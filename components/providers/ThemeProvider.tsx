"use client";

// ThemeProvider — owns the app's light/dark mode and brand accent, and
// applies them to the document root as CSS variables / the `.dark`
// class (see globals.css). Persisted per-device in localStorage so a
// choice sticks instantly without a round-trip; the org can later sync
// a default to the profile.
//
// Accent is stored as a hex string. A few curated presets ship by
// default; the logo-extraction feature (later) just feeds a hex in
// here, so theming has ONE source of truth.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ThemeMode = "light" | "dark";

export interface AccentPreset { id: string; name: string; hex: string }

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "indigo",  name: "Indigo",  hex: "#4f46e5" },
  { id: "violet",  name: "Violet",  hex: "#7c3aed" },
  { id: "blue",    name: "Blue",    hex: "#2563eb" },
  { id: "teal",    name: "Teal",    hex: "#0d9488" },
  { id: "emerald", name: "Emerald", hex: "#059669" },
  { id: "orange",  name: "Orange",  hex: "#ea580c" },
  { id: "rose",    name: "Rose",    hex: "#e11d48" },
  { id: "slate",   name: "Graphite", hex: "#475569" },
];

interface ThemeCtx {
  mode: ThemeMode;
  accent: string;          // hex
  setMode: (m: ThemeMode) => void;
  toggleMode: () => void;
  setAccent: (hex: string) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const LS_MODE = "mfgos.theme.mode";
const LS_ACCENT = "mfgos.theme.accent";

// ── color helpers: derive hover/soft/ring/contrast from one hex ──
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
/** Readable text color (black/white) for a given background. */
function contrastFg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#0f172a" : "#ffffff";
}

function applyTheme(mode: ThemeMode, accent: string) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.style.setProperty("--color-accent", accent);
  root.style.setProperty("--color-accent-hover", mix(accent, "#000000", 0.15));
  root.style.setProperty("--color-accent-fg", contrastFg(accent));
  root.style.setProperty("--color-accent-ring", mix(accent, "#ffffff", 0.35));
  // soft tint differs by mode (light wash vs dark glow) — handled in CSS
  // for dark; set a light tint here so light mode gets a faithful wash.
  if (mode === "light") root.style.setProperty("--color-accent-soft", mix(accent, "#ffffff", 0.88));
  else root.style.removeProperty("--color-accent-soft"); // let .dark rule compute it
  // expose meta theme-color for mobile chrome
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement("meta"); meta.setAttribute("name", "theme-color"); document.head.appendChild(meta); }
  meta.setAttribute("content", mode === "dark" ? "#0b1120" : "#ffffff");
}

// Lazy initial reads — run once, client-only (the pre-paint script
// already applied the class/accent to <html> so there's no flash).
function initialMode(): ThemeMode {
  if (typeof window === "undefined") return "light";
  try { const m = localStorage.getItem(LS_MODE); if (m === "dark" || m === "light") return m; } catch { /* noop */ }
  return "light";
}
function initialAccent(): string {
  if (typeof window === "undefined") return ACCENT_PRESETS[0].hex;
  try { const a = localStorage.getItem(LS_ACCENT); if (a && /^#[0-9a-fA-F]{6}$/.test(a)) return a; } catch { /* noop */ }
  return ACCENT_PRESETS[0].hex;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const [accent, setAccentState] = useState<string>(initialAccent);

  // Single source of truth: whenever mode/accent change, paint the DOM.
  useEffect(() => { applyTheme(mode, accent); }, [mode, accent]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try { localStorage.setItem(LS_MODE, m); } catch { /* noop */ }
  }, []);
  const toggleMode = useCallback(() => setModeState((m) => {
    const next = m === "dark" ? "light" : "dark";
    try { localStorage.setItem(LS_MODE, next); } catch { /* noop */ }
    return next;
  }), []);
  const setAccent = useCallback((hex: string) => {
    setAccentState(hex);
    try { localStorage.setItem(LS_ACCENT, hex); } catch { /* noop */ }
  }, []);

  const value = useMemo(() => ({ mode, accent, setMode, toggleMode, setAccent }), [mode, accent, setMode, toggleMode, setAccent]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme must be used within ThemeProvider");
  return c;
}

// Pre-paint script: set the .dark class + accent BEFORE first paint to
// avoid a flash of the wrong theme. Injected in <head> in layout.tsx.
export const THEME_PREPAINT = `(function(){try{
  var m=localStorage.getItem('${LS_MODE}'); if(m==='dark'){document.documentElement.classList.add('dark');}
  var a=localStorage.getItem('${LS_ACCENT}'); if(a&&/^#[0-9a-fA-F]{6}$/.test(a)){document.documentElement.style.setProperty('--color-accent',a);}
}catch(e){}})();`;
