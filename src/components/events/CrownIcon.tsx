/** A pixel-style crown for champions. Decorative (the title beside it says everything); gold, and still when the viewer prefers reduced motion (see .trophy-float). */
export function CrownIcon({ size = 20, className = "", float = false }: { size?: number; className?: string; float?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 16 12" width={size} height={(size * 12) / 16} className={`shrink-0 ${float ? "trophy-float" : ""} ${className}`} shapeRendering="crispEdges">
      <path fill="currentColor" d="M1 11V3l3 3 4-5 4 5 3-3v8z" />
      <path fill="#0b0e14" opacity=".4" d="M1 9h14v1H1z" />
      <circle cx="1" cy="3" r="1" fill="currentColor" />
      <circle cx="8" cy="1" r="1" fill="currentColor" />
      <circle cx="15" cy="3" r="1" fill="currentColor" />
    </svg>
  );
}
