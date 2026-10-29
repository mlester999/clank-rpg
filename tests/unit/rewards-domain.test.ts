import { describe, expect, it } from "vitest";

import { checkRewardAddress } from "@/domain/rewards/address";
import { ACTIVE_CLAIM_STATUSES, canTransition, DENIAL_REASON_CODES, DENIAL_REASONS, isActiveClaim, isTerminalClaim, type ClaimStatus } from "@/domain/rewards/claims";
import * as tokenModule from "@/domain/rewards/tokens";
import { formatTokenAmount, formatTokenPlain, MAX_UINT256, parseTokenAmount } from "@/domain/rewards/tokens";
import { DEFAULT_SETTINGS, parseSettings } from "@/domain/settings";

describe("token amounts are exact (BigInt, real decimals) — never a float", () => {
  it("parses whole and fractional token amounts at any decimals", () => {
    expect(parseTokenAmount("10000", 18)).toBe(10_000n * 10n ** 18n);
    expect(parseTokenAmount("0.5", 18)).toBe(5n * 10n ** 17n);
    expect(parseTokenAmount("10000", 6)).toBe(10_000_000_000n);
    expect(parseTokenAmount("1.000001", 6)).toBe(1_000_001n);
    expect(parseTokenAmount("7", 0)).toBe(7n);
    expect(parseTokenAmount("0", 18)).toBe(0n);
  });
  it("REFUSES what it cannot represent exactly instead of rounding", () => {
    expect(() => parseTokenAmount("1.0000001", 6)).toThrow(/decimal places/);
    expect(() => parseTokenAmount("0.5", 0)).toThrow(/decimal places/);
    for (const bad of ["", "abc", "-5", "1e9", "1,000", " 5", "5 ", ".5", "5.", "01", "0x10", "NaN"]) expect(() => parseTokenAmount(bad, 18)).toThrow();
    for (const bad of [-1, 37, 1.5, Number.NaN]) expect(() => parseTokenAmount("1", bad)).toThrow(/decimals/);
  });
  it("a JavaScript number cannot hold the reward: 10,000 tokens at 18 decimals is beyond 2^53 and still exact", () => {
    const raw = parseTokenAmount("10000", 18);
    expect(raw).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(formatTokenPlain(raw, 18)).toBe("10000");
    expect(parseTokenAmount("123456789.123456789123456789", 18)).toBe(123_456_789_123_456_789_123_456_789n);
  });
  it("formats for display: grouping, trimmed fraction, truncation (never rounds up)", () => {
    expect(formatTokenAmount(parseTokenAmount("42500", 18), 18)).toBe("42,500");
    expect(formatTokenAmount(parseTokenAmount("1234567.5", 18), 18)).toBe("1,234,567.5");
    expect(formatTokenAmount(parseTokenAmount("0.123456789", 18), 18)).toBe("0.1234"); // truncated, not 0.1235
    expect(formatTokenAmount(0n, 18)).toBe("0");
    expect(formatTokenPlain(1n, 18)).toBe("0.000000000000000001");
    expect(() => formatTokenPlain(-1n, 18)).toThrow();
  });
  it("round-trips for every decimals value", () => {
    for (let d = 0; d <= 36; d++) {
      const raw = 123_456_789n * 10n ** BigInt(Math.max(0, d - 3)) + 7n;
      expect(parseTokenAmount(formatTokenPlain(raw, d), d)).toBe(raw);
    }
    expect(MAX_UINT256).toBe(2n ** 256n - 1n);
  });
});

describe("there is NO per-battle token emission", () => {
  it("the per-battle equal-split primitive is gone from the token module, and no setting can configure a per-battle pool", () => {
    expect(tokenModule).not.toHaveProperty("splitReward");
    expect(DEFAULT_SETTINGS.arena_picks).not.toHaveProperty("rewardPerBattle");
    expect(DEFAULT_SETTINGS.arena_picks).not.toHaveProperty("dailyEmissionCap");
    // A payload that still carries the retired key is read as a legacy row: the key is dropped, it can never configure anything.
    const up = parseSettings("arena_picks", { ...DEFAULT_SETTINGS.arena_picks, rewardPerBattle: "10000" });
    expect(up).not.toHaveProperty("rewardPerBattle");
    expect(Object.keys(up)).not.toContain("rewardPerBattle");
  });
});

describe("reward wallet address validation", () => {
  it("accepts a valid EVM address (any case that is valid) and normalises to lower-case", () => {
    const lower = "0x52908400098527886e0f7030069857d2e4169ee7";
    expect(checkRewardAddress(lower)).toEqual({ ok: true, address: lower });
    expect(checkRewardAddress("0x52908400098527886E0F7030069857D2E4169EE7")).toEqual({ ok: true, address: lower }); // valid EIP-55 checksum
    expect(checkRewardAddress(`  ${lower}  `)).toEqual({ ok: true, address: lower });
    expect(checkRewardAddress(lower.toUpperCase().replace("0X", "0x"))).toEqual({ ok: true, address: lower }); // all-caps carries no checksum
  });
  it("rejects a mixed-case address with a BAD checksum (a typo)", () => {
    expect(checkRewardAddress("0x52908400098527886E0F7030069857D2E4169ee7")).toEqual({ ok: false, reason: "MALFORMED" });
  });
  it("rejects malformed input of every kind", () => {
    for (const bad of ["", "0x", "0x123", "52908400098527886e0f7030069857d2e4169ee7", "0xZZ908400098527886e0f7030069857d2e4169ee7", "0x52908400098527886e0f7030069857d2e4169ee7aa", "vitalik.eth", "0x 2908400098527886e0f7030069857d2e4169ee7"]) {
      expect(checkRewardAddress(bad), bad).toEqual({ ok: false, reason: "MALFORMED" });
    }
    for (const bad of [undefined, null, 5, {}, []]) expect(checkRewardAddress(bad)).toEqual({ ok: false, reason: "MALFORMED" });
  });
  it("rejects the zero address, burn addresses and system/precompile addresses", () => {
    expect(checkRewardAddress("0x0000000000000000000000000000000000000000")).toEqual({ ok: false, reason: "ZERO_ADDRESS" });
    expect(checkRewardAddress("0x000000000000000000000000000000000000dEaD")).toEqual({ ok: false, reason: "BURN_ADDRESS" });
    expect(checkRewardAddress("0xdead000000000000000000000000000000000000")).toEqual({ ok: false, reason: "BURN_ADDRESS" });
    expect(checkRewardAddress("0xffffffffffffffffffffffffffffffffffffffff")).toEqual({ ok: false, reason: "BURN_ADDRESS" });
    expect(checkRewardAddress("0x0000000000000000000000000000000000000001")).toEqual({ ok: false, reason: "RESERVED_ADDRESS" });
    expect(checkRewardAddress("0x000000000000000000000000000000000000ffff")).toEqual({ ok: false, reason: "RESERVED_ADDRESS" });
  });
});

describe("manual claim state machine", () => {
  const ALL: ClaimStatus[] = ["PENDING", "SENT", "DENIED"];
  it("allows exactly PENDING → SENT and PENDING → DENIED — nothing else", () => {
    const allowed = new Set(["PENDING>SENT", "PENDING>DENIED"]);
    for (const from of ALL) for (const to of ALL) expect(canTransition(from, to), `${from}>${to}`).toBe(allowed.has(`${from}>${to}`));
  });
  it("SENT and DENIED are terminal: they go nowhere (a paid or refused claim is frozen)", () => {
    for (const t of ["SENT", "DENIED"] as ClaimStatus[]) {
      expect(isTerminalClaim(t)).toBe(true);
      for (const to of ALL) expect(canTransition(t, to)).toBe(false);
    }
    expect(isTerminalClaim("PENDING")).toBe(false);
  });
  it("only PENDING holds a reservation (at most one per member)", () => {
    expect([...ACTIVE_CLAIM_STATUSES]).toEqual(["PENDING"]);
    expect(isActiveClaim("PENDING")).toBe(true);
    expect(isActiveClaim("SENT")).toBe(false);
    expect(isActiveClaim("DENIED")).toBe(false);
  });
  it("every denial reason has an admin label and a SAFE player message — none leaks anti-fraud reasoning", () => {
    expect(DENIAL_REASON_CODES.sort()).toEqual(["INVALID_WALLET", "NEEDS_REVIEW", "OTHER", "SUSPICIOUS"]);
    for (const code of DENIAL_REASON_CODES) {
      const r = DENIAL_REASONS[code];
      expect(r.label.length).toBeGreaterThan(3);
      expect(r.publicMessage).not.toMatch(/fraud|sybil|duplicate|suspicious|bot|multi|score|risk/i);
      expect(r.publicLabel).not.toMatch(/fraud|sybil|duplicate|suspicious|bot|multi|score|risk/i);
    }
    // Abuse-flavoured reasons also hold the account (the existing REVIEW state); ordinary ones do not.
    expect(DENIAL_REASONS.SUSPICIOUS.holdsAccount).toBe(true);
    expect(DENIAL_REASONS.NEEDS_REVIEW.holdsAccount).toBe(true);
    expect(DENIAL_REASONS.INVALID_WALLET.holdsAccount).toBe(false);
    expect(DENIAL_REASONS.OTHER.holdsAccount).toBe(false);
  });
});

describe("arena_picks settings", () => {
  it("ships the FINAL economy in ONE place and validates it", () => {
    expect(DEFAULT_SETTINGS.arena_picks).toMatchObject({ enabled: true, minimumClaim: "10000", pointsPerCorrectPick: 10, dailyPrizePool: "200000", weeklyPrizePool: "1000000", dailyMinimumPicks: 20, weeklyMinimumPicks: 100, holderDailyQualifyHours: 24, holderWeeklyQualifyHours: 168, holderMaxAgeHours: 6 });
    expect(parseSettings("arena_picks", DEFAULT_SETTINGS.arena_picks)).toEqual(DEFAULT_SETTINGS.arena_picks);
  });
  it("rejects floats-as-numbers, negatives, junk and unknown keys", () => {
    const base = DEFAULT_SETTINGS.arena_picks;
    expect(() => parseSettings("arena_picks", { ...base, dailyPrizePool: 100000 })).toThrow();
    expect(() => parseSettings("arena_picks", { ...base, dailyPrizePool: "-5" })).toThrow();
    expect(() => parseSettings("arena_picks", { ...base, weeklyPrizePool: "1e4" })).toThrow();
    expect(() => parseSettings("arena_picks", { ...base, minimumClaim: "ten" })).toThrow();
    expect(() => parseSettings("arena_picks", { ...base, surprise: 1 })).toThrow();
  });
  it("an existing database (no arena_picks row, no betting row) still loads from defaults", () => {
    // loadSettings falls back per key; unknown stored keys (e.g. the retired `betting`) are ignored — exercised in the integration suite.
    expect(DEFAULT_SETTINGS).not.toHaveProperty("betting");
  });
});
