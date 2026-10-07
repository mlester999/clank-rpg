import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseTelegramUpdate, type ParsedUpdate } from "@/domain/telegram/updates";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { makeTextHasher } from "@/server/crypto";
import type { Db } from "@/server/db/types";
import { setTelegramStatus } from "@/server/services/admin";
import { ingestUpdate, type IngestDeps } from "@/server/services/telegramIngest";

import { count, createTestDb, resetDb } from "../support/db";

/**
 * A non-player account (a community bot, a moderator, a spam ring) must never get a hero from the LIVE webhook — and the way to say
 * so is the EXISTING moderation mechanism (Admin → a Telegram member → FLAGGED / BANNED, audited and reversible), not a hard-coded id.
 *
 * The scenario mirrors the live database when the hero threshold drops 100 → 50: some members already hold 70 qualifying messages and
 * have no hero (the old threshold was 100). Members the operator excluded must not be turned into heroes by their NEXT webhook
 * message; everyone else must be.
 */
let db: Db;
let deps: IngestDeps;
const CHAT = -1001234567890;
const T0 = Date.UTC(2026, 5, 1, 9, 0, 0);
const DAY = 86_400_000;
/** Deliberately an arbitrary id: nothing in the game knows or cares which account is excluded. */
const EXCLUDED = 5530802189;
const MEMBER = 7001;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  const base = await loadSettings(db);
  // live today: the threshold is still 100 — set explicitly so this test does not depend on the shipped default
  deps = { settings: { ...base, telegram: { ...base.telegram, qualifyingThreshold: 100 } }, classes: await loadClasses(db), hash: makeTextHasher("test-pepper-value-123"), classRollSecret: "test-class-secret-value-0123456789" };
});

let mid = 0;
const raw = (author: number, name: string, text: string, atMs: number) => ({
  update_id: ++mid + 2_000_000,
  message: { message_id: mid, date: Math.floor(atMs / 1000), chat: { id: CHAT, type: "supergroup" }, from: { id: author, is_bot: false, first_name: name, username: name.toLowerCase() }, text },
});
const send = (u: unknown) => ingestUpdate(db, parseTelegramUpdate(u, CHAT) as ParsedUpdate, deps);
async function sendMessages(author: number, name: string, n: number, from = 0) {
  const out = [];
  for (let i = from; i < from + n; i++) out.push(await send(raw(author, name, `thoughtful message number ${i} about bonding curves and launch ${i * 13} mechanics`, T0 + Math.floor(i / 30) * DAY + (i % 30) * 60_000)));
  return out;
}
const lowerThreshold = (to: number) => void (deps = { ...deps, settings: { ...deps.settings, telegram: { ...deps.settings.telegram, qualifyingThreshold: to } } });

describe("the threshold drops 100 → 50: an excluded member gets no hero from the live webhook; everyone else does", () => {
  it("both accounts hold 70 qualifying messages and no hero; after the operator FLAGS one and the threshold becomes 50, only the other turns into a hero on its next message", async () => {
    await sendMessages(EXCLUDED, "BBOT", 70);
    await sendMessages(MEMBER, "Member", 70);
    expect(await count(db, "characters")).toBe(0); // threshold 100: nobody yet
    expect((await db.query<{ qualifying_message_count: number }>("select qualifying_message_count from public.telegram_users where telegram_user_id = $1", [EXCLUDED]))[0]!.qualifying_message_count).toBe(70);

    // the operator uses the ordinary moderation control, before the new threshold goes live
    await setTelegramStatus(db, EXCLUDED, "FLAGGED", "community bot — not a player", "admin", deps);
    lowerThreshold(50);

    const bot = await sendMessages(EXCLUDED, "BBOT", 3, 70);
    expect(bot.every((r) => r.status === "PROCESSED" && !r.characterCreated)).toBe(true);
    expect(await count(db, "characters", `telegram_user_id = ${EXCLUDED}`)).toBe(0);

    const [next] = await sendMessages(MEMBER, "Member", 1, 70);
    expect(next).toMatchObject({ status: "PROCESSED", characterCreated: true });
    expect(await count(db, "characters", `telegram_user_id = ${MEMBER}`)).toBe(1);
    expect(await count(db, "characters")).toBe(1);
  });

  it("BANNED works the same way, and the block is audited and reversible: lifting it lets the NEXT message create the hero", async () => {
    await sendMessages(EXCLUDED, "BBOT", 70);
    await setTelegramStatus(db, EXCLUDED, "BANNED", "excluded account", "admin", deps);
    lowerThreshold(50);
    await sendMessages(EXCLUDED, "BBOT", 2, 70);
    expect(await count(db, "characters", `telegram_user_id = ${EXCLUDED}`)).toBe(0);
    const audit = await db.query<{ action: string; entity_id: string }>("select action, entity_id from public.admin_audit_log where action = 'telegram.status'");
    expect(audit).toEqual([{ action: "telegram.status", entity_id: String(EXCLUDED) }]);

    await setTelegramStatus(db, EXCLUDED, "OK", null, "admin", deps);
    const [after] = await sendMessages(EXCLUDED, "BBOT", 1, 72);
    expect(after).toMatchObject({ status: "PROCESSED" });
    expect(await count(db, "characters", `telegram_user_id = ${EXCLUDED}`)).toBe(1);
  });

  it("WITHOUT the block the very same account IS turned into a hero by its next message at 50 — which is exactly why the block is a pre-requisite of the threshold migration", async () => {
    await sendMessages(EXCLUDED, "BBOT", 70);
    lowerThreshold(50);
    const [r] = await sendMessages(EXCLUDED, "BBOT", 1, 70);
    expect(r).toMatchObject({ status: "PROCESSED", characterCreated: true });
  });
});

describe("no account is special-cased in the code", () => {
  it("no source, script or migration hard-codes the excluded Telegram id", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        if (f === "node_modules" || f.startsWith(".next")) continue;
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|sql|json)$/.test(f) && readFileSync(p, "utf8").includes(String(EXCLUDED))) hits.push(p);
      }
    };
    for (const d of ["src", "scripts", "supabase"]) walk(join(process.cwd(), d));
    expect(hits).toEqual([]);
  });
});
