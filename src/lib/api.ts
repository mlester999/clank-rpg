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

export async function api<T = Record<string, unknown>>(path: string, init?: { method?: string; json?: unknown }): Promise<ApiOk<T> | ApiErr> {
  try {
    const res = await fetch(path, {
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
    return { ok: false, error: "NETWORK", status: 0 };
  }
}

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Please sign in with Telegram first.",
  NOT_CLAIMED: "Claim your hero first.",
  NO_HERO: "You don't have a hero yet — keep chatting in the official Clank.trade Telegram!",
  RATE_LIMITED: "Slow down a moment and try again.",
  NETWORK: "Can't reach the server. Check your connection.",
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
  STORAGE_NOT_CONFIGURED: "Photo storage isn't configured on this server yet (see docs/HERO_PROFILE_PHOTOS.md).",
};

export const friendly = (code: string): string => MESSAGES[code] ?? "Something went wrong. Please try again.";
