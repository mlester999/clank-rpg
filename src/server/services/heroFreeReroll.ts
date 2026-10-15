import { generateCharacter } from "@/domain/character/generate";
import type { HeroCardModel } from "@/domain/hero/card";
import {
  BLOCK_MESSAGE,
  compareRerolled,
  memberActor,
  nextRerollAt,
  rerollDay,
  rerollOddsView,
  rolledStateProblem,
  type FreeRerollBlock,
  type FreeRerollErrorCode,
  type FreeRerollResultDto,
  type FreeRerollStatusDto,
} from "@/domain/hero/freeReroll";
import { versionStateFromGenerated } from "@/domain/hero/heroVersion";
import type { BehaviorCounters } from "@/domain/telegram/types";

import { secureSeed } from "../crypto";
import { type Db, type Queryable } from "../db/types";

import { audit } from "./auditLog";
import { invalidateHeroCards } from "./heroCache";
import { appendAndProject, assertNotInArena, heroCardFor, HeroVersionError, type HeroVersioningDeps } from "./heroVersions";
import { heroArenaLock, loadCurrentVersion, loadVersion, rowToState } from "./heroVersionStore";

/**
 * THE FREE DAILY HERO REROLL (docs/HERO_FREE_REROLL.md). One free reroll per member per UTC calendar day, server-authoritative end to end:
 *
 *   · the member is the SESSION's member (the route resolves it) and the hero is the one bound to that Telegram id — a browser names neither;
 *   · everything happens in ONE transaction that first takes the hero's row lock (a member has exactly one hero), so a member's requests are
 *     serialised: two tabs, a double click or a retry cannot interleave;
 *   · the allowance is a row in `hero_free_rerolls` whose PRIMARY KEY is (member, UTC day) — the database refuses a second reroll on the same
 *     UTC day, whatever the application does — and it is inserted in the same transaction as the REROLL hero version it describes (the
 *     database also refuses a member-made version without its allowance row). A reroll without a consumed allowance, or an allowance consumed
 *     without a reroll, cannot commit;
 *   · the roll is the existing generator (same class odds, rarity weights and PWR bands as every hero) with a server-chosen 128-bit nonce, validated
 *     before it can become a version; a bad roll aborts the transaction and consumes nothing;
 *   · the hero keeps its id, owner, claim, Gold, items, achievements, record, Picks and rewards; the old state stays in the version history and no
 *     battle snapshot is ever read or written. A hero in a committed Arena roster is refused (nothing consumed), exactly like an admin reroll.
 *
 * The clock is the SERVER's (`deps.now`); the browser's clock, timezone and countdown decide nothing.
 */

export class FreeRerollError extends Error {
  constructor(
    readonly code: FreeRerollErrorCode,
    readonly status: number,
    message?: string,
    /** Extra facts the API may return with the refusal (never anything private). */
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

export interface FreeRerollDeps extends HeroVersioningDeps {
  /** Whether demo heroes count (local previews only). */
  allowDemo: boolean;
  /** TEST HOOK ONLY — production always uses `generateCharacter`. */
  generate?: typeof generateCharacter;
}

const nowOf = (d: FreeRerollDeps): Date => (d.now ? d.now() : new Date());

/** Has the migration been applied? Without the table the feature reads as unavailable (the code can ship before the migration). */
export async function freeRerollReady(q: Queryable): Promise<boolean> {
  const [row] = await q.query<{ ready: boolean }>("select (to_regclass('public.hero_free_rerolls') is not null) as ready");
  return Boolean(row?.ready);
}

export interface MemberHero {
  id: string;
  kind: "COMMUNITY" | "SPECIAL_CHARACTER";
  status: string;
  is_demo: boolean;
  public_id: string;
  name: string;
  telegram_user_id: number;
  current_hero_version_id: string | null;
  member_status: string;
  display_name: string;
  activity_score: number;
  behavior: Partial<BehaviorCounters>;
  claimed: boolean;
}

export const HERO_SQL = `select c.id, c.kind, c.status, c.is_demo, c.public_id, coalesce(c.name_override, c.name) as name, c.telegram_user_id, c.current_hero_version_id,
                         tu.status as member_status, tu.display_name, tu.activity_score, tu.behavior, (cl.character_id is not null) as claimed
                    from public.characters c
                    join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
                    left join public.character_claims cl on cl.character_id = c.id
                   where c.telegram_user_id = $1`;

/** Why this member's hero cannot be rerolled right now, from facts about the hero only (the Arena roster is checked separately). */
export function unavailableReason(h: MemberHero, allowDemo: boolean): FreeRerollBlock | null {
  if (h.kind !== "COMMUNITY") return "HERO_UNAVAILABLE";
  if (h.member_status === "BANNED" || h.member_status === "FLAGGED") return "HERO_UNAVAILABLE";
  if (h.status !== "ACTIVE") return "HERO_UNAVAILABLE";
  if (h.is_demo && !allowDemo) return "HERO_UNAVAILABLE";
  if (!h.claimed) return "NOT_CLAIMED";
  return null;
}

interface AllowanceRow {
  telegram_user_id: number;
  utc_day: string;
  character_id: string;
  request_id: string;
  hero_version_id: string;
  previous_version_id: string;
  created_at: Date;
}

const ALLOWANCE_COLUMNS = "telegram_user_id, utc_day::text as utc_day, character_id, request_id, hero_version_id, previous_version_id, created_at";

/** A reroll as the result screen shows it, built from the TWO STORED VERSIONS (so a retry or a refresh shows the same pair, never a mixture). */
export async function buildRerollResult(
  q: Queryable,
  r: { characterId: string; requestId: string; versionId: string; previousVersionId: string; at: Date },
  deps: FreeRerollDeps,
  alreadyApplied: boolean,
): Promise<FreeRerollResultDto> {
  const [next, prev] = await Promise.all([loadVersion(q, r.characterId, r.versionId), loadVersion(q, r.characterId, r.previousVersionId)]);
  if (!next || !prev) throw new FreeRerollError("INVALID_ROLL", 500, "The reroll's versions are missing.");
  const [before, after] = [await heroCardFor(q, r.characterId, deps, rowToState(prev)), await heroCardFor(q, r.characterId, deps, rowToState(next))];
  return { requestId: r.requestId, alreadyApplied, rerolledAt: new Date(r.at).getTime(), before, after, comparison: compareRerolled(before, after) };
}

/** Today's free reroll as the result screen shows it. */
const resultFromAllowance = (q: Queryable, a: AllowanceRow, deps: FreeRerollDeps, alreadyApplied: boolean): Promise<FreeRerollResultDto> =>
  buildRerollResult(q, { characterId: a.character_id, requestId: a.request_id, versionId: a.hero_version_id, previousVersionId: a.previous_version_id, at: a.created_at }, deps, alreadyApplied);

// ---------------------------------------------------------------------------------------------------------------------
// STATUS (read-only)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The member's free-reroll status. `enabled` is the feature flag (the caller reads it); a disabled feature answers DISABLED without touching the
 * hero tables, so switching it off is instant and an unmigrated database cannot break the page.
 */
export async function getFreeRerollStatus(q: Queryable, memberId: number, enabled: boolean, deps: FreeRerollDeps): Promise<FreeRerollStatusDto> {
  const now = nowOf(deps).getTime();
  const base: FreeRerollStatusDto = {
    state: "DISABLED",
    serverNow: now,
    utcDay: rerollDay(now),
    nextResetAt: nextRerollAt(now),
    block: null,
    message: null,
    current: null,
    today: null,
    odds: rerollOddsView(deps.settings.character.rarityWeights),
  };
  if (!enabled) return base;
  if (!(await freeRerollReady(q))) return { ...base, state: "UNAVAILABLE", message: "Free rerolls aren't ready on this server yet." };

  const [hero] = await q.query<MemberHero>(HERO_SQL, [memberId]);
  if (!hero || !hero.current_hero_version_id) return { ...base, state: "BLOCKED", block: "NO_HERO", message: BLOCK_MESSAGE.NO_HERO };
  const current: HeroCardModel = await heroCardFor(q, hero.id, deps);

  const [used] = await q.query<AllowanceRow>(`select ${ALLOWANCE_COLUMNS} from public.hero_free_rerolls where telegram_user_id = $1 and utc_day = $2::date`, [memberId, rerollDay(now)]);
  if (used) return { ...base, state: "USED", current, today: await resultFromAllowance(q, used, deps, true) };

  let block = unavailableReason(hero, deps.allowDemo);
  if (!block && (await heroArenaLock(q, hero.id)).locked) block = "HERO_IN_ARENA";
  if (block) return { ...base, state: "BLOCKED", block, message: BLOCK_MESSAGE[block], current };
  return { ...base, state: "AVAILABLE", current };
}

// ---------------------------------------------------------------------------------------------------------------------
// REROLL
// ---------------------------------------------------------------------------------------------------------------------

/**
 * THE ROLL, shared by the free and the paid reroll: a brand-new hero state from the existing generator (same class odds, rarity weights and PWR bands as every hero,
 * a server-chosen 128-bit nonce), VALIDATED before it can become a version, appended as a REROLL version with the pointer and projection moved in the same
 * transaction. The caller holds the hero's row lock and has already decided the member may roll (allowance or payment) and that the hero is not in a committed
 * Arena roster. A bad roll throws `INVALID_ROLL` and the caller's transaction rolls back — nothing is consumed.
 */
export async function rollNewHeroVersion(tx: Queryable, hero: MemberHero, requestId: string, actor: string, deps: FreeRerollDeps) {
  const previous = await loadCurrentVersion(tx, hero.id);
  if (!previous) throw new FreeRerollError("NO_HERO", 409, "This hero has no version history.");
  const nonce = deps.nonce ? deps.nonce() : secureSeed(16);
  const generated = (deps.generate ?? generateCharacter)({
    telegramUserId: Number(hero.telegram_user_id),
    displayName: hero.name,
    behavior: hero.behavior,
    activityScore: Number(hero.activity_score),
    classes: deps.classes,
    settings: deps.settings,
    secret: deps.secret,
    seedSalt: nonce,
  });
  const classDef = deps.classes.find((c) => c.id === generated.classId);
  if (!classDef) throw new FreeRerollError("INVALID_ROLL", 500, "The rolled class is not available.");
  let state;
  try {
    state = versionStateFromGenerated(generated, classDef, deps.settings.character, deps.settings.visuals.spriteSet);
  } catch (error) {
    throw new FreeRerollError("INVALID_ROLL", 500, error instanceof Error ? error.message : "The roll was invalid.");
  }
  const problem = rolledStateProblem(state, deps.classes, deps.settings.character);
  if (problem) throw new FreeRerollError("INVALID_ROLL", 500, problem);
  return appendAndProject(tx, hero, { action: "REROLL", state, requestId, actor }, deps);
}

/** The constraint a database error names (postgres.js / PGlite shapes), if any. */
export const constraintOf = (error: unknown): string | null => {
  const e = error as { constraint?: unknown; constraint_name?: unknown; cause?: unknown; message?: unknown };
  const direct = e?.constraint ?? e?.constraint_name;
  if (typeof direct === "string") return direct;
  if (e?.cause) return constraintOf(e.cause);
  const m = typeof e?.message === "string" ? /constraint "?([a-z0-9_]+)"?/i.exec(e.message) : null;
  return m?.[1] ?? null;
};

/**
 * Rerolls the member's own hero with today's free allowance. `requestId` is the browser's idempotency key for THIS confirmation: a retry (lost
 * answer, double click, second tab) with the same key returns the same result and writes nothing.
 */
export async function rerollOwnHero(db: Db, memberId: number, requestId: string, deps: FreeRerollDeps): Promise<FreeRerollResultDto> {
  const now = nowOf(deps);
  const day = rerollDay(now.getTime());
  let publicId: string | null = null;
  try {
    const result = await db.transaction(async (tx) => {
      // The hero's row lock first — every request of this member queues here.
      const [hero] = await tx.query<MemberHero>(`${HERO_SQL} for update of c`, [memberId]);
      if (!hero || !hero.current_hero_version_id) throw new FreeRerollError("NO_HERO", 404, BLOCK_MESSAGE.NO_HERO);
      publicId = hero.public_id;

      // A retry of a request that already succeeded: answer with what it did.
      const [same] = await tx.query<AllowanceRow>(`select ${ALLOWANCE_COLUMNS} from public.hero_free_rerolls where request_id = $1`, [requestId]);
      if (same) {
        if (Number(same.telegram_user_id) !== memberId) throw new FreeRerollError("REQUEST_CONFLICT", 409, "That request key was already used.");
        return resultFromAllowance(tx, same, deps, true);
      }
      // …and a key already spent on some other hero version (an admin rollback, another member) is never reusable.
      const [taken] = await tx.query("select 1 from public.hero_versions where request_id = $1", [requestId]);
      if (taken) throw new FreeRerollError("REQUEST_CONFLICT", 409, "That request key was already used.");

      const unavailable = unavailableReason(hero, deps.allowDemo);
      if (unavailable) throw new FreeRerollError(unavailable, unavailable === "NOT_CLAIMED" ? 403 : 409, BLOCK_MESSAGE[unavailable]);

      const [used] = await tx.query("select 1 from public.hero_free_rerolls where telegram_user_id = $1 and utc_day = $2::date", [memberId, day]);
      if (used) throw new FreeRerollError("ALREADY_USED_TODAY", 409, "You've already used today's free reroll.", { nextResetAt: nextRerollAt(now.getTime()) });

      // Committed Arena rosters are never touched: refused here, nothing consumed.
      try {
        await assertNotInArena(tx, hero.id);
      } catch (e) {
        if (e instanceof HeroVersionError && e.code === "HERO_IN_ARENA") throw new FreeRerollError("HERO_IN_ARENA", 409, BLOCK_MESSAGE.HERO_IN_ARENA);
        throw e;
      }

      const { row, previous: replaced } = await rollNewHeroVersion(tx, hero, requestId, memberActor(memberId), deps);
      await tx.query(
        `insert into public.hero_free_rerolls (telegram_user_id, utc_day, character_id, request_id, hero_version_id, previous_version_id,
                                               from_class_id, from_rarity, from_power, to_class_id, to_rarity, to_power, created_at)
         values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)`,
        [memberId, day, hero.id, requestId, row.id, replaced.id, replaced.class_id, replaced.rarity, Number(replaced.power), row.class_id, row.rarity, Number(row.power), now.toISOString()],
      );
      await audit(tx, memberActor(memberId), "hero.free_reroll", "character", hero.id, {
        heroId: hero.id,
        publicId: hero.public_id,
        utcDay: day,
        requestId,
        previousVersion: Number(replaced.version_number),
        newVersion: Number(row.version_number),
        previousVersionId: replaced.id,
        newVersionId: row.id,
        from: { classId: replaced.class_id, rarity: replaced.rarity, power: Number(replaced.power) },
        to: { classId: row.class_id, rarity: row.rarity, power: Number(row.power) },
        generatorVersion: row.generator_version,
      });
      const [allowance] = await tx.query<AllowanceRow>(`select ${ALLOWANCE_COLUMNS} from public.hero_free_rerolls where request_id = $1`, [requestId]);
      return resultFromAllowance(tx, allowance as AllowanceRow, deps, false);
    });
    if (publicId) invalidateHeroCards(publicId);
    return result;
  } catch (error) {
    if (error instanceof FreeRerollError) throw error;
    // The database is the last line of defence: if two writers ever got past the application's checks, its constraints answer the same way.
    const constraint = constraintOf(error);
    if (constraint === "hero_free_rerolls_pkey") throw new FreeRerollError("ALREADY_USED_TODAY", 409, "You've already used today's free reroll.", { nextResetAt: nextRerollAt(now.getTime()) });
    if (constraint === "hero_free_rerolls_request_id_key" || constraint === "hero_versions_request_key") throw new FreeRerollError("REQUEST_CONFLICT", 409, "That request key was already used.");
    throw error;
  }
}
