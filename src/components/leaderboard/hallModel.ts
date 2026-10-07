/**
 * THE HALL OF CHAMPIONS — its navigation as a pure model (no React), so the structure can be tested and a state can be shared as a link.
 *
 *   ARENA PICKS   the PLAYER competition — Daily / Weekly are REWARDED, Season is standings only
 *   HERO ARENA    the HERO competition   — Daily / Weekly are REWARDED, Season is standings only (ranked by Arena Wins)
 *   HERO RECORDS  statistics only         — Top-2, KOs (Daily / Weekly / Season) and current PWR: no prizes, ever
 *
 * One scope selector (Daily · Weekly · Season) is shared by every section; the rewarded competitions are visibly separate from the informational records.
 */
export type HallSection = "picks" | "hero-arena" | "records";
export type HallScope = "daily" | "weekly" | "season";
export type HallMetric = "top2" | "kos" | "pwr";

export interface HallState {
  section: HallSection;
  scope: HallScope;
  metric: HallMetric;
}

export const HALL_SECTIONS: ReadonlyArray<{ id: HallSection; label: string; kicker: string; tag: "REWARDED" | "STATS"; blurb: string }> = [
  { id: "picks", label: "Arena Picks", kicker: "Player competition", tag: "REWARDED", blurb: "Predict the winner. Earn from good Picks." },
  { id: "hero-arena", label: "Hero Arena", kicker: "Hero competition", tag: "REWARDED", blurb: "Win Arena fights. Your hero earns." },
  { id: "records", label: "Hero Records", kicker: "Statistics", tag: "STATS", blurb: "Top-2, KOs and PWR. Bragging rights." },
];

export const HALL_SCOPES: ReadonlyArray<{ id: HallScope; label: string }> = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "season", label: "Season" },
];

export const HALL_METRICS: ReadonlyArray<{ id: HallMetric; label: string }> = [
  { id: "top2", label: "Top-2" },
  { id: "kos", label: "KOs" },
  { id: "pwr", label: "PWR" },
];

export const DEFAULT_HALL: HallState = { section: "picks", scope: "daily", metric: "top2" };

const pick = <T extends string>(allowed: ReadonlyArray<{ id: T }>, value: string | null | undefined, fallback: T): T => (allowed.find((a) => a.id === value)?.id ?? fallback);

/** A (possibly hand-edited, possibly missing) query string → a valid state. Anything unknown falls back to the default. */
export function parseHall(params: Record<string, string | string[] | undefined> | URLSearchParams): HallState {
  const get = (k: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const section = pick(HALL_SECTIONS, get("section"), DEFAULT_HALL.section);
  const metric = pick(HALL_METRICS, get("metric"), DEFAULT_HALL.metric);
  // Records default to the season view (a record is a season's story); the rewarded sections open on today's board.
  const scope = pick(HALL_SCOPES, get("scope"), section === "records" ? "season" : DEFAULT_HALL.scope);
  return { section, scope, metric };
}

/** The shareable query string of a state ("" for the default, so the plain page URL stays clean). */
export function hallQuery(state: HallState): string {
  const q = new URLSearchParams();
  if (state.section !== DEFAULT_HALL.section) q.set("section", state.section);
  const defaultScope = state.section === "records" ? "season" : DEFAULT_HALL.scope;
  if (state.scope !== defaultScope) q.set("scope", state.scope);
  if (state.section === "records" && state.metric !== DEFAULT_HALL.metric) q.set("metric", state.metric);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Which scopes a view offers: PWR is a CURRENT figure, not an event that accumulates, so it has none. */
export const scopesOf = (state: HallState): ReadonlyArray<{ id: HallScope; label: string }> => (state.section === "records" && state.metric === "pwr" ? [] : HALL_SCOPES);

/** Does this view pay? Only the Daily and Weekly boards of the two competitions. */
export const isRewardedView = (state: HallState): boolean => state.section !== "records" && state.scope !== "season";
