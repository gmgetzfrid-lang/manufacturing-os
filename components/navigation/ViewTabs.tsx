"use client";

// ViewTabs — the shared "switch the lens" strip used by every consolidated
// tool. Instead of separate pages that re-present the same records, a tool
// (Documents, Equipment, Home, Activity) is one concept with several views;
// this strip is how you flip between them. One component so every consolidated
// tool looks and behaves identically.

import React from "react";
import { badgeText } from "@/lib/badge";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export interface ViewTab {
  label: string;
  href: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Optional count badge. */
  badge?: number;
  /** Match the active state by exact path or by prefix (default: prefix). */
  exact?: boolean;
  /** Prefixes that must NOT count as this tab, for a sibling tab nested under it. */
  exclude?: string[];
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
  const router = useRouter();
  // The Graph opens on the library and folder you were in, not the whole
  // estate (it has a way back up to everything). The folder is read from
  // the address at the moment of the tap.
  const libMatch = /^\/documents\/([0-9a-f-]{36})/.exec(pathname);
  const hrefFor = (href: string) => href === "/documents/graph" && libMatch ? `/documents/graph?focus=${encodeURIComponent(`lib:${libMatch[1]}`)}` : href;
  const openGraphHere = (e: React.MouseEvent, href: string) => {
    if (href !== "/documents/graph" || !libMatch || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const folderId = new URLSearchParams(window.location.search).get("folderId");
    if (!folderId) return;
    e.preventDefault();
    router.push(`/documents/graph?focus=${encodeURIComponent(`folder:${folderId}`)}`);
  };
  const isActive = (t: ViewTab) => {
    if (t.exclude?.some((x) => pathname === x || pathname.startsWith(x + "/"))) return false;
    return t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(t.href + "/") || pathname.startsWith(t.href + "?");
  };

  // The header is on the light panel now: both variants draw the same.
  void variant;
  const dark = false;
  // On a phone the views don't all fit: the strip scrolls on its own (never
  // the page), with the one you're on brought into sight.
  const strip = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = strip.current, on = el?.querySelector<HTMLElement>("[aria-current=page]");
    if (!el || !on || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = Math.max(0, on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2);
  }, [pathname]);
  return (
    <div className={`flex items-center gap-3 flex-wrap min-w-0 max-w-full ${dark ? "" : "mb-4"}`}>
      {title && (
        <span className={`text-[14px] font-medium ${dark ? "text-[var(--color-ink-muted)]" : "text-[var(--color-text-muted)]"}`}>{title}</span>
      )}
      <div ref={strip} className={`inline-flex items-center gap-0.5 p-0.5 rounded-md min-w-0 max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${dark ? "bg-[var(--color-ink-2)] border border-[var(--color-ink-line)]" : "bg-[var(--color-surface-2)] border border-[var(--color-border-strong)]"}`}>
        {tabs.map((t) => {
          const active = isActive(t);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={hrefFor(t.href)}
              onClick={(e) => openGraphHere(e, t.href)}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-bold transition-colors ${
                active
                  ? (dark ? "bg-white text-[var(--color-ink)] shadow-sm" : "bg-[var(--color-surface)] text-[var(--color-text)] shadow-[0_1px_2px_rgb(31_39_51/0.15)] ring-1 ring-[var(--color-border-strong)]")
                  : (dark ? "text-[var(--color-ink-muted)] hover:text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]")
              }`}
            >
              {Icon && <Icon className="w-3.5 h-3.5" />}
              {t.label}
              {typeof t.badge === "number" && t.badge > 0 && (
                <span className={`ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[11px] font-black ${active ? (dark ? "bg-[var(--color-ink)] text-white" : "bg-[var(--color-text)] text-[var(--color-surface)]") : (dark ? "bg-[var(--color-ink-line)] text-[var(--color-ink-fg)]" : "bg-[var(--color-border)] text-[var(--color-text-muted)]")}`}>
                  {badgeText(t.badge)}
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

import { Table, Lock, AlertOctagon, Map as MapIcon, List, Activity as ActivityIcon, ScrollText, Inbox as InboxIcon, Network, Send, Package, ClipboardList, Gauge, Bot, BookOpen, Waypoints, GitPullRequest, Settings2, Puzzle, Unplug } from "lucide-react";

export const DOCUMENT_VIEWS: ViewTab[] = [
  { label: "Table", href: "/documents", icon: Table, exclude: ["/documents/graph", "/documents/connectors"] },
  { label: "Graph", href: "/documents/graph", icon: Waypoints },
  { label: "Connector checks", href: "/documents/connectors", icon: Unplug },
  { label: "Register", href: "/register", icon: ClipboardList },
  { label: "Checkouts", href: "/checkouts", icon: Lock },
  { label: "Packages", href: "/packages", icon: Package },
  { label: "Holds", href: "/admin/holds", icon: AlertOctagon },
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

// Everything AI lives here. The sidebar's "Intelligence" opens the chat
// itself (Ask); these tabs are the rest of it, the status board last.
export const INTELLIGENCE_VIEWS: ViewTab[] = [
  { label: "Ask", href: "/assistant", icon: Bot },
  { label: "Knowledge", href: "/knowledge", icon: BookOpen },
  { label: "Graph", href: "/graph", icon: Waypoints },
  { label: "Review", href: "/admin/proposed-links", icon: GitPullRequest },
  { label: "Skills", href: "/intelligence/skills", icon: Puzzle },
  { label: "Status", href: "/intelligence", icon: Gauge, exact: true },
  { label: "Setup", href: "/intelligence/setup", icon: Settings2 },
];
