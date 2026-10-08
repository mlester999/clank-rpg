# Arena audio — the sound of the Live Arena

> Code: `src/domain/audio/*` (the synthesis toolkit `dsp.ts`, the 45-sound catalogue `sounds.ts`, the finishing pass `render.ts`, the mixing policy `policy.ts`, event → sound mapping `cues.ts`,
> analysis helpers `analysis.ts`), `src/components/arena/audio/*` (the engine `ArenaAudioManager.ts`, the speaker button `SoundToggle.tsx`, the saved choice `audioPrefs.ts`, the hook
> `useArenaAudio.ts`), the stage hooks in `ArenaRenderer.ts` / `ArenaScreen.tsx`, `scripts/audio-preview.ts`.
> Tests: `tests/unit/arena-audio-{synth,policy,cues,manager}.test.ts`, `tests/unit/arena-sound-toggle.test.ts`, `tests/support/fakeAudio.ts`.

## The rule

**A sound exists only because the server recorded the thing it describes.** The renderer's replay events (the verified battle the server released at the bell) and the authoritative clock (3 · 2 · 1,
the bell, the winner) are the only sources. The browser decides nothing about combat and invents no sound: no random effects, no "impact" for a hit the server did not record.

## What plays when

| Moment | Sound | Source |
| --- | --- | --- |
| next round is forming | `round_ready` (soft chime) | the battle's `startsAt` |
| 3 · 2 · 1 | three rising beeps (D5 · E5 · F♯5) | the countdown on the **server** clock (`combatStartsAt − n × digit`) |
| FIGHT | a distinct, stronger horn + boom | `combatStartsAt` — never earlier |
| basic attacks | sword / mace / dagger swing, bow release, arcane orb / holy bolt cast | `ATTACK` events, by the attacker's class style |
| impacts | sword · mace (deep, weighty) · dagger (sharp) · arrow · magic · holy hit; AoE; crit ping; whiff | `HIT` / `MISS` events, by the attacker's weapon; a sweep that hits five heroes is ONE impact |
| named abilities | cleave · charge · ground slam · shadowstep · evasion · volley · snare shot · arcane burst · frost nova · smite · sanctuary | `SKILL` events (a cast with a cast time is heard twice: the cast now, the ability when it resolves) |
| defence / support / status | shield · healing pulse · stun · slow (frost) · taunt horn · buff / empower | `SHIELD`, `HEAL`, `STATUS` events; a lifesteal heal is silent (the strike already sounded) |
| KO | `ko`; the last opponent's falls with the bigger `ko_final`; one `final_duel` stinger when three or more started | `ELIM` events |
| winner | `victory` (rewarding, not the loudest thing in the pack) | only after the fight is over **and** the verified winner is in hand |
| results | `results` chime | `resultsStartAt` |

## The speaker button

Bottom-right of the Live Arena (inside the stage, clear of the combat HUD; the stage hint keeps clear of it). A real `<button>`: keyboard-operable, visible focus ring, 44 px touch target, an accessible name that says what a
press does, a tooltip on hover **and** focus.

| State | Icon | Tooltip · label |
| --- | --- | --- |
| sound on and playing | speaker with waves | **Sound On** · "Mute Arena sound" |
| muted | speaker with an X | **Sound Off** · "Turn Arena sound on" |
| preference on, browser has not allowed sound yet | waves + one pulsing dot | **Enable sound** · "Enable Arena sound" |
| no Web Audio / audio error | disabled | Sound unavailable |

The choice is `localStorage["clank.arena.sound"]` (`on` | `off`, default `on`) and it is written **only** by clicking the button (or another tab doing so): a page load, refresh, navigation, tab restore, visibility change or an
audio error never changes it. Unreadable storage falls back to the default; nothing throws.

## Autoplay, done honestly

Nothing sounds before the browser allows it. The `AudioContext` is created **inside a real user gesture** — a click on the speaker, or the first trusted tap / key press anywhere while the saved preference is "on" — never on load
and never from a timer; a script-dispatched event never unlocks it. A refused gesture leaves the quiet "Enable sound" invitation (no popup, no error, no repeated nagging). Muted means silent **now**: every voice is cut, the master
gain goes to zero and the context is suspended. A hidden tab is silent and parked; a returning tab starts with a clean slate (stale cues are refused by their own age, never replayed). A back/forward-cache restore invalidates
everything scheduled. Every public method of the engine swallows its own failures: a broken audio stack costs the sound, never the Arena.

## Mixing

One engine per page (never per render): cue → policy → `AudioBufferSource` → voice gain → gentle stereo pan (by where the fighter stands) → bus → **master gain (0.8 × internal volume 0.85)** → bus compressor tuned as a limiter. Every effect is
first brought to the same loudness (−16 dBFS over its loudest 120 ms) and then moved by its own trim, so the pack sits inside a 14 dB band. The policy: a cue key is accepted once (a remounted renderer, a retried request or a restored tab
cannot replay it); a sound repeated faster than its own gap is thinned; at most N copies of one sound and 14 voices overall; when the mix is full an important cue (priority 0: the countdown, the bell, the last KO, the winner) takes the least
important voice and an unimportant one is dropped; the bell and the winner briefly duck the ordinary effects; pitch varies ± a few semitones **deterministically from the cue's key** (the same event always sounds the same). A combat cue older
than 260 ms (a stalled frame, a tab that slept) is dropped, not played late.

## The sounds themselves

Original, synthesised in code (pulse / triangle / noise voices, short envelopes, a little saturation — a retro-RPG identity). **No samples, no downloaded packs, no third-party assets, nothing to attribute.** The whole pack is rendered
once per browser on first use (deterministically: the same samples on every machine, in Node and in the browser) and held as `AudioBuffer`s — **no audio files ship**. `pnpm audio:preview -- --out <dir>` writes the 45 sounds as 16-bit WAVs
(27 s, 1.7 MB), a spectrogram contact sheet (`sheet.png`) and `metrics.json`, so they can be listened to and reviewed.

## Verified in real Chrome (a tap on the live Web Audio graph)

Review artifacts (not committed) are written to `.data/qa-chat-audio/` by the QA harness. Over whole battles, on a production build against scratch infrastructure (38 checks, all passing): no `AudioContext` before a gesture; the first tap unlocks it; the countdown beeps start within
within ±10 ms of the server's T-3 / T-2 / T-1 and the FIGHT cue at the bell; no combat sound before the bell; one KO sound per elimination in the server's replay; the winner after the fight ends; no clipping (peak 0.68–0.74); sustained combat averages ≈ −19 dBFS RMS
(p90 −15, short-term peak −3 dBFS); mute silences the output within 100 ms and parks the context; the saved choice survives a refresh; a tab joined mid-fight plays no burst of old sounds; a hidden tab is silent.
