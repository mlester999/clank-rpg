"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ArenaPhase } from "./ArenaRenderer";

/** The member's own pick (mirrors the server's PickView). `battleId` is the battle that was PREDICTED. */
export interface MyPick {
  battleId: string;
  characterId: string;
  submittedAt: number;
  changedCount: number;
  locked: boolean;
  result: "CORRECT" | "INCORRECT" | "VOID" | null;
  rewardGold: number;
  rewardEligible: boolean;
}

/**
 * What a battle's pick round says. `locked` and `distribution` are the SERVER's: the window is closed (the battle on stage was
 * decided, or this battle took the stage) and, only then, the crowd. `outcome` appears once the battle is over.
 */
export interface PickRound {
  locked: boolean;
  distribution: { total: number; byCharacter: Record<string, number> } | null;
  outcome: {
    result: "CORRECT" | "INCORRECT" | "VOID";
    winnerCharacterId: string | null;
    /** Clank Points earned for this pick. */
    points: number;
    /** The leaderboards: every valid pick counts, so this is simply the leaderboard Points it added (null until scored). */
    board: { points: number } | null;
    /** `true` while the settlement that credits the pick has not run yet. */
    pending: boolean;
  } | null;
}

export interface PickEligibility {
  eligible: boolean;
  reason: "NO_HERO" | "BELOW_THRESHOLD" | "NOT_ELIGIBLE" | null;
  explanation: string;
}

export type PickErrorCode = "LOCKED" | "NOT_OPEN" | "RESOLVED" | "NOT_A_FIGHTER" | "NOT_FOUND" | "PICKS_DISABLED" | "UNAUTHENTICATED" | "NOT_ELIGIBLE" | "REWARDS_UNAVAILABLE" | "RATE_LIMITED" | "NETWORK";

/** A member's pick on ONE battle, with that battle's round. */
export interface BattlePick {
  pick: MyPick | null;
  round: PickRound | null;
}

export interface PicksApi {
  /** null = not known yet; false = visitor is not signed in. */
  signedIn: boolean | null;
  eligibility: PickEligibility | null;
  /** The pick on the UPCOMING battle — the one this panel is about. */
  pick: MyPick | null;
  round: PickRound | null;
  /** The member's pick on the battle that is on stage NOW (made while it was upcoming), and — once it is decided — how it turned out. */
  current: BattlePick;
  pendingCharacterId: string | null;
  error: PickErrorCode | null;
  /** The explanation the server attached to the last refusal (for NOT_ELIGIBLE). */
  errorDetail: string | null;
  submit: (characterId: string) => Promise<void>;
  clearError: () => void;
}

const MESSAGES: Record<PickErrorCode, string> = {
  LOCKED: "Picks for this fight are locked.",
  NOT_OPEN: "This fight isn't open for picks yet.",
  RESOLVED: "This fight is already decided.",
  NOT_A_FIGHTER: "That hero isn't fighting in this battle.",
  NOT_FOUND: "That battle could not be found.",
  PICKS_DISABLED: "Arena Picks are switched off right now.",
  UNAUTHENTICATED: "Sign in with Telegram to make your Pick.",
  NOT_ELIGIBLE: "Your account can't make rewarded Picks yet.",
  REWARDS_UNAVAILABLE: "Arena Picks aren't available yet.",
  RATE_LIMITED: "Slow down — too many Picks. Try again in a moment.",
  NETWORK: "Couldn't reach the server. Try again.",
};
export const pickMessage = (code: PickErrorCode): string => MESSAGES[code];

interface Stored extends BattlePick {
  signedIn: boolean | null;
  eligibility: PickEligibility | null;
}

interface PicksResponse {
  signedIn: boolean;
  eligibility: PickEligibility | null;
  pick: MyPick | null;
  round: PickRound;
}

const EMPTY: BattlePick = { pick: null, round: null };

/**
 * The signed-in member's Picks. Two battles matter at any moment, and they are never confused:
 *   · `upcomingId` — the battle that fights NEXT. It is the only pick target. The server alone decides whether its window is open
 *     (it closes when the battle on stage is decided); this hook just talks to it and shows its answer.
 *   · `currentId`  — the battle on stage. Picks can no longer change; it is read only to show the member what they picked and,
 *     once the arena has decided and settled it, how that turned out (with a few patient retries until the settlement has run).
 * When the upcoming battle takes the stage its stored pick is simply what `currentId` selects — nothing is refetched or lost.
 *
 * `enabled` = the server says Arena Picks exist right now (flag on). `windowStatus` is the server's verdict for the upcoming
 * battle: when it flips to LOCKED the round is fetched once more (the crowd is released at that moment, never before).
 */
export function usePicks(upcomingId: string | null, currentId: string | null, enabled: boolean, phase: ArenaPhase, windowStatus: "OPEN" | "LOCKED" | null): PicksApi {
  const [byBattle, setByBattle] = useState<Record<string, Stored>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<PickErrorCode | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const latestUpcoming = useRef<string | null>(upcomingId);
  useEffect(() => {
    latestUpcoming.current = upcomingId;
  });

  /** Asks the server what this member has on a battle. Pure I/O: the caller decides whether the answer is still wanted. */
  const fetchBattle = useCallback(async (id: string): Promise<Stored | null> => {
    try {
      const res = await fetch(`/api/arena/picks?battleId=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) return null;
      const json = (await res.json()) as PicksResponse;
      return { signedIn: json.signedIn, eligibility: json.eligibility, pick: json.pick, round: json.round };
    } catch {
      return null; // the next trigger tries again
    }
  }, []);
  const store = useCallback((id: string, next: Stored) => setByBattle((all) => ({ ...trim(all, id), [id]: next })), []);
  /** Fetch + store (fire and forget; for event handlers). */
  const load = useCallback((id: string): void => void fetchBattle(id).then((s) => s && store(id, s)), [fetchBattle, store]);

  // A battle becomes the upcoming one (or the one on stage): fetch what the member has on it, once, unless we already know.
  const known = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    for (const id of [upcomingId, currentId]) {
      if (id && !known.current.has(id)) {
        known.current.add(id);
        void fetchBattle(id).then((s) => s && store(id, s));
      }
    }
  }, [upcomingId, currentId, enabled, fetchBattle, store]);

  // The server closed the upcoming battle's window: pick up the closed round (and the crowd, which it releases only now).
  useEffect(() => {
    if (!upcomingId || !enabled || windowStatus !== "LOCKED") return;
    let cancelled = false;
    void fetchBattle(upcomingId).then((s) => {
      if (!cancelled && s) store(upcomingId, s);
    });
    return () => {
      cancelled = true;
    };
  }, [upcomingId, enabled, windowStatus, fetchBattle, store]);

  // The battle on stage is over on the clock: the arena decides + settles it, then the rewards settle — pull the member's outcome
  // with a few patient retries.
  const decided = phase === "VICTORY" || phase === "RESULTS" || phase === "DONE";
  const current = currentId ? byBattle[currentId] ?? null : null;
  const waiting = Boolean(current?.pick) && (current?.round?.outcome == null || current.round.outcome.pending);
  useEffect(() => {
    if (!currentId || !enabled || !decided || !waiting) return;
    let cancelled = false;
    const timers = [400, 1200, 2600, 4500, 7000].map((ms) =>
      setTimeout(() => {
        if (cancelled) return;
        void fetchBattle(currentId).then((s) => {
          if (!cancelled && s) store(currentId, s);
        });
      }, ms),
    );
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [currentId, enabled, decided, waiting, fetchBattle, store]);

  const upcoming = upcomingId ? byBattle[upcomingId] ?? null : null;

  const submit = useCallback(
    async (characterId: string) => {
      const id = latestUpcoming.current;
      if (!id) return;
      setError(null);
      setErrorDetail(null);
      setPending(characterId);
      const previous = byBattle[id] ?? null;
      // Optimistic: the row flips to YOUR PICK immediately; the server's answer replaces it (and a refusal puts the old state back).
      setByBattle((all) => ({
        ...all,
        [id]: {
          signedIn: true,
          eligibility: previous?.eligibility ?? null,
          round: previous?.round ?? null,
          pick: { battleId: id, characterId, submittedAt: Date.now(), changedCount: 0, locked: false, result: null, rewardGold: 0, rewardEligible: true },
        },
      }));
      const restore = () =>
        setByBattle((all) => {
          const next = { ...all };
          if (previous) next[id] = previous;
          else delete next[id];
          return next;
        });
      try {
        const res = await fetch("/api/arena/picks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ battleId: id, characterId }) });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; pick?: MyPick; error?: PickErrorCode; message?: string };
        if (res.ok && json.pick) {
          setByBattle((all) => ({ ...all, [id]: { signedIn: true, eligibility: all[id]?.eligibility ?? null, round: all[id]?.round ?? null, pick: json.pick as MyPick } }));
        } else {
          restore();
          const code = json.error ?? "NETWORK";
          setError(code);
          if (json.message) setErrorDetail(json.message);
          if (code === "UNAUTHENTICATED") setByBattle((all) => ({ ...all, [id]: { signedIn: false, eligibility: null, pick: null, round: null } }));
          // The server's window is the authority: it refused, so look at what it says now (it will say LOCKED).
          if (code === "LOCKED" || code === "NOT_OPEN") void load(id);
        }
      } catch {
        restore();
        setError("NETWORK");
      } finally {
        setPending(null);
      }
    },
    [byBattle, load],
  );

  return useMemo(
    () => ({
      signedIn: upcoming?.signedIn ?? current?.signedIn ?? null,
      eligibility: upcoming?.eligibility ?? current?.eligibility ?? null,
      pick: upcoming?.pick ?? null,
      round: upcoming?.round ?? null,
      current: current ? { pick: current.pick, round: current.round } : EMPTY,
      pendingCharacterId: pending,
      error,
      errorDetail,
      submit,
      clearError: () => {
        setError(null);
        setErrorDetail(null);
      },
    }),
    [upcoming, current, pending, error, errorDetail, submit],
  );
}

/** Keeps the per-battle cache small: only the few most recent battles are ever needed. */
function trim(all: Record<string, Stored>, keep: string): Record<string, Stored> {
  const ids = Object.keys(all);
  if (ids.length < 6) return all;
  const out: Record<string, Stored> = {};
  for (const id of ids.slice(-4)) if (id !== keep) out[id] = all[id] as Stored;
  return out;
}
