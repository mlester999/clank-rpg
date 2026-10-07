"use client";

import Link from "next/link";
import { memo } from "react";

import { HeroAvatar } from "@/components/hero/HeroAvatar";
import { lookFor } from "@/components/hero/look";
import { TrophyIcon } from "@/components/ui/Icons";
import type { ArenaStateDto } from "@/lib/dto";

export function relativeTime(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The hall of recent champions, below the arena. POWER is the value frozen when the battle was
 * fought (what it was when they won), not the hero's current number.
 */
export const RecentWinners = memo(function RecentWinners({ state, now }: { state: ArenaStateDto | null; now: number }) {
  const rows = state?.recent.filter((r) => r.winner) ?? [];
  return (
    <section aria-labelledby="recent-winners">
      <div className="mb-2 flex items-center justify-between">
        <h2 id="recent-winners" className="font-display text-base tracking-wide text-paper sm:text-lg">
          Recent <span className="text-shine">winners</span>
        </h2>
        {rows.length > 0 && <span className="label hidden sm:inline">Last {rows.length} battles</span>}
      </div>
      {rows.length === 0 ? (
        <div className="plate plate-flat p-4 text-sm text-steel-300">The first champion will be crowned when the first battle ends.</div>
      ) : (
        <ul className="grid grid-cols-1 gap-2 min-[520px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          {rows.map((r, i) => {
            const w = r.winner!;
            const visual = state!.classes[w.classId];
            return (
              <li key={r.id}>
                <Link
                  href={`/heroes/${w.publicId}`}
                  className={`plate relative flex items-center gap-3 p-2.5 transition-transform hover:-translate-y-0.5 ${i === 0 ? "plate-clank" : ""}`}
                  style={{ ["--chamfer" as string]: "9px" }}
                >
                  <span className="relative shrink-0">
                    <HeroAvatar avatarUrl={w.avatarUrl} look={lookFor(w.appearance, visual, state!.visuals.disabledCosmetics)} size={56} label={w.name} className="rounded-md" />
                    <span className="absolute -top-1.5 -right-1.5 grid h-5 w-5 place-items-center rounded-full bg-clank-300 text-ink-950 shadow" aria-hidden>
                      <TrophyIcon size={12} />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[0.62rem] font-bold tracking-wider text-clank-300 uppercase">
                      <span>#1 Winner</span>
                     
                    </span>
                    <span className="block truncate font-display text-[0.95rem] leading-tight text-paper" title={w.name}>{w.name}</span>
                    <span className="block truncate text-[0.7rem] text-steel-300">
                      {visual?.name ?? "Hero"}
                      {w.power !== null ? ` · PWR ${w.power.toLocaleString()}` : ""}
                    </span>
                    <span className="block truncate text-[0.66rem] text-steel-400">
                      {relativeTime(r.endedAt, now)}
                      {r.runnerUp ? ` · over ${r.runnerUp.name}` : ""}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
});
