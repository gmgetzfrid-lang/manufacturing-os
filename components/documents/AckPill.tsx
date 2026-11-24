"use client";

// AckPill — the at-a-glance read-&-understood badge. Green = everyone signed,
// amber = outstanding, red = overdue or hard-gated-and-pending. Renders nothing
// when the document has no acknowledgment roster. Driven entirely by the roster
// summary (never a cached count) so it can't drift.

import React from "react";
import { ClipboardCheck, ClipboardList, AlertTriangle, Lock } from "lucide-react";
import { ackStatusFor, type AckSummary, type AckStatus } from "@/lib/acknowledgments";

const CFG: Record<Exclude<AckStatus, "none">, { cls: string; Icon: typeof ClipboardCheck; verb: string }> = {
  complete: { cls: "bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)] text-[var(--state-released)] border-[color-mix(in_srgb,var(--state-released)_35%,transparent)]", Icon: ClipboardCheck, verb: "Acknowledged" },
  partial:  { cls: "bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)] text-[var(--state-held)] border-[color-mix(in_srgb,var(--state-held)_40%,transparent)]",       Icon: ClipboardList,  verb: "Ack" },
  overdue:  { cls: "bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] text-[var(--state-overdue)] border-[color-mix(in_srgb,var(--state-overdue)_35%,transparent)]",             Icon: AlertTriangle,  verb: "Ack overdue" },
  blocked:  { cls: "bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] text-[var(--state-overdue)] border-[color-mix(in_srgb,var(--state-overdue)_35%,transparent)]",             Icon: Lock,           verb: "Pending ack" },
};

export default function AckPill({ summary, compact = false, className = "" }: {
  summary?: AckSummary | null;
  compact?: boolean;
  className?: string;
}) {
  const status = ackStatusFor(summary);
  if (status === "none" || !summary) return null;
  const cfg = CFG[status];
  const count = `${summary.done}/${summary.required}`;
  const Icon = cfg.Icon;
  return (
    <span
      title={`${summary.done} of ${summary.required} acknowledged${summary.waived ? ` · ${summary.waived} waived` : ""}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-body font-medium whitespace-nowrap ${cfg.cls} ${className}`}
    >
      <Icon className="w-3 h-3 shrink-0" /> {compact ? count : `${cfg.verb} ${count}`}
    </span>
  );
}
