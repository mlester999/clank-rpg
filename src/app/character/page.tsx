import type { Metadata } from "next";

import { CharacterHub } from "@/components/character/CharacterHub";

export const metadata: Metadata = { title: "Your Character" };

export default function CharacterPage() {
  return <CharacterHub />;
}
