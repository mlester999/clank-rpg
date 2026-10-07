import type { CSSProperties, ReactNode } from "react";

import type { Rarity } from "@/domain/character/appearance";
import { getHeroCardBackground, HERO_ARENA_BACKGROUND_POSITION } from "@/domain/hero/cardBackground";
import { RARITY_RULES } from "@/domain/hero/rarity";
import { rarityCssVars, rarityVisual, type BadgeIcon } from "@/domain/hero/rarityVisuals";

/**
 * The shared rarity UI pieces. Every list, card, profile, panel and leaderboard row that shows a rarity or a PWR uses these — the colours,
 * icon shapes and frame styles all come from RARITY_VISUALS (domain/hero/rarityVisuals.ts), so no component styles a rarity on its own.
 *
 * Rarity is never colour alone: each tier has its own ICON SHAPE (● ◆ ✦ ♛) and always shows its NAME, in addition to its colour.
 */

const ICON_PATH: Record<BadgeIcon, ReactNode> = {
  dot: <circle cx="6" cy="6" r="3.6" />,
  diamond: <path d="M6 0.8 11.2 6 6 11.2 0.8 6Z" />,
  star: <path d="M6 0.6c.5 3 1.3 4.8 5.4 5.4-4.1.6-4.9 2.4-5.4 5.4-.5-3-1.3-4.8-5.4-5.4C4.7 5.4 5.5 3.6 6 .6Z" />,
  crown: <path d="M1 9.6 .8 3.4 3.6 6 6 1.6 8.4 6l2.8-2.6-.2 6.2Z" />,
};

export function RarityIcon({ rarity, size = 12, className = "" }: { rarity: Rarity; size?: number; className?: string }) {
  const icon = rarityVisual(rarity).badge.icon;
  return (
    <svg aria-hidden viewBox="0 0 12 12" width={size} height={size} fill="currentColor" className={`shrink-0 ${className}`} data-rarity-icon={icon}>
      {ICON_PATH[icon]}
    </svg>
  );
}

const BADGE_SIZE = {
  xs: "gap-1 rounded-sm px-1.5 py-px text-[0.56rem] tracking-[0.1em]",
  sm: "gap-1 rounded px-1.5 py-0.5 text-[0.62rem] tracking-[0.12em]",
  md: "gap-1.5 rounded px-2.5 py-1 text-[0.72rem] tracking-[0.14em]",
  lg: "gap-2 rounded-md px-3.5 py-1.5 text-sm tracking-[0.16em]",
} as const;
const ICON_SIZE = { xs: 9, sm: 11, md: 13, lg: 16 } as const;

/** [◆ RARE] — the rarity's icon and name. Common is a quiet outline; the higher tiers are solid. */
export function RarityBadge({ rarity, size = "sm", className = "" }: { rarity: Rarity; size?: keyof typeof BADGE_SIZE; className?: string }) {
  const v = rarityVisual(rarity);
  const solid = v.tier > 0;
  const style: CSSProperties = solid
    ? { background: `linear-gradient(180deg, ${v.colors.light}, ${v.colors.base} 60%)`, color: v.colors.ink, boxShadow: v.tier >= 2 ? `0 0 ${6 + v.tier * 3}px ${v.colors.glow}` : undefined }
    : { background: "rgba(154,164,178,0.14)", color: v.colors.light, boxShadow: `inset 0 0 0 1px ${v.colors.dark}` };
  return (
    <span
      className={`inline-flex shrink-0 items-center font-display uppercase leading-none ${BADGE_SIZE[size]} ${className}`}
      style={style}
      data-testid="rarity-badge"
      data-rarity={rarity}
      title={`${RARITY_RULES[rarity].label} rarity`}
    >
      <RarityIcon rarity={rarity} size={ICON_SIZE[size]} />
      <span>{RARITY_RULES[rarity].label}</span>
    </span>
  );
}

const PLAQUE_CUT = "polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px)";

/**
 * The collectible rarity tag on a hero's profile: a chamfered plaque (the panels' own corner cut), the tier's icon shape, a "RARITY" caption and
 * the tier name. Common is a quiet dark-steel plate; Rare / Epic / Legendary are solid in the tier's colour, with a sheen, and a glow that grows
 * with the tier. Same colours, icons and names as `RarityBadge` — never colour alone.
 */
export function RarityPlaque({ rarity, className = "" }: { rarity: Rarity; className?: string }) {
  const v = rarityVisual(rarity);
  const solid = v.tier > 0;
  const fill = solid ? `linear-gradient(180deg, ${v.colors.light}, ${v.colors.base} 78%, ${v.colors.dark})` : "linear-gradient(180deg, #3b4454, #262d3a)";
  const sheen = solid ? "linear-gradient(115deg, transparent 38%, rgba(255,255,255,0.3) 50%, transparent 62%)" : "none";
  return (
    <span
      className={`inline-flex min-w-0 ${className}`}
      style={{ filter: v.tier >= 2 ? `drop-shadow(0 0 ${4 + v.tier * 3}px ${v.colors.glow})` : undefined }}
      data-testid="rarity-plaque"
      data-rarity={rarity}
      data-tier={v.tier}
      title={`${RARITY_RULES[rarity].label} rarity`}
    >
      <span
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-4 pl-3 uppercase"
        style={{ clipPath: PLAQUE_CUT, backgroundImage: `${sheen}, ${fill}`, color: solid ? v.colors.ink : v.colors.light, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)" }}
      >
        <RarityIcon rarity={rarity} size={20} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="text-[0.55rem] font-bold tracking-[0.18em] opacity-80">Rarity</span>
          <span className="truncate font-display text-sm tracking-[0.1em]">{RARITY_RULES[rarity].label}</span>
        </span>
      </span>
    </span>
  );
}

const PWR_SIZE = {
  xs: { label: "text-[0.5rem]", value: "text-sm" },
  sm: { label: "text-[0.56rem]", value: "text-lg" },
  md: { label: "text-[0.62rem]", value: "text-2xl" },
  lg: { label: "text-xs", value: "text-5xl" },
  xl: { label: "text-sm", value: "text-6xl sm:text-7xl" },
} as const;

/**
 * PWR — one of the biggest numbers wherever a hero is shown. "PWR" caption over a large rarity-tinted number; the number carries a soft
 * glow on the higher tiers. `inline` puts the caption beside the number (list rows).
 */
export function PwrValue({ power, rarity, size = "md", inline = false, className = "" }: { power: number; rarity: Rarity; size?: keyof typeof PWR_SIZE; inline?: boolean; className?: string }) {
  const v = rarityVisual(rarity);
  const s = PWR_SIZE[size];
  return (
    <span className={`inline-flex ${inline ? "items-baseline gap-1.5" : "flex-col items-center leading-none"} ${className}`} data-testid="pwr" aria-label={`Power ${Math.round(power)}`}>
      <span className={`font-display tracking-[0.2em] text-clank-200 uppercase ${s.label}`}>PWR</span>
      <span
        className={`font-display leading-none tnum ${s.value}`}
        style={{ color: v.tier === 0 ? "#e8edf5" : v.colors.light, textShadow: v.tier >= 2 ? `0 0 ${8 + v.tier * 4}px ${v.colors.glow}` : undefined }}
        data-pwr={Math.round(power)}
      >
        {Math.round(power).toLocaleString("en-US")}
      </span>
    </span>
  );
}

/** "+33" / "−18" — a PWR difference with an arrow and a sign (not colour alone). */
export function PwrDelta({ delta, className = "" }: { delta: number; className?: string }) {
  const up = delta > 0;
  const same = delta === 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-display text-lg tnum ${className}`}
      style={{ background: same ? "rgba(139,151,171,0.15)" : up ? "rgba(95,211,141,0.16)" : "rgba(255,77,94,0.16)", color: same ? "#8b97ab" : up ? "#5fd38d" : "#ff7a86" }}
      data-testid="pwr-delta"
      data-direction={same ? "same" : up ? "up" : "down"}
    >
      <span aria-hidden>{same ? "＝" : up ? "▲" : "▼"}</span>
      {same ? "0" : `${up ? "+" : "−"}${Math.abs(delta)}`}
    </span>
  );
}

/** CSS variables for a rarity — spread on any container that uses the `.rarity-*` classes. */
export const rarityStyle = (rarity: Rarity): CSSProperties => rarityCssVars(rarity) as CSSProperties;

/**
 * The framed art area every hero portrait sits in — the rarity's backdrop, frame, pattern and corner ornaments, all read from RARITY_VISUALS.
 * `compact` is the thin variant for small avatars in rows and tables (a lighter frame, no corner ornaments); the SHAPE of each frame still
 * differs per tier, so rarity is never colour alone.
 */
export function RarityFrame({ rarity, children, compact = false, arena = false, className = "", style }: { rarity: Rarity; children?: ReactNode; compact?: boolean; arena?: boolean; className?: string; style?: CSSProperties }) {
  const v = rarityVisual(rarity);
  // `arena`: the rarity's arena image is painted under the hero ("cover": filled and cropped, never stretched). The image is decorative (no alt text). A rarity
  // without an image — or a file that is missing — leaves the neutral rarity backdrop in place: CSS backgrounds have no broken-image state.
  const background = arena ? getHeroCardBackground(rarity) : null;
  return (
    <div
      className={`rarity-art ${v.tier === 3 ? "rarity-shimmer" : ""} ${className}`}
      style={{ ...rarityStyle(rarity), ...style }}
      data-frame={v.frame.style}
      data-tier={v.tier}
      data-rarity={rarity}
      data-compact={compact ? "true" : undefined}
      data-arena={arena ? (background ? "image" : "fallback") : undefined}
      data-testid="rarity-frame"
    >
      <span className="rarity-pattern" aria-hidden />
      {background ? <span className="rarity-arena" aria-hidden data-arena-background={background} style={{ backgroundImage: `url(${background})`, backgroundPosition: HERO_ARENA_BACKGROUND_POSITION }} /> : null}
      {children}
      {compact ? null : <FrameCorners rarity={rarity} />}
    </div>
  );
}

/** Corner ornaments of a framed art area, by the rarity's frame.corners: none · notch · gem · crown. */
export function FrameCorners({ rarity }: { rarity: Rarity }) {
  const v = rarityVisual(rarity);
  const kind = v.frame.corners;
  if (kind === "none") return null;
  const c = v.colors.base;
  const corner = (pos: string, rot: number) => (
    <svg key={pos} aria-hidden viewBox="0 0 16 16" width={kind === "crown" ? 20 : 16} height={kind === "crown" ? 20 : 16} className={`absolute ${pos}`} style={{ transform: `rotate(${rot}deg)` }} fill={c}>
      {kind === "notch" ? <path d="M0 0h10L0 10Z" /> : null}
      {kind === "gem" ? (
        <>
          <path d="M0 0h12L0 12Z" />
          <path d="M5 5.4 7.6 8 5 10.6 2.4 8Z" fill={v.colors.light} stroke={v.colors.dark} strokeWidth=".6" />
        </>
      ) : null}
      {kind === "crown" ? (
        <>
          <path d="M0 0h15L0 15Z" />
          <path d="M3 11.4 2.8 6.4 4.6 8.4 6.4 4.6 8.2 8.4 10 7Z" fill={v.colors.light} stroke={v.colors.dark} strokeWidth=".5" />
        </>
      ) : null}
    </svg>
  );
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 z-10" data-frame-corners={kind}>
      {corner("top-0 left-0", 0)}
      {corner("top-0 right-0", 90)}
      {corner("bottom-0 right-0", 180)}
      {corner("bottom-0 left-0", 270)}
      {kind === "crown" ? (
        <svg viewBox="0 0 24 14" width="38" height="22" className="absolute top-0 left-1/2 -translate-x-1/2" fill={c}>
          <path d="M1 12.4.8 3.4 6 7.4 12 1.2 18 7.4 23.2 3.4 23 12.4Z" stroke={v.colors.dark} strokeWidth=".8" />
          <circle cx="12" cy="6.4" r="1.6" fill={v.colors.light} />
        </svg>
      ) : null}
    </span>
  );
}
