"use client";

import { useEffect, useRef } from "react";

import { spriteKey } from "@/domain/sprites/config";
import { getHeroSheet } from "@/components/sprites/compositor";
import { DEFAULT_SPRITE_SET } from "@/components/sprites/library";
import { useSpriteLibrary } from "@/components/sprites/useSprites";

import { rarityVisual } from "@/domain/hero/rarityVisuals";

import { mix } from "./colors";
import { drawHero, IDLE_POSE, type HeroLook } from "./drawHero";

interface Props {
  look: HeroLook;
  size?: number;
  /** "bust" crops to head & shoulders; "full" shows the whole hero. */
  frame?: "bust" | "full";
  animate?: boolean;
  victory?: boolean;
  className?: string;
  label?: string;
  /** Sprite set to draw from (defaults to the standard set). */
  setId?: string;
  /** Draw only the hero (no rarity backdrop): it stands on whatever is behind the canvas — the card's arena image. */
  transparent?: boolean;
}

/**
 * Draws a hero from the SAME layered spritesheets the arena uses. Until the sprite set is ready
 * (or if it cannot draw this hero) it falls back to the procedural vector hero, so a portrait is
 * never blank. Static portraits draw once; animated ones loop the idle (or victory) clip.
 */
export function HeroPortrait({ look, size = 64, frame = "bust", animate = false, victory = false, className = "", label, setId = DEFAULT_SPRITE_SET, transparent = false }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const lib = useSpriteLibrary(setId);
  const source = lib.source;
  // Depend on the visual identity, not on object identity (parents rebuild `look` on every render).
  const key = spriteKey(look.sprite, look.colors, look.rarity);
  const lookRef = useRef(look);
  useEffect(() => {
    lookRef.current = look;
  });

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const l = lookRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let stopped = false;
    const rv = rarityVisual(l.rarity);
    const sheet = source ? getHeroSheet(source, l.sprite, l.colors, l.rarity) : null;
    const useSprite = Boolean(source && sheet && !sheet.needsFallback);
    // its skeleton's atlas page is loading: the backdrop only (the portrait redraws when the page arrives — `rev`), never the vector hero for a moment
    const waiting = Boolean(useSprite && sheet?.pending);

    const background = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      if (transparent) return;
      const bg = ctx.createRadialGradient(size / 2, size * 0.35, size * 0.05, size / 2, size / 2, size * 0.75);
      bg.addColorStop(0, mix(rv.surface.from, rv.colors.base, 0.22 + rv.tier * 0.05));
      bg.addColorStop(1, rv.surface.to);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, size, size);
    };

    const paintVector = (tSec: number) => {
      background();
      ctx.save();
      if (frame === "bust") {
        const scale = (size * 0.98) / 78;
        ctx.translate(size / 2, size * 0.03 + 104 * scale);
        ctx.scale(scale, scale);
      } else {
        const scale = (size * 0.9) / 108;
        ctx.translate(size / 2, size * 0.96);
        ctx.scale(scale, scale);
      }
      drawHero(ctx, l, { ...IDLE_POSE, t: tSec, victory });
      ctx.restore();
    };

    const paintSprite = (tSec: number) => {
      if (!source || !sheet) return;
      const m = source.manifest;
      const clip = victory && m.clips.victory ? "victory" : sheet.plan.idleClip;
      const def = m.clips[clip]!;
      const strip = sheet.strip(clip, 0);
      if (!strip) return waiting ? background() : paintVector(tSec);
      const f = def.loop ? Math.floor(tSec * def.fps) % def.frames : 0;
      // Source crop in sprite pixels, derived from the manifest (so any frame size / proportion works).
      const n = m.nominalHeightPx;
      const crop =
        frame === "bust"
          ? { w: n * 0.92, h: n * 0.92, x: m.anchor.x - n * 0.42, y: m.anchor.y - n * 1.14 }
          : { w: m.frame.w * 0.9, h: m.frame.h, x: (m.frame.w - m.frame.w * 0.9) / 2, y: 0 };
      // keep the crop square-ish for the canvas aspect
      const scale = (size * dpr) / Math.max(crop.w, crop.h);
      background();
      ctx.save();
      ctx.imageSmoothingEnabled = m.pixelArt === false || scale < 2.2;
      ctx.imageSmoothingQuality = "high";
      const dw = (crop.w / Math.max(crop.w, crop.h)) * size;
      const dh = (crop.h / Math.max(crop.w, crop.h)) * size;
      const aura = frame === "full" ? sheet.aura() : null;
      if (aura && sheet.plan.aura?.def.loop) {
        const loop = sheet.plan.aura.def.loop;
        const af = Math.floor(tSec * loop.fps) % loop.frames;
        ctx.drawImage(aura, af * m.frame.w + crop.x, crop.y, crop.w, crop.h, (size - dw) / 2, size - dh, dw, dh);
      }
      ctx.drawImage(strip, f * m.frame.w + crop.x, crop.y, crop.w, crop.h, (size - dw) / 2, size - dh, dw, dh);
      ctx.restore();
    };

    const paint = useSprite ? paintSprite : paintVector;
    paint(0.4);
    if (animate) {
      const start = performance.now();
      const loop = (now: number) => {
        if (stopped) return;
        paint((now - start) / 1000 + 0.4);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [key, size, frame, animate, victory, source, transparent, lib.rev]);

  return <canvas ref={ref} role="img" aria-label={label ?? "Hero portrait"} style={{ width: size, height: size }} className={`block shrink-0 ${className}`} />;
}
