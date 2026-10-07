import { Callout, ClassSummary, DocH2, DocTable } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

/** The prose for each class. Role, reach and strongest stats come from the class catalogue (GAME_RULES.classes), never from here. */
const PERSONALITY: Record<string, { personality: string; strengths: string[]; tradeoffs: string[] }> = {
  warrior: {
    personality: "A front-line brawler that charges in and trades blows. When it gets badly hurt it fights even harder, so a wounded Warrior is still dangerous.",
    strengths: ["Plenty of HP and heavy physical damage", "Closes distance with a charge that staggers its target", "A sweeping strike that hits every enemy around it", "Fights harder as the fight turns against it"],
    tradeoffs: ["Short reach: it has to get close to do anything", "Can be kited by ranged heroes", "Little defence against magic"],
  },
  mage: {
    personality: "A glass cannon. It stays at range and detonates the arena from a safe distance, with bursts of magic and a freezing nova to buy space.",
    strengths: ["The biggest magic damage and a long reach", "Burst that can finish a fight quickly", "Slows enemies that get too close"],
    tradeoffs: ["Low HP and low DEF: a few hits can end it", "Has to keep moving to stay out of reach", "Struggles when cornered"],
  },
  rogue: {
    personality: "An opportunist. Fast and quick to strike, it hunts the wounded and slips away before the counter-attack.",
    strengths: ["High speed, and critical hits that hurt", "Hunts the weakest target on the field", "Vanishes behind a target for one heavy strike, and can become hard to hit"],
    tradeoffs: ["Medium HP and low DEF", "Must be in melee range to deal damage", "Relies on timing and a little luck"],
  },
  ranger: {
    personality: "A marksman that kites and snipes. It never fights where the enemy wants, loosing arrows from a distance and snaring anyone who closes in.",
    strengths: ["Long reach and good speed", "Volleys that hit several targets", "Snares to control a chase"],
    tradeoffs: ["Low HP and low DEF", "Stands still for a moment after each shot", "Can be run down by fast melee heroes"],
  },
  tank: {
    personality: "Immovable. It soaks up punishment and makes everyone fight on its terms, taking less damage from every hit.",
    strengths: ["The most HP and the best DEF", "Takes reduced damage from every source", "Can raise a barrier, and slams the ground to hit and slow nearby enemies and draw their attention"],
    tradeoffs: ["Slow, and not much damage", "Needs time to win a fight", "Can be outlasted by sustain or kited from range"],
  },
  cleric: {
    personality: "A sustain specialist. It outlasts the chaos with radiant tricks, recovering health over time and punishing enemies with holy bolts.",
    strengths: ["Recovers health as it fights, and its holy strike heals it", "Good INT and CHA, so its skills come around faster", "A sanctuary that both heals and shields it when things go badly"],
    tradeoffs: ["Moderate damage", "Medium reach, so it has to keep its distance", "Needs a long fight to show its strength"],
  },
};

export default function Classes() {
  const r = GAME_RULES;
  return (
    <>
      <DocH2 id="overview">The six classes</DocH2>
      <p>
        Every hero belongs to one of {r.hero.classCount} classes. A class decides how the hero fights — its weapon and reach, what it is good at, and how its stat budget is spent. A class is not a ranking:
        all six are meant to be competitive, in every rarity.
      </p>
      <DocTable
        caption="The six classes"
        head={["Class", "Role", "Reach", "Strongest stats"]}
        rows={r.classes.map((c) => [c.name, c.role, c.reach, c.strongest.map((s) => s.label).join(" · ")])}
      />

      {r.classes.map((c) => {
        const p = PERSONALITY[c.id];
        return (
          <section key={c.id} aria-labelledby={c.id}>
            <DocH2 id={c.id}>{c.name}</DocH2>
            <p><em>{c.tagline}</em></p>
            <ClassSummary id={c.id} />
            {p && (
              <>
                <p>{p.personality}</p>
                <p><strong>Strengths</strong></p>
                <ul>{p.strengths.map((s) => <li key={s}>{s}</li>)}</ul>
                <p><strong>Trade-offs</strong></p>
                <ul>{p.tradeoffs.map((s) => <li key={s}>{s}</li>)}</ul>
              </>
            )}
          </section>
        );
      })}

      <DocH2 id="matchups">Matchups</DocH2>
      <p>
        Some classes are naturally better against others — a Ranger can punish a slow Tank, a Rogue can hunt a Mage — but <strong>nothing is guaranteed</strong>. Where the heroes stand, who they choose to
        attack, when their skills come off cooldown and a little luck all matter, and every battle has eight heroes, not two.
      </p>
      <Callout title="Class and rarity">
        Rarity makes a hero stronger; class decides <em>how</em> it is strong. A Common Mage can still beat a Rare Tank on a good day.
      </Callout>
    </>
  );
}
