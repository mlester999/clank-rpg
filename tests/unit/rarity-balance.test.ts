import { describe, expect, it } from "vitest";

import { runRaritySim } from "../../scripts/lib/raritySim";
import { GAME_RULES } from "@/domain/gameRules";

/**
 * RARITY IS A REAL STRENGTH TIER — AND THE ARENA STAYS INTERESTING. These tests run the REAL combat engine over fighters drawn exactly like
 * hero generator 2 draws them (the full report is `pnpm rarity:sim`, 10,000 battles per scenario; the sizes here are smaller, with tolerances
 * wide enough for the sampling noise and tight enough to catch a real regression).
 *
 *   uniform      every slot a random rarity → higher rarity wins clearly more, a Common still wins sometimes, Legendary is not an automatic win
 *   per-rarity   all eight slots one rarity → no class is useless (or dominant) inside any rarity: equal PWR means equal strength
 *   duel         one fighter of the rarity under test against seven Commons → a Legendary is strong, not unbeatable
 */
describe("rarity strength — measured with the real combat engine", () => {
  const uniform = runRaritySim({ battles: 3000, scenario: "uniform", salt: "t-uni" });
  const perRarity = runRaritySim({ battles: 3000, scenario: "per-rarity", salt: "t-per" });
  const duel = runRaritySim({ battles: 2400, scenario: "duel", salt: "t-duel" });

  it("LEGENDARY is the strongest overall, then EPIC, then RARE, COMMON the lowest (win rate AND average placement)", () => {
    const w = (r: string) => uniform.byRarity[r]!.winPct;
    const p = (r: string) => uniform.byRarity[r]!.avgPlace;
    expect(w("LEGENDARY")).toBeGreaterThan(w("EPIC"));
    expect(w("EPIC")).toBeGreaterThan(w("RARE"));
    expect(w("RARE")).toBeGreaterThan(w("COMMON"));
    expect(p("LEGENDARY")).toBeLessThan(p("EPIC"));
    expect(p("EPIC")).toBeLessThan(p("RARE"));
    expect(p("RARE")).toBeLessThan(p("COMMON"));
    // the ladder is steep enough to be felt: a Legendary wins well over twice as often as a Rare, and ~4× a Common
    expect(w("LEGENDARY") / w("COMMON")).toBeGreaterThan(3);
  });

  it("every rarity beats the one below it head-to-head more often than not — and a LOWER rarity still wins plenty of those meetings", () => {
    for (const [pair, { higherOutplacesPct }] of Object.entries(uniform.pairwise)) {
      expect(higherOutplacesPct, pair).toBeGreaterThan(52);
      expect(higherOutplacesPct, pair).toBeLessThan(82); // never an automatic win
    }
    expect(uniform.pairwise["LEGENDARY>COMMON"]!.higherOutplacesPct).toBeGreaterThan(uniform.pairwise["RARE>COMMON"]!.higherOutplacesPct);
  });

  it("Legendary is NOT an automatic win: a lone Legendary against seven Commons wins about half the time, and the Commons together win the rest", () => {
    const lone = duel.byRarity.LEGENDARY!;
    expect(lone.winPct).toBeGreaterThan(35);
    expect(lone.winPct).toBeLessThan(70);
    expect(duel.winnerRarityShare.COMMON!).toBeGreaterThan(20); // a Common takes the battle in a large share of them
  });

  it("a Common can still win: in a field of every rarity a Common wins a real share of battles", () => {
    expect(uniform.winnerRarityShare.COMMON!).toBeGreaterThan(5);
    expect(uniform.byRarity.COMMON!.winPct).toBeGreaterThan(2.5);
  });

  it("NO CLASS IS USELESS (or dominant) INSIDE ANY RARITY: when everyone has the same PWR, every class wins about its fair 12.5% share", () => {
    for (const [cls, row] of Object.entries(perRarity.byClass)) {
      expect(row.winPct, `${cls} overall`).toBeGreaterThan(9.5);
      expect(row.winPct, `${cls} overall`).toBeLessThan(15.5);
    }
    for (const [cls, byRarity] of Object.entries(perRarity.byClassRarity)) {
      for (const [rarity, cell] of Object.entries(byRarity)) {
        expect(cell.winPct, `${cls} ${rarity}`).toBeGreaterThan(8);
        expect(cell.winPct, `${cls} ${rarity}`).toBeLessThan(18);
      }
    }
  });

  it("every class benefits from rarity: its win rate rises from Common to Legendary in a mixed field", () => {
    for (const [cls, byRarity] of Object.entries(uniform.byClassRarity)) {
      expect(byRarity.LEGENDARY!.winPct, cls).toBeGreaterThan(byRarity.COMMON!.winPct);
      expect(byRarity.LEGENDARY!.winPct, cls).toBeGreaterThan(14); // a Legendary of ANY class is a real contender (12.5 % is a fair share)
    }
  });

  it("the fight length target is kept (~35–45 s median, 60 s cap) across every scenario", () => {
    for (const r of [uniform, perRarity, duel]) {
      expect(r.duration.median).toBeGreaterThanOrEqual(33);
      expect(r.duration.median).toBeLessThanOrEqual(44);
      expect(r.duration.p95).toBeLessThanOrEqual(60);
      expect(r.duration.max).toBeLessThanOrEqual(60);
      expect(r.timeoutPct).toBeLessThan(7);
    }
  });

  it("every fighter the simulation drew is inside its rarity's band (the sim uses the production generator path)", () => {
    for (const r of [uniform, duel]) {
      for (const [rarity, p] of Object.entries(r.powerByRarity)) {
        const rule = GAME_RULES.rarity.ladder.find((x) => x.id === rarity)!;
        expect(p.min, rarity).toBeGreaterThanOrEqual(rule.powerMin);
        expect(p.max, rarity).toBeLessThanOrEqual(rule.powerMax);
      }
    }
  });

  it("the public docs quote a MEASURED number: it must stay within tolerance of what the engine does today", () => {
    const measured = uniform.pairwise["LEGENDARY>COMMON"]!.higherOutplacesPct;
    expect(Math.abs(measured - GAME_RULES.balance.legendaryOutplacesCommonPercent)).toBeLessThan(6);
  });
});
