"use client";

// AckPill — the at-a-glance read-&-understood badge. Green = everyone signed,
// amber = outstanding, red = overdue or hard-gated-and-pending. Renders nothing
// when the document has no acknowledgment roster. Driven entirely by the roster
// summary (never a cached count) so it can't drift.

import React from "react";
import { ClipboardCheck, ClipboardList, AlertTriangle, Lock } from "lucide-react";
import { ackStatusFor, type AckSummary, type AckStatus } from "@/lib/acknowledgments";

const CFG: Record<Exclude<AckStatus, "none">, { cls: string; Icon: typeof ClipboardCheck; verb: string }> = {
  complete: { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: ClipboardCheck, verb: "Acknowledged" },
  partial:  { cls: "bg-amber-50 text-amber-700 border-amber-200",       Icon: ClipboardList,  verb: "Ack" },
  overdue:  { cls: "bg-red-50 text-red-700 border-red-200",             Icon: AlertTriangle,  verb: "Ack overdue" },
  blocked:  { cls: "bg-red-50 text-red-700 border-red-200",             Icon: Lock,           verb: "Pending ack" },
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
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${cfg.cls} ${className}`}
    >
      <Icon className="w-3 h-3 shrink-0" /> {compact ? count : `${cfg.verb} ${count}`}
    </span>
  );
}
