import { isBondedObserved } from "../chain/clankTrade";
import { ZERO_ADDRESS, ProviderUnavailableError, type BalanceReader, type CatalogProvider } from "../chain/types";
import { json, type Db, type Queryable } from "../db/types";

export interface ScanSummary {
  pagesRead: number;
  coinsSeen: number;
  bondedFound: number;
  inserted: number;
  updated: number;
  autoApproved: number;
  draftsPrepared: number;
  complete: boolean;
}

export interface ScanOptions {
  chainId: number;
  maxPages: number;
  /** Promote newly observed bonded coins straight to ELIGIBLE (otherwise they await admin approval). */
  autoApprove: boolean;
  reader?: BalanceReader | null;
}

/**
 * Pulls the Clank.trade catalog and records ONLY bonded/graduated coins as holding candidates.
 * Re-scans refresh catalog facts (supply, price, progress) but never touch an admin's decision
 * (status / approval). Not-yet-bonded coins are ignored entirely.
 */
export async function scanCatalog(db: Db, catalog: CatalogProvider, opts: ScanOptions): Promise<ScanSummary> {
  const summary: ScanSummary = { pagesRead: 0, coinsSeen: 0, bondedFound: 0, inserted: 0, updated: 0, autoApproved: 0, draftsPrepared: 0, complete: false };
  let cursor: string | undefined;
  const bonded = [];
  for (let page = 0; page < opts.maxPages; page++) {
    const result = await catalog.listCoins(cursor);
    summary.pagesRead++;
    summary.coinsSeen += result.coins.length;
    bonded.push(...result.coins.filter((c) => isBondedObserved(c)));
    if (!result.nextCursor) {
      summary.complete = true;
      break;
    }
    cursor = result.nextCursor;
  }
  summary.bondedFound = bonded.length;

  for (const coin of bonded) {
    let detail = null;
    try {
      detail = await catalog.getCoinDetail(coin.address);
    } catch (e) {
      if (!(e instanceof ProviderUnavailableError)) throw e;
    }
    let decimals: number | null = null;
    if (opts.reader) {
      try {
        decimals = await opts.reader.getDecimals(coin.address);
      } catch {
        decimals = null; // keep the stored/default value; do not guess a different one
      }
    }
    await db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string; status: string }>("select id, status from public.eligible_tokens where chain_id = $1 and address = $2", [coin.chainId, coin.address]);
      const common = [
        coin.symbol.slice(0, 40), coin.name.slice(0, 200), coin.imageUrl, coin.quoteCurrency, coin.quoteSymbol,
        coin.state, coin.progress, detail?.totalSupply ?? null, detail?.priceQuote ?? null,
      ];
      if (existing[0]) {
        await tx.query(
          `update public.eligible_tokens set symbol = $3, name = $4, image_url = $5, quote_currency = $6, quote_symbol = $7,
                  catalog_state = $8, catalog_progress = $9, bonded_observed = true,
                  bonded_observed_at = coalesce(bonded_observed_at, now()),
                  total_supply = coalesce($10::numeric, total_supply),
                  price_quote = coalesce($11::numeric, price_quote), price_observed_at = case when $11::numeric is null then price_observed_at else now() end,
                  decimals = coalesce($12::int, decimals)
            where chain_id = $1 and address = $2`,
          [coin.chainId, coin.address, ...common, decimals],
        );
        summary.updated++;
      } else {
        const status = opts.autoApprove ? "ELIGIBLE" : "CANDIDATE";
        const rows = await tx.query<{ id: string }>(
          `insert into public.eligible_tokens (chain_id, address, symbol, name, image_url, quote_currency, quote_symbol, catalog_state, catalog_progress,
                    bonded_observed, bonded_observed_at, total_supply, price_quote, price_observed_at, decimals, status, approved_by, approved_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, now(), $10::numeric, $11::numeric, case when $11::numeric is null then null else now() end,
                   coalesce($12::int, 18), $13, $14, case when $13 = 'ELIGIBLE' then now() else null end)
           returning id`,
          [coin.chainId, coin.address, ...common, decimals, status, opts.autoApprove ? "AUTO:bonded-observed" : null],
        );
        summary.inserted++;
        if (opts.autoApprove) summary.autoApproved++;
        existing.push({ id: (rows[0] as { id: string }).id, status });
      }
      const row = existing[0] as { id: string; status: string };
      if (row.status === "ELIGIBLE") {
        if (await prepareBossDraft(tx, row.id)) summary.draftsPrepared++;
      }
    });
  }
  return summary;
}

/**
 * Prepares a boss DRAFT for an eligible coin. Drafts are inert: the database refuses to move a
 * draft to APPROVED/LIVE without an explicit admin approver (see boss_drafts triggers), and
 * nothing in the arena reads boss data. Deterministic templates only — no AI, no invented facts.
 */
export async function prepareBossDraft(q: Queryable, tokenId: string): Promise<boolean> {
  const [t] = await q.query<{ symbol: string; name: string; image_url: string | null; catalog_progress: string | null }>(
    "select symbol, name, image_url, catalog_progress from public.eligible_tokens where id = $1 and status = 'ELIGIBLE'",
    [tokenId],
  );
  if (!t) return false;
  const label = t.symbol.toUpperCase();
  const rows = await q.query(
    `insert into public.boss_drafts (token_id, identity, stats, abilities, lore, loot)
     values ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6::jsonb) on conflict do nothing returning id`,
    [
      tokenId,
      json({ title: `${t.name.slice(0, 40)} Colossus`, symbol: label, imageUrl: t.image_url }),
      json({ hp: 900, str: 42, def: 30, int: 24, agi: 18, cha: 20, luck: 15, note: "template stats — admin must tune" }),
      json([{ id: "boss_overclock", name: "Overclock", description: "Template ability — admin must define." }]),
      `A bonded relic of ${t.name} stirs in the Foundry. (Auto-generated placeholder lore — pending admin review.)`,
      json([{ type: "ITEM", templateHint: `${label.toLowerCase()}_relic` }, { type: "BADGE", id: `slayer_${label.toLowerCase()}` }]),
    ],
  );
  return rows.length > 0;
}

export async function setTokenStatus(q: Queryable, tokenId: string, status: "CANDIDATE" | "ELIGIBLE" | "REJECTED" | "DELISTED", actor: string): Promise<void> {
  const rows = await q.query(
    `update public.eligible_tokens set status = $2, approved_by = case when $2 = 'ELIGIBLE' then $3 else approved_by end,
            approved_at = case when $2 = 'ELIGIBLE' then now() else approved_at end where id = $1 returning id`,
    [tokenId, status, actor],
  );
  if (rows.length === 0) throw new Error("token not found");
  if (status === "ELIGIBLE") await prepareBossDraft(q, tokenId);
}

export const isNativeQuote = (quote: string | null): boolean => (quote ?? ZERO_ADDRESS).toLowerCase() === ZERO_ADDRESS;
