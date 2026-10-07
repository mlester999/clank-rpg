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
}

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

/**
 * Priority: KO  >  VICTORY  >  the most recent of SKILL/ATTACK still playing  >  HIT  >  MOVE  >  IDLE.
 * HIT sits below attacks so trading blows doesn't constantly interrupt swings; the arena adds a
 * brief damage flash on top regardless of the clip.
 */
export function selectPlayback(input: AnimInput, m: SpriteManifest, attackClip: ClipKey): Playback {
  const make = (state: AnimState, key: ClipKey, elapsed: number): Playback => {
    const clipKey = resolveClip(m, key);
    const clip = m.clips[clipKey] as ClipDef;
    return { state, clip: clipKey, frame: frameAt(clip, elapsed), progress: clip.loop ? ((elapsed / clipDurationMs(clip)) % 1 + 1) % 1 : oneShotProgress(clip, elapsed) };
  };

  if (!input.alive) return make("KO", "ko", input.sinceKoMs ?? 0);
  if (input.victory) return make("VICTORY", "victory", input.loopClockMs);

  const atk = resolveClip(m, attackClip);
  const attackLive = within(m, atk, input.sinceAttackMs);
  const skillLive = within(m, "skill", input.sinceSkillMs);
  if (skillLive && (!attackLive || input.sinceSkillMs <= input.sinceAttackMs)) return make("SKILL", "skill", input.sinceSkillMs);
  if (attackLive) return make("ATTACK", atk, input.sinceAttackMs);
  if (within(m, "hit", input.sinceHurtMs)) return make("HIT", "hit", input.sinceHurtMs);
  if (input.moving && !input.stunned) return make("MOVE", "move", input.loopClockMs);
  return make("IDLE", "idle", input.loopClockMs);
}
