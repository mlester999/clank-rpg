import type { Metadata } from "next";
import { formatWinRate } from "@/domain/progression/seasonRecord";
import Link from "next/link";
import { notFound } from "next/navigation";

import { HeroActions } from "@/components/hero/HeroActions";
import { HeroCard } from "@/components/hero/HeroCard";
import { cardKey, heroSocialMeta } from "@/domain/hero/card";
import { heroCardImagePath, heroUrl, isPublicHeroId } from "@/domain/hero/publicId";
import { demoHeroesAllowed, getEnv } from "@/server/env";
import { getAllClasses, getReadyDb, getSettings } from "@/server/runtime";
import { getPublicHero, getPublicHeroCard } from "@/server/services/publicHeroes";

export const dynamic = "force-dynamic";

async function context() {
  const [db, settings, classes] = await Promise.all([getReadyDb(), getSettings(), getAllClasses()]);
  return { db, ctx: { allowDemo: demoHeroesAllowed(), classes, settings } };
}

/** Open Graph / Twitter metadata of the CURRENT version: the image URL carries the card's content key, so a reroll or rollback never leaves an old image cached. */
export async function generateMetadata({ params }: { params: Promise<{ publicId: string }> }): Promise<Metadata> {
  const { publicId } = await params;
  if (!isPublicHeroId(publicId)) return { title: "Hero not found", robots: { index: false } };
  const { db, ctx } = await context();
  const card = await getPublicHeroCard(db, publicId, ctx);
  if (!card) return { title: "Hero not found", robots: { index: false } };
  const meta = heroSocialMeta(card, getEnv().NEXT_PUBLIC_APP_URL);
  const alt = `${card.name} — ${card.className}, ${card.rarity.toLowerCase()} hero card`;
  return {
    title: { absolute: meta.title },
    description: meta.description,
    alternates: { canonical: meta.url },
    openGraph: { title: meta.title, description: meta.description, url: meta.url, siteName: "Clank RPG", type: "website", images: [{ url: meta.imageUrl, width: 1200, height: 1200, alt }] },
    twitter: { card: "summary", title: meta.title, description: meta.description, images: [{ url: meta.imageUrl, alt }] },
  };
}

export default async function PublicHeroPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  if (!isPublicHeroId(publicId)) notFound();
  const { db, ctx } = await context();
  const hero = await getPublicHero(db, publicId, ctx);
  if (!hero) notFound(); // unknown, suspended, banned — the same page, never a reason
  const { card } = hero;
  const url = heroUrl(getEnv().NEXT_PUBLIC_APP_URL, card.publicId);
  const key = cardKey(card);
  const fmt = (n: number) => n.toLocaleString("en-US");
  const accuracy = hero.picks && hero.picks.total > 0 ? Math.round((hero.picks.correct / hero.picks.total) * 100) : null;

  return (
    <div className="mx-auto w-full max-w-[1000px] px-3 py-6 sm:px-6">
      <p className="mb-4 text-sm"><Link href="/heroes" className="text-clank-300 hover:text-clank-200">← All heroes</Link></p>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        <div className="min-w-0">
          <HeroCard model={card} animate heading="h1" />
          <HeroActions className="mx-auto mt-4 max-w-[440px]" model={card} url={url} downloadHref={`${heroCardImagePath(card.publicId, key)}&download=1`} />
        </div>

        <div className="min-w-0 space-y-4">
          <section className="plate plate-flat p-4" aria-labelledby="record-h">
            <h2 id="record-h" className="label">Arena record{hero.season ? ` · ${hero.season.label}` : ""}</h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="hero-record">
              {([["Matches", fmt(hero.record.battles)], ["Wins", fmt(hero.record.wins)], ["Win rate", formatWinRate(hero.record.battles, hero.record.wins)], ["Top 2", fmt(hero.record.top2)], ["KOs", fmt(hero.record.eliminations)]] as const).map(([label, v]) => (
                <div key={label} className="min-w-0"><dt className="label !text-[0.6rem]">{label}</dt><dd className="font-display text-xl text-paper tnum">{v}</dd></div>
              ))}
            </dl>
            {hero.season?.kind === "DEVELOPMENT" && <p className="mt-3 text-xs text-steel-300" data-testid="hero-dev-note">Development run — test battles, not an official record.</p>}
          </section>

          {hero.season && (
            <section className="plate plate-flat p-4" aria-labelledby="season-h">
              <h2 id="season-h" className="label">{hero.season.label}</h2>
              <p className="mt-2 text-paper" data-testid="hero-season-rank"><span className="font-display text-xl text-clank-200">{hero.season.rank}</span> <span className="text-sm text-steel-300">· {fmt(hero.season.points)} season points</span></p>
            </section>
          )}

          {hero.picks && hero.picks.total > 0 && (
            <section className="plate plate-flat p-4" aria-labelledby="picks-h">
              <h2 id="picks-h" className="label">Arena Picks</h2>
              <p className="mt-2 text-paper" data-testid="hero-picks"><span className="font-display text-xl tnum">{fmt(hero.picks.correct)}</span> <span className="text-sm text-steel-300">correct of {fmt(hero.picks.total)} picks{accuracy !== null ? ` · ${accuracy}% accuracy` : ""}</span></p>
            </section>
          )}

          <section className="plate plate-flat p-4" aria-labelledby="recent-h">
            <h2 id="recent-h" className="label">Recent fights</h2>
            {hero.recentBattles.length === 0 ? (
              <p className="mt-2 text-sm text-steel-300">No settled fights yet.</p>
            ) : (
              <ul className="mt-3 space-y-1.5" data-testid="hero-recent">
                {hero.recentBattles.map((b, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 rounded bg-white/[0.04] px-3 py-1.5 text-sm">
                    <span className={`font-display ${b.placement === 1 ? "text-clank-200" : "text-paper"}`}>{b.placement === 1 ? "Winner" : `#${b.placement}`}</span>
                    <span className="text-steel-300">{b.eliminations} KO{b.eliminations === 1 ? "" : "s"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
