"use client";

// ThemeProvider: light/dark mode and the workspace's colors, applied to
// the document root as CSS variables (see globals.css). Saved per device.
//
// The workspace's palette (from its logo: primary, secondary, deep) is
// placed on roles, 60 / 30 / 10:
//   page     a light neutral with about 4% of the brand hue (60)
//   side     the side menu in the brand's deep shade, calm and dark (30):
//            the brand's, or its own color (a logo's darkest, say)
//   action   the ONE filled color: the main button per screen (10). The
//            logo's second color, or the brand's opposite.
//   brand    the brand's readable shade: links, the current tab's
//            underline, the side menu's marker, the focus ring, the one
//            series that matters in a chart.
// Nothing paints a saturated band behind page headers: --color-band is
// kept for older code and is the page color. The app sets every
// lightness (lib/brandColors), so any logo works.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { signalScale, chartColor, toOklch, fromOklch, mix, deepFor, accentFor, tintedNeutrals, isColorful } from "@/lib/brandColors";

export type ThemeMode = "light" | "dark";

const isHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);

/** A workspace's colors: `primary` the brand, `secondary` the accent's
 *  source (the logo's second color; the same as primary means "use the
 *  brand's opposite"), `deep` the side menu's own source color (the
 *  brand when unset), `side` the side menu ("deep" by default). */
export interface Palette { id: string; name: string; primary: string; secondary: string; deep?: string; side?: "deep" | "light" | "dark"; base?: string; accent?: string }

/** Ready-made pairs: a brand color and the accent that makes it pop. */
export const PALETTE_PRESETS: Palette[] = [
  { id: "blue",    name: "Blue and tangerine", primary: "#1f5bd6", secondary: "#f97316" },
  { id: "navy",    name: "Navy and gold",      primary: "#1e3a8a", secondary: "#eab308" },
  { id: "teal",    name: "Teal and coral",     primary: "#0f766e", secondary: "#fb7185" },
  { id: "green",   name: "Green and orange",   primary: "#15803d", secondary: "#f97316" },
  { id: "red",     name: "Red and teal",       primary: "#b91c1c", secondary: "#14b8a6" },
  { id: "orange",  name: "Orange and blue",    primary: "#c2410c", secondary: "#2563eb" },
  { id: "violet",  name: "Violet and gold",    primary: "#6d28d9", secondary: "#eab308" },
  { id: "magenta", name: "Magenta and teal",   primary: "#be185d", secondary: "#14b8a6" },
];

/** The side menu as saved: "deep" unless someone chose light. */
export const sideOf = (p: Palette): "deep" | "light" => (p.side === "light" ? "light" : "deep");

/** The color the side menu's deep shade comes from: its own, or the brand. */
export const deepOf = (p: Palette): string => (p.deep && isHex(p.deep) && isColorful(p.deep) ? p.deep : p.primary);

/** Every CSS variable the colors set, worked out once (also saved so the
 *  next page load paints them before React starts). */
export function themeVars(mode: ThemeMode, p: Palette): Record<string, string> {
  const sc = signalScale(p.primary);
  const acc = accentFor(p.primary, p.secondary);
  const n = tintedNeutrals(p.primary, mode);
  const v: Record<string, string> = {};
  // Greys with a breath of the brand (the page, sheets, hairlines, and a
  // field's resting edge at 3:1).
  v["--color-canvas"] = n.canvas; v["--color-surface"] = n.surface; v["--color-surface-2"] = n.surface2;
  v["--color-border"] = n.border; v["--color-border-strong"] = n.borderStrong; v["--color-border-control"] = n.borderControl;
  // Kept for older code: the page color (no header band any more).
  v["--color-band"] = n.canvas;
  // The brand at full strength (charts, progress).
  v["--color-main"] = sc[600];
  v["--color-main-hover"] = sc[700];
  // The brand's readable shade: links, the current tab and the menu
  // marker, the focus ring.
  v["--color-accent-text"] = mode === "dark" ? sc[300] : sc[700];
  v["--color-current"] = mode === "dark" ? sc[400] : sc[600];
  v["--color-focus"] = mode === "dark" ? sc[400] : sc[600];
  v["--color-accent-ring"] = mode === "dark" ? sc[400] : sc[600];
  if (mode === "light") v["--color-accent-soft"] = sc[100];         // "you are here" tints
  // Action: the one filled button per screen.
  v["--color-accent"] = acc.fill;
  v["--color-accent-hover"] = acc.hover;
  v["--color-accent-fg"] = acc.fg;
  v["--color-accent-2"] = acc.fill;
  v["--color-accent-2-hover"] = acc.hover;
  v["--color-accent-2-fg"] = acc.fg;
  v["--color-accent-2-soft"] = mode === "light" ? sc[50] : mix(sc[900], n.surface, 0.6);
  v["--brand-gradient"] = `linear-gradient(135deg, ${sc[600]}, ${sc[600]})`;
  v["--charcoal-accent-text"] = sc[300];
  // Charts: the brand first, the accent's hue next.
  v["--viz-cat-1"] = mode === "dark" ? sc[400] : sc[600];
  v["--viz-cat-2"] = chartColor(acc.fill);
  // Side menu: the deep shade (default), or light. The deep shade comes
  // from its own color when one is set; the app still sets its lightness.
  // Its current item takes the white of the top bar and the page header
  // beside it, and joins them (on a light menu, which is that white
  // itself, it takes the page color so it still shows).
  const current = { "--side-current": sideOf(p) === "deep" ? n.surface : n.canvas, "--side-current-text": mode === "dark" ? "#e8ebf0" : "#1f2733" };
  if (sideOf(p) === "deep") {
    const deep = deepFor(deepOf(p), mode);
    const [dl, , dh] = toOklch(deep);
    Object.assign(v, {
      "--side-bg": deep, "--side-surface": fromOklch(dl + 0.06, 0.04, dh), "--side-text": "#ffffff",
      "--side-muted": "rgb(255 255 255 / 0.78)", "--side-faint": "rgb(255 255 255 / 0.6)",
      "--side-border": "rgb(255 255 255 / 0.12)", "--side-border-strong": "rgb(255 255 255 / 0.22)",
      // The logo's white plate, and a quiet gray for anything drawn on it
      // (the workspace menu's arrow).
      "--side-accent-text": sc[200], "--side-logo-plate": "#ffffff", "--side-logo-ink": "#5b6675", "--side-glow": sc[400], ...current,
    });
  } else {
    Object.assign(v, {
      "--side-bg": mode === "dark" ? n.surface : "#ffffff", "--side-surface": n.surface2, "--side-text": mode === "dark" ? "#e8ebf0" : "#1f2733",
      "--side-muted": mode === "dark" ? "#a9b2bf" : "#4f5b6b", "--side-faint": mode === "dark" ? "#8a94a3" : "#677283",
      "--side-border": n.border, "--side-border-strong": n.borderStrong,
      "--side-accent-text": mode === "dark" ? sc[300] : sc[700], "--side-logo-plate": "transparent", "--side-logo-ink": mode === "dark" ? "#a9b2bf" : "#4f5b6b", "--side-glow": "transparent", ...current,
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
  // (--color-heading was set by older versions: headings are text now.)
  for (const k of ["--color-accent-soft", "--viz-cat-2", "--color-ink-text", "--color-ink-muted", "--side-accent-soft", "--color-canvas", "--color-surface", "--color-surface-2", "--color-border", "--color-border-strong", "--color-heading"]) root.style.removeProperty(k);
  const vars = themeVars(mode, p);
  for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
  try { localStorage.setItem(LS_VARS, JSON.stringify(vars)); } catch { /* noop */ }

  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement("meta"); meta.setAttribute("name", "theme-color"); document.head.appendChild(meta); }
  // The phone's browser bar matches the top bar under it (the white
  // surface), not a brand color.
  meta.setAttribute("content", vars["--color-surface"]);
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
      if (o && isHex(o.primary)) return { id: o.id ?? "custom", name: o.name ?? "Custom", primary: o.primary, secondary: isHex(o.secondary ?? "") ? o.secondary : o.primary, ...(isHex(o.deep ?? "") ? { deep: o.deep } : {}), ...(o.side === "light" ? { side: "light" as const } : {}) };
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
    () => ({ mode, palette: effective, accent: accentFor(effective.primary, effective.secondary).fill, paletteLocked: !!orgPalette, setMode, toggleMode, setPalette, setAccent, applyOrgPalette }),
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
