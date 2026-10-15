-- Clank RPG — Arena Picks prize pools: DAILY 100,000 → 500,000 $CLANKRPG and WEEKLY 500,000 → 1,000,000 $CLANKRPG. SETTINGS ONLY — no schema, no board, no result, no ledger row.
--
-- The pools live in the stored `arena_picks` settings row, and the seed never overwrites an existing row, so the new defaults shipped in code (DEFAULT_ARENA_PICKS)
-- do NOT reach a database seeded earlier. This moves the two stored numbers.
--
-- GUARDED, one number at a time: a pool moves only while it still holds the previous shipped default. A pool an admin has already retuned in Admin → Settings is left
-- alone (and a value that already equals the new default is not touched again), so re-running this is a no-op.
--
-- NOTHING historical changes: a finalized Daily / Weekly board froze the pool it paid out, and those frozen rows are never rewritten. A period that is still running
-- finalizes with the pool in force when it closes (the existing behaviour for any pool change), so today's board will already pay the new amount.
--
-- NOT changed here, on purpose: `seasonRewardAllocation` (the Admin planning figure, 20,000,000). The Season 1 plan at the new pools is 84 days × 500,000 + 12 weeks ×
-- 1,000,000 = 54,000,000 (67,500,000 with every holder bonus at +25 %), so Admin → Arena Picks will warn that the plan EXCEEDS the allocation until the owner sets the
-- allocation to the real reserve. It is a planning metric only (nothing is minted or reserved by it) and what the treasury can actually fund is the owner's decision.

update public.game_settings
   set value = value
         || case when value ->> 'dailyPrizePool' = '100000' then jsonb_build_object('dailyPrizePool', '500000') else '{}'::jsonb end
         || case when value ->> 'weeklyPrizePool' = '500000' then jsonb_build_object('weeklyPrizePool', '1000000') else '{}'::jsonb end,
       version = version + 1,
       updated_by = 'migration:20261015002800',
       updated_at = now()
 where key = 'arena_picks'
   and jsonb_typeof(value) = 'object'
   and (value ->> 'dailyPrizePool' = '100000' or value ->> 'weeklyPrizePool' = '500000');

select public.clank_harden_schema();
