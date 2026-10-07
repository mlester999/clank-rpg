import Link from "next/link";
import type { ReactNode } from "react";

import { DOCS_ROOT, docHref, neighbours, type DocPageMeta } from "@/content/docs/registry";

/** Breadcrumbs: Docs › Group › Page. */
export function Breadcrumbs({ page }: { page: DocPageMeta }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-3 text-[0.78rem] text-steel-300" data-testid="docs-breadcrumbs">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <li><Link href={DOCS_ROOT} className="hover:text-paper">Docs</Link></li>
        {page.slug !== "" && (
          <>
            <li aria-hidden className="text-steel-400">›</li>
            <li>{page.group}</li>
            <li aria-hidden className="text-steel-400">›</li>
            <li aria-current="page" className="text-paper">{page.title}</li>
          </>
        )}
      </ol>
    </nav>
  );
}

/** Previous / next page links at the foot of a page. */
export function PageNav({ slug }: { slug: string }) {
  const { prev, next } = neighbours(slug);
  return (
    <nav aria-label="Previous and next page" className="mt-12 grid grid-cols-1 gap-3 border-t border-white/10 pt-6 sm:grid-cols-2" data-testid="docs-pager">
      {prev ? (
        <Link href={docHref(prev.slug)} rel="prev" className="docs-card docs-plain">
          <span className="label !text-[0.6rem]">← Previous</span>
          <span className="mt-1 block font-display text-sm text-paper">{prev.slug === "" ? "Introduction" : prev.title}</span>
        </Link>
      ) : <span />}
      {next ? (
        <Link href={docHref(next.slug)} rel="next" className="docs-card docs-plain text-right sm:col-start-2">
          <span className="label !text-[0.6rem]">Next →</span>
          <span className="mt-1 block font-display text-sm text-paper">{next.title}</span>
        </Link>
      ) : <span />}
    </nav>
  );
}

/** One documentation page: breadcrumbs, title, lead, the body (in the readable `.docs-prose` style) and previous / next. */
export function DocArticle({ meta, children }: { meta: DocPageMeta; children: ReactNode }) {
  return (
    <article data-testid="docs-article" data-doc={meta.slug || "home"}>
      <Breadcrumbs page={meta} />
      <h1 className="docs-h1">{meta.title}</h1>
      <p className="docs-lead">{meta.summary}</p>
      <div className="docs-prose mt-6">{children}</div>
      <PageNav slug={meta.slug} />
    </article>
  );
}
