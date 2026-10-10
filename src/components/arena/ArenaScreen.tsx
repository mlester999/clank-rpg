"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_SPRITE_SET } from "@/components/sprites/library";
import { PhaseCueTracker } from "@/domain/audio/cues";
import { useSpriteLibrary } from "@/components/sprites/useSprites";
import { ARENA_LABEL_MAX, truncateDisplayName } from "@/domain/character/displayName";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { ArenaStateDto, FighterDto } from "@/lib/dto";


import { SoundToggle } from "./audio/SoundToggle";
import { ArenaChat } from "./chat/ArenaChat";
import { useArenaAudio } from "./audio/useArenaAudio";
import { ComingSoon, HowItWorks } from "./ArenaInfo";
import { HeroEligibilityCard } from "./HeroEligibility";
import { ArenaRenderer, type ArenaPhase } from "./ArenaRenderer";
import { ArenaPicks } from "./ArenaPicks";
import { RecentWinners } from "./RecentWinners";
import { ResultsPanel, type PickLine } from "./ResultsPanel";
import { RosterStore } from "./rosterStore";
import { SpectatorStrip } from "./SpectatorStrip";
import { ArenaHeader, CountdownOverlay, PhaseBanner, PicksOpenHint, StageHint, SurvivorsHud } from "./StageHud";
import { StageStatusCard } from "./StageStatusCard";
import { headerStatus, stageMode } from "./stageMode";
import { telemetry } from "./telemetry";
import { EliminationLog } from "./eventCursor";
import { nextBattleLabel } from "./pollSchedule";
import { useArena } from "./useArena";
import { windowDisplay } from "./picksView";
import { usePicks } from "./usePicks";

interface Hud {
  phase: ArenaPhase;
  countdown: number | null;
  alive: number;
}

interface KillLine {
  id: string;
  text: string;
}

const EMPTY_HUD: Hud = { phase: "IDLE", countdown: null, alive: 0 };

/**
 * The Global Idle Arena page. Hierarchy: the ARENA dominates (left, ~73%); the right rail is the
 * ARENA PICKS — the eight heroes of the NEXT fight with the spectator action (a FREE pick, made while the current fight is
 * watched on the stage). Everything else (live spectator stats, recent winners, how it works, locked features) is secondary.
 *
 * Nothing here decides an outcome: the canvas plays the server's verified replay, and picks are
 * accepted or refused by the server alone.
 */
export function ArenaScreen({ initial }: { initial: ArenaStateDto | null }) {
  const { state, replay, online, connection, loaded, getNow } = useArena(initial);
  const lib = useSpriteLibrary(state?.visuals.spriteSet ?? DEFAULT_SPRITE_SET);
  const { audio, snapshot: sound } = useArenaAudio();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ArenaRenderer | null>(null);
  const measureRef = useRef<(() => void) | null>(null);
  const stateRef = useRef(state);
  const replayRef = useRef(replay);
  const bySlotRef = useRef<Map<number, FighterDto>>(new Map());
  const hudRef = useRef<Hud>(EMPTY_HUD);
  const roster = useMemo(() => new RosterStore(), []);
  const [hud, setHud] = useState<Hud>(EMPTY_HUD);
  const [kills, setKills] = useState<KillLine[]>([]);
  // Seeded from the server-rendered state (identical on server and client); the render loop keeps it fresh.
  const [now, setNow] = useState(initial?.serverTime ?? 0);

  const current = state?.current ?? null;
  const fighters = useMemo(() => current?.fighters ?? [], [current]);
  const bySlot = useMemo(() => new Map(fighters.map((f) => [f.slot ?? -1, f])), [fighters]);

  // The animation loop reads the latest data through refs, which are only written after commit.
  useEffect(() => {
    stateRef.current = state;
    replayRef.current = replay;
    bySlotRef.current = bySlot;
  });

  // --- renderer lifecycle
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const renderer = new ArenaRenderer(canvas);
    rendererRef.current = renderer;
    // The page's own controls over the stage (the Survivors plate, the sound button, the kill feed) are MEASURED, so name plates and floating
    // numbers keep clear of them at any size. Re-measured whenever the stage resizes or the set of boxes changes.
    const measure = () => {
      const w = wrap.getBoundingClientRect();
      const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const el of wrap.querySelectorAll<HTMLElement>("[data-stage-reserve]")) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) boxes.push({ x: b.left - w.left, y: b.top - w.top, w: b.width, h: b.height });
      }
      renderer.setReserved(boxes);
    };
    measureRef.current = measure;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      renderer.resize(Math.max(280, r.width), Math.max(200, r.height), window.devicePixelRatio || 1);
      measure();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const eliminations = new EliminationLog();
    // sound: the replay's events become cues in the renderer; the clock's own cues (3 · 2 · 1, the bell, the winner) come from the tracker below
    renderer.onCue = (cue) => audio.play(cue);
    const phaseCues = new PhaseCueTracker();
    renderer.onEvent = (e) => {
      const id = eliminations.first(stateRef.current?.current?.id ?? "-", e.victim);
      if (id === null) return;
      const v = bySlotRef.current.get(e.victim);
      const k = e.killer === null ? null : bySlotRef.current.get(e.killer);
      // Long Telegram-derived names are shortened for this pill only; the stored name is untouched.
      const short = (n: string | undefined) => (n ? truncateDisplayName(n, ARENA_LABEL_MAX) : "a hero");
      const text = k ? `${short(k.name)} eliminated ${short(v?.name)}` : `${short(v?.name)} was eliminated`;
      // The visible feed is drawn ON the stage (same frame, same geometry as the name plates); this list is its screen-reader twin.
      renderer.feedKill(id, k?.name ?? null, v?.name ?? "a hero", getNow());
      setKills((list) => [...list.slice(-1), { id, text }]);
      setTimeout(() => setKills((list) => list.filter((l) => l.id !== id)), 4200);
    };

    let raf = 0;
    let last = performance.now();
    let lastHud = 0;
    let lastNow = 0;
    let celebratedFor = "";
    const frame = (t: number) => {
      const s = stateRef.current;
      const dt = Math.min(100, t - last);
      last = t;
      const serverNow = getNow();
      const cur = s?.current ?? null;
      if (s) renderer.setClasses(s.classes);
      renderer.setBattle(cur, replayRef.current);
      const timing = s?.timing ?? { countdownMs: 3000, maxCombatMs: 30000, introMs: 2500, victoryHoldMs: 1200, resultsMs: 5000, tickMs: 100 };
      // The renderer decides the phase ONCE per frame and draws the 3 · 2 · 1 itself; the HUD below reads the very same value.
      const ph = renderer.render(serverNow, { countdownMs: timing.countdownMs, maxCombatMs: timing.maxCombatMs }, dt);
      const rep = replayRef.current;
      const winnerSlot = rep && (ph.phase === "VICTORY" || ph.phase === "RESULTS" || ph.phase === "DONE") ? (rep.ranking[0] ?? null) : null;
      audio.setStage(cur?.id ?? null, ph.phase);
      for (const cue of phaseCues.update({
        battleId: cur?.id ?? null, phase: ph.phase, countdown: ph.countdown, now: serverNow, startsAt: cur?.startsAt ?? null, combatStartsAt: cur?.combatStartsAt ?? null,
        combatEndsAt: cur?.combatEndsAt ?? null, resultsStartAt: cur?.resultsStartAt ?? null, countdownMs: timing.countdownMs, winnerKnown: winnerSlot !== null,
      })) audio.play(cue);
      if (cur && winnerSlot !== null && celebratedFor !== cur.id && ph.phase !== "DONE") {
        celebratedFor = cur.id;
        renderer.celebrate(winnerSlot, serverNow);
      }
      if (t - lastHud > 90) {
        lastHud = t;
        const entries = renderer.roster();
        roster.update(entries);
        const alive = entries.filter((r) => r.alive).length;
        const prev = hudRef.current;
        if (prev.phase !== ph.phase || prev.countdown !== ph.countdown || prev.alive !== alive) {
          const next: Hud = { phase: ph.phase, countdown: ph.countdown, alive };
          hudRef.current = next;
          setHud(next);
        }
      }
      if (t - lastNow > 250) {
        lastNow = t;
        setNow(serverNow);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.onCue = null;
      audio.stopAll();
      rendererRef.current = null;
      measureRef.current = null;
    };
  }, [getNow, roster, audio]);

  // --- spritesheets: installed into the renderer as soon as the set is ready (vector heroes until then)
  const spriteSource = lib.source;
  useEffect(() => {
    rendererRef.current?.setSprites(spriteSource);
  }, [spriteSource]);

  // What the stage is showing — decided from the PERSISTED server state (plus whether the browser can reach the server at all).
  const mode = stageMode({ state, loaded, online });
  const waiting = mode !== "STAGE" && mode !== "LOADING" && mode !== "GATHERING";
  const phase = hud.phase;

  // --- transition telemetry, recorded at React COMMIT (what the viewer's screen actually showed), on the synced clock.
  const battleId = current?.id ?? null;
  const combatStartsAtForTelemetry = current?.combatStartsAt ?? null;
  useEffect(() => {
    if (battleId) telemetry.push({ kind: "roster", clientAt: Date.now(), serverAt: getNow(), battleId });
  }, [battleId, getNow]);
  useEffect(() => {
    if (battleId && hud.countdown !== null) telemetry.push({ kind: "countdown", clientAt: Date.now(), serverAt: getNow(), battleId, value: hud.countdown });
  }, [battleId, hud.countdown, getNow]);
  useEffect(() => {
    if (battleId && hud.phase === "COMBAT" && combatStartsAtForTelemetry !== null) {
      const at = getNow();
      telemetry.push({ kind: "combat", clientAt: Date.now(), serverAt: at, battleId, value: at - combatStartsAtForTelemetry });
    }
  }, [battleId, hud.phase, combatStartsAtForTelemetry, getNow]);

  // --- placements (only ever REVEALED once the fight is over)
  const placements = useMemo(() => {
    const m = new Map<string, number>();
    if (current?.results) for (const r of current.results) m.set(r.characterId, r.placement);
    else if (replay) replay.ranking.forEach((slot, i) => {
      const f = bySlot.get(slot);
      if (f) m.set(f.characterId, i + 1);
    });
    return m;
  }, [current, replay, bySlot]);
  const winnerId = useMemo(() => [...placements.entries()].find(([, p]) => p === 1)?.[0] ?? null, [placements]);
  const decided = phase === "VICTORY" || phase === "RESULTS" || phase === "DONE";

  const results = useMemo(() => {
    if (!current) return null;
    const rows = current.results;
    const order = rows
      ? rows.slice(0, 2).map((r) => ({ f: fighters.find((x) => x.characterId === r.characterId), r }))
      : replay
        ? replay.ranking.slice(0, 2).map((slot) => ({ f: bySlot.get(slot), r: null }))
        : [];
    return order.filter((o): o is { f: FighterDto; r: NonNullable<typeof o.r> | null } => Boolean(o.f));
  }, [current, fighters, replay, bySlot]);

  // --- Arena Picks (free; made on the UPCOMING battle while the current one is watched; the server decides everything).
  // The panel and the Picks hook follow `state.upcoming`, never `state.current`: both come from the SAME snapshot, so when the next
  // battle takes the stage the panel moves on to the one after it in the very same render.
  const upcoming = state?.upcoming ?? null;
  const picksOn = Boolean(state?.picks.enabled);
  const upcomingWindow = windowDisplay(upcoming, now);
  // The panel closes at the server's own lock instant — not at the next 250 ms tick of `now`. (The server refuses picks from that
  // instant regardless; this only makes what is DISPLAYED agree with it to the millisecond.)
  const locksAt = upcoming?.picks.locksAt ?? null;
  useEffect(() => {
    if (locksAt === null) return;
    const wait = locksAt - getNow();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(getNow()), wait + 1);
    return () => clearTimeout(timer);
  }, [upcoming?.id, locksAt, getNow]);
  const picks = usePicks(upcoming?.id ?? null, current?.id ?? null, picksOn, phase, upcomingWindow);
  const pickedFighter = picks.current.pick ? fighters.find((f) => f.characterId === picks.current.pick!.characterId) : undefined;
  const onStage = useMemo(() => (current ? { fighters, decided } : null), [current, fighters, decided]);

  // The hero the viewer picked keeps its name in place on the stage (and is marked); and the page's boxes over the stage are re-measured when they change.
  const focusSlot = pickedFighter?.slot ?? null;
  useEffect(() => {
    rendererRef.current?.setFocus(focusSlot);
  }, [focusSlot, current?.id]);
  const hudShown = Boolean(current) && phase !== "IDLE";
  useEffect(() => {
    measureRef.current?.();
  }, [hudShown, mode]);

  const pickOutcome = picks.current.round?.outcome;
  const pickLine: PickLine | null =
    picksOn && picks.current.pick && pickedFighter
      ? {
          name: pickedFighter.name,
          outcome: pickOutcome?.result === "CORRECT" || pickOutcome?.result === "INCORRECT" || pickOutcome?.result === "VOID" ? pickOutcome.result : "PENDING",
          ...(pickOutcome?.result === "CORRECT" && !pickOutcome.pending ? { points: pickOutcome.points } : {}),
        }
      : null;

  // Healthy operation: the next eight are on stage the instant this reaches zero. "Starting…" covers the few
  // milliseconds of that hand-over; "Preparing next battle…" only appears if the server is genuinely late.
  const nextLabel = state?.next ? nextBattleLabel(state.next.startsAt, now) : null;
  const showResults = (phase === "RESULTS" || phase === "DONE") && results && results.length > 0;
  const nowCoarse = Math.floor(now / 5000) * 5000;

  return (
    <div className="mx-auto w-full max-w-[1500px] px-3 pt-4 pb-6 sm:px-6">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(340px,27%)] xl:grid-rows-[auto_auto_1fr] xl:gap-x-4">
        {/* status strip — the public header carries nothing about queues, cycles, rounds or scheduling */}
        <div className="xl:col-start-1 xl:row-start-1">
          <ArenaHeader status={headerStatus(mode, state)} season={state?.season ?? null} phase={state?.phase} online={online} connection={connection} demo={Boolean(state?.demo)} />
        </div>

        {/* the stage */}
        <div className="stage-frame plate plate-clank rivets p-[3px] xl:col-start-1 xl:row-start-2" style={{ ["--chamfer" as string]: "14px" }} data-testid="arena-stage" data-battle={current?.id} data-phase={phase} data-mode={mode}>
          {/* @container: everything laid over the stage (results, hints, the survivors plate) sizes itself from the stage's own width, not the page's */}
          <div ref={wrapRef} className="@container relative aspect-[800/780] w-full overflow-hidden bg-ink-950 sm:aspect-[5/3]" style={{ clipPath: "inherit" }}>
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" role="img" aria-label={current ? `The arena: ${fighters.map((f) => `${f.name} the ${state?.classes[f.classId]?.name ?? "hero"}`).join(", ")}` : "The arena awaits its next heroes"} />

            {/* top HUD */}
            {current && phase !== "IDLE" && <SurvivorsHud alive={hud.alive} total={fighters.length || 8} />}

            {/* kill feed: drawn on the stage (top-right, by the renderer); this is its screen-reader twin */}
            <div className="sr-only" aria-live="polite" data-testid="kill-feed">
              {kills.map((k) => (
                <p key={k.id}>{k.text}</p>
              ))}
            </div>

            {/* countdown: the 3 · 2 · 1 before every fight */}
            <CountdownOverlay phase={phase} countdown={hud.countdown} />
            {current && (
              <StageHint phase={phase}>
                {picksOn && upcomingWindow === "OPEN" ? <PicksOpenHint /> : "Heroes entering the arena…"}
              </StageHint>
            )}
            {current && <PhaseBanner phase={phase} sinceCombatStartMs={now - (current.combatStartsAt ?? 0)} />}

            {/* results: #1 winner + #2 runner-up, ~5 s, then straight into the next battle */}
            {showResults && results && <ResultsPanel entries={results} classes={state?.classes ?? {}} disabled={state?.visuals.disabledCosmetics} pick={pickLine} next={nextLabel} />}

            {/* the intentional waiting screens (not started / preparing / paused / development / between seasons) and the one real error */}
            {waiting && (
              <div className="absolute inset-0 grid place-items-center overflow-y-auto bg-ink-950/70 p-3 backdrop-blur-[1px] sm:p-4">
                <StageStatusCard mode={mode} state={state} />
              </div>
            )}
            {mode === "GATHERING" && (
              <div className="absolute inset-0 grid place-items-center p-4">
                <GatheringCard state={state} />
              </div>
            )}
            {mode === "LOADING" && (
              <div className="absolute inset-0 grid place-items-center">
                <span className="chip bg-ink-950/80">Opening the arena…</span>
              </div>
            )}

            {/* the speaker: bottom-right of the live arena */}
            <SoundToggle audio={audio} snapshot={sound} />
          </div>
        </div>

        {/* Directly under the stage: the live spectator status, then the Arena Chat (its own island — see chat/ArenaChat.tsx). On small screens this is
            what follows the arena; Arena Picks (below) follow the chat there. */}
        <div className="flex min-w-0 flex-col gap-3 xl:col-start-1 xl:row-start-3">
          <SpectatorStrip state={state} fighters={fighters} phase={phase} winnerCharacterId={decided ? winnerId : null} roster={roster} />
          <ArenaChat />
        </div>

        {/* Arena Picks: the NEXT fight's eight (right rail on desktop, beside the arena and its chat; under them on small screens) */}
        <aside className="flex min-w-0 flex-col gap-3 xl:col-start-2 xl:row-span-3 xl:row-start-1">
          <ArenaPicks state={state} upcoming={upcoming} now={now} picks={picks} onStage={onStage} loaded={loaded} mode={mode} />
        </aside>
      </div>

      <div className="mt-8 space-y-6">
        <RecentWinners state={state} now={nowCoarse} />
        <StaticSections threshold={state?.heroThreshold ?? FALLBACK_HERO_THRESHOLD} />
      </div>
    </div>
  );
}

/**
 * The sections under the arena never change while a battle is watched. The page re-renders several times a second (the synced
 * clock, the HUD, the roster), and re-rendering this static content with it was a measurable share of every commit — so it only
 * re-renders when the threshold it shows does.
 */
const StaticSections = memo(function StaticSections({ threshold }: { threshold: number }) {
  return (
    <>
      <HeroEligibilityCard threshold={threshold} />
      <div className="grid gap-4 md:grid-cols-2">
        <HowItWorks />
        <ComingSoon />
      </div>
    </>
  );
});

/** Used only while the first arena state is still loading; the live value comes from settings (state.heroThreshold). */
const FALLBACK_HERO_THRESHOLD = DEFAULT_SETTINGS.telegram.qualifyingThreshold;

/** Running, but fewer eligible heroes than a battle needs: the ONLY place a "heroes so far" counter appears. */
function GatheringCard({ state }: { state: ArenaStateDto | null }) {
  const have = state?.eligibleHeroes ?? 0;
  const need = state?.groupSize ?? 8;
  const heroThreshold = state?.heroThreshold ?? FALLBACK_HERO_THRESHOLD;
  return (
    <div className="plate plate-clank max-w-md p-5 text-center" data-testid="stage-status" data-mode="GATHERING">
      <h2 className="font-display text-lg text-clank-300">The Foundry is warming up</h2>
      <p className="mt-2 text-sm text-steel-300">
        Battles start as soon as <b className="text-paper">{need} heroes</b> exist. Heroes are created automatically for members of the official Clank.trade Telegram community with <b className="text-paper">{heroThreshold}+ qualifying messages</b>.
      </p>
      <div className="mt-3 flex items-center justify-center gap-1.5" aria-label={`${have} of ${need} heroes`}>
        {Array.from({ length: need }, (_, i) => (
          <span key={i} className={`h-3 w-3 rounded-full ${i < have ? "bg-teal shadow-[0_0_10px_#2ee6c8]" : "bg-white/10"}`} />
        ))}
      </div>
      <p className="mt-1 text-xs text-steel-300 tnum">{have} / {need} heroes</p>
    </div>
  );
}
