// The pieces admin screens and the public pages share, so a list reads the
// same everywhere: a ruled table on one white sheet, a quiet status tag (a
// dot and a word), labeled form rows, and the button and link recipes.
//
// No "use client" here on purpose: the public pages are server pages and
// import these class strings too (PageHero's live in a client module, where
// a server page can't read them).

import React from "react";

/** The page's one main action: filled with the signal color. */
export const btnPrimary =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap h-10 px-4 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[15px] font-semibold hover:bg-[var(--color-accent-hover)] shadow-[0_1px_0_rgb(0_0_0/0.12)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)] focus-visible:ring-offset-2";

/** A secondary button: white, ruled, graphite text. */
export const btnQuiet =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap h-9 px-3.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-text-faint)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]";

/** A small secondary button for a table row. */
export const btnRow =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 h-8 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-text-faint)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]";

/** A destructive secondary button (red text on white). */
export const btnDanger =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap h-9 px-3.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

/** An icon-only button with a visible hover fill. Give it an aria-label. */
export const btnIcon =
  "inline-flex items-center justify-center w-8 h-8 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]";

/** A link: the signal color's readable shade, underlined on hover. */
export const link =
  "text-[var(--color-accent-text)] hover:underline underline-offset-2";

/** A text field with no size: give it a width, height and text size. */
export const fieldBox =
  "px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 disabled:opacity-60 transition-colors";

/** A full-width text field on a white sheet. */
export const field = `w-full h-10 text-[15px] ${fieldBox}`;

/** A form label: 13px, muted, sentence case. */
export const label = "block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5";

/** A white sheet: where data sits. */
export const sheet = "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]";

/** The ruled table recipe. */
export const tbl = {
  wrap: "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden",
  table: "w-full text-[15px] border-collapse",
  thead: "bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left",
  th: "font-semibold px-4 h-10 whitespace-nowrap",
  tbody: "divide-y divide-[var(--color-border)]",
  tr: "hover:bg-[var(--color-surface-2)] transition-colors",
  td: "px-4 py-3 align-middle",
  /** A sheet's footer row: "40 of 120 shown · Show more". */
  foot: "px-4 py-3 border-t border-[var(--color-border)] flex items-center justify-between gap-3 text-[14px]",
};

export type Tone = "bad" | "warn" | "good" | "none";

const TONE_VAR: Record<Tone, string> = {
  bad: "var(--state-overdue)",
  warn: "var(--state-held)",
  good: "var(--state-released)",
  none: "var(--color-text-faint)",
};

/** A quiet status tag: an 8px dot in the state color, the word in graphite
 *  (or in the state color with `colored`). */
export function StatusTag({ tone = "none", colored = false, children, className = "" }: {
  tone?: Tone; colored?: boolean; children: React.ReactNode; className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] font-semibold whitespace-nowrap ${className}`}
      style={{ color: colored && tone !== "none" ? TONE_VAR[tone] : "var(--color-text)" }}>
      <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: TONE_VAR[tone] }} />
      {children}
    </span>
  );
}

/** The 3px left edge on a late or waiting row. Put it in a `relative` cell. */
export function RowEdge({ tone }: { tone: Exclude<Tone, "none"> }) {
  return <span aria-hidden className="absolute left-0 inset-y-0 w-[3px]" style={{ background: TONE_VAR[tone] }} />;
}

/** Text in a state color (a late count, a failed step). */
export function toneText(tone: Tone): string {
  return tone === "bad" ? "text-[var(--state-overdue)]" : tone === "warn" ? "text-[var(--state-held)]" : tone === "good" ? "text-[var(--state-released)]" : "text-[var(--color-text)]";
}

/** One labeled row of a settings form: the label (and one short hint) on the
 *  left, the control on the right; stacked when the sheet is narrow (a phone,
 *  or a half-width section). Values beside a label use `@xl:pt-2` to line up. */
export function FormRow({ label: text, hint, htmlFor, children, className = "" }: {
  label: React.ReactNode; hint?: React.ReactNode; htmlFor?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`@container ${className}`}>
     <div className="grid grid-cols-1 @xl:grid-cols-[minmax(180px,260px)_1fr] gap-x-8 gap-y-2 px-4 sm:px-5 py-4">
      <div className="min-w-0 @xl:pt-2">
        {htmlFor
          ? <label htmlFor={htmlFor} className="block text-[14px] font-semibold text-[var(--color-text)]">{text}</label>
          : <div className="text-[14px] font-semibold text-[var(--color-text)]">{text}</div>}
        {hint && <p className="mt-0.5 text-[13px] leading-snug text-[var(--color-text-muted)]">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
     </div>
    </div>
  );
}

/** A problem said where it happened, with an optional way to try again. */
export function Problem({ children, retry, className = "" }: {
  children: React.ReactNode; retry?: () => void; className?: string;
}) {
  return (
    <p role="alert" className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[14px] text-[var(--state-overdue)] ${className}`}>
      <span className="font-semibold">{children}</span>
      {retry && <button type="button" onClick={retry} className={link}>Try again</button>}
    </p>
  );
}

/** A section whose content brings its own sheet (a table, a list): the
 *  heading on the panel, `action` on its right, and the content as given. */
export function Section({ label: text, action, children, className = "", id }: {
  label: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; id?: string;
}) {
  return (
    <section className={`min-w-0 ${className}`} aria-labelledby={id}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 mb-2.5 min-h-8">
        <h2 id={id} className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)] [&_svg]:inline [&_svg]:align-[-2px]">{text}</h2>
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

/** A human date: "Aug 6", or "Aug 6, 2025" outside this year. */
export function shortDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** A human date and time: "Aug 6, 2:40 PM". */
export function shortDateTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${shortDate(iso)}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}
