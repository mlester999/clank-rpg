import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 20): SVGProps<SVGSVGElement> => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true });

export const GearIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.5l1.6 2.3 2.7-.7.9 2.6 2.7.7-.3 2.8 2 1.9-2 1.9.3 2.8-2.7.7-.9 2.6-2.7-.7L12 21.5l-1.6-2.3-2.7.7-.9-2.6-2.7-.7.3-2.8-2-1.9 2-1.9-.3-2.8 2.7-.7.9-2.6 2.7.7z" />
  </svg>
);
export const LockIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 018 0v3" />
  </svg>
);
export const SwordsIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 6.5L21 18v3h-3L6.5 9.5M11 5L5 11M8 8L4 4M5 3L3 5" />
  </svg>
);
export const SkullIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M12 3C7.5 3 4.5 6 4.5 10c0 2.4 1.1 4 2.5 5v3.5h3V17h4v1.5h3V15c1.4-1 2.5-2.6 2.5-5 0-4-3-7-7.5-7z" />
    <circle cx="9" cy="11" r="1.5" fill="currentColor" />
    <circle cx="15" cy="11" r="1.5" fill="currentColor" />
  </svg>
);
export const MapIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" />
  </svg>
);
export const BannerIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6 3v18M6 4h12l-3 4 3 4H6" />
  </svg>
);
export const TowerIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6 21V9l-1.5-1V4H8v2h2V4h4v2h2V4h3.5v4L18 9v12M10 21v-5a2 2 0 014 0v5" />
  </svg>
);
export const UserIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
  </svg>
);
export const BagIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 016 0v2" />
  </svg>
);
export const TrophyIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M7 4h10v5a5 5 0 01-10 0zM7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3M12 14v4M8 21h8M10 18h4" />
  </svg>
);
export const ArenaIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <ellipse cx="12" cy="14" rx="9" ry="5" />
    <path d="M3 14V9M21 14V9M12 4l1.5 3 3.2.4-2.4 2.2.7 3.2L12 11.2 9 12.8l.7-3.2L7.3 7.4 10.5 7z" />
  </svg>
);
export const CloseIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const CheckIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export const FEATURE_ICONS = { skull: SkullIcon, map: MapIcon, swords: SwordsIcon, banner: BannerIcon, tower: TowerIcon } as const;
export const HeroesIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <circle cx="17" cy="9" r="2.4" />
    <path d="M16.5 14.2c2.6.2 4.5 2.2 4.5 4.8" />
  </svg>
);
export const BookIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M5 4.5A1.5 1.5 0 016.5 3H19v15H6.5A1.5 1.5 0 005 19.5v-15z" />
    <path d="M5 19.5A1.5 1.5 0 006.5 21H19v-3M9 7.5h6M9 11h6" />
  </svg>
);
export const MoreIcon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="5.5" cy="12" r="1.6" fill="currentColor" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.6" fill="currentColor" />
  </svg>
);
