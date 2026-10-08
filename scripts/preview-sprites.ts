/**
 * Renders contact sheets of the sprite set through the REAL runtime compositor (the same code the
 * browser uses), for eyeballing art and catching alignment problems.
 *
 *   pnpm sprites:preview -- --out sheet.png                 overview: every class, key poses
 *   pnpm sprites:preview -- --class mage --out mage.png     every clip/frame for one class
 *   pnpm sprites:preview -- --matrix --out matrix.png        QA grid: every class × every rarity (idle + attack + skill)
 *   pnpm sprites:preview -- --contact --out contact.png      CONTACT SHEET: 6 classes × 4 rarities, each idle · move · attack (the weapon's own
 *                                                            clip, on its impact frame) · cast (impact frame), labelled; add --full for hit · KO
 *   pnpm sprites:preview -- --variety 8 --out variety.png    VARIETY: 8 different heroes of every class (idle), one per seed — same-class heroes
 *                                                            must not be clones (face, hair, skin, colours and the item VARIANTS differ)
 *   pnpm sprites:preview -- --class warrior --variety 20 --wrap 10 --labels --out w.png
 *                                                            the 20-hero challenge: 20 heroes of one class and rarity in a 10-wide grid, each
 *                                                            labelled with the designs it wears (helm · armour · weapon …)
 *   options: --rarity LEGENDARY  --seed hero-42  --set clank-dev-v1  --scale 3  --dir <folder> (a set outside public/sprites, e.g. a saved copy)
 *            --rig warrior-brute  only heroes drawn on that skeleton (archetype): the first seeds whose look picks it (--anim, --variety)
 *   pnpm sprites:preview -- --archetypes --scale 2 --out poses.png
 *                                                            POSE LANGUAGES: one row per skeleton (three per class), one hero each — stance ·
 *                                                            second stance · walk/run · attack (impact) · cast (impact) · hit · KO · victory
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";

import { rollAppearance } from "../src/domain/character/appearance";
import { DEFAULT_CLASSES } from "../src/domain/content";
import { deriveSpriteConfig } from "../src/domain/sprites/config";
import { parseManifest, type ClipKey } from "../src/domain/sprites/spec";
import { createRng } from "../src/domain/util/rng";
import { getHeroSheet, type CanvasFactory, type SpriteSource } from "../src/components/sprites/compositor";
import { drawHeroSprite, playbackFor } from "../src/components/sprites/draw";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

async function loadSource(setId: string): Promise<SpriteSource> {
  const dir = arg("dir") ?? path.join(process.cwd(), "public", "sprites", setId);
  const manifest = parseManifest(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")));
  const images: SpriteSource["images"] = {};
  for (const [key, file] of Object.entries(manifest.images)) images[key] = (await loadImage(path.join(dir, file))) as unknown as CanvasImageSource;
  const factory: CanvasFactory = (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement;
  return { manifest, images, factory };
}

async function main(): Promise<void> {
  const src = await loadSource(arg("set", "clank-dev-v1") as string);
  const scale = Number(arg("scale", "3"));
  const rarity = (arg("rarity", "COMMON") as "COMMON" | "RARE" | "EPIC" | "LEGENDARY");
  const seed = arg("seed", "preview") as string;
  const only = arg("class");
  const out = arg("out", "sprite-preview.png") as string;
  const matrix = process.argv.includes("--matrix");
  const contact = process.argv.includes("--contact");
  const variety = Number(arg("variety", "0"));
  const wrap = Number(arg("wrap", "0")) || variety;
  const labels = process.argv.includes("--labels");
  const labelLines = labels ? 3 : 0;
  const m = src.manifest;
  const cw = m.frame.w * scale;
  const ch = m.frame.h * scale;
  const heroHeight = m.nominalHeightPx * scale;

  const classes = only ? DEFAULT_CLASSES.filter((c) => c.id === only) : DEFAULT_CLASSES;
  if (classes.length === 0) throw new Error(`unknown class ${only}`);

  const keyPoses: Array<[ClipKey, number]> = [["idle", 0], ["move", 1], ["attack_slash", 2], ["skill", 3], ["hit", 0], ["ko", 3], ["victory", 1]];
  const clipRows = (Object.keys(m.clips) as ClipKey[]).sort((a, b) => (m.clips[a]!.row - m.clips[b]!.row));
  const RARITIES_ALL = ["COMMON", "RARE", "EPIC", "LEGENDARY"] as const;
  const matrixPoses: Array<[ClipKey, number]> = [["idle", 0], ["attack_slash", 2], ["skill", 3]];
  // --full: also the hit reaction and the knock-out (lying still) — the review sheet for all 24 class × rarity combinations
  const full = process.argv.includes("--full");
  // --anim: the animation contact sheet — for each class (one hero) every frame of idle · move · its OWN attack · cast · hit · KO · victory
  const anim = process.argv.includes("--anim");
  // --archetypes: every skeleton of the set (a packed set's rigs), one row each
  const archetypes = process.argv.includes("--archetypes") && (m.rigs?.length ?? 0) > 0;
  const ARCH_POSES: Array<[string, ClipKey | "attack" | "stance", number | "impact" | "last"]> = [["stance A", "idle", 0], ["stance B", "idle2", 0], ["run", "move", 1], ["attack", "attack", "impact"], ["cast", "skill", "impact"], ["hit", "hit", 0], ["KO", "ko", "last"], ["victory", "victory", 1]];
  const ANIM_CLIPS = ["idle", "idle2", "move", "attack", "skill", "hit", "ko", "victory"] as const;
  const STATES = full ? (["idle", "walk/run", "attack", "cast", "hit", "ko"] as const) : (["idle", "move", "attack", "cast"] as const);
  const cols = archetypes ? ARCH_POSES.length : anim ? 6 : variety > 0 ? Math.min(variety, wrap) : contact ? RARITIES_ALL.length * STATES.length : matrix ? RARITIES_ALL.length * matrixPoses.length : only ? Math.max(...clipRows.map((c) => m.clips[c]!.frames)) : keyPoses.length;
  const perClassRows = variety > 0 ? Math.ceil(variety / Math.min(variety, wrap)) : 1;
  const rows = archetypes ? (m.rigs as string[]).length : anim ? classes.length * ANIM_CLIPS.length : variety > 0 ? classes.length * perClassRows : matrix || contact ? classes.length : only ? clipRows.length : classes.length;
  const labelW = contact || archetypes ? 112 : 0;
  const labelH = contact || archetypes ? 44 : 0;
  const lineH = 11;
  const cellH = ch + labelLines * lineH;
  const sheet = createCanvas(labelW + cols * cw, labelH + rows * cellH);
  const ctx = sheet.getContext("2d") as unknown as CanvasRenderingContext2D;

  let onlyRig = arg("rig");
  /** With --rig: the first seed (from `heroSeed`) whose hero is drawn on that skeleton — the archetype is a pure function of the look. */
  const seedFor = (heroSeed: string, cls: (typeof DEFAULT_CLASSES)[number], as: typeof rarity): string => {
    if (!onlyRig) return heroSeed;
    for (let n = 0; n < 400; n++) {
      const sd = n === 0 ? heroSeed : `${heroSeed}~${n}`;
      const sheetHero = getHeroSheet(src, deriveSpriteConfig(rollAppearance(createRng(sd), cls, as), cls.look, as), cls.look.colors, as);
      if (sheetHero.plan.rig === onlyRig) return sd;
    }
    return heroSeed;
  };
  const place = (col: number, row: number, clip: ClipKey, frame: number, cls: (typeof DEFAULT_CLASSES)[number], face: 1 | -1 = 1, as: typeof rarity = rarity, heroSeed0 = `${seed}-${cls.id}`): void => {
    const heroSeed = seedFor(heroSeed0, cls, as);
    const parts = rollAppearance(createRng(heroSeed), cls, as);
    const sheetHero = getHeroSheet(src, deriveSpriteConfig(parts, cls.look, as), cls.look.colors, as);
    const x = labelW + col * cw;
    const y = labelH + row * cellH;
    ctx.fillStyle = (col + row) % 2 ? "#232b3a" : "#1d2431";
    ctx.fillRect(x, y, cw, ch);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(x + m.anchor.x * scale, y + m.anchor.y * scale, cw * 0.22, ch * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(x + m.anchor.x * scale, y + m.anchor.y * scale);
    // "attack" = this hero's own attack clip (its weapon decides), on the frame where the blow lands.
    // "attack" = the hero's own attack clip; "stance" = the hero's own idle (idle or idle2 — the arena shows it that way)
    const own = clip === ("attack" as ClipKey) ? sheetHero.plan.attackClip : clip === ("stance" as ClipKey) ? sheetHero.plan.idleClip : clip;
    const at = clip === ("attack" as ClipKey) && !anim ? (m.clips[own]?.impact ?? 0) : frame;
    const pb = { ...playbackFor(sheetHero, src, { alive: true, moving: false, victory: false, stunned: false, sinceAttackMs: Infinity, sinceSkillMs: Infinity, sinceHurtMs: Infinity, sinceKoMs: null, loopClockMs: 0 }), clip: own, frame: at };
    drawHeroSprite(ctx, src, sheetHero, { playback: pb, direction: face === 1 ? "right" : "left" }, heroHeight);
    ctx.restore();
    if (labels) {
      // what this hero wears, by design (the variant ids without their item prefix)
      const short = (id: string) => id.replace(/^[a-z]+\.[a-z]+\./, "").replace(/^[a-z]+\./, "");
      const pick = (prefix: string) => sheetHero.plan.layers.find((l) => l.id.startsWith(prefix) && !/\.\d+$/.test(l.id))?.id;
      const words = [
        [pick("headgear."), pick("outfit.") && sheetHero.plan.layers.find((l) => /^outfit\.[a-z]+\.[a-z]\d/.test(l.id) && !/\.(arms|legs|shoulders)\./.test(l.id))?.id],
        [pick("weapon.") && sheetHero.plan.layers.find((l) => /^weapon\.[a-z]+\.[a-z]\d/.test(l.id))?.id, sheetHero.plan.layers.find((l) => l.id.includes(".shoulders.") && !/\.\d+$/.test(l.id))?.id],
        [sheetHero.plan.rig ?? "", sheetHero.plan.layers.find((l) => l.id.startsWith("body.head."))?.id ?? "head-round", sheetHero.plan.layers.find((l) => l.id.startsWith("body.beard."))?.id],
      ];
      ctx.fillStyle = "#11151d";
      ctx.fillRect(x, y + ch, cw, labelLines * lineH);
      ctx.font = "9px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      words.forEach((pair, li) => {
        ctx.fillStyle = li === 2 ? "#7d8799" : "#c3cad6";
        ctx.fillText(pair.filter(Boolean).map((w) => short(w as string).replace(/^body\.|^head\./, "")).join(" · ").slice(0, Math.floor(cw / 5)), x + 3, y + ch + 1 + li * lineH);
      });
    }
  };

  if (archetypes) {
    ctx.fillStyle = "#11151d";
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    ctx.textBaseline = "middle";
    ARCH_POSES.forEach(([label], i) => {
      ctx.fillStyle = "#8b97ab";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, labelW + (i + 0.5) * cw, 22);
    });
    (m.rigs as string[]).forEach((rig, r) => {
      const cls = DEFAULT_CLASSES.find((c) => rig === c.id || rig.startsWith(`${c.id}-`));
      if (!cls) return;
      onlyRig = rig;
      ctx.fillStyle = "#e6ebf2";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(rig, 6, labelH + (r + 0.5) * cellH);
      ARCH_POSES.forEach(([, clip, at], i) => {
        const def = clip === "attack" || clip === "stance" ? undefined : m.clips[clip];
        const frame = at === "last" ? (def?.frames ?? 1) - 1 : at === "impact" ? (def?.impact ?? 0) : at;
        place(i, r, clip as ClipKey, frame, cls, 1, rarity, `${seed}-${rig}`);
      });
    });
  } else if (anim) {
    classes.forEach((cls, ci) => {
      ANIM_CLIPS.forEach((c, k) => {
        const key = c === "attack" ? ("attack" as ClipKey) : (c as ClipKey);
        const def = c === "attack" ? undefined : m.clips[c as ClipKey];
        const frames = def?.frames ?? 6;
        for (let f = 0; f < frames; f++) place(f, ci * ANIM_CLIPS.length + k, key, f, cls, 1, rarity, `${seed}-${cls.id}`);
      });
    });
  } else if (variety > 0) {
    const per = Math.min(variety, wrap);
    classes.forEach((cls, r) => {
      for (let i = 0; i < variety; i++) place(i % per, r * perClassRows + Math.floor(i / per), "stance" as ClipKey, 0, cls, 1, rarity, `${seed}-${cls.id}-${i}`);
    });
  } else if (contact) {
    ctx.fillStyle = "#11151d";
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    ctx.font = "bold 15px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    RARITIES_ALL.forEach((rar, ri) => {
      ctx.fillStyle = ["#c9d1dc", "#6fb6ff", "#c58bff", "#ffc24a"][ri] as string;
      ctx.fillText(rar, labelW + (ri + 0.5) * STATES.length * cw, 13);
      STATES.forEach((st, si) => {
        ctx.fillStyle = "#8b97ab";
        ctx.font = "12px sans-serif";
        ctx.fillText(st, labelW + (ri * STATES.length + si + 0.5) * cw, 33);
        ctx.font = "bold 15px sans-serif";
      });
    });
    classes.forEach((cls, r) => {
      ctx.fillStyle = "#e6ebf2";
      ctx.textAlign = "left";
      ctx.fillText(cls.name, 8, labelH + (r + 0.5) * ch);
      ctx.textAlign = "center";
      RARITIES_ALL.forEach((rar, ri) => {
        const poses: Array<[ClipKey, number]> = [["stance" as ClipKey, 0], ["move", 1], ["attack" as ClipKey, 0], ["skill", m.clips.skill?.impact ?? 3]];
        if (full) poses.push(["hit", 0], ["ko", (m.clips.ko?.frames ?? 1) - 1]);
        poses.forEach(([clip, frame], si) => place(ri * STATES.length + si, r, clip, frame, cls, 1, rar));
      });
    });
  } else if (matrix) {
    classes.forEach((cls, r) => RARITIES_ALL.forEach((rar, ri) => matrixPoses.forEach(([clip, frame], pi) => place(ri * matrixPoses.length + pi, r, clip, frame, cls, 1, rar))));
  } else if (only) {
    clipRows.forEach((clip, r) => {
      for (let f = 0; f < m.clips[clip]!.frames; f++) place(f, r, clip, f, classes[0]!);
    });
  } else {
    classes.forEach((cls, r) => keyPoses.forEach(([clip, frame], c) => place(c, r, clip, frame, cls)));
  }
  await writeFile(out, sheet.toBuffer("image/png"));
  console.log(`wrote ${out} (${sheet.width}×${sheet.height})`);
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
