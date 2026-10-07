import type { Metadata } from "next";

import { DocArticle } from "@/components/docs/DocArticle";
import { DOC_BODIES } from "@/content/docs/bodies";
import { findDocPage } from "@/content/docs/registry";

export const metadata: Metadata = {
  title: "Docs",
  description: findDocPage("")?.summary,
  alternates: { canonical: "/docs" },
};

export default function DocsHome() {
  const meta = findDocPage("")!;
  const Body = DOC_BODIES[""]!;
  return (
    <DocArticle meta={meta}>
      <Body />
    </DocArticle>
  );
}
