/** All reward periods are UTC. The DAILY board runs 00:00 UTC → next 00:00 UTC; the WEEKLY board runs Monday 00:00 UTC → next Monday 00:00 UTC. Never the viewer's timezone. */
const DAY_MS = 86_400_000;

export const utcDate = (ms: number): string => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
export const nextUtcMidnight = (ms: number): number => (Math.floor(ms / DAY_MS) + 1) * DAY_MS;

/** The Monday (00:00 UTC, as YYYY-MM-DD) of the week containing `ms`. */
export function utcWeekStart(ms: number): string {
  const dayIndex = Math.floor(ms / DAY_MS); // days since 1970-01-01 (a Thursday)
  const sinceMonday = (dayIndex + 3) % 7; // 0 = Monday
  return new Date((dayIndex - sinceMonday) * DAY_MS).toISOString().slice(0, 10);
}
export const nextUtcWeekStart = (ms: number): number => Date.parse(`${utcWeekStart(ms)}T00:00:00.000Z`) + 7 * DAY_MS;

/** The canonical weekly window containing `ms`: Monday 00:00:00.000 UTC → next Monday 00:00:00.000 UTC (end exclusive). Never the viewer's timezone. */
export interface WeekWindow {
  /** The Monday as YYYY-MM-DD (the week's identifier). */
  weekStart: string;
  startsAt: number;
  endsAt: number;
}

export function weekWindow(ms: number): WeekWindow {
  const weekStart = utcWeekStart(ms);
  const startsAt = Date.parse(`${weekStart}T00:00:00.000Z`);
  return { weekStart, startsAt, endsAt: startsAt + 7 * DAY_MS };
}

/** True when `week` is a valid Monday identifier (YYYY-MM-DD). */
export const isWeekStart = (week: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(week) && !Number.isNaN(Date.parse(`${week}T00:00:00Z`)) && utcWeekStart(Date.parse(`${week}T00:00:00Z`)) === week;

/** The Monday identifier of the week before `week`. */
export const previousWeekStart = (week: string): string => new Date(Date.parse(`${week}T00:00:00.000Z`) - 7 * DAY_MS).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------------
// One vocabulary for both leaderboards
// ---------------------------------------------------------------------------------------------------------------------
export type PeriodKind = "DAILY" | "WEEKLY";
export const PERIOD_KINDS: readonly PeriodKind[] = ["DAILY", "WEEKLY"];
export const isPeriodKind = (v: unknown): v is PeriodKind => v === "DAILY" || v === "WEEKLY";

/** A leaderboard period: [startsAt, endsAt) in UTC, identified by its start date (YYYY-MM-DD; a Monday for WEEKLY). */
export interface PeriodWindow {
  kind: PeriodKind;
  /** The identifier: the UTC date the period starts on. */
  start: string;
  startsAt: number;
  endsAt: number;
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const spanMs = (kind: PeriodKind): number => (kind === "DAILY" ? DAY_MS : 7 * DAY_MS);

/** The period of `kind` containing `ms`. */
export function periodWindow(kind: PeriodKind, ms: number): PeriodWindow {
  const startsAt = kind === "DAILY" ? Math.floor(ms / DAY_MS) * DAY_MS : weekWindow(ms).startsAt;
  return { kind, start: isoDate(startsAt), startsAt, endsAt: startsAt + spanMs(kind) };
}

/** True when `start` is a valid identifier for `kind`: a real UTC date (a Monday for WEEKLY). */
export function isPeriodStart(kind: PeriodKind, start: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return false;
  const ms = Date.parse(`${start}T00:00:00Z`);
  if (Number.isNaN(ms) || isoDate(ms) !== start) return false;
  return kind === "DAILY" || utcWeekStart(ms) === start;
}

/** The window of the period identified by `start` (callers validate with `isPeriodStart` first). */
export function periodWindowOf(kind: PeriodKind, start: string): PeriodWindow {
  const startsAt = Date.parse(`${start}T00:00:00.000Z`);
  return { kind, start, startsAt, endsAt: startsAt + spanMs(kind) };
}

/** The identifier of the period before `start`. */
export const previousPeriodStart = (kind: PeriodKind, start: string): string => isoDate(Date.parse(`${start}T00:00:00.000Z`) - spanMs(kind));

/** True when the period has ended (its end is at or before `nowMs`) — it can be finalized. */
export const periodHasEnded = (kind: PeriodKind, start: string, nowMs: number): boolean => periodWindowOf(kind, start).endsAt <= nowMs;

/** The first period boundary of `kind` at or after `ms` (the earliest period a requirement that ends at `ms` can still count for). */
export function firstPeriodStartAtOrAfter(kind: PeriodKind, ms: number): number {
  const w = periodWindow(kind, ms);
  return w.startsAt === ms ? ms : w.endsAt;
}
