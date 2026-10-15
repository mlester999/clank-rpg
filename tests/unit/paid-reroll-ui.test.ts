import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PaidConfirmView, PaidProgressView, PaidRerollCard } from "@/components/character/PaidReroll";
import { RerollResultView } from "@/components/character/FreeReroll";
import type { PaidFlow } from "@/components/character/paidRerollFlow";
import type { HeroCardModel } from "@/domain/hero/card";
import { compareRerolled, type FreeRerollResultDto } from "@/domain/hero/freeReroll";
import type { PaidRerollStatusDto } from "@/domain/hero/paidReroll";

/**
 * THE PAID REROLL UI: every state of the panel is truthful (never a clickable button that is not really available), the confirmation says what is paid, to whom and that it
 * cannot be undone, and once the payment is sent the screen only ever says "your payment is safe" — never offers another one.
 */
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<\/?(b|strong|em|i)(\s[^>]*)?>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const card = (over: Partial<HeroCardModel> = {}): HeroCardModel => ({
  publicId: "k7m2q9x4tb3d", name: "MARKYYESTER", classId: "ranger", className: "Ranger", rarity: "EPIC", power: 185, stats: { hp: 120, str: 8, def: 7, int: 22, agi: 10, cha: 9, luck: 11 }, seasonRank: null,
  look: {
    rarity: "EPIC", parts: { skin: 0, hairStyle: 0, hairColor: 0, eyes: 0, mouth: 0, accessory: 0, cape: false, aura: "none", outfitHue: 0 },
    sprite: { v: 1, catalog: 1, skin: 0, hairColor: 0, hue: 0, slots: { outfit: "outfit.light", weapon: "weapon.bow" } }, colors: ["#111111", "#222222", "#333333"], weapon: "bow", headgear: "hat", body: "medium",
  },
  ...over,
});

const status = (over: Partial<PaidRerollStatusDto> = {}): PaidRerollStatusDto => ({
  state: "AVAILABLE", serverNow: NOW, message: null, block: null, price: { whole: "100000", label: "100,000", symbol: "$CLANKRPG" }, usedToday: 0, maxPerDay: 10,
  wallet: { linked: true, address: "0x52908400098527886e0f7030069857d2e4169ee7", addresses: ["0x52908400098527886e0f7030069857d2e4169ee7"] }, credit: null,
  payment: { chainId: 4663, chainIdHex: "0x1237", chainName: "Robinhood Chain", rpcUrl: null, to: "0x00000000000000000000000000000000000c1a4c", data: "0xa9059cbb", recipient: "0xde709f2102306220921060314715629080e2fb77", amountRaw: "1" },
  explorerTxUrl: "https://explorer.example/tx/{hash}", current: card(), ...over,
});
const renderCard = (s: PaidRerollStatusDto | null, over: { failed?: boolean; loading?: boolean } = {}) => renderToStaticMarkup(createElement(PaidRerollCard, { status: s, ...over }));

describe("the panel: every state tells the truth", () => {
  it("AVAILABLE: the price, today's use, an ENABLED button, and a promise that the wallet opens and the member confirms first", () => {
    const html = renderCard(status({ usedToday: 2 }));
    const t = text(html);
    expect(t).toMatch(/Reroll again/);
    expect(t).toMatch(/Pay 100,000 \$CLANKRPG for another roll/);
    expect(t).toMatch(/2\/10 today/);
    expect(html).toMatch(/<button[^>]*data-testid="paid-reroll-open"[^>]*>/);
    expect(html).not.toMatch(/data-testid="paid-reroll-open"[^>]*disabled/);
    expect(t).toMatch(/Pay 100,000 \$CLANKRPG & reroll/);
    expect(t).toMatch(/Your wallet opens to approve the payment/);
    expect(t).toMatch(/You'll confirm first\. Your new hero could be weaker\./);
    expect(t).not.toMatch(/link it to your hero first/); // the wallet is already linked
    expect(html).toContain('data-state="AVAILABLE"');
  });

  it("AVAILABLE with no linked wallet says the wallet is linked first — free, no gas", () => {
    const t = text(renderCard(status({ wallet: { linked: false, address: null, addresses: [] } })));
    expect(t).toMatch(/link it to your hero first — free, no gas/);
  });

  it("FREE_FIRST: the free reroll comes first — a DISABLED button, never a payment that is not needed", () => {
    const html = renderCard(status({ state: "FREE_FIRST", message: "Your free reroll is still available today — use it first." }));
    expect(text(html)).toMatch(/use it first/);
    expect(html).toMatch(/data-testid="paid-reroll-open-disabled"[^>]*disabled|disabled=""[^>]*data-testid="paid-reroll-open-disabled"/);
    expect(html).not.toContain('data-testid="paid-reroll-open"');
  });

  it("CREDIT_WAITING: a confirmed payment is offered back ('Use my paid reroll'), and is disabled with the honest sentence while the hero is in a live fight", () => {
    const ready = renderCard(status({ state: "CREDIT_WAITING", message: "Your payment is confirmed — your reroll is ready.", credit: { txHash: `0x${"ab".repeat(32)}`, paidAt: NOW } }));
    expect(text(ready)).toMatch(/Payment confirmed/);
    expect(text(ready)).toMatch(/Use my paid reroll/);
    expect(ready).not.toMatch(/data-testid="paid-reroll-use-credit"[^>]*disabled/);
    const locked = renderCard(status({ state: "CREDIT_WAITING", block: "HERO_IN_ARENA", message: "Your payment is confirmed and safe. Your hero is lined up for a live Arena fight — your reroll will be ready once the upcoming fights have finished.", credit: { txHash: `0x${"ab".repeat(32)}`, paidAt: NOW } }));
    expect(text(locked)).toMatch(/confirmed and safe/);
    expect(locked).toMatch(/data-testid="paid-reroll-use-credit"[^>]*disabled|disabled=""[^>]*data-testid="paid-reroll-use-credit"/);
  });

  it("LIMIT_REACHED and BLOCKED show the reason and no payment button; DISABLED and UNAVAILABLE say so plainly", () => {
    for (const s of [status({ state: "LIMIT_REACHED", message: "You've used all of today's paid rerolls. They reset at 00:00 UTC." }), status({ state: "BLOCKED", block: "NOT_CLAIMED", message: "Claim your hero to reroll it." })]) {
      const html = renderCard(s);
      expect(html).toContain('data-testid="paid-reroll-blocked"');
      expect(html).not.toContain('data-testid="paid-reroll-open"');
    }
    expect(text(renderCard(status({ state: "DISABLED", price: null, message: "Paid rerolls aren't open yet." })))).toMatch(/Paid rerolls aren't open yet\./);
    expect(text(renderCard(status({ state: "UNAVAILABLE", price: null, message: "Paid rerolls open when $CLANKRPG is live on this server." })))).toMatch(/open when \$CLANKRPG is live/);
    expect(renderCard(status({ state: "DISABLED", price: null }))).not.toContain('data-testid="paid-reroll-open"');
  });

  it("loading shows a skeleton; a failed read offers a retry", () => {
    expect(renderCard(null, { loading: true })).toContain('data-testid="paid-reroll-loading"');
    expect(renderCard(null, { failed: true })).toContain('data-testid="paid-reroll-error"');
  });
});

describe("the confirmation", () => {
  const props = (over: Record<string, unknown> = {}) => ({ status: status(), credit: false, acknowledged: false, submitting: false, error: null, titleId: "t", onToggle: () => undefined, onCancel: () => undefined, onConfirm: () => undefined, ...over });
  const render = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PaidConfirmView, props(over)));

  it("says what is paid, from where and to whom, that the wallet shows it, that the roll can be weaker and that nothing is refunded — and shows the current hero", () => {
    const html = render();
    const t = text(html);
    expect(t).toMatch(/Reroll your hero\?/);
    expect(t).toMatch(/Cost: 100,000 \$CLANKRPG, sent from your own wallet to the Clank RPG reward treasury, which funds the prize pools/);
    expect(t).toMatch(/Your wallet will open and show the payment — nothing moves unless you approve it there\. Clank RPG never holds your keys\./);
    expect(t).toMatch(/exactly as random as a free one/);
    expect(t).toMatch(/lower rarity.*lower PWR.*different class.*different appearance/);
    expect(t).toMatch(/cannot restore.*the payment is not refunded/);
    expect(t).toMatch(/MARKYYESTER/);
    expect(html).toContain('data-testid="paid-confirm-warning"');
  });

  it("the Pay button stays DISABLED until the acknowledgement is ticked; Cancel is focused first and enabled", () => {
    expect(render()).toMatch(/data-testid="paid-confirm-button"[^>]*disabled|disabled=""[^>]*data-testid="paid-confirm-button"/);
    expect(render({ acknowledged: true })).not.toMatch(/data-testid="paid-confirm-button"[^>]*disabled/);
    expect(render()).toMatch(/data-autofocus[^>]*data-testid="paid-confirm-cancel"|data-testid="paid-confirm-cancel"[^>]*data-autofocus/);
    expect(text(render({ acknowledged: true }))).toMatch(/Pay 100,000 \$CLANKRPG Opens your wallet/);
  });

  it("a refusal is shown in an alert; one that cannot be retried leaves only Close", () => {
    const retry = render({ error: { code: "REJECTED", message: "The wallet request was cancelled. Nothing was paid.", retryable: true } });
    expect(retry).toContain('data-testid="paid-confirm-error"');
    expect(retry).toContain('data-testid="paid-confirm-button"');
    const final = render({ error: { code: "NOT_CLAIMED", message: "Claim your hero to reroll it.", retryable: false } });
    expect(final).not.toContain('data-testid="paid-confirm-button"');
    expect(text(final)).toMatch(/Close/);
  });

  it("using a payment that is already confirmed asks for nothing more: no price block, 'Reroll now', no 'not refunded'", () => {
    const html = render({ credit: true, acknowledged: true });
    const t = text(html);
    expect(t).toMatch(/Use your paid reroll\?/);
    expect(t).toMatch(/Your payment is already confirmed — nothing more to pay\./);
    expect(t).toMatch(/Reroll now/);
    expect(html).not.toContain('data-testid="paid-confirm-price"');
    expect(t).not.toMatch(/not refunded/);
  });
});

describe("the wallet and verification screens", () => {
  const HASH = `0x${"ab".repeat(32)}`;
  const view = (flow: Extract<PaidFlow, { step: "wallet" | "verifying" }>) => renderToStaticMarkup(createElement(PaidProgressView, { flow, titleId: "t", explorerTxUrl: "https://explorer.example/tx/{hash}", onCheckAgain: () => undefined }));

  it("each wallet step says what the member is being asked, and that nothing has been paid yet", () => {
    const connect = text(view({ step: "wallet", requestId: "r", phase: "CONNECT" }));
    expect(connect).toMatch(/Waiting for your wallet…/);
    expect(connect).toMatch(/Connect your wallet/);
    expect(connect).toMatch(/Nothing has been paid yet/);
    expect(text(view({ step: "wallet", requestId: "r", phase: "LINK" }))).toMatch(/free and gives Clank RPG no access to your funds/);
    expect(text(view({ step: "wallet", requestId: "r", phase: "NETWORK" }))).toMatch(/Switch your wallet to the right network/);
    expect(text(view({ step: "wallet", requestId: "r", phase: "PAY" }))).toMatch(/Approve the payment in your wallet/);
  });

  it("verifying: the confirmation count, a link to the transaction, 'don't pay again', and no button while the server is being asked", () => {
    const busy = view({ step: "verifying", requestId: "r", txHash: HASH, confirmations: null, required: null, busy: true, problem: null });
    expect(text(busy)).toMatch(/Payment sent/);
    expect(text(busy)).toMatch(/Confirming it on-chain…/);
    expect(text(busy)).toMatch(/Don't pay again/);
    expect(busy).toContain(`href="https://explorer.example/tx/${HASH}"`);
    expect(busy).toContain('rel="noopener noreferrer"');
    expect(busy).not.toContain('data-testid="paid-check-again"');
    const waiting = view({ step: "verifying", requestId: "r", txHash: HASH, confirmations: 1, required: 2, busy: false, problem: null });
    expect(text(waiting)).toMatch(/1\/2 confirmations/);
    expect(waiting).toContain('data-testid="paid-check-again"');
    expect(text(view({ step: "verifying", requestId: "r", txHash: HASH, confirmations: 0, required: 0, busy: false, problem: null }))).not.toMatch(/0\/0/);
  });

  it("a problem after payment says the payment is SAFE — and offers 'check again', never another payment", () => {
    const html = view({ step: "verifying", requestId: "r", txHash: HASH, confirmations: null, required: null, busy: false, problem: { code: "CHECK_FAILED", message: "We couldn't reach the server to confirm your payment. It is safe — check again in a moment.", retryable: true } });
    expect(text(html)).toMatch(/Your payment is safe/);
    expect(text(html)).toMatch(/It is safe — check again/);
    expect(html).toContain('data-testid="paid-check-again"');
    expect(text(html)).not.toMatch(/Pay 100,000/);
  });
});

describe("the result", () => {
  it("reuses the free reroll's honest comparison, with the paid footnote", () => {
    const before = card();
    const after = card({ rarity: "RARE", power: 160 });
    const r: FreeRerollResultDto = { requestId: "11111111-1111-4111-8111-111111111111", alreadyApplied: false, rerolledAt: NOW, before, after, comparison: compareRerolled(before, after) };
    const html = renderToStaticMarkup(createElement(RerollResultView, { result: r, titleId: "t", onView: () => undefined, footnote: "Your old hero stays in your history. You paid 100,000 $CLANKRPG for this reroll." }));
    expect(text(html)).toMatch(/Weaker/);
    expect(text(html)).toMatch(/You paid 100,000 \$CLANKRPG for this reroll\./);
    expect(text(html)).not.toMatch(/free reroll is used/);
  });
});
