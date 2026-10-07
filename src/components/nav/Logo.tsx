import Image from "next/image";

export function Logo({ compact = false, wordmarkClass = "" }: { compact?: boolean; wordmarkClass?: string }) {
  return (
    <span className="inline-flex items-center gap-2.5 select-none">
      <Image
        src="/clank-rpg-logo.png"
        alt=""
        width={36}
        height={36}
        priority
        className="h-9 w-9 object-contain"
      />
      {!compact && (
        <span className={`font-display text-[1.05rem] leading-none tracking-wide ${wordmarkClass}`}>
          <span className="text-shine">CLANK</span> <span className="text-paper">RPG</span>
        </span>
      )}
    </span>
  );
}
