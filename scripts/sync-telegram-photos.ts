/**
 * Refreshes the cached Telegram profile photos of heroes (the same bounded batch the scheduler runs with
 * `/api/internal/tick?photos=1`).
 *
 *   pnpm telegram:sync-photos                      dry run: lists who WOULD be asked — no Telegram calls, no writes
 *   pnpm telegram:sync-photos -- --apply --limit 25
 *
 * Needs TELEGRAM_BOT_TOKEN (the bot has to be live in the official group for Telegram to expose photos) and photo
 * storage (Supabase URL + service-role key, or the embedded dev database). It never downloads a picture that has not
 * changed. Read the printed `→ database:` label first: with DATABASE_URL set this talks to the LIVE database.
 */
import { getEnv } from "../src/server/env";
import { createBotApiPhotoSource, findPhotoSyncCandidates, syncTelegramPhotoBatch } from "../src/server/services/telegramPhotos";
import { createAvatarStore } from "../src/server/storage/factory";

import { run } from "./lib/context";

void run(async ({ db }) => {
  const env = getEnv();
  const apply = process.argv.includes("--apply");
  const limitIdx = process.argv.indexOf("--limit");
  const limit = Math.min(Math.max(Number(limitIdx >= 0 ? process.argv[limitIdx + 1] : 25) || 25, 1), 200);

  const candidates = await findPhotoSyncCandidates(db, new Date(), limit);
  console.log(`${candidates.length} hero(es) due a Telegram photo check (limit ${limit}).`);
  if (!apply) {
    for (const id of candidates.slice(0, 20)) console.log(`  would check telegram user ${id}`);
    console.log("Dry run — nothing was sent to Telegram or written. Re-run with --apply to do it.");
    return;
  }
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set — Telegram photos cannot be fetched until the bot is configured.");
  const store = createAvatarStore(env);
  if (!store) throw new Error("No photo storage available: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or run against the embedded dev database).");
  const summary = await syncTelegramPhotoBatch(db, store, createBotApiPhotoSource({ token: env.TELEGRAM_BOT_TOKEN }), { limit });
  console.log(`checked ${summary.checked}:`, summary.byStatus, summary.rateLimited ? "(stopped early: Telegram rate limit)" : "");
});
