import { describe, expect, it } from "vitest";

import { DEFAULT_ACHIEVEMENTS } from "@/domain/content/achievements";

/**
 * THE ACHIEVEMENT CATALOGUE. Every achievement pays a one-off Clank Gold grant and unlocks a title the member may show above their hero's name — so a member can always
 * answer "what do I get for this?", and a shown title identifies exactly one achievement.
 */
const byId = (id: string) => DEFAULT_ACHIEVEMENTS.find((a) => a.id === id)!;

describe("every achievement has a title and a Gold reward", () => {
  it("20 achievements, each with a title (1–60 characters) and a positive whole Gold amount", () => {
    expect(DEFAULT_ACHIEVEMENTS).toHaveLength(20);
    for (const a of DEFAULT_ACHIEVEMENTS) {
      expect(a.reward.title, a.id).toBeTruthy();
      expect(a.reward.title!.trim(), a.id).toBe(a.reward.title);
      expect(a.reward.title!.length, a.id).toBeLessThanOrEqual(60);
      expect(Number.isInteger(a.reward.gold), a.id).toBe(true);
      expect(a.reward.gold!, a.id).toBeGreaterThan(0);
    }
  });

  it("ids, badges and titles are unique (a title on a hero names one achievement)", () => {
    for (const key of ["id", "badge", "title"] as const) {
      const values = DEFAULT_ACHIEVEMENTS.map((a) => (key === "id" ? a.id : (a.reward[key] as string).toLowerCase()));
      expect(new Set(values).size, key).toBe(values.length);
    }
  });

  it("harder achievements pay more than the easier ones of the same ladder", () => {
    const ladders: string[][] = [
      ["arena_debut", "arena_regular", "arena_veteran"], // battles fought
      ["victor", "champion", "legend_of_the_pit"], // battles won
      ["first_blood", "reaper"], // eliminations
      ["voice_of_clank", "pillar_of_clank"], // community messages
      ["diamond_1d", "diamond_7d", "diamond_30d", "diamond_90d"], // holding streak
    ];
    for (const ladder of ladders) {
      const gold = ladder.map((id) => byId(id).reward.gold!);
      expect(gold, ladder.join(" < ")).toEqual([...gold].sort((a, b) => a - b));
      expect(new Set(gold).size, ladder.join(" < ")).toBe(gold.length);
    }
  });

  it("the rewards are small next to what a battle pays: no single achievement pays more than a few hundred Gold", () => {
    expect(Math.max(...DEFAULT_ACHIEVEMENTS.map((a) => a.reward.gold!))).toBeLessThanOrEqual(500);
    expect(DEFAULT_ACHIEVEMENTS.reduce((n, a) => n + a.reward.gold!, 0)).toBeLessThan(3000);
  });
});
