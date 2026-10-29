"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { RarityBadge, PwrValue } from "@/components/hero/rarity";
import type { Rarity } from "@/domain/character/appearance";
import { graphemes } from "@/domain/character/displayName";
import { isFallbackName, RPG_NAME_MAX, validateRpgName } from "@/domain/character/rpgName";
import { api, friendly } from "@/lib/api";
import { cropToSquare, PhotoPrepError, type CroppedPhoto } from "@/lib/imageCrop";
import { useRemote } from "@/lib/useRemote";
import type { HeroDetail, HeroListRow } from "@/server/services/heroAdmin";
import type { HeroPhotoAdminView } from "@/server/services/heroPhotos";

import { HeroVersionsPanel } from "./HeroVersionsPanel";

const fmtDate = (v: unknown) => (v ? new Date(String(v)).toLocaleString() : "–");
const n = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString());

interface Page {
  heroes: HeroListRow[];
  total: number;
  limit: number;
  offset: number;
}

const RARITIES = ["COMMON", "RARE", "EPIC", "LEGENDARY"];
const sel = "rounded-md border border-white/10 bg-ink-900 px-2 py-1 text-sm text-paper";

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Panel({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="plate mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">{title ? <h2 className="label min-w-0 [overflow-wrap:anywhere]">{title}</h2> : <span />}{actions}</div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function HeroManager() {
  const [search, setSearch] = useState("");
  const [f, setF] = useState({ claimed: "", classId: "", rarity: "", kind: "", status: "", renamed: "", sort: "newest" });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  // The detail panel renders below a 25-row list: bring it into view when a hero is opened.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ block: "start" });
  }, [selected]);
  const q = useDebounced(search.trim());

  const params = new URLSearchParams({ limit: "25", offset: String(offset), sort: f.sort });
  if (q) params.set("search", q);
  if (f.claimed) params.set("claimed", f.claimed);
  if (f.classId) params.set("class", f.classId);
  if (f.rarity) params.set("rarity", f.rarity);
  if (f.kind) params.set("kind", f.kind);
  if (f.status) params.set("status", f.status);
  if (f.renamed) params.set("renamed", f.renamed);
  const key = `/api/admin/heroes?${params}`;
  const { data, error, reload } = useRemote<Page>(() => api<Page>(key), key);
  const { data: config } = useRemote<{ classes: Array<{ id: string; name?: string }> }>(() => api("/api/admin/config"), "admin-config-classes");

  const set = (patch: Partial<typeof f>) => {
    setF((cur) => ({ ...cur, ...patch }));
    setOffset(0);
  };

  return (
    <>
      <Panel title="Find a hero" actions={<span className="text-xs text-steel-400">{data ? `${n(data.total)} match${data.total === 1 ? "" : "es"}` : ""}</span>}>
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Hero status">
          {([["", "All"], ["ACTIVE", "Active"], ["SUSPENDED", "Suspended"], ["INACTIVE", "Inactive"]] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={f.status === value} className={`btn btn-sm ${f.status === value ? "btn-teal" : "btn-ghost"}`} onClick={() => set({ status: value })}>{label}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <input value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} placeholder="RPG name, Telegram name, @username, Telegram ID or hero ID" aria-label="Search heroes" className={`${sel} min-w-[16rem] flex-1`} />
          <select aria-label="Claimed filter" className={sel} value={f.claimed} onChange={(e) => set({ claimed: e.target.value })}><option value="">Claimed + unclaimed</option><option value="claimed">Claimed</option><option value="unclaimed">Unclaimed</option></select>
          <select aria-label="Class filter" className={sel} value={f.classId} onChange={(e) => set({ classId: e.target.value })}><option value="">Any class</option>{config?.classes.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}</select>
          <select aria-label="Rarity filter" className={sel} value={f.rarity} onChange={(e) => set({ rarity: e.target.value })}><option value="">Any rarity</option>{RARITIES.map((r) => <option key={r} value={r}>{r.charAt(0) + r.slice(1).toLowerCase()}</option>)}</select>
          <select aria-label="Hero type filter" className={sel} value={f.kind} onChange={(e) => set({ kind: e.target.value })}><option value="">All hero types</option><option value="COMMUNITY">Normal heroes</option><option value="SPECIAL_CHARACTER">Special characters</option></select>
          <select aria-label="Status filter" className={sel} value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="">Any status</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="SUSPENDED">Suspended</option></select>
          <select aria-label="Renamed filter" className={sel} value={f.renamed} onChange={(e) => set({ renamed: e.target.value })}><option value="">Renamed or not</option><option value="renamed">Manually renamed</option><option value="original">Original name</option></select>
          <select aria-label="Sort" className={sel} value={f.sort} onChange={(e) => set({ sort: e.target.value })}><option value="newest">Newest first</option><option value="name">Name A–Z</option><option value="power">Highest PWR</option><option value="power_asc">Lowest PWR</option></select>
        </div>
      </Panel>

      <Panel>
        {error && <p className="text-danger">{friendly(error.error)}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr>{["Hero", "Telegram", "Class", "Rarity", "PWR", "Ownership", "Status", "Qualifying", ""].map((h) => <th key={h} className="label whitespace-nowrap px-2 py-1.5">{h}</th>)}</tr></thead>
            <tbody>
              {data?.heroes.map((h) => (
                <tr key={h.id} className={`border-t border-white/5 ${selected === h.id ? "bg-white/5" : ""}`}>
                  <td className="max-w-[16rem] min-w-[9rem] px-2 py-1.5 text-paper [overflow-wrap:anywhere]">
                    <Thumb url={h.avatarUrl} name={h.rpgName} />
                    <span className="font-semibold">{h.rpgName}</span>
                    {h.renamed && <span className="chip ml-1.5" title={`Generated name: ${h.generatedName}`}>renamed</span>}
                    {!h.renamed && isFallbackName(h.rpgName) && <span className="chip ml-1.5 border-clank-500/40 text-clank-300" title="Fallback name — a good candidate for a rename">fallback</span>}
                    {h.isDemo && <span className="chip ml-1.5">demo</span>}
                    {h.kind === "SPECIAL_CHARACTER" && <span className="chip ml-1.5 border-teal/40 text-teal">special</span>}
                    {h.needsRebalance && <span className="chip ml-1.5 border-ember/40 text-ember" title="Still on the first hero generator — it moves onto the rarity power system with the system rebalance" data-testid="needs-rebalance">needs rebalance</span>}
                  </td>
                  <td className="px-2 py-1.5 text-steel-300">
                    {h.telegramUserId === null ? "–" : <><span className="text-paper">{h.telegramDisplayName || "(no name)"}</span>{h.telegramUsername ? <> · @{h.telegramUsername}</> : null}<br /><span className="tnum text-xs text-steel-400">{h.telegramUserId}</span></>}
                  </td>
                  <td className="px-2">{h.classId}</td>
                  <td className="px-2">{h.rarity ? <RarityBadge rarity={h.rarity as Rarity} size="sm" /> : "–"}</td>
                  <td className="px-2">{h.rarity ? <PwrValue power={h.power} rarity={h.rarity as Rarity} size="sm" inline /> : <span className="tnum">{n(h.power)}</span>}</td>
                  <td className="px-2"><span className={`chip ${h.claimed ? "border-ok/40 text-ok" : ""}`}>{h.claimed ? "claimed" : "unclaimed"}</span></td>
                  <td className="px-2">{h.status.toLowerCase()}</td>
                  <td className="px-2 tnum">{n(h.qualifyingMessages)}</td>
                  <td className="px-2 py-1.5"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(h.id)}>Open</button></td>
                </tr>
              ))}
              {data && data.heroes.length === 0 && <tr><td colSpan={10} className="px-2 py-4 text-steel-400">No heroes match.</td></tr>}
              {!data && !error && <tr><td colSpan={10} className="px-2 py-4 text-steel-400">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
        {data && data.total > data.limit && (
          <div className="mt-3 flex items-center justify-between text-sm text-steel-300">
            <button type="button" className="btn btn-ghost btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - data.limit))}>← Previous</button>
            <span className="tnum">{offset + 1}–{Math.min(offset + data.limit, data.total)} of {n(data.total)}</span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={offset + data.limit >= data.total} onClick={() => setOffset(offset + data.limit)}>Next →</button>
          </div>
        )}
      </Panel>

      {selected && <div ref={detailRef} className="scroll-mt-4"><HeroDetailPanel key={selected} id={selected} onClose={() => setSelected(null)} onChanged={reload} /></div>}
    </>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="label !text-[0.6rem]">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-paper">{children}</dd>
      {hint && <p className="text-[0.65rem] text-steel-400">{hint}</p>}
    </div>
  );
}

function HeroDetailPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, reload } = useRemote<{ hero: HeroDetail }>(() => api(`/api/admin/heroes/${id}`), `hero-${id}`);
  const hero = data?.hero;
  const refresh = () => {
    reload();
    onChanged();
  };

  if (error) return <Panel title="Hero" actions={<button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>}><p className="text-danger">{friendly(error.error)}</p></Panel>;
  if (!hero) return <Panel title="Hero"><p className="text-steel-300">Loading…</p></Panel>;

  return (
    <Panel title={`Hero · ${hero.rpgName}`} actions={<button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>}>
      <div className="mb-5 border-b border-white/10 pb-5">
        <h3 className="mb-3 font-display text-sm tracking-wider text-clank-300 uppercase">Hero card &amp; versions</h3>
        <HeroVersionsPanel heroId={hero.id} onChanged={onChanged} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <h3 className="font-display text-sm tracking-wider text-clank-300 uppercase">RPG identity</h3>
          <dl className="mt-2 grid gap-2">
            <Field label="RPG display name" hint="Shown everywhere in Clank RPG.">{hero.rpgName}</Field>
            <Field label="Generated name" hint="From the Telegram name when the hero was created.">{hero.generatedName}{hero.nameOverride ? "" : " (in use)"}</Field>
            <Field label="Character ID"><code className="text-xs">{hero.id}</code></Field>
            <Field label="Type">{hero.kind === "SPECIAL_CHARACTER" ? "Special character" : "Normal hero"} · {hero.origin.toLowerCase().replace("_", " ")}{hero.isDemo ? " · demo" : ""}</Field>
            <Field label="Class" hint="Changes only through an audited reroll / rollback (a new hero version) — never edited directly.">{hero.classId}</Field>
            <Field label="PWR">{hero.rarity ? <PwrValue power={hero.power} rarity={hero.rarity as Rarity} size="md" inline /> : n(hero.power)}</Field>
            <Field label="Rarity">{hero.rarity ? <RarityBadge rarity={hero.rarity as Rarity} size="sm" /> : "–"}</Field>
            <Field label="Arena eligible" hint="A suspended hero still exists — identity, rarity, PWR and history intact — it just does not enter NEW rosters.">{hero.arenaEligible ? "YES" : "NO"}</Field>
            <Field label="Created">{fmtDate(hero.createdAt)}</Field>
            <Field label="Last activity">{fmtDate(hero.lastActivityAt)}</Field>
          </dl>
          <h3 className="mt-4 font-display text-sm tracking-wider text-clank-300 uppercase" data-testid="hero-season-heading">{hero.season ? hero.season.label : "Current season"} performance</h3>
          {hero.season ? (
            <dl className="mt-2 grid gap-2" data-testid="hero-season">
              <Field label="Matches">{n(hero.season.matches)}</Field>
              <Field label="Wins">{n(hero.season.wins)}</Field>
              <Field label="Win rate">{hero.season.winRate === null ? "—" : `${hero.season.winRate}%`}</Field>
              <Field label="Top-2 finishes">{n(hero.season.top2)}</Field>
              <Field label="All-time (internal)" hint="Career counters across every season and development run.">{hero.career.battles} matches · {hero.career.wins} wins</Field>
            </dl>
          ) : <p className="mt-2 text-sm text-steel-300">No active season.</p>}
        </div>
        <div>
          <h3 className="font-display text-sm tracking-wider text-clank-300 uppercase">Telegram identity</h3>
          {hero.telegram ? (
            <dl className="mt-2 grid gap-2">
              <Field label="Telegram user ID" hint="Immutable. This is what ownership is tied to.">{hero.telegram.userId}</Field>
              <Field label="Telegram display name" hint="External information — can change on Telegram.">{hero.telegram.displayName || "–"}</Field>
              <Field label="Telegram @username">{hero.telegram.username ? `@${hero.telegram.username}` : "none on record"}</Field>
              <Field label="Member status">{hero.telegram.status.toLowerCase()}{hero.telegram.flagReason ? ` — ${hero.telegram.flagReason}` : ""}</Field>
              {hero.activity && (
                <>
                  <Field label="Qualifying messages">{n(hero.activity.qualifyingMessages)} of {n(hero.activity.totalMessages)} total</Field>
                  <Field label="Activity">{hero.activity.activeDays} active days · score {hero.activity.activityScore.toFixed(1)}</Field>
                  <Field label="Engagement">{hero.activity.repliesSent} replies sent · {hero.activity.repliesReceived} received · {hero.activity.reactionsReceived} reactions</Field>
                  <Field label="Messages between">{fmtDate(hero.activity.firstMessageAt)} → {fmtDate(hero.activity.lastMessageAt)}</Field>
                </>
              )}
            </dl>
          ) : <p className="mt-2 text-sm text-steel-300">No Telegram identity — this is a hand-authored special character.</p>}
          <h3 className="mt-4 font-display text-sm tracking-wider text-clank-300 uppercase">Ownership</h3>
          <dl className="mt-2 grid gap-2">
            <Field label="Claim state"><span className={`chip ${hero.claimed ? "border-ok/40 text-ok" : ""}`}>{hero.claimed ? "claimed" : "unclaimed"}</span>{hero.claimedAt ? ` since ${fmtDate(hero.claimedAt)}` : ""}</Field>
            <Field label="Linked wallet">{hero.wallet ? <code className="text-xs">{hero.wallet}</code> : "none"}</Field>
          </dl>
        </div>
        <div className="space-y-4">
          <PhotoPanel hero={hero} onDone={refresh} />
          <RenameForm hero={hero} onDone={refresh} />
          <NoteForm hero={hero} onDone={refresh} />
          <details className="rounded-md border border-white/10 p-2 text-sm"><summary className="cursor-pointer text-steel-300">Sprite configuration</summary><pre className="mt-2 max-h-56 overflow-auto text-[0.68rem] text-steel-300">{JSON.stringify({ sprite: hero.sprite, cosmeticOverrides: hero.cosmeticOverrides, seed: hero.appearanceSeed }, null, 1)}</pre></details>
          <Moderation hero={hero} onDone={refresh} />
        </div>
      </div>
    </Panel>
  );
}

/** Small avatar for the hero list: the photo when there is one, otherwise the first letter. Never a broken image. */
function Thumb({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const cls = "mr-2 inline-grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md bg-ink-800 align-middle text-xs font-bold text-steel-300 ring-1 ring-white/10";
  if (url && failed !== url) {
    // eslint-disable-next-line @next/next/no-img-element -- same-origin, versioned image served by /api/avatars
    return <img src={url} alt="" width={32} height={32} loading="lazy" className={`${cls} object-cover`} onError={() => setFailed(url)} />;
  }
  return <span aria-hidden className={cls}>{graphemes(name)[0] ?? "?"}</span>;
}

const SOURCE_LABEL: Record<HeroPhotoAdminView["active"], string> = { ADMIN: "Admin upload", TELEGRAM: "Telegram profile photo", DEFAULT: "Generated class portrait (no photo)" };

/**
 * Profile photo controls. Priority: admin upload → Telegram photo → generated portrait. Images are centre-cropped to a
 * square in the browser (EXIF removed), then validated again on the server from their bytes.
 */
function PhotoPanel({ hero, onDone }: { hero: HeroDetail; onDone: () => void }) {
  const photo = hero.photo;
  const [prepared, setPrepared] = useState<CroppedPhoto | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (prepared) URL.revokeObjectURL(prepared.previewUrl); }, [prepared]);

  async function choose(file: File | undefined) {
    setMsg(null);
    setPrepared(null);
    if (!file) return;
    try {
      setPrepared(await cropToSquare(file));
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof PhotoPrepError ? e.message : "Could not read that file." });
    }
  }

  async function send(request: () => Promise<Response>, done: string) {
    setBusy(true);
    try {
      const res = await request();
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: { status?: string } };
      if (!res.ok || body.ok === false) return setMsg({ tone: "err", text: friendly(body.error ?? "REQUEST_FAILED") });
      setMsg({ tone: "ok", text: body.result?.status ? `${done} (${body.result.status.toLowerCase().replace(/_/g, " ")})` : done });
      setPrepared(null);
      if (fileRef.current) fileRef.current.value = "";
      onDone();
    } catch {
      setMsg({ tone: "err", text: friendly("NETWORK") });
    } finally {
      setBusy(false);
    }
  }

  const upload = () => prepared && void send(() => fetch(`/api/admin/heroes/${hero.id}/photo`, { method: "PUT", headers: { "content-type": prepared.blob.type }, body: prepared.blob, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000) }), "Photo saved.");
  const remove = () => void send(() => fetch(`/api/admin/heroes/${hero.id}/photo`, { method: "DELETE", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000) }), "Admin photo removed.");
  const refreshTelegram = () => void send(() => fetch(`/api/admin/heroes/${hero.id}/photo/telegram-refresh`, { method: "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000) }), "Asked Telegram.");

  const tg = photo.telegram;
  return (
    <div>
      <h3 className="font-display text-sm tracking-wider text-clank-300 uppercase">Profile photo</h3>
      <p className="mt-1 text-xs text-steel-400">The person&apos;s picture — separate from the arena sprite. Priority: admin upload → Telegram photo → generated portrait.</p>
      <div className="mt-2 flex items-start gap-3">
        <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-lg bg-ink-800 text-center text-[0.65rem] text-steel-400 ring-1 ring-white/10">
          {photo.url ? (
            // eslint-disable-next-line @next/next/no-img-element -- same-origin, versioned image served by /api/avatars
            <img src={photo.url} alt={`${hero.rpgName} — current profile photo`} width={96} height={96} className="h-24 w-24 object-cover" />
          ) : (
            <span className="px-1">No photo — the generated class portrait is shown</span>
          )}
        </div>
        <dl className="grid min-w-0 gap-1 text-xs">
          <div><dt className="label !text-[0.55rem]">Active source</dt><dd className="text-paper" data-testid="photo-source">{SOURCE_LABEL[photo.active]}</dd></div>
          {photo.admin && <div><dt className="label !text-[0.55rem]">Admin upload</dt><dd className="text-steel-300">{photo.admin.width}×{photo.admin.height} · {Math.max(1, Math.round(photo.admin.bytes / 1024))} KB · {fmtDate(photo.admin.updatedAt)}</dd></div>}
          <div>
            <dt className="label !text-[0.55rem]">Telegram photo</dt>
            <dd className="text-steel-300">
              {!tg ? "not requested yet" : tg.status === "AVAILABLE" ? `cached ${fmtDate(tg.fetchedAt)}` : tg.status === "NONE" ? "member has no (visible) photo" : tg.status === "ERROR" ? `last attempt failed${tg.lastError ? `: ${tg.lastError}` : ""}` : "not requested yet"}
              {tg?.url && photo.active === "ADMIN" && (
                // eslint-disable-next-line @next/next/no-img-element -- admin-only preview of the cached Telegram photo
                <img src={tg.url} alt="" width={28} height={28} className="mt-1 h-7 w-7 rounded object-cover ring-1 ring-white/10" />
              )}
            </dd>
          </div>
        </dl>
      </div>

      <label className="label mt-3 block !text-[0.6rem]" htmlFor={`photo-${hero.id}`}>Upload or replace (PNG, JPEG or WebP — cropped to a square)</label>
      <input ref={fileRef} id={`photo-${hero.id}`} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => void choose(e.target.files?.[0])} className={`${sel} mt-1 w-full text-xs`} />
      {prepared && (
        <div className="mt-2 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
          <img src={prepared.previewUrl} alt="Preview of the square crop" width={64} height={64} className="h-16 w-16 rounded-lg object-cover ring-1 ring-clank-400/60" />
          <p className="text-xs text-steel-300">Square crop {prepared.width}×{prepared.height} · {Math.max(1, Math.round(prepared.blob.size / 1024))} KB</p>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm" disabled={busy || !prepared} onClick={upload}>{photo.admin ? "Replace photo" : "Upload photo"}</button>
        {photo.admin && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => window.confirm("Remove the admin photo? The hero falls back to its Telegram photo, then to the generated portrait.") && remove()}>Remove admin photo</button>}
        {hero.telegram && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={refreshTelegram} title="Ask Telegram for this member's current photo (needs the bot to be live)">Refresh from Telegram</button>}
      </div>
      {msg && <p role="status" className={`mt-2 text-sm ${msg.tone === "ok" ? "text-clank-300" : "text-danger"}`}>{msg.text}</p>}
    </div>
  );
}

function RenameForm({ hero, onDone }: { hero: HeroDetail; onDone: () => void }) {
  const [value, setValue] = useState(hero.rpgName);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const check = validateRpgName(value);
  const unchanged = check.ok && check.name === hero.rpgName;

  async function save(name: string | null) {
    setBusy(true);
    const r = await api<{ changed: boolean; oldName: string; newName: string }>(`/api/admin/heroes/${hero.id}/name`, { method: "PUT", json: { name } });
    setBusy(false);
    if (!r.ok) return setMsg(friendly(r.error));
    setMsg(r.data.changed ? `Renamed “${r.data.oldName}” → “${r.data.newName}”. Telegram ID, class, stats, claim and wallet are untouched.` : "No change.");
    onDone();
  }

  return (
    <div>
      <h3 className="font-display text-sm tracking-wider text-clank-300 uppercase">Rename</h3>
      <p className="mt-1 text-xs text-steel-400">Presentation only. Never changes who owns the hero.</p>
      <label className="label mt-2 block !text-[0.6rem]" htmlFor={`name-${hero.id}`}>RPG display name</label>
      <input id={`name-${hero.id}`} value={value} onChange={(e) => { setValue(e.target.value); setMsg(""); }} maxLength={80} className={`${sel} mt-1 w-full`} aria-invalid={!check.ok} aria-describedby={`name-help-${hero.id}`} />
      <p id={`name-help-${hero.id}`} className={`mt-1 text-xs ${check.ok ? "text-steel-400" : "text-danger"}`}>{check.ok ? `${Array.from(check.name).length}/${RPG_NAME_MAX}` : check.message}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm" disabled={busy || !check.ok || unchanged} onClick={() => check.ok && void save(check.name)}>Save name</button>
        {hero.nameOverride !== null && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save(null)}>Reset to “{hero.generatedName}”</button>}
      </div>
      {hero.nameChangedAt && <p className="mt-2 text-[0.7rem] text-steel-400">Last changed {fmtDate(hero.nameChangedAt)} ({hero.nameChangedBy?.toLowerCase() ?? "admin"})</p>}
      {msg && <p role="status" className="mt-2 text-sm text-clank-300">{msg}</p>}
      {hero.renameHistory.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[0.7rem] text-steel-400">
          {hero.renameHistory.map((h, i) => <li key={i}>{fmtDate(h.at)} — {h.oldName} → {h.newName}</li>)}
        </ul>
      )}
    </div>
  );
}

function NoteForm({ hero, onDone }: { hero: HeroDetail; onDone: () => void }) {
  const [note, setNote] = useState(hero.adminNote ?? "");
  const [msg, setMsg] = useState("");
  return (
    <div>
      <h3 className="font-display text-sm tracking-wider text-clank-300 uppercase">Admin note</h3>
      <textarea value={note} onChange={(e) => { setNote(e.target.value); setMsg(""); }} rows={3} maxLength={500} aria-label="Admin note" placeholder="Only admins see this" className={`${sel} mt-1 w-full`} />
      <div className="mt-1 flex items-center gap-2">
        <button type="button" className="btn btn-ghost btn-sm" disabled={note.trim() === (hero.adminNote ?? "")} onClick={async () => { const r = await api(`/api/admin/heroes/${hero.id}/note`, { method: "PUT", json: { note: note.trim() || null } }); setMsg(r.ok ? "Saved." : friendly(r.error)); if (r.ok) onDone(); }}>Save note</button>
        <span role="status" className="text-xs text-clank-300">{msg}</span>
      </div>
    </div>
  );
}

function Moderation({ hero, onDone }: { hero: HeroDetail; onDone: () => void }) {
  const [msg, setMsg] = useState("");
  const patch = async (body: unknown) => {
    const r = await api(`/api/admin/heroes/${hero.id}`, { method: "PATCH", json: body });
    setMsg(r.ok ? "Done." : friendly(r.error));
    if (r.ok) onDone();
  };
  return (
    <div>
      <h3 className="font-display text-sm tracking-wider text-clank-300 uppercase">Moderation</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void patch({ status: hero.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE" })}>{hero.status === "ACTIVE" ? "Suspend hero" : "Activate hero"}</button>
      </div>
      <details className="mt-3 rounded-md border border-danger/30 p-2 text-sm">
        <summary className="cursor-pointer text-danger">Advanced / dangerous</summary>
        <p className="mt-2 text-xs text-steel-300">Class, stats and identity are deliberately not editable here. These actions are logged.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const a = window.prompt("Achievement id to grant (e.g. og_clanker)"); if (a) void patch({ grantAchievement: a.trim() }); }}>Grant achievement</button>
          {hero.claimed && <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.confirm("Remove this claim and unlink the wallet? The player can claim again with Telegram.") && void patch({ unclaim: true })}>Remove claim</button>}
        </div>
      </details>
      {msg && <p role="status" className="mt-2 text-sm text-clank-300">{msg}</p>}
    </div>
  );
}
