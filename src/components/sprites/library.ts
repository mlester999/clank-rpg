import { safeParseManifest } from "@/domain/sprites/spec";
import { V3_SET, V3_SET_ID, v3Manifest } from "@/domain/sprites/v3/set";

import type { AtlasStatus, SpriteSource } from "./compositor";

/**
 * Loads a sprite set (manifest + atlas images) ONCE per page and shares it with every canvas.
 *
 *  · a block-layout set (v1): all atlases load in parallel at first use, so heroes are never "popping in" mid-battle;
 *  · a PACKED set (v2 — one atlas page per skeleton, eighteen skeletons): only the pages of the heroes actually drawn are fetched, the first time
 *    one of them is asked for (`source.ensure`), and the arena asks for its eight as soon as the battle is known — long before the bell. A set
 *    of eighteen skeletons costs a page only for each skeleton on screen, not all of them;
 *  · a broken manifest ⇒ status "failed" (everything falls back to the vector hero) — but a failure is NOT final: a request that failed
 *    (a flaky network, a server that was busy) is retried with backoff, so one bad moment never leaves a viewer on the vector fallback for the
 *    rest of the session;
 *  · a single atlas that fails to load only costs the layers inside it (reported, not fatal) after its own retries.
 */

/** Backoff between whole-set attempts after a failure (ms); after the last one the set stays "failed" until the page reloads. */
export const SPRITE_RETRY_MS = [1500, 4000, 10_000, 30_000] as const;
/** Each atlas image is tried this many times within one attempt. */
const IMAGE_TRIES = 3;
const attempts = new Map<string, number>();

/**
 * The set a page draws with until the server has said which one is live (`visuals.spriteSet`, see `announceSpriteSet`): the set that was live
 * before hero renderer v3, so shipping v3's code changes nothing on screen until the setting itself is switched. Every set stays shipped and
 * selectable (`clank-v3`, `clank-dev-v2`, `clank-dev-v1`): the same stored looks draw in any of them.
 */
export const DEFAULT_SPRITE_SET = "clank-dev-v2";

const ACTIVE_KEY = "clank.spriteSet";
const SET_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
let active: string | null = null;
const activeListeners = new Set<() => void>();

/**
 * The sprite set the server says is live, as last heard on this device (the Arena state carries it; a hero page's look carries it too) —
 * remembered across pages, so a portrait on a page that does not load the settings draws in the same set as the Arena.
 */
export function activeSpriteSet(): string {
  if (active !== null) return active;
  let stored: string | null = null;
  try {
    stored = typeof localStorage !== "undefined" ? localStorage.getItem(ACTIVE_KEY) : null;
  } catch {
    stored = null; // storage blocked: the default until the server says otherwise
  }
  return (active = stored && SET_ID.test(stored) ? stored : DEFAULT_SPRITE_SET);
}

/** The server said which set is live (`visuals.spriteSet`): every portrait that does not name a set follows it from now on. */
export function announceSpriteSet(id: string | null | undefined): void {
  if (!id || !SET_ID.test(id) || id === activeSpriteSet()) return;
  active = id;
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // not remembered across pages; this page still follows it
  }
  for (const fn of activeListeners) fn();
}

export function subscribeActiveSpriteSet(fn: () => void): () => void {
  activeListeners.add(fn);
  return () => activeListeners.delete(fn);
}

export type LibraryStatus = "idle" | "loading" | "ready" | "failed";

export interface LibraryState {
  id: string;
  status: LibraryStatus;
  source: SpriteSource | null;
  error: string | null;
  /** Atlas keys that failed to load (their layers are skipped; a hero whose own skeleton page failed is drawn with the vector fallback). */
  failedAtlases: string[];
  /** Bumped whenever a lazily loaded atlas page arrives (or fails): a still portrait redraws then. */
  rev: number;
}

const IDLE = (id: string): LibraryState => ({ id, status: "idle", source: null, error: null, failedAtlases: [], rev: 0 });

const states = new Map<string, LibraryState>();
const loading = new Map<string, Promise<LibraryState>>();
const listeners = new Set<() => void>();

const set = (id: string, next: LibraryState) => {
  states.set(id, next);
  for (const l of listeners) l();
};

const idles = new Map<string, LibraryState>();

/** The not-yet-loaded state. Cached: snapshots must be referentially stable (useSyncExternalStore). */
export function getIdleState(id: string): LibraryState {
  let idle = idles.get(id);
  if (!idle) idles.set(id, (idle = IDLE(id)));
  return idle;
}

export function getLibraryState(id: string): LibraryState {
  return states.get(id) ?? getIdleState(id);
}

export function subscribeLibrary(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const browserCanvas = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    // decoded off the main thread BEFORE the set is ready: the first composition of a hero never stalls a frame on decoding an atlas
    img.onload = () => {
      if (typeof img.decode !== "function") return resolve(img);
      img.decode().then(() => resolve(img), () => resolve(img));
    };
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

export interface LibraryDeps {
  fetchJson?: (url: string) => Promise<unknown>;
  loadImage?: (url: string) => Promise<CanvasImageSource>;
  factory?: (w: number, h: number) => HTMLCanvasElement;
  base?: string;
  /** Test hook: how a retry is scheduled (default setTimeout). */
  schedule?: (fn: () => void, ms: number) => void;
}

async function loadWithRetry(load: (url: string) => Promise<CanvasImageSource>, url: string): Promise<CanvasImageSource> {
  let last: unknown;
  for (let i = 0; i < IMAGE_TRIES; i++) {
    try {
      return await load(i === 0 ? url : `${url}${url.includes("?") ? "&" : "?"}retry=${i}`);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Starts (or joins) loading a set. Safe to call from many components; the work happens once. */
export function ensureSpriteSet(id: string, deps: LibraryDeps = {}): Promise<LibraryState> {
  const known = states.get(id);
  if (known && (known.status === "ready" || known.status === "failed")) return Promise.resolve(known);
  const inflight = loading.get(id);
  if (inflight) return inflight;

  if (id === V3_SET_ID) {
    // the procedural set draws itself: ready at once, nothing to download (a hero's strips are generated on first use)
    const source: SpriteSource = { manifest: v3Manifest(), images: {}, factory: deps.factory ?? browserCanvas, procedural: V3_SET };
    const state: LibraryState = { id, status: "ready", source, error: null, failedAtlases: [], rev: 0 };
    set(id, state);
    return Promise.resolve(state);
  }
  const base = deps.base ?? `/sprites/${id}`;
  const p = (async (): Promise<LibraryState> => {
    set(id, { ...IDLE(id), status: "loading" });
    try {
      const raw = await (deps.fetchJson ? deps.fetchJson(`${base}/manifest.json`) : fetch(`${base}/manifest.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest ${r.status}`)))));
      const parsed = safeParseManifest(raw);
      if (!parsed.ok) throw new Error(`invalid sprite manifest: ${parsed.error}`);
      const manifest = parsed.manifest;
      const images: SpriteSource["images"] = {};
      const failed: string[] = [];
      const load = deps.loadImage ?? loadImage;
      // a packed set loads its skeleton pages on demand; what block-layout layers use (the auras) is loaded now
      const lazy = (manifest.rigs?.length ?? 0) > 0;
      const eager = lazy ? [...new Set(Object.values(manifest.layers).flatMap((l) => (l.image !== undefined && !l.cells ? [l.image] : [])))] : Object.keys(manifest.images);
      await Promise.all(
        eager.map(async (key) => {
          try {
            images[key] = await loadWithRetry(load, `${base}/${manifest.images[key]}`);
          } catch {
            failed.push(key);
          }
        }),
      );
      if (!lazy && failed.length === Object.keys(manifest.images).length) throw new Error("no sprite atlas could be loaded");
      const source: SpriteSource = { manifest, images, factory: deps.factory ?? browserCanvas };
      if (lazy) source.ensure = lazyPages(id, base, source, failed, load);
      const state: LibraryState = { id, status: "ready", source, error: null, failedAtlases: [...failed], rev: 0 };
      if (failed.length) console.warn(`[sprites] ${id}: atlases failed to load: ${failed.join(", ")} — their layers are skipped`);
      attempts.delete(id);
      set(id, state);
      return state;
    } catch (e) {
      const state: LibraryState = { id, status: "failed", source: null, error: e instanceof Error ? e.message : String(e), failedAtlases: [], rev: 0 };
      const n = attempts.get(id) ?? 0;
      const wait = SPRITE_RETRY_MS[n];
      console.warn(`[sprites] ${id}: ${state.error} — using the procedural vector hero${wait !== undefined ? `, retrying in ${wait} ms` : ""}`);
      set(id, state);
      if (wait !== undefined) {
        attempts.set(id, n + 1);
        (deps.schedule ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
          if (states.get(id)?.status !== "failed") return;
          states.delete(id);
          void ensureSpriteSet(id, deps);
        }, wait);
      }
      return state;
    } finally {
      loading.delete(id);
    }
  })();
  loading.set(id, p);
  return p;
}

const pageRetries = new Map<string, () => void>();

/**
 * The on-demand loader of a packed set's pages (`SpriteSource.ensure`): the first ask for a page starts it (with its own retries); every arrival
 * or failure bumps the library state's `rev`, so still portraits redraw. A page that failed every try stays failed until the network comes back
 * (`retrySpriteSetNow`) — the hero is drawn with the vector fallback meanwhile, never as an empty space.
 */
function lazyPages(id: string, base: string, source: SpriteSource, failedAtStart: string[], load: (url: string) => Promise<CanvasImageSource>): (keys: readonly string[]) => AtlasStatus {
  const inflight = new Set<string>();
  const failed = new Set(failedAtStart);
  const bump = () => {
    const cur = states.get(id);
    if (cur?.source === source) set(id, { ...cur, failedAtlases: [...failed], rev: cur.rev + 1 });
  };
  pageRetries.set(id, () => {
    if (failed.size === 0) return;
    failed.clear();
    bump();
  });
  return (keys) => {
    let status: AtlasStatus = "ready";
    for (const key of keys) {
      if (source.images[key]) continue;
      if (failed.has(key) || !source.manifest.images[key]) {
        status = "failed";
        continue;
      }
      if (status === "ready") status = "loading";
      if (inflight.has(key)) continue;
      inflight.add(key);
      void loadWithRetry(load, `${base}/${source.manifest.images[key]}`).then(
        (img) => {
          source.images[key] = img;
        },
        () => {
          failed.add(key);
          console.warn(`[sprites] ${id}: atlas ${key} failed to load — heroes drawn from it use the vector fallback`);
        },
      ).finally(() => {
        inflight.delete(key);
        bump();
      });
    }
    return status;
  };
}

/**
 * Retry a set that FAILED right away (the connection came back, the tab was restored): the backoff is for a server that keeps failing, not a
 * reason to keep a viewer on the vector fallback once the network is back. No-op while it is loading or once it is ready.
 */
export function retrySpriteSetNow(id: string, deps: LibraryDeps = {}): void {
  if (states.get(id)?.status === "ready") pageRetries.get(id)?.(); // a lazily loaded page that failed gets another chance
  if (states.get(id)?.status !== "failed" || loading.has(id)) return;
  states.delete(id);
  void ensureSpriteSet(id, deps);
}

/** Test hook. */
export function resetSpriteLibrary(): void {
  active = null;
  pageRetries.clear();
  states.clear();
  idles.clear();
  loading.clear();
  attempts.clear();
}
