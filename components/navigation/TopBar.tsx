"use client";

// TopBar — the thin strip on the paper above every page.
//
// Where you are is the page's own job now: every page opens on a dark band
// whose small label says where you are (and its back arrow goes up a level),
// so this strip doesn't repeat it. It keeps what is the same everywhere:
// the menu (phone), search (⌘K), Inbox, density, theme and the bell.

import React from "react";
import Link from "next/link";
import { Search, Command, Inbox, Menu } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import NotificationBell from "@/components/notifications/NotificationBell";
import ThemeMenu from "@/components/navigation/ThemeMenu";
import DensityToggle from "@/components/navigation/DensityToggle";

export default function TopBar({ onOpenMobileNav }: { onOpenMobileNav?: () => void } = {}) {
  const { uid } = useRole();

  return (
    <header className="vt-top shrink-0 h-14 sm:h-12 sm:mt-1 bg-[var(--color-canvas)] px-4 sm:px-6 lg:px-8 flex items-center gap-3 relative z-30">
      {/* Hamburger — opens the off-canvas nav drawer (mobile only). */}
      <button
        onClick={onOpenMobileNav}
        aria-label="Open navigation menu"
        title="Menu"
        className="md:hidden -ml-1 mr-0.5 w-11 h-11 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors shrink-0"
      >
        <Menu className="w-5 h-5" />
      </button>
      <div className="flex-1" />

      {/* Right: ⌘K hint pill + bell */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Mobile: the pill doesn't fit, but search must still exist — a
            phone user needs "find E-22" as much as a desktop user does. */}
        <button
          onClick={() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
          }}
          aria-label="Search anything"
          title="Search anything"
          className="sm:hidden w-11 h-11 inline-flex items-center justify-center rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
        >
          <Search className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            // Synthesize ⌘K so we don't import the palette's context here.
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
          }}
          title="Search anything (⌘K)"
          className="hidden sm:inline-flex items-center gap-2 h-9 w-60 lg:w-80 pl-3 pr-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border-strong)] hover:border-[var(--color-border-control)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors group"
        >
          <Search className="w-3.5 h-3.5" />
          <span className="flex-1 min-w-0 truncate text-left text-[14px] pr-1">Search documents, tags, requests</span>
          <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[var(--color-surface-2)] group-hover:bg-[var(--color-border)] rounded text-[11px] font-mono text-[var(--color-text-muted)] font-bold">
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
    </header>
  );
}
