import { Callout, DocH2, DocLink, DocTable } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

export default function Rewards() {
  const r = GAME_RULES;
  return (
    <>
      <DocH2 id="points-and-prizes">Points and prizes</DocH2>
      <p>There are two things you can earn, and they are kept apart:</p>
      <DocTable
        caption="What you can earn"
        head={["What", "How you earn it", "What it does"]}
        rows={[
          ["Points", `A correct Arena Pick is +${r.picks.pointsPerCorrectPick}.`, "Decides your place on the Daily and Weekly leaderboards."],
          [r.token.symbol, `Finish in the Top ${r.picks.topRewarded} of a rewarded Daily or Weekly board — with enough valid Picks for Arena Picks, or enough Arena Wins for Hero Arena.`, "A prize paid from that board's fixed pool."],
        ]}
      />
      <p>
        <strong>No token is paid per battle.</strong> {r.token.symbol} is only ever paid by the rewarded leaderboards. <strong>Arena Picks</strong> pays <strong>{r.picks.daily.poolLabel}</strong> a day and{" "}
        <strong>{r.picks.weekly.poolLabel}</strong> a week, each shared by the Top {r.picks.topRewarded}. <strong>Hero Arena</strong> is a separate program with its own pools, set by the team and shown on its boards (until
        they are set, a board says <em>Reward pool not set</em>). The pools are fixed — they don&apos;t grow or shrink with the number of players. Season boards and Hero Records pay nothing.
      </p>
      <p>
        A Hero Arena prize belongs to the hero&apos;s <strong>owner</strong>. If the hero hasn&apos;t been claimed yet, the prize is reserved for it and released to whoever claims it — never to anyone else.
      </p>

      <DocH2 id="the-prize-ladder">The prize ladder</DocH2>
      <p>One ladder is used for both boards. Your share is a percentage of the pool for your position:</p>
      <DocTable
        caption="Prize ladder"
        head={["Position", "Share of the pool"]}
        rows={r.picks.prizeLadderPercent.map((p, i) => [`#${i + 1}`, `${p}%`])}
      />
      <p>
        See <DocLink to="/docs/leaderboards">Leaderboards</DocLink> for the exact amounts on each board and for how ties and minimums work.
      </p>

      <DocH2 id="before-the-token-launches">Before the token launches</DocH2>
      <Callout tone="warn" title="Rewards are recorded now; claims open later">
        The {r.token.symbol} token has not launched yet. Until it does, the game still keeps score: Picks, Points, leaderboard results and the prizes you earn are all <strong>recorded</strong>, and they stay yours.
        Nothing is lost while you wait, and nothing is denied. Claims open after launch — see <DocLink to="/docs/claims">Claims</DocLink>.
      </Callout>
      <p>The game never asks you for anything to earn a prize, and the docs never state a token address that doesn&apos;t exist.</p>

      <DocH2 id="what-rewards-never-depend-on">What rewards never depend on</DocH2>
      <ul>
        <li><strong>Your hero&apos;s rarity or PWR.</strong> A correct Pick is worth the same on every hero.</li>
        <li><strong>Spending money.</strong> Picks are free and there is nothing to buy to earn Points.</li>
        <li><strong>Holding the token.</strong> Holding {r.token.symbol} never changes your Points or your rank. It can only add a <DocLink to="/docs/holder-bonus">bonus</DocLink> on a prize you already won.</li>
      </ul>
    </>
  );
}
