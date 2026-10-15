"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useTokenConfig } from "@/components/leaderboard/useTokenConfig";
import { ArenaIcon, BagIcon, BookIcon, CalendarIcon, HeroesIcon, MoreIcon, TrophyIcon, UserIcon } from "@/components/ui/Icons";
import { footerNote, stageBadge } from "@/domain/publicPresentation";
import { BUY_LABEL, CLANK_TRADE_URL } from "@/domain/rewards/buyLink";

import { AccountControl, resolveAccount, type AccountViewer } from "./AccountControl";
import { Logo } from "./Logo";
import { usePublicSeason } from "./usePublicSeason";

const PRIMARY = [
  { href: "/", label: "Arena", Icon: ArenaIcon },
  { href: "/character", label: "Character", Icon: UserIcon },
  { href: "/inventory", label: "Inventory", Icon: BagIcon },
  { href: "/leaderboard", label: "Leaderboard", Icon: TrophyIcon },
  { href: "/events", label: "Events", Icon: CalendarIcon },
  { href: "/heroes", label: "Heroes", Icon: HeroesIcon },
  { href: "/docs", label: "Docs", Icon: BookIcon },
] as const;
// The phone bottom bar keeps five equal slots (a sixth would not fit a 320 px label): Events, Heroes and Docs live in "More" there.
const BOTTOM = PRIMARY.filter((p) => p.href !== "/heroes" && p.href !== "/docs" && p.href !== "/events");

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

interface MeResponse {
  viewer: AccountViewer | null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  // undefined = still asking · null = signed out (anonymous) · object = signed in. Only a real answer from the server ever means "signed in".
  const [me, setMe] = useState<MeResponse["viewer"] | undefined>(undefined);
  const router = useRouter();
  // The "More" sheet is tied to the page it was opened on, so navigating closes it without an effect.
  const [moreAt, setMoreAt] = useState<string | null>(null);
  const more = moreAt === path;
  const isAdmin = path.startsWith("/admin");
  // BUY $CLANKRPG: the server decides the link (https://clank.trade/ until the official contract address is configured, then https://clank.trade/<address>);
  // until it answers the plain site link is used, so the button is never dead and never points anywhere invented.
  const buyUrl = useTokenConfig()?.buyUrl ?? CLANK_TRADE_URL;
  // "Pre-season" before the launch, "Season 1" after it — from the persisted game phase, never from the environment.
  const season = usePublicSeason();
  const badge = stageBadge(season);

  useEffect(() => {
    if (isAdmin) return;
    let live = true;
    // A slow or failed answer must never leave the visitor staring at a blank control: after the timeout (or on any error) an UNKNOWN state becomes the
    // sign-in call to action, while a state we already knew is kept (one failed refresh does not sign anybody out of the navbar).
    const refresh = () =>
      fetch("/api/me", { cache: "no-store", signal: AbortSignal.timeout(8_000) })
        .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
        .then((answer) => live && setMe((previous) => resolveAccount(previous, answer)))
        .catch(() => live && setMe((previous) => resolveAccount(previous, null)));
    void refresh();
    window.addEventListener("clank-session", refresh);
    return () => {
      live = false;
      window.removeEventListener("clank-session", refresh);
    };
  }, [path, isAdmin]);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    setMe(null);
    router.push("/");
    router.refresh();
  }

  if (isAdmin) return <>{children}</>;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-950/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center gap-4 px-4 sm:px-6">
          <Link href="/" aria-label="Clank RPG — home" className="shrink-0">
            {/* Below 440 px only the emblem shows, so the BUY button and the sign-in / account control both fit without overlap or sideways scrolling (the name is also in the page title and the aria-label). */}
            <Logo wordmarkClass="hidden min-[440px]:inline" />
          </Link>
          {badge && (
            <span className={`chip hidden uppercase sm:inline-flex lg:hidden 2xl:inline-flex ${badge.tone === "live" ? "border-teal/40 bg-teal/10 text-teal" : "border-clank-500/40 bg-clank-500/10 text-clank-300"}`} data-testid="stage-badge">{badge.text}</span>
          )}

          <nav aria-label="Main" className="ml-2 hidden min-w-0 flex-1 items-center gap-1 lg:flex">
            {PRIMARY.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                aria-current={isActive(path, href) ? "page" : undefined}
                className={`relative rounded-md px-2 py-2 font-display text-[0.72rem] tracking-wider uppercase transition-colors xl:px-3 ${
                  isActive(path, href) ? "text-clank-300" : "text-steel-300 hover:text-paper"
                }`}
              >
                {label}
                {isActive(path, href) && <span className="absolute inset-x-3 -bottom-[13px] h-[3px] rounded-full bg-clank-400 shadow-[0_0_12px_rgba(202,148,249,.8)]" />}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex min-w-0 items-center gap-2 lg:ml-0">
            <a
              href={buyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm shrink-0 px-2.5 text-[0.62rem] tracking-wide whitespace-nowrap min-[400px]:px-3.5 min-[400px]:text-[0.7rem] min-[400px]:tracking-[0.06em]"
              data-testid="buy-clankrpg"
              aria-label={`${BUY_LABEL} (opens Clank.trade in a new tab)`}
            >
              {BUY_LABEL}
            </a>
            <AccountControl viewer={me} pathKey={path} onSignOut={signOut} />
          </div>
        </div>
      </header>

      <main className="flex-1 pb-24 lg:pb-10">{children}</main>

      <footer className="border-t border-white/5 px-4 pt-5 pb-24 text-center text-xs text-steel-400 sm:px-6 lg:pb-5" data-testid="site-footer">
        <nav aria-label="Footer" className="mb-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 font-display text-[0.66rem] tracking-wider uppercase">
          <Link href="/docs" className="text-clank-300 hover:text-clank-200" data-testid="footer-docs">Docs</Link>
          <Link href="/docs/faq" className="text-steel-300 hover:text-paper">FAQ</Link>
          <Link href="/docs/rarity" className="text-steel-300 hover:text-paper">Rarity &amp; power</Link>
          <Link href="/heroes" className="text-steel-300 hover:text-paper">Heroes</Link>
          <Link href="/leaderboard" className="text-steel-300 hover:text-paper">Leaderboard</Link>
          <Link href="/events" className="text-steel-300 hover:text-paper">Events</Link>
        </nav>
        <span data-testid="footer-note">{footerNote(season)}</span>
      </footer>

      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
        <ul className="mx-auto grid max-w-xl grid-cols-5">
          {BOTTOM.map(({ href, label, Icon }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive(path, href) ? "page" : undefined}
                className={`flex h-16 min-w-0 flex-col items-center justify-center gap-1 text-[0.56rem] font-bold tracking-normal uppercase min-[360px]:text-[0.62rem] min-[360px]:tracking-wider ${isActive(path, href) ? "text-clank-300" : "text-steel-400"}`}
              >
                <Icon size={22} />
                {label}
              </Link>
            </li>
          ))}
          <li>
            <button type="button" onClick={() => setMoreAt((v) => (v === path ? null : path))} aria-expanded={more} data-testid="nav-more" className={`flex h-16 w-full min-w-0 flex-col items-center justify-center gap-1 text-[0.56rem] font-bold tracking-normal uppercase min-[360px]:text-[0.62rem] min-[360px]:tracking-wider ${more || isActive(path, "/heroes") || isActive(path, "/events") || isActive(path, "/docs") ? "text-clank-300" : "text-steel-400"}`}>
              <MoreIcon size={22} />
              More
            </button>
          </li>
        </ul>
        {more && (
          <div className="slide-up absolute inset-x-3 bottom-[4.4rem] plate plate-flat p-2">
            <Link href="/events" aria-current={isActive(path, "/events") ? "page" : undefined} className="flex items-center gap-3 rounded-md px-3 py-3 text-sm font-semibold text-paper active:bg-white/5" data-testid="nav-events-mobile">
              <CalendarIcon size={16} className="text-clank-300" />
              Events
              <span className="chip ml-auto">Champions</span>
            </Link>
            <Link href="/heroes" aria-current={isActive(path, "/heroes") ? "page" : undefined} className="flex items-center gap-3 rounded-md px-3 py-3 text-sm font-semibold text-paper active:bg-white/5" data-testid="nav-heroes-mobile">
              <HeroesIcon size={16} className="text-clank-300" />
              Heroes
              <span className="chip ml-auto">Browse</span>
            </Link>
            <Link href="/docs" aria-current={isActive(path, "/docs") ? "page" : undefined} className="flex items-center gap-3 rounded-md px-3 py-3 text-sm font-semibold text-paper active:bg-white/5" data-testid="nav-docs-mobile">
              <BookIcon size={16} className="text-clank-300" />
              Docs
              <span className="chip ml-auto">Read</span>
            </Link>
          </div>
        )}
      </nav>
    </div>
  );
}
