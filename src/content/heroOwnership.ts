import type { OwnershipKind, SelfHeroStatus } from "@/domain/heroOwnership";

/**
 * The ownership / status panel on a hero's profile. Short, plain, and public-safe:
 *  - nothing here says WHY a hero is suspended — moderation notes and reasons are never sent to the page, so they cannot be shown;
 *  - nothing promises rewards, ranking or power from claiming — claiming only unlocks managing the hero.
 */
export interface OwnershipCopy {
  /** Tone drives the colours AND the icon, so the state is never colour alone. */
  tone: "claimed" | "unclaimed" | "action" | "neutral";
  /** The status word in the identity block ("UNCLAIMED", "CLAIMED", "TEAM HERO"). */
  label: string;
  /** One line, in the panel. */
  body: string;
  /** The call to action, when there is one. */
  cta: "SIGN_IN" | "CLAIM" | null;
}

export function ownershipCopy(kind: OwnershipKind, opts: { claimBlocked?: boolean } = {}): OwnershipCopy {
  switch (kind) {
    case "TEAM":
      return { tone: "neutral", label: "Team hero", body: "A hand-crafted Clank.trade team character.", cta: null };
    case "DEMO":
      return { tone: "neutral", label: "Demo hero", body: "A preview hero for testing — it doesn't belong to a member.", cta: null };
    case "UNCLAIMED_SIGNED_OUT":
      return { tone: "unclaimed", label: "Unclaimed", body: "Sign in with Telegram to claim this hero.", cta: "SIGN_IN" };
    case "UNCLAIMED_CLAIMABLE":
      // A suspended hero can't be claimed (the server refuses it) — so no button, rather than one that always fails.
      if (opts.claimBlocked) return { tone: "unclaimed", label: "Unclaimed", body: "This is your hero. It can't be claimed right now.", cta: null };
      return { tone: "action", label: "Hero found", body: "This is your hero. Claim it to manage tactics, gear and your wallet.", cta: "CLAIM" };
    case "UNCLAIMED_OTHER":
      return { tone: "unclaimed", label: "Unclaimed", body: "Only the Telegram member this hero was created for can claim it.", cta: null };
    case "CLAIMED_OWNER":
      return { tone: "claimed", label: "Claimed", body: "This is your hero. Telegram identity verified.", cta: null };
    case "CLAIMED_PUBLIC":
      return { tone: "claimed", label: "Claimed", body: "This hero has a verified Telegram owner.", cta: null };
  }
}

export interface ArenaNotice {
  title: string;
  body: string;
}

/**
 * Arena availability, for the hero's own member only. A suspended hero keeps its history, rank and gear; it just doesn't enter NEW Arena
 * rosters (a battle already on stage or announced is still fought). Reasons are deliberately absent.
 */
export function arenaNotice(status: SelfHeroStatus | null | undefined): ArenaNotice | null {
  if (status === "SUSPENDED") return { title: "Arena suspended", body: "This hero isn't entering new Arena battles right now. Its history and rank are kept." };
  if (status === "INACTIVE") return { title: "Not in the Arena", body: "This hero is inactive, so it isn't entering new Arena battles." };
  return null;
}
