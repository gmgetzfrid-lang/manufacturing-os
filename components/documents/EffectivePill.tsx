"use client";

// EffectivePill — an amber badge shown when a revision is issued but NOT YET in
// force (a future effective date). Renders nothing once the date has arrived
// (the rev is simply the current controlled copy) or when none is set.
//
// VFY-15 (admin-and-org Round G, P12): given the document's workspace
// (`orgId`), the badge decides in that workspace's calendar — its Admin's
// time zone, read once per workspace and kept a few minutes — the same
// calendar the daily scan announces in and /api/verify answers in. Until it
// has loaded, or with no workspace given, none set or an unreadable setting,
// it decides in the deployment's calendar, as before.

import React, { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { effectiveStatusFor, daysUntilEffective, cachedWorkspaceEffectiveDateTimeZone } from "@/lib/effectiveDate";

function useWorkspaceEffectiveZone(orgId: string | null | undefined, wanted: boolean): string | undefined {
  const [zone, setZone] = useState<{ orgId: string; zone: string } | null>(null);
  useEffect(() => {
    if (!orgId || !wanted) return;
    let live = true;
    void cachedWorkspaceEffectiveDateTimeZone(supabase, orgId).then((z) => { if (live) setZone({ orgId, zone: z }); });
    return () => { live = false; };
  }, [orgId, wanted]);
  return zone && zone.orgId === orgId ? zone.zone : undefined;
}

export default function EffectivePill({ effectiveDate, orgId = null, compact = false, className = "" }: {
  effectiveDate?: string | null;
  /** The document's workspace — its Admin's time zone decides "in effect". */
  orgId?: string | null;
  compact?: boolean;
  className?: string;
}) {
  const zone = useWorkspaceEffectiveZone(orgId, !!effectiveDate);
  const now = new Date();
  if (effectiveStatusFor(effectiveDate, now, zone) !== "pending") return null;
  const days = daysUntilEffective(effectiveDate, now, zone);
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
