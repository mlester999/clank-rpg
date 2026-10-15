import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { stageCopy } from "@/components/arena/stageMode";
import { DOC_BODIES } from "@/content/docs/bodies";
import { DOC_PAGES } from "@/content/docs/registry";
import { FEATURES } from "@/content/features";
import type { ArenaStateDto } from "@/lib/dto";

/**
 * THE PUBLIC LAUNCH EXPERIENCE SAYS NOTHING ABOUT DEVELOPMENT. Before Season 1 the public is told "Pre-season / Season 1 coming soon"; after it, "Season 1". Neither says
 * development, test battles, beta or local. (Admin screens keep their precise vocabulary, and internal infrastructure — localhost handling, dev login, demo heroes —
 * is untouched: it is guarded by the environment and never reaches a production visitor.)
 */
const BANNED = /\bdevelopment\b|\btest battles?\b|\btest records?\b|\btest (picks|results|data)\b|\bbeta\b|\blocal mode\b|\bdev mode\b|\bnot in the beta\b/i;

const decode = (s: string) => s.replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const textOf = (html: string) => decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

describe("the docs", () => {
  it("never describe the game as being in development, test or beta", () => {
    const offenders = DOC_PAGES.map((p) => [p.slug, textOf(renderToStaticMarkup(createElement(DOC_BODIES[p.slug]!)))] as const).filter(([, t]) => BANNED.test(t)).map(([slug, t]) => `${slug || "home"}: …${BANNED.exec(t)?.[0]}…`);
    expect(offenders).toEqual([]);
  });
});

describe("the roadmap and the waiting screens", () => {
  it("say 'coming later' and 'Pre-season', never 'not in the Beta' or 'development'", () => {
    const all = JSON.stringify(FEATURES);
    expect(all).not.toMatch(/not in the beta/i);
    const state = (over: Partial<ArenaStateDto>): ArenaStateDto => ({ phase: "DEVELOPMENT", season: { id: "x", kind: "DEVELOPMENT", number: null, name: "Development / Beta", label: "Pre-season" }, ...over }) as ArenaStateDto;
    for (const mode of ["DEVELOPMENT_IDLE", "NOT_STARTED", "PREPARING", "PAUSED", "RECONNECTING", "NO_SEASON"] as const) {
      const c = stageCopy(mode, state({}));
      expect(`${c.title} ${c.lines.join(" ")}`, mode).not.toMatch(BANNED);
    }
    expect(stageCopy("DEVELOPMENT_IDLE", null).title).toBe("Pre-season");
    expect(stageCopy("DEVELOPMENT_IDLE", null).lines.join(" ")).toMatch(/Season 1 is coming soon/);
    expect(stageCopy("NOT_STARTED", state({ phase: "LIVE", season: { id: "s", kind: "COMPETITIVE", number: 1, name: "Season 1", label: "Season 1" } })).lines.join(" ")).toMatch(/Season 1 battles will begin soon/);
  });
});

describe("the public source files", () => {
  const root = process.cwd();
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx|ts)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  // public = components outside admin + the pages (not the admin page, not API routes) + the docs content
  const publicFiles = [...walk(path.join(root, "src/components")), ...walk(path.join(root, "src/app")), ...walk(path.join(root, "src/content"))]
    .map((f) => path.relative(root, f))
    .filter((f) => !f.startsWith("src/components/admin/") && !f.startsWith("src/app/admin/") && !f.startsWith("src/app/api/"));

  it("no public file renders the old development / test / beta strings", () => {
    const OLD = [/Development · test battles/, /Development \/ Beta/, /Arena in development/, /Development run —/, /still being built/i, /test battles are not running/i, /Beta — heroes/, />\s*Beta\s*</, /not in the Beta/, /Local mode/i, /LOCAL MODE/];
    const offenders = publicFiles.flatMap((f) => {
      const src = readFileSync(path.join(root, f), "utf8");
      return OLD.filter((re) => re.test(src)).map((re) => `${f}: ${re}`);
    });
    expect(offenders).toEqual([]);
  });

  it("the only 'local' public strings are the non-production dev-login and the demo-hero chip, both guarded by the environment", () => {
    const hits = publicFiles.flatMap((f) => (/Local preview/.test(readFileSync(path.join(root, f), "utf8")) ? [f] : [])).sort();
    expect(hits).toEqual(["src/components/arena/StageHud.tsx", "src/components/character/SignInPanel.tsx"]);
    const env = readFileSync(path.join(root, "src/server/env.ts"), "utf8");
    expect(env).toMatch(/devLoginEnabled[\s\S]*!env\.isProduction/); // the dev login cannot exist in production
    expect(readFileSync(path.join(root, "src/app/api/me/route.ts"), "utf8")).toMatch(/!env\.isProduction && Boolean\(env\.CLANK_DEV_LOGIN\)/);
  });

  it("the navigation and footer are phase-driven (from the persisted game phase), not hard-coded 'Beta'", () => {
    const shell = readFileSync(path.join(root, "src/components/nav/AppShell.tsx"), "utf8");
    expect(shell).toMatch(/stageBadge\(season\)/);
    expect(shell).toMatch(/footerNote\(season\)/);
    expect(shell).toMatch(/href: "\/events"/);
    expect(shell).not.toMatch(/>Beta</);
  });
});
