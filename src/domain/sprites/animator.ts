import { clipDurationMs } from "./geometry";
import type { AnimState, ClipDef, ClipKey, SpriteManifest } from "./spec";

/**
 * Pure animation logic: "what is this hero doing right now?" → which clip and frame to show.
 * It reads only timestamps the renderer already tracks from the server-authoritative replay, so
 * the browser never invents combat state — it only chooses how to PRESENT it.
 */

export interface AnimInput {
  alive: boolean;
  moving: boolean;
  victory: boolean;
  stunned: boolean;
  /** ms since the last ATTACK / SKILL / HIT event on this unit (Infinity = never). */
  sinceAttackMs: number;
  sinceSkillMs: number;
  sinceHurtMs: number;
  /** ms since elimination; null while alive. */
  sinceKoMs: number | null;
  /** Free-running clock for looping clips, already de-synchronised per hero. */
  loopClockMs: number;
  /** Moving AWAY from the way the hero faces (a ranged hero stepping back from a threat): the run cycle plays backwards — no moonwalking. */
  backpedal?: boolean;
  /** The run cycle's clock when it is driven by the ground covered (stride-locked: a slow step plays as a walk). Default: `loopClockMs`. */
  moveClockMs?: number;
  /** Ground speed (world units / s, smoothed). A set with a `run` clip runs above RUN_SPEED and walks below it. */
  speed?: number;
  /** ms since this hero parried / dodged a blow (the target of a MISS). A set with a `block` clip plays it. */
  sinceBlockMs?: number;
  /** ms since this hero's facing flipped. A set with a `turn` clip plays it (a turn through a front view). */
  sinceTurnMs?: number;
}

/** Above this ground speed (world units / s) a hero with a `run` clip runs (the arena adds hysteresis). */
export const RUN_SPEED = 80;
/** The arena's move clock runs at real time at this ground speed (the walk's authored cadence). */
export const MOVE_CLOCK_SPEED = 62;

export interface Playback {
  state: AnimState;
  clip: ClipKey;
  /** Frame index inside the clip. */
  frame: number;
  /** 0..1 through a one-shot clip (1 once finished); loops report their position in the cycle. */
  progress: number;
}

/**
 * Optional clips degrade gracefully so a minimal sprite set still works:
 * attack_shoot → attack_thrust → attack_slash,  attack_thrust → attack_slash,  victory → idle.
 */
export function resolveClip(m: SpriteManifest, wanted: ClipKey): ClipKey {
  const chain: Record<string, ClipKey[]> = {
    attack_shoot: ["attack_shoot", "attack_thrust", "attack_slash"],
    attack_thrust: ["attack_thrust", "attack_slash"],
    victory: ["victory", "idle"],
    idle2: ["idle2", "idle"],
    run: ["run", "move"],
  };
  for (const k of chain[wanted] ?? [wanted]) if (m.clips[k]) return k;
  return "idle";
}

/** Frame index at `elapsedMs` into a clip. One-shots hold their last frame; loops wrap. */
export function frameAt(clip: ClipDef, elapsedMs: number): number {
  const t = Math.max(0, elapsedMs);
  const f = Math.floor((t / 1000) * clip.fps);
  return clip.loop ? f % clip.frames : Math.min(f, clip.frames - 1);
}

export function oneShotProgress(clip: ClipDef, elapsedMs: number): number {
  return Math.min(1, Math.max(0, elapsedMs / clipDurationMs(clip)));
}

const within = (m: SpriteManifest, key: ClipKey, since: number): boolean => {
  const clip = m.clips[key];
  return !!clip && since >= 0 && since < clipDurationMs(clip);
};

/** True once a clip has shown its impact frame (the blow has landed / the shot has left). A clip without one: never. */
const pastImpact = (m: SpriteManifest, key: ClipKey, since: number): boolean => {
  const clip = m.clips[key];
  return !!clip && clip.impact !== undefined && since >= ((clip.impact + 1) / clip.fps) * 1000;
};

/**
 * Priority: KO  >  VICTORY  >  the most recent of SKILL/ATTACK still playing  >  HIT  >  MOVE  >  IDLE (in the hero's own stance, `idleClip`).
 * HIT sits below attacks so trading blows doesn't constantly interrupt swings; the arena adds a
 * brief damage flash on top regardless of the clip.
 *
 * No sliding feet: once the blow has landed (the clip is past its impact frame) a hero that is MOVING again runs — the follow-through is cut
 * short instead of gliding across the floor in a pose with planted feet. A hit taken on the run shows as the flash and recoil on the run cycle
 * (the HIT clip is for a hero standing its ground).
 */
export function selectPlayback(input: AnimInput, m: SpriteManifest, attackClip: ClipKey, idleClip: ClipKey = "idle"): Playback {
  const make = (state: AnimState, key: ClipKey, elapsed: number, reverse = false): Playback => {
    const clipKey = resolveClip(m, key);
    const clip = m.clips[clipKey] as ClipDef;
    const frame = frameAt(clip, elapsed);
    return {
      state, clip: clipKey, frame: reverse && clip.loop ? clip.frames - 1 - frame : frame,
      progress: clip.loop ? ((elapsed / clipDurationMs(clip)) % 1 + 1) % 1 : oneShotProgress(clip, elapsed),
    };
  };

  if (!input.alive) return make("KO", "ko", input.sinceKoMs ?? 0);
  if (input.victory) return make("VICTORY", "victory", input.loopClockMs);

  const atk = resolveClip(m, attackClip);
  const running = input.moving && !input.stunned;
  const attackLive = within(m, atk, input.sinceAttackMs) && !(running && pastImpact(m, atk, input.sinceAttackMs));
  const skillLive = within(m, "skill", input.sinceSkillMs) && !(running && pastImpact(m, "skill", input.sinceSkillMs));
  if (skillLive && (!attackLive || input.sinceSkillMs <= input.sinceAttackMs)) return make("SKILL", "skill", input.sinceSkillMs);
  if (attackLive) return make("ATTACK", atk, input.sinceAttackMs);
  // a parry / dodge (sets that draw one) reads instead of the hit reaction for a blow that missed
  if (m.clips.block && input.sinceBlockMs !== undefined && within(m, "block", input.sinceBlockMs) && !running && !(input.sinceHurtMs < input.sinceBlockMs)) return make("BLOCK", "block", input.sinceBlockMs);
  if (within(m, "hit", input.sinceHurtMs) && !running) return make("HIT", "hit", input.sinceHurtMs);
  // a facing change passes through a front view (sets that draw one)
  if (m.clips.turn && input.sinceTurnMs !== undefined && within(m, "turn", input.sinceTurnMs) && !input.stunned) return make("TURN", "turn", input.sinceTurnMs);
  if (input.moving && !input.stunned) {
    const run = m.clips.run;
    const clock = input.moveClockMs ?? input.loopClockMs;
    if (run && (input.speed ?? 0) >= RUN_SPEED) return make("MOVE", "run", clock * (MOVE_CLOCK_SPEED / (run.refSpeed ?? MOVE_CLOCK_SPEED)), input.backpedal === true);
    return make("MOVE", "move", clock, input.backpedal === true);
  }
  return make("IDLE", idleClip, input.loopClockMs);
}
