import { cuesForEvents, type CueContext, type SoundCue } from "@/domain/audio/cues";
import { ARENA_LABEL_MAX } from "@/domain/character/displayName";
import { EV, EV_FLAG, FRAME_FLAG } from "@/domain/combat/types";
import type { BattleDto, ClassVisual, FighterDto, ReplayDto } from "@/lib/dto";

import { drawHero, HERO_HEIGHT, type HeroLook, type HeroPose } from "@/components/hero/drawHero";
import { lookFor } from "@/components/hero/look";
import { getHeroSheet, type HeroSheet, type SpriteSource } from "@/components/sprites/compositor";
import { drawHeroSprite, playbackFor, type SpriteDraw } from "@/components/sprites/draw";
import { resolveClip, RUN_SPEED, type AnimInput } from "@/domain/sprites/animator";

import { rarityVisual } from "@/domain/hero/rarityVisuals";

import { actionTimes, castTicks, impactLeadMs, sinceClipStart, type ActionTimes } from "./actionClock";
import { ArenaPlayback, isPreFight, type PlaybackFrame, type StageTiming } from "./playback";
import { fitPlateName, layoutPlates, newPlateState, plateMetrics, plateSizes, type PlateInput, type PlateMode, type PlateSizes, type PlateState, type Rect } from "./nameplates";
import { updateOffsets } from "./spacing";
import type { PhaseNow } from "./phase";
import { drawRarityMark } from "./rarityFx";
import { TALL, WIDE, drawBackground, project, type Layout } from "./scene";

/**
 * Canvas renderer for the Global Arena. It is a pure PLAYER of server-computed data:
 * positions, HP and every event come from the verified replay; the browser never decides who
 * wins. Fixed camera, all eight fighters always on screen.
 *
 * PRESENTATION RULES (hero renderer v2):
 *   · No generic circles around the bodies. A hero stands on ONE small contact shadow; rarity shows on its gear (the sprite set) and on its name
 *     plate; a status shows ON the hero (a shield shimmers across the hero's own silhouette, a slow frosts the feet, a buff rises in small
 *     chevrons, a stun circles stars over the head, a taunt marks it) — never as a ring.
 *   · A blow lands on screen when the server says it lands: the attack / cast clip is started early enough that its impact frame is shown at the
 *     event (actionClock.ts). Shots leave from the weapon (the sprite set's muzzle), never from the middle of the body.
 *   · Skills read by shape: a cleave sweeps, a nova cracks the floor with shards, a taunt shouts, a burst shatters, a heal rises, a dash leaves
 *     afterimages, a knock-out falls and raises dust.
 *   · Name plates never cover a hero: each hangs above its own hero's real head (a tall hat included) and stays there for the whole fight, on a
 *     phone as much as on a desktop. In a crowd a plate steps sideways or up just far enough to clear its neighbours (nameplates.ts), keeps
 *     out of the measured HUD boxes, and only a hero buried in a pile falls back to a bare name, then to its HP bar. Damage numbers rise from
 *     above the plate, beside the head — never across a name — and every number stays inside the stage.
 *   · No body-sized shapes: a blade leaves a thin trail along its arc (never a filled half-disc), a hit is a short light flash and a few
 *     sparks, a smite is a short shaft that drops onto the head.
 */

export type ArenaPhase = "IDLE" | "INTRO" | "COUNTDOWN" | "COMBAT" | "VICTORY" | "RESULTS" | "DONE";

export interface RenderClock {
  now: number;
  phase: ArenaPhase;
  /** ms since the battle slot began (for the drop-in animation) */
  sinceStart: number;
  /** ms since combat began, clamped to the fight length */
  combatMs: number;
  winnerSlot: number | null;
}

interface UnitState {
  slot: number;
  fighter: FighterDto;
  look: HeroLook;
  visual: ClassVisual | undefined;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  hpShown: number;
  hpTrail: number;
  alive: boolean;
  flags: number;
  target: number;
  attackAt: number;
  castAt: number;
  hurtAt: number;
  deadAt: number;
  textAt: number;
  facing: 1 | -1;
  /** The way the hero faced at spawn (toward the centre) — restored whenever the stage resets to the spawn state. */
  spawnFacing: 1 | -1;
  moving: boolean;
  /** Horizontal speed (world units / s): a hero moving against the way it faces is backpedalling. */
  vx: number;
  landed: boolean;
  /** The side the last blow came from (+1: from the left, the hero recoils to the right). */
  hurtDir: 1 | -1;
  /** A dash: where it started and when (afterimages). */
  dashAt: number;
  dashFrom: [number, number];
  /** A shield was just raised (a brighter shimmer). */
  shieldAt: number;
  /** How many numbers have popped over this hero (they alternate sides). */
  numbers: number;
  /** Presentation-only horizontal nudge (world units) that keeps two sprites in contact from merging into one figure (spacing.ts). */
  ox: number;
  /** The run cycle's own clock: it advances with the ground the hero actually covers (a slow step is a walk, a sprint a run — no sliding feet). */
  moveClock: number;
  /** Smoothed ground speed (world units / s) and whether the hero is running (a set with a `run` clip; hysteresis keeps it from flickering). */
  speed: number;
  running: boolean;
  /** The last parried / dodged blow (the target of a MISS) and the last facing flip — presentation clips of sets that draw them. */
  blockAt: number;
  turnAt: number;
  /** The facing the sprite was last drawn with (0: not drawn yet). */
  drawnFacing: 0 | 1 | -1;
  /** Screen y of the top of this hero's name plate as last drawn (NaN: none) — numbers rise from above it, never across the name. */
  plateTop: number;
  /** The last label shown at the feet, and its row (labels close together stack instead of overlapping). */
  feetAt: number;
  feetRow: number;
  /** Whom the last blow / shot was aimed at, and until when the hero keeps facing it (its follow-through never turns away from the target). */
  faceSlot: number;
  faceUntil: number;
  /** The last white hit flash (a short pop; a hero hit by several attackers is not kept white). */
  flashAt: number;
  /** Composed spritesheet hero (null until a sprite set is ready, or when the set cannot draw this hero). */
  sheet: HeroSheet | null;
  sheetSrc: SpriteSource | null;
  /** Live spectator stats, accumulated from the verified event log as playback passes each event. */
  damage: number;
  kills: number;
  /** Name plate memory (nameplates.ts): mode, which side it stepped to, drawn position — kept between frames so plates never flicker. */
  plate: PlateState;
  /** The plate as last placed (what a fading plate keeps drawing) and the sizes of its modes for the current stage size. */
  plateRect: Rect | null;
  plateShown: PlateMode;
  plateName: string;
  /** The hero's chosen title as drawn above its name ("" = none), fitted like the name. */
  plateTitle: string;
  plateSizes: PlateSizes | null;
  plateSizesKey: string;
}

interface Fx {
  t0: number;
  dur: number;
  layer: "ground" | "air";
  draw: (ctx: CanvasRenderingContext2D, k: number, now: number) => void;
}

export interface RosterEntry {
  slot: number;
  hpFrac: number;
  alive: boolean;
  kills: number;
  damage: number;
  /** FRAME_FLAG bits: stunned / slowed / shielded / taunted / buffed … */
  flags: number;
}

/** One plate as drawn in the last frame (QA / tests only — see ArenaRenderer.capturePlates). Layout units. */
export interface PlateDebug {
  slot: number;
  mode: PlateMode;
  name: string;
  rect: Rect;
  displaced: boolean;
  key: string;
  /** Where the hero's head is (the plate's anchor). */
  ax: number;
  ay: number;
}

/** A floating number's remembered step away from a plate or button (layout units): see ArenaRenderer.fitText. */
interface TextNudge {
  dx: number;
  dy: number;
  /** False until the first frame: a number that is born next to a plate starts clear of it. */
  set: boolean;
}

export interface ArenaEventOut {
  type: "ELIM";
  victim: number;
  killer: number | null;
}

const easeOutBack = (t: number) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/**
 * How tall a hero is drawn on the stage (hero units; the vector hero is authored 104 tall). Well under the authored height: eight heroes share
 * one floor, a melee pair in contact must still read as two figures, and the floor must stay visible around them (≈ 2× the sprite's own pixels
 * on a desktop stage — the class reads from the silhouette, not from size).
 */
const STAGE_HERO_HEIGHT = 84;
const STAGE_K = STAGE_HERO_HEIGHT / HERO_HEIGHT;
/** Mouth / chest heights in hero units (feet at 0). */
const MOUTH_Y = 84 * STAGE_K;
const CHEST_Y = 50 * STAGE_K;
/** A name plate hangs this far above the top of its hero (hero units). */
const PLATE_GAP = 8;
/** Time per display frame spent composing clips ahead of need (ms): before the bell, and — procedural sets only — during the fight. */
const WARM_BUDGET_MS = 5;
const WARM_BUDGET_FIGHT_MS = 2;
/** A display frame that took longer than this (ms) was late: a procedural set warms nothing on it. */
const LATE_FRAME_MS = 18;

export class ArenaRenderer {
  private ctx: CanvasRenderingContext2D;
  private layout: Layout = WIDE;
  private bg: HTMLCanvasElement | null = null;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private units: UnitState[] = [];
  /** Every unit's plate memory by slot (the layout keeps its hysteresis here between frames). */
  private plateStates = new Map<number, PlateState>();
  private fx: Fx[] = [];
  private battleId: string | null = null;
  private battle: BattleDto | null = null;
  private replay: ReplayDto | null = null;
  /** Per fighter, when its blows and casts happen (ms after the bell) — the sprite clips are timed to them. */
  private times = new Map<number, ActionTimes>();
  /** What the stage shows at each instant — the pure, server-derived part (spawn state before the bell, the verified replay after). */
  private readonly playback = new ArenaPlayback();
  private classes: Record<string, ClassVisual> = {};
  private fontFamily = "sans-serif";
  private displayFont = "sans-serif";
  private R = 300;
  private reducedMotion = false;
  private sprites: SpriteSource | null = null;
  onEvent: ((e: ArenaEventOut) => void) | null = null;
  /** Every sound the replay's events call for, as it becomes due — the Arena's audio engine listens. Presentation only; it decides nothing. */
  onCue: ((cue: SoundCue) => void) | null = null;
  /** For each elimination of the replay on stage: how many fighters were still standing after it (built once per replay). */
  private eliminations: { replay: ReplayDto; after: Map<string, number> } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    const cs = getComputedStyle(canvas);
    this.fontFamily = cs.fontFamily || "sans-serif";
    this.displayFont = getComputedStyle(document.documentElement).getPropertyValue("--font-bungee").trim() || this.fontFamily;
    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }

  /** CSS size of the canvas element. Chooses the wide or tall camera framing. */
  resize(cssW: number, cssH: number, dpr: number): void {
    const next = cssW / Math.max(1, cssH) < 1.25 ? TALL : WIDE;
    this.cssW = cssW;
    this.cssH = cssH;
    // Fill-rate, not script, is what a phone pays for (profiled: ~6 % of a throttled frame is our code, ~40 % is the browser filling and
    // compositing the canvas). A phone-sized stage is capped at 2× — the pixel art stays crisp — instead of 2.5–3×.
    this.dpr = Math.min(dpr, cssW < 480 ? 2 : 2.5);
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.layout = next;
    this.bg = null;
  }

  get layoutName(): Layout["name"] {
    return this.layout.name;
  }

  setClasses(classes: Record<string, ClassVisual>): void {
    this.classes = classes;
  }

  /** Install (or clear) the sprite set. Until one is installed, heroes draw with the vector fallback. */
  setSprites(src: SpriteSource | null): void {
    this.sprites = src;
    this.requestPages();
  }

  /** Asks a lazily loaded set for the atlas pages of the heroes of this battle as soon as both are known — long before the bell. */
  private requestPages(): void {
    for (const u of this.units) this.sheetFor(u)?.atlasStatus();
  }

  /** Install (or clear) the battle being shown. Resets animation state when the battle changes. */
  setBattle(battle: BattleDto | null, replay: ReplayDto | null): void {
    const id = battle?.id ?? null;
    this.battle = battle;
    if (id !== this.battleId) {
      this.battleId = id;
      this.fx = [];
      this.units = [];
      this.times = new Map();
      if (battle) {
        this.R = 300;
        this.units = battle.fighters
          .slice()
          .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
          .map((f, i) => {
            const slot = f.slot ?? i;
            const visual = this.classes[f.classId];
            const sp = f.startPosition ?? [0, 0];
            const facing = (sp[0] > 0 ? -1 : 1) as 1 | -1;
            return {
              slot, fighter: f, look: lookFor(f.appearance, visual), visual, x: sp[0], y: sp[1],
              hp: f.maxHp ?? 1, maxHp: f.maxHp ?? 1, hpShown: f.maxHp ?? 1, hpTrail: f.maxHp ?? 1,
              alive: true, flags: FRAME_FLAG.ALIVE, target: 0, attackAt: -1e9, castAt: -1e9, hurtAt: -1e9, deadAt: -1, textAt: -1e9,
              facing, spawnFacing: facing, moving: false, vx: 0, landed: false, hurtDir: 1, dashAt: -1e9, dashFrom: [sp[0], sp[1]], shieldAt: -1e9, numbers: 0, ox: 0, moveClock: slot * 137, speed: 0, running: false, blockAt: -1e9, turnAt: -1e9, drawnFacing: 0, plateTop: Number.NaN, feetAt: -1e9, feetRow: 0, faceSlot: -1, faceUntil: -1e9, flashAt: -1e9,
              sheet: null, sheetSrc: null, damage: 0, kills: 0, plate: newPlateState(), plateRect: null, plateShown: "full", plateName: "", plateTitle: "", plateSizes: null, plateSizesKey: "",
            } satisfies UnitState;
          });
        this.plateStates = new Map(this.units.map((u) => [u.slot, u.plate]));
        this.requestPages();
      }
    }
    if (replay && replay !== this.replay) {
      this.replay = replay;
      this.R = replay.combat.arenaRadius;
      this.times = replay.battleId === id ? actionTimes(replay) : new Map();
    } else if (!replay) {
      this.replay = null;
      this.times = new Map();
    }
  }

  private ensureBackground(): HTMLCanvasElement {
    if (this.bg) return this.bg;
    const L = this.layout;
    const c = document.createElement("canvas");
    c.width = Math.round(L.w * (this.cssW / L.w) * this.dpr);
    c.height = Math.round(L.h * (this.cssH / L.h) * this.dpr);
    const g = c.getContext("2d");
    if (g) {
      g.scale(c.width / L.w, c.height / L.h);
      drawBackground(g, L);
    }
    this.bg = c;
    return c;
  }

  /** A fighter's position at a replay tick (the verified frames), or null when the replay doesn't have it. */
  private positionAt(slot: number, tick: number): [number, number] | null {
    const r = this.replay;
    const n = this.units.length;
    if (!r || r.battleId !== this.battleId || tick < 0 || n === 0) return null;
    const o = (tick * n + slot) * r.stride;
    if (o + 1 >= r.frames.length) return null;
    return [(r.frames[o] as number) / 10, (r.frames[o + 1] as number) / 10];
  }

  private worldToScreen(wx: number, wy: number) {
    return project(this.layout, wx, wy, this.R);
  }

  /** Where a hero is DRAWN: its server position plus the presentation nudge (spacing.ts). */
  private unitScreen(u: UnitState) {
    return project(this.layout, u.x + u.ox, u.y, this.R);
  }

  private pos(slot: number) {
    const u = this.units.find((x) => x.slot === slot);
    return u ? { u, ...this.unitScreen(u) } : null;
  }

  // ---------------------------------------------------------------- simulation playback
  /**
   * Applies the stage state of this instant. Before the bell every hero is SNAPPED to its spawn state (start position, full HP, alive, no
   * status) — no easing toward it, nothing kept from an earlier frame — so the 3 · 2 · 1 can never show a hurt or fallen hero.
   */
  private updateUnits(frame: PlaybackFrame, clock: RenderClock, dtMs: number): void {
    const pre = isPreFight(frame.clock.phase);
    if (frame.reset) {
      this.fx = [];
      for (const u of this.units) {
        u.attackAt = u.castAt = u.hurtAt = u.textAt = u.dashAt = u.shieldAt = u.flashAt = u.faceUntil = u.blockAt = u.turnAt = -1e9;
        u.drawnFacing = 0;
        u.deadAt = -1;
        u.facing = u.spawnFacing;
      }
    }
    for (const u of this.units) {
      const f = frame.units.find((x) => x.slot === u.slot);
      if (!f) continue;
      const px = u.x;
      const py = u.y;
      u.x = f.x;
      u.y = f.y;
      u.hp = f.hp;
      u.flags = pre ? FRAME_FLAG.ALIVE : f.flags;
      u.target = f.target + 1;
      const st = frame.stats.get(u.slot);
      u.damage = st?.damage ?? 0;
      u.kills = st?.kills ?? 0;
      if (pre) {
        u.alive = true;
        u.deadAt = -1;
        u.moving = false;
        u.vx = 0;
        u.speed = 0;
        u.running = false;
        u.facing = u.spawnFacing;
        u.hpShown = u.hpTrail = u.hp = u.maxHp;
        continue;
      }
      const speed = (Math.hypot(u.x - px, u.y - py) / Math.max(1, dtMs)) * 1000;
      u.moving = speed > 14 && !f.jumped;
      // the run cycle advances with the ground covered: ≈ 62 units/s is the authored cadence; slower reads as a walk (clamped so it never freezes)
      if (u.moving) u.moveClock += dtMs * clamp(speed / 62, 0.4, 1.6);
      // smoothed ground speed for the walk / run choice (a set with a `run` clip), with hysteresis
      u.speed += ((u.moving ? speed : 0) - u.speed) * (1 - Math.exp(-dtMs / 140));
      u.running = u.moving && (u.speed > RUN_SPEED || (u.running && u.speed > RUN_SPEED - 9));
      u.vx = f.jumped ? 0 : ((u.x - px) / Math.max(1, dtMs)) * 1000;
      const wasAlive = u.alive;
      u.alive = f.alive;
      if (wasAlive && !u.alive && u.deadAt < 0) u.deadAt = clock.now;
      if (!u.alive && u.deadAt < 0) u.deadAt = clock.now - 3000; // joined late: already fallen
      // Facing: toward the target while it is alive (with a little dead zone, so two heroes stacked vertically don't flip every frame), otherwise
      // the direction of travel. A hero stepping back from its target therefore keeps facing it — and backpedals.
      const aimed = clock.now < u.faceUntil ? this.units.find((q) => q.slot === u.faceSlot) : null;
      const tgt = aimed && aimed.alive ? aimed : u.target > 0 ? this.units.find((q) => q.slot === u.target - 1) : null;
      if (tgt && tgt.alive && Math.abs(tgt.x - u.x) > (tgt === aimed ? 2 : 8)) u.facing = tgt.x > u.x ? 1 : -1;
      else if (!(tgt && tgt.alive) && Math.abs(u.x - px) > 0.05) u.facing = u.x > px ? 1 : -1;
      // HP bar easing (+ white damage trail)
      const k = 1 - Math.exp(-dtMs / 70);
      u.hpShown += (u.hp - u.hpShown) * k;
      u.hpTrail += (u.hpShown - u.hpTrail) * (1 - Math.exp(-dtMs / 420));
      if (u.hpTrail < u.hpShown) u.hpTrail = u.hpShown;
    }
  }

  /** Presentation spacing between sprites in contact (never before the bell). */
  private updateSpacing(frame: PlaybackFrame, dtMs: number): void {
    updateOffsets(this.units, frame.reset ? 0 : dtMs, !isPreFight(frame.clock.phase) && !this.reducedMotion);
  }

  private processEvents(frame: PlaybackFrame, now: number): void {
    const r = this.replay;
    if (!r) return;
    // Joined mid-fight or the tab was asleep: the cursor skips visuals for events older than 700 ms. It never rewinds, so a small backward
    // step of the estimated server clock cannot make an already-shown elimination appear again. Never any before the bell.
    for (const ev of frame.fresh) this.spawnForEvent(ev as [number, number, number, number, number, number], now - (frame.clock.combatMs - ev[0] * r.tickMs));
    if (this.onCue && frame.fresh.length > 0 && this.battle) {
      const ctx = this.cueContext(r, this.battle.id, frame.clock.combatMs);
      for (const cue of cuesForEvents(frame.fresh, ctx)) this.onCue(cue);
    }
  }

  /** What the cue mapper needs from the stage: who stands where, which skill is which, how long a cast takes, how many are left after a KO. */
  private cueContext(r: ReplayDto, battleId: string, combatMs: number): CueContext {
    if (this.eliminations?.replay !== r) {
      const after = new Map<string, number>();
      let left = this.units.length;
      for (const e of r.events) if (e[1] === EV.ELIM) after.set(`${e[0]}:${e[2]}`, --left);
      this.eliminations = { replay: r, after };
    }
    const elim = this.eliminations.after;
    const start = this.units.length;
    return {
      battleId,
      tickMs: r.tickMs,
      combatMs,
      radius: this.R,
      unit: (slot) => {
        const u = this.units.find((x) => x.slot === slot);
        return u ? { classId: u.fighter.classId, weapon: u.visual?.weapon ?? "", body: u.visual?.body ?? "", style: u.visual?.attackStyle ?? "slash", x: u.x } : undefined;
      },
      skill: (index) => {
        const id = r.skillIds[index];
        return id === undefined ? undefined : { id, fx: r.skillFx[id]?.fx ?? "buff" };
      },
      releaseMs: (slot, tick) => castTicks(r, slot, tick) * r.tickMs,
      aliveAfter: (tick, victim) => {
        const alive = elim.get(`${tick}:${victim}`);
        return alive === undefined ? undefined : { alive, start };
      },
    };
  }

  private spawnForEvent(ev: [number, number, number, number, number, number], at: number): void {
    const [, kind, a, b, v, flags] = ev;
    const A = this.units.find((u) => u.slot === a);
    const B = this.units.find((u) => u.slot === b);
    const style = A?.visual?.attackStyle ?? "slash";
    const cA = A?.visual?.colors[1] ?? "#fff";
    switch (kind) {
      case EV.ATTACK: {
        if (!A) return;
        A.attackAt = at;
        if (B) {
          A.faceSlot = B.slot;
          A.faceUntil = at + 380;
          if (Math.abs(B.x - A.x) > 2) A.facing = B.x > A.x ? 1 : -1; // the shot / blow leaves toward its target, never sideways or backwards
        }
        if (flags & EV_FLAG.PROJECTILE && B) this.projectile(A, B, at, Math.max(120, v * (this.replay?.tickMs ?? 100)), style, cA);
        else if (B) this.slash(A, B, at, cA, A.visual?.body === "heavy", style);
        break;
      }
      case EV.HIT: {
        if (!B) return;
        B.hurtAt = at;
        if (at - B.flashAt > 260) B.flashAt = at;
        if (A) B.hurtDir = B.x >= A.x ? 1 : -1;
        const crit = (flags & EV_FLAG.CRIT) !== 0;
        this.damageText(B, `${v}`, crit ? "#ffd04a" : (flags & EV_FLAG.AOE) !== 0 ? "#ffb08a" : "#ffffff", crit ? 1.45 : 1, at);
        this.sparks(B, at, crit ? "#ffd04a" : "#ffe9c4", crit ? 12 : 7);
        break;
      }
      case EV.MISS:
        if (B) {
          this.damageText(B, "MISS", "#9aa4b2", 0.8, at);
          // the target parries / dodges (a set with a `block` clip): the clip's guard is up as the blow would have landed
          B.blockAt = at - 60;
        }
        break;
      case EV.SKILL: {
        if (!A) return;
        A.castAt = at;
        const info = this.replay?.skillFx[this.replay.skillIds[v] as string];
        // The cast begins now; its effect is shown when it RESOLVES — with the damage it does (the end of the cast, from the replay's frames).
        const release = this.replay ? castTicks(this.replay, a, ev[0]) * this.replay.tickMs : 0;
        this.skillFx(info?.fx ?? "buff", A, B ?? null, at + release);
        if (info && this.cssW > 520) this.damageText(A, info.name.toUpperCase(), "#8ff7e4", 0.62, at, 0, "feet");
        break;
      }
      case EV.HEAL:
        if (B) {
          this.damageText(B, `+${v}`, "#7dffb2", 0.95, at);
          this.risingMarks(B, at, "#7dffb2", "+");
        }
        break;
      case EV.SHIELD:
        if (A) A.shieldAt = at;
        break;
      case EV.STATUS: {
        const labels: Record<number, [string, string]> = { 1: ["STUNNED", "#ffd04a"], 2: ["SLOWED", "#8fe3ff"], 3: ["TAUNTED", "#ff7a6a"] };
        const l = labels[v];
        if (l && A && at - A.textAt > 500) {
          A.textAt = at;
          this.damageText(A, l[0], l[1], 0.58, at, 0, "feet");
        }
        break;
      }
      case EV.DASH:
        if (A) {
          A.dashAt = at;
          A.dashFrom = this.positionAt(A.slot, ev[0] - 1) ?? [A.x, A.y];
          if (!this.sheetFor(A)) this.dashTrail(A, at);
        }
        break;
      case EV.ELIM: {
        if (!A) return;
        this.eliminationBurst(A, at);
        this.onEvent?.({ type: "ELIM", victim: a, killer: b >= 0 ? b : null });
        break;
      }
      case EV.HAZARD:
        if (A && at - A.textAt > 450) {
          A.textAt = at;
          A.hurtAt = at;
          this.damageText(A, `${v}`, "#ff7a5c", 0.8, at);
        }
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- effects
  private add(fx: Fx): void {
    if (this.fx.length > 220) this.fx.splice(0, 40);
    this.fx.push(fx);
  }

  /** A weapon trail in front of the attacker: a tapered crescent for swings, two quick streaks for daggers. */
  private slash(A: UnitState, B: UnitState, at: number, color: string, big: boolean, style = "slash"): void {
    const tilt = clamp((B.y - A.y) / 160, -0.5, 0.5);
    if (style === "stab") {
      this.add({
        t0: at, dur: 150, layer: "air",
        draw: (ctx, k) => {
          const p = this.unitScreen(A);
          const dir = B.x >= A.x ? 1 : -1;
          ctx.save();
          ctx.translate(p.x, p.y - (CHEST_Y - 2) * p.s);
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = color;
          ctx.lineCap = "round";
          for (const off of [-4, 4]) {
            ctx.lineWidth = 2.6 * p.s * (1 - k * 0.5);
            ctx.beginPath();
            ctx.moveTo(dir * (16 + k * 8) * p.s, off * p.s * 0.7);
            ctx.lineTo(dir * (36 + k * 12) * p.s, off * p.s * 0.2);
            ctx.stroke();
          }
          ctx.restore();
        },
      });
      return;
    }
    // A THIN blade trail along the weapon's arc (a sliver, thickest in the middle, tapering to points) — never a filled half-disc, which read as
    // a big translucent circle around the target.
    this.add({
      t0: at, dur: big ? 200 : 150, layer: "air",
      draw: (ctx, k) => {
        const p = this.unitScreen(A);
        const dir = B.x >= A.x ? 1 : -1;
        const r = (big ? 30 : 24) * p.s;
        const sweep = Math.min(1, k * 2.2); // the trail follows the blade, then fades
        const a0 = -1.05;
        const a1 = -1.05 + 1.9 * sweep;
        ctx.save();
        ctx.translate(p.x + dir * 10 * p.s, p.y - CHEST_Y * p.s);
        ctx.scale(dir, 1);
        ctx.rotate(tilt * dir);
        ctx.globalAlpha = (1 - k) * 0.8;
        ctx.fillStyle = "#fffaf0";
        ctx.beginPath();
        ctx.arc(0, 0, r, a0, a1);
        ctx.arc(-0.07 * r, 0, 0.9 * r, a1, a0, true);
        ctx.closePath();
        ctx.fill();
        // the coloured edge, only once the trail is long enough (an arc whose end is before its start would be drawn the long way round —
        // a full circle)
        if (a1 > a0 + 0.3) {
          ctx.globalAlpha = (1 - k) * 0.55;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2 * p.s;
          ctx.beginPath();
          ctx.arc(0, 0, r + 0.6 * p.s, a0 + 0.15, a1);
          ctx.stroke();
        }
        ctx.restore();
      },
    });
  }

  /**
   * Where a fighter's shot leaves, in screen space: its weapon's muzzle on the attack's impact frame (sprite sets that declare it — the bow, the
   * staff crystal, the scepter's sun), otherwise just in front of the chest.
   */
  private muzzle(u: UnitState): { x: number; y: number } {
    const p = this.unitScreen(u);
    const src = this.sprites;
    const sheet = this.sheetFor(u);
    if (src && sheet?.plan.muzzle) {
      const k = (STAGE_HERO_HEIGHT / src.manifest.nominalHeightPx) * p.s;
      return { x: p.x + (sheet.plan.muzzle.x - src.manifest.anchor.x) * k * u.facing, y: p.y + (sheet.plan.muzzle.y - src.manifest.anchor.y) * k };
    }
    return { x: p.x + 14 * p.s * u.facing, y: p.y - (CHEST_Y + 6) * p.s };
  }

  private projectile(A: UnitState, B: UnitState, at: number, dur: number, style: string, color: string): void {
    let from: { x: number; y: number } | null = null; // fixed at release: the shot doesn't follow the shooter afterwards
    this.add({
      t0: at, dur, layer: "air",
      draw: (ctx, k) => {
        from ??= this.muzzle(A);
        const b = this.pos(B.slot);
        if (!b) return;
        const ax = from.x;
        const ay = from.y;
        const bx = b.x;
        const by = b.y - CHEST_Y * b.s;
        const arc = style === "arrow" ? 14 : 6; // an arrow flies a shallow arc; magic flies almost straight
        const x = ax + (bx - ax) * k;
        const y = ay + (by - ay) * k - Math.sin(k * Math.PI) * arc;
        const ang = Math.atan2(by - ay - Math.PI * arc * Math.cos(k * Math.PI), bx - ax); // along the flight path
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        if (style === "arrow") {
          ctx.strokeStyle = "#e9e2d0";
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(-15, 0);
          ctx.lineTo(8, 0);
          ctx.stroke();
          ctx.fillStyle = "#dfe6f2";
          ctx.beginPath();
          ctx.moveTo(8, -3.6);
          ctx.lineTo(14, 0);
          ctx.lineTo(8, 3.6);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = "#c8553d"; // fletching
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(-15, 0);
          ctx.lineTo(-19, -3);
          ctx.moveTo(-15, 0);
          ctx.lineTo(-19, 3);
          ctx.stroke();
        } else if (style === "bolt") {
          // holy bolt: a four-point star with a short golden trail
          ctx.fillStyle = "#fff6c4";
          ctx.beginPath();
          for (let i = 0; i < 8; i++) {
            const r = i % 2 ? 2.4 : 7;
            const a = (i / 8) * Math.PI * 2;
            ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
          }
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 0.45;
          ctx.fillStyle = "#ffd98a";
          ctx.fillRect(-22, -1.8, 18, 3.6);
        } else {
          const c = style === "orb" ? "#9d7bff" : color && color !== "#fff" ? color : "#ffe08a";
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(0, 0, style === "orb" ? 6.5 : 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.75)";
          ctx.beginPath();
          ctx.arc(1.2, -1.2, 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.45;
          ctx.fillStyle = c;
          ctx.fillRect(-18, -2.2, 14, 4.4);
        }
        ctx.restore();
      },
    });
  }

  private damageText(U: UnitState, text: string, color: string, scale: number, at: number, dy = 0, anchor: "head" | "feet" = "head"): void {
    // Numbers pop BESIDE the head (alternating sides, a little jitter) and rise — never stamped onto the hero's own name plate.
    const side = (U.numbers++ & 1) === 0 ? 1 : -1;
    // Labels at the feet (a skill's name, a status) stack downward instead of printing over one another.
    if (anchor === "feet") {
      dy = at - U.feetAt < 700 ? U.feetRow + 1 : 0;
      U.feetRow = dy;
      U.feetAt = at;
    }
    const jitter = anchor === "feet" ? ((U.slot * 37 + at) % 29) - 14 : side * (22 + (((U.slot * 37 + at) % 9) - 4));
    const nudge: TextNudge = { dx: 0, dy: 0, set: false };
    let lastK = 0;
    this.add({
      t0: at, dur: 900, layer: "air",
      draw: (ctx, k) => {
        const dtMs = Math.max(0, k - lastK) * 900;
        lastK = k;
        const p = this.unitScreen(U);
        const pop = this.reducedMotion ? 1 : k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : 1.15 - Math.min(0.15, (k - 0.12) * 0.4);
        const rise = this.reducedMotion ? 20 : easeOutBack(Math.min(1, k * 1.6)) * 34 + k * 14;
        ctx.save();
        ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
        const size = Math.round(19 * scale * pop * this.textScale());
        ctx.font = `${size}px ${this.displayFont}, ${this.fontFamily}`;
        ctx.textAlign = "center";
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(6,8,12,0.95)";
        ctx.lineJoin = "round";
        const tx = p.x + jitter * (anchor === "feet" ? 0.3 : p.s);
        const fromHead = p.y - (this.headTop(U) - 14) * p.s;
        const start = Number.isNaN(U.plateTop) ? fromHead : Math.min(fromHead, U.plateTop - 4 * this.textScale());
        let ty = anchor === "feet" ? p.y + (14 + dy * 11) * p.s + k * 10 : start - rise * 0.75 + dy;
        if (anchor === "feet") {
          // labels at the feet of DIFFERENT heroes standing close together: each steps down a row instead of printing over another
          const w = ctx.measureText(text).width;
          const h = parseFloat(ctx.font) * 1.05;
          for (let row = 0; row < 3 && this.feetRects.some((q) => Math.abs(q.x - tx) < (q.w + w) / 2 && Math.abs(q.y - ty) < h); row++) ty += h;
          this.feetRects.push({ x: tx, y: ty, w, h });
        }
        // the number stays inside the stage, off the page's own controls and off every name plate (it steps beside or above them)
        const fit = this.fitText(tx, ty, ctx.measureText(text).width + 4, size, nudge, dtMs);
        ctx.strokeText(text, fit.x, fit.y);
        ctx.fillStyle = color;
        ctx.fillText(text, fit.x, fit.y);
        ctx.restore();
      },
    });
  }

  private sparks(U: UnitState, at: number, color: string, n: number, y = CHEST_Y + 2): void {
    const seed = U.slot * 13 + Math.floor(at);
    this.add({
      t0: at, dur: 300, layer: "air",
      draw: (ctx, k) => {
        const p = this.unitScreen(U);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        for (let i = 0; i < n; i++) {
          const a = ((seed + i * 97) % 360) * (Math.PI / 180);
          const r0 = 8 + k * 24;
          const r1 = r0 + 7 * (1 - k);
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(a) * r0 * p.s, p.y - y * p.s + Math.sin(a) * r0 * p.s * 0.8);
          ctx.lineTo(p.x + Math.cos(a) * r1 * p.s, p.y - y * p.s + Math.sin(a) * r1 * p.s * 0.8);
          ctx.stroke();
        }
        ctx.restore();
      },
    });
  }

  /** Shards that crack up out of the floor and spread to `radius` (an area skill's reach, shown without drawing a ring). */
  private groundShards(at0: () => [number, number], radius: number, at: number, dur: number, color: string, n = 12): void {
    this.add({
      t0: at, dur, layer: "ground",
      draw: (ctx, k) => {
        const [x0, y0] = at0();
        ctx.save();
        ctx.fillStyle = color;
        ctx.strokeStyle = "rgba(12,18,30,0.7)";
        ctx.lineWidth = 1;
        const grow = this.reducedMotion ? 1 : Math.min(1, k * 2.4);
        const rise = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
        ctx.globalAlpha = Math.min(1, (1 - k) * 1.8);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + (i % 2) * 0.22;
          const d = radius * (0.3 + 0.7 * grow) * (i % 2 ? 0.78 : 1);
          const p = this.worldToScreen(x0 + Math.cos(a) * d, y0 + Math.sin(a) * d);
          const h = rise * (i % 3 === 0 ? 15 : 10) * p.s;
          if (h < 0.6) continue;
          const w = 3 * p.s;
          ctx.beginPath();
          ctx.moveTo(p.x - w, p.y);
          ctx.lineTo(p.x + w * 0.25, p.y - h);
          ctx.lineTo(p.x + w, p.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      },
    });
  }

  /** Frost crystals at a hero's feet (hero units, feet at the origin). */
  private drawFrost(ctx: CanvasRenderingContext2D, now: number, slot: number, strength = 1): void {
    const tw = this.reducedMotion ? 0 : now / 280 + slot;
    ctx.save();
    ctx.fillStyle = "#c8f2ff";
    ctx.strokeStyle = "rgba(36,84,124,0.85)";
    ctx.lineWidth = 1;
    const spikes: ReadonlyArray<readonly [number, number]> = [[-15, 6], [-9, 10], [-3, 5], [5, 9], [11, 7], [16, 4]];
    for (const [i, [x, h]] of spikes.entries()) {
      ctx.globalAlpha = strength * (0.7 + 0.25 * Math.sin(tw + i * 1.7));
      ctx.beginPath();
      ctx.moveTo(x - 2.2, 1.5);
      ctx.lineTo(x + (i % 2 ? 0.8 : -0.8), 1.5 - h);
      ctx.lineTo(x + 2.2, 1.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A snare's frost, held at the target's feet for a moment. */
  private frostFx(U: UnitState, at: number, dur: number): void {
    this.add({
      t0: at, dur, layer: "air",
      draw: (ctx, k, now) => {
        const p = this.unitScreen(U);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(p.s, p.s);
        this.drawFrost(ctx, now, U.slot, k < 0.15 ? k / 0.15 : 1 - Math.max(0, k - 0.7) / 0.3);
        ctx.restore();
      },
    });
  }

  /** A taunt: three shout lines out of the mouth, toward the way the hero faces. */
  private shout(U: UnitState, at: number, color: string): void {
    this.add({
      t0: at, dur: 520, layer: "air",
      draw: (ctx, k) => {
        const p = this.unitScreen(U);
        const f = U.facing;
        const cx = p.x + f * 8 * p.s;
        const cy = p.y - MOUTH_Y * p.s;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineCap = "round";
        for (let i = 0; i < 3; i++) {
          const kk = clamp(k * 1.5 - i * 0.2, 0, 1);
          if (kk <= 0 || kk >= 1) continue;
          const r = (10 + kk * 26) * p.s;
          ctx.globalAlpha = (1 - kk) * 0.95;
          ctx.lineWidth = 2.6 * p.s * (1 - kk * 0.5);
          ctx.beginPath();
          if (f > 0) ctx.arc(cx, cy, r, -0.55, 0.55);
          else ctx.arc(cx, cy, r, Math.PI - 0.55, Math.PI + 0.55);
          ctx.stroke();
        }
        ctx.restore();
      },
    });
  }

  /** Soft motes rising from a hero's feet (a heal). */
  private motes(U: UnitState, at: number, color: string): void {
    if (this.reducedMotion) return;
    this.add({
      t0: at, dur: 760, layer: "air",
      draw: (ctx, k) => {
        const p = this.unitScreen(U);
        ctx.save();
        ctx.fillStyle = color;
        for (let i = 0; i < 7; i++) {
          const kk = clamp(k * 1.3 - (i % 4) * 0.08, 0, 1);
          ctx.globalAlpha = Math.sin(kk * Math.PI) * 0.85;
          const x = p.x + (((i * 23) % 36) - 18) * p.s;
          const y = p.y - (6 + kk * 70 + (i % 3) * 6) * p.s;
          ctx.fillRect(x - 1.5 * p.s, y - 1.5 * p.s, 3 * p.s, 3 * p.s);
        }
        ctx.restore();
      },
    });
  }

  /** Dust kicked up at the feet (a landing, a body hitting the floor). */
  private dust(wx: number, wy: number, at: number, n: number, spread: number): void {
    if (this.reducedMotion) return;
    this.add({
      t0: at, dur: 540, layer: "air",
      draw: (ctx, k) => {
        const p = this.worldToScreen(wx, wy);
        ctx.save();
        for (let i = 0; i < n; i++) {
          const side = i % 2 ? 1 : -1;
          const d = (8 + ((i * 7) % 13)) * spread * (0.3 + 0.7 * Math.sqrt(k));
          ctx.globalAlpha = (1 - k) * 0.45;
          ctx.fillStyle = i % 3 ? "#b9ab98" : "#8f8273";
          ctx.beginPath();
          ctx.ellipse(p.x + side * d * p.s, p.y - (2 + (i % 3) * 3 + k * 7) * p.s, (2.5 + k * 4.5) * p.s, (2 + k * 3) * p.s, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      },
    });
  }

  private skillFx(fx: string, A: UnitState, B: UnitState | null, at: number): void {
    const at0 = () => [A.x, A.y] as [number, number];
    switch (fx) {
      case "cleave":
        if (B) this.slash(A, B, at, "#ffe9b8", true);
        this.dust(A.x, A.y, at + 60, 4, 1.1);
        break;
      case "nova":
        this.groundShards(at0, 75, at, 560, "#bfefff", 14);
        break;
      case "taunt":
        this.shout(A, at, "#ff7a6a");
        this.risingMarks(A, at, "#ff7a6a", "!", 2);
        break;
      case "burst":
        if (B) {
          this.projectile(A, B, at, 280, "orb", "#9d7bff");
          this.sparks(B, at + 280, "#c9a6ff", 12);
        }
        break;
      case "volley":
        if (B) {
          this.projectile(A, B, at, 240, "arrow", "#fff");
          this.projectile(A, B, at + 60, 260, "arrow", "#fff");
          this.projectile(A, B, at + 120, 280, "arrow", "#fff");
        }
        break;
      case "snare":
        if (B) {
          this.projectile(A, B, at, 240, "arrow", "#fff");
          this.frostFx(B, at + 240, 720);
        }
        break;
      case "smite":
        if (B) {
          // A beam of light that comes down onto the target and STOPS at the top of its head — it marks the hero without hiding it.
          this.add({
            t0: at, dur: 380, layer: "air",
            draw: (ctx, k) => {
              const p = this.unitScreen(B);
              // A short shaft that DROPS onto the head (it does not stand over the stage as a column): it falls in the first quarter, then fades.
              const bottom = p.y - (this.headTop(B) + 2) * p.s;
              const len = 70 * p.s;
              const drop = this.reducedMotion ? 1 : Math.min(1, k * 4);
              const top = bottom - len * drop;
              ctx.save();
              ctx.globalAlpha = (1 - k) * 0.8;
              const g = ctx.createLinearGradient(0, bottom - len, 0, bottom);
              g.addColorStop(0, "rgba(255,244,196,0)");
              g.addColorStop(1, "rgba(255,244,196,0.95)");
              ctx.fillStyle = g;
              const w = 6 * (1 - k * 0.4) * p.s;
              ctx.fillRect(p.x - w / 2, top, w, bottom - top);
              ctx.restore();
            },
          });
          this.sparks(B, at + 60, "#fff0b0", 9, this.headTop(B) + 2);
        }
        break;
      case "shield":
        A.shieldAt = at;
        break;
      case "heal":
        this.risingMarks(A, at, "#7dffb2", "+");
        this.motes(A, at, "#9dffc6");
        break;
      case "dash":
        break; // the DASH event leaves the afterimages
      default:
        this.risingMarks(A, at, "#ffe08a", "✦");
        break;
    }
  }

  private risingMarks(U: UnitState, at: number, color: string, glyph: string, n = 4): void {
    this.add({
      t0: at, dur: 800, layer: "air",
      draw: (ctx, k) => {
        const p = this.unitScreen(U);
        ctx.save();
        ctx.font = `${Math.round(16 * this.textScale())}px ${this.displayFont}`;
        ctx.textAlign = "center";
        ctx.fillStyle = color;
        ctx.strokeStyle = "rgba(6,8,12,0.8)";
        ctx.lineWidth = 3;
        ctx.globalAlpha = 1 - k;
        for (let i = 0; i < n; i++) {
          const at = this.fitText(p.x + (i - (n - 1) / 2) * 16 * p.s, p.y - 30 * p.s - k * 56 - i * 6, 12 * this.textScale(), 16 * this.textScale());
          ctx.strokeText(glyph, at.x, at.y);
          ctx.fillText(glyph, at.x, at.y);
        }
        ctx.restore();
      },
    });
  }

  /** Vector-fallback heroes only (a sprite hero leaves afterimages instead). */
  private dashTrail(U: UnitState, at: number): void {
    const x0 = U.x;
    const y0 = U.y;
    this.add({
      t0: at, dur: 320, layer: "ground",
      draw: (ctx, k) => {
        const a = this.worldToScreen(x0, y0);
        const b = this.unitScreen(U);
        ctx.save();
        ctx.globalAlpha = (1 - k) * 0.6;
        ctx.strokeStyle = "#cfe6ff";
        ctx.lineWidth = 10 * (1 - k);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - 40 * a.s);
        ctx.lineTo(b.x, b.y - 40 * b.s);
        ctx.stroke();
        ctx.restore();
      },
    });
  }

  /** A knock-out: a few sparks and a short "KO" where the hero stood, then dust as the body hits the floor (the KO clip). No ring. */
  private eliminationBurst(U: UnitState, at: number): void {
    const x = U.x;
    const y = U.y;
    this.sparks(U, at, "#ff8a5c", 8);
    this.dust(x, y, at + 330, 8, 1.4);
    this.add({
      t0: at, dur: 700, layer: "air",
      draw: (ctx, k) => {
        const p = this.worldToScreen(x, y);
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - k * 1.3);
        ctx.font = `${Math.round(26 * this.textScale())}px ${this.displayFont}`;
        ctx.textAlign = "center";
        ctx.fillStyle = "#ff5a4d";
        ctx.strokeStyle = "#0c0f15";
        ctx.lineWidth = 5;
        const fit = this.fitText(p.x, p.y - (this.headTop(U) + 4) * p.s - (this.reducedMotion ? 0 : k * 22), ctx.measureText("KO").width + 4, 26 * this.textScale());
        ctx.strokeText("KO", fit.x, fit.y);
        ctx.fillText("KO", fit.x, fit.y);
        ctx.restore();
      },
    });
  }

  private textScale(): number {
    return clamp(this.layout.w / Math.max(320, this.cssW) * 0.62, 0.78, 1.7);
  }

  // ---------------------------------------------------------------- drawing
  /**
   * Draws one frame at server instant `now` and returns the phase it drew — the HUD reads THAT, so the page and the canvas can never disagree
   * about whether the fight has started. The 3 · 2 · 1 and FIGHT! are drawn here, in the same frame as the fight itself.
   */
  render(now: number, timing: StageTiming, dtMs: number): PhaseNow {
    const frame = this.playback.frame(this.battle, this.replay, now, timing);
    const ph: PhaseNow = frame?.clock ?? { phase: "IDLE", countdown: null, sinceStart: 0, combatMs: 0, combatLeftMs: timing.maxCombatMs };
    const decided = ph.phase === "VICTORY" || ph.phase === "RESULTS" || ph.phase === "DONE";
    const clock: RenderClock = { now, phase: ph.phase, sinceStart: ph.sinceStart, combatMs: ph.combatMs, winnerSlot: decided && this.replay ? (this.replay.ranking[0] ?? null) : null };
    if (frame) {
      this.updateUnits(frame, clock, dtMs);
      this.updateSpacing(frame, dtMs);
      this.processEvents(frame, now);
    }
    this.draw(clock, dtMs);
    this.drawStageCall(ph, now, timing);
    return ph;
  }

  private draw(clock: RenderClock, dtMs: number): void {
    const ctx = this.ctx;
    const L = this.layout;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.ensureBackground(), 0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform((this.canvas.width / L.w), 0, 0, (this.canvas.height / L.h), 0, 0);

    // Flicker on the overhead lights keeps the hall alive even in idle moments.
    const flick = 0.04 + Math.sin(clock.now / 420) * 0.015;
    ctx.fillStyle = `rgba(202,148,249,${flick})`;
    ctx.fillRect(0, 0, L.w, L.standsH);

    const now = clock.now;
    for (const f of this.fx) if (f.layer === "ground") this.drawFx(ctx, f, now);

    const order = this.units.slice().sort((a, b) => a.y - b.y);
    // Every contact shadow first, so a hero in front never darkens the feet of the one behind it.
    for (const u of order) this.drawShadow(ctx, u, clock);
    for (const u of order) this.drawUnit(ctx, u, clock);

    this.drawPlates(ctx, clock, dtMs);
    this.feetRects.length = 0;
    // Numbers, shots and skill effects over the plates: a damage number is never hidden under a name.
    for (const f of this.fx) if (f.layer === "air") this.drawFx(ctx, f, now);
    this.fx = this.fx.filter((f) => now - f.t0 < f.dur + 50);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.warmSheets(clock, dtMs);
  }

  /**
   * The clips a hero will need in the fight, composed AHEAD of it while the eight stand idle (intro, 3 · 2 · 1), so a slow phone never composes
   * a hero's first swing, hit or fall in the middle of the fight. Clip by clip across ALL heroes (everyone's walk before anyone's victory),
   * within a small time budget per display frame: a composed set builds one strip per frame; a procedural set (v3) generates the frames that fit
   * its budget (this device's measured cost per frame) — at least one per display frame before the bell, and during the fight only what fits,
   * never on a display frame that is already late. Presentation only — what is drawn, and when, is unchanged; a frame not warmed in time is
   * generated on first use.
   */
  private warmSheets(clock: RenderClock, dtMs: number): void {
    if (!this.sprites) return;
    const pre = isPreFight(clock.phase);
    const procedural = Boolean(this.sprites.procedural);
    if (!pre && !(procedural && clock.phase === "COMBAT")) return;
    if (procedural && dtMs > LATE_FRAME_MS) return; // behind already: add nothing to this frame
    const m = this.sprites.manifest;
    const until = performance.now() + (pre ? WARM_BUDGET_MS : WARM_BUDGET_FIGHT_MS);
    let force = pre;
    const order = ["idle", "move", "attack", "skill", "hit", "run", "ko", "block", "turn", "victory"] as const;
    for (const slot of order) {
      for (const u of this.units) {
        const sheet = this.sheetFor(u);
        if (!sheet) continue;
        const clip = slot === "idle" ? sheet.plan.idleClip : slot === "attack" ? sheet.plan.attackClip : slot;
        if (!m.clips[clip] || sheet.isComposed(clip)) continue;
        if (!sheet.warm(clip, until, force)) return;
        force = false;
      }
    }
  }

  /**
   * The 3 · 2 · 1 and FIGHT!, drawn on the canvas in the SAME frame as the fight — so the countdown can never still be on screen while combat
   * plays (a DOM overlay is committed by React a frame or more later). Each digit pops in and settles; under reduced motion it simply fades.
   */
  private drawStageCall(ph: PhaseNow, now: number, timing: StageTiming): void {
    const b = this.battle;
    if (!b || b.combatStartsAt === null) return;
    let text: string | null = null;
    let k = 0; // 0..1 through the digit / banner
    if (ph.phase === "COUNTDOWN" && ph.countdown !== null) {
      const digitMs = Math.max(1, timing.countdownMs / 3);
      const left = b.combatStartsAt - now; // ms until the bell
      k = clamp(1 - (left - (ph.countdown - 1) * digitMs) / digitMs, 0, 1);
      text = String(ph.countdown);
    } else if (ph.phase === "COMBAT" && ph.combatMs < 850) {
      k = ph.combatMs / 850;
      text = "FIGHT!";
    }
    if (text === null) return;
    const ctx = this.ctx;
    const L = this.layout;
    ctx.setTransform(this.canvas.width / L.w, 0, 0, this.canvas.height / L.h, 0, 0);
    const fight = text === "FIGHT!";
    // Pop in (0 → 18 %), hold, then ease out — FIGHT! lingers a little and leaves upward.
    const appear = this.reducedMotion ? 1 : clamp(k / 0.18, 0, 1);
    const scale = this.reducedMotion ? 1 : fight ? 0.85 + 0.25 * Math.min(1, k * 3) : 1.9 - 0.9 * easeOutBack(appear);
    const alpha = k < 0.18 ? appear : k > (fight ? 0.6 : 0.82) ? clamp(1 - (k - (fight ? 0.6 : 0.82)) / (fight ? 0.4 : 0.18), 0, 1) : 1;
    const size = (fight ? 0.16 : 0.27) * L.h;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(L.cx, L.h * (fight ? 0.42 : 0.44) - (fight && !this.reducedMotion ? k * 10 : 0));
    ctx.scale(scale, scale);
    ctx.font = `${Math.round(size)}px ${this.displayFont}, ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.fillStyle = "#4d2d87"; // the drop face (the same treatment as the page's display type)
    ctx.fillText(text, 0, size * 0.06);
    ctx.lineWidth = size * 0.06;
    ctx.strokeStyle = "rgba(10,8,20,0.9)";
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = fight ? "#e8d5ff" : "#ca94f9";
    ctx.fillText(text, 0, 0);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawFx(ctx: CanvasRenderingContext2D, f: Fx, now: number): void {
    const k = (now - f.t0) / f.dur;
    if (k < 0 || k > 1) return;
    f.draw(ctx, k, now);
  }

  private poseFor(u: UnitState, clock: RenderClock): HeroPose {
    const now = clock.now;
    const sinceAttack = now - u.attackAt;
    const sinceCast = now - u.castAt;
    const sinceHurt = now - u.hurtAt;
    const dead = u.deadAt >= 0 ? clamp((now - u.deadAt) / 900, 0, 1) : 0;
    return {
      t: now / 1000 + u.slot * 0.37,
      moving: u.moving && u.alive,
      attack: sinceAttack >= 0 && sinceAttack < 260 ? sinceAttack / 260 : -1,
      cast: sinceCast >= 0 && sinceCast < 480 ? sinceCast / 480 : -1,
      hurt: sinceHurt >= 0 && sinceHurt < 220 ? 1 - sinceHurt / 220 : 0,
      dead,
      facing: u.facing,
      victory: (clock.phase === "VICTORY" || clock.phase === "RESULTS" || clock.phase === "DONE") && clock.winnerSlot === u.slot && u.alive,
      chill: (u.flags & FRAME_FLAG.SLOWED) !== 0 && u.alive,
      ground: false,
    };
  }

  /** Intro drop-in for a unit: how high above the floor it still is, and how visible. */
  private dropIn(u: UnitState, clock: RenderClock): { lift: number; alpha: number } {
    if (clock.phase !== "INTRO" || this.reducedMotion) return { lift: 0, alpha: 1 };
    const local = clock.sinceStart - u.slot * 85;
    const k = clamp(local / 650, 0, 1);
    return { lift: (1 - easeOutBack(k)) * 300, alpha: clamp(local / 180, 0, 1) };
  }

  /** How visible a fallen hero still is: the KO clip plays, the body lies for a moment, then fades. */
  private koFade(u: UnitState, now: number): number {
    if (u.alive || u.deadAt < 0) return 1;
    return 1 - clamp((now - u.deadAt - 1000) / 700, 0, 1);
  }

  /** One small contact shadow on the floor under the feet — it stays on the ground while a hero drops in, and shrinks the higher it is. */
  private drawShadow(ctx: CanvasRenderingContext2D, u: UnitState, clock: RenderClock): void {
    const { lift, alpha } = this.dropIn(u, clock);
    const a = alpha * this.koFade(u, clock.now);
    if (a <= 0) return;
    const p = this.unitScreen(u);
    const air = clamp(lift / 300, 0, 1);
    const fallen = !u.alive && u.deadAt >= 0 ? clamp((clock.now - u.deadAt) / 600, 0, 1) : 0;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(p.s * (1 - air * 0.45), p.s * (1 - air * 0.45));
    ctx.fillStyle = "#000";
    ctx.globalAlpha = a * 0.3 * (1 - air * 0.6);
    ctx.beginPath();
    ctx.ellipse(0, 0, 16 + fallen * 12, 4.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = a * 0.22 * (1 - air);
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawUnit(ctx: CanvasRenderingContext2D, u: UnitState, clock: RenderClock): void {
    const p = this.unitScreen(u);
    const { lift, alpha } = this.dropIn(u, clock);
    if (clock.phase === "INTRO" && !this.reducedMotion && lift <= 0.5 && !u.landed && alpha > 0) {
      u.landed = true;
      this.dust(u.x, u.y, clock.now, 6, 1);
    }
    if (alpha <= 0) return;
    // A blow knocks the hero back a few units (presentation only — the position itself is the server's).
    const sinceHurt = clock.now - u.hurtAt;
    const recoil = !this.reducedMotion && u.alive && sinceHurt >= 0 && sinceHurt < 160 ? u.hurtDir * 3.2 * (1 - sinceHurt / 160) : 0;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.x + recoil * p.s, p.y - lift);
    ctx.scale(p.s, p.s);
    const sheet = this.sheetFor(u);
    // its skeleton's atlas page is still on its way (asked for when the battle was set): nothing yet, rather than the vector hero for a moment
    let drawn = Boolean(sheet?.pending);
    if (sheet && this.sprites && !drawn) {
      const sd = this.spriteDraw(u, clock, sheet);
      if (!sd) drawn = true; // fallen and faded out
      else {
        this.drawAfterimages(ctx, u, clock, sheet, sd, p);
        drawn = drawHeroSprite(ctx, this.sprites, sheet, sd, STAGE_HERO_HEIGHT);
      }
    }
    if (!drawn) {
      ctx.save();
      ctx.scale(STAGE_K, STAGE_K);
      drawHero(ctx, u.look, this.poseFor(u, clock));
      ctx.restore();
    }
    if (u.alive) this.drawStatus(ctx, u, clock.now);
    ctx.restore();
  }

  /** The status a hero is under, drawn ON it (hero units, feet at the origin) — from the verified frame flags. */
  private drawStatus(ctx: CanvasRenderingContext2D, u: UnitState, now: number): void {
    const f = u.flags;
    const top = this.headTop(u);
    if (f & FRAME_FLAG.SLOWED) this.drawFrost(ctx, now, u.slot);
    if (f & (FRAME_FLAG.BUFFED | FRAME_FLAG.EMPOWERED)) {
      // small chevrons rising beside the body (gold: buffed, ember: empowered)
      ctx.save();
      ctx.strokeStyle = f & FRAME_FLAG.EMPOWERED ? "#ff9a5a" : "#ffd98a";
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 0; i < 3; i++) {
        const k = this.reducedMotion ? 0.45 + i * 0.12 : (now / 1000 + i / 3 + u.slot * 0.17) % 1;
        const x = i === 0 ? -20 : i === 1 ? 19 : -7;
        const y = -12 - k * top * 0.62;
        ctx.globalAlpha = Math.sin(k * Math.PI) * 0.9;
        ctx.beginPath();
        ctx.moveTo(x - 3.6, y + 2.6);
        ctx.lineTo(x, y - 1);
        ctx.lineTo(x + 3.6, y + 2.6);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (f & FRAME_FLAG.STUNNED) {
      // three small stars circling over the head
      ctx.save();
      ctx.fillStyle = "#ffd04a";
      ctx.strokeStyle = "rgba(40,28,6,0.9)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const a = (this.reducedMotion ? 0.6 : now / 220) + (i * Math.PI * 2) / 3;
        const cx = Math.cos(a) * 14;
        const cy = -(top + 6) + Math.sin(a) * 3.5;
        ctx.globalAlpha = Math.sin(a) < -0.3 ? 0.6 : 1;
        ctx.beginPath();
        for (let j = 0; j < 8; j++) {
          const r = j % 2 ? 1.4 : 3.8;
          const b = (j / 8) * Math.PI * 2 - Math.PI / 2;
          ctx.lineTo(cx + Math.cos(b) * r, cy + Math.sin(b) * r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
    if (f & FRAME_FLAG.TAUNTED) {
      // a small red mark beside the head: "drawn to the Tank"
      ctx.save();
      const bob = this.reducedMotion ? 0 : Math.sin(now / 160 + u.slot) * 1.5;
      ctx.font = `700 17px ${this.displayFont}, ${this.fontFamily}`;
      ctx.textAlign = "center";
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(20,6,6,0.9)";
      ctx.fillStyle = "#ff6a5a";
      ctx.strokeText("!", u.facing * -15, -(top - 2) + bob);
      ctx.fillText("!", u.facing * -15, -(top - 2) + bob);
      ctx.restore();
    }
  }

  /** The composed sprite for a unit, or null when the vector fallback should draw it. */
  private sheetFor(u: UnitState): HeroSheet | null {
    const src = this.sprites;
    if (!src) return null;
    if (u.sheetSrc !== src) {
      u.sheetSrc = src;
      u.sheet = getHeroSheet(src, u.look.sprite, u.look.colors, u.look.rarity);
    }
    return u.sheet && !u.sheet.needsFallback ? u.sheet : null;
  }

  /** The top of a hero's head (a hat or crest included), in hero units above its feet. */
  private headTop(u: UnitState): number {
    const src = this.sprites;
    const sheet = this.sheetFor(u);
    if (!src || !sheet) return 112 * STAGE_K;
    return ((src.manifest.anchor.y - sheet.topPx()) / src.manifest.nominalHeightPx) * STAGE_HERO_HEIGHT;
  }

  /** ms since the bell, unclamped (after the fight the last clips finish and the heroes return to idle), or -1 before it. */
  private sinceBell(clock: RenderClock): number {
    const b = this.battle;
    if (isPreFight(clock.phase) || !b || b.combatStartsAt === null) return -1;
    return clock.now - b.combatStartsAt;
  }

  /** What a sprite hero shows this frame, or null when the fall-and-fade after a knock-out is over. */
  private spriteDraw(u: UnitState, clock: RenderClock, sheet: HeroSheet): SpriteDraw | null {
    const src = this.sprites;
    if (!src) return null;
    const now = clock.now;
    const m = src.manifest;
    const sinceKo = u.deadAt >= 0 ? now - u.deadAt : null;
    const fade = this.koFade(u, now);
    if (fade <= 0) return null;
    // The attack / cast clip is timed so its impact frame is on screen at the server's event (actionClock.ts). Only the verified replay of THIS
    // battle drives it, and nothing before the bell.
    const t = this.replay?.battleId === this.battle?.id ? this.times.get(u.slot) : undefined;
    const bell = this.sinceBell(clock);
    const sinceAttackMs = t && bell >= 0 ? sinceClipStart(t.attacks, bell, impactLeadMs(m.clips[resolveClip(m, sheet.plan.attackClip)])) : Infinity;
    const sinceSkillMs = t && bell >= 0 ? sinceClipStart(t.skills, bell, impactLeadMs(m.clips.skill)) : Infinity;
    const backpedal = u.moving && Math.abs(u.vx) > 10 && Math.sign(u.vx) === -u.facing;
    // a facing flip starts the `turn` clip (sets that draw one) — never before the bell, never on the first draw
    if (u.drawnFacing !== u.facing) {
      if (u.drawnFacing !== 0 && bell >= 0 && u.alive) u.turnAt = now;
      u.drawnFacing = u.facing;
    }
    const input: AnimInput = {
      alive: u.alive,
      moving: u.moving && u.alive,
      victory: (clock.phase === "VICTORY" || clock.phase === "RESULTS" || clock.phase === "DONE") && clock.winnerSlot === u.slot && u.alive,
      stunned: (u.flags & FRAME_FLAG.STUNNED) !== 0 && u.alive,
      sinceAttackMs,
      sinceSkillMs,
      sinceHurtMs: now - u.hurtAt,
      sinceKoMs: sinceKo,
      loopClockMs: now + u.slot * 137, // de-synchronise idle loops between heroes
      moveClockMs: u.moveClock,
      backpedal,
      speed: u.running ? Math.max(u.speed, RUN_SPEED) : Math.min(u.speed, RUN_SPEED - 1),
      sinceBlockMs: bell >= 0 ? now - u.blockAt : Infinity,
      sinceTurnMs: bell >= 0 ? now - u.turnAt : Infinity,
    };
    const sinceFlash = now - u.flashAt;
    const sinceShield = now - u.shieldAt;
    const shieldFlash = sinceShield >= 0 && sinceShield < 450 ? 1 - sinceShield / 450 : 0;
    const shield = u.alive ? Math.max((u.flags & FRAME_FLAG.SHIELDED) !== 0 ? 0.7 : 0, shieldFlash) : 0;
    return {
      playback: playbackFor(sheet, src, input),
      direction: u.facing === 1 ? "right" : "left",
      // A BLINK (≈ 4 frames), not a state: long or strong white made a hit hero — or two caught by one area spell — read as a see-through ghost.
      flash: sinceFlash >= 0 && sinceFlash < 60 ? 0.6 * (1 - sinceFlash / 60) : 0,
      chill: (u.flags & FRAME_FLAG.SLOWED) !== 0 && u.alive,
      shield,
      shieldPhase: this.reducedMotion ? 0.5 : ((now / 1300 + u.slot * 0.29) % 1),
      alpha: fade,
    };
  }

  /**
   * A dash leaves three fading, cool-tinted afterimages of the hero along its path — BEHIND it, never on top of it (no streak, no ring). A dash
   * too short to leave the hero's own outline draws none: overlapping copies would only smear the hero.
   */
  private drawAfterimages(ctx: CanvasRenderingContext2D, u: UnitState, clock: RenderClock, sheet: HeroSheet, sd: SpriteDraw, p: { x: number; y: number; s: number }): void {
    const since = clock.now - u.dashAt;
    if (this.reducedMotion || !this.sprites || since < 0 || since > 280) return;
    const from = this.worldToScreen(u.dashFrom[0], u.dashFrom[1]);
    const dx = (from.x - p.x) / p.s;
    const dy = (from.y - p.y) / p.s;
    const len = Math.hypot(dx, dy);
    if (len < 34) return; // in hero units: about a body width
    const fade = 1 - since / 280;
    for (const [t, a] of [[1, 0.1], [0.72, 0.15], [0.44, 0.2]] as const) {
      if (len * t < 26) continue; // a ghost must sit clear of the hero itself
      ctx.save();
      ctx.translate(dx * t, dy * t);
      drawHeroSprite(ctx, this.sprites, sheet, { ...sd, flash: 0, shield: 0, chill: true, alpha: (sd.alpha ?? 1) * a * fade }, STAGE_HERO_HEIGHT);
      ctx.restore();
    }
  }

  /** Measured text widths by font + text: plates are laid out every frame, and measureText is not free on a phone. */
  private readonly widths = new Map<string, number>();
  private textWidth(ctx: CanvasRenderingContext2D, font: string, text: string): number {
    const key = `${font}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      if (this.widths.size > 400) this.widths.clear();
      ctx.font = font;
      w = ctx.measureText(text).width;
      this.widths.set(key, w);
    }
    return w;
  }
  /** Feet labels placed this frame (so labels of neighbouring heroes never overlap). */
  private readonly feetRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  private readonly tagNames = new Map<string, string>();
  /** Name-tag text, memoised (the label is drawn every frame, and grapheme segmentation + measuring are not free). */
  private tagName(ctx: CanvasRenderingContext2D, name: string, maxChars: number, maxWidth: number, font: string): string {
    const key = `${maxChars}|${Math.round(maxWidth)}|${font}|${name}`;
    let out = this.tagNames.get(key);
    if (out === undefined) {
      if (this.tagNames.size > 200) this.tagNames.clear();
      out = fitPlateName(name, maxChars, maxWidth, (t) => this.textWidth(ctx, font, t));
      this.tagNames.set(key, out);
    }
    return out;
  }

  // ---------------------------------------------------------------- kill feed
  /** The last two eliminations, drawn on the stage itself (top-right) so they share the plates' geometry: a plate steps around them and the floating "KO" is drawn OVER them. */
  private feed: Array<{ id: string; killer: string | null; victim: string; t0: number }> = [];

  /** An elimination to announce on the stage. Shown ~4 s; at most two lines (the newest replaces the oldest). Idempotent per `id`. */
  feedKill(id: string, killer: string | null, victim: string, now: number): void {
    if (this.feed.some((l) => l.id === id)) return;
    this.feed.push({ id, killer, victim, t0: now });
    if (this.feed.length > 2) this.feed.shift();
  }

  /** Where each live feed line sits this frame (layout units), already fitted to the stage — also the boxes plates must stay out of. */
  private feedBoxes(ctx: CanvasRenderingContext2D, now: number): Array<{ rect: Rect; text: string; alpha: number; dy: number }> {
    if (this.feed.length === 0) return [];
    this.feed = this.feed.filter((l) => now - l.t0 < 4200 && now >= l.t0 - 500);
    if (this.feed.length === 0) return [];
    const L = this.layout;
    const m = plateMetrics(this.cssW, L.w);
    const margin = m.u(this.cssW < 480 ? 8 : 12);
    const font = `600 ${m.nameFs}px ${this.fontFamily}`;
    const h = m.nameFs * 1.1 + m.u(9);
    const iconW = m.u(13);
    const maxW = L.w * (this.cssW < 480 ? 0.56 : 0.42);
    const out: Array<{ rect: Rect; text: string; alpha: number; dy: number }> = [];
    let y = margin;
    for (const l of this.feed) {
      // the names are shortened (measured, with an ellipsis) until the whole line fits its box — never clipped by the stage's edge
      let chars = this.cssW < 400 ? 10 : ARENA_LABEL_MAX;
      let text = "";
      let w = 0;
      for (; chars >= 3; chars--) {
        const k = l.killer === null ? null : this.tagName(ctx, l.killer, chars, 1e9, font);
        const v = this.tagName(ctx, l.victim, chars, 1e9, font);
        text = k === null ? `${v} was eliminated` : `${k} eliminated ${v}`;
        w = this.textWidth(ctx, font, text) + iconW + m.u(12);
        if (w <= maxW) break;
      }
      const age = now - l.t0;
      const alpha = age < 3400 ? 1 : clamp(1 - (age - 3400) / 800, 0, 1);
      const dy = this.reducedMotion ? 0 : -m.u(8) * Math.max(0, 1 - age / 160);
      out.push({ rect: { x: L.w - margin - w, y, w, h }, text, alpha, dy });
      y += h + m.u(3);
    }
    return out;
  }

  private drawFeed(ctx: CanvasRenderingContext2D, boxes: ReturnType<ArenaRenderer["feedBoxes"]>): void {
    if (boxes.length === 0) return;
    const m = plateMetrics(this.cssW, this.layout.w);
    for (const b of boxes) {
      const { x, w, h } = b.rect;
      const y = b.rect.y + b.dy;
      ctx.save();
      ctx.globalAlpha = b.alpha;
      ctx.fillStyle = "rgba(6,9,14,0.84)";
      this.rr(ctx, x, y, w, h, m.u(4));
      ctx.fill();
      ctx.strokeStyle = "rgba(255,90,100,0.45)";
      ctx.lineWidth = m.u(1);
      ctx.stroke();
      // the cross, then the line
      const cx = x + m.u(9);
      const cy = y + h / 2;
      const r = m.u(3.2);
      ctx.strokeStyle = "#ff5a64";
      ctx.lineWidth = m.u(1.8);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r);
      ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r);
      ctx.lineTo(cx - r, cy + r);
      ctx.stroke();
      ctx.font = `600 ${m.nameFs}px ${this.fontFamily}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#f1f5fb";
      ctx.fillText(b.text, x + m.u(18), cy + m.u(0.5));
      ctx.restore();
    }
  }

  /** When on, every frame leaves the plates it drew in `plates` (a test / QA hook; off in production, so nothing is allocated per frame). */
  private plateLog: PlateDebug[] | null = null;
  capturePlates(on = true): void {
    this.plateLog = on ? [] : null;
  }
  get plates(): readonly PlateDebug[] {
    return this.plateLog ?? [];
  }
  /** Layout size (units) and the css size of the stage, for converting what `plates` reports. */
  get stage(): { layoutW: number; layoutH: number; cssW: number; cssH: number } {
    return { layoutW: this.layout.w, layoutH: this.layout.h, cssW: this.cssW, cssH: this.cssH };
  }

  // ---------------------------------------------------------------- safe zones and focus
  /** Boxes over the stage that belong to the page (the Survivors plate, the sound button …), in css px from the stage's top-left corner. */
  private reservedCss: Rect[] = [];
  /** …and the same boxes in layout units (rebuilt when the boxes or the stage size change). */
  private reservedLayout: Rect[] | null = null;
  /** The hero the viewer picked: its plate keeps its place and is marked. */
  private focusSlot: number | null = null;

  /**
   * Tells the renderer which parts of the stage the page covers with its own controls, MEASURED from the page (css px, relative to the canvas).
   * Name plates and floating numbers keep clear of them — nothing is drawn where it would be hidden under a button.
   */
  setReserved(rects: readonly Rect[]): void {
    const same = rects.length === this.reservedCss.length && rects.every((r, i) => {
      const q = this.reservedCss[i] as Rect;
      return Math.abs(r.x - q.x) < 0.5 && Math.abs(r.y - q.y) < 0.5 && Math.abs(r.w - q.w) < 0.5 && Math.abs(r.h - q.h) < 0.5;
    });
    if (same) return;
    this.reservedCss = rects.map((r) => ({ ...r }));
    this.reservedLayout = null;
  }

  /** The slot of the hero the viewer picked to win (or null): placed first, so its name never steps aside, and drawn with a gold edge. */
  setFocus(slot: number | null): void {
    this.focusSlot = slot;
  }

  private reserved(): readonly Rect[] {
    if (!this.reservedLayout) {
      const fx = this.layout.w / Math.max(1, this.cssW);
      const fy = this.layout.h / Math.max(1, this.cssH);
      const pad = 2 * fx;
      this.reservedLayout = this.reservedCss.map((r) => ({ x: r.x * fx - pad, y: r.y * fy - pad, w: r.w * fx + 2 * pad, h: r.h * fy + 2 * pad }));
    }
    return this.reservedLayout;
  }

  /** The name plates drawn this frame (bars excluded), in layout units: floating text keeps off them so a number never hides a name. */
  private plateBoxes: Rect[] = [];

  /**
   * Keeps a piece of centred floating text inside the stage, out of the page's reserved boxes (a button) and off the name plates: returns the x
   * (centre) and y (baseline) to draw at. `w` and `h` are the text's width and height in layout units. A text that would sit on something steps to the
   * cheapest free spot — beside it, or just above it. With `memo` (a number that lives ~1 s) the step is remembered: it moves away quickly (~40 ms)
   * and comes back slowly (~110 ms), so a number brushing past a plate never flickers between two places.
   */
  private fitText(x: number, y: number, w: number, h: number, memo?: TextNudge, dtMs = 0): { x: number; y: number } {
    const L = this.layout;
    const m = 3 * (L.w / Math.max(1, this.cssW));
    const cx0 = clamp(x, m + w / 2, L.w - m - w / 2);
    const cy0 = clamp(y, m + h, L.h - m);
    const reserved = this.reserved();
    const plates = this.plateBoxes;
    const hit = (cx: number, cy: number, r: Rect) => cx - w / 2 < r.x + r.w && cx + w / 2 > r.x && cy - h < r.y + r.h && cy > r.y;
    const inStage = (cx: number, cy: number) => cx - w / 2 >= m - 0.01 && cx + w / 2 <= L.w - m + 0.01 && cy - h >= m - 0.01 && cy <= L.h - m + 0.01;
    const blockedBy = (cx: number, cy: number): Rect | undefined => reserved.find((r) => hit(cx, cy, r)) ?? plates.find((r) => hit(cx, cy, r));
    let cx = cx0;
    let cy = cy0;
    for (let pass = 0; pass < 3; pass++) {
      const r = blockedBy(cx, cy);
      if (!r) break;
      // beside the obstacle (either side) or just above it — whichever is free and costs the least movement
      const options = [
        { x: r.x + r.w + m + w / 2, y: cy },
        { x: r.x - m - w / 2, y: cy },
        { x: cx, y: r.y - m },
      ]
        .filter((o) => inStage(o.x, o.y) && !blockedBy(o.x, o.y))
        .sort((a, b) => Math.abs(a.x - cx) + Math.abs(a.y - cy) - (Math.abs(b.x - cx) + Math.abs(b.y - cy)));
      if (options.length === 0) {
        // nowhere free: stay out of the page's own controls at least
        const box = reserved.find((q) => hit(cx, cy, q));
        if (!box) break;
        const right = box.x + box.w + w / 2;
        cx = clamp(right + w / 2 <= L.w - m && (cx - box.x > box.w / 2 || box.x - w / 2 - w / 2 < m) ? right : box.x - w / 2, m + w / 2, L.w - m - w / 2);
        break;
      }
      cx = (options[0] as { x: number; y: number }).x;
      cy = (options[0] as { x: number; y: number }).y;
    }
    if (!memo) return { x: cx, y: cy };
    const tdx = cx - cx0;
    const tdy = cy - cy0;
    if (!memo.set) {
      memo.set = true;
      memo.dx = tdx;
      memo.dy = tdy;
    }
    const away = (t: number, cur: number) => Math.abs(t) > Math.abs(cur) + 0.01 || (t !== 0 && Math.sign(t) !== Math.sign(cur));
    const toward = this.reducedMotion ? 1 : 1 - Math.exp(-dtMs / 110);
    const out = this.reducedMotion ? 1 : 1 - Math.exp(-dtMs / 40);
    memo.dx += (tdx - memo.dx) * (away(tdx, memo.dx) ? out : toward);
    memo.dy += (tdy - memo.dy) * (away(tdy, memo.dy) ? out : toward);
    return { x: clamp(cx0 + memo.dx, m + w / 2, L.w - m - w / 2), y: clamp(cy0 + memo.dy, m + h, L.h - m) };
  }

  // ---------------------------------------------------------------- name plates
  /**
   * NAME PLATES. Each hangs just above its own hero's head (a tall hat included) in EVERY phase and on every screen size: name and HP bar
   * (name, class and HP before and after the fight on a wide stage). The geometry — which plate steps aside for which, which fall back to a
   * bare name — lives in nameplates.ts; this decides what each plate says, feeds it where the heroes are drawn, and paints the result.
   * Names are never scaled below ~10.5 css px; a small stage gets SHORTER names instead (measured, with an ellipsis).
   */
  private drawPlates(ctx: CanvasRenderingContext2D, clock: RenderClock, dtMs: number): void {
    // Over the results the stage sits behind a translucent panel that names the winner and the runner-up: no plates (nor the kill feed) there — text
    // seen through a panel would only read as clipped.
    if (clock.phase === "RESULTS" || clock.phase === "DONE") {
      if (this.plateLog) this.plateLog.length = 0;
      this.plateBoxes.length = 0;
      return;
    }
    const L = this.layout;
    const m = plateMetrics(this.cssW, L.w);
    const margin = m.u(3);
    const phone = this.cssW < 480;
    const want = clock.phase === "COMBAT" || phone ? "compact" : "full";
    const decided = clock.phase === "VICTORY"; // (the results phases returned above)
    const nameFont = `600 ${m.nameFs}px ${this.fontFamily}`;
    const subFont = `700 ${m.subFs}px ${this.fontFamily}`;
    const items: PlateInput[] = [];
    const ends = new Map<number, { dead: number; ay: number; ax: number }>();
    for (const u of this.units) {
      const dead = u.deadAt >= 0 ? clamp((clock.now - u.deadAt) / 700, 0, 1) : 0;
      if (dead >= 1) continue;
      if (clock.phase === "INTRO" && clock.sinceStart - u.slot * 85 < 500) continue;
      const p = this.unitScreen(u);
      const ay = p.y - (this.headTop(u) + PLATE_GAP) * p.s - (u.alive ? 0 : dead * 20);
      ends.set(u.slot, { dead, ay, ax: p.x });
      if (!u.alive) continue; // a fallen hero's plate is no obstacle: it only fades where it stood
      const key = `${this.cssW}|${u.fighter.name}|${u.fighter.title ?? ""}`;
      if (u.plateSizesKey !== key) {
        u.plateSizesKey = key;
        u.plateName = this.tagName(ctx, u.fighter.name, m.maxChars, m.maxNameW, nameFont);
        const nameW = this.textWidth(ctx, nameFont, u.plateName);
        const classW = this.textWidth(ctx, subFont, (u.visual?.name ?? "Hero").toUpperCase());
        // The title (an achievement the member chose to show) hangs above the name in small capitals, shortened like a name when it is long.
        u.plateTitle = u.fighter.title ? this.tagName(ctx, u.fighter.title.toUpperCase(), m.maxChars + 8, m.maxNameW * 1.2, subFont) : "";
        const titleW = u.plateTitle ? this.textWidth(ctx, subFont, u.plateTitle) : 0;
        u.plateSizes = plateSizes(m, nameW, classW, titleW);
      }
      const focus = this.focusSlot === u.slot;
      const winner = decided && clock.winnerSlot === u.slot;
      items.push({ slot: u.slot, ax: p.x, ay, sizes: u.plateSizes as PlateSizes, want, priority: focus || winner ? -1e6 : -ay });
    }
    if (this.plateLog) this.plateLog.length = 0;
    this.plateBoxes.length = 0;
    const snap = this.reducedMotion || isPreFight(clock.phase);
    const feedBoxes = this.feedBoxes(ctx, clock.now);
    // The kill feed is a four-second caption: plates keep out of it when they can, and a name goes over it rather than being dropped to an HP bar.
    // (So the feed is painted BEFORE the plates: where the two meet, the name is on top.)
    const placements = layoutPlates(items, { bounds: { x: margin, y: margin, w: L.w - 2 * margin, h: L.h - 2 * margin }, reserved: this.reserved(), soft: feedBoxes.map((b) => b.rect), gap: m.u(2), immediate: snap, dtMs }, this.plateStates, clock.now);
    this.drawFeed(ctx, feedBoxes);
    for (const pl of placements) {
      const u = this.units.find((x) => x.slot === pl.slot) as UnitState;
      const e = ends.get(pl.slot) as { dead: number; ay: number; ax: number };
      const rect = pl.rect;
      u.plateRect = rect;
      u.plateShown = pl.mode;
      if (pl.mode !== "bar") this.plateBoxes.push(rect);
      // floating numbers rise from above the plate only when the plate is over the head; a plate off to the side leaves the head's own space free
      u.plateTop = e.ax >= rect.x + 4 && e.ax <= rect.x + rect.w - 4 ? rect.y : Number.NaN;
      this.drawPlate(ctx, u, clock, rect, pl.mode, u.plateName, m, 1 - pl.alpha, pl.displaced ? { x: e.ax, y: e.ay } : null);
      this.plateLog?.push({ slot: pl.slot, mode: pl.mode, name: u.plateName, rect, displaced: pl.displaced, key: pl.key, ax: e.ax, ay: e.ay });
    }
    // heroes that have just fallen: their plate stays over the body (no longer an obstacle for the living) and fades
    for (const u of this.units) {
      if (u.alive || !u.plateRect || !u.plateSizes) continue;
      const e = ends.get(u.slot);
      if (!e) continue;
      const sz = u.plateSizes[u.plateShown];
      const x = clamp(e.ax - sz.w / 2, margin, L.w - margin - sz.w);
      const y = clamp(e.ay - sz.h, margin, L.h - margin - sz.h);
      u.plateTop = y;
      this.drawPlate(ctx, u, clock, { x, y, w: sz.w, h: sz.h }, u.plateShown, u.plateName, m, e.dead, null);
    }
  }

  private drawPlate(
    ctx: CanvasRenderingContext2D, u: UnitState, clock: RenderClock, r: Rect, mode: PlateMode, name: string, m: ReturnType<typeof plateMetrics>, fade: number, pointer: { x: number; y: number } | null,
  ): void {
    const { x, y, w, h } = r;
    const { u: px } = m;
    const accent = u.visual?.colors[0] ?? "#8b97ab";
    const rv = rarityVisual(u.fighter.appearance.rarity);
    const decided = clock.phase === "VICTORY" || clock.phase === "RESULTS" || clock.phase === "DONE";
    const gold = u.alive && ((decided && clock.winnerSlot === u.slot) || this.focusSlot === u.slot);
    ctx.save();
    ctx.globalAlpha = 1 - fade;
    if (pointer && mode !== "bar") {
      // a plate that is not straight above its hero points at it: a thin leader from the plate's lower edge to the top of the head
      const sx = clamp(pointer.x, x + px(6), x + w - px(6));
      ctx.strokeStyle = gold ? "#ffd04a" : accent;
      ctx.globalAlpha = (1 - fade) * 0.75;
      ctx.lineWidth = px(1.1);
      ctx.beginPath();
      ctx.moveTo(sx, y + h);
      ctx.lineTo(pointer.x, pointer.y + px(1));
      ctx.stroke();
      ctx.fillStyle = gold ? "#ffd04a" : accent;
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y + px(1), px(1.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1 - fade;
    }
    if (mode === "bar") {
      ctx.fillStyle = "rgba(6,9,14,0.86)";
      this.rr(ctx, x, y, w, h, px(2));
      ctx.fill();
      ctx.fillStyle = u.alive ? accent : "#3a4558";
      ctx.fillRect(x, y, px(2), h);
      this.hpBar(ctx, u, x + px(2.8), y + px(1), w - px(3.8), h - px(2));
      ctx.restore();
      return;
    }
    const nfs = m.nameFs;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    if (mode === "tag") {
      // no box: the name outlined for legibility over whatever it hangs in front of, with a thin HP line under it
      ctx.font = `600 ${nfs}px ${this.fontFamily}`;
      ctx.lineJoin = "round";
      ctx.lineWidth = px(2.8);
      ctx.strokeStyle = "rgba(6,8,12,0.95)";
      const ty = y + nfs * 0.55;
      ctx.strokeText(name, x + w / 2, ty);
      ctx.fillStyle = u.alive ? (gold ? "#ffe08a" : "#f1f5fb") : "#8b97ab";
      ctx.fillText(name, x + w / 2, ty);
      this.hpBar(ctx, u, x + px(1), y + h - px(2.6), w - px(2), px(2.2));
      ctx.restore();
      return;
    }
    // plate
    ctx.fillStyle = "rgba(6,9,14,0.86)";
    this.rr(ctx, x, y, w, h, px(4));
    ctx.fill();
    ctx.strokeStyle = u.alive ? (gold ? "#ffd04a" : accent) : "#3a4558";
    ctx.lineWidth = px(gold ? 1.8 : 1.3);
    ctx.stroke();
    // text sits in the area above the HP bar; the bar is the plate's floor
    let textTop = y + px(2.4);
    const textX = x + (w - px(7)) / 2 + px(0.5);
    if (u.plateTitle && (mode === "full" || m.titleInCompact)) {
      // The hero's chosen title, ABOVE its name: small capitals in gold.
      ctx.font = `700 ${m.subFs}px ${this.fontFamily}`;
      ctx.fillStyle = u.alive ? (gold ? "#ffe08a" : "#e9c46a") : "#6b6454";
      ctx.fillText(u.plateTitle, textX, textTop + m.subFs * 0.6);
      textTop += m.subFs * 1.15;
    }
    ctx.font = `600 ${nfs}px ${this.fontFamily}`;
    ctx.fillStyle = u.alive ? "#f1f5fb" : "#8b97ab";
    ctx.fillText(name, textX, textTop + nfs * 0.55);
    if (mode === "full") {
      // Heroes have no level, so the class (in its accent colour) is the second line.
      ctx.font = `700 ${m.subFs}px ${this.fontFamily}`;
      ctx.fillStyle = u.alive ? accent : "#5d6a7d";
      ctx.fillText((u.visual?.name ?? "Hero").toUpperCase(), textX, textTop + nfs * 1.1 + m.subFs * 0.6);
    }
    // The rarity shows on the plate as an EDGE and a small tier SHAPE (dot · diamond · star · crown) — never as text in the stage.
    if (rv.tier > 0 && u.alive) {
      ctx.save();
      ctx.globalAlpha *= 0.55 + rv.tier * 0.1;
      ctx.strokeStyle = rv.colors.base;
      ctx.lineWidth = px(0.7 + rv.tier * 0.3);
      this.rr(ctx, x + px(1.6), y + px(1.6), w - px(3.2), h - px(3.2), px(3));
      ctx.stroke();
      ctx.restore();
    }
    drawRarityMark(ctx, u.fighter.appearance.rarity, x + w - px(5.6), y + px(5.6), px(2.7));
    this.hpBar(ctx, u, x + px(3), y + h - px(5.6), w - px(6), px(3.4));
    ctx.restore();
  }

  private hpBar(ctx: CanvasRenderingContext2D, u: UnitState, bx: number, by: number, bw: number, bh: number): void {
    ctx.fillStyle = "#1a2029";
    this.rr(ctx, bx, by, bw, bh, 2);
    ctx.fill();
    const fracNow = clamp(u.hpShown / u.maxHp, 0, 1);
    const fracTrail = clamp(u.hpTrail / u.maxHp, 0, 1);
    if (fracTrail > fracNow) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      this.rr(ctx, bx, by, bw * fracTrail, bh, 2);
      ctx.fill();
    }
    ctx.fillStyle = fracNow > 0.5 ? "#5fd38d" : fracNow > 0.25 ? "#f5b94a" : "#ff4d5e";
    if (fracNow > 0) {
      this.rr(ctx, bx, by, Math.max(2, bw * fracNow), bh, 2);
      ctx.fill();
    }
  }

  private rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Live per-fighter status for the DOM roster (eased HP, alive flag). */
  roster(): RosterEntry[] {
    return this.units.map((u) => ({ slot: u.slot, hpFrac: clamp(u.hpShown / u.maxHp, 0, 1), alive: u.alive, kills: u.kills, damage: u.damage, flags: u.flags }));
  }

  /** Called by the UI to spawn celebratory confetti when results appear. */
  celebrate(slot: number | null, now: number): void {
    const u = slot === null ? null : this.units.find((x) => x.slot === slot);
    if (!u || this.reducedMotion) return;
    this.add({
      t0: now, dur: 2400, layer: "air",
      draw: (ctx, k) => {
        const p = this.unitScreen(u);
        ctx.save();
        for (let i = 0; i < 26; i++) {
          const a = (i / 26) * Math.PI * 2 + i * 0.3;
          const sp = 40 + (i % 5) * 18;
          const x = p.x + Math.cos(a) * sp * k * 1.8;
          const y = p.y - 70 * p.s + Math.sin(a) * sp * k * 1.1 + k * k * 120;
          ctx.globalAlpha = 1 - k;
          ctx.fillStyle = ["#ca94f9", "#e8d5ff", "#2ee6c8", "#754cbe"][i % 4] as string;
          ctx.fillRect(x, y, 6, 3);
        }
        ctx.restore();
      },
    });
  }
}
