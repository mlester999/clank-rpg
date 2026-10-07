import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signSession, newSession, USER_SESSION_COOKIE } from "@/server/auth/session";
import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { privateKeyToAccount } from "viem/accounts";

import type { SimulatedChainReader } from "@/server/rewards/chain";
import { setChainReaderForTests } from "@/server/rewards/context";
import { resetRewardsReadyCache } from "@/server/rewards/pool";
import { finalizePeriod } from "@/server/rewards/leaderboard";
import { settleBattleRewards } from "@/server/rewards/settlement";
import { resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, resetDb, seedEligibleMember, seedHeroes } from "../support/db";
import { balanceOf, CHAIN_ID, credit, loser, newChain, pickAs, seedScores, settingsWith, stageNext, TOKEN, tokens, WALLET_A, WALLET_B, chainTokens } from "../support/rewards";
import { finishBattle, stageBattle } from "../support/stage";

/** HTTP-level guarantees of Arena Picks rewards: who may do what, what the browser can and cannot say, and what is (not) exposed. */

const ORIGIN = "http://localhost:3700";
const BOT_TOKEN = "123456789:AAExampleBotTokenForTestsOnly_abcdefghijk";
const TREASURY_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ENV: Record<string, string> = {
  NODE_ENV: "test",
  SESSION_SECRET: "x".repeat(40),
  ADMIN_ACCESS_KEY: "admin-access-key-for-tests-0123456789",
  CRON_SECRET: "cron-secret-for-tests-0123456789abcd",
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: "webhook_secret_for_tests_1234567890",
  TELEGRAM_OFFICIAL_CHAT_ID: "-1001234567890",
  CLANK_DEV_LOGIN: "true",
  NEXT_PUBLIC_APP_URL: ORIGIN,
  CLANKRPG_CHAIN_ADAPTER: "simulated",
  // A RETIRED secret: the app never uses a signing key. If one is still in the environment it must never leak anywhere.
  CLANKRPG_REWARD_TREASURY_PRIVATE_KEY: TREASURY_KEY,
};

let db: Db;
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
  setChainReaderForTests(undefined);
  resetEnvCache();
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  resetRuntimeCaches();
  resetRewardsReadyCache();
  chain = newChain();
  setChainReaderForTests(chain); // a read-only simulated chain: balances + transfers an "admin" made by hand
  process.env.CLANKRPG_CHAIN_ADAPTER = "simulated";
  resetEnvCache();
});

let chain: SimulatedChainReader;

type RouteFn = (req: Request, ctx?: unknown) => Promise<Response>;
const req = (path: string, init: { method?: string; origin?: string | null; json?: unknown; cookie?: string } = {}) => {
  const headers = new Headers();
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  headers.set("host", "localhost:3700");
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers, body: init.json !== undefined ? JSON.stringify(init.json) : null });
};
const call = (fn: unknown, r: Request, ctx?: unknown) => (fn as RouteFn)(r, ctx);
const rewardsRoute = () => import("@/app/api/me/rewards/route");
const claimRoute = () => import("@/app/api/me/rewards/claim/route");
const picksRoute = () => import("@/app/api/arena/picks/route");

/** A signed session for an (eligible by default) member, optionally issued in the past. */
async function session(telegramId: number, opts: { issuedMsAgo?: number; eligible?: boolean } = {}): Promise<string> {
  if (opts.eligible !== false) await seedEligibleMember(db, { id: telegramId });
  else await db.query("insert into public.telegram_users (telegram_user_id, display_name) values ($1, 'Newbie') on conflict do nothing", [telegramId]);
  const [row] = await db.query<{ session_epoch: number }>("select session_epoch from public.telegram_users where telegram_user_id = $1", [telegramId]);
  const payload = newSession("user", telegramId, row!.session_epoch, 3600 * 24 * 14, Date.now() - (opts.issuedMsAgo ?? 0));
  return `${USER_SESSION_COOKIE}=${encodeURIComponent(signSession(payload, ENV.SESSION_SECRET as string))}`;
}
let keyN = 0;
const key = () => `http-claim-key-${++keyN}-${Math.random().toString(36).slice(2, 8)}`;
const claim = async (cookie: string | undefined, json: unknown) => call((await claimRoute()).POST, req("/api/me/rewards/claim", { json, ...(cookie ? { cookie } : {}) }));

// --- admin helpers -----------------------------------------------------------------------------------------------------
const adminRoute = () => import("@/app/api/admin/[...path]/route");
let adminCookieCache = "";
async function adminCookie(): Promise<string> {
  if (adminCookieCache) return adminCookieCache;
  const r = await (await adminRoute()).POST(req("/api/admin/session", { json: { key: ENV.ADMIN_ACCESS_KEY } }), { params: Promise.resolve({ path: ["session"] }) });
  adminCookieCache = (r.headers.getSetCookie().find((c) => c.startsWith("clank_admin=")) ?? "").split(";")[0] ?? "";
  return adminCookieCache;
}
const admin = async (method: "GET" | "POST" | "PUT" | "DELETE", path: string, init: { json?: unknown; cookie?: string | null } = {}) => {
  const segs = path.split("?")[0]!.split("/");
  const cookie = init.cookie === null ? undefined : (init.cookie ?? (await adminCookie()));
  const handler = (await adminRoute())[method] as unknown as (r: Request, c: unknown) => Promise<Response>;
  return handler(req(`/api/admin/${path}`, { method, ...(init.json !== undefined ? { json: init.json } : {}), ...(cookie ? { cookie } : {}) }), { params: Promise.resolve({ path: segs }) });
};
const summary = async (cookie: string) => (await call((await rewardsRoute()).GET, req("/api/me/rewards", { method: "GET", cookie }))).json();

describe("identity: Telegram is the account", () => {
  it("every reward endpoint is closed without a signed-in session", async () => {
    expect((await call((await rewardsRoute()).GET, req("/api/me/rewards", { method: "GET" }))).status).toBe(401);
    expect((await claim(undefined, { idempotencyKey: key() })).status).toBe(401);
    const picks = await picksRoute();
    expect((await call(picks.POST, req("/api/arena/picks", { json: { battleId: "00000000-0000-4000-8000-000000000000", characterId: "00000000-0000-4000-8000-000000000001" } }))).status).toBe(401);
  });

  it("a forged or tampered session cookie is not a session", async () => {
    await seedEligibleMember(db, { id: 4001 });
    const good = await session(4001);
    const tampered = good.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await call((await rewardsRoute()).GET, req("/api/me/rewards", { method: "GET", cookie: tampered }))).status).toBe(401);
    const wrongSecret = `${USER_SESSION_COOKIE}=${encodeURIComponent(signSession(newSession("user", 4001, 0, 3600), "y".repeat(40)))}`;
    expect((await call((await rewardsRoute()).GET, req("/api/me/rewards", { method: "GET", cookie: wrongSecret }))).status).toBe(401);
  });

  it("cross-site requests are refused (CSRF): a different Origin cannot create a claim", async () => {
    const cookie = await session(4002);
    await credit(db, 4002, tokens(20_000));
    const evil = "https://evil.example";
    const body = { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A };
    expect((await call((await claimRoute()).POST, req("/api/me/rewards/claim", { json: body, cookie, origin: evil }))).status).toBe(403);
    expect((await call((await claimRoute()).POST, req("/api/me/rewards/claim", { json: body, cookie, origin: null }))).status).toBe(403);
    expect(await balanceOf(db, 4002)).toMatchObject({ claimable: tokens(20_000), reserved: 0n });
  });

  it("the member is ALWAYS the session's Telegram id: a body-supplied identity, amount, recipient or status is refused outright", async () => {
    const a = await session(4010);
    await session(4011);
    await credit(db, 4010, tokens(20_000));
    await credit(db, 4011, tokens(20_000));
    const base = { destination: "CUSTOM", address: WALLET_A };
    const forgeries = [{ telegramUserId: 4011 }, { userId: 4011 }, { amount: "99999" }, { amountRaw: "1" }, { payout: "99999" }, { claimable: "99999" }, { claimId: "x" }, { recipient: WALLET_B }, { wallet: WALLET_B }, { status: "SENT" }, { txHash: `0x${"a".repeat(64)}` }, { destinationKind: "HOLDER_WALLET" }, { walletAddress: WALLET_B }];
    for (const [i, forged] of forgeries.entries()) {
      const who = i < 6 ? a : await session(4600 + i); // the claim endpoint is rate-limited per member: spread the attempts
      const r = await claim(who, { ...base, ...forged, idempotencyKey: key() });
      expect(r.status, JSON.stringify(forged)).toBe(422);
    }
    // the HOLDER_WALLET variant takes no address at all; CUSTOM requires one; the retired pasted-wallet body is not accepted
    const c = await session(4012);
    expect((await claim(c, { destination: "HOLDER_WALLET", address: WALLET_A, idempotencyKey: key() })).status).toBe(422);
    expect((await claim(c, { destination: "CUSTOM", idempotencyKey: key() })).status).toBe(422);
    expect((await claim(c, { destination: "ELSEWHERE", address: WALLET_A, idempotencyKey: key() })).status).toBe(422);
    expect((await claim(c, { idempotencyKey: key(), walletAddress: WALLET_A })).status).toBe(422);
    expect(await db.query("select 1 from public.arena_reward_claims")).toHaveLength(0);
    expect(await balanceOf(db, 4010)).toMatchObject({ claimable: tokens(20_000), reserved: 0n });
    expect(await balanceOf(db, 4011)).toMatchObject({ claimable: tokens(20_000), reserved: 0n });
  });

  it("the pasted-reward-wallet endpoint is gone: payout destinations are per-claim and holder wallets only change by SIGNATURE", async () => {
    // @ts-expect-error — the route no longer exists (payout destinations are per-claim; holder wallets change only by signature)
    await expect(import("@/app/api/me/rewards/wallet/route")).rejects.toThrow();
  });
});

describe("claiming over HTTP: a MANUAL payout request (nothing is ever sent by the app)", () => {
  it("a FREE member with no wallet enters a destination: the whole balance is reserved as ONE PENDING request, the amount never comes from the browser", async () => {
    const cookie = await session(4030);
    await credit(db, 4030, tokens(42_500));
    expect((await claim(cookie, { idempotencyKey: key(), destination: "HOLDER_WALLET" })).status).toBe(422); // no holder wallet → asked for an address
    const res = await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claim).toMatchObject({ status: "PENDING", amount: "42,500", destinationKind: "CUSTOM" });
    expect(JSON.stringify(body)).not.toContain(WALLET_A); // no full address is echoed
    const s = (await summary(cookie)).rewards;
    expect(s).toMatchObject({ claimable: "0", pending: "42,500", totalEarned: "42,500", claimed: "0", symbol: "$CLANKRPG", claimsNote: "PENDING" });
    expect(s.pendingClaim).toMatchObject({ status: "PENDING", amount: "42,500", destination: "0x5290…9ee7", destinationKind: "CUSTOM", txHash: null });
    expect(s.claimHistory).toHaveLength(1);
    expect(JSON.stringify(s)).not.toContain(WALLET_A); // the summary carries only the SHORT destination
    expect(chain.transferLookups).toBe(0); // the chain was never even asked: nothing is sent
  });

  it("a double-click / refresh (same key) returns the same request; a new key while one is pending is refused politely", async () => {
    const cookie = await session(4031);
    await credit(db, 4031, tokens(20_000));
    const k = key();
    const first = await (await claim(cookie, { idempotencyKey: k, destination: "CUSTOM", address: WALLET_A })).json();
    const again = await claim(cookie, { idempotencyKey: k, destination: "CUSTOM", address: WALLET_A });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ replayed: true, claim: { id: first.claim.id } });
    await credit(db, 4031, tokens(15_000));
    const blocked = await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_B });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "CLAIM_IN_PROGRESS", message: "You already have a claim waiting to be paid." });
    expect(await db.query("select 1 from public.arena_reward_claims")).toHaveLength(1);
  });

  it("below the minimum: refused, the reward keeps accumulating, and no destination is recorded", async () => {
    const cookie = await session(4032);
    await credit(db, 4032, tokens(7_500));
    const res = await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "BELOW_MINIMUM" });
    expect(await balanceOf(db, 4032)).toMatchObject({ claimable: tokens(7_500) });
    expect((await summary(cookie)).rewards).toMatchObject({ claimable: "7,500", minimumClaim: "10,000", belowMinimum: true, claimsNote: "BELOW_MINIMUM" });
    expect(await db.query("select 1 from public.arena_reward_claims")).toEqual([]);
  });

  it("malformed / zero / burn addresses are refused with a clear message", async () => {
    const cookie = await session(4033);
    await credit(db, 4033, tokens(20_000));
    for (const bad of ["0x1234", "0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD", "not an address at all, really not", "0x52908400098527886E0F7030069857D2E4169ee7"]) {
      const res = await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: bad });
      expect(res.status, bad).toBe(422);
      expect(["INVALID_INPUT", "INVALID_WALLET"], bad).toContain((await res.json()).error);
    }
    expect(await balanceOf(db, 4033)).toMatchObject({ claimable: tokens(20_000), reserved: 0n });
  });

  it("with the token UNAVAILABLE the member is told their rewards are safe — and nothing is lost", async () => {
    setChainReaderForTests(null);
    const cookie = await session(4034);
    await credit(db, 4034, tokens(20_000));
    const res = await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "CLAIMS_UNAVAILABLE", message: "Claims are temporarily unavailable. Your rewards are safe and will continue accumulating." });
    expect(await balanceOf(db, 4034)).toMatchObject({ claimable: tokens(20_000), reserved: 0n });
    expect((await summary(cookie)).rewards).toMatchObject({ claimable: "20,000", claimsAvailable: false, claimsNote: "UNAVAILABLE" });
  });

  it("a member who is under review keeps earning; claims are on hold with a generic message (no internal reason leaks)", async () => {
    const cookie = await session(4035);
    await credit(db, 4035, tokens(20_000));
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state, review_reason) values (4035, 'REVIEW', 'bot-like timing on 9 battles') on conflict (telegram_user_id) do update set review_state = 'REVIEW', review_reason = 'bot-like timing on 9 battles'");
    const res = await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A });
    expect(res.status).toBe(409);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("CLAIMS_HELD");
    expect(text).not.toMatch(/bot-like|REVIEW|review_reason|timing/i);
    expect(JSON.stringify(await summary(cookie))).not.toMatch(/bot-like|review_reason|reviewState/i);
  });

  it("rate limits repeated claim attempts", async () => {
    const cookie = await session(4036);
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A })).status);
    expect(codes).toContain(429);
  });
});

describe("Arena Picks over HTTP", () => {
  const stage = async () => {
    await seedHeroes(db, 16);
    const state = await import("@/app/api/arena/state/route");
    // Picks are made on the UPCOMING battle (the one that takes the stage after the fight in progress).
    const up = (await (await call(state.GET, req("/api/arena/state", { method: "GET" }))).json()).state as { upcoming: { id: string; fighters: Array<{ characterId: string }> } | null };
    expect(up.upcoming).not.toBeNull();
    return { current: up.upcoming! };
  };
  const getPicks = async (battleId: string, cookie?: string) => (await call((await picksRoute()).GET, req(`/api/arena/picks?battleId=${battleId}`, { method: "GET", ...(cookie ? { cookie } : {}) }))).json();

  it("an INELIGIBLE member gets a clear public explanation and cannot pick — with only a coarse reason", async () => {
    const s = await stage();
    const cookie = await session(4050, { eligible: false });
    const res = await call((await picksRoute()).POST, req("/api/arena/picks", { json: { battleId: s.current.id, characterId: s.current.fighters[0]!.characterId }, cookie }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "NOT_ELIGIBLE", message: "Members with 50+ qualifying messages in the official Clank.trade community can participate in rewarded Arena Picks." });
    const view = await getPicks(s.current.id, cookie);
    expect(view.eligibility).toMatchObject({ eligible: false, reason: "NO_HERO" });
    // A suspended hero reads as the generic reason — the suspension itself is not disclosed.
    await seedEligibleMember(db, { id: 4051, heroStatus: "SUSPENDED" });
    const suspended = await session(4051, { eligible: false });
    expect((await getPicks(s.current.id, suspended)).eligibility).toMatchObject({ eligible: false, reason: "NOT_ELIGIBLE" });
  });

  it("the CROWD is withheld until picks lock: no counts before, and only after the server clock passes the lock", async () => {
    const s = await stage();
    const a = await session(4060);
    const b = await session(4061);
    const c = await session(4062);
    const f = s.current.fighters.map((x) => x.characterId);
    for (const [cookie, fighter] of [[a, f[0]], [b, f[0]], [c, f[1]]] as const) {
      expect((await call((await picksRoute()).POST, req("/api/arena/picks", { json: { battleId: s.current.id, characterId: fighter }, cookie }))).status).toBe(200);
    }
    // Before the lock: nobody — not even a picker — receives any counts, and the shared state has none either.
    const before = await getPicks(s.current.id, a);
    expect(before.round).toMatchObject({ locked: false, distribution: null, outcome: null });
    expect(JSON.stringify(before)).not.toMatch(/"total"|byCharacter/);
    const stateRoute = await import("@/app/api/arena/state/route");
    resetRuntimeCaches();
    expect(JSON.stringify((await (await call(stateRoute.GET, req("/api/arena/state", { method: "GET" }))).json()).state.picks)).not.toMatch(/counts|distribution|"2"/);
    expect((await getPicks(s.current.id)).round.distribution).toBeNull(); // anonymous too

    // The window closes (server clock): now the crowd may be shown.
    // The window closes (server clock) — here by the battle's own start passing; the lock rule itself is covered by the arena lifecycle suite.
    await db.query("update public.arena_battles set starts_at = now() - interval '1 second' where id = $1", [s.current.id]);
    const after = await getPicks(s.current.id, a);
    expect(after.round).toMatchObject({ locked: true, distribution: { total: 3, byCharacter: { [f[0]!]: 2, [f[1]!]: 1 } } });
    // Still no identities: only counts, and only your own pick.
    expect(JSON.stringify(after)).not.toMatch(/telegram|4061|4062/i);
    expect((await getPicks(s.current.id, c)).pick).toMatchObject({ characterId: f[1] });
  });

  it("a pick submitted after the server-side lock is refused, whatever the browser's clock says", async () => {
    const s = await stage();
    const cookie = await session(4070);
    // The window closes (server clock) — here by the battle's own start passing; the lock rule itself is covered by the arena lifecycle suite.
    await db.query("update public.arena_battles set starts_at = now() - interval '1 second' where id = $1", [s.current.id]);
    const res = await call((await picksRoute()).POST, req("/api/arena/picks", { json: { battleId: s.current.id, characterId: s.current.fighters[0]!.characterId }, cookie }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "LOCKED" });
  });
});

describe("privacy: nothing internal or secret reaches a browser", () => {
  const FORBIDDEN = /telegram_user_id|telegramUserId|review_state|reviewState|review_reason|flag_reason|risk|suspicion|treasuryKey|TREASURY_PRIVATE_KEY|privateKey|SESSION_SECRET|ADMIN_ACCESS_KEY|TELEGRAM_BOT_TOKEN|service_role|SUPABASE/i;

  it("player-facing reward and pick responses carry no raw Telegram ID, risk flag, admin note or secret", async () => {
    const cookie = await session(4080);
    await credit(db, 4080, tokens(25_000));
    await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A });
    const bodies = [
      JSON.stringify(await summary(cookie)),
      JSON.stringify(await (await claim(cookie, { idempotencyKey: key() })).json()),
    ];
    for (const b of bodies) {
      expect(b).not.toMatch(FORBIDDEN);
      expect(b).not.toContain(TREASURY_KEY.slice(2));
      expect(b).not.toContain("4080");
    }
    const stateRoute = await import("@/app/api/arena/state/route");
    await seedHeroes(db, 16);
    resetRuntimeCaches();
    const state = JSON.stringify(await (await call(stateRoute.GET, req("/api/arena/state", { method: "GET" }))).json());
    expect(state).not.toMatch(FORBIDDEN);
    expect(state).not.toMatch(/treasury|0x[0-9a-f]{40}/i);
  });

  it("every admin reward route is admin-only: closed without a session AND for a signed-in player", async () => {
    const player = await session(4090);
    const gets = ["picks/overview", "picks/battles", "picks/claims", "picks/claims?status=PENDING", "picks/review", "picks/accounts", "picks/reconciliation", "picks/weeks", "picks/weeks/2026-09-28", "picks/holders", "picks/token"];
    for (const path of gets) {
      expect((await admin("GET", path, { cookie: null })).status, path).toBe(401);
      expect((await admin("GET", path, { cookie: player })).status, `${path} as a player`).toBe(401);
    }
    const posts: Array<[string, unknown]> = [
      ["picks/accounts/4090/review", {}], ["picks/accounts/4090/adjust", {}], ["picks/claims/00000000-0000-4000-8000-000000000000/sent", { txHash: `0x${"a".repeat(64)}` }],
      ["picks/claims/00000000-0000-4000-8000-000000000000/deny", { reason: "OTHER" }], ["picks/weeks/finalize", {}], ["picks/weeks/2026-09-28/prizes/4090/resolve", { action: "release", reason: "nope nope" }],
      ["picks/sim/balance", { address: WALLET_A, amount: "1" }], ["picks/sim/transfer", { to: WALLET_A, amount: "1" }], ["picks/sim/outage", { on: true }],
    ];
    for (const [path, json] of posts) {
      expect((await admin("POST", path, { json, cookie: null })).status, path).toBe(401);
      expect((await admin("POST", path, { json, cookie: player })).status, `${path} as a player`).toBe(401);
    }
  });

  it("the admin console never shows a secret — a retired treasury private key still in the environment is reported BY NAME only", async () => {
    const res = await admin("GET", "picks/overview");
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("CLANKRPG_REWARD_TREASURY_PRIVATE_KEY is set"); // the admin is told to remove it
    expect(text).not.toContain(TREASURY_KEY.slice(2));
    expect(text).not.toMatch(/PRIVATE_KEY=|privateKey|treasuryKey|SESSION_SECRET|ADMIN_ACCESS_KEY/);
    const tok = JSON.stringify(await (await admin("GET", "picks/token")).json());
    expect(tok).not.toContain(TREASURY_KEY.slice(2));
    // A misconfigured token (an address that is not an address): the admin sees WHY (names only), nobody sees a secret.
    setChainReaderForTests(undefined);
    delete process.env.CLANKRPG_CHAIN_ADAPTER;
    process.env.CLANKRPG_TOKEN_ADDRESS = "not-an-address";
    resetEnvCache();
    try {
      const bad = JSON.stringify(await (await admin("GET", "picks/overview")).json());
      expect(bad).toContain("CLANKRPG_TOKEN_ADDRESS is not a valid address");
      expect(bad).not.toContain(TREASURY_KEY.slice(2));
    } finally {
      delete process.env.CLANKRPG_TOKEN_ADDRESS;
      resetEnvCache();
    }
  });
});

describe("the login flow still works for a plain Telegram member (no wallet needed anywhere)", () => {
  it("signing in needs only Telegram — and the member can then pick and see their rewards page", async () => {
    await seedEligibleMember(db, { id: 4100 });
    const login = await import("@/app/api/auth/telegram/route");
    const payload = signTelegramLoginPayload({ id: 4100, first_name: "Ada", username: "ada", auth_date: Math.floor(Date.now() / 1000) - 1 }, BOT_TOKEN);
    const res = await call(login.POST, req("/api/auth/telegram", { json: payload }));
    const cookie = (res.headers.getSetCookie().find((c) => c.startsWith("clank_session=")) ?? "").split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    expect((await summary(cookie)).rewards).toMatchObject({ claimable: "0", holderWallet: { short: null }, eligibility: { eligible: true } });
  });
});

describe("optional HOLDER wallet verification over HTTP", () => {
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
  const OTHER = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
  const account = privateKeyToAccount(KEY);
  let reader: SimulatedChainReader;
  const challengeRoute = () => import("@/app/api/me/rewards/holder/challenge/route");
  const verifyRoute = () => import("@/app/api/me/rewards/holder/verify/route");
  const refreshRoute = () => import("@/app/api/me/rewards/holder/refresh/route");
  const challenge = async (cookie: string | undefined, address = account.address) => call((await challengeRoute()).POST, req("/api/me/rewards/holder/challenge", { json: { address }, ...(cookie ? { cookie } : {}) }));
  const verify = async (cookie: string | undefined, json: unknown) => call((await verifyRoute()).POST, req("/api/me/rewards/holder/verify", { json, ...(cookie ? { cookie } : {}) }));
  async function connect(cookie: string, signer: ReturnType<typeof privateKeyToAccount> = account, address = account.address) {
    const c = await (await challenge(cookie, address)).json();
    return verify(cookie, { nonce: c.nonce, signature: await signer.signMessage({ message: c.message }) });
  }
  beforeEach(() => {
    reader = chain; // the same read-only simulated chain the whole file uses
    expect(reader.chainId).toBe(CHAIN_ID);
    expect(reader.tokenAddress).toBe(TOKEN);
  });

  it("every holder route is closed without a session, refuses cross-site requests and unknown fields — the browser can never say a balance, a tier, a bonus or a signer", async () => {
    const cookie = await session(4200);
    expect((await challenge(undefined)).status).toBe(401);
    expect((await verify(undefined, { nonce: "n".repeat(32), signature: `0x${"ab".repeat(65)}` })).status).toBe(401);
    expect((await call((await refreshRoute()).POST, req("/api/me/rewards/holder/refresh", { json: {} }))).status).toBe(401);
    expect((await call((await challengeRoute()).POST, req("/api/me/rewards/holder/challenge", { json: { address: account.address }, cookie, origin: "https://evil.example" }))).status).toBe(403);
    const c = await (await challenge(cookie)).json();
    const signature = await account.signMessage({ message: c.message });
    for (const forged of [{ balance: "99999999" }, { tier: 5 }, { tierIndex: 5 }, { address: account.address }, { telegramUserId: 1 }, { bonusBps: 2500 }, { qualified: true }, { wallet: WALLET_A }]) {
      expect((await verify(cookie, { nonce: c.nonce, signature, ...forged })).status, JSON.stringify(forged)).toBe(422);
    }
    expect((await call((await challengeRoute()).POST, req("/api/me/rewards/holder/challenge", { json: { address: account.address, balance: "1" }, cookie }))).status).toBe(422);
  });

  it("challenge → real signature → verified: the wallet is linked, the server read the balance, and even a 10M holder earns NO bonus yet (continuity starts now)", async () => {
    const cookie = await session(4201);
    reader.setBalance(account.address, chainTokens(10_000_000));
    const ch = await challenge(cookie);
    expect(ch.status).toBe(200);
    const c = await ch.json();
    expect(c.message).toContain(`Wallet: ${account.address.toLowerCase()}`);
    const res = await verify(cookie, { nonce: c.nonce, signature: await account.signMessage({ message: c.message }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.holder).toMatchObject({ walletConnected: true, tier: { name: "10M HOLDER", bonus: "+25%" }, balance: "10,000,000", daily: { status: "QUALIFYING", payingBonus: null }, weekly: { status: "QUALIFYING", payingBonus: null } });
    const s = await summary(cookie);
    expect(s.rewards.holder.walletConnected).toBe(true);
    expect(s.rewards.holderWallet.short).toMatch(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/); // only the SHORT form is ever served
    expect(JSON.stringify(s)).not.toContain(account.address.toLowerCase());
    expect(JSON.stringify(s.rewards.holder)).not.toContain(account.address.toLowerCase()); // the card carries only the short form
  });

  it("a wrong signature, a replayed nonce and another member's nonce are all refused, and nothing is linked", async () => {
    const cookie = await session(4202);
    const other = await session(4203);
    const c = await (await challenge(cookie)).json();
    const wrong = await verify(cookie, { nonce: c.nonce, signature: await privateKeyToAccount(OTHER).signMessage({ message: c.message }) });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ error: "BAD_SIGNATURE", message: "That signature doesn't match this wallet. Nothing was changed." });
    expect(await db.query("select 1 from public.arena_reward_accounts where holder_wallet_address is not null")).toHaveLength(0);
    const signature = await account.signMessage({ message: c.message });
    expect((await verify(other, { nonce: c.nonce, signature })).status).toBe(409); // someone else's nonce
    expect((await verify(cookie, { nonce: c.nonce, signature })).status).toBe(200);
    expect((await verify(cookie, { nonce: c.nonce, signature })).status).toBe(409); // replay
  });

  it("one wallet ↔ one account: a second Telegram identity cannot link it ('This wallet is already linked to another Clank RPG account.')", async () => {
    const a = await session(4204);
    const b = await session(4205);
    expect((await connect(a)).status).toBe(200);
    const dup = await connect(b);
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "WALLET_IN_USE", message: "This wallet is already linked to another Clank RPG account." });
    expect((await summary(b)).rewards.holderWallet.short).toBeNull();
  });

  it("'Refresh holdings' is server-side and rate-limited (one per 5 minutes); a balance in the body is never read — only the chain's is", async () => {
    const cookie = await session(4206);
    reader.setBalance(account.address, chainTokens(600_000));
    await connect(cookie);
    const refresh = async (json: unknown = {}) => call((await refreshRoute()).POST, req("/api/me/rewards/holder/refresh", { json, cookie }));
    reader.setBalance(account.address, chainTokens(1_100_000));
    const first = await (await refresh({ balance: "99999999999", tier: 5 })).json(); // forged fields are ignored: the SERVER read the chain
    expect(first).toMatchObject({ refresh: "OK", holder: { balance: "1,100,000" } });
    expect(first.holder.tier.name).toBe("1M HOLDER"); // the tier of the SERVER-read balance…
    expect(first.holder.daily.payingBonus).toBeNull(); // …and no bonus without continuity from before the period began
    const second = await refresh();
    expect(await second.json()).toMatchObject({ refresh: "THROTTLED" });
  });

  it("an RPC failure writes no evidence and the member is told verification is needed only once it goes stale", async () => {
    const cookie = await session(4208);
    reader.setBalance(account.address, chainTokens(600_000));
    await connect(cookie);
    reader.failNext();
    const failed = await (await call((await refreshRoute()).POST, req("/api/me/rewards/holder/refresh", { json: {}, cookie }))).json();
    expect(failed).toMatchObject({ refresh: "UNAVAILABLE", holder: { walletConnected: true, verificationNeeded: false } }); // verified minutes ago: nothing to worry about yet
  });

  it("with holder verification UNAVAILABLE everyone is simply FREE: Connect wallet is refused politely and nothing else is affected", async () => {
    setChainReaderForTests(null);
    const cookie = await session(4207);
    const ch = await challenge(cookie);
    expect(ch.status).toBe(503);
    expect(await ch.json()).toMatchObject({ error: "HOLDERS_UNAVAILABLE", message: "Holder benefits aren't available yet. Arena Picks, Points and the leaderboards work exactly as before." });
    const s = (await summary(cookie)).rewards;
    expect(s.holder).toMatchObject({ available: false, walletConnected: false, tier: { name: "FREE" } });
    expect(s.eligibility.eligible).toBe(true); // playing, picking, Points and the leaderboards need no wallet
  });
});

describe("the OFFICIAL token configuration endpoint (the only place a client learns the contract address)", () => {
  const tokenRoute = () => import("@/app/api/rewards/token/route");
  it("is public, serves the ONE configured contract, and nothing secret", async () => {
    const res = await call((await tokenRoute()).GET, req("/api/rewards/token", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/public/);
    const body = await res.json();
    expect(body.token).toEqual({ launched: true, configured: true, symbol: "$CLANKRPG", address: TOKEN, chainId: CHAIN_ID, explorerTxUrl: null, buyUrl: `https://clank.trade/${TOKEN}` });
    expect(JSON.stringify(body)).not.toMatch(/key|secret|treasury|rpc|decimals/i);
    expect(JSON.stringify(body)).not.toContain(TREASURY_KEY.slice(2));
  });
  it("NOT LAUNCHED: no address configured serves no address and the plain https://clank.trade/ BUY link — a normal state, never an error", async () => {
    setChainReaderForTests(undefined);
    delete process.env.CLANKRPG_CHAIN_ADAPTER;
    delete process.env.CLANKRPG_TOKEN_ADDRESS;
    resetEnvCache();
    const res = await call((await tokenRoute()).GET, req("/api/rewards/token", { method: "GET" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toEqual({ launched: false, configured: false, symbol: "$CLANKRPG", address: null, chainId: null, explorerTxUrl: null, buyUrl: "https://clank.trade/" });
  });
  it("a real configured address flips the SAME endpoint to https://clank.trade/<address> with no code change (RPC adapter, nothing is asked of the chain)", async () => {
    setChainReaderForTests(undefined);
    delete process.env.CLANKRPG_CHAIN_ADAPTER;
    process.env.CLANKRPG_TOKEN_ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7";
    resetEnvCache();
    try {
      const body = await (await call((await tokenRoute()).GET, req("/api/rewards/token", { method: "GET" }))).json();
      expect(body.token).toMatchObject({ launched: true, address: "0x52908400098527886e0f7030069857d2e4169ee7", buyUrl: "https://clank.trade/0x52908400098527886e0f7030069857d2e4169ee7" });
    } finally {
      delete process.env.CLANKRPG_TOKEN_ADDRESS;
      resetEnvCache();
    }
  });
  it("no client source hard-codes a contract address", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && /"use client"/.test(readFileSync(p, "utf8").slice(0, 200)) && /0x[0-9a-fA-F]{40}/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(join(process.cwd(), "src", "components"));
    expect(hits).toEqual([]);
  });
});

describe("the DAILY and WEEKLY leaderboards over HTTP: server clock, canonical periods, frozen history", () => {
  const route = () => import("@/app/api/leaderboard/picks/route");
  const get = async (q = "", cookie?: string) => call((await route()).GET, req(`/api/leaderboard/picks${q}`, { method: "GET", ...(cookie ? { cookie } : {}) }));

  it("DAILY is public and never cached: serverNow, startsAt and endsAt are the SERVER's, the day is always 00:00→00:00 UTC, and the prize rules are served", async () => {
    const before = Date.now();
    const res = await get("?period=daily");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store"); // it carries the server clock the client countdown anchors to
    const body = await res.json();
    expect(body.serverNow).toBeGreaterThanOrEqual(before);
    expect(body.serverNow).toBeLessThanOrEqual(Date.now());
    expect(body.board).toMatchObject({ kind: "DAILY", state: "CURRENT", rows: [], participants: 0, serverNow: body.serverNow });
    expect(body.board.startsAt % 86_400_000).toBe(0);
    expect(body.board.endsAt - body.board.startsAt).toBe(86_400_000);
    expect(body.board.startsAt).toBeLessThanOrEqual(body.serverNow);
    expect(body.board.endsAt).toBeGreaterThan(body.serverNow);
    expect(body.board.rules).toMatchObject({ kind: "DAILY", prizePool: "100,000", minimumPicks: 20, pointsPerCorrectPick: 10, topRewarded: 10, symbol: "$CLANKRPG" });
    expect(body.board.rules).not.toHaveProperty("scoredPicksPerDay"); // no per-day cap in what the server tells the client
    expect(body.board.rules.prizes.map((p: { amount: string }) => p.amount)).toEqual(["30,000", "20,000", "15,000", "10,000", "8,000", "6,000", "4,000", "3,000", "2,000", "2,000"]);
    expect(body.current).toMatchObject({ kind: "DAILY", start: body.board.start, startsAt: body.board.startsAt, endsAt: body.board.endsAt });
    expect(body.me).toBeNull(); // anonymous: no personal standing
    // The default period is the DAILY board.
    expect((await (await get()).json()).board.kind).toBe("DAILY");
    expect(JSON.stringify(body)).not.toMatch(/telegram|username|"balance"|wallet|0x[0-9a-f]{40}/i);
  });

  it("WEEKLY is a Monday→Monday window with its own 500,000 pool and the SAME ladder percentages (150,000 / 100,000 / 75,000 …)", async () => {
    const body = await (await get("?period=weekly")).json();
    expect(body.board).toMatchObject({ kind: "WEEKLY", state: "CURRENT", rows: [], participants: 0 });
    expect(new Date(body.board.startsAt).getUTCDay()).toBe(1);
    expect(body.board.endsAt - body.board.startsAt).toBe(7 * 86_400_000);
    expect(body.board.rules).toMatchObject({ kind: "WEEKLY", prizePool: "500,000", minimumPicks: 100, topRewarded: 10 });
    expect(body.board.rules.prizes.map((p: { amount: string }) => p.amount)).toEqual(["150,000", "100,000", "75,000", "50,000", "40,000", "30,000", "20,000", "15,000", "10,000", "10,000"]);
    expect(body.board.rules.holderBonuses.map((b: { label: string; bonus: string }) => `${b.label} ${b.bonus}`)).toEqual(["100K +5%", "500K +10%", "1M +15%", "5M +20%", "10M +25%"]);
  });

  it("validates the period: daily takes any real day that has started, weekly a Monday that has; no junk, no future, no invented board for an unfinalized past period", async () => {
    expect((await get("?period=hourly")).status).toBe(400);
    expect((await get("?period=weekly&start=2026-10-06")).status).toBe(400); // a Tuesday is not a week start
    expect((await get("?period=daily&start=nonsense")).status).toBe(400);
    expect((await get("?period=daily&start=2026-02-30")).status).toBe(400);
    expect((await get("?period=daily&start=2999-01-05")).status).toBe(400); // the future
    expect((await get("?period=weekly&start=2999-01-05")).status).toBe(400);
    expect((await get("?period=weekly&start=2026-09-21")).status).toBe(404); // a valid past Monday that was never finalized
    expect((await get("?period=daily&start=2026-09-21")).status).toBe(404);
  });

  it("a signed-in member also gets their OWN standing — Picks / Correct / Accuracy / Points / Rank and eligibility (no per-day cap counter) — and finalized boards serve their frozen rows (base prize, holder bonus, total)", async () => {
    const cookie = await session(4300);
    await session(4301);
    let st = await stageBattle(db);
    const settings = settingsWith({ dailyMinimumPicks: 1, weeklyMinimumPicks: 1 });
    await pickAs(db, st, 4300, st.winnerId);
    await pickAs(db, st, 4301, loser(st));
    await finishBattle(db, st);
    await settleBattleRewards(db, { now: st.clock.now, settings }, st.battleId);
    st = await stageNext(db, st);
    await pickAs(db, st, 4300, st.winnerId);
    await finishBattle(db, st);
    await settleBattleRewards(db, { now: st.clock.now, settings }, st.battleId);
    // The fixture's battles are on Sunday 2026-10-04 (the week of 2026-09-28), both ended: freeze them, then read them over HTTP.
    const ctx = { now: () => new Date("2026-10-05T00:00:05Z"), settings, decimals: 18, reader: null };
    expect(await finalizePeriod(db, ctx, "DAILY", "2026-10-04")).toMatchObject({ status: "FINALIZED" });
    expect(await finalizePeriod(db, ctx, "WEEKLY", "2026-09-28")).toMatchObject({ status: "FINALIZED" });

    const day = await get("?period=daily&start=2026-10-04", cookie);
    expect(day.status).toBe(200);
    const body = await day.json();
    expect(body.board).toMatchObject({ kind: "DAILY", state: "FINAL", start: "2026-10-04", participants: 2, eligibleParticipants: 2, finalizedAt: expect.any(Number) });
    expect(body.board.rows.map((r: { name: string; points: number; rank: number; basePrize: string; holderBonus: string; totalReward: string }) => [r.name, r.points, r.rank, r.basePrize, r.holderBonus, r.totalReward])).toEqual([["Hero 4300", 20, 1, "30,000", "0", "30,000"], ["Hero 4301", 0, 2, "20,000", "0", "20,000"]]);
    expect(body.me).toMatchObject({ rank: 1, points: 20, picks: 2, correctPicks: 2, accuracy: 100, prizeEligible: true, prize: { base: "30,000", bonus: "0", total: "30,000", status: "CREDITED", bonusStatus: "NONE" } });
    expect(body.periods).toEqual([{ start: "2026-10-04", participants: 2, prizePool: "100,000" }]);
    expect(JSON.stringify(body.board)).not.toMatch(/telegram|username|telegram_user_id/); // hero identities only

    const week = await (await get("?period=weekly&start=2026-09-28", cookie)).json();
    expect(week.board).toMatchObject({ kind: "WEEKLY", state: "FINAL", start: "2026-09-28" });
    expect(week.board.rows[0]).toMatchObject({ name: "Hero 4300", points: 20, basePrize: "150,000" });
    expect(week.periods).toEqual([{ start: "2026-09-28", participants: 2, prizePool: "500,000" }]);

    // the member's own reward summary lists each prize on its own line — Daily and Weekly distinguished — and the rules for both boards
    const mine = (await summary(cookie)).rewards;
    expect(mine.latestRewards.map((r: { label: string; amount: string }) => [r.label, r.amount])).toEqual(expect.arrayContaining([["DAILY #1", "30,000"], ["WEEKLY #1", "150,000"]]));
    expect(mine.boards.daily).toMatchObject({ prizePool: "100,000", minimumPicks: 20 }); // the shipped minimum (the test only lowered it for the freeze)
    expect(mine.boards.daily).not.toHaveProperty("scoredPicksPerDay");
    expect(mine.boards.weekly).toMatchObject({ prizePool: "500,000" });
    // a PUBLIC reader never sees someone's prize status (only the owner's `me` does)
    const anon = await (await get("?period=daily&start=2026-10-04")).json();
    expect(anon.me).toBeNull();
    expect(JSON.stringify(anon)).not.toMatch(/"status":"(CREDITED|HELD|FORFEITED)"/);
  });

  it("there is no endpoint that can reset a leaderboard: only GET exists for the public boards, and admin has no reset route", async () => {
    const mod = await route();
    expect(Object.keys(mod).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
    for (const path of ["picks/boards/reset", "picks/boards/daily/current/reset", "picks/leaderboard/reset", "picks/boards/clear", "picks/weeks/reset"]) {
      for (const method of ["POST", "PUT", "DELETE"] as const) expect([404, 405], `${method} ${path}`).toContain((await admin(method, path, { json: {} })).status);
    }
  });
});

describe("the MANUAL claim lifecycle through the admin API (Pending → Sent / Denied) — no private key anywhere", () => {
  const pending = async () => (await (await admin("GET", "picks/claims?status=PENDING")).json()) as { claims: Array<Record<string, unknown>>; counts: Record<string, { count: number; amount: string }> };
  const mark = (id: string, json: unknown) => admin("POST", `picks/claims/${id}/sent`, { json });
  const deny = (id: string, json: unknown) => admin("POST", `picks/claims/${id}/deny`, { json });

  it("a member requests; the admin sees it with its frozen amount and destination; MARK SENT verifies the transfer on-chain; the member then sees SENT with the transaction", async () => {
    const cookie = await session(4400);
    await credit(db, 4400, tokens(25_000));
    const c = (await (await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A })).json()).claim;

    const q = await pending();
    expect(q.counts).toMatchObject({ PENDING: { count: 1, amount: "25,000" }, SENT: { count: 0 }, DENIED: { count: 0 } });
    expect(q.claims[0]).toMatchObject({ id: c.id, telegram_user_id: 4400, destination_address: WALLET_A, destination_kind: "CUSTOM", amount: "25,000", status: "PENDING", review_state: "NORMAL" });

    // The admin pays BY HAND (simulated here as a transfer on the read-only chain), then names the transaction. Only a hash is accepted.
    const hash = (await (await admin("POST", "picks/sim/transfer", { json: { to: WALLET_A, amount: "25000" } })).json()).txHash as string;
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    for (const forged of [{ amount: "1" }, { recipient: WALLET_B }, { destination: WALLET_B }, { status: "SENT" }]) expect((await mark(c.id, { txHash: hash, ...forged })).status, JSON.stringify(forged)).toBe(422);
    expect((await mark(c.id, { txHash: hash })).status).toBe(409); // 1 confirmation of the 2 required: still PENDING, with a clear reason
    chain.advance(2);
    const done = await mark(c.id, { txHash: hash });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: "SENT" });
    expect((await mark(c.id, { txHash: hash })).status).toBe(409); // marking SENT twice is refused

    const s = (await summary(cookie)).rewards;
    expect(s).toMatchObject({ claimable: "0", pending: "0", claimed: "25,000", totalEarned: "25,000" });
    expect(s.claimHistory[0]).toMatchObject({ status: "SENT", amount: "25,000", destination: "0x5290…9ee7", txShort: `${hash.slice(0, 6)}…${hash.slice(-4)}` });
    expect(s.pendingClaim).toBeNull();
    expect((await pending()).claims).toEqual([]);
    expect((await (await admin("GET", "picks/reconciliation")).json()).issues).toEqual([]);
  });

  it("MARK SENT refuses a wrong transfer (recipient / amount / token / failed) and a hash used by another claim — and the claim stays PENDING", async () => {
    const a = await session(4401);
    const b = await session(4402);
    await credit(db, 4401, tokens(25_000));
    await credit(db, 4402, tokens(25_000));
    const ca = (await (await claim(a, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A })).json()).claim;
    const cb = (await (await claim(b, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_B })).json()).claim;
    const send = (over: Record<string, unknown>) => { const { hash } = chain.sendTransfer({ to: WALLET_A, amountRaw: chainTokens(25_000), ...over } as never); chain.advance(2); return hash; };
    const code = async (id: string, hash: string) => ({ status: (await mark(id, { txHash: hash })).status });
    expect(await code(ca.id, send({ to: WALLET_B }))).toEqual({ status: 409 }); // wrong recipient
    expect(await code(ca.id, send({ amountRaw: chainTokens(24_999) }))).toEqual({ status: 409 }); // wrong amount
    expect(await code(ca.id, send({ token: "0x5555555555555555555555555555555555555555" }))).toEqual({ status: 409 }); // wrong token
    expect(await code(ca.id, send({ status: "reverted" }))).toEqual({ status: 409 }); // failed tx
    expect(await code(ca.id, `0x${"7".repeat(64)}`)).toEqual({ status: 409 }); // unknown to the network
    expect((await mark(ca.id, { txHash: "nonsense" })).status).toBe(422);
    chain.setOutage(true);
    expect(await code(ca.id, send({}))).toEqual({ status: 503 }); // the chain cannot be read: never SENT blindly
    chain.setOutage(false);
    expect((await pending()).claims).toHaveLength(2);
    // a valid payout for A; the SAME hash cannot also close B's claim
    const good = send({});
    expect((await mark(ca.id, { txHash: good })).status).toBe(200);
    const bBad = await mark(cb.id, { txHash: good });
    expect(bBad.status).toBe(409);
    expect(await bBad.json()).toMatchObject({ error: "TX_IN_USE" });
  });

  it("DENY requires a valid reason; the member sees DENIED with a SAFE explanation (never internal reasoning) and the reward is claimable again", async () => {
    const cookie = await session(4403);
    await credit(db, 4403, tokens(15_000));
    const c = (await (await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A })).json()).claim;
    expect((await deny(c.id, {})).status).toBe(422);
    expect((await deny(c.id, { reason: "BECAUSE" })).status).toBe(422);
    expect((await deny(c.id, { reason: "OTHER" })).status).toBe(422); // 'Other' needs a note
    expect((await deny(c.id, { reason: "INVALID_WALLET", amount: "1" })).status).toBe(422);
    const ok = await deny(c.id, { reason: "INVALID_WALLET", note: "address belongs to an exchange deposit that rejects this token" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "DENIED", accountHeld: false });
    const s = (await summary(cookie)).rewards;
    expect(s).toMatchObject({ claimable: "15,000", pending: "0", claimed: "0" });
    expect(s.claimHistory[0]).toMatchObject({ status: "DENIED", denial: { label: "Invalid wallet", message: expect.stringContaining("claimable balance") } });
    expect(JSON.stringify(s)).not.toMatch(/exchange deposit|denial_note|denied_by|admin/i); // the admin's internal note never reaches the player
    expect((await deny(c.id, { reason: "INVALID_WALLET" })).status).toBe(409); // already DENIED
  });

  it("a SUSPICIOUS denial holds the account (REVIEW) without leaking why; the player is only told it could not be processed", async () => {
    const cookie = await session(4404);
    await credit(db, 4404, tokens(15_000));
    const c = (await (await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_A })).json()).claim;
    const res = await deny(c.id, { reason: "SUSPICIOUS", note: "same destination as 6 other accounts" });
    expect(await res.json()).toMatchObject({ status: "DENIED", accountHeld: true });
    const s = JSON.stringify((await summary(cookie)).rewards);
    expect(s).not.toMatch(/suspicious|same destination|6 other|REVIEW|review_state/i);
    expect(JSON.parse(s).claimHistory[0].denial).toEqual({ label: "Could not be processed", message: "We couldn't process this claim. Your rewards are safe in your account." });
    const blocked = await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_B });
    expect(await blocked.json()).toMatchObject({ error: "CLAIMS_HELD" });
    expect((await (await admin("GET", "picks/claims?status=DENIED")).json()).claims[0]).toMatchObject({ denial_reason: "SUSPICIOUS", review_state: "REVIEW" });
  });

  it("holder-wallet destination vs another wallet: the connected wallet is offered only to verified holders and stays unchanged by a custom payout", async () => {
    const cookie = await session(4405);
    await credit(db, 4405, tokens(30_000));
    const holder = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const ch = await (await call((await import("@/app/api/me/rewards/holder/challenge/route")).POST, req("/api/me/rewards/holder/challenge", { json: { address: holder.address }, cookie }))).json();
    const verified = await call((await import("@/app/api/me/rewards/holder/verify/route")).POST, req("/api/me/rewards/holder/verify", { json: { nonce: ch.nonce, signature: await holder.signMessage({ message: ch.message }) }, cookie }));
    expect(verified.status).toBe(200);
    const before = (await summary(cookie)).rewards.holderWallet.short;
    const custom = await (await claim(cookie, { idempotencyKey: key(), destination: "CUSTOM", address: WALLET_B })).json();
    expect(custom.claim).toMatchObject({ destinationKind: "CUSTOM" });
    expect((await summary(cookie)).rewards.holderWallet.short).toBe(before); // a payout address never changes the holder wallet
    // pay and finish it, then claim again to the CONNECTED wallet
    const { hash } = chain.sendTransfer({ to: WALLET_B, amountRaw: chainTokens(30_000) });
    chain.advance(2);
    expect((await mark(custom.claim.id, { txHash: hash })).status).toBe(200);
    await credit(db, 4405, tokens(11_000));
    const connected = await (await claim(cookie, { idempotencyKey: key(), destination: "HOLDER_WALLET" })).json();
    expect(connected.claim).toMatchObject({ destinationKind: "HOLDER_WALLET", amount: "11,000", status: "PENDING" });
    expect((await pending()).claims[0]).toMatchObject({ destination_address: holder.address.toLowerCase(), destination_kind: "HOLDER_WALLET" });
  });
});

describe("the admin boards / holder / token views over HTTP", () => {
  it("boards: the running Daily and Weekly with rules and counts; finalize is a safe, idempotent, audited sweep (and nothing can reset)", async () => {
    const w = await (await admin("GET", "picks/boards")).json();
    expect(w.boards.current.DAILY).toMatchObject({ prizePool: "100,000", minimumPicks: 20, participants: 0 });
    expect(w.boards.current.WEEKLY).toMatchObject({ prizePool: "500,000", minimumPicks: 100, participants: 0 });
    expect(w.boards.finalized).toEqual([]);
    expect(w.boards.unfinalized).toEqual([]);
    const run = await admin("POST", "picks/boards/finalize", { json: {} });
    expect(run.status).toBe(200);
    expect((await run.json()).result).toEqual({ finalized: 0, waiting: 0, failed: 0, periods: [], reconciled: { checked: 0, credited: 0, expired: 0 } });
    expect(await db.query("select 1 from public.admin_audit_log where action = 'rewards.boards_finalize'")).toHaveLength(1);
    expect((await admin("GET", "picks/boards/DAILY/not-a-date")).status).toBe(404);
    expect((await admin("GET", "picks/boards/WEEKLY/2026-10-06")).status).toBe(404); // a Tuesday is not a week
    expect((await admin("GET", "picks/boards/HOURLY/2026-10-06")).status).toBe(404);
    expect((await admin("GET", "picks/boards/DAILY/2026-10-06")).status).toBe(200);
  });

  it("payout summary: only admins can read it; an unfinalized board is 404; a finalized one serves the exact payout as JSON and as a safe CSV download", async () => {
    await seedScores(db, Array.from({ length: 3 }, (_, i) => ({ user: 9701 + i, day: "2026-10-06", picks: 20, correct: 20 - i })));
    await db.query("update public.characters set name = '=HYPERLINK(\"http://evil.example\")' where telegram_user_id = 9701");
    const path = "picks/boards/DAILY/2026-10-06/payout";
    expect((await admin("GET", path, { cookie: null })).status).toBe(401); // no admin session, no payout
    expect((await admin("GET", path)).status).toBe(404); // the day exists but has not been frozen
    expect(await finalizePeriod(db, { now: () => new Date("2026-10-07T00:00:05Z"), settings: settingsWith(), reader: null }, "DAILY", "2026-10-06")).toMatchObject({ status: "FINALIZED" });

    const json = await (await admin("GET", path)).json();
    expect(json.payout.summary).toMatchObject({ kind: "DAILY", start: "2026-10-06", basePool: "100,000", baseAwarded: "65,000", holderBonuses: "0", totalPayout: "65,000", totalPayoutPlain: "65000", prizeWinners: 3 });
    expect(json.payout.rows.map((r: { rank: number; totalRewardPlain: string; claimStatus: string }) => [r.rank, r.totalRewardPlain, r.claimStatus])).toEqual([[1, "30000", "UNCLAIMED"], [2, "20000", "UNCLAIMED"], [3, "15000", "UNCLAIMED"]]);
    expect(JSON.stringify(json)).not.toMatch(/evidence|hold_reason|review_reason/i); // no anti-fraud internals

    const csv = await admin("GET", `${path}?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="clank-daily-payout-2026-10-06.csv"');
    expect(csv.headers.get("cache-control")).toBe("no-store");
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("period_type,period_start,rank,telegram_id,hero,wallet,base_prize,holder_tier,holder_bonus_percent,holder_bonus,total_reward,claim_status,tx_hash");
    expect(text.split("\r\n")[1]).toContain(`"'=HYPERLINK(""http://evil.example"")"`); // a hero named like a formula cannot run in a spreadsheet
    expect((await admin("GET", "picks/boards/DAILY/not-a-date/payout")).status).toBe(404);
    expect((await admin("GET", "picks/boards/HOURLY/2026-10-06/payout")).status).toBe(404);
    expect((await admin("POST", path, { json: {} })).status).toBeGreaterThanOrEqual(404); // read-only: there is no way to write a payout
  });

  it("the economy: maximum liabilities and the Season 1 plan are served to admins (and only to admins)", async () => {
    const o = (await (await admin("GET", "picks/overview")).json()).overview;
    expect(o.economy.daily).toEqual({ basePool: "100,000", maxBonusExposure: "25,000", maxLiability: "125,000" });
    expect(o.economy.weekly).toEqual({ basePool: "500,000", maxBonusExposure: "125,000", maxLiability: "625,000" });
    expect(o.economy.season).toMatchObject({ baseMaximum: "14,400,000", maximumWithBonuses: "18,000,000", allocation: "20,000,000", buffer: "2,000,000", fits: true });
    expect((await admin("GET", "picks/overview", { cookie: null })).status).toBe(401);
  });

  it("holders: connected wallets, due and overdue checks, failures, stale, and the Daily / Weekly qualification — without any secret", async () => {
    const cookie = await session(4500);
    const holder = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    chain.setBalance(holder.address, chainTokens(1_000_000));
    const ch = await (await call((await import("@/app/api/me/rewards/holder/challenge/route")).POST, req("/api/me/rewards/holder/challenge", { json: { address: holder.address }, cookie }))).json();
    await call((await import("@/app/api/me/rewards/holder/verify/route")).POST, req("/api/me/rewards/holder/verify", { json: { nonce: ch.nonce, signature: await holder.signMessage({ message: ch.message }) }, cookie }));
    const h = (await (await admin("GET", "picks/holders")).json()).holders;
    expect(h).toMatchObject({ connectedWallets: 1, dueForRefresh: 0, overdue: 0, withFailures: 0, staleOverMaxAge: 0, holderMaxAgeHours: 6, refreshMinutes: 30, batchSize: 25 });
    expect(h.accounts[0]).toMatchObject({ telegramUserId: 4500, observedTier: "1M HOLDER", balance: "1,000,000", failures: 0, stale: false, daily: { status: "QUALIFYING", tier: "1M" }, weekly: { status: "QUALIFYING", tier: "1M" } });
    expect(h.accounts[0].nextCheckAt).toBeGreaterThan(Date.now() + 20 * 60_000);
    chain.failNext();
    await call((await import("@/app/api/me/rewards/holder/refresh/route")).POST, req("/api/me/rewards/holder/refresh", { json: {}, cookie }));
    const after = (await (await admin("GET", "picks/holders")).json()).holders;
    expect(after).toMatchObject({ withFailures: 1 });
    expect(after.accounts[0]).toMatchObject({ failures: 1, lastError: expect.stringContaining("simulated outage") });
    expect(JSON.stringify(after)).not.toContain(TREASURY_KEY.slice(2));
  });

  it("token: the contract (public, copyable), metadata AUTO-DETECTED from the contract (symbol, decimals — nothing typed), Verified/Failed, RPC Available/Unavailable — names and status only", async () => {
    const t = (await (await admin("GET", "picks/token?fresh=1")).json()).token;
    expect(t).toMatchObject({ launched: true, contract: { status: "CONFIGURED", address: TOKEN }, metadata: { status: "VERIFIED", decimals: 18, symbol: "CLANKRPG", source: "CONTRACT" }, rpc: { status: "AVAILABLE", chainIdMatches: true }, adapter: "simulated", holderVerificationAvailable: true, claimsAvailable: true });
    // the CONTRACT is authoritative: a different decimals() is simply what is detected — there is no configured value to "mismatch"
    chain.setMetadata({ decimals: 6 });
    const six = (await (await admin("GET", "picks/token?fresh=1")).json()).token;
    expect(six).toMatchObject({ metadata: { status: "VERIFIED", decimals: 6 }, holderVerificationAvailable: true });
    expect(JSON.stringify(six)).not.toMatch(/mismatch/i);
    // a contract that cannot be verified closes holder verification and claims (fail closed); the warning says why
    chain.setMetadata(null);
    const bad = (await (await admin("GET", "picks/token?fresh=1")).json()).token;
    expect(bad).toMatchObject({ metadata: { status: "FAILED" }, holderVerificationAvailable: false, claimsAvailable: false });
    expect(bad.warnings.join(" ")).toMatch(/could not be verified/);
    chain.setMetadata({ decimals: 18 });
    chain.setOutage(true);
    const down = (await (await admin("GET", "picks/token?fresh=1")).json()).token;
    expect(down.rpc).toMatchObject({ status: "UNAVAILABLE" });
    expect(down.warnings.join(" ")).toMatch(/RPC is unavailable/);
    expect(JSON.stringify([t, bad, down])).not.toContain(TREASURY_KEY.slice(2));
  });

  it("the QA-only simulation endpoints exist ONLY with the simulated chain (a real chain refuses them)", async () => {
    expect((await admin("POST", "picks/sim/balance", { json: { address: WALLET_A, amount: "5" } })).status).toBe(200);
    setChainReaderForTests(null);
    expect((await admin("POST", "picks/sim/balance", { json: { address: WALLET_A, amount: "5" } })).status).toBe(409);
    expect((await admin("POST", "picks/sim/transfer", { json: { to: WALLET_A, amount: "5" } })).status).toBe(409);
    expect((await admin("POST", "picks/sim/outage", { json: { on: true } })).status).toBe(409);
  });

  it("sim/outage switches the simulated RPC off and on (QA seam for PENDING VERIFICATION) and validates its body", async () => {
    expect((await admin("POST", "picks/sim/outage", { json: { on: "yes" } })).status).toBe(422);
    expect((await admin("POST", "picks/sim/outage", { json: { on: true, extra: 1 } })).status).toBe(422);
    expect((await admin("POST", "picks/sim/outage", { json: { on: true } })).status).toBe(200);
    await expect(chain.balanceOf(WALLET_A)).rejects.toThrow();
    expect((await admin("POST", "picks/sim/outage", { json: { on: false } })).status).toBe(200);
    await expect(chain.balanceOf(WALLET_A)).resolves.toBeTypeOf("bigint");
  });
});
