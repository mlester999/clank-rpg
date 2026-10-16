begin;

update public.game_settings
   set value = value || jsonb_build_object(
         'dailyPrizePool', '500000',
         'weeklyPrizePool', '1000000'
       ),
       version = version + 1,
       updated_by = 'migration:20261017002800',
       updated_at = now()
 where key = 'arena_picks'
   and value->>'dailyPrizePool' = '100000'
   and value->>'weeklyPrizePool' = '500000';

update public.game_settings
   set value = value || jsonb_build_object('seasonRewardAllocation', '75000000'),
       version = version + 1,
       updated_by = 'migration:20261017002800',
       updated_at = now()
 where key = 'arena_picks'
   and value->>'dailyPrizePool' = '500000'
   and value->>'weeklyPrizePool' = '1000000'
   and value->>'seasonRewardAllocation' = '20000000';

commit;
