import Link from "next/link";

import { Callout, DocH2, RarityLadderStrip } from "@/components/docs/prose";
import { DOC_PAGES, docHref } from "@/content/docs/registry";
import { GAME_RULES } from "@/domain/gameRules";

const START_HERE = ["getting-started", "heroes", "rarity", "arena", "arena-picks", "leaderboards", "rewards", "faq"] as const;
const LABELS: Record<(typeof START_HERE)[number], string> = {
  "getting-started": "Getting started",
  heroes: "Heroes",
  rarity: "Rarity & power",
  arena: "Arena",
  "arena-picks": "Arena Picks",
  leaderboards: "Leaderboards",
  rewards: "Rewards",
  faq: "FAQ",
};

export default function Home() {
  const r = GAME_RULES;
  return (
    <>
      <DocH2 id="what-is-clank-rpg">What is Clank RPG?</DocH2>
      <p>
        Clank RPG is an idle arena game built for the <strong>{r.community.name}</strong> community. If you are an active member of the official Telegram community, the game gives you a
        <strong> hero</strong> — a fighter with a class, a rarity, stats and a look of its own. Your hero then fights in a <strong>global Arena</strong> all day, with no controls and nothing for you to
        operate.
      </p>
      <p>
        What you <em>do</em> is watch, and <strong>Pick</strong> who you think will win the next battle. Picks are free. Correct Picks earn Points, and the Points decide the Daily and Weekly leaderboards.
      </p>

      <DocH2 id="where-to-start">Where to start</DocH2>
      <div className="grid grid-cols-1 gap-3 min-[520px]:grid-cols-2" data-testid="docs-home-cards">
        {START_HERE.map((slug) => {
          const page = DOC_PAGES.find((p) => p.slug === slug)!;
          return (
            <Link key={slug} href={docHref(slug)} className="docs-card docs-plain">
              <span className="font-display text-sm tracking-wide text-paper">{LABELS[slug]}</span>
              <span className="mt-1.5 block text-sm leading-snug text-steel-300">{page.summary}</span>
            </Link>
          );
        })}
      </div>

      <DocH2 id="the-short-version">The short version</DocH2>
      <ul>
        <li>
          <strong>Heroes.</strong> Send {r.community.telegramThreshold} qualifying messages in the official community and a hero is created for you. There are {r.hero.classCount} classes and four rarities.
        </li>
        <li>
          <strong>Rarity is a real strength tier.</strong> A higher rarity means a bigger stat budget and a higher PWR — from Common at {r.rarity.ladder[0]!.band} up to Legendary at {r.rarity.ladder[3]!.band}.
        </li>
        <li>
          <strong>The Arena.</strong> {r.arena.heroesPerBattle} heroes enter, the last one standing wins. A battle never lasts longer than {r.arena.maxCombatSeconds} seconds.
        </li>
        <li>
          <strong>Picks.</strong> Free and unlimited — one Pick per battle. A correct Pick is +{r.picks.pointsPerCorrectPick} Points; a wrong one is 0 and costs nothing.
        </li>
        <li>
          <strong>Leaderboards.</strong> Daily: {r.picks.daily.poolLabel} {r.token.symbol}. Weekly: {r.picks.weekly.poolLabel} {r.token.symbol}. Top {r.picks.topRewarded} on each.
        </li>
      </ul>
      <RarityLadderStrip />
      <Callout title="Game, not a market">
        Heroes are game characters. They are not NFTs, they cannot be bought, sold or traded, and nothing about the game asks you to spend money to play.
      </Callout>
    </>
  );
}
