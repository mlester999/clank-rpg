# Hero profile photos (and long names)

A hero has **two pictures** that must never be confused:

| | what | where it shows |
|---|---|---|
| **Arena sprite** | the animated, procedural *fighter* | the arena canvas, spectator strip, result cards, the full-body figure on the hero page |
| **Profile photo** | the *person's* picture | Current Round panel, Recent Winners, leaderboards, hero page (beside the name), hero search, admin Heroes list + detail |

The photo never replaces the sprite and is never part of a battle snapshot (it is presentation only, like the RPG name).

## Which image is shown

1. **Admin override** — uploaded in Admin → Heroes → *Open* → **Profile photo**.
2. **Telegram profile photo** — cached from the Bot API by the member's immutable `telegram_user_id`.
3. **Generated default** — the class portrait drawn by the client (no row, nothing stored).

`avatarUrl` is `null` for case 3, and the browser also falls back to the generated portrait if an image ever fails to
load, so a broken image cannot appear. The priority rule lives in exactly one place: the `hero_profile_photos` SQL view.

## Identity rules

* Photos are keyed by `characters.id` (override) and `telegram_user_id` (Telegram cache) — **never by a name**.
  Renaming a hero, or a Telegram display name/@username changing, cannot move, orphan or duplicate a photo and cannot create
  a new hero (tested).
* The RPG display name (`name_override ?? name`), the Telegram display name and the @username remain separate fields.
  Admin rename is unchanged and applies everywhere.

## Architecture

```
admin browser ── crop to square (canvas, EXIF dropped) ──▶ PUT /api/admin/heroes/:id/photo  (admin session + same-origin)
                                                              │ validate BYTES (type, structure, size, pixels)
                                                              ▼
                                              AvatarStore.put(override/<heroId>/<sha16>.<ext>)   ← Supabase Storage (private bucket)
                                                              │                                       or local disk in dev
                                                              ▼
                       hero_photo_overrides (path, mime, bytes, w×h, sha256, updated_by)   +   admin_audit_log
viewers ──▶ GET /api/avatars/:heroId?v=<sha12> ──▶ view picks ADMIN > TELEGRAM ──▶ bytes (immutable cache for 1 year)
```

* **Bytes are never in database rows** (no base64): rows hold path + integrity metadata; objects live in a private
  bucket and are served only through `/api/avatars/…` with `X-Content-Type-Options: nosniff`, a `default-src 'none'; sandbox`
  CSP and the stored, allow-listed image type. The URL carries a content-hash `v`, so it changes when the image does.
* **Validation** (`src/domain/media/image.ts`): PNG / JPEG / WebP only; the type is **sniffed from the bytes** — the
  client-declared type is only a consistency check; structure is walked (no data hidden behind the image); still images
  only (no animated PNG/WebP, no GIF, **no SVG**); ≤ 2 MB; 64–4096 px per side. File names are server-generated
  (`override/<heroId>/<hash>.<ext>`); a client file name never reaches storage.
* **Admin only.** Upload / replace / remove / "refresh from Telegram" are routes inside the admin dispatcher: admin
  session cookie *and* same-origin check for every non-GET. A signed-in player or an anonymous caller gets 401; a cross-site
  request gets 403 (tested). Every change is written to the append-only audit log.
* **Storage selection** (`src/server/storage/factory.ts`): `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` → Supabase Storage;
  no `DATABASE_URL` and not production → files under `.data/avatars` (next to the embedded database); anything else →
  uploads answer **503 `STORAGE_NOT_CONFIGURED`**. A laptop pointed at the live database never writes image files to its own disk.

## Database / storage migration (NOT applied anywhere — you apply it)

`supabase/migrations/20261005000900_hero_profile_photos.sql` (ends with `select public.clank_harden_schema();`):

* `hero_photo_overrides` — one row per hero with an admin photo.
* `telegram_user_photos` — cache of Telegram's answer per member (`status`, `file_unique_id`, path, hash, `checked_at`,
  backoff counters).
* view `hero_profile_photos` (`security_invoker`) — the priority rule + a 12-char cache-busting `version`.
* creates the **private** bucket `hero-avatars` (png/jpeg/webp, 5 MB) when the `storage` schema exists. It is guarded: on
  plain Postgres it is skipped, and if the role may not write `storage.buckets` it raises a NOTICE instead of failing — then
  create the bucket by hand in the Supabase dashboard (private; png/jpeg/webp; 5 MB).

Environment (server only; `.env.example` is updated): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, optional
`SUPABASE_AVATAR_BUCKET` (default `hero-avatars`). The service-role key must never reach the browser.

Order: the migration is independent of 800 (hero admin) — `pnpm db:migrate -- --up-to 20261005000800` applies 800 alone;
deploy the code that reads the view **after** 900 is applied.

## Telegram profile photos — status

* Implemented against the documented Bot API: `getUserProfilePhotos(user_id, limit=1)` → pick a ≥ 320 px size → `getFile`
  → download → validate → store. The cache is keyed by `telegram_user_id`; an unchanged `file_unique_id` is **not
  downloaded again**; verdicts are re-checked at most every 24 h (errors back off 1 h, 2 h, 4 h … ≤ 24 h); a failed
  attempt never blanks a working avatar; a removed Telegram photo stops showing; the bot token never appears in an error,
  a log line or a response (tested).
* Run it with `pnpm telegram:sync-photos` (dry run by default; `--apply --limit 25`) or the scheduler's
  `/api/internal/tick?photos=1` (25 heroes per tick, stops at a rate limit). Admins also get **Refresh from Telegram** per hero.
* **Not verified against real Telegram.** The bot is not connected to the official group yet, and the historical Telegram Desktop
  export contains no profile photos, so none are fabricated: every imported member shows the generated portrait until the bot
  can see them. Telegram may also return "no photo" for members whose privacy settings hide it — that resolves to the default,
  not an error.

## Long / status-like names

Imported Telegram display names can be long or read like a status line ("Celsius - Busy With …"). The **stored** names are
never changed to fit a layout:

* wide surfaces use CSS ellipsis (`truncate`) with the full name in a `title`;
* the arena name tag and the kill feed shorten the *drawn* text with `truncateDisplayName` (`src/domain/character/displayName.ts`):
  grapheme-aware (never half an emoji or a stranded combining mark), prefers a word boundary ("Celsius - Busy With…"), never
  leaves a dangling separator.
* an admin rename (`name_override`) is respected everywhere and keeps working independently of the Telegram name.
