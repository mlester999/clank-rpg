import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BecomeHeroCard, HeroStatusCard } from "@/components/character/EligibilityCards";
import { HeroEligibilityCard } from "@/components/arena/HeroEligibility";
import { arenaCard, characterCard, COMMUNITY, learnMore, statusCopy } from "@/content/heroEligibility";
import { eligibilityState, type EligibilityState } from "@/domain/heroEligibility";
import { DEFAULT_SETTINGS } from "@/domain/settings";

const T = DEFAULT_SETTINGS.telegram.qualifyingThreshold;
const member = (over: Partial<{ characterId: string | null; claimed: boolean; qualifyingMessages: number | null | undefined; status: "OK" | "FLAGGED" }> = {}) =>
  eligibilityState({ viewer: { characterId: null, claimed: false, qualifyingMessages: 0, status: "OK", ...over }, threshold: T });

describe("eligibility state", () => {
  it("uses the 50-message boundary and keeps all larger counts eligible", () => {
    expect(T).toBe(50);
    expect(member({ qualifyingMessages: 49 })).toEqual({ kind: "NOT_YET", qualifying: 49, threshold: T });
    for (const qualifyingMessages of [50, 51, 99, 100]) {
      expect(member({ qualifyingMessages })).toEqual({ kind: "ELIGIBLE" });
    }
    expect(member({ qualifyingMessages: 0 })).toEqual({ kind: "NOT_YET", qualifying: 0, threshold: T });
  });

  it("follows a configured threshold rather than a second hard-coded rule", () => {
    expect(eligibilityState({ viewer: { characterId: null, claimed: false, qualifyingMessages: 149 }, threshold: 150 })).toMatchObject({ kind: "NOT_YET", threshold: 150 });
    expect(eligibilityState({ viewer: { characterId: null, claimed: false, qualifyingMessages: 150 }, threshold: 150 })).toEqual({ kind: "ELIGIBLE" });
  });

  it("an existing unclaimed hero is 'hero found'; a claimed one is 'claimed' — regardless of the count", () => {
    expect(member({ characterId: "h1", qualifyingMessages: 3 })).toEqual({ kind: "HERO_FOUND" });
    expect(member({ characterId: "h1", claimed: true, qualifyingMessages: null })).toEqual({ kind: "CLAIMED" });
  });

  it("nobody signed in → signed out, with no numbers", () => {
    expect(eligibilityState({ viewer: null, threshold: T })).toEqual({ kind: "SIGNED_OUT" });
  });

  it("never fabricates progress when the verified count is unavailable", () => {
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const s = member({ qualifyingMessages: bad as never });
      expect(s.kind, String(bad)).toBe("UNKNOWN");
      expect(JSON.stringify(statusCopy(s, T))).not.toMatch(/\d+ \/ \d+/);
    }
  });

  it("a flagged member is told it is being reviewed, never that a hero will be created", () => {
    const s = member({ qualifyingMessages: 500, status: "FLAGGED" });
    expect(s.kind).toBe("REVIEW");
    expect(JSON.stringify(statusCopy(s, T))).not.toMatch(/will be created/i);
  });
});

describe("status copy", () => {
  const copy = (s: EligibilityState) => statusCopy(s, T);
  it("matches the agreed states", () => {
    expect(copy({ kind: "NOT_YET", qualifying: 25, threshold: T })).toMatchObject({ title: "Not yet eligible", lines: ["25 / 50 qualifying messages", expect.stringContaining("official Clank.trade Telegram community")], progress: { value: 25, max: 50 } });
    expect(copy({ kind: "ELIGIBLE" })).toMatchObject({ title: "Hero eligible", lines: ["50+ qualifying messages reached.", "Your hero will be created automatically."] });
    expect(copy({ kind: "HERO_FOUND" })?.lines[0]).toBe("Your Clank RPG hero already exists.");
    expect(copy({ kind: "CLAIMED" })).toMatchObject({ title: "Your hero is claimed", lines: ["Telegram identity verified."] });
    expect(copy({ kind: "SIGNED_OUT" })).toBeNull();
  });
});

/** Every player-facing string this feature can show, for the wording rules below. */
function allCopy(): string {
  const states: EligibilityState[] = [{ kind: "SIGNED_OUT" }, { kind: "CLAIMED" }, { kind: "HERO_FOUND" }, { kind: "REVIEW" }, { kind: "ELIGIBLE" }, { kind: "UNKNOWN" }, { kind: "NOT_YET", qualifying: 25, threshold: T }];
  return JSON.stringify([arenaCard(T), learnMore(T), characterCard(T), ...states.map((s) => statusCopy(s, T))]);
}

describe("wording", () => {
  it("always says qualifying messages and names the official Clank.trade Telegram community", () => {
    const text = JSON.stringify([arenaCard(T), characterCard(T), learnMore(T)]);
    expect(text).toContain("50+ qualifying messages");
    expect(text).toContain(COMMUNITY);
    expect(COMMUNITY).toBe("official Clank.trade Telegram community");
  });

  it("never invites message farming", () => {
    const text = allCopy();
    expect(text).not.toMatch(/send (\d+|a hundred|100|enough|lots|many)[^"]*messages/i);
    expect(text).not.toMatch(/\b(post|write|type|spam|farm)\b[^"]{0,25}\b\d+\b[^"]{0,15}\bmessages\b/i);
    expect(text).not.toMatch(/\bget a hero\b/i);
    expect(text).not.toMatch(/\b\d+ messages\b(?! )/); // a bare count without "qualifying"
    expect(text).toMatch(/spam/i); // …and it does say spam doesn't count
    expect(text).toMatch(/don't count|don't|doesn't/i);
  });

  it("does not leak scoring internals (caps, rate limits, weights, thresholds other than the headline)", () => {
    expect(allCopy()).not.toMatch(/daily cap|per day|a day|cap\b|rate.?limit|weight|seconds|cooldown|too fast|burst|duplicate|gibberish|words?\b.*\bminimum|\bscore\b|0\.\d/i);
  });

  it("explains class randomness + that players can't change it and that no prior sign-up is needed", () => {
    const text = JSON.stringify(learnMore(T));
    expect(text).toMatch(/mostly chance/i);
    expect(text).toMatch(/class is set/i); // set at creation; players cannot change it (the team can — Admin reroll)
    expect(text).toMatch(/don't need to sign up/i);
  });
});

describe("rendered components", () => {
  it("arena card shows the headline rule, a Learn more control and the modal content", () => {
    const html = renderToStaticMarkup(createElement(HeroEligibilityCard, { threshold: T }));
    expect(html).toContain("Who becomes a hero?");
    expect(html).toContain("50+ qualifying messages");
    expect(html).toContain("official Clank.trade Telegram community");
    expect(html).toContain("Learn more");
    expect(html).toContain("<dialog");
    expect(html).toContain("its class is set");
  });

  it("character card explains the rule and points existing heroes to claiming", () => {
    const html = renderToStaticMarkup(createElement(BecomeHeroCard, { threshold: T }));
    expect(html).toContain("Become a Clank RPG hero");
    expect(html).toContain("Reach 50+ qualifying messages to become eligible.");
    expect(html).toContain("Already have a hero?");
    expect(html).toContain("Sign in with Telegram to claim it.");
  });

  it("status card shows numeric progress only for a verified count", () => {
    const withCount = renderToStaticMarkup(createElement(HeroStatusCard, { state: { kind: "NOT_YET", qualifying: 25, threshold: T }, threshold: T }));
    expect(withCount).toContain("25 / 50 qualifying messages");
    expect(withCount).toContain('role="progressbar"');
    const unknown = renderToStaticMarkup(createElement(HeroStatusCard, { state: { kind: "UNKNOWN" }, threshold: T }));
    expect(unknown).not.toContain("progressbar");
    expect(unknown).not.toMatch(/\d+ \/ \d+/);
    expect(renderToStaticMarkup(createElement(HeroStatusCard, { state: { kind: "SIGNED_OUT" }, threshold: T }))).toBe("");
    const claimed = renderToStaticMarkup(createElement(HeroStatusCard, { state: { kind: "CLAIMED" }, threshold: T }));
    expect(claimed).toContain("Your hero is claimed");
    expect(claimed).toContain("Telegram identity verified.");
  });
});
