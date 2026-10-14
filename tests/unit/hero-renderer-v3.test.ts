import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";

import { getHeroSheet, HeroSheet, spriteStats, type SpriteSource } from "@/components/sprites/compositor";
import { activeSpriteSet, announceSpriteSet, DEFAULT_SPRITE_SET, ensureSpriteSet, getLibraryState, resetSpriteLibrary, subscribeActiveSpriteSet } from "@/components/sprites/library";
import { rollAppearance, type Rarity } from "@/domain/character/appearance";
import { DEFAULT_CLASSES } from "@/domain/content";
import { cardKey } from "@/domain/hero/card";
import { selectPlayback, type AnimInput } from "@/domain/sprites/animator";
import { deriveSpriteConfig, type SpriteConfig } from "@/domain/sprites/config";
import { rigOf } from "@/domain/sprites/plan";
import { parseManifest } from "@/domain/sprites/spec";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { ARCHETYPE_IDS, BODY_PLANS, standingHeight } from "@/domain/sprites/v3/anatomy";
import { CLIP_ORDER, TIMING, VIEW_ZOOM, WORLD_PER_PX, type ClipKey3 } from "@/domain/sprites/v3/clips";
import { genomeOf } from "@/domain/sprites/v3/genome";
import { ANCHOR, FRAME_H, FRAME_W, heroOf, renderClipFrame, type Hero } from "@/domain/sprites/v3/render";
import { aimDir, ik } from "@/domain/sprites/v3/rig";
import { V3_SET, V3_SET_ID, v3Manifest } from "@/domain/sprites/v3/set";
import { validateFrame, type FrameIssue } from "@/domain/sprites/v3/validate";
import { createRng } from "@/domain/util/rng";

/**
 * HERO RENDERER v3 — the procedural per-hero renderer. Every check here runs on REAL generated heroes (the production appearance generator →
 * the stored sprite config → the v3 genome → solved poses → rendered pixels), never on hand-made fixtures or source snapshots:
 *
 *   · structure on 100 uncurated heroes per class, every frame of every clip (validate.ts: faces, grips, ground contact, frame edges, bones,
 *     knees, lost equipment, NaN);
 *   · determinism and independent randomness streams; the v2 archetype of every hero is kept;
 *   · the IK, the gait's planted feet, the clip timing the arena lines up with the server;
 *   · the set plugs into the existing compositor / library / animator / card key without disturbing v1 / v2.
 */

const cls = (id: string) => DEFAULT_CLASSES.find((c) => c.id === id)!;
const RARITIES: readonly Rarity[] = ["COMMON", "RARE", "EPIC", "LEGENDARY"];
const configOf = (id: string, seed: string, rarity: Rarity = "COMMON"): SpriteConfig => deriveSpriteConfig(rollAppearance(createRng(seed), cls(id), rarity), cls(id).look, rarity);
const heroFor = (id: string, seed: string, rarity: Rarity = "COMMON"): Hero => heroOf({ config: configOf(id, seed, rarity), colors: cls(id).look.colors, rarity });
const sha = (a: Uint8ClampedArray): string => createHash("sha256").update(a).digest("hex");
const CLASSES = ["warrior", "tank", "rogue", "ranger", "mage", "cleric"] as const;

function clipsOf(h: Hero): ClipKey3[] {
  return CLIP_ORDER.filter((c) => !c.startsWith("attack") || c === h.lo.attack);
}

afterEach(() => resetSpriteLibrary());

describe("structure on 100 uncurated heroes per class (every frame of every clip)", () => {
  for (const c of CLASSES) {
    it(`${c}: no structural defect; a weapon crosses a face for at most two frames of an action`, () => {
      const errors: string[] = [];
      let frames = 0;
      for (let i = 0; i < 100; i++) {
        const h = heroFor(c, `v3-sweep-${c}-${i}`, RARITIES[i % 4]);
        for (const clip of clipsOf(h)) {
          let briefly = 0;
          for (let f = 0; f < TIMING[clip].frames; f++) {
            const issues: FrameIssue[] = validateFrame(h, clip, renderClipFrame(h, clip, f));
            frames++;
            for (const iss of issues) {
              if (iss.code === "eyes-action") briefly++;
              else errors.push(`${c}#${i} ${h.g.arch} ${clip}#${f} ${iss.code}: ${iss.detail}`);
            }
          }
          if (briefly > 2) errors.push(`${c}#${i} ${h.g.arch} ${clip}: a face covered for ${briefly} frames`);
        }
      }
      expect(frames).toBeGreaterThan(100 * 70);
      expect(errors.slice(0, 12)).toEqual([]);
    }, 300_000);
  }
});

describe("faces", () => {
  it("open-faced heroes show every eye pixel at rest, on the head's own skin, the mouth below them", () => {
    let checked = 0;
    for (const c of CLASSES) {
      for (let i = 0; i < 40; i++) {
        const h = heroFor(c, `v3-face-${c}-${i}`, RARITIES[i % 4]);
        const fr = renderClipFrame(h, h.g.stance === 1 ? "idle2" : "idle", 0);
        const face = fr.meta.face;
        expect(face.visible).toBe(true);
        if (fr.meta.cover.visor) {
          // a closed visor: the slit and two glints are stamped on the helm at the eye line
          expect(face.eyes.every((e) => e.drawn === e.expected)).toBe(true);
          continue;
        }
        expect(face.eyes.length).toBeGreaterThanOrEqual(1);
        for (const e of face.eyes) {
          expect(e.drawn, `${c}#${i}`).toBe(e.expected);
          // every eye pixel is an eye on top of the head (the stamp only writes on face skin)
          for (let dy = 0; dy < e.h; dy++) for (let dx = 0; dx < e.w; dx++) {
            const p = fr.parts[(e.y + dy) * FRAME_W + e.x + dx] as number;
            if (p >= 0 && fr.partNames[p] === "eyes") expect(fr.partTags[p]).toBe(17);
          }
        }
        if (face.mouth) expect(face.mouth.y).toBeGreaterThan((face.eyes[0] as { y: number }).y + 1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("the near eye sits left of the far eye with a skin pixel between them (three-quarter view)", () => {
    for (let i = 0; i < 30; i++) {
      const fr = renderClipFrame(heroFor("ranger", `v3-eyes-${i}`), "idle", 0);
      const [n, f] = fr.meta.face.eyes;
      if (!n || !f) continue;
      expect(f.x).toBeGreaterThanOrEqual(n.x + n.w + 1);
      expect(f.y).toBe(n.y);
    }
  });

  it("the stored accessory is drawn (and visible) on every class — never over the eyes", () => {
    const shows: Record<string, RegExp> = { goggles: /^goggle/, scarf: /^scarf$/, "cog-pin": /^cog/, monocle: /^monocle$/, headset: /^headset/ };
    for (const c of CLASSES) {
      for (const [acc, re] of Object.entries(shows)) {
        const rarity: Rarity = acc === "goggles" || acc === "scarf" ? "RARE" : "LEGENDARY";
        const base = configOf(c, `v3-acc-${c}`, rarity);
        const hero = heroOf({ config: { ...base, slots: { ...base.slots, accessory: `accessory.${acc}` } }, colors: cls(c).look.colors, rarity });
        const fr = renderClipFrame(hero, hero.g.stance === 1 ? "idle2" : "idle", 0);
        const visible = new Set<number>(Array.from(fr.parts).filter((p) => p >= 0 && re.test(fr.partNames[p] as string)));
        // a monocle sits on the face: a closed visor hides it (as a helm hides the hair)
        if (acc === "monocle" && fr.meta.cover.visor) expect(visible.size, `${c} ${acc} under a visor`).toBe(0);
        else expect(visible.size, `${c} ${acc}`).toBeGreaterThan(0);
        expect(validateFrame(hero, hero.g.stance === 1 ? "idle2" : "idle", fr), `${c} ${acc}`).toEqual([]);
        const none = heroOf({ config: { ...base, slots: { ...base.slots, accessory: undefined } }, colors: cls(c).look.colors, rarity });
        expect(renderClipFrame(none, none.g.stance === 1 ? "idle2" : "idle", 0).partNames.some((n) => re.test(n)), `${c} without ${acc}`).toBe(false);
      }
    }
  });

  it("a hood shows the stored hair style through its face opening (a fringe; a lock for long hair)", () => {
    const base = configOf("rogue", "v3-hood-hair");
    const hairPx = (style: number) => {
      const hero = heroOf({ config: { ...base, slots: { ...base.slots, headgear: "headgear.hood", hair: `hair.${style}` } }, colors: cls("rogue").look.colors, rarity: "COMMON" });
      const fr = renderClipFrame(hero, "idle", 0);
      return Array.from(fr.parts).filter((p) => p >= 0 && fr.partNames[p] === "hair").length;
    };
    expect(hairPx(0)).toBeGreaterThan(0);
    expect(hairPx(2)).toBeGreaterThan(hairPx(0) + 3); // the long lock
  });
});

describe("determinism and independent streams", () => {
  it("the same stored look renders the same pixels every time", () => {
    for (const c of CLASSES) {
      const a = renderClipFrame(heroFor(c, `v3-det-${c}`, "EPIC"), "attack_slash", 3);
      const b = renderClipFrame(heroFor(c, `v3-det-${c}`, "EPIC"), "attack_slash", 3);
      expect(sha(a.rgba)).toBe(sha(b.rgba));
    }
  });

  it("changing the headgear (a cosmetic override) changes nothing about the body, face, hair, palette, weapon design or motion", () => {
    for (let i = 0; i < 60; i++) {
      const cfg = configOf("warrior", `v3-ind-${i}`, "RARE");
      const g0 = genomeOf({ config: cfg, colors: cls("warrior").look.colors, rarity: "RARE" });
      const g1 = genomeOf({ config: { ...cfg, slots: { ...cfg.slots, headgear: "headgear.crown" } }, colors: cls("warrior").look.colors, rarity: "RARE" });
      expect(g1.headgear).toBe("crown");
      expect({ ...g1, headgear: null }).toEqual({ ...g0, headgear: null });
    }
  });

  it("every hero keeps the archetype renderer v2 gave it (the same build, stance pair and grip language)", () => {
    const v2 = parseManifest(JSON.parse(readFileSync(path.join(process.cwd(), "public", "sprites", "clank-dev-v2", "manifest.json"), "utf8")));
    for (const c of CLASSES) {
      for (let i = 0; i < 40; i++) {
        const cfg = configOf(c, `v3-arch-${c}-${i}`);
        expect(genomeOf({ config: cfg, colors: cls(c).look.colors, rarity: "COMMON" }).arch).toBe(rigOf(cfg, v2));
      }
    }
  });
});

describe("anatomy, IK and gait", () => {
  it("every archetype is a coherent body 40–50 px tall", () => {
    for (const a of ARCHETYPE_IDS) {
      const h = standingHeight(BODY_PLANS[a]);
      expect(h, a).toBeGreaterThan(39);
      expect(h, a).toBeLessThan(51);
    }
  });

  it("two-bone IK keeps both segment lengths and never over-stretches", () => {
    for (const t of [[3, -9, 4], [20, 0, 0], [0.5, -0.5, 0.2]] as const) {
      const r = ik([0, 0, 0], t, 6.6, 6.0, [-1, -0.5, 0.5]);
      expect(Math.hypot(...r.mid)).toBeCloseTo(6.6, 5);
      expect(Math.hypot(r.end[0] - r.mid[0], r.end[1] - r.mid[1], r.end[2] - r.mid[2])).toBeCloseTo(6.0, 5);
    }
    expect(aimDir({ angle: 90 })[0]).toBeCloseTo(1, 6);
  });

  it("two-handed weapons and bow-strings: the second hand is ON its grip in every frame", () => {
    for (const [c, arch] of [["warrior", "warrior-brute"], ["mage", "mage-battle"], ["ranger", "ranger"]] as const) {
      let found = 0;
      for (let i = 0; i < 200 && found < 3; i++) {
        const h = heroFor(c, `v3-grip-${i}`);
        if (h.g.arch !== arch) continue;
        found++;
        for (const clip of clipsOf(h)) for (let f = 0; f < TIMING[clip].frames; f++) expect(renderClipFrame(h, clip, f).meta.sk.gripError, `${arch} ${clip}#${f}`).toBeLessThan(0.8);
      }
      expect(found).toBe(3);
    }
  });

  it("walking: a planted foot moves back by the stride's share of the ground each frame (no sliding), and one foot is always down", () => {
    const h = heroFor("warrior", "v3-gait");
    const T = TIMING.move;
    // the skeleton is in body units: the clip's stride is in sprite pixels (body units × the camera zoom)
    const step = (T.stride as number) / VIEW_ZOOM / T.frames;
    const xs: number[] = [];
    for (let f = 0; f < T.frames; f++) {
      const sk = renderClipFrame(h, "move", f).meta.sk;
      xs.push(sk.ankleN[0]);
      expect(Math.min(sk.ankleN[1], sk.ankleF[1]) - h.g.plan.ankle).toBeLessThan(0.9);
    }
    // frames 0..4 are the near foot's stance
    for (let f = 0; f < 4; f++) expect(Math.abs(xs[f]! - xs[f + 1]! - step)).toBeLessThan(1.0);
  });

  it("the walk cycle's cadence covers exactly one stride per cycle at the arena's stride-locked speed", () => {
    const T = TIMING.move;
    const cycleSec = T.frames / T.fps;
    expect(62 * cycleSec).toBeCloseTo((T.stride as number) * WORLD_PER_PX, 5);
    const R = TIMING.run;
    expect((R.refSpeed as number) * (R.frames / R.fps)).toBeCloseTo((R.stride as number) * WORLD_PER_PX, 5);
  });

  it("attacks are real actions: a cut turns the weapon, a thrust drives the hand out, a shot raises the bow — then all come back", () => {
    for (const c of CLASSES) {
      const h = heroFor(c, `v3-swing-${c}`, "RARE");
      const clip = h.lo.attack;
      const s0 = renderClipFrame(h, clip, 0).meta.sk;
      const imp = renderClipFrame(h, clip, TIMING[clip].impact!).meta.sk;
      const end = renderClipFrame(h, clip, TIMING[clip].frames - 1).meta.sk;
      const a = s0.weapon!.y;
      const b = imp.weapon!.y;
      const turned = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * (180 / Math.PI);
      const reach = imp.handN[0] - s0.handN[0];
      if (clip === "attack_shoot") expect(imp.handF[1], c).toBeGreaterThan(s0.handF[1] + 4);
      else if (clip === "attack_thrust") expect(Math.max(reach, turned / 5), c).toBeGreaterThan(3.5);
      else expect(turned, c).toBeGreaterThan(40);
      // the clip ends where it began (it loops back into the stance)
      expect(Math.hypot(end.handN[0] - s0.handN[0], end.handN[1] - s0.handN[1]), c).toBeLessThan(1.6);
    }
  });
});

describe("the sprite contract", () => {
  it("every frame is the set's frame size, the anchor is fixed, impact frames lie inside their clips, leads stay ≤ 300 ms", () => {
    const m = v3Manifest();
    expect(m.frame).toEqual({ w: FRAME_W, h: FRAME_H });
    expect(m.anchor).toEqual(ANCHOR);
    for (const k of CLIP_ORDER) {
      const c = m.clips[k]!;
      expect(c.frames).toBe(TIMING[k].frames);
      if (c.impact !== undefined) {
        expect(c.impact).toBeLessThan(c.frames);
        expect(((c.impact + 0.4) / c.fps) * 1000).toBeLessThan(300);
      }
    }
    const fr = renderClipFrame(heroFor("tank", "v3-size"), "ko", 9);
    expect(fr.rgba.length).toBe(FRAME_W * FRAME_H * 4);
  });

  it("shooting weapons declare where the shot leaves (the arrow head / the crystal) on the impact frame", () => {
    for (const c of ["ranger", "mage", "cleric"] as const) {
      const p = V3_SET.hero(configOf(c, `v3-muzzle-${c}`), cls(c).look.colors, "COMMON");
      expect(p.muzzle, c).not.toBeNull();
      expect(p.muzzle!.x).toBeGreaterThan(ANCHOR.x);
      expect(p.muzzle!.y).toBeLessThan(ANCHOR.y);
    }
  });

  it("the compositor draws a procedural hero: one strip per clip, frames left → right, no atlases", () => {
    const src: SpriteSource = { manifest: v3Manifest(), images: {}, factory: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement, procedural: V3_SET };
    const cfg = configOf("cleric", "v3-strip");
    const sheet = getHeroSheet(src, cfg, cls("cleric").look.colors, "LEGENDARY");
    expect(sheet.needsFallback).toBe(false);
    expect(sheet.pending).toBe(false);
    expect(sheet.images).toEqual([]);
    for (const clip of ["idle", "move", "attack_thrust", "skill", "hit", "ko", "victory", "run", "block", "turn"] as const) {
      const strip = sheet.strip(clip)!;
      expect(strip.width, clip).toBe(TIMING[clip].frames * FRAME_W);
      expect(strip.height).toBe(FRAME_H);
    }
    expect(sheet.topPx()).toBeLessThan(ANCHOR.y - 35);
  });

  it("procedural strips fill one frame at a time — drawn frames match the full render, warming stays inside its budget", () => {
    const src: SpriteSource = { manifest: v3Manifest(), images: {}, factory: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement, procedural: V3_SET };
    const cfg = configOf("warrior", "v3-lazy");
    const colors = cls("warrior").look.colors;
    const sheet = new HeroSheet(src, cfg, colors, "EPIC");
    const before = spriteStats.frames;
    // drawing frame 3 of the walk generates exactly that frame
    const strip = sheet.strip("move", 0, 3)!;
    expect(spriteStats.frames - before).toBe(1);
    expect(sheet.isComposed("move")).toBe(false);
    const px = (c: HTMLCanvasElement, f: number) => Array.from((c.getContext("2d") as unknown as CanvasRenderingContext2D).getImageData(f * FRAME_W, 0, FRAME_W, FRAME_H).data);
    const full = V3_SET.hero(cfg, colors, "EPIC").frames("move");
    expect(px(strip, 3)).toEqual(Array.from(full[3]!.rgba));
    expect(px(strip, 4).some((v) => v !== 0)).toBe(false); // not generated yet
    // a silhouette covers only the frames asked for
    const sil = sheet.silhouette("move", 0, "#ffffff", 3)!;
    expect(px(sil, 3).filter((_, i) => i % 4 === 3)).toEqual(Array.from(full[3]!.rgba).filter((_, i) => i % 4 === 3));
    // warming: past its deadline it adds nothing — unless forced (one frame), and a generous deadline finishes the clip
    const n0 = spriteStats.frames;
    expect(sheet.warm("move", 0)).toBe(false);
    expect(spriteStats.frames - n0).toBe(0);
    expect(sheet.warm("move", 0, true)).toBe(false);
    expect(spriteStats.frames - n0).toBe(1);
    sheet.warm("move", Number.POSITIVE_INFINITY);
    expect(sheet.isComposed("move")).toBe(true);
    for (let f = 0; f < TIMING.move.frames; f++) expect(px(strip, f)).toEqual(Array.from(full[f]!.rgba));
    expect(spriteStats.frames - before).toBe(TIMING.move.frames);
  });

  it("pages follow the set the server says is live — validated, notified once, and the pre-v3 set until then", () => {
    resetSpriteLibrary();
    expect(activeSpriteSet()).toBe("clank-dev-v2");
    const seen: string[] = [];
    const off = subscribeActiveSpriteSet(() => seen.push(activeSpriteSet()));
    announceSpriteSet("clank-v3");
    announceSpriteSet("clank-v3"); // unchanged: no notification
    announceSpriteSet("../not-a-set");
    announceSpriteSet(null);
    expect(activeSpriteSet()).toBe("clank-v3");
    expect(seen).toEqual(["clank-v3"]);
    off();
    resetSpriteLibrary();
    expect(activeSpriteSet()).toBe("clank-dev-v2");
  });

  it("the library serves the procedural set at once (no download); fresh settings default to it", async () => {
    // until the server says which set is live, a page draws with the set that was live before v3 (shipping the code changes nothing on screen)
    expect(DEFAULT_SPRITE_SET).toBe("clank-dev-v2");
    expect(DEFAULT_SETTINGS.visuals.spriteSet).toBe(V3_SET_ID);
    const st = await ensureSpriteSet(V3_SET_ID, { fetchJson: () => Promise.reject(new Error("must not fetch")), factory: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement });
    expect(st.status).toBe("ready");
    expect(getLibraryState(V3_SET_ID).source?.procedural).toBe(V3_SET);
  });
});

describe("animator: run, block and turn (sets that draw them) — v1/v2 untouched", () => {
  const base: AnimInput = { alive: true, moving: true, victory: false, stunned: false, sinceAttackMs: Infinity, sinceSkillMs: Infinity, sinceHurtMs: Infinity, sinceKoMs: null, loopClockMs: 0, moveClockMs: 0 };
  const v2 = parseManifest(JSON.parse(readFileSync(path.join(process.cwd(), "public", "sprites", "clank-dev-v2", "manifest.json"), "utf8")));

  it("walks below the run speed and runs above it; the run's clock is scaled to its own reference speed", () => {
    const m = v3Manifest();
    expect(selectPlayback({ ...base, speed: 60 }, m, "attack_slash").clip).toBe("move");
    const run = selectPlayback({ ...base, speed: 95, moveClockMs: 1000 }, m, "attack_slash");
    expect(run.clip).toBe("run");
    const R = m.clips.run!;
    expect(run.frame).toBe(Math.floor(((1000 * 62) / (R.refSpeed as number) / 1000) * R.fps) % R.frames);
    // v2 has no run clip: a fast hero still plays its move cycle
    expect(selectPlayback({ ...base, speed: 95 }, v2, "attack_slash").clip).toBe("move");
  });

  it("a parried blow plays the block clip, a facing flip the turn clip — only in sets that have them", () => {
    const m = v3Manifest();
    const still = { ...base, moving: false };
    expect(selectPlayback({ ...still, sinceBlockMs: 50 }, m, "attack_slash").state).toBe("BLOCK");
    expect(selectPlayback({ ...still, sinceTurnMs: 20 }, m, "attack_slash").state).toBe("TURN");
    expect(selectPlayback({ ...still, sinceBlockMs: 50 }, v2, "attack_slash").state).toBe("IDLE");
    expect(selectPlayback({ ...still, sinceTurnMs: 20 }, v2, "attack_slash").state).toBe("IDLE");
    // attacks still win over both
    expect(selectPlayback({ ...still, sinceBlockMs: 50, sinceAttackMs: 30 }, m, "attack_slash").state).toBe("ATTACK");
  });
});

describe("versioning", () => {
  it("v3 cards carry the v3 art revision in their key; cards drawn by v1 / v2 keep the keys they had", () => {
    const model = {
      name: "Rivet", classId: "warrior", rarity: "RARE", power: 100, stats: { hp: 1, str: 1, def: 1, int: 1, agi: 1, cha: 1, luck: 1 }, seasonRank: null,
      look: { parts: {}, sprite: configOf("warrior", "card"), colors: cls("warrior").look.colors, weapon: "sword", headgear: "helm", body: "medium", spriteSet: "clank-dev-v2" },
    } as unknown as Parameters<typeof cardKey>[0];
    const v2Key = cardKey(model);
    const v3Key = cardKey({ ...model, look: { ...model.look, spriteSet: V3_SET_ID } });
    expect(v3Key).not.toBe(v2Key);
    expect(cardKey(model)).toBe(v2Key);
  });

  it("the settings migration moves only a database that still selects v2", () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", "20261014002600_hero_renderer_v3.sql"), "utf8");
    expect(sql).toMatch(/value ->> 'spriteSet' = 'clank-dev-v2'/);
    expect(sql).toMatch(/"clank-v3"/);
    expect(sql).not.toMatch(/\b(delete|drop|truncate)\b/i);
  });
});
