"use client";

import { EmptyState } from "@/components/ui/bits";

/**
 * Heroes are read straight from the database when the page is rendered. If it is unreachable for a moment the visitor gets this — a retry state, never a
 * blank page and never the database's own message (Next.js does not send it to the browser either; only a digest).
 */
export default function HeroesError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-3 py-16 sm:px-6" data-testid="heroes-unavailable">
      <EmptyState
        title="Heroes are temporarily unavailable"
        body="We couldn't load the heroes just now. Nothing is lost — the Arena keeps running. Please try again in a moment."
        action={<button className="btn btn-sm" type="button" onClick={reset} data-testid="heroes-retry">Try again</button>}
      />
    </div>
  );
}
