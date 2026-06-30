"use client";

// ReviewPill — the at-a-glance review-cycle badge shown on a document (in the
// list, the inspector, and the viewer). Green = current, amber = due soon, red =
// overdue. Renders nothing when the document has no review cycle.

import React from "react";
import { CheckCircle2, Clock, AlertTriangle } from "lucide-react";
import { reviewStatusFor, daysUntilReview } from "@/lib/reviewCycles";

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
  const date = (nextReviewDate ?? "").slice(0, 10);

  const cfg = {
    current:  { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: CheckCircle2, full: `Reviewed · due ${date}`,            short: date },
    due_soon: { cls: "bg-amber-50 text-amber-700 border-amber-200",       Icon: Clock,        full: days != null ? `Review due in ${days}d` : `Review due ${date}`, short: days != null ? `Due ${days}d` : date },
    overdue:  { cls: "bg-red-50 text-red-700 border-red-200",             Icon: AlertTriangle, full: days != null ? `Review overdue ${Math.abs(days)}d` : "Review overdue", short: days != null ? `Overdue ${Math.abs(days)}d` : "Overdue" },
  }[status];

  const Icon = cfg.Icon;
  return (
    <span
      title={`Next review: ${date}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${cfg.cls} ${className}`}
    >
      <Icon className="w-3 h-3 shrink-0" /> {compact ? cfg.short : cfg.full}
    </span>
  );
}
