"use client";

// TopBar — the strip above every page, on its own white surface with a
// hairline under it. It stays put while the page scrolls; once the page
// has scrolled under it, it casts a soft shadow, so it reads as on top.
//
// Where you are is the page's own job: every page opens on a header whose
// small label says where you are (and its back arrow goes up a level), so
// this strip doesn't repeat it. It keeps what is the same everywhere: the
// menu (phone), search (⌘K), Inbox, density, theme and the bell.

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search, Command, Inbox, Menu } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import NotificationBell from "@/components/notifications/NotificationBell";
import ThemeMenu from "@/components/navigation/ThemeMenu";
import DensityToggle from "@/components/navigation/DensityToggle";

/** True once the page under the bar has scrolled: the column's own
 *  scroller, or a page's main area that scrolls by itself (a library),
 *  that is, a scroller starting right under the bar and most of its width.
 *  Side lists (the folder rail) and tables that scroll don't count. */
function usePageScrolled(bar: React.RefObject<HTMLElement | null>): boolean {
  const [scrolled, setScrolled] = React.useState(false);
  // A new page starts at its top.
  const pathname = usePathname();
  const [path, setPath] = React.useState(pathname);
  if (path !== pathname) { setPath(pathname); setScrolled(false); }
  React.useEffect(() => {
    const onScroll = (e: Event) => {
      const el = e.target;
      const b = bar.current?.getBoundingClientRect();
      if (!(el instanceof HTMLElement) || !b) return;
      const r = el.getBoundingClientRect();
      if (Math.abs(r.top - b.bottom) > 2 || r.width < b.width * 0.6) return;
      setScrolled(el.scrollTop > 0);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, [bar]);
  return scrolled;
}

export default function TopBar({ onOpenMobileNav }: { onOpenMobileNav?: () => void } = {}) {
  const { uid } = useRole();
  const bar = React.useRef<HTMLElement>(null);
  const scrolled = usePageScrolled(bar);

  return (
    <header ref={bar} data-scrolled={scrolled || undefined}
      className={`vt-top shrink-0 h-14 sm:h-16 bg-[var(--color-surface)] border-b border-[var(--color-border)] px-4 sm:px-6 lg:px-8 flex items-center gap-3 relative z-30 transition-shadow duration-200 ${scrolled ? "shadow-[var(--shadow-bar)]" : ""}`}>
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
          <span className="flex-1 min-w-0 truncate text-left text-body pr-1">Search documents, tags, requests</span>
          <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[var(--color-surface-2)] group-hover:bg-[var(--color-border)] rounded text-caption font-mono text-[var(--color-text-muted)] font-medium">
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
