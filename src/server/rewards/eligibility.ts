import type { Queryable } from "../db/types";

/**
 * Who may make REWARDED Arena Picks. Reward eligibility is the strong Telegram eligibility the hero system already uses —
 * never a raw message count, never anything the browser says:
 *
 *   · signed in through Telegram (the caller proves it; the immutable numeric Telegram id is the identity),
 *   · ≥ `threshold` QUALIFYING messages in the official Clank.trade community (`qualifying_message_count`, set only by the
 *     official-chat ingest — anti-spam formulas stay private),
 *   · an ACTIVE generated Clank RPG hero (1 Telegram id → 1 hero, enforced by a UNIQUE constraint),
 *   · not banned, and not SUSPENDED for rewards.
 *
 * A member who is FLAGGED or under reward REVIEW can still pick and have rewards RECORDED, but their CLAIMS are held until an
 * admin reviews them (nothing is silently destroyed). The result is snapshotted on the pick every time it is submitted and
 * frozen when picks lock, so a correct pick never vanishes because unrelated profile state changed a second later.
 */
export type IneligibleReason = "NOT_FOUND" | "BANNED" | "DEMO_NOT_ALLOWED" | "NO_HERO" | "HERO_INACTIVE" | "BELOW_THRESHOLD" | "SUSPENDED";
export type ReviewState = "NORMAL" | "REVIEW" | "SUSPENDED";

export interface RewardEligibility {
  eligible: boolean;
  reason: IneligibleReason | null;
  /** Effective review state (the account's, raised by a Telegram FLAGGED status). */
  reviewState: ReviewState;
  qualifying: number;
  threshold: number;
  heroId: string | null;
}

/**
 * What a PLAYER may be told about why they are not eligible: only the explainable, non-sensitive reasons. Bans, suspensions,
 * inactive heroes and demo accounts all read as the same generic "not eligible" — internal risk state is never exposed.
 */
export type PublicIneligibleReason = "NO_HERO" | "BELOW_THRESHOLD" | "NOT_ELIGIBLE";
export const publicIneligibleReason = (reason: IneligibleReason | null): PublicIneligibleReason | null =>
  reason === null ? null : reason === "NO_HERO" || reason === "BELOW_THRESHOLD" ? reason : "NOT_ELIGIBLE";

/** The one public sentence about who can take part. It deliberately says nothing about how messages are scored. */
export const eligibilityExplanation = (threshold: number): string => `Members with ${threshold}+ qualifying messages in the official Clank.trade community can participate in rewarded Arena Picks.`;

export async function getRewardEligibility(q: Queryable, telegramUserId: number, opts: { threshold: number; allowDemo: boolean }): Promise<RewardEligibility> {
  const [row] = await q.query<{ status: string; is_demo: boolean; qualifying: number; hero: string | null; hero_status: string | null; review_state: ReviewState | null }>(
    `select tu.status, tu.is_demo, tu.qualifying_message_count as qualifying, c.id as hero, c.status as hero_status, ra.review_state
       from public.telegram_users tu
       left join public.characters c on c.telegram_user_id = tu.telegram_user_id
       left join public.arena_reward_accounts ra on ra.telegram_user_id = tu.telegram_user_id
      where tu.telegram_user_id = $1`,
    [telegramUserId],
  );
  const base = { qualifying: row?.qualifying ?? 0, threshold: opts.threshold, heroId: row?.hero ?? null };
  if (!row) return { ...base, eligible: false, reason: "NOT_FOUND", reviewState: "NORMAL" };
  const account: ReviewState = row.review_state ?? "NORMAL";
  const reviewState: ReviewState = account === "NORMAL" && row.status === "FLAGGED" ? "REVIEW" : account;
  const no = (reason: IneligibleReason) => ({ ...base, eligible: false, reason, reviewState });
  if (row.status === "BANNED") return no("BANNED");
  if (row.is_demo && !opts.allowDemo) return no("DEMO_NOT_ALLOWED");
  if (!row.hero) return no("NO_HERO");
  if (row.hero_status === "SUSPENDED") return no("SUSPENDED");
  if (row.hero_status !== "ACTIVE") return no("HERO_INACTIVE");
  if (account === "SUSPENDED") return no("SUSPENDED");
  if (Number(row.qualifying) < opts.threshold) return no("BELOW_THRESHOLD");
  return { ...base, eligible: true, reason: null, reviewState };
}
