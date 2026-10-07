-- Clank RPG — foundation: helpers, data-driven game configuration, seasons, audit log.
-- All balance values live in data (game_settings / character_classes / skills) so
-- admins can tune the game without a deploy. Battles reference an immutable,
-- content-addressed ruleset snapshot so past results stay reproducible.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only (% rejected)', tg_table_name, tg_op
    using errcode = '23000';
end;
$$;

-- ---------------------------------------------------------------------------
-- Game configuration
-- ---------------------------------------------------------------------------

create table public.game_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  value jsonb not null,
  version integer not null default 1 check (version >= 1),
  updated_by text,
  updated_at timestamptz not null default now()
);

create table public.character_classes (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null check (char_length(name) between 1 and 40),
  description text not null default '',
  enabled boolean not null default true,
  sort_order integer not null default 100,
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger character_classes_updated_at before update on public.character_classes
  for each row execute function public.set_updated_at();

create table public.skills (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null check (char_length(name) between 1 and 60),
  enabled boolean not null default true,
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger skills_updated_at before update on public.skills
  for each row execute function public.set_updated_at();

-- Content-addressed, immutable copies of the ruleset a battle was simulated with.
create table public.ruleset_snapshots (
  hash text primary key check (hash ~ '^[0-9a-f]{64}$'),
  rules_version text not null,
  ruleset jsonb not null,
  created_at timestamptz not null default now()
);
create trigger ruleset_snapshots_append_only before update or delete on public.ruleset_snapshots
  for each row execute function public.forbid_mutation();

create table public.feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_.]{1,60}$'),
  enabled boolean not null default false,
  description text not null default '',
  payload jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Seasons (seasonal competitive progression resets; permanent progression does not)
-- ---------------------------------------------------------------------------

create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  number integer not null unique check (number >= 1),
  name text not null check (char_length(name) between 1 and 60),
  status text not null default 'UPCOMING' check (status in ('UPCOMING', 'ACTIVE', 'ENDED')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
-- At most one ACTIVE season at any time.
create unique index seasons_single_active on public.seasons ((true)) where status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Admin audit log (append-only)
-- ---------------------------------------------------------------------------

create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  actor text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index admin_audit_log_created_idx on public.admin_audit_log (created_at desc);
create trigger admin_audit_log_append_only before update or delete on public.admin_audit_log
  for each row execute function public.forbid_mutation();
