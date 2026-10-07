import { z } from "zod";

import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_S, newSession, signSession } from "@/server/auth/session";
import { safeEqual } from "@/server/crypto";
import type { Db } from "@/server/db/types";
import { demoHeroesAllowed, getEnv, getSecret } from "@/server/env";
import { clearCookieHeader, clientKey, cookieHeader, fail, isAdmin, ok, rateLimited, readBytes, readJson, sameOriginOk } from "@/server/http/guards";
import { ensureArenaAdvanced, getEnabledClasses, getIngestDeps, getProviders, getReadyDb, getSettings, invalidateArenaCaches, invalidateConfigCache, invalidateFlagCache } from "@/server/runtime";
import * as rewardsAdmin from "@/server/rewards/admin";
import { getChainReader, getTokenHealth, getTokenStatus } from "@/server/rewards/context";
import { buyUrl } from "@/domain/rewards/buyLink";
import { heroUrl } from "@/domain/hero/publicId";
import { cachedTokenMetadata, currentTokenMetadata, verifiedTokenMetadata } from "@/server/rewards/tokenMetadata";
import { DENIAL_REASON_CODES, type DenialReason } from "@/domain/rewards/claims";
import { payoutCsv } from "@/domain/rewards/payout";
import { finalizeDueBoards } from "@/server/rewards/leaderboard";
import { isPeriodKind, isPeriodStart } from "@/domain/rewards/time";
import * as admin from "@/server/services/admin";
import * as lifecycle from "@/server/services/lifecycle";
import { AdminError } from "@/server/services/admin";
import { arenaOps } from "@/server/services/arenaOps";
import { getHeroDetail, searchHeroes } from "@/server/services/heroAdmin";
import { applyRerollPreview, getHeroVersioning, heroCardFor, HeroVersionError, previewReroll, rollbackHero, versionCard, type HeroVersioningDeps } from "@/server/services/heroVersions";
import { renderHeroCardPng } from "@/server/heroes/cardImage";
import { getHeroPhotoAdminView, loadTelegramPhotoBytes, removeAdminPhoto, setAdminPhoto } from "@/server/services/heroPhotos";
import { createBotApiPhotoSource, syncTelegramPhoto } from "@/server/services/telegramPhotos";
import { getAvatarStore } from "@/server/storage";
import { AVATAR_MAX_BYTES } from "@/domain/media/image";
import { scanCatalog } from "@/server/services/tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const ACTOR = "admin";

interface Ctx {
  req: Request;
  db: Db;
  url: URL;
  seg: string[];
}
type Handler = (c: Ctx) => Promise<Response>;

const json = async <S extends z.ZodType>(c: Ctx, schema: S, max?: number) => readJson(c.req, schema, max);

const uuid = z.string().uuid();

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
const route = (method: string, path: string, handler: Handler) =>
  routes.push({ method, pattern: new RegExp(`^${path.replace(/:[a-z]+/g, "([^/]+)")}$`), handler });

route("GET", "overview", async (c) => ok(await admin.adminOverview(c.db, demoHeroesAllowed())));
route("GET", "telegram/eligibility", async (c) => ok(await admin.telegramEligibilityOverview(c.db)));

const oneOf = <T extends string>(v: string | null, allowed: readonly T[]): T | undefined => (v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);

route("GET", "heroes", async (c) => {
  const sp = c.url.searchParams;
  const claimed = oneOf(sp.get("claimed"), ["claimed", "unclaimed"] as const);
  const kind = oneOf(sp.get("kind"), ["COMMUNITY", "SPECIAL_CHARACTER"] as const);
  const status = oneOf(sp.get("status"), ["ACTIVE", "INACTIVE", "SUSPENDED"] as const);
  const renamed = oneOf(sp.get("renamed"), ["renamed", "original"] as const);
  const sort = oneOf(sp.get("sort"), ["newest", "name", "power", "power_asc"] as const);
  return ok(
    await searchHeroes(c.db, {
      ...(sp.get("search") ? { search: (sp.get("search") as string).slice(0, 80) } : {}),
      ...(claimed ? { claimed } : {}),
      ...(sp.get("class") ? { classId: (sp.get("class") as string).slice(0, 40) } : {}),
      ...(sp.get("rarity") ? { rarity: (sp.get("rarity") as string).slice(0, 20) } : {}),
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(renamed ? { renamed } : {}),
      ...(sort ? { sort } : {}),
      limit: Number(sp.get("limit") ?? 50) || 50,
      offset: Number(sp.get("offset") ?? 0) || 0,
    }),
  );
});
route("GET", "heroes/:id", async (c) => {
  if (!uuid.safeParse(c.seg[1]).success) return fail("NOT_FOUND", 404);
  const hero = await getHeroDetail(c.db, c.seg[1] as string);
  return hero ? ok({ hero }) : fail("NOT_FOUND", 404);
});
// Rename = presentation only. The hero is resolved from the URL id and re-checked in the database; nothing else is writable here.
route("PUT", "heroes/:id/name", async (c) => {
  if (!uuid.safeParse(c.seg[1]).success) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ name: z.string().max(200).nullable() }), 2_000);
  if (!body.ok) return body.response;
  return ok(await admin.renameHero(c.db, c.seg[1] as string, body.data.name, ACTOR));
});

// --- hero versions: card, history, REROLL (preview → apply) and ROLLBACK ---------------------------------------------------
// ADMIN ONLY (the dispatcher requires the admin session and a same-origin request for every non-GET). The browser can only NAME a preview it was
// shown or a version it saw: the seed, class, rarity, stats and look are always drawn / read on the server. No cost, cooldown or cap anywhere.
async function versioningDeps(): Promise<HeroVersioningDeps> {
  return { settings: await getSettings(), classes: await getEnabledClasses(), secret: getSecret("CLASS_ROLL_SECRET") };
}
const heroId = (c: Ctx): string | null => (uuid.safeParse(c.seg[1]).success ? (c.seg[1] as string) : null);

route("GET", "heroes/:id/versions", async (c) => {
  const id = heroId(c);
  if (!id) return fail("NOT_FOUND", 404);
  const deps = await versioningDeps();
  const origin = getEnv().NEXT_PUBLIC_APP_URL;
  const versioning = await getHeroVersioning(c.db, id, demoHeroesAllowed());
  return ok({ versioning, card: await heroCardFor(c.db, id, deps), publicUrl: heroUrl(origin, versioning.publicId) });
});
route("GET", "heroes/:id/versions/:vid/card", async (c) => {
  const id = heroId(c);
  if (!id || !uuid.safeParse(c.seg[3]).success) return fail("NOT_FOUND", 404);
  return ok(await versionCard(c.db, id, c.seg[3] as string, await versioningDeps()));
});
// The current card as a 1200×1200 PNG, for ANY hero (public visibility does not apply to the admin console).
route("GET", "heroes/:id/card-image", async (c) => {
  const id = heroId(c);
  if (!id) return fail("NOT_FOUND", 404);
  const deps = await versioningDeps();
  const card = await heroCardFor(c.db, id, deps);
  const png = await renderHeroCardPng(card, { spriteSet: deps.settings.visuals.spriteSet });
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="clank-rpg-hero-${card.publicId}.png"` } });
});
route("POST", "heroes/:id/reroll/preview", async (c) => {
  const id = heroId(c);
  if (!id) return fail("NOT_FOUND", 404);
  if (rateLimited(`herorerollpreview:${clientKey(c.req)}`, 120, 60_000)) return fail("RATE_LIMITED", 429);
  const body = await json(c, z.strictObject({}), 200);
  if (!body.ok) return body.response;
  return ok({ preview: await previewReroll(c.db, id, ACTOR, await versioningDeps()) });
});
route("POST", "heroes/:id/reroll/apply", async (c) => {
  const id = heroId(c);
  if (!id) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ previewId: uuid }), 500);
  if (!body.ok) return body.response;
  return ok({ result: await applyRerollPreview(c.db, id, body.data.previewId, ACTOR, await versioningDeps()) });
});
route("POST", "heroes/:id/rollback", async (c) => {
  const id = heroId(c);
  if (!id) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ versionId: uuid, expectedCurrentVersionId: uuid, requestId: uuid }), 800);
  if (!body.ok) return body.response;
  return ok({ result: await rollbackHero(c.db, { characterId: id, targetVersionId: body.data.versionId, expectedCurrentVersionId: body.data.expectedCurrentVersionId, requestId: body.data.requestId }, ACTOR, await versioningDeps()) });
});

// --- profile photo -----------------------------------------------------------------------------------------------
// Admin only (the dispatcher already requires the admin session and a same-origin request for every non-GET). The hero is
// taken from the URL and re-checked in the database; the image is validated from its BYTES, never from its claimed type.
const photoStore = () => getAvatarStore();
const STORAGE_OFF = () => fail("STORAGE_NOT_CONFIGURED", 503, "Photo storage is not configured on this server (see docs/HERO_PROFILE_PHOTOS.md).");

route("PUT", "heroes/:id/photo", async (c) => {
  if (!uuid.safeParse(c.seg[1]).success) return fail("NOT_FOUND", 404);
  const store = photoStore();
  if (!store) return STORAGE_OFF();
  const body = await readBytes(c.req, AVATAR_MAX_BYTES);
  if (!body.ok) return body.response;
  const result = await setAdminPhoto(c.db, store, { characterId: c.seg[1] as string, bytes: body.bytes, declaredMime: c.req.headers.get("content-type"), actor: ACTOR });
  return ok({ photo: result, view: await getHeroPhotoAdminView(c.db, c.seg[1] as string) });
});
route("DELETE", "heroes/:id/photo", async (c) => {
  if (!uuid.safeParse(c.seg[1]).success) return fail("NOT_FOUND", 404);
  const store = photoStore();
  if (!store) return STORAGE_OFF();
  const result = await removeAdminPhoto(c.db, store, c.seg[1] as string, ACTOR);
  return ok({ ...result, view: await getHeroPhotoAdminView(c.db, c.seg[1] as string) });
});
// Preview of the cached Telegram photo even while an admin override is the one on screen.
route("GET", "heroes/:id/photo/telegram", async (c) => {
  if (!uuid.safeParse(c.seg[1]).success) return fail("NOT_FOUND", 404);
  const store = photoStore();
  const photo = store ? await loadTelegramPhotoBytes(c.db, store, c.seg[1] as string) : null;
  if (!photo) return fail("NOT_FOUND", 404);
  return new Response(photo.bytes as BodyInit, { headers: { "Content-Type": photo.mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, max-age=300" } });
});
// Ask Telegram for this member's current profile photo now (admin convenience; the scheduler does the same in bulk).
route("POST", "heroes/:id/photo/telegram-refresh", async (c) => {
  if (!uuid.safeParse(c.seg[1]).success) return fail("NOT_FOUND", 404);
  const store = photoStore();
  if (!store) return STORAGE_OFF();
  const token = getEnv().TELEGRAM_BOT_TOKEN;
  const [row] = await c.db.query<{ telegram_user_id: number | null; is_demo: boolean }>("select telegram_user_id, is_demo from public.characters where id = $1", [c.seg[1]]);
  if (!row) return fail("NOT_FOUND", 404);
  if (row.telegram_user_id === null || row.is_demo) return ok({ result: { status: "NO_TELEGRAM_IDENTITY" }, view: await getHeroPhotoAdminView(c.db, c.seg[1] as string) });
  if (!token) return ok({ result: { status: "NOT_CONFIGURED" }, view: await getHeroPhotoAdminView(c.db, c.seg[1] as string) });
  const result = await syncTelegramPhoto(c.db, store, createBotApiPhotoSource({ token }), Number(row.telegram_user_id), { force: true });
  await admin.audit(c.db, ACTOR, "hero.photo.telegram_refresh", "character", c.seg[1] as string, { status: result.status });
  return ok({ result, view: await getHeroPhotoAdminView(c.db, c.seg[1] as string) });
});

route("PUT", "heroes/:id/note", async (c) => {
  if (!uuid.safeParse(c.seg[1]).success) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ note: z.string().max(2_000).nullable() }), 4_000);
  if (!body.ok) return body.response;
  await admin.setHeroNote(c.db, c.seg[1] as string, body.data.note, ACTOR);
  return ok({});
});
route("PATCH", "heroes/:id", async (c) => {
  if (!uuid.safeParse(c.seg[1]).success) return fail("NOT_FOUND", 404);
  const body = await json(c, z.record(z.string(), z.unknown()));
  if (!body.ok) return body.response;
  await admin.patchHero(c.db, c.seg[1] as string, body.data, ACTOR);
  return ok({});
});
route("POST", "special", async (c) => {
  const body = await json(c, z.record(z.string(), z.unknown()));
  if (!body.ok) return body.response;
  return ok(await admin.createSpecialCharacter(c.db, body.data, ACTOR), { status: 201 });
});

route("GET", "telegram/users", async (c) =>
  ok({
    users: await admin.listTelegramUsers(c.db, {
      ...(c.url.searchParams.get("status") ? { status: c.url.searchParams.get("status") as string } : {}),
      ...(c.url.searchParams.get("search") ? { search: c.url.searchParams.get("search") as string } : {}),
    }),
  }),
);
route("POST", "telegram/users/:id/status", async (c) => {
  const id = Number(c.seg[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ status: z.enum(["OK", "FLAGGED", "BANNED"]), reason: z.string().max(200).nullable().optional() }));
  if (!body.ok) return body.response;
  await admin.setTelegramStatus(c.db, id, body.data.status, body.data.reason ?? null, ACTOR, await getIngestDeps());
  return ok({});
});
route("POST", "telegram/import", async (c) => {
  // Large exports (100 MB+) should use `pnpm telegram:import`; serverless bodies are small.
  const body = await json(c, z.strictObject({ export: z.unknown(), chatId: z.number().int().optional() }), 4_000_000);
  if (!body.ok) return body.response;
  return ok(await admin.importTelegramExportJson(c.db, body.data.export, await getIngestDeps(), ACTOR, body.data.chatId));
});

route("GET", "config", async (c) => ok(await admin.getAllConfig(c.db)));
route("PUT", "settings/:key", async (c) => {
  const body = await json(c, z.strictObject({ value: z.unknown() }), 200_000);
  if (!body.ok) return body.response;
  const saved = await admin.putSetting(c.db, c.seg[1] as string, body.data.value, ACTOR);
  invalidateConfigCache();
  return ok({ value: saved });
});
route("PUT", "classes/:id", async (c) => {
  const body = await json(c, z.strictObject({ definition: z.unknown(), enabled: z.boolean().optional() }), 200_000);
  if (!body.ok) return body.response;
  await admin.putClass(c.db, c.seg[1] as string, body.data.definition, body.data.enabled, ACTOR);
  invalidateConfigCache();
  return ok({});
});
route("PUT", "skills/:id", async (c) => {
  const body = await json(c, z.strictObject({ definition: z.unknown() }), 200_000);
  if (!body.ok) return body.response;
  await admin.putSkill(c.db, c.seg[1] as string, body.data.definition, ACTOR);
  invalidateConfigCache();
  return ok({});
});

route("GET", "seasons", async (c) => ok({ seasons: await admin.listSeasons(c.db) }));

// --- GAME CONTROL: the game phase, the seasons and the Arena's runtime state. Every action is one locked, audited transaction (services/lifecycle.ts);
// the destructive ones need the typed phrase (the server checks it again — the console only enables the button). There is NO route that sets the phase
// or a season row directly, and none that goes back from LIVE to DEVELOPMENT.
const lifecycleDeps = () => ({ actor: ACTOR, allowDemo: demoHeroesAllowed() });
const confirmation = z.strictObject({ confirmation: z.string().max(60) });
route("GET", "game", async (c) => {
  // Looking at the console moves the Arena along, exactly like a viewer's request does (coalesced, idempotent, gated by the persisted status — a stopped
  // Arena does nothing): a pause that is draining, or a start that is preparing, never waits for someone to open the public page.
  void ensureArenaAdvanced().catch(() => undefined);
  return ok(await lifecycle.getGameControl(c.db, { allowDemo: demoHeroesAllowed() }));
});
route("POST", "game/launch", async (c) => {
  const body = await json(c, confirmation, 400);
  if (!body.ok) return body.response;
  const out = await lifecycle.launchSeason1(c.db, lifecycleDeps(), body.data);
  invalidateArenaCaches();
  return ok(out);
});
route("POST", "game/start", async (c) => {
  const out = await lifecycle.startArena(c.db, lifecycleDeps());
  invalidateArenaCaches();
  // Battle #1 is prepared by the next advance (the worker's, or a viewer's): kick one now, off the response path, so it is ready within moments.
  void ensureArenaAdvanced(0).catch(() => undefined);
  return ok(out);
});
route("POST", "game/pause", async (c) => {
  const out = await lifecycle.pauseArena(c.db, lifecycleDeps());
  invalidateArenaCaches();
  return ok(out);
});
route("POST", "game/resume", async (c) => {
  const out = await lifecycle.resumeArena(c.db, lifecycleDeps());
  invalidateArenaCaches();
  void ensureArenaAdvanced(0).catch(() => undefined);
  return ok(out);
});
route("POST", "game/reset", async (c) => {
  const body = await json(c, confirmation, 400);
  if (!body.ok) return body.response;
  const out = await lifecycle.resetDevelopment(c.db, lifecycleDeps(), body.data);
  invalidateArenaCaches();
  return ok(out);
});
route("POST", "game/end-season", async (c) => {
  const body = await json(c, confirmation, 400);
  if (!body.ok) return body.response;
  const out = await lifecycle.endSeason(c.db, lifecycleDeps(), body.data);
  invalidateArenaCaches();
  return ok(out);
});
route("POST", "game/create-season", async (c) => {
  const out = await lifecycle.createNextSeason(c.db, lifecycleDeps());
  invalidateArenaCaches();
  return ok(out);
});

route("GET", "arena", async (c) => ok({ ...(await admin.arenaOverview(c.db)), ops: await arenaOps(c.db, { now: Date.now(), allowDemo: demoHeroesAllowed(), groupSize: (await getSettings()).arena.groupSize }) }));
route("POST", "arena", async (c) => {
  const body = await json(c, z.strictObject({ action: z.enum(["pause", "resume", "void_unsettled", "abort_cycle"]) }));
  if (!body.ok) return body.response;
  await admin.arenaAdmin(c.db, body.data.action, ACTOR, { allowDemo: demoHeroesAllowed() });
  invalidateArenaCaches();
  return ok({});
});

route("GET", "items", async (c) => ok({ items: await admin.listItems(c.db) }));
route("PUT", "items", async (c) => {
  const body = await json(c, z.record(z.string(), z.unknown()));
  if (!body.ok) return body.response;
  await admin.putItem(c.db, body.data, ACTOR);
  return ok({});
});
route("GET", "achievements", async (c) => ok({ achievements: await admin.listAchievements(c.db) }));
route("PUT", "achievements", async (c) => {
  const body = await json(c, z.record(z.string(), z.unknown()));
  if (!body.ok) return body.response;
  await admin.putAchievement(c.db, body.data, ACTOR);
  return ok({});
});

route("GET", "flags", async (c) => ok({ flags: await admin.listFlags(c.db) }));
route("PUT", "flags/:key", async (c) => {
  const body = await json(c, z.strictObject({ enabled: z.boolean() }));
  if (!body.ok) return body.response;
  await admin.setFlag(c.db, decodeURIComponent(c.seg[1] as string), body.data.enabled, ACTOR);
  invalidateFlagCache();
  return ok({});
});

route("GET", "tokens", async (c) => ok({ tokens: await admin.listTokens(c.db) }));
route("POST", "tokens/scan", async (c) => {
  const env = getEnv();
  const { catalog, reader } = getProviders();
  const summary = await scanCatalog(c.db, catalog, { chainId: env.ROBINHOOD_CHAIN_ID, maxPages: 60, autoApprove: Boolean(env.CLANK_AUTO_APPROVE_BONDED), reader });
  await admin.audit(c.db, ACTOR, "token.scan", "catalog", null, summary);
  return ok({ summary });
});
route("POST", "tokens/:id/status", async (c) => {
  if (!uuid.safeParse(c.seg[1]).success) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ status: z.enum(["CANDIDATE", "ELIGIBLE", "REJECTED", "DELISTED"]) }));
  if (!body.ok) return body.response;
  await admin.adminSetTokenStatus(c.db, c.seg[1] as string, body.data.status, ACTOR);
  return ok({});
});

route("GET", "bosses", async (c) => ok({ bosses: await admin.listBossDrafts(c.db) }));
route("POST", "bosses/:id/decision", async (c) => {
  if (!uuid.safeParse(c.seg[1]).success) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ decision: z.enum(["APPROVED", "REJECTED"]) }));
  if (!body.ok) return body.response;
  await admin.decideBossDraft(c.db, c.seg[1] as string, body.data.decision, ACTOR);
  return ok({});
});

route("GET", "audit", async (c) => ok({ entries: await admin.listAudit(c.db) }));

// --- ARENA PICKS rewards (inspection + audited review/claim actions) ---------------------------------------------------
const limitOf = (c: Ctx) => Number(c.url.searchParams.get("limit") ?? 50) || 50;
// Reward amounts are LOGICAL (no decimals anywhere). Only holder balances / the treasury balance are CHAIN amounts: they use the contract's own decimals() — null until the token has launched and been verified.
const tokenDecimalsNow = async (db: Ctx["db"]): Promise<number | null> => (await currentTokenMetadata(db)).meta?.decimals ?? null;
route("GET", "picks/overview", async (c) => ok({ overview: await rewardsAdmin.rewardsOverview(c.db, { settings: await getSettings(), tokenDecimals: await tokenDecimalsNow(c.db), token: getTokenStatus(), reader: await getChainReader(), nowMs: Date.now() }) }));
route("GET", "picks/battles", async (c) => ok({ battles: await rewardsAdmin.listRecentBattles(c.db, limitOf(c)) }));
route("GET", "picks/claims", async (c) => {
  const status = c.url.searchParams.get("status");
  if (status !== null && !["PENDING", "SENT", "DENIED"].includes(status)) return fail("INVALID_STATUS", 422);
  return ok({
    claims: await rewardsAdmin.listClaims(c.db, { ...(status ? { status: status as rewardsAdmin.ClaimQueueStatus } : {}), limit: limitOf(c) }),
    counts: await rewardsAdmin.claimCounts(c.db),
    denialReasons: DENIAL_REASON_CODES,
  });
});
// MARK SENT: the admin supplies ONLY the transaction hash. The amount and destination are the claim's frozen ones, and the server
// verifies the transaction on-chain (read-only RPC) before the claim becomes SENT. Not verifiable → it stays PENDING (409/503).
const MARK_STATUS: Record<string, number> = { NOT_FOUND: 404, WRONG_STATE: 409, INVALID_HASH: 422, NEEDS_CHAIN: 503, CHAIN_UNAVAILABLE: 503, TOKEN_CONFIG_CHANGED: 409, TX_IN_USE: 409, TX_NOT_FOUND: 409, REVERTED: 409, WRONG_CHAIN: 409, WRONG_TOKEN: 409, WRONG_RECIPIENT: 409, WRONG_AMOUNT: 409, NOT_CONFIRMED: 409 };
route("POST", "picks/claims/:id/sent", async (c) => {
  if (!uuid.safeParse(c.seg[2]).success) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ txHash: z.string().min(10).max(80) }), 1_000);
  if (!body.ok) return body.response;
  const result = await rewardsAdmin.adminMarkClaimSent(c.db, { now: () => new Date() }, await getChainReader(), await getSettings(), { claimId: c.seg[2] as string, txHash: body.data.txHash }, ACTOR);
  return result.ok ? ok({ status: result.claim.status }) : fail(result.reason, MARK_STATUS[result.reason] ?? 409, result.detail);
});
route("POST", "picks/claims/:id/deny", async (c) => {
  if (!uuid.safeParse(c.seg[2]).success) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ reason: z.enum(DENIAL_REASON_CODES as [string, ...string[]]), note: z.string().trim().max(500).optional() }), 2_000);
  if (!body.ok) return body.response;
  const result = await rewardsAdmin.adminDenyClaim(c.db, { now: () => new Date() }, { claimId: c.seg[2] as string, reason: body.data.reason as DenialReason, ...(body.data.note ? { note: body.data.note } : {}) }, ACTOR);
  return result.ok ? ok({ status: result.claim.status, accountHeld: result.accountHeld }) : fail(result.reason, result.reason === "NOT_FOUND" ? 404 : result.reason === "REASON_REQUIRED" ? 422 : 409);
});

// DAILY + WEEKLY leaderboards (admin): the running periods, finalized boards with each Top-10 row's base prize / holder bonus / evidence, held
// prizes and pending bonuses. There is deliberately NO "reset leaderboard" route — periods end by the clock and history is immutable.
route("GET", "picks/boards", async (c) => ok({ boards: await rewardsAdmin.boardsAdminOverview(c.db, { settings: await getSettings(), nowMs: Date.now() }) }));
route("POST", "picks/boards/finalize", async (c) => {
  // Safe to re-run: finalizes only ENDED periods that are not finalized yet (never a running one, never a frozen one), then reconciles pending bonuses.
  const result = await finalizeDueBoards(c.db, { now: () => new Date(), settings: await getSettings() });
  await admin.audit(c.db, ACTOR, "rewards.boards_finalize", "arena_leaderboards", "sweep", { ...result });
  return ok({ result });
});
route("GET", "picks/boards/:kind/:start", async (c) => {
  const kind = (c.seg[2] ?? "").toUpperCase();
  if (!isPeriodKind(kind) || !isPeriodStart(kind, c.seg[3] ?? "")) return fail("NOT_FOUND", 404);
  return ok({ results: await rewardsAdmin.boardResultsAdmin(c.db, kind, c.seg[3] as string) });
});
// The exact payout of one finalized board: base prizes + qualified holder bonuses = the total to send by hand, one row per winner (claim
// status, wallet, tx hash). `?format=csv` downloads the same table as a CSV (amounts as plain decimals; player-controlled text is formula-safe).
route("GET", "picks/boards/:kind/:start/payout", async (c) => {
  const kind = (c.seg[2] ?? "").toUpperCase();
  if (!isPeriodKind(kind) || !isPeriodStart(kind, c.seg[3] ?? "")) return fail("NOT_FOUND", 404);
  const payout = await rewardsAdmin.boardPayout(c.db, kind, c.seg[3] as string);
  if (!payout) return fail("NOT_FINALIZED", 404, "That board has not been finalized yet.");
  if (c.url.searchParams.get("format") === "csv") {
    return new Response(payoutCsv(payout), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="clank-${kind.toLowerCase()}-payout-${c.seg[3]}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return ok({ payout });
});
route("POST", "picks/boards/:kind/:start/prizes/:user/resolve", async (c) => {
  const kind = (c.seg[2] ?? "").toUpperCase();
  const userId = Number(c.seg[5]);
  if (!isPeriodKind(kind) || !isPeriodStart(kind, c.seg[3] ?? "") || !Number.isSafeInteger(userId)) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ action: z.enum(["release", "forfeit"]), reason: z.string().trim().min(3).max(300) }), 2_000);
  if (!body.ok) return body.response;
  const result = await rewardsAdmin.adminResolveHeldPrize(c.db, { now: () => new Date() }, { kind, start: c.seg[3] as string, userId, ...body.data }, ACTOR);
  return result.ok ? ok({ status: result.status }) : fail(result.reason, result.reason === "NOT_FOUND" ? 404 : result.reason === "REASON_REQUIRED" ? 422 : 409);
});
// A holder bonus whose close verification failed waits PENDING VERIFICATION: re-verify it now, or give up on it. The base prize is never touched.
route("POST", "picks/boards/:kind/:start/bonuses/:user/reconcile", async (c) => {
  const kind = (c.seg[2] ?? "").toUpperCase();
  const userId = Number(c.seg[5]);
  if (!isPeriodKind(kind) || !isPeriodStart(kind, c.seg[3] ?? "") || !Number.isSafeInteger(userId)) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ action: z.enum(["reverify", "expire"]), reason: z.string().trim().max(300).default("") }), 2_000);
  if (!body.ok) return body.response;
  if (body.data.action === "expire" && body.data.reason.length < 3) return fail("REASON_REQUIRED", 422);
  const result = await rewardsAdmin.adminReconcileBonus(c.db, { now: () => new Date(), settings: await getSettings(), reader: await getChainReader() }, { kind, start: c.seg[3] as string, userId, ...body.data }, ACTOR);
  return result.ok ? ok({ outcome: result.outcome }) : fail(result.reason, 409);
});

// HOLDER VERIFICATION and TOKEN CONFIGURATION status (admin only; the contract address is public, nothing secret is ever shown).
route("GET", "picks/holders", async (c) => ok({ holders: await rewardsAdmin.holderOverview(c.db, { settings: await getSettings(), tokenDecimals: await tokenDecimalsNow(c.db), nowMs: Date.now() }) }));
route("GET", "picks/token", async (c) => {
  const status = getTokenStatus();
  const health = await getTokenHealth(c.url.searchParams.get("fresh") === "1").catch(() => null);
  // A successful check also persists what the contract reported (symbol, decimals, verified_at) for the other processes and the profile.
  if (health?.metadataStatus === "VERIFIED") await verifiedTokenMetadata(c.db, await getChainReader()).catch(() => null);
  return ok({ token: rewardsAdmin.tokenAdminStatus(status, health, await cachedTokenMetadata(c.db, status).catch(() => null)), buyUrl: buyUrl(status.publicAddress) });
});
route("GET", "picks/review", async (c) => ok(await rewardsAdmin.listReview(c.db)));
route("GET", "picks/accounts", async (c) => ok({ accounts: await rewardsAdmin.listAccounts(c.db, limitOf(c)) }));
route("GET", "picks/reconciliation", async (c) => ok({ issues: await rewardsAdmin.reconcileRewards(c.db, { now: new Date() }) }));
route("GET", "picks/accounts/:id", async (c) => {
  const id = Number(c.seg[2]);
  if (!Number.isSafeInteger(id)) return fail("NOT_FOUND", 404);
  const detail = await rewardsAdmin.getAccountDetail(c.db, id, { settings: await getSettings(), tokenDecimals: await tokenDecimalsNow(c.db), nowMs: Date.now() });
  return detail ? ok({ detail }) : fail("NOT_FOUND", 404);
});
// DEV/QA ONLY (refused unless the SIMULATED chain adapter is active — never on a real chain): set a simulated $CLANKRPG balance for an
// address, and create a simulated transfer (as if an admin had paid a claim by hand) so MARK SENT can be exercised without sending tokens.
route("POST", "picks/sim/balance", async (c) => {
  const body = await json(c, z.strictObject({ address: z.string().min(40).max(64), amount: z.string().regex(/^\d{1,18}(\.\d{1,18})?$/) }), 1_000);
  if (!body.ok) return body.response;
  const reader = await getChainReader();
  if (!reader || reader.adapter !== "simulated") return fail("NOT_SIMULATED", 409, "Only available with the simulated adapter.");
  const checked = (await import("@/domain/rewards/address")).checkRewardAddress(body.data.address);
  if (!checked.ok) return fail("INVALID_WALLET", 422);
  const meta = await reader.metadata().catch(() => null);
  if (!meta) return fail("TOKEN_UNVERIFIED", 409, "The simulated contract is currently unverifiable.");
  (reader as unknown as { setBalance(a: string, raw: bigint): void }).setBalance(checked.address, (await import("@/domain/rewards/tokens")).parseTokenAmount(body.data.amount, meta.decimals));
  return ok({});
});
route("POST", "picks/sim/transfer", async (c) => {
  const body = await json(c, z.strictObject({ to: z.string().min(40).max(64), amount: z.string().regex(/^\d{1,18}(\.\d{1,18})?$/) }), 1_000);
  if (!body.ok) return body.response;
  const reader = await getChainReader();
  if (!reader || reader.adapter !== "simulated") return fail("NOT_SIMULATED", 409, "Only available with the simulated adapter.");
  const checked = (await import("@/domain/rewards/address")).checkRewardAddress(body.data.to);
  if (!checked.ok) return fail("INVALID_WALLET", 422);
  const meta = await reader.metadata().catch(() => null);
  if (!meta) return fail("TOKEN_UNVERIFIED", 409, "The simulated contract is currently unverifiable.");
  const { hash } = (reader as unknown as { sendTransfer(i: { to: string; amountRaw: bigint }): { hash: string } }).sendTransfer({ to: checked.address, amountRaw: (await import("@/domain/rewards/tokens")).parseTokenAmount(body.data.amount, meta.decimals) });
  return ok({ txHash: hash });
});
/** QA only (simulated chain only): change what the simulated CONTRACT reports about itself — its decimals() and symbol() — or make it unverifiable (`null`). */
route("POST", "picks/sim/metadata", async (c) => {
  const body = await json(c, z.strictObject({ decimals: z.number().int().min(0).max(36).optional(), symbol: z.string().min(1).max(40).optional(), broken: z.boolean().optional() }), 300);
  if (!body.ok) return body.response;
  const reader = await getChainReader();
  if (!reader || reader.adapter !== "simulated") return fail("NOT_SIMULATED", 409, "Only available with the simulated adapter.");
  const sim = reader as unknown as { setMetadata(m: { decimals?: number; symbol?: string } | null): void };
  if (body.data.broken) sim.setMetadata(null);
  else sim.setMetadata({ ...(body.data.decimals !== undefined ? { decimals: body.data.decimals } : {}), ...(body.data.symbol !== undefined ? { symbol: body.data.symbol } : {}) });
  return ok({});
});
/** QA only (simulated chain only): switch the simulated RPC off / on, to exercise "close verification failed → bonus PENDING VERIFICATION". */
route("POST", "picks/sim/outage", async (c) => {
  const body = await json(c, z.strictObject({ on: z.boolean() }), 200);
  if (!body.ok) return body.response;
  const reader = await getChainReader();
  if (!reader || reader.adapter !== "simulated") return fail("NOT_SIMULATED", 409, "Only available with the simulated adapter.");
  (reader as unknown as { setOutage(down: boolean): void }).setOutage(body.data.on);
  return ok({ outage: body.data.on });
});
route("POST", "picks/accounts/:id/review", async (c) => {
  const id = Number(c.seg[2]);
  if (!Number.isSafeInteger(id)) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ state: z.enum(["NORMAL", "REVIEW", "SUSPENDED"]), reason: z.string().trim().max(300).default("") }), 2_000);
  if (!body.ok) return body.response;
  await rewardsAdmin.setReviewState(c.db, id, body.data.state, body.data.reason, ACTOR);
  return ok({});
});
route("POST", "picks/accounts/:id/wallet-exception", async (c) => {
  const id = Number(c.seg[2]);
  if (!Number.isSafeInteger(id)) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ reason: z.string().trim().min(3).max(300) }), 2_000);
  if (!body.ok) return body.response;
  await rewardsAdmin.approveWalletException(c.db, id, body.data.reason, ACTOR);
  return ok({});
});
route("POST", "picks/accounts/:id/adjust", async (c) => {
  const id = Number(c.seg[2]);
  if (!Number.isSafeInteger(id)) return fail("NOT_FOUND", 404);
  const body = await json(c, z.strictObject({ amount: z.string().regex(/^\d{1,18}(\.\d{1,18})?$/), direction: z.enum(["credit", "debit"]), reason: z.string().trim().min(3).max(300), key: z.string().min(8).max(120) }), 2_000);
  if (!body.ok) return body.response;
  return ok(await rewardsAdmin.adminAdjust(c.db, { userId: id, ...body.data }, ACTOR));
});
// ---------------------------------------------------------------------------------------

async function dispatch(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const method = req.method.toUpperCase();
  const env = getEnv();

  // Session endpoints (login is the only unauthenticated route).
  if (path.length === 1 && path[0] === "session") {
    if (method === "GET") return ok({ authenticated: isAdmin(req), configured: Boolean(env.ADMIN_ACCESS_KEY) });
    if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
    if (method === "DELETE") {
      const res = ok({});
      res.headers.append("Set-Cookie", clearCookieHeader(ADMIN_SESSION_COOKIE));
      return res;
    }
    if (method === "POST") {
      if (!env.ADMIN_ACCESS_KEY) return fail("ADMIN_DISABLED", 503, "Admin access is not configured.");
      if (rateLimited(`adminlogin:${clientKey(req)}`, 5, 60_000)) return fail("RATE_LIMITED", 429);
      const body = await readJson(req, z.strictObject({ key: z.string().min(1).max(512) }));
      if (!body.ok) return body.response;
      if (!safeEqual(body.data.key, env.ADMIN_ACCESS_KEY)) {
        await new Promise((r) => setTimeout(r, 400)); // blunt brute-force economics
        return fail("INVALID_KEY", 401);
      }
      const token = signSession(newSession("admin", 0, 0, ADMIN_SESSION_TTL_S), getSecret("SESSION_SECRET", env));
      const res = ok({});
      res.headers.append("Set-Cookie", cookieHeader(ADMIN_SESSION_COOKIE, token, ADMIN_SESSION_TTL_S, { strict: true }));
      return res;
    }
    return fail("METHOD_NOT_ALLOWED", 405);
  }

  if (!isAdmin(req)) return fail("UNAUTHORIZED", 401);
  if (method !== "GET" && !sameOriginOk(req)) return fail("BAD_ORIGIN", 403);

  const joined = path.join("/");
  for (const r of routes) {
    if (r.method !== method) continue;
    if (!r.pattern.test(joined)) continue;
    try {
      return await r.handler({ req, db: await getReadyDb(), url: new URL(req.url), seg: path });
    } catch (error) {
      if (error instanceof AdminError) return fail(error.code, error.status, error.message === error.code ? undefined : error.message);
      if (error instanceof HeroVersionError) return fail(error.code, error.status, error.message === error.code ? undefined : error.message);
      if (error instanceof z.ZodError) return fail("INVALID_INPUT", 422, error.issues[0]?.message);
      console.error("[admin]", joined, error);
      return fail("INTERNAL_ERROR", 500);
    }
  }
  return fail("NOT_FOUND", 404);
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
