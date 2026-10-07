/**
 * Historical Telegram import from a Telegram Desktop "Export chat history" JSON (result.json).
 *
 * DEFAULT IS A DRY RUN: nothing is written (if a database is reachable it is only READ, inside a
 * `SET TRANSACTION READ ONLY` transaction that Postgres itself enforces). Writing needs --apply AND a
 * TELEGRAM_OFFICIAL_CHAT_ID that matches the export.
 *
 * Counts are RECOMPUTED from the messages through the same anti-spam pipeline as live traffic —
 * nothing can be typed in — and the whole import is idempotent (keyed by chat id + message id + the
 * numeric Telegram user id; never by username).
 *
 *   pnpm telegram:import -- ./result.json                       # dry run
 *   pnpm telegram:import -- ./result.json --apply               # live write
 *
 * Flags: --expect-name "<group title>"  --expect-chat-id <id>  --chat-id <override>
 *        --exclude-ids 1,2,3   --offline (don't open the database at all)   --report <path.json>
 *        --defer-heroes   import members/messages/reactions/counters only and create NO heroes. Needs just the
 *                         baseline schema (BASELINE_MIGRATION); run again WITHOUT the flag, once the database is at
 *                         the repository's latest migration, to create the heroes (resumable, nothing is re-counted).
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_CLASSES } from "../src/domain/content";
import { parseTelegramExport } from "../src/domain/telegram/exportParser";
import { planImport, type ImportPlan } from "../src/domain/telegram/importPlan";
import { DEFAULT_SETTINGS, type GameSettings } from "../src/domain/settings";
import type { ClassDef } from "../src/domain/rules";
import { makeTextHasher } from "../src/server/crypto";
import { readMigrations } from "../src/server/db/migrate";
import { getEnv, getSecret } from "../src/server/env";
import { audit } from "../src/server/services/admin";
import { summarizeStored } from "../src/server/services/telegramBackfill";
import { applyImportPlan, decideSkips, loadExistingSnapshot, loadImportConfig, loadExistingUsers, reconcileHeroes, refreshDerivedCounters, type ExistingSnapshot } from "../src/server/services/telegramImport";

import { run } from "./lib/context";

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_FLAGS = new Set(["--chat-id", "--expect-name", "--expect-chat-id", "--exclude-ids", "--report"]);
const file = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""));

/** The last migration the data phase (telegram_* tables, audit log) depends on. */
const BASELINE_MIGRATION = "20261004000600";

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");
const line = (label: string, value: string | number) => console.log(`  ${label.padEnd(44)} ${typeof value === "number" ? fmt(value) : value}`);
const h = (title: string) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 70 - title.length))}`);

void run(async ({ db, target }) => {
  if (!file) throw new Error('usage: pnpm telegram:import -- <result.json> [--apply] [--expect-name "…"] [--expect-chat-id <id>] [--exclude-ids 1,2] [--offline] [--report path]');
  const env = getEnv();
  const apply = flag("apply");

  // ---------------------------------------------------------------- read + identify the export
  const raw = await readFile(file);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const parsed = parseTelegramExport(JSON.parse(raw.toString("utf8")), {
    ...(opt("chat-id") ? { chatId: Number(opt("chat-id")) } : {}),
    excludeUserIds: new Set((opt("exclude-ids") ?? "").split(",").filter(Boolean).map(Number)),
  });

  h("EXPORT IDENTITY");
  line("file", file);
  line("size / sha256", `${fmt(raw.length)} bytes / ${sha256.slice(0, 16)}…`);
  line("group name", parsed.chatName);
  line("type", parsed.chatType);
  line("export chat id → Bot API chat id", `${parsed.exportChatId} → ${parsed.chatId}`);
  const official = env.TELEGRAM_OFFICIAL_CHAT_ID;
  line("TELEGRAM_OFFICIAL_CHAT_ID configured", official === undefined ? "NOT SET" : String(official));
  const expectName = opt("expect-name");
  const expectId = opt("expect-chat-id") ? Number(opt("expect-chat-id")) : official;
  const problems: string[] = [];
  if (expectName && parsed.chatName !== expectName) problems.push(`group name "${parsed.chatName}" ≠ expected "${expectName}"`);
  if (expectId !== undefined && expectId !== parsed.chatId) problems.push(`chat id ${parsed.chatId} ≠ expected ${expectId}`);
  if (parsed.chatType !== "public_supergroup" && parsed.chatType !== "private_supergroup") problems.push(`unexpected chat type "${parsed.chatType}"`);
  if (apply && official === undefined) problems.push("--apply requires TELEGRAM_OFFICIAL_CHAT_ID to be configured so the export is checked against the intended group");
  if (problems.length) throw new Error(`Refusing: ${problems.join("; ")}`);
  console.log(`  identity check: PASSED${expectName ? " (name matches)" : ""}${expectId !== undefined ? " (chat id matches)" : " (no chat id configured — dry run only)"}`);

  // ---------------------------------------------------------------- settings, classes, secrets
  let settings: GameSettings = DEFAULT_SETTINGS;
  let classes: ClassDef[] = DEFAULT_CLASSES;
  let configSource = "code defaults (no database read)";
  let snapshot: ExistingSnapshot | null = null;
  let stored: Awaited<ReturnType<typeof summarizeStored>> | null = null;
  const useDb = !flag("offline");
  if (useDb) {
    await db.transaction(async (tx) => {
      await tx.exec("SET TRANSACTION READ ONLY");
      const [{ n } = { n: 0 }] = await tx.query<{ n: number }>("select count(*)::int as n from public.character_classes");
      if (n === 0) {
        configSource = "code defaults (database has no reference data yet)";
        return;
      }
      const cfg = await loadImportConfig(tx);
      settings = cfg.settings;
      classes = cfg.classes;
      configSource = `${cfg.source} (${target})`;
      snapshot = await loadExistingSnapshot(tx, parsed.chatId);
      stored = await summarizeStored(tx, parsed.chatId, settings.telegram.qualifyingThreshold);
    });
  }
  let pepper: string;
  try {
    pepper = getSecret("TELEGRAM_HASH_PEPPER", env);
  } catch (e) {
    if (apply) throw e;
    pepper = "dry-run-ephemeral-pepper";
  }
  let classSecret: string | null = null;
  try {
    classSecret = getSecret("CLASS_ROLL_SECRET", env);
  } catch (e) {
    if (apply) throw e;
  }
  line("settings / classes from", configSource);
  line("hash pepper", apply ? "configured (required)" : env.TELEGRAM_HASH_PEPPER ? "configured" : "ephemeral (dry run only)");
  line("class-roll secret", classSecret ? "configured" : "not configured → no class preview");

  // ---------------------------------------------------------------- plan
  const hash = makeTextHasher(pepper);
  const snap = snapshot as ExistingSnapshot | null;
  const decision = snap ? decideSkips(parsed.messages, snap) : { skipUsers: new Set<number>(), mergeUsers: [] as number[] };
  let existing = undefined;
  if (snap && decision.mergeUsers.length) {
    await db.transaction(async (tx) => {
      await tx.exec("SET TRANSACTION READ ONLY");
      existing = await loadExistingUsers(tx, parsed.chatId, decision.mergeUsers, snap);
    });
  }
  const plan: ImportPlan = planImport({
    messages: parsed.messages,
    settings,
    hash,
    ...(existing ? { existing } : {}),
    skipUsers: decision.skipUsers,
    ...(snap ? { knownStatus: snap.statusByUser } : {}),
    ...(classSecret ? { preview: { classes, classRollSecret: classSecret } } : {}),
  });

  // ---------------------------------------------------------------- report
  const st = parsed.stats;
  h("FILE CONTENTS");
  line("entries in file", st.entries);
  line("  user messages", st.messageEntries);
  line("  service messages (ignored)", st.serviceEntries);
  for (const [a, n] of Object.entries(st.serviceByAction).sort((x, y) => y[1] - x[1])) line(`      ${a}`, n);
  if (Object.keys(st.unknownEntryTypes).length) line("  UNKNOWN entry types", JSON.stringify(st.unknownEntryTypes));
  h("NOT IMPORTED (identity cannot be a claimable person)");
  line("deleted accounts (messages / distinct ids)", `${fmt(parsed.skipped.DELETED_ACCOUNT ?? 0)} / ${fmt(st.deletedAccountIds.length)}`);
  line("channel / anonymous-admin senders (msgs / ids)", `${fmt(parsed.skipped.CHANNEL_OR_ANONYMOUS_SENDER ?? 0)} / ${fmt(st.channelSenders.length)}`);
  line("excluded by operator", parsed.skipped.EXCLUDED_BY_OPERATOR ?? 0);
  line("malformed / missing sender id", parsed.skipped.NON_USER_OR_MALFORMED ?? 0);
  line("unusable date", parsed.skipped.BAD_DATE ?? 0);
  line("bot-flagged senders", "0 detectable — the export has no bot flag (see below)");
  h("MESSAGES READ FROM REAL PEOPLE");
  line("messages imported", plan.totals.importedMessages);
  line("unique Telegram users", plan.totals.uniqueUsers);
  line("  with text / caption", st.messagesWithText);
  line("  sticker / media only (no text)", st.mediaOnlyMessages);
  line("  forwarded (never qualify)", st.forwardedMessages);
  line("  edited (final text is what we see)", st.editedMessages);
  line("  sent via an inline bot (human sender)", st.viaBotMessages);
  line("replies — real conversation (user / channel / deleted target)", `${fmt(st.replyKinds.toUser)} / ${fmt(st.replyKinds.toChannel)} / ${fmt(st.replyKinds.toUnknown)}`);
  line("replies — NOT counted (forum-topic root / join msg)", st.replyKinds.implicitTopicOrService);
  line("replies — NOT counted (into another chat)", st.replyKinds.otherChat);
  h("SCORING (same deterministic rules as live traffic)");
  const nothingToWrite = snap !== null && plan.users.length === 0;
  if (nothingToWrite) console.log("  NOTE: every member in this file is already stored, so this run writes nothing. The figures in the SCORING, HEROES and REACTIONS\n        sections describe only what THIS run would write (0) — not what is stored. See STORED STATE below.");
  line("new messages to write", plan.totals.newMessages);
  line("QUALIFYING messages", `${fmt(plan.totals.qualifyingMessages)}  (${pct(plan.totals.qualifyingMessages, plan.totals.newMessages)})`);
  line("rejected", fmt(plan.totals.newMessages - plan.totals.qualifyingMessages));
  for (const [r, n] of Object.entries(plan.totals.rejectedByReason).sort((x, y) => y[1] - x[1])) line(`      ${r}`, `${fmt(n)}  (${pct(n, plan.totals.newMessages)})`);
  h("HEROES");
  line(`users with ≥ ${settings.telegram.qualifyingThreshold} qualifying messages`, plan.totals.eligibleUsers);
  line("  → heroes created by this run's own writes", classSecret ? plan.heroes.length : `${plan.totals.eligibleUsers} (class preview off: CLASS_ROLL_SECRET is not configured)`);
  line("near misses (90–99 qualifying)", plan.totals.nearMissUsers);
  line("auto-flagged as spam-like (no hero)", plan.totals.autoFlaggedUsers);
  console.log("  qualifying-message distribution:");
  for (const d of plan.distribution) console.log(`      ≥ ${String(d.atLeast).padStart(5)}  ${fmt(d.users).padStart(6)} users`);
  if (plan.heroes.length) {
    const byClass: Record<string, number> = {};
    const byRarity: Record<string, number> = {};
    for (const hr of plan.heroes) {
      byClass[hr.classId] = (byClass[hr.classId] ?? 0) + 1;
      byRarity[hr.rarity] = (byRarity[hr.rarity] ?? 0) + 1;
    }
    line("class preview", JSON.stringify(byClass));
    line("rarity preview (PWR tier)", JSON.stringify(byRarity));
  }
  h("REACTIONS");
  line("reaction total in export", st.reactions.total);
  line("  with an identified user reactor", st.reactions.attributedToUsers);
  line("  by channels (not importable)", st.reactions.attributedToChannels);
  line("  reactor not listed by Telegram (not importable)", st.reactions.unattributed);
  line("importable after rules", plan.totals.reactionsImportable);
  line("  dropped: self-reaction", plan.totals.reactionsDroppedSelf);
  line("  dropped: author not imported", plan.totals.reactionsDroppedAuthorNotImported);
  line("  dropped: per-reactor daily cap", plan.totals.reactionsDroppedDailyCap);
  h("AMBIGUOUS / FOR OPERATOR REVIEW");
  console.log(`  bot-like display names (NOT removed — cannot be confirmed from the export):`);
  for (const b of st.botLikeSenders) console.log(`      user${b.id}  "${b.name}"  ${b.messages} msgs`);
  console.log(`  busiest senders (identity unchanged; verify none are bots/moderator tools):`);
  for (const u of plan.topUsers.slice(0, 8)) console.log(`      user${u.userId}  "${u.name}"  ${fmt(u.total)} msgs, ${fmt(u.qualifying)} qualifying${u.eligible ? "  → hero" : ""}`);
  if (st.parseErrors.length) {
    console.log(`  parse errors (${st.parseErrors.length}, first shown):`);
    for (const e of st.parseErrors.slice(0, 8)) console.log(`      ${e}`);
  } else {
    line("parse errors", 0);
  }

  // ---------------------------------------------------------------- database overlap
  if (snap) {
    h("DATABASE OVERLAP (read-only check)");
    const present = parsed.messages.filter((m) => snap.keys.has(m.messageId)).length;
    line("file messages already stored", present);
    line("file messages not yet stored", parsed.messages.length - present);
    line("members already complete (skipped on write)", decision.skipUsers.size);
    line("members to merge with existing rows", decision.mergeUsers.length);
  }

  const storedNow = stored as Awaited<ReturnType<typeof summarizeStored>> | null;
  if (storedNow) {
    h("STORED STATE (what the database already holds for this chat)");
    line("stored official-group messages", storedNow.messages);
    line("stored members / qualifying messages", `${fmt(storedNow.members)} / ${fmt(storedNow.qualifying)}`);
    line(`members with ≥ ${settings.telegram.qualifyingThreshold} qualifying (status OK)`, storedNow.eligible);
    line("  of those, WITHOUT a hero yet", storedNow.eligibleWithoutHero);
    if (storedNow.eligibleWithoutHero > 0) console.log(`  → preview them with:  pnpm telegram:backfill-heroes   (read-only). --apply here would also create them\n    (it reconciles heroes for every stored eligible member), but the dedicated command is the one to review first.`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? "APPLY" : "DRY_RUN",
    file: { path: file, bytes: raw.length, sha256 },
    chat: { name: parsed.chatName, type: parsed.chatType, exportId: parsed.exportChatId, botApiChatId: parsed.chatId },
    stats: st,
    skipped: parsed.skipped,
    totals: plan.totals,
    distribution: plan.distribution,
    heroPreview: plan.heroes.length ? { count: plan.heroes.length, classes: plan.heroes.reduce<Record<string, number>>((m, x) => ((m[x.classId] = (m[x.classId] ?? 0) + 1), m), {}) } : null,
    topUsers: plan.topUsers,
  };
  const reportPath = path.resolve(opt("report") ?? path.join(process.cwd(), ".data", `telegram-import-${apply ? "apply" : "dryrun"}.json`));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nreport written to ${reportPath}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing was written. Re-run with --apply to import.");
    return;
  }

  // ---------------------------------------------------------------- APPLY
  h("APPLYING");
  const deferHeroes = flag("defer-heroes");
  const migrations = await readMigrations();
  const expectedVersion = migrations.at(-1)?.version;
  const appliedVersions = new Set((await db.query<{ version: string }>("select version from supabase_migrations.schema_migrations")).map((r) => r.version));
  if (deferHeroes) {
    const missing = migrations.filter((m) => m.version <= BASELINE_MIGRATION && !appliedVersions.has(m.version)).map((m) => m.version);
    if (missing.length) throw new Error(`Database is missing baseline migration(s) ${missing.join(", ")}. Apply migrations first.`);
    const pendingLater = migrations.filter((m) => m.version > BASELINE_MIGRATION && !appliedVersions.has(m.version)).map((m) => m.version);
    console.log(`  --defer-heroes: schema has the baseline (${BASELINE_MIGRATION}); NOT yet applied here: ${pendingLater.join(", ") || "none"} → no heroes will be created in this run.`);
  } else {
    const latest = [...appliedVersions].sort().at(-1);
    if (latest !== expectedVersion || migrations.some((m) => !appliedVersions.has(m.version))) {
      throw new Error(`Database schema (${latest}) is not at the repository's latest migration (${expectedVersion}). Apply migrations first, or use --defer-heroes to import the data without creating heroes.`);
    }
  }
  const [{ n: classCount } = { n: 0 }] = await db.query<{ n: number }>("select count(*)::int as n from public.character_classes");
  if (classCount === 0) throw new Error("Reference data is missing (no classes). Run `pnpm db:migrate` first.");
  const progress = (p: { phase: string; done: number; total: number }) => process.stdout.write(`\r  ${p.phase.padEnd(9)} ${fmt(p.done)}/${fmt(p.total)}      `);
  const t0 = Date.now();
  const written = await applyImportPlan(db, plan, { onProgress: progress });
  console.log();
  const touched = [...new Set([...plan.users.map((u) => u.userId), ...plan.reactions.map((r) => r.authorId)])];
  const refreshed = await refreshDerivedCounters(db, touched, settings, progress);
  console.log();
  const heroes = deferHeroes ? { created: 0, ids: [] as string[] } : await reconcileHeroes(db, { settings, classes, classRollSecret: classSecret as string }, progress);
  console.log();
  await audit(db, "cli", "telegram.import.bulk", "chat", String(parsed.chatId), {
    sha256, file: path.basename(file), chatName: parsed.chatName, written, refreshed, heroesCreated: heroes.created, heroesDeferred: deferHeroes, totals: plan.totals,
  });
  h("RESULT");
  line("members written / skipped (already complete)", `${fmt(written.usersWritten)} / ${fmt(written.usersSkipped)}`);
  line("messages inserted", written.messagesInserted);
  line("messages re-scored (existing rows)", written.messagesRescored);
  line("reactions inserted", written.reactionsInserted);
  line("member counters refreshed", refreshed);
  line("heroes created", deferHeroes ? "0 (deferred: --defer-heroes)" : heroes.created);
  line("elapsed", `${((Date.now() - t0) / 1000).toFixed(1)} s`);
});
