# Hero profile — the left column

> Code: `src/components/character/HeroIdentity.tsx` (the panels), `HeroView.tsx` (data + wiring), `src/components/hero/rarity.tsx` (`RarityPlaque`),
> `src/components/ui/Icons.tsx` (class + action icons), `src/domain/heroOwnership.ts` + `src/content/heroOwnership.ts` (who owns the hero, and the copy).
> Tests: `tests/unit/hero-profile-ui.test.ts`, `tests/security/http.test.ts` ("a hero's own Arena availability …").
> UI only: nothing here computes PWR, rarity, class, rank or Arena stats — they arrive finished from `/api/heroes/<id>`.

## Two panels, not a stack of cards

| Panel | Holds |
|---|---|
| **Identity** (`HeroIdentityPanel`) | the rarity's arena artwork → profile photo + the hero's name (the dominant text) → **rarity** plaque + **class** tag → class tagline → **ownership** block → **actions** |
| **Standing** (`HeroStandingPanel`) | **Combat power** (PWR, the biggest number) and **Development rank** (name + points + one progress bar) |

Below `lg` the two panels are simply the top section of the page (no skinny sidebar): on tablets the art sits beside the details and PWR sits beside
the rank; on phones everything stacks. From `lg` they are the 320 px left column; the column sticks to the top only when the window is tall enough to
show all of it (`.hero-rail` in `globals.css`) — otherwise its bottom would be unreachable.

## Rarity, class and ownership look different on purpose

| | Visual language | Not colour alone |
|---|---|---|
| **Rarity** | a chamfered, collectible plaque in the tier's colour (Common: quiet steel · Rare: blue · Epic: violet · Legendary: gold, with a glow that grows with the tier) | the tier's icon shape (● ◆ ✦ ♛) and its name |
| **Class** | a dark tile with a class glyph tinted with the class colour: Warrior sword · Mage staff · Rogue dagger · Ranger bow · Tank shield · Cleric holy cross (an unknown class falls back to crossed swords) | the glyph and the name |
| **Ownership** | an account-status block with its own icon: claimed (green ✓) · unclaimed (dashed, open padlock) · hero found (teal link + Claim) | the icon and the label |

## Ownership states (`heroOwnership`, pure)

`TEAM` and `DEMO` (nothing to claim) · `UNCLAIMED_SIGNED_OUT` (CTA: **Sign in with Telegram**) · `UNCLAIMED_CLAIMABLE` (signed in as this hero's member:
**Claim this hero**) · `UNCLAIMED_OTHER` (signed in as somebody else: no CTA) · `CLAIMED_OWNER` · `CLAIMED_PUBLIC`.

**Arena availability** — "ARENA SUSPENDED" / "Not in the Arena" — is told to the hero's own member only. `/api/heroes/<id>` returns `self: { heroStatus }`
**only** when the signed-in member is looking at their own hero (one extra read); the public hero data has no status, and nothing — here or anywhere on
the page — says *why*. A suspended hero keeps its history and rank and simply doesn't enter new Arena rosters (`arenaEligibility.ts`); it can't be
claimed (the server refuses), so the Claim button is not shown for it.

## Actions

* **View hero card** → `/heroes/<publicId>` (the public page).
* **Download** → `/api/hero-cards/<publicId>?download=1`: the server draws the *current* card as a PNG (no stale content key).
* **Share** → a disclosure with **Post on X** (a web intent: it can't attach the image, so the card is downloaded and added by hand — the panel says so)
  and **Copy link** (the canonical `/heroes/<publicId>` URL, via the shared `copyText` helper in `src/lib/clipboard.ts`). The browser's native share
  sheet is not used. `Esc` closes the options and returns focus to **Share**.

All three are real links / buttons (keyboard reachable, visible focus ring, 44 px targets); on a phone View is full width and Download / Share sit in two columns.

## Copy rules

Short and plain. PWR reads "An estimate of this hero's combat strength." — no tier ranges ("Common tier: 130–149"), nothing that suggests PWR decides a fight;
the long explanation lives in `/docs`. Pinned by `hero-profile-ui.test.ts`.
