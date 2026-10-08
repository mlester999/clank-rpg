/**
 * Builds the DEV sprite sets into public/sprites/<set-id>/.
 *
 *   pnpm sprites:build                 both sets
 *   pnpm sprites:build -- --set v2     only clank-dev-v2 (hero renderer v2)
 *
 *   clank-dev-v1   the original placeholder set. KEPT AS IT WAS: an admin can still select it, and nothing about it changes.
 *   clank-dev-v2   HERO RENDERER v2 — the same layer ids (a hero's stored look is drawn exactly as chosen), better proportions, class silhouettes,
 *                  anticipation in every action, rarity shown by gear (no rings), a silhouette outline. Same frame and size as v1 (same memory).
 *
 * This is generated stand-in art so the spritesheet engine can be built, tested and demoed; replacing it means shipping a new set that satisfies
 * docs/SPRITES.md (same manifest contract, any frame size) — nothing in the renderer is tied to these pictures.
 */
import { AURAS, LAYERS } from "./sprites/parts";
import { RARITY_LAYERS } from "./sprites/rarityParts";
import { CLIP_ORDER, CLIPS, joints, poseFor } from "./sprites/rig";
import { buildSet, type SetLayer } from "./sprites/buildSet";
import { buildPackedSet, type PackedLayer } from "./sprites/buildPacked";
import { ANCHOR_X, CLIP_ORDER as CLIP_ORDER_V2, CLIPS as CLIPS_V2, FEET_Y, FRAME, joints as joints2, poseFor as poseFor2, RIG_ATTACK, RIG_IDS, type ClipName } from "./sprites/v2/rig";
import { AURAS as AURAS_V2, setLayers } from "./sprites/v2/set";

const arg = (name: string): string | null => (process.argv.includes(`--${name}`) ? (process.argv[process.argv.indexOf(`--${name}`) + 1] ?? null) : null);
const only = arg("set");
/** v2 only: build a subset of the class skeletons (a quick preview while iterating on one class) and/or into another set id. */
const onlyRigs = arg("rigs")?.split(",");
const v2Id = arg("id") ?? "clank-dev-v2";

async function main(): Promise<void> {
  if (!only || only === "v1") {
    await buildSet({
      id: "clank-dev-v1",
      name: "Clank Dev Placeholder Set",
      credits: "Generated procedurally by scripts/build-dev-sprites.ts. DEV PLACEHOLDER — not production art.",
      anchor: { x: 34, y: 58 },
      nominalHeightPx: 46,
      clips: CLIPS,
      clipOrder: CLIP_ORDER,
      poseFor,
      joints: joints as never,
      layers: [...LAYERS, ...RARITY_LAYERS] as unknown as SetLayer[],
      auras: AURAS,
    });
  }
  if (!only || only === "v2") {
    await buildPackedSet<ClipName>({
      id: v2Id,
      name: "Clank Hero Renderer v2",
      credits: "Generated procedurally by scripts/build-dev-sprites.ts (scripts/sprites/v2). Hero renderer v2 — DEV PLACEHOLDER art, not licensed production art.",
      outline: "#0b0a12",
      innerOutline: "#3c3c3c",
      paletteTones: true,
      // 96 × 80: room for a Legendary's crest or wings, a brute's greatsword raised overhead, a warden's longbow and a lunging duelist; the feet
      // stand at (40, 76)
      frame: { w: FRAME.w, h: FRAME.h },
      anchor: { x: ANCHOR_X, y: FEET_Y },
      floor: FEET_Y + 1.5,
      nominalHeightPx: 46,
      clips: CLIPS_V2,
      clipOrder: CLIP_ORDER_V2,
      rigs: RIG_IDS.map((id) => ({ id, attack: RIG_ATTACK[id], poseFor: (c: ClipName, f: number) => poseFor2(c, f, id), joints: (p: never) => joints2(p, id) })),
      layers: setLayers().map((l) => ({ ...l, family: "v2" }) as unknown as PackedLayer),
      auras: AURAS_V2,
      ...(onlyRigs ? { onlyRigs } : {}),
    });
  }
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
