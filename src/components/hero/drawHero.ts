import type { AppearanceParts } from "@/domain/character/appearance";
import { ACCESSORIES, HAIR_COLORS, SKIN_TONES } from "@/domain/character/appearance";
import type { SpriteConfig } from "@/domain/sprites/config";

import { darken, lighten, shiftHue, RARITY_COLOR } from "./colors";

/**
 * PROCEDURAL VECTOR HERO — now the FALLBACK renderer. The arena and portraits draw heroes from
 * layered spritesheets (see components/sprites); this vector hero is what appears if a sprite set
 * is still loading, fails to load, or lacks art for a hero's class kit, so a hero is never missing.
 *
 * Procedural, modular hero sprite. Every hero is assembled from the same parts library
 * (body · face · hair · headgear · outfit · weapon · accessory · cape · aura) so animations
 * (idle · walk · attack · cast · hit · eliminated · victory) are identical and reliable for any
 * community member — no per-user art is ever required. Rarity adds its look (aura, cape, accessories; the rarity layers live in the spritesheet engine) — it never changes what the hero is.
 *
 * Coordinate system: origin at the hero's feet, +y down, ≈ 104 units tall.
 */
export interface HeroLook {
  rarity: string;
  parts: AppearanceParts;
  /** Resolved layer config for the spritesheet renderer (ignored by this vector fallback). */
  sprite: SpriteConfig;
  colors: [string, string, string];
  weapon: string;
  headgear: string;
  body: string;
}

export interface HeroPose {
  /** seconds, drives idle/walk cycles and aura animation */
  t: number;
  moving: boolean;
  /** 0..1 progress of an attack swing, or -1 */
  attack: number;
  /** 0..1 progress of an ability cast, or -1 */
  cast: number;
  /** 0..1 hit-flash intensity */
  hurt: number;
  /** 0 alive … 1 fully faded after elimination */
  dead: number;
  facing: 1 | -1;
  victory: boolean;
  /** extra tint used for slows etc. */
  chill?: boolean;
  /** false: the caller draws the ground itself (the arena: one small contact shadow, rarity shown by the plate / gear) — no shadow, no aura ring. */
  ground?: boolean;
}

export const IDLE_POSE: HeroPose = { t: 0, moving: false, attack: -1, cast: -1, hurt: 0, dead: 0, facing: 1, victory: false };

const OUTLINE = "#0c0f15";

/** Alpha of the whole hero for this draw (parent fade × elimination fade). Parts scale from it. */
let BASE_ALPHA = 1;
const setAlpha = (ctx: CanvasRenderingContext2D, v: number) => {
  ctx.globalAlpha = BASE_ALPHA * v;
};

interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  skin: string;
  hair: string;
  outline: string;
  hurt: number;
}

function paletteOf(look: HeroLook, hurt: number): Palette {
  const hue = (look.parts.outfitHue % 61) - 30; // keep class identity recognisable
  const [p, s, a] = look.colors;
  const mixHurt = (c: string) => (hurt > 0 ? lighten(c, hurt * 0.55) : c);
  return {
    primary: mixHurt(shiftHue(p, hue)),
    secondary: mixHurt(shiftHue(s, hue)),
    accent: mixHurt(shiftHue(a, hue)),
    skin: mixHurt(SKIN_TONES[look.parts.skin % SKIN_TONES.length] as string),
    hair: mixHurt(HAIR_COLORS[look.parts.hairColor % HAIR_COLORS.length] as string),
    outline: hurt > 0.2 ? "#ff6a5a" : OUTLINE,
    hurt,
  };
}

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fillStroke(ctx: CanvasRenderingContext2D, fill: string, outline: string, lw = 2.4) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = outline;
  ctx.lineJoin = "round";
  ctx.stroke();
}

function drawAura(ctx: CanvasRenderingContext2D, look: HeroLook, t: number) {
  const aura = look.parts.aura;
  if (aura === "none") return;
  const c = RARITY_COLOR[look.rarity] ?? "#fff";
  ctx.save();
  if (aura === "ring") {
    setAlpha(ctx, 0.55 + Math.sin(t * 3) * 0.15);
    ctx.strokeStyle = c;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, -4, 30 + Math.sin(t * 3) * 1.5, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
    setAlpha(ctx, 0.18);
    ctx.fillStyle = c;
    ctx.fill();
  } else if (aura === "sparks") {
    for (let i = 0; i < 6; i++) {
      const a = t * 1.7 + (i * Math.PI * 2) / 6;
      const rx = 34;
      const x = Math.cos(a) * rx;
      const y = -52 + Math.sin(a * 1.3) * 34 - ((t * 20 + i * 11) % 18);
      setAlpha(ctx, 0.5 + 0.4 * Math.sin(a * 2));
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    setAlpha(ctx, 0.4);
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, -4, 28, 8, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    // flame
    for (let i = 0; i < 9; i++) {
      const phase = t * 6 + i * 1.9;
      const base = -32 + (i % 3) * 32;
      const x = Math.cos(i * 1.4) * 24;
      const h = 22 + Math.sin(phase) * 8 + (i % 3) * 5;
      setAlpha(ctx, 0.5);
      ctx.fillStyle = i % 2 ? c : "#ff7a2f";
      ctx.beginPath();
      ctx.moveTo(x - 5, -4);
      ctx.quadraticCurveTo(x + Math.sin(phase) * 5, base - h, x + 5, -4);
      ctx.closePath();
      ctx.fill();
    }
    setAlpha(ctx, 0.5);
    ctx.strokeStyle = c;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, -4, 32, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHair(ctx: CanvasRenderingContext2D, style: number, p: Palette, cy: number, covered: boolean) {
  if (covered) return; // a helm hides the hair completely
  ctx.fillStyle = p.hair;
  ctx.strokeStyle = p.outline;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  const top = cy - 15;
  switch (style % 8) {
    case 0: // crop
      ctx.beginPath();
      ctx.arc(0, cy - 2, 17.5, Math.PI * 1.08, Math.PI * 1.92);
      ctx.lineTo(10, top + 6);
      ctx.quadraticCurveTo(0, top + 2, -10, top + 6);
      ctx.closePath();
      break;
    case 1: // spiky
      ctx.beginPath();
      ctx.moveTo(-16, cy - 6);
      for (let i = 0; i < 6; i++) {
        ctx.lineTo(-16 + i * 6.4 + 3, top - 8 - (i % 2) * 5);
        ctx.lineTo(-16 + i * 6.4 + 6.4, top + 3);
      }
      ctx.lineTo(16, cy - 6);
      ctx.closePath();
      break;
    case 2: // long
      ctx.beginPath();
      ctx.arc(0, cy - 2, 18, Math.PI, Math.PI * 2);
      ctx.lineTo(18, cy + 18);
      ctx.lineTo(10, cy + 14);
      ctx.lineTo(10, cy - 4);
      ctx.lineTo(-10, cy - 4);
      ctx.lineTo(-10, cy + 14);
      ctx.lineTo(-18, cy + 18);
      ctx.closePath();
      break;
    case 3: // mohawk
      ctx.beginPath();
      ctx.moveTo(-5, cy - 8);
      ctx.lineTo(-3, top - 12);
      ctx.lineTo(0, top - 6);
      ctx.lineTo(3, top - 12);
      ctx.lineTo(5, cy - 8);
      ctx.closePath();
      break;
    case 4: // bun
      ctx.beginPath();
      ctx.arc(0, cy - 2, 17.5, Math.PI * 1.1, Math.PI * 1.9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, top - 7, 7, 0, Math.PI * 2);
      break;
    case 5: // curly
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = Math.PI + (i / 6) * Math.PI;
        ctx.arc(Math.cos(a) * 15, cy - 2 + Math.sin(a) * 15, 6, 0, Math.PI * 2);
      }
      break;
    case 6: // swoop
      ctx.beginPath();
      ctx.ellipse(4, cy - 11, 18, 10, -0.25, Math.PI, Math.PI * 2.1);
      ctx.lineTo(-12, cy - 4);
      ctx.closePath();
      break;
    default:
      return; // bald
  }
  ctx.fill();
  ctx.stroke();
}

function drawHeadgear(ctx: CanvasRenderingContext2D, kind: string, p: Palette, cy: number) {
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = p.outline;
  switch (kind) {
    case "helm": {
      ctx.beginPath();
      ctx.arc(0, cy - 1, 19, Math.PI, Math.PI * 2);
      ctx.lineTo(19, cy + 2);
      ctx.lineTo(-19, cy + 2);
      ctx.closePath();
      fillStroke(ctx, p.secondary, p.outline);
      ctx.fillStyle = darken(p.secondary, 0.35);
      rrect(ctx, -11, cy - 6, 22, 5, 2);
      ctx.fill();
      ctx.fillStyle = p.accent;
      ctx.beginPath();
      ctx.moveTo(-2, cy - 20);
      ctx.lineTo(0, cy - 30);
      ctx.lineTo(2, cy - 20);
      ctx.closePath();
      fillStroke(ctx, p.accent, p.outline, 2);
      break;
    }
    case "hat": {
      ctx.beginPath();
      ctx.moveTo(-26, cy - 8);
      ctx.quadraticCurveTo(0, cy - 2, 26, cy - 8);
      ctx.lineTo(18, cy - 12);
      ctx.lineTo(-18, cy - 12);
      ctx.closePath();
      fillStroke(ctx, p.primary, p.outline);
      ctx.beginPath();
      ctx.moveTo(-14, cy - 11);
      ctx.quadraticCurveTo(-4, cy - 40, 10, cy - 46);
      ctx.quadraticCurveTo(10, cy - 30, 14, cy - 11);
      ctx.closePath();
      fillStroke(ctx, p.primary, p.outline);
      ctx.fillStyle = p.accent;
      ctx.fillRect(-14, cy - 17, 28, 4);
      break;
    }
    case "hood": {
      ctx.beginPath();
      ctx.arc(0, cy, 21, Math.PI * 0.95, Math.PI * 2.05);
      ctx.lineTo(18, cy + 12);
      ctx.quadraticCurveTo(0, cy + 6, -18, cy + 12);
      ctx.closePath();
      fillStroke(ctx, p.primary, p.outline);
      break;
    }
    case "cap": {
      ctx.beginPath();
      ctx.arc(0, cy - 3, 18, Math.PI * 1.02, Math.PI * 1.98);
      ctx.lineTo(24, cy - 6);
      ctx.lineTo(-18, cy - 6);
      ctx.closePath();
      fillStroke(ctx, p.primary, p.outline);
      ctx.beginPath();
      ctx.moveTo(10, cy - 16);
      ctx.quadraticCurveTo(30, cy - 36, 28, cy - 22);
      ctx.quadraticCurveTo(22, cy - 18, 12, cy - 12);
      ctx.closePath();
      fillStroke(ctx, p.accent, p.outline, 2);
      break;
    }
    case "halo": {
      ctx.strokeStyle = "#ffe08a";
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.ellipse(0, cy - 24, 14, 4.5, 0, 0, Math.PI * 2);
      ctx.stroke();
      setAlpha(ctx, 0.25);
      ctx.fillStyle = "#fff0b0";
      ctx.fill();
      setAlpha(ctx, 1);
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.arc(0, cy - 3, 17, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
      break;
    }
    case "crown": {
      ctx.beginPath();
      ctx.moveTo(-14, cy - 16);
      ctx.lineTo(-14, cy - 28);
      ctx.lineTo(-7, cy - 20);
      ctx.lineTo(0, cy - 30);
      ctx.lineTo(7, cy - 20);
      ctx.lineTo(14, cy - 28);
      ctx.lineTo(14, cy - 16);
      ctx.closePath();
      fillStroke(ctx, "#ffcf5a", p.outline);
      break;
    }
    default:
      break;
  }
}

function drawFace(ctx: CanvasRenderingContext2D, parts: AppearanceParts, cy: number, lookDir: number, hurt: number, dead: number) {
  ctx.fillStyle = OUTLINE;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  const ex = 6.5;
  const ey = cy + 1;
  const dx = lookDir * 1.5;
  if (dead > 0.05) {
    // X eyes when eliminated
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * ex - 3 + dx, ey - 3);
      ctx.lineTo(s * ex + 3 + dx, ey + 3);
      ctx.moveTo(s * ex + 3 + dx, ey - 3);
      ctx.lineTo(s * ex - 3 + dx, ey + 3);
      ctx.stroke();
    }
  } else if (hurt > 0.3) {
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * ex - 3 + dx, ey - 2);
      ctx.lineTo(s * ex + dx, ey + 1);
      ctx.lineTo(s * ex + 3 + dx, ey - 2);
      ctx.stroke();
    }
  } else {
    switch (parts.eyes % 4) {
      case 0:
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(s * ex + dx, ey, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case 1:
        for (const s of [-1, 1]) {
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.ellipse(s * ex + dx * 0.5, ey, 3.6, 4.2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = OUTLINE;
          ctx.beginPath();
          ctx.arc(s * ex + dx * 1.4, ey + 0.5, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case 2:
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * ex - 3 + dx, ey);
          ctx.quadraticCurveTo(s * ex + dx, ey + 3, s * ex + 3 + dx, ey);
          ctx.stroke();
        }
        break;
      default:
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * ex - 3 * s + dx, ey - 3);
          ctx.lineTo(s * ex + 3 * s + dx, ey + 1);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(s * ex + dx, ey + 1, 1.7, 0, Math.PI * 2);
          ctx.fill();
        }
    }
  }
  // mouth
  ctx.beginPath();
  const my = cy + 9;
  if (dead > 0.05 || hurt > 0.3) {
    ctx.ellipse(dx, my + 1, 2.6, 3, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (parts.mouth % 3 === 0) {
    ctx.moveTo(-4 + dx, my);
    ctx.quadraticCurveTo(dx, my + 4, 4 + dx, my);
    ctx.stroke();
  } else if (parts.mouth % 3 === 1) {
    ctx.moveTo(-3 + dx, my + 1);
    ctx.lineTo(3 + dx, my + 1);
    ctx.stroke();
  } else {
    ctx.arc(dx, my + 1, 2.6, 0, Math.PI);
    ctx.stroke();
  }
}

function drawWeapon(ctx: CanvasRenderingContext2D, kind: string, p: Palette, angle: number, glow: number, rarityColor: string) {
  ctx.save();
  ctx.rotate(angle);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = p.outline;
  ctx.lineWidth = 2.4;
  const steel = lighten("#aab4c3", p.hurt * 0.4);
  switch (kind) {
    case "sword":
      ctx.fillStyle = steel;
      rrect(ctx, -3.5, -44, 7, 36, 2);
      fillStroke(ctx, steel, p.outline);
      rrect(ctx, -9, -10, 18, 5, 2);
      fillStroke(ctx, p.accent, p.outline);
      rrect(ctx, -2.5, -6, 5, 11, 2);
      fillStroke(ctx, darken(p.accent, 0.3), p.outline, 2);
      break;
    case "mace":
      rrect(ctx, -2.5, -34, 5, 40, 2);
      fillStroke(ctx, "#6d5a45", p.outline);
      ctx.beginPath();
      ctx.arc(0, -38, 9, 0, Math.PI * 2);
      fillStroke(ctx, steel, p.outline);
      ctx.fillStyle = p.accent;
      ctx.fillRect(-9, -40, 18, 3);
      break;
    case "staff": {
      rrect(ctx, -2.2, -48, 4.4, 56, 2);
      fillStroke(ctx, "#7a5a3a", p.outline, 2);
      ctx.beginPath();
      ctx.arc(0, -52, 7 + glow * 3, 0, Math.PI * 2);
      ctx.save();
      ctx.shadowColor = rarityColor;
      ctx.shadowBlur = 6 + glow * 14;
      fillStroke(ctx, lighten(p.accent, 0.35 + glow * 0.3), p.outline, 2);
      ctx.restore();
      break;
    }
    case "tome":
      rrect(ctx, -9, -28, 18, 22, 3);
      fillStroke(ctx, p.primary, p.outline);
      ctx.fillStyle = p.accent;
      ctx.fillRect(-1.5, -28, 3, 22);
      ctx.save();
      ctx.shadowColor = "#ffe9a0";
      ctx.shadowBlur = glow * 14;
      ctx.strokeStyle = "#fff4c4";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-7, -26, 14, 18);
      ctx.restore();
      break;
    case "daggers":
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.translate(s * 7, 0);
        ctx.rotate(s * 0.35);
        rrect(ctx, -2.5, -26, 5, 24, 2);
        fillStroke(ctx, steel, p.outline, 2.2);
        rrect(ctx, -4, -4, 8, 4, 1.5);
        fillStroke(ctx, p.accent, p.outline, 2);
        ctx.restore();
      }
      break;
    case "bow":
      ctx.strokeStyle = p.outline;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(-6, -22, 24, -1.1, 1.1);
      ctx.stroke();
      ctx.strokeStyle = "#8a6a40";
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.arc(-6, -22, 24, -1.1, 1.1);
      ctx.stroke();
      ctx.strokeStyle = "#e9e2d0";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-6 + Math.cos(-1.1) * 24, -22 + Math.sin(-1.1) * 24);
      ctx.lineTo(-6 + Math.cos(1.1) * 24 - glow * 8, -22 + Math.sin(1.1) * 24);
      ctx.stroke();
      break;
    default:
      break;
  }
  ctx.restore();
}

/** Draws one hero at the current transform origin (feet). */
export function drawHero(ctx: CanvasRenderingContext2D, look: HeroLook, pose: HeroPose): void {
  const p = paletteOf(look, pose.hurt);
  const { parts } = look;
  const t = pose.t;
  const f = pose.facing;
  const dead = pose.dead;
  const rarityColor = RARITY_COLOR[look.rarity] ?? "#fff";

  // Shadow + aura sit on the ground and never rotate with the body.
  const parentAlpha = ctx.globalAlpha;
  const ground = pose.ground !== false;
  if (ground) {
    ctx.save();
    ctx.globalAlpha = parentAlpha * (1 - dead) * 0.38;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, -1, 25, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (ground && dead < 0.6) {
    ctx.save();
    BASE_ALPHA = parentAlpha * (1 - dead / 0.6);
    drawAura(ctx, look, t);
    ctx.restore();
  }

  ctx.save();
  BASE_ALPHA = parentAlpha * Math.max(0, 1 - Math.max(0, dead - 0.35) / 0.65);
  ctx.globalAlpha = BASE_ALPHA;
  if (dead > 0) {
    // topple backwards around the feet
    ctx.rotate(-f * Math.min(1, dead * 3) * 1.45);
    ctx.translate(0, Math.min(1, dead * 3) * 6);
  }
  ctx.scale(f, 1);

  // Animation parameters
  const breath = Math.sin(t * 2.4) * 1.3;
  const walk = pose.moving ? Math.sin(t * 13) : 0;
  const bob = pose.moving ? Math.abs(Math.sin(t * 13)) * -3 : breath * 0.6;
  const attackK = pose.attack >= 0 ? Math.sin(Math.min(1, pose.attack) * Math.PI) : 0;
  const castK = pose.cast >= 0 ? Math.sin(Math.min(1, pose.cast) * Math.PI) : 0;
  const victoryK = pose.victory ? Math.abs(Math.sin(t * 5)) : 0;
  const lunge = attackK * 6;
  ctx.translate(lunge, bob - victoryK * 10);
  const squash = pose.hurt > 0 ? 1 - pose.hurt * 0.05 : 1;
  ctx.scale(1 + (1 - squash) * 2, squash);

  // Cape (behind everything)
  if (parts.cape) {
    ctx.beginPath();
    const sway = Math.sin(t * 3) * 3 + (pose.moving ? -8 : 0);
    ctx.moveTo(-13, -62);
    ctx.quadraticCurveTo(-26 + sway, -38, -22 + sway * 1.4, -10);
    ctx.lineTo(10 + sway * 0.6, -12);
    ctx.quadraticCurveTo(14, -40, 13, -62);
    ctx.closePath();
    fillStroke(ctx, darken(rarityColor, 0.35), p.outline);
  }

  // Back arm (holds nothing; swings opposite to the legs)
  const backArm = pose.moving ? -walk * 0.7 : Math.sin(t * 2.4 + 1) * 0.08;
  ctx.save();
  ctx.translate(-16, -56);
  ctx.rotate(backArm - 0.1 - castK * 1.6 + victoryK * -2.2);
  rrect(ctx, -4, -2, 8, 20, 4);
  fillStroke(ctx, look.body === "robe" ? p.primary : p.skin, p.outline, 2.2);
  ctx.restore();

  // Legs
  if (look.body !== "robe") {
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(s * 7, -30);
      ctx.rotate(walk * 0.55 * s);
      rrect(ctx, -5, 0, 10, 23, 4);
      fillStroke(ctx, darken(p.primary, 0.25), p.outline, 2.2);
      rrect(ctx, -6, 19, 13, 7, 3);
      fillStroke(ctx, darken(p.secondary, 0.35), p.outline, 2.2);
      ctx.restore();
    }
  } else {
    for (const s of [-1, 1]) {
      rrect(ctx, s * 7 - 4 + walk * 1.5 * s, -8, 9, 8, 3);
      fillStroke(ctx, darken(p.secondary, 0.35), p.outline, 2.2);
    }
  }

  // Torso
  const wide = look.body === "heavy" ? 38 : look.body === "light" ? 28 : 33;
  if (look.body === "robe") {
    ctx.beginPath();
    ctx.moveTo(-15, -62);
    ctx.lineTo(15, -62);
    ctx.lineTo(23, -8 + Math.sin(t * 2.4) * 0.5);
    ctx.lineTo(-23, -8 + Math.sin(t * 2.4) * 0.5);
    ctx.closePath();
    fillStroke(ctx, p.primary, p.outline);
    ctx.fillStyle = p.accent;
    ctx.fillRect(-16, -42, 32, 5);
  } else {
    rrect(ctx, -wide / 2, -64, wide, 36, look.body === "heavy" ? 6 : 8);
    fillStroke(ctx, p.primary, p.outline);
    ctx.fillStyle = p.secondary;
    if (look.body === "heavy") {
      rrect(ctx, -wide / 2 + 4, -60, wide - 8, 18, 4);
      ctx.fill();
      ctx.strokeStyle = p.outline;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.fillStyle = p.accent;
      ctx.fillRect(-wide / 2, -36, wide, 5);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * (wide / 2 + 1), -60, 9, 0, Math.PI * 2);
        fillStroke(ctx, p.secondary, p.outline, 2.2);
      }
    } else {
      ctx.fillRect(-wide / 2, -38, wide, 4);
      ctx.fillStyle = p.accent;
      ctx.beginPath();
      ctx.moveTo(-wide / 2, -64);
      ctx.lineTo(-wide / 2 + 10, -64);
      ctx.lineTo(wide / 2, -34);
      ctx.lineTo(wide / 2 - 8, -34);
      ctx.closePath();
      setAlpha(ctx, 0.55);
      ctx.fill();
      setAlpha(ctx, 1);
    }
  }
  if (parts.accessory === 3) {
    ctx.save();
    ctx.translate(-8, -52);
    ctx.fillStyle = "#e0a43a";
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i % 2 ? 3 : 5;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    fillStroke(ctx, "#e0a43a", p.outline, 1.4);
    ctx.restore();
  }
  if (parts.accessory === 2) {
    ctx.fillStyle = p.accent;
    rrect(ctx, -12, -68, 24, 7, 3);
    fillStroke(ctx, p.accent, p.outline, 2);
    ctx.beginPath();
    ctx.moveTo(6, -62);
    ctx.quadraticCurveTo(18 + Math.sin(t * 5) * 3, -56, 20 + Math.sin(t * 5) * 4, -46);
    ctx.lineTo(13, -50);
    ctx.closePath();
    fillStroke(ctx, p.accent, p.outline, 2);
  }

  // Head
  const headY = -79 + (pose.hurt > 0.3 ? 2 : 0);
  ctx.beginPath();
  ctx.arc(0, headY, 17, 0, Math.PI * 2);
  fillStroke(ctx, p.skin, p.outline);
  const hasFullCover = look.headgear === "helm";
  drawHair(ctx, parts.hairStyle, p, headY, hasFullCover);
  drawFace(ctx, parts, headY, 1, pose.hurt, dead);
  if (parts.accessory === 1) {
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 8, headY - 12, 5.4, 0, Math.PI * 2);
      fillStroke(ctx, "rgba(120,220,255,0.55)", "#e0a43a", 2.2);
    }
    ctx.strokeStyle = "#e0a43a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-3, headY - 12);
    ctx.lineTo(3, headY - 12);
    ctx.stroke();
  }
  if (parts.accessory === 4) {
    ctx.beginPath();
    ctx.arc(7, headY + 1, 5.6, 0, Math.PI * 2);
    ctx.strokeStyle = "#e0a43a";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(10, headY + 6);
    ctx.quadraticCurveTo(14, headY + 18, 8, headY + 26);
    ctx.stroke();
  }
  if (parts.accessory === 5) {
    ctx.strokeStyle = "#2a3342";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, headY - 1, 18.5, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-17, headY - 2);
    ctx.lineTo(-20, headY + 8);
    ctx.lineTo(-13, headY + 12);
    ctx.stroke();
  }
  drawHeadgear(ctx, look.headgear, p, headY);

  // Front arm + weapon
  ctx.save();
  ctx.translate(16, -56);
  const swing = pose.attack >= 0 ? -1.9 + Math.min(1, pose.attack) * 3.0 : 0;
  const idleSway = Math.sin(t * 2.4) * 0.06 + (pose.moving ? walk * 0.6 : 0);
  const armAngle = pose.attack >= 0 ? swing : -0.25 + idleSway - castK * 2.2 - victoryK * 2.6;
  ctx.rotate(armAngle);
  rrect(ctx, -4, -2, 8, 20, 4);
  fillStroke(ctx, look.body === "robe" ? p.primary : p.skin, p.outline, 2.2);
  ctx.translate(0, 18);
  ctx.beginPath();
  ctx.arc(0, 0, 4.4, 0, Math.PI * 2);
  fillStroke(ctx, p.skin, p.outline, 2);
  const weaponAngle = look.weapon === "bow" ? Math.PI / 2 - 0.1 : look.weapon === "staff" || look.weapon === "tome" ? -0.1 + castK * 0.5 : Math.PI + 0.2;
  drawWeapon(ctx, look.weapon, p, weaponAngle, Math.max(castK, attackK * 0.4), rarityColor);
  ctx.restore();

  if (pose.chill) {
    setAlpha(ctx, 0.28);
    ctx.fillStyle = "#8fe3ff";
    ctx.fillRect(-26, -106, 52, 106);
  }
  ctx.restore();
  void ACCESSORIES;
}

/** Visual height of a hero in sprite units (feet to top of head), for name-plate placement. */
export const HERO_HEIGHT = 104;
