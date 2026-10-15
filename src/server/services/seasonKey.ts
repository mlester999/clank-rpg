import type { Queryable } from "../db/types";

/**
 * The identity of the season being played, as ONE cheap read (the seasons table holds a handful of rows). The short-lived in-process memos in front of the public
 * boards put it in their key, so the moment a season changes — Season 1's launch above all — no process (this one or any other serverless instance) can serve a
 * board computed for the previous season: the key simply no longer matches. Nothing has to be invalidated, and nothing can be forgotten.
 */
export async function activeSeasonKey(q: Queryable): Promise<string> {
  const [row] = await q.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE' limit 1");
  return row?.id ?? "none";
}
