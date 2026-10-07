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

export const SPRITE_SPEC_VERSION = 1;

/** Logical states the arena can ask a hero to be in. */
export const ANIM_STATES = ["IDLE", "MOVE", "ATTACK", "SKILL", "HIT", "KO", "VICTORY"] as const;
export type AnimState = (typeof ANIM_STATES)[number];

/**
 * Concrete clips (rows) a sprite set provides. ATTACK comes in three styles so every weapon
 * family animates plausibly while all layers still share one frame grid.
 */
export const CLIP_KEYS = ["idle", "move", "attack_slash", "attack_thrust", "attack_shoot", "skill", "hit", "ko", "victory"] as const;
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
export const TINT_ROLES = ["skin", "hair", "primary", "secondary", "accent", "rarity", "cape"] as const;
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
});
export type ClipDef = z.infer<typeof clipSchema>;

export const layerSchema = z.strictObject({
  /** Key into manifest.images. */
  image: z.string().min(1),
  /** Top-left of this layer's block inside that image, in pixels. */
  x: int(0, 65536),
  y: int(0, 65536),
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
  /** Auras: a single row of frames that loops independently of the body clip. */
  loop: z.strictObject({ frames: int(1, 64), fps: z.number().min(1).max(60) }).optional(),
});
export type LayerDef = z.infer<typeof layerSchema>;

const directionSchema = z.union([z.strictObject({ index: int(0, 3) }), z.strictObject({ mirror: z.enum(DIRECTIONS) })]);

export const manifestSchema = z
  .strictObject({
    spec: z.literal(SPRITE_SPEC_VERSION),
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
    frame: z.strictObject({ w: int(8, 512), h: int(8, 512) }),
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
    for (const [name, dir] of Object.entries(m.directions)) {
      if (dir && "mirror" in dir) {
        const target = m.directions[dir.mirror];
        if (!target || "mirror" in target) issue(`direction "${name}" mirrors "${dir.mirror}", which must be an authored direction`, ["directions", name]);
      }
    }
    const authored = Object.values(m.directions).filter((d) => d && "index" in d).map((d) => (d as { index: number }).index);
    if (new Set(authored).size !== authored.length) issue("authored directions must use distinct indexes", ["directions"]);
    if (!m.layers[BODY_LAYER_ID]) issue(`missing required layer "${BODY_LAYER_ID}"`, ["layers", BODY_LAYER_ID]);
    for (const [id, layer] of Object.entries(m.layers)) {
      if (!m.images[layer.image]) issue(`layer "${id}" references unknown image "${layer.image}"`, ["layers", id, "image"]);
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
