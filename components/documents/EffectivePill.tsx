"use client";

// EffectivePill — an amber badge shown when a revision is issued but NOT YET in
// force (a future effective date). Renders nothing once the date has arrived
// (the rev is simply the current controlled copy) or when none is set.
//
// VFY-15 (admin-and-org Round G, P12): given the document's workspace
// (`orgId`), the badge decides in that workspace's calendar — its Admin's
// time zone, read once per workspace and kept a few minutes — the same
// calendar the daily scan announces in and /api/verify answers in. With no
// workspace given, none set, an unreadable setting, or before the deployment
// records 20261203 as live (workspaceEffectiveZoneHonoured), it decides in
// the deployment's calendar, as before. Review fix: WHILE the workspace's
// zone is loading it decides in the latest calendar (UTC-12,
// EFFECTIVE_DATE_FALLBACK_TIME_ZONE) — the deployment's calendar could be
// ahead of the workspace's and leave "not yet in effect" off the first
// paint; the latest calendar can only show the badge a little longer, never
// drop it early (DEC-63 / REV-9's "late, never early").
// Re-review: the browser asks /api/workspace-effective-zone (the server
// decides whether the stored zone is shown to be an Admin's — it needs the
// audit trail), so the badge agrees with /api/verify and the scan.

import React, { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  effectiveStatusFor, daysUntilEffective, cachedWorkspaceEffectiveDateTimeZone,
  workspaceEffectiveZoneHonoured, EFFECTIVE_DATE_FALLBACK_TIME_ZONE,
} from "@/lib/effectiveDate";

function useWorkspaceEffectiveZone(orgId: string | null | undefined, wanted: boolean): string | undefined {
  const [zone, setZone] = useState<{ orgId: string; zone: string } | null>(null);
  const honoured = workspaceEffectiveZoneHonoured();
  useEffect(() => {
    if (!orgId || !wanted || !honoured) return;
    let live = true;
    void cachedWorkspaceEffectiveDateTimeZone(supabase, orgId).then((z) => { if (live) setZone({ orgId, zone: z }); });
    return () => { live = false; };
  }, [orgId, wanted, honoured]);
  // Before 20261203 is recorded live the setting is not read: the
  // deployment's calendar decides (undefined), as before VFY-15.
  if (!orgId || !honoured) return undefined;
  if (zone && zone.orgId === orgId) return zone.zone;
  // Loading: the latest calendar, so the badge is never dropped early.
  return EFFECTIVE_DATE_FALLBACK_TIME_ZONE;
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
