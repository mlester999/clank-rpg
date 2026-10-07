/**
 * Builds the DEV PLACEHOLDER sprite set into public/sprites/clank-dev-v1/.
 *
 *   pnpm sprites:build
 *
 * This is generated stand-in art so the spritesheet engine can be built, tested and demoed
 * before professional art exists. It is NOT production art. Replacing it means shipping a new
 * set that satisfies docs/SPRITES.md (same manifest contract, any frame size) — nothing in the
 * renderer is tied to these pictures.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas } from "@napi-rs/canvas";

import { parseManifest, SPRITE_SPEC_VERSION, type SpriteManifest } from "../src/domain/sprites/spec";

import { AURAS, LAYERS, type LayerSpec } from "./sprites/parts";
import { RARITY_LAYERS } from "./sprites/rarityParts";
import { FRAME_H, FRAME_W, imageDataOf, newFrame, pixelate } from "./sprites/pen";
import { CLIP_ORDER, CLIPS, poseFor, joints, type ClipName } from "./sprites/rig";

const SET_ID = "clank-dev-v1";
const OUT = path.join(process.cwd(), "public", "sprites", SET_ID);

const COLS = Math.max(...Object.values(CLIPS).map((c) => c.frames));
const ROWS = 1 + Math.max(...Object.values(CLIPS).map((c) => c.row));
const BLOCK_W = COLS * FRAME_W;
const BLOCK_H = ROWS * FRAME_H;
const AURA_FRAMES = 8;

/** Rarity layers split into one atlas per kind (trim / shoulder / crest / weaponfx) so no single image gets taller than a phone browser decodes comfortably. */
const fileOf = (l: LayerSpec): string => (l.family === "rarity" ? `rarity-${l.id.split(".")[0]}` : FAMILY_FILE[l.family]);

const FAMILY_FILE: Record<LayerSpec["family"], string> = {
  body: "body", outfits: "outfits", face: "face", hair: "hair", headgear: "headgear", extras: "extras", weapons: "weapons", rarity: "rarity",
};

type Cell = Uint8ClampedArray;

function renderLayer(layer: LayerSpec): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const clip of CLIP_ORDER) {
    for (let f = 0; f < CLIPS[clip].frames; f++) {
      const { canvas, g } = newFrame();
      const pose = poseFor(clip, f);
      layer.draw(g, pose, joints(pose));
      cells.set(`${clip}:${f}`, pixelate(canvas, layer.tint === null ? 9 : 7));
    }
  }
  return cells;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  // 1. group layers by atlas file, stacking one block per layer
  const byFile = new Map<string, LayerSpec[]>();
  for (const l of [...LAYERS, ...RARITY_LAYERS]) byFile.set(fileOf(l), [...(byFile.get(fileOf(l)) ?? []), l]);

  const images: Record<string, string> = {};
  const layers: SpriteManifest["layers"] = {};
  let cellCount = 0;

  for (const [file, group] of byFile) {
    const atlas = createCanvas(BLOCK_W, BLOCK_H * group.length);
    const ctx = atlas.getContext("2d");
    for (const [i, layer] of group.entries()) {
      const y0 = i * BLOCK_H;
      for (const [key, pixels] of renderLayer(layer)) {
        const [clip, frame] = key.split(":") as [ClipName, string];
        ctx.putImageData(imageDataOf(pixels), Number(frame) * FRAME_W, y0 + CLIPS[clip].row * FRAME_H);
        cellCount++;
      }
      layers[layer.id] = {
        image: file, x: 0, y: y0, z: layer.z, tint: layer.tint,
        ...(layer.of ? { of: layer.of } : {}),
        ...(layer.attack ? { attack: layer.attack } : {}),
      };
    }
    images[file] = `${file}.png`;
    await writeFile(path.join(OUT, `${file}.png`), atlas.toBuffer("image/png"));
  }

  // 2. auras: one row of looping frames per aura, stacked in one atlas
  const auraAtlas = createCanvas(AURA_FRAMES * FRAME_W, FRAME_H * AURAS.length);
  const actx = auraAtlas.getContext("2d");
  for (const [i, aura] of AURAS.entries()) {
    for (let f = 0; f < AURA_FRAMES; f++) {
      const { canvas, g } = newFrame();
      aura.draw(g, f, AURA_FRAMES);
      actx.putImageData(imageDataOf(pixelate(canvas, 7)), f * FRAME_W, i * FRAME_H);
      cellCount++;
    }
    layers[aura.id] = { image: "auras", x: 0, y: i * FRAME_H, z: -5, tint: "rarity", loop: { frames: AURA_FRAMES, fps: 10 } };
  }
  images.auras = "auras.png";
  await writeFile(path.join(OUT, "auras.png"), auraAtlas.toBuffer("image/png"));

  // 3. manifest (validated with the same schema the game uses at runtime)
  const manifest = parseManifest({
    spec: SPRITE_SPEC_VERSION,
    id: SET_ID,
    name: "Clank Dev Placeholder Set",
    status: "dev-placeholder",
    credits: "Generated procedurally by scripts/build-dev-sprites.ts. DEV PLACEHOLDER — not production art.",
    frame: { w: FRAME_W, h: FRAME_H },
    anchor: { x: 34, y: 58 },
    nominalHeightPx: 46,
    images,
    clips: Object.fromEntries(CLIP_ORDER.map((c) => [c, { row: CLIPS[c].row, frames: CLIPS[c].frames, fps: CLIPS[c].fps, loop: CLIPS[c].loop, ...(CLIPS[c].impact !== undefined ? { impact: CLIPS[c].impact } : {}) }])),
    directions: { right: { index: 0 }, left: { mirror: "right" } },
    layers,
  });
  await writeFile(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`built ${SET_ID}: ${Object.keys(manifest.layers).length} layers, ${Object.keys(images).length} atlases, ${cellCount} cells → ${path.relative(process.cwd(), OUT)}`);
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
