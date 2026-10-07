import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArenaPicksView } from "@/components/rewards/ArenaPicksPanel";
import { HolderBonusCard, formatHeld } from "@/components/rewards/HolderBonusCard";
import type { BonusStatusDto, HolderCardDto, RewardsPayload, RewardsSummary } from "@/components/rewards/useRewards";

/**
 * The PROFILE side of Arena Picks (stats, points, holder bonus, rewards, claims), server-rendered from fixtures. The Arena Picks PANEL
 * on the Arena page (the upcoming eight, the lock, how your earlier pick turned out) has its own file: arena-picks-panel.test.ts.
 */
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
const BETTING_WORDS = /\b(bet|bets|betting|wager|wagering|odds|escrow|deposit|stake[sd]?|withdraw|bet pool|betting balance|you lost|winning bet|losing bet)\b/i;
const H = 3_600_000;
const D = 24 * H;
const PERIOD = { periodStartsAt: Date.parse("2026-10-05T00:00:00Z"), periodEndsAt: Date.parse("2026-10-06T00:00:00Z") };

const bonus = (over: Partial<BonusStatusDto> = {}): BonusStatusDto => ({ status: "NONE", payingBonus: null, payingTier: null, upgradingTo: null, tier: null, heldMs: 0, requiredMs: D, eligibleFrom: null, brokenAt: null, ...PERIOD, ...over });
const TIERS = [["FREE", "0", 0], ["100K", "100,000", 500], ["500K", "500,000", 1000], ["1M", "1,000,000", 1500], ["5M", "5,000,000", 2000], ["10M", "10,000,000", 2500]].map(([label, minimum, bps], index) => ({
  index, label: label as string, name: index === 0 ? "FREE" : `${label} HOLDER`, minimum: minimum as string, bonusBps: bps as number, bonus: `+${(bps as number) / 100}%`,
}));
const FREE_CARD: HolderCardDto = {
  launched: true, available: true, walletConnected: false, wallet: { short: null }, tier: { index: 0, name: "FREE", label: "FREE", bonusBps: 0, bonus: "+0%" }, verificationNeeded: false, balance: null, balanceVerifiedAt: null,
  nextTier: { name: "100K HOLDER", label: "100K", minimum: "100,000", bonus: "+5%" }, daily: bonus(), weekly: bonus({ requiredMs: 7 * D }), tiers: TIERS, maxBonus: "+25%", symbol: "$CLANKRPG",
};
const HOLDER_CARD: HolderCardDto = {
  ...FREE_CARD, walletConnected: true, wallet: { short: "0x1234…ABCD" }, tier: { index: 3, name: "1M HOLDER", label: "1M", bonusBps: 1500, bonus: "+15%" }, balance: "1,284,500", balanceVerifiedAt: 1,
  nextTier: { name: "5M HOLDER", label: "5M", minimum: "5,000,000", bonus: "+20%" },
  daily: bonus({ status: "QUALIFIED", payingBonus: "+15%", payingTier: "1M", tier: "1M", heldMs: 3 * D }),
  weekly: bonus({ status: "QUALIFYING", tier: "1M", heldMs: 5 * D + 7 * H, requiredMs: 7 * D, eligibleFrom: Date.parse("2026-10-12T00:00:00Z") }),
};
const RULES = (kind: "DAILY" | "WEEKLY") => ({
  kind, minimumPicks: kind === "DAILY" ? 20 : 100, pointsPerCorrectPick: 10, prizePool: kind === "DAILY" ? "100,000" : "500,000", prizePoolPlain: kind === "DAILY" ? "100000" : "500000", symbol: "$CLANKRPG", topRewarded: 10,
  prizes: [], prizesPaused: false, holderBonuses: [],
});
const summary = (over: Partial<RewardsSummary> = {}): RewardsSummary => ({
  symbol: "$CLANKRPG", claimable: "42,500", pending: "0", claimed: "120,000", totalEarned: "162,500", minimumClaim: "10,000", belowMinimum: false, claimsAvailable: true, claimsNote: null,
  holderWallet: { short: null }, pendingClaim: null, claimHistory: [], latestRewards: [],
  boards: { daily: RULES("DAILY"), weekly: RULES("WEEKLY") },
  periodStats: {
    daily: { kind: "DAILY", start: "2026-10-05", endsAt: Date.parse("2026-10-06T00:00:00Z"), picks: 47, correct: 28, accuracy: 59.6, points: 280, rank: 4, prizeEligible: true, picksToEligible: 0, minimumPicks: 20 },
    weekly: { kind: "WEEKLY", start: "2026-10-05", endsAt: Date.parse("2026-10-12T00:00:00Z"), picks: 83, correct: 51, accuracy: 61.4, points: 510, rank: 9, prizeEligible: false, picksToEligible: 17, minimumPicks: 100 },
  },
  eligibility: { eligible: true, reason: null, explanation: "Members with 50+ qualifying messages in the official Clank.trade community can participate in rewarded Arena Picks." },
  holder: FREE_CARD,
  points: { dayStart: "2026-10-05", dayEndsAt: Date.parse("2026-10-06T00:00:00Z"), weekStart: "2026-10-05", weekEndsAt: Date.parse("2026-10-12T00:00:00Z"), today: 80, weekly: 120, lifetime: 940 }, ...over,
});
const view = (rewards: RewardsSummary, over: Partial<RewardsPayload> = {}, note: string | null = null) =>
  text(renderToStaticMarkup(createElement(ArenaPicksView, {
    data: { rewards, stats: { totalPicks: 12, correctPicks: 5, accuracy: 42, currentStreak: 2, bestStreak: 4 }, history: [], freshAuthMinutes: 15, ...over }, note, onClaim: () => undefined,
  })));

const CLAIM = (status: "PENDING" | "SENT" | "DENIED", extra: Partial<NonNullable<RewardsSummary["pendingClaim"]>> = {}): NonNullable<RewardsSummary["pendingClaim"]> =>
  ({ id: `c-${status}`, status, amount: "10,000", destination: "0x1234…abcd", destinationKind: "CUSTOM", txHash: null, txShort: null, requestedAt: Date.UTC(2026, 9, 5, 12), denial: null, ...extra });

describe("Profile → Arena Picks", () => {
  it("shows stats, the DAILY and WEEKLY leaderboard stats (Picks · Correct · Accuracy · Points · Current rank — no per-day cap counter), the four reward amounts with the CLAIM button — and none of the betting vocabulary", () => {
    const t = view(summary({ pending: "10,000" }));
    expect(t).toMatch(/Accuracy 42%/);
    expect(t).toMatch(/Correct picks 5/);
    expect(t).toMatch(/Total picks 12/);
    expect(t).toMatch(/Current streak 2/);
    expect(t).toMatch(/Best streak 4/);
    expect(t).toMatch(/Daily Picks 47 Correct 28 Accuracy 59\.6% Points 280 Current rank #4/);
    expect(t).toMatch(/Weekly Picks 83 Correct 51 Accuracy 61\.4% Points 510 Current rank #9/);
    expect(t).toMatch(/Lifetime Clank Points 940/);
    expect(t).not.toMatch(/Scored Picks today|\d+ \/ 20|first 20/i); // the per-day cap is gone from every word on the page
    expect(t).toMatch(/Free and unlimited[\s\S]*nothing is paid per battle/); // no per-battle token anywhere
    expect(t).toMatch(/Claimable 42,500 \$CLANKRPG Pending 10,000 \$CLANKRPG Sent 120,000 \$CLANKRPG Total earned 162,500 \$CLANKRPG/);
    expect(t).toMatch(/Claim rewards/);
    expect(t).not.toMatch(/Reward wallet|Change wallet/); // the pasted reward wallet is gone: destinations are per claim
    expect(t).not.toMatch(BETTING_WORDS);
  });

  it("says EVERY valid pick counts toward the Daily and Weekly boards (a race for the most correct Picks), the minimum comes from the server's rules, and a member under it is told how many more picks make them prize eligible", () => {
    const t = view(summary());
    expect(t).toMatch(/Every valid Pick counts\. A correct Pick earns 10 Points/);
    expect(t).toMatch(/a race for the most correct Picks/);
    expect(t).toMatch(/Weekly[\s\S]*Not yet prize eligible — 17 more Picks needed \(100 this week\)/);
    expect(t).not.toMatch(/Daily[\s\S]{0,260}Not yet prize eligible — \d+ more Picks needed \(20 this day\)/); // the daily member is already eligible
    const custom = view(summary({ periodStats: { ...summary().periodStats, daily: { ...summary().periodStats.daily, prizeEligible: false, picksToEligible: 1, minimumPicks: 20, picks: 19 } } }));
    expect(custom).toMatch(/Not yet prize eligible — 1 more Pick needed \(20 this day\)/);
  });

  it("LATEST REWARDS: Daily, Weekly and Holder Bonus are separate lines — \"DAILY #1 +30,000\", \"10M HOLDER BONUS +7,500\", \"WEEKLY #4 +50,000\"", () => {
    const t = view(summary({ latestRewards: [
      { kind: "DAILY_LEADERBOARD", label: "DAILY #1", board: "Daily", period: "2026-10-06", amount: "30,000", at: Date.UTC(2026, 9, 7, 0, 0, 5) },
      { kind: "HOLDER_BONUS", label: "10M HOLDER BONUS", board: "Daily", period: "2026-10-06", amount: "7,500", at: Date.UTC(2026, 9, 7, 0, 0, 5) },
      { kind: "WEEKLY_LEADERBOARD", label: "WEEKLY #4", board: "Weekly", period: "2026-09-28", amount: "50,000", at: Date.UTC(2026, 9, 5, 0, 0, 5) },
    ] }));
    expect(t).toMatch(/Latest rewards DAILY #1 2026-10-06 \+30,000 \$CLANKRPG 10M HOLDER BONUS 2026-10-06 \+7,500 \$CLANKRPG WEEKLY #4 week of 2026-09-28 \+50,000 \$CLANKRPG/);
    expect(view(summary())).toMatch(/Place in the Top 10 of a Daily or Weekly Arena Picks board and your prize shows up here\./);
  });

  it("CLAIM HISTORY: PENDING, SENT (with the short transaction and a VIEW TX link when an explorer is configured) and DENIED (with the safe reason)", () => {
    const rewards = summary({
      claimHistory: [
        CLAIM("PENDING"),
        CLAIM("SENT", { amount: "25,000", destination: "0x34ab…cdef", destinationKind: "HOLDER_WALLET", txHash: `0x${"cd".repeat(32)}`, txShort: "0xcdcd…cdcd" }),
        CLAIM("DENIED", { amount: "5,000", denial: { label: "Invalid wallet", message: "That wallet address couldn't be used. Your rewards are back in your claimable balance." } }),
      ],
    });
    const plain = view(rewards);
    expect(plain).toMatch(/Claim history 10,000 \$CLANKRPG Pending Oct 5 0x1234…abcd/);
    expect(plain).toMatch(/25,000 \$CLANKRPG Sent Oct 5 0x34ab…cdef 0xcdcd…cdcd/);
    expect(plain).toMatch(/5,000 \$CLANKRPG Denied/);
    expect(plain).toMatch(/Reason: Invalid wallet — That wallet address couldn't be used/);
    expect(plain).not.toMatch(/View tx/); // no explorer configured → no link is invented
    const withExplorer = renderToStaticMarkup(createElement(ArenaPicksView, { data: { rewards, stats: { totalPicks: 1, correctPicks: 1, accuracy: 100, currentStreak: 1, bestStreak: 1 }, history: [], freshAuthMinutes: 15 }, note: null, onClaim: () => undefined, token: { launched: true, configured: true, symbol: "$CLANKRPG", address: "0x00000000000000000000000000000000000c1a4c", chainId: 4663, explorerTxUrl: "https://explorer.example/tx/{hash}", buyUrl: "https://clank.trade/0x00000000000000000000000000000000000c1a4c" } }));
    expect(withExplorer).toContain(`href="https://explorer.example/tx/0x${"cd".repeat(32)}"`);
    expect(text(withExplorer)).toMatch(/View tx/);
    expect(withExplorer).toContain('rel="noopener noreferrer"');
    expect(text(plain)).not.toMatch(/fraud|suspicious|risk score|review/i);
  });

  it("a pending claim shows its amount, destination and kind, and the claim button is off with the reserved-amount explanation", () => {
    const t = view(summary({ claimable: "0", pending: "10,000", claimsAvailable: false, claimsNote: "PENDING", pendingClaim: CLAIM("PENDING", { destinationKind: "HOLDER_WALLET", destination: "0x1234…abcd" }) }));
    expect(t).toMatch(/Pending 10,000 \$CLANKRPG → 0x1234…abcd · connected wallet/);
    expect(t).toMatch(/Your claim is waiting for a manual payout\. The reserved amount can't be claimed again\./);
  });

  it("below the minimum: the balance is shown, the minimum is explained, nothing is discarded", () => {
    const t = view(summary({ claimable: "7,500", belowMinimum: true, claimsAvailable: false, claimsNote: "BELOW_MINIMUM", totalEarned: "7,500", claimed: "0" }));
    expect(t).toMatch(/Claimable 7,500 \$CLANKRPG/);
    expect(t).toMatch(/Minimum claim: 10,000 \$CLANKRPG\. Your rewards keep accumulating — nothing is lost\./);
  });

  it("claims unavailable / held: the exact reassuring wording, and no internal reason", () => {
    expect(view(summary({ claimsAvailable: false, claimsNote: "UNAVAILABLE" }))).toContain("Claims are temporarily unavailable. Your rewards are safe and will continue accumulating.");
    const held = view(summary({ claimsAvailable: false, claimsNote: "HELD" }));
    expect(held).toMatch(/on hold for now\. Your rewards are safe/);
    expect(held).not.toMatch(/review|flag|suspend|fraud|bot/i);
  });

  it("pick history: When / Your pick / Winner / Result / Points — EVERY correct pick shows +10 (the 1st and the 101st alike), a wrong one shows 0, no battle numbers, no token amount", () => {
    const t = view(summary(), {
      history: [
        { battleId: "b1", at: Date.UTC(2026, 9, 5, 12, 0), picked: { characterId: "x", publicId: "222222222222", name: "Celsius" }, winner: { characterId: "x", publicId: "222222222222", name: "Celsius" }, result: "CORRECT", points: 10, leaderboard: { points: 10 } },
        { battleId: "b2", at: Date.UTC(2026, 9, 5, 12, 1), picked: { characterId: "y", publicId: "222222222222", name: "Leon" }, winner: { characterId: "z", publicId: "222222222222", name: "Pikachu" }, result: "INCORRECT", points: 0, leaderboard: { points: 0 } },
        { battleId: "b3", at: Date.UTC(2026, 9, 5, 12, 2), picked: { characterId: "x", publicId: "222222222222", name: "Mia" }, winner: { characterId: "x", publicId: "222222222222", name: "Mia" }, result: "CORRECT", points: 10, leaderboard: { points: 10 } },
      ],
    });
    expect(t).toMatch(/Celsius Celsius Correct \+10/);
    expect(t).toMatch(/Leon Pikachu Wrong 0/);
    expect(t).toMatch(/Mia Mia Correct \+10/); // there is no "past the daily limit": every valid correct pick scores
    expect(t).not.toMatch(/past the daily limit|scored/i);
    expect(t).not.toMatch(/\$CLANKRPG[^R]*Correct/); // no per-pick token amount
    expect(t).not.toMatch(/battle\s*#\s*\d/i);
    expect(t).not.toMatch(BETTING_WORDS);
  });

  it("pick history: a pick still waiting for its fight reads UPCOMING / FIGHTING NOW (no winner, no points) above the resolved ones", () => {
    const t = view(summary(), {
      history: [
        { battleId: "b5", at: Date.UTC(2026, 9, 5, 12, 5), picked: { characterId: "r", publicId: "222222222222", name: "Rin Okumura" }, winner: null, result: null, phase: "UPCOMING", points: 0, leaderboard: null },
        { battleId: "b4", at: Date.UTC(2026, 9, 5, 12, 4), picked: { characterId: "m", publicId: "222222222222", name: "Mia" }, winner: null, result: null, phase: "FIGHTING", points: 0, leaderboard: null },
        { battleId: "b3", at: Date.UTC(2026, 9, 5, 12, 2), picked: { characterId: "x", publicId: "222222222222", name: "Celsius" }, winner: { characterId: "x", publicId: "222222222222", name: "Celsius" }, result: "CORRECT", points: 10, leaderboard: { points: 10 } },
      ],
    });
    expect(t).toMatch(/Rin Okumura — Upcoming pick –/);
    expect(t).toMatch(/Mia — Fighting now –/);
    expect(t).toMatch(/Celsius Celsius Correct \+10/);
    expect(t.indexOf("Rin Okumura")).toBeLessThan(t.indexOf("Mia"));
    expect(t.indexOf("Mia")).toBeLessThan(t.indexOf("Celsius"));
  });

  it("an ineligible member sees the public explanation instead of rewards-they-can't-earn jargon", () => {
    const t = view(summary({ eligibility: { eligible: false, reason: "BELOW_THRESHOLD", explanation: "Members with 50+ qualifying messages in the official Clank.trade community can participate in rewarded Arena Picks." }, claimsAvailable: false, claimsNote: "NOT_ELIGIBLE" }));
    expect(t).toContain("Members with 50+ qualifying messages in the official Clank.trade community can participate in rewarded Arena Picks.");
  });
});

describe("Holder reward bonus card", () => {
  const card = (holder: HolderCardDto) => renderToStaticMarkup(createElement(HolderBonusCard, { holder, onChanged: () => undefined }));

  it("FREE: 0% bonus, the invitation to boost prizes, the full bonus ladder, a Connect Wallet button — and 'holdings NEVER affect your score or chance to rank'", () => {
    const html = card(FREE_CARD);
    const t = text(html);
    expect(t).toMatch(/Holder reward bonus FREE/);
    expect(t).toContain("0% bonus");
    expect(t).toContain("Hold $CLANKRPG to boost leaderboard prizes you earn.");
    expect(html).toContain('data-testid="connect-wallet"');
    for (const row of ["FREE 0%", "100K+ +5%", "500K+ +10%", "1M+ +15%", "5M+ +20%", "10M+ +25%"]) expect(t).toContain(row);
    expect(t).toContain("Holdings NEVER affect your Arena Picks score or chance to rank.");
    expect(t).not.toMatch(/rewarded wins|allowance|token-rewarded/i); // the old per-day allowance model is gone
    expect(t).not.toMatch(BETTING_WORDS);
  });

  it("a connected 1M holder: tier and bonus, balance, SHORT wallet, Daily QUALIFIED, Weekly QUALIFYING with its progress clock — and a Refresh button instead of Connect", () => {
    const html = card(HOLDER_CARD);
    const t = text(html);
    expect(t).toMatch(/Holder reward bonus 1M HOLDER/);
    expect(t).toContain("+15% Leaderboard Prize Bonus");
    expect(t).toMatch(/Balance 1,284,500 \$CLANKRPG/);
    expect(t).toContain("Wallet 0x1234…ABCD");
    expect(t).toMatch(/Daily bonus QUALIFIED \+15% will be added to any daily prize you earn\./);
    expect(t).toMatch(/Weekly bonus QUALIFYING Eligible for a future Weekly Holder Bonus after qualification requirements are met — from the weekly board starting Oct 12 UTC\./);
    expect(t).toMatch(/Weekly qualification progress 5D 7H \/ 7D required before the next eligible week \(week of Oct 12 UTC\) ?\./);
    expect(html).toContain('data-testid="refresh-holdings"');
    expect(html).not.toContain('data-testid="connect-wallet"');
    expect(html).toMatch(/data-active="true"[^>]*>[\s\S]*?1M\+/); // the member's tier is highlighted in the ladder
  });

  it("buying during the day: 'QUALIFYING — eligible for a future Daily Holder Bonus', never a promise for the board in progress", () => {
    const t = text(card({ ...HOLDER_CARD, tier: { index: 5, name: "10M HOLDER", label: "10M", bonusBps: 2500, bonus: "+25%" }, balance: "10,250,000", daily: bonus({ status: "QUALIFYING", tier: "10M", heldMs: 3 * H, eligibleFrom: Date.parse("2026-10-07T00:00:00Z") }) }));
    expect(t).toMatch(/10M HOLDER[\s\S]*Balance 10,250,000/);
    expect(t).toMatch(/Daily bonus QUALIFYING Eligible for a future Daily Holder Bonus after qualification requirements are met — from the daily board starting Oct 7 UTC\./);
  });

  it("a lower tier pays now while a higher one is still accumulating, BROKEN is explained without blaming the member, and a stale verification says NEEDS VERIFICATION", () => {
    const upgrading = text(card({ ...HOLDER_CARD, daily: bonus({ status: "QUALIFIED", payingBonus: "+5%", payingTier: "100K", tier: "100K", upgradingTo: { tier: "1M", bonus: "+15%", eligibleFrom: Date.parse("2026-10-08T00:00:00Z") } }) }));
    expect(upgrading).toMatch(/\+5% applies now \(100K\)\. 1M \(\+15%\) qualifies for the daily board starting Oct 8\./);
    const broken = text(card({ ...HOLDER_CARD, daily: bonus({ status: "BROKEN", tier: "1M", brokenAt: Date.parse("2026-10-05T14:00:00Z") }) }));
    expect(broken).toMatch(/Daily bonus BROKEN Your 1M holding wasn't verified without a break \(10-05 14:00 UTC\), so there is no daily bonus this period\. Your rank and base prize are not affected\./);
    const needs = text(card({ ...HOLDER_CARD, daily: bonus({ status: "NEEDS_VERIFICATION", tier: "1M" }) }));
    expect(needs).toMatch(/Daily bonus NEEDS VERIFICATION We couldn't verify your holdings recently, so nothing is assumed\. Refresh your holdings\./);
  });

  it("unavailable holder checks are explained plainly and Connect is off; the pending-verification banner is reassuring with a Refresh button and never blames the member", () => {
    const off = card({ ...FREE_CARD, available: false });
    expect(text(off)).toMatch(/Holder benefits aren't available yet\. Arena Picks, Points and the leaderboards work exactly as before\./);
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*data-testid="connect-wallet"/);
    const stale = card({ ...HOLDER_CARD, verificationNeeded: true, daily: bonus({ status: "NEEDS_VERIFICATION", tier: "1M" }) });
    const t = text(stale);
    expect(t).toMatch(/Holdings verification needed/i);
    expect(t).toContain("We couldn't refresh your $CLANKRPG balance, so no holder bonus is assumed for now. Your wallet and everything you've earned are safe.");
    expect(stale).toContain('data-testid="verification-refresh"');
    expect(t).not.toMatch(/fraud|suspicious|risk|banned|removed/i);
    expect(text(card(HOLDER_CARD))).not.toMatch(/Holdings verification needed/i);
    expect(text(card(FREE_CARD))).not.toMatch(/Holdings verification needed/i);
  });

  it("explains the rule honestly: the bonus is extra, needs continuity before AND during the period, and buying during a leaderboard grants nothing instant", () => {
    const t = text(card(HOLDER_CARD));
    expect(t).toMatch(/added to a Daily or Weekly prize you have already earned and never reduces anyone else's/);
    expect(t).toMatch(/24 hours \(Daily\) or 7 days \(Weekly\) before the period starts, and until it ends/);
    expect(t).toMatch(/buying tokens during a leaderboard does not grant an instant bonus/);
  });

  it("the OFFICIAL contract shown here comes from the server's token config (a prop) — the component has no address of its own", () => {
    const withToken = renderToStaticMarkup(createElement(HolderBonusCard, { holder: FREE_CARD, onChanged: () => undefined, token: { launched: true, configured: true, symbol: "$CLANKRPG", address: "0x52908400098527886e0f7030069857d2e4169ee7", chainId: 4663, explorerTxUrl: null, buyUrl: "https://clank.trade/0x52908400098527886e0f7030069857d2e4169ee7" } }));
    expect(text(withToken)).toContain("Official $CLANKRPG contract: 0x52908400098527886e0f7030069857d2e4169ee7");
    expect(text(card(FREE_CARD))).not.toMatch(/Official \$CLANKRPG contract/); // no token config → no contract line, never a fallback
  });

  it("the ladder is a wrapping grid of tiles (readable at 320 px), never a wide table", () => {
    const html = card(FREE_CARD);
    expect(html).toMatch(/<ul[^>]*grid-cols-2[^>]*data-testid="holder-ladder"/);
    expect(html).not.toMatch(/<table/);
  });

  it("durations read as the spec shows them: 5D 7H, 7D, 6H 12M", () => {
    expect(formatHeld(5 * D + 7 * H)).toBe("5D 7H");
    expect(formatHeld(7 * D)).toBe("7D");
    expect(formatHeld(6 * H + 12 * 60_000)).toBe("6H 12M");
    expect(formatHeld(0)).toBe("0H 0M"); // never a bare "0M" — that reads like "0 million"
    expect(formatHeld(12 * 60_000)).toBe("0H 12M");
  });
});
