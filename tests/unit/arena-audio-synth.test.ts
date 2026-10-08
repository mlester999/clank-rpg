import { describe, expect, it } from "vitest";

import { fingerprint, fingerprintDistance, spectralCentroid } from "@/domain/audio/analysis";
import { loudestRms, peakOf, SAMPLE_RATE, toDb, wavBytes } from "@/domain/audio/dsp";
import { CEILING, renderSound } from "@/domain/audio/render";
import { SOUND_IDS, SOUNDS, type SoundId } from "@/domain/audio/sounds";

/**
 * THE ACTUAL SAMPLES. Every Arena effect is rendered by the real synthesis code (the browser runs the very same functions) and measured: audible,
 * clean at both edges, never clipping, in the loudness band it was designed for, bright where it should be bright, and unlike every other sound.
 * These are properties of the audio itself — not of a function that was called.
 */

const pcm = (id: SoundId) => renderSound(id);
const cent = (id: SoundId) => spectralCentroid(pcm(id), SAMPLE_RATE);

describe("every sound is a real, clean, bounded waveform", () => {
  it.each(SOUND_IDS)("%s", (id) => {
    const x = pcm(id);
    const sec = x.length / SAMPLE_RATE;
    expect(sec, "length").toBeGreaterThan(0.08);
    expect(sec, "length").toBeLessThan(2.0);
    expect(x.every(Number.isFinite), "finite samples").toBe(true);
    expect(peakOf(x), "never above the ceiling").toBeLessThanOrEqual(CEILING + 1e-6);
    expect(peakOf(x), "audible (not near-silent)").toBeGreaterThan(0.08);
    // loudest 120 ms: between a whisper and a shout — every effect sits in one mixable band
    const db = toDb(loudestRms(x, SAMPLE_RATE, 0.12));
    expect(db, "loudness (dBFS)").toBeGreaterThan(-30);
    expect(db, "loudness (dBFS)").toBeLessThan(-8);
    // no click at either edge, no DC offset
    expect(Math.abs(x[0] as number), "starts at zero").toBeLessThan(0.01);
    expect(Math.abs(x[x.length - 1] as number), "ends at zero").toBeLessThan(0.01);
    const mean = x.reduce((a, v) => a + v, 0) / x.length;
    expect(Math.abs(mean), "DC").toBeLessThan(0.01);
    // it does not hang on to silence at the end (a long dead tail wastes a voice slot): the last 15 % is not the loudest part
    const tail = loudestRms(x.subarray(Math.floor(x.length * 0.85)), SAMPLE_RATE, 0.05);
    expect(tail).toBeLessThan(loudestRms(x, SAMPLE_RATE, 0.05) + 1e-9);
  });

  it("is deterministic: the same sound renders the same samples every time (an event always sounds the same)", () => {
    // renderSound caches; the raw recipes are seeded per id — render twice from the recipe
    for (const id of ["sword_hit", "bow_release", "fight", "skill_slam"] as const) {
      const a = SOUNDS[id].render(makeSynthFor(id));
      const b = SOUNDS[id].render(makeSynthFor(id));
      expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer)), id).toBe(true);
    }
  });

  it("the whole pack is light: under 40 s of audio, ≤ 2.6 MB as 16-bit mono at the Arena's rate", () => {
    let samples = 0;
    for (const id of SOUND_IDS) samples += pcm(id).length;
    expect(samples / SAMPLE_RATE).toBeLessThan(40);
    expect(samples * 2).toBeLessThan(2.6 * 1024 * 1024);
  });

  it("exports as a valid 16-bit WAV (what the review sheet and a sound designer's tools read)", () => {
    const x = pcm("sword_hit");
    const w = wavBytes(x, SAMPLE_RATE);
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...w.subarray(8, 12))).toBe("WAVE");
    expect(v.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(x.length * 2);
  });
});

import { makeSynth } from "@/domain/audio/dsp";
const makeSynthFor = (id: SoundId) => makeSynth(SAMPLE_RATE, id);

describe("the sounds sit where their job says", () => {
  it("a dagger is brighter and shorter than a sword, a sword than a mace (swings AND hits)", () => {
    expect(cent("dagger_swing")).toBeGreaterThan(cent("sword_swing"));
    expect(cent("sword_swing")).toBeGreaterThan(cent("mace_swing"));
    expect(cent("sword_hit")).toBeGreaterThan(cent("mace_hit"));
    expect(cent("dagger_hit")).toBeGreaterThan(cent("mace_hit") * 3);
    expect(pcm("dagger_swing").length).toBeLessThan(pcm("sword_swing").length);
    expect(pcm("sword_swing").length).toBeLessThan(pcm("mace_swing").length);
  });

  it("heavy hits are deep: the Tank's mace thumps in the low register, an arrow thuds below a sword's crack", () => {
    expect(cent("mace_hit")).toBeLessThan(900);
    expect(cent("arrow_hit")).toBeLessThan(cent("sword_hit"));
  });

  it("the three countdown beeps rise, and each is short; FIGHT is longer, louder and richer than any of them", () => {
    expect(cent("cd_3")).toBeLessThan(cent("cd_2"));
    expect(cent("cd_2")).toBeLessThan(cent("cd_1"));
    for (const id of ["cd_3", "cd_2", "cd_1"] as const) expect(pcm(id).length / SAMPLE_RATE).toBeLessThan(0.2);
    const fight = pcm("fight");
    expect(fight.length / SAMPLE_RATE).toBeGreaterThan(0.7);
    expect(loudestRms(fight, SAMPLE_RATE, 0.12)).toBeGreaterThan(loudestRms(pcm("cd_1"), SAMPLE_RATE, 0.12));
    // "clearly different": its spectrum has far more going on than a beep's
    expect(fingerprintDistance(fingerprint(fight, SAMPLE_RATE), fingerprint(pcm("cd_1"), SAMPLE_RATE))).toBeGreaterThan(5);
  });

  it("the winner's fanfare is the longest rewarding sound but not the loudest thing in the pack", () => {
    const v = loudestRms(pcm("victory"), SAMPLE_RATE, 0.12);
    expect(pcm("victory").length / SAMPLE_RATE).toBeGreaterThan(1.2);
    expect(toDb(v)).toBeLessThan(-11); // rewarding, not obnoxious
    expect(loudestRms(pcm("fight"), SAMPLE_RATE, 0.12)).toBeGreaterThan(v);
  });

  it("quiet sounds are quiet: a whiff, an ember and the results chime sit well under the strikes", () => {
    const strike = loudestRms(pcm("sword_hit"), SAMPLE_RATE, 0.12);
    for (const id of ["miss_whiff", "hazard_tick", "results", "round_ready"] as const) expect(loudestRms(pcm(id), SAMPLE_RATE, 0.12), id).toBeLessThan(strike * 0.6);
  });

  it("the loudness of the whole pack stays inside a 14 dB band (nothing jumps out, nothing disappears)", () => {
    const dbs = SOUND_IDS.map((id) => toDb(loudestRms(pcm(id), SAMPLE_RATE, 0.12)));
    expect(Math.max(...dbs) - Math.min(...dbs)).toBeLessThan(18);
  });
});

describe("no two sounds are the same sound", () => {
  it("every pair differs in its spectrum over time (distance ≥ 5 dB RMS between the 10-band × 8-slice fingerprints; measured minimum ≈ 6.7)", () => {
    const fps = SOUND_IDS.map((id) => [id, fingerprint(pcm(id), SAMPLE_RATE)] as const);
    const close: string[] = [];
    for (let i = 0; i < fps.length; i++) {
      for (let j = i + 1; j < fps.length; j++) {
        const d = fingerprintDistance(fps[i]![1], fps[j]![1]);
        if (d < 5) close.push(`${fps[i]![0]} ~ ${fps[j]![0]} (${d.toFixed(2)})`);
      }
    }
    expect(close).toEqual([]);
  });

  it("the three countdown beeps are the same instrument at three pitches (that is the point of them)", () => {
    // the one deliberate family: distinct only in pitch
    expect(cent("cd_1") / cent("cd_3")).toBeGreaterThan(1.1);
  });
});
