# Paid hero reroll

> **Status (2026-10-15): built and verified on scratch databases only — shipped OFF.** Nothing here has been applied to LIVE. Migration `20261015003000_hero_paid_reroll.sql` is pending; the feature flag
> `hero.paid_reroll` is seeded **disabled**; and the feature also needs the token configured (`CLANKRPG_TOKEN_ADDRESS` + `CLANKRPG_REWARD_TREASURY_ADDRESS`). Until all three are true the panel says
> "Paid rerolls aren't open yet" / "open when $CLANKRPG is live" and nothing can be paid.

A member who has used today's **free** reroll ([`HERO_FREE_REROLL.md`](HERO_FREE_REROLL.md)) can **pay $CLANKRPG for another**: **100,000 $CLANKRPG** by default (`hero_reroll.paidPrice`), up to **10 per UTC day** (`paidMaxPerDay`).
The reroll is *exactly as random as a free one* — the same generator, the same odds, the same validation, the old state stays in the version history. Only the way it is paid for differs.

## 1. How the payment works (and why the app still holds no key)

```
Hero page → "Reroll again" card → confirm dialog (price, recipient, warning, acknowledgement)
   │ click "Pay 100,000 $CLANKRPG"
   ▼
 the member's OWN wallet opens (window.ethereum / EIP-1193), in this order:
   1  eth_requestAccounts                 connect an account
   2  personal_sign (only if no wallet is linked yet)   free, no gas: links the wallet to the hero through the existing server challenge
   3  wallet_switchEthereumChain          (wallet_addEthereumChain first if the wallet has never seen the chain)
   4  eth_sendTransaction                 an ordinary ERC-20  transfer(treasury, price)  — to/data/amount come from the SERVER's status, the browser adds nothing
   ▼
 POST /api/me/hero/reroll/paid { requestId, txHash }   → the server READS the chain, verifies, records, rerolls
```

* The payee is the **reward treasury** (`CLANKRPG_REWARD_TREASURY_ADDRESS`, the wallet that pays prizes by hand). Reroll fees therefore refill the very reserve that funds the Daily / Weekly prize pools — see
  [`TOKEN_UTILITY.md`](TOKEN_UTILITY.md). The app never signs, never sends and never holds a key; it only *reads* (`getTransfer`, the same read-only seam payouts are verified with).
* The browser never decides anything: the **token, recipient, amount and calldata** are built on the server (`getPaidRerollStatus`, converting the price with the contract's own `decimals()`), and the request body
  carries only `{ requestId, txHash }` (strict schema — an amount, address, hero id or price is a 422).

## 2. What counts as "paid" (`checkPayment`, pure, `src/domain/hero/paidReroll.ts`)

Decided only from the chain's own facts about the transaction:

| Check | Refusal (`PAYMENT_INVALID`, `reason`) |
| --- | --- |
| the transaction **succeeded** | `REVERTED` |
| on the **configured chain** | `WRONG_CHAIN` |
| it contains `Transfer` events **to the treasury** | `NOT_TO_TREASURY` |
| …of the **official token** | `WRONG_TOKEN` |
| …from a wallet **the member proved control of** (the hero's linked wallet, or the reward-holder wallet) | `WRONG_PAYER` |
| the sum from ONE such wallet ≥ the price (an overpayment is one reroll) | `TOO_LITTLE` |
| **confirmations ≥ `paymentConfirmations`** (default 2) | not an error: `PENDING`, the browser asks again every 4 s |

Because the payer must be a wallet the member linked (a wallet can back only one hero), **a hash seen in a public mempool cannot be claimed by anyone else**.

## 3. Money is never lost: record first (a credit), then apply

`confirmPaidReroll` (`src/server/services/heroPaidReroll.ts`):

1. **Verify on-chain — outside every database transaction.** The shared handle has one connection in production; an RPC call must never hold it, nor sit inside a transaction holding a hero's row lock
   (the same rule as the equip fix in [`DATABASE_CONNECTIONS.md`](DATABASE_CONNECTIONS.md) § Incident 3).
2. **Record the payment** in `hero_paid_rerolls` as `PAID` — a transaction of its own, `UNIQUE (tx_hash)`.
3. **Apply** in a second transaction: lock the hero, check the request key, claimed/active, the daily brake and the Arena roster, `rollNewHeroVersion` (shared with the free reroll), move the row to `APPLIED`.

If step 3 is refused — the hero is in a live Arena fight (`HERO_IN_ARENA`), today's paid limit is reached (`DAILY_LIMIT`), a stale request key — the **credit stays**. The status then reads `CREDIT_WAITING`
("Your payment is confirmed and safe…") with a **Use my paid reroll** button; no second payment is ever requested. The browser also remembers `{requestId, txHash}` in `localStorage` and finishes an
unresolved payment after a reload (the server is idempotent on the hash). A replay of an applied hash returns the same reroll (`alreadyApplied`), whatever request key it carries.

## 4. What the database enforces by itself (migration 3000)

* `hero_paid_rerolls`: **`UNIQUE (tx_hash)`** (one payment, one reroll — for every member), `UNIQUE (request_id)`, `UNIQUE (hero_version_id)`, a shape CHECK (a row is either `PAID` with no apply columns, or `APPLIED` with all of them),
  the UTC day derived from `applied_at`.
* Guards: a row is born `PAID` for the hero's **own** member; `PAID → APPLIED` is the only transition and changes nothing but the apply columns; the version it names must be a `REROLL` made by `member-paid:<id>`, the direct
  successor of the one it replaced, with matching key and before/after class · rarity · PWR; never deleted except with its hero.
* A **deferred constraint trigger** on `hero_versions`: a version created by `member-paid:*` cannot commit without its `APPLIED` payment row. A reroll that was not paid for cannot exist. (The free reroll's check looks only at
  `member:*`, so the two programmes never interfere — that is why the actor is `member-paid:`, not `member:`.)
* `audit_hero_paid_rerolls()` — every row is a violation; must return none. RLS on, no policies, no browser-role privileges (`clank_harden_schema()`).

## 5. Configuration and switching it on

| What | Where | Default |
| --- | --- | --- |
| price (whole $CLANKRPG, a decimal **string**) | `game_settings.hero_reroll.paidPrice` (Admin → Settings) | `"100000"` |
| paid rerolls per member per UTC day | `hero_reroll.paidMaxPerDay` | `10` |
| confirmations before the reroll is applied | `hero_reroll.paymentConfirmations` | `2` |
| feature flag | Admin → Feature flags → `hero.paid_reroll` | **off** |
| token contract / payee | `CLANKRPG_TOKEN_ADDRESS` / `CLANKRPG_REWARD_TREASURY_ADDRESS` (`.env`) | unset until launch |
| RPC for `wallet_addEthereumChain`, explorer link | `ROBINHOOD_RPC_URL`, `CLANKRPG_EXPLORER_TX_URL` | as configured |

Checklist before flipping the flag: apply migration `…003000`; set the two addresses and confirm Admin → Token health shows the contract VERIFIED; do one real payment with a small price on a test member;
`select * from audit_hero_paid_rerolls();` returns nothing; then enable the flag. **Kill switch:** the flag off stops new payments and applications immediately; recorded credits stay recorded (honour them when it is
re-enabled, or refund by hand — the transaction hash and payer are on the row).

## 6. Fairness — read this before enabling

A free reroll is already "a ratchet toward Legendary" ([`HERO_FREE_REROLL.md`](HERO_FREE_REROLL.md) § 4). A **paid** reroll removes the *one-per-day* brake for members willing to pay: reaching Legendary takes ~99 rerolls on
average (≈ 9.9 M $CLANKRPG at the default price), reaching Epic or better ~11.5 (≈ 1.15 M). That is a real **pay-to-roll** mechanic on top of a competitive ladder (Hero Arena prizes follow the strongest heroes' wins).
Safeguards that exist: the **daily cap** (default 10 — the first knob to turn down), the price (a setting), the flag, and "builds lock when a Season starts" remains the recommended way to keep Season standings about play
([`HERO_FREE_REROLL.md`](HERO_FREE_REROLL.md) § 4 recommendation 1 — **not implemented**; with paid rerolls it matters more). It is the owner's decision; the numbers above are the honest cost of the choice.

## 7. Tests

`tests/unit/paid-reroll.test.ts` (payment rules, the flow reducer, the wallet steps against a fake EIP-1193 wallet) · `tests/unit/paid-reroll-ui.test.ts` (every panel state, the confirmation, the progress and result screens) ·
`tests/integration/hero-paid-reroll.test.ts` (24: status states, a payment buys exactly one reroll, replays, pending/unconfirmed, every invalid payment, another member's payment, parallel confirmations, the daily limit and a live
Arena roster keeping the credit) · `tests/integration/hero-paid-reroll-migration.test.ts` (placement, additive, constraints, guards by raw SQL, the auditor) · `tests/security/hero-paid-reroll-http.test.ts` (flag, origin, session,
strict body, replay, theft attempt). All also pass on **real Postgres** with `CLANK_TEST_DRIVER=postgres CLANK_TEST_POOL=1|4` (parallel confirmations, pool of one). Real-browser QA: the full dialog with a fake EIP-1193 wallet
(connect → switch network → send → "Payment sent… confirming", payment remembered locally).

**Not verified:** a real wallet extension and a real on-chain transfer (needs the launched token and a funded wallet — the simulated chain stands in for the read side).
