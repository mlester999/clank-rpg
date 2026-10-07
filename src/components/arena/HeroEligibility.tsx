"use client";

import { useId, useRef } from "react";

import { arenaCard, learnMore } from "@/content/heroEligibility";

/** Small lore card under the arena: who becomes a hero. "Learn more" opens a native modal dialog (focus-trapped, Esc closes). */
export function HeroEligibilityCard({ threshold }: { threshold: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const card = arenaCard(threshold);
  const more = learnMore(threshold);
  return (
    <section className="plate plate-flat p-4" aria-labelledby="who-heroes" data-testid="hero-eligibility">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-80">
          <h2 id="who-heroes" className="label">{card.title}</h2>
          <p className="mt-2 text-sm leading-snug text-paper">{card.lead}</p>
          <p className="mt-1.5 text-sm leading-snug text-steel-300">{card.body}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => ref.current?.showModal()}>{card.cta}</button>
      </div>

      <dialog
        ref={ref}
        aria-labelledby={titleId}
        className="m-auto w-[calc(100%-2rem)] max-w-[30rem] bg-transparent p-0 text-paper backdrop:bg-black/70"
        onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
      >
        <div className="plate plate-clank p-5">
          <h3 id={titleId} className="font-display text-lg tracking-wide text-clank-300 uppercase">{more.title}</h3>
          <ul className="mt-3 space-y-2.5">
            {more.points.map((p) => (
              <li key={p} className="flex gap-2 text-sm leading-snug text-steel-300">
                <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rotate-45 bg-clank-400" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex justify-end">
            <button type="button" className="btn btn-sm" autoFocus onClick={() => ref.current?.close()}>Got it</button>
          </div>
        </div>
      </dialog>
    </section>
  );
}
