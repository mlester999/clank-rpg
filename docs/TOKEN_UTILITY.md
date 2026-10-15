# What $CLANKRPG is for — live uses, what was added, and proposals

> Written 2026-10-15. **Live / built** items are in the code; **proposals** are ideas for the owner to choose between — none of them is implemented. The architecture rules every item respects:
> the app **holds no key** (it only reads the chain), **Clank Gold stays off-chain**, and **nothing buys combat power directly** (stats, POWER, matchmaking, win odds).

## 1. What $CLANKRPG does today

| Use | How it works | Status |
| --- | --- | --- |
| **Leaderboard prizes** | Arena Picks Daily **500,000** and Weekly **1,000,000** (Top 10, fixed pools); Hero Arena pools are set by the team. Paid by hand, verified on-chain. | live in the code ([`ARENA_PICKS.md`](ARENA_PICKS.md), [`HERO_ARENA.md`](HERO_ARENA.md)) |
| **Holder prize bonus** | Verified holding adds +5 % … +25 % **on a prize you already earned** (never to score, rank or power; continuity from before the period). | live ([`ARENA_PICKS.md`](ARENA_PICKS.md)) |
| **Paid hero reroll** | After today's free reroll, pay **100,000 $CLANKRPG** (settings: price, daily cap) from your own wallet for another roll. Fees go to the **reward treasury** — the reserve that funds the prize pools. | **built in this change, shipped OFF** ([`HERO_PAID_REROLL.md`](HERO_PAID_REROLL.md)) |

The loop this creates: **players earn $CLANKRPG from the pools → some spend it on rerolls → the fees refill the treasury → the treasury funds the pools.** At the default price, a single paid reroll (100,000) is one fifth of a
daily pool; five paid rerolls a day cover it. That makes the token a *circulating* currency instead of a one-way emission, and it is the main reason to price rerolls in the token rather than in Gold.

*(Separate, and not $CLANKRPG: the hero bonuses for **bonded Clank.trade coins** — [`ECONOMY_AND_CHAIN.md`](ECONOMY_AND_CHAIN.md).)*

## 2. Design rules for any new use

1. **No direct power for sale.** Gear is earned (drops, Gold shop) and small; the paid reroll sells a *random draw*, and its dial (price + daily cap) is a setting. Anything that sold stats or win odds would turn the Arena into
   pay-to-win and put the prize pools at the mercy of the biggest wallet.
2. **Spend flows back to players.** Fees go to the reward treasury (or are burned), not to a team wallet the pools never see — it is what makes "spend" and "earn" one economy.
3. **Everything is verified on-chain, read-only.** The reusable piece now exists: `checkPayment` (`src/domain/hero/paidReroll.ts`) + the record-first-then-apply pattern in `heroPaidReroll.ts` (a verified payment becomes a durable credit,
   `UNIQUE (tx_hash)`, applied exactly once). A new paid feature is a new "what the payment buys" on top of it.
4. **Holding earns status and bonuses on prizes, never power.** Verified holder wallets already exist; cosmetics and badges can ride on them with no combat effect.
5. **Gold never touches the chain.** A Gold ↔ token bridge would make Gold a currency and invite botting; the Gear Shop is Gold's job.

## 3. Proposals (not built) — in the order I would do them

| # | Idea | What it is | Why / risk | Effort on the existing foundations |
| --- | --- | --- | --- | --- |
| 1 | **Hero cosmetics for $CLANKRPG** | Card frames and backgrounds, name-plate colours, victory poses/auras — pay a fixed price, own it forever. | Pure status; no power; the most proven token sink in games like this. Needs art. | Small: a `cosmetics` table + the paid-credit pattern; the renderer already has overrides/auras. |
| 2 | **Prize-pool top-ups ("sponsor a pool")** | Anyone — a member, a project, the team — can add $CLANKRPG to a *specific* Daily/Weekly pool with a verified transfer; the pool for that period grows and the board shows "+ 250,000 from <name>". | Community-funded, transparent, great for events. Needs a `pool_topups` record and a rule that a top-up applies only to a period that has not closed. | Small–medium: `checkPayment` + one table + the board's pool figure. |
| 3 | **Holder status (not power)** | A "Holder" title tier, a star on the name plate and a chat badge for *verified* holders, by tier (the existing holder tiers). | Rewards holding without touching fairness. Risk: it must never *look* like a power perk. | Small: titles already exist (achievement titles); add a metric from the holder status. |
| 4 | **Paid rename** | A member renames their hero (e.g. 25,000 $CLANKRPG) instead of an admin only. | Simple sink; needs the existing name moderation to run on every change. | Small: `setRpgNameInTx` already validates and audits. |
| 5 | **Event / tournament entry fees** | For Community Wars / Bosses / PvP when they ship: an entry fee in $CLANKRPG, paid out to the winners (minus a burn). | Strong token loop, but only meaningful once those modes exist. Must be opt-in and never required for the core Arena. | Medium (the modes themselves are the work). |
| 6 | **Burn share of fees** | Burn a stated percentage of reroll/cosmetic fees (the admin sends them to a burn address by hand — the app holds no key; publish the transaction). | A clear deflation story. Operationally manual; adds one more thing to keep honest. | Process, not code (a monthly burn report in Admin would help). |
| 7 | **Season pass (cosmetic)** | One payment per Season for a banner, a title and a cosmetic set. | Predictable treasury inflow. Risk of feeling like a paywall — keep it cosmetic and small. | Small once cosmetics (#1) exist. |

**Not recommended:** selling stats, rarity guarantees or Legendary odds; a Gold ↔ token swap; a token-gated *Arena entry* (Telegram membership is the account — the game must stay free to play); anything that makes a prize depend on holding.

## 4. How to read the numbers before choosing

* The paid reroll's cost of rarity: ~11.5 rerolls to Epic-or-better (≈ 1.15 M $CLANKRPG), ~99 to Legendary (≈ 9.9 M) at the default price — see [`HERO_PAID_REROLL.md`](HERO_PAID_REROLL.md) § 6. If that feels too cheap or too dear, the **price** and the
  **daily cap** are the dials; if it feels like it distorts the ladder, the "builds lock when a Season starts" rule is the answer.
* The new pools raise the Season 1 plan to 54,000,000 (67,500,000 with bonuses) against the 20,000,000 planning allocation ([`ARENA_PICKS.md`](ARENA_PICKS.md) § *What the rules can cost at most*) — fee inflow
  (#1–#2 and the paid reroll) is what makes a number like that sustainable, so the treasury's expected inflow belongs in that plan.
