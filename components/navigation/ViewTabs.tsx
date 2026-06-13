"use client";

// ViewTabs — the shared "switch the lens" strip used by every consolidated
// tool. Instead of separate pages that re-present the same records, a tool
// (Documents, Equipment, Home, Activity) is one concept with several views;
// this strip is how you flip between them. One component so every consolidated
// tool looks and behaves identically.

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface ViewTab {
  label: string;
  href: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Optional count badge. */
  badge?: number;
  /** Match the active state by exact path or by prefix (default: prefix). */
  exact?: boolean;
}

export default function ViewTabs({
  title,
  tabs,
  variant = "light",
  right,
}: {
  /** The tool name shown to the left of the views, e.g. "Documents". */
  title?: string;
  tabs: ViewTab[];
  variant?: "light" | "dark";
  /** Optional right-aligned content (e.g. a scope toggle). */
  right?: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const isActive = (t: ViewTab) =>
    t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(t.href + "/") || pathname.startsWith(t.href + "?");

  const dark = variant === "dark";
  return (
    <div className={`flex items-center gap-3 flex-wrap mb-4 ${dark ? "" : ""}`}>
      {title && (
        <span className={`text-xs font-black uppercase tracking-wider ${dark ? "text-[var(--color-text-muted)]" : "text-[var(--color-text-faint)]"}`}>{title}</span>
      )}
      <div className={`inline-flex items-center gap-1 p-1 rounded-xl ${dark ? "bg-slate-900 border border-slate-800" : "bg-[var(--color-surface-2)] border border-[var(--color-border)]"}`}>
        {tabs.map((t) => {
          const active = isActive(t);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-bold transition-colors ${
                active
                  ? (dark ? "bg-slate-700 text-white shadow" : "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm")
                  : (dark ? "text-[var(--color-text-faint)] hover:text-slate-200" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]")
              }`}
            >
              {Icon && <Icon className="w-3.5 h-3.5" />}
              {t.label}
              {typeof t.badge === "number" && t.badge > 0 && (
                <span className={`ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[10px] font-black ${active ? "bg-[var(--color-accent)] text-white" : (dark ? "bg-slate-700 text-slate-200" : "bg-[var(--color-border)] text-[var(--color-text-muted)]")}`}>
                  {t.badge > 99 ? "99+" : t.badge}
                </span>
              )}
            </Link>
          );
        })}
      </div>
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

// ─── Tab presets for each consolidated tool ──────────────────────

import { LayoutGrid, Table, Lock, AlertOctagon, Map as MapIcon, List, Activity as ActivityIcon, ScrollText, Inbox as InboxIcon, Network, Send } from "lucide-react";

export const DOCUMENT_VIEWS: ViewTab[] = [
  { label: "Table", href: "/documents", icon: Table },
  { label: "Board", href: "/control-tower", icon: LayoutGrid },
  { label: "Locks", href: "/checkouts", icon: Lock },
  { label: "Blocked", href: "/admin/holds", icon: AlertOctagon },
  { label: "Transmittals", href: "/transmittals", icon: Send },
];

export const EQUIPMENT_VIEWS: ViewTab[] = [
  { label: "Table", href: "/admin/assets", icon: List },
  { label: "Map", href: "/plot-plans", icon: MapIcon },
];

export const HOME_VIEWS: ViewTab[] = [
  { label: "My Inbox", href: "/inbox", icon: InboxIcon },
  { label: "Coordination", href: "/coordination", icon: Network },
];

export const ACTIVITY_VIEWS: ViewTab[] = [
  { label: "Activity", href: "/activity", icon: ActivityIcon },
  { label: "Audit log", href: "/admin/audit", icon: ScrollText },
];
