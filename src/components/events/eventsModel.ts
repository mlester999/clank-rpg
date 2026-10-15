import { EVENT_KINDS, EVENT_PROGRAMS, type EventKind, type EventProgram, type PeriodDto } from "@/domain/events";

/**
 * THE EVENTS PAGE — its navigation as a pure model (no React), so the structure can be tested and a state can be shared as a link:
 *
 *   /events?program=picks|hero&kind=daily|weekly&period=YYYY-MM-DD
 *
 * `period` opens that completed period's full results (the Top 10) — a stable link to a finalized result.
 */
export interface EventsViewState {
  program: EventProgram;
  kind: EventKind;
  /** The period whose full results are open (a UTC date), or null. */
  period: string | null;
}

export const DEFAULT_EVENTS: EventsViewState = { program: "picks", kind: "daily", period: null };

export const PROGRAM_TABS: ReadonlyArray<{ id: EventProgram; label: string; kicker: string }> = [
  { id: "picks", label: "Arena Picks", kicker: "Players" },
  { id: "hero", label: "Hero Arena", kicker: "Heroes" },
];

export const KIND_TABS: ReadonlyArray<{ id: EventKind; label: string }> = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseEvents(params: Record<string, string | string[] | undefined> | URLSearchParams): EventsViewState {
  const get = (k: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const program = (EVENT_PROGRAMS as readonly string[]).includes(get("program") ?? "") ? (get("program") as EventProgram) : DEFAULT_EVENTS.program;
  const kind = (EVENT_KINDS as readonly string[]).includes(get("kind") ?? "") ? (get("kind") as EventKind) : DEFAULT_EVENTS.kind;
  const period = get("period");
  return { program, kind, period: period && DATE.test(period) && !Number.isNaN(Date.parse(`${period}T00:00:00Z`)) ? period : null };
}

/** The shareable query string of a state ("" for the default, so the plain page URL stays clean). */
export function eventsQuery(state: EventsViewState): string {
  const q = new URLSearchParams();
  if (state.program !== DEFAULT_EVENTS.program) q.set("program", state.program);
  if (state.kind !== DEFAULT_EVENTS.kind) q.set("kind", state.kind);
  if (state.period) q.set("period", state.period);
  const s = q.toString();
  return s ? `?${s}` : "";
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "2026-10-14" → "OCT 14" (a calendar label for a UTC date — never converted through the viewer's timezone). */
export function dayLabel(start: string): string {
  const [, m, d] = start.split("-");
  return `${MONTHS[Number(m) - 1] ?? "?"} ${Number(d)}`;
}

/** "OCT 14" for a daily period, "WEEK OF OCT 12" for a weekly one. */
export const periodLabelOf = (kind: EventKind, start: string): string => (kind === "daily" ? dayLabel(start) : `WEEK OF ${dayLabel(start)}`);

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dm = (d: Date): string => `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
const dmy = (d: Date): string => `${dm(d)} ${d.getUTCFullYear()}`;

/**
 * "Wednesday 14 October 2026" / "12 October – 18 October 2026" — composed by hand from the UTC calendar date, so the same text appears in every timezone, locale and
 * ICU build (an Intl formatter would punctuate it differently from one Node/browser to the next).
 */
export function longPeriodLabel(kind: EventKind, start: string): string {
  const first = new Date(Date.parse(`${start}T00:00:00Z`));
  if (kind === "daily") return `${WEEKDAYS[first.getUTCDay()]} ${dmy(first)}`;
  const last = new Date(first.getTime() + 6 * 86_400_000);
  return `${first.getUTCFullYear() === last.getUTCFullYear() ? dm(first) : dmy(first)} – ${dmy(last)}`;
}

/** The title of a champion: "#1 DAILY CHAMPION" (Arena Picks) / "#1 WEEKLY HERO" (Hero Arena). */
export function championTitle(program: EventProgram, kind: EventKind, joint: boolean): string {
  const word = kind === "daily" ? "DAILY" : "WEEKLY";
  if (program === "hero") return joint ? `JOINT ${word} HEROES` : `#1 ${word} HERO`;
  return joint ? `JOINT ${word} CHAMPIONS` : `#1 ${word} CHAMPION`;
}

/** What a period that has no champion says, in the spec's words. */
export function outcomeHeadline(outcome: PeriodDto["outcome"]): string {
  switch (outcome) {
    case "NO_ELIGIBLE_WINNER":
      return "NO ELIGIBLE WINNER";
    case "NO_COMPLETED_RESULTS":
      return "NO COMPLETED RESULTS";
    case "FINALIZING":
      return "FINALIZING";
    default:
      return "";
  }
}
