"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { RARITY_COLOR } from "@/components/hero/colors";
import { EmptyState, PageHeader, RarityChip, SkeletonBlock } from "@/components/ui/bits";
import type { ItemRarity } from "@/domain/content/items";
import { STAT_LABELS, type StatKey } from "@/domain/stats";
import { api, friendly } from "@/lib/api";
import type { InventoryItemView, ShopItemView } from "@/lib/dto";
import { useRemote } from "@/lib/useRemote";

interface InvResponse {
  claimed: boolean;
  items: InventoryItemView[];
  gold: number;
  /** What a spare item of each rarity sells for (null while the shop is closed). */
  shop: { enabled: boolean; sell: Record<ItemRarity, number> | null };
}

interface ShopResponse {
  shop: { enabled: boolean; claimed: boolean; gold: number; items: ShopItemView[] };
}

const SLOTS = ["WEAPON", "ARMOR", "TRINKET"] as const;
const SLOT_LABEL = { WEAPON: "Weapon", ARMOR: "Armor", TRINKET: "Trinket" };

const newKey = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "00000000-0000-4000-8000-000000000000".replace(/0/g, () => Math.floor(Math.random() * 16).toString(16)));

export function InventoryView() {
  const { data, error, loading, reload: load } = useRemote<InvResponse>(() => api<InvResponse>("/api/me/inventory"), "inventory");
  const state: "loading" | "anon" | "ready" | "error" = data ? "ready" : error ? (error.status === 401 ? "anon" : "error") : loading ? "loading" : "error";
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tab, setTab] = useState<"bag" | "shop">("bag");
  /** The item whose SELL is waiting for a second tap (selling is final). */
  const [confirmSell, setConfirmSell] = useState<string | null>(null);

  async function toggle(item: InventoryItemView) {
    setBusy(item.id);
    setNote(null);
    const r = await api("/api/me/equip", { method: "POST", json: { itemId: item.id, equip: !item.equipped } });
    setBusy(null);
    if (!r.ok) setNote(friendly(r.error));
    load();
  }

  async function sell(item: InventoryItemView) {
    if (confirmSell !== item.id) {
      setConfirmSell(item.id);
      window.setTimeout(() => setConfirmSell((c) => (c === item.id ? null : c)), 4000);
      return;
    }
    setConfirmSell(null);
    setBusy(item.id);
    setNote(null);
    const r = await api<{ price: number; gold: number }>("/api/me/shop/sell", { method: "POST", json: { itemId: item.id } });
    setBusy(null);
    setNote(r.ok ? `Sold ${item.name} for ${r.data.price.toLocaleString()} Gold.` : friendly(r.error));
    load();
  }

  if (state === "loading") return <Shell><SkeletonBlock className="h-32" /><SkeletonBlock className="mt-4 h-72" /></Shell>;
  if (state === "anon")
    return (
      <Shell>
        <EmptyState title="Sign in to see your inventory" body="Your hero's gear and Clank Gold live here. Sign in with Telegram to open it." action={<Link href="/character" className="btn btn-sm">Sign in with Telegram</Link>} />
      </Shell>
    );
  if (state === "error" || !data) return <Shell><EmptyState title="Couldn't load your inventory" body="Please try again in a moment." action={<button className="btn btn-sm" type="button" onClick={load}>Retry</button>} /></Shell>;

  const shopOpen = data.shop.enabled;
  const equipped = SLOTS.map((s) => data.items.find((i) => i.slot === s && i.equipped));
  const bag = data.items.filter((i) => !i.equipped);
  const sellPrice = (item: InventoryItemView): number | null => (data.shop.sell ? (data.shop.sell[item.rarity] ?? null) : null);

  return (
    <Shell gold={data.gold}>
      {!data.claimed && (
        <div className="plate plate-clank mb-4 p-4 text-sm">
          <b className="text-clank-300">Claim your hero to equip gear.</b>{" "}
          <span className="text-steel-300">Your hero keeps collecting loot while unclaimed, but only the owner can equip, buy or sell it. </span>
          <Link href="/character" className="text-clank-300 underline">Go to your hero</Link>
        </div>
      )}

      <GoldUses shopOpen={shopOpen} />

      <section aria-labelledby="eq" className="plate mt-4 p-5">
        <h2 id="eq" className="label">Equipped</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-3">
          {SLOTS.map((slot, i) => (
            <li key={slot}>
              {equipped[i] ? <ItemCard item={equipped[i]} busy={busy === equipped[i].id} onToggle={toggle} canEquip={data.claimed} /> : <div className="grid h-full min-h-[8.5rem] place-items-center rounded-lg border border-dashed border-white/10 p-3 text-center text-sm text-steel-400">{SLOT_LABEL[slot]}<br />empty</div>}
            </li>
          ))}
        </ul>
      </section>
      {note && <p role="status" className="mt-3 text-sm text-clank-300" data-testid="inventory-note">{note}</p>}

      <nav role="tablist" aria-label="Bag or shop" className="mt-4 flex gap-1 rounded-lg bg-ink-900 p-1" data-testid="inventory-tabs">
        {(["bag", ...(shopOpen ? (["shop"] as const) : [])] as Array<"bag" | "shop">).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`tab-${t}`}
            className={`flex-1 rounded-md px-3 py-2 font-display text-xs tracking-wider whitespace-nowrap uppercase ${tab === t ? "bg-clank-500 text-ink-900" : "text-steel-300 hover:text-paper"}`}>
            {t === "bag" ? `Bag · ${bag.length}` : "Gear Shop"}
          </button>
        ))}
      </nav>

      {tab === "shop" && shopOpen ? (
        <ShopPanel gold={data.gold} claimed={data.claimed} onChanged={load} onNote={setNote} />
      ) : (
        <section aria-labelledby="bag" className="plate mt-3 p-5">
          <h2 id="bag" className="label">Bag · {bag.length}</h2>
          {bag.length === 0 ? (
            <p className="mt-3 text-sm text-steel-300">
              Nothing here yet. Gear drops from Global Arena battles — the higher you place, the better your odds.
              {shopOpen ? <> Or <button type="button" className="text-clank-300 underline" onClick={() => setTab("shop")}>buy some in the Gear Shop</button> with your Clank Gold.</> : null} Coin-themed relics are coming with Bosses.
            </p>
          ) : (
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {bag.map((item) => (
                <li key={item.id}>
                  <ItemCard item={item} busy={busy === item.id} onToggle={toggle} canEquip={data.claimed} sell={data.claimed ? { price: sellPrice(item), confirming: confirmSell === item.id, onSell: () => void sell(item) } : undefined} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </Shell>
  );
}

function Shell({ children, gold }: { children: React.ReactNode; gold?: number }) {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-3 py-6 sm:px-6">
      <PageHeader
        title="Your"
        accent="Inventory"
        subtitle="Gear modifies your stats. Rarer gear gives a little more, and each slot holds one item."
        right={gold !== undefined ? <span className="plate plate-flat flex items-center gap-2 px-4 py-2" style={{ ["--chamfer" as string]: "8px" }}><span className="label">Clank Gold</span><span className="font-display text-xl text-gold tnum" data-testid="gold">{gold.toLocaleString()}</span></span> : undefined}
      />
      {children}
    </div>
  );
}

/** What Clank Gold is for — said plainly, on the screen that shows it. */
export function GoldUses({ shopOpen }: { shopOpen: boolean }) {
  return (
    <details className="plate plate-flat group p-4" data-testid="gold-uses" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
        <span className="font-display text-sm tracking-[0.12em] text-gold uppercase">What is Clank Gold for?</span>
        <span className="text-xs text-steel-400 group-open:hidden">Show</span>
        <span className="hidden text-xs text-steel-400 group-open:inline">Hide</span>
      </summary>
      <div className="mt-3 grid gap-3 text-sm text-steel-300 sm:grid-cols-2">
        <div>
          <p className="label !text-[0.62rem]">Earn it</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 marker:text-steel-500">
            <li>Every Arena fight pays Gold — more for placing high and for each elimination.</li>
            <li>A correct Arena Pick pays a little Gold.</li>
            <li>Every <b className="text-paper">achievement</b> pays a one-off Gold reward and unlocks a title.</li>
            <li>Selling spare gear.</li>
          </ul>
        </div>
        <div>
          <p className="label !text-[0.62rem]">Spend it</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 marker:text-steel-500">
            {shopOpen ? <li><b className="text-paper">Gear Shop</b> — buy weapons, armor and trinkets for your class. Legendary gear is earned in the Arena, never sold.</li> : <li>The Gear Shop is closed right now.</li>}
            <li>Coming with Bosses and Expeditions: relics, entry costs and upgrades.</li>
          </ul>
          <p className="mt-2 text-xs text-steel-400">Gold is a game currency, not a token: it can&apos;t be traded or withdrawn, and it never changes your hero&apos;s POWER.</p>
        </div>
      </div>
    </details>
  );
}

function ShopPanel({ gold, claimed, onChanged, onNote }: { gold: number; claimed: boolean; onChanged: () => void; onNote: (note: string | null) => void }) {
  const { data, loading, reload } = useRemote<ShopResponse>(() => api<ShopResponse>("/api/me/shop"), "shop");
  const [busy, setBusy] = useState<string | null>(null);
  // One idempotency key per item until the purchase gets a definite answer: a lost reply can be retried without paying twice.
  const keys = useRef(new Map<string, string>());

  async function buy(item: ShopItemView) {
    setBusy(item.templateId);
    onNote(null);
    const requestId = keys.current.get(item.templateId) ?? newKey();
    keys.current.set(item.templateId, requestId);
    const r = await api<{ price: number; gold: number }>("/api/me/shop/buy", { method: "POST", json: { templateId: item.templateId, requestId } });
    setBusy(null);
    if (r.ok) {
      keys.current.delete(item.templateId);
      onNote(`Bought ${item.name} for ${r.data.price.toLocaleString()} Gold. It's in your bag.`);
    } else {
      if (!["NETWORK", "TIMEOUT", "DB_UNAVAILABLE"].includes(r.error)) keys.current.delete(item.templateId);
      onNote(r.error === "INSUFFICIENT_GOLD" ? "You don't have enough Clank Gold for that yet." : friendly(r.error));
    }
    reload();
    onChanged();
  }

  if (loading && !data) return <SkeletonBlock className="mt-3 h-56" />;
  if (!data) return <div className="plate mt-3 p-5"><EmptyState title="The shop is unavailable" body="Please try again in a moment." action={<button className="btn btn-sm" type="button" onClick={reload}>Retry</button>} /></div>;
  const { items } = data.shop;
  return (
    <section aria-labelledby="shop" className="plate mt-3 p-5" data-testid="shop">
      <h2 id="shop" className="label">Gear Shop</h2>
      <p className="mt-1 text-xs text-steel-300">Gear for your class. Bought gear works exactly like dropped gear: the same small bonus, and it never changes your hero&apos;s POWER.</p>
      {!claimed && <p className="mt-2 text-sm text-steel-300">Claim your hero to buy gear.</p>}
      {SLOTS.map((slot) => {
        const list = items.filter((i) => i.slot === slot);
        if (list.length === 0) return null;
        return (
          <div key={slot} className="mt-4">
            <h3 className="font-display text-xs tracking-[0.14em] text-steel-200 uppercase">{SLOT_LABEL[slot]}s</h3>
            <ul className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((item) => {
                const color = RARITY_COLOR[item.rarity] ?? "#9aa4b2";
                const mods = Object.entries(item.statMods).filter(([, v]) => v);
                const missing = item.price - gold;
                return (
                  <li key={item.templateId}>
                    <article className="flex h-full flex-col rounded-lg border bg-ink-900/70 p-3" style={{ borderColor: `${color}88` }} data-testid="shop-item" data-template={item.templateId}>
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="text-sm font-bold" style={{ color }}>{item.name}</h4>
                        <RarityChip rarity={item.rarity} />
                      </div>
                      <p className="label mt-0.5 !text-[0.6rem]">{SLOT_LABEL[item.slot]}{item.classRestriction ? ` · ${item.classRestriction.join(" / ")}` : ""}{item.owned > 0 ? ` · you have ${item.owned}` : ""}</p>
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {mods.map(([k, v]) => <li key={k} className="chip !text-ok">+{v} {STAT_LABELS[k as StatKey] ?? k}</li>)}
                      </ul>
                      <div className="mt-auto pt-3">
                        <button type="button" className="btn btn-sm w-full" disabled={!claimed || missing > 0 || busy !== null} onClick={() => void buy(item)} data-testid="shop-buy">
                          {busy === item.templateId ? "…" : <>Buy · <span className="tnum">{item.price.toLocaleString()}</span> Gold</>}
                        </button>
                        {claimed && missing > 0 && <p className="mt-1.5 text-center text-[0.68rem] text-steel-400">Need {missing.toLocaleString()} more Gold</p>}
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function ItemCard({ item, onToggle, busy, canEquip, sell }: { item: InventoryItemView; onToggle: (i: InventoryItemView) => void; busy: boolean; canEquip: boolean; sell?: { price: number | null; confirming: boolean; onSell: () => void } | undefined }) {
  const color = RARITY_COLOR[item.rarity] ?? "#9aa4b2";
  const mods = Object.entries(item.statMods).filter(([, v]) => v);
  const reason = !canEquip ? "Claim your hero to equip" : !item.usable && !item.equipped ? `For ${item.classRestriction ? item.classRestriction.join(" / ") : "another class"} only` : null;
  return (
    <article className="flex h-full flex-col rounded-lg border bg-ink-900/70 p-3" style={{ borderColor: `${color}88`, boxShadow: item.equipped ? `0 0 0 1px ${color}55, 0 0 22px ${color}22` : undefined }}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-bold" style={{ color }}>{item.name}</h3>
        <RarityChip rarity={item.rarity} />
      </div>
      <p className="label mt-0.5 !text-[0.6rem]">{SLOT_LABEL[item.slot]}{item.classRestriction ? ` · ${item.classRestriction.join(" / ")}` : ""}</p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {mods.map(([k, v]) => (
          <li key={k} className="chip !text-ok">+{v} {STAT_LABELS[k as StatKey] ?? k}</li>
        ))}
      </ul>
      <div className="mt-auto pt-3">
        <button type="button" className={`btn btn-sm w-full ${item.equipped ? "btn-ghost" : ""}`} disabled={busy || (!item.equipped && (!item.usable || !canEquip))} onClick={() => onToggle(item)}>
          {busy ? "…" : item.equipped ? "Unequip" : "Equip"}
        </button>
        {reason && <p className="mt-1.5 text-center text-[0.68rem] text-steel-400">{reason}</p>}
        {sell && sell.price !== null && (
          <button type="button" className={`btn btn-sm btn-ghost mt-1.5 w-full ${sell.confirming ? "!border-gold !text-gold" : ""}`} disabled={busy} onClick={sell.onSell} data-testid="sell" aria-label={`${sell.confirming ? "Confirm selling" : "Sell"} ${item.name} for ${sell.price.toLocaleString()} Gold`}>
            {sell.confirming ? <>Tap again to sell · +<span className="tnum">{sell.price.toLocaleString()}</span></> : <>Sell · +<span className="tnum">{sell.price.toLocaleString()}</span> Gold</>}
          </button>
        )}
      </div>
    </article>
  );
}
