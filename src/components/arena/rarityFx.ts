import type { Rarity } from "@/domain/character/appearance";
import { rarityVisual, type BadgeIcon } from "@/domain/hero/rarityVisuals";

/**
 * ARENA RARITY EFFECTS — what makes a rarer hero LOOK rarer on the battle stage, with no label: a ground ring (rings, rune ticks), a faint
 * outline, a soft glow and a few rising particles. Every number comes from RARITY_VISUALS[rarity].arena (the one shared table); nothing here
 * is styled per component.
 *
 * VISUAL ONLY. These functions run after, and completely independently of, the deterministic simulation: they read nothing from combat, write
 * nothing to it, and are a pure function of (rarity, slot, clock time). They keep no state and allocate nothing per frame (no arrays, no
 * closures, no gradients with `shadowBlur`), so eight Legendary heroes cost a few hundred cheap canvas calls per frame.
 *
 * Rarity is never colour alone: every tier differs in SHAPE too — Common one thin ring · Rare a ring with a solid outline · Epic two rings with
 * rune ticks, a dashed outline and diamond sparks · Legendary three rings, a double outline and round embers.
 *
 * `reduced` (prefers-reduced-motion): the rings, glow and outline are drawn static and the particles are not drawn at all.
 */

const TAU = Math.PI * 2;
/** Body centre, in hero-local units (feet at the origin, hero ≈ 104 tall). */
const BODY_Y = -50;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Stable pseudo-random in [0, 1) from two small integers (no state, no Math.random — the same hero always shimmers the same way). */
const hash01 = (a: number, b: number): number => {
  let h = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};

/** The effects a rarity has at all (Common has a thin ring and nothing else). */
export const hasRarityFx = (rarity: Rarity | string): boolean => rarityVisual(rarity).tier > 0;

/**
 * UNDER the hero: the ground ring(s) and, for Epic and above, the rune ticks that slowly turn around the outer ring. Drawn with the origin at
 * the hero's feet; `alpha` is the unit's fade (intro / knock-out).
 */
export function drawRarityGround(ctx: CanvasRenderingContext2D, rarity: Rarity | string, now: number, slot: number, alpha: number, reduced: boolean): void {
  const v = rarityVisual(rarity);
  const g = v.arena.ground;
  if (alpha <= 0.01) return;
  const pulse = reduced || v.arena.pulse.amplitude === 0 ? 1 : 1 + v.arena.pulse.amplitude * Math.sin((now / v.arena.pulse.periodMs) * TAU + slot * 0.9);
  ctx.save();
  ctx.strokeStyle = v.colors.base;
  ctx.lineWidth = g.lineWidth;
  for (let i = 0; i < g.rings; i++) {
    const k = 1 + i * 0.24;
    ctx.globalAlpha = alpha * g.alpha * (1 - i * 0.28);
    ctx.beginPath();
    ctx.ellipse(0, -1, g.rx * k * pulse, g.ry * k * pulse, 0, 0, TAU);
    ctx.stroke();
  }
  if (g.ticks > 0) {
    // rune ticks: short radial strokes on the outer ring, turning slowly (static under reduced motion)
    const R = 1 + (g.rings - 1) * 0.24;
    const spin = reduced ? 0 : (now / 7000) * TAU;
    ctx.globalAlpha = alpha * Math.min(1, g.alpha + 0.1);
    ctx.strokeStyle = v.colors.light;
    ctx.lineWidth = g.lineWidth * 0.8;
    ctx.beginPath();
    for (let i = 0; i < g.ticks; i++) {
      const a = spin + (i / g.ticks) * TAU;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const rx = g.rx * R * pulse;
      const ry = g.ry * R * pulse;
      ctx.moveTo(c * rx, -1 + s * ry);
      ctx.lineTo(c * (rx + 3.2), -1 + s * (ry + 1.1));
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * BEHIND the hero: the soft body glow of Rare and above (a radial gradient — no blur filter) and the outline whose SHAPE differs per tier:
 * solid (Rare) · dashed (Epic) · double (Legendary).
 */
export function drawRarityAura(ctx: CanvasRenderingContext2D, rarity: Rarity | string, now: number, slot: number, alpha: number, reduced: boolean): void {
  const v = rarityVisual(rarity);
  if (v.tier === 0 || alpha <= 0.01) return;
  const breathe = reduced ? 1 : 0.88 + 0.12 * Math.sin((now / v.arena.pulse.periodMs) * TAU + slot * 1.3);
  ctx.save();
  const glow = ctx.createRadialGradient(0, BODY_Y, 4, 0, BODY_Y, 30 + v.tier * 9);
  glow.addColorStop(0, v.colors.glow);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = alpha * (0.45 + 0.18 * v.tier) * breathe;
  ctx.fillStyle = glow;
  ctx.fillRect(-48, BODY_Y - 62, 96, 124);

  const o = v.arena.outline;
  if (o.width > 0) {
    ctx.strokeStyle = v.colors.light;
    ctx.lineWidth = o.width;
    ctx.globalAlpha = alpha * o.alpha * breathe;
    if (v.tier === 2) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.ellipse(0, BODY_Y, 31 + v.tier, 56 + v.tier, 0, 0, TAU);
    ctx.stroke();
    if (v.tier === 3) {
      ctx.lineWidth = o.width * 0.6;
      ctx.globalAlpha = alpha * o.alpha * 0.6 * breathe;
      ctx.beginPath();
      ctx.ellipse(0, BODY_Y, 36, 61, 0, 0, TAU);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * IN FRONT of the hero: a handful of particles rising from the ring — Epic: diamond sparks, Legendary: round embers. A pure function of the
 * clock (each particle's position is `((now + phase) mod life) / life`), so nothing is stored. Not drawn under reduced motion.
 */
export function drawRarityParticles(ctx: CanvasRenderingContext2D, rarity: Rarity | string, now: number, slot: number, alpha: number, reduced: boolean): void {
  const v = rarityVisual(rarity);
  const p = v.arena.particles;
  if (p.count === 0 || reduced || alpha <= 0.01) return;
  const life = 1500 + v.tier * 250;
  const rise = (p.riseSpeed * life) / 1000;
  ctx.save();
  ctx.fillStyle = v.tier === 3 ? v.colors.light : v.colors.base;
  for (let i = 0; i < p.count; i++) {
    const t = ((now + hash01(slot, i) * life * 4) % life) / life; // 0 → 1 over the particle's life
    const fade = Math.min(t / 0.15, 1) * (1 - t); // quick fade-in, slow fade-out
    const x = (hash01(slot * 7 + 3, i) * 2 - 1) * (p.kind === "ember" ? 24 : 21) + Math.sin(t * TAU + i) * 2.5;
    const y = -6 - t * rise - hash01(i, slot + 11) * 10;
    const s = p.size * (1 - 0.45 * t);
    ctx.globalAlpha = alpha * p.alpha * clamp01(fade);
    if (p.kind === "spark") {
      ctx.beginPath(); // a small diamond — a different SHAPE from the Legendary embers
      ctx.moveTo(x, y - s * 1.5);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s * 1.5);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, s, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * The tier mark on a name plate (no text): the tier's badge SHAPE — dot · diamond · four-point star · crown — in the rarity colour, centred on
 * (cx, cy) with half-size `r`. Common draws a quiet dot so every plate has the same anatomy.
 */
export function drawRarityMark(ctx: CanvasRenderingContext2D, rarity: Rarity | string, cx: number, cy: number, r: number, ink?: string): void {
  const v = rarityVisual(rarity);
  const icon: BadgeIcon = v.badge.icon;
  ctx.save();
  // `ink` = a solid single-colour mark (for sitting on a rarity-coloured badge); otherwise the mark is rarity-coloured with a light edge.
  ctx.fillStyle = ink ?? (v.tier === 0 ? v.colors.dark : v.colors.base);
  ctx.strokeStyle = v.colors.light;
  ctx.lineWidth = Math.max(0.6, r * 0.18);
  ctx.beginPath();
  switch (icon) {
    case "dot":
      ctx.arc(cx, cy, r * 0.62, 0, TAU);
      break;
    case "diamond":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    case "star":
      ctx.moveTo(cx, cy - r * 1.15);
      ctx.quadraticCurveTo(cx + r * 0.18, cy - r * 0.18, cx + r * 1.15, cy);
      ctx.quadraticCurveTo(cx + r * 0.18, cy + r * 0.18, cx, cy + r * 1.15);
      ctx.quadraticCurveTo(cx - r * 0.18, cy + r * 0.18, cx - r * 1.15, cy);
      ctx.quadraticCurveTo(cx - r * 0.18, cy - r * 0.18, cx, cy - r * 1.15);
      ctx.closePath();
      break;
    case "crown":
      ctx.moveTo(cx - r, cy + r * 0.8);
      ctx.lineTo(cx - r * 1.05, cy - r * 0.55);
      ctx.lineTo(cx - r * 0.45, cy + r * 0.05);
      ctx.lineTo(cx, cy - r * 0.95);
      ctx.lineTo(cx + r * 0.45, cy + r * 0.05);
      ctx.lineTo(cx + r * 1.05, cy - r * 0.55);
      ctx.lineTo(cx + r, cy + r * 0.8);
      ctx.closePath();
      break;
  }
  ctx.fill();
  if (v.tier > 0 && ink === undefined) ctx.stroke();
  ctx.restore();
}
