"use client";

// The page frame every screen shares. Three layers, so a page has depth:
//   back   the dark band: a small label, the page's ANSWER in big type
//          (what matters right now, e.g. "1 thing needs you."), one line
//          under it, and anything that steers the page (tabs, search, a
//          path of steps)
//   middle white cards that overlap the band's bottom edge (PageBody)
//   top    the one orange action, raised above both. On a phone it rides
//          in a bar at the bottom of the screen so a thumb can reach it.
// One thing is huge, everything else is small: there are no middle sizes.

import React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/** Quiet button on the dark band (menus, filters, secondary actions). */
export const heroQuiet =
  "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-[10px] border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-[13px] font-semibold text-[var(--color-ink-fg)] hover:bg-[var(--color-ink-line)] disabled:opacity-50 transition-colors";

/** The one orange action, raised. */
export const heroPrimary =
  "inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[14px] font-extrabold hover:bg-[var(--color-accent-hover)] shadow-[0_12px_24px_-12px_var(--color-accent)] disabled:opacity-50 transition-colors";

export function PageHero({
  kicker,
  title,
  sub,
  back,
  tools,
  primary,
  children,
  size = "lg",
  overlap = true,
  className = "",
}: {
  /** Small all-caps label: where you are (e.g. "Document control · Drawings"). */
  kicker?: React.ReactNode;
  /** The answer: what matters on this page right now. Shown big. */
  title: React.ReactNode;
  /** One short line under the answer. */
  sub?: React.ReactNode;
  /** A left arrow back one screen. */
  back?: { href?: string; onClick?: () => void; label: string };
  /** Small controls top right (menus, refresh, filters): use heroQuiet. */
  tools?: React.ReactNode;
  /** The one orange action (use heroPrimary). Raised on desktop; a bottom
   *  bar on a phone. */
  primary?: React.ReactNode;
  /** Things that steer the page and belong in the band: tabs, search,
   *  a path of steps. */
  children?: React.ReactNode;
  /** "md" for detail pages whose answer is long. */
  size?: "lg" | "md";
  /** true (default): a PageBody follows and its cards overlap the band.
   *  false: the band ends on its own and content starts below it. */
  overlap?: boolean;
  className?: string;
}) {
  const big = size === "lg"
    ? "text-[34px] sm:text-[46px] lg:text-[56px]"
    : "text-[28px] sm:text-[38px] lg:text-[44px]";
  return (
    <>
      <section
        className={`relative rounded-[20px] bg-[var(--color-ink)] text-white px-5 sm:px-8 lg:px-10 pt-4 sm:pt-6 ${overlap ? "pb-20 sm:pb-24" : "pb-7 sm:pb-8 mb-5"} ${className}`}
      >
        <div className="flex items-center gap-2 min-h-9">
          {back && (back.href ? (
            <Link href={back.href} aria-label={back.label}
              className="-ml-2 w-9 h-9 rounded-[10px] grid place-items-center text-[var(--color-ink-fg)] hover:bg-[var(--color-ink-2)]">
              <ChevronLeft className="w-5 h-5" />
            </Link>
          ) : (
            <button type="button" onClick={back.onClick} aria-label={back.label}
              className="-ml-2 w-9 h-9 rounded-[10px] grid place-items-center text-[var(--color-ink-fg)] hover:bg-[var(--color-ink-2)]">
              <ChevronLeft className="w-5 h-5" />
            </button>
          ))}
          {kicker && (
            <div className="min-w-0 truncate text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">{kicker}</div>
          )}
          <div className="flex-1" />
          {tools && <div className="flex items-center gap-2 shrink-0">{tools}</div>}
        </div>
        <div className="mt-5 sm:mt-7 flex flex-wrap items-end gap-x-8 gap-y-4">
          <div className="min-w-0 flex-1 basis-[420px]">
            <h1 className={`${big} leading-[1.03] font-black tracking-[-0.03em] text-white`}>{title}</h1>
            {sub && <p className="mt-3 text-[14px] sm:text-[15px] text-[var(--color-ink-text)] max-w-3xl">{sub}</p>}
          </div>
          {primary && <div className="max-sm:hidden shrink-0">{primary}</div>}
        </div>
        {children && <div className="mt-6">{children}</div>}
      </section>
      {primary && (
        // On a phone the one action sits where a thumb reaches it.
        <div className="sm:hidden fixed inset-x-0 bottom-0 z-40 px-3.5 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] bg-[color-mix(in_srgb,var(--color-canvas)_94%,transparent)] border-t border-[var(--color-border)] [&>*]:w-full">
          {primary}
        </div>
      )}
    </>
  );
}

/** The middle layer: cards that overlap the band's bottom edge. Its first
 *  child should be a Card (white), never bare text. */
export function PageBody({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`relative -mt-14 sm:-mt-16 px-2 sm:px-5 space-y-4 ${className}`}>{children}</div>;
}

/** A white card on the paper: soft depth, no outline. `label` is the
 *  small all-caps name; `action` sits on its right. */
export function Card({
  label,
  action,
  children,
  className = "",
  pad = true,
  as: Tag = "section",
}: {
  label?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  pad?: boolean;
  as?: "section" | "article" | "div";
}) {
  return (
    <Tag className={`rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] ${pad ? "p-4 sm:p-5" : ""} ${className}`}>
      {(label || action) && (
        <div className={`flex items-center gap-3 ${pad ? "mb-3" : "px-4 sm:px-5 pt-4 pb-3"}`}>
          {label && <h2 className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">{label}</h2>}
          <div className="flex-1" />
          {action}
        </div>
      )}
      {children}
    </Tag>
  );
}

/** A row of cards that keeps going sideways: the last one is cut off at
 *  the edge, so it's plain there's more (it scrolls). */
export function CardStrip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`-mr-2 sm:-mr-5 flex gap-3 sm:gap-4 overflow-x-auto overscroll-x-contain pb-1 pr-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}>
      {children}
    </div>
  );
}

/** Steps or phases joined by one line, so they read as one path. */
export function StepLine({ steps, onDark = false }: {
  steps: Array<{ label: React.ReactNode; note?: React.ReactNode; tone?: "bad" | "ok" | "muted"; state: "done" | "now" | "next" }>;
  onDark?: boolean;
}) {
  const fg = onDark ? "#ffffff" : "var(--color-text)";
  const line = onDark ? "var(--color-ink-line)" : "var(--color-border-strong)";
  return (
    <ol className="flex items-start" aria-label="Steps">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const filled = s.state === "done";
        return (
          <li key={i} className={last ? "shrink-0 pr-2" : "flex-1 min-w-0"} aria-current={s.state === "now" ? "step" : undefined}>
            <div className="flex items-center">
              <span className="w-3.5 h-3.5 rounded-full shrink-0 box-border"
                style={filled ? { background: fg } : { border: `2px solid ${s.state === "now" ? fg : line}` }} />
              {!last && <span className="flex-1 h-0.5" style={{ background: filled && steps[i + 1]?.state !== "next" ? fg : line }} />}
            </div>
            <div className={`mt-2.5 pr-3 text-[13px] sm:text-[14px] font-bold truncate ${onDark ? "text-white" : "text-[var(--color-text)]"}`}>{s.label}</div>
            {s.note && (
              <div className={`pr-3 text-[12px] mt-0.5 ${s.tone === "bad" ? (onDark ? "text-rose-300 font-semibold" : "text-rose-700 font-semibold") : onDark ? "text-[var(--color-ink-muted)]" : "text-[var(--color-text-muted)]"}`}>{s.note}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default PageHero;
