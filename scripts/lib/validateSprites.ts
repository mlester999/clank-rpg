import { readFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";

import { COSMETIC_ITEMS } from "../../src/domain/sprites/catalog";
import { blockSize, directionBlocks } from "../../src/domain/sprites/geometry";
import { safeParseManifest, type SpriteManifest } from "../../src/domain/sprites/spec";

/**
 * Acceptance check for a sprite set (the shipped dev set AND any production pack):
 *
 *   pnpm sprites:validate -- [setId]          (default clank-dev-v1; --strict fails on missing catalogue art; --all lists every offending cell)
 *
 * Errors mean "the engine would draw this wrong": a broken manifest, an atlas that is too small
 * for the layer blocks it declares, a layer that touches the frame edge (clipped art), an empty
 * body/outfit cell. Warnings are catalogue items the set has no art for yet.
 */

export interface SpriteValidation {
  ok: boolean;
  manifest: SpriteManifest | null;
  errors: string[];
  warnings: string[];
  stats: { layers: number; atlases: number; cellsChecked: number };
}

export const SPRITES_ROOT = path.join(process.cwd(), "public", "sprites");

export async function validateSpriteSet(setId: string, opts: { strict?: boolean; root?: string; listAll?: boolean } = {}): Promise<SpriteValidation> {
  const dir = path.join(opts.root ?? SPRITES_ROOT, setId);
  const errors: string[] = [];
  const warnings: string[] = [];
  const out = (manifest: SpriteManifest | null, cells = 0, atlases = 0): SpriteValidation => ({
    ok: errors.length === 0, manifest, errors, warnings, stats: { layers: manifest ? Object.keys(manifest.layers).length : 0, atlases, cellsChecked: cells },
  });

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  } catch (e) {
    errors.push(`cannot read ${setId}/manifest.json: ${(e as Error).message}`);
    return out(null);
  }
  const parsed = safeParseManifest(raw);
  if (!parsed.ok) {
    errors.push(`manifest invalid: ${parsed.error}`);
    return out(null);
  }
  const m = parsed.manifest;
  if (m.id !== setId) errors.push(`manifest id "${m.id}" does not match its folder "${setId}"`);
  if (m.anchor.x > m.frame.w || m.anchor.y > m.frame.h) errors.push("anchor lies outside the frame");
  if (m.nominalHeightPx > m.frame.h) errors.push("nominalHeightPx exceeds the frame height");

  // atlases
  const atlas: Record<string, { w: number; h: number; data: Uint8ClampedArray }> = {};
  for (const [key, file] of Object.entries(m.images)) {
    try {
      const img = await loadImage(path.join(dir, file));
      const c = createCanvas(img.width, img.height);
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      atlas[key] = { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
    } catch (e) {
      errors.push(`atlas "${key}" (${file}) cannot be read as an image: ${(e as Error).message}`);
    }
  }

  // layer blocks fit inside their atlas, and nothing touches the frame edge
  const bs = blockSize(m);
  const { w: fw, h: fh } = m.frame;
  const dirs = directionBlocks(m);
  let cells = 0;
  const clipped: string[] = [];
  const empty: string[] = [];
  const cellStats = (a: (typeof atlas)[string], sx: number, sy: number) => {
    let edge = "";
    let opaque = 0;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        if ((a.data[((sy + y) * a.w + sx + x) * 4 + 3] as number) > 8) {
          opaque++;
          if (x === 0 && !edge.includes("L")) edge += "L";
          if (x === fw - 1 && !edge.includes("R")) edge += "R";
          if (y === 0 && !edge.includes("T")) edge += "T";
          if (y === fh - 1 && !edge.includes("B")) edge += "B";
        }
      }
    }
    return { edge, opaque };
  };
  for (const [id, layer] of Object.entries(m.layers)) {
    const a = atlas[layer.image];
    if (!a) continue;
    const w = layer.loop ? layer.loop.frames * fw : bs.w;
    const h = layer.loop ? fh : bs.h;
    if (layer.x + w > a.w || layer.y + h > a.h) {
      errors.push(`layer "${id}" block (${layer.x},${layer.y} ${w}×${h}) does not fit atlas "${layer.image}" (${a.w}×${a.h})`);
      continue;
    }
    const mustHaveArt = id === "body.base" || /^outfit\.[a-z]+$/.test(id); // body and every outfit torso must have art in every cell
    if (layer.loop) {
      for (let f = 0; f < layer.loop.frames; f++) {
        const s = cellStats(a, layer.x + f * fw, layer.y);
        cells++;
        if (s.edge) clipped.push(`${id} loop f${f} [${s.edge}]`);
      }
      continue;
    }
    for (let d = 0; d < dirs; d++) {
      for (const [clip, def] of Object.entries(m.clips)) {
        if (!def) continue;
        for (let f = 0; f < def.frames; f++) {
          const s = cellStats(a, layer.x + f * fw, layer.y + (d * (bs.h / fh / dirs) + def.row) * fh);
          cells++;
          if (s.edge) clipped.push(`${id} ${clip} f${f}${dirs > 1 ? ` dir${d}` : ""} [${s.edge}]`);
          if (s.opaque === 0 && mustHaveArt) empty.push(`${id} ${clip} f${f}`);
        }
      }
    }
  }
  if (clipped.length) errors.push(`${clipped.length} cell(s) touch the frame edge (art would be cut off): ${clipped.slice(0, opts.listAll ? clipped.length : 8).join("; ")}${clipped.length > 8 && !opts.listAll ? "; … (use --all to list every one)" : ""}`);
  if (empty.length) errors.push(`${empty.length} body/outfit cell(s) are empty: ${empty.slice(0, 6).join("; ")}`);

  // catalogue coverage
  const missing = COSMETIC_ITEMS.filter((i) => i.enabled && !m.layers[i.id]).map((i) => i.id);
  if (missing.length) (opts.strict ? errors : warnings).push(`${missing.length} catalogue item(s) have no art in this set: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`);
  if (m.status === "dev-placeholder") warnings.push("status is dev-placeholder: this is stand-in art, not production art");

  return out(m, cells, Object.keys(atlas).length);
}
