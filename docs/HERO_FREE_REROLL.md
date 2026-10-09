# Free daily hero reroll

> **Status (2026-10-09): shipped and OFF.** The code is on `master`; migration `20261009002500_hero_free_reroll.sql` **is applied to the live database** (additive: an empty table, three guards, an auditor — verified read-only afterwards:
> 0 rows, `audit_hero_free_rerolls()` and `audit_hero_versions()` both empty, RLS on, 139 heroes / 224 versions unchanged). The feature flag `hero.free_reroll` has **no row on live yet, which means disabled** (the reference seed adds it as disabled
> on its next run) — **nobody can reroll.** Read [§ 4](#4-fairness-what-one-free-reroll-a-day-does-to-the-game) **before** switching it on: the mechanics are safe, the *game-balance* effect of a free daily reroll is large and is the owner's decision.

One free reroll per member per **UTC calendar day**. The reroll replaces the member's hero's *generated state* (class, rarity, stats / PWR, look) with a fresh roll from the **same generator that creates
every hero** — same class odds, same rarity weights, same PWR bands. The hero keeps its id, owner, claim, Gold, items, achievements, record, Picks and rewards; the old state stays in the version history.

## 1. What was audited (and where the answers live)

| Question | Answer |
| --- | --- |
| Hero generation | `generateCharacter` (`src/domain/character/generate.ts`, **hero-gen/2**): class → rarity (`character.rarityWeights` **70 / 22 / 7 / 1**) → PWR position inside the rarity's band → stats fitted to that PWR → look. A reroll passes a server-chosen 128-bit `seedSalt`; nothing else differs from creating a hero. |
| Eligibility / claim / ownership | A member's hero is bound to their Telegram id (`characters.telegram_user_id`, immutable). The member is the **session's** member (`getViewer`); the hero is looked up from it — a request names neither. A reroll additionally needs the hero to be **claimed** (`character_claims`), exactly the "owner" the hero page already uses (`isOwner`). |
| Existing admin reroll | `previewReroll` / `applyRerollPreview` (`services/heroVersions.ts`): unlimited, admin-only, preview-then-apply. The member reroll **reuses its core** (`appendAndProject`, `assertNotInArena`): one transaction under the hero's row lock, append a version, move pointer + projection, recompute cached PWR. |
| Versioning | `hero_versions` is the authority (append-only, immutable); `characters.current_hero_version_id` is the pointer; class / stats / look columns are the projection, guarded by deferred triggers. A member reroll is a normal `REROLL` version whose `created_by` is `member:<telegram id>`. |
| Suspended / banned | A suspended or inactive hero, a flagged (under-review) member and a banned member (their session is dead) cannot reroll. The answer is the same plain sentence for all of them — never a reason. |
| Arena rosters / snapshots | A hero in any unsettled roster (`SCHEDULED` / `SIMULATED`: on stage, upcoming pick target, prepared) is **refused** (`HERO_IN_ARENA`, nothing consumed). Proven on real Postgres; see § 3. |
| Progression, Gold, inventory, achievements, ranks, season stats | All keyed by `characters.id` (or the member), none by version — see § 3. |
| Leaderboard boundaries / reward config | Daily = UTC day, Weekly = Monday UTC (`domain/rewards/time.ts`); pools and minimums from the `arena_picks` setting. The reroll touches none of it. |
| Migrations | Highest before this work: `20261008002400` (Arena Chat, live). New: **`20261009002500_hero_free_reroll.sql`** (forward-only; no applied migration was edited). |
| DB reliability protections | One transaction per request, hero row lock, pool-of-1 safe (no second connection inside the transaction), `guarded()` turns a database outage into a `503 DB_UNAVAILABLE` + `Retry-After`. |
| Other sessions / uncommitted work | At the start: other dev servers and scratch clusters from other sessions were running (ports 3830–3832, 5497/5498/5521/5531/5561) — none used; the working tree held only one uncommitted test fix. |

### Which hero attributes reroll, and which are immutable

| Changes under a reroll (the version's generated state) | Never changes |
| --- | --- |
| class · rarity · generated stats (HP STR DEF INT AGI CHA LUCK) · **PWR** · the look (skin, hair, eyes, mouth, accessory, cape, aura, hue) · the sprite layers (outfit / weapon / headgear of the class, rarity trim / pauldrons / crest / aura) · the appearance seed and the generation seed (internal) · `characters.power` (the cached effective PWR is recomputed) | hero id · public id (`/heroes/<id>`) · Telegram id / owner · kind · origin · RPG name · moderation status · claim · wallet link · profile photo · tactic · title · Gold · inventory · achievements · XP · career record · Season stats · Picks, Points, rewards, holder status · every historical battle and result |

Not versioned on purpose (unchanged from [`HERO_VERSIONS.md`](HERO_VERSIONS.md)): name, moderation, claims, wallets, photos, cosmetic overrides, wallet-derived stat components, gear, tactic.

## 2. How it works (server-authoritative)

```
POST /api/me/hero/reroll { requestId }              GET /api/me/hero/reroll  → status
  same-origin · signed Telegram session · flag on     DISABLED · UNAVAILABLE · AVAILABLE · USED (+ today's before/after) · BLOCKED
  ↓ one transaction
  1  lock the member's hero row (FOR UPDATE)          — every request of a member queues here
  2  same requestId already done?  → return that result (alreadyApplied) · key used elsewhere → 409
  3  eligible? claimed, ACTIVE, COMMUNITY, member not banned/flagged
  4  today's allowance unused?     (member, UTC day) → else 409 ALREADY_USED_TODAY
  5  hero in a committed roster?   → 409 HERO_IN_ARENA (nothing consumed)
  6  roll: generateCharacter(seedSalt = 128-bit CSPRNG) → validate (band, class, stats, PWR = power(stats))
  7  append REROLL version · move pointer + projection · recompute cached PWR
  8  insert hero_free_rerolls (member, UTC day, request key, version ids, before/after class·rarity·PWR)
  9  audit entry `hero.free_reroll` (actor `member:<id>`; no seed)
  ↓ commit — or roll back everything
```

* **The limit is a database constraint.** `hero_free_rerolls` has `PRIMARY KEY (telegram_user_id, utc_day)`: a second reroll for a member on the same UTC day **cannot be inserted**, whatever the application does. `utc_day` is
  derived from `created_at` by a CHECK. The browser's clock, timezone, tabs and replays decide nothing: the day is the **server's UTC** day, and the allowance is a **calendar** boundary — used at 23:50 UTC it is back at 00:00 UTC (a
  rolling 24 h cooldown would not be), proven with a millisecond-exact test.
* **A reroll and its allowance commit together.** A guard trigger refuses an allowance row that is not a real REROLL of that member's own hero (right version, key, direct successor, matching before/after figures); a
  **deferred constraint trigger** refuses a `member:*` hero version that has no allowance row at commit. An allowance cannot be spent without a reroll, a reroll cannot exist uncounted. `audit_hero_free_rerolls()` reports any
  violation (it must return no rows).
* **Idempotent.** The browser sends one UUID per confirmation. A retry (lost answer, double click, second tab) with the same key returns the same pair of before/after cards, built from the two *stored* versions, and writes nothing.
  A key already used by another member or another version → `409 REQUEST_CONFLICT`.
* **Invalid rolls never become versions.** The roll is validated (current generator, enabled class, PWR inside the rarity's band, PWR equal to the power of the stats, stats inside the generator's bounds, a drawable sprite);
  a bad roll aborts the transaction — `INVALID_ROLL`, nothing consumed.
* **Flag + readiness.** `hero.free_reroll` (Admin → feature flags) is **off** by default; off = `403 FREE_REROLL_DISABLED` for the POST and a plain "Free rerolls aren't open yet." for the panel. If the migration is not applied the
  status is `UNAVAILABLE` (the code can ship before the migration).
* **Courtesy rate limit** (12/min per member, 60/min per IP) answers a script hammering the endpoint with `429`; it is *not* the limit.

## 3. Historical records and the economy

Everything below is stored against the hero's **id** (or the member), never against a version, so a reroll cannot touch it. Tested byte-for-byte (`tests/integration/hero-free-reroll.test.ts`).

| | Policy |
| --- | --- |
| Past Arena battles, participants, **snapshots, event hashes, replays**, placements | **Persist, untouched.** Every battle carries its own frozen snapshot; a reroll reads and writes no arena table. Replays are re-run after rerolling participants and match. |
| Gold balance / ledger | **Persist** (`currency_accounts` / `currency_ledger`, keyed by hero id). |
| Inventory / equipped gear | **Persist.** Gear restricted to another class stays in the inventory (and stays flagged equipped) but does not apply to the new class — the inventory already marks it `usable: false`; nothing is deleted. The confirmation says so. |
| Achievements, XP, title, tactic | **Persist** (hero-level, not build-level). |
| Career record (`arena_battles / wins / top2 / eliminations / damage`) and **Season stats** | **Persist** with the hero. They are the hero's (and its owner's) results: resetting or archiving them on a reroll would rewrite leaderboards and Hero-Arena standings. A daily/weekly **frozen** board keeps the class and rarity the hero *had* when it froze (`hero_arena_results.class_id / rarity`), and a battle's frozen snapshot keeps its look. |
| Picks, Points, rewards, holder status, claims, wallet | **Persist** (member-level). A reroll never changes score, rank, prize or bonus. |
| Previously settled Picks, historical leaderboards, season archives | **Persist, untouched.** |
| Old hero configuration | **Archived** as a version in the history (`hero_versions`, append-only). There is no free undo — the member-facing feature cannot restore it; an admin rollback remains an audited operator action. |
| Hero **display** on live pages (hero card, directory, Picks rows) | Shows the **current** build. Boards that attach rarity at read time (Arena Picks rows) show the current rarity next to an old row — display only, existing behaviour for admin rerolls too. |

**Active / committed battles.** Policy **A — block while committed** (the simplest provably safe design): a hero in the on-stage, upcoming (pick target) or prepared roster cannot reroll; the panel says *"Your hero is lined up for a live
Arena fight. Try again once the upcoming fights have finished — your free reroll is still waiting."* and the refusal consumes nothing. The race between the Arena freezing a roster and a reroll is closed by the same lock
ordering as the admin tools (roster rows reference `characters`, so scheduling key-share-locks every fighter, which conflicts with the reroll's `FOR UPDATE`): **proven on real Postgres** with parallel connections and a
mutation check (`tests/integration/hero-free-reroll-postgres.test.ts`: removing the lock and the primary key makes four of the five tests fail).

## 4. Fairness: what one free reroll a day does to the game

`pnpm reroll:fairness` (read-only, no database) reproduces every number below: it draws heroes through the **real generator** and works the long run out exactly (cross-checked by a 40,000-member simulation, worst difference 0.37 pp).

**A reroll is exactly as fair as creating a hero.** 60,000 fresh-salt rolls: Common 69.8 % · Rare 22.2 % · Epic 6.9 % · Legendary 1.1 % (configured 70 / 22 / 7 / 1); **0** rolls outside their PWR band (130–149 · 150–169 · 170–189 · 190–209); the six classes 16.4–16.8 % each. Nothing is boosted, there is no pity, no hidden nerf, and a reroll can land lower as easily as higher.

**What a free reroll changes is the member's choice of when to stop.** A member who rerolls until they are happy has a ratchet that no single draw has:

| Keeps rerolling until… | one draw | expected rerolls | median | by day 7 | by day 30 | by day 90 | by day 365 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Rare or better | 30 % | 2.3 | 1 | 94.2 % | 100 % | 100 % | 100 % |
| **Epic or better** | 8 % | 11.5 | 8 | 48.7 % | **92.5 %** | 99.9 % | 100 % |
| **Legendary** | 1 % | **99** | 68 | 7.7 % | **26.8 %** | 59.9 % | **97.5 %** |

If *every* active member follows "stop at Legendary", the population drifts like this (today: 70 / 22 / 7 / 1 %, mean PWR 147):

| day | Common | Rare | Epic | Legendary | mean PWR |
| --- | --- | --- | --- | --- | --- |
| 7 | 65.2 % | 20.5 % | 6.5 % | 7.7 % | 150.6 |
| 30 | 51.8 % | 16.3 % | 5.2 % | **26.8 %** | 160.6 |
| 90 | 28.3 % | 8.9 % | 2.8 % | 59.9 % | 178.1 |
| 180 | 11.5 % | 3.6 % | 1.1 % | 83.8 % | 190.6 |
| 365 | 1.8 % | 0.6 % | 0.2 % | **97.5 %** | **197.9** (+34.6 %) |

"Stop at Epic or better" ends at 87.5 % Epic / 12.5 % Legendary by day 90 (mean PWR 181.6); "stop at Rare or better" at 73.3 / 23.3 / 3.3 (mean 165.2). Never rerolling, or rerolling every day whatever you hold, leaves the odds exactly as they are.

**What that does in the Arena** (real combat engine, 1,500 battles per mix; per-slot win share, fair share 12.5 %):

| mix | Common | Rare | Epic | Legendary | who wins the battle (C / R / E / L) |
| --- | --- | --- | --- | --- | --- |
| today 70/22/7/1 | 9.0 | 16.3 | 28.6 | 44.4 | 50.4 / 28.7 / 16.4 / 4.5 |
| everyone Epic+ at day 90 | – | – | 11.3 | 20.9 | 0 / 0 / 78.5 / 21.5 |
| everyone Legendary at day 30 | 5.4 | 10.6 | 14.7 | 26.8 | 22.3 / 13.3 / 6.2 / 58.2 |
| everyone Legendary at day 180 | 2.5 | 6.1 | 3.4 | 14.3 | 2.3 / 1.7 / 0.3 / **95.7** |
| everyone Legendary at day 365 | 2.3 | 1.3 | 0.0 | 12.8 | 0.3 / 0.1 / 0.0 / **99.6** |

(Rarities with almost no members are sparse in the simulation; read them as "badly outmatched", not as exact figures.)

**Reading.** The mechanics are sound; the *economy* is the issue. It is **not an unlimited loophole** (one draw a day, one hero per member, Telegram-verified) but it is a **convergence**: a patient member reaches Legendary in ~99 days on
average, a member who stops at Epic+ in ~12. Over a few months the rarity ladder compresses (Legendary stops being 1 %), mean PWR rises by a third, and a member who does *not* reroll becomes a weak minority — rerolling turns into a
daily chore. Because Daily/Weekly **Hero Arena** prizes follow the strongest heroes' wins, a daily-login advantage is converted into prize share.

**Recommended safeguards before production (none implemented — the flag stays off):**

1. **Do not enable it inside a competitive Season as is.** The simplest transparent safeguard: *builds lock when a Season starts*; free rerolls are allowed in development and between Seasons only. This keeps Season standings and prizes about play, not about a re-roll streak.
2. If a reroll *during* a Season is wanted: make it **weekly** (the ratchet is 7× slower: ≈ 41 % Legendary after a year, ≈ 66 % Epic+ after 12 weeks) or cap it **per Season** (e.g. 10), and show the remaining count.
3. Or add a transparent **keeper rule** ("an Epic or Legendary hero can't be free-rerolled") — it stops the churn at the top but makes the ratchet one-way; the owner should weigh that explicitly.
4. Decide on purpose whether "Legendary" should stay 1 %. If the reroll ships, the *effective* distribution will not be 1 %; either accept it, adjust the weights/bands (a visible rule change), or keep rerolls scarce.
5. Monitoring when enabled: `select * from audit_hero_free_rerolls()` (must be empty), a periodic rarity census, and the flag as the kill switch.

## 5. UI

* **Hero page (your own hero), left column → "Free hero reroll".** `AVAILABLE` ("1 available" + REROLL HERO) · `USED` ("Free reroll used", "Next free reroll in 23H 59M 59S", a *disabled* button) · `BLOCKED` (not claimed / in a live Arena fight / unavailable — the reason in a sentence) ·
  `DISABLED` ("Free rerolls aren't open yet.", no button) · `UNAVAILABLE` · loading / error with a retry. Never a clickable button that is not really available.
* **Confirmation ("Reroll your hero?").** Opens on click — it never rerolls by itself. Shows the *current* hero (art, name, class, rarity, PWR), the **warning** (lower rarity, lower PWR, different class and appearance; cannot be restored), what is
  kept, the odds (read from the server's settings), an **acknowledgement checkbox** that must be ticked, and **Cancel** / **Confirm reroll — "Uses today's free reroll"**. Native modal `<dialog>`: labelled, page inert, Cancel focused first, Tab wraps
  inside, Escape / backdrop close it before submission, scrolls inside the viewport (tested at 320×568).
* **Submitting.** One request per confirmation (a ref guard and the reducer both refuse a second one); "Rerolling…", Cancel and Escape ignored. **If the answer is lost** (network, timeout, database blip) the flow does **not** offer another attempt — it asks the
  server what happened and shows the result if *this* request committed, "nothing was used" if not, "already used today" if another tab did. Verified in a real browser, including a request that **commits on the server while its answer is dropped**.
* **Result ("Your new hero").** Only after the server confirmed. The new hero's art, "RARE WARRIOR", PWR, a ▲/▼ difference with the words *Stronger / Weaker / Same PWR*, an old-vs-new table, "Your old hero stays in your history. Today's free reroll is used." and **View my hero**. The page behind re-reads the hero (also when it was rerolled in
  another tab), so the old class / rarity / PWR never stays on screen as "current".
* **Countdown** (`src/components/time/ResetCountdown.tsx`, formatter `domain/time/resetCountdown.ts`): `23H 59M 59S` under a day, `06D 23H 59M` with days (Weekly). Anchored to the **server's** clock; when it reaches zero it only *asks the server* (and keeps asking every 2 s, bounded) — it never decides the allowance came back. One shared 250 ms ticker for every countdown on a page; a countdown re-renders only itself, once a second; no polling; identical text on server and client (no hydration mismatch). A tab that returns after a while, a page restored by Back and a connection that returns all re-read the status.

## 6. Arena rewards and Leaderboards (same change)

* **Arena → Picks panel** is a quick summary: two compact tiles — **Daily pool 100,000 $CLANKRPG** · **Weekly pool 500,000 $CLANKRPG** (amounts from `state.picks.reward`) — one link "Prize rules & countdowns →", then "Correct Pick = +10 Points" and "Free to play". Removed from the Arena: the TOP 10 banner, the reset countdown, the fine print, the launch note, the oversized medal/crown art and the animations. The block went from ~290 px to ~85 px.
* **Leaderboards** carry the detail: each Daily / Weekly board opens with a highlighted **countdown card** (*DAILY LEADERBOARD · ENDS IN · 23H 59M 59S*, *WEEKLY … 06D 23H 59M*) beside the pool; a finished period says **COMPLETED** with its date and frozen date (no timer); **Reward details** show both pools, who shares them, the qualification (20 / 100 valid Picks), the holder bonus and the token's launch status, all from the server's rules (`boardRules`; the Picks payload now carries `programme: { daily, weekly }`). The raw "00:00 UTC → 00:00 UTC" line is gone from primary text; exact timestamps are in a collapsed **Exact times** disclosure. Hero Arena and Hero Records boards use the same card. A **Season** countdown exists **only** if the database holds a real, upcoming end time for the active Season (`seasons.ends_at`, normally none today) — nothing is ever invented, and in the development run the Season view says *Development / Beta* with no timer.

## 7. Operations

```bash
pnpm reroll:fairness                      # the numbers in § 4 (read-only)
select * from public.audit_hero_free_rerolls();   -- must return no rows
select * from public.audit_hero_versions();       -- must return no rows
```

**Enabling (owner's decision, after § 4):** the migration is already applied on live — run both audits, then switch `hero.free_reroll` on in Admin → feature flags (if the row does not exist yet, run `pnpm db:seed:reference` first — it adds it as disabled — or create it from Admin). **Disabling:** switch it off — instant (2 s flag cache), nothing is lost. **Rollback of the schema** (only before any member reroll exists): `drop trigger hero_versions_member_reroll_allowance on public.hero_versions; drop table public.hero_free_rerolls; drop function public.audit_hero_free_rerolls(), public.check_member_reroll_has_allowance(), public.guard_hero_free_reroll_insert(), public.guard_hero_free_reroll_immutable();`.

## 8. Tests

`tests/unit/free-reroll.test.ts` (UTC boundaries, countdown formats, comparison, roll validation, the fairness maths and the generator's real odds) · `tests/unit/free-reroll-ui.test.ts` (every panel state, the confirmation, the result, the flow reducer, dialog structure) ·
`tests/unit/leaderboard-countdown-ui.test.ts` (countdown headers, completed state, reward details, season rule, the shared ticker) · `tests/unit/arena-prize-pools.test.ts` + `tests/integration/arena-picks-panel.test.ts` (compact tiles) ·
`tests/integration/hero-free-reroll.test.ts` (23: first reroll, one per UTC day, midnight, concurrency, retries, ownership, suspended/banned, Arena lock, historical battles, account assets, bad rolls, rollback, distribution) ·
`tests/integration/hero-free-reroll-postgres.test.ts` (real parallel connections; `CLANK_TEST_PG_URL`; 5, with a lock-and-key mutation check) · `tests/integration/hero-free-reroll-migration.test.ts` · `tests/security/hero-reroll-http.test.ts` (the route: flag, origin, session, strict body, replay, 429).
Real-browser QA (headless Chrome over CDP against a production build on a scratch Postgres): 51 + 82 checks and 39 screenshots — see the report; the QA scripts are not part of the repository.
