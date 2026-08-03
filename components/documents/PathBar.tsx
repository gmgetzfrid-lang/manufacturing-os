"use client";

// PathBar — the folder-path breadcrumb for a library page. Each segment is
// a chip carrying the node's OWN icon and color, so the path reads the way
// the folders look everywhere else. Deep paths collapse their middle into a
// "…" menu instead of squeezing every segment illegible. Theme-var colors
// throughout — the bar this replaces hardcoded slate tones that broke dark
// mode.

import React, { useEffect, useRef, useState } from "react";
import { ChevronRight, MoreHorizontal, Home, ChevronDown } from "lucide-react";
import { NodeIcon } from "@/lib/nodeIcons";

export interface PathSegment {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
}

/** The little colored tile that stands in for the node. */
function Tile({ icon, color, className = "w-4 h-4" }: {
  icon?: string | null; color?: string | null; className?: string;
}) {
  return (
    <span
      className={`${className} rounded grid place-items-center text-white shrink-0`}
      style={{ background: color || "var(--brand-gradient)" }}
    >
      <NodeIcon name={icon} className="w-2.5 h-2.5" />
    </span>
  );
}

const Sep = () => <ChevronRight className="w-3 h-3 text-[var(--color-text-faint)] mx-0.5 shrink-0" />;

export default function PathBar({ library, segments, onNavigate }: {
  library: { name: string; icon?: string | null; color?: string | null };
  /** Ancestors first, CURRENT node last. Empty = at the library root. */
  segments: PathSegment[];
  onNavigate: (folderId: string | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const atRoot = segments.length === 0;
  const current = segments[segments.length - 1];
  const ancestors = segments.slice(0, -1);
  // Keep the nearest parent visible; older ancestors fold into "…".
  const visibleAncestors = ancestors.length > 1 ? ancestors.slice(-1) : ancestors;
  const hidden = ancestors.slice(0, ancestors.length - visibleAncestors.length);

  const chip =
    "flex items-center gap-1.5 px-1.5 py-1 rounded-lg transition-colors shrink-0 " +
    "hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]";

  return (
    <nav className="flex items-center text-xs font-medium text-[var(--color-text-muted)] overflow-hidden min-w-0" aria-label="Folder path">
      {/* Library root */}
      <button
        onClick={() => onNavigate(null)}
        className={`${chip} ${atRoot ? "text-[var(--color-text)] font-bold" : ""}`}
        title={library.name}
      >
        {library.color || library.icon
          ? <Tile icon={library.icon} color={library.color} />
          : <Home className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate max-w-[10rem]">{library.name}</span>
      </button>

      {/* Folded ancestors */}
      {hidden.length > 0 && (
        <>
          <Sep />
          <div className="relative shrink-0" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className={`${chip} ${menuOpen ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : ""}`}
              title={`${hidden.length} more level${hidden.length === 1 ? "" : "s"}`}
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
              <ChevronDown className="w-2.5 h-2.5 -ml-0.5" />
            </button>
            {menuOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 min-w-44 max-w-64 py-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg ring-1 ring-black/5 animate-in fade-in zoom-in-95 duration-150 origin-top-left">
                {hidden.map((seg, i) => (
                  <button
                    key={seg.id}
                    onClick={() => { setMenuOpen(false); onNavigate(seg.id); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                    style={{ paddingLeft: `${12 + i * 10}px` }}
                  >
                    <Tile icon={seg.icon} color={seg.color} />
                    <span className="truncate">{seg.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Visible ancestors */}
      {visibleAncestors.map((seg) => (
        <React.Fragment key={seg.id}>
          <Sep />
          <button onClick={() => onNavigate(seg.id)} className={`${chip} min-w-0`} title={seg.name}>
            <Tile icon={seg.icon} color={seg.color} />
            <span className="truncate max-w-[9rem]">{seg.name}</span>
          </button>
        </React.Fragment>
      ))}

      {/* Current folder */}
      {current && (
        <>
          <Sep />
          <span className="flex items-center gap-1.5 px-1.5 py-1 font-bold text-[var(--color-text)] min-w-0" title={current.name}>
            <Tile icon={current.icon} color={current.color} />
            <span className="truncate">{current.name}</span>
          </span>
        </>
      )}
    </nav>
  );
}
