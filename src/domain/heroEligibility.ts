/**
 * Where a visitor stands on the road to a hero. Pure: the UI renders it, tests pin it.
 *
 * Numbers are only ever shown when the backend supplied a VERIFIED qualifying-message count (the stored counter of the
 * signed-in Telegram member). Without one the state is UNKNOWN and no progress is invented.
 */
export interface EligibilityInput {
  /** Null = nobody is signed in. */
  viewer: {
    characterId: string | null;
    claimed: boolean;
    /** Verified count from the database; anything that is not a finite number ≥ 0 is treated as unavailable. */
    qualifyingMessages: number | null | undefined;
    /** 'FLAGGED' members are being reviewed and will not get a hero from their current activity. */
    status?: "OK" | "FLAGGED" | "BANNED" | undefined;
  } | null;
  threshold: number;
}

export type EligibilityState =
  | { kind: "SIGNED_OUT" }
  | { kind: "CLAIMED" }
  | { kind: "HERO_FOUND" }
  | { kind: "REVIEW" }
  | { kind: "ELIGIBLE" }
  | { kind: "NOT_YET"; qualifying: number; threshold: number }
  | { kind: "UNKNOWN" };

export function eligibilityState({ viewer, threshold }: EligibilityInput): EligibilityState {
  if (!viewer) return { kind: "SIGNED_OUT" };
  if (viewer.characterId) return viewer.claimed ? { kind: "CLAIMED" } : { kind: "HERO_FOUND" };
  if (viewer.status === "FLAGGED") return { kind: "REVIEW" };
  const n = viewer.qualifyingMessages;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return { kind: "UNKNOWN" };
  if (n >= threshold) return { kind: "ELIGIBLE" };
  return { kind: "NOT_YET", qualifying: Math.floor(n), threshold };
}
