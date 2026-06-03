"use client";

// useIsMobile — true when the viewport is below the Tailwind `md` breakpoint
// (768px). Used to drive behaviour that can't be expressed in pure CSS, e.g.
// forcing the sidebar to its full (non-icon) layout when it's an off-canvas
// drawer, regardless of the desktop collapse preference.

import { useEffect, useState } from "react";

const QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  // Default false so server render / first paint matches the desktop layout;
  // we correct on mount. (Avoids hydration mismatch flashes on desktop.)
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(QUERY);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return isMobile;
}
