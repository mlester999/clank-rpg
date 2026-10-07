import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { slugOf } from "@/components/docs/DocsShell";
import { DOC_BODIES } from "@/content/docs/bodies";
import { DOC_GROUPS, DOC_PAGES, buildSearchIndex, docHref, findDocPage, neighbours, searchDocs } from "@/content/docs/registry";
import { DEFAULT_CLASSES } from "@/domain/content";
import { GAME_RULES, compactNumber, prizeShare } from "@/domain/gameRules";
import { RARITY_RULES } from "@/domain/hero/rarity";
import { DEFAULT_ARENA_PICKS, DEFAULT_SETTINGS } from "@/domain/settings";

const decode = (s: string) => s.replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const html = (slug: string) => renderToStaticMarkup(createElement(DOC_BODIES[slug]!));
/** Visible text: tags dropped, entities decoded, whitespace collapsed. */
const text = (slug: string) => decode(html(slug).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const ALL_TEXT = DOC_PAGES.map((p) => text(p.slug)).join("\n");

const PREFERRED = ["getting-started", "heroes", "classes", "rarity", "power-and-stats", "arena", "arena-picks", "leaderboards", "rewards", "holder-bonus", "claims", "hero-profiles", "faq"];

describe("docs registry", () => {
  it("has every page of the preferred architecture, each with a body", () => {
    for (const slug of PREFERRED) expect(findDocPage(slug), slug).toBeDefined();
    expect(findDocPage("")).toBeDefined(); // /docs itself
    for (const p of DOC_PAGES) expect(DOC_BODIES[p.slug], p.slug || "home").toBeTypeOf("function");
    expect(Object.keys(DOC_BODIES).sort()).toEqual(DOC_PAGES.map((p) => p.slug).sort());
  });

  it("slugs are unique, URL-safe, and every page has a title, a summary, a known group and unique section ids", () => {
    expect(new Set(DOC_PAGES.map((p) => p.slug)).size).toBe(DOC_PAGES.length);
    for (const p of DOC_PAGES) {
      expect(p.slug).toMatch(/^[a-z0-9-]*$/);
      expect(p.title.length).toBeGreaterThan(2);
      expect(p.summary.length).toBeGreaterThan(20);
      expect(DOC_GROUPS).toContain(p.group);
      expect(new Set(p.sections.map((s) => s.id)).size, p.slug).toBe(p.sections.length);
      for (const s of p.sections) expect(s.id).toMatch(/^[a-z0-9-]+$/);
    }
    for (const g of DOC_GROUPS) expect(DOC_PAGES.some((p) => p.group === g), g).toBe(true);
  });

  it("previous / next links walk the pages in reading order from the first to the last", () => {
    expect(neighbours(DOC_PAGES[0]!.slug).prev).toBeNull();
    expect(neighbours(DOC_PAGES.at(-1)!.slug).next).toBeNull();
    const walked: string[] = [];
    let cur: (typeof DOC_PAGES)[number] | null = DOC_PAGES[0]!;
    while (cur) {
      walked.push(cur.slug);
      cur = neighbours(cur.slug).next;
    }
    expect(walked).toEqual(DOC_PAGES.map((p) => p.slug));
    expect(docHref("")).toBe("/docs");
    expect(docHref("rarity")).toBe("/docs/rarity");
    expect(neighbours("does-not-exist")).toEqual({ prev: null, next: null });
  });

  it("slugOf reads the page out of a pathname (home, nested, trailing slash, anchor)", () => {
    expect(slugOf("/docs")).toBe("");
    expect(slugOf("/docs/")).toBe("");
    expect(slugOf("/docs/rarity")).toBe("rarity");
    expect(slugOf("/docs/power-and-stats#what-is-pwr")).toBe("power-and-stats");
  });

  it("search finds pages and sections by title, section and keyword (and nothing for an empty query)", () => {
    const index = buildSearchIndex();
    expect(searchDocs(index, "")).toEqual([]);
    expect(searchDocs(index, "rarity")[0]!.href).toBe("/docs/rarity");
    expect(searchDocs(index, "holder")[0]!.href).toBe("/docs/holder-bonus");
    expect(searchDocs(index, "pwr ranges").some((e) => e.href === "/docs/rarity#pwr-ranges")).toBe(true);
    expect(searchDocs(index, "legendary").some((e) => e.slug === "rarity")).toBe(true);
    expect(searchDocs(index, "weekly").some((e) => e.slug === "leaderboards")).toBe(true);
    expect(searchDocs(index, "zzzzqqq")).toEqual([]);
    expect(searchDocs(index, "a", 3).length).toBeLessThanOrEqual(3);
  });
});

describe("every docs page", () => {
  it.each(DOC_PAGES.map((p) => p.slug))("%j renders exactly the sections the registry declares, in order, with matching headings", (slug) => {
    const meta = findDocPage(slug)!;
    const out = html(slug);
    const rendered = [...out.matchAll(/<h2 id="([a-z0-9-]+)"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => ({ id: m[1]!, title: decode(m[2]!.replace(/<[^>]+>/g, "")).trim() }));
    expect(rendered.map((r) => r.id)).toEqual(meta.sections.map((s) => s.id));
    expect(rendered.map((r) => r.title)).toEqual(meta.sections.map((s) => s.title));
    // every h2 has a copyable anchor link
    for (const s of meta.sections) expect(out).toContain(`href="#${s.id}"`);
  });

  it.each(DOC_PAGES.map((p) => p.slug))("%j: every link goes somewhere that exists (docs page, section anchor, or a known app route) and nothing leaves the site", (slug) => {
    const out = html(slug);
    const hrefs = [...out.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]!));
    const known = new Set(["/heroes", "/leaderboard", "/docs"]);
    for (const href of hrefs) {
      expect(href.startsWith("http"), `external link ${href}`).toBe(false);
      if (href.startsWith("#")) {
        expect(out, `${slug} anchor ${href}`).toContain(`id="${href.slice(1)}"`);
        continue;
      }
      const [base, hash] = href.split("#");
      const ok = known.has(base!) || (base!.startsWith("/docs/") && findDocPage(base!.slice("/docs/".length)) !== undefined);
      expect(ok, `${slug} → ${href}`).toBe(true);
      if (hash && base!.startsWith("/docs")) expect(findDocPage(base === "/docs" ? "" : base!.slice(6))!.sections.some((s) => s.id === hash), href).toBe(true);
    }
  });
});

describe("docs content states CURRENT product truth, from the shared rules", () => {
  const r = GAME_RULES;
  const t = (slug: string) => text(slug);

  it("getting started: the official Clank.trade Telegram community, the qualifying-message threshold, and no anti-abuse internals", () => {
    const x = t("getting-started");
    expect(x).toContain("Clank.trade Telegram community");
    expect(x).toContain(`${DEFAULT_SETTINGS.telegram.qualifyingThreshold} qualifying messages`);
    expect(x).toMatch(/qualifying message is a real contribution/i);
    expect(x).toMatch(/spam/i);
    expect(x).not.toMatch(/duplicate|burst|rate limit|filler ratio|daily cap/i); // the scoring internals stay private
  });

  it("heroes: one per member, defined by class / rarity / stats / PWR / look; fights automatically; no admin tooling advertised", () => {
    const x = t("heroes");
    for (const w of ["Class", "Rarity", "Stats", "PWR", "Look"]) expect(x).toContain(w);
    expect(x).toMatch(/one hero/i);
    expect(x).toMatch(/automatically|by themselves|on its own/i);
  });

  it("classes: all six, each with role, strongest stats, strengths and trade-offs — and no matchup guarantee", () => {
    const x = t("classes");
    for (const c of DEFAULT_CLASSES) expect(x, c.id).toContain(c.name);
    expect(x.match(/Strengths/g)!.length).toBe(DEFAULT_CLASSES.length);
    expect(x.match(/Trade-offs/g)!.length).toBe(DEFAULT_CLASSES.length);
    expect(x).toMatch(/nothing is guaranteed/i);
  });

  it("rarity: the new final system — a strength tier, the EXACT bands from RARITY_RULES, the odds, and 'not a guarantee'", () => {
    const x = t("rarity");
    for (const tier of r.rarity.ladder) {
      expect(x).toContain(tier.label);
      expect(x).toContain(`${RARITY_RULES[tier.id].powerMin}–${RARITY_RULES[tier.id].powerMax}`);
      expect(x).toContain(`${tier.oddsPercent}%`);
    }
    expect(x).toMatch(/larger stat budget/i);
    expect(x).toMatch(/higher PWR range/i);
    expect(x).toMatch(/stronger combat potential/i);
    expect(x).toMatch(/do not overlap/i);
    expect(x).toMatch(/does not win every battle/i);
    expect(x).toMatch(/Common\s+hero can beat a Legendary/i);
    expect(x).toMatch(/Arena Pick Points/);
  });

  it("power & stats: PWR explained, all seven stats, classes spend stats differently, and PWR is not a result", () => {
    const x = t("power-and-stats");
    for (const s of r.hero.stats) expect(x).toContain(s.label);
    expect(x).toMatch(/comparable across classes/i);
    expect(x).toMatch(/Classes spend stats differently/);
    expect(x).toMatch(/never changes a hero's PWR/i);
  });

  it("arena: eight heroes, the flow idle → countdown → combat → result → next battle, the 60 s cap, server-authoritative, replayable", () => {
    const x = t("arena");
    expect(x).toContain(`${r.arena.heroesPerBattle} heroes`);
    for (const w of ["Idle", "Countdown", "Combat", "Result", "Next battle"]) expect(x).toContain(w);
    expect(x).toContain(`at most ${r.arena.maxCombatSeconds} seconds`);
    expect(x).toMatch(/finish naturally/i);
    expect(x).toMatch(/server-authoritative/i);
    expect(x).toMatch(/deterministic and\s+replayable/i);
    expect(x).toMatch(/global Arena/i);
    expect(x).not.toMatch(/seed/i); // internal seeds are never exposed
  });

  it("arena picks: the CURRENT lifecycle — pick the UPCOMING battle, it locks when the current one is decided, unlimited, +10, one per battle, no per-battle token", () => {
    const x = t("arena-picks");
    expect(x).toMatch(/upcoming/i);
    expect(x).toMatch(/lock/i);
    expect(x).toMatch(/unlimited valid Picks/i);
    expect(x).toContain(`+${DEFAULT_ARENA_PICKS.pointsPerCorrectPick} Points`);
    expect(x).toMatch(/one Pick per battle/i);
    expect(x).toMatch(/earns 0/i);
    expect(x).toMatch(/no per-battle token payout/i);
    expect(x).toMatch(/not betting/i);
    expect(x).toMatch(/Rarity doesn't change the score/);
  });

  it("leaderboards: UTC periods, the exact pools and minimums, 'not a cap', Top 10, the ladder, ties", () => {
    const x = t("leaderboards");
    expect(x).toContain("00:00 UTC");
    expect(x).toContain("Monday 00:00 UTC");
    expect(x).toContain(`${r.picks.daily.poolLabel} ${r.token.symbol}`);
    expect(x).toContain(`${r.picks.weekly.poolLabel} ${r.token.symbol}`);
    expect(x).toContain(`${r.picks.dailyMinimumPicks} valid Picks`);
    expect(x).toContain(`${r.picks.weeklyMinimumPicks} valid Picks`);
    expect(x).toMatch(/not\s+a limit on how many Picks score|not a cap/i);
    expect(x).toContain(`Top ${r.picks.topRewarded}`);
    expect(x).toMatch(/Every valid Pick counts/);
    for (const [i, percent] of r.picks.prizeLadderPercent.entries()) expect(x, `#${i + 1}`).toContain(`${percent}%`);
    expect(x).toContain("30,000"); // #1 of the daily pool, computed from the ladder
    expect(x).toContain("150,000"); // #1 of the weekly pool
    expect(prizeShare(1, r.picks.daily.pool).amount).toBe(30_000);
    expect(x).toMatch(/no effect/i);
  });

  it("leaderboards: the Hall's three sections, Hero Arena rules (wins only, ties, owner, reserved, pool not invented), Hero Records pay nothing, seasons start clean", () => {
    const x = t("leaderboards");
    for (const w of ["Hall of Champions", "Arena Picks", "Hero Arena", "Hero Records"]) expect(x, w).toContain(w);
    expect(x).toMatch(/Daily and Weekly are rewarded\. Season is standings only/);
    expect(x).toMatch(/Arena Wins/);
    expect(x).toMatch(/settled\s+battles of the current season/);
    expect(x).toContain(`Top ${r.heroArena.topRewarded} heroes with at least ${r.heroArena.minimumWins} win`);
    for (const percent of r.heroArena.prizeLadderPercent) expect(x).toContain(`${percent}%`);
    expect(x).toMatch(/Ties share/);
    expect(x).toMatch(/prize goes to the hero's owner/);
    expect(x).toMatch(/reserved/i);
    expect(x).toMatch(/never redistributed/);
    expect(x).toMatch(/Reward pool not set/);
    expect(x).toMatch(/No amount is promised before it is shown/);
    expect(x).toMatch(/holder bonus does not apply to Hero Arena/i);
    expect(x).toMatch(/Hero Records are statistics/);
    expect(x).toMatch(/They carry no prizes/);
    expect(x).toMatch(/every Season board starts at zero/);
    expect(x).toMatch(/Development \/ Beta/);
    // the Hero Arena pools are a decision of the team: no amount of them is written anywhere
    expect(Object.keys(r.heroArena)).not.toContain("dailyPrizePool");
    const rewards = t("rewards");
    expect(rewards).toMatch(/Hero Arena.*separate program/s);
    expect(rewards).toMatch(/Season boards and Hero Records pay nothing/);
  });

  it("rewards / holder bonus / claims: tiers, never pay-to-win, manual verified payout, claims closed before launch, no invented address", () => {
    const holder = t("holder-bonus");
    for (const tier of r.holderBonus.tiers) {
      expect(holder).toContain(tier.label);
      expect(holder).toContain(tier.bonusPercent === 0 ? "0%" : `+${tier.bonusPercent}%`);
    }
    expect(holder).toMatch(/only increases an earned leaderboard prize/i);
    for (const never of ["Points", "rank", "Picks", "PWR", "rarity", "combat power"]) expect(holder).toContain(never);
    expect(holder).toMatch(/not pay-to-win/i);
    expect(holder).toMatch(/effectively 0%/);
    const claims = t("claims");
    expect(claims).toContain(r.token.claimsClosedNotice);
    expect(claims).toMatch(/manual and verified/i);
    expect(claims).toMatch(/does not hold a signing key/i);
    expect(t("rewards")).toMatch(/No token is paid per battle/);
    expect(t("rewards")).toMatch(/before the token launches/i);
    expect(ALL_TEXT).not.toMatch(/0x[0-9a-fA-F]{40}/); // the token address is never invented
  });

  it("hero profiles: the public page, the card hierarchy, share to X / download / copy link — and nothing about private Admin tools", () => {
    const x = t("hero-profiles");
    for (const w of ["Download card", "Share to X", "Copy link"]) expect(x).toContain(w);
    expect(x).toMatch(/art.*name.*rarity and class.*PWR.*seven stats/is);
    expect(x).not.toMatch(/admin/i);
  });

  it("FAQ answers every question the product needs, in the current truth", () => {
    const x = t("faq");
    for (const q of [
      "How do I get a hero?",
      "Why don't I have a hero yet?",
      "What are qualifying Telegram messages?",
      "What does PWR mean?",
      "Does higher rarity mean stronger?",
      "Can a Common beat a Legendary?",
      "How do Arena Picks work?",
      "Do I need tokens to make Picks?",
      "Does holding $CLANKRPG increase my leaderboard score?",
      "How are rewards claimed?",
      "Why is the token not available yet?",
      "Can I change my hero?",
      "How often do battles happen?",
    ]) expect(x, q).toContain(q);
    expect(x).toMatch(/Can I change my hero\?\s*No\./);
    expect(html("faq").match(/<details/g)!.length).toBeGreaterThanOrEqual(13);
  });

  it("the home page links to every top-level topic", () => {
    const out = html("");
    for (const slug of ["getting-started", "heroes", "rarity", "arena", "arena-picks", "leaderboards", "rewards", "faq"]) expect(out).toContain(`href="/docs/${slug}"`);
  });
});

describe("docs hygiene", () => {
  it("contains no outdated 'rarity is cosmetic' language anywhere", () => {
    expect(ALL_TEXT).not.toMatch(/cosmetic only|rarity is cosmetic|rarity does not (affect|change)|does not affect (stats|power|combat)/i);
  });

  it("never advertises admin tools or an admin reroll, and never leaks internals (seeds, secrets, hashes, env names)", () => {
    expect(ALL_TEXT).not.toMatch(/\badmin\b|reroll|backfill|migration|CLASS_ROLL_SECRET|PEPPER|service[_ ]role/i);
  });

  it("the Telegram threshold, PWR bands, pools, minimums, odds and holder tiers are NEVER typed into a page — every one comes from GAME_RULES", () => {
    const dir = path.join(process.cwd(), "src/content/docs/pages");
    const forbidden = [/100,000/, /500,000/, /\b1[34]0\b/, /\b149\b/, /\b169\b/, /\b189\b/, /\b209\b/, /\b190\b/, /\b70%/, /\b22%/, /30,000/, /37,500/, /\+25%/, /\b100K\b/, /\b10M\b/, /\b60 seconds/];
    for (const file of readdirSync(dir)) {
      const src = readFileSync(path.join(dir, file), "utf8");
      for (const re of forbidden) expect(src, `${file} hard-codes ${re}`).not.toMatch(re);
    }
  });

  it("copy changes with the rules: the same rules module drives every number (spot-check against the authoritative defaults)", () => {
    expect(GAME_RULES.community.telegramThreshold).toBe(DEFAULT_SETTINGS.telegram.qualifyingThreshold);
    expect(GAME_RULES.arena.maxCombatSeconds).toBe(DEFAULT_SETTINGS.arena.maxCombatMs / 1000);
    expect(GAME_RULES.arena.heroesPerBattle).toBe(DEFAULT_SETTINGS.arena.groupSize);
    expect(GAME_RULES.picks.pointsPerCorrectPick).toBe(DEFAULT_ARENA_PICKS.pointsPerCorrectPick);
    expect(GAME_RULES.picks.daily.pool).toBe(DEFAULT_ARENA_PICKS.dailyPrizePool);
    expect(GAME_RULES.picks.weekly.pool).toBe(DEFAULT_ARENA_PICKS.weeklyPrizePool);
    expect(GAME_RULES.picks.dailyMinimumPicks).toBe(DEFAULT_ARENA_PICKS.dailyMinimumPicks);
    expect(GAME_RULES.picks.weeklyMinimumPicks).toBe(DEFAULT_ARENA_PICKS.weeklyMinimumPicks);
    expect(GAME_RULES.picks.prizeLadderPercent.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100);
    expect(GAME_RULES.holderBonus.tiers.map((x) => [x.label, x.bonusPercent])).toEqual([["FREE", 0], ["100K+", 5], ["500K+", 10], ["1M+", 15], ["5M+", 20], ["10M+", 25]]);
    expect(GAME_RULES.rarity.ladder.map((x) => x.band)).toEqual(["130–149", "150–169", "170–189", "190–209"]);
    expect(GAME_RULES.rarity.ladder.reduce((a, x) => a + x.oddsPercent, 0)).toBeCloseTo(100, 5);
    expect(GAME_RULES.rarity.ladder.map((x) => x.oddsPercent)).toEqual([70, 22, 7, 1]);
    expect(compactNumber(100_000)).toBe("100K");
    expect(compactNumber(5_000_000)).toBe("5M");
  });

  it("each class's 'strongest stats' reflect its identity", () => {
    const strongest = (id: string) => GAME_RULES.classes.find((c) => c.id === id)!.strongest.map((s) => s.key);
    expect(strongest("mage")).toContain("int");
    expect(strongest("warrior")).toContain("str");
    expect(strongest("tank")).toContain("def");
    expect(strongest("rogue")).toContain("agi");
    expect(strongest("ranger")).toContain("agi");
    expect(strongest("cleric")).toContain("cha");
    expect(GAME_RULES.classes.find((c) => c.id === "mage")!.reach).toBe("Ranged");
    expect(GAME_RULES.classes.find((c) => c.id === "tank")!.reach).toBe("Melee");
  });
});
