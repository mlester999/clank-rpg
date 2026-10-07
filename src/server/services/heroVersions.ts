import type { Rarity } from "@/domain/character/appearance";
import { generateCharacter } from "@/domain/character/generate";
import {
  HERO_GENERATOR_VERSION,
  heroGeneratorLabel,
  isLegacyGenerator,
  parseHeroVersionState,
  versionStateFromGenerated,
  type HeroVersionAction,
  type HeroVersionState,
} from "@/domain/hero/heroVersion";
import type { HeroCardModel } from "@/domain/hero/card";
import { rebalanceHeroState } from "@/domain/hero/rebalance";
import { deterministicUuid } from "@/domain/util/hash";
import type { ClassDef } from "@/domain/rules";
import type { GameSettings } from "@/domain/settings";
import type { StatBlock } from "@/domain/stats";
import type { BehaviorCounters } from "@/domain/telegram/types";

import { loadClasses, loadRuleset } from "../config/settingsRepo";
import { json, type Db, type Queryable } from "../db/types";
import { secureSeed } from "../crypto";

import { audit } from "./admin";
import { loadFighters, refreshPower, type FighterOverride } from "./characters";
import { invalidateHeroCards } from "./heroCache";
import { toHeroCardModel } from "./heroCardModel";
import {
  heroArenaLock,
  insertHeroVersion,
  listVersionRows,
  loadCurrentVersion,
  loadVersion,
  rowToState,
  type ArenaLock,
  type HeroVersionRow,
} from "./heroVersionStore";

/**
 * ADMIN hero rerolls and rollbacks. A hero's identity never changes — only its CURRENT generated RPG state moves, by appending a version.
 *
 *   PREVIEW   draws a candidate from the same generator that creates new heroes, with a server-chosen random nonce, and stores it as a
 *             short-lived `hero_reroll_previews` row. Nothing about the hero changes and no version is written. "Reroll again" is just
 *             another preview.
 *   APPLY     turns exactly that stored candidate into the next version (REROLL) — never a second roll, never anything the browser sent.
 *   ROLLBACK  appends a new version (ROLLBACK) that is an exact copy of an older one. Newer versions are kept.
 *   REBALANCE appends a SYSTEM_REBALANCE version: the deterministic move of a hero made by the first generator onto the rarity power system
 *             (same hero, class, rarity and identity; stats/PWR fitted into the rarity's band; rarity layers added). Run by the guarded
 *             rebalance script — see rebalanceHero.
 *
 * Both state changes run in ONE transaction that first takes the hero's row lock, so double clicks, concurrent admins and apply-vs-rollback
 * races serialise: the second request sees the first one's result and is answered idempotently (same key) or refused as stale (anything else).
 * They are also refused while the hero sits in an unsettled Arena roster (see heroArenaLock).
 */

export class HeroVersionError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const ARENA_LOCK_MESSAGE = "Hero is currently queued in a live Arena fight. Try again after the prepared battle cycle completes.";

/** How long an unapplied candidate stays valid. */
export const REROLL_PREVIEW_TTL_MS = 30 * 60_000;

export interface HeroVersioningDeps {
  settings: GameSettings;
  /** ENABLED classes — what the generator rolls from, exactly as for a brand-new hero. */
  classes: ClassDef[];
  /** CLASS_ROLL_SECRET (server-only). */
  secret: string;
  now?: () => Date;
  /** Test hook only. Production draws a 128-bit CSPRNG nonce per preview. */
  nonce?: () => string;
}

const nowOf = (d: HeroVersioningDeps): Date => (d.now ? d.now() : new Date());

// ---------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------

/** One history line. No seed, no internal id other than the version id the admin console needs to act on it. */
export interface HeroVersionDto {
  id: string;
  number: number;
  action: HeroVersionAction;
  current: boolean;
  /** ROLLBACK: the version number this one copies. */
  sourceVersion: number | null;
  /** The version that was current just before this one. */
  previousVersion: number | null;
  createdAt: Date;
  createdBy: string;
  generatorVersion: string;
  /** "Hero generator 2.0.0" — what the Admin console shows next to the version. */
  generatorLabel: string;
  /** Made by the first (pre-rarity-power) generator: kept for history and displayable, but it can no longer be restored. */
  legacy: boolean;
  classId: string;
  className: string;
  rarity: Rarity;
  /** PWR / stats as GENERATED for this version (class base + variation + Telegram bonus), under the formula of the generator that made it. */
  power: number;
  stats: StatBlock;
}

export interface HeroVersioningView {
  publicId: string;
  /** What the admin needs next to the card: moderation, and whether the hero is currently in the Arena / on the public pages. */
  moderation: { heroStatus: string; memberStatus: string | null; arenaEligible: boolean; isPublic: boolean };
  rerollable: boolean;
  rerollBlockedReason: string | null;
  currentVersion: number;
  versionCount: number;
  /** False while the hero is still on a first-generator version (it moves onto the rarity power system with the system rebalance). */
  onCurrentGenerator: boolean;
  versions: HeroVersionDto[];
  arenaLock: ArenaLock & { message: string | null };
}

const classNameOf = (classes: readonly ClassDef[], id: string): string => classes.find((c) => c.id === id)?.name ?? id;

function toDto(row: HeroVersionRow, p: { currentId: string | null; numberById: Map<string, number>; classes: readonly ClassDef[] }): HeroVersionDto {
  return {
    id: row.id,
    number: Number(row.version_number),
    action: row.action,
    current: row.id === p.currentId,
    sourceVersion: row.source_version_id ? (p.numberById.get(row.source_version_id) ?? null) : null,
    previousVersion: row.previous_version_id ? (p.numberById.get(row.previous_version_id) ?? null) : null,
    createdAt: row.created_at,
    createdBy: row.created_by,
    generatorVersion: row.generator_version,
    generatorLabel: heroGeneratorLabel(row.generator_version),
    legacy: isLegacyGenerator(row.generator_version),
    classId: row.class_id,
    className: classNameOf(p.classes, row.class_id),
    rarity: row.rarity,
    power: Number(row.power),
    stats: row.stats,
  };
}

interface HeroRow {
  id: string;
  kind: "COMMUNITY" | "SPECIAL_CHARACTER";
  public_id: string;
  name: string;
  telegram_user_id: number | null;
  current_hero_version_id: string | null;
}

async function loadHero(q: Queryable, characterId: string, lock: boolean): Promise<HeroRow> {
  const [hero] = await q.query<HeroRow>(
    `select id, kind, public_id, coalesce(name_override, name) as name, telegram_user_id, current_hero_version_id from public.characters where id = $1 ${lock ? "for update" : ""}`,
    [characterId],
  );
  if (!hero) throw new HeroVersionError("NOT_FOUND", 404);
  if (!hero.current_hero_version_id) throw new HeroVersionError("NO_VERSION", 409, "This hero has no version history (run the hero-version migration).");
  return hero;
}

function rerollBlockedReason(hero: Pick<HeroRow, "kind" | "telegram_user_id">): string | null {
  if (hero.kind !== "COMMUNITY" || hero.telegram_user_id === null) return "Special characters are hand-authored — they cannot be rerolled.";
  return null;
}

/** Admin: the whole picture for one hero's version panel. `allowDemo` = whether demo heroes count as Arena-eligible / public here. */
export async function getHeroVersioning(q: Queryable, characterId: string, allowDemo = false): Promise<HeroVersioningView> {
  const hero = await loadHero(q, characterId, false);
  const [mod] = await q.query<{ status: string; member_status: string | null; is_demo: boolean }>(
    `select c.status, tu.status as member_status, c.is_demo from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id where c.id = $1`,
    [characterId],
  );
  // The SAME predicate the Arena queue and the public pages use: an ACTIVE hero whose member is not BANNED (demo heroes only where allowed).
  const eligible = mod?.status === "ACTIVE" && mod.member_status !== "BANNED" && (!mod.is_demo || allowDemo);
  const [rows, classes, lock] = await Promise.all([listVersionRows(q, characterId), loadClasses(q, false), heroArenaLock(q, characterId)]);
  const numberById = new Map(rows.map((r) => [r.id, Number(r.version_number)]));
  const versions = rows.map((r) => toDto(r, { currentId: hero.current_hero_version_id, numberById, classes }));
  return {
    publicId: hero.public_id,
    moderation: { heroStatus: mod?.status ?? "UNKNOWN", memberStatus: mod?.member_status ?? null, arenaEligible: eligible, isPublic: eligible },
    rerollable: rerollBlockedReason(hero) === null,
    rerollBlockedReason: rerollBlockedReason(hero),
    currentVersion: versions.find((v) => v.current)?.number ?? 0,
    versionCount: versions.length,
    onCurrentGenerator: versions.find((v) => v.current)?.legacy === false,
    versions,
    arenaLock: { ...lock, message: lock.locked ? ARENA_LOCK_MESSAGE : null },
  };
}

function overrideOf(state: HeroVersionState): FighterOverride {
  return { classId: state.classId, variation: state.variation, telegramBonus: state.telegramBonus, rarity: state.rarity, parts: state.appearance, sprite: state.sprite };
}

/**
 * The hero drawn as a card. With no `state` it is the hero as it is NOW; with a state it is what the hero WOULD look like with that
 * generated state (everything else — wallet/gear parts, claim, tactic, name — unchanged). Read-only either way.
 */
export async function heroCardFor(q: Queryable, characterId: string, deps: Pick<HeroVersioningDeps, "settings">, state?: HeroVersionState): Promise<HeroCardModel> {
  const hero = await loadHero(q, characterId, false);
  const { ruleset } = await loadRuleset(q, deps.settings);
  const [fighter] = await loadFighters(q, [characterId], ruleset, deps.settings, state ? new Map([[characterId, overrideOf(state)]]) : undefined);
  if (!fighter) throw new HeroVersionError("NOT_FOUND", 404);
  const classDef = ruleset.classes[fighter.classId] as ClassDef;
  return toHeroCardModel({ publicId: hero.public_id, name: hero.name, fighter, classDef });
}

/** Admin: one stored version drawn as a card (the PREVIEW action on a history row). */
export async function versionCard(q: Queryable, characterId: string, versionId: string, deps: Pick<HeroVersioningDeps, "settings">): Promise<{ version: number; card: HeroCardModel }> {
  const row = await loadVersion(q, characterId, versionId);
  if (!row) throw new HeroVersionError("VERSION_NOT_FOUND", 404);
  return { version: Number(row.version_number), card: await heroCardFor(q, characterId, deps, rowToState(row)) };
}

// ---------------------------------------------------------------------------------------
// PREVIEW
// ---------------------------------------------------------------------------------------

export interface RerollPreviewResult {
  previewId: string;
  expiresAt: Date;
  baseVersion: number;
  current: HeroCardModel;
  candidate: HeroCardModel;
  arenaLock: ArenaLock & { message: string | null };
}

interface TelegramMemberRow {
  display_name: string;
  activity_score: number;
  behavior: Partial<BehaviorCounters>;
}

/**
 * Draws a reroll CANDIDATE. The hero is not touched and no version is written: the candidate is stored as a short-lived preview so that
 * exactly what the admin sees is what Apply will use. The seed is generated here, on the server — the browser sends nothing but "preview".
 */
export async function previewReroll(db: Db, characterId: string, actor: string, deps: HeroVersioningDeps): Promise<RerollPreviewResult> {
  const now = nowOf(deps);
  return db.transaction(async (tx) => {
    const hero = await loadHero(tx, characterId, false);
    const blocked = rerollBlockedReason(hero);
    if (blocked) throw new HeroVersionError("NOT_REROLLABLE", 422, blocked);
    const [member] = await tx.query<TelegramMemberRow>("select display_name, activity_score, behavior from public.telegram_users where telegram_user_id = $1", [hero.telegram_user_id]);
    if (!member) throw new HeroVersionError("NOT_REROLLABLE", 422, "This hero has no Telegram member record to roll from.");

    const nonce = deps.nonce ? deps.nonce() : secureSeed(16);
    const generated = generateCharacter({
      telegramUserId: Number(hero.telegram_user_id),
      displayName: hero.name,
      behavior: member.behavior,
      activityScore: Number(member.activity_score),
      classes: deps.classes,
      settings: deps.settings,
      secret: deps.secret,
      seedSalt: nonce,
    });
    const classDef = deps.classes.find((c) => c.id === generated.classId);
    if (!classDef) throw new HeroVersionError("CLASS_UNAVAILABLE", 500);
    const state = versionStateFromGenerated(generated, classDef, deps.settings.character, deps.settings.visuals.spriteSet);

    const base = await loadCurrentVersion(tx, characterId);
    if (!base) throw new HeroVersionError("NO_VERSION", 409);
    // Housekeeping: candidates nobody applied are worthless after a day.
    await tx.query("delete from public.hero_reroll_previews where applied_version_id is null and expires_at < $1::timestamptz - interval '1 day'", [now.toISOString()]);
    const expiresAt = new Date(now.getTime() + REROLL_PREVIEW_TTL_MS);
    const [preview] = await tx.query<{ id: string }>(
      `insert into public.hero_reroll_previews (character_id, base_version_id, generation_seed, candidate, created_by, created_at, expires_at)
       values ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz) returning id`,
      [characterId, base.id, state.generationSeed, json(state), actor, now.toISOString(), expiresAt.toISOString()],
    );
    const lock = await heroArenaLock(tx, characterId);
    return {
      previewId: (preview as { id: string }).id,
      expiresAt,
      baseVersion: Number(base.version_number),
      current: await heroCardFor(tx, characterId, deps),
      candidate: await heroCardFor(tx, characterId, deps, state),
      arenaLock: { ...lock, message: lock.locked ? ARENA_LOCK_MESSAGE : null },
    };
  });
}

// ---------------------------------------------------------------------------------------
// Applying a state (shared by APPLY and ROLLBACK)
// ---------------------------------------------------------------------------------------

/**
 * Appends the version and moves the hero to it — pointer AND projection — inside the caller's transaction (which holds the hero's row lock).
 * `clank.allow_class_change` is the existing, audited switch that lets the otherwise-permanent class column change, transaction-local.
 */
async function appendAndProject(
  tx: Queryable,
  hero: HeroRow,
  p: { action: Exclude<HeroVersionAction, "INITIAL">; state: HeroVersionState; sourceVersionId?: string; requestId: string; actor: string },
  deps: HeroVersioningDeps,
): Promise<{ row: HeroVersionRow; previous: HeroVersionRow }> {
  const previous = await loadCurrentVersion(tx, hero.id);
  if (!previous) throw new HeroVersionError("NO_VERSION", 409);
  const [{ next } = { next: 1 }] = await tx.query<{ next: number }>("select coalesce(max(version_number), 0) + 1 as next from public.hero_versions where character_id = $1", [hero.id]);
  const row = await insertHeroVersion(tx, {
    characterId: hero.id,
    versionNumber: Number(next),
    action: p.action,
    sourceVersionId: p.sourceVersionId ?? null,
    previousVersionId: previous.id,
    requestId: p.requestId,
    state: p.state,
    createdBy: p.actor,
  });
  await tx.query("select set_config('clank.allow_class_change', 'on', true)");
  await tx.query("update public.characters set class_id = $2, current_hero_version_id = $3 where id = $1", [hero.id, p.state.classId, row.id]);
  await tx.query("update public.character_stats set variation = $2::jsonb, telegram_bonus = $3::jsonb where character_id = $1", [hero.id, json(p.state.variation), json(p.state.telegramBonus)]);
  await tx.query(
    "update public.character_appearances set rarity = $2, parts = $3::jsonb, seed = $4, sprite = $5::jsonb where character_id = $1",
    [hero.id, p.state.rarity, json(p.state.appearance), p.state.appearanceSeed, p.state.sprite === null ? null : json(p.state.sprite)],
  );
  // characters.power is the cached EFFECTIVE power: recompute it from the new components (wallet/gear parts stay as they were).
  await refreshPower(tx, hero.id, deps.settings, await loadClasses(tx, false));
  return { row, previous };
}

async function assertNotInArena(tx: Queryable, characterId: string): Promise<void> {
  const lock = await heroArenaLock(tx, characterId);
  if (lock.locked) throw new HeroVersionError("HERO_IN_ARENA", 409, ARENA_LOCK_MESSAGE);
}

export interface VersionChangeResult {
  /** True when this exact request had already been applied (a double click or a retry): nothing was written this time. */
  alreadyApplied: boolean;
  version: HeroVersionDto;
  previousVersion: number;
  card: HeroCardModel;
}

async function resultFor(tx: Queryable, hero: HeroRow, row: HeroVersionRow, deps: HeroVersioningDeps, alreadyApplied: boolean): Promise<VersionChangeResult> {
  const rows = await listVersionRows(tx, hero.id);
  const numberById = new Map(rows.map((r) => [r.id, Number(r.version_number)]));
  const classes = await loadClasses(tx, false);
  const [now] = await tx.query<{ current_hero_version_id: string | null }>("select current_hero_version_id from public.characters where id = $1", [hero.id]);
  const dto = toDto(row, { currentId: now?.current_hero_version_id ?? null, numberById, classes });
  return { alreadyApplied, version: dto, previousVersion: dto.previousVersion ?? 0, card: await heroCardFor(tx, hero.id, deps) };
}

// ---------------------------------------------------------------------------------------
// APPLY (reroll)
// ---------------------------------------------------------------------------------------

/** Makes the previously previewed candidate the hero's next version. */
export async function applyRerollPreview(db: Db, characterId: string, previewId: string, actor: string, deps: HeroVersioningDeps): Promise<VersionChangeResult> {
  const now = nowOf(deps);
  const result = await db.transaction(async (tx) => {
    const hero = await loadHero(tx, characterId, true); // the lock every state change takes first
    const [preview] = await tx.query<{ id: string; base_version_id: string; candidate: unknown; expires_at: Date; applied_version_id: string | null }>(
      "select id, base_version_id, candidate, expires_at, applied_version_id from public.hero_reroll_previews where id = $1 and character_id = $2 for update",
      [previewId, characterId],
    );
    if (!preview) throw new HeroVersionError("PREVIEW_NOT_FOUND", 404);
    if (preview.applied_version_id) {
      // A double click / retry of the SAME candidate: answer with what the first request did.
      const existing = await loadVersion(tx, characterId, preview.applied_version_id);
      if (!existing) throw new HeroVersionError("PREVIEW_NOT_FOUND", 404);
      return resultFor(tx, hero, existing, deps, true);
    }
    if (new Date(preview.expires_at).getTime() <= now.getTime()) throw new HeroVersionError("PREVIEW_EXPIRED", 410, "This preview expired — roll again.");
    if (preview.base_version_id !== hero.current_hero_version_id) throw new HeroVersionError("STALE_PREVIEW", 409, "This hero changed since the preview was drawn — roll again.");
    await assertNotInArena(tx, characterId);

    const state = parseHeroVersionState(preview.candidate);
    // A candidate drawn by an older ruleset (a preview made before a deploy) must not become a version: roll again under the current one.
    if (state.generatorVersion !== HERO_GENERATOR_VERSION) throw new HeroVersionError("PREVIEW_OUTDATED", 409, "This preview was drawn by an older hero generator — roll again.");
    const { row, previous } = await appendAndProject(tx, hero, { action: "REROLL", state, requestId: preview.id, actor }, deps);
    await tx.query("update public.hero_reroll_previews set applied_version_id = $2, applied_at = $3::timestamptz where id = $1", [preview.id, row.id, now.toISOString()]);
    await audit(tx, actor, "hero.reroll", "character", characterId, {
      heroId: characterId,
      publicId: hero.public_id,
      action: "REROLL",
      previousVersion: Number(previous.version_number),
      newVersion: Number(row.version_number),
      previousVersionId: previous.id,
      newVersionId: row.id,
      from: { classId: previous.class_id, rarity: previous.rarity, power: Number(previous.power) },
      to: { classId: row.class_id, rarity: row.rarity, power: Number(row.power) },
      generatorVersion: row.generator_version,
      previewId: preview.id,
    });
    return resultFor(tx, hero, row, deps, false);
  });
  invalidateHeroCards(result.card.publicId);
  return result;
}

// ---------------------------------------------------------------------------------------
// ROLLBACK
// ---------------------------------------------------------------------------------------

export interface RollbackInput {
  characterId: string;
  /** The older version to restore. */
  targetVersionId: string;
  /** The version the admin was looking at: a different current version means somebody else changed the hero meanwhile. */
  expectedCurrentVersionId: string;
  /** Idempotency key for this click (a retry or a double click sends the same one). */
  requestId: string;
}

/** Appends a ROLLBACK version that is an exact copy of `targetVersionId` and makes it current. Nothing is deleted. */
export async function rollbackHero(db: Db, input: RollbackInput, actor: string, deps: HeroVersioningDeps): Promise<VersionChangeResult> {
  const result = await db.transaction(async (tx) => {
    const hero = await loadHero(tx, input.characterId, true);
    const [done] = await tx.query<{ id: string; character_id: string; action: string; source_version_id: string | null }>(
      "select id, character_id, action, source_version_id from public.hero_versions where request_id = $1",
      [input.requestId],
    );
    if (done) {
      if (done.character_id !== hero.id || done.action !== "ROLLBACK" || done.source_version_id !== input.targetVersionId) throw new HeroVersionError("REQUEST_CONFLICT", 409, "That request key was already used for something else.");
      const existing = (await loadVersion(tx, hero.id, done.id)) as HeroVersionRow;
      return resultFor(tx, hero, existing, deps, true);
    }
    if (hero.current_hero_version_id !== input.expectedCurrentVersionId) throw new HeroVersionError("STALE_VERSION", 409, "This hero changed since you opened it — reload and try again.");
    const target = await loadVersion(tx, hero.id, input.targetVersionId);
    if (!target) throw new HeroVersionError("VERSION_NOT_FOUND", 404);
    if (target.id === hero.current_hero_version_id) throw new HeroVersionError("ALREADY_CURRENT", 409, "That version is already the current one.");
    // A version made by the first generator predates rarity power: its stats were never fitted to a PWR band, so restoring it would put the hero
    // outside its rarity's range. It stays in the history for display (and for audit), but only rarity-power versions can be restored.
    if (isLegacyGenerator(target.generator_version)) throw new HeroVersionError("LEGACY_VERSION", 422, "That version was made before the rarity power system and can only be viewed, not restored.");
    await assertNotInArena(tx, hero.id);

    const { row, previous } = await appendAndProject(tx, hero, { action: "ROLLBACK", state: rowToState(target), sourceVersionId: target.id, requestId: input.requestId, actor }, deps);
    await audit(tx, actor, "hero.rollback", "character", hero.id, {
      heroId: hero.id,
      publicId: hero.public_id,
      action: "ROLLBACK",
      previousVersion: Number(previous.version_number),
      newVersion: Number(row.version_number),
      restoredVersion: Number(target.version_number),
      previousVersionId: previous.id,
      newVersionId: row.id,
      sourceVersionId: target.id,
      from: { classId: previous.class_id, rarity: previous.rarity, power: Number(previous.power) },
      to: { classId: row.class_id, rarity: row.rarity, power: Number(row.power) },
    });
    return resultFor(tx, hero, row, deps, false);
  });
  invalidateHeroCards(result.card.publicId);
  return result;
}


// ---------------------------------------------------------------------------------------
// SYSTEM REBALANCE
// ---------------------------------------------------------------------------------------

export type RebalanceStatus = "REBALANCED" | "ALREADY_ON_CURRENT_GENERATOR" | "NOT_A_COMMUNITY_HERO";

export interface RebalanceResult {
  status: RebalanceStatus;
  characterId: string;
  publicId: string;
  fromVersion: number;
  toVersion: number;
  from: { classId: string; rarity: Rarity; power: number; generatorVersion: string };
  to: { classId: string; rarity: Rarity; power: number; generatorVersion: string };
}

/** The idempotency key of rebalancing THIS version onto THIS generator: a retry, a second run or a concurrent run can only ever write one row. */
export const rebalanceRequestId = (previousVersionId: string): string => deterministicUuid(`hero-rebalance|${HERO_GENERATOR_VERSION}|${previousVersionId}`);

/**
 * Moves one hero from a first-generator version onto the rarity power system by appending a SYSTEM_REBALANCE version (see rebalanceHeroState
 * for exactly what is kept, changed and added). One transaction, under the hero's row lock; refused while the hero sits in an unsettled
 * Arena roster (the caller defers it and tries again later) — exactly like a reroll, so no fighter ever changes after people picked it.
 * The historical versions are never touched. Idempotent: a hero already on the current generator is reported, not written.
 */
export async function rebalanceHero(db: Db, characterId: string, actor: string, deps: HeroVersioningDeps): Promise<RebalanceResult> {
  const result = await db.transaction(async (tx) => {
    const hero = await loadHero(tx, characterId, true);
    const previous = await loadCurrentVersion(tx, characterId);
    if (!previous) throw new HeroVersionError("NO_VERSION", 409);
    const summary = (row: HeroVersionRow) => ({ classId: row.class_id, rarity: row.rarity, power: Number(row.power), generatorVersion: row.generator_version });
    if (hero.kind !== "COMMUNITY" || hero.telegram_user_id === null) {
      return { status: "NOT_A_COMMUNITY_HERO" as const, characterId, publicId: hero.public_id, fromVersion: Number(previous.version_number), toVersion: Number(previous.version_number), from: summary(previous), to: summary(previous) };
    }
    if (!isLegacyGenerator(previous.generator_version)) {
      return { status: "ALREADY_ON_CURRENT_GENERATOR" as const, characterId, publicId: hero.public_id, fromVersion: Number(previous.version_number), toVersion: Number(previous.version_number), from: summary(previous), to: summary(previous) };
    }
    await assertNotInArena(tx, characterId);
    const classDef = deps.classes.find((c) => c.id === previous.class_id) ?? (await loadClasses(tx, false)).find((c) => c.id === previous.class_id);
    if (!classDef) throw new HeroVersionError("CLASS_UNAVAILABLE", 500, `class ${previous.class_id} is not defined`);
    const state = rebalanceHeroState({ previous: rowToState(previous), classDef, settings: deps.settings.character });
    const { row } = await appendAndProject(tx, hero, { action: "SYSTEM_REBALANCE", state, requestId: rebalanceRequestId(previous.id), actor }, deps);
    await audit(tx, actor, "hero.rebalance", "character", characterId, {
      heroId: characterId,
      publicId: hero.public_id,
      action: "SYSTEM_REBALANCE",
      previousVersion: Number(previous.version_number),
      newVersion: Number(row.version_number),
      previousVersionId: previous.id,
      newVersionId: row.id,
      from: { classId: previous.class_id, rarity: previous.rarity, power: Number(previous.power), generatorVersion: previous.generator_version },
      to: { classId: row.class_id, rarity: row.rarity, power: Number(row.power), generatorVersion: row.generator_version },
    });
    return { status: "REBALANCED" as const, characterId, publicId: hero.public_id, fromVersion: Number(previous.version_number), toVersion: Number(row.version_number), from: summary(previous), to: summary(row) };
  });
  invalidateHeroCards(result.publicId);
  return result;
}
