import { classDefSchema, skillDefSchema, validateRuleset, hashRuleset, rulesVersionFor, type ClassDef, type Ruleset, type SkillDef } from "@/domain/rules";
import { DEFAULT_SETTINGS, parseSettings, settingsSchemas, type GameSettings, type SettingsKey } from "@/domain/settings";
import { canonicalJson } from "@/domain/util/hash";
import { json, type Queryable } from "../db/types";

const KEYS = Object.keys(settingsSchemas) as SettingsKey[];

/** Reads all game settings; any missing key falls back to the shipped default. */
export async function loadSettings(q: Queryable): Promise<GameSettings> {
  const rows = await q.query<{ key: string; value: unknown }>("select key, value from public.game_settings");
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<string, unknown>;
  for (const key of KEYS) {
    out[key] = byKey.has(key) ? parseSettings(key, byKey.get(key)) : DEFAULT_SETTINGS[key];
  }
  return out as unknown as GameSettings;
}

export async function saveSetting(q: Queryable, key: SettingsKey, value: unknown, actor: string): Promise<GameSettings[SettingsKey]> {
  const parsed = parseSettings(key, value);
  await q.query(
    `insert into public.game_settings (key, value, updated_by) values ($1, $2::jsonb, $3)
     on conflict (key) do update set value = excluded.value, version = public.game_settings.version + 1,
       updated_by = excluded.updated_by, updated_at = now()`,
    [key, json(parsed), actor],
  );
  return parsed;
}

export async function loadClasses(q: Queryable, onlyEnabled = true): Promise<ClassDef[]> {
  const rows = await q.query<{ definition: unknown }>(
    `select definition from public.character_classes ${onlyEnabled ? "where enabled" : ""} order by sort_order, id`,
  );
  return rows.map((r) => classDefSchema.parse(r.definition));
}

export async function loadSkills(q: Queryable): Promise<SkillDef[]> {
  const rows = await q.query<{ definition: unknown }>("select definition from public.skills where enabled order by id");
  return rows.map((r) => skillDefSchema.parse(r.definition));
}

/**
 * The ruleset a NEW battle will be simulated with. Classes disabled by an admin still
 * resolve for heroes that already have them (we load ALL classes for combat, but only
 * enabled ones are rolled for new heroes).
 */
export async function loadRuleset(q: Queryable, settings?: GameSettings): Promise<{ ruleset: Ruleset; hash: string }> {
  const s = settings ?? (await loadSettings(q));
  const [classes, skills] = await Promise.all([loadClasses(q, false), loadSkills(q)]);
  const ruleset = validateRuleset({
    // 3.1.0 only when the stored combat settings carry `engagement` (settings migration 20261007002300); until then new battles are 3.0.0.
    rulesVersion: rulesVersionFor(s.combat),
    combat: s.combat,
    classes: Object.fromEntries(classes.map((c) => [c.id, c])),
    skills: Object.fromEntries(skills.map((k) => [k.id, k])),
  });
  return { ruleset, hash: hashRuleset(ruleset) };
}

/** Stores an immutable, content-addressed copy of the ruleset (idempotent). */
export async function ensureRulesetSnapshot(q: Queryable, ruleset: Ruleset, hash: string): Promise<void> {
  await q.query(
    `insert into public.ruleset_snapshots (hash, rules_version, ruleset) values ($1, $2, $3::jsonb)
     on conflict (hash) do nothing`,
    [hash, ruleset.rulesVersion, canonicalJson(ruleset)],
  );
}

export async function loadRulesetSnapshot(q: Queryable, hash: string): Promise<Ruleset> {
  const rows = await q.query<{ ruleset: unknown }>("select ruleset from public.ruleset_snapshots where hash = $1", [hash]);
  if (!rows[0]) throw new Error(`ruleset snapshot ${hash} not found`);
  return validateRuleset(rows[0].ruleset);
}
