import { NextResponse } from "next/server";

import { safeEqual } from "@/server/crypto";
import { demoHeroesAllowed, getEnv } from "@/server/env";
import { getChainReader } from "@/server/rewards/context";
import { refreshDueHolders } from "@/server/rewards/holders";
import { settleDueRewards } from "@/server/rewards/settlement";
import { finalizeDueHeroBoards } from "@/server/rewards/heroArena";
import { finalizeDueBoards } from "@/server/rewards/leaderboard";
import { verifiedTokenMetadata } from "@/server/rewards/tokenMetadata";
import { fail, guarded } from "@/server/http/guards";
import { ensureArenaAdvanced, getEnabledClasses, getProviders, getReadyDb, getSettings } from "@/server/runtime";
import { syncCharacterHoldings } from "@/server/services/holdings";
import { createBotApiPhotoSource, syncTelegramPhotoBatch } from "@/server/services/telegramPhotos";
import { getAvatarStore } from "@/server/storage";
import { scanCatalog } from "@/server/services/tokens";
import { indexTokenTrades } from "@/server/services/trading";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = getEnv().CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") && safeEqual(header.slice(7), secret);
}

/**
 * Scheduler entry point (Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`;
 * any scheduler may POST). Always advances the arena. `?scan=1` refreshes the bonded-coin
 * catalog, `?trades=1` indexes recent public trades, `?holdings=1` re-verifies a bounded batch of linked wallets, and `?photos=1` refreshes a bounded batch of Telegram profile photos.
 */
async function handle(req: Request) {
  if (!authorized(req)) return fail("FORBIDDEN", 403);
  const url = new URL(req.url);
  const out: Record<string, unknown> = {};
  out.arena = await ensureArenaAdvanced(0).catch((e) => ({ error: String(e) }));
  const db = await getReadyDb();
  const env = getEnv();
  // Arena Picks: score finished battles (no token is credited per battle), freeze any ended Daily / Weekly leaderboard (idempotent; each prize
  // winner's holdings get a fresh close verification first; a bonus whose verification failed is reconciled), and re-verify a BOUNDED batch of
  // holder wallets whose next check is due (never every wallet every minute). There is no token sender: payouts are manual.
  // Failures are reported, never thrown: the arena has already advanced and must never depend on the reward path.
  const settings = await getSettings();
  out.rewards = {
    settlement: await settleDueRewards(db, { now: () => new Date() }).catch((e: unknown) => ({ error: String(e) })),
    boards: await finalizeDueBoards(db, { now: () => new Date(), settings }).catch((e: unknown) => ({ error: String(e) })),
    // HERO ARENA: a separate program with its own sweep (never throws; one program failing cannot affect the other).
    heroArena: await finalizeDueHeroBoards(db, { now: () => new Date(), settings, allowDemo: demoHeroesAllowed() }),
    holders: await getChainReader().then((reader) => refreshDueHolders(db, { now: () => new Date() }, reader, settings)).catch((e: unknown) => ({ error: String(e) })),
    // Keep the persisted token metadata (symbol / decimals / verified_at, read from the CONTRACT) fresh; null = not launched or not verifiable (features stay closed).
    token: await getChainReader().then(async (reader) => ((await verifiedTokenMetadata(db, reader)) ? "VERIFIED" : reader ? "UNVERIFIED" : "NOT_LAUNCHED")).catch((e: unknown) => ({ error: String(e) })),
  };
  if (url.searchParams.get("scan") === "1") {
    const { catalog, reader } = getProviders();
    out.scan = await scanCatalog(db, catalog, { chainId: env.ROBINHOOD_CHAIN_ID, maxPages: 40, autoApprove: Boolean(env.CLANK_AUTO_APPROVE_BONDED), reader }).catch((e) => ({ error: String(e) }));
  }
  if (url.searchParams.get("trades") === "1") {
    const { catalog } = getProviders();
    const tokens = await db.query<{ id: string; address: string; quote_currency: string | null }>("select id, address, quote_currency from public.eligible_tokens where status = 'ELIGIBLE'");
    const totals = { tokens: 0, counted: 0, errors: 0 };
    for (const t of tokens) {
      try {
        const r = await indexTokenTrades(db, catalog, { id: t.id, address: t.address, quoteCurrency: t.quote_currency }, { maxPages: 4, minTradeQuote: settings.trading.minTradeQuote });
        totals.tokens++;
        totals.counted += r.counted;
      } catch {
        totals.errors++; // provider unavailable → skip; nothing is guessed
      }
    }
    out.trades = totals;
  }
  if (url.searchParams.get("holdings") === "1") {
    const { reader } = getProviders();
    const classes = await getEnabledClasses();
    const stale = await db.query<{ character_id: string }>(
      `select w.character_id from public.wallet_links w where w.unlinked_at is null
        order by (select max(observed_at) from public.token_holdings h where h.character_id = w.character_id) nulls first limit 25`,
    );
    const results: Record<string, number> = {};
    for (const s of stale) {
      const r = await syncCharacterHoldings(db, s.character_id, { reader, settings, classes, force: true }).catch(() => ({ status: "UNAVAILABLE" as const }));
      results[r.status] = (results[r.status] ?? 0) + 1;
    }
    out.holdings = results;
  }
  if (url.searchParams.get("photos") === "1") {
    // Telegram profile photos for heroes: one bounded batch per tick; unchanged pictures are not downloaded again.
    const store = getAvatarStore();
    const token = env.TELEGRAM_BOT_TOKEN;
    out.photos = !store
      ? { status: "STORAGE_NOT_CONFIGURED" }
      : !token
        ? { status: "NOT_CONFIGURED" }
        : await syncTelegramPhotoBatch(db, store, createBotApiPhotoSource({ token }), { limit: 25 }).catch((e) => ({ error: e instanceof Error ? e.message : "photo sync failed" }));
  }
  return NextResponse.json({ ok: true, ...out }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = guarded("internal/tick", handle);
export const POST = guarded("internal/tick", handle);
