# Hero renderer v3 (`clank-v3`) — the procedural pixel character engine

> **Status: built and verified locally, NOT live.** The code ships the renderer and makes it the default for fresh settings, but every page
> keeps drawing whatever `game_settings.visuals.spriteSet` says (`clank-dev-v2` today) — the Arena, portraits, avatars and share cards — until
> migration `20261014002600_hero_renderer_v3.sql` is applied, which has not been done anywhere outside scratch databases. Verified on a
> production build: with the setting on `clank-dev-v2` the new code generates 0 v3 frames on any page. v1 and v2 are untouched and stay
> selectable; switching back is one admin setting.

v3 draws every hero **from its stored look** (class, rarity, appearance parts, sprite config — the same inputs v2 reads) with a small 2.5D
software rasteriser that thinks in anatomy, not layers. Nothing about a hero is re-rolled or re-derived: ids, classes, rarities, PWR, stats,
ownership, hero versions, battle results and combat hashes are not read or written by the renderer.

QA artefacts (images, videos, measurements): `docs/qa/hero-renderer-v3/` — see §8.

---

## 1. Why v2 looked wrong (root causes)

| Symptom in v2 | Root cause |
|---|---|
| Mushy, noisy pixels; uneven outlines | Each layer was a vector drawing rendered at 4×, then thresholded/posterised **per layer** and outlined **per layer** — every layer brought its own outline and its own quantisation noise, and layers stacked on top of each other. |
| Limbs passing through bodies, gear on the wrong side | Layers had **fixed z order** per clip. Depth never depended on the pose, so an arm swinging forward could not move in front of the torso and back again. |
| Hands not on the weapon, two-handed grips floating | Arms were **forward kinematics** (angles per frame); the weapon was a separate layer posed independently — nothing guaranteed the hand was on the hilt. |
| Feet sliding on the floor | The walk cycle's stride had no relation to the speed the Arena moves a hero at, and the clip played at a fixed fps. |
| Faces off the head, helmets over the eyes | Face pieces were stamped at fixed sprite coordinates, not anchored to the head; headgear layers were drawn over them blind. |
| Blurry / uneven pixel sizes in the Arena | The stage scaled sprites by a non-integer factor (e.g. 1.96×) with smoothing on some paths. |

These are properties of the layer pipeline, so v3 replaces the pipeline rather than tuning the art.

## 2. Architecture

All of v3 is pure TypeScript under `src/domain/sprites/v3/` (≈ 6.6 k lines), isomorphic (browser, server card renderer, tests, scripts), no
atlases, no downloads.

```
SpriteConfig + class colours + rarity
  └─ genome.ts      independent hash streams: body · face · equipment · palette · anim (v2-compatible picks: archetype, tone, metal, cloth, stance)
      ├─ anatomy.ts   18 archetype body plans (6 classes × 3, same ids and same per-hero pick as v2)
      ├─ palette.ts   5-tone material ramps, OKLCH hue-shifted (color.ts, materials.ts)
      └─ gear/*       per-class loadouts: armour, headgear, weapon, shield/off-hand — pools chosen by RARITY, design by the look
  └─ clips.ts + poses/*   target-based keyframes per archetype (anim.ts: easing, polar hand arcs), procedural gait
  └─ rig.ts         pose → skeleton: two-bone IK (planted feet with automatic hip drop; hands in chest / pelvis / world space;
                    weapon attached to the holding hand; two-handed second grip; bow string hand; shield strapped to the forearm)
  └─ body.ts / kit.ts / gear/*   analytic primitives in view space (view.ts camera, gbuffer.ts):
                    ellipsoids, swept-sphere capsules, boxes, plates, lines, pixel stamps → z-buffered G-buffer (depth, part, normal, tone)
  └─ post.ts        pixel-art pass: material ramps, quantised lambert / metal bands, selective interior lines, orphan clean-up,
                    material-tinted 1 px silhouette outline
  └─ gear/accessory.ts  the stored accessory trait: goggles (pushed up above the brow), scarf (colour chosen to contrast with the outfit),
                    cog pin, headset; under a hood the hair shows as a fringe (+ a lock for long hair) through the face opening
  └─ face.ts        eyes / brows / mouth stamped on HEAD-LOCAL anchors, masked to visible face skin; closed visors get a slit + glints;
                    the monocle is a ring stamped around (never over) the near eye
  └─ validate.ts    anatomical checks on the finished frame (§6)
render.ts  → FrameResult { rgba 96×80, part ids, meta (hands, grips, muzzle, face, feet…) }
set.ts     → the sprite-set contract: v3Manifest() + ProceduralHero { frames(clip), frame(clip, f), muzzle, aura }
```

* **Space.** Character space X forward, Y up, Z toward the viewer. Camera yaw 24°, pitch 12°, zoom 1.12, head turned 16° toward the
  camera — a three-quarter view in which the near arm reads as near. Joints are snapped to pixel centres; anything below the floor is clipped.
* **Frame.** 96 × 80 px, anchor (44, 73), nominal hero height 46 px — the same contract as v2, so the Arena, portraits and cards need no
  layout changes.
* **Depth is per pixel and per pose**, so an arm, a weapon or a shield passes in front of or behind the body exactly as the pose puts it.
* **Facing** is a mirror of the right-facing render (the Arena only needs left/right). Because the body is one 3D pose, the mirrored hero keeps
  its weapon in the same hand relative to its body; a facing change plays a short `turn` clip (the camera swings through 104° → 74° → 46°).
* **Rarity** chooses the equipment pools (a Legendary wears only Legendary constructions) and the procedural aura particles (`aura.ts`); it
  never changes body size.

### Randomness streams

`genome.ts` derives each trait family from its own hash of the stored look, so changing one family never shifts another: body (build,
height, proportions within the archetype), face (eyes, brows, mouth, hair), equipment (one stream per slot: armour, helm, weapon, shield),
palette (tone, cloth, metal) and animation (idle variant, phase). The archetype pick is v2's (`stableHash("build|<weapon item>|lookKey") % 3`),
so a hero keeps its v2 skeleton family.

## 3. Animation

| clip | frames | fps | notes |
|---|---|---|---|
| idle / idle2 | 8 | 6 | breathing, weight shift; idle2 is the second stance |
| move | 8 | ≈ 11 (derived) | stride 22 px × zoom; **stride-locked**: the planted foot moves exactly one stride share per frame |
| run | 8 | ≈ 11.7 (derived) | stride 32 px, reference speed 96; used above 80 u/s (with 9 u/s hysteresis) |
| attack_slash / attack_thrust | 9 | 18 | impact on frame 3: anticipation → strike → follow-through → recover |
| attack_shoot | 9 | 16 | impact on frame 4: nock → draw to the jaw → release from the bow (the muzzle) → recover |
| skill | 10 | 16 | impact on frame 4 (cast, blessing, war cry…) |
| hit | 4 | 16 | recoil away from the blow |
| block | 5 | 18 | shield / weapon brace — played on a MISS |
| ko | 10 | 12 | back / forward / kneel falls, the weapon drops, bounce, still (stays inside the frame) |
| victory | 8 | 8 | per archetype |
| turn | 3 | 22 | facing change |

`fps = frames × refSpeed / (stride × zoom × world-units-per-px)` for move and run, and the Arena drives both from a **move clock** advanced by
`speed / 62` — so at any speed the feet stay planted (no moonwalking). The animator (`src/domain/sprites/animator.ts`) only uses run, block and
turn when the manifest declares them, so v1/v2 behave exactly as before.

## 4. Integration

* `src/domain/sprites/spec.ts` — clip keys `run`, `block`, `turn`; optional `stride` / `refSpeed`.
* `src/components/sprites/compositor.ts` — `SpriteSource.procedural`. A procedural strip is allocated empty and **filled one frame at a time**
  the first time that frame is drawn or warmed (one shared ImageData copies frames in); silhouettes (hit flash, chill, shield) are made per
  frame the same way. The name-plate height is measured from the first idle frame's own pixels (no canvas read-back). Heroes sit in the same
  48-hero LRU as v2.
* `src/components/arena/ArenaRenderer.ts` — speed / run state, block on MISS, turn after the bell, and clip warming **clip by clip across all
  heroes** within a time budget per display frame: 5 ms before the bell (at least one frame per display frame), 2 ms during the fight (procedural
  sets only, only what fits — the compositor keeps a running average of this device's cost per frame), nothing on a display frame that was
  already late (> 18 ms) and nothing after the fight. A frame that was not warmed is generated when it is first drawn.
* `src/components/sprites/draw.ts` — `snapPixelScale`: when the stage scale is within 12 % of an integer device scale it snaps to it (and
  rounds the translation), so every art pixel is the same size on screen.
* `src/components/hero/HeroPortrait.tsx` — asks only for the frame it shows, and draws with **the live set**: the one its look names (hero
  pages), else the set the server last announced on this device (`announceSpriteSet` / `useActiveSpriteSet` in `library.ts` /
  `useSprites.ts`). The Arena state announces it, and so do the hero directory and hero pages (`components/sprites/LiveSpriteSet.tsx`, from the
  settings they already read); it is remembered in `localStorage` (`clank.spriteSet`). Until a page has heard it, the fallback is
  `DEFAULT_SPRITE_SET = "clank-dev-v2"` — the set that was live before v3. A set is loaded one task after a portrait mounts, so a hydrated
  portrait that switches to the live set at once never downloads the fallback's 3.8 MB manifest.
* `src/server/heroes/cardImage.ts`, `src/domain/hero/card.ts` — cards draw with the procedural set; the card content key includes
  `v3.<V3_ART_REVISION>` so a renderer switch (or an art revision) re-keys cached images.
* `src/domain/settings.ts` — the default `visuals.spriteSet` for fresh settings (a new database) is `clank-v3`; an existing settings row keeps
  its value. `src/components/sprites/library.ts` serves `clank-v3` immediately (nothing to fetch).
* Scripts: `scripts/lib/validateSprites.ts` (procedural validation), `scripts/lib/telegram-backfill-scratch.ts`,
  `scripts/backfill-telegram-heroes.ts` (procedural-aware), `scripts/sprites-v3-qa.ts` (the QA artefact generator).

**Combat is not touched.** The renderer reads the replay; it never feeds anything back. No combat, balance, stat or result code changed.

## 5. Versioning and rollout

* Set id `clank-v3` (`src/domain/sprites/v3/version.ts`), art revision `V3_ART_REVISION = 1`. Bump the revision whenever a change alters
  pixels of existing heroes — it re-keys card images.
* `clank-dev-v1` and `clank-dev-v2` (atlases in `public/sprites/`) are unchanged and selectable.
* Migration `supabase/migrations/20261014002600_hero_renderer_v3.sql` switches `visuals.spriteSet` from `clank-dev-v2` to `clank-v3` — **only if
  it is still `clank-dev-v2`** (an operator's explicit choice is never overridden), bumping the settings version. Not applied to any live
  database.
* **Rollback:** set `visuals.spriteSet` back to `clank-dev-v2` in the admin settings. No data migration either way.

## 6. Validation

`validateFrame` (`src/domain/sprites/v3/validate.ts`) runs on real generated frames:

| code | rule |
|---|---|
| finite | every joint and anchor is a finite number |
| edge | nothing touches the frame border (KO and dropped weapons included) |
| bones | bone lengths match the body plan (IK never stretches a limb) |
| knees | knees bend forward, never backward |
| ground | the stance foot is on the floor while standing |
| grip / hand | the holding hand is on the grip; a two-handed second hand is on the haft; the hand is visible |
| weapon | the weapon is attached to the hand (and drops only on a KO) |
| eyes | the eyes are on the head, on visible face skin (or a visor slit), never covered by headgear |
| eyes-action | during an action at most 2 frames per clip may cross the face with the weapon |
| mouth | the mouth is on the face |

Tests: `tests/unit/hero-renderer-v3.test.ts` (100 uncurated seeds per class through every clip, faces, determinism, stream independence,
v2 archetype continuity, IK, grips, gait / cadence, attacks are real actions, accessories on every class, hood fringes, the contract, muzzles,
the compositor incl. frame-at-a-time strips and budgeted warming, the live-set announcement, library default, animator run / block / turn, card
key, migration SQL) and `tests/integration/renderer-v3-migration.test.ts` (the
migration on a scratch database). `pnpm sprites:validate clank-v3 --strict` validates 30 heroes per class × every clip that hero uses × every frame (14,580 frames).

## 7. Measurements

Offline (Node 22, Apple silicon; `docs/qa/hero-renderer-v3/perf/offline-generation.txt`):

| | v3 |
|---|---|
| one frame | p50 1.0 ms · p95 1.2 ms · p99 1.3 ms (100 heroes, 7,300 frames) |
| one hero, every Arena clip (73 frames) | p50 74 ms · p95 87 ms · p99 95 ms |
| a hero's first appearance (setup + first idle frame) | p50 1.3 ms · p95 3.5 ms (GC outliers to ≈ 20 ms at p99) |
| 1 / 8 / 24 / 100 heroes, every clip | 67 ms / 653 ms / 1.9 s / 7.4 s |
| strip memory per hero (all 73 frames generated) | 2.24 MB (canvas backing store) |
| cache | LRU of 48 heroes (verified: the oldest is evicted, a recent one is kept) → ≤ 108 MB if all 48 were fully generated; one battle's 8 heroes ≈ 18 MB, usually less (frames are generated only when drawn or warmed) |

v2, for comparison: 19 atlas pages, 8.5 MB PNG, **161 MB decoded** (a battle decodes 17–19 of them), plus 1.14 MB of composed strips per hero.

Real Arena, production builds on a scratch database, headless Chrome, 8-player battles, no screen capture running
(`docs/qa/hero-renderer-v3/perf/arena-browser-runs.json`):

| run | v2 frame ms p50 / p95 / p99 | v3 frame ms p50 / p95 / p99 | notes |
|---|---|---|---|
| desktop 1280×800 @2× | 16.7 / 16.8 / 33.4 | 16.7 / 16.8 / 33.3 | 0 long tasks either way (the p99 is the headless compositor at 2×, same for both) |
| mobile 390×844 @3× | 16.7 / 16.7 / 16.8 | 16.7 / 16.8 / 16.8 | 0 long tasks either way |
| mobile, CPU throttled 4× (v2: 2 runs, v3: 4 runs) | 16.7 / 16.8 / 16.8 | 16.7 / 16.7–16.8 / 16.8 | longest task v2 50–66 ms, v3 ≤ 59 ms (0–1 per battle); battle-start frame v2 100–117 ms, v3 67–100 ms; results-screen frame v2 100–117 ms, v3 67–117 ms |
| sprite downloads | 17–19 requests, 8.0–9.0 MB | 0 | |
| JS heap at the end of a battle | 19.6–20.7 MB | 17–48 MB | v3 includes uncollected per-frame garbage (≈ 280 KB per generated frame, short-lived) |

How it got there: the first v3 integration generated whole clips at once and measured the name-plate height with a GPU read-back; on the
throttled phone that meant battle-start hitches up to 283 ms and a p99 of 33.4 ms. Frame-at-a-time generation, the read-back-free plate
measurement, the lazy muzzle and the adaptive warm-up (§4) fixed it.

## 8. QA artefacts and how to regenerate them

`pnpm exec tsx scripts/sprites-v3-qa.ts --out docs/qa/hero-renderer-v3` writes 01–09 and `videos/*` (≈ 30 s):

* `01-old-vs-new-warriors-zoom.png`, `02-old-vs-new-warriors-arena-size.png`, `03-faces-old-vs-new.png`, `04-weapon-grips-old-vs-new.png`
* `05-twenty-common-warriors.png`, `06-twenty-legendary-warriors.png`, `07-all-classes-all-rarities.png`
* `08-animation-contact-<class>.png` (every frame of every clip), `09-edge-cases.png`
* `videos/` — warrior idle→run→attack→recover, tank walk→block→attack→recover, rogue run→strike→reposition, ranger move→stop→aim→fire→recover,
  mage move→cast→release, cleric idle→heal→recover, hit→KO, victory, facing change (MP4 + GIF, 60 Hz)

Captured from the real Arena (production builds, scratch Postgres, headless Chrome over CDP):

* `videos/arena-desktop-8-players-v3.mp4`, `videos/arena-mobile-v3.mp4`, `videos/arena-desktop-8-players-v2-before.mp4`,
  `videos/arena-mobile-v2-before.mp4`, `videos/arena-duel-{ranger-vs-warrior,tank-vs-mage,rogue-vs-cleric}-v3.mp4`
* `arena/arena-desktop-v2-vs-v3.png`, `arena/arena-mobile-v2-vs-v3.png`, `arena/arena-native-and-4x-v2-vs-v3.png`,
  `arena/arena-desktop-v3-key-moments.png` (intro → countdown → FIGHT → clusters → final 1v1 → KO → victory → results),
  `arena/arena-duel-*-v3.png`, `arena/page-desktop-v{2,3}-portraits.png`, `arena/page-mobile-v3.png`
* `10-hero-cards-v2-vs-v3.png` — server-rendered share cards (same stats and PWR, new art)
* `11-accessories-every-class.png` (none · goggles · scarf · cog pin · monocle · headset on every class), `12-hooded-hair-styles.png`
* `perf/anatomy-sweep-600-heroes.txt`, `perf/accessory-sweep.txt` (every accessory forced onto 20 heroes per class, every clip),
  `perf/variety-near-duplicates.json`, `perf/offline-generation.txt`, `perf/arena-browser-runs.json`

## 9. Known limits

* **Bulk.** v3 heroes are anatomically proportioned; v2's chibi silhouettes (huge hats, shields and heads) read bolder at a glance from far
  away. v3 reads better up close and in motion; at 1× on a small phone some classes (ranger vs rogue at a distance) rely on colour more than
  on silhouette.
* **Near-identical heroes.** Gear designs hash the never-overridable part of the look (skin, hair colour, hue — so a cosmetic change never
  swaps a hero's armour), so two heroes of one class and rarity that share those three wear the same gear and differ only in face, hair and
  accessory. Over 100 uncurated seeds per class (7,200 same-class, same-rarity pairs): 0 pixel-identical idle frames, 3 pairs differ in < 5 %
  of their pixels, 20 in < 10 % (`perf/variety-near-duplicates.json`). Closed helms (Tanks) and hood + mask (Rogues) hide most identity traits.
* **Clerics** are deliberately cream / white robes in every tier (class identity); within a tier they vary by cut, trim, stole and headgear more
  than by colour.
* **Brief weapon-over-face frames.** Up to 2 frames per action clip may cross the face (allowed by the validator). In the 600-hero sweep
  (48,600 frames): 13 single frames — 7 on Sage mages' thrust / cast (the staff passes the face) and 6 on the first KO frame of Sentinel
  tanks (the stagger swings the hammer across the visor). Never in idle, walk, run, block or victory.
* **Pages that do not read the settings** (`/character`, `/leaderboard`, the sign-in panel) draw portraits in the set last announced on that
  device — or `clank-dev-v2` on a device that has not opened the Arena or a hero page since the switch. One visit to either fixes it for good
  (and a rollback propagates the same way).
* **Only right / left.** Up / down facings are not drawn (the Arena never needs them).
* **First appearance cost** on very slow devices is still ≈ 100 ms for a full 8-hero roster at battle start — on par with v2's atlas
  composition, but not lower. Pre-generating the next battle's roster would need the next roster in the Arena state (a server change, not
  made).
* **Not production art in the hand-pixelled sense.** v3 places pixels by rule (ramps, bands, lines, clean-up), consistently across every seed;
  an artist would still do better on individual hero portraits.
