"use client";

import { useState } from "react";

import type { OfficialToken } from "@/components/leaderboard/useTokenConfig";
import { api } from "@/lib/api";

import type { BonusStatusDto, HolderCardDto } from "./useRewards";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** "5D 7H", "7D", "6H 12M", "0H 0M" — a duration, for the qualification progress (never a bare "0M", which reads like "0 million"). */
export function formatHeld(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return h > 0 ? `${d}D ${h}H` : `${d}D`;
  return `${h}H ${m}M`;
}

const STATUS_LABEL: Record<BonusStatusDto["status"], string> = { QUALIFIED: "QUALIFIED", QUALIFYING: "QUALIFYING", BROKEN: "BROKEN", NEEDS_VERIFICATION: "NEEDS VERIFICATION", NONE: "NOT QUALIFIED" };
const STATUS_CLS: Record<BonusStatusDto["status"], string> = {
  QUALIFIED: "border-teal/50 bg-teal/15 text-teal",
  QUALIFYING: "border-clank-400/50 bg-clank-500/15 text-clank-200",
  BROKEN: "border-danger/50 bg-danger/10 text-danger",
  NEEDS_VERIFICATION: "border-ember/50 bg-ember/10 text-ember",
  NONE: "border-white/15 text-steel-300",
};

/** One plain sentence for a Daily / Weekly status: what it means right now, in player terms. */
function explain(kind: "Daily" | "Weekly", s: BonusStatusDto): string {
  const board = kind.toLowerCase();
  switch (s.status) {
    case "QUALIFIED":
      return s.upgradingTo
        ? `${s.payingBonus} applies now (${s.payingTier}). ${s.upgradingTo.tier} (${s.upgradingTo.bonus}) qualifies for the ${board} board starting ${s.upgradingTo.eligibleFrom ? dayLabel(s.upgradingTo.eligibleFrom) : "later"}.`
        : `${s.payingBonus} will be added to any ${board} prize you earn.`;
    case "QUALIFYING":
      return `Eligible for a future ${kind} Holder Bonus after qualification requirements are met${s.eligibleFrom ? ` — from the ${board} board starting ${dayLabel(s.eligibleFrom)} UTC` : ""}.`;
    case "BROKEN":
      return `Your ${s.tier ?? ""} holding wasn't verified without a break${s.brokenAt ? ` (${new Date(s.brokenAt).toISOString().slice(5, 16).replace("T", " ")} UTC)` : ""}, so there is no ${board} bonus this period. Your rank and base prize are not affected.`;
    case "NEEDS_VERIFICATION":
      return "We couldn't verify your holdings recently, so nothing is assumed. Refresh your holdings.";
    default:
      return `No ${board} bonus yet.`;
  }
}

/**
 * HOLDER REWARD BONUS — the OPTIONAL holder benefit. Holding $CLANKRPG adds a percentage BONUS to leaderboard prizes you have already
 * earned, if your holdings were verified continuously from before the period began and through it. It NEVER changes your Arena
 * Picks, your score, your rank, a tie-break, hero stats or POWER, and a wallet is never needed to play.
 *
 * "Connect wallet" never trusts the browser: the server issues a message, the wallet signs it, the server verifies the signature
 * and reads the balance itself.
 */
export function HolderBonusCard({ holder, onChanged, token = null }: { holder: HolderCardDto; onChanged: () => void; token?: OfficialToken | null }) {
  const [busy, setBusy] = useState<null | "connect" | "refresh">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isHolder = holder.tier.index > 0;

  async function connect() {
    setError(null);
    setMessage(null);
    const eth = typeof window === "undefined" ? null : ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null);
    if (!eth) return setError("No wallet found in this browser. Open this page in a browser with an EVM wallet (any wallet that supports Robinhood Chain works).");
    setBusy("connect");
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts[0];
      if (!address) throw new Error("no account");
      const challenge = await api<{ nonce: string; message: string }>("/api/me/rewards/holder/challenge", { method: "POST", json: { address } });
      if (!challenge.ok) return setError(typeof challenge.detail?.message === "string" ? challenge.detail.message : "Couldn't start the wallet check.");
      // Signing is free, costs no gas and gives the game no access to funds.
      const signature = (await eth.request({ method: "personal_sign", params: [challenge.data.message, address] })) as string;
      const verified = await api("/api/me/rewards/holder/verify", { method: "POST", json: { nonce: challenge.data.nonce, signature } });
      if (!verified.ok) return setError(typeof verified.detail?.message === "string" ? verified.detail.message : "Couldn't verify that wallet.");
      setMessage("Wallet verified. Your holdings are re-checked about every 30 minutes. A bonus needs verified holding from before a leaderboard period begins.");
      onChanged();
    } catch {
      setError("The wallet request was cancelled.");
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setError(null);
    setMessage(null);
    setBusy("refresh");
    const r = await api<{ refresh: string }>("/api/me/rewards/holder/refresh", { method: "POST", json: {} });
    setBusy(null);
    if (!r.ok) return setError(typeof r.detail?.message === "string" ? r.detail.message : "Couldn't refresh your holdings.");
    setMessage(r.data.refresh === "THROTTLED" ? "Holdings were refreshed a moment ago. You can refresh again in a few minutes." : r.data.refresh === "UNAVAILABLE" ? "The chain couldn't be reached. Nothing changed." : "Holdings refreshed.");
    onChanged();
  }

  const weekly = holder.weekly;
  const showProgress = isHolder && (weekly.status === "QUALIFYING" || weekly.status === "BROKEN");

  // BEFORE LAUNCH there is nothing to verify and nothing to show as a tier: no balance, no tier ladder, no wallet step — only the plain facts and 0 %.
  if (!holder.launched) {
    return (
      <section className="plate p-4 sm:p-5" aria-labelledby="ap-holder" data-testid="holder-card" data-launched="false">
        <h2 id="ap-holder" className="font-display text-lg tracking-wider text-paper uppercase">Holder reward bonus</h2>
        <p className="mt-2 text-sm text-steel-200" data-testid="holder-not-launched">{holder.symbol} has not launched yet.</p>
        <p className="mt-1 text-sm text-steel-300">Holder bonuses will become available after the official token launches.</p>
        <p className="label mt-3">Current bonus</p>
        <p className="font-display text-base text-paper" data-testid="holder-bonus-line">0%</p>
        <p className="mt-3 text-xs font-bold text-paper" data-testid="holder-never">Holdings NEVER affect your Arena Picks score or chance to rank.</p>
      </section>
    );
  }

  return (
    <section className="plate p-4 sm:p-5" aria-labelledby="ap-holder" data-testid="holder-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ap-holder" className="font-display text-lg tracking-wider text-paper uppercase">Holder reward bonus</h2>
        <span className={`chip tnum ${isHolder ? "border-clank-400/50 bg-clank-500/15 text-clank-300" : ""}`} data-testid="holder-tier">{holder.tier.name}</span>
      </div>

      <p className="mt-2 font-display text-base text-paper" data-testid="holder-bonus-line">
        {isHolder ? <>{holder.tier.bonus} <span className="text-sm text-steel-200">Leaderboard Prize Bonus</span></> : <>0% bonus</>}
      </p>

      {isHolder ? (
        <dl className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="label">Balance</dt>
            <dd className="font-display text-lg break-words text-paper tnum" data-testid="holder-balance">{holder.balance ?? "–"} <span className="text-xs text-clank-300">{holder.symbol}</span></dd>
          </div>
          <div className="min-w-0">
            <dt className="label">Wallet</dt>
            <dd className="font-mono text-sm text-paper" data-testid="holder-wallet">{holder.wallet.short ?? "–"}</dd>
          </div>
          <BonusRow label="Daily bonus" kind="Daily" s={holder.daily} testId="holder-daily" />
          <BonusRow label="Weekly bonus" kind="Weekly" s={weekly} testId="holder-weekly" />
        </dl>
      ) : (
        <p className="mt-2 text-sm text-steel-200">Hold {holder.symbol} to boost leaderboard prizes you earn.</p>
      )}

      {showProgress && (
        <p className="mt-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-steel-200" data-testid="holder-progress">
          Weekly qualification progress <b className="font-display text-paper tnum">{formatHeld(Math.min(weekly.heldMs, weekly.requiredMs))} / {formatHeld(weekly.requiredMs)}</b> required before the next eligible week
          {weekly.eligibleFrom && weekly.status === "QUALIFYING" ? <> <span className="text-steel-400">(week of {dayLabel(weekly.eligibleFrom)} UTC)</span></> : null}.
        </p>
      )}

      {holder.verificationNeeded && (
        <div role="status" className="mt-3 rounded-md border border-ember/40 bg-ember/10 px-3 py-2.5" data-testid="holder-verification-needed">
          <p className="font-display text-sm tracking-wider text-ember uppercase">Holdings verification needed</p>
          <p className="mt-1 text-xs text-steel-200">We couldn&apos;t refresh your {holder.symbol} balance, so no holder bonus is assumed for now. Your wallet and everything you&apos;ve earned are safe.</p>
          <button type="button" className="btn btn-sm mt-2" onClick={() => void refresh()} disabled={busy !== null} data-testid="verification-refresh">
            {busy === "refresh" ? "Refreshing…" : "Refresh holdings"}
          </button>
        </div>
      )}

      {!holder.walletConnected && !holder.available && <p className="mt-3 text-xs text-steel-300">Holder benefits aren&apos;t available yet. Arena Picks, Points and the leaderboards work exactly as before.</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!holder.walletConnected ? (
          <button type="button" className="btn btn-sm" onClick={() => void connect()} disabled={!holder.available || busy !== null} data-testid="connect-wallet">
            {busy === "connect" ? "Waiting for wallet…" : "Connect wallet"}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-sm" onClick={() => void refresh()} disabled={busy !== null} data-testid="refresh-holdings">
              {busy === "refresh" ? "Refreshing…" : "Refresh holdings"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void connect()} disabled={busy !== null} title="Verify a different wallet (needs a recent Telegram sign-in; your holder qualification starts again from zero)">
              Change wallet
            </button>
          </>
        )}
      </div>
      {message && <p role="status" className="mt-2 text-xs text-teal">{message}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger" data-testid="holder-error">{error}</p>}

      <p className="label mt-4">Leaderboard prize bonus by holding</p>
      <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="holder-ladder">
        {holder.tiers.map((t) => (
          <li key={t.index} className={`min-w-0 rounded-lg p-2 ring-1 ${t.index === holder.tier.index ? "bg-clank-500/12 ring-clank-400/60" : "bg-white/[0.03] ring-white/10"}`} data-active={t.index === holder.tier.index || undefined}>
            <p className="font-display text-sm text-paper tnum">{t.index === 0 ? "FREE" : `${t.label}+`}</p>
            <p className="text-xs text-clank-300 tnum">{t.index === 0 ? "0%" : t.bonus}</p>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs font-bold text-paper" data-testid="holder-never">Holdings NEVER affect your Arena Picks score or chance to rank.</p>
      <p className="mt-1.5 text-[0.66rem] leading-snug text-steel-400">
        The bonus is extra: it is added to a Daily or Weekly prize you have already earned and never reduces anyone else&apos;s. It needs holdings verified continuously for 24 hours (Daily) or 7 days (Weekly) before the period starts, and until it ends — buying tokens during a leaderboard does not grant an instant bonus.
      </p>
      {token?.address && (
        <p className="mt-2 border-t border-white/10 pt-2 text-[0.66rem] text-steel-400">
          Official {holder.symbol} contract: <span className="font-mono break-all text-steel-200" data-testid="holder-contract">{token.address}</span>
        </p>
      )}
    </section>
  );
}

function BonusRow({ label, kind, s, testId }: { label: string; kind: "Daily" | "Weekly"; s: BonusStatusDto; testId: string }) {
  return (
    <div className="min-w-0 sm:col-span-2" data-testid={testId} data-status={s.status}>
      <dt className="label">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`chip ${STATUS_CLS[s.status]}`} data-testid={`${testId}-status`}>{STATUS_LABEL[s.status]}</span>
        <span className="min-w-0 flex-1 text-xs leading-snug text-steel-300">{explain(kind, s)}</span>
      </dd>
    </div>
  );
}
