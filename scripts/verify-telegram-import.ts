/**
 * READ-ONLY verification of an imported Telegram export against whatever database is configured.
 *
 * The expected numbers are RECOMPUTED from the export file through the same pipeline the importer used
 * (parser → planner), then compared with the stored rows — per member, not just in total. Everything runs
 * inside `SET TRANSACTION READ ONLY` (enforced by Postgres) and is rolled back.
 *
 *   pnpm telegram:verify -- ./result.json                 # import data (+ heroes if they exist)
 *   pnpm telegram:verify -- ./result.json --require-heroes # also demand every eligible member has exactly one hero
 *
 * Exit code 1 when any check fails.
 */
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { DEFAULT_CLASSES } from "../src/domain/content";
import { generateCharacter } from "../src/domain/character/generate";
import { spriteConfigSchema } from "../src/domain/sprites/config";
import { parseTelegramExport } from "../src/domain/telegram/exportParser";
import { planImport } from "../src/domain/telegram/importPlan";
import { loadImportConfig } from "../src/server/services/telegramImport";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import { makeTextHasher } from "../src/server/crypto";
import { getEnv, getSecret } from "../src/server/env";

import { run } from "./lib/context";

const args = process.argv.slice(2).filter((a) => a !== "--");
const file = args.find((a) => !a.startsWith("--"));
const requireHeroes = args.includes("--require-heroes");
const fmt = (n: number) => n.toLocaleString("en-US");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✔" : "✘"} ${label}${detail ? `  — ${detail}` : ""}`);
}
const eq = (label: string, actual: number | string, expected: number | string) => check(label, actual === expected, `db=${actual} expected=${expected}`);
const h = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);

void run(async ({ db, target }) => {
  if (!file) throw new Error("usage: pnpm telegram:verify -- <result.json> [--require-heroes]");
  const env = getEnv();
  const parsed = parseTelegramExport(JSON.parse((await readFile(file)).toString("utf8")), {});
  const chatId = parsed.chatId;
  console.log(`verifying ${parsed.chatName} (${chatId}) against ${target}`);

  await db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY");
    const { settings, classes } = (await tx.query("select 1 from public.character_classes limit 1")).length ? await loadImportConfig(tx) : { settings: DEFAULT_SETTINGS, classes: DEFAULT_CLASSES };
    const plan = planImport({ messages: parsed.messages, settings, hash: makeTextHasher(getSecret("TELEGRAM_HASH_PEPPER", env)) });
    const expectUser = new Map(plan.users.map((u) => [u.userId, u]));
    const num = async (sql: string, params: unknown[] = []) => Number((await tx.query<{ n: string | number }>(sql, params))[0]?.n ?? 0);

    h("IDENTITY");
    eq("chats present in telegram_messages", await num("select count(distinct chat_id)::int as n from public.telegram_messages"), 1);
    eq("messages outside the official chat", await num("select count(*)::int as n from public.telegram_messages where chat_id <> $1", [chatId]), 0);
    eq("messages with source other than IMPORT", await num("select count(*)::int as n from public.telegram_messages where source <> 'IMPORT'"), 0);
    eq("demo (negative-id) members mixed in", await num("select count(*)::int as n from public.telegram_users where is_demo"), 0);
    eq("members with a stored username (export has none → must stay empty)", await num("select count(*)::int as n from public.telegram_users where username is not null"), 0);

    h("COUNTS vs. the export");
    eq("members", await num("select count(*)::int as n from public.telegram_users"), plan.totals.uniqueUsers);
    eq("messages", await num("select count(*)::int as n from public.telegram_messages"), plan.totals.importedMessages);
    eq("qualifying messages", await num("select count(*)::int as n from public.telegram_messages where qualifies"), plan.totals.qualifyingMessages);
    const rejected = await tx.query<{ reject_reason: string; n: number }>("select reject_reason, count(*)::int as n from public.telegram_messages where not qualifies group by 1");
    const dbRej = Object.fromEntries(rejected.map((r) => [r.reject_reason, Number(r.n)]));
    const rejDiff = Object.keys({ ...dbRej, ...plan.totals.rejectedByReason }).filter((k) => (dbRej[k] ?? 0) !== (plan.totals.rejectedByReason[k] ?? 0));
    check("rejected messages by reason", rejDiff.length === 0, rejDiff.length ? `differs: ${rejDiff.join(", ")}` : JSON.stringify(dbRej));
    eq("reactions", await num("select count(*)::int as n from public.telegram_reactions"), plan.reactions.length);
    eq("members with ≥ threshold qualifying (status OK)", await num("select count(*)::int as n from public.telegram_users where status = 'OK' and qualifying_message_count >= $1", [settings.telegram.qualifyingThreshold]), plan.totals.eligibleUsers);

    h("PER-MEMBER (every member compared)");
    const rows = await tx.query<{ telegram_user_id: string; total_message_count: number; qualifying_message_count: number; active_days: number; replies_received: number; reactions_received: number; status: string; display_name: string }>(
      "select telegram_user_id, total_message_count, qualifying_message_count, active_days, replies_received, reactions_received, status, display_name from public.telegram_users",
    );
    let bad = 0;
    const examples: string[] = [];
    for (const r of rows) {
      const e = expectUser.get(Number(r.telegram_user_id));
      const mismatch = !e || r.total_message_count !== e.history.totalMessages || r.qualifying_message_count !== e.history.qualifyingMessages || r.active_days !== e.history.activeDays
        || r.replies_received !== e.repliesReceived || r.reactions_received !== e.reactionsReceived || r.status !== e.status;
      if (mismatch) {
        bad += 1;
        if (examples.length < 3) examples.push(`user${r.telegram_user_id} db=${r.total_message_count}/${r.qualifying_message_count} expected=${e?.history.totalMessages}/${e?.history.qualifyingMessages}`);
      }
    }
    check("members whose totals/qualifying/active days/replies/reactions/status differ", bad === 0, bad ? `${bad}: ${examples.join("; ")}` : `${fmt(rows.length)} members all match`);
    const drift = await num(`select count(*)::int as n from public.telegram_users u where u.total_message_count <> (select count(*) from public.telegram_messages m where m.telegram_user_id = u.telegram_user_id)
        or u.qualifying_message_count <> (select count(*) from public.telegram_messages m where m.telegram_user_id = u.telegram_user_id and m.qualifies)`);
    eq("members whose counters differ from their own stored messages", drift, 0);
    eq("daily table: message_count sum = messages", await num("select coalesce(sum(message_count),0)::int as n from public.telegram_daily_activity"), plan.totals.importedMessages);
    eq("daily table: qualifying_count sum = qualifying", await num("select coalesce(sum(qualifying_count),0)::int as n from public.telegram_daily_activity"), plan.totals.qualifyingMessages);

    h("INTEGRITY");
    eq("duplicate (chat, message) keys", await num("select count(*)::int as n from (select chat_id, message_id from public.telegram_messages group by 1,2 having count(*) > 1) d"), 0);
    eq("orphan messages (no member)", await num("select count(*)::int as n from public.telegram_messages m where not exists (select 1 from public.telegram_users u where u.telegram_user_id = m.telegram_user_id)"), 0);
    eq("self-reactions", await num("select count(*)::int as n from public.telegram_reactions where reactor_user_id = author_user_id"), 0);
    eq("reactions whose message is not stored", await num("select count(*)::int as n from public.telegram_reactions r where not exists (select 1 from public.telegram_messages m where m.chat_id = r.chat_id and m.message_id = r.message_id and m.telegram_user_id = r.author_user_id)"), 0);
    eq("NOT VALID / unvalidated constraints", await num("select count(*)::int as n from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public' and not c.convalidated"), 0);
    const cols = await tx.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'telegram_messages'");
    check("telegram_messages has no text column (only features + keyed hash)", !cols.some((c) => /^(text|message|content|body)$/i.test(c.column_name)), cols.map((c) => c.column_name).join(","));
    const keys = await tx.query<{ k: string }>("select distinct jsonb_object_keys(features) as k from public.telegram_messages");
    check("stored feature keys contain no raw text (textHash is the keyed HMAC)", !keys.some((k) => /^(text|body|content|message|raw\w*)$/i.test(k.k)), keys.map((k) => k.k).join(","));

    h("HEROES");
    const heroes = await num("select count(*)::int as n from public.characters where kind = 'COMMUNITY'");
    console.log(`  heroes stored: ${fmt(heroes)}   eligible members: ${fmt(plan.totals.eligibleUsers)}`);
    eq("duplicate heroes per Telegram id", await num("select count(*)::int as n from (select telegram_user_id from public.characters where telegram_user_id is not null group by 1 having count(*) > 1) d"), 0);
    eq("heroes whose member is below the threshold / not OK", await num(`select count(*)::int as n from public.characters c join public.telegram_users u on u.telegram_user_id = c.telegram_user_id
        where c.kind = 'COMMUNITY' and not c.is_demo and (u.status <> 'OK' or u.qualifying_message_count < $1)`, [settings.telegram.qualifyingThreshold]), 0);
    eq("heroes not marked HISTORICAL_IMPORT/TELEGRAM", await num("select count(*)::int as n from public.characters where kind = 'COMMUNITY' and origin not in ('HISTORICAL_IMPORT','TELEGRAM')"), 0);
    if (requireHeroes) eq("eligible members without a hero", await num(`select count(*)::int as n from public.telegram_users u where u.status = 'OK' and u.qualifying_message_count >= $1
        and not exists (select 1 from public.characters c where c.telegram_user_id = u.telegram_user_id)`, [settings.telegram.qualifyingThreshold]), 0);
    else console.log("  (hero completeness not required in this run; use --require-heroes once heroes are created)");

    if (heroes > 0) {
      const secret = getSecret("CLASS_ROLL_SECRET", env);
      const hs = await tx.query<{ telegram_user_id: string; class_id: string; name: string; rarity: string; seed: string; parts: unknown; sprite: unknown; behavior: Record<string, number>; activity_score: number; display_name: string }>(
        `select c.telegram_user_id, c.class_id, c.name, a.rarity, a.seed, a.parts, a.sprite, u.behavior, u.activity_score, u.display_name
           from public.characters c join public.character_appearances a on a.character_id = c.id join public.telegram_users u on u.telegram_user_id = c.telegram_user_id where c.kind = 'COMMUNITY'`,
      );
      let classBad = 0, lookBad = 0, nameBad = 0, spriteBad = 0;
      for (const hr of hs) {
        const g = generateCharacter({ telegramUserId: Number(hr.telegram_user_id), displayName: hr.display_name, behavior: hr.behavior, activityScore: Number(hr.activity_score), classes, settings, secret });
        if (g.classId !== hr.class_id) classBad += 1;
        if (g.rarity !== hr.rarity || g.appearanceSeed !== hr.seed || !isDeepStrictEqual(g.appearance, hr.parts)) lookBad += 1;
        if (g.name !== hr.name) nameBad += 1;
        if (!spriteConfigSchema.safeParse(hr.sprite).success || !isDeepStrictEqual(g.sprite, hr.sprite)) spriteBad += 1;
      }
      eq("heroes whose class differs from the secret-derived roll", classBad, 0);
      eq("heroes whose rarity/appearance differ from the deterministic roll", lookBad, 0);
      eq("heroes whose name differs from the sanitised display name", nameBad, 0);
      eq("heroes whose stored sprite is missing, invalid or differs from the deterministic derivation", spriteBad, 0);
      const byClass = Object.fromEntries((await tx.query<{ class_id: string; n: number }>("select class_id, count(*)::int as n from public.characters where kind = 'COMMUNITY' group by 1 order by 1")).map((r) => [r.class_id, Number(r.n)]));
      console.log(`  classes: ${JSON.stringify(byClass)}`);
      console.log(`  rarity (PWR tier): ${JSON.stringify(Object.fromEntries((await tx.query<{ rarity: string; n: number }>("select a.rarity, count(*)::int as n from public.character_appearances a join public.characters c on c.id = a.character_id where c.kind = 'COMMUNITY' group by 1 order by 1")).map((r) => [r.rarity, Number(r.n)])))}`);
    }

    h("ECONOMY UNTOUCHED BY THE IMPORT (no double-awarded Gold; retired XP/level columns never written)");
    eq("heroes with a non-default retired xp/level value", await num("select count(*)::int as n from public.characters where xp > 0 or level > 1"), 0);
    console.log(`  currency_ledger rows: ${fmt(await num("select count(*)::int as n from public.currency_ledger"))}   character_achievements: ${fmt(await num("select count(*)::int as n from public.character_achievements"))}`);
    eq("ledger/balance mismatches (audit_currency_ledger)", await num("select count(*)::int as n from public.audit_currency_ledger()"), 0);
  });

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✔" : `${failures} CHECK(S) FAILED ✘`}`);
  if (failures) process.exitCode = 1;
});
