begin;

-- Daily Arena Picks pool 500,000 -> 200,000 $CLANKRPG. The weekly pool, the prize ladder percentages and the season allocation are unchanged.
-- Guarded: only a row still holding the previous default is touched, so an admin-edited pool is never overwritten.
update public.game_settings
   set value = value || jsonb_build_object('dailyPrizePool', '200000'),
       version = version + 1,
       updated_by = 'migration:20261029002900',
       updated_at = now()
 where key = 'arena_picks'
   and value->>'dailyPrizePool' = '500000'
   and value->>'weeklyPrizePool' = '1000000';

commit;
