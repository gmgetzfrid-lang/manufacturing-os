// The pieces admin screens and the public pages share, so a list reads the
// same everywhere: a ruled table on one white sheet, a quiet status (a dot
// and a word), labeled form rows, and the button and link recipes.
//
// Buttons: ONE filled primary per screen (the accent, top-lit: a light
// top edge and a small shadow, so it reads as pressable); secondary is
// white with a hairline edge on a faint shadow; tertiary is a link;
// destructive is red words on a secondary button (and always confirms).
// 40 px tall, 44 px on touch screens, radius 8. Focus is the app-wide
// ring (globals.css). Sheets and tables: a hairline and a faint shadow.
//
// No "use client" here on purpose: the public pages are server pages and
// import these class strings too (PageHero's live in a client module, where
// a server page can't read them).

import React from "react";
import { explainError } from "@/lib/friendlyError";

/** The page's one main action: filled with the accent. */
export const btnPrimary =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap h-10 pointer-coarse:h-11 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-[var(--shadow-action)] text-[15px] font-semibold hover:bg-[var(--color-accent-hover)] active:shadow-none disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed transition-[color,background-color,border-color,box-shadow]";

/** A secondary button: white, a hairline edge, text color. */
export const btnQuiet =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-control)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-control)] active:shadow-none disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed transition-[color,background-color,border-color,box-shadow]";

/** A small secondary button for a table row. */
export const btnRow =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 h-8 pointer-coarse:h-10 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-control)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-control)] active:shadow-none disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed transition-[color,background-color,border-color,box-shadow]";

/** A destructive action: red words on a secondary button. Confirm first. */
export const btnDanger =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-control)] text-[14px] font-semibold text-[var(--state-overdue-text)] hover:bg-[color-mix(in_srgb,var(--state-overdue)_6%,var(--color-surface))] hover:border-[color-mix(in_srgb,var(--state-overdue)_45%,var(--color-border-strong))] active:shadow-none disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed transition-[color,background-color,border-color,box-shadow]";

/** A tertiary action: a link-styled button (no box). */
export const btnLink =
  "inline-flex items-center gap-1.5 whitespace-nowrap min-h-8 pointer-coarse:min-h-11 text-[14px] font-semibold text-[var(--color-accent-text)] hover:underline underline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline";

/** An icon-only button with a visible hover fill. Give it an aria-label
 *  and a title (the tooltip). */
export const btnIcon =
  "inline-flex items-center justify-center w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors";

/** A link: the brand's readable shade, underlined on hover. */
export const link =
  "text-[var(--color-accent-text)] hover:underline underline-offset-2";

/** A text field with no size: give it a width, height and text size. The
 *  resting edge is 3:1 against the page; focus is the app-wide ring. */
export const fieldBox =
  "px-3 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] disabled:opacity-60 aria-[invalid=true]:border-[var(--state-overdue)] transition-colors";

/** A full-width text field on a white sheet: 40 px (44 on touch), 16 px
 *  text on a phone. */
export const field = `w-full h-10 pointer-coarse:h-11 text-[15px] max-sm:text-[16px] ${fieldBox}`;

/** A form label, above its field: 14px, sentence case. */
export const label = "block text-[14px] font-semibold text-[var(--color-text)] mb-1.5";

/** The line under a field that says what's wrong and how to fix it. */
export const fieldError = "mt-1.5 flex items-start gap-1.5 text-[13px] font-semibold text-[var(--state-overdue-text)]";

/** A white sheet: where data sits. */
export const sheet = "rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]";

/** The ruled table recipe. */
export const tbl = {
  wrap: "rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden",
  table: "w-full text-[14px] border-collapse tabular-nums",
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
const TONE_TEXT: Record<Tone, string> = {
  bad: "var(--state-overdue-text)",
  warn: "var(--state-held-text)",
  good: "var(--state-released-text)",
  none: "var(--color-text)",
};

/** A quiet status: a small dot in the state color and a word. The word is
 *  colored only when the state needs someone (late or failed, waiting);
 *  `colored` forces it on (true) or off (false). */
export function StatusTag({ tone = "none", colored, children, className = "" }: {
  tone?: Tone; colored?: boolean; children: React.ReactNode; className?: string;
}) {
  const wordColored = colored ?? (tone === "bad" || tone === "warn");
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] font-semibold whitespace-nowrap ${className}`}
      style={{ color: wordColored && tone !== "none" ? TONE_TEXT[tone] : tone === "none" ? "var(--color-text-muted)" : "var(--color-text)" }}>
      <span aria-hidden className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: TONE_VAR[tone] }} />
      {children}
    </span>
  );
}

/** A status as a dot and a word (the `ui-pill` recipe): done green dot,
 *  waiting amber, late or failed red (the word colored too), not set grey,
 *  `brand` / `solid` the brand's dot. */
export function Pill({ tone = "none", children, className = "", title }: {
  tone?: Tone | "brand" | "solid"; children: React.ReactNode; className?: string; title?: string;
}) {
  const mod = tone === "good" ? "is-good" : tone === "bad" ? "is-bad" : tone === "warn" ? "is-warn"
    : tone === "solid" ? "is-solid" : tone === "brand" ? "" : "is-muted";
  return <span title={title} className={`ui-pill ${mod} ${className}`}>{children}</span>;
}

/** A plain, muted icon at text size in front of a heading or row (the
 *  `ui-icon-tile` recipe; no colored tile). Use it only when the icon
 *  carries meaning (a file type, folder vs file). */
export function IconTile({ icon: Icon, size = "sm", solid = false, className = "" }: {
  icon: React.ComponentType<{ className?: string }>; size?: "sm" | "md"; solid?: boolean; className?: string;
}) {
  return (
    <span aria-hidden className={`ui-icon-tile ${size === "sm" ? "is-sm" : ""} ${solid ? "is-solid" : ""} ${className}`}>
      <Icon className={size === "sm" ? "w-4 h-4" : "w-[18px] h-[18px]"} />
    </span>
  );
}

/** The 3px left edge on a late or waiting row. Put it in a `relative` cell. */
export function RowEdge({ tone }: { tone: Exclude<Tone, "none"> }) {
  return <span aria-hidden className="absolute left-0 inset-y-0 w-[3px]" style={{ background: TONE_VAR[tone] }} />;
}

/** Text in a state color (a late count, a failed step). */
export function toneText(tone: Tone): string {
  return tone === "bad" ? "text-[var(--state-overdue-text)]" : tone === "warn" ? "text-[var(--state-held-text)]" : tone === "good" ? "text-[var(--state-released-text)]" : "text-[var(--color-text)]";
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

/** A problem said where it happened, with an optional way to try again.
 *  Pass the caught `error` to have it said in plain words (never a raw
 *  database or network message); `children` is used as written. */
export function Problem({ children, error, retry, className = "" }: {
  children?: React.ReactNode; error?: unknown; retry?: () => void; className?: string;
}) {
  const said = children ?? (error !== undefined ? (() => { const f = explainError(error); return `${f.message} ${f.next}`; })() : null);
  return (
    <p role="alert" className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[14px] text-[var(--state-overdue-text)] ${className}`}>
      <span className="font-semibold">{said}</span>
      {retry && <button type="button" onClick={retry} className={link}>Try again</button>}
    </p>
  );
}

/** A section whose content brings its own sheet (a table, a list): the
 *  heading on the page, `action` on its right, and the content as given.
 *  A count reads as plain figures after the heading ("Libraries 4"). */
export function Section({ label: text, icon, count, action, children, className = "", id }: {
  label: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; id?: string;
  /** Kept for older callers: a plain muted icon before the heading. */
  icon?: React.ComponentType<{ className?: string }>;
  /** A count after the heading, as plain muted figures. */
  count?: number;
}) {
  return (
    <section className={`min-w-0 ${className}`} aria-labelledby={id}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 mb-3 min-h-8">
        <h2 id={id} className="font-display text-[20px] leading-tight font-semibold text-[var(--color-text)] inline-flex items-center gap-2 [&_svg]:inline [&_svg]:align-[-2px]">
          {icon && <IconTile icon={icon} />}
          {text}
          {count !== undefined && count > 0 && <span className="ui-count">{count.toLocaleString()}</span>}
        </h2>
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
