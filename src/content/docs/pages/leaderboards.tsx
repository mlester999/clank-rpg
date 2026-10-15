import { Callout, DocH2, DocLink, DocTable, PrizeTable } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

export default function Leaderboards() {
  const r = GAME_RULES;
  const h = r.heroArena;
  return (
    <>
      <DocH2 id="the-hall">The Hall of Champions</DocH2>
      <p>
        The <DocLink to="/leaderboard">Leaderboard</DocLink> page is the <strong>Hall of Champions</strong>. It has three sections, and every one of them can be read by <strong>Daily</strong>,{" "}
        <strong>Weekly</strong> or <strong>Season</strong>:
      </p>
      <DocTable
        caption="The three sections"
        head={["Section", "Who competes", "Ranked by", "Pays?"]}
        rows={[
          ["Arena Picks", "Players", "Correct Picks (Points)", "Daily and Weekly are rewarded. Season is standings only."],
          ["Hero Arena", "Heroes", "Arena Wins", "Daily and Weekly are rewarded. Season is standings only."],
          ["Hero Records", "Heroes", "Top-2 finishes, KOs, PWR", "Never. Statistics and bragging rights."],
        ]}
      />
      <p>
        The two rewarded competitions are separate: each has its own boards, its own pool and its own results, and one never affects the other. A hero&apos;s Arena Wins do not give its owner Picks Points,
        and your Picks do not give your hero Arena Wins.
      </p>

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

      <DocH2 id="hero-arena">Hero Arena</DocH2>
      <p>
        Hero Arena ranks <strong>heroes</strong> by their <strong>Arena Wins</strong> — one win for every battle a hero finishes first. Only <strong>settled</strong> battles of the current season count, and a
        Daily or Weekly board counts only the wins that settled inside that UTC day or Monday-to-Monday week.
      </p>
      <ul>
        <li><strong>Daily and Weekly are rewarded.</strong> The Top {h.topRewarded} heroes with at least {h.minimumWins} win share the period&apos;s prize pool on the same ladder shape as the Picks boards: {h.prizeLadderPercent.map((p) => `${p}%`).join(", ")}.</li>
        <li><strong>Ties share.</strong> Heroes level on Arena Wins take the same rank and split the prizes of the positions they occupy equally. Nothing else breaks a tie — not rarity, class, PWR or who won first.</li>
        <li><strong>The prize goes to the hero&apos;s owner.</strong> If the hero has been claimed, the owner is credited. If it hasn&apos;t been claimed yet, the prize is <strong>reserved</strong> for that hero and is released to whoever claims it — it is never handed to anyone else and never redistributed.</li>
        <li><strong>The pool is set by the team.</strong> Until it is, the board shows <em>Reward pool not set</em>. No amount is promised before it is shown on the board.</li>
        <li><strong>Season is standings only.</strong> The Season board is the running total of Arena Wins for the season. It pays nothing.</li>
      </ul>
      <p>
        A hero that is later suspended keeps the wins it already settled on past boards, but cannot enter new battles. A hero&apos;s performance is never reset by changing how it looks.
      </p>
      <Callout title="What never affects Hero Arena">
        Rarity, PWR, class, your $CLANKRPG holdings and your wallet have <strong>no effect</strong> on Arena Wins or on rank. The holder bonus does not apply to Hero Arena prizes.
      </Callout>

      <DocH2 id="hero-records">Hero Records</DocH2>
      <p>
        Hero Records are <strong>statistics</strong>, not a competition: <strong>Top-2</strong> finishes and <strong>KOs</strong> (Daily, Weekly or Season) and a hero&apos;s current <strong>PWR</strong>. They carry no prizes.
        Wins live on Hero Arena, so they are not repeated here. PWR is a current figure, so it has no Daily, Weekly or Season view.
      </p>

      <DocH2 id="seasons">Seasons</DocH2>
      <p>
        Every board belongs to a season. When a new season begins, <strong>every Season board starts at zero</strong> and so do the Daily and Weekly boards — wins and Picks from an earlier season are never mixed in.
        Past seasons stay on record and can be browsed from the season selector once there is more than one. Before Season 1 launches, boards are labelled <strong>Pre-season</strong>: they are practice
        results, not an official record, and none of them carry into Season 1 — the Events page only ever shows the winners of official seasons.
      </p>
    </>
  );
}
