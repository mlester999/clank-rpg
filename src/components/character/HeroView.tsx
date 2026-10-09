"use client";

import Link from "next/link";
import { formatWinRate } from "@/domain/progression/seasonRecord";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { RARITY_COLOR } from "@/components/hero/colors"; // gear item rarities (they include UNCOMMON) — hero rarity uses the shared RARITY_VISUALS
import { lookFor } from "@/components/hero/look";
import type { Rarity } from "@/domain/character/appearance";
import { heroOwnership, type SelfHeroStatus } from "@/domain/heroOwnership";
import { EmptyState, SkeletonBlock } from "@/components/ui/bits";
import { CheckIcon, LockIcon } from "@/components/ui/Icons";
import { lighten } from "@/domain/util/color";
import { STAT_KEYS, STAT_LABELS, type StatKey } from "@/domain/stats";
import { api, friendly } from "@/lib/api";
import type { CharacterDto, ClassVisual, InventoryItemView } from "@/lib/dto";
import { useRemote } from "@/lib/useRemote";

import { FreeRerollPanel } from "./FreeReroll";
import { HeroIdentityPanel, HeroStandingPanel } from "./HeroIdentity";
import { ArenaPicksPanel } from "@/components/rewards/ArenaPicksPanel";
import { WalletPanel } from "./WalletPanel";

interface HeroResponse {
  hero: CharacterDto;
  isOwner: boolean;
  owner: { tactic: "AGGRESSIVE" | "BALANCED" | "DEFENSIVE"; gold: number; inventory: InventoryItemView[]; wallet: string | null } | null;
  classVisual: ClassVisual | null;
  /** Only present when the signed-in member is looking at their OWN hero: facts the public hero data never carries. */
  self?: { heroStatus: SelfHeroStatus } | null;
}

interface Viewer {
  characterId: string | null;
  claimed: boolean;
  threshold?: number;
}

const TACTICS = [
  { id: "AGGRESSIVE", name: "Aggressive", body: "Hunts wounded targets and fights to the last drop of HP." },
  { id: "BALANCED", name: "Balanced", body: "The class default: sensible targeting, retreats only when it must." },
  { id: "DEFENSIVE", name: "Defensive", body: "Plays it safe: uses defensive abilities earlier and backs off sooner." },
] as const;

const STAT_CAP: Record<StatKey, number> = { hp: 440, str: 70, def: 70, int: 70, agi: 70, cha: 70, luck: 70 };
const COMPONENT_COLORS = { class: "#8b97ab", gear: "#f5b94a", community: "#2ee6c8", wallet: "#b366ff" };

interface HeroBundle {
  hero: HeroResponse;
  viewer: Viewer | null;
}

async function loadHero(id: string) {
  const [h, me] = await Promise.all([api<HeroResponse>(`/api/heroes/${id}`), api<{ viewer: Viewer | null }>("/api/me")]);
  if (!h.ok) return h;
  return { ok: true as const, data: { hero: h.data, viewer: me.ok ? me.data.viewer : null } };
}

export function HeroView({ id }: { id: string }) {
  const router = useRouter();
  const { data: bundle, error, loading, reload } = useRemote<HeroBundle>(() => loadHero(id), id);
  const data = bundle?.hero ?? null;
  const viewer = bundle?.viewer ?? null;
  const state: "loading" | "missing" | "error" | "ok" = bundle ? "ok" : error ? (error.status === 404 ? "missing" : "error") : loading ? "loading" : "error";
  const load = async () => reload();
  const [tab, setTab] = useState<"overview" | "picks" | "tactics" | "wallet">("overview");
  const [claimNote, setClaimNote] = useState<string | null>(null);
  const [tacticNote, setTacticNote] = useState<string | null>(null);
  // After a reroll the hero is re-read from the server. Until that read lands the old class / rarity / PWR must not look current: dim them (the reroll panel itself stays).
  const [staleBundle, setStaleBundle] = useState<HeroBundle | null>(null);
  const staleAfterReroll = staleBundle !== null && bundle === staleBundle && loading;

  if (state === "loading") return <HeroSkeleton />;
  if (state === "missing") return <EmptyState title="Hero not found" body="This hero doesn't exist (or hasn't been created yet)." action={<Link href="/leaderboard" className="btn btn-sm">See the leaderboard</Link>} />;
  if (state === "error" || !data) return <EmptyState title="Couldn't load this hero" body="Something went wrong on our side. Give it a moment and try again." action={<button className="btn btn-sm" onClick={reload} type="button">Retry</button>} />;

  const { hero, isOwner, owner, classVisual } = data;
  const look = lookFor(hero.appearance, classVisual ?? undefined);
  const winRate = formatWinRate(hero.record.battles, hero.record.wins);
  const ownership = heroOwnership({ hero: { id: hero.id, kind: hero.kind, isDemo: hero.isDemo, claimed: hero.claimed }, viewer });
  // Arena Picks rewards belong to the signed-in Telegram identity — available on your own hero even before you "claim" it.
  const isMine = Boolean(viewer && viewer.characterId === hero.id);

  async function claim() {
    setClaimNote(null);
    const r = await api("/api/me/claim", { method: "POST", json: {} });
    if (r.ok) {
      setClaimNote("Hero claimed! You can now manage tactics, gear and your Arena Picks rewards.");
      await load();
    } else setClaimNote(friendly(r.error));
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST", json: {} });
    window.dispatchEvent(new Event("clank-session"));
    router.push("/");
    router.refresh();
  }

  async function setTactic(t: string) {
    const r = await api("/api/me/tactic", { method: "POST", json: { tactic: t } });
    setTacticNote(r.ok ? "Tactic saved. It applies from your next battle." : friendly(r.error));
    if (r.ok) await load();
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-3 py-5 sm:px-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* identity + standing: the top hero section below `lg`, the left column above it */}
        <div className="hero-rail min-w-0 space-y-4">
          <div className={`min-w-0 space-y-4 transition-opacity ${staleAfterReroll ? "opacity-40" : ""}`} aria-busy={staleAfterReroll} data-testid="hero-rail-body">
            <HeroIdentityPanel
              hero={hero}
              classVisual={classVisual}
              look={look}
              ownership={ownership}
              selfStatus={data.self?.heroStatus}
              note={claimNote}
              onClaim={ownership === "UNCLAIMED_CLAIMABLE" ? claim : undefined}
              onSignOut={isOwner ? signOut : undefined}
            />
            <HeroStandingPanel power={hero.power} rarity={hero.appearance.rarity as Rarity} season={hero.season} />
          </div>
          {/* the member's own hero only: the free daily reroll (feature-flagged on the server; a disabled feature says so plainly) */}
          {isMine && <FreeRerollPanel onRerolled={() => { setStaleBundle(bundle); void load(); }} />}
        </div>

        {/* details */}
        <div className={`min-w-0 space-y-4 transition-opacity ${staleAfterReroll ? "opacity-40" : ""}`} aria-busy={staleAfterReroll}>
          {(isOwner || isMine) && (
            <nav className="flex gap-1 overflow-x-auto rounded-lg bg-ink-900 p-1" aria-label="Hero sections">
              {((isOwner && owner ? ["overview", "picks", "tactics", "wallet"] : ["overview", "picks"]) as Array<"overview" | "picks" | "tactics" | "wallet">).map((t) => (
                <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t} className={`flex-1 rounded-md px-3 py-2 font-display text-xs tracking-wider whitespace-nowrap uppercase ${tab === t ? "bg-clank-500 text-ink-900" : "text-steel-300 hover:text-paper"}`}>
                  {t === "overview" ? "Overview" : t === "picks" ? "Arena Picks" : t === "tactics" ? "Tactics" : "Bonus wallet"}
                </button>
              ))}
            </nav>
          )}

          {tab === "picks" && (isOwner || isMine) ? (
            <ArenaPicksPanel />
          ) : tab === "tactics" && isOwner && owner ? (
            <section className="plate p-5">
              <h2 className="font-display text-lg text-paper">Battle tactics</h2>
              <p className="mt-1 text-sm text-steel-300">Your hero fights on its own — tactics shape how. Class abilities and targeting still follow its class.</p>
              {tacticNote && <p role="status" className="mt-2 text-sm text-clank-300">{tacticNote}</p>}
              <div className="mt-4 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Tactic">
                {TACTICS.map((t) => (
                  <button key={t.id} type="button" role="radio" aria-checked={owner.tactic === t.id} onClick={() => void setTactic(t.id)} className={`plate p-4 text-left transition ${owner.tactic === t.id ? "plate-clank" : "plate-flat hover:brightness-125"}`}>
                    <span className="flex items-center justify-between">
                      <span className="font-display text-sm text-paper">{t.name}</span>
                      {owner.tactic === t.id && <CheckIcon size={18} className="text-clank-300" />}
                    </span>
                    <span className="mt-1 block text-xs text-steel-300">{t.body}</span>
                  </button>
                ))}
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <Locked title="Skill priority" body="Choose which ability fires first." />
                <Locked title="Target preference" body="Prefer wounded, nearest or most dangerous foes." />
              </div>
            </section>
          ) : tab === "wallet" && isOwner && owner ? (
            <section className="plate p-5">
              <h2 className="font-display text-lg text-paper">Bonus wallet &amp; bonded coins</h2>
              <p className="mt-1 text-xs text-steel-400">Optional: link a wallet to unlock bonded-coin hero bonuses. You do NOT need a wallet to play, make Arena Picks or earn rewards. (Holder tiers and reward wallets live in the Arena Picks tab.)</p>
              <div className="mt-3">
                <WalletPanel linkedAddress={owner.wallet} bondedCoins={hero.wallet.bondedCoinsHeld} diamondDays={hero.wallet.diamondDays} onChanged={() => void load()} />
              </div>
            </section>
          ) : (
            <>
              <section className="plate p-4 sm:p-5" aria-label="Hero summary">
                <dl className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-6">
                  <Tile label="Class" text={classVisual?.name ?? hero.classId} color={classVisual?.colors[0]} />
                  <Tile label="Arena wins" value={hero.record.wins} accent />
                  <Tile label="Top-2 finishes" value={hero.record.top2} />
                  <Tile label="Matches" value={hero.record.battles} />
                  <Tile label="KOs" value={hero.record.eliminations} />
                  <Tile label="Win rate" text={winRate} />
                </dl>
              </section>
              <StatsCard hero={hero} />
              <div className="grid gap-4 md:grid-cols-2">
                <SeasonCard season={hero.season} />
                <section className="plate p-5" aria-labelledby="com">
                  <h2 id="com" className="label">Community &amp; chain</h2>
                  {hero.community ? (
                    <dl className="mt-3 grid grid-cols-3 gap-3">
                      <Metric label="Messages" value={hero.community.qualifyingMessages} />
                      <Metric label="Active days" value={hero.community.activeDays} />
                      <Metric label="Activity" value={Math.round(hero.community.activityScore)} />
                    </dl>
                  ) : (
                    <p className="mt-3 text-sm text-steel-300">{hero.special?.role ?? "Hand-crafted team character."}</p>
                  )}
                  <p className="mt-3 text-xs text-steel-300">
                    {hero.wallet.linked ? `${hero.wallet.bondedCoinsHeld} bonded coin${hero.wallet.bondedCoinsHeld === 1 ? "" : "s"} held · ${hero.wallet.diamondDays}-day Diamond Hands` : "No wallet linked — wallet bonuses are optional."}
                  </p>
                </section>
              </div>
              {isOwner && owner && <GearStrip items={owner.inventory} gold={owner.gold} />}
              <section className="plate p-5" aria-labelledby="ach">
                <h2 id="ach" className="label">Achievements · {hero.achievements.filter((a) => a.unlocked).length}/{hero.achievements.length}</h2>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {hero.achievements.map((a) => (
                    <li key={a.id} className={`flex items-start gap-3 rounded-md border p-2.5 ${a.unlocked ? "border-clank-500/40 bg-clank-500/10" : "border-white/5 bg-white/[0.03] opacity-60"}`}>
                      <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${a.unlocked ? "bg-clank-400 text-ink-900" : "bg-white/10 text-steel-400"}`}>{a.unlocked ? <CheckIcon size={16} /> : <LockIcon size={14} />}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-paper">{a.name}</span>
                        <span className="block text-xs text-steel-300">{a.description}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              {hero.recentBattles.length > 0 && (
                <section className="plate p-5" aria-labelledby="hist">
                  <h2 id="hist" className="label">Recent battles</h2>
                  <ul className="mt-3 divide-y divide-white/5">
                    {hero.recentBattles.map((b) => (
                      <li key={b.battleId} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className={`font-display ${b.placement === 1 ? "text-clank-300" : b.placement === 2 ? "text-paper" : "text-steel-300"}`}>#{b.placement}</span>
                        <span className="flex-1 text-xs text-steel-300 tnum">{b.eliminations} {b.eliminations === 1 ? "KO" : "KOs"}</span>
                        <span className="text-xs text-gold tnum">+{b.gold} Gold</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatsCard({ hero }: { hero: CharacterDto }) {
  const comp = (key: StatKey) => {
    const b = hero.statBreakdown;
    const get = (name: string) => (b[name]?.[key] as number | undefined) ?? 0;
    return {
      class: get("base") + get("variation"),
      gear: get("gear"),
      community: get("telegram"),
      wallet: get("holdings") + get("loyalty") + get("trading"),
    };
  };
  return (
    <section className="plate p-5" aria-labelledby="stats">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="stats" className="label">Stats</h2>
        <div className="flex flex-wrap gap-3 text-[0.65rem] text-steel-300">
          {[["Class", COMPONENT_COLORS.class], ["Gear", COMPONENT_COLORS.gear], ["Community", COMPONENT_COLORS.community], ["Wallet", COMPONENT_COLORS.wallet]].map(([n, c]) => (
            <span key={n} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: c }} />{n}</span>
          ))}
        </div>
      </div>
      <ul className="mt-3 space-y-2.5">
        {STAT_KEYS.map((k) => {
          const total = hero.stats[k] ?? 0;
          const c = comp(k);
          const sum = c.class + c.gear + c.community + c.wallet || 1;
          const width = Math.min(100, (total / STAT_CAP[k]) * 100);
          return (
            <li key={k} className="grid grid-cols-[3.2rem_1fr_3rem] items-center gap-3">
              <span className="font-display text-xs text-steel-300">{STAT_LABELS[k]}</span>
              <span className="flex h-3 overflow-hidden rounded-sm bg-white/10" style={{ width: `${width}%`, minWidth: "6px" }} title={`Class ${c.class.toFixed(1)} · Gear ${c.gear.toFixed(1)} · Community ${c.community.toFixed(1)} · Wallet ${c.wallet.toFixed(1)}`}>
                <span style={{ width: `${(c.class / sum) * 100}%`, background: COMPONENT_COLORS.class }} />
                <span style={{ width: `${(c.gear / sum) * 100}%`, background: COMPONENT_COLORS.gear }} />
                <span style={{ width: `${(c.community / sum) * 100}%`, background: COMPONENT_COLORS.community }} />
                <span style={{ width: `${(c.wallet / sum) * 100}%`, background: COMPONENT_COLORS.wallet }} />
              </span>
              <span className="text-right font-display text-sm text-paper tnum">{total}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function GearStrip({ items, gold }: { items: InventoryItemView[]; gold: number }) {
  const equipped = items.filter((i) => i.equipped);
  return (
    <section className="plate p-5" aria-labelledby="gear">
      <div className="flex items-center justify-between">
        <h2 id="gear" className="label">Equipment</h2>
        <span className="chip !text-gold tnum">{gold.toLocaleString()} Clank Gold</span>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-3">
        {(["WEAPON", "ARMOR", "TRINKET"] as const).map((slot) => {
          const it = equipped.find((e) => e.slot === slot);
          return (
            <li key={slot} className="rounded-md border border-white/10 bg-white/5 p-3" style={it ? { borderColor: `${RARITY_COLOR[it.rarity]}88` } : undefined}>
              <p className="label !text-[0.6rem]">{slot}</p>
              <p className="mt-1 truncate text-sm font-bold" style={{ color: it ? RARITY_COLOR[it.rarity] : "#56637a" }}>{it?.name ?? "Empty"}</p>
            </li>
          );
        })}
      </ul>
      <Link href="/inventory" className="btn btn-ghost btn-sm mt-3">Open inventory</Link>
    </section>
  );
}

function Tile({ label, value, text, accent = false, color }: { label: string; value?: number; text?: string; accent?: boolean; color?: string | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="label !text-[0.6rem]">{label}</dt>
      <dd className={`truncate font-display text-xl tnum ${accent ? "text-clank-300" : "text-paper"}`} style={color && !accent ? { color: lighten(color, 0.5) } : undefined}>{text ?? (value ?? 0).toLocaleString()}</dd>
    </div>
  );
}

type SeasonInfo = CharacterDto["season"];

function SeasonCard({ season }: { season: SeasonInfo }) {
  return (
    <section className="plate p-5" aria-labelledby="season">
      <h2 id="season" className="label">{season ? season.label : "Season"}</h2>
      {season ? (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4 md:grid-cols-2">
            <Metric label="Rank" text={season.rank.name} />
            <Metric label="Points" value={season.points} accent />
            <Metric label="Matches" value={season.battles} />
            <Metric label="Wins" value={season.wins} />
          </dl>
          <p className="mt-3 text-xs text-steel-300">{season.kind === "DEVELOPMENT" ? "Development run — test battles, not an official record. " : ""}Season rank is competitive status. It resets every season, so everyone — new heroes included — can climb it, and it never changes your stats.</p>
        </>
      ) : (
        <p className="mt-3 text-sm text-steel-300">Season rank appears here once a season is running.</p>
      )}
    </section>
  );
}

function Metric({ label, value, text, accent = false }: { label: string; value?: number; text?: string; accent?: boolean }) {
  return (
    <div>
      <dt className="label !text-[0.6rem]">{label}</dt>
      <dd className={`font-display text-xl tnum ${accent ? "text-clank-300" : "text-paper"}`}>{text ?? (value ?? 0).toLocaleString()}</dd>
    </div>
  );
}

function Locked({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-dashed border-white/10 p-3 opacity-70">
      <LockIcon size={16} className="mt-0.5 text-steel-400" />
      <div>
        <p className="text-sm font-bold text-steel-300">{title} <span className="chip ml-1">Soon</span></p>
        <p className="text-xs text-steel-400">{body}</p>
      </div>
    </div>
  );
}

function HeroSkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-[1200px] gap-4 px-3 py-5 sm:px-6 lg:grid-cols-[320px_minmax(0,1fr)]" aria-busy="true" aria-label="Loading hero">
      <div className="space-y-4">
        <SkeletonBlock className="h-[560px]" />
        <SkeletonBlock className="h-64" />
      </div>
      <div className="space-y-4">
        <SkeletonBlock className="h-64" />
        <SkeletonBlock className="h-40" />
        <SkeletonBlock className="h-56" />
      </div>
    </div>
  );
}
