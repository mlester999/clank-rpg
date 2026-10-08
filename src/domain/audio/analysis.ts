/**
 * ARENA AUDIO — measuring sound: an FFT, spectrograms, the spectral centroid and a coarse "fingerprint" (energy per band per time slice).
 * Used by the tests (every sound must be audible, bright / dark where it should be, and different from every other sound) and by the review sheets.
 * Not shipped to players: nothing in the Arena imports this.
 */

const TAU = Math.PI * 2;

/** In-place radix-2 FFT. `re` / `im` have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-TAU) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = (re[b] as number) * cr - (im[b] as number) * ci;
        const ti = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Magnitude spectrogram: `frames × (size / 2)` (Hann window). */
export function spectrogram(buf: Float32Array, size = 512, hop = 256): Float32Array[] {
  const out: Float32Array[] = [];
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((TAU * i) / (size - 1));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let start = 0; start === 0 || start + size <= buf.length; start += hop) {
    for (let i = 0; i < size; i++) {
      re[i] = (start + i < buf.length ? (buf[start + i] as number) : 0) * (win[i] as number);
      im[i] = 0;
    }
    fft(re, im);
    const mags = new Float32Array(size / 2);
    for (let k = 0; k < size / 2; k++) mags[k] = Math.hypot(re[k] as number, im[k] as number);
    out.push(mags);
  }
  return out;
}

/** Where the energy is, on average (Hz): low = dark / heavy, high = bright / sharp. */
export function spectralCentroid(buf: Float32Array, sr: number, size = 512): number {
  let num = 0;
  let den = 0;
  for (const f of spectrogram(buf, size, size / 2)) {
    for (let k = 1; k < f.length; k++) {
      const m = f[k] as number;
      num += m * ((k * sr) / size);
      den += m;
    }
  }
  return den > 0 ? num / den : 0;
}

/**
 * A coarse picture of a sound — log energy in `bands` log-spaced bands over `slices` equal time slices — for comparing two sounds: two sounds that
 * are really the same have a near-zero distance. Normalised so a sound's loudness does not matter, only its shape.
 */
export function fingerprint(buf: Float32Array, sr: number, bands = 10, slices = 8): Float32Array {
  const size = 512;
  const frames = spectrogram(buf, size, 256);
  const out = new Float32Array(bands * slices);
  const edges: number[] = [];
  for (let b = 0; b <= bands; b++) edges.push(Math.round(Math.pow(size / 2 / 2, b / bands) * 2));
  for (let sl = 0; sl < slices; sl++) {
    const f0 = Math.floor((sl * frames.length) / slices);
    const f1 = Math.max(f0 + 1, Math.floor(((sl + 1) * frames.length) / slices));
    for (let b = 0; b < bands; b++) {
      let e = 0;
      for (let f = f0; f < f1 && f < frames.length; f++) for (let k = edges[b] as number; k < (edges[b + 1] as number) && k < size / 2; k++) e += ((frames[f] as Float32Array)[k] as number) ** 2;
      out[sl * bands + b] = 10 * Math.log10(e + 1e-6);
    }
  }
  const mean = out.reduce((a, v) => a + v, 0) / out.length;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) - mean;
  return out;
}

/** Root-mean-square distance between two fingerprints, in dB. */
export function fingerprintDistance(a: Float32Array, b: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += ((a[i] as number) - (b[i] as number)) ** 2;
  return Math.sqrt(acc / a.length);
}
