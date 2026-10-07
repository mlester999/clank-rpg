-- Clank RPG — Arena combat rules 3.0.0: longer fights (median ≈ 37 s, hard cap 60 s). SETTINGS ONLY — no schema, no battle data.
--
-- Combat numbers live in `game_settings` and the app reads them from there, so the 3.0.0 defaults shipped in code do NOT reach a
-- database whose rows were seeded earlier (the seed never overwrites an existing row). This moves the two stored rows:
--
--   combat  hpScale 1.5 → 1.55 · derive.atkPerStr / atkPerInt 1.0 → 0.925 · overtime 10 s / 0.08 per s → 28 s / 0.16 per s ·
--           NEW pace { time 1.95, move 1.1 }  (the global slow-motion that lengthens fights without editing a class or a skill)
--   arena   maxCombatMs 30 000 → 60 000
--
-- GUARDED: a row is changed only while it still holds EXACTLY the 2.0.0 shipped numbers (and, for combat, has no `pace` yet). A row an
-- admin has tuned, or one that already carries 3.0.0, is left alone — so applying this never overwrites a deliberate setting and
-- re-running it is a no-op. The two rows are independent (an admin who tuned one still gets the other).
--
-- NOTHING historical changes: every stored battle carries the ruleset snapshot it was simulated with (`ruleset_snapshots`) and its own
-- `snapshot.maxCombatMs`, and a ruleset without `pace` replays with the exact 1 / 1 no-op, so rules 1.0.0 and 2.0.0 battles keep
-- producing their pinned event hashes. New battles are stamped rules 3.0.0 by the code.
--
-- ORDER: apply with the Arena Picks migrations, BEFORE any code that expects `combat.pace` runs (that code's strict settings schema
-- accepts a row without `pace`, but the 3.0.0 pacing only takes effect once these rows are moved).

update public.game_settings
   set value = jsonb_set(
                 jsonb_set(
                   jsonb_set(
                     jsonb_set(
                       jsonb_set(
                         jsonb_set(value, '{hpScale}', '1.55'::jsonb),
                         '{derive,atkPerStr}', '0.925'::jsonb),
                       '{derive,atkPerInt}', '0.925'::jsonb),
                     '{overtime,startMs}', '28000'::jsonb),
                   '{overtime,damageRampPerSec}', '0.16'::jsonb),
                 '{pace}', '{"time": 1.95, "move": 1.1}'::jsonb, true),
       version = version + 1,
       updated_by = 'migration:20261005001700',
       updated_at = now()
 where key = 'combat'
   and jsonb_typeof(value) = 'object'
   and not (value ? 'pace')
   and value -> 'hpScale' = '1.5'::jsonb
   and value #> '{derive,atkPerStr}' = '1'::jsonb
   and value #> '{derive,atkPerInt}' = '1'::jsonb
   and value #> '{overtime,startMs}' = '10000'::jsonb
   and value #> '{overtime,damageRampPerSec}' = '0.08'::jsonb;

update public.game_settings
   set value = jsonb_set(value, '{maxCombatMs}', '60000'::jsonb),
       version = version + 1,
       updated_by = 'migration:20261005001700',
       updated_at = now()
 where key = 'arena'
   and jsonb_typeof(value) = 'object'
   and value -> 'maxCombatMs' = '30000'::jsonb;
