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
import { rolesOf, bandFor, sideTokens, buttonText, mix, luminance, actionText, DEFAULT_ROLES } from "@/lib/themeRoles";

export type ThemeMode = "light" | "dark";

/** A workspace's colors in three roles (see lib/themeRoles): `base` the
 *  side menu, `primary` the main color (the page band), `accent` the action
 *  color kept small (buttons, links). `secondary` is kept for palettes
 *  saved by older versions. */
export interface Palette { id: string; name: string; primary: string; secondary: string; base?: string; accent?: string }

// A pair that sets the mood plus one action color that stands out. [0] is
// the default: charcoal and royal blue, with the brand orange on buttons.
export const PALETTE_PRESETS: Palette[] = [
  { id: "royal",    name: "Charcoal, royal blue, orange", base: "#11141a", primary: "#1c3fbd", accent: "#ea580c", secondary: "#ea580c" },
  { id: "jade",     name: "Midnight, jade, pink",         base: "#0f1b2d", primary: "#0f766e", accent: "#db2777", secondary: "#db2777" },
  { id: "violet",   name: "White, violet, pink",          base: "#f6f5f2", primary: "#5b21b6", accent: "#db2777", secondary: "#db2777" },
  { id: "steel",    name: "Navy, steel blue, safety yellow", base: "#0b1526", primary: "#2f4a6d", accent: "#eab308", secondary: "#eab308" },
  { id: "forest",   name: "Graphite, forest green, orange", base: "#1c1f23", primary: "#166534", accent: "#f97316", secondary: "#f97316" },
  { id: "teal",     name: "Ink, teal, coral",             base: "#111827", primary: "#115e59", accent: "#e11d48", secondary: "#e11d48" },
];

interface ThemeCtx {
  mode: ThemeMode;
  palette: Palette;
  accent: string;                 // the action color (buttons, links)
  /** True when the active palette is enforced by the organization. */
  paletteLocked: boolean;
  setMode: (m: ThemeMode) => void;
  toggleMode: () => void;
  setPalette: (p: Palette) => void;
  /** Set just the primary; keeps current secondary. */
  setAccent: (hex: string) => void;
  /** Apply an org-enforced palette (overrides personal; not persisted to
   *  this device). Pass null to fall back to the personal palette. */
  applyOrgPalette: (p: Palette | null) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const LS_MODE = "mfgos.theme.mode";
const LS_PALETTE = "mfgos.theme.palette";   // JSON {primary,secondary}
const LS_ACCENT = "mfgos.theme.accent";     // legacy single hex

const isHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);

function applyTheme(mode: ThemeMode, p: Palette) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  const r = rolesOf(p);

  // The pair: the band (main color) and the side menu (base).
  const band = bandFor(mode, r.main);
  set("--color-band", band);
  // Softer white for the line and labels on the band, tinted by the band.
  set("--color-ink-text", mix("#ffffff", band, 0.16));
  set("--color-ink-muted", mix("#ffffff", band, 0.28));
  const side = sideTokens(mode === "dark" && luminance(r.base) >= 0.35 ? mix(r.base, "#000000", 0.85) : r.base);
  set("--side-bg", side.bg); set("--side-surface", side.surface); set("--side-text", side.text);
  set("--side-muted", side.muted); set("--side-faint", side.faint);
  set("--side-border", side.border); set("--side-border-strong", side.borderStrong);
  // The menu's "you are here" sits on the band color; on a light menu it
  // needs white text, which the band always carries.

  // The third: the action color, small and only on what you tap.
  set("--color-accent", r.action);
  set("--color-accent-text", actionText(mode, r.action));
  set("--color-accent-hover", mix(r.action, "#000000", 0.15));
  set("--color-accent-fg", buttonText(r.action));
  set("--color-accent-ring", mix(r.action, "#ffffff", 0.35));
  set("--color-accent-2", r.action);
  set("--color-accent-2-hover", mix(r.action, "#000000", 0.15));
  set("--color-accent-2-fg", buttonText(r.action));
  // Folder and cover fills that used the brand gradient: the main color, flat.
  set("--brand-gradient", `linear-gradient(135deg, ${r.main}, ${r.main})`);

  if (mode === "light") {
    set("--color-accent-soft", mix(r.action, "#ffffff", 0.88));
    set("--color-accent-2-soft", mix(r.action, "#ffffff", 0.88));
  } else {
    root.style.removeProperty("--color-accent-soft"); // computed in .dark rule
    set("--color-accent-2-soft", mix(r.action, "#0b1120", 0.78));
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
      if (o && isHex(o.primary) && isHex(o.secondary)) return { id: o.id ?? "custom", name: o.name ?? "Custom", primary: o.primary, secondary: o.secondary, ...(isHex(o.base ?? "") ? { base: o.base } : {}), ...(isHex(o.accent ?? "") ? { accent: o.accent } : {}) };
    }
    // migrate a legacy single accent → palette (primary + derived secondary)
    const legacy = localStorage.getItem(LS_ACCENT);
    // An older single color was the button color: keep it as the action color.
    if (legacy && isHex(legacy)) return { id: "custom", name: "Custom", base: DEFAULT_ROLES.base, primary: DEFAULT_ROLES.main, accent: legacy, secondary: legacy };
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
    setPaletteState((prev) => { const r = rolesOf(prev); const p = { ...prev, id: "custom", name: "Custom", base: r.base, primary: r.main, accent: hex, secondary: hex }; persistPalette(p); return p; });
  }, []);
  const applyOrgPalette = useCallback((p: Palette | null) => { setOrgPalette(p); }, []);

  const value = useMemo(
    () => ({ mode, palette: effective, accent: rolesOf(effective).action, paletteLocked: !!orgPalette, setMode, toggleMode, setPalette, setAccent, applyOrgPalette }),
    [mode, effective, orgPalette, setMode, toggleMode, setPalette, setAccent, applyOrgPalette],
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
  var pal=localStorage.getItem('${LS_PALETTE}'); var H=/^#[0-9a-fA-F]{6}$/; var st=document.documentElement.style;
  if(pal){try{var o=JSON.parse(pal); if(o&&H.test(o.primary)&&H.test(o.accent)){st.setProperty('--color-band',o.primary);st.setProperty('--color-accent',o.accent);if(H.test(o.base)){st.setProperty('--side-bg',o.base);}}}catch(e){}}
}catch(e){}})();`;
