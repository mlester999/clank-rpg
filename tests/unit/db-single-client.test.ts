import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ONE AUTHORITATIVE POSTGRES CLIENT PATH (static audit). In production every connection comes from `createPostgresDb` / `acquireSessionLock` in
 * src/server/db/postgres.ts; the web app reaches it through ONE module-level singleton (`getDb` in db/index.ts, kept on globalThis); nothing in a request
 * path may build a client of its own — a per-request client is how a serverless function exhausts the pooler (instances × requests × pool).
 */
const ROOT = process.cwd();
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
};
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
const read = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // code only: comments may talk about it

describe("postgres clients", () => {
  const src = walk(path.join(ROOT, "src"));

  it("src/ imports the `postgres` package in exactly one file: the driver", () => {
    const importers = src.filter((f) => /from\s+["']postgres["']|require\(["']postgres["']\)/.test(read(f))).map(rel);
    expect(importers).toEqual(["src/server/db/postgres.ts"]);
  });

  it("inside the driver, a client is constructed only where it is meant to be: the pool (`connect`) and the worker's session lock", () => {
    const code = read(path.join(ROOT, "src/server/db/postgres.ts"));
    expect(code.match(/\bpostgres\(/g)).toHaveLength(2);
    expect(code).toMatch(/const connect = \(\) =>\s*postgres\(/);
    expect(code).toMatch(/export async function acquireSessionLock[\s\S]*?const sql = postgres\(/);
  });

  it("src/ constructs a database handle in exactly one place — the lazily-created, globalThis-held singleton — and never inside a request handler", () => {
    const makers = src.filter((f) => /\bcreatePostgresDb\(/.test(read(f))).map(rel);
    expect(makers.sort()).toEqual(["src/server/db/index.ts", "src/server/db/postgres.ts"]); // postgres.ts only DEFINES it; index.ts is the one caller
    const index = read(path.join(ROOT, "src/server/db/index.ts"));
    expect(index).toMatch(/__clankDb/); // held on globalThis: survives module reloads, one per process
    expect(index.match(/createPostgresDb\(/g)).toHaveLength(1);
    for (const f of src.filter((x) => rel(x).startsWith("src/app/") || rel(x).startsWith("src/components/"))) expect(read(f), rel(f)).not.toMatch(/createPostgresDb|createPgliteDb|from\s+["']postgres["']/);
  });

  it("the driver turns off postgres.js's floating array-type fetch, prepared statements, and never lets a pool exceed the hard cap", () => {
    const code = read(path.join(ROOT, "src/server/db/postgres.ts"));
    expect(code).toMatch(/fetch_types:\s*false/);
    expect(code).toMatch(/prepare:\s*false/);
    expect(code.match(/fetch_types:\s*false/g)!.length).toBeGreaterThanOrEqual(2); // the pool AND the lock connection
    const index = read(path.join(ROOT, "src/server/db/index.ts"));
    expect(index).toMatch(/POOL_HARD_CAP/);
  });

  it("scripts go through the driver too (they may open their own handle — they are processes of their own — but never construct a postgres.js client)", () => {
    const scripts = walk(path.join(ROOT, "scripts"));
    expect(scripts.filter((f) => /from\s+["']postgres["']/.test(read(f))).map(rel)).toEqual([]);
  });
});
