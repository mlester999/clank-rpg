import { RARITIES, type Rarity } from "@/domain/character/appearance";
import { CARD_NAME_MAX, cardText, type HeroCardLook, type HeroCardModel } from "@/domain/hero/card";
import { isPublicHeroId } from "@/domain/hero/publicId";
import { seasonRankView } from "@/domain/progression/seasonRecord";
import type { ClassDef } from "@/domain/rules";
import type { GameSettings } from "@/domain/settings";
import { resolveSpriteConfig } from "@/domain/sprites/config";

import type { Queryable } from "../db/types";

import { classesRuleset, loadFighters } from "./characters";
import { activeSeasonRecord } from "./seasonRecords";
import { toHeroCardModel } from "./heroCardModel";

/**
 * The PUBLIC hero surface: the directory and the profile, keyed by the stable public id. Everything here is public-safe by construction —
 * every query SELECTS named columns (no `select *`, no Telegram id, no seed, no moderation state, no wallet) and the result types carry only
 * what a visitor may see.
 *
 * VISIBILITY follows the rules the Arena and the leaderboards already use: an ACTIVE hero whose Telegram member is not BANNED (demo heroes only
 * where demo heroes are allowed at all). A suspended / inactive / banned hero is simply NOT FOUND — the answer never says why.
 */

export const PUBLIC_DIRECTORY_PAGE_SIZE = 24;
export const PUBLIC_DIRECTORY_MAX_PAGE_SIZE = 48;

/** SQL predicate over aliases `c` (characters) and `tu` (telegram_users); `$n` is the `allowDemo` boolean. */
const visibleWhere = (allowDemoParam: string): string => `c.status = 'ACTIVE' and (tu.status is null or tu.status <> 'BANNED') and (not c.is_demo or ${allowDemoParam}::boolean)`;

export interface DirectoryCard {
  publicId: string;
  name: string;
  classId: string;
  className: string;
  rarity: Rarity;
  power: number;
  look: HeroCardLook;
}

export interface DirectoryFilters {
  classId?: string;
  rarity?: string;
  search?: string;
  sort?: "power" | "power_asc" | "name" | "newest";
  limit?: number;
  offset?: number;
}

export interface DirectoryPage {
  heroes: DirectoryCard[];
  total: number;
  limit: number;
  offset: number;
  classes: Array<{ id: string; name: string }>;
}

const escapeLike = (s: string) => s.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);

export const lookOf = (classDef: ClassDef | undefined, rarity: Rarity, parts: HeroCardLook["parts"], sprite: unknown, overrides: unknown, disabled: readonly string[]): HeroCardLook => {
  const look = classDef?.look ?? { weapon: "sword", headgear: "cap", body: "medium", colors: ["#5d6b7a", "#c4cddb", "#2c343d"] as [string, string, string] };
  return {
    rarity,
    parts,
    sprite: resolveSpriteConfig({ stored: sprite, parts, look: classDef?.look, overrides: overrides as never, disabled, rarity }),
    colors: [...look.colors] as [string, string, string],
    weapon: look.weapon,
    headgear: look.headgear,
    body: look.body,
  };
};

/** Active public heroes as cards: portrait, name, class, rarity, POWER. A card is a link to the profile — nothing else. */
export async function listPublicHeroes(q: Queryable, filters: DirectoryFilters, ctx: { allowDemo: boolean; classes: readonly ClassDef[]; settings: GameSettings }): Promise<DirectoryPage> {
  const limit = Math.max(1, Math.min(Math.trunc(filters.limit ?? PUBLIC_DIRECTORY_PAGE_SIZE), PUBLIC_DIRECTORY_MAX_PAGE_SIZE));
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
  const where = [visibleWhere("$1")];
  const params: unknown[] = [ctx.allowDemo];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);
  if (filters.classId && ctx.classes.some((c) => c.id === filters.classId)) where.push(`c.class_id = ${add(filters.classId)}`);
  if (filters.rarity && (RARITIES as readonly string[]).includes(filters.rarity)) where.push(`ca.rarity = ${add(filters.rarity)}`);
  const term = (filters.search ?? "").trim().slice(0, 40);
  if (term) where.push(`lower(coalesce(c.name_override, c.name)) like ${add(`%${escapeLike(term)}%`)} escape '\\'`);
  // PWR sorts by the current version's stored PWR, NOT the cached `characters.power`: that cache can be stale on a database that has not been rebalanced yet.
  // What a tile SHOWS is computed fresh below from the hero's generated stats, so it always equals the profile (and, once a hero is on the rarity power system, the sort key).
  const order = filters.sort === "name" ? "lower(coalesce(c.name_override, c.name)), c.public_id" : filters.sort === "newest" ? "c.created_at desc, c.public_id" : filters.sort === "power_asc" ? "v.power asc, c.created_at, c.public_id" : "v.power desc, c.created_at, c.public_id";
  const rows = await q.query<{ id: string; public_id: string; name: string; class_id: string; power: number; rarity: Rarity; parts: HeroCardLook["parts"]; sprite: unknown; overrides: unknown; total: number }>(
    `select c.id, c.public_id, coalesce(c.name_override, c.name) as name, c.class_id, v.power, ca.rarity, ca.parts, ca.sprite, ca.cosmetic_overrides as overrides, count(*) over ()::int as total
       from public.characters c
       join public.character_appearances ca on ca.character_id = c.id
       join public.hero_versions v on v.id = c.current_hero_version_id
       left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
      where ${where.join(" and ")}
      order by ${order} limit ${add(limit)} offset ${add(offset)}`,
    params,
  );
  const byId = new Map(ctx.classes.map((c) => [c.id, c]));
  // PWR — the power of the hero's GENERATED stats (never wallet bonuses or gear) — the very figure its profile and card show.
  const fighters = rows.length ? await loadFighters(q, rows.map((r) => r.id), classesRuleset(ctx.classes, ctx.settings), ctx.settings) : [];
  const powerOf = new Map(fighters.map((f) => [f.characterId, f.power]));
  return {
    heroes: rows.map((r) => ({
      publicId: r.public_id,
      name: cardText(r.name, CARD_NAME_MAX),
      classId: r.class_id,
      className: byId.get(r.class_id)?.name ?? r.class_id,
      rarity: r.rarity,
      power: powerOf.get(r.id) ?? Number(r.power),
      look: lookOf(byId.get(r.class_id), r.rarity, r.parts, r.sprite, r.overrides, ctx.settings.visuals.disabledCosmetics),
    })),
    total: Number(rows[0]?.total ?? 0),
    limit,
    offset,
    classes: ctx.classes.map((c) => ({ id: c.id, name: c.name })),
  };
}

export interface PublicHeroProfile {
  card: HeroCardModel;
  /** The hero's record in the ACTIVE season (zero at the start of every season; the hero itself never resets). */
  record: { battles: number; wins: number; top2: number; eliminations: number };
  /** Arena Picks (lifetime, valid settled picks) of the member behind this hero — counts only. */
  picks: { total: number; correct: number } | null;
  season: { name: string; label: string; kind: "DEVELOPMENT" | "COMPETITIVE"; rank: string; ranked: boolean; points: number } | null;
  /** The last few settled battles: placement and eliminations. No battle ids, nothing replayable. */
  recentBattles: Array<{ placement: number; eliminations: number; at: number | null }>;
}

interface ProfileRow {
  id: string;
  public_id: string;
  name: string;
  telegram_user_id: number | null;
}

/** Resolves a public id to a visible hero, or null (unknown id, malformed id, or a hero that is not public — indistinguishable on purpose). */
async function visibleHero(q: Queryable, publicId: string, allowDemo: boolean): Promise<ProfileRow | null> {
  if (!isPublicHeroId(publicId)) return null;
  const [row] = await q.query<ProfileRow>(
    `select c.id, c.public_id, coalesce(c.name_override, c.name) as name, c.telegram_user_id
       from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
      where c.public_id = $1 and ${visibleWhere("$2")}`,
    [publicId, allowDemo],
  );
  return row ?? null;
}

/** The hero's place in the ACTIVE season: "Unranked" until it has fought a battle there (the tier is earned each season, the hero is not reset). */
async function seasonOf(q: Queryable, characterId: string, settings: GameSettings): Promise<{ season: NonNullable<PublicHeroProfile["season"]>; record: PublicHeroProfile["record"] } | null> {
  const rec = await activeSeasonRecord(q, characterId);
  if (!rec.season || !settings.progression.seasonRanks.length) return null;
  const rank = seasonRankView(rec.points, rec.battles, settings.progression.seasonRanks);
  return {
    season: { name: rec.season.name, label: rec.season.label, kind: rec.season.kind, rank: rank.name, ranked: rec.battles > 0, points: rec.points },
    record: { battles: rec.battles, wins: rec.wins, top2: rec.top2, eliminations: rec.eliminations },
  };
}

/** The canonical card model of a PUBLIC hero (its effective stats as it fights now), or null. Used by the profile, the image and the social metadata. */
export async function getPublicHeroCard(q: Queryable, publicId: string, ctx: { allowDemo: boolean; classes: readonly ClassDef[]; settings: GameSettings }): Promise<HeroCardModel | null> {
  const hero = await visibleHero(q, publicId, ctx.allowDemo);
  if (!hero) return null;
  return cardOf(q, hero, ctx);
}

async function cardOf(q: Queryable, hero: ProfileRow, ctx: { classes: readonly ClassDef[]; settings: GameSettings }): Promise<HeroCardModel | null> {
  const [fighter] = await loadFighters(q, [hero.id], classesRuleset(ctx.classes, ctx.settings), ctx.settings);
  const classDef = fighter ? ctx.classes.find((c) => c.id === fighter.classId) : undefined;
  if (!fighter || !classDef) return null;
  const season = await seasonOf(q, hero.id, ctx.settings);
  const card = toHeroCardModel({ publicId: hero.public_id, name: hero.name, fighter, classDef, seasonRank: season?.season.rank ?? null });
  return { ...card, look: { ...card.look, spriteSet: ctx.settings.visuals.spriteSet } };
}

export async function getPublicHero(q: Queryable, publicId: string, ctx: { allowDemo: boolean; classes: readonly ClassDef[]; settings: GameSettings }): Promise<PublicHeroProfile | null> {
  const hero = await visibleHero(q, publicId, ctx.allowDemo);
  if (!hero) return null;
  const card = await cardOf(q, hero, ctx);
  if (!card) return null;
  const [seasonInfo, recent, picks] = await Promise.all([
    seasonOf(q, hero.id, ctx.settings),
    q.query<{ placement: number; eliminations: number; settled_at: Date | null }>(
      // The fights of the ACTIVE season only: a new season's profile does not list the previous run's battles.
      `select p.placement, p.eliminations, b.settled_at from public.arena_participants p join public.arena_battles b on b.id = p.battle_id
        where p.character_id = $1 and b.status = 'SETTLED' and b.season_id = (select id from public.seasons where status = 'ACTIVE' limit 1) order by b.sequence desc limit 8`,
      [hero.id],
    ),
    hero.telegram_user_id === null
      ? Promise.resolve(null)
      : q.query<{ total: number; correct: number }>(
          // Picks of an ARCHIVED development run never count (public.season_counts): they were test data.
          "select count(*)::int as total, (count(*) filter (where correct))::int as correct from public.arena_pick_scores where telegram_user_id = $1 and public.season_counts(season_id)",
          [hero.telegram_user_id],
        ).then((r) => (r[0] ? { total: Number(r[0].total), correct: Number(r[0].correct) } : null), (e: unknown) => {
          if (/does not exist/i.test(e instanceof Error ? e.message : String(e))) return null; // before the Arena Picks leaderboard migration
          throw e;
        }),
  ]);
  return {
    card,
    record: seasonInfo?.record ?? { battles: 0, wins: 0, top2: 0, eliminations: 0 },
    picks,
    season: seasonInfo?.season ?? null,
    recentBattles: recent.map((r) => ({ placement: Number(r.placement), eliminations: Number(r.eliminations), at: r.settled_at ? new Date(r.settled_at).getTime() : null })),
  };
}
