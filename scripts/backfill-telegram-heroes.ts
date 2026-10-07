/**
 * Hero backfill for Telegram history that is ALREADY stored in the database.
 *
 * DRY RUN is the default: source rows are read in short, batched `SET TRANSACTION READ ONLY` transactions (enforced by
 * Postgres) and nothing is written. Scoring and planning run locally after the reads. The report is computed from stored rows —
 * by re-scoring every member's stored message features with the same pure pipeline the importer and the live
 * webhook use.
 *
 *   pnpm telegram:backfill-heroes -- --preview-shipped-threshold   # dry run using the new shipped threshold, without a DB write
 *   pnpm telegram:backfill-heroes -- --apply --expect-new-heroes N # create exactly the heroes due at the active DB threshold
 *
 * Flags: --chat-id <id>            (default TELEGRAM_OFFICIAL_CHAT_ID)
 *        --exclude-ids 1,2         never create a hero for these Telegram ids
 *        --confirm-human-ids 1,2   eligible members whose name looks like a bot but who are people
 *        --expect-eligible <n>     fail the health check if the eligible count differs
 *        --expect-new-heroes <n>   with --apply: refuse unless exactly n heroes are due (pins the run to the dry run)
 *        --preview-shipped-threshold  dry-run only: preview the shipped threshold (50) before the config migration
 *        --batch-size N            bounded members per short, read-only transaction (default 50, maximum 500)
 *        --message-page-size N     maximum stored messages per read-only page (default 1000, maximum 10000)
 *        --rescore                 with --apply: also persist a fresh evaluation where stored scores differ
 *        --scratch-check           dry-run only: replay this live read snapshot into isolated PGlite and verify creation there
 *        --report <path.json>
 *
 * Never inserts, duplicates or deletes messages, reactions or members. Safe to run repeatedly.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SETTINGS } from "../src/domain/settings";
import { scoreUserHistory } from "../src/domain/telegram/history";
import { planLayers } from "../src/domain/sprites/plan";
import { parseManifest } from "../src/domain/sprites/spec";
import { readMigrations } from "../src/server/db/migrate";
import { createPostgresDb } from "../src/server/db/postgres";
import { getEnv, getSecret } from "../src/server/env";
import { audit } from "../src/server/services/admin";
import { applyBackfill, buildBackfillPlanBatched, previousImportExpectation } from "../src/server/services/telegramBackfill";
import { loadImportConfig } from "../src/server/services/telegramImport";
import { verifyTelegramBackfillScratch, type ScratchBackfillResult } from "./lib/telegram-backfill-scratch";

import { run } from "./lib/context";

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ids = (name: string) => new Set((opt(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number));

const fmt = (n: number) => n.toLocaleString("en-US");
const line = (label: string, value: string | number) => console.log(`  ${label.padEnd(52)} ${typeof value === "number" ? fmt(value) : value}`);
const h = (title: string) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 70 - title.length))}`);
const count = (xs: readonly string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const PREVIOUS_DEFAULT_THRESHOLD = 100;

async function validateSpriteOutput(settings: typeof DEFAULT_SETTINGS, heroes: Array<{ userId: number; sprite: unknown }>) {
  if (heroes.length === 0) return { set: settings.visuals.spriteSet, status: "not needed", atlasesPresent: 0, atlasCount: 0, renderableHeroes: 0, missingLayers: [] as string[] };
  const directory = path.resolve(process.cwd(), "public", "sprites", settings.visuals.spriteSet);
  const raw = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as unknown;
  const manifest = parseManifest(raw);
  const atlasFiles = Object.values(manifest.images);
  const present: boolean[] = await Promise.all(atlasFiles.map(async (file) => {
    try { await access(path.join(directory, file)); return true; } catch { return false; }
  }));
  const missingLayers = heroes.flatMap((hero) => {
    const layers = planLayers(hero.sprite as never, manifest);
    return layers.missing.map((id) => `user${hero.userId}:${id}`);
  });
  const renderableHeroes = heroes.filter((hero) => {
    const layers = planLayers(hero.sprite as never, manifest);
    return !layers.fallback && layers.missing.length === 0;
  }).length;
  return { set: manifest.id, status: manifest.status, atlasesPresent: present.filter(Boolean).length, atlasCount: atlasFiles.length, renderableHeroes, missingLayers };
}

void run(async (ctx) => {
  const env = getEnv();
  let db = ctx.db;
  let target = ctx.target;
  if (env.DATABASE_URL) {
    const databaseUrl = new URL(env.DATABASE_URL);
    // The audit uses short transactions, so use Supabase's transaction pooler
    // when the configured URL is its session-pooler endpoint (port 5432).
    if (databaseUrl.hostname.endsWith(".pooler.supabase.com") && databaseUrl.port === "5432") databaseUrl.port = "6543";
    await db.close();
    db = createPostgresDb(databaseUrl.toString(), { maxConnections: 1 });
    target = `LIVE postgres://…@${databaseUrl.host}${databaseUrl.pathname} (short read-only transactions)`;
    ctx.close = () => db.close();
  }
  const apply = flag("apply");
  const previewShippedThreshold = flag("preview-shipped-threshold");
  const scratchCheck = flag("scratch-check");
  if (apply && previewShippedThreshold) throw new Error("--preview-shipped-threshold is read-only and cannot be used with --apply.");
  if (apply && scratchCheck) throw new Error("--scratch-check is read-only and cannot be combined with --apply.");
  const chatId = opt("chat-id") ? Number(opt("chat-id")) : env.TELEGRAM_OFFICIAL_CHAT_ID;
  if (chatId === undefined || !Number.isFinite(chatId)) throw new Error("No chat: set TELEGRAM_OFFICIAL_CHAT_ID or pass --chat-id.");
  if (apply && env.TELEGRAM_OFFICIAL_CHAT_ID !== chatId) throw new Error(`--apply only works for the configured official chat (${env.TELEGRAM_OFFICIAL_CHAT_ID}); got ${chatId}.`);
const excludeIds = ids("exclude-ids");
const confirmedHumanIds = ids("confirm-human-ids");
const batchSize = opt("batch-size") === undefined ? 50 : Number(opt("batch-size"));
const messagePageSize = opt("message-page-size") === undefined ? 1_000 : Number(opt("message-page-size"));

  let classSecret: string | null = null;
  try {
    classSecret = getSecret("CLASS_ROLL_SECRET", env);
  } catch (e) {
    if (apply) throw e;
  }

  // ---- everything below the first block is read-only
  const migrations = await readMigrations();
  const appliedVersions = await db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY");
    return new Set((await tx.query<{ version: string }>("select version from supabase_migrations.schema_migrations")).map((r) => r.version));
  });
  const missingMigrations = migrations.filter((m) => !appliedVersions.has(m.version)).map((m) => m.version);

  const cfg = await db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY");
    return loadImportConfig(tx);
  });
  const settings = previewShippedThreshold
    ? { ...cfg.settings, telegram: { ...cfg.settings.telegram, qualifyingThreshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold } }
    : cfg.settings;
const batchDurations: number[] = [];
const readTransactionDurations: number[] = [];
const { plan, stored } = await buildBackfillPlanBatched(db, { chatId, settings, classes: cfg.classes, classRollSecret: classSecret, excludeIds, confirmedHumanIds }, {
    batchSize,
    messagePageSize,
    onRead: ({ batch, page, rows, durationMs }) => {
      readTransactionDurations.push(durationMs);
      if (page > 0) console.log(`\n  Read message page ${page} of batch ${batch}: ${fmt(rows)} rows (${durationMs.toFixed(0)}ms)`);
    },
    onBatch: ({ done, total, batch, durationMs }) => {
      batchDurations.push(durationMs);
      process.stdout.write(`\r  Read batch ${batch}: ${fmt(done)}/${fmt(total)} Telegram members (${durationMs.toFixed(0)}ms)      `);
    },
  });
  process.stdout.write("\n");
  const storedMessageCount = stored.reduce((sum, member) => sum + member.messages.length, 0);
  const seenMessageIds = new Set<number>();
  const duplicateMessageIds = new Set<number>();
  for (const member of stored) for (const message of member.messages) {
    if (seenMessageIds.has(message.messageId)) duplicateMessageIds.add(message.messageId);
    seenMessageIds.add(message.messageId);
  }
  const [sourceMessageCount] = await db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return tx.query<{ n: number }>("select count(*)::int as n from public.telegram_messages where chat_id = $1", [chatId]);
  });
  if (storedMessageCount !== Number(sourceMessageCount?.n ?? -1) || duplicateMessageIds.size > 0) {
    throw new Error(`Paged source history did not reassemble uniquely: read ${storedMessageCount}, database count ${sourceMessageCount?.n ?? "unknown"}, duplicate message ids ${duplicateMessageIds.size}${duplicateMessageIds.size ? ` (first ${[...duplicateMessageIds].slice(0, 5).join(", ")})` : ""}.`);
  }
  const previous = await db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY");
    return previousImportExpectation(tx, chatId);
  });
  const { heroCounts, currentClasses, sourceHeroes, heroUsers, classRows, skillRows } = await db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY");
    const [heroCounts] = await tx.query<{ total: number; community: number }>(
      "select count(*)::int as total, count(*) filter (where kind = 'COMMUNITY' and not is_demo)::int as community from public.characters",
    );
    const currentClasses = await tx.query<{ id: string; name: string; heroes: number }>(
      `select cc.id, cc.name, count(c.id)::int as heroes from public.character_classes cc
        left join public.characters c on c.class_id = cc.id and c.kind = 'COMMUNITY' and not c.is_demo
        group by cc.id, cc.name order by cc.sort_order, cc.id`,
    );
    const sourceHeroes = await tx.query<{ character: Record<string, unknown>; stats: Record<string, unknown> | null; appearance: Record<string, unknown> | null }>(
      `select to_jsonb(c) as character, to_jsonb(s) as stats, to_jsonb(a) as appearance
         from public.characters c left join public.character_stats s on s.character_id = c.id
         left join public.character_appearances a on a.character_id = c.id
        where c.kind = 'COMMUNITY' and not c.is_demo order by c.telegram_user_id`,
    );
    const sourceTelegramIds = sourceHeroes.map((hero) => Number(hero.character.telegram_user_id));
    const heroUsers = sourceTelegramIds.length ? await tx.query<Record<string, unknown>>(
      "select * from public.telegram_users where telegram_user_id = any($1::bigint[]) order by telegram_user_id", [sourceTelegramIds],
    ) : [];
    const classRows = await tx.query<Record<string, unknown>>("select id, name, description, enabled, sort_order, definition from public.character_classes order by sort_order, id");
    const skillRows = await tx.query<Record<string, unknown>>("select id, name, enabled, definition from public.skills order by id");
    return { heroCounts, currentClasses, sourceHeroes, heroUsers, classRows, skillRows };
  });
  const t = plan.totals;
  const adjacentUsers = plan.members.filter((m) => m.stored.qualifying >= 40 && m.stored.qualifying <= 110);
  const adjacentDrift = adjacentUsers.filter((m) => m.stored.qualifying !== m.expected.qualifying);
const crossedUp = plan.members.filter((m) => m.stored.qualifying < 50 && m.expected.qualifying >= 50);
const crossedDown = plan.members.filter((m) => m.stored.qualifying >= 50 && m.expected.qualifying < 50);
const memberRows = new Map(stored.map((member) => [member.userId, member]));
const crossingReasons = (userId: number, direction: "up" | "down") => {
  const member = memberRows.get(userId);
  if (!member) return {};
  const fresh = scoreUserHistory(member.messages.map((message) => message.features), "OK", settings.telegram);
  const reasons: Record<string, number> = {};
  member.messages.forEach((message, i) => {
    const next = fresh.scored[i];
    if (!next || message.qualifies === next.qualifies) return;
    if (direction === "up" && !message.qualifies && next.qualifies) {
      const reason = message.reason ?? "STORED_REJECTED_UNKNOWN";
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    } else if (direction === "down" && message.qualifies && !next.qualifies) {
      const reason = next.reason ?? "RESCORED_REJECTED_UNKNOWN";
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  });
  return reasons;
};
const crossingDetails = [
  ...crossedUp.map((m) => ({ userId: m.userId, stored: m.stored.qualifying, rescored: m.expected.qualifying, status: m.status, direction: "up" as const, causes: crossingReasons(m.userId, "up") })),
  ...crossedDown.map((m) => ({ userId: m.userId, stored: m.stored.qualifying, rescored: m.expected.qualifying, status: m.status, direction: "down" as const, causes: crossingReasons(m.userId, "down") })),
];
  const eligibleWithHero = plan.members.filter((m) => m.eligible && m.hasHero).length;
  const eligibleWithoutHero = plan.members.filter((m) => m.eligible && !m.hasHero).length;
  const newClassCounts = count(plan.heroes.map((x) => x.classId));
  const projectedClasses = Object.fromEntries(currentClasses.map((c) => [c.name, Number(c.heroes) + (newClassCounts[c.id] ?? 0)]));
  const spriteOutput = await validateSpriteOutput(settings, plan.heroes);
  let scratch: ScratchBackfillResult | null = null;
  if (scratchCheck) {
    if (!classSecret) throw new Error("--scratch-check requires CLASS_ROLL_SECRET so generated heroes can be verified.");
    scratch = await verifyTelegramBackfillScratch({
      chatId, settings, classes: cfg.classes, classRollSecret: classSecret, excludeIds, confirmedHumanIds, stored,
      heroes: sourceHeroes, heroUsers, classRows, skillRows, plan,
    });
  }
  const applyCommand = [
    "pnpm telegram:backfill-heroes -- --apply",
    `--expect-new-heroes ${t.wouldCreate}`,
    ...(t.driftMembers > 0 || !t.eligibilitySetsMatch ? ["--rescore"] : []),
    ...(excludeIds.size ? [`--exclude-ids ${[...excludeIds].sort((a, b) => a - b).join(",")}`] : []),
    ...(confirmedHumanIds.size ? [`--confirm-human-ids ${[...confirmedHumanIds].sort((a, b) => a - b).join(",")}`] : []),
  ].join(" ");

  h("TARGET");
  line("database", target);
  line("official chat id", String(chatId));
  line("schema", missingMigrations.length ? `BEHIND — missing ${missingMigrations.join(", ")} (--apply would refuse)` : `up to date (${migrations.at(-1)?.version})`);
  line("settings / classes", cfg.source);
  line("stored minimum qualifying messages", cfg.settings.telegram.qualifyingThreshold);
  line("minimum used for this preview", plan.threshold);
  if (previewShippedThreshold) line("threshold source", "shipped code default (preview only; database unchanged)");
  line("CLASS_ROLL_SECRET", classSecret ? `loaded (${classSecret.length} chars) — class preview ON` : "NOT configured — class preview OFF, --apply would refuse");
  line("mode", apply ? "APPLY" : "DRY RUN (read-only, batched transactions)");
  line("history read batch size", batchSize);
  line("message page size", messagePageSize);
  if (batchDurations.length) {
    const averageMs = batchDurations.reduce((sum, x) => sum + x, 0) / batchDurations.length;
    line("read-only member-batch processing latency (avg / max)", `${averageMs.toFixed(0)}ms / ${Math.max(...batchDurations).toFixed(0)}ms`);
  }
  if (readTransactionDurations.length) {
    const averageMs = readTransactionDurations.reduce((sum, x) => sum + x, 0) / readTransactionDurations.length;
    line("read-only transaction latency (avg / max)", `${averageMs.toFixed(0)}ms / ${Math.max(...readTransactionDurations).toFixed(0)}ms`);
  }

  h("STORED HISTORY CONSIDERED");
  line("stored official-group messages considered", t.messagesConsidered);
  line("source message rows read exactly once", storedMessageCount);
  line("unique Telegram users considered", t.membersConsidered);

  h("RE-EVALUATION (stored message features re-scored today)");
  line("qualifying messages — stored", t.storedQualifying);
  line("qualifying messages — freshly re-scored", t.rescoredQualifying);
  line("rejected (stored)", t.storedRejected);
  for (const [r, n] of Object.entries(t.rejectedByReason).sort((a, b) => b[1] - a[1])) line(`      ${r}`, n);
  line("members whose stored scores/counters differ", `${fmt(t.driftMembers)} (${fmt(t.driftMessages)} message score(s))`);
  line("users with stored count 40–110 qualifying", adjacentUsers.length);
  line("users in that band whose qualifying count drifted", adjacentDrift.length);
  line("crossed 50 upward (stored below → freshly eligible)", crossedUp.length);
  for (const m of crossedUp) console.log(`      user${m.userId}  stored=${m.stored.qualifying}  rescored=${m.expected.qualifying}  status=${m.status}  stored rejection reasons now qualifying=${JSON.stringify(crossingReasons(m.userId, "up"))}`);
  line("crossed 50 downward (stored eligible → freshly below)", crossedDown.length);
  for (const m of crossedDown) console.log(`      user${m.userId}  stored=${m.stored.qualifying}  rescored=${m.expected.qualifying}  status=${m.status}  fresh rejection reasons=${JSON.stringify(crossingReasons(m.userId, "down"))}`);
  const drifters = plan.members.filter((m) => m.status === "OK" && m.hasDrift).slice(0, 5);
  for (const d of drifters) console.log(`      user${d.userId} "${d.displayName}"  messages=${d.drift.messages} counters=[${d.drift.counters.join(",")}] daily=${d.drift.daily} behavior=${d.drift.behavior}`);

  h("ELIGIBILITY");
  line(`users with ≥ ${plan.threshold} qualifying messages (re-scored, status OK)`, t.eligible);
  line(`users with ${plan.threshold}–${PREVIOUS_DEFAULT_THRESHOLD - 1} qualifying messages`, plan.members.filter((m) => m.status === "OK" && m.expected.qualifying >= plan.threshold && m.expected.qualifying < PREVIOUS_DEFAULT_THRESHOLD).length);
  line("  same test on the stored counters", `${fmt(t.eligibleByStoredCounters)}  (${t.eligibilitySetsMatch ? "identical set" : "DIFFERENT SET"})`);
  line("near misses", `${fmt(t.nearMiss)} (${plan.threshold - 10}–${plan.threshold - 1} qualifying)`);
  for (const d of plan.distribution) console.log(`      ≥ ${String(d.atLeast).padStart(5)}  ${fmt(d.users).padStart(6)} users`);

  h("HEROES");
  line("current heroes (all types, including demos)", Number(heroCounts?.total ?? 0));
  line("current real community heroes", Number(heroCounts?.community ?? 0));
  line("heroes already present", t.heroesPresent);
  line("eligible users who already have a hero", eligibleWithHero);
  line("eligible users without a hero", eligibleWithoutHero);
  line(`newly eligible users without a hero (${plan.threshold}–${PREVIOUS_DEFAULT_THRESHOLD - 1})`, plan.members.filter((m) => m.status === "OK" && m.expected.qualifying >= plan.threshold && m.expected.qualifying < PREVIOUS_DEFAULT_THRESHOLD && !m.hasHero).length);
  line("heroes that WOULD be created", t.wouldCreate);
  line("projected total heroes (all types)", Number(heroCounts?.total ?? 0) + t.wouldCreate);
  line("projected total real community heroes", Number(heroCounts?.community ?? 0) + t.wouldCreate);
  line("  blocked: operator exclusion / unconfirmed bot-like name", `${t.blockedOperator} / ${t.blockedBotLike}`);
  line("existing heroes whose member is no longer eligible", t.heroesNoLongerEligible);
  if (scratch) {
    line("isolated PGlite: existing / created / total heroes", `${scratch.existingHeroes} / ${scratch.createdHeroes} / ${scratch.totalHeroes}`);
    line("  TOTAL heroes / ARENA-ELIGIBLE now / not eligible (suspended, banned…)", `${scratch.totalHeroes} / ${scratch.arenaEligibleHeroes} / ${scratch.ineligibleHeroes}`);
    line("  existing hero rows / Arena history preserved / retry idempotent", `${scratch.preExistingHeroRowsPreserved} / ${scratch.preExistingArenaHistoryPreserved} / ${scratch.idempotentSecondRun}`);
    line("  new generated rows verified / eligible missing / duplicate identity groups", `${scratch.completeGeneratedRows} / ${scratch.missingEligibleHeroes} / ${scratch.duplicateTelegramIdentities}`);
    line("  Arena eligible / prepared ahead / initial lineup", `${scratch.arena.eligibleHeroes} / ${scratch.arena.preparedAhead} / ${scratch.arena.lineupMs.toFixed(1)}ms`);
    const hv = scratch.heroVersions;
    line("  hero versions: existing with INITIAL v1 / new with INITIAL v1 / total", `${hv.existingWithInitialV1} / ${hv.newWithInitialV1} / ${hv.totalInitialVersions} (all versions: ${hv.totalVersions})`);
    line("  hero versions: missing / duplicate current / existing changed / snapshot mismatches", `${hv.missingInitialVersions} / ${hv.duplicateCurrentVersions} / ${hv.existingChanged} / ${hv.existingSnapshotMismatches}`);
    line("  hero versions: created by 2nd run / audit violations", `${hv.secondRunVersionsCreated} / ${hv.auditViolations}`);
    line("  info: heroes whose CACHED characters.power differs from their stored components (pre-existing; the migration never touches it)", hv.staleCachedPower);
    const rp = scratch.rarityPower;
    const sum = (x: { count: number; min: number; p25: number; median: number; p75: number; p90: number; max: number; mean: number }) => `n=${x.count} min ${x.min} · p25 ${x.p25} · median ${x.median} · p75 ${x.p75} · p90 ${x.p90} · max ${x.max} (mean ${x.mean})`;
    h("RARITY POWER (scratch: the existing heroes are rebalanced, the new ones are born on the current generator)");
    line("generator / heroes / current version on that generator", `${rp.generator} / ${rp.heroes} / ${rp.onCurrentGenerator}`);
    console.log("  BEFORE — the existing heroes under the first generator's stat-weight POWER (from the copied live rows):");
    line("    all existing", sum(rp.legacyBefore.overall));
    for (const [k, v] of Object.entries(rp.legacyBefore.byRarity)) line(`    ${k}`, sum(v));
    for (const [k, v] of Object.entries(rp.legacyBefore.byClass)) line(`    class ${k}`, sum(v));
    console.log("  REBALANCE (existing heroes → SYSTEM_REBALANCE v2; v1 untouched):");
    line("    attempted / rebalanced / deferred (in an unsettled Arena roster)", `${rp.rebalance.attempted} / ${rp.rebalance.rebalanced} / ${rp.rebalance.deferredInArena}`);
    line("    with a SYSTEM_REBALANCE v2 / v1 rows changed / class·rarity·identity changed", `${rp.rebalance.withRebalanceV2} / ${rp.rebalance.v1Changed} / ${rp.rebalance.identityChanged}`);
    line("    versions created by a 2nd run / cached power ≠ version power", `${rp.rebalance.secondRunCreated} / ${rp.rebalance.cachedPowerMismatch}`);
    console.log("  AFTER — authoritative PWR of the CURRENT versions:");
    line("    existing heroes (rebalanced)", sum(rp.afterExisting.overall));
    line("    new heroes (born on the current generator)", sum(rp.afterNew.overall));
    for (const [k, v] of Object.entries(rp.all.byRarity)) line(`    ALL ${k}`, sum(v));
    line("    rarity counts", JSON.stringify(rp.all.rarityCounts));
    line("    class counts", JSON.stringify(rp.all.byClass));
    line("    invalid PWR / outside rarity band / bands non-overlapping", `${rp.invalidPower} / ${rp.outsideTier} / ${rp.nonOverlapping}`);
    line("    missing sprite layers / audit_hero_rarity_power() rows", `${rp.missingAssets} / ${rp.auditRarityViolations}`);
  }
  if (plan.heroes.length) {
    line("class preview (permanent once created)", JSON.stringify(count(plan.heroes.map((x) => x.classId))));
    line("projected community class distribution", JSON.stringify(projectedClasses));
    line("rarity preview (each rarity is a PWR tier)", JSON.stringify(count(plan.heroes.map((x) => x.rarity))));
    line("classes / rarities valid", `${plan.heroes.filter((x) => x.classValid && x.rarityValid).length}/${plan.heroes.length}`);
    line("stats / appearances valid", `${plan.heroes.filter((x) => x.statsValid).length}/${plan.heroes.length} stats, ${plan.heroes.filter((x) => x.appearanceValid).length}/${plan.heroes.length} appearances`);
    line("sprite config valid / deterministic", `${plan.heroes.filter((x) => x.spriteValid).length}/${plan.heroes.length} valid, ${plan.heroes.filter((x) => x.deterministic).length}/${plan.heroes.length} deterministic`);
    line("sprite set / atlas files", `${spriteOutput.set} (${spriteOutput.status}), ${spriteOutput.atlasesPresent}/${spriteOutput.atlasCount} files present`);
    line("sprite plans with all layer references", `${spriteOutput.renderableHeroes}/${plan.heroes.length} renderable; ${spriteOutput.missingLayers.length} missing layer(s)`);
    console.log("      telegram id   qualifying  class     rarity   hero name");
    for (const x of plan.heroes) console.log(`      ${String(x.userId).padEnd(12)}  ${String(x.qualifying).padStart(9)}  ${x.classId.padEnd(8)}  ${x.rarity.padEnd(7)}  ${x.name}${x.nameFromFallback ? "   (name fallback)" : ""}`);
  } else if (!classSecret) {
    console.log("      (no hero list: CLASS_ROLL_SECRET is not configured here)");
  }

  h("SPAM-FLAGGED / EXCLUDED");
  line("members not in status OK (never eligible)", t.nonOkMembers);
  for (const x of plan.nonOk) console.log(`      user${x.userId}  "${x.name}"  ${x.status}  ${x.total} msgs, ${x.storedQualifying} stored-qualifying  ${x.reason ?? ""}`);
  line("operator exclusions given", excludeIds.size);

  h("AMBIGUOUS IDENTITIES (identity is always the numeric Telegram id)");
  console.log("  bot-like names (kept, not removed — a bot cannot be proven from the data):");
  for (const b of plan.ambiguous.botLike) console.log(`      user${b.userId}  "${b.name}"  ${b.total} msgs, ${b.qualifying} qualifying  ${b.eligible ? "ELIGIBLE → needs --confirm-human-ids or --exclude-ids" : "below threshold → cannot become a hero"}`);
  if (!plan.ambiguous.botLike.length) console.log("      none");
  line("eligible members sharing one display name", plan.ambiguous.duplicateEligibleNames.length);
  for (const d of plan.ambiguous.duplicateEligibleNames) console.log(`      "${d.name}": ${d.userIds.join(", ")}`);
  line("heroes that would get a fallback name (symbol-only name)", plan.ambiguous.fallbackNames.length);
  for (const f of plan.ambiguous.fallbackNames) console.log(`      user${f.userId}  "${f.displayName}" → "${f.heroName}"`);

  h("DISCREPANCY CHECK vs. the earlier expectation");
  const explicitExpected = opt("expect-eligible");
  const expected = explicitExpected !== undefined ? Number(explicitExpected) : previous.expectedEligible;
  const eligibleAtStoredThreshold = plan.members.filter((m) => m.status === "OK" && m.expected.qualifying >= cfg.settings.telegram.qualifyingThreshold).length;
  const eligibleForComparison = explicitExpected !== undefined || plan.threshold === cfg.settings.telegram.qualifyingThreshold ? t.eligible : eligibleAtStoredThreshold;
  line("earlier bulk-import runs in the audit log", previous.runs);
  line("eligible members those runs planned for", previous.expectedEligible ?? "not recorded");
  line("eligible members now", t.eligible);
  if (eligibleForComparison !== t.eligible) line(`eligible members at stored threshold ${cfg.settings.telegram.qualifyingThreshold}`, eligibleAtStoredThreshold);
  const discrepancy = expected !== null && expected !== undefined && expected !== eligibleForComparison;
  line("discrepancy", expected === null || expected === undefined ? "no baseline to compare" : discrepancy ? `YES (${eligibleForComparison} vs ${expected} at the comparison threshold)` : "none");

  h("VERDICT");
  const problems: string[] = [];
  if (t.driftMembers > 0) problems.push(`${t.driftMembers} member(s) with stored scores that differ from a fresh evaluation`);
  if (!t.eligibilitySetsMatch) problems.push("eligible set differs between stored counters and fresh evaluation");
  if (t.blockedBotLike > 0) problems.push(`${t.blockedBotLike} eligible member(s) with a bot-like name need a decision`);
  if (discrepancy) problems.push("eligible count differs from the earlier expectation");
  if (!classSecret) problems.push("CLASS_ROLL_SECRET not configured");
  if (plan.heroes.some((x) => !x.classValid || !x.rarityValid || !x.statsValid || !x.appearanceValid || !x.spriteValid || !x.deterministic) || spriteOutput.atlasesPresent !== spriteOutput.atlasCount || spriteOutput.renderableHeroes !== plan.heroes.length || spriteOutput.missingLayers.length > 0) problems.push("a hero preview has invalid stats, appearance or sprite references, or is not deterministic");
  if (t.heroesNoLongerEligible > 0) problems.push(`${t.heroesNoLongerEligible} existing hero(es) belong to members who are no longer eligible (review only, nothing is removed)`);
  const apply_blockers = [...(missingMigrations.length ? [`schema behind: ${missingMigrations.join(", ")}`] : []), ...(cfg.source !== "database" ? ["reference rows are double-encoded: run pnpm db:repair-jsonb"] : [])];
  console.log(problems.length ? `  NOT CLEAN — ${problems.join("; ")}` : "  HEALTHY — stored history re-evaluates to exactly what is stored; no discrepancies.");
  if (apply_blockers.length) console.log(`  --apply is blocked by: ${apply_blockers.join("; ")}`);

  const reportPath = path.resolve(opt("report") ?? path.join(process.cwd(), ".data", `telegram-backfill-${apply ? "apply" : "dryrun"}.json`));
  const batchLatency = batchDurations.length ? {
    count: batchDurations.length,
    averageMs: batchDurations.reduce((sum, x) => sum + x, 0) / batchDurations.length,
    maxMs: Math.max(...batchDurations),
  } : null;
  const transactionLatency = readTransactionDurations.length ? {
    count: readTransactionDurations.length,
    averageMs: readTransactionDurations.reduce((sum, x) => sum + x, 0) / readTransactionDurations.length,
    maxMs: Math.max(...readTransactionDurations),
  } : null;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), mode: apply ? "APPLY" : "DRY_RUN", chatId, storedThreshold: cfg.settings.telegram.qualifyingThreshold, previewThreshold: plan.threshold, previewShippedThreshold, eligibleAtStoredThreshold, heroCounts, projectedClasses, spriteOutput, scratch, batchLatency, transactionLatency, rescore: { storedCount40to110: adjacentUsers.length, driftedCount40to110: adjacentDrift.length, crossedUp: crossedUp.map((m) => ({ userId: m.userId, stored: m.stored.qualifying, rescored: m.expected.qualifying, status: m.status })), crossedDown: crossedDown.map((m) => ({ userId: m.userId, stored: m.stored.qualifying, rescored: m.expected.qualifying, status: m.status })), crossingDetails }, totals: t, distribution: plan.distribution, heroes: plan.heroes, nonOk: plan.nonOk, ambiguous: plan.ambiguous, previous, problems, apply_blockers }, null, 2));
  console.log(`\nreport written to ${reportPath}`);

  if (!apply) {
    if (previewShippedThreshold) {
      console.log(`\nDRY RUN — nothing was written. After the pending migrations are explicitly approved and applied, this is the guarded command to create exactly these ${t.wouldCreate} hero(es):\n  ${applyCommand}`);
    } else {
      console.log(`\nDRY RUN — nothing was written. To create exactly the ${t.wouldCreate} hero(es) currently due:\n  ${applyCommand}`);
    }
    return;
  }

  // ---------------------------------------------------------------- APPLY
  if (apply_blockers.length) throw new Error(`Refusing: ${apply_blockers.join("; ")}`);
  if (!classSecret) throw new Error("CLASS_ROLL_SECRET is required to create heroes.");
  h("APPLYING");
  const progress = (p: { phase: string; done: number; total: number }) => process.stdout.write(`\r  ${p.phase.padEnd(9)} ${fmt(p.done)}/${fmt(p.total)}      `);
  const expectNew = opt("expect-new-heroes");
  const result = await applyBackfill(db, { chatId, settings, classes: cfg.classes, classRollSecret: classSecret, excludeIds, confirmedHumanIds }, {
    rescore: flag("rescore"),
    ...(expectNew !== undefined ? { expectNewHeroes: Number(expectNew) } : {}),
    onProgress: progress,
  });
  console.log();
  await audit(db, "cli", "telegram.backfill.heroes", "chat", String(chatId), {
    heroesCreated: result.heroesCreated, rescoredMembers: result.rescoredMembers, heroesPresentAfter: result.after.totals.heroesPresent, eligible: t.eligible, excludeIds: [...excludeIds], confirmedHumanIds: [...confirmedHumanIds],
  });
  h("RESULT");
  line("heroes created", result.heroesCreated);
  line("members re-scored", result.rescoredMembers);
  line("heroes present now", result.after.totals.heroesPresent);
  line("heroes still due after this run", result.after.totals.wouldCreate);
  line("messages / reactions / members touched", "0 / 0 / 0 (never inserted, deleted or duplicated)");
  console.log(`\nverify: pnpm telegram:verify -- <result.json> --require-heroes`);
});
