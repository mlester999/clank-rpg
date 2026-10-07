import { describe, expect, it } from "vitest";

import { csvCell, PAYOUT_CLAIM_STATUSES, PAYOUT_CSV_COLUMNS, payoutCsv, payoutSummaryText, type PayoutDto, type PayoutRowDto } from "@/domain/rewards/payout";

/** The pure formatters behind COPY PAYOUT SUMMARY and EXPORT CSV (the server computes the numbers; these only print them). */
const row = (rank: number, over: Partial<PayoutRowDto> = {}): PayoutRowDto => ({
  rank, tied: false, telegramUserId: 9000 + rank, hero: `Hero ${rank}`, correctPicks: 20 - rank, picks: 24, accuracy: 70.8, points: 190,
  basePrize: "30,000", basePrizePlain: "30000", holderTier: null, bonusPercent: null, holderBonus: "0", holderBonusPlain: "0", totalReward: "30,000", totalRewardPlain: "30000",
  baseStatus: "CREDITED", bonusStatus: "NONE", claimStatus: "UNCLAIMED", wallet: null, walletSource: null, txHash: null, ...over,
});
const dto = (rows: PayoutRowDto[]): PayoutDto => ({
  summary: {
    kind: "DAILY", start: "2026-10-07", finalizedAt: 1, symbol: "$CLANKRPG", basePool: "100,000", baseAwarded: "100,000", returnedToReserve: "0", maxBonusPercent: "+25%", holderBonuses: "7,500", totalPayout: "107,500", totalPayoutPlain: "107500",
    heldForReview: "0", forfeited: "0", bonusesPending: 0, bonusesPendingMaximum: "0", prizeWinners: rows.length, byStatus: Object.fromEntries(PAYOUT_CLAIM_STATUSES.map((s) => [s, "0"])) as PayoutDto["summary"]["byStatus"],
  },
  rows,
});

describe("csvCell", () => {
  it("passes plain text and numbers through, and escapes quotes, commas and line breaks (RFC 4180)", () => {
    expect(csvCell("Hero")).toBe("Hero");
    expect(csvCell(30000)).toBe("30000");
    expect(csvCell("21666.666666666666666666")).toBe("21666.666666666666666666");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("neutralises anything a spreadsheet would run as a formula — hero names are player-controlled", () => {
    for (const evil of ['=HYPERLINK("http://x")', "+SUM(A1)", "-2+3", "@cmd", "\tTAB", "\rCR"]) expect(csvCell(evil).replace(/^"/, "").startsWith("'"), evil).toBe(true);
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-5")).toBe("-5"); // a plain number is data, not a formula
  });
});

describe("payoutCsv", () => {
  it("writes the documented header and one CRLF line per winner, with plain amounts and the bonus percent as a number", () => {
    expect(PAYOUT_CSV_COLUMNS.join(",")).toBe("period_type,period_start,rank,telegram_id,hero,wallet,base_prize,holder_tier,holder_bonus_percent,holder_bonus,total_reward,claim_status,tx_hash");
    const csv = payoutCsv(dto([
      row(1, { holderTier: "10M", bonusPercent: "+25%", holderBonus: "7,500", holderBonusPlain: "7500", totalReward: "37,500", totalRewardPlain: "37500", wallet: "0xabc", claimStatus: "SENT", txHash: "0xdef" }),
      row(2, { hero: "=EVIL()", basePrize: "20,000", basePrizePlain: "20000", totalRewardPlain: "20000" }),
    ]));
    expect(csv.split("\r\n")).toEqual([
      "period_type,period_start,rank,telegram_id,hero,wallet,base_prize,holder_tier,holder_bonus_percent,holder_bonus,total_reward,claim_status,tx_hash",
      "DAILY,2026-10-07,1,9001,Hero 1,0xabc,30000,10M,25,7500,37500,SENT,0xdef",
      "DAILY,2026-10-07,2,9002,'=EVIL(),,20000,,,0,20000,UNCLAIMED,",
      "",
    ]);
  });
  it("has no column for anything from the review / anti-fraud side", () => {
    expect(PAYOUT_CSV_COLUMNS.join(" ")).not.toMatch(/evidence|review|hold_reason|balance|observ|flag|reason|continuity/i);
  });
});

describe("payoutSummaryText", () => {
  it("leads with Base Prize Pool, Holder Bonuses and TOTAL PAYOUT, then one line per winner (ties and tx hashes shown)", () => {
    const text = payoutSummaryText(dto([
      row(1, { holderTier: "10M", bonusPercent: "+25%", holderBonus: "7,500", totalReward: "37,500", wallet: "0xabc", claimStatus: "SENT", txHash: "0xdef" }),
      row(2, { tied: true }), row(2, { tied: true, telegramUserId: 9999, hero: "Tie" }),
    ]));
    const lines = text.split("\n");
    expect(lines[0]).toBe("DAILY PAYOUT SUMMARY — 2026-10-07 (UTC)");
    expect(text).toMatch(/Base Prize Pool\s+100,000 \$CLANKRPG/);
    expect(text).toMatch(/Holder Bonuses\s+7,500 \$CLANKRPG/);
    expect(text).toMatch(/TOTAL PAYOUT\s+107,500 \$CLANKRPG/);
    expect(text).toContain("#1  Hero 1 (tg 9001)  30,000 + 7,500 (10M +25%) = 37,500  [SENT]  → 0xabc  tx 0xdef");
    expect(text).toContain("#2 (tie)  Hero 2 (tg 9002)");
    expect(text).toContain("#2 (tie)  Tie (tg 9999)");
  });
  it("the weekly statement says 'week of'", () => {
    const d = dto([row(1)]);
    d.summary.kind = "WEEKLY";
    expect(payoutSummaryText(d)).toMatch(/^WEEKLY PAYOUT SUMMARY — week of 2026-10-07 \(UTC\)/);
  });
});
