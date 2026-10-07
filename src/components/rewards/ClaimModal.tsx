"use client";

import { useRef, useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";

import type { RewardsSummary } from "./useRewards";

const looksLikeAddress = (v: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(v.trim());

/**
 * CLAIM $CLANKRPG — a request for a MANUAL payout; nothing is sent automatically. Where should this reward go?
 *
 *  · a member with a SIGNATURE-VERIFIED holder wallet chooses between that connected wallet and any other EVM address;
 *  · everyone else just types an address (no wallet connection is needed to claim).
 *
 * Choosing another address is for THIS payout only: it never changes the holder wallet that proves their holdings. Everything
 * here is a courtesy — the server validates the address and the eligibility, and derives the amount from the reward ledger (the
 * browser never sends one). One idempotency key per opened dialog: a double click can never create a second request.
 */
export function ClaimModal({ rewards, onClose, onDone }: { rewards: RewardsSummary; onClose: () => void; onDone: (message: string) => void }) {
  const hasHolderWallet = rewards.holderWallet.short !== null;
  const [choice, setChoice] = useState<"HOLDER_WALLET" | "CUSTOM">(hasHolderWallet ? "HOLDER_WALLET" : "CUSTOM");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(`claim-${crypto.randomUUID()}`);
  const needsAddress = choice === "CUSTOM";
  const valid = !needsAddress || looksLikeAddress(address);

  async function submit() {
    setBusy(true);
    setError(null);
    const r = await api<{ claim: { amount: string } }>("/api/me/rewards/claim", {
      method: "POST",
      json: needsAddress ? { idempotencyKey: key.current, destination: "CUSTOM", address: address.trim() } : { idempotencyKey: key.current, destination: "HOLDER_WALLET" },
    });
    setBusy(false);
    if (!r.ok) {
      setError(typeof r.detail?.message === "string" ? r.detail.message : "Couldn't submit the claim. Please try again.");
      return;
    }
    onDone(`Claim submitted — ${r.data.claim.amount} ${rewards.symbol} is pending a manual payout.`);
  }

  return (
    <Modal title="Claim rewards" onClose={onClose}>
      <div className="space-y-3.5" data-testid="claim-modal">
        <div>
          <p className="label">Claimable</p>
          <p className="font-display text-xl text-clank-200 tnum" data-testid="claim-amount">{rewards.claimable} <span className="text-sm text-clank-300">{rewards.symbol}</span></p>
        </div>

        {hasHolderWallet ? (
          <fieldset className="space-y-2">
            <legend className="label">Where should we send your rewards?</legend>
            <label className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm ${choice === "HOLDER_WALLET" ? "border-clank-400/60 bg-clank-500/10" : "border-white/10 bg-white/[0.03]"}`}>
              <input type="radio" name="claim-destination" className="mt-1" checked={choice === "HOLDER_WALLET"} onChange={() => setChoice("HOLDER_WALLET")} data-testid="claim-dest-connected" />
              <span className="min-w-0">
                <b className="block text-paper">Connected Wallet</b>
                <span className="block font-mono text-xs break-all text-steel-300" data-testid="claim-wallet">{rewards.holderWallet.short}</span>
              </span>
            </label>
            <label className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm ${choice === "CUSTOM" ? "border-clank-400/60 bg-clank-500/10" : "border-white/10 bg-white/[0.03]"}`}>
              <input type="radio" name="claim-destination" className="mt-1" checked={choice === "CUSTOM"} onChange={() => setChoice("CUSTOM")} data-testid="claim-dest-other" />
              <span className="min-w-0"><b className="block text-paper">Another Wallet</b></span>
            </label>
          </fieldset>
        ) : (
          <p className="text-xs text-steel-300">Enter the wallet where you want to receive your rewards. No wallet connection is needed.</p>
        )}

        {needsAddress && (
          <div>
            <label htmlFor="claim-address" className="label">EVM wallet address</label>
            <input
              id="claim-address"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="mt-1 w-full rounded-md border border-white/15 bg-ink-950/70 px-3 py-2 font-mono text-sm text-paper outline-none focus:border-clank-400"
              aria-invalid={address !== "" && !valid}
              data-testid="claim-address"
            />
            <p className="mt-1.5 text-xs text-steel-400">Make sure the address supports Robinhood Chain.</p>
            {hasHolderWallet && <p className="mt-1 text-xs text-steel-400">This address is for this payout only — your connected holder wallet and holder qualification don&apos;t change.</p>}
          </div>
        )}

        <p className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-steel-300">Rewards are paid out manually. After you submit, the amount is reserved and shows as <b className="text-paper">Pending</b> until it is sent.</p>

        {error && (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="claim-error">
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-sm" onClick={() => void submit()} disabled={busy || !valid} data-testid="claim-confirm">
            {busy ? "Submitting…" : "Submit claim"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
