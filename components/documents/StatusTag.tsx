// A quiet status tag for document control: an 8px dot in the state color
// and the word in graphite. Color only where it means something: done
// (issued), waiting (in review, checked out) and late or blocked. Every
// other status gets a grey dot.

import React from "react";

export type DocTone = "good" | "warn" | "bad" | "none";

const DOT: Record<DocTone, string> = {
  good: "var(--state-released)",
  warn: "var(--state-held)",
  bad: "var(--state-overdue)",
  none: "var(--color-text-faint)",
};

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

export function StatusTag({ tone, status, children, colored = false, className = "" }: {
  /** The dot's tone; worked out from `status` when left out. */
  tone?: DocTone;
  status?: string | null;
  children?: React.ReactNode;
  /** Text in the state color too (for a late or waiting word). */
  colored?: boolean;
  className?: string;
}) {
  const t = tone ?? docStatusTone(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[13px] font-semibold whitespace-nowrap ${className}`}
      style={{ color: colored && t !== "none" ? DOT[t] : "var(--color-text)" }}
    >
      <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: DOT[t] }} />
      {children ?? status ?? "-"}
    </span>
  );
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
