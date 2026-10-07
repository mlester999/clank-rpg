/**
 * Cost of the Arena rarity effects, measured with the REAL canvas engine (Skia via @napi-rs/canvas) and the real sprite compositor:
 * eight fighters per frame, drawn with and without the effects, for every rarity — the worst case being eight Legendary heroes.
 *
 *   pnpm rarity:bench                (default 600 frames per row)
 *   pnpm rarity:bench -- --frames 2000
 *
 * It measures CPU time per frame in Node (no GPU, no compositor), which is the part the effects add; the 60 fps budget is 16.7 ms a frame.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";

import { drawRarityAura, drawRarityGround, drawRarityMark, drawRarityParticles } from "../src/components/arena/rarityFx";
import { HeroSheet, type CanvasFactory, type SpriteSource } from "../src/components/sprites/compositor";
import { drawHeroSprite, playbackFor } from "../src/components/sprites/draw";
import { rollAppearance, type Rarity } from "../src/domain/character/appearance";
import { DEFAULT_CLASSES } from "../src/domain/content";
import { deriveSpriteConfig } from "../src/domain/sprites/config";
import { parseManifest } from "../src/domain/sprites/spec";
import { createRng } from "../src/domain/util/rng";

const args = process.argv.slice(2).filter((a) => a !== "--");
const frames = Number(args[args.indexOf("--frames") + 1] || 600);

async function main() {
  const dir = path.join(process.cwd(), "public", "sprites", "clank-dev-v1");
  const manifest = parseManifest(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")));
  const images: SpriteSource["images"] = {};
  for (const [k, f] of Object.entries(manifest.images)) images[k] = (await loadImage(path.join(dir, f))) as unknown as CanvasImageSource;
  const src: SpriteSource = { manifest, images, factory: ((w: number, h: number) => createCanvas(w, h)) as unknown as CanvasFactory };
  const W = 1200;
  const H = 720;
  const ctx = createCanvas(W, H).getContext("2d") as unknown as CanvasRenderingContext2D;

  const lineup = (rarity: Rarity) =>
    Array.from({ length: 8 }, (_, i) => {
      const c = DEFAULT_CLASSES[i % DEFAULT_CLASSES.length]!;
      const cfg = deriveSpriteConfig(rollAppearance(createRng(`b-${i}-${c.id}`), c, rarity), c.look, rarity);
      return { sheet: new HeroSheet(src, cfg, c.look.colors, rarity), x: 180 + (i % 4) * 280, y: 260 + Math.floor(i / 4) * 280, rarity };
    });

  const drawFrame = (units: ReturnType<typeof lineup>, withFx: boolean, now: number) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#101018";
    ctx.fillRect(0, 0, W, H);
    units.forEach((u, slot) => {
      ctx.save();
      ctx.translate(u.x, u.y);
      ctx.scale(1.25, 1.25);
      if (withFx) {
        drawRarityGround(ctx, u.rarity, now, slot, 1, false);
        drawRarityAura(ctx, u.rarity, now, slot, 1, false);
      }
      const playback = playbackFor(u.sheet, src, { alive: true, moving: false, victory: false, stunned: false, sinceAttackMs: 1e9, sinceSkillMs: 1e9, sinceHurtMs: 1e9, sinceKoMs: null, loopClockMs: now + slot * 137 });
      drawHeroSprite(ctx, src, u.sheet, { playback, direction: "right", alpha: 1 }, 104);
      if (withFx) drawRarityParticles(ctx, u.rarity, now, slot, 1, false);
      ctx.restore();
      if (withFx) drawRarityMark(ctx, u.rarity, u.x, u.y - 150, 5);
    });
  };

  /** Steady-state CPU ms per frame: the lineup is composed and warmed up first (sprite sheets are cached after their first frame), then `n` frames are timed. */
  const cost = (rarity: Rarity, withFx: boolean, n: number): number => {
    const units = lineup(rarity);
    for (let f = 0; f < 120; f++) drawFrame(units, withFx, f * 16.7); // warm-up: not timed
    const t0 = process.hrtime.bigint();
    for (let f = 0; f < n; f++) drawFrame(units, withFx, 2_000 + f * 16.7);
    return Number(process.hrtime.bigint() - t0) / 1e6 / n;
  };

  const rows: Array<[string, number]> = [];
  rows.push(["8 Common, no effects (the 'before')", cost("COMMON", false, frames)]);
  for (const r of ["COMMON", "RARE", "EPIC", "LEGENDARY"] as const) rows.push([`8 ${r}, sprites + effects`, cost(r, true, frames)]);
  rows.push(["8 Legendary, sprites only", cost("LEGENDARY", false, frames)]);
  for (const [label, ms] of rows) console.log(`${label.padEnd(40)} ${ms.toFixed(3)} ms/frame`);
  const base = rows[5]![1];
  const worst = rows[4]![1];
  console.log(`\nWORST CASE (8 Legendary): the effects add ${(worst - base).toFixed(3)} ms per frame (${((worst / base - 1) * 100).toFixed(0)}% over the sprites alone); the whole frame costs ${worst.toFixed(2)} ms of a 16.7 ms budget.`);
}
void main();
