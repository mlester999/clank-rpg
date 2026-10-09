"use client";

import Link from "next/link";
import { useId, useRef, useState, type ReactNode } from "react";

import { HeroArena } from "@/components/hero/HeroArena";
import { HeroAvatar } from "@/components/hero/HeroAvatar";
import { HeroName } from "@/components/hero/HeroName";
import type { HeroLook } from "@/components/hero/drawHero";
import { PwrValue, RarityPlaque } from "@/components/hero/rarity";
import { CheckIcon, ClassIcon, DownloadIcon, EyeIcon, LinkIcon, LockIcon, ShareIcon, TelegramIcon, UnlockIcon, UserCheckIcon, UserIcon } from "@/components/ui/Icons";
import { arenaNotice, ownershipCopy, type OwnershipCopy } from "@/content/heroOwnership";
import type { Rarity } from "@/domain/character/appearance";
import { xIntentUrl } from "@/domain/hero/card";
import { heroCardImagePath, heroPath, heroUrl } from "@/domain/hero/publicId";
import { rarityVisual } from "@/domain/hero/rarityVisuals";
import type { OwnershipKind, SelfHeroStatus } from "@/domain/heroOwnership";
import { lighten } from "@/domain/util/color";
import { copyText } from "@/lib/clipboard";
import type { CharacterDto, ClassVisual } from "@/lib/dto";

/**
 * THE LEFT COLUMN OF A HERO PROFILE — two intentional panels instead of a stack of loose cards:
 *
 *   IDENTITY   the arena art, the hero's name (the dominant text), rarity, class, who owns the hero, the class tagline and the actions.
 *   STANDING   COMBAT (PWR — one of the strongest elements on the page) and PROGRESSION (the season rank).
 *
 * Rarity, class and ownership each have their own visual language so they can't be mistaken for one another:
 *   · RARITY    a chamfered, collectible plaque in the tier's colour with the tier's icon shape (Common is a quiet steel plate);
 *   · CLASS     a dark tile with a class glyph (a sword, staff, dagger, bow, shield or holy cross) tinted with the class colour;
 *   · OWNERSHIP an account status block with its own icon (claimed ✓, unclaimed open padlock, found ⇢ claim) and, where it applies, a call to action.
 * Layout only — nothing here computes PWR, rarity, class or rank; they arrive finished from the server.
 */

type SeasonInfo = CharacterDto["season"];

export interface IdentityPanelProps {
  hero: Pick<CharacterDto, "name" | "title" | "publicId" | "avatarUrl" | "classId" | "power" | "appearance">;
  classVisual: ClassVisual | null;
  look: HeroLook;
  ownership: OwnershipKind;
  /** The hero's own status — only ever passed for the signed-in member's own hero. */
  selfStatus?: SelfHeroStatus | null | undefined;
  /** Shown under the ownership block (claim result, errors). */
  note?: string | null;
  onClaim?: () => void | Promise<void>;
  /** Set only for the signed-in owner: the small-screen Sign out button. */
  onSignOut?: () => void | Promise<void>;
  /** Site origin for the canonical share link; defaults to this page's origin. */
  origin?: string | undefined;
  /** Render the arena as a still (tests / reduced work). */
  animate?: boolean;
}

export function HeroIdentityPanel({ hero, classVisual, look, ownership, selfStatus, note, onClaim, onSignOut, origin, animate = true }: IdentityPanelProps) {
  const rarity = hero.appearance.rarity as Rarity;
  const className = classVisual?.name ?? hero.classId;
  return (
    <section className="plate plate-clank rivets p-4 sm:p-5 md:grid md:grid-cols-[minmax(0,17.5rem)_minmax(0,1fr)] md:items-start md:gap-6 lg:block" aria-label="Hero identity" data-testid="hero-identity">
      <HeroArena look={look} animate={animate} label={hero.name} className="mx-auto w-full max-w-[22rem] md:max-w-none lg:mx-0 lg:max-w-none" />
      <div className="mt-4 min-w-0 space-y-3.5 md:mt-0 lg:mt-4">
        {/* The profile photo (the person) sits with the name; the animated hero above is the fighter. No photo → the generated class portrait. */}
        <div className="flex items-center gap-3">
          <HeroAvatar avatarUrl={hero.avatarUrl} look={look} size={52} label={hero.name} className="rounded-xl" />
          <div className="min-w-0 flex-1">
            {hero.title && <p className="truncate text-xs font-semibold tracking-wide text-clank-300 uppercase">{hero.title}</p>}
            <HeroName name={hero.name} testId="hero-name" />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:max-lg:grid-cols-2">
          <RarityPlaque rarity={rarity} />
          <ClassTag classId={hero.classId} name={className} color={classVisual?.colors[0]} />
        </div>

        {classVisual?.tagline && <p className="border-l-2 border-clank-500/60 pl-3 text-xs leading-relaxed text-steel-300 italic" data-testid="hero-tagline">{classVisual.tagline}</p>}

        <OwnershipPanel kind={ownership} selfStatus={selfStatus} note={note} onClaim={onClaim} onSignOut={onSignOut} />

        <HeroActionBar publicId={hero.publicId} model={{ name: hero.name, rarity, className, power: hero.power }} origin={origin} />
      </div>
    </section>
  );
}

/** CLASS — a dark tile with the class glyph in the class colour. Its own shape and weight, nothing like the rarity plaque. */
export function ClassTag({ classId, name, color }: { classId: string; name: string; color?: string | undefined }) {
  const tint = color ?? "#8b97ab";
  return (
    <div className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-md border border-white/12 bg-ink-900/70 py-1.5 pr-3 pl-1.5" data-testid="class-tag" data-class={classId}>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded" style={{ background: `${tint}33`, boxShadow: `inset 0 0 0 1px ${tint}77`, color: lighten(tint, 0.55) }}>
        <ClassIcon classId={classId} size={19} data-class-icon={classId} />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-[0.55rem] font-bold tracking-[0.18em] text-steel-400 uppercase">Class</span>
        <span className="truncate font-display text-sm tracking-wide text-paper">{name}</span>
      </span>
    </div>
  );
}

const TONE: Record<OwnershipCopy["tone"], { box: string; icon: ReactNode; chip: string; label: string }> = {
  claimed: { box: "border-ok/40 bg-ok/10", icon: <UserCheckIcon size={18} />, chip: "bg-ok/20 text-ok", label: "text-ok" },
  unclaimed: { box: "border-dashed border-white/25 bg-white/[0.03]", icon: <UnlockIcon size={18} />, chip: "bg-white/10 text-steel-300", label: "text-paper" },
  action: { box: "border-teal/45 bg-teal/10", icon: <LinkIcon size={18} />, chip: "bg-teal/20 text-teal", label: "text-teal" },
  neutral: { box: "border-white/12 bg-white/[0.03]", icon: <UserIcon size={18} />, chip: "bg-white/10 text-steel-300", label: "text-paper" },
};

/**
 * OWNERSHIP — an account fact, not a trait of the hero. Says whether the hero is claimed, what the visitor can do about it
 * (sign in with Telegram / claim it), and — to the hero's own member only — whether the hero is currently kept out of the Arena.
 */
export function OwnershipPanel({ kind, selfStatus, note, onClaim, onSignOut }: { kind: OwnershipKind; selfStatus?: SelfHeroStatus | null | undefined; note?: string | null | undefined; onClaim?: (() => void | Promise<void>) | undefined; onSignOut?: (() => void | Promise<void>) | undefined }) {
  const notice = arenaNotice(selfStatus);
  const claimBlocked = selfStatus === "SUSPENDED";
  const copy = ownershipCopy(kind, { claimBlocked });
  const tone = TONE[copy.tone];
  return (
    <section className={`rounded-md border p-3 ${tone.box}`} aria-label="Hero ownership" data-testid="ownership-panel" data-ownership={kind}>
      <div className="flex items-start gap-2.5">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded ${tone.chip}`}>{tone.icon}</span>
        <div className="min-w-0">
          <p className={`font-display text-sm tracking-[0.08em] uppercase ${tone.label}`} data-testid="ownership-status">{copy.label}</p>
          <p className="mt-0.5 text-xs leading-snug text-steel-300" data-testid="ownership-body">{copy.body}</p>
        </div>
      </div>
      {copy.cta === "SIGN_IN" && (
        <Link href="/character" className="btn btn-teal mt-3 w-full !px-3 text-[0.74rem]" data-testid="ownership-sign-in">
          <TelegramIcon size={16} />
          Sign in with Telegram
        </Link>
      )}
      {copy.cta === "CLAIM" && onClaim && (
        <button type="button" className="btn btn-teal mt-3 w-full !px-3 text-[0.74rem]" onClick={() => void onClaim()} data-testid="ownership-claim">
          <UserCheckIcon size={16} />
          Claim this hero
        </button>
      )}
      {notice && (
        <div role="note" className="mt-3 flex items-start gap-2.5 rounded-md border border-ember/45 bg-ember/10 p-2.5" data-testid="arena-notice">
          <LockIcon size={16} className="mt-0.5 shrink-0 text-ember" />
          <div className="min-w-0">
            <p className="font-display text-xs tracking-[0.08em] text-ember uppercase">{notice.title}</p>
            <p className="mt-0.5 text-xs leading-snug text-steel-300">{notice.body}</p>
          </div>
        </div>
      )}
      {note && <p role="status" className="mt-3 text-xs text-clank-300" data-testid="ownership-note">{note}</p>}
      {onSignOut && (
        <button type="button" className="btn btn-ghost mt-3 w-full !px-3 text-[0.74rem] sm:hidden" onClick={() => void onSignOut()} data-testid="ownership-sign-out">
          Sign out
        </button>
      )}
    </section>
  );
}

/**
 * VIEW HERO CARD · DOWNLOAD · SHARE.
 *   View      opens this hero's public page (its card, stats and links).
 *   Download  the generated card as a PNG — the server draws the CURRENT card, so it can never be an old image.
 *   Share     opens two options: post on X (a web intent — it cannot attach the image, so the card is downloaded and added by hand) or copy the
 *             canonical link. The browser's native share sheet is NOT used (the profile never used it).
 */
export function HeroActionBar({ publicId, model, origin }: { publicId: string; model: { name: string; rarity: Rarity; className: string; power: number }; origin?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const panel = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const base = origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  const url = heroUrl(base, publicId);

  async function copy() {
    setCopied((await copyText(url)) ? "copied" : "failed");
    window.setTimeout(() => setCopied("idle"), 2500);
  }

  return (
    <div
      className="grid grid-cols-2 gap-2.5"
      data-testid="hero-actions"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        setOpen(false);
        toggle.current?.focus();
      }}
    >
      <Link href={heroPath(publicId)} className="btn col-span-2" data-testid="hero-view-card" aria-label="View hero card — opens this hero's public page">
        <EyeIcon size={18} />
        View hero card
      </Link>
      <a href={`${heroCardImagePath(publicId)}?download=1`} download={`clank-rpg-hero-${publicId}.png`} className="btn btn-ghost px-3" data-testid="hero-download" aria-label="Download hero card as a PNG image">
        <DownloadIcon size={18} />
        Download
      </a>
      <button ref={toggle} type="button" className="btn btn-ghost px-3" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((v) => !v)} data-testid="hero-share">
        <ShareIcon size={18} />
        Share
      </button>
      <div id={panel} hidden={!open} className="col-span-2 grid grid-cols-2 gap-2" data-testid="hero-share-options">
        <a href={xIntentUrl(model, url)} target="_blank" rel="noopener noreferrer" className="btn btn-ghost px-3" data-testid="hero-share-x" aria-label="Post on X (opens in a new tab)">
          Post on X
        </a>
        <button type="button" className="btn btn-ghost px-3" onClick={() => void copy()} data-testid="hero-copy-link">
          {copied === "copied" ? <CheckIcon size={16} /> : <LinkIcon size={16} />}
          Copy link
        </button>
        <p className="col-span-2 text-[0.68rem] leading-snug text-steel-400">X can&apos;t attach the image — download the card, then add it to your post.</p>
      </div>
      <p role="status" className={copied === "idle" ? "sr-only" : "col-span-2 text-xs text-clank-300"} data-testid="hero-copy-status">
        {copied === "copied" ? "Link copied." : copied === "failed" ? "Couldn't copy — select the link and copy it by hand." : ""}
      </p>
    </div>
  );
}

/** The STANDING panel: COMBAT (PWR) and PROGRESSION (season rank) side by side on tablets, stacked in the desktop column. */
export function HeroStandingPanel({ power, rarity, season }: { power: number; rarity: Rarity; season: SeasonInfo }) {
  return (
    <section className="plate plate-clank rivets grid gap-5 p-4 sm:p-5 md:grid-cols-2 md:gap-6 lg:grid-cols-1 lg:gap-5" aria-label="Hero standing" data-testid="hero-standing">
      <CombatPower power={power} rarity={rarity} />
      <RankProgress season={season} />
    </section>
  );
}

/** COMBAT — PWR is one of the biggest numbers on the page; the copy under it is one short line (the long explanation lives in /docs). */
export function CombatPower({ power, rarity }: { power: number; rarity: Rarity }) {
  const v = rarityVisual(rarity);
  return (
    <div className="rounded-md border p-3.5" style={{ borderColor: `${v.colors.dark}`, background: `linear-gradient(180deg, ${v.surface.from}, ${v.surface.to})` }} data-testid="combat-power">
      <p className="label">Combat power</p>
      <PwrValue power={power} rarity={rarity} size="xl" inline className="mt-2" />
      <p className="mt-2 text-xs text-steel-300">An estimate of this hero&apos;s combat strength.</p>
    </div>
  );
}

/** PROGRESSION — the season rank: the rank name and points first, then one progress bar to the next rank. A season rank is status only; it never changes stats or PWR. */
export function RankProgress({ season }: { season: SeasonInfo }) {
  if (!season) {
    return (
      <div data-testid="season-rank">
        <p className="label">Season rank</p>
        <p className="mt-2 text-sm text-steel-300">No season is running yet.</p>
      </div>
    );
  }
  const { rank } = season;
  const ranked = season.ranked;
  const top = ranked && !rank.next;
  const pct = !ranked ? 0 : top ? 100 : Math.round(Math.min(1, Math.max(0, rank.progress)) * 100);
  const caption = !ranked
    ? "Fight your first battle to get ranked."
    : rank.next && rank.pointsToNext !== null
      ? `${rank.pointsToNext.toLocaleString("en-US")} pts to ${rank.next.name}`
      : "Top rank reached.";
  return (
    <div data-testid="season-rank">
      <p className="label">{season.label} rank</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="min-w-0 truncate font-display text-2xl leading-none text-paper" data-testid="season-rank-name">{rank.name}</p>
        <p className="shrink-0 text-right leading-none tnum">
          <span className="font-display text-xl text-clank-200">{season.points.toLocaleString("en-US")}</span>
          <span className="ml-1 text-[0.65rem] font-bold tracking-[0.14em] text-steel-400 uppercase">pts</span>
        </p>
      </div>
      <div
        role="progressbar"
        aria-label={rank.next ? `Progress to ${rank.next.name}` : "Rank progress"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="mt-3 h-2.5 overflow-hidden rounded-sm bg-white/10"
        data-testid="rank-progress"
      >
        <span className="block h-full bg-gradient-to-r from-clank-600 via-clank-400 to-clank-200" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-steel-300 tnum" data-testid="rank-caption">{caption}</p>
    </div>
  );
}
