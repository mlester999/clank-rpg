import type { SoundDef, SoundId } from "./sounds";

/**
 * ARENA AUDIO — the mixing POLICY: which sounds may start, which are dropped and which make room. Pure and clock-injected, so it is tested without a
 * sound card. Eight fighters can attack in the same instant; the policy keeps that a busy, readable fight and not a wall of noise:
 *
 *   · the same cue (same key) is never started twice;
 *   · a sound repeated faster than its own `minGapMs` is thinned (the countdown and the winner are never thinned);
 *   · at most `maxVoices` copies of one sound, and at most `maxTotal` voices overall;
 *   · when the mix is full, an IMPORTANT cue (lower priority number) takes the place of the least important sounding voice; an unimportant cue is
 *     dropped. Priority 0 (3 · 2 · 1, the bell, the KO of the last hero, the winner) always gets in.
 */

export interface Voice {
  id: SoundId;
  priority: number;
  startedAt: number;
  endsAt: number;
  /** Cuts the voice short (a quick fade) — called when it is stolen or the arena is muted. */
  stop: () => void;
}

export type Admission =
  | { ok: true; steal: Voice | null }
  | { ok: false; reason: "duplicate" | "throttled" | "crowded" };

export interface PolicyLimits {
  maxTotal: number;
  /** Priority-4 sounds (a whiff, an ember) are not even started once this many voices are sounding. */
  quietCap: number;
  /** How many cue keys are remembered. */
  memory: number;
}

export const DEFAULT_LIMITS: PolicyLimits = { maxTotal: 14, quietCap: 9, memory: 800 };

export class VoicePolicy {
  private readonly voices = new Set<Voice>();
  private readonly lastStart = new Map<SoundId, number>();
  private readonly seen = new Set<string>();

  constructor(private readonly limits: PolicyLimits = DEFAULT_LIMITS) {}

  get active(): number {
    return this.voices.size;
  }

  /** Decides whether a cue may start now. It does NOT start anything; call `started` once the voice is sounding. */
  admit(def: SoundDef, key: string, now: number): Admission {
    this.sweep(now);
    if (this.seen.has(key)) return { ok: false, reason: "duplicate" };
    const critical = def.priority === 0;
    const last = this.lastStart.get(def.id);
    if (!critical && last !== undefined && now - last < def.minGapMs) return { ok: false, reason: "throttled" };

    let steal: Voice | null = null;
    const same = [...this.voices].filter((v) => v.id === def.id);
    if (same.length >= def.maxVoices) {
      if (!critical && def.priority >= 2) return { ok: false, reason: "crowded" };
      steal = same.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
    }
    if (!steal && this.voices.size >= this.limits.maxTotal) {
      // the least important (highest number), oldest voice — taken only if it matters less than the newcomer
      const worst = [...this.voices].reduce((a, b) => (b.priority > a.priority || (b.priority === a.priority && b.startedAt < a.startedAt) ? b : a));
      if (worst.priority > def.priority || (critical && worst.priority >= 0)) steal = worst;
      else return { ok: false, reason: "crowded" };
    }
    if (!steal && def.priority >= 4 && this.voices.size >= this.limits.quietCap) return { ok: false, reason: "crowded" };
    return { ok: true, steal };
  }

  /** Records that a cue was accepted (its key is remembered so the same event can never sound twice). */
  remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > this.limits.memory) this.seen.delete(this.seen.values().next().value as string);
  }

  started(v: Voice): void {
    this.voices.add(v);
    this.lastStart.set(v.id, v.startedAt);
  }

  ended(v: Voice): void {
    this.voices.delete(v);
  }

  /** Cuts every voice (mute, a battle that left the stage, the Arena unmounting). */
  stopAll(): void {
    for (const v of [...this.voices]) {
      this.voices.delete(v);
      try {
        v.stop();
      } catch {
        /* a voice that cannot be stopped is already gone */
      }
    }
  }

  /** Forgets every cue key (a new battle starts clean). */
  forget(): void {
    this.seen.clear();
    this.lastStart.clear();
  }

  /** Drops voices that have finished by their own clock (a safety net for a missed `ended`). */
  private sweep(now: number): void {
    for (const v of this.voices) if (v.endsAt + 250 < now) this.voices.delete(v);
  }
}
