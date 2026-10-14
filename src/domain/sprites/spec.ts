import { z } from "zod";

/**
 * Clank Sprite Spec v1 — the contract between the game and ANY sprite art (the shipped dev
 * placeholders or a professional pack that replaces them).
 *
 * The model is LPC-style layered spritesheets:
 *   · every layer (body, outfit, hair, weapon, …) is drawn on the SAME frame grid, so any
 *     compatible combination composites into one hero with identical timing and hitboxes;
 *   · a layer is a block of cells: one row per clip, one column per frame;
 *   · what lives where is described by a JSON manifest, never hard-coded in the renderer.
 *
 * This file is pure (no DOM, no I/O) so the server, the browser, the validators and the tests
 * all share one definition.
 */

/**
 * 1 = every layer is one block of full cells (v1, the original v2).  2 = additionally allows PACKED layers (`cells`): per skeleton (`rigs`), each
 * clip row is stored as a strip of trimmed cells — a set can then draw every layer once per class skeleton for a fraction of the memory.
 */
export const SPRITE_SPEC_VERSION = 2;

/** Logical states the arena can ask a hero to be in. */
export const ANIM_STATES = ["IDLE", "MOVE", "ATTACK", "SKILL", "HIT", "KO", "VICTORY", "BLOCK", "TURN"] as const;
export type AnimState = (typeof ANIM_STATES)[number];

/**
 * Concrete clips (rows) a sprite set provides. ATTACK comes in three styles so every weapon
 * family animates plausibly while all layers still share one frame grid. `idle2` (optional) is a second
 * STANCE: each hero stands in one of the two, chosen from its never-rerolled look (plan.idleClip).
 * Optional presentation clips (renderer v3): `run` (a faster gait, chosen by ground speed), `block` (the target of a MISS parries or
 * dodges), `turn` (a facing change passes through a front view). A set without them behaves exactly as before.
 */
export const CLIP_KEYS = ["idle", "move", "attack_slash", "attack_thrust", "attack_shoot", "skill", "hit", "ko", "victory", "idle2", "run", "block", "turn"] as const;
export type ClipKey = (typeof CLIP_KEYS)[number];
export const ATTACK_CLIPS = ["attack_slash", "attack_thrust", "attack_shoot"] as const satisfies readonly ClipKey[];
export type AttackClip = (typeof ATTACK_CLIPS)[number];

/** A set is unusable without these; the others degrade gracefully (see animator.resolveClip). */
export const REQUIRED_CLIPS = ["idle", "move", "attack_slash", "skill", "hit", "ko"] as const satisfies readonly ClipKey[];

/**
 * Composable visual slots. `body` is implicit: layer `body.base` is always required.
 * `trim`, `shoulder`, `crest` and `weaponfx` are the rarity enhancement layers (hero generator 2): drawn per class look and per rarity
 * tier, they only ever ADD to the class silhouette.
 */
export const SLOT_IDS = ["eyes", "mouth", "hair", "outfit", "weapon", "offhand", "headgear", "accessory", "cape", "aura", "trim", "shoulder", "crest", "weaponfx"] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export const BODY_LAYER_ID = "body.base";

/** Which palette colour a (grayscale-authored) layer is tinted with. `null` = drawn as authored. */
export const TINT_ROLES = ["skin", "hair", "primary", "secondary", "accent", "rarity", "cape", "metal", "cloth"] as const;
export type TintRole = (typeof TINT_ROLES)[number];

export const DIRECTIONS = ["down", "left", "right", "up"] as const;
export type Direction = (typeof DIRECTIONS)[number];

// ---------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const clipSchema = z.strictObject({
  /** Row of the clip inside every layer block. */
  row: int(0, 63),
  frames: int(1, 32),
  fps: z.number().min(1).max(60),
  /** Loops while the state lasts (idle, move, victory) instead of playing once. */
  loop: z.boolean(),
  /** Frame where the hit "lands" (attacks/skills) — lets effects line up with the animation. */
  impact: int(0, 31).optional(),
  /** Locomotion clips: sprite pixels covered by one cycle (documentation for the stride-locked clock). */
  stride: z.number().min(1).max(512).optional(),
  /**
   * `run`: the ground speed (world units / s) at which the cycle plays at its own fps. The arena's move clock runs at real time at 62 units / s
   * (the walk's cadence); a run authored for a faster speed is advanced proportionally slower, so its feet stay planted too.
   */
  refSpeed: z.number().min(1).max(1000).optional(),
});
export type ClipDef = z.infer<typeof clipSchema>;

const RIG_ID = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/);
const ITEM_ID = z.string().regex(/^[a-z]+\.[a-z0-9_.-]+$/);
const RARITY = z.enum(["COMMON", "RARE", "EPIC", "LEGENDARY"]);

/**
 * One clip row of a PACKED layer: `[image, cells]`. `cells` is compact text — one cell per frame, separated by `;`: `x,y,w,h,ox,oy` in base 36
 * (the frame's trimmed pixels at (x, y) in the atlas, `w × h`, drawn at (ox, oy) inside its frame), or `-` for a frame that draws nothing.
 * Every frame is trimmed on its own, and identical cells (a held pose, a lying KO) share one place in the atlas. Text, not nested arrays: a
 * design library has ~10k rows, and a phone validates one short string per row much faster than six numbers per frame.
 */
export const PACKED_CELLS = /^(?:-|[0-9a-z]+(?:,[0-9a-z]+){5})(?:;(?:-|[0-9a-z]+(?:,[0-9a-z]+){5}))*$/;
export const packedRowSchema = z.tuple([z.string().min(1), z.string().max(4096).regex(PACKED_CELLS)]);
export type PackedRow = z.infer<typeof packedRowSchema>;
/** A decoded cell: `[x, y, w, h, ox, oy]` (w = 0: the frame draws nothing). */
export type PackedCell = readonly [number, number, number, number, number, number];

const EMPTY_CELL: PackedCell = [0, 0, 0, 0, 0, 0];
/** Decodes a packed row's cells (pure; callers cache it). */
export function decodeCells(cells: string): PackedCell[] {
  return cells.split(";").map((c) => (c === "-" ? EMPTY_CELL : (c.split(",").map((n) => parseInt(n, 36)) as unknown as PackedCell)));
}
/** Encodes cells for a packed row. */
export function encodeCells(cells: readonly PackedCell[]): string {
  return cells.map((c) => (c[2] === 0 || c[3] === 0 ? "-" : c.map((n) => n.toString(36)).join(","))).join(";");
}

export const layerSchema = z.strictObject({
  /** Key into manifest.images (block layout). */
  image: z.string().min(1).optional(),
  /** Top-left of this layer's block inside that image, in pixels (block layout). */
  x: int(0, 65536).optional(),
  y: int(0, 65536).optional(),
  /**
   * PACKED layout (spec 2): per skeleton id (manifest.rigs), one entry per clip row (index = clip.row; null = draws nothing in that clip). A
   * layer drawn for some skeletons only (a class's own sword) simply has no entry for the others — and cannot be worn on them.
   */
  cells: z.record(RIG_ID, z.array(packedRowSchema.nullable()).max(64)).optional(),
  /** Weapons: the skeleton (class pose language) a hero holding this item is animated with. */
  rig: RIG_ID.optional(),
  /**
   * Weapons: the ARCHETYPE skeletons of the class (a brute, a duelist … each its own build, stance and grip). A hero holding this item is
   * animated with one of them, chosen from its never-rerolled look (plan.rigOf); absent = always `rig`.
   */
  builds: z.array(RIG_ID).min(1).max(8).optional(),
  /** Variants: the rarities that may wear this drawing (absent = any) — rarity picks the equipment TIER, the hero's look picks the design. */
  tiers: z.array(RARITY).min(1).max(4).optional(),
  /** Variants: relative chance among the drawings a hero may wear (default 1). */
  weight: int(1, 100).optional(),
  /** Overrides the catalogue's `hides` for the item while THIS drawing is worn (an open half-helm shows the hair a full helm hides). */
  hides: z.array(z.string().regex(/^[a-z]+$/)).max(8).optional(),
  /**
   * Parts: by default a part of an item is drawn with EVERY drawing of that item (a quiver, a class kit). `false`: only with the item's own
   * drawing — a sleeve that belongs to one outfit design, which another design of the same outfit replaces with its own.
   */
  kit: z.boolean().optional(),
  /** Draw order, low first. */
  z: int(-100, 1000),
  tint: z.enum(TINT_ROLES).nullable().optional(),
  /**
   * Makes this layer a PART of another item (e.g. `outfit.heavy.front` is the sleeve of
   * `outfit.heavy`). A sleeve must draw in front of the torso while the torso draws behind it, so
   * one catalogue item can own several layers at different depths. Parts render with their owner.
   */
  of: z.string().regex(/^[a-z]+\.[a-z0-9_.-]+$/).optional(),
  /** Weapons: which attack clip a hero holding this plays. */
  attack: z.enum(ATTACK_CLIPS).optional(),
  /** Shooting weapons: where the arrow / spell leaves on the impact frame of that attack clip (frame pixels, authored direction). */
  muzzle: z.strictObject({ x: z.number(), y: z.number() }).optional(),
  /** Shooting weapons drawn for several skeletons: the muzzle on each (an archetype holds the weapon its own way). Absent for a skeleton = `muzzle`. */
  muzzles: z.record(RIG_ID, z.strictObject({ x: z.number(), y: z.number() })).optional(),
  /** Auras: a single row of frames that loops independently of the body clip. */
  loop: z.strictObject({ frames: int(1, 64), fps: z.number().min(1).max(60) }).optional(),
  /**
   * Alternative drawings of THIS item (other layer ids of the set, each with its own parts). Which one a hero wears is a deterministic function
   * of its stored look (plan.variantOf) — variety between heroes of one class without re-rolling anyone. Absent = always this layer.
   */
  variants: z.array(ITEM_ID).max(64).optional(),
});
export type LayerDef = z.infer<typeof layerSchema>;

const directionSchema = z.union([z.strictObject({ index: int(0, 3) }), z.strictObject({ mirror: z.enum(DIRECTIONS) })]);

export const manifestSchema = z
  .strictObject({
    spec: z.union([z.literal(1), z.literal(SPRITE_SPEC_VERSION)]),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    name: z.string().min(1).max(80),
    /** `dev-placeholder` = generated stand-in art. Flip to `production` only for real, licensed art. */
    status: z.enum(["dev-placeholder", "production"]),
    credits: z.string().max(400).optional(),
    /**
     * true (default): crisp pixel art — images are drawn without smoothing. Set false for painted /
     * high-resolution art so it is scaled with smoothing instead of looking blocky.
     */
    pixelArt: z.boolean().optional(),
    /**
     * Optional silhouette outline colour (`#rrggbb`). When set, every composed hero strip gets ONE clean 1 px outline around the whole figure (pixel
     * art reads by its silhouette; per-layer outlines alone leave seams where layers overlap). Absent = drawn exactly as composed (v1).
     */
    outline: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    /**
     * true: each hero wears its class colours in one of five TONES (deeper … paler), picked from its never-rerolled look (config.PALETTE_TONES)
     * — same-class heroes are not one shade. Absent = the class colours with the hero's hue shift only (v1).
     */
    paletteTones: z.boolean().optional(),
    frame: z.strictObject({ w: int(8, 512), h: int(8, 512) }),
    /** Skeletons (spec 2): each class animates with its own proportions and pose language; packed layers store cells per skeleton. First = default. */
    rigs: z.array(RIG_ID).min(1).max(32).optional(),
    /** Feet pivot inside a frame (where the hero stands on the arena floor). */
    anchor: z.strictObject({ x: z.number().min(0), y: z.number().min(0) }),
    /** Feet-to-top-of-head height inside a frame; the renderer scales so this matches the arena's hero height. */
    nominalHeightPx: z.number().min(8).max(512),
    images: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), z.string().regex(/^[a-z0-9][a-z0-9._-]*\.png$/)),
    clips: z.partialRecord(z.enum(CLIP_KEYS), clipSchema),
    /** `right` is the authored direction; `left` normally mirrors it. down/up are optional future rows. */
    directions: z.partialRecord(z.enum(DIRECTIONS), directionSchema),
    layers: z.record(z.string().regex(/^[a-z]+\.[a-z0-9_.-]+$/), layerSchema),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
    for (const key of REQUIRED_CLIPS) if (!m.clips[key]) issue(`missing required clip "${key}"`, ["clips", key]);
    const rows = new Set<number>();
    for (const [key, clip] of Object.entries(m.clips)) {
      if (!clip) continue;
      if (rows.has(clip.row)) issue(`clip "${key}" reuses row ${clip.row}`, ["clips", key, "row"]);
      rows.add(clip.row);
      if (clip.impact !== undefined && clip.impact >= clip.frames) issue("impact frame is outside the clip", ["clips", key, "impact"]);
    }
    if (!m.directions.right) issue('direction "right" is the authored direction and is required', ["directions", "right"]);
    for (const [id, layer] of Object.entries(m.layers)) for (const v of layer.variants ?? []) if (!m.layers[v]) issue(`layer "${id}" names a variant "${v}" the set does not have`, ["layers", id, "variants"]);
    for (const [name, dir] of Object.entries(m.directions)) {
      if (dir && "mirror" in dir) {
        const target = m.directions[dir.mirror];
        if (!target || "mirror" in target) issue(`direction "${name}" mirrors "${dir.mirror}", which must be an authored direction`, ["directions", name]);
      }
    }
    const authored = Object.values(m.directions).filter((d) => d && "index" in d).map((d) => (d as { index: number }).index);
    if (new Set(authored).size !== authored.length) issue("authored directions must use distinct indexes", ["directions"]);
    if (!m.layers[BODY_LAYER_ID]) issue(`missing required layer "${BODY_LAYER_ID}"`, ["layers", BODY_LAYER_ID]);
    const rigs = new Set(m.rigs ?? []);
    const rowCount = 1 + Math.max(0, ...Object.values(m.clips).map((c) => c?.row ?? 0));
    for (const [id, layer] of Object.entries(m.layers)) {
      const block = layer.image !== undefined && layer.x !== undefined && layer.y !== undefined;
      if (!block && !layer.cells) issue(`layer "${id}" has neither a block (image, x, y) nor packed cells`, ["layers", id]);
      if (layer.cells && m.spec < 2) issue(`layer "${id}" is packed, which needs spec 2`, ["layers", id, "cells"]);
      if (layer.loop && !block) issue(`looping layer "${id}" must use the block layout`, ["layers", id]);
      if (layer.image !== undefined && !m.images[layer.image]) issue(`layer "${id}" references unknown image "${layer.image}"`, ["layers", id, "image"]);
      if (layer.rig && !rigs.has(layer.rig)) issue(`layer "${id}" names an unknown rig "${layer.rig}"`, ["layers", id, "rig"]);
      for (const r of layer.builds ?? []) if (!rigs.has(r)) issue(`layer "${id}" names an unknown build "${r}"`, ["layers", id, "builds"]);
      for (const r of Object.keys(layer.muzzles ?? {})) if (!rigs.has(r)) issue(`layer "${id}" has a muzzle for an unknown rig "${r}"`, ["layers", id, "muzzles"]);
      for (const [rig, rows] of Object.entries(layer.cells ?? {})) {
        if (!rigs.has(rig)) issue(`layer "${id}" has cells for an unknown rig "${rig}"`, ["layers", id, "cells", rig]);
        if (rows.length > rowCount) issue(`layer "${id}" (${rig}) has more rows than the set has clips`, ["layers", id, "cells", rig]);
        rows.forEach((r, i) => {
          if (!r) return;
          if (!m.images[r[0]]) issue(`layer "${id}" (${rig}) row ${i} references unknown image "${r[0]}"`, ["layers", id, "cells", rig, i]);
          const clip = Object.values(m.clips).find((c) => c?.row === i);
          const n = r[1].split(";").length;
          if (clip && n !== clip.frames) issue(`layer "${id}" (${rig}) row ${i} has ${n} cells for ${clip.frames} frames`, ["layers", id, "cells", rig, i]);
        });
      }
      if (layer.of && !m.layers[layer.of]) issue(`layer "${id}" is a part of unknown item "${layer.of}"`, ["layers", id, "of"]);
      if (layer.of && m.layers[layer.of]?.of) issue(`layer "${id}": parts cannot be nested`, ["layers", id, "of"]);
      if (layer.attack && !m.clips[layer.attack]) issue(`layer "${id}" plays attack clip "${layer.attack}" that this set does not define`, ["layers", id, "attack"]);
    }
  });

export type SpriteManifest = z.infer<typeof manifestSchema>;

/** Parses and validates untrusted manifest JSON. Throws a ZodError describing the first problems. */
export function parseManifest(raw: unknown): SpriteManifest {
  return manifestSchema.parse(raw);
}

export function safeParseManifest(raw: unknown): { ok: true; manifest: SpriteManifest } | { ok: false; error: string } {
  const r = manifestSchema.safeParse(raw);
  if (r.success) return { ok: true, manifest: r.data };
  return { ok: false, error: r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ") };
}
