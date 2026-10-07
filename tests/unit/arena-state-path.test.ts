import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The public Arena state endpoint is the hottest read in the app (thousands of viewers, polled every second or so). It must never
 * wait on the token: no chain RPC, no holder verification, no finalization, no claims, no token metadata. This walks the STATIC import
 * graph of the route and fails if any of those modules is reachable from it.
 */
const SRC = join(process.cwd(), "src");
const FORBIDDEN = [
  "server/rewards/chain",
  "server/rewards/holders",
  "server/rewards/claims",
  "server/rewards/leaderboard",
  "server/rewards/tokenMetadata",
  "server/rewards/context",
  "server/rewards/target",
  "server/rewards/config",
  "server/rewards/admin",
  "server/rewards/settlement",
  "domain/rewards/holderBonus",
];

const resolveModule = (from: string, spec: string): string | null => {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) if (existsSync(c) && c.match(/\.(ts|tsx)$/)) return c;
  return null;
};

function graph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    const src = readFileSync(file, "utf8");
    const specs = [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1] as string);
    const edges: string[] = [];
    seen.set(file, edges);
    for (const spec of specs) {
      const target = resolveModule(file, spec);
      if (target) {
        edges.push(target);
        walk(target);
      } else if (!spec.startsWith(".") && !spec.startsWith("@/")) edges.push(`pkg:${spec}`);
    }
  };
  walk(entry);
  return seen;
}

describe("the Arena state path never touches the token", () => {
  const entry = join(SRC, "app", "api", "arena", "state", "route.ts");
  const g = graph(entry);
  const modules = [...g.keys()].map((f) => f.slice(SRC.length + 1).replace(/\.(ts|tsx)$/, ""));
  const packages = [...new Set([...g.values()].flat().filter((e) => e.startsWith("pkg:")).map((e) => e.slice(4)))];

  it("walks a real graph (the route, the view builders and the reward DTO are all reachable)", () => {
    expect(modules).toEqual(expect.arrayContaining(["app/api/arena/state/route", "server/services/views", "server/rewards/pool"]));
    expect(modules.length).toBeGreaterThan(10);
  });

  it("reaches none of: the chain reader, holder verification, finalization, claims, token metadata/config, admin, or the bonus engine", () => {
    const hits = FORBIDDEN.filter((f) => modules.includes(f) || packages.includes(f));
    expect(hits).toEqual([]);
  });
});
