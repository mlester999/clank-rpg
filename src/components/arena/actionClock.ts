import { EV, FRAME_FLAG } from "@/domain/combat/types";
import type { ClipDef } from "@/domain/sprites/spec";
import type { ReplayDto } from "@/lib/dto";

/**
 * WHEN A BLOW LANDS ON SCREEN — the sprite's impact frame is lined up with the server's event.
 *
 * The replay says WHEN an attack lands / a shot leaves (ATTACK) and when a skill is cast (SKILL — it fires when its cast ends: the replay's frames
 * carry CASTING until then, so the release instant is read from them). A sprite clip reaches its impact frame some
 * time after it starts — the anticipation (wind-up, draw, gather) comes first. Starting the clip AT the event made every blow land on screen
 * 150–280 ms after its damage number. Here the clip starts `leadMs` BEFORE the event, so the impact frame is on screen when the event happens.
 *
 * Pure presentation of server data: every time comes from the verified replay (the event already exists — nothing is predicted or decided), and
 * a clip never starts before the bell, so the 3 · 2 · 1 shows nobody swinging.
 */
export interface ActionTimes {
  /** ms after the bell of each ATTACK of one fighter, and of each skill's RELEASE (the end of its cast), ascending. */
  attacks: number[];
  skills: number[];
}

type ReplayTiming = Pick<ReplayDto, "events" | "tickMs"> & Partial<Pick<ReplayDto, "frames" | "stride" | "startPositions" | "ticks">>;

/**
 * Ticks from a SKILL event (the cast begins) to its release: a cast resolves on the first tick its caster no longer carries CASTING; an instant
 * skill at once. 0 when the replay has no frames.
 */
export function castTicks(replay: ReplayTiming, slot: number, tick: number): number {
  const { frames, stride, startPositions } = replay;
  if (!frames || !stride || !startPositions) return 0;
  const n = startPositions.length;
  const last = replay.ticks ?? Math.floor(frames.length / (n * stride)) - 1;
  let t = tick;
  while (t <= last && ((frames[(t * n + slot) * stride + 3] as number) & FRAME_FLAG.CASTING) !== 0) t++;
  return t - tick;
}

export function actionTimes(replay: ReplayTiming): Map<number, ActionTimes> {
  const out = new Map<number, ActionTimes>();
  const of = (slot: number): ActionTimes => {
    let t = out.get(slot);
    if (!t) out.set(slot, (t = { attacks: [], skills: [] }));
    return t;
  };
  for (const e of replay.events) {
    if (e[1] === EV.ATTACK) of(e[2]).attacks.push(e[0] * replay.tickMs);
    else if (e[1] === EV.SKILL) of(e[2]).skills.push((e[0] + castTicks(replay, e[2], e[0])) * replay.tickMs);
  }
  for (const t of out.values()) t.skills.sort((a, b) => a - b);
  return out;
}

/** How long before its event a clip must start so that its impact frame is on screen when the event happens (0 without an impact frame). */
export function impactLeadMs(clip: ClipDef | undefined): number {
  if (!clip || clip.impact === undefined) return 0;
  return ((clip.impact + 0.4) / clip.fps) * 1000;
}

/**
 * ms since the clip presenting the latest action began, at `combatMs` after the bell — Infinity when none has begun. A clip begins `leadMs`
 * before its event, never before the bell. `times` must be ascending.
 */
export function sinceClipStart(times: readonly number[], combatMs: number, leadMs: number): number {
  if (combatMs < 0) return Infinity;
  const limit = combatMs + leadMs;
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= limit) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return Infinity;
  return combatMs - Math.max(0, (times[lo - 1] as number) - leadMs);
}
