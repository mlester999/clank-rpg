import { z } from "zod";

/**
 * Server environment. Parsed lazily so `next build` and unit tests don't need every secret.
 * NOTHING here is exposed to the browser; only NEXT_PUBLIC_* values are, and only those
 * listed in `publicConfig()`.
 */
const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters").optional(),
  ADMIN_ACCESS_KEY: z.string().min(24, "ADMIN_ACCESS_KEY must be at least 24 characters").optional(),
  CRON_SECRET: z.string().min(24).optional(),
  CLASS_ROLL_SECRET: z.string().min(24).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/, "Telegram secret tokens allow only A-Z a-z 0-9 _ -").optional(),
  TELEGRAM_OFFICIAL_CHAT_ID: z.coerce.number().int().optional(),
  TELEGRAM_HASH_PEPPER: z.string().min(16).optional(),
  NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{4,64}$/).optional(),
  ROBINHOOD_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  ROBINHOOD_CHAIN_ID: z.coerce.number().int().default(4663),
  CLANK_TRADE_API_URL: z.string().url().default("https://clank.trade"),
  CLANK_AUTO_APPROVE_BONDED: bool,
  CLANK_ALLOW_DEMO_HEROES: bool,
  CLANK_DEV_LOGIN: bool,
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3700"),
  // Hero profile-photo storage (Supabase Storage, server-side only). Without these, local development writes to disk
  // and production refuses uploads — it never falls back silently.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  SUPABASE_AVATAR_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,62}$/).default("hero-avatars"),
  CLANK_AVATAR_DIR: z.string().min(1).optional(),
  // $CLANKRPG: the ONE official token (public contract address) used for holder verification, for verifying manual payouts and for the
  // BUY $CLANKRPG link. Unset until the token launches — nothing depends on it: the Arena, picks, leaderboards, finalization and reward
  // accounting all run without it (rewards are LOGICAL amounts, see domain/rewards/tokens.ts). Once it is set the backend reads the
  // contract itself (decimals(), symbol(), balanceOf()); there is NO decimals setting — the contract is the only authority.
  // Plain optional string on purpose: a missing or mistyped value makes holder verification / claims stay unavailable (see
  // server/rewards/config.ts, which validates and fails closed) — nothing crashes. The chain itself comes from ROBINHOOD_RPC_URL /
  // ROBINHOOD_CHAIN_ID above. There is NO signing key: payouts are made by hand.
  CLANKRPG_TOKEN_ADDRESS: z.string().optional(),
  /** Optional, read-only: the wallet that pays rewards by hand (reserve monitoring only; the app never signs with it). */
  CLANKRPG_REWARD_TREASURY_ADDRESS: z.string().optional(),
  /** Optional block-explorer transaction URL with a `{hash}` placeholder, e.g. https://explorer.example/tx/{hash} (public). */
  CLANKRPG_EXPLORER_TX_URL: z.string().optional(),
  /** "simulated" = an in-memory chain (balances + transfers) for local development, QA and tests. Refused in production. */
  CLANKRPG_CHAIN_ADAPTER: z.string().optional(),
});

export type ServerEnv = z.infer<typeof schema> & { isProduction: boolean };

let cached: ServerEnv | null = null;

export function getEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  if (source === process.env && cached) return cached;
  // `KEY=` lines (as shipped in .env.example) mean "not set", never "set to an empty string".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env: ServerEnv = { ...parsed.data, isProduction: parsed.data.NODE_ENV === "production" };
  if (source === process.env) cached = env;
  return env;
}

export function resetEnvCache(): void {
  cached = null;
}

/** Development convenience secrets — never usable in production (getSecret throws there). */
const DEV_FALLBACKS: Record<string, string> = {
  SESSION_SECRET: "dev-only-session-secret-do-not-use-in-production-0123456789",
  CLASS_ROLL_SECRET: "dev-only-class-roll-secret-do-not-use-1234567",
  TELEGRAM_HASH_PEPPER: "dev-only-telegram-hash-pepper",
};

export function getSecret(name: "SESSION_SECRET" | "CLASS_ROLL_SECRET" | "TELEGRAM_HASH_PEPPER", env: ServerEnv = getEnv()): string {
  const value = env[name];
  if (value) return value;
  // Development fallbacks exist ONLY for the embedded local database. Anything pointed at a real
  // database (NODE_ENV=production OR a configured DATABASE_URL — e.g. running an import script from
  // a laptop against Supabase) must supply real secrets: class rolls and message hashes derived from a
  // publicly-known fallback would be predictable and permanent.
  if (env.isProduction || env.DATABASE_URL) {
    throw new Error(`${name} must be configured when using a real database (set it in .env.local; see .env.example)`);
  }
  return DEV_FALLBACKS[name] as string;
}

/** Whether the arena may include DEV_SEED demo heroes. Never silently true in production. */
export function demoHeroesAllowed(env: ServerEnv = getEnv()): boolean {
  if (env.CLANK_ALLOW_DEMO_HEROES) return true;
  return !env.isProduction && !env.DATABASE_URL;
}

/** Dev-only login for demo heroes. Hard-disabled in production regardless of env. */
export function devLoginEnabled(env: ServerEnv = getEnv()): boolean {
  return !env.isProduction && Boolean(env.CLANK_DEV_LOGIN);
}
