import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `public.period_season(kind, start)` scans the scores of the period it is asked about. Called once PER SCORE ROW inside a scan of the scores (as it used to be in
 * `findFinalizingPeriod`, which every Picks board request runs) that is quadratic in the number of picks: 1.3 s for a few hundred rows. The scans that list periods use the
 * row-level "this score is of a season that counts" test instead, which answers the same question once per season.
 */
describe("period scans stay linear", () => {
  const read = (f: string) => readFileSync(new URL(`../../src/server/rewards/${f}`, import.meta.url), "utf8");

  it("only the single-period lookup calls period_season; the scans over scores use the counting-season test", () => {
    for (const file of ["leaderboard.ts", "admin.ts"]) {
      const calls = read(file).split("\n").filter((line) => /public\.period_season\(/.test(line) && !/^\s*(\*|\/\/)/.test(line));
      // the one remaining call: `select public.period_season($1::text, $2::date) as id` (one period → one answer)
      for (const line of calls) expect(line, `${file}: ${line.trim()}`).toContain('"select public.period_season($1::text, $2::date) as id"');
    }
    const lb = read("leaderboard.ts");
    expect(lb).toContain("s.season_id in (select z.id from public.seasons z where public.season_counts(z.id))");
    expect(lb.match(/\$\{COUNTING_SEASON_SCORE\}/g)?.length).toBe(2); // findFinalizingPeriod + the sweep
    expect(read("admin.ts")).toContain("${COUNTING_SEASON_SCORE}");
  });
});
