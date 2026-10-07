import { fail, guarded } from "@/server/http/guards";
import { getReadyDb } from "@/server/runtime";
import { loadPhotoBytes } from "@/server/services/heroPhotos";
import { getAvatarStore } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public profile photo of one hero (admin override → Telegram photo). The storage bucket stays private; this is the
 * only way an image reaches a browser. 404 means "no photo" and the UI draws the generated class portrait.
 *
 * The URL carries `?v=<content hash>`, so a response whose `v` matches the current photo can be cached for a year
 * (it can never change under that URL), while a bare or outdated URL is revalidated quickly.
 *
 * Defence in depth for a user-influenced file: served with the stored, allow-listed image type, `nosniff`, and a
 * CSP that disables everything (even if something opened it as a document, nothing could run).
 */
async function handleGET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return fail("NOT_FOUND", 404);
  try {
    const store = getAvatarStore();
    if (!store) return fail("NOT_FOUND", 404);
    const photo = await loadPhotoBytes(await getReadyDb(), store, id.toLowerCase());
    if (!photo) return fail("NOT_FOUND", 404);

    const etag = `"${photo.version}"`;
    const requested = new URL(req.url).searchParams.get("v");
    const headers: Record<string, string> = {
      "Content-Type": photo.mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      ETag: etag,
      "Cache-Control": requested === photo.version ? "public, max-age=31536000, immutable" : "public, max-age=60, must-revalidate",
    };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(photo.bytes as BodyInit, { status: 200, headers: { ...headers, "Content-Length": String(photo.bytes.byteLength) } });
  } catch (error) {
    console.error("[avatars]", error);
    return fail("AVATAR_UNAVAILABLE", 503);
  }
}

export const GET = guarded("avatars/[id]", handleGET);
