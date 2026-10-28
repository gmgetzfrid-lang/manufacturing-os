// timeLog — the running record of when things were done, for the project
// file: every step's start, progress, hold, done (at the time punched for
// it), with its work order, crew, comment and who entered it — plus the
// shift's safety incidents and notes. Kept out of the update email; it's
// its own export (Excel).

import type { Milestone, MilestoneNote, MilestoneStatus } from "@/types/schema";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { shiftAt, type ShiftTimes } from "@/lib/shiftReport";
import type { ShiftRecord } from "@/lib/shiftRecord";

export interface TimeLogRow {
  at: number;
  /** "Tue, Oct 27 · Day" */
  shift: string;
  task: string;
  wo: string;
  step: string;
  crew: string;
  /** "Started", "Progress", "Done", "On hold", … */
  what: string;
  /** "12% → 45%" */
  pct: string;
  comment: string;
  enteredBy: string;
  /** When it was typed in, when that was later than it happened. */
  enteredAt: number | null;
}

type LogRow = ProgressLogRow & { entered_at?: string | null };

const ms = (v: string | number | Date | null | undefined) => (v == null ? NaN : typeof v === "number" ? v : v instanceof Date ? v.getTime() : Date.parse(v));

const WHAT: Partial<Record<MilestoneStatus, string>> = { completed: "Done", on_hold: "On hold", blocked: "Blocked", missed: "Missed" };

/** What a logged change was, in plain words. */
export function describeChange(oldS: MilestoneStatus | null, oldP: number | null, newS: MilestoneStatus, newP: number | null): string {
  const o = Number(oldP ?? 0), n = Number(newP ?? 0);
  if (WHAT[newS] && oldS !== newS) return oldS === "on_hold" || oldS === "blocked" ? `${WHAT[newS]} (was ${oldS === "on_hold" ? "on hold" : "blocked"})` : WHAT[newS]!;
  if (newS === "planned") return oldS && oldS !== "planned" ? "Set back to not started" : "Not started";
  if (newS === "in_progress") {
    if (oldS === "on_hold" || oldS === "blocked") return `Off ${oldS === "on_hold" ? "hold" : "block"}, in progress`;
    if (oldS === "completed") return "Reopened";
    if (oldS === "planned" || oldS == null) return "Started";
    return n < o ? "Progress corrected down" : "Progress";
  }
  return n !== o ? "Progress" : (WHAT[newS] ?? newS);
}

export function buildTimeLog(input: {
  milestones: Milestone[];
  log: LogRow[];
  notes: MilestoneNote[];
  records?: Map<string, ShiftRecord>;
  tz: string;
  times: ShiftTimes;
  /** Only this window (a shift); default the whole job. */
  from?: number; to?: number;
}): TimeLogRow[] {
  const { tz, times } = input;
  const byId = new Map(input.milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const parents = new Set(input.milestones.map((m) => m.parentId).filter(Boolean) as string[]);
  const shiftOf = (at: number) => {
    const w = shiftAt(at, tz, times);
    const d = new Date(w.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
    return `${d} · ${w.kind === "day" ? "Day" : "Night"}`;
  };
  const inRange = (at: number) => Number.isFinite(at) && (input.from == null || at >= input.from) && (input.to == null || at < input.to);
  const base = (id: string) => {
    const m = byId.get(id);
    const p = m?.parentId ? byId.get(m.parentId) : undefined;
    return {
      task: p?.name ?? m?.name ?? "", step: m && p ? m.name : "",
      wo: m?.workOrderRef?.trim() || p?.workOrderRef?.trim() || "", crew: m?.responsibleParty?.trim() || "",
    };
  };
  // Notes by step, oldest first; each used once.
  const notesBy = new Map<string, MilestoneNote[]>();
  for (const n of [...input.notes].sort((a, b) => ms(a.createdAt) - ms(b.createdAt))) {
    if (!notesBy.has(n.milestoneId)) notesBy.set(n.milestoneId, []);
    notesBy.get(n.milestoneId)!.push(n);
  }
  const used = new Set<MilestoneNote>();
  // The note written with a change — one that says something first (a
  // change can leave a bare status note beside the one with the reason).
  const near = (id: string, kind: MilestoneNote["kind"], t: number, slackMs = 120_000) => {
    const c = (notesBy.get(id) ?? []).filter((n) => !used.has(n) && n.kind === kind && Math.abs(ms(n.createdAt) - t) <= slackMs);
    return c.find((n) => n.body?.trim()) ?? c[0];
  };

  const out: TimeLogRow[] = [];
  for (const r of input.log) {
    const m = byId.get(r.milestone_id);
    if (!m || parents.has(r.milestone_id) || m.isSummary) continue;
    // The log's own start line (old = new, or a step being created) isn't a change.
    if (r.old_status == null || (r.old_status === r.new_status && Number(r.old_percent ?? 0) === Number(r.new_percent ?? 0))) continue;
    const at = ms(r.at);
    if (!inRange(at)) continue;
    const entered = ms(r.entered_at ?? r.at);
    const status = near(r.milestone_id, "status", entered);
    const comment = near(r.milestone_id, "note", entered);
    if (status) used.add(status);
    if (comment) used.add(comment);
    // A hold's reason is the status note's text; work's comment is the note.
    const reason = r.new_status === "on_hold" || r.new_status === "blocked" ? status?.body?.trim() : undefined;
    const o = Number(r.old_percent ?? 0), n = Number(r.new_percent ?? 0);
    out.push({
      at, shift: shiftOf(at), ...base(r.milestone_id),
      what: describeChange(r.old_status, r.old_percent, r.new_status, r.new_percent),
      pct: o !== n ? `${o}% → ${n}%` : `${n}%`,
      comment: [reason, comment?.body?.trim()].filter(Boolean).join(" — "),
      enteredBy: comment?.createdByName ?? status?.createdByName ?? "",
      enteredAt: Number.isFinite(entered) && entered - at > 5 * 60_000 ? entered : null,
    });
  }
  // Comments and "why it's behind" said on their own.
  for (const n of input.notes) {
    if (used.has(n) || (n.kind !== "note" && n.kind !== "behind") || !n.body?.trim()) continue;
    const at = ms(n.happenedAt ?? n.createdAt);
    if (!inRange(at)) continue;
    const written = ms(n.createdAt);
    out.push({
      at, shift: shiftOf(at), ...base(n.milestoneId),
      what: n.kind === "behind" ? "Why it's behind" : "Comment", pct: "",
      comment: n.body.trim(), enteredBy: n.createdByName ?? "",
      enteredAt: written - at > 5 * 60_000 ? written : null,
    });
  }
  // The shifts' own record: incidents, notes & actions.
  for (const [, rec] of input.records ?? new Map<string, ShiftRecord>()) {
    for (const x of rec.incidents?.items ?? []) {
      if (!inRange(x.at)) continue;
      out.push({ at: x.at, shift: shiftOf(x.at), task: "Safety", wo: "", step: "", crew: "", what: `Safety incident — ${x.kind}`, pct: "", comment: x.text, enteredBy: x.by ?? "", enteredAt: null });
    }
    for (const x of rec.notes ?? []) {
      if (!inRange(x.at)) continue;
      out.push({ at: x.at, shift: shiftOf(x.at), task: "Notes & actions", wo: "", step: "", crew: "", what: x.followUp ? (x.cleared ? "Follow-up (cleared)" : "Follow-up") : "Note", pct: "", comment: x.text, enteredBy: x.by ?? "", enteredAt: null });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.task.localeCompare(b.task) || a.step.localeCompare(b.step));
}

/** The log as an Excel file, downloaded. */
export async function downloadTimeLog(rows: TimeLogRow[], o: { project: string; title: string; tz: string; fileName: string }): Promise<void> {
  const XLSX = await import("xlsx");
  const date = (at: number) => new Date(at).toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: o.tz });
  const time = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: o.tz });
  const head = ["Date", "Time", "Shift", "Task / equipment", "WO", "Step", "Crew", "What happened", "%", "Comment", "Entered by", "Entered at"];
  const aoa: (string | number)[][] = [
    [`${o.project} — ${o.title}`],
    [`Times are when the work was done, as entered. Exported ${date(Date.now())} ${time(Date.now())}.`],
    [],
    head,
    ...rows.map((r) => [date(r.at), time(r.at), r.shift, r.task, r.wo, r.step, r.crew, r.what, r.pct, r.comment, r.enteredBy, r.enteredAt != null ? `${date(r.enteredAt)} ${time(r.enteredAt)}` : ""]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [10, 6, 18, 34, 9, 40, 16, 24, 11, 60, 26, 16].map((wch) => ({ wch }));
  ws["!autofilter"] = { ref: `A4:L${aoa.length}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Time log");
  XLSX.writeFile(wb, o.fileName);
}
