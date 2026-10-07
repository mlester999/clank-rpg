import { getCosmetic } from "./catalog";
import type { SpriteConfig } from "./config";
import { ATTACK_CLIPS, BODY_LAYER_ID, SLOT_IDS, type AttackClip, type LayerDef, type SlotId, type SpriteManifest, type TintRole } from "./spec";

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
}

/**
 * Pure: config + manifest → what to composite. Missing optional layers (hair, accessory,
 * aura…) are skipped and reported; a missing body or outfit demands the fallback renderer.
 */
export function planLayers(config: SpriteConfig, manifest: SpriteManifest): SpritePlan {
  const layers: PlannedLayer[] = [];
  const missing: string[] = [];
  let aura: PlannedLayer | null = null;
  let fallback = false;

  const partsOf = (ownerId: string): Array<[string, LayerDef]> => Object.entries(manifest.layers).filter(([, d]) => d.of === ownerId);

  const body = manifest.layers[BODY_LAYER_ID];
  if (body) {
    layers.push({ id: BODY_LAYER_ID, slot: "body", def: body, tint: body.tint ?? null });
    for (const [pid, def] of partsOf(BODY_LAYER_ID)) layers.push({ id: pid, slot: "body", def, tint: def.tint ?? null });
  } else {
    missing.push(BODY_LAYER_ID);
    fallback = true;
  }

  // Slots covered by something the hero wears (a full helm hides the hair).
  const hidden = new Set<SlotId>();
  for (const slot of SLOT_IDS) {
    const id = config.slots[slot];
    for (const h of (id ? getCosmetic(id)?.hides : undefined) ?? []) hidden.add(h);
  }

  for (const slot of SLOT_IDS) {
    const id = config.slots[slot];
    if (!id || hidden.has(slot)) continue;
    const def = manifest.layers[id];
    if (!def) {
      missing.push(id);
      if (slot === "outfit") fallback = true;
      continue;
    }
    const planned: PlannedLayer = { id, slot, def, tint: def.tint ?? null };
    if (def.loop) aura = planned;
    else {
      layers.push(planned);
      for (const [pid, pdef] of partsOf(id)) layers.push({ id: pid, slot, def: pdef, tint: pdef.tint ?? null });
    }
  }

  layers.sort((a, b) => a.def.z - b.def.z);

  const weapon = config.slots.weapon ? manifest.layers[config.slots.weapon] : undefined;
  const attackClip: AttackClip = weapon?.attack && manifest.clips[weapon.attack] ? weapon.attack : (ATTACK_CLIPS.find((c) => manifest.clips[c]) ?? "attack_slash");
  return { layers, aura, missing, fallback, attackClip };
}
