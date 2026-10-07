import type { Db } from "@/server/db/types";

import { runArena, seedEligibleMember } from "./db";

/**
 * SYNTHETIC HERO ARENA HISTORY — exact placements at exact instants, without simulating hundreds of fights. Writes SETTLED battles (the same rows the real settlement
 * produces: status SETTLED, settled_at, winner, participants with placement / eliminations) and mirrors what the real settlement adds to the season totals
 * (`season_character_stats`: battles, wins, top-2, eliminations), so the period boards and the Season boards can be checked against each other.
 */
export interface HeroSpec {
  /** The Telegram member the hero belongs to (created eligible, with a hero). */
  user: number;
  name?: string;
  status?: "ACTIVE" | "INACTIVE" | "SUSPENDED";
  claimed?: boolean;
}

/** Creates members + heroes (optionally claimed) and returns user → hero id. */
export async function seedHeroOwners(db: Db, specs: HeroSpec[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const s of specs) {
    await seedEligibleMember(db, { id: s.user });
    const [hero] = await db.query<{ id: string }>("select id from public.characters where telegram_user_id = $1", [s.user]);
    if (s.name) await db.query("update public.characters set name = $2 where id = $1", [hero!.id, s.name]);
    if (s.claimed) await db.query("insert into public.character_claims (character_id, telegram_user_id, auth_date) values ($1, $2, now()) on conflict do nothing", [hero!.id, s.user]);
    out.set(s.user, hero!.id);
  }
  return out;
}

export interface BattleSpec {
  /** When it settled (ISO). The period it belongs to is decided by this instant, exactly as in production. */
  at: string;
  /** hero id → placement (1 = the win). */
  placements: Array<{ hero: string; placement: number; kos?: number }>;
  seasonId?: string;
  /** How far the battle got: SETTLED (default), SIMULATED (decided, not settled yet) or VOID (cancelled). Only SETTLED battles count anywhere. */
  outcome?: "SETTLED" | "SIMULATED" | "VOID";
}

let sequence = 0;

/** Inserts the battles in the given order. Heroes are suspended / banned AFTER this if a test needs it (a suspended hero cannot enter a new roster). */
export async function seedHeroBattles(db: Db, battles: BattleSpec[]): Promise<string[]> {
  // The database refuses to schedule a battle while the Arena is stopped. This scratch Arena is run for the moment history is written and left PAUSED (a stopped
  // state: lifecycle actions such as END SEASON still work) — unless it was already running.
  const [state] = await db.query<{ status: string }>("select status from public.arena_state where id = 1");
  const wasRunning = state?.status === "RUNNING";
  if (!wasRunning) await runArena(db);
  try {
    return await writeBattles(db, battles);
  } finally {
    if (!wasRunning) {
      await db.query("update public.arena_state set status = 'PAUSE_REQUESTED' where id = 1");
      await db.query("update public.arena_state set status = 'PAUSED' where id = 1");
    }
  }
}

async function writeBattles(db: Db, battles: BattleSpec[]): Promise<string[]> {
  const hash = "a".repeat(64);
  await db.query("insert into public.ruleset_snapshots (hash, rules_version, ruleset) values ($1, 'test', '{}'::jsonb) on conflict (hash) do nothing", [hash]);
  const ids: string[] = [];
  for (const b of battles) {
    const [season] = await db.query<{ id: string }>("select id from public.seasons where ($1::uuid is null and status = 'ACTIVE') or id = $1::uuid limit 1", [b.seasonId ?? null]);
    const [existing] = await db.query<{ id: string }>("select id from public.arena_cycles where seed = $1 limit 1", [`hero-arena-${season!.id}`]);
    const cycle =
      existing?.id ??
      (await db.query<{ id: string }>("insert into public.arena_cycles (number, season_id, status, seed, hero_count, completed_at) values (800000 + (select count(*)::int from public.arena_cycles), $1, 'COMPLETED', $2, 0, now()) returning id", [season!.id, `hero-arena-${season!.id}`]))[0]!.id;
    const winner = b.placements.find((p) => p.placement === 1)?.hero ?? null;
    const runnerUp = b.placements.find((p) => p.placement === 2)?.hero ?? null;
    // The REAL lifecycle, because the database enforces it: a roster can only be written while the battle is SCHEDULED (it is final afterwards), a battle is
    // SIMULATED before it is SETTLED, and settled results are frozen.
    const [battle] = await db.query<{ id: string }>(
      `insert into public.arena_battles (season_id, cycle_id, status, starts_at, combat_starts_at, combat_ends_at, slot_ends_at, season_sequence)
       values ($1, $2, 'SCHEDULED', $3::timestamptz - interval '40 seconds', $3::timestamptz - interval '30 seconds', $3::timestamptz - interval '10 seconds', $3::timestamptz, $4) returning id`,
      [season!.id, cycle, b.at, ++sequence],
    );
    ids.push(battle!.id);
    let slot = 0;
    for (const p of b.placements) {
      await db.query("insert into public.arena_participants (battle_id, character_id, slot, placement, eliminations) values ($1, $2, $3, $4, $5)", [battle!.id, p.hero, slot++, p.placement, p.kos ?? 0]);
      if ((b.outcome ?? "SETTLED") !== "SETTLED") continue; // season totals only ever move when a battle SETTLES
      await db.query(
        `insert into public.season_character_stats (season_id, character_id, points, battles, wins, top2, eliminations, damage) values ($1, $2, 0, 1, $3, $4, $5, 0)
         on conflict (season_id, character_id) do update set battles = public.season_character_stats.battles + 1, wins = public.season_character_stats.wins + excluded.wins,
           top2 = public.season_character_stats.top2 + excluded.top2, eliminations = public.season_character_stats.eliminations + excluded.eliminations`,
        [season!.id, p.hero, p.placement === 1 ? 1 : 0, p.placement <= 2 ? 1 : 0, p.kos ?? 0],
      );
    }
    await db.query("update public.arena_battles set status = 'SIMULATED', rules_version = 'test', ruleset_hash = $2, seed = $3, snapshot = '{}'::jsonb, simulated_at = $4::timestamptz where id = $1", [battle!.id, hash, `seed-${sequence}`, b.at]);
    if ((b.outcome ?? "SETTLED") === "SETTLED") await db.query("update public.arena_battles set status = 'SETTLED', settled_at = $2::timestamptz, winner_id = $3, runner_up_id = $4 where id = $1", [battle!.id, b.at, winner, runnerUp]);
    else if (b.outcome === "VOID") await db.query("update public.arena_battles set status = 'VOID', settled_at = $2::timestamptz where id = $1", [battle!.id, b.at]);
  }
  return ids;
}

/**
 * Gives each hero exactly `wins` wins on `day` (UTC date) — one battle per win, each against two throw-away filler heroes (placements 2 and 3) so the filler never
 * out-wins anyone. Returns nothing: assert through the boards.
 */
export async function giveWins(db: Db, hero: string, wins: number, at: string, opts: { seasonId?: string; filler: [string, string]; top2Only?: number; kos?: number } ): Promise<void> {
  const battles: BattleSpec[] = [];
  const base = Date.parse(at);
  for (let i = 0; i < wins; i++) battles.push({ at: new Date(base + i * 60_000).toISOString(), seasonId: opts.seasonId, placements: [{ hero, placement: 1, kos: opts.kos ?? 1 }, { hero: opts.filler[0], placement: 2 }, { hero: opts.filler[1], placement: 3 }] });
  for (let i = 0; i < (opts.top2Only ?? 0); i++) battles.push({ at: new Date(base + (wins + i) * 60_000).toISOString(), seasonId: opts.seasonId, placements: [{ hero: opts.filler[0], placement: 1 }, { hero, placement: 2, kos: 0 }, { hero: opts.filler[1], placement: 3 }] });
  await seedHeroBattles(db, battles);
}
