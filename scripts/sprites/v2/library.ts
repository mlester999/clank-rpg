import type { AttackClip, SlotId, TintRole } from "../../../src/domain/sprites/spec";

import { M, T, TIER_RARITY, type Ctx, type Joints, type Pose, type Pt, type Ramp, type RigId, type Tier } from "./kit";

/**
 * HERO RENDERER v2 — the DESIGN LIBRARY's data model.
 *
 * A hero's stored look names catalogue ITEMS (`headgear.helm`, `outfit.medium`, `weapon.sword` …). The set draws every item as a family of
 * DESIGNS (manifest `variants`): each design belongs to one class skeleton (`rigs`) and one equipment TIER (`tiers` = the rarity that wears
 * it), so a Common Warrior wears one of the Common Warrior helms, a Legendary Warrior one of the Legendary ones — rarity decides the quality of
 * the gear, the hero's never-rerolled look decides WHICH design (plan.variantOf, hashed per item: the helm, the armour, the pauldrons and the
 * sword are independent choices).
 *
 * A design is drawn in several MATERIALS — class cloth, the hero's armour metal, real leather and gold, a rarity-coloured plume — and a sprite
 * layer has one tint, so `design()` groups a design's pieces by (depth, tint) into as few layers as it can — all real-colour pieces at a depth
 * share one — the first is the design itself, the rest are its parts.
 */

export type Draw = (g: Ctx, p: Pose, j: Joints) => void;

/** One layer of the library (the shape `buildPackedSet` takes). */
export interface DesignLayer {
  id: string;
  of?: string;
  z: number;
  tint: TintRole | null;
  /** Skeletons this layer is drawn for (default: all six). */
  rigs?: readonly RigId[];
  /** Weapons: the class skeleton a hero holding it is animated with (the default of `builds`). */
  rig?: RigId;
  /** Weapons: the skeletons (archetypes) of its class, one chosen per hero from the never-rerolled look. */
  builds?: readonly RigId[];
  tiers?: Array<(typeof TIER_RARITY)[number]>;
  weight?: number;
  hides?: SlotId[];
  kit?: boolean;
  empty?: boolean;
  attack?: AttackClip;
  muzzle?: (j: Joints) => Pt;
  variants?: string[];
  draw: Draw;
}

/** A material: a tint role (drawn in the grey ramp, coloured per hero) or a real-colour ramp. */
export type Mat = Exclude<TintRole, "skin" | "hair"> | Ramp;

export interface Piece {
  z: number;
  mat: Mat;
  draw: (g: Ctx, p: Pose, j: Joints, r: Ramp) => void;
}

export const piece = (z: number, mat: Mat, draw: Piece["draw"]): Piece => ({ z, mat, draw });

const tintOf = (m: Mat): TintRole | null => (typeof m === "string" ? m : null);
const rampOf = (m: Mat): Ramp => (typeof m === "string" ? T : m);
/** Layers are split by TINT only: every real-colour piece at one depth (steel, gold, leather, a gem) shares a layer. */
const keyOf = (m: Mat): string => (typeof m === "string" ? m : "real");

export interface DesignSpec {
  id: string;
  tier: Tier;
  rigs: readonly RigId[];
  weight?: number;
  hides?: SlotId[];
  attack?: AttackClip;
  muzzle?: (j: Joints) => Pt;
  rig?: RigId;
  pieces: readonly Piece[];
}

/**
 * One design → its layers. Pieces sharing a depth and a material are drawn into one layer, in the order given; the layer holding the FIRST
 * piece is the design's own id (it carries the variant metadata), the others are parts `<id>.<n>` drawn with it.
 */
export function design(d: DesignSpec): DesignLayer[] {
  const groups: Array<{ z: number; mat: Mat; pieces: Piece[] }> = [];
  for (const pc of d.pieces) {
    const g = groups.find((x) => x.z === pc.z && keyOf(x.mat) === keyOf(pc.mat));
    if (g) g.pieces.push(pc);
    else groups.push({ z: pc.z, mat: pc.mat, pieces: [pc] });
  }
  return groups.map((grp, i): DesignLayer => {
    const draw: Draw = (g, p, j) => {
      for (const pc of grp.pieces) {
        g.save();
        pc.draw(g, p, j, rampOf(pc.mat));
        g.restore();
      }
    };
    const base = { z: grp.z, tint: tintOf(grp.mat), rigs: d.rigs, draw };
    if (i > 0) return { id: `${d.id}.${i}`, of: d.id, ...base };
    return {
      id: d.id,
      ...base,
      tiers: [TIER_RARITY[d.tier]],
      ...(d.weight !== undefined ? { weight: d.weight } : {}),
      ...(d.hides ? { hides: d.hides } : {}),
      ...(d.attack ? { attack: d.attack } : {}),
      ...(d.muzzle ? { muzzle: d.muzzle } : {}),
      ...(d.rig ? { rig: d.rig } : {}),
    };
  });
}

/** Ids of the designs (not their parts) in a list of layers. */
export const designIds = (layers: readonly DesignLayer[]): string[] => layers.filter((l) => !l.of).map((l) => l.id);

export { M, T };
