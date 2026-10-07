import type { ReactNode } from "react";

import { characterCard, statusCopy } from "@/content/heroEligibility";
import type { EligibilityState } from "@/domain/heroEligibility";

const TONE: Record<string, string> = {
  info: "plate-flat",
  progress: "plate-clank",
  good: "plate-teal",
  claimed: "plate-teal",
};

/** Where the signed-in member stands. Numbers only appear when the server supplied a verified count. */
export function HeroStatusCard({ state, threshold, children }: { state: EligibilityState; threshold: number; children?: ReactNode }) {
  const copy = statusCopy(state, threshold);
  if (!copy) return null;
  const pct = copy.progress ? Math.min(100, Math.round((copy.progress.value / copy.progress.max) * 100)) : null;
  const [first, ...rest] = copy.lines;
  return (
    <section className={`plate ${TONE[copy.tone] ?? "plate-flat"} p-4 text-left`} aria-labelledby="hero-status" data-eligibility={state.kind}>
      <p className="label">{copy.tone === "claimed" ? "Telegram identity" : "Hero status"}</p>
      <h2 id="hero-status" className="mt-1 font-display text-lg tracking-wide text-paper uppercase">{copy.title}</h2>
      {pct !== null && copy.progress ? (
        <div className="mt-3">
          <p className="font-display text-base text-paper tnum">{first}</p>
          <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={copy.progress.value} aria-valuemin={0} aria-valuemax={copy.progress.max} aria-label="Qualifying messages toward a hero">
            <div className="h-full rounded-full bg-linear-to-r from-clank-500 to-teal" style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-paper">{first}</p>
      )}
      {rest.map((l) => <p key={l} className="mt-1.5 text-sm text-steel-300">{l}</p>)}
      {children}
    </section>
  );
}

/** The permanent explanation for visitors: who becomes a hero, in game language. */
export function BecomeHeroCard({ threshold }: { threshold: number }) {
  const c = characterCard(threshold);
  return (
    <section className="plate plate-clank p-5" aria-labelledby="become-hero">
      <p className="label">Eligibility</p>
      <h2 id="become-hero" className="mt-1 font-display text-lg tracking-wide text-clank-300 uppercase">{c.title}</h2>
      <ul className="mt-3 space-y-2">
        {c.lines.map((l) => (
          <li key={l} className="flex gap-2 text-sm leading-snug text-steel-300">
            <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rotate-45 bg-clank-400" />
            <span>{l}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 rounded-md border border-white/10 bg-white/5 p-3 text-sm text-steel-300"><b className="text-paper">{c.already.title}</b> {c.already.body}</p>
    </section>
  );
}
