"use client";

import { SpeakerIcon, SpeakerOffIcon } from "@/components/ui/Icons";

import type { ArenaAudioManager, AudioSnapshot } from "./ArenaAudioManager";

/**
 * The speaker at the bottom-right of the Live Arena.
 *
 *   sound on (audible)                 speaker with waves   · tooltip "Sound On"   · click mutes
 *   muted                               speaker with a cross · tooltip "Sound Off"  · click turns it on
 *   on, but the browser has not allowed it yet   speaker with waves, pulsing · "Enable sound" · click (or any first tap) allows it
 *
 * A real <button>: keyboard-operable, a visible focus ring, a 44 px touch target, an accessible name that says what a press DOES. It sits in the
 * stage's corner and never over the combat HUD (the stage hint keeps clear of it).
 */
export function SoundToggleView({ snapshot, onToggle }: { snapshot: AudioSnapshot; onToggle?: () => void }) {
  const { pref, status, audible, needsUnlock } = snapshot;
  const unavailable = status === "unsupported" || status === "error";
  const state = unavailable ? "unavailable" : pref === "off" ? "off" : audible ? "on" : "locked";
  const tip = unavailable ? "Sound unavailable" : state === "on" ? "Sound On" : state === "off" ? "Sound Off" : "Enable sound";
  const label = unavailable ? "Sound is unavailable in this browser" : state === "on" ? "Mute Arena sound" : state === "off" ? "Turn Arena sound on" : "Enable Arena sound";
  const Icon = state === "on" || state === "locked" ? SpeakerIcon : SpeakerOffIcon;
  return (
    <div className="group pointer-events-none absolute right-1 bottom-1 z-20 sm:right-2 sm:bottom-2">
      <span
        role="tooltip"
        id="sound-toggle-tip"
        className="absolute right-full bottom-1.5 mr-1.5 hidden rounded bg-ink-950/90 px-2 py-1 text-[0.7rem] font-semibold whitespace-nowrap text-paper ring-1 ring-clank-400/40 group-focus-within:block group-hover:block"
      >
        {tip}
      </span>
      <button
        type="button"
        onClick={onToggle}
        disabled={unavailable}
        aria-label={label}
        aria-describedby="sound-toggle-tip"
        title={tip}
        data-sound-toggle
        data-testid="sound-toggle"
        data-sound={state}
        data-pref={pref}
        data-needs-unlock={needsUnlock ? "true" : "false"}
        className={`pointer-events-auto relative grid h-11 w-11 place-items-center rounded-lg border bg-ink-950/80 text-paper shadow-[0_0_0_1px_rgba(0,0,0,.4)] backdrop-blur-[2px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-clank-300 enabled:hover:bg-clank-700/60 enabled:active:translate-y-px disabled:opacity-50 ${
          state === "on" ? "border-clank-400/60 text-clank-200" : state === "locked" ? "border-gold/60 text-gold" : "border-white/15 text-steel-300"
        }`}
      >
        <Icon size={20} />
        {state === "locked" && <span aria-hidden className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 animate-ping rounded-full bg-gold/80" />}
      </button>
    </div>
  );
}

export function SoundToggle({ audio, snapshot }: { audio: ArenaAudioManager; snapshot: AudioSnapshot }) {
  return <SoundToggleView snapshot={snapshot} onToggle={() => audio.toggle()} />;
}
