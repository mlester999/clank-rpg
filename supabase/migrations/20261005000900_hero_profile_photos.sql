-- Clank RPG — hero PROFILE PHOTOS (the person's picture), kept apart from the arena SPRITE (the fighter).
--
-- Which image a hero shows, highest priority first:
--   1. an ADMIN override                 (hero_photo_overrides, keyed by the hero)
--   2. the member's TELEGRAM profile photo (telegram_user_photos, keyed by the IMMUTABLE telegram_user_id)
--   3. nothing stored → the app draws the generated class portrait; no row, no broken image.
--
-- Image BYTES never live in these rows (no base64 blobs): they sit in object storage (private bucket
-- `hero-avatars`) and the rows hold the path + integrity metadata. The app serves them through
-- /api/avatars/<heroId>?v=<sha>, so the bucket stays private and the URL changes whenever the image does.
--
-- Nothing here is derived from a name: renaming a hero or a Telegram @username can never move, orphan or
-- duplicate a photo. Ownership follows characters.id (override) and telegram_user_id (Telegram cache).

create table public.hero_photo_overrides (
  character_id uuid primary key references public.characters (id) on delete cascade,
  storage_path text not null check (storage_path ~ '^[a-z0-9][a-z0-9/_.-]{3,200}$'),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  width integer not null check (width between 1 and 8192),
  height integer not null check (height between 1 and 8192),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger hero_photo_overrides_updated_at before update on public.hero_photo_overrides
  for each row execute function public.set_updated_at();

-- A cache of what Telegram currently shows for a member. `file_unique_id` is Telegram's stable id for the
-- picture itself: while it is unchanged the bytes are NOT downloaded again.
create table public.telegram_user_photos (
  telegram_user_id bigint primary key references public.telegram_users (telegram_user_id) on delete cascade,
  -- UNKNOWN: never asked · AVAILABLE: a verified copy is stored · NONE: Telegram reports no (visible) photo · ERROR: the last attempt failed
  status text not null default 'UNKNOWN' check (status in ('UNKNOWN', 'AVAILABLE', 'NONE', 'ERROR')),
  file_unique_id text,
  file_id text,
  storage_path text check (storage_path is null or storage_path ~ '^[a-z0-9][a-z0-9/_.-]{3,200}$'),
  mime_type text check (mime_type is null or mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer check (byte_size is null or byte_size between 1 and 5242880),
  width integer,
  height integer,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz,
  fetched_at timestamptz,
  error_count integer not null default 0 check (error_count >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'AVAILABLE' or (storage_path is not null and mime_type is not null and sha256 is not null))
);
create index telegram_user_photos_due_idx on public.telegram_user_photos (checked_at nulls first);
create trigger telegram_user_photos_updated_at before update on public.telegram_user_photos
  for each row execute function public.set_updated_at();

-- The ONE place the priority rule lives. `version` is a short content hash used to cache-bust the image URL.
create view public.hero_profile_photos with (security_invoker = true) as
  select c.id as character_id,
         case when o.character_id is not null then 'ADMIN'
              when t.status = 'AVAILABLE' then 'TELEGRAM' end as source,
         case when o.character_id is not null then o.storage_path
              when t.status = 'AVAILABLE' then t.storage_path end as storage_path,
         case when o.character_id is not null then o.mime_type
              when t.status = 'AVAILABLE' then t.mime_type end as mime_type,
         left(case when o.character_id is not null then o.sha256
                   when t.status = 'AVAILABLE' then t.sha256 end, 12) as version
    from public.characters c
    left join public.hero_photo_overrides o on o.character_id = c.id
    left join public.telegram_user_photos t on t.telegram_user_id = c.telegram_user_id;

-- Private bucket for the image bytes (Supabase Storage). Skipped on plain Postgres (local PGlite has no
-- `storage` schema) and never allowed to block the migration: if the role may not touch storage.buckets,
-- create the bucket `hero-avatars` (private; png/jpeg/webp; 5 MB) in the dashboard instead.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('hero-avatars', 'hero-avatars', false, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
exception when others then
  raise notice 'hero-avatars bucket was not created automatically (%). Create it in the Supabase dashboard: private, png/jpeg/webp, 5 MB.', sqlerrm;
end
$$;

select public.clank_harden_schema();
