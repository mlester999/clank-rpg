import { describe, expect, it } from "vitest";

import { VoicePolicy, type Voice } from "@/domain/audio/policy";
import { SOUNDS, type SoundId } from "@/domain/audio/sounds";

/** The mixing policy, on its own clock: what starts, what is thinned, what makes room. */

const voice = (id: SoundId, at: number, over: Partial<Voice> = {}): Voice => ({ id, priority: SOUNDS[id].priority, startedAt: at, endsAt: at + 400, stop: () => undefined, ...over });

function present(p: VoicePolicy, id: SoundId, key: string, now: number): "played" | string {
  const a = p.admit(SOUNDS[id], key, now);
  if (!a.ok) return a.reason;
  if (a.steal) p.ended(a.steal);
  p.remember(key);
  p.started(voice(id, now));
  return "played";
}

describe("duplicates and repeats", () => {
  it("the same cue key never sounds twice, however it is delivered", () => {
    const p = new VoicePolicy();
    expect(present(p, "sword_hit", "b:1:2:0:1", 0)).toBe("played");
    expect(present(p, "sword_hit", "b:1:2:0:1", 5000)).toBe("duplicate");
    expect(present(p, "cd_3", "b:cd3", 0)).toBe("played");
    expect(present(p, "cd_3", "b:cd3", 9000)).toBe("duplicate");
  });

  it("a sound repeated faster than its own minimum gap is thinned (machine-gunning); the countdown and the winner are never thinned", () => {
    const p = new VoicePolicy();
    expect(present(p, "sword_hit", "a", 0)).toBe("played");
    expect(present(p, "sword_hit", "b", SOUNDS.sword_hit.minGapMs - 1)).toBe("throttled");
    expect(present(p, "sword_hit", "c", SOUNDS.sword_hit.minGapMs + 1)).toBe("played");
    expect(present(p, "cd_1", "x", 0)).toBe("played");
    expect(present(p, "cd_1", "y", 10)).toBe("played"); // priority 0: never thinned
  });

  it("forgetting a battle clears its keys: the next battle's first sounds are fresh", () => {
    const p = new VoicePolicy();
    present(p, "ko", "b1:ko", 0);
    p.forget();
    expect(present(p, "ko", "b1:ko", 10_000)).toBe("played");
  });
});

describe("a crowd: eight fighters at once", () => {
  it("never more than a sound's own voice limit — extra impacts are dropped, an important one steals the oldest copy", () => {
    const p = new VoicePolicy();
    const max = SOUNDS.sword_hit.maxVoices;
    let played = 0;
    for (let i = 0; i < max + 4; i++) if (present(p, "sword_hit", `h${i}`, i * (SOUNDS.sword_hit.minGapMs + 1)) === "played") played++;
    expect(played).toBe(max);
    expect(p.active).toBeLessThanOrEqual(max);
    // a priority-0 cue of the same sound would take the oldest slot
    expect(present(p, "cd_1", "cd", 10)).toBe("played");
  });

  it("the total is capped; when the mix is full a more important cue takes the least important voice and a less important one is dropped", () => {
    const p = new VoicePolicy({ maxTotal: 6, quietCap: 4, memory: 100 });
    const stopped: SoundId[] = [];
    const fill: SoundId[] = ["sword_swing", "mace_swing", "dagger_swing", "bow_release", "orb_cast", "bolt_cast"];
    fill.forEach((id, i) => {
      const a = p.admit(SOUNDS[id], `f${i}`, i * 200);
      expect(a.ok).toBe(true);
      p.remember(`f${i}`);
      p.started(voice(id, i * 200, { stop: () => stopped.push(id), endsAt: 99_999 }));
    });
    expect(p.active).toBe(6);
    // an unimportant newcomer (priority 4) does not get in
    expect(present(p, "miss_whiff", "w", 1300)).toBe("crowded");
    // an equally unimportant swing (priority 3) does not push out another swing either
    expect(present(p, "dagger_swing", "d2", 1400)).toBe("crowded");
    // the winner's fanfare (0) always gets in, by taking the oldest least-important voice
    const v = p.admit(SOUNDS.victory, "v", 1500);
    expect(v.ok && v.steal?.id).toBeTruthy();
    // a KO (1) takes a swing (3) too
    const p2 = new VoicePolicy({ maxTotal: 2, quietCap: 2, memory: 50 });
    for (const [id, key, at] of [["sword_swing", "s1", 0], ["mace_swing", "s2", 100]] as const) {
      p2.admit(SOUNDS[id], key, at);
      p2.remember(key);
      p2.started(voice(id, at, { endsAt: 99_999 }));
    }
    const ko = p2.admit(SOUNDS.ko, "k", 200);
    expect(ko.ok && ko.steal?.id).toBe("sword_swing");
  });

  it("quiet, unimportant sounds (a whiff, an ember) are not even started once the mix is busy", () => {
    const p = new VoicePolicy({ maxTotal: 14, quietCap: 3, memory: 50 });
    for (let i = 0; i < 3; i++) present(p, (["sword_hit", "mace_hit", "arrow_hit"] as const)[i]!, `q${i}`, i * 100);
    expect(present(p, "hazard_tick", "e", 400)).toBe("crowded");
  });

  it("stopAll cuts everything at once (mute, a battle leaving the stage)", () => {
    const p = new VoicePolicy();
    const stopped: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = (["sword_hit", "mace_hit", "arrow_hit", "magic_hit"] as const)[i]!;
      p.admit(SOUNDS[id], `s${i}`, i * 100);
      p.started(voice(id, i * 100, { stop: () => stopped.push(i) }));
    }
    p.stopAll();
    expect(stopped.sort()).toEqual([0, 1, 2, 3]);
    expect(p.active).toBe(0);
  });

  it("voices that never reported their end are swept by their own clock (a missed `ended` cannot jam the mixer)", () => {
    const p = new VoicePolicy({ maxTotal: 2, quietCap: 2, memory: 50 });
    p.started(voice("sword_swing", 0, { endsAt: 300 }));
    p.started(voice("mace_swing", 0, { endsAt: 300 }));
    expect(present(p, "dagger_swing", "late", 5000)).toBe("played");
  });
});
