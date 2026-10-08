import { z } from "zod";

import { rollRarity, type AppearanceParts, type Rarity } from "@/domain/character/appearance";
import { rollAppearance } from "@/domain/character/appearance";
import { validateRpgName } from "@/domain/character/rpgName";
import { AUTHORED_GENERATOR_VERSION, buildHeroVersionState } from "@/domain/hero/heroVersion";
import { deriveSpriteConfig } from "@/domain/sprites/config";
import { classDefSchema, skillDefSchema, validateRuleset, rulesVersionFor } from "@/domain/rules";
import { settingsSchemas, type SettingsKey } from "@/domain/settings";
import { createRng } from "@/domain/util/rng";
import { parseTelegramExport } from "@/domain/telegram/exportParser";
import { json, type Db, type Queryable } from "../db/types";

import { loadClasses, loadSettings, loadSkills, saveSetting } from "../config/settingsRepo";
import { grantAchievement } from "./achievements";
import { refreshPower } from "./characters";
import { createInitialHeroVersion } from "./heroVersionStore";
import { AdminError } from "./adminError";
import { arenaEligibleSql } from "./arenaEligibility";
import { audit } from "./auditLog";
import { bumpSessionEpoch } from "./identity";
import { setTokenStatus } from "./tokens";
import { importMessages, recomputeTelegramUser, type IngestDeps } from "./telegramIngest";
import { pauseArena, resumeArena } from "./lifecycle";

/** Every admin mutation goes through here so it is audit-logged in the same transaction (the implementation lives in ./auditLog). */
export { audit };

// (AdminError lives in ./adminError so the lifecycle service can raise it without importing this whole module.)
export { AdminError };

// --- overview -----------------------------------------------------------------------------
export async function adminOverview(q: Queryable, allowDemo = false) {
  const [counts] = await q.query<Record<string, number>>(
    `select
       (select count(*)::int from public.telegram_users where not is_demo) as telegram_users,
       (select count(*)::int from public.telegram_users where status = 'FLAGGED') as flagged,
       (select count(*)::int from public.telegram_users where status = 'BANNED') as banned,
       (select count(*)::int from public.characters) as heroes,
       (select count(*)::int from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
         where ${arenaEligibleSql("$1")}) as arena_eligible_heroes,
       (select count(*)::int from public.characters where status = 'SUSPENDED') as suspended_heroes,
       (select count(*)::int from public.hero_versions) as hero_versions,
       (select count(*)::int from public.characters where is_demo) as demo_heroes,
       (select count(*)::int from public.character_claims) as claimed,
       (select count(*)::int from public.characters where kind = 'SPECIAL_CHARACTER') as special,
       (select count(*)::int from public.arena_battles where status = 'SETTLED') as battles_settled,
       (select count(*)::int from public.arena_cycles) as cycles,
       (select coalesce(sum(balance), 0)::int from public.currency_accounts) as gold_in_circulation,
       (select count(*)::int from public.eligible_tokens where status = 'ELIGIBLE') as tokens_eligible,
       (select count(*)::int from public.eligible_tokens where status = 'CANDIDATE') as tokens_candidates,
       (select count(*)::int from public.boss_drafts where status = 'DRAFT') as boss_drafts`,
    [allowDemo],
  );
  const [state] = await q.query<{ status: string; last_advance_at: Date | null }>("select status, last_advance_at from public.arena_state where id = 1");
  const [game] = await q.query<{ phase: string }>("select phase from public.game_state where id = 1");
  const [cycle] = await q.query("select number, status, hero_count, carried_in_count, created_at from public.arena_cycles where status = 'ACTIVE' limit 1");
  const [season] = await q.query("select kind, number, name, status from public.seasons where status = 'ACTIVE' limit 1");
  const recent = await q.query<Record<string, unknown>>(
    "select id, season_sequence as battle, sequence, status, starts_at, duration_ms, ended_by, events_hash from public.arena_battles order by sequence desc limit 8",
  );
  return {
    counts,
    arena: { status: state?.status ?? "NOT_STARTED", paused: state?.status === "PAUSED", lastAdvanceAt: state?.last_advance_at ?? null, cycle: cycle ?? null, season: season ?? null, recent },
    phase: game?.phase ?? "DEVELOPMENT",
    rulesVersion: rulesVersionFor((await loadSettings(q)).combat),
  };
}

export async function telegramEligibilityOverview(q: Queryable) {
  const settings = await loadSettings(q);
  const [counts] = await q.query<{ eligible_telegram_users: number; heroes_created: number; eligible_without_hero: number }>(
    `select
       (select count(*)::int from public.telegram_users u
         where u.status = 'OK' and not u.is_demo and u.qualifying_message_count >= $1) as eligible_telegram_users,
       (select count(*)::int from public.characters c
         where c.kind = 'COMMUNITY' and not c.is_demo) as heroes_created,
       (select count(*)::int from public.telegram_users u
         where u.status = 'OK' and not u.is_demo and u.qualifying_message_count >= $1
           and not exists (select 1 from public.characters c where c.telegram_user_id = u.telegram_user_id)) as eligible_without_hero`,
    [settings.telegram.qualifyingThreshold],
  );
  return {
    threshold: settings.telegram.qualifyingThreshold,
    eligibleTelegramUsers: Number(counts?.eligible_telegram_users ?? 0),
    heroesCreated: Number(counts?.heroes_created ?? 0),
    eligibleWithoutHero: Number(counts?.eligible_without_hero ?? 0),
  };
}

// --- heroes -------------------------------------------------------------------------------
const heroPatch = z.strictObject({
  status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]).optional(),
  /** RPG display name (null clears the override and returns to the generated name). Validated by validateRpgName. */
  nameOverride: z.string().max(200).nullable().optional(),
  adminNote: z.string().trim().max(500).nullable().optional(),
  title: z.string().trim().max(60).nullable().optional(),
  grantAchievement: z.string().regex(/^[a-z][a-z0-9_]{1,50}$/).optional(),
  unclaim: z.literal(true).optional(),
});

export interface RenameResult {
  changed: boolean;
  heroId: string;
  oldName: string;
  newName: string;
}

/**
 * The ONE way an RPG display name changes. Presentation only: it writes characters.name_override (+ who/when) and an
 * audit entry — nothing else. Identity, class, stats, claims, wallets and history are never touched, and ownership is
 * never derived from the name. `name = null` clears the override (back to the generated name).
 */
export async function setRpgNameInTx(tx: Queryable, id: string, name: string | null, actor: string): Promise<RenameResult> {
  const [hero] = await tx.query<{ id: string; name: string; name_override: string | null; telegram_user_id: number | null; kind: string }>(
    "select id, name, name_override, telegram_user_id, kind from public.characters where id = $1 for update",
    [id],
  );
  if (!hero) throw new AdminError("NOT_FOUND", 404);
  let next: string | null = null;
  if (name !== null) {
    const v = validateRpgName(name);
    if (!v.ok) throw new AdminError("INVALID_NAME", 422, v.message);
    next = v.name;
  }
  const oldName = hero.name_override ?? hero.name;
  const newName = next ?? hero.name;
  if (next === hero.name_override) return { changed: false, heroId: id, oldName, newName };
  await tx.query("update public.characters set name_override = $2, name_changed_at = now(), name_changed_by = 'ADMIN' where id = $1", [id, next]);
  await audit(tx, actor, "hero.rename", "character", id, {
    heroId: id,
    telegramUserId: hero.telegram_user_id,
    heroKind: hero.kind,
    oldName,
    newName,
    previousOverride: hero.name_override,
    newOverride: next,
    cleared: next === null,
    // The admin console is protected by one shared key, so an individual operator cannot be identified. Say so.
    operator: "shared admin key (individual operator not identifiable)",
  });
  return { changed: true, heroId: id, oldName, newName };
}

export async function renameHero(db: Db, id: string, name: string | null, actor: string): Promise<RenameResult> {
  return db.transaction((tx) => setRpgNameInTx(tx, id, name, actor));
}

/** Admin notes: up to 500 characters, newlines allowed, other control characters not. Blank clears the note. */
function cleanNote(note: string | null): string | null {
  const text = note === null ? null : note.trim() || null;
  if (text !== null && (Array.from(text).length > 500 || /[^\P{Cc}\n]/u.test(text))) throw new AdminError("INVALID_NOTE", 422, "Notes can be at most 500 characters, without control characters.");
  return text;
}

export async function setHeroNote(db: Db, id: string, note: string | null, actor: string): Promise<void> {
  const text = cleanNote(note);
  await db.transaction(async (tx) => {
    const [hero] = await tx.query<{ admin_note: string | null }>("select admin_note from public.characters where id = $1 for update", [id]);
    if (!hero) throw new AdminError("NOT_FOUND", 404);
    if ((hero.admin_note ?? null) === text) return;
    await tx.query("update public.characters set admin_note = $2 where id = $1", [id, text]);
    await audit(tx, actor, "hero.note", "character", id, { previous: hero.admin_note, note: text });
  });
}

export async function patchHero(db: Db, id: string, patch: unknown, actor: string): Promise<void> {
  const p = heroPatch.parse(patch);
  const { nameOverride, adminNote, ...rest } = p;
  await db.transaction(async (tx) => {
    const [hero] = await tx.query<{ id: string }>("select id from public.characters where id = $1 for update", [id]);
    if (!hero) throw new AdminError("NOT_FOUND", 404);
    if (p.status) await tx.query("update public.characters set status = $2 where id = $1", [id, p.status]);
    if (nameOverride !== undefined) await setRpgNameInTx(tx, id, nameOverride, actor);
    if (adminNote !== undefined) {
      await tx.query("update public.characters set admin_note = $2 where id = $1", [id, cleanNote(adminNote)]);
    }
    if (p.title !== undefined) await tx.query("update public.characters set title = $2 where id = $1", [id, p.title]);
    if (p.grantAchievement) {
      const exists = await tx.query("select 1 from public.achievements where id = $1", [p.grantAchievement]);
      if (!exists.length) throw new AdminError("UNKNOWN_ACHIEVEMENT", 404);
      await grantAchievement(tx, id, p.grantAchievement);
    }
    if (p.unclaim) {
      const removed = await tx.query<{ telegram_user_id: number }>("delete from public.character_claims where character_id = $1 returning telegram_user_id", [id]);
      if (removed[0]) await bumpSessionEpoch(tx, removed[0].telegram_user_id);
      await tx.query("update public.wallet_links set unlinked_at = now() where character_id = $1 and unlinked_at is null", [id]);
    }
    // The rename is audited by setRpgNameInTx with old/new values; everything else is logged here.
    if (Object.keys(rest).length || adminNote !== undefined) await audit(tx, actor, "hero.patch", "character", id, { ...rest, ...(adminNote !== undefined ? { adminNote } : {}) });
  });
}

// --- Telegram eligibility, flags, import ---------------------------------------------------
export async function listTelegramUsers(q: Queryable, opts: { status?: string; search?: string; limit?: number }) {
  const like = opts.search ? `%${opts.search.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  return q.query(
    `select telegram_user_id, username, display_name, status, flag_reason, qualifying_message_count, total_message_count, active_days, activity_score,
            reactions_received, replies_received, last_message_at, eligible_at, (behavior->>'spam')::int as spam_rejects
       from public.telegram_users
      where not is_demo and ($1::text is null or status = $1) and ($2::text is null or lower(coalesce(username, '')) like $2 escape '\\' or lower(display_name) like $2 escape '\\')
      order by (status <> 'OK') desc, last_message_at desc nulls last limit $3`,
    [opts.status ?? null, like, Math.min(opts.limit ?? 50, 200)],
  );
}

export async function setTelegramStatus(db: Db, telegramUserId: number, status: "OK" | "FLAGGED" | "BANNED", reason: string | null, actor: string, deps: IngestDeps): Promise<void> {
  await db.transaction(async (tx) => {
    const [u] = await tx.query<{ status: string }>("select status from public.telegram_users where telegram_user_id = $1 for update", [telegramUserId]);
    if (!u) throw new AdminError("NOT_FOUND", 404);
    await tx.query("update public.telegram_users set status = $2, flag_reason = $3 where telegram_user_id = $1", [telegramUserId, status, status === "OK" ? null : reason]);
    if (status === "BANNED") {
      await tx.query("update public.characters set status = 'SUSPENDED' where telegram_user_id = $1", [telegramUserId]);
      await bumpSessionEpoch(tx, telegramUserId);
    } else if (u.status === "BANNED") {
      await tx.query("update public.characters set status = 'ACTIVE' where telegram_user_id = $1 and status = 'SUSPENDED'", [telegramUserId]);
    }
    // Flag changes alter which stored messages qualify, so rebuild the member from stored features.
    await recomputeTelegramUser(tx, telegramUserId, deps);
    await audit(tx, actor, "telegram.status", "telegram_user", String(telegramUserId), { from: u.status, to: status, reason });
  });
}

export async function importTelegramExportJson(db: Db, exportJson: unknown, deps: IngestDeps, actor: string, chatId?: number) {
  const parsed = parseTelegramExport(exportJson, chatId !== undefined ? { chatId } : {});
  const summary = await importMessages(db, parsed.messages, deps);
  await audit(db, actor, "telegram.import", "chat", String(parsed.chatId), { chatName: parsed.chatName, skipped: parsed.skipped, summary });
  return { chatId: parsed.chatId, chatName: parsed.chatName, skipped: parsed.skipped, summary };
}

// --- settings / classes / skills -----------------------------------------------------------
export async function getAllConfig(q: Queryable) {
  const [settings, classes, skills] = await Promise.all([loadSettings(q), loadClasses(q, false), loadSkills(q)]);
  const versions = await q.query<{ key: string; version: number; updated_by: string | null; updated_at: Date }>("select key, version, updated_by, updated_at from public.game_settings order by key");
  const enabled = await q.query<{ id: string; enabled: boolean }>("select id, enabled from public.character_classes");
  return { settings, classes, skills, versions, classEnabled: Object.fromEntries(enabled.map((e) => [e.id, e.enabled])) };
}

export async function putSetting(db: Db, key: string, value: unknown, actor: string) {
  if (!(key in settingsSchemas)) throw new AdminError("UNKNOWN_SETTING", 404);
  return db.transaction(async (tx) => {
    const saved = await saveSetting(tx, key as SettingsKey, value, actor);
    await audit(tx, actor, "settings.put", "game_setting", key, { value: saved });
    return saved;
  });
}

export async function putClass(db: Db, id: string, definition: unknown, enabled: boolean | undefined, actor: string) {
  const def = classDefSchema.parse(definition);
  if (def.id !== id) throw new AdminError("ID_MISMATCH", 422);
  await db.transaction(async (tx) => {
    const skills = await loadSkills(tx);
    const classes = (await loadClasses(tx, false)).filter((c) => c.id !== id);
    // Validate the whole ruleset still holds together (e.g. the class's skills exist).
    const [s] = [await loadSettings(tx)];
    validateRuleset({
      rulesVersion: rulesVersionFor(s.combat),
      combat: s.combat,
      classes: Object.fromEntries([...classes, def].map((c) => [c.id, c])),
      skills: Object.fromEntries(skills.map((k) => [k.id, k])),
    });
    await tx.query(
      `insert into public.character_classes (id, name, description, enabled, definition) values ($1, $2, $3, coalesce($4::boolean, true), $5::jsonb)
       on conflict (id) do update set name = excluded.name, description = excluded.description, definition = excluded.definition,
         enabled = coalesce($4::boolean, public.character_classes.enabled)`,
      [id, def.name, def.tagline, enabled ?? null, json(def)],
    );
    await audit(tx, actor, "class.put", "character_class", id, { enabled, definition: def });
  });
}

export async function putSkill(db: Db, id: string, definition: unknown, actor: string) {
  const def = skillDefSchema.parse(definition);
  if (def.id !== id) throw new AdminError("ID_MISMATCH", 422);
  await db.transaction(async (tx) => {
    await tx.query(
      "insert into public.skills (id, name, definition) values ($1, $2, $3::jsonb) on conflict (id) do update set name = excluded.name, definition = excluded.definition",
      [id, def.name, json(def)],
    );
    await audit(tx, actor, "skill.put", "skill", id, def);
  });
}

// --- seasons -------------------------------------------------------------------------------
/** Read-only: seasons are created, ended and archived by the lifecycle actions (services/lifecycle.ts) — never by editing a row. */
export async function listSeasons(q: Queryable) {
  return q.query(
    `select id, kind, number, name, status, starts_at, ends_at, battle_counter as last_battle, ended_reason,
            (select count(*)::int from public.arena_battles b where b.season_id = s.id and b.status = 'SETTLED') as battles_settled
       from public.seasons s order by starts_at desc, created_at desc`,
  );
}

// --- arena controls ------------------------------------------------------------------------
/**
 * The pre-lifecycle Arena controls, kept for the existing API shape. pause / resume are the lifecycle actions (see services/lifecycle.ts: PAUSE
 * drains the battles already committed, RESUME continues the same season). The two maintenance actions are EMERGENCY tools — void a battle that
 * went wrong, abort a cycle — so they work in any Arena state: they take the arena's own row lock first (the same lock every Arena step and every
 * lifecycle action holds), so they serialize against all of them and can never tear a step in half. (A pause would drain exactly the battle you
 * want to void, which is why they do not wait for one.)
 */
export async function arenaAdmin(db: Db, action: "pause" | "resume" | "void_unsettled" | "abort_cycle", actor: string, opts: { allowDemo?: boolean; now?: () => Date } = {}) {
  const deps = { actor, allowDemo: opts.allowDemo ?? false, ...(opts.now ? { now: opts.now } : {}) };
  if (action === "pause") {
    await pauseArena(db, deps);
    return;
  }
  if (action === "resume") {
    await resumeArena(db, deps);
    return;
  }
  await db.transaction(async (tx) => {
    await tx.query("select status from public.arena_state where id = 1 for update");
    if (action === "void_unsettled") {
      const voided = await tx.query<{ id: string }>("update public.arena_battles set status = 'VOID' where status in ('SCHEDULED', 'SIMULATED') returning id");
      for (const b of voided) {
        // Heroes keep their turn: their queue entries become pending again, at their original position.
        await tx.query("update public.arena_queue_entries set status = 'PENDING', battle_id = null where battle_id = $1 and status = 'IN_BATTLE'", [b.id]);
      }
    } else {
      await tx.query("update public.arena_queue_entries set status = 'SKIPPED' where status = 'PENDING' and cycle_id in (select id from public.arena_cycles where status = 'ACTIVE')");
      await tx.query("update public.arena_cycles set status = 'ABORTED', completed_at = now() where status = 'ACTIVE'");
    }
    await audit(tx, actor, `arena.${action}`, "arena", null);
  });
}

export async function arenaOverview(q: Queryable) {
  const cycles = await q.query("select number, status, seed, hero_count, carried_in_count, carried_out_count, created_at, completed_at from public.arena_cycles order by number desc limit 10");
  const queue = await q.query(
    `select e.position, e.status, e.carried_in, coalesce(c.name_override, c.name) as name, c.class_id, c.power from public.arena_queue_entries e
       join public.characters c on c.id = e.character_id join public.arena_cycles y on y.id = e.cycle_id and y.status = 'ACTIVE' order by e.position limit 64`,
  );
  return { cycles, queue };
}

// --- items, achievements, flags ------------------------------------------------------------
const itemSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,50}$/),
  name: z.string().min(1).max(60),
  description: z.string().max(240).default(""),
  slot: z.enum(["WEAPON", "ARMOR", "TRINKET"]),
  rarity: z.enum(["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"]),
  classRestriction: z.array(z.string()).nullable().default(null),
  statMods: z.record(z.enum(["hp", "str", "def", "int", "agi", "cha", "luck"]), z.number().min(-50).max(50)),
  sourceTag: z.string().max(40).default("ADMIN"),
  enabled: z.boolean().default(true),
});

export async function putItem(db: Db, input: unknown, actor: string) {
  const i = itemSchema.parse(input);
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into public.item_templates (id, name, description, slot, rarity, class_restriction, stat_mods, source_tag, enabled)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10)
       on conflict (id) do update set name = excluded.name, description = excluded.description, slot = excluded.slot, rarity = excluded.rarity,
         class_restriction = excluded.class_restriction, stat_mods = excluded.stat_mods, source_tag = excluded.source_tag, enabled = excluded.enabled`,
      [i.id, i.name, i.description, i.slot, i.rarity, i.classRestriction ? json(i.classRestriction) : null, json(i.statMods), i.sourceTag, i.enabled],
    );
    await audit(tx, actor, "item.put", "item_template", i.id, i);
  });
}

export async function listItems(q: Queryable) {
  return q.query("select id, name, slot, rarity, class_restriction, stat_mods, source_tag, enabled from public.item_templates order by slot, array_position(array['COMMON','UNCOMMON','RARE','EPIC','LEGENDARY'], rarity), id");
}

const achievementSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,50}$/),
  name: z.string().min(1).max(60),
  description: z.string().max(240).default(""),
  category: z.string().max(30).default("GENERAL"),
  criteria: z.union([z.strictObject({ metric: z.enum(["battles", "wins", "top2", "eliminations", "telegram_qualifying", "telegram_active_days", "diamond_days", "bonded_tokens_held"]), gte: z.number().min(0) }), z.strictObject({ type: z.enum(["manual", "locked"]) })]),
  reward: z.strictObject({ badge: z.string().min(1).max(40), title: z.string().max(60).optional(), gold: z.number().int().min(0).max(1000).optional() }),
  hidden: z.boolean().default(false),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(100),
});

export async function putAchievement(db: Db, input: unknown, actor: string) {
  const a = achievementSchema.parse(input);
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into public.achievements (id, name, description, category, criteria, reward, hidden, enabled, sort_order)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
       on conflict (id) do update set name = excluded.name, description = excluded.description, category = excluded.category, criteria = excluded.criteria,
         reward = excluded.reward, hidden = excluded.hidden, enabled = excluded.enabled, sort_order = excluded.sort_order`,
      [a.id, a.name, a.description, a.category, json(a.criteria), json(a.reward), a.hidden, a.enabled, a.sortOrder],
    );
    await audit(tx, actor, "achievement.put", "achievement", a.id, a);
  });
}

export async function listAchievements(q: Queryable) {
  return q.query("select a.id, a.name, a.category, a.criteria, a.reward, a.enabled, (select count(*)::int from public.character_achievements ca where ca.achievement_id = a.id and ca.archived_at is null) as unlocked from public.achievements a order by a.sort_order");
}

export async function listFlags(q: Queryable) {
  return q.query("select key, enabled, description, updated_by, updated_at from public.feature_flags order by key");
}

export async function setFlag(db: Db, key: string, enabled: boolean, actor: string) {
  await db.transaction(async (tx) => {
    const rows = await tx.query("update public.feature_flags set enabled = $2, updated_by = $3, updated_at = now() where key = $1 returning key", [key, enabled, actor]);
    if (!rows.length) throw new AdminError("NOT_FOUND", 404);
    await audit(tx, actor, "flag.set", "feature_flag", key, { enabled });
  });
}

// --- tokens + boss drafts ------------------------------------------------------------------
export async function listTokens(q: Queryable) {
  return q.query(
    `select t.id, t.chain_id, t.address, t.symbol, t.name, t.status, t.bonded_observed, t.catalog_state, t.catalog_progress, t.total_supply, t.price_quote, t.quote_symbol,
            t.approved_by, t.approved_at, (select count(*)::int from public.token_holdings h where h.token_id = t.id and h.balance > 0) as holders
       from public.eligible_tokens t order by (t.status = 'CANDIDATE') desc, t.symbol`,
  );
}

export async function adminSetTokenStatus(db: Db, id: string, status: "CANDIDATE" | "ELIGIBLE" | "REJECTED" | "DELISTED", actor: string) {
  await db.transaction(async (tx) => {
    await setTokenStatus(tx, id, status, actor);
    await audit(tx, actor, "token.status", "eligible_token", id, { status });
  });
}

export async function listBossDrafts(q: Queryable) {
  return q.query(
    `select d.id, d.status, d.identity, d.stats, d.abilities, d.lore, d.loot, d.generated_by, d.approved_by, d.approved_at, t.symbol, t.name as token_name
       from public.boss_drafts d join public.eligible_tokens t on t.id = d.token_id order by d.created_at desc`,
  );
}

/** Approval records an admin decision only. Bosses are not playable in this Beta (feature.bosses stays off). */
export async function decideBossDraft(db: Db, id: string, decision: "APPROVED" | "REJECTED", actor: string) {
  await db.transaction(async (tx) => {
    const rows = await tx.query(
      "update public.boss_drafts set status = $2, approved_by = $3, approved_at = now() where id = $1 and status = 'DRAFT' returning id",
      [id, decision, actor],
    );
    if (!rows.length) throw new AdminError("NOT_FOUND_OR_NOT_DRAFT", 404);
    await audit(tx, actor, `boss.${decision.toLowerCase()}`, "boss_draft", id);
  });
}

// --- special characters --------------------------------------------------------------------
const specialSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  classId: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  role: z.string().max(80),
  bio: z.string().max(500).default(""),
  rarity: z.enum(["COMMON", "RARE", "EPIC", "LEGENDARY"]).default("LEGENDARY"),
  fixedStats: z.strictObject({ hp: z.number().min(1), str: z.number().min(1), def: z.number().min(1), int: z.number().min(1), agi: z.number().min(1), cha: z.number().min(1), luck: z.number().min(1) }).optional(),
  appearanceSeed: z.string().max(60).default("special"),
  active: z.boolean().default(false),
});

/**
 * Creates a SPECIAL_CHARACTER (team/staff hero) from admin-authored data. Never generated from
 * Telegram rules; has no level (their standing is the `role` shown on the profile and the
 * authored `fixedStats`); starts INACTIVE so it does not enter the arena until an admin activates it.
 */
export async function createSpecialCharacter(db: Db, input: unknown, actor: string) {
  const s = specialSchema.parse(input);
  return db.transaction(async (tx) => {
    const classes = await loadClasses(tx, false);
    const cls = classes.find((c) => c.id === s.classId);
    if (!cls) throw new AdminError("UNKNOWN_CLASS", 404);
    const rng = createRng(`special/${s.appearanceSeed}`);
    const rarity: Rarity = s.rarity;
    void rollRarity;
    const parts: AppearanceParts = rollAppearance(rng, cls, rarity);
    const [row] = await tx.query<{ id: string }>(
      `insert into public.characters (kind, telegram_user_id, class_id, name, status, origin, is_demo)
       values ('SPECIAL_CHARACTER', null, $1, $2, $3, 'ADMIN', false) returning id`,
      [s.classId, s.name, s.active ? "ACTIVE" : "INACTIVE"],
    );
    const id = (row as { id: string }).id;
    const settings = await loadSettings(tx);
    const seed = s.appearanceSeed || "special";
    const sprite = deriveSpriteConfig(parts, cls.look, rarity);
    await tx.query("insert into public.character_stats (character_id, variation, fixed_stats) values ($1, '{}'::jsonb, $2::jsonb)", [id, s.fixedStats ? json(s.fixedStats) : null]);
    await tx.query("insert into public.character_appearances (character_id, rarity, parts, seed, sprite) values ($1, $2, $3::jsonb, $4, $5::jsonb)", [id, rarity, json(parts), seed, json(sprite)]);
    // A special character is a hero too: it is created TOGETHER with its INITIAL v1 (the database refuses to commit one without it).
    await createInitialHeroVersion(
      tx, id,
      buildHeroVersionState({ generationSeed: seed, appearanceSeed: seed, classDef: cls, rarity, variation: {}, telegramBonus: {}, fixedStats: s.fixedStats ?? null, appearance: parts, sprite, spriteSet: settings.visuals.spriteSet, settings: settings.character, generatorVersion: AUTHORED_GENERATOR_VERSION }),
      "system:admin",
    );
    await tx.query("insert into public.special_character_profiles (character_id, role, bio, created_by) values ($1, $2, $3, $4)", [id, s.role, s.bio, actor]);
    await refreshPower(tx, id, settings, classes);
    await audit(tx, actor, "special.create", "character", id, { name: s.name, classId: s.classId, role: s.role });
    return { id };
  });
}


export async function listAudit(q: Queryable, limit = 100) {
  return q.query("select id, actor, action, entity_type, entity_id, detail, created_at from public.admin_audit_log order by id desc limit $1", [Math.min(limit, 500)]);
}
