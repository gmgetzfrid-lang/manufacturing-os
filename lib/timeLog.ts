// timeLog — the running record of when things were done, for the project
// file: every step's start, progress, hold, done (at the time punched for
// it), with its work order, crew, comment and who entered it — plus the
// shift's safety incidents and notes. Kept out of the update email; it's
// its own export (Excel).

import type { Milestone, MilestoneNote, MilestoneStatus } from "@/types/schema";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { shiftAt, TURNOVER_GRACE_MS, type ShiftTimes } from "@/lib/shiftReport";
import type { ShiftRecord } from "@/lib/shiftRecord";
import { discoveries, impactLine, ADDED, kindOf } from "@/lib/discovery";
import { inheritedWorkOrders, woOf } from "@/lib/workOrderCrew";

export interface TimeLogRow {
  at: number;
  /** The step it's about (none for the shift's own notes and incidents). */
  id?: string;
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

/** Each step's name as the log says it: two steps of one name under the
 *  same task ("Welded pipe replacements") are told apart, in plan order:
 *  "Welded pipe replacements (1 of 2)". */
export function stepLabels(milestones: Milestone[]): Map<string, string> {
  const groups = new Map<string, Milestone[]>();
  for (const m of milestones) {
    if (!m.id) continue;
    const k = `${m.parentId ?? ""}\u0000${m.name.trim().toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  const out = new Map<string, string>();
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => (ms(a.plannedStartAt) || Infinity) - (ms(b.plannedStartAt) || Infinity) || (ms(a.plannedAt) || Infinity) - (ms(b.plannedAt) || Infinity) || a.id!.localeCompare(b.id!));
    sorted.forEach((m, i) => out.set(m.id!, g.length > 1 ? `${m.name} (${i + 1} of ${g.length})` : m.name));
  }
  return out;
}

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
  // A step's WO is often only on its work order (the group above it).
  const wos = inheritedWorkOrders(input.milestones);
  const woFor = (m?: Milestone) => (m ? m.workOrderRef?.trim() || (m.id ? wos.get(m.id) : undefined) || woOf(m) : "");
  const shiftOf = (at: number) => {
    const w = shiftAt(at, tz, times);
    const d = new Date(w.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
    return `${d} · ${w.kind === "day" ? "Day" : "Night"}`;
  };
  const inRange = (at: number) => Number.isFinite(at) && (input.from == null || at >= input.from) && (input.to == null || at < input.to);
  const label = stepLabels(input.milestones);
  const base = (id: string) => {
    const m = byId.get(id);
    const p = m?.parentId ? byId.get(m.parentId) : undefined;
    return {
      task: p?.name ?? m?.name ?? "", step: m && p ? label.get(id) ?? m.name : "",
      wo: woFor(m) || woFor(p) || "", crew: m?.responsibleParty?.trim() || "",
    };
  };
  // Notes by step, oldest first; each used once.
  const notesBy = new Map<string, MilestoneNote[]>();
  for (const n of [...input.notes].sort((a, b) => ms(a.createdAt) - ms(b.createdAt))) {
    if (!notesBy.has(n.milestoneId)) notesBy.set(n.milestoneId, []);
    notesBy.get(n.milestoneId)!.push(n);
  }
  const used = new Set<MilestoneNote>();
  // The log's changes (its own start line, old = new or a step being
  // created, isn't one).
  const changes = input.log.filter((r) => {
    const m = byId.get(r.milestone_id);
    return !!m && !parents.has(r.milestone_id) && !m.isSummary && r.old_status != null
      && !(r.old_status === r.new_status && Number(r.old_percent ?? 0) === Number(r.new_percent ?? 0));
  }).map((r) => ({ r, at: ms(r.at), entered: ms(r.entered_at ?? r.at) }));
  // Each note goes with the change it was saved with: saved within two
  // minutes of it, about the time the change is for (a note keeps the time
  // it's about), else the change entered closest to it. One entry can make
  // two changes (a start at 7:00 and its 25% now): its comment is the one
  // about now. A note that says something first (a change can leave a bare
  // status note beside the one with the reason).
  const statusOf = new Map<number, MilestoneNote>(), noteOf = new Map<number, MilestoneNote>();
  const pairs: Array<{ i: number; n: MilestoneNote; score: number }> = [];
  changes.forEach((c, i) => {
    for (const n of notesBy.get(c.r.milestone_id) ?? []) {
      if (n.kind !== "status" && n.kind !== "note") continue;
      const gap = Math.abs(ms(n.createdAt) - c.entered);
      if (!(gap <= 120_000)) continue;
      const about = n.happenedAt != null && Math.abs(ms(n.happenedAt) - c.at) <= 60_000;
      pairs.push({ i, n, score: (about ? 0 : 1e9) + (n.body?.trim() ? 0 : 1e7) + gap });
    }
  });
  for (const p of pairs.sort((a, b) => a.score - b.score)) {
    const to = p.n.kind === "status" ? statusOf : noteOf;
    if (used.has(p.n) || to.has(p.i)) continue;
    to.set(p.i, p.n);
    used.add(p.n);
  }

  const out: TimeLogRow[] = [];
  for (const [i, { r, at, entered }] of changes.entries()) {
    if (!inRange(at)) continue;
    const status = statusOf.get(i);
    const comment = noteOf.get(i);
    // A hold's reason is the status note's text; work's comment is the note.
    const reason = r.new_status === "on_hold" || r.new_status === "blocked" ? status?.body?.trim() : undefined;
    const o = Number(r.old_percent ?? 0), n = Number(r.new_percent ?? 0);
    out.push({
      at, id: r.milestone_id, shift: shiftOf(at), ...base(r.milestone_id),
      what: describeChange(r.old_status, r.old_percent, r.new_status, r.new_percent),
      pct: o !== n ? `${o}% → ${n}%` : `${n}%`,
      comment: [reason, comment?.body?.trim()].filter(Boolean).join(" - "),
      enteredBy: comment?.createdByName ?? status?.createdByName ?? "",
      enteredAt: Number.isFinite(entered) && entered - at > 5 * 60_000 ? entered : null,
    });
  }
  // Comments and "why it's behind" said on their own — under the shift the
  // report puts them on (lib/shiftReport notesForShift): one with a time,
  // that time's; one typed without, the turnover it was written at.
  for (const n of input.notes) {
    if (used.has(n) || (n.kind !== "note" && n.kind !== "behind") || !n.body?.trim()) continue;
    const at = ms(n.happenedAt ?? n.createdAt);
    const forShift = n.happenedAt ? at : at - TURNOVER_GRACE_MS;
    if (!inRange(forShift)) continue;
    const written = ms(n.createdAt);
    out.push({
      at, id: n.milestoneId, shift: shiftOf(forShift), ...base(n.milestoneId),
      what: n.kind === "behind" ? "Why it's behind" : "Comment", pct: "",
      comment: n.body.trim(), enteredBy: n.createdByName ?? "",
      enteredAt: written - at > 5 * 60_000 ? written : null,
    });
  }
  // Discovery work: when it was found, the work it added, what it did.
  for (const d of discoveries(input.milestones)) {
    const at = d.record.foundAt;
    if (!inRange(at)) continue;
    out.push({
      at, shift: shiftOf(at), task: d.task?.name ?? "", step: d.steps.map((s) => s.name).join("; "),
      // Its own WO # when it was given one, else the task's.
      wo: d.steps[0]?.workOrderRef?.trim() || woFor(d.task) || woFor(d.steps[0]) || "", crew: [...new Set(d.steps.map((s) => s.responsibleParty?.trim()).filter(Boolean))].join(", "),
      what: `${ADDED[kindOf(d.record)].word} ${ADDED[kindOf(d.record)].found}`, pct: "",
      comment: `${d.record.what} - ${impactLine(d.record.impact, (h) => `${h} h`)}${d.record.approvedBy ? ` · approved by ${d.record.approvedBy}` : ""}`,
      enteredBy: d.record.addedBy ?? d.record.foundBy ?? "", enteredAt: d.record.addedAt - at > 5 * 60_000 ? d.record.addedAt : null,
    });
  }
  // The shifts' own record: incidents, notes & actions.
  for (const [, rec] of input.records ?? new Map<string, ShiftRecord>()) {
    for (const x of rec.incidents?.items ?? []) {
      if (!inRange(x.at)) continue;
      out.push({ at: x.at, shift: shiftOf(x.at), task: "Safety", wo: "", step: "", crew: "", what: `Safety incident - ${x.kind}`, pct: "", comment: x.text, enteredBy: x.by ?? "", enteredAt: null });
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
  const time = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: o.tz });
  const head = ["Date", "Time", "Shift", "Task / equipment", "WO", "Step", "Crew", "What happened", "%", "Comment", "Entered by", "Entered at"];
  const aoa: (string | number)[][] = [
    [`${o.project} - ${o.title}`],
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
