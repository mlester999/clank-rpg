/**
 * Renders the Arena sound effects through the REAL synthesis code (src/domain/audio — the same code the browser runs) so they can be reviewed:
 *
 *   pnpm audio:preview -- --out .data/audio            WAV files, a spectrogram contact sheet (sheet.png) and metrics.json
 *   pnpm audio:preview -- --out .data/audio --only sword_hit,fight
 *
 * The sheet draws every sound as a spectrogram (time → right, frequency ↑ on a log scale, brightness = energy) with its name, length and level, so
 * a broken sound (silence, a click, a flat line, the wrong register) is visible at a glance. The WAVs are 16-bit mono at the Arena's sample rate.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas } from "@napi-rs/canvas";

import { spectrogram, spectralCentroid } from "../src/domain/audio/analysis";
import { loudestRms, peakOf, SAMPLE_RATE, toDb, wavBytes } from "../src/domain/audio/dsp";
import { renderSound } from "../src/domain/audio/render";
import { SOUND_IDS, SOUNDS, type SoundId } from "../src/domain/audio/sounds";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const out = path.resolve(arg("out") ?? ".data/audio");
  const only = arg("only")?.split(",") as SoundId[] | undefined;
  const ids = only ?? [...SOUND_IDS];
  await mkdir(path.join(out, "wav"), { recursive: true });

  const cell = { w: 300, h: 150, pad: 6, head: 18 };
  const cols = 5;
  const rows = Math.ceil(ids.length / cols);
  const sheet = createCanvas(cols * (cell.w + cell.pad) + cell.pad, rows * (cell.h + cell.head + cell.pad) + cell.pad);
  const g = sheet.getContext("2d");
  g.fillStyle = "#0b0e14";
  g.fillRect(0, 0, sheet.width, sheet.height);
  const metrics: Record<string, unknown> = {};
  let total = 0;

  ids.forEach((id, n) => {
    const pcm = renderSound(id);
    const sec = pcm.length / SAMPLE_RATE;
    total += sec;
    metrics[id] = { seconds: +sec.toFixed(3), peak: +peakOf(pcm).toFixed(3), loudestRmsDb: +toDb(loudestRms(pcm, SAMPLE_RATE, 0.12)).toFixed(1), centroidHz: Math.round(spectralCentroid(pcm, SAMPLE_RATE)), priority: SOUNDS[id].priority };
    void writeFile(path.join(out, "wav", `${id}.wav`), wavBytes(pcm, SAMPLE_RATE));
    const x0 = cell.pad + (n % cols) * (cell.w + cell.pad);
    const y0 = cell.pad + Math.floor(n / cols) * (cell.h + cell.head + cell.pad);
    g.fillStyle = "#e8edf5";
    g.font = "12px sans-serif";
    g.textBaseline = "top";
    g.fillText(`${id}  ${sec.toFixed(2)} s  ${(metrics[id] as { loudestRmsDb: number }).loudestRmsDb} dB`, x0, y0);
    const frames = spectrogram(pcm, 512, 128);
    const maxFrames = Math.min(frames.length, cell.w);
    g.fillStyle = "#06080c";
    g.fillRect(x0, y0 + cell.head, cell.w, cell.h);
    // time axis scaled so a 1.7 s sound fills the cell and a 0.14 s one is a short strip (their lengths are comparable at a glance)
    const px = cell.w / (1.8 * SAMPLE_RATE / 128);
    for (let f = 0; f < maxFrames; f++) {
      const col = frames[f] as Float32Array;
      for (let y = 0; y < cell.h; y++) {
        const hz = 60 * Math.pow(15000 / 60, 1 - y / cell.h);
        const k = Math.min(col.length - 1, Math.round((hz / (SAMPLE_RATE / 2)) * col.length));
        const db = 20 * Math.log10((col[k] as number) + 1e-6);
        const v = Math.max(0, Math.min(1, (db + 20) / 60));
        if (v < 0.02) continue;
        g.fillStyle = `rgb(${Math.round(255 * Math.pow(v, 0.8))},${Math.round(160 * Math.pow(v, 2))},${Math.round(255 * (1 - v) * v * 2 + 60 * v)})`;
        g.fillRect(x0 + f * px, y0 + cell.head + y, Math.max(1, px + 0.5), 1);
      }
    }
  });
  await writeFile(path.join(out, "sheet.png"), sheet.toBuffer("image/png"));
  await writeFile(path.join(out, "metrics.json"), `${JSON.stringify({ sampleRate: SAMPLE_RATE, sounds: metrics, totalSeconds: +total.toFixed(2) }, null, 2)}\n`);
  console.log(`wrote ${ids.length} sounds (${total.toFixed(1)} s) → ${path.relative(process.cwd(), out)}/{wav/*.wav, sheet.png, metrics.json}`);
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
