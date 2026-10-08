import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { rollAppearance } from "@/domain/character/appearance";
import { DEFAULT_CLASSES } from "@/domain/content";
import { deriveSpriteConfig, type SpriteConfig } from "@/domain/sprites/config";
import { planLayers, stableHash, variantOf } from "@/domain/sprites/plan";
import { parseManifest, safeParseManifest, type SpriteManifest } from "@/domain/sprites/spec";
import { createRng } from "@/domain/util/rng";

import { makeManifest } from "../support/sprites";

/**
 * ITEM VARIANTS (hero renderer v2): a set may draw a class item more than one way (`variants` on its layer). Which drawing a hero wears is a pure
 * function of the never-rerolled parts of its stored look (skin, hair colour, hue) — so same-class heroes differ, and each keeps its drawing forever.
 */

const cls = (id: string) => DEFAULT_CLASSES.find((c) => c.id === id)!;
const configFor = (id: string, seed: string): SpriteConfig => deriveSpriteConfig(rollAppearance(createRng(`${seed}-${id}`), cls(id), "COMMON"), cls(id).look);

/** The synthetic set with a second sword and helm, a kit part on the sword and a part that only the second sword has. */
function withVariants(): SpriteManifest {
  const m = makeManifest();
  const atlas = { image: "atlas", x: 0, y: 0 };
  m.layers["weapon.sword"] = { ...m.layers["weapon.sword"]!, variants: ["weapon.sword.b"] };
  m.layers["weapon.sword.b"] = { ...atlas, z: 70, tint: null, attack: "attack_slash" };
  m.layers["weapon.sword.kit"] = { ...atlas, z: 7, tint: null, of: "weapon.sword" };
  m.layers["weapon.sword.b.gem"] = { ...atlas, z: 71, tint: null, of: "weapon.sword.b" };
  m.layers["headgear.helm"] = { ...m.layers["headgear.helm"]!, variants: ["headgear.helm.b"] };
  m.layers["headgear.helm.b"] = { ...atlas, z: 60, tint: null };
  return m;
}

describe("item variants", () => {
  it("the hash is pinned (a hero's drawing must never change between releases)", () => {
    expect([stableHash(""), stableHash("weapon.sword|0|0|0"), stableHash("headgear.helm|3|2|-15")]).toEqual([2872998923, 1947576290, 1640693964]);
  });

  it("no variants → the item itself (v1, and any item a set draws once)", () => {
    const cfg = configFor("warrior", "a");
    expect(variantOf(cfg, "weapon.sword", makeManifest())).toBe("weapon.sword");
    expect(variantOf(cfg, "weapon.ghost", makeManifest())).toBe("weapon.ghost");
  });

  it("is deterministic, and depends only on skin, hair colour and hue — never on a slot a player can change", () => {
    const m = withVariants();
    const cfg = configFor("warrior", "b");
    const v = variantOf(cfg, "weapon.sword", m);
    expect(variantOf(structuredClone(cfg), "weapon.sword", m)).toBe(v);
    const restyled: SpriteConfig = { ...cfg, slots: { ...cfg.slots, hair: "hair.6", eyes: "eyes.3", accessory: "accessory.monocle" } };
    expect(variantOf(restyled, "weapon.sword", m)).toBe(v);
  });

  it("spreads heroes across the drawings, independently per item (a hero's sword does not decide its helm)", () => {
    const m = withVariants();
    const n = 600;
    const combos = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const cfg = configFor("warrior", `spread-${i}`);
      const k = `${variantOf(cfg, "weapon.sword", m)}|${variantOf(cfg, "headgear.helm", m)}`;
      combos.set(k, (combos.get(k) ?? 0) + 1);
    }
    expect(combos.size).toBe(4);
    for (const count of combos.values()) expect(count / n).toBeGreaterThan(0.12);
  });

  it("the planner draws the chosen variant with the item's own parts (a kit, a quiver) and the variant's parts — never the other drawing", () => {
    const m = withVariants();
    for (let i = 0; i < 40; i++) {
      const cfg = configFor("warrior", `plan-${i}`);
      const chosen = variantOf(cfg, "weapon.sword", m);
      const ids = planLayers(cfg, m).layers.map((l) => l.id);
      expect(ids).toContain(chosen);
      expect(ids).toContain("weapon.sword.kit");
      expect(ids.includes("weapon.sword.b.gem")).toBe(chosen === "weapon.sword.b");
      expect(ids.filter((id) => id === "weapon.sword" || id === "weapon.sword.b")).toEqual([chosen]);
    }
  });

  it("the attack clip and the muzzle come from the drawing the hero wears", () => {
    const m = withVariants();
    m.layers["weapon.bow"] = { ...m.layers["weapon.bow"]!, variants: ["weapon.bow.b"], muzzle: { x: 40, y: 30 } };
    m.layers["weapon.bow.b"] = { image: "atlas", x: 0, y: 0, z: 70, tint: null, attack: "attack_shoot", muzzle: { x: 41, y: 29 } };
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const cfg = configFor("ranger", `bow-${i}`);
      const plan = planLayers(cfg, m);
      expect(plan.attackClip).toBe("attack_shoot");
      seen.add(JSON.stringify(plan.muzzle));
      expect(plan.muzzle).toEqual(variantOf(cfg, "weapon.bow", m) === "weapon.bow.b" ? { x: 41, y: 29 } : { x: 40, y: 30 });
    }
    expect(seen.size).toBe(2);
  });

  it("a manifest naming a variant it does not draw is rejected", () => {
    const m = makeManifest();
    m.layers["weapon.sword"] = { ...m.layers["weapon.sword"]!, variants: ["weapon.sword.ghost"] };
    const r = safeParseManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/variant/);
  });

  describe("the shipped sets", () => {
    const load = (id: string) => parseManifest(JSON.parse(readFileSync(path.join(process.cwd(), "public", "sprites", id, "manifest.json"), "utf8")));

    it("v1 has no variants: every existing v1 hero renders exactly as before", () => {
      expect(Object.values(load("clank-dev-v1").layers).some((l) => l.variants?.length)).toBe(false);
    });

    /** The class items and the skeleton each class is drawn on. */
    const CLASS_ITEMS: Record<string, { rig: string; weapon: string; headgear: string; outfit: string }> = {
      warrior: { rig: "warrior", weapon: "weapon.sword", headgear: "headgear.helm", outfit: "outfit.medium" },
      tank: { rig: "tank", weapon: "weapon.mace", headgear: "headgear.helm", outfit: "outfit.heavy" },
      rogue: { rig: "rogue", weapon: "weapon.daggers", headgear: "headgear.hood", outfit: "outfit.light" },
      ranger: { rig: "ranger", weapon: "weapon.bow", headgear: "headgear.cap", outfit: "outfit.light" },
      mage: { rig: "mage", weapon: "weapon.staff", headgear: "headgear.hat", outfit: "outfit.robe" },
      cleric: { rig: "cleric", weapon: "weapon.tome", headgear: "headgear.halo", outfit: "outfit.robe" },
    };

    it("v2 draws every class item as a DESIGN LIBRARY: at every tier, ≥ 4 designs of the class weapon, headgear and torso on the class's skeleton", () => {
      const m = load("clank-dev-v2");
      for (const [cid, items] of Object.entries(CLASS_ITEMS)) {
        for (const item of [items.weapon, items.headgear, items.outfit]) {
          const designs = (m.layers[item]!.variants ?? []).map((v) => m.layers[v]!).filter((d) => d.cells?.[items.rig]);
          for (const tier of ["COMMON", "RARE", "EPIC", "LEGENDARY"]) expect(designs.filter((d) => d.tiers?.includes(tier as never)).length, `${cid} ${item} ${tier}`).toBeGreaterThanOrEqual(4);
        }
        // weapon designs keep the item's attack clip and the class skeleton; shooting weapons say where the shot leaves
        const base = m.layers[items.weapon]!;
        for (const v of base.variants!) {
          const def = m.layers[v]!;
          expect(def.attack, v).toBe(base.attack);
          expect(def.rig, v).toBe(items.rig);
          expect(Boolean(def.muzzle), v).toBe(["weapon.bow", "weapon.staff", "weapon.tome"].includes(items.weapon));
        }
      }
    });

    it("v2: every class wears its sub-slots (arms and legs; a quiver on every Ranger, pauldrons on every Tank) and 24 same-class heroes wear ≥ 22 different design combinations", () => {
      const m = load("clank-dev-v2");
      for (const c of DEFAULT_CLASSES) {
        const items = CLASS_ITEMS[c.id]!;
        const looks = new Set<string>();
        for (let i = 0; i < 24; i++) {
          const cfg = configFor(c.id, `kit-${i}`);
          const ids = planLayers(cfg, m).layers.map((l) => l.id);
          expect(ids.some((id) => id.startsWith(`${items.outfit}.arms.`)), `${c.id} arms`).toBe(true);
          expect(ids.some((id) => id.startsWith(`${items.outfit}.legs.`)), `${c.id} legs`).toBe(true);
          if (c.id === "ranger") expect(ids.some((id) => id.startsWith("weapon.bow.quiver.")), "quiver").toBe(true);
          if (c.id === "tank") expect(ids.some((id) => id.startsWith("outfit.heavy.shoulders.")), "pauldrons").toBe(true);
          looks.add(ids.filter((id) => /\.[a-z]\d-[a-z]+$/.test(id)).join(","));
        }
        // (a repeated COMBINATION is possible — the Common Mage pool has ~2400 — and the two heroes still differ in face, hair and palette)
        expect(looks.size, c.id).toBeGreaterThanOrEqual(22);
      }
    });
  });
});
