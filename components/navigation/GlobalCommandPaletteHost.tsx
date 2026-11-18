"use client";

// GlobalCommandPaletteHost — the part of the global command palette that
// lives in the app shell (projects-tab PERF-12, projects-joint J18).
//
// It owns the palette's open state and the one window keydown listener —
// Cmd+K / Ctrl+K toggles, `/` opens when no field has focus, `?` opens
// straight to the shortcuts, Escape closes — mounted with the protected
// layout, exactly as the palette's own listener was. The palette itself
// (components/navigation/GlobalCommandPalette.tsx: the search, the actions
// and what they import — the evidence pack, the feature atlas) is a module
// of its own, fetched when the browser is first idle after the page is up,
// or at the first press, whichever comes first. A press before it has
// arrived is kept: the palette opens as soon as it lands. The header's
// search button and the cockpit's QuickLaunch dispatch the same Cmd+K
// keydown, so they reach this listener too.

import React, { useEffect, useRef, useState } from "react";
import { lazyModule, usePreloadWhenIdle } from "@/lib/lazyModule";

export const commandPaletteModule = lazyModule(
  () => import("@/components/navigation/GlobalCommandPalette"),
  "command palette",
);

export type PaletteKeyAction = "toggle" | "help" | "close" | null;

/** What a window keydown does to the palette. `/` and `?` are not taken
 *  from someone typing in a field, and only while the palette is closed;
 *  Cmd+K / Ctrl+K always toggles; Escape closes an open palette. */
export function paletteKeyAction(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target">,
  open: boolean,
): PaletteKeyAction {
  const isCmdK = (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
  const isSlash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey;
  // Don't hijack `/` when the user's typing into a field
  const target = e.target as HTMLElement | null;
  const inField = !!target && (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
  // `?` (Shift+/) from anywhere opens straight to the shortcuts cheatsheet —
  // the standard GitHub/Linear/Gmail gesture the placeholder advertises.
  const isHelp = e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey;
  if (isCmdK || (isSlash && !inField && !open)) return "toggle";
  if (isHelp && !inField && !open) return "help";
  if (e.key === "Escape" && open) return "close";
  return null;
}

export default function GlobalCommandPaletteHost() {
  const [open, setOpen] = useState(false);
  // Set when the palette is opened via the global `?` so it lands directly
  // on the shortcuts cheatsheet (the palette's open effect reads + clears it).
  const wantShortcutsRef = useRef(false);

  usePreloadWhenIdle(commandPaletteModule);

  // Open on Cmd+K / Ctrl+K — or just `/` when no input is focused — from
  // anywhere. The `/` shortcut matches Linear / GitHub / Vercel patterns
  // and is fast to reach for power users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = paletteKeyAction(e, open);
      if (action === "toggle") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (action === "help") {
        e.preventDefault();
        wantShortcutsRef.current = true;
        setOpen(true);
      } else if (action === "close") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Opening fetches the palette if the idle preload has not yet.
  const loaded = commandPaletteModule.useLoaded(open);
  if (!loaded) return null;
  const Palette = loaded.default;
  return <Palette open={open} setOpen={setOpen} wantShortcutsRef={wantShortcutsRef} />;
}
