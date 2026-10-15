"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Modal } from "@/components/ui/Modal";
import { CONFIRM, type ConfirmAction } from "@/domain/lifecycle";
import { LAUNCH_KEEPS, LAUNCH_RESETS, LAUNCH_WARNING, type LaunchPreflight } from "@/domain/launchPreflight";
import type { ActionAvailability, Blocker, GameControl, LifecycleActionId, SeasonView } from "@/domain/lifecycleDto";
import type { OfficialSeasonStatus } from "@/server/services/lifecycle";
import { api, friendly } from "@/lib/api";

import { Card, fmtDate, useAdminData, useAdminDataWhen } from "./adminUi";
import { LaunchReadiness, type PreflightResponse } from "./LaunchReadiness";
import { OfficialSeasonCard } from "./OfficialSeasonCard";

/**
 * GAME CONTROL — the one place where the game's lifecycle is changed: the game PHASE (Development → Live, one way), the SEASON, and the Arena's runtime
 * state (start / pause / resume). Everything shown here is read from the server (`GET /api/admin/game`); the buttons only ASK — the server re-checks
 * every precondition inside one locked transaction, so a stale screen, a second Admin window or a double click can never do something the state forbids.
 *
 * Launching Season 1 and resetting the development run are deliberate, two-step actions: an explanation (CANCEL / CONTINUE), then a typed phrase that
 * has to match exactly before the final button is enabled. Heroes are never touched by anything on this page.
 */

type Pending =
  | { id: "launch" | "resetDevelopment" | "endSeason"; step: "explain" | "type" }
  | { id: "startArena" | "pauseArena" | "resumeArena" | "createSeason"; step: "confirm" };

const STATUS_TILE: Record<GameControl["arena"]["status"], string> = { NOT_STARTED: "NOT STARTED", PREPARING: "PREPARING", RUNNING: "RUNNING", PAUSE_REQUESTED: "PAUSING…", PAUSED: "PAUSED" };

const phraseAction: Record<"launch" | "resetDevelopment" | "endSeason", ConfirmAction> = { launch: "LAUNCH", resetDevelopment: "RESET", endSeason: "END_SEASON" };
const endpoint: Record<LifecycleActionId, string> = {
  launch: "launch",
  startArena: "start",
  pauseArena: "pause",
  resumeArena: "resume",
  resetDevelopment: "reset",
  endSeason: "end-season",
  createSeason: "create-season",
};

function Tile({ label, value, sub, tone, testId, small = false }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "teal" | "gold" | "danger" | "clank"; testId?: string; small?: boolean }) {
  const color = tone === "teal" ? "text-teal" : tone === "gold" ? "text-gold" : tone === "danger" ? "text-danger" : tone === "clank" ? "text-clank-300" : "text-paper";
  return (
    <div className="min-w-0 rounded-md border border-white/10 bg-white/5 p-3" data-testid={testId}>
      <p className="label">{label}</p>
      <p className={`mt-1 font-display ${small ? "text-sm" : "text-lg"} tnum break-words ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[0.68rem] break-words text-steel-400">{sub}</p>}
    </div>
  );
}

const agoLabel = (ms: number): string => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s ago` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`);
const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `#${n.toLocaleString()}`);

function statusTone(status: GameControl["arena"]["status"]): "teal" | "gold" | "clank" | "danger" {
  if (status === "RUNNING") return "teal";
  if (status === "PREPARING" || status === "PAUSE_REQUESTED") return "gold";
  return status === "PAUSED" ? "clank" : "danger";
}

export function GameControlPanel() {
  const { data, error, reload } = useAdminData<GameControl>("/api/admin/game");
  // The launch readiness (pre-season only) and the official-season status (once live) are separate, heavier reads: asked less often than the 3 s Arena poll.
  const preSeason = data?.phase === "DEVELOPMENT";
  const live0 = data?.phase === "LIVE";
  const pre = useAdminDataWhen<PreflightResponse>("/api/admin/game/preflight", preSeason);
  const official = useAdminDataWhen<{ status: OfficialSeasonStatus }>("/api/admin/game/official-season", live0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // The Arena changes state on its own (PREPARING → RUNNING once Battle #1 is ready, PAUSE_REQUESTED → PAUSED once the last battle is done): keep looking.
  const reloadRef = useRef(reload);
  const heavyRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    reloadRef.current = reload;
    heavyRef.current = () => void (live0 ? official.reload() : preSeason ? pre.reload() : undefined);
  });
  useEffect(() => {
    const t = setInterval(() => void reloadRef.current(), 3000);
    const heavy = setInterval(() => heavyRef.current(), 12_000);
    return () => {
      clearInterval(t);
      clearInterval(heavy);
    };
  }, []);

  if (error) return <p className="text-danger" role="alert">{error}</p>;
  if (!data) return <p className="text-steel-300">Loading…</p>;

  const g = data;
  const live = g.phase === "LIVE";
  const arena = g.arena;
  const seasonLabel = g.season?.label ?? "No active season";
  const open = (p: Pending) => {
    setTyped("");
    setMsg(null);
    setPending(p);
  };
  const close = () => {
    setPending(null);
    setTyped("");
  };

  const run = async (id: LifecycleActionId) => {
    setBusy(true);
    const phrase = id === "launch" || id === "resetDevelopment" || id === "endSeason" ? typed.trim() : undefined;
    const r = await api(`/api/admin/game/${endpoint[id]}`, { method: "POST", ...(phrase !== undefined ? { json: { confirmation: phrase } } : {}) });
    setBusy(false);
    close();
    if (r.ok) setMsg({ tone: "ok", text: id === "launch" && (r.data as { alreadyLaunched?: boolean }).alreadyLaunched ? "Season 1 was already launched. This request changed nothing — the existing launch is unchanged." : ACTION_DONE[id] });
    else setMsg({ tone: "err", text: String((r.detail as { message?: string } | undefined)?.message ?? friendly(r.error)) });
    await reload();
    void pre.reload();
  };

  const statusLine =
    arena.status === "NOT_STARTED" ? (live ? "The Arena has not been started. Nothing runs until START ARENA is pressed." : "The development Arena is not running.")
    : arena.status === "PREPARING" ? `Preparing Battle ${num(g.battles.nextToIssue)} — the first roster is being made ready.`
    : arena.status === "PAUSE_REQUESTED" ? `Pausing after the current battles (${arena.committedBattles} still committed). No new battle is made.`
    : arena.status === "PAUSED" ? "The Arena is paused: no battle is created until it is resumed." : "Battles run continuously — no click per fight.";

  return (
    <>
      <Card title="Game control" actions={<span className={`chip uppercase ${live ? "border-teal/40 bg-teal/10 text-teal" : "border-clank-400/40 bg-clank-500/10 text-clank-300"}`} data-testid="phase-chip">{live ? (g.season ? `${g.season.label} active` : "Live") : "Pre-season"}</span>}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" data-testid="game-tiles">
          <Tile label="Current season state" value={live ? (g.season ? `${g.season.label} active`.toUpperCase() : "BETWEEN SEASONS") : "PRE-SEASON"} sub={live ? `Launched ${fmtDate(g.launchedAt)}` : "Practice before the official launch — nothing here is official"} tone={live ? "teal" : "clank"} testId="tile-phase" />
          <Tile label="Current season" value={seasonLabel} sub={g.season ? `${g.season.kind === "COMPETITIVE" ? "Official" : "Test run"} · started ${fmtDate(g.season.startsAt)}` : "Between seasons"} testId="tile-season" />
          <Tile label="Arena status" value={STATUS_TILE[arena.status]} sub={`since ${fmtDate(arena.statusChangedAt)}${arena.lastAdvanceAt && arena.status !== "NOT_STARTED" && arena.status !== "PAUSED" ? ` · last advance ${agoLabel(g.now - arena.lastAdvanceAt)}` : ""}`} tone={statusTone(arena.status)} testId="tile-arena" />
          <Tile label="Total heroes" value={g.heroes.total.toLocaleString()} sub="every hero that exists" testId="tile-total" />
          <Tile label="Arena eligible" value={g.heroes.eligible.toLocaleString()} sub={`${g.heroes.suspended} suspended${g.heroes.inactive ? ` · ${g.heroes.inactive} inactive` : ""}${g.heroes.bannedMember ? ` · ${g.heroes.bannedMember} banned` : ""}`} tone={g.heroes.eligible >= g.groupSize ? "teal" : "danger"} testId="tile-eligible" />
          <Tile label="Current battle" value={num(g.battles.current?.number)} sub={g.battles.current?.status} testId="tile-current" />
          <Tile label="Next battle" value={num(g.battles.next?.number)} sub={g.battles.next ? g.battles.next.status : `next number issued: ${num(g.battles.nextToIssue)}`} testId="tile-next" />
          <Tile label="Season start" small value={g.season ? fmtDate(g.season.startsAt) : "—"} sub={arena.startedAt ? `Arena started ${fmtDate(arena.startedAt)}` : "Arena not started in this season"} testId="tile-start" />
        </div>
        <p className="mt-3 text-sm text-steel-300" data-testid="status-line">{statusLine}</p>
        {msg && (
          <p role="status" className={`mt-3 rounded-md border px-3 py-2 text-sm break-words ${msg.tone === "ok" ? "border-teal/30 bg-teal/10 text-teal" : "border-danger/40 bg-danger/10 text-danger"}`} data-testid="game-message">{msg.text}</p>
        )}
      </Card>

      <Card title="Actions">
        <div className="grid gap-3 md:grid-cols-2" data-testid="game-actions">
          {!live && (
            <ActionBox
              title="Launch Season 1"
              body="Archives the development run, creates a clean Season 1 and leaves the Arena NOT STARTED. Every hero stays exactly as it is. One way: there is no going back to Development."
              a={gateLaunch(g.actions.launch, pre.data?.preflight ?? null)}
              label="Launch Season 1"
              tone="primary"
              testId="action-launch"
              onClick={() => open({ id: "launch", step: "explain" })}
            />
          )}
          {arena.status === "NOT_STARTED" && (
            <ActionBox title="Start Arena" body={`Starts ${live ? "Season 1" : "the development"} battles beginning with Battle ${num(g.battles.nextToIssue)}. Once started, battles continue automatically.`} a={g.actions.startArena} label="Start Arena" tone="primary" testId="action-start" onClick={() => open({ id: "startArena", step: "confirm" })} />
          )}
          {(arena.status === "RUNNING" || arena.status === "PREPARING") && (
            <ActionBox title="Pause Arena" body="Finishes the battles already committed (on stage, announced, prepared), then stops. Nothing visible is cancelled; no new battle is made." a={g.actions.pauseArena} label="Pause Arena" tone="ghost" testId="action-pause" onClick={() => open({ id: "pauseArena", step: "confirm" })} />
          )}
          {(arena.status === "PAUSED" || arena.status === "PAUSE_REQUESTED") && (
            <ActionBox title={arena.status === "PAUSE_REQUESTED" ? "Cancel the pause" : "Resume Arena"} body={`Continues the SAME season: the next battle is ${num(g.battles.nextToIssue)}, the queue and every record carry on.`} a={g.actions.resumeArena} label={arena.status === "PAUSE_REQUESTED" ? "Cancel pause" : "Resume Arena"} tone="primary" testId="action-resume" onClick={() => open({ id: "resumeArena", step: "confirm" })} />
          )}
          {!live && (
            <ActionBox title="Reset development run" body="Archives the current test run and starts a fresh one (battle numbers restart at #1, records at zero). Heroes and history are kept. Development only." a={g.actions.resetDevelopment} label="Reset development run" tone="danger" testId="action-reset" onClick={() => open({ id: "resetDevelopment", step: "explain" })} />
          )}
          {live && g.season && (
            <ActionBox title={`End ${g.season.label}`} body="Archives the season (battles, snapshots and results stay replayable) and leaves the game between seasons, the Arena not started." a={g.actions.endSeason} label={`End ${g.season.label}`} tone="danger" testId="action-end" onClick={() => open({ id: "endSeason", step: "explain" })} />
          )}
          {live && !g.season && (
            <ActionBox title="Create next season" body="Creates the next official season (battle numbers from #1, records at zero). The Arena stays NOT STARTED until you start it." a={g.actions.createSeason} label="Create next season" tone="primary" testId="action-create" onClick={() => open({ id: "createSeason", step: "confirm" })} />
          )}
        </div>
      </Card>

      {!live && <LaunchReadiness data={pre.data ?? null} onChanged={pre.reload} />}
      {live && <OfficialSeasonCard status={official.data?.status ?? null} />}

      {g.rewards.checked && (
        <Card title="Reward obligations">
          {g.rewards.blocking ? (
            <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger" data-testid="reward-blockers">
              <p className="font-semibold">Reward obligations exist — a launch or reset is refused until they are resolved.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">{g.rewards.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          ) : (
            <p className="text-sm text-teal" data-testid="reward-clear">No reward liabilities: nothing has been credited, reserved, claimed or held, so archiving the development run orphans nothing.</p>
          )}
          <p className="mt-2 text-xs text-steel-400">{g.rewards.finalizedBoards} finalized leaderboard(s) · claimable {g.rewards.claimableMicro} · reserved {g.rewards.reservedMicro} · claimed {g.rewards.claimedMicro} (logical micro-tokens)</p>
        </Card>
      )}

      <Card title="Seasons">
        <SeasonsTable seasons={g.seasons} />
      </Card>

      {pending && pending.step === "confirm" && (
        <Modal title={CONFIRM_COPY[pending.id].title(g)} onClose={close}>
          <p className="text-sm text-steel-300">{CONFIRM_COPY[pending.id].body(g)}</p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={close}>Cancel</button>
            <button type="button" className="btn btn-sm" disabled={busy} data-testid="confirm-action" onClick={() => void run(pending.id)}>{CONFIRM_COPY[pending.id].button}</button>
          </div>
        </Modal>
      )}

      {pending && pending.step === "explain" && (
        <Modal title={EXPLAIN_COPY[pending.id].title} onClose={close} tone="danger" wide>
          <p className="text-sm text-steel-300">{EXPLAIN_COPY[pending.id].intro}</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-paper">{EXPLAIN_COPY[pending.id].bullets(g).map((b) => <li key={b}>{b}</li>)}</ul>
          {g.actions[pending.id].warnings.map((w) => <p key={w} className="mt-2 text-sm text-clank-300">⚠ {w}</p>)}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={close} data-testid="explain-cancel">Cancel</button>
            <button type="button" className="btn btn-sm" data-testid="explain-continue" onClick={() => setPending({ id: pending.id, step: "type" })}>Continue</button>
          </div>
        </Modal>
      )}

      {pending && pending.step === "type" && (
        <TypedConfirm
          action={pending.id}
          phrase={CONFIRM[phraseAction[pending.id]]}
          typed={typed}
          setTyped={setTyped}
          busy={busy}
          onCancel={close}
          onConfirm={() => void run(pending.id)}
        />
      )}
    </>
  );
}

const ACTION_DONE: Record<LifecycleActionId, string> = {
  launch: "Season 1 is launched. The game is LIVE and the Arena is NOT STARTED — start it when you are ready.",
  startArena: "Arena start requested: Battle #1 is being prepared.",
  pauseArena: "Pause requested. The Arena pauses once the battles already committed have finished.",
  resumeArena: "The Arena is running again.",
  resetDevelopment: "The development run is archived and a fresh one has begun. Heroes are untouched.",
  endSeason: "The season is archived. Create the next one when you are ready.",
  createSeason: "The next season is created and the Arena is NOT STARTED.",
};

const CONFIRM_COPY: Record<"startArena" | "pauseArena" | "resumeArena" | "createSeason", { title: (g: GameControl) => string; body: (g: GameControl) => string; button: string }> = {
  startArena: {
    title: () => "Start Arena?",
    body: (g) => `This will start ${g.phase === "LIVE" ? g.season?.label ?? "the season" : "the development"} battles beginning with Battle #${g.battles.nextToIssue}. Once started, battles will continue automatically.`,
    button: "Start Arena",
  },
  pauseArena: {
    title: () => "Pause Arena?",
    body: () => "No new battle will be made. The battles already committed (on stage, announced, prepared) finish first; then the Arena pauses.",
    button: "Pause Arena",
  },
  resumeArena: {
    title: (g) => (g.arena.status === "PAUSE_REQUESTED" ? "Cancel the pause?" : "Resume Arena?"),
    body: (g) => `The Arena continues the same season. The next battle is #${g.battles.nextToIssue}.`,
    button: "Resume",
  },
  createSeason: {
    title: () => "Create the next season?",
    body: () => "Battle numbers start again from #1 and every hero's season record starts at zero. The Arena stays NOT STARTED until you start it.",
    button: "Create season",
  },
};

const EXPLAIN_COPY: Record<"launch" | "resetDevelopment" | "endSeason", { title: string; intro: string; bullets: (g: GameControl) => string[] }> = {
  launch: {
    title: "Launch Season 1?",
    intro: LAUNCH_WARNING,
    bullets: (g) => [
      "archive the pre-season Arena run (nothing is deleted; every battle, snapshot and hash stays replayable)",
      "create Season 1 and leave the Arena NOT STARTED — START ARENA is a separate step",
      ...LAUNCH_RESETS.map((r) => `reset — ${r}`),
      `preserve every hero exactly (${g.heroes.total} total, ${g.heroes.eligible} Arena-eligible)`,
      ...LAUNCH_KEEPS.slice(1).map((r) => `keep — ${r}`),
    ],
  },
  resetDevelopment: {
    title: "Reset current competitive state?",
    intro: "This will reset current-season competitive records while preserving heroes.",
    bullets: () => ["archive the current development run (nothing is deleted)", "start a fresh development run: battle numbers from #1, records at zero", "leave the Arena NOT STARTED", "change no hero, rarity, class, stat, PWR or version"],
  },
  endSeason: {
    title: "End the season?",
    intro: "The season is archived and the game is left between seasons.",
    bullets: (g) => [`archive ${g.season?.label ?? "the season"} (battles, snapshots, hashes and results stay replayable)`, "leave the Arena NOT STARTED with no active season", "change no hero"],
  },
};

function ActionBox({ title, body, a, label, tone, testId, onClick }: { title: string; body: string; a: ActionAvailability; label: string; tone: "primary" | "ghost" | "danger"; testId: string; onClick: () => void }) {
  const cls = tone === "primary" ? "btn btn-sm" : tone === "danger" ? "btn btn-sm border-danger/50 text-danger" : "btn btn-ghost btn-sm";
  return (
    <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] p-3" data-testid={testId} data-allowed={a.allowed}>
      <h3 className="font-display text-sm tracking-wider text-paper uppercase">{title}</h3>
      <p className="mt-1 text-sm text-steel-300">{body}</p>
      {!a.allowed && (
        <ul className="mt-2 space-y-1 text-sm text-danger" aria-label={`Why ${title} is unavailable`}>
          {a.blockers.map((b) => <li key={b.code}>{b.message}</li>)}
        </ul>
      )}
      {a.allowed && a.warnings.map((w) => <p key={w} className="mt-2 text-sm text-clank-300">⚠ {w}</p>)}
      <button type="button" className={`${cls} mt-3 max-w-full`} disabled={!a.allowed} onClick={onClick}>{label}</button>
    </div>
  );
}

function TypedConfirm({ action, phrase, typed, setTyped, busy, onCancel, onConfirm }: { action: "launch" | "resetDevelopment" | "endSeason"; phrase: string; typed: string; setTyped: (v: string) => void; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const exact = typed.trim() === phrase;
  const finalLabel = action === "launch" ? "CONFIRM SEASON 1 LAUNCH" : action === "resetDevelopment" ? "CONFIRM RESET" : "CONFIRM END SEASON";
  return (
    <Modal title={action === "launch" ? "Launch Season 1?" : action === "resetDevelopment" ? "Reset current competitive state?" : "End the season?"} onClose={onCancel} tone="danger">
      {action === "launch" && (
        <p className="mb-3 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-paper" data-testid="launch-warning">
          <b className="font-display tracking-wider text-danger uppercase">Warning.</b> {LAUNCH_WARNING}
        </p>
      )}
      <label htmlFor="typed-confirmation" className="text-sm text-steel-300">
        Type <b className="font-display tracking-wider text-paper select-all">{phrase}</b> to confirm.
      </label>
      <input
        id="typed-confirmation"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        className="mt-2 w-full rounded-md border border-white/10 bg-ink-900 px-3 py-2 font-display tracking-wider text-paper"
        data-testid="typed-confirmation"
      />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-sm border-danger/50" disabled={!exact || busy} data-testid="final-confirm" onClick={onConfirm}>{finalLabel}</button>
      </div>
    </Modal>
  );
}

function SeasonsTable({ seasons }: { seasons: SeasonView[] }) {
  if (seasons.length === 0) return <p className="text-sm text-steel-400">No seasons yet.</p>;
  return (
    <table className="w-full text-left text-sm" data-testid="seasons-table">
      <thead>
        <tr>{["Season", "Kind", "Status", "Last battle", "Started", "Ended"].map((h) => <th key={h} className="label whitespace-nowrap px-2 py-1.5">{h}</th>)}</tr>
      </thead>
      <tbody>
        {seasons.map((s) => (
          <tr key={s.id} className="border-t border-white/5">
            <td className="px-2 py-1.5 whitespace-nowrap text-paper">{s.name}</td>
            <td className="px-2 whitespace-nowrap">{s.kind === "COMPETITIVE" ? "Official" : "Development"}</td>
            <td className="px-2 whitespace-nowrap">{s.status}</td>
            <td className="px-2 whitespace-nowrap tnum">{s.lastBattleNumber ? `#${s.lastBattleNumber.toLocaleString()}` : "—"}</td>
            <td className="px-2 whitespace-nowrap">{fmtDate(s.startsAt)}</td>
            <td className="px-2 whitespace-nowrap">{fmtDate(s.endsAt)}{s.endedReason ? ` · ${s.endedReason.replaceAll("_", " ").toLowerCase()}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The launch button obeys the preflight too (backup, pending settlements, schema…): the server re-checks all of it, this only keeps a doomed click from being offered. */
function gateLaunch(a: ActionAvailability, pf: LaunchPreflight | null): ActionAvailability {
  if (!pf) return a.allowed ? { ...a, allowed: false, blockers: [{ code: "PREFLIGHT_PENDING", message: "Checking launch readiness…" }] } : a;
  const covered = new Set(["PHASE", "ARENA_STOPPED", "REWARDS"]); // already represented by the action's own blockers
  const extra: Blocker[] = pf.checks.filter((c) => c.blocking && c.status === "FAIL" && !covered.has(c.id)).map((c) => ({ code: `PREFLIGHT_${c.id}`, message: c.detail }));
  return extra.length ? { ...a, allowed: false, blockers: [...a.blockers, ...extra] } : a;
}
