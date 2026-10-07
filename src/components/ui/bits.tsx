import type { ReactNode } from "react";

import { RARITY_COLOR } from "@/components/hero/colors";

export function Plate({ children, className = "", clank = false, flat = false, as: As = "section", ...rest }: { children: ReactNode; className?: string; clank?: boolean; flat?: boolean; as?: "section" | "div" | "article" } & React.HTMLAttributes<HTMLElement>) {
  return (
    <As className={`plate ${clank ? "plate-clank" : ""} ${flat ? "plate-flat" : ""} ${className}`} {...(rest as object)}>
      {children}
    </As>
  );
}

export function RarityChip({ rarity }: { rarity: string }) {
  const c = RARITY_COLOR[rarity] ?? "#9aa4b2";
  return (
    <span className="chip" style={{ color: c, borderColor: `${c}66`, background: `${c}18` }}>
      {rarity.charAt(0) + rarity.slice(1).toLowerCase()}
    </span>
  );
}

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function PageHeader({ title, accent, subtitle, right }: { title: string; accent?: string; subtitle?: string; right?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl tracking-wide text-paper sm:text-3xl">
          {title} {accent && <span className="text-shine">{accent}</span>}
        </h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-steel-300">{subtitle}</p>}
      </div>
      {right}
    </header>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="plate plate-flat mx-auto max-w-lg p-6 text-center">
      <h2 className="font-display text-lg text-paper">{title}</h2>
      <p className="mt-2 text-sm text-steel-300">{body}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
