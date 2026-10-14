import { HAIR_COLORS, SKIN_TONES } from "../../character/appearance";
import { CLOTH_TONES, METAL_TONES, PALETTE_TONES, type SpriteConfig } from "../config";
import { lookKey, stableHash } from "../hash";

import { ARCHETYPE_CLASS, BODY_PLANS, CLASS_ARCHETYPES, type ArchetypeId, type BodyPlan, type ClassRig } from "./anatomy";

/**
 * HERO RENDERER v3 — the GENOME: everything the renderer needs to know about one hero, derived (never stored, never re-rolled) from the hero's
 * persisted look — its SpriteConfig (catalogue item per slot, skin, hair colour, hue), its class colours and its rarity.
 *
 * Independent RANDOMNESS STREAMS: each domain hashes the never-overridable part of the look (skin · hair colour · hue — `lookKey`) with its own
 * prefix, so a choice in one domain can never move another. Changing a hero's helm (a cosmetic override of the headgear slot) cannot change
 * its face, body, hair, weapon design or the way it moves:
 *
 *   body       `build|<weapon item>|…`   — the archetype (IDENTICAL to renderer v2's pick, so every hero keeps its build)
 *   face       `v3:face|…`               — head shape, brow weight, facial hair
 *   equip      `v3:eq|<slot>|…`          — one design per equipment slot, from the pool of the hero's tier (rarity) and class
 *   palette    `tone|…` · `metal|…` · `cloth|…` — IDENTICAL to v2 (the same class-colour shade, armour metal and second cloth colour)
 *   anim       `v3:anim|…`               — tempo and stance (the stance pick is v2's `stance|…`)
 *
 * Stored identity traits (eye style, mouth, hair style and colour, skin, accessory, cape, aura, hue) are read straight from the config.
 */

export type Tier = 0 | 1 | 2 | 3;
export const TIER_OF: Record<string, Tier> = { COMMON: 0, RARE: 1, EPIC: 2, LEGENDARY: 3 };

export type HeadShapeId = "round" | "square" | "long" | "broad" | "sharp";
export type Beard = "none" | "stubble" | "short" | "full" | "goatee" | "moustache" | "long";
export type Headgear = "helm" | "hat" | "hood" | "cap" | "halo" | "crown" | null;
export type Body = "medium" | "heavy" | "light" | "robe";
export type Weapon = "sword" | "mace" | "daggers" | "bow" | "staff" | "tome";

export interface Genome {
  key: string;
  cls: ClassRig;
  arch: ArchetypeId;
  plan: BodyPlan;
  rarity: string;
  tier: Tier;
  // identity
  skin: string;
  hairColor: string;
  hairStyle: number | null; // null = bald
  eyes: number;
  mouth: number;
  accessory: string | null;
  cape: boolean;
  aura: string | null;
  // face stream
  headShape: HeadShapeId;
  beard: Beard;
  browWeight: number;
  // equipment
  body: Body;
  weapon: Weapon;
  headgear: Headgear;
  shield: boolean;
  /** Per-slot design index (each gear builder maps it into its own pool for this class and tier). */
  design: Record<string, number>;
  // palette
  colors: { primary: string; secondary: string; accent: string; metal: string; cloth: string; rarity: string };
  tone: number;
  // animation stream
  stance: 0 | 1;
  tempo: number;
}

/** A hash in [0, n) from one stream. */
export const pick = (stream: string, key: string, n: number): number => (n <= 1 ? 0 : stableHash(`${stream}|${key}`) % n);
/** A hash in [0, 1). */
export const unit = (stream: string, key: string): number => stableHash(`${stream}|${key}`) / 4294967296;

const WEAPON_CLASS: Record<Weapon, ClassRig> = { sword: "warrior", mace: "tank", daggers: "rogue", bow: "ranger", staff: "mage", tome: "cleric" };
const BODIES: readonly Body[] = ["medium", "heavy", "light", "robe"];
const WEAPONS: readonly Weapon[] = ["sword", "mace", "daggers", "bow", "staff", "tome"];

const itemTail = (id: string | undefined, prefix: string): string | null => (id && id.startsWith(`${prefix}.`) ? (id.slice(prefix.length + 1).split(".")[0] ?? null) : null);

export interface GenomeInput {
  config: SpriteConfig;
  colors: readonly [string, string, string];
  rarity: string;
}

/** Facial hair, weighted per class (heavy fighters bearded more often, casters with long beards, rogues mostly clean). */
const BEARDS: Record<ClassRig, Array<[Beard, number]>> = {
  warrior: [["none", 5], ["stubble", 3], ["short", 3], ["full", 2], ["moustache", 1], ["goatee", 1]],
  tank: [["none", 4], ["stubble", 2], ["short", 2], ["full", 4], ["moustache", 1]],
  rogue: [["none", 9], ["stubble", 3], ["goatee", 2]],
  ranger: [["none", 7], ["stubble", 3], ["short", 2], ["goatee", 1]],
  mage: [["none", 6], ["goatee", 2], ["long", 3], ["moustache", 1]],
  cleric: [["none", 7], ["short", 2], ["full", 1], ["long", 1]],
};

function weighted<T>(list: Array<[T, number]>, h: number): T {
  const total = list.reduce((n, [, w]) => n + w, 0);
  let k = h % total;
  for (const [v, w] of list) {
    k -= w;
    if (k < 0) return v;
  }
  return (list[list.length - 1] as [T, number])[0];
}

export function genomeOf(input: GenomeInput): Genome {
  const c = input.config;
  const lk = lookKey(c);
  const weapon = (itemTail(c.slots.weapon, "weapon") as Weapon | null) ?? "sword";
  const w: Weapon = WEAPONS.includes(weapon) ? weapon : "sword";
  const body0 = itemTail(c.slots.outfit, "outfit") as Body | null;
  const cls = WEAPON_CLASS[w];
  // renderer v2's archetype pick, verbatim: builds[stableHash("build|<weapon item>|" + lookKey) % builds.length]
  const archs = CLASS_ARCHETYPES[cls];
  const arch = archs[stableHash(`build|${c.slots.weapon ?? `weapon.${w}`}|${lk}`) % archs.length] as ArchetypeId;
  const headgearTail = itemTail(c.slots.headgear, "headgear") as Headgear;
  const hair = itemTail(c.slots.hair, "hair");
  const tier = TIER_OF[input.rarity] ?? 0;
  const tone = PALETTE_TONES[stableHash(`tone|${lk}`) % PALETTE_TONES.length] as number;
  const design: Record<string, number> = {};
  for (const slot of ["helm", "armor", "arms", "legs", "shoulders", "belt", "weapon", "offhand", "cape", "gear", "boots", "hat", "trim"]) design[slot] = stableHash(`v3:eq|${slot}|${lk}`);
  const rarityColor: Record<string, string> = { COMMON: "#9aa4b2", RARE: "#4aa8ff", EPIC: "#b366ff", LEGENDARY: "#ffb020" };
  return {
    key: lk,
    cls,
    arch,
    plan: BODY_PLANS[arch],
    rarity: input.rarity,
    tier,
    skin: SKIN_TONES[c.skin % SKIN_TONES.length] as string,
    hairColor: HAIR_COLORS[c.hairColor % HAIR_COLORS.length] as string,
    hairStyle: hair === null ? null : Number(hair),
    eyes: Number(itemTail(c.slots.eyes, "eyes") ?? 0) || 0,
    mouth: Number(itemTail(c.slots.mouth, "mouth") ?? 0) || 0,
    accessory: itemTail(c.slots.accessory, "accessory"),
    cape: Boolean(c.slots.cape),
    aura: itemTail(c.slots.aura, "aura"),
    headShape: (["round", "square", "long", "broad", "sharp"] as const)[pick("v3:face|shape", lk, 5)] as HeadShapeId,
    beard: weighted(BEARDS[cls], stableHash(`v3:face|beard|${lk}`)),
    browWeight: unit("v3:face|brow", lk),
    body: body0 && BODIES.includes(body0) ? body0 : cls === "tank" ? "heavy" : cls === "mage" || cls === "cleric" ? "robe" : cls === "warrior" ? "medium" : "light",
    weapon: w,
    headgear: headgearTail,
    shield: c.slots.offhand === "offhand.shield",
    design,
    colors: { primary: input.colors[0], secondary: input.colors[1], accent: input.colors[2], metal: METAL_TONES[stableHash(`metal|${lk}`) % METAL_TONES.length] as string, cloth: CLOTH_TONES[stableHash(`cloth|${lk}`) % CLOTH_TONES.length] as string, rarity: rarityColor[input.rarity] ?? "#9aa4b2" },
    tone,
    stance: (stableHash(`stance|${lk}`) % 2) as 0 | 1,
    tempo: 0.94 + unit("v3:anim|tempo", lk) * 0.12,
  };
}

/** The archetype's class (for code that only has the archetype id). */
export const classOf = (a: ArchetypeId): ClassRig => ARCHETYPE_CLASS[a];
