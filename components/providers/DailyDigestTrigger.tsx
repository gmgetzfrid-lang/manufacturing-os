"use client";

// DailyDigestTrigger — fires the once-a-day in-app digest bell wherever the
// user lands (not just the scratchpad page), so opening the app anywhere still
// surfaces "you have overdue / due-today / aging to-dos". Gated to once per
// browser session; maybeNotifyMorningDigest is itself idempotent per day.

import { useEffect } from "react";
import { useRole } from "@/components/providers/RoleContext";
import { getDailyBrief, maybeNotifyMorningDigest } from "@/lib/notes";

const STALE_UNDATED_DAYS = 3;

export default function DailyDigestTrigger() {
  const { activeOrgId, uid } = useRole();
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
    })();
    return () => { alive = false; };
  }, [activeOrgId, uid]);

  return null;
}
