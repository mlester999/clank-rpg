import { picksWindow, type PicksLockReason, type PicksWindow } from "@/domain/arena/picksWindow";
import { avatarUrlOrNull } from "@/domain/media/avatarUrl";
import { startPositionFor } from "@/domain/combat/engine";
import { FRAME_STRIDE, type EventTuple } from "@/domain/combat/types";
import { DEFAULT_ACHIEVEMENTS } from "@/domain/content";
import { isRetiredAchievement } from "@/domain/content/achievements";
import { publicSeasonLabel, type ArenaRuntimeStatus, type GamePhase, type SeasonKind } from "@/domain/lifecycle";
import { seasonRankView, type SeasonRankView } from "@/domain/progression/seasonRecord";
import { PICKS_REWARD_OFF, type PicksRewardDto } from "@/domain/rewards/picksDto";
import type { ClassDef, Ruleset } from "@/domain/rules";
import type { GameSettings } from "@/domain/settings";
import type { Queryable } from "../db/types";


import { replayBattle, type BattleSnapshot } from "./arena";
import { countEligibleHeroes } from "./arenaEligibility";
import { activeSeasonRecord } from "./seasonRecords";
import { toWindowBattle, toWindowPredecessor } from "./picks";

// ---------------------------------------------------------------------------------------
// Arena state
// ---------------------------------------------------------------------------------------

/**
 * How a hero looks, as sent to browsers. `sprite` is the layer config (resolved + frozen for
 * arena fighters; the raw stored value elsewhere — the client resolves it with the same pure
 * domain code). `overrides` are player-chosen cosmetics. Both are cosmetic only.
 */
export interface AppearanceDto {
  rarity: string;
  parts: unknown;
  sprite?: unknown;
  overrides?: unknown;
}

export interface FighterDto {
  slot: number | null;
  characterId: string;
  /** Stable public hero id — what the public profile URL (/heroes/<publicId>) uses. */
  publicId: string;
  name: string;
  classId: string;
  title: string | null;
  isDemo: boolean;
  claimed: boolean;
  /** Summary POWER frozen with the pre-battle snapshot (display only — never a combat input). */
  power: number | null;
  appearance: AppearanceDto;
  /** Profile photo (admin override → Telegram photo), or null → the UI draws the generated class portrait. */
  avatarUrl: string | null;
  maxHp: number | null;
  startPosition: [number, number] | null;
}

export interface ResultRowDto {
  placement: number;
  characterId: string;
  slot: number | null;
  eliminations: number;
  damageDealt: number;
  survivedMs: number | null;
  /** HP left when the battle ended (0 = eliminated). Null on battles settled before this was reported. */
  finalHp: number | null;
  maxHp: number | null;
  goldAwarded: number;
}

export interface BattleDto {
  id: string;
  /** Internal, global, never reset — ordering only. The number people see is `number`. */
  sequence: number;
  /** The PUBLIC battle number: scoped to the season (Battle #1 of Season 1 …). */
  number: number;
  status: "SCHEDULED" | "SIMULATED" | "SETTLED";
  startsAt: number;
  combatStartsAt: number | null;
  combatEndsAt: number | null;
  resultsStartAt: number | null;
  slotEndsAt: number | null;
  durationMs: number | null;
  endedBy: "LAST_STANDING" | "TIME_LIMIT" | null;
  tickMs: number;
  fighters: FighterDto[];
  /** Present only once combat has finished on the server clock. */
  results: ResultRowDto[] | null;
  eventsHash: string | null;
  rulesVersion: string | null;
  hasReplay: boolean;
}

/** One of the eight heroes of the UPCOMING battle: who they are and how strong — nothing about how the fight will go. */
export interface UpcomingFighterDto {
  characterId: string;
  publicId: string;
  name: string;
  classId: string;
  title: string | null;
  isDemo: boolean;
  claimed: boolean;
  /** Summary POWER frozen with the battle's snapshot (display only). */
  power: number | null;
  appearance: AppearanceDto;
  avatarUrl: string | null;
}

/**
 * The state of the pick window of the upcoming battle, decided by the SERVER (see domain/arena/picksWindow.ts). The browser only
 * displays it: it may close the panel EARLIER than `locksAt` on its synced clock but never opens it later than the server says.
 */
export interface UpcomingPicksDto {
  /** OPEN = picks are accepted right now; LOCKED = they are not (the battle on stage is decided, or this battle took the stage). */
  status: "OPEN" | "LOCKED";
  /** PREDECESSOR = the battle on stage closes it; FALLBACK = nothing is on stage ahead of it, so its own start does. */
  mode: "PREDECESSOR" | "FALLBACK";
  /** Why a LOCKED window is closed. */
  lockReason: PicksLockReason | null;
  /** Server-clock instant an OPEN window closes — a countdown hint, never an authority. */
  locksAt: number | null;
  /** The persisted close moment once the arena has stamped it. */
  lockedAt: number | null;
}

/**
 * The battle that will fight NEXT — and the target of every Arena Pick. Its roster is committed (the eight listed are exactly the
 * eight who will fight, never re-drawn); its OUTCOME is not: no slot, hit points, ranking, winner or replay is ever published
 * before the fight. It is viewer-independent (the payload is shared); "my pick" is served by /api/arena/picks.
 */
export interface UpcomingBattleDto {
  id: string;
  /** The public (season) battle number it will have on stage. */
  number: number;
  startsAt: number;
  fighters: UpcomingFighterDto[];
  picks: UpcomingPicksDto;
}

export interface ClassVisual {
  name: string;
  role: string;
  tagline: string;
  colors: [string, string, string];
  weapon: string;
  headgear: string;
  body: string;
  attackStyle: string;
}

export function classVisuals(classes: readonly ClassDef[]): Record<string, ClassVisual> {
  return Object.fromEntries(
    classes.map((c) => [c.id, { name: c.name, role: c.role, tagline: c.tagline, colors: c.look.colors, weapon: c.look.weapon, headgear: c.look.headgear, body: c.look.body, attackStyle: c.attack.style }]),
  );
}

/** The leaderboard prize pools on offer (display strings only). The type lives in the rewards domain; it is re-exported here for the arena DTOs. */
export type { PicksRewardDto };

export interface ArenaStateDto {
  classes: Record<string, ClassVisual>;
  timing: { introMs: number; countdownMs: number; victoryHoldMs: number; resultsMs: number; maxCombatMs: number; tickMs: number };
  serverTime: number;
  /**
   * When the server STARTED handling this request (set by the state endpoint). With `serverTime` (when it finished) a
   * client can separate network time from server processing time and keep its clock estimate honest even when the
   * server was slow (NTP-style). Absent from server-rendered state.
   */
  serverReceivedAt?: number;
  /**
   * What the public Arena is doing — derived from the PERSISTED runtime status (never from a process's memory):
   * NOT_STARTED (launched / reset, nobody pressed START yet) · PREPARING (Battle #1 is being made ready) · LIVE (battles are made and fought) ·
   * GATHERING (running, but fewer eligible heroes than a battle needs) · PAUSED · NO_SEASON (between seasons).
   * A failure to reach the server at all is NOT a status — that is the browser's own "reconnecting" state.
   */
  status: "LIVE" | "GATHERING" | "PAUSED" | "NO_SEASON" | "NOT_STARTED" | "PREPARING";
  /** The game phase: DEVELOPMENT (test battles, not official records) or LIVE (official seasons). */
  phase: GamePhase;
  /** A pause was requested: the battles already committed are finishing, no new one will be made. */
  pausing: boolean;
  eligibleHeroes: number;
  groupSize: number;
  /** Qualifying messages a member of the official Telegram community needs to become eligible for a hero (a setting). */
  heroThreshold: number;
  season: { id: string; kind: SeasonKind; number: number | null; name: string; label: string } | null;
  /** The battle on stage right now (its fight, its results). It is NEVER the target of a pick. */
  current: BattleDto | null;
  /** The battle that fights next, with its final roster and the server's verdict on its pick window — the Arena Picks target. Null while it is not prepared yet. */
  upcoming: UpcomingBattleDto | null;
  /** Timing only: the next battle's id and start (also present while its roster is still being prepared). */
  next: { id: string; number: number; startsAt: number } | null;
  recent: Array<{ id: string; sequence: number; number: number; endedAt: number; winner: FighterDto | null; runnerUp: FighterDto | null }>;
  /**
   * ARENA PICKS (free and unlimited; correct scored picks earn leaderboard Points, the Daily/Weekly boards pay $CLANKRPG). Shared by every viewer, so it carries NOTHING about
   * anyone's pick — and deliberately no per-fighter pick counts: showing the crowd before picks lock would let everyone
   * copy it. Per-member state (my pick, and the crowd once locked) is served by /api/arena/picks. The window itself
   * (`upcoming.picks`) is the SERVER's verdict.
   */
  picks: { enabled: boolean; rewardGold: number; reward: PicksRewardDto };
  visuals: { spriteSet: string; disabledCosmetics: string[] };
  demo: boolean;
}

interface BattleRowFull {
  id: string; sequence: number; season_sequence: number; status: "SCHEDULED" | "SIMULATED" | "SETTLED"; starts_at: Date; combat_starts_at: Date | null; combat_ends_at: Date | null;
  slot_ends_at: Date | null; duration_ms: number | null; ended_by: "LAST_STANDING" | "TIME_LIMIT" | null; snapshot: BattleSnapshot | null; events_hash: string | null;
  rules_version: string | null; winner_id: string | null; runner_up_id: string | null;
  picks_locked_at: Date | null; picks_lock_reason: PicksLockReason | null;
}

interface PartRow {
  character_id: string; public_id: string; slot: number | null; placement: number | null; eliminations: number; damage_dealt: number; survived_ms: number | null;
  max_hp: number | null; final_hp: number | null; gold_awarded: number; name: string; class_id: string; title: string | null; is_demo: boolean;
  claimed: boolean; rarity: string; parts: unknown; sprite: unknown; cosmetic_overrides: unknown; avatar_version: string | null;
}

const BATTLE_COLS = "id, sequence, season_sequence, status, starts_at, combat_starts_at, combat_ends_at, slot_ends_at, duration_ms, ended_by, snapshot, events_hash, rules_version, winner_id, runner_up_id, picks_locked_at, picks_lock_reason";
const t = (d: Date | null): number | null => (d ? new Date(d).getTime() : null);

async function loadFighters(q: Queryable, battle: BattleRowFull, startRadius: number): Promise<{ fighters: FighterDto[]; parts: PartRow[] }> {
  const parts = await q.query<PartRow>(
    `select p.character_id, c.public_id, p.slot, p.placement, p.eliminations, p.damage_dealt, p.survived_ms, p.max_hp, p.final_hp, p.gold_awarded,
            coalesce(c.name_override, c.name) as name, c.class_id, c.title, c.is_demo, (cl.character_id is not null) as claimed, ca.rarity, ca.parts, ca.sprite, ca.cosmetic_overrides,
            hp.version as avatar_version
       from public.arena_participants p join public.characters c on c.id = p.character_id
       join public.character_appearances ca on ca.character_id = c.id left join public.character_claims cl on cl.character_id = c.id
       left join public.hero_profile_photos hp on hp.character_id = c.id
      where p.battle_id = $1 order by p.slot nulls last, p.character_id`,
    [battle.id],
  );
  const snap = new Map((battle.snapshot?.display ?? []).map((d) => [d.characterId, d]));
  const fighters = parts.map((p): FighterDto => {
    const frozen = snap.get(p.character_id); // the pre-battle snapshot wins over live data
    return {
      slot: p.slot,
      characterId: p.character_id,
      publicId: p.public_id,
      // The RPG display name is presentation only (never a combat input), so the CURRENT name wins over the frozen one:
      // a rename shows up on stage immediately while the snapshot itself stays immutable.
      name: p.name,
      classId: frozen?.classId ?? p.class_id,
      title: frozen ? frozen.title : p.title,
      isDemo: frozen?.isDemo ?? p.is_demo,
      claimed: frozen?.claimed ?? p.claimed,
      power: frozen?.power ?? null,
      // Battles simulated before layered sprites carry no frozen sprite config: fall back to the stored one (or let the client derive it).
      appearance: frozen
        ? { rarity: frozen.appearance.rarity, parts: frozen.appearance.parts, sprite: (frozen.appearance as { sprite?: unknown }).sprite ?? p.sprite ?? undefined }
        : { rarity: p.rarity, parts: p.parts, sprite: p.sprite ?? undefined, overrides: p.cosmetic_overrides },
      // Like the name, the photo is presentation only: the CURRENT one shows, the battle snapshot never holds it.
      avatarUrl: avatarUrlOrNull(p.character_id, p.avatar_version),
      maxHp: p.max_hp,
      // The battle's OWN size (what the engine placed it with — tick 0 of its replay), never today's `arena.groupSize`: an admin may change the
      // group size while a battle is on stage, and the 3 · 2 · 1 must show the fighters exactly where the fight will start.
      startPosition: p.slot === null ? null : startPositionFor(p.slot, parts.length, startRadius),
    };
  });
  return { fighters, parts };
}

/** The public face of an upcoming fighter: identity and POWER only (no slot, hit points or start position — those belong to the fight). */
function toUpcomingFighter(f: FighterDto): UpcomingFighterDto {
  return { characterId: f.characterId, publicId: f.publicId, name: f.name, classId: f.classId, title: f.title, isDemo: f.isDemo, claimed: f.claimed, power: f.power, appearance: f.appearance, avatarUrl: f.avatarUrl };
}

/**
 * The public status, from the PERSISTED runtime status — never from a process's memory or a cached advance result (those can be a few seconds stale or
 * belong to another process). NOT_STARTED / PREPARING / PAUSED are exactly what the Admin set; while the Arena runs, "LIVE" means battles exist and
 * "GATHERING" means there are not enough eligible heroes to make one.
 */
export function publicStatus(runtime: ArenaRuntimeStatus, ctx: { hasSeason: boolean; hasBattle: boolean; eligible: number; groupSize: number }): ArenaStateDto["status"] {
  if (runtime === "NOT_STARTED") return "NOT_STARTED";
  if (runtime === "PAUSED") return "PAUSED";
  if (!ctx.hasSeason) return "NO_SEASON";
  if (runtime === "PREPARING") return ctx.hasBattle ? "LIVE" : "PREPARING";
  return ctx.hasBattle || ctx.eligible >= ctx.groupSize ? "LIVE" : "GATHERING";
}

export async function getArenaState(q: Queryable, nowMs: number, settings: GameSettings, opts: { allowDemo: boolean; classes: readonly ClassDef[]; picksEnabled?: boolean; reward?: PicksRewardDto }): Promise<ArenaStateDto> {
  const now = new Date(nowMs).toISOString();
  // The independent reads run TOGETHER: this snapshot is built on the arena's critical path (the instant a battle starts,
  // every viewer needs it), and on a database a round trip away (~100+ ms) a dozen sequential queries cost over a second.
  type Frozen = { classId?: string; power?: number; appearance?: { rarity?: string; parts?: unknown; sprite?: unknown } } | null;
  const recentsP = q.query<{ id: string; sequence: number; season_sequence: number; slot_ends_at: Date; wid: string; wpub: string; wname: string; wclass: string; wrarity: string; wparts: unknown; wsprite: unknown; wover: unknown; wsnap: Frozen; rid: string | null; rpub: string | null; rname: string | null; rclass: string | null; rrarity: string | null; rparts: unknown; rsprite: unknown; rover: unknown; rsnap: Frozen; wavatar: string | null; ravatar: string | null }>(
    // Class, look and POWER come from the pre-battle SNAPSHOT — what they were when they fought. A hero rerolled or rolled back afterwards
    // must not rewrite how an old win is shown; the live columns are only the fallback for battles that carry no frozen display.
    `select b.id, b.sequence, b.season_sequence, b.slot_ends_at,
            w.id as wid, w.public_id as wpub, coalesce(w.name_override, w.name) as wname,
            w.class_id as wclass, wa.rarity as wrarity, wa.parts as wparts, wa.sprite as wsprite, wa.cosmetic_overrides as wover,
            (select d from jsonb_array_elements(b.snapshot->'display') d where d->>'characterId' = w.id::text limit 1) as wsnap,
            r.id as rid, r.public_id as rpub, coalesce(r.name_override, r.name) as rname,
            r.class_id as rclass, ra.rarity as rrarity, ra.parts as rparts, ra.sprite as rsprite, ra.cosmetic_overrides as rover,
            (select d from jsonb_array_elements(b.snapshot->'display') d where d->>'characterId' = r.id::text limit 1) as rsnap,
            whp.version as wavatar, rhp.version as ravatar
       from public.arena_battles b
       left join public.characters w on w.id = b.winner_id left join public.character_appearances wa on wa.character_id = w.id
       left join public.characters r on r.id = b.runner_up_id left join public.character_appearances ra on ra.character_id = r.id
       left join public.hero_profile_photos whp on whp.character_id = w.id left join public.hero_profile_photos rhp on rhp.character_id = r.id
      where b.status = 'SETTLED' and b.season_id = (select id from public.seasons where status = 'ACTIVE' limit 1) order by b.sequence desc limit 6`,
  );
  recentsP.catch(() => undefined); // awaited below; never an unhandled rejection if an earlier read throws first
  // Everything public belongs to the ACTIVE season: after a launch / reset the previous run's battles are archived and none of them is ever "current".
  const ACTIVE = "season_id = (select id from public.seasons where status = 'ACTIVE' limit 1)";
  const [[season], eligibleHeroes, [runtime], [game], [curRow], [nxtRow]] = await Promise.all([
    q.query<{ id: string; kind: SeasonKind; number: number | null; name: string }>("select id, kind, number, name from public.seasons where status = 'ACTIVE' limit 1"),
    countEligibleHeroes(q, opts.allowDemo),
    q.query<{ status: ArenaRuntimeStatus }>("select status from public.arena_state where id = 1"),
    q.query<{ phase: GamePhase }>("select phase from public.game_state where id = 1"),
    q.query<BattleRowFull>(
      `select ${BATTLE_COLS} from public.arena_battles where ${ACTIVE} and status in ('SIMULATED', 'SETTLED') and starts_at <= $1::timestamptz order by sequence desc limit 1`,
      [now],
    ),
    // "Next" is the earliest battle that has not started on the server clock: still SCHEDULED, or already PREPARED
    // (simulated ahead of time, see stepArena R0) with its start in the future. A prepared battle is the UPCOMING battle —
    // the Arena Picks target: its final roster and pick window are published, its outcome and replay never are.
    q.query<BattleRowFull>(
      `select ${BATTLE_COLS} from public.arena_battles where ${ACTIVE} and (status = 'SCHEDULED' or (status = 'SIMULATED' and starts_at > $1::timestamptz)) order by sequence limit 1`,
      [now],
    ),
  ]);

  // A stopped Arena (NOT STARTED, or PAUSED after it drained) shows NO battle at all: the last battle of the season is over, and keeping it "on stage"
  // would freeze its final frame behind the PAUSED screen. (A pause only completes once the last battle's own results screen has finished.)
  const stopped = runtime?.status === "PAUSED" || runtime?.status === "NOT_STARTED" || !runtime;
  const cur = stopped ? undefined : curRow;
  const nxt = stopped ? undefined : nxtRow;

  // Everything that depends on the battle on stage — and on the upcoming one — is one more round of PARALLEL reads (the upcoming
  // roster rides on the same snapshot as the arena: no extra request, no extra polling loop, no extra round trip).
  const picksEnabled = Boolean(opts.picksEnabled);
  const upcomingRow = nxt && nxt.status === "SIMULATED" ? nxt : null;
  const [loaded, loadedUpcoming] = await Promise.all([
    cur ? loadFighters(q, cur, settings.combat.startRadius) : Promise.resolve(null),
    upcomingRow ? loadFighters(q, upcomingRow, settings.combat.startRadius) : Promise.resolve(null),
  ]);

  let current: BattleDto | null = null;
  if (cur && loaded) {
    const { fighters, parts } = loaded;
    const combatEnds = t(cur.combat_ends_at);
    const finished = combatEnds !== null && nowMs >= combatEnds;
    current = {
      id: cur.id,
      sequence: Number(cur.sequence),
      number: Number(cur.season_sequence),
      status: cur.status,
      startsAt: t(cur.starts_at) as number,
      combatStartsAt: t(cur.combat_starts_at),
      combatEndsAt: combatEnds,
      resultsStartAt: combatEnds === null ? null : combatEnds + settings.arena.victoryHoldMs,
      slotEndsAt: t(cur.slot_ends_at),
      durationMs: cur.duration_ms,
      endedBy: cur.ended_by,
      tickMs: settings.combat.tickMs,
      fighters,
      results: finished
        ? parts
            .filter((p) => p.placement !== null)
            .sort((a, b) => (a.placement as number) - (b.placement as number))
            .map((p) => ({
              placement: p.placement as number, characterId: p.character_id, slot: p.slot, eliminations: p.eliminations,
              damageDealt: p.damage_dealt, survivedMs: p.survived_ms, finalHp: p.final_hp, maxHp: p.max_hp, goldAwarded: p.gold_awarded,
            }))
        : null,
      eventsHash: cur.events_hash,
      rulesVersion: cur.rules_version,
      hasReplay: cur.status !== "SCHEDULED",
    };
  }

  const next: ArenaStateDto["next"] = nxt ? { id: nxt.id, number: Number(nxt.season_sequence), startsAt: t(nxt.starts_at) as number } : null;

  // The upcoming battle's pick window: the SAME pure rule the pick service enforces, fed with the battle on stage as its
  // predecessor (the latest battle that has started is, by construction, the one immediately before the earliest that has not).
  let upcoming: UpcomingBattleDto | null = null;
  if (upcomingRow && loadedUpcoming) {
    const window: PicksWindow = picksWindow(toWindowBattle(upcomingRow), cur ? toWindowPredecessor(cur) : null, nowMs);
    upcoming = {
      id: upcomingRow.id,
      number: Number(upcomingRow.season_sequence),
      startsAt: t(upcomingRow.starts_at) as number,
      fighters: loadedUpcoming.fighters.map(toUpcomingFighter),
      picks: {
        status: window.state === "OPEN" ? "OPEN" : "LOCKED",
        mode: window.mode,
        lockReason: window.state === "OPEN" ? null : window.reason,
        locksAt: window.state === "OPEN" ? window.locksAt : null,
        lockedAt: t(upcomingRow.picks_locked_at),
      },
    };
  }

  const recents = await recentsP;
  const mini = (id: string | null, publicId: string | null, name: string | null, classId: string | null, rarity: string | null, parts: unknown, sprite: unknown, overrides: unknown, frozen: Frozen, avatarVersion: string | null): FighterDto | null => {
    if (!(id && publicId && name && classId && rarity)) return null;
    const snap = frozen && frozen.appearance ? frozen : null;
    return {
      slot: null, characterId: id, publicId, name, classId: snap?.classId ?? classId, title: null, isDemo: false, claimed: false, power: frozen?.power ?? null,
      appearance: snap
        ? { rarity: snap.appearance?.rarity ?? rarity, parts: snap.appearance?.parts ?? parts, sprite: snap.appearance?.sprite ?? sprite ?? undefined }
        : { rarity, parts, sprite: sprite ?? undefined, overrides },
      avatarUrl: avatarUrlOrNull(id, avatarVersion), maxHp: null, startPosition: null,
    };
  };

  return {
    classes: classVisuals(opts.classes),
    timing: { introMs: settings.arena.introMs, countdownMs: settings.arena.countdownMs, victoryHoldMs: settings.arena.victoryHoldMs, resultsMs: settings.arena.resultsMs, maxCombatMs: settings.arena.maxCombatMs, tickMs: settings.combat.tickMs },
    serverTime: nowMs,
    status: publicStatus(runtime?.status ?? "NOT_STARTED", { hasSeason: Boolean(season), hasBattle: Boolean(cur || nxt), eligible: eligibleHeroes, groupSize: settings.arena.groupSize }),
    phase: game?.phase ?? "DEVELOPMENT",
    pausing: runtime?.status === "PAUSE_REQUESTED",
    eligibleHeroes,
    groupSize: settings.arena.groupSize,
    heroThreshold: settings.telegram.qualifyingThreshold,
    season: season ? { id: season.id, kind: season.kind, number: season.number, name: season.name, label: publicSeasonLabel(season) } : null,
    current,
    upcoming,
    next,
    recent: recents.map((r) => ({
      id: r.id, sequence: Number(r.sequence), number: Number(r.season_sequence), endedAt: t(r.slot_ends_at) as number,
      winner: mini(r.wid, r.wpub, r.wname, r.wclass, r.wrarity, r.wparts, r.wsprite, r.wover, r.wsnap, r.wavatar),
      runnerUp: mini(r.rid, r.rpub, r.rname, r.rclass, r.rrarity, r.rparts, r.rsprite, r.rover, r.rsnap, r.ravatar),
    })),
    picks: {
      enabled: picksEnabled,
      rewardGold: settings.picks.rewardGold,
      reward: opts.reward ?? PICKS_REWARD_OFF,
    },
    visuals: { spriteSet: settings.visuals.spriteSet, disabledCosmetics: settings.visuals.disabledCosmetics },
    demo: current?.fighters.some((f) => f.isDemo) ?? false,
  };
}

export interface ReplayDto {
  skillFx: Record<string, { name: string; fx: string }>;
  combat: { arenaRadius: number; startRadius: number; unitRadius: number };
  battleId: string;
  tickMs: number;
  ticks: number;
  stride: number;
  frames: number[];
  events: EventTuple[];
  skillIds: string[];
  startPositions: Array<[number, number]>;
  slotOf: Record<string, number>;
  eventsHash: string;
  rulesVersion: string;
  ranking: number[];
}

/**
 * Replays are RE-SIMULATED from the frozen snapshot + seed + ruleset and checked against the
 * stored hash, so what viewers see is exactly the persisted, verifiable battle.
 *
 * WITHHELD UNTIL COMBAT STARTS (the instant free picks lock). A replay contains the whole
 * outcome, so releasing it while picks are still open would let a script read the winner and
 * "pick" it. Before this moment the browser
 * needs only the roster + start positions (in the arena state) to show the eight standing idle.
 */
export async function getReplayDto(q: Queryable, battleId: string, nowMs: number): Promise<ReplayDto | null> {
  const [b] = await q.query<{ combat_starts_at: Date | null }>("select combat_starts_at from public.arena_battles where id = $1", [battleId]);
  if (!b || b.combat_starts_at === null || nowMs < new Date(b.combat_starts_at).getTime()) return null;
  const replay = await replayBattle(q, battleId);
  if (!replay) return null;
  const o = replay.outcome;
  const rs: Ruleset = replay.ruleset;
  return {
    skillFx: Object.fromEntries(o.skillIds.map((id) => [id, { name: rs.skills[id]?.name ?? id, fx: rs.skills[id]?.fx ?? "buff" }])),
    combat: { arenaRadius: rs.combat.arenaRadius, startRadius: rs.combat.startRadius, unitRadius: rs.combat.unitRadius },
    battleId, tickMs: o.tickMs, ticks: o.ticks, stride: FRAME_STRIDE, frames: o.frames ?? [], events: o.events, skillIds: o.skillIds,
    startPositions: o.startPositions, slotOf: o.slotOf, eventsHash: o.eventsHash, rulesVersion: o.rulesVersion, ranking: o.ranking,
  };
}

// ---------------------------------------------------------------------------------------
// Hero profile
// ---------------------------------------------------------------------------------------

export interface CharacterDto {
  id: string;
  /** Stable public hero id — the profile / share URL. */
  publicId: string;
  kind: "COMMUNITY" | "SPECIAL_CHARACTER";
  name: string;
  title: string | null;
  classId: string;
  power: number;
  claimed: boolean;
  isDemo: boolean;
  appearance: AppearanceDto;
  avatarUrl: string | null;
  stats: Record<string, number>;
  statBreakdown: Record<string, Record<string, number>>;
  record: { battles: number; wins: number; top2: number; eliminations: number; damage: number };
  /** This season's record and ladder tier. Points reset every season; the tier is status only. */
  /** The ACTIVE season (a development run before the launch, Season 1 after it): the figures every public "wins / matches / win rate / rank" reads. */
  season: {
    kind: SeasonKind; number: number | null; name: string; label: string; points: number; battles: number; wins: number; top2: number;
    /** False until the hero has fought a battle THIS season: it is then "Unranked", whatever tier it held before. */
    ranked: boolean;
    rank: SeasonRankView;
  } | null;
  community: { qualifyingMessages: number; activeDays: number; activityScore: number } | null;
  wallet: { linked: boolean; bondedCoinsHeld: number; diamondDays: number };
  achievements: Array<{ id: string; name: string; description: string; category: string; unlocked: boolean; unlockedAt: Date | null; badge: string; title?: string }>;
  recentBattles: Array<{ battleId: string; placement: number; eliminations: number; gold: number; at: Date | null }>;
  special: { role: string; bio: string } | null;
}

export async function getCharacterDto(q: Queryable, id: string, settings: GameSettings, fighter: { stats: Record<string, number>; breakdown: Record<string, Record<string, number>>; power: number } | null): Promise<CharacterDto | null> {
  const [c] = await q.query<{
    id: string; public_id: string; kind: CharacterDto["kind"]; name: string; title: string | null; class_id: string; power: number; is_demo: boolean;
    claimed: boolean; rarity: string; parts: unknown; sprite: unknown; overrides: unknown;
    qualifying: number | null; active_days: number | null; activity: number | null; role: string | null; bio: string | null; wallet_linked: boolean; avatar_version: string | null;
  }>(
    `select c.id, c.public_id, c.kind, coalesce(c.name_override, c.name) as name, c.title, c.class_id, c.power, c.is_demo, (cl.character_id is not null) as claimed, ca.rarity, ca.parts, ca.sprite, ca.cosmetic_overrides as overrides,
            tu.qualifying_message_count as qualifying, tu.active_days, tu.activity_score as activity, sp.role, sp.bio,
            exists (select 1 from public.wallet_links w where w.character_id = c.id and w.unlinked_at is null) as wallet_linked, hp.version as avatar_version
       from public.characters c join public.character_appearances ca on ca.character_id = c.id
       left join public.character_claims cl on cl.character_id = c.id left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
       left join public.special_character_profiles sp on sp.character_id = c.id left join public.hero_profile_photos hp on hp.character_id = c.id
      where c.id = $1`,
    [id],
  );
  if (!c) return null;
  // The record is the ACTIVE season's (see services/seasonRecords.ts): a new season starts every hero at 0 matches / 0 wins / Unranked.
  const record = await activeSeasonRecord(q, id);
  const [bonded] = await q.query<{ n: number; days: number | null }>(
    `select (select count(*)::int from public.token_holdings h join public.eligible_tokens t on t.id = h.token_id where h.character_id = $1 and h.balance > 0 and t.status = 'ELIGIBLE') as n,
            (select max(floor(extract(epoch from (now() - started_at)) / 86400))::int from public.holding_streaks where character_id = $1 and ended_at is null) as days`,
    [id],
  );
  const unlocked = await q.query<{ achievement_id: string; unlocked_at: Date }>("select achievement_id, unlocked_at from public.character_achievements where character_id = $1 and archived_at is null", [id]);
  const defs = await q.query<{ id: string; name: string; description: string; category: string; reward: { badge: string; title?: string }; hidden: boolean; criteria: unknown }>(
    "select id, name, description, category, reward, hidden, criteria from public.achievements where enabled order by sort_order",
  );
  const have = new Map(unlocked.map((u) => [u.achievement_id, u.unlocked_at]));
  const recent = await q.query<{ battle_id: string; placement: number; eliminations: number; gold_awarded: number; settled_at: Date | null }>(
    `select p.battle_id, p.placement, p.eliminations, p.gold_awarded, b.settled_at from public.arena_participants p
       join public.arena_battles b on b.id = p.battle_id where p.character_id = $1 and b.status = 'SETTLED' and b.season_id = (select id from public.seasons where status = 'ACTIVE' limit 1) order by b.sequence desc limit 8`,
    [id],
  );
  const tiers = settings.progression.seasonRanks;
  void DEFAULT_ACHIEVEMENTS;
  return {
    id: c.id, publicId: c.public_id, kind: c.kind, name: c.name, title: c.title, classId: c.class_id,
    power: fighter?.power ?? c.power, claimed: c.claimed, isDemo: c.is_demo, appearance: { rarity: c.rarity, parts: c.parts, sprite: c.sprite ?? undefined, overrides: c.overrides }, avatarUrl: avatarUrlOrNull(c.id, c.avatar_version),
    stats: fighter?.stats ?? {}, statBreakdown: fighter?.breakdown ?? {},
    record: { battles: record.battles, wins: record.wins, top2: record.top2, eliminations: record.eliminations, damage: record.damage },
    season: record.season
      ? {
          kind: record.season.kind, number: record.season.number, name: record.season.name, label: record.season.label, points: record.points,
          battles: record.battles, wins: record.wins, top2: record.top2, ranked: record.battles > 0,
          rank: seasonRankView(record.points, record.battles, tiers),
        }
      : null,
    community: c.qualifying === null ? null : { qualifyingMessages: c.qualifying, activeDays: c.active_days ?? 0, activityScore: Number(c.activity ?? 0) },
    wallet: { linked: c.wallet_linked, bondedCoinsHeld: bonded?.n ?? 0, diamondDays: bonded?.days ?? 0 },
    achievements: defs
      .filter((d) => !isRetiredAchievement(d.criteria) && (!d.hidden || have.has(d.id)))
      .map((d) => ({ id: d.id, name: d.name, description: d.description, category: d.category, unlocked: have.has(d.id), unlockedAt: have.get(d.id) ?? null, badge: d.reward.badge, ...(d.reward.title ? { title: d.reward.title } : {}) })),
    recentBattles: recent.map((r) => ({ battleId: r.battle_id, placement: r.placement, eliminations: r.eliminations, gold: r.gold_awarded, at: r.settled_at })),
    special: c.role !== null ? { role: c.role, bio: c.bio ?? "" } : null,
  };
}

export async function searchHeroes(q: Queryable, term: string, allowDemo: boolean, limit = 12): Promise<Array<{ id: string; publicId: string; name: string; classId: string; claimed: boolean; appearance: AppearanceDto; avatarUrl: string | null }>> {
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`).toLowerCase()}%`;
  const rows = await q.query<{ id: string; public_id: string; name: string; class_id: string; claimed: boolean; rarity: string; parts: unknown; sprite: unknown; overrides: unknown; avatar_version: string | null }>(
    `select c.id, c.public_id, coalesce(c.name_override, c.name) as name, c.class_id, (cl.character_id is not null) as claimed, ca.rarity, ca.parts, ca.sprite, ca.cosmetic_overrides as overrides, hp.version as avatar_version
       from public.characters c join public.character_appearances ca on ca.character_id = c.id
       left join public.character_claims cl on cl.character_id = c.id left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
       left join public.hero_profile_photos hp on hp.character_id = c.id
      where c.status = 'ACTIVE' and (not c.is_demo or $2::boolean) and (lower(coalesce(c.name_override, c.name)) like $1 escape '\\' or lower(tu.username) like $1 escape '\\')
      order by c.power desc limit $3`,
    [like, allowDemo, limit],
  );
  return rows.map((r) => ({ id: r.id, publicId: r.public_id, name: r.name, classId: r.class_id, claimed: r.claimed, appearance: { rarity: r.rarity, parts: r.parts, sprite: r.sprite ?? undefined, overrides: r.overrides }, avatarUrl: avatarUrlOrNull(r.id, r.avatar_version) }));
}
