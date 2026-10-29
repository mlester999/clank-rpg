/**
 * READ-ONLY verification of an imported Telegram export against whatever database is configured.
 *
 * The expected numbers are RECOMPUTED from the export file through the same pipeline the importer used
 * (parser → planner), then compared with the stored rows — per member, not just in total. Everything runs
 * inside `SET TRANSACTION READ ONLY` (enforced by Postgres) and is rolled back.
 *
 *   pnpm telegram:verify -- ./result.json                 # import data (+ heroes if they exist)
 *   pnpm telegram:verify -- ./result.json --require-heroes # also demand every eligible member has exactly one hero
 *   pnpm telegram:verify -- ./result.json --exclude-ids 1,2  # the same exclusions you passed to the import
 *
 * The database may legitimately hold MORE than the file: the importer only ever adds, so messages deleted on Telegram after an
 * earlier import stay stored; members get moderated and sign in (usernames); display names change; heroes get rerolled or rebalanced.
 * So file -> database is strict (nothing in the export may be missing or scored differently) and the other direction is reported,
 * not failed. Hero rolls are re-derived only for heroes still on their INITIAL version.
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
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--exclude-ids");
const requireHeroes = args.includes("--require-heroes");
const excludeIds = new Set((args[args.indexOf("--exclude-ids") + 1] ?? "").split(",").filter(Boolean).map(Number));
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
  const parsed = parseTelegramExport(JSON.parse((await readFile(file)).toString("utf8")), { excludeUserIds: excludeIds });
  const chatId = parsed.chatId;
  console.log(`verifying ${parsed.chatName} (${chatId}) against ${target}`);

  await db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY");
    const { settings, classes } = (await tx.query("select 1 from public.character_classes limit 1")).length ? await loadImportConfig(tx) : { settings: DEFAULT_SETTINGS, classes: DEFAULT_CLASSES };
    const plan = planImport({ messages: parsed.messages, settings, hash: makeTextHasher(getSecret("TELEGRAM_HASH_PEPPER", env)) });
    const num = async (sql: string, params: unknown[] = []) => Number((await tx.query<{ n: string | number }>(sql, params))[0]?.n ?? 0);

    h("IDENTITY");
    eq("chats present in telegram_messages", await num("select count(distinct chat_id)::int as n from public.telegram_messages"), 1);
    eq("messages outside the official chat", await num("select count(*)::int as n from public.telegram_messages where chat_id <> $1", [chatId]), 0);
    eq("messages with source other than IMPORT", await num("select count(*)::int as n from public.telegram_messages where source <> 'IMPORT'"), 0);
    eq("demo (negative-id) members mixed in", await num("select count(*)::int as n from public.telegram_users where is_demo"), 0);
    console.log(`  members with a stored username (export has none; set only by sign-in): ${await num("select count(*)::int as n from public.telegram_users where username is not null")}`);

    h("EXPORT → DATABASE (strict: everything in the file must be stored and scored the same)");
    const expMsg = new Map<number, { userId: number; qualifies: boolean }>();
    for (const u of plan.users) for (const m of u.messages) expMsg.set(m.messageId, { userId: u.userId, qualifies: m.qualifies });
    const dbMsgs = await tx.query<{ message_id: string; telegram_user_id: string; qualifies: boolean; reject_reason: string | null }>("select message_id, telegram_user_id, qualifies, reject_reason from public.telegram_messages");
    const dbById = new Map(dbMsgs.map((m) => [Number(m.message_id), m]));
    let missing = 0, scoredDifferently = 0;
    const dbRej: Record<string, number> = {};
    for (const [id, e] of expMsg) {
      const d = dbById.get(id);
      if (!d) { missing += 1; continue; }
      if (d.qualifies !== e.qualifies || Number(d.telegram_user_id) !== e.userId) scoredDifferently += 1;
      if (!d.qualifies) dbRej[d.reject_reason ?? "?"] = (dbRej[d.reject_reason ?? "?"] ?? 0) + 1;
    }
    eq("export messages missing from the database", missing, 0);
    eq("export messages stored with a different author / qualifies flag", scoredDifferently, 0);
    eq("export messages stored", expMsg.size - missing, plan.totals.importedMessages);
    const rejDiff = Object.keys({ ...dbRej, ...plan.totals.rejectedByReason }).filter((k) => (dbRej[k] ?? 0) !== (plan.totals.rejectedByReason[k] ?? 0));
    check("rejected messages by reason (export messages only)", rejDiff.length === 0, rejDiff.length ? `differs: ${rejDiff.join(", ")}` : JSON.stringify(dbRej));
    const storedOnly = dbMsgs.filter((m) => !expMsg.has(Number(m.message_id)));
    const storedOnlyByUser = new Set(storedOnly.map((m) => Number(m.telegram_user_id)));
    console.log(`  stored but absent from this export (deleted on Telegram or excluded since an earlier import; never removed by design): ${fmt(storedOnly.length)} messages, ${fmt(storedOnly.filter((m) => m.qualifies).length)} qualifying, ${fmt(storedOnlyByUser.size)} members`);

    const dbReactions = await tx.query<{ message_id: string; reactor_user_id: string }>("select message_id, reactor_user_id from public.telegram_reactions");
    const dbReactionKeys = new Set(dbReactions.map((r) => `${r.message_id}:${r.reactor_user_id}`));
    eq("export reactions missing from the database", plan.reactions.filter((r) => !dbReactionKeys.has(`${r.messageId}:${r.reactorId}`)).length, 0);
    console.log(`  stored reactions beyond this export: ${fmt(dbReactions.length - plan.reactions.length)}`);

    h("PER-MEMBER (every member in the export compared)");
    const rows = await tx.query<{ telegram_user_id: string; total_message_count: number; qualifying_message_count: number; active_days: number; status: string }>(
      "select telegram_user_id, total_message_count, qualifying_message_count, active_days, status from public.telegram_users",
    );
    const dbUsers = new Map(rows.map((r) => [Number(r.telegram_user_id), r]));
    eq("export members missing from the database", plan.users.filter((u) => !dbUsers.has(u.userId)).length, 0);
    console.log(`  stored members beyond this export: ${fmt(rows.length - plan.users.length)}`);
    let bad = 0, exact = 0, withExtras = 0, moderated = 0;
    const examples: string[] = [];
    for (const e of plan.users) {
      const r = dbUsers.get(e.userId);
      if (!r) continue;
      if (r.status !== e.status) moderated += 1;
      const extra = storedOnlyByUser.has(e.userId);
      // A member with stored-only messages may hold MORE than the export implies, never less.
      const mismatch = extra
        ? r.total_message_count < e.history.totalMessages || r.qualifying_message_count < e.history.qualifyingMessages
        : r.total_message_count !== e.history.totalMessages || r.qualifying_message_count !== e.history.qualifyingMessages || r.active_days !== e.history.activeDays;
      if (extra) withExtras += 1; else exact += 1;
      if (mismatch) {
        bad += 1;
        if (examples.length < 3) examples.push(`user${r.telegram_user_id} db=${r.total_message_count}/${r.qualifying_message_count} expected=${e.history.totalMessages}/${e.history.qualifyingMessages}`);
      }
    }
    check("members whose totals / qualifying (and, without stored-only messages, active days) differ", bad === 0, bad ? `${bad}: ${examples.join("; ")}` : `${fmt(exact)} match exactly, ${fmt(withExtras)} hold stored-only messages on top`);
    console.log(`  members whose status changed since the export was planned (moderation): ${moderated}`);
    eq("expected-eligible members below the threshold in the database", plan.users.filter((u) => u.eligible && (dbUsers.get(u.userId)?.qualifying_message_count ?? 0) < settings.telegram.qualifyingThreshold).length, 0);
    console.log(`  members at or above the threshold (status OK): ${fmt(await num("select count(*)::int as n from public.telegram_users where status = 'OK' and qualifying_message_count >= $1", [settings.telegram.qualifyingThreshold]))}  (export alone: ${plan.totals.eligibleUsers})`);
    const drift = await num(`select count(*)::int as n from public.telegram_users u where u.total_message_count <> (select count(*) from public.telegram_messages m where m.telegram_user_id = u.telegram_user_id)
        or u.qualifying_message_count <> (select count(*) from public.telegram_messages m where m.telegram_user_id = u.telegram_user_id and m.qualifies)`);
    eq("members whose counters differ from their own stored messages", drift, 0);
    eq("daily table: message_count sum = stored messages", await num("select coalesce(sum(message_count),0)::int as n from public.telegram_daily_activity"), dbMsgs.length);
    eq("daily table: qualifying_count sum = stored qualifying", await num("select coalesce(sum(qualifying_count),0)::int as n from public.telegram_daily_activity"), dbMsgs.filter((m) => m.qualifies).length);

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
      const hs = await tx.query<{ telegram_user_id: string; class_id: string; name: string; rarity: string; seed: string; parts: unknown; sprite: unknown; behavior: Record<string, number>; activity_score: number; display_name: string; versions: number; created_at: Date | string; member_updated_at: Date | string }>(
        `select c.telegram_user_id, c.class_id, c.name, (select count(*)::int from public.hero_versions v where v.character_id = c.id) as versions, c.created_at, u.updated_at as member_updated_at, a.rarity, a.seed, a.parts, a.sprite, u.behavior, u.activity_score, u.display_name
           from public.characters c join public.character_appearances a on a.character_id = c.id join public.telegram_users u on u.telegram_user_id = c.telegram_user_id where c.kind = 'COMMUNITY'`,
      );
      let classBad = 0, lookBad = 0, nameBad = 0, spriteBad = 0, evolved = 0, grown = 0;
      for (const hr of hs) {
        // Rerolled / rolled-back / rebalanced heroes legitimately differ from the first roll; hero_versions is their authority (audit functions below).
        if (hr.versions > 1) { evolved += 1; continue; }
        const g = generateCharacter({ telegramUserId: Number(hr.telegram_user_id), displayName: hr.display_name, behavior: hr.behavior, activityScore: Number(hr.activity_score), classes, settings, secret });
        const classDiffers = g.classId !== hr.class_id;
        const lookDiffers = g.rarity !== hr.rarity || g.appearanceSeed !== hr.seed || !isDeepStrictEqual(g.appearance, hr.parts);
        const spriteInvalid = !spriteConfigSchema.safeParse(hr.sprite).success;
        const spriteDiffers = spriteInvalid || !isDeepStrictEqual(g.sprite, hr.sprite);
        // The roll reads the member's CURRENT behaviour / activity, which every import or webhook message refreshes, while a hero's class and look are
        // permanent from creation. So a hero created before its member's stats were last updated may legitimately differ; only newer heroes must match.
        if (new Date(hr.created_at) < new Date(hr.member_updated_at)) {
          if (classDiffers || lookDiffers || spriteDiffers) grown += 1;
          if (spriteInvalid) spriteBad += 1;
        } else {
          if (classDiffers) classBad += 1;
          if (lookDiffers) lookBad += 1;
          if (spriteDiffers) spriteBad += 1;
        }
        if (g.name !== hr.name) nameBad += 1;
      }
      eq("heroes whose class differs from the secret-derived roll", classBad, 0);
      eq("heroes whose rarity/appearance differ from the deterministic roll", lookBad, 0);
      console.log(`  heroes whose name differs from the member's CURRENT display name (names are fixed at creation, Telegram names change): ${nameBad}`);
      console.log(`  heroes whose member stats moved on since the hero was created (class and look stay as first rolled): ${grown}`);
      console.log(`  heroes on a later version (rerolled / rolled back / rebalanced), covered by the audit functions instead of a re-roll: ${evolved}`);
      eq("audit_hero_versions() violations", await num("select count(*)::int as n from public.audit_hero_versions()"), 0);
      eq("audit_hero_rarity_power() violations", await num("select count(*)::int as n from public.audit_hero_rarity_power()"), 0);
      eq("heroes whose stored sprite is missing, invalid or differs from the deterministic derivation", spriteBad, 0);
      const byClass = Object.fromEntries((await tx.query<{ class_id: string; n: number }>("select class_id, count(*)::int as n from public.characters where kind = 'COMMUNITY' group by 1 order by 1")).map((r) => [r.class_id, Number(r.n)]));
      console.log(`  classes: ${JSON.stringify(byClass)}`);
      console.log(`  rarity (PWR tier): ${JSON.stringify(Object.fromEntries((await tx.query<{ rarity: string; n: number }>("select a.rarity, count(*)::int as n from public.character_appearances a join public.characters c on c.id = a.character_id where c.kind = 'COMMUNITY' group by 1 order by 1")).map((r) => [r.rarity, Number(r.n)])))}`);
    }

    h("ECONOMY UNTOUCHED BY THE IMPORT (no double-awarded Gold; retired XP/level columns never written)");
    // Heroes created before XP / levels were retired still carry them; the columns are never read or written now, so this is reported, not failed.
    console.log(`  heroes with a non-default retired xp/level value (legacy, never read): ${await num("select count(*)::int as n from public.characters where xp > 0 or level > 1")}`);
    console.log(`  currency_ledger rows: ${fmt(await num("select count(*)::int as n from public.currency_ledger"))}   character_achievements: ${fmt(await num("select count(*)::int as n from public.character_achievements"))}`);
    eq("ledger/balance mismatches (audit_currency_ledger)", await num("select count(*)::int as n from public.audit_currency_ledger()"), 0);
  });

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✔" : `${failures} CHECK(S) FAILED ✘`}`);
  if (failures) process.exitCode = 1;
});
