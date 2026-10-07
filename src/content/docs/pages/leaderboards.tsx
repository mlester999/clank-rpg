import { Callout, DocH2, DocLink, PrizeTable } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

export default function Leaderboards() {
  const r = GAME_RULES;
  return (
    <>
      <DocH2 id="daily">Daily leaderboard</DocH2>
      <p>
        The Daily leaderboard covers one <strong>UTC day</strong>, from 00:00 UTC to the next 00:00 UTC. (It always runs on UTC, whatever time zone you are in.) <strong>Every valid Pick counts</strong>: a correct Pick is
        +{r.picks.pointsPerCorrectPick} Points.
      </p>
      <ul>
        <li><strong>Prize pool:</strong> {r.picks.daily.poolLabel} {r.token.symbol}, shared by the <strong>Top {r.picks.topRewarded}</strong>.</li>
        <li><strong>To be prize-eligible</strong> you need at least <strong>{r.picks.dailyMinimumPicks} valid Picks</strong> that day. That is a bar for prizes only — it is <em>not</em> a limit on how many Picks score.</li>
      </ul>
      <PrizeTable pool={r.picks.daily.pool} label="Daily" />

      <DocH2 id="weekly">Weekly leaderboard</DocH2>
      <p>
        The Weekly leaderboard runs from <strong>Monday 00:00 UTC to the next Monday 00:00 UTC</strong>, and works exactly like the Daily one over a whole week.
      </p>
      <ul>
        <li><strong>Prize pool:</strong> {r.picks.weekly.poolLabel} {r.token.symbol}, shared by the <strong>Top {r.picks.topRewarded}</strong>.</li>
        <li><strong>To be prize-eligible</strong> you need at least <strong>{r.picks.weeklyMinimumPicks} valid Picks</strong> that week — again a bar for prizes only, not a cap.</li>
      </ul>
      <PrizeTable pool={r.picks.weekly.pool} label="Weekly" />

      <DocH2 id="ranking-and-ties">Ranking and ties</DocH2>
      <p>
        Boards are ranked by <strong>correct Picks</strong> (which is the same as Points), then by <strong>accuracy</strong> — correct Picks as a share of all your Picks. If two players are exactly level on both, they
        are tied: they share the tied positions and split the prize for them equally. Nothing else breaks a tie — not your hero, your rarity, your balance or who got there first.
      </p>
      <Callout title="What never affects a ranking">
        Hero rarity and PWR, the class you picked, your $CLANKRPG holdings and your wallet have <strong>no effect</strong> on Points, rank or tie-breaks. The holder bonus only adds to a prize you have already earned —
        see <DocLink to="/docs/holder-bonus">Holder bonus</DocLink>.
      </Callout>

      <DocH2 id="prize-eligibility">Prize eligibility</DocH2>
      <p>
        Everyone who Picks appears on the board. Prizes, though, go to the Top {r.picks.topRewarded} <em>prize-eligible</em> players — those who reached the minimum ({r.picks.dailyMinimumPicks} Picks for the Daily board,
        {" "}{r.picks.weeklyMinimumPicks} for the Weekly). Below the minimum you are still scored and still ranked, marked <em>not yet prize eligible</em>; you just don&apos;t take a prize position. Unclaimed positions
        aren&apos;t rolled over — each pool is fixed.
      </p>
    </>
  );
}
