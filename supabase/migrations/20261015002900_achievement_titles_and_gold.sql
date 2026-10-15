-- Clank RPG — EVERY achievement pays Clank Gold and unlocks a TITLE (migration 2900). Data only — no schema change.
--
-- Until now only some achievements paid Gold and only some carried a title, and the first title a hero earned was put on it automatically. From this version every
-- achievement pays a one-off Gold grant and unlocks a title that the member CHOOSES to show above their hero's name (POST /api/me/title; the text is always read from
-- the achievement's own reward). The shipped numbers are in src/domain/content/achievements.ts; the seed never overwrites an existing row, so the stored rows are moved here.
--
--   1. achievements.reward   each of the 20 shipped rows moves to its new reward — GUARDED: only while the row still holds exactly the previous shipped reward, so a
--                            reward an admin has retuned (Admin → Achievements) is left alone, and re-running this changes nothing.
--   2. one-off Gold backfill a member who already unlocked an achievement whose reward now carries Gold (or one an admin granted by hand, which never paid) receives that
--                            Gold once. The idempotency key is the SAME one the application uses when an unlock pays (`achv:<hero>:<achievement>:<unlock row id>`), so an
--                            unlock that was already paid — the old 25 / 100 / 10 / 50 / 250 grants — is skipped, and nothing can be paid twice, here or later. Only ACTIVE
--                            unlocks count (an archived development unlock is history). One INSERT per row, on purpose: the ledger's balance_after is computed by a BEFORE
--                            trigger from the account balance, which an AFTER trigger only updates at the end of each statement.
--
-- Nothing else is touched: no stat, power, hero version, title text already on a hero, battle or board.

update public.achievements a
   set reward = v.new_reward
  from (values
    ('arena_debut',       '{"badge":"debut"}'::jsonb,                                                      '{"badge":"debut","title":"Rookie","gold":10}'::jsonb),
    ('arena_regular',     '{"badge":"regular","gold":25}'::jsonb,                                          '{"badge":"regular","title":"Regular","gold":25}'::jsonb),
    ('arena_veteran',     '{"badge":"veteran","title":"Veteran","gold":100}'::jsonb,                       '{"badge":"veteran","title":"Veteran","gold":100}'::jsonb),
    ('first_blood',       '{"badge":"first_blood"}'::jsonb,                                                '{"badge":"first_blood","title":"First Blood","gold":10}'::jsonb),
    ('reaper',            '{"badge":"reaper","title":"Reaper"}'::jsonb,                                    '{"badge":"reaper","title":"Reaper","gold":75}'::jsonb),
    ('victor',            '{"badge":"victor","gold":10}'::jsonb,                                           '{"badge":"victor","title":"Victor","gold":10}'::jsonb),
    ('champion',          '{"badge":"champion","title":"Champion","gold":50}'::jsonb,                      '{"badge":"champion","title":"Champion","gold":50}'::jsonb),
    ('legend_of_the_pit', '{"badge":"legend","title":"Legend of the Pit","gold":250}'::jsonb,              '{"badge":"legend","title":"Legend of the Pit","gold":250}'::jsonb),
    ('podium_regular',    '{"badge":"podium"}'::jsonb,                                                     '{"badge":"podium","title":"Podium Regular","gold":40}'::jsonb),
    ('voice_of_clank',    '{"badge":"voice500"}'::jsonb,                                                   '{"badge":"voice500","title":"Voice of Clank","gold":50}'::jsonb),
    ('pillar_of_clank',   '{"badge":"voice2000","title":"Pillar"}'::jsonb,                                 '{"badge":"voice2000","title":"Pillar","gold":150}'::jsonb),
    ('steady_presence',   '{"badge":"days60"}'::jsonb,                                                     '{"badge":"days60","title":"Steady Presence","gold":75}'::jsonb),
    ('og_clanker',        '{"badge":"og","title":"OG Clanker"}'::jsonb,                                    '{"badge":"og","title":"OG Clanker","gold":100}'::jsonb),
    ('diamond_1d',        '{"badge":"diamond1"}'::jsonb,                                                   '{"badge":"diamond1","title":"Fresh Diamond","gold":10}'::jsonb),
    ('diamond_7d',        '{"badge":"diamond7"}'::jsonb,                                                   '{"badge":"diamond7","title":"Steady Hands","gold":25}'::jsonb),
    ('diamond_30d',       '{"badge":"diamond30","title":"Diamond Hands"}'::jsonb,                          '{"badge":"diamond30","title":"Diamond Hands","gold":75}'::jsonb),
    ('diamond_90d',       '{"badge":"diamond90","title":"Unbreakable Grip"}'::jsonb,                       '{"badge":"diamond90","title":"Unbreakable Grip","gold":200}'::jsonb),
    ('bonded_collector',  '{"badge":"collector"}'::jsonb,                                                  '{"badge":"collector","title":"Bonded Collector","gold":50}'::jsonb),
    ('boss_slayer',       '{"badge":"boss_slayer","title":"Boss Slayer"}'::jsonb,                          '{"badge":"boss_slayer","title":"Boss Slayer","gold":300}'::jsonb),
    ('seasonal_champion', '{"badge":"season_champion","title":"Seasonal Champion"}'::jsonb,               '{"badge":"season_champion","title":"Seasonal Champion","gold":500}'::jsonb)
  ) as v(id, old_reward, new_reward)
 where a.id = v.id and a.reward = v.old_reward and a.reward <> v.new_reward;

do $$
declare
  r record;
begin
  for r in
    select ca.character_id, a.id as achievement_id, ca.id as unlock_id, (a.reward ->> 'gold')::integer as gold
      from public.character_achievements ca
      join public.achievements a on a.id = ca.achievement_id
     where ca.archived_at is null
       and jsonb_typeof(a.reward -> 'gold') = 'number'
       and (a.reward ->> 'gold')::numeric > 0
       and (a.reward ->> 'gold')::numeric = trunc((a.reward ->> 'gold')::numeric)
     order by ca.character_id, ca.unlocked_at, ca.id
  loop
    insert into public.currency_ledger (character_id, delta, reason, ref_type, ref_id, idempotency_key)
    values (r.character_id, r.gold, 'achievement', 'achievement', r.achievement_id, 'achv:' || r.character_id::text || ':' || r.achievement_id || ':' || r.unlock_id::text)
    on conflict (idempotency_key) do nothing;
  end loop;
end
$$;

select public.clank_harden_schema();
