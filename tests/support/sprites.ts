import { SLOT_IDS, type SpriteManifest } from "@/domain/sprites/spec";
import { COSMETIC_ITEMS } from "@/domain/sprites/catalog";

/**
 * A minimal but complete synthetic sprite set: every catalogue item has a layer, laid out on the
 * standard grid. Tests use it to exercise the contract without depending on shipped art.
 */
export function makeManifest(over: Partial<SpriteManifest> = {}, drop: string[] = []): SpriteManifest {
  const layers: SpriteManifest["layers"] = { "body.base": { image: "atlas", x: 0, y: 0, z: 10, tint: "skin" } };
  let y = 576 * 1;
  const zFor: Record<string, number> = { cape: 5, outfit: 20, eyes: 30, mouth: 31, hair: 40, accessory: 50, headgear: 60, offhand: 65, weapon: 70, aura: -5 };
  for (const item of COSMETIC_ITEMS) {
    if (drop.includes(item.id)) continue;
    const base = { image: "atlas", x: 0, y, z: zFor[item.slot] ?? 50 };
    layers[item.id] =
      item.slot === "aura" ? { ...base, tint: "rarity", loop: { frames: 8, fps: 10 } }
      : item.slot === "weapon" ? { ...base, tint: null, attack: item.id === "weapon.bow" ? "attack_shoot" : item.id === "weapon.staff" || item.id === "weapon.tome" ? "attack_thrust" : "attack_slash" }
      : { ...base, tint: item.slot === "outfit" ? "primary" : item.slot === "hair" ? "hair" : null };
    y += 576;
  }
  void SLOT_IDS;
  const m: SpriteManifest = {
    spec: 1,
    id: "test-set",
    name: "Test set",
    status: "dev-placeholder",
    frame: { w: 64, h: 64 },
    anchor: { x: 32, y: 58 },
    nominalHeightPx: 50,
    images: { atlas: "atlas.png" },
    clips: {
      idle: { row: 0, frames: 4, fps: 6, loop: true },
      move: { row: 1, frames: 6, fps: 12, loop: true },
      attack_slash: { row: 2, frames: 5, fps: 16, loop: false, impact: 1 },
      attack_thrust: { row: 3, frames: 5, fps: 16, loop: false, impact: 2 },
      attack_shoot: { row: 4, frames: 5, fps: 14, loop: false, impact: 3 },
      skill: { row: 5, frames: 6, fps: 12, loop: false },
      hit: { row: 6, frames: 2, fps: 10, loop: false },
      ko: { row: 7, frames: 4, fps: 7, loop: false },
      victory: { row: 8, frames: 4, fps: 8, loop: true },
    },
    directions: { right: { index: 0 }, left: { mirror: "right" } },
    layers,
    ...over,
  };
  return m;
}
