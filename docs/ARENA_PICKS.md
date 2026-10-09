# Arena Picks — free unlimited predictions, leaderboard Points, Daily & Weekly $CLANKRPG prizes, and a verified-holder prize bonus

*2026-10-05. Nothing was committed, pushed or deployed, and no migration was applied to any live database by this work.*

**There is no wagering, and no token is paid per battle.** Every Arena Pick is free and unlimited; a wrong pick earns 0 and costs nothing. Correct picks earn **Points**; **$CLANKRPG is paid only by the DAILY and WEEKLY leaderboards**, to their Top 10, from fixed prize pools. Holding $CLANKRPG never changes a score, a rank or a tie-break — it only adds a **percentage bonus on a leaderboard prize you already earned**, and only if your holdings were **verified continuously from before the period began**. Telegram is the player identity; a wallet is optional.

**Tokens are paid by hand.** This application holds **no signing key** and never sends a transaction. A claim is a *request* (it reserves the member's claimable balance); an admin pays it manually and names the transaction, and the server verifies that transfer **read-only** on-chain before the claim becomes SENT.

## Contents

[The final economy](#the-final-economy) · [How a round works](#how-a-round-works) · [Eligibility](#eligibility-strong-telegram-eligibility-v1) · [Anti-bot](#anti-bot--anti-sybil) · [Scoring](#scoring-every-valid-pick-counts) · [Leaderboards](#the-daily-and-weekly-leaderboards) · [Holder prize bonus](#the-holder-prize-bonus) · [Verified holding continuity](#verified-holding-continuity-and-what-it-is-not) · [Holder verification](#holder-verification-wallet-balance-refresh) · [Official contract](#the-one-official-clankrpg-contract) · [Ledger](#the-reward-ledger-base-and-bonus-kept-apart) · [Manual claims](#manual-claims) · [Economy numbers](#what-the-rules-can-cost-at-most) · [Admin](#admin--arena-picks) · [Player surfaces](#player-surfaces) · [Betting removal](#removal-of-the-betting-direction) · [Migration](#migration) · [Before going live](#needed-before-paying-real-claims) · [Tests](#tests) · [Verification](#verification-record)

## The final economy

| | **Default** | **Setting** (`game_settings.arena_picks`) |
| --- | --- | --- |
| Arena Picks | **unlimited**, free, one pick per battle, no wager, no loss, no wallet needed | — |
| Scoring | **every valid pick counts** toward the Daily and the Weekly board — there is **no per-day scoring limit** | — (the old `scoredPicksPerDay` key is retired and never read) |
| Points | correct pick **+10**, wrong pick 0 | `pointsPerCorrectPick` = 10 |
| **Daily** board | 00:00 UTC → 00:00 UTC, **100,000 $CLANKRPG**, Top 10 | `dailyPrizePool` = "100000" |
| **Weekly** board | Monday 00:00 UTC → next Monday, **500,000 $CLANKRPG**, Top 10 | `weeklyPrizePool` = "500000" |
| Payout ladder (both boards) | 30 / 20 / 15 / 10 / 8 / 6 / 4 / 3 / 2 / 2 % | `prizeSplitBps` = [3000,2000,1500,1000,800,600,400,300,200,200] |
| Minimum to be **prize**-eligible | Daily **20 valid picks** in the UTC day · Weekly **100** in the week — a participation bar for *prizes only*, never a scoring cap (below it you still score and still rank, marked NOT YET PRIZE ELIGIBLE) | `dailyMinimumPicks` = 20, `weeklyMinimumPicks` = 100 |
| Holder bonus tiers | FREE 0% · 100K +5% · 500K +10% · 1M +15% · 5M +20% · 10M +25% | `holderBonusTiers` |
| Bonus qualification | Daily **24 h** before the day starts + throughout · Weekly **7 days** before the week starts + throughout | `holderDailyQualifyHours` = 24, `holderWeeklyQualifyHours` = 168 |
| Verification | ~30 min per wallet (±20 %), bounded batches of 25; freshness window **6 h** | `holderRefreshMinutes`, `holderRefreshJitterPct`, `holderCheckBatchSize`, `holderMaxAgeHours` |

Everything above is **one setting** read by the server and the UI (prize ladder, pools, tiers, limits) — nothing is duplicated as a constant. Token amounts are decimal strings of whole tokens held as integer **logical micro-tokens** (BigInt; 1 unit = 1/1,000,000 $CLANKRPG, so 30,000 $CLANKRPG = 30,000,000,000) — see *Logical accounting* below; no JavaScript number ever holds a token quantity.

**Removed** in this phase: the per-battle 10,000 pool (`rewardPerBattle`), the per-day "rewarded wins" allowance by holder tier (FREE 1 · 100K 2 · 500K 5 · 1M 10 · 5M 15 · 10M 30), the 24 h tier-upgrade state machine, the lock-time tier snapshot, `dailyEmissionCap`, and the `ARENA_PICK_REWARD` ledger kind. The database now **refuses** a per-battle credit (the ledger has no such kind).

## How a round works

1. The next battle's eight fighters are known → **PICKS OPEN** for it (the arena lifecycle — picks target the *upcoming* battle and close when the battle in front is decided). An eligible, signed-in member chooses one fighter. **Unlimited battles per day; exactly one pick per battle** (`PRIMARY KEY (battle_id, telegram_user_id)`).
2. The window closes (server clock; the database repeats the check). The eligibility snapshot on the pick is **frozen**.
3. The battle settles. **Arena #1 is the correct pick** (the authoritative `arena_battles.winner_id`; a tampered pick `result` cannot change it — tested).
4. Seconds later, in a **separate transaction** that never blocks the arena, the picks are **scored** (below). **No token moves.**
5. When a UTC day / week ends, the board is **finalized**: ranks and prizes freeze, base prizes (and any holder bonus) become **claimable**. A member then requests a claim; an admin pays it by hand.

## Eligibility (strong Telegram eligibility, V1)

A member can make valid picks only if all hold, evaluated on the server from their own record:

* authenticated through Telegram (the signed session carries the immutable numeric Telegram id);
* ≥ `telegram.qualifyingThreshold` **qualifying** messages in the official Clank.trade community — never a raw message count; no scoring formula is exposed;
* an **ACTIVE** generated Clank RPG hero (1 Telegram id → 1 hero, `UNIQUE`);
* not banned, hero not suspended, account not `SUSPENDED` for rewards; demo heroes only where demo heroes are allowed at all (never in production).

Public wording: *"Members with {N}+ qualifying messages in the official Clank.trade community can participate in rewarded Arena Picks."* A player is only ever told a coarse reason (`NO_HERO`, `BELOW_THRESHOLD`, or generic `NOT_ELIGIBLE`).

**Review states** (`arena_reward_accounts.review_state`): `NORMAL`; `REVIEW` (a Telegram `FLAGGED` member counts as REVIEW) — they keep their place and their rewards are **recorded**, but a **prize position they hold is HELD** and **claims are held**; `SUSPENDED` — cannot make rewarded picks. Nothing is silently destroyed; nobody shifts up. The eligibility result is snapshotted on the pick on every submit and **frozen when picks lock**; a "valid" pick is one whose frozen snapshot is eligible. Historical picks from before this system are never valid.

## Anti-bot / anti-Sybil

| Rule | Enforced by |
| --- | --- |
| 1 Telegram id → 1 hero | `characters.telegram_user_id UNIQUE` |
| ≤ 1 pick per battle per identity | `arena_picks` primary key; duplicates are idempotent; races lose at the database |
| No browser-supplied score, rank, points, balance, tier, bonus or amount | identity is only the signed-session Telegram id; bodies are strict (unknown fields → 422); every number is computed on the server |
| Late picks | server clock (service) + DB trigger |
| **No scoring cap — and nothing that behaves like one** | every valid pick is one counted row in `arena_pick_scores`. The 1300-era `scored`, `scored_index` and `daily_limit` columns and the per-day counting trigger are removed by migration 1400, so no database rule can stop Points after pick #20. The only guard on a score row refuses one for a day/week whose board is **already finalized** (`guard_arena_pick_score`) |
| Scoring replay / duplicate score or Points | `UNIQUE(battle_id)` settlement, `UNIQUE(member, battle)` score row and Points row, one transaction |
| Finalization replay | `PRIMARY KEY (kind, period_start)` on the board, `UNIQUE` ledger rows per (member, period, base/bonus), idempotency keys; the first insert wins, the rest see `ALREADY_FINALIZED` |
| Duplicate / overlapping claims | account row lock + reservation + "one PENDING claim per member" + idempotency key |
| One holder wallet ↔ one account | trigger + unique index; refused attempts logged; an admin-approved exception is the only way around |
| **Holder evidence cannot be forged** | `arena_holder_observations` is append-only, rows are written only by the server after an on-chain read, and the database refuses an observation of any wallet other than the member's *current verified* one |
| Farming visibility | Admin → Accounts: picks, accuracy, rewards, wallets, qualifying count. **No automatic ban** — high accuracy alone proves nothing |

## Scoring: every valid pick counts

`settleBattleRewards(battleId)` (`src/server/rewards/settlement.ts` — the name is kept for callers; it now **scores** and credits nothing) runs after the arena settled a battle:

1. battle must be `SETTLED` / `VOID` (a void battle scores nothing); the winner is `arena_battles.winner_id`;
2. every **valid** pick (frozen eligibility) is recorded **once** in `arena_pick_scores` — right or wrong;
3. a correct pick is worth `pointsPerCorrectPick` (+10), a wrong pick 0. There is **no per-day counter**: pick #1, #20, #21 and #100 of a UTC day all count. The only thing that can stop a score row is that day's or that week's board having already been **finalized** (a frozen board is never altered by a late settlement);
4. **Lifetime Clank Points** (`arena_points_ledger`, append-only, unique per pick) are awarded for every valid correct pick — unlimited, never reset, never multiplied.

So there is **no scoring cap**: a member who makes 80 picks in a UTC day and gets 45 right has **Picks 80 · Correct 45 · Points 450** on that day's board (and the same picks count toward the week). **Holdings never change a score** — a FREE member and a 10M holder with the same picks have the same Points and the same rank (`integration/rewards-no-pay-to-win`); only the prize *amount* can differ after finalization. **Minimums** decide *prizes*, not scoring: a member needs at least `dailyMinimumPicks` (20) valid picks in the UTC day to receive a Daily prize and `weeklyMinimumPicks` (100) in the week to receive a Weekly prize — 19 picks is not eligible, 20 is, whatever the holder tier. The same score rows feed **both** boards: the Daily board groups by `utc_date`, the Weekly board by `week_start`.

## The Daily and Weekly leaderboards

**Periods** (`src/domain/rewards/time.ts`, UTC only, never the viewer's timezone): DAILY `00:00:00 UTC → next 00:00:00` · WEEKLY `Monday 00:00:00 UTC → next Monday` (a battle belongs to the period of its `settled_at`). 23:59:59 is the old period; 00:00:00 is the new one.

**Ranking** (`src/domain/rewards/leaderboard.ts`): **correct picks** (desc), then **accuracy = correct ÷ valid picks** (integer cross-multiplication — no floats). Points (correct × 10) are the display score and order the board exactly as correct picks do. Same correct picks *and* same accuracy is an **exact tie**; ties are never broken by tier, balance, wallet age, account age, who scored first or id (the id only fixes display order inside a tie). Competition ranks (1, 1, 3). The board lists **every** participant; identity is the **hero**, never the Telegram id.

**Prizes.** The pool is split by the ladder across prize **positions** filled only by **prize-eligible** members (at least 20 valid picks that day / 100 that week). Anyone below the minimum stays on the board marked **NOT YET PRIZE ELIGIBLE** (never hidden) and takes no position — so "1 pick, 1 correct, 100 %" can neither win nor win a tie-break.

| Position | % | Daily (100,000) | Weekly (500,000) |
| --- | --- | --- | --- |
| #1 | 30 | 30,000 | 150,000 |
| #2 | 20 | 20,000 | 100,000 |
| #3 | 15 | 15,000 | 75,000 |
| #4 | 10 | 10,000 | 50,000 |
| #5 | 8 | 8,000 | 40,000 |
| #6 | 6 | 6,000 | 30,000 |
| #7 | 4 | 4,000 | 20,000 |
| #8 | 3 | 3,000 | 15,000 |
| #9 | 2 | 2,000 | 10,000 |
| #10 | 2 | 2,000 | 10,000 |

**Exact ties at a prize boundary** combine the affected positions and split them equally: two exactly tied for #2 share 20,000 + 15,000 = **17,500 each**, and the next player occupies **#4** (10,000). If a tie group reaches past the last rewarded position, the whole group shares the positions that exist. Integer remainders (a few base units) go back to the reserve — never to an arbitrary member (`pool = awarded + returned`, a database CHECK; property-tested over pools, ladders and tie shapes). Unfilled positions return to the reserve — **no jackpot, no rollover**.

**Countdown and rollover.** `ENDS IN 14H 23M 18S` (daily — never shows days) / `6D 23H 59M 59S` (weekly) is anchored to the *server's* clock (`serverNow` in the payload; a monotonic local timer ticks between fetches, so changing the device clock changes nothing). At zero the page refetches at once and every 1.5 s until the server reports the new period; the scored-picks counter reads `0 / 20` again. A user can neither trigger nor prevent the rollover, and there is **no reset action anywhere**.

**Finalization (automatic, idempotent, never a reset).** The 1-minute tick (`/api/internal/tick`, `pnpm arena:worker`, and a throttled sweep after each settlement) finalizes every ended day and week not yet finalized, oldest first (`finalizeDueBoards`; `finalizeDueWeeks` is a kept alias). Per period, **in this order**:

1. wait until every battle that settled in the period has been scored (`WAITING_FOR_SETTLEMENT` otherwise);
2. compute standings and the prize list; for every **prize winner with a verified holder wallet**, take a **fresh authoritative balance read** (the *close verification*) — **outside** any transaction;
3. in **one transaction**: write the frozen board (`arena_leaderboards`) and each participant's result (`arena_leaderboard_results`), decide each winner's holder bonus **from the evidence**, and credit the **base prize** and (separately) the **holder bonus**.

Finalized boards are **immutable** (append-only triggers). Only two things may later change, once each and always recorded: an admin **releases / forfeits** a prize held for review (its bonus follows it), or a bonus that was **PENDING VERIFICATION** is reconciled. A frozen board keeps the terms it was frozen under (pool, ladder, minimums, bonus tiers, windows).

**History.** `GET /api/leaderboard/picks?period=daily|weekly[&start=YYYY-MM-DD]` — `TODAY · OCT 6 · OCT 5 …` for daily, `CURRENT WEEK · SEP 28 · …` for weekly; the period that just ended shows **FINALIZING** (its live standings) until it is frozen. A finished row shows rank, hero, points, accuracy, **base prize, holder bonus with the qualifying tier label, total reward**.

**Prizes paused** (`enabled: false`): picks and scoring continue, boards still freeze and rank, but a **zero pool is frozen with them** and nobody is paid; the UI says so.

## The holder prize bonus

Holding $CLANKRPG changes **one** thing: a **bonus on a prize already earned**.

* **Extra, never carved out.** Daily #1 base 30,000: FREE → 30,000 · 1M holder → 30,000 + 15 % = **34,500** · 10M holder → 30,000 + 25 % = **37,500**. #2 and #3 still receive exactly 20,000 and 15,000.
* **Computed once, at the close, from evidence** — never from the balance at close alone, never from the browser. `bonus = floor(base × bps / 10000)` (database CHECK, using exact integer `div`).
* **Never changes** picks, correct picks, Points, accuracy, rank, tie-breaks, POWER or combat — pinned by `integration/rewards-no-pay-to-win` (by construction, by behaviour, by outcome).

**Qualification.** A wallet qualifies for a tier for a period iff its **verified holding continuity** reaches back to `period start − required hours` (24 h daily, 7 days weekly) and is **unbroken through the final close verification**. The highest qualifying tier wins, and a lower tier still qualifies when the wallet continuously held at least that much (**tier fallback**: a 10M holder who fell to 6M keeps 5M +20 %; one who fell to 1.2M keeps 1M +15 %).

| Scenario (Daily Oct 7) | Result |
| --- | --- |
| **A.** #1 buys 10M five minutes before the close | base 30,000 ✔ · bonus ✘ (the 10M run began too recently) |
| **B.** held 10M for the previous 24 h and all day | base 30,000 + **7,500** (+25 %) |
| **C.** qualified, then the balance drops before the close | base ✔ · 10M bonus removed; the highest tier held all day is paid (1M → +15 %); fully sold → none |
| **D.** (Weekly) buys 10M Sunday night while #1 | base 150,000 ✔ · **no** +25 % |
| **E.** (Weekly) 7-day pre-week requirement met and the entire week | base 150,000 + **37,500** |
| **F.** the same 10M moved between wallets/accounts | no instant reuse: the receiving wallet has no history of its own, the sender drops out at the next check |
| buys during the day (20:00) | nothing for that day; the same holding qualifies later (daily: from the board whose start is ≥ 24 h after the run began) |

## Verified holding continuity — and what it is not

Tokens are **not locked in a contract**, so we **do not claim** mathematically perfect continuous holding. What we implement:

> *all required scheduled authoritative balance checks observed the wallet at or above the threshold, with no stale / disqualifying gap.*

Concretely (`src/domain/rewards/holderBonus.ts`, pure and exhaustively tested): the evidence is the immutable list of **successful `balanceOf` reads** of the member's *current* verified wallet (`arena_holder_observations`: CONNECT / MANUAL / BACKGROUND / CLOSE). A **run** is an unbroken stretch of consecutive observations that are all ≥ the tier threshold with **no two consecutive reads further apart than `holderMaxAgeHours` (6 h)**. An unverified gap longer than that **proves nothing**, so continuity **restarts** (it is never silently assumed). The **close observation** is the first read at or after the period's end and must itself be within a freshness window of the previous read.

Honest limits, so nobody over-reads this:

* between two checks (~30 min) a wallet could in principle move tokens away and back; the jitter and the member-independent schedule make this unpredictable but not impossible;
* a **platform outage** longer than 6 h restarts every affected wallet's clock (fail-safe: when in doubt, no bonus). Admin shows **overdue** wallets and a backlog warning so operators can react; raise `holderCheckBatchSize` if wallets outnumber ~750 per 30 min;
* a bonus whose close read **fails** is **PENDING VERIFICATION** for `holderReconcileHours` (24 h) — re-checked on every tick, credited only if the evidence still proves it, otherwise `NONE`, and **EXPIRED** after the window. The **base prize is never delayed**. A winner who sells everything inside that window loses the pending bonus; that is a deliberate trade-off against granting from stale data;
* **stale data is never rewarded**: a member whose last verification is older than 6 h shows **NEEDS VERIFICATION** and earns nothing from it.

**Token hopping.** Evidence belongs to the *account bound at the time*: changing the holder wallet **resets qualification from zero** (old rows stay for audit but are filtered out), and an account that connects a wallet another account just left starts with **no history**. One wallet ↔ one account (unique index + trigger).

## Holder verification (wallet, balance, refresh)

`Connect wallet` is **optional** and lives on Profile → Arena Picks. Nothing the browser says about a wallet or a balance is believed: the server issues a single-use 10-minute nonce and the exact message, the wallet signs it (`personal_sign`, free, no gas, no access to funds), the server recovers the signer from **its stored message**, the nonce is consumed, and the address becomes the member's **verified holder wallet**. Changing it later needs a fresh Telegram sign-in (`walletChangeFreshMinutes`, 15). The holder wallet is **not** a payout address (every claim names its own).

**Four server-side paths**, all appending an observation on success:

| Path | When | Notes |
| --- | --- | --- |
| **CONNECT** | the moment a wallet is verified | the first balance read happens inside the verify request |
| **MANUAL** | **Refresh holdings** | server-side only (the body is never read), one per `holderManualRefreshSeconds` (**5 min**) per member |
| **BACKGROUND** | every tick | each wallet carries `next_check_at`; a bounded batch (`holderCheckBatchSize`, **25**) of due wallets per pass — never every wallet every minute, never per battle |
| **CLOSE** | at leaderboard close | a fresh read for each prize winner with a wallet, before the bonus is decided |

**Cadence.** After a success the next check is ~`holderRefreshMinutes` (30) away ±`holderRefreshJitterPct` (20 %). After a failure the wallet backs off 5 → 10 → 20 min…, never beyond the normal interval; failures are counted. A failed read writes **no** observation (it leaves a visible gap in the evidence).

## The one official $CLANKRPG contract

There is exactly **one** official token, configured server-side and handed to clients by the server — no client, page or component hard-codes an address.

| Variable | Meaning |
| --- | --- |
| `CLANKRPG_TOKEN_ADDRESS` | the ONE official $CLANKRPG ERC-20 on Robinhood Chain (**not invented here — set the real one**). **The only token setting.** Leave it unset until the token launches. |
| `CLANKRPG_REWARD_TREASURY_ADDRESS` | *optional, read-only*: the wallet rewards are paid from, so Admin can show its balance and coverage |
| `CLANKRPG_EXPLORER_TX_URL` | *optional, public*: explorer URL with a `{hash}` placeholder |
| `CLANKRPG_CHAIN_ADAPTER=simulated` | in-memory chain for local dev/QA only; **refused in production** |
| `ROBINHOOD_RPC_URL`, `ROBINHOOD_CHAIN_ID` | the **existing** Robinhood Chain configuration, reused |

`GET /api/rewards/token` serves the public facts: `launched`, the address, symbol, chain id and the **BUY link** (server-computed from the same address — there is no `NEXT_PUBLIC_` copy that could disagree). **Decimals and symbol are never configured:** once an address is set the server verifies the contract (chain id, bytecode at the address, `decimals()` 0–36, `symbol()`), caches what the contract itself reported (`arena_reward_token`: symbol, decimals, verified_at) and the **contract is authoritative**. A contract that cannot be verified fails **closed** — holder verification and claims/manual-payout verification stop, Admin says why — while the Arena, Picks, boards, Points, finalization and reward accounting carry on. **No signing key anywhere:** `CLANKRPG_REWARD_TREASURY_PRIVATE_KEY` is retired — if set, Admin warns *by name only* (as it does for the retired decimals variable).

### $CLANKRPG has not launched yet — and nothing waits for it

With `CLANKRPG_TOKEN_ADDRESS` unset the token **does not exist** as far as the app is concerned, and that is a normal state, not an error:

* The Arena, free unlimited Picks, the Daily and Weekly boards, Clank Points, period finalization, base-prize accounting (the ledger, claimable balances) and manual-claim *requests* all work exactly as after launch.
* **Every holder bonus is 0 %** (everyone is FREE): finalization does not even look for a holder. No balance is ever faked and no contract is invented. The profile's holder card says *HOLDER REWARD BONUS — $CLANKRPG has not launched yet. Holder bonuses will become available after the official token launches. Current Bonus 0%* and shows no tiers as if they were live.
* A claim request is answered *CLAIMS WILL OPEN AFTER $CLANKRPG LAUNCH* — never DENIED; the balance stays CLAIMABLE and keeps accumulating. Holder verification and on-chain payout verification are unavailable (fail closed) until the contract exists.
* The **BUY $CLANKRPG** button in the navbar (desktop and mobile) opens `https://clank.trade/` in a new tab. The moment the address is set, the *same* button opens `https://clank.trade/<address>` — no code change.
* **Launch procedure:** set `CLANKRPG_TOKEN_ADDRESS` (the chain is the existing `ROBINHOOD_RPC_URL` / `ROBINHOOD_CHAIN_ID`) and restart. Admin → Holders & token then shows the **Official Contract** (short address + COPY), **Metadata Verified**, the **Symbol** and the **Decimals detected** from the contract (there is no decimals input). Nothing else is configured.

### Logical accounting (why decimals are not a setting)

Rewards are a property of the *game*, so they are stored as **LOGICAL micro-tokens** — integers at a fixed scale of 6 (`LOGICAL_DECIMALS`), identical before and after the token exists. A finished board stores no token decimals, no raw ERC-20 units and no contract. The contract's `decimals()` matters in exactly three places, all read from the contract at the time: **(1)** comparing a *chain* balance with a holder tier's whole-token minimum, **(2)** converting a claim's logical amount to the exact raw on-chain amount (`amount_raw = amount_micro × 10^(decimals − 6)`; a database CHECK enforces it, and a token with fewer than 6 decimals pays the representable part while the dust stays claimable), **(3)** verifying a manual payout: logical amount → contract `decimals()` → raw → chain, official token, `Transfer` event, recipient, **exact raw amount**, success → SENT. Raw chain quantities (`balance_raw`, `amount_raw`) always stay raw.

## The reward ledger: base and bonus kept apart

`arena_reward_ledger` is **append-only**. Kinds: **`DAILY_LEADERBOARD_BASE_REWARD`, `DAILY_LEADERBOARD_HOLDER_BONUS`, `WEEKLY_LEADERBOARD_BASE_REWARD`, `WEEKLY_LEADERBOARD_HOLDER_BONUS`**, `CLAIM_RESERVED`, `CLAIM_SENT`, `CLAIM_RELEASED`, `ADMIN_ADJUSTMENT` — and **nothing else**: a per-battle credit cannot be inserted (a CHECK on `kind`, plus the sign rule of every kind; a leaderboard credit must name its `period_kind`/`period_start` and reference a real result row). One base and one bonus row per (member, period), enforced by partial unique indexes. Example, Daily #1 with a qualified 10M holder: `BASE +30,000` and `HOLDER BONUS +7,500` = **37,500 claimable**.

`arena_reward_accounts` holds the balances and is maintained **only by triggers on the ledger**; `CHECK (earned = claimable + reserved + claimed)` is conservation per account. **Claimable** — earned, not yet claimed; **Pending** — reserved by a claim awaiting its manual payout; **Sent** — paid and verified on-chain; **Total earned** — the sum.

## Manual claims

A claim is **a request**, never "button → send tokens". `member requests ─► PENDING ─► SENT (an admin paid by hand; the server verified the transfer on-chain) | DENIED (reason required; the reservation returns to CLAIMABLE)`.

**Request** (`POST /api/me/rewards/claim`, one transaction): lock the account → replay check → availability → eligibility → no other PENDING claim → amount = the **whole claimable balance from the ledger** (the body has no amount) ≥ `minimumClaim` → validate the destination → create the claim, **freeze its amount and destination**, `CLAIM_RESERVED`. **Connected wallet vs another wallet:** body `{idempotencyKey, destination: "HOLDER_WALLET"}` or `{…, destination: "CUSTOM", address}`; a custom address is for *that payout only* and never changes the holder wallet or its evidence. Destination rules: valid EVM address (EIP-55 checksum when mixed-case), not zero/burn/precompile, not the token contract or the reward wallet, not another account's verified holder wallet.

**Admin → Claims** is the payout queue. **Mark sent** takes only the transaction hash: the server reads the chain **read-only** and requires a successful receipt on the configured chain with ≥ `minConfirmations` (2), a `Transfer` event of the **official token** whose **recipient equals the claim's frozen destination** and whose **amount equals the frozen amount exactly**; a hash backs one claim ever (unique index). Anything else leaves the claim PENDING with a precise message. **Deny** needs a reason; *Duplicate/suspicious* and *Needs review* also put the account under REVIEW. The member sees only safe, calm explanations. An admin can change neither amount nor destination (database-frozen).

The profile lists **Latest rewards** with each source on its own line — `DAILY #1 +30,000 $CLANKRPG`, `10M HOLDER BONUS +7,500 $CLANKRPG`, `WEEKLY #4 +50,000 $CLANKRPG` — and the **Claim history** (PENDING / SENT / DENIED).

## What the rules can cost at most

Because no token is emitted per battle, the maximum is a product of settings (`src/domain/rewards/economy.ts`, shown in Admin → Overview):

| | Base pool | Max holder-bonus exposure (+25 % on every prize) | **Max liability** |
| --- | --- | --- | --- |
| Daily | 100,000 | 25,000 | **125,000** |
| Weekly | 500,000 | 125,000 | **625,000** |

**Season 1 planning** (12 weeks = 84 days; a *planning metric only* — nothing is minted or reserved):

| | |
| --- | --- |
| Daily base total | 84 × 100,000 = **8,400,000** |
| Weekly base total | 12 × 500,000 = **6,000,000** |
| Season 1 base maximum | **14,400,000** |
| With +25 % bonuses everywhere | **18,000,000** |
| Reward / dev allocation | 20,000,000 |
| Theoretical buffer | **2,000,000** |

`seasonPlanWeeks` and `seasonRewardAllocation` are settings; Admin warns if a plan exceeds its allocation.

## Admin → Arena Picks

Tabs: **Overview · Claims · Daily & Weekly · Holders & token · Recent battles · Review · Accounts · Reconciliation.** Every write is audited.

* **Overview:** the **leaderboard economy** (per board: base pool, maximum holder-bonus exposure, maximum liability), the **Season 1 plan**, configuration, the prize ladder and bonus tier table with wallets per tier, today (picks, correct, points), reward health (base and bonus credited **separately**, held, pending bonuses, outstanding, coverage), warnings (token off, retired key present, **overdue holder wallets**, pending bonuses, plan over allocation, thin coverage).
* **Daily & Weekly:** the running periods; **finalized boards** with each Top-10 row — rank, hero, points, accuracy, **base prize, holder tier, bonus %, bonus amount, total reward, review status and a one-line qualification-evidence summary** (e.g. *"10M QUALIFIED: verified at/above the threshold at every one of 97 checks since 2026-10-06T00:00:00Z (needed ≤ …)"* or *"Not qualified — 10M: held only since 2026-10-07T23:55:00Z (needed ≤ 2026-10-06T00:00:00Z)"*); for a **HELD** prize *Release / Forfeit* with an audited reason (the bonus follows); for a **PENDING VERIFICATION** bonus *Re-verify now / Give up*. If an ended period has not finalized: a warning and *Re-run safe finalization*. **No reset, ever.**
* **Holders & token:** the token status (**Official Contract** — NOT LAUNCHED, or the short address with COPY — **Metadata Verified**, **Symbol**, **Decimals detected**; no decimals input), RPC status, counters (connected, due, **overdue**, failures, stale) and a **qualification table** per wallet — current balance, observed tier, last verified, next verification, failures, **Daily / Weekly bonus Qualified · Qualifying · Broken**, qualification start, broken timestamp and reason. Internal risk signals stay admin-only.
* **Review**, **Accounts** (member detail: wallet, balance, observed tier, qualification, picks, correct, points, claimable/sent, review state, latest observations, recent board results), audited balance adjustment, **Reconciliation** (base ledger = credited base prizes; bonus ledger = credited bonuses; board totals; pending bonuses past their window; empty = healthy).
* Dev/QA only (simulated adapter only — a real chain answers 409): `POST /api/admin/picks/sim/balance`, `POST /api/admin/picks/sim/transfer`, and `POST /api/admin/picks/sim/outage {on}` (switches the simulated RPC off/on, to rehearse a failed close verification → bonus PENDING VERIFICATION → *Re-verify bonus now*).

## Hall of Champions — Picks Season, and what changed around Picks (2026-10-07)

The Leaderboard page now has three sections (Arena Picks · Hero Arena · Hero Records) with one Daily/Weekly/Season selector — see [HERO_ARENA.md](HERO_ARENA.md). **Picks rules are unchanged** (UTC day / Monday week, minimums 20 / 100 valid Picks, +10 per correct Pick, pools 100,000 / 500,000, the Top-10 ladder). What is new for Picks:

* **Season = standings only.** `GET /api/leaderboard/picks?period=season[&season=<id>]` is the cumulative correct-Picks standing of one season (current by default): no prize ladder, no payout, no finalization. Season 2 starts at zero; past seasons stay browsable.
* The Daily/Weekly payload carries the season's label and kind (so the UI can show **Development / Beta**).
* Performance: the per-request scan `findFinalizingPeriod`, the Picks sweep and the admin overview no longer call `public.period_season()` per score row (it scans the period's scores itself — quadratic in the number of picks). They use the equivalent row-level `COUNTING_SEASON_SCORE` test; results are identical (1,338 ms → 14 ms on the scratch data set). Guarded by `tests/unit/period-scan.test.ts`.
* Hero Arena is a **separate** reward program: its own pools, tables, finalization and ledger source (`reward_source` labels every ledger row `ARENA_PICKS_DAILY` / `ARENA_PICKS_WEEKLY` / `HERO_ARENA_DAILY` / `HERO_ARENA_WEEKLY`). The Picks ledger insert path is untouched.

## Player surfaces

* **Arena → Picks panel:** (owned by the arena-lifecycle work) free unlimited picks; short copy from `state.picks.reward` (`PicksRewardDto`: points per correct pick, the Daily/Weekly minimums and pools — no per-battle token amount, no daily cap); results show Points and whether the pick counted toward the boards.
  * **Prize tiles (presentation only; compact since 2026-10-09):** under the title the panel shows two small tiles — **Daily pool 100,000 $CLANKRPG** and **Weekly pool 500,000 $CLANKRPG** — one link "Prize rules & countdowns →" (to the Leaderboards), then the two short lines "Correct Pick = +10 Points" / "Free to play", then the Telegram sign-in strip or the member's own pick state, then the eight fighters. The Arena is a *quick summary*: the Top-10 banner, the reset countdowns, the fine print, the token-launch note, the big medal/crown art and the animations were removed (they replaced the earlier "plaques", ~290 px tall; the tiles are ~85 px). Every number comes from `state.picks.reward` (built from the `arena_picks` settings — an admin who changes a pool changes the tile; nothing is typed twice). The tiles are server-renderable (no state, no timer), so nothing on the Arena re-renders because of them. The rules, Top-N, minimum Picks, holder bonus, token status and live countdowns are on the Leaderboards page — see [`HERO_FREE_REROLL.md`](HERO_FREE_REROLL.md) § 6.
* **Leaderboard → Arena Picks → Daily | Weekly:** title with the (i) popover, a highlighted **countdown card** (*DAILY LEADERBOARD · ENDS IN · 23H 59M 59S* / *WEEKLY … 06D 23H 59M*, server-anchored; a finished period says **COMPLETED**; the exact UTC times are in a collapsed "Exact times"), the pool and `TOP 10 REWARDED`, **My score**, **Picks · Correct · Accuracy · Points · Current rank** (Daily and Weekly, no `n / 20` counter), the Top-10 prize ladder, **Reward details** (both pools, who shares them, the 20 / 100 valid-Picks qualification, the holder bonus, the token launch status), the day/week selector, then the board (rank, hero, correct/picks, accuracy, streak, points, projected/final prize, `TIE`, `NOT YET PRIZE ELIGIBLE`; a finished row adds the holder tier label, bonus and total). The (i) popover is **HOW DAILY ARENA PICKS WORKS** / **HOW WEEKLY ARENA PICKS WORKS** with the spec's wording and every number from the server's rules; hover/click on desktop, tap on a phone.
* **Profile → Arena Picks:** accuracy and streaks; **Points** (Daily and Weekly picks · correct · accuracy · points · rank, lifetime Clank Points); the **HOLDER REWARD BONUS** card (FREE: *0% bonus · Hold $CLANKRPG to boost leaderboard prizes you earn · ladder · Connect wallet · Holdings NEVER affect your Arena Picks score or chance to rank*; holder: tier and `+15 % Leaderboard Prize Bonus`, balance, short wallet, **Daily bonus QUALIFIED / QUALIFYING / BROKEN / NEEDS VERIFICATION**, **Weekly qualification progress 5D 7H / 7D required before the next eligible week**, Refresh holdings); Arena Rewards; Latest rewards; Claim history (**CLAIM REWARDS** → *Where should we send your rewards? (•) Connected Wallet / ( ) Another Wallet → SUBMIT CLAIM*); recent picks (+10 when correct).

## Removal of the betting direction

All of it is gone (server/domain/components/routes/admin panels/env/settings/flags/tests/docs for betting and the mainnet shadow mode). Live's inert leftovers from the retired code (a `game_settings.betting` row and flags `betting.enabled`, `betting.test_mode`, `betting.real_money_enabled`) are **untouched**; the app ignores them. A reviewed one-off — **only with your explicit go-ahead** — would be:

```sql
delete from public.feature_flags where key in ('betting.enabled', 'betting.test_mode', 'betting.real_money_enabled');
delete from public.game_settings where key = 'betting';
```

## Migration

**`20261005001300_arena_picks_rewards.sql` is ALREADY APPLIED to the live database** — re-verified read-only on 2026-10-05 during this phase (`pnpm db:migrate -- --dry-run` → *"up to date (already applied: 10)"*; a `SET TRANSACTION READ ONLY` inspection showed every reward table present and **empty** — 0 picks, 0 settlements, 0 ledger rows, 0 claims — and the live schema identical to that file apart from the inert betting leftovers). It was therefore **not edited**. Everything in this phase is the follow-up:

**`supabase/migrations/20261005001400_arena_picks_leaderboards.sql`** (NOT applied anywhere live):

* **refuses to run** (and rolls back whole) if any per-battle $CLANKRPG was ever credited (`ARENA_PICK_REWARD` ledger rows, a paid outcome, a distributing settlement) — it will not discard money records;
* rewrites a stored `arena_picks` settings row that still has the old-design keys (live's is the untouched v1 seed): retired keys go, the economy numbers take the final defaults, operational knobs an admin tuned survive, `version` +1, `updated_by = 'migration:20261005001400'`; the application's reader (`upgradeLegacyArenaPicks`) performs the same upgrade in memory, so code running **before** the migration reads the old row correctly;
* drops `arena_pick_outcomes` and its allowance guard, the lock-time tier snapshot trigger and function (the inert `arena_picks.tier_snapshot` column stays — the pick guard names it);
* **ledger:** new kinds (base and bonus apart), `period_kind`/`period_start` instead of `week_start`, the per-battle reference columns dropped, new sign rules and unique indexes, a composite FK to the result row;
* **LOGICAL amounts:** every reward amount is an integer number of micro-tokens (`*_micro`); `token_decimals` and raw ERC-20 units leave the boards and the ledger. A claim carries its logical `amount_micro` plus the exact `amount_raw` derived from the contract's `decimals()` when it was made, tied by a CHECK (`amount_raw = amount_micro × 10^(token_decimals − 6)`); `arena_reward_token` is a one-row cache of what the contract itself reported (symbol, decimals, verified_at). The migration **refuses** (whole, nothing changed) if the database already holds any reward amount recorded under 1300's token-base-unit scale — live holds none;
* **`arena_pick_settlements`** keeps only the exactly-once scoring anchor (status `SCORED`/`VOID`, counts incl. `valid_picks`, `points_awarded`; no token field);
* **`arena_weekly_pick_scores` → `arena_pick_scores`** (feeds both boards) with a new guard that refuses a score row for any finalized day/week (and no per-day counting columns);
* **`arena_leaderboards` + `arena_leaderboard_results`** (DAILY and WEEKLY; frozen terms; the result row carries base prize/status and bonus tier/%/amount/status/evidence; CHECKs make `bonus = div(base × bps, 10000)`, forbid a bonus on an unearned prize and tie a CREDITED/HELD/FORFEITED bonus to its base prize's status; a guard trigger allows only the two audited transitions); the old (empty) weekly tables are dropped;
* **`arena_holder_observations`** (append-only; the database refuses an observation of any wallet but the member's current verified one); `arena_holder_status` loses its tier/candidate/activation columns and keeps the latest read and the verification schedule; `arena_holder_tier_history` is kept as a legacy audit trail.

Tested (`integration/rewards-migration`, 20 tests) on an empty database, on a database **in the state live is in today** (…001300 applied, the untouched v1 settings row, empty tables), with an admin-tuned old row, with an already-new row, with a per-battle credit and with 1300-scale reward amounts (both refuse: nothing changed, nothing recorded), for the logical-amount schema and the claim conversion CHECK, and for atomic rollback on a mid-migration error.

**Apply order:** the migration **first**, then deploy the code. Code that runs before it is a quiet no-op for the reward sweeps (`rewardsReady` checks the new tables) and writes nothing: the boards answer 503, and so does **submitting a pick** (`REWARDS_UNAVAILABLE` — a pick could not be scored, so none is taken); the arena itself keeps running. That is why the migration goes first. A dry run lists exactly what would apply:

```bash
pnpm db:migrate -- --dry-run
pnpm db:migrate -- --up-to 20261005001400   # applies pending migrations up to and including this one, no reference seeding
```

(Other migrations may also be pending — `…001500` Arena Picks lifecycle, `…001600` Telegram hero threshold, `…001700` combat pacing 3.0.0 (settings only, see `docs/COMBAT.md`); `--up-to` lets you apply them in order and separately. **Before `…001600`:** flag any non-player account (a community bot) under Admin → Telegram, or the live webhook turns it into a hero on its next message once the threshold is 50 — see `docs/TELEGRAM.md`.) Restart any running `arena-worker` / dev server after applying so they load this code — a worker still running the old code logs quiet scoring errors until then.

## Needed before paying real claims

1. **Your go-ahead to apply `…001400`** to live (then deploy). Nothing here applied it.
2. **After the token launches:** the real **`CLANKRPG_TOKEN_ADDRESS`** — nothing else (decimals and symbol are read from the contract); optionally `CLANKRPG_REWARD_TREASURY_ADDRESS` and `CLANKRPG_EXPLORER_TX_URL`. Before launch leave it unset: everything except holder bonuses and on-chain payouts already works. Remove `CLANKRPG_REWARD_TREASURY_PRIVATE_KEY` if it exists anywhere — there is no signer.
3. Run **one** `pnpm arena:worker` (or the 1-minute `/api/internal/tick`): it scores picks, runs **background holder verification**, **finalizes the Daily and Weekly boards** (with the close verification) and reconciles pending bonuses. Watch Admin's *overdue wallets* warning.
4. A **real-RPC check** against Robinhood Chain: token `decimals()`/`symbol()`, a holder `balanceOf`, the **close verification** at an actual boundary, and one real manual payout through *Mark sent* with a tiny amount (all exercised only against a simulated chain and a mocked node so far).
5. Check a **real wallet extension** and **real Telegram** sign-in once (QA used a mock EIP-1193 wallet with real signatures).
6. Load-test finalization and scoring on **real Postgres** (PGlite is single-connection: concurrency tests prove logic, not true parallelism).
7. Review the numbers (pools, ladder, minimums, bonus tiers, the 24 h / 7 d windows) as **product decisions**; the Season 1 plan fits a 20,000,000 allocation only at these defaults.
8. Decide the policy for REVIEW/SUSPENDED accounts, legal/regulatory review of token rewards, and the stale live betting rows (cleanup SQL above, unrun).

## Tests

`unit/rewards-leaderboard` (daily/weekly windows and countdown formats, ranking, the 30/20/15… ladder at both pools, the 17,500 tie, remainder conservation property, holder schedule), `unit/rewards-holder-bonus` (the continuity engine and every loophole case, tier fallback, gaps, the live QUALIFIED/QUALIFYING/BROKEN/NEEDS VERIFICATION card), `unit/rewards-economy` (max liabilities, Season 1 numbers, legacy-settings upgrade, cross-field validation), `unit/rewards-domain`, `unit/rewards-config`, `unit/rewards-chain-reader`, `unit/arena-board-ui`, `integration/rewards-scoring`, `integration/rewards-boards` (Top-10 ladder, minimums, ties, finalization idempotency/immutability/waiting, weekly accumulation, the sweep, live/final DTOs), `integration/rewards-holder-bonus` (cases A–F against the real database and simulated chain, close verification, PENDING → CREDITED / NONE / EXPIRED, held prizes carrying bonuses, ledger separation, holder-vs-free ties, a claim of base + bonus), `integration/rewards-holders` (signatures, the observation log, token hopping, wallet change, paths A–C, stale handling), `integration/rewards-claims`, `integration/rewards-admin`, `integration/rewards-no-pay-to-win` (including a played-out 22-battle comparison of a FREE member and a 10M holder), `integration/rewards-migration`, `integration/rewards-picks`, `integration/arena-picks-ui`, `security/rewards-http`, `security/rls`.

Added by the token-not-launched / logical-accounting pass: `integration/rewards-no-token` (no `CLANKRPG_TOKEN_ADDRESS`: Daily + Weekly finalization, base accounting, 0 % bonuses even for a wallet with history, claims answered *not yet*, Admin payout summaries 100,000 / 500,000, the pre-launch holder card), `integration/rewards-mock-contract` (a mock contract at 2 / 6 / 9 / 18 decimals: symbol + decimals auto-detected and cached, holder tiers read at the contract's decimals, logical → raw claim conversion, MARK SENT exact-raw verification, an unverifiable contract failing closed), `integration/telegram-blocked-member` (a flagged/banned account is never turned into a hero by the live webhook; nothing hard-codes an id), `unit/arena-state-path` (the Arena state route never reaches the token), and the new `rewards-migration` / `rewards-http` / `rewards-config` cases (logical schema, claim conversion CHECK, token cache table, retired variables, BUY link, public token endpoint).

## Verification record

*Run 2026-10-05 → 2026-10-06. Nothing was committed, pushed, deployed or applied to live. Everything below ran against scratch PGlite databases, a simulated chain and local dev servers; live was only ever read inside `SET TRANSACTION READ ONLY`.*

**FINAL GATE (2026-10-06, after the logical-accounting / token-not-launched / BUY-CTA / 60 s-combat pass — supersedes the gate table and the cap-era / tier-ladder walk-throughs below):**

| Gate | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `eslint . --max-warnings=0` | 0 errors, **0 warnings** |
| `vitest run` | **78 files / 1,269 tests pass** |
| Critical set × 3 (combat, pacing, no-level goldens, static arena, kill feed, boundaries, Arena state/transition, upcoming-picks lifecycle, Daily + Weekly boards, holder bonus, token config / chain reader / mock contract / no-token, payouts, claims, hero threshold + blocked member, HTTP) | **41 files / 703 tests, identical in all three runs** |
| `next build` (isolated dist dir, blank `DATABASE_URL`) | succeeds |
| Scratch migration proof (a database fingerprint-identical to live @1300, live's real settings rows): runner order, fully reversed order, each of 1400/1500/1600/1700 alone, injected late failure → whole-file rollback + clean retry | **40 / 40 checks pass** |
| Combat simulation, 10,000 random 8-fighter battles, rules 3.0.0, hard cap 60 s | median **37.4 s** · p75 41.9 · p90 47.4 · p95 52.4 · max 60 · 91 % end between 25 and 55 s · **3.1 %** reach the cap · class win % Warrior 16.5 / Mage 15.9 / Ranger 13.3 / Rogue 10.9 / Cleric 9.7 / Tank 8.8 |
| Live-like arena drive (HTTP, 12 members, 10 real battles, no token configured) | combat median 39.4 s (29.0–46.4), all `LAST_STANDING`; lock = 6.2 s before the fight, slots back-to-back (gap 0 ms), 108 picks accepted / 9 late picks refused `LOCKED`, next roster prepared during every fight; **`/api/arena/state` over 682 polls: min 11.5 ms · median 33.8 ms · p95 40.5 ms · max 86.1 ms** (local PGlite, no injected latency) |
| Arena state path | `tests/unit/arena-state-path.test.ts` walks the route's static import graph: no chain reader, holder verification, finalization, claims, token metadata/config or bonus engine is reachable (the reward sweep is lazy-loaded off the request path) |
| Live (read-only) | 10 migrations applied, `…001400` `…001500` `…001600` `…001700` pending, all reward tables empty (1400's refusal guards cannot trip), 78,965 messages, 70 heroes, threshold still 100; final hero preview with the excluded account: **69 new / 139 total**, 69/69 renderable on the dev-placeholder art set |

**Responsive QA of the BUY $CLANKRPG button** (real browser, isolated server): at 1440 / 1024 / 768 / 375 / 320 px the button is visible, readable, never overlaps the logo or the account button, and the page has no horizontal overflow; below 360 px the header shows the emblem only (and below 480 px the account button is icon-only) so both buttons fit. With no address configured it opens `https://clank.trade/` and with a (simulated) contract configured the same button opens `https://clank.trade/<address>`, both in a new tab with `rel="noopener noreferrer"`. The Admin token panel shows *Official Contract* (short address + COPY), *Metadata Verified*, the *Symbol* and *Decimals detected* (no input), and the BUY link in use.

**Live state (read-only, re-checked 2026-10-06 08:25):** 10 migrations applied (`…000100` – `…000900`, `…001300`); `…001400`, `…001500`, `…001600` pending; every reward table empty (0 picks, 0 settlements, 0 ledger rows, 0 claims, 0 weeks); `game_settings.arena_picks` is still the v1 seed (`rewardPerBattle`, tiered `rewardedWins`, 100,000 weekly pool) — exactly what `…001400` rewrites. Because `…001300` is applied, it was not edited.

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` (`--max-warnings=0`) | clean |
| `pnpm test` | **69 files / 1,159 tests pass** |
| Key set × 3 (rewards, scoring, boards, holders, ties, ledger, claims, arena transition/boundary/state, kill-feed, picks HTTP) | **29 files / 531 tests, identical in all three runs — no flake** |
| `next build` (isolated dist dir, blank `DATABASE_URL`) | succeeds |
| Client-bundle scan (22 files) for secret names / server-only config / QA keys | 0 hits |

**Real-browser QA** (isolated server, scratch PGlite, simulated chain; sign-in through the dev-login route; wallet signatures were REAL `personal_sign` signatures from throwaway keys via a mock EIP-1193 provider):

* **SUPERSEDED — cap era (kept as history only).** An earlier QA pass recorded a FREE member and a 10M holder making 23 real picks under the old *first 20 picks per day score* rule (`scoredToday 20 / 20`). That rule was **removed**; unlimited scoring is covered by the automated suites (`integration/rewards-scoring`, `integration/rewards-no-pay-to-win`, `unit/rewards-leaderboard`, `integration/rewards-boards`) and has **not** been re-run in a real browser since the change.
* **SUPERSEDED — cap era.** The earlier Daily/Weekly board walk-through showed a `17 / 20` scored-picks counter, which no longer exists (the profile and boards now show Picks · Correct · Accuracy · Points · rank). The rest of that walk-through (100,000 / 500,000 pools, TOP 10 REWARDED, server-anchored ENDS IN, history selector, **NOT YET PRIZE ELIGIBLE** rows, exact ties marked TIE, server-supplied popover numbers) is unchanged.
* **Rollover** (server clock offset to Sunday 23:48 UTC; QA rig only) — second by second: `00H 00M 01S` → at `00:00:00` the Daily **and** Weekly period both flip (`2026-10-11` → `2026-10-12`), the new period's counters start at zero, the countdown restarts at **23H 59M 59S** (weekly `6D 23H 56M`), the ended periods show **FINALIZING** and then freeze as history chips (`OCT 11`, week of `OCT 5`); nothing is deleted.
* **Holder qualification states** — a fresh 10M holder (connected through the real Connect Wallet flow) is **QUALIFYING** (daily from the Oct 7 board, weekly from Oct 19, progress `0H 0M / 7D`); the long-term holder is **QUALIFIED**; a member who sold today is **BROKEN**; FREE members show the FREE card with the tier ladder and "Holdings NEVER affect your Arena Picks score or chance to rank".
* **Loopholes in the finalized boards** — Daily Oct 4: #1 long-term 10M holder **30,000 + 7,500 = 37,500**; #2 who bought 10M five minutes before the close **20,000, no bonus** (admin evidence: *held only since 2026-10-04T23:55:00Z (needed ≤ 2026-10-03T00:00:00Z)*); #3 1M holder 15,000 + 2,250. Seller on the day: base paid, bonus removed. Weekly (week of Oct 5, frozen at the rollover): #1 base 150,000 with the holder bonus waiting on verification (next bullet), the last-minute buyer #2 base 100,000 and no bonus; the weekly Sunday-night-buyer and full-qualification cases (D / E) are exercised by `integration/rewards-holder-bonus`, not re-run by hand.
* **Failed close verification** (simulated RPC switched off across the boundary) — both boards froze with every **base prize paid** and the winner's bonus **PENDING VERIFICATION** ("Holder bonus pending verification" on the board and in *My reward*; admin: "No close verification exists yet"); after the RPC returned, **Re-verify bonus now** → *Bonus re-verified: CREDITED* → 30,000 + 7,500 = 37,500 with the evidence line.
* **Manual claims** — modal: *Where should we send your rewards? (•) Connected Wallet / ( ) Another Wallet*; an invalid address leaves **Submit** disabled; a valid alternate address creates a PENDING claim of 375,000 to that wallet while the **holder wallet is unchanged**; Admin → Claims shows *CUSTOM WALLET* vs *CONNECTED HOLDER WALLET* with the exact frozen amount; **Mark sent** (simulated transfer, ≥ 2 confirmations) → SENT, **Deny** (reason) → DENIED and the reward is claimable again; member history shows SENT with the tx hash and DENIED with a calm explanation. *Latest rewards* list `DAILY #1 +30,000`, `10M HOLDER BONUS +7,500`, `WEEKLY #1 +150,000`, `10M HOLDER BONUS +37,500` as separate lines.
* **Admin** — Leaderboard economy (Daily 100,000 / 25,000 / **125,000**; Weekly 500,000 / 125,000 / **625,000**), Season 1 plan (84 days; 8,400,000 + 6,000,000 = 14,400,000; **18,000,000** at +25 % everywhere; 20,000,000 allocation; **2,000,000** buffer), holder-qualification table (balance, observed tier, last/next verification, failures, Daily/Weekly Qualified·Qualifying·Broken with the reason), finalized boards with every §45 column and the evidence summary.

**Responsive QA** — at **1440 / 1024 / 768 / 375 / 320** px, for the Daily and Weekly boards (current and finalized, both popovers), the character page (holder card, claim modal with *Another Wallet* open) and every Admin Arena Picks tab: **no page-level horizontal overflow and no element outside the viewport at any step**; popovers and the modal stay fully inside it down to 320 px (screenshots at 320 px checked by eye).

**Defects found by this QA and fixed:** the progress label read `0M / 7D` for brand-new holdings (reads like "0 million") → `0H 0M`; a stale comment in `services/holdings.ts`; the docs said unmigrated code leaves picks untouched — it answers 503 until the migration is applied; and a QA-only `sim/outage` admin route was added (simulated chain only, tested) to be able to rehearse §31 in a browser.

**Not verified (needs the real world):** a real Robinhood Chain token (`decimals()`, `balanceOf`, a real close verification, a real manual payout), a real wallet extension, real Telegram sign-in, true Postgres concurrency (PGlite is single-connection). The sweep that finalizes boards is driven by the worker / `/api/internal/tick` (and, in dev, by an arena settlement) — in production run **one** `pnpm arena:worker` or the 1-minute tick.
