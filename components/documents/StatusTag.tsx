// A status tag for document control: a soft pill, tinted with the state
// color. Color only where it means something: done (issued), waiting (in
// review, checked out) and late or blocked. Every other status is grey.

import React from "react";

export type DocTone = "good" | "warn" | "bad" | "none";

/** Document status → the tone of its dot. */
export function docStatusTone(status?: string | null): DocTone {
  switch ((status || "").trim().toLowerCase()) {
    case "issued":
    case "as-built":
    case "released":
    case "approved":
    case "acknowledged":
    case "received":
      return "good";
    case "in review":
    case "internal review":
    case "pending":
    case "pending review":
    case "issued for construction":
    case "awaiting":
      return "warn";
    case "rejected":
    case "failed":
    case "blocked":
    case "overdue":
      return "bad";
    default:
      return "none";
  }
}

/** The soft pill recipe for a tone: a tint of the state color behind the
 *  word in that color; grey for every other status. */
export function pillClass(tone: DocTone): string {
  return `inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] font-semibold whitespace-nowrap leading-[18px] ${PILL[tone]}`;
}

const PILL: Record<DocTone, string> = {
  good: "bg-[color-mix(in_srgb,var(--state-released)_14%,transparent)] text-[var(--state-released)]",
  warn: "bg-[color-mix(in_srgb,var(--state-held)_16%,transparent)] text-[var(--state-held)]",
  bad: "bg-[color-mix(in_srgb,var(--state-overdue)_14%,transparent)] text-[var(--state-overdue)]",
  none: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] shadow-[inset_0_0_0_1px_var(--color-border)]",
};

/** A status as a soft pill: done green, waiting amber, late or failed red,
 *  anything else grey. */
export function StatusTag({ tone, status, children, className = "" }: {
  /** The pill's tone; worked out from `status` when left out. */
  tone?: DocTone;
  status?: string | null;
  children?: React.ReactNode;
  /** Kept for older callers: the word is always in the state color now. */
  colored?: boolean;
  className?: string;
}) {
  const t = tone ?? docStatusTone(status);
  return <span className={`${pillClass(t)} ${className}`}>{children ?? status ?? "-"}</span>;
}

/** "Nov 11" (this year) or "Nov 11, 2025". "-" when there's no date. */
export function humanDate(value: unknown): string {
  if (value == null || value === "") return "-";
  let d: Date | null = null;
  const v = value as { toDate?: () => Date; seconds?: number };
  if (value instanceof Date) d = value;
  else if (typeof v.toDate === "function") d = v.toDate();
  else if (typeof v.seconds === "number") d = new Date(v.seconds * 1000);
  else if (typeof value === "string" || typeof value === "number") d = new Date(value);
  if (!d || Number.isNaN(d.getTime())) return "-";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}
