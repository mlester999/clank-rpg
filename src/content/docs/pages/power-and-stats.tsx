import { Callout, DocH2, DocLink, DocTable } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

export default function PowerAndStats() {
  const r = GAME_RULES;
  return (
    <>
      <DocH2 id="what-is-pwr">What is PWR?</DocH2>
      <p>
        <strong>PWR</strong> is one number that estimates a hero&apos;s overall combat strength. It is worked out from the hero&apos;s actual stats, on the server, so what you see on a card, in a list or in the
        Arena is always the real figure for that hero.
      </p>
      <p>
        PWR is built so it is <strong>comparable across classes</strong>: a Tank and a Mage with the same PWR are expected to be about as strong, even though they spend their points very differently. And because
        each rarity has its own PWR range, PWR also tells you which tier a hero belongs to — from {r.rarity.ladder[0]!.band} for Common up to {r.rarity.ladder[3]!.band} for Legendary.
        <DocLink to="/docs/rarity"> See the ranges →</DocLink>
      </p>

      <DocH2 id="the-seven-stats">The seven stats</DocH2>
      <DocTable
        caption="The seven stats"
        head={["Stat", "What it does"]}
        rows={[
          ["HP", "Health. How much damage the hero can take before it is knocked out."],
          ["STR", "Strength. Powers physical attacks and physical skills."],
          ["DEF", "Defence. Reduces the damage the hero takes — with diminishing returns, so stacking it only goes so far."],
          ["INT", "Intelligence. Powers magic attacks and spells, which partly ignore DEF."],
          ["AGI", "Agility. Faster attacks, faster movement and a better chance to dodge."],
          ["CHA", "Charisma. Shortens skill cooldowns, so skills come around sooner."],
          ["LUCK", "Luck. A better chance of critical hits and of dodging an attack."],
        ]}
      />

      <DocH2 id="classes-spend-stats-differently">Classes spend stats differently</DocH2>
      <p>
        A hero&apos;s <strong>rarity</strong> decides how big its stat budget is. Its <strong>class</strong> decides how that budget is spent. A Warrior puts most of it into STR and HP, a Mage into INT, a Rogue into AGI
        and LUCK, a Ranger into AGI and STR, a Tank into HP and DEF, and a Cleric into INT, CHA and staying alive. Each hero&apos;s own roll then moves a few points around, so two Legendary Mages are never identical.
      </p>
      <DocTable
        caption="Where each class's points go"
        head={["Class", "Strongest stats"]}
        rows={r.classes.map((c) => [c.name, c.strongest.map((s) => s.label).join(" · ")])}
      />

      <DocH2 id="what-pwr-is-not">What PWR is not</DocH2>
      <Callout tone="note" title="An estimate, not a result">
        PWR is a summary. Fights are played out using the individual stats, the class and its skills — not the PWR number — so a lower-PWR hero can still win, especially against a class it matches up well against.
      </Callout>
      <p>
        PWR is also not something you can buy. Holding the $CLANKRPG token never changes a hero&apos;s PWR, its stats or its rarity.
      </p>
    </>
  );
}
