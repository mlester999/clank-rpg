"use client";

import { useState } from "react";

import { api, friendly } from "@/lib/api";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

type SyncResult =
  | { status: "OK"; eligibleTokens: number; holdingScore: number; loyaltyDays: number; holdings: Array<{ symbol: string; supplyFraction: number; streakDays: number }> }
  | { status: "NO_WALLET" | "DISABLED" | "THROTTLED" }
  | { status: "UNAVAILABLE"; reason: string };

export function WalletPanel({ linkedAddress, bondedCoins, diamondDays, onChanged }: { linkedAddress: string | null; bondedCoins: number; diamondDays: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);

  const provider = (): Eip1193 | null => (typeof window === "undefined" ? null : ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null));

  async function link() {
    setMessage(null);
    const eth = provider();
    if (!eth) return setMessage("No wallet found in this browser. Install a Robinhood Chain-compatible wallet (any EVM wallet works).");
    setBusy(true);
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts[0];
      if (!address) throw new Error("no account");
      const challenge = await api<{ nonce: string; message: string }>("/api/me/wallet/challenge", { method: "POST", json: { address } });
      if (!challenge.ok) return setMessage(friendly(challenge.error));
      // Signing is free, costs no gas, and gives the game no access to funds.
      const signature = (await eth.request({ method: "personal_sign", params: [challenge.data.message, address] })) as string;
      const verified = await api<{ holdings: SyncResult }>("/api/me/wallet/verify", { method: "POST", json: { nonce: challenge.data.nonce, signature } });
      if (!verified.ok) return setMessage(friendly(verified.error));
      setResult(verified.data.holdings);
      setMessage("Wallet linked.");
      onChanged();
    } catch {
      setMessage("Wallet request was cancelled.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    const r = await api<{ holdings: SyncResult }>("/api/me/wallet/refresh", { method: "POST", json: {} });
    setBusy(false);
    if (r.ok) {
      setResult(r.data.holdings);
      onChanged();
    } else setMessage(friendly(r.error));
  }

  async function unlink() {
    setBusy(true);
    await api("/api/me/wallet/refresh", { method: "DELETE" });
    setBusy(false);
    setResult(null);
    setMessage("Wallet unlinked. Wallet bonuses have been removed.");
    onChanged();
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-steel-300">
        Linking a wallet is optional. It adds small, capped bonuses for holding <b className="text-paper">bonded Clank.trade coins</b> on Robinhood Chain — never more than a modest slice of your hero&apos;s strength.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Wallet" value={linkedAddress ? `${linkedAddress.slice(0, 6)}…${linkedAddress.slice(-4)}` : "Not linked"} />
        <Stat label="Bonded coins held" value={linkedAddress ? String(bondedCoins) : "–"} />
        <Stat label="Diamond Hands" value={linkedAddress ? `${diamondDays} day${diamondDays === 1 ? "" : "s"}` : "–"} />
      </div>
      <div className="flex flex-wrap gap-2">
        {!linkedAddress ? (
          <button className="btn" disabled={busy} onClick={link} type="button">{busy ? "Waiting for wallet…" : "Connect & sign"}</button>
        ) : (
          <>
            <button className="btn btn-teal btn-sm" disabled={busy} onClick={refresh} type="button">Re-verify holdings</button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={link} type="button">Use a different wallet</button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={unlink} type="button">Unlink</button>
          </>
        )}
      </div>
      {message && <p role="status" className="text-sm text-clank-300">{message}</p>}
      {result?.status === "UNAVAILABLE" && <p role="status" className="text-sm text-steel-300">Chain data is unreachable right now: {result.reason} Your previous verified bonuses are unchanged.</p>}
      {result?.status === "THROTTLED" && <p role="status" className="text-sm text-steel-300">Holdings were verified moments ago. Try again in a few minutes.</p>}
      {result?.status === "OK" && (
        <div className="rounded-md border border-white/10 bg-white/5 p-3 text-sm">
          {result.holdings.length === 0 ? (
            <p className="text-steel-300">No eligible bonded coins found in this wallet yet.</p>
          ) : (
            <ul className="space-y-1">
              {result.holdings.map((h) => (
                <li key={h.symbol} className="flex justify-between gap-3">
                  <span className="font-semibold text-paper">{h.symbol}</span>
                  <span className="text-steel-300 tnum">{(h.supplyFraction * 100).toFixed(3)}% of supply · {h.streakDays}d streak</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="text-xs text-steel-400">Streaks count from the first time we verified your balance, and reset if you sell down or we can&apos;t verify for several days.</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/5 p-3">
      <p className="label">{label}</p>
      <p className="mt-1 font-display text-base text-paper">{value}</p>
    </div>
  );
}
