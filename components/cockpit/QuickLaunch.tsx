"use client";

// Quick-action launcher — the common "start something" entry points, so Home
// is a place you DO things from, not just a list that's sometimes empty.
//
// Extracted from the /inbox cockpit so the same launcher can be dropped onto
// the customizable dashboard as a widget.

import React from "react";
import Link from "next/link";
import { Send, Briefcase, StickyNote, Zap, RefreshCw, ArrowRight } from "lucide-react";

export const QUICK_ACTIONS: Array<{ label: string; sub: string; href?: string; icon: React.ComponentType<{ className?: string }>; tone: string; action?: "search" }> = [
  { label: "New request", sub: "Drafting / design", href: "/requests/new", icon: Send, tone: "text-[var(--color-accent)] bg-orange-50" },
  { label: "Documents", sub: "Browse & check out", href: "/documents", icon: Briefcase, tone: "text-blue-600 bg-blue-50" },
  { label: "Scratchpad", sub: "Jot · ask · it reminds you", href: "/scratchpad", icon: StickyNote, tone: "text-amber-600 bg-amber-50" },
  { label: "Coordination", sub: "Collisions & blockers", href: "/coordination", icon: Zap, tone: "text-rose-600 bg-rose-50" },
  { label: "Search", sub: "⌘K everything", action: "search", icon: RefreshCw, tone: "text-[var(--color-text-faint)] bg-[var(--color-surface-2)]" },
];

export function QuickLaunch() {
  const openSearch = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <Zap className="w-4 h-4 text-[var(--color-text-muted)]" />
        <span className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">Quick launch</span>
      </div>
      <div className="p-2">
        {QUICK_ACTIONS.map((a) => {
          const inner = (
            <div className="group flex items-center gap-3 rounded-xl p-2.5 hover:bg-[var(--color-canvas)] transition-colors">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${a.tone}`}><a.icon className="w-4 h-4" /></div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-[var(--color-text)] truncate">{a.label}</div>
                <div className="text-[11px] text-[var(--color-text-muted)] truncate">{a.sub}</div>
              </div>
              <ArrowRight className="w-4 h-4 text-[var(--color-text)] group-hover:text-[var(--color-text-muted)] group-hover:translate-x-0.5 transition-all shrink-0" />
            </div>
          );
          return a.href
            ? <Link key={a.label} href={a.href} className="block">{inner}</Link>
            : <button key={a.label} onClick={openSearch} className="text-left w-full block">{inner}</button>;
        })}
      </div>
    </div>
  );
}
