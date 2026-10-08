import type { AppearanceParts, Rarity } from "@/domain/character/appearance";
import type { HeroVersionAction, HeroVersionState } from "@/domain/hero/heroVersion";
import type { SpriteConfig } from "@/domain/sprites/config";
import type { StatBlock } from "@/domain/stats";

import { json, type Queryable } from "../db/types";

/**
 * Low-level access to a hero's version history. See supabase/migrations/20261005001800_hero_versions.sql for the model:
 *   hero_versions + characters.current_hero_version_id  = the AUTHORITY;  class / stats / look columns = the materialised projection.
 * The workflow (preview, apply, rollback) lives in heroVersions.ts; this file only reads and appends rows.
 */

export interface HeroVersionRow {
  id: string;
  character_id: string;
  version_number: number;
  action: HeroVersionAction;
  source_version_id: string | null;
  previous_version_id: string | null;
  request_id: string | null;
  generation_seed: string;
  generator_version: string;
  class_id: string;
  rarity: Rarity;
  variation: Partial<StatBlock>;
  telegram_bonus: Partial<StatBlock>;
  stats: StatBlock;
  power: number;
  appearance_seed: string;
  appearance: AppearanceParts;
  sprite: SpriteConfig | null;
  render: { spriteSet?: string };
  created_at: Date;
  created_by: string;
}

export const VERSION_COLUMNS =
  "id, character_id, version_number, action, source_version_id, previous_version_id, request_id, generation_seed, generator_version, class_id, rarity, variation, telegram_bonus, stats, power, appearance_seed, appearance, sprite, render, created_at, created_by";

/** The generated-state columns of a version row → the application-side state object. */
export function rowToState(r: HeroVersionRow): HeroVersionState {
  return {
    generationSeed: r.generation_seed,
    generatorVersion: r.generator_version,
    classId: r.class_id,
    rarity: r.rarity,
    variation: r.variation,
    telegramBonus: r.telegram_bonus,
    stats: r.stats,
    power: Number(r.power),
    appearanceSeed: r.appearance_seed,
    appearance: r.appearance,
    sprite: r.sprite,
    render: { spriteSet: r.render?.spriteSet ?? "clank-dev-v1" }, // a row written before render info existed was drawn with v1 (history stays true)
  };
}

export interface InsertVersionInput {
  characterId: string;
  versionNumber: number;
  action: HeroVersionAction;
  sourceVersionId?: string | null;
  previousVersionId?: string | null;
  requestId?: string | null;
  state: HeroVersionState;
  createdBy: string;
}

/** Appends one version row. The caller (holding the hero's row lock) decides the version number; (character_id, version_number) is unique. */
export async function insertHeroVersion(q: Queryable, i: InsertVersionInput): Promise<HeroVersionRow> {
  const s = i.state;
  const [row] = await q.query<HeroVersionRow>(
    `insert into public.hero_versions (
       character_id, version_number, action, source_version_id, previous_version_id, request_id, generation_seed, generator_version,
       class_id, rarity, variation, telegram_bonus, stats, power, appearance_seed, appearance, sprite, render, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16::jsonb, $17::jsonb, $18::jsonb, $19)
     returning ${VERSION_COLUMNS}`,
    [
      i.characterId, i.versionNumber, i.action, i.sourceVersionId ?? null, i.previousVersionId ?? null, i.requestId ?? null, s.generationSeed, s.generatorVersion,
      s.classId, s.rarity, json(s.variation), json(s.telegramBonus), json(s.stats), s.power, s.appearanceSeed, json(s.appearance), s.sprite === null ? null : json(s.sprite), json(s.render), i.createdBy,
    ],
  );
  return row as HeroVersionRow;
}

/**
 * Creates v1 / INITIAL for a hero that was JUST inserted (with its character_stats + character_appearances rows) in this transaction, and makes it
 * the current version. Part of hero creation — never call it for a hero that already has a version (the unique INITIAL index would refuse).
 */
export async function createInitialHeroVersion(q: Queryable, characterId: string, state: HeroVersionState, createdBy: string): Promise<string> {
  const row = await insertHeroVersion(q, { characterId, versionNumber: 1, action: "INITIAL", state, createdBy });
  await q.query("update public.characters set current_hero_version_id = $2 where id = $1", [characterId, row.id]);
  return row.id;
}

export async function loadCurrentVersion(q: Queryable, characterId: string): Promise<HeroVersionRow | null> {
  const [row] = await q.query<HeroVersionRow>(
    `select ${VERSION_COLUMNS.split(", ").map((c) => `v.${c}`).join(", ")} from public.hero_versions v
       join public.characters c on c.current_hero_version_id = v.id where c.id = $1`,
    [characterId],
  );
  return row ?? null;
}

export async function loadVersion(q: Queryable, characterId: string, versionId: string): Promise<HeroVersionRow | null> {
  const [row] = await q.query<HeroVersionRow>(`select ${VERSION_COLUMNS} from public.hero_versions where id = $1 and character_id = $2`, [versionId, characterId]);
  return row ?? null;
}

/** Every version, newest first. */
export async function listVersionRows(q: Queryable, characterId: string): Promise<HeroVersionRow[]> {
  return q.query<HeroVersionRow>(`select ${VERSION_COLUMNS} from public.hero_versions where character_id = $1 order by version_number desc`, [characterId]);
}

export interface ArenaLock {
  locked: boolean;
  /** The unsettled battles the hero is rostered in (sequence numbers are admin-facing only). */
  battles: Array<{ sequence: number; status: "SCHEDULED" | "SIMULATED" }>;
}

/**
 * Is this hero part of ANY roster that is not settled yet?
 *
 * Rosters are committed when a battle is SCHEDULED and frozen (snapshot + outcome) when it is SIMULATED, and the Arena keeps several ahead —
 * the battle on stage, the UPCOMING pick target and one more prepared battle. Users can already see and pick the fighters of every one of
 * them, so changing such a hero would change a fighter AFTER people looked at (and picked) it. A hero is free again only once all of those
 * battles are SETTLED (or void). It is never enough to look at the visually current battle.
 */
export async function heroArenaLock(q: Queryable, characterId: string): Promise<ArenaLock> {
  const rows = await q.query<{ sequence: number; status: "SCHEDULED" | "SIMULATED" }>(
    `select b.sequence, b.status from public.arena_participants p join public.arena_battles b on b.id = p.battle_id
      where p.character_id = $1 and b.status in ('SCHEDULED', 'SIMULATED') order by b.sequence`,
    [characterId],
  );
  return { locked: rows.length > 0, battles: rows.map((r) => ({ sequence: Number(r.sequence), status: r.status })) };
}
