# Rarity is a real strength tier — hero generator 2

> **Decision (2026-10-06, owner):** *higher rarity = higher power potential.* This **supersedes** the earlier rule "rarity is cosmetic only". Rarity is now a gameplay
> strength tier AND a visual prestige tier. It still does **not** guarantee a win, and it still touches **nothing outside the hero** (Arena Pick Points, leaderboard
> ranks and prizes, the holder bonus, claims and wallets all ignore it — asserted in tests).
>
> Status: implemented and verified on scratch databases and in a local browser. **Nothing was committed, pushed, deployed or applied to live; no live data was changed;
> no live worker or webhook was started.** The staged live release is in [`RELEASE_PLAN.md`](RELEASE_PLAN.md) (Stage E3).

## 1. The final bands

One authoritative table: `RARITY_RULES` in [`src/domain/hero/rarity.ts`](../src/domain/hero/rarity.ts). Everything that needs a band, a stat budget or a tier — the generator, the rebalance, the
audits, the hero card, the Admin console, the public docs — reads it; no number is repeated anywhere else (a test scans the docs pages for hard-coded copies).

| Rarity | PWR band | Stat budget (× class baseline) | Odds (unchanged) | Visual tier |
| --- | --- | --- | --- | --- |
| Common | **130 – 149** | 0.93 – 1.06 | 70 % | 0 |
| Rare | **150 – 169** | 1.07 – 1.21 | 22 % | 1 |
| Epic | **170 – 189** | 1.21 – 1.35 | 7 % | 2 |
| Legendary | **190 – 209** | 1.36 – 1.49 | 1 % | 3 |

The bands are contiguous and **do not overlap** (highest Common 149 < lowest Rare 150 < …), asserted over 12,000 deterministic samples and over the 139-hero scratch population.
The rarity odds are the *same weights the first generator used* (700 / 220 / 70 / 10): nothing was boosted, there is no pity and no admin boost (a test draws 20,000 heroes and
checks the odds, and that the same seed gives the same class and rarity under both generators).

### Why these numbers (audit first, as asked)

The earlier run of this work chose the bands; I re-derived and re-checked them against the real generator before keeping them.

* **The 70 existing heroes under the OLD formula** (read from LIVE through read-only transactions, replayed into a scratch database): PWR **min 131 · p25 138 · median 151 · p75 158 · p90 162 · max 167**.
  By rarity: Common 51 heroes (131–167, median 151) · Rare 15 · Epic 4 · Legendary 0. By class: Rogue mean 161.6, Tank 156.5, Warrior 154.7 versus Mage 136.5, Ranger 137.9, Cleric 141.3 — **the old
  formula was ~25 points class-uneven** (it rated raw HP/STR, not strength), which is why PWR needed calibrating (§2).
* **The projected 69 new heroes** were drawn with the new generator: Common 54 · Rare 7 · Epic 8 · Legendary 0 (PWR 131–185).
* The old population sat at 131–167 around a median of ~150. The new Common band (130–149) brackets "an ordinary hero as it is today", every class's own baseline hero (stat budget 1.0) reads
  133–147 (inside Common), and each step up is +20 PWR (≈ +14 % stats). Legendary tops out at 209 = about 1.5× a baseline hero. That is the gradient the simulation (§6) shows is *clear but not
  automatic*: a bigger spread (the sketch in the brief, 100–230) makes a Legendary win almost every battle; a narrower one makes rarity unreadable.

## 2. PWR comes from the real stats

`computeHeroPower(stats, class)` in [`src/domain/hero/power.ts`](../src/domain/hero/power.ts) is the only PWR formula (`POWER_FORMULA_VERSION` 2):

```
PWR = round( classFactor × (0.4·HP + 2·STR + 2·DEF + 2·INT + 2·AGI + 1·CHA + 1·LUCK) )
```

* Computed **server-side from the hero's generated stats**. A browser never sends one and an arbitrary PWR is never stored: a version's `power` is always `computeHeroPower(its stats)`.
* **Class factors** (frozen constants) calibrate the classes against each other so that **equal PWR means equal expected strength whichever class carries it** — that is what stops Tank / Cleric
  from being rated below their worth and keeps every class competitive in every rarity. They were fitted with the real combat engine; `pnpm rarity:calibrate` reproduces the fit
  (**five independent 20,000-battle rounds, all eight slots one rarity: the six classes' win rates stayed within 0.4–1.2 points of each other** — the shipped constants are already inside the
  noise floor, so they were kept; the tool's suggestions were all < 1 %). A unit test fails if the shipped class baselines ever drift away from what the factors were calibrated for.
* A class's *baseline hero* reads `140 / CLASS_STRENGTH_SCALE` (133–147): the six baselines are not equally strong, and PWR measures strength, not "points spent".
* **PWR excludes wallet bonuses and gear.** They change how a hero *fights* (`Fighter.stats`) but never its PWR (`Fighter.generatedStats` is the exact block PWR is computed from, and the card shows it),
  so a rarity band always agrees with the number on the card, and token holdings never affect hero power.

## 3. Stat budget (rarity → budget, class → distribution, seed → variation)

[`src/domain/hero/statBudget.ts`](../src/domain/hero/statBudget.ts): the seed picks a position inside the rarity's band (uniform, with a bounded lean towards Telegram activity — the old activity bonus, now a nudge
*inside* the tier that can never move a hero out of it); the target PWR is `powerAtPosition(rarity, position)`; the class's own stat **shape** (what the class is good at) is scaled to that PWR with the seed's small
bounded shape variation (`rollVariation`, unchanged) and `fitStatsToPower` nudges single stat points until the integer stats read **exactly** that PWR. **Stats, PWR and rarity agree by construction — nothing is
clamped afterwards.** A Legendary Mage is INT-led, a Legendary Warrior STR/HP-led, a Legendary Tank HP/DEF-led, and no two heroes are identical (asserted).

Generator versions: `hero-gen/1` (the first generator; rarity was a look only) and **`hero-gen/2`** (this one, "hero generator 2.0.0"). Every version stores the generator that drew it; old versions are
never re-interpreted under new rules and are never restorable by rollback (their stats were never fitted to a band) — they stay viewable.

## 4. Reroll, rebalance and history

* **Admin reroll** is one fresh draw from the same generator: rarity, class, stat budget, stats, PWR, look and rarity layers come from the *same roll*, with the production odds. It can land higher *or* lower
  (Rare→Common, Common→Rare, Epic→Common, …). Nothing is boosted and there is no guaranteed upgrade. The preview makes the difference obvious: **PWR current → new in the largest type on screen, a ▲/▼ change, the
  rarity and class change, side-by-side cards, a stat table.** Apply turns *exactly* the previewed candidate into the next version; rollback restores an older rarity-power version exactly. (Verified in a real browser:
  Rare 164 → Common 143 `▼ −21 Weaker`; Common 133 → Rare 153 `▲ +20 Stronger`; apply → v2; rollback → v3 = v1's class, rarity, PWR and stats.)
* **Existing heroes — `SYSTEM_REBALANCE`** (migration …1900 + [`scripts/rebalance-heroes.ts`](../scripts/rebalance-heroes.ts), pure rule in [`rebalance.ts`](../src/domain/hero/rebalance.ts)). Each `hero-gen/1` hero gets ONE appended version:
  **kept** — the hero, owner, public URL, class, **rarity**, seed, face / hair / colours; **changed** — stats and PWR: the class shape is rescaled to the hero's *own* rarity band, and where in the band it lands follows its old
  *standing among class peers* (`standingPosition`: 80 % how far its old stats sat above the class baseline, 20 % its own seed) so a hero that was strong for its class stays strong for its rarity; its small stat-shape
  variation is carried over; **added** — the rarity visual layers, chosen by the same seed-and-rarity rule new heroes use. It is deterministic (run it twice, anywhere, get identical bytes), idempotent, and **never random**:
  it does not re-roll rarity, class or identity. v1 is untouched byte-for-byte.
* **Historical Arena results are never rewritten.** The rebalance reads and writes no arena table; settled battles' snapshots, event hashes, winners and placements are byte-identical afterwards and replays reproduce
  exactly (integration test); heroes in an unsettled roster are refused (`HERO_IN_ARENA`) so prepared rosters stay authoritative; only *future* battles use the new current version.
* **The scratch proof on the real 70** (their stored rows replayed into an isolated database, then the live-order release run: migrations → backfill the 69 → rebalance the 70): attempted/rebalanced/deferred 70/70/0 ·
  every hero has a `SYSTEM_REBALANCE` v2 · v1 rows changed 0 · class/rarity/identity changed 0 · a second run created 0 versions · all 139 on `hero-gen/2` · invalid PWR 0 · outside band 0 · missing sprite layers 0 ·
  `audit_hero_rarity_power()` = 0 rows. Result: Common 105 (131–147) · Rare 22 (151–165) · Epic 12 (174–185) · Legendary 0. Re-run any time, read-only:
  `pnpm telegram:backfill-heroes -- --preview-shipped-threshold --scratch-check --exclude-ids 5530802189`.

## 5. The visual system

One table, [`RARITY_VISUALS`](../src/domain/hero/rarityVisuals.ts), feeds the hero card, public profile, Admin, directory, upcoming Picks, leaderboard rows, portrait frames, the Arena effects, the downloadable PNG and the social
(Open Graph) image. **Rarity is never colour alone** — every tier differs in shape and intensity too.

| | Badge | Frame | Arena ground | Outline / glow | Particles | Sprite layers |
| --- | --- | --- | --- | --- | --- | --- |
| Common | ● dot | plain | 1 thin ring | none | none | none — clean |
| Rare | ◆ diamond | bevelled + notch corners, soft glow | ring + inner arc | solid, faint | none | trim + weapon glint, light aura |
| Epic | ✦ star | double frame + gem corners, woven backdrop | 2 rings + 6 rune ticks | dashed | 6 rising **diamond** sparks | + pauldrons, weapon glow, a crest half the time, spark aura |
| Legendary | ♛ crown | ornate crowned frame, gold glow | 3 rings + 10 rune ticks | solid double | 12 rising **round** embers | all four layers + cape + gold accessory, flame aura |

* **Class identity stays:** rarity layers are mapped class-aware onto the class's own body / weapon / headgear and only *add*; a Legendary Ranger is still unmistakably a Ranger (tested over 120 heroes: its silhouette is closer
  to its own Common than to any other class).
* **24 class × rarity combinations** × 5 seeds are checked (`tests/unit/rarity-sprite-assets.test.ts`, 100 tests): every layer resolves, nothing is missing, the weapon / outfit / headgear are always there, the tier's layers are
  *visible* (changed pixels in the 80×64 idle frame, measured: Common 0 · Rare 27–112 · Epic 167–331 · Legendary 283–398), nothing underneath is erased, the aura is a separate layer behind the hero (it cannot cover a face),
  and idle / attack / KO frames read at battle size.
* **The Arena shows NO rarity text.** Rarity appears as a ground ring, a body glow + outline, rising particles, and on the name plate as a rarity-coloured edge and a small tier *shape* (never a label). Effects are a pure
  function of the clock, drawn after and independently of the simulation (the engine imports none of it), allocate nothing per frame, use no blur filters, and respect `prefers-reduced-motion` (static ring, glow and outline;
  no particles, no pulse). Tests: no `fillText` anywhere in the effects, bounded draw calls (≈ 100 per hero), deterministic, reduced-motion still, knocked-out heroes draw nothing.
* **PWR emphasis:** `PwrValue` is the largest number on the hero card (up to 72 px), the directory tile, the upcoming-Picks row, the Admin list and the reroll banner. The card hierarchy is art (the hero in its arena) → name → rarity + class → PWR → stats; the band is not printed on a card.
* **Share card (1200 × 1200 PNG)** is drawn from the same table plus the rarity's arena image: tiered frame layers, corner ornaments, the hero small in its arena, badge with the tier shape, a big glowing PWR.
  Byte-stable (rendered twice, identical).

## 6. Balance simulation (the real combat engine)

`pnpm rarity:sim` draws fighters exactly as generator 2 does and fights them with the real engine (combat rules 3.0.0, 60 s cap). Four scenarios × **10,000 battles** (80,000 fighters each):

| Scenario | Win % per slot (fair share = 12.5 %) | Notes |
| --- | --- | --- |
| **Uniform** (every slot a random rarity) | Common **4.9** · Rare **8.3** · Epic **14.1** · Legendary **22.8** | avg placement 5.25 / 4.77 / 4.26 / 3.72; who wins the battle: C 9.7 % · R 16.5 % · E 28.1 % · L 45.7 % |
| **Head-to-head** (higher rarity out-places lower, uniform) | L>C **70.8 %** · L>E 58.4 % · L>R 65.5 % · E>C 64.6 % · E>R 57.7 % · R>C 57.3 % | a lower rarity wins 29–43 % of the meetings |
| **Production mix** (70/22/7/1) | Common 9.2 · Rare 16.9 · Epic 27.3 · Legendary 42.4 | the live arena: Commons still take 51.8 % of battles |
| **Per-rarity** (all eight the same rarity) | every class **11.0 – 14.6 %** in every rarity | no class is useless or dominant inside any rarity |
| **Duel** (1 hero vs 7 Commons) | Legendary **51.8 %** · Epic 37.0 · Rare 22.3 · Common 10.0 | Legendary is strong, not automatic: the 7 Commons together still win ~half |

* **Timing is unchanged:** median fight **37.8 – 38.3 s**, p90 48.4 – 49.4 s, p95 52.9 – 53.7 s, time-limit 2.6 – 3.5 % in every scenario (target 35–45 s, cap 60 s).
* **Legendary automatic-win problem: no.** **Class × rarity anomaly (disclosed):** in a mixed field the classes do not scale identically — a Legendary Tank wins 26.6 % per slot and a Legendary Cleric 24.9 % versus a Legendary
  Ranger 19.5 % / Mage 19.9 % (uniform); in the 1-vs-7-Commons duel a Legendary Tank wins 63.9 % and a Ranger 38.3 %. High-DEF / high-HP heroes gain most from out-classing weak opposition (defence has diminishing returns
  but a Common's damage is far below a Legendary's DEF), ranged kiters least. It is inherent to the damage model, not to the stat budget (with every fighter on the same PWR every class sits at ~12.5 %), every class still
  rises monotonically with rarity (a Legendary of *any* class is a real contender, ≥ 19.5 % per slot), and a single per-class factor cannot equalise both views, so it was left as the measured class identity rather than
  hidden. Tank-vs-Ranger scaling is the first thing to tune if it needs to change.
* `tests/unit/rarity-balance.test.ts` re-runs a smaller simulation on every `pnpm test` and fails if any of these properties break; it also checks the one *measured* number the public docs quote.

## 7. Performance (Arena)

* **Frame stability, real browser, worst case** (an arena where every fighter is Legendary, every battle; 30 s of `requestAnimationFrame` intervals): **p50 16.7 ms · p95 16.9 ms · p99 18.6 ms** (56 fps average including one
  ~1 s dev-mode stall). The **baseline** arena (all Common) measured **p50 16.7 · p95 18.3 · p99 18.7**: no measurable difference.
* **CPU cost, headless Skia, steady state, 8 fighters per frame** (`pnpm rarity:bench`): sprites only 0.57 – 0.83 ms; sprites + effects Common 0.89 · Rare 2.05 · Epic 2.41 · **Legendary 3.25 ms** — the whole frame costs ~3.3 ms of a
  16.7 ms budget; the effects add ≈ 2.4 ms in the worst case.
* **Arena state latency** (worst-case arena, local PGlite): median **10.7 ms**, p95 22.3 ms. **JS heap** 33.3 MB before and after 25 s — no leak.

## 8. Public docs (`/docs`) and the shared rules

A real documentation section inside the Next.js app: left sidebar with groups and active highlighting, a right-hand "on this page" list with scroll-spy, breadcrumbs, previous / next, copyable anchor links (a `#` on every
heading plus **Copy link**), a mobile menu with search, and lightweight client-side search over titles, sections and keywords. 14 pages: `/docs`, `getting-started`, `heroes`, `classes`, `rarity`, `power-and-stats`,
`hero-profiles`, `arena`, `arena-picks`, `leaderboards`, `rewards`, `holder-bonus`, `claims`, `faq`. Body copy is readable system sans; the pixel display font is used only for headings, badges and titles.

**The docs can't go stale:** every number comes from [`src/domain/gameRules.ts`](../src/domain/gameRules.ts), which derives from the authoritative defaults (`DEFAULT_SETTINGS`, `DEFAULT_ARENA_PICKS`, `RARITY_RULES`,
the class catalogue) — the Telegram threshold, rarity names / PWR bands / odds, Daily / Weekly minimums and pools, points per correct Pick, the prize ladder, holder tiers, the combat cap. `tests/unit/docs.test.ts` (50 tests)
renders every page and checks it declares exactly its registry sections, every link resolves, the content states current product truth, no hard-coded game number appears in a page source, no admin tool / reroll / token
address / outdated "cosmetic" language appears, and the FAQ answers every required question. (I mutation-checked it: hard-coding "60 seconds" or dropping a section fails it.) The rules describe the game's *launch
configuration*; an operator who retunes a setting in Admin changes the game, not the docs.

## 9. Verification record

* **Final gates (all green):** `pnpm lint` 0 warnings · `tsc --noEmit` clean · full `vitest` run three times, identical each time: **95 files / 1594 passed / 4 skipped** (the 4 skipped are the real-Postgres suite, which
  needs `CLANK_TEST_PG_URL`) · real-Postgres suite against a throwaway local cluster: **6 / 6** (including the two new rebalance races — parallel rebalance of one hero, and an Arena freeze racing a rebalance; the
  `RACE_MUTATION=drop-fk` sensitivity check still fails the race tests when the guarantee is removed) · production build OK · client-bundle scan clean (no seed, secret, admin tool or token address).
* **Visual assets:** all 24 class × rarity combinations were composed through the real sprite compositor plus the Arena effects and inspected as a contact sheet: every tier differs in shape (ring count, rune ticks,
  outline style, particle shape, trim/crest/pauldron layers) as well as colour; no clipped layers, no aura over a face, rings centred under the feet.
* **Tests:** New suites this pass: `unit/rarity-power` (26), `unit/rarity-rebalance` (6), `unit/rarity-arena-fx` (10), `unit/rarity-ui` (13), `unit/rarity-balance` (9), `unit/rarity-sprite-assets` (100),
  `unit/docs` (50), `integration/rarity-rebalance` (8), `integration/rarity-economy` (6), `integration/rarity-migration` (8). The old "rarity is cosmetic" tests were rewritten to assert the new rule.
* **Browser (local scratch server, never live)**, 24 class × rarity heroes + legacy ones: directory (filter / sort / badges / frames), profile card, upcoming-Picks rows (badge + PWR), leaderboard rows, Admin list
  (badges, "needs rebalance", PWR sort), reroll preview both directions, apply, rollback, docs pages and the mobile menu — and overflow measurements at **1440 / 1024 / 768 / 375 / 320** on the Arena, Picks, directory,
  profile, leaderboard, docs (home, rarity, leaderboards, classes, faq) and Admin (list, detail, preview): **no horizontal overflow anywhere** (wide docs tables scroll inside their own focusable container).
* **Migration audit (read-only against live, 2026-10-06):** 10 migrations applied (…000100 – …001300); pending in order: 1400, 1500, 1600, 1700, 1800, **1900**; no hero versions yet; 70 heroes (52 ACTIVE / 18 SUSPENDED);
  threshold stored 100; the excluded bot-like member (5530802189) is NOT blocked yet (still the operator's step before 1600). **1900** is additive: one `DROP CONSTRAINT` (the action CHECK swapped for its superset), a new CHECK,
  one function, one column comment, one refusal guard (needs 1800); it changes no hero, version, arena row or setting (a test fingerprints all of them before and after applying it).

## 10. Decisions and limits worth knowing

* **A `hero-gen/1` version cannot be restored by rollback** (it can be viewed): its stats were never fitted to a band, so restoring it would put a hero outside its rarity's range. Rolling back to the system-rebalance version
  (v2) or any later generator-2 version is exact.
* Until a hero is rebalanced, the new pages show its old stats under the new PWR formula, which can sit outside its band (the Admin list flags it **needs rebalance**) — rebalance before deploying (Stage E3).
* PWR excludes gear and wallet bonuses by design (§2); there are currently no claimed heroes with gear on live.
* "Typically 30–50 seconds" in the docs is the measured fight length (median ~38 s, p90 ~49 s); the cap (60 s) comes from the settings.
* Leaderboard rarity badges show the hero's *current* rarity, attached after ranking; no result row stores it.
* Heroes are game characters: nothing here is NFT, marketplace or trading logic.
