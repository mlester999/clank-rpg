# Arena — responsive layout, name plates, results and compact chat

UI and presentation only. Nothing here touches combat, the Arena scheduler, picks, rewards, PWR, rarity, Telegram ownership, the leaderboards, daily
rerolls or season state, and nothing needs a migration. Historical replays render exactly as before (the renderer still plays the server's verified
frames; it only decides where *names* hang).

## What was wrong (root causes)

| Symptom on a phone | Root cause | Fix |
|---|---|---|
| Names above heroes in the 3·2·1, gone during the fight | `drawPlates` had a deliberate `narrow` branch (stage < 480 css px): *compact before the bell, HP bar only during combat* | one plate per living hero in **every** phase and on every size (`nameplates.ts`) |
| Results: "RESULTS" clipped, winner cut off, runner-up off-stage | a fixed `grid-cols-[1.2fr_1fr]` whose tracks have a `min-content` minimum, so a long unbreakable name (Bungee, `truncate` has no effect on a grid item's minimum) widened the grid past the stage; the stage's `overflow-hidden` then silently clipped it. 132 px / 96 px portraits and `p-3` cards were desktop numbers | `ResultsPanel.tsx`: `minmax(0, …)` tracks, rem-sized portraits scaled by CSS, names that wrap and clamp, layout chosen from the **stage's** width (container queries), content measured against the stage's height |
| Sound button over "NEXT BATTLE IN" / the runner-up | the results column ignored the bottom-right corner | the footer is ≥ 3 rem tall and keeps 3 rem clear on both sides; the speaker is a measured safe zone for plates and floating text |
| "PICKS OPEN FOR THE NEXT FIGHT — SCROLL DOWN TO PICK" wrapped into fragments | one `chip` sentence in a 254 px lane, free to break anywhere | `PicksOpenHint`: two unbreakable lines (title over guidance) on a narrow stage, one line with a divider on a wide one |
| Chat far too tall | `h-[18.5rem] sm:h-[26rem] lg:h-[30rem]` for the *history alone*, plus header and box | one fixed **total** panel height (240 / 280 / 300 px) with the history scrolling inside |
| Floating numbers could leave the stage | numbers were placed at `hero.x ± 22` with no bounds | every floating text is fitted to the stage and nudged out of the measured reserved boxes |
| Damage numbers landed **on top of a neighbour's name** ("Wiz**20**", "Pix**10**") once names stayed up for the whole fight | a number rises from above *its own* plate; in a crowd the plate of whoever stands above it is in the way, and the number layer is drawn over the plates | `fitText` also keeps every number, KO and skill label off the plates drawn that frame: it steps to the nearest free spot beside or above (≤ 3 passes), moves away within ~40 ms and comes back over ~110 ms, so nothing flickers. Measured over whole simulated fights: 35 % of number-frames sat on a plate at 390 px before, 1.4 % now |

What was **not** the cause: the canvas scaling. The wrapper's `aspect-[800/780]` (< 640 px) and `sm:aspect-[5/3]` match the renderer's two cameras
(`TALL` 800×780, `WIDE` 1000×600), so the logical → screen transform is uniform and never distorts; DPR is capped at 2 on a phone. No `overflow:hidden`
was added to hide anything: where something used to be clipped it now actually fits.

## The stage coordinate system

The stage has one logical space per camera (`scene.ts`: `TALL` 800×780 · `WIDE` 1000×600). Everything drawn on the canvas — heroes, plates, floating
numbers, the kill feed, the 3·2·1 — lives in it; the canvas is scaled to the stage's css box by one uniform factor (`cpl`, css px per layout unit).
Page elements laid over the stage (the Survivors plate, the sound button) are **measured** (`[data-stage-reserve]`, css px from the stage's corner) and
handed to the renderer (`setReserved`), which converts them to layout units and keeps plates and floating text out of them. Nothing scales an
authoritative position: hero coordinates, collisions and replays are untouched; only *presentation* offsets move.

## Name plates (`src/components/arena/nameplates.ts`)

* Four modes: **full** (name · class · HP — wide stage, before and after the fight), **compact** (name · HP), **tag** (bare outlined name over a thin HP
  line) and **bar** (HP only). A plate falls down this list only when it cannot fit; a hero buried in a pile is the only one that ever shows a bar.
* Names are never drawn below **10.5 css px**, even at 320 px. A small stage gets *shorter* names instead (10 characters under 400 px, 12 under 560,
  16 above — measured, with an ellipsis, grapheme-safe); the full name is in the roster cards below (and the hero profile). The stored name is untouched.
* Placement is front-to-back: the viewer's picked hero first, then the lowest on screen. A plate hangs straight above its hero's head; if that spot is
  taken it steps **exactly** far enough sideways (≤ 1.2 plate widths) or up (≤ 2 rows) to clear the plates already placed, the measured boxes and the
  stage edge. A displaced plate shows a thin leader to its hero's head.
* The kill feed (top-right, ~4 s) is a **soft** obstacle: plates keep out of it when they can, and a plate that would otherwise be reduced to its HP bar takes the
  spot anyway (painted above the feed) — a name outranks a caption. (At 320 px / phone-landscape a winner standing near the top used to lose its name for ~1 s
  of the victory because the feed and the Survivors plate left no free spot.) Floating numbers, KO and skill labels also keep off the plates (`fitText`).
* Stable: a plate keeps the side it chose until that stops fitting; a richer mode is taken back only after ~0.28 s; the step aside is eased (~0.1 s)
  while the plate itself is glued to the head (a running hero takes its name with it); a plate **never glides across a neighbour** — if it cannot ease
  there it lands on its target and fades in over 0.16 s instead of hopping.
* Cost: a few rectangle tests per plate per frame, and the layout returns after one check when nothing overlaps. Text widths are memoised.

## Results (`ResultsPanel.tsx`)

* **Stage < 36 rem wide (phones, narrow stages):** two compact horizontal cards in one column — small portrait beside name, class · PWR and
  stats; the winner is the larger card, then the runner-up.
* **Stage ≥ 36 rem (tablets, laptops, desktops):** two vertical cards side by side, winner larger.
* **Height is measured.** After every render the panel checks whether its content overflows the stage and steps down a density tier (title folded
  away → tighter cards, smaller portraits → one-line names) until it fits, before paint. A taller stage starts again from the roomiest tier.
* Only the server's result row is shown (KOs, damage, HP left, gold when awarded). A runner-up with no row yet still shows name, class, PWR.
* The phase lengths are unchanged (5 s of results, then the next battle); nothing was extended to make room.

## Fighter cards (`SpectatorStrip.tsx`)

Avatar never shrinks, name and class lines truncate inside the card (never into the rarity mark), HP and KO/damage wrap onto two lines instead of colliding on a narrow card,
and the status row is one fixed line that *wraps inside its height* — a pill that does not fit drops out whole instead of being cut in half by the card edge (a "+1" pill
did exactly that on a 140 px card at 320 px).

## Chat (`src/components/arena/chat/*`)

Total panel height (header + history + message box): **240 px** phone · **280 px** tablet (≥ 640) · **300 px** desktop (≥ 1024). The history is the
only part that scrolls. Behaviour rules live in `scrollRules.ts` (follow at the bottom, stay put when reading, "New messages" indicator, keep your place
when older history loads); the keyboard rules in `keyboard.ts`. Realtime, Telegram sign-in, persistence, anti-spam, moderation and reconnection are
untouched. Also fixed on the way: the message box stayed two lines tall after sending a message that had wrapped (it was measured before React cleared
it).

## Verifying

**Automated** — `pnpm test` (new/extended: `arena-nameplates`, `arena-stage-names`, `arena-floating-text`, `arena-results-panel`, `arena-stage-overlays`, `arena-chat-compact`,
`arena-chat-scroll`, `arena-mobile-layout`), `pnpm typecheck`, `pnpm lint`, `pnpm build`. The stage tests drive the *real* `ArenaRenderer` over real simulated fights (a
recording canvas stands in for the browser), including a fight under the retired storm-ring rules (1.0.0) so historical replays are covered.

**Real browser** (headless Chrome over CDP, against a scratch Postgres + a Realtime stand-in — never the live database; the production build, from a clean copy of the tree
that contains no `.env`):

| What | Result |
|---|---|
| Arena phases (intro/picks, 3·2·1, FIGHT, early/8/4/2 left, victory, results ×2, next battle) | all 13 captured at 390 / 320 / 360 / 430 / 820 / 1440 px; the four key phases at 375, 414, 768, 900, 1024, 1280, 1366, 1600, 1920 px and four landscape sizes |
| Canvas text audit (`fillText` tapped on the arena canvas, every draw measured against the canvas) | **459,905 draws, 0 clipped** (181,521 on phones) |
| DOM audit (page overflow, anything outside the stage, result cards inside the stage / not scrolling / not under the speaker, picks hint not wrapping or touching the speaker, fighter-card text inside its card) | 0 failures at every size after the pill fix |
| Names in the fight (share of living hero-frames that had a name drawn) | 100 % in the 3·2·1 and 100 % in the victory at every portrait/desktop size; combat 99–100 % (portrait), 92 % phone-landscape 667×375 and 83 % 844×390 in the crowded opening — a 450×270 px stage cannot hold eight 10.5 px names, so a hero buried in a pile shows its HP bar. Smallest name ever drawn: 10.5 css px |
| Chat | 27/27: height 300 / 280 / 240 px (was 619 / 555 / 435), no horizontal overflow at 320–1440 px, name left / time far right, long names and 280-char messages, follow-the-bottom with no panel/page growth, "New messages" indicator, older history keeps the reader's place, realtime drop → reconnecting → live |
| Keyboard | Android-style (layout viewport shrinks): box fully visible. iOS-style (only `visualViewport` shrinks, driven through the real `ChatComposer` with a controllable `visualViewport`): box inside the visible area, bottom nav steps aside and returns |
| Sound button | 15/15 at 390 / 320 / 1440 px: 44 px, 4–8 px from the stage corner, toggles on/off, preference persists across a reload |
| Address bar / rotation | stage and canvas unchanged for 844 → 760 → 664 px tall viewports; rotating mid-results re-fits (landscape tier 2, portrait tier 0), cards stay inside |
| Offline | stage keeps playing the last battle, "Reconnecting…" chip on its own row, recovers on its own; the "Arena paused" waiting screen fits at 320 px |
| Frame times (production build, headless software GL — no real GPU) | desktop 1440×900: before 59.5–60.0 fps in 5 of 7 runs, after 59.3–59.8 in 4 of 7; the other runs of *both* builds sit in a 54 fps mode (every 10th frame two vsyncs) — renderer 26–29 % and GPU process 70–79 % of a core in both builds. Phone 390×844 at 4× CPU throttle: before 56.5 / 59.7 fps, after 57.0 / 57.4, p95 16.8 ms in both. Main-thread script time: before 80–118 ms/s, after 99–112 ms/s |

**Not tested, and why:** Mobile Safari / iOS and desktop Safari. The development machine has only the Xcode command-line tools (the iOS Simulator needs full Xcode) and Safari's
"Allow remote automation" is off, so neither WebKit nor a real on-screen keyboard could be driven. WebKit-specific behaviour (container queries, `svh`, canvas text metrics) is
therefore unverified; the iOS keyboard rules are verified against a stand-in `visualViewport`, not a device.

Screenshots (before / after and every state above): `docs/qa/arena-responsive/`.
