"use client";

import { useState } from "react";

import { api } from "@/lib/api";

import { act, Card, fmtDate, Note, Table, useAdminData, type Row } from "./adminUi";
import { Stat } from "./ArenaOpsPanel";
import { ClaimsQueue } from "./ArenaPicksClaims";
import { HoldersAdmin, TokenStatus } from "./ArenaPicksHolders";
import { BoardsAdmin } from "./ArenaPicksBoards";

/**
* ARENA PICKS — admin only. The leaderboard economy and what it can cost at most, the Daily / Weekly boards, holder qualification, reserve health, claims, the review queue and anti-farming observability. Shows
 * internal state (Telegram ids, wallets, why claims are held) that players never see. The only writes are audited actions.
 */
const TABS = [["overview", "Overview"], ["claims", "Claims"], ["boards", "Daily & Weekly"], ["holders", "Holders & token"], ["battles", "Recent battles"], ["review", "Review"], ["accounts", "Accounts"], ["reconciliation", "Reconciliation"]] as const;
type Tab = (typeof TABS)[number][0];

const short = (v: unknown) => (typeof v === "string" && v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-4)}` : String(v ?? "–"));

export function ArenaPicksAdmin() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div>
      <p className="mb-3 rounded-md border border-violet/30 bg-violet/10 px-3 py-2 text-sm text-violet">
        Arena Picks are FREE and unlimited: no deposits, wagers or betting balances exist, and NO token is paid per battle. The only money here is the $CLANKRPG reward ledger — Daily and Weekly leaderboard prizes (base) plus holder bonuses, kept apart — and every write below is audited.
      </p>
      <nav className="mb-4 flex flex-wrap gap-1" aria-label="Arena Picks sections">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${tab === id ? "bg-clank-500 text-ink-900" : "text-steel-300 hover:bg-white/5"}`}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "overview" && <Overview />}
      {tab === "battles" && <Battles />}
      {tab === "claims" && <ClaimsQueue />}
      {tab === "boards" && <BoardsAdmin />}
      {tab === "holders" && <HoldersAdmin />}
      {tab === "review" && <Review />}
      {tab === "accounts" && <Accounts />}
      {tab === "reconciliation" && <Reconciliation />}
    </div>
  );
}

interface BoardRules { prizePool: string; topRewarded: number; minimumPicks: number; symbol: string; prizes: Array<{ position: number; share: string; amount: string }> }
interface BoardEconomy { basePool: string; maxBonusExposure: string; maxLiability: string }
interface OverviewData {
  overview: {
    prizesEnabled: boolean; minimumClaim: string;
    token: { launched: boolean; available: boolean; reasons: string[]; adapter: string | null; chainId: number | null; address: string | null; treasury: string | null };
    eligibleMembers: number; currentBattle: { id: string; picks: number; distribution: Record<string, number> } | null;
    economy: { maxBonusPercent: number; daily: BoardEconomy; weekly: BoardEconomy; season: { weeks: number; days: number; dailyBaseTotal: string; weeklyBaseTotal: string; baseMaximum: string; maximumWithBonuses: string; allocation: string; buffer: string; fits: boolean } };
    rules: { daily: BoardRules; weekly: BoardRules };
    awarded: { base: string; bonus: string; heldBase: string; pendingBonuses: number };
    outstanding: string; claimableLiability: string; reservedByClaims: string; claimed: string;
    treasuryBalance: string | null; coverageRatio: number | null; pendingClaims: { count: number; amount: string }; heldAccounts: number; warnings: string[]; notices: string[];
    pointsPerCorrectPick: number; minimumPicks: { daily: number; weekly: number }; holderBonusTiers: Array<{ label: string; name: string; minimum: string; bonus: string }>;
    holderQualifyHours: { daily: number; weekly: number }; holderRefreshMinutes: number; holderMaxAgeHours: number; utcReset: string;
    today: { totalPicks: number; correctPicks: number; boardPicks: number; leaderboardPoints: number; lifetimePointsIssued: number; participants: number };
    holderCounts: Array<{ label: string; name: string; users: number }>;
  };
}

function Overview() {
  const { data } = useAdminData<OverviewData>("/api/admin/picks/overview");
  const o = data?.overview;
  if (!o) return <p className="text-sm text-steel-300">Loading…</p>;
  const e = o.economy;
  return (
    <>
      {o.warnings.length > 0 && (
        <ul className="mb-4 space-y-2" aria-label="Warnings">
          {o.warnings.map((w) => <li key={w} className="rounded-md border border-clank-400/40 bg-clank-500/10 px-3 py-2 text-sm text-clank-300">{w}</li>)}
        </ul>
      )}
      <TokenStatus />
      <Card title="Leaderboard economy — the most the rules can pay out">
        <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2" data-testid="admin-economy">
          {([["DAILY", "Daily", e.daily], ["WEEKLY", "Weekly", e.weekly]] as const).map(([key, label, b]) => (
            <section key={key} className="min-w-0 rounded-md border border-white/10 bg-ink-950/60 p-3" data-testid={`economy-${key.toLowerCase()}`}>
              <h4 className="label mb-2">{label}</h4>
              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
                <Stat label="Base prize pool" value={b.basePool} sub="$CLANKRPG, fixed — never rolls over" />
                <Stat label="Max holder bonus exposure" value={b.maxBonusExposure} sub={`+${e.maxBonusPercent}% on every prize, at most`} />
                <Stat label={`Maximum ${label.toLowerCase()} liability`} value={b.maxLiability} sub="base + bonus exposure" />
              </div>
            </section>
          ))}
        </div>
        <p className="mt-2 text-xs text-steel-400">No token is emitted per battle: the worst case is a product of settings. Holder bonuses are extra — they are never taken from another player&apos;s prize.</p>
      </Card>
      <Card title="Season 1 planning (a planning metric — nothing is minted or reserved by it)">
        <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4" data-testid="admin-season">
          <Stat label="Season length" value={`${e.season.weeks} weeks`} sub={`${e.season.days} days`} />
          <Stat label="Daily base total" value={e.season.dailyBaseTotal} sub={`${e.season.days} × ${e.daily.basePool}`} />
          <Stat label="Weekly base total" value={e.season.weeklyBaseTotal} sub={`${e.season.weeks} × ${e.weekly.basePool}`} />
          <Stat label="Season 1 base maximum" value={e.season.baseMaximum} />
          <Stat label={`Maximum with +${e.maxBonusPercent}% bonuses everywhere`} value={e.season.maximumWithBonuses} />
          <Stat label="Reward / dev allocation" value={e.season.allocation} />
          <Stat label="Theoretical buffer" value={e.season.buffer} sub={e.season.fits ? "fits inside the allocation" : "EXCEEDS the allocation"} />
        </div>
      </Card>
      <Card title="Configuration">
        <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Leaderboard prizes" value={o.prizesEnabled ? "ON" : "PAUSED"} />
          <Stat label="Minimum picks (daily / weekly)" value={`${o.minimumPicks.daily} / ${o.minimumPicks.weekly}`} sub={`+${o.pointsPerCorrectPick} per correct · every valid pick counts · no daily cap`} />
          <Stat label="Minimum claim" value={`${o.minimumClaim} $CLANKRPG`} />
          <Stat label="Eligible members" value={o.eligibleMembers.toLocaleString()} />
          <Stat label="Token / holder verification" value={o.token.available ? `ON (${o.token.adapter})` : o.token.launched ? "OFF" : "NOT LAUNCHED"} sub={o.token.available ? `chain ${o.token.chainId}` : o.token.launched ? o.token.reasons.join("; ") : "bonuses 0% · claims open after launch"} />
          <Stat label="Payouts" value="MANUAL" sub={`${o.pendingClaims.count} pending · ${o.pendingClaims.amount} $CLANKRPG`} />
          <Stat label="Official contract" value={o.token.launched ? short(o.token.address) : "NOT LAUNCHED"} />
          <Stat label="Reward wallet (read-only)" value={short(o.token.treasury)} />
        </div>
      </Card>
      <Card title="Prize ladder and holder bonus (current settings)">
        <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Daily prize pool" value={`${o.rules.daily.prizePool} $CLANKRPG`} sub={`Top ${o.rules.daily.topRewarded} · min ${o.rules.daily.minimumPicks} picks to be prize eligible`} />
          <Stat label="Weekly prize pool" value={`${o.rules.weekly.prizePool} $CLANKRPG`} sub={`Top ${o.rules.weekly.topRewarded} · min ${o.rules.weekly.minimumPicks} picks to be prize eligible`} />
          <Stat label="Daily bonus qualification" value={`${o.holderQualifyHours.daily} h before + throughout`} sub={`verified ~every ${o.holderRefreshMinutes} min · gap > ${o.holderMaxAgeHours} h breaks it`} />
          <Stat label="Weekly bonus qualification" value={`${o.holderQualifyHours.weekly / 24} days before + throughout`} sub="verified holding continuity" />
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[26rem] text-left text-sm" data-testid="admin-ladder">
            <thead><tr className="text-[0.66rem] tracking-wider text-steel-400 uppercase"><th className="py-1 pr-3">Position</th><th className="py-1 pr-3">Share</th><th className="py-1 pr-3">Daily prize</th><th className="py-1">Weekly prize</th></tr></thead>
            <tbody>
              {o.rules.daily.prizes.map((p, i) => (
                <tr key={p.position} className="border-t border-white/5"><td className="py-1 pr-3 text-paper tnum">#{p.position}</td><td className="py-1 pr-3 tnum">{p.share}</td><td className="py-1 pr-3 tnum">{p.amount}</td><td className="py-1 tnum">{o.rules.weekly.prizes[i]?.amount ?? "–"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[22rem] text-left text-sm" data-testid="admin-tiers">
            <thead><tr className="text-[0.66rem] tracking-wider text-steel-400 uppercase"><th className="py-1 pr-3">Tier</th><th className="py-1 pr-3">Minimum holding</th><th className="py-1 pr-3">Prize bonus</th><th className="py-1">Wallets now</th></tr></thead>
            <tbody>
              <tr className="border-t border-white/5"><td className="py-1 pr-3 text-paper">FREE</td><td className="py-1 pr-3 tnum">0</td><td className="py-1 pr-3 tnum">+0%</td><td className="py-1 tnum">{o.holderCounts.find((c) => c.label === "FREE")?.users ?? 0}</td></tr>
              {o.holderBonusTiers.map((t) => (
                <tr key={t.label} className="border-t border-white/5">
                  <td className="py-1 pr-3 text-paper">{t.label}</td>
                  <td className="py-1 pr-3 tnum">{t.minimum}</td>
                  <td className="py-1 pr-3 tnum">{t.bonus}</td>
                  <td className="py-1 tnum">{o.holderCounts.find((c) => c.label === t.label)?.users ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Today (UTC)">
        <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat label="Picks resolved" value={o.today.totalPicks.toLocaleString()} />
          <Stat label="Correct picks" value={o.today.correctPicks.toLocaleString()} />
          <Stat label="Picks counted" value={o.today.boardPicks.toLocaleString()} sub="every valid pick made today counts on the boards" />
          <Stat label="Leaderboard points" value={o.today.leaderboardPoints.toLocaleString()} />
          <Stat label="Lifetime Points issued" value={o.today.lifetimePointsIssued.toLocaleString()} />
          <Stat label="Scoring participants" value={o.today.participants.toLocaleString()} />
        </div>
      </Card>
      <Card title="Reward health">
        <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Base prizes credited" value={o.awarded.base} sub="Daily + Weekly" />
          <Stat label="Holder bonuses credited" value={o.awarded.bonus} sub={`${o.awarded.pendingBonuses} pending verification`} />
          <Stat label="Held for review" value={o.awarded.heldBase} sub="base prizes awaiting an admin" />
          <Stat label="Outstanding (owed)" value={o.outstanding} sub={`claimable ${o.claimableLiability} · pending ${o.reservedByClaims}`} />
          <Stat label="Sent (paid by hand)" value={o.claimed} />
          <Stat label="Reward wallet balance" value={o.treasuryBalance ?? "not monitored"} />
          <Stat label="Coverage" value={o.coverageRatio === null ? "–" : `${o.coverageRatio.toFixed(2)}×`} sub="reward wallet ÷ outstanding" />
          <Stat label="Pending claims" value={`${o.pendingClaims.count}`} sub={`${o.pendingClaims.amount} $CLANKRPG · ${o.heldAccounts} account(s) held`} />
        </div>
      </Card>
      <Card title="Battle picks are made on (live counts — admins only)">
        {o.currentBattle ? <p className="text-sm text-steel-300">{o.currentBattle.picks} pick(s). By fighter: <span className="font-mono text-xs">{JSON.stringify(Object.fromEntries(Object.entries(o.currentBattle.distribution).map(([k, v]) => [short(k), v])))}</span></p> : <p className="text-sm text-steel-400">No battle open for picks.</p>}
      </Card>
    </>
  );
}

function Battles() {
  const { data } = useAdminData<{ battles: Row[] }>("/api/admin/picks/battles?limit=50");
  return <Card title="Recently scored battles (no token is attached to a battle)"><Table rows={(data?.battles ?? []).map((b) => ({ ...b, battle: `#${b.sequence}`, picks_by_fighter: b.picks_by_fighter }))} columns={["battle", "status", "winner", "picks_total", "correct_picks", "correct_pickers", "scored_picks", "scored_points", "lifetime_points", "picks_by_fighter", "settled_at"]} /></Card>;
}

interface ReviewData { held: Row[]; walletAttempts: Row[]; sharedWallets: Row[]; heldPrizes: Row[] }

function Review() {
  const { data, reload } = useAdminData<ReviewData>("/api/admin/picks/review");
  const [msg, setMsg] = useState("");
  const [uid, setUid] = useState("");
  const state = (id: unknown, s: "NORMAL" | "REVIEW" | "SUSPENDED") => {
    const reason = s === "NORMAL" ? "" : (window.prompt(`Why ${s}? (shown to admins only)`) ?? "");
    if (s !== "NORMAL" && !reason) return;
    void act(`/api/admin/picks/accounts/${id}/review`, "POST", { state: s, reason }, reload, setMsg);
  };
  return (
    <>
      <Note msg={msg} />
      <Card title="Accounts held for review (claims blocked; rewards still recorded)">
        <Table rows={(data?.held ?? []).map((r) => ({ ...r, wallet: short(r.holder_wallet_address) }))} columns={["telegram_user_id", "display_name", "telegram_status", "flag_reason", "review_state", "review_reason", "review_updated_by", "claimable", "wallet"]} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={uid} onChange={(e) => setUid(e.target.value)} placeholder="Telegram user id" className="rounded-md border border-white/15 bg-ink-950/70 px-2 py-1 text-sm" aria-label="Telegram user id" />
          {(["REVIEW", "SUSPENDED", "NORMAL"] as const).map((s) => <button key={s} type="button" className="btn btn-ghost btn-sm" onClick={() => uid && state(uid, s)}>{s === "NORMAL" ? "Clear hold" : `Set ${s}`}</button>)}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const reason = window.prompt("Why is sharing a wallet legitimate? (audited)"); if (uid && reason) void act(`/api/admin/picks/accounts/${uid}/wallet-exception`, "POST", { reason }, reload, setMsg); }}>Approve wallet exception</button>
        </div>
      </Card>
      <Card title="Duplicate wallet attempts (holder wallets, and claims to another account's verified wallet)"><Table rows={(data?.walletAttempts ?? []).map((a) => ({ ...a, attempted_address: short(a.attempted_address) }))} columns={["created_at", "telegram_user_id", "display_name", "attempted_address", "conflicting_user_id"]} /></Card>
      <Card title="Wallets shared by several accounts (holder wallets and payout destinations)"><Table rows={(data?.sharedWallets ?? []).map((s) => ({ ...s, wallet: short(s.wallet) }))} columns={["kind", "wallet", "accounts", "telegram_user_ids"]} /></Card>
      <Card title="Leaderboard prizes held for review (rank kept — release or forfeit under Daily & Weekly; a holder bonus follows its prize)"><Table rows={data?.heldPrizes ?? []} columns={["kind", "period_start", "telegram_user_id", "hero_name", "rank", "points", "prize", "bonus", "bonus_status", "hold_reason"]} /></Card>
    </>
  );
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const text = (v: unknown): string => (v === null || v === undefined || v === "" ? "–" : String(v));
const when = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? fmtDate(v as string) : "–");

/** One member's reward state, laid out for scanning (admin only). Wraps to one column on a phone. */
export function MemberDetail({ detail }: { detail: Obj }) {
  const identity = obj(detail.identity), hero = obj(detail.hero), holder = obj(detail.holder), points = obj(detail.points), picks = obj(detail.picks), rewards = obj(detail.rewards), review = obj(detail.review);
  const daily = obj(holder?.daily), weekly = obj(holder?.weekly);
  const observations = Array.isArray(holder?.observations) ? (holder?.observations as Obj[]) : [];
  const boards = Array.isArray(detail.boards) ? (detail.boards as Obj[]) : [];
  const qual = (q: Obj | null): string => (q ? `${text(q.status)}${q.tier ? ` · ${text(q.tier)}` : ""}${q.since ? ` · since ${when(q.since)}` : ""}${q.brokenAt ? ` · broken ${when(q.brokenAt)} (${text(q.brokenBy)})` : ""}` : "–");
  const groups: Array<[string, Array<[string, string]>]> = [
    ["Telegram identity", [["Telegram id", text(identity?.telegramUserId)], ["Display name", text(identity?.displayName)], ["Username", text(identity?.username)], ["Telegram status", text(identity?.telegramStatus)], ["Qualifying messages", text(identity?.qualifyingMessages)], ["First seen", when(identity?.firstSeenAt)]]],
    ["Hero", [["Name", text(hero?.name)], ["Class", text(hero?.classId)], ["Status", text(hero?.status)]]],
    ["Holder wallet & verification", [["Verified wallet", text(holder?.wallet)], ["Wallet verified", when(holder?.walletVerifiedAt)], ["Balance (last read)", text(holder?.verifiedBalance)], ["Observed tier", text(holder?.observedTier)], ["Last verified", when(holder?.balanceVerifiedAt)], ["Next verification", when(holder?.nextCheckAt)], ["Verification failures", text(holder?.checkFailures)], ["Stale", holder?.stale ? "yes" : "no"], ["Last check error", text(holder?.lastError)]]],
    ["Bonus qualification (now)", [["Daily bonus", qual(daily)], ["Weekly bonus", qual(weekly)]]],
    ["Points & picks", [["Today's Points", text(points?.today)], ["Weekly Points", text(points?.weekly)], ["Lifetime Clank Points", text(points?.lifetime)], ["Picks today", text(points?.picksToday)], ["Picks this week", text(points?.picksThisWeek)], ["Total picks", text(picks?.total)], ["Correct picks", text(picks?.correct)], ["Accuracy", picks?.accuracy === null || picks?.accuracy === undefined ? "–" : `${text(picks?.accuracy)}%`]]],
    ["Rewards ($CLANKRPG)", [["Claimable", text(rewards?.claimable)], ["Pending claim", text(rewards?.reserved)], ["Claimed", text(rewards?.claimed)], ["Total earned", text(rewards?.earned)]]],
    ["Risk / review", [["Review state", text(review?.state)], ["Reason", text(review?.reason)], ["Wallet exception", review?.walletException ? "approved" : "no"]]],
  ];
  return (
    <div className="space-y-3" data-testid="account-detail">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {groups.map(([title, rows]) => (
          <section key={title} className="min-w-0 rounded-md border border-white/10 bg-ink-950/60 p-3">
            <h4 className="label mb-2">{title}</h4>
            <dl className="space-y-1.5 text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <dt className="text-xs text-steel-400">{k}</dt>
                  <dd className="min-w-0 break-all text-right font-mono text-xs text-paper">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      {boards.length > 0 && (
        <section className="min-w-0 rounded-md border border-white/10 bg-ink-950/60 p-3">
          <h4 className="label mb-2">Recent board results</h4>
          <ul className="space-y-1 text-xs text-steel-200">
            {boards.map((b, i) => (
              <li key={i} className="break-words"><span className="chip mr-2">{text(b.kind)}</span>{text(b.period)} · #{text(b.rank)} · {text(b.points)} pts · base {text(b.base)} ({text(b.baseStatus)}){b.bonusTier ? ` · bonus ${text(b.bonusTier)} ${text(b.bonusPercent)} = ${text(b.bonus)} (${text(b.bonusStatus)})` : ""}</li>
            ))}
          </ul>
        </section>
      )}
      {observations.length > 0 && (
        <section className="min-w-0 rounded-md border border-white/10 bg-ink-950/60 p-3">
          <h4 className="label mb-2">Latest balance observations (the continuity evidence)</h4>
          <ul className="space-y-1 text-xs text-steel-200">
            {observations.map((o, i) => (
              <li key={i} className="break-words"><span className="chip mr-2">{text(o.source)}</span>{text(o.balance)} · {when(o.at)}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Accounts() {
  const { data, reload } = useAdminData<{ accounts: Row[] }>("/api/admin/picks/accounts?limit=100");
  const [msg, setMsg] = useState("");
  const [look, setLook] = useState("");
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const open = async (id: string) => {
    const r = await api<{ detail: Record<string, unknown> }>(`/api/admin/picks/accounts/${encodeURIComponent(id)}`);
    setDetail(r.ok ? r.data.detail : null);
    setMsg(r.ok ? "" : `Failed: ${r.error}`);
  };
  const [f, setF] = useState({ user: "", amount: "", direction: "credit", reason: "" });
  return (
    <>
      <Card title="Pickers (observability only — high accuracy alone never triggers a ban)">
        <Table rows={(data?.accounts ?? []).map((a) => ({ ...a, wallet: short(a.holder_wallet_address) }))} columns={["telegram_user_id", "display_name", "first_seen_at", "qualifying_message_count", "picks", "correct", "accuracy", "earned", "claimed", "wallet", "accounts_on_wallet", "review_state"]} />
      </Card>
      <Card title="Member reward detail (admin only)">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input value={look} onChange={(e) => setLook(e.target.value)} placeholder="Telegram user id" className="rounded-md border border-white/15 bg-ink-950/70 px-2 py-1 text-sm" aria-label="Telegram user id" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => look && void open(look)}>Open</button>
        </div>
        {detail ? <MemberDetail detail={detail} /> : <p className="text-sm text-steel-400">Telegram identity, hero, verified wallet, balance and observed tier, Daily / Weekly bonus qualification, scored picks, points, accuracy, claimable/claimed, review status and the latest balance observations.</p>}
      </Card>
      <Card title="Adjust a reward balance (audited, idempotent, can never overdraw)">
        <Note msg={msg} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-steel-300">Telegram id<input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} className="mt-1 block rounded-md border border-white/15 bg-ink-950/70 px-2 py-1 text-sm text-paper" /></label>
          <label className="text-xs text-steel-300">Amount ($CLANKRPG)<input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="mt-1 block rounded-md border border-white/15 bg-ink-950/70 px-2 py-1 text-sm text-paper" /></label>
          <label className="text-xs text-steel-300">Direction<select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} className="mt-1 block rounded-md border border-white/15 bg-ink-950/70 px-2 py-1 text-sm text-paper"><option value="credit">credit</option><option value="debit">debit</option></select></label>
          <label className="min-w-[12rem] flex-1 text-xs text-steel-300">Reason<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} className="mt-1 block w-full rounded-md border border-white/15 bg-ink-950/70 px-2 py-1 text-sm text-paper" /></label>
          <button type="button" className="btn btn-sm" onClick={() => void act(`/api/admin/picks/accounts/${f.user}/adjust`, "POST", { amount: f.amount, direction: f.direction, reason: f.reason, key: `adj-${crypto.randomUUID()}` }, reload, setMsg)}>Apply</button>
        </div>
      </Card>
    </>
  );
}

function Reconciliation() {
  const { data } = useAdminData<{ issues: Array<{ severity: string; type: string; ref: string; detail: string }> }>("/api/admin/picks/reconciliation");
  const issues = data?.issues ?? [];
  return (
    <Card title="Reconciliation (the healthy answer is an empty list)">
      {issues.length === 0 ? <p className="text-sm text-teal">All reward books reconcile.</p> : (
        <ul className="space-y-2">{issues.map((i) => <li key={`${i.type}${i.ref}`} className="rounded-md border border-white/10 px-3 py-2 text-sm"><span className="chip mr-2">{i.severity}</span><b>{i.type}</b> <span className="font-mono text-xs">{short(i.ref)}</span> — {i.detail}</li>)}</ul>
      )}
      <p className="mt-2 text-xs text-steel-400">Last checked {fmtDate(new Date())}.</p>
    </Card>
  );
}
