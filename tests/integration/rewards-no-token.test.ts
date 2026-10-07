import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buyUrl } from "@/domain/rewards/buyLink";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { HolderBonusCard } from "@/components/rewards/HolderBonusCard";
import { resetEnvCache } from "@/server/env";
import { boardPayout, rewardsOverview, reconcileRewards, tokenAdminStatus } from "@/server/rewards/admin";
import { requestClaim } from "@/server/rewards/claims";
import { getChainReader, getTokenStatus, setChainReaderForTests } from "@/server/rewards/context";
import { getHolderCard, refreshDueHolders } from "@/server/rewards/holders";
import { finalizePeriod } from "@/server/rewards/leaderboard";
import { auditRewardAccounts } from "@/server/rewards/ledger";
import { REWARD_MESSAGES } from "@/server/rewards/messages";
import { getClaimTarget } from "@/server/rewards/target";
import type { Db } from "@/server/db/types";

import { createTestDb, resetDb, seedEligibleMember } from "../support/db";
import { balanceOf, bindWallet, chainTokens, HOUR, observeSteady, resultOf, seedScores, settingsWith, tokens, utc, walletFor } from "../support/rewards";

/**
 * $CLANKRPG DOES NOT EXIST YET. With no CLANKRPG_TOKEN_ADDRESS configured (and no simulated chain) the Arena, Picks, both boards, Points,
 * finalization, base-reward accounting and claim accounting must all behave exactly as after launch — only holder bonuses (everyone is
 * 0 %), on-chain payout verification and holder verification are unavailable, and nothing is denied or invented.
 */
let db: Db;
const SAVED: Record<string, string | undefined> = {};
const KEYS = ["CLANKRPG_TOKEN_ADDRESS", "CLANKRPG_CHAIN_ADAPTER", "CLANKRPG_REWARD_TREASURY_ADDRESS"] as const;

beforeAll(async () => {
  for (const k of KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  resetEnvCache();
  setChainReaderForTests(undefined);
  db = await createTestDb();
});
afterAll(async () => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  resetEnvCache();
  setChainReaderForTests(undefined);
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

const DAY = "2026-10-07";
const CLOSE = utc(2026, 10, 8, 0, 0, 5);
const WEEK = "2026-10-12";
const WEEK_CLOSE = utc(2026, 10, 19, 0, 0, 5);
/** `reader` is deliberately NOT passed: the finalizer asks the environment, exactly as in production with no token. */
const close = (kind: "DAILY" | "WEEKLY", start: string, at: number) => finalizePeriod(db, { now: () => new Date(at), settings: settingsWith() }, kind, start);
const dailyField = (n = 10) => seedScores(db, Array.from({ length: n }, (_, i) => ({ user: 9001 + i, day: DAY, picks: 20, correct: 20 - i })));
const weeklyField = () =>
  seedScores(db, Array.from({ length: 10 }, (_, i) => i).flatMap((i) => ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((day) => ({ user: 9001 + i, day, picks: 20, correct: 20 - i }))));
const healthy = async () => {
  expect(await auditRewardAccounts(db)).toEqual([]);
  expect(await reconcileRewards(db, { now: new Date() })).toEqual([]);
};

describe("no CLANKRPG_TOKEN_ADDRESS: the token is NOT LAUNCHED (a normal state)", () => {
  it("the configuration says so plainly — no address, no chain reader, the BUY link falls back to https://clank.trade/", async () => {
    expect(getTokenStatus()).toMatchObject({ launched: false, available: false, tokenAddress: null, publicAddress: null, chainId: null });
    expect(await getChainReader()).toBeNull();
    expect(buyUrl(getTokenStatus().publicAddress)).toBe("https://clank.trade/");
    expect(await getClaimTarget(db)).toMatchObject({ enabled: false, reason: "NOT_LAUNCHED", tokenAddress: null, tokenDecimals: null });
  });

  it("the Admin token panel: Official Contract NOT LAUNCHED, Metadata not verified, no symbol, no decimals — and no warning (it is not a fault)", async () => {
    const t = tokenAdminStatus(getTokenStatus(), null, null);
    expect(t).toMatchObject({
      launched: false,
      contract: { status: "NOT_LAUNCHED", address: null },
      metadata: { status: "NOT_LAUNCHED", symbol: null, decimals: null },
      holderVerificationAvailable: false,
      claimsAvailable: false,
      warnings: [],
    });
    expect(t.notices.join(" ")).toMatch(/has not launched yet/);
    expect(t.notices.join(" ")).toMatch(/ONLY token setting/);
  });
});

describe("the Daily board finalizes with NO token: base prizes, ledger and balances are exactly as after launch", () => {
  it("ten winners: 30,000 / 20,000 / … / 2,000 credited as claimable, every holder bonus 0 %, nothing waiting on anything", async () => {
    await dailyField();
    const r = await close("DAILY", DAY, CLOSE);
    expect(r.status).toBe("FINALIZED");
    const [board] = await db.query<Record<string, string>>("select prize_pool_micro::text, base_awarded_micro::text, returned_to_reserve_micro::text from public.arena_leaderboards where kind = 'DAILY'");
    expect(board).toEqual({ prize_pool_micro: tokens(100_000).toString(), base_awarded_micro: tokens(100_000).toString(), returned_to_reserve_micro: "0" });
    const expected = [30_000, 20_000, 15_000, 10_000, 8_000, 6_000, 4_000, 3_000, 2_000, 2_000];
    for (let i = 0; i < 10; i++) {
      const row = await resultOf(db, "DAILY", DAY, 9001 + i);
      expect(row, `rank ${i + 1}`).toMatchObject({ rank: i + 1, base_prize_micro: tokens(expected[i]!).toString(), base_status: "CREDITED", bonus_status: "NONE", bonus_bps: 0, bonus_micro: "0" });
      expect((await balanceOf(db, 9001 + i)).claimable).toBe(tokens(expected[i]!));
    }
    const kinds = (await db.query<{ kind: string }>("select distinct kind from public.arena_reward_ledger")).map((k) => k.kind);
    expect(kinds).toEqual(["DAILY_LEADERBOARD_BASE_REWARD"]); // no bonus row exists
    await healthy();
  });

  it("a wallet-bound member with a long holding history gets NO bonus before launch — and exactly the same points, rank and base prize as everyone else", async () => {
    await dailyField(3);
    // the history a stale/simulated database could carry: a 10M wallet verified for days — it must not matter without a token
    await bindWallet(db, 9001, { verifiedAtMs: utc(2026, 10, 4) });
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 22, 0), chainTokens(10_250_000), 4 * HOUR);
    await close("DAILY", DAY, CLOSE);
    const rows = [await resultOf(db, "DAILY", DAY, 9001), await resultOf(db, "DAILY", DAY, 9002), await resultOf(db, "DAILY", DAY, 9003)];
    expect(rows.map((r) => [r!.rank, r!.points, r!.base_prize_micro, r!.bonus_status, r!.bonus_bps])).toEqual([
      [1, 200, tokens(30_000).toString(), "NONE", 0],
      [2, 190, tokens(20_000).toString(), "NONE", 0],
      [3, 180, tokens(15_000).toString(), "NONE", 0],
    ]);
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(30_000));
    await healthy();
  });

  it("re-running finalization is still idempotent without a token (one board, one credit per winner)", async () => {
    await dailyField(3);
    expect((await close("DAILY", DAY, CLOSE)).status).toBe("FINALIZED");
    expect((await close("DAILY", DAY, CLOSE)).status).toBe("ALREADY_FINALIZED");
    expect((await db.query("select 1 from public.arena_reward_ledger")).length).toBe(3);
  });
});

describe("the Weekly board finalizes with NO token", () => {
  it("ten winners: 150,000 / 100,000 / … credited, bonuses 0 %", async () => {
    await weeklyField();
    expect((await close("WEEKLY", WEEK, WEEK_CLOSE)).status).toBe("FINALIZED");
    const first = await resultOf(db, "WEEKLY", WEEK, 9001);
    expect(first).toMatchObject({ rank: 1, picks: 100, base_prize_micro: tokens(150_000).toString(), bonus_status: "NONE" });
    expect((await balanceOf(db, 9010)).claimable).toBe(tokens(10_000));
    await healthy();
  }, 120_000);
});

describe("the Admin payout summary works before launch (every bonus 0)", () => {
  it("Daily: base 100,000 + holder bonuses 0 = TOTAL 100,000 (the ceiling the summary reports is the post-launch maximum, 125,000)", async () => {
    await dailyField();
    await close("DAILY", DAY, CLOSE);
    const p = await boardPayout(db, "DAILY", DAY);
    expect(p!.summary).toMatchObject({ basePool: "100,000", baseAwarded: "100,000", holderBonuses: "0", totalPayout: "100,000", totalPayoutPlain: "100000", prizeWinners: 10, bonusesPending: 0 });
    expect(p!.rows.every((r) => r.holderTier === null && r.holderBonus === "0")).toBe(true);
  });

  it("Weekly: base 500,000 + holder bonuses 0 = TOTAL 500,000", async () => {
    await weeklyField();
    await close("WEEKLY", WEEK, WEEK_CLOSE);
    const p = await boardPayout(db, "WEEKLY", WEEK);
    expect(p!.summary).toMatchObject({ basePool: "500,000", baseAwarded: "500,000", holderBonuses: "0", totalPayout: "500,000", totalPayoutPlain: "500000", prizeWinners: 10 });
  }, 120_000);

  it("the Admin overview reports the not-launched state as a NOTICE (not a warning) and the economy ceilings 100,000→125,000 and 500,000→625,000", async () => {
    const o = await rewardsOverview(db, { settings: DEFAULT_SETTINGS, token: getTokenStatus(), tokenDecimals: null, reader: null, nowMs: Date.now() });
    expect(o.token).toMatchObject({ launched: false, available: false });
    expect(o.notices.join(" ")).toMatch(/has not launched yet/);
    expect(o.warnings.join(" ")).not.toMatch(/launched|unusable|not configured/i);
    expect(o.economy.daily).toMatchObject({ basePool: "100,000", maxBonusExposure: "25,000", maxLiability: "125,000" });
    expect(o.economy.weekly).toMatchObject({ basePool: "500,000", maxBonusExposure: "125,000", maxLiability: "625,000" });
  });
});

describe("claims before launch: 'not yet', never denied — and nothing is lost", () => {
  it("a claim request is answered TOKEN_NOT_LAUNCHED with the player wording; the balance stays claimable and no claim row exists", async () => {
    await dailyField(3);
    await close("DAILY", DAY, CLOSE);
    const target = await getClaimTarget(db);
    const r = await requestClaim(db, { now: () => new Date(CLOSE), allowDemo: true }, { userId: 9001, idempotencyKey: "claim-before-launch-1", destination: { kind: "CUSTOM", address: walletFor(9100) }, settings: DEFAULT_SETTINGS, target });
    expect(r).toEqual({ ok: false, reason: "TOKEN_NOT_LAUNCHED" });
    expect(REWARD_MESSAGES.TOKEN_NOT_LAUNCHED).toMatch(/Claims will open after \$CLANKRPG launches/);
    expect(REWARD_MESSAGES.TOKEN_NOT_LAUNCHED).toMatch(/nothing is lost or denied/);
    expect(await balanceOf(db, 9001)).toMatchObject({ claimable: tokens(30_000), reserved: 0n, claimed: 0n });
    expect(await db.query("select 1 from public.arena_reward_claims")).toEqual([]);
    expect(await db.query("select 1 from public.arena_reward_claims where status = 'DENIED'")).toEqual([]);
    await healthy();
  });
});

describe("holder verification is unavailable before launch (it fails closed) — and does not disturb anything", () => {
  it("the background refresh has no reader and does nothing; the holder card says the token has not launched, with a plain 0 % and no tier ladder", async () => {
    const u = await seedEligibleMember(db, { id: 9201 });
    expect(await refreshDueHolders(db, { now: () => new Date() }, null, DEFAULT_SETTINGS)).toMatchObject({ failed: 0 }); // no reader: nothing to read, nothing to fail
    const card = await getHolderCard(db, u, DEFAULT_SETTINGS, { launched: false, decimals: null }, Date.now(), false);
    expect(card).toMatchObject({ launched: false, available: false });
    const html = renderToStaticMarkup(createElement(HolderBonusCard, { holder: card, onChanged: () => undefined }));
    expect(html).toContain("Holder reward bonus");
    expect(html).toContain("$CLANKRPG has not launched yet.");
    expect(html).toContain("Holder bonuses will become available after the official token launches.");
    expect(html).toMatch(/data-testid="holder-bonus-line">0%</);
    expect(html).not.toMatch(/data-testid="holder-ladder"/); // no tiers shown as if live
    expect(html).not.toMatch(/\+5%|\+10%|\+15%|\+20%|\+25%|100K|500K|1M|5M|10M/);
    expect(html).not.toMatch(/Connect wallet/i);
    expect(html).toContain("Holdings NEVER affect your Arena Picks score or chance to rank.");
  });
});
