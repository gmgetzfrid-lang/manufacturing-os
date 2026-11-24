// The Manufacturing OS mark: a control valve as drawn on a P&ID (the
// bowtie on its line, the stem, the diaphragm actuator on top), white on
// deep navy, the actuator in the one warm accent. It is the product's own
// mark, the same as the home-screen icon (public/icon.svg, icon-192/512.png,
// app/apple-icon.png) and the browser tab (app/icon.svg). A workspace's
// uploaded logo is that company's, shown where it is shown today; this mark
// stays the product's.
//
// Under 20 px it switches to the tab-icon cut (drawn on a 16 px grid, no
// pipe stubs), so it stays crisp.

import React from "react";

/** The mark's own colors (fixed: the product's, not the workspace's). */
export const MARK_NAVY = "#0b1f4d";
export const MARK_ACCENT = "#f5a524";

export function AppMark({ size = 32, ring = false, className = "", title }: {
  size?: number;
  /** A hairline edge, for a dark background where the navy tile would
   *  melt into it (the side menu, the front door's brand panel). */
  ring?: boolean;
  className?: string;
  /** Says "Manufacturing OS" to a screen reader; leave out when the name
   *  is written next to it. */
  title?: string;
}) {
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true as const };
  if (size < 20) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className={`shrink-0 ${className}`} {...a11y}>
        <rect width="16" height="16" rx="3.5" fill={MARK_NAVY} />
        <path d="M2 8L8 11.5L2 15ZM14 8L8 11.5L14 15Z" fill="#fff" />
        <path d="M7 6h2v5.5H7z" fill="#fff" />
        <path d="M3.5 6a4.5 4.5 0 0 1 9 0z" fill={MARK_ACCENT} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={`shrink-0 ${className}`} {...a11y}>
      <rect width="100" height="100" rx="22" fill={MARK_NAVY} />
      {ring && <rect x="1" y="1" width="98" height="98" rx="21" fill="none" stroke="#fff" strokeOpacity=".18" strokeWidth="2" />}
      <g transform="translate(8 8) scale(.84)">
        <path d="M12 63H27M73 63H88" stroke="#fff" strokeWidth="8" strokeLinecap="round" />
        <path d="M27 47L50 63L27 79ZM73 47L50 63L73 79Z" fill="#fff" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
        <path d="M46.5 37h7v26h-7z" fill="#fff" />
        <path d="M30 38a20 20 0 0 1 40 0z" fill={MARK_ACCENT} />
      </g>
    </svg>
  );
}

/** The mark and the name, as the product signs its pages. */
export function AppLogo({ size = 32, ring = false, className = "", nameClass = "" }: {
  size?: number;
  ring?: boolean;
  className?: string;
  nameClass?: string;
}) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <AppMark size={size} ring={ring} />
      <span className={`whitespace-nowrap font-display text-[18px] font-semibold leading-none text-[var(--color-text)] ${nameClass}`}>Manufacturing OS</span>
    </span>
  );
}

export default AppMark;
