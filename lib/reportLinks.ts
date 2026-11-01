// reportLinks - the project's reports, one name each, and how a button
// elsewhere (the hour-by-hour export on Today, Print on Work orders) opens
// one in Reports already set to its shift or work order.

export type ReportId = "turnover" | "hourly" | "timelog" | "schedule" | "workorders" | "kickoff" | "closeout" | "field";

export interface ReportMeta { id: ReportId; name: string; sub: string; form?: boolean }

/** Reports (filled in from the project), then forms (blank, by hand). */
export const REPORTS: ReportMeta[] = [
  { id: "turnover", name: "Shift turnover", sub: "The update after each shift · print, email" },
  { id: "hourly", name: "Hourly log", sub: "Hour by hour, a shift or every shift · PDF, Word, Excel" },
  { id: "timelog", name: "Time log", sub: "Every step, the time each thing was done · Excel" },
  { id: "schedule", name: "Schedule report", sub: "Complete, pace, forecast finish · print" },
  { id: "workorders", name: "Work order report", sub: "Plan against actual, each work order · print" },
  { id: "kickoff", name: "Kick-off", sub: "Start of the project · present, print, email" },
  { id: "closeout", name: "Close-out", sub: "End of the project · present, print, email" },
  { id: "field", name: "Field tracker", sub: "Starts, finishes, % and notes, by pen", form: true },
];

export const reportName = (id: ReportId) => REPORTS.find((r) => r.id === id)?.name ?? "";

export interface ShiftPick { dayKey: string; kind: "day" | "night" }

/** A report opened from elsewhere, set to what was on screen there. */
export interface ReportLink {
  id: ReportId;
  /** The shift (turnover, hourly log, time log). */
  shift?: ShiftPick;
  /** Time log: this shift, or the whole job. */
  scope?: "shift" | "job";
  /** Work order report: with each step's history. */
  history?: boolean;
  /** Work order report / field tracker: one work order (its key). */
  wo?: string;
  /** Work order report: which work orders ("open", "behind"…) and a search. */
  show?: string;
  query?: string;
  /** Each opening applies afresh, even of the same report. */
  n?: number;
}
