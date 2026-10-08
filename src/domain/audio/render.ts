import { fromDb, loudestRms, makeSynth, peakOf, SAMPLE_RATE, toDb } from "./dsp";
import { SOUNDS, type SoundId } from "./sounds";

/**
 * ARENA AUDIO — a finished sound: rendered from its recipe, cleaned (no DC, short fades at both edges), set to a common loudness (every effect is
 * brought to the same −16 dBFS over its loudest 120 ms, then moved by its own `trimDb`) and limited so that nothing leaves here above 0.95.
 *
 * Deterministic: the same id renders the same samples on every machine, in the browser and in Node. The browser renders each sound once, lazily,
 * and keeps the result as an AudioBuffer.
 */

/** The loudness every sound is normalised to before its own trim, in dBFS (RMS of its loudest 120 ms). The master gain and the limiter bring the whole mix down from here. */
export const REFERENCE_DB = -16;
/** Nothing rendered here is louder than this (linear). */
export const CEILING = 0.95;

/** A smooth knee: linear up to 0.6, then tanh-saturating toward the ceiling (no hard clipping edge). */
export function softLimit(buf: Float32Array, ceiling = CEILING): Float32Array {
  const knee = 0.6;
  const room = ceiling - knee;
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i] as number;
    const a = Math.abs(x);
    out[i] = a <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((a - knee) / room));
  }
  return out;
}

function clean(buf: Float32Array, sr: number): Float32Array {
  const out = Float32Array.from(buf);
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i] as number;
  mean /= Math.max(1, out.length);
  const fi = Math.max(1, Math.round(0.0015 * sr));
  const fo = Math.max(1, Math.round(0.012 * sr));
  for (let i = 0; i < out.length; i++) {
    let g = 1;
    if (i < fi) g = i / fi;
    const fromEnd = out.length - 1 - i;
    if (fromEnd < fo) g = Math.min(g, fromEnd / fo);
    out[i] = ((out[i] as number) - mean) * g;
  }
  return out;
}

const cache = new Map<string, Float32Array>();

/** The finished samples of a sound. `sr` defaults to SAMPLE_RATE. The result is shared — never mutate it. */
export function renderSound(id: SoundId, sr = SAMPLE_RATE): Float32Array {
  const key = `${id}@${sr}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const def = SOUNDS[id];
  if (!def) throw new Error(`unknown sound ${id}`);
  const raw = clean(def.render(makeSynth(sr, id)), sr);
  const rms = loudestRms(raw, sr, 0.12);
  const gain = rms > 0 ? fromDb(REFERENCE_DB + def.trimDb) / rms : 0;
  const scaled = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) scaled[i] = (raw[i] as number) * gain;
  // a very spiky sound (a click) would clip long before it reached its loudness: take it down so its peak lands on the ceiling's knee instead of
  // being squashed flat by the limiter
  const peak = peakOf(scaled);
  const tamed = peak > 1.6 ? scaled.map((v) => (v * 1.6) / peak) : scaled;
  const out = softLimit(tamed);
  cache.set(key, out);
  return out;
}

export interface SoundMetrics {
  id: SoundId;
  seconds: number;
  peak: number;
  rmsDb: number;
}

export function metricsOf(id: SoundId, sr = SAMPLE_RATE): SoundMetrics {
  const pcm = renderSound(id, sr);
  return { id, seconds: pcm.length / sr, peak: peakOf(pcm), rmsDb: toDb(loudestRms(pcm, sr, 0.12)) };
}
