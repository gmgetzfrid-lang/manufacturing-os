"use client";

// ReportsView - every report of the project in one place, one name each.
// Left, the list: reports filled in from the project, then forms filled in
// by hand. Right, the one picked: its few choices (which shift, the
// format, the letterhead), page 1 as it will come out, and Download or
// Print. A button elsewhere (Hourly log on Today, Print on a work order)
// opens the same report here, already set to its shift or work order.
// On a phone the list comes first; a report opens full screen with a way
// back to the list.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Download, Loader2, Mail, Presentation, Printer, X } from "lucide-react";
import type { Milestone } from "@/types/schema";
import type { CancelledJob } from "@/lib/cancelledJobs";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import type { CriticalPathResult, PathMarks } from "@/lib/criticalPath";
import { defaultReviewShift, shiftWindow, type ShiftTimes } from "@/lib/shiftReport";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { dayKey, dayKeyToMs, fmtInTz } from "@/lib/scheduleTz";
import { useLetterhead } from "@/lib/letterheadStore";
import { REPORTS, type ReportId, type ReportLink, type ShiftPick } from "@/lib/reportLinks";
import type { ExportDoc } from "@/lib/reportExport";
import { copyUpdateForEmail, printHtml, updatePrintDocument, updateToSend } from "@/lib/updatePrint";
import { withWorkOrderCrews } from "@/lib/workOrderCrew";
import { loadProgressLog } from "@/lib/progressHistory";
import { loadShiftRecords, type ShiftRecord } from "@/lib/shiftRecord";
import { notesFor } from "@/lib/milestones";
import { buildTimeLog, downloadTimeLog, type TimeLogRow } from "@/lib/timeLog";
import { jobLogs, oneShiftLog, type ShiftLog } from "@/lib/hourlyLog";
import { hourlyLogPdf, hourlyLogTable, pngInBrowser, saveHourlyLog, type LogFormat } from "@/lib/hourlyLogFiles";
import { groupWorkOrders, findOrders, showsOrder, fieldOrdersOf, workOrdersPrintDocument, SHOW_WORD, type Show } from "@/lib/workOrderGroups";
import { fieldTrackerFor } from "@/lib/fieldTracker";
import { FieldTrackerOptions, type FieldChoice } from "@/components/projects/FieldTrackerPrint";
import ShiftReportView from "@/components/projects/ShiftReportView";
import ExecutionReportView from "@/components/projects/ExecutionReportView";
import type { MeetingKind } from "@/lib/meetingPlan";

interface Props {
  milestones: Milestone[];
  cancelled?: CancelledJob[];
  childrenByParent: Map<string, Milestone[]>;
  progress?: Map<string, ProgressInfo>;
  shiftTimes: ShiftTimes;
  projectId: string;
  projectName?: string;
  canEdit: boolean;
  userId?: string;
  userName?: string;
  critical?: CriticalPathResult;
  criticalSource?: string;
  marks?: PathMarks;
  pathNow?: number;
  /** Opened from elsewhere, set to its shift or work order. */
  link?: ReportLink | null;
}

const SHOWS: Array<[Show, string]> = [["all", "All"], ["open", "Open"], ["behind", "Behind"], ["critical", "Critical path"], ["notStarted", "Not started"], ["held", "Held"], ["done", "Done"], ["added", "Discovery & added"]];
const MEETING_OF: Partial<Record<ReportId, MeetingKind>> = { turnover: "turnover", kickoff: "kickoff", closeout: "closeout" };
const FORMAT_NAME: Record<LogFormat, string> = { pdf: "PDF", docx: "Word", xlsx: "Excel" };

// ── Made lately: this device's last few, to make again with a tap ──
interface Made { report: ReportId; label: string; at: number; shift?: ShiftPick | null; every?: boolean; format?: LogFormat; scope?: "shift" | "job" }
const madeKey = (projectId: string) => `reports:made:${projectId}`;
function readMade(projectId: string): Made[] {
  try { const v = JSON.parse(localStorage.getItem(madeKey(projectId)) ?? "[]"); return Array.isArray(v) ? v as Made[] : []; } catch { return []; }
}

export default function ReportsView(p: Props) {
  const tz = useScheduleTz();
  const { projectId, shiftTimes: times } = p;
  const live = useMemo(() => withWorkOrderCrews(p.milestones), [p.milestones]);
  const { lh } = useLetterhead(projectId);

  const [sel, setSel] = useState<ReportId>("turnover");
  // Phone: the report open full screen (the list behind it).
  const [phoneOpen, setPhoneOpen] = useState(false);
  // The shift (turnover, hourly log, time log); null: the current one.
  const [shiftPick, setShiftPick] = useState<ShiftPick | null>(null);
  const [every, setEvery] = useState(false);
  const [format, setFormat] = useState<LogFormat>("pdf");
  const [useLh, setUseLh] = useState(true);
  const [scope, setScope] = useState<"shift" | "job">("shift");
  const [woShow, setWoShow] = useState<Show | "one">("all");
  const [woQuery, setWoQuery] = useState("");
  const [woKey, setWoKey] = useState("");
  const [woHistory, setWoHistory] = useState(false);
  const [fieldStart, setFieldStart] = useState<{ wo?: string; n: number }>({ n: 0 });
  const [field, setField] = useState<FieldChoice | null>(null);

  // A report opened from elsewhere: set to what was on screen there.
  const linkN = p.link?.n;
  useEffect(() => {
    const l = p.link;
    if (!l) return;
    setSel(l.id); setPhoneOpen(true);
    if (l.shift) { setShiftPick(l.shift); setEvery(false); }
    if (l.scope) setScope(l.scope);
    if (l.id === "workorders") {
      if (l.wo) { setWoShow("one"); setWoKey(l.wo); setWoQuery(""); }
      else { setWoShow((SHOWS.some(([k]) => k === l.show) ? l.show : "all") as Show); setWoQuery(l.query ?? ""); }
      setWoHistory(!!l.history);
    }
    if (l.id === "field") setFieldStart({ wo: l.wo, n: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per link
  }, [linkN]);

  // The shift on screen: the one picked, else the current one.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const current = useMemo(() => defaultReviewShift(live, now, tz, times), [live, now, tz, times]);
  const shift = useMemo(() => (shiftPick ? shiftWindow(shiftPick.dayKey, shiftPick.kind, tz, times) : current), [shiftPick, current, tz, times]);
  const shiftLabel = `${shift.kind === "day" ? "Day" : "Night"} shift ${fmtInTz(shift.start, tz, { weekday: "short", month: "short", day: "numeric" })}`;
  const name = (p.projectName ?? "Schedule").trim() || "Schedule";
  const fileBase = name.replace(/[\\/:*?"<>|]/g, "").trim() || "Schedule";

  // Made lately (this device).
  const [made, setMade] = useState<Made[]>([]);
  useEffect(() => { setMade(readMade(projectId)); }, [projectId]);
  const remember = (m: Omit<Made, "at">) => {
    const next = [{ ...m, at: Date.now() }, ...readMade(projectId).filter((x) => !(x.report === m.report && x.label === m.label))].slice(0, 6);
    try { localStorage.setItem(madeKey(projectId), JSON.stringify(next)); } catch { /* private mode */ }
    setMade(next);
  };
  const again = (m: Made) => {
    setSel(m.report);
    if (m.shift !== undefined) setShiftPick(m.shift);
    if (m.every != null) setEvery(m.every);
    if (m.format) setFormat(m.format);
    if (m.scope) setScope(m.scope);
  };

  // ── The job's records, read when a report needs them ──
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    const evs = ["schedule:changed", "milestone-notes:changed", "shift-record:changed"];
    for (const e of evs) window.addEventListener(e, on);
    return () => { for (const e of evs) window.removeEventListener(e, on); };
  }, []);
  const jobRef = useRef<{ key: string; p: Promise<{ log: Awaited<ReturnType<typeof loadProgressLog>>; records: Map<string, ShiftRecord>; notes: Awaited<ReturnType<typeof notesFor>> }> } | null>(null);
  const loadJob = useCallback(() => {
    const key = `${projectId}:${tick}:${live.length}`;
    if (jobRef.current?.key !== key) {
      const parents = new Set(live.map((m) => m.parentId).filter(Boolean));
      jobRef.current = {
        key,
        p: Promise.all([loadProgressLog(projectId), loadShiftRecords(projectId), notesFor(live.filter((m) => m.id && !parents.has(m.id)).map((m) => m.id!))])
          .then(([log, records, notes]) => ({ log, records, notes })),
      };
      jobRef.current.p.catch(() => { jobRef.current = null; });
    }
    return jobRef.current.p;
  }, [projectId, tick, live]);

  // ── Hourly log ──
  const hourlyLogs = useCallback(async (): Promise<ShiftLog[]> => {
    const { log, records, notes } = await loadJob();
    const at = Date.now();
    const timeLog = buildTimeLog({ milestones: live, log: log ?? [], notes, records, tz, times });
    const o = { milestones: live, timeLog, records, log: log ?? [], tz, times, now: at };
    return every ? jobLogs(o) : [oneShiftLog(o, shift)];
  }, [loadJob, live, tz, times, every, shift]);
  const hourlyName = every ? `${name} - hourly log, whole job` : `${name} - hourly log ${shift.dayKey} ${shift.kind}`;

  // ── Time log ──
  const timeRows = useCallback(async (): Promise<TimeLogRow[]> => {
    const { log, records, notes } = await loadJob();
    return buildTimeLog({ milestones: live, log: log ?? [], notes, records, tz, times, ...(scope === "shift" ? { from: shift.start, to: shift.end } : {}) });
  }, [loadJob, live, tz, times, scope, shift]);
  const timeTitle = scope === "shift" ? `Time log - ${shift.kind === "day" ? "Day shift" : "Night shift"} ${fmtInTz(shift.start, tz, { weekday: "short", month: "short", day: "numeric" })}` : "Time log - whole job to date";

  // ── Work orders and the field tracker ──
  const orders = useMemo(() => groupWorkOrders(p.milestones, p.childrenByParent, p.progress, tz, times, now), [p.milestones, p.childrenByParent, p.progress, tz, times, now]);
  const woShown = useMemo(() => (woShow === "one" ? orders.filter((o) => o.key === woKey) : findOrders(orders, woQuery).filter((o) => showsOrder(o, woShow, p.marks))), [orders, woShow, woKey, woQuery, p.marks]);
  const fieldOrders = useMemo(() => fieldOrdersOf(orders), [orders]);
  const woScope = woShow === "one" ? (woShown[0] ? `${woShown[0].wo ? `WO ${woShown[0].wo}` : "No WO"} · ${woShown[0].owner.name}` : "One work order")
    : `${SHOW_WORD[woShow]}${woQuery.trim() ? ` · search “${woQuery.trim()}”` : ""}`;

  // ── The meetings' update (turnover, kick-off, close-out) ──
  const meeting = MEETING_OF[sel];
  // Comes from the meeting's report, made off screen (below); a different
  // meeting or shift sends its own.
  const [doc, setDoc] = useState<ExportDoc | null>(null);
  const [presenting, setPresenting] = useState(false);

  // ── Page 1, as it will come out ──
  const [preview, setPreview] = useState<{ kind: "html"; html: string; landscape?: boolean } | { kind: "img"; src: string; pages: number } | { kind: "rows"; head: string[]; rows: string[][]; total: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const lhOn = useLh && !!lh ? lh : null;
  const previewSig = JSON.stringify([sel, shift.dayKey, shift.kind, every, format, !!lhOn, scope, woShow, woKey, woQuery, woHistory, field, tick, live.length, meeting ? doc : null]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      setPreviewErr(null);
      try {
        if (meeting) {
          setPreview(doc ? { kind: "html", html: updatePrintDocument(updateToSend(doc, meeting), lhOn) } : null);
          setPreviewBusy(!doc);
          return;
        }
        if (sel === "schedule") { setPreview(null); return; }
        setPreviewBusy(true);
        if (sel === "hourly") {
          const logs = await hourlyLogs();
          if (format === "xlsx") {
            const rows = hourlyLogTable(logs);
            if (alive) setPreview({ kind: "rows", head: ["Date", "Shift", "Time", "Type", "What happened"], rows: rows.slice(0, 40), total: rows.length });
          } else {
            const bytes = await hourlyLogPdf(logs, { project: name, lh: lhOn, toPng: pngInBrowser });
            const pg = await pdfPage1(bytes);
            if (alive) setPreview({ kind: "img", src: pg.src, pages: pg.pages });
          }
        } else if (sel === "timelog") {
          const rows = await timeRows();
          const d = (at: number) => fmtInTz(at, tz, { month: "numeric", day: "numeric", year: "numeric" });
          const tm = (at: number) => fmtInTz(at, tz, { hour: "numeric", minute: "2-digit", hour12: true });
          if (alive) setPreview({ kind: "rows", head: ["Date", "Time", "Shift", "Task / equipment", "WO", "Step", "Crew", "What happened", "%", "Comment"], rows: rows.slice(0, 40).map((r) => [d(r.at), tm(r.at), r.shift, r.task, r.wo, r.step, r.crew, r.what, r.pct, r.comment]), total: rows.length });
        } else if (sel === "workorders") {
          const html = await workOrdersPrintDocument({ shown: woShown, milestones: p.milestones, projectId, projectName: p.projectName, tz, times, progress: p.progress, format: woHistory ? "history" : "report", scope: `${woScope}${woHistory ? " · with each step's history" : ""}`, lh: lhOn });
          if (alive) setPreview({ kind: "html", html, landscape: true });
        } else if (sel === "field") {
          if (alive) setPreview(field ? { kind: "html", html: fieldTrackerFor(field, { project: name, tz, orders: fieldOrders, dayMs: (x) => dayKeyToMs(x, tz) }), landscape: true } : null);
        }
      } catch (e) {
        if (alive) { setPreview(null); setPreviewErr((e as Error).message); }
      } finally {
        if (alive && !meeting) setPreviewBusy(false);
      }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- previewSig is every input
  }, [previewSig]);

  // ── Download / Print ──
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setMsg(null); }, [sel]);
  const blocked = "Your browser blocked the print window - allow pop-ups for this site and try again.";
  const run = async (what: "download" | "print" | "email") => {
    setMsg(null);
    // A print window is opened at the tap, so the browser doesn't take it for a pop-up.
    const w = what === "print" && sel !== "hourly" ? window.open("", "_blank") : null;
    if (what === "print" && sel !== "hourly" && !w) { setMsg(blocked); return; }
    setBusy(true);
    try {
      if (meeting) {
        if (!doc) throw new Error("Still getting the report ready.");
        const picked = updateToSend(doc, meeting);
        if (what === "email") { setMsg((await copyUpdateForEmail(picked)) ? "Copied - paste into your email." : "Your browser blocked the copy - try again."); return; }
        printHtml(updatePrintDocument(picked, lhOn), w);
        remember({ report: sel, label: `${meeting === "turnover" ? shiftLabel : "Printed"}`, shift: shiftPick });
      } else if (sel === "hourly") {
        const logs = await hourlyLogs();
        if (what === "print") {
          const bytes = await hourlyLogPdf(logs, { project: name, lh: lhOn, toPng: pngInBrowser });
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
          const win = window.open(url, "_blank");
          if (!win) { setMsg(blocked); URL.revokeObjectURL(url); return; }
          setTimeout(() => URL.revokeObjectURL(url), 120_000);
        } else {
          await saveHourlyLog(logs, format, { project: name, lh: lhOn, toPng: pngInBrowser, fileName: hourlyName });
          setMsg(`${logs.length} shift${logs.length === 1 ? "" : "s"} saved.`);
        }
        remember({ report: "hourly", label: `${every ? "every shift" : shiftLabel} · ${what === "print" ? "printed" : FORMAT_NAME[format]}`, shift: shiftPick, every, format });
      } else if (sel === "timelog") {
        const rows = await timeRows();
        await downloadTimeLog(rows, { project: name, tz, title: timeTitle, fileName: `${fileBase} - time log${scope === "shift" ? ` ${shift.dayKey} ${shift.kind}` : ""}.xlsx` });
        setMsg(`${rows.length} entr${rows.length === 1 ? "y" : "ies"} exported.`);
        remember({ report: "timelog", label: scope === "shift" ? shiftLabel : "whole job", shift: shiftPick, scope });
      } else if (sel === "workorders") {
        const html = await workOrdersPrintDocument({ shown: woShown, milestones: p.milestones, projectId, projectName: p.projectName, tz, times, progress: p.progress, format: woHistory ? "history" : "report", scope: `${woScope}${woHistory ? " · with each step's history" : ""}`, lh: lhOn });
        printHtml(html, w);
        remember({ report: "workorders", label: woScope });
      } else if (sel === "field" && field) {
        printHtml(fieldTrackerFor(field, { project: name, tz, orders: fieldOrders, dayMs: (x) => dayKeyToMs(x, tz) }), w);
        remember({ report: "field", label: field.kind === "job" ? "whole project" : field.kind === "wo" ? "one work order" : field.kind === "step" ? "one step" : `${field.from} to ${field.to}` });
      }
    } catch (e) {
      w?.close();
      setMsg(`Not made: ${(e as Error).message}`);
    } finally { setBusy(false); }
  };

  const meta = REPORTS.find((r) => r.id === sel)!;
  const today = dayKey(now, tz);

  // ── Pieces ──
  const seg = (on: boolean) => `h-8 px-3 text-[12.5px] font-bold ${on ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`;
  // A labeled line of choices (a function, not a component: its inputs keep focus).
  const row = (label: string, children: React.ReactNode) => (
    <div className="grid grid-cols-[88px_1fr] sm:grid-cols-[100px_1fr] items-center gap-2 min-h-9">
      <span className="text-[12.5px] font-semibold text-[var(--color-text-muted)]">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
  const shiftRow = (
    row("Which", <>
      <span className="inline-flex rounded-lg border border-[var(--color-border-strong)] overflow-hidden" role="group" aria-label="Day or night">
        {(["day", "night"] as const).map((k) => (
          <button key={k} type="button" aria-pressed={shift.kind === k} onClick={() => setShiftPick({ dayKey: shift.dayKey, kind: k })} className={seg(shift.kind === k)}>{k === "day" ? "Day" : "Night"}</button>
        ))}
      </span>
      <input type="date" value={shift.dayKey} max={today} onChange={(e) => { if (e.target.value) setShiftPick({ dayKey: e.target.value, kind: shift.kind }); }} aria-label="Date"
        className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]" />
      {shiftPick && <button type="button" onClick={() => setShiftPick(null)} className="h-8 px-2.5 rounded-lg border border-[var(--color-border)] text-[12px] font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Current shift</button>}
    </>)
  );
  const lhRow = lh && sel !== "field" && sel !== "timelog" && !(sel === "hourly" && format === "xlsx") ? (
    row("Letterhead", <>
      <label className="inline-flex items-center gap-2 text-[12.5px] cursor-pointer select-none">
        <input type="checkbox" checked={useLh} onChange={(e) => setUseLh(e.target.checked)} className="w-4 h-4 accent-[var(--color-accent)]" />
        <span className="font-semibold">{lh.name || "Company letterhead"}</span>
      </label>
    </>)
  ) : null;
  const primary = "inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold hover:bg-[var(--color-accent-hover)] disabled:opacity-50";
  const secondary = "inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50";

  const options = (
    <div className="space-y-2">
      {sel === "turnover" && shiftRow}
      {sel === "hourly" && (
        <>
          {row("Shifts", <>
            <span className="inline-flex rounded-lg border border-[var(--color-border-strong)] overflow-hidden" role="group" aria-label="Shifts">
              <button type="button" aria-pressed={!every} onClick={() => setEvery(false)} className={seg(!every)}>One shift</button>
              <button type="button" aria-pressed={every} onClick={() => setEvery(true)} className={seg(every)}>Every shift</button>
            </span>
          </>)}
          {!every && shiftRow}
          {row("Format", <>
            <span className="inline-flex rounded-lg border border-[var(--color-border-strong)] overflow-hidden" role="group" aria-label="Format">
              {(["pdf", "docx", "xlsx"] as const).map((f) => <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)} className={seg(format === f)}>{FORMAT_NAME[f]}</button>)}
            </span>
          </>)}
        </>
      )}
      {sel === "timelog" && (
        <>
          {row("Covers", <>
            <span className="inline-flex rounded-lg border border-[var(--color-border-strong)] overflow-hidden" role="group" aria-label="Covers">
              <button type="button" aria-pressed={scope === "shift"} onClick={() => setScope("shift")} className={seg(scope === "shift")}>One shift</button>
              <button type="button" aria-pressed={scope === "job"} onClick={() => setScope("job")} className={seg(scope === "job")}>Whole job</button>
            </span>
          </>)}
          {scope === "shift" && shiftRow}
          {row("Format", <><span className="text-[12.5px] font-semibold">Excel</span></>)}
        </>
      )}
      {sel === "workorders" && (
        <>
          {row("Which", <>
            <select value={woShow} onChange={(e) => { const v = e.target.value as Show | "one"; setWoShow(v); if (v === "one" && !woKey) setWoKey(orders[0]?.key ?? ""); }} aria-label="Which work orders"
              className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]">
              {SHOWS.map(([k, l]) => <option key={k} value={k}>{l} ({findOrders(orders, woQuery).filter((o) => showsOrder(o, k, p.marks)).length})</option>)}
              <option value="one">One work order</option>
            </select>
            {woShow !== "one" && woQuery.trim() && (
              <span className="inline-flex items-center gap-1 h-7 px-2 rounded-full bg-[var(--color-surface-2)] text-[12px] font-semibold">“{woQuery.trim()}”
                <button type="button" onClick={() => setWoQuery("")} aria-label="Clear the search" className="text-[var(--color-text-muted)]"><X className="w-3.5 h-3.5" /></button>
              </span>
            )}
          </>)}
          {woShow === "one" && (
            row("Work order", <>
              <select value={woKey} onChange={(e) => setWoKey(e.target.value)} aria-label="Work order"
                className="h-8 w-full max-w-[420px] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]">
                {orders.map((o) => <option key={o.key} value={o.key}>{o.wo ? `WO ${o.wo} · ` : ""}{o.owner.name}</option>)}
              </select>
            </>)
          )}
          {row("History", <>
            <label className="inline-flex items-center gap-2 text-[12.5px] cursor-pointer select-none">
              <input type="checkbox" checked={woHistory} onChange={(e) => setWoHistory(e.target.checked)} className="w-4 h-4 accent-[var(--color-accent)]" />
              Every start, % update, hold and comment, with its time
            </label>
          </>)}
        </>
      )}
      {sel === "field" && <FieldTrackerOptions key={fieldStart.n} orders={fieldOrders} today={today} start={fieldStart} onChoice={setField} />}
      {lhRow}
    </div>
  );

  const actions = sel === "schedule" ? null : (
    <div className="flex flex-wrap items-center gap-2">
      {sel === "hourly" && <button type="button" disabled={busy} onClick={() => void run("download")} className={primary}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download</button>}
      {sel === "hourly" && format !== "xlsx" && <button type="button" disabled={busy} onClick={() => void run("print")} className={secondary}><Printer className="w-4 h-4" /> Print</button>}
      {sel === "timelog" && <button type="button" disabled={busy} onClick={() => void run("download")} className={primary}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download</button>}
      {(meeting || sel === "workorders" || sel === "field") && (
        <button type="button" disabled={busy || (!!meeting && !doc) || (sel === "field" && !field) || (sel === "workorders" && woShown.length === 0)} onClick={() => void run("print")} className={primary}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />} Print
        </button>
      )}
      {meeting && <button type="button" disabled={busy || !doc} onClick={() => void run("email")} className={secondary}><Mail className="w-4 h-4" /> Copy for email</button>}
      {(meeting === "kickoff" || meeting === "closeout") && <button type="button" onClick={() => setPresenting(true)} className={secondary}><Presentation className="w-4 h-4" /> Present</button>}
      {msg && <span role="status" className={`text-[12px] font-semibold ${/^Not made|blocked/.test(msg) ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{msg}</span>}
    </div>
  );

  const madeHere = made.filter((m) => m.report === sel).slice(0, 4);
  const detail = (
    <div className="min-w-0 space-y-4">
      <div>
        <button type="button" onClick={() => setPhoneOpen(false)} className="sm:hidden mb-2 inline-flex items-center gap-1 text-[13px] font-bold text-[var(--color-accent)]">
          <ChevronLeft className="w-4 h-4" /> Reports
        </button>
        <h2 className="text-[18px] font-black text-[var(--color-text)]">{meta.name}</h2>
        <p className="text-[13px] text-[var(--color-text-muted)] mt-0.5">{DESCRIBE[sel]}</p>
      </div>
      {sel === "schedule" ? (
        <ExecutionReportView milestones={p.milestones} shiftTimes={times} critical={p.critical} criticalSource={p.criticalSource} projectId={projectId} projectName={p.projectName} />
      ) : (
        <div className="grid gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)] items-start">
          <div className="space-y-4 min-w-0">
            {(!meeting || meeting === "turnover" || lhRow) && options}
            {actions}
            {madeHere.length > 0 && (
              <div>
                <div className="text-[12px] font-bold text-[var(--color-text-muted)] mb-1">Made lately</div>
                <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                  {madeHere.map((m) => (
                    <li key={`${m.label}:${m.at}`}>
                      <button type="button" onClick={() => again(m)} className="w-full text-left py-1.5 text-[12.5px] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                        {meta.name} · {m.label} <span className="text-[var(--color-text-muted)]">· {fmtInTz(m.at, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <PreviewPane preview={preview} busy={previewBusy} err={previewErr} />
        </div>
      )}
    </div>
  );

  const base = { milestones: p.milestones, cancelled: p.cancelled, userId: p.userId, userName: p.userName, canEdit: p.canEdit, progress: p.progress, projectId, projectName: p.projectName, pathNow: p.pathNow };
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm sm:flex min-h-[520px]">
      {/* The update a meeting sends, made off screen for the preview. */}
      {meeting && <ShiftReportView key={sel} {...base} docOnly meetingFixed={meeting} shiftPick={meeting === "turnover" ? shiftPick : undefined} onDoc={setDoc} />}
      <nav aria-label="Reports" className={`${phoneOpen ? "hidden sm:block" : ""} sm:w-[280px] shrink-0 sm:border-r border-[var(--color-border)] py-3`}>
        {[{ head: "Reports", sub: "filled in from the project", items: REPORTS.filter((r) => !r.form) }, { head: "Forms", sub: "blank, filled in by hand", items: REPORTS.filter((r) => r.form) }].map((g) => (
          <div key={g.head} className="mb-2">
            <div className="px-4 pt-1 pb-1">
              <div className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{g.head}</div>
              <div className="text-[11.5px] text-[var(--color-text-faint)]">{g.sub}</div>
            </div>
            {g.items.map((r) => {
              const on = r.id === sel;
              return (
                <button key={r.id} type="button" aria-current={on ? "page" : undefined} onClick={() => { setSel(r.id); setPhoneOpen(true); }}
                  className={`w-full text-left px-4 py-2 border-l-[3px] ${on ? "sm:border-[var(--color-accent)] sm:bg-[var(--color-accent-soft)] border-transparent" : "border-transparent hover:bg-[var(--color-surface-2)]"}`}>
                  <span className={`block text-[14px] font-bold ${on ? "sm:text-[var(--color-accent)] text-[var(--color-text)]" : "text-[var(--color-text)]"}`}>{r.name}</span>
                  <span className="block text-[12px] text-[var(--color-text-muted)] leading-snug">{r.sub}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className={`${phoneOpen ? "" : "hidden sm:block"} flex-1 min-w-0 p-4 sm:p-6`}>{detail}</div>
      {presenting && meeting && (
        <div className="fixed inset-0 z-[300] bg-[var(--color-bg,#f8fafc)] overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
            <b className="text-[14px]">{meta.name}</b>
            <button type="button" onClick={() => setPresenting(false)} className="inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-[12.5px] font-bold"><X className="w-4 h-4" /> Close</button>
          </div>
          <div className="max-w-[1400px] mx-auto p-3 sm:p-5">
            <ShiftReportView {...base} meetingFixed={meeting} presentOnOpen />
          </div>
        </div>
      )}
    </div>
  );
}

const DESCRIBE: Record<ReportId, string> = {
  turnover: "Where the job stands, done, next, safety and the meetings, for one shift. The same update Today sends.",
  hourly: "The shift hour by hour: the meetings, each hour's work, breaks and overtime.",
  timelog: "Every step and the time each thing was done, for the project file.",
  schedule: "Complete, pace and the forecast finish, with what's blocked and overdue.",
  workorders: "Each work order opened up with all its steps: plan against actual, status, % and the latest comment.",
  kickoff: "The start of the project: the job, the first shifts, readiness and safety.",
  closeout: "The end of the project: how it went, what was added, what's open, lessons for next time.",
  field: "A blank form for the field: the work orders, steps, resources and plan, with lines to write starts, finishes, % and notes by pen.",
};

/** Page 1 of a PDF as a picture (pdf.js), and how many pages it has. */
async function pdfPage1(bytes: Uint8Array): Promise<{ src: string; pages: number }> {
  const { pdfjs } = await import("react-pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const { PDFJS_VERBOSITY } = await import("@/lib/pdfjsConfig");
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: PDFJS_VERBOSITY }).promise;
  try {
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1.5 });
    const c = document.createElement("canvas");
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("This browser can't draw the page.");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
    return { src: c.toDataURL("image/png"), pages: doc.numPages };
  } finally { void doc.destroy(); }
}

type Preview = { kind: "html"; html: string; landscape?: boolean } | { kind: "img"; src: string; pages: number } | { kind: "rows"; head: string[]; rows: string[][]; total: number } | null;

/** Page 1 as it will come out, scaled to the pane. */
function PreviewPane({ preview, busy, err }: { preview: Preview; busy: boolean; err: string | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const landscape = preview?.kind === "html" && preview.landscape;
  const W = landscape ? 1056 : 816, H = landscape ? 816 : 1056;
  const k = w > 0 ? w / W : 0.4;
  // Off paper the page has no margins: the preview gives it the printed ones.
  const html = preview?.kind === "html" ? (preview.html.includes("lh-frame") ? preview.html : preview.html.replace("</head>", "<style>@media screen{body{padding:12mm}}</style></head>")) : "";
  return (
    <div className="min-w-0 rounded-xl bg-slate-200/70 dark:bg-slate-800/60 p-3 sm:p-4 lg:sticky lg:top-4">
      <div ref={ref} className="w-full">
        {err ? (
          <div className="rounded-lg bg-[var(--color-surface)] p-6 text-[12.5px] text-rose-700 dark:text-rose-400">Couldn&apos;t show it: {err}</div>
        ) : !preview ? (
          <div className="rounded-lg bg-white shadow flex items-center justify-center text-[12px] text-slate-500" style={{ height: H * k }}>
            {busy ? <span className="inline-flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Getting page 1 ready…</span> : "Pick what to put on it."}
          </div>
        ) : preview.kind === "img" ? (
          // eslint-disable-next-line @next/next/no-img-element -- a page drawn in the browser
          <img src={preview.src} alt="Page 1" className={`w-full rounded-sm bg-white shadow ${busy ? "opacity-60" : ""}`} />
        ) : preview.kind === "rows" ? (
          <div className={`rounded-sm bg-white shadow overflow-auto ${busy ? "opacity-60" : ""}`} style={{ maxHeight: 640 }}>
            <table className="w-full border-collapse text-[10.5px] text-slate-900">
              <thead><tr>{preview.head.map((h) => <th key={h} className="sticky top-0 bg-slate-100 border border-slate-300 px-1.5 py-1 text-left font-bold whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {preview.rows.length === 0 ? <tr><td colSpan={preview.head.length} className="px-2 py-4 text-center text-slate-500">Nothing in it yet.</td></tr>
                  : preview.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={`border border-slate-200 px-1.5 py-0.5 align-top ${c.length <= 24 ? "whitespace-nowrap" : "min-w-[220px]"}`}>{c}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={`relative overflow-hidden rounded-sm bg-white shadow ${busy ? "opacity-60" : ""}`} style={{ height: H * k }}>
            <iframe title="Page 1" srcDoc={html} sandbox="" tabIndex={-1} aria-hidden
              style={{ width: W, height: H, border: 0, transform: `scale(${k})`, transformOrigin: "0 0", pointerEvents: "none" }} />
          </div>
        )}
      </div>
      <div className="mt-2 text-center text-[11.5px] text-slate-600 dark:text-slate-300">
        {preview?.kind === "img" ? `Page 1 of ${preview.pages} · what you'll get`
          : preview?.kind === "rows" ? `${preview.total > preview.rows.length ? `First ${preview.rows.length} of ${preview.total} rows` : `${preview.total} row${preview.total === 1 ? "" : "s"}`} · what you'll get`
            : "Page 1 · what you'll get"}
      </div>
    </div>
  );
}
