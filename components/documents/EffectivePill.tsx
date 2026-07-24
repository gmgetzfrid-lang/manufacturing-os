"use client";

// EffectivePill — an amber badge shown when a revision is issued but NOT YET in
// force (a future effective date). Renders nothing once the date has arrived
// (the rev is simply the current controlled copy) or when none is set.

import React from "react";
import { CalendarClock } from "lucide-react";
import { effectiveStatusFor, daysUntilEffective } from "@/lib/effectiveDate";

export default function EffectivePill({ effectiveDate, compact = false, className = "" }: {
  effectiveDate?: string | null;
  compact?: boolean;
  className?: string;
}) {
  if (effectiveStatusFor(effectiveDate) !== "pending") return null;
  const days = daysUntilEffective(effectiveDate);
  const date = (effectiveDate ?? "").slice(0, 10);
  return (
    <span
      title={`Issued — becomes effective ${date}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap bg-amber-50 text-amber-700 border-amber-200 ${className}`}
    >
      <CalendarClock className="w-3 h-3 shrink-0" /> {compact ? (days != null ? `Eff ${days}d` : date) : `Effective ${date}`}
    </span>
  );
}
