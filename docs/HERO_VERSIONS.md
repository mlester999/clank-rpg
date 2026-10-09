# Hero versions, admin rerolls, public heroes and the hero card

> Migration **`20261005001800_hero_versions.sql`** (NOT applied to live — apply it with the staged plan in [`RELEASE_PLAN.md`](RELEASE_PLAN.md)).
> Status: implemented and verified on scratch databases; nothing was committed, pushed, deployed or applied to live.

A hero is **one permanent person**: `characters.id`, `telegram_user_id`, the public hero id, the claim, picks, rewards, moderation and every historical
battle. What can change is only the hero's **generated RPG state** — class, rarity, the generated stat components and the look. That state is now an
immutable, append-only **history of versions**, and exactly one version is current.

```
v1 INITIAL    the hero exactly as it was created (for the existing heroes: a pure snapshot — nothing re-rolled, no new seed)
v2 REROLL     an admin-approved candidate from the SAME generator that creates new heroes
v3 REROLL
v4 REROLL
v5 ROLLBACK   an exact copy of v2 (source_version_id = v2) — appended; v3 and v4 are kept
v6 REROLL     history simply continues
```

## 1. Which representation is authoritative

| | what it is |
|---|---|
| **`hero_versions` + `characters.current_hero_version_id`** | **the source of truth.** One pointer column ⇒ exactly one current version; a composite foreign key `(current_hero_version_id, id) → hero_versions(id, character_id)` makes it impossible to point at another hero's version. |
| `characters.class_id`, `character_stats.{variation, telegram_bonus}`, `character_appearances.{rarity, parts, seed, sprite}` | the **materialised projection** of the current version. Every existing reader (combat, arena snapshots, leaderboards, the hero page) keeps reading these unchanged. They are written **only together with the pointer, in one transaction**. |
| `characters.power` | the cached **effective** POWER (generated stats + wallet / gear parts), exactly as before. A version's own `stats` / `power` are the **generated** figures (class base + variation + Telegram bonus, or the authored fixed stats); they are equal whenever a hero has no wallet or gear bonus (true for every hero today). |

**Split brain cannot be committed.** Deferred constraint triggers compare the projection with the current version *at commit* (`class`, `rarity`,
`appearance`, `seed`, `sprite`, `variation`, `telegram_bonus`) and abort the transaction on any difference; a deferred trigger also refuses to commit a hero
that has no current version. `public.audit_hero_versions()` reports any violation (it must return **zero rows**): no current version, no INITIAL, version
numbers not 1..n, the current version not the latest, or a projection mismatch.

Not versioned on purpose: name / `name_override` (presentation), moderation status, claims, wallets, profile photos, `cosmetic_overrides`, wallet-derived
stat components (holdings / loyalty / trading), gear, tactic.

### The `hero_versions` row

`id` · `character_id` · `version_number` (unique per hero, 1..n) · `action` (`INITIAL` / `REROLL` / `ROLLBACK`) · `source_version_id` (ROLLBACK: the version
restored) · `previous_version_id` (the version that was current just before) · `request_id` (idempotency key; unique) · `generation_seed` (**internal**, never sent
to a browser) · `generator_version` (`hero-gen/1`) · `class_id` · `rarity` · `variation` · `telegram_bonus` · `stats` · `power` · `appearance_seed` · `appearance` ·
`sprite` (NULL = legacy hero, derived from `appearance` when drawn) · `render` (sprite set) · `created_at` · `created_by`. CHECKs tie the shape together:
`INITIAL ⇔ version_number = 1 ⇔ no previous version ⇔ no request_id`, `ROLLBACK ⇔ source_version_id`. A partial unique index allows exactly **one INITIAL per hero**.
Updates are rejected by a trigger; deleting a version is only possible as the cascade of deleting the whole hero.

## 2. The existing 70 heroes → v1 (the migration)

`hero_snapshot_initial_version(character_id)` copies class, rarity, seed, components, `parts` and `sprite` **verbatim**, and computes only the two summary figures
(`stats`, `power`) with the application's exact arithmetic (IEEE doubles, same addition order, round-half-up). The backfill runs for **every** hero — active,
suspended, renamed, special, demo — because moderation is a separate dimension. `characters.updated_at` is not bumped (the trigger is disabled around the two
backfill statements), so every pre-existing column of every pre-existing row is **byte-identical** before and after — asserted over 301 heroes in
`tests/integration/hero-versions-migration.test.ts`, together with SQL ≙ TypeScript parity of `stats` / `power` for every hero (including fixed-stat specials) and with
the cached `characters.power`. The function is idempotent (returns the existing v1; a second INITIAL is impossible).

## 3. Every new hero gets v1 atomically

`createCharacterForUser` (webhook, historical import, guarded backfill, demo seed) inserts the character, its stats, its appearance **and** the INITIAL v1
(storing the *full* HMAC seed the generator derived — never a new one), then sets the pointer — in one transaction (it opens one itself if handed a bare
database). Special (admin-authored) characters go through the same step. The database refuses to commit a hero without a current version, so a creation path that
forgets it fails instead of leaving an orphan (tested: a forced failure of the version insert leaves no character, stats or appearance row behind).

## 4. Admin reroll — preview, then apply

*Admin → Heroes → open a hero → "Hero card & versions".* Admin only (the admin session plus a same-origin check on every mutation). **Unlimited**: no token cost,
cooldown, daily limit or cap (asserted: 25 applied rerolls in a row with the clock frozen).

1. **Reroll hero** → `POST /api/admin/heroes/:id/reroll/preview` (body `{}`; anything else is refused). The server draws a 128-bit random nonce, runs
   `generateCharacter` with it (`seedSalt`) — the **same** generator, class odds, rarity weights and bounds as a brand-new hero; nothing is boosted and there is no
   admin-only rarity logic — and stores the candidate in `hero_reroll_previews` (not a version; expires after 30 minutes). The response shows **CURRENT vs NEW**
   cards plus a table of class · rarity · POWER · HP STR DEF INT AGI CHA LUCK. The hero is untouched. *Reroll again* is simply another preview; previews write no
   version and no audit entry.
2. **Apply this reroll** → `POST …/reroll/apply {previewId}`. Inside one transaction it takes the hero's row lock, loads the stored candidate (never anything the
   browser sent, no second roll), refuses if the preview is expired / stale / foreign / the hero is in an unsettled Arena roster, appends the REROLL version, moves the
   pointer **and** the projection, recomputes the cached POWER, marks the preview applied and writes the audit entry.
3. A **double click**, a retry or a parallel request for the same preview returns the same version (`alreadyApplied: true`); a second preview of the same base is
   **STALE** (409); an expired one is 410. Exactly one committed transition per base version.

**Rarity is a strength tier (hero generator 2, 2026-10-06 — this REPLACES the earlier "rarity stays cosmetic" rule; see [`RARITY_POWER.md`](RARITY_POWER.md)).** A reroll draws class, rarity,
stat budget, stats, PWR and look from ONE roll of the same generator that creates new heroes: the rarity (production odds 70 / 22 / 7 / 1 %, unchanged, nothing boosted) fixes the PWR band,
the class spends the budget, the seed picks the spot inside the band. So a reroll can land HIGHER or LOWER (Common→Epic, Epic→Common, Rare→Legendary …); every candidate's PWR is inside its
rarity's band and equals `computeHeroPower(stats)` (asserted on every one of the 25 applied rerolls, and over 6,000 rolls per rarity). The preview shows PWR current → new with the change.

**Generator versions and the rebalance.** Every version records the generator that drew it: `hero-gen/1` (the first generator, rarity was only a look) and `hero-gen/2` (rarity power). Old
versions are never re-interpreted. `SYSTEM_REBALANCE` is a fourth action: the deterministic, system-made move of an EXISTING `hero-gen/1` hero onto the rarity power system — same hero, owner,
public URL, class, RARITY and identity; stats/PWR fitted into the rarity's band; rarity layers added; appended as a new version (`scripts/rebalance-heroes.ts`, migration `…001900`). v1 stays
byte-for-byte untouched and remains viewable, but a `hero-gen/1` version cannot be ROLLED BACK to (its stats were never fitted to a band): `LEGACY_VERSION` / 422.

Special (hand-authored) characters cannot be rerolled (they have fixed stats and no Telegram member).

**Member rerolls (behind a feature flag).** The same `REROLL` version can also be made by the hero's own member, once per UTC day — `created_by = 'member:<telegram id>'`, one `hero_free_rerolls` row per use, same generator, same Arena protection. The admin reroll stays unlimited and audited; see [`HERO_FREE_REROLL.md`](HERO_FREE_REROLL.md).

## 5. History and rollback

*History* lists every version newest first: version, action, date, class, rarity, POWER and its relation (`from vN` / `restores vN`), with **Preview** (draws any old
version as a card, read-only) and **Roll back**. `POST …/rollback {versionId, expectedCurrentVersionId, requestId}`: under the same hero lock it appends a ROLLBACK version
that is an exact copy of the target (`source_version_id`), keeps everything newer, and refuses a stale screen (`expectedCurrentVersionId`), restoring the current
version, an unknown / foreign version and a request key reused for something else. A retry with the same `requestId` returns the same version.

## 6. Arena safety

A hero in **any unsettled roster** — `SCHEDULED` or `SIMULATED` battles: the battle on stage, the **upcoming** pick target and the next prepared battle (the Arena keeps
two ahead) — cannot be rerolled or rolled back. Apply / Roll back answer 409 `HERO_IN_ARENA` with *"Hero is currently queued in a live Arena fight. Try again after the
prepared battle cycle completes."*, and the console disables the buttons and shows the same message. Preview stays allowed. Once those battles settle, the hero is free.

**Why a race cannot slip through:** the roster rows reference `characters`, so scheduling a battle takes a key-share lock on every fighter's row, which conflicts with the
`FOR UPDATE` that every version change takes first. The two serialise on the hero's row: whichever commits second sees the other (the admin check refuses a rostered
hero; a roster is never built around a hero whose change is still in flight). This is **proven on real Postgres** (`tests/integration/hero-versions-postgres.test.ts`: 16 + 4 parallel connections,
a slowed admin transaction, up to 30 rounds — thousands of applies and hundreds of correct refusals, zero torn snapshots, zero deadlocks) and the suite is sensitive: with
that foreign key dropped (`RACE_MUTATION=drop-fk`) the invariant fails immediately (`class: expected 'ranger' to be 'tank'`).

**Historical battles are untouched.** Every battle carries its own frozen snapshot (units + display) and ruleset hash; nothing here reads or writes arena tables.
Tests reroll participants after a battle and assert snapshot JSON, events hash, replay result, winner / runner-up, result and placements are byte-identical. The public
"recent winners" strip used to read the winner's **live** class and look; it now reads the frozen snapshot, so a later reroll cannot rewrite how an old win is shown.

## 7. Public heroes

* **Stable public id** `characters.public_id`: 12 random symbols from a 31-symbol alphabet (no `0 1 i l o`), minted by the database, unique, immutable (trigger).
  It is never derived from the name, the Telegram id or a sequence, so rename / reroll / rollback / a duplicate display name never change or collide with a URL.
  Existing heroes received theirs in the migration.
* **`/heroes`** — the directory: active, public heroes as cards (portrait, name, class, rarity, POWER), filters by class and rarity, name search, sort, paging
  (24 per page). Server-rendered; no marketplace features.
* **`/heroes/<publicId>`** — the profile: the card, Season rank, Arena record, Arena Picks counts, recent fights (placement / KOs only, no battle ids), and the actions.
* **Visibility** follows the rules the Arena and the boards already use: `ACTIVE` hero, member not `BANNED` (demo heroes only where demo heroes are allowed). Suspended /
  inactive / banned / unknown / malformed ids are the **same plain 404** (page and image) — the reason is never revealed, and version history is never deleted.
* **Clickable identity:** Daily / Weekly Arena Picks boards, the stat leaderboards, the arena's fighters / results / spectator strip / recent winners / pick list, the Recent
  picks table and the hero search all link to `/heroes/<publicId>`. The owner's `/character` page keeps its management features and links to its public card.
* **Privacy:** the card model and every public query select named fields only. Asserted: no Telegram id / username, database id, seed, flag reason, admin note, wallet or
  moderation word appears anywhere in the serialised profile or directory, and the profile has exactly the whitelisted keys.

## 8. The hero card (one model, five surfaces)

`HeroCardModel` (`src/domain/hero/card.ts`) is the single public-safe data model: public id, name, class, rarity, POWER, the seven effective stats (`HP STR DEF INT AGI CHA LUCK`),
season rank and the resolved look. It feeds the React `HeroCard` (Admin preview, profile) / `HeroCardCompact` (directory), the **PNG** and the **Open Graph** metadata.
The card shows the hero's GENERATED stats and its PWR (the power of exactly those stats) — gear and wallet bonuses change how a hero fights, never the card. Rarity dresses the card from the one shared
`RARITY_VISUALS` table (frame style, corner ornaments, glow, badge shape); the hero stands in the rarity's **arena image** (§ 8a) and PWR is one of its largest elements. The PWR band
(130–149 …) is a game rule, not card copy: it is not printed on a card.

* **Download card** → `/api/hero-cards/<publicId>?v=<key>&download=1`: a **1200 × 1200 PNG** of the *current* version, drawn server-side with `@napi-rs/canvas` from the card model, the
  arena's own sprite set (`public/sprites/<set>` through the same compositor) and Next's bundled UI font (Geist). Reproducible byte for byte (the looping aura is pinned to a
  frame). Text is painted with canvas calls — a name can inject nothing. It contains branding, name, art, rarity, class, POWER and stats, and **no** Telegram id, internal id, seed,
  moderation or wallet data. Admin gets the same image for any hero at `/api/admin/heroes/:id/card-image` (public visibility does not apply there).
* **Share to X** → `https://x.com/intent/post?text=…&url=<canonical hero URL>` with `My Clank RPG hero / <Name> / <Rarity> <Class> / POWER <n>`. A web intent **cannot attach
  the image** (and the UI says so): download the card and attach it by hand. No X API credentials are involved.
* **Copy link** → the same canonical URL (`NEXT_PUBLIC_APP_URL` + `/heroes/<publicId>`), with a clipboard fallback.
* **Open Graph / Twitter:** title `Marky's Legendary Mage | Clank RPG`, description (class, rarity, POWER, stats), canonical URL, a 1200 × 1200 image URL carrying the card's
  **content key** (a short hash of everything shown). A reroll, rollback or rename changes the key, so a stale image / social card is never reused: an image whose key matches is
  served `immutable`; any other key gets the current picture with no long-term caching; `ETag` / 304 supported.
* **Known limitation:** the PNG font covers Latin scripts. Characters outside Latin / punctuation (emoji, CJK, Cyrillic …) are dropped from the *image* name (a name with nothing
  drawable reads "Clank Hero"); the web page always shows the real name.

### 8a. The card's arena (rarity backgrounds)

`public/hero-card-backgrounds/{common,rare,epic,legendary}.webp` are the four uploaded arena images, used **as uploaded** (square, 1254 × 1254, never processed — the files carry
transparency outside the arena ring, and the card's rarity backdrop sits under them). `src/domain/hero/cardBackground.ts` is the ONE map: `getHeroCardBackground(rarity)` →
`/hero-card-backgrounds/<file>` (or `null` for a missing / unknown rarity → the neutral rarity backdrop), plus `heroArenaLayout()` — the maths that fits the image with "cover" (filled and
cropped, never stretched) and puts the hero in it: a small figure (≈ 26% of the arena's width), centred, feet on the floor, well inside the rim. The web card (`HeroArena`, a square frame; the
canvas is redrawn at the frame's real size so the pixel art stays crisp), the directory tile (hero ×1.4 for the thumbnail), the character page and the server-rendered PNG all use them, so
the Admin reroll preview (CURRENT and NEW each with their own arena), the rollback preview (the OLD version's rarity, not the current one), the public profile and the downloadable card cannot
disagree. Mapping: Common → image 1 (natural stone, no magic), Rare → 2 (blue / cyan runes), Epic → 4 (purple crystals, gold trim), Legendary → 3 (the most ornate, gold + purple).
The server function ships the images (`outputFileTracingIncludes`) and the browser caches them for a day (`next.config.ts`). Tests: `tests/unit/hero-card-arena.test.ts`, `tests/integration/hero-card-png.test.ts`.

## 9. Two numbers that are easy to confuse

* **TOTAL heroes vs ARENA-ELIGIBLE heroes.** A suspended hero exists (it keeps its history, its public id and its versions) but is not queued and has no public page. After the guarded
  backfill the total is 70 + 69 = **139**; the arena-eligible number is 139 minus every hero a moderator suspended or whose member is banned (live today: 18 suspended → **121**). Admin → Overview
  shows both, and the scratch proof reports both (and asserts that every non-eligible hero is an *existing* one — a newly created hero is always eligible).
* **Cached `characters.power` vs the POWER a hero fights with.** The cache is refreshed only by some events and is **stale on live today** (70 of 70 heroes, +2…+9, see `RELEASE_PLAN.md` Stage E2). A version's `stats` / `power`
  are computed from the stored components, the public pages (profile, card, directory, Open Graph) show the freshly computed figure, and the directory sorts by the version's POWER — so a tile never disagrees with its profile.

## 10. Cache invalidation

Admin detail and public pages are `force-dynamic` (always current). Rendered PNGs are cached in memory under `<publicId>:<content key>` and are dropped after a reroll /
rollback (memory hygiene — correctness already comes from the key). The OG image URL carries the key. There is no other hero summary cache.

## 11. Operations

* `select * from public.audit_hero_versions();` → must return **no rows** (run it after Stage E and after any incident).
* Admin overview shows **heroes (total)**, **arena-eligible heroes** (active, member not banned) and **hero versions** — three different numbers; a suspended hero is not "missing".
* `@napi-rs/canvas` is now a runtime dependency; `next.config.ts` lists it in `serverExternalPackages` and traces `public/sprites/**` + the font for the image routes.
* `CLASS_ROLL_SECRET` must be the production value for rerolls too (it keys the derived seeds); it never leaves the server.

## 12. Tests

`hero-versions-rollback-sql` (the documented back-out SQL and the optional POWER refresh SQL, executed from `RELEASE_PLAN.md`, 3) · `hero-versions-migration` (live-shaped migration, 14) · `hero-versions` (creation atomicity, preview / apply / rollback, 25 rerolls, rarity, arena protection, replay, 26) ·
`public-heroes` (ids, visibility, privacy, directory, PNG, 13) · `hero-versions-http` (admin routes, public image route, pages, OG, links, 13) · `hero-card` (unit, 13) ·
`arena-queue-139` (4) · `hero-versions-postgres` (real concurrency; runs only with `CLANK_TEST_PG_URL`, 4) · the scratch 70 → 139 scenario in `telegram-backfill` (and in
`pnpm telegram:backfill-heroes -- --scratch-check`, which now also proves every hero has exactly one INITIAL v1).
