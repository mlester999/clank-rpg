import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PayoutView } from "@/components/admin/ArenaPicksBoards";
import { PAYOUT_CLAIM_STATUSES, type PayoutDto, type PayoutRowDto } from "@/domain/rewards/payout";

/** The Admin payout summary + table, server-rendered from a fixture: what an operator reads to pay a board by hand. */
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const row = (rank: number, over: Partial<PayoutRowDto> = {}): PayoutRowDto => ({
  rank, tied: false, telegramUserId: 9000 + rank, hero: `Hero ${rank}`, correctPicks: 20 - rank, picks: 24, accuracy: 59.6, points: (20 - rank) * 10,
  basePrize: "30,000", basePrizePlain: "30000", holderTier: null, bonusPercent: null, holderBonus: "0", holderBonusPlain: "0", totalReward: "30,000", totalRewardPlain: "30000",
  baseStatus: "CREDITED", bonusStatus: "NONE", claimStatus: "UNCLAIMED", wallet: null, walletSource: null, txHash: null, ...over,
});
const dto = (rows: PayoutRowDto[], over: Partial<PayoutDto["summary"]> = {}): PayoutDto => ({
  summary: {
    kind: "DAILY", start: "2026-10-07", finalizedAt: 1, symbol: "$CLANKRPG", basePool: "100,000", baseAwarded: "100,000", returnedToReserve: "0", maxBonusPercent: "+25%", holderBonuses: "7,500", totalPayout: "107,500", totalPayoutPlain: "107500",
    heldForReview: "0", forfeited: "0", bonusesPending: 0, bonusesPendingMaximum: "0", prizeWinners: rows.length,
    byStatus: { ...(Object.fromEntries(PAYOUT_CLAIM_STATUSES.map((s) => [s, "0"])) as PayoutDto["summary"]["byStatus"]), UNCLAIMED: "70,000", SENT: "37,500" }, ...over,
  },
  rows,
});
const view = (p: PayoutDto, kind: "DAILY" | "WEEKLY" = "DAILY") => renderToStaticMarkup(createElement(PayoutView, { payout: p, kind, start: p.summary.start, onCopy: () => undefined }));

describe("Admin payout summary", () => {
  const p = dto([
    row(1, { holderTier: "10M", bonusPercent: "+25%", holderBonus: "7,500", totalReward: "37,500", claimStatus: "SENT", wallet: "0x52908400098527886e0f7030069857d2e4169ee7", txHash: `0x${"ab".repeat(32)}` }),
    row(2, { basePrize: "20,000", totalReward: "20,000", tied: true }),
    row(3, { basePrize: "15,000", totalReward: "15,000", claimStatus: "PENDING", wallet: "0x8617e340b3d01fa5f11f306f4090fd50e238070d" }),
  ]);

  it("leads with Base prize pool, Holder bonuses and TOTAL PAYOUT — the exact amount to send", () => {
    const t = text(view(p));
    expect(t).toMatch(/Daily payout summary/);
    expect(t).toMatch(/Base prize pool 100,000 \$CLANKRPG 100,000 awarded · 0 back to the reserve/);
    expect(t).toMatch(/Holder bonuses 7,500 \$CLANKRPG qualified · up to \+25%/);
    expect(t).toMatch(/TOTAL PAYOUT 107,500 \$CLANKRPG exactly what to send · 3 winners/);
    expect(t).toMatch(/unclaimed 70,000 sent 37,500/); // only non-zero statuses
  });

  it("the table has every column: rank, player, correct picks, total picks, accuracy, points, base prize, holder tier, bonus %, bonus, total, claim status, wallet / tx", () => {
    const html = view(p);
    const t = text(html);
    for (const h of ["Rank", "Player", "Correct", "Picks", "Accuracy", "Points", "Base prize", "Holder tier", "Bonus %", "Bonus", "Total to send", "Status", "Wallet / tx"]) expect(t, h).toContain(h);
    expect(t).toMatch(/#1 Hero 1 tg 9001 19 24 59\.6% 190 30,000 10M \+25% 7,500 37,500 SENT 0x5290…9ee7 tx 0xabababab…/);
    expect(t).toMatch(/#2 TIE Hero 2 tg 9002 18 24 59\.6% 180 20,000 – – 0 20,000 UNCLAIMED/);
    expect(t).toMatch(/#3 Hero 3 tg 9003 17 24 59\.6% 170 15,000 – – 0 15,000 PENDING/);
    expect(html).toContain('data-testid="payout-table"');
    expect(html).toContain('data-testid="payout-cards"'); // the same rows as stacked cards on a narrow screen
    expect(html.match(/data-testid="payout-status"/g)).toHaveLength(6); // table + cards
  });

  it("offers COPY PAYOUT SUMMARY and EXPORT CSV (a plain download link to the admin-only route)", () => {
    const html = view(p);
    expect(html).toContain('data-testid="copy-payout"');
    expect(html).toContain('href="/api/admin/picks/boards/DAILY/2026-10-07/payout?format=csv"');
    expect(html).toContain("download");
    expect(text(html)).toMatch(/Copy payout summary Export CSV/);
  });

  it("the weekly view is labelled Weekly and uses its own start date", () => {
    const w = dto([row(1)], { kind: "WEEKLY", start: "2026-10-12", basePool: "500,000", baseAwarded: "500,000", holderBonuses: "0", totalPayout: "500,000" });
    const html = view(w, "WEEKLY");
    expect(text(html)).toMatch(/Weekly payout summary/);
    expect(text(html)).toMatch(/TOTAL PAYOUT 500,000 \$CLANKRPG/);
    expect(html).toContain("/api/admin/picks/boards/WEEKLY/2026-10-12/payout?format=csv");
  });

  it("states a hold or a pending bonus plainly, and never shows anti-fraud internals", () => {
    const flagged = dto([row(1, { claimStatus: "HELD", baseStatus: "HELD" })], { heldForReview: "30,000", bonusesPending: 2, bonusesPendingMaximum: "15,000" });
    const t = text(view(flagged));
    expect(t).toMatch(/30,000 of the total is held for review — send it only after the prize is released\./);
    expect(t).toMatch(/2 holder bonus\(es\) are still pending verification and are not in the total \(at most 15,000 more\)\./);
    expect(t).toContain("HELD");
    expect(t).not.toMatch(/evidence|continuity|observation|fraud|suspicious|balance/i);
  });

  it("a board nobody earned a prize on says so instead of rendering an empty table", () => {
    const html = view(dto([], { basePool: "100,000", baseAwarded: "0", returnedToReserve: "100,000", holderBonuses: "0", totalPayout: "0" }));
    expect(text(html)).toMatch(/Nobody earned a prize on this board\./);
    expect(html).not.toContain('data-testid="payout-table"');
  });
});
