/**
 * Renders contact sheets of the sprite set through the REAL runtime compositor (the same code the
 * browser uses), for eyeballing art and catching alignment problems.
 *
 *   pnpm sprites:preview -- --out sheet.png                 overview: every class, key poses
 *   pnpm sprites:preview -- --class mage --out mage.png     every clip/frame for one class
 *   pnpm sprites:preview -- --matrix --out matrix.png        QA grid: every class × every rarity (idle + attack + skill)
 *   options: --rarity LEGENDARY  --seed hero-42  --set clank-dev-v1  --scale 3
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
  const dir = path.join(process.cwd(), "public", "sprites", setId);
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
  const cols = matrix ? RARITIES_ALL.length * matrixPoses.length : only ? Math.max(...clipRows.map((c) => m.clips[c]!.frames)) : keyPoses.length;
  const rows = matrix ? classes.length : only ? clipRows.length : classes.length;
  const sheet = createCanvas(cols * cw, rows * ch);
  const ctx = sheet.getContext("2d") as unknown as CanvasRenderingContext2D;

  const place = (col: number, row: number, clip: ClipKey, frame: number, cls: (typeof DEFAULT_CLASSES)[number], face: 1 | -1 = 1, as: typeof rarity = rarity): void => {
    const parts = rollAppearance(createRng(`${seed}-${cls.id}`), cls, as);
    const sheetHero = getHeroSheet(src, deriveSpriteConfig(parts, cls.look, as), cls.look.colors, as);
    const x = col * cw;
    const y = row * ch;
    ctx.fillStyle = (col + row) % 2 ? "#232b3a" : "#1d2431";
    ctx.fillRect(x, y, cw, ch);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(x + m.anchor.x * scale, y + m.anchor.y * scale, cw * 0.22, ch * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(x + m.anchor.x * scale, y + m.anchor.y * scale);
    const pb = { ...playbackFor(sheetHero, src, { alive: true, moving: false, victory: false, stunned: false, sinceAttackMs: Infinity, sinceSkillMs: Infinity, sinceHurtMs: Infinity, sinceKoMs: null, loopClockMs: 0 }), clip, frame };
    drawHeroSprite(ctx, src, sheetHero, { playback: pb, direction: face === 1 ? "right" : "left" }, heroHeight);
    ctx.restore();
  };

  if (matrix) {
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
