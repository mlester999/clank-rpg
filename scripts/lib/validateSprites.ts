import { readFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";

import { COSMETIC_ITEMS } from "../../src/domain/sprites/catalog";
import { blockSize, directionBlocks } from "../../src/domain/sprites/geometry";
import { rollAppearance, type Rarity } from "../../src/domain/character/appearance";
import { DEFAULT_CLASSES } from "../../src/domain/content";
import { deriveSpriteConfig } from "../../src/domain/sprites/config";
import { ATTACK_CLIPS, decodeCells, safeParseManifest, type SpriteManifest } from "../../src/domain/sprites/spec";
import { CLIP_ORDER, TIMING } from "../../src/domain/sprites/v3/clips";
import { FRAME_H, FRAME_W, heroOf, renderClipFrame } from "../../src/domain/sprites/v3/render";
import { isProceduralSet, v3Manifest } from "../../src/domain/sprites/v3/set";
import { validateFrame } from "../../src/domain/sprites/v3/validate";
import { createRng } from "../../src/domain/util/rng";

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

  if (isProceduralSet(setId)) return validateProcedural(setId, opts.strict === true);

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
    const mustHaveArt = id === "body.base" || /^outfit\.[a-z]+$/.test(id); // body and every outfit torso must have art in every cell
    if (layer.cells) {
      // packed: every row's strip lies inside its atlas, and its trimmed rectangle keeps 1 px clear of the frame edge (the outline needs it)
      for (const [rig, rows] of Object.entries(layer.cells)) {
        for (const [clip, def] of Object.entries(m.clips)) {
          if (!def) continue;
          const r = rows[def.row];
          const decoded = r ? decodeCells(r[1]) : [];
          if (!r || decoded.every((c) => c[2] === 0)) {
            // a skeleton plays only its own class's attack clip: the other attack rows are legitimately absent
            if (mustHaveArt && !(ATTACK_CLIPS as readonly string[]).includes(clip)) empty.push(`${id} ${rig} ${clip}`);
            continue;
          }
          const img = r[0];
          const a = atlas[img];
          cells += def.frames;
          if (!a) continue;
          if (decoded.length !== def.frames) errors.push(`layer "${id}" (${rig} ${clip}) has ${decoded.length} cells for ${def.frames} frames`);
          decoded.forEach(([x, y, w, h, ox, oy], f) => {
            if (w === 0) {
              if (mustHaveArt && !(ATTACK_CLIPS as readonly string[]).includes(clip)) empty.push(`${id} ${rig} ${clip} f${f}`);
              return;
            }
            if (x + w > a.w || y + h > a.h) {
              errors.push(`layer "${id}" (${rig} ${clip} f${f}) cell does not fit atlas "${img}" (${a.w}×${a.h})`);
              return;
            }
            const edge = `${ox === 0 ? "L" : ""}${ox + w >= fw ? "R" : ""}${oy === 0 ? "T" : ""}${oy + h >= fh ? "B" : ""}`;
            if (edge) clipped.push(`${id} ${rig} ${clip} f${f} [${edge}]`);
          });
        }
      }
      continue;
    }
    const a = layer.image !== undefined ? atlas[layer.image] : undefined;
    if (!a || layer.x === undefined || layer.y === undefined) continue;
    const lx = layer.x;
    const ly = layer.y;
    const w = layer.loop ? layer.loop.frames * fw : bs.w;
    const h = layer.loop ? fh : bs.h;
    if (lx + w > a.w || ly + h > a.h) {
      errors.push(`layer "${id}" block (${lx},${ly} ${w}×${h}) does not fit atlas "${layer.image}" (${a.w}×${a.h})`);
      continue;
    }
    if (layer.loop) {
      for (let f = 0; f < layer.loop.frames; f++) {
        const s = cellStats(a, lx + f * fw, ly);
        cells++;
        if (s.edge) clipped.push(`${id} loop f${f} [${s.edge}]`);
      }
      continue;
    }
    for (let d = 0; d < dirs; d++) {
      for (const [clip, def] of Object.entries(m.clips)) {
        if (!def) continue;
        for (let f = 0; f < def.frames; f++) {
          const s = cellStats(a, lx + f * fw, ly + (d * (bs.h / fh / dirs) + def.row) * fh);
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


/**
 * A PROCEDURAL set (hero renderer v3) has no atlases to inspect: its manifest is checked against the schema, and real generated heroes are
 * rendered and validated frame by frame (src/domain/sprites/v3/validate.ts) — `strict` renders 30 heroes per class, otherwise 8; every clip,
 * every frame. A weapon may sweep across a face for at most two frames of an action.
 */
function validateProcedural(setId: string, strict: boolean): SpriteValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = safeParseManifest(JSON.parse(JSON.stringify(v3Manifest())));
  if (!parsed.ok) errors.push(`manifest invalid: ${parsed.error}`);
  const rarities: Rarity[] = ["COMMON", "RARE", "EPIC", "LEGENDARY"];
  const per = strict ? 30 : 8;
  let frames = 0;
  for (const cls of DEFAULT_CLASSES) {
    for (let i = 0; i < per; i++) {
      const rarity = rarities[i % 4] as Rarity;
      const config = deriveSpriteConfig(rollAppearance(createRng(`validate-${setId}-${cls.id}-${i}`), cls, rarity), cls.look, rarity);
      const hero = heroOf({ config, colors: cls.look.colors, rarity });
      for (const clip of CLIP_ORDER) {
        if (clip.startsWith("attack") && clip !== hero.lo.attack) continue;
        let brief = 0;
        for (let f = 0; f < TIMING[clip].frames; f++) {
          const fr = renderClipFrame(hero, clip, f);
          frames++;
          if (fr.w !== FRAME_W || fr.h !== FRAME_H || fr.rgba.length !== FRAME_W * FRAME_H * 4) errors.push(`${cls.id}#${i} ${clip}#${f}: wrong frame size`);
          for (const iss of validateFrame(hero, clip, fr)) {
            if (iss.code === "eyes-action") brief++;
            else errors.push(`${cls.id}#${i} ${hero.g.arch} ${clip}#${f} ${iss.code}: ${iss.detail}`);
          }
        }
        if (brief > 2) errors.push(`${cls.id}#${i} ${hero.g.arch} ${clip}: a face covered for ${brief} frames of the action`);
      }
    }
  }
  return { ok: errors.length === 0, manifest: parsed.ok ? parsed.manifest : null, errors, warnings, stats: { layers: 0, atlases: 0, cellsChecked: frames } };
}
