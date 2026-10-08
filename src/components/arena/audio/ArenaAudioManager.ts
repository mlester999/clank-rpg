import { LATE_MAX_MS, type SoundCue } from "@/domain/audio/cues";
import { SAMPLE_RATE } from "@/domain/audio/dsp";
import { VoicePolicy, type Voice } from "@/domain/audio/policy";
import { renderSound } from "@/domain/audio/render";
import { SOUND_IDS, SOUNDS, type SoundId } from "@/domain/audio/sounds";
import { stableHash } from "@/domain/sprites/hash";

import { DEFAULT_SOUND_PREF, readSoundPref, SOUND_PREF_KEY, writeSoundPref, type SoundPref } from "./audioPrefs";

/**
 * THE ARENA'S SOUND ENGINE — one per page, never per render.
 *
 *   cue (from the server's events / clock) → policy (dedupe · throttle · priority · voice limits) → AudioBufferSource → voice gain → stereo pan → bus
 *   → master gain → compressor / limiter → speakers
 *
 * What it guarantees:
 *   · NOTHING sounds before the browser allows it: the AudioContext is created inside a real user gesture (a click on the speaker button, or the
 *     first tap / key press anywhere while the viewer's saved preference is "on") — never on page load, never by a timer;
 *   · the viewer's choice (`on` / `off`) lives in localStorage and changes ONLY when the viewer clicks the button — a refresh, a navigation, a tab
 *     restore or an audio error can never flip it;
 *   · muted means silent NOW: every voice is cut, the master gain is zero and the context is suspended;
 *   · a hidden tab is silent and a returning tab starts clean (stale cues are refused by their own age, not replayed);
 *   · combat sounds are refused outside COMBAT / VICTORY and for any battle that is not on stage; a cue is accepted once per key;
 *   · every public method swallows its own failures: a broken audio stack costs the sound, never the Arena.
 *
 * The browser pieces (`AudioContext`, storage, document) are injected, so the same logic runs against a fake in tests and against the real thing in
 * the page.
 */

export type EngineStatus = "idle" | "starting" | "ready" | "unsupported" | "error";

export interface AudioSnapshot {
  /** The viewer's saved choice. */
  pref: SoundPref;
  /** The engine: `idle` = no AudioContext yet (the browser has not been given a gesture). */
  status: EngineStatus;
  /** Sound is actually playing right now (preference on, unlocked, tab visible). */
  audible: boolean;
  /** The preference is "on" but the browser has not allowed sound yet: the button invites a click ("Enable sound"). */
  needsUnlock: boolean;
}

export interface AudioEnv {
  createContext: (() => AudioContext) | null;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  /** Monotonic ms (the policy's clock). */
  now: () => number;
  doc: Document | null;
  win: Window | null;
  /** The PCM of a sound (default: the synthesiser). */
  pcm: (id: SoundId) => Float32Array;
}

/** The highest total output the mixer allows (before the limiter): the "master Arena gain". */
export const MASTER_GAIN = 0.8;
/** The default volume (0..1); `setVolume` changes it (kept internal — the Arena shows one mute button, no slider). */
export const DEFAULT_VOLUME = 0.85;
const LOW_DUCK = 0.5;

const browserEnv = (): AudioEnv => {
  const w = typeof window === "undefined" ? null : window;
  const Ctor = w ? (w.AudioContext ?? (w as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
  let storage: AudioEnv["storage"] = null;
  try {
    storage = w ? w.localStorage : null;
  } catch {
    storage = null;
  }
  return {
    createContext: Ctor ? () => new Ctor({ latencyHint: "interactive" }) : null,
    storage,
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    doc: typeof document === "undefined" ? null : document,
    win: w,
    pcm: (id) => renderSound(id),
  };
};

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  sfx: GainNode;
  cue: GainNode;
}

export class ArenaAudioManager {
  private readonly env: AudioEnv;
  private snapshot: AudioSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly policy = new VoicePolicy();
  private graph: Graph | null = null;
  private readonly buffers = new Map<SoundId, AudioBuffer>();
  private attached = false;
  private unlocking: Promise<void> | null = null;
  private visible = true;
  private volume = DEFAULT_VOLUME;
  private battle: string | null = null;
  private phase = "IDLE";
  private warned = false;
  private teardown: Array<() => void> = [];
  /** Counters for tests and the QA overlay: what the engine accepted and what it turned away. */
  readonly stats = { played: 0, duplicate: 0, throttled: 0, crowded: 0, stale: 0, gated: 0, muted: 0 };

  constructor(env: Partial<AudioEnv> = {}) {
    this.env = { ...browserEnv(), ...env };
    const pref = readSoundPref(this.env.storage);
    this.snapshot = { pref, status: this.env.createContext ? "idle" : "unsupported", audible: false, needsUnlock: pref === "on" && Boolean(this.env.createContext) };
  }

  // ------------------------------------------------------------------------------------------------ store (React)
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): AudioSnapshot => this.snapshot;
  /** The server (and the hydration pass) always render the default: the stored choice is read on the client, after hydration. */
  getServerSnapshot = (): AudioSnapshot => SERVER_SNAPSHOT;

  private set(patch: Partial<Pick<AudioSnapshot, "pref" | "status">>): void {
    const pref = patch.pref ?? this.snapshot.pref;
    const status = patch.status ?? this.snapshot.status;
    const audible = pref === "on" && status === "ready" && this.visible && this.graph?.ctx.state === "running";
    const needsUnlock = pref === "on" && status !== "ready" && status !== "unsupported" && status !== "error";
    const s = this.snapshot;
    if (s.pref === pref && s.status === status && s.audible === audible && s.needsUnlock === needsUnlock) return;
    this.snapshot = { pref, status, audible, needsUnlock };
    for (const l of [...this.listeners]) l();
  }

  // ------------------------------------------------------------------------------------------------ page lifecycle
  /** Starts listening (the Arena mounted). Safe to call twice. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const { doc, win } = this.env;
    // the preference may have been changed in another tab, or this is the first client render after hydration
    this.set({ pref: readSoundPref(this.env.storage) });
    this.visible = !doc || doc.visibilityState !== "hidden";
    const on = <T extends EventTarget>(t: T | null, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void => {
      if (!t) return;
      t.addEventListener(type, fn, opts);
      this.teardown.push(() => t.removeEventListener(type, fn, opts));
    };
    on(doc, "visibilitychange", () => this.onVisibility());
    on(win, "pageshow", (e) => {
      if ((e as PageTransitionEvent).persisted) this.onRestored();
    });
    on(win, "storage", (e) => {
      if ((e as StorageEvent).key === SOUND_PREF_KEY) this.syncPref();
    });
    for (const type of ["pointerdown", "keydown", "touchend"]) on(win, type, (e) => this.onGesture(e), { capture: true, passive: true });
    this.set({});
  }

  /** The Arena left the page: every voice is cut and the context is parked (not destroyed — the next visit reuses it). */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    for (const t of this.teardown.splice(0)) t();
    this.stopAll();
    this.battle = null;
    this.phase = "IDLE";
    this.policy.forget();
    void this.park();
    this.set({});
  }

  // ------------------------------------------------------------------------------------------------ the viewer's controls
  /** The speaker button. Audible → mute. Muted → unmute (and unlock: this click IS the gesture). Preference on but locked → unlock. */
  toggle(): void {
    try {
      const s = this.snapshot;
      if (s.pref === "on" && s.audible) {
        writeSoundPref("off", this.env.storage);
        this.set({ pref: "off" });
        this.silence();
        return;
      }
      if (s.pref !== "on") {
        writeSoundPref("on", this.env.storage);
        this.set({ pref: "on" });
      }
      void this.unlock();
    } catch (e) {
      this.fail(e);
    }
  }

  /** Explicit setter (tests, future settings UI). */
  setEnabled(on: boolean): void {
    try {
      if (on) {
        if (this.snapshot.pref !== "on") {
          writeSoundPref("on", this.env.storage);
          this.set({ pref: "on" });
        }
        void this.unlock();
      } else if (this.snapshot.pref !== "off") {
        writeSoundPref("off", this.env.storage);
        this.set({ pref: "off" });
        this.silence();
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** Internal master volume, 0..1 (the Arena has no slider). */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyMaster();
  }

  // ------------------------------------------------------------------------------------------------ the stage
  /**
   * Which battle is on stage and which phase it is in — fed every frame (cheap). A new battle starts clean; combat cues are only accepted while
   * the fight is on (COMBAT, and VICTORY for the last blow's echo), whatever the caller sends.
   */
  setStage(battleId: string | null, phase: string): void {
    if (battleId !== this.battle) {
      this.battle = battleId;
      this.policy.stopAll();
      this.policy.forget();
    }
    this.phase = phase;
  }

  /** Presents one cue. Never throws. */
  play(cue: SoundCue): void {
    try {
      const g = this.graph;
      const s = this.snapshot;
      if (!g || !s.audible) {
        this.stats.muted++;
        return;
      }
      if (cue.battle !== this.battle) {
        this.stats.gated++;
        return;
      }
      if (cue.kind === "combat" && this.phase !== "COMBAT" && this.phase !== "VICTORY") {
        this.stats.gated++;
        return;
      }
      // a combat sound that is already this old (a tab that was asleep, a stalled frame) is dropped, not played late; phase cues carry their own freshness
      if (cue.kind === "combat" && cue.lateMs > LATE_MAX_MS.combat) {
        this.stats.stale++;
        return;
      }
      const def = SOUNDS[cue.id];
      const now = this.env.now();
      const admission = this.policy.admit(def, cue.key, now);
      if (!admission.ok) {
        this.stats[admission.reason]++;
        return;
      }
      const buffer = this.bufferOf(g.ctx, cue.id);
      if (!buffer) return;
      if (admission.steal) {
        this.policy.ended(admission.steal);
        admission.steal.stop();
      }
      this.policy.remember(cue.key);
      this.start(g, def, buffer, cue, now);
      this.stats.played++;
    } catch (e) {
      this.fail(e);
    }
  }

  /** Cuts every voice that is sounding (a battle left the stage, the Arena unmounted). */
  stopAll(): void {
    this.policy.stopAll();
  }

  // ------------------------------------------------------------------------------------------------ unlocking
  private onGesture(e: Event): void {
    if (this.snapshot.pref !== "on" || this.snapshot.status === "ready" || this.snapshot.status === "starting") return;
    const target = e.target as Element | null;
    // the speaker button handles its own click (a pointerdown here would start the sound and the click would then switch it OFF)
    if (target && typeof target.closest === "function" && target.closest("[data-sound-toggle]")) return;
    if ((e as Event & { isTrusted?: boolean }).isTrusted === false) return;
    void this.unlock();
  }

  /** Creates the AudioContext (inside a gesture) and starts it. Idempotent; resolves when the browser has decided. */
  unlock(): Promise<void> {
    if (this.unlocking) return this.unlocking;
    const p = (async () => {
      try {
        if (!this.env.createContext) {
          this.set({ status: "unsupported" });
          return;
        }
        if (this.snapshot.pref !== "on") return;
        this.set({ status: "starting" });
        const g = this.graph ?? this.build();
        if (g.ctx.state !== "running") await g.ctx.resume();
        // a gesture can be refused (the browser decides): stay "idle" and keep the invitation, no error
        if (g.ctx.state !== "running") {
          this.set({ status: "idle" });
          return;
        }
        this.applyMaster();
        this.set({ status: "ready" });
        this.primeBuffers(g.ctx);
      } catch (e) {
        this.fail(e);
      }
    })().finally(() => {
      this.unlocking = null;
    });
    this.unlocking = p;
    return p;
  }

  private build(): Graph {
    const ctx = (this.env.createContext as () => AudioContext)();
    const master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    // a bus compressor tuned as a limiter: eight simultaneous strikes get squeezed, never clipped
    limiter.threshold.value = -14;
    limiter.knee.value = 8;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.14;
    const sfx = ctx.createGain();
    const cue = ctx.createGain();
    sfx.connect(master);
    cue.connect(master);
    master.connect(limiter);
    limiter.connect(ctx.destination);
    master.gain.value = 0;
    ctx.onstatechange = () => this.onContextState();
    this.graph = { ctx, master, limiter, sfx, cue };
    return this.graph;
  }

  private onContextState(): void {
    const g = this.graph;
    if (!g) return;
    // the browser can pause an audio context on its own (an interrupted phone call, a background tab): the invitation comes back
    if (g.ctx.state === "running") this.set(this.snapshot.pref === "on" && this.snapshot.status === "idle" ? { status: "ready" } : {});
    else if (this.snapshot.status === "ready" && this.snapshot.pref === "on" && this.visible) this.set({ status: "idle" });
    else this.set({});
  }

  /** Renders the sounds into AudioBuffers in small steps (the important ones first), so the first fight never pays for it. */
  private primeBuffers(ctx: AudioContext): void {
    const order: SoundId[] = ["cd_3", "cd_2", "cd_1", "fight", "victory", "ko", "ko_final", "sword_swing", "sword_hit", "mace_swing", "mace_hit", "dagger_swing", "dagger_hit", "bow_release", "arrow_hit", "orb_cast", "magic_hit", "bolt_cast", "holy_hit"];
    const queue = [...order, ...SOUND_IDS.filter((id) => !order.includes(id))];
    const step = (): void => {
      if (this.graph?.ctx !== ctx) return;
      for (let i = 0; i < 3 && queue.length; i++) this.bufferOf(ctx, queue.shift() as SoundId);
      if (queue.length) setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  private bufferOf(ctx: AudioContext, id: SoundId): AudioBuffer | null {
    const hit = this.buffers.get(id);
    if (hit) return hit;
    try {
      const pcm = this.env.pcm(id);
      const buf = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
      buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
      this.buffers.set(id, buf);
      return buf;
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------------ voices
  private start(g: Graph, def: (typeof SOUNDS)[SoundId], buffer: AudioBuffer, cue: SoundCue, now: number): void {
    const { ctx } = g;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // deterministic variation: the same event always sounds the same
    const h = (stableHash(cue.key) % 2001) / 1000 - 1;
    const rate = Math.pow(2, (def.pitchVar * h) / 12);
    src.playbackRate.value = rate;
    const vg = ctx.createGain();
    vg.gain.value = Math.min(1.2, Math.max(0, cue.gain));
    let tail: AudioNode = vg;
    src.connect(vg);
    if (typeof ctx.createStereoPanner === "function" && cue.pan !== 0) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.min(1, Math.max(-1, cue.pan));
      vg.connect(pan);
      tail = pan;
    }
    tail.connect(def.priority === 0 ? g.cue : g.sfx);
    const when = ctx.currentTime + Math.max(0, cue.delayMs) / 1000;
    const seconds = buffer.duration / rate;
    const voice: Voice = {
      id: def.id,
      priority: def.priority,
      startedAt: now + cue.delayMs,
      endsAt: now + cue.delayMs + seconds * 1000,
      stop: () => {
        try {
          const t = ctx.currentTime;
          vg.gain.cancelScheduledValues(t);
          vg.gain.setValueAtTime(vg.gain.value, t);
          vg.gain.linearRampToValueAtTime(0, t + 0.008);
          src.stop(t + 0.012);
        } catch {
          /* already stopped */
        }
      },
    };
    src.onended = () => {
      this.policy.ended(voice);
      try {
        src.disconnect();
        vg.disconnect();
        if (tail !== vg) tail.disconnect();
      } catch {
        /* already disconnected */
      }
    };
    src.start(when);
    this.policy.started(voice);
    if (def.duckMs > 0) this.duck(g, when, def.duckMs);
  }

  /** A bell or a winner takes the room: the ordinary effects dip for a moment (the cue bus is not ducked). */
  private duck(g: Graph, when: number, ms: number): void {
    const t = Math.max(when, g.ctx.currentTime);
    g.sfx.gain.cancelScheduledValues(t);
    g.sfx.gain.setTargetAtTime(LOW_DUCK, t, 0.012);
    g.sfx.gain.setTargetAtTime(1, t + ms / 1000, 0.14);
  }

  private applyMaster(): void {
    const g = this.graph;
    if (!g) return;
    const on = this.snapshot.pref === "on" && this.visible;
    const t = g.ctx.currentTime;
    g.master.gain.cancelScheduledValues(t);
    g.master.gain.setValueAtTime(g.master.gain.value, t);
    g.master.gain.linearRampToValueAtTime(on ? MASTER_GAIN * this.volume : 0, t + (on ? 0.03 : 0.004));
  }

  // ------------------------------------------------------------------------------------------------ silence, visibility, errors
  /** Immediate silence: voices cut, master to zero, context parked. */
  private silence(): void {
    this.stopAll();
    const g = this.graph;
    if (g) {
      const t = g.ctx.currentTime;
      g.master.gain.cancelScheduledValues(t);
      g.master.gain.setValueAtTime(0, t);
    }
    void this.park();
  }

  private async park(): Promise<void> {
    const g = this.graph;
    if (!g || g.ctx.state !== "running") return;
    try {
      await g.ctx.suspend();
    } catch {
      /* closing or already suspended */
    }
    this.set({});
  }

  private onVisibility(): void {
    const hidden = this.env.doc?.visibilityState === "hidden";
    this.visible = !hidden;
    if (hidden) {
      this.stopAll();
      this.applyMaster();
      void this.park();
      this.set({});
      return;
    }
    // coming back: a clean slate (nothing from before is replayed) and the sound returns if the viewer wants it
    this.policy.forget();
    if (this.snapshot.pref === "on" && this.graph) void this.unlock();
    else this.set({});
  }

  /** Back / forward cache restore: the page is the same object as before, but everything that was scheduled is long gone. */
  private onRestored(): void {
    this.stopAll();
    this.policy.forget();
    this.visible = !this.env.doc || this.env.doc.visibilityState !== "hidden";
    this.syncPref();
    if (this.snapshot.pref === "on" && this.graph) void this.unlock();
  }

  private syncPref(): void {
    const pref = readSoundPref(this.env.storage);
    if (pref === this.snapshot.pref) return;
    this.set({ pref });
    if (pref === "off") this.silence();
    else if (this.graph) void this.unlock();
  }

  private fail(e: unknown): void {
    if (!this.warned) {
      this.warned = true;
      console.warn("[arena-audio] sound is unavailable:", e instanceof Error ? e.message : e);
    }
    this.stopAll();
    this.set({ status: "error" });
  }

  /** Test hook / dispose: closes the context. */
  async dispose(): Promise<void> {
    this.detach();
    const g = this.graph;
    this.graph = null;
    this.buffers.clear();
    try {
      await g?.ctx.close();
    } catch {
      /* already closed */
    }
    this.set({ status: this.env.createContext ? "idle" : "unsupported" });
  }
}

const SERVER_SNAPSHOT: AudioSnapshot = { pref: DEFAULT_SOUND_PREF, status: "idle", audible: false, needsUnlock: true };

let shared: ArenaAudioManager | null = null;
/** THE manager of this page (created on first use, in the browser only). */
export function getArenaAudio(): ArenaAudioManager {
  shared ??= new ArenaAudioManager();
  return shared;
}
