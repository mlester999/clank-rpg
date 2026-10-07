"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ArenaStateDto, ReplayDto } from "@/lib/dto";

import { ArenaPoller, retryAfterMs, type Connection, type PollResult } from "./arenaPoller";
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
 *  - ONE loop, ONE request at a time (ArenaPoller): a tab that becomes visible, is restored with Back, or regains the network gets exactly one
 *    immediate fresh read; failures back off exponentially with jitter, and `connection` says "syncing" / "reconnecting" meanwhile
 *  - estimates the server/client clock offset from the lowest-latency samples
 *  - fetches the verified replay for the battle on stage (released by the server at combat start)
 */
export function useArena(initial: ArenaStateDto | null) {
  const [state, setState] = useState<ArenaStateDto | null>(initial);
  const [replayState, setReplayState] = useState<{ id: string; replay: ReplayDto } | null>(null);
  const [connection, setConnection] = useState<Connection>("live");
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

  /**
   * One authoritative read, for the poller. `holdUntil` asks the server to answer at that instant (new-battle boundary). It never throws; a read that was
   * superseded (`signal` aborted by a newer one) is dropped without touching state.
   */
  const fetchOnce = useCallback(async (holdUntil: number | null, signal: AbortSignal): Promise<PollResult> => {
    const t0 = Date.now();
    // The request's own deadline AND the poller's abort, in one signal (AbortSignal.any is not available in every browser we serve).
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(holdUntil === null ? "/api/arena/state" : `/api/arena/state?hold=${Math.round(holdUntil)}`, { cache: "no-store", signal: controller.signal });
      const t1 = Date.now();
      if (!res.ok) {
        setLoaded(true);
        return { ok: false, retryAfterMs: retryAfterMs(res.headers.get("retry-after")) };
      }
      const json = (await res.json()) as StateResponse;
      if (!json.ok || !json.state) throw new Error("bad payload");
      if (signal.aborted) return { ok: false }; // superseded while it was in flight: whatever replaced it is newer
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
      setLoaded(true);
      return { ok: true };
    } catch {
      if (!signal.aborted) setLoaded(true);
      return { ok: false };
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
    }
  }, []);

  // The poll loop (see ArenaPoller for what it guarantees) with boundary-aware scheduling (see planNextPoll).
  const pollerRef = useRef<ArenaPoller | null>(null);
  useEffect(() => {
    let overdueStreak = 0;
    const poller = new ArenaPoller(
      {
        fetchOnce,
        planAfterSuccess: (heldFor) => {
          const s = stateRef.current;
          const now = Date.now() + offset.current;
          overdueStreak = s?.current?.slotEndsAt != null && now >= s.current.slotEndsAt ? overdueStreak + 1 : 0;
          const recent = samples.current.slice(-3);
          const rttMs = recent.length ? recent.reduce((a, x) => a + x.rtt, 0) / recent.length : 120;
          // How long the server takes to build an ordinary snapshot (held requests are excluded: their time is the wait).
          const serverMs = typicalServerMs(dwells.current);
          return planNextPoll({ state: s, now, ok: true, failures: 0, overdueStreak, rttMs, serverMs, heldFor });
        },
        onConnection: (next) => {
          if (next === "reconnecting") overdueStreak = 0;
          setConnection(next);
        },
      },
      { now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), random: Math.random },
    );
    pollerRef.current = poller;
    // A server-rendered state is fresh when the page was just loaded (look again in 1.5 s). One that is OLD — the router re-mounted the page from its cache on a
    // Back navigation — gets its fresh look immediately.
    poller.start(initial && Math.abs(Date.now() - initial.serverTime) < 5_000 ? 1500 : 0);
    const onVisible = () => {
      if (document.visibilityState === "visible") poller.trigger("visible");
    };
    // Telemetry: hidden/visible transitions, so a throttled background tab is never mistaken for lag.
    const mark = () => telemetry.push({ kind: "visibility", clientAt: Date.now(), serverAt: Date.now() + offset.current, battleId: null, flag: document.visibilityState !== "visible" });
    exposeTelemetry();
    mark();
    document.addEventListener("visibilitychange", mark);
    document.addEventListener("visibilitychange", onVisible);
    // A tab that was frozen or throttled (hidden, bfcache, a sleeping laptop, a network drop) resyncs to the LIVE battle the
    // instant it can — it never replays what it missed and never rewinds the arena: everything on screen is a pure function
    // of the synced server clock, so one fresh snapshot is all it takes. These events arrive in bursts; the poller turns a burst into ONE request.
    const resyncPageshow = () => poller.trigger("pageshow");
    const resyncOnline = () => poller.trigger("online");
    const resyncFocus = () => poller.trigger("focus");
    window.addEventListener("pageshow", resyncPageshow);
    window.addEventListener("online", resyncOnline);
    window.addEventListener("focus", resyncFocus);
    return () => {
      window.removeEventListener("pageshow", resyncPageshow);
      window.removeEventListener("online", resyncOnline);
      window.removeEventListener("focus", resyncFocus);
      document.removeEventListener("visibilitychange", mark);
      document.removeEventListener("visibilitychange", onVisible);
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [fetchOnce, initial]);

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
    // "Not yet" (404) is the expected answer until combat starts: retry fast. A real failure (5xx, network) backs off — a degraded database must not be hammered 3×/s.
    const load = async (attempt: number, failures: number) => {
      let notYet = false;
      try {
        const res = await fetch(`/api/arena/battles/${currentId}/replay`, { signal: AbortSignal.timeout(10_000) }); // never hangs: a timeout is a failure like any other (backs off, retries)
        notYet = res.status === 404;
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { replay: ReplayDto };
        if (cancelled) return;
        replays.current.set(currentId, json.replay);
        if (replays.current.size > 6) replays.current.delete(replays.current.keys().next().value as string);
        setReplayState({ id: currentId, replay: json.replay });
      } catch {
        if (cancelled || attempt >= 60) return;
        const failed = notYet ? failures : failures + 1;
        const delay = notYet ? (attempt < 4 ? 120 : 300) : Math.round(Math.min(8000, 1000 * 2 ** (failed - 1)) * (0.75 + Math.random() * 0.5));
        timer = setTimeout(() => void load(attempt + 1, failed), delay);
      }
    };
    const wait = combatStartsAt ? Math.max(0, combatStartsAt - (Date.now() + offset.current) - 150) : 0;
    timer = setTimeout(() => void load(0, 0), wait);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [currentId, combatStartsAt]);

  const online = connection !== "reconnecting";
  return { state, replay: replayState && replayState.id === currentId ? replayState.replay : null, online, connection, loaded, getNow, refresh: () => pollerRef.current?.trigger("manual") };
}
