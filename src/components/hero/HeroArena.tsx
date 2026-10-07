"use client";

import { useEffect, useRef, useState } from "react";

import type { Rarity } from "@/domain/character/appearance";
import { HERO_ARENA, heroArenaLayout } from "@/domain/hero/cardBackground";

import type { HeroLook } from "./drawHero";
import { HeroPortrait } from "./HeroPortrait";
import { RarityFrame } from "./rarity";

/** The width assumed before the browser has measured the frame (server render / first paint). */
export const ARENA_DEFAULT_WIDTH = 400;

/**
 * THE HERO'S ART AREA on a card: the rarity's arena image (behind) with a small hero standing in it.
 *
 *   arena image (RarityFrame `arena`, "cover") → contact shadow → hero sprite (transparent canvas) → [the card's own text stays OUTSIDE the frame]
 *
 * The frame is square like the images. The hero is sized and placed by `heroArenaLayout` (domain/hero/cardBackground.ts) — the same maths the
 * server-rendered PNG uses — so it is a small, centred, full-body figure with its feet on the arena floor, never touching the edge. The canvas is
 * redrawn at the frame's real size (not scaled by CSS), so the pixel art stays crisp at every card width. Pass `width` for a fixed-size frame.
 */
export function HeroArena({ look, label, animate = false, width, heroScale = 1, className = "" }: { look: HeroLook; label: string; animate?: boolean; width?: number; heroScale?: number; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(ARENA_DEFAULT_WIDTH);

  useEffect(() => {
    if (width !== undefined) return;
    const el = box.current;
    if (!el) return;
    const update = () => setMeasured(Math.max(1, Math.round(el.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);

  const w = width ?? measured;
  const h = Math.round(w / HERO_ARENA.aspect);
  const { hero } = heroArenaLayout({ w, h }, { heroScale });
  const size = Math.max(48, Math.round(hero.canvas));
  const shadowW = Math.round(hero.height * 0.95);
  const shadowH = Math.max(6, Math.round(hero.height * 0.16));

  return (
    <div ref={box} className={className} style={width !== undefined ? { width } : undefined} data-testid="hero-arena">
      <RarityFrame rarity={look.rarity as Rarity} arena className="relative w-full" style={{ aspectRatio: String(HERO_ARENA.aspect) }}>
        {/* the contact shadow, centred on the hero's feet */}
        <span
          aria-hidden
          data-arena-shadow
          style={{ position: "absolute", left: Math.round(hero.feetX - shadowW / 2), top: Math.round(hero.feetY - shadowH * 0.55), width: shadowW, height: shadowH, background: "radial-gradient(ellipse at center, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.28) 45%, rgba(0,0,0,0) 72%)", pointerEvents: "none" }}
        />
        <div data-arena-hero style={{ position: "absolute", left: Math.round(hero.canvasX), top: Math.round(hero.canvasY), width: size, height: size }}>
          <HeroPortrait look={look} size={size} frame="full" animate={animate} transparent label={label} className="relative" />
        </div>
      </RarityFrame>
    </div>
  );
}
