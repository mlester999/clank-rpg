/**
 * SCRATCH-ONLY QA DATA for the Events page and the Season 1 launch screens.
 *
 * It builds three disposable databases on a LOCAL throwaway Postgres, so the real screens can be looked at without touching anything that matters:
 *
 *   pre       a pre-season: ~40 real generated heroes, battles, Picks, frozen boards (no prizes), Gold / loot — the game as it is before the launch
 *   launch    the same database after the (typed, preflighted, backed-up) Season 1 launch — Season 1 empty
 *   history   Season 1 backdated by 16 days with synthetic official results, finalized day by day and week by week (champions, ties, empty days, an ineligible leader…)
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5498/clank_qa_pre pnpm exec tsx scripts/qa-events-seed.ts pre
 *
 * HARD GUARD: it refuses any database that is not on 127.0.0.1 / localhost AND whose name does not start with "clank_qa". Nothing here can be pointed at Supabase.
 * The numbers it writes are fabricated for screenshots; they are never production data, and the history stage edits timestamps on the scratch copy only.
 */
import { DEFAULT_SETTINGS, type GameSettings } from "../src/domain/settings";
import { loadClasses, loadSettings } from "../src/server/config/settingsRepo";
import { migrate } from "../src/server/db/migrate";
import { finalizeHeroPeriod, resetHeroArenaReadiness } from "../src/server/rewards/heroArena";
import { seedReferenceData } from "../src/server/seed/reference";
import { createCharacterForUser, type TelegramUserRow } from "../src/server/services/characters";
import { applyLedger } from "../src/server/services/economy";
import { launchSeason1, recordBackupAttestation } from "../src/server/services/lifecycle";
import { giveWins } from "../tests/support/heroArena";
import { finalize as finalizePicks, seedScores, settingsWith } from "../tests/support/rewards";

import { run } from "./lib/context";

const NAMES = [
  "MARKYYESTER", "Celsius", "Gearbox Gus", "Rivet", "Sprocket Sue", "Piston Pete", "Cog Cadet", "Lady Lathe", "Boltcutter", "Dynamo Dan", "Torque Tina", "Welder Wren",
  "Flywheel", "Crankshaft Kai", "Pinion Pia", "Ratchet Rex", "Grease Monkey", "Anvil Ada", "Bellows Bo", "Turbine Tess", "Clutch", "Gantry Gil", "Furnace Finn",
  "SIR BARNABY THE MAGNIFICENT", "Xx_DragonSlayer_2000_xX", "Bjørn Ærøskøbing", "Hammer Hana", "Lever Lou", "Vice Vera", "Steamfitter", "Chisel Chen", "Axle Axel",
  "Brass Bruno", "Copper Cleo", "Ember Ellis", "Forge Fay", "Gasket Gale", "Hinge Hugo", "Ironclad Ivy", "Jack Jolt",
];
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

void run(async ({ db, target, databaseUrl }) => {
  // ── the guard: local + throwaway only ───────────────────────────────────────────────────────────────────────────
  if (!databaseUrl) throw new Error("Set DATABASE_URL to a LOCAL scratch database named clank_qa*.");
  const u = new URL(databaseUrl);
  if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) || !/^\/clank_qa/.test(u.pathname)) throw new Error(`Refusing ${target}: QA data is written only to a local database named clank_qa*.`);
  const stage = process.argv[2];
  if (!["pre", "launch", "history"].includes(stage ?? "")) throw new Error("Usage: qa-events-seed.ts pre | launch | history");

  const noPrizes = (): GameSettings => ({ ...settingsWith({ enabled: false }), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: false } });
  const withPrizes = (heroPool: boolean): GameSettings => ({ ...settingsWith(), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: heroPool, dailyPrizePool: "10000", weeklyPrizePool: "50000" } });
  const heroCtx = (settings: GameSettings, at: number) => ({ now: () => new Date(at), settings, allowDemo: false });
  const deps = { actor: "qa-admin", allowDemo: false } as const;
  const members = async () => (await db.query<{ telegram_user_id: number; id: string }>("select telegram_user_id, id from public.characters order by created_at, id")).map((r) => ({ user: Number(r.telegram_user_id), hero: r.id }));

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (stage === "pre") {
    await migrate(db);
    await seedReferenceData(db);
    const settings = await loadSettings(db);
    const classes = await loadClasses(db);
    for (let i = 0; i < NAMES.length; i++) {
      const id = 5_100_000 + i;
      await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count, behavior) values ($1, $2, 160, '{}'::jsonb) on conflict do nothing", [id, NAMES[i]]);
      const [user] = await db.query<TelegramUserRow>("select * from public.telegram_users where telegram_user_id = $1", [id]);
      await createCharacterForUser(db, user as TelegramUserRow, { settings, classes, secret: "qa-throwaway-class-roll-secret-0123456789", origin: "TELEGRAM" });
    }
    // exact public names (the hero name is presentation, not identity)
    for (let i = 0; i < NAMES.length; i++) await db.query("update public.characters set name = $2 where telegram_user_id = $1", [5_100_000 + i, NAMES[i]]);
    const m = await members();
    const filler: [string, string] = [m[38]!.hero, m[39]!.hero];

    // the pre-season: three days of battles and Picks, boards frozen WITHOUT prizes (a credited prize would — rightly — block the launch)
    const base = Date.parse("2026-09-24T00:00:00Z"); // well before any Season 1 day: a date can only ever hold ONE frozen board
    for (let d = 0; d < 3; d++) {
      const day = iso(base + d * DAY);
      await giveWins(db, m[d]!.hero, 5 - d, `${day}T11:00:00Z`, { filler, kos: 2 });
      await giveWins(db, m[d + 5]!.hero, 3, `${day}T14:00:00Z`, { filler });
      await seedScores(db, m.slice(0, 8).map((x, i) => ({ user: x.user, day, picks: 24 - i, correct: 18 - i * 2 + d })));
      await finalizePicks(db, "DAILY", day, base + (d + 1) * DAY + 3_600_000, { settings: noPrizes() });
      await finalizeHeroPeriod(db, heroCtx(noPrizes(), base + (d + 1) * DAY + 3_600_000), "DAILY", day);
    }
    for (const x of m.slice(0, 12)) await applyLedger(db, { characterId: x.hero, amount: 150 + Math.floor(Math.random() * 600), reason: "arena", idempotencyKey: `qa-gold-${x.hero}` });
    for (const x of m.slice(0, 6)) {
      const [c] = await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [x.hero]);
      await db.query("insert into public.inventory_items (character_id, template_id, slot, equipped) values ($1, $2, 'WEAPON', true)", [x.hero, `${c!.class_id}_weapon_rare`]);
    }
    console.log(`✓ pre-season ready: ${m.length} heroes`);
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (stage === "launch") {
    await recordBackupAttestation(db, deps, { reference: "QA scratch snapshot (template database clank_qa_pre)", verified: true, notes: "scratch data — fabricated for screenshots" });
    const r = await launchSeason1(db, deps, { confirmation: "LAUNCH SEASON 1" });
    console.log(`✓ launched: ${r.seasonNumber}, archived ${r.archived?.battlesSettled ?? 0} battles, ${r.economy.goldAccountsReset} gold accounts reset`);
    return;
  }

  // ── history: Season 1, backdated 16 days on THIS scratch copy, with fabricated official results ─────────────────
  resetHeroArenaReadiness();
  const SPAN = 16;
  const todayMs = Math.floor(Date.now() / DAY) * DAY;
  const startMs = todayMs - SPAN * DAY;
  await db.exec("alter table public.game_state disable trigger game_state_guard; alter table public.seasons disable trigger seasons_guard");
  await db.query("update public.game_state set launched_at = launched_at - ($1 || ' days')::interval", [String(SPAN)]);
  await db.query("update public.seasons set starts_at = starts_at - ($1 || ' days')::interval where kind = 'COMPETITIVE'", [String(SPAN)]);
  await db.exec("alter table public.game_state enable trigger game_state_guard; alter table public.seasons enable trigger seasons_guard");

  const m = await members();
  const filler: [string, string] = [m[38]!.hero, m[39]!.hero];
  const pick = (n: number) => m.slice(0, n);
  for (let d = 0; d < SPAN; d++) {
    const dayMs = startMs + d * DAY;
    const day = iso(dayMs);
    const closed = dayMs + DAY + 3_600_000;
    let scores: Array<{ user: number; picks: number; correct: number }> = [];
    let wins: Array<{ hero: number; n: number }> = [];
    switch (d % 8) {
      case 0: scores = pick(8).map((x, i) => ({ user: x.user, picks: 26 - i, correct: 20 - i * 2 })); wins = [{ hero: 0, n: 5 }, { hero: 3, n: 3 }, { hero: 7, n: 1 }]; break; // a plain day
      case 1: scores = pick(6).map((x, i) => ({ user: x.user, picks: 24, correct: i < 2 ? 17 : 10 - i })); wins = [{ hero: 4, n: 4 }, { hero: 5, n: 4 }, { hero: 9, n: 2 }]; break; // a tie for first, in both competitions
      case 2: scores = [{ user: m[10]!.user, picks: 19, correct: 19 }, ...pick(5).map((x, i) => ({ user: x.user, picks: 25, correct: 18 - i * 3 }))]; wins = [{ hero: 2, n: 6 }, { hero: 6, n: 2 }]; break; // an ineligible leader
      case 3: scores = []; wins = []; break; // an empty day
      case 4: scores = pick(5).map((x, i) => ({ user: x.user, picks: 12 - i, correct: 9 - i })); wins = [{ hero: 8, n: 3 }]; break; // nobody reaches the Pick minimum
      case 5: scores = pick(10).map((x, i) => ({ user: x.user, picks: 30 - i, correct: 24 - i })); wins = [{ hero: 23, n: 5 }, { hero: 24, n: 4 }, { hero: 25, n: 3 }]; break; // long names win
      case 6: scores = []; wins = [{ hero: 1, n: 4 }, { hero: 12, n: 2 }]; break; // heroes fought, nobody picked
      default: scores = pick(9).map((x, i) => ({ user: x.user, picks: 23 - i, correct: 17 - i })); wins = [{ hero: 11, n: 5 }, { hero: 1, n: 3 }]; break;
    }
    if (scores.length) await seedScores(db, scores.map((s) => ({ ...s, day })));
    for (const w of wins) await giveWins(db, m[w.hero]!.hero, w.n, `${day}T${String(10 + (w.hero % 8)).padStart(2, "0")}:00:00Z`, { filler, kos: 1 + (w.hero % 3) });
    await finalizePicks(db, "DAILY", day, closed, { settings: withPrizes(false) });
    // Hero Arena: no pool approved yet (recognition only) — except two days finalized WITH a test pool to see how an allocation reads
    await finalizeHeroPeriod(db, heroCtx(withPrizes(d === 0 || d === 5), closed), "DAILY", day);
  }
  // the weekly boards: every complete Monday-to-Monday week of the span
  for (let ms = startMs; ms < todayMs; ms += DAY) {
    const dow = new Date(ms).getUTCDay();
    if (dow !== 1) continue;
    const end = ms + 7 * DAY;
    if (end > todayMs) continue;
    await finalizePicks(db, "WEEKLY", iso(ms), end + 3_600_000, { settings: withPrizes(false) });
    await finalizeHeroPeriod(db, heroCtx(withPrizes(false), end + 3_600_000), "WEEKLY", iso(ms));
  }
  console.log(`✓ Season 1 history: ${SPAN} days from ${iso(startMs)}`);
});
