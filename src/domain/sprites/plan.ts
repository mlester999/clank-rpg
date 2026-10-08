import type { Rarity } from "../character/appearance";

import { getCosmetic } from "./catalog";
import type { SpriteConfig } from "./config";
import { drawsOn } from "./geometry";
import { lookKey, stableHash } from "./hash";
import { ATTACK_CLIPS, BODY_LAYER_ID, SLOT_IDS, type AttackClip, type ClipKey, type LayerDef, type SlotId, type SpriteManifest, type TintRole } from "./spec";

export interface PlannedLayer {
  id: string;
  slot: SlotId | "body";
  def: LayerDef;
  tint: TintRole | null;
}

export interface SpritePlan {
  /** Frame-synchronised layers, back to front (low z first; a cape sits behind the body). */
  layers: PlannedLayer[];
  /** A layer that loops on its own clock (auras), drawn under the hero. */
  aura: PlannedLayer | null;
  /** Layer ids the config asks for that this sprite set does not have. */
  missing: string[];
  /**
   * True when the set cannot draw this hero credibly (no body, or the class outfit is absent).
   * The renderer then uses the procedural vector hero instead — a hero is never invisible.
   */
  fallback: boolean;
  /** Which attack clip this hero plays (driven by the weapon). */
  attackClip: AttackClip;
  /** Where this hero's shots leave on the attack's impact frame (frame pixels, authored direction), when the weapon declares it. */
  muzzle: { x: number; y: number } | null;
  /** The skeleton this hero is drawn on (packed sets), null for a set without rigs. */
  rig: string | null;
  /** The hero's STANCE: `idle`, or `idle2` when the set draws a second stance for this skeleton (chosen from the never-rerolled look). */
  idleClip: ClipKey;
}

/**
 * Which of the set's two stances a hero stands in (`idle` / `idle2`): half the heroes of a class stand one way, half the other — a pure
 * function of the stored look (like every design choice), so a hero never changes stance. A set without `idle2` (or without it for this
 * skeleton) always uses `idle`.
 */
export function idleClipOf(config: SpriteConfig, manifest: SpriteManifest, rig: string | null): ClipKey {
  const alt = manifest.clips.idle2;
  if (!alt) return "idle";
  const body = manifest.layers[BODY_LAYER_ID];
  if (body?.cells && (!rig || !body.cells[rig]?.[alt.row])) return "idle";
  return stableHash(`stance|${lookKey(config)}`) % 2 === 0 ? "idle" : "idle2";
}

export { stableHash } from "./hash";

const PARTS = new WeakMap<SpriteManifest, Map<string, string[]>>();
/** owner id → its parts, in manifest order (built once per manifest: a design library has hundreds of layers). */
function partsIndex(m: SpriteManifest): Map<string, string[]> {
  let idx = PARTS.get(m);
  if (idx) return idx;
  idx = new Map();
  for (const [id, d] of Object.entries(m.layers)) if (d.of) idx.set(d.of, [...(idx.get(d.of) ?? []), id]);
  PARTS.set(m, idx);
  return idx;
}

/**
 * The skeleton a hero is animated with: one of its weapon's ARCHETYPES (`builds` — a brute, a duelist … each its own build, stance and grip),
 * chosen from the never-rerolled look like every design choice; else the weapon's class rig; else the set's default; null for a set without
 * rigs. A hero keeps its archetype forever (the hash is pinned and keyed on skin, hair colour and hue only).
 */
export function rigOf(config: SpriteConfig, manifest: SpriteManifest): string | null {
  const rigs = manifest.rigs;
  if (!rigs || rigs.length === 0) return null;
  const weaponId = config.slots.weapon;
  const weapon = weaponId ? manifest.layers[weaponId] : undefined;
  const builds = weapon?.builds?.filter((r) => rigs.includes(r)) ?? [];
  if (builds.length > 0) return builds[stableHash(`build|${weaponId}|${lookKey(config)}`) % builds.length] as string;
  return weapon?.rig && rigs.includes(weapon.rig) ? weapon.rig : (rigs[0] as string);
}

export interface VariantOptions {
  /** The hero's rarity: a drawing with `tiers` is only worn at those rarities (default COMMON). */
  rarity?: Rarity | string;
  /** The hero's skeleton (default: rigOf). A packed drawing is only worn on a skeleton it is drawn for. */
  rig?: string | null;
}

/**
 * Which drawing of item `id` this hero wears when the set offers variants: a deterministic function of the parts of the stored look that can
 * never be overridden or re-rolled (skin, hair colour, hue) — so two Warriors carry different swords and helms, and every hero keeps the same
 * one forever. The pool is the item and its variants that this hero's skeleton and rarity tier may wear, weighted by `weight` (a rarity no
 * drawing is made for — junk data — wears one of the skeleton's drawings rather than nothing). Without variants: the item itself.
 */
export function variantOf(config: SpriteConfig, id: string, manifest: SpriteManifest, opts: VariantOptions = {}): string {
  const variants = manifest.layers[id]?.variants;
  if (!variants || variants.length === 0) return id;
  const rig = opts.rig === undefined ? rigOf(config, manifest) : opts.rig;
  const rarity = opts.rarity ?? "COMMON";
  const onRig = [id, ...variants].filter((v) => {
    const d = manifest.layers[v];
    return !!d && drawsOn(d, rig);
  });
  const tiered = onRig.filter((v) => {
    const t = manifest.layers[v]?.tiers as string[] | undefined;
    return !t || t.includes(rarity);
  });
  const pool = tiered.length > 0 ? tiered : onRig;
  if (pool.length === 0) return id;
  const weightOf = (v: string): number => manifest.layers[v]?.weight ?? 1;
  let k = stableHash(`${id}|${lookKey(config)}`) % pool.reduce((n, v) => n + weightOf(v), 0);
  for (const v of pool) {
    k -= weightOf(v);
    if (k < 0) return v;
  }
  return pool[pool.length - 1] as string;
}

/**
 * The atlas images a plan draws from — on its own skeleton only (a packed set keeps one page per skeleton) — plus its aura's. A lazily loaded
 * set must have exactly these before the hero is composed; nothing else of the set is needed to draw it.
 */
export function planImages(plan: SpritePlan): string[] {
  const out = new Set<string>();
  for (const l of plan.layers) {
    if (l.def.cells) {
      for (const r of (plan.rig ? l.def.cells[plan.rig] : undefined) ?? []) if (r) out.add(r[0]);
    } else if (l.def.image !== undefined) out.add(l.def.image);
  }
  const aura = plan.aura as PlannedLayer | null;
  if (aura?.def.image !== undefined) out.add(aura.def.image);
  return [...out].sort();
}

/**
 * Pure: config + manifest (+ the hero's rarity) → what to composite. Missing optional layers (hair, accessory, aura…) are skipped and reported;
 * a missing body or outfit demands the fallback renderer.
 */
export function planLayers(config: SpriteConfig, manifest: SpriteManifest, rarity: Rarity | string = "COMMON"): SpritePlan {
  const layers: PlannedLayer[] = [];
  const missing: string[] = [];
  let aura: PlannedLayer | null = null;
  let fallback = false;
  const rig = rigOf(config, manifest);
  const opts: VariantOptions = { rarity, rig };

  const partsOf = (ownerId: string): readonly string[] => partsIndex(manifest).get(ownerId) ?? [];
  const drawable = (id: string): boolean => {
    const d = manifest.layers[id];
    return !!d && drawsOn(d, rig);
  };
  /** An item can be worn when the drawing this hero would wear can be drawn on its skeleton (a set may draw a class's designs only there). */
  const wearable = (item: string): boolean => !!manifest.layers[item] && drawable(variantOf(config, item, manifest, opts));
  const plan = (slot: SlotId | "body", id: string, def: LayerDef): PlannedLayer => ({ id, slot, def, tint: def.tint ?? null });
  /**
   * The drawing of `item` this hero wears, its own parts, and the item's kit parts — each part resolved through its own variants, and a part's
   * chosen drawing bringing ITS parts (a pauldron design's far twin, a helm design's plume).
   */
  const wear = (slot: SlotId | "body", item: string): void => {
    const chosen = variantOf(config, item, manifest, opts);
    const def = manifest.layers[chosen] as LayerDef;
    if (def.loop) {
      aura = plan(slot, chosen, def);
      return;
    }
    layers.push(plan(slot, chosen, def));
    // the item's own parts (a quiver, a class kit) go with every variant of it; a variant may add parts of its own
    const owners = chosen === item ? [item] : [item, chosen];
    for (const owner of owners) {
      for (const pid of partsOf(owner)) {
        const pdef = manifest.layers[pid] as LayerDef;
        if (owner === item && chosen !== item && pdef.kit === false) continue;
        const pv = variantOf(config, pid, manifest, opts);
        if (!drawable(pv)) continue;
        layers.push(plan(slot, pv, manifest.layers[pv] as LayerDef));
        if (pv !== pid) for (const qid of partsOf(pv)) if (drawable(qid)) layers.push(plan(slot, qid, manifest.layers[qid] as LayerDef));
      }
    }
  };

  if (wearable(BODY_LAYER_ID)) wear("body", BODY_LAYER_ID);
  else {
    missing.push(BODY_LAYER_ID);
    fallback = true;
  }

  // Slots covered by something the hero wears (a full helm hides the hair; an open drawing of it may declare that it hides less).
  const hidden = new Set<SlotId>();
  for (const slot of SLOT_IDS) {
    const id = config.slots[slot];
    if (!id) continue;
    const chosen = manifest.layers[id] ? manifest.layers[variantOf(config, id, manifest, opts)] : undefined;
    const hides = (chosen?.hides as SlotId[] | undefined) ?? getCosmetic(id)?.hides ?? [];
    for (const h of hides) hidden.add(h);
  }

  for (const slot of SLOT_IDS) {
    const item = config.slots[slot];
    if (!item || hidden.has(slot)) continue;
    if (!wearable(item)) {
      missing.push(item);
      if (slot === "outfit") fallback = true;
      continue;
    }
    wear(slot, item);
  }

  layers.sort((a, b) => a.def.z - b.def.z);

  const weapon = config.slots.weapon && wearable(config.slots.weapon) ? manifest.layers[variantOf(config, config.slots.weapon, manifest, opts)] : undefined;
  const attackClip: AttackClip = weapon?.attack && manifest.clips[weapon.attack] ? weapon.attack : (ATTACK_CLIPS.find((c) => manifest.clips[c]) ?? "attack_slash");
  const muzzle = weapon?.attack === attackClip ? ((rig ? weapon.muzzles?.[rig] : undefined) ?? weapon.muzzle ?? null) : null;
  return { layers, aura, missing, fallback, attackClip, muzzle, rig, idleClip: idleClipOf(config, manifest, rig) };
}
