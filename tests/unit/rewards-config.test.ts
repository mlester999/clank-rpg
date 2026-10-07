import { describe, expect, it } from "vitest";

import { getEnv } from "@/server/env";
import { buyLinkFor, NOT_LAUNCHED_REASON, resolveTokenConfig, retiredEnvPresent, SIMULATED_CHAIN_ID, SIMULATED_TOKEN_ADDRESS } from "@/server/rewards/config";

const TOKEN = "0x52908400098527886e0f7030069857d2e4169ee7";
const TREASURY = "0x8617e340b3d01fa5f11f306f4090fd50e238070d";
// The chain comes from the EXISTING Robinhood configuration — there is no second RPC / chain-id setting for the token. And there is NO decimals
// setting at all: the contract is the only authority for decimals() and symbol().
const GOOD = { CLANKRPG_TOKEN_ADDRESS: TOKEN, ROBINHOOD_RPC_URL: "https://rpc.example.org", ROBINHOOD_CHAIN_ID: "4663" };
const env = (over: Record<string, string | undefined> = {}, base: Record<string, string | undefined> = GOOD) => getEnv({ NODE_ENV: "test", ...base, ...over } as NodeJS.ProcessEnv);
const reasons = (over: Record<string, string | undefined>, base?: Record<string, string | undefined>) => {
  const r = resolveTokenConfig(env(over, base));
  return r.configured ? null : r.reasons;
};

describe("the $CLANKRPG token configuration: ONE setting (the address), FAILS CLOSED, and never blocks anything else", () => {
  it("with nothing configured the token has NOT LAUNCHED — a normal state, not an error — and the reason says exactly that", () => {
    const r = resolveTokenConfig(env({}, {}));
    expect(r).toEqual({ configured: false, launched: false, reasons: [NOT_LAUNCHED_REASON] });
    expect(NOT_LAUNCHED_REASON).toMatch(/has not launched yet/);
    expect(JSON.stringify(r)).not.toMatch(/decimals/i);
  });

  it("a valid configuration is just the address + the existing Robinhood chain: no decimals, no treasury, no key", () => {
    const r = resolveTokenConfig(env());
    expect(r).toEqual({ configured: true, adapter: "rpc", tokenAddress: TOKEN, publicAddress: TOKEN, chainId: 4663, rpcUrl: "https://rpc.example.org/", treasuryAddress: null, explorerTxUrl: null });
    expect(Object.keys(r)).not.toContain("decimals");
  });

  it("CLANKRPG_TOKEN_DECIMALS is RETIRED: setting it (any value) changes nothing — the contract decides", () => {
    for (const v of ["6", "18", "abc", "99", ""]) expect(resolveTokenConfig(env({ CLANKRPG_TOKEN_DECIMALS: v }))).toEqual(resolveTokenConfig(env()));
    expect(retiredEnvPresent({ CLANKRPG_TOKEN_DECIMALS: "18" } as unknown as NodeJS.ProcessEnv).map((r) => r.name)).toEqual(["CLANKRPG_TOKEN_DECIMALS"]);
  });

  it("the Robinhood defaults apply when the chain variables are unset (one chain config, no duplicate)", () => {
    const r = resolveTokenConfig(env({ ROBINHOOD_RPC_URL: undefined, ROBINHOOD_CHAIN_ID: undefined }));
    expect(r).toMatchObject({ configured: true, chainId: 4663, rpcUrl: "https://rpc.mainnet.chain.robinhood.com/" });
  });

  it("the OLD duplicate chain settings and every signer variable are ignored — they cannot configure anything", () => {
    const r = resolveTokenConfig(env({ CLANKRPG_REWARD_RPC_URL: "https://evil.example", CLANKRPG_REWARD_CHAIN_ID: "1", CLANKRPG_REWARD_TREASURY_PRIVATE_KEY: "0x" + "11".repeat(32), CLANKRPG_REWARD_SENDER: "simulated" }));
    expect(r).toMatchObject({ configured: true, adapter: "rpc", chainId: 4663, rpcUrl: "https://rpc.example.org/" });
    expect(JSON.stringify(r)).not.toContain("evil.example");
    expect(JSON.stringify(r)).not.toContain("1111");
    expect(JSON.stringify(Object.keys(r))).not.toMatch(/key|private|sign/i);
  });

  it("an address that is set but invalid is a MISCONFIGURATION (launched, with a reason) — distinct from 'not launched'", () => {
    for (const bad of ["0x123", "0x0000000000000000000000000000000000000000", "not-an-address"]) {
      const r = resolveTokenConfig(env({ CLANKRPG_TOKEN_ADDRESS: bad }));
      expect(r).toMatchObject({ configured: false, launched: true });
      if (!r.configured) expect(r.reasons).toContain("CLANKRPG_TOKEN_ADDRESS is not a valid address");
    }
    // a malformed ROBINHOOD_RPC_URL is rejected by the existing environment parser itself (loudly, at boot) — the one chain config.
    expect(() => env({ ROBINHOOD_RPC_URL: "not a url" })).toThrow(/ROBINHOOD_RPC_URL/);
  });

  it("the public address is the EXACT configured text (a checksummed address stays checksummed); matching uses the lower-case form", () => {
    const checksummed = "0x52908400098527886E0F7030069857D2E4169EE7";
    const r = resolveTokenConfig(env({ CLANKRPG_TOKEN_ADDRESS: `  ${checksummed}  ` }));
    expect(r).toMatchObject({ configured: true, tokenAddress: TOKEN, publicAddress: checksummed });
  });

  it("RPC must be https (plain http only for localhost)", () => {
    expect(reasons({ ROBINHOOD_RPC_URL: "http://rpc.example.org" })).toContain("ROBINHOOD_RPC_URL must be https (http only for localhost)");
    expect(reasons({ ROBINHOOD_RPC_URL: "http://localhost:8545" })).toBeNull();
    expect(reasons({ ROBINHOOD_RPC_URL: "http://127.0.0.1:8545" })).toBeNull();
  });

  it("the optional reward wallet is READ-ONLY monitoring: it must be a valid address and cannot be the token contract", () => {
    expect(resolveTokenConfig(env({ CLANKRPG_REWARD_TREASURY_ADDRESS: TREASURY }))).toMatchObject({ configured: true, treasuryAddress: TREASURY });
    expect(reasons({ CLANKRPG_REWARD_TREASURY_ADDRESS: "nope" })).toContain("CLANKRPG_REWARD_TREASURY_ADDRESS is not a valid address");
    expect(reasons({ CLANKRPG_REWARD_TREASURY_ADDRESS: TOKEN })).toContain("the treasury cannot be the token contract");
  });

  it("the explorer URL template is optional, https-only and must contain {hash}", () => {
    expect(resolveTokenConfig(env({ CLANKRPG_EXPLORER_TX_URL: "https://explorer.example/tx/{hash}" }))).toMatchObject({ explorerTxUrl: "https://explorer.example/tx/{hash}" });
    expect(resolveTokenConfig(env({ CLANKRPG_EXPLORER_TX_URL: "http://explorer.example/tx/{hash}" }))).toMatchObject({ explorerTxUrl: null });
    expect(resolveTokenConfig(env({ CLANKRPG_EXPLORER_TX_URL: "https://explorer.example/tx/" }))).toMatchObject({ explorerTxUrl: null });
  });

  it("the simulated chain adapter works for dev/tests with clearly-fake defaults (no decimals), and is REFUSED in production", () => {
    const sim = resolveTokenConfig(env({ CLANKRPG_CHAIN_ADAPTER: "simulated" }, {}));
    expect(sim).toMatchObject({ configured: true, adapter: "simulated", tokenAddress: SIMULATED_TOKEN_ADDRESS, chainId: SIMULATED_CHAIN_ID, rpcUrl: null });
    expect(Object.keys(sim)).not.toContain("decimals");
    const prod = resolveTokenConfig(getEnv({ NODE_ENV: "production", CLANKRPG_CHAIN_ADAPTER: "simulated" } as NodeJS.ProcessEnv));
    expect(prod.configured).toBe(false);
    if (!prod.configured) expect(prod.reasons.join(" ")).toMatch(/refused in production/);
    expect(reasons({ CLANKRPG_CHAIN_ADAPTER: "turbo" })).toContain('CLANKRPG_CHAIN_ADAPTER must be "simulated" or unset');
  });

  it("retired variables (a treasury PRIVATE KEY, the old decimals setting) are reported by NAME only — never their value — so an admin can remove them", () => {
    const found = retiredEnvPresent({ CLANKRPG_REWARD_TREASURY_PRIVATE_KEY: "0xabc", CLANKRPG_TOKEN_DECIMALS: "18" } as unknown as NodeJS.ProcessEnv);
    expect(found.map((r) => r.name)).toEqual(["CLANKRPG_REWARD_TREASURY_PRIVATE_KEY", "CLANKRPG_TOKEN_DECIMALS"]);
    expect(JSON.stringify(found)).not.toContain("0xabc");
    expect(retiredEnvPresent({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(retiredEnvPresent({ CLANKRPG_REWARD_TREASURY_PRIVATE_KEY: "  " } as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("the BUY $CLANKRPG link follows the ONE token address setting", () => {
  it("is the plain site link until an address is configured…", () => {
    expect(buyLinkFor(env({}, {}))).toBe("https://clank.trade/");
    expect(buyLinkFor(env({ CLANKRPG_TOKEN_ADDRESS: "" }))).toBe("https://clank.trade/");
  });
  it("…then the exact configured address, with no code change", () => {
    expect(buyLinkFor(env())).toBe(`https://clank.trade/${TOKEN}`);
    expect(buyLinkFor(env({ CLANKRPG_TOKEN_ADDRESS: ` ${TOKEN.toUpperCase().replace("0X", "0x")} ` }))).toBe(`https://clank.trade/${TOKEN.toUpperCase().replace("0X", "0x")}`);
  });
  it("a malformed address never reaches a URL", () => {
    expect(buyLinkFor(env({ CLANKRPG_TOKEN_ADDRESS: "0x123" }))).toBe("https://clank.trade/");
    expect(buyLinkFor(env({ CLANKRPG_TOKEN_ADDRESS: "javascript:alert(1)" }))).toBe("https://clank.trade/");
  });
});
