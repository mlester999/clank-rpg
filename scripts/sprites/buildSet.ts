import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas } from "@napi-rs/canvas";

import { parseManifest, SPRITE_SPEC_VERSION, type SpriteManifest } from "../../src/domain/sprites/spec";

import { FRAME_H, FRAME_W, imageDataOf, newFrame, OL, pixelate, type Ctx } from "./pen";

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** Replaces one exact colour of the supersampled frame by another (anti-aliased edge samples keep their blend, so lines stay smooth). */
export function recolor(canvas: ReturnType<typeof newFrame>["canvas"], from: string, to: string): void {
  const g = canvas.getContext("2d");
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const [fr, fg, fb] = hex(from);
  const [tr, tg, tb] = hex(to);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    // exact or near-exact outline samples (the stroke's interior); blended edge samples move proportionally
    const dist = Math.abs((d[i] as number) - fr) + Math.abs((d[i + 1] as number) - fg) + Math.abs((d[i + 2] as number) - fb);
    if (dist > 24) continue;
    d[i] = tr;
    d[i + 1] = tg;
    d[i + 2] = tb;
  }
  g.putImageData(img, 0, 0);
}

/**
 * Builds one generated sprite set (atlases + manifest) from a layer registry and a skeleton. Shared by every dev set (v1, v2), so the block layout
 * and the manifest are produced the same way for each — only the art (layers) and the animation (clips + poses) differ.
 */
export interface SetLayer {
  id: string;
  of?: string;
  family: string;
  z: number;
  tint: SpriteManifest["layers"][string]["tint"];
  attack?: SpriteManifest["layers"][string]["attack"];
  muzzle?: (joints: never) => [number, number];
  /** Alternative drawings of this item (other layer ids of the set) — see `variants` in the manifest spec. */
  variants?: string[];
  draw: (g: Ctx, pose: never, joints: never) => void;
}

export interface SetSpec<Clip extends string> {
  id: string;
  name: string;
  credits: string;
  outline?: string;
  /**
   * Selective outlining: on TINTED layers the near-black outline colour (pen `OL`) is replaced by this neutral grey before pixelation, so the
   * lines INSIDE a hero become a dark shade of the part's own colour (dark red between red cloth and red cloth, dark skin around a face)
   * instead of black. The composed hero still gets one black silhouette outline (`outline`). Untinted layers (eyes, mouths, metal, weapons) keep
   * their dark lines.
   */
  innerOutline?: string;
  anchor: { x: number; y: number };
  nominalHeightPx: number;
  clips: Record<Clip, { row: number; frames: number; fps: number; loop: boolean; impact?: number }>;
  clipOrder: readonly Clip[];
  poseFor: (clip: Clip, f: number) => unknown;
  joints: (pose: never) => unknown;
  layers: readonly SetLayer[];
  auras: ReadonlyArray<{ id: string; draw: (g: Ctx, frame: number, frames: number) => void }>;
}

const AURA_FRAMES = 8;

/** Where a shooting weapon's projectile leaves, measured on the impact frame of its attack clip (rounded to ½ px). */
function muzzleOf<Clip extends string>(spec: SetSpec<Clip>, layer: SetLayer): { muzzle?: { x: number; y: number } } {
  const clip = layer.attack ? spec.clips[layer.attack as Clip] : undefined;
  if (!layer.muzzle || !clip || clip.impact === undefined) return {};
  const [x, y] = layer.muzzle(spec.joints(spec.poseFor(layer.attack as Clip, clip.impact) as never) as never);
  return { muzzle: { x: Math.round(x * 2) / 2, y: Math.round(y * 2) / 2 } };
}

export async function buildSet<Clip extends string>(spec: SetSpec<Clip>): Promise<void> {
  const OUT = path.join(process.cwd(), "public", "sprites", spec.id);
  await mkdir(OUT, { recursive: true });
  const cols = Math.max(...spec.clipOrder.map((c) => spec.clips[c].frames));
  const rows = 1 + Math.max(...spec.clipOrder.map((c) => spec.clips[c].row));
  const blockW = cols * FRAME_W;
  const blockH = rows * FRAME_H;
  const fileOf = (l: SetLayer): string => (l.family === "rarity" ? `rarity-${l.id.split(".")[0]}` : l.family);

  const byFile = new Map<string, SetLayer[]>();
  for (const l of spec.layers) byFile.set(fileOf(l), [...(byFile.get(fileOf(l)) ?? []), l]);
  const images: Record<string, string> = {};
  const layers: SpriteManifest["layers"] = {};
  let cells = 0;
  for (const [file, group] of byFile) {
    const atlas = createCanvas(blockW, blockH * group.length);
    const ctx = atlas.getContext("2d");
    for (const [i, layer] of group.entries()) {
      const y0 = i * blockH;
      for (const clip of spec.clipOrder) {
        for (let f = 0; f < spec.clips[clip].frames; f++) {
          const { canvas, g } = newFrame();
          const pose = spec.poseFor(clip, f);
          layer.draw(g, pose as never, spec.joints(pose as never) as never);
          if (spec.innerOutline && layer.tint !== null) recolor(canvas, OL, spec.innerOutline);
          ctx.putImageData(imageDataOf(pixelate(canvas, layer.tint === null ? 9 : 7)), f * FRAME_W, y0 + spec.clips[clip].row * FRAME_H);
          cells++;
        }
      }
      layers[layer.id] = { image: file, x: 0, y: y0, z: layer.z, tint: layer.tint, ...(layer.of ? { of: layer.of } : {}), ...(layer.attack ? { attack: layer.attack } : {}), ...muzzleOf(spec, layer), ...(layer.variants?.length ? { variants: layer.variants } : {}) };
    }
    images[file] = `${file}.png`;
    await writeFile(path.join(OUT, `${file}.png`), atlas.toBuffer("image/png"));
  }
  const auraAtlas = createCanvas(AURA_FRAMES * FRAME_W, FRAME_H * spec.auras.length);
  const actx = auraAtlas.getContext("2d");
  for (const [i, aura] of spec.auras.entries()) {
    for (let f = 0; f < AURA_FRAMES; f++) {
      const { canvas, g } = newFrame();
      aura.draw(g, f, AURA_FRAMES);
      actx.putImageData(imageDataOf(pixelate(canvas, 7)), f * FRAME_W, i * FRAME_H);
      cells++;
    }
    layers[aura.id] = { image: "auras", x: 0, y: i * FRAME_H, z: -5, tint: "rarity", loop: { frames: AURA_FRAMES, fps: 10 } };
  }
  images.auras = "auras.png";
  await writeFile(path.join(OUT, "auras.png"), auraAtlas.toBuffer("image/png"));

  const manifest = parseManifest({
    spec: SPRITE_SPEC_VERSION,
    id: spec.id,
    name: spec.name,
    status: "dev-placeholder",
    credits: spec.credits,
    ...(spec.outline ? { outline: spec.outline } : {}),
    frame: { w: FRAME_W, h: FRAME_H },
    anchor: spec.anchor,
    nominalHeightPx: spec.nominalHeightPx,
    images,
    clips: Object.fromEntries(spec.clipOrder.map((c) => { const d = spec.clips[c]; return [c, { row: d.row, frames: d.frames, fps: d.fps, loop: d.loop, ...(d.impact !== undefined ? { impact: d.impact } : {}) }]; })),
    directions: { right: { index: 0 }, left: { mirror: "right" } },
    layers,
  });
  await writeFile(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`built ${spec.id}: ${Object.keys(manifest.layers).length} layers, ${Object.keys(images).length} atlases, ${cells} cells → ${path.relative(process.cwd(), OUT)}`);
}
