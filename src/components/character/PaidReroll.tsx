"use client";

import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";

import { PixelArt } from "@/components/arena/PrizePools";
import { useResumeRefetch } from "@/components/time/useResumeRefetch";
import { CheckIcon, RerollIcon, WarningIcon } from "@/components/ui/Icons";
import { PAID_MESSAGE, type PaidRerollOutcomeDto, type PaidRerollStatusDto } from "@/domain/hero/paidReroll";
import { api, friendly, isTransient } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";

import { HeroLine, RerollDialog, RerollResultView } from "./FreeReroll";
import { CREDIT_KEPT_CODES, clearPending, initialPaidFlow, loadPending, paidFlowReducer, savePending, type PaidFlow, type PaidFlowProblem, type WalletPhase } from "./paidRerollFlow";
import { heroStateKey } from "./rerollFlow";
import { connectAccount, ensureChain, injectedProvider, linkWallet, sendPayment, WALLET_MESSAGE, WalletError } from "./walletClient";

/**
 * PAID HERO REROLL — the member's panel under the free reroll, the irreversible-action confirmation, the wallet steps and the result.
 *
 *   PaidRerollCard     the panel: FREE_FIRST · AVAILABLE (the price and one button) · CREDIT_WAITING · LIMIT_REACHED · BLOCKED · DISABLED / UNAVAILABLE
 *   PaidConfirmView    "REROLL FOR 100,000 $CLANKRPG?" — what will be paid, to whom, the warning (it can be weaker, it cannot be undone), an acknowledgement
 *   PaidProgressView   the wallet is open / the payment is being verified on-chain — and, once it is sent, only ever "your payment is safe", never a second payment
 *   PaidRerollPanel    the stateful whole (status read, the wallet steps, the flow reducer, recovery of an unresolved payment after a reload)
 *
 * The server decides everything (the price, the recipient, the calldata, whether the payment counts); the browser only forwards what the server asked for.
 */

// ------------------------------------------------------------------------------------------------ a small pixel coin for the header
const COIN = [
  "...oooooo...",
  "..oGGGGGGgo.",
  ".oGGwwwwGggo",
  "oGGwGGGGGggd",
  "oGwGGggGGggd",
  "oGwGgGGgGggd",
  "oGwGgGGgGggd",
  "oGGwGggGgggd",
  "ogGGwwwGgggd",
  ".odggggggddo",
  "..oddddddoo.",
  "...oooooo...",
] as const;

const short = (a: string | null): string => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

// ------------------------------------------------------------------------------------------------ the panel (pure view)
export interface PaidRerollCardProps {
  status: PaidRerollStatusDto | null;
  loading?: boolean;
  failed?: boolean;
  onRetry?: () => void;
  onStart?: () => void;
  /** Use a payment that is already confirmed (no new payment). */
  onUseCredit?: () => void;
}

export function PaidRerollCard({ status, loading = false, failed = false, onRetry, onStart, onUseCredit }: PaidRerollCardProps) {
  const titleId = useId();
  const state = status?.state ?? (failed ? "ERROR" : "LOADING");
  const price = status?.price ? `${status.price.label} ${status.price.symbol}` : null;
  const chip =
    state === "AVAILABLE" ? { text: `${status!.usedToday}/${status!.maxPerDay} today`, cls: "border-gold/40 bg-gold/10 text-gold" }
    : state === "CREDIT_WAITING" ? { text: "Payment confirmed", cls: "border-teal/50 bg-teal/10 text-teal" }
    : state === "DISABLED" ? { text: "Not open yet", cls: "border-white/15 bg-white/[0.04] text-steel-300" }
    : null;
  return (
    <section className="plate plate-flat p-4" aria-labelledby={titleId} data-testid="paid-reroll" data-state={state} aria-busy={loading || state === "LOADING"}>
      <div className="flex items-center gap-2.5">
        <PixelArt rows={COIN} size={24} />
        <h2 id={titleId} className="min-w-0 flex-1 font-display text-[0.82rem] tracking-[0.1em] text-paper uppercase" data-testid="paid-reroll-title">Reroll again</h2>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="min-w-0 text-[0.7rem] leading-snug text-steel-300">Used your free reroll? Pay {price ?? "$CLANKRPG"} for another roll — same odds, any time of day.</p>
        {chip && <span className={`chip shrink-0 uppercase ${chip.cls}`} data-testid="paid-reroll-chip">{chip.text}</span>}
      </div>

      {state === "LOADING" && <div className="mt-3 h-11 animate-pulse rounded-md bg-white/[0.05]" data-testid="paid-reroll-loading" />}

      {state === "ERROR" && (
        <div className="mt-3" role="status" data-testid="paid-reroll-error">
          <p className="text-sm text-steel-200">Couldn&apos;t check paid rerolls.</p>
          <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={onRetry}>Retry</button>
        </div>
      )}

      {status?.state === "AVAILABLE" && (
        <div className="mt-3">
          <button type="button" className="btn w-full justify-center" onClick={onStart} data-testid="paid-reroll-open">
            <RerollIcon size={18} />
            <span>Pay {price} &amp; reroll</span>
          </button>
          <p className="mt-2 text-center text-[0.68rem] text-steel-300">
            Your wallet opens to approve the payment{status.wallet.linked ? "" : " (you'll link it to your hero first — free, no gas)"}. You&apos;ll confirm first. Your new hero could be weaker.
          </p>
        </div>
      )}

      {status?.state === "FREE_FIRST" && (
        <div className="mt-3">
          <p className="flex gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm leading-snug text-steel-200" role="status" data-testid="paid-reroll-free-first">
            <CheckIcon size={16} className="mt-0.5 shrink-0 text-teal" />
            <span>{status.message}</span>
          </p>
          <button type="button" className="btn mt-3 w-full justify-center" disabled aria-disabled="true" data-testid="paid-reroll-open-disabled">
            <RerollIcon size={18} />
            <span>Pay {price} &amp; reroll</span>
          </button>
        </div>
      )}

      {status?.state === "CREDIT_WAITING" && (
        <div className="mt-3" data-testid="paid-reroll-credit">
          <p className="flex gap-2 rounded-md border border-teal/30 bg-teal/[0.07] px-3 py-2 text-sm leading-snug text-steel-100" role="status">
            <CheckIcon size={16} className="mt-0.5 shrink-0 text-teal" />
            <span>{status.message}</span>
          </p>
          <button type="button" className="btn mt-3 w-full justify-center" onClick={onUseCredit} disabled={status.block === "HERO_IN_ARENA"} data-testid="paid-reroll-use-credit">
            <RerollIcon size={18} />
            <span>Use my paid reroll</span>
          </button>
        </div>
      )}

      {(status?.state === "LIMIT_REACHED" || status?.state === "BLOCKED") && (
        <p className="mt-3 flex gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm leading-snug text-steel-200" role="status" data-testid="paid-reroll-blocked" data-block={status.block ?? ""}>
          <WarningIcon size={16} className="mt-0.5 shrink-0 text-steel-300" />
          <span>{status.message}</span>
        </p>
      )}

      {(status?.state === "DISABLED" || status?.state === "UNAVAILABLE") && (
        <p className="mt-3 text-sm leading-snug text-steel-300" role="status" data-testid="paid-reroll-disabled">{status.message ?? PAID_MESSAGE.DISABLED}</p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ the confirmation (pure view)
export interface PaidConfirmProps {
  status: PaidRerollStatusDto;
  /** Applying a payment that is already confirmed: nothing more to pay. */
  credit: boolean;
  acknowledged: boolean;
  submitting: boolean;
  error: PaidFlowProblem | null;
  titleId: string;
  onToggle: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function PaidConfirmView({ status, credit, acknowledged, submitting, error, titleId, onToggle, onCancel, onConfirm }: PaidConfirmProps) {
  const ackId = useId();
  const price = status.price ? `${status.price.label} ${status.price.symbol}` : "";
  const blocked = Boolean(error && !error.retryable);
  return (
    <div data-testid="paid-confirm">
      <h3 id={titleId} className="font-display text-xl tracking-wide text-clank-300 uppercase">{credit ? "Use your paid reroll?" : "Reroll your hero?"}</h3>
      <p className="mt-1 text-sm text-steel-200">Your current hero will be replaced with a new random roll.</p>

      {status.current && (
        <div className="mt-4 rounded-md border border-white/10 bg-white/[0.03] p-3">
          <p className="label mb-2">Current hero</p>
          <HeroLine card={status.current} size={104} />
        </div>
      )}

      {credit ? (
        <p className="mt-3 rounded-md border border-teal/30 bg-teal/[0.07] p-3 text-sm leading-snug text-steel-100" data-testid="paid-confirm-credit">Your payment is already confirmed — nothing more to pay.</p>
      ) : (
        <div className="mt-3 rounded-md border border-gold/30 bg-gold/[0.06] p-3 text-sm leading-snug text-steel-100" data-testid="paid-confirm-price">
          <p><b className="font-display tracking-wide text-gold uppercase">Cost:</b> <b className="tnum">{price}</b>, sent from your own wallet to the Clank RPG reward treasury, which funds the prize pools.</p>
          <p className="mt-1 text-[0.74rem] text-steel-300">Your wallet will open and show the payment — nothing moves unless you approve it there. Clank RPG never holds your keys.</p>
        </div>
      )}

      <div role="note" className="mt-3 flex gap-2.5 rounded-md border border-ember/50 bg-ember/10 p-3 text-sm leading-snug text-paper" data-testid="paid-confirm-warning">
        <WarningIcon size={20} className="mt-0.5 shrink-0 text-ember" />
        <p>
          <b className="font-display tracking-wide text-ember uppercase">Warning:</b> a paid reroll is exactly as random as a free one. Your new hero could have a <b>lower rarity</b>, <b>lower PWR</b>, a <b>different class</b> and a <b>different appearance</b>.
          Once rerolled, you <b>cannot restore</b> your previous hero{credit ? "" : " — and the payment is not refunded"}.
        </p>
      </div>

      <ul className="mt-3 space-y-1.5 text-[0.76rem] leading-snug text-steel-300">
        <li><b className="text-steel-100">You keep:</b> your Gold, items, achievements, Arena record, Picks, Points and rewards.</li>
        <li><b className="text-steel-100">Gear</b> made for your old class stays in your inventory but won&apos;t apply to a different class.</li>
      </ul>

      <label htmlFor={ackId} className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-md border border-white/10 bg-white/[0.03] p-3 text-sm leading-snug text-paper has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-clank-300">
        <input id={ackId} type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[#b779f5]" checked={acknowledged} onChange={onToggle} disabled={submitting || blocked} data-testid="paid-confirm-ack" />
        <span>I understand that my new hero could be weaker, that this reroll cannot be undone{credit ? "" : ", and that the payment is not refunded"}.</span>
      </label>

      {error && (
        <p role="alert" className={`mt-3 rounded-md border px-3 py-2 text-sm leading-snug ${error.retryable ? "border-ember/40 bg-ember/10 text-paper" : "border-white/15 bg-white/[0.04] text-steel-100"}`} data-testid="paid-confirm-error" data-code={error.code}>
          {error.message}
        </p>
      )}

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn btn-ghost justify-center" onClick={onCancel} disabled={submitting} data-autofocus data-testid="paid-confirm-cancel">{blocked ? "Close" : "Cancel"}</button>
        {!blocked && (
          <button type="button" className="btn justify-center" onClick={onConfirm} disabled={!acknowledged || submitting} aria-busy={submitting} data-testid="paid-confirm-button">
            {credit ? <span>Reroll now</span> : <span className="flex flex-col items-center leading-tight"><span>Pay {price}</span><span className="text-[0.6rem] font-normal tracking-wide normal-case opacity-80">Opens your wallet</span></span>}
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the wallet is open / the payment is being verified (pure view)
const PHASE_TEXT: Record<WalletPhase, string> = {
  CONNECT: "Connect your wallet — approve the connection in the wallet window.",
  LINK: "Sign the message in your wallet to link it to your hero. It's free and gives Clank RPG no access to your funds.",
  NETWORK: "Switch your wallet to the right network when it asks.",
  PAY: "Approve the payment in your wallet.",
};

export function PaidProgressView({ flow, titleId, explorerTxUrl, onCheckAgain }: { flow: Extract<PaidFlow, { step: "wallet" | "verifying" }>; titleId: string; explorerTxUrl: string | null; onCheckAgain: () => void }) {
  if (flow.step === "wallet") {
    return (
      <div data-testid="paid-wallet" role="status" data-phase={flow.phase}>
        <h3 id={titleId} className="font-display text-xl tracking-wide text-clank-300 uppercase">Waiting for your wallet…</h3>
        <p className="mt-2 text-sm leading-snug text-steel-200">{PHASE_TEXT[flow.phase]}</p>
        <p className="mt-3 text-[0.72rem] leading-snug text-steel-400">Nothing has been paid yet. You can decline any prompt to stop.</p>
      </div>
    );
  }
  const link = explorerTxUrl ? explorerTxUrl.replace("{hash}", flow.txHash) : null;
  return (
    <div data-testid="paid-verifying" role="status" data-busy={flow.busy}>
      <h3 id={titleId} className="font-display text-xl tracking-wide text-clank-300 uppercase">{flow.problem ? "Your payment is safe" : "Payment sent"}</h3>
      {flow.problem ? (
        <p className="mt-2 text-sm leading-snug text-steel-100" data-testid="paid-verifying-problem" data-code={flow.problem.code}>{flow.problem.message}</p>
      ) : (
        <p className="mt-2 text-sm leading-snug text-steel-200">
          Confirming it on-chain{flow.confirmations !== null && flow.required ? ` — ${Math.min(flow.confirmations, flow.required)}/${flow.required} confirmations` : "…"}. This usually takes a few seconds.
        </p>
      )}
      <p className="mt-3 text-[0.72rem] leading-snug text-steel-400">
        Don&apos;t pay again. Your payment is recorded on-chain and with us — if you close this page, come back and your reroll will finish.
        {link && <> <a href={link} target="_blank" rel="noopener noreferrer" className="text-clank-300 underline">View transaction</a></>}
      </p>
      {!flow.busy && (
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn justify-center" onClick={onCheckAgain} data-autofocus data-testid="paid-check-again">Check again</button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the stateful whole
interface StatusEnvelope {
  status: PaidRerollStatusDto;
}

const newKey = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "00000000-0000-4000-8000-000000000000".replace(/0/g, () => Math.floor(Math.random() * 16).toString(16)));
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const POLL_MS = 4000;
const POLL_TRIES = 60;

export function PaidRerollPanel({ onRerolled }: { /** The hero changed on the server: reload whatever shows it. */ onRerolled?: () => void }) {
  const { data, error, loading, reload } = useRemote<StatusEnvelope>(() => api<StatusEnvelope>("/api/me/hero/reroll/paid"), "paid-reroll-status");
  const [flow, dispatch] = useReducer(paidFlowReducer, initialPaidFlow);
  /** When set, the dialog applies this ALREADY-CONFIRMED payment instead of asking for a new one. */
  const [creditHash, setCreditHash] = useState<string | null>(null);
  const status = data?.status ?? null;
  const titleId = useId();
  const busy = useRef(false);
  const alive = useRef(true);
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useResumeRefetch(reload);

  /** Turns a payment into a reroll: asks the server, waits while it is not confirmed, and ends only on a result or a message that says the payment is safe. */
  const verify = useCallback(
    async (requestId: string, txHash: string) => {
      for (let attempt = 0; attempt < POLL_TRIES && alive.current; attempt++) {
        dispatch({ type: "ASKING" });
        const r = await api<{ outcome: PaidRerollOutcomeDto }>("/api/me/hero/reroll/paid", { method: "POST", json: { requestId, txHash }, timeoutMs: 30_000 });
        if (!alive.current) return;
        if (r.ok) {
          const o = r.data.outcome;
          if (o.status === "APPLIED") {
            clearPending();
            dispatch({ type: "APPLIED", result: o.result, payment: o.payment });
            reload();
            return;
          }
          dispatch({ type: "PENDING", confirmations: o.confirmations, required: o.required });
          await sleep(POLL_MS);
          continue;
        }
        const detail = r.detail as { message?: string } | undefined;
        if (isTransient(r.error) || r.error === "PAYMENT_CHECK_UNAVAILABLE" || r.error === "PAID_REROLL_UNAVAILABLE" || r.status >= 500) {
          dispatch({ type: "CHECK_FAILED" });
          return;
        }
        if (r.error === "RATE_LIMITED") {
          await sleep(POLL_MS * 2);
          continue;
        }
        const message = detail?.message ?? friendly(r.error);
        if (CREDIT_KEPT_CODES.has(r.error)) {
          // recorded as a credit on the server: the status panel offers it again — no second payment, ever
          clearPending();
          dispatch({ type: "REFUSED", problem: { code: r.error, message, retryable: false } });
          reload();
          return;
        }
        // the payment itself does not count (or the feature closed): say why, plainly
        clearPending();
        dispatch({ type: "REFUSED", problem: { code: r.error, message, retryable: false } });
        reload();
        return;
      }
      if (alive.current) dispatch({ type: "PENDING", confirmations: 0, required: 0 });
    },
    [reload],
  );

  // A payment that was sent in an earlier visit and never turned into a reroll (a reload, a closed tab): finish it. The server is idempotent on the hash.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !status || status.state === "DISABLED" || status.state === "UNAVAILABLE") return;
    const p = loadPending();
    resumed.current = true;
    if (!p) return;
    dispatch({ type: "RESUME", requestId: p.requestId, txHash: p.txHash });
    void verify(p.requestId, p.txHash);
  }, [status, verify]);

  const open = () => {
    if (status?.state !== "AVAILABLE") return;
    setCreditHash(null);
    dispatch({ type: "OPEN", requestId: newKey() });
  };
  const useCredit = () => {
    if (status?.state !== "CREDIT_WAITING" || !status.credit || status.block === "HERO_IN_ARENA") return;
    setCreditHash(status.credit.txHash);
    dispatch({ type: "OPEN", requestId: newKey() });
  };

  const confirm = async () => {
    if (busy.current || flow.step !== "confirm" || !flow.acknowledged) return; // one start per confirmation, however fast the clicks come
    const payment = status?.payment ?? null;
    if (!creditHash && !payment) return;
    busy.current = true;
    const requestId = flow.requestId;
    dispatch({ type: "START" });
    let txHash = creditHash;
    try {
      if (!txHash) {
        const eth = injectedProvider();
        if (!eth) throw new WalletError("NO_WALLET", WALLET_MESSAGE.NO_WALLET);
        const account = await connectAccount(eth);
        const known = status?.wallet.addresses ?? [];
        if (known.length === 0) {
          dispatch({ type: "PHASE", phase: "LINK" });
          await linkWallet(eth, account);
        } else if (!known.includes(account)) {
          throw new WalletError("WRONG_ACCOUNT", `${WALLET_MESSAGE.WRONG_ACCOUNT} (${short(known[0] ?? null)})`);
        }
        dispatch({ type: "PHASE", phase: "NETWORK" });
        await ensureChain(eth, payment as NonNullable<typeof payment>);
        dispatch({ type: "PHASE", phase: "PAY" });
        txHash = await sendPayment(eth, account, payment as NonNullable<typeof payment>);
      }
      // From here the member HAS paid (or is using a payment that was already confirmed): remember it, and never ask for another.
      savePending({ requestId, txHash });
      dispatch({ type: "PAID", txHash });
      await verify(requestId, txHash);
    } catch (e) {
      if (e instanceof WalletError) dispatch({ type: "REFUSED", problem: { code: e.code, message: e.message, retryable: true } });
      else dispatch({ type: "REFUSED", problem: { code: "FAILED", message: "Something went wrong before the payment was sent. Nothing was paid — try again.", retryable: true } });
    } finally {
      busy.current = false;
    }
  };

  const checkAgain = async () => {
    if (flow.step !== "verifying" || busy.current) return;
    busy.current = true;
    try {
      await verify(flow.requestId, flow.txHash);
    } finally {
      busy.current = false;
    }
  };

  const closeResult = () => {
    dispatch({ type: "DISMISS_RESULT" });
    setCreditHash(null);
    window.setTimeout(() => heading.current?.querySelector<HTMLElement>("h2")?.focus(), 0);
  };

  // THE HERO CHANGED UNDER US (our own paid reroll, one in another tab): tell the page to re-read whatever shows the hero.
  const knownHero = useRef<string | null>(null);
  const currentKey = heroStateKey(status?.current);
  useEffect(() => {
    if (currentKey === null) return;
    if (knownHero.current !== null && knownHero.current !== currentKey) onRerolled?.();
    knownHero.current = currentKey;
  }, [currentKey, onRerolled]);

  const cancel = () => dispatch({ type: "CANCEL" });
  // A "your payment is safe" message (verifying with a problem that cannot be retried) has a Close button of its own.
  const closeProblem = () => dispatch({ type: "CLOSE_PROBLEM" });
  const showDialog = flow.step !== "closed";

  return (
    <div ref={heading}>
      <PaidRerollCard status={status} loading={loading && !status} failed={!status && Boolean(error)} onRetry={reload} onStart={open} onUseCredit={useCredit} />
      {showDialog && (
        <RerollDialog
          labelledBy={titleId}
          step={flow.step}
          onEscape={() => (flow.step === "result" ? closeResult() : flow.step === "verifying" && flow.problem && !flow.problem.retryable ? closeProblem() : cancel())}
          onBackdrop={() => (flow.step === "result" ? undefined : cancel())}
        >
          {flow.step === "result" ? (
            <RerollResultView result={flow.result} titleId={titleId} onView={closeResult} footnote={`Your old hero stays in your history. You paid ${flow.payment.amountLabel} ${flow.payment.symbol} for this reroll.`} />
          ) : flow.step === "wallet" || flow.step === "verifying" ? (
            <>
              <PaidProgressView flow={flow} titleId={titleId} explorerTxUrl={status?.explorerTxUrl ?? null} onCheckAgain={() => void checkAgain()} />
              {flow.step === "verifying" && flow.problem && !flow.problem.retryable && (
                <div className="mt-3 flex justify-end">
                  <button type="button" className="btn btn-ghost justify-center" onClick={closeProblem} data-autofocus data-testid="paid-close-problem">Close</button>
                </div>
              )}
            </>
          ) : status ? (
            <PaidConfirmView
              status={status}
              credit={creditHash !== null}
              acknowledged={flow.step === "confirm" && flow.acknowledged}
              submitting={false}
              error={flow.step === "confirm" ? flow.error : null}
              titleId={titleId}
              onToggle={() => dispatch({ type: "TOGGLE_ACK" })}
              onCancel={cancel}
              onConfirm={() => void confirm()}
            />
          ) : null}
        </RerollDialog>
      )}
    </div>
  );
}

export type { PaidFlow };
