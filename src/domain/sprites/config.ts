import { z } from "zod";

import { HAIR_COLORS, HAIR_STYLE_COUNT, EYE_STYLE_COUNT, MOUTH_STYLE_COUNT, SKIN_TONES, ACCESSORIES, type AppearanceParts, type Rarity } from "../character/appearance";
import { darken, lighten, RARITY_COLOR, shiftHue } from "../util/color";

import { CATALOG_VERSION, getCosmetic, isUsable, type ClassLook } from "./catalog";
import { lookKey, stableHash } from "./hash";
import { SLOT_IDS, type SlotId, type TintRole } from "./spec";

/**
 * A hero's visual configuration: which catalogue item sits in every slot, plus the colour
 * choices that parameterise tinted layers. It is a pure function of the persisted appearance
 * parts + the class look (`deriveSpriteConfig`), is STORED when a hero is created (so a later
 * catalogue update can never change how an existing hero looks), and is the base that
 * player-chosen cosmetic overrides are layered on top of.
 */
export interface SpriteConfig {
  v: 1;
  /** Catalogue version this config was generated against (diagnostic only). */
  catalog: number;
  /** Index into SKIN_TONES. */
  skin: number;
  /** Index into HAIR_COLORS. */
  hairColor: number;
  /** Hue shift (degrees) applied to the class outfit colours — per-hero variety that keeps the class recognisable. */
  hue: number;
  /** slot → catalogue item id. A missing slot is empty. */
  slots: Partial<Record<SlotId, string>>;
}

export type CosmeticOverrides = Partial<Record<SlotId, string | null>>;

export const spriteConfigSchema = z.strictObject({
  v: z.literal(1),
  catalog: z.number().int().min(1).max(10_000),
  skin: z.number().int().min(0).max(63),
  hairColor: z.number().int().min(0).max(63),
  hue: z.number().int().min(-180).max(180),
  slots: z.partialRecord(z.enum(SLOT_IDS), z.string().min(3).max(60)),
});

/** Slots that must never be empty (class identity depends on them). */
const REQUIRED_SLOTS: readonly SlotId[] = ["outfit", "weapon"];

const idx = (n: unknown, len: number): number => (Number.isFinite(n) ? ((Math.trunc(n as number) % len) + len) % len : 0);

const FALLBACK_LOOK: ClassLook = { weapon: "sword", headgear: "cap", body: "medium", colors: ["#5d6b7a", "#c4cddb", "#2c343d"] };

/** What a class wears by default (also the fallback when an item is disabled or unknown). */
export function classDefaults(look: ClassLook): Partial<Record<SlotId, string>> {
  const out: Partial<Record<SlotId, string>> = {
    outfit: `outfit.${look.body}`,
    weapon: `weapon.${look.weapon}`,
    headgear: `headgear.${look.headgear}`,
  };
  if (look.body === "heavy") out.offhand = "offhand.shield";
  return out;
}

/**
 * Deterministic appearance → sprite layers. No randomness lives here: variety was already
 * rolled (and persisted) as `AppearanceParts`; this only maps those indices onto catalogue items.
 *
 * With a `rarity` (hero generator 2) the rolled rarity enhancements (`parts.fx`) are mapped, class-aware, onto the trim / shoulder /
 * crest / weapon-fx items of that rarity's tier: the Ranger's bow gets the bow ornament, the Mage's robe the mantle, and so on.
 */
export function deriveSpriteConfig(parts: AppearanceParts, look: ClassLook | undefined, rarity?: Rarity): SpriteConfig {
  const l = look ?? FALLBACK_LOOK;
  const hairStyle = idx(parts.hairStyle, HAIR_STYLE_COUNT);
  const slots: Partial<Record<SlotId, string>> = {
    ...classDefaults(l),
    eyes: `eyes.${idx(parts.eyes, EYE_STYLE_COUNT)}`,
    mouth: `mouth.${idx(parts.mouth, MOUTH_STYLE_COUNT)}`,
  };
  if (hairStyle < HAIR_STYLE_COUNT - 1) slots.hair = `hair.${hairStyle}`; // the last style is bald
  const acc = ACCESSORIES[idx(parts.accessory, ACCESSORIES.length)];
  if (acc && acc !== "none") slots.accessory = `accessory.${acc}`;
  if (parts.cape) slots.cape = "cape.default";
  if (parts.aura && parts.aura !== "none") slots.aura = `aura.${parts.aura}`;
  if (parts.fx && rarity && rarity !== "COMMON") {
    const tier = rarity.toLowerCase();
    if (parts.fx.trim) slots.trim = `trim.${tier}.${l.body}`;
    if (parts.fx.shoulder) slots.shoulder = `shoulder.${tier}.${l.body}`;
    if (parts.fx.crest) slots.crest = `crest.${tier}.${l.headgear}`;
    if (parts.fx.weapon) slots.weaponfx = `weaponfx.${tier}.${l.weapon}`;
  }
  const cfg: SpriteConfig = {
    v: 1,
    catalog: CATALOG_VERSION,
    skin: idx(parts.skin, SKIN_TONES.length),
    hairColor: idx(parts.hairColor, HAIR_COLORS.length),
    hue: idx(parts.outfitHue, 61) - 30,
    slots,
  };
  return sanitizeSpriteConfig(cfg, l) ?? cfg;
}

interface Opts {
  disabled?: ReadonlySet<string> | readonly string[];
}

/**
 * Validates a config against the catalogue for THIS class: unknown, disabled, admin-disabled or
 * class-incompatible items are dropped (required slots fall back to the class default).
 * Returns null when the input is not a config at all.
 */
export function sanitizeSpriteConfig(raw: unknown, look: ClassLook | undefined, opts: Opts = {}): SpriteConfig | null {
  const parsed = spriteConfigSchema.safeParse(raw);
  if (!parsed.success) return null;
  const l = look ?? FALLBACK_LOOK;
  const defaults = classDefaults(l);
  const slots: Partial<Record<SlotId, string>> = {};
  for (const slot of SLOT_IDS) {
    const id = parsed.data.slots[slot];
    if (id && getCosmetic(id)?.slot === slot && isUsable(id, l, opts)) slots[slot] = id;
    else if (REQUIRED_SLOTS.includes(slot) && defaults[slot] && isUsable(defaults[slot]!, l, opts)) slots[slot] = defaults[slot];
  }
  return { ...parsed.data, slots };
}

/**
 * Applies player-chosen cosmetics on top of the generated look. Every override is validated:
 * unknown / disabled / class-incompatible items are ignored, `null` clears an optional slot, and
 * required slots (outfit, weapon) can be swapped but never emptied. The generated config is
 * never mutated — clearing every override restores the original look.
 */
export function applyOverrides(base: SpriteConfig, overrides: CosmeticOverrides | null | undefined, look: ClassLook | undefined, opts: Opts = {}): SpriteConfig {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return base; // junk (e.g. a corrupt column) is ignored, never thrown on
  const l = look ?? FALLBACK_LOOK;
  const slots = { ...base.slots };
  for (const slot of SLOT_IDS) {
    if (!(slot in overrides)) continue;
    const want = overrides[slot];
    if (want === null) {
      if (!REQUIRED_SLOTS.includes(slot)) delete slots[slot];
    } else if (typeof want === "string" && getCosmetic(want)?.slot === slot && isUsable(want, l, opts)) {
      slots[slot] = want;
    }
  }
  return { ...base, slots };
}

/**
 * The single entry point for "what does this hero look like": stored config (or a fresh
 * derivation for legacy rows) → overrides → admin kill-switches. Never throws on bad data.
 */
export function resolveSpriteConfig(input: {
  stored?: unknown;
  parts: AppearanceParts;
  look: ClassLook | undefined;
  overrides?: CosmeticOverrides | null;
  disabled?: ReadonlySet<string> | readonly string[];
  /** The hero's rarity: with it, a derived look carries the rarity layers a generator-2 hero was rolled (a hero with no `parts.fx` is unaffected). */
  rarity?: Rarity;
}): SpriteConfig {
  const opts: Opts = input.disabled ? { disabled: input.disabled } : {};
  const derived = (): SpriteConfig => deriveSpriteConfig(input.parts, input.look, input.rarity);
  const base = sanitizeSpriteConfig(input.stored, input.look, opts) ?? sanitizeSpriteConfig(derived(), input.look, opts) ?? derived();
  return sanitizeSpriteConfig(applyOverrides(base, input.overrides, input.look, opts), input.look, opts) ?? base;
}

// ---------------------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------------------

export type HeroPalette = Record<TintRole, string>;

/**
 * Armour metals for layers tinted `metal` (hero renderer v2): steel, iron, bronze, blackened iron, silver. Each hero wears ONE, picked from its
 * never-rerolled look (skin, hair colour, hue) — so a squad of Warriors is not one suit of armour in different shirts. Sets without `metal`
 * layers (v1) are unaffected.
 */
export const METAL_TONES = ["#a9b2c0", "#80868f", "#b5844d", "#585e6a", "#cbd0da"] as const;
/** A second cloth colour (`cloth`): ivory, charcoal, leather, slate, oxblood, forest, ochre — tabards, cloaks, sashes, plumes. */
export const CLOTH_TONES = ["#e4ddca", "#3a3843", "#7a5536", "#5b6c82", "#7b3131", "#3f6249", "#be9645"] as const;

/**
 * Class-colour TONES (sets that declare `paletteTones`, hero renderer v2): each hero wears its class colours one of five shades deeper or paler,
 * picked from the never-rerolled look — a squad of Warriors is crimson, brick, red, coral and rose, all still unmistakably the Warrior red.
 * Negative = mixed toward black, positive = toward white.
 */
export const PALETTE_TONES = [-0.26, -0.13, 0, 0.12, 0.22] as const;

const toned = (hex: string, t: number): string => (t < 0 ? darken(hex, -t) : t > 0 ? lighten(hex, t) : hex);

/** Resolves every tint role for one hero. Colours derive from the class (so a class re-tune propagates) plus the hero's own picks. */
export function resolvePalette(config: SpriteConfig, colors: readonly [string, string, string], rarity: string, opts: { tones?: boolean } = {}): HeroPalette {
  const rarityColor = RARITY_COLOR[rarity] ?? (RARITY_COLOR.COMMON as string);
  const tone = opts.tones ? (PALETTE_TONES[stableHash(`tone|${lookKey(config)}`) % PALETTE_TONES.length] as number) : 0;
  return {
    skin: SKIN_TONES[config.skin % SKIN_TONES.length] as string,
    hair: HAIR_COLORS[config.hairColor % HAIR_COLORS.length] as string,
    primary: toned(shiftHue(colors[0], config.hue), tone),
    secondary: shiftHue(colors[1], config.hue),
    accent: toned(shiftHue(colors[2], config.hue), tone * 0.5),
    rarity: rarityColor,
    cape: darken(rarityColor, 0.35),
    metal: METAL_TONES[stableHash(`metal|${lookKey(config)}`) % METAL_TONES.length] as string,
    cloth: CLOTH_TONES[stableHash(`cloth|${lookKey(config)}`) % CLOTH_TONES.length] as string,
  };
}

/** Stable cache key: identical visual inputs ⇒ identical key. */
export function spriteKey(config: SpriteConfig, colors: readonly [string, string, string], rarity: string): string {
  const slots = SLOT_IDS.map((s) => config.slots[s] ?? "").join("|");
  return `${slots}#${config.skin}.${config.hairColor}.${config.hue}#${colors.join(",")}#${rarity}`;
}
