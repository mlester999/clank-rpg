"use client";

import { useState } from "react";

import { Card, fmtDate, useAdminData } from "./adminUi";
import { Stat } from "./ArenaOpsPanel";

/**
 * HOLDER VERIFICATION and the official TOKEN CONFIGURATION — admin only, never public. Connected wallets are re-verified in bounded
 * background batches (~30 min each); every success is an immutable observation, and a holder BONUS is decided from those. This
 * shows who is due or overdue (a gap longer than the freshness window breaks continuity), who is failing, and each wallet's Daily /
 * Weekly bonus qualification: Qualified / Qualifying / Broken, when it started and when and why it broke. Names and status only: no secret
 * appears here.
 */
type Qual = { status: "QUALIFIED" | "QUALIFYING" | "BROKEN" | "NEEDS_VERIFICATION" | "NONE"; tier: string | null; qualificationStart: number | null; brokenAt: number | null; brokenBy: string | null; eligibleFrom: number | null };
interface HoldersData {
  holders: {
    connectedWallets: number; dueForRefresh: number; overdue: number; withFailures: number; staleOverMaxAge: number; holderMaxAgeHours: number; refreshMinutes: number; batchSize: number;
    accounts: Array<{ telegramUserId: number; hero: string | null; wallet: string | null; balance: string; observedTier: string; lastVerifiedAt: number | null; nextCheckAt: number | null; failures: number; stale: boolean; lastError: string | null; daily: Qual; weekly: Qual }>;
  };
}

interface TokenData {
  token: {
    launched: boolean;
    contract: { status: "NOT_LAUNCHED" | "CONFIGURED" | "INVALID"; address: string | null };
    /** What the CONTRACT reports about itself — read from the chain, never typed in. */
    metadata: { status: "NOT_LAUNCHED" | "VERIFIED" | "FAILED" | "UNVERIFIED"; symbol: string | null; decimals: number | null; verifiedAt: number | null; source: "CONTRACT" | "CACHE" | null; error: string | null };
    rpc: { status: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN"; chainId: number | null; chainIdMatches: boolean | null; error: string | null };
    adapter: string | null; rewardWallet: string | null; holderVerificationAvailable: boolean; claimsAvailable: boolean; reasons: string[]; warnings: string[]; notices: string[];
  };
  /** The BUY $CLANKRPG link the public site uses right now (https://clank.trade/ until an address is configured). */
  buyUrl: string;
}

const short = (v: string | null) => (v && v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-4)}` : (v ?? "–"));
const tone = (ok: boolean | null) => (ok === null ? "text-steel-300" : ok ? "text-teal" : "text-danger");

const QUAL_CLS: Record<Qual["status"], string> = { QUALIFIED: "text-teal", QUALIFYING: "text-clank-200", BROKEN: "text-danger", NEEDS_VERIFICATION: "text-ember", NONE: "text-steel-400" };
const qualText = (q: Qual): string => {
  const base = q.status === "NEEDS_VERIFICATION" ? "NEEDS VERIFICATION" : q.status === "NONE" ? "—" : q.status;
  const tier = q.tier ? ` · ${q.tier}` : "";
  const start = q.qualificationStart ? ` · since ${fmtDate(q.qualificationStart)}` : "";
  const broke = q.status === "BROKEN" && q.brokenAt ? ` · broken ${fmtDate(q.brokenAt)} (${q.brokenBy === "GAP" ? "unverified gap" : "below threshold"})` : "";
  const next = q.status === "QUALIFYING" && q.eligibleFrom ? ` · counts from ${new Date(q.eligibleFrom).toISOString().slice(0, 10)}` : "";
  return `${base}${tier}${start}${broke}${next}`;
};

export function HoldersAdmin() {
  const { data } = useAdminData<HoldersData>("/api/admin/picks/holders");
  const h = data?.holders;
  return (
    <>
      <TokenStatus />
      <Card title="Holder verification & bonus qualification">
        {!h ? <p className="text-sm text-steel-300">Loading…</p> : (
          <>
            <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-5" data-testid="holder-counts">
              <Stat label="Connected holder wallets" value={h.connectedWallets.toLocaleString()} />
              <Stat label="Due for refresh" value={h.dueForRefresh.toLocaleString()} sub={`~every ${h.refreshMinutes} min · batch ${h.batchSize}`} />
              <Stat label="Overdue" value={h.overdue.toLocaleString()} sub={`> ${h.refreshMinutes * 2} min late — continuity at risk`} />
              <Stat label="Verification failures" value={h.withFailures.toLocaleString()} sub="backing off" />
              <Stat label={`Stale > ${h.holderMaxAgeHours}h`} value={h.staleOverMaxAge.toLocaleString()} sub="NEEDS VERIFICATION until refreshed" />
            </div>
            {h.accounts.length === 0 ? <p className="mt-3 text-sm text-steel-400">No connected wallets yet.</p> : (
              <ul className="mt-4 space-y-2" data-testid="holder-accounts">
                {h.accounts.map((a) => (
                  <li key={a.telegramUserId} className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="min-w-0 text-sm text-paper"><b>{a.hero ?? "—"}</b> <span className="text-xs text-steel-400">tg {a.telegramUserId}</span></span>
                      <span className="font-mono text-xs text-steel-300" title={a.wallet ?? ""}>{short(a.wallet)}</span>
                    </div>
                    <dl className="mt-1.5 grid min-w-0 grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
                      <Mini label="Current balance" value={a.balance} />
                      <Mini label="Observed tier" value={a.observedTier} />
                      <Mini label="Last verified" value={a.lastVerifiedAt ? fmtDate(a.lastVerifiedAt) : "never"} warn={a.stale} />
                      <Mini label="Next verification" value={a.nextCheckAt ? fmtDate(a.nextCheckAt) : "–"} />
                      <Mini label="Verification failures" value={String(a.failures)} warn={a.failures > 0} />
                      {a.lastError && <Mini label="Last error" value={a.lastError} warn />}
                    </dl>
                    <dl className="mt-1.5 grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-xs lg:grid-cols-2">
                      <div className="min-w-0" data-testid="holder-daily" data-status={a.daily.status}><dt className="text-[0.62rem] tracking-wider text-steel-500 uppercase">Daily bonus</dt><dd className={`break-words ${QUAL_CLS[a.daily.status]}`}>{qualText(a.daily)}</dd></div>
                      <div className="min-w-0" data-testid="holder-weekly" data-status={a.weekly.status}><dt className="text-[0.62rem] tracking-wider text-steel-500 uppercase">Weekly bonus</dt><dd className={`break-words ${QUAL_CLS[a.weekly.status]}`}>{qualText(a.weekly)}</dd></div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function Mini({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.62rem] tracking-wider text-steel-500 uppercase">{label}</dt>
      <dd className={`break-words tnum ${warn ? "text-ember" : "text-steel-100"}`}>{value}</dd>
    </div>
  );
}

/** Official $CLANKRPG contract / contract-reported metadata / RPC status. The contract address is public and copyable; nothing here is typed in — decimals and symbol come from the contract. */
export function TokenStatus() {
  const [fresh, setFresh] = useState(0);
  const { data, reload } = useAdminData<TokenData>(`/api/admin/picks/token${fresh ? "?fresh=1" : ""}`);
  const [copied, setCopied] = useState(false);
  const t = data?.token;
  if (!t) return <Card title="Official $CLANKRPG token"><p className="text-sm text-steel-300">Loading…</p></Card>;
  const copy = async () => {
    if (!t.contract.address) return;
    try {
      await navigator.clipboard.writeText(t.contract.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Card title="Official $CLANKRPG token" actions={<button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFresh((n) => n + 1); void reload(); }} data-testid="token-recheck">Check now</button>}>
      {t.notices.length > 0 && (
        <ul className="mb-3 space-y-2" aria-label="Token notices" data-testid="token-notices">
          {t.notices.map((n) => <li key={n} className="rounded-md border border-clank-400/30 bg-clank-500/10 px-3 py-2 text-sm text-clank-200">{n}</li>)}
        </ul>
      )}
      {t.warnings.length > 0 && (
        <ul className="mb-3 space-y-2" aria-label="Token warnings" data-testid="token-warnings">
          {t.warnings.map((w) => <li key={w} className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{w}</li>)}
        </ul>
      )}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3" data-testid="token-status">
        <div className="min-w-0 rounded-md border border-white/10 bg-white/5 p-3">
          <p className="label">Official Contract</p>
          <p className={`mt-1 font-display text-lg ${tone(t.contract.status === "CONFIGURED" ? true : t.contract.status === "INVALID" ? false : null)}`} data-testid="token-ca-status">{t.contract.status === "CONFIGURED" ? "Configured" : t.contract.status === "NOT_LAUNCHED" ? "NOT LAUNCHED" : "Invalid"}</p>
          {t.contract.address && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs"><span className="font-mono break-all text-steel-200" data-testid="token-ca" title={t.contract.address}>{short(t.contract.address)}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>{copied ? "Copied ✓" : "Copy"}</button></p>
          )}
        </div>
        <div className="min-w-0 rounded-md border border-white/10 bg-white/5 p-3">
          <p className="label">Metadata (from the contract)</p>
          <p className={`mt-1 font-display text-lg ${tone(t.metadata.status === "VERIFIED" ? true : t.metadata.status === "FAILED" ? false : null)}`} data-testid="token-metadata-status">{t.metadata.status === "VERIFIED" ? "Verified" : t.metadata.status === "FAILED" ? "Failed" : t.metadata.status === "NOT_LAUNCHED" ? "—" : t.metadata.decimals !== null ? "Cached" : "Unverified"}</p>
          <p className="mt-1 text-xs text-steel-400" data-testid="token-metadata">Symbol {t.metadata.symbol ? `$${t.metadata.symbol.replace(/^\$/, "")}` : "–"} · Decimals {t.metadata.decimals ?? "–"} <span className="text-steel-500">(detected, not configured)</span>{t.metadata.verifiedAt ? ` · verified ${fmtDate(t.metadata.verifiedAt)}` : ""}</p>
        </div>
        <div className="min-w-0 rounded-md border border-white/10 bg-white/5 p-3">
          <p className="label">Robinhood RPC</p>
          <p className={`mt-1 font-display text-lg ${tone(t.rpc.status === "AVAILABLE" ? true : t.rpc.status === "UNAVAILABLE" ? false : null)}`} data-testid="token-rpc-status">{t.rpc.status === "AVAILABLE" ? "Available" : t.rpc.status === "UNAVAILABLE" ? "Unavailable" : "Unknown"}</p>
          <p className="mt-1 text-xs text-steel-400">chain {t.rpc.chainId ?? "–"}{t.adapter === "simulated" ? " · SIMULATED (dev only)" : ""}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-steel-400">Holder verification: <b className={tone(t.holderVerificationAvailable)}>{t.holderVerificationAvailable ? "available" : "off (everyone is FREE · 0% bonus)"}</b> · Claims: <b className={tone(t.claimsAvailable)}>{t.claimsAvailable ? "open" : t.launched ? "closed (contract unverified)" : "open after launch"}</b>{t.rewardWallet ? ` · read-only reward wallet ${short(t.rewardWallet)}` : ""}. No signing key is used or needed: payouts are manual.</p>
      <p className="mt-1 text-xs text-steel-400">BUY $CLANKRPG link in use: <span className="font-mono break-all text-steel-200" data-testid="token-buy-url">{data?.buyUrl}</span></p>
    </Card>
  );
}
