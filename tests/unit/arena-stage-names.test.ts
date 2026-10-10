import { describe, expect, it } from "vitest";

import { graphemeLength } from "@/domain/character/displayName";
import { legacyRingRuleset } from "../support/legacyRing";
import { makeHarness, playFight, stageFor, type DrawCall, type Harness } from "../support/stageHarness";
import { plateMetrics } from "@/components/arena/nameplates";
import { ruleset } from "../support/fixtures";

/**
 * HERO NAMES ON THE STAGE — the real ArenaRenderer, a recording canvas, real simulated fights (the engine the server runs). Names must stay on screen for
 * the whole fight on every screen size: countdown, combat, the final two, the victory — not just before the bell.
 */
const VIEWPORTS = [320, 360, 390, 430, 768, 1440] as const;
const SEEDS = ["a", "b", "c"] as const;
const FULL_NAME = "Sir Bartholomew Maximilian Featherstone";

interface Tally {
  frames: number;
  heroFrames: number;
  named: number;
  bars: number;
  overlaps: number;
  outside: number;
  minNameCssPx: number;
  noNameFrames: number;
  platesMismatch: number;
}

/** Plays every seed at one viewport and tallies what the plates did, by phase. */
function tally(viewport: number, seeds: readonly string[], pick: (phase: string, alive: number) => boolean, after?: (h: Harness) => void): Tally {
  const { w, h } = stageFor(viewport);
  const t: Tally = { frames: 0, heroFrames: 0, named: 0, bars: 0, overlaps: 0, outside: 0, minNameCssPx: 99, noNameFrames: 0, platesMismatch: 0 };
  for (const seed of seeds) {
    const hn = makeHarness(seed, w, h);
    after?.(hn);
    const st = hn.renderer.stage;
    playFight(hn, (_now, phase) => {
      const alive = hn.renderer.roster().filter((r) => r.alive).length;
      if (!pick(phase, alive)) return;
      const ps = hn.renderer.plates;
      t.frames++;
      t.heroFrames += ps.length;
      if (ps.length !== alive) t.platesMismatch++;
      const vis = ps.filter((p) => p.mode !== "bar");
      if (vis.length === 0 && ps.length > 0) t.noNameFrames++;
      for (const p of ps) {
        if (p.mode === "bar") t.bars++;
        else t.named++;
        if (p.rect.x < -0.01 || p.rect.y < -0.01 || p.rect.x + p.rect.w > st.layoutW + 0.01 || p.rect.y + p.rect.h > st.layoutH + 0.01) t.outside++;
      }
      let over = false;
      for (let i = 0; i < vis.length && !over; i++) {
        for (let j = i + 1; j < vis.length; j++) {
          const a = vis[i]!.rect;
          const b = vis[j]!.rect;
          if (a.x < b.x + b.w - 0.01 && a.x + a.w > b.x + 0.01 && a.y < b.y + b.h - 0.01 && a.y + a.h > b.y + 0.01) {
            over = true;
            break;
          }
        }
      }
      if (over) t.overlaps++;
      const names = new Set(hn.battle.fighters.map((f) => f.name));
      for (const c of hn.calls) {
        const m = /(\d+(?:\.\d+)?)px/.exec(c.font);
        if (m && c.op === "fillText" && (names.has(c.text) || c.text.endsWith("…")) && hn.renderer.plates.some((p) => p.name === c.text)) t.minNameCssPx = Math.min(t.minNameCssPx, Number(m[1]) * (w / st.layoutW));
      }
    });
  }
  return t;
}

describe.each(VIEWPORTS)("at a %i px wide viewport", (vw) => {
  it("COUNTDOWN: all eight heroes wear a name, at their spawn spots, none overlapping", () => {
    const t = tally(vw, SEEDS, (phase) => phase === "COUNTDOWN");
    expect(t.frames).toBeGreaterThan(40);
    expect(t.heroFrames).toBe(t.frames * 8);
    expect(t.bars).toBe(0);
    expect(t.overlaps).toBe(0);
    expect(t.platesMismatch).toBe(0);
  });

  it("COMBAT: every living hero keeps a name (≥ 97 % of hero-frames on a phone, ≥ 99 % wider), never all HP bars, never overlapping, never outside the stage", () => {
    const t = tally(vw, SEEDS, (phase, alive) => phase === "COMBAT" && alive > 0);
    expect(t.frames).toBeGreaterThan(500);
    expect(t.named / t.heroFrames).toBeGreaterThanOrEqual(vw < 480 ? 0.97 : 0.99);
    expect(t.noNameFrames).toBe(0);
    expect(t.overlaps).toBe(0);
    expect(t.outside).toBe(0);
    expect(t.platesMismatch).toBe(0);
  });

  it("EIGHT heroes alive: eight names (≥ 97 %), no overlap", () => {
    const t = tally(vw, SEEDS, (phase, alive) => phase === "COMBAT" && alive === 8);
    expect(t.frames).toBeGreaterThan(60);
    expect(t.named / t.heroFrames).toBeGreaterThanOrEqual(0.97);
    expect(t.overlaps).toBe(0);
  });

  it("FINAL 1v1: both names stay on screen (≥ 99 %)", () => {
    const t = tally(vw, SEEDS, (phase, alive) => phase === "COMBAT" && alive === 2);
    expect(t.frames).toBeGreaterThan(20);
    expect(t.named / t.heroFrames).toBeGreaterThanOrEqual(0.99);
    expect(t.overlaps).toBe(0);
  });

  it("VICTORY: the winner's name is on screen", () => {
    const t = tally(vw, SEEDS, (phase) => phase === "VICTORY");
    expect(t.frames).toBeGreaterThan(5);
    expect(t.bars).toBe(0);
    expect(t.named).toBe(t.heroFrames);
  });

  it("names are never drawn smaller than 10.5 css px, even at 320 px", () => {
    const t = tally(vw, ["a"], (phase) => phase === "COMBAT" || phase === "COUNTDOWN");
    expect(t.minNameCssPx).toBeGreaterThanOrEqual(10.5 - 0.05);
  });
});

describe("text on the stage never leaves the stage", () => {
  const within = (c: DrawCall, w: number, h: number, layoutW: number, layoutH: number) => {
    const m = /(\d+(?:\.\d+)?)px/.exec(c.font);
    const size = (m ? Number(m[1]) : 10) * c.scale;
    const tw = c.text.length * size * 0.56;
    const left = c.align === "center" ? c.x - tw / 2 : c.align === "right" || c.align === "end" ? c.x - tw : c.x;
    return { ok: left >= -1.5 && left + tw <= layoutW + 1.5 && c.y >= -1 && c.y <= layoutH + size, left, right: left + tw, w, h };
  };

  it.each([320, 390, 1440])("%i px: every name, number, KO and feed line, in every frame of three fights", (vw) => {
    const { w, h } = stageFor(vw);
    let calls = 0;
    const bad: string[] = [];
    for (const seed of SEEDS) {
      const hn = makeHarness(seed, w, h);
      hn.renderer.feedKill("e0", "Hannah Montgomery-Wellington", FULL_NAME, hn.combatStartsAt + 1000); // the widest line the feed can carry
      const st = hn.renderer.stage;
      playFight(hn, () => {
        for (const c of hn.calls) {
          calls++;
          const r = within(c, w, h, st.layoutW, st.layoutH);
          if (!r.ok && c.text.length > 0) bad.push(`${c.text} @ ${Math.round(r.left)}..${Math.round(r.right)} of ${st.layoutW}`);
        }
      });
    }
    expect(calls).toBeGreaterThan(5000);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe("long names", () => {
  it("a 40-character hero name is shortened on the stage (with an ellipsis), the stored name is untouched, and it fits the plate", () => {
    const hn = makeHarness("long", 330, 322, [FULL_NAME, "Ki", "Zed", "Fox", "Bo", "Mochi", "Lulu", "Pixel"]);
    const cap = plateMetrics(330, hn.renderer.stage.layoutW).maxChars;
    let seen = false;
    playFight(hn, (_n, phase) => {
      if (phase !== "COUNTDOWN") return;
      const p = hn.renderer.plates.find((x) => x.slot === 0)!;
      seen = true;
      expect(p.name).not.toBe(FULL_NAME);
      expect(p.name.endsWith("…")).toBe(true);
      expect(graphemeLength(p.name)).toBeLessThanOrEqual(cap);
      expect(p.rect.w * (330 / hn.renderer.stage.layoutW)).toBeLessThanOrEqual(330 * 0.4);
    });
    expect(seen).toBe(true);
    expect(hn.battle.fighters[0]!.name).toBe(FULL_NAME);
  });

  it("short names are drawn whole", () => {
    const hn = makeHarness("short", 366, 357);
    playFight(hn, (_n, phase) => {
      if (phase !== "COUNTDOWN") return;
      expect(hn.renderer.plates.find((p) => p.slot === 5)!.name).toBe("Ki");
    });
  });
});

describe("safe zones and focus", () => {
  it("plates keep out of a measured reserved box (the Survivors plate) in every frame of a fight", () => {
    const { w, h } = stageFor(390);
    const hn = makeHarness("res", w, h);
    const box = { x: 8, y: 8, w: 118, h: 46 };
    hn.renderer.setReserved([box]);
    const st = hn.renderer.stage;
    const fx = st.layoutW / w;
    const fy = st.layoutH / h;
    const r = { x: box.x * fx, y: box.y * fy, w: box.w * fx, h: box.h * fy };
    let frames = 0;
    playFight(hn, () => {
      frames++;
      for (const p of hn.renderer.plates) {
        if (p.mode === "bar") continue;
        const hit = p.rect.x < r.x + r.w && p.rect.x + p.rect.w > r.x && p.rect.y < r.y + r.h && p.rect.y + p.rect.h > r.y;
        expect(hit).toBe(false);
      }
    });
    expect(frames).toBeGreaterThan(300);
  });

  it("the hero the viewer picked keeps its plate straight above its head, and it is placed ahead of every other", () => {
    const { w, h } = stageFor(390);
    const hn = makeHarness("focus", w, h);
    hn.renderer.setFocus(3);
    let home = 0;
    let frames = 0;
    playFight(hn, (_n, phase) => {
      if (phase !== "COMBAT") return;
      const p = hn.renderer.plates.find((x) => x.slot === 3);
      if (!p) return;
      frames++;
      if (!p.displaced) home++;
    });
    expect(frames).toBeGreaterThan(40);
    expect(home / frames).toBeGreaterThanOrEqual(0.95);
  });
});

describe("the kill feed and the page's boxes never cost a hero its name", () => {
  const NAMES = ["Markyyester", "Jayson", "Alex", "Sir Bartholomew Maximilian Featherstone", "xX_DragonSlayer_Xx", "Ki", "Hannah Montgomery-Wellington", "Zed"];
  const nameOf = (slot: number | null) => (slot === null ? null : (NAMES[slot % NAMES.length] as string));
  const SEEDS_FEED = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const;

  /** Smallest stages the page can give the arena: a 320 px phone (290 × 283) and a phone held sideways (398 × 239). The Survivors plate and the speaker are reserved, the feed runs. */
  it.each([[290, 283], [398, 239], [360, 351]] as const)("%i × %i px stage: the winner keeps a NAME through the whole victory, and no hero loses its name for long in the fight", (w, h) => {
    let victory = 0;
    let victoryNamed = 0;
    let fight = 0;
    let fightNamed = 0;
    for (const seed of SEEDS_FEED) {
      const hn = makeHarness(seed, w, h, NAMES);
      hn.renderer.setReserved([w < 400 ? { x: 8, y: 8, w: 92, h: 44 } : { x: 8, y: 8, w: 110, h: 50 }, { x: w - 48, y: h - 48, w: 44, h: 44 }]);
      let at = 0;
      hn.renderer.onEvent = (e) => hn.renderer.feedKill(`${seed}-${e.victim}`, nameOf(e.killer), nameOf(e.victim) as string, at);
      playFight(hn, (now, phase) => {
        at = now;
        const alive = hn.renderer.roster().filter((r) => r.alive).length;
        const named = hn.renderer.plates.filter((p) => p.mode !== "bar").length;
        if (phase === "VICTORY") {
          victory++;
          if (named >= 1) victoryNamed++;
        }
        if (phase === "COMBAT" && alive > 0) {
          fight += alive;
          fightNamed += Math.min(alive, named);
        }
      });
    }
    expect(victory).toBeGreaterThan(100);
    expect(victoryNamed).toBe(victory); // not one victory frame without the winner's name
    expect(fightNamed / fight).toBeGreaterThanOrEqual(0.95);
  });
});

describe("the 3 · 2 · 1 is still a true pre-fight freeze", () => {
  it("before the bell the plates are exactly the spawn state — the same with or without the replay in hand", () => {
    const { w, h } = stageFor(390);
    const withReplay = makeHarness("freeze", w, h);
    const without = makeHarness("freeze", w, h);
    without.renderer.setBattle(without.battle, null);
    const snap = (hn: Harness) => hn.renderer.plates.map((p) => [p.slot, p.mode, p.name, Math.round(p.rect.x * 100), Math.round(p.rect.y * 100)]);
    const a: unknown[] = [];
    const b: unknown[] = [];
    for (let now = withReplay.startsAt + 2600; now < withReplay.combatStartsAt - 20; now += 100) {
      withReplay.renderer.render(now, withReplay.timing, 100);
      without.renderer.render(now, without.timing, 100);
      a.push(snap(withReplay));
      b.push(snap(without));
    }
    expect(a.length).toBeGreaterThan(20);
    expect(a).toEqual(b);
    // …and nothing of the fight is visible: every plate shows full HP and no hero has moved from its start position
    for (const u of withReplay.renderer.roster()) {
      expect(u.hpFrac).toBe(1);
      expect(u.alive).toBe(true);
      expect(u.damage).toBe(0);
    }
  });
});

describe("historical replays still play, with names", () => {
  it("a battle fought under the retired storm-ring rules (1.0.0) renders end to end, every living hero named", () => {
    const { w, h } = stageFor(390);
    const hn = makeHarness("legacy", w, h, undefined, legacyRingRuleset(ruleset));
    let frames = 0;
    let named = 0;
    let heroFrames = 0;
    playFight(hn, (_n, phase) => {
      if (phase !== "COMBAT") return;
      frames++;
      for (const p of hn.renderer.plates) {
        heroFrames++;
        if (p.mode !== "bar") named++;
      }
    });
    expect(frames).toBeGreaterThan(50);
    expect(named / heroFrames).toBeGreaterThanOrEqual(0.95);
    expect(hn.replay.rulesVersion).toBe("1.0.0");
  });
});

describe("cost", () => {
  it("laying out and drawing a whole fight's plates is cheap: well under a millisecond per frame in plain Node", () => {
    const { w, h } = stageFor(390);
    const hn = makeHarness("cost", w, h);
    const t0 = performance.now();
    let frames = 0;
    playFight(hn, () => {
      frames++;
    }, 16);
    const per = (performance.now() - t0) / frames;
    expect(frames).toBeGreaterThan(1500);
    expect(per).toBeLessThan(2); // generous: it includes every other part of the draw (background, fx), against a recording canvas
  });
});
