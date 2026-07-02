"use client";

// DailyDigestTrigger — fires the once-a-day in-app digest bell wherever the
// user lands (not just the scratchpad page), so opening the app anywhere still
// surfaces "you have overdue / due-today / aging to-dos". Gated to once per
// browser session; maybeNotifyMorningDigest is itself idempotent per day.

import { useEffect } from "react";
import { useRole } from "@/components/providers/RoleContext";
import { getDailyBrief, maybeNotifyMorningDigest } from "@/lib/notes";
import { scanAndNotifyReviews } from "@/lib/reviewCycles";
import { scanAndNotifyAcks } from "@/lib/acknowledgments";
import { scanReviews } from "@/lib/reviewControl";
import { scanEffectiveDates } from "@/lib/effectiveDate";

const STALE_UNDATED_DAYS = 3;

export default function DailyDigestTrigger() {
  const { activeOrgId, uid, activeRole } = useRole();
  useEffect(() => {
    if (!activeOrgId || !uid) return;
    const key = `mfg.digest.${activeOrgId}.${uid}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch { /* private mode — just proceed */ }

    let alive = true;
    (async () => {
      try {
        const brief = await getDailyBrief(activeOrgId, uid);
        if (!alive) return;
        const staleBefore = Date.now() - STALE_UNDATED_DAYS * 86400000;
        const staleNoDateCount = brief.noDate.filter((it) => {
          const touched = new Date(it.note.updatedAt ?? it.note.createdAt).getTime();
          return Number.isFinite(touched) && touched < staleBefore;
        }).length;
        await maybeNotifyMorningDigest(activeOrgId, uid, brief, { staleNoDateCount });
      } catch { /* best-effort — never block the app */ }
      // Fan out review-cycle due/overdue notices. Run from a controller's session
      // (they hold the write permission to stamp review_notified_at); the per-doc
      // cooldown guard dedups across whichever controller triggers it first.
      if (alive && (activeRole === "Admin" || activeRole === "DocCtrl")) {
        try { await scanAndNotifyReviews(activeOrgId); } catch { /* best-effort */ }
        // Same cadence + guard: re-nudge outstanding read-&-understood sign-offs
        // and escalate long-overdue ones. Per-row notified_at watermark dedups.
        if (alive) { try { await scanAndNotifyAcks(activeOrgId); } catch { /* best-effort */ } }
        // And pre-publish reviews: auto-activate alternates past the timeout,
        // re-nudge reviewers, escalate stalled sign-offs.
        if (alive) { try { await scanReviews(activeOrgId); } catch { /* best-effort */ } }
        // And effective dates: announce revisions that come into force today.
        if (alive) { try { await scanEffectiveDates(activeOrgId); } catch { /* best-effort */ } }
      }
    })();
    return () => { alive = false; };
  }, [activeOrgId, uid, activeRole]);

  return null;
}
