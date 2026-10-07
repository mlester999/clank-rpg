import { DEFAULT_ACHIEVEMENTS, DEFAULT_CLASSES, DEFAULT_SKILLS, generateDefaultItems } from "@/domain/content";
import { DEFAULT_SETTINGS, type SettingsKey } from "@/domain/settings";
import { json, type Queryable } from "../db/types";
import { backfillSpriteConfigs } from "../services/sprites";

export const DEFAULT_FLAGS: Array<{ key: string; enabled: boolean; description: string }> = [
  { key: "arena.live", enabled: true, description: "Global Idle Arena runs and advances." },
  { key: "telegram.ingest", enabled: true, description: "Accept Telegram webhook activity." },
  { key: "claims.enabled", enabled: true, description: "Allow members to claim their hero." },
  { key: "wallet.link", enabled: true, description: "Allow signed-message wallet linking." },
  { key: "holdings.bonuses", enabled: true, description: "Apply bonded-coin holding bonuses." },
  { key: "arena.picks", enabled: true, description: "Arena Picks: eligible members make ONE free pick on the NEXT fight while the current one is on stage; picks lock when the current fight's winner is decided. Correct scored picks earn Clank Points toward the Daily and Weekly leaderboards. No token is paid per battle. No stake, no deposit, no wager." },
  { key: "feature.bosses", enabled: false, description: "Coin bosses (coming soon)." },
  { key: "feature.expeditions", enabled: false, description: "Expeditions (coming soon)." },
  { key: "feature.pvp", enabled: false, description: "Ranked PvP and direct challenges (coming soon)." },
  { key: "feature.guilds", enabled: false, description: "Guilds and Community Wars (coming soon)." },
  { key: "feature.world", enabled: false, description: "Explorable world hubs (coming soon)." },
];

/** Whether `table.column` exists (the seed also runs on databases that are migrated only part of the way). */
async function hasColumn(q: Queryable, table: string, column: string): Promise<boolean> {
  const rows = await q.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2", [table, column]);
  return rows.length > 0;
}

/**
 * Idempotent: inserts only what is missing and NEVER overwrites rows an admin may have
 * edited. Safe to run on every boot / deploy.
 */
export async function seedReferenceData(q: Queryable): Promise<{ inserted: Record<string, number> }> {
  const inserted: Record<string, number> = {};
  const count = (key: string, rows: unknown[]) => (inserted[key] = rows.length);

  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    const rows = await q.query(
      "insert into public.game_settings (key, value, updated_by) values ($1, $2::jsonb, 'seed') on conflict (key) do nothing returning key",
      [key, json(DEFAULT_SETTINGS[key])],
    );
    inserted.settings = (inserted.settings ?? 0) + rows.length;
  }

  let n = 0;
  for (const [i, c] of DEFAULT_CLASSES.entries()) {
    n += (
      await q.query(
        `insert into public.character_classes (id, name, description, sort_order, definition)
         values ($1, $2, $3, $4, $5::jsonb) on conflict (id) do nothing returning id`,
        [c.id, c.name, c.tagline, (i + 1) * 10, json(c)],
      )
    ).length;
  }
  inserted.classes = n;

  n = 0;
  for (const s of DEFAULT_SKILLS) {
    n += (
      await q.query(
        "insert into public.skills (id, name, definition) values ($1, $2, $3::jsonb) on conflict (id) do nothing returning id",
        [s.id, s.name, json(s)],
      )
    ).length;
  }
  inserted.skills = n;

  n = 0;
  for (const a of DEFAULT_ACHIEVEMENTS) {
    n += (
      await q.query(
        `insert into public.achievements (id, name, description, category, criteria, reward, hidden, sort_order)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) on conflict (id) do nothing returning id`,
        [a.id, a.name, a.description, a.category, json(a.criteria), json(a.reward), a.hidden ?? false, a.sortOrder],
      )
    ).length;
  }
  inserted.achievements = n;

  n = 0;
  for (const it of generateDefaultItems()) {
    n += (
      await q.query(
        `insert into public.item_templates (id, name, description, slot, rarity, class_restriction, stat_mods, look, source_tag)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9) on conflict (id) do nothing returning id`,
        [it.id, it.name, it.description, it.slot, it.rarity, it.classRestriction ? json(it.classRestriction) : null, json(it.statMods), json(it.look), it.sourceTag],
      )
    ).length;
  }
  inserted.items = n;

  n = 0;
  for (const f of DEFAULT_FLAGS) {
    n += (
      await q.query(
        "insert into public.feature_flags (key, enabled, description, updated_by) values ($1, $2, $3, 'seed') on conflict (key) do nothing returning key",
        [f.key, f.enabled, f.description],
      )
    ).length;
  }
  inserted.flags = n;

  // Heroes that predate the layered-sprite system get their (deterministic) look persisted now.
  inserted.spriteConfigs = await backfillSpriteConfigs(q);

  // The DEVELOPMENT run — active by default so the arena has somewhere to record its (test) stats. It is NOT Season 1: Season 1 is created by the
  // Admin launch flow (services/lifecycle.ts), never by seeding. Seeding runs on every boot, so everything here only fills what is missing.
  const hasSeason = await q.query("select 1 from public.seasons limit 1");
  if (hasSeason.length === 0) {
    if (await hasColumn(q, "seasons", "kind")) {
      await q.query("insert into public.seasons (kind, run_number, name, status) values ('DEVELOPMENT', 1, 'Development / Beta', 'ACTIVE')");
    } else {
      await q.query("insert into public.seasons (number, name, status) values (1, 'Season 1 — Foundry Open', 'ACTIVE')"); // a database from before the lifecycle migration
    }
    inserted.seasons = 1;
  }
  // The game phase row (DEVELOPMENT until the launch). The migration creates it; a database that was truncated for a test run needs it back.
  if (await hasColumn(q, "game_state", "phase")) {
    inserted.gameState = (await q.query("insert into public.game_state (id) values (1) on conflict (id) do nothing returning id")).length;
  }
  void count;
  return { inserted };
}
