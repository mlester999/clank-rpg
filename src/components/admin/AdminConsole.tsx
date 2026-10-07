"use client";

import { useMemo, useState, type ReactNode } from "react";

import { Logo } from "@/components/nav/Logo";
import { api, friendly } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";

import { act, Card, fmtDate, Note, Table, useAdminData, type Row } from "./adminUi";
import { ArenaOpsPanel, type ArenaOpsData } from "./ArenaOpsPanel";
import { ArenaPicksAdmin } from "./ArenaPicksAdmin";
import { GameControlPanel } from "./GameControlPanel";
import { HeroArenaAdmin } from "./HeroArenaAdmin";
import { HeroManager } from "./HeroManager";

const SECTIONS = [
  ["overview", "Overview"], ["game", "Game control"], ["heroes", "Heroes"], ["telegram", "Telegram"], ["config", "Balance & config"], ["arena", "Arena"], ["picks", "Arena Picks"], ["hero-arena", "Hero Arena rewards"],
  ["items", "Items"], ["achievements", "Achievements"], ["tokens", "Coins & bosses"], ["flags", "Feature flags"], ["special", "Special characters"], ["audit", "Audit log"],
] as const;
type SectionId = (typeof SECTIONS)[number][0];

export function AdminConsole() {
  const { data: session, error: sessionError, loading, reload: check } = useRemote<{ authenticated: boolean; configured: boolean }>(() => api("/api/admin/session"), "admin-session");
  const auth: "loading" | "out" | "in" | "disabled" = session ? (!session.configured ? "disabled" : session.authenticated ? "in" : "out") : sessionError ? "out" : loading ? "loading" : "out";
  const [section, setSection] = useState<SectionId>("overview");

  if (auth === "loading") return <Center><p className="text-steel-300">Loading…</p></Center>;
  if (auth === "disabled") return <Center><div className="plate p-6 text-center"><h1 className="font-display text-lg text-paper">Admin is disabled</h1><p className="mt-2 text-sm text-steel-300">Admin access isn&apos;t configured on this server.</p></div></Center>;
  if (auth === "out") return <Login onDone={check} />;

  return (
    <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[230px_minmax(0,1fr)]">
      <aside className="border-b border-white/10 bg-ink-900 p-3 lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between lg:block">
          <Logo />
          <span className="chip mt-0 lg:mt-3">Admin</span>
        </div>
        <nav className="mt-3 flex gap-1 overflow-x-auto lg:flex-col" aria-label="Admin sections">
          {SECTIONS.map(([id, label]) => (
            <button key={id} type="button" onClick={() => setSection(id)} aria-current={section === id} className={`shrink-0 rounded-md px-3 py-2 text-left text-sm font-semibold ${section === id ? "bg-clank-500 text-ink-900" : "text-steel-300 hover:bg-white/5 hover:text-paper"}`}>
              {label}
            </button>
          ))}
        </nav>
        <button type="button" className="btn btn-ghost btn-sm mt-3 w-full" onClick={async () => { await api("/api/admin/session", { method: "DELETE" }); check(); }}>Sign out</button>
      </aside>
      <main className="min-w-0 p-4 sm:p-6">
        <h1 className="mb-4 font-display text-2xl text-paper">{SECTIONS.find((s) => s[0] === section)?.[1]}</h1>
        {section === "overview" && <Overview />}
        {section === "game" && <GameControlPanel />}
        {section === "heroes" && <HeroManager />}
        {section === "telegram" && <Telegram />}
        {section === "config" && <Config />}
        {section === "arena" && <ArenaAdmin />}
        {section === "picks" && <ArenaPicksAdmin />}
        {section === "hero-arena" && <HeroArenaAdmin />}
        {section === "items" && <JsonCrud title="Item templates" listPath="/api/admin/items" listKey="items" putPath="/api/admin/items" columns={["id", "name", "slot", "rarity", "enabled"]} template={ITEM_TEMPLATE} />}
        {section === "achievements" && <JsonCrud title="Achievements" listPath="/api/admin/achievements" listKey="achievements" putPath="/api/admin/achievements" columns={["id", "name", "category", "unlocked", "enabled"]} template={ACH_TEMPLATE} />}
        {section === "tokens" && <Tokens />}
        {section === "flags" && <Flags />}
        {section === "special" && <Special />}
        {section === "audit" && <Audit />}
      </main>
    </div>
  );
}

function Center({ children }: { children: ReactNode }) {
  return <div className="grid min-h-dvh place-items-center p-4">{children}</div>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Center>
      <form className="plate plate-clank w-full max-w-sm p-6" onSubmit={async (e) => { e.preventDefault(); const r = await api("/api/admin/session", { method: "POST", json: { key } }); if (r.ok) onDone(); else setErr(r.error === "RATE_LIMITED" ? friendly("RATE_LIMITED") : "That key isn't right."); }}>
        <Logo />
        <h1 className="mt-4 font-display text-lg text-paper">Admin access</h1>
        <label className="mt-3 block text-sm text-steel-300" htmlFor="adminkey">Access key</label>
        <input id="adminkey" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className="mt-1 w-full rounded-md border border-white/10 bg-ink-900 px-3 py-2 text-paper" />
        {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
        <button className="btn mt-4 w-full" type="submit">Enter</button>
      </form>
    </Center>
  );
}

// ---------------------------------------------------------------- sections
/** Two different numbers, never confused: how many heroes EXIST, and how many can fight right now (active, member not banned). A suspended hero is not "missing". */
const COUNT_LABELS: Record<string, string> = { heroes: "TOTAL HEROES", arena_eligible_heroes: "ARENA ELIGIBLE", suspended_heroes: "suspended heroes", hero_versions: "hero versions" };

function Overview() {
  const { data, error } = useAdminData<{ counts: Record<string, number>; phase: "DEVELOPMENT" | "LIVE"; arena: { status: string; paused: boolean; lastAdvanceAt: string | null; cycle: Row | null; season: Row | null; recent: Row[] }; rulesVersion: string }>("/api/admin/overview");
  if (error) return <p className="text-danger">{error}</p>;
  if (!data) return <p className="text-steel-300">Loading…</p>;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
        {Object.entries(data.counts).map(([k, v]) => (
          <div key={k} className="plate plate-flat p-3" style={{ ["--chamfer" as string]: "6px" }}><p className="label !text-[0.58rem]">{COUNT_LABELS[k] ?? k.replaceAll("_", " ")}</p><p className="font-display text-xl text-paper tnum">{v.toLocaleString()}</p></div>
        ))}
      </div>
      <Card title="Arena"><p className="text-sm text-paper" data-testid="overview-arena">{data.phase === "LIVE" ? "LIVE" : "DEVELOPMENT"} · Arena {data.arena.status.replaceAll("_", " ").toLowerCase()} · last advance {fmtDate(data.arena.lastAdvanceAt)} · combat rules v{data.rulesVersion}</p><p className="mt-1 text-sm text-steel-300">Season: {String(data.arena.season?.name ?? "none")} · Cycle: {data.arena.cycle ? `#${data.arena.cycle.number}, ${data.arena.cycle.hero_count} heroes` : "none"} · <span className="text-clank-300">Start, pause and launch live in Game control.</span></p></Card>
      <Card title="Recent battles (public number · internal sequence)"><Table rows={data.arena.recent} columns={["battle", "sequence", "status", "starts_at", "duration_ms", "ended_by", "events_hash"]} /></Card>
    </>
  );
}

function Telegram() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const { data, reload } = useAdminData<{ users: Row[] }>(`/api/admin/telegram/users?status=${status}&search=${encodeURIComponent(q)}`);
  const eligibility = useAdminData<{ threshold: number; eligibleTelegramUsers: number; heroesCreated: number; eligibleWithoutHero: number }>("/api/admin/telegram/eligibility");
  const [msg, setMsg] = useState("");
  const [importText, setImportText] = useState("");
  const [chatId, setChatId] = useState("");
  const set = (id: unknown, s: string) => {
    const reason = s === "OK" ? null : window.prompt(`Reason for ${s}?`, "") ?? null;
    return act(`/api/admin/telegram/users/${id}/status`, "POST", { status: s, reason }, reload, setMsg);
  };
  return (
    <>
      <Card title="Hero eligibility">
        {eligibility.error ? <p className="text-danger">{eligibility.error}</p> : eligibility.data ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><dt className="label">Minimum qualifying messages</dt><dd className="mt-1 font-display text-xl text-paper tnum">{eligibility.data.threshold.toLocaleString()}</dd></div>
            <div><dt className="label">Eligible Telegram users</dt><dd className="mt-1 font-display text-xl text-paper tnum">{eligibility.data.eligibleTelegramUsers.toLocaleString()}</dd></div>
            <div><dt className="label">Heroes created</dt><dd className="mt-1 font-display text-xl text-paper tnum">{eligibility.data.heroesCreated.toLocaleString()}</dd></div>
            <div><dt className="label">Eligible without a hero</dt><dd className="mt-1 font-display text-xl text-paper tnum">{eligibility.data.eligibleWithoutHero.toLocaleString()}</dd></div>
          </dl>
        ) : <p className="text-steel-300">Loading…</p>}
      </Card>
      <Card title="Members" actions={<div className="flex gap-2"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search members" className="rounded-md border border-white/10 bg-ink-900 px-2 py-1 text-sm" /><select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter" className="rounded-md border border-white/10 bg-ink-900 px-2 py-1 text-sm"><option value="">All</option><option>FLAGGED</option><option>BANNED</option><option>OK</option></select></div>}>
        <Note msg={msg} />
        <table className="w-full text-left text-sm">
          <thead><tr>{["Id", "Username", "Status", "Qualifying", "Total", "Active days", "Score", "Spam hits", "Actions"].map((h) => <th key={h} className="label px-2 py-1.5">{h}</th>)}</tr></thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={String(u.telegram_user_id)} className="border-t border-white/5">
                <td className="px-2 tnum">{String(u.telegram_user_id)}</td><td className="px-2">{String(u.username ?? u.display_name)}</td>
                <td className="px-2" title={String(u.flag_reason ?? "")}>{String(u.status)}</td><td className="px-2 tnum">{String(u.qualifying_message_count)}</td><td className="px-2 tnum">{String(u.total_message_count)}</td><td className="px-2 tnum">{String(u.active_days)}</td><td className="px-2 tnum">{Number(u.activity_score).toFixed(1)}</td><td className="px-2 tnum">{String(u.spam_rejects ?? 0)}</td>
                <td className="flex gap-1 px-2 py-1.5">
                  {u.status !== "OK" && <button className="btn btn-ghost btn-sm" type="button" onClick={() => set(u.telegram_user_id, "OK")}>Clear</button>}
                  {u.status !== "FLAGGED" && <button className="btn btn-ghost btn-sm" type="button" onClick={() => set(u.telegram_user_id, "FLAGGED")}>Flag</button>}
                  {u.status !== "BANNED" && <button className="btn btn-ghost btn-sm" type="button" onClick={() => window.confirm("Ban this member and suspend their hero?") && set(u.telegram_user_id, "BANNED")}>Ban</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Historical import (Telegram Desktop export)">
        <p className="mb-2 text-sm text-steel-300">The Bot API cannot read message history. Export the official group from Telegram Desktop (<i>Export chat history → JSON</i>), then import it here (≤ ~4 MB) or with <code>pnpm telegram:import</code> for large files. Counts are recomputed from the messages through the same anti-spam rules — never typed in. Re-importing is safe.</p>
        <input type="file" accept="application/json,.json" aria-label="Export file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setImportText(await f.text()); }} className="mb-2 block text-sm" />
        <input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="Chat id override (optional, e.g. -100123…)" aria-label="Chat id" className="mb-2 w-full max-w-sm rounded-md border border-white/10 bg-ink-900 px-2 py-1 text-sm" />
        <button className="btn btn-sm" type="button" disabled={!importText} onClick={async () => {
          try { const body: Row = { export: JSON.parse(importText) }; if (chatId.trim()) body.chatId = Number(chatId); const r = await act("/api/admin/telegram/import", "POST", body, reload, setMsg); if (r.ok) setMsg(`Imported: ${JSON.stringify((r.data as Row).summary)}`); } catch { setMsg("That file isn't valid JSON."); }
        }}>Import</button>
      </Card>
    </>
  );
}

/** Remounts the editor whenever the underlying value changes, so it never shows stale text. */
function JsonEditor({ initial, onSave, rows = 16 }: { initial: unknown; onSave: (value: unknown) => Promise<string | null>; rows?: number }) {
  const serialized = useMemo(() => JSON.stringify(initial, null, 2), [initial]);
  return <JsonEditorInner key={serialized} serialized={serialized} onSave={onSave} rows={rows} />;
}

function JsonEditorInner({ serialized, onSave, rows }: { serialized: string; onSave: (value: unknown) => Promise<string | null>; rows: number }) {
  const [text, setText] = useState(serialized);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  return (
    <div>
      <textarea value={text} onChange={(e) => { setText(e.target.value); setOk(false); }} rows={rows} spellCheck={false} aria-label="JSON" className="w-full rounded-md border border-white/10 bg-ink-950 p-2 font-mono text-xs text-paper" />
      <div className="mt-2 flex items-center gap-3">
        <button className="btn btn-sm" type="button" onClick={async () => { try { const e = await onSave(JSON.parse(text)); setErr(e); setOk(!e); } catch { setErr("Invalid JSON"); } }}>Save</button>
        {ok && <span className="text-sm text-ok">Saved & audit-logged.</span>}
        {err && <span role="alert" className="text-sm text-danger">{err}</span>}
      </div>
    </div>
  );
}

function Config() {
  const { data, reload } = useAdminData<{ settings: Record<string, unknown>; classes: Array<{ id: string }>; skills: Array<{ id: string }>; versions: Array<{ key: string; version: number; updated_by: string | null; updated_at: string }>; classEnabled: Record<string, boolean> }>("/api/admin/config");
  const [kind, setKind] = useState<"settings" | "classes" | "skills">("settings");
  const [pick, setPick] = useState("combat");
  if (!data) return <p className="text-steel-300">Loading…</p>;
  const options = kind === "settings" ? Object.keys(data.settings) : kind === "classes" ? data.classes.map((c) => c.id) : data.skills.map((s) => s.id);
  const current = options.includes(pick) ? pick : options[0]!;
  const value = kind === "settings" ? data.settings[current] : kind === "classes" ? data.classes.find((c) => c.id === current) : data.skills.find((s) => s.id === current);
  const version = data.versions.find((v) => v.key === current);
  const save = async (v: unknown): Promise<string | null> => {
    const r = kind === "settings" ? await api(`/api/admin/settings/${current}`, { method: "PUT", json: { value: v } }) : kind === "classes" ? await api(`/api/admin/classes/${current}`, { method: "PUT", json: { definition: v, enabled: data.classEnabled[current] ?? true } }) : await api(`/api/admin/skills/${current}`, { method: "PUT", json: { definition: v } });
    if (r.ok) await reload();
    return r.ok ? null : `Rejected (${r.error}) — check the values against the schema.`;
  };
  return (
    <Card title="Every balance value lives here — no deploy needed. Changes are validated, versioned and audit-logged. Battles in progress keep the ruleset they started with.">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(["settings", "classes", "skills"] as const).map((k) => <button key={k} type="button" className={`btn btn-sm ${kind === k ? "" : "btn-ghost"}`} onClick={() => { setKind(k); setPick(""); }}>{k}</button>)}
        <select value={current} onChange={(e) => setPick(e.target.value)} aria-label="Item" className="rounded-md border border-white/10 bg-ink-900 px-2 py-1.5 text-sm">{options.map((o) => <option key={o}>{o}</option>)}</select>
        {kind === "settings" && version && <span className="chip">v{version.version} · {version.updated_by ?? "seed"}</span>}
        {kind === "classes" && <label className="flex items-center gap-2 text-sm text-steel-300"><input type="checkbox" checked={data.classEnabled[current] ?? true} onChange={async (e) => { await api(`/api/admin/classes/${current}`, { method: "PUT", json: { definition: value, enabled: e.target.checked } }); await reload(); }} /> enabled for new heroes</label>}
      </div>
      <JsonEditor initial={value} onSave={save} rows={22} />
    </Card>
  );
}

function ArenaAdmin() {
  const { data, reload } = useAdminData<{ cycles: Row[]; queue: Row[]; ops: ArenaOpsData }>("/api/admin/arena");
  const [msg, setMsg] = useState("");
  const run = (action: string, confirm?: string) => { if (confirm && !window.confirm(confirm)) return; void act("/api/admin/arena", "POST", { action }, async () => { await reload(); }, setMsg); };
  return (
    <>
      <Card title="Controls">
        <Note msg={msg} />
        <p className="mb-3 text-sm text-steel-300">Starting, pausing and resuming the Arena — and launching a season — live in <b className="text-clank-300">Game control</b>. These two are emergency tools: they work in any state, serialize against every Arena step and lifecycle action, and are audit-logged.</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => run("void_unsettled", "Void any battle that has not settled? Those heroes keep their turn.")}>Void unsettled battles</button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => run("abort_cycle", "Abort the current cycle? A fresh shuffled cycle starts next.")}>Abort cycle</button>
        </div>
      </Card>
      {data?.ops && <ArenaOpsPanel ops={data.ops} />}
      <Card title="Cycles"><Table rows={data?.cycles ?? []} columns={["number", "status", "hero_count", "carried_in_count", "carried_out_count", "created_at", "seed"]} /></Card>
      <Card title="Active queue (first 64)"><Table rows={data?.queue ?? []} columns={["position", "name", "class_id", "power", "status", "carried_in"]} /></Card>
    </>
  );
}

const ITEM_TEMPLATE = { id: "cog_charm_rare", name: "Brassbound Cog Charm", description: "", slot: "TRINKET", rarity: "RARE", classRestriction: null, statMods: { luck: 2, agi: 1 }, sourceTag: "ADMIN", enabled: true };
const ACH_TEMPLATE = { id: "new_badge", name: "New Badge", description: "", category: "GENERAL", criteria: { metric: "wins", gte: 5 }, reward: { badge: "new_badge", title: "Title" }, hidden: false, enabled: true, sortOrder: 200 };

function JsonCrud({ title, listPath, listKey, putPath, columns, template }: { title: string; listPath: string; listKey: string; putPath: string; columns: string[]; template: unknown }) {
  const { data, reload } = useAdminData<Record<string, Row[]>>(listPath);
  const [msg, setMsg] = useState("");
  return (
    <>
      <Card title={`${title} — add or update (matched by id)`} actions={<Note msg={msg} />}>
        <JsonEditor initial={template} rows={14} onSave={async (v) => { const r = await api(putPath, { method: "PUT", json: v }); setMsg(r.ok ? "Saved." : ""); if (r.ok) await reload(); return r.ok ? null : `Rejected (${r.error}).`; }} />
      </Card>
      <Card title={title}><Table rows={data?.[listKey] ?? []} columns={columns} /></Card>
    </>
  );
}

function Tokens() {
  const { data, reload } = useAdminData<{ tokens: Row[] }>("/api/admin/tokens");
  const bosses = useAdminData<{ bosses: Row[] }>("/api/admin/bosses");
  const [msg, setMsg] = useState("");
  return (
    <>
      <Card title="Bonded coins (only ELIGIBLE coins affect heroes)" actions={<button className="btn btn-sm" type="button" onClick={async () => { setMsg("Scanning Clank.trade…"); const r = await api<{ summary: Row }>("/api/admin/tokens/scan", { method: "POST", json: {} }); setMsg(r.ok ? `Scan: ${JSON.stringify(r.data.summary)}` : "Scan failed — the Clank.trade data source may be unreachable."); await reload(); await bosses.reload(); }}>Scan catalog</button>}>
        <Note msg={msg} />
        <p className="mb-2 text-xs text-steel-400">&ldquo;Bonded&rdquo; is inferred from Clank.trade&apos;s public app data (state 3, progress 100), which is not an official API. Approve each coin deliberately.</p>
        <table className="w-full text-left text-sm"><thead><tr>{["Symbol", "Name", "Status", "Progress", "Holders", "Approved by", ""].map((h) => <th key={h} className="label px-2 py-1.5">{h}</th>)}</tr></thead>
          <tbody>{data?.tokens.map((t) => (
            <tr key={String(t.id)} className="border-t border-white/5"><td className="px-2 text-paper">{String(t.symbol)}</td><td className="px-2">{String(t.name)}</td><td className="px-2">{String(t.status)}</td><td className="px-2 tnum">{String(t.catalog_progress ?? "–")}</td><td className="px-2 tnum">{String(t.holders)}</td><td className="px-2">{String(t.approved_by ?? "–")}</td>
              <td className="flex gap-1 px-2 py-1.5">{(["ELIGIBLE", "REJECTED", "DELISTED"] as const).filter((s) => s !== t.status).map((s) => <button key={s} className="btn btn-ghost btn-sm" type="button" onClick={() => void act(`/api/admin/tokens/${t.id}/status`, "POST", { status: s }, async () => { await reload(); await bosses.reload(); }, setMsg)}>{s.toLowerCase()}</button>)}</td></tr>
          ))}</tbody></table>
      </Card>
      <Card title="Boss drafts — drafts only; nothing goes live in the Beta">
        <table className="w-full text-left text-sm"><thead><tr>{["Coin", "Title", "Status", "Lore", ""].map((h) => <th key={h} className="label px-2 py-1.5">{h}</th>)}</tr></thead>
          <tbody>{bosses.data?.bosses.map((b) => (
            <tr key={String(b.id)} className="border-t border-white/5"><td className="px-2 text-paper">{String(b.symbol)}</td><td className="px-2">{String((b.identity as Row)?.title ?? "")}</td><td className="px-2">{String(b.status)}</td><td className="max-w-xs truncate px-2" title={String(b.lore)}>{String(b.lore)}</td>
              <td className="flex gap-1 px-2 py-1.5">{b.status === "DRAFT" && <><button className="btn btn-ghost btn-sm" type="button" onClick={() => void act(`/api/admin/bosses/${b.id}/decision`, "POST", { decision: "APPROVED" }, bosses.reload, setMsg)}>Approve</button><button className="btn btn-ghost btn-sm" type="button" onClick={() => void act(`/api/admin/bosses/${b.id}/decision`, "POST", { decision: "REJECTED" }, bosses.reload, setMsg)}>Reject</button></>}</td></tr>
          ))}</tbody></table>
      </Card>
    </>
  );
}

function Flags() {
  const { data, reload } = useAdminData<{ flags: Array<{ key: string; enabled: boolean; description: string; updated_by: string | null }> }>("/api/admin/flags");
  const [msg, setMsg] = useState("");
  return (
    <Card title="Feature flags"><Note msg={msg} />
      <ul className="divide-y divide-white/5">{data?.flags.map((f) => (
        <li key={f.key} className="flex items-center gap-3 py-2">
          <input id={f.key} type="checkbox" checked={f.enabled} onChange={(e) => void act(`/api/admin/flags/${encodeURIComponent(f.key)}`, "PUT", { enabled: e.target.checked }, reload, setMsg)} />
          <label htmlFor={f.key} className="flex-1 text-sm"><b className="text-paper">{f.key}</b> <span className="text-steel-300">— {f.description}</span></label>
        </li>
      ))}</ul>
    </Card>
  );
}

const SPECIAL_TEMPLATE = { name: "Team Hero", classId: "warrior", role: "Community lead", bio: "", rarity: "LEGENDARY", fixedStats: { hp: 260, str: 30, def: 22, int: 8, agi: 18, cha: 16, luck: 14 }, appearanceSeed: "team-hero", active: false };
function Special() {
  const [msg, setMsg] = useState("");
  return (
    <Card title="Create a special (team) character" actions={<Note msg={msg} />}>
      <p className="mb-2 text-sm text-steel-300">Special characters are authored by hand — never generated from Telegram rules. They are created INACTIVE so they stay out of the arena until you activate them from the Heroes tab. They cannot be claimed through the community flow.</p>
      <JsonEditor initial={SPECIAL_TEMPLATE} rows={14} onSave={async (v) => { const r = await api("/api/admin/special", { method: "POST", json: v }); setMsg(r.ok ? "Created (inactive)." : ""); return r.ok ? null : `Rejected (${r.error}).`; }} />
    </Card>
  );
}

function Audit() {
  const { data } = useAdminData<{ entries: Row[] }>("/api/admin/audit");
  return <Card title="Latest admin actions"><Table rows={data?.entries ?? []} columns={["id", "created_at", "actor", "action", "entity_type", "entity_id", "detail"]} /></Card>;
}
