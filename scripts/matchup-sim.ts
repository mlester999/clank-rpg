/**
 * Class matchups, measured fairly (definitions in scripts/lib/matchupSim.ts). Pure simulation: no database. Every number is reproducible from
 * its seed (the salts below are fixed).
 *
 *   pnpm exec tsx scripts/matchup-sim.ts                          fresh 1 v 1 matrix (realistic heroes, equal rarity, Arena spawn points) +
 *                                                                 5,000+ final-duel replays
 *   pnpm exec tsx scripts/matchup-sim.ts --n 700 --finals 12000    1 v 1 duels per pair · eight-hero battles mined for ranged-vs-melee finals
 *   --spawn duel                                                  the standard 1 v 1 spawn (opposite sides) instead of random Arena spawn points
 *   --json out.json                                               also write everything as JSON
 */
import { writeFileSync } from "node:fs";

import { collectFinals, defaultRuleset, isRanged, matchup, rate, replayFinal, type MatchupSummary, type SpawnMode } from "./lib/matchupSim";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const N = Number(arg("n", "700"));
const FINAL_BATTLES = Number(arg("finals", "12000"));
const SPAWN = (arg("spawn", "arena") as SpawnMode);

const rs = defaultRuleset();
const ids = Object.keys(rs.classes);
const t0 = performance.now();

// 1. fresh 1 v 1 matrix
const matrix: MatchupSummary[] = [];
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) matrix.push(matchup(rs, ids[i]!, ids[j]!, N, SPAWN, "matrix"));
console.log(`=== fresh 1 v 1 — rules ${rs.rulesVersion}, realistic heroes, equal rarity (rotating), ${SPAWN} spawn, ${N} duels per pair (${N * matrix.length} total)`);
for (const m of matrix) {
  console.log(`${`${m.a} vs ${m.b}`.padEnd(20)} ${String(m.aWin.pct).padStart(5)} % [${m.aWin.lo}–${m.aWin.hi}]  (A in slot 0: ${m.bySlot.aFirst.pct} %, slot 1: ${m.bySlot.bFirst.pct} %)  median ${m.medianDurationS} s` +
    (m.medianContactS !== null ? `  contact ${m.medianContactS} s, ${m.avgHitsBeforeContact} ranged hits before` : ""));
}
const cat = (pred: (a: string, b: string) => boolean, side: (m: MatchupSummary) => number) => {
  let w = 0;
  let n = 0;
  for (const m of matrix) if (pred(m.a, m.b)) {
    w += side(m);
    n += m.aWin.n;
  }
  return rate(w, n);
};
const meleeVsRanged = cat((a, b) => isRanged(rs, a) !== isRanged(rs, b), (m) => (isRanged(rs, m.a) ? m.aWin.n - m.aWin.wins : m.aWin.wins));
console.log(`melee beats ranged: ${meleeVsRanged.pct} % [${meleeVsRanged.lo}–${meleeVsRanged.hi}] of ${meleeVsRanged.n}`);
const lopsided = matrix.map((m) => Math.max(m.aWin.pct, 100 - m.aWin.pct)).sort((x, y) => y - x);
console.log(`most lopsided pair: ${lopsided[0]} % · pairs at or beyond 80/20: ${lopsided.filter((x) => x >= 80).length} of ${matrix.length}`);

// 2. final duels: the last two of real eight-hero battles, replayed from their situation (as it was / at equal HP)
const finals = collectFinals(rs, FINAL_BATTLES, "final");
let actualRanged = 0;
let replayRanged = 0;
let equalRanged = 0;
let equalFreshRanged = 0;
let equalFreshSpawnRanged = 0;
let replayAgree = 0;
let hpR = 0;
let hpM = 0;
for (const [k, f] of finals.entries()) {
  const ri = isRanged(rs, f.units[0].classId) ? 0 : 1;
  if (f.actualWinner === ri) actualRanged++;
  const w = replayFinal(rs, f, `replay-${k}`);
  if (w === ri) replayRanged++;
  if (w === f.actualWinner) replayAgree++;
  const mean = (f.start[0].hpFrac! + f.start[1].hpFrac!) / 2;
  if (replayFinal(rs, f, `equal-${k}`, { hpFrac: [mean, mean] }) === ri) equalRanged++;
  if (replayFinal(rs, f, `equalfresh-${k}`, { hpFrac: [mean, mean], freshCooldowns: true }) === ri) equalFreshRanged++;
  if (replayFinal(rs, f, `equalfreshspawn-${k}`, { hpFrac: [1, 1], freshCooldowns: true, spawnPositions: true }) === ri) equalFreshSpawnRanged++;
  hpR += f.start[ri]!.hpFrac!;
  hpM += f.start[1 - ri]!.hpFrac!;
}
const nF = finals.length;
console.log(`\n=== final duels — ${nF} ranged-vs-melee finals mined from ${FINAL_BATTLES} realistic eight-hero battles (production rarity odds)`);
console.log(`HP at the start of the final: ranged ${Math.round((hpR / nF) * 100)} % · melee ${Math.round((hpM / nF) * 100)} %`);
const fr = (x: number) => rate(x, nF);
console.log(`ranged side wins — in the battle: ${fr(actualRanged).pct} % [${fr(actualRanged).lo}–${fr(actualRanged).hi}] · replayed from the same situation: ${fr(replayRanged).pct} % (same winner ${fr(replayAgree).pct} %) · replayed at EQUAL HP: ${fr(equalRanged).pct} % [${fr(equalRanged).lo}–${fr(equalRanged).hi}]`);
console.log(`  …at equal HP AND every skill ready: ${fr(equalFreshRanged).pct} % [${fr(equalFreshRanged).lo}–${fr(equalFreshRanged).hi}] · the same two heroes as a FRESH 1 v 1 (full HP, skills ready, standard spawn): ${fr(equalFreshSpawnRanged).pct} % [${fr(equalFreshSpawnRanged).lo}–${fr(equalFreshSpawnRanged).hi}]`);
console.log(`(${Math.round((performance.now() - t0) / 1000)} s)`);

const json = arg("json");
if (json) writeFileSync(json, JSON.stringify({ rulesVersion: rs.rulesVersion, spawn: SPAWN, perPair: N, matrix, meleeVsRanged, finals: { n: nF, battles: FINAL_BATTLES, actualRanged: fr(actualRanged), replayRanged: fr(replayRanged), replayAgree: fr(replayAgree), equalHpRanged: fr(equalRanged), equalHpFreshCooldownsRanged: fr(equalFreshRanged), sameHeroesFreshDuelRanged: fr(equalFreshSpawnRanged), hpAtFinal: { ranged: hpR / nF, melee: hpM / nF } } }, null, 2));
