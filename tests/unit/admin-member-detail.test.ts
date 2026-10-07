import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemberDetail } from "@/components/admin/ArenaPicksAdmin";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

/** The shape rewards/admin.ts `getAccountDetail` returns (admin-only). */
const detail = {
  identity: { telegramUserId: 4242, displayName: "Ada", username: "ada_l", telegramStatus: "OK", flagReason: null, firstSeenAt: "2026-10-01T10:00:00.000Z", qualifyingMessages: 187 },
  hero: { id: "h1", name: "Ada the Bold", classId: "ranger", status: "ACTIVE" },
  holder: {
    wallet: "0x671e0c798730cd5d07f9f6024f6b7b86e78e0e18", walletVerifiedAt: "2026-10-04T10:00:00.000Z",
    verifiedBalance: "1,284,500", observedTier: "1M HOLDER", balanceVerifiedAt: "2026-10-05T10:00:00.000Z",
    lastCheckAt: "2026-10-05T10:00:00.000Z", nextCheckAt: "2026-10-06T10:00:00.000Z", checkFailures: 0, lastError: null, stale: false,
    daily: { status: "QUALIFIED", tier: "1M", since: "2026-10-02T10:00:00.000Z", heldMs: 259200000, brokenAt: null, brokenBy: null },
    weekly: { status: "QUALIFYING", tier: "1M", since: "2026-10-01T10:00:00.000Z", heldMs: 345600000, brokenAt: null, brokenBy: null },
    observations: [{ source: "RPC", balance: "1,284,500", at: "2026-10-05T10:00:00.000Z", wallet: "0x671e0c798730cd5d07f9f6024f6b7b86e78e0e18" }],
  },
  points: { today: 70, weekly: 120, lifetime: 480, picksToday: 47, picksThisWeek: 83, weekStart: "2026-10-05", weekEndsAt: 1791763200000 },
  picks: { total: 40, correct: 12, accuracy: 30 },
  rewards: { claimable: "42,500", reserved: "0", claimed: "120,000", earned: "162,500" },
  boards: [{ kind: "DAILY", period: "2026-10-04", rank: 1, points: 70, base: "30,000", baseStatus: "CREDITED", bonus: "0", bonusStatus: "NONE", bonusTier: null, bonusPercent: null }],
  review: { state: "NORMAL", reason: null, by: null, at: null, walletException: false },
};

describe("admin member reward detail (requirement 34)", () => {
  const html = renderToStaticMarkup(createElement(MemberDetail, { detail }));
  const t = text(html);

  it("shows every field the admin needs, labelled — not a JSON dump", () => {
    for (const label of [
      "Telegram id", "Display name", "Qualifying messages", // Telegram identity
      "Name", "Class", // Hero
      "Verified wallet", "Wallet verified", "Balance (last read)", "Observed tier", "Last verified", "Next verification", // Holder state
      "Daily bonus", "Weekly bonus", // Holder qualification
      "Today's Points", "Weekly Points", "Lifetime Clank Points", "Picks today", "Picks this week", "Accuracy", // Points & picks
      "Claimable", "Claimed", "Total earned", // Rewards
      "Review state", "Wallet exception", // Risk
      "Recent board results", "Latest balance observations", // Admin evidence
    ]) expect(t, label).toContain(label);
    expect(t).not.toMatch(/[{}]|\"identity\"|telegramUserId/);
  });

  it("renders the real values: verified tier and balance, bonus qualification, Points, accuracy, claimable/claimed", () => {
    expect(t).toContain("1M HOLDER");
    expect(t).toContain("1,284,500");
    expect(t).toMatch(/Daily bonus QUALIFIED · 1M/);
    expect(t).toMatch(/Weekly bonus QUALIFYING · 1M/);
    expect(t).toMatch(/Today's Points 70/);
    expect(t).toMatch(/Picks today 47/);
    expect(t).toMatch(/Picks this week 83/);
    expect(t).toMatch(/Weekly Points 120/);
    expect(t).not.toMatch(/Scored picks|\/ 20/); // no per-day cap counter anywhere
    expect(t).toMatch(/Accuracy 30%/);
    expect(t).toContain("42,500");
    expect(t).toContain("120,000");
    expect(t).toMatch(/DAILY 2026-10-04 · #1 · 70 pts · base 30,000/);
    expect(t).toMatch(/RPC 1,284,500/);
    expect(t).toContain("0x671e0c798730cd5d07f9f6024f6b7b86e78e0e18"); // admin sees the FULL wallet (players only ever see the short form)
  });

  it("tolerates a member with no wallet, no observations and no hero (FREE, never connected)", () => {
    const bare = { identity: { telegramUserId: 7, displayName: "Zed" }, hero: null, holder: { wallet: null, walletVerifiedAt: null, verifiedBalance: null, observedTier: "FREE", balanceVerifiedAt: null, lastCheckAt: null, nextCheckAt: null, checkFailures: 0, lastError: null, stale: false, daily: null, weekly: null, observations: [] }, points: { today: 0, weekly: 0, lifetime: 0, scoredPicksToday: 0, scoredLimitPerDay: 20, scoredPicksThisWeek: 0 }, picks: { total: 0, correct: 0, accuracy: null }, rewards: { claimable: "0", reserved: "0", claimed: "0", earned: "0" }, boards: [], review: { state: "NORMAL", reason: null, walletException: false } };
    const b = text(renderToStaticMarkup(createElement(MemberDetail, { detail: bare })));
    expect(b).toContain("FREE");
    expect(b).toMatch(/Verified wallet –/);
    expect(b).not.toContain("Latest balance observations"); // nothing to show
    expect(b).not.toMatch(/undefined|null|NaN/);
  });

  it("wraps on a phone: single column below md, and long values break instead of overflowing", () => {
    expect(html).toContain("grid-cols-1");
    expect(html).toContain("break-all");
  });
});
