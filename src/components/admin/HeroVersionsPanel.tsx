"use client";

import { useState } from "react";

import { HeroActions } from "@/components/hero/HeroActions";
import { HeroCard } from "@/components/hero/HeroCard";
import { PwrDelta, PwrValue, RarityBadge } from "@/components/hero/rarity";
import { CARD_STATS, formatPower, type HeroCardModel } from "@/domain/hero/card";
import { api, friendly } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";
import type { HeroVersionDto, HeroVersioningView, RerollPreviewResult, VersionChangeResult } from "@/server/services/heroVersions";

const fmtDate = (v: unknown) => (v ? new Date(String(v)).toLocaleString() : "–");
const ACTION_LABEL: Record<HeroVersionDto["action"], string> = { INITIAL: "INITIAL", REROLL: "REROLL", ROLLBACK: "ROLLBACK", SYSTEM_REBALANCE: "SYSTEM REBALANCE" };
const uuid = (): string => crypto.randomUUID();

interface Bundle {
  versioning: HeroVersioningView;
  card: HeroCardModel;
  publicUrl: string;
}

type Candidate = { kind: "reroll"; preview: RerollPreviewResult } | { kind: "version"; version: number; card: HeroCardModel };

/**
 * ADMIN · HERO CARD & VERSIONS. The hero stays the same person; only its CURRENT generated RPG state moves.
 *
 *   REROLL HERO → a server-drawn candidate is shown next to the current hero (nothing changes yet) → CANCEL · REROLL AGAIN · APPLY THIS REROLL.
 *   HISTORY     → every version, newest first, with PREVIEW and ROLL BACK (a rollback appends a new version; nothing is deleted).
 *
 * The browser never sends a seed, class, rarity or stat — only the id of a preview it was shown, or of a version it saw.
 */
export function HeroVersionsPanel({ heroId, onChanged }: { heroId: string; onChanged: () => void }) {
  const { data, error, reload } = useRemote<Bundle>(() => api<Bundle>(`/api/admin/heroes/${heroId}/versions`), `hero-versions-${heroId}`);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [confirmRollback, setConfirmRollback] = useState<{ version: HeroVersionDto; requestId: string } | null>(null);

  if (error) return <p className="text-danger">{friendly(error.error)}</p>;
  if (!data) return <p className="text-steel-300">Loading hero card…</p>;
  const { versioning, card, publicUrl } = data;
  const lock = versioning.arenaLock;
  const current = versioning.versions.find((v) => v.current);

  const done = (text: string) => {
    setMsg({ tone: "ok", text });
    setCandidate(null);
    setConfirmRollback(null);
    reload();
    onChanged();
  };
  const fail = (code: string, message?: string) => {
    setMsg({ tone: "err", text: message && code !== "INTERNAL_ERROR" ? message : friendly(code) });
    if (["STALE_PREVIEW", "STALE_VERSION", "PREVIEW_EXPIRED", "HERO_IN_ARENA"].includes(code)) reload();
  };

  async function draw() {
    setBusy(true);
    setMsg(null);
    const r = await api<{ preview: RerollPreviewResult }>(`/api/admin/heroes/${heroId}/reroll/preview`, { method: "POST", json: {} });
    setBusy(false);
    if (!r.ok) return fail(r.error, (r.detail as { message?: string } | undefined)?.message);
    setCandidate({ kind: "reroll", preview: r.data.preview });
    setShowHistory(false);
  }
  async function apply(previewId: string) {
    setBusy(true);
    const r = await api<{ result: VersionChangeResult }>(`/api/admin/heroes/${heroId}/reroll/apply`, { method: "POST", json: { previewId } });
    setBusy(false);
    if (!r.ok) return fail(r.error, (r.detail as { message?: string } | undefined)?.message);
    done(r.data.result.alreadyApplied ? `Already applied as v${r.data.result.version.number}.` : `Applied: the hero is now v${r.data.result.version.number} (${r.data.result.card.rarity.toLowerCase()} ${r.data.result.card.className}).`);
  }
  async function previewVersion(v: HeroVersionDto) {
    setBusy(true);
    setMsg(null);
    const r = await api<{ version: number; card: HeroCardModel }>(`/api/admin/heroes/${heroId}/versions/${v.id}/card`);
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setCandidate({ kind: "version", version: r.data.version, card: r.data.card });
  }
  async function rollback(v: HeroVersionDto, requestId: string) {
    if (!current) return;
    setBusy(true);
    const r = await api<{ result: VersionChangeResult }>(`/api/admin/heroes/${heroId}/rollback`, { method: "POST", json: { versionId: v.id, expectedCurrentVersionId: current.id, requestId } });
    setBusy(false);
    if (!r.ok) return fail(r.error, (r.detail as { message?: string } | undefined)?.message);
    done(r.data.result.alreadyApplied ? `Already rolled back as v${r.data.result.version.number}.` : `Rolled back to v${v.number}: the hero is now v${r.data.result.version.number}.`);
  }

  return (
    <div data-testid="hero-versions" className="min-w-0">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className="min-w-0">
          <HeroCard model={card} heading="h3" />
          <HeroActions className="mx-auto mt-3 max-w-[440px]" model={card} url={publicUrl} downloadHref={`/api/admin/heroes/${heroId}/card-image`} note={false} />
          {!versioning.moderation.isPublic && (
            <p className="mx-auto mt-1 max-w-[440px] text-[0.7rem] text-ember" data-testid="hero-not-public">Not public right now — the public link answers “not found” until the hero is active (and its member not banned).</p>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3" data-testid="hero-version-facts">
            <Fact label="Current version"><span data-testid="current-version">v{versioning.currentVersion}</span>{current ? ` · ${ACTION_LABEL[current.action]}` : ""}</Fact>
            <Fact label="Versions">{versioning.versionCount}</Fact>
            <Fact label="Moderation">{versioning.moderation.heroStatus.toLowerCase()}{versioning.moderation.memberStatus && versioning.moderation.memberStatus !== "OK" ? ` · member ${versioning.moderation.memberStatus.toLowerCase()}` : ""}</Fact>
            <Fact label="Arena eligible">{versioning.moderation.arenaEligible ? "yes" : "no"}</Fact>
            <Fact label="In a live Arena roster">{lock.locked ? "yes — frozen" : "no"}</Fact>
            <Fact label="Public profile">{versioning.moderation.isPublic ? "visible" : "hidden"}</Fact>
          </dl>

          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm" disabled={busy || !versioning.rerollable} onClick={() => void draw()} data-testid="reroll-hero">Reroll hero</button>
            <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showHistory} onClick={() => { setShowHistory((v) => !v); setCandidate((c) => (c?.kind === "reroll" ? c : null)); }} data-testid="toggle-history">History ({versioning.versionCount})</button>
          </div>
          {!versioning.rerollable && <p className="text-xs text-steel-400">{versioning.rerollBlockedReason}</p>}
          {lock.locked && <p role="status" className="rounded-md border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-ember" data-testid="arena-lock-message">{lock.message}</p>}
          <p className="text-[0.7rem] text-steel-400">Rerolls are unlimited — no cost, cooldown or cap. A reroll is a fresh draw from the same generator and the normal production odds: nothing is boosted, so it can land on a HIGHER or a LOWER rarity (and PWR) than the current hero. Rarity is a real strength tier. Previous versions are always kept.</p>
          {!versioning.onCurrentGenerator && <p className="text-xs text-ember" data-testid="legacy-generator-note">This hero is still on the first hero generator. It moves onto the rarity power system with the system rebalance — until then a reroll can only start from its current look.</p>}
          {msg && <p role="status" className={`text-sm ${msg.tone === "ok" ? "text-clank-300" : "text-danger"}`} data-testid="versions-message">{msg.text}</p>}
        </div>
      </div>

      {candidate?.kind === "reroll" && (
        <section className="mt-5 rounded-lg border border-clank-400/40 bg-clank-500/[0.06] p-3 sm:p-4" aria-label="Reroll preview" data-testid="reroll-preview">
          <h3 className="font-display text-sm tracking-wider text-clank-300 uppercase">Reroll preview — nothing has changed yet</h3>
          <p className="mt-1 text-xs text-steel-400">This candidate was drawn on the server and expires {fmtDate(candidate.preview.expiresAt)}. “Apply” turns exactly this candidate into the next version.</p>
          <PowerCompare current={candidate.preview.current} next={candidate.preview.candidate} />
          <CompareCards current={candidate.preview.current} next={candidate.preview.candidate} />
          <StatDiff current={candidate.preview.current} next={candidate.preview.candidate} />
          {candidate.preview.arenaLock.locked && <p role="status" className="mt-3 rounded-md border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-ember" data-testid="apply-blocked">{candidate.preview.arenaLock.message}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setCandidate(null); setMsg(null); }} data-testid="reroll-cancel">Cancel</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void draw()} data-testid="reroll-again">Reroll again</button>
            <button type="button" className="btn btn-sm" disabled={busy || candidate.preview.arenaLock.locked} onClick={() => void apply(candidate.preview.previewId)} data-testid="reroll-apply">Apply this reroll</button>
          </div>
        </section>
      )}

      {candidate?.kind === "version" && (
        <section className="mt-5 rounded-lg border border-white/15 bg-white/[0.03] p-3 sm:p-4" aria-label="Version preview" data-testid="version-preview">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-sm tracking-wider text-clank-300 uppercase">Preview of v{candidate.version}</h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCandidate(null)}>Close preview</button>
          </div>
          <PowerCompare current={card} next={candidate.card} nextLabel={`v${candidate.version}`} />
          <CompareCards current={card} next={candidate.card} nextLabel={`v${candidate.version}`} />
          <StatDiff current={card} next={candidate.card} />
        </section>
      )}

      {showHistory && (
        <section className="mt-5" aria-label="Hero history" data-testid="hero-history">
          <h3 className="font-display text-sm tracking-wider text-clank-300 uppercase">Hero history</h3>
          <ol className="mt-2 space-y-1.5">
            {versioning.versions.map((v) => (
              <li key={v.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border px-3 py-2 text-sm ${v.current ? "border-clank-400/50 bg-clank-500/10" : "border-white/10 bg-white/[0.02]"}`} data-testid="history-row" data-version={v.number}>
                <span className="font-display text-paper tnum">v{v.number}</span>
                <span className="chip">{ACTION_LABEL[v.action]}</span>
                <span className="min-w-0 text-paper"><RarityBadge rarity={v.rarity} className="mr-1.5 align-middle" /> {v.className}</span>
                <PwrValue power={v.power} rarity={v.rarity} size="sm" inline />
                {v.legacy && <span className="chip" title={v.generatorLabel}>FIRST GENERATOR</span>}
                <span className="text-xs text-steel-400">
                  {v.action === "ROLLBACK" && v.sourceVersion !== null ? `restores v${v.sourceVersion} · ` : v.action === "REROLL" && v.previousVersion !== null ? `from v${v.previousVersion} · ` : ""}
                  {fmtDate(v.createdAt)}
                </span>
                {v.current ? (
                  <span className="chip ml-auto border-clank-400/60 text-clank-200" data-testid="history-current">CURRENT</span>
                ) : (
                  <span className="ml-auto flex gap-1.5">
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void previewVersion(v)} data-testid="history-preview">Preview</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy || lock.locked || !versioning.rerollable || v.legacy} title={v.legacy ? "Made before the rarity power system — view only" : lock.locked ? (lock.message ?? undefined) : undefined} onClick={() => setConfirmRollback({ version: v, requestId: uuid() })} data-testid="history-rollback">Roll back</button>
                  </span>
                )}
                {confirmRollback?.version.id === v.id && (
                  <span className="flex w-full flex-wrap items-center gap-2 border-t border-white/10 pt-2" data-testid="rollback-confirm">
                    <span className="text-xs text-paper">Restore v{v.number}? It is appended as a new version; nothing is deleted.</span>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void rollback(v, confirmRollback.requestId)} data-testid="rollback-confirm-yes">Confirm roll back</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirmRollback(null)}>Cancel</button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="label !text-[0.58rem]">{label}</dt>
      <dd className="text-paper [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function CompareCards({ current, next, nextLabel = "New" }: { current: HeroCardModel; next: HeroCardModel; nextLabel?: string }) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="compare">
      <div className="min-w-0">
        <p className="label mb-1.5 text-center">Current</p>
        <HeroCard model={current} heading="h3" />
      </div>
      <div className="min-w-0">
        <p className="label mb-1.5 text-center !text-clank-300">{nextLabel}</p>
        <HeroCard model={next} heading="h3" />
      </div>
    </div>
  );
}

/**
 * THE headline of a reroll / version preview: PWR current → new, big, with the change — and the rarity and class they belong to. The admin should
 * never have to compare small numbers to see whether a candidate is stronger.
 */
export function PowerCompare({ current, next, nextLabel = "New" }: { current: HeroCardModel; next: HeroCardModel; nextLabel?: string }) {
  const delta = Math.round(next.power) - Math.round(current.power);
  const side = (m: HeroCardModel, label: string, accent: boolean) => (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
      <p className={`label ${accent ? "!text-clank-300" : ""}`}>{label}</p>
      <PwrValue power={m.power} rarity={m.rarity} size="xl" />
      <p className="flex flex-wrap items-center justify-center gap-1.5"><RarityBadge rarity={m.rarity} size="md" /><span className="font-display text-xs tracking-widest text-paper uppercase">{m.className}</span></p>
    </div>
  );
  const verdict = delta > 0 ? "Stronger" : delta < 0 ? "Weaker" : "Same PWR";
  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-black/25 p-3 sm:p-4" data-testid="power-compare" data-direction={delta > 0 ? "up" : delta < 0 ? "down" : "same"}>
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        {side(current, "Current", false)}
        <div className="flex shrink-0 flex-row items-center justify-center gap-2 sm:flex-col" aria-hidden>
          <span className="font-display text-3xl text-clank-300 sm:rotate-0">→</span>
        </div>
        {side(next, nextLabel, true)}
      </div>
      <p className="mt-3 flex flex-wrap items-center justify-center gap-3 border-t border-white/10 pt-3 text-sm" data-testid="power-verdict">
        <PwrDelta delta={delta} />
        <span className="text-steel-300">{verdict}</span>
        {current.rarity !== next.rarity && <span className="text-steel-300">· rarity changes <RarityBadge rarity={current.rarity} size="xs" className="align-middle" /> → <RarityBadge rarity={next.rarity} size="xs" className="align-middle" /></span>}
        {current.classId !== next.classId && <span className="text-steel-300">· class changes {current.className} → {next.className}</span>}
      </p>
    </div>
  );
}

/** Class · rarity · PWR · the seven stats, current → new, with the change. */
export function StatDiff({ current, next }: { current: HeroCardModel; next: HeroCardModel }) {
  const rows: Array<{ key: string; label: string; a: React.ReactNode; b: React.ReactNode; delta: number | null; same: boolean; strong?: boolean }> = [
    { key: "class", label: "Class", a: current.className, b: next.className, delta: null, same: current.classId === next.classId },
    { key: "rarity", label: "Rarity", a: <RarityBadge rarity={current.rarity} size="xs" />, b: <RarityBadge rarity={next.rarity} size="xs" />, delta: null, same: current.rarity === next.rarity },
    { key: "pwr", label: "PWR", a: formatPower(current.power), b: formatPower(next.power), delta: Math.round(next.power) - Math.round(current.power), same: false, strong: true },
    ...CARD_STATS.map(({ key, label }) => ({ key, label, a: String(Math.round(current.stats[key])), b: String(Math.round(next.stats[key])), delta: Math.round(next.stats[key]) - Math.round(current.stats[key]), same: false })),
  ];
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="stat-diff">
        <thead><tr className="text-[0.62rem] tracking-wider text-steel-400 uppercase"><th className="py-1 pr-3 font-semibold">&nbsp;</th><th className="py-1 pr-3 font-semibold">Current</th><th className="py-1 pr-3 font-semibold">New</th><th className="py-1 font-semibold">Change</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={`border-t border-white/5 ${r.strong ? "bg-white/[0.04]" : ""}`}>
              <th className={`py-1 pr-3 font-semibold ${r.strong ? "font-display text-sm text-clank-200" : "text-xs text-steel-300"}`}>{r.label}</th>
              <td className={`py-1 pr-3 text-paper tnum ${r.strong ? "font-display text-base" : ""}`}>{r.a}</td>
              <td className={`py-1 pr-3 text-paper tnum ${r.strong ? "font-display text-base" : ""}`}>{r.b}</td>
              <td className={`py-1 tnum ${r.delta === null ? "text-steel-400" : r.delta > 0 ? "text-ok" : r.delta < 0 ? "text-danger" : "text-steel-400"} ${r.strong ? "font-display text-base" : ""}`}>
                {r.delta === null ? (r.same ? "same" : "changed") : r.delta > 0 ? `▲ +${r.delta}` : r.delta < 0 ? `▼ −${Math.abs(r.delta)}` : "＝ 0"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
