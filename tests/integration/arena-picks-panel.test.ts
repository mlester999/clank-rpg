import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ArenaPicks } from "@/components/arena/ArenaPicks";
import { pickCopy, secondsUntilLock, windowDisplay } from "@/components/arena/picksView";
import type { PicksApi } from "@/components/arena/usePicks";
import type { ArenaStateDto, PicksRewardDto } from "@/lib/dto";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { getArenaState } from "@/server/services/views";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

/**
 * The Arena Picks PANEL, server-rendered from a REAL arena state (no browser needed): it lists the UPCOMING eight — never the
 * fighters on stage — and says in each phase what it must, and (as important) what it must NOT say: no betting words, no
 * crowd before the lock, no "you lost", no per-battle token reward. This complements, and does not replace, a real-browser pass.
 */
let db: Db;
let clock: FakeClock;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  clock = new FakeClock();
});

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
const BETTING_WORDS = /\b(bet|bets|betting|wager|wagering|odds|escrow|deposit|stake[sd]?|withdraw|bet pool|betting balance|you lost|winning bet|losing bet)\b/i;
/** Every phrase that implied a token reward PER BATTLE: obsolete — the boards pay, not the battle. */
const OBSOLETE_COPY = /10,000|correct pickers? share|share[sd]? .{0,30}\$CLANKRPG this round|round reward|reward this (battle|round)|token reward this battle|this round\b/i;

const REWARD: PicksRewardDto = {
  status: "ACTIVE",
  symbol: "$CLANKRPG",
  pointsPerCorrectPick: 10,
  dailyMinimumPicks: 20,
  weeklyMinimumPicks: 100,
  daily: { prizePool: "500,000", topRewarded: 10, endsAt: Date.parse("2026-10-05T00:00:00Z") + 86_400_000 },
  weekly: { prizePool: "1,000,000", topRewarded: 10, endsAt: Date.parse("2026-10-12T00:00:00Z") },
};

/** An arena with battle A on stage and battle B UPCOMING (picks OPEN), at the clock's current instant (A has just taken the stage). */
async function arena(reward: PicksRewardDto = REWARD): Promise<ArenaStateDto> {
  await seedHeroes(db, 24);
  await advanceArena(db, arenaCtx(clock));
  return stateAt(clock.ms, reward);
}
const stateAt = async (t: number, reward: PicksRewardDto = REWARD): Promise<ArenaStateDto> =>
  getArenaState(db, t, await loadSettings(db), { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true, reward });

const basePicks = (over: Partial<PicksApi> = {}): PicksApi => ({
  signedIn: true,
  eligibility: { eligible: true, reason: null, explanation: "Members with 50+ qualifying messages in the official Clank.trade community can participate in rewarded Arena Picks." },
  pick: null,
  round: { locked: false, distribution: null, outcome: null },
  current: { pick: null, round: null },
  pendingCharacterId: null,
  error: null,
  errorDetail: null,
  submit: async () => undefined,
  clearError: () => undefined,
  ...over,
});

const panel = (state: ArenaStateDto, picks: PicksApi, over: { now?: number; decided?: boolean; onStage?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(ArenaPicks, {
      state,
      upcoming: state.upcoming,
      now: over.now ?? state.serverTime,
      picks,
      onStage: over.onStage === false ? null : { fighters: state.current?.fighters ?? [], decided: over.decided ?? false },
      loaded: true,
    }),
  );

const myPick = (state: ArenaStateDto, index: number, over: Partial<NonNullable<PicksApi["pick"]>> = {}) => ({
  battleId: state.upcoming!.id, characterId: state.upcoming!.fighters[index]!.characterId, submittedAt: 1, changedCount: 0, locked: false, result: null, rewardGold: 0, rewardEligible: true, ...over,
});

describe("Arena Picks panel — picks OPEN while the current fight is on", () => {
  it("shows ARENA PICKS / pick the next winner, the short copy, and the UPCOMING eight (avatar, name, class, PWR, PICK) — never the fighters on stage", async () => {
    const state = await arena();
    const html = panel(state, basePicks());
    const t = text(html);
    expect(t).toMatch(/Arena Picks/);
    expect(t).toMatch(/Pick the next winner/);
    expect(t).toMatch(/Picks open · \d+s/);
    expect(t).toContain("Correct Pick = +10 Points");
    expect(t).not.toMatch(/Every valid Pick counts|first 20|per day|each day count|scored Picks/i); // the per-day cap is gone from the panel's words
    expect(t).toContain("Free to play");
    expect(t).not.toMatch(/No wallet required|Pick the winner\. Earn/); // the longer sentences are gone: the Arena is a quick summary
    // the prizes are two compact tiles: the TOTAL pools and the token — and nothing else (no Top 10 banner, no countdown, no fine print)
    expect(html).toContain('data-testid="prize-daily"');
    expect(html).toContain('data-testid="prize-weekly"');
    expect(t).toContain("Daily pool 500,000 $CLANKRPG");
    expect(t).toContain("Weekly pool 1,000,000 $CLANKRPG");
    expect(t).not.toMatch(/Top 10 winners|Resets in|Prize pool/);
    expect(t).not.toContain("Daily 500,000 · Weekly 1,000,000"); // the old plain line is gone
    for (const f of state.upcoming!.fighters) {
      expect(t).toContain(f.name);
      expect(t).toContain(state.classes[f.classId]!.name);
      expect(t).toContain(`PWR ${f.power!.toLocaleString()}`);
    }
    // The panel is about the NEXT fight: nobody who is fighting right now appears in it.
    for (const f of state.current!.fighters) expect(html).not.toContain(f.characterId);
    for (const f of state.current!.fighters) expect(t).not.toContain(f.name);
    expect((html.match(/aria-label="Pick /g) ?? []).length).toBe(8); // a PICK button on every upcoming fighter
    expect(html).toContain(`data-battle="${state.upcoming!.id}"`);
    expect(html).toContain('data-window="OPEN"');
    expect(t).not.toMatch(BETTING_WORDS);
    expect(html).not.toContain('data-testid="crowd"'); // anti-herding: no counts while open
    expect(t).not.toMatch(/\d+ Picks? on the next fight/);
    expect(t).not.toMatch(/\$\s?(10|20|50|100)\b/);
    expect(t).not.toMatch(/balance|deposit|confirm bet/i);
  });

  it("never carries the obsolete per-battle token copy, anywhere in the panel", async () => {
    const state = await arena();
    for (const picks of [basePicks(), basePicks({ pick: myPick(state, 0) }), basePicks({ signedIn: false, eligibility: null })]) {
      expect(text(panel(state, picks))).not.toMatch(OBSOLETE_COPY);
    }
    expect(text(panel(await stateAt(clock.ms, { ...REWARD, status: "OFF" }), basePicks()))).not.toMatch(OBSOLETE_COPY);
    for (const c of [pickCopy(REWARD), pickCopy(undefined), pickCopy({ ...REWARD, status: "OFF" })]) expect(JSON.stringify(c)).not.toMatch(OBSOLETE_COPY);
  });

  it("YOUR PICK marks the selected upcoming fighter", async () => {
    const state = await arena();
    const mine = state.upcoming!.fighters[2]!;
    const html = panel(state, basePicks({ pick: myPick(state, 2) }));
    expect(html).toContain(`aria-label="${mine.name} is your pick"`);
    expect(html).toContain('data-picked="true"');
    expect(text(html)).toMatch(/Your pick/);
  });

  it("signed-out visitors STILL see the eight and the OPEN state, with the Telegram sign-in call to action (no wallet)", async () => {
    const state = await arena();
    const html = panel(state, basePicks({ signedIn: false, eligibility: null }));
    const t = text(html);
    expect(t).toMatch(/Sign in with Telegram to make your Pick\./);
    expect(t).toMatch(/Picks open/);
    for (const f of state.upcoming!.fighters) expect(t).toContain(f.name); // not blocked behind authentication
    expect(t).not.toMatch(/connect (a )?wallet/i);
    expect(t).not.toMatch(/connect|wallet(?! required)/i);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Pick /); // nothing to press until signed in
  });

  it("an ineligible member sees the ONE public eligibility sentence and cannot press PICK", async () => {
    const state = await arena();
    const html = panel(state, basePicks({ eligibility: { eligible: false, reason: "BELOW_THRESHOLD", explanation: "Members with 50+ qualifying messages in the official Clank.trade community can participate in rewarded Arena Picks." } }));
    expect(text(html)).toContain("Members with 50+ qualifying messages in the official Clank.trade community can participate in rewarded Arena Picks.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Pick /);
    expect(text(html)).not.toMatch(/banned|suspended|flag|risk|score(?!d| Points)/i);
  });

  it("with the reward programme OFF the panel promises no prize — Picks and Points still work", async () => {
    const state = await arena({ ...REWARD, status: "OFF", dailyMinimumPicks: 0, weeklyMinimumPicks: 0, daily: { ...REWARD.daily, prizePool: "0" }, weekly: { ...REWARD.weekly, prizePool: "0" } });
    const html = panel(state, basePicks());
    const t = text(html);
    expect(t).toContain("Pick who wins the next fight.");
    expect(t).toMatch(/Correct Picks earn Clank Points/);
    expect(t).not.toMatch(/Daily [\d,]+ ·/);
    expect(html).not.toContain('data-testid="prize-pools"'); // nothing is promised while the programme is off
    expect(t).not.toMatch(/Daily pool|Weekly pool|Top 10 winners|100,000|500,000/);
    expect(t).toMatch(/Picks open/);
  });
});

describe("Arena Picks panel — the compact prize presentation (hierarchy, states)", () => {
  const order = (html: string, ...needles: string[]) => needles.map((n) => html.indexOf(n));
  const ascending = (xs: number[]) => xs.every((x, i) => x > -1 && (i === 0 || x > (xs[i - 1] as number)));

  it("reads top to bottom: Arena Picks / next fight → the two prize pools → how it works (+10, free) → the sign-in step → the fighters", async () => {
    const state = await arena();
    const html = panel(state, basePicks({ signedIn: false, eligibility: null }));
    expect(ascending(order(html, 'id="arena-picks"', "Pick the next winner", 'data-testid="prize-pools"', 'data-testid="prize-daily"', 'data-testid="prize-weekly"', 'data-testid="prize-rules-link"', 'data-testid="picks-copy"', 'data-testid="picks-signin"', "<ol "))).toBe(true);
  });

  it("signed OUT: the Telegram step is a designed strip below the prizes and copy — the same link to the same sign-in page, never above the prizes", async () => {
    const state = await arena();
    const html = panel(state, basePicks({ signedIn: false, eligibility: null }));
    const t = text(html);
    expect(t).toContain("Sign in with Telegram to make your Pick.");
    expect(html).toMatch(/<a[^>]*href="\/character"[^>]*>Sign in with Telegram<\/a>/);
    expect(html.indexOf('data-testid="picks-signin"')).toBeGreaterThan(html.indexOf('data-testid="prize-weekly"'));
    expect(html).toContain('data-testid="prize-daily"');
    expect(html).toContain('data-testid="prize-weekly"');
  });

  it("signed IN: no sign-in strip, the prizes still lead, and the member's own pick state is the one the panel already had", async () => {
    const state = await arena();
    const html = panel(state, basePicks({ pick: myPick(state, 4) }));
    expect(html).not.toContain('data-testid="picks-signin"');
    expect(html).toContain('data-testid="prize-pools"');
    expect(html).toContain(`aria-label="${state.upcoming!.fighters[4]!.name} is your pick"`);
    expect(html.indexOf('data-testid="prize-pools"')).toBeLessThan(html.indexOf('data-picked="true"'));
    expect(text(html)).not.toMatch(/Sign in with Telegram/);
  });

  it("an ineligible member sees the prizes, then the one eligibility sentence — and PICK stays off", async () => {
    const state = await arena();
    const html = panel(state, basePicks({ eligibility: { eligible: false, reason: "BELOW_THRESHOLD", explanation: "Members with 50+ qualifying messages in the official Clank.trade community can participate in rewarded Arena Picks." } }));
    expect(html.indexOf('data-testid="prize-pools"')).toBeLessThan(html.indexOf('data-testid="picks-ineligible"'));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Pick /);
  });

  it("the panel carries no token-launch disclaimer at all (it was removed): nothing about launch or claiming, in any state", async () => {
    const state = await arena();
    for (const picks of [basePicks(), basePicks({ signedIn: false, eligibility: null }), basePicks({ pick: myPick(state, 1) })]) {
      const html = panel(state, picks);
      expect(text(html)).not.toMatch(/claimable|after launch|\blaunch(ed)?\b/i);
      expect(html).not.toContain("prize-launch-note");
    }
  });

  it("the explanation is two short lines — 'Correct Pick = +10 Points' and 'Free to play' — each a whole line of text", async () => {
    const state = await arena();
    const html = panel(state, basePicks());
    expect(html).toMatch(/data-testid="picks-lead"[^>]*>Correct Pick = \+10 Points<\/p>/);
    expect(html).toMatch(/data-testid="picks-free"[^>]*>Free to play<\/p>/);
    expect(html).not.toContain("inline-block"); // the old sentence-splitting hack is gone with the long sentence
  });

  it("the tiles follow the state's reward configuration, and the Arena carries no countdown for them (the Leaderboards page does)", async () => {
    const state = await arena({ ...REWARD, daily: { ...REWARD.daily, prizePool: "75,000" }, weekly: { ...REWARD.weekly, prizePool: "300,000" } });
    const html = panel(state, basePicks());
    expect(html).toMatch(/data-testid="prize-daily-amount"[^>]*>75,000</);
    expect(html).toMatch(/data-testid="prize-weekly-amount"[^>]*>300,000</);
    expect(text(html)).not.toMatch(/100,000|500,000/);
    expect(html).not.toContain('<b class="tnum">');
    expect(html).not.toContain("prize-reset");
  });
});

describe("Arena Picks panel — LOCKED the moment the current winner is decided", () => {
  it("flips to PICKS LOCKED: the selected pick stays highlighted and reads 'Locked for the next fight', and no other fighter can be chosen", async () => {
    const state = await arena();
    const decidedAt = state.current!.combatEndsAt!;
    const locked = await stateAt(decidedAt + 10);
    expect(locked.upcoming!.id).toBe(state.upcoming!.id); // the very same battle, now locked
    const out = panel(locked, basePicks({ pick: myPick(locked, 3, { locked: true }), round: { locked: true, distribution: null, outcome: null } }), { decided: true });
    const t = text(out);
    expect(t).toMatch(/Picks locked/);
    expect(t).not.toMatch(/Picks open/);
    expect(t).toMatch(/Your pick/);
    expect(t).toContain(locked.upcoming!.fighters[3]!.name);
    expect(t).toContain("Locked for the next fight.");
    expect(out).not.toContain('aria-label="Pick '); // no PICK button on anyone
    expect(out).toContain(`aria-label="${locked.upcoming!.fighters[3]!.name} is your locked pick"`);
    expect(out).toContain('data-window="LOCKED"');
    for (const f of locked.upcoming!.fighters) expect(t).toContain(f.name); // still the same eight
  });

  it("a member who did not pick is told picks are locked and when they open again", async () => {
    const state = await arena();
    const locked = await stateAt(state.current!.combatEndsAt! + 10);
    const t = text(panel(locked, basePicks(), { decided: true }));
    expect(t).toMatch(/Picks locked/);
    expect(t).toMatch(/Picks for the next fight are locked/);
  });

  it("signed-out visitors still see the LOCKED state and the eight", async () => {
    const state = await arena();
    const locked = await stateAt(state.current!.combatEndsAt! + 10);
    const t = text(panel(locked, basePicks({ signedIn: false, eligibility: null }), { decided: true }));
    expect(t).toMatch(/Picks locked/);
    expect(t).toMatch(/Sign in with Telegram to make your Pick\./);
    for (const f of locked.upcoming!.fighters) expect(t).toContain(f.name);
  });

  it("after the lock the server-provided crowd appears per fighter; before it never does — even if a stale crowd were passed in", async () => {
    const state = await arena();
    const [a, b] = state.upcoming!.fighters;
    const crowd = { total: 5, byCharacter: { [a!.characterId]: 3, [b!.characterId]: 2 } };
    const open = panel(state, basePicks({ round: { locked: false, distribution: crowd, outcome: null } }));
    expect(open).not.toContain('data-testid="crowd"');
    expect(text(open)).not.toMatch(/\d+ Picks? on the next fight/);
    const locked = await stateAt(state.current!.combatEndsAt! + 10);
    const t = text(panel(locked, basePicks({ round: { locked: true, distribution: crowd, outcome: null } }), { decided: true }));
    expect(t).toMatch(/3 Picks/);
    expect(t).toMatch(/5 Picks on the next fight/);
  });
});

describe("the panel switches to the NEXT battle the instant the current one's successor takes the stage", () => {
  it("at the boundary the picks panel lists battle C, OPEN — never battle B, who is now on stage", async () => {
    const state = await arena();
    const B = state.upcoming!;
    await advanceArena(db, arenaCtx(clock));
    clock.ms = B.startsAt;
    await advanceArena(db, arenaCtx(clock));
    const after = await stateAt(B.startsAt);
    expect(after.current!.id).toBe(B.id); // the arena shows B …
    expect(after.upcoming!.id).not.toBe(B.id); // … the panel moved on to C, in the same snapshot
    const html1 = panel(after, basePicks());
    const t = text(html1);
    for (const f of after.upcoming!.fighters) expect(t).toContain(f.name);
    for (const f of after.current!.fighters) expect(t).not.toContain(f.name); // B's heroes are NOT in the picks panel any more
    expect(html1).toContain(`data-battle="${after.upcoming!.id}"`);
    expect(html1).toContain('data-window="OPEN"');
    expect(t).toMatch(/Picks open/);
  });

  it("while its server-supplied pick window still says OPEN, a panel whose synced clock has reached the battle's own start never shows OPEN", async () => {
    const state = await arena();
    const u = state.upcoming!;
    expect(windowDisplay(u, state.serverTime)).toBe("OPEN");
    expect(windowDisplay(u, u.picks.locksAt!)).toBe("LOCKED"); // display may close EARLIER than the snapshot said …
    expect(windowDisplay({ ...u, picks: { ...u.picks, locksAt: null } }, u.startsAt)).toBe("LOCKED"); // … and a battle on stage is never a pick target
    expect(windowDisplay({ ...u, picks: { ...u.picks, status: "LOCKED" } }, 0)).toBe("LOCKED"); // … and a LOCKED snapshot is never shown as OPEN (the server wins)
    expect(windowDisplay(null, 0)).toBeNull();
    expect(secondsUntilLock(u, u.picks.locksAt! - 4200)).toBe(5);
    expect(secondsUntilLock(u, u.picks.locksAt!)).toBeNull();
  });

  it("while the next battle is being prepared the panel says so calmly (an empty roster, no stale fighters)", async () => {
    const state = await arena();
    const none: ArenaStateDto = { ...state, upcoming: null };
    const out = panel(none, basePicks());
    expect(text(out)).toMatch(/Preparing next fight/);
    expect(out).not.toContain('aria-label="Pick ');
    for (const f of state.current!.fighters) expect(text(out)).not.toContain(f.name);
  });
});

describe("how your earlier pick turned out (the fight now on stage)", () => {
  const withStage = async () => {
    const state = await arena();
    const onStage = state.current!.fighters;
    return { state, onStage, winner: onStage[0]!, other: onStage[1]! };
  };
  const earlier = (battleId: string, characterId: string, over: Partial<NonNullable<PicksApi["pick"]>> = {}) => ({ battleId, characterId, submittedAt: 1, changedCount: 0, locked: true, result: null, rewardGold: 0, rewardEligible: true, ...over });

  it("while the fight is on: 'Your pick · fighting now' with the name; no result yet", async () => {
    const { state, other } = await withStage();
    const out = panel(state, basePicks({ current: { pick: earlier(state.current!.id, other.characterId), round: null } }));
    expect(text(out)).toMatch(/Your pick · fighting now/);
    expect(text(out)).toContain(other.name);
    expect(out).toContain('data-state="fighting"');
    expect(out).not.toContain('data-state="correct"');
    expect(out).not.toContain('data-state="incorrect"');
  });

  it("CORRECT: the winner and the Clank Points — EVERY correct pick earns +10 (no cap note, however many picks the member has made today)", async () => {
    const { state, winner } = await withStage();
    const pick = earlier(state.current!.id, winner.characterId, { result: "CORRECT" });
    const scored = panel(state, basePicks({ current: { pick, round: { locked: true, distribution: null, outcome: { result: "CORRECT", winnerCharacterId: winner.characterId, points: 10, board: { points: 10 }, pending: false } } } }), { decided: true });
    const t = text(scored);
    expect(t).toMatch(/Correct/);
    expect(t).toContain(`Your pick ${winner.name}`);
    expect(t).toContain(`Winner ${winner.name}`);
    expect(t).toContain("+10 Points");
    expect(t).not.toMatch(/first 20|each day count|past the daily limit/i);
    expect(t).not.toMatch(BETTING_WORDS);
    expect(t).not.toMatch(OBSOLETE_COPY);
    // the 21st / 100th / 101st pick of the day reads exactly like the first: nothing is "beyond the limit" any more
    const late = text(panel(state, basePicks({ current: { pick, round: { locked: true, distribution: null, outcome: { result: "CORRECT", winnerCharacterId: winner.characterId, points: 10, board: { points: 10 }, pending: false } } } }), { decided: true }));
    expect(late).toContain("+10 Points");
    expect(late).not.toMatch(/first 20|each day count|limit/i);
  });

  it("NOT THIS TIME: never 'you lost' — your pick, the winner, +0 Points, pick again on the next fight", async () => {
    const { state, winner, other } = await withStage();
    const t = text(panel(state, basePicks({
      current: { pick: earlier(state.current!.id, other.characterId, { result: "INCORRECT" }), round: { locked: true, distribution: null, outcome: { result: "INCORRECT", winnerCharacterId: winner.characterId, points: 0, board: null, pending: false } } },
    }), { decided: true }));
    expect(t).toMatch(/Not this time/);
    expect(t).toContain(`Your pick ${other.name}`);
    expect(t).toContain(`Winner ${winner.name}`);
    expect(t).toMatch(/\+0 Points/);
    expect(t).toMatch(/Pick again on the next fight/);
    expect(t).not.toMatch(/\blost\b|\bloss\b|you lose/i);
  });

  it("still being credited, and a cancelled fight, are handled calmly; no pick → no result block at all", async () => {
    const { state, other } = await withStage();
    const pick = earlier(state.current!.id, other.characterId);
    expect(text(panel(state, basePicks({ current: { pick, round: { locked: true, distribution: null, outcome: { result: "CORRECT", winnerCharacterId: other.characterId, points: 0, board: null, pending: true } } } }), { decided: true }))).toMatch(/Settling your pick/);
    expect(text(panel(state, basePicks({ current: { pick, round: { locked: true, distribution: null, outcome: { result: "VOID", winnerCharacterId: null, points: 0, board: null, pending: false } } } }), { decided: true }))).toMatch(/cancelled/);
    const none = panel(state, basePicks(), { decided: true });
    expect(none).not.toContain('data-testid="onstage-pick"');
  });
});
