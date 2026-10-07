import { LEGACY_HERO_GENERATOR_VERSION } from "@/domain/hero/heroVersion";
import { winRatePercent } from "@/domain/progression/seasonRecord";
import { activeSeasonRecord } from "./seasonRecords";
import { avatarUrlOrNull } from "@/domain/media/avatarUrl";

import type { Queryable } from "../db/types";

import { getHeroPhotoAdminView, type HeroPhotoAdminView } from "./heroPhotos";

/**
 * Read side of hero management (admin only). Three identities are kept apart on purpose:
 *   telegramUserId  — immutable identity
 *   telegramDisplayName / username — external Telegram information (may change; never used for ownership)
 *   rpgName         — what Clank RPG shows: name_override ?? generated name
 */

export interface HeroSearchFilters {
  search?: string;
  claimed?: "claimed" | "unclaimed";
  classId?: string;
  rarity?: string;
  kind?: "COMMUNITY" | "SPECIAL_CHARACTER";
  status?: "ACTIVE" | "INACTIVE" | "SUSPENDED";
  renamed?: "renamed" | "original";
  sort?: "newest" | "name" | "power" | "power_asc";
  limit?: number;
  offset?: number;
}

export interface HeroListRow {
  id: string;
  rpgName: string;
  generatedName: string;
  renamed: boolean;
  kind: "COMMUNITY" | "SPECIAL_CHARACTER";
  classId: string;
  rarity: string | null;
  /** PWR (the cached authoritative figure: refreshed whenever a hero version is applied). */
  power: number;
  /** True while the hero's current version was made by the first generator (it is not on the rarity power system yet). */
  needsRebalance: boolean;
  status: string;
  isDemo: boolean;
  claimed: boolean;
  telegramUserId: number | null;
  telegramUsername: string | null;
  telegramDisplayName: string | null;
  qualifyingMessages: number | null;
  /** Profile photo currently on screen (null → generated class portrait). */
  avatarUrl: string | null;
  createdAt: Date;
}

const escapeLike = (s: string) => s.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);

export async function searchHeroes(q: Queryable, f: HeroSearchFilters = {}): Promise<{ heroes: HeroListRow[]; total: number; limit: number; offset: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);

  const term = (f.search ?? "").trim();
  if (term) {
    const bare = term.replace(/^@/, "");
    const like = add(`%${escapeLike(bare)}%`);
    const ors = [
      `lower(coalesce(c.name_override, c.name)) like ${like} escape '\\'`,
      `lower(c.name) like ${like} escape '\\'`,
      `lower(coalesce(tu.display_name, '')) like ${like} escape '\\'`,
      `lower(coalesce(tu.username, '')) like ${like} escape '\\'`,
    ];
    if (/^-?\d{1,19}$/.test(bare)) ors.push(`c.telegram_user_id::text = ${add(bare)}`);
    if (/^[0-9a-f-]{6,36}$/i.test(bare)) ors.push(`c.id::text like ${add(`${bare.toLowerCase()}%`)}`);
    where.push(`(${ors.join(" or ")})`);
  }
  if (f.claimed === "claimed") where.push("cl.character_id is not null");
  if (f.claimed === "unclaimed") where.push("cl.character_id is null");
  if (f.classId) where.push(`c.class_id = ${add(f.classId)}`);
  if (f.rarity) where.push(`ca.rarity = ${add(f.rarity)}`);
  if (f.kind) where.push(`c.kind = ${add(f.kind)}`);
  if (f.status) where.push(`c.status = ${add(f.status)}`);
  if (f.renamed === "renamed") where.push("c.name_override is not null");
  if (f.renamed === "original") where.push("c.name_override is null");

  const limit = Math.max(1, Math.min(f.limit ?? 50, 100));
  const offset = Math.max(0, f.offset ?? 0);
  const order = f.sort === "name" ? "lower(coalesce(c.name_override, c.name)), c.id" : f.sort === "power" ? "c.power desc, c.id" : f.sort === "power_asc" ? "c.power asc, c.id" : "c.created_at desc, c.id";
  const rows = await q.query<{
    id: string; name: string; name_override: string | null; kind: HeroListRow["kind"]; class_id: string; rarity: string | null; power: number; status: string; generator_version: string | null;
    is_demo: boolean; claimed: boolean; telegram_user_id: number | null; username: string | null; tg_name: string | null; qualifying: number | null; created_at: Date; total: number; avatar_version: string | null;
  }>(
    `select c.id, c.name, c.name_override, c.kind, c.class_id, ca.rarity, c.power, c.status, c.is_demo, (cl.character_id is not null) as claimed,
            c.telegram_user_id, tu.username, tu.display_name as tg_name, tu.qualifying_message_count as qualifying, c.created_at, count(*) over ()::int as total, hp.version as avatar_version,
            v.generator_version
       from public.characters c
       left join public.hero_versions v on v.id = c.current_hero_version_id
       left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
       left join public.character_claims cl on cl.character_id = c.id
       left join public.character_appearances ca on ca.character_id = c.id
       left join public.hero_profile_photos hp on hp.character_id = c.id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by ${order} limit ${add(limit)} offset ${add(offset)}`,
    params,
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    limit,
    offset,
    heroes: rows.map((r) => ({
      id: r.id,
      rpgName: r.name_override ?? r.name,
      generatedName: r.name,
      renamed: r.name_override !== null,
      kind: r.kind,
      classId: r.class_id,
      rarity: r.rarity,
      power: Number(r.power),
      needsRebalance: r.kind === "COMMUNITY" && r.generator_version === LEGACY_HERO_GENERATOR_VERSION,
      status: r.status,
      isDemo: r.is_demo,
      claimed: r.claimed,
      telegramUserId: r.telegram_user_id === null ? null : Number(r.telegram_user_id),
      telegramUsername: r.username,
      telegramDisplayName: r.tg_name,
      qualifyingMessages: r.qualifying === null ? null : Number(r.qualifying),
      avatarUrl: avatarUrlOrNull(r.id, r.avatar_version),
      createdAt: r.created_at,
    })),
  };
}

export interface HeroDetail {
  id: string;
  kind: "COMMUNITY" | "SPECIAL_CHARACTER";
  origin: string;
  isDemo: boolean;
  status: string;
  // the three identities, kept apart
  rpgName: string;
  generatedName: string;
  nameOverride: string | null;
  nameChangedAt: Date | null;
  nameChangedBy: string | null;
  telegram: {
    userId: number;
    displayName: string;
    username: string | null;
    status: string;
    flagReason: string | null;
  } | null;
  claimed: boolean;
  claimedAt: Date | null;
  wallet: string | null;
  // the hero
  classId: string;
  power: number;
  title: string | null;
  rarity: string | null;
  appearanceSeed: string | null;
  sprite: unknown;
  cosmeticOverrides: unknown;
  /** The hero's CURRENT-SEASON performance (a hero's identity above is separate and never resets). Zero at the start of every season. */
  season: { label: string; kind: "DEVELOPMENT" | "COMPETITIVE"; matches: number; wins: number; top2: number; winRate: number | null; points: number } | null;
  /** All-time career counters (every season and development run) — internal, never shown publicly. */
  career: { battles: number; wins: number; top2: number };
  /** Whether this hero can enter a NEW Arena roster right now (ACTIVE, member not banned): a suspended hero still exists, with everything intact. */
  arenaEligible: boolean;
  // Telegram activity (communities only)
  activity: {
    qualifyingMessages: number;
    totalMessages: number;
    activeDays: number;
    activityScore: number;
    repliesSent: number;
    repliesReceived: number;
    reactionsReceived: number;
    firstMessageAt: Date | null;
    lastMessageAt: Date | null;
  } | null;
  createdAt: Date;
  lastActivityAt: Date | null;
  adminNote: string | null;
  /** Profile photo: which source is active, plus the admin override and Telegram cache details. */
  photo: HeroPhotoAdminView;
  renameHistory: Array<{ at: Date; oldName: string; newName: string; actor: string }>;
}

export async function getHeroDetail(q: Queryable, id: string): Promise<HeroDetail | null> {
  const [r] = await q.query<Record<string, never>>(
    `select c.id, c.kind, c.origin, c.is_demo, c.status, c.name, c.name_override, c.name_changed_at, c.name_changed_by, c.class_id, c.power, c.title,
            c.admin_note, c.created_at, c.last_arena_at, c.arena_battles, c.arena_wins, c.arena_top2,
            ca.rarity, ca.seed as appearance_seed, ca.sprite, ca.cosmetic_overrides,
            tu.telegram_user_id, tu.username, tu.display_name as tg_name, tu.status as tg_status, tu.flag_reason, tu.qualifying_message_count, tu.total_message_count, tu.active_days,
            tu.activity_score, tu.reply_count, tu.replies_received, tu.reactions_received, tu.first_message_at, tu.last_message_at,
            cl.claimed_at, (select w.address from public.wallet_links w where w.character_id = c.id and w.unlinked_at is null limit 1) as wallet
       from public.characters c
       left join public.character_appearances ca on ca.character_id = c.id
       left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
       left join public.character_claims cl on cl.character_id = c.id
      where c.id = $1`,
    [id],
  );
  if (!r) return null;
  const x = r as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- one wide row, mapped field by field below
  const history = await q.query<{ created_at: Date; old_name: string; new_name: string; actor: string }>(
    `select created_at, detail->>'oldName' as old_name, detail->>'newName' as new_name, actor from public.admin_audit_log
      where action = 'hero.rename' and entity_type = 'character' and entity_id = $1 order by id desc limit 10`,
    [id],
  );
  const seasonRec = await activeSeasonRecord(q, id);
  const lastMessageAt = x.last_message_at ? new Date(x.last_message_at) : null;
  const lastArenaAt = x.last_arena_at ? new Date(x.last_arena_at) : null;
  const last = [lastMessageAt, lastArenaAt].filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return {
    id: x.id,
    kind: x.kind,
    origin: x.origin,
    isDemo: x.is_demo,
    status: x.status,
    rpgName: x.name_override ?? x.name,
    generatedName: x.name,
    nameOverride: x.name_override,
    nameChangedAt: x.name_changed_at,
    nameChangedBy: x.name_changed_by,
    telegram: x.telegram_user_id === null ? null : { userId: Number(x.telegram_user_id), displayName: x.tg_name, username: x.username, status: x.tg_status, flagReason: x.flag_reason },
    claimed: x.claimed_at !== null,
    claimedAt: x.claimed_at,
    wallet: x.wallet,
    classId: x.class_id,
    power: Number(x.power),
    title: x.title,
    rarity: x.rarity,
    appearanceSeed: x.appearance_seed,
    sprite: x.sprite,
    cosmeticOverrides: x.cosmetic_overrides,
    season: seasonRec.season ? { label: seasonRec.season.label, kind: seasonRec.season.kind, matches: seasonRec.battles, wins: seasonRec.wins, top2: seasonRec.top2, winRate: winRatePercent(seasonRec.battles, seasonRec.wins), points: seasonRec.points } : null,
    career: { battles: Number(x.arena_battles), wins: Number(x.arena_wins), top2: Number(x.arena_top2) },
    arenaEligible: x.status === "ACTIVE" && x.tg_status !== "BANNED",
    activity:
      x.telegram_user_id === null
        ? null
        : {
            qualifyingMessages: Number(x.qualifying_message_count),
            totalMessages: Number(x.total_message_count),
            activeDays: Number(x.active_days),
            activityScore: Number(x.activity_score),
            repliesSent: Number(x.reply_count),
            repliesReceived: Number(x.replies_received),
            reactionsReceived: Number(x.reactions_received),
            firstMessageAt: x.first_message_at,
            lastMessageAt: x.last_message_at,
          },
    createdAt: x.created_at,
    lastActivityAt: last,
    adminNote: x.admin_note,
    photo: await getHeroPhotoAdminView(q, id),
    renameHistory: history.map((h) => ({ at: h.created_at, oldName: h.old_name, newName: h.new_name, actor: h.actor })),
  };
}
