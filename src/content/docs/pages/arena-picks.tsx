import { Callout, DocH2, DocLink } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

export default function ArenaPicks() {
  const r = GAME_RULES;
  return (
    <>
      <DocH2 id="what-a-pick-is">What a Pick is</DocH2>
      <p>
        A <strong>Pick</strong> is your prediction of which of the {r.arena.heroesPerBattle} heroes will <strong>win the next battle</strong>. Picks are free: there is nothing to stake, nothing to deposit and no wallet
        to connect.
      </p>
      <ul>
        <li>You can make <strong>unlimited valid Picks</strong> — one in every battle, as many battles as you like.</li>
        <li>There is <strong>one Pick per battle</strong>. You can change it while the Pick window is open.</li>
        <li>A <strong>correct</strong> Pick earns <strong>+{r.picks.pointsPerCorrectPick} Points</strong>. A wrong Pick earns 0 — and costs you nothing.</li>
      </ul>

      <DocH2 id="how-a-round-flows">How a round flows</DocH2>
      <p>
        Picks always look <em>one battle ahead</em>. While the current battle (call it A) is being fought on stage, the eight heroes of the <strong>upcoming</strong> battle (B) are listed beside it, ready to be
        picked.
      </p>
      <ol>
        <li><strong>Battle A is on stage.</strong> You Pick the winner of B.</li>
        <li><strong>A is decided.</strong> The moment its winner is known, the Picks for B <strong>lock</strong>. You can&apos;t pick or change after that.</li>
        <li><strong>B takes the stage</strong> and is fought, and Picks for <strong>C</strong> open.</li>
        <li><strong>B is decided.</strong> Your Pick for B is scored: correct is +{r.picks.pointsPerCorrectPick}, wrong is 0.</li>
      </ol>
      <p>
        The server decides when the window closes, not your browser, and the pick counts of other players stay hidden until a window has locked — so nobody can simply follow the crowd.
      </p>

      <DocH2 id="scoring">Scoring</DocH2>
      <p>
        <strong>Every valid Pick counts.</strong> Correct Picks earn Points, and your Points feed both the <DocLink to="/docs/leaderboards">Daily and the Weekly leaderboard</DocLink>. There is no per-battle token payout:
        Picks pay out through the leaderboards, not battle by battle.
      </p>
      <Callout title="Rarity doesn't change the score">
        A correct Pick is worth the same +{r.picks.pointsPerCorrectPick} whether you backed a Common or a Legendary. Backing a favourite doesn&apos;t earn extra, and backing an underdog doesn&apos;t either — a win is a win.
      </Callout>

      <DocH2 id="who-can-pick">Who can Pick</DocH2>
      <p>
        To make a Pick that counts, you need to be <strong>signed in with Telegram</strong> and have an <strong>active hero</strong> — which means you have reached the {r.community.telegramThreshold} qualifying messages and your
        account is in good standing. Anyone can watch, but only eligible members&apos; Picks count toward the leaderboards.
      </p>

      <DocH2 id="what-picks-are-not">What Picks are not</DocH2>
      <p>
        Arena Picks are <strong>not betting</strong>. You never put anything at risk and there is no pool you pay into. The prizes come from fixed pools set aside for the leaderboards, and a wrong Pick simply earns nothing.
      </p>
    </>
  );
}
