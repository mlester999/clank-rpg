import type { RealtimeChannel, RealtimeClient, RealtimeClientOptions } from "@supabase/realtime-js";

import { readEnvelope, readEvent } from "@/domain/chat/envelope";
import type { ChatEvent, ChatRealtimeConfig } from "@/domain/chat/types";

import { verifyEnvelope } from "./verify";

/**
 * ARENA CHAT — the live connection to the room (Supabase Realtime Broadcast, private channel).
 *
 *   · the Realtime client is loaded on demand (a dynamic import — it is not part of the Arena's first paint) and anything that goes wrong loading or
 *     joining leaves the chat working: the caller falls back to its slow catch-up;
 *   · NOTHING is shown because it arrived: every event is verified against the server's signature first (verify.ts). A forged one is dropped; one this
 *     browser cannot verify is only a hint that something happened ("fetch the room"), never content;
 *   · reconnecting is controlled: an exponential, jittered backoff (≈1 s growing to 30 s), the same for every browser, so an outage never turns into
 *     a thundering herd; after a handful of rejected joins in a row the connection gives up for a few minutes instead of hammering a channel that
 *     refuses it (a misconfigured project must not be retried at full speed forever);
 *   · a tab that has been hidden for a minute lets go of its socket entirely (nobody is reading) and rejoins when it is seen again; a network that
 *     comes back, or a page restored from the back/forward cache, rejoins at once;
 *   · every (re)join calls `onJoined`, which is the caller's cue to catch up on what it missed while it was away.
 */

export type LiveState = "off" | "connecting" | "live" | "reconnecting" | "paused";

export interface RealtimeModule {
  RealtimeClient: new (endPoint: string, options?: RealtimeClientOptions) => RealtimeClient;
}

export interface ConnectionOptions {
  config: ChatRealtimeConfig;
  onEvent: (event: ChatEvent) => void;
  /** Something arrived that could not be verified here: go and ask the server. */
  onHint: () => void;
  onState: (state: LiveState) => void;
  /** The channel was (re)joined: catch up. */
  onJoined: () => void;
  load?: () => Promise<RealtimeModule>;
  doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> | null;
  win?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  random?: () => number;
  /** A tab hidden this long releases its socket. */
  pauseHiddenAfterMs?: number;
  /** After this many consecutive failed joins the connection rests … */
  failuresBeforeRest?: number;
  /** … for this long, then tries once more. */
  restMs?: number;
  /** Test seam: the WebSocket implementation. */
  transport?: RealtimeClientOptions["transport"];
}

export const backoffMs = (tries: number, random: () => number = Math.random): number => Math.round(Math.min(30_000, 1_000 * 2 ** Math.max(0, tries - 1)) * (0.5 + random() * 0.5));

export class ChatConnection {
  private client: RealtimeClient | null = null;
  private channel: RealtimeChannel | null = null;
  private current: LiveState = "off";
  private generation = 0;
  private failures = 0;
  private started = false;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private lastHint = 0;
  private readonly cleanup: Array<() => void> = [];
  /** What this connection has seen (tests, and a debugging aid). */
  readonly stats = { received: 0, accepted: 0, forged: 0, malformed: 0, hints: 0, joins: 0 };

  constructor(private readonly o: ConnectionOptions) {}

  get state(): LiveState {
    return this.current;
  }

  private set(state: LiveState): void {
    if (state === this.current) return;
    this.current = state;
    if (state === "live") {
      this.attempts = 0;
      this.disarm();
    } else if (state === "connecting" || state === "reconnecting") {
      if (!this.watchdog) this.arm();
    } else {
      this.disarm();
    }
    this.o.onState(state);
  }

  /**
   * Our own safety net under the library's reconnecting: if the connection is still not live after a generous, growing delay (longer than the library's
   * own retry schedule, so it only acts when the library did not recover — a runtime that never reports a refused handshake, a socket the browser put to
   * sleep), the whole client is rebuilt from scratch. Same jittered backoff for every browser; it stops the moment the room is live.
   */
  private arm(): void {
    this.disarm();
    if (!this.started) return;
    const delay = Math.round(backoffMs(++this.attempts, this.o.random ?? Math.random) * 1.5) + 2_000;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.started && (this.current === "connecting" || this.current === "reconnecting")) void this.join();
    }, delay);
  }

  private disarm(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** Starts listening to the page (visibility, network, restore) and joins the room. Safe to call twice. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const { doc, win } = this.o;
    const add = <T extends { addEventListener: (t: string, f: (e: Event) => void) => void; removeEventListener: (t: string, f: (e: Event) => void) => void }>(t: T | null | undefined, type: string, fn: (e: Event) => void): void => {
      if (!t) return;
      t.addEventListener(type, fn);
      this.cleanup.push(() => t.removeEventListener(type, fn));
    };
    add(doc, "visibilitychange", () => this.onVisibility());
    add(win, "online", () => this.nudge());
    add(win, "pageshow", (e) => {
      if ((e as PageTransitionEvent).persisted) this.nudge();
    });
    if (doc?.visibilityState === "hidden") this.onVisibility();
    else void this.join();
  }

  /** Leaves the room and stops listening. */
  stop(): void {
    this.started = false;
    for (const c of this.cleanup.splice(0)) c();
    this.clearTimers();
    this.teardown();
    this.set("off");
  }

  private clearTimers(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    if (this.restTimer) clearTimeout(this.restTimer);
    this.pauseTimer = null;
    this.restTimer = null;
    this.disarm();
  }

  private teardown(): void {
    this.generation++; // anything still in flight for the old connection is ignored from now on
    const { channel, client } = this;
    this.channel = null;
    this.client = null;
    try {
      if (channel) void client?.removeChannel(channel);
      void client?.disconnect();
    } catch {
      /* already gone */
    }
  }

  private async join(): Promise<void> {
    if (!this.started) return;
    this.teardown(); // (this also invalidates anything still in flight for an earlier connection)
    const mine = this.generation;
    this.set(this.current === "live" || this.current === "reconnecting" ? "reconnecting" : "connecting");
    this.arm(); // every (re)build is watched: if it does not get us live in time, it is rebuilt again, later
    let mod: RealtimeModule;
    try {
      mod = await (this.o.load ?? (() => import("@supabase/realtime-js") as Promise<RealtimeModule>))();
    } catch {
      if (this.generation === mine) this.rest();
      return;
    }
    if (this.generation !== mine || !this.started) return;
    try {
      const { config } = this.o;
      const random = this.o.random ?? Math.random;
      const client = new mod.RealtimeClient(config.url, {
        params: { apikey: config.key },
        heartbeatIntervalMs: 25_000,
        timeout: 10_000,
        reconnectAfterMs: (tries: number) => backoffMs(tries, random),
        ...(this.o.transport ? { transport: this.o.transport } : {}),
      });
      // The publishable key doubles as the access token of an anonymous viewer — what the Supabase client does for a visitor without a session. It is set
      // BEFORE the channel joins: a private channel joined without a token is refused once and only succeeds on the library's retry a second later.
      await client.setAuth(config.key);
      if (this.generation !== mine || !this.started) {
        void client.disconnect();
        return;
      }
      const channel = client.channel(config.topic, { config: { private: true, broadcast: { self: false, ack: false } } });
      channel.on("broadcast", { event: config.event }, (message: { payload?: unknown }) => this.receive(message?.payload, mine));
      this.client = client;
      this.channel = channel;
      channel.subscribe((status: string) => this.onStatus(status, mine));
    } catch {
      if (this.generation === mine) this.rest();
    }
  }

  private onStatus(status: string, gen: number): void {
    if (gen !== this.generation || !this.started) return;
    if (status === "SUBSCRIBED") {
      this.failures = 0;
      this.stats.joins++;
      this.set("live");
      this.o.onJoined();
      return;
    }
    // CHANNEL_ERROR · TIMED_OUT · CLOSED: the library rejoins by itself with its own stepped delay; we count the failures and rest if they never end
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      this.set("reconnecting");
      if (status !== "CLOSED" && ++this.failures >= (this.o.failuresBeforeRest ?? 6)) this.rest();
    }
  }

  /** Gives up for a while (a refused join, a failed load): the caller's slow catch-up carries the room meanwhile. */
  private rest(): void {
    this.teardown();
    this.failures = 0;
    this.set("off");
    if (this.restTimer) clearTimeout(this.restTimer);
    if (!this.started) return;
    this.restTimer = setTimeout(() => {
      this.restTimer = null;
      if (this.started) void this.join();
    }, this.o.restMs ?? 5 * 60_000);
  }

  private receive(payload: unknown, gen: number): void {
    if (gen !== this.generation) return;
    this.stats.received++;
    const envelope = readEnvelope(payload);
    if (!envelope) {
      this.stats.malformed++;
      return;
    }
    void verifyEnvelope(envelope, this.o.config.verifyKey).then((verdict) => {
      if (gen !== this.generation || !this.started) return;
      if (verdict === "forged") {
        this.stats.forged++;
      } else if (verdict === "unverifiable") {
        const now = Date.now();
        if (now - this.lastHint > 2_000) {
          this.lastHint = now;
          this.stats.hints++;
          this.o.onHint();
        }
      } else {
        const event = readEvent(envelope.j);
        if (event) {
          this.stats.accepted++;
          this.o.onEvent(event);
        } else {
          this.stats.malformed++;
        }
      }
    });
  }

  /** The network is back / the page was restored: rejoin now instead of waiting out a backoff. */
  nudge(): void {
    if (!this.started || this.current === "live" || this.current === "paused") return;
    this.clearTimers();
    this.failures = 0;
    void this.join();
  }

  private onVisibility(): void {
    const hidden = this.o.doc?.visibilityState === "hidden";
    if (hidden) {
      if (this.pauseTimer || this.current === "paused") return;
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = null;
        if (!this.started) return;
        this.teardown();
        this.set("paused");
      }, this.o.pauseHiddenAfterMs ?? 60_000);
      return;
    }
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.current === "paused") void this.join();
  }
}
