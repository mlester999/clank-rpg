"use client";

import Link from "next/link";
import { memo, useMemo } from "react";

import { HeroAvatar } from "@/components/hero/HeroAvatar";
import { lookFor } from "@/components/hero/look";
import { PwrValue, RarityBadge } from "@/components/hero/rarity";
import type { Rarity } from "@/domain/character/appearance";
import { CheckIcon, LockIcon } from "@/components/ui/Icons";
import type { ArenaStateDto, ClassVisual, FighterDto, UpcomingBattleDto, UpcomingFighterDto } from "@/lib/dto";

import { pickCopy, secondsUntilLock, windowDisplay, type WindowDisplay } from "./picksView";
import type { StageMode } from "./stageMode";
import { pickMessage, type BattlePick, type PicksApi } from "./usePicks";

interface Props {
  state: ArenaStateDto | null;
  /** The UPCOMING battle — the only thing this panel lists and the only battle a Pick can name. Null until it is prepared. */
  upcoming: UpcomingBattleDto | null;
  /** The synced SERVER clock (ms). Used for the countdown and to close the panel no later than the server does. */
  now: number;
  picks: PicksApi;
  /** The battle on stage, and where it is: used ONLY to say how the member's earlier Pick on it is going — never to list its fighters. */
  onStage: { fighters: FighterDto[]; decided: boolean } | null;
  loaded: boolean;
  /** What the stage is showing: while the Arena is not running (not started, preparing, paused, development, offline) there is nothing to pick on. */
  mode?: StageMode;
}

/** The panel's calm line while there is no battle to pick on — never an empty 8-slot skeleton that looks broken. */
const IDLE_NOTE: Partial<Record<StageMode, { chip: string; text: string }>> = {
  NOT_STARTED: { chip: "Opens with the Arena", text: "Picks open as soon as the first battle is announced." },
  DEVELOPMENT_IDLE: { chip: "Not running", text: "No test battles are running right now." },
  PREPARING: { chip: "Preparing first fight", text: "The first roster is being made ready. Picks open as soon as it is announced." },
  PAUSED: { chip: "Arena paused", text: "Picks are paused with the Arena and open again when battles resume." },
  RECONNECTING: { chip: "Offline", text: "Waiting to reach the Arena…" },
  NO_SEASON: { chip: "Between seasons", text: "Picks open again when the next season starts." },
};

/**
 * ARENA PICKS — the right-hand panel: the EIGHT heroes of the NEXT fight, each with a PICK action, while the current fight is
 * watched on the stage. The panel never lists the fighters on stage.
 *
 *     fight A on stage ─ picks for B OPEN ─ A is decided ─ picks for B LOCKED ─ A's results ─ 3·2·1 ─ B on stage, picks for C OPEN
 *
 * Picks are FREE: nothing to pay in or lose, no wallet. The SERVER decides whether the window is open (the arena stamps the
 * lock the moment the fight on stage is decided) — this panel only displays that verdict, and never shows a window open after
 * the server closed it. The crowd appears only once the window is closed.
 */
export function ArenaPicks({ state, upcoming, now, picks, onStage, loaded, mode }: Props) {
  const enabled = Boolean(state?.picks.enabled);
  const idle = mode && !upcoming ? (IDLE_NOTE[mode] ?? null) : null;
  const display: WindowDisplay | null = windowDisplay(upcoming, now);
  const open = enabled && display === "OPEN";
  const locked = enabled && display === "LOCKED";
  const seconds = secondsUntilLock(upcoming, now);
  const copy = pickCopy(state?.picks.reward);
  const crowd = locked ? (picks.round?.distribution ?? null) : null; // the server releases it only after the window closed
  const slots = useMemo(() => Array.from({ length: state?.groupSize ?? 8 }, (_, i) => upcoming?.fighters[i] ?? null), [upcoming, state?.groupSize]);
  const ineligible = enabled && picks.signedIn === true && picks.eligibility !== null && !picks.eligibility.eligible;
  const canPick = open && picks.signedIn === true && !ineligible;
  const myPick = picks.pick && upcoming && picks.pick.battleId === upcoming.id ? picks.pick : null;
  const myPickFighter = myPick ? upcoming?.fighters.find((f) => f.characterId === myPick.characterId) : undefined;

  const statusChip = !enabled
    ? { text: "Picks off", cls: "" }
    : idle
      ? { text: idle.chip, cls: "" }
      : !upcoming
      ? { text: "Preparing next fight", cls: "" }
      : open
        ? { text: seconds !== null ? `Picks open · ${seconds}s` : "Picks open", cls: "border-teal/40 bg-teal/10 text-teal" }
        : { text: "Picks locked", cls: "border-clank-400/40 bg-clank-500/10 text-clank-300" };

  return (
    <section
      className="plate plate-clank flex min-w-0 flex-col"
      aria-labelledby="arena-picks"
      style={{ ["--chamfer" as string]: "12px" }}
      data-testid="arena-picks"
      data-battle={upcoming?.id}
      data-window={display ?? undefined}
    >
      <header className="px-3 pt-3 pb-2 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="arena-picks" className="font-display text-sm tracking-wider text-paper uppercase">
              Arena Picks
            </h2>
            <p className="mt-0.5 font-display text-[0.62rem] tracking-[0.2em] text-clank-300 uppercase" data-testid="picks-subtitle">
              Pick the next winner
            </p>
          </div>
          <span className={`chip tnum ${statusChip.cls}`} aria-live="polite" data-testid="picks-status">
            {open && <span className="live-dot" />}
            {locked && <LockIcon size={11} />}
            {statusChip.text}
          </span>
        </div>

        {enabled && (
          <div className="mt-2 rounded-md border border-clank-400/25 bg-clank-500/[0.06] px-2.5 py-2" data-testid="picks-copy">
            <p className="text-[0.76rem] leading-snug text-paper">{copy.lead}</p>
            <p className="mt-1 text-[0.7rem] leading-snug text-steel-300">{copy.scoring}</p>
            {copy.prize && (
              <p className="mt-1 text-[0.68rem] leading-snug text-clank-200 tnum" data-testid="picks-prize">
                {copy.prize}
              </p>
            )}
            <p className="mt-1 text-[0.66rem] leading-snug text-steel-400">{copy.free}</p>
          </div>
        )}

        {locked && upcoming && (
          <div className="mt-2 rounded-md border border-clank-400/35 bg-clank-500/[0.08] px-2.5 py-2" role="status" data-testid="picks-locked-note">
            {myPick && myPickFighter ? (
              <>
                <p className="label !text-[0.58rem]">Your pick</p>
                <p className="flex items-center gap-1.5 font-display text-[0.95rem] leading-tight text-paper" data-testid="locked-pick-name">
                  <LockIcon size={12} /> {myPickFighter.name}
                </p>
                <p className="mt-0.5 text-[0.7rem] text-steel-300">Locked for the next fight.</p>
              </>
            ) : (
              <p className="text-[0.72rem] leading-snug text-steel-300">Picks for the next fight are locked. They open again for the fight after it.</p>
            )}
          </div>
        )}

        {enabled && picks.signedIn === false && upcoming && (
          <p className="mt-2 rounded-md border border-clank-500/30 bg-clank-500/10 px-2.5 py-1.5 text-[0.72rem] text-clank-200" data-testid="picks-signin">
            <Link href="/character" className="font-bold underline underline-offset-2 hover:text-paper">
              Sign in with Telegram
            </Link>{" "}
            to make your Pick.
          </p>
        )}
        {ineligible && upcoming && (
          <p className="mt-2 rounded-md border border-white/15 bg-white/[0.04] px-2.5 py-1.5 text-[0.72rem] leading-snug text-steel-300" data-testid="picks-ineligible">
            {picks.eligibility?.explanation}
          </p>
        )}
        {picks.error && picks.error !== "UNAUTHENTICATED" && (
          <p role="alert" className="mt-2 flex items-start justify-between gap-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[0.72rem] text-danger">
            <span>{picks.error === "NOT_ELIGIBLE" && picks.errorDetail ? picks.errorDetail : pickMessage(picks.error)}</span>
            <button type="button" onClick={picks.clearError} className="font-bold underline" aria-label="Dismiss">
              ✕
            </button>
          </p>
        )}
      </header>

      {idle && (
        <p className="mx-3 mb-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-3 text-center text-[0.78rem] leading-snug text-steel-300" data-testid="picks-idle">
          {idle.text}
        </p>
      )}
      {!idle && (
        <ol className="flex flex-col gap-1.5 px-2 pb-2 sm:px-3" aria-label="Heroes fighting in the next battle">
          {slots.map((f, i) =>
            f ? (
              <PickRow
                key={f.characterId}
                f={f}
                visual={state?.classes[f.classId]}
                disabled={state?.visuals.disabledCosmetics}
                selected={myPick?.characterId === f.characterId}
                pending={picks.pendingCharacterId === f.characterId}
                open={open}
                canPick={canPick}
                enabled={enabled}
                crowd={crowd ? (crowd.byCharacter[f.characterId] ?? 0) : null}
                signedIn={picks.signedIn}
                onPick={picks.submit}
              />
            ) : (
              <li key={`empty-${i}`} className="skeleton h-[4rem]" aria-hidden={loaded ? undefined : true} />
            ),
          )}
        </ol>
      )}

      {enabled && picks.current.pick && onStage && <OnStagePick current={picks.current} onStage={onStage} />}

      <footer className="mt-auto flex items-center justify-between gap-2 border-t border-white/5 px-3 py-2 text-[0.68rem] text-steel-400 sm:px-4">
        <span className="inline-flex items-center gap-1.5">
          <LockIcon size={12} /> Free Picks · nothing to lose
        </span>
        {crowd && crowd.total > 0 && (
          <span className="tnum" data-testid="crowd-total">
            {crowd.total} Pick{crowd.total === 1 ? "" : "s"} on the next fight
          </span>
        )}
      </footer>
    </section>
  );
}

/**
 * What became of the member's EARLIER Pick — the one they made while the fight now on stage was the upcoming one. It names one
 * hero (their own choice), never lists the fighters on stage. Nothing was risked, so a miss is "not this time", never "you lost".
 */
function OnStagePick({ current, onStage }: { current: BattlePick; onStage: NonNullable<Props["onStage"]> }) {
  const pick = current.pick as NonNullable<BattlePick["pick"]>;
  const picked = onStage.fighters.find((f) => f.characterId === pick.characterId);
  const outcome = current.round?.outcome ?? null;
  const winner = outcome?.winnerCharacterId ? onStage.fighters.find((f) => f.characterId === outcome.winnerCharacterId) : undefined;
  const box = "mx-2 mb-2 rounded-lg border px-3 py-2.5 sm:mx-3";

  if (!onStage.decided) {
    return (
      <div className={`${box} border-white/10 bg-white/[0.03]`} role="status" data-testid="onstage-pick" data-state="fighting">
        <p className="label !text-[0.58rem]">Your pick · fighting now</p>
        <p className="flex items-center gap-1.5 font-display text-[0.9rem] text-paper">
          <LockIcon size={12} /> {picked?.name ?? "Your hero"}
        </p>
      </div>
    );
  }
  if (!outcome || outcome.pending) {
    return (
      <div className={`${box} border-white/10 bg-white/[0.03]`} role="status" data-testid="onstage-pick" data-state="settling">
        <p className="label !text-[0.58rem]">Your pick</p>
        <p className="font-display text-[0.9rem] text-paper">{picked?.name ?? "Your hero"}</p>
        <p className="mt-0.5 text-[0.72rem] text-steel-300">Settling your pick…</p>
      </div>
    );
  }
  if (outcome.result === "VOID") {
    return (
      <div className={`${box} border-white/10 bg-white/[0.03]`} role="status" data-testid="onstage-pick" data-state="void">
        <p className="text-[0.74rem] text-steel-300">That fight was cancelled — your pick doesn&apos;t count. Pick again on the next one.</p>
      </div>
    );
  }
  if (outcome.result === "CORRECT") {
    return (
      <div className={`${box} border-teal/45 bg-teal/10`} role="status" data-testid="onstage-pick" data-state="correct">
        <p className="flex items-center gap-1.5 font-display text-[0.8rem] tracking-wider text-teal uppercase">
          <CheckIcon size={14} /> Correct
        </p>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.74rem]">
          <dt className="text-steel-400">Your pick</dt>
          <dd className="text-paper">{picked?.name ?? "—"}</dd>
          <dt className="text-steel-400">Winner</dt>
          <dd className="text-paper">{winner?.name ?? picked?.name ?? "—"}</dd>
        </dl>
        <p className="mt-1.5 font-display text-base text-teal tnum" data-testid="pick-points">
          +{outcome.points} <span className="text-[0.7rem]">Points</span>
        </p>
      </div>
    );
  }
  return (
    <div className={`${box} border-white/10 bg-white/[0.03]`} role="status" data-testid="onstage-pick" data-state="incorrect">
      <p className="font-display text-[0.8rem] tracking-wider text-paper uppercase">Not this time</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.74rem]">
        <dt className="text-steel-400">Your pick</dt>
        <dd className="text-paper">{picked?.name ?? "—"}</dd>
        <dt className="text-steel-400">Winner</dt>
        <dd className="text-paper">{winner?.name ?? "—"}</dd>
      </dl>
      <p className="mt-1.5 text-[0.7rem] text-steel-300">+0 Points. Pick again on the next fight.</p>
    </div>
  );
}

interface RowProps {
  f: UpcomingFighterDto;
  visual: ClassVisual | undefined;
  disabled: string[] | undefined;
  selected: boolean;
  pending: boolean;
  open: boolean;
  canPick: boolean;
  enabled: boolean;
  /** Picks on this fighter — null until the server releases the crowd (after the window closed). */
  crowd: number | null;
  signedIn: boolean | null;
  onPick: (characterId: string) => Promise<void>;
}

const PickRow = memo(function PickRow({ f, visual, disabled, selected, pending, open, canPick, enabled, crowd, signedIn, onPick }: RowProps) {
  const look = lookFor(f.appearance, visual, disabled);
  const accent = visual?.colors[0] ?? "#8b97ab";
  const rarity = f.appearance.rarity as Rarity;
  return (
    <li
      className={`flex items-center gap-2 rounded-lg p-1.5 pr-2 ring-1 transition-colors ${selected ? "bg-clank-500/12 ring-clank-400/70" : "bg-white/[0.025] ring-white/[0.06]"}`}
      data-picked={selected || undefined}
      data-character={f.characterId}
    >
      <Link href={`/heroes/${f.publicId}`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md hover:brightness-125" aria-label={`${f.name}, ${rarity.toLowerCase()} ${visual?.name ?? "hero"}${f.power !== null ? `, PWR ${f.power.toLocaleString()}` : ""}`}>
        <HeroAvatar avatarUrl={f.avatarUrl} look={look} size={48} label={f.name} className="rounded-md" eager />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.82rem] leading-tight font-bold text-paper" title={f.name}>{f.name}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[0.7rem] leading-tight">
            <RarityBadge rarity={rarity} size="xs" />
            <span className="truncate font-semibold" style={{ color: accent }}>{visual?.name ?? "Hero"}</span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-baseline gap-2 leading-none">
            {f.power !== null ? <PwrValue power={f.power} rarity={rarity} size="sm" inline /> : null}
            {crowd !== null && crowd > 0 && <span className="truncate text-[0.66rem] text-steel-400 tnum" data-testid="crowd">· {crowd} Pick{crowd === 1 ? "" : "s"}</span>}
          </span>
        </span>
      </Link>
      <PickAction enabled={enabled} open={open} canPick={canPick} selected={selected} pending={pending} signedIn={signedIn} onPick={() => void onPick(f.characterId)} name={f.name} />
    </li>
  );
});

function PickAction({ enabled, open, canPick, selected, pending, signedIn, onPick, name }: {
  enabled: boolean; open: boolean; canPick: boolean; selected: boolean; pending: boolean; signedIn: boolean | null; onPick: () => void; name: string;
}) {
  const base = "inline-flex min-w-[4.9rem] items-center justify-center gap-1 whitespace-nowrap";
  if (!enabled) return null;

  if (open) {
    if (selected)
      return (
        <button type="button" onClick={onPick} aria-pressed="true" aria-label={`${name} is your pick`} className={`btn btn-teal btn-sm ${base}`} disabled={pending}>
          <CheckIcon size={13} /> Your pick
        </button>
      );
    return (
      <button
        type="button"
        onClick={onPick}
        className={`btn btn-sm ${base}`}
        disabled={pending || !canPick}
        aria-label={`Pick ${name} to win`}
        title={signedIn === false ? "Sign in with Telegram to pick" : !canPick ? "Your account can't make rewarded Picks yet" : `Pick ${name} to win the next fight`}
      >
        {pending ? "…" : "Pick"}
      </button>
    );
  }

  // Locked: the chosen fighter stays highlighted; nobody else can be chosen.
  if (selected)
    return (
      <span className={`${base} chip border-clank-400/60 bg-clank-500/15 text-clank-300`} aria-label={`${name} is your locked pick`}>
        <LockIcon size={11} /> Your pick
      </span>
    );
  return null;
}
