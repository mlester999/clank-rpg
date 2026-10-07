"use client";

import Link from "next/link";
import { useState } from "react";

import { explorerTxLink, useTokenConfig, type OfficialToken } from "@/components/leaderboard/useTokenConfig";

import { ClaimModal } from "./ClaimModal";
import { HolderBonusCard } from "./HolderBonusCard";
import { useRewards, type ClaimInfo, type PeriodStatsInfo, type RewardsPayload, type RewardsSummary } from "./useRewards";

const CLAIM_NOTES: Record<NonNullable<RewardsSummary["claimsNote"]>, (r: RewardsSummary) => string> = {
  NOT_LAUNCHED: () => "CLAIMS WILL OPEN AFTER $CLANKRPG LAUNCH. Your rewards are safe and stay claimable — nothing is lost or denied.",
  UNAVAILABLE: () => "Claims are temporarily unavailable. Your rewards are safe and will continue accumulating.",
  HELD: () => "Claims on your account are on hold for now. Your rewards are safe and will keep accumulating.",
  BELOW_MINIMUM: (r) => (r.belowMinimum ? `Minimum claim: ${r.minimumClaim} ${r.symbol}. Your rewards keep accumulating — nothing is lost.` : "Leaderboard prizes show up here once a Daily or Weekly board you placed on has ended."),
  NOT_ELIGIBLE: () => "This account can't claim rewards right now. Your rewards are safe.",
  PENDING: () => "Your claim is waiting for a manual payout. The reserved amount can't be claimed again.",
};

/** Player-facing claim states: PENDING (reserved, waiting for a manual payout), SENT (paid), DENIED (refused; the reward is claimable again). */
const CLAIM_BADGE: Record<ClaimInfo["status"], { label: string; cls: string }> = {
  PENDING: { label: "Pending", cls: "border-clank-400/50 bg-clank-500/15 text-clank-200" },
  SENT: { label: "Sent", cls: "border-teal/50 bg-teal/15 text-teal" },
  DENIED: { label: "Denied", cls: "border-danger/50 bg-danger/10 text-danger" },
};

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * The member's own ARENA PICKS + ARENA REWARDS (the Profile tab). Everything is display of what the server computed; the
 * only action is "claim" (a request for a MANUAL payout), and it never lets the browser name an amount.
 */
export function ArenaPicksPanel() {
  const { data, error, loading, reload } = useRewards();
  const [modal, setModal] = useState<null | "claim">(null);
  const token = useTokenConfig();
  const [note, setNote] = useState<string | null>(null);

  if (loading) return <section className="plate p-5"><p className="text-sm text-steel-300">Loading your Arena Picks…</p></section>;
  if (error || !data) {
    return (
      <section className="plate p-5">
        <h2 className="font-display text-lg text-paper">Arena Picks</h2>
        <p className="mt-2 text-sm text-steel-300">{error === "UNAVAILABLE" ? "Arena Picks rewards aren't available yet." : "Couldn't load your Arena Picks. Try again in a moment."}</p>
      </section>
    );
  }
  const { rewards } = data;
  const done = (m: string) => {
    setModal(null);
    setNote(m);
    void reload();
  };
  return (
    <>
      <ArenaPicksView data={data} note={note} onClaim={() => setModal("claim")} onTierChanged={() => void reload()} token={token} />
      {modal === "claim" && <ClaimModal rewards={rewards} onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}

/** The pure view of the member's Arena Picks + rewards (everything the server computed; actions are callbacks). */
export function ArenaPicksView({ data, note, onClaim, onTierChanged, token = null }: { data: RewardsPayload; note: string | null; onClaim: () => void; onTierChanged?: () => void; token?: OfficialToken | null }) {
  const { rewards, stats, history } = data;
  const pending = rewards.pendingClaim;

  return (
    <div className="space-y-4" data-testid="arena-picks-panel">
      {note && <p role="status" className="rounded-md border border-teal/40 bg-teal/10 px-3 py-2 text-sm text-teal">{note}</p>}

      <section className="plate p-4 sm:p-5" aria-labelledby="ap-stats">
        <h2 id="ap-stats" className="font-display text-lg text-paper">Arena Picks</h2>
        <p className="mt-1 text-xs text-steel-400">Free and unlimited: pick who wins each battle. A wrong pick costs nothing, and nothing is paid per battle — correct picks earn Points toward the Daily and Weekly leaderboards.</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-5">
          <Stat label="Accuracy" value={stats.accuracy === null ? "–" : `${stats.accuracy}%`} testId="stat-accuracy" />
          <Stat label="Correct picks" value={String(stats.correctPicks)} testId="stat-correct" />
          <Stat label="Total picks" value={String(stats.totalPicks)} testId="stat-total" />
          <Stat label="Current streak" value={String(stats.currentStreak)} testId="stat-streak" />
          <Stat label="Best streak" value={String(stats.bestStreak)} testId="stat-best" />
        </dl>
        {!rewards.eligibility.eligible && <p className="mt-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-steel-300">{rewards.eligibility.explanation}</p>}
      </section>

      <section className="plate p-4 sm:p-5" aria-labelledby="ap-points">
        <h2 id="ap-points" className="font-display text-lg text-paper">Leaderboard stats</h2>
        <p className="mt-1 text-xs text-steel-400">Every valid Pick counts. A correct Pick earns {rewards.boards.daily.pointsPerCorrectPick} Points — off-chain, not tradeable, the same for everyone. The Daily and Weekly leaderboards are a race for the most correct Picks.</p>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <PeriodStats title="Daily" stats={rewards.periodStats.daily} testId="daily" />
          <PeriodStats title="Weekly" stats={rewards.periodStats.weekly} testId="weekly" />
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="min-w-0 rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/10">
            <dt className="label">Lifetime Clank Points</dt>
            <dd className="font-display text-xl text-paper tnum" data-testid="points-lifetime">{rewards.points.lifetime.toLocaleString()}</dd>
          </div>
        </dl>
        <p className="mt-2 text-[0.66rem] text-steel-400">The Daily board ends 00:00 UTC; the Weekly board Monday 00:00 UTC. <a href="/leaderboard" className="underline underline-offset-2 hover:text-paper">Arena Picks leaderboards</a></p>
      </section>

      <HolderBonusCard holder={rewards.holder} onChanged={() => onTierChanged?.()} token={token} />

      <section className="plate p-4 sm:p-5" aria-labelledby="ap-rewards">
        <h2 id="ap-rewards" className="font-display text-lg text-paper">Arena Rewards</h2>
        <dl className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Amount label="Claimable" value={rewards.claimable} symbol={rewards.symbol} accent testId="rewards-claimable" />
          <Amount label="Pending" value={rewards.pending} symbol={rewards.symbol} testId="rewards-pending" />
          <Amount label="Sent" value={rewards.claimed} symbol={rewards.symbol} testId="rewards-claimed" />
          <Amount label="Total earned" value={rewards.totalEarned} symbol={rewards.symbol} testId="rewards-total" />
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn" onClick={onClaim} disabled={!rewards.claimsAvailable} data-testid="claim-open">
            Claim rewards
          </button>
          {rewards.claimsNote && <p className="min-w-0 flex-1 text-xs text-steel-300" data-testid="claim-note">{CLAIM_NOTES[rewards.claimsNote](rewards)}</p>}
        </div>

        {pending && (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-clank-200" data-testid="claim-state" data-status={pending.status}>
            <span className={`chip ${CLAIM_BADGE.PENDING.cls}`}>Pending</span>
            <span className="tnum">{pending.amount} {rewards.symbol}</span>
            <span className="text-steel-400">→ <span className="font-mono text-xs">{pending.destination}</span> · {pending.destinationKind === "HOLDER_WALLET" ? "connected wallet" : "another wallet"}</span>
          </p>
        )}
      </section>

      <section className="plate p-4 sm:p-5" aria-labelledby="ap-latest">
        <h2 id="ap-latest" className="font-display text-lg text-paper">Latest rewards</h2>
        {rewards.latestRewards.length === 0 ? (
          <p className="mt-2 text-sm text-steel-300">Place in the Top {rewards.boards.daily.topRewarded} of a Daily or Weekly Arena Picks board and your prize shows up here.</p>
        ) : (
          <ul className="mt-3 divide-y divide-white/5" data-testid="latest-rewards">
            {rewards.latestRewards.map((r, i) => (
              <li key={`${r.at}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2" data-kind={r.kind}>
                <span className="min-w-0 text-sm text-paper"><span className="font-display tracking-wider uppercase">{r.label}</span>{r.period && <span className="ml-2 text-xs text-steel-400">{r.board === "Weekly" ? `week of ${r.period}` : r.period}</span>}</span>
                <span className="font-display text-sm text-teal tnum">+{r.amount} {rewards.symbol}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="plate p-4 sm:p-5" aria-labelledby="ap-claims">
        <h2 id="ap-claims" className="font-display text-lg text-paper">Claim history</h2>
        {rewards.claimHistory.length === 0 ? (
          <p className="mt-2 text-sm text-steel-300">No claims yet. When you claim, the request and its payout show up here.</p>
        ) : (
          <ul className="mt-3 space-y-2" data-testid="claim-history">
            {rewards.claimHistory.map((c) => {
              const badge = CLAIM_BADGE[c.status];
              const link = explorerTxLink(token, c.txHash);
              return (
                <li key={c.id} className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2" data-status={c.status}>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="font-display text-sm text-paper tnum">{c.amount} {rewards.symbol}</span>
                    <span className={`chip ${badge.cls}`} data-testid="claim-badge">{badge.label}</span>
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-steel-400">
                    <span>{day(c.requestedAt)}</span>
                    <span className="font-mono" title="Destination wallet">{c.destination}</span>
                    {c.status === "SENT" && c.txShort && <span className="font-mono text-steel-300" title={c.txHash ?? undefined}>{c.txShort}</span>}
                    {c.status === "SENT" && link && <a href={link} target="_blank" rel="noopener noreferrer" className="font-bold text-clank-300 underline underline-offset-2">View tx</a>}
                  </p>
                  {c.status === "DENIED" && c.denial && (
                    <p className="mt-1 text-xs text-steel-300" data-testid="claim-denial">
                      Reason: <b className="text-paper">{c.denial.label}</b> — {c.denial.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="plate p-4 sm:p-5" aria-labelledby="ap-history">
        <h2 id="ap-history" className="font-display text-lg text-paper">Recent picks</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-steel-300">No picks yet. Pick who wins the next fight in the arena — it&apos;s free.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-sm" data-testid="pick-history">
              <thead>
                <tr className="text-[0.66rem] tracking-wider text-steel-400 uppercase">
                  <th className="py-1.5 pr-3 font-semibold">When</th>
                  <th className="py-1.5 pr-3 font-semibold">Your pick</th>
                  <th className="py-1.5 pr-3 font-semibold">Winner</th>
                  <th className="py-1.5 pr-3 font-semibold">Result</th>
                  <th className="py-1.5 text-right font-semibold">Points</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.battleId} className="border-t border-white/5" data-state={h.result === null ? (h.phase ?? "UPCOMING").toLowerCase() : h.result.toLowerCase()}>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-steel-400 tnum">{when(h.at)}</td>
                    <td className="py-1.5 pr-3 text-paper"><Link href={`/heroes/${h.picked.publicId}`} className="hover:text-clank-200 hover:underline" data-testid="history-hero-link">{h.picked.name}</Link></td>
                    <td className="py-1.5 pr-3 text-paper">{h.winner ? (h.winner.publicId ? <Link href={`/heroes/${h.winner.publicId}`} className="hover:text-clank-200 hover:underline" data-testid="history-hero-link">{h.winner.name}</Link> : h.winner.name) : "—"}</td>
                    <td className="py-1.5 pr-3">
                      {h.result === null ? (
                        <span className="chip border-clank-400/50 bg-clank-500/15 text-clank-200">{h.phase === "FIGHTING" ? "Fighting now" : "Upcoming pick"}</span>
                      ) : h.result === "CORRECT" ? (
                        <span className="chip border-teal/50 bg-teal/15 text-teal">Correct</span>
                      ) : h.result === "INCORRECT" ? (
                        <span className="chip">Wrong</span>
                      ) : (
                        <span className="chip">Void</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right tnum" data-testid="history-points">
                      {h.result === null ? <span className="text-steel-400">–</span> : h.result === "CORRECT" ? <span className="text-teal">+{h.points}</span> : <span className="text-steel-400">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0">
      <dt className="label">{label}</dt>
      <dd className="font-display text-xl text-paper tnum" data-testid={testId}>{value}</dd>
    </div>
  );
}

function Amount({ label, value, symbol, accent = false, testId }: { label: string; value: string; symbol: string; accent?: boolean; testId: string }) {
  return (
    <div className={`min-w-0 rounded-lg p-3 ring-1 ${accent ? "bg-clank-500/10 ring-clank-400/40" : "bg-white/[0.03] ring-white/10"}`}>
      <dt className="label">{label}</dt>
      <dd className={`mt-0.5 font-display text-lg break-words tnum ${accent ? "text-clank-200" : "text-paper"}`} data-testid={testId}>
        {value} <span className="text-xs text-clank-300">{symbol}</span>
      </dd>
    </div>
  );
}

/** One period's own stats: Picks · Correct · Accuracy · Points · Current rank (and the prize-eligibility note while below the minimum). */
function PeriodStats({ title, stats, testId }: { title: string; stats: PeriodStatsInfo; testId: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-clank-500/10 p-3 ring-1 ring-clank-400/40" data-testid={`period-stats-${testId}`}>
      <h3 className="font-display text-xs tracking-wider text-clank-200 uppercase">{title}</h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3">
        <PStat label="Picks" value={stats.picks.toLocaleString()} testId={`${testId}-picks`} />
        <PStat label="Correct" value={stats.correct.toLocaleString()} testId={`${testId}-correct`} />
        <PStat label="Accuracy" value={stats.accuracy === null ? "–" : `${stats.accuracy.toFixed(1)}%`} testId={`${testId}-accuracy`} />
        <PStat label="Points" value={stats.points.toLocaleString()} testId={`${testId}-points`} />
        <PStat label="Current rank" value={stats.rank === null ? "–" : `#${stats.rank}`} testId={`${testId}-rank`} />
      </dl>
      {!stats.prizeEligible && (
        <p className="mt-2 text-[0.68rem] leading-snug text-steel-300" data-testid={`${testId}-eligibility`}>
          Not yet prize eligible — {stats.picksToEligible} more Pick{stats.picksToEligible === 1 ? "" : "s"} needed ({stats.minimumPicks} this {title === "Daily" ? "day" : "week"}).
        </p>
      )}
    </div>
  );
}

function PStat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0">
      <dt className="label">{label}</dt>
      <dd className="font-display text-xl text-paper tnum" data-testid={testId}>{value}</dd>
    </div>
  );
}
