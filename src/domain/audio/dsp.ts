/**
 * ARENA AUDIO — the small DSP toolkit every Clank RPG sound effect is built from.
 *
 * Pure number crunching (Float32Array in, Float32Array out): no DOM, no Web Audio, no randomness that is not seeded. The same code renders a sound in
 * the browser (once, on first use — then it is an AudioBuffer in a cache) and in Node (tests that measure the actual samples, the WAV export, the
 * spectrogram review sheets). What a test measures is exactly what a player hears.
 *
 * Sound identity: retro-RPG — pulse / triangle / noise voices, short envelopes, hard-edged attacks, a little saturation. Everything is original.
 */

export const SAMPLE_RATE = 32_000;

/** A small, fast, seedable PRNG (mulberry32) — a sound renders identically every time. */
export function rngFor(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^ (h >>> 16)) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Wave = "sine" | "square" | "saw" | "tri";
export type Freq = number | ((t: number) => number);
export type Env = (t: number) => number;

const TAU = Math.PI * 2;
const freqAt = (f: Freq, t: number): number => (typeof f === "number" ? f : f(t));

/** polyBLEP residual: removes most of the aliasing of a naive saw / square edge. */
function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Note names → Hz (A4 = 440). `note("C5")`. */
export function note(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const semis = (base[m[1] as string] as number) + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) - 4) * 12 - 9;
  return 440 * Math.pow(2, semis / 12);
}

/** The synthesiser, bound to a sample rate and a seed (noise is deterministic per sound). */
export function makeSynth(sr: number, seed: string) {
  const rng = rngFor(seed);
  const len = (sec: number): number => Math.max(1, Math.round(sec * sr));
  const zeros = (sec: number): Float32Array => new Float32Array(len(sec));

  /** One oscillator. `f` may glide (a function of time in seconds). */
  function osc(wave: Wave, dur: number, f: Freq, o: { pw?: number; phase?: number; vib?: [rate: number, semis: number] } = {}): Float32Array {
    const n = len(dur);
    const out = new Float32Array(n);
    let ph = o.phase ?? 0;
    const pw = o.pw ?? 0.5;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let hz = freqAt(f, t);
      if (o.vib) hz *= Math.pow(2, (Math.sin(TAU * o.vib[0] * t) * o.vib[1]) / 12);
      const dt = Math.min(0.45, hz / sr);
      let v: number;
      switch (wave) {
        case "sine":
          v = Math.sin(TAU * ph);
          break;
        case "saw":
          v = 2 * ph - 1 - blep(ph, dt);
          break;
        case "square":
          v = (ph < pw ? 1 : -1) + blep(ph, dt) - blep((ph + 1 - pw) % 1, dt);
          break;
        default:
          v = 4 * Math.abs(ph - 0.5) - 1;
      }
      out[i] = v;
      ph += dt;
      if (ph >= 1) ph -= 1;
    }
    return out;
  }

  /** White noise. */
  function noise(dur: number): Float32Array {
    const out = new Float32Array(len(dur));
    for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
    return out;
  }

  /** Brown-ish (low-weighted) noise: a rumble. */
  function rumble(dur: number): Float32Array {
    const out = new Float32Array(len(dur));
    let acc = 0;
    for (let i = 0; i < out.length; i++) {
      acc = acc * 0.985 + (rng() * 2 - 1) * 0.12;
      out[i] = acc;
    }
    return normalize(out, 0.9);
  }

  /** A plucked string (Karplus–Strong) — a bowstring, a harp, a lute. `decay` ≈ 0.99–0.999; `bright` 0–1 (the initial burst's colour). */
  function pluck(dur: number, hz: number, decay = 0.996, bright = 0.7): Float32Array {
    const n = len(dur);
    const out = new Float32Array(n);
    const period = Math.max(2, Math.round(sr / hz));
    const line = new Float32Array(period);
    let prev = 0;
    for (let i = 0; i < period; i++) {
      const r = rng() * 2 - 1;
      prev = prev * (1 - bright) + r * bright;
      line[i] = prev;
    }
    let p = 0;
    for (let i = 0; i < n; i++) {
      const a = line[p] as number;
      const b = line[(p + 1) % period] as number;
      out[i] = a;
      line[p] = (a + b) * 0.5 * decay;
      p = (p + 1) % period;
    }
    return out;
  }

  /** Multiplies by an envelope function of time. */
  function shape(buf: Float32Array, env: Env): Float32Array {
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = (buf[i] as number) * env(i / sr);
    return out;
  }

  /** RBJ biquad (low / high / band pass, notch, peak). `f` and `q` may move (recomputed every 16 samples). */
  function filter(buf: Float32Array, type: "lp" | "hp" | "bp" | "notch", f: Freq, q: number | ((t: number) => number) = 0.8): Float32Array {
    const out = new Float32Array(buf.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    for (let i = 0; i < buf.length; i++) {
      if ((i & 15) === 0) {
        const t = i / sr;
        const fc = Math.min(sr * 0.45, Math.max(20, freqAt(f, t)));
        const qq = Math.max(0.2, typeof q === "number" ? q : q(t));
        const w0 = (TAU * fc) / sr;
        const cos = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * qq);
        const a0 = 1 + alpha;
        if (type === "lp") {
          b0 = (1 - cos) / 2 / a0; b1 = (1 - cos) / a0; b2 = b0;
        } else if (type === "hp") {
          b0 = (1 + cos) / 2 / a0; b1 = -(1 + cos) / a0; b2 = b0;
        } else if (type === "bp") {
          b0 = alpha / a0; b1 = 0; b2 = -alpha / a0;
        } else {
          b0 = 1 / a0; b1 = (-2 * cos) / a0; b2 = b0;
        }
        a1 = (-2 * cos) / a0;
        a2 = (1 - alpha) / a0;
      }
      const x0 = buf[i] as number;
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y0;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return out;
  }

  /** Sums buffers placed at offsets (seconds) with gains; the result is as long as the last one ends (or `dur`). */
  function mix(parts: Array<{ buf: Float32Array; at?: number; gain?: number }>, dur?: number): Float32Array {
    let end = 0;
    for (const p of parts) end = Math.max(end, Math.round((p.at ?? 0) * sr) + p.buf.length);
    const out = new Float32Array(dur !== undefined ? len(dur) : end);
    for (const p of parts) {
      const o = Math.round((p.at ?? 0) * sr);
      const g = p.gain ?? 1;
      for (let i = 0; i < p.buf.length && o + i < out.length; i++) out[o + i] = (out[o + i] as number) + (p.buf[i] as number) * g;
    }
    return out;
  }

  /** A feedback echo (shimmer, a hall's first reflections). `wet` scales the echoes only; the result is `tail` seconds longer. */
  function echo(buf: Float32Array, delay: number, feedback: number, wet: number, tail = 0.25): Float32Array {
    const d = Math.max(1, Math.round(delay * sr));
    const n = buf.length + len(tail);
    const y = new Float32Array(n);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i < buf.length ? (buf[i] as number) : 0;
      y[i] = x + (i >= d ? (y[i - d] as number) * feedback : 0);
      out[i] = x + wet * ((y[i] as number) - x);
    }
    return out;
  }

  /** Soft saturation (tanh), normalised so a full-scale input stays full-scale. */
  function saturate(buf: Float32Array, drive: number): Float32Array {
    const k = Math.tanh(drive);
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = Math.tanh((buf[i] as number) * drive) / k;
    return out;
  }

  /** Sample-rate / bit-depth reduction: the crunchy retro edge. */
  function crush(buf: Float32Array, bits: number, hold: number): Float32Array {
    const out = new Float32Array(buf.length);
    const q = Math.pow(2, bits - 1);
    let held = 0;
    for (let i = 0; i < buf.length; i++) {
      if (i % hold === 0) held = Math.round((buf[i] as number) * q) / q;
      out[i] = held;
    }
    return out;
  }

  function normalize(buf: Float32Array, peak = 0.95): Float32Array {
    let m = 0;
    for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i] as number));
    if (m === 0) return buf;
    const g = peak / m;
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = (buf[i] as number) * g;
    return out;
  }

  /** Reverses a buffer (a swell into an impact). */
  function reverse(buf: Float32Array): Float32Array {
    return Float32Array.from(buf).reverse();
  }

  return { sr, rng, len, zeros, osc, noise, rumble, pluck, shape, filter, mix, echo, saturate, crush, normalize, reverse };
}

export type Synth = ReturnType<typeof makeSynth>;

// ------------------------------------------------------------------------------------------------ envelopes

/** exp(-t/tau) — a struck / plucked decay. */
export const decay = (tau: number): Env => (t) => Math.exp(-t / tau);

/** Linear attack to 1 over `a`, then an exponential decay with time constant `tau`. */
export const hit = (a: number, tau: number): Env => (t) => (t < a ? t / a : Math.exp(-(t - a) / tau));

/** Attack – hold – release envelope over a known duration. */
export const swell = (a: number, dur: number, r: number): Env => (t) => Math.min(1, t / a) * Math.min(1, Math.max(0, (dur - t) / r));

/** Rise to 1 at `peak` seconds, then fall to 0 at `dur` (a whoosh's body). */
export const bell = (peak: number, dur: number): Env => (t) => (t < peak ? Math.pow(t / peak, 1.6) : Math.pow(Math.max(0, 1 - (t - peak) / (dur - peak)), 1.8));

/** Exponential glide between two frequencies over `dur`. */
export const glide = (f0: number, f1: number, dur: number, curve = 1): ((t: number) => number) => (t) => f0 * Math.pow(f1 / f0, Math.pow(Math.min(1, t / dur), curve));

// ------------------------------------------------------------------------------------------------ analysis (used by the renderer's loudness and by the tests)

export function peakOf(buf: Float32Array): number {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i] as number));
  return m;
}

/** RMS of the loudest window of `windowSec` (the way a short effect is perceived, not diluted by its silence). */
export function loudestRms(buf: Float32Array, sr: number, windowSec = 0.15): number {
  const w = Math.max(1, Math.min(buf.length, Math.round(windowSec * sr)));
  let acc = 0;
  for (let i = 0; i < w; i++) acc += (buf[i] as number) ** 2;
  let best = acc;
  for (let i = w; i < buf.length; i++) {
    acc += (buf[i] as number) ** 2 - (buf[i - w] as number) ** 2;
    if (acc > best) best = acc;
  }
  return Math.sqrt(Math.max(0, best) / w);
}

export const toDb = (x: number): number => 20 * Math.log10(Math.max(1e-9, x));
export const fromDb = (db: number): number => Math.pow(10, db / 20);

/** A 16-bit PCM mono WAV file. */
export function wavBytes(pcm: Float32Array, sr: number): Uint8Array {
  const n = pcm.length;
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round((pcm[i] as number) * 32767))), true);
  return out;
}
