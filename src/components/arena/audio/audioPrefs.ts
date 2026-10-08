/**
 * The viewer's saved sound choice. localStorage, one key, two values. It is written ONLY when the viewer clicks the speaker button (or another tab
 * does) — never by a page load, a navigation, a visibility change or an error — and a missing, unreadable or foreign value means the default.
 * Every access is guarded: storage can be absent, blocked (private windows, cleared site data) or throw; the page then simply uses the default.
 */
export const SOUND_PREF_KEY = "clank.arena.sound";
export type SoundPref = "on" | "off";
/** New visitors start with sound ON — it is silent until the browser allows playback (their first tap or click), and the speaker button says so. */
export const DEFAULT_SOUND_PREF: SoundPref = "on";

type Store = Pick<Storage, "getItem" | "setItem">;

export function readSoundPref(storage: Store | null): SoundPref {
  try {
    const v = storage?.getItem(SOUND_PREF_KEY);
    return v === "on" || v === "off" ? v : DEFAULT_SOUND_PREF;
  } catch {
    return DEFAULT_SOUND_PREF;
  }
}

export function writeSoundPref(pref: SoundPref, storage: Store | null): void {
  try {
    storage?.setItem(SOUND_PREF_KEY, pref);
  } catch {
    /* blocked storage: the choice lasts until the page closes */
  }
}
