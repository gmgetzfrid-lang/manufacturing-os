// scheduleRules — the small, testable rules behind "the system records what
// you told it, never guesses, and makes it one click to take back".
//
//   • parseIsoDurationHours   MS Project's PT4H30M0S → 4.5
//   • mergeImportedProgress   a re-import never takes progress away
//   • completionNote          "done Oct 25 · 3 days early" wherever a
//                              finished task appears off its planned day
//   • needsFutureConfirm      marking work that is planned more than a day
//                              ahead asks once before it lands
// Pure functions; views and data writers call them.

import type { MilestoneStatus } from "@/types/schema";
import { dayDiff, fmtInTz } from "@/lib/scheduleTz";

/** "PT40H0M0S" / "PT4H30M" / "P1DT2H" → hours. Null when unparseable or 0. */
export function parseIsoDurationHours(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(raw.trim());
  if (!m) return null;
  const d = Number(m[1] ?? 0), h = Number(m[2] ?? 0), min = Number(m[3] ?? 0), s = Number(m[4] ?? 0);
  // MS Project writes <Duration> in working time; treat a D as an 8 h day
  // (its own default) so P1DT2H reads as 10 h, not 26.
  const hours = d * 8 + h + min / 60 + s / 3600;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.round(hours * 100) / 100;
}

export interface LiveProgress {
  status: MilestoneStatus;
  percent: number;
  actualAt: string | null;
  actualStartAt: string | null;
}

/** What a re-import may write for status/progress on a row that already
 *  exists: never lower the live %, never clear live actuals. The file can
 *  only RAISE progress (it was updated on the floor after the last import),
 *  and then the stamps follow. Returns null when nothing should change. */
export function mergeImportedProgress(live: LiveProgress, filePercent: number | null | undefined, nowIso: string): Partial<{
  percent_complete: number; status: MilestoneStatus; actual_at: string | null; actual_start_at: string | null; first_completed_at: string;
}> | null {
  const fp = filePercent != null && Number.isFinite(filePercent) ? Math.max(0, Math.min(100, Math.round(filePercent))) : 0;
  const livePct = Math.max(0, Math.min(100, Math.round(live.percent)));
  const liveException = live.status === "blocked" || live.status === "on_hold" || live.status === "missed";
  if (fp <= livePct) return null;                 // file is behind the floor → keep the floor
  if (liveException && fp < 100) return null;     // a hold/block stays until a person lifts it
  const out: ReturnType<typeof mergeImportedProgress> = { percent_complete: fp };
  if (fp >= 100) {
    out.status = "completed";
    out.actual_at = live.actualAt ?? nowIso;
    out.actual_start_at = live.actualStartAt ?? nowIso;
    out.first_completed_at = live.actualAt ?? nowIso;
  } else {
    out.status = "in_progress";
    out.actual_start_at = live.actualStartAt ?? nowIso;
  }
  return out;
}

/** "done Oct 25 · 3 days early" / "done Oct 29 · 1 day late" / null when it
 *  finished on its planned day (or has no completion stamp). */
export function completionNote(actualAt: string | number | Date | null | undefined, plannedFinishMs: number, tz: string): string | null {
  if (actualAt == null || actualAt === "") return null;
  const a = actualAt instanceof Date ? actualAt.getTime() : typeof actualAt === "number" ? actualAt : Date.parse(actualAt);
  if (!Number.isFinite(a) || !Number.isFinite(plannedFinishMs)) return null;
  const days = dayDiff(a, plannedFinishMs, tz); // positive = finished before the planned day
  const when = fmtInTz(a, tz, { month: "short", day: "numeric" });
  if (days === 0) return null;
  const n = Math.abs(days);
  return `done ${when} · ${n} day${n === 1 ? "" : "s"} ${days > 0 ? "early" : "late"}`;
}

/** Chip-sized variant: "3d early" / "1d late" / null. */
export function completionNoteShort(actualAt: string | number | Date | null | undefined, plannedFinishMs: number, tz: string): string | null {
  if (actualAt == null || actualAt === "") return null;
  const a = actualAt instanceof Date ? actualAt.getTime() : typeof actualAt === "number" ? actualAt : Date.parse(actualAt);
  if (!Number.isFinite(a) || !Number.isFinite(plannedFinishMs)) return null;
  const days = dayDiff(a, plannedFinishMs, tz);
  if (days === 0) return null;
  return `${Math.abs(days)}d ${days > 0 ? "early" : "late"}`;
}

/** Ask before recording progress on work planned more than a day ahead —
 *  the one cheap guard against a mis-click on the wrong day. */
export function needsFutureConfirm(plannedStartMs: number, nowMs: number, nextStatus: MilestoneStatus | null, nextPercent: number | null): boolean {
  if (!Number.isFinite(plannedStartMs)) return false;
  const touchesProgress = nextStatus === "completed" || nextStatus === "in_progress" || (nextPercent != null && nextPercent > 0);
  return touchesProgress && plannedStartMs - nowMs > 24 * 3600_000;
}
