import { computeHoldingScore, holdingStatBonus, type HoldingInput } from "@/domain/holdings/holdingPower";
import { evolveStreak, loyaltyStatBonus, reachedMilestones, streakDays, type StreakState } from "@/domain/holdings/streaks";
import { computeTradingScore, tradingStatBonus } from "@/domain/holdings/trading";
import type { ClassDef } from "@/domain/rules";
import type { GameSettings } from "@/domain/settings";
import { ProviderUnavailableError, type BalanceReader } from "../chain/types";
import { json, type Db } from "../db/types";
import { getEnv } from "../env";

import { evaluateAchievements } from "./achievements";
import { refreshPower } from "./characters";
import { isNativeQuote } from "./tokens";

export type HoldingsSyncResult =
  | {
      status: "OK";
      eligibleTokens: number;
      holdingScore: number;
      loyaltyDays: number;
      tradingScore: number;
      holdings: Array<{ symbol: string; supplyFraction: number; streakDays: number }>;
    }
  | { status: "NO_WALLET" | "DISABLED" | "THROTTLED" }
  | { status: "UNAVAILABLE"; reason: string };

export interface HoldingsDeps {
  reader: BalanceReader | null;
  settings: GameSettings;
  classes: ClassDef[];
  now?: Date;
  /** Skip the per-character throttle (cron / admin). */
  force?: boolean;
}

interface TokenRow {
  id: string;
  address: string;
  symbol: string;
  decimals: number;
  total_supply: string | null;
  price_quote: string | null;
  quote_currency: string | null;
}

interface StreakRow {
  id: string;
  token_id: string;
  started_at: Date;
  peak_balance: string;
  last_verified_at: Date;
}

const SUPPLY_SCALE = 1_000_000_000n;

/**
 * Verifies a claimed hero's wallet against ONLY eligible (bonded) Clank.trade coins on
 * Robinhood Chain and recomputes the wallet-derived stat components. Every number comes from a
 * live provider read in this call: if the RPC is unreachable we return UNAVAILABLE and leave the
 * previous verified state untouched — we never guess or decay silently.
 */
export async function syncCharacterHoldings(db: Db, characterId: string, deps: HoldingsDeps): Promise<HoldingsSyncResult> {
  const now = deps.now ?? new Date();
  const s = deps.settings;
  if (!s.holdings.enabled) return { status: "DISABLED" };

  const [wallet] = await db.query<{ address: string; class_id: string; last_obs: Date | null }>(
    `select w.address, c.class_id, (select max(observed_at) from public.token_holdings h where h.character_id = c.id) as last_obs
       from public.wallet_links w join public.characters c on c.id = w.character_id
      where w.character_id = $1 and w.unlinked_at is null`,
    [characterId],
  );
  if (!wallet) return { status: "NO_WALLET" };
  if (!deps.force && wallet.last_obs && now.getTime() - new Date(wallet.last_obs).getTime() < s.holdings.syncMinIntervalSeconds * 1000) return { status: "THROTTLED" };
  if (!deps.reader) return { status: "UNAVAILABLE", reason: "No Robinhood Chain data source is configured." };

  // $CLANKRPG is NEVER a holdings-bonus coin: its balance only decides the holder PRIZE BONUS on an earned leaderboard prize (rewards/holders.ts), never POWER.
  const clankrpg = (getEnv().CLANKRPG_TOKEN_ADDRESS ?? "").trim().toLowerCase();
  const tokens = (
    await db.query<TokenRow>("select id, address, symbol, decimals, total_supply, price_quote, quote_currency from public.eligible_tokens where status = 'ELIGIBLE' order by address")
  ).filter((t) => clankrpg === "" || t.address.toLowerCase() !== clankrpg);
  let balances: Map<string, bigint>;
  try {
    balances = await deps.reader.getBalances(wallet.address, tokens.map((t) => ({ address: t.address, decimals: t.decimals })));
  } catch (e) {
    if (e instanceof ProviderUnavailableError) return { status: "UNAVAILABLE", reason: "Robinhood Chain data is temporarily unreachable." };
    throw e;
  }

  const classDef = deps.classes.find((c) => c.id === wallet.class_id);
  if (!classDef) throw new Error(`unknown class ${wallet.class_id}`);

  return db.transaction(async (tx) => {
    const open = await tx.query<StreakRow>(
      "select id, token_id, started_at, peak_balance, last_verified_at from public.holding_streaks where character_id = $1 and ended_at is null for update",
      [characterId],
    );
    const openBy = new Map(open.map((o) => [o.token_id, o]));
    const inputs: HoldingInput[] = [];
    const summary: Array<{ symbol: string; supplyFraction: number; streakDays: number }> = [];

    for (const t of tokens) {
      const raw = balances.get(t.address) ?? 0n;
      const supply = t.total_supply ? BigInt(t.total_supply) : 0n;
      const fraction = supply > 0n ? Number((raw * SUPPLY_SCALE) / supply) / Number(SUPPLY_SCALE) : 0;
      const dust = fraction <= s.holdings.dustSupplyFraction;
      const effective = dust ? 0n : raw;

      // Persist the verified snapshot.
      if (effective > 0n) {
        const wholeTokens = Number(effective) / 10 ** t.decimals;
        const valueQuote = isNativeQuote(t.quote_currency) && t.price_quote !== null ? wholeTokens * Number(t.price_quote) : null;
        await tx.query(
          `insert into public.token_holdings (character_id, token_id, balance, supply_fraction, value_quote, observed_at)
           values ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6::timestamptz)
           on conflict (character_id, token_id) do update set balance = excluded.balance, supply_fraction = excluded.supply_fraction,
             value_quote = excluded.value_quote, observed_at = excluded.observed_at`,
          [characterId, t.id, effective.toString(), fraction.toFixed(18), valueQuote === null ? null : valueQuote.toFixed(18), now.toISOString()],
        );
        inputs.push({ tokenId: t.id, supplyFraction: fraction, valueQuote });
      } else {
        await tx.query(
          `insert into public.token_holdings (character_id, token_id, balance, supply_fraction, observed_at) values ($1, $2, 0, 0, $3::timestamptz)
           on conflict (character_id, token_id) do update set balance = 0, supply_fraction = 0, value_quote = null, observed_at = excluded.observed_at`,
          [characterId, t.id, now.toISOString()],
        );
      }

      // Diamond Hands streak transition.
      const prev = openBy.get(t.id);
      const state: StreakState | null = prev
        ? { startedAtMs: new Date(prev.started_at).getTime(), peakBalance: BigInt(prev.peak_balance), lastVerifiedAtMs: new Date(prev.last_verified_at).getTime() }
        : null;
      const step = evolveStreak(state, effective, now.getTime(), s.loyalty);
      let activeStreakId = prev?.id ?? null;
      const insertStreak = async (st: StreakState) => {
        const rows = await tx.query<{ id: string }>(
          `insert into public.holding_streaks (character_id, token_id, started_at, peak_balance, last_verified_at)
           values ($1, $2, $3::timestamptz, $4::numeric, $5::timestamptz) returning id`,
          [characterId, t.id, new Date(st.startedAtMs).toISOString(), st.peakBalance.toString(), new Date(st.lastVerifiedAtMs).toISOString()],
        );
        return (rows[0] as { id: string }).id;
      };
      if (step.action === "START") {
        activeStreakId = await insertStreak(step.next);
      } else if (step.action === "CONTINUE" && prev) {
        await tx.query("update public.holding_streaks set peak_balance = $2::numeric, last_verified_at = $3::timestamptz where id = $1", [prev.id, step.next.peakBalance.toString(), now.toISOString()]);
      } else if (step.action === "RESTART" && prev) {
        await tx.query("update public.holding_streaks set ended_at = $2::timestamptz, end_reason = $3 where id = $1", [prev.id, now.toISOString(), step.endReason === "VERIFY_GAP" ? "SOLD_DOWN" : step.endReason]);
        activeStreakId = step.next ? await insertStreak(step.next) : null;
      }
      const cur = step.action === "RESTART" || step.action === "START" || step.action === "CONTINUE" ? step.next : null;
      let days = 0;
      if (cur && activeStreakId) {
        days = streakDays(cur, now.getTime());
        for (const m of reachedMilestones(days, s.loyalty)) {
          await tx.query(
            "insert into public.holding_milestones (streak_id, days, character_id, token_id, achieved_at) values ($1, $2, $3, $4, $5::timestamptz) on conflict do nothing",
            [activeStreakId, m, characterId, t.id, now.toISOString()],
          );
        }
      }
      if (effective > 0n) summary.push({ symbol: t.symbol, supplyFraction: fraction, streakDays: days });
    }

    // Streaks on tokens that are no longer eligible can't be vouched for any more.
    const eligibleIds = new Set(tokens.map((t) => t.id));
    for (const o of open) {
      if (!eligibleIds.has(o.token_id)) {
        await tx.query("update public.holding_streaks set ended_at = $2::timestamptz, end_reason = 'TOKEN_DELISTED' where id = $1", [o.id, now.toISOString()]);
      }
    }

    // Recompute wallet-derived components.
    const hold = computeHoldingScore(inputs, s.holdings);
    const holdingsBonus = holdingStatBonus(hold.score, classDef, s.holdings);
    const [best] = await tx.query<{ days: number | null }>(
      "select max(floor(extract(epoch from ($2::timestamptz - started_at)) / 86400))::int as days from public.holding_streaks where character_id = $1 and ended_at is null",
      [characterId, now.toISOString()],
    );
    const loyalty = loyaltyStatBonus(best?.days ?? 0, classDef, s.loyalty);
    const [agg] = await tx.query<{ days: number; volume: string | null; tokens: number }>(
      `select (select count(*)::int from public.trade_activity_days d where d.trader_address = $1) as days,
              (select coalesce(sum(volume_quote), 0)::text from public.trade_stats ts where ts.trader_address = $1) as volume,
              (select count(distinct token_id)::int from public.trade_stats ts2 where ts2.trader_address = $1) as tokens`,
      [wallet.address],
    );
    const tradingScore = computeTradingScore({ tradeDays: agg?.days ?? 0, volumeQuote: Number(agg?.volume ?? 0) / 1e18, tokens: agg?.tokens ?? 0 }, s.trading);
    const trading = tradingStatBonus(tradingScore, s.trading);

    await tx.query(
      `update public.character_stats set holdings_bonus = $2::jsonb, loyalty_bonus = $3::jsonb, trading_bonus = $4::jsonb, holding_power = $5 where character_id = $1`,
      [characterId, json(holdingsBonus), json(loyalty.bonus), json(trading), hold.score],
    );
    await refreshPower(tx, characterId, s, deps.classes);
    await evaluateAchievements(tx, characterId, now.getTime()); // the same clock the streaks were just measured with
    return { status: "OK", eligibleTokens: hold.eligibleTokens, holdingScore: hold.score, loyaltyDays: best?.days ?? 0, tradingScore, holdings: summary } as HoldingsSyncResult;
  });
}
