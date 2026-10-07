"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { DOCS_ROOT, DOC_GROUPS, DOC_PAGES, buildSearchIndex, docHref, findDocPage, searchDocs } from "@/content/docs/registry";

/** The slug of the docs page a pathname points at ("" for the docs home). */
export function slugOf(path: string): string {
  if (path === DOCS_ROOT || path === `${DOCS_ROOT}/`) return "";
  return path.replace(/^\/docs\//, "").split(/[/?#]/)[0] ?? "";
}

function DocsSearch({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const index = useMemo(() => buildSearchIndex(), []);
  const results = useMemo(() => searchDocs(index, q), [index, q]);
  return (
    <div className="mb-3" role="search">
      <label htmlFor="docs-search" className="sr-only">Search the docs</label>
      <input
        id="docs-search"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) {
            router.push(results[0].href);
            setQ("");
            onNavigate?.();
          }
        }}
        placeholder="Search the docs"
        autoComplete="off"
        className="w-full rounded-md border border-white/10 bg-ink-900 px-3 py-2 text-sm text-paper placeholder:text-steel-400 focus-visible:outline-2 focus-visible:outline-clank-300"
        data-testid="docs-search"
      />
      {q.trim() && (
        <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto rounded-md border border-white/10 bg-ink-900 p-1" aria-label="Search results" data-testid="docs-search-results">
          {results.length === 0 && <li className="px-2 py-2 text-sm text-steel-300">Nothing found.</li>}
          {results.map((r) => (
            <li key={r.href}>
              <Link href={r.href} onClick={() => { setQ(""); onNavigate?.(); }} className="block rounded px-2 py-1.5 text-sm text-paper hover:bg-white/5">
                {r.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocsNav({ slug, onNavigate }: { slug: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Documentation">
      {DOC_GROUPS.map((group) => (
        <div key={group} className="mb-4">
          <p className="label mb-1 px-2 !text-[0.6rem]">{group}</p>
          <ul className="space-y-0.5">
            {DOC_PAGES.filter((p) => p.group === group).map((p) => (
              <li key={p.slug || "home"}>
                <Link href={docHref(p.slug)} aria-current={p.slug === slug ? "page" : undefined} onClick={onNavigate} className="docs-nav-link">
                  {p.slug === "" ? "Introduction" : p.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** "On this page": the page's sections, with the one being read highlighted (a scroll spy over the headings). */
function Toc({ slug }: { slug: string }) {
  const page = findDocPage(slug);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!page) return;
    const els = page.sections.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => e !== null);
    if (els.length === 0 || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = els.find((el) => visible.has(el.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-96px 0px -62% 0px" },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [page]);
  if (!page || page.sections.length < 2) return null;
  return (
    <nav aria-label="On this page" data-testid="docs-toc">
      <p className="label mb-2 !text-[0.6rem]">On this page</p>
      <ul>
        {page.sections.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} className="docs-toc-link" aria-current={active === s.id ? "true" : undefined}>{s.title}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DocsShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const slug = slugOf(path);
  const page = findDocPage(slug);
  // The mobile menu is tied to the page it was opened on, so navigating closes it without an effect.
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const menuOpen = menuAt === path;
  return (
    <div className="mx-auto w-full max-w-[1320px] px-3 sm:px-6" data-testid="docs-shell">
      <div className="sticky top-16 z-30 -mx-3 border-b border-white/10 bg-ink-950/95 px-3 py-2 backdrop-blur-md sm:-mx-6 sm:px-6 lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate font-display text-[0.7rem] tracking-wider text-clank-300 uppercase">
            <Link href={DOCS_ROOT} className="docs-plain hover:text-clank-200">Docs</Link>
            {page && slug !== "" ? <span className="text-steel-300"> · {page.title}</span> : null}
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-sm shrink-0"
            aria-expanded={menuOpen}
            aria-controls="docs-menu"
            onClick={() => setMenuAt(menuOpen ? null : path)}
            data-testid="docs-menu-button"
          >
            {menuOpen ? "Close" : "Menu"}
          </button>
        </div>
        {menuOpen && (
          <div id="docs-menu" className="mt-2 max-h-[68dvh] overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-ink-900 p-3" data-testid="docs-menu">
            <DocsSearch onNavigate={() => setMenuAt(null)} />
            <DocsNav slug={slug} onNavigate={() => setMenuAt(null)} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-8 py-6 lg:grid-cols-[236px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_218px]">
        <aside className="hidden lg:block" aria-label="Docs navigation">
          <div className="sticky top-24 max-h-[calc(100dvh-7rem)] overflow-y-auto pr-2">
            <DocsSearch />
            <DocsNav slug={slug} />
          </div>
        </aside>
        <div className="min-w-0">{children}</div>
        <aside className="hidden xl:block">
          <div className="sticky top-24 max-h-[calc(100dvh-7rem)] overflow-y-auto">
            <Toc slug={slug} />
          </div>
        </aside>
      </div>
    </div>
  );
}
