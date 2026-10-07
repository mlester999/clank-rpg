"use client";

import { useState } from "react";

/** Copies the absolute link to a section (`/docs/page#section`) to the clipboard. Falls back silently where the clipboard API is unavailable. */
export function CopyAnchor({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    const url = `${window.location.origin}${window.location.pathname}#${id}`;
    try {
      await navigator.clipboard.writeText(url);
      setDone(true);
      window.setTimeout(() => setDone(false), 1600);
    } catch {
      window.location.hash = id; // at least put the link in the address bar
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="docs-anchor font-[family-name:var(--font-ui)] text-[0.62rem] tracking-[0.14em] uppercase"
      aria-label={done ? "Link copied" : "Copy link to this section"}
      data-testid="copy-section-link"
    >
      {done ? "Copied" : "Copy link"}
    </button>
  );
}
