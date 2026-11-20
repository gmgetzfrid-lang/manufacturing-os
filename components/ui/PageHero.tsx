"use client";

// The page frame every screen shares, drawn like the title block of an
// engineering drawing: the page's answer in big condensed type on the left
// (what matters right now, e.g. "43 things need you"), the few facts that
// back it up in ruled cells beside it, and the one main action at the end.
// It sits on the grey panel; there is no colored block. Below it, sections
// are a heading and their content on a white sheet, full width.

import React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/** A secondary button: white, ruled, graphite text. */
export const heroQuiet =
  "inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-text-faint)] disabled:opacity-50 transition-colors";

/** The page's one main action: filled with the signal color. */
export const heroPrimary =
  "inline-flex items-center justify-center gap-2 h-10 px-4 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[15px] font-semibold hover:bg-[var(--color-accent-hover)] shadow-[0_1px_0_rgb(0_0_0/0.12)] disabled:opacity-50 transition-colors";

/** One ruled cell in the title block: a fact that backs up the answer. */
export interface HeroFact { label: React.ReactNode; value: React.ReactNode; tone?: "bad" | "warn" | "good" }

export function PageHero({
  kicker,
  title,
  sub,
  back,
  tools,
  primary,
  facts,
  children,
  size = "lg",
  className = "",
}: {
  /** Where you are (e.g. "Documents / Drawings"). */
  kicker?: React.ReactNode;
  /** The answer: what matters on this page right now. Shown big. */
  title: React.ReactNode;
  /** One short line under the answer. */
  sub?: React.ReactNode;
  /** A left arrow back one screen. */
  back?: { href?: string; onClick?: () => void; label: string };
  /** Secondary controls (menus, filters): use heroQuiet. */
  tools?: React.ReactNode;
  /** The one main action (use heroPrimary). On a phone it rides in a bar
   *  at the bottom of the screen, where a thumb reaches it. */
  primary?: React.ReactNode;
  /** Up to four facts beside the answer, in ruled cells. */
  facts?: HeroFact[];
  /** Things that steer the page: tabs, search, a path of steps. */
  children?: React.ReactNode;
  /** "md" for detail pages whose answer is long. */
  size?: "lg" | "md";
  /** Kept for older callers; the header never overlaps content now. */
  overlap?: boolean;
  className?: string;
}) {
  const big = size === "lg" ? "text-[30px] sm:text-[38px]" : "text-[26px] sm:text-[32px]";
  const tone = (t?: HeroFact["tone"]) => t === "bad" ? "text-[var(--state-overdue)]" : t === "warn" ? "text-[var(--state-held)]" : t === "good" ? "text-[var(--state-released)]" : "text-[var(--color-text)]";
  return (
    <>
      <header className={`page-head ${children ? "" : "pb-5 border-b border-[var(--color-border-strong)]"} ${className}`}>
        {(back || kicker || tools) && (
          <div className="flex items-center gap-2 min-h-9 mb-1">
            {back && (back.href ? (
              <Link href={back.href} aria-label={back.label}
                className="-ml-2 w-8 h-8 rounded-md grid place-items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]">
                <ChevronLeft className="w-5 h-5" />
              </Link>
            ) : (
              <button type="button" onClick={back.onClick} aria-label={back.label}
                className="-ml-2 w-8 h-8 rounded-md grid place-items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]">
                <ChevronLeft className="w-5 h-5" />
              </button>
            ))}
            {kicker && <div className="min-w-0 truncate text-[14px] font-medium text-[var(--color-text-muted)]">{kicker}</div>}
            <div className="flex-1" />
            {tools && <div className="flex items-center gap-2 shrink-0">{tools}</div>}
          </div>
        )}
        <div className="flex flex-wrap items-stretch gap-x-0 gap-y-4">
          <div className="min-w-0 flex-1 basis-[360px] pr-6 self-center">
            <h1 className={`font-display ${big} leading-[1.05] font-semibold tracking-[-0.01em] text-[var(--color-text)]`}>{title}</h1>
            {sub && <p className="mt-2 text-[15px] leading-snug text-[var(--color-text-muted)] max-w-[70ch]">{sub}</p>}
          </div>
          {facts && facts.length > 0 && (
            <dl className="flex max-sm:w-full max-sm:border-t max-sm:border-[var(--color-border-strong)] max-sm:pt-3">
              {facts.slice(0, 4).map((f, i) => (
                <div key={i} className="px-5 max-sm:first:pl-0 sm:border-l border-[var(--color-border-strong)] max-sm:[&+&]:border-l flex flex-col justify-center min-w-[96px]">
                  <dt className="text-[13px] text-[var(--color-text-muted)] whitespace-nowrap">{f.label}</dt>
                  <dd className={`font-display text-[28px] leading-none mt-1 font-semibold tabular-nums ${tone(f.tone)}`}>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {primary && <div className={`max-sm:hidden shrink-0 self-center ${facts?.length ? "pl-5 border-l border-[var(--color-border-strong)]" : ""}`}>{primary}</div>}
        </div>
        {children && <div className="mt-5">{children}</div>}
      </header>
      {primary && (
        // On a phone the one action sits where a thumb reaches it.
        <div className="sm:hidden fixed inset-x-0 bottom-0 z-40 px-3.5 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] bg-[color-mix(in_srgb,var(--color-canvas)_94%,transparent)] border-t border-[var(--color-border)] [&>*]:w-full">
          {primary}
        </div>
      )}
    </>
  );
}

/** The page's content under the header. */
export function PageBody({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`mt-6 space-y-8 ${className}`}>{children}</div>;
}

// Classes that place a section in a grid stay on the outer element; the
// rest style the sheet.
const PLACE = /^(?:[a-z]+:)*(?:col-span|row-span|order|sticky|top-|self-|min-w-0|basis)/;

/** A section: its heading on the panel, its content on a white sheet.
 *  `label` names it; `action` sits on the heading's right. */
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
  const sheet = `rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] ${pad ? "p-4 sm:p-5" : ""}`;
  if (!label && !action) return <Tag className={`${sheet} ${className}`}>{children}</Tag>;
  const parts = className.split(/\s+/).filter(Boolean);
  const place = parts.filter((c) => PLACE.test(c)).join(" ");
  const rest = parts.filter((c) => !PLACE.test(c)).join(" ");
  return (
    <Tag className={`min-w-0 ${place}`}>
      <div className="flex items-end gap-3 mb-2.5 min-h-8">
        {label && <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)] [&_svg]:inline [&_svg]:align-[-2px]">{label}</h2>}
        <div className="flex-1" />
        {action}
      </div>
      <div className={`${sheet} ${rest}`}>{children}</div>
    </Tag>
  );
}

/** A row of items that keeps going sideways: the last one is cut off at
 *  the edge, so it's plain there's more (it scrolls). */
export function CardStrip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`-mr-4 sm:-mr-6 flex gap-3 overflow-x-auto overscroll-x-contain pb-1 pr-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}>
      {children}
    </div>
  );
}

/** Steps or phases joined by one line, so they read as one path. */
export function StepLine({ steps, onDark = false }: {
  steps: Array<{ label: React.ReactNode; note?: React.ReactNode; tone?: "bad" | "ok" | "muted"; state: "done" | "now" | "next" }>;
  onDark?: boolean;
}) {
  void onDark; // the header is on the light panel now
  const fg = "var(--color-text)";
  const line = "var(--color-border-strong)";
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
            <div className="mt-2.5 pr-3 text-[14px] font-semibold truncate text-[var(--color-text)]">{s.label}</div>
            {s.note && (
              <div className={`pr-3 text-[13px] mt-0.5 ${s.tone === "bad" ? "text-[var(--state-overdue)] font-semibold" : "text-[var(--color-text-muted)]"}`}>{s.note}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default PageHero;
