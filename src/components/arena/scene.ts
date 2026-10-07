import { createRng } from "@/domain/util/rng";

/** Fixed camera geometry. The camera never moves; every fighter is always on screen. */
export interface Layout {
  name: "wide" | "tall";
  w: number;
  h: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** vertical extent of the stands behind the floor */
  standsH: number;
}

export const WIDE: Layout = { name: "wide", w: 1000, h: 600, cx: 500, cy: 352, rx: 392, ry: 200, standsH: 190 };
export const TALL: Layout = { name: "tall", w: 800, h: 780, cx: 400, cy: 452, rx: 362, ry: 262, standsH: 190 };

export function project(L: Layout, wx: number, wy: number, R: number): { x: number; y: number; s: number } {
  const depth = (wy + R) / (2 * R); // 0 far … 1 near
  return { x: L.cx + (wx / R) * L.rx, y: L.cy + (wy / R) * L.ry, s: (L === TALL ? 0.98 : 1.04) + 0.34 * depth };
}

function gearPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, teeth: number, inner: number) {
  ctx.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : inner;
    const x = cx + Math.cos(a) * rx * r;
    const y = cy + Math.sin(a) * ry * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Pre-renders the static arena hall (stands, wall, floor, lights). */
export function drawBackground(ctx: CanvasRenderingContext2D, L: Layout): void {
  const { w, h, cx, cy, rx, ry } = L;
  const rng = createRng("clank-arena-hall");

  // --- Hall: deep gradient + back wall
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#04060a");
  g.addColorStop(0.45, "#0b1018");
  g.addColorStop(1, "#080b11");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Arches along the back wall
  const archY = L.standsH - 6;
  for (let i = 0; i < 9; i++) {
    const ax = (i + 0.5) * (w / 9);
    const aw = (w / 9) * 0.7;
    const grad = ctx.createLinearGradient(0, 24, 0, archY);
    grad.addColorStop(0, "#0a0e15");
    grad.addColorStop(1, "#150f26");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(ax - aw / 2, archY);
    ctx.lineTo(ax - aw / 2, 56);
    ctx.quadraticCurveTo(ax, 4, ax + aw / 2, 56);
    ctx.lineTo(ax + aw / 2, archY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#2b3547";
    ctx.lineWidth = 3;
    ctx.stroke();
    // warm lamp behind each arch
    const lamp = ctx.createRadialGradient(ax, 70, 2, ax, 70, aw * 0.7);
    lamp.addColorStop(0, "rgba(202,148,249,0.30)");
    lamp.addColorStop(1, "rgba(202,148,249,0)");
    ctx.fillStyle = lamp;
    ctx.fillRect(ax - aw, 20, aw * 2, archY - 10);
  }

  // Overhead pipes (lavender metal)
  for (const [y, th] of [[10, 9], [26, 6]] as const) {
    const pg = ctx.createLinearGradient(0, y, 0, y + th);
    pg.addColorStop(0, "#b08ae0");
    pg.addColorStop(0.5, "#5b379c");
    pg.addColorStop(1, "#2a1850");
    ctx.fillStyle = pg;
    ctx.fillRect(0, y, w, th);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(0, y + 1, w, 1.4);
    for (let x = 40; x < w; x += 130) {
      ctx.fillStyle = "#1a1030";
      ctx.fillRect(x, y - 2, 7, th + 4);
    }
  }

  // Hanging banners
  const bannerColors = ["#b8402f", "#2e6fa8", "#754cbe", "#4a8d62"];
  for (let i = 0; i < 4; i++) {
    const bx = w * (0.14 + i * 0.24);
    ctx.fillStyle = bannerColors[i] as string;
    ctx.beginPath();
    ctx.moveTo(bx - 20, 34);
    ctx.lineTo(bx + 20, 34);
    ctx.lineTo(bx + 20, 108);
    ctx.lineTo(bx, 98);
    ctx.lineTo(bx - 20, 108);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "rgba(232,213,255,0.92)";
    gearPath(ctx, bx, 64, 9, 9, 8, 0.72);
    ctx.fill();
    ctx.fillStyle = "#12161d";
    ctx.beginPath();
    ctx.arc(bx, 64, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Stands: three tiers of silhouettes
  const tiers = 4;
  for (let t = 0; t < tiers; t++) {
    const ty = L.standsH - 10 + t * 12 - (tiers - t) * 4 + 8;
    const rowGrad = ctx.createLinearGradient(0, ty - 18, 0, ty + 22);
    rowGrad.addColorStop(0, "#10151e");
    rowGrad.addColorStop(1, "#06080c");
    ctx.fillStyle = rowGrad;
    ctx.fillRect(0, ty - 4, w, 24);
    const n = Math.round(w / 15);
    for (let i = 0; i < n; i++) {
      const x = (i + rng.next() * 0.8) * (w / n);
      const hh = 7 + rng.next() * 3;
      const shade = 22 + t * 6 + Math.floor(rng.next() * 12);
      ctx.fillStyle = `rgb(${shade},${shade + 4},${shade + 12})`;
      ctx.beginPath();
      ctx.arc(x, ty + 2, hh * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x - hh * 0.9, ty + 5, hh * 1.8, 11);
      if (rng.next() < 0.12) {
        // a cheering fan with raised arms and a bright scarf
        ctx.fillStyle = bannerColors[Math.floor(rng.next() * 4)] as string;
        ctx.fillRect(x - hh * 0.8, ty + 8, hh * 1.6, 3);
        ctx.fillStyle = `rgb(${shade + 10},${shade + 14},${shade + 22})`;
        ctx.fillRect(x - hh, ty - 6, 2.4, 12);
        ctx.fillRect(x + hh - 2.4, ty - 6, 2.4, 12);
      }
    }
  }
  // Barrier wall in front of the stands
  const wallY = L.standsH + 24;
  const wg = ctx.createLinearGradient(0, wallY - 22, 0, wallY + 26);
  wg.addColorStop(0, "#2a3342");
  wg.addColorStop(0.3, "#1a202b");
  wg.addColorStop(1, "#0b0e14");
  ctx.fillStyle = wg;
  ctx.fillRect(0, wallY - 22, w, 48);
  ctx.fillStyle = "#ca94f9";
  ctx.fillRect(0, wallY - 22, w, 3);
  for (let x = 0; x < w; x += 40) {
    ctx.fillStyle = "rgba(202,148,249,0.2)";
    ctx.fillRect(x, wallY - 18, 20, 8);
  }

  // --- Floor
  // outer shadow/glow
  ctx.save();
  ctx.shadowColor = "rgba(202,148,249,0.32)";
  ctx.shadowBlur = 40;
  ctx.fillStyle = "#06080c";
  ctx.beginPath();
  ctx.ellipse(cx, cy + 6, rx + 18, ry + 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // rim (lavender metal) with dark segments
  const rim = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
  rim.addColorStop(0, "#b08ae0");
  rim.addColorStop(0.5, "#5b379c");
  rim.addColorStop(1, "#2a1850");
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 3, rx + 14, ry + 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy + 3, rx + 14, ry + 10, 0, 0, Math.PI * 2);
  ctx.ellipse(cx, cy, rx + 3, ry + 2, 0, 0, Math.PI * 2, true);
  ctx.clip("evenodd");
  for (let i = -40; i < 80; i++) {
    ctx.fillStyle = i % 2 === 0 ? "rgba(14,8,28,0.85)" : "rgba(202,148,249,0.0)";
    ctx.beginPath();
    ctx.moveTo(i * 22, cy - ry - 20);
    ctx.lineTo(i * 22 + 12, cy - ry - 20);
    ctx.lineTo(i * 22 + 12 - 90, cy + ry + 20);
    ctx.lineTo(i * 22 - 90, cy + ry + 20);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // floor plate
  const fg = ctx.createRadialGradient(cx, cy - ry * 0.25, 20, cx, cy, rx);
  fg.addColorStop(0, "#3b465a");
  fg.addColorStop(0.55, "#262e3d");
  fg.addColorStop(1, "#161b25");
  ctx.fillStyle = fg;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();
  // concentric rings
  for (let i = 1; i <= 6; i++) {
    const k = i / 6.4;
    ctx.strokeStyle = i % 2 ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.28)";
    ctx.lineWidth = i % 2 ? 2 : 3;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * k, ry * k, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // radial seams
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * rx * 0.18, cy + Math.sin(a) * ry * 0.18);
    ctx.lineTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    ctx.stroke();
  }
  // rivets
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  for (let ring = 0; ring < 3; ring++) {
    const k = 0.34 + ring * 0.26;
    const n = 16 + ring * 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ring * 0.1;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // central gear emblem
  ctx.fillStyle = "rgba(202,148,249,0.10)";
  gearPath(ctx, cx, cy, rx * 0.2, ry * 0.2, 12, 0.82);
  ctx.fill();
  ctx.strokeStyle = "rgba(202,148,249,0.42)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "rgba(7,9,13,0.55)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 0.075, ry * 0.075, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(202,148,249,0.55)";
  ctx.lineWidth = 3;
  ctx.stroke();
  // spotlights
  for (const sx of [0.25, 0.5, 0.75]) {
    const lg = ctx.createRadialGradient(cx + (sx - 0.5) * rx * 1.4, cy - ry * 0.1, 4, cx + (sx - 0.5) * rx * 1.4, cy, rx * 0.5);
    lg.addColorStop(0, "rgba(240,226,255,0.15)");
    lg.addColorStop(1, "rgba(240,226,255,0)");
    ctx.fillStyle = lg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();

  // inner rim highlight (the static boundary — it never moves)
  ctx.strokeStyle = "rgba(202,148,249,0.5)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx - 2, ry - 1.5, 0, 0, Math.PI * 2);
  ctx.stroke();

  // vignette
  const vg = ctx.createRadialGradient(cx, cy, Math.min(rx, ry) * 0.9, cx, cy, Math.max(w, h) * 0.75);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.65)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);
}
