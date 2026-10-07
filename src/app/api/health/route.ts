import { NextResponse } from "next/server";

import { viewerAdvanceEnabled } from "@/server/env";
import { getReadyDb } from "@/server/runtime";
import { arenaHealth } from "@/server/services/arenaHealth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Liveness + readiness: `ok` means the database answers. `arena.advancedBy` says who moves the Arena ("viewers" until ARENA_VIEWER_ADVANCE=off, then "worker"),
 * and `arena.stalled` turns true when something that was due has not happened for 30 s — the signal that the worker is down once viewers are read-only.
 * (A health probe must never fail because of the Arena, so a problem reading it is reported as `arena: null`, not as a failure.)
 */
export async function GET() {
  try {
    const db = await getReadyDb();
    const [m] = await db.query<{ latest: string | null }>("select max(version) as latest from supabase_migrations.schema_migrations");
    const arena = await arenaHealth(db, Date.now()).catch(() => null);
    return NextResponse.json(
      { ok: true, driver: db.driver, schemaVersion: m?.latest ?? null, arena: arena ? { ...arena, advancedBy: viewerAdvanceEnabled() ? "viewers" : "worker" } : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "3" } });
  }
}
