"use client";

// PathBar — the folder-path breadcrumb for a library page. Each segment is
// a chip carrying the node's OWN icon and color, so the path reads the way
// the folders look everywhere else. Deep paths collapse their middle into a
// "…" menu instead of squeezing every segment illegible. Theme-var colors
// throughout — the bar this replaces hardcoded slate tones that broke dark
// mode.

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
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

export default function PathBar({ library, segments, onNavigate, onDropItems, onDark = false, home }: {
  library: { name: string; icon?: string | null; color?: string | null };
  /** Ancestors first, CURRENT node last. Empty = at the library root. */
  segments: PathSegment[];
  onNavigate: (folderId: string | null) => void;
  /** Dropping dragged folder/document(s) onto a crumb moves them THERE —
   *  which is how "move up a level" and "move to root" work without a
   *  dialog, the way every desktop file manager does it. */
  onDropItems?: (targetId: string | null, payload: { folderId?: string; docIds?: string[] }) => void;
  /** On the page's dark band: small all-caps crumbs, no colored tiles. */
  onDark?: boolean;
  /** A first crumb above the library (e.g. Document control → /documents). */
  home?: { label: string; href: string };
}) {
  // The fold menu is placed FIXED from its button: on the band the path sits
  // in a clipped one-line label, where an absolute menu would be cut off.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const menuOpen = !!menuAt;
  const setMenuOpen = (v: boolean) => { if (!v) setMenuAt(null); };
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuAt(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuAt(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [menuOpen]);

  const sep = onDark
    ? <span aria-hidden="true" className="mx-1.5 shrink-0 opacity-60">/</span>
    : <ChevronRight className="w-3 h-3 text-[var(--color-text-faint)] mx-0.5 shrink-0" />;

  const atRoot = segments.length === 0;
  const current = segments[segments.length - 1];
  const ancestors = segments.slice(0, -1);
  // Keep the nearest parent visible; older ancestors fold into "…".
  const visibleAncestors = ancestors.length > 1 ? ancestors.slice(-1) : ancestors;
  const hidden = ancestors.slice(0, ancestors.length - visibleAncestors.length);

  const chip = onDark
    ? "flex items-center gap-1.5 py-1 rounded-md transition-colors shrink-0 hover:text-[var(--color-text)] hover:underline underline-offset-4"
    : "flex items-center gap-1.5 px-1.5 py-1 rounded-lg transition-colors shrink-0 " +
      "hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]";

  const [dropOn, setDropOn] = useState<string | "root" | null>(null);
  const acceptsDrag = (e: React.DragEvent) =>
    !!onDropItems && (e.dataTransfer.types.includes("application/x-folder-id")
      || e.dataTransfer.types.includes("application/x-doc-ids"));
  const dropProps = (targetId: string | null, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!acceptsDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropOn(key);
    },
    onDragLeave: () => setDropOn((cur) => (cur === key ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      if (!acceptsDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropOn(null);
      const folderId = e.dataTransfer.getData("application/x-folder-id") || undefined;
      const raw = e.dataTransfer.getData("application/x-doc-ids");
      let docIds: string[] | undefined;
      try { docIds = raw ? (JSON.parse(raw) as string[]) : undefined; } catch { docIds = undefined; }
      if (folderId || (docIds && docIds.length > 0)) onDropItems!(targetId, { folderId, docIds });
    },
  });
  const dropRing = (key: string) =>
    dropOn !== key ? ""
    : onDark ? " px-1.5 bg-[var(--color-surface)] ring-2 ring-[var(--color-border-strong)] text-[var(--color-text)]"
    : " bg-[var(--color-surface-2)] dark:bg-[var(--color-surface-2)] ring-2 ring-[var(--color-border-strong)] text-[var(--color-text)]";
  const here = onDark ? "text-[var(--color-text)]" : "text-[var(--color-text)] font-medium";

  return (
    <nav className={`flex items-center min-w-0 overflow-hidden ${onDark ? "text-body font-medium text-[var(--color-text-muted)]" : "text-body font-medium text-[var(--color-text-muted)]"}`} aria-label="Folder path">
      {home && (
        <>
          <Link href={home.href} className={`${chip} max-sm:hidden`}>{home.label}</Link>
          <span className="max-sm:hidden contents">{sep}</span>
        </>
      )}
      {/* Library root */}
      <button
        onClick={() => onNavigate(null)}
        {...dropProps(null, "root")}
        className={`${chip} ${atRoot ? here : ""}${dropRing("root")}`}
        title={library.name}
        aria-current={atRoot ? "page" : undefined}
      >
        {!onDark && (library.color || library.icon
          ? <Tile icon={library.icon} color={library.color} />
          : <Home className="w-3.5 h-3.5 shrink-0" />)}
        <span className="truncate max-w-[10rem]">{library.name}</span>
      </button>

      {/* Folded ancestors */}
      {hidden.length > 0 && (
        <>
          {sep}
          <div className="relative shrink-0" ref={menuRef}>
            <button
              onClick={(e) => {
                if (menuOpen) { setMenuOpen(false); return; }
                const r = e.currentTarget.getBoundingClientRect();
                setMenuAt({ x: Math.max(8, Math.min(r.left, window.innerWidth - 264)), y: r.bottom + 4 });
              }}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`${hidden.length} more level${hidden.length === 1 ? "" : "s"}`}
              className={`${chip} ${menuOpen ? (onDark ? "text-white" : "bg-[var(--color-surface-2)] text-[var(--color-text)]") : ""}`}
              title={`${hidden.length} more level${hidden.length === 1 ? "" : "s"}`}
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
              <ChevronDown className="w-2.5 h-2.5 -ml-0.5" />
            </button>
            {menuAt && (
              <div role="menu" style={{ left: menuAt.x, top: menuAt.y }} className="fixed z-[70] min-w-44 max-w-64 py-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg ring-1 ring-black/5 normal-case tracking-normal animate-in fade-in zoom-in-95 duration-150 origin-top-left">
                {hidden.map((seg, i) => (
                  <button
                    key={seg.id}
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); onNavigate(seg.id); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
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
          {sep}
          <button onClick={() => onNavigate(seg.id)} {...dropProps(seg.id, seg.id)}
            className={`${chip} min-w-0${dropRing(seg.id)}`} title={seg.name}>
            {!onDark && <Tile icon={seg.icon} color={seg.color} />}
            <span className="truncate max-w-[9rem]">{seg.name}</span>
          </button>
        </React.Fragment>
      ))}

      {/* Current folder */}
      {current && (
        <>
          {sep}
          <span aria-current="page" className={`flex items-center gap-1.5 py-1 min-w-0 ${onDark ? "text-white" : "px-1.5 font-medium text-[var(--color-text)]"}`} title={current.name}>
            {!onDark && <Tile icon={current.icon} color={current.color} />}
            <span className="truncate">{current.name}</span>
          </span>
        </>
      )}
    </nav>
  );
}
