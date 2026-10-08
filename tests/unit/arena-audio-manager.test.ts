import { afterEach, describe, expect, it, vi } from "vitest";

import { ArenaAudioManager, MASTER_GAIN } from "@/components/arena/audio/ArenaAudioManager";
import { SOUND_PREF_KEY } from "@/components/arena/audio/audioPrefs";
import type { SoundCue } from "@/domain/audio/cues";
import type { SoundId } from "@/domain/audio/sounds";

import { FakeContext, fakePage, type FakeSource } from "../support/fakeAudio";

/**
 * THE ENGINE, against a Web Audio stack that behaves like a browser: it starts locked, unlocks on a gesture, runs sources and is suspended by the
 * page. What is proven: nothing sounds before it is allowed, the viewer's choice survives everything but a click, mute is instant, a hidden tab is
 * silent, a restored tab starts clean, a repeated cue sounds once, a broken audio stack never breaks the Arena.
 */

afterEach(() => vi.restoreAllMocks());

const PCM = new Float32Array(3200).fill(0.1);
const make = (pref?: string) => {
  const page = fakePage(pref);
  const manager = new ArenaAudioManager({ createContext: page.createContext, storage: page.storage, now: page.now, doc: page.doc, win: page.win, pcm: () => PCM });
  manager.attach();
  return { page, manager };
};
const cue = (id: SoundId, key: string, over: Partial<SoundCue> = {}): SoundCue => ({ id, key: `b:${key}`, battle: "b", kind: "combat", pan: 0, gain: 1, delayMs: 0, lateMs: 0, ...over });
const unlocked = async (pref?: string) => {
  const t = make(pref);
  t.manager.setStage("b", "COMBAT");
  t.page.gesture();
  await t.manager.unlock();
  await new Promise((r) => setTimeout(r, 10));
  return t;
};
const sources = (page: ReturnType<typeof fakePage>) => page.contexts.flatMap((c) => (c as unknown as FakeContext).sources);

describe("the browser's autoplay lock", () => {
  it("nothing exists before a gesture: no AudioContext on load, on attach, or when cues arrive", () => {
    const { page, manager } = make();
    manager.setStage("b", "COMBAT");
    manager.play(cue("sword_hit", "h1"));
    expect(page.contexts).toHaveLength(0);
    expect(manager.getSnapshot()).toMatchObject({ pref: "on", status: "idle", audible: false, needsUnlock: true });
    expect(manager.stats.played).toBe(0);
  });

  it("the first real gesture (any tap, click or key) unlocks it, once: the context is created inside the gesture and runs", async () => {
    const { page, manager } = make();
    page.gesture("keydown");
    await manager.unlock();
    expect(page.contexts).toHaveLength(1);
    expect(manager.getSnapshot()).toMatchObject({ status: "ready", audible: true, needsUnlock: false });
    page.gesture("pointerdown");
    page.gesture("touchend");
    await manager.unlock();
    expect(page.contexts).toHaveLength(1); // never recreated
  });

  it("a gesture the browser still refuses leaves the invitation up — no error, no spam, no crash", async () => {
    const { page, manager } = make();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const e = Object.defineProperty(new Event("pointerdown"), "isTrusted", { value: true });
    page.win.dispatchEvent(e); // allowed stays false: resume() leaves the context suspended
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.getSnapshot()).toMatchObject({ status: "idle", needsUnlock: true, audible: false });
    expect(warn).not.toHaveBeenCalled();
    page.gesture();
    await manager.unlock();
    expect(manager.getSnapshot().audible).toBe(true);
  });

  it("a script-dispatched (untrusted) event never unlocks audio — only a real gesture does", async () => {
    const { page, manager } = make();
    FakeContext.allowed = true;
    page.win.dispatchEvent(new Event("pointerdown")); // isTrusted: false
    await new Promise((r) => setTimeout(r, 10));
    expect(page.contexts).toHaveLength(0);
    expect(manager.getSnapshot().audible).toBe(false);
  });

  it("while the choice is OFF a gesture never starts audio; the speaker button (this click is the gesture) starts it", async () => {
    const { page, manager } = make("off");
    page.gesture("pointerdown");
    await manager.unlock();
    expect(page.contexts).toHaveLength(0);
    expect(manager.getSnapshot()).toMatchObject({ pref: "off", audible: false, needsUnlock: false });
    FakeContext.allowed = true;
    manager.toggle();
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.getSnapshot()).toMatchObject({ pref: "on", status: "ready", audible: true });
    expect(page.store.get(SOUND_PREF_KEY)).toBe("on");
  });

  it("a press on the speaker button itself is not also treated as 'any gesture' (it would start the sound and the click would then mute it)", async () => {
    const { page, manager } = make("on");
    const button = { closest: (sel: string) => (sel === "[data-sound-toggle]" ? button : null) } as unknown as Element;
    page.gesture("pointerdown", button);
    await new Promise((r) => setTimeout(r, 10));
    expect(page.contexts).toHaveLength(0);
    manager.toggle(); // the click: "Enable sound"
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.getSnapshot()).toMatchObject({ pref: "on", audible: true });
  });
});

describe("the viewer's choice", () => {
  it("defaults to on; reads 'off' / 'on' from storage; a foreign value means the default", () => {
    expect(make().manager.getSnapshot().pref).toBe("on");
    expect(make("off").manager.getSnapshot().pref).toBe("off");
    expect(make("on").manager.getSnapshot().pref).toBe("on");
    expect(make("loud").manager.getSnapshot().pref).toBe("on");
  });

  it("is written ONLY by the speaker button: a refresh, a visibility change, an audio error and a restore leave it exactly as it was", async () => {
    const t = await unlocked();
    t.manager.toggle(); // the viewer mutes
    expect(t.page.store.get(SOUND_PREF_KEY)).toBe("off");
    const writes = vi.spyOn(t.page.storage, "setItem");
    // everything else the page can do
    t.page.hide();
    t.page.show();
    t.page.win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    for (let i = 0; i < 3; i++) t.page.gesture("pointerdown");
    // a refresh = a new manager on the same storage
    const reloaded = new ArenaAudioManager({ createContext: t.page.createContext, storage: t.page.storage, now: t.page.now, doc: t.page.doc, win: t.page.win, pcm: () => PCM });
    reloaded.attach();
    expect(reloaded.getSnapshot().pref).toBe("off");
    expect(writes).not.toHaveBeenCalled();
    expect(t.page.store.get(SOUND_PREF_KEY)).toBe("off");
  });

  it("a click while audible mutes; the next click unmutes — and each is saved", async () => {
    const t = await unlocked();
    expect(t.manager.getSnapshot().audible).toBe(true);
    t.manager.toggle();
    expect(t.manager.getSnapshot()).toMatchObject({ pref: "off", audible: false });
    expect(t.page.store.get(SOUND_PREF_KEY)).toBe("off");
    t.manager.toggle();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.manager.getSnapshot()).toMatchObject({ pref: "on", audible: true });
    expect(t.page.store.get(SOUND_PREF_KEY)).toBe("on");
    expect(t.page.contexts).toHaveLength(1); // one context for the whole session
  });

  it("another tab's change is followed (the storage event); blocked storage falls back to the default without throwing", async () => {
    const t = await unlocked();
    t.page.store.set(SOUND_PREF_KEY, "off");
    t.page.win.dispatchEvent(Object.assign(new Event("storage"), { key: SOUND_PREF_KEY }));
    expect(t.manager.getSnapshot()).toMatchObject({ pref: "off", audible: false });
    const blocked = new ArenaAudioManager({ createContext: t.page.createContext, storage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }, doc: t.page.doc, win: t.page.win, pcm: () => PCM });
    blocked.attach();
    expect(blocked.getSnapshot().pref).toBe("on");
    expect(() => blocked.toggle()).not.toThrow();
  });
});

describe("mute is instant, unmute is instant", () => {
  it("muting cuts every sounding voice, zeroes the master gain and suspends the context — before the click handler returns", async () => {
    const t = await unlocked();
    for (let i = 0; i < 4; i++) t.manager.play(cue((["sword_hit", "mace_hit", "arrow_hit", "magic_hit"] as const)[i]!, `k${i}`));
    const ctx = t.page.contexts[0] as unknown as FakeContext;
    const live = sources(t.page).filter((s) => s.startedAt !== null);
    expect(live.length).toBe(4);
    const master = ctx.gains.find((g) => [...g.out].some((n) => ctx.compressors.includes(n as never)))!;
    expect(master.gain.value).toBeCloseTo(MASTER_GAIN * 0.85, 2);
    t.manager.toggle();
    expect(live.every((s) => s.stoppedAt !== null)).toBe(true);
    expect(master.gain.value).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.state).toBe("suspended");
    // and nothing plays while muted
    const before = sources(t.page).length;
    t.manager.play(cue("sword_hit", "after-mute"));
    expect(sources(t.page).length).toBe(before);
  });

  it("unmuting brings the sound back at once with the SAME context", async () => {
    const t = await unlocked();
    t.manager.toggle();
    t.manager.toggle();
    await new Promise((r) => setTimeout(r, 10));
    t.manager.play(cue("sword_hit", "back"));
    expect(sources(t.page).filter((s) => s.startedAt !== null).length).toBe(1);
    expect(t.page.contexts).toHaveLength(1);
  });
});

describe("only what the server recorded, only when it is due", () => {
  it("combat cues are refused before the bell (INTRO / COUNTDOWN) and for any battle that is not on stage; phase cues are not combat", async () => {
    const t = await unlocked();
    for (const phase of ["IDLE", "INTRO", "COUNTDOWN", "RESULTS", "DONE"]) {
      t.manager.setStage("b", phase);
      t.manager.play(cue("sword_hit", `x-${phase}`));
    }
    t.manager.setStage("b", "COMBAT");
    t.manager.play(cue("sword_hit", "other", { battle: "someone-else" }));
    expect(sources(t.page).filter((s) => s.startedAt !== null).length).toBe(0);
    t.manager.setStage("b", "COUNTDOWN");
    t.manager.play(cue("cd_2", "cd2", { kind: "phase" }));
    expect(sources(t.page).filter((s) => s.startedAt !== null).length).toBe(1);
  });

  it("a cue is accepted once per key — a re-delivered event, a remounted renderer, a retried request sound nothing", async () => {
    const t = await unlocked();
    for (let i = 0; i < 5; i++) t.manager.play(cue("sword_hit", "same-event"));
    expect(sources(t.page).filter((s) => s.startedAt !== null).length).toBe(1);
    expect(t.manager.stats.duplicate).toBe(4);
  });

  it("a combat cue that is already old (a stalled frame, a tab that was asleep) is dropped, not played late", async () => {
    const t = await unlocked();
    t.manager.play(cue("sword_hit", "old", { lateMs: 900 }));
    t.manager.play(cue("sword_hit", "fresh", { lateMs: 30 }));
    expect(sources(t.page).filter((s) => s.startedAt !== null).length).toBe(1);
    expect(t.manager.stats.stale).toBe(1);
  });

  it("a delayed cue (a cast's release) is scheduled on the audio clock, not played now; a new battle starts clean and cuts the old one", async () => {
    const t = await unlocked();
    const ctx = t.page.contexts[0] as unknown as FakeContext;
    ctx.currentTime = 10;
    t.manager.play(cue("skill_burst", "burst", { delayMs: 400 }));
    const s = sources(t.page).find((x) => x.startedAt !== null)!;
    expect(s.startedAt).toBeCloseTo(10.4, 3);
    t.manager.setStage("next-battle", "INTRO");
    expect(s.stoppedAt).not.toBeNull(); // the old battle's sounds are cut
    t.manager.setStage("next-battle", "COMBAT");
    t.manager.play(cue("sword_hit", "same-key-new-battle", { battle: "next-battle" }));
    expect(sources(t.page).filter((x) => x.startedAt !== null).length).toBe(2);
  });

  it("deterministic variation: the same cue key always has the same pitch", async () => {
    const rate = async () => {
      const t = await unlocked();
      t.manager.play(cue("sword_hit", "pitch-key"));
      return (sources(t.page).find((x) => x.startedAt !== null) as unknown as FakeSource).playbackRate.value;
    };
    expect(await rate()).toBe(await rate());
    expect(Math.abs(Math.log2(await rate()) * 12)).toBeLessThanOrEqual(1);
  });

  it("priority cues (3 · 2 · 1, the bell, the winner) take the un-ducked bus and duck the ordinary effects", async () => {
    const t = await unlocked();
    t.manager.setStage("b", "COUNTDOWN");
    const ctx = t.page.contexts[0] as unknown as FakeContext;
    t.manager.play(cue("cd_3", "cd3", { kind: "phase" }));
    const ducked = ctx.gains.filter((g) => g.gain.calls.some((c) => c.op === "target" && c.v === 0.5));
    expect(ducked.length).toBe(1);
  });
});

describe("hidden tabs, back/forward restores and the Arena unmounting", () => {
  it("a hidden tab is silent and parked; coming back resumes it with a clean slate", async () => {
    const t = await unlocked();
    t.manager.play(cue("sword_hit", "h"));
    const live = sources(t.page).filter((s) => s.startedAt !== null);
    t.page.hide();
    await new Promise((r) => setTimeout(r, 10));
    expect(live.every((s) => s.stoppedAt !== null)).toBe(true);
    expect(t.manager.getSnapshot().audible).toBe(false);
    const n = sources(t.page).length;
    t.manager.play(cue("sword_hit", "while-hidden"));
    expect(sources(t.page).length).toBe(n);
    t.page.show();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.manager.getSnapshot().audible).toBe(true);
    t.manager.play(cue("sword_hit", "h")); // the key from before the break is forgotten: a fresh page does not carry stale state
    expect(sources(t.page).length).toBe(n + 1);
    expect(t.manager.getSnapshot().pref).toBe("on");
  });

  it("a back/forward-cache restore invalidates what was scheduled and re-syncs, without touching the choice", async () => {
    const t = await unlocked();
    t.manager.play(cue("skill_burst", "late-burst", { delayMs: 500 }));
    const s = sources(t.page).find((x) => x.startedAt !== null)!;
    t.page.win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(s.stoppedAt).not.toBeNull();
    expect(t.manager.getSnapshot().pref).toBe("on");
  });

  it("leaving the Arena cuts every voice and parks the context; coming back reuses it", async () => {
    const t = await unlocked();
    t.manager.play(cue("sword_hit", "bye"));
    const live = sources(t.page).filter((s) => s.startedAt !== null);
    t.manager.detach();
    expect(live.every((s) => s.stoppedAt !== null)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect((t.page.contexts[0] as unknown as FakeContext).state).toBe("suspended");
    t.manager.attach();
    t.page.gesture();
    await t.manager.unlock();
    expect(t.page.contexts).toHaveLength(1);
    expect(t.manager.getSnapshot().audible).toBe(true);
  });

  it("the browser interrupting the context (a phone call, a power-save) brings the 'Enable sound' invitation back — and a tap restores it", async () => {
    const t = await unlocked();
    (t.page.contexts[0] as unknown as FakeContext).change("interrupted");
    expect(t.manager.getSnapshot()).toMatchObject({ audible: false, needsUnlock: true });
    t.page.gesture();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.manager.getSnapshot().audible).toBe(true);
  });
});

describe("an audio failure never reaches the Arena", () => {
  it("no Web Audio at all: 'unsupported', buttons and cues do nothing, nothing throws", () => {
    const page = fakePage();
    const m = new ArenaAudioManager({ createContext: null, storage: page.storage, doc: page.doc, win: page.win, pcm: () => PCM });
    m.attach();
    expect(m.getSnapshot()).toMatchObject({ status: "unsupported", needsUnlock: false, audible: false });
    expect(() => { m.toggle(); m.play(cue("sword_hit", "x")); m.stopAll(); m.detach(); }).not.toThrow();
  });

  it("a context that throws on creation, or a graph that throws while playing: 'error' state, a single warning, the choice untouched, no exception", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = fakePage();
    const boom = new ArenaAudioManager({ createContext: () => { throw new Error("no audio device"); }, storage: page.storage, doc: page.doc, win: page.win, pcm: () => PCM });
    boom.attach();
    page.gesture();
    await expect(boom.unlock()).resolves.toBeUndefined();
    expect(boom.getSnapshot()).toMatchObject({ status: "error", pref: "on" });
    expect(page.store.has(SOUND_PREF_KEY)).toBe(false);
    expect(() => boom.play(cue("sword_hit", "x"))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);

    const t = await unlocked();
    (t.page.contexts[0] as unknown as FakeContext).createBufferSource = () => { throw new Error("graph broke"); };
    expect(() => t.manager.play(cue("sword_hit", "g"))).not.toThrow();
    expect(t.manager.getSnapshot().status).toBe("error");
  });
});
