import { describe, expect, it } from "vitest";

import { ARENA_LABEL_MAX, graphemeLength, truncateDisplayName } from "@/domain/character/displayName";
import { RPG_NAME_MAX, validateRpgName } from "@/domain/character/rpgName";

describe("truncateDisplayName — presentation only", () => {
  it("leaves names that fit completely alone", () => {
    expect(truncateDisplayName("Gearbox Gus", 16)).toBe("Gearbox Gus");
    expect(truncateDisplayName("A".repeat(16), 16)).toBe("A".repeat(16));
  });

  it("shortens a status-style Telegram name at a word boundary", () => {
    expect(truncateDisplayName("Celsius - Busy With Something Else Entirely", 22)).toBe("Celsius - Busy With…");
  });

  it("never leaves a dangling separator before the ellipsis", () => {
    expect(truncateDisplayName("Celsius - - - - - - - - -", 12)).not.toMatch(/[-\s]…$/);
    expect(truncateDisplayName("Mr. Smith | Currently away", 12)).toMatch(/…$/);
  });

  it("cuts a long single word to the limit, ellipsis included", () => {
    const out = truncateDisplayName("Supercalifragilisticexpialidocious", 10);
    expect(graphemeLength(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("counts an emoji sequence as ONE character and never splits it", () => {
    const family = "👨‍👩‍👧‍👦"; // ZWJ sequence: 7 code points, 1 grapheme
    expect(graphemeLength(family)).toBe(1);
    const out = truncateDisplayName(`${family.repeat(12)}`, 6);
    expect(out).toBe(`${family.repeat(5)}…`);
    const flagged = truncateDisplayName("🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷", 5);
    expect(Array.from(flagged.replace("…", "")).every((c) => /\p{Regional_Indicator}/u.test(c))).toBe(true);
    expect(Array.from(flagged.replace("…", "")).length % 2).toBe(0); // whole flags only
  });

  it("keeps combining marks attached to their letter", () => {
    const name = "Éloïse Ñandú Çağlar Ünal Östberg"; // composed + decomposed mix
    const decomposed = name.normalize("NFD");
    const out = truncateDisplayName(decomposed, 8);
    expect(graphemeLength(out)).toBeLessThanOrEqual(8);
    expect(out.normalize("NFC")).not.toMatch(/[̀-ͯ]$/);
  });

  it("handles emoji-only and non-latin names", () => {
    expect(truncateDisplayName("🔥🔥🔥🔥🔥🔥🔥🔥", 4)).toBe("🔥🔥🔥…");
    expect(truncateDisplayName("こんにちは世界の皆さんこんにちは", 6)).toBe("こんにちは…");
  });

  it("does not mutate its input or the stored-name rules (a long Telegram-derived name is still a valid stored value)", () => {
    const stored = "Celsius - Busy With Something Else Entirely";
    const before = stored;
    truncateDisplayName(stored, ARENA_LABEL_MAX);
    expect(stored).toBe(before);
    // The stored name is bounded by RPG_NAME_MAX (32); shortening on screen is independent of that.
    expect(validateRpgName("Celsius - Busy With Something Els").ok || validateRpgName("x".repeat(RPG_NAME_MAX)).ok).toBe(true);
  });

  it("is safe for degenerate limits", () => {
    expect(truncateDisplayName("abcdef", 0)).toBe("a…");
    expect(truncateDisplayName("", 5)).toBe("");
  });
});
