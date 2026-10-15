# Clank Gold, equipment, holdings and the Robinhood Chain data

## Clank Gold (off-chain)

Not a blockchain token and not redeemable for anything. Every change is an **append-only `currency_ledger` row** with a unique `idempotency_key`; balances are maintained by database triggers (BEFORE: lock the account, reject overdrafts; AFTER: apply the delta), so there is exactly one mutation path and replaying a request is a no-op. `audit_currency_ledger()` returns any account whose balance ≠ Σ ledger (must be empty; tested). Updates/deletes on the ledger are rejected by trigger.

Beta earn rates are conservative and configurable (`progression`): participation 2 + placement bonus (#1 +25, #2 +15, #3 +8, #4 +4) + 2 per elimination (≈ 10 Gold per fight on average), plus a little for correct Picks (`picks.rewardGold`). **Every achievement pays a one-off Gold reward** (10 … 500, scaled to its difficulty; `domain/content/achievements.ts`), whether it unlocks by a metric or an admin grants it — idempotent per unlock row (`achv:<hero>:<achievement>:<unlock id>`), so a replay or the one-off backfill in migration `…002900` can never pay twice. Unclaimed heroes accumulate Gold but only claimed owners manage anything.

### What Gold is for — the Gear Shop (`services/shop.ts`, `shop` settings)

Gold now has sinks. A **claimed** hero's owner can, from the Inventory screen (which also answers "What is Clank Gold for?" in words):

* **Buy** gear for the hero's class (weapons, armor and the class-free trinkets) at the `shop.buy` prices — default **Common 200 · Uncommon 500 · Rare 1,500 · Epic 5,000**; **Legendary is never sold** (`null`: it is earned in the Arena). Only enabled templates with the `ARENA_DROP` source tag are sold (coin-themed / boss items arrive with their own sources).
* **Sell** spare, unequipped gear at the `shop.sell` prices — default **40 · 100 · 300 · 1,000 · Legendary 2,500**. Every sell price must be **below** its rarity's buy price (the settings schema refuses anything else), so buying and selling back is always a loss: the shop can only remove Gold from the economy. A sold item is **archived** (`archived_at`), not deleted — an Arena result may still reference it as the drop it produced.

Both are single ledger transactions: lock the hero, debit/credit with an idempotency key (a purchase is keyed by the browser's request id, a sale by the item id), insert/archive the item. The overdraft trigger refuses an empty purse, so parallel purchases cannot spend the same Gold twice (verified with real parallel connections). Bought gear is identical to dropped gear (same small flat bonus, class restrictions, one item per slot) and — like all gear — never changes POWER. `shop.enabled = false` closes both buying and selling; nothing else in the game changes. The season launch archives development loot and Gold like any other, so pre-season shopping resets with the rest.

### Achievement titles

Every achievement also unlocks a **title**. A member chooses **one** unlocked title to show above their hero's name (hero page → Achievements → *Show this title*; `POST /api/me/title { achievementId | null }`). The text always comes from the achievement's own reward, only an unlocked, non-archived achievement can be chosen, and only the claimed owner can change their own hero. It is stored where the title always lived — `characters.title` — so every existing read path works and the Season 1 reset still clears a title that an archived achievement granted. The title shows on the Arena's name plates (always on the full plate, and on the compact plate on stages ≥ 560 px wide), in the Current Round list, the fighter strip, the results and the hero page; an Arena battle freezes it with the roster when it is scheduled, so a new title appears from the member's next fight. An unlock no longer sets a title automatically — the member chooses.

## No permanent XP or levels — seasons instead

Heroes are created automatically from members of the official Clank.trade Telegram community once they reach 50+ qualifying messages. If older heroes passively gained permanent XP/levels from endless Arena battles, every member who qualifies later would be permanently behind. So **Clank RPG has no permanent XP and no character levels.** Arena battles pay **Clank Gold** and **season points**, and extend the **Arena record** — nothing else.

A hero's strength comes only from: its class baseline, the bounded creation roll, Telegram-derived stats, bonded-coin holdings, holding-duration milestones, small trading bonuses, equipment and tactics. None of these grows by fighting, and a golden-hash test (`tests/unit/no-level.test.ts`) pins that combat output for existing heroes is byte-identical to before the removal.

**Seasonal rank** is the competitive ladder: Bronze → Silver → Gold → Diamond → Clanker, derived purely from the points a hero earned *this season* (placement points 10/7/5/4/3/2/1/0 in `season_character_stats`). Tiers are data (`progression.seasonRanks`: id, name, `minPoints`; the first tier must start at 0, thresholds strictly increase) and can be retuned by an admin without a deploy. Points reset by starting a new season, so veterans and newcomers are back on the same rung. Rank is status only: it never feeds stats, POWER, matchmaking or combat (tested). Tune the default thresholds (200 / 600 / 1,500 / 3,000) to the real season length and hero count before launch.

**Retired, still in the schema (not dropped, not written, not read):** `characters.xp`, `characters.level`, `characters.characters_level_idx`, `arena_participants.xp_awarded`, `item_templates.min_level`, and the legacy `growth` table that old `character_classes` rows / ruleset snapshots may still carry (accepted by validation, never read). Old `game_settings` rows that still hold `progression.xp` / `character.levelCap` are accepted and stripped on load. Old `level_*` achievement rows are skipped when evaluating and hidden from profiles. No migration is required; a future cleanup migration may drop the columns once the live data has been confirmed to hold only the defaults (`xp = 0`, `level = 1`, `xp_awarded = 0`).

## Equipment

Three slots (Weapon / Armor / Trinket), five rarities with small flat modifiers (total budget 1 / 2 / 3.5 / 5 / 7 points per item), optional class restrictions, and **no level requirement** (claimed heroes can equip anything their class allows; rarity only sets the size of the small bonus). One equipped item per slot is enforced by a partial unique index. Only **claimed** owners can equip; items still drop to unclaimed heroes. Drops are rolled from the battle seed (auditable, deterministic) and idempotent per battle. Coin-themed loot slots into the same tables (`item_templates.source_tag`, boss `loot` hints).

## Bonded Clank.trade coins and holdings

Only coins with status **ELIGIBLE** matter. `scanCatalog` records bonded coins as `CANDIDATE`; an admin approves each (or set `CLANK_AUTO_APPROVE_BONDED=true`). Non-bonded coins are not stored at all.

**Holding Power** (hybrid, strongly diminishing, hard-capped): `score = 0.40·sat(Σ value, 2 ETH) + 0.35·(1 − Π(1 − sat(share_i, 2 % of supply))) + 0.25·sat(#coins, 3)` where `sat(x,k) = 1 − e^(−x/k)` < 1. The score converts to at most **10 stat points** (30 % HP, 30 % DEF, 10 % LUCK, 30 % class-primary). Whales are rewarded but not dominant: tests show 100× the holdings buys well under 10× the score, and even a maximal whale's wallet share of POWER stays under ~20 % at every level. Wallet value counts only for **native-ETH-quoted** coins (other quote currencies still count toward supply share and coin count) — there is no USD price source.

**Diamond Hands.** Per (hero, coin) streak, evaluated at each *verified* snapshot. It starts at the first balance **we observed** (we never backdate history); it resets if the balance falls below **80 % of its peak**; if we could not verify for **> 48 h** it restarts (a sell-and-rebuy cannot be ruled out); changing wallets or delisting a coin ends it. Milestones at **1 / 7 / 30 / 90 days** grant defensive-only bonuses (HP/DEF; 0.5 / 1 / 2 / 3 points, total cap 4) and the `diamond_*` achievements. If the chain is unreachable, the sync returns *unavailable* and leaves all previous verified state untouched.

**Trading activity** is deliberately tiny (≤ 1.5 points). It scores distinct trading **days**, a saturating volume term and coin breadth — never raw trade counts — and ignores dust and non-ETH-quoted coins, so 1,000 same-day wash trades ≈ one trading day. Trade rollups are keyed by trader wallet from the public trades feed; verified-wallet owners get the bonus.

**Boss drafts.** Eligible coins get an inert `DRAFT` (title, template stats/abilities/lore/loot hints — deterministic text, no AI, no invented facts). A database trigger refuses `APPROVED`/`LIVE` without a human approver (`SYSTEM` is rejected), and nothing in the arena reads boss data. Bosses are a locked preview in the Beta.

## What was verified against the live network (2026-10-04, `pnpm chain:probe`)

| Check | Result |
| --- | --- |
| Robinhood Chain RPC `eth_chainId` | ✅ `4663` (`https://rpc.mainnet.chain.robinhood.com`, public & rate-limited) |
| Clank.trade `GET /v1/coins` pagination | ✅ 392 coins across 33 pages |
| "Bonded" signal | 🟡 **Observed, not documented:** exactly 6 coins reported `state: 3` with `progress: 100`; the other 386 were `state: 0`. This inference is configurable (`OBSERVED_BONDED_STATES`) and every coin still needs admin approval unless auto-approve is on. **Confirm the meaning of `state` with the Clank.trade team.** |
| `coins.detail` | ✅ `totalSupply` (raw), `price` (in the **quote currency**: ETH for most coins, but some coins are quoted in another token such as SPCX), `marketCap` |
| `coins.trades` | ✅ rows include a `trader` address, raw base/quote amounts, timestamp |
| ERC-20 reads via viem | ✅ `totalSupply` from the chain **matches** the API's `totalSupply` exactly for a bonded coin; `decimals` = 18; `balanceOf` works |

Everything in `src/server/chain/clankTrade.ts` is Zod-validated, size/time-bounded, and fails closed to "unavailable" — never to zero. Clank.trade's JSON is the website's own *unofficial* interface and may change without notice; keep the adapter behind its interface and watch `providerErrors` in the cron output.
