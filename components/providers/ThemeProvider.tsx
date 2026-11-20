"use client";

// ThemeProvider: light/dark mode and the workspace's colors, applied to
// the document root as CSS variables (see globals.css). Saved per device.
//
// The app decides where color goes (lib/brandColors): pages are calm grey
// and white; the signal color marks only what you can do (buttons, links,
// the current tab and menu item). A palette supplies the hue (`primary`),
// an optional second hue for charts (`secondary`), and whether the side
// menu is light or graphite. The app sets lightness and strength, so any
// logo or picked color works.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { signalScale, chartColor, toOklch, fromOklch, isColorful, mix } from "@/lib/brandColors";

export type ThemeMode = "light" | "dark";

/** A workspace's colors: `primary` the brand (signal) color, `secondary`
 *  an optional second hue for charts, `side` the side menu. Older saved
 *  palettes (with `base` / `accent`) still load: their primary is used. */
export interface Palette { id: string; name: string; primary: string; secondary: string; side?: "light" | "dark"; base?: string; accent?: string }

/** Ready-made brand colors. The app tunes each one for buttons and links. */
export const PALETTE_PRESETS: Palette[] = [
  { id: "blue",    name: "Blue",    primary: "#1f5bd6", secondary: "#1f5bd6" },
  { id: "navy",    name: "Navy",    primary: "#1e3a8a", secondary: "#1e3a8a" },
  { id: "teal",    name: "Teal",    primary: "#0f766e", secondary: "#0f766e" },
  { id: "green",   name: "Green",   primary: "#15803d", secondary: "#15803d" },
  { id: "red",     name: "Red",     primary: "#b91c1c", secondary: "#b91c1c" },
  { id: "orange",  name: "Orange",  primary: "#c2410c", secondary: "#c2410c" },
  { id: "violet",  name: "Violet",  primary: "#6d28d9", secondary: "#6d28d9" },
  { id: "magenta", name: "Magenta", primary: "#be185d", secondary: "#be185d" },
];

/** Every CSS variable the colors set, worked out once (also saved so the
 *  next page load paints them before React starts). */
export function themeVars(mode: ThemeMode, p: Palette): Record<string, string> {
  const sc = signalScale(p.primary);
  const h = toOklch(sc[600])[2];
  const v: Record<string, string> = {};
  v["--color-accent"] = sc[600];
  v["--color-accent-hover"] = sc[700];
  v["--color-accent-fg"] = "#ffffff";
  v["--color-accent-ring"] = sc[400];
  v["--color-accent-text"] = mode === "dark" ? sc[300] : sc[700];
  if (mode === "light") v["--color-accent-soft"] = sc[100];
  v["--color-accent-2"] = sc[600];
  v["--color-accent-2-hover"] = sc[700];
  v["--color-accent-2-fg"] = "#ffffff";
  v["--color-accent-2-soft"] = mode === "light" ? sc[50] : mix(sc[900], "#181d25", 0.6);
  v["--color-band"] = sc[600];
  v["--brand-gradient"] = `linear-gradient(135deg, ${sc[600]}, ${sc[600]})`;
  v["--charcoal-accent-text"] = sc[300];
  // Charts: the brand color first, the logo's second hue next if it has one.
  v["--viz-cat-1"] = mode === "dark" ? sc[400] : sc[600];
  if (isColorful(p.secondary) && p.secondary.toLowerCase() !== p.primary.toLowerCase()) v["--viz-cat-2"] = chartColor(p.secondary);
  // Side menu: light, or graphite tinted toward the brand hue.
  const dark = p.side === "dark" || mode === "dark";
  if (!dark) {
    Object.assign(v, {
      "--side-bg": "#f7f8fa", "--side-surface": "#eceff3", "--side-text": "#1f2733", "--side-muted": "#4f5b6b",
      "--side-faint": "#677283", "--side-border": "#e0e4e9", "--side-border-strong": "#c7ced7",
      "--side-accent-text": sc[700], "--side-accent-soft": sc[100], "--side-logo-plate": "transparent",
    });
  } else {
    const bgL = mode === "dark" ? 0.2 : 0.25;
    Object.assign(v, {
      "--side-bg": fromOklch(bgL, 0.02, h), "--side-surface": fromOklch(bgL + 0.05, 0.025, h), "--side-text": "#f2f4f7",
      "--side-muted": "#b3bcc8", "--side-faint": "#8d97a5", "--side-border": fromOklch(bgL + 0.07, 0.025, h),
      "--side-border-strong": fromOklch(bgL + 0.13, 0.025, h), "--side-accent-text": sc[200], "--side-accent-soft": fromOklch(bgL + 0.1, 0.07, h), "--side-logo-plate": "#ffffff",
    });
  }
  return v;
}

const LS_VARS = "mfgos.theme.vars";

function applyTheme(mode: ThemeMode, p: Palette) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  // Clear what an earlier palette set, so nothing lingers.
  for (const k of ["--color-accent-soft", "--viz-cat-2", "--color-ink-text", "--color-ink-muted", "--side-accent-soft"]) root.style.removeProperty(k);
  const vars = themeVars(mode, p);
  for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
  try { localStorage.setItem(LS_VARS, JSON.stringify(vars)); } catch { /* noop */ }

  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement("meta"); meta.setAttribute("name", "theme-color"); document.head.appendChild(meta); }
  meta.setAttribute("content", mode === "dark" ? "#11151b" : "#eef0f3");
}

interface ThemeCtx {
  mode: ThemeMode;
  palette: Palette;
  /** The signal color as buttons show it. */
  accent: string;
  /** True when the active palette is enforced by the organization. */
  paletteLocked: boolean;
  setMode: (m: ThemeMode) => void;
  toggleMode: () => void;
  setPalette: (p: Palette) => void;
  /** Set just the brand color. */
  setAccent: (hex: string) => void;
  /** Apply an org-enforced palette (overrides personal; not persisted to
   *  this device). Pass null to fall back to the personal palette. */
  applyOrgPalette: (p: Palette | null) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const LS_MODE = "mfgos.theme.mode";
const LS_PALETTE = "mfgos.theme.palette";   // JSON Palette
const LS_ACCENT = "mfgos.theme.accent";     // legacy single hex

const isHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);

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
      if (o && isHex(o.primary)) return { id: o.id ?? "custom", name: o.name ?? "Custom", primary: o.primary, secondary: isHex(o.secondary ?? "") ? o.secondary : o.primary, ...(o.side === "dark" || o.side === "light" ? { side: o.side } : {}) };
    }
    const legacy = localStorage.getItem(LS_ACCENT);
    if (legacy && isHex(legacy)) return { id: "custom", name: "Custom", primary: legacy, secondary: legacy };
  } catch { /* noop */ }
  return PALETTE_PRESETS[0];
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Hydration contract: the FIRST client render must match the server's
  // HTML, so state starts at the same defaults the server used. Saved
  // mode/palette sync in after mount — the pre-paint <head> script already
  // set the real classes/CSS vars on <html>, so there's no visual flash;
  // only React's picture of the theme catches up. (Reading localStorage in
  // the useState initializer was the app-wide hydration mismatch — React
  // #418 for anyone with a saved dark mode.)
  const [mode, setModeState] = useState<ThemeMode>("light");
  const [palette, setPaletteState] = useState<Palette>(PALETTE_PRESETS[0]);
  const [hydrated, setHydrated] = useState(false);
  // Org-enforced palette wins when present (source of truth lives in the
  // org record, so it is not persisted to this device).
  const [orgPalette, setOrgPalette] = useState<Palette | null>(null);
  const effective = orgPalette ?? palette;

  useEffect(() => {
    let alive = true;
    (async () => {
      const m = initialMode();
      const p = initialPalette();
      if (!alive) return;
      setModeState(m);
      setPaletteState(p);
      setHydrated(true);
    })();
    return () => { alive = false; };
  }, []);

  // Don't stomp the pre-paint script's correct theme with the default
  // during the first frame — apply only once the saved state is loaded.
  useEffect(() => { if (hydrated) applyTheme(mode, effective); }, [hydrated, mode, effective]);
  // Paper is white: print in the light theme whatever the screen is in, so
  // reports and the shift turnover never print with dark backgrounds.
  useEffect(() => {
    const root = document.documentElement;
    const before = () => root.classList.remove("dark");
    const after = () => root.classList.toggle("dark", mode === "dark");
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => { window.removeEventListener("beforeprint", before); window.removeEventListener("afterprint", after); };
  }, [mode]);

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
  const applyOrgPalette = useCallback((p: Palette | null) => { setOrgPalette(p); }, []);

  const value = useMemo(
    () => ({ mode, palette: effective, accent: signalScale(effective.primary)[600], paletteLocked: !!orgPalette, setMode, toggleMode, setPalette, setAccent, applyOrgPalette }),
    [mode, effective, orgPalette, setMode, toggleMode, setPalette, setAccent, applyOrgPalette],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme must be used within ThemeProvider");
  return c;
}

// Pre-paint script: the .dark class and the saved color variables BEFORE
// first paint, so there's no flash. Injected in <head> in layout.tsx.
export const THEME_PREPAINT = `(function(){try{
  var m=localStorage.getItem('${LS_MODE}'); if(m==='dark'){document.documentElement.classList.add('dark');}
  var v=localStorage.getItem('${LS_VARS}'); var st=document.documentElement.style;
  if(v){try{var o=JSON.parse(v); for(var k in o){ if(k.indexOf('--')===0 && typeof o[k]==='string' && o[k].length<120){ if(m!=='dark' || k!=='--color-accent-soft'){st.setProperty(k,o[k]);} } }}catch(e){}}
}catch(e){}})();`;
