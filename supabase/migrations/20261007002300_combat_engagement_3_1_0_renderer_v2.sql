-- Clank RPG — Arena combat rules 3.1.0 (engagement) + hero renderer v2. SETTINGS ONLY — no schema, no battle data, no hero data.
--
-- Combat numbers and the sprite set live in `game_settings`, and the seed never overwrites an existing row, so the 3.1.0 / v2 defaults shipped in
-- code do NOT reach a database seeded earlier. This moves two stored rows:
--
--   combat   NEW engagement { … }   (rules 3.1.0: committed attacks — windup / recovery, ranged fighters planted and holding their ground for
--                                   both — ranged spacing discipline with retreat stamina, melee pursuit, gap-closers that must enter a ranged
--                                   fighter's reach first, aimed shots, healing that fades in overtime; numbers and reasoning in docs/COMBAT.md).
--                                   Nothing else in the row changes: pace, overtime, hpScale, derive… stay exactly the 3.0.0 values.
--   visuals  spriteSet clank-dev-v1 → clank-dev-v2   (hero renderer v2: the SAME layer ids — every hero's stored look, class, rarity and parts
--                                   are untouched and drawn as chosen; v1 stays shipped and an admin can select it again in Settings)
--
-- GUARDED: the combat row moves only while it has no `engagement` yet AND still holds the 3.0.0 pacing exactly (pace 1.95 / 1.1, hpScale 1.55,
-- overtime 28 s / 0.16 per s, atkPerStr / atkPerInt 0.925) — the numbers 3.1.0 was tuned against. A row an admin has re-paced is left alone. The
-- visuals row moves only while it still selects clank-dev-v1. The two rows are independent, and re-running this is a no-op.
--
-- NOTHING historical changes: every stored battle carries the ruleset snapshot it was simulated with (`ruleset_snapshots`), and a ruleset
-- without `engagement` replays with the exact 3.0.0 code path, so 1.0.0 / 2.0.0 / 3.0.0 battles keep producing their pinned event hashes. New
-- battles are stamped rules 3.1.0 by the code (a ruleset WITH `engagement`). Hero versions keep the sprite set they recorded.
--
-- ORDER: apply after 20261007002200. The code that reads `combat.engagement` accepts a row without it (and then simulates 3.0.0 exactly), so
-- deploying the code before applying this is safe; the 3.1.0 rules and the v2 renderer take effect once these rows are moved.

update public.game_settings
   set value = jsonb_set(value, '{engagement}', '{
         "windupMs": {"melee": 60, "ranged": 60},
         "recoveryMs": {"melee": 50, "ranged": 60},
         "windupMove": {"melee": 0.5, "ranged": 0},
         "recoveryMove": {"melee": 1, "ranged": 0},
         "backpedal": 1,
         "retreatMaxMs": 3000,
         "repositionCooldownMs": 1200,
         "wallMargin": 40,
         "skillWindupMs": 100,
         "skillGraceMs": 300,
         "separation": 1.9,
         "surround": 0.6,
         "leadTicks": 4,
         "fatigueMs": 10000,
         "safeRange": 0,
         "chaseMult": 1.1,
         "runnerReach": 0.7,
         "flank": 2,
         "openerReach": 0.5,
         "aimedDodge": 0.5,
         "overtimeHealCut": 0.05,
         "classes": {
           "warrior": {"intervalMult": 1.04},
           "rogue": {"windupMs": 40, "recoveryMs": 40, "intervalMult": 1.05},
           "tank": {"windupMs": 110, "recoveryMs": 60, "intervalMult": 1.1, "chaseMult": 1.2},
           "ranger": {"intervalMult": 0.52, "preferredRange": 150, "dangerRange": 85},
           "mage": {"intervalMult": 0.8, "dangerRange": 80},
           "cleric": {"intervalMult": 1.2}
         }
       }'::jsonb, true),
       version = version + 1,
       updated_by = 'migration:20261007002300',
       updated_at = now()
 where key = 'combat'
   and jsonb_typeof(value) = 'object'
   and not (value ? 'engagement')
   and value -> 'pace' = '{"time": 1.95, "move": 1.1}'::jsonb
   and value -> 'hpScale' = '1.55'::jsonb
   and value #> '{overtime,startMs}' = '28000'::jsonb
   and value #> '{overtime,damageRampPerSec}' = '0.16'::jsonb
   and value #> '{derive,atkPerStr}' = '0.925'::jsonb
   and value #> '{derive,atkPerInt}' = '0.925'::jsonb;

update public.game_settings
   set value = jsonb_set(value, '{spriteSet}', '"clank-dev-v2"'::jsonb),
       version = version + 1,
       updated_by = 'migration:20261007002300',
       updated_at = now()
 where key = 'visuals'
   and jsonb_typeof(value) = 'object'
   and value ->> 'spriteSet' = 'clank-dev-v1';
