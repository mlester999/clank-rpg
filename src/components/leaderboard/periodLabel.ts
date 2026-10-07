const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "2026-10-06" → "OCT 6" (a calendar label for a UTC date — never converted through the viewer's timezone). */
export function periodLabel(start: string): string {
  const [, m, d] = start.split("-");
  return `${MONTHS[Number(m) - 1] ?? "?"} ${Number(d)}`;
}
