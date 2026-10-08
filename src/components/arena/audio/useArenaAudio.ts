"use client";

import { useEffect, useSyncExternalStore } from "react";

import { getArenaAudio, type ArenaAudioManager, type AudioSnapshot } from "./ArenaAudioManager";

/**
 * The Arena's sound, for a component: the live snapshot (preference · engine status · audible · needs a click) and the manager itself. The manager is
 * attached while the Arena is mounted (listeners for visibility / restore / the first gesture) and detached — voices cut, context parked — when it
 * leaves. React re-renders only when the snapshot changes: cues never go through React.
 */
export function useArenaAudio(): { audio: ArenaAudioManager; snapshot: AudioSnapshot } {
  const audio = getArenaAudio();
  const snapshot = useSyncExternalStore(audio.subscribe, audio.getSnapshot, audio.getServerSnapshot);
  useEffect(() => {
    audio.attach();
    return () => audio.detach();
  }, [audio]);
  return { audio, snapshot };
}
