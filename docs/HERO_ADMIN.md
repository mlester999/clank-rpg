# Hero admin, RPG names & hero eligibility

Three things shipped together (migration `20261005000800_hero_admin.sql`):

1. **Admin → Heroes** — search, filter and inspect every hero; rename it; leave an admin note; light moderation.
2. **The RPG display name** — what Clank RPG shows for a hero, separate from the member's Telegram identity.
3. **"Who becomes a hero?"** — player-facing explanation of the eligibility rule (arena card + modal, `/character` cards, signed-in status).

## 1. Three identities, kept apart

| Identity | Where it lives | Can change? | Used for |
| --- | --- | --- | --- |
| Telegram user id | `telegram_users.telegram_user_id`, `characters.telegram_user_id` | **Never** | Ownership, claims, wallets, history — everything that matters is keyed by this / the character id |
| Telegram display name / `@username` | `telegram_users.display_name`, `.username` | Yes, on Telegram | External information only; shown in admin, never trusted for ownership |
| **RPG display name** | `coalesce(characters.name_override, characters.name)` | Admin (and, later, a restricted self-service rename: `name_changed_by = 'PLAYER'` is reserved) | What every Clank RPG screen shows |

`characters.name` is the name generated when the hero was created (from the Telegram name, or the neutral fallback `Wanderer ####` when that name has nothing printable). `name_override` is the chosen name; clearing it returns to the generated one.

**A rename is presentation only.** `setRpgNameInTx` (`src/server/services/admin.ts`) writes `name_override`, `name_changed_at`, `name_changed_by` and one audit row — nothing else. Telegram id, character id, class, stats, XP, claim, wallet, achievements, inventory, gold and battle history are untouched (pinned by `integration/hero-admin`). The player can still claim the same hero after a rename. There is exactly **one** implementation: both `PUT /api/admin/heroes/:id/name` and the legacy `PATCH heroes/:id { nameOverride }` go through it.

### Name rules (`src/domain/character/rpgName.ts`, shared by the UI and the server)

* Normalised to NFC, runs of spaces collapsed, trimmed.
* At most **32 characters, counted in Unicode code points** (the database allows 40, so an emoji never splits).
* Normal Unicode and emoji are fine (including ZWJ emoji sequences); a name needs at least one letter, number or emoji.
* Rejected: control characters (incl. tab/newline), bidi overrides/isolates, zero-width space, word joiners, BOM, and `<` `>` `` ` ``. The database repeats the control-character rule as a `CHECK` (`characters_name_override_clean`) as defence in depth.
* Names are rendered as plain text by React; the HTML-looking name `<img src=x onerror=alert(1)>` is stripped/rejected on the way in and could never execute on the way out.

### Where a renamed hero's new name shows up

Verified visually and by `integration/hero-admin` ("the new name appears everywhere"): admin list and detail · hero page `/character/[id]` and the owner's `/character` page · leaderboards · public hero search (the old *generated* name stops matching; the Telegram `@username` still does) · arena stage cards, **Current Round** list and the spectator strip — including a battle already in progress (its combat snapshot stays frozen so replays are reproducible; only the label is live) · Recent Winners · wallet-link challenge text.

Deliberately **not** renamed: the account chip / "Welcome, …" greeting in the header show the member's **Telegram** name (that is the signed-in identity, not the hero).

## 2. Admin → Heroes

Admin API (all behind the admin session; same-origin enforced for writes; every write audit-logged):

| Route | Purpose |
| --- | --- |
| `GET /api/admin/telegram/eligibility` | Configured qualifying-message minimum, eligible real Telegram users, real community heroes created, and eligible users without a hero. |
| `GET /api/admin/heroes` | `search` (RPG name, generated name, Telegram name, `@username`, Telegram id, hero id prefix; LIKE wildcards are literal), filters `claimed`, `class`, `rarity`, `kind`, `status`, `renamed`, `sort` (`newest` / `name` / `power`), `limit` (≤ 100) + `offset`. Unknown filter values are ignored, not trusted. |
| `GET /api/admin/heroes/:id` | Identity (the three kinds above), class, power, rarity, sprite config, record, Telegram activity, wallet, ownership, rename history (last 10 from the audit log), admin note. |
| `PUT /api/admin/heroes/:id/name` | `{ name }` or `{ name: null }` (reset). 422 `INVALID_NAME` with the reason. Same name → no-op, no audit noise. |
| `PUT /api/admin/heroes/:id/note` | Admin-only note, ≤ 500 characters, blank clears. |
| `PATCH /api/admin/heroes/:id` | Status (suspend/activate), grant achievement, remove claim. **Class, stats, XP, level and identity fields are refused here** — the class changes only through an audited reroll / rollback (a new hero version, see `HERO_VERSIONS.md`) and stays protected at the database level too. |

UI: `src/components/admin/HeroManager.tsx` (list with debounced search, pagination of 25, detail panel, rename form with live validation and a code-point counter, reset-to-generated, rename history, notes, moderation). Chips mark **renamed**, **fallback** (a `Wanderer ####` hero is a good rename candidate), **demo** and **special**.

Audit entries (`hero.rename`) record hero id, Telegram id, old/new name, previous/new override, whether it was a reset, and the timestamp. The admin console is one shared key, so the actor is `admin` and the entry says `operator: shared admin key (individual operator not identifiable)` rather than pretending otherwise (see *Known gaps* in `SECURITY.md`).

## 3. "Who becomes a hero?" (eligibility)

Player-facing copy lives in `src/content/heroEligibility.ts`; the state machine is the pure `src/domain/heroEligibility.ts`. Rules for the copy (enforced by `unit/hero-eligibility`): always "qualifying messages" and "official Clank.trade Telegram community"; never wording that invites sending N messages; high level only — no caps, rate limits, weights or any threshold other than the headline number. The number is the setting `telegram.qualifyingThreshold` (default 50), never hard-coded in the UI.

| Surface | What it shows |
| --- | --- |
| Arena, under the stage | "Who becomes a hero?" card + **Learn more** (native `<dialog>`: focus-trapped, Esc / backdrop / "Got it" close it, scrolls inside the viewport on small screens) |
| `/character`, signed out | "Become a Clank RPG hero" card (+ "Already have a hero? Sign in with Telegram to claim it.") |
| `/character`, signed in | A status card for the member's own state (below) |
| The hero page (`/character/<id>`), signed in as that hero's member | The **ownership block** in the identity panel instead of the card — see [HERO_PROFILE_UI.md](HERO_PROFILE_UI.md) |

| State | Trigger | Shown |
| --- | --- | --- |
| `SIGNED_OUT` | no session | explanation card only, no numbers |
| `NOT_YET` | verified count < threshold | "Not yet eligible", `N / threshold` + progress bar |
| `ELIGIBLE` | count ≥ threshold, no hero yet | "Hero eligible — your hero will be created automatically" |
| `HERO_FOUND` | hero exists, not claimed | "Hero found — claim it" |
| `CLAIMED` | hero claimed | "Your hero is claimed — Telegram identity verified" |
| `REVIEW` | member flagged | "Hero not available right now — activity is being reviewed" (never promises a hero, never shows a count) |
| `UNKNOWN` | no verified count available | "Signed in" + the rule; **no progress is ever invented** |

Numbers come only from the member's stored, server-verified `qualifying_message_count` via `/api/me` (`viewer.qualifyingMessages`, `viewer.threshold`, `viewer.status`); signed-out visitors get no member data at all.

## 4. Migration `20261005000800_hero_admin.sql`

Adds `characters.admin_note` (≤ 500), `name_changed_at`, `name_changed_by` (`ADMIN` | `PLAYER`) — all **nullable, no default** (metadata-only, no table rewrite) — plus the `characters_name_override_clean` check, then `select public.clank_harden_schema();`.

**Safe to apply** (verified 2026-10-05):

* Rehearsed on a populated database at migration 7: applies in one transaction, every existing row is byte-identical afterwards, new columns are `NULL` for existing heroes, the constraints bite (`tests/integration/migrate-options.test.ts`). If an existing `name_override` ever contained a control character the migration would roll back whole and leave nothing half-applied (also tested) — on live there are **0** such rows.
* Read-only preflight against live (Postgres-enforced `SET TRANSACTION READ ONLY`, rolled back): 7 migrations applied, `characters` = 70 rows / 176 kB, 0 `name_override` values at all, none of the new columns or the constraint exist yet, `clank_harden_schema()` present, no competing locks.
* Only admin code reads the new columns (`heroAdmin.ts`, `admin.ts`). Public pages, the arena and the leaderboard use `name_override`, which already exists — so deploying the code before the migration only breaks the **Admin → Heroes** tab, never player-facing pages. Still: apply the migration first.
* Rollback if ever needed (only after nothing writes to them): `alter table public.characters drop constraint characters_name_override_clean, drop column admin_note, drop column name_changed_at, drop column name_changed_by;`. Renames themselves live in `name_override` + the audit log and survive.

**Apply exactly this migration — and only this one** (see `OPERATIONS.md`): plain `pnpm db:migrate` applies *every* pending file (and seeds reference data), so another pending migration would ride along.

```bash
pnpm db:migrate -- --dry-run --up-to 20261005000800   # read-only: lists what WOULD be applied
pnpm db:migrate -- --up-to 20261005000800             # applies migration 800 only; later ones stay pending; no reference seeding
```

## 5. Verification

See the dated section at the bottom of this file.

### Known limitations

* The admin console is a single shared key — individual operators are not identifiable in the audit log.
* There is no player self-service rename yet; `name_changed_by = 'PLAYER'` is reserved for it and would need its own rate limits and review.
* Rename history is read from the append-only audit log (last 10 entries); there is no separate history table.
* Hero names generated from Telegram names are capped at 24 characters and have markup and ZWJ joiners stripped by the existing name generator; only admin renames can use the full 32 characters and ZWJ emoji sequences.

## Verification — 2026-10-05

Nothing was committed, pushed, deployed or applied to the live database. All browser work ran on an isolated server (embedded PGlite in a scratch directory, throwaway secrets, `DATABASE_URL` blanked). The only contact with live was **read-only**: `pnpm db:migrate -- --dry-run …` and a preflight inside Postgres-enforced `SET TRANSACTION READ ONLY`, rolled back.

| Check | Result |
| --- | --- |
| `pnpm build` (production) | ✅ passes, no warnings — 12 pages, 30 route entries (09:35 and again 10:07) |
| `pnpm typecheck` | ✅ clean |
| `pnpm test` before other work landed in the shared tree (09:36) | ✅ 473 / 473 (30 files) |
| Hero admin · RPG name · eligibility · identity · leaderboard · migration test files (9 files) | ✅ 116 / 116 |
| Added with this pass | 8 tests — `tests/integration/migrate-options.test.ts` (`--up-to`, `--dry-run`, migration 800 rehearsed on a populated migration-7 database) |
| `pnpm lint` (whole repo) | ✅ clean at 10:11 (two warnings in `src/domain/settings.ts` seen at 10:01 were another session's work in progress and are gone) |
| `pnpm test` on the whole shared tree at 10:11 | ⚠️ 569 / 573 — the 4 failures are all **arena** tests (`picks.test.ts › the reward is configurable…`, `arena-transition`, `arena-boundary-http`), in code and brand-new test files another Claude session was still changing; none are in hero admin, eligibility, identity, leaderboard or migrations. Re-run once that work is finished. |

**Visual QA** (Browser pane at 320, 375, 768, 1024 and 1440 px; signed out and signed in):

* Arena card, Learn more modal (Esc, backdrop and "Got it" close it; focus lands on "Got it"; scrolls inside the viewport at 320×568), `/character` cards, and **all seven** eligibility states: signed out, not yet (37/100, 49/50 → 98 %), eligible, hero found, claimed, under review, unknown (no progress invented — reached by making `/api/me` return no count in the page, since real data never produces it).
* Admin → Heroes: list, search (name, `@username`, ids), filters, pagination, detail, rename with live validation (markup, control/bidi/zero-width, empty, 33 characters, only symbols), reset-to-generated, history, notes.
* Names: a 100-character Telegram name, emoji-only (→ `Wanderer ####`), emoji mix, Arabic, CJK, combining-mark ("zalgo"), ZWJ emoji, an HTML-looking name (rendered as plain text, nothing injected), 32 × `W`. New names showed up in the admin list, hero page, owner page, leaderboard, public search, arena stage + Current Round (including mid-battle) and Recent Winners.

**Found and fixed during QA** (no behaviour change, class-only unless noted):

1. Hero page overflowed sideways on phones for a long unbroken name (706 px on a 375 px screen) — `HeroView.tsx` grid had no explicit mobile column.
2. Admin console was 1000 px wide on a phone — `AdminConsole.tsx` grid had no explicit mobile column.
3. Admin list: a long unbroken name spilled out of its cell; the "Hero · …" panel title pushed the page wider — `HeroManager.tsx`.
4. Admin → Open on a row far down the list put the detail panel entirely below the fold — it now scrolls into view (`HeroManager.tsx`).
5. The not-yet-eligible card repeated "Qualifying messages" as a label and in the value and wrapped awkwardly at 375 px — `EligibilityCards.tsx` (the pinned text "N / 50 qualifying messages" is unchanged).

**Remaining visual notes (none block release):** the admin hero table has ten columns, so below ~1100 px it scrolls horizontally inside its panel (the "Open" button is at the right end); on a 375 px phone a 32-character unbroken name wraps over four lines in that table. The Browser pane could not capture screenshots while hidden, so after the fixes layout was confirmed by measurement (page width equals viewport width on every page above) rather than by image.
