import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { newSession, signSession, verifySession } from "@/server/auth/session";
import { signTelegramLoginPayload, verifyTelegramLogin } from "@/server/auth/telegramLogin";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { buildWalletMessage, normalizeAddress, verifyWalletSignature } from "@/server/auth/wallet";
import type { Db } from "@/server/db/types";
import { claimCharacter, createWalletChallenge, loginWithTelegram, unlinkWallet, verifyWalletLink } from "@/server/services/identity";

import { count, createTestDb, insertStubHero, resetDb, seedHeroes } from "../support/db";

const BOT_TOKEN = "123456789:AAExampleBotTokenForTestsOnly_abcdefghijk";
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

const widget = (id: number, over: Record<string, string | number> = {}, authDate = Math.floor(NOW / 1000)) =>
  signTelegramLoginPayload({ id, first_name: "Ada", username: "ada_l", auth_date: authDate, ...over }, BOT_TOKEN);

describe("Telegram Login verification", () => {
  it("accepts a correctly signed, fresh payload and returns the immutable numeric id", () => {
    const v = verifyTelegramLogin(widget(4242), BOT_TOKEN, NOW);
    expect(v).toMatchObject({ ok: true, user: { id: 4242, username: "ada_l", displayName: "Ada" } });
  });
  it("rejects tampered fields (e.g. swapping the id to take over someone else's hero)", () => {
    const p = widget(4242);
    expect(verifyTelegramLogin({ ...p, id: 9999 }, BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyTelegramLogin({ ...p, username: "someone_else" }, BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("rejects a payload signed with a different bot token", () => {
    const forged = signTelegramLoginPayload({ id: 1, auth_date: Math.floor(NOW / 1000) }, "999:other-bot-token-xxxxxxxxxxxxxxxxxxxxxxxx");
    expect(verifyTelegramLogin(forged, BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("rejects expired and future-dated payloads", () => {
    expect(verifyTelegramLogin(widget(1, {}, Math.floor(NOW / 1000) - 3600), BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: "EXPIRED" });
    expect(verifyTelegramLogin(widget(1, {}, Math.floor(NOW / 1000) + 3600), BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: "FROM_FUTURE" });
  });
  it("rejects malformed payloads without throwing", () => {
    for (const bad of [null, "x", 5, {}, { id: "abc", hash: "z", auth_date: 1 }, { id: 1, auth_date: 1 }]) {
      expect(verifyTelegramLogin(bad, BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: "MALFORMED" });
    }
  });
});

describe("login → claim", () => {
  const login = (id: number, over = {}, now = NOW) => loginWithTelegram(db, widget(id, over), { botToken: BOT_TOKEN, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold, nowMs: now });

  it("a login payload can only be used once (replay protection)", async () => {
    const payload = widget(5001);
    expect((await loginWithTelegram(db, payload, { botToken: BOT_TOKEN, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold, nowMs: NOW })).ok).toBe(true);
    expect(await loginWithTelegram(db, payload, { botToken: BOT_TOKEN, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold, nowMs: NOW })).toMatchObject({ ok: false, reason: "REPLAYED" });
  });

  it("only the SAME Telegram id can claim its hero; claiming is idempotent", async () => {
    const [heroId] = await seedHeroes(db, 1, { startId: 7001 });
    const l = await login(7001);
    expect(l).toMatchObject({ ok: true, telegramUserId: 7001, characterId: heroId, claimed: false });
    const first = await claimCharacter(db, 7001, new Date(NOW));
    expect(first).toEqual({ ok: true, characterId: heroId, alreadyClaimed: false });
    expect(await claimCharacter(db, 7001, new Date(NOW))).toEqual({ ok: true, characterId: heroId, alreadyClaimed: true });
    expect(await count(db, "character_claims")).toBe(1);
  });

  it("a different Telegram id cannot claim someone else's hero (username is never trusted)", async () => {
    const [heroId] = await seedHeroes(db, 1, { startId: 7002 });
    await db.query("update public.telegram_users set username = 'victim' where telegram_user_id = 7002");
    // Attacker signs in with the SAME username text but a different numeric id.
    const attacker = await login(8002, { username: "victim", first_name: "Impostor" });
    expect(attacker).toMatchObject({ ok: true, characterId: null });
    expect(await claimCharacter(db, 8002, new Date(NOW))).toEqual({ ok: false, reason: "NO_HERO" });
    expect(await count(db, "character_claims")).toBe(0);
    // The DB itself refuses a second claimant even if application code were bypassed.
    await db.query("insert into public.character_claims (character_id, telegram_user_id, auth_date) values ($1, 7002, now())", [heroId]);
    await expect(db.query("insert into public.telegram_users (telegram_user_id, display_name) values (8002, 'x') on conflict do nothing")).resolves.toBeDefined();
    await expect(db.query("insert into public.character_claims (character_id, telegram_user_id, auth_date) values ($1, 8002, now())", [heroId])).rejects.toThrow();
  });

  it("logging in without a hero reports progress and creates no hero", async () => {
    const l = await login(7003);
    expect(l).toMatchObject({ ok: true, characterId: null, claimed: false });
    expect(await count(db, "characters")).toBe(0);
  });

  it("banned members cannot sign in", async () => {
    await seedHeroes(db, 1, { startId: 7004 });
    await db.query("update public.telegram_users set status = 'BANNED' where telegram_user_id = 7004");
    expect(await login(7004)).toMatchObject({ ok: false, reason: "BANNED" });
  });

  it("special characters cannot be claimed through the community flow", async () => {
    await db.query("insert into public.telegram_users (telegram_user_id, display_name) values (7005, 'x')");
    const [cls] = await db.query<{ id: string }>("select id from public.character_classes limit 1");
    const h = await insertStubHero(db, { kind: "SPECIAL_CHARACTER", telegram_user_id: 7005, class_id: cls!.id, name: "Staff", origin: "ADMIN" });
    expect(h).toBeDefined();
    expect(await claimCharacter(db, 7005, new Date(NOW))).toEqual({ ok: false, reason: "NOT_COMMUNITY_HERO" });
  });
});

describe("signed sessions", () => {
  const secret = "s".repeat(40);
  const good = signSession(newSession("user", 42, 0, 3600, NOW), secret);
  it("round-trips, and rejects tampering, wrong secrets, wrong type and expiry", () => {
    expect(verifySession(good, secret, "user", NOW)).toMatchObject({ sub: 42, ep: 0 });
    const [body, mac] = good.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ typ: "user", sub: 1, ep: 0, iat: 1, exp: 9_999_999_999 })).toString("base64url");
    expect(verifySession(`${forgedBody}.${mac}`, secret, "user", NOW)).toBeNull();
    expect(verifySession(`${body}.${mac!.slice(0, -2)}xx`, secret, "user", NOW)).toBeNull();
    expect(verifySession(good, "x".repeat(40), "user", NOW)).toBeNull();
    expect(verifySession(good, secret, "admin", NOW)).toBeNull();
    expect(verifySession(good, secret, "user", NOW + 3601 * 1000)).toBeNull();
    for (const junk of ["", "abc", "a.b.c", ".", `${body}.`, "x".repeat(5000)]) expect(verifySession(junk, secret, "user", NOW)).toBeNull();
    expect(verifySession(undefined, secret, "user", NOW)).toBeNull();
  });
  it("a user token can never act as an admin token", () => {
    expect(verifySession(good, secret, "admin", NOW)).toBeNull();
  });
});

describe("wallet signature verification", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());

  async function claimedHero(tid: number) {
    const [id] = await seedHeroes(db, 1, { startId: tid });
    await claimCharacter(db, tid, new Date(NOW));
    return id!;
  }

  it("links a wallet only with a valid signature over the server-issued challenge", async () => {
    const hero = await claimedHero(9001);
    const ch = await createWalletChallenge(db, hero, account.address, 4663, new Date(NOW));
    expect(ch.ok).toBe(true);
    if (!ch.ok) return;
    const signature = await account.signMessage({ message: ch.message });
    const linked = await verifyWalletLink(db, hero, ch.nonce, signature, new Date(NOW + 1000));
    expect(linked).toEqual({ ok: true, address: account.address.toLowerCase(), replaced: null });
    expect((await db.query<{ address: string }>("select address from public.wallet_links where character_id = $1 and unlinked_at is null", [hero]))[0]!.address).toBe(account.address.toLowerCase());
  });

  it("rejects a signature from a different wallet (forged ownership)", async () => {
    const hero = await claimedHero(9002);
    const ch = await createWalletChallenge(db, hero, account.address, 4663, new Date(NOW));
    if (!ch.ok) throw new Error("challenge");
    const forged = await stranger.signMessage({ message: ch.message });
    expect(await verifyWalletLink(db, hero, ch.nonce, forged, new Date(NOW))).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(await count(db, "wallet_links")).toBe(0);
  });

  it("rejects a valid signature over a DIFFERENT message (the server only trusts its own challenge text)", async () => {
    const hero = await claimedHero(9003);
    const ch = await createWalletChallenge(db, hero, account.address, 4663, new Date(NOW));
    if (!ch.ok) throw new Error("challenge");
    const other = await account.signMessage({ message: "I am the owner of this hero, trust me" });
    expect(await verifyWalletLink(db, hero, ch.nonce, other, new Date(NOW))).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("challenges are single-use, expiring, and bound to the requesting hero", async () => {
    const hero = await claimedHero(9004);
    const other = await claimedHero(9005);
    const ch = await createWalletChallenge(db, hero, account.address, 4663, new Date(NOW));
    if (!ch.ok) throw new Error("challenge");
    const sig = await account.signMessage({ message: ch.message });
    // another hero cannot redeem it
    expect(await verifyWalletLink(db, other, ch.nonce, sig, new Date(NOW))).toEqual({ ok: false, reason: "NO_CHALLENGE" });
    // expired
    expect(await verifyWalletLink(db, hero, ch.nonce, sig, new Date(NOW + 11 * 60_000))).toEqual({ ok: false, reason: "EXPIRED" });
    // success once ...
    expect((await verifyWalletLink(db, hero, ch.nonce, sig, new Date(NOW + 1000))).ok).toBe(true);
    // ... never twice (replay)
    expect(await verifyWalletLink(db, hero, ch.nonce, sig, new Date(NOW + 2000))).toEqual({ ok: false, reason: "ALREADY_USED" });
  });

  it("a wallet can back only ONE hero", async () => {
    const a = await claimedHero(9006);
    const b = await claimedHero(9007);
    const cha = await createWalletChallenge(db, a, account.address, 4663, new Date(NOW));
    if (!cha.ok) throw new Error("challenge");
    await verifyWalletLink(db, a, cha.nonce, await account.signMessage({ message: cha.message }), new Date(NOW));
    expect(await createWalletChallenge(db, b, account.address, 4663, new Date(NOW))).toEqual({ ok: false, reason: "ADDRESS_IN_USE" });
  });

  it("requires a claimed hero and a valid address", async () => {
    const [unclaimed] = await seedHeroes(db, 1, { startId: 9008 });
    expect(await createWalletChallenge(db, unclaimed!, account.address, 4663, new Date(NOW))).toEqual({ ok: false, reason: "NOT_CLAIMED" });
    const hero = await claimedHero(9009);
    expect(await createWalletChallenge(db, hero, "0x123", 4663, new Date(NOW))).toEqual({ ok: false, reason: "BAD_ADDRESS" });
    expect(await createWalletChallenge(db, hero, "not an address", 4663, new Date(NOW))).toEqual({ ok: false, reason: "BAD_ADDRESS" });
  });

  it("relinking a different wallet resets holding state; unlink clears wallet bonuses", async () => {
    const hero = await claimedHero(9010);
    const link = async (acct: typeof account) => {
      const ch = await createWalletChallenge(db, hero, acct.address, 4663, new Date(NOW));
      if (!ch.ok) throw new Error("challenge");
      return verifyWalletLink(db, hero, ch.nonce, await acct.signMessage({ message: ch.message }), new Date(NOW));
    };
    await link(account);
    await db.query("update public.character_stats set holdings_bonus = '{\"def\": 3}'::jsonb where character_id = $1", [hero]);
    const re = await link(stranger);
    expect(re).toMatchObject({ ok: true, replaced: account.address.toLowerCase() });
    expect(await unlinkWallet(db, hero, new Date(NOW))).toBe(true);
    expect((await db.query<{ holdings_bonus: object }>("select holdings_bonus from public.character_stats where character_id = $1", [hero]))[0]!.holdings_bonus).toEqual({});
    expect(await unlinkWallet(db, hero, new Date(NOW))).toBe(false);
  });

  it("pure helpers: message format, address normalisation and recovery", async () => {
    const msg = buildWalletMessage({ heroName: "Ada", address: account.address.toLowerCase(), chainId: 4663, nonce: "n".repeat(24), issuedAt: new Date(NOW), expiresAt: new Date(NOW + 600_000) });
    expect(msg).toContain("Chain ID: 4663");
    expect(msg).toContain(`Nonce: ${"n".repeat(24)}`);
    expect(normalizeAddress(account.address)).toBe(account.address.toLowerCase());
    expect(normalizeAddress("0xZZ")).toBeNull();
    const sig = await account.signMessage({ message: msg });
    expect(await verifyWalletSignature(msg, sig, account.address)).toBe(true);
    expect(await verifyWalletSignature(msg + "!", sig, account.address)).toBe(false);
    expect(await verifyWalletSignature(msg, "0xdeadbeef", account.address)).toBe(false);
  });
});
