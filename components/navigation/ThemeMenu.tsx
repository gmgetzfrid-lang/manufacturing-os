"use client";

// ThemeMenu — the top-bar control for picking light/dark and the brand
// PALETTE (a coordinated primary+secondary pair, not a single color).
// Lives next to the notification bell. The logo flow builds a palette
// from the two most distinct brand colors.

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sun, Moon, Palette as PaletteIcon, Check, Upload, Loader2, Zap } from "lucide-react";
import { useTheme, PALETTE_PRESETS, type Palette } from "@/components/providers/ThemeProvider";
import { extractLogoColors, type ExtractedColor } from "@/lib/logoTheme";

/** Perceptual-ish distance so the secondary is visually distinct. */
function dist(a: string, b: string): number {
  const p = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r1, g1, b1] = p(a); const [r2, g2, b2] = p(b);
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
}

export default function ThemeMenu() {
  const { mode, palette, toggleMode, setPalette } = useTheme();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const [extracting, setExtracting] = useState(false);
  const [brandColors, setBrandColors] = useState<ExtractedColor[]>([]);

  const samePalette = (p: Palette) =>
    p.primary.toLowerCase() === palette.primary.toLowerCase() &&
    p.secondary.toLowerCase() === palette.secondary.toLowerCase();

  const onLogo = async (file: File) => {
    setExtracting(true);
    try {
      const colors = await extractLogoColors(file);
      setBrandColors(colors);
      if (colors[0]) {
        // primary = most salient; secondary = most visually distinct from it.
        const primary = colors[0].hex;
        const secondary = colors.slice(1).sort((a, b) => dist(primary, b.hex) - dist(primary, a.hex))[0]?.hex ?? primary;
        setPalette({ id: "logo", name: "From logo", primary, secondary });
      }
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

            {/* Palette presets — coordinated primary + secondary */}
            <div className="mt-3 flex items-center gap-1.5">
              <PaletteIcon className="w-3 h-3 text-[var(--color-text-faint)]" />
              <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Palette</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {PALETTE_PRESETS.map((p) => {
                const active = samePalette(p);
                return (
                  <button
                    key={p.id}
                    onClick={() => setPalette(p)}
                    title={p.name}
                    className={`group flex items-center gap-2 px-2 py-1.5 rounded-xl border transition-colors ${active ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}
                  >
                    <span className="relative w-6 h-6 rounded-full shrink-0 ring-1 ring-black/10" style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.secondary})` }}>
                      {active && <Check className="w-3.5 h-3.5 text-white absolute inset-0 m-auto drop-shadow" />}
                    </span>
                    <span className={`text-[11px] font-bold truncate ${active ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{p.name}</span>
                  </button>
                );
              })}
            </div>

            {/* Brand-from-logo */}
            <div className="mt-3 pt-2.5 border-t border-[var(--color-border)]">
              <div className="flex items-center gap-1.5 mb-2">
                <Zap className="w-3 h-3 text-[var(--color-text-faint)]" />
                <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Brand from your logo</span>
              </div>
              {brandColors.length > 0 ? (
                <>
                  {/* live palette preview from the logo */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-9 h-6 rounded-lg ring-1 ring-black/10" style={{ background: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})` }} />
                    <span className="text-[10px] text-[var(--color-text-faint)]">Tap to set <b className="text-[var(--color-text-muted)]">primary</b>, long-press order picks secondary.</span>
                  </div>
                  <div className="grid grid-cols-8 gap-1.5">
                    {brandColors.map((c) => {
                      const isPrimary = palette.primary.toLowerCase() === c.hex.toLowerCase();
                      const isSecondary = palette.secondary.toLowerCase() === c.hex.toLowerCase();
                      return (
                        <button key={c.hex} title={c.hex}
                          onClick={() => setPalette({ ...palette, id: "logo", name: "From logo", primary: c.hex })}
                          onContextMenu={(e) => { e.preventDefault(); setPalette({ ...palette, id: "logo", name: "From logo", secondary: c.hex }); }}
                          className={`relative w-6 h-6 rounded-full transition-transform hover:scale-110 ${isPrimary ? "ring-2 ring-offset-2 ring-[var(--color-text-muted)] ring-offset-[var(--color-surface)]" : isSecondary ? "ring-2 ring-offset-1 ring-[var(--color-accent-2)] ring-offset-[var(--color-surface)]" : ""}`}
                          style={{ backgroundColor: c.hex }}>
                          {isPrimary && <Check className="w-3.5 h-3.5 text-white absolute inset-0 m-auto drop-shadow" />}
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
