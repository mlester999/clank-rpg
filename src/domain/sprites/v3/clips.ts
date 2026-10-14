import type { ArchetypeId, BodyPlan } from "./anatomy";
import { gait, type ClipPlan, type GaitOpts, type Key } from "./anim";
import type { Genome } from "./genome";
import { REST_POSE, type HandTarget, type Pose } from "./rig";
import type { V3 } from "./vec";

/**
 * HERO RENDERER v3 — the CLIP TABLE (shared timing) and the helpers archetype pose libraries are written with.
 *
 * Timing is shared by every class (combat timing never depends on the class): the arena starts an attack / cast clip `(impact + 0.4) / fps`
 * before the server's event so the impact frame is on screen at the hit (≈ 190 ms for melee, ≈ 275 ms for shots and casts — the same leads
 * renderer v2 used, with more frames for smoother motion). Locomotion clips declare their STRIDE; their fps is derived so that the arena's
 * stride-locked clock (≈ 62 world units / s = the authored cadence) covers exactly one stride per cycle.
 */

export type ClipKey3 = "idle" | "idle2" | "move" | "run" | "attack_slash" | "attack_thrust" | "attack_shoot" | "skill" | "hit" | "block" | "ko" | "victory" | "turn";

/** World units per sprite pixel on the stage (84-unit-tall heroes, 46-px nominal height). */
export const WORLD_PER_PX = 84 / 46;
/** The arena's stride-locked cadence: the move clock runs at real time when a hero covers 62 world units per second. */
export const REF_SPEED = 62;

export const WALK_STRIDE = 22;
export const RUN_STRIDE = 32;
/**
 * The camera's uniform zoom (render.ts): body units → sprite pixels. A hero stands ≈ 46 px tall in its stance (the nominal height the arena
 * scales to), every proportion unchanged. Strides are in body units; the sprite moves `stride × zoom` pixels per cycle.
 */
export const VIEW_ZOOM = 1.12;

const cadence = (frames: number, stride: number, refSpeed: number): number => (frames * refSpeed) / (stride * VIEW_ZOOM * WORLD_PER_PX);

export interface ClipTiming {
  frames: number;
  fps: number;
  loop: boolean;
  impact?: number;
  stride?: number;
  /** Run clip: the speed (world units / s) at which its cycle plays at its own fps. */
  refSpeed?: number;
}

export const TIMING: Record<ClipKey3, ClipTiming> = {
  idle: { frames: 8, fps: 6, loop: true },
  idle2: { frames: 8, fps: 6, loop: true },
  move: { frames: 8, fps: cadence(8, WALK_STRIDE, REF_SPEED), loop: true, stride: WALK_STRIDE * VIEW_ZOOM },
  run: { frames: 8, fps: cadence(8, RUN_STRIDE, 96), loop: true, stride: RUN_STRIDE * VIEW_ZOOM, refSpeed: 96 },
  attack_slash: { frames: 9, fps: 18, loop: false, impact: 3 },
  attack_thrust: { frames: 9, fps: 18, loop: false, impact: 3 },
  attack_shoot: { frames: 9, fps: 16, loop: false, impact: 4 },
  skill: { frames: 10, fps: 16, loop: false, impact: 4 },
  hit: { frames: 4, fps: 16, loop: false },
  block: { frames: 5, fps: 18, loop: false },
  ko: { frames: 10, fps: 12, loop: false },
  victory: { frames: 8, fps: 8, loop: true },
  turn: { frames: 3, fps: 22, loop: false },
};

export const CLIP_ORDER: readonly ClipKey3[] = ["idle", "idle2", "move", "run", "attack_slash", "attack_thrust", "attack_shoot", "skill", "hit", "block", "ko", "victory", "turn"];

/** What an archetype's pose library provides: a key list per clip (locomotion is generated from gait settings + a carry pose). */
export interface PoseLibrary {
  stance: Pose;
  stance2: Pose;
  /** The upper body while walking / running (hands, weapon aim); gait fills legs, hips and lean. */
  carry: (kind: "walk" | "run", swingN: number, swingF: number) => Partial<Pose>;
  walk: Omit<GaitOpts, "kind" | "stride">;
  run: Omit<GaitOpts, "kind" | "stride">;
  attack: Key[];
  skill: Key[];
  hit: Key[];
  block: Key[];
  ko: Key[];
  victory: Key[];
}

export const pose = (o: Partial<Pose>): Pose => ({ ...REST_POSE, ...o });
export const at = (x: number, y: number, z: number, elbow?: V3): HandTarget => (elbow ? { at: [x, y, z], elbow } : { at: [x, y, z] });
export const world = (x: number, y: number, z: number): HandTarget => ({ at: [x, y, z], space: "world" });
export const GRIP: HandTarget = { grip: true };
export const STRING: HandTarget = { string: true };

/**
 * A breathing loop over a stance: the chest swells, the body settles a pixel at the top of the breath and the weapon tip dips and recovers
 * a beat later (overlapping action), the head nods with it. Never the feet: a stance is planted.
 */
export function breathe(base: Pose, o: { weapon?: number; drop?: number } = {}): Key[] {
  const wa = base.weapon.angle;
  const dr = o.drop ?? 0.6;
  const ws = o.weapon ?? 3;
  return [
    { t: 0, breath: 0, drop: base.drop, weapon: { ...base.weapon, angle: wa }, headPitch: base.headPitch },
    { t: 0.35, breath: 1, drop: base.drop + dr * 0.5, weapon: { ...base.weapon, angle: wa + ws * 0.4 }, headPitch: base.headPitch + 1.5, ease: "inOut" },
    { t: 0.6, breath: 0.8, drop: base.drop + dr, weapon: { ...base.weapon, angle: wa + ws }, headPitch: base.headPitch + 2.5, ease: "inOut" },
    { t: 0.85, breath: 0.2, drop: base.drop + dr * 0.4, weapon: { ...base.weapon, angle: wa + ws * 0.5 }, headPitch: base.headPitch + 1, ease: "inOut" },
  ];
}

/** Builds the clip plan for one clip of an archetype. */
export function clipPlan(lib: PoseLibrary, key: ClipKey3, plan: BodyPlan, g: Genome | null): ClipPlan {
  const tm = TIMING[key];
  const base = { frames: tm.frames, fps: tm.fps, loop: tm.loop, ...(tm.impact !== undefined ? { impact: tm.impact } : {}), ...(tm.stride ? { stride: tm.stride } : {}) };
  void plan;
  const tempo = g?.tempo ?? 1;
  switch (key) {
    case "idle":
      return { ...base, fps: base.fps * tempo, keys: breathe(lib.stance) };
    case "idle2":
      return { ...base, fps: base.fps * tempo, keys: breathe(lib.stance2) };
    case "move":
    case "run": {
      const kind = key === "move" ? "walk" : "run";
      const go = { ...(kind === "walk" ? lib.walk : lib.run), kind, stride: (tm.stride as number) / VIEW_ZOOM } as GaitOpts;
      const keys: Key[] = [];
      for (let f = 0; f < tm.frames; f++) {
        const gp = gait(f / tm.frames, go);
        const carry = lib.carry(kind, gp.swingN, gp.swingF);
        keys.push({ t: f / tm.frames, ...carry, footN: gp.footN, footF: gp.footF, drop: gp.drop, lean: gp.lean + (carry.lean ?? 0), hipYaw: gp.hipYaw, twist: gp.twist + (carry.twist ?? 0), sway: gp.sway, ease: "linear" });
      }
      return { ...base, keys };
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      return { ...base, keys: lib.attack };
    case "skill":
      return { ...base, keys: lib.skill };
    case "hit":
      return { ...base, keys: lib.hit };
    case "block":
      return { ...base, keys: lib.block };
    case "ko":
      return { ...base, keys: lib.ko };
    case "victory":
      return { ...base, keys: lib.victory };
    case "turn":
      return { ...base, keys: [{ t: 0 }] };
  }
}

export type { ArchetypeId };
