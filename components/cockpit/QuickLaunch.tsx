"use client";

// Quick-action launcher — the common "start something" entry points, so Home
// is a place you DO things from, not just a list that's sometimes empty.
//
// Extracted from the /inbox cockpit so the same launcher can be dropped onto
// the customizable dashboard as a widget.

import React from "react";
import Link from "next/link";
import { Send, Briefcase, Zap, Search, ChevronRight } from "lucide-react";

export const QUICK_ACTIONS: Array<{ label: string; sub: string; href?: string; icon: React.ComponentType<{ className?: string }>; tone: string; action?: "search" }> = [
  { label: "New request", sub: "Drafting or design", href: "/requests/new", icon: Send, tone: "text-[var(--color-text)] bg-[var(--color-surface-2)]" },
  { label: "Documents", sub: "Browse and check out", href: "/documents", icon: Briefcase, tone: "text-[var(--color-text)] bg-[var(--color-surface-2)]" },
  { label: "Coordination", sub: "Collisions and blockers", href: "/coordination", icon: Zap, tone: "text-[var(--color-text)] bg-[var(--color-surface-2)]" },
  { label: "Search", sub: "Everything, ⌘K", action: "search", icon: Search, tone: "text-[var(--color-text)] bg-[var(--color-surface-2)]" },
];

export function QuickLaunch() {
  const openSearch = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  return (
    // Four rows: spaced, not ruled.
    <ul className="py-1.5">
      {QUICK_ACTIONS.map((a) => {
        const inner = (
          <span className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors">
            {/* A plain muted icon, no tile: the words say what it is. */}
            <a.icon aria-hidden className="w-[18px] h-[18px] shrink-0 text-[var(--color-text-muted)]" />
            <span className="min-w-0 flex-1">
              <span className="block text-reading font-medium text-[var(--color-text)] truncate">{a.label}</span>
              <span className="block text-body text-[var(--color-text-muted)] truncate">{a.sub}</span>
            </span>
            <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
          </span>
        );
        return (
          <li key={a.label}>
            {a.href
              ? <Link href={a.href} className="block">{inner}</Link>
              : <button type="button" onClick={openSearch} className="text-left w-full block">{inner}</button>}
          </li>
        );
      })}
    </ul>
  );
}
