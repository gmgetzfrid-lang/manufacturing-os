"use client";

// CornerDock — ONE bottom-right corner for every floating surface.
//
// Toasts, the upload indicator, and the knowledge-index card each used to
// pin themselves to `fixed bottom right` independently, so they rendered on
// top of each other and whichever mounted last won. The dock is a single
// fixed flex column; widgets portal their cards into it and stack with a
// gap instead of overlapping.
//
// CornerPortal degrades gracefully: on pages where the dock isn't mounted
// (public routes), it falls back to its own fixed positioning, so a widget
// never disappears just because the shell isn't there.

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const DOCK_ID = "corner-dock";

/** The shared target. Mount ONCE, in the protected layout. */
export function CornerDock() {
  return (
    <div
      id={DOCK_ID}
      className="fixed bottom-4 right-4 z-[300] flex flex-col items-end gap-2 pointer-events-none max-w-[calc(100vw-2rem)]"
    />
  );
}

/** Render children into the dock (stacked), or fall back to a fixed corner
 *  of their own when no dock exists on this page. */
export function CornerPortal({ children }: { children: React.ReactNode }) {
  // Resolved after mount (SSR has no document); the timeout defers the state
  // write out of the effect body per react-hooks/set-state-in-effect.
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setTarget(document.getElementById(DOCK_ID)), 0);
    return () => clearTimeout(t);
  }, []);
  if (!target) {
    return (
      <div className="fixed bottom-4 right-4 z-[300] flex flex-col items-end gap-2 pointer-events-none">
        {children}
      </div>
    );
  }
  return createPortal(children, target);
}
