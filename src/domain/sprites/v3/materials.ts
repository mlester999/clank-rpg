import { adjust, hex, outlineOf, ramp, type RampOpts, type RGB } from "./color";
import type { Material, MaterialKind } from "./gbuffer";

/** HERO RENDERER v3 — materials: a ramp + how it reacts to light + its outline colour. */

const KIND_RAMP: Partial<Record<MaterialKind, RampOpts>> = {
  skin: { dark: 0.1, light: 0.07, shift: 18, shadowChroma: 1.15, lightChroma: 0.9 },
  hair: { dark: 0.12, light: 0.1, shift: 12 },
  cloth: { dark: 0.12, light: 0.085, shift: 14 },
  leather: { dark: 0.11, light: 0.08, shift: 10 },
  wood: { dark: 0.11, light: 0.08, shift: 8 },
  metal: { dark: 0.16, light: 0.13, shift: 10, spec: 0.12, lightChroma: 0.6 },
  gem: { dark: 0.15, light: 0.14, shift: 6, spec: 0.16 },
  glow: { dark: 0.12, light: 0.12, shift: 4, spec: 0.12 },
  matte: { dark: 0.12, light: 0.09, shift: 12 },
  flat: { dark: 0.1, light: 0.08 },
};

export function material(base: RGB | string, kind: MaterialKind, o: RampOpts = {}): Material {
  const c = typeof base === "string" ? hex(base) : base;
  const r = ramp(c, { ...KIND_RAMP[kind], ...o });
  return { ramp: r, kind, outline: outlineOf(r, kind === "glow" ? 0.45 : 0.62) };
}

/** Real-colour materials shared by every hero. */
export const MAT = {
  steel: material("#aab4c4", "metal"),
  iron: material("#7d8592", "metal"),
  bronze: material("#b8813f", "metal"),
  blackIron: material("#545a68", "metal"),
  silver: material("#cdd3de", "metal"),
  gold: material("#e2a83a", "metal", { light: 0.12 }),
  paleGold: material("#efd27a", "metal"),
  leather: material("#7a563a", "leather"),
  darkLeather: material("#4c3a2d", "leather"),
  paleLeather: material("#a87e55", "leather"),
  wood: material("#8a6340", "wood"),
  darkWood: material("#5a4130", "wood"),
  paleWood: material("#c9a46c", "wood"),
  bone: material("#e6dcc2", "matte"),
  string: material("#e8e2d0", "flat"),
  cloth: material("#d9d2bf", "cloth"),
  paper: material("#efe2c4", "cloth"),
  white: material("#e9edf3", "cloth"),
  dark: material("#3a3c4a", "cloth"),
  fur: material("#d4c4ad", "hair"),
  darkFur: material("#6e5a48", "hair"),
  feather: material("#e9e3d3", "cloth"),
  redFeather: material("#c0443a", "cloth"),
  ruby: material("#d93b52", "gem"),
  sapphire: material("#3f84f0", "gem"),
  emerald: material("#33c272", "gem"),
  amethyst: material("#a35cf0", "gem"),
  topaz: material("#f0b43a", "gem"),
  arcane: material("#9f86ff", "glow"),
  frost: material("#86dcff", "glow"),
  holy: material("#ffe28a", "glow"),
  fel: material("#8fe063", "glow"),
  ember: material("#ff9a3c", "glow"),
  eyeWhite: material("#f2efe8", "flat"),
  shadow: material("#1d1a26", "flat"),
} as const;

/** A darker, desaturated variant of a colour (a cloth's lining, an inner robe). */
export const deeper = (c: RGB, dL = -0.12): RGB => adjust(c, dL, 0.9);
