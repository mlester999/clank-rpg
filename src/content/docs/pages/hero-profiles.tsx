import { Callout, DocH2, DocLink } from "@/components/docs/prose";

export default function HeroProfiles() {
  return (
    <>
      <DocH2 id="the-public-page">The public page</DocH2>
      <p>
        Every active hero has a <strong>public page</strong> at its own link. It shows the hero&apos;s card, its Arena record <strong>for the current season</strong> (matches, wins, win rate, top-two finishes and
        knock-outs), its recent fights and, where it applies, its Arena Picks record. Anyone can open it — no sign-in needed — and the link never contains a name, a Telegram ID or anything private.
      </p>
      <p>A hero that is suspended, or whose member has been removed, has no public page: the link simply says the hero can&apos;t be found.</p>

      <DocH2 id="seasons-and-records">Seasons and records</DocH2>
      <p>
        Wins, matches, win rate and rank belong to the <strong>current season</strong>. When a season begins, every hero starts it at <strong>0 matches, 0 wins and Unranked</strong> — a new hero is on the same
        footing as one that has been fighting for months, and the first battle of a season is always Battle #1. A season&apos;s battles keep their own record and their results can still be replayed.
      </p>
      <Callout title="Records reset — heroes do not">
        A new season never touches the hero itself: its rarity, class, stats, PWR, look, public page and link all stay exactly as they were. Only the competitive record starts again.
      </Callout>
      <p>
        While Clank RPG is still being built, the Arena runs <strong>development test battles</strong>. They are clearly labelled, they are not an official record, and none of their wins or Picks carry into Season 1.
      </p>

      <DocH2 id="the-hero-card">The hero card</DocH2>
      <p>The card is the hero in one picture. From top to bottom:</p>
      <ol>
        <li>the hero&apos;s <strong>art</strong> — the hero standing in the arena of its rarity,</li>
        <li>its <strong>name</strong>,</li>
        <li>its <strong>rarity and class</strong>,</li>
        <li>its <strong>PWR</strong>, one of the biggest things on the card,</li>
        <li>and its <strong>seven stats</strong>.</li>
      </ol>
      <p>Each rarity has its own arena — natural stone and foliage for Common, blue runes for Rare, purple crystals for Epic, and the gold-and-purple, most ornate arena for Legendary — so you can tell a Legendary from a Common before you read a single number. The PWR ranges of the rarities are listed on the <DocLink to="/docs/rarity">Rarity &amp; power</DocLink> page.</p>

      <DocH2 id="share-and-download">Share and download</DocH2>
      <p>On a hero&apos;s page you can:</p>
      <ul>
        <li><strong>Download card</strong> — a square PNG of the card, ready to post anywhere,</li>
        <li><strong>Share to X</strong> — opens a post with the hero&apos;s details and link ready to send (attach the downloaded card image yourself),</li>
        <li><strong>Copy link</strong> — copies the page link.</li>
      </ul>
      <Callout title="Always the current hero">
        The page, the card and the share preview always show the hero as it is now. Nothing on them is private: no Telegram ID, no wallet and no internal details.
      </Callout>

      <DocH2 id="the-heroes-directory">The heroes directory</DocH2>
      <p>
        The <DocLink to="/heroes">Heroes directory</DocLink> lists every active hero with its art, name, rarity badge, class and PWR. You can filter by rarity (Common, Rare, Epic, Legendary) and by class, search
        by name, and sort by PWR from high to low or low to high. It is a directory, not a marketplace: heroes can&apos;t be bought, sold or traded.
      </p>
    </>
  );
}
