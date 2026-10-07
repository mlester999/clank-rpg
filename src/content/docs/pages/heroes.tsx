import { Callout, DocH2, DocLink, DocTable } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

export default function Heroes() {
  const r = GAME_RULES;
  return (
    <>
      <DocH2 id="one-member-one-hero">One member, one hero</DocH2>
      <p>
        Every eligible community member gets <strong>one hero</strong>. It belongs to you in the game&apos;s sense — it carries your name, it has a public page and its record (this season&apos;s wins, knock-outs, recent
        fights) is its own — and it is the hero that appears in the Arena under your name.
      </p>

      <DocH2 id="what-defines-a-hero">What defines a hero</DocH2>
      <DocTable
        caption="What defines a hero"
        head={["Part", "What it is"]}
        rows={[
          ["Class", <span key="c">One of {r.hero.classCount} fighting styles. It decides the weapon, the reach and what the hero is good at. <DocLink to="/docs/classes">Classes →</DocLink></span>],
          ["Rarity", <span key="r">Common, Rare, Epic or Legendary — a real strength tier and a visual one. <DocLink to="/docs/rarity">Rarity →</DocLink></span>],
          ["Stats", <span key="s">HP, STR, DEF, INT, AGI, CHA and LUCK: the seven numbers a hero fights with. <DocLink to="/docs/power-and-stats">Power &amp; stats →</DocLink></span>],
          ["PWR", "One number that sums up the hero's combat strength, so you can compare heroes at a glance."],
          ["Look", "How the hero is drawn: face, hair, colours and the outfit and effects that go with its class and rarity."],
        ]}
      />
      <p>You can&apos;t re-roll your hero yourself, and nothing you can buy changes it.</p>

      <DocH2 id="appearance">Appearance</DocH2>
      <p>
        A hero&apos;s class decides its silhouette: a Mage always looks like a Mage, a Ranger like a Ranger. Rarity adds to that look rather than replacing it — a Legendary Ranger is still unmistakably a
        Ranger, just with ornate trim, armour details, a glowing weapon and a golden aura.
      </p>
      <p>
        The same hero always looks the same. Its look is fixed when it is created, so what you see on the card, in the directory and in the Arena is one and the same hero.
      </p>

      <DocH2 id="fighting-automatically">Fighting automatically</DocH2>
      <p>
        Heroes take part in Arena battles by themselves, in rotation with every other eligible hero. There are no controls during a fight: your hero attacks, moves and uses its skills on its own, following
        its class. You can watch live, or just check the result later.
      </p>
      <Callout title="Your part">
        Your hero fights; <em>you</em> Pick. <DocLink to="/docs/arena-picks">Arena Picks</DocLink> are how you take part in the Arena as a spectator.
      </Callout>
    </>
  );
}
