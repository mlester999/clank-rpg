/**
 * Helper for the Telegram Bot API webhook (requires TELEGRAM_BOT_TOKEN — never commit it).
 *
 *   pnpm telegram:webhook -- info
 *   pnpm telegram:webhook -- set https://your.domain/api/telegram/webhook
 *   pnpm telegram:webhook -- delete
 *
 * `set` registers the secret token (TELEGRAM_WEBHOOK_SECRET) so only Telegram can call the route,
 * and asks for `message` + `message_reaction` updates. The bot must be a group ADMIN for
 * reactions and (unless privacy mode is off) to see every group message.
 */
import { getEnv } from "../src/server/env";

import { loadLocalEnv } from "./lib/context";

loadLocalEnv();
const env = getEnv();
const token = env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set. See .env.example.");
  process.exit(1);
}
const [cmd, url] = process.argv.slice(2).filter((a) => a !== "--");
const api = async (method: string, body?: unknown) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return res.json();
};

if (cmd === "info") {
  console.log(JSON.stringify({ me: await api("getMe"), webhook: await api("getWebhookInfo") }, null, 2));
} else if (cmd === "set") {
  if (!url?.startsWith("https://")) throw new Error("webhook URL must be https");
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET is required");
  console.log(await api("setWebhook", { url, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "message_reaction"], drop_pending_updates: false }));
} else if (cmd === "delete") {
  console.log(await api("deleteWebhook", { drop_pending_updates: false }));
} else {
  console.error("usage: telegram:webhook -- info | set <https-url> | delete");
  process.exit(1);
}
