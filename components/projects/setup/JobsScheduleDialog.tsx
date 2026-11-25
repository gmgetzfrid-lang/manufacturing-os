"use client";

// JobsScheduleDialog - a schedule made from the project's jobs, for a job
// with no P6 or MS Project file (lib/jobsSchedule). Asks the one thing the
// project can't know: the hours each job takes, and when the work starts.
// Jobs run one after another, on day shifts unless nights are worked, and
// land on the Schedule tab like an imported schedule (changeable there).

import React, { useEffect, useState } from "react";
import { CalendarRange, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { field as fieldCls, label as labelCls } from "@/components/admin/kit";
import { useShiftTimes, saveProjectShiftTimes } from "@/lib/shiftTimesStore";
import { toDateTimeInput } from "@/lib/scheduleTz";
import { importMilestonesFromParsed } from "@/lib/milestones";
import { jobsSchedule, sayWall } from "@/lib/jobsSchedule";
import { isTypedItem, type ScopeWO } from "@/lib/woIntake";
import { sayError } from "@/components/projects/sayError";

const hhmm = (s: string) => (/^\d{1,2}:\d{2}/.exec(s)?.[0] ?? "06:00").padStart(5, "0");
const ampm = (s: string) => { const [h, m] = hhmm(s).split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };

export default function JobsScheduleDialog({ orgId, projectId, uid, actorName, tz, items, onClose, onMade }: {
  orgId: string; projectId: string; uid: string; actorName?: string; tz: string; items: ScopeWO[];
  onClose: () => void; onMade: (steps: number) => void;
}) {
  const times = useShiftTimes(projectId);
  const [start, setStart] = useState(() => `${toDateTimeInput(Date.now() + 86_400_000, tz).slice(0, 10)}T${hhmm(times.dayStart)}`);
  const [nights, setNights] = useState(times.nightJobs !== undefined && (times.nightJobs === "file" || times.nightJobs.length > 0));
  const [hours, setHours] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose, busy]);

  const w = { dayStart: times.dayStart, nightStart: times.nightStart, nights };
  const jobs = items.map((item) => ({ item, hours: Number(hours[item.wo]) }));
  const without = jobs.filter((j) => !(Number.isFinite(j.hours) && j.hours > 0)).length;
  const plan = jobsSchedule(jobs, start, w);
  const missing = !start ? "a start" : without ? `hours for ${without} job${without === 1 ? "" : "s"}` : null;

  const make = async () => {
    if (missing) { setError(`Add ${missing} first.`); return; }
    setBusy(true); setError(null);
    try {
      // The night question is answered here, so setup doesn't ask it again.
      const nightJobs = !nights ? [] : Array.isArray(times.nightJobs) && times.nightJobs.length ? times.nightJobs : "file" as const;
      if (JSON.stringify(nightJobs) !== JSON.stringify(times.nightJobs)) await saveProjectShiftTimes(projectId, { ...times, nightJobs });
      const res = await importMilestonesFromParsed({ orgId, projectId, timeZone: tz, baselineAll: true, source: "manual", rows: plan.rows, createdBy: uid, createdByName: actorName });
      if (res.errors.length && !res.inserted) throw new Error(res.errors[0]);
      window.dispatchEvent(new CustomEvent("schedule:changed"));
      onMade(res.inserted);
    } catch (e) { setError(sayError(e)); }
    finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="js-title" className="fixed inset-0 z-[200] bg-[var(--color-ink)]/55 flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="ui-float ui-float-in w-full max-w-2xl bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-6 pt-4 pb-4 border-b border-[var(--color-border)] flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 id="js-title" className="font-display text-section font-semibold text-[var(--color-text)]">Make the schedule from the jobs</h2>
            <p className="mt-0.5 text-body text-[var(--color-text-muted)]">Give each job its hours. They run one after another from the start, and you can change any of them on the Schedule tab.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="-mr-2 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-5 space-y-4 max-h-[66vh] overflow-y-auto">
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-3 items-end">
            <div><label htmlFor="js-start" className={labelCls}>Work starts</label><input id="js-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={fieldCls} /></div>
            <label className="flex items-center gap-2 min-h-11 text-body text-[var(--color-text)]">
              <input type="checkbox" checked={nights} onChange={(e) => setNights(e.target.checked)} className="w-5 h-5" />
              Nights are worked too
            </label>
          </div>
          <p className="text-caption text-[var(--color-text-muted)]">{nights ? "Work runs around the clock." : `Day shifts only: ${ampm(times.dayStart)} to ${ampm(times.nightStart)}, from the project's shift times.`}</p>
          <div className="rounded-lg border border-[var(--color-border)]">
            <div className="px-3 py-2 flex items-center gap-3 border-b border-[var(--color-border)] text-body font-semibold text-[var(--color-text)]"><span className="flex-1">Job</span><span className="w-24 text-right">Hours</span></div>
            <ul className="divide-y divide-[var(--color-border)]">
              {items.map((x) => (
                <li key={x.wo} className="px-3 py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-body text-[var(--color-text)] break-words">{x.what}</div>
                    <div className="text-caption text-[var(--color-text-muted)]">{[x.tag || x.equipment, isTypedItem(x.wo) ? "" : `WO ${x.wo}`].filter(Boolean).join(" · ") || "No equipment"}</div>
                  </div>
                  <div className="w-24 shrink-0">
                    <input aria-label={`Hours for ${x.what}`} inputMode="decimal" value={hours[x.wo] ?? ""} placeholder="hrs"
                      onChange={(e) => setHours((h) => ({ ...h, [x.wo]: e.target.value.replace(/[^\d.]/g, "") }))} className={`${fieldCls} text-right tabular-nums`} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
          {error && <ErrorNote title={error} />}
        </div>
        <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-body text-[var(--color-text-muted)]">{missing ? `Add ${missing} to make it.` : plan.finish ? <>Finishes <b className="text-[var(--color-text)]">{sayWall(plan.finish)}</b></> : null}</span>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void make()} disabled={!!missing} loading={busy}><CalendarRange className="w-4 h-4" /> Make the schedule</Button>
        </div>
      </div>
    </div>
  );
}
