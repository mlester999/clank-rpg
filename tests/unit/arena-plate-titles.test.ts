import { describe, expect, it } from "vitest";

import { plateMetrics, plateSizes } from "@/components/arena/nameplates";

/**
 * The hero's chosen TITLE on the stage's name plate: a line ABOVE the name, on the full plate always and on the compact plate when the stage is wide enough.
 * The tag and bar fallbacks never carry it, so a crowd that squeezes plates can always still show every name.
 */
const wide = plateMetrics(1000, 1000);
const phone = plateMetrics(366, 800);
const charW = (m: { nameFs: number }) => m.nameFs * 0.56;

describe("plate sizes with a title", () => {
  it("without a title nothing changes (an omitted title is a zero-width one)", () => {
    for (const m of [wide, phone]) {
      expect(plateSizes(m, 8 * charW(m), 6 * charW(m) * 0.74)).toEqual(plateSizes(m, 8 * charW(m), 6 * charW(m) * 0.74, 0));
    }
  });

  it("the full plate is one sub-line taller with a title; the compact plate only on a wide stage", () => {
    const plain = plateSizes(wide, 8 * charW(wide), 5 * charW(wide));
    const titled = plateSizes(wide, 8 * charW(wide), 5 * charW(wide), 10 * charW(wide));
    expect(titled.full.h).toBeCloseTo(plain.full.h + wide.subFs * 1.15, 6);
    expect(wide.titleInCompact).toBe(true);
    expect(titled.compact.h).toBeCloseTo(plain.compact.h + wide.subFs * 1.15, 6);

    const phonePlain = plateSizes(phone, 8 * charW(phone), 5 * charW(phone));
    const phoneTitled = plateSizes(phone, 8 * charW(phone), 5 * charW(phone), 10 * charW(phone));
    expect(phone.titleInCompact).toBe(false);
    expect(phoneTitled.compact).toEqual(phonePlain.compact); // a phone's compact plate stays as small as before
    expect(phoneTitled.full.h).toBeCloseTo(phonePlain.full.h + phone.subFs * 1.15, 6);
  });

  it("a long title widens the plate that carries it, never the tag or the bar", () => {
    const longTitle = 24 * charW(wide);
    const plain = plateSizes(wide, 6 * charW(wide), 5 * charW(wide));
    const titled = plateSizes(wide, 6 * charW(wide), 5 * charW(wide), longTitle);
    expect(titled.full.w).toBeGreaterThan(plain.full.w);
    expect(titled.compact.w).toBeGreaterThan(plain.compact.w);
    expect(titled.tag).toEqual(plain.tag);
    expect(titled.bar).toEqual(plain.bar);
  });

  it("the modes still shrink in order with a title: full ≥ compact ≥ tag ≥ bar", () => {
    for (const m of [wide, phone]) {
      const s = plateSizes(m, 9 * charW(m), 6 * charW(m), 14 * charW(m));
      expect(s.full.h).toBeGreaterThan(s.compact.h);
      expect(s.compact.h).toBeGreaterThan(s.tag.h);
      expect(s.tag.h).toBeGreaterThan(s.bar.h);
      expect(s.full.w).toBeGreaterThanOrEqual(s.compact.w);
    }
  });

  it("only a stage with room for the extra line shows the title on compact plates", () => {
    expect(plateMetrics(559, 800).titleInCompact).toBe(false);
    expect(plateMetrics(560, 1000).titleInCompact).toBe(true);
  });
});
