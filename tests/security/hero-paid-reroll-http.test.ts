import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { setChainReaderForTests } from "@/server/rewards/context";
import type { SimulatedChainReader } from "@/server/rewards/chain";
import { invalidateFlagCache, resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, resetDb, seedHeroes } from "../support/db";
import { chainTokens, newChain, TOKEN, WALLET_C } from "../support/rewards";

/** The reward treasury: the shared TREASURY test constant is a RESERVED address (the config refuses it), so this suite uses an ordinary-looking one. */
const TREASURY = WALLET_C;

/**
 * THE PAID REROLL ROUTE, over real Request objects: what a browser (or an attacker with a cookie) can and cannot do.
 *   GET  /api/me/hero/reroll/paid            (status)
 *   POST /api/me/hero/reroll/paid { requestId, txHash }   (the member has paid: verify on-chain, then reroll)
 *
 * Run it on the real driver with a pool of ONE connection to prove the route never needs a second one inside a transaction:
 *   CLANK_TEST_DRIVER=postgres CLANK_TEST_POOL=1 CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5498/postgres pnpm exec vitest run tests/security/hero-paid-reroll-http.test.ts
 */
const ORIGIN = "http://localhost:3700";
const BOT_TOKEN = "123456789:AAExampleBotTokenForTestsOnly_abcdefghijk";
const ENV = {
  NODE_ENV: "test",
  SESSION_SECRET: "x".repeat(40),
  ADMIN_ACCESS_KEY: "admin-access-key-for-tests-0123456789",
  CRON_SECRET: "cron-secret-for-tests-0123456789abcd",
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: "webhook_secret_for_tests_1234567890",
  TELEGRAM_OFFICIAL_CHAT_ID: "-1001234567890",
  NEXT_PUBLIC_APP_URL: ORIGIN,
  CLANKRPG_CHAIN_ADAPTER: "simulated",
  CLANKRPG_TOKEN_ADDRESS: TOKEN,
  CLANKRPG_REWARD_TREASURY_ADDRESS: TREASURY,
};
let db: Db;
let chain: SimulatedChainReader;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.DATABASE_URL;
  resetEnvCache();
  db = await createTestDb();
  (globalThis as unknown as { __clankDb: { promise: Promise<Db> } }).__clankDb = { promise: Promise.resolve(db) };
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  resetRuntimeCaches();
  chain = newChain();
  setChainReaderForTests(chain);
});
afterEach(() => setChainReaderForTests(undefined));

type RouteFn = (req: Request, ctx?: never) => Promise<Response>;
const req = (init: { method?: string; json?: unknown; cookie?: string; origin?: string | null; body?: string; headers?: Record<string, string> } = {}) => {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  headers.set("host", "localhost:3700");
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}/api/me/hero/reroll/paid`, { method: init.method ?? "POST", headers, body: init.json !== undefined ? JSON.stringify(init.json) : (init.body ?? null) });
};
const route = async () => (await import("@/app/api/me/hero/reroll/paid/route")) as unknown as { GET: RouteFn; POST: RouteFn };
const flag = async (on: boolean) => {
  await db.query("insert into public.feature_flags (key, enabled, description) values ('hero.paid_reroll', $1, 'test') on conflict (key) do update set enabled = excluded.enabled", [on]);
  invalidateFlagCache();
};
const cookieOf = (res: Response) => (res.headers.getSetCookie().find((c) => c.startsWith("clank_session=")) ?? "").split(";")[0] ?? "";
let loginClock = Math.floor(Date.now() / 1000);
async function loginAs(telegramId: number): Promise<string> {
  const auth = await import("@/app/api/auth/telegram/route");
  const payload = signTelegramLoginPayload({ id: telegramId, first_name: "Ada", username: "ada", auth_date: ++loginClock - 1 }, BOT_TOKEN);
  const h = new Headers({ origin: ORIGIN, host: "localhost:3700", "content-type": "application/json" });
  const res = await (auth.POST as unknown as RouteFn)(new Request(`${ORIGIN}/api/auth/telegram`, { method: "POST", headers: h, body: JSON.stringify(payload) }));
  return cookieOf(res);
}
let nextWallet = 0x9000;
/** A signed-in member whose hero is claimed and has a linked wallet. */
async function member(tid: number, opts: { wallet?: boolean } = {}): Promise<{ cookie: string; hero: string; wallet: string }> {
  const [hero] = await seedHeroes(db, 1, { startId: tid });
  const cookie = await loginAs(tid);
  const claim = await import("@/app/api/me/claim/route");
  expect((await (claim.POST as unknown as RouteFn)(req({ json: {}, cookie }))).status).toBe(200);
  const wallet = `0x${(nextWallet++).toString(16).padStart(40, "0")}`;
  if (opts.wallet !== false) await db.query("insert into public.wallet_links (character_id, address, chain_id) values ($1, $2, 4663)", [hero, wallet]);
  return { cookie, hero: hero!, wallet };
}
const pay = (from: string, over: { amountRaw?: bigint; mined?: boolean } = {}, confirm = true): string => {
  const { hash } = chain.sendTransfer({ from, to: TREASURY, amountRaw: over.amountRaw ?? chainTokens(100_000), ...(over.mined === undefined ? {} : { mined: over.mined }) });
  if (confirm) chain.advance(1);
  return hash;
};
const versions = async (hero: string) => Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_versions where character_id = $1", [hero]))[0]!.n);
const uuid = () => crypto.randomUUID();

describe("the feature flag: OFF by default, and a disabled feature writes nothing", () => {
  it("the reference seed ships the flag DISABLED; a missing or off flag is DISABLED for the status and 403 PAID_REROLL_DISABLED for the POST", async () => {
    expect((await db.query<{ enabled: boolean }>("select enabled from public.feature_flags where key = 'hero.paid_reroll'"))[0]?.enabled).toBe(false);
    const { cookie, hero, wallet } = await member(5501);
    const r = await route();
    expect((await (await r.GET(req({ method: "GET", cookie }))).json()).status).toMatchObject({ state: "DISABLED", payment: null, current: null });
    const res = await r.POST(req({ json: { requestId: uuid(), txHash: pay(wallet) }, cookie }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "PAID_REROLL_DISABLED" });
    expect(await versions(hero)).toBe(1);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_paid_rerolls"))[0]!.n)).toBe(0);
  });

  it("switching the flag on opens it with the payment the wallet must send, switching it off closes it again at once", async () => {
    const { cookie } = await member(5502);
    const r = await route();
    await flag(true);
    const on = (await (await r.GET(req({ method: "GET", cookie }))).json()).status;
    expect(on).toMatchObject({ state: "AVAILABLE", price: { label: "100,000", symbol: "$CLANKRPG" }, wallet: { linked: true }, payment: { to: TOKEN, recipient: TREASURY, chainIdHex: "0x1237" } });
    expect(JSON.stringify(on)).not.toMatch(/telegram_?user_?id|privateKey|secret|seed/i);
    await flag(false);
    expect((await (await r.GET(req({ method: "GET", cookie }))).json()).status.state).toBe("DISABLED");
  });
});

describe("who may call it", () => {
  it("signed-out visitors get 401 on both verbs; a cross-site or origin-less POST is 403; garbage cookies are anonymous", async () => {
    await flag(true);
    const r = await route();
    const good = { requestId: uuid(), txHash: `0x${"ab".repeat(32)}` };
    expect((await r.GET(req({ method: "GET" }))).status).toBe(401);
    expect((await r.POST(req({ json: good }))).status).toBe(401);
    const { cookie } = await member(5503);
    expect((await r.POST(req({ json: good, cookie, origin: "https://evil.example" }))).status).toBe(403);
    expect((await r.POST(req({ json: good, cookie, origin: null }))).status).toBe(403);
    expect((await r.POST(req({ json: good, cookie: "clank_session=garbage" }))).status).toBe(401);
  });

  it("the body is STRICT: only a UUID requestId and a transaction hash — an amount, an address, a hero id, a member id or a price is refused (422), and nothing changes", async () => {
    await flag(true);
    const { cookie, hero, wallet } = await member(5504);
    const other = (await seedHeroes(db, 1, { startId: 5590 }))[0]!;
    const r = await route();
    const hash = pay(wallet);
    const good = { requestId: uuid(), txHash: hash };
    for (const body of [
      {}, { requestId: uuid() }, { txHash: hash }, { requestId: "nope", txHash: hash }, { requestId: uuid(), txHash: "0x123" }, { requestId: uuid(), txHash: 5 },
      { ...good, amount: "1" }, { ...good, price: 1 }, { ...good, payer: wallet }, { ...good, characterId: other }, { ...good, telegramUserId: 5590 }, { ...good, classId: "mage" }, { ...good, rarity: "LEGENDARY" },
    ]) {
      expect((await r.POST(req({ json: body, cookie }))).status, JSON.stringify(body)).toBe(422);
    }
    expect((await r.POST(req({ cookie, body: "not json", headers: { "content-type": "application/json" } }))).status).toBe(400);
    expect((await r.POST(req({ cookie, body: JSON.stringify(good), headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect(await versions(hero)).toBe(1);
    expect(await versions(other)).toBe(1);
  });

  it("an unclaimed hero gets 403 NOT_CLAIMED, a member whose wallet is not linked gets 409 WALLET_NOT_LINKED — nothing is recorded", async () => {
    await flag(true);
    const [hero] = await seedHeroes(db, 1, { startId: 5505 });
    const cookie = await loginAs(5505);
    const r = await route();
    expect((await (await r.GET(req({ method: "GET", cookie }))).json()).status).toMatchObject({ state: "BLOCKED", block: "NOT_CLAIMED" });
    const res = await r.POST(req({ json: { requestId: uuid(), txHash: pay("0x00000000000000000000000000000000000000aa") }, cookie }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "NOT_CLAIMED" });
    const noWallet = await member(5506, { wallet: false });
    const res2 = await r.POST(req({ json: { requestId: uuid(), txHash: pay("0x00000000000000000000000000000000000000bb") }, cookie: noWallet.cookie }));
    expect(res2.status).toBe(409);
    expect(await res2.json()).toMatchObject({ error: "WALLET_NOT_LINKED" });
    expect(await versions(hero!)).toBe(1);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_paid_rerolls"))[0]!.n)).toBe(0);
  });
});

describe("the paid reroll over HTTP", () => {
  it("a real payment rerolls the hero (no seed, no Telegram id in the answer); a replay of the hash returns the same reroll; the status then shows today's use", async () => {
    await flag(true);
    const { cookie, hero, wallet } = await member(5510);
    const r = await route();
    const hash = pay(wallet);
    const key = uuid();
    const res = await r.POST(req({ json: { requestId: key, txHash: hash }, cookie }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toMatchObject({ status: "APPLIED", result: { requestId: key, alreadyApplied: false }, payment: { txHash: hash, amountLabel: "100,000", symbol: "$CLANKRPG" } });
    expect(body.outcome.result.before.publicId).toBe(body.outcome.result.after.publicId);
    expect(JSON.stringify(body)).not.toMatch(/generationSeed|telegram_user_id|telegramUserId|nonce|"5510"/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await versions(hero)).toBe(2);

    const replay = await r.POST(req({ json: { requestId: uuid(), txHash: hash.toUpperCase().replace("0X", "0x") }, cookie }));
    expect(replay.status).toBe(200);
    expect((await replay.json()).outcome.result).toMatchObject({ alreadyApplied: true });
    expect(await versions(hero)).toBe(2);
    expect((await (await r.GET(req({ method: "GET", cookie }))).json()).status).toMatchObject({ state: "AVAILABLE", usedToday: 1 });
  });

  it("a payment that is not confirmed yet is a 200 PENDING (the browser asks again); it goes through when it is", async () => {
    await flag(true);
    const { cookie, hero, wallet } = await member(5511);
    const r = await route();
    const hash = pay(wallet, { mined: false }, false);
    const key = uuid();
    const pending = await r.POST(req({ json: { requestId: key, txHash: hash }, cookie }));
    expect(pending.status).toBe(200);
    expect((await pending.json()).outcome).toEqual({ status: "PENDING", confirmations: 0, required: 2 });
    chain.mine(hash);
    chain.advance(1);
    expect((await (await r.POST(req({ json: { requestId: key, txHash: hash }, cookie }))).json()).outcome.status).toBe("APPLIED");
    expect(await versions(hero)).toBe(2);
  });

  it("a payment that is not a payment is 422 PAYMENT_INVALID with the reason, and nothing is used", async () => {
    await flag(true);
    const { cookie, hero, wallet } = await member(5512);
    const r = await route();
    const res = await r.POST(req({ json: { requestId: uuid(), txHash: pay(wallet, { amountRaw: chainTokens(99_999) }) }, cookie }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, error: "PAYMENT_INVALID", reason: "TOO_LITTLE" });
    expect(await versions(hero)).toBe(1);
  });

  it("another member's cookie can never use someone else's payment", async () => {
    await flag(true);
    const a = await member(5520);
    const b = await member(5521);
    const r = await route();
    const hash = pay(a.wallet);
    const stolen = await r.POST(req({ json: { requestId: uuid(), txHash: hash }, cookie: b.cookie }));
    expect(stolen.status).toBe(422);
    expect(await stolen.json()).toMatchObject({ error: "PAYMENT_INVALID", reason: "WRONG_PAYER" });
    expect(await versions(b.hero)).toBe(1);
    expect((await (await r.POST(req({ json: { requestId: uuid(), txHash: hash }, cookie: a.cookie }))).json()).outcome.status).toBe("APPLIED");
    const afterwards = await r.POST(req({ json: { requestId: uuid(), txHash: hash }, cookie: b.cookie }));
    expect(afterwards.status).toBe(409);
    expect(await afterwards.json()).toMatchObject({ error: "TX_ALREADY_USED" });
  });

  it("the token not being configured is a quiet 'not available': the status says so and the POST is a 503 — the app keeps working", async () => {
    await flag(true);
    setChainReaderForTests(null);
    const { cookie, wallet } = await member(5530);
    const r = await route();
    expect((await (await r.GET(req({ method: "GET", cookie }))).json()).status).toMatchObject({ state: "UNAVAILABLE", payment: null });
    const res = await r.POST(req({ json: { requestId: uuid(), txHash: `0x${"cd".repeat(32)}` }, cookie }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "PAID_REROLL_UNAVAILABLE" });
    void wallet;
  });
});
