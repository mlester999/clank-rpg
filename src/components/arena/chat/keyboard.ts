/**
 * The on-screen keyboard, as numbers. Browsers disagree about what the keyboard does to the page — iOS Safari and current Android Chrome leave the layout
 * viewport alone and shrink only the VISUAL viewport (window.visualViewport); some Android modes shrink the layout viewport itself — so the message box is
 * kept visible by looking at the visual viewport, which is right in both.
 */

/** The fixed bottom navigation's height (h-16) plus a little air: a focused message box is kept this far above the bottom of what is visible. */
export const NAV_CLEAR_PX = 72;
/** A visible viewport at least this much shorter than the window means a keyboard is up (an address-bar collapse changes it by far less). */
export const KEYBOARD_MIN_PX = 120;

/** Is a keyboard up? `visualHeight` is `visualViewport.height` (null where the API is missing). */
export function keyboardUp(innerHeight: number, visualHeight: number | null): boolean {
  return visualHeight !== null && innerHeight - visualHeight > KEYBOARD_MIN_PX;
}

/**
 * How far the page must scroll DOWN (px, 0 when none) so the form's bottom edge sits inside the visible viewport: clear of the keyboard by 8 px when one is
 * up, clear of the bottom navigation when not.
 */
export function revealDelta(input: { formBottom: number; visualTop: number; visualHeight: number; keyboard: boolean }): number {
  const bottom = input.visualTop + input.visualHeight;
  const clear = input.keyboard ? 8 : NAV_CLEAR_PX;
  const over = input.formBottom - (bottom - clear);
  return over > 1 ? over : 0;
}
