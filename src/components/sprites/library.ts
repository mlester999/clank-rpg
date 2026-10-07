import { safeParseManifest } from "@/domain/sprites/spec";

import type { SpriteSource } from "./compositor";

/**
 * Loads a sprite set (manifest + atlas images) ONCE per page and shares it with every canvas.
 *
 *  · all atlases load in parallel at first use, so heroes are never "popping in" mid-battle;
 *  · a broken manifest ⇒ status "failed" (everything falls back to the vector hero);
 *  · a single atlas that fails to load only costs the layers inside it (reported, not fatal).
 */

export const DEFAULT_SPRITE_SET = "clank-dev-v1";

export type LibraryStatus = "idle" | "loading" | "ready" | "failed";

export interface LibraryState {
  id: string;
  status: LibraryStatus;
  source: SpriteSource | null;
  error: string | null;
  /** Atlas keys that failed to load (their layers are skipped). */
  failedAtlases: string[];
}

const IDLE = (id: string): LibraryState => ({ id, status: "idle", source: null, error: null, failedAtlases: [] });

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
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

export interface LibraryDeps {
  fetchJson?: (url: string) => Promise<unknown>;
  loadImage?: (url: string) => Promise<CanvasImageSource>;
  factory?: (w: number, h: number) => HTMLCanvasElement;
  base?: string;
}

/** Starts (or joins) loading a set. Safe to call from many components; the work happens once. */
export function ensureSpriteSet(id: string, deps: LibraryDeps = {}): Promise<LibraryState> {
  const known = states.get(id);
  if (known && (known.status === "ready" || known.status === "failed")) return Promise.resolve(known);
  const inflight = loading.get(id);
  if (inflight) return inflight;

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
      await Promise.all(
        Object.entries(manifest.images).map(async ([key, file]) => {
          try {
            images[key] = await (deps.loadImage ?? loadImage)(`${base}/${file}`);
          } catch {
            failed.push(key);
          }
        }),
      );
      if (failed.length === Object.keys(manifest.images).length) throw new Error("no sprite atlas could be loaded");
      const state: LibraryState = { id, status: "ready", source: { manifest, images, factory: deps.factory ?? browserCanvas }, error: null, failedAtlases: failed };
      if (failed.length) console.warn(`[sprites] ${id}: atlases failed to load: ${failed.join(", ")} — their layers are skipped`);
      set(id, state);
      return state;
    } catch (e) {
      const state: LibraryState = { id, status: "failed", source: null, error: e instanceof Error ? e.message : String(e), failedAtlases: [] };
      console.warn(`[sprites] ${id}: ${state.error} — using the procedural vector hero`);
      set(id, state);
      return state;
    } finally {
      loading.delete(id);
    }
  })();
  loading.set(id, p);
  return p;
}

/** Test hook. */
export function resetSpriteLibrary(): void {
  states.clear();
  idles.clear();
  loading.clear();
}
