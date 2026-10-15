import { Callout, DocH2, DocLink, DocTable } from "@/components/docs/prose";
import { DEFAULT_ACHIEVEMENTS } from "@/domain/content/achievements";
import { DEFAULT_SETTINGS } from "@/domain/settings";

const n = (x: number): string => x.toLocaleString("en-US");

export default function GoldAndGear() {
  const shop = DEFAULT_SETTINGS.shop;
  const reroll = DEFAULT_SETTINGS.hero_reroll;
  const gold = DEFAULT_ACHIEVEMENTS.reduce((sum, a) => sum + (a.reward.gold ?? 0), 0);
  return (
    <>
      <DocH2 id="what-clank-gold-is">What Clank Gold is</DocH2>
      <p>
        Clank Gold is the game&apos;s own currency. It lives inside the game: it can&apos;t be traded, sent or withdrawn, it has no cash value, and it never changes your hero&apos;s PWR. It exists so that playing has a
        reward you can <em>do something with</em>.
      </p>
      <DocTable
        caption="Where Gold comes from"
        head={["Source", "How much"]}
        rows={[
          ["Every Arena fight", "A little for taking part, more for placing high, and a little for every elimination — about 10 Gold per fight on average."],
          ["A correct Arena Pick", "A small amount."],
          ["Achievements", `Every achievement pays a one-off reward — ${n(Math.min(...DEFAULT_ACHIEVEMENTS.map((a) => a.reward.gold ?? 0)))} to ${n(Math.max(...DEFAULT_ACHIEVEMENTS.map((a) => a.reward.gold ?? 0)))} Gold, ${n(gold)} in all.`],
          ["Selling spare gear", "See below."],
        ]}
      />

      <DocH2 id="the-gear-shop">The Gear Shop</DocH2>
      <p>
        Open <strong>Inventory</strong> and choose <strong>Gear Shop</strong>. You can buy weapons, armor and trinkets made for your hero&apos;s class, and sell spare gear back. Bought gear is exactly the same as gear that drops from
        the Arena: the same small bonus for its rarity, one item per slot, and it never changes your hero&apos;s PWR. Only the owner of a claimed hero can buy or sell.
      </p>
      <DocTable
        caption="Gear Shop prices"
        head={["Rarity", "Buy", "Sell a spare"]}
        rows={(["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"] as const).map((r) => [
          r[0] + r.slice(1).toLowerCase(),
          shop.buy[r] === null ? "Not sold — earned in the Arena" : `${n(shop.buy[r] as number)} Gold`,
          `${n(shop.sell[r])} Gold`,
        ])}
      />
      <p>Selling always pays less than buying, so the shop can only ever take Gold out of the game — it never creates it. An equipped item has to be unequipped before it can be sold.</p>

      <DocH2 id="achievements-and-titles">Achievements and titles</DocH2>
      <p>
        Every achievement does two things when you unlock it: it pays its <strong>Gold</strong> reward, and it unlocks a <strong>title</strong>. On your hero page you can choose <strong>one</strong> unlocked title to show above
        your hero&apos;s name — on the Arena stage, in the Current Round list and on the hero page. You choose; nothing is shown until you do, and you can change or remove it any time. A new title appears from your next fight.
      </p>
      <Callout title="Titles are for show">A title is a badge of what you&apos;ve done. It never changes stats, PWR, matchmaking or prizes.</Callout>

      <DocH2 id="rerolling-your-hero">Rerolling your hero</DocH2>
      <p>
        Every claimed member gets <strong>one free reroll per UTC day</strong>: a brand-new random roll from the same generator that creates every hero — same class odds, same rarity chances — that replaces your hero&apos;s class,
        rarity, stats and look. It can come out weaker as easily as stronger, it can&apos;t be undone, and you keep your Gold, items, achievements, record and rewards.
      </p>
      <p>
        When it opens, you can <strong>pay for more</strong>: <strong>{n(Number(reroll.paidPrice))} $CLANKRPG</strong> per extra reroll, up to {reroll.paidMaxPerDay} a day. Your own wallet opens and
        shows the payment — nothing moves unless you approve it, and Clank RPG never holds your keys. The roll is exactly as random as a free one; payments go to the reward treasury that funds the prize pools. A confirmed payment is
        never lost: if your hero happens to be in a live fight, the reroll simply waits for you.
      </p>
      <p>
        Paying has no effect on <DocLink to="/docs/arena-picks">Arena Picks</DocLink>, Points or your rank — see <DocLink to="/docs/rewards">Rewards</DocLink>.
      </p>
    </>
  );
}
