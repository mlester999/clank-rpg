/**
 * ARENA CHAT — how a message's age is written. The instant itself is a server-generated UTC timestamp (`created_at`); this only decides the label.
 *
 *   under a minute  Just now        a minute…an hour   1m ago · 15m ago        an hour…a day   1h ago · 2h ago
 *   a day…a week    1d ago · 2d ago   older            Oct 2  (this year)  ·  Oct 2, 2025  (an earlier year)
 *
 * A message "from the future" (the viewer's clock is behind the server's) is "Just now", never a negative age.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeTime(atMs: number, nowMs: number, timeZone?: string): string {
  const age = nowMs - atMs;
  if (!Number.isFinite(age) || age < MIN) return "Just now";
  if (age < HOUR) return `${Math.floor(age / MIN)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d ago`;
  const sameYear = new Date(atMs).getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), ...(timeZone ? { timeZone } : {}) }).format(new Date(atMs));
}

/** The exact moment, for a tooltip ("Oct 8, 2026, 3:04:05 PM"), in the viewer's own time zone unless one is given. */
export function exactTime(atMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium", ...(timeZone ? { timeZone } : {}) }).format(new Date(atMs));
}

/** Milliseconds until the label of a message of this age next changes (so a ticker never wakes more often than it must). */
export function nextLabelChangeMs(atMs: number, nowMs: number): number {
  const age = Math.max(0, nowMs - atMs);
  const unit = age < HOUR ? MIN : age < DAY ? HOUR : DAY;
  return unit - (age % unit) || unit;
}
