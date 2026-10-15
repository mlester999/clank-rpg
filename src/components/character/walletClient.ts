import type { PaidRerollPaymentRequest } from "@/domain/hero/paidReroll";
import { api } from "@/lib/api";

/**
 * THE BROWSER WALLET, as the paid reroll uses it: an injected EIP-1193 provider (`window.ethereum` — MetaMask, Rabby, the wallet in a phone's browser, …) is asked to
 *
 *   1. connect an account (`eth_requestAccounts` — the wallet opens),
 *   2. link it to the hero when it is not linked yet (a free signature of a server-issued, single-use message: no gas, no access to funds),
 *   3. be on the right network (`wallet_switchEthereumChain`, adding the chain first if the wallet has never seen it),
 *   4. send the payment (`eth_sendTransaction` — the wallet opens again, showing a plain ERC-20 `transfer`).
 *
 * The provider is injected, so every step is testable with a fake wallet. Nothing here ever sees a key, and nothing in the request is the browser's own: the
 * token, recipient, amount and calldata all come from the server's status (`PaidRerollPaymentRequest`).
 */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
}

export type WalletFailure =
  | "NO_WALLET"
  /** The member closed or declined a wallet prompt. */
  | "REJECTED"
  | "NO_ACCOUNT"
  /** The wallet has a different account selected than the one linked to the hero. */
  | "WRONG_ACCOUNT"
  | "LINK_FAILED"
  | "NETWORK_FAILED"
  | "SEND_FAILED";

export class WalletError extends Error {
  constructor(readonly code: WalletFailure, message: string, readonly detail?: string) {
    super(message);
    this.name = "WalletError";
  }
}

export const WALLET_MESSAGE: Record<WalletFailure, string> = {
  NO_WALLET: "No wallet found in this browser. Open this page in your wallet's browser, or install an EVM wallet such as MetaMask.",
  REJECTED: "The wallet request was cancelled. Nothing was paid.",
  NO_ACCOUNT: "Your wallet didn't share an account. Nothing was paid.",
  WRONG_ACCOUNT: "Select the wallet that is linked to your hero, then try again.",
  LINK_FAILED: "We couldn't link that wallet to your hero. Nothing was paid.",
  NETWORK_FAILED: "Your wallet couldn't switch to the right network. Nothing was paid.",
  SEND_FAILED: "The wallet couldn't send the payment. Nothing was paid.",
};

export const injectedProvider = (): Eip1193 | null => (typeof window === "undefined" ? null : ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null));

/** EIP-1193: 4001 = the user rejected the request; wallets also use ACTION_REJECTED. */
const rejected = (error: unknown): boolean => {
  const e = error as { code?: unknown; name?: unknown };
  return e?.code === 4001 || e?.code === "ACTION_REJECTED" || e?.name === "UserRejectedRequestError";
};
const codeOf = (error: unknown): unknown => (error as { code?: unknown })?.code;

/** Opens the wallet's connect prompt and returns the account it selected (lower-case). */
export async function connectAccount(eth: Eip1193): Promise<string> {
  let accounts: unknown;
  try {
    accounts = await eth.request({ method: "eth_requestAccounts" });
  } catch (error) {
    throw new WalletError(rejected(error) ? "REJECTED" : "NO_ACCOUNT", WALLET_MESSAGE[rejected(error) ? "REJECTED" : "NO_ACCOUNT"]);
  }
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) throw new WalletError("NO_ACCOUNT", WALLET_MESSAGE.NO_ACCOUNT);
  return first.toLowerCase();
}

/** Links `address` to the signed-in hero: the server issues a single-use message, the wallet signs it (free), the server recovers the signer and checks it. */
export async function linkWallet(eth: Eip1193, address: string): Promise<void> {
  const challenge = await api<{ nonce: string; message: string }>("/api/me/wallet/challenge", { method: "POST", json: { address } });
  if (!challenge.ok) throw new WalletError("LINK_FAILED", WALLET_MESSAGE.LINK_FAILED, challenge.error);
  let signature: unknown;
  try {
    signature = await eth.request({ method: "personal_sign", params: [challenge.data.message, address] });
  } catch (error) {
    throw new WalletError(rejected(error) ? "REJECTED" : "LINK_FAILED", WALLET_MESSAGE[rejected(error) ? "REJECTED" : "LINK_FAILED"]);
  }
  const verified = await api("/api/me/wallet/verify", { method: "POST", json: { nonce: challenge.data.nonce, signature } });
  if (!verified.ok) throw new WalletError("LINK_FAILED", verified.error === "ADDRESS_IN_USE" ? "That wallet is already linked to another hero." : WALLET_MESSAGE.LINK_FAILED, verified.error);
}

/** Makes sure the wallet is on the payment's chain: switch, and add the chain first when the wallet has never seen it (error 4902). */
export async function ensureChain(eth: Eip1193, payment: Pick<PaidRerollPaymentRequest, "chainIdHex" | "chainName" | "rpcUrl">): Promise<void> {
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: payment.chainIdHex }] });
    return;
  } catch (error) {
    if (rejected(error)) throw new WalletError("REJECTED", WALLET_MESSAGE.REJECTED);
    if (codeOf(error) !== 4902 && codeOf(error) !== -32603) throw new WalletError("NETWORK_FAILED", WALLET_MESSAGE.NETWORK_FAILED);
  }
  if (!payment.rpcUrl) throw new WalletError("NETWORK_FAILED", WALLET_MESSAGE.NETWORK_FAILED);
  try {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: payment.chainIdHex, chainName: payment.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [payment.rpcUrl] }],
    });
  } catch (error) {
    throw new WalletError(rejected(error) ? "REJECTED" : "NETWORK_FAILED", WALLET_MESSAGE[rejected(error) ? "REJECTED" : "NETWORK_FAILED"]);
  }
}

/** Opens the wallet's transaction prompt for the server's payment (token contract + transfer calldata) and returns the transaction hash. */
export async function sendPayment(eth: Eip1193, from: string, payment: Pick<PaidRerollPaymentRequest, "to" | "data">): Promise<string> {
  let hash: unknown;
  try {
    hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: payment.to, data: payment.data, value: "0x0" }] });
  } catch (error) {
    throw new WalletError(rejected(error) ? "REJECTED" : "SEND_FAILED", WALLET_MESSAGE[rejected(error) ? "REJECTED" : "SEND_FAILED"]);
  }
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new WalletError("SEND_FAILED", WALLET_MESSAGE.SEND_FAILED);
  return hash.toLowerCase();
}
