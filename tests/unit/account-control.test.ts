import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountControlView, accountLabel, initialOf, resolveAccount, type AccountViewer } from "@/components/nav/AccountControl";
import { SignInPanel } from "@/components/character/SignInPanel";

/**
 * THE NAVBAR'S AUTH CONTROL. Production showed a generic user icon to a visitor who was not signed in; clicking it went to /character. The control now has
 * three states that cannot be mistaken for one another — loading, signed out (a "Sign in with Telegram" call to action) and signed in (avatar menu).
 */
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const USER_ICON = '<circle cx="12" cy="8" r="4"'; // the generic account glyph (UserIcon)
const render = (viewer: AccountViewer | null | undefined, over: { open?: boolean } = {}) => renderToStaticMarkup(createElement(AccountControlView, { viewer, ...over }));
const player = (over: Partial<AccountViewer> = {}): AccountViewer => ({ displayName: "Mira", characterId: "hero-1", claimed: true, ...over });

describe("signed out (anonymous visitor)", () => {
  const html = render(null);

  it("shows a clear SIGN IN WITH TELEGRAM call to action that leads into the login flow", () => {
    expect(html).toContain('aria-label="Sign in with Telegram"');
    expect(html).toContain('data-testid="signin-telegram"');
    expect(html).toContain('href="/character"'); // the page that holds the Telegram login widget
    expect(text(html)).toContain("Sign in with Telegram");
    expect(text(html)).toContain("Sign in"); // the short form for narrow phones is there too
    expect(html).toContain('data-auth="signed-out"');
  });

  it("does not look or behave like an account: no avatar, no name, no menu, no sign-out, no generic user icon", () => {
    expect(html).not.toContain(USER_ICON);
    expect(html).not.toContain("account-menu");
    expect(html).not.toContain("aria-haspopup");
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("Your hero");
    expect(html).not.toContain("Your character");
    expect(html).not.toContain("Inventory");
  });
});

describe("loading (the server has not answered yet)", () => {
  const html = render(undefined);

  it("is a blank placeholder: not the account button, not a sign-in prompt, nothing implied", () => {
    expect(html).toContain('data-testid="auth-loading"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
    expect(html).not.toContain(USER_ICON);
    expect(text(html)).toBe("");
  });
});

describe("signed in", () => {
  it("shows the avatar + name menu button, and no sign-in call to action", () => {
    const html = render(player());
    expect(html).toContain('data-auth="signed-in"');
    expect(html).toContain('data-testid="account-button"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Account menu — Mira"');
    expect(text(html)).toContain("Mira");
    expect(html).toContain(">M<"); // the avatar initial
    expect(html).not.toContain("signin-telegram");
    expect(html).not.toContain('aria-label="Sign in with Telegram"');
    expect(html).not.toContain('role="menu"'); // closed
  });

  it("the open menu offers Your hero · Inventory · Sign out — Characters/Profile navigation works", () => {
    const html = render(player(), { open: true });
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/role="menuitem"[^>]*href="\/character"[^>]*>Your hero</);
    expect(html).toMatch(/role="menuitem"[^>]*href="\/inventory"[^>]*>Inventory</);
    expect(html).toContain('data-testid="sign-out"');
    expect(text(html)).toContain("Signed in as Mira");
  });

  it("a member without a hero yet still gets the account menu, with a neutral label for the character page", () => {
    const html = render(player({ characterId: null, claimed: false, displayName: "" }), { open: true });
    expect(html).toContain('aria-label="Account menu — Your account"');
    expect(html).toMatch(/role="menuitem"[^>]*href="\/character"[^>]*>Your character</);
  });

  it("names and initials: Telegram display names with emoji, spaces or nothing at all", () => {
    expect(initialOf("  mira ")).toBe("M");
    expect(initialOf("🔱 KMS 🪬")).toBe("🔱");
    expect(initialOf("")).toBe("?");
    expect(accountLabel(player({ displayName: "  " }))).toBe("Your hero");
    expect(accountLabel(player({ displayName: "", characterId: null }))).toBe("Your account");
  });
});

describe("the sign-in page panel (where the call to action leads)", () => {
  const panel = (telegramBot: string | null) => renderToStaticMarkup(createElement(SignInPanel, { login: { telegramBot, devLogin: false }, onSignedIn: () => undefined }));

  it("with the Telegram bot configured it renders the Telegram login widget container under a 'Sign in with Telegram' heading", () => {
    const html = panel("ClankRpgBot");
    expect(text(html)).toContain("Sign in with Telegram");
    expect(html).toContain('data-testid="telegram-login-widget"');
    expect(text(html)).toContain("You are not signed in yet");
    expect(text(html)).not.toContain("isn't available");
  });

  it("without it, it says plainly that sign-in is not available yet (no widget, no pretence) — and never shows a dev login", () => {
    const html = panel(null);
    expect(html).not.toContain("telegram-login-widget");
    expect(text(html)).toContain("Sign in with Telegram isn't available on this site yet");
    expect(text(html)).not.toContain("Local preview only");
  });
});

describe("what an answer — or no answer — from /api/me means", () => {
  it("a real answer is the truth: a viewer is signed in, `viewer: null` (or no viewer) is signed out", () => {
    expect(resolveAccount(undefined, { viewer: player() })).toEqual(player());
    expect(resolveAccount(undefined, { viewer: null })).toBeNull();
    expect(resolveAccount(player(), { viewer: null })).toBeNull(); // signed out elsewhere / session expired
    expect(resolveAccount(player(), {})).toBeNull();
  });

  it("no answer (timeout, network error, error status) never invents 'signed in': unknown → the sign-in call to action; a known state is kept", () => {
    expect(resolveAccount(undefined, null)).toBeNull();
    expect(resolveAccount(null, null)).toBeNull();
    expect(resolveAccount(player(), null)).toEqual(player());
  });
});
