import { ARENA_LABEL_MAX, truncateDisplayName } from "@/domain/character/displayName";
import { EV, EV_FLAG, FRAME_FLAG } from "@/domain/combat/types";
import type { BattleDto, ClassVisual, FighterDto, ReplayDto } from "@/lib/dto";

import { drawHero, HERO_HEIGHT, type HeroLook, type HeroPose } from "@/components/hero/drawHero";
import { lookFor } from "@/components/hero/look";
import { getHeroSheet, type HeroSheet, type SpriteSource } from "@/components/sprites/compositor";
import { drawHeroSprite, playbackFor } from "@/components/sprites/draw";
import type { AnimInput } from "@/domain/sprites/animator";

import { rarityVisual } from "@/domain/hero/rarityVisuals";

import { EventCursor } from "./eventCursor";
import { drawRarityAura, drawRarityGround, drawRarityMark, drawRarityParticles } from "./rarityFx";
import { TALL, WIDE, drawBackground, project, type Layout } from "./scene";

/**
 * Canvas renderer for the Global Arena. It is a pure PLAYER of server-computed data:
 * positions, HP and every event come from the verified replay; the browser never decides who
 * wins. Fixed camera, all eight fighters always on screen.
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
  moving: boolean;
  landed: boolean;
  /** Composed spritesheet hero (null until a sprite set is ready, or when the set cannot draw this hero). */
  sheet: HeroSheet | null;
  sheetSrc: SpriteSource | null;
  /** Live spectator stats, accumulated from the verified event log as playback passes each event. */
  damage: number;
  kills: number;
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

export interface ArenaEventOut {
  type: "ELIM";
  victim: number;
  killer: number | null;
}

const easeOutBack = (t: number) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class ArenaRenderer {
  private ctx: CanvasRenderingContext2D;
  private layout: Layout = WIDE;
  private bg: HTMLCanvasElement | null = null;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private units: UnitState[] = [];
  private fx: Fx[] = [];
  private battleId: string | null = null;
  private replay: ReplayDto | null = null;
  private readonly cursor = new EventCursor();
  private classes: Record<string, ClassVisual> = {};
  private fontFamily = "sans-serif";
  private displayFont = "sans-serif";
  private R = 300;
  private reducedMotion = false;
  private sprites: SpriteSource | null = null;
  private statIdx = 0;
  private lastStatMs = 0;
  onEvent: ((e: ArenaEventOut) => void) | null = null;

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
    this.dpr = Math.min(dpr, 2.5);
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
  }

  /**
   * Accumulates damage dealt / eliminations as playback passes each event. Independent of the
   * visual-effect cursor (which may skip old events when a tab was asleep), so totals stay exact.
   */
  private trackStats(clock: RenderClock): void {
    const r = this.replay;
    if (!r || (clock.phase !== "COMBAT" && clock.phase !== "VICTORY" && clock.phase !== "RESULTS" && clock.phase !== "DONE")) return;
    if (clock.combatMs < this.lastStatMs) {
      this.statIdx = 0;
      for (const u of this.units) {
        u.damage = 0;
        u.kills = 0;
      }
    }
    this.lastStatMs = clock.combatMs;
    while (this.statIdx < r.events.length) {
      const ev = r.events[this.statIdx] as [number, number, number, number, number, number];
      if (ev[0] * r.tickMs > clock.combatMs) break;
      this.statIdx++;
      if (ev[1] === EV.HIT) {
        const a = this.units.find((u) => u.slot === ev[2]);
        if (a) a.damage += ev[4];
      } else if (ev[1] === EV.ELIM && ev[3] >= 0) {
        const k = this.units.find((u) => u.slot === ev[3]);
        if (k) k.kills++;
      }
    }
  }

  /** Install (or clear) the battle being shown. Resets animation state when the battle changes. */
  setBattle(battle: BattleDto | null, replay: ReplayDto | null): void {
    const id = battle?.id ?? null;
    if (id !== this.battleId) {
      this.battleId = id;
      this.fx = [];
      this.cursor.reset();
      this.units = [];
      this.statIdx = 0;
      this.lastStatMs = 0;
      if (battle) {
        this.R = 300;
        this.units = battle.fighters
          .slice()
          .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
          .map((f, i) => {
            const slot = f.slot ?? i;
            const visual = this.classes[f.classId];
            const sp = f.startPosition ?? [0, 0];
            return {
              slot, fighter: f, look: lookFor(f.appearance, visual), visual, x: sp[0], y: sp[1],
              hp: f.maxHp ?? 1, maxHp: f.maxHp ?? 1, hpShown: f.maxHp ?? 1, hpTrail: f.maxHp ?? 1,
              alive: true, flags: FRAME_FLAG.ALIVE, target: 0, attackAt: -1e9, castAt: -1e9, hurtAt: -1e9, deadAt: -1, textAt: -1e9,
              facing: (sp[0] > 0 ? -1 : 1) as 1 | -1, moving: false, landed: false,
              sheet: null, sheetSrc: null, damage: 0, kills: 0,
            };
          });
      }
    }
    if (replay && replay !== this.replay) {
      this.replay = replay;
      this.R = replay.combat.arenaRadius;
      this.cursor.reset();
      this.statIdx = 0;
    } else if (!replay) {
      this.replay = null;
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

  private worldToScreen(wx: number, wy: number) {
    return project(this.layout, wx, wy, this.R);
  }

  private pos(slot: number) {
    const u = this.units.find((x) => x.slot === slot);
    return u ? { u, ...this.worldToScreen(u.x, u.y) } : null;
  }

  // ---------------------------------------------------------------- simulation playback
  private frameState(combatMs: number) {
    const r = this.replay;
    if (!r) return null;
    const n = this.units.length;
    const tf = clamp(combatMs / r.tickMs, 0, r.ticks);
    const i0 = Math.floor(tf);
    const i1 = Math.min(i0 + 1, r.ticks);
    return { r, n, i0, i1, a: tf - i0 };
  }

  private updateUnits(clock: RenderClock, dtMs: number): void {
    const fs = this.frameState(clock.combatMs);
    const playing = fs && (clock.phase === "COMBAT" || clock.phase === "VICTORY" || clock.phase === "RESULTS" || clock.phase === "DONE");
    for (const u of this.units) {
      if (fs && playing) {
        const { r, n, i0, i1, a } = fs;
        const s = r.stride;
        const o0 = i0 * n * s + u.slot * s;
        const o1 = i1 * n * s + u.slot * s;
        const x0 = (r.frames[o0] as number) / 10;
        const y0 = (r.frames[o0 + 1] as number) / 10;
        const x1 = (r.frames[o1] as number) / 10;
        const y1 = (r.frames[o1 + 1] as number) / 10;
        const jump = Math.hypot(x1 - x0, y1 - y0) > 60; // dash: do not slide through other fighters
        const px = u.x;
        const py = u.y;
        u.x = jump ? (a < 0.5 ? x0 : x1) : x0 + (x1 - x0) * a;
        u.y = jump ? (a < 0.5 ? y0 : y1) : y0 + (y1 - y0) * a;
        const speed = Math.hypot(u.x - px, u.y - py) / Math.max(1, dtMs) * 1000;
        u.moving = speed > 14 && !jump;
        u.hp = r.frames[o0 + 2] as number;
        u.flags = r.frames[o0 + 3] as number;
        u.target = r.frames[o0 + 4] as number;
        const wasAlive = u.alive;
        u.alive = (u.flags & FRAME_FLAG.ALIVE) !== 0;
        if (wasAlive && !u.alive && u.deadAt < 0) u.deadAt = clock.now;
        if (!u.alive && u.deadAt < 0) u.deadAt = clock.now - 3000; // joined late: already fallen
        // facing
        const tgt = u.target > 0 ? this.units.find((q) => q.slot === u.target - 1) : null;
        if (tgt && tgt.alive && Math.abs(tgt.x - u.x) > 4) u.facing = tgt.x > u.x ? 1 : -1;
        else if (Math.abs(u.x - px) > 0.05) u.facing = u.x > px ? 1 : -1;
      } else {
        u.moving = false;
        u.flags = FRAME_FLAG.ALIVE;
      }
      // HP bar easing (+ white damage trail)
      const k = 1 - Math.exp(-dtMs / 70);
      u.hpShown += (u.hp - u.hpShown) * k;
      u.hpTrail += (u.hpShown - u.hpTrail) * (1 - Math.exp(-dtMs / 420));
      if (u.hpTrail < u.hpShown) u.hpTrail = u.hpShown;
    }
  }

  private processEvents(clock: RenderClock): void {
    const r = this.replay;
    if (!r || (clock.phase !== "COMBAT" && clock.phase !== "VICTORY")) return;
    const now = clock.now;
    // Joined mid-fight or the tab was asleep: the cursor skips visuals for events older than 700 ms. It never rewinds, so a
    // small backward step of the estimated server clock cannot make an already-shown elimination appear again.
    for (const ev of this.cursor.take(r.events as Array<[number, number, number, number, number, number]>, r.tickMs, clock.combatMs)) {
      this.spawnForEvent(ev, now - (clock.combatMs - ev[0] * r.tickMs));
    }
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
        if (flags & EV_FLAG.PROJECTILE && B) this.projectile(A.slot, B.slot, at, Math.max(120, v * (this.replay?.tickMs ?? 100)), style, cA);
        else if (B) this.slash(A, B, at, cA, A.visual?.body === "heavy", style);
        break;
      }
      case EV.HIT: {
        if (!B) return;
        B.hurtAt = at;
        const crit = (flags & EV_FLAG.CRIT) !== 0;
        this.damageText(B, `${v}`, crit ? "#ffd04a" : (flags & EV_FLAG.AOE) !== 0 ? "#ffb08a" : "#ffffff", crit ? 1.45 : 1, at);
        this.sparks(B, at, crit ? "#ffd04a" : "#ffe9c4", crit ? 12 : 7);
        break;
      }
      case EV.MISS:
        if (B) this.damageText(B, "MISS", "#9aa4b2", 0.8, at);
        break;
      case EV.SKILL: {
        if (!A) return;
        A.castAt = at;
        const info = this.replay?.skillFx[this.replay.skillIds[v] as string];
        this.castRune(A, at, A.visual?.colors[1] ?? "#8ff7e4");
        this.skillFx(info?.fx ?? "buff", A, B ?? null, at);
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
        if (A) this.bubbleFlash(A, at);
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
        if (A) this.dashTrail(A, at);
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

  private slash(A: UnitState, B: UnitState, at: number, color: string, big: boolean, style = "slash"): void {
    const ang = Math.atan2((B.y - A.y) * 0.55, B.x - A.x);
    if (style === "stab") {
      // quick double thrust streak (daggers)
      const dir = B.x >= A.x ? 1 : -1;
      this.add({
        t0: at, dur: 170, layer: "air",
        draw: (ctx, k) => {
          const p = this.worldToScreen(A.x, A.y);
          ctx.save();
          ctx.translate(p.x, p.y - 44 * p.s);
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = color;
          ctx.lineCap = "round";
          ctx.shadowColor = color;
          ctx.shadowBlur = 8;
          for (const off of [-4, 4]) {
            ctx.lineWidth = 2.8 * (1 - k * 0.5);
            ctx.beginPath();
            ctx.moveTo(dir * (14 + k * 8) * p.s, off * p.s * 0.7);
            ctx.lineTo(dir * (36 + k * 14) * p.s, off * p.s * 0.2);
            ctx.stroke();
          }
          ctx.restore();
        },
      });
      return;
    }
    this.add({
      t0: at, dur: big ? 260 : 190, layer: "air",
      draw: (ctx, k) => {
        const p = this.worldToScreen(A.x, A.y);
        const reach = 44 * p.s;
        ctx.save();
        ctx.translate(p.x + Math.cos(ang) * 10 * p.s, p.y - 50 * p.s + Math.sin(ang) * 6);
        ctx.rotate(ang);
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = color;
        ctx.lineWidth = (big ? 8 : 5) * (1 - k * 0.6);
        ctx.lineCap = "round";
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(0, 0, reach, -1.0 + k * 0.5, 0.9 + k * 0.7);
        ctx.stroke();
        ctx.restore();
      },
    });
  }

  private projectile(from: number, to: number, at: number, dur: number, style: string, color: string): void {
    this.add({
      t0: at, dur, layer: "air",
      draw: (ctx, k) => {
        const a = this.pos(from);
        const b = this.pos(to);
        if (!a || !b) return;
        const ax = a.x;
        const ay = a.y - 52 * a.s;
        const bx = b.x;
        const by = b.y - 46 * b.s;
        const x = ax + (bx - ax) * k;
        const y = ay + (by - ay) * k - Math.sin(k * Math.PI) * 16;
        const ang = Math.atan2(by - ay, bx - ax);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        if (style === "arrow") {
          ctx.strokeStyle = "#e9e2d0";
          ctx.lineWidth = 2.6;
          ctx.beginPath();
          ctx.moveTo(-16, 0);
          ctx.lineTo(8, 0);
          ctx.stroke();
          ctx.fillStyle = "#dfe6f2";
          ctx.beginPath();
          ctx.moveTo(8, -4);
          ctx.lineTo(15, 0);
          ctx.lineTo(8, 4);
          ctx.closePath();
          ctx.fill();
        } else if (style === "bolt") {
          // holy bolt: a four-point star with a soft golden trail
          ctx.shadowColor = "#fff0a8";
          ctx.shadowBlur = 14;
          ctx.fillStyle = "#fff6c4";
          ctx.beginPath();
          for (let i = 0; i < 8; i++) {
            const r = i % 2 ? 2.4 : 7.5;
            const a = (i / 8) * Math.PI * 2;
            ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
          }
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 0.45;
          ctx.fillStyle = "#ffd98a";
          ctx.fillRect(-26, -2, 22, 4);
        } else {
          const c = style === "orb" ? "#9d7bff" : color && color !== "#fff" ? color : "#ffe08a";
          ctx.shadowColor = c;
          ctx.shadowBlur = 16;
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(0, 0, style === "orb" ? 7.5 : 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.5;
          ctx.fillRect(-20, -2.5, 18, 5);
        }
        ctx.restore();
      },
    });
  }

  private damageText(U: UnitState, text: string, color: string, scale: number, at: number, dy = 0, anchor: "head" | "feet" = "head"): void {
    const jitter = ((U.slot * 37 + at) % 29) - 14;
    this.add({
      t0: at, dur: 900, layer: "air",
      draw: (ctx, k) => {
        const p = this.worldToScreen(U.x, U.y);
        const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : 1.15 - Math.min(0.15, (k - 0.12) * 0.4);
        const rise = easeOutBack(Math.min(1, k * 1.6)) * 34 + k * 14;
        ctx.save();
        ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
        ctx.font = `${Math.round(19 * scale * pop * this.textScale())}px ${this.displayFont}, ${this.fontFamily}`;
        ctx.textAlign = "center";
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(6,8,12,0.95)";
        ctx.lineJoin = "round";
        const tx = p.x + jitter * (anchor === "feet" ? 0.3 : 1);
        const ty = anchor === "feet" ? p.y + 14 * p.s + k * 10 : p.y - 118 * p.s - rise + dy;
        ctx.strokeText(text, tx, ty);
        ctx.fillStyle = color;
        ctx.fillText(text, tx, ty);
        ctx.restore();
      },
    });
  }

  private sparks(U: UnitState, at: number, color: string, n: number): void {
    const seed = U.slot * 13 + Math.floor(at);
    this.add({
      t0: at, dur: 320, layer: "air",
      draw: (ctx, k) => {
        const p = this.worldToScreen(U.x, U.y);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 2.4;
        ctx.lineCap = "round";
        for (let i = 0; i < n; i++) {
          const a = ((seed + i * 97) % 360) * (Math.PI / 180);
          const r0 = 8 + k * 26;
          const r1 = r0 + 7 * (1 - k);
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(a) * r0 * p.s, p.y - 52 * p.s + Math.sin(a) * r0 * p.s * 0.8);
          ctx.lineTo(p.x + Math.cos(a) * r1 * p.s, p.y - 52 * p.s + Math.sin(a) * r1 * p.s * 0.8);
          ctx.stroke();
        }
        ctx.restore();
      },
    });
  }

  private ring(wx: () => [number, number], r: number, at: number, dur: number, color: string, fill = true): void {
    this.add({
      t0: at, dur, layer: "ground",
      draw: (ctx, k) => {
        const [x, y] = wx();
        const p = this.worldToScreen(x, y);
        const rr = r * (0.2 + 0.8 * Math.min(1, k * 1.25));
        const rx = (rr / this.R) * this.layout.rx;
        const ry = (rr / this.R) * this.layout.ry;
        ctx.save();
        ctx.globalAlpha = (1 - k) * 0.9;
        if (fill) {
          const g = ctx.createRadialGradient(p.x, p.y, rx * 0.2, p.x, p.y, rx);
          g.addColorStop(0, "rgba(255,255,255,0)");
          g.addColorStop(1, color);
          ctx.fillStyle = g;
          ctx.globalAlpha = (1 - k) * 0.5;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = (1 - k) * 0.95;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 4 * (1 - k * 0.6);
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      },
    });
  }

  private skillFx(fx: string, A: UnitState, B: UnitState | null, at: number): void {
    const at0 = () => [A.x, A.y] as [number, number];
    switch (fx) {
      case "cleave":
        this.ring(at0, 64, at, 300, "#ffd98a");
        if (B) this.slash(A, B, at, "#ffe9b8", true);
        break;
      case "nova":
        this.ring(at0, 75, at, 520, "#8fe3ff");
        break;
      case "taunt":
        this.ring(at0, 70, at, 500, "#ff7a6a");
        this.risingMarks(A, at, "#ff7a6a", "!");
        break;
      case "burst":
        if (B) {
          const bx = B.x;
          const by = B.y;
          this.projectile(A.slot, B.slot, at, 280, "orb", "#9d7bff");
          this.ring(() => [bx, by], 58, at + 280, 420, "#b58bff");
        }
        break;
      case "volley":
        if (B) {
          this.projectile(A.slot, B.slot, at, 240, "arrow", "#fff");
          this.projectile(A.slot, B.slot, at + 60, 260, "arrow", "#fff");
          this.projectile(A.slot, B.slot, at + 120, 280, "arrow", "#fff");
        }
        break;
      case "snare":
        if (B) {
          this.projectile(A.slot, B.slot, at, 240, "arrow", "#fff");
          this.ring(() => [B.x, B.y], 36, at + 240, 520, "#8fe3ff");
        }
        break;
      case "smite":
        if (B) {
          this.add({
            t0: at, dur: 380, layer: "air",
            draw: (ctx, k) => {
              const p = this.worldToScreen(B.x, B.y);
              ctx.save();
              ctx.globalAlpha = (1 - k) * 0.9;
              const g = ctx.createLinearGradient(0, p.y - 260, 0, p.y);
              g.addColorStop(0, "rgba(255,244,196,0)");
              g.addColorStop(1, "rgba(255,244,196,0.95)");
              ctx.fillStyle = g;
              const w = 26 * (1 - k * 0.5) * p.s;
              ctx.fillRect(p.x - w / 2, p.y - 260, w, 260);
              ctx.restore();
            },
          });
          this.ring(() => [B.x, B.y], 40, at + 40, 400, "#fff0b0");
        }
        break;
      case "shield":
        this.bubbleFlash(A, at);
        break;
      case "heal":
        this.risingMarks(A, at, "#7dffb2", "+");
        this.ring(at0, 46, at, 480, "#7dffb2");
        break;
      case "dash":
        break;
      default:
        this.risingMarks(A, at, "#ffe08a", "✦");
        break;
    }
  }

  /** A faint rotating rune ring under the caster: makes "this hero just used an ability" readable at a glance. */
  private castRune(U: UnitState, at: number, color: string): void {
    this.add({
      t0: at, dur: 480, layer: "ground",
      draw: (ctx, k) => {
        const p = this.worldToScreen(U.x, U.y);
        const rx = (24 + k * 12) * p.s;
        const ry = (7.5 + k * 3.5) * p.s;
        ctx.save();
        ctx.globalAlpha = (1 - k) * 0.75;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + k * 2.4;
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(a) * rx * 0.86, p.y + Math.sin(a) * ry * 0.86);
          ctx.lineTo(p.x + Math.cos(a) * rx * 1.12, p.y + Math.sin(a) * ry * 1.12);
          ctx.stroke();
        }
        ctx.restore();
      },
    });
  }

  private risingMarks(U: UnitState, at: number, color: string, glyph: string): void {
    this.add({
      t0: at, dur: 800, layer: "air",
      draw: (ctx, k) => {
        const p = this.worldToScreen(U.x, U.y);
        ctx.save();
        ctx.font = `${Math.round(16 * this.textScale())}px ${this.displayFont}`;
        ctx.textAlign = "center";
        ctx.fillStyle = color;
        ctx.globalAlpha = 1 - k;
        for (let i = 0; i < 4; i++) {
          ctx.fillText(glyph, p.x + (i - 1.5) * 16 * p.s, p.y - 30 * p.s - k * 56 - i * 6);
        }
        ctx.restore();
      },
    });
  }

  private bubbleFlash(U: UnitState, at: number): void {
    this.add({
      t0: at, dur: 420, layer: "air",
      draw: (ctx, k) => {
        const p = this.worldToScreen(U.x, U.y);
        ctx.save();
        ctx.globalAlpha = (1 - k) * 0.8;
        ctx.strokeStyle = "#8fe3ff";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y - 50 * p.s, (30 + k * 18) * p.s, (56 + k * 12) * p.s, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      },
    });
  }

  private dashTrail(U: UnitState, at: number): void {
    const x0 = U.x;
    const y0 = U.y;
    this.add({
      t0: at, dur: 320, layer: "ground",
      draw: (ctx, k) => {
        const a = this.worldToScreen(x0, y0);
        const b = this.worldToScreen(U.x, U.y);
        ctx.save();
        ctx.globalAlpha = (1 - k) * 0.7;
        ctx.strokeStyle = "#cfe6ff";
        ctx.lineWidth = 14 * (1 - k);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - 40 * a.s);
        ctx.lineTo(b.x, b.y - 40 * b.s);
        ctx.stroke();
        ctx.restore();
      },
    });
  }

  private eliminationBurst(U: UnitState, at: number): void {
    const x = U.x;
    const y = U.y;
    this.ring(() => [x, y], 56, at, 560, "#ff5a4d");
    this.add({
      t0: at, dur: 700, layer: "air",
      draw: (ctx, k) => {
        const p = this.worldToScreen(x, y);
        ctx.save();
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2 + i;
          const d = (14 + (i % 3) * 14) * Math.sqrt(k) * 3;
          ctx.globalAlpha = 1 - k;
          ctx.fillStyle = i % 2 ? "#ffd98a" : "#ff6a3d";
          ctx.beginPath();
          ctx.arc(p.x + Math.cos(a) * d * p.s, p.y - 46 * p.s + Math.sin(a) * d * p.s * 0.8 - k * 10, (4 - k * 3) * p.s, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = Math.max(0, 1 - k * 1.4);
        ctx.font = `${Math.round(34 * this.textScale())}px ${this.displayFont}`;
        ctx.textAlign = "center";
        ctx.fillStyle = "#ff5a4d";
        ctx.strokeStyle = "#0c0f15";
        ctx.lineWidth = 5;
        ctx.strokeText("KO", p.x, p.y - 100 * p.s - k * 26);
        ctx.fillText("KO", p.x, p.y - 100 * p.s - k * 26);
        ctx.restore();
      },
    });
  }

  private textScale(): number {
    return clamp(this.layout.w / Math.max(320, this.cssW) * 0.62, 0.78, 1.7);
  }

  // ---------------------------------------------------------------- drawing
  render(clock: RenderClock, dtMs: number): void {
    const ctx = this.ctx;
    const L = this.layout;
    this.updateUnits(clock, dtMs);
    this.processEvents(clock);
    this.trackStats(clock);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.ensureBackground(), 0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform((this.canvas.width / L.w), 0, 0, (this.canvas.height / L.h), 0, 0);

    // Flicker on the overhead lights keeps the hall alive even in idle moments.
    const flick = 0.04 + Math.sin(clock.now / 420) * 0.015;
    ctx.fillStyle = `rgba(202,148,249,${flick})`;
    ctx.fillRect(0, 0, L.w, L.standsH);

    const now = clock.now;
    // ground fx
    for (const f of this.fx) if (f.layer === "ground") this.drawFx(ctx, f, now);

    // landing dust (intro)
    const order = this.units.slice().sort((a, b) => a.y - b.y);
    for (const u of order) this.drawUnit(ctx, u, clock);

    for (const f of this.fx) if (f.layer === "air") this.drawFx(ctx, f, now);
    this.fx = this.fx.filter((f) => now - f.t0 < f.dur + 50);

    for (const u of order) this.drawPlate(ctx, u, clock);
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
    };
  }

  private drawUnit(ctx: CanvasRenderingContext2D, u: UnitState, clock: RenderClock): void {
    const p = this.worldToScreen(u.x, u.y);
    let lift = 0;
    let alpha = 1;
    if (clock.phase === "INTRO" && !this.reducedMotion) {
      // Heroes drop into the arena one after another and land in their idle stance.
      const local = clock.sinceStart - u.slot * 85;
      const k = clamp(local / 650, 0, 1);
      lift = (1 - easeOutBack(k)) * 300;
      alpha = clamp(local / 180, 0, 1);
      if (k >= 1 && !u.landed) {
        u.landed = true;
        this.ring(() => [u.x, u.y], 40, clock.now, 420, "rgba(232,213,255,0.9)", false);
      }
    }
    if (alpha <= 0) return;
    // RARITY effects (visual only — drawn after, and independently of, the simulation): a ground ring that stays on the floor while the hero drops in,
    // a glow + outline behind the hero and a few rising particles in front. They fade with the hero when it is knocked out.
    const rarity = u.fighter.appearance.rarity;
    const koFade = u.alive || u.deadAt < 0 ? 1 : 1 - clamp((clock.now - u.deadAt) / 450, 0, 1);
    const fxAlpha = alpha * koFade;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(p.s, p.s);
    drawRarityGround(ctx, rarity, clock.now, u.slot, fxAlpha, this.reducedMotion);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.x, p.y - lift);
    ctx.scale(p.s, p.s);
    drawRarityAura(ctx, rarity, clock.now, u.slot, fxAlpha, this.reducedMotion);
    const sheet = this.sheetFor(u);
    if (!(sheet && this.drawSprite(ctx, u, clock, sheet))) drawHero(ctx, u.look, this.poseFor(u, clock));
    drawRarityParticles(ctx, rarity, clock.now, u.slot, fxAlpha, this.reducedMotion);
    // status halos from the verified frame flags
    if (u.alive) {
      if (u.flags & FRAME_FLAG.SHIELDED) {
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = "#8fe3ff";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(0, -52, 33, 58, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (u.flags & FRAME_FLAG.STUNNED) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#ffd04a";
        for (let i = 0; i < 3; i++) {
          const a = clock.now / 160 + (i * Math.PI * 2) / 3;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * 17, -108 + Math.sin(a) * 5, 3.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
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

  /** Draws a spritesheet hero at the current transform (feet at origin). Returns false to request the fallback. */
  private drawSprite(ctx: CanvasRenderingContext2D, u: UnitState, clock: RenderClock, sheet: HeroSheet): boolean {
    const src = this.sprites;
    if (!src) return false;
    const now = clock.now;
    const sinceKo = u.deadAt >= 0 ? now - u.deadAt : null;
    // KO plays its fall, holds, then fades.
    const fade = sinceKo === null ? 1 : 1 - clamp((sinceKo - 1000) / 700, 0, 1);
    if (fade <= 0) return true;
    const input: AnimInput = {
      alive: u.alive,
      moving: u.moving && u.alive,
      victory: (clock.phase === "VICTORY" || clock.phase === "RESULTS" || clock.phase === "DONE") && clock.winnerSlot === u.slot && u.alive,
      stunned: (u.flags & FRAME_FLAG.STUNNED) !== 0 && u.alive,
      sinceAttackMs: now - u.attackAt,
      sinceSkillMs: now - u.castAt,
      sinceHurtMs: now - u.hurtAt,
      sinceKoMs: sinceKo,
      loopClockMs: now + u.slot * 137, // de-synchronise idle/walk loops between heroes
    };
    // soft ground shadow (not baked into the art, so it stays correct for any set)
    ctx.save();
    ctx.globalAlpha *= 0.38 * fade;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, -1, 25, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const sinceHurt = now - u.hurtAt;
    return drawHeroSprite(
      ctx, src, sheet,
      {
        playback: playbackFor(sheet, src, input),
        direction: u.facing === 1 ? "right" : "left",
        flash: sinceHurt >= 0 && sinceHurt < 200 ? 1 - sinceHurt / 200 : 0,
        chill: (u.flags & FRAME_FLAG.SLOWED) !== 0 && u.alive,
        alpha: fade,
      },
      HERO_HEIGHT,
    );
  }

  private readonly tagNames = new Map<string, string>();
  /** Name-tag text, memoised (the label is drawn every frame, and grapheme segmentation is not free). */
  private tagName(name: string, max: number): string {
    const key = `${max}|${name}`;
    let out = this.tagNames.get(key);
    if (out === undefined) {
      if (this.tagNames.size > 200) this.tagNames.clear();
      out = truncateDisplayName(name, max);
      this.tagNames.set(key, out);
    }
    return out;
  }

  private drawPlate(ctx: CanvasRenderingContext2D, u: UnitState, clock: RenderClock): void {
    const dead = u.deadAt >= 0 ? clamp((clock.now - u.deadAt) / 1400, 0, 1) : 0;
    if (dead >= 1) return;
    if (clock.phase === "INTRO" && clock.sinceStart - u.slot * 85 < 500) return;
    const p = this.worldToScreen(u.x, u.y);
    const L = this.layout;
    const cpl = this.cssW / L.w;
    const pf = clamp(10.2 / (13 * cpl), 0.75, 2.2);
    const fs = 13 * pf;
    const small = this.cssW < 520;
    // Only the DRAWN label is shortened (grapheme-safe: never half an emoji); the hero's stored name is untouched.
    const name = this.tagName(u.fighter.name, small ? 9 : ARENA_LABEL_MAX);
    ctx.save();
    ctx.globalAlpha = 1 - dead;
    // Plate = name / class / HP. Heroes have no level, so the class (in its accent colour) is the second line.
    const classLabel = (u.visual?.name ?? "Hero").toUpperCase();
    const subFs = fs * 0.72;
    ctx.font = `600 ${fs}px ${this.fontFamily}`;
    const nameW = ctx.measureText(name).width;
    ctx.font = `700 ${subFs}px ${this.fontFamily}`;
    const classW = ctx.measureText(classLabel).width;
    const w = Math.max(76 * pf, nameW + 16 * pf, classW + 16 * pf);
    const h = fs + subFs + 15 * pf;
    let x = p.x - w / 2;
    x = clamp(x, 4, L.w - w - 4);
    const y = p.y - 118 * p.s - h - 6 * pf - (u.alive ? 0 : dead * 20);
    const accent = u.visual?.colors[0] ?? "#8b97ab";
    const rv = rarityVisual(u.fighter.appearance.rarity);

    // plate
    ctx.fillStyle = "rgba(6,9,14,0.82)";
    this.rr(ctx, x, y, w, h, 5 * pf);
    ctx.fill();
    ctx.strokeStyle = u.alive ? (clock.winnerSlot === u.slot && clock.phase !== "COMBAT" ? "#ffd04a" : accent) : "#3a4558";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // name
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = `600 ${fs}px ${this.fontFamily}`;
    ctx.fillStyle = u.alive ? "#f1f5fb" : "#8b97ab";
    ctx.fillText(name, x + w / 2, y + 2 * pf + (fs + 3 * pf) / 2 + 0.5);
    // class
    ctx.font = `700 ${subFs}px ${this.fontFamily}`;
    ctx.fillStyle = u.alive ? accent : "#5d6a7d";
    ctx.fillText(classLabel, x + w / 2, y + 2 * pf + (fs + 3 * pf) + (subFs + 1 * pf) / 2 + 0.5);
    // The rarity shows on the plate as an EDGE and a small tier SHAPE (dot · diamond · star · crown) — never as text in the stage.
    if (rv.tier > 0 && u.alive) {
      ctx.save();
      ctx.globalAlpha *= 0.55 + rv.tier * 0.1;
      ctx.strokeStyle = rv.colors.base;
      ctx.lineWidth = 0.7 + rv.tier * 0.35;
      this.rr(ctx, x + 2.2, y + 2.2, w - 4.4, h - 4.4, 3.4 * pf);
      ctx.stroke();
      ctx.restore();
    }
    drawRarityMark(ctx, u.fighter.appearance.rarity, x + w - 7 * pf, y + 7 * pf, 3.2 * pf);
    // HP bar
    const bx = x + 3;
    const by = y + h - 7.5 * pf;
    const bw = w - 6;
    const bh = 4.8 * pf;
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
    ctx.restore();
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
        const p = this.worldToScreen(u.x, u.y);
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

