import { circle, cord, ellipse, gem, line, lit, local, M, poly, rrect, sub, torso, type Ctx, type Joints, type Pose, type Ramp } from "./kit";
import { piece, type Mat, type Piece } from "./library";

/**
 * HERO RENDERER v2 — GEAR: the small things a hero carries that change the outline (a shield slung on the back, a bedroll, a quiver) or add a
 * readable detail at the belt (a horn, a hand axe, a pouch, a book). Each class has its own pool (the class accessory sub-slot), chosen per
 * hero independently of its armour and weapon. Torso space; back items at z 6–7 (behind the body), belt items at z 23.
 */

/** A scabbard at the back hip, on a strap. */
export function scabbard(mat: Ramp = M.leather, fit: Ramp = M.gold, len = 12.6): Piece {
  return piece(7, mat, (g, _p, j, r) => torso(g, j, () => {
    local(g, [-3.6, -3], 0.72, () => {
      rrect(g, -1.7, 0, 3.4, len, 1.2, r.base, 1);
      line(g, [-0.8, 2.4], [-0.8, len - 1.6], 0.6, r.hi);
      rrect(g, -2.1, -0.4, 4.2, 2.4, 0.6, fit.base, 0.8);
      poly(g, [[-1.7, len - 2], [1.7, len - 2], [1.2, len + 0.8], [0, len + 1.6], [-1.2, len + 0.8]], fit.base, 0.8);
    });
  }));
}

/** A round shield slung on the back: its painted face (in `face`) and its rim + boss (in `metal`). */
export function backShield(face: Mat, metal: Mat, r0 = 6.8): Piece[] {
  const at = (fn: (g: Ctx, r: Ramp) => void) => (g: Ctx, _p: Pose, j: Joints, r: Ramp) => torso(g, j, () => local(g, [-6.6, -9.4], -0.25, () => fn(g, r)));
  return [
    piece(6, face, at((g, r) => {
      lit(g, () => g.ellipse(0, 0, r0 * 0.62, r0, 0, 0, Math.PI * 2), r, { shadow: [1.2, -0.6] });
      line(g, [0, -r0 + 1], [0, r0 - 1], 0.8, r.lo);
    })),
    piece(6, metal, at((g, r) => {
      g.beginPath();
      g.ellipse(0, 0, r0 * 0.62, r0, 0, 0, Math.PI * 2);
      g.strokeStyle = "#15151a";
      g.lineWidth = 2.2;
      g.stroke();
      g.strokeStyle = r.base;
      g.lineWidth = 1.1;
      g.stroke();
      ellipse(g, 0.6, 0, 1.8, 2.4, r.base, 0.8);
      circle(g, 0.3, -0.6, 0.6, r.hi, 0);
    })),
  ];
}

/** A war horn hanging at the hip on a cord. */
export function horn(mat: Ramp = M.bone, band: Ramp = M.bronze): Piece {
  return piece(23, mat, (g, _p, j, r) => torso(g, j, () => {
    cord(g, () => {
      g.beginPath();
      g.moveTo(-5.4, -4.4);
      g.quadraticCurveTo(-7.6, 0.6, -4.6, 3.4);
    }, 0.6, M.leather.lo, 0.8);
    lit(g, () => {
      g.moveTo(-7.4, -0.8);
      g.quadraticCurveTo(-6.4, 4.6, -1.6, 4.6);
      g.lineTo(-1.4, 2.8);
      g.quadraticCurveTo(-5, 2.8, -5.6, -0.4);
      g.closePath();
    }, r, { shadow: [0.6, -0.6] });
    rrect(g, -7.8, -1.6, 2.6, 1.4, 0.4, band.base, 0.6);
  }));
}

/** A belt pouch (and a knife beside it). */
export function pouch(mat: Ramp = M.leather, knife = true): Piece {
  return piece(23, mat, (g, _p, j, r) => torso(g, j, () => {
    if (knife) {
      rrect(g, 4.6, -3, 1.6, 6, 0.6, M.darkLeather.base, 0.8);
      rrect(g, 4.8, -5.4, 1.2, 2.6, 0.4, M.wood.base, 0.6);
    }
    rrect(g, -7.2, -2.6, 4.6, 4.4, 1.2, r.base, 0.9);
    rrect(g, -7.2, -2.6, 4.6, 1.8, 0.8, r.hi, 0.7);
    circle(g, -4.9, -0.8, 0.5, M.bronze.base, 0);
  }));
}

/** A hand axe tucked through the belt at the back hip. */
export function handAxe(head: Ramp = M.iron, haft: Ramp = M.wood): Piece {
  return piece(23, head, (g, _p, j, r) => torso(g, j, () => local(g, [-6, -4], 0.5, () => {
    rrect(g, -0.7, -2, 1.4, 10, 0.5, haft.base, 0.7);
    lit(g, () => sub(g, [[0.6, -1.4], [4.4, -3.6], [5, 0.6], [4.2, 3.4], [0.6, 1.2]]), r, { shadow: [0.6, -0.6] });
  })));
}

/** A rolled bedroll strapped across the small of the back. */
export function bedroll(mat: Mat, strap: Ramp = M.leather): Piece[] {
  return [
    piece(6, mat, (g, _p, j, r) => torso(g, j, () => {
      lit(g, () => g.ellipse(-6.6, -2, 3, 5.4, 0.2, 0, Math.PI * 2), r, { shadow: [1, -0.6] });
      ellipse(g, -6.4, -6.6, 2.4, 1.2, r.hi, 0.7, undefined, 0.2);
    })),
    piece(6, strap, (g, _p, j, r) => torso(g, j, () => {
      for (const y of [-4.6, 0.6]) rrect(g, -9.6, y, 6, 1.1, 0.4, r.base, 0.6);
    })),
  ];
}

/** A small backpack / satchel on the back. */
export function satchel(mat: Ramp = M.leather): Piece {
  return piece(6, mat, (g, _p, j, r) => torso(g, j, () => {
    lit(g, () => sub(g, [[-10.4, -11], [-5, -11.6], [-4.6, -2.4], [-10.8, -2]]), r, { shadow: [1, -0.6] });
    rrect(g, -10.6, -11.8, 6, 3, 1, r.hi, 0.8);
    circle(g, -7.6, -8.6, 0.6, M.bronze.base, 0);
  }));
}

/** A book hanging at the hip on a chain (casters). */
export function hipBook(cover: Mat, fit: Ramp = M.gold): Piece[] {
  return [
    piece(23, cover, (g, _p, j, r) => torso(g, j, () => {
      rrect(g, 3.4, -3.4, 5.4, 6.8, 0.9, r.base, 0.9);
      rrect(g, 3.4, -3.4, 1.2, 6.8, 0.4, r.lo, 0);
    })),
    piece(23, fit, (g, _p, j, r) => torso(g, j, () => {
      rrect(g, 4.6, -2.6, 3.4, 5.2, 0.5, M.paper.base, 0.5);
      line(g, [3, -4.2], [-1.6, -6.6], 0.7, r.base);
      gem(g, 6.4, 0, 0.9, M.sapphire);
    })),
  ];
}

/** Potion vials on a belt (casters, rogues). */
export function vials(colors: readonly Ramp[] = [M.ruby, M.sapphire, M.emerald]): Piece {
  return piece(23, M.paper, (g, _p, j) => torso(g, j, () => {
    colors.forEach((c, i) => {
      const x = -6.6 + i * 2.6;
      rrect(g, x - 0.9, -3.2, 1.8, 3.6, 0.8, c.base, 0.7);
      rrect(g, x - 0.5, -4.4, 1, 1.4, 0.3, M.wood.base, 0.5);
      circle(g, x - 0.3, -2, 0.4, c.hi, 0);
    });
  }));
}

/** A scroll case on the back. */
export function scrollCase(mat: Ramp = M.leather, cap: Ramp = M.bronze): Piece {
  return piece(6, mat, (g, _p, j, r) => torso(g, j, () => local(g, [-6, -8], -0.5, () => {
    rrect(g, -1.6, -6, 3.2, 14, 1.2, r.base, 0.9);
    rrect(g, -1.9, -7, 3.8, 2, 0.6, cap.base, 0.7);
    rrect(g, -1.9, 7, 3.8, 1.8, 0.6, cap.base, 0.7);
  })));
}

/** Throwing knives in a chest bandolier (rogues). */
export function knifeBandolier(strap: Ramp = M.darkLeather, blade: Ramp = M.steel): Piece {
  return piece(23, strap, (g, _p, j, r) => torso(g, j, () => {
    local(g, [-5.4, -13.4], 0.82, () => {
      rrect(g, 0, -1, 15.4, 2, 0.6, r.base, 0.8);
      for (let i = 0; i < 4; i++) {
        const x = 3 + i * 3;
        poly(g, [[x - 0.6, -1], [x + 0.6, -1], [x + 0.2, -4.6], [x - 0.2, -4.6]], blade.base, 0.5);
      }
    });
  }));
}

/** A lantern / censer hanging at the hip on a chain (clerics). */
export function censer(metal: Ramp = M.bronze, light: Ramp = M.holy): Piece[] {
  return [
    piece(23, metal, (g, p, j, r) => torso(g, j, () => {
      const sw = p.capeSway * 0.3;
      line(g, [5.6, -4.4], [6.2 + sw * 0.3, 1.6], 0.6, r.lo);
      rrect(g, 4.2 + sw * 0.3, 1.4, 4, 4.4, 1.2, r.base, 0.9);
      poly(g, [[4.4 + sw * 0.3, 1.6], [6.2 + sw * 0.3, -0.4], [8 + sw * 0.3, 1.6]], r.hi, 0.6);
    })),
    piece(23, light, (g, p, j, r) => torso(g, j, () => {
      const sw = p.capeSway * 0.3;
      rrect(g, 5.2 + sw * 0.3, 2.6, 2, 2, 0.6, r.hi, 0);
    })),
  ];
}
