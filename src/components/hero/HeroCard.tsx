"use client";

import Link from "next/link";

import { CARD_STATS, formatPower, rarityClassLine, type HeroCardModel } from "@/domain/hero/card";
import { heroPath } from "@/domain/hero/publicId";
import { bandLabel, positionInBand, RARITY_RULES } from "@/domain/hero/rarity";
import { rarityVisual } from "@/domain/hero/rarityVisuals";

import { HeroPortrait } from "./HeroPortrait";
import { PwrValue, RarityBadge, RarityFrame, rarityStyle } from "./rarity";

/**
 * THE hero card. One presentation of one public-safe data model (HeroCardModel) — used by the Admin preview, the public profile and the public
 * directory, and mirrored by the downloadable PNG and the social preview image, which are drawn from the very same model.
 *
 * Rarity is a real strength tier: the card dresses itself from the shared RARITY_VISUALS (frame, backdrop, glow, badge shape) and shows the hero's
 * actual PWR — one of the largest things on the card — with where it sits inside its rarity's band.
 *
 * Hierarchy: ART → NAME → RARITY + CLASS → PWR → STATS.
 */

/** The tier meter under PWR: the rarity's name and band, and a bar for where this hero sits inside it (a shape, not just a colour). */
function TierMeter({ model }: { model: Pick<HeroCardModel, "rarity" | "power"> }) {
  const rule = RARITY_RULES[model.rarity];
  const v = rarityVisual(model.rarity);
  const pos = positionInBand(model.rarity, model.power);
  return (
    <div className="mx-auto mt-2 w-full max-w-[260px]" data-testid="hero-card-tier">
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="presentation">
        <div className="h-full rounded-full" style={{ width: `${Math.round((pos ?? 0) * 100)}%`, minWidth: pos === null ? 0 : 6, background: `linear-gradient(90deg, ${v.colors.dark}, ${v.colors.base}, ${v.colors.light})` }} />
      </div>
      <p className="mt-1 text-center text-[0.68rem] tracking-wide text-steel-300">
        {rule.label} tier <span className="tnum">· {bandLabel(model.rarity)}</span>
      </p>
    </div>
  );
}

/** The full card: prominent art, name, rarity + class, a large PWR and the seven stats. */
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

        <RarityFrame rarity={model.rarity} className="mt-3 grid place-items-center" style={{ minHeight: 268 }}>
          <HeroPortrait look={model.look} size={252} frame="full" animate={animate} label={`${model.name}, ${rarityClassLine(model)}`} className="relative" />
        </RarityFrame>

        <Heading className="mt-3 text-center font-display text-xl leading-tight [overflow-wrap:anywhere] text-paper sm:text-2xl" data-testid="hero-card-name">{model.name}</Heading>
        <p className="mt-1.5 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1" data-testid="hero-card-class">
          <RarityBadge rarity={model.rarity} size="md" />
          <span className="font-display text-sm tracking-[0.16em] uppercase" style={{ color: v.colors.light }}>{model.className}</span>
          {model.seasonRank ? <span className="text-sm text-steel-300">· {model.seasonRank}</span> : null}
        </p>

        <div className="mt-3 flex flex-col items-center" data-testid="hero-card-power">
          <PwrValue power={model.power} rarity={model.rarity} size="xl" />
        </div>
        <TierMeter model={model} />

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

/** A directory tile: framed portrait, name, rarity badge + class, a large PWR — and a link to the hero's public profile. */
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
        <RarityFrame rarity={model.rarity} className="grid place-items-center" style={{ width: 132, height: 132 }}>
          <HeroPortrait look={model.look} size={132} frame="full" label="" className="relative" />
        </RarityFrame>
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
