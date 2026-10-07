-- Clank RPG — security boundary.
--
-- The browser NEVER talks to the database directly in this Beta: every read and write
-- goes through server-only code using a privileged connection (postgres / service_role).
-- So: RLS is enabled on every table with NO policies for API roles, and all privileges
-- are revoked from anon/authenticated. Adding a public read later is an explicit,
-- reviewed policy — never an accident of Supabase's default grants.
--
-- The logic lives in a function so that EVERY future migration can finish with
--   select public.clank_harden_schema();
-- (tests/security fails the build if any table is left without RLS).
-- It runs on plain Postgres (local PGlite) where Supabase's roles may not exist.

create or replace function public.clank_harden_schema()
returns void
language plpgsql
as $$
declare
  t record;
  api_role text;
begin
  -- 1. RLS on every table in public.
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;

  -- 2. Strip API-role privileges (tables, sequences, functions) and default privileges.
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on all tables in schema public from %I', api_role);
      execute format('revoke all on all sequences in schema public from %I', api_role);
      execute format('revoke all on all functions in schema public from %I', api_role);
      execute format('alter default privileges in schema public revoke all on tables from %I', api_role);
      execute format('alter default privileges in schema public revoke all on sequences from %I', api_role);
      execute format('alter default privileges in schema public revoke all on functions from %I', api_role);
    end if;
  end loop;

  -- 3. Functions are executable by PUBLIC by default; close that too.
  execute 'revoke execute on all functions in schema public from public';
  execute 'alter default privileges in schema public revoke execute on functions from public';

  -- 4. The server role keeps full access.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant all on all tables in schema public to service_role';
    execute 'grant all on all sequences in schema public to service_role';
    execute 'grant execute on all functions in schema public to service_role';
  end if;
end;
$$;

select public.clank_harden_schema();
