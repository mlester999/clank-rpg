"use client";

import type { OfficialSeasonStatus } from "@/server/services/lifecycle";

import { Card, fmtDate } from "./adminUi";

/** SEASON 1 once it is running: the official start, the official counts, the leaderboard and Events finalization status and any auditor finding. Read-only. */
export function OfficialSeasonCard({ status }: { status: OfficialSeasonStatus | null }) {
  if (!status) return <Card title="Official season"><p className="text-sm text-steel-300">Loading…</p></Card>;
  if (!status.season) {
    return <Card title="Official season"><p className="text-sm text-steel-300" data-testid="official-none">The game is LIVE but no season is active — create the next one when ready.</p></Card>;
  }
  const e = status.events;
  const clean = status.auditFindings.length === 0;
  const stat = (label: string, value: string, sub?: string, testId?: string) => (
    <div className="min-w-0 rounded-md border border-white/10 bg-white/5 p-2.5" data-testid={testId}>
      <p className="label">{label}</p>
      <p className="mt-0.5 font-display text-lg text-paper tnum">{value}</p>
      {sub && <p className="mt-0.5 text-[0.66rem] break-words text-steel-400">{sub}</p>}
    </div>
  );
  return (
    <Card title={`${status.season.label} status`} actions={<span className={`chip ${clean ? "border-teal/40 bg-teal/10 text-teal" : "border-danger/40 bg-danger/10 text-danger"}`} data-testid="official-audit">{clean ? "Audit clean" : `${status.auditFindings.length} finding(s)`}</span>}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" data-testid="official-tiles">
        {stat("Official start", fmtDate(status.season.startsAt), status.launchedBy ? `launched by ${status.launchedBy}` : undefined, "official-start")}
        {stat("Official matches", status.officialMatches.toLocaleString(), `${status.heroesWithRecords.toLocaleString()} hero(es) with a record`, "official-matches")}
        {stat("Official Picks", status.officialPicks.toLocaleString(), `${status.scoredPicks.toLocaleString()} scored`, "official-picks")}
        {stat("Leaderboard boards", `${status.boards.picks + status.boards.hero}`, `${status.boards.picks} Arena Picks · ${status.boards.hero} Hero Arena frozen`, "official-boards")}
        {stat("Events finalization", `${e.completedDaily} day(s) · ${e.completedWeekly} week(s)`, `champions crowned — Picks ${e.champions.picksDaily} daily / ${e.champions.picksWeekly} weekly · Hero Arena ${e.champions.heroDaily} daily / ${e.champions.heroWeekly} weekly`, "official-events")}
      </div>
      {!clean && (
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-danger" data-testid="official-findings">{status.auditFindings.slice(0, 8).map((f) => <li key={f}>{f}</li>)}</ul>
      )}
    </Card>
  );
}
