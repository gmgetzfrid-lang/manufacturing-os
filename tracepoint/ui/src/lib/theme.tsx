// Light/dark mode and brand palette, adapted from Manufacturing OS's
// ThemeProvider: a palette is a coordinated pair from which hover, soft and
// ring tones are derived, so the whole interface moves together.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Mode = "light" | "dark";
export interface Palette { id: string; name: string; primary: string; secondary: string }

export const PALETTES: Palette[] = [
  { id: "tracepoint", name: "TracePoint Red", primary: "#dc2626", secondary: "#f97316" },
  { id: "industrial", name: "Industrial Orange", primary: "#ea580c", secondary: "#f59e0b" },
  { id: "ocean", name: "Ocean", primary: "#2563eb", secondary: "#06b6d4" },
  { id: "indigo", name: "Indigo Nebula", primary: "#4f46e5", secondary: "#a855f7" },
  { id: "teal", name: "Lagoon", primary: "#0d9488", secondary: "#22c55e" },
  { id: "graphite", name: "Graphite", primary: "#475569", secondary: "#0ea5e9" },
];

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
  const c = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${c(r1 + (r2 - r1) * t)}${c(g1 + (g2 - g1) * t)}${c(b1 + (b2 - b1) * t)}`;
}
function fg(h: string): string {
  const [r, g, b] = hexToRgb(h);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? "#0f172a" : "#ffffff";
}

function apply(mode: Mode, p: Palette) {
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.style.setProperty("--color-accent", mode === "dark" ? mix(p.primary, "#ffffff", 0.08) : p.primary);
  root.style.setProperty("--color-accent-hover", mix(p.primary, "#000000", 0.15));
  root.style.setProperty("--color-accent-fg", fg(p.primary));
  root.style.setProperty("--color-accent-ring", mix(p.primary, "#ffffff", 0.35));
  root.style.setProperty("--color-accent-2", p.secondary);
  root.style.setProperty("--brand-gradient", `linear-gradient(135deg, ${p.primary}, ${p.secondary})`);
  if (mode === "light") {
    root.style.setProperty("--color-accent-soft", mix(p.primary, "#ffffff", 0.9));
    root.style.setProperty("--color-accent-2-soft", mix(p.secondary, "#ffffff", 0.9));
  } else {
    root.style.removeProperty("--color-accent-soft");
    root.style.removeProperty("--color-accent-2-soft");
  }
}

interface Ctx { mode: Mode; palette: Palette; setMode: (m: Mode) => void; toggle: () => void; setPalette: (p: Palette) => void }
const ThemeCtx = createContext<Ctx | null>(null);

function initialMode(): Mode {
  try {
    const m = localStorage.getItem("tp.theme.mode");
    if (m === "light" || m === "dark") return m;
  } catch { /* ignore */ }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function initialPalette(): Palette {
  try {
    const id = localStorage.getItem("tp.theme.palette");
    return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
  } catch { return PALETTES[0]; }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(initialMode);
  const [palette, setPaletteState] = useState<Palette>(initialPalette);
  useEffect(() => apply(mode, palette), [mode, palette]);
  const setMode = useCallback((m: Mode) => { setModeState(m); try { localStorage.setItem("tp.theme.mode", m); } catch { /* */ } }, []);
  const setPalette = useCallback((p: Palette) => { setPaletteState(p); try { localStorage.setItem("tp.theme.palette", p.id); } catch { /* */ } }, []);
  const value = useMemo(() => ({ mode, palette, setMode, setPalette, toggle: () => setMode(mode === "dark" ? "light" : "dark") }), [mode, palette, setMode, setPalette]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Ctx {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error("useTheme outside ThemeProvider");
  return c;
}
