import { rollAppearance } from "@/domain/character/appearance";
import { simulateBattle } from "@/domain/combat/engine";
import { FRAME_STRIDE } from "@/domain/combat/types";
import { DEFAULT_CLASSES } from "@/domain/content";
import { createRng } from "@/domain/util/rng";
import type { BattleDto, FighterDto, ReplayDto } from "@/lib/dto";
import type { Ruleset } from "@/domain/rules";
import { classVisuals } from "@/server/services/views";
import { ArenaRenderer } from "@/components/arena/ArenaRenderer";

import { classIds, makeUnit, ruleset } from "./fixtures";

/**
 * A real ArenaRenderer in plain Node: a recording 2D context stands in for the canvas, a real simulated battle (the same engine the server runs)
 * stands in for the server's replay. It exists so the stage's PRESENTATION — name plates above all — can be measured over whole fights, frame by
 * frame, without a browser. Nothing here decides a fight; the replay is whatever the engine produced.
 */

export interface DrawCall {
  op: "fillText" | "strokeText";
  text: string;
  x: number;
  y: number;
  font: string;
  align: string;
  /** Effective scale of the text (translate / scale in force when it was drawn). */
  scale: number;
}

/**
 * A canvas 2D context that accepts every call, remembers the text it was asked to draw — at STAGE coordinates (it follows translate / scale / save / restore;
 * the renderer's base setTransform is the stage's own layout-unit space, so it counts as the identity) — and measures text as 0.56 em per character.
 */
export function recordingContext(calls: DrawCall[], ops?: { n: number }): CanvasRenderingContext2D {
  const state: Record<string, unknown> = { font: "10px sans-serif", textAlign: "start" };
  let m = { sx: 1, sy: 1, tx: 0, ty: 0 };
  const stack: Array<typeof m> = [];
  const px = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 10);
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (ops && typeof prop === "string" && prop !== "font" && prop !== "textAlign") ops.n++;
      if (prop === "measureText") return (text: string) => ({ width: text.length * px() * 0.56 });
      if (prop === "fillText" || prop === "strokeText") return (text: string, x: number, y: number) => calls.push({ op: prop, text, x: m.sx * x + m.tx, y: m.sy * y + m.ty, font: String(state.font), align: String(state.textAlign), scale: m.sy });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => ({ addColorStop: () => undefined });
      if (prop === "save") return () => void stack.push({ ...m });
      if (prop === "restore") return () => void (m = stack.pop() ?? m);
      if (prop === "setTransform") return () => void (m = { sx: 1, sy: 1, tx: 0, ty: 0 }); // the renderer's base transform IS the stage's layout space
      if (prop === "translate") return (x: number, y: number) => void (m = { ...m, tx: m.tx + m.sx * x, ty: m.ty + m.sy * y });
      if (prop === "scale") return (x: number, y: number) => void (m = { ...m, sx: m.sx * x, sy: m.sy * y });
      if (prop in state) return state[prop];
      return () => undefined;
    },
    set(_t, prop: string, value) {
      state[prop] = value;
      return true;
    },
  };
  return new Proxy({}, handler) as CanvasRenderingContext2D;
}

export interface Harness {
  renderer: ArenaRenderer;
  calls: DrawCall[];
  battle: BattleDto;
  replay: ReplayDto;
  /** Server-clock instants of the battle. */
  startsAt: number;
  combatStartsAt: number;
  combatEndsAt: number;
  timing: { countdownMs: number; maxCombatMs: number };
}

const NAMES = ["Markyyester", "Jayson", "Alex", "Sir Bartholomew Maximilian Featherstone", "xX_DragonSlayer_Xx", "Ki", "Hannah Montgomery-Wellington", "Zed"];

/** Installs the few browser globals the renderer reads at construction. */
function stubBrowser(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.getComputedStyle = () => ({ fontFamily: "sans-serif", getPropertyValue: () => "" });
  g.window = { matchMedia: () => ({ matches: false }), devicePixelRatio: 2 };
  g.document = { documentElement: {}, createElement: () => ({ width: 0, height: 0, getContext: () => recordingContext([]) }) };
}

/** Builds a harness for one real battle at a stage of `cssW × cssH` css pixels. `names` are the eight heroes' names (defaults to a mix of short and very long). */
export function makeHarness(seed: string, cssW: number, cssH: number, names: readonly string[] = NAMES, rules: Ruleset = ruleset, opts: { Renderer?: new (c: HTMLCanvasElement) => ArenaRenderer; ops?: { n: number } } = {}): Harness {
  stubBrowser();
  const rng = createRng(`harness-${seed}`);
  const units = Array.from({ length: 8 }, (_, k) => makeUnit(`h${seed}-${k}`, classIds[(k + Math.floor(rng.next() * 7)) % classIds.length] as string));
  const out = simulateBattle({ seed: `harness-${seed}`, ruleset: rules, units, maxCombatMs: 60_000, recordFrames: true });
  const classes = classVisuals(DEFAULT_CLASSES);
  const fighters: FighterDto[] = out.participants.map((p, slot) => {
    const classId = units[slot]?.classId ?? (classIds[0] as string);
    const cls = DEFAULT_CLASSES.find((c) => c.id === classId) ?? (DEFAULT_CLASSES[0] as (typeof DEFAULT_CLASSES)[number]);
    return {
      slot, characterId: p.characterId, publicId: `pub${slot}`, name: names[slot % names.length] as string, classId, title: null, isDemo: false, claimed: false, power: 150 + slot,
      appearance: { rarity: (["COMMON", "RARE", "EPIC", "LEGENDARY"] as const)[slot % 4] as string, parts: rollAppearance(createRng(`app-${seed}-${slot}`), cls, "COMMON") },
      avatarUrl: null, maxHp: Math.round(p.maxHp), startPosition: out.startPositions[slot] as [number, number],
    };
  });
  const startsAt = 1_000_000;
  const combatStartsAt = startsAt + 5500;
  const combatEndsAt = combatStartsAt + out.ticks * out.tickMs;
  const battle: BattleDto = {
    id: `battle-${seed}`, sequence: 1, number: 1, status: "SIMULATED", startsAt, combatStartsAt, combatEndsAt, resultsStartAt: combatEndsAt + 1200, slotEndsAt: combatEndsAt + 6200,
    durationMs: out.ticks * out.tickMs, endedBy: "LAST_STANDING", tickMs: out.tickMs, fighters, results: null, eventsHash: out.eventsHash, rulesVersion: out.rulesVersion, hasReplay: true,
  };
  const replay: ReplayDto = {
    skillFx: Object.fromEntries(out.skillIds.map((id) => [id, { name: rules.skills[id]?.name ?? id, fx: rules.skills[id]?.fx ?? "buff" }])),
    combat: { arenaRadius: rules.combat.arenaRadius, startRadius: rules.combat.startRadius, unitRadius: rules.combat.unitRadius },
    battleId: battle.id, tickMs: out.tickMs, ticks: out.ticks, stride: FRAME_STRIDE, frames: out.frames ?? [], events: out.events, skillIds: out.skillIds, startPositions: out.startPositions,
    slotOf: out.slotOf, eventsHash: out.eventsHash, rulesVersion: out.rulesVersion, ranking: out.ranking,
  };
  const calls: DrawCall[] = [];
  const canvas = { width: 0, height: 0, getContext: () => recordingContext(calls, opts.ops) } as unknown as HTMLCanvasElement;
  const renderer = new (opts.Renderer ?? ArenaRenderer)(canvas);
  renderer.resize(cssW, cssH, 2);
  renderer.setClasses(classes);
  renderer.setBattle(battle, replay);
  renderer.capturePlates?.(true);
  return { renderer, calls, battle, replay, startsAt, combatStartsAt, combatEndsAt, timing: { countdownMs: 3000, maxCombatMs: 60_000 } };
}

/** The stage size a phone / tablet / desktop viewport gives the arena (the 800:780 tall stage under 640 px of viewport, the 5:3 wide one above). */
export const stageFor = (viewportW: number): { w: number; h: number } => {
  const w = viewportW < 640 ? viewportW - 24 - 6 : Math.min(1000, viewportW - 48 - 6);
  return { w, h: viewportW < 640 ? Math.round((w * 780) / 800) : Math.round((w * 3) / 5) };
};

/** Plays the fight in 100 ms steps (what a 10 fps device draws), calling `each` after every frame. Returns the instants played. */
export function playFight(h: Harness, each: (now: number, phase: string) => void, stepMs = 100): void {
  const { renderer, battle } = h;
  const from = h.startsAt + 2600; // intro done, countdown about to start
  const to = h.combatEndsAt + 2000;
  for (let now = from; now <= to; now += stepMs) {
    h.calls.length = 0;
    const ph = renderer.render(now, h.timing, stepMs);
    each(now, ph.phase);
  }
  void battle;
}
