import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { HeroView } from "@/components/character/HeroView";

export const metadata: Metadata = { title: "Hero" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function HeroPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <HeroView id={id} />;
}
