import { applyHide, emptyRoom, mergeIncoming, oldestId, prependOlder, reconcileLatest, trimLive, type RoomState } from "@/domain/chat/room";
import type { ChatEvent, ChatPageDto, ChatRealtimeConfig, ChatYou } from "@/domain/chat/types";
import type { ApiErr, ApiOk } from "@/lib/api";

import type { PageQuery, SendOutcome } from "./chatApi";
import { backoffMs, type ConnectionOptions, type LiveState } from "./chatConnection";

/**
 * ARENA CHAT — the room's brain, with no React in it (so the whole thing is tested without a browser, like the Arena's audio engine).
 *
 *   · ONE source of truth for the room (`RoomState`), the viewer (`you`) and the connection (`live`); React only reads snapshots;
 *   · history comes from the server (the newest page, then older pages on demand); the live connection only adds what happens next;
 *   · every way of being out of date funnels into ONE guarded catch-up: one request at a time, never closer together than a second and a half,
 *     failures back off exponentially with jitter. Catch-up runs after every (re)join, when a tab becomes visible, when the network returns, when
 *     a page is restored, when a broadcast could not be verified — and as a slow timer (20 s without a live connection, 90 s with one, 60 s while the
 *     room is closed), only while the tab is visible. That timer is the safety net, not the delivery path;
 *   · it never throws, and a failure anywhere leaves the messages already on screen exactly where they are.
 */

export interface ChatSnapshot {
  /** loading: the first answer is awaited · ready · closed: the room is not open (calm panel) · error: the first load failed (retry button). */
  phase: "loading" | "ready" | "closed" | "error";
  closedReason: "CLOSED" | "NOT_READY" | null;
  room: RoomState;
  /** null: a guest (or not known yet — see `phase`). */
  you: ChatYou | null;
  live: LiveState;
  /** The server offered live delivery. */
  realtime: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  /** Counts the viewer's own accepted messages, so the list can follow them to the bottom whatever the scroll position. */
  ownTick: number;
}

type Timer = unknown;

export interface ControllerDeps {
  fetchPage: (q?: PageQuery) => Promise<ApiOk<ChatPageDto & { ok: true }> | ApiErr>;
  sendMessage: (body: string, nonce: string) => Promise<SendOutcome>;
  connect: (options: ConnectionOptions) => { start: () => void; stop: () => void };
  now: () => number;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (t: Timer) => void;
  random: () => number;
  doc: (Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">) | null;
  win: (Pick<Window, "addEventListener" | "removeEventListener">) | null;
}

export const CATCH_UP_SPACING_MS = 1_500;
export const SLOW_SYNC_MS = 20_000;
export const SAFETY_SYNC_MS = 90_000;
export const CLOSED_RECHECK_MS = 60_000;

const INITIAL: ChatSnapshot = { phase: "loading", closedReason: null, room: emptyRoom, you: null, live: "off", realtime: false, loadingOlder: false, olderFailed: false, ownTick: 0 };

export class ChatController {
  private snap: ChatSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private started = false;
  private inflight = false;
  private again = false;
  private lastRun = -Infinity;
  private failures = 0;
  private spacingTimer: Timer | null = null;
  private tick: Timer | null = null;
  private connection: { start: () => void; stop: () => void } | null = null;
  private connectionKey = "";
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly d: ControllerDeps) {}

  // ------------------------------------------------------------------------------------------------ store
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): ChatSnapshot => this.snap;
  getServerSnapshot = (): ChatSnapshot => INITIAL;

  private patch(p: Partial<ChatSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) l();
  }

  private get visible(): boolean {
    return !this.d.doc || this.d.doc.visibilityState !== "hidden";
  }

  // ------------------------------------------------------------------------------------------------ lifecycle
  start(): void {
    if (this.started) return;
    this.started = true;
    const on = <T extends { addEventListener: (t: string, f: (e: Event) => void) => void; removeEventListener: (t: string, f: (e: Event) => void) => void }>(t: T | null, type: string, fn: (e: Event) => void): void => {
      if (!t) return;
      t.addEventListener(type, fn);
      this.cleanup.push(() => t.removeEventListener(type, fn));
    };
    on(this.d.doc, "visibilitychange", () => {
      if (this.visible) this.requestCatchUp();
    });
    on(this.d.win, "online", () => this.requestCatchUp());
    on(this.d.win, "pageshow", (e) => {
      if ((e as PageTransitionEvent).persisted) this.requestCatchUp();
    });
    this.requestCatchUp();
  }

  stop(): void {
    this.started = false;
    for (const c of this.cleanup.splice(0)) c();
    if (this.spacingTimer !== null) this.d.clearTimer(this.spacingTimer);
    if (this.tick !== null) this.d.clearTimer(this.tick);
    this.spacingTimer = null;
    this.tick = null;
    this.connection?.stop();
    this.connection = null;
    this.connectionKey = "";
    this.again = false;
    // a controller is single-use per mount, but a Strict-Mode remount starts it again: begin from what is on screen, not from nothing
    this.snap = { ...this.snap, live: "off" };
  }

  // ------------------------------------------------------------------------------------------------ catching up
  /** Asks for the newest page of the room, soon. Any number of calls become at most one request at a time. */
  requestCatchUp(): void {
    if (!this.started) return;
    if (this.inflight) {
      this.again = true;
      return;
    }
    const wait = this.lastRun + CATCH_UP_SPACING_MS - this.d.now();
    if (wait > 0) {
      if (this.spacingTimer === null) {
        this.spacingTimer = this.d.setTimer(() => {
          this.spacingTimer = null;
          this.requestCatchUp();
        }, wait);
      }
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    this.inflight = true;
    this.lastRun = this.d.now();
    let page: (ChatPageDto & { ok: true }) | null = null;
    try {
      const r = await this.d.fetchPage({});
      if (r.ok) page = r.data;
    } catch {
      page = null;
    }
    this.inflight = false;
    if (!this.started) return;
    if (page) {
      this.failures = 0;
      this.apply(page);
    } else {
      this.failures++;
      if (this.snap.phase === "loading") this.patch({ phase: "error" });
    }
    if (this.again) {
      this.again = false;
      this.requestCatchUp();
    }
    this.armTimer();
  }

  private apply(page: ChatPageDto): void {
    if (!page.enabled) {
      this.ensureConnection(null);
      this.patch({ phase: "closed", closedReason: page.reason ?? "CLOSED", you: null, realtime: false });
      return;
    }
    this.patch({
      phase: "ready",
      closedReason: null,
      room: reconcileLatest(this.snap.room, page),
      you: page.you ?? null,
      realtime: Boolean(page.realtime),
    });
    this.ensureConnection(page.realtime ?? null);
  }

  /**
   * The next scheduled catch-up (skipped while the tab is hidden — becoming visible triggers one):
   *   · before the first answer (loading / error): quick but controlled retries, 0.5 s growing to 30 s — nobody should stare at "couldn't load";
   *   · closed: a slow re-check, so the room opens by itself when the switch is flipped or the migration is applied;
   *   · ready: the safety-net interval (90 s live, 20 s otherwise), doubling with every consecutive failure up to two minutes.
   * All jittered, so browsers that fell over together do not come back together.
   */
  private armTimer(): void {
    if (this.tick !== null) this.d.clearTimer(this.tick);
    this.tick = null;
    if (!this.started) return;
    const { phase, live } = this.snap;
    const jitter = 0.8 + this.d.random() * 0.4;
    let delay: number;
    if (phase === "loading" || phase === "error") delay = backoffMs(Math.max(1, this.failures), this.d.random);
    else if (phase === "closed") delay = CLOSED_RECHECK_MS * jitter;
    else {
      const base = (live === "live" ? SAFETY_SYNC_MS : SLOW_SYNC_MS) * jitter;
      delay = this.failures > 0 ? Math.min(120_000, base * 2 ** Math.min(this.failures, 3)) : base;
    }
    this.tick = this.d.setTimer(() => {
      this.tick = null;
      if (this.visible) this.requestCatchUp();
      else this.armTimer();
    }, delay);
  }

  // ------------------------------------------------------------------------------------------------ the live connection
  private ensureConnection(config: ChatRealtimeConfig | null): void {
    const key = config ? JSON.stringify([config.url, config.key, config.topic, config.event, config.verifyKey]) : "";
    if (key === this.connectionKey) return;
    this.connection?.stop();
    this.connection = null;
    this.connectionKey = key;
    if (!config) {
      this.patch({ live: "off" });
      return;
    }
    this.connection = this.d.connect({
      config,
      onEvent: (e) => this.onEvent(e),
      onHint: () => this.requestCatchUp(),
      onState: (live) => {
        this.patch({ live });
        this.armTimer();
      },
      onJoined: () => this.requestCatchUp(),
      doc: this.d.doc,
      win: this.d.win,
      random: this.d.random,
    });
    this.connection.start();
  }

  private onEvent(e: ChatEvent): void {
    const room = e.t === "msg" ? mergeIncoming(this.snap.room, [e.m]) : applyHide(this.snap.room, e.id, e.rev);
    if (room !== this.snap.room) this.patch({ room });
  }

  // ------------------------------------------------------------------------------------------------ what the viewer does
  /** Retry after a failed first load. */
  retry(): void {
    if (this.snap.phase === "error") this.patch({ phase: "loading" });
    this.lastRun = -Infinity;
    this.requestCatchUp();
  }

  /** Scrolling up reached the top: older messages, one page at a time. */
  async loadOlder(): Promise<void> {
    const s = this.snap;
    if (!this.started || s.loadingOlder || !s.room.hasMore) return;
    const before = oldestId(s.room);
    if (before === null) return;
    this.patch({ loadingOlder: true, olderFailed: false });
    let page: ChatPageDto | null = null;
    try {
      const r = await this.d.fetchPage({ before });
      if (r.ok) page = r.data;
    } catch {
      page = null;
    }
    if (!this.started) return;
    if (page?.enabled) this.patch({ loadingOlder: false, room: prependOlder(this.snap.room, page) });
    else this.patch({ loadingOlder: false, olderFailed: true });
  }

  /** The list is at the bottom and has grown past its budget: let go of the oldest. */
  trim(): void {
    const room = trimLive(this.snap.room);
    if (room !== this.snap.room) this.patch({ room });
  }

  /** Sends a message. The caller (the composer) owns the pending state and the nonce. Never throws. */
  async send(body: string, nonce: string): Promise<SendOutcome> {
    const r = await this.d.sendMessage(body, nonce);
    if (!this.started) return r;
    if (r.ok) {
      this.patch({ room: mergeIncoming(this.snap.room, [r.message]), ownTick: this.snap.ownTick + 1 });
    } else if (r.error === "MUTED" && this.snap.you) {
      this.patch({ you: { ...this.snap.you, canSend: false, muted: r.muted ?? { permanent: true } } });
    } else if (r.error === "UNAUTHENTICATED") {
      this.patch({ you: null });
    } else if (r.error === "CHAT_CLOSED") {
      this.patch({ phase: "closed", closedReason: "CLOSED" });
    }
    return r;
  }
}
