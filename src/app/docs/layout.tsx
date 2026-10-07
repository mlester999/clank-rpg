import type { Metadata } from "next";

import { DocsShell } from "@/components/docs/DocsShell";

export const metadata: Metadata = {
  title: { default: "Docs", template: "%s · Clank RPG Docs" },
  description: "How Clank RPG works: heroes, classes, rarity and PWR, the Arena, Arena Picks, leaderboards and rewards.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
