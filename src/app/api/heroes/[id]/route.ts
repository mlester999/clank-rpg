import { isSelfHeroStatus } from "@/domain/heroOwnership";
import { loadRuleset } from "@/server/config/settingsRepo";
import { fail, getViewer, ok, guarded } from "@/server/http/guards";
import { getReadyDb, getSettings } from "@/server/runtime";
import { getBalance } from "@/server/services/economy";
import { loadFighters } from "@/server/services/characters";
import { classVisuals, getCharacterDto } from "@/server/services/views";
import { listInventory } from "@/server/services/inventory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleGET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return fail("NOT_FOUND", 404);
  const db = await getReadyDb();
  const settings = await getSettings();
  const { ruleset } = await loadRuleset(db, settings);
  const [fighter] = await loadFighters(db, [id], ruleset, settings);
  if (!fighter) return fail("NOT_FOUND", 404);
  const hero = await getCharacterDto(db, id, settings, { stats: fighter.stats, breakdown: fighter.breakdown as never, power: fighter.power });
  if (!hero) return fail("NOT_FOUND", 404);
  const viewer = await getViewer(req);
  const isOwner = Boolean(viewer && viewer.characterId === id && viewer.claimed);
  const owner = isOwner
    ? {
        tactic: fighter.tactic,
        gold: await getBalance(db, id),
        inventory: await listInventory(db, id),
        wallet: (await db.query<{ address: string }>("select address from public.wallet_links where character_id = $1 and unlinked_at is null", [id]))[0]?.address ?? null,
      }
    : null;
  const cls = ruleset.classes[hero.classId];
  // The hero's own availability is told to its own member only (claimed or not) — never to the public, and never with a reason.
  const [status] = viewer && viewer.characterId === id ? await db.query<{ status: string }>("select status from public.characters where id = $1", [id]) : [];
  const self = status && isSelfHeroStatus(status.status) ? { heroStatus: status.status } : null;
  return ok({ hero, isOwner, owner, classVisual: cls ? classVisuals([cls])[cls.id] : null, self });
}

export const GET = guarded("heroes/[id]", handleGET);
