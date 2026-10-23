"use client";

// TimeZoneNudge — a project with no time zone runs its schedule on UTC.
// The times still read as typed, but "now" is compared against them in
// UTC: in Central time the schedule thinks it's 5–6 hours later than it
// is, so "plan by now", behind / on plan and which shift is current are
// all off. Say so plainly and fix it in one click (times stay as written).

import React, { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { browserTimeZone, tzLabel } from "@/lib/scheduleTz";
import { updateProjectMeta } from "@/lib/projects";

export default function TimeZoneNudge({ projectId, timezone, canManage, userId, onFixed }: {
  projectId: string; timezone?: string | null; canManage: boolean; userId: string; onFixed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const here = browserTimeZone();
  if (timezone || here === "UTC") return null;
  const offsetH = Math.round(-new Date().getTimezoneOffset() / 60);
  const fix = async () => {
    setBusy(true); setErr(null);
    try {
      await updateProjectMeta({ projectId, patch: { timezone: here }, keepWallClock: true, actorUserId: userId });
      onFixed();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 text-[12.5px] text-amber-900 dark:text-amber-200">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="flex-1 space-y-1.5">
        <div>
          <b>This project&apos;s time zone isn&apos;t set, so the schedule runs on UTC.</b> Your times read as you typed them,
          but &ldquo;now&rdquo; is {Math.abs(offsetH)} hour{Math.abs(offsetH) === 1 ? "" : "s"} {offsetH < 0 ? "ahead of" : "behind"} your clock there — so
          plan-by-now, behind / on plan and which shift is current are off.
        </div>
        {canManage ? (
          <button onClick={() => void fix()} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-bold px-2.5 py-1 disabled:opacity-60">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Set it to {tzLabel(here)} — times stay as written
          </button>
        ) : (
          <div>Ask the project owner to set it: Edit project → Time zone.</div>
        )}
        {err && <div className="text-rose-700 dark:text-rose-300">{err}</div>}
      </div>
    </div>
  );
}
