import { DocH2, DocLink } from "@/components/docs/prose";
import { GAME_RULES } from "@/domain/gameRules";

function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group mb-2 rounded-lg border border-white/10 bg-white/[0.03] open:bg-white/[0.05]" data-testid="faq-item">
      <summary className="cursor-pointer list-none px-4 py-3 font-semibold text-paper [&::-webkit-details-marker]:hidden">
        <span className="mr-2 text-clank-400 group-open:hidden" aria-hidden>+</span>
        <span className="mr-2 hidden text-clank-400 group-open:inline" aria-hidden>−</span>
        {q}
      </summary>
      <div className="px-4 pt-1 pb-3 [&>p:last-child]:mb-0">{children}</div>
    </details>
  );
}

export default function Faq() {
  const r = GAME_RULES;
  const legend = r.rarity.ladder[3]!;
  const common = r.rarity.ladder[0]!;
  return (
    <>
      <DocH2 id="getting-a-hero">Getting a hero</DocH2>
      <Q q="How do I get a hero?">
        <p>
          Be an active member of the official {r.community.name} Telegram community and send {r.community.telegramThreshold} qualifying messages. A hero is created for you automatically.{" "}
          <DocLink to="/docs/getting-started">Getting started →</DocLink>
        </p>
      </Q>
      <Q q="Why don't I have a hero yet?">
        <p>
          Most likely you haven&apos;t reached {r.community.telegramThreshold} <em>qualifying</em> messages yet — not every message counts, because spam, floods, filler and copy-paste don&apos;t. It can also be that your
          account is under review. Keep taking part in the community, and ask there if you think something is wrong.
        </p>
      </Q>
      <Q q="What are qualifying Telegram messages?">
        <p>
          Real contributions to the conversation in the official community. Spam, floods, one-word filler, forwarded content and link-dropping don&apos;t count. The exact checks are kept private so they can&apos;t be
          gamed.
        </p>
      </Q>
      <Q q="Can I change my hero?">
        <p>No. A hero is generated for you and players can&apos;t re-roll, swap or buy one. If something is wrong with your hero, ask in the official community.</p>
      </Q>

      <DocH2 id="power-and-rarity">Power and rarity</DocH2>
      <Q q="What does PWR mean?">
        <p>
          PWR is one number that estimates a hero&apos;s overall combat strength, calculated from its stats. It lets you compare heroes of different classes at a glance.{" "}
          <DocLink to="/docs/power-and-stats">Power &amp; stats →</DocLink>
        </p>
      </Q>
      <Q q="Does higher rarity mean stronger?">
        <p>
          Yes. Rarity is a real strength tier: a higher rarity means a bigger stat budget and a higher PWR range — {common.label} is {common.band}, {legend.label} is {legend.band}, and the ranges don&apos;t overlap.{" "}
          <DocLink to="/docs/rarity">Rarity →</DocLink>
        </p>
      </Q>
      <Q q="Can a Common beat a Legendary?">
        <p>
          Yes. A Legendary has a clear advantage but not a guarantee: class matchups, positioning and luck still matter, and a battle has {r.arena.heroesPerBattle} heroes. In our testing a Legendary finishes ahead of a
          Common about {r.balance.legendaryOutplacesCommonPercent} times in 100 — so the Common wins the other {100 - r.balance.legendaryOutplacesCommonPercent}.
        </p>
      </Q>

      <DocH2 id="picks-and-leaderboards">Picks and leaderboards</DocH2>
      <Q q="How do Arena Picks work?">
        <p>
          While one battle is on stage, you pick the winner of the <em>next</em> one. Picks lock the moment the current battle is decided. A correct Pick is +{r.picks.pointsPerCorrectPick} Points; a wrong one is 0. You get
          one Pick per battle and can make as many as you like. <DocLink to="/docs/arena-picks">Arena Picks →</DocLink>
        </p>
      </Q>
      <Q q="Do I need tokens to make Picks?">
        <p>No. Picks are free and need no wallet and no tokens. You only need a hero and a Telegram sign-in.</p>
      </Q>
      <Q q="Does holding $CLANKRPG increase my leaderboard score?">
        <p>
          No. Holding {r.token.symbol} never changes your Points, your rank or any tie-break. It can only add a percentage bonus to a prize you have already earned.{" "}
          <DocLink to="/docs/holder-bonus">Holder bonus →</DocLink>
        </p>
      </Q>
      <Q q="How do the leaderboards pay out?">
        <p>
          The Daily board shares {r.picks.daily.poolLabel} {r.token.symbol} and the Weekly board {r.picks.weekly.poolLabel} {r.token.symbol} between their Top {r.picks.topRewarded}. You need at least {r.picks.dailyMinimumPicks} valid
          Picks (Daily) or {r.picks.weeklyMinimumPicks} (Weekly) to be prize-eligible. <DocLink to="/docs/leaderboards">Leaderboards →</DocLink>
        </p>
      </Q>

      <DocH2 id="tokens-and-claims">Tokens and claims</DocH2>
      <Q q="How are rewards claimed?">
        <p>
          You request a claim for your claimable balance, and the team pays it out by hand; the game then verifies the transfer on the blockchain. <DocLink to="/docs/claims">Claims →</DocLink>
        </p>
      </Q>
      <Q q="Why is the token not available yet?">
        <p>
          {r.token.symbol} hasn&apos;t launched yet, and the game doesn&apos;t invent a date or an address. Until it does, your Points and earned prizes are recorded safely and claims stay closed. Nothing you earn is lost while you wait.
        </p>
      </Q>

      <DocH2 id="the-game">The game</DocH2>
      <Q q="How often do battles happen?">
        <p>
          Continuously: one battle follows another. Each lasts at most {r.arena.maxCombatSeconds} seconds (most finish sooner), plus a short countdown and a results screen. <DocLink to="/docs/arena">The Arena →</DocLink>
        </p>
      </Q>
      <Q q="Are heroes NFTs, or can I trade them?">
        <p>No. Heroes are game characters. They aren&apos;t NFTs and can&apos;t be bought, sold or traded.</p>
      </Q>
    </>
  );
}
