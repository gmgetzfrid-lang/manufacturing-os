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

import React, { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Search, Command, Inbox, Menu } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import NotificationBell from "@/components/notifications/NotificationBell";
import ThemeMenu from "@/components/navigation/ThemeMenu";
import DensityToggle from "@/components/navigation/DensityToggle";

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
  workspace: "Document Compare",
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

export default function TopBar({ onOpenMobileNav }: { onOpenMobileNav?: () => void } = {}) {
  const { uid } = useRole();
  const pathname = usePathname();

  // Resolve the dynamic id segment (/documents/<id>, /projects/<id>,
  // /requests/<id>) to a human name so the breadcrumb reads "Unit 12 P&IDs"
  // instead of "#a1b2c3". Keyed by id so a stale name never shows after
  // navigation; falls back to the #id hint until it resolves.
  const [resolved, setResolved] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const parts = (pathname ?? "").split("/").filter(Boolean);
    const id = parts[1];
    if (!id || !/^[0-9a-f-]{8,}$/.test(id)) return;
    const run = async () => {
      try {
        let name: string | null = null;
        if (parts[0] === "documents") {
          const { data } = await supabase.from("libraries").select("name").eq("id", id).maybeSingle();
          name = (data as { name?: string } | null)?.name ?? null;
        } else if (parts[0] === "projects") {
          const { data } = await supabase.from("projects").select("name").eq("id", id).maybeSingle();
          name = (data as { name?: string } | null)?.name ?? null;
        } else if (parts[0] === "requests") {
          const { data } = await supabase.from("tickets").select("ticket_id, title").eq("id", id).maybeSingle();
          const row = data as { ticket_id?: string; title?: string } | null;
          name = row?.ticket_id || row?.title || null;
        }
        if (alive && name) setResolved({ id, name });
      } catch { /* keep the #id fallback */ }
    };
    void run();
    return () => { alive = false; };
  }, [pathname]);

  const crumbs = useMemo(() => {
    const base = buildCrumbs(pathname);
    const id = (pathname ?? "").split("/").filter(Boolean)[1];
    // Swap the id crumb (2nd segment) for the resolved name when it matches
    // the id currently in the path.
    if (resolved && resolved.id === id && base[1] && base[1].label.startsWith("#")) {
      base[1] = { ...base[1], label: resolved.name };
    }
    return base;
  }, [pathname, resolved]);

  return (
    <header className="shrink-0 h-14 bg-[var(--color-surface)] border-b border-[var(--color-border)] px-4 flex items-center gap-3 relative z-30 backdrop-blur supports-[backdrop-filter]:bg-[color-mix(in_srgb,var(--color-surface)_80%,transparent)]">
      {/* Hamburger — opens the off-canvas nav drawer (mobile only). */}
      <button
        onClick={onOpenMobileNav}
        aria-label="Open navigation menu"
        className="md:hidden -ml-1 mr-0.5 w-9 h-9 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors shrink-0"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center min-w-0 flex-1 gap-1.5 text-sm">
        {crumbs.length === 0 ? (
          <span className="text-[var(--color-text-faint)] italic">Home</span>
        ) : (
          crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />}
              {c.href ? (
                <Link
                  href={c.href}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] font-medium truncate transition-colors"
                >
                  {c.label}
                </Link>
              ) : (
                <span className="text-[var(--color-text)] font-bold truncate">{c.label}</span>
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
          className="hidden sm:inline-flex items-center gap-2 h-8 pl-2.5 pr-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors group"
        >
          <Search className="w-3.5 h-3.5" />
          <span className="text-xs font-medium pr-1">Search</span>
          <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[var(--color-surface-2)] group-hover:bg-slate-200 rounded text-[10px] font-mono text-[var(--color-text-muted)] font-bold">
            <Command className="w-2.5 h-2.5" />K
          </kbd>
        </button>

        <div className="h-6 w-px bg-[var(--color-border)]" />

        <Link
          href="/inbox"
          aria-label="Inbox"
          title="Inbox"
          className="relative w-9 h-9 inline-flex items-center justify-center rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
        >
          <Inbox className="w-4 h-4" />
        </Link>
        <DensityToggle />
        <ThemeMenu />
        {uid && <NotificationBell variant="header" />}
      </div>

      {/* Subtle gradient underline that ties to the sidebar's orange edge */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[var(--color-accent)]/20 to-transparent pointer-events-none" />
    </header>
  );
}
