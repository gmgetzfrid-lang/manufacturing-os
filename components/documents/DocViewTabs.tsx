"use client";

// The Documents views as underline tabs, with the daily ones in sight and
// the rest one tap away under More, grouped by job (Hick's law: a short row
// is read at a glance). Document control works every day in the table, the
// staged set, checkouts and transmittals; the graph, the register, connector
// checks, holds and work packages are looked at now and then.
//
// When the view you're on lives under More, the More tab takes its name and
// its underline, so the row always says where you are.
//
// Same look and behavior as the shared ViewTabs (underline, muted counts,
// view-transition on switch, the Graph opening on the folder you're in).

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useStagedDocs } from "@/lib/stagedDocs";
import { badgeText } from "@/lib/badge";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { onTransitionClick, transitionPush } from "@/lib/viewTransition";
import { DOCUMENT_VIEWS, type ViewTab } from "@/components/navigation/ViewTabs";
import { TabGlide } from "@/components/ui/TabGlide";

/** The views document control opens every day: always in the row. */
const DAILY = ["/documents", "/documents/staged", "/checkouts", "/transmittals"];
/** The rest, under More, by what they are for. */
const GROUPS: Array<{ label: string; hrefs: string[] }> = [
  { label: "Look up", hrefs: ["/documents/graph", "/register"] },
  { label: "Checks", hrefs: ["/documents/connectors", "/admin/holds"] },
  { label: "Jobs", hrefs: ["/packages"] },
];

const byHref = new Map(DOCUMENT_VIEWS.map((t) => [t.href, t]));

export default function DocViewTabs({
  hrefs,
  right,
}: {
  /** Where a tab goes from this page, by its usual href (the library sends
   *  Graph to the folder you are in; the graph sends Table back). */
  hrefs?: Partial<Record<string, string>>;
  /** Right-aligned content on the tab row. */
  right?: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { activeOrgId, uid } = useRole();
  const staged = useStagedDocs(activeOrgId, uid);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEscapeClose(() => { setOpen(false); trigger.current?.focus(); }, open);

  const libMatch = /^\/documents\/([0-9a-f-]{36})/.exec(pathname);
  const hrefFor = (href: string) => hrefs?.[href]
    ?? (href === "/documents/graph" && libMatch ? `/documents/graph?focus=${encodeURIComponent(`lib:${libMatch[1]}`)}` : href);
  const isActive = (t: ViewTab) => {
    if (t.exclude?.some((x) => pathname === x || pathname.startsWith(x + "/"))) return false;
    return t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(t.href + "/");
  };
  const go = (e: React.MouseEvent<HTMLElement>, t: ViewTab) => {
    // The Graph opens on the folder you're in, read at the moment of the tap.
    if (!hrefs?.[t.href] && t.href === "/documents/graph" && libMatch && !(e.metaKey || e.ctrlKey || e.shiftKey)) {
      const folderId = new URLSearchParams(window.location.search).get("folderId");
      if (folderId) {
        e.preventDefault();
        transitionPush(router, `/documents/graph?focus=${encodeURIComponent(`folder:${folderId}`)}`);
        return;
      }
    }
    if (isActive(t)) return;
    onTransitionClick(e, () => router.push(hrefFor(t.href)));
  };

  const daily = DAILY.map((h) => byHref.get(h)).filter(Boolean) as ViewTab[];
  const groups = GROUPS.map((g) => ({ label: g.label, tabs: g.hrefs.map((h) => byHref.get(h)).filter(Boolean) as ViewTab[] }));
  const moreOn = groups.flatMap((g) => g.tabs).find(isActive) ?? null;
  const countOf = (t: ViewTab) => (t.liveCount === "staged" ? staged.count : t.badge);

  // On a phone the row scrolls on its own, the one you're on in sight.
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = strip.current, on = el?.querySelector<HTMLElement>("[aria-current=page]");
    if (!el || !on || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = Math.max(0, on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2);
  }, [pathname]);

  // The menu: under its tab, kept on screen; closes on a tap outside or a
  // scroll of the page under it.
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => !!t && (!!trigger.current?.contains(t as Node) || !!menu.current?.contains(t as Node));
    const away = (e: MouseEvent | TouchEvent) => { if (!inside(e.target)) setOpen(false); };
    const moved = (e: Event) => { if (!inside(e.target)) setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("mousedown", away); document.removeEventListener("touchstart", away);
      window.removeEventListener("scroll", moved, true); window.removeEventListener("resize", moved);
    };
  }, [open]);
  const toggle = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) });
    setOpen((o) => !o);
  };
  // Up and down walk the menu; Home and End jump to its ends.
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "ArrowDown" ? (i + 1) % items.length
      : e.key === "ArrowUp" ? (i - 1 + items.length) % items.length
      : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    items[to]?.focus();
  };

  const tabCls = (on: boolean) => `shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 border-b-2 text-body transition-colors ${
    on
      ? "border-[var(--color-current)] text-[var(--color-text)] font-medium"
      : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]"
  }`;

  return (
    <div className="flex items-end gap-x-4 gap-y-2 flex-wrap min-w-0 max-w-full mb-4 border-b border-[var(--color-border)]">
      <nav aria-label="Documents views" ref={strip}
        className="relative tab-glide -mb-px flex items-end gap-5 min-w-0 max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {daily.map((t) => {
          const on = isActive(t);
          const n = countOf(t);
          return (
            <Link key={t.href} href={hrefFor(t.href)} onClick={(e) => go(e, t)} aria-current={on ? "page" : undefined} className={tabCls(on)}>
              {t.label}
              {typeof n === "number" && n > 0 && (
                <span className="text-body font-normal tabular-nums text-[var(--color-text-muted)]">{badgeText(n)}</span>
              )}
            </Link>
          );
        })}
        <button ref={trigger} type="button" onClick={toggle}
          aria-haspopup="menu" aria-expanded={open}
          aria-current={moreOn ? "page" : undefined}
          aria-label={moreOn ? `${moreOn.label}. More views` : "More views"}
          className={tabCls(!!moreOn)}>
          {moreOn ? moreOn.label : "More"}
          <ChevronDown aria-hidden className={`ui-chevron w-3.5 h-3.5 ${open ? "rotate-180" : ""}`} />
        </button>
        <TabGlide id="doc-views" />
      </nav>
      {right && <div className="ml-auto self-center pb-1.5">{right}</div>}
      {open && typeof document !== "undefined" && createPortal(
        <div ref={menu} role="menu" aria-label="More views" onKeyDown={onMenuKey}
          style={{ top: at.top, left: at.left, transformOrigin: "top left" }}
          className="on-sheet ui-float ui-float-in fixed z-[650] w-60 max-w-[calc(100vw-1rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1.5">
          {groups.map((g, gi) => (
            <div key={g.label} role="group" aria-label={g.label} className={gi > 0 ? "mt-1 pt-1 border-t border-[var(--color-border)]" : ""}>
              <div className="px-3 pt-1.5 pb-1 text-caption text-[var(--color-text-muted)]">{g.label}</div>
              {g.tabs.map((t) => {
                const on = isActive(t);
                const Icon = t.icon;
                return (
                  <Link key={t.href} href={hrefFor(t.href)} role="menuitem" aria-current={on ? "page" : undefined}
                    onClick={(e) => { setOpen(false); go(e, t); }}
                    className={`relative flex items-center gap-2.5 px-3 min-h-10 pointer-coarse:min-h-11 text-body hover:bg-[var(--color-surface-2)] focus-visible:bg-[var(--color-surface-2)] ${on ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text)]"}`}>
                    {on && <span aria-hidden className="absolute left-0 inset-y-2 w-[3px] rounded-r bg-[var(--color-current)]" />}
                    {Icon && <Icon className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />}
                    {t.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
