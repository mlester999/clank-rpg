import type { Metadata } from "next";

import { HallOfChampions } from "@/components/leaderboard/HallOfChampions";
import { parseHall } from "@/components/leaderboard/hallModel";

export const metadata: Metadata = { title: "Hall of Champions" };

type Search = Record<string, string | string[] | undefined>;

/** The Hall of Champions: Arena Picks · Hero Arena · Hero Records. `?section=&scope=&metric=` makes a view linkable. */
export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  return <HallOfChampions initial={parseHall(await searchParams)} />;
}
