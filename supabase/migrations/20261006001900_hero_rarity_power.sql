-- 1900 — RARITY POWER SYSTEM (hero generator 2).
--
-- Rarity becomes a real strength tier: every standard hero is generated with a PWR inside its rarity's band
--   COMMON 130–149 · RARE 150–169 · EPIC 170–189 · LEGENDARY 190–209
-- (authoritative in code: src/domain/hero/rarity.ts — the numbers below are the database-side guard of the same table, and a test fails if
-- the two ever disagree). Stats are fitted to that PWR, never the other way round, so stats, PWR and rarity always agree.
--
-- What this migration does — and, just as important, what it does NOT do:
--   · adds the SYSTEM_REBALANCE hero-version action: the deterministic, system-made move of an existing hero onto the new system (same hero,
--     owner, public URL, class, RARITY and identity; stats/PWR fitted into the band; rarity layers added). It is appended as a NEW version by
--     the guarded rebalance script (scripts/rebalance-heroes.ts) — this migration itself touches NO hero row and NO hero version;
--   · adds the database-side tier guard: a version made by hero generator 2 can only be stored with a PWR inside its rarity's band;
--   · adds audit_hero_rarity_power(): the read-only report of which heroes are not (yet) on the new system / outside their band.
-- Existing versions — every v1 INITIAL — are untouched. No data is changed, deleted or re-derived. Historical Arena snapshots, outcomes, hashes
-- and replays are not read or written. Deploy order: apply this migration, deploy the code, then run the rebalance script (dry-run first).

-- ---------------------------------------------------------------------------
-- 0. Guard: the hero-version migration must already be applied (this file extends its table).
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.hero_versions') is null or to_regprocedure('public.audit_hero_versions()') is null then
    raise exception 'hero_rarity_power: the hero-version migration (20261005001800) must be applied first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The SYSTEM_REBALANCE action
-- ---------------------------------------------------------------------------

alter table public.hero_versions drop constraint hero_versions_action_check;
alter table public.hero_versions
  add constraint hero_versions_action_check check (action in ('INITIAL', 'REROLL', 'ROLLBACK', 'SYSTEM_REBALANCE'));

-- (Unchanged and still correct for the new action: INITIAL ⇔ v1 ⇔ no previous version ⇔ no request key; ROLLBACK ⇔ has a source version.
--  A SYSTEM_REBALANCE carries a deterministic request key, so a retry or a concurrent run can only ever write one row.)

-- ---------------------------------------------------------------------------
-- 2. Tier guard: generator 2 versions are inside their rarity's PWR band
--    (generator 1 versions predate rarity power and keep whatever they were stored with; hand-authored special characters carry their own
--     generator label and are exempt by design.)
-- ---------------------------------------------------------------------------

alter table public.hero_versions
  add constraint hero_versions_gen2_power_in_rarity_band check (
    generator_version <> 'hero-gen/2'
    or (rarity = 'COMMON'    and power between 130 and 149)
    or (rarity = 'RARE'      and power between 150 and 169)
    or (rarity = 'EPIC'      and power between 170 and 189)
    or (rarity = 'LEGENDARY' and power between 190 and 209)
  );

-- ---------------------------------------------------------------------------
-- 3a. Documentation of the column: the first migration that created it called rarity "COSMETIC ONLY". That is no longer true (a rarity is a PWR tier);
--     an applied migration is never edited, so the column itself now carries the current rule.
-- ---------------------------------------------------------------------------

comment on column public.character_appearances.rarity is
  'Hero rarity: COMMON / RARE / EPIC / LEGENDARY. A real strength tier (hero generator 2 fits the hero''s stats into the rarity''s PWR band) as well as a visual one.';

-- ---------------------------------------------------------------------------
-- 3. Auditor: heroes that are not on the rarity power system yet, or whose current PWR is outside their band.
--    Every row is a finding. Expected result AFTER the rebalance: no rows. (Before it: one NOT_REBALANCED row per community hero.)
--    Demo heroes and hand-authored special characters are not subject to rarity bands.
-- ---------------------------------------------------------------------------

create or replace function public.audit_hero_rarity_power()
returns table (character_id uuid, problem text)
language sql
stable
as $$
  select c.id, 'NOT_REBALANCED'::text
    from public.characters c join public.hero_versions v on v.id = c.current_hero_version_id
   where c.kind = 'COMMUNITY' and not c.is_demo and v.generator_version = 'hero-gen/1'
  union all
  select c.id, 'POWER_OUTSIDE_RARITY_BAND'
    from public.characters c join public.hero_versions v on v.id = c.current_hero_version_id
   where c.kind = 'COMMUNITY' and not c.is_demo and v.generator_version = 'hero-gen/2'
     and not (
          (v.rarity = 'COMMON'    and v.power between 130 and 149)
       or (v.rarity = 'RARE'      and v.power between 150 and 169)
       or (v.rarity = 'EPIC'      and v.power between 170 and 189)
       or (v.rarity = 'LEGENDARY' and v.power between 190 and 209))
$$;

select public.clank_harden_schema();
