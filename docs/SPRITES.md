# Hero sprites — engine, procedural looks, and the production-art spec

> **The art that ships today is generated placeholder art**, built by `pnpm sprites:build` and labelled
> `status: "dev-placeholder"` in its manifests: **`clank-dev-v2` — hero renderer v2, the default** — and
> `clank-dev-v1`, the original set, kept and still selectable. They exist so the engine could be built,
> tested and demoed. **They are not production art.** This document is both the architecture of the
> system and the brief for replacing it.

## 0. Hero renderer v2 (`clank-dev-v2`)

The same engine, the same contract and **the same catalogue ids** as v1 — so every hero's stored look (class, rarity, parts,
sprite config, hero versions) is drawn exactly as it was chosen; nothing about a hero is re-rolled or re-derived. Switching
between v1 and v2 is the `visuals.spriteSet` setting (settings migration `20261007002300` moves a database that still selects
v1; an admin can switch back at any time). v2 has never been selected by a production database, so it is refined in place (card
images re-key through `CARD_ART_REVISION`, atlas pages are content-hashed file names).

### 0.1 Archetypes — three skeletons per class (sixth pass)

The design library (0.2) gave every class many helms, armours and weapons, but every hero of a class was still the SAME BODY in the same stance
holding the same-sized weapon: twenty Warriors read as one figure in twenty helmets. Each class is now drawn on **three skeletons** — archetypes,
each a different build, grip, stance pair and pose language (`scripts/sprites/v2/rig.ts` + `archetypes.ts`):

| class | the original | archetype 2 | archetype 3 |
| --- | --- | --- | --- |
| Warrior | vanguard — sword up, planted guard | **brute** — widest build, a GREATSWORD in both hands (tail guard / planted), cleave and spin | **duelist** — tall and lean, side-on en-garde with a BUCKLER, a long lunge |
| Tank | bulwark — shield forward, mace on the shoulder | **juggernaut** — the biggest body, shield held high, a rising smash and a ground slam | **sentinel** — tall knight, shield grounded, a long-hafted mace upright, an overhead chop |
| Rogue | cutthroat — low crouch, twin daggers | **assassin** — tall and thin, long knives reversed, a gliding stalk, a lunging stab | **brawler** — short and stocky, a boxer's guard with the knives at the face, quick jabs |
| Ranger | scout — recurve carried upright | **warden** — tall, a LONGBOW nearly his height, a deep slow draw, a sky volley | **skirmisher** — small, a SHORTBOW held level in a crouch, a snap shot, a leaping shot |
| Mage | scholar — staff planted | **battlemage** — a short staff ACROSS the body in both hands, leaning into the cast | **sage** — HUNCHED, a tall staff leaned on, a slow shuffle |
| Cleric | priest — scepter before the chest | **templar** — broad, a holy mace on the shoulder, an overhead smite | **monk** — slight, a tall sun-staff grounded, a hand raised in prayer, a kneeling blessing |

* **A hero's archetype is chosen like every design choice:** the class weapon lists its class's skeletons in the manifest (`builds`), and
  `plan.rigOf` picks one from the never-rerolled look (`stableHash("build|<weapon>|" + lookKey)` — skin, hair colour, hue). Nothing is stored,
  nothing is re-rolled; the helm, armour, weapon design and stance stay independent choices (tested). About a third of a class's heroes get each.
* **The build is a real body:** proportions, limb weight, chest (garments scale with it), HEAD SIZE (faces, hair and headgear scale with the
  head) and the weapon: a design drawn on the brute is a greatsword (longer, wider, a two-hand grip with the front hand at the pommel), on the
  warden a longbow, on the monk a staff that reaches the ground (`Build.weapon`). Every class design is drawn on all three skeletons.
* **Two-handed grips are rigid:** a pose may hold its weapon in both hands (`gripB`) or put the back hand at a torso point (`handBAt`); the back
  arm is solved by IK, and when it cannot reach, the weapon comes in toward the body (tested: the back hand is on the grip in every such frame).
  A torso **twist** turns the shoulders through a swing (anticipation → strike → follow-through).
* **Grounded:** stances never lift the feet (breathing is a torso squash); planted weapons and fallen heroes stop at the floor (the packer
  clips everything below it, `floor`); a knocked-out hero's weapon lies along the ground instead of sticking up out of the body.
* **Palette tones** (manifest `paletteTones`): each hero wears its class colours one of five shades deeper or paler (`config.PALETTE_TONES`),
  from the never-rerolled look — v1 is unaffected.
* **More open heads:** bare-headed, brow-band and gold-circlet Warriors (the hair shows); brimmed-hat and tricorne Rogues (the face shows).
* **Frame 96 × 80** (feet at 40, 76; nominal height 46 px — the same on-screen size).
* **Lazily loaded pages:** a packed set loads its manifest (and the aura atlas) up front and fetches each skeleton's page the first time a hero on
  it is drawn (`SpriteSource.ensure`; the arena asks for its eight fighters' pages as soon as the battle is set, long before the bell; a
  portrait shows its backdrop until its page arrives — never a vector hero for a moment; a page that fails is retried when the network comes
  back). The server's card renderer reads pages on demand too (at most 6 decoded per process). See §6.
* Measured (idle stance, 20 Common Warriors / 8 of each other class): the median pairwise SILHOUETTE difference went from 182 → 488 px
  (Warrior), 176 → 524 (Tank), 225 → 540 (Rogue), 369 → 538 (Ranger), 342 → 642 (Mage), 91 → 359 (Cleric); near-identical silhouettes (< 100 px
  apart) among 190 Common Warrior pairs: 40 → 12.
* Look at it: `pnpm sprites:preview -- --set clank-dev-v2 --archetypes --scale 2 --out poses.png` (one row per skeleton: both stances, run,
  attack, cast, hit, KO, victory) and `--rig warrior-brute` to restrict `--anim` / `--variety` to one archetype.

### 0.2 The design library (fifth pass)

Before this pass every Warrior was the same drawing in a different hue: one outfit per body type, two drawings per weapon and helm, and
rarity as overlay ornaments on the Common look (Legendary ≈ Common + gold). v2 is now a **design library** drawn on **six class skeletons**:

* **Six skeletons** (`scripts/sprites/v2/rig.ts`): each class has its own build and pose language (Warrior planted guard and rotating swing,
  Tank shield-forward march and overhead smash, Rogue low crouch and dash-stab, Ranger planted draw-aim-release, Mage levitating cast, Cleric
  smite and blessing). Clip lengths, fps and impact frames are SHARED, so combat timing never depends on the class. The weapon decides the
  skeleton (`layer.rig`).
* **Designs, not ornaments.** Every class item is drawn as a family of designs (manifest `variants`): per class and per **equipment tier**
  (`tiers`) — 4–5 helms / hats / hoods, 4 torso constructions, 2–4 arm and leg designs, 2–4 pauldrons, 4 weapons, and a class gear pool, at
  EACH of Common · Rare · Epic · Legendary. Rarity picks the POOL (a Legendary wears only Legendary designs: a winged, dragon, crowned or lion
  helm, gilded or dragonscale plate, a sunblade — a different construction, not Common gear in gold); the hero's never-rerolled look picks the
  DESIGN (`plan.variantOf`, hashed per item: the helm, the torso, the arms, the legs, the pauldrons, the weapon, the gear and the stance are
  independent choices). Tier-exclusive designs bake their tier's colour (an Epic plume is violet, Legendary runes gold) instead of a rarity-
  tinted layer. Common is clean, practical and finished (a nasal helm, a gambeson, an arming sword), never ugly.
* **Independent sub-slots** (kit parts with variants of their own, `set.ts`): `outfit.<body>.arms`, `.legs`, `.shoulders`, `weapon.<w>.gear`,
  `weapon.bow.quiver`, `body.base.head` (five head shapes) and `body.base.beard` (facial hair, weighted per class). A part's chosen design may
  bring parts of its own (a pauldron's far twin, a helm's plume).
* **Two stances** (`idle` / `idle2`): each hero stands in one of two class stances (Warrior raised guard vs low guard, Tank mace forward vs
  shield planted and mace at rest, Rogue crouch vs upright reverse grip, Ranger bow carried vs arrow nocked, Mage staff planted vs palm raised,
  Cleric scepter before the chest vs hand raised in blessing), chosen from the stored look (`plan.idleClip`); the arena, portraits and cards
  use it.
* **The rarity overlay slots** of hero generator 2 (`trim` / `shoulder` / `crest` / `weaponfx`) stay in the catalogue and in every stored look
  but draw nothing in v2 — the tier lives in the equipment. (v1 keeps its overlays.)
* **Identity is untouched:** eyes, mouth, hair style and colour, skin, accessories and outfit hue are the hero's stored traits, drawn as before.
* **Frame 88 × 72** (feet at 37, 68 — now 96 × 80, see 0.1; nominal height 46 px — the same on-screen size): headroom for crests, wings and a greatsword raised
  overhead. Hems stop at the floor when a hero kneels or falls (`kit.floorLen`); nothing touches the frame border (validator, strict).
* Code: `scripts/sprites/v2/` — `kit` (materials, frames, shading), `body` (body, heads, beards, face, hair, accessories), builders
  (`garments`, `helms`, `hats`, `blades`, `hafts`, `bows`, `shields`, `pauldrons`, `capes`, `gear`), one table per class (`warrior` … `cleric`),
  `set` (the catalogue items, their designs and sub-slots), `parts` (the earlier v2 drawings — now only the generic fallback an admin-made class
  mixing items across skeletons would wear).

### 0.3 Earlier v2 passes (still true)

* **Proportions and silhouettes.** A smaller head on a longer body (head ≈ 35 % of the height instead of 41 %), two-segment
  legs with knees, longer arms. Each class reads by its outline at battle size: Warrior — helm, tabard over mail, sword;
  Mage — tall bent hat, bell-sleeved robe, crystal staff; Rogue — deep hood and mask, twin daggers; Ranger — feathered cap,
  quiver, long recurve bow; Tank — great helm, shield, flanged mace; Cleric — halo, robe, sun scepter, tome at the hip.
* **Volume, faces and metal (second v2 pass).** Limbs carry a band of light along their upper-back edge (two tones per limb instead of one flat
  fill — light from the top-left, like the head). The Warrior's and Tank's helm is real **steel** with a brass brow band (a class-coloured dome
  melted into the skin), open-faced with the nasal guard *between* the eyes, so the face reads; the Tank's front pauldron sits below the jaw;
  large eye whites were reduced (they read as goggles at battle size); the Ranger carries the bow **upright** at rest (its string no longer
  slashes across the body) and raises it to shoot; Legendary light gear lost its crossed harness and stud rows (gold on everything drowned the
  class colours) — a gilded belt, a jewelled buckle and a clasp instead. Layer ids, tint roles of every hero's stored choices and frame
  geometry are unchanged, so nothing about any hero is re-rolled.
* **Third pass (selective outlines, heads, capes).** Interior lines are a dark shade of each part's own colour, not black (`innerOutline`:
  tinted layers draw their outline in neutral dark grey, which the compositor tints with the part — the composed hero still gets one black
  silhouette outline), so a hero no longer looks like a sticker made of outlined pieces. Heads are a shape (cranium, flatter face front,
  cheek, jaw, chin) lit from above instead of a shaded disc; eyes carry brows (calm / alert / stern by eye style); robes have cloth folds;
  capes wear the class's dark accent colour (a Legendary is no longer a sheet of gold); Epic / Legendary pauldrons sit on the upper arm with
  their spikes swept back (on the shoulder joint they read as a bell under the chin); the resting bow is carried upright (the earlier fix had
  its rotation inverted). **Honest limit:** this is still procedurally generated stand-in art — see [`ART_PRODUCTION.md`](ART_PRODUCTION.md)
  for the production path.
* **Fourth pass (drawing quality, class kits, variety, rarity readability).** Still the same generator, frame, anchor and layer contract.
  * *Drawing:* limbs taper (thigh → shin, upper arm → forearm) and are drawn as one outlined shape with a rounded joint; hands are small
    mittens with a thumb, pointing along the forearm (no balls on sticks); boots have a heel, an instep, a toe and a cuff, in a darker tone that
    grounds the figure; torsos have a V-taper (shoulders wider than the waist); robes cross over at the chest with fanned folds and a knotted
    sash; plate has abdomen lames and riveted faulds; the head is a round cranium with a soft cheek and jaw (outline-first, so it merges into
    one clean edge — the earlier jaw read as a box under a hat brim). The idle stance is wider (feet apart, knees soft).
  * *Class kits* — parts of each class's own weapon (`of: weapon.<x>`), so every hero of the class wears them, whatever its drawing:
    Warrior — a scabbard at the back hip · Tank — a steel bevor over the jaw and a visor brim (the face reduced to its eyes) · Rogue — a
    knotted waist sash whose tails stream out behind · Ranger — a leaf-cut hooded mantle (and the quiver) · Mage — a tall flared collar
    rising behind the head · Cleric — a white, gold-edged amice. The Ranger's cap was redrawn as a forester's cap sweeping back to a point
    with a red feather (its old forward peak + feather read as two ears).
  * *Variants* (manifest `variants`, see §4): every class weapon and headgear has a second drawing — a broadsword with iron quillons, a
    morning star, a crook staff with an orb, a star scepter, straight parrying daggers, a longbow; a kettle hat over a mail coif, a straight
    cone hat with a crescent, a cowl with a liripipe tail, a broad-brimmed hat, a laurel with a high halo. Which one a hero wears is a pure
    function of the never-rerolled parts of its stored look (`variantOf`: skin, hair colour, hue — hashed per item, so a hero's sword does
    not decide its helm). Same clip, same muzzle, same crest anchors. Nothing is stored and nothing is re-rolled: v1 has no variants, and a
    hero's drawing never changes.
  * *Rarity reads at battle size:* Rare now adds a rarity-coloured belt / sash and a tassel on the weapon's grip (before: thin piping that
    vanished at 84 px); Epic keeps pauldrons / mantle, crest, rune-lit weapon and the cape; Legendary keeps its class-specific pieces
    (winged helm crest, gilded belt and clasp, the stole) and its tassel becomes a longer jewelled ornament; the robe stole is thinner (less
    gold paint, more class colour).
  * `pnpm sprites:preview -- --set clank-dev-v2 --variety 8 --out variety.png` draws eight different heroes of every class side by side.
* **Animation with anticipation.** Every attack is anticipation → strike → follow-through, every shot draw → aim → release →
  recover, every cast gather → channel → release, a knock-out staggers, buckles, falls and settles. Each attack / cast
  clip declares its `impact` frame, and the arena starts the clip early so that frame is on screen **at the server's event**
  (`src/components/arena/actionClock.ts`). A hero moving against the way it faces plays its run cycle backwards (no
  moonwalking).
* **Rarity is prestige gear, not rings.** Rare: trim + a weapon glint. Epic: + pauldrons (spiked / a mantle), a weapon glow,
  sometimes a crest. Legendary: all four, gilded (a harness, a stole, a plumed or gilded crest, a jewelled weapon). The rarity
  aura is a few motes / sparks / embers at the feet — never a ring around the body.
* **A silhouette outline** (manifest `outline`): one clean 1 px outline around the whole composed figure, computed once per
  (hero, clip) — never per frame.
* **Shots leave the weapon.** Shooting weapons declare a `muzzle` (where the arrow / spell leaves on the impact frame); the
  arena launches projectiles from there.
* **The same on-screen size as v1** (nominal height 46 px); the frame grew to 88 × 72 in the design-library pass and to 96 × 80 with the archetypes.

Build / check / look:

```bash
pnpm sprites:build -- --set v2                       # ~3.5 min (18 skeletons, one at a time, ≈ 2.9 GB peak); --rigs warrior,warrior-brute,warrior-duelist and --id <scratch-id> for a quick partial preview build (build ALL of a class's skeletons, or its weapon falls back)
pnpm sprites:validate clank-dev-v2 --strict
pnpm sprites:preview -- --set clank-dev-v2 --contact --full --scale 2 --out contact.png   # 6 classes × 4 rarities × stance · move · attack · cast · hit · KO
pnpm sprites:preview -- --set clank-dev-v2 --class warrior --variety 20 --wrap 10 --labels --scale 3 --out w.png   # the 20-hero challenge
pnpm sprites:preview -- --set clank-dev-v2 --anim --rarity EPIC --out anim.png   # every frame: idle · idle2 · move · own attack · cast · hit · KO · victory
```

Tests: `tests/unit/sprite-assets.test.ts` and `tests/unit/rarity-sprite-assets.test.ts` run every check against **both**
sets (validator, catalogue coverage, every clip of every class composites, determinism, the six classes differ in silhouette
and colour, all 24 class × rarity combinations resolve and read at battle size, rarity is visible — v1 as overlays, v2 as an
equipment tier: every worn design belongs to the hero's tier and a higher tier is a different construction — and a Legendary
still looks like its class); `tests/unit/hero-design-library.test.ts` covers the packed format, the planner (tier pools, part
designs, junk rarities), determinism keyed only on never-rerolled values, slot independence, stances, the 20-hero challenge as an
automated floor (no two of 20 same-class, same-rarity heroes within 150 px of each other) and the atlas budget;
`tests/unit/sprite-variants.test.ts` the library's size per class and tier; `tests/unit/arena-presentation.test.ts` the impact
timing, backpedal, muzzles and the no-rings rule.

## 1. How a hero is drawn

```
persisted look (SpriteConfig)          sprite set (manifest.json + atlases)         canvas
 slot → catalogue item id     ─plan─▶   which layer blocks to use, z-order  ─tint─▶  one strip per
 skin / hair colour / hue                tint role per layer                  ─blit─▶  (hero, clip) → 1 drawImage per frame
```

* **Layers.** A hero is a stack of layers (body, outfit, eyes, mouth, hair, headgear, accessory, cape, weapon, off-hand, aura). Every layer lives on the **same frame grid**, so any compatible combination composites into one hero with identical timing and hitboxes. (LPC-style.)
* **Compose once, draw cheaply.** When a hero first needs a clip, its layers are composited into a single strip (tinted layers are blended onto their palette colour with `hard-light`: mid-grey = the colour, lighter/darker = highlight/shadow). From then on the arena does **one `drawImage` per hero per frame**. Composed heroes sit in a 48-entry LRU.
* **Data-driven.** What exists, where it is, how it animates and how it tints is described by `manifest.json`, validated by `src/domain/sprites/spec.ts`. Nothing in the renderer knows about these particular pictures.
* **Always something on screen.** If the manifest fails, the atlases fail, or the set lacks a hero's body/outfit, the hero is drawn with the original procedural **vector** renderer (`components/hero/drawHero.ts`) — the fallback is part of the design, not an afterthought. A missing *optional* layer (hair, accessory, aura…) is simply skipped. **A failed load is not final:** each atlas is retried before it is given up on, and a set that failed is retried with backoff (1.5 s · 4 s · 10 s · 30 s — `SPRITE_RETRY_MS`, `tests/unit/sprite-library.test.ts`), so one bad moment (a busy server, a flaky phone connection) never leaves a viewer on the vector heroes for the whole session — that fallback is what made heroes look like prototype blobs.

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
| IDLE | `idle` (loop) · `idle2` (loop, optional) | heroes stand here while the eight drop in and during 3·2·1 — each in its own STANCE (`plan.idleClip`: `idle2` when the set draws a second stance for the skeleton) |
| MOVE / RUN | `move` (loop) | **stride-locked**: the cycle advances with the ground the hero actually covers (≈ 62 units/s = the authored cadence, clamped 0.4–1.6×), so a slowed hero, a melee step-in during a wind-up or a backpedal plays as a WALK and a sprinting Rogue as a run — no sliding feet |
| ATTACK | `attack_slash` · `attack_thrust` · `attack_shoot` | chosen by the **weapon layer's** `attack` field (sword/mace → slash, daggers/staff/tome → thrust, bow → shoot); missing optional styles fall back thrust→slash |
| ABILITY / SKILL | `skill` | played on SKILL events; its `impact` (release) frame lines up with the event; the effect reads by its shape (shards, a shout, a light column, afterimages …), never as a ring |
| HIT | `hit` | lower priority than attack/skill so trading blows doesn't interrupt swings; a white damage blink (≤ 60 %, 60 ms) is drawn over *any* clip; a hero hit while running keeps its run cycle (flash + recoil) |
| KO / DEATH | `ko` (holds last frame, then fades) | |
| VICTORY | `victory` (loop, optional → falls back to idle) | the winner during victory/results |

Priority: `KO > VICTORY > latest of SKILL/ATTACK > HIT > MOVE > IDLE` (`animator.selectPlayback`, pure and tested). **No sliding feet:** once an
attack / skill clip is past its impact frame, a hero that is moving again shows its run cycle (the follow-through is cut short instead of gliding
across the floor in a planted pose). Rules 3.1.0 make this rare for ranged heroes — they stand still ≈ 300 ms before every shot and ≈ 100 ms after
it, which covers the whole draw → aim → release (283 ms lead) of `attack_shoot`. Attack and cast clips start `impact / fps` before the **server event** (`components/arena/actionClock.ts`), so the blow lands on screen with its damage number — and never before the bell; a set without `impact` frames simply starts the clip at the event. `backpedal` plays the run cycle backwards.

**Directions.** Heroes are authored facing **right**; `left` mirrors it (the arena only ever needs left/right). The manifest and renderer already support authored `down`/`up` blocks (`directions: { right:{index:0}, down:{index:1}, … }`) for future expansion — see `geometry.resolveDirection`.

## 4. Production art specification

Anything that satisfies the contract below drops in with **no code change** (new folder under `public/sprites/<set-id>/`, then set `visuals.spriteSet`). Verify with:

```bash
pnpm sprites:validate -- <set-id> --strict
pnpm sprites:preview -- --set <set-id> --out sheet.png        # renders it through the real runtime compositor
```

### Frame & anchor
* One frame size for **every** layer: `frame.w × frame.h`, 8–512 px each. v1 uses **80×64**, v2 **96×80**. 64–128 px is the practical range; wider-than-tall leaves room for long weapons and lunges.
* `anchor` = the point on the floor under the hero's feet, inside the frame. `nominalHeightPx` = feet-to-top-of-head height inside the frame; the arena scales so this equals its hero height, so **art of any resolution lands at the same on-screen size**.
* **Nothing may touch the frame border** (no opaque pixel on the outer 1 px ring) — the validator fails the set otherwise. Leave room for the longest weapon in the widest lunge, and for a hero lying down in `ko`.
* `pixelArt: true` (default) draws without smoothing — right for pixel art, and the arena scales by non-integer factors. Painted/HD art should set `"pixelArt": false`.

### Clips (rows) — frame counts
| clip | required | recommended frames | loops |
| --- | --- | --- | --- |
| `idle` | ✅ | 4–8 | ✔ |
| `idle2` | optional — a second stance | 4–8 | ✔ |
| `move` | ✅ | 6–8 | ✔ |
| `attack_slash` | ✅ | 4–8 (impact on frame 1–2) | |
| `skill` | ✅ | 4–8 | |
| `hit` | ✅ | 1–3 | |
| `ko` | ✅ | 3–6 | |
| `attack_thrust`, `attack_shoot`, `victory` | optional | 4–8 | victory ✔ |

Each clip declares `row`, `frames`, `fps`, `loop`, optional `impact`. Rows must be unique. Frames run left→right.

### Layer blocks & atlases
* A **layer block** is `cols × rows` cells (`cols` = max frames of any clip, `rows` = number of clip rows, × number of authored directions stacked vertically). **Every layer has the same block size.** Several layer blocks are stacked in one PNG atlas; the manifest records each block's top-left (`x`,`y`).
* PNG-32 with alpha, straight (non-premultiplied). Keep any atlas side ≤ 4096 px (mobile Safari) and the **total decoded size** reasonable: `clank-dev-v1` is 27.2 M px (≈ 109 MB decoded, 655 KB on the wire), `clank-dev-v2` 32.7 M px (≈ 131 MB decoded, 1007 KB) — most of it the rarity layers; the fourth v2 pass added 18 layers (class kits + item variants: +4.9 M px, +205 KB). Twelve atlases are fetched once, in parallel, at first view.
* `layers[id]`: `{ image, x, y, z, tint, of?, attack?, muzzle?, variants?, loop? }`. `muzzle` (shooting weapons): `{ x, y }` in frame pixels, authored direction — where the arrow / spell leaves on the impact frame of the weapon's attack clip.
* Optional manifest `outline` (`#rrggbb`): one 1 px silhouette outline around every composed hero.
* `z` orders layers back-to-front (dev: cape 5 · body 10 · outfit 20–22 · eyes 30 · mouth 31 · hair 40 · accessory 50 · headgear 60 · off-hand 65 · body arm 64 · sleeve 66 · weapon 70; aura −5).
* **Parts.** `of: "<owner id>"` makes a layer a part of another item, drawn at its own depth whenever the owner is worn (e.g. `outfit.heavy.front` — the sleeve that must sit *in front of* the torso — or `hair.2.back`). Parts cannot be nested.
* **Packed layout (spec 2)** — what v2 ships. `rigs: [...]` names the skeletons; a layer's `cells: { <rig>: [row per clip] }` stores, per clip, `[image, "x,y,w,h,ox,oy;…"]`:
  one TRIMMED cell per frame in base 36 (`-` = the frame draws nothing), identical cells shared. A skeleton has rows only for the clips its class
  plays (its own attack). A layer drawn for some skeletons only cannot be worn on the others. Weapons declare `rig` (the skeleton a hero holding
  them is animated with). Pages are grouped per skeleton, written as exact palette PNGs and named by content hash.
* **Variants.** `variants: ["<layer id>", …]` (≤ 64) on a catalogue item's layer: alternative drawings of that item. A variant may declare
  `tiers` (the rarities that wear it — the equipment tier), `weight`, `hides` (an open helm shows the hair) and parts of its own (`kit: false` on a
  part of the item's own drawing keeps it off the variants). The planner picks one per
  hero with `variantOf` (a pinned hash of the item id + skin + hair colour + hue — never a slot the player can change), draws it with the item's
  own parts plus any parts of the chosen variant, and takes the attack clip and muzzle from it. A variant naming a layer the set does not have
  is a broken manifest. A set without variants draws every item one way (v1).
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

* Heroes are drawn 84 hero-units tall on the stage (was 96): eight heroes no longer fill the floor, a melee pair in contact still reads as two
  figures, and the pixel art lands at ≈ 2× on a desktop stage.
* **Presentation spacing** (`components/arena/spacing.ts`): two living heroes standing almost side by side and closer than 38 units are DRAWN up
  to 8 units further apart each (eased, symmetric, never before the bell); the server's positions, distances and outcomes are untouched.
  Visibly overlapping pairs: 5.6 % → 3.1 % (543,251 samples, 600 battles).
* Plate text widths are measured once per font + name (not every frame), and the spawn state is cached per battle.
* Arena frame cost is ~8 `drawImage` calls (one per hero) + effects; no per-frame allocation in the hero path. Measured in a dev build while a fight played: **p50 16.7 ms · p95 17.6 ms (60 fps), 0 long tasks, 23 MB JS heap**.
* React does not re-render per animation frame: the canvas loop writes live HP/kills/status into an external store (`rosterStore`) that only the spectator strip subscribes to; the rest of the page updates once per second or per phase change.
* Composition is lazy (per clip, on first use) and cached; hero strips for a battle are built while the eight stand idle.
* Network per battle: **0** sprite requests (loaded once per page) and one replay request (served only after picks lock — see `docs/SECURITY.md`).
* Cost of the dev sets — v1: 12 PNG atlases, 655 KB transferred / ≈ 109 MB decoded. v2 (design library): 1,332 layers on six skeletons in
  7 palette-PNG pages, **12.8 Mpx ≈ 51 MB decoded** (the block-layout v2 before it: 32.7 Mpx ≈ 131 MB) and **≈ 3.1 MB transferred** (2.8 MB
  of PNG + a 1.3 MB manifest served gzipped as ≈ 0.3 MB; the block v2: 1.0 MB). Per-frame trimming, de-duplicated cells and one row of attack
  per skeleton are what make ~30× more art fit in less memory. A composed hero strip grew with the frame (88 × 72 vs 80 × 64: +24 %).
  **Archetype pass:** eighteen skeletons, one page each (1.7–3.15 Mpx, 19 pages with the auras): **40.2 Mpx for the whole library, 8.1 MB of
  PNG + a 3.8 MB manifest served gzipped as 0.84 MB** — but a browser only ever decodes the pages of the heroes it draws: an arena of eight
  fetches ≤ 8 pages (≤ 25 Mpx in the worst case, eight different skeletons; typically 5–6 pages ≈ 11–14 Mpx), the rest is never requested.
  Measured on the stage (production build, eight heroes): desktop 1280×800 and laptop 1440×900 @2× frame p50/p95 16.7 / 16.7 ms, 0 long
  tasks; a 375 px phone @2× the same; a 4×-CPU-throttled 390 px phone @3× 16.7 / 16.7 ms with 2 long tasks (148 ms) at battle start; JS heap
  19–40 MB. A composed hero strip grew with the frame (96 × 80 vs 88 × 72: +21 %).
* **Composition is cheap and early.** A tinted packed cell is coloured on a frame-sized scratch canvas (the composite passes never touch the
  whole strip); atlases are decoded (`img.decode()`) before the set is marked ready; during the intro and 3 · 2 · 1 the arena composes the
  clips each hero will need, one strip per frame (`ArenaRenderer.warmSheets`) — measured on a 4×-throttled phone: 1–2 long tasks (57–133 ms) per
  battle, frame p95 16.8 ms.
* v2's outline is computed once per composed strip. **Status and hit overlays** (the hit blink, the cool cast of a slow, the shield's shimmer
  band) draw the hero's cached flat SILHOUETTE strip (`HeroSheet.silhouette`, built once per clip and colour) at low alpha over the hero — no
  per-frame scratch canvas. The scratch-canvas version could reuse a canvas before the browser had rasterised the previous draw from it, and
  under load heroes came out see-through ("ghosts" in busy fights, seen in headless QA on a loaded machine).
* A phone-sized stage (< 480 css px) renders at most 2× device pixels (profiled on a 4×-throttled phone: our script is ~6 % of a frame; the
  rest is the browser filling and compositing the canvas).
