"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ChevronDownIcon, TelegramIcon } from "@/components/ui/Icons";

/**
 * THE NAVBAR'S ACCOUNT AREA — three states that can never be mistaken for one another:
 *
 *   `undefined`  still asking the server who the visitor is → a blank pill. NOT the account button, NOT a sign-in prompt: nothing is implied yet.
 *   `null`       anonymous (no valid session) → a "Sign in with Telegram" call to action. No avatar, no name, no account menu.
 *   a viewer     signed in → an avatar + name menu: Your character · Inventory · Sign out.
 *
 * Presentation only (`AccountControlView`, rendered to markup in tests); `AccountControl` adds the open/close behaviour.
 */
export interface AccountViewer {
  displayName: string;
  characterId: string | null;
  claimed: boolean;
}
/** undefined = loading · null = signed out · object = signed in */
export type AccountState = AccountViewer | null | undefined;

/**
 * What the server's answer (or the lack of one) means for the control. A real answer is the truth — a viewer object is signed in, anything else is signed out.
 * No answer (timeout, network error, an error status) never INVENTS "signed in": an unknown state becomes the sign-in call to action, and a state we already
 * knew is kept, so one failed refresh does not flip a signed-in member's navbar.
 */
export function resolveAccount(previous: AccountState, answer: { viewer?: AccountViewer | null } | null): AccountState {
  if (answer) return answer.viewer ?? null;
  return previous === undefined ? null : previous;
}

export const initialOf = (name: string): string => {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
};

/** What the signed-in button is called: the member's Telegram name, else a neutral word that does not pretend to know more. */
export const accountLabel = (viewer: AccountViewer): string => viewer.displayName.trim() || (viewer.characterId ? "Your hero" : "Your account");

interface ViewProps {
  viewer: AccountState;
  open?: boolean;
  onToggle?: () => void;
  onClose?: () => void;
  onSignOut?: () => void;
}

const ITEM = "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-semibold text-paper hover:bg-white/5 focus-visible:bg-white/10";

export function AccountControlView({ viewer, open = false, onToggle, onClose, onSignOut }: ViewProps) {
  if (viewer === undefined) {
    return <span role="status" aria-label="Checking sign-in" data-testid="auth-loading" data-auth="loading" className="inline-block h-[2.1rem] w-[6.5rem] animate-pulse rounded-lg bg-white/5 min-[560px]:w-[13.5rem] lg:w-[6.5rem] xl:w-[13.5rem]" />;
  }
  if (viewer === null) {
    return (
      <Link href="/character" className="btn btn-teal btn-sm shrink-0 px-2.5 whitespace-nowrap min-[400px]:px-3.5" aria-label="Sign in with Telegram" data-testid="signin-telegram" data-auth="signed-out">
        <TelegramIcon size={16} />
        {/* The full words wherever they fit (≥ 560 px below the desktop navigation, and from 1280 px up); the short form on phones narrower than 560 px and in the 1024–1279 px band, where the
            desktop navigation leaves no room — the Telegram mark and the accessible name keep it unmistakable. */}
        <span className="min-[560px]:hidden lg:inline xl:hidden">Sign in</span>
        <span className="hidden min-[560px]:inline lg:hidden xl:inline">Sign in with Telegram</span>
      </Link>
    );
  }
  const name = accountLabel(viewer);
  return (
    <div className="relative min-w-0" data-testid="account-menu" data-auth="signed-in">
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="account-menu-list"
        aria-label={`Account menu — ${name}`}
        className="btn btn-ghost btn-sm min-w-0 gap-2 px-2 min-[480px]:px-2.5"
        data-testid="account-button"
      >
        <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-clank-500 font-display text-[0.7rem] text-ink-900">{initialOf(name)}</span>
        <span className="hidden max-w-[9rem] truncate min-[480px]:inline">{name}</span>
        <ChevronDownIcon size={14} className={`hidden shrink-0 transition-transform min-[480px]:block ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div id="account-menu-list" role="menu" aria-label="Account" className="plate plate-flat absolute top-full right-0 z-50 mt-2 w-56 p-1.5" data-testid="account-menu-list">
          <p className="truncate px-3 pt-1.5 pb-1 text-[0.68rem] text-steel-400">Signed in as <b className="text-steel-300">{name}</b></p>
          <Link href="/character" role="menuitem" className={ITEM} onClick={onClose}>
            {viewer.characterId ? "Your hero" : "Your character"}
          </Link>
          <Link href="/inventory" role="menuitem" className={ITEM} onClick={onClose}>
            Inventory
          </Link>
          <button type="button" role="menuitem" className={`${ITEM} border-t border-white/5 text-steel-300`} onClick={onSignOut} data-testid="sign-out">
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** The interactive wrapper: the menu belongs to the page it was opened on (so navigating closes it), and closes on Escape or an outside click. */
export function AccountControl({ viewer, pathKey, onSignOut }: { viewer: AccountState; pathKey: string; onSignOut: () => void | Promise<void> }) {
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = viewer !== null && viewer !== undefined && openAt === pathKey;
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpenAt(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpenAt(null);
      root.current?.querySelector<HTMLButtonElement>("[data-testid=account-button]")?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="min-w-0">
      <AccountControlView
        viewer={viewer}
        open={open}
        onToggle={() => setOpenAt((v) => (v === pathKey ? null : pathKey))}
        onClose={() => setOpenAt(null)}
        onSignOut={() => {
          setOpenAt(null);
          void onSignOut();
        }}
      />
    </div>
  );
}
