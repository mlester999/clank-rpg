"use client";

import Link from "next/link";

import { CARD_STATS, formatPower, rarityClassLine, type HeroCardModel } from "@/domain/hero/card";
import { heroPath } from "@/domain/hero/publicId";
import { rarityVisual } from "@/domain/hero/rarityVisuals";

import { HeroArena } from "./HeroArena";
import { HeroName } from "./HeroName";
import { PwrValue, RarityBadge, rarityStyle } from "./rarity";

/**
 * THE hero card. One presentation of one public-safe data model (HeroCardModel) — used by the Admin preview, the public profile and the public
 * directory, and mirrored by the downloadable PNG and the social preview image, which are drawn from the very same model.
 *
 * Rarity is a real strength tier: the card dresses itself from the shared RARITY_VISUALS (frame, glow, badge shape), its hero stands in the rarity's ARENA
 * image (domain/hero/cardBackground.ts) and it shows the hero's actual PWR — one of the largest things on the card. The PWR band (130–149 …) is a game
 * rule, not card copy: it is never printed on a card.
 *
 * Hierarchy: ART (hero in its arena) → NAME → RARITY + CLASS → PWR → STATS.
 */

/** The full card: the hero standing in its rarity's arena, name, rarity + class, a large PWR and the seven stats. */
export function HeroCard({ model, animate = false, className = "", heading = "h2" }: { model: HeroCardModel; animate?: boolean; className?: string; heading?: "h1" | "h2" | "h3" }) {
  const v = rarityVisual(model.rarity);
  const Heading = heading;
  return (
    <div className={`rarity-glow mx-auto w-full max-w-[440px] ${className}`} style={rarityStyle(model.rarity)}>
      <article
        className="plate relative w-full p-3 sm:p-4"
        style={{
          ["--chamfer" as string]: "16px",
          ["--plate-edge" as string]: `linear-gradient(180deg, ${v.colors.base} 0%, ${v.colors.dark} 60%, #3a2270 100%)`,
          ["--plate-bg" as string]: `linear-gradient(180deg, ${v.surface.from} 0%, #120c24 55%, ${v.surface.to} 100%)`,
        }}
        data-testid="hero-card"
        data-rarity={model.rarity}
        data-class={model.classId}
        data-tier={v.tier}
        aria-label={`${model.name} — ${rarityClassLine(model)}, PWR ${formatPower(model.power)}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-[0.62rem] tracking-[0.22em] text-clank-300 uppercase">Clank RPG</span>
          <span className="font-display text-[0.62rem] tracking-[0.18em] text-steel-300 uppercase">Hero card</span>
        </div>

        <HeroArena look={model.look} animate={animate} label={`${model.name}, ${rarityClassLine(model)}`} className="mt-3" />

        <div className="mt-3">
          <HeroName name={model.name} as={Heading} max="1.5rem" min="0.85rem" wrapCap="1.35rem" align="center" testId="hero-card-name" />
        </div>
        <p className="mt-1.5 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1" data-testid="hero-card-class">
          <RarityBadge rarity={model.rarity} size="md" />
          <span className="font-display text-sm tracking-[0.16em] uppercase" style={{ color: v.colors.light }}>{model.className}</span>
          {model.seasonRank ? <span className="text-sm text-steel-300">· {model.seasonRank}</span> : null}
        </p>

        <div className="mt-3 flex flex-col items-center" data-testid="hero-card-power">
          <PwrValue power={model.power} rarity={model.rarity} size="xl" />
        </div>

        <dl className="mt-4 grid grid-cols-4 gap-1 min-[400px]:grid-cols-7" data-testid="hero-card-stats">
          {CARD_STATS.map(({ key, label }) => (
            <div key={key} className="min-w-0 rounded bg-white/[0.05] px-0.5 py-1.5 text-center">
              <dt className="text-[0.56rem] font-bold tracking-wide text-clank-300 uppercase sm:text-[0.62rem]">{label}</dt>
              <dd className="font-display text-sm text-paper tnum sm:text-base" data-stat={key}>{Math.round(model.stats[key])}</dd>
            </div>
          ))}
        </dl>
      </article>
    </div>
  );
}

/** A directory tile: the hero in its rarity's arena, name, rarity badge + class, a large PWR — and a link to the hero's public profile. */
export function HeroCardCompact({ model, href = heroPath(model.publicId) }: { model: Pick<HeroCardModel, "publicId" | "name" | "className" | "rarity" | "power" | "look">; href?: string }) {
  const v = rarityVisual(model.rarity);
  return (
    <div className="rarity-glow" style={rarityStyle(model.rarity)}>
      <Link
        href={href}
        className="plate group flex min-w-0 flex-col items-center gap-1.5 p-3 text-center transition-transform hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-clank-300"
        style={{
          ["--chamfer" as string]: "12px",
          ["--plate-edge" as string]: `linear-gradient(180deg, ${v.colors.base} 0%, ${v.colors.dark} 100%)`,
          ["--plate-bg" as string]: `linear-gradient(180deg, ${v.surface.from} 0%, ${v.surface.to} 100%)`,
        }}
        data-testid="hero-tile"
        data-rarity={model.rarity}
        data-tier={v.tier}
        aria-label={`${model.name} — ${rarityClassLine(model)}, PWR ${formatPower(model.power)}`}
      >
        <HeroArena look={model.look} label="" heroScale={1.4} className="w-full max-w-[188px]" />
        <span className="block w-full truncate font-display text-sm text-paper" title={model.name}>{model.name}</span>
        <span className="flex max-w-full items-center justify-center gap-1.5 text-[0.7rem]">
          <RarityBadge rarity={model.rarity} size="xs" />
          <span className="truncate text-steel-300">{model.className}</span>
        </span>
        <PwrValue power={model.power} rarity={model.rarity} size="md" />
      </Link>
    </div>
  );
}
