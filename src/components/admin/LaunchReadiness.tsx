"use client";

import { useState } from "react";

import type { LaunchPreflight, PreflightCheck } from "@/domain/launchPreflight";
import { api, friendly } from "@/lib/api";

import { Card, fmtDate } from "./adminUi";

/**
 * SEASON 1 LAUNCH READINESS — what the (one-way) launch would archive and reset, in REAL counts read from the database right now, the conditions that must hold,
 * and the backup attestation the launch requires. Read-only except for recording a backup attestation (append-only, audited). The launch button lives in
 * "Actions" and stays disabled while any blocking condition fails; the server runs the same checks again inside the launch transaction.
 */
export interface PreflightResponse {
  preflight: LaunchPreflight;
  resets: readonly string[];
  keeps: readonly string[];
}

const n = (x: number | string): string => Number(x).toLocaleString("en-US");

function Count({ label, value, sub, tone, testId }: { label: string; value: string; sub?: string; tone?: "teal" | "gold" | "danger"; testId: string }) {
  const color = tone === "teal" ? "text-teal" : tone === "gold" ? "text-gold" : tone === "danger" ? "text-danger" : "text-paper";
  return (
    <div className="min-w-0 rounded-md border border-white/10 bg-white/5 p-2.5" data-testid={testId}>
      <p className="label">{label}</p>
      <p className={`mt-0.5 font-display text-lg tnum ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[0.66rem] break-words text-steel-400">{sub}</p>}
    </div>
  );
}

const STATUS_STYLE: Record<PreflightCheck["status"], string> = {
  PASS: "border-teal/40 bg-teal/10 text-teal",
  WARN: "border-gold/40 bg-gold/10 text-gold",
  FAIL: "border-danger/40 bg-danger/10 text-danger",
};

export function LaunchReadiness({ data, onChanged }: { data: PreflightResponse | null; onChanged: () => void | Promise<void> }) {
  if (!data) return <Card title="Season 1 launch readiness"><p className="text-sm text-steel-300" data-testid="preflight-loading">Checking the database…</p></Card>;
  const pf = data.preflight;
  const f = pf.facts;
  const unsafe = pf.unsafe.length;
  const openJobs = f.battles.open + (f.jobs.activeCycle ? 1 : 0) + (f.jobs.lifecycleLockBusy ? 1 : 0);
  return (
    <Card
      title="Season 1 launch readiness"
      actions={<span className={`chip ${pf.ready ? "border-teal/40 bg-teal/10 text-teal" : "border-danger/40 bg-danger/10 text-danger"}`} data-testid="preflight-verdict">{pf.ready ? "Ready to launch" : "Not ready"}</span>}
    >
      <p className="text-sm text-steel-300">
        What the launch would archive, counted from the database right now. {f.season.label ? <>Pre-season run: <b className="text-paper">{f.season.label}</b>.</> : "There is no active season."} Nothing here changes anything.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" data-testid="preflight-counts">
        <Count testId="count-heroes" label="Existing heroes" value={n(f.heroes.total)} sub={`${n(f.heroes.eligible)} Arena-eligible · ${n(f.heroes.suspended)} suspended — all kept`} tone="teal" />
        <Count testId="count-versions" label="Hero versions" value={n(f.heroes.versions)} sub="append-only history — kept" tone="teal" />
        <Count testId="count-battles" label="Pre-season battles" value={n(f.battles.settled + f.battles.voided + f.battles.open)} sub={`${n(f.battles.settled)} settled · ${n(f.battles.voided)} void · ${n(f.battles.open)} open (voided at launch)`} />
        <Count testId="count-picks" label="Pre-season Picks" value={n(f.picks.submitted)} sub={`${n(f.picks.scored)} scored rows archived`} />
        <Count testId="count-leaderboards" label="Pre-season leaderboard entries" value={n(f.boards.picksResults + f.boards.heroResults)} sub={`${n(f.boards.picksBoards)} Picks + ${n(f.boards.heroBoards)} Hero Arena boards frozen`} />
        <Count testId="count-records" label="Hero records" value={n(f.heroRecords.heroesWithRecords)} sub={`${n(f.heroRecords.careerCounters)} career counters zeroed`} />
        <Count testId="count-economy" label="Pre-season economy entries" value={n(f.economy.goldAccounts + f.economy.lootItems + f.economy.arenaAchievements)} sub={`${n(f.economy.goldAccounts)} Gold accounts (${n(f.economy.goldTotal)} Gold) · ${n(f.economy.lootItems)} items · ${n(f.economy.arenaAchievements)} battle achievements`} />
        <Count testId="count-pending" label="Pending settlements" value={n(f.picks.settledBattlesAwaitingScoring)} sub="settled battles whose Picks are not scored yet" tone={f.picks.settledBattlesAwaitingScoring ? "danger" : "teal"} />
        <Count testId="count-jobs" label="Active jobs" value={n(openJobs)} sub={`${n(f.battles.open)} open battle(s) · cycle ${f.jobs.activeCycle ? "active" : "none"} · lifecycle lock ${f.jobs.lifecycleLockBusy ? "BUSY" : "free"}`} tone={openJobs ? "gold" : "teal"} />
        <Count testId="count-unsafe" label="Unsafe conditions" value={n(unsafe)} sub={unsafe ? "see the list below" : "none"} tone={unsafe ? "danger" : "teal"} />
        <Count testId="count-members" label="Members (kept)" value={n(f.members)} sub="accounts, Telegram identity, admin settings" />
        <Count testId="count-chat" label="Arena Chat messages (kept)" value={n(f.chatMessages)} sub="chat is not competition; it is not cleared" />
      </div>

      <h3 className="label mt-5">Conditions</h3>
      <ul className="mt-2 space-y-1.5" data-testid="preflight-checks">
        {pf.checks.map((c, i) => (
          <li key={`${c.id}-${i}`} className="flex items-start gap-2.5 rounded-md border border-white/10 bg-white/[0.03] p-2.5" data-check={c.id} data-status={c.status}>
            <span className={`chip mt-0.5 shrink-0 ${STATUS_STYLE[c.status]}`}>{c.status}</span>
            <span className="min-w-0 text-sm">
              <span className="block font-semibold text-paper">{c.label}{c.blocking ? "" : <span className="ml-1.5 text-[0.62rem] font-normal tracking-wider text-steel-400 uppercase">advisory</span>}</span>
              <span className="block break-words text-steel-300">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      <BackupPanel pf={pf} onChanged={onChanged} />

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <details className="rounded-md border border-white/10 bg-white/[0.03] p-3" open data-testid="preflight-resets">
          <summary className="cursor-pointer font-display text-xs tracking-wider text-gold uppercase">Resets for Season 1</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-steel-200">{data.resets.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
        <details className="rounded-md border border-white/10 bg-white/[0.03] p-3" open data-testid="preflight-keeps">
          <summary className="cursor-pointer font-display text-xs tracking-wider text-teal uppercase">Survives the launch</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-steel-200">{data.keeps.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
      </div>
      <p className="mt-3 text-[0.68rem] text-steel-400">Checked {fmtDate(pf.checkedAt)} · schema {f.schema.latestApplied ?? "unknown"}</p>
    </Card>
  );
}

function BackupPanel({ pf, onChanged }: { pf: LaunchPreflight; onChanged: () => void | Promise<void> }) {
  const [reference, setReference] = useState("");
  const [verified, setVerified] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const b = pf.backup;
  const latest = b.latest;

  async function submit() {
    setBusy(true);
    const r = await api("/api/admin/game/backup-attestation", { method: "POST", json: { reference: reference.trim(), verified, ...(notes.trim() ? { notes: notes.trim() } : {}) } });
    setBusy(false);
    if (r.ok) {
      setMsg({ tone: "ok", text: "Backup attestation recorded." });
      setReference("");
      setNotes("");
      await onChanged();
    } else setMsg({ tone: "err", text: String((r.detail as { message?: string } | undefined)?.message ?? friendly(r.error)) });
  }

  return (
    <div className="mt-5 rounded-md border border-white/10 bg-white/[0.03] p-3" data-testid="backup-panel" data-satisfied={b.satisfied}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-xs tracking-wider text-paper uppercase">Backup readiness</h3>
        <span className={`chip ${b.satisfied ? STATUS_STYLE.PASS : STATUS_STYLE[b.required ? "FAIL" : "WARN"]}`}>{b.satisfied ? "Attested" : b.required ? "Required" : "Not attested"}</span>
      </div>
      <p className="mt-1.5 text-sm text-steel-300">
        The launch needs a backup taken in the last {b.maxAgeHours} h, verified, at the current schema. The app cannot look inside a backup: this records who says it exists, what it is called and when — it does not prove it.
      </p>
      {latest ? (
        <p className="mt-2 text-sm text-steel-200" data-testid="backup-latest">
          Latest: <b className="text-paper">{latest.reference}</b> · {latest.verified ? "verified" : "NOT verified"} · by {latest.attestedBy} · {fmtDate(latest.attestedAt)} · schema {latest.schemaVersion}
        </p>
      ) : (
        <p className="mt-2 text-sm text-steel-300" data-testid="backup-none">No backup has been attested yet.</p>
      )}
      {b.reason && <p className="mt-1 text-sm text-gold" data-testid="backup-reason">{b.reason}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label className="text-xs text-steel-300">
          Backup reference (restore point, dump name + checksum…)
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={300} className="mt-1 w-full rounded-md border border-white/10 bg-ink-900 px-3 py-2 text-sm text-paper" data-testid="backup-reference" />
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm text-steel-200">
          <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} data-testid="backup-verified" /> I restored / verified it
        </label>
      </div>
      <label className="mt-2 block text-xs text-steel-300">
        Notes (optional)
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className="mt-1 w-full rounded-md border border-white/10 bg-ink-900 px-3 py-2 text-sm text-paper" data-testid="backup-notes" />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-sm" disabled={busy || reference.trim().length < 3} onClick={() => void submit()} data-testid="backup-submit">Record attestation</button>
        {msg && <span role="status" className={`text-sm ${msg.tone === "ok" ? "text-teal" : "text-danger"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

