"use client";

import { useEffect } from "react";

import { announceSpriteSet } from "./library";

/**
 * Tells this page's portraits which sprite set is live (`visuals.spriteSet`, read on the server by the page) — and remembers it on this device for
 * pages that do not read the settings. Renders nothing.
 */
export function LiveSpriteSet({ id }: { id: string }) {
  useEffect(() => announceSpriteSet(id), [id]);
  return null;
}
