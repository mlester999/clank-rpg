"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ArenaStateDto, ReplayDto } from "@/lib/dto";

import { bestOffset, clockSample, planNextPoll, typicalServerMs, type ClockSample } from "./pollSchedule";
import { exposeTelemetry, telemetry } from "./telemetry";

/** One request never waits longer than this: a hung connection must not freeze the poll loop (a held answer takes ≤ 1.5 s). */
const REQUEST_TIMEOUT_MS = 8000;

/** Profile photos already requested (the browser cache does the rest). */
const warmed = new Set<string>();
/**
 * Start fetching the photos of the fighters in a snapshot the moment it ARRIVES — before React has rendered a single row — so
 * the avatars are on their way during the 3 · 2 · 1 instead of beginning after the DOM exists. Both rosters the server has
 * already published are warmed: the battle on stage, and the UPCOMING battle (the picks panel lists it, and it takes the stage
 * next — so when it does, its eight photos are already in the browser cache and nothing hitches). Combat sprites need no
 * warming of their own: every hero is composed from one shared sprite set that is loaded once per page.
 * Images are requested with low priority and never awaited — a missing photo only costs that row its generated portrait.
 */
function warmAvatars(state: ArenaStateDto): void {
  if (typeof Image === "undefined") return;
  const urls = [...(state.upcoming?.fighters ?? []), ...(state.current?.fighters ?? [])].map((f) => f.avatarUrl);
  for (const url of urls) {
    if (!url || warmed.has(url)) continue;
    warmed.add(url);
    if (warmed.size > 400) warmed.delete(warmed.values().next().value as string);
    const img = new Image();
    img.decoding = "async";
    img.src = url;
  }
}

interface StateResponse {
  ok: boolean;
  state?: ArenaStateDto;
}

/**
 * Keeps every viewer on the SAME moment of the SAME server-authoritative battle.
 *  - polls the state endpoint, and times one request to land just before the end of the results screen,
 *    asking the server to answer AT that instant — so the next eight appear the moment the timer ends
 *    (see planNextPoll); if the next battle is genuinely late it retries fast instead of waiting a poll interval
 *  - estimates the server/client clock offset from the lowest-latency samples
 *  - fetches the verified replay for the battle on stage (released by the server at combat start)
 */
export function useArena(initial: ArenaStateDto | null) {
  const [state, setState] = useState<ArenaStateDto | null>(initial);
  const [replayState, setReplayState] = useState<{ id: string; replay: ReplayDto } | null>(null);
  const [online, setOnline] = useState(true);
  const [loaded, setLoaded] = useState(Boolean(initial));
  const offset = useRef(0);
  const samples = useRef<ClockSample[]>([]);
  const dwells = useRef<number[]>([]);
  const replays = useRef(new Map<string, ReplayDto>());
  const stateRef = useRef<ArenaStateDto | null>(initial);
  const seenBattles = useRef(new Set<string>());

  const getNow = useCallback(() => Date.now() + offset.current, []);

  // Seed the clock offset from the server-rendered state (refined by every poll afterwards).
  useEffect(() => {
    if (initial) offset.current = initial.serverTime - Date.now();
  }, [initial]);

  /** One authoritative read. `holdUntil` asks the server to answer at that instant (new-battle boundary). */
  const refresh = useCallback(async (holdUntil: number | null = null): Promise<boolean> => {
    const t0 = Date.now();
    try {
      const res = await fetch(holdUntil === null ? "/api/arena/state" : `/api/arena/state?hold=${Math.round(holdUntil)}`, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const t1 = Date.now();
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as StateResponse;
      if (!json.ok || !json.state) throw new Error("bad payload");
      // The server stamps when it started and finished handling the request, so a slow or deliberately held answer
      // does not skew the clock estimate.
      const sample = clockSample(json.state.serverTime, t0, t1, json.state.serverReceivedAt);
      samples.current = [...samples.current, sample].slice(-6);
      offset.current = bestOffset(samples.current);
      if (holdUntil === null && sample.serverMs !== undefined) dwells.current = [...dwells.current, sample.serverMs].slice(-3);
      stateRef.current = json.state;
      warmAvatars(json.state);
      // Telemetry: the first snapshot that contains a battle, with how it arrived (held at the boundary or an ordinary poll).
      const cur = json.state.current;
      if (cur) {
        telemetry.knowStart(cur.id, cur.startsAt);
        if (!seenBattles.current.has(cur.id)) {
          seenBattles.current.add(cur.id);
          telemetry.push({ kind: "state", clientAt: t1, serverAt: t1 + offset.current, battleId: cur.id, value: json.state.serverTime, flag: holdUntil !== null, rtt: sample.rtt });
        }
      }
      setState(json.state);
      setOnline(true);
      setLoaded(true);
      return true;
    } catch {
      setOnline(false);
      setLoaded(true);
      return false;
    }
  }, []);

  // Poll loop with boundary-aware scheduling (see planNextPoll).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;
    let overdueStreak = 0;
    let heldFor: number | null = null;
    let pendingHold: number | null = null;
    const loop = async () => {
      if (stopped) return;
      const hold = pendingHold;
      pendingHold = null;
      if (hold !== null) heldFor = hold;
      const ok = await refresh(hold);
      if (stopped) return;
      failures = ok ? 0 : Math.min(failures + 1, 5);
      const s = stateRef.current;
      const now = Date.now() + offset.current;
      overdueStreak = ok && s?.current?.slotEndsAt != null && now >= s.current.slotEndsAt ? overdueStreak + 1 : 0;
      const recent = samples.current.slice(-3);
      const rttMs = recent.length ? recent.reduce((a, x) => a + x.rtt, 0) / recent.length : 120;
      // How long the server takes to build an ordinary snapshot (held requests are excluded: their time is the wait).
      const serverMs = typicalServerMs(dwells.current);
      const plan = planNextPoll({ state: s, now, ok, failures, overdueStreak, rttMs, serverMs, heldFor });
      pendingHold = plan.holdUntil;
      timer = setTimeout(loop, plan.delayMs);
    };
    timer = setTimeout(loop, initial ? 1500 : 0);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        pendingHold = null;
        void loop();
      }
    };
    // Telemetry: hidden/visible transitions, so a throttled background tab is never mistaken for lag.
    const mark = () => telemetry.push({ kind: "visibility", clientAt: Date.now(), serverAt: Date.now() + offset.current, battleId: null, flag: document.visibilityState !== "visible" });
    exposeTelemetry();
    mark();
    document.addEventListener("visibilitychange", mark);
    document.addEventListener("visibilitychange", onVisible);
    // A tab that was frozen or throttled (hidden, bfcache, a sleeping laptop, a network drop) resyncs to the LIVE battle the
    // instant it can — it never replays what it missed and never rewinds the arena: everything on screen is a pure function
    // of the synced server clock, so one fresh snapshot is all it takes.
    const resync = () => {
      clearTimeout(timer);
      pendingHold = null;
      void loop();
    };
    window.addEventListener("pageshow", resync);
    window.addEventListener("online", resync);
    window.addEventListener("focus", onVisible);
    return () => {
      window.removeEventListener("pageshow", resync);
      window.removeEventListener("online", resync);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", mark);
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, initial]);

  // Load the verified replay for the battle on stage. The server withholds it until combat starts
  // (it contains the outcome, and free picks are open until then), so begin just before the bell
  // and retry quickly on the expected "not yet".
  const currentId = state?.current?.hasReplay ? state.current.id : null;
  const combatStartsAt = state?.current?.combatStartsAt ?? null;
  useEffect(() => {
    if (!currentId) return;
    const cached = replays.current.get(currentId);
    if (cached) {
      queueMicrotask(() => setReplayState({ id: currentId, replay: cached }));
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number) => {
      try {
        const res = await fetch(`/api/arena/battles/${currentId}/replay`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { replay: ReplayDto };
        if (cancelled) return;
        replays.current.set(currentId, json.replay);
        if (replays.current.size > 6) replays.current.delete(replays.current.keys().next().value as string);
        setReplayState({ id: currentId, replay: json.replay });
      } catch {
        if (!cancelled && attempt < 60) timer = setTimeout(() => void load(attempt + 1), attempt < 4 ? 120 : 300);
      }
    };
    const wait = combatStartsAt ? Math.max(0, combatStartsAt - (Date.now() + offset.current) - 150) : 0;
    timer = setTimeout(() => void load(0), wait);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [currentId, combatStartsAt]);

  return { state, replay: replayState && replayState.id === currentId ? replayState.replay : null, online, loaded, getNow, refresh: () => refresh() };
}
