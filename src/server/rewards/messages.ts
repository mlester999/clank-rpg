/**
 * Player-facing wording for every reward / pick refusal. The server returns these with the stable error code so the client
 * never invents text, and none of them reveals an internal rule, flag or anti-abuse signal.
 */
export const REWARD_MESSAGES: Record<string, string> = {
  TOKEN_NOT_LAUNCHED: "Claims will open after $CLANKRPG launches. Your rewards are safe and stay claimable — nothing is lost or denied.",
  CLAIMS_UNAVAILABLE: "Claims are temporarily unavailable. Your rewards are safe and will continue accumulating.",
  CLAIMS_HELD: "Claims on your account are on hold for now. Your rewards are safe and will keep accumulating.",
  NOT_ELIGIBLE: "This account can't claim rewards right now. Your rewards are safe.",
  DESTINATION_REQUIRED: "Enter the wallet where you want to receive this reward.",
  NO_HOLDER_WALLET: "You haven't connected a holder wallet. Enter the wallet where you want to receive this reward.",
  INVALID_WALLET: "That doesn't look like a valid wallet address for Robinhood Chain. Check it and try again.",
  WALLET_IN_USE: "This wallet is already linked to another Clank RPG account.",
  HOLDER_WALLET_IN_USE: "This wallet is already linked to another Clank RPG account.",
  BELOW_MINIMUM: "Your claimable rewards are below the minimum claim. They keep accumulating — nothing is lost.",
  NOTHING_TO_CLAIM: "You have no claimable rewards yet.",
  CLAIM_IN_PROGRESS: "You already have a claim waiting to be paid.",
  FRESH_AUTH_REQUIRED: "For your security, sign in with Telegram again, then connect a different holder wallet.",
  REWARDS_UNAVAILABLE: "Rewards are not available yet.",
  HOLDERS_UNAVAILABLE: "Holder benefits aren't available yet. Arena Picks, Points and the leaderboards work exactly as before.",
  INVALID_CHALLENGE: "That wallet request expired or was already used. Connect your wallet again.",
  BAD_SIGNATURE: "That signature doesn't match this wallet. Nothing was changed.",
  THROTTLED: "Holdings were refreshed a moment ago. You can refresh again in a few minutes.",
  RATE_LIMITED: "Too many requests. Try again in a moment.",
};

export const rewardMessage = (code: string): string | undefined => REWARD_MESSAGES[code];
