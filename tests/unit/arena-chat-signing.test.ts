import { describe, expect, it } from "vitest";

import { readEnvelope, readEvent } from "@/domain/chat/envelope";
import { CHAT_EVENT, CHAT_TOPIC } from "@/domain/chat/limits";
import type { ChatEnvelope, ChatMessageDto } from "@/domain/chat/types";
import { createRestBroadcaster } from "@/server/chat/broadcast";
import { chatRealtimeConfig, realtimeSocketUrl } from "@/server/chat/runtime";
import { createChatSigner } from "@/server/chat/signing";
import { getEnv } from "@/server/env";

import { verifyEnvelope } from "@/components/arena/chat/verify";

const message: ChatMessageDto = { id: 7, at: "2026-10-08T12:00:00.000Z", name: "Markyyester", avatarUrl: null, senderKey: "abcdefghijklmnop", body: "hello", rev: 0 };

describe("the signer — what makes a broadcast trustworthy", () => {
  const signer = createChatSigner("a-long-enough-session-secret-0123456789");

  it("derives the same keys from the same secret, different keys from another, and a public key of 32 raw bytes", () => {
    expect(createChatSigner("a-long-enough-session-secret-0123456789").publicKey).toBe(signer.publicKey);
    expect(createChatSigner("another-session-secret-0123456789-abcdef").publicKey).not.toBe(signer.publicKey);
    expect(Buffer.from(signer.publicKey, "base64url")).toHaveLength(32);
    expect(signer.publicKey).not.toContain("a-long-enough"); // the key is derived, never the secret
  });

  it("seals an event into an envelope whose signature verifies — and only that exact text", () => {
    const env = signer.seal({ t: "msg", m: message });
    expect(env.v).toBe(1);
    expect(readEnvelope(env)).toEqual(env);
    expect(signer.verify(env)).toBe(true);
    expect(readEvent(env.j)).toEqual({ t: "msg", m: message });
    // one changed character, a swapped signature, another server's signature: all refused
    expect(signer.verify({ ...env, j: env.j.replace("hello", "hell0") })).toBe(false);
    const other = createChatSigner("another-session-secret-0123456789-abcdef").seal({ t: "msg", m: message });
    expect(signer.verify({ ...env, s: other.s })).toBe(false);
    expect(signer.verify(other)).toBe(false);
  });

  it("is verifiable by the BROWSER's code path (WebCrypto Ed25519 over the raw public key) — and that path rejects forgeries", async () => {
    const env = signer.seal({ t: "hide", id: 9, rev: 1 });
    expect(await verifyEnvelope(env, signer.publicKey)).toBe("ok");
    expect(await verifyEnvelope({ ...env, j: JSON.stringify({ t: "hide", id: 10, rev: 1 }) }, signer.publicKey)).toBe("forged");
    const attacker = createChatSigner("an-attackers-own-secret-0123456789-abcd");
    const forged: ChatEnvelope = attacker.seal({ t: "msg", m: { ...message, name: "Admin", body: "Send me your seed phrase" } });
    expect(await verifyEnvelope(forged, signer.publicKey)).toBe("forged");
    expect(await verifyEnvelope(env, "not-a-key")).toBe("unverifiable");
  });

  it("senderKey is stable per member, different between members, short, opaque — and never contains the id", () => {
    expect(signer.senderKey(123456789)).toBe(signer.senderKey(123456789));
    expect(signer.senderKey(123456789)).not.toBe(signer.senderKey(123456790));
    expect(signer.senderKey(123456789)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(signer.senderKey(123456789)).not.toContain("123456789");
    expect(createChatSigner("another-session-secret-0123456789-abcdef").senderKey(123456789)).not.toBe(signer.senderKey(123456789));
  });
});

describe("the REST broadcaster — handing a committed event to Supabase Realtime", () => {
  const env: ChatEnvelope = { v: 1, j: "{}", s: "A".repeat(86) };
  const make = (impl: typeof fetch, extra: Partial<Parameters<typeof createRestBroadcaster>[0]> = {}) => createRestBroadcaster({ url: "https://proj.supabase.co/", key: "service-role-key-0123456789", fetch: impl, log: () => undefined, ...extra });

  it("POSTs one private broadcast to the Realtime REST endpoint with the service key, and reports success on 2xx", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const b = make((async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch);
    expect(await b.publish(env)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://proj.supabase.co/realtime/v1/api/broadcast");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.apikey).toBe("service-role-key-0123456789");
    expect(headers.authorization).toBeUndefined(); // a new-style secret key is not a JWT: apikey only
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ messages: [{ topic: CHAT_TOPIC, event: CHAT_EVENT, payload: env, private: true }] });
  });

  it("a legacy service_role key (a JWT) is also sent as the bearer token", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature-part-0123456789";
    const seen: Array<Record<string, string>> = [];
    const b = createRestBroadcaster({ url: "https://proj.supabase.co", key: jwt, log: () => undefined, fetch: (async (_u: string, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return new Response(null, { status: 202 }); }) as unknown as typeof fetch });
    expect(await b.publish(env)).toBe(true);
    expect(seen[0]).toMatchObject({ apikey: jwt, authorization: `Bearer ${jwt}` });
  });

  it("never throws: an error status, a network error and a timeout are all just 'false'", async () => {
    expect(await make((async () => new Response("no", { status: 500 })) as unknown as typeof fetch).publish(env)).toBe(false);
    expect(await make((async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch).publish(env)).toBe(false);
    const hang = (async (_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const started = Date.now();
    expect(await make(hang, { timeoutMs: 40 }).publish(env)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("opens a circuit after repeated failures (no more waiting on a dead Realtime) and closes it after the pause", async () => {
    let calls = 0;
    let now = 1_000;
    const logs: string[] = [];
    const b = make((async () => { calls++; throw new Error("down"); }) as unknown as typeof fetch, { failuresToOpen: 3, openMs: 30_000, now: () => now, log: (m) => logs.push(m) });
    for (let i = 0; i < 3; i++) await b.publish(env);
    expect(calls).toBe(3);
    expect(logs).toHaveLength(1);
    for (let i = 0; i < 10; i++) expect(await b.publish(env)).toBe(false);
    expect(calls).toBe(3); // skipped while open
    now += 30_001;
    await b.publish(env);
    expect(calls).toBe(4); // tried again
  });

  it("a success resets the count, so scattered failures never open the circuit", async () => {
    let n = 0;
    let calls = 0;
    const b = make((async () => { calls++; if (++n % 3 !== 0) throw new Error("flaky"); return new Response(null, { status: 202 }); }) as unknown as typeof fetch, { failuresToOpen: 3 });
    for (let i = 0; i < 12; i++) await b.publish(env);
    expect(calls).toBe(12);
  });
});

describe("what the browser is told about live delivery", () => {
  const base = { NODE_ENV: "test", SESSION_SECRET: "x".repeat(40) };
  const signer = createChatSigner("x".repeat(40));

  it("converts the project URL to the Realtime socket URL", () => {
    expect(realtimeSocketUrl("https://abc.supabase.co")).toBe("wss://abc.supabase.co/realtime/v1");
    expect(realtimeSocketUrl("https://abc.supabase.co/")).toBe("wss://abc.supabase.co/realtime/v1");
    expect(realtimeSocketUrl("http://127.0.0.1:54321")).toBe("ws://127.0.0.1:54321/realtime/v1");
  });

  it("offers live delivery only when BOTH the browser side (url + publishable key) and the server side (url + service key) are configured", () => {
    const cfg = (e: Record<string, string>) => chatRealtimeConfig(getEnv({ ...base, ...e } as NodeJS.ProcessEnv), signer);
    const full = { NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_0123456789abcdef", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789" };
    expect(cfg(full)).toEqual({ url: "wss://abc.supabase.co/realtime/v1", key: "sb_publishable_0123456789abcdef", topic: CHAT_TOPIC, event: CHAT_EVENT, verifyKey: signer.publicKey });
    expect(cfg({})).toBeNull();
    expect(cfg({ ...full, SUPABASE_SERVICE_ROLE_KEY: "" })).toBeNull(); // nothing would ever be broadcast: do not promise "live"
    expect(cfg({ ...full, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" })).toBeNull();
    expect(cfg({ ...full, NEXT_PUBLIC_SUPABASE_URL: "" })?.url).toBe("wss://abc.supabase.co/realtime/v1"); // falls back to SUPABASE_URL
    expect(JSON.stringify(cfg(full))).not.toContain("service-role");
    // a mistyped value switches live delivery off — it never stops the app (getEnv does not throw) and never leaks into the config
    expect(cfg({ ...full, NEXT_PUBLIC_SUPABASE_URL: "not a url" })?.url).toBe("wss://abc.supabase.co/realtime/v1"); // falls back to the project URL
    expect(cfg({ ...full, CHAT_REALTIME_URL: "nope" })?.url).toBe("wss://abc.supabase.co/realtime/v1");
    expect(cfg({ ...full, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "short" })).toBeNull();
    expect(cfg({ ...full, SUPABASE_URL: "ftp://x.test" })).toBeNull();
  });
});
