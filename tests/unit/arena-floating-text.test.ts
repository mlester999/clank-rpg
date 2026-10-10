import { describe, expect, it } from "vitest";

import { makeHarness, playFight, stageFor, type Harness } from "../support/stageHarness";

/**
 * FLOATING NUMBERS vs NAME PLATES — a damage number (or a heal) is never drawn on top of a hero's name. The real ArenaRenderer, a recording canvas and
 * real simulated fights, played at 60 fps. Before this rule a number rose from its own plate straight through the plate of whoever stood above it in a
 * crowd ("Wiz20", "Pix10"), because plates are now on screen for the whole fight and wide enough to be in the way.
 */
const SEEDS = ["a", "b", "c", "d"] as const;
const px = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);

interface Tally {
  numbers: number;
  onPlate: number;
  outside: number;
}

/** Plays whole fights and counts the number draws that overlap a plate drawn in the same frame. `blind` makes the renderer ignore plates (the old behaviour). */
function tally(viewport: number, blind = false): Tally {
  const { w, h } = stageFor(viewport);
  const t: Tally = { numbers: 0, onPlate: 0, outside: 0 };
  for (const seed of SEEDS) {
    const hn: Harness = makeHarness(seed, w, h);
    if (blind) Object.defineProperty(hn.renderer, "plateBoxes", { get: () => [], set: () => undefined });
    const st = hn.renderer.stage;
    playFight(
      hn,
      (_now, phase) => {
        if (phase !== "COMBAT") return;
        const plates = hn.renderer.plates.filter((p) => p.mode !== "bar");
        for (const c of hn.calls) {
          if (c.op !== "fillText" || !/^\+?\d{1,4}$/.test(c.text)) continue;
          const size = px(c.font) * c.scale;
          const tw = c.text.length * size * 0.56;
          const box = { x: c.x - tw / 2, y: c.y - size, w: tw, h: size };
          t.numbers++;
          if (box.x < -0.5 || box.x + box.w > st.layoutW + 0.5 || box.y < -0.5 || box.y + box.h > st.layoutH + 0.5) t.outside++;
          // an overlap of more than a couple of layout units on both axes (the glyph's own side bearings are not "on" a plate)
          if (plates.some((p) => box.x < p.rect.x + p.rect.w - 2 && box.x + box.w > p.rect.x + 2 && box.y < p.rect.y + p.rect.h - 2 && box.y + box.h > p.rect.y + 2)) t.onPlate++;
        }
      },
      16,
    );
  }
  return t;
}

describe.each([320, 390, 768, 1440])("at a %i px wide viewport", (vw) => {
  it("numbers keep off the name plates (≥ 97 % of every number drawn; the rest is the ~50 ms glide away from a plate that just moved under one) and inside the stage", () => {
    const t = tally(vw);
    expect(t.numbers).toBeGreaterThan(300);
    expect(t.outside).toBe(0);
    expect(t.onPlate / t.numbers).toBeLessThanOrEqual(0.03);
  });
});

describe("the check has teeth", () => {
  it("with the plate-avoidance switched off, a phone-sized stage has far more numbers sitting on plates", () => {
    const on = tally(390);
    const off = tally(390, true);
    expect(off.onPlate / off.numbers).toBeGreaterThan(0.05);
    expect(off.onPlate / off.numbers).toBeGreaterThan((on.onPlate / on.numbers) * 10);
  });
});
