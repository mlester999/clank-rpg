# Player sign-in (Sign in with Telegram) — signed-out / signed-in behavior

> Admin authentication is separate (`clank_admin` cookie, `ADMIN_ACCESS_KEY`) and is not described here.
> Code: `src/components/nav/AppShell.tsx` + `AccountControl.tsx` (navbar), `src/components/character/SignInPanel.tsx` (widget),
> `src/app/api/me/route.ts`, `src/app/api/auth/{telegram,logout,dev}/route.ts`, `src/server/http/guards.ts`, `src/server/auth/session.ts`.
> Tests: `tests/unit/account-control.test.ts`, `tests/security/auth-signed-out.test.ts`, `tests/security/http.test.ts`.

## Incident: "the navbar shows a generic user icon and there is no Sign in with Telegram"

Three independent causes, one of them in production configuration:

1. **Production had no Telegram login configured.** On `www.clankrpg.fun`, `/api/me` returned `login.telegramBot: null` and `POST /api/auth/telegram`
   answered `503 LOGIN_UNAVAILABLE` — which the server returns only when `TELEGRAM_BOT_TOKEN` is unset. So `/character` showed "Telegram sign-in isn't connected
   on this server yet" and no widget could ever render. **This needs Vercel environment variables (below) and a redeploy; no code change can fix it.**
2. **The navbar had one control for everyone.** Signed out or in, it was the same ghost button with the generic user icon linking to `/character`; the label
   ("Sign in") was hidden below 480 px, so on phones it was just an icon, and while the answer was pending it read "…". Nothing said *Telegram*, and nothing
   distinguished "not signed in" from "account".
3. **The header overflowed at common laptop widths.** At 1280 px the production header was 153 px wider than the screen (the desktop nav plus the five "coming
   soon" links), pushing the sign-in/account control off-screen; the page scrolled sideways. (Separately: below 640 px the "Sign out" button was hidden, so a
   phone user could not sign out.)

## Behavior now

| | Signed out (anonymous) | Signed in |
|---|---|---|
| Server (`GET /api/me`) | `viewer: null`; **no cookie is ever set**; `login.telegramBot` = the bot username only when the widget can work | `viewer: { displayName, characterId, claimed, … }` |
| Navbar | teal **✈ Sign in with Telegram** (short "Sign in" + the Telegram mark on phones narrower than 560 px and between 1024–1279 px, where the desktop nav needs the room; the accessible name is always "Sign in with Telegram"). No avatar, no name, no menu, no sign-out, no user icon | avatar + name button → menu: **Your hero** (or *Your character*) · **Inventory** · **Sign out** (Esc / outside click / navigation close it) |
| While the answer is pending | a blank pill — neither the account button nor the sign-in button | — |
| If `/api/me` fails or takes > 8 s | the sign-in button (an unknown state never becomes "signed in"); a state already known is kept | kept |
| `/character` | the **Sign in with Telegram** panel (widget), "How heroes work", and the public hero search | the member's hero page |
| `/inventory`, protected actions | "Sign in to see your inventory" → *Sign in with Telegram* → `/character`; protected API routes answer **401** | works |

There is **no guest account**: nothing is created for an anonymous visitor. A session exists only after a verified Telegram login
(`POST /api/auth/telegram` verifies Telegram's HMAC against the bot token, the `auth_date` freshness and replay).

**`/character` is intentionally public** — it is the sign-in page *and* the public explainer / hero search — so the navbar CTA links there. It is not a
protected route; what it shows depends on the session.

## Cookies and sessions

* `clank_session`: signed (HMAC, `SESSION_SECRET`), **HttpOnly**, **Secure in production**, `SameSite=Lax`, `Path=/`, **host-only** (no `Domain`), 14 days.
  Host-only means a login on `www.clankrpg.fun` is not sent to `clankrpg.fun` or any other host (the apex redirects to `www`; there is one canonical host).
* A session is valid only while the member's `session_epoch` still matches (bumped when a member is banned) and the member is not BANNED.
* A garbage, tampered, expired or wrong-kind cookie (including the admin cookie) is simply anonymous. `POST /api/auth/logout` clears the cookie.
* Browsers scope cookies by host, **not port**: two local dev servers on `localhost` share a session (useful to know when testing).

## Production configuration (names only)

| Variable | Needed for | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **login** (signature verification) and the bot API | must be the token of the bot named below; without it `/api/auth/telegram` → 503 and the widget is not offered. Setting it does **not** switch the webhook/ingestion on |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | **login** (the widget needs the bot username, no `@`) | read by the server at runtime from `/api/me`; both this and the token must be set or `login.telegramBot` stays `null` |
| `SESSION_SECRET` (≥ 32 chars) | signing player and admin sessions | already required |
| `NEXT_PUBLIC_APP_URL` | origin fallback + canonical links | set to `https://www.clankrpg.fun` (a POST is accepted when its `Origin` equals the request `Host` — www works either way — or this origin) |
| `TELEGRAM_HASH_PEPPER`, `CLASS_ROLL_SECRET` | hero creation for a first-time member | already required |
| `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OFFICIAL_CHAT_ID` | the ingest **webhook** only | not needed for sign-in; leave the webhook off until intended |

Outside Vercel: in **@BotFather → `/setdomain`** set the bot's domain to **`www.clankrpg.fun`** (exactly the host the widget runs on — the Telegram widget refuses
"bot domain invalid" for any other host, including the apex). Environment variables on Vercel apply to new deployments, so redeploy after changing them.
`CLANK_DEV_LOGIN` (demo-hero login) is impossible in production.

## Checking it without secrets

```text
GET  https://www.clankrpg.fun/api/me                 → login.telegramBot must be the bot username (not null)
POST https://www.clankrpg.fun/api/auth/telegram {}   → 422/401 when configured; 503 LOGIN_UNAVAILABLE when TELEGRAM_BOT_TOKEN is missing
```
