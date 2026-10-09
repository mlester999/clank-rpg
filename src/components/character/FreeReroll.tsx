"use client";

import { useCallback, useEffect, useId, useReducer, useRef, useState, type ReactNode } from "react";

import { PixelArt } from "@/components/arena/PrizePools";
import { HeroArena } from "@/components/hero/HeroArena";
import { PwrDelta, PwrValue, RarityBadge, rarityStyle } from "@/components/hero/rarity";
import { ResetCountdown } from "@/components/time/ResetCountdown";
import { useResumeRefetch } from "@/components/time/useResumeRefetch";
import { CheckIcon, RerollIcon, TimerIcon, WarningIcon } from "@/components/ui/Icons";
import { rarityClassLine, type HeroCardModel } from "@/domain/hero/card";
import { compareRerolled, type FreeRerollResultDto, type FreeRerollStatusDto, type RerollOddsView } from "@/domain/hero/freeReroll";
import { api, friendly } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";

import { heroStateKey, initialRerollFlow, isRetryable, isUncertain, rerollFlowReducer, type RerollFlow, type RerollFlowError } from "./rerollFlow";

/**
 * FREE HERO REROLL — the member's panel on their own hero page, the irreversible-action confirmation and the result.
 *
 *   FreeRerollCard      the panel: AVAILABLE · USED (a countdown to the next 00:00 UTC) · BLOCKED · DISABLED / UNAVAILABLE — never a clickable button that is not really available
 *   RerollConfirmView   "REROLL YOUR HERO?" — the current hero, the warning (it can be weaker, it cannot be undone), what is kept, the odds, an acknowledgement, Cancel / Confirm
 *   RerollResultView    "YOUR NEW HERO" — the server-confirmed new hero, honestly compared with the old one
 *   FreeRerollPanel     the stateful whole (status read, the flow reducer, the dialogs)
 *
 * The server decides everything; the countdown is a display anchored to the server's clock and, when it reaches zero, the panel ASKS the server what is true now.
 */

// ------------------------------------------------------------------------------------------------ a small pixel die for the header
const DIE = [
  "..oooooooo..",
  ".oVVVVVVVVo.",
  "oVwwwwwwwwvo",
  "oVwuuwwuuwvo",
  "oVwuuwwuuwvo",
  "oVwwwuuwwwvo",
  "oVwwwuuwwwvo",
  "oVwuuwwuuwvo",
  "oVwuuwwuuwvo",
  "oVwwwwwwwwvo",
  ".ouvvvvvvuo.",
  "..oooooooo..",
] as const;

const EXACT_FORMAT = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// ------------------------------------------------------------------------------------------------ the panel (pure view)
export interface FreeRerollCardProps {
  status: FreeRerollStatusDto | null;
  loading?: boolean;
  /** Reading the status failed (and nothing is known): a retry button is shown. */
  failed?: boolean;
  onRetry?: () => void;
  onReroll?: () => void;
  /** The countdown reached zero: ask the server what is true now. */
  onElapsed?: () => void;
  /** The server could not be asked after the countdown ended. */
  checking?: boolean;
}

export function FreeRerollCard({ status, loading = false, failed = false, onRetry, onReroll, onElapsed, checking = false }: FreeRerollCardProps) {
  const titleId = useId();
  const state = status?.state ?? (failed ? "ERROR" : "LOADING");
  const chip =
    state === "AVAILABLE" ? { text: "1 available", cls: "border-teal/50 bg-teal/10 text-teal" }
    : state === "USED" ? { text: "Used today", cls: "border-white/15 bg-white/[0.04] text-steel-300" }
    : state === "DISABLED" ? { text: "Not open yet", cls: "border-white/15 bg-white/[0.04] text-steel-300" }
    : null;
  return (
    <section className="plate plate-clank p-4" aria-labelledby={titleId} data-testid="free-reroll" data-state={state} aria-busy={loading || state === "LOADING"}>
      <div className="flex items-center gap-2.5">
        <PixelArt rows={DIE} size={26} />
        <h2 id={titleId} tabIndex={-1} className="min-w-0 flex-1 font-display text-[0.82rem] tracking-[0.1em] text-paper uppercase" style={{ outline: "none" }} data-testid="free-reroll-title">Free hero reroll</h2>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="min-w-0 text-[0.7rem] leading-snug text-steel-300">One new random roll every day. No cost.</p>
        {chip && <span className={`chip shrink-0 uppercase ${chip.cls}`} data-testid="free-reroll-chip">{chip.text}</span>}
      </div>

      {state === "LOADING" && <div className="mt-3 h-11 animate-pulse rounded-md bg-white/[0.05]" data-testid="free-reroll-loading" />}

      {state === "ERROR" && (
        <div className="mt-3" role="status" data-testid="free-reroll-error">
          <p className="text-sm text-steel-200">Couldn&apos;t check your free reroll.</p>
          <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={onRetry}>Retry</button>
        </div>
      )}

      {status?.state === "AVAILABLE" && (
        <div className="mt-3">
          <button type="button" className="btn w-full justify-center" onClick={onReroll} data-testid="free-reroll-open">
            <RerollIcon size={18} />
            <span>Reroll hero</span>
          </button>
          <p className="mt-2 text-center text-[0.68rem] text-steel-300">You&apos;ll confirm first. Your new hero could be weaker.</p>
        </div>
      )}

      {status?.state === "USED" && (
        <div className="mt-3">
          <p className="font-display text-xs tracking-[0.14em] text-paper uppercase" data-testid="free-reroll-used">Free reroll used</p>
          <div className="mt-2 flex items-center gap-3 rounded-md border border-clank-400/30 bg-clank-500/[0.07] px-3 py-2.5">
            <TimerIcon size={22} className="shrink-0 text-clank-300" />
            <div className="min-w-0" title={`Resets at ${EXACT_FORMAT(status.nextResetAt)}`}>
              <p className="label">Next free reroll in</p>
              <ResetCountdown serverNow={status.serverNow} endsAt={status.nextResetAt} label="Next free reroll in" onElapsed={onElapsed} className="block font-display text-2xl leading-tight text-paper sm:text-[1.65rem]" testId="free-reroll-countdown" />
            </div>
          </div>
          {checking && <p role="status" className="mt-2 text-[0.7rem] text-steel-300" data-testid="free-reroll-checking">Checking with the server…</p>}
          <button type="button" className="btn mt-3 w-full justify-center" disabled aria-disabled="true" data-testid="free-reroll-open-disabled">
            <RerollIcon size={18} />
            <span>Reroll hero</span>
          </button>
        </div>
      )}

      {status?.state === "BLOCKED" && (
        <p className="mt-3 flex gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm leading-snug text-steel-200" role="status" data-testid="free-reroll-blocked" data-block={status.block ?? ""}>
          <WarningIcon size={16} className="mt-0.5 shrink-0 text-steel-300" />
          <span>{status.message}</span>
        </p>
      )}

      {(status?.state === "DISABLED" || status?.state === "UNAVAILABLE") && (
        <p className="mt-3 text-sm leading-snug text-steel-300" role="status" data-testid="free-reroll-disabled">
          {status.state === "DISABLED" ? "Free rerolls aren't open yet." : (status.message ?? "Free rerolls aren't ready on this server yet.")}
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ pieces of the dialogs
function HeroLine({ card, size }: { card: HeroCardModel; size: number }) {
  return (
    <div className="flex items-center gap-3">
      <HeroArena look={card.look} label={`${card.name}, ${rarityClassLine(card)}`} width={size} className="shrink-0" />
      <div className="min-w-0">
        <p className="truncate font-display text-lg text-paper" title={card.name} data-testid="reroll-current-name">{card.name}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <RarityBadge rarity={card.rarity} size="sm" />
          <span className="font-display text-xs tracking-[0.12em] text-steel-200 uppercase" data-testid="reroll-current-class">{card.className}</span>
        </p>
        <div className="mt-1.5" data-testid="reroll-current-pwr"><PwrValue power={card.power} rarity={card.rarity} size="sm" inline /></div>
      </div>
    </div>
  );
}

const oddsLine = (odds: readonly RerollOddsView[]): string => odds.map((o) => `${o.label} ${o.percent}%`).join(" · ");

// ------------------------------------------------------------------------------------------------ the confirmation (pure view)
export interface RerollConfirmProps {
  current: HeroCardModel;
  odds: readonly RerollOddsView[];
  acknowledged: boolean;
  submitting: boolean;
  error: RerollFlowError | null;
  titleId: string;
  onToggle: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RerollConfirmView({ current, odds, acknowledged, submitting, error, titleId, onToggle, onCancel, onConfirm }: RerollConfirmProps) {
  const ackId = useId();
  const blocked = Boolean(error && !error.retryable);
  return (
    <div data-testid="reroll-confirm">
      <h3 id={titleId} className="font-display text-xl tracking-wide text-clank-300 uppercase">Reroll your hero?</h3>
      <p className="mt-1 text-sm text-steel-200">Your current hero will be replaced with a new random roll.</p>

      <div className="mt-4 rounded-md border border-white/10 bg-white/[0.03] p-3">
        <p className="label mb-2">Current hero</p>
        <HeroLine card={current} size={104} />
      </div>

      <div role="note" className="mt-3 flex gap-2.5 rounded-md border border-ember/50 bg-ember/10 p-3 text-sm leading-snug text-paper" data-testid="reroll-warning">
        <WarningIcon size={20} className="mt-0.5 shrink-0 text-ember" />
        <p>
          <b className="font-display tracking-wide text-ember uppercase">Warning:</b> your new hero could have a <b>lower rarity</b>, <b>lower PWR</b>, a <b>different class</b> and a <b>different appearance</b>.
          Once confirmed, you <b>cannot restore</b> your previous hero with this free reroll.
        </p>
      </div>

      <ul className="mt-3 space-y-1.5 text-[0.76rem] leading-snug text-steel-300" data-testid="reroll-kept">
        <li><b className="text-steel-100">You keep:</b> your Gold, items, achievements, Arena record, Picks, Points and rewards. Fights you already played still show your hero as it was then.</li>
        <li><b className="text-steel-100">Gear</b> made for your old class stays in your inventory but won&apos;t apply to a different class.</li>
        <li><b className="text-steel-100">The odds are the same for everyone:</b> <span data-testid="reroll-odds">{oddsLine(odds)}</span>. Nothing is guaranteed.</li>
      </ul>

      <label htmlFor={ackId} className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-md border border-white/10 bg-white/[0.03] p-3 text-sm leading-snug text-paper has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-clank-300">
        <input id={ackId} type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[#b779f5]" checked={acknowledged} onChange={onToggle} disabled={submitting || blocked} data-testid="reroll-ack" />
        <span>I understand that my new hero could be weaker and that this reroll cannot be undone.</span>
      </label>

      {error && (
        <p role="alert" className={`mt-3 rounded-md border px-3 py-2 text-sm leading-snug ${error.retryable ? "border-ember/40 bg-ember/10 text-paper" : "border-white/15 bg-white/[0.04] text-steel-100"}`} data-testid="reroll-error" data-code={error.code}>
          {error.message}
        </p>
      )}

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn btn-ghost justify-center" onClick={onCancel} disabled={submitting} data-autofocus data-testid="reroll-cancel">{blocked ? "Close" : "Cancel"}</button>
        {!blocked && (
          <button type="button" className="btn justify-center" onClick={onConfirm} disabled={!acknowledged || submitting} aria-busy={submitting} data-testid="reroll-confirm-button">
            {submitting ? (
              <>
                <RerollIcon size={18} className="animate-spin motion-reduce:animate-none" />
                <span>Rerolling…</span>
              </>
            ) : (
              <span className="flex flex-col items-center leading-tight">
                <span>Confirm reroll</span>
                <span className="text-[0.6rem] font-normal tracking-wide normal-case opacity-80">Uses today&apos;s free reroll</span>
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ "we are asking the server what happened"
function CheckingView({ titleId, failed, onCheckAgain }: { titleId: string; failed: boolean; onCheckAgain: () => void }) {
  return (
    <div data-testid="reroll-checking" role="status">
      <h3 id={titleId} className="font-display text-xl tracking-wide text-clank-300 uppercase">Confirming…</h3>
      <p className="mt-2 text-sm leading-snug text-steel-200">
        {failed
          ? "We couldn't reach the server to confirm whether your reroll went through. Your free reroll is safe — it can only be used once. Check again in a moment."
          : "The connection dropped while rerolling. Checking with the server whether it went through…"}
      </p>
      {failed && (
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn justify-center" onClick={onCheckAgain} data-autofocus data-testid="reroll-check-again">Check again</button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the result (pure view)
function ChangeRow({ label, before, after, testId }: { label: string; before: ReactNode; after: ReactNode; testId: string }) {
  return (
    <div className="grid grid-cols-[4.2rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 border-t border-white/10 py-2 first:border-t-0" data-testid={testId}>
      <dt className="label">{label}</dt>
      <dd className="min-w-0 text-steel-300" data-side="old">{before}</dd>
      <dd className="min-w-0 text-paper" data-side="new">{after}</dd>
    </div>
  );
}

export function RerollResultView({ result, titleId, onView }: { result: FreeRerollResultDto; titleId: string; onView: () => void }) {
  const { before, after } = result;
  // Recomputed from the two cards so the words can never disagree with the numbers shown.
  const c = compareRerolled(before, after);
  const verdict = c.verdict === "STRONGER" ? { text: "Stronger", cls: "text-ok" } : c.verdict === "WEAKER" ? { text: "Weaker", cls: "text-[#ff7a86]" } : { text: "Same PWR", cls: "text-steel-200" };
  const sentence =
    c.verdict === "STRONGER" ? `Your new hero is ${c.powerDelta} PWR stronger.`
    : c.verdict === "WEAKER" ? `Your new hero is ${Math.abs(c.powerDelta)} PWR weaker.`
    : "Your new hero has exactly the same PWR.";
  return (
    <div data-testid="reroll-result" data-verdict={c.verdict} style={rarityStyle(after.rarity)}>
      <h3 id={titleId} className="text-center font-display text-xl tracking-wide text-clank-300 uppercase">Your new hero</h3>
      <div className="mx-auto mt-3 flex w-full max-w-[15rem] justify-center">
        <HeroArena look={after.look} label={`${after.name}, ${rarityClassLine(after)}`} width={232} className="max-w-full" />
      </div>
      <p className="mt-3 text-center font-display text-lg tracking-wide text-paper uppercase" data-testid="reroll-new-line">{rarityClassLine(after)}</p>
      <div className="mt-1 flex flex-col items-center gap-2">
        <PwrValue power={after.power} rarity={after.rarity} size="lg" />
        <PwrDelta delta={c.powerDelta} />
        <p className={`font-display text-sm tracking-[0.14em] uppercase ${verdict.cls}`} data-testid="reroll-verdict">{verdict.text}</p>
      </div>
      <p className="mt-1 text-center text-sm text-steel-200" data-testid="reroll-sentence">{sentence}</p>

      <dl className="mt-4 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1 text-sm" aria-label="Old and new hero">
        <div className="grid grid-cols-[4.2rem_minmax(0,1fr)_minmax(0,1fr)] gap-2 py-1.5">
          <span />
          <span className="label">Old</span>
          <span className="label">New</span>
        </div>
        <ChangeRow label="PWR" testId="reroll-row-pwr" before={<span className="font-display tnum">{before.power}</span>} after={<span className="font-display tnum">{after.power}</span>} />
        <ChangeRow label="Rarity" testId="reroll-row-rarity" before={<RarityBadge rarity={before.rarity} size="xs" />} after={<RarityBadge rarity={after.rarity} size="xs" />} />
        <ChangeRow label="Class" testId="reroll-row-class" before={<span className="break-words">{before.className}</span>} after={<span className="break-words">{after.className}</span>} />
      </dl>
      <p className="mt-3 text-center text-[0.72rem] leading-snug text-steel-300">Your old hero stays in your history. Today&apos;s free reroll is used.</p>

      <div className="mt-4 flex justify-center">
        <button type="button" className="btn w-full justify-center sm:w-auto" onClick={onView} data-autofocus data-testid="reroll-view-hero">
          <CheckIcon size={18} />
          <span>View my hero</span>
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the dialog shell
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * A native modal <dialog>: labelled, the page behind is inert, Escape handled by us (never while a request is in flight), scrolls inside the viewport on short
 * screens. Focus: when the dialog opens — and whenever its step changes — the SAFE control (`data-autofocus`: Cancel, or the result's "View my hero") takes focus,
 * and Tab / Shift+Tab wrap inside the dialog instead of leaving it for the browser's own chrome.
 */
function RerollDialog({ labelledBy, step, onEscape, onBackdrop, children }: { labelledBy: string; step: string; onEscape: () => void; onBackdrop: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  useEffect(() => {
    // React's autoFocus runs before the dialog is open (a closed dialog cannot take focus), so the safe control is focused here, after showModal()
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      className="m-auto max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-[30rem] overflow-y-auto overscroll-contain bg-transparent p-0 text-paper backdrop:bg-black/75"
      data-testid="reroll-dialog"
      onCancel={(e) => {
        e.preventDefault(); // we decide: the reducer ignores Escape while a request is in flight
        onEscape();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onClick={(e) => {
        if (e.target === ref.current) onBackdrop();
      }}
    >
      <div className="plate plate-clank p-4 sm:p-5">{children}</div>
    </dialog>
  );
}

// ------------------------------------------------------------------------------------------------ the stateful whole
interface StatusEnvelope {
  status: FreeRerollStatusDto;
}

const newKey = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "00000000-0000-4000-8000-000000000000".replace(/0/g, () => Math.floor(Math.random() * 16).toString(16)));

export function FreeRerollPanel({ onRerolled }: { /** The hero changed on the server: reload whatever shows it. */ onRerolled?: () => void }) {
  const { data, error, loading, reload } = useRemote<StatusEnvelope>(() => api<StatusEnvelope>("/api/me/hero/reroll"), "free-reroll-status");
  const [flow, dispatch] = useReducer(rerollFlowReducer, initialRerollFlow);
  const status = data?.status ?? null;
  const inFlight = useRef(false);
  const titleId = useId();
  const heading = useRef<HTMLDivElement>(null);

  // Back / a sleeping tab / a returning connection: ask the server what is true now.
  useResumeRefetch(reload);

  // The countdown reached zero: the SERVER decides whether a new allowance exists. Ask now and keep asking every 2 s (bounded) until it says so.
  const [elapsedFor, setElapsedFor] = useState<{ endsAt: number; tries: number } | null>(null);
  const waitingForReset = Boolean(elapsedFor && status?.state === "USED" && status.nextResetAt === elapsedFor.endsAt && elapsedFor.tries < 30);
  const onElapsed = useCallback(() => {
    if (!status || status.state !== "USED") return;
    setElapsedFor({ endsAt: status.nextResetAt, tries: 0 });
    reload();
  }, [status, reload]);
  useEffect(() => {
    if (!waitingForReset || loading) return;
    const id = window.setTimeout(() => {
      setElapsedFor((e) => (e ? { ...e, tries: e.tries + 1 } : e));
      reload();
    }, 2000);
    return () => window.clearTimeout(id);
  }, [waitingForReset, loading, reload, elapsedFor?.tries]);

  const open = () => {
    if (status?.state !== "AVAILABLE") return;
    dispatch({ type: "OPEN", requestId: newKey() });
  };

  const check = useCallback(async () => {
    const r = await api<StatusEnvelope>("/api/me/hero/reroll");
    if (r.ok) dispatch({ type: "CHECKED", status: r.data.status });
    else dispatch({ type: "CHECK_FAILED" });
  }, []);

  const confirm = async () => {
    if (inFlight.current || flow.step !== "confirm" || !flow.acknowledged) return; // one submission per confirmation, however fast the clicks come
    inFlight.current = true;
    const requestId = flow.requestId;
    dispatch({ type: "SUBMIT" });
    try {
      const r = await api<{ result: FreeRerollResultDto }>("/api/me/hero/reroll", { method: "POST", json: { requestId }, timeoutMs: 20_000 });
      if (r.ok) {
        dispatch({ type: "SUCCEEDED", result: r.data.result });
        reload(); // the status read below makes the page re-read the hero (see the effect on the hero's state key)
      } else if (isUncertain(r.error, r.status)) {
        dispatch({ type: "UNCERTAIN" });
        await check();
      } else {
        const retryable = isRetryable(r.error);
        dispatch({ type: "REFUSED", error: { code: r.error, message: friendly(r.error), retryable } });
        if (!retryable) reload(); // the panel behind should tell the truth too
      }
    } finally {
      inFlight.current = false;
    }
  };

  const checkAgain = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await check();
    } finally {
      inFlight.current = false;
    }
  };

  const closeResult = () => {
    dispatch({ type: "DISMISS_RESULT" });
    window.setTimeout(() => heading.current?.querySelector<HTMLElement>("h2")?.focus(), 0);
  };
  // A result found by asking the server afterwards (an uncertain answer that DID commit) also needs the panel to re-read.
  const lastResultKey = useRef<string | null>(null);
  useEffect(() => {
    if (flow.step === "result" && lastResultKey.current !== flow.result.requestId) {
      lastResultKey.current = flow.result.requestId;
      reload();
    }
  }, [flow, reload]);

  // THE HERO CHANGED UNDER US: whenever two status reads disagree about which hero this is (our own reroll, a reroll in another tab or browser, a tab that
  // slept through one), whatever shows the hero on the page is stale — tell the page to re-read it, so the old class / rarity / PWR is never left looking current.
  const knownHero = useRef<string | null>(null);
  const currentKey = heroStateKey(status?.current);
  useEffect(() => {
    if (currentKey === null) return;
    if (knownHero.current !== null && knownHero.current !== currentKey) onRerolled?.();
    knownHero.current = currentKey;
  }, [currentKey, onRerolled]);

  const cancel = () => dispatch({ type: "CANCEL" });
  const current = status?.current ?? null;

  return (
    <div ref={heading}>
      <FreeRerollCard status={status} loading={loading && !status} failed={!status && Boolean(error)} onRetry={reload} onReroll={open} onElapsed={onElapsed} checking={waitingForReset} />
      {flow.step !== "closed" && (
        <RerollDialog
          labelledBy={titleId}
          step={flow.step}
          onEscape={() => (flow.step === "result" ? closeResult() : cancel())}
          onBackdrop={cancel}
        >
          {flow.step === "result" ? (
            <RerollResultView result={flow.result} titleId={titleId} onView={closeResult} />
          ) : flow.step === "checking" ? (
            <CheckingView titleId={titleId} failed={flow.failedCheck} onCheckAgain={() => void checkAgain()} />
          ) : current ? (
            <RerollConfirmView
              current={current}
              odds={status?.odds ?? []}
              acknowledged={flow.step === "confirm" && flow.acknowledged}
              submitting={flow.step === "submitting"}
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

export type { RerollFlow };
