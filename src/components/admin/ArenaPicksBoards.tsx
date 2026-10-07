"use client";

import { useState } from "react";

import { payoutSummaryText, type PayoutClaimStatus, type PayoutDto, type PayoutRowDto } from "@/domain/rewards/payout";
import { api } from "@/lib/api";

import { Card, fmtDate, Note, useAdminData } from "./adminUi";
import { Stat } from "./ArenaOpsPanel";

/**
 * DAILY + WEEKLY BOARDS — the running periods, the frozen boards with each Top-10 row's base prize, holder bonus and the
 * continuity evidence behind it, prizes held for review and bonuses pending verification. Periods finalize AUTOMATICALLY at
 * 00:00 UTC (and Monday 00:00 UTC) in the 1-minute tick; the only batch action is a safe, idempotent re-run of that sweep. There is
 * deliberately NO "reset leaderboard".
 */
type Kind = "DAILY" | "WEEKLY";
interface Current { start: string; endsAt: number; serverNow: number; remainingMs: number; prizePool: string; minimumPicks: number; participants: number; eligibleParticipants: number; reviewAccounts: number }
interface Finalized { kind: Kind; start: string; participants: number; eligible: number; prizePool: string; baseAwarded: string; returned: string; credited: number; held: number; forfeited: number; bonusesCredited: number; bonusTotal: string; bonusesPending: number; finalizedAt: number }
interface BoardsOverview { boards: { current: Record<Kind, Current>; unfinalized: Array<{ kind: Kind; start: string }>; finalized: Finalized[] } }

const remaining = (ms: number): string => {
  const s = Math.max(Math.floor(ms / 1000), 0);
  return `${Math.floor(s / 86_400)}d ${String(Math.floor((s % 86_400) / 3_600)).padStart(2, "0")}h ${String(Math.floor((s % 3_600) / 60)).padStart(2, "0")}m`;
};

export function BoardsAdmin() {
  const { data, reload } = useAdminData<BoardsOverview>("/api/admin/picks/boards");
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const b = data?.boards;
  if (!b) return <p className="text-sm text-steel-300">Loading…</p>;

  async function rerun() {
    setBusy(true);
    const r = await api<{ result: { finalized: number; waiting: number; failed: number; periods: string[]; reconciled: { checked: number; credited: number; expired: number } } }>("/api/admin/picks/boards/finalize", { method: "POST", json: {} });
    setBusy(false);
    setMsg(r.ok ? `Finalization sweep finished: ${r.data.result.finalized} finalized, ${r.data.result.waiting} waiting for scoring, ${r.data.result.failed} failed; ${r.data.result.reconciled.checked} pending bonus(es) re-checked.` : `Failed: ${r.error}`);
    if (r.ok) await reload();
  }

  return (
    <>
      <Note msg={msg} />
      {b.unfinalized.length > 0 && (
        <div className="mb-4 rounded-md border border-ember/40 bg-ember/10 px-3 py-2.5 text-sm text-ember" data-testid="unfinalized-warning">
          Not finalized yet: <b>{b.unfinalized.map((u) => `${u.kind.toLowerCase()} ${u.start}`).join(", ")}</b>. This normally resolves itself within a minute (the sweep waits for every battle of the period to be scored).
          <button type="button" className="btn btn-sm ml-3 mt-2 sm:mt-0" onClick={() => void rerun()} disabled={busy} data-testid="rerun-finalization">{busy ? "Running…" : "Re-run safe finalization"}</button>
        </div>
      )}
      {(["DAILY", "WEEKLY"] as const).map((k) => {
        const c = b.current[k];
        return (
          <Card key={k} title={`Current ${k === "DAILY" ? "day" : "week"}`}>
            <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4" data-testid={`current-${k.toLowerCase()}`}>
              <Stat label={`${k === "DAILY" ? "Day" : "Week"} start (UTC)`} value={c.start} sub={k === "DAILY" ? "00:00 UTC" : "Monday 00:00 UTC"} />
              <Stat label="Ends (UTC)" value={`${new Date(c.endsAt).toISOString().slice(0, 16).replace("T", " ")} UTC`} sub={`time remaining ${remaining(c.remainingMs)}`} />
              <Stat label="Base prize pool" value={`${c.prizePool} $CLANKRPG`} />
              <Stat label="Minimum picks" value={String(c.minimumPicks)} sub={`valid picks this ${k === "DAILY" ? "UTC day" : "UTC week"} for prize eligibility · no daily cap`} />
              <Stat label="Participants" value={c.participants.toLocaleString()} />
              <Stat label="Prize-eligible" value={c.eligibleParticipants.toLocaleString()} />
              <Stat label="Under review" value={c.reviewAccounts.toLocaleString()} sub="their prize would be held" />
            </div>
          </Card>
        );
      })}
      <p className="mb-4 text-xs text-steel-400">Boards finalize automatically at the period boundary. A leaderboard can never be reset during a period, and a finalized board never changes (only an audited release / forfeit of a held prize, or the reconciliation of a bonus pending verification).</p>
      <Card title="Finalized boards (frozen)">
        {b.finalized.length === 0 ? <p className="text-sm text-steel-400">No finalized boards yet.</p> : (
          <ul className="space-y-2" data-testid="finalized-boards">
            {b.finalized.map((f) => {
              const id = `${f.kind}:${f.start}`;
              return (
                <li key={id} className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2" data-board={id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-display text-sm text-paper uppercase">{f.kind === "DAILY" ? "Daily" : "Weekly"} · {f.kind === "WEEKLY" ? "week of " : ""}{f.start}</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(open === id ? null : id)} data-testid={`open-board-${f.kind.toLowerCase()}-${f.start}`}>{open === id ? "Hide results" : "Show results"}</button>
                  </div>
                  <p className="mt-1 text-xs text-steel-300 tnum">
                    {f.participants} participant{f.participants === 1 ? "" : "s"} · {f.eligible} eligible · pool {f.prizePool} · base awarded {f.baseAwarded} · returned to reserve {f.returned} · {f.credited} base prize(s) claimable · holder bonuses {f.bonusTotal} ({f.bonusesCredited} credited)
                    {f.held > 0 && <b className="text-ember"> · {f.held} held for review</b>}{f.forfeited > 0 && <> · {f.forfeited} forfeited</>}{f.bonusesPending > 0 && <b className="text-ember"> · {f.bonusesPending} bonus(es) pending verification</b>} · finalized {fmtDate(f.finalizedAt)}
                  </p>
                  {open === id && <BoardResults kind={f.kind} start={f.start} onChanged={() => void reload()} setMsg={setMsg} />}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

interface ResultRow {
  rank: number; telegramUserId: number; hero: string; points: number; picks: number; correctPicks: number; accuracyBps: number; prizeEligible: boolean; tieSize: number;
  basePrize: string; holderTier: string | null; holderBonusPercent: string | null; holderBonus: string; totalReward: string;
  baseStatus: "NONE" | "CREDITED" | "HELD" | "FORFEITED"; holdReason: string | null; bonusStatus: "NONE" | "PENDING_VERIFICATION" | "CREDITED" | "HELD" | "FORFEITED" | "EXPIRED";
  evidenceSummary: string | null; resolvedBy: string | null; resolutionReason: string | null;
}

type Pending = { userId: string; action: "release" | "forfeit" | "reverify" | "expire" };

function BoardResults({ kind, start, onChanged, setMsg }: { kind: Kind; start: string; onChanged: () => void; setMsg: (m: string) => void }) {
  const { data, reload } = useAdminData<{ results: ResultRow[] }>(`/api/admin/picks/boards/${kind}/${start}`);
  const [busy, setBusy] = useState<string | null>(null);
  // Every consequential action needs an audited reason: an inline form per row (never a browser prompt).
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const ask = (userId: number, action: Pending["action"]) => {
    const id = String(userId);
    setPending(pending?.userId === id && pending.action === action ? null : { userId: id, action });
    setReason("");
    setError(null);
  };
  const needsReason = pending ? pending.action !== "reverify" : false;

  async function run() {
    if (!pending || (needsReason && reason.trim().length < 3)) return;
    setBusy(pending.userId);
    setError(null);
    const base = `/api/admin/picks/boards/${kind}/${start}`;
    const r = pending.action === "release" || pending.action === "forfeit"
      ? await api(`${base}/prizes/${pending.userId}/resolve`, { method: "POST", json: { action: pending.action, reason: reason.trim() } })
      : await api<{ outcome: string }>(`${base}/bonuses/${pending.userId}/reconcile`, { method: "POST", json: { action: pending.action, reason: reason.trim() } });
    setBusy(null);
    if (!r.ok) {
      setError(typeof r.detail?.message === "string" ? r.detail.message : `Failed: ${r.error}. Nothing changed.`);
      return;
    }
    const outcome = "outcome" in (r.data as object) ? String((r.data as { outcome: string }).outcome) : "";
    setMsg(pending.action === "release" ? "Held prize released (base prize and bonus are now claimable)." : pending.action === "forfeit" ? "Held prize forfeited (returned to the reserve)." : pending.action === "reverify" ? `Bonus re-verified: ${outcome || "done"}.` : "Pending bonus expired (the base prize is untouched).");
    setPending(null);
    setReason("");
    await reload();
    onChanged();
  }

  if (!data) return <p className="mt-2 text-xs text-steel-400">Loading…</p>;
  return (
    <>
    <PayoutPanel kind={kind} start={start} setMsg={setMsg} refreshKey={data.results.map((r) => `${r.baseStatus}${r.bonusStatus}`).join("")} />
    <h3 className="label mt-3">All results · review and evidence</h3>
    <ul className="mt-1 space-y-2" data-testid={`board-results-${kind.toLowerCase()}-${start}`}>
      {data.results.map((r) => {
        const id = String(r.telegramUserId);
        return (
          <li key={id} className="min-w-0 rounded-md border border-white/5 bg-ink-950/50 p-2.5 text-xs" data-rank={r.rank}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="min-w-0"><b className="text-paper tnum">#{r.rank}</b> <span className="text-paper">{r.hero}</span> <span className="text-steel-400">(tg {id})</span>{r.tieSize > 1 && <span className="ml-1 text-steel-400">· tie ×{r.tieSize}</span>}</span>
              <span className="text-steel-300 tnum">{r.points} pts · {r.correctPicks}/{r.picks} correct · {(Math.round(r.accuracyBps / 10) / 10).toFixed(1)}%{!r.prizeEligible && <span className="ml-1 text-steel-500">· not prize-eligible</span>}</span>
            </div>
            <dl className="mt-1.5 grid min-w-0 grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3 lg:grid-cols-6">
              <Cell label="Base prize" value={r.basePrize} />
              <Cell label="Holder tier" value={r.holderTier ?? "–"} />
              <Cell label="Holder bonus %" value={r.holderBonusPercent ?? "–"} />
              <Cell label="Holder bonus" value={r.holderBonus} />
              <Cell label="Total reward" value={r.totalReward} strong />
              <Cell label="Review status" value={`${r.baseStatus}${r.holdReason ? ` (${r.holdReason})` : ""}${r.bonusStatus !== "NONE" ? ` · bonus ${r.bonusStatus.replace("_", " ")}` : ""}`} warn={r.baseStatus === "HELD" || r.bonusStatus === "PENDING_VERIFICATION"} />
            </dl>
            {r.evidenceSummary && <p className="mt-1.5 break-words text-[0.7rem] leading-snug text-steel-300" data-testid="evidence-summary"><span className="label mr-1">Qualification evidence</span>{r.evidenceSummary}</p>}
            {r.resolvedBy && <p className="mt-1 text-[0.66rem] text-steel-500">Resolved by {r.resolvedBy}: {r.resolutionReason}</p>}
            {(r.baseStatus === "HELD" || r.bonusStatus === "PENDING_VERIFICATION") && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {r.baseStatus === "HELD" && (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => ask(r.telegramUserId, "release")} data-testid="release-prize">Release</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => ask(r.telegramUserId, "forfeit")} data-testid="forfeit-prize">Forfeit</button>
                  </>
                )}
                {r.bonusStatus === "PENDING_VERIFICATION" && (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => ask(r.telegramUserId, "reverify")} data-testid="reverify-bonus">Re-verify bonus now</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => ask(r.telegramUserId, "expire")} data-testid="expire-bonus">Give up on bonus</button>
                  </>
                )}
              </div>
            )}
            {pending?.userId === id && (
              <div className="mt-2 rounded-md border border-clank-400/30 bg-clank-500/[0.06] p-3" data-testid="prize-action-panel">
                {needsReason ? (
                  <>
                    <label htmlFor={`prize-reason-${id}`} className="label">
                      {pending.action === "release" ? "Why release this held prize (and its bonus) to the member? (audited)" : pending.action === "forfeit" ? "Why forfeit this held prize (and its bonus)? (audited — the amounts return to the reserve)" : "Why give up on this bonus? (audited — the base prize is untouched)"}
                    </label>
                    <input id={`prize-reason-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" className="mt-1 w-full rounded-md border border-white/15 bg-ink-950/70 px-3 py-2 text-sm text-paper outline-none focus:border-clank-400" data-testid="prize-reason" />
                  </>
                ) : (
                  <p className="text-xs text-steel-200">Re-reads the member&apos;s balance on-chain now, then applies the same continuity rule as the close. It credits only what the evidence proves.</p>
                )}
                {error && <p role="alert" className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="prize-action-error">{error}</p>}
                <div className="mt-2.5 flex flex-wrap justify-end gap-2">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPending(null)} disabled={busy !== null}>Cancel</button>
                  <button type="button" className="btn btn-sm" onClick={() => void run()} disabled={busy !== null || (needsReason && reason.trim().length < 3)} data-testid="confirm-prize-action">{busy ? "Saving…" : "Confirm"}</button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
    </>
  );
}

function Cell({ label, value, strong = false, warn = false }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.6rem] tracking-wider text-steel-500 uppercase">{label}</dt>
      <dd className={`break-words tnum ${warn ? "text-ember" : strong ? "font-bold text-teal" : "text-steel-100"}`}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// PAYOUT SUMMARY — what to send by hand for this board, exactly
// ---------------------------------------------------------------------------------------------------------------------
const STATUS_STYLE: Record<PayoutClaimStatus, string> = {
  UNCLAIMED: "border-white/20 text-steel-200",
  PENDING: "border-clank-400/50 bg-clank-500/15 text-clank-200",
  SENT: "border-teal/50 bg-teal/15 text-teal",
  DENIED: "border-danger/50 bg-danger/10 text-danger",
  HELD: "border-ember/50 bg-ember/10 text-ember",
  FORFEITED: "border-white/15 text-steel-500",
};
const short = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "–");

function StatusChip({ status }: { status: PayoutClaimStatus }) {
  return <span className={`inline-block rounded border px-1.5 py-px text-[0.62rem] tracking-wider uppercase ${STATUS_STYLE[status]}`} data-testid="payout-status">{status}</span>;
}

function PayoutPanel({ kind, start, setMsg, refreshKey }: { kind: Kind; start: string; setMsg: (m: string) => void; refreshKey: string }) {
  const { data, reload } = useAdminData<{ payout: PayoutDto }>(`/api/admin/picks/boards/${kind}/${start}/payout`);
  // A held prize released, or a bonus reconciled, above changes the exact total: reload when the rows' statuses change.
  const [seen, setSeen] = useState(refreshKey);
  if (seen !== refreshKey) {
    setSeen(refreshKey);
    void reload();
  }
  if (!data) return <p className="mt-2 text-xs text-steel-400">Loading payout…</p>;
  async function copy() {
    const text = payoutSummaryText(data!.payout);
    try {
      await navigator.clipboard.writeText(text);
      setMsg("Payout summary copied.");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      setMsg("Payout summary copied.");
    }
  }

  return <PayoutView payout={data.payout} kind={kind} start={start} onCopy={() => void copy()} />;
}

/** The payout summary and the per-winner table of ONE finalized board (presentational: it renders what the server computed). */
export function PayoutView({ payout, kind, start, onCopy }: { payout: PayoutDto; kind: Kind; start: string; onCopy: () => void }) {
  const { summary: s, rows } = payout;
  const label = kind === "DAILY" ? "Daily" : "Weekly";
  return (
    <section className="mt-3 min-w-0 rounded-md border border-clank-400/30 bg-clank-500/[0.05] p-3" data-testid={`payout-${kind.toLowerCase()}-${start}`} aria-label={`${label} payout summary`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-display text-sm tracking-wider text-clank-200 uppercase">{label} payout summary</h3>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCopy} data-testid="copy-payout">Copy payout summary</button>
          <a className="btn btn-ghost btn-sm" href={`/api/admin/picks/boards/${kind}/${start}/payout?format=csv`} download data-testid="export-payout-csv">Export CSV</a>
        </div>
      </div>

      <dl className="mt-2.5 grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4" data-testid="payout-summary">
        <PayoutStat label="Base prize pool" value={`${s.basePool} ${s.symbol}`} sub={`${s.baseAwarded} awarded · ${s.returnedToReserve} back to the reserve`} />
        <PayoutStat label="Holder bonuses" value={`${s.holderBonuses} ${s.symbol}`} sub={`qualified · up to ${s.maxBonusPercent}`} />
        <PayoutStat label="TOTAL PAYOUT" value={`${s.totalPayout} ${s.symbol}`} strong sub={`exactly what to send · ${s.prizeWinners} winner${s.prizeWinners === 1 ? "" : "s"}`} testId="payout-total" />
        <PayoutStat label="By status" value="" sub="" custom={
          <ul className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[0.66rem] text-steel-300 tnum">
            {(Object.entries(s.byStatus) as Array<[PayoutClaimStatus, string]>).filter(([, v]) => v !== "0").map(([k, v]) => <li key={k}>{k.toLowerCase()} {v}</li>)}
          </ul>
        } />
      </dl>
      {s.heldForReview !== "0" && <p className="mt-2 text-[0.72rem] text-ember" data-testid="payout-held">{s.heldForReview} of the total is held for review — send it only after the prize is released.</p>}
      {s.bonusesPending > 0 && <p className="mt-1 text-[0.72rem] text-ember" data-testid="payout-pending">{s.bonusesPending} holder bonus(es) are still pending verification and are not in the total (at most {s.bonusesPendingMaximum} more).</p>}

      {rows.length === 0 ? <p className="mt-2 text-xs text-steel-400">Nobody earned a prize on this board.</p> : (
        <>
          <div className="mt-2.5 hidden min-w-0 overflow-x-auto md:block">
            <table className="w-full min-w-[56rem] text-left text-xs tnum" data-testid="payout-table">
              <thead>
                <tr className="text-[0.6rem] tracking-wider text-steel-500 uppercase">
                  {["Rank", "Player", "Correct", "Picks", "Accuracy", "Points", "Base prize", "Holder tier", "Bonus %", "Bonus", "Total to send", "Status", "Wallet / tx"].map((h) => <th key={h} className="py-1 pr-2 font-normal">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.telegramUserId} className="border-t border-white/5 align-top" data-rank={r.rank}>
                    <td className="py-1.5 pr-2 text-paper">#{r.rank}{r.tied && <span className="ml-1 text-[0.58rem] text-steel-400">TIE</span>}</td>
                    <td className="max-w-[10rem] py-1.5 pr-2 break-words text-paper">{r.hero}<span className="block text-[0.6rem] text-steel-500">tg {r.telegramUserId}</span></td>
                    <td className="py-1.5 pr-2">{r.correctPicks}</td>
                    <td className="py-1.5 pr-2">{r.picks}</td>
                    <td className="py-1.5 pr-2">{r.accuracy.toFixed(1)}%</td>
                    <td className="py-1.5 pr-2">{r.points}</td>
                    <td className="py-1.5 pr-2">{r.basePrize}</td>
                    <td className="py-1.5 pr-2">{r.holderTier ?? "–"}</td>
                    <td className="py-1.5 pr-2">{r.bonusPercent ?? "–"}</td>
                    <td className="py-1.5 pr-2">{r.holderBonus}</td>
                    <td className="py-1.5 pr-2 font-bold text-teal" data-testid="payout-row-total">{r.totalReward}</td>
                    <td className="py-1.5 pr-2"><StatusChip status={r.claimStatus} /></td>
                    <td className="py-1.5 font-mono text-[0.62rem] break-all text-steel-300" title={r.wallet ?? ""}>{short(r.wallet)}{r.txHash && <span className="block text-steel-500" title={r.txHash}>tx {r.txHash.slice(0, 10)}…</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-2.5 space-y-2 md:hidden" data-testid="payout-cards">
            {rows.map((r) => <PayoutCard key={r.telegramUserId} r={r} />)}
          </ul>
        </>
      )}
    </section>
  );
}

function PayoutStat({ label, value, sub, strong = false, testId, custom }: { label: string; value: string; sub: string; strong?: boolean; testId?: string; custom?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-white/10 bg-ink-950/50 px-2.5 py-2">
      <dt className="text-[0.6rem] tracking-wider text-steel-500 uppercase">{label}</dt>
      {custom ?? (
        <>
          <dd className={`font-display text-base break-words tnum ${strong ? "text-teal" : "text-paper"}`} data-testid={testId}>{value}</dd>
          {sub && <p className="mt-0.5 text-[0.62rem] leading-snug text-steel-400">{sub}</p>}
        </>
      )}
    </div>
  );
}

function PayoutCard({ r }: { r: PayoutRowDto }) {
  return (
    <li className="min-w-0 rounded-md border border-white/5 bg-ink-950/50 p-2.5 text-xs" data-rank={r.rank}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="min-w-0 break-words"><b className="text-paper tnum">#{r.rank}</b> <span className="text-paper">{r.hero}</span> <span className="text-steel-500">(tg {r.telegramUserId})</span></span>
        <StatusChip status={r.claimStatus} />
      </div>
      <dl className="mt-1.5 grid min-w-0 grid-cols-2 gap-x-3 gap-y-1">
        <Cell label="Correct / picks" value={`${r.correctPicks} / ${r.picks}`} />
        <Cell label="Accuracy · points" value={`${r.accuracy.toFixed(1)}% · ${r.points}`} />
        <Cell label="Base prize" value={r.basePrize} />
        <Cell label="Holder tier" value={r.holderTier ? `${r.holderTier} ${r.bonusPercent ?? ""}` : "–"} />
        <Cell label="Holder bonus" value={r.holderBonus} />
        <Cell label="Total to send" value={r.totalReward} strong />
      </dl>
      {r.wallet && <p className="mt-1 break-all font-mono text-[0.62rem] text-steel-300">{r.wallet}{r.txHash && <span className="block text-steel-500">tx {r.txHash}</span>}</p>}
    </li>
  );
}
