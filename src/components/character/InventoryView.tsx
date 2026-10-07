"use client";

import Link from "next/link";
import { useState } from "react";

import { RARITY_COLOR } from "@/components/hero/colors";
import { EmptyState, PageHeader, RarityChip, SkeletonBlock } from "@/components/ui/bits";
import { STAT_LABELS, type StatKey } from "@/domain/stats";
import { api, friendly } from "@/lib/api";
import type { InventoryItemView } from "@/lib/dto";
import { useRemote } from "@/lib/useRemote";

interface InvResponse {
  claimed: boolean;
  items: InventoryItemView[];
  gold: number;
}

const SLOTS = ["WEAPON", "ARMOR", "TRINKET"] as const;
const SLOT_LABEL = { WEAPON: "Weapon", ARMOR: "Armor", TRINKET: "Trinket" };

export function InventoryView() {
  const { data, error, loading, reload: load } = useRemote<InvResponse>(() => api<InvResponse>("/api/me/inventory"), "inventory");
  const state: "loading" | "anon" | "ready" | "error" = data ? "ready" : error ? (error.status === 401 ? "anon" : "error") : loading ? "loading" : "error";
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function toggle(item: InventoryItemView) {
    setBusy(item.id);
    setNote(null);
    const r = await api("/api/me/equip", { method: "POST", json: { itemId: item.id, equip: !item.equipped } });
    setBusy(null);
    if (!r.ok) setNote(friendly(r.error));
    load();
  }

  if (state === "loading") return <Shell><SkeletonBlock className="h-32" /><SkeletonBlock className="mt-4 h-72" /></Shell>;
  if (state === "anon")
    return (
      <Shell>
        <EmptyState title="Sign in to see your inventory" body="Your hero's gear and Clank Gold live here. Sign in with Telegram to open it." action={<Link href="/character" className="btn btn-sm">Sign in</Link>} />
      </Shell>
    );
  if (state === "error" || !data) return <Shell><EmptyState title="Couldn't load your inventory" body="Please try again in a moment." action={<button className="btn btn-sm" type="button" onClick={load}>Retry</button>} /></Shell>;

  const equipped = SLOTS.map((s) => data.items.find((i) => i.slot === s && i.equipped));
  const bag = data.items.filter((i) => !i.equipped);

  return (
    <Shell gold={data.gold}>
      {!data.claimed && (
        <div className="plate plate-clank mb-4 p-4 text-sm">
          <b className="text-clank-300">Claim your hero to equip gear.</b>{" "}
          <span className="text-steel-300">Your hero keeps collecting loot while unclaimed, but only the owner can equip it. </span>
          <Link href="/character" className="text-clank-300 underline">Go to your hero</Link>
        </div>
      )}
      <section aria-labelledby="eq" className="plate p-5">
        <h2 id="eq" className="label">Equipped</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-3">
          {SLOTS.map((slot, i) => (
            <li key={slot}>
              {equipped[i] ? <ItemCard item={equipped[i]} busy={busy === equipped[i].id} onToggle={toggle} canEquip={data.claimed} /> : <div className="grid h-full min-h-[8.5rem] place-items-center rounded-lg border border-dashed border-white/10 p-3 text-center text-sm text-steel-400">{SLOT_LABEL[slot]}<br />empty</div>}
            </li>
          ))}
        </ul>
      </section>
      {note && <p role="status" className="mt-3 text-sm text-danger">{note}</p>}
      <section aria-labelledby="bag" className="plate mt-4 p-5">
        <h2 id="bag" className="label">Bag · {bag.length}</h2>
        {bag.length === 0 ? (
          <p className="mt-3 text-sm text-steel-300">Nothing here yet. Gear drops from Global Arena battles — the higher you place, the better your odds. Coin-themed relics are coming with Bosses.</p>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bag.map((item) => (
              <li key={item.id}><ItemCard item={item} busy={busy === item.id} onToggle={toggle} canEquip={data.claimed} /></li>
            ))}
          </ul>
        )}
      </section>
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
        right={gold !== undefined ? <span className="plate plate-flat flex items-center gap-2 px-4 py-2" style={{ ["--chamfer" as string]: "8px" }}><span className="label">Clank Gold</span><span className="font-display text-xl text-gold tnum">{gold.toLocaleString()}</span></span> : undefined}
      />
      {children}
    </div>
  );
}

function ItemCard({ item, onToggle, busy, canEquip }: { item: InventoryItemView; onToggle: (i: InventoryItemView) => void; busy: boolean; canEquip: boolean }) {
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
      </div>
    </article>
  );
}
