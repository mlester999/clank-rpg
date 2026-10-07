import type { Metadata } from "next";
import Link from "next/link";

import { HeroCardCompact } from "@/components/hero/HeroCard";
import { RarityIcon } from "@/components/hero/rarity";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { RARITIES } from "@/domain/character/appearance";
import { RARITY_LABEL } from "@/domain/hero/card";
import { demoHeroesAllowed } from "@/server/env";
import { getAllClasses, getReadyDb, getSettings } from "@/server/runtime";
import { listPublicHeroes, PUBLIC_DIRECTORY_PAGE_SIZE, type DirectoryFilters } from "@/server/services/publicHeroes";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Heroes",
  description: "Every hero of the Clank RPG arena — class, rarity and PWR. Higher rarity is a stronger hero. Pick a hero to see their card.",
};

type Search = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
const SORTS = [
  { id: "power", label: "PWR high → low" },
  { id: "power_asc", label: "PWR low → high" },
  { id: "name", label: "Name A–Z" },
  { id: "newest", label: "Newest" },
] as const;

export default async function HeroesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const classId = first(sp.class);
  const rarity = first(sp.rarity);
  const q = first(sp.q).slice(0, 40);
  const sort = (SORTS.find((s) => s.id === first(sp.sort))?.id ?? "power") as NonNullable<DirectoryFilters["sort"]>;
  const page = Math.max(1, Math.min(Number.parseInt(first(sp.page), 10) || 1, 10_000));

  const [db, settings, classes] = await Promise.all([getReadyDb(), getSettings(), getAllClasses()]);
  const data = await listPublicHeroes(db, { classId, rarity, search: q, sort, limit: PUBLIC_DIRECTORY_PAGE_SIZE, offset: (page - 1) * PUBLIC_DIRECTORY_PAGE_SIZE }, { allowDemo: demoHeroesAllowed(), classes, settings });

  const href = (patch: Partial<Record<"class" | "rarity" | "q" | "sort" | "page", string | null>>): string => {
    const next = new URLSearchParams();
    const merged = { class: classId, rarity, q, sort: sort === "power" ? "" : sort, page: "", ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, String(v));
    const s = next.toString();
    return s ? `/heroes?${s}` : "/heroes";
  };
  const pages = Math.max(1, Math.ceil(data.total / data.limit));
  const chip = (active: boolean) =>
    `shrink-0 rounded-md px-3 py-1.5 font-display text-[0.66rem] tracking-wider uppercase ring-1 transition ${active ? "bg-clank-500 text-ink-900 ring-clank-400" : "bg-white/[0.03] text-steel-300 ring-white/10 hover:bg-white/[0.06]"}`;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-3 py-6 sm:px-6">
      <PageHeader title="The" accent="Heroes" subtitle={`${data.total.toLocaleString()} hero${data.total === 1 ? "" : "es"} in the arena. Open one to see their card, stats and recent fights.`} />

      <form action="/heroes" method="get" role="search" className="mb-3 flex gap-2" data-testid="heroes-search">
        <input name="q" defaultValue={q} placeholder="Search a hero by name" aria-label="Search heroes by name" maxLength={40} className="min-w-0 flex-1 rounded-md border border-white/10 bg-ink-900 px-3 py-2 text-sm text-paper placeholder:text-steel-400" />
        {classId && <input type="hidden" name="class" value={classId} />}
        {rarity && <input type="hidden" name="rarity" value={rarity} />}
        {sort !== "power" && <input type="hidden" name="sort" value={sort} />}
        <button type="submit" className="btn btn-ghost btn-sm">Search</button>
      </form>

      <nav aria-label="Filter by class" className="mb-2 flex gap-1.5 overflow-x-auto pb-1" data-testid="filter-class">
        <Link href={href({ class: "", page: "" })} className={chip(!classId)} aria-current={!classId ? "true" : undefined}>All</Link>
        {data.classes.map((c) => (
          <Link key={c.id} href={href({ class: c.id, page: "" })} className={chip(classId === c.id)} aria-current={classId === c.id ? "true" : undefined}>{c.name}</Link>
        ))}
      </nav>
      <nav aria-label="Filter by rarity" className="mb-2 flex gap-1.5 overflow-x-auto pb-1" data-testid="filter-rarity">
        <Link href={href({ rarity: "", page: "" })} className={chip(!rarity)} aria-current={!rarity ? "true" : undefined}>All</Link>
        {RARITIES.map((r) => (
          <Link key={r} href={href({ rarity: r, page: "" })} className={`${chip(rarity === r)} inline-flex items-center gap-1.5`} aria-current={rarity === r ? "true" : undefined}><RarityIcon rarity={r} size={11} />{RARITY_LABEL[r]}</Link>
        ))}
      </nav>
      <nav aria-label="Sort" className="mb-4 flex items-center gap-1.5 overflow-x-auto pb-1" data-testid="filter-sort">
        <span className="label shrink-0">Sort</span>
        {SORTS.map((s) => (
          <Link key={s.id} href={href({ sort: s.id === "power" ? "" : s.id, page: "" })} className={chip(sort === s.id)} aria-current={sort === s.id ? "true" : undefined}>{s.label}</Link>
        ))}
      </nav>

      {data.heroes.length === 0 ? (
        <EmptyState title="No heroes match" body="Try another class or rarity, or clear the search." action={<Link href="/heroes" className="btn btn-sm">Show all heroes</Link>} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4" data-testid="hero-grid">
          {data.heroes.map((h) => (
            <li key={h.publicId} className="min-w-0">
              <HeroCardCompact model={h} />
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav aria-label="Pages" className="mt-6 flex items-center justify-between text-sm text-steel-300" data-testid="heroes-pager">
          {page > 1 ? <Link href={href({ page: String(page - 1) })} className="btn btn-ghost btn-sm" rel="prev">← Previous</Link> : <span />}
          <span className="tnum">Page {page} of {pages}</span>
          {page < pages ? <Link href={href({ page: String(page + 1) })} className="btn btn-ghost btn-sm" rel="next">Next →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
