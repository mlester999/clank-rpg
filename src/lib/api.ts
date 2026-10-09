"use client";

/** Thin fetch helpers: JSON in/out, same-origin, with a stable error shape (never raw server text). */
export interface ApiOk<T> {
  ok: true;
  data: T;
}
export interface ApiErr {
  ok: false;
  error: string;
  status: number;
  /** The full error body (e.g. `confirmations` / `required` on a deposit that is still confirming). */
  detail?: Record<string, unknown>;
}

/**
 * A request never waits forever: a hung connection must end in an error state with a Retry button, never in a skeleton that is never replaced. (The server
 * itself gives up on the database after ~20 s per statement, so a healthy-but-degraded answer — a 503 — normally arrives first.)
 */
const API_TIMEOUT_MS = 25_000;

export async function api<T = Record<string, unknown>>(path: string, init?: { method?: string; json?: unknown; timeoutMs?: number }): Promise<ApiOk<T> | ApiErr> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? API_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      signal: controller.signal,
      method: init?.method ?? "GET",
      headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
      cache: "no-store",
      credentials: "same-origin",
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
    if (!res.ok || body.ok === false) return { ok: false, error: body.error ?? "REQUEST_FAILED", status: res.status, detail: body as Record<string, unknown> };
    // Anything that can change who you are (or what you own) tells the shell to refresh.
    if (init?.method && init.method !== "GET" && /^\/api\/(auth|me\/claim)/.test(path)) window.dispatchEvent(new Event("clank-session"));
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, error: controller.signal.aborted ? "TIMEOUT" : "NETWORK", status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Please sign in with Telegram first.",
  NOT_CLAIMED: "Claim your hero first.",
  NO_HERO: "You don't have a hero yet — keep chatting in the official Clank.trade Telegram!",
  RATE_LIMITED: "Slow down a moment and try again.",
  NETWORK: "Can't reach the server. Check your connection.",
  TIMEOUT: "The server is taking too long to answer. Please try again in a moment.",
  DB_UNAVAILABLE: "This is temporarily unavailable. Please try again in a moment.",
  ARENA_UNAVAILABLE: "The Arena is temporarily unavailable. Please try again in a moment.",
  REPLAY_UNAVAILABLE: "The replay is temporarily unavailable. Please try again in a moment.",
  CLASS_RESTRICTED: "That item is for a different class.",
  BAD_SIGNATURE: "That signature didn't match the wallet. Try again.",
  EXPIRED: "That request timed out. Start again.",
  ADDRESS_IN_USE: "That wallet is already linked to another hero.",
  BAD_ADDRESS: "That doesn't look like a valid wallet address.",
  LOGIN_REJECTED: "Telegram sign-in couldn't be verified. Please try again.",
  LOGIN_REPLAYED: "That sign-in was already used. Please try again.",
  LOGIN_UNAVAILABLE: "Sign in with Telegram isn't available on this site yet.",
  CLAIMS_PAUSED: "Claiming is paused for a moment.",
  CLAIMED_BY_OTHER: "This hero was already claimed.",
  SUSPENDED: "This hero is currently suspended.",
  UNAUTHORIZED: "Your admin session has expired — sign in again.",
  BAD_ORIGIN: "That request didn't come from this site. Reload the page and try again.",
  PAYLOAD_TOO_LARGE: "That image is too large (2 MB max after preparing).",
  PHOTO_EMPTY: "No image was sent.",
  PHOTO_TOO_LARGE: "That image is too large (2 MB max).",
  PHOTO_UNSUPPORTED_TYPE: "Only PNG, JPEG or WebP images are accepted.",
  PHOTO_MIME_MISMATCH: "The file's content doesn't match its type.",
  PHOTO_CORRUPT: "That image is damaged or has extra data after it.",
  PHOTO_ANIMATED: "Animated images aren't accepted — use a still image.",
  PHOTO_TOO_SMALL: "The image must be at least 64×64 pixels.",
  PHOTO_DIMENSIONS_TOO_LARGE: "The image can be at most 4096×4096 pixels.",
  FREE_REROLL_DISABLED: "Free rerolls aren't open yet.",
  FREE_REROLL_UNAVAILABLE: "Free rerolls aren't ready on this server yet.",
  ALREADY_USED_TODAY: "You've already used today's free reroll.",
  HERO_IN_ARENA: "Your hero is lined up for a live Arena fight. Try again once the upcoming fights have finished — your free reroll is still waiting.",
  HERO_UNAVAILABLE: "Your hero can't be rerolled right now.",
  INVALID_ROLL: "The roll could not be completed. Nothing was used — try again.",
  REQUEST_CONFLICT: "That request was already used. Reload the page and try again.",
  STORAGE_NOT_CONFIGURED: "Photo storage isn't configured on this server yet (see docs/HERO_PROFILE_PHOTOS.md).",
};

export const friendly = (code: string): string => MESSAGES[code] ?? "Something went wrong. Please try again.";

/** True for the failures that mean "the service is having a moment — try again" (as opposed to "you did something wrong"). */
export const isTransient = (code: string): boolean => code === "NETWORK" || code === "TIMEOUT" || code === "DB_UNAVAILABLE" || code === "ARENA_UNAVAILABLE" || code === "REPLAY_UNAVAILABLE";
