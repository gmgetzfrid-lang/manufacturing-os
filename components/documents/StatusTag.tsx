// A status for document control: a small dot and the word. Color only
// where it means something: the dot is green when done (issued), amber when
// waiting (in review, checked out), red when late or blocked; the word is
// colored only when someone has to act (waiting, late, blocked). Every
// other status is a grey dot and a muted word. Never a filled box.

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

/** The dot-and-word recipe for a tone (the `ui-pill` class in
 *  globals.css): green / amber / red dot, grey for every other status. */
export function pillClass(tone: DocTone): string {
  return `ui-pill ${PILL[tone]}`;
}

const PILL: Record<DocTone, string> = {
  good: "is-good",
  warn: "is-warn",
  bad: "is-bad",
  none: "is-muted",
};

/** A status as a dot and a word: done green, waiting amber, late or
 *  failed red, anything else grey. */
export function StatusTag({ tone, status, children, className = "" }: {
  /** The tone; worked out from `status` when left out. */
  tone?: DocTone;
  status?: string | null;
  children?: React.ReactNode;
  /** Kept for older callers. */
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
