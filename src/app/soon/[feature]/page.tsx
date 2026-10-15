import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { FEATURE_ICONS, LockIcon } from "@/components/ui/Icons";
import { FEATURES, FEATURE_ORDER, type FeatureId } from "@/content/features";

export function generateStaticParams() {
  return FEATURE_ORDER.map((feature) => ({ feature }));
}

export async function generateMetadata({ params }: { params: Promise<{ feature: string }> }): Promise<Metadata> {
  const { feature } = await params;
  const f = FEATURES[feature as FeatureId];
  return { title: f ? `${f.title} — Coming Soon` : "Coming Soon" };
}

export default async function SoonPage({ params }: { params: Promise<{ feature: string }> }) {
  const { feature } = await params;
  const f = FEATURES[feature as FeatureId];
  if (!f) notFound();
  const Icon = FEATURE_ICONS[f.icon];

  return (
    <div className="mx-auto w-full max-w-[1000px] px-3 py-8 sm:px-6">
      <section className="plate rivets relative overflow-hidden p-6 sm:p-10" style={{ ["--plate-edge" as string]: `linear-gradient(180deg, ${f.accent}, #232b39 70%)` }}>
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 h-80 w-80 rounded-full opacity-25 blur-3xl" style={{ background: f.accent }} />
        <div aria-hidden className="hazard absolute inset-x-0 top-0 h-2 opacity-70" />
        <div className="relative flex flex-col items-start gap-6 sm:flex-row sm:items-center">
          <div className="relative grid h-28 w-28 shrink-0 place-items-center rounded-2xl border-2 sm:h-36 sm:w-36" style={{ borderColor: `${f.accent}88`, background: `radial-gradient(circle at 50% 35%, ${f.accent}33, #0b0e14 70%)`, color: f.accent }}>
            <Icon size={64} strokeWidth={1.6} />
            <span className="absolute -right-3 -bottom-3 grid h-10 w-10 place-items-center rounded-full bg-ink-950 ring-2" style={{ ["--tw-ring-color" as string]: f.accent }}>
              <LockIcon size={18} />
            </span>
          </div>
          <div>
            <p className="chip" style={{ color: f.accent, borderColor: `${f.accent}66` }}><LockIcon size={12} /> Locked · Coming soon</p>
            <h1 className="mt-3 font-display text-3xl text-paper sm:text-4xl">{f.title}</h1>
            <p className="mt-1 text-lg font-semibold" style={{ color: f.accent }}>{f.tagline}</p>
          </div>
        </div>
        <p className="relative mt-6 max-w-2xl text-base text-steel-300">{f.pitch}</p>

        <div className="relative mt-6 grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="label">What&apos;s coming</h2>
            <ul className="mt-3 space-y-2">
              {f.bullets.map((b) => (
                <li key={b} className="flex gap-2.5 text-sm text-paper">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rotate-45" style={{ background: f.accent }} />
                  {b}
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-4">
            <div className="rounded-lg border border-white/10 bg-white/5 p-4">
              <h2 className="label">Already in place</h2>
              <p className="mt-2 text-sm text-steel-300">{f.foundation}</p>
            </div>
            {f.teaser && (
              <div className="rounded-lg border border-dashed border-white/15 p-4">
                <h2 className="label flex items-center gap-2"><LockIcon size={13} /> {f.teaser.title} — coming later</h2>
                <p className="mt-2 text-sm text-steel-300">{f.teaser.body}</p>
              </div>
            )}
          </div>
        </div>

        <div className="relative mt-8 flex flex-wrap items-center gap-3">
          <Link href="/" className="btn">Back to the Arena</Link>
          <Link href="/leaderboard" className="btn btn-ghost">Hall of Champions</Link>
        </div>
      </section>

      <nav aria-label="Other upcoming features" className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {FEATURE_ORDER.filter((id) => id !== f.id).map((id) => (
          <Link key={id} href={`/soon/${id}`} className="plate plate-flat flex items-center gap-2 p-3 text-sm text-steel-300 transition hover:text-paper" style={{ ["--chamfer" as string]: "6px" }}>
            <LockIcon size={14} />
            {FEATURES[id].nav}
          </Link>
        ))}
      </nav>
    </div>
  );
}
