"use client";

// ThemeProvider — owns the app's light/dark mode and brand PALETTE, and
// applies them to the document root as CSS variables / the `.dark`
// class (see globals.css). Persisted per-device in localStorage.
//
// A palette is a *coordinated pair* — a primary and a secondary brand
// color — not a single accent. The provider derives a full set of tones
// (hover, soft, ring, on-color text, gradient stops) from the pair, so
// the whole UI moves together. Curated palettes ship by default; the
// logo-extraction feature builds a palette by picking the two most
// distinct brand colors. ONE source of truth for brand color.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ThemeMode = "light" | "dark";

export interface Palette { id: string; name: string; primary: string; secondary: string }

// Designer-grade coordinated palettes (primary + harmonious secondary).
export const PALETTE_PRESETS: Palette[] = [
  { id: "indigo",   name: "Indigo Nebula", primary: "#4f46e5", secondary: "#a855f7" },
  { id: "ocean",    name: "Ocean",         primary: "#2563eb", secondary: "#06b6d4" },
  { id: "teal",     name: "Lagoon",        primary: "#0d9488", secondary: "#22c55e" },
  { id: "forest",   name: "Forest",        primary: "#059669", secondary: "#84cc16" },
  { id: "sunset",   name: "Sunset",        primary: "#ea580c", secondary: "#e11d48" },
  { id: "magma",    name: "Magma",         primary: "#dc2626", secondary: "#f59e0b" },
  { id: "berry",    name: "Berry",         primary: "#db2777", secondary: "#7c3aed" },
  { id: "graphite", name: "Graphite",      primary: "#475569", secondary: "#0ea5e9" },
];

interface ThemeCtx {
  mode: ThemeMode;
  palette: Palette;
  accent: string;                 // = palette.primary (back-compat)
  setMode: (m: ThemeMode) => void;
  toggleMode: () => void;
  setPalette: (p: Palette) => void;
  /** Set just the primary; keeps current secondary. */
  setAccent: (hex: string) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const LS_MODE = "mfgos.theme.mode";
const LS_PALETTE = "mfgos.theme.palette";   // JSON {primary,secondary}
const LS_ACCENT = "mfgos.theme.accent";     // legacy single hex

// ── color helpers ───────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const int = parseInt(n, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mix(hex: string, withHex: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(hex); const [r2, g2, b2] = hexToRgb(withHex);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
function contrastFg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#0f172a" : "#ffffff";
}
const isHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);

function applyTheme(mode: ThemeMode, p: Palette) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");

  // primary
  root.style.setProperty("--color-accent", p.primary);
  root.style.setProperty("--color-accent-hover", mix(p.primary, "#000000", 0.15));
  root.style.setProperty("--color-accent-fg", contrastFg(p.primary));
  root.style.setProperty("--color-accent-ring", mix(p.primary, "#ffffff", 0.35));
  // secondary
  root.style.setProperty("--color-accent-2", p.secondary);
  root.style.setProperty("--color-accent-2-hover", mix(p.secondary, "#000000", 0.15));
  root.style.setProperty("--color-accent-2-fg", contrastFg(p.secondary));
  // gradient stops for hero/brand surfaces
  root.style.setProperty("--brand-gradient", `linear-gradient(135deg, ${p.primary}, ${p.secondary})`);

  // soft tints differ by mode (light wash vs dark glow)
  if (mode === "light") {
    root.style.setProperty("--color-accent-soft", mix(p.primary, "#ffffff", 0.88));
    root.style.setProperty("--color-accent-2-soft", mix(p.secondary, "#ffffff", 0.88));
  } else {
    root.style.removeProperty("--color-accent-soft"); // computed in .dark rule
    root.style.setProperty("--color-accent-2-soft", mix(p.secondary, "#0b1120", 0.78));
  }

  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement("meta"); meta.setAttribute("name", "theme-color"); document.head.appendChild(meta); }
  meta.setAttribute("content", mode === "dark" ? "#0b1120" : "#ffffff");
}

// ── lazy initial reads (client-only; pre-paint script handles flash) ──
function initialMode(): ThemeMode {
  if (typeof window === "undefined") return "light";
  try { const m = localStorage.getItem(LS_MODE); if (m === "dark" || m === "light") return m; } catch { /* noop */ }
  return "light";
}
function initialPalette(): Palette {
  if (typeof window === "undefined") return PALETTE_PRESETS[0];
  try {
    const raw = localStorage.getItem(LS_PALETTE);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && isHex(o.primary) && isHex(o.secondary)) return { id: o.id ?? "custom", name: o.name ?? "Custom", primary: o.primary, secondary: o.secondary };
    }
    // migrate a legacy single accent → palette (primary + derived secondary)
    const legacy = localStorage.getItem(LS_ACCENT);
    if (legacy && isHex(legacy)) return { id: "custom", name: "Custom", primary: legacy, secondary: mix(legacy, "#ffffff", 0) };
  } catch { /* noop */ }
  return PALETTE_PRESETS[0];
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const [palette, setPaletteState] = useState<Palette>(initialPalette);

  useEffect(() => { applyTheme(mode, palette); }, [mode, palette]);

  const persistPalette = (p: Palette) => {
    try { localStorage.setItem(LS_PALETTE, JSON.stringify(p)); } catch { /* noop */ }
  };

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try { localStorage.setItem(LS_MODE, m); } catch { /* noop */ }
  }, []);
  const toggleMode = useCallback(() => setModeState((m) => {
    const next = m === "dark" ? "light" : "dark";
    try { localStorage.setItem(LS_MODE, next); } catch { /* noop */ }
    return next;
  }), []);
  const setPalette = useCallback((p: Palette) => {
    setPaletteState(p); persistPalette(p);
  }, []);
  const setAccent = useCallback((hex: string) => {
    setPaletteState((prev) => { const p = { ...prev, id: "custom", name: "Custom", primary: hex }; persistPalette(p); return p; });
  }, []);

  const value = useMemo(
    () => ({ mode, palette, accent: palette.primary, setMode, toggleMode, setPalette, setAccent }),
    [mode, palette, setMode, toggleMode, setPalette, setAccent],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme must be used within ThemeProvider");
  return c;
}

// Pre-paint script: set the .dark class + primary accent BEFORE first
// paint to avoid a flash. Injected in <head> in layout.tsx.
export const THEME_PREPAINT = `(function(){try{
  var m=localStorage.getItem('${LS_MODE}'); if(m==='dark'){document.documentElement.classList.add('dark');}
  var pal=localStorage.getItem('${LS_PALETTE}'); var prim=null;
  if(pal){try{var o=JSON.parse(pal); if(o&&/^#[0-9a-fA-F]{6}$/.test(o.primary)){prim=o.primary;}}catch(e){}}
  if(!prim){var a=localStorage.getItem('${LS_ACCENT}'); if(a&&/^#[0-9a-fA-F]{6}$/.test(a)){prim=a;}}
  if(prim){document.documentElement.style.setProperty('--color-accent',prim);}
}catch(e){}})();`;
