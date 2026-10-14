import type { ArchetypeId } from "../anatomy";
import type { Dress } from "../body";
import type { Material } from "../gbuffer";
import type { Genome, Tier } from "../genome";
import type { Build } from "../kit";
import { material, MAT } from "../materials";
import type { HeroPalette } from "../palette";
import type { HoldSpec } from "../rig";
import type { V3 } from "../vec";

import { CLASS_LOADOUTS } from "./classes";
import type { HeadCover } from "./headgear";
import type { WeaponResult } from "./weapons";

/**
 * HERO RENDERER v3 — a hero's LOADOUT: what it wears and holds, chosen per CLASS and TIER (rarity) from design pools by the genome's equipment
 * stream. Rarity picks the POOL (a Legendary wears only Legendary constructions), the hero's look picks the DESIGN, each slot independently.
 */

export type AttackClip = "attack_slash" | "attack_thrust" | "attack_shoot";

export interface Loadout {
  hold: HoldSpec;
  dress: Dress;
  /** Torso garments, belts, pauldrons, capes, quivers … (after the body volumes). */
  garments(b: Build): void;
  /** Headgear; returns what of the face / hair stays visible. Null headgear: the bare head. */
  head(b: Build): HeadCover | null;
  /** Main weapon, second weapon / buckler, shield. Returns where shots leave. */
  weapon(b: Build): WeaponResult | null;
  attack: AttackClip;
  /** How far the main weapon reaches along its axis from the grip (px): up the blade / shaft, and down to the pommel / foot. */
  span: { up: number; down: number };
  /** Short design names (for QA labels). */
  names: string[];
}

export interface LoadoutCtx {
  g: Genome;
  pal: HeroPalette;
  tier: Tier;
  arch: ArchetypeId;
  /** Picks one of `n` designs for a slot (the genome's per-slot stream). */
  pick: (slot: string, n: number) => number;
}

export type ClassLoadout = (c: LoadoutCtx) => Loadout;

export function loadoutOf(g: Genome, pal: HeroPalette): Loadout {
  const c: LoadoutCtx = { g, pal, tier: g.tier, arch: g.arch, pick: (slot, n) => (n <= 1 ? 0 : (g.design[slot] ?? 0) % n) };
  return CLASS_LOADOUTS[g.cls](c);
}

/** A base dress (skin everywhere) to start a design from. */
export function baseDress(pal: HeroPalette): Dress {
  return {
    thigh: pal.skin, shin: pal.skin, foot: MAT.darkLeather, boot: null, pelvis: pal.skin, waist: pal.skin, chest: pal.skin,
    upperArm: pal.skin, forearm: pal.skin, glove: null, hand: pal.skin, neck: pal.skin,
  };
}

/** Darker trousers in the hero's second cloth colour or leather. */
export const trousers = (pal: HeroPalette, k: number): Material => [pal.accent, MAT.darkLeather, material("#4a4038", "cloth"), pal.cloth][k % 4] as Material;

export type { HeadCover, V3 };
