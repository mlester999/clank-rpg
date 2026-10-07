import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClassTag, CombatPower, HeroActionBar, HeroIdentityPanel, HeroStandingPanel, OwnershipPanel, RankProgress, nameSize, type IdentityPanelProps } from "@/components/character/HeroIdentity";
import { lookFor } from "@/components/hero/look";
import { RarityPlaque } from "@/components/hero/rarity";
import { CLASS_ICONS, classIcon } from "@/components/ui/Icons";
import { arenaNotice, ownershipCopy } from "@/content/heroOwnership";
import { RARITIES, type Rarity } from "@/domain/character/appearance";
import { RARITY_RULES } from "@/domain/hero/rarity";
import { RARITY_VISUALS } from "@/domain/hero/rarityVisuals";
import { heroOwnership, isSelfHeroStatus, type OwnershipKind } from "@/domain/heroOwnership";
import { hexToRgb, mix } from "@/domain/util/color";
import type { CharacterDto, ClassVisual } from "@/lib/dto";

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
/** The opening tag that carries `data-testid="<id>"` (attribute order differs between <a>, <Link> and <button>). */
const tagOf = (html: string, id: string) => new RegExp(`<[a-z]+\\b[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const CLASSES = ["warrior", "mage", "rogue", "ranger", "tank", "cleric"] as const;
const PUBLIC_ID = "k7m2q9x4tb3d";
const ORIGIN = "https://clank.example";

const classVisual = (name: string): ClassVisual => ({ name, role: "", tagline: `The ${name} way of fighting.`, colors: ["#8a3b2f", "#c9a24b", "#2c343d"], weapon: "sword", headgear: "cap", body: "medium", attackStyle: "slash" });

type HeroLite = IdentityPanelProps["hero"];
const heroOf = (over: Partial<HeroLite> & { rarity?: Rarity } = {}): HeroLite => {
  const { rarity = "COMMON", ...rest } = over;
  return {
    name: "Forge Fay", title: null, publicId: PUBLIC_ID, avatarUrl: null, classId: "tank", power: 137,
    appearance: {
      rarity,
      parts: { skin: 0, hairStyle: 0, hairColor: 0, eyes: 0, mouth: 0, accessory: 0, cape: false, aura: "none", outfitHue: 0 },
      sprite: { v: 1, catalog: 2, skin: 0, hairColor: 0, hue: 0, slots: { outfit: "outfit.robe", weapon: "weapon.staff" } },
    } as unknown as HeroLite["appearance"],
    ...rest,
  };
};

type PanelOver = Omit<Partial<IdentityPanelProps>, "hero"> & { hero?: Partial<HeroLite> & { rarity?: Rarity } };
const panel = (over: PanelOver = {}) => {
  const { hero: heroOver, ...rest } = over;
  const hero = heroOf(heroOver);
  const cv = over.classVisual === undefined ? classVisual("Tank") : over.classVisual;
  return render(createElement(HeroIdentityPanel, { classVisual: cv, look: lookFor(hero.appearance, cv ?? undefined), ownership: "UNCLAIMED_SIGNED_OUT", origin: ORIGIN, animate: false, ...rest, hero } as IdentityPanelProps));
};

const season = (over: Partial<NonNullable<CharacterDto["season"]>> = {}): NonNullable<CharacterDto["season"]> => ({
  kind: "DEVELOPMENT", number: null, name: "Development run", label: "Development", points: 340, battles: 6, wins: 2, top2: 3, ranked: true,
  rank: { id: "silver", name: "Silver", index: 1, tierCount: 5, next: { name: "Gold", minPoints: 500 }, pointsToNext: 160, progress: 0.4 },
  ...over,
});

// WCAG relative luminance / contrast, used to pin the plaque's legibility.
const lum = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };

describe("rarity plaque — the collectible badge, never colour alone", () => {
  it("shows each tier's NAME and its own icon shape, from the shared rarity visuals", () => {
    const shapes = RARITIES.map((r) => {
      const out = render(createElement(RarityPlaque, { rarity: r }));
      expect(text(out)).toBe(`Rarity ${RARITY_RULES[r].label}`);
      expect(out).toContain('data-testid="rarity-plaque"');
      expect(out).toContain(`data-rarity="${r}"`);
      expect(out).toContain(`title="${RARITY_RULES[r].label} rarity"`);
      return /data-rarity-icon="([a-z]+)"/.exec(out)![1];
    });
    expect(shapes).toEqual(["dot", "diamond", "star", "crown"]);
  });

  it("uses the canonical colours: Common steel, Rare blue, Epic violet, Legendary gold", () => {
    const hue = (hex: string) => { const [r, g, b] = hexToRgb(hex); return { r, g, b }; };
    const c = RARITIES.map((r) => hue(RARITY_VISUALS[r].colors.base));
    expect(c[0]!.b - c[0]!.r).toBeLessThan(30); // steel: no strong hue
    expect(c[1]!.b).toBeGreaterThan(c[1]!.r + 80); // blue
    expect(c[2]!.b).toBeGreaterThan(c[2]!.g + 60); // violet: blue + red over green
    expect(c[2]!.r).toBeGreaterThan(c[2]!.g + 40);
    expect(c[3]!.r).toBeGreaterThan(c[3]!.b + 120); // gold / amber
    const out = RARITIES.map((r) => render(createElement(RarityPlaque, { rarity: r })));
    expect(out[1]).toContain(RARITY_VISUALS.RARE.colors.light);
    expect(out[3]).toContain(RARITY_VISUALS.LEGENDARY.colors.base);
    expect(out[0]).not.toContain(RARITY_VISUALS.RARE.colors.base);
  });

  it("is chamfered like the panels, and glows only from Epic up", () => {
    expect(RARITIES.map((r) => render(createElement(RarityPlaque, { rarity: r })).includes("clip-path"))).toEqual([true, true, true, true]);
    expect(RARITIES.map((r) => render(createElement(RarityPlaque, { rarity: r })).includes("drop-shadow"))).toEqual([false, false, true, true]);
  });

  it("keeps its label readable: ≥ 4.5:1 for the text colour on the plaque fill", () => {
    for (const r of RARITIES) {
      const v = RARITY_VISUALS[r];
      if (v.tier === 0) {
        expect(contrast(v.colors.light, "#3b4454")).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v.colors.light, "#262d3a")).toBeGreaterThanOrEqual(4.5);
      } else {
        expect(contrast(v.colors.ink, v.colors.light)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v.colors.ink, v.colors.base)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(mix(v.colors.ink, v.colors.base, 0.2), v.colors.base)).toBeGreaterThanOrEqual(4.5); // the 80 % "RARITY" caption
      }
    }
  });
});

describe("class presentation — a glyph per class, in its own visual language", () => {
  it("all six classes render with their own icon, name and caption", () => {
    const icons = new Set<string>();
    for (const id of CLASSES) {
      const out = render(createElement(ClassTag, { classId: id, name: id[0]!.toUpperCase() + id.slice(1), color: "#8a3b2f" }));
      expect(out).toContain('data-testid="class-tag"');
      expect(out).toContain(`data-class="${id}"`);
      expect(out).toContain(`data-class-icon="${id}"`);
      expect(text(out)).toBe(`Class ${id[0]!.toUpperCase() + id.slice(1)}`);
      icons.add(/<svg[\s\S]*?<\/svg>/.exec(out)![0].replace(/data-class-icon="[a-z]+"/, ""));
    }
    expect(icons.size).toBe(6); // six different glyphs
    expect(Object.keys(CLASS_ICONS).sort()).toEqual([...CLASSES].sort());
  });

  it("an unknown class still gets an icon (crossed swords) instead of a hole", () => {
    expect(classIcon("necromancer")).toBe(classIcon("also-unknown"));
    const out = render(createElement(ClassTag, { classId: "necromancer", name: "Necromancer" }));
    expect(out).toContain("<svg");
    expect(out).toContain('aria-hidden="true"');
  });

  it("is a different shape from the rarity plaque, and from the ownership block", () => {
    const html = panel({ hero: { rarity: "EPIC", classId: "mage" }, ownership: "UNCLAIMED_SIGNED_OUT" });
    const root = (testid: string) => new RegExp(`<[a-z]+ [^>]*data-testid="${testid}"[^>]*>`).exec(html)![0];
    const classOf = (tag: string) => /class="([^"]*)"/.exec(tag)![1];
    const plaque = classOf(root("rarity-plaque"));
    const cls = classOf(root("class-tag"));
    const own = classOf(root("ownership-panel"));
    expect(new Set([plaque, cls, own]).size).toBe(3);
    expect(html).toContain("clip-path"); // plaque only
    expect(cls).toContain("bg-ink-900"); // dark tile
    expect(own).toContain("border-dashed"); // unclaimed = dashed
  });
});

describe("who owns the hero — pure state", () => {
  const hero = (over: Partial<{ id: string; kind: string; isDemo: boolean; claimed: boolean }> = {}) => ({ id: "h1", kind: "COMMUNITY", isDemo: false, claimed: false, ...over });
  const cases: Array<[string, Parameters<typeof heroOwnership>[0], OwnershipKind]> = [
    ["team character", { hero: hero({ kind: "SPECIAL_CHARACTER" }), viewer: null }, "TEAM"],
    ["demo hero, anyone else", { hero: hero({ isDemo: true }), viewer: null }, "DEMO"],
    ["demo hero, signed in as it (a development login can still claim)", { hero: hero({ isDemo: true }), viewer: { characterId: "h1", claimed: false } }, "UNCLAIMED_CLAIMABLE"],
    ["unclaimed, signed out", { hero: hero(), viewer: null }, "UNCLAIMED_SIGNED_OUT"],
    ["unclaimed, I am this hero's member", { hero: hero(), viewer: { characterId: "h1", claimed: false } }, "UNCLAIMED_CLAIMABLE"],
    ["unclaimed, I am somebody else", { hero: hero(), viewer: { characterId: "h2", claimed: true } }, "UNCLAIMED_OTHER"],
    ["unclaimed, I have no hero at all", { hero: hero(), viewer: { characterId: null, claimed: false } }, "UNCLAIMED_OTHER"],
    ["claimed, signed out", { hero: hero({ claimed: true }), viewer: null }, "CLAIMED_PUBLIC"],
    ["claimed, somebody else's", { hero: hero({ claimed: true }), viewer: { characterId: "h2", claimed: true } }, "CLAIMED_PUBLIC"],
    ["claimed, mine", { hero: hero({ claimed: true }), viewer: { characterId: "h1", claimed: true } }, "CLAIMED_OWNER"],
  ];
  it.each(cases)("%s → %s", (_name, input, expected) => {
    expect(heroOwnership(input)).toBe(expected);
  });

  it("only the three real statuses are accepted as a hero's own status", () => {
    expect(["ACTIVE", "INACTIVE", "SUSPENDED"].every(isSelfHeroStatus)).toBe(true);
    expect(["BANNED", "", null, undefined, 3].some(isSelfHeroStatus)).toBe(false);
  });
});

describe("the ownership panel", () => {
  const own = (kind: OwnershipKind, extra: Partial<Parameters<typeof OwnershipPanel>[0]> = {}) => render(createElement(OwnershipPanel, { kind, ...extra }));

  it("UNCLAIMED, signed out: says so and offers Sign in with Telegram", () => {
    const out = own("UNCLAIMED_SIGNED_OUT");
    expect(text(out)).toContain("Unclaimed");
    expect(text(out)).toContain("Sign in with Telegram to claim this hero.");
    expect(tagOf(out, "ownership-sign-in")).toMatch(/^<a\b[^>]*href="\/character"/);
    expect(out).not.toContain("data-testid=\"ownership-claim\"");
    expect(out).toContain('data-ownership="UNCLAIMED_SIGNED_OUT"');
  });

  it("UNCLAIMED, signed in as the hero's member: HERO FOUND with a Claim button (and only with a handler)", () => {
    const out = own("UNCLAIMED_CLAIMABLE", { onClaim: () => undefined });
    expect(text(out)).toContain("Hero found");
    expect(text(out)).toContain("Claim it to manage tactics, gear and your wallet.");
    expect(out).toMatch(/<button [^>]*data-testid="ownership-claim"/);
    expect(out).not.toContain("ownership-sign-in");
    expect(own("UNCLAIMED_CLAIMABLE")).not.toContain("ownership-claim"); // no handler → no dead button
  });

  it("UNCLAIMED, signed in as somebody else: no call to action", () => {
    const out = own("UNCLAIMED_OTHER", { onClaim: () => undefined });
    expect(text(out)).toContain("Unclaimed");
    expect(out).not.toContain("ownership-claim");
    expect(out).not.toContain("ownership-sign-in");
  });

  it("CLAIMED: the owner and the public see different, short copy and no CTA", () => {
    const mine = own("CLAIMED_OWNER");
    const theirs = own("CLAIMED_PUBLIC");
    expect(text(mine)).toContain("Claimed");
    expect(text(mine)).toContain("This is your hero. Telegram identity verified.");
    expect(text(theirs)).toContain("This hero has a verified Telegram owner.");
    for (const out of [mine, theirs]) {
      expect(out).not.toContain("ownership-claim");
      expect(out).not.toContain("ownership-sign-in");
      expect(out).toContain("border-ok/40"); // green
    }
  });

  it("TEAM and DEMO heroes are not 'unclaimed' — there is nothing to claim", () => {
    expect(text(own("TEAM"))).toContain("Team hero");
    expect(text(own("DEMO"))).toContain("Demo hero");
    for (const k of ["TEAM", "DEMO"] as const) expect(text(own(k))).not.toMatch(/unclaimed|sign in/i);
  });

  it("each state has its own icon and colour (never colour alone)", () => {
    const kinds: OwnershipKind[] = ["UNCLAIMED_SIGNED_OUT", "UNCLAIMED_CLAIMABLE", "CLAIMED_OWNER", "TEAM"];
    const icons = kinds.map((k) => /<svg[\s\S]*?<\/svg>/.exec(own(k, { onClaim: () => undefined }))![0]);
    expect(new Set(icons).size).toBe(4);
    expect(own("CLAIMED_OWNER")).toContain("border-ok/40");
    expect(own("UNCLAIMED_CLAIMABLE")).toContain("border-teal/45");
    expect(own("UNCLAIMED_SIGNED_OUT")).toContain("border-dashed");
  });

  it("ARENA SUSPENDED is shown to the member, with real rules and NO reason; a suspended hero cannot be claimed", () => {
    const out = own("UNCLAIMED_CLAIMABLE", { selfStatus: "SUSPENDED", onClaim: () => undefined });
    expect(out).toContain('data-testid="arena-notice"');
    expect(text(out)).toContain("Arena suspended");
    expect(text(out)).toContain("This hero isn't entering new Arena battles right now. Its history and rank are kept.");
    expect(out).not.toContain("ownership-claim"); // the server refuses it — so there is no button that always fails
    expect(text(out)).not.toMatch(/because|reason|violat|spam|cheat|abuse|banned|moderat/i);
    expect(text(own("CLAIMED_OWNER", { selfStatus: "INACTIVE" }))).toContain("Not in the Arena");
    expect(own("CLAIMED_OWNER", { selfStatus: "ACTIVE" })).not.toContain("arena-notice");
    expect(own("CLAIMED_OWNER")).not.toContain("arena-notice");
    expect(arenaNotice(null)).toBeNull();
    expect(arenaNotice("SUSPENDED")!.body).not.toMatch(/because|reason/i);
  });

  it("shows the claim result note, and the small-screen Sign out only for the owner", () => {
    expect(own("CLAIMED_OWNER", { note: "Hero claimed!" })).toMatch(/role="status"[^>]*>Hero claimed!/);
    expect(own("CLAIMED_OWNER", { onSignOut: () => undefined })).toContain('data-testid="ownership-sign-out"');
    expect(own("CLAIMED_PUBLIC")).not.toContain("ownership-sign-out");
  });

  it("every state's copy is short enough to read at a glance", () => {
    const kinds: OwnershipKind[] = ["TEAM", "DEMO", "UNCLAIMED_SIGNED_OUT", "UNCLAIMED_CLAIMABLE", "UNCLAIMED_OTHER", "CLAIMED_OWNER", "CLAIMED_PUBLIC"];
    for (const k of kinds) expect(ownershipCopy(k).body.length).toBeLessThan(90);
  });
});

describe("hero actions — View hero card · Download · Share", () => {
  const bar = (over: Partial<Parameters<typeof HeroActionBar>[0]> = {}) => render(createElement(HeroActionBar, { publicId: PUBLIC_ID, model: { name: "Forge Fay", rarity: "EPIC", className: "Mage", power: 177 }, origin: ORIGIN, ...over }));

  it("VIEW HERO CARD opens the public hero page", () => {
    const out = bar();
    const tag = tagOf(out, "hero-view-card");
    expect(tag).toMatch(new RegExp(`^<a\\b[^>]*href="/heroes/${PUBLIC_ID}"`));
    expect(tag).toContain('aria-label="View hero card — opens this hero&#x27;s public page"');
    expect(text(out)).toContain("View hero card");
  });

  it("DOWNLOAD is the generated PNG of the CURRENT card (no stale content key), with a file name", () => {
    const out = bar();
    expect(out).toMatch(new RegExp(`<a [^>]*href="/api/hero-cards/${PUBLIC_ID}\\?download=1"`));
    expect(out).toContain(`download="clank-rpg-hero-${PUBLIC_ID}.png"`);
    expect(out).toContain('aria-label="Download hero card as a PNG image"');
    expect(out).not.toContain("?v=");
    expect(out).not.toContain("&amp;v=");
  });

  it("SHARE is a disclosure with two honest options: post on X (new tab) and copy the canonical link", () => {
    const out = bar();
    expect(out).toMatch(/<button [^>]*aria-expanded="false"[^>]*data-testid="hero-share"/);
    const controls = /aria-controls="([^"]+)"/.exec(out)![1]!;
    expect(out).toMatch(new RegExp(`id="${controls.replace(/[:]/g, "\\:")}"[^>]*hidden`)); // closed until opened — not tabbable
    const x = /<a [^>]*href="([^"]+)"[^>]*data-testid="hero-share-x"[^>]*>/.exec(out)!;
    const href = decodeURIComponent(x[1]!.replace(/&amp;/g, "&"));
    expect(href).toContain("https://x.com/intent/post?text=");
    expect(href).toContain(`url=${ORIGIN}/heroes/${PUBLIC_ID}`);
    expect(href).toContain("Forge Fay");
    expect(href).toContain("PWR 177");
    expect(x[0]).toContain('target="_blank"');
    expect(x[0]).toContain('rel="noopener noreferrer"');
    expect(x[0]).toContain('aria-label="Post on X (opens in a new tab)"');
    expect(out).toContain('data-testid="hero-copy-link"');
    expect(text(out)).toContain("X can't attach the image");
  });

  it("the native share sheet is NOT used (the profile never used it)", () => {
    expect(read("src/components/character/HeroIdentity.tsx")).not.toMatch(/navigator\.share/);
  });

  it("keeps a polite live region for 'Link copied' that is present from the start", () => {
    expect(bar()).toMatch(/<p role="status" class="sr-only" data-testid="hero-copy-status">/);
  });

  it("buttons are real links / buttons (keyboard reachable) with 44 px targets, and every icon is decorative", () => {
    const out = bar();
    expect(out).not.toContain("btn-sm"); // 2.1 rem would be a tiny target
    expect(out).not.toContain("tabindex");
    for (const tag of out.match(/<(a|button)\b[^>]*>/g) ?? []) expect(tag).toMatch(/class="[^"]*\bbtn\b/);
    for (const svg of out.match(/<svg\b[^>]*>/g) ?? []) expect(svg).toContain('aria-hidden="true"');
    expect(read("src/app/globals.css")).toMatch(/\.btn \{[^}]*min-height: 2\.75rem/);
    expect(read("src/app/globals.css")).toMatch(/\.btn > svg \{\s*flex-shrink: 0/);
  });

  it("on a phone the actions are full-width (view) and two columns (download / share)", () => {
    const out = bar();
    expect(out).toContain('class="grid grid-cols-2 gap-2.5"');
    expect(out).toMatch(/class="btn col-span-2"[^>]*data-testid="hero-view-card"/);
  });
});

describe("the identity panel", () => {
  it("is ONE panel: art → name → rarity + class → tagline → ownership → actions", () => {
    const html = panel({ hero: { rarity: "RARE", classId: "warrior", title: "Chat Veteran" }, classVisual: classVisual("Warrior") });
    const order = ["rarity-frame", "hero-name", "rarity-plaque", "class-tag", "hero-tagline", "ownership-panel", "hero-actions"].map((id) => html.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(text(html)).toContain("Chat Veteran");
    expect(text(html)).toContain("The Warrior way of fighting.");
    expect(html).toContain('data-arena="image"'); // the rarity's arena artwork
  });

  it("every rarity and every class renders the whole identity block", () => {
    for (const rarity of RARITIES) {
      for (const classId of CLASSES) {
        const html = panel({ hero: { rarity, classId }, classVisual: classVisual(classId) });
        expect(html).toContain(`data-rarity="${rarity}"`);
        expect(html).toContain(`data-class="${classId}"`);
        expect(html).toContain('data-testid="hero-actions"');
      }
    }
  });

  it("a missing class definition still renders (class id as the name, no tagline)", () => {
    const html = panel({ classVisual: null, hero: { classId: "warrior" } });
    expect(text(html)).toContain("Class warrior");
    expect(html).not.toContain("hero-tagline");
  });

  it("the name is the dominant type; long names step down and wrap — they are never cut off", () => {
    const long = "Maximilian Bartholomew Fitzwilliam-Smyth"; // 40 characters, the maximum
    const html = panel({ hero: { name: long } });
    expect(html).toContain(`>${long}</h1>`);
    expect(html).toContain(`title="${long}"`);
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).not.toMatch(/<h1[^>]*line-clamp/);
    expect(html).not.toMatch(/<h1[^>]*truncate/);
    expect(nameSize("Fay")).toBe("text-2xl sm:text-3xl");
    expect(nameSize("A".repeat(20))).toBe("text-xl sm:text-2xl");
    expect(nameSize(long)).toBe("text-lg sm:text-xl");
    expect(panel({ hero: { name: "Supercalifragilisticexpialidocious" } })).toContain("Supercalifragilisticexpialidocious");
  });

  it("an escape-looking name stays text", () => {
    const html = panel({ hero: { name: "<img src=x onerror=alert(1)>" } });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("lays out as a top section on tablets and phones, a 320 px rail only from lg", () => {
    const html = panel();
    expect(html).toContain("md:grid-cols-[minmax(0,17.5rem)_minmax(0,1fr)]"); // tablet: art beside the details
    expect(html).toContain("lg:block"); // desktop: stacked in the rail
    expect(html).toContain("grid-cols-1 gap-2 sm:max-lg:grid-cols-2"); // rarity / class: stacked on phones, side by side on tablets
    expect(html).toContain("max-w-[22rem]"); // the art never grows past a sensible size on a phone
    const view = read("src/components/character/HeroView.tsx");
    expect(view).toContain("lg:grid-cols-[320px_minmax(0,1fr)]");
    expect(view).toContain('className="hero-rail min-w-0 space-y-4"');
    const css = read("src/app/globals.css");
    expect(css).toMatch(/@media \(min-width: 64rem\) and \(min-height: 62rem\) \{\s*\.hero-rail \{\s*position: sticky/); // sticks only when it fits the window
  });
});

describe("standing — combat power and development rank", () => {
  it("PWR is huge, labelled COMBAT POWER, with one short subtle line", () => {
    const out = render(createElement(CombatPower, { power: 137, rarity: "COMMON" }));
    expect(out).toContain('data-pwr="137"');
    expect(out).toContain("text-6xl"); // the xl PWR size
    expect(text(out)).toBe("Combat power PWR 137 An estimate of this hero's combat strength.");
  });

  it("never prints a rarity tier range or promises victory", () => {
    for (const rarity of RARITIES) {
      const html = panel({ hero: { rarity } }) + render(createElement(HeroStandingPanel, { power: 143, rarity, season: season() }));
      const t = text(html);
      expect(t).not.toMatch(/\btier\b/i); // "Common tier: 130–149" and friends
      expect(t).not.toMatch(/\d{2,3}\s*[–—-]\s*\d{2,3}/);
      expect(t).not.toMatch(/guarantee|always win|will win|wins? every|beat(s)? everyone/i);
    }
    const view = read("src/components/character/HeroView.tsx");
    expect(view).not.toContain("RARITY_RULES");
    expect(view).not.toMatch(/tier\.\s*PWR/);
    expect(read("src/components/character/HeroIdentity.tsx")).not.toMatch(/RARITY_RULES/);
  });

  it("Development rank: the word stays visible, rank name + points first, then one progress bar", () => {
    const out = render(createElement(RankProgress, { season: season() }));
    expect(text(out)).toContain("Development rank");
    expect(out).toMatch(/data-testid="season-rank-name">Silver</);
    expect(text(out)).toContain("340 pts");
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-label="Progress to Gold"');
    expect(out).toContain('aria-valuenow="40"');
    expect(out).toContain("width:40%");
    expect(text(out)).toContain("160 pts to Gold");
    expect(out).not.toContain("<ul"); // the old pips are gone
  });

  it("an unranked hero, a top-rank hero and no season at all each read correctly", () => {
    const unranked = render(createElement(RankProgress, { season: season({ ranked: false, points: 0, battles: 0, rank: { id: "unranked", name: "Unranked", index: -1, tierCount: 5, next: null, pointsToNext: null, progress: 0 } }) }));
    expect(unranked).toContain('aria-valuenow="0"');
    expect(text(unranked)).toContain("Unranked");
    expect(text(unranked)).toContain("Fight your first battle to get ranked.");
    const top = render(createElement(RankProgress, { season: season({ rank: { id: "mythic", name: "Mythic", index: 4, tierCount: 5, next: null, pointsToNext: null, progress: 1 } }) }));
    expect(top).toContain('aria-valuenow="100"');
    expect(text(top)).toContain("Top rank reached.");
    expect(text(render(createElement(RankProgress, { season: null })))).toContain("No season is running yet.");
    expect(text(render(createElement(RankProgress, { season: season({ kind: "COMPETITIVE", number: 1, label: "Season 1" }) })))).toContain("Season 1 rank");
  });

  it("the standing panel is one panel holding both, side by side on tablets", () => {
    const out = render(createElement(HeroStandingPanel, { power: 207, rarity: "LEGENDARY", season: season() }));
    expect(out).toContain('data-testid="hero-standing"');
    expect(out.indexOf("combat-power")).toBeLessThan(out.indexOf("season-rank"));
    expect(out).toContain("md:grid-cols-2");
    expect(out).toContain("lg:grid-cols-1");
  });
});
