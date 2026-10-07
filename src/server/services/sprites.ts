import type { AppearanceParts } from "@/domain/character/appearance";
import { deriveSpriteConfig } from "@/domain/sprites/config";
import { json, type Queryable } from "../db/types";
import { loadClasses } from "../config/settingsRepo";

const BATCH = 500;

/**
 * Persists a sprite config for every hero that predates the layered-sprite system (or was
 * created by a path that did not set one). Idempotent and race-safe (`sprite is null` guard):
 * once stored, a hero's look is frozen against future catalogue changes.
 */
export async function backfillSpriteConfigs(q: Queryable): Promise<number> {
  let total = 0;
  let classes: Map<string, { look: Parameters<typeof deriveSpriteConfig>[1] }> | null = null;
  for (;;) {
    const rows = await q.query<{ character_id: string; parts: unknown; class_id: string }>(
      `select ca.character_id, ca.parts, c.class_id
         from public.character_appearances ca join public.characters c on c.id = ca.character_id
        where ca.sprite is null order by ca.character_id limit ${BATCH}`,
    );
    if (rows.length === 0) return total;
    classes ??= new Map((await loadClasses(q, false)).map((c) => [c.id, { look: c.look }]));
    for (const r of rows) {
      const config = deriveSpriteConfig(r.parts as AppearanceParts, classes.get(r.class_id)?.look);
      await q.query("update public.character_appearances set sprite = $2::jsonb where character_id = $1 and sprite is null", [r.character_id, json(config)]);
      total++;
    }
    if (rows.length < BATCH) return total;
  }
}
