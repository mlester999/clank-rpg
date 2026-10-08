import { describe, expect, it } from "vitest";

import type { PageQuery, SendOutcome } from "@/components/arena/chat/chatApi";
import { CATCH_UP_SPACING_MS, ChatController, CLOSED_RECHECK_MS, SAFETY_SYNC_MS, SLOW_SYNC_MS, type ControllerDeps } from "@/components/arena/chat/chatController";
import type { ConnectionOptions, LiveState } from "@/components/arena/chat/chatConnection";
import type { ChatMessageDto, ChatPageDto, ChatRealtimeConfig, ChatYou } from "@/domain/chat/types";

/** The room's brain with no browser: a manual clock, scripted server answers and a recorded connection. */

const msg = (id: number, over: Partial<ChatMessageDto> = {}): ChatMessageDto => ({ id, at: new Date(Date.UTC(2026, 9, 8, 12, 0, id % 60)).toISOString(), name: `User ${id}`, avatarUrl: null, senderKey: "abcdefghijklmnop", body: `m${id}`, rev: 0, ...over });
const config = (over: Partial<ChatRealtimeConfig> = {}): ChatRealtimeConfig => ({ url: "wss://x.test/realtime/v1", key: "pk", topic: "arena-chat", event: "chat", verifyKey: "vk", ...over });
const you: ChatYou = { senderKey: "mine-mine-mine-12", canSend: true, muted: null };
const pageOf = (messages: ChatMessageDto[], over: Partial<ChatPageDto> = {}): ChatPageDto & { ok: true } => ({ ok: true, enabled: true, messages, hasMore: false, you: null, realtime: null, serverTime: "2026-10-08T12:00:00.000Z", ...over });

function harness(over: Partial<ControllerDeps> = {}) {
  let clock = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const fetches: Array<PageQuery | undefined> = [];
  const answers: Array<() => Promise<unknown> | unknown> = [];
  const connections: Array<{ options: ConnectionOptions; started: boolean; stopped: boolean }> = [];
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (t: string, f: (e: Event) => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f),
    removeEventListener: (t: string, f: (e: Event) => void) => void listeners.get(t)?.delete(f),
  };
  const sends: Array<{ body: string; nonce: string }> = [];
  let sendAnswer: SendOutcome = { ok: true, message: msg(500), duplicate: false };
  const deps: ControllerDeps = {
    fetchPage: async (q) => {
      fetches.push(q);
      const next = answers.shift();
      const r = next ? await next() : pageOf([]);
      return (r as { ok: boolean }).ok === false ? (r as never) : ({ ok: true, data: r } as never);
    },
    sendMessage: async (body, nonce) => {
      sends.push({ body, nonce });
      return sendAnswer;
    },
    connect: (options) => {
      const c = { options, started: false, stopped: false };
      connections.push(c);
      return { start: () => void (c.started = true), stop: () => void (c.stopped = true) };
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (t) => void timers.delete(t as number),
    random: () => 0.5,
    doc: doc as never,
    win: doc as never,
    ...over,
  };
  const chat = new ChatController(deps);
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  /** Moves the clock and fires every timer that has come due (in order), letting promises settle between them. */
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = Math.max(clock, due[1].at);
      due[1].fn();
      await flush();
    }
    clock = end;
    await flush();
  };
  return {
    chat, fetches, answers, connections, sends, doc, timers,
    answer: (r: unknown) => void answers.push(() => r),
    fire: (type: string, e: Partial<Event> = {}) => { for (const f of [...(listeners.get(type) ?? [])]) f(e as Event); },
    setSend: (r: SendOutcome) => void (sendAnswer = r),
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    flush, advance, now: () => clock,
  };
}

describe("loading the room", () => {
  it("starts 'loading', asks for the newest page once, and shows it", async () => {
    const h = harness();
    h.answer(pageOf([msg(1), msg(2)], { you }));
    expect(h.chat.getSnapshot().phase).toBe("loading");
    h.chat.start();
    await h.flush();
    expect(h.fetches).toEqual([{}]);
    const s = h.chat.getSnapshot();
    expect(s.phase).toBe("ready");
    expect(s.room.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(s.you).toEqual(you);
    expect(s.realtime).toBe(false);
  });

  it("a guest is a guest: you = null, and the room is still readable", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you: null }));
    h.chat.start();
    await h.flush();
    expect(h.chat.getSnapshot()).toMatchObject({ phase: "ready", you: null });
  });

  it("a closed room is a calm 'closed' state with its reason — never an error, never a spinner — and it is re-checked slowly", async () => {
    const h = harness();
    h.answer({ ...pageOf([]), enabled: false, reason: "NOT_READY" });
    h.chat.start();
    await h.flush();
    expect(h.chat.getSnapshot()).toMatchObject({ phase: "closed", closedReason: "NOT_READY", you: null, live: "off" });
    expect(h.connections).toHaveLength(0);
    h.answer(pageOf([msg(1)], { you }));
    await h.advance(CLOSED_RECHECK_MS * 1.3);
    expect(h.chat.getSnapshot()).toMatchObject({ phase: "ready", closedReason: null });
  });

  it("a failed first load ends in 'error' (a retry button), not in a spinner; retrying works", async () => {
    const h = harness();
    h.answer({ ok: false, error: "TIMEOUT", status: 0 });
    h.chat.start();
    await h.flush();
    expect(h.chat.getSnapshot().phase).toBe("error");
    h.answer(pageOf([msg(1)], { you }));
    h.chat.retry();
    expect(h.chat.getSnapshot().phase).toBe("loading");
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.chat.getSnapshot()).toMatchObject({ phase: "ready" });
  });

  it("a request that THROWS is a failed request too (nothing escapes)", async () => {
    const h = harness({ fetchPage: async () => { throw new Error("boom"); } });
    h.chat.start();
    await h.flush();
    expect(h.chat.getSnapshot().phase).toBe("error");
  });
});

describe("catching up — one request at a time, never closer than 1.5 s", () => {
  it("a burst of reasons becomes ONE request now and at most one more afterwards", async () => {
    const h = harness();
    let release!: () => void;
    h.answers.push(() => new Promise((r) => { release = () => r(pageOf([msg(1)], { you })); }));
    h.chat.start();
    await h.flush();
    for (let i = 0; i < 20; i++) h.chat.requestCatchUp();
    expect(h.fetches).toHaveLength(1); // still in flight: nothing else started
    h.answer(pageOf([msg(1), msg(2)], { you }));
    release();
    await h.flush();
    expect(h.fetches).toHaveLength(1); // the burst asked for one more, but not within 1.5 s of the last
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.fetches).toHaveLength(2);
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.fetches).toHaveLength(2);
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it("the next catch-up merges: what is on screen stays, new messages join, a message hidden meanwhile leaves", async () => {
    const h = harness();
    h.answer(pageOf([msg(1), msg(2), msg(3)], { you }));
    h.chat.start();
    await h.flush();
    h.answer(pageOf([msg(1), msg(3), msg(4)], { you }));
    h.chat.requestCatchUp();
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1, 3, 4]);
  });

  it("failures back off (doubling, capped, jittered) and the messages on screen are untouched", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you }));
    h.chat.start();
    await h.flush();
    for (let i = 0; i < 5; i++) h.answer({ ok: false, error: "NETWORK", status: 0 });
    const gaps: number[] = [];
    let last = h.now();
    for (let i = 0; i < 5; i++) {
      const before = h.fetches.length;
      while (h.fetches.length === before) await h.advance(500);
      gaps.push(h.now() - last);
      last = h.now();
    }
    expect(gaps[0]!).toBeLessThanOrEqual(SLOW_SYNC_MS * 1.2 + 500); // the first scheduled catch-up is on time (and fails) …
    expect(gaps[1]!).toBeGreaterThanOrEqual(SLOW_SYNC_MS * 2 * 0.8); // … after which the interval doubles
    expect(gaps[2]!).toBeGreaterThan(gaps[1]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(121_000); // … up to two minutes, never beyond
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1]);
    expect(h.chat.getSnapshot().phase).toBe("ready");
  });

  it("before the first answer, retries are quick but controlled (0.5 s growing to 30 s) — nobody stares at 'couldn't load'", async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.answer({ ok: false, error: "NETWORK", status: 0 });
    h.chat.start();
    await h.flush();
    const gaps: number[] = [];
    let last = h.now();
    for (let i = 0; i < 5; i++) {
      const before = h.fetches.length;
      while (h.fetches.length === before) await h.advance(250);
      gaps.push(h.now() - last);
      last = h.now();
    }
    expect(gaps[0]!).toBeLessThan(5_000);
    expect(gaps[4]!).toBeGreaterThan(gaps[0]!);
    expect(gaps[4]!).toBeLessThanOrEqual(31_000);
    h.answer(pageOf([msg(1)], { you }));
    for (let i = 0; i < 80 && h.chat.getSnapshot().phase !== "ready"; i++) await h.advance(1_000);
    expect(h.chat.getSnapshot().phase).toBe("ready");
  });

  it("the slow timer: ~20 s without a live connection, ~90 s with one — and not at all while the tab is hidden", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you }));
    h.chat.start();
    await h.flush();
    const base = h.fetches.length;
    await h.advance(SLOW_SYNC_MS * 1.3);
    expect(h.fetches.length).toBe(base + 1);

    // live: the safety net is much slower
    for (let i = 0; i < 6; i++) h.answer(pageOf([msg(1)], { you, realtime: config() }));
    await h.advance(SLOW_SYNC_MS * 1.3);
    h.connections[0]!.options.onState("live");
    const live = h.fetches.length;
    await h.advance(SLOW_SYNC_MS * 2);
    expect(h.fetches.length).toBe(live);
    await h.advance(SAFETY_SYNC_MS);
    expect(h.fetches.length).toBe(live + 1);

    // hidden: the timer fires but asks for nothing …
    h.doc.visibilityState = "hidden";
    const hidden = h.fetches.length;
    await h.advance(SAFETY_SYNC_MS * 3);
    expect(h.fetches.length).toBe(hidden);
    // … and the moment the tab is seen again, one catch-up
    h.doc.visibilityState = "visible";
    h.fire("visibilitychange");
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.fetches.length).toBe(hidden + 1);
  });

  it("the network coming back and a page restored from the back/forward cache each trigger a catch-up; a normal pageshow does not", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you }));
    h.chat.start();
    await h.flush();
    await h.advance(CATCH_UP_SPACING_MS * 2);
    const n = h.fetches.length;
    h.fire("pageshow", { persisted: false } as never);
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.fetches.length).toBe(n);
    h.fire("pageshow", { persisted: true } as never);
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.fetches.length).toBe(n + 1);
    h.fire("online");
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.fetches.length).toBe(n + 2);
  });
});

describe("the live connection", () => {
  it("is created once per distinct configuration, started, and reused by later pages; a new configuration replaces it; none stops it", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you, realtime: config() }));
    h.chat.start();
    await h.flush();
    expect(h.connections).toHaveLength(1);
    expect(h.connections[0]).toMatchObject({ started: true, stopped: false });
    expect(h.chat.getSnapshot().realtime).toBe(true);
    h.answer(pageOf([msg(1)], { you, realtime: config() }));
    await h.advance(CATCH_UP_SPACING_MS * 14);
    expect(h.connections).toHaveLength(1);
    h.answer(pageOf([msg(1)], { you, realtime: config({ key: "rotated" }) }));
    await h.advance(CATCH_UP_SPACING_MS * 14);
    expect(h.connections).toHaveLength(2);
    expect(h.connections[0]!.stopped).toBe(true);
    h.answer(pageOf([msg(1)], { you, realtime: null }));
    await h.advance(CATCH_UP_SPACING_MS * 14);
    expect(h.connections[1]!.stopped).toBe(true);
    expect(h.chat.getSnapshot()).toMatchObject({ realtime: false, live: "off" });
  });

  it("verified events build the room: a message joins in order, a duplicate does nothing, a hide removes, a stale copy cannot bring it back", async () => {
    const h = harness();
    h.answer(pageOf([msg(1), msg(3)], { you, realtime: config() }));
    h.chat.start();
    await h.flush();
    const { onEvent } = h.connections[0]!.options;
    onEvent({ t: "msg", m: msg(2) });
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    const before = h.chat.getSnapshot();
    onEvent({ t: "msg", m: msg(2) });
    expect(h.chat.getSnapshot()).toBe(before); // a duplicate delivery is not even a re-render
    onEvent({ t: "hide", id: 2, rev: 1 });
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1, 3]);
    onEvent({ t: "msg", m: msg(2, { rev: 0 }) });
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1, 3]);
    onEvent({ t: "msg", m: msg(2, { rev: 2 }) });
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("joining (or re-joining) and an unverifiable broadcast each ask for a catch-up; the connection's state is the room's 'live' status", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you, realtime: config() }));
    h.chat.start();
    await h.flush();
    const { options } = h.connections[0]!;
    const seen: LiveState[] = [];
    h.chat.subscribe(() => seen.push(h.chat.getSnapshot().live));
    options.onState("connecting");
    options.onState("live");
    expect(h.chat.getSnapshot().live).toBe("live");
    const n = h.fetches.length;
    h.answer(pageOf([msg(1), msg(2)], { you, realtime: config() }));
    options.onJoined();
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.fetches.length).toBe(n + 1);
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1, 2]);
    h.answer(pageOf([msg(1), msg(2), msg(3)], { you, realtime: config() }));
    options.onHint();
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    options.onState("reconnecting");
    expect(h.chat.getSnapshot().live).toBe("reconnecting");
  });
});

describe("history", () => {
  it("scrolling up loads the page before the oldest message; one at a time; nothing when there is no more; a failure is remembered for retry", async () => {
    const h = harness();
    h.answer(pageOf([msg(21), msg(22)], { you, hasMore: true }));
    h.chat.start();
    await h.flush();
    h.answer(pageOf([msg(19), msg(20)], { hasMore: true }));
    const first = h.chat.loadOlder();
    void h.chat.loadOlder(); // the viewer scrolled again: ignored while one is in flight
    await first;
    expect(h.fetches.slice(-1)).toEqual([{ before: 21 }]);
    expect(h.fetches.filter((q) => q?.before !== undefined)).toHaveLength(1);
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([19, 20, 21, 22]);

    h.answer({ ok: false, error: "NETWORK", status: 0 });
    await h.chat.loadOlder();
    expect(h.chat.getSnapshot()).toMatchObject({ olderFailed: true, loadingOlder: false });
    expect(h.chat.getSnapshot().room.messages).toHaveLength(4);
    h.answer(pageOf([msg(17), msg(18)], { hasMore: false }));
    await h.chat.loadOlder();
    expect(h.chat.getSnapshot()).toMatchObject({ olderFailed: false });
    expect(h.chat.getSnapshot().room.hasMore).toBe(false);
    const before = h.fetches.length;
    await h.chat.loadOlder();
    expect(h.fetches.length).toBe(before);
  });
});

describe("sending", () => {
  it("an accepted message joins the room at once (the broadcast echo is a harmless duplicate) and tells the list to follow it", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you, realtime: config() }));
    h.chat.start();
    await h.flush();
    const mine = msg(2, { senderKey: you.senderKey, body: "hello" });
    h.setSend({ ok: true, message: mine, duplicate: false });
    expect(await h.chat.send("hello", "nonce-1234")).toMatchObject({ ok: true });
    expect(h.sends).toEqual([{ body: "hello", nonce: "nonce-1234" }]);
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(h.chat.getSnapshot().ownTick).toBe(1);
    h.connections[0]!.options.onEvent({ t: "msg", m: mine });
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it("a refusal changes what the composer shows: muted → cannot send; signed out → a guest; closed → the calm panel", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you }));
    h.chat.start();
    await h.flush();
    h.setSend({ ok: false, error: "MUTED", message: "no", muted: { permanent: false, until: "2026-10-08T13:00:00.000Z" }, transient: false });
    await h.chat.send("x", "nonce-1234");
    expect(h.chat.getSnapshot().you).toMatchObject({ canSend: false, muted: { permanent: false } });
    h.setSend({ ok: false, error: "UNAUTHENTICATED", message: "sign in", transient: false });
    await h.chat.send("x", "nonce-5678");
    expect(h.chat.getSnapshot().you).toBeNull();
    h.setSend({ ok: false, error: "CHAT_CLOSED", message: "closed", transient: false });
    await h.chat.send("x", "nonce-9012");
    expect(h.chat.getSnapshot().phase).toBe("closed");
    expect(h.chat.getSnapshot().room.messages.map((m) => m.id)).toEqual([1]); // history stays in memory
  });

  it("a rate-limit answer or a network failure changes nothing about the room", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you }));
    h.chat.start();
    await h.flush();
    const before = h.chat.getSnapshot();
    h.setSend({ ok: false, error: "TOO_FAST", message: "slow down", retryAfterMs: 2_000, transient: false });
    await h.chat.send("x", "nonce-1234");
    h.setSend({ ok: false, error: "NETWORK", message: "offline", transient: true });
    await h.chat.send("x", "nonce-1234");
    expect(h.chat.getSnapshot()).toBe(before);
  });
});

describe("leaving", () => {
  it("stop() ends everything: the connection, the page listeners and every timer — and nothing is fetched afterwards", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you, realtime: config() }));
    h.chat.start();
    await h.flush();
    expect(h.listenerCount()).toBeGreaterThan(0);
    h.chat.stop();
    expect(h.connections[0]!.stopped).toBe(true);
    expect(h.listenerCount()).toBe(0);
    expect(h.timers.size).toBe(0);
    const n = h.fetches.length;
    h.chat.requestCatchUp();
    await h.advance(SAFETY_SYNC_MS * 3);
    expect(h.fetches.length).toBe(n);
  });

  it("a request still in flight when the section unmounts does not touch anything afterwards", async () => {
    const h = harness();
    let release!: () => void;
    h.answers.push(() => new Promise((r) => { release = () => r(pageOf([msg(1)], { you, realtime: config() })); }));
    h.chat.start();
    await h.flush();
    h.chat.stop();
    release();
    await h.flush();
    expect(h.connections).toHaveLength(0);
    expect(h.chat.getSnapshot().phase).toBe("loading");
    expect(h.timers.size).toBe(0);
  });

  it("can be started again (a Strict-Mode remount) and starts clean", async () => {
    const h = harness();
    h.answer(pageOf([msg(1)], { you, realtime: config() }));
    h.chat.start();
    await h.flush();
    h.chat.stop();
    h.answer(pageOf([msg(1)], { you, realtime: config() }));
    h.chat.start();
    await h.advance(CATCH_UP_SPACING_MS);
    expect(h.chat.getSnapshot().phase).toBe("ready");
    expect(h.connections).toHaveLength(2);
    expect(h.connections[1]!.started).toBe(true);
  });
});
