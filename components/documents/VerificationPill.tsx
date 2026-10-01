"use client";

// VerificationPill — GAP-9: the at-a-glance field-verification currency badge,
// rendered beside ReviewPill / AckPill / EffectivePill. The state comes from
// lib/reviewCycles.ts summarizeFieldVerification (the review-cycle rule applied
// to the walkdown cadence): green = current, amber = due soon / never verified,
// red = overdue / a field discrepancy supersedes the last verification, grey =
// verified with no cadence, or unknown (the register could not be read).
// Renders nothing when there is nothing to say.

import React from "react";
import { CheckCircle2, Clock, AlertTriangle, HelpCircle, MapPin } from "lucide-react";
import { verificationPillText, verificationPillTitle, type FieldVerification } from "@/lib/reviewCycles";

export default function VerificationPill({ verification, compact = false, className = "" }: {
  verification?: FieldVerification | null;
  /** Compact = icon + short text (for dense table cells). */
  compact?: boolean;
  className?: string;
}) {
  if (!verification) return null;
  const { full, short, tone } = verificationPillText(verification);
  const cls = {
    ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warn: "bg-amber-50 text-amber-700 border-amber-200",
    bad: "bg-red-50 text-red-700 border-red-200",
    neutral: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]",
  }[tone];
  const Icon = verification.status === "current" ? CheckCircle2
    : verification.status === "due_soon" || verification.status === "never" ? Clock
    : verification.status === "overdue" || verification.status === "discrepancy" ? AlertTriangle
    : verification.status === "unknown" ? HelpCircle : MapPin;
  return (
    <span
      title={verificationPillTitle(verification)}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${cls} ${className}`}
    >
      <Icon className="w-3 h-3 shrink-0" /> {compact ? short : full}
    </span>
  );
}
