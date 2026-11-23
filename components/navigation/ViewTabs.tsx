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
import { useRole } from "@/components/providers/RoleContext";
import { useStagedDocs } from "@/lib/stagedDocs";
import { onTransitionClick, transitionPush } from "@/lib/viewTransition";

export interface ViewTab {
  label: string;
  href: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Optional count badge. */
  badge?: number;
  /** A count read live on this device: "staged" is how many documents
   *  this person has staged in this workspace. */
  liveCount?: "staged";
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
  hrefs,
}: {
  /** The tool name shown to the left of the views, e.g. "Documents". */
  title?: string;
  tabs: ViewTab[];
  variant?: "light" | "dark";
  /** Optional right-aligned content (e.g. a scope toggle). */
  right?: React.ReactNode;
  /** Where a tab goes from this page, by its usual href: the library page
   *  sends Graph to the folder you are in, the graph sends Table back to
   *  the folder it shows. */
  hrefs?: Partial<Record<string, string>>;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { activeOrgId, uid } = useRole();
  const staged = useStagedDocs(activeOrgId, uid);
  const badgeOf = (t: ViewTab) => (t.liveCount === "staged" ? staged.count : t.badge);
  // The Graph opens on the library and folder you were in, not the whole
  // estate (it has a way back up to everything). A page that knows where
  // it is says so (`hrefs`); otherwise the folder is read from the address
  // at the moment of the tap.
  const libMatch = /^\/documents\/([0-9a-f-]{36})/.exec(pathname);
  const hrefFor = (href: string) => hrefs?.[href] ?? (href === "/documents/graph" && libMatch ? `/documents/graph?focus=${encodeURIComponent(`lib:${libMatch[1]}`)}` : href);
  const openGraphHere = (e: React.MouseEvent, href: string): boolean => {
    if (hrefs?.[href] || href !== "/documents/graph" || !libMatch || e.metaKey || e.ctrlKey || e.shiftKey) return false;
    const folderId = new URLSearchParams(window.location.search).get("folderId");
    if (!folderId) return false;
    e.preventDefault();
    transitionPush(router, `/documents/graph?focus=${encodeURIComponent(`folder:${folderId}`)}`);
    return true;
  };
  const isActive = (t: ViewTab) => {
    if (t.exclude?.some((x) => pathname === x || pathname.startsWith(x + "/"))) return false;
    return t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(t.href + "/") || pathname.startsWith(t.href + "?");
  };

  // The header is on the light panel now: both variants draw the same.
  void variant;
  // On a phone the views don't all fit: the strip scrolls on its own (never
  // the page), with the one you're on brought into sight.
  const strip = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const el = strip.current, on = el?.querySelector<HTMLElement>("[aria-current=page]");
    if (!el || !on || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = Math.max(0, on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2);
  }, [pathname]);
  // Underline tabs: the one you're on is text color with a brand line
  // under it; the rest are muted. A count is plain muted figures after the
  // label. Switching views cross-fades where the browser can.
  return (
    <div className="flex items-end gap-x-4 gap-y-2 flex-wrap min-w-0 max-w-full mb-4 border-b border-[var(--color-border)]">
      {title && (
        <span className="self-center text-[14px] text-[var(--color-text-muted)]">{title}</span>
      )}
      <nav aria-label={title ? `${title} views` : "Views"} ref={strip} className="-mb-px flex items-end gap-5 min-w-0 max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const active = isActive(t);
          const badge = badgeOf(t);
          return (
            <Link
              key={t.href}
              href={hrefFor(t.href)}
              onClick={(e) => {
                if (openGraphHere(e, t.href) || active) return;
                onTransitionClick(e, () => router.push(hrefFor(t.href)));
              }}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 border-b-2 text-[14px] transition-colors ${
                active
                  ? "border-[var(--color-current)] text-[var(--color-text)] font-semibold"
                  : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]"
              }`}
            >
              {t.label}
              {typeof badge === "number" && badge > 0 && (
                <span className="text-[13px] font-normal tabular-nums text-[var(--color-text-muted)]">{badgeText(badge)}</span>
              )}
            </Link>
          );
        })}
      </nav>
      {right && <div className="ml-auto self-center pb-1.5">{right}</div>}
    </div>
  );
}

// ─── Tab presets for each consolidated tool ──────────────────────

import { Table, Lock, AlertOctagon, Map as MapIcon, List, Activity as ActivityIcon, ScrollText, Inbox as InboxIcon, Network, Send, Package, ClipboardList, Gauge, Bot, BookOpen, Waypoints, GitPullRequest, Settings2, Puzzle, Unplug, Layers } from "lucide-react";

export const DOCUMENT_VIEWS: ViewTab[] = [
  { label: "Table", href: "/documents", icon: Table, exclude: ["/documents/graph", "/documents/connectors", "/documents/staged"] },
  // The documents you staged, from any folder or library: view them side by
  // side, mark them up, send them. The count is how many are staged.
  { label: "Staged", href: "/documents/staged", icon: Layers, liveCount: "staged" },
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
