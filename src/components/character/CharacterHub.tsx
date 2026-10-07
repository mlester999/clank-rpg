"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { HeroAvatar } from "@/components/hero/HeroAvatar";
import { lookFor } from "@/components/hero/look";
import { EmptyState, PageHeader, SkeletonBlock } from "@/components/ui/bits";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { eligibilityState } from "@/domain/heroEligibility";
import { api } from "@/lib/api";
import type { ClassVisual } from "@/lib/dto";
import { useRemote } from "@/lib/useRemote";

import { BecomeHeroCard, HeroStatusCard } from "./EligibilityCards";
import { HeroView } from "./HeroView";
import { SignInPanel, type LoginInfo } from "./SignInPanel";

interface Me {
  viewer: { displayName: string; characterId: string | null; claimed: boolean; qualifyingMessages: number; threshold: number; status?: "OK" | "FLAGGED" } | null;
  login: LoginInfo;
}

interface SearchHit {
  id: string;
  publicId: string;
  name: string;
  classId: string;
  claimed: boolean;
  appearance: { rarity: string; parts: unknown };
  avatarUrl?: string | null;
}

export function CharacterHub() {
  const { data: me, error, reload: load } = useRemote<Me>(() => api<Me>("/api/me"), "me");
  const failed = Boolean(error);

  if (failed) return <div className="p-6"><EmptyState title="Can't load your profile" body="Please try again in a moment." /></div>;
  if (!me) return <div className="mx-auto max-w-[1100px] space-y-4 px-3 py-6 sm:px-6"><SkeletonBlock className="h-40" /><SkeletonBlock className="h-64" /></div>;

  if (me.viewer?.characterId) return <HeroView id={me.viewer.characterId} />;
  // The rule itself is a setting; a signed-in member's own threshold is authoritative, the default only covers visitors.
  const threshold = me.viewer?.threshold ?? DEFAULT_SETTINGS.telegram.qualifyingThreshold;

  return (
    <div className="mx-auto w-full max-w-[1100px] px-3 py-6 sm:px-6">
      <PageHeader title="Your" accent="Character" subtitle="Heroes are born from the official Clank.trade Telegram — nobody creates one by hand." />
      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-4">
          {me.viewer ? <ProgressCard viewer={me.viewer} /> : <SignInPanel login={me.login} onSignedIn={load} />}
          <BecomeHeroCard threshold={threshold} />
          <HowItWorks threshold={threshold} />
        </div>
        <FindHero />
      </div>
    </div>
  );
}

function ProgressCard({ viewer }: { viewer: NonNullable<Me["viewer"]> }) {
  // Progress is shown only from the verified, stored count of this signed-in member — never estimated.
  const state = eligibilityState({ viewer: { characterId: viewer.characterId, claimed: viewer.claimed, qualifyingMessages: viewer.qualifyingMessages, status: viewer.status }, threshold: viewer.threshold });
  return (
    <div className="space-y-3">
      <h2 className="font-display text-lg text-clank-300">Welcome, {viewer.displayName || "traveller"}</h2>
      <HeroStatusCard state={state} threshold={viewer.threshold} />
    </div>
  );
}

function HowItWorks({ threshold }: { threshold: number }) {
  const steps = [
    ["Take part", "Join the conversation in the official Clank.trade Telegram community."],
    ["Get a hero", `At ${threshold}+ qualifying messages a hero is created for you automatically — class, look and stats included.`],
    ["Fight while idle", "Your hero enters the Global Arena on its own. No site visit required."],
    ["Claim it", "Sign in with Telegram to take control: tactics, gear and optional wallet bonuses."],
  ];
  return (
    <section className="plate plate-flat p-5" aria-labelledby="how">
      <h2 id="how" className="label">How heroes work</h2>
      <ol className="mt-3 space-y-3">
        {steps.map(([t, b], i) => (
          <li key={t} className="flex gap-3">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-clank-500 font-display text-sm text-ink-900">{i + 1}</span>
            <span><b className="text-paper">{t}.</b> <span className="text-sm text-steel-300">{b}</span></span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FindHero() {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<SearchHit[] | null>(null);
  const [classes, setClasses] = useState<Record<string, ClassVisual>>({});
  // Results are only shown while the query is long enough, so short input needs no state reset.
  const hits = q.trim().length >= 2 ? found : null;
  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => {
      void api<{ heroes: SearchHit[]; classes: Record<string, ClassVisual> }>(`/api/heroes?q=${encodeURIComponent(q.trim())}`).then((r) => {
        if (!r.ok) return;
        setFound(r.data.heroes);
        setClasses(r.data.classes);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <section className="plate p-5" aria-labelledby="find">
      <h2 id="find" className="label">Find a hero</h2>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by hero name or Telegram username"
        aria-label="Search heroes"
        className="mt-3 w-full rounded-md border border-white/10 bg-ink-900 px-3 py-2.5 text-sm text-paper placeholder:text-steel-400"
      />
      <ul className="mt-3 space-y-1.5" aria-live="polite">
        {hits?.map((h) => (
          <li key={h.id}>
            <Link href={`/heroes/${h.publicId}`} className="flex items-center gap-3 rounded-md p-1.5 hover:bg-white/5">
              <HeroAvatar avatarUrl={h.avatarUrl} look={lookFor(h.appearance, classes[h.classId])} size={40} className="rounded" label={h.name} />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-paper" title={h.name}>{h.name}</span><span className="text-xs text-steel-300">{classes[h.classId]?.name ?? "Hero"}</span></span>
              <span className={`chip ${h.claimed ? "text-ok" : ""}`}>{h.claimed ? "Claimed" : "Unclaimed"}</span>
            </Link>
          </li>
        ))}
        {hits && hits.length === 0 && <li className="p-2 text-sm text-steel-300">No heroes match that search.</li>}
        {!hits && <li className="p-2 text-xs text-steel-400">Type at least two letters.</li>}
      </ul>
    </section>
  );
}
