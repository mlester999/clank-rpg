import { readFileSync } from "node:fs";
import path from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";

import { HeroSheet, type SpriteSource } from "@/components/sprites/compositor";
import { ensureSpriteSet, getLibraryState, resetSpriteLibrary, retrySpriteSetNow } from "@/components/sprites/library";
import { rollAppearance, type Rarity } from "@/domain/character/appearance";
import { DEFAULT_CLASSES } from "@/domain/content";
import { deriveSpriteConfig, resolvePalette, type SpriteConfig } from "@/domain/sprites/config";
import { planImages, planLayers, rigOf, variantOf } from "@/domain/sprites/plan";
import { parseManifest, safeParseManifest, type SpriteManifest } from "@/domain/sprites/spec";
import { createRng } from "@/domain/util/rng";

import { CLASS_RIGS, FEET_Y, joints, poseFor, RIG_IDS, type ClipName, type RigId } from "../../scripts/sprites/v2/rig";
import { makeManifest } from "../support/sprites";

/**
 * HERO RENDERER v2 — ARCHETYPE SKELETONS. Each class is drawn on three skeletons (a build, a stance, a grip and a pose language each); a hero's
 * archetype is a pure function of its never-rerolled look, like every design choice. These tests guard the contract (determinism, no rerolls,
 * independence, lazily loaded pages) and the mechanics of the poses (two-handed grips that reach, weapons that fall flat, grounded feet). What
 * the heroes look like is judged on the rendered sheets.
 */

const cls = (id: string) => DEFAULT_CLASSES.find((c) => c.id === id)!;
const configOf = (id: string, seed: string, rarity: Rarity = "COMMON"): SpriteConfig => deriveSpriteConfig(rollAppearance(createRng(seed), cls(id), rarity), cls(id).look, rarity);
const shipped = (): SpriteManifest => parseManifest(JSON.parse(readFileSync(path.join(process.cwd(), "public", "sprites", "clank-dev-v2", "manifest.json"), "utf8")));
const WEAPON: Record<string, string> = { warrior: "weapon.sword", tank: "weapon.mace", rogue: "weapon.daggers", ranger: "weapon.bow", mage: "weapon.staff", cleric: "weapon.tome" };

afterEach(() => resetSpriteLibrary());

describe("the archetype contract (synthetic set)", () => {
  function archetypes(): SpriteManifest {
    const m = makeManifest({ rigs: ["warrior", "warrior-brute", "warrior-duelist", "ranger"] });
    m.layers["weapon.sword"] = { ...m.layers["weapon.sword"]!, rig: "warrior", builds: ["warrior", "warrior-brute", "warrior-duelist"] };
    m.layers["weapon.bow"] = { ...m.layers["weapon.bow"]!, rig: "ranger", muzzle: { x: 50, y: 30 }, muzzles: { ranger: { x: 52, y: 31 } } };
    return parseManifest(m);
  }

  it("a hero's archetype is one of its weapon's builds, chosen from the never-rerolled look only (restyled eyes, hair or accessory change nothing)", () => {
    const m = archetypes();
    const counts = new Map<string, number>();
    for (let i = 0; i < 600; i++) {
      const cfg = configOf("warrior", `arch-${i}`);
      const rig = rigOf(cfg, m) as string;
      counts.set(rig, (counts.get(rig) ?? 0) + 1);
      const restyled: SpriteConfig = { ...cfg, slots: { ...cfg.slots, eyes: "eyes.3", mouth: "mouth.2", hair: "hair.4", accessory: "accessory.monocle" } };
      expect(rigOf(restyled, m)).toBe(rig);
      expect(rigOf(structuredClone(cfg), m)).toBe(rig);
    }
    expect([...counts.keys()].sort()).toEqual(["warrior", "warrior-brute", "warrior-duelist"]);
    for (const [rig, n] of counts) expect(n / 600, rig).toBeGreaterThan(0.25);
  });

  it("a weapon without builds keeps its own skeleton; a set without skeletons draws on none", () => {
    expect(rigOf(configOf("ranger", "r"), archetypes())).toBe("ranger");
    expect(rigOf(configOf("warrior", "w"), makeManifest())).toBeNull();
  });

  it("the muzzle is the archetype's own (a warden and a skirmisher hold a bow differently), else the weapon's", () => {
    const m = archetypes();
    expect(planLayers(configOf("ranger", "r"), m).muzzle).toEqual({ x: 52, y: 31 });
    const own = structuredClone(m);
    delete own.layers["weapon.bow"]!.muzzles;
    expect(planLayers(configOf("ranger", "r"), own).muzzle).toEqual({ x: 50, y: 30 });
  });

  it("a manifest naming a build or a muzzle skeleton it does not have is rejected", () => {
    const a = makeManifest({ rigs: ["warrior"] });
    a.layers["weapon.sword"] = { ...a.layers["weapon.sword"]!, builds: ["warrior", "ghost"] };
    expect(safeParseManifest(a).ok).toBe(false);
    const b = makeManifest({ rigs: ["warrior"] });
    b.layers["weapon.bow"] = { ...b.layers["weapon.bow"]!, muzzles: { ghost: { x: 1, y: 1 } } };
    expect(safeParseManifest(b).ok).toBe(false);
  });

  it("palette tones are opt-in per set and keyed on the never-rerolled look: v1 colours are untouched", () => {
    const colors = cls("warrior").look.colors;
    const cfg = configOf("warrior", "tone");
    expect(resolvePalette(cfg, colors, "COMMON").primary).toBe(resolvePalette(cfg, colors, "COMMON", { tones: false }).primary);
    const tones = new Set(Array.from({ length: 80 }, (_, i) => resolvePalette(configOf("warrior", `tone-${i}`), colors, "COMMON", { tones: true }).primary));
    const plain = new Set(Array.from({ length: 80 }, (_, i) => resolvePalette(configOf("warrior", `tone-${i}`), colors, "COMMON").primary));
    expect(tones.size).toBeGreaterThan(plain.size);
  });
});

// ------------------------------------------------------------------------------------------------ lazily loaded pages

/** A packed set with two skeletons, each its own page, plus a block-layout aura on an atlas of its own. */
function packedSet(): SpriteManifest {
  const base = makeManifest({ spec: 2, rigs: ["a", "b"], images: { atlas: "atlas.png", "a-0": "a-0-x.png", "b-0": "b-0-x.png" } });
  const row = (img: string) => [img, "0,0,4,4,1,1;0,0,4,4,1,1;0,0,4,4,1,1;0,0,4,4,1,1"] as [string, string];
  base.layers = {
    "body.base": { z: 10, tint: "skin", cells: { a: [row("a-0")], b: [row("b-0")] } },
    "outfit.medium": { z: 20, tint: "primary", cells: { a: [row("a-0")], b: [row("b-0")] } },
    "weapon.sword": { z: 70, tint: null, attack: "attack_slash", rig: "a", builds: ["a", "b"], cells: { a: [], b: [] } },
    "aura.ring": { image: "atlas", x: 0, y: 0, z: -5, tint: "rarity", loop: { frames: 8, fps: 10 } },
  };
  return parseManifest(base);
}

function lazyHarness(fail: (url: string) => boolean = () => false) {
  const urls: string[] = [];
  const deps = {
    base: "/sprites/packed",
    factory: (w: number, h: number) => createCanvas(w, h) as unknown as HTMLCanvasElement,
    fetchJson: async () => packedSet(),
    loadImage: async (url: string) => {
      urls.push(url);
      if (fail(url)) throw new Error("404");
      return createCanvas(8, 8) as unknown as CanvasImageSource;
    },
    schedule: () => undefined,
  };
  return { deps, urls };
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("a packed set loads only the skeleton pages of the heroes drawn", () => {
  it("ready with the manifest (and the block-layout atlas); a page is fetched the first time a hero asks for it, once, and bumps `rev`", async () => {
    const h = lazyHarness();
    const s = await ensureSpriteSet("packed", h.deps);
    expect(s.status).toBe("ready");
    expect(h.urls).toEqual(["/sprites/packed/atlas.png"]);
    const src = s.source!;
    expect(src.ensure!(["a-0"])).toBe("loading");
    expect(src.ensure!(["a-0"])).toBe("loading"); // not fetched twice
    await flush();
    expect(src.ensure!(["a-0"])).toBe("ready");
    expect(h.urls).toEqual(["/sprites/packed/atlas.png", "/sprites/packed/a-0-x.png"]); // b's page was never needed
    expect(getLibraryState("packed").rev).toBe(1);
  });

  it("a hero is composed only once its page is here — a strip asked for earlier is NOT cached incomplete", async () => {
    const h = lazyHarness();
    const src = (await ensureSpriteSet("packed", h.deps)).source as SpriteSource;
    const cfg = configOf("warrior", "lazy");
    const sheet = new HeroSheet(src, cfg, cls("warrior").look.colors, "COMMON");
    expect(sheet.images).toEqual([`${sheet.plan.rig}-0`]);
    expect(sheet.pending).toBe(true);
    expect(sheet.needsFallback).toBe(false); // waiting is not failing: no vector hero flashes in
    expect(sheet.strip("idle")).toBeNull();
    await flush();
    expect(sheet.pending).toBe(false);
    expect(sheet.strip("idle")).not.toBeNull();
    expect(sheet.isComposed("idle")).toBe(true);
  });

  it("a page that fails every try draws its heroes with the vector fallback — and gets another chance when the network comes back", async () => {
    let down = true;
    const h = lazyHarness((url) => down && url.includes("b-0"));
    const src = (await ensureSpriteSet("packed", h.deps)).source as SpriteSource;
    expect(src.ensure!(["b-0"])).toBe("loading");
    await flush();
    expect(src.ensure!(["b-0"])).toBe("failed");
    expect(getLibraryState("packed").failedAtlases).toEqual(["b-0"]);
    down = false;
    retrySpriteSetNow("packed", h.deps); // 'online' / 'visibilitychange'
    expect(src.ensure!(["b-0"])).toBe("loading");
    await flush();
    expect(src.ensure!(["b-0"])).toBe("ready");
  });
});

// ------------------------------------------------------------------------------------------------ the shipped set

describe("the shipped v2 set: eighteen skeletons, three per class", () => {
  const m = shipped();

  it("every class weapon animates on its class's three skeletons, and every class design is drawn on all three", () => {
    expect(m.rigs).toEqual([...RIG_IDS]);
    for (const c of DEFAULT_CLASSES) {
      const rigs = CLASS_RIGS[c.id as keyof typeof CLASS_RIGS];
      expect(m.layers[WEAPON[c.id]!]!.builds, c.id).toEqual([...rigs]);
      for (const v of m.layers[WEAPON[c.id]!]!.variants ?? []) for (const r of rigs) expect(m.layers[v]!.cells?.[r], `${v} on ${r}`).toBeDefined();
    }
  });

  it("each class's heroes spread over its three archetypes (≥ 22 % each of 300), independently of the helm, the torso and the weapon design", () => {
    for (const c of DEFAULT_CLASSES) {
      const counts = new Map<string, number>();
      const helmByRig = new Map<string, Set<string>>();
      for (let i = 0; i < 300; i++) {
        const cfg = configOf(c.id, `spread-${c.id}-${i}`);
        const plan = planLayers(cfg, m, "COMMON");
        const rig = plan.rig as string;
        counts.set(rig, (counts.get(rig) ?? 0) + 1);
        const helm = variantOf(cfg, cfg.slots.headgear!, m, { rarity: "COMMON", rig });
        helmByRig.set(helm, (helmByRig.get(helm) ?? new Set()).add(rig));
      }
      expect(counts.size, c.id).toBe(3);
      for (const [rig, n] of counts) expect(n / 300, `${c.id} ${rig}`).toBeGreaterThan(0.22);
      for (const [helm, rigs] of helmByRig) expect(rigs.size, `${c.id}: ${helm} is worn on every archetype`).toBe(3);
    }
  });

  it("a hero needs only its own skeleton's page (and the auras): an arena of eight never loads the whole library", () => {
    for (const c of DEFAULT_CLASSES) {
      const plan = planLayers(configOf(c.id, `pages-${c.id}`, "LEGENDARY"), m, "LEGENDARY");
      const pages = planImages(plan);
      expect(pages.filter((p) => p !== "auras"), `${c.id}: ${pages.join(",")}`).toEqual([`${plan.rig}-0`]);
    }
  });

  it("shooting weapons know where the shot leaves on EVERY archetype (a warden's longbow, a skirmisher's shortbow, a monk's staff)", () => {
    for (const cid of ["ranger", "mage", "cleric"]) {
      for (const v of m.layers[WEAPON[cid]!]!.variants!) {
        for (const r of CLASS_RIGS[cid as keyof typeof CLASS_RIGS]) expect(m.layers[v]!.muzzles?.[r], `${v} on ${r}`).toBeDefined();
      }
    }
  });
});

describe("the archetype poses (forward kinematics)", () => {
  const clips: ClipName[] = ["idle", "idle2", "move", "attack_slash", "attack_thrust", "attack_shoot", "skill", "hit", "victory"];
  const dist = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  it("a two-handed grip REACHES: the back hand is on the weapon in every frame that holds it in both hands", () => {
    let checked = 0;
    for (const rig of RIG_IDS) {
      for (const clip of clips) {
        for (let f = 0; f < 6; f++) {
          const p = poseFor(clip, f, rig);
          if (p.gripB === undefined) continue;
          const j = joints(p, rig);
          const target: [number, number] = [j.handF[0] + j.weaponDir[0] * p.gripB, j.handF[1] + j.weaponDir[1] * p.gripB];
          expect(dist(j.handB, target), `${rig} ${clip} ${f}`).toBeLessThan(1.2);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("standing stances are planted: the lowest foot (or knee) is ON the floor line in every frame — breathing never lifts the feet", () => {
    for (const rig of RIG_IDS) {
      for (const clip of ["idle", "idle2"] as ClipName[]) {
        if (rig === "rogue-brawler" && clip === "idle") continue; // the brawler bounces on his toes on purpose
        for (let f = 0; f < 6; f++) {
          const j = joints(poseFor(clip, f, rig), rig);
          const lowest = Math.max(j.footF[1], j.footB[1], j.kneeF[1], j.kneeB[1]);
          expect(Math.abs(lowest - FEET_Y), `${rig} ${clip} ${f}`).toBeLessThan(0.01);
        }
      }
    }
  });

  it("a knocked-out hero's weapon lies along the ground — it never sticks up out of the body", () => {
    for (const rig of RIG_IDS as readonly RigId[]) {
      const j = joints(poseFor("ko", 5, rig), rig);
      expect(Math.abs(j.weaponDir[1]), rig).toBeLessThan(0.45);
    }
  });
});
