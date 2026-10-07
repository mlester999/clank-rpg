/**
 * Who this hero belongs to, as the profile page presents it. Pure: the UI renders it, tests pin it.
 *
 * CLAIMING is an ACCOUNT fact, separate from rarity and class: a community hero is created from Telegram activity, and the member it was
 * created for can claim it by signing in with Telegram. Nothing about claiming changes the hero's stats, PWR or rank.
 */
export type OwnershipKind =
  /** A hand-crafted team character — it has no Telegram member behind it, so there is nothing to claim. */
  | "TEAM"
  /** A preview hero (local development only). */
  | "DEMO"
  /** Unclaimed, and nobody is signed in: the call to action is "Sign in with Telegram". */
  | "UNCLAIMED_SIGNED_OUT"
  /** Unclaimed and the signed-in member IS this hero's member: they can claim it now. */
  | "UNCLAIMED_CLAIMABLE"
  /** Unclaimed, and the signed-in member is somebody else. */
  | "UNCLAIMED_OTHER"
  /** Claimed, and the signed-in member owns it. */
  | "CLAIMED_OWNER"
  /** Claimed, seen by anyone else (signed out or signed in as another member). */
  | "CLAIMED_PUBLIC";

export interface OwnershipInput {
  hero: { id: string; kind: string; isDemo: boolean; claimed: boolean };
  /** The signed-in member's hero link, or null when nobody is signed in. */
  viewer: { characterId: string | null; claimed: boolean } | null;
}

export function heroOwnership({ hero, viewer }: OwnershipInput): OwnershipKind {
  const mine = Boolean(viewer && viewer.characterId === hero.id);
  if (hero.kind === "SPECIAL_CHARACTER") return "TEAM";
  // A local-preview hero is "demo" for everyone EXCEPT the member signed in as it — a development login must still be able to walk the claim flow.
  if (hero.isDemo && !mine) return "DEMO";
  if (hero.claimed) return mine ? "CLAIMED_OWNER" : "CLAIMED_PUBLIC";
  if (!viewer) return "UNCLAIMED_SIGNED_OUT";
  return mine && !viewer.claimed ? "UNCLAIMED_CLAIMABLE" : "UNCLAIMED_OTHER";
}

/** The hero's own status, which only its own signed-in member is told (it is never in the public hero data). */
export type SelfHeroStatus = "ACTIVE" | "INACTIVE" | "SUSPENDED";

export const isSelfHeroStatus = (v: unknown): v is SelfHeroStatus => v === "ACTIVE" || v === "INACTIVE" || v === "SUSPENDED";
