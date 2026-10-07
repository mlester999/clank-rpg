import { getAddress, isAddress, recoverMessageAddress } from "viem";

/**
 * Wallet linking uses a server-issued, single-use, expiring challenge signed with
 * personal_sign (EIP-191). The server rebuilds the exact message from its own stored challenge;
 * the browser only supplies the signature. We then recover the signer and require it to equal
 * the address the challenge was issued for. No address is ever trusted from the client.
 *
 * Scope: EOA wallets (ECDSA recovery). Smart-contract wallets (ERC-1271) would need an RPC
 * `isValidSignature` call and are intentionally not claimed as supported here.
 */
export interface WalletChallengeInput {
  heroName: string;
  address: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export function normalizeAddress(input: string): string | null {
  if (!isAddress(input, { strict: false })) return null;
  return getAddress(input.toLowerCase()).toLowerCase();
}

export function buildWalletMessage(i: WalletChallengeInput): string {
  return [
    "Clank RPG — link wallet to your hero",
    "",
    "Signing proves you control this wallet. It costs no gas and gives Clank RPG no access to your funds.",
    "",
    `Hero: ${i.heroName}`,
    `Wallet: ${i.address}`,
    `Chain ID: ${i.chainId}`,
    `Nonce: ${i.nonce}`,
    `Issued: ${i.issuedAt.toISOString()}`,
    `Expires: ${i.expiresAt.toISOString()}`,
  ].join("\n");
}

export async function recoverSigner(message: string, signature: string): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    return (await recoverMessageAddress({ message, signature: signature as `0x${string}` })).toLowerCase();
  } catch {
    return null;
  }
}

export async function verifyWalletSignature(message: string, signature: string, expectedAddress: string): Promise<boolean> {
  const signer = await recoverSigner(message, signature);
  return signer !== null && signer === expectedAddress.toLowerCase();
}
