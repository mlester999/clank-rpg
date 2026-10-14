# Hero art — the production path (brief for an artist or studio)

> **Update:** hero renderer v3 ([SPRITES_V3.md](SPRITES_V3.md)) replaces v2's layer pipeline with an anatomical 2.5D pixel renderer (IK grips,
> per-pixel depth, head-anchored faces, stride-locked walks). The brief below still applies to hand-authored art on the atlas contract.

**Where we are.** The heroes on screen today (`clank-dev-v2`, "hero renderer v2") are **procedurally generated stand-in art**: vector shapes
posed on a skeleton, rasterised at 4× and posterised into pixels by `scripts/sprites/v2`. They are consistent, readable and fully wired
(every hero's stored look, class, rarity and identity traits draw correctly; attacks line up with the server's events), and the last three
passes pushed them as far as the generator sensibly goes — class silhouettes, open-faced steel helms, round heads with brows, tapered
limbs and mitten hands, selective (colour) inner outlines, cloth folds, per-class kit pieces (scabbard, bevor, sash, mantle, collar, amice),
two drawings of every class weapon and headgear chosen per hero, an upright resting bow, rarity as gear instead of glow. **They are not production art and
cannot become it**: shapes are drawn by formula, so faces, hands, cloth and armour never get the deliberate pixel placement, hue-shifted
ramps and per-frame clean-up that a pixel artist gives a 46 px character. Further generator work has diminishing returns.

**Sixth pass (archetypes).** Each class is now drawn on three skeletons (builds, grips, stances and pose languages — see SPRITES.md §0.1), which
is the biggest same-class variety the generator can give; a production artist would author the same three body bases per class (or keep one and
vary the equipment), on the same contract.

**Recommendation.** Commission hand-drawn **class base sheets + layered equipment** to the existing sprite contract (`docs/SPRITES.md` §4).
The engine, the manifest format, the compositor, the stored hero looks and the arena timing all stay as they are: a finished set is a new
folder under `public/sprites/<set-id>/` plus one setting (`visuals.spriteSet`). No hero is re-rolled — the art is drawn *for* the existing
catalogue ids, so every hero keeps exactly the parts it already has.

## 1. Format (fixed by the engine)

| | |
| --- | --- |
| Frame | **96 × 80 px** recommended (80 × 64 today). Nominal hero height (feet → top of head) **58–64 px**. Anything 64–128 px works: the arena scales by `nominalHeightPx`. |
| Anchor | one foot anchor for every frame of every layer (bottom-centre of the feet), e.g. (40, 74). Feet must not drift between frames (no bouncing origins). |
| Border | no opaque pixel on the outer 1 px of any frame (validator rule): leave room for the longest weapon in the widest lunge and for a hero lying down. |
| Direction | authored facing **right**; left is mirrored. (Down/up blocks are supported by the format if ever wanted.) |
| Colour | PNG-32, straight alpha. **Tintable layers in neutral grey** (mid-grey #808080 = the hero's colour exactly, lighter = highlight, darker = shadow); metal, wood, gems, faces' eyes/mouths in real colours (`tint: null`). |
| Outline | dark outline on the **outer silhouette only**; interior lines in a darker shade of the local colour (selective outlining). The compositor can add the outer outline (`manifest.outline`), so layers may be drawn without it. |
| Light | one light direction for every layer: from the top-front. 3–4 tone ramps per material, hue-shifted shadows. |

## 2. What to draw (each one a layer on the same frame grid)

| Slot | Ids (catalogue) | Notes per class |
| --- | --- | --- |
| Body | `body.base` (+ `body.arm`, the near arm in front of the outfit) | one body, skin-tinted; 2–3 head shapes are welcome as separate catalogue items later |
| Outfit | `outfit.medium` (Warrior: tabard over mail) · `outfit.heavy` (Tank: plate) · `outfit.light` (Rogue: jerkin; Ranger: leathers) · `outfit.robe` (Mage, Cleric) | each with its `.trim` and `.front` (near sleeve) parts; class colour = primary tint |
| Weapon | `weapon.sword` · `mace` · `daggers` · `bow` (+ `bow.quiver`, on the back) · `staff` · `tome` (Cleric's holy kit: sun scepter + tome at the hip) | real colours; mark the **muzzle** (where the arrow / spell leaves) for bow, staff, tome. Optional: class kit parts (`of: weapon.<x>`) and second drawings (`variants`) — see SPRITES.md |
| Off-hand | `offhand.shield` (Tank tower shield) | the Tank's silhouette — big, in front |
| Headgear | `helm` (Warrior/Tank, open-faced — the face must read) · `hat` (Mage) · `hood` (Rogue, masked) · `cap` (Ranger, feathered) · `halo` (Cleric) · `crown` | a helm hides hair |
| Face | `eyes.0–3` · `mouth.0–2` | these are hero IDENTITY traits — keep four distinct eye styles and three mouths; add brows to the eye layers |
| Hair | `hair.0–6` (+ `hair.2.back`) | hair-tinted |
| Extras | `accessory.goggles · scarf · cog-pin · monocle · headset`, `cape.default` | cape is drawn behind the body |
| Rarity | `trim.<rare/epic/legendary>.<body>` · `shoulder.…` · `crest.<rarity>.<headgear>` · `weaponfx.<rarity>.<weapon>` · `aura.ring/sparks/flame` | rarity-tinted; see §4 |

## 3. Animations (rows) — and the timing the combat engine expects

| Clip | Frames · fps | Required poses | Engine timing it must match |
| --- | --- | --- | --- |
| `idle` (loop) | 6 · 7 | breathing, weapon settles | shown during intro and 3 · 2 · 1 |
| `move` (loop) | 6–8 · 12 | contact · down · pass · up, both sides; arms counter-swing | the cycle is **stride-locked** (it advances with ground covered), so any cadence works; author one full stride ≈ 28 world units |
| `attack_slash` | 6 · 14, **impact frame 2** | anticipation (weapon cocked) → swing → impact → follow-through → guard | melee wind-up is 200 ms (Rogue 100, Tank 300): the impact frame is shown at the server's hit |
| `attack_thrust` | 6 · 14, impact 2 | coil → full extension → retract | daggers, staff, tome |
| `attack_shoot` | 6 · 12, **impact 3** | raise → draw → aim (still) → release (string snaps) → follow-through → lower | the archer stands still ≈ 300 ms before the release and ≈ 100 ms after: frames 0–3 must read as standing |
| `skill` | 6 · 12, impact 3 | gather → channel → release → hold → settle | casts and telegraphed skills |
| `hit` | 3 · 12 | recoil away from the blow, recover | a short white blink is drawn over any clip; the run cycle is kept when hit on the run |
| `ko` | 6 · 9 | stagger · knees buckle · fall · hit the ground · bounce · lie still | held, then the arena fades the body |
| `victory` (loop) | 4 · 8 | arms up / weapon raised | winner during results |

## 4. Rarity — what each tier must add (on the gear, never as a glow around the body)

* **Common** — clean, simple, finished equipment. No ornament.
* **Rare** — refined: piped edges, a lit blade edge / fletched arrow, a better buckle.
* **Epic** — a premium silhouette change: pauldrons on the upper arm (or a draped mantle for robes), a gem crest on the headgear, a rune-lit weapon. Capes appear (in the class's own dark accent colour).
* **Legendary** — exceptional, class-specific pieces: winged / plumed helm crest, a jewelled weapon with a trailing ornament, a gilded belt and clasp. **Gold is an accent, not a coat of paint** — the class colour must still dominate the figure.

## 5. Acceptance (how a delivery is checked)

```bash
pnpm sprites:validate -- <set-id> --strict      # contract: every catalogue id drawn, no frame touches its border, anchors consistent
pnpm sprites:preview -- --set <set-id> --contact --scale 3 --out contact.png   # 6 classes × 4 rarities: idle · move · attack · cast
```

Then on the stage (desktop and a 360 px phone): eight heroes readable at battle size without names; each class recognisable from its
silhouette alone; a Legendary next to a Common of the same class reads as the same class, better equipped; no sliding feet; no weapon through
the body in idle or move; the release frame of a shot lines up with the arrow leaving.

**Scope estimate.** One body, four outfits (+ trims / sleeves), six weapons, one shield, six headgear, eleven face parts, seven hair styles,
five accessories, one cape and the rarity sets — about 100 layers × 9 rows × up to 6 frames. A sensible order: (1) Warrior and Ranger complete
(body, their outfit, weapon, headgear, one rarity ladder) as a style test in the arena; (2) the other four classes; (3) hair / accessories;
(4) the full rarity ladder.
