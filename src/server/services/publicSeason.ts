import type { GamePhase, SeasonKind } from "@/domain/lifecycle";
import type { PublicSeasonDto } from "@/domain/publicPresentation";

import type { Queryable } from "../db/types";

/**
 * The persisted game phase and active season, in the words the PUBLIC uses (see domain/publicPresentation.ts). Read from `game_state` / `seasons` — product state in the
 * database, never an environment variable. A database from before the lifecycle migration is, by definition, still pre-season.
 */
export async function getPublicSeason(q: Queryable): Promise<PublicSeasonDto> {
  const [ready] = await q.query<{ ok: boolean }>("select to_regclass('public.game_state') is not null as ok");
  if (!ready?.ok) return { phase: "DEVELOPMENT", season: null };
  const [g] = await q.query<{ phase: GamePhase }>("select phase from public.game_state where id = 1");
  const [s] = await q.query<{ kind: SeasonKind; number: number | null }>("select kind, number from public.seasons where status = 'ACTIVE' limit 1");
  const phase: GamePhase = g?.phase === "LIVE" ? "LIVE" : "DEVELOPMENT";
  return { phase, season: s ? { kind: s.kind, number: s.number, label: s.kind === "COMPETITIVE" && s.number !== null ? `Season ${s.number}` : "Pre-season" } : null };
}
