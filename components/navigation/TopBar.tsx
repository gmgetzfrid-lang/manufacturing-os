"use client";

// TopBar — header that sits above the main content area.
//
// Three regions:
//
//   [left]    Breadcrumb derived from the URL (Section / Subpage / Resource).
//             Clickable up the chain. The current segment is plain text.
//   [center]  Empty for now — a future global search input drops in here.
//   [right]   ⌘K trigger pill + notification bell + page-context divider.
//
// Designed to feel like a real product chrome, not a skeleton. Subtle
// gradient, a tiny status dot, refined typography. Sits sticky-flush
// with the sidebar's brand row to give one continuous top edge.

import React, { useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Search, Command } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import NotificationBell from "@/components/notifications/NotificationBell";

interface Crumb {
  label: string;
  href?: string;
}

// Map first-segment paths to a friendlier section label.
const SECTION_LABEL: Record<string, string> = {
  inbox: "Inbox",
  scratchpad: "Scratchpad",
  documents: "Document Control",
  checkouts: "Active Checkouts",
  projects: "Projects",
  requests: "Drafting Requests",
  activity: "Activity",
  profile: "Profile",
  settings: "Settings",
  admin: "Admin",
  share: "Shared Link",
  search: "Search",
  dashboard: "Dashboard",
  workspace: "Workspace",
};

// Map common /admin/<x> children. Falls back to the segment.
const ADMIN_LABEL: Record<string, string> = {
  users: "Users",
  libraries: "Library config",
  requests: "Request forms",
  permissions: "Permissions",
  scope: "Operational scope",
  analytics: "Analytics",
  audit: "Audit log",
  "data-export": "Data export",
  settings: "Workspace settings",
  holds: "Hold queue",
  assets: "Asset registry",
};

function titleizeSegment(seg: string): string {
  return seg
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildCrumbs(pathname: string | null): Crumb[] {
  if (!pathname || pathname === "/") return [];
  const parts = pathname.split("/").filter(Boolean);

  const crumbs: Crumb[] = [];
  let acc = "";
  parts.forEach((seg, i) => {
    acc += `/${seg}`;
    const isFirst = i === 0;
    const isLast = i === parts.length - 1;
    let label: string;
    if (isFirst) {
      label = SECTION_LABEL[seg] ?? titleizeSegment(seg);
    } else if (parts[0] === "admin" && i === 1) {
      label = ADMIN_LABEL[seg] ?? titleizeSegment(seg);
    } else if (/^[0-9a-f-]{8,}$/.test(seg)) {
      // Looks like an id — render a short hint.
      label = `#${seg.slice(0, 6)}`;
    } else {
      label = titleizeSegment(seg);
    }
    crumbs.push({ label, href: isLast ? undefined : acc });
  });

  return crumbs;
}

export default function TopBar() {
  const { uid } = useRole();
  const pathname = usePathname();
  const crumbs = useMemo(() => buildCrumbs(pathname), [pathname]);

  return (
    <header
      className="shrink-0 h-14 bg-gradient-to-r from-white via-white to-slate-50 border-b border-slate-200 px-4 flex items-center gap-3 relative"
      style={{
        backgroundImage:
          "linear-gradient(to right, rgba(255,255,255,1), rgba(255,255,255,0.96)), radial-gradient(circle at top right, rgba(249,115,22,0.06), transparent 60%)",
      }}
    >
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center min-w-0 flex-1 gap-1.5 text-sm">
        {crumbs.length === 0 ? (
          <span className="text-slate-400 italic">Home</span>
        ) : (
          crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />}
              {c.href ? (
                <Link
                  href={c.href}
                  className="text-slate-500 hover:text-slate-900 font-medium truncate transition-colors"
                >
                  {c.label}
                </Link>
              ) : (
                <span className="text-slate-900 font-bold truncate">{c.label}</span>
              )}
            </React.Fragment>
          ))
        )}
      </nav>

      {/* Right: ⌘K hint pill + bell */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => {
            // Synthesize ⌘K so we don't import the palette's context here.
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
          }}
          title="Search anything (⌘K)"
          className="hidden sm:inline-flex items-center gap-2 h-8 pl-2.5 pr-1.5 rounded-lg bg-white border border-slate-200 hover:border-slate-300 text-slate-500 hover:text-slate-900 transition-colors group"
        >
          <Search className="w-3.5 h-3.5" />
          <span className="text-xs font-medium pr-1">Search</span>
          <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-slate-100 group-hover:bg-slate-200 rounded text-[10px] font-mono text-slate-500 font-bold">
            <Command className="w-2.5 h-2.5" />K
          </kbd>
        </button>

        <div className="h-6 w-px bg-slate-200" />

        {uid && <NotificationBell userId={uid} variant="header" />}
      </div>

      {/* Subtle gradient underline that ties to the sidebar's orange edge */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-orange-500/15 to-transparent pointer-events-none" />
    </header>
  );
}
