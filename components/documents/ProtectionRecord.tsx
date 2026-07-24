"use client";

// ProtectionRecord — what the control system PREVENTED, counted.
//
// "The system stopped 14 silent overwrites this quarter" is the sentence
// that survives budget season. Every counter here comes from records the
// system already writes; this just adds them up (last 90 days).

import React, { useEffect, useState } from "react";
import { ShieldCheck, GitBranch, Clock, FileWarning } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface Counts {
  conflictsBlocked: number;
  branchesOpened: number;
  branchesResolved: number;
  autoReleases: number;
  flaggedPublishes: number;
}

const WINDOW_DAYS = 90;

export default function ProtectionRecord({ orgId }: { orgId: string }) {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
      const count = async (action: string): Promise<number> => {
        try {
          const { count: n } = await supabase
            .from("audit_logs")
            .select("id", { count: "exact", head: true })
            .eq("org_id", orgId)
            .eq("action", action)
            .gt("timestamp", since);
          return n ?? 0;
        } catch {
          return 0;
        }
      };
      const countReleased = async (): Promise<number> => {
        try {
          const { count: n } = await supabase
            .from("checkout_sessions")
            .select("id", { count: "exact", head: true })
            .eq("org_id", orgId)
            .like("released_reason", "Auto-released%")
            .gt("released_at", since);
          return n ?? 0;
        } catch {
          return 0;
        }
      };
      const countFlagged = async (): Promise<number> => {
        try {
          const { count: n } = await supabase
            .from("document_versions")
            .select("id", { count: "exact", head: true })
            .eq("org_id", orgId)
            .eq("provenance", "unverified")
            .gt("created_at", since);
          return n ?? 0;
        } catch {
          return 0;
        }
      };
      const [conflictsBlocked, branchesOpened, branchesResolved, autoReleases, flaggedPublishes] =
        await Promise.all([
          count("REV_CONFLICT_BLOCKED"),
          count("REV_BRANCH"),
          count("BRANCH_RESOLVED"),
          countReleased(),
          countFlagged(),
        ]);
      if (alive) setCounts({ conflictsBlocked, branchesOpened, branchesResolved, autoReleases, flaggedPublishes });
    })();
    return () => { alive = false; };
  }, [orgId]);

  if (!counts) return null;
  const anything =
    counts.conflictsBlocked + counts.branchesOpened + counts.branchesResolved +
    counts.autoReleases + counts.flaggedPublishes;
  if (anything === 0) return null;

  const stat = (
    icon: React.ReactNode,
    value: number,
    label: string,
    tone: string,
  ) => (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${tone}`}>
      {icon}
      <span className="text-lg font-black tabular-nums">{value}</span>
      <span className="text-[10px] font-bold leading-tight opacity-80">{label}</span>
    </div>
  );

  return (
    <div className="mb-4">
      <div className="flex items-center gap-1.5 mb-1.5">
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">
          Protection record — last {WINDOW_DAYS} days
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {counts.conflictsBlocked > 0 && stat(
          <ShieldCheck className="w-4 h-4 text-emerald-600" />,
          counts.conflictsBlocked,
          "silent overwrites stopped",
          "border-emerald-200 bg-emerald-50 text-emerald-900",
        )}
        {(counts.branchesOpened > 0 || counts.branchesResolved > 0) && stat(
          <GitBranch className="w-4 h-4 text-purple-600" />,
          counts.branchesResolved,
          `of ${counts.branchesOpened} branches reconciled`,
          "border-purple-200 bg-purple-50 text-purple-900",
        )}
        {counts.autoReleases > 0 && stat(
          <Clock className="w-4 h-4 text-blue-600" />,
          counts.autoReleases,
          "forgotten checkouts auto-released",
          "border-blue-200 bg-blue-50 text-blue-900",
        )}
        {counts.flaggedPublishes > 0 && stat(
          <FileWarning className="w-4 h-4 text-amber-600" />,
          counts.flaggedPublishes,
          "publishes flagged for provenance review",
          "border-amber-200 bg-amber-50 text-amber-900",
        )}
      </div>
    </div>
  );
}
