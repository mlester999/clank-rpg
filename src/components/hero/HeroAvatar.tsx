"use client";

import { useState } from "react";

import { HeroPortrait } from "./HeroPortrait";
import type { HeroLook } from "./drawHero";
import { RarityFrame } from "./rarity";
import type { Rarity } from "@/domain/character/appearance";

interface Props {
  /** Profile photo URL (admin override → Telegram photo), or null/undefined when the hero has none. */
  avatarUrl: string | null | undefined;
  /** Used for the generated default portrait, for the rarity frame, and as the alt text. */
  look: HeroLook;
  size?: number;
  label: string;
  className?: string;
  /** Load immediately (the eight fighters on stage) instead of when scrolled near — nothing about the arena may wait for a photo. */
  eager?: boolean;
  /** Draw the rarity frame around the picture (default). Turn off only where an outer frame already exists. */
  framed?: boolean;
}

/**
 * A hero's PROFILE picture — the person, not the fighter (the arena keeps drawing the animated sprite).
 * Square, cropped to fill, in the hero's RARITY FRAME (the compact variant of the one on the hero card: the frame's shape differs per tier,
 * so rarity reads without colour). It can never show a broken image: with no photo, or if the photo fails to load for any reason, it draws
 * the generated class portrait instead. A new URL gets a fresh chance to load.
 */
export function HeroAvatar({ avatarUrl, look, size = 44, label, className = "", eager = false, framed = true }: Props) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const picture =
    avatarUrl && failedUrl !== avatarUrl ? (
      // A plain <img>: same-origin, versioned, immutable URL served by /api/avatars — the image optimiser adds nothing here.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={`${label} — profile photo`}
        width={size}
        height={size}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        draggable={false}
        onError={() => setFailedUrl(avatarUrl)}
        style={{ width: size, height: size }}
        className={`block shrink-0 bg-ink-800 object-cover ${framed ? "" : className}`}
      />
    ) : (
      <HeroPortrait look={look} size={size} label={label} className={framed ? "" : className} />
    );
  if (!framed) return picture;
  return (
    <RarityFrame rarity={look.rarity as Rarity} compact className={`shrink-0 ${className}`} style={{ width: size, height: size }}>
      {picture}
    </RarityFrame>
  );
}
