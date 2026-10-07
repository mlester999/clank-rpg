import { cardKey } from "@/domain/hero/card";
import { isPublicHeroId } from "@/domain/hero/publicId";
import { demoHeroesAllowed } from "@/server/env";
import { clientKey, fail, rateLimited, guarded } from "@/server/http/guards";
import { renderHeroCardPng } from "@/server/heroes/cardImage";
import { getAllClasses, getReadyDb, getSettings } from "@/server/runtime";
import { getCachedHeroCard, putCachedHeroCard } from "@/server/services/heroCache";
import { getPublicHeroCard } from "@/server/services/publicHeroes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The shareable hero card: a 1200 × 1200 PNG of the hero's CURRENT version, for any PUBLIC hero. It is also the image behind the social preview.
 *
 *  · Only public-safe data goes in (the canonical card model — see domain/hero/card.ts), and the hero must be visible under the normal moderation
 *    rules: anything else is a plain 404 that says nothing about why.
 *  · `?v=<key>` carries the card's content key. When it matches the current card the image is served as immutable (a reroll / rollback changes the key,
 *    so a stale image can never be reused); otherwise the current card is served without long-term caching.
 *  · `?download=1` sets a download filename. Nothing is read from the request except the id, the key and that flag.
 */
async function handleGET(req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await ctx.params;
  if (!isPublicHeroId(publicId)) return fail("NOT_FOUND", 404);
  if (rateLimited(`herocard:${clientKey(req)}`, 120, 60_000)) return fail("RATE_LIMITED", 429);
  const [db, settings, classes] = await Promise.all([getReadyDb(), getSettings(), getAllClasses()]);
  const card = await getPublicHeroCard(db, publicId, { allowDemo: demoHeroesAllowed(), classes, settings });
  if (!card) return fail("NOT_FOUND", 404);

  const key = cardKey(card);
  let png = getCachedHeroCard(publicId, key);
  if (!png) {
    png = await renderHeroCardPng(card, { spriteSet: settings.visuals.spriteSet });
    putCachedHeroCard(publicId, key, png);
  }
  const url = new URL(req.url);
  const matches = url.searchParams.get("v") === key;
  const headers: Record<string, string> = {
    "Content-Type": "image/png",
    "Cache-Control": matches ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
    ETag: `"${key}"`,
    "X-Content-Type-Options": "nosniff",
  };
  if (url.searchParams.get("download") === "1") headers["Content-Disposition"] = `attachment; filename="clank-rpg-hero-${publicId}.png"`;
  if (req.headers.get("if-none-match") === `"${key}"`) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(png), { headers });
}

export const GET = guarded("hero-cards/[publicId]", handleGET);
