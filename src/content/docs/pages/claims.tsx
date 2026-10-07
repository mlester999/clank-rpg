import { Callout, DocH2, DocLink } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

export default function Claims() {
  const r = GAME_RULES;
  return (
    <>
      <DocH2 id="how-claims-work">How claims work</DocH2>
      <p>
        When a Daily or Weekly leaderboard ends, its result is frozen and the prizes become <strong>claimable</strong>: they are added to your claimable balance. A <strong>claim</strong> is a request to be paid that balance
        in {r.token.symbol}, to a wallet address you provide.
      </p>
      <ul>
        <li>You claim your <strong>whole claimable balance</strong> at once, once it reaches the minimum of <strong>{r.picks.minimumClaimLabel} {r.token.symbol}</strong>.</li>
        <li>You choose where it is sent — your connected wallet, or another address just for that payout. Your wallet is never needed to <em>play</em>.</li>
        <li>While a claim is pending, its amount is set aside for you so it can&apos;t be spent twice.</li>
      </ul>

      <DocH2 id="manual-verified-payout">Manual, verified payout</DocH2>
      <p>
        Payouts are <strong>manual and verified</strong>. The game does not hold a signing key and never sends tokens by itself. Instead, a member of the team sends your payout by hand, and the game then checks that
        transfer on the blockchain — the right token, the right wallet and exactly the right amount — before it marks your claim as sent.
      </p>
      <p>
        Accounts under review can have claims held until the review is done. Nothing is silently taken away; the claim stays and the team follows up.
      </p>

      <DocH2 id="claims-before-launch">Claims before launch</DocH2>
      <Callout tone="warn" title={r.token.claimsClosedNotice}>
        Until {r.token.symbol} launches there is nothing to pay out, so claims stay closed and the claim panel says so. Your earned rewards remain recorded and claimable — <strong>nothing is lost or denied</strong>. They
        become claimable in {r.token.symbol} once it launches.
      </Callout>
      <p>
        The docs don&apos;t quote a contract address because there isn&apos;t one yet. Once the token launches, the game&apos;s {r.token.buyLabel} button points to it — be careful with any other address you are sent. For how prizes are earned in the first place, see <DocLink to="/docs/rewards">Rewards</DocLink>.
      </p>
    </>
  );
}
