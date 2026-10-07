"use client";

import { useEffect, useRef, useState } from "react";

import { anchorServerClock, countdownParts, formatCountdown, serverNowFrom, type CountdownParts } from "@/domain/rewards/leaderboard";

/**
 * A live countdown to `endsAt` that is anchored to the SERVER's clock, not the viewer's. The server says "it is `serverNow`";
 * the browser remembers its own MONOTONIC timer at that instant and from then on estimates `serverNow + (monotonic delta)`. A
 * user whose clock is wrong, in another timezone, or changed mid-session sees exactly the same countdown as everyone else, and
 * nobody can "reset" a leaderboard by touching their clock. When it reaches zero `onElapsed` fires ONCE per target (the caller
 * re-fetches: the next day / week is already running on the server).
 */
/** `withDays: false` formats a DAILY countdown ("14H 23M 18S"); the default is the weekly "6D 23H 59M 59S". */
export function useServerCountdown(opts: { serverNow: number; endsAt: number; active: boolean; onElapsed: () => void; withDays?: boolean }): { parts: CountdownParts; text: string; remainingMs: number } {
  const { serverNow, endsAt, active, onElapsed, withDays = true } = opts;
  // The estimate of the server's clock. It restarts at the server's own value whenever the server tells us the time again.
  const [estimate, setEstimate] = useState(serverNow);
  const [seen, setSeen] = useState(serverNow);
  if (seen !== serverNow) {
    setSeen(serverNow);
    setEstimate(serverNow);
  }

  useEffect(() => {
    if (!active) return;
    const anchor = anchorServerClock(serverNow, performance.now());
    const id = window.setInterval(() => setEstimate(serverNowFrom(anchor, performance.now())), 250);
    return () => window.clearInterval(id);
  }, [serverNow, active]);

  const remainingMs = endsAt - estimate;
  const parts = countdownParts(remainingMs);

  const firedFor = useRef<number | null>(null);
  const elapsed = useRef(onElapsed);
  useEffect(() => {
    elapsed.current = onElapsed;
    if (active && parts.done && firedFor.current !== endsAt) {
      firedFor.current = endsAt;
      elapsed.current();
    }
  });

  return { parts, text: formatCountdown(parts, { withDays }), remainingMs };
}
