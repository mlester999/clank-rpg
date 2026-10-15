import type { Metadata } from "next";

import { EventsView } from "@/components/events/EventsView";
import { parseEvents } from "@/components/events/eventsModel";

export const metadata: Metadata = { title: "Events", description: "Who has been winning: the champions of every completed Daily and Weekly period of Arena Picks and Hero Arena." };

type Search = Record<string, string | string[] | undefined>;

/** Events: Recent Champions and Past Results. `?program=&kind=&period=` makes a view (and a period's full results) linkable. */
export default async function EventsPage({ searchParams }: { searchParams: Promise<Search> }) {
  return <EventsView initial={parseEvents(await searchParams)} />;
}
