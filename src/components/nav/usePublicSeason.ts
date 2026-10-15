"use client";

import type { PublicSeasonDto } from "@/domain/publicPresentation";
import { api } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";

/** Where the game stands (pre-season or a live season), as the PUBLIC is told: null until the server has answered — no chip is better than a wrong one. */
export function usePublicSeason(): PublicSeasonDto | null {
  const { data } = useRemote<PublicSeasonDto>(() => api<PublicSeasonDto>("/api/season"), "public-season");
  return data ?? null;
}
