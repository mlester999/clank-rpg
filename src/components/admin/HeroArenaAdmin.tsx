"use client";

import { useState } from "react";

import { friendly } from "@/lib/api";
import type { HeroArenaAdminOverview } from "@/server/rewards/heroArenaAdmin";

import { act, Card, Note, Table, useAdminData } from "./adminUi";

/**
 * ADMIN · REWARD PROGRAMS. Arena Picks and Hero Arena are two separate programs with separate pools — shown side by side so neither can be mistaken for the other.
 * The pools are edited in Balance & config (`arena_picks` / `hero_arena`: audited like every setting). This panel shows what each program paid, what is reserved for unclaimed
 * heroes, what is held for review — and offers the one audited action an admin has on a Hero Arena prize: release a HELD one to its owner, or forfeit it.
 */
type PrizeRow = HeroArenaAdminOverview["open"][number];

export function HeroArenaAdmin() {
  const { data, error, reload } = useAdminData<{ overview: HeroArenaAdminOverview }>("/api/admin/hero-arena/overview");
  const [msg, setMsg] = useState("");
  const [reason, setReason] = useState("");
  if (error) return <p className="text-danger" role="alert">{error}</p>;
  if (!data) return <p className="text-steel-300">Loading…</p>;
  const o = data.overview;

  const resolve = async (p: PrizeRow, action: "release" | "forfeit") => {
    if (reason.trim().length < 3) return setMsg("Give a reason (at least 3 characters) — it is written to the audit log.");
    const r = await act(`/api/admin/hero-arena/boards/${p.kind}/${p.start}/prizes/${p.characterId}/resolve`, "POST", { action, reason: reason.trim() }, reload, setMsg);
    if (!r.ok) setMsg(friendly(r.error));
    else setReason("");
  };

  return (
    <div data-testid="hero-arena-admin">
      <Note msg={msg} />
      {o.notices.map((n) => <p key={n} role="status" className="mb-3 rounded-md border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-ember">{n}</p>)}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="programs">
        {o.programs.map((p) => (
          <section key={p.id} className="plate mb-4 p-4" data-testid={`program-${p.id}`}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="label">{p.label}</h2>
              <span className={`chip ${p.enabled ? "" : "border-ember/40 text-ember"}`}>{p.enabled ? "prizes on" : "prizes off"}</span>
            </div>
            <p className="mt-1 text-xs text-steel-300">Rewards: {p.rewards} · {p.minimum}</p>
            <dl className="mt-3 grid grid-cols-2 gap-2">
              <Pool label="Daily pool" value={p.dailyPool} />
              <Pool label="Weekly pool" value={p.weeklyPool} />
            </dl>
            <p className="mt-2 text-[0.72rem] text-steel-400">Ladder: {p.ladderBps.map((b) => `${b / 100}%`).join(" · ")} · edit in Balance & config → <code>{p.setting}</code></p>
          </section>
        ))}
      </div>

      <Card title="Credits by reward source (the audit label of every ledger entry)">
        <Table rows={o.ledger.map((l) => ({ source: l.source, credits: l.credits, total: `${l.total} $CLANKRPG` }))} columns={["source", "credits", "total"]} />
      </Card>

      <Card title="Hero Arena prizes">
        {o.hero.migrated ? (
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="hero-totals">
            <Stat label="Finalized boards" value={String(o.hero.boards)} />
            <Stat label="Credited" value={`${o.hero.credited.total} (${o.hero.credited.count})`} />
            <Stat label="Reserved · unclaimed heroes" value={`${o.hero.reserved.total} (${o.hero.reserved.count})`} />
            <Stat label="Held for review" value={`${o.hero.held.total} (${o.hero.held.count})`} />
            <Stat label="Returned to reserve" value={o.hero.returnedToReserve} />
          </dl>
        ) : <p className="text-sm text-steel-400">Not available until the Hero Arena migration is applied.</p>}
      </Card>

      {o.open.length > 0 && (
        <Card title="Reserved and held prizes">
          <label className="mb-3 block text-sm text-steel-300">Reason for a release / forfeit (audited)
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="mt-1 w-full rounded-md border border-white/10 bg-ink-900 px-3 py-2 text-sm text-paper" placeholder="e.g. reviewed — account is fine" />
          </label>
          <table className="w-full text-left text-sm">
            <thead><tr>{["period", "hero", "owner", "prize", "status", ""].map((c) => <th key={c} className="label px-2 py-1.5">{c}</th>)}</tr></thead>
            <tbody>
              {o.open.map((p) => (
                <tr key={`${p.kind}${p.start}${p.characterId}`} className="border-t border-white/5" data-testid="open-prize">
                  <td className="px-2 py-1.5 whitespace-nowrap">{p.kind} {p.start}</td>
                  <td className="px-2 py-1.5">{p.hero}</td>
                  <td className="px-2 py-1.5">{p.ownerUserId ?? "—"}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{p.prize}</td>
                  <td className="px-2 py-1.5">{p.status === "RESERVED" ? "reserved until the owner claims" : `held${p.holdReason ? ` (${p.holdReason})` : ""}`}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {p.status === "HELD" ? (
                      <>
                        <button type="button" className="btn btn-sm" onClick={() => void resolve(p, "release")}>Release</button>{" "}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resolve(p, "forfeit")}>Forfeit</button>
                      </>
                    ) : <span className="text-xs text-steel-400">no admin action — credited when claimed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Recent finalized Hero Arena boards">
        <Table rows={o.recentBoards.map((b) => ({ period: `${b.kind} ${b.start}`, season: b.season, pool: b.pool, participants: b.participants, eligible: b.eligible, awarded: b.awarded, returned: b.returned }))} columns={["period", "season", "pool", "participants", "eligible", "awarded", "returned"]} />
      </Card>
    </div>
  );
}

function Pool({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <dt className="label">{label}</dt>
      <dd className={`font-display text-lg tnum ${value === null ? "text-steel-300" : "text-clank-200"}`} data-testid={value === null ? "pool-not-set" : undefined}>{value === null ? "REWARD POOL NOT SET" : `${value} $CLANKRPG`}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <dt className="label">{label}</dt>
      <dd className="font-display text-sm break-words text-paper tnum">{value}</dd>
    </div>
  );
}
