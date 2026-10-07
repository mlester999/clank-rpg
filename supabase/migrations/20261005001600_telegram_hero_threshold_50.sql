-- Lower the shipped hero eligibility minimum without changing any Telegram scoring settings.
-- Only migrate the previous default; preserve any separately configured threshold.
update public.game_settings
   set value = jsonb_set(value, '{qualifyingThreshold}', '50'::jsonb, false),
       version = version + 1,
       updated_by = 'migration:20261005001600',
       updated_at = now()
 where key = 'telegram'
   and jsonb_typeof(value) = 'object'
   and value->>'qualifyingThreshold' = '100';
