import { Callout, DocH2, DocLink, RarityLadderStrip, RarityTable } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

export default function Rarity() {
  const r = GAME_RULES;
  const [common, rare, epic, legendary] = r.rarity.ladder;
  return (
    <>
      <DocH2 id="four-tiers">Four tiers</DocH2>
      <p>
        Every hero has a rarity: <strong>Common</strong>, <strong>Rare</strong>, <strong>Epic</strong> or <strong>Legendary</strong>. Rarity is a <strong>real strength tier</strong> as well as a visual one.
        Higher rarity generally means:
      </p>
      <ul>
        <li>a <strong>larger stat budget</strong> — the hero is built from more stat points,</li>
        <li>a <strong>higher PWR range</strong>,</li>
        <li><strong>stronger combat potential</strong> in the Arena, and</li>
        <li>a more <strong>premium look</strong> — richer frames, auras and effects.</li>
      </ul>
      <RarityLadderStrip />

      <DocH2 id="pwr-ranges">PWR ranges</DocH2>
      <p>
        Each rarity has its own PWR range, and the ranges <strong>do not overlap</strong>: the strongest Common is still weaker than the weakest Rare, the strongest Rare is weaker than the weakest Epic, and so on.
        A hero&apos;s PWR always sits inside its rarity&apos;s range.
      </p>
      <RarityTable />
      <p>
        Inside a range, heroes differ: a Rare with a PWR of {rare!.powerMin + 2} and a Rare with a PWR of {rare!.powerMax - 2} are both Rare, but the second is meaningfully stronger. Rarity sets the tier; the hero&apos;s own
        roll decides where in the tier it lands. <DocLink to="/docs/power-and-stats">What PWR means →</DocLink>
      </p>

      <DocH2 id="how-rarity-is-decided">How rarity is decided</DocH2>
      <p>
        A hero&apos;s rarity is a <strong>random draw with fixed odds</strong> when the hero is created. The odds are the same for everybody:
      </p>
      <ul>
        {r.rarity.ladder.map((t) => (
          <li key={t.id}><strong>{t.label}</strong> — {t.oddsPercent}%</li>
        ))}
      </ul>
      <p>
        There is no way to buy, boost or choose a rarity, and nothing you hold or spend changes your odds. The class a hero gets is decided separately, so a Legendary can be any of the {r.hero.classCount} classes.
      </p>

      <DocH2 id="what-rarity-looks-like">What rarity looks like</DocH2>
      <p>
        Each tier has its own look, so you can tell a hero&apos;s rarity at a glance — and not only by colour: the badge shape, the frame and the effects all change with the tier.
      </p>
      <ul>
        <li><strong>{common!.label}</strong> ({common!.visual.badge}) — {common!.visual.frame}. {common!.visual.effect}</li>
        <li><strong>{rare!.label}</strong> ({rare!.visual.badge}) — {rare!.visual.frame}. {rare!.visual.effect}</li>
        <li><strong>{epic!.label}</strong> ({epic!.visual.badge}) — {epic!.visual.frame}. {epic!.visual.effect}</li>
        <li><strong>{legendary!.label}</strong> ({legendary!.visual.badge}) — {legendary!.visual.frame}. {legendary!.visual.effect}</li>
      </ul>
      <p>
        In a live battle the Arena doesn&apos;t print a rarity label next to a fighter. Instead a rarer hero simply <em>looks</em> rarer: a ring on the ground, a glow, and — for Epic and Legendary — drifting sparks or embers.
      </p>

      <DocH2 id="not-a-guarantee">Not a guarantee</DocH2>
      <Callout tone="warn" title="Higher rarity does not win every battle">
        A higher rarity is a real advantage, not an automatic victory. Class matchups, positioning, timing and a little luck all still matter, and every battle has {r.arena.heroesPerBattle} heroes. A Common
        hero can beat a Legendary — it just does so less often. That is what keeps the Arena worth watching.
      </Callout>
      <p>
        In our balance testing, with heroes of all rarities mixed together, a Legendary out-places a Common roughly {r.balance.legendaryOutplacesCommonPercent} times in 100 when the two meet — and the Common wins the
        rest. Every class is competitive inside every rarity.
      </p>

      <DocH2 id="what-rarity-does-not-touch">What rarity does not touch</DocH2>
      <p>Rarity is about the <em>hero in battle</em>. It has nothing to do with the rest of the game:</p>
      <ul>
        <li>Arena Pick Points — a correct Pick is always +{r.picks.pointsPerCorrectPick}, whichever hero you picked,</li>
        <li>Daily and Weekly leaderboard rank, tie-breaks and prizes,</li>
        <li>the holder bonus, claims, or anything about your wallet.</li>
      </ul>
    </>
  );
}
