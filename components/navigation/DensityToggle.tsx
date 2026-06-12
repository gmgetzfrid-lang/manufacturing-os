"use client";

// DensityToggle — comfortable vs compact information density. Document
// controllers live in thousand-row grids; compact mode tightens row padding so
// far more fits on screen. Stored per-browser and applied as a data attribute
// on <html> so pure CSS does the work (see globals.css [data-density]).

import React from "react";
import { Rows3, Rows4 } from "lucide-react";

const KEY = "mfg-os.density";
type Density = "comfortable" | "compact";

function apply(d: Density) {
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-density", d);
}

export default function DensityToggle() {
  const [density, setDensity] = React.useState<Density>("comfortable");

  React.useEffect(() => {
    try {
      const saved = (localStorage.getItem(KEY) as Density | null) ?? "comfortable";
      setDensity(saved);
      apply(saved);
    } catch { /* ignore */ }
  }, []);

  const toggle = () => {
    const next: Density = density === "comfortable" ? "compact" : "comfortable";
    setDensity(next);
    apply(next);
    try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  };

  return (
    <button
      onClick={toggle}
      title={density === "comfortable" ? "Switch to compact density" : "Switch to comfortable density"}
      aria-label="Toggle density"
      className="w-9 h-9 inline-flex items-center justify-center rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
    >
      {density === "comfortable" ? <Rows3 className="w-4 h-4" /> : <Rows4 className="w-4 h-4" />}
    </button>
  );
}
