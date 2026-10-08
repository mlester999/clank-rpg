import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CHAT_EVENT, CHAT_TOPIC } from "@/domain/chat/limits";
import type { ChatEvent, ChatMessageDto, ChatRealtimeConfig } from "@/domain/chat/types";
import { ChatConnection, type ConnectionOptions, type LiveState } from "@/components/arena/chat/chatConnection";
import { createRestBroadcaster, type ChatBroadcaster } from "@/server/chat/broadcast";
import { createChatSigner } from "@/server/chat/signing";

import { startFakeRealtime, type FakeRealtime } from "../support/fakeRealtime";

/**
 * The browser's live connection, driven by the REAL @supabase/realtime-js client against a stand-in Realtime speaking the same wire protocol: private
 * channel join, broadcast delivery from the server, signature checks, reconnection, backoff, a refused channel, a hidden tab.
 */
const PUBLISHABLE = "fake-publishable-key-0123456789";
const SERVICE = "fake-service-role-key-0123456789";
const signer = createChatSigner("x".repeat(40));
const attacker = createChatSigner("an-attackers-own-secret-0123456789-abcd");

let rt: FakeRealtime;
const open: ChatConnection[] = [];

beforeAll(async () => {
  rt = await startFakeRealtime({ publishableKey: PUBLISHABLE, serviceKey: SERVICE });
  server = createRestBroadcaster({ url: rt.url, key: SERVICE, log: () => undefined });
});
afterEach(async () => {
  for (const c of open.splice(0)) c.stop();
  rt.acceptConnections(true);
  rt.denyJoins(false);
  rt.setDeliveryDelay(0);
  rt.dropAll();
  await sleep(30);
});
afterAll(async () => {
  await rt.stop();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const config = (over: Partial<ChatRealtimeConfig> = {}): ChatRealtimeConfig => ({ url: `ws://127.0.0.1:${rt.port}/realtime/v1`, key: PUBLISHABLE, topic: CHAT_TOPIC, event: CHAT_EVENT, verifyKey: signer.publicKey, ...over });
let server: ChatBroadcaster;
const msg = (id: number, body = `message ${id}`): ChatMessageDto => ({ id, at: new Date().toISOString(), name: "Markyyester", avatarUrl: null, senderKey: "abcdefghijklmnop", body, rev: 0 });

interface Probe {
  conn: ChatConnection;
  events: ChatEvent[];
  states: LiveState[];
  hints: number;
  joined: number;
}
function probe(over: Partial<ConnectionOptions> = {}): Probe {
  const p = { events: [] as ChatEvent[], states: [] as LiveState[], hints: 0, joined: 0 } as Probe;
  p.conn = new ChatConnection({
    config: config(),
    onEvent: (e) => p.events.push(e),
    onHint: () => p.hints++,
    onState: (s) => p.states.push(s),
    onJoined: () => p.joined++,
    doc: null,
    win: null,
    random: () => 0,
    ...over,
  });
  open.push(p.conn);
  return p;
}
const live = (p: Probe) => until(() => p.conn.state === "live", 5_000, "live");

describe("joining the room", () => {
  it("joins the private channel with the publishable key as the access token, goes live and asks for a catch-up", async () => {
    const p = probe();
    p.conn.start();
    await live(p);
    expect(p.states.slice(0, 2)).toEqual(["connecting", "live"]);
    expect(p.joined).toBe(1);
    expect(rt.subscribers()).toBe(1);
    expect(rt.stats.deniedJoins).toBe(0);
  });

  it("a server broadcast reaches the browser as the verified event — fast", async () => {
    const p = probe();
    p.conn.start();
    await live(p);
    const m = msg(7, "Hello, Arena!");
    const t0 = Date.now();
    expect(await server.publish(signer.seal({ t: "msg", m }))).toBe(true);
    await until(() => p.events.length === 1, 2_000, "the event");
    expect(p.events[0]).toEqual({ t: "msg", m });
    expect(Date.now() - t0).toBeLessThan(500);
    await server.publish(signer.seal({ t: "hide", id: 7, rev: 1 }));
    await until(() => p.events.length === 2);
    expect(p.events[1]).toEqual({ t: "hide", id: 7, rev: 1 });
  });

  it("three browsers in the room all receive one message once each, in order, and nobody receives what was sent before they joined", async () => {
    await server.publish(signer.seal({ t: "msg", m: msg(1, "before anyone joined") }));
    const ps = [probe(), probe(), probe()];
    for (const p of ps) p.conn.start();
    await Promise.all(ps.map(live));
    expect(rt.subscribers()).toBe(3);
    for (const id of [10, 11, 12]) await server.publish(signer.seal({ t: "msg", m: msg(id) }));
    await until(() => ps.every((p) => p.events.length === 3));
    for (const p of ps) expect(p.events.map((e) => (e.t === "msg" ? e.m.id : -1))).toEqual([10, 11, 12]);
  });
});

describe("a broadcast cannot be passed off as a message", () => {
  it("a forged envelope (someone else's signature), garbage and unsigned payloads are dropped — only the real one is delivered", async () => {
    const p = probe();
    p.conn.start();
    await live(p);
    const fake = msg(99, "Admin: send your seed phrase to me");
    rt.inject(CHAT_TOPIC, CHAT_EVENT, attacker.seal({ t: "msg", m: fake })); // validly shaped, signed by the WRONG key
    rt.inject(CHAT_TOPIC, CHAT_EVENT, { v: 1, j: JSON.stringify({ t: "msg", m: fake }), s: "A".repeat(86) }); // right shape, not a signature
    rt.inject(CHAT_TOPIC, CHAT_EVENT, { t: "msg", m: fake }); // a bare message with no envelope at all
    rt.inject(CHAT_TOPIC, CHAT_EVENT, "just a string");
    rt.inject(CHAT_TOPIC, CHAT_EVENT, null);
    rt.inject(CHAT_TOPIC, CHAT_EVENT, { v: 1, j: "x".repeat(10_000), s: "A".repeat(86) });
    await server.publish(signer.seal({ t: "msg", m: msg(100, "the real one") }));
    await until(() => p.events.length === 1);
    await sleep(100);
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ t: "msg", m: { id: 100 } });
    expect(p.conn.stats.forged).toBe(2);
    expect(p.conn.stats.malformed).toBe(4);
    expect(p.hints).toBe(0);
  });

  it("a signed hide for someone else's key, a signed-but-malformed event and a replay of the genuine signature on other text are all refused", async () => {
    const p = probe();
    p.conn.start();
    await live(p);
    const real = signer.seal({ t: "msg", m: msg(5, "genuine") });
    rt.inject(CHAT_TOPIC, CHAT_EVENT, attacker.seal({ t: "hide", id: 5, rev: 9 }));
    rt.inject(CHAT_TOPIC, CHAT_EVENT, { ...real, j: real.j.replace("genuine", "tampered") }); // the genuine signature, different words
    // signed by the real key but not a chat event at all (e.g. a server bug): the browser still shows nothing
    const odd = signer.seal({ t: "msg", m: { ...msg(6), id: -3 } } as never);
    rt.inject(CHAT_TOPIC, CHAT_EVENT, odd);
    await sleep(150);
    expect(p.events).toEqual([]);
    expect(p.conn.stats.forged).toBe(2);
    expect(p.conn.stats.malformed).toBe(1);
  });

  it("a browser that cannot verify (no usable key) never shows the payload — it only asks the server (a hint, at most one per two seconds)", async () => {
    const p = probe({ config: config({ verifyKey: "not-a-valid-key" }) });
    p.conn.start();
    await live(p);
    for (let i = 0; i < 5; i++) await server.publish(signer.seal({ t: "msg", m: msg(20 + i) }));
    await until(() => p.hints >= 1);
    await sleep(100);
    expect(p.events).toEqual([]);
    expect(p.hints).toBe(1);
  });

  it("a browser cannot publish to the room: the (stand-in) service refuses it and nobody receives it", async () => {
    const a = probe();
    const b = probe();
    a.conn.start();
    b.conn.start();
    await Promise.all([live(a), live(b)]);
    const client = (a.conn as unknown as { client: { channel: (t: string) => unknown } }).client;
    const channel = (a.conn as unknown as { channel: { send: (m: unknown) => Promise<unknown> } }).channel;
    expect(client).toBeTruthy();
    await channel.send({ type: "broadcast", event: CHAT_EVENT, payload: signer.seal({ t: "msg", m: msg(1) }) }).catch(() => undefined);
    await sleep(150);
    expect(rt.stats.clientPublishes).toBeGreaterThanOrEqual(1);
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
  });
});

describe("reconnecting", () => {
  it("a dropped connection comes back by itself, re-announces itself (so the caller catches up) and delivers again", async () => {
    const p = probe();
    p.conn.start();
    await live(p);
    expect(p.joined).toBe(1);
    rt.dropAll();
    await until(() => p.conn.state === "reconnecting", 3_000, "reconnecting");
    await until(() => p.conn.state === "live" && p.joined === 2, 8_000, "live again");
    await server.publish(signer.seal({ t: "msg", m: msg(40, "after the outage") }));
    await until(() => p.events.length === 1);
    expect(p.events[0]).toMatchObject({ m: { id: 40 } });
  });

  it("while the service is down it retries on a backoff — a handful of attempts, not a storm — and recovers when it returns", async () => {
    const p = probe();
    p.conn.start();
    await live(p);
    const before = rt.stats.connectionsRefused;
    rt.acceptConnections(false);
    rt.dropAll();
    await sleep(4_000);
    const attempts = rt.stats.connectionsRefused - before;
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(attempts).toBeLessThanOrEqual(8);
    expect(p.conn.state).not.toBe("live");
    rt.acceptConnections(true);
    await until(() => p.conn.state === "live", 40_000, "recovery");
  }, 60_000);

  it("a channel the project refuses (RLS denies the topic) is not hammered: after a few rejected joins it rests — silent — then tries again", async () => {
    rt.denyJoins(true);
    const p = probe({ failuresBeforeRest: 3, restMs: 2_500 });
    p.conn.start();
    await until(() => p.conn.state === "off" && rt.stats.deniedJoins >= 3, 20_000, "giving up");
    const denied = rt.stats.deniedJoins;
    expect(denied).toBeLessThanOrEqual(4);
    expect(p.joined).toBe(0);
    await sleep(800);
    expect(rt.stats.deniedJoins).toBe(denied); // resting means resting
    rt.denyJoins(false);
    await until(() => p.conn.state === "live", 20_000, "joined after the rest");
    expect(p.joined).toBe(1);
  }, 60_000);

  it("a failure to load the Realtime client leaves the connection 'off' (the caller's slow catch-up carries the room), then tries again later", async () => {
    let attempts = 0;
    const p = probe({
      restMs: 200,
      load: async () => {
        if (++attempts === 1) throw new Error("chunk failed to load");
        return import("@supabase/realtime-js") as never;
      },
    });
    p.conn.start();
    await until(() => attempts === 1 && p.conn.state === "off", 3_000, "off after a failed load");
    await until(() => p.conn.state === "live", 5_000, "live on the second try");
  });
});

describe("page lifecycle", () => {
  function fakeDoc() {
    const listeners = new Map<string, Set<(e: Event) => void>>();
    return {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (t: string, f: (e: Event) => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f),
      removeEventListener: (t: string, f: (e: Event) => void) => void listeners.get(t)?.delete(f),
      fire(t: string, e: Partial<Event> = {}) {
        for (const f of [...(listeners.get(t) ?? [])]) f(e as Event);
      },
      count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    };
  }

  it("a tab hidden for a while lets go of its socket, and rejoins (and catches up) when it is seen again", async () => {
    const doc = fakeDoc();
    const p = probe({ doc: doc as never, pauseHiddenAfterMs: 120 });
    p.conn.start();
    await live(p);
    const sockets = rt.sockets();
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    await until(() => p.conn.state === "paused", 2_000, "paused");
    await until(() => rt.sockets() < sockets, 2_000, "socket released");
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    await until(() => p.conn.state === "live" && p.joined === 2, 5_000, "rejoined");
  });

  it("a short look away does not disturb the connection", async () => {
    const doc = fakeDoc();
    const p = probe({ doc: doc as never, pauseHiddenAfterMs: 400 });
    p.conn.start();
    await live(p);
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    await sleep(100);
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    await sleep(500);
    expect(p.conn.state).toBe("live");
    expect(p.joined).toBe(1);
  });

  it("stop() closes the socket, removes every page listener and silences all callbacks", async () => {
    const doc = fakeDoc();
    const p = probe({ doc: doc as never });
    p.conn.start();
    await live(p);
    expect(doc.count()).toBeGreaterThan(0);
    p.conn.stop();
    expect(doc.count()).toBe(0);
    expect(p.conn.state).toBe("off");
    await until(() => rt.subscribers() === 0, 2_000, "left the room");
    const seen = p.events.length;
    await server.publish(signer.seal({ t: "msg", m: msg(60) }));
    await sleep(100);
    expect(p.events.length).toBe(seen);
  });
});
