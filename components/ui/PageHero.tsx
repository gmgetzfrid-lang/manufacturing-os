"use client";

// The page frame every screen shares. The header has its own white
// surface, from the top bar down to a hairline under its tabs (never a
// colored band): a small muted kicker (where you are), the page's
// answer as the title (what matters right now, e.g. "1 thing needs you."),
// one short line under it, and the facts that back it up: ONE hero number
// large, the others as small labeled values in a row. Zeros are muted, a
// late or waiting value is in its state color (never a filled box). The one
// filled action (the accent) sits on the right; secondary tools are quiet
// buttons beside the kicker. Tabs, search and filters sit just under the
// header, on the same white. Below, on the page color, sections are a
// heading and their content on a white sheet, full width.

import React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { CountUp } from "@/components/ui/CountUp";

/** A secondary button: white, a hairline edge, text color, a faint shadow. */
export const heroQuiet =
  "ui-quiet ui-press inline-flex items-center justify-center gap-1.5 whitespace-nowrap h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-control)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-control)] active:shadow-none disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed transition-[color,background-color,border-color,box-shadow,transform]";

/** The page's one main action: the only filled accent on the screen,
 *  top-lit so it reads as something to press. */
export const heroPrimary =
  "ui-press inline-flex items-center justify-center gap-2 whitespace-nowrap h-10 pointer-coarse:h-11 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-[var(--shadow-action)] text-reading font-medium hover:bg-[var(--color-accent-hover)] active:shadow-none disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed transition-[color,background-color,border-color,box-shadow,transform]";

/** A fact that backs up the answer. `hero` marks the one number that
 *  matters (shown large); otherwise the first fact that isn't zero is. */
export interface HeroFact { label: React.ReactNode; value: React.ReactNode; tone?: "bad" | "warn" | "good"; hero?: boolean }

/** True for a value that reads as nothing: 0, "0", "0 h", "0%", "-". */
export function isZeroFact(v: React.ReactNode): boolean {
  if (typeof v === "number") return v === 0;
  if (typeof v === "string") return /^\s*(?:0+(?:[.,]0+)?\s*(?:h|d|%)?|-|–)\s*$/i.test(v);
  return false;
}

const TONE_TEXT: Record<NonNullable<HeroFact["tone"]>, string> = {
  bad: "text-[var(--state-overdue-text)]",
  warn: "text-[var(--state-held-text)]",
  good: "text-[var(--state-released-text)]",
};

function factColor(f: HeroFact): string {
  if (isZeroFact(f.value)) return "text-[var(--color-text-faint)]";
  return f.tone ? TONE_TEXT[f.tone] : "text-[var(--color-text)]";
}

/** Which fact leads: the one marked `hero`, else the first that isn't
 *  zero; none when every fact is zero (nothing to shout about). */
function heroIndex(facts: HeroFact[], mode: "auto" | "none"): number {
  if (mode === "none") return -1;
  const marked = facts.findIndex((f) => f.hero);
  if (marked >= 0) return marked;
  return facts.findIndex((f) => !isZeroFact(f.value));
}

export function PageHero({
  kicker,
  title,
  sub,
  back,
  tools,
  primary,
  facts,
  factsHero = "auto",
  children,
  size = "lg",
  compactOnPhone = false,
  slim = false,
  className = "",
}: {
  /** Where you are (e.g. "Documents / Drawings"). */
  kicker?: React.ReactNode;
  /** The answer: what matters on this page right now. */
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
  /** Up to four facts under the answer: one large, the rest small. */
  facts?: HeroFact[];
  /** "none" shows every fact small (no hero number). */
  factsHero?: "auto" | "none";
  /** Things that steer the page: tabs, search, a path of steps. */
  children?: React.ReactNode;
  /** "md" for detail pages whose answer is long. */
  size?: "lg" | "md";
  /** On a phone: the answer in one small line, no kicker, no short line,
   *  no facts. For a page whose real content needs the screen (a map). */
  compactOnPhone?: boolean;
  /** The tabs under an overview: the answer and its short line small,
   *  the facts in one line under it (no big number). */
  slim?: boolean;
  /** Kept for older callers; the header never overlaps content now. */
  overlap?: boolean;
  className?: string;
}) {
  const big = compactOnPhone || slim
    ? "text-section"
    : size === "lg" ? "text-title" : "text-section sm:text-title";
  const phoneHide = compactOnPhone ? "max-sm:hidden" : "";
  const list = (facts ?? []).slice(0, 4);
  const hi = heroIndex(list, factsHero);
  const hero = hi >= 0 ? list[hi] : null;
  const rest = list.filter((_, i) => i !== hi);
  const backCls = "-ml-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 rounded-lg grid place-items-center shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)] transition-colors";
  return (
    <>
      {/* The header's own white surface: an empty layer behind it, spread
          to the column's edges and up to the top bar (globals.css). */}
      <div className="page-top">
      <div aria-hidden className="page-top-sheet" />
      <header className={`page-head relative -mt-2 ${className}`}>
        {(back || kicker || tools) && (
          <div className={`flex flex-wrap items-center gap-x-2 gap-y-2 min-h-10 mb-1.5 ${compactOnPhone && !back && !tools ? "max-sm:hidden" : ""}`}>
            {back && (back.href ? (
              <Link href={back.href} aria-label={back.label} title={back.label} className={backCls}>
                <ChevronLeft className="w-5 h-5" />
              </Link>
            ) : (
              <button type="button" onClick={back.onClick} aria-label={back.label} title={back.label} className={backCls}>
                <ChevronLeft className="w-5 h-5" />
              </button>
            ))}
            <div className="min-w-0 flex-1 truncate text-body text-[var(--color-text-muted)]">{kicker}</div>
            {tools && <div className="page-tools flex flex-wrap items-center gap-1 min-w-0 max-w-full">{tools}</div>}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div className="min-w-0 flex-1 basis-[300px]">
            <h1 className={`font-display ${big} leading-[1.2] font-semibold tracking-[-0.005em] text-[var(--color-text)] [overflow-wrap:anywhere]`}>{title}</h1>
            {sub && (slim
              ? <p className="mt-0.5 text-body leading-snug text-[var(--color-text-muted)] max-w-[90ch]">{sub}</p>
              : <p className={`${phoneHide} mt-1.5 text-reading leading-snug text-[var(--color-text-muted)] max-w-[72ch]`}>{sub}</p>)}
            {slim && list.length > 0 && (
              <dl className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-body">
                {list.map((f, i) => (
                  <div key={i} className="inline-flex items-baseline gap-1.5 min-w-0">
                    <dt className="text-[var(--color-text-muted)]">{f.label}</dt>
                    <dd className={`font-semibold tabular-nums whitespace-nowrap ${factColor(f)}`}>{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {!slim && list.length > 0 && (
              <dl className={`${phoneHide} mt-4 flex flex-wrap items-end gap-x-7 gap-y-3`}>
                {hero && (
                  <div className="min-w-0 sm:mr-2">
                    <dt className="text-body text-[var(--color-text-muted)] truncate">{hero.label}</dt>
                    <dd className={`mt-0.5 font-display text-title sm:text-hero leading-[1.05] font-bold tabular-nums whitespace-nowrap ${factColor(hero)}`}><CountUp value={hero.value} /></dd>
                  </div>
                )}
                {rest.map((f, i) => (
                  <div key={i} className="min-w-0 sm:pb-1">
                    <dt className="text-body text-[var(--color-text-muted)] truncate">{f.label}</dt>
                    {/* Beside a hero number the others are small (no middle size:
                        docs/design-rules.md TY5, B4); with no hero they lead. */}
                    <dd className={`mt-0.5 font-display ${hero ? "text-reading" : "text-section"} leading-tight font-semibold tabular-nums whitespace-nowrap ${factColor(f)}`}><CountUp value={f.value} /></dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          {primary && <div className="max-sm:hidden shrink-0">{primary}</div>}
        </div>
      </header>
      {children && <div className={`page-top-kids relative mt-4 ${compactOnPhone ? "max-sm:mt-2" : ""}`}>{children}</div>}
      </div>
      {primary && (
        // On a phone the one action sits where a thumb reaches it (above the
        // staged tray when that shows: --staged-tray-h), clear of the home
        // indicator.
        <div className="sm:hidden fixed inset-x-0 bottom-[var(--staged-tray-h,0px)] z-40 px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] bg-[color-mix(in_srgb,var(--color-surface)_94%,transparent)] border-t border-[var(--color-border)] shadow-[0_-6px_16px_-10px_rgb(15_23_42/0.18)] [&>*]:w-full">
          {primary}
        </div>
      )}
    </>
  );
}

/** The page's content under the header. */
export function PageBody({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`page-body mt-6 space-y-8 ${className}`}>{children}</div>;
}

// Classes that place a section in a grid stay on the outer element; the
// rest style the sheet.
const PLACE = /^(?:[a-z]+:)*(?:col-span|row-span|order|sticky|top-|self-|min-w-0|basis)/;

/** A section: its heading on the page, its content on a white sheet.
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
  const sheet = `rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-card)] ${pad ? "p-4 sm:p-5" : ""}`;
  if (!label && !action) return <Tag className={`${sheet} ${className}`}>{children}</Tag>;
  const parts = className.split(/\s+/).filter(Boolean);
  const place = parts.filter((c) => PLACE.test(c)).join(" ");
  const rest = parts.filter((c) => !PLACE.test(c)).join(" ");
  return (
    <Tag className={`min-w-0 ${place}`}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 mb-3 min-h-8">
        {label && <h2 className="font-display text-section leading-tight font-semibold text-[var(--color-text)] [&_svg]:inline [&_svg]:align-[-2px]">{label}</h2>}
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
export function StepLine({ steps, onDark = false, compact = false }: {
  steps: Array<{ label: React.ReactNode; note?: React.ReactNode; short?: React.ReactNode; tone?: "bad" | "ok" | "muted"; state: "done" | "now" | "next" }>;
  onDark?: boolean;
  /** One line per step: its name and where it stands (`short`), for the
   *  tabs below the overview. */
  compact?: boolean;
}) {
  void onDark; // the header is on the page now: one look everywhere
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
              <span className="w-3 h-3 rounded-full shrink-0 box-border"
                style={filled ? { background: fg } : { border: `2px solid ${s.state === "now" ? "var(--color-current)" : line}` }} />
              {!last && <span className="flex-1 h-px" style={{ background: filled && steps[i + 1]?.state !== "next" ? fg : line }} />}
            </div>
            {compact ? (
              <div className="mt-1.5 pr-3 text-body truncate">
                <span className="font-medium text-[var(--color-text)]">{s.label}</span>
                {(s.short ?? null) != null && <span className={s.tone === "bad" ? "text-[var(--state-overdue-text)] font-medium" : "text-[var(--color-text-muted)]"}> · {s.short}</span>}
              </div>
            ) : <div className="mt-2.5 pr-3 text-body font-medium truncate text-[var(--color-text)]">{s.label}</div>}
            {!compact && s.note && (
              // The note stays quiet: the page marks only the late part red
              // (dates and the rest stay gray, docs/design-rules.md B2).
              <div className="pr-3 text-body mt-0.5 tabular-nums text-[var(--color-text-muted)]">{s.note}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default PageHero;
