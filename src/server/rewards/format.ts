/** "0x5290…9ee7" — the only form of a wallet address that appears in shared UI copy. */
export const shortAddress = (a: string | null): string | null => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : null);
