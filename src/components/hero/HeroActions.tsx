"use client";

import { useState } from "react";

import { xIntentUrl, type HeroCardModel } from "@/domain/hero/card";

/**
 * DOWNLOAD CARD · SHARE TO X · COPY LINK.
 *
 *  · Download is a plain link to the PNG for the CURRENT version (the URL carries the card's content key, so it can never be an old image).
 *  · Share opens X's web composer with prepared text and the canonical hero link. A web intent can NOT attach an image — so the card is
 *    downloaded separately and attached by hand; this component says so instead of pretending otherwise.
 *  · Copy puts the same canonical link on the clipboard (Discord, Telegram, a reply …).
 */
export function HeroActions({ model, url, downloadHref, note = true, className = "" }: { model: Pick<HeroCardModel, "name" | "rarity" | "className" | "power">; url: string; downloadHref: string; note?: boolean; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      // clipboard blocked (permissions / insecure context): fall back to a temporary selection
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        setState(ok ? "copied" : "failed");
      } catch {
        setState("failed");
      }
    }
    window.setTimeout(() => setState("idle"), 2500);
  }

  return (
    <div className={className} data-testid="hero-actions">
      <div className="flex flex-wrap gap-2">
        <a href={downloadHref} download className="btn btn-sm" data-testid="hero-download">Download card</a>
        <a href={xIntentUrl(model, url)} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm" data-testid="hero-share-x" aria-label="Share to X (opens in a new tab)">Share to X</a>
        <button type="button" onClick={copy} className="btn btn-ghost btn-sm" data-testid="hero-copy-link">Copy link</button>
      </div>
      <p role="status" className="mt-1.5 min-h-[1.1rem] text-xs text-clank-300" data-testid="hero-copy-status">{state === "copied" ? "Link copied." : state === "failed" ? "Couldn't copy — select the link and copy it by hand." : ""}</p>
      {note && <p className="text-[0.68rem] text-steel-400">X can&apos;t attach the image for you — download the card, then add it to your post.</p>}
    </div>
  );
}
