"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { formatResetCountdown } from "@/domain/time/resetCountdown";

import { monotonicNow, subscribeClock } from "./clockStore";

/**
 * THE countdown: "23H 59M 59S" · "06D 23H 59M". Anchored to the SERVER's clock — `serverNow` is the server's time when the data arrived, and from then on
 * the browser adds only its own monotonic elapsed time — so a wrong device clock, another timezone or a clock changed mid-session cannot change what it shows.
 * A countdown never authorises anything: when it reaches zero it only calls `onElapsed` (once per `endsAt`), and the caller asks the SERVER what is true now.
 *
 * It is a leaf: it subscribes to the one shared ticker (`clockStore`) and re-renders only itself, once a second — never the board, panel or page around it.
 * Server render and first client render show the same text (`endsAt − serverNow`), so there is no hydration mismatch.
 */
export interface ResetCountdownProps {
  /** The server's clock (ms) when this data was built. */
  serverNow: number;
  /** The instant it ends (ms, UTC). */
  endsAt: number;
  /** A timer that can exceed a day (Weekly) switches to "DD HH MM" while a whole day is left; a Daily timer never shows days. */
  allowDays?: boolean;
  /** Called once when the countdown reaches zero (per `endsAt`). */
  onElapsed?: () => void;
  className?: string;
  /** The accessible name, e.g. "Daily leaderboard ends in" (the text is the value). */
  label: string;
  testId?: string;
}

export function ResetCountdown({ serverNow, endsAt, allowDays = false, onElapsed, className, label, testId }: ResetCountdownProps) {
  const [anchor, setAnchor] = useState(() => ({ serverNow, mono: monotonicNow() }));
  if (anchor.serverNow !== serverNow) setAnchor({ serverNow, mono: monotonicNow() }); // the server told us the time again: restart from it
  const remainingNow = (): number => endsAt - (anchor.serverNow + (monotonicNow() - anchor.mono));

  const text = useSyncExternalStore(
    subscribeClock,
    () => formatResetCountdown(remainingNow(), { allowDays }),
    () => formatResetCountdown(endsAt - serverNow, { allowDays }),
  );

  // zero → tell the caller, once per target
  const latest = useRef({ onElapsed, remainingNow });
  useEffect(() => {
    latest.current = { onElapsed, remainingNow };
  });
  const firedFor = useRef<number | null>(null);
  useEffect(() => {
    const check = (): void => {
      if (firedFor.current === endsAt || latest.current.remainingNow() > 0) return;
      firedFor.current = endsAt;
      latest.current.onElapsed?.();
    };
    check();
    return subscribeClock(check);
  }, [endsAt]);

  return (
    <span role="timer" aria-label={label} className={`tnum ${className ?? ""}`} data-testid={testId} data-ends-at={endsAt} data-remaining-ms={Math.max(0, Math.round(remainingNow()))} suppressHydrationWarning>
      {text}
    </span>
  );
}
