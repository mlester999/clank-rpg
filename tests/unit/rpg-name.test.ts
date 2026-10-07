import { describe, expect, it } from "vitest";

import { isFallbackName, RPG_NAME_MAX, validateRpgName } from "@/domain/character/rpgName";

const ok = (raw: unknown) => {
  const r = validateRpgName(raw);
  if (!r.ok) throw new Error(`expected valid, got ${r.problem}`);
  return r.name;
};
const problem = (raw: unknown) => {
  const r = validateRpgName(raw);
  return r.ok ? null : r.problem;
};

describe("RPG display-name validation", () => {
  it("accepts ordinary names and trims / collapses spaces", () => {
    expect(ok("NuggetMage")).toBe("NuggetMage");
    expect(ok("  Nugget   Mage  ")).toBe("Nugget Mage");
  });

  it("keeps normal Unicode and emoji — Telegram identities legitimately contain them", () => {
    expect(ok("奶白的雪子")).toBe("奶白的雪子");
    expect(ok("Rémois ⚔️")).toBe("Rémois ⚔️");
    expect(ok("🥰")).toBe("🥰"); // emoji-only is a real name here (it is only the AUTO-generated fallback that avoids it)
    expect(ok("👩‍🚀 Ada")).toBe("👩‍🚀 Ada"); // zero-width joiner inside an emoji sequence is allowed
    expect(ok("Café".normalize("NFD"))).toBe("Café".normalize("NFC")); // normalised
  });

  it("rejects empty and whitespace-only names", () => {
    expect(problem("")).toBe("EMPTY");
    expect(problem("   ")).toBe("EMPTY");
    expect(problem(null)).toBe("EMPTY");
    expect(problem(42)).toBe("EMPTY");
  });

  it("enforces a practical maximum in code points, not UTF-16 units", () => {
    expect(ok("a".repeat(RPG_NAME_MAX))).toHaveLength(RPG_NAME_MAX);
    expect(problem("a".repeat(RPG_NAME_MAX + 1))).toBe("TOO_LONG");
    expect(problem("x".repeat(5000))).toBe("TOO_LONG");
    expect(ok("🥰".repeat(RPG_NAME_MAX))).toBeTruthy(); // 32 emoji = 64 UTF-16 units, still 32 characters
    expect(problem("🥰".repeat(RPG_NAME_MAX + 1))).toBe("TOO_LONG");
  });

  it("rejects control, bidi-override and invisible formatting characters", () => {
    for (const bad of ["a\u0000b", "a\nb", "a\tb", "a‮b", "a⁦b", "a​b", "﻿ab", "a\u0085b", "a\u007Fb"]) {
      expect(problem(bad), JSON.stringify(bad)).toBe("CONTROL_CHARACTERS");
    }
  });

  it("rejects markup characters and names with nothing a person can see", () => {
    expect(problem("<script>alert(1)</script>")).toBe("MARKUP");
    expect(problem("a`b")).toBe("MARKUP");
    expect(problem("---")).toBe("NO_VISIBLE_CHARACTERS");
    expect(problem("   !!!   ")).toBe("NO_VISIBLE_CHARACTERS");
  });

  it("recognises the generated fallback name", () => {
    expect(isFallbackName("Wanderer 1234")).toBe(true);
    expect(isFallbackName("Wanderer 12")).toBe(false);
    expect(isFallbackName("NuggetMage")).toBe(false);
  });
});
