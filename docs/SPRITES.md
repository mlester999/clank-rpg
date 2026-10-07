# Hero sprites — engine, procedural looks, and the production-art spec

> **The art that ships today is generated placeholder art** (`public/sprites/clank-dev-v1`, built by
> `pnpm sprites:build`, labelled `status: "dev-placeholder"` in its manifest). It exists so the
> engine could be built, tested and demoed. **It is not production art.** This document is both the
> architecture of the system and the brief for replacing it.

## 1. How a hero is drawn

```
persisted look (SpriteConfig)          sprite set (manifest.json + atlases)         canvas
 slot → catalogue item id     ─plan─▶   which layer blocks to use, z-order  ─tint─▶  one strip per
 skin / hair colour / hue                tint role per layer                  ─blit─▶  (hero, clip) → 1 drawImage per frame
```

* **Layers.** A hero is a stack of layers (body, outfit, eyes, mouth, hair, headgear, accessory, cape, weapon, off-hand, aura). Every layer lives on the **same frame grid**, so any compatible combination composites into one hero with identical timing and hitboxes. (LPC-style.)
* **Compose once, draw cheaply.** When a hero first needs a clip, its layers are composited into a single strip (tinted layers are blended onto their palette colour with `hard-light`: mid-grey = the colour, lighter/darker = highlight/shadow). From then on the arena does **one `drawImage` per hero per frame**. Composed heroes sit in a 48-entry LRU.
* **Data-driven.** What exists, where it is, how it animates and how it tints is described by `manifest.json`, validated by `src/domain/sprites/spec.ts`. Nothing in the renderer knows about these particular pictures.
* **Always something on screen.** If the manifest fails, the atlases fail, or the set lacks a hero's body/outfit, the hero is drawn with the original procedural **vector** renderer (`components/hero/drawHero.ts`) — the fallback is part of the design, not an afterthought. A missing *optional* layer (hair, accessory, aura…) is simply skipped.

Code map: `src/domain/sprites/` (pure: `spec` · `catalog` · `config` · `plan` · `animator` · `geometry`) · `src/components/sprites/` (`library` loader · `compositor` · `draw` · `useSprites`) · `scripts/sprites/` + `scripts/build-dev-sprites.ts` (the placeholder generator) · `scripts/lib/validateSprites.ts` (the acceptance check).

## 2. Procedural, persistent hero looks

Heroes are generated automatically from Telegram activity, so appearance must be deterministic **and stable**:

1. At creation, `rollAppearance` (unchanged) rolls the appearance parts from the hero's own seeded stream; `deriveSpriteConfig` maps those parts + the class look onto catalogue items. No extra randomness is consumed, so class/stats/rarity for a given member are bit-identical to before.
2. The resulting **`SpriteConfig`** is stored in `character_appearances.sprite`. After that the stored value wins — a later catalogue update can never change how an existing hero looks. Legacy rows (`sprite IS NULL`) are derived and backfilled at boot (`backfillSpriteConfigs`, idempotent).
3. Arena battles **freeze the resolved look into the battle snapshot**, so a replay looks the same forever.
4. Resolution order for what a browser draws: stored config (or derivation) → player overrides → admin kill-switches → sanitising against the class. It never throws on bad data.

**Rarity dresses the hero — and it is a strength tier.** Rarity gives a hero a stat budget and a PWR band (see [`RARITY_POWER.md`](RARITY_POWER.md)); the SPRITE side of it is purely visual: aura, cape, accessory and, from hero generator 2, four rarity layers — `trim` (outfit piping), `shoulder` (pauldrons or a mantle), `crest` (an ornament on the headgear) and `weaponfx` (a glint/glow/ornament on the weapon) — chosen class-aware from the hero's seed and rarity. Common wears none, Rare trim + weapon glint, Epic trim + shoulders + weapon glow (+ a crest half the time), Legendary all four. Cosmetic fields (`cosmetic_overrides`, sprite config, the aura) never feed stats, POWER or combat: stats come from the stat budget, never from what a hero wears (asserted in tests: dressing a hero differently leaves `fighterToUnit` and a re-simulated battle's events hash identical).

**Class identity.** Weapon family and outfit body are **locked to the class look**, so classes stay readable (a Tank can never wear a Mage's staff). Hair, eyes, mouth, accessories, cape, aura and headgear are open. Classes added by an admin use the legacy `look.weapon/headgear/body` fields to pick existing art.

**Customisation foundation (no shop yet).** `character_appearances.cosmetic_overrides` holds player-chosen items layered over the generated look. `applyOverrides` validates each one (exists, enabled, class-compatible, not admin-disabled); `null` clears an optional slot; outfit/weapon can be swapped but never emptied; clearing the overrides restores the original look. Catalogue items carry `tier` (cosmetic rarity), `source` (`STARTER | PROCEDURAL | EARNED | BOSS_LOOT`), `fits` and `enabled`, so earned/boss cosmetics only need new rows + art.

Admin controls (all generic, in the existing console): setting `visuals` = `{ spriteSet, disabledCosmetics[] }`; no sensitive control is exposed to players.

## 3. Animation states

| State | Clip(s) | Notes |
| --- | --- | --- |
| IDLE | `idle` (loop) | heroes stand here while the eight drop in and during 3·2·1 |
| MOVE / RUN | `move` (loop) | |
| ATTACK | `attack_slash` · `attack_thrust` · `attack_shoot` | chosen by the **weapon layer's** `attack` field (sword/mace → slash, daggers/staff/tome → thrust, bow → shoot); missing optional styles fall back thrust→slash |
| ABILITY / SKILL | `skill` | played on SKILL events; the arena also draws a cast-rune ring |
| HIT | `hit` | lower priority than attack/skill so trading blows doesn't interrupt swings; a white damage flash is drawn over *any* clip |
| KO / DEATH | `ko` (holds last frame, then fades) | |
| VICTORY | `victory` (loop, optional → falls back to idle) | the winner during victory/results |

Priority: `KO > VICTORY > latest of SKILL/ATTACK > HIT > MOVE > IDLE` (`animator.selectPlayback`, pure and tested). Frames advance with time since the **server event**, so swings line up with damage numbers.

**Directions.** Heroes are authored facing **right**; `left` mirrors it (the arena only ever needs left/right). The manifest and renderer already support authored `down`/`up` blocks (`directions: { right:{index:0}, down:{index:1}, … }`) for future expansion — see `geometry.resolveDirection`.

## 4. Production art specification

Anything that satisfies the contract below drops in with **no code change** (new folder under `public/sprites/<set-id>/`, then set `visuals.spriteSet`). Verify with:

```bash
pnpm sprites:validate -- <set-id> --strict
pnpm sprites:preview -- --set <set-id> --out sheet.png        # renders it through the real runtime compositor
```

### Frame & anchor
* One frame size for **every** layer: `frame.w × frame.h`, 8–512 px each. The dev set uses **80×64**. 64–128 px is the practical range; wider-than-tall leaves room for long weapons and lunges.
* `anchor` = the point on the floor under the hero's feet, inside the frame. `nominalHeightPx` = feet-to-top-of-head height inside the frame; the arena scales so this equals its hero height, so **art of any resolution lands at the same on-screen size**.
* **Nothing may touch the frame border** (no opaque pixel on the outer 1 px ring) — the validator fails the set otherwise. Leave room for the longest weapon in the widest lunge, and for a hero lying down in `ko`.
* `pixelArt: true` (default) draws without smoothing — right for pixel art, and the arena scales by non-integer factors. Painted/HD art should set `"pixelArt": false`.

### Clips (rows) — frame counts
| clip | required | recommended frames | loops |
| --- | --- | --- | --- |
| `idle` | ✅ | 4–8 | ✔ |
| `move` | ✅ | 6–8 | ✔ |
| `attack_slash` | ✅ | 4–8 (impact on frame 1–2) | |
| `skill` | ✅ | 4–8 | |
| `hit` | ✅ | 1–3 | |
| `ko` | ✅ | 3–6 | |
| `attack_thrust`, `attack_shoot`, `victory` | optional | 4–8 | victory ✔ |

Each clip declares `row`, `frames`, `fps`, `loop`, optional `impact`. Rows must be unique. Frames run left→right.

### Layer blocks & atlases
* A **layer block** is `cols × rows` cells (`cols` = max frames of any clip, `rows` = number of clip rows, × number of authored directions stacked vertically). **Every layer has the same block size.** Several layer blocks are stacked in one PNG atlas; the manifest records each block's top-left (`x`,`y`).
* PNG-32 with alpha, straight (non-premultiplied). Keep any atlas side ≤ 4096 px (mobile Safari) and the **total decoded size** reasonable: the dev set is ~13 M px (≈ 53 MB decoded, 372 KB on the wire). Eight atlases are fetched once, in parallel, at first view.
* `layers[id]`: `{ image, x, y, z, tint, of?, attack?, loop? }`. `z` orders layers back-to-front (dev: cape 5 · body 10 · outfit 20–22 · eyes 30 · mouth 31 · hair 40 · accessory 50 · headgear 60 · off-hand 65 · body arm 64 · sleeve 66 · weapon 70; aura −5).
* **Parts.** `of: "<owner id>"` makes a layer a part of another item, drawn at its own depth whenever the owner is worn (e.g. `outfit.heavy.front` — the sleeve that must sit *in front of* the torso — or `hair.2.back`). Parts cannot be nested.
* **Auras** (`loop: { frames, fps }`) are a single row that loops on its own clock, independent of the body clip.

### Layer ids (must match the catalogue — `src/domain/sprites/catalog.ts`)
| slot | ids | required |
| --- | --- | --- |
| body | `body.base` | ✅ (parts allowed: arms in front of the outfit, etc.) |
| outfit | `outfit.medium` · `outfit.robe` · `outfit.light` · `outfit.heavy` | ✅ — a missing outfit for a worn item **forces the vector fallback** for that hero |
| weapon | `weapon.sword` · `mace` · `staff` · `tome` · `daggers` · `bow` | recommended; set `attack` on each |
| off-hand | `offhand.shield` | optional |
| eyes / mouth | `eyes.0–3` · `mouth.0–2` | optional |
| hair | `hair.0–6` (8th style = bald, no layer) | optional |
| headgear | `headgear.helm` · `hat` · `hood` · `cap` · `halo` · `crown` | optional (a helm hides hair) |
| accessory | `accessory.goggles` · `scarf` · `cog-pin` · `monocle` · `headset` | optional |
| cape / aura | `cape.default` · `aura.ring` · `aura.sparks` · `aura.flame` | optional |

New cosmetics = a new catalogue row (`id`, `slot`, `tier`, `source`, `fits`, `enabled`) + a layer with that id. `--strict` fails the set if any enabled catalogue item has no art; without it, missing items are warnings and the hero simply renders without them.

### Tinting
`tint` is one of `skin · hair · primary · secondary · accent · rarity · cape`, or `null`.
* **Tinted layers must be authored in neutral grey.** Mid-grey (`#808080`) becomes the palette colour *exactly*; lighter greys become highlights, darker greys shadows; near-black outlines stay near-black. This keeps one body/outfit sheet usable for every skin tone, hair colour and class colour.
* `null` = drawn exactly as authored (metal, wood, gems, pre-coloured art). A licensed pack with fixed colours can leave every layer `null`.
* Palette sources: skin/hair from the hero's picks; primary/secondary/accent from the **class** colours with the hero's hue shift; `rarity` from the shared rarity palette (`RARITY_VISUALS`); `cape` = darkened rarity colour.

### Licensing
Fill `manifest.credits` for any third-party art and flip `status` to `"production"` only for real, licensed art.

## 5. Replacing the placeholder — checklist

1. Author/obtain layers to the spec above (any frame size).
2. Assemble atlases + `manifest.json` in `public/sprites/<set-id>/` (see `scripts/build-dev-sprites.ts` for a complete worked example of block layout and manifest generation).
3. `pnpm sprites:validate -- <set-id> --strict` must print `OK`.
4. `pnpm sprites:preview -- --set <set-id> --out sheet.png` and look at it.
5. Admin → Balance & config → `visuals` → `spriteSet: "<set-id>"`.
6. A new set id means new URLs, so browser caches never serve stale art.

## 6. Performance notes

* Arena frame cost is ~8 `drawImage` calls (one per hero) + effects; no per-frame allocation in the hero path. Measured in a dev build while a fight played: **p50 16.7 ms · p95 17.6 ms (60 fps), 0 long tasks, 23 MB JS heap**.
* React does not re-render per animation frame: the canvas loop writes live HP/kills/status into an external store (`rosterStore`) that only the spectator strip subscribes to; the rest of the page updates once per second or per phase change.
* Composition is lazy (per clip, on first use) and cached; hero strips for a battle are built while the eight stand idle.
* Network per battle: **0** sprite requests (loaded once per page) and one replay request (served only after picks lock — see `docs/SECURITY.md`).
* Cost of the dev set: 8 PNG atlases, 372 KB transferred, ≈ 53 MB decoded. A production set with a larger frame will cost more; budget with `blockSize × layer count`.
