"use client";

import Link from "next/link";

import { FEATURE_ICONS, LockIcon } from "@/components/ui/Icons";
import { FEATURES, FEATURE_ORDER } from "@/content/features";

const STEPS: Array<[string, string]> = [
  ["Watch, and pick the next winner", "While a fight is on, the eight heroes of the NEXT fight are on the right. Pick who you think wins — it's free, and no wallet is needed."],
  ["Picks lock", "The moment the current winner is decided, picks for the next fight lock. Then comes the results screen and a 3 · 2 · 1."],
  ["Under-a-minute brawl", "Fully automatic and decided on the server, inside a fixed arena. Fights usually last 30 to 50 seconds and never run past 60. The last hero standing wins — and picks open for the fight after it."],
  ["Points and leaderboards", "Every valid Pick counts toward the Daily and Weekly leaderboards. A correct Pick earns Clank Points — the boards are a race for the most correct Picks."],
];

export function HowItWorks() {
  return (
    <section className="plate plate-flat p-4" aria-labelledby="how">
      <h2 id="how" className="label">How the arena works</h2>
      <ol className="mt-3 space-y-2.5">
        {STEPS.map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-clank-500/15 font-display text-[0.7rem] text-clank-300 ring-1 ring-clank-500/40">{i + 1}</span>
            <span className="text-sm leading-snug text-steel-300">
              <b className="text-paper">{title}.</b> {body}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-steel-400">A hero&apos;s class and rarity are set when it is created, and players can&apos;t change them. Rarity is a real strength tier — a higher rarity means a higher PWR — but never a guaranteed win. <Link href="/docs/rarity" className="text-clank-300 underline underline-offset-2 hover:text-clank-200">How rarity works</Link>.</p>
    </section>
  );
}

export function ComingSoon() {
  return (
    <section className="plate plate-flat p-4" aria-labelledby="soon">
      <h2 id="soon" className="label">Coming soon</h2>
      <ul className="mt-3 grid grid-cols-2 gap-2">
        {FEATURE_ORDER.map((id) => {
          const f = FEATURES[id];
          const Icon = FEATURE_ICONS[f.icon];
          return (
            <li key={id}>
              <Link
                href={`/soon/${id}`}
                className="group relative flex items-center gap-2.5 overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 transition-colors hover:bg-white/[0.05]"
                title={`${f.title} — ${f.tagline}`}
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md" style={{ background: `${f.accent}1f`, color: f.accent }}>
                  <Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.78rem] font-bold text-paper">{f.nav}</span>
                  <span className="flex items-center gap-1 text-[0.62rem] tracking-wider text-steel-400 uppercase">
                    <LockIcon size={10} /> Locked
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-steel-400">
        Arena Picks are free — you can never lose anything. A wrong pick simply earns nothing.
      </p>
    </section>
  );
}
