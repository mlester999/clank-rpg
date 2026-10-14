-- Clank RPG — hero renderer v3 (procedural, generated per hero). SETTINGS ONLY — no schema, no battle data, no hero data.
--
-- The sprite set lives in `game_settings` (key 'visuals'), and the seed never overwrites an existing row, so the v3 default shipped in code does
-- NOT reach a database seeded earlier. This moves ONE stored value:
--
--   visuals  spriteSet clank-dev-v2 → clank-v3   (hero renderer v3: every hero is drawn from the SAME stored look — class, rarity, appearance
--                                                 parts and sprite config are read, never rewritten; v1 and v2 stay shipped and an admin can
--                                                 select either again in Settings at any time)
--
-- GUARDED: the row moves only while it still selects clank-dev-v2 (a row an admin pointed elsewhere is left alone). Re-running it is a no-op.
--
-- NOTHING historical changes: battles store their fighters' looks and their ruleset, never pixels; replays draw with the selected set, and every
-- event hash is independent of art. Hero versions keep the sprite set they recorded (`hero_versions.render`). Hero-card images re-key on the set
-- id (their content key includes it), so no stale card is served.
--
-- ORDER: any time after 20261009002500. Deploying the code first is safe: the arena follows this setting, the client fallback / portraits use
-- the code default (v3).

update public.game_settings
   set value = jsonb_set(value, '{spriteSet}', '"clank-v3"'::jsonb),
       version = version + 1,
       updated_by = 'migration:20261014002600',
       updated_at = now()
 where key = 'visuals'
   and jsonb_typeof(value) = 'object'
   and value ->> 'spriteSet' = 'clank-dev-v2';
