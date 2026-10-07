/**
 * HOLDER VERIFICATION SCHEDULE. Each connected wallet carries its own `next_check_at`; the 1-minute tick re-reads only a bounded
 * batch of wallets that are due, so the chain is never asked about every wallet every minute.
 *
 *  · after a SUCCESS the next check is ~`holderRefreshMinutes` away, with ± jitter so wallets do not all fall due in the same minute;
 *  · after a FAILURE the wallet backs off (5 min, 10, 20 …) but never beyond the normal interval, and the failures are counted.
 */
const MIN_MS = 60_000;

/** `intervalMinutes` ± `jitterPct` percent. `random01` is a number in [0, 1) (injectable so tests are deterministic). */
export function nextCheckDelayMs(intervalMinutes: number, jitterPct: number, random01: number): number {
  const base = intervalMinutes * MIN_MS;
  const spread = base * (Math.min(Math.max(jitterPct, 0), 100) / 100);
  return Math.max(MIN_MS, Math.round(base - spread + 2 * spread * Math.min(Math.max(random01, 0), 0.999999)));
}

/** Delay before retrying after `failures` consecutive failed reads (1 = the first failure). */
export function failureBackoffMs(failures: number, intervalMinutes: number): number {
  const exp = Math.min(Math.max(failures, 1), 10) - 1;
  return Math.min(5 * MIN_MS * 2 ** exp, intervalMinutes * MIN_MS);
}

/** True when a verification is too old to trust: the member is treated as FREE for NEW reward eligibility until it is refreshed. */
export const isVerificationStale = (verifiedAtMs: number | null, nowMs: number, maxAgeHours: number): boolean => verifiedAtMs === null || nowMs - verifiedAtMs > maxAgeHours * 3_600_000;
