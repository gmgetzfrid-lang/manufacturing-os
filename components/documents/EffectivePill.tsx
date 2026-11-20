"use client";

// EffectivePill — an amber badge shown when a revision is issued but NOT YET in
// force (a future effective date). Renders nothing once the date has arrived
// (the rev is simply the current controlled copy) or when none is set.

import React from "react";
import { CalendarClock } from "lucide-react";
import { effectiveStatusFor, daysUntilEffective } from "@/lib/effectiveDate";
import { humanDate } from "@/components/documents/StatusTag";

export default function EffectivePill({ effectiveDate, compact = false, className = "" }: {
  effectiveDate?: string | null;
  compact?: boolean;
  className?: string;
}) {
  if (effectiveStatusFor(effectiveDate) !== "pending") return null;
  const days = daysUntilEffective(effectiveDate);
  const date = humanDate(effectiveDate);
  return (
    <span
      title={`Issued - becomes effective ${date}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-semibold whitespace-nowrap bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)] text-[var(--state-held)] border-[color-mix(in_srgb,var(--state-held)_40%,transparent)] ${className}`}
    >
      <CalendarClock className="w-3 h-3 shrink-0" /> {compact ? (days != null ? `Eff ${days}d` : date) : `Effective ${date}`}
    </span>
  );
}
