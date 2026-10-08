import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas } from "@napi-rs/canvas";

import { ATTACK_CLIPS, encodeCells, parseManifest, SPRITE_SPEC_VERSION, type PackedCell, type PackedRow, type SpriteManifest } from "../../src/domain/sprites/spec";

import { recolor } from "./buildSet";
import { encodeIndexedPng } from "./png";
import { FRAME_H as FH, FRAME_W as FW, imageDataOf, newFrame, OL, pixelate, type Ctx } from "./pen";

/**
 * Builds a PACKED sprite set (spec 2): every layer is drawn once per skeleton it can be worn on (each class has its own proportions and pose
 * language), and every clip row is stored as a strip of TRIMMED cells — the union rectangle of what its frames draw — packed into atlas pages.
 * A full 80 × 64 cell is mostly empty (a mouth is a few pixels): trimming cuts the decoded atlas size ~8×, which is what makes six skeletons and
 * a large design library affordable.
 *
 *   · every frame is trimmed on its own, and identical cells (a pose held over several frames, a lying KO) are stored once per page;
 *   · pages are written as exact palette PNGs (the art is posterised: a page has a few hundred colours) — half the bytes of an RGBA PNG;
 *   · pages are grouped by skeleton (`<rig>-<n>`; auras on their own page), named by content hash — a browser can never pair a new manifest with
 *     a stale cached atlas, and an unchanged page keeps its name (and its cache) across builds;
 *   · a skeleton only gets the attack row its class plays (`attack`); the other attack rows are absent (the class never plays them);
 *   · stale files of the set are removed.
 */

export interface PackedRig<Clip extends string> {
  id: string;
  /** The attack clip this class plays (its weapon's). */
  attack: Clip;
  poseFor: (clip: Clip, f: number) => unknown;
  joints: (pose: never) => unknown;
}

export interface PackedLayer {
  id: string;
  of?: string;
  family: string;
  z: number;
  tint: SpriteManifest["layers"][string]["tint"];
  attack?: SpriteManifest["layers"][string]["attack"];
  /** Shooting weapons: where the projectile leaves (frame px) on the impact frame of the attack, on the weapon's own skeleton. */
  muzzle?: (joints: never) => readonly [number, number];
  variants?: string[];
  /** Skeletons this layer is drawn for (default: every rig of the set). */
  rigs?: readonly string[];
  /** Weapons: the class skeleton a hero holding this is animated with. */
  rig?: string;
  /** Weapons: the skeletons (archetypes) of its class, one chosen per hero (plan.rigOf). */
  builds?: readonly string[];
  tiers?: Array<"COMMON" | "RARE" | "EPIC" | "LEGENDARY">;
  weight?: number;
  hides?: string[];
  kit?: boolean;
  /** A catalogue item this set intentionally draws as nothing (it exists for every skeleton, with no rows). */
  empty?: boolean;
  draw: (g: Ctx, pose: never, joints: never) => void;
}

export interface PackedSetSpec<Clip extends string> {
  id: string;
  name: string;
  credits: string;
  outline?: string;
  innerOutline?: string;
  /** Vary the class colours' tone per hero (manifest `paletteTones`). */
  paletteTones?: boolean;
  anchor: { x: number; y: number };
  nominalHeightPx: number;
  clips: Record<Clip, { row: number; frames: number; fps: number; loop: boolean; impact?: number }>;
  clipOrder: readonly Clip[];
  rigs: ReadonlyArray<PackedRig<Clip>>;
  layers: readonly PackedLayer[];
  auras: ReadonlyArray<{ id: string; draw: (g: Ctx, frame: number, frames: number) => void }>;
  /** Only build these skeletons (a quick preview set while iterating on one class). */
  onlyRigs?: readonly string[];
  /** Frame size (default 80 × 64). */
  frame?: { w: number; h: number };
  /**
   * The FLOOR (frame y): nothing is drawn below it — a planted greatsword's point, a grounded staff's foot, a mace resting head-down or a fallen
   * hero's sword stops at the ground (it reads as standing on it) instead of sinking through it or off the frame.
   */
  floor?: number;
}

const PAGE_W = 2048;
const PAGE_MAX_H = 4096;
const AURA_FRAMES = 8;

interface Cell {
  ox: number;
  oy: number;
  w: number;
  h: number;
  pixels: Uint8ClampedArray; // w × h RGBA
  /** Content hash: identical cells share one place in the atlas. */
  key: string;
}

interface RowCells {
  layer: string;
  rig: string;
  row: number;
  /** One per frame; null = the frame draws nothing. */
  cells: Array<Cell | null>;
}

/** Renders one clip row of one layer on one skeleton, each frame trimmed to its own opaque rectangle (null: the row draws nothing at all). */
function renderRow<Clip extends string>(spec: PackedSetSpec<Clip>, rig: PackedRig<Clip>, layer: PackedLayer, clip: Clip): RowCells | null {
  const def = spec.clips[clip];
  const FRAME_W = spec.frame?.w ?? FW;
  const FRAME_H = spec.frame?.h ?? FH;
  const cells: Array<Cell | null> = [];
  for (let f = 0; f < def.frames; f++) {
    const { canvas, g } = newFrame(FRAME_W, FRAME_H);
    const pose = rig.poseFor(clip, f);
    if (spec.floor !== undefined) {
      g.beginPath();
      g.rect(0, 0, FRAME_W, spec.floor);
      g.clip();
    }
    layer.draw(g, pose as never, rig.joints(pose as never) as never);
    if (spec.innerOutline && layer.tint !== null) recolor(canvas, OL, spec.innerOutline);
    const px = pixelate(canvas, layer.tint === null ? 9 : 7);
    let x0 = FRAME_W;
    let y0 = FRAME_H;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++) {
        if ((px[(y * FRAME_W + x) * 4 + 3] as number) === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) {
      cells.push(null);
      continue;
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = ((y0 + y) * FRAME_W + x0) * 4;
      pixels.set(px.subarray(src, src + w * 4), y * w * 4);
    }
    const key = createHash("sha1").update(`${w}x${h}`).update(pixels).digest("hex");
    cells.push({ ox: x0, oy: y0, w, h, pixels, key });
  }
  if (cells.every((c) => c === null)) return null;
  return { layer: layer.id, rig: rig.id, row: def.row, cells };
}

interface Page {
  w: number;
  h: number;
  at: Map<string, { x: number; y: number; cell: Cell }>;
}

/** Shelf packing of distinct cells: tallest first, left to right, a new shelf when a row is full. Null when it does not fit one page. */
function packCells(cells: Cell[]): Page | null {
  const sorted = [...cells].sort((a, b) => b.h - a.h || b.w - a.w || (a.key < b.key ? -1 : 1));
  const at = new Map<string, { x: number; y: number; cell: Cell }>();
  let shelfY = 0;
  let shelfH = 0;
  let x = 0;
  let w = 0;
  for (const c of sorted) {
    if (x + c.w > PAGE_W) {
      shelfY += shelfH;
      shelfH = 0;
      x = 0;
    }
    if (shelfY + c.h > PAGE_MAX_H) return null;
    at.set(c.key, { x, y: shelfY, cell: c });
    x += c.w;
    shelfH = Math.max(shelfH, c.h);
    w = Math.max(w, x);
  }
  return { w, h: shelfY + shelfH, at };
}

/** Splits a skeleton's rows into pages (a row's cells always share one page), each page packed with its distinct cells. */
function paginate(rows: RowCells[]): Array<{ rows: RowCells[]; page: Page }> {
  const distinct = (rs: RowCells[]): Cell[] => {
    const m = new Map<string, Cell>();
    for (const r of rs) for (const c of r.cells) if (c) m.set(c.key, c);
    return [...m.values()];
  };
  const out: Array<{ rows: RowCells[]; page: Page }> = [];
  let rest = rows;
  while (rest.length) {
    // the largest prefix of the remaining rows that packs into one page (binary search on the count)
    let lo = 1;
    let hi = rest.length;
    let best: { n: number; page: Page } | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const page = packCells(distinct(rest.slice(0, mid)));
      if (page) {
        best = { n: mid, page };
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (!best) throw new Error(`a row of ${rest[0]?.layer} does not fit an atlas page`);
    out.push({ rows: rest.slice(0, best.n), page: best.page });
    rest = rest.slice(best.n);
  }
  return out;
}

const hash8 = (buf: Buffer): string => createHash("sha1").update(buf).digest("hex").slice(0, 8);

export async function buildPackedSet<Clip extends string>(spec: PackedSetSpec<Clip>): Promise<void> {
  const OUT = path.join(process.cwd(), "public", "sprites", spec.id);
  await mkdir(OUT, { recursive: true });
  const rigs = spec.rigs.filter((r) => !spec.onlyRigs || spec.onlyRigs.includes(r.id));
  const rigIds = rigs.map((r) => r.id);
  const rows = 1 + Math.max(...spec.clipOrder.map((c) => spec.clips[c].row));
  const t0 = Date.now();

  const cellsOf = new Map<string, Record<string, Array<PackedRow | null>>>();
  for (const layer of spec.layers) {
    const perRig: Record<string, Array<PackedRow | null>> = {};
    for (const rigId of (layer.rigs ?? rigIds).filter((r) => rigIds.includes(r))) perRig[rigId] = new Array<PackedRow | null>(rows).fill(null);
    cellsOf.set(layer.id, perRig);
  }
  let frames = 0;
  let renderedRows = 0;

  // ONE SKELETON AT A TIME (render its rows, pack its pages, write them, let the pixels go): a library drawn on eighteen skeletons does not fit
  // in memory all at once. Identical cells share one pixel buffer from the moment they are drawn. Row order is deterministic: layer order, then
  // clip order.
  const images: Record<string, string> = {};
  const files = new Set<string>();
  let stored = 0;
  for (const rigId of rigIds) {
    const rig = rigs.find((r) => r.id === rigId) as PackedRig<Clip>;
    const rendered: RowCells[] = [];
    const shared = new Map<string, Cell>();
    for (const layer of spec.layers) {
      if (layer.empty || !(layer.rigs ?? rigIds).includes(rigId)) continue;
      for (const clip of spec.clipOrder) {
        if ((ATTACK_CLIPS as readonly string[]).includes(clip) && clip !== rig.attack) continue;
        const r = renderRow(spec, rig, layer, clip);
        frames += spec.clips[clip].frames;
        if (!r) continue;
        r.cells = r.cells.map((c) => {
          if (!c) return null;
          const known = shared.get(c.key);
          if (known) return known;
          shared.set(c.key, c);
          return c;
        });
        rendered.push(r);
      }
    }
    renderedRows += rendered.length;
    for (const [n, { rows: pageRows, page }] of paginate(rendered).entries()) {
      const canvas = createCanvas(Math.max(1, page.w), Math.max(1, page.h));
      const ctx = canvas.getContext("2d");
      for (const { x, y, cell } of page.at.values()) {
        ctx.putImageData(imageDataOf(cell.pixels, cell.w, cell.h), x, y);
        stored += cell.w * cell.h;
      }
      const key = `${rigId}-${n}`;
      for (const r of pageRows) {
        const rowsOf = cellsOf.get(r.layer) as Record<string, Array<PackedRow | null>>;
        (rowsOf[r.rig] as Array<PackedRow | null>)[r.row] = [key, encodeCells(r.cells.map((c): PackedCell => {
          if (!c) return [0, 0, 0, 0, 0, 0];
          const p = page.at.get(c.key) as { x: number; y: number };
          return [p.x, p.y, c.w, c.h, c.ox, c.oy];
        }))];
      }
      const png = encodeIndexedPng(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height) ?? canvas.toBuffer("image/png");
      const file = `${key}-${hash8(png)}.png`;
      images[key] = file;
      files.add(file);
      await writeFile(path.join(OUT, file), png);
    }
  }

  // auras: a single looping row each, block layout
  const FRAME_W = spec.frame?.w ?? FW;
  const FRAME_H = spec.frame?.h ?? FH;
  const auraAtlas = createCanvas(AURA_FRAMES * FRAME_W, FRAME_H * Math.max(1, spec.auras.length));
  const actx = auraAtlas.getContext("2d");
  const layers: SpriteManifest["layers"] = {};
  for (const [i, aura] of spec.auras.entries()) {
    for (let f = 0; f < AURA_FRAMES; f++) {
      const { canvas, g } = newFrame(FRAME_W, FRAME_H);
      aura.draw(g, f, AURA_FRAMES);
      actx.putImageData(imageDataOf(pixelate(canvas, 7), FRAME_W, FRAME_H), f * FRAME_W, i * FRAME_H);
    }
    layers[aura.id] = { image: "auras", x: 0, y: i * FRAME_H, z: -5, tint: "rarity", loop: { frames: AURA_FRAMES, fps: 10 } };
  }
  const auraPng = encodeIndexedPng(actx.getImageData(0, 0, auraAtlas.width, auraAtlas.height).data, auraAtlas.width, auraAtlas.height) ?? auraAtlas.toBuffer("image/png");
  const auraFile = `auras-${hash8(auraPng)}.png`;
  images.auras = auraFile;
  files.add(auraFile);
  await writeFile(path.join(OUT, auraFile), auraPng);

  /**
   * Where a shooting weapon's projectile leaves on the impact frame of its attack: on its own (default) skeleton (`muzzle`) and on every skeleton it
   * is drawn for (`muzzles` — an archetype holds it with other arms, another stance and its own weapon scale).
   */
  const muzzleOf = (layer: PackedLayer): { muzzle?: { x: number; y: number }; muzzles?: Record<string, { x: number; y: number }> } => {
    const clip = layer.attack ? spec.clips[layer.attack as Clip] : undefined;
    if (!layer.muzzle || !clip || clip.impact === undefined) return {};
    const at = (rig: PackedRig<Clip>) => {
      const [x, y] = (layer.muzzle as NonNullable<PackedLayer["muzzle"]>)(rig.joints(rig.poseFor(layer.attack as Clip, clip.impact as number) as never) as never);
      return { x: Math.round(x * 2) / 2, y: Math.round(y * 2) / 2 };
    };
    const own = rigs.find((r) => r.id === (layer.rig ?? layer.rigs?.[0]));
    const on = rigs.filter((r) => (layer.rigs ?? rigIds).includes(r.id));
    return { ...(own ? { muzzle: at(own) } : {}), ...(on.length > 1 ? { muzzles: Object.fromEntries(on.map((r) => [r.id, at(r)])) } : {}) };
  };
  for (const layer of spec.layers) {
    const cells = cellsOf.get(layer.id) as Record<string, Array<PackedRow | null>>;
    // trailing empty rows are dropped (a row index past the end reads as "nothing")
    for (const r of Object.keys(cells)) {
      const arr = cells[r] as Array<PackedRow | null>;
      while (arr.length && arr[arr.length - 1] === null) arr.pop();
    }
    layers[layer.id] = {
      z: layer.z,
      tint: layer.tint,
      cells,
      ...(layer.of ? { of: layer.of } : {}),
      ...(layer.attack ? { attack: layer.attack } : {}),
      ...muzzleOf(layer),
      ...(layer.variants?.length ? { variants: layer.variants } : {}),
      ...(layer.rig && rigIds.includes(layer.rig) ? { rig: layer.rig } : {}),
      ...(layer.builds && layer.builds.filter((r) => rigIds.includes(r)).length > 1 ? { builds: layer.builds.filter((r) => rigIds.includes(r)) } : {}),
      ...(layer.tiers ? { tiers: layer.tiers } : {}),
      ...(layer.weight !== undefined ? { weight: layer.weight } : {}),
      ...(layer.hides ? { hides: layer.hides } : {}),
      ...(layer.kit !== undefined ? { kit: layer.kit } : {}),
    };
  }

  const manifest = parseManifest({
    spec: SPRITE_SPEC_VERSION,
    id: spec.id,
    name: spec.name,
    status: "dev-placeholder",
    credits: spec.credits,
    ...(spec.outline ? { outline: spec.outline } : {}),
    ...(spec.paletteTones ? { paletteTones: true } : {}),
    frame: { w: FRAME_W, h: FRAME_H },
    rigs: rigIds,
    anchor: spec.anchor,
    nominalHeightPx: spec.nominalHeightPx,
    images,
    clips: Object.fromEntries(spec.clipOrder.map((c) => { const d = spec.clips[c]; return [c, { row: d.row, frames: d.frames, fps: d.fps, loop: d.loop, ...(d.impact !== undefined ? { impact: d.impact } : {}) }]; })),
    directions: { right: { index: 0 }, left: { mirror: "right" } },
    layers,
  });
  for (const f of await readdir(OUT)) if (f.endsWith(".png") && !files.has(f)) await rm(path.join(OUT, f));
  await writeFile(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  console.log(`built ${spec.id}: ${Object.keys(manifest.layers).length} layers on ${rigIds.length} rigs, ${frames} frames → ${renderedRows} rows, ${(stored / 1e6).toFixed(2)} Mpx of distinct cells in ${Object.keys(images).length} atlases, ${((Date.now() - t0) / 1000).toFixed(1)} s → ${path.relative(process.cwd(), OUT)}`);
}
