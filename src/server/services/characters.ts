import { generateCharacter } from "@/domain/character/generate";
import { versionStateFromGenerated } from "@/domain/hero/heroVersion";
import { computeHeroPower } from "@/domain/hero/power";
import { computeEffectiveStats, type EffectiveStats } from "@/domain/character/stats";
import type { AppearanceParts, Rarity } from "@/domain/character/appearance";
import { resolveSpriteConfig, type SpriteConfig } from "@/domain/sprites/config";
import type { Tactic } from "@/domain/combat/types";
import type { ClassDef, Ruleset } from "@/domain/rules";
import type { GameSettings } from "@/domain/settings";
import { addStats, zeroStats, type StatBlock } from "@/domain/stats";
import type { BehaviorCounters } from "@/domain/telegram/types";
import type { CombatUnitInput } from "@/domain/combat/types";
import { json, type Db, type Queryable } from "../db/types";

import { createInitialHeroVersion } from "./heroVersionStore";

export type CharacterOrigin = "TELEGRAM" | "HISTORICAL_IMPORT" | "ADMIN" | "DEV_SEED";

export interface TelegramUserRow {
  telegram_user_id: number;
  username: string | null;
  display_name: string;
  status: "OK" | "FLAGGED" | "BANNED";
  is_demo: boolean;
  activity_score: number;
  behavior: Partial<BehaviorCounters>;
}

export interface CreateCharacterOptions {
  settings: GameSettings;
  classes: ClassDef[];
  secret: string;
  origin: CharacterOrigin;
}

/**
 * Creates the hero for an eligible Telegram member. Race-safe and idempotent: the unique
 * constraint on telegram_user_id means concurrent/retried calls produce exactly one hero.
 *
 * The hero and its INITIAL version (v1) are created TOGETHER, in the caller's transaction: there is no state in which a hero exists
 * without a version (the database refuses to commit one). Every creation path — the live webhook, the historical import, the guarded
 * backfill, the demo seed — goes through here.
 */
export async function createCharacterForUser(
  q: Queryable | Db,
  user: TelegramUserRow,
  opts: CreateCharacterOptions,
): Promise<{ characterId: string; created: boolean }> {
  // Handed a bare database (autocommit) instead of a transaction? Then the hero and its INITIAL v1 would commit statement by statement —
  // so open the one transaction here. Callers that already hold a transaction (the webhook, the import, the backfill) just join it.
  if ("transaction" in q) return q.transaction((tx) => createCharacterForUser(tx, user, opts));
  const existing = await q.query<{ id: string }>("select id from public.characters where telegram_user_id = $1", [user.telegram_user_id]);
  if (existing[0]) return { characterId: existing[0].id, created: false };

  const generated = generateCharacter({
    telegramUserId: user.telegram_user_id,
    displayName: user.display_name || user.username || "",
    behavior: user.behavior,
    activityScore: Number(user.activity_score),
    classes: opts.classes,
    settings: opts.settings,
    secret: opts.secret,
  });

  const rows = await q.query<{ id: string }>(
    `insert into public.characters (kind, telegram_user_id, class_id, name, origin, is_demo)
     values ('COMMUNITY', $1, $2, $3, $4, $5)
     on conflict (telegram_user_id) do nothing
     returning id`,
    [user.telegram_user_id, generated.classId, generated.name, opts.origin, opts.origin === "DEV_SEED"],
  );
  if (!rows[0]) {
    const winner = await q.query<{ id: string }>("select id from public.characters where telegram_user_id = $1", [user.telegram_user_id]);
    return { characterId: (winner[0] as { id: string }).id, created: false };
  }
  const characterId = rows[0].id;

  await q.query(
    `insert into public.character_stats (character_id, variation, telegram_bonus) values ($1, $2::jsonb, $3::jsonb)`,
    [characterId, json(generated.variation), json(generated.telegramBonus)],
  );
  await q.query(
    `insert into public.character_appearances (character_id, rarity, parts, seed, sprite) values ($1, $2, $3::jsonb, $4, $5::jsonb)`,
    [characterId, generated.rarity, json(generated.appearance), generated.appearanceSeed, json(generated.sprite)],
  );
  const classDef = opts.classes.find((c) => c.id === generated.classId);
  if (!classDef) throw new Error(`generated class ${generated.classId} is not an enabled class`);
  await createInitialHeroVersion(q, characterId, versionStateFromGenerated(generated, classDef, opts.settings.character, opts.settings.visuals.spriteSet), `system:${opts.origin.toLowerCase()}`);
  await refreshPower(q, characterId, opts.settings, opts.classes);
  await q.query("update public.telegram_users set eligible_at = coalesce(eligible_at, now()) where telegram_user_id = $1", [user.telegram_user_id]);
  return { characterId, created: true };
}

export interface Fighter {
  characterId: string;
  kind: "COMMUNITY" | "SPECIAL_CHARACTER";
  name: string;
  classId: string;
  title: string | null;
  claimed: boolean;
  isDemo: boolean;
  tactic: Tactic;
  /** PWR — the authoritative POWER of `generatedStats` (class + rarity budget). Wallet bonuses and gear never move it. */
  power: number;
  /** What the hero fights with right now: generated stats + wallet-derived bonuses + equipped gear. */
  stats: StatBlock;
  /** The hero's GENERATED stats — the exact block PWR is computed from and the hero card shows (no wallet bonus, no gear). */
  generatedStats: StatBlock;
  breakdown: EffectiveStats["breakdown"];
  /** `sprite` is the RESOLVED layer config (generated look + validated overrides − admin-disabled items). */
  appearance: { rarity: Rarity; parts: AppearanceParts; sprite: SpriteConfig };
}

interface FighterRow {
  id: string;
  kind: "COMMUNITY" | "SPECIAL_CHARACTER";
  name: string;
  name_override: string | null;
  class_id: string;
  tactic: Tactic;
  title: string | null;
  is_demo: boolean;
  power: number;
  variation: StatBlock;
  telegram_bonus: StatBlock;
  holdings_bonus: StatBlock;
  loyalty_bonus: StatBlock;
  trading_bonus: StatBlock;
  fixed_stats: Partial<StatBlock> | null;
  rarity: Rarity;
  parts: AppearanceParts;
  sprite: unknown;
  cosmetic_overrides: unknown;
  claimed: boolean;
}

interface GearRow {
  character_id: string;
  stat_mods: Partial<StatBlock>;
  class_restriction: string[] | null;
}

export const DEFAULT_TACTIC: Tactic = "BALANCED";

/**
 * PREVIEW ONLY: what a hero would look like with a different generated state (a reroll candidate, an older version) while keeping everything else
 * about it — wallet/gear parts, claim, tactic — exactly as it is. Nothing is written; the stored hero is not consulted for these fields.
 */
export interface FighterOverride {
  classId: string;
  variation: Partial<StatBlock>;
  telegramBonus: Partial<StatBlock>;
  rarity: Rarity;
  parts: AppearanceParts;
  /** The stored sprite config to resolve (null = derive from `parts`). */
  sprite: unknown;
}

/**
 * Builds the authoritative fighter view (effective stats incl. gear) for a set of heroes.
 * Unclaimed heroes ALWAYS fight with the class-default tactic and cannot have gear equipped.
 */
export async function loadFighters(q: Queryable, ids: readonly string[], ruleset: Ruleset, settings: GameSettings, overrides?: ReadonlyMap<string, FighterOverride>): Promise<Fighter[]> {
  if (ids.length === 0) return [];
  const rows = await q.query<FighterRow>(
    `select c.id, c.kind, c.name, c.name_override, c.class_id, c.tactic, c.title, c.is_demo, c.power,
            cs.variation, cs.telegram_bonus, cs.holdings_bonus, cs.loyalty_bonus, cs.trading_bonus, cs.fixed_stats,
            ca.rarity, ca.parts, ca.sprite, ca.cosmetic_overrides, (cl.character_id is not null) as claimed
       from public.characters c
       join public.character_stats cs on cs.character_id = c.id
       join public.character_appearances ca on ca.character_id = c.id
       left join public.character_claims cl on cl.character_id = c.id
      where c.id in (select (jsonb_array_elements_text($1::jsonb))::uuid)`,
    [json(ids)],
  );
  const gear = await q.query<GearRow>(
    `select i.character_id, t.stat_mods, t.class_restriction
       from public.inventory_items i join public.item_templates t on t.id = i.template_id
      where i.equipped and i.archived_at is null and i.character_id in (select (jsonb_array_elements_text($1::jsonb))::uuid)`,
    [json(ids)],
  );
  const gearBy = new Map<string, GearRow[]>();
  for (const g of gear) gearBy.set(g.character_id, [...(gearBy.get(g.character_id) ?? []), g]);

  const fighters = rows.map((stored): Fighter => {
    const o = overrides?.get(stored.id);
    const r: FighterRow = o ? { ...stored, class_id: o.classId, variation: o.variation as StatBlock, telegram_bonus: o.telegramBonus as StatBlock, rarity: o.rarity, parts: o.parts, sprite: o.sprite } : stored;
    const classDef = ruleset.classes[r.class_id];
    if (!classDef) throw new Error(`character ${r.id} has unknown class ${r.class_id}`);
    // Gear is gated by claim + class only. There is no level requirement: heroes have no permanent level.
    const usableGear = (gearBy.get(r.id) ?? []).filter(
      (g) => r.claimed && (!g.class_restriction || g.class_restriction.includes(r.class_id)),
    );
    const eff = computeEffectiveStats({
      classDef,
      variation: addStats(r.variation),
      telegram: addStats(r.telegram_bonus),
      holdings: addStats(r.holdings_bonus),
      loyalty: addStats(r.loyalty_bonus),
      trading: addStats(r.trading_bonus),
      gear: addStats(...usableGear.map((g) => g.stat_mods)),
      fixed: r.fixed_stats,
    });
    // The hero's generated stats (class + rarity budget + seed shape): PWR is computed from exactly this block, and the hero card shows it, so the
    // number and the stats beside it always agree. Wallet-derived bonuses and gear change how a hero FIGHTS (`stats`) but never PWR — and token
    // holdings never affect hero power.
    const generatedStats = computeEffectiveStats({ classDef, variation: addStats(r.variation), telegram: addStats(r.telegram_bonus), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats(), fixed: r.fixed_stats }).total;
    return {
      characterId: r.id,
      kind: r.kind,
      name: r.name_override ?? r.name,
      classId: r.class_id,
      title: r.title,
      claimed: r.claimed,
      isDemo: r.is_demo,
      tactic: r.claimed ? r.tactic : DEFAULT_TACTIC,
      power: computeHeroPower(generatedStats, r.class_id),
      stats: eff.total,
      generatedStats,
      breakdown: eff.breakdown,
      appearance: {
        rarity: r.rarity,
        parts: r.parts,
        sprite: resolveSpriteConfig({ stored: r.sprite, parts: r.parts, look: classDef.look, overrides: r.cosmetic_overrides as never, disabled: settings.visuals.disabledCosmetics, rarity: r.rarity }),
      },
    };
  });
  return fighters.sort((a, b) => (a.characterId < b.characterId ? -1 : 1));
}

export function fighterToUnit(f: Fighter): CombatUnitInput {
  return { characterId: f.characterId, name: f.name, classId: f.classId, tactic: f.tactic, stats: f.stats };
}

/** A ruleset carrying only what stat / POWER derivation needs (classes) — for display paths that never simulate a fight. */
export function classesRuleset(classes: readonly ClassDef[], settings: GameSettings): Ruleset {
  return { rulesVersion: "-", combat: settings.combat, classes: Object.fromEntries(classes.map((c) => [c.id, c])), skills: {} } as Ruleset;
}

/** Re-derives and caches POWER (display/leaderboards only; never read by combat). */
export async function refreshPower(q: Queryable, characterId: string, settings: GameSettings, classes: ClassDef[]): Promise<number> {
  const ruleset = classesRuleset(classes, settings);
  const [f] = await loadFighters(q, [characterId], ruleset, settings);
  if (!f) throw new Error(`character ${characterId} not found`);
  await q.query("update public.characters set power = $2 where id = $1", [characterId, f.power]);
  return f.power;
}

export const emptyComponents = () => ({ variation: zeroStats(), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() });
