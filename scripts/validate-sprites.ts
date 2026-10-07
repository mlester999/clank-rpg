import { validateSpriteSet } from "./lib/validateSprites";

const setId = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "clank-dev-v1";
const strict = process.argv.includes("--strict");

void validateSpriteSet(setId, { strict, listAll: process.argv.includes("--all") }).then((r) => {
  console.log(`sprite set "${setId}": ${r.stats.layers} layers, ${r.stats.atlases} atlases, ${r.stats.cellsChecked} cells checked`);
  for (const w of r.warnings) console.log(`  warn  ${w}`);
  for (const e of r.errors) console.log(`  ERROR ${e}`);
  console.log(r.ok ? "OK" : "FAILED");
  process.exitCode = r.ok ? 0 : 1;
});
