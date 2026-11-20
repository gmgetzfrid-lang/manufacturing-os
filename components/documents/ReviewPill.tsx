"use client";

// ReviewPill — the at-a-glance review-cycle badge shown on a document (in the
// list, the inspector, and the viewer). Green = current, amber = due soon, red =
// overdue. Renders nothing when the document has no review cycle.

import React from "react";
import { CheckCircle2, Clock, AlertTriangle } from "lucide-react";
import { reviewStatusFor, daysUntilReview } from "@/lib/reviewCycles";
import { humanDate } from "@/components/documents/StatusTag";

export default function ReviewPill({ nextReviewDate, leadDays = 30, compact = false, className = "" }: {
  nextReviewDate?: string | null;
  leadDays?: number;
  /** Compact = icon + short text (for dense table cells). */
  compact?: boolean;
  className?: string;
}) {
  const status = reviewStatusFor(nextReviewDate, leadDays);
  if (status === "none") return null;
  const days = daysUntilReview(nextReviewDate);
  const date = humanDate(nextReviewDate);

  const cfg = {
    current:  { cls: "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)] text-[var(--state-released)] border-[color-mix(in_srgb,var(--state-released)_35%,transparent)]", Icon: CheckCircle2, full: `Reviewed · due ${date}`,            short: date },
    due_soon: { cls: "bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)] text-[var(--state-held)] border-[color-mix(in_srgb,var(--state-held)_40%,transparent)]",       Icon: Clock,        full: days != null ? `Review due in ${days}d` : `Review due ${date}`, short: days != null ? `Due ${days}d` : date },
    overdue:  { cls: "bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] text-[var(--state-overdue)] border-[color-mix(in_srgb,var(--state-overdue)_35%,transparent)]",             Icon: AlertTriangle, full: days != null ? `Review overdue ${Math.abs(days)}d` : "Review overdue", short: days != null ? `Overdue ${Math.abs(days)}d` : "Overdue" },
  }[status];

  const Icon = cfg.Icon;
  return (
    <span
      title={`Next review: ${date}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-semibold whitespace-nowrap ${cfg.cls} ${className}`}
    >
      <Icon className="w-3 h-3 shrink-0" /> {compact ? cfg.short : cfg.full}
    </span>
  );
}
