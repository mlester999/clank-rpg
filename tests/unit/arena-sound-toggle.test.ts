import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AudioSnapshot } from "@/components/arena/audio/ArenaAudioManager";
import { SoundToggleView } from "@/components/arena/audio/SoundToggle";

/** The speaker at the bottom-right of the Live Arena, in every state it can be in. */
const snap = (over: Partial<AudioSnapshot> = {}): AudioSnapshot => ({ pref: "on", status: "ready", audible: true, needsUnlock: false, ...over });
const html = (s: AudioSnapshot) => renderToStaticMarkup(createElement(SoundToggleView, { snapshot: s, onToggle: () => undefined }));
const text = (h: string) => h.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
// the cross of the muted speaker (two diagonal strokes) and the sound waves of the playing one
const WAVES = "M15.54 8.46a5 5 0 0 1 0 7.07";
const CROSS = 'd="m22 9-6 6"';

describe("the speaker button", () => {
  it("sound ON: a speaker with sound waves, 'Sound On', clicking it mutes", () => {
    const h = html(snap());
    expect(h).toContain(WAVES);
    expect(h).not.toContain(CROSS);
    expect(text(h)).toContain("Sound On");
    expect(h).toContain('aria-label="Mute Arena sound"');
    expect(h).toContain('data-sound="on"');
  });

  it("sound OFF: a speaker with an X, 'Sound Off', clicking it turns sound on", () => {
    const h = html(snap({ pref: "off", audible: false, needsUnlock: false }));
    expect(h).toContain(CROSS);
    expect(h).not.toContain(WAVES);
    expect(text(h)).toContain("Sound Off");
    expect(h).toContain('aria-label="Turn Arena sound on"');
    expect(h).toContain('data-sound="off"');
  });

  it("ON but the browser has not allowed sound yet: a subtle 'Enable sound' invitation (one pulsing dot, no popup)", () => {
    const h = html(snap({ status: "idle", audible: false, needsUnlock: true }));
    expect(h).toContain('data-sound="locked"');
    expect(text(h)).toContain("Enable sound");
    expect(h).toContain('aria-label="Enable Arena sound"');
    expect(h).toContain("animate-ping");
    expect(h).toContain(WAVES);
    expect(h).not.toContain("role=\"dialog\"");
  });

  it("a browser without Web Audio (or a broken audio stack): the button says so and is disabled — it never crashes the Arena", () => {
    for (const status of ["unsupported", "error"] as const) {
      const h = html(snap({ status, audible: false, needsUnlock: false }));
      expect(h).toContain('data-sound="unavailable"');
      expect(h).toMatch(/<button[^>]*disabled/);
      expect(text(h)).toContain("Sound unavailable");
    }
  });

  it("is a real, keyboard-operable button with an accessible name, a visible focus ring, a 44 px touch target and a tooltip on hover AND focus", () => {
    const h = html(snap());
    expect(h).toMatch(/<button[^>]*type="button"/);
    expect(h).toContain("h-11 w-11"); // 44 × 44 px
    expect(h).toContain("focus-visible:outline-2");
    expect(h).toContain("group-focus-within:block");
    expect(h).toContain("group-hover:block");
    expect(h).toContain('role="tooltip"');
    expect(h).toContain('aria-describedby="sound-toggle-tip"');
    expect(h).toContain("data-sound-toggle");
  });

  it("sits at the BOTTOM-RIGHT of the arena stage, above the canvas, and does not catch clicks meant for the stage around it", () => {
    const h = html(snap());
    expect(h).toMatch(/class="[^"]*pointer-events-none[^"]*absolute[^"]*right-1[^"]*bottom-1[^"]*"/);
    expect(h).toContain("sm:right-2");
    expect(h).toContain("sm:bottom-2");
    expect(h).toContain("pointer-events-auto"); // only the button itself takes clicks
    expect(h).toContain("z-20");
  });
});
