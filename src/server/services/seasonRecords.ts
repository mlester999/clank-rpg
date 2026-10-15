import { publicSeasonLabel, type SeasonKind } from "@/domain/lifecycle";

import type { Queryable } from "../db/types";

/**
 * A hero's record in the ACTIVE season (a development run before the launch, Season 1 after it, …) — the figures every public surface shows as
 * "wins / matches / win rate / rank". They come from `season_character_stats`, which settlement maintains per season, so a new season is zero by
 * construction: no row, no reset, no deleted history. The hero's lifetime counters on `characters` are the all-time career and are NOT what is shown.
 */
export interface SeasonRecord {
  season: { id: string; kind: SeasonKind; number: number | null; name: string; label: string } | null;
  battles: number;
  wins: number;
  top2: number;
  eliminations: number;
  damage: number;
  points: number;
}

interface Row {
  id: string;
  kind: SeasonKind;
  number: number | null;
  name: string;
  battles: number | null;
  wins: number | null;
  top2: number | null;
  eliminations: number | null;
  damage: number | string | null;
  points: number | null;
}

export async function activeSeasonRecord(q: Queryable, characterId: string): Promise<SeasonRecord> {
  const [r] = await q.query<Row>(
    `select s.id, s.kind, s.number, s.name, ss.battles, ss.wins, ss.top2, ss.eliminations, ss.damage, ss.points
       from public.seasons s left join public.season_character_stats ss on ss.season_id = s.id and ss.character_id = $1
      where s.status = 'ACTIVE' limit 1`,
    [characterId],
  );
  if (!r) return { season: null, battles: 0, wins: 0, top2: 0, eliminations: 0, damage: 0, points: 0 };
  return {
    season: { id: r.id, kind: r.kind, number: r.number, name: r.name, label: publicSeasonLabel(r) },
    battles: Number(r.battles ?? 0),
    wins: Number(r.wins ?? 0),
    top2: Number(r.top2 ?? 0),
    eliminations: Number(r.eliminations ?? 0),
    damage: Number(r.damage ?? 0),
    points: Number(r.points ?? 0),
  };
}
