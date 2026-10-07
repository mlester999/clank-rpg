"use client";

import { useState } from "react";

import { DENIAL_REASON_CODES, DENIAL_REASONS, type DenialReason } from "@/domain/rewards/claims";
import { api } from "@/lib/api";

import { Card, fmtDate, useAdminData } from "./adminUi";

/**
 * CLAIMS — the MANUAL payout queue. A claim is paid by hand, off-platform: copy the wallet and the amount, send the tokens from
 * the reward wallet, then paste the transaction hash into MARK SENT. The server reads the chain (read-only) and only then marks
 * the claim SENT — and the amount and the destination are frozen on the claim; nothing on this screen can change them. DENY
 * needs a reason and returns the reservation to the member's claimable balance. There is no private key anywhere.
 */
type Status = "PENDING" | "SENT" | "DENIED";

interface ClaimRow {
  id: string;
  telegram_user_id: number;
  display_name: string | null;
  username: string | null;
  hero_name: string | null;
  destination_address: string;
  destination_kind: "HOLDER_WALLET" | "CUSTOM";
  amount: string;
  /** The frozen amount at FULL precision (plain decimal) — what to send, and what the chain check compares against. */
  amount_exact: string;
  status: Status;
  tx_hash: string | null;
  requested_at: string;
  sent_at: string | null;
  sent_by: string | null;
  denied_at: string | null;
  denied_by: string | null;
  denial_reason: DenialReason | null;
  denial_note: string | null;
  review_state: string;
  telegram_status: string;
  other_accounts_same_destination: number;
}

interface ClaimsData {
  claims: ClaimRow[];
  counts: Record<Status, { count: number; amount: string }>;
}

const SECTIONS: Array<[Status, string]> = [["PENDING", "Pending"], ["SENT", "Sent"], ["DENIED", "Denied"]];

export function ClaimsQueue() {
  const [status, setStatus] = useState<Status>("PENDING");
  const { data, reload } = useAdminData<ClaimsData>(`/api/admin/picks/claims?status=${status}&limit=100`);
  const [msg, setMsg] = useState("");
  return (
    <>
      <p className="mb-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-steel-300">
        Payouts are made <b className="text-paper">by hand</b>. The amount and destination of a claim are frozen — copy them, send the tokens, then <b className="text-paper">Mark sent</b> with the transaction hash. The server verifies the transfer on-chain before a claim becomes SENT; if the chain can&apos;t confirm it, the claim stays PENDING.
      </p>
      <div role="tablist" aria-label="Claim status" className="mb-3 flex flex-wrap gap-1.5" data-testid="claim-sections">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={status === id} onClick={() => { setStatus(id); setMsg(""); }} data-testid={`claims-tab-${id}`} className={`rounded-md px-3 py-1.5 text-sm font-semibold ring-1 ${status === id ? "bg-clank-500 text-ink-900 ring-clank-300" : "bg-white/5 text-steel-200 ring-white/10 hover:bg-white/10"}`}>
            {label} <span className="tnum opacity-80">({data?.counts[id].count ?? "…"})</span>
          </button>
        ))}
        {data && <span className="ml-1 self-center text-xs text-steel-400 tnum">{data.counts[status].amount} $CLANKRPG {status === "PENDING" ? "waiting" : status === "SENT" ? "paid" : "returned to members"}</span>}
      </div>
      {msg && <p role="status" className="mb-3 text-sm text-clank-300" data-testid="claims-note">{msg}</p>}
      {!data ? (
        <p className="text-sm text-steel-300">Loading…</p>
      ) : data.claims.length === 0 ? (
        <Card><p className="text-sm text-steel-400">No {status.toLowerCase()} claims.</p></Card>
      ) : (
        <ul className="space-y-3" data-testid="claim-list">
          {data.claims.map((c) => <ClaimCard key={c.id} claim={c} onChanged={() => void reload()} setMsg={setMsg} />)}
        </ul>
      )}
    </>
  );
}

function ClaimCard({ claim: c, onChanged, setMsg }: { claim: ClaimRow; onChanged: () => void; setMsg: (m: string) => void }) {
  const [panel, setPanel] = useState<null | "sent" | "deny">(null);
  const [hash, setHash] = useState("");
  const [reason, setReason] = useState<DenialReason>("INVALID_WALLET");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied("unavailable");
    }
  };

  async function markSent() {
    setBusy(true);
    setError(null);
    const r = await api(`/api/admin/picks/claims/${c.id}/sent`, { method: "POST", json: { txHash: hash.trim() } });
    setBusy(false);
    if (!r.ok) {
      setError(typeof r.detail?.message === "string" ? r.detail.message : `Could not mark this claim sent (${r.error}). It stays PENDING.`);
      return;
    }
    setMsg("Claim marked SENT — the transfer was verified on-chain.");
    setPanel(null);
    onChanged();
  }

  async function deny() {
    setBusy(true);
    setError(null);
    const r = await api<{ accountHeld: boolean }>(`/api/admin/picks/claims/${c.id}/deny`, { method: "POST", json: { reason, ...(note.trim() ? { note: note.trim() } : {}) } });
    setBusy(false);
    if (!r.ok) {
      setError(typeof r.detail?.message === "string" ? r.detail.message : `Could not deny this claim (${r.error}).`);
      return;
    }
    setMsg(r.data.accountHeld ? "Claim denied — the reward is claimable again and the account is now held for review." : "Claim denied — the reward is claimable again.");
    setPanel(null);
    onChanged();
  }

  const reviewed = c.review_state !== "NORMAL" || c.telegram_status === "FLAGGED";
  return (
    <li className="plate p-3.5 sm:p-4" data-testid="claim-card" data-status={c.status} data-claim-id={c.id}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-paper" title={c.hero_name ?? c.display_name ?? ""}>{c.hero_name ?? c.display_name ?? "Member"}</p>
          <p className="text-xs text-steel-400">Telegram {c.display_name ?? "—"}{c.username ? ` (@${c.username})` : ""} · id <span className="tnum">{c.telegram_user_id}</span></p>
        </div>
        <div className="text-right">
          <p className="font-display text-lg text-clank-200 tnum" data-testid="claim-card-amount">{c.amount} <span className="text-xs">$CLANKRPG</span></p>
          <p className="text-[0.66rem] text-steel-400">requested {fmtDate(c.requested_at)}</p>
        </div>
      </div>
      <p className="mt-1.5 text-xs text-steel-300">
        Exact amount to send <span className="font-mono break-all text-paper" data-testid="claim-card-exact">{c.amount_exact}</span>
        <span className="block text-[0.66rem] text-steel-400">Send exactly this — the transfer is verified to the last decimal.</span>
      </p>

      <div className="mt-2.5">
        <p className="label">Destination wallet</p>
        <p className="font-mono text-xs break-all text-paper" data-testid="claim-card-wallet">{c.destination_address}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5 text-[0.66rem]">
          <span className={`chip ${c.destination_kind === "HOLDER_WALLET" ? "border-teal/50 bg-teal/10 text-teal" : ""}`} data-testid="claim-card-kind">{c.destination_kind === "HOLDER_WALLET" ? "Connected holder wallet" : "Custom wallet"}</span>
          {reviewed && <span className="chip border-ember/50 bg-ember/10 text-ember" data-testid="claim-card-review">Review: {c.review_state !== "NORMAL" ? c.review_state : "FLAGGED"}</span>}
          {c.other_accounts_same_destination > 0 && <span className="chip border-danger/50 bg-danger/10 text-danger" data-testid="claim-card-shared">Also used by {c.other_accounts_same_destination} other account{c.other_accounts_same_destination === 1 ? "" : "s"}</span>}
        </div>
      </div>

      {c.status === "SENT" && (
        <div className="mt-2.5 text-xs text-steel-300">
          <p className="label">Transaction</p>
          <p className="font-mono break-all text-paper" data-testid="claim-card-tx">{c.tx_hash}</p>
          <p className="mt-1">Sent {fmtDate(c.sent_at)} by {c.sent_by ?? "admin"} · verified on-chain</p>
        </div>
      )}
      {c.status === "DENIED" && c.denial_reason && (
        <div className="mt-2.5 text-xs text-steel-300">
          <p className="label">Denied</p>
          <p className="text-paper" data-testid="claim-card-denial">{DENIAL_REASONS[c.denial_reason].label}{c.denial_note ? ` — ${c.denial_note}` : ""}</p>
          <p className="mt-1">{fmtDate(c.denied_at)} by {c.denied_by ?? "admin"} · the reward returned to the member&apos;s claimable balance</p>
        </div>
      )}

      {c.status === "PENDING" && (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy("wallet", c.destination_address)} data-testid="copy-wallet">{copied === "wallet" ? "Copied ✓" : "Copy wallet"}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy("amount", c.amount_exact)} data-testid="copy-amount">{copied === "amount" ? "Copied ✓" : "Copy amount"}</button>
            <button type="button" className="btn btn-sm" onClick={() => { setPanel(panel === "sent" ? null : "sent"); setError(null); }} data-testid="mark-sent">Mark sent</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPanel(panel === "deny" ? null : "deny"); setError(null); }} data-testid="deny-claim">Deny</button>
          </div>

          {panel === "sent" && (
            <div className="mt-3 rounded-md border border-clank-400/30 bg-clank-500/[0.06] p-3" data-testid="mark-sent-panel">
              <label htmlFor={`tx-${c.id}`} className="label">Transaction hash</label>
              <input id={`tx-${c.id}`} value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} className="mt-1 w-full rounded-md border border-white/15 bg-ink-950/70 px-3 py-2 font-mono text-xs text-paper outline-none focus:border-clank-400" data-testid="tx-hash-input" />
              <p className="mt-1.5 text-[0.68rem] text-steel-400">The server checks the transaction on Robinhood Chain: it must have succeeded, emitted a Transfer of the official token to <b className="text-steel-200">this</b> wallet for <b className="text-steel-200">this</b> amount. You can&apos;t change either.</p>
              {error && <p role="alert" className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="mark-sent-error">{error}</p>}
              <div className="mt-2.5 flex flex-wrap justify-end gap-2">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel(null)} disabled={busy}>Cancel</button>
                <button type="button" className="btn btn-sm" onClick={() => void markSent()} disabled={busy || hash.trim().length < 10} data-testid="confirm-sent">{busy ? "Verifying…" : "Confirm sent"}</button>
              </div>
            </div>
          )}

          {panel === "deny" && (
            <div className="mt-3 rounded-md border border-danger/30 bg-danger/[0.05] p-3" data-testid="deny-panel">
              <label htmlFor={`reason-${c.id}`} className="label">Reason (required)</label>
              <select id={`reason-${c.id}`} value={reason} onChange={(e) => setReason(e.target.value as DenialReason)} className="mt-1 w-full rounded-md border border-white/15 bg-ink-950/70 px-3 py-2 text-sm text-paper" data-testid="deny-reason">
                {DENIAL_REASON_CODES.map((code) => <option key={code} value={code}>{DENIAL_REASONS[code].label}</option>)}
              </select>
              <label htmlFor={`note-${c.id}`} className="label mt-2.5 block">Internal note {reason === "OTHER" ? "(required)" : "(optional)"}</label>
              <textarea id={`note-${c.id}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className="mt-1 w-full rounded-md border border-white/15 bg-ink-950/70 px-3 py-2 text-sm text-paper" data-testid="deny-note" />
              <p className="mt-1.5 text-[0.68rem] text-steel-400">The member sees only a safe explanation. The reward returns to their claimable balance{DENIAL_REASONS[reason].holdsAccount ? "; this reason also puts the account under review (further claims are held)" : ""}.</p>
              {error && <p role="alert" className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="deny-error">{error}</p>}
              <div className="mt-2.5 flex flex-wrap justify-end gap-2">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel(null)} disabled={busy}>Cancel</button>
                <button type="button" className="btn btn-sm" onClick={() => void deny()} disabled={busy || (reason === "OTHER" && note.trim().length < 3)} data-testid="confirm-deny">{busy ? "Denying…" : "Confirm deny"}</button>
              </div>
            </div>
          )}
        </>
      )}
    </li>
  );
}
