"use client";

import Link from "next/link";
import { memo } from "react";

import { FRAME_FLAG } from "@/domain/combat/types";
import { HeroAvatar } from "@/components/hero/HeroAvatar";
import { lookFor } from "@/components/hero/look";
import { RarityIcon } from "@/components/hero/rarity";
import { rarityVisual } from "@/domain/hero/rarityVisuals";
import type { Rarity } from "@/domain/character/appearance";
import type { ArenaStateDto, FighterDto } from "@/lib/dto";

import type { ArenaPhase } from "./ArenaRenderer";
import { useRoster, type RosterStore } from "./rosterStore";

const STATUS: Array<{ bit: number; label: string; cls: string }> = [
  { bit: FRAME_FLAG.STUNNED, label: "Stunned", cls: "border-gold/50 text-gold" },
  { bit: FRAME_FLAG.SLOWED, label: "Slowed", cls: "border-sky/50 text-sky" },
  { bit: FRAME_FLAG.TAUNTED, label: "Taunted", cls: "border-danger/50 text-danger" },
  { bit: FRAME_FLAG.SHIELDED, label: "Shield", cls: "border-sky/50 text-sky" },
  { bit: FRAME_FLAG.EMPOWERED, label: "Empowered", cls: "border-teal/50 text-teal" },
  { bit: FRAME_FLAG.BUFFED, label: "Buffed", cls: "border-teal/50 text-teal" },
];

interface Props {
  state: ArenaStateDto | null;
  fighters: FighterDto[];
  phase: ArenaPhase;
  winnerCharacterId: string | null;
  roster: RosterStore;
}

/**
 * Spectator HUD under the arena: who is alive, hurt, buffed or eliminated, and how much damage
 * and how many KOs each fighter has — live, from the verified replay. Identity and the pick
 * action live in the Current Round panel; this strip is purely "what is happening right now".
 */
export function SpectatorStrip({ state, fighters, phase, winnerCharacterId, roster }: Props) {
  const live = useRoster(roster);
  const fighting = phase === "COMBAT" || phase === "VICTORY" || phase === "RESULTS" || phase === "DONE";
  return (
    <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Live fighter status">
      {Array.from({ length: state?.groupSize ?? 8 }, (_, i) => {
        const f = fighters.find((x) => x.slot === i) ?? fighters[i];
        if (!f) return <li key={i} className="skeleton h-[5.4rem]" aria-hidden />;
        const r = live.find((x) => x.slot === f.slot);
        return (
          <FighterCard
            key={f.characterId}
            f={f}
            state={state!}
            hpFrac={r?.hpFrac ?? 1}
            alive={r?.alive ?? true}
            kills={r?.kills ?? 0}
            damage={r?.damage ?? 0}
            flags={r?.flags ?? 0}
            fighting={fighting}
            winner={winnerCharacterId === f.characterId}
          />
        );
      })}
    </ul>
  );
}

const FighterCard = memo(function FighterCard({ f, state, hpFrac, alive, kills, damage, flags, fighting, winner }: {
  f: FighterDto; state: ArenaStateDto; hpFrac: number; alive: boolean; kills: number; damage: number; flags: number; fighting: boolean; winner: boolean;
}) {
  const visual = state.classes[f.classId];
  const hpNow = f.maxHp ? Math.max(0, Math.round(hpFrac * f.maxHp)) : null;
  const color = hpFrac > 0.5 ? "#5fd38d" : hpFrac > 0.25 ? "#f5b94a" : "#ff4d5e";
  const status = alive ? STATUS.filter((s) => (flags & s.bit) !== 0) : [];
  return (
    <li>
      <Link
        href={`/heroes/${f.publicId}`}
        className={`plate plate-flat relative block p-2 transition-[filter,opacity] hover:brightness-125 ${!alive ? "opacity-50 saturate-50" : ""} ${winner ? "plate-clank" : ""}`}
        style={{ ["--chamfer" as string]: "7px" }}
        aria-label={`${f.name}: ${alive ? `${Math.round(hpFrac * 100)}% health` : "eliminated"}`}
      >
        <span className="flex items-center gap-2">
          <HeroAvatar avatarUrl={null} look={lookFor(f.appearance, visual, state.visuals.disabledCosmetics)} size={34} label={f.name} className="rounded" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.78rem] leading-tight font-bold text-paper" title={f.name}>{f.name}</span>
            <span className="flex items-center gap-1 truncate text-[0.66rem] leading-tight text-steel-300">
              <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: visual?.colors[0] ?? "#8b97ab" }} aria-hidden />
              {visual?.name}{f.power !== null ? ` · ${f.power.toLocaleString()}` : ""}
            </span>
          </span>
          <span className="shrink-0" style={{ color: rarityVisual(f.appearance.rarity).colors.base }} title={`${rarityVisual(f.appearance.rarity).label} rarity`} aria-label={`${rarityVisual(f.appearance.rarity).label} rarity`}><RarityIcon rarity={f.appearance.rarity as Rarity} size={12} /></span>
        </span>
        <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-white/10">
          <span className="block h-full rounded-full transition-[width] duration-150" style={{ width: `${Math.round(hpFrac * 100)}%`, background: color }} />
        </span>
        <span className="mt-1 flex items-center justify-between gap-1 text-[0.64rem] text-steel-300 tnum">
          <span>{hpNow !== null ? <><b className="text-paper">{hpNow}</b>/{f.maxHp} HP</> : "—"}</span>
          {fighting ? (
            <span className="flex items-center gap-2" title="Eliminations · damage dealt">
              <span><b className="text-paper">{kills}</b> KO</span>
              <span><b className="text-paper">{damage.toLocaleString()}</b> dmg</span>
            </span>
          ) : (
            <span className="text-steel-400">ready</span>
          )}
        </span>
        <span className="mt-1 flex min-h-[1rem] flex-wrap gap-1">
          {!alive && <Pill cls="border-danger/50 text-danger">KO</Pill>}
          {winner && <Pill cls="border-clank-300/60 text-clank-300">Winner</Pill>}
          {status.map((s) => (
            <Pill key={s.bit} cls={s.cls}>{s.label}</Pill>
          ))}
        </span>
      </Link>
    </li>
  );
});

function Pill({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`rounded-full border px-1.5 text-[0.58rem] leading-[1.05rem] font-bold tracking-wider uppercase ${cls}`}>{children}</span>;
}
