/**
 * ONE shared clock for every countdown on a page. Each countdown used to run its own interval and re-render whatever contained it; now there is a single
 * 250 ms ticker (only while somebody is subscribed) and a countdown's subscription re-renders ONLY its own small text when the text it shows changes —
 * once a second. Nothing here polls the network and nothing reads the wall clock: a countdown is `server time at fetch + this browser's MONOTONIC delta`.
 */
type Listener = () => void;

const TICK_MS = 250;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;

const emit = (): void => {
  for (const l of [...listeners]) l();
};
// A tab coming back from the background (or a laptop waking up) re-evaluates immediately instead of waiting for the next tick.
const wake = (): void => {
  if (typeof document === "undefined" || document.visibilityState === "visible") emit();
};

export function subscribeClock(listener: Listener): () => void {
  listeners.add(listener);
  if (timer === null && typeof window !== "undefined") {
    timer = setInterval(emit, TICK_MS);
    document.addEventListener("visibilitychange", wake);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", wake);
    }
  };
}

/** How many countdowns are listening right now (tests, and a guard that nothing leaks). */
export const clockSubscribers = (): number => listeners.size;
/** Is the shared ticker running (it must stop when the last countdown unmounts)? */
export const clockRunning = (): boolean => timer !== null;

/** The browser's monotonic timer (not the wall clock). 0 on the server. */
export const monotonicNow = (): number => (typeof performance !== "undefined" ? performance.now() : 0);
