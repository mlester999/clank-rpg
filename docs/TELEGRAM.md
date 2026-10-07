# Telegram: identity, activity and heroes

Only the **official Clank.trade community** counts. The webhook processes exactly one chat (`TELEGRAM_OFFICIAL_CHAT_ID`); messages from any other chat (including individual token groups), bots, anonymous/channel senders, edits and unsupported updates are ignored.

## What is stored (privacy)

Message **text is never stored**. Per message we keep: ids, timestamp, a keyed **hash** of the normalised text (HMAC with `TELEGRAM_HASH_PEPPER`, used only to detect duplicates), lengths, and boolean features (reply? link? question? night-time? media kind…). That is also what makes *recompute* possible: scoring rules can change and any member can be rebuilt from stored features without ever having kept the words.

Telegram **display names** become hero names after sanitising (control/bidi/zero-width characters and markup are stripped, length capped, neutral fallback if nothing printable remains). Admins can override a name.

## Identity

The immutable numeric **Telegram user id** is the only identity. Usernames and display names are refreshed on every message and never used for ownership. Claiming requires a valid **Telegram Login Widget** payload (HMAC-SHA256 over the sorted fields with `SHA256(bot_token)`, ≤ 5 minutes old, **single-use**), and the hero is looked up *by that id* — a request body can never name a different hero. Demo/dev users have **negative** ids; a CHECK constraint makes it impossible for a real id to be flagged demo or vice-versa.

## Which messages qualify (deterministic, no AI)

A message earns progression only if it passes every rule, evaluated in this fixed order (the first failure is recorded as the reason):

| Rule | Default | Reason code |
| --- | --- | --- |
| Member is not BANNED / FLAGGED | – | `USER_BANNED` / `USER_FLAGGED` |
| Not forwarded | – | `FORWARDED` |
| Not a bare link | – | `LINK_ONLY` |
| Has text (not sticker/photo-only) | – | `NO_TEXT` |
| ≥ 3 s since the member's previous message | 3 s | `TOO_FAST` |
| ≤ 8 messages in any 60 s | 8 | `BURST` |
| Not a repeat of the member's own text within 24 h | 24 h | `DUPLICATE` |
| Not gibberish (repeated characters, unique-word ratio ≥ 0.4) | 0.4 | `GIBBERISH` |
| ≥ 3 words and ≥ 12 letters | 3 / 12 | `TOO_SHORT` |
| Not "gm / lfg / wen / wagmi…" filler (< 60 % low-value words) | 0.6 | `LOW_VALUE` |
| ≤ 40 qualifying messages per UTC day | 40 | `DAILY_CAP` |

The 40-message daily cap means the 50-message hero threshold takes at least two active days. Case, punctuation and emoji are normalised before duplicate detection (`"WEN MOON?!"` = `"wen moon 🚀"`). A qualifying message's *weight* (0.3–1.2) rises slightly for replies/questions and falls for short messages; weight only feeds the activity score.

A member whose messages are ≥ 80 % spam-type rejections (after ≥ 40 messages) is **auto-flagged** for admin review; flagged members' messages are stored but do not qualify until cleared. Every threshold above is in `game_settings → telegram`.

## Hybrid activity score (0–100)

Weighted, each component saturating (`1 − e^(−x/k)`) so volume alone cannot max it out: qualifying messages (35 %), active days (25 %), conversation — replies sent + received (15 %), engagement — reactions + replies received (10 %), and average message quality (15 %). Reactions need the bot to be a group **admin** (`message_reaction` updates), are credited to the *author*, ignore self-reactions and are capped per reactor per day. The score drives the Community leaderboard and a small stat bonus (0–6 points). Behavioural ratios (reply %, question %, exclamation %, long-message %, link %, media %, night %, burstiness) feed the subtle class nudge below.

## Hero creation (at 50 qualifying messages)

Inside the same transaction as the 50th qualifying message, the hero is created exactly once (unique `telegram_user_id`; retries are no-ops):

* **Class — mostly random, permanent.** `p(c) = (1−λ)/n + λ·softmax(β·affinity_c)` with λ = 0.18, n = 6: every class keeps ≥ 13.7 % and none can exceed 31.7 % (uniform = 16.7 %) *whatever the member does* — behaviour is bucketed coarsely (low/mid/high) and only nudges odds, never guarantees. The roll uses a stream seeded by `HMAC(CLASS_ROLL_SECRET, telegram_id)`: stable for a member (idempotent) but unpredictable without the secret, so it cannot be farmed or previewed. A database trigger makes `class_id` immutable; only an audited admin override can change it.
* **Stats:** class baseline + *bounded* variation (each stat ±2, HP ±5, net ≤ ±3 points, and **|Δ POWER| ≤ 5**, i.e. ~3.6 % of a hero) + a small Telegram bonus (≤ 6 points, concave in the activity score).
* **Look:** procedural parts (skin, hair, eyes, mouth, accessory, cape, aura, outfit hue) on top of class gear. **Rarity** (Common 70 % / Rare 22 % / Epic 7 % / Legendary 1 % — a fixed draw, never boosted) is a **real strength tier**: it fixes the hero's PWR band and stat budget (Common 130–149 · Rare 150–169 · Epic 170–189 · Legendary 190–209) and the rarity visuals; class is drawn from its own stream and never depends on rarity. See [`RARITY_POWER.md`](RARITY_POWER.md).

## Historical activity — what is and is not possible

* The **Bot API cannot read history.** A bot sees messages only after it joined, so past activity cannot be fetched through it. We do **not** fabricate historical counts.
* Supported path: a chat member exports the group from **Telegram Desktop → Export chat history → JSON** (`result.json`) and runs the CLI importer (below). It feeds the messages through the *same* scoring pipeline, then recomputes every affected member chronologically. Members with ≥ 50 verified qualifying historical messages get heroes (origin `HISTORICAL_IMPORT`). Importing is idempotent. Limits of the export format: it contains display names but **no usernames and no bot flag**, so hero names come from display names and bot accounts cannot be told apart from people by the file alone.
* A real-time MTProto user client could also read history, but that needs a user session with its own risks and is intentionally not built.

## Importing a Telegram Desktop export (CLI)

```bash
pnpm telegram:import -- ./result.json                      # DRY RUN (default): reads, never writes
pnpm telegram:import -- ./result.json --offline            # dry run without opening any database
pnpm telegram:import -- ./result.json --apply              # writes; needs TELEGRAM_OFFICIAL_CHAT_ID = the export's chat
pnpm telegram:import -- ./result.json --apply --defer-heroes   # data only; create the heroes in a later run
pnpm telegram:verify -- ./result.json [--require-heroes]  # read-only: recompute from the file, compare row by row
```

* **Identity check first.** The export's group name, type and id (`-100…` Bot API form) must match `TELEGRAM_OFFICIAL_CHAT_ID` (and optionally `--expect-name`), otherwise the run refuses. A dry run against a database is a `SET TRANSACTION READ ONLY` transaction that Postgres enforces.
* **Needs** `TELEGRAM_HASH_PEPPER` (keyed text hash — must be the same on the deploy host, or duplicate detection diverges) and `CLASS_ROLL_SECRET` (decides every hero's permanent class). With a real `DATABASE_URL` the importer never falls back to development secrets.
* **What the real export looks like, and how each case is handled** (nothing is guessed):

| In the export | Handling |
|---|---|
| `from_id` `userN` | identity = `N` (numeric, immutable). Usernames are never used. |
| `from: null` / deleted account | not imported (no claimable person) — counted and reported |
| `channelN` senders / anonymous admins | not imported — counted and reported |
| service messages (joins, pins, topic edits…) | ignored, counted by action; unknown entry types are listed |
| bot messages | the file has no bot flag; bot-like display names are **listed for review, not removed** |
| forwarded | stored, never qualifies (`FORWARDED`) |
| stickers / media | stored; captions count as text; no text → `NO_TEXT` |
| edited | the final text is what the file holds (earlier versions are unrecoverable) |
| replies | resolved from the replied-to message *in the same file*; forum-topic implicit replies, joins and replies into other chats are not counted |
| reactions | only reactions with a named user reactor on a stored message; per-reactor daily cap applies; channel / unnamed reactors are not importable |
| `via_bot` | a human sender using an inline bot — counted as the human |

* **Idempotent by construction:** messages are keyed `(chat_id, message_id)`, reactions `(chat, message, reactor)`, members and heroes by the numeric Telegram id. Counters (messages, qualifying, active days, replies/reactions received, activity score) are *derived from stored rows*, so re-runs, partial runs and merging with live webhook traffic cannot double-count. Heroes: a unique `telegram_user_id`; class and look come from `HMAC(CLASS_ROLL_SECRET, id)`.
* **Safety rails for a live database:** `--apply` refuses unless the schema is at the repository's latest migration (or, with `--defer-heroes`, at the baseline the data phase needs), reference data exists, and the pepper/secret are configured.
* **jsonb note:** `pnpm db:repair-jsonb` fixes reference rows seeded through the old postgres.js adapter (jsonb stored as a string). The importer reads such rows only after proving they equal the shipped defaults; heroes need the repair first.

### Creating heroes from history that is already stored

The importer is idempotent for messages, so against a database that already holds the history its dry run reports **0 new messages / 0 qualifying / 0 heroes** — those numbers describe only what *that run would write*, not what is stored (the report now says so and prints a *STORED STATE* block). To evaluate and create heroes from the stored rows use the dedicated command, which never inserts, duplicates or deletes a message, reaction or member:

```bash
pnpm telegram:backfill-heroes                                                 # DRY RUN at the active database threshold
pnpm telegram:backfill-heroes -- --preview-shipped-threshold                  # read-only preview at the shipped 50-message threshold
pnpm db:migrate -- --up-to 20261005001600                                    # apply the threshold config migration when approved
pnpm telegram:backfill-heroes -- --apply --expect-new-heroes N               # apply only after a reviewed dry run and explicit approval
```

**Hero versions.** Every hero the backfill, the import or the live webhook creates gets its INITIAL **v1** in the same transaction (`docs/HERO_VERSIONS.md`); the hero-version migration `20261005001800` must therefore be applied before `--apply`, and the scratch check (`--scratch-check`) now also proves that every existing hero ends up with exactly one INITIAL v1 unchanged and every new hero gets one. It reports **total heroes** and **arena-eligible heroes** as separate numbers (a suspended hero is not "missing"). The full staged live order is in `docs/RELEASE_PLAN.md`.

Migration `20261005001600` changes only a stored `qualifyingThreshold` value of `100` to `50`; it leaves all message-quality and anti-spam settings unchanged. It does not create or modify heroes. The preview flag lets an operator calculate the 50-message result while the database still stores the old threshold; it is dry-run only and cannot be combined with `--apply`.

* **Excluding a non-player account (a community bot, a moderator) — do this BEFORE the threshold migration.** Lowering the threshold also lowers it for the **live webhook**: the next message of any member who already holds ≥ 50 qualifying messages and has no hero creates one. The one-off `--exclude-ids` flag of the backfill only protects the backfill run; for the live webhook use the ordinary moderation control — **Admin → Telegram → the member → FLAG (or BAN) with a reason** (audited, reversible, no code or id is special-cased). A FLAGGED/BANNED member never gets a hero from the webhook, the backfill or a re-score, keeps no prize eligibility, and can be restored to OK at any time (their next message then creates the hero). `tests/integration/telegram-blocked-member.test.ts` proves exactly this on a 70-message account around a 100 → 50 threshold change, and that no source file hard-codes an id.
* **Dry run reports:** stored messages and members considered; stored vs freshly re-scored qualifying totals (re-scored from the stored message *features* with the same pure pipeline); members whose stored scores/counters differ (drift); users at or above the threshold; heroes already present; heroes that would be created with their permanent class, cosmetic rarity, name and a validated deterministic sprite; spam-flagged members; ambiguous identities; and a discrepancy check against what the earlier bulk import planned (from the audit log).
* **Gates for `--apply`:** schema at the latest migration; reference rows readable (otherwise `pnpm db:repair-jsonb`); `CLASS_ROLL_SECRET` configured; `--expect-new-heroes N` must equal the number due; stored scores that differ from a fresh evaluation refuse the run unless `--rescore` is given (only status-OK members are ever re-scored); an eligible member whose name looks like a bot (`/bot/i`) refuses the run until a person decides with `--confirm-human-ids` or `--exclude-ids` — bots cannot be proven from the export, so nothing is removed automatically.
* **Idempotent:** a hero is keyed by the unique Telegram id and members who have one are skipped; re-running creates nothing and changes nothing. The run ends by re-planning from the stored rows to prove nothing is still due.

## Setting it up (needs credentials you control)

1. Create a bot with **@BotFather** → `TELEGRAM_BOT_TOKEN`. Add it to the official group. Make it an **admin** (needed for reactions) and either turn **privacy mode off** (`/setprivacy`) or keep admin rights so it sees all messages.
2. Choose `TELEGRAM_WEBHOOK_SECRET` (A–Z a–z 0–9 `_-`, ≥ 16 chars) and find the group's chat id → `TELEGRAM_OFFICIAL_CHAT_ID` (e.g. `-1001234567890`).
3. `pnpm telegram:webhook -- set https://<your-domain>/api/telegram/webhook` (registers the secret token and `message` + `message_reaction` updates). `-- info` shows delivery status.
4. For sign-in: `@BotFather → /setdomain` for your domain, and set `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` (**both** it and `TELEGRAM_BOT_TOKEN` are required, or the button is not offered). Full behavior, cookies and the production checklist: [`PLAYER_AUTH.md`](PLAYER_AUTH.md).

The webhook rejects missing/wrong secret tokens (403, constant-time compare), non-JSON (400) and oversize (413) bodies; malformed-but-authentic updates get a 200 so Telegram doesn't retry them forever; real processing errors return 500 (Telegram retries; ingestion is idempotent).
