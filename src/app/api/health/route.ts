import { NextResponse } from "next/server";

import { getReadyDb } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const db = await getReadyDb();
    const [m] = await db.query<{ latest: string | null }>("select max(version) as latest from supabase_migrations.schema_migrations");
    return NextResponse.json({ ok: true, driver: db.driver, schemaVersion: m?.latest ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
