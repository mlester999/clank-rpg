import { generateCharacter } from "@/domain/character/generate";
import { computeEffectiveStats, computePower } from "@/domain/character/stats";
import { DEFAULT_SETTINGS, type GameSettings } from "@/domain/settings";
import { addStats, zeroStats } from "@/domain/stats";
import { loadClasses } from "@/server/config/settingsRepo";
import { json, type Db } from "@/server/db/types";

/**
 * Heroes exactly as the code created them BEFORE hero versions existed: a character, its stats row, its appearance row, a cached POWER — and
 * NO version history (the table does not exist yet at that schema). This is what the LIVE database holds today; migration 1800 must turn each
 * of these into a hero with one INITIAL v1 without changing anything about it.
 *
 * The cached POWER is the first generator's stat-weight POWER (what the live rows hold), not the rarity-power formula.
 *
 * Works on a database migrated up to (not including) the hero-version migration — and also on the current schema, where each hero is then
 * written together with the INITIAL v1 snapshot of exactly that stored state (hero generator 1), in one transaction.
 */
export async function seedLegacyHeroes(
  db: Db,
  count: number,
  opts: { startId?: number; settings?: GameSettings; secret?: string; origin?: "TELEGRAM" | "HISTORICAL_IMPORT" | "DEV_SEED"; activity?: (i: number) => number } = {},
): Promise<Array<{ id: string; telegramUserId: number }>> {
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  const secret = opts.secret ?? "legacy-hero-secret-value-1234567890";
  const origin = opts.origin ?? "HISTORICAL_IMPORT";
  const classes = await loadClasses(db);
  const out: Array<{ id: string; telegramUserId: number }> = [];
  for (let i = 0; i < count; i++) {
    const telegramUserId = (opts.startId ?? 5_000_000) + i;
    const activityScore = opts.activity ? opts.activity(i) : (i % 9) * 11;
    // a spread of behaviour so every class (and every rarity, over enough heroes) shows up
    const pick = (m: number, ...v: number[]) => v[i % m] as number;
    const behavior = {
      msgs: 120, replies: pick(3, 6, 30, 70), questions: pick(4, 2, 12, 36, 6), exclaims: pick(5, 4, 14, 40, 8, 20), long: pick(3, 2, 8, 24), links: pick(7, 1, 4, 16, 0, 8, 2, 20),
      media: pick(2, 1, 20), night: pick(8, 6, 20, 50, 10, 40, 8, 30, 14), burst: pick(5, 3, 10, 40, 20, 6), spam: 0,
    };
    await db.query(
      `insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count, activity_score, behavior, is_demo)
       values ($1, $2, 120, $3, $4::jsonb, $5) on conflict do nothing`,
      [telegramUserId, `Legacy ${telegramUserId}`, activityScore, json(behavior), origin === "DEV_SEED"],
    );
    // The heroes the LIVE database holds were drawn by the first generator — reproduce exactly that.
    const g = generateCharacter({ telegramUserId, displayName: `Legacy ${telegramUserId}`, behavior, activityScore, classes, settings, secret, generatorVersion: "hero-gen/1" });
    const classDef = classes.find((c) => c.id === g.classId)!;
    const legacyPower = computePower(computeEffectiveStats({ classDef, variation: addStats(g.variation), telegram: addStats(g.telegramBonus), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() }).total, settings.character);
    const write = async (q: Pick<Db, "query">): Promise<string> => {
      const [row] = await q.query<{ id: string }>(
        `insert into public.characters (kind, telegram_user_id, class_id, name, origin, is_demo, power) values ('COMMUNITY', $1, $2, $3, $4, $5, $6) returning id`,
        [telegramUserId, g.classId, g.name, origin, origin === "DEV_SEED", legacyPower],
      );
      const id = (row as { id: string }).id;
      await q.query("insert into public.character_stats (character_id, variation, telegram_bonus) values ($1, $2::jsonb, $3::jsonb)", [id, json(g.variation), json(g.telegramBonus)]);
      await q.query("insert into public.character_appearances (character_id, rarity, parts, seed, sprite) values ($1, $2, $3::jsonb, $4, $5::jsonb)", [id, g.rarity, json(g.appearance), g.appearanceSeed, json(g.sprite)]);
      return id;
    };
    // On the current schema a hero cannot exist without a version: write the rows and their INITIAL v1 snapshot in ONE transaction.
    const [hasSnapshot] = await db.query<{ ok: boolean }>("select to_regprocedure('public.hero_snapshot_initial_version(uuid,text)') is not null as ok");
    let id: string;
    if (hasSnapshot?.ok) {
      id = await db.transaction(async (tx) => {
        const created = await write(tx);
        await tx.query("select public.hero_snapshot_initial_version($1, 'system:test-legacy')", [created]);
        return created;
      });
    } else {
      id = await write(db);
    }
    out.push({ id, telegramUserId });
  }
  return out;
}
