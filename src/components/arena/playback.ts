import { EV, FRAME_FLAG, type EventTuple } from "@/domain/combat/types";
import type { BattleDto, ReplayDto } from "@/lib/dto";

import { EventCursor } from "./eventCursor";
import { phaseNow, type PhaseNow } from "./phase";

/**
 * WHAT THE STAGE SHOWS AT ONE SERVER INSTANT — a pure function of (battle, replay, server clock).
 *
 * The 3 · 2 · 1 is a real PRE-FIGHT state, not a decoration:
 *   · before `combatStartsAt` (IDLE · INTRO · COUNTDOWN) every hero is exactly as it spawned — its authoritative start position, FULL HP,
 *     alive, no status — and no combat event is presented, whatever the browser saw before (a battle whose timeline moved, a clock estimate
 *     that stepped back across the bell, a replay that arrived early). Nothing from the fight can leak under the countdown.
 *   · from `combatStartsAt` on, the verified replay is played: tick 0 is the spawn state, the first event is at tick 1.
 * The browser never decides anything here: positions, HP, flags and events all come from the server's replay; this only says WHICH part of it
 * is visible at a given instant. `ArenaPlayback` adds the per-viewer bookkeeping (each event presented once, live damage / KO totals) and
 * tells the renderer when everything it has drawn so far must be dropped.
 */
export interface StageTiming {
  countdownMs: number;
  maxCombatMs: number;
}

export interface UnitFrame {
  slot: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** FRAME_FLAG bits (ALIVE, STUNNED, SLOWED, SHIELDED, … and, from rules 3.1.0, the combat state bits). */
  flags: number;
  /** Slot of the current target, or -1. */
  target: number;
  /** True when this tick's position jumped (a dash / shadowstep): draw it, never slide through other fighters. */
  jumped: boolean;
}

export type ArenaPhaseName = PhaseNow["phase"];

/** The phases before the bell: heroes stand where they spawned, at full HP, and nothing of the fight is shown. */
export const isPreFight = (phase: ArenaPhaseName): boolean => phase === "IDLE" || phase === "INTRO" || phase === "COUNTDOWN";
const playsReplay = (phase: ArenaPhaseName): boolean => phase === "COMBAT" || phase === "VICTORY" || phase === "RESULTS" || phase === "DONE";

const fightersBySlot = (battle: BattleDto) => battle.fighters.slice().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

/** The authoritative spawn state: start positions, full HP, alive, no status. Exactly tick 0 of the replay. */
export function spawnState(battle: BattleDto): UnitFrame[] {
  // Cached per battle object (the stage asks for it every animation frame); callers get fresh copies, so nothing shared can be mutated.
  let base = spawnCache.get(battle);
  if (!base) spawnCache.set(battle, (base = buildSpawnState(battle)));
  return base.map((u) => ({ ...u }));
}
const spawnCache = new WeakMap<BattleDto, UnitFrame[]>();
function buildSpawnState(battle: BattleDto): UnitFrame[] {
  return fightersBySlot(battle).map((f, i) => {
    const sp = f.startPosition ?? [0, 0];
    const maxHp = f.maxHp ?? 1;
    return { slot: f.slot ?? i, x: sp[0], y: sp[1], hp: maxHp, maxHp, alive: true, flags: FRAME_FLAG.ALIVE, target: -1, jumped: false };
  });
}

/** A position change this large between two ticks is a teleport-style move (dash / shadowstep), never a walk. */
export const JUMP_UNITS = 60;

/** Every hero at `combatMs` into the replay: positions interpolated between ticks; HP, flags and target exact for the tick. */
export function unitsAt(battle: BattleDto, replay: ReplayDto, combatMs: number): UnitFrame[] {
  const spawn = spawnState(battle);
  const n = spawn.length;
  const s = replay.stride;
  const tf = Math.min(Math.max(combatMs / replay.tickMs, 0), replay.ticks);
  const i0 = Math.floor(tf);
  const i1 = Math.min(i0 + 1, replay.ticks);
  const a = tf - i0;
  return spawn.map((u) => {
    const o0 = i0 * n * s + u.slot * s;
    const o1 = i1 * n * s + u.slot * s;
    if (o1 + s > replay.frames.length) return u;
    const x0 = (replay.frames[o0] as number) / 10;
    const y0 = (replay.frames[o0 + 1] as number) / 10;
    const x1 = (replay.frames[o1] as number) / 10;
    const y1 = (replay.frames[o1 + 1] as number) / 10;
    const jumped = Math.hypot(x1 - x0, y1 - y0) > JUMP_UNITS;
    const flags = replay.frames[o0 + 3] as number;
    return {
      slot: u.slot,
      x: jumped ? (a < 0.5 ? x0 : x1) : x0 + (x1 - x0) * a,
      y: jumped ? (a < 0.5 ? y0 : y1) : y0 + (y1 - y0) * a,
      hp: replay.frames[o0 + 2] as number,
      maxHp: u.maxHp,
      alive: (flags & FRAME_FLAG.ALIVE) !== 0,
      flags,
      target: (replay.frames[o0 + 4] as number) - 1,
      jumped,
    };
  });
}

export interface StageAt {
  clock: PhaseNow;
  units: UnitFrame[];
  /** How many replay events have happened by this instant (0 before the bell). */
  eventsHappened: number;
}

/** The stage at one server instant. Before the bell: the spawn state, 0 events — even if a replay is already in hand. */
export function stageAt(battle: BattleDto, replay: ReplayDto | null, nowMs: number, timing: StageTiming): StageAt {
  const clock = phaseNow(battle, nowMs, timing.countdownMs, timing.maxCombatMs);
  if (!replay || replay.battleId !== battle.id || !playsReplay(clock.phase)) return { clock, units: spawnState(battle), eventsHappened: 0 };
  let happened = 0;
  while (happened < replay.events.length && (replay.events[happened] as EventTuple)[0] * replay.tickMs <= clock.combatMs) happened++;
  return { clock, units: unitsAt(battle, replay, clock.combatMs), eventsHappened: happened };
}

export interface PlaybackFrame extends StageAt {
  /** Events to PRESENT this frame — each exactly once per viewer; never any before the bell. */
  fresh: EventTuple[];
  /** Drop everything drawn so far (effects, KO fades, eased HP): a new battle, a battle whose timeline moved, or a step back to before the bell. */
  reset: boolean;
  /** Live damage dealt / eliminations per slot, exact from the event log up to now. */
  stats: Map<number, { damage: number; kills: number }>;
}

/**
 * One viewer's playback of the battle on stage. Feed it every animation frame; it returns the stage state plus the events to present.
 * It resets itself — and says so — whenever what it has shown no longer belongs to the timeline on screen.
 */
export class ArenaPlayback {
  private key: string | null = null;
  private replayRef: ReplayDto | null = null;
  private wasPreFight = true;
  private readonly cursor = new EventCursor();
  private statIdx = 0;
  private statMs = 0;
  private readonly stats = new Map<number, { damage: number; kills: number }>();

  frame(battle: BattleDto | null, replay: ReplayDto | null, nowMs: number, timing: StageTiming): PlaybackFrame | null {
    if (!battle) {
      this.key = null;
      return null;
    }
    const at = stageAt(battle, replay, nowMs, timing);
    const pre = isPreFight(at.clock.phase);
    const key = `${battle.id}@${battle.combatStartsAt ?? "?"}`;
    let reset = false;
    if (key !== this.key || (pre && !this.wasPreFight)) {
      // A different battle — or the SAME battle whose timeline moved, or a clock that stepped back to before the bell: nothing shown so far is valid.
      this.key = key;
      this.replayRef = null;
      this.cursor.reset();
      this.resetStats();
      reset = true;
    }
    this.wasPreFight = pre;
    const usable = replay && replay.battleId === battle.id ? replay : null;
    if (usable !== this.replayRef) {
      this.replayRef = usable;
      this.cursor.reset();
      this.resetStats();
    }
    let fresh: EventTuple[] = [];
    if (usable && !pre) {
      if (at.clock.phase === "COMBAT" || at.clock.phase === "VICTORY") fresh = this.cursor.take(usable.events, usable.tickMs, at.clock.combatMs);
      this.trackStats(usable, at.clock.combatMs);
    }
    return { ...at, fresh, reset, stats: this.stats };
  }

  private resetStats(): void {
    this.statIdx = 0;
    this.statMs = 0;
    this.stats.clear();
  }

  private trackStats(r: ReplayDto, combatMs: number): void {
    if (combatMs < this.statMs) this.resetStats();
    this.statMs = combatMs;
    while (this.statIdx < r.events.length) {
      const ev = r.events[this.statIdx] as EventTuple;
      if (ev[0] * r.tickMs > combatMs) break;
      this.statIdx++;
      if (ev[1] === EV.HIT) this.bump(ev[2]).damage += ev[4];
      else if (ev[1] === EV.ELIM && ev[3] >= 0) this.bump(ev[3]).kills++;
    }
  }

  private bump(slot: number): { damage: number; kills: number } {
    let s = this.stats.get(slot);
    if (!s) this.stats.set(slot, (s = { damage: 0, kills: 0 }));
    return s;
  }
}
