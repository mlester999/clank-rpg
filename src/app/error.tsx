"use client";

import { EmptyState } from "@/components/ui/bits";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="px-3 py-16">
      <EmptyState title="The Foundry hit a snag" body="Something went wrong loading this page. Heroes keep fighting meanwhile — try again in a moment." action={<button className="btn btn-sm" type="button" onClick={reset}>Try again</button>} />
    </div>
  );
}
