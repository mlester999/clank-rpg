import { Callout, DocH2, DocLink, HolderTierTable } from "@/components/docs/prose";
import { GAME_RULES, formatWhole, prizeShare } from "@/domain/gameRules";

export default function HolderBonus() {
  const r = GAME_RULES;
  const best = r.holderBonus.tiers[r.holderBonus.tiers.length - 1]!;
  const example = prizeShare(1, r.picks.daily.pool).amount; // the #1 Daily prize
  return (
    <>
      <DocH2 id="what-it-is">What it is</DocH2>
      <p>
        The holder bonus is an <strong>optional extra on a leaderboard prize you have already earned</strong>. If you win a prize and you were a verified {r.token.symbol} holder, a percentage is added on top of it. For
        example, a {formatWhole(example)} {r.token.symbol} prize with a +{best.bonusPercent}% bonus pays {formatWhole(example + (example * best.bonusPercent) / 100)}.
      </p>
      <p>
        The bonus is <em>extra</em>: it is paid on top, and it never takes anything away from anyone else&apos;s prize. It also needs a <em>verified</em> holding — you must have held the tokens from before the
        period began ({r.holderBonus.dailyQualifyHours} hours before a Daily board, {r.holderBonus.weeklyQualifyHours / 24} days before a Weekly one) and kept holding them until it ended.
      </p>

      <DocH2 id="the-tiers">The tiers</DocH2>
      <HolderTierTable />
      <p>
        <strong>FREE</strong> is everyone who doesn&apos;t hold the token — and a perfectly good way to play: you can win the same leaderboard prizes, with a bonus of 0%. The top tier, {best.label}, adds +{best.bonusPercent}%.
      </p>

      <DocH2 id="what-it-never-does">What it never does</DocH2>
      <Callout tone="good" title="Not pay-to-win">
        The holder bonus only increases an <strong>earned leaderboard prize</strong>. It <strong>never</strong> increases your Points, your rank, your Picks, a hero&apos;s PWR, its rarity or its combat power.
      </Callout>
      <ul>
        <li>It can&apos;t make you win a prize — you have to earn a prize position on the board first.</li>
        <li>It doesn&apos;t change a tie-break or move anybody up or down the ranking.</li>
        <li>It doesn&apos;t touch your hero: holding {r.token.symbol} never changes a hero&apos;s stats, PWR or rarity.</li>
      </ul>

      <DocH2 id="before-launch">Before the token launches</DocH2>
      <p>
        The {r.token.symbol} token has not launched yet, so there is nothing to hold and the holder bonus is effectively <strong>0%</strong> for everyone. The game still records your Points and prizes, and the bonus can
        apply once the token exists and your holding has been verified. See <DocLink to="/docs/claims">Claims</DocLink> for what happens to earned rewards in the meantime.
      </p>
    </>
  );
}
