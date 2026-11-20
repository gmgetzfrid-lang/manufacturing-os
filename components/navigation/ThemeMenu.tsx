"use client";

// ThemeMenu: the top-bar control for light/dark and the colors (the pair
// that sets the mood plus the one action color; see PalettePicker).

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sun, Moon } from "lucide-react";
import { useTheme } from "@/components/providers/ThemeProvider";
import PalettePicker from "@/components/branding/PalettePicker";

export default function ThemeMenu() {
  const { mode, palette, toggleMode, setPalette, paletteLocked } = useTheme();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const openMenu = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const w = Math.min(360, window.innerWidth - 16);
      setPos({ top: r.bottom + 8, right: Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - w - 8)) });
    }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={openMenu}
        title="Appearance"
        aria-label="Appearance"
        className="relative w-9 h-9 inline-flex items-center justify-center rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
      >
        {mode === "dark" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 z-[300]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[310] w-[min(360px,calc(100vw-16px))] max-h-[calc(100vh-80px)] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-lg ring-1 ring-black/5 p-3 animate-in fade-in zoom-in-95 duration-150 origin-top-right"
            style={{ top: pos.top, right: pos.right }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-2">Appearance</div>

            {/* Light / Dark segmented toggle */}
            <div className="grid grid-cols-2 gap-1 p-0.5 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border)]">
              <button
                onClick={() => mode !== "light" && toggleMode()}
                className={`inline-flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${mode === "light" ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)]"}`}
              >
                <Sun className="w-3.5 h-3.5" /> Light
              </button>
              <button
                onClick={() => mode !== "dark" && toggleMode()}
                className={`inline-flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${mode === "dark" ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)]"}`}
              >
                <Moon className="w-3.5 h-3.5" /> Dark
              </button>
            </div>

            <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
              <div className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-2">Colors</div>
              <PalettePicker value={palette} onChange={setPalette}
                lockedNote={paletteLocked ? "Your workspace sets these colors. An admin can change them in Branding." : undefined} />
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
