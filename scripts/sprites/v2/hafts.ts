import { circle, cord, ellipse, gem, inWeaponSpace, line, lit, M, OL, poly, rrect, sparkle, sub, weaponPoint, weaponScale, type Ctx, type Joints, type Pose, type Pt, type Ramp } from "./kit";
import { piece, type Piece } from "./library";

/**
 * HERO RENDERER v2 — HAFTED weapons (weapon space: the hand at the origin, the shaft up −y): the Tank's maces and hammers, the Mage's staffs and
 * the Cleric's scepters. A SHAFT (length above / below the hand, wood or metal, bands, a wrapped grip) and a HEAD. Magic heads brighten and
 * throw rays on a cast (`glow` of the pose) — shapes, not translucent blobs (the pixelator would turn a blob into a solid disc).
 */

export type HeadKind =
  | "flanged" | "ball" | "spiked" | "hammer" | "club" | "maul" | "pick"
  | "crystal" | "orb" | "rings" | "branch" | "skull" | "moon" | "shard" | "eye" | "cage"
  | "sun" | "star" | "ankh" | "cross" | "lantern" | "wings" | "dove" | "flame";

export interface HaftSpec {
  /** Shaft length above the hand (to the head's base). */
  len: number;
  /** Shaft below the hand (a staff's foot). */
  below?: number;
  w?: number;
  shaft: Ramp;
  wrap?: Ramp;
  bands?: Ramp;
  head: HeadKind;
  headMat: Ramp;
  /** The magic / holy light of the head (the crystal, the orb, the sun). */
  light?: Ramp;
  gem?: Ramp;
  size?: number;
  /** Small ornaments (gold tips, a ribbon, leaves). */
  trim?: Ramp;
}

/** Where the head's centre is (weapon space). */
export const headCentre = (s: HaftSpec): Pt => [0, -s.len - 3.6 * (s.size ?? 1)];

function shaftDraw(g: Ctx, s: HaftSpec): void {
  const w = s.w ?? 2.2;
  const below = s.below ?? 4.6;
  rrect(g, -w / 2, -s.len, w, s.len + below, w * 0.45, s.shaft.base, 0.8);
  line(g, [-w * 0.15, -s.len + 1], [-w * 0.15, below - 1], 0.6, s.shaft.hi);
  if (s.wrap) {
    rrect(g, -w / 2 - 0.2, -2.2, w + 0.4, 5, 0.6, s.wrap.base, 0.7);
    for (let y = -1.6; y < 2.6; y += 1.3) line(g, [-w / 2, y], [w / 2, y + 0.7], 0.45, s.wrap.lo);
  }
  if (s.bands) {
    for (const y of [-s.len + 1.6, -s.len * 0.55, below - 1.6]) rrect(g, -w / 2 - 0.5, y - 0.6, w + 1, 1.3, 0.5, s.bands.base, 0.6);
  }
}

function headDraw(g: Ctx, s: HaftSpec, p: Pose): void {
  const k = s.size ?? 1;
  const [cx, cy] = headCentre(s);
  const m = s.headMat;
  const L = s.light ?? M.arcane;
  const charged = p.glow > 0.5;
  const rays = (n: number, r0: number, r1: number, color: string, w = 0.9) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      line(g, [cx + Math.cos(a) * r0, cy + Math.sin(a) * r0], [cx + Math.cos(a) * r1, cy + Math.sin(a) * r1], w, color);
    }
  };
  switch (s.head) {
    case "flanged":
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.25;
        poly(g, [[cx, cy], [cx + Math.cos(a - 0.3) * 3 * k, cy + Math.sin(a - 0.3) * 3 * k], [cx + Math.cos(a) * 6 * k, cy + Math.sin(a) * 6 * k], [cx + Math.cos(a + 0.3) * 3 * k, cy + Math.sin(a + 0.3) * 3 * k]], m.lo, 0.8);
      }
      lit(g, () => g.ellipse(cx, cy, 3.6 * k, 4 * k, 0, 0, Math.PI * 2), m, { shadow: [-0.8, 0.8], hi: () => g.ellipse(cx - 1, cy - 1.4, 1.2, 1.4, 0, 0, Math.PI * 2) });
      rrect(g, -2.6 * k, cy + 3.6 * k, 5.2 * k, 1.6, 0.5, (s.trim ?? M.bronze).base, 0.7);
      break;
    case "ball":
      lit(g, () => g.ellipse(cx, cy, 4.2 * k, 4.4 * k, 0, 0, Math.PI * 2), m, { shadow: [-1, 1], hi: () => g.ellipse(cx - 1.4, cy - 1.6, 1.4, 1.4, 0, 0, Math.PI * 2) });
      for (const a of [0.4, 1.6, 2.8, 4, 5.2]) circle(g, cx + Math.cos(a) * 2.6 * k, cy + Math.sin(a) * 2.6 * k, 0.6, m.hi, 0);
      break;
    case "spiked":
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.2;
        poly(g, [[cx + Math.cos(a - 0.4) * 3.4 * k, cy + Math.sin(a - 0.4) * 3.4 * k], [cx + Math.cos(a) * 7 * k, cy + Math.sin(a) * 7 * k], [cx + Math.cos(a + 0.4) * 3.4 * k, cy + Math.sin(a + 0.4) * 3.4 * k]], m.lo, 0.7);
      }
      lit(g, () => g.ellipse(cx, cy, 4.2 * k, 4.2 * k, 0, 0, Math.PI * 2), m, { shadow: [-1, 1] });
      break;
    case "hammer":
      lit(g, () => sub(g, [[-5.6 * k, cy - 3 * k], [5.6 * k, cy - 3 * k], [5.6 * k, cy + 3 * k], [-5.6 * k, cy + 3 * k]]), m, { shadow: [-1, 0.8] });
      poly(g, [[-5.6 * k, cy - 2 * k], [-9.4 * k, cy], [-5.6 * k, cy + 2 * k]], m.lo, 0.8); // the back spike
      line(g, [-4.6 * k, cy - 1.6 * k], [4.6 * k, cy - 1.6 * k], 0.6, m.hi);
      rrect(g, 5.4 * k, cy - 3.4 * k, 1.6, 6.8 * k, 0.5, m.hi, 0.7);
      break;
    case "maul":
      lit(g, () => sub(g, [[-6.4 * k, cy - 4 * k], [6.4 * k, cy - 4 * k], [6.8 * k, cy + 4 * k], [-6.8 * k, cy + 4 * k]]), m, { shadow: [-1, 1] });
      for (const x of [-6, 6]) rrect(g, x * k - 1, cy - 4.6 * k, 2, 9.2 * k, 0.6, (s.trim ?? m).hi, 0.7);
      line(g, [-5.6 * k, cy], [5.6 * k, cy], 0.7, m.lo);
      break;
    case "club":
      lit(g, () => {
        g.moveTo(-1.4, cy + 6 * k);
        g.quadraticCurveTo(-4.4 * k, cy - 2 * k, -2.6 * k, cy - 6 * k);
        g.quadraticCurveTo(0, cy - 8 * k, 2.6 * k, cy - 6 * k);
        g.quadraticCurveTo(4.4 * k, cy - 2 * k, 1.4, cy + 6 * k);
        g.closePath();
      }, m, { shadow: [-1, 0.6] });
      for (const [x, y] of [[-2, -4], [1.8, -2], [-1.6, 0.6], [2, 2.6], [0, -6]] as const) circle(g, x * k, cy + y * k, 0.8, (s.trim ?? M.iron).base, 0.5);
      break;
    case "pick":
      lit(g, () => sub(g, [[-2, cy - 2 * k], [3, cy - 2.6 * k], [10 * k, cy + 2 * k], [3, cy + 1.6 * k], [-2, cy + 2 * k]]), m, { shadow: [-0.6, 0.6] });
      lit(g, () => sub(g, [[-2, cy - 2 * k], [-6 * k, cy - 2 * k], [-6 * k, cy + 2 * k], [-2, cy + 2 * k]]), m, { shadow: [-0.6, 0.6] });
      break;
    case "crystal":
      for (const sg of [-1, 1]) poly(g, [[sg * 1.1, cy + 4 * k], [sg * 3.8 * k, cy - 0.4 * k], [sg * 1.8, cy + 2.2 * k]], (s.trim ?? M.wood).lo, 0.8);
      if (charged) rays(8, 4.8 * k, 7.6 * k, L.hi);
      lit(g, () => sub(g, [[cx, cy - 4.6 * k], [cx + 2.8 * k, cy], [cx, cy + 4 * k], [cx - 2.8 * k, cy]]), { ...L, base: charged ? L.hi : L.base }, { shadow: [-1, 0.6] });
      poly(g, [[cx, cy - 4.6 * k], [cx + 2.8 * k, cy], [cx, cy]], L.hi, 0);
      break;
    case "orb":
      cord(g, () => {
        g.beginPath();
        g.arc(cx, cy, 4 * k, Math.PI * 0.62, Math.PI * 2.3);
      }, 1.5, m.base);
      if (charged) rays(8, 3.6 * k, 6.6 * k, L.hi);
      lit(g, () => g.ellipse(cx, cy, 2.5 * k, 2.5 * k, 0, 0, Math.PI * 2), { ...L, base: charged ? L.hi : L.base }, { shadow: [-0.8, 0.8], hi: () => g.ellipse(cx - 0.8, cy - 0.9, 0.8, 0.8, 0, 0, Math.PI * 2) });
      break;
    case "rings":
      // a floating gem inside two crossed rings (the rings turn with the glow)
      for (const [rx, ry, rot] of [[4.6, 1.8, 0.3 + p.glow * 0.6], [1.8, 4.6, -0.3]] as const) {
        g.save();
        g.beginPath();
        g.ellipse(cx, cy, rx * k, ry * k, rot, 0, Math.PI * 2);
        g.strokeStyle = OL;
        g.lineWidth = 2;
        g.stroke();
        g.strokeStyle = m.base;
        g.lineWidth = 1;
        g.stroke();
        g.restore();
      }
      gem(g, cx, cy, 2.2 * k, charged ? { ...L, base: L.hi } : L);
      if (charged) sparkle(g, cx + 4 * k, cy - 4 * k, 2.2, L.hi);
      break;
    case "branch":
      // a gnarled living branch: forks, leaves and a glowing seed
      // two gnarled forks curling round a seed, leaves sprouting from them
      for (const sg of [-1, 1]) cord(g, () => {
        g.beginPath();
        g.moveTo(0, cy + 4 * k);
        g.bezierCurveTo(sg * 4.6 * k, cy + 1 * k, sg * 4.2 * k, cy - 5 * k, sg * 1 * k, cy - 6.2 * k);
      }, 1.6, m.base);
      for (const [x, y, a] of [[-5, -2.4, -0.9], [4.8, -3.4, 0.8], [-2.4, -6.6, -0.3], [3, -7.2, 0.4]] as const) ellipse(g, x * k, cy + y * k, 2.2, 1.1, (s.trim ?? M.emerald).base, 0.6, OL, a);
      gem(g, cx + 0.4, cy - 1.6 * k, 1.6 * k, charged ? { ...L, base: L.hi } : L);
      break;
    case "skull":
      lit(g, () => {
        g.ellipse(cx, cy - 0.6 * k, 3.6 * k, 3.4 * k, 0, 0, Math.PI * 2);
        g.rect(cx - 2.2 * k, cy + 1.6 * k, 4.4 * k, 2.4 * k);
      }, m, { shadow: [-0.8, 0.6] });
      circle(g, cx - 1.3 * k, cy - 0.4 * k, 0.9 * k, charged ? L.hi : "#1c1c26", 0);
      circle(g, cx + 1.3 * k, cy - 0.4 * k, 0.9 * k, charged ? L.hi : "#1c1c26", 0);
      for (const x of [-1.2, 0, 1.2]) line(g, [cx + x * k, cy + 2 * k], [cx + x * k, cy + 3.6 * k], 0.4, m.lo);
      break;
    case "moon":
      lit(g, () => {
        g.arc(cx, cy, 4.6 * k, Math.PI * 0.35, Math.PI * 1.65);
        g.arc(cx + 2 * k, cy, 3.6 * k, Math.PI * 1.55, Math.PI * 0.45, true);
        g.closePath();
      }, m, { shadow: [-0.6, 0.6] });
      gem(g, cx + 0.6 * k, cy, 1.4 * k, charged ? { ...L, base: L.hi } : L);
      break;
    case "shard":
      // a cluster of raw crystal shards bound to the shaft
      for (const [x, h, w] of [[-2.2, 7, 1.8], [0.4, 9.4, 2.2], [2.6, 6, 1.6]] as const) {
        lit(g, () => sub(g, [[(x - w) * k, cy + 3 * k], [x * k, cy - h * k + 3 * k], [(x + w) * k, cy + 3 * k]]), { ...L, base: charged ? L.hi : L.base }, { shadow: [-0.6, 0.4] });
      }
      rrect(g, -2.6 * k, cy + 2.6 * k, 5.2 * k, 2, 0.6, m.base, 0.7);
      if (charged) rays(6, 6.6 * k, 9 * k, L.hi, 0.8);
      break;
    case "eye":
      lit(g, () => g.ellipse(cx, cy, 4.4 * k, 3 * k, 0, 0, Math.PI * 2), m, { shadow: [-0.6, 0.6] });
      circle(g, cx + 0.4, cy, 1.8 * k, charged ? L.hi : L.base, 0.6);
      circle(g, cx + 0.6, cy, 0.7 * k, "#1c1c26", 0);
      for (const a of [-0.6, 0, 0.6]) line(g, [cx + Math.sin(a) * 4.6 * k, cy - Math.cos(a) * 3.2 * k], [cx + Math.sin(a) * 6.6 * k, cy - Math.cos(a) * 5 * k], 0.8, m.base);
      break;
    case "cage":
      // a gilded cage holding a floating spark
      for (const x of [-3, -1, 1, 3]) line(g, [x * k, cy + 3.6 * k], [x * 0.5 * k, cy - 4.4 * k], 0.8, m.base);
      rrect(g, -3.6 * k, cy + 3 * k, 7.2 * k, 1.4, 0.4, m.base, 0.6);
      circle(g, cx, cy - 4.6 * k, 1, m.base, 0.6);
      sparkle(g, cx, cy, (charged ? 3.4 : 2.4) * k, L.hi);
      break;
    case "sun":
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        line(g, [cx + Math.cos(a) * 3 * k, cy + Math.sin(a) * 3 * k], [cx + Math.cos(a) * (charged ? 7 : 5.6) * k, cy + Math.sin(a) * (charged ? 7 : 5.6) * k], 1.2, i % 2 ? m.lo : m.base);
      }
      lit(g, () => g.ellipse(cx, cy, 3.2 * k, 3.2 * k, 0, 0, Math.PI * 2), { ...L, base: charged ? L.hi : L.base }, { shadow: [-0.6, 0.6] });
      circle(g, cx - 0.8, cy - 0.8, 0.9, "#ffffff", 0);
      break;
    case "star":
      g.beginPath();
      g.arc(cx, cy, 4.2 * k, 0, Math.PI * 2);
      g.strokeStyle = OL;
      g.lineWidth = 2.6;
      g.stroke();
      g.strokeStyle = m.base;
      g.lineWidth = 1.2;
      g.stroke();
      lit(g, () => sub(g, [[cx, cy - 6.4 * k], [cx + 1.3 * k, cy - 1.3 * k], [cx + 6 * k, cy], [cx + 1.3 * k, cy + 1.3 * k], [cx, cy + 6 * k], [cx - 1.3 * k, cy + 1.3 * k], [cx - 6 * k, cy], [cx - 1.3 * k, cy - 1.3 * k]]), { ...L, base: charged ? L.hi : L.base }, { shadow: [-0.4, 0.4] });
      break;
    case "ankh":
      cord(g, () => {
        g.beginPath();
        g.ellipse(cx, cy - 2.4 * k, 2.2 * k, 3 * k, 0, 0, Math.PI * 2);
      }, 1.6, m.base);
      rrect(g, -4.4 * k, cy + 0.4 * k, 8.8 * k, 1.8, 0.6, m.base, 0.8);
      if (charged) rays(8, 5.6 * k, 8 * k, L.hi, 0.8);
      gem(g, cx, cy + 1.3 * k, 1.2, L);
      break;
    case "cross":
      lit(g, () => sub(g, [[-1.2 * k, cy - 6 * k], [1.2 * k, cy - 6 * k], [1.2 * k, cy - 2.4 * k], [4.6 * k, cy - 2.4 * k], [4.6 * k, cy], [1.2 * k, cy], [1.2 * k, cy + 4 * k], [-1.2 * k, cy + 4 * k], [-1.2 * k, cy], [-4.6 * k, cy], [-4.6 * k, cy - 2.4 * k], [-1.2 * k, cy - 2.4 * k]]), m, { shadow: [-0.6, 0.6] });
      gem(g, cx, cy - 1.2 * k, 1.3, s.gem ?? M.ruby);
      if (charged) rays(8, 6.4 * k, 8.6 * k, L.hi, 0.8);
      break;
    case "lantern":
      line(g, [0, cy - 6 * k], [0, cy - 3.6 * k], 0.8, m.base);
      lit(g, () => sub(g, [[-3 * k, cy - 3.6 * k], [3 * k, cy - 3.6 * k], [3.6 * k, cy + 3 * k], [-3.6 * k, cy + 3 * k]]), m, { shadow: [-0.6, 0.6] });
      rrect(g, -2 * k, cy - 2.2 * k, 4 * k, 4.4 * k, 0.6, charged ? L.hi : L.base, 0);
      break;
    case "wings":
      for (const sg of [-1, 1]) lit(g, () => sub(g, [[sg * 1, cy + 2 * k], [sg * 5 * k, cy - 2 * k], [sg * 7.6 * k, cy - 7 * k], [sg * 4 * k, cy - 4.4 * k], [sg * 4.6 * k, cy - 6.4 * k], [sg * 1.6 * k, cy - 2 * k]]), m, { shadow: [0.4, 0.4] });
      gem(g, cx, cy - 1.4 * k, 2 * k, charged ? { ...L, base: L.hi } : L);
      break;
    case "dove":
      lit(g, () => {
        g.ellipse(cx, cy, 3 * k, 2 * k, 0, 0, Math.PI * 2);
        g.moveTo(cx - 1, cy - 1);
        g.lineTo(cx - 6 * k, cy - 5 * k);
        g.lineTo(cx - 2, cy + 1);
      }, M.white, { shadow: [-0.4, 0.4] });
      if (charged) rays(8, 4.6 * k, 7 * k, L.hi, 0.8);
      break;
    case "flame":
      cord(g, () => {
        g.beginPath();
        g.arc(cx, cy + 1 * k, 3.6 * k, Math.PI * 0.1, Math.PI * 0.9);
      }, 1.4, m.base);
      lit(g, () => {
        g.moveTo(cx - 2.6 * k, cy + 1.6 * k);
        g.quadraticCurveTo(cx - 3.2 * k, cy - 3 * k, cx + 0.4 * k, cy - (charged ? 8 : 6.4) * k);
        g.quadraticCurveTo(cx + 0.4 * k, cy - 2.6 * k, cx + 2.6 * k, cy + 1.6 * k);
        g.closePath();
      }, { ...L, base: charged ? L.hi : L.base }, { shadow: [-0.4, 0.6] });
      break;
  }
  if (s.gem && s.head !== "cross") gem(g, cx, cy + 4.6 * k, 1.1, s.gem);
}

/** A hafted weapon as the archetype carries it: a sentinel's long-hafted mace, a battlemage's short staff, a monk's tall sun-staff. */
export function sizedHaft(s: HaftSpec, j: Joints): HaftSpec {
  const k = weaponScale(j);
  if (k.len === 1 && k.w === 1 && !k.below) return s;
  return { ...s, len: s.len * k.len, below: Math.max((s.below ?? 4.6) * Math.max(1, k.len * 0.9), k.below ?? 0), size: (s.size ?? 1) * k.w };
}

/** One hafted weapon in the FRONT hand. */
export function haft(s: HaftSpec): Piece[] {
  return [
    piece(70, s.shaft, (g, p, j) => inWeaponSpace(g, j.handF, j, () => {
      const t = sizedHaft(s, j);
      shaftDraw(g, t);
      headDraw(g, t, p);
    })),
  ];
}

/** The head's centre in frame pixels (a staff's / scepter's muzzle on the cast frame). */
export const haftMuzzle = (s: HaftSpec) => (j: Joints): Pt => {
  const [x, y] = headCentre(sizedHaft(s, j));
  return weaponPoint(j, x, y);
};
