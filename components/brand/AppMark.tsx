// The app logo: a spectacle blind, the blind and spacer every turnaround
// sets and pulls, turned on its web: the open spacer in white, the blind
// in the app's orange, on navy. The same as the home-screen icon
// (public/icon.svg) and the browser tab (app/icon.svg). Small sizes draw it
// a little bolder so it holds at 16 to 32 px. A workspace's uploaded logo
// is that company's, shown in the side menu and on pages sent outside;
// this is the app's.

import React from "react";

/** The logo's navy. */
export const APP_NAVY = "#0b1f4d";
/** The logo's orange (globals.css --app-orange). */
export const APP_ORANGE = "#f26a1b";

/** The blind itself, on a 1024 square; `small` draws it bolder. */
export function BlindShape({ small = false }: { small?: boolean }) {
  return (
    <g transform="rotate(-32 512 512)">
      <rect x="420" y={small ? 452 : 462} width="184" height={small ? 120 : 100} rx="12" fill="#fff" />
      <circle cx="300" cy="512" r={small ? 180 : 168} fill="#fff" />
      <circle cx="300" cy="512" r={small ? 78 : 84} fill={APP_NAVY} />
      <circle cx="724" cy="512" r={small ? 180 : 168} fill={APP_ORANGE} />
    </g>
  );
}

export function AppMark({ size = 32, ring = false, className = "", title }: {
  size?: number;
  /** A hairline edge, for a dark background the navy would melt into. */
  ring?: boolean;
  className?: string;
  /** Says "Manufacturing OS" to a screen reader; leave out when the name
   *  is written next to it. */
  title?: string;
}) {
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true as const };
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" className={`shrink-0 ${className}`} {...a11y}>
      <rect width="1024" height="1024" rx="228" fill={APP_NAVY} />
      {ring && <rect x="16" y="16" width="992" height="992" rx="214" fill="none" stroke="#fff" strokeOpacity=".22" strokeWidth="32" />}
      <BlindShape small={size <= 32} />
    </svg>
  );
}

/** The logo and the app's name. */
export function AppLogo({ size = 32, ring = false, nameClass = "text-section" }: { size?: number; ring?: boolean; nameClass?: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <AppMark size={size} ring={ring} />
      <span className={`font-display font-semibold leading-none text-[var(--color-text)] whitespace-nowrap ${nameClass}`}>Manufacturing OS</span>
    </span>
  );
}
