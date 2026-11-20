"use client";

// RetentionPill — records-management state. Red "Legal hold" (frozen), amber
// "Disposition due" (past retention), slate "Disposed", or a subtle "Retain to
// <year>" while retained. Renders nothing when no retention applies.

import React from "react";
import { Lock, AlertTriangle, Archive, CalendarClock } from "lucide-react";
import { retentionStatusFor } from "@/lib/retention";

export default function RetentionPill({ retentionUntil, dispositionState, legalHold, compact = false, className = "" }: {
  retentionUntil?: string | null;
  dispositionState?: string | null;
  legalHold?: boolean | null;
  compact?: boolean;
  className?: string;
}) {
  const status = retentionStatusFor({ retentionUntil, dispositionState, legalHold });
  if (status === "none") return null;
  const year = (retentionUntil ?? "").slice(0, 4);

  const cfg = {
    hold:     { cls: "bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] text-[var(--state-overdue)] border-[color-mix(in_srgb,var(--state-overdue)_35%,transparent)]",             Icon: Lock,          full: "Legal hold",             short: "Hold" },
    eligible: { cls: "bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)] text-[var(--state-held)] border-[color-mix(in_srgb,var(--state-held)_40%,transparent)]",       Icon: AlertTriangle, full: "Disposition due",        short: "Dispose" },
    disposed: { cls: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]",      Icon: Archive,       full: "Disposed",               short: "Disposed" },
    active:   { cls: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]",       Icon: CalendarClock, full: `Retain to ${year}`,      short: year },
  }[status];

  const Icon = cfg.Icon;
  return (
    <span
      title={legalHold ? "Under legal hold - can't be deleted or disposed" : retentionUntil ? `Retention until ${retentionUntil.slice(0, 10)}` : undefined}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-semibold whitespace-nowrap ${cfg.cls} ${className}`}
    >
      <Icon className="w-3 h-3 shrink-0" /> {compact ? cfg.short : cfg.full}
    </span>
  );
}
