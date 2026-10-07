import { describe, expect, it } from "vitest";

import { generateCharacter } from "@/domain/character/generate";
import { rollAppearance, type AppearanceParts } from "@/domain/character/appearance";
import { DEFAULT_CLASSES } from "@/domain/content";
import { LOOK_BODIES, LOOK_HEADGEAR, LOOK_WEAPONS } from "@/domain/rules";
import { COSMETIC_ITEMS, CATALOG_VERSION, fitsClass, getCosmetic, isUsable } from "@/domain/sprites/catalog";
import { applyOverrides, classDefaults, deriveSpriteConfig, resolvePalette, resolveSpriteConfig, sanitizeSpriteConfig, spriteKey, type SpriteConfig } from "@/domain/sprites/config";
import { frameAt, resolveClip, selectPlayback, type AnimInput } from "@/domain/sprites/animator";
import { blockSize, cellRect, clipDurationMs, resolveDirection } from "@/domain/sprites/geometry";
import { planLayers } from "@/domain/sprites/plan";
import { parseManifest, safeParseManifest } from "@/domain/sprites/spec";
import { createRng } from "@/domain/util/rng";
import { DEFAULT_SETTINGS } from "@/domain/settings";

import { makeManifest } from "../support/sprites";

const warrior = DEFAULT_CLASSES.find((c) => c.id === "warrior")!;
const mage = DEFAULT_CLASSES.find((c) => c.id === "mage")!;
const tank = DEFAULT_CLASSES.find((c) => c.id === "tank")!;
const neutral = { msgs: 0, replies: 0, questions: 0, exclaims: 0, long: 0, links: 0, media: 0, night: 0, burst: 0, spam: 0 };

const partsFor = (seed: string, cls = warrior, rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY" = "COMMON") => rollAppearance(createRng(seed), cls, rarity);

describe("cosmetic catalogue", () => {
  it("has unique ids that are prefixed by their slot", () => {
    expect(new Set(COSMETIC_ITEMS.map((i) => i.id)).size).toBe(COSMETIC_ITEMS.length);
    for (const i of COSMETIC_ITEMS) expect(i.id.startsWith(`${i.slot}.`), i.id).toBe(true);
  });

  it("covers every look value a class can declare (so admin-added classes still render)", () => {
    for (const w of LOOK_WEAPONS) expect(getCosmetic(`weapon.${w}`), w).toBeDefined();
    for (const h of LOOK_HEADGEAR) expect(getCosmetic(`headgear.${h}`), h).toBeDefined();
    for (const b of LOOK_BODIES) expect(getCosmetic(`outfit.${b}`), b).toBeDefined();
  });

  it("is cosmetic only: items carry no stat or combat fields, just visual metadata", () => {
    const allowed = new Set(["id", "slot", "name", "tier", "source", "fits", "hides", "enabled"]); // all purely visual
    for (const i of COSMETIC_ITEMS) expect(Object.keys(i).filter((k) => !allowed.has(k)), i.id).toEqual([]);
  });

  it("class-compatibility: weapons and outfits are locked to their class look, flair is open", () => {
    expect(isUsable("weapon.sword", warrior.look)).toBe(true);
    expect(isUsable("weapon.staff", warrior.look)).toBe(false);
    expect(isUsable("weapon.sword", mage.look)).toBe(false);
    expect(isUsable("outfit.robe", mage.look)).toBe(true);
    expect(isUsable("outfit.heavy", mage.look)).toBe(false);
    expect(isUsable("offhand.shield", tank.look)).toBe(true);
    expect(isUsable("offhand.shield", warrior.look)).toBe(false);
    for (const c of DEFAULT_CLASSES) {
      expect(isUsable("aura.flame", c.look)).toBe(true);
      expect(isUsable("cape.default", c.look)).toBe(true);
      expect(isUsable("accessory.goggles", c.look)).toBe(true);
    }
  });

  it("an item is unusable when unknown, catalogue-disabled or admin-disabled", () => {
    expect(isUsable("weapon.nope", warrior.look)).toBe(false);
    expect(isUsable("aura.ring", warrior.look, { disabled: ["aura.ring"] })).toBe(false);
    expect(isUsable("aura.ring", warrior.look, { disabled: new Set(["other"]) })).toBe(true);
    expect(fitsClass({ id: "x.y", slot: "weapon", name: "x", tier: "COMMON", source: "STARTER", enabled: true }, warrior.look)).toBe(true);
  });
});

describe("deterministic procedural look", () => {
  it("the same appearance parts always derive the identical config", () => {
    const p = partsFor("hero-1");
    expect(deriveSpriteConfig(p, warrior.look)).toEqual(deriveSpriteConfig(p, warrior.look));
    expect(spriteKey(deriveSpriteConfig(p, warrior.look), warrior.look.colors, "COMMON")).toBe(spriteKey(deriveSpriteConfig(p, warrior.look), warrior.look.colors, "COMMON"));
  });

  it("a hero keeps the same config across generations (idempotent per member + secret)", () => {
    const input = { telegramUserId: 42, displayName: "Ada", behavior: neutral, activityScore: 40, classes: DEFAULT_CLASSES, settings: DEFAULT_SETTINGS, secret: "test-secret-value-123456" };
    const a = generateCharacter(input);
    const b = generateCharacter(input);
    expect(a.sprite).toEqual(b.sprite);
    expect(a.sprite).toEqual(deriveSpriteConfig(a.appearance, DEFAULT_CLASSES.find((c) => c.id === a.classId)!.look));
  });

  it("different heroes get different looks (variety) yet always a valid, class-compatible kit", () => {
    const keys = new Set<string>();
    for (let id = 1; id <= 300; id++) {
      const g = generateCharacter({ telegramUserId: id, displayName: "x", behavior: neutral, activityScore: 10, classes: DEFAULT_CLASSES, settings: DEFAULT_SETTINGS, secret: "test-secret-value-123456" });
      const cls = DEFAULT_CLASSES.find((c) => c.id === g.classId)!;
      keys.add(spriteKey(g.sprite, cls.look.colors, g.rarity));
      // every item is usable by the class, and class identity (outfit + weapon) is always present
      for (const [slot, itemId] of Object.entries(g.sprite.slots)) expect(isUsable(itemId!, cls.look), `${slot}:${itemId}`).toBe(true);
      expect(g.sprite.slots.weapon).toBe(`weapon.${cls.look.weapon}`);
      expect(g.sprite.slots.outfit).toBe(`outfit.${cls.look.body}`);
      expect(g.sprite.slots.headgear).toBe(`headgear.${cls.look.headgear}`);
      expect(sanitizeSpriteConfig(g.sprite, cls.look)).toEqual(g.sprite);
    }
    expect(keys.size).toBeGreaterThan(250);
  });

  it("each of the six classes reads differently at a glance: distinct weapon, outfit/headgear combos", () => {
    const kits = DEFAULT_CLASSES.map((c) => classDefaults(c.look));
    expect(new Set(kits.map((k) => k.weapon)).size).toBe(6);
    expect(new Set(kits.map((k) => `${k.outfit}|${k.headgear}`)).size).toBeGreaterThanOrEqual(5);
    expect(classDefaults(tank.look).offhand).toBe("offhand.shield");
    expect(classDefaults(warrior.look).offhand).toBeUndefined();
  });

  it("rarity DRESSES the hero (aura, cape, trim, pauldrons, crest, weapon glow) but never replaces the class kit", () => {
    const common = deriveSpriteConfig(partsFor("same-hero", warrior, "COMMON"), warrior.look, "COMMON");
    const legendary = deriveSpriteConfig(partsFor("same-hero", warrior, "LEGENDARY"), warrior.look, "LEGENDARY");
    expect(common.slots.aura).toBeUndefined();
    expect(common.slots.trim ?? common.slots.shoulder ?? common.slots.crest ?? common.slots.weaponfx).toBeUndefined(); // Common: clean, nothing added
    expect(legendary.slots.aura).toBe("aura.flame");
    expect(legendary.slots.cape).toBe("cape.default");
    for (const slot of ["trim", "shoulder", "crest", "weaponfx"] as const) expect(legendary.slots[slot], slot).toMatch(/\.legendary\./); // Legendary wears the whole set
    // the class identity — weapon, outfit, headgear — is exactly the class default under every rarity
    expect(legendary.slots.weapon).toBe(common.slots.weapon);
    expect(legendary.slots.outfit).toBe(common.slots.outfit);
    expect(legendary.slots.headgear).toBe(common.slots.headgear);
    // and rarity DOES change the generated stats: the same member rolled as Legendary is stronger than as Common (class is unchanged)
    const base = { telegramUserId: 9, displayName: "x", behavior: neutral, activityScore: 50, classes: DEFAULT_CLASSES, secret: "s".repeat(24) };
    const rolled = (rarity: "COMMON" | "LEGENDARY") => generateCharacter({ ...base, settings: { ...DEFAULT_SETTINGS, character: { ...DEFAULT_SETTINGS.character, rarityWeights: { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0, [rarity]: 1 } } } });
    expect(rolled("LEGENDARY").classId).toBe(rolled("COMMON").classId);
    expect(rolled("LEGENDARY").power).toBeGreaterThan(rolled("COMMON").power);
  });

  it("tolerates garbage persisted parts (never throws, always yields a usable kit)", () => {
    const junk = { skin: NaN, hairStyle: -3, hairColor: 1e9, eyes: "x", mouth: undefined, accessory: 99, cape: true, aura: "plasma", outfitHue: -50 } as unknown as AppearanceParts;
    const cfg = deriveSpriteConfig(junk, warrior.look);
    expect(sanitizeSpriteConfig(cfg, warrior.look)).toEqual(cfg);
    expect(cfg.slots.aura).toBeUndefined(); // unknown aura is dropped, not rendered as a missing layer
    expect(deriveSpriteConfig(junk, undefined).slots.weapon).toBe("weapon.sword");
  });
});

describe("resolving, sanitising and customising", () => {
  const base = deriveSpriteConfig(partsFor("hero-x", warrior, "EPIC"), warrior.look);

  it("a stored config wins over re-derivation (a catalogue update can never change an existing hero)", () => {
    const stored: SpriteConfig = { ...base, hue: 7, slots: { ...base.slots, hair: "hair.4" } };
    const out = resolveSpriteConfig({ stored, parts: partsFor("hero-x", warrior, "EPIC"), look: warrior.look });
    expect(out.hue).toBe(7);
    expect(out.slots.hair).toBe("hair.4");
  });

  it("legacy rows (no stored config) and malformed stored values fall back to derivation", () => {
    const parts = partsFor("legacy");
    const derived = deriveSpriteConfig(parts, warrior.look);
    expect(resolveSpriteConfig({ stored: null, parts, look: warrior.look })).toEqual(derived);
    expect(resolveSpriteConfig({ stored: { v: 99, nonsense: true }, parts, look: warrior.look })).toEqual(derived);
    expect(resolveSpriteConfig({ stored: "oops", parts, look: warrior.look })).toEqual(derived);
  });

  it("overrides must be class-compatible and exist: invalid ones are ignored, valid ones apply", () => {
    const o = applyOverrides(base, { weapon: "weapon.staff", headgear: "headgear.crown", aura: "aura.ring", hair: "hair.nope" }, warrior.look);
    expect(o.slots.weapon).toBe("weapon.sword"); // a Warrior cannot hold a Mage's staff
    expect(o.slots.headgear).toBe("headgear.crown"); // headgear is open to every class
    expect(o.slots.aura).toBe("aura.ring");
    expect(o.slots.hair).toBe(base.slots.hair); // unknown item ignored
    expect(base.slots.headgear).toBe("headgear.helm"); // the generated look was not mutated
  });

  it("null clears an optional slot but class-identity slots can never be emptied", () => {
    const o = applyOverrides(base, { aura: null, cape: null, outfit: null, weapon: null }, warrior.look);
    expect(o.slots.aura).toBeUndefined();
    expect(o.slots.cape).toBeUndefined();
    expect(o.slots.outfit).toBe("outfit.medium");
    expect(o.slots.weapon).toBe("weapon.sword");
  });

  it("never throws on corrupt override values (numbers, strings, arrays, nested junk)", () => {
    for (const junk of [7, "x", [], [1, 2], true, { weapon: 5, aura: {}, hair: ["hair.1"] }]) {
      expect(() => applyOverrides(base, junk as never, warrior.look), JSON.stringify(junk)).not.toThrow();
      expect(resolveSpriteConfig({ stored: base, parts: partsFor("hero-x"), look: warrior.look, overrides: junk as never }).slots.weapon).toBe("weapon.sword");
    }
  });

  it("clearing every override restores the generated look exactly", () => {
    const customised = applyOverrides(base, { headgear: "headgear.crown", aura: null }, warrior.look);
    expect(customised).not.toEqual(base);
    expect(applyOverrides(base, {}, warrior.look)).toEqual(base);
    expect(applyOverrides(base, null, warrior.look)).toEqual(base);
  });

  it("admin-disabled cosmetics disappear; required slots fall back to the class default", () => {
    const out = resolveSpriteConfig({ stored: base, parts: partsFor("hero-x"), look: warrior.look, disabled: ["aura.flame", "aura.sparks", "cape.default", "weapon.sword"] });
    expect(out.slots.aura).toBeUndefined();
    expect(out.slots.cape).toBeUndefined();
    expect(out.slots.weapon).toBeUndefined(); // the class default itself is disabled → nothing rather than a wrong weapon
    expect(out.slots.outfit).toBe("outfit.medium");
  });

  it("sanitising drops items for the wrong class (e.g. a stale config after a class change)", () => {
    const asMage = sanitizeSpriteConfig(base, mage.look)!;
    expect(asMage.slots.weapon).toBe("weapon.staff");
    expect(asMage.slots.outfit).toBe("outfit.robe");
  });

  it("palette derives from the class colours + the hero's own picks; rarity tints come from the shared rarity palette", () => {
    const p = resolvePalette(base, warrior.look.colors, "LEGENDARY");
    expect(Object.keys(p).sort()).toEqual(["accent", "cape", "hair", "primary", "rarity", "secondary", "skin"]);
    expect(p.rarity).toBe("#ffb020");
    expect(resolvePalette(base, warrior.look.colors, "NOPE").rarity).toBe("#9aa4b2"); // unknown rarity degrades to COMMON grey
  });

  it("stamps the catalogue version it was generated against", () => {
    expect(base.catalog).toBe(CATALOG_VERSION);
  });
});

describe("sprite manifest contract", () => {
  it("accepts a complete set", () => {
    expect(() => parseManifest(makeManifest())).not.toThrow();
  });

  it.each([
    ["a missing required clip", (m: ReturnType<typeof makeManifest>) => { delete m.clips.hit; }, /hit/],
    ["a clip row reused", (m: ReturnType<typeof makeManifest>) => { m.clips.move!.row = 0; }, /reuses row/],
    ["an impact frame outside the clip", (m: ReturnType<typeof makeManifest>) => { m.clips.hit!.impact = 5; }, /impact/],
    ["a layer referencing an unknown image", (m: ReturnType<typeof makeManifest>) => { m.layers["body.base"]!.image = "ghost"; }, /unknown image/],
    ["no body layer", (m: ReturnType<typeof makeManifest>) => { delete m.layers["body.base"]; }, /body\.base/],
    ["a weapon naming an attack clip the set lacks", (m: ReturnType<typeof makeManifest>) => { delete m.clips.attack_shoot; }, /attack_shoot/],
    ["no authored right direction", (m: ReturnType<typeof makeManifest>) => { m.directions = { left: { index: 0 } }; }, /right/],
    ["a mirror pointing at nothing", (m: ReturnType<typeof makeManifest>) => { m.directions = { right: { index: 0 }, left: { mirror: "up" } }; }, /mirror/],
  ])("rejects %s", (_name, mutate, message) => {
    const m = makeManifest();
    mutate(m);
    const r = safeParseManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it("pixelArt is optional (default: crisp, unsmoothed) and must be a boolean when given", () => {
    expect(safeParseManifest({ ...makeManifest(), pixelArt: false }).ok).toBe(true);
    expect(safeParseManifest({ ...makeManifest(), pixelArt: "yes" }).ok).toBe(false);
  });

  it("rejects unknown fields and hostile image paths", () => {
    expect(safeParseManifest({ ...makeManifest(), extra: 1 }).ok).toBe(false);
    expect(safeParseManifest({ ...makeManifest(), images: { atlas: "../../etc/passwd.png" } }).ok).toBe(false);
    expect(safeParseManifest({ ...makeManifest(), images: { atlas: "https://evil.example/x.png" } }).ok).toBe(false);
  });
});

describe("layer planning and the missing-asset fallback", () => {
  const cfg = deriveSpriteConfig(partsFor("plan", tank, "LEGENDARY"), tank.look);

  it("orders layers by z (cape behind the body, weapon in front); auras loop on their own", () => {
    const plan = planLayers(cfg, makeManifest());
    expect(plan.fallback).toBe(false);
    expect(plan.missing).toEqual([]);
    const ids = plan.layers.map((l) => l.id);
    expect(ids[0]).toBe("cape.default"); // drawn behind everything
    expect(ids.indexOf("body.base")).toBeLessThan(ids.indexOf("outfit.heavy"));
    expect(ids.indexOf("outfit.heavy")).toBeLessThan(ids.indexOf("weapon.mace"));
    const zs = plan.layers.map((l) => l.def.z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
    expect(plan.aura?.id).toBe("aura.flame");
    expect(plan.layers.some((l) => l.slot === "aura")).toBe(false);
  });

  it("a missing OPTIONAL layer is skipped and reported; the hero still renders", () => {
    const plan = planLayers(cfg, makeManifest({}, ["aura.flame", cfg.slots.hair ?? "hair.0", "cape.default"]));
    expect(plan.fallback).toBe(false);
    expect(plan.missing).toEqual(expect.arrayContaining(["aura.flame", "cape.default"]));
    expect(plan.aura).toBeNull();
  });

  it("a missing OUTFIT (class identity) or BODY demands the vector fallback — a hero is never invisible", () => {
    expect(planLayers(cfg, makeManifest({}, [cfg.slots.outfit!])).fallback).toBe(true);
    const noBody = makeManifest();
    delete noBody.layers["body.base"];
    expect(planLayers(cfg, noBody).fallback).toBe(true);
  });

  it("a full helm hides the hair; other headgear shows it", () => {
    const m = makeManifest();
    const helmed = { ...cfg, slots: { ...cfg.slots, hair: "hair.1", headgear: "headgear.helm" } };
    const capped = { ...cfg, slots: { ...cfg.slots, hair: "hair.1", headgear: "headgear.cap" } };
    expect(planLayers(helmed, m).layers.some((l) => l.slot === "hair")).toBe(false);
    expect(planLayers(capped, m).layers.some((l) => l.slot === "hair")).toBe(true);
  });

  it("multi-part items: parts (a sleeve in front of the torso) render with their owner, at their own depth", () => {
    const m = makeManifest();
    m.layers["outfit.heavy.front"] = { image: "atlas", x: 0, y: 0, z: 66, tint: "primary", of: "outfit.heavy" };
    m.layers["body.arm"] = { image: "atlas", x: 0, y: 0, z: 64, tint: "skin", of: "body.base" };
    const plan = planLayers(cfg, m); // cfg is a Tank: outfit.heavy
    const ids = plan.layers.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(["outfit.heavy", "outfit.heavy.front", "body.arm"]));
    expect(ids.indexOf("outfit.heavy")).toBeLessThan(ids.indexOf("weapon.mace"));
    // the sleeve sits in front of the torso but behind the weapon
    expect(ids.indexOf("outfit.heavy.front")).toBeGreaterThan(ids.indexOf("outfit.heavy"));
    expect(ids.indexOf("outfit.heavy.front")).toBeLessThan(ids.indexOf("weapon.mace"));
    // parts of an item the hero does not wear are not drawn
    const mageCfg = deriveSpriteConfig(partsFor("m", mage), mage.look);
    expect(planLayers(mageCfg, m).layers.some((l) => l.id === "outfit.heavy.front")).toBe(false);
    // …and a part of an unknown owner is a broken manifest
    m.layers["outfit.ghost.front"] = { image: "atlas", x: 0, y: 0, z: 66, of: "outfit.ghost" };
    expect(safeParseManifest(m).ok).toBe(false);
  });

  it("the weapon decides the attack animation", () => {
    const m = makeManifest();
    const bow = deriveSpriteConfig(partsFor("r", DEFAULT_CLASSES.find((c) => c.id === "ranger")!), DEFAULT_CLASSES.find((c) => c.id === "ranger")!.look);
    expect(planLayers(bow, m).attackClip).toBe("attack_shoot");
    expect(planLayers(deriveSpriteConfig(partsFor("m", mage), mage.look), m).attackClip).toBe("attack_thrust");
    expect(planLayers(deriveSpriteConfig(partsFor("w", warrior), warrior.look), m).attackClip).toBe("attack_slash");
  });
});

describe("geometry and directions", () => {
  const m = makeManifest();

  it("every layer block is the same size, so layers are interchangeable", () => {
    expect(blockSize(m)).toEqual({ w: 6 * 64, h: 9 * 64 });
  });

  it("cells are addressed by clip row and frame, clamped to the clip", () => {
    const layer = m.layers["body.base"]!;
    expect(cellRect(m, layer, m.clips.move!, 3, 0)).toEqual({ sx: 3 * 64, sy: 1 * 64, sw: 64, sh: 64 });
    expect(cellRect(m, layer, m.clips.hit!, 99, 0).sx).toBe(64); // clamped to the last frame
    expect(cellRect(m, layer, m.clips.hit!, -4, 0).sx).toBe(0);
  });

  it("left mirrors right by default; authored left/up/down rows are honoured", () => {
    expect(resolveDirection(m, "right")).toEqual({ index: 0, mirror: false });
    expect(resolveDirection(m, "left")).toEqual({ index: 0, mirror: true });
    expect(resolveDirection(m, "up")).toEqual({ index: 0, mirror: false }); // unauthored → degrade to right, never invisible
    const four = makeManifest({ directions: { right: { index: 0 }, down: { index: 1 }, up: { index: 2 }, left: { mirror: "right" } } });
    expect(resolveDirection(four, "down")).toEqual({ index: 1, mirror: false });
    expect(resolveDirection(four, "up")).toEqual({ index: 2, mirror: false });
    expect(blockSize(four).h).toBe(9 * 64 * 3);
    expect(cellRect(four, four.layers["body.base"]!, four.clips.idle!, 0, 2).sy).toBe(2 * 9 * 64);
    const authoredLeft = makeManifest({ directions: { right: { index: 0 }, left: { index: 1 } } });
    expect(resolveDirection(authoredLeft, "left")).toEqual({ index: 1, mirror: false });
  });
});

describe("animation selection", () => {
  const m = makeManifest();
  const calm: AnimInput = { alive: true, moving: false, victory: false, stunned: false, sinceAttackMs: Infinity, sinceSkillMs: Infinity, sinceHurtMs: Infinity, sinceKoMs: null, loopClockMs: 0 };
  const sel = (over: Partial<AnimInput>, attack = "attack_slash" as const) => selectPlayback({ ...calm, ...over }, m, attack);

  it("covers every required state: IDLE, MOVE, ATTACK, SKILL, HIT, KO (+ VICTORY)", () => {
    expect(sel({}).state).toBe("IDLE");
    expect(sel({ moving: true }).state).toBe("MOVE");
    expect(sel({ sinceAttackMs: 50 }).state).toBe("ATTACK");
    expect(sel({ sinceSkillMs: 50 }).state).toBe("SKILL");
    expect(sel({ sinceHurtMs: 30 }).state).toBe("HIT");
    expect(sel({ alive: false, sinceKoMs: 100 }).state).toBe("KO");
    expect(sel({ victory: true }).state).toBe("VICTORY");
  });

  it("priority: KO > VICTORY > skill/attack (most recent) > HIT > MOVE > IDLE", () => {
    expect(sel({ alive: false, sinceKoMs: 0, victory: true, sinceAttackMs: 10 }).state).toBe("KO");
    expect(sel({ victory: true, sinceAttackMs: 10 }).state).toBe("VICTORY");
    expect(sel({ sinceAttackMs: 100, sinceSkillMs: 40 }).state).toBe("SKILL");
    expect(sel({ sinceAttackMs: 40, sinceSkillMs: 100 }).state).toBe("ATTACK");
    expect(sel({ sinceAttackMs: 40, sinceHurtMs: 10, moving: true }).state).toBe("ATTACK"); // trading blows does not interrupt a swing
    expect(sel({ sinceHurtMs: 10, moving: true }).state).toBe("HIT");
    expect(sel({ moving: true, stunned: true }).state).toBe("IDLE"); // stunned heroes do not walk
  });

  it("one-shots finish and hold; loops wrap", () => {
    const slashMs = clipDurationMs(m.clips.attack_slash!);
    expect(sel({ sinceAttackMs: slashMs + 1 }).state).toBe("IDLE"); // swing is over
    expect(frameAt(m.clips.ko!, 99_999)).toBe(3); // KO holds the last frame
    expect(frameAt(m.clips.idle!, 0)).toBe(0);
    expect(frameAt(m.clips.idle!, 1000 / 6 * 4)).toBe(0); // 4 frames @ 6 fps wrap
    expect(sel({ alive: false, sinceKoMs: 99_999 }).frame).toBe(3);
  });

  it("attack frames advance with time since the event (so the swing lines up with the damage)", () => {
    const frames = [0, 70, 140, 210, 280].map((t) => sel({ sinceAttackMs: t }).frame);
    expect(frames).toEqual([0, 1, 2, 3, 4]);
  });

  it("optional clips degrade gracefully on a minimal set", () => {
    const minimal = makeManifest();
    delete minimal.clips.attack_shoot;
    delete minimal.clips.attack_thrust;
    delete minimal.clips.victory;
    for (const l of Object.values(minimal.layers)) delete l.attack;
    expect(resolveClip(minimal, "attack_shoot")).toBe("attack_slash");
    expect(resolveClip(minimal, "attack_thrust")).toBe("attack_slash");
    expect(resolveClip(minimal, "victory")).toBe("idle");
    expect(selectPlayback({ ...calm, victory: true }, minimal, "attack_shoot").clip).toBe("idle");
    expect(selectPlayback({ ...calm, sinceAttackMs: 10 }, minimal, "attack_shoot").clip).toBe("attack_slash");
  });
});
