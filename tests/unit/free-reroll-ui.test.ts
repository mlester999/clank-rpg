import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FreeRerollCard, RerollConfirmView, RerollResultView } from "@/components/character/FreeReroll";
import { heroStateKey, initialRerollFlow, isRetryable, isUncertain, rerollFlowReducer, type RerollAction, type RerollFlow } from "@/components/character/rerollFlow";
import type { HeroCardModel } from "@/domain/hero/card";
import { compareRerolled, rerollOddsView, type FreeRerollResultDto, type FreeRerollStatusDto } from "@/domain/hero/freeReroll";
import { DEFAULT_SETTINGS } from "@/domain/settings";

/**
 * THE FREE REROLL UI: every state of the panel, the irreversible-action confirmation (what it warns about, what it truthfully says is kept, how it stays disabled
 * until the acknowledgement), the result (honest about weaker / stronger), and the flow's rules (one submission, nothing assumed after a lost answer).
 */
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<\/?(b|strong|em|i)(\s[^>]*)?>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const NOW = Date.UTC(2026, 9, 9, 0, 0, 1); // one second into the UTC day
const NEXT = Date.UTC(2026, 9, 10);

const card = (over: Partial<HeroCardModel> = {}): HeroCardModel => ({
  publicId: "k7m2q9x4tb3d", name: "MARKYYESTER", classId: "ranger", className: "Ranger", rarity: "EPIC", power: 185, stats: { hp: 120, str: 8, def: 7, int: 22, agi: 10, cha: 9, luck: 11 }, seasonRank: null,
  look: {
    rarity: "EPIC", parts: { skin: 0, hairStyle: 0, hairColor: 0, eyes: 0, mouth: 0, accessory: 0, cape: false, aura: "none", outfitHue: 0 },
    sprite: { v: 1, catalog: 1, skin: 0, hairColor: 0, hue: 0, slots: { outfit: "outfit.light", weapon: "weapon.bow" } }, colors: ["#111111", "#222222", "#333333"], weapon: "bow", headgear: "hat", body: "medium",
  },
  ...over,
});
const odds = rerollOddsView(DEFAULT_SETTINGS.character.rarityWeights);
const result = (before: HeroCardModel, after: HeroCardModel): FreeRerollResultDto => ({ requestId: "11111111-1111-4111-8111-111111111111", alreadyApplied: false, rerolledAt: NOW, before, after, comparison: compareRerolled(before, after) });
const status = (over: Partial<FreeRerollStatusDto> = {}): FreeRerollStatusDto => ({ state: "AVAILABLE", serverNow: NOW, utcDay: "2026-10-09", nextResetAt: NEXT, block: null, message: null, current: card(), today: null, odds, ...over });
const renderCard = (s: FreeRerollStatusDto | null, over: { failed?: boolean; loading?: boolean } = {}) => renderToStaticMarkup(createElement(FreeRerollCard, { status: s, ...over }));

describe("the panel: every state is truthful — never a clickable button that is not really available", () => {
  it("AVAILABLE: 'Free hero reroll' · '1 available' · a REROLL HERO button that is enabled", () => {
    const html = renderCard(status());
    const t = text(html);
    expect(t).toMatch(/Free hero reroll/);
    expect(t).toMatch(/1 available/i);
    expect(html).toMatch(/<button[^>]*data-testid="free-reroll-open"[^>]*>/);
    expect(html).not.toMatch(/data-testid="free-reroll-open"[^>]*disabled/);
    expect(t).toMatch(/Reroll hero/);
    expect(t).toMatch(/You'll confirm first\. Your new hero could be weaker\./);
    expect(html).toContain('data-state="AVAILABLE"');
  });

  it("USED: 'Free reroll used' · 'Next free reroll in' · the countdown to the next 00:00 UTC (23H 59M 59S) · a DISABLED button", () => {
    const html = renderCard(status({ state: "USED", today: result(card(), card({ rarity: "RARE", power: 162 })) }));
    const t = text(html);
    expect(t).toMatch(/Free reroll used/);
    expect(t).toMatch(/Next free reroll in 23H 59M 59S/);
    expect(html).toMatch(/role="timer"[^>]*aria-label="Next free reroll in"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="free-reroll-open-disabled"|<button[^>]*data-testid="free-reroll-open-disabled"[^>]*disabled=""/);
    expect(html).not.toContain('data-testid="free-reroll-open"'); // there is no enabled button at all
    expect(html).toContain('aria-disabled="true"');
    expect(t).not.toMatch(/00:00 UTC/); // the exact reset time is a tooltip, not the headline
    expect(html).toContain('title="Resets at 2026-10-10 00:00 UTC"');
  });

  it("the countdown reads 02D…/hours correctly at other moments and never negative (formatter pinned in free-reroll.test.ts)", () => {
    const t = text(renderCard(status({ state: "USED", serverNow: Date.UTC(2026, 9, 9, 15, 35, 48) })));
    expect(t).toMatch(/Next free reroll in 08H 24M 12S/);
  });

  it("BLOCKED: the reason in plain words (no button): not claimed · in an Arena fight (your free reroll is still waiting) · unavailable (no reason)", () => {
    const blocked = (block: FreeRerollStatusDto["block"], message: string) => renderCard(status({ state: "BLOCKED", block, message }));
    const arena = blocked("HERO_IN_ARENA", "Your hero is lined up for a live Arena fight. Try again once the upcoming fights have finished — your free reroll is still waiting.");
    expect(text(arena)).toMatch(/lined up for a live Arena fight.*your free reroll is still waiting/);
    expect(arena).not.toContain('data-testid="free-reroll-open"');
    expect(arena).not.toContain("disabled");
    expect(text(blocked("NOT_CLAIMED", "Claim your hero to use your free reroll."))).toContain("Claim your hero to use your free reroll.");
    const unavailable = blocked("HERO_UNAVAILABLE", "Your hero can't be rerolled right now.");
    expect(text(unavailable)).toContain("Your hero can't be rerolled right now.");
    expect(text(unavailable)).not.toMatch(/suspend|ban|flag|review/i);
  });

  it("DISABLED (feature flag off): 'Free rerolls aren't open yet.' — a plain, truthful state with no button; UNAVAILABLE says the server isn't ready", () => {
    const off = renderCard(status({ state: "DISABLED", current: null }));
    expect(text(off)).toContain("Free rerolls aren't open yet.");
    expect(text(off)).toMatch(/Not open yet/);
    expect(off).not.toMatch(/<button/);
    const un = renderCard(status({ state: "UNAVAILABLE", message: "Free rerolls aren't ready on this server yet.", current: null }));
    expect(text(un)).toContain("Free rerolls aren't ready on this server yet.");
    expect(un).not.toMatch(/<button/);
  });

  it("LOADING shows a skeleton, an unknown/failed read shows a retry — an unknown state never becomes 'available'", () => {
    const loading = renderCard(null);
    expect(loading).toContain('data-testid="free-reroll-loading"');
    expect(loading).not.toMatch(/<button/);
    const failed = renderCard(null, { failed: true });
    expect(text(failed)).toMatch(/Couldn't check your free reroll\./);
    expect(failed).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(failed).not.toContain('data-testid="free-reroll-open"');
  });
});

describe("the confirmation: 'Reroll your hero?' — the risk, said plainly", () => {
  const render = (over: Partial<Parameters<typeof RerollConfirmView>[0]> = {}) =>
    renderToStaticMarkup(createElement(RerollConfirmView, { current: card(), odds, acknowledged: false, submitting: false, error: null, titleId: "t1", onToggle: () => undefined, onCancel: () => undefined, onConfirm: () => undefined, ...over }));

  it("titles it, says the hero will be REPLACED by a new random roll, and shows the CURRENT hero: name, class, rarity and PWR", () => {
    const html = render();
    const t = text(html);
    expect(html).toContain('<h3 id="t1"');
    expect(t).toMatch(/Reroll your hero\?/);
    expect(t).toContain("Your current hero will be replaced with a new random roll.");
    expect(html).toMatch(/data-testid="reroll-current-name"[^>]*>MARKYYESTER</);
    expect(html).toMatch(/data-testid="reroll-current-class"[^>]*>Ranger</);
    expect(html).toContain('data-rarity="EPIC"');
    expect(t).toMatch(/Epic/);
    expect(html).toMatch(/data-pwr="185"/);
    expect(t).toMatch(/PWR 185/);
  });

  it("WARNS that the new hero could have a LOWER rarity, LOWER PWR, a different class and a different appearance — and that it cannot be restored", () => {
    const html = render();
    const t = text(html);
    expect(html).toContain('role="note"');
    expect(t).toMatch(/Warning: your new hero could have a lower rarity, lower PWR, a different class and a different appearance\./);
    expect(t).toMatch(/Once confirmed, you cannot restore your previous hero with this free reroll\./);
  });

  it("is honest about what is kept — and never claims earned rewards or history are lost", () => {
    const t = text(render());
    expect(t).toMatch(/You keep: your Gold, items, achievements, Arena record, Picks, Points and rewards\./);
    expect(t).toMatch(/Fights you already played still show your hero as it was then\./);
    expect(t).toMatch(/Gear made for your old class stays in your inventory but won't apply to a different class\./);
    expect(t).not.toMatch(/\b(lose|lost|erase|erased|wipe|wiped|delete|deleted|reset|forfeit)\b/i);
  });

  it("states the odds — the same for everyone, from the server's settings — and promises nothing", () => {
    const t = text(render());
    expect(t).toContain("Common 70% · Rare 22% · Epic 7% · Legendary 1%");
    expect(t).toMatch(/Nothing is guaranteed\./);
    expect(t).not.toMatch(/upgrade|guaranteed (upgrade|better)|better hero|improve/i);
    expect(odds.map((o) => o.percent)).toEqual(["70", "22", "7", "1"]);
  });

  it("the acknowledgement is required: an unchecked box disables CONFIRM; checked enables it; Cancel is always there and is the initial focus", () => {
    const off = render({ acknowledged: false });
    expect(off).toMatch(/type="checkbox"[^>]*data-testid="reroll-ack"/);
    expect(off).not.toMatch(/data-testid="reroll-ack"[^>]*checked/);
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*data-testid="reroll-confirm-button"|<button[^>]*data-testid="reroll-confirm-button"[^>]*disabled=""/);
    expect(text(off)).toContain("I understand that my new hero could be weaker and that this reroll cannot be undone.");
    const on = render({ acknowledged: true });
    expect(on).toMatch(/checked=""/);
    expect(on).not.toMatch(/<button[^>]*data-testid="reroll-confirm-button"[^>]*disabled/);
    expect(text(on)).toMatch(/Confirm reroll Uses today's free reroll/);
    expect(on).toMatch(/data-testid="reroll-cancel"/);
    expect(text(on)).toMatch(/Cancel/);
  });

  it("while submitting: 'Rerolling…', CONFIRM and Cancel and the checkbox are all disabled (no second click can do anything)", () => {
    const html = render({ acknowledged: true, submitting: true });
    expect(text(html)).toMatch(/Rerolling…/);
    expect(html).toMatch(/data-testid="reroll-confirm-button"[^>]*aria-busy="true"|aria-busy="true"[^>]*data-testid="reroll-confirm-button"/);
    for (const id of ["reroll-confirm-button", "reroll-cancel", "reroll-ack"]) {
      expect(html, id).toMatch(new RegExp(`<(button|input)[^>]*disabled=""[^>]*data-testid="${id}"|<(button|input)[^>]*data-testid="${id}"[^>]*disabled=""`));
    }
  });

  it("a definite refusal shows the message (alert) and, if nothing can be retried, replaces CONFIRM with Close", () => {
    const fatal = render({ error: { code: "ALREADY_USED_TODAY", message: "You've already used today's free reroll.", retryable: false } });
    expect(fatal).toContain('role="alert"');
    expect(text(fatal)).toContain("You've already used today's free reroll.");
    expect(fatal).not.toContain('data-testid="reroll-confirm-button"');
    expect(text(fatal)).toMatch(/Close/);
    const retry = render({ error: { code: "INVALID_ROLL", message: "The roll could not be completed. Nothing was used — try again.", retryable: true } });
    expect(retry).toContain('data-testid="reroll-confirm-button"');
    expect(retry).toContain('data-code="INVALID_ROLL"');
  });
});

describe("the result: 'Your new hero' — honest about weaker and stronger", () => {
  const render = (before: HeroCardModel, after: HeroCardModel) => renderToStaticMarkup(createElement(RerollResultView, { result: result(before, after), titleId: "r1", onView: () => undefined }));

  it("a WEAKER hero is said to be weaker: EPIC 185 → RARE 162 shows ▼ −23, 'Weaker' and the old/new rows", () => {
    const html = render(card(), card({ rarity: "RARE", power: 162, classId: "warrior", className: "Warrior" }));
    const t = text(html);
    expect(t).toMatch(/Your new hero/);
    expect(t).toMatch(/Rare Warrior/);
    expect(html).toMatch(/data-pwr="162"/);
    expect(html).toContain('data-verdict="WEAKER"');
    expect(html).toMatch(/data-direction="down"/);
    expect(t).toMatch(/−23/);
    expect(t).toMatch(/Weaker/);
    expect(t).toMatch(/Your new hero is 23 PWR weaker\./);
    expect(t).not.toMatch(/upgrade|congratulations|stronger/i);
    expect(html).toMatch(/data-testid="reroll-row-pwr"[\s\S]*?data-side="old"[^>]*>[\s\S]*?185[\s\S]*?data-side="new"[^>]*>[\s\S]*?162/);
    expect(html).toMatch(/data-testid="reroll-row-rarity"[\s\S]*?data-rarity="EPIC"[\s\S]*?data-rarity="RARE"/);
    expect(html).toMatch(/data-testid="reroll-row-class"[\s\S]*?Ranger[\s\S]*?Warrior/);
    expect(t).toMatch(/View my hero/);
  });

  it("a STRONGER hero says stronger; the same PWR says exactly that — a reroll is never presented as an upgrade unless it was one", () => {
    const up = render(card({ rarity: "COMMON", power: 140 }), card({ rarity: "LEGENDARY", power: 195 }));
    expect(up).toContain('data-verdict="STRONGER"');
    expect(text(up)).toMatch(/Your new hero is 55 PWR stronger\./);
    expect(up).toMatch(/data-direction="up"/);
    const same = render(card({ power: 180 }), card({ power: 180, classId: "mage", className: "Mage" }));
    expect(same).toContain('data-verdict="SAME_POWER"');
    expect(text(same)).toMatch(/Your new hero has exactly the same PWR\./);
  });

  it("says the old hero stays in history and that today's reroll is used — nothing about lost rewards", () => {
    const t = text(render(card(), card({ power: 150, rarity: "RARE" })));
    expect(t).toMatch(/Your old hero stays in your history\. Today's free reroll is used\./);
    expect(t).not.toMatch(/\b(lose|lost|erased|wiped)\b/i);
  });

  it("shows only the NEW hero's identity as current: the old name/PWR appear only in the labelled 'Old' column", () => {
    const html = render(card({ power: 185 }), card({ power: 120, rarity: "COMMON" }));
    expect(html.match(/data-pwr="185"/g) ?? []).toHaveLength(0); // the big PWR is the new one (the old figure is plain text in the Old column)
    expect(html).toMatch(/data-pwr="120"/);
  });
});

describe("the flow: one submission, nothing assumed after a lost answer", () => {
  const run = (actions: RerollAction[], from: RerollFlow = initialRerollFlow): RerollFlow => actions.reduce(rerollFlowReducer, from);
  const KEY = "22222222-2222-4222-8222-222222222222";
  const opened = run([{ type: "OPEN", requestId: KEY }]);
  const ready = run([{ type: "TOGGLE_ACK" }], opened);
  const res = result(card(), card({ rarity: "RARE", power: 162 }));

  it("REROLL HERO only OPENS the confirmation — it never rerolls; Cancel makes no change", () => {
    expect(opened).toEqual({ step: "confirm", requestId: KEY, acknowledged: false, error: null });
    expect(run([{ type: "CANCEL" }], opened)).toEqual(initialRerollFlow);
    expect(run([{ type: "CANCEL" }], ready)).toEqual(initialRerollFlow); // Escape / backdrop / Cancel
    expect(run([{ type: "OPEN", requestId: "other" }], opened)).toBe(opened); // already open: ignored
  });

  it("CONFIRM does nothing until the acknowledgement is ticked; unticking disables it again", () => {
    expect(run([{ type: "SUBMIT" }], opened)).toBe(opened);
    expect(run([{ type: "SUBMIT" }], ready)).toEqual({ step: "submitting", requestId: KEY });
    expect(run([{ type: "TOGGLE_ACK" }], ready)).toMatchObject({ acknowledged: false });
  });

  it("double click / Enter held: once submitting, every further SUBMIT, Cancel and Escape is ignored", () => {
    const submitting = run([{ type: "SUBMIT" }], ready);
    for (const a of [{ type: "SUBMIT" }, { type: "CANCEL" }, { type: "TOGGLE_ACK" }, { type: "OPEN", requestId: "x" }] as RerollAction[]) expect(run([a], submitting)).toBe(submitting);
    expect(run([{ type: "SUBMIT" }, { type: "SUBMIT" }, { type: "SUBMIT" }], ready)).toEqual({ step: "submitting", requestId: KEY });
  });

  it("only a server-confirmed result becomes a result — and the same pair is shown whether it came by the answer or by checking the server afterwards", () => {
    const submitting = run([{ type: "SUBMIT" }], ready);
    expect(run([{ type: "SUCCEEDED", result: res }], submitting)).toEqual({ step: "result", result: res });
    expect(run([{ type: "SUCCEEDED", result: res }], opened)).toBe(opened); // a result nobody asked for is ignored
    expect(run([{ type: "DISMISS_RESULT" }], { step: "result", result: res })).toEqual(initialRerollFlow);
    expect(run([{ type: "CANCEL" }], { step: "result", result: res })).toEqual({ step: "result", result: res }); // Escape does not skip the result
  });

  it("a definite refusal returns to the confirmation with the reason, the acknowledgement cleared (each attempt is a fresh decision)", () => {
    const refused = run([{ type: "REFUSED", error: { code: "INVALID_ROLL", message: "x", retryable: true } }], run([{ type: "SUBMIT" }], ready));
    expect(refused).toMatchObject({ step: "confirm", requestId: KEY, acknowledged: false, error: { code: "INVALID_ROLL", retryable: true } });
    expect(run([{ type: "SUBMIT" }], refused)).toBe(refused); // not acknowledged again yet
    expect(run([{ type: "TOGGLE_ACK" }, { type: "SUBMIT" }], refused)).toEqual({ step: "submitting", requestId: KEY }); // a retryable refusal may be retried (same key)
    const used = run([{ type: "REFUSED", error: { code: "ALREADY_USED_TODAY", message: "x", retryable: false } }, { type: "TOGGLE_ACK" }, { type: "SUBMIT" }], run([{ type: "SUBMIT" }], ready));
    expect(used.step).toBe("confirm"); // …but "already used" can never be submitted again
  });

  it("a LOST ANSWER (network, timeout, database blip) does not offer another attempt: the flow asks the server what really happened", () => {
    const checking = run([{ type: "UNCERTAIN" }], run([{ type: "SUBMIT" }], ready));
    expect(checking).toEqual({ step: "checking", requestId: KEY, failedCheck: false });
    for (const a of [{ type: "SUBMIT" }, { type: "CANCEL" }, { type: "TOGGLE_ACK" }] as RerollAction[]) expect(run([a], checking)).toBe(checking);
    expect(run([{ type: "CHECK_FAILED" }], checking)).toEqual({ step: "checking", requestId: KEY, failedCheck: true });
    const st = (s: Partial<FreeRerollStatusDto>) => ({ type: "CHECKED", status: status(s) }) as RerollAction;
    // the server says THIS request went through → its result
    const mine = { ...res, requestId: KEY };
    expect(run([st({ state: "USED", today: mine })], checking)).toEqual({ step: "result", result: mine });
    // used by another request (another tab) → spent, no retry
    const other = run([st({ state: "USED", today: { ...res, requestId: "other" } })], checking);
    expect(other).toMatchObject({ step: "confirm", error: { code: "ALREADY_USED_TODAY", retryable: false } });
    // not used → it did not commit: nothing was consumed, the same key may be sent again
    const didnt = run([st({ state: "AVAILABLE" })], checking);
    expect(didnt).toMatchObject({ step: "confirm", requestId: KEY, acknowledged: false, error: { code: "NOT_COMPLETED", retryable: true } });
    // blocked / disabled → says so
    expect(run([st({ state: "DISABLED", message: "Free rerolls aren't available right now." })], checking)).toMatchObject({ step: "confirm", error: { retryable: false } });
  });

  it("classifies answers: network / timeout / 5xx are uncertain; a clear 4xx refusal is not; INVALID_ROLL and RATE_LIMITED are the only retryable ones", () => {
    expect(isUncertain("NETWORK", 0)).toBe(true);
    expect(isUncertain("TIMEOUT", 0)).toBe(true);
    expect(isUncertain("DB_UNAVAILABLE", 503)).toBe(true);
    expect(isUncertain("SOMETHING", 500)).toBe(true);
    expect(isUncertain("INVALID_ROLL", 500)).toBe(false); // the server says plainly nothing was used
    for (const code of ["ALREADY_USED_TODAY", "HERO_IN_ARENA", "NOT_CLAIMED", "FREE_REROLL_DISABLED", "UNAUTHENTICATED", "BAD_ORIGIN", "REQUEST_CONFLICT"]) expect(isUncertain(code, code === "UNAUTHENTICATED" ? 401 : 409), code).toBe(false);
    expect(isRetryable("INVALID_ROLL")).toBe(true);
    expect(isRetryable("RATE_LIMITED")).toBe(true);
    for (const code of ["ALREADY_USED_TODAY", "HERO_IN_ARENA", "NOT_CLAIMED"]) expect(isRetryable(code)).toBe(false);
  });
});

describe("the page re-reads the hero when it changed anywhere", () => {
  it("heroStateKey differs when class, rarity, PWR or name differ, and is stable otherwise (so a reroll in another tab is noticed)", () => {
    const a = card();
    expect(heroStateKey(a)).toBe(heroStateKey({ ...a }));
    for (const change of [{ classId: "mage" }, { rarity: "RARE" as const }, { power: 186 }, { name: "OTHER" }]) expect(heroStateKey({ ...a, ...change })).not.toBe(heroStateKey(a));
    expect(heroStateKey(null)).toBeNull();
    expect(heroStateKey(undefined)).toBeNull();
  });

  it("the panel notifies the page from ONE place — the change of the hero's state key between two status reads — and says 'Checking with the server' for as long as it waits after a countdown", () => {
    const src = readFileSync(path.join(process.cwd(), "src/components/character/FreeReroll.tsx"), "utf8");
    expect((src.match(/onRerolled\?\.\(\)/g) ?? []).length).toBe(1);
    expect(src).toContain("knownHero.current !== null && knownHero.current !== currentKey");
    expect(src).toContain("checking={waitingForReset}");
  });
});

describe("accessibility of the dialog (structure; the behaviour is exercised in a real browser)", () => {
  const src = readFileSync(path.join(process.cwd(), "src/components/character/FreeReroll.tsx"), "utf8");

  it("is a native modal <dialog> labelled by its title, opened with showModal (focus trap, inert page), scrolling inside the viewport on short screens", () => {
    expect(src).toContain("<dialog");
    expect(src).toContain("showModal()");
    expect(src).toContain("aria-labelledby={labelledBy}");
    expect(src).toMatch(/max-h-\[calc\(100dvh-1rem\)\][^"]*overflow-y-auto/);
  });

  it("Escape is routed through the reducer (ignored while a request is in flight): the native cancel is prevented, not left to close the dialog", () => {
    expect(src).toMatch(/onCancel=\{\(e\) => \{\s*e\.preventDefault\(\)/);
    expect(src).toContain('type: "CANCEL"');
  });

  it("the safe choice has focus when the confirmation opens (Cancel, via data-autofocus after showModal), the result's primary action has it on success, Tab wraps inside the dialog, and focus returns to the panel heading", () => {
    expect(src).toMatch(/data-autofocus data-testid="reroll-cancel"/);
    expect(src).toMatch(/data-autofocus data-testid="reroll-view-hero"/);
    expect(src).toMatch(/data-autofocus data-testid="reroll-check-again"/);
    expect(src).toContain('querySelector<HTMLElement>("[data-autofocus]")?.focus()');
    expect(src).toMatch(/e\.key !== "Tab"/);
    expect(src).toContain('querySelector<HTMLElement>("h2")?.focus()');
  });

  it("a double submission is also blocked outside React state (a ref guard), the idempotency key is a fresh UUID per confirmation, and the body carries nothing but that key", () => {
    expect(src).toContain("inFlight.current");
    expect(src).toContain("crypto.randomUUID()");
    expect(src).toMatch(/json: \{ requestId \}/);
    expect(src).not.toMatch(/json: \{[^}]*(characterId|classId|rarity|seed|power)/);
  });

  it("asks the server again when a countdown ends, a tab returns, a page is restored (Back) or the connection comes back", () => {
    expect(src).toContain("useResumeRefetch(reload)");
    const resume = readFileSync(path.join(process.cwd(), "src/components/time/useResumeRefetch.ts"), "utf8");
    expect(resume).toContain("visibilitychange");
    expect(resume).toContain("pageshow");
    expect(resume).toContain("persisted");
    expect(resume).toContain('"online"');
  });
});
