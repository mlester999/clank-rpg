import { NextResponse } from "next/server";

import { parseTelegramUpdate } from "@/domain/telegram/updates";
import { safeEqual } from "@/server/crypto";
import { getEnv } from "@/server/env";
import { fail } from "@/server/http/guards";
import { getIngestDeps, getReadyDb, isFlagOn } from "@/server/runtime";
import { ingestUpdate } from "@/server/services/telegramIngest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 512 * 1024;

/**
 * Telegram Bot API webhook. Authenticated by the secret token Telegram echoes back in the
 * X-Telegram-Bot-Api-Secret-Token header (set via setWebhook secret_token). Only the single
 * official Clank.trade chat is processed; every other chat, bots and malformed updates are ignored.
 */
export async function POST(req: Request) {
  const env = getEnv();
  if (!env.TELEGRAM_WEBHOOK_SECRET || env.TELEGRAM_OFFICIAL_CHAT_ID === undefined) return fail("NOT_CONFIGURED", 503);
  const provided = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(provided, env.TELEGRAM_WEBHOOK_SECRET)) return fail("FORBIDDEN", 403);

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return fail("PAYLOAD_TOO_LARGE", 413);
  const text = await req.text();
  if (text.length > MAX_BODY) return fail("PAYLOAD_TOO_LARGE", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("INVALID_JSON", 400);
  }

  if (!(await isFlagOn("telegram.ingest"))) return NextResponse.json({ ok: true, paused: true });
  const update = parseTelegramUpdate(body, env.TELEGRAM_OFFICIAL_CHAT_ID);
  try {
    const result = await ingestUpdate(await getReadyDb(), update, await getIngestDeps());
    return NextResponse.json({ ok: true, status: result.status });
  } catch (error) {
    // 5xx makes Telegram retry; ingestion is idempotent per update_id / message id.
    console.error("[telegram/webhook]", error);
    return fail("PROCESSING_FAILED", 500);
  }
}
