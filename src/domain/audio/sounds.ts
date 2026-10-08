import { bell, glide, hit, makeSynth, note, SAMPLE_RATE, swell, type Synth } from "./dsp";

/**
 * ARENA AUDIO — the sound catalogue: every effect the Arena can play, how it is made, how loud it is and how the mixer treats it.
 *
 * Each effect is a recipe (`render`) over the DSP toolkit — original retro-RPG synthesis, no samples from anywhere. A sound is rendered ONCE (on first
 * use; deterministic), normalised to a common loudness (`trimDb` places it relative to the others) and cached as an AudioBuffer.
 *
 * Mixer metadata:
 *   · `priority` 0 (never dropped: countdown, the bell, the winner) … 4 (the first to go in a crowd: a whiff, an ember ticking);
 *   · `minGapMs` / `maxVoices`: a repeated hit never machine-guns, and eight fighters never stack twenty copies of one sound;
 *   · `pitchVar`: ± semitones, chosen deterministically from the cue's key (the same event always sounds the same — no randomness at play time).
 */

export const SOUND_IDS = [
  // phase
  "cd_3", "cd_2", "cd_1", "fight", "round_ready", "final_duel", "ko", "ko_final", "victory", "results",
  // basic attacks
  "sword_swing", "mace_swing", "dagger_swing", "bow_release", "orb_cast", "bolt_cast",
  // impacts
  "sword_hit", "mace_hit", "dagger_hit", "arrow_hit", "magic_hit", "holy_hit", "aoe_hit", "crit_ping", "miss_whiff",
  // casting
  "cast_arcane", "cast_holy",
  // named abilities
  "skill_cleave", "skill_charge", "skill_slam", "skill_shadowstep", "skill_buff", "skill_volley", "skill_snare", "skill_burst", "skill_nova", "skill_smite", "skill_sanctuary",
  // defence / support / status
  "shield_up", "heal_pulse", "stun_hit", "slow_frost", "taunt_horn", "empower_rise", "hazard_tick",
] as const;
export type SoundId = (typeof SOUND_IDS)[number];

export type SoundGroup = "phase" | "melee" | "ranged" | "magic" | "impact" | "skill" | "defense" | "status" | "result";

export interface SoundDef {
  id: SoundId;
  group: SoundGroup;
  /** 0 = never dropped … 4 = first to go. */
  priority: 0 | 1 | 2 | 3 | 4;
  /** Loudness against the reference (−20 dBFS over the loudest 120 ms): + louder, − quieter. */
  trimDb: number;
  /** Minimum ms between two plays of this sound (whoever caused them). */
  minGapMs: number;
  /** At most this many copies sounding at once. */
  maxVoices: number;
  /** ± semitones of deterministic variation (0 = always the same pitch). */
  pitchVar: number;
  /** Ducks the ordinary effects while it sounds (a bell, a winner): ms of ducking, 0 = none. */
  duckMs: number;
  render: (s: Synth) => Float32Array;
}

const def = (
  id: SoundId,
  group: SoundGroup,
  priority: SoundDef["priority"],
  trimDb: number,
  minGapMs: number,
  maxVoices: number,
  pitchVar: number,
  render: SoundDef["render"],
  duckMs = 0,
): SoundDef => ({ id, group, priority, trimDb, minGapMs, maxVoices, pitchVar, duckMs, render });

// ------------------------------------------------------------------------------------------------ building blocks

/** A countdown beep: a pulse with a sine an octave up, short and clean. */
function beep(s: Synth, hz: number): Float32Array {
  const d = 0.14;
  const body = s.mix([{ buf: s.osc("square", d, hz, { pw: 0.28 }), gain: 0.5 }, { buf: s.osc("sine", d, hz), gain: 0.5 }, { buf: s.osc("sine", d, hz * 2), gain: 0.18 }]);
  return s.shape(s.filter(body, "lp", hz * 5, 0.7), swell(0.003, d, 0.045));
}

/** A whoosh: band-passed noise whose centre sweeps from `f0` to `f1`, peaking at `peak`. */
function whoosh(s: Synth, dur: number, f0: number, f1: number, peak: number, q = 1.1): Float32Array {
  return s.shape(s.filter(s.noise(dur), "bp", glide(f0, f1, dur, 1.2), q), bell(peak, dur));
}

/** A struck thump: a falling sine, saturated. */
function thump(s: Synth, dur: number, f0: number, f1: number, tau: number, drive = 1.6): Float32Array {
  return s.saturate(s.shape(s.osc("sine", dur, glide(f0, f1, Math.min(dur, tau * 2.4))), hit(0.002, tau)), drive);
}

/** A short burst of high noise: the crack / click of a blade or an arrowhead. */
function crack(s: Synth, dur: number, hp: number, tau: number): Float32Array {
  return s.shape(s.filter(s.noise(dur), "hp", hp, 0.7), hit(0.0006, tau));
}

/** Metal partials ringing (a sword's edge, a shield): inharmonic sines. */
function ring(s: Synth, dur: number, base: number, tau: number): Float32Array {
  return s.shape(
    s.mix([{ buf: s.osc("sine", dur, base) }, { buf: s.osc("sine", dur, base * 1.43), gain: 0.7 }, { buf: s.osc("sine", dur, base * 2.12), gain: 0.5 }, { buf: s.osc("sine", dur, base * 2.97), gain: 0.3 }]),
    hit(0.0008, tau),
  );
}

/** A soft bell / glockenspiel note. */
function chime(s: Synth, dur: number, hz: number, tau: number): Float32Array {
  return s.shape(s.mix([{ buf: s.osc("sine", dur, hz) }, { buf: s.osc("sine", dur, hz * 2.76), gain: 0.25 }, { buf: s.osc("tri", dur, hz * 2), gain: 0.2 }]), hit(0.002, tau));
}

/** A brass-like stack of detuned saws, low-passed with a brightening sweep. */
function brass(s: Synth, dur: number, hz: number, bright = 3600): Float32Array {
  const parts = [0.994, 1, 1.006].map((d) => ({ buf: s.osc("saw", dur, hz * d, { vib: [5.5, 0.12] }) }));
  const sum = s.mix(parts);
  return s.filter(sum, "lp", (t) => 500 + (bright - 500) * Math.min(1, t / 0.09), 0.9);
}

// ------------------------------------------------------------------------------------------------ the catalogue

export const SOUNDS: Record<SoundId, SoundDef> = {
  // ---------------------------------------------------------------- countdown & phase
  cd_3: def("cd_3", "phase", 0, 3, 200, 1, 0, (s) => beep(s, note("D5")), 160),
  cd_2: def("cd_2", "phase", 0, 3, 200, 1, 0, (s) => beep(s, note("E5")), 160),
  cd_1: def("cd_1", "phase", 0, 3, 200, 1, 0, (s) => beep(s, note("F#5")), 160),
  fight: def("fight", "phase", 0, 6, 600, 1, 0, (s) => {
    const dur = 0.95;
    const boom = thump(s, dur, 118, 36, 0.2, 2);
    const clash = s.shape(s.filter(s.noise(dur), "bp", 5200, 0.55), hit(0.002, 0.26));
    const horn = s.mix([note("D4"), note("F#4"), note("A4"), note("D5")].map((hz) => ({ buf: brass(s, dur, hz, 4200), gain: 0.5 })));
    const stab = s.shape(s.mix([{ buf: s.osc("square", dur, note("D6"), { pw: 0.25 }), gain: 0.5 }, { buf: s.osc("sine", dur, note("A6")), gain: 0.4 }]), hit(0.002, 0.07));
    const body = s.shape(horn, (t) => Math.min(1, t / 0.012) * (t < 0.42 ? 1 : Math.exp(-(t - 0.42) / 0.16)));
    return s.saturate(s.mix([{ buf: boom, gain: 1 }, { buf: clash, gain: 0.5 }, { buf: body, gain: 0.85 }, { buf: stab, gain: 0.5 }]), 1.5);
  }, 700),
  round_ready: def("round_ready", "phase", 3, -7, 800, 1, 0, (s) =>
    s.echo(s.mix([{ buf: chime(s, 0.5, note("E5"), 0.16), gain: 0.7 }, { buf: chime(s, 0.5, note("B5"), 0.18), at: 0.09, gain: 0.55 }, { buf: whoosh(s, 0.4, 300, 1400, 0.2, 0.9), gain: 0.2 }]), 0.11, 0.3, 0.4)),
  final_duel: def("final_duel", "phase", 1, 3, 3000, 1, 0, (s) => {
    const dur = 0.95;
    const low = s.mix([{ buf: brass(s, dur, note("E2"), 900) }, { buf: brass(s, dur, note("B2"), 900), gain: 0.8 }]);
    const swellEnv = (t: number) => Math.min(1, t / 0.35) * (t < 0.55 ? 1 : Math.exp(-(t - 0.55) / 0.2));
    const shimmer = s.shape(s.filter(s.noise(dur), "hp", 6000, 0.7), bell(0.5, dur));
    return s.saturate(s.mix([{ buf: s.shape(low, swellEnv), gain: 0.9 }, { buf: shimmer, gain: 0.3 }, { buf: thump(s, 0.5, 90, 40, 0.15), at: 0.5, gain: 0.8 }]), 1.3);
  }, 400),
  ko: def("ko", "result", 1, 1.5, 120, 2, 0.5, (s) => {
    const dur = 0.5;
    const fall = s.shape(s.mix([{ buf: s.osc("tri", dur, glide(520, 110, 0.38)), gain: 0.7 }, { buf: s.osc("square", dur, glide(260, 55, 0.38), { pw: 0.3 }), gain: 0.3 }]), hit(0.004, 0.16));
    return s.saturate(s.mix([{ buf: fall, gain: 0.8 }, { buf: thump(s, dur, 150, 42, 0.12), at: 0.02, gain: 0.9 }, { buf: crack(s, 0.1, 1400, 0.03), gain: 0.5 }]), 1.4);
  }),
  ko_final: def("ko_final", "result", 0, 4, 1000, 1, 0, (s) => {
    const dur = 1.0;
    const fall = s.shape(s.mix([{ buf: s.osc("tri", dur, glide(660, 70, 0.8)), gain: 0.7 }, { buf: s.osc("saw", dur, glide(330, 48, 0.8)), gain: 0.35 }]), hit(0.004, 0.3));
    const glass = s.shape(s.mix([{ buf: ring(s, dur, 1760, 0.2), gain: 0.5 }, { buf: s.filter(s.noise(dur), "hp", 3500, 0.7), gain: 0.35 }]), hit(0.001, 0.12));
    return s.saturate(s.echo(s.mix([{ buf: fall, gain: 0.75 }, { buf: thump(s, dur, 130, 34, 0.22, 2.2), gain: 1 }, { buf: glass, gain: 0.5 }]), 0.09, 0.35, 0.35), 1.4);
  }, 600),
  victory: def("victory", "result", 0, 1.5, 3000, 1, 0, (s) => {
    // a short chiptune fanfare: C5 E5 G5 — C6, then a held major chord and a sparkle
    const notes: Array<[number, number, number]> = [[note("C5"), 0, 0.13], [note("E5"), 0.14, 0.13], [note("G5"), 0.28, 0.13], [note("C6"), 0.42, 0.55]];
    const lead = s.mix(notes.map(([hz, at, d]) => ({ at, buf: s.shape(s.mix([{ buf: s.osc("square", d + 0.1, hz, { pw: 0.3 }), gain: 0.55 }, { buf: s.osc("sine", d + 0.1, hz), gain: 0.5 }]), swell(0.006, d, 0.09 + (d > 0.2 ? 0.25 : 0)) ) })));
    const chord = s.mix([note("C5"), note("E5"), note("G5"), note("C6")].map((hz) => ({ at: 0.42, buf: s.shape(brass(s, 0.95, hz, 2400), (t) => Math.min(1, t / 0.02) * Math.exp(-t / 0.6)), gain: 0.34 })));
    const sparkle = s.mix([0, 0.07, 0.14, 0.21].map((at, i) => ({ at: 0.46 + at, buf: chime(s, 0.5, note("C7") * Math.pow(1.122, i * 2), 0.18), gain: 0.22 })));
    return s.saturate(s.echo(s.mix([{ buf: lead, gain: 0.9 }, { buf: chord, gain: 0.8 }, { buf: sparkle }, { buf: thump(s, 0.3, 120, 50, 0.1), at: 0.42, gain: 0.5 }]), 0.13, 0.3, 0.3, 0.35), 1.2);
  }, 900),
  results: def("results", "result", 2, -5, 3000, 1, 0, (s) =>
    s.echo(s.mix([{ buf: chime(s, 0.7, note("G5"), 0.22), gain: 0.7 }, { buf: chime(s, 0.7, note("D6"), 0.26), at: 0.11, gain: 0.6 }, { buf: chime(s, 0.7, note("G6"), 0.3), at: 0.22, gain: 0.35 }]), 0.15, 0.35, 0.4, 0.3)),

  // ---------------------------------------------------------------- basic attacks
  sword_swing: def("sword_swing", "melee", 3, -5, 55, 3, 0.8, (s) => s.mix([{ buf: whoosh(s, 0.2, 700, 3600, 0.075), gain: 1 }, { buf: s.shape(s.osc("sine", 0.2, 2740), hit(0.01, 0.045)), at: 0.04, gain: 0.1 }])),
  mace_swing: def("mace_swing", "melee", 3, -3, 80, 2, 0.8, (s) => s.mix([{ buf: whoosh(s, 0.32, 240, 1100, 0.13, 0.9), gain: 1 }, { buf: s.shape(s.osc("sine", 0.32, glide(95, 60, 0.3)), bell(0.12, 0.32)), gain: 0.5 }])),
  dagger_swing: def("dagger_swing", "melee", 3, -6, 45, 3, 0.9, (s) => s.mix([{ buf: whoosh(s, 0.12, 2200, 7000, 0.035, 1.5), gain: 1 }, { buf: s.shape(s.osc("sine", 0.12, 4300), hit(0.004, 0.025)), at: 0.025, gain: 0.08 }])),
  bow_release: def("bow_release", "ranged", 3, -3, 55, 3, 0.8, (s) => {
    const twang = s.shape(s.filter(s.pluck(0.32, 184, 0.9955, 0.55), "lp", 2600, 0.7), hit(0.001, 0.13));
    const swish = s.shape(s.filter(s.noise(0.12), "bp", glide(3600, 1800, 0.12), 1.2), bell(0.025, 0.12));
    return s.mix([{ buf: twang, gain: 1 }, { buf: swish, gain: 0.35 }, { buf: crack(s, 0.03, 2400, 0.006), gain: 0.25 }]);
  }),
  orb_cast: def("orb_cast", "magic", 3, -3, 80, 2, 0.6, (s) => {
    const dur = 0.4;
    const core = s.shape(s.osc("sine", dur, glide(520, 1500, 0.24, 1.6), { vib: [9, 0.15] }), swell(0.025, 0.3, 0.12));
    const harm = s.shape(s.osc("tri", dur, glide(1040, 3000, 0.24, 1.6)), swell(0.025, 0.3, 0.12));
    const air = s.shape(s.filter(s.noise(dur), "bp", 3200, 1.2), bell(0.14, 0.3));
    return s.echo(s.mix([{ buf: core, gain: 0.7 }, { buf: harm, gain: 0.18 }, { buf: air, gain: 0.2 }, { buf: chime(s, 0.3, 2793, 0.06), at: 0.2, gain: 0.25 }]), 0.07, 0.35, 0.3);
  }),
  bolt_cast: def("bolt_cast", "magic", 3, -3, 80, 2, 0.5, (s) =>
    s.echo(s.mix([{ buf: chime(s, 0.45, note("E5"), 0.13), gain: 0.7 }, { buf: chime(s, 0.45, note("A5"), 0.15), at: 0.075, gain: 0.7 }, { buf: whoosh(s, 0.26, 2000, 4400, 0.1, 1.2), gain: 0.18 }, { buf: s.shape(s.osc("sine", 0.4, 440), swell(0.03, 0.4, 0.2)), gain: 0.18 }]), 0.08, 0.3, 0.3)),

  // ---------------------------------------------------------------- impacts
  sword_hit: def("sword_hit", "impact", 2, 0, 50, 4, 0.9, (s) => {
    const dur = 0.2;
    return s.saturate(s.mix([{ buf: thump(s, dur, 230, 70, 0.04), gain: 0.8 }, { buf: crack(s, dur, 900, 0.022), gain: 0.85 }, { buf: ring(s, dur, 1850, 0.05), gain: 0.22 }]), 1.3);
  }),
  mace_hit: def("mace_hit", "impact", 2, 2, 70, 3, 0.9, (s) => {
    const dur = 0.34;
    return s.saturate(s.mix([{ buf: thump(s, dur, 160, 36, 0.11, 2.2), gain: 1 }, { buf: s.shape(s.filter(s.noise(dur), "lp", 1900, 0.8), hit(0.001, 0.05)), gain: 0.6 }, { buf: s.shape(s.filter(s.noise(dur), "bp", 420, 2), hit(0.01, 0.09)), gain: 0.28 }]), 1.5);
  }),
  dagger_hit: def("dagger_hit", "impact", 2, -3, 40, 4, 1, (s) => {
    const dur = 0.14;
    return s.mix([{ buf: crack(s, dur, 1900, 0.012), gain: 0.9 }, { buf: s.shape(s.osc("sine", dur, glide(1320, 880, 0.04)), hit(0.001, 0.02)), gain: 0.5 }, { buf: ring(s, dur, 3300, 0.035), gain: 0.18 }]);
  }),
  arrow_hit: def("arrow_hit", "impact", 2, -2, 50, 4, 0.8, (s) => {
    const dur = 0.24;
    return s.mix([
      { buf: s.shape(s.filter(s.noise(dur), "lp", 1300, 0.8), hit(0.001, 0.02)), gain: 0.85 },
      { buf: thump(s, dur, 270, 120, 0.035, 1.3), gain: 0.7 },
      { buf: s.shape(s.filter(s.noise(dur), "bp", 720, 3), hit(0.004, 0.035)), gain: 0.4 },
      { buf: s.shape(s.osc("sine", dur, glide(540, 500, dur), { vib: [28, 0.4] }), hit(0.004, 0.075)), at: 0.015, gain: 0.14 },
    ]);
  }),
  magic_hit: def("magic_hit", "impact", 2, -1, 60, 3, 0.7, (s) => {
    const dur = 0.42;
    const pop = s.shape(s.filter(s.noise(dur), "bp", glide(1900, 420, 0.2), 0.9), hit(0.002, 0.07));
    const zap = s.shape(s.osc("sine", dur, glide(940, 250, 0.2)), hit(0.003, 0.07));
    const glitter = s.shape(s.osc("tri", dur, 2450, { vib: [14, 0.4] }), hit(0.01, 0.12));
    return s.echo(s.mix([{ buf: pop, gain: 0.55 }, { buf: zap, gain: 0.7 }, { buf: glitter, gain: 0.22 }]), 0.055, 0.4, 0.3);
  }),
  holy_hit: def("holy_hit", "impact", 2, -2, 60, 3, 0.5, (s) => {
    const dur = 0.46;
    const bellPair = s.mix([{ buf: chime(s, dur, 1318, 0.13), gain: 0.55 }, { buf: chime(s, dur, 1976, 0.12), at: 0.012, gain: 0.4 }]);
    return s.echo(s.mix([{ buf: bellPair }, { buf: thump(s, dur, 330, 170, 0.07, 1.2), gain: 0.55 }, { buf: crack(s, 0.1, 2800, 0.015), gain: 0.2 }]), 0.075, 0.35, 0.3);
  }),
  aoe_hit: def("aoe_hit", "impact", 2, 2, 90, 2, 0.6, (s) => {
    const dur = 0.4;
    return s.saturate(s.mix([{ buf: thump(s, dur, 190, 46, 0.1, 2), gain: 0.9 }, { buf: crack(s, dur, 700, 0.04), gain: 0.7 }, { buf: crack(s, 0.2, 1800, 0.03), at: 0.035, gain: 0.5 }, { buf: crack(s, 0.2, 1300, 0.03), at: 0.07, gain: 0.35 }]), 1.5);
  }),
  crit_ping: def("crit_ping", "impact", 2, -4, 90, 2, 0, (s) =>
    s.mix([{ buf: chime(s, 0.3, 2349, 0.07), gain: 0.6 }, { buf: chime(s, 0.3, 3520, 0.06), at: 0.018, gain: 0.45 }, { buf: crack(s, 0.05, 5000, 0.006), gain: 0.2 }])),
  miss_whiff: def("miss_whiff", "melee", 4, -12, 120, 2, 0.8, (s) => whoosh(s, 0.13, 1200, 3200, 0.04, 0.9)),

  // ---------------------------------------------------------------- casting
  cast_arcane: def("cast_arcane", "magic", 2, -2, 200, 2, 0.4, (s) => {
    const dur = 0.5;
    const rise = s.shape(s.osc("sine", dur, glide(280, 940, 0.42, 1.4), { vib: [8, 0.3] }), swell(0.05, dur, 0.1));
    const up = s.shape(s.osc("tri", dur, glide(560, 1880, 0.42, 1.4), { vib: [10, 0.3] }), swell(0.05, dur, 0.1));
    const dust = s.shape(s.filter(s.noise(dur), "bp", glide(1400, 4200, dur), 1.5), swell(0.05, dur, 0.1));
    return s.echo(s.mix([{ buf: rise, gain: 0.6 }, { buf: up, gain: 0.22 }, { buf: dust, gain: 0.25 }]), 0.09, 0.3, 0.3);
  }),
  cast_holy: def("cast_holy", "magic", 2, -2, 200, 2, 0.3, (s) => {
    const dur = 0.55;
    const pad = s.mix([note("C5"), note("E5"), note("G5")].map((hz, i) => ({ buf: s.shape(s.osc("sine", dur, hz, { vib: [5.5, 0.1] }), swell(0.07 + i * 0.04, dur, 0.15)), gain: 0.4 })));
    return s.echo(s.mix([{ buf: pad }, { buf: chime(s, 0.4, note("C7"), 0.12), at: 0.3, gain: 0.2 }]), 0.1, 0.35, 0.3);
  }),

  // ---------------------------------------------------------------- named abilities
  skill_cleave: def("skill_cleave", "skill", 1, 1, 250, 1, 0.3, (s) => {
    const dur = 0.5;
    return s.mix([{ buf: whoosh(s, dur, 350, 2600, 0.17, 1), gain: 1 }, { buf: whoosh(s, 0.36, 500, 3400, 0.12, 1.2), at: 0.09, gain: 0.55 }, { buf: ring(s, 0.4, 1300, 0.09), at: 0.1, gain: 0.16 }, { buf: thump(s, 0.3, 120, 55, 0.07), at: 0.14, gain: 0.5 }]);
  }),
  skill_charge: def("skill_charge", "skill", 1, 1, 250, 1, 0.3, (s) => {
    const dur = 0.42;
    const zip = s.filter(s.osc("saw", dur, glide(180, 2200, 0.3, 1.7)), "lp", glide(500, 4200, 0.3), 0.8);
    return s.saturate(s.mix([{ buf: s.shape(zip, swell(0.01, 0.3, 0.06)), gain: 0.65 }, { buf: whoosh(s, 0.3, 500, 4200, 0.2), gain: 0.5 }, { buf: thump(s, 0.3, 150, 48, 0.09, 2), at: 0.26, gain: 1 }]), 1.3);
  }),
  skill_slam: def("skill_slam", "skill", 1, 3, 400, 1, 0.2, (s) => {
    const dur = 0.7;
    const rumble = s.shape(s.filter(s.rumble(dur), "lp", 360, 0.8), hit(0.004, 0.26));
    const cracks = s.mix([0, 0.03, 0.07, 0.12].map((at, i) => ({ at, buf: crack(s, 0.2, 800 + i * 400, 0.04), gain: 0.55 - i * 0.1 })));
    return s.saturate(s.mix([{ buf: thump(s, dur, 100, 30, 0.22, 2.6), gain: 1 }, { buf: rumble, gain: 0.9 }, { buf: cracks, gain: 0.8 }]), 1.6);
  }),
  skill_shadowstep: def("skill_shadowstep", "skill", 1, 0, 250, 1, 0.4, (s) => {
    const dur = 0.4;
    const bwip = s.shape(s.osc("sine", dur, glide(2000, 320, 0.2)), hit(0.003, 0.09));
    const rev = s.reverse(whoosh(s, 0.22, 600, 5200, 0.08, 1.4));
    return s.echo(s.mix([{ buf: rev, gain: 0.7 }, { buf: bwip, at: 0.17, gain: 0.7 }, { buf: chime(s, 0.3, 3136, 0.05), at: 0.2, gain: 0.2 }]), 0.06, 0.3, 0.25);
  }),
  skill_buff: def("skill_buff", "status", 2, -2, 250, 1, 0.3, (s) => {
    const parts = [note("C5"), note("E5"), note("G5"), note("C6")].map((hz, i) => ({ at: i * 0.065, buf: s.shape(s.mix([{ buf: s.osc("tri", 0.3, hz) }, { buf: s.osc("sine", 0.3, hz * 2), gain: 0.25 }]), hit(0.004, 0.1)), gain: 0.55 }));
    return s.echo(s.mix(parts), 0.08, 0.3, 0.3);
  }),
  skill_volley: def("skill_volley", "skill", 1, 0, 300, 1, 0.3, (s) => {
    const twang = (hz: number) => s.shape(s.filter(s.pluck(0.28, hz, 0.995, 0.6), "lp", 2800, 0.7), hit(0.001, 0.1));
    return s.mix([{ buf: twang(176), at: 0, gain: 0.9 }, { buf: twang(196), at: 0.075, gain: 0.8 }, { buf: twang(220), at: 0.15, gain: 0.8 }, { buf: whoosh(s, 0.3, 2200, 5200, 0.1, 1.2), gain: 0.22 }]);
  }),
  skill_snare: def("skill_snare", "skill", 1, 0, 250, 1, 0.3, (s) => {
    const twang = s.shape(s.filter(s.pluck(0.3, 200, 0.995, 0.6), "lp", 2600, 0.7), hit(0.001, 0.11));
    const ice = s.mix([{ buf: chime(s, 0.4, 2217, 0.14), gain: 0.3 }, { buf: chime(s, 0.4, 3322, 0.12), at: 0.03, gain: 0.22 }]);
    return s.mix([{ buf: twang, gain: 0.9 }, { buf: ice, at: 0.05, gain: 0.8 }]);
  }),
  skill_burst: def("skill_burst", "skill", 1, 2, 300, 1, 0.3, (s) => {
    const dur = 0.7;
    const boom = s.shape(s.osc("sine", dur, glide(620, 55, 0.4)), hit(0.003, 0.14));
    const body = s.shape(s.filter(s.noise(dur), "lp", glide(2600, 260, 0.5), 0.8), hit(0.002, 0.14));
    const tail = s.mix([0, 0.05, 0.1].map((at, i) => ({ at: 0.04 + at, buf: chime(s, 0.5, note("E6") * (1 + i * 0.26), 0.14), gain: 0.2 })));
    return s.saturate(s.echo(s.mix([{ buf: boom, gain: 0.9 }, { buf: body, gain: 0.85 }, { buf: tail }]), 0.08, 0.35, 0.3, 0.3), 1.4);
  }),
  skill_nova: def("skill_nova", "skill", 1, 1, 300, 1, 0.3, (s) => {
    const dur = 0.7;
    const shatter = s.mix([0, 0.02, 0.05, 0.09].map((at, i) => ({ at, buf: crack(s, 0.2, 3200 + i * 500, 0.03), gain: 0.5 })));
    const glass = s.mix([{ buf: ring(s, 0.6, 2410, 0.16), gain: 0.4 }, { buf: ring(s, 0.6, 3180, 0.14), at: 0.025, gain: 0.3 }]);
    return s.echo(s.mix([{ buf: thump(s, dur, 150, 50, 0.13, 1.8), gain: 0.9 }, { buf: shatter, gain: 0.8 }, { buf: glass }, { buf: whoosh(s, 0.5, 5200, 1800, 0.06, 1), gain: 0.2 }]), 0.09, 0.35, 0.3);
  }),
  skill_smite: def("skill_smite", "skill", 1, 1, 300, 1, 0.2, (s) => {
    const dur = 0.7;
    const choir = s.mix([note("C5"), note("E5"), note("G5"), note("C6")].map((hz, i) => ({ buf: s.shape(s.osc("sine", dur, hz, { vib: [5.2, 0.14] }), (t) => Math.min(1, t / 0.07) * Math.exp(-t / (0.32 - i * 0.02))), gain: 0.34 })));
    return s.saturate(s.echo(s.mix([{ buf: choir }, { buf: crack(s, 0.2, 2200, 0.025), gain: 0.55 }, { buf: thump(s, 0.4, 260, 90, 0.09, 1.5), gain: 0.8 }, { buf: chime(s, 0.5, note("E7"), 0.14), at: 0.04, gain: 0.2 }]), 0.1, 0.3, 0.3), 1.2);
  }),
  skill_sanctuary: def("skill_sanctuary", "skill", 1, 0, 400, 1, 0.2, (s) => {
    const arp = [note("C5"), note("E5"), note("G5"), note("C6"), note("E6")].map((hz, i) => ({ at: i * 0.08, buf: s.mix([{ buf: chime(s, 0.6, hz, 0.2) }, { buf: s.shape(s.osc("sine", 0.6, hz / 2), swell(0.02, 0.5, 0.25)), gain: 0.25 }]), gain: 0.45 }));
    return s.echo(s.mix(arp), 0.13, 0.4, 0.4, 0.45);
  }),

  // ---------------------------------------------------------------- defence / support / status
  shield_up: def("shield_up", "defense", 2, -1, 120, 2, 0.4, (s) => {
    const dur = 0.4;
    const clang = s.shape(s.mix([{ buf: s.osc("square", dur, 1050, { pw: 0.5 }), gain: 0.3 }, { buf: ring(s, dur, 880, 0.1), gain: 0.7 }]), hit(0.001, 0.09));
    const rise = s.shape(s.osc("sine", dur, glide(900, 1700, 0.12)), hit(0.004, 0.07));
    return s.mix([{ buf: clang, gain: 0.9 }, { buf: rise, at: 0.05, gain: 0.4 }, { buf: crack(s, 0.05, 2600, 0.008), gain: 0.4 }, { buf: thump(s, 0.2, 180, 90, 0.05), gain: 0.5 }]);
  }),
  heal_pulse: def("heal_pulse", "defense", 3, -3, 220, 2, 0.4, (s) => {
    const dur = 0.5;
    const up = s.shape(s.osc("sine", dur, glide(523, 659, 0.12)), swell(0.03, dur, 0.28));
    const oct = s.shape(s.osc("tri", dur, glide(1046, 1318, 0.12)), swell(0.03, dur, 0.28));
    return s.echo(s.mix([{ buf: up, gain: 0.55 }, { buf: oct, gain: 0.18 }, { buf: chime(s, 0.4, note("E6"), 0.12), at: 0.1, gain: 0.2 }]), 0.12, 0.35, 0.35);
  }),
  stun_hit: def("stun_hit", "status", 2, -1, 200, 2, 0.4, (s) => {
    const dur = 0.3;
    return s.mix([{ buf: thump(s, dur, 300, 90, 0.05, 1.6), gain: 0.8 }, { buf: crack(s, 0.1, 1500, 0.02), gain: 0.6 }, { buf: chime(s, dur, 1760, 0.1), at: 0.04, gain: 0.35 }, { buf: chime(s, dur, 2217, 0.09), at: 0.09, gain: 0.25 }]);
  }),
  slow_frost: def("slow_frost", "status", 3, -5, 250, 1, 0.5, (s) => {
    const dur = 0.4;
    const fall = s.shape(s.osc("sine", dur, glide(2800, 1700, dur), { vib: [18, 0.5] }), swell(0.02, dur, 0.2));
    const air = s.shape(s.filter(s.noise(dur), "hp", 4200, 0.7), swell(0.02, dur, 0.2));
    return s.mix([{ buf: fall, gain: 0.35 }, { buf: air, gain: 0.3 }, { buf: chime(s, 0.4, 2637, 0.1), at: 0.02, gain: 0.25 }]);
  }),
  taunt_horn: def("taunt_horn", "status", 2, 0, 400, 1, 0.2, (s) => {
    const dur = 0.5;
    const horn = s.shape(brass(s, dur, 146.8, 1700), (t) => Math.min(1, t / 0.03) * (t < 0.28 ? 1 : Math.exp(-(t - 0.28) / 0.09)));
    return s.saturate(s.mix([{ buf: horn, gain: 0.85 }, { buf: thump(s, 0.3, 110, 50, 0.08), gain: 0.5 }]), 1.4);
  }),
  empower_rise: def("empower_rise", "status", 3, -3, 300, 1, 0.3, (s) => {
    const dur = 0.45;
    const rise = s.filter(s.osc("saw", dur, glide(160, 640, 0.35, 1.3)), "lp", glide(600, 3000, 0.35), 0.9);
    return s.mix([{ buf: s.shape(rise, swell(0.03, dur, 0.1)), gain: 0.5 }, { buf: chime(s, 0.3, note("G6"), 0.1), at: 0.32, gain: 0.3 }]);
  }),
  hazard_tick: def("hazard_tick", "status", 4, -10, 300, 1, 0.5, (s) => s.mix([{ buf: s.shape(s.filter(s.noise(0.14), "lp", 1600, 0.8), hit(0.001, 0.03)), gain: 0.8 }, { buf: thump(s, 0.14, 200, 90, 0.03, 1.2), gain: 0.5 }])),
};

/** Renders a sound's raw samples (before loudness normalisation) — exposed for tests and the sound sheet. */
export function renderRaw(id: SoundId, sr = SAMPLE_RATE): Float32Array {
  const d = SOUNDS[id];
  if (!d) throw new Error(`unknown sound ${id}`);
  return d.render(makeSynth(sr, id));
}
