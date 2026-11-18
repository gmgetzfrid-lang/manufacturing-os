// msProject - a schedule as a Microsoft Project file (the XML format Project
// opens with File > Open, "XML Format"): work orders as summary tasks with
// their steps under them, links, crews as resources, and the plant's day,
// night and around-the-clock calendars.
//
//   - The as-built schedule: each step on the dates it was really done, held
//     there (manually scheduled), with the original plan as Baseline, % done,
//     and the actual start and finish where recorded.
//   - The suggested schedule: each activity scheduled by Project from its
//     links, its calendar and its hours, held no earlier than the start the
//     suggestion gives it (so a crew's queue keeps its order).
//
// Pure: no database here.

import { wallClock } from "@/lib/scheduleTz";
import { noEmDash } from "@/lib/noEmDash";
import type { AsBuilt } from "@/lib/asBuiltSchedule";
import type { NextPlan } from "@/lib/nextPlan";

export type MspCal = "day" | "night" | "both";
export interface MspTask {
  /** Unique within the file; links refer to it. */
  key: string;
  name: string;
  /** 1: a work order (its steps under it); 2: a step. */
  level: 1 | 2;
  summary?: boolean;
  start: number; finish: number;
  /** Working hours on its calendar. */
  hours: number;
  cal: MspCal;
  preds?: string[];
  /** Held on its dates (the as-built record). */
  manual?: boolean;
  /** Start no earlier than (the suggested schedule). */
  snet?: number | null;
  pct?: number;
  actualStart?: number | null; actualFinish?: number | null;
  baseline?: { start: number; finish: number } | null;
  resource?: string | null;
  notes?: string;
}

const esc = (s: string) => noEmDash(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pad = (n: number) => String(n).padStart(2, "0");
/** A time on the plant's clock, as Project reads it. */
export function mspTime(t: number, tz: string): string {
  const w = wallClock(t, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:00`;
}
/** Hours as a Project duration. */
export function mspDuration(hours: number): string {
  const m = Math.max(0, Math.round(hours * 60));
  return `PT${Math.floor(m / 60)}H${m % 60}M0S`;
}
/** Hours between two times on the plant's wall clock. */
const wallHours = (a: number, b: number, tz: string) => Math.max(0, (Date.parse(`${mspTime(b, tz)}Z`) - Date.parse(`${mspTime(a, tz)}Z`)) / 3_600_000);
const hhmm = (s: string) => `${(s || "06:00").slice(0, 5)}:00`;

const CAL_UID: Record<MspCal, number> = { both: 1, day: 2, night: 3 };

function calendarsXml(times: { dayStart: string; nightStart: string }): string {
  const day = hhmm(times.dayStart), night = hhmm(times.nightStart);
  const week = (spans: Array<[string, string]>) => [1, 2, 3, 4, 5, 6, 7].map((d) =>
    `<WeekDay><DayType>${d}</DayType><DayWorking>1</DayWorking><WorkingTimes>${spans.map(([f, t]) => `<WorkingTime><FromTime>${f}</FromTime><ToTime>${t}</ToTime></WorkingTime>`).join("")}</WorkingTimes></WeekDay>`).join("");
  const cal = (uid: number, name: string, spans: Array<[string, string]>) =>
    `<Calendar><UID>${uid}</UID><Name>${esc(name)}</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID><WeekDays>${week(spans)}</WeekDays></Calendar>`;
  return `<Calendars>${cal(1, "24 Hours", [["00:00:00", "00:00:00"]])}${cal(2, "Day shift", [[day, night]])}${cal(3, "Night shift", [["00:00:00", day], [night, "00:00:00"]])}</Calendars>`;
}

/** The file. `title`: the project and what this is ("Transmix, suggested schedule, Phase 2"). */
export function msProjectXml(o: { title: string; tz: string; times: { dayStart: string; nightStart: string }; tasks: MspTask[] }): string {
  const { tz } = o;
  const uid = new Map(o.tasks.map((t, i) => [t.key, i + 1]));
  const start = Math.min(...o.tasks.map((t) => t.start)), finish = Math.max(...o.tasks.map((t) => t.finish));
  let outline = 0, sub = 0;
  const crews = [...new Set(o.tasks.map((t) => t.resource?.trim()).filter((r): r is string => !!r))];
  const resUid = new Map(crews.map((c, i) => [c, i + 1]));
  const tasks = o.tasks.map((t, i) => {
    if (t.level === 1) { outline++; sub = 0; } else sub++;
    const num = t.level === 1 ? `${outline}` : `${outline}.${sub}`;
    // Project's clock has no daylight saving: around-the-clock time is the
    // wall-clock hours between start and finish (7 h across the night the
    // clocks go back reads 6).
    const dur = t.summary || t.manual || t.cal === "both" ? wallHours(t.start, t.finish, tz) : t.hours;
    const preds = (t.preds ?? []).map((k) => uid.get(k)).filter((u): u is number => u != null && u !== i + 1);
    const snet = !t.manual && !t.summary && t.snet != null;
    return `<Task><UID>${i + 1}</UID><ID>${i + 1}</ID><Name>${esc(t.name)}</Name><Type>1</Type><IsNull>0</IsNull>`
      + `<OutlineNumber>${num}</OutlineNumber><OutlineLevel>${t.level}</OutlineLevel><Priority>500</Priority>`
      + `<Start>${mspTime(t.start, tz)}</Start><Finish>${mspTime(t.finish, tz)}</Finish><Duration>${mspDuration(dur)}</Duration>`
      + (t.manual ? `<ManualStart>${mspTime(t.start, tz)}</ManualStart><ManualFinish>${mspTime(t.finish, tz)}</ManualFinish><ManualDuration>${mspDuration(dur)}</ManualDuration>` : "")
      + `<DurationFormat>${t.manual || t.summary ? 6 : 5}</DurationFormat><EffortDriven>0</EffortDriven><Estimated>0</Estimated><Milestone>${dur === 0 && !t.summary ? 1 : 0}</Milestone><Summary>${t.summary ? 1 : 0}</Summary>`
      + `<PercentComplete>${Math.round(Math.max(0, Math.min(100, t.pct ?? 0)))}</PercentComplete>`
      + (t.actualStart != null ? `<ActualStart>${mspTime(t.actualStart, tz)}</ActualStart>` : "")
      + (t.actualFinish != null ? `<ActualFinish>${mspTime(t.actualFinish, tz)}</ActualFinish>` : "")
      + `<ConstraintType>${snet ? 4 : 0}</ConstraintType><CalendarUID>${t.summary ? -1 : CAL_UID[t.cal]}</CalendarUID>`
      + (snet ? `<ConstraintDate>${mspTime(t.snet!, tz)}</ConstraintDate>` : "")
      + `<IgnoreResourceCalendar>1</IgnoreResourceCalendar>`
      + (t.notes ? `<Notes>${esc(t.notes)}</Notes>` : "")
      + preds.map((p) => `<PredecessorLink><PredecessorUID>${p}</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`).join("")
      + (t.baseline ? `<Baseline><Number>0</Number><Start>${mspTime(t.baseline.start, tz)}</Start><Finish>${mspTime(t.baseline.finish, tz)}</Finish><Duration>${mspDuration(wallHours(t.baseline.start, t.baseline.finish, tz))}</Duration></Baseline>` : "")
      + `<Active>1</Active><Manual>${t.manual ? 1 : 0}</Manual></Task>`;
  }).join("");
  const resources = crews.map((c) => `<Resource><UID>${resUid.get(c)}</UID><ID>${resUid.get(c)}</ID><Name>${esc(c)}</Name><Type>1</Type><IsNull>0</IsNull></Resource>`).join("");
  let a = 0;
  const assignments = o.tasks.flatMap((t, i) => (t.resource?.trim() && !t.summary ? [`<Assignment><UID>${++a}</UID><TaskUID>${i + 1}</TaskUID><ResourceUID>${resUid.get(t.resource.trim())}</ResourceUID><Units>1</Units></Assignment>`] : [])).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Project xmlns="http://schemas.microsoft.com/project">`
    + `<SaveVersion>14</SaveVersion><Name>${esc(o.title)}.xml</Name><Title>${esc(o.title)}</Title><ScheduleFromStart>1</ScheduleFromStart>`
    + `<StartDate>${mspTime(start, tz)}</StartDate><FinishDate>${mspTime(finish, tz)}</FinishDate><CalendarUID>1</CalendarUID>`
    + `<DefaultStartTime>${hhmm(o.times.dayStart)}</DefaultStartTime><DefaultFinishTime>${hhmm(o.times.nightStart)}</DefaultFinishTime>`
    + `<MinutesPerDay>720</MinutesPerDay><MinutesPerWeek>5040</MinutesPerWeek><DaysPerMonth>30</DaysPerMonth><DefaultTaskType>1</DefaultTaskType><DurationFormat>5</DurationFormat><HonorConstraints>1</HonorConstraints>`
    + calendarsXml(o.times)
    + `<Tasks>${tasks}</Tasks><Resources>${resources}</Resources><Assignments>${assignments}</Assignments></Project>`;
}

// ─── The two schedules ──────────────────────────────────────────────

/** The as-built schedule: every step held on the dates it was really done
 *  (a step still going runs to `now`; one not started sits on its plan),
 *  the original plan as Baseline. `dependsOn`: the schedule's links. */
export function asBuiltTasks(a: AsBuilt, dependsOn: Map<string, string[]>, now: number): MspTask[] {
  const ids = new Set(a.orders.flatMap((o) => o.steps.map((s) => s.id)));
  const out: MspTask[] = [];
  for (const o of a.orders) {
    const steps: MspTask[] = o.steps.map((s) => {
      const start = s.barStart ?? s.planStart ?? now;
      const finish = s.finish ?? (s.status === "not_started" ? Math.max(start, s.planFinish ?? start) : Math.max(start, now));
      const notes = [s.added ? `Added after the plan: ${s.added}.` : "", s.status === "done" && s.start == null ? "Start not recorded: shown from its planned start." : "", s.status !== "done" && s.status !== "not_started" ? `Not finished: ${s.pct}% done.` : ""].filter(Boolean).join(" ");
      return {
        key: s.id, name: s.name, level: 2, start, finish, hours: (finish - start) / 3_600_000, cal: "both", manual: true,
        pct: s.pct, actualStart: s.start, actualFinish: s.finish,
        baseline: s.planStart != null && s.planFinish != null ? { start: s.planStart, finish: s.planFinish } : null,
        resource: s.crew, preds: (dependsOn.get(s.id) ?? []).filter((p) => ids.has(p)), notes: notes || undefined,
      };
    });
    if (!steps.length) continue;
    out.push({
      key: `wo:${o.key}`, name: `${o.wo ? `WO ${o.wo} · ` : ""}${o.name}`, level: 1, summary: true,
      start: Math.min(...steps.map((s) => s.start)), finish: Math.max(...steps.map((s) => s.finish)), hours: 0, cal: "both", manual: true,
      pct: Math.round((o.done / o.steps.length) * 100),
      baseline: o.planStart != null && o.planFinish != null ? { start: o.planStart, finish: o.planFinish } : null,
      notes: [o.foundOn ? `Found on ${o.foundOn}.` : "", o.phase ? `${o.phase}.` : ""].filter(Boolean).join(" ") || undefined,
    }, ...steps);
  }
  return out;
}

/** The suggested schedule: each activity on its calendar for its hours,
 *  after its links, no earlier than the start the suggestion gives it. */
export function suggestedTasks(plan: NextPlan, orderName: (key: string) => string): MspTask[] {
  const out: MspTask[] = [];
  if (plan.pre.length) {
    out.push({ key: "pre", name: "Before the shutdown", level: 1, summary: true, start: plan.start, finish: plan.start, hours: 0, cal: "both" });
    for (const a of plan.pre) out.push({ key: a.id, name: a.name, level: 2, start: plan.start, finish: plan.start, hours: 0, cal: "both", snet: null, resource: a.crew === "Not set" ? null : a.crew, notes: a.basis || "Done before the shutdown." });
  }
  const byOrder = new Map<string, NextPlan["acts"]>();
  for (const a of plan.acts) byOrder.set(a.order, [...(byOrder.get(a.order) ?? []), a]);
  const orders = [...byOrder.entries()].sort((x, y) => Math.min(...x[1].map((a) => a.start)) - Math.min(...y[1].map((a) => a.start)));
  for (const [key, acts] of orders) {
    const list = [...acts].sort((a, b) => a.start - b.start);
    out.push({ key: `wo:${key}`, name: orderName(key) || "Work order", level: 1, summary: true, start: list[0].start, finish: Math.max(...list.map((a) => a.finish)), hours: 0, cal: "both" });
    for (const a of list) out.push({
      key: a.id, name: a.name, level: 2, start: a.start, finish: a.finish, hours: a.hours, cal: a.cal, snet: a.start,
      preds: a.preds, resource: a.crew === "Not set" ? null : a.crew,
      notes: [a.basis, plan.driving.includes(a.id) ? "Sets the finish." : "", a.heldForCrew ? "Waits for its crew." : ""].filter(Boolean).join(" ") || undefined,
    });
  }
  return out;
}
