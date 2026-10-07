import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocArticle } from "@/components/docs/DocArticle";
import { DOC_BODIES } from "@/content/docs/bodies";
import { DOC_PAGES, docHref, findDocPage } from "@/content/docs/registry";

/** Every docs page is known at build time: unknown slugs are a plain 404. */
export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_PAGES.filter((p) => p.slug !== "").map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const meta = findDocPage(slug);
  if (!meta || slug === "") return { title: "Not found" };
  return { title: meta.title, description: meta.summary, alternates: { canonical: docHref(meta.slug) } };
}

export default async function DocsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const meta = findDocPage(slug);
  const Body = DOC_BODIES[slug];
  if (!meta || slug === "" || !Body) notFound();
  return (
    <DocArticle meta={meta}>
      <Body />
    </DocArticle>
  );
}
