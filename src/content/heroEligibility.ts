import type { EligibilityState } from "@/domain/heroEligibility";

/**
 * Player-facing copy about becoming a hero. Rules for this file:
 *  - always "qualifying messages" — never wording that suggests sending N messages (that invites spam);
 *  - always "official Clank.trade Telegram community";
 *  - HIGH LEVEL only: no thresholds other than the headline number, no daily caps, no timings, no scoring weights.
 */

export const COMMUNITY = "official Clank.trade Telegram community";

export const arenaCard = (threshold: number) => ({
  title: "Who becomes a hero?",
  lead: `Members of the ${COMMUNITY} with ${threshold}+ qualifying messages are eligible to become heroes in Clank RPG.`,
  body: "Activity, engagement and message quality help shape each hero. Spam and repetitive low-quality messages don't count.",
  cta: "Learn more",
});

export const learnMore = (threshold: number) => ({
  title: "How heroes are made",
  points: [
    `Only activity in the ${COMMUNITY} counts.`,
    `Members with ${threshold}+ qualifying messages become eligible for a hero.`,
    "Quality matters. Thoughtful, original messages qualify; spam, repetition and farming don't.",
    "Replies, conversation and steady, active participation can all help shape your hero.",
    "Class is mostly chance, with a subtle nudge from how you take part. Once your hero is created, its class is set — players can't change it.",
    "You don't need to sign up first: heroes are created automatically. Sign in with Telegram afterwards to claim yours.",
  ],
});

export const characterCard = (threshold: number) => ({
  title: "Become a Clank RPG hero",
  lines: [
    `Clank RPG heroes are created automatically from members of the ${COMMUNITY}.`,
    `Reach ${threshold}+ qualifying messages to become eligible.`,
    "Your Telegram activity helps influence your hero's stats and class.",
    "Spam and repetitive low-quality messages don't count toward eligibility.",
  ],
  already: { title: "Already have a hero?", body: "Sign in with Telegram to claim it." },
});

export interface StatusCopy {
  tone: "info" | "progress" | "good" | "claimed";
  title: string;
  lines: string[];
  /** Only set for NOT_YET, from a verified count. */
  progress?: { value: number; max: number };
}

export function statusCopy(state: EligibilityState, threshold: number): StatusCopy | null {
  switch (state.kind) {
    case "SIGNED_OUT":
      return null;
    case "NOT_YET":
      return {
        tone: "progress",
        title: "Not yet eligible",
        lines: [`${state.qualifying} / ${state.threshold} qualifying messages`, `Keep taking part naturally in the ${COMMUNITY}.`],
        progress: { value: state.qualifying, max: state.threshold },
      };
    case "ELIGIBLE":
      return { tone: "good", title: "Hero eligible", lines: [`${threshold}+ qualifying messages reached.`, "Your hero will be created automatically."] };
    case "HERO_FOUND":
      return { tone: "good", title: "Hero found", lines: ["Your Clank RPG hero already exists.", "Claim it to manage tactics, gear and your wallet."] };
    case "CLAIMED":
      return { tone: "claimed", title: "Your hero is claimed", lines: ["Telegram identity verified."] };
    case "REVIEW":
      return { tone: "info", title: "Hero not available right now", lines: [`Activity on this account is being reviewed.`] };
    case "UNKNOWN":
      return { tone: "info", title: "Signed in", lines: [`Heroes are created automatically once a member of the ${COMMUNITY} reaches ${threshold}+ qualifying messages.`] };
  }
}
