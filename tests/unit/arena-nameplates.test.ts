import { describe, expect, it } from "vitest";

import {
  fitPlateName,
  layoutPlates,
  MODE_RANK,
  plateMetrics,
  plateSizes,
  type PlateEnv,
  type PlateInput,
  type PlateMode,
  type PlateState,
  type Placement,
  type Rect,
} from "@/components/arena/nameplates";

/**
 * NAME PLATES — the geometry that keeps every hero's name on the stage, on a phone as on a desktop. Pure functions: no canvas, no clock.
 * (tests/unit/arena-stage-names.test.ts plays whole fights through the real renderer; this file pins the rules one at a time.)
 */

/** The tall (phone) stage: 800 × 780 layout units shown 366 css px wide. */
const L = { w: 800, h: 780 };
const M = plateMetrics(366, L.w);
const charW = M.nameFs * 0.56;
const sizesOf = (chars: number) => plateSizes(M, chars * charW, 6 * charW * 0.74);
const margin = M.u(3);
const bounds: Rect = { x: margin, y: margin, w: L.w - 2 * margin, h: L.h - 2 * margin };
const env = (over: Partial<PlateEnv> = {}): PlateEnv => ({ bounds, reserved: [], gap: M.u(2), immediate: true, ...over });
const item = (slot: number, ax: number, ay: number, over: Partial<PlateInput> = {}): PlateInput => ({ slot, ax, ay, sizes: sizesOf(8), want: "compact", priority: -ay, ...over });

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.01 && a.x + a.w > b.x + 0.01 && a.y < b.y + b.h - 0.01 && a.y + a.h > b.y + 0.01;
const named = (ps: Placement[]) => ps.filter((p) => p.mode !== "bar");
const noOverlaps = (ps: Placement[]) => {
  const v = named(ps);
  for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) if (overlap(v[i]!.rect, v[j]!.rect)) return false;
  return true;
};

describe("plate metrics: legible at every size", () => {
  it.each([280, 296, 320, 366, 400, 480, 560, 720, 1000, 1400])("a %i px stage draws names at 10.5 css px or more", (cssW) => {
    const m = plateMetrics(cssW, cssW < 640 ? 800 : 1000);
    expect(m.nameFs * m.cpl).toBeGreaterThanOrEqual(10.5 - 1e-9);
    expect(m.nameFs * m.cpl).toBeLessThanOrEqual(13 + 1e-9);
    expect(m.subFs).toBeLessThan(m.nameFs);
  });

  it("a small stage gets SHORTER names, never smaller type", () => {
    const phone = plateMetrics(296, 800);
    const desktop = plateMetrics(1000, 1000);
    expect(phone.maxChars).toBeLessThan(desktop.maxChars);
    expect(phone.nameFs * phone.cpl).toBeCloseTo(10.5, 5);
    expect(phone.maxNameW * phone.cpl).toBeLessThanOrEqual(0.3 * 296 + 1e-6);
  });

  it("the four modes shrink: full ≥ compact ≥ tag ≥ bar, and a plate is never wider than a third of the stage on a phone", () => {
    const s = sizesOf(10);
    expect(s.full.h).toBeGreaterThan(s.compact.h);
    expect(s.compact.h).toBeGreaterThan(s.tag.h);
    expect(s.tag.h).toBeGreaterThan(s.bar.h);
    expect(MODE_RANK.full).toBeLessThan(MODE_RANK.bar);
    expect(s.compact.w * M.cpl).toBeLessThanOrEqual(366 * 0.4);
  });
});

describe("fitPlateName: names are shortened, never overflow", () => {
  const measure = (t: string) => t.length * 7;
  it("leaves a name that fits untouched", () => {
    expect(fitPlateName("Ki", 10, 200, measure)).toBe("Ki");
    expect(fitPlateName("Markyyester", 12, 200, measure)).toBe("Markyyester");
  });
  it("cuts a long name to the character budget with an ellipsis (the stored name is untouched)", () => {
    const out = fitPlateName("Sir Bartholomew Maximilian Featherstone", 10, 1e9, measure);
    expect([...out].length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("Sir")).toBe(true);
  });
  it("also respects the measured width", () => {
    const out = fitPlateName("Hannah Montgomery-Wellington", 16, 70, measure);
    expect(measure(out)).toBeLessThanOrEqual(70);
    expect(out.endsWith("…")).toBe(true);
  });
  it("never splits an emoji", () => {
    const out = fitPlateName("🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥", 6, 1e9, measure);
    expect(out).toBe("🔥🔥🔥🔥🔥…");
  });
});

describe("layoutPlates: where a name goes", () => {
  it("a lone hero's plate hangs straight above its head, centred", () => {
    const [p] = layoutPlates([item(0, 400, 300)], env(), new Map(), 0);
    expect(p!.mode).toBe("compact");
    expect(p!.key).toBe("home");
    expect(p!.rect.x + p!.rect.w / 2).toBeCloseTo(400, 3);
    expect(p!.rect.y + p!.rect.h).toBeCloseTo(300, 3);
    expect(p!.displaced).toBe(false);
  });

  it("two heroes in contact: both keep their names, side by side or stacked, never overlapping", () => {
    const out = layoutPlates([item(0, 400, 300), item(1, 420, 296)], env(), new Map(), 0);
    expect(out.map((p) => p.mode)).toEqual(["compact", "compact"]);
    expect(noOverlaps(out)).toBe(true);
    for (const p of out) {
      expect(Math.abs(p.rect.x + p.rect.w / 2 - (p.slot === 0 ? 400 : 420))).toBeLessThanOrEqual(p.rect.w * 1.2 + 0.01); // a step aside is at most ~1 plate width
    }
  });

  it("the front-most hero keeps its natural place; the one behind steps aside", () => {
    const out = layoutPlates([item(0, 400, 320), item(1, 405, 300)], env(), new Map(), 0);
    const front = out.find((p) => p.slot === 0)!;
    const back = out.find((p) => p.slot === 1)!;
    expect(front.key).toBe("home");
    expect(back.key).not.toBe("home");
  });

  it("a picked hero (top priority) never steps aside, whoever is in front", () => {
    const out = layoutPlates([item(0, 400, 320), item(1, 405, 300, { priority: -1e6 })], env(), new Map(), 0);
    expect(out.find((p) => p.slot === 1)!.key).toBe("home");
    expect(out.find((p) => p.slot === 0)!.key).not.toBe("home");
  });

  it("four heroes standing close together all keep a name, without overlap", () => {
    const items = [0, 1, 2, 3].map((i) => item(i, 380 + i * 24, 330 + (i % 2) * 18));
    const out = layoutPlates(items, env(), new Map(), 0);
    expect(named(out).length).toBe(4);
    expect(noOverlaps(out)).toBe(true);
  });

  it("eight heroes in an extreme pile: no overlaps, most keep a readable name, the rest keep an HP bar", () => {
    const items = Array.from({ length: 8 }, (_, i) => item(i, 380 + (i % 4) * 22, 400 + Math.floor(i / 4) * 30));
    const out = layoutPlates(items, env(), new Map(), 0);
    expect(noOverlaps(out)).toBe(true);
    expect(named(out).length).toBeGreaterThanOrEqual(6);
    expect(out.filter((p) => p.mode === "bar").length).toBe(8 - named(out).length);
  });

  it("every named plate stays inside the stage — at the left edge, the right edge and the top", () => {
    for (const [ax, ay] of [[4, 300], [796, 300], [400, 2], [2, 2], [798, 4]] as const) {
      const [p] = layoutPlates([item(0, ax, ay)], env(), new Map(), 0);
      expect(p!.rect.x).toBeGreaterThanOrEqual(bounds.x - 0.01);
      expect(p!.rect.y).toBeGreaterThanOrEqual(bounds.y - 0.01);
      expect(p!.rect.x + p!.rect.w).toBeLessThanOrEqual(bounds.x + bounds.w + 0.01);
      expect(p!.rect.y + p!.rect.h).toBeLessThanOrEqual(bounds.y + bounds.h + 0.01);
    }
  });

  it("keeps out of reserved boxes (the Survivors plate, the sound button …)", () => {
    const hud: Rect = { x: 20, y: 20, w: 250, h: 100 };
    const out = layoutPlates([item(0, 150, 160), item(1, 300, 140), item(2, 700, 700)], env({ reserved: [hud] }), new Map(), 0);
    for (const p of named(out)) expect(overlap(p.rect, hud)).toBe(false);
    expect(named(out).length).toBe(3);
  });

  it("a transient caption (the kill feed) is a SOFT box: plates keep out of it when they can …", () => {
    const feed: Rect = { x: 380, y: 60, w: 400, h: 60 };
    const out = layoutPlates([item(0, 590, 130)], env({ soft: [feed] }), new Map(), 0);
    expect(out[0]!.mode).not.toBe("bar");
    expect(overlap(out[0]!.rect, feed)).toBe(false);
  });

  it("… but a name outranks a caption: where no spot is free of it, the plate sits over the caption instead of dropping to an HP bar", () => {
    // a stage-wide caption in the top band and a hero standing in it: every spot a plate could take touches the caption
    const feed: Rect = { x: 0, y: 0, w: L.w, h: 200 };
    const out = layoutPlates([item(0, 400, 120)], env({ soft: [feed] }), new Map(), 0);
    expect(out[0]!.mode).not.toBe("bar");
    // …whereas a HARD box (the speaker, the Survivors plate) is never overlapped, whatever it costs
    const hard = layoutPlates([item(0, 400, 120)], env({ reserved: [feed] }), new Map(), 0);
    expect(hard[0]!.mode).toBe("bar");
  });

  it("a hero that wants the full plate gets it when there is room, and drops to a smaller one when it must", () => {
    const wantFull = (slot: number, ax: number, ay: number) => item(slot, ax, ay, { want: "full" });
    const roomy = layoutPlates([wantFull(0, 200, 300), wantFull(1, 600, 300)], env(), new Map(), 0);
    expect(roomy.map((p) => p.mode)).toEqual(["full", "full"]);
    const crowded = layoutPlates(Array.from({ length: 8 }, (_, i) => wantFull(i, 390 + (i % 4) * 14, 300 + Math.floor(i / 4) * 16)), env(), new Map(), 0);
    expect(crowded.some((p) => p.mode !== "full")).toBe(true);
    expect(named(crowded).length).toBeGreaterThanOrEqual(5);
    expect(noOverlaps(crowded)).toBe(true);
  });

  it("is deterministic: the same heroes in the same places always give the same plates", () => {
    const items = Array.from({ length: 8 }, (_, i) => item(i, 300 + i * 31, 300 + ((i * 17) % 40)));
    const a = layoutPlates(items, env(), new Map(), 0);
    const b = layoutPlates([...items].reverse(), env(), new Map(), 0);
    expect(a.map((p) => [p.slot, p.mode, p.key, Math.round(p.rect.x), Math.round(p.rect.y)])).toEqual(b.map((p) => [p.slot, p.mode, p.key, Math.round(p.rect.x), Math.round(p.rect.y)]));
  });
});

/** Plays a scripted fight: each frame a function gives every hero's position; returns the plates per frame. */
function play(frames: number, at: (f: number) => Array<[number, number, number]>, over: Partial<PlateEnv> = {}, stepMs = 50) {
  const states = new Map<number, PlateState>();
  const out: Placement[][] = [];
  for (let f = 0; f < frames; f++) {
    const items = at(f).map(([slot, ax, ay]) => item(slot, ax, ay));
    out.push(layoutPlates(items, { ...env({ immediate: false, dtMs: stepMs }), ...over }, states, f * stepMs));
  }
  return out;
}

describe("layoutPlates: stable — no jitter, no hopping", () => {
  const center = (p: Placement) => ({ x: p.rect.x + p.rect.w / 2, y: p.rect.y + p.rect.h / 2 });

  it("a hero running past another: the plate follows smoothly, and the one unavoidable side change (past the other's plate) LANDS and fades in — it never hops at full strength", () => {
    const frames = play(60, (f) => [[0, 400, 320], [1, 700 - f * 10, 316]]);
    let hops = 0;
    for (let f = 1; f < frames.length; f++) {
      const a = center(frames[f - 1]!.find((p) => p.slot === 1)!);
      const pb = frames[f]!.find((p) => p.slot === 1)!;
      const b = center(pb);
      if (Math.hypot(a.x - b.x, a.y - b.y) > M.u(26)) {
        hops++;
        expect(pb.alpha).toBeLessThan(1); // a big jump only ever happens as a landing, fading in
      }
    }
    expect(hops).toBeLessThanOrEqual(2);
  });

  it("two heroes brushing against each other all fight long do not make the names flicker between modes", () => {
    const wobble = (f: number): Array<[number, number, number]> => [[0, 400, 320], [1, 400 + 70 + 22 * Math.sin(f / 3), 316]];
    const frames = play(200, wobble);
    let modeSwitches = 0;
    for (let f = 1; f < frames.length; f++) {
      const a = frames[f - 1]!.find((p) => p.slot === 1)!;
      const b = frames[f]!.find((p) => p.slot === 1)!;
      if (a.mode !== b.mode) modeSwitches++;
    }
    expect(modeSwitches).toBeLessThanOrEqual(2);
    expect(frames.every(noOverlaps)).toBe(true);
  });

  it("a plate that stepped aside stays aside for a moment after the way clears (≈ 0.3 s), then goes home — heroes brushing past do not make a name flick", () => {
    // A (in front) stands against B for 10 frames; then A walks away. B's natural spot is free from frame 10.
    const frames = play(30, (f) => (f < 10 ? [[0, 400, 320], [1, 410, 316]] : [[0, 400 + (f - 9) * 60, 320], [1, 410, 316]]));
    const b = (f: number) => frames[f]!.find((p) => p.slot === 1)!;
    expect(b(9).key).not.toBe("home");
    for (const f of [10, 11, 12, 13, 14, 15]) expect(b(f).key, `frame ${f}`).not.toBe("home"); // 6 × 50 ms = the 0.3 s hold
    expect(b(18).key).toBe("home");
    expect(b(29).key).toBe("home");
    expect(frames.every(noOverlaps)).toBe(true);
  });

  it("…and if the neighbour comes back within that moment, the plate is where it was: no flick", () => {
    // frames 10–12: A leaves (B's spot free); frame 13 on: A is back against B
    const at = (f: number): Array<[number, number, number]> => (f >= 10 && f < 13 ? [[0, 800, 320], [1, 410, 316]] : [[0, 400, 320], [1, 410, 316]]);
    const frames = play(30, at);
    const keys = frames.map((fr) => fr.find((p) => p.slot === 1)!.key);
    const side = keys[9];
    expect(side).not.toBe("home");
    for (let f = 9; f < 30; f++) expect(keys[f]).toBe(side);
  });

  it("a plate never glides across a neighbour: when it cannot ease there, it lands (and fades in) instead of hopping through", () => {
    const frames = play(40, (f) => [[0, 400, 320], [1, f < 20 ? 520 : 290, 316]]);
    for (const fr of frames) expect(noOverlaps(fr)).toBe(true);
    const landed = frames.flatMap((fr) => fr.filter((p) => p.slot === 1 && p.alpha < 1));
    for (const p of landed) {
      expect(p.alpha).toBeGreaterThanOrEqual(0.35 - 1e-9);
      expect(p.alpha).toBeLessThan(1);
    }
    expect(frames[39]!.find((p) => p.slot === 1)!.alpha).toBe(1); // …and is fully there in the end
  });

  it("before the bell (immediate) every plate lands exactly where it belongs, with no easing and no fade", () => {
    const [a, b] = layoutPlates([item(0, 400, 320), item(1, 410, 316)], env({ immediate: true }), new Map(), 1000);
    for (const p of [a!, b!]) {
      expect(p.alpha).toBe(1);
      expect(p.rect.x).toBeCloseTo(p.target.x, 6);
      expect(p.rect.y).toBeCloseTo(p.target.y, 6);
    }
  });
});

describe("layoutPlates: names follow their hero", () => {
  it("a plate's natural spot moves with the hero frame by frame (no lag: it is glued to the head)", () => {
    const frames = play(30, (f) => [[0, 100 + f * 20, 300 + f]]);
    frames.forEach((fr, f) => {
      const p = fr[0]!;
      expect(p.rect.x + p.rect.w / 2).toBeCloseTo(100 + f * 20, 3);
      expect(p.rect.y + p.rect.h).toBeCloseTo(300 + f, 3);
    });
  });

  it("every plate is within about a plate-width and two rows of its hero's head", () => {
    const items = Array.from({ length: 8 }, (_, i) => item(i, 330 + (i % 4) * 40, 380 + Math.floor(i / 4) * 40));
    const out = layoutPlates(items, env(), new Map(), 0);
    for (const p of named(out)) {
      const it = items.find((x) => x.slot === p.slot)!;
      expect(Math.abs(p.rect.x + p.rect.w / 2 - it.ax)).toBeLessThanOrEqual(p.rect.w * 1.2 + 0.01);
      expect(it.ay - (p.rect.y + p.rect.h)).toBeLessThanOrEqual((p.rect.h + M.u(2)) * 2.2 + 0.01);
      expect(it.ay - (p.rect.y + p.rect.h)).toBeGreaterThanOrEqual(-0.01); // never below the head
    }
  });
});

describe("a mode never changes by accident", () => {
  it.each<[PlateMode, PlateMode]>([["full", "compact"], ["compact", "tag"]])("%s ranks richer than %s", (a, b) => {
    expect(MODE_RANK[a]).toBeLessThan(MODE_RANK[b]);
  });
});
