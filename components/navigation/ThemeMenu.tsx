"use client";

// ThemeMenu — the top-bar control for picking light/dark and the brand
// accent. Lives next to the notification bell. Logo-based theme
// extraction (later) will add a panel here; the accent presets are the
// stable baseline.

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sun, Moon, Palette, Check, Upload, Loader2, Sparkles } from "lucide-react";
import { useTheme, ACCENT_PRESETS } from "@/components/providers/ThemeProvider";
import { extractLogoColors, type ExtractedColor } from "@/lib/logoTheme";

export default function ThemeMenu() {
  const { mode, accent, toggleMode, setAccent } = useTheme();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const [extracting, setExtracting] = useState(false);
  const [brandColors, setBrandColors] = useState<ExtractedColor[]>([]);

  const onLogo = async (file: File) => {
    setExtracting(true);
    try {
      const colors = await extractLogoColors(file);
      setBrandColors(colors);
      if (colors[0]) setAccent(colors[0].hex);
    } finally { setExtracting(false); }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const openMenu = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
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
            className="fixed z-[310] w-64 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl ring-1 ring-black/5 p-3"
            style={{ top: pos.top, right: pos.right }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-2">Appearance</div>

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

            {/* Accent presets */}
            <div className="mt-3 flex items-center gap-1.5">
              <Palette className="w-3 h-3 text-[var(--color-text-faint)]" />
              <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Accent</span>
            </div>
            <div className="mt-2 grid grid-cols-8 gap-1.5">
              {ACCENT_PRESETS.map((p) => {
                const active = accent.toLowerCase() === p.hex.toLowerCase();
                return (
                  <button
                    key={p.id}
                    onClick={() => setAccent(p.hex)}
                    title={p.name}
                    className={`relative w-6 h-6 rounded-full transition-transform hover:scale-110 ${active ? "ring-2 ring-offset-2 ring-[var(--color-text-muted)] ring-offset-[var(--color-surface)]" : ""}`}
                    style={{ backgroundColor: p.hex }}
                  >
                    {active && <Check className="w-3.5 h-3.5 text-white absolute inset-0 m-auto drop-shadow" />}
                  </button>
                );
              })}
            </div>

            {/* Brand-from-logo */}
            <div className="mt-3 pt-2.5 border-t border-[var(--color-border)]">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="w-3 h-3 text-[var(--color-text-faint)]" />
                <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Brand from your logo</span>
              </div>
              {brandColors.length > 0 ? (
                <>
                  <div className="grid grid-cols-8 gap-1.5">
                    {brandColors.map((c) => {
                      const active = accent.toLowerCase() === c.hex.toLowerCase();
                      return (
                        <button key={c.hex} onClick={() => setAccent(c.hex)} title={c.hex}
                          className={`relative w-6 h-6 rounded-full transition-transform hover:scale-110 ${active ? "ring-2 ring-offset-2 ring-[var(--color-text-muted)] ring-offset-[var(--color-surface)]" : ""}`}
                          style={{ backgroundColor: c.hex }}>
                          {active && <Check className="w-3.5 h-3.5 text-white absolute inset-0 m-auto drop-shadow" />}
                        </button>
                      );
                    })}
                  </div>
                  <button onClick={() => fileRef.current?.click()} className="mt-2 text-[11px] font-bold text-[var(--color-accent)] hover:underline">Try another logo</button>
                </>
              ) : (
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={extracting}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-[var(--color-border-strong)] text-xs font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors disabled:opacity-50"
                >
                  {extracting ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading colors…</> : <><Upload className="w-3.5 h-3.5" /> Upload logo → pull colors</>}
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onLogo(f); e.currentTarget.value = ""; }}
              />
              <div className="mt-1.5 text-[10px] text-[var(--color-text-faint)]">We read the colors right here in your browser — the logo isn&apos;t uploaded anywhere.</div>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
