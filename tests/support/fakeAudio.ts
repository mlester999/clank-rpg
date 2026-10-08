/**
 * A faithful-enough Web Audio stack for the engine's tests: a context that starts SUSPENDED (the browser's autoplay lock) and only runs once it
 * is resumed after a user gesture; a graph of nodes that records what is connected to what; sources that record when they were scheduled and
 * stopped. `ended()` plays the part of the browser finishing a sound.
 */

export class FakeParam {
  value = 1;
  readonly calls: Array<{ op: string; v?: number; t?: number }> = [];
  setValueAtTime(v: number, t: number) { this.value = v; this.calls.push({ op: "set", v, t }); return this; }
  linearRampToValueAtTime(v: number, t: number) { this.value = v; this.calls.push({ op: "ramp", v, t }); return this; }
  setTargetAtTime(v: number, t: number) { this.calls.push({ op: "target", v, t }); return this; }
  cancelScheduledValues(t: number) { this.calls.push({ op: "cancel", t }); return this; }
}

export class FakeNode {
  readonly out = new Set<FakeNode>();
  connect(n: FakeNode) { this.out.add(n); return n; }
  disconnect() { this.out.clear(); }
}
export class FakeGain extends FakeNode { gain = new FakeParam(); }
export class FakePanner extends FakeNode { pan = new FakeParam(); }
export class FakeCompressor extends FakeNode { threshold = new FakeParam(); knee = new FakeParam(); ratio = new FakeParam(); attack = new FakeParam(); release = new FakeParam(); }
export class FakeBuffer { constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {} get duration() { return this.length / this.sampleRate; } copyToChannel() {} }
export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  playbackRate = new FakeParam();
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  start(t = 0) { this.startedAt = t; }
  stop(t = 0) { this.stoppedAt = t; }
  end() { this.onended?.(); }
}
export class FakeDestination extends FakeNode {}

export class FakeContext {
  state: "suspended" | "running" | "closed" | "interrupted" = "suspended";
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly destination = new FakeDestination();
  onstatechange: (() => void) | null = null;
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly panners: FakePanner[] = [];
  readonly compressors: FakeCompressor[] = [];
  readonly buffers: FakeBuffer[] = [];
  /** The browser's autoplay policy: a resume() only succeeds once the page has had a user gesture. */
  static allowed = false;
  resumes = 0;
  suspends = 0;
  closed = false;
  async resume() { this.resumes++; if (FakeContext.allowed && this.state !== "closed") this.change("running"); }
  async suspend() { this.suspends++; if (this.state === "running") this.change("suspended"); }
  async close() { this.closed = true; this.change("closed"); }
  change(s: FakeContext["state"]) { this.state = s; this.onstatechange?.(); }
  createGain() { const g = new FakeGain(); this.gains.push(g); return g as unknown as GainNode; }
  createStereoPanner() { const p = new FakePanner(); this.panners.push(p); return p as unknown as StereoPannerNode; }
  createDynamicsCompressor() { const c = new FakeCompressor(); this.compressors.push(c); return c as unknown as DynamicsCompressorNode; }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s as unknown as AudioBufferSourceNode; }
  createBuffer(ch: number, len: number, sr: number) { const b = new FakeBuffer(ch, len, sr); this.buffers.push(b); return b as unknown as AudioBuffer; }
}

/** A page: window + document as event targets, a visibility flag, localStorage, and the autoplay lock. */
export function fakePage(initialPref?: string) {
  const store = new Map<string, string>();
  if (initialPref !== undefined) store.set("clank.arena.sound", initialPref);
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const win = new EventTarget() as unknown as Window;
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as "visible" | "hidden" }) as unknown as Document & { visibilityState: "visible" | "hidden" };
  const contexts: FakeContext[] = [];
  FakeContext.allowed = false;
  let clock = 1000;
  return {
    store, storage, win, doc, contexts,
    createContext: () => { const c = new FakeContext(); contexts.push(c); return c as unknown as AudioContext; },
    now: () => clock,
    tick: (ms: number) => { clock += ms; },
    /** A real user gesture: the browser now lets audio run, and the page hears pointerdown / keydown. */
    gesture: (type = "pointerdown", target?: Element) => {
      FakeContext.allowed = true;
      const e = new Event(type) as Event & { isTrusted: boolean };
      Object.defineProperty(e, "target", { value: target ?? null });
      Object.defineProperty(e, "isTrusted", { value: true }); // a real gesture is trusted: script-dispatched events never unlock audio
      win.dispatchEvent(e);
    },
    hide: () => { doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); },
    show: () => { doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); },
  };
}
