import { buyUrl } from "@/domain/rewards/buyLink";
import { ok, guarded } from "@/server/http/guards";
import { getTokenStatus } from "@/server/rewards/context";
import { REWARD_SYMBOL } from "@/server/rewards/pool";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The OFFICIAL $CLANKRPG token, as configured on the server — the ONE place the contract address and the BUY link are served from, so
 * no client ever hard-codes one and there is no second (public) variable that could disagree with it. The address is public. Nothing
 * secret is here (there is no signing key anywhere), and nothing is answered from the chain: this is configuration only.
 *
 *  - `launched`  an official address is configured. FALSE until the token exists (a normal state).
 *  - `buyUrl`    `https://clank.trade/` until an address is configured, then `https://clank.trade/<address>` — the same BUY $CLANKRPG button, no code change.
 */
async function handleGET() {
  const t = getTokenStatus();
  return ok(
    {
      token: {
        launched: t.launched,
        configured: t.available,
        symbol: REWARD_SYMBOL,
        address: t.available ? t.publicAddress : null,
        chainId: t.available ? t.chainId : null,
        explorerTxUrl: t.available ? t.explorerTxUrl : null,
        buyUrl: buyUrl(t.publicAddress),
      },
    },
    { cache: "public, max-age=60" },
  );
}

export const GET = guarded("rewards/token", handleGET);
