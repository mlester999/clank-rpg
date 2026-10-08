import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { actionTimes, castTicks, impactLeadMs, sinceClipStart } from "@/components/arena/actionClock";
import { drawHero, IDLE_POSE } from "@/components/hero/drawHero";
import { lookFor } from "@/components/hero/look";
import { rollAppearance } from "@/domain/character/appearance";
import { simulateBattle } from "@/domain/combat/engine";
import { EV, FRAME_FLAG, FRAME_STRIDE, type BattleOutcome } from "@/domain/combat/types";
import { DEFAULT_CLASSES } from "@/domain/content";
import { MAX as SPACING_MAX, updateOffsets, type SpacedUnit } from "@/components/arena/spacing";
import { frameAt, selectPlayback, type AnimInput } from "@/domain/sprites/animator";
import { deriveSpriteConfig } from "@/domain/sprites/config";
import { planLayers } from "@/domain/sprites/plan";
import { parseManifest, type ClipKey } from "@/domain/sprites/spec";
import { createRng } from "@/domain/util/rng";
import { classVisuals } from "@/server/services/views";

import { classIds, makeUnit, ruleset } from "../support/fixtures";

/**
 * ARENA PRESENTATION (hero renderer v2) — what a viewer sees is the server's fight, presented better:
 *   · a blow lands on screen when the server says it lands (the attack / cast clip's impact frame is shown at the event), never before the bell;
 *   · a hero stepping back from a threat backpedals (the run cycle plays backwards — no moonwalking);
 *   · shots leave from the weapon, not from the middle of the body;
 *   · no generic circles: the arena draws no rarity rings, no cast runes, no shield bubbles, no ring shock-waves.
 */
const root = process.cwd();
const V2 = parseManifest(JSON.parse(readFileSync(path.join(root, "public/sprites/clank-dev-v2/manifest.json"), "utf8")));
const ATTACK_CLIPS = ["attack_slash", "attack_thrust", "attack_shoot"] as const;

describe("a blow lands on screen when the server says it lands", () => {
  const battles = Array.from({ length: 40 }, (_, i) => {
    const rng = createRng(`pres-${i}`);
    const units = Array.from({ length: 2 + (i % 7) }, (_, k) => makeUnit(`p${i}-${k}`, rng.pick(classIds)));
    return simulateBattle({ seed: `pres-${i}`, ruleset, units, maxCombatMs: 60_000, recordFrames: true });
  });
  const timing = (out: BattleOutcome) => ({ events: out.events, tickMs: out.tickMs, frames: out.frames ?? [], stride: FRAME_STRIDE, startPositions: out.startPositions, ticks: out.ticks });

  it("every ATTACK and SKILL event of 40 real battles shows its clip's IMPACT frame at the event instant (when the clip has room to wind up)", () => {
    let checked = 0;
    for (const out of battles) {
      const times = actionTimes(timing(out));
      for (const [, t] of times) {
        for (const [list, clips] of [[t.attacks, ATTACK_CLIPS], [t.skills, ["skill"] as const]] as const) {
          for (const clipKey of clips) {
            const clip = V2.clips[clipKey as ClipKey]!;
            const lead = impactLeadMs(clip);
            for (let i = 0; i < list.length; i++) {
              const at = list[i]!;
              const next = list[i + 1];
              if (at < lead || (next !== undefined && next - lead <= at)) continue; // no room before the bell / the next blow has already begun
              expect(frameAt(clip, sinceClipStart(list, at, lead)), `${clipKey} @${at}`).toBe(clip.impact);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it("the wind-up is shown BEFORE the event (anticipation), and nothing at all before the bell", () => {
    const clip = V2.clips.attack_slash!;
    const lead = impactLeadMs(clip);
    expect(lead).toBeGreaterThan(0);
    expect(sinceClipStart([1000], 1000 - lead + 1, lead)).toBeLessThan(lead); // the clip is already playing just before the blow
    expect(sinceClipStart([1000], 1000 - lead - 5, lead)).toBe(Infinity); // …and had not begun a moment earlier
    expect(sinceClipStart([1000], -1, lead)).toBe(Infinity); // the countdown: no clip, whatever the replay says
    expect(sinceClipStart([50], 0, lead)).toBe(0); // an early blow's clip starts AT the bell, never before it
    expect(sinceClipStart([], 5000, lead)).toBe(Infinity);
  });

  it("the timing comes only from the replay's own events (ATTACK / SKILL of each fighter, in order)", () => {
    const out = battles[0]!;
    const times = actionTimes(timing(out));
    const attacks = out.events.filter((e) => e[1] === EV.ATTACK).length;
    const skills = out.events.filter((e) => e[1] === EV.SKILL).length;
    expect([...times.values()].reduce((n, t) => n + t.attacks.length, 0)).toBe(attacks);
    expect([...times.values()].reduce((n, t) => n + t.skills.length, 0)).toBe(skills);
    for (const t of times.values()) for (const l of [t.attacks, t.skills]) expect([...l].sort((a, b) => a - b)).toEqual(l);
  });
});

describe("a skill fires when its cast ENDS", () => {
  it("the skill clip releases (and its effect shows) on the tick the cast resolves — read from the replay's CASTING frames — not when it begins", () => {
    let casts = 0;
    let longCasts = 0;
    for (let i = 0; i < 30; i++) {
      const rng = createRng(`cast-${i}`);
      const units = Array.from({ length: 8 }, (_, k) => makeUnit(`c${i}-${k}`, rng.pick(classIds)));
      const out = simulateBattle({ seed: `cast-${i}`, ruleset, units, maxCombatMs: 60_000, recordFrames: true });
      const r = { events: out.events, tickMs: out.tickMs, frames: out.frames!, stride: FRAME_STRIDE, startPositions: out.startPositions, ticks: out.ticks };
      const n = out.participants.length;
      const flags = (t: number, s: number) => out.frames![(t * n + s) * FRAME_STRIDE + 3]!;
      for (const [t, kind, a] of out.events) {
        if (kind !== EV.SKILL) continue;
        const k = castTicks(r, a, t);
        casts++;
        if (k > 2) longCasts++;
        for (let x = t; x < t + k; x++) expect(flags(x, a) & FRAME_FLAG.CASTING, `casting through tick ${x}`).not.toBe(0);
        if (t + k <= out.ticks) expect(flags(t + k, a) & FRAME_FLAG.CASTING, "released").toBe(0);
        expect(actionTimes(r).get(a)!.skills).toContain((t + k) * out.tickMs);
      }
    }
    expect(casts).toBeGreaterThan(200);
    expect(longCasts).toBeGreaterThan(10); // real casts (volley, arcane burst, ground slam) are among them
  });
});

describe("movement reads correctly", () => {
  const calm: AnimInput = { alive: true, moving: true, victory: false, stunned: false, sinceAttackMs: Infinity, sinceSkillMs: Infinity, sinceHurtMs: Infinity, sinceKoMs: null, loopClockMs: 0 };
  it("a hero backing away plays its run cycle BACKWARDS (no moonwalk), a hero running forward plays it forwards", () => {
    const move = V2.clips.move!;
    for (let ms = 0; ms < 1000; ms += 37) {
      const fwd = selectPlayback({ ...calm, loopClockMs: ms }, V2, "attack_slash");
      const back = selectPlayback({ ...calm, loopClockMs: ms, backpedal: true }, V2, "attack_slash");
      expect([fwd.clip, back.clip]).toEqual(["move", "move"]);
      expect(back.frame).toBe(move.frames - 1 - fwd.frame);
    }
  });
  it("backpedal only changes the run cycle (an attack, a hit, idle are untouched)", () => {
    for (const over of [{ sinceAttackMs: 40 }, { sinceHurtMs: 30, moving: false }, { moving: false }] as const) {
      expect(selectPlayback({ ...calm, ...over, backpedal: true }, V2, "attack_slash")).toEqual(selectPlayback({ ...calm, ...over }, V2, "attack_slash"));
    }
  });
});

describe("shots leave from the weapon", () => {
  const configOf = (classId: string) => {
    const c = DEFAULT_CLASSES.find((x) => x.id === classId)!;
    return deriveSpriteConfig(rollAppearance(createRng(`m-${classId}`), c, "COMMON"), c.look);
  };
  it("the ranged classes' weapons declare a muzzle in front of the hero, inside the frame, at weapon height; melee weapons don't", () => {
    for (const id of ["ranger", "mage", "cleric"]) {
      const plan = planLayers(configOf(id), V2);
      expect(plan.muzzle, id).not.toBeNull();
      const { x, y } = plan.muzzle!;
      expect(x, id).toBeGreaterThan(V2.anchor.x + 8); // in front of the body
      expect(x).toBeLessThan(V2.frame.w);
      expect(V2.anchor.y - y, id).toBeGreaterThan(V2.nominalHeightPx * 0.45); // hand / crystal height, not the feet
      expect(V2.anchor.y - y).toBeLessThan(V2.nominalHeightPx * 0.95);
    }
    for (const id of ["warrior", "rogue", "tank"]) expect(planLayers(configOf(id), V2).muzzle, id).toBeNull();
  });
});

describe("no generic circles around the heroes", () => {
  const renderer = readFileSync(path.join(root, "src/components/arena/ArenaRenderer.ts"), "utf8");
  it("the arena renderer draws no rarity ground rings / auras / particle halos, no cast runes, no shield bubbles and no ring shock-waves", () => {
    for (const banned of ["drawRarityGround", "drawRarityAura", "drawRarityParticles", "castRune", "bubbleFlash", "private ring("]) expect(renderer, banned).not.toContain(banned);
    expect(renderer).toContain("drawRarityMark"); // rarity stays readable: the plate's tier mark (and the gear on the sprite)
  });
  it("the vector fallback hero, drawn by the arena, has no shadow ellipse and no aura ring of its own (the arena draws one small contact shadow)", () => {
    expect(renderer).toMatch(/ground: false/);
    const visuals = classVisuals(DEFAULT_CLASSES);
    const c = DEFAULT_CLASSES.find((x) => x.id === "mage")!;
    const look = lookFor({ rarity: "LEGENDARY", parts: rollAppearance(createRng("fb"), c, "LEGENDARY") }, visuals.mage);
    const ellipses = (ground?: boolean) => {
      let n = 0;
      const ctx = new Proxy({}, {
        get: (_t, prop: string) => (prop === "createRadialGradient" || prop === "createLinearGradient" ? () => ({ addColorStop: () => undefined }) : (...args: unknown[]) => { if (prop === "ellipse" && args[0] === 0 && (args[1] === -1 || args[1] === -4)) n++; }),
        set: () => true,
      }) as unknown as CanvasRenderingContext2D;
      drawHero(ctx, look, { ...IDLE_POSE, t: 0.4, ...(ground === undefined ? {} : { ground }) });
      return n;
    };
    expect(ellipses()).toBeGreaterThan(0); // cards and portraits keep their ground
    expect(ellipses(false)).toBe(0);
  });
});

describe("presentation spacing: two sprites in contact are drawn apart — the server's positions never move", () => {
  const unit = (slot: number, x: number, y: number, alive = true): SpacedUnit => ({ slot, x, y, alive, ox: 0 });

  it("two fighters in melee contact are nudged apart symmetrically, by at most MAX each, and settle without jitter", () => {
    const us = [unit(0, 0, 0), unit(1, 30, 4)];
    for (let i = 0; i < 120; i++) updateOffsets(us, 16, true);
    expect(us[0]!.ox).toBeLessThan(0);
    expect(us[1]!.ox).toBeGreaterThan(0);
    expect(us[0]!.ox).toBeCloseTo(-us[1]!.ox, 6);
    expect(Math.abs(us[0]!.ox)).toBeLessThanOrEqual(SPACING_MAX);
    const settled = us.map((u) => u.ox);
    for (let i = 0; i < 60; i++) updateOffsets(us, 16, true);
    us.forEach((u, i) => expect(u.ox).toBeCloseTo(settled[i]!, 3)); // settled: it only keeps converging, never oscillates
    expect([us[0]!.x, us[1]!.x]).toEqual([0, 30]); // the authoritative positions are untouched
  });

  it("no nudge for fighters already clear of each other, one far above the other, or fallen; none at all before the bell", () => {
    const apart = [unit(0, 0, 0), unit(1, 60, 0)];
    const stacked = [unit(0, 0, 0), unit(1, 5, 80)];
    const fallen = [unit(0, 0, 0), unit(1, 20, 0, false)];
    for (const us of [apart, stacked, fallen]) {
      for (let i = 0; i < 60; i++) updateOffsets(us, 16, true);
      expect(us.every((u) => Math.abs(u.ox) < 1e-9)).toBe(true);
    }
    const pre = [unit(0, 0, 0), unit(1, 10, 0)];
    pre[0]!.ox = 5;
    updateOffsets(pre, 16, false);
    expect(pre.map((u) => u.ox)).toEqual([0, 0]);
  });

  it("three fighters on one target: every offset stays bounded", () => {
    const us = [unit(0, 0, 0), unit(1, 30, 0), unit(2, -30, 2), unit(3, 2, 10)];
    for (let i = 0; i < 200; i++) updateOffsets(us, 16, true);
    for (const u of us) expect(Math.abs(u.ox)).toBeLessThanOrEqual(SPACING_MAX + 1e-9);
  });
});

describe("walk vs run: the run cycle advances with the ground covered (stride-locked)", () => {
  const calm: AnimInput = { alive: true, moving: true, victory: false, stunned: false, sinceAttackMs: Infinity, sinceSkillMs: Infinity, sinceHurtMs: Infinity, sinceKoMs: null, loopClockMs: 0 };
  it("the MOVE frame follows the hero's own move clock, not wall time", () => {
    const a = selectPlayback({ ...calm, loopClockMs: 999, moveClockMs: 0 }, V2, "attack_slash");
    const b = selectPlayback({ ...calm, loopClockMs: 0, moveClockMs: 0 }, V2, "attack_slash");
    expect(a).toEqual(b); // wall time alone does not advance the stride
    const half = selectPlayback({ ...calm, moveClockMs: 250 }, V2, "attack_slash");
    expect(half.state).toBe("MOVE");
    expect(half.frame).toBe(3); // 250 ms of full-speed ground → frame 3 of a 6-frame, 12 fps cycle
  });
});
