export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** 1 - e^(-x/k): smooth saturation into [0, 1). Concave, strictly increasing, never reaches 1. */
export const saturate = (x: number, k: number): number => (x <= 0 ? 0 : 1 - Math.exp(-x / k));

export const round2 = (n: number): number => Math.round(n * 100) / 100;
