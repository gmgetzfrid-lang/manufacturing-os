"use client";

// ReportsView - every report of the project in one place, one name each.
// Left, the list: reports filled in from the project, then forms filled in
// by hand. Right, the one picked: its few choices (which shift, the
// format, the letterhead), page 1 as it will come out, and Download or
// Print. A button elsewhere (Hourly log on the Shift tab, Print on a work order)
// opens the same report here, already set to its shift or work order.
// On a phone the list comes first; a report opens full screen with a way
// back to the list.

import { openFindingsReview } from "@/components/projects/Findings";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ClipboardPen, Download, FileText, Loader2, Mail, Maximize2, Minimize2, Minus, Plus, Presentation, Printer, SlidersHorizontal, X, Lightbulb } from "lucide-react";
import type { Milestone } from "@/types/schema";
import type { CancelledJob } from "@/lib/cancelledJobs";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import type { CriticalPathResult, PathMarks } from "@/lib/criticalPath";
import { defaultReviewShift, shiftWindow, shiftAt, meetingLeadMin, type ShiftTimes } from "@/lib/shiftReport";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { dayKey, fmtInTz } from "@/lib/scheduleTz";
import { useLetterhead } from "@/lib/letterheadStore";
import { REPORTS, type ReportId, type ReportLink, type ShiftPick } from "@/lib/reportLinks";
import type { ExportDoc } from "@/lib/reportExport";
import { copyUpdateForEmail, copyRich, sendParts, printHtml, sendPrintDocument, updateToSend, updateDocx, updateFileName, saveFile } from "@/lib/updatePrint";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { usePhases } from "@/components/projects/PhaseContext";
import { phaseStats, phaseReportHtml, phaseReportDocument, phaseReportText, howItDidHtml, type CostLine, type CostEntry } from "@/lib/phaseReport";
import { buildAsBuilt, asBuiltDocument, downloadAsBuilt } from "@/lib/asBuiltSchedule";
import { withWorkOrderCrews } from "@/lib/workOrderCrew";
import { loadProgressLog } from "@/lib/progressHistory";
import { loadShiftRecords, saveShiftRecord, useShiftRecords, type ShiftRecord } from "@/lib/shiftRecord";
import { loadHandover, handoverKey, type HandoverDecision } from "@/lib/shiftHandover";
import { notesFor } from "@/lib/milestones";
import { buildTimeLog, downloadTimeLog, type TimeLogRow } from "@/lib/timeLog";
import { jobLogs, oneShiftLog, type ShiftLog } from "@/lib/hourlyLog";
import { hourlyLogPdf, hourlyLogTable, pngInBrowser, saveHourlyLog, type LogFormat } from "@/lib/hourlyLogFiles";
import { groupWorkOrders, findOrders, showsOrder, workOrdersPrintDocument, SHOW_WORD, type Show } from "@/lib/workOrderGroups";
import { buildShiftSheet, shiftSheetHtml, shiftSheetDocument, sheetPages, sheetIds, sheetTitle } from "@/lib/shiftSheet";
import ShiftSheetEntry from "@/components/projects/ShiftSheetEntry";
import ShiftReportView from "@/components/projects/ShiftReportView";
import ExecutionReportView from "@/components/projects/ExecutionReportView";
import AsBuiltScheduleView from "@/components/projects/AsBuiltScheduleView";
import { defaultMeeting, type MeetingKind } from "@/lib/meetingPlan";
import { useProjectWord } from "@/components/projects/ProjectTypeContext";
import { useWoClasses, passes, WoClassSelects } from "@/components/projects/WoClassFilter";
import { typeLabel, unitLabel, NONE } from "@/lib/woClass";

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
  /** The link has been applied: it isn't applied again on the next visit. */
  onLinkUsed?: () => void;
}

// The report last open on each project (this visit): back on Reports, it's
// still there.
const lastOpen = new Map<string, ReportId>();
// A report asked for from another tab (Close-out's "Close-out report"):
// opened straight, on a phone too.
const askedOpen = new Set<string>();
export function openReportNext(projectId: string, id: ReportId): void { lastOpen.set(projectId, id); askedOpen.add(projectId); }

const SHOWS: Array<[Show, string]> = [["all", "All"], ["open", "Open"], ["behind", "Behind"], ["critical", "Critical path"], ["notStarted", "Not started"], ["held", "Held"], ["done", "Done"], ["added", "Discovery & added"]];
const MEETING_OF: Partial<Record<ReportId, MeetingKind>> = { turnover: "turnover", kickoff: "kickoff", closeout: "closeout" };
const FORMAT_NAME: Record<LogFormat, string> = { pdf: "PDF", docx: "Word", xlsx: "Excel" };

// ── Made lately: this device's last few, to make again with a tap ──
/** What the hourly log and the time log cover: the whole project, some
 *  days, or one shift. */
type Cover = "job" | "range" | "shift";
interface Made { report: ReportId; label: string; at: number; shift?: ShiftPick | null; cover?: Cover; range?: { from: string; to: string }; format?: LogFormat }
const madeKey = (projectId: string) => `reports:made:${projectId}`;
function readMade(projectId: string): Made[] {
  try { const v = JSON.parse(localStorage.getItem(madeKey(projectId)) ?? "[]"); return Array.isArray(v) ? v as Made[] : []; } catch { return []; }
}

export default function ReportsView(p: Props) {
  const tz = useScheduleTz();
  const word = useProjectWord();
  const { projectId, shiftTimes: times } = p;
  const live = useMemo(() => withWorkOrderCrews(p.milestones), [p.milestones]);
  const { lh } = useLetterhead(projectId);

  // First time in: the meeting the job is at (kick-off before it starts,
  // close-out once it's done), else the shift turnover.
  const [sel, setSelState] = useState<ReportId>(() => lastOpen.get(projectId) ?? defaultMeeting(live, Date.now(), p.progress, tz));
  const setSel = useCallback((id: ReportId) => { lastOpen.set(projectId, id); setSelState(id); }, [projectId]);
  // Phone: the report open full screen (the list behind it).
  const [phoneOpen, setPhoneOpen] = useState(() => askedOpen.has(projectId));
  useEffect(() => { askedOpen.delete(projectId); }, [projectId]);
  // The shift (turnover, hourly log, time log); null: the current one.
  const [shiftPick, setShiftPick] = useState<ShiftPick | null>(null);
  // Opened from the list: the whole project; from the Shift tab, that shift.
  const [cover, setCover] = useState<Cover>("job");
  const [format, setFormat] = useState<LogFormat>("pdf");
  const [useLh, setUseLh] = useState(true);
  // Some days: both shifts of each (a night is its start day's).
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [woShow, setWoShow] = useState<Show | "one">("all");
  const [woQuery, setWoQuery] = useState("");
  const [woKey, setWoKey] = useState("");
  const [woHistory, setWoHistory] = useState(false);
  // Work orders left open on Work orders, printed with the ones the filter finds.
  const [woAlso, setWoAlso] = useState<string[]>([]);
  // Only these units and equipment types.
  const [woUnits, setWoUnits] = useState<string[]>([]);
  const [woTypes, setWoTypes] = useState<string[]>([]);
  // The shift sheet: the shift it's for (null: the coming one), and its
  // entry screen open.
  const [sheetPick, setSheetPick] = useState<ShiftPick | null>(null);
  const [sheetEntry, setSheetEntry] = useState(false);

  // A report opened from elsewhere: set to what was on screen there.
  const linkN = p.link?.n;
  useEffect(() => {
    const l = p.link;
    if (!l) return;
    setSel(l.id); setPhoneOpen(true);
    if (l.shift) { setShiftPick(l.shift); setCover("shift"); }
    if (l.scope) setCover(l.scope === "job" ? "job" : "shift");
    if (l.id === "workorders") {
      if (l.wo) { setWoShow("one"); setWoKey(l.wo); setWoQuery(""); }
      else { setWoShow((SHOWS.some(([k]) => k === l.show) ? l.show : "all") as Show); setWoQuery(l.query ?? ""); }
      setWoHistory(!!l.history);
    }
    if (l.id === "sheet") { setSheetPick(l.shift ?? null); setSheetEntry(!!l.enter); }
    if (l.id === "workorders") { setWoAlso(l.also ?? []); setWoUnits(l.units ?? []); setWoTypes(l.types ?? []); }
    p.onLinkUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per link
  }, [linkN]);

  // The shift on screen: the one picked, else the current one.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const current = useMemo(() => defaultReviewShift(live, now, tz, times), [live, now, tz, times]);
  const shift = useMemo(() => (shiftPick ? shiftWindow(shiftPick.dayKey, shiftPick.kind, tz, times) : current), [shiftPick, current, tz, times]);
  const shiftLabel = `${shift.kind === "day" ? "Day" : "Night"} shift ${fmtInTz(shift.start, tz, { weekday: "short", month: "short", day: "numeric" })}`;
  // The days picked; until then the last week, ending on the current shift's day.
  const days = useMemo(() => {
    if (range) return range;
    const d = new Date(`${current.dayKey}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 6);
    return { from: d.toISOString().slice(0, 10), to: current.dayKey };
  }, [range, current.dayKey]);
  const coverLabel = cover === "job" ? "whole project" : cover === "range" ? `${days.from} to ${days.to}` : shiftLabel;
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
    if (m.cover) setCover(m.cover);
    if (m.range) setRange(m.range);
    if (m.format) setFormat(m.format);
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
    const timeLog = buildTimeLog({ milestones: live, log: log ?? [], notes, records, tz, times, word });
    const o = { milestones: live, timeLog, records, log: log ?? [], tz, times, now: at };
    if (cover === "shift") return [oneShiftLog(o, shift)];
    const all = jobLogs(o);
    // Some days: each shift whose day is in them (its key: "2026-10-30:night").
    return cover === "range" ? all.filter((l) => { const d = l.key.slice(0, 10); return d >= days.from && d <= days.to; }) : all;
  }, [loadJob, live, tz, times, cover, shift, word, days.from, days.to]);
  const hourlyName = cover === "job" ? `${name} - hourly log, whole project` : cover === "range" ? `${name} - hourly log ${days.from} to ${days.to}` : `${name} - hourly log ${shift.dayKey} ${shift.kind}`;

  // ── Time log ──
  const timeRows = useCallback(async (): Promise<TimeLogRow[]> => {
    const { log, records, notes } = await loadJob();
    const win = cover === "shift" ? { from: shift.start, to: shift.end }
      : cover === "range" ? { from: shiftWindow(days.from, "day", tz, times).start, to: shiftWindow(days.to, "night", tz, times).end } : {};
    return buildTimeLog({ milestones: live, log: log ?? [], notes, records, tz, times, word, ...win });
  }, [loadJob, live, tz, times, cover, shift, word, days.from, days.to]);
  const dayLabel = (d: string) => fmtInTz(shiftWindow(d, "day", tz, times).start, tz, { month: "short", day: "numeric" });
  const timeTitle = cover === "shift" ? `Time log - ${shift.kind === "day" ? "Day shift" : "Night shift"} ${fmtInTz(shift.start, tz, { weekday: "short", month: "short", day: "numeric" })}`
    : cover === "range" ? `Time log - ${dayLabel(days.from)} to ${dayLabel(days.to)}` : "Time log - whole project to date";

  // ── Work orders ──
  const orders = useMemo(() => groupWorkOrders(p.milestones, p.childrenByParent, p.progress, tz, times, now), [p.milestones, p.childrenByParent, p.progress, tz, times, now]);
  const wc = useWoClasses(projectId, p.milestones);
  const woShown = useMemo(() => (woShow === "one" ? orders.filter((o) => o.key === woKey)
    : orders.filter((o) => woAlso.includes(o.key) || (findOrders([o], woQuery).length > 0 && showsOrder(o, woShow, p.marks) && passes(wc, o.owner, woUnits, woTypes)))), [orders, woShow, woKey, woQuery, woAlso, p.marks, wc, woUnits, woTypes]);
  const classScope = [
    ...woUnits.map((u) => (u === NONE ? "no unit" : wc.book ? unitLabel(u, wc.book) : `Unit ${u}`)),
    ...woTypes.map((t) => (t === NONE ? "no type set" : wc.book ? typeLabel(t, wc.book) : `Type ${t}`)),
  ].join(" · ");
  const woScope = woShow === "one" ? (woShown[0] ? `${woShown[0].wo ? `WO ${woShown[0].wo}` : "No WO"} · ${woShown[0].owner.name}` : "One work order")
    : `${SHOW_WORD[woShow]}${classScope ? ` · ${classScope}` : ""}${woQuery.trim() ? ` · search “${woQuery.trim()}”` : ""}`;

  // ── The shift sheet (lib/shiftSheet) ──
  // The coming shift: from its start meeting on, the next one.
  const sheetShift = useMemo(() => (sheetPick ? shiftWindow(sheetPick.dayKey, sheetPick.kind, tz, times) : shiftAt(now + (meetingLeadMin(times) + 1) * 60_000, tz, times)), [sheetPick, now, tz, times]);
  // What its turnover decided: steps pulled forward, the other crew's to try.
  const [sheetDec, setSheetDec] = useState<Record<string, HandoverDecision>>({});
  const sheetKey = handoverKey(sheetShift);
  useEffect(() => {
    if (sel !== "sheet") return;
    let alive = true;
    loadHandover(projectId, sheetKey).then((h) => { if (alive) setSheetDec(h?.decisions ?? {}); }).catch(() => { if (alive) setSheetDec({}); });
    return () => { alive = false; };
  }, [sel, projectId, sheetKey, tick]);
  // The shift's plan, set by hand on the Shift tab: the sheet's list.
  const { records: sheetRecords } = useShiftRecords(sel === "sheet" ? projectId : null);
  const sheetPlan = sheetRecords.get(sheetKey)?.plan;
  const sheet = useMemo(() => {
    if (sel !== "sheet") return null;
    const pulls = Object.entries(sheetDec).filter(([, d]) => d.tryIt && d.pulled).map(([id]) => id);
    const tries = new Set(Object.entries(sheetDec).filter(([, d]) => d.tryIt && !d.pulled).map(([id]) => id));
    return buildShiftSheet({ milestones: live, progress: p.progress, criticalIds: p.critical?.ids, tz, times, target: sheetShift, now, pullIds: pulls, tryIds: tries, plan: sheetPlan });
  }, [sel, live, p.progress, p.critical, tz, times, sheetShift, now, sheetDec, sheetPlan]);
  const sheetDoc = useMemo(() => (sheet ? shiftSheetDocument(`${name} - ${sheetTitle(sheet.shift, tz)}`, shiftSheetHtml(sheet, { project: name, tz, times })) : null), [sheet, name, tz, times]);
  const sheetLabel = `${sheetShift.kind === "day" ? "Day" : "Night"} shift ${fmtInTz(sheetShift.start, tz, { weekday: "short", month: "short", day: "numeric" })}`;

  // ── The meetings' update (turnover, kick-off, close-out) ──
  const meeting = MEETING_OF[sel];
  // Comes from the meeting's report, made off screen (below); a different
  // meeting or shift sends its own.
  const [doc, setDoc] = useState<ExportDoc | null>(null);
  // The meeting on screen, full size: to work in it, or to present it.
  const [onScreen, setOnScreen] = useState<null | "open" | "present">(null);

  // ── The report, whole, as it will come out ──
  const [preview, setPreview] = useState<Preview>(null);
  // The report full screen, its options beside it (a print setup screen).
  const [full, setFull] = useState(false);
  useEffect(() => { setFull(false); }, [sel]);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const lhOn = useLh && !!lh ? lh : null;
  // ── Phase report: the phase picked (or every phase and the project) ──
  const ph = usePhases();
  // The numbers for a phase (null: the whole project): progress from the
  // log, money from the budget lines and what's booked on them.
  const statsMaker = async () => {
    const rows = <T,>(table: string) => fetchAllRows<T>((from, to) => supabase.from(table).select("*").eq("project_id", projectId).order("id").range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>);
    const [log, lines, entries, proj] = await Promise.all([
      loadProgressLog(projectId), rows<CostLine>("cost_accounts"), rows<CostEntry>("cost_entries"),
      supabase.from("projects").select("authorized_amount").eq("id", projectId).maybeSingle(),
    ]);
    const total = (proj.data as { authorized_amount?: number | null } | null)?.authorized_amount;
    const at = Date.now();
    return { at, stats: (phase: (typeof ph.phases)[number] | null) => phaseStats({ milestones: ph.all, phases: ph.phases, phase, log, tz, times, now: at, total: total == null ? null : Number(total), lines: lines.rows, entries: entries.rows }) };
  };
  // The close-out's "How the job did" (the phase picked, else the project).
  const howItDid = async () => {
    const { at, stats } = await statsMaker();
    const phase = ph.phase ? ph.phases.find((x) => x.id === ph.phase) ?? null : null;
    // All phases: the project's totals, then each phase against its own plan.
    if (!phase && ph.phases.length) return howItDidHtml(stats(null), tz, at, { chart: false }) + ph.phases.map((p) => howItDidHtml(stats(p), tz, at)).join("");
    return howItDidHtml(stats(phase), tz, at);
  };
  // The as-built schedule: the phase picked (else the whole job), as built.
  const asBuiltScope = ph.phase ? ph.phases.find((x) => x.id === ph.phase)?.name ?? "Phase" : ph.phases.length ? "All phases" : "Whole project";
  const asBuilt = () => buildAsBuilt({ milestones: p.milestones, childrenByParent: p.childrenByParent, cancelled: p.cancelled, phases: ph.phases, tz });
  const asBuiltDoc = () => asBuiltDocument(asBuilt(), { project: name, scope: asBuiltScope, tz, now: Date.now() });
  const phaseBody = async (): Promise<{ html: string; text: string; title: string }> => {
    const { at, stats } = await statsMaker();
    const each = ph.phases.map(stats);
    const all = stats(null);
    const picked = ph.phase ? each.find((x) => x.phase?.id === ph.phase) ?? null : null;
    const title = picked?.phase ? `${picked.phase.name} phase report` : `${p.projectName ?? "Project"} phase report`;
    return { html: phaseReportHtml({ project: p.projectName ?? "Project", tz, now: at, picked, all, each }), text: phaseReportText({ project: p.projectName ?? "Project", picked, all, each }), title };
  };
  const previewSig = JSON.stringify([ph.phase, ph.phases, sel === "phase" ? ph.all.length : 0, sel, shift.dayKey, shift.kind, cover, days.from, days.to, format, !!lhOn, woShow, woKey, woQuery, woAlso, woHistory, woUnits, woTypes, wc.ready, sel === "sheet" ? sheetDoc : null, tick, live.length, meeting ? doc : null]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      setPreviewErr(null);
      try {
        if (meeting) {
          const page = doc ? sendPrintDocument(updateToSend(doc, meeting), lhOn) : null;
          setPreview(page ? { kind: "html", html: page } : null);
          setPreviewBusy(!doc);
          // The close-out: how the job did, under it.
          if (page && meeting === "closeout") {
            const extra = await howItDid().catch(() => "");
            if (alive && extra) setPreview({ kind: "html", html: page.replace(/<\/body>/i, `${extra}</body>`) });
          }
          return;
        }
        if (sel === "schedule") { setPreview(null); return; }
        setPreviewBusy(true);
        if (sel === "hourly") {
          const logs = await hourlyLogs();
          if (format === "xlsx") {
            const rows = hourlyLogTable(logs);
            if (alive) setPreview({ kind: "rows", head: ["Date", "Shift", "Time", "Type", "What happened"], rows: rows.slice(0, ROWS_SHOWN), total: rows.length });
          } else {
            const bytes = await hourlyLogPdf(logs, { project: name, lh: lhOn, toPng: pngInBrowser });
            // Every page, shown as each is drawn.
            await pdfPages(bytes, (pages, total) => { if (alive) setPreview({ kind: "pdf", pages, total }); }, () => alive);
          }
        } else if (sel === "timelog") {
          const rows = await timeRows();
          const d = (at: number) => fmtInTz(at, tz, { month: "numeric", day: "numeric", year: "numeric" });
          const tm = (at: number) => fmtInTz(at, tz, { hour: "numeric", minute: "2-digit", hour12: true });
          if (alive) setPreview({ kind: "rows", head: ["Date", "Time", "Shift", "Task / equipment", "WO", "Step", "Crew", "What happened", "%", "Comment"], rows: rows.slice(0, ROWS_SHOWN).map((r) => [d(r.at), tm(r.at), r.shift, r.task, r.wo, r.step, r.crew, r.what, r.pct, r.comment]), total: rows.length });
        } else if (sel === "workorders") {
          const html = await workOrdersPrintDocument({ shown: woShown, milestones: p.milestones, projectId, projectName: p.projectName, tz, times, progress: p.progress, format: woHistory ? "history" : "report", word, scope: `${woScope}${woHistory ? " · with each step's history" : ""}`, lh: lhOn });
          if (alive) setPreview({ kind: "html", html, landscape: true });
        } else if (sel === "sheet") {
          if (alive) setPreview(sheetDoc ? { kind: "html", html: sheetDoc, pages: sheetPages(sheetDoc) } : null);
        } else if (sel === "phase") {
          const b = await phaseBody();
          if (alive) setPreview({ kind: "html", html: phaseReportDocument(b.title, b.html) });
        } else if (sel === "asbuilt") {
          if (alive) setPreview({ kind: "html", html: asBuiltDoc(), landscape: true });
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
  const run = async (what: "download" | "print" | "email" | "word") => {
    setMsg(null);
    // A print window is opened at the tap, so the browser doesn't take it for a pop-up.
    const w = what === "print" && sel !== "hourly" ? window.open("", "_blank") : null;
    if (what === "print" && sel !== "hourly" && !w) { setMsg(blocked); return; }
    setBusy(true);
    try {
      if (meeting) {
        if (!doc) throw new Error("Still getting the report ready.");
        const picked = updateToSend(doc, meeting);
        if (what === "email") {
          let ok: boolean;
          if (meeting === "closeout") {
            const parts = sendParts(picked);
            const extra = await howItDid().catch(() => "");
            ok = await copyRich(parts.html + extra, parts.text);
          } else ok = await copyUpdateForEmail(picked);
          setMsg(ok ? "Copied - paste into your email." : "Your browser blocked the copy - try again.");
          return;
        }
        if (what === "word") { saveFile(await updateDocx(picked), updateFileName(picked)); setMsg("Word file saved."); return; }
        const page = sendPrintDocument(picked, lhOn);
        const extra = meeting === "closeout" ? await howItDid().catch(() => "") : "";
        printHtml(extra ? page.replace(/<\/body>/i, `${extra}</body>`) : page, w);
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
        remember({ report: "hourly", label: `${coverLabel} · ${what === "print" ? "printed" : FORMAT_NAME[format]}`, shift: shiftPick, cover, range: cover === "range" ? days : undefined, format });
      } else if (sel === "timelog") {
        const rows = await timeRows();
        await downloadTimeLog(rows, { project: name, tz, title: timeTitle, fileName: `${fileBase} - time log${cover === "shift" ? ` ${shift.dayKey} ${shift.kind}` : cover === "range" ? ` ${days.from} to ${days.to}` : ", whole project"}.xlsx` });
        setMsg(`${rows.length} entr${rows.length === 1 ? "y" : "ies"} exported.`);
        remember({ report: "timelog", label: coverLabel, shift: shiftPick, cover, range: cover === "range" ? days : undefined });
      } else if (sel === "workorders") {
        const html = await workOrdersPrintDocument({ shown: woShown, milestones: p.milestones, projectId, projectName: p.projectName, tz, times, progress: p.progress, format: woHistory ? "history" : "report", word, scope: `${woScope}${woHistory ? " · with each step's history" : ""}`, lh: lhOn });
        printHtml(html, w);
        remember({ report: "workorders", label: woScope });
      } else if (sel === "asbuilt") {
        if (what === "download") {
          await downloadAsBuilt(asBuilt(), { project: name, scope: asBuiltScope, tz, fileName: `${fileBase} - as-built schedule${ph.phase ? ` ${ph.phases.find((x) => x.id === ph.phase)?.name ?? ""}` : ""}.xlsx` });
          setMsg("Excel file saved.");
        } else printHtml(asBuiltDoc(), w);
        remember({ report: "asbuilt", label: `${asBuiltScope} · ${what === "download" ? "Excel" : "printed"}` });
      } else if (sel === "phase") {
        const b = await phaseBody();
        if (what === "email") { setMsg((await copyRich(b.html, b.text)) ? "Copied - paste into your email." : "Your browser blocked the copy - try again."); return; }
        printHtml(phaseReportDocument(b.title, b.html), w);
        remember({ report: "phase", label: ph.phase ? ph.phases.find((x) => x.id === ph.phase)?.name ?? "Phase" : "All phases" });
      } else if (sel === "sheet" && sheet && sheetDoc) {
        printHtml(sheetDoc, w);
        // Kept with the shift: entering it shows these lines, in this order.
        const orgId = live[0]?.orgId;
        if (p.canEdit && p.userId && orgId) {
          void saveShiftRecord({ orgId, projectId, shiftKey: sheetKey, userId: p.userId, change: (r) => ({ ...r, sheet: { ids: sheetIds(sheet), printedAt: Date.now(), by: p.userName ?? null } }) }).catch(() => undefined);
        }
        remember({ report: "sheet", label: sheetLabel, shift: sheetPick });
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
  // What the hourly log and the time log cover: the whole project, some days, one shift.
  const coverRows = (
    <>
      {row("Covers", <>
        <span className="inline-flex flex-wrap rounded-lg border border-[var(--color-border-strong)] overflow-hidden" role="group" aria-label="Covers">
          {([["job", "Whole project"], ["range", "Date range"], ["shift", "One shift"]] as const).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={cover === k} onClick={() => setCover(k)} className={seg(cover === k)}>{l}</button>
          ))}
        </span>
      </>)}
      {cover === "range" && row("Days", <>
        <input type="date" value={days.from} max={days.to} onChange={(e) => { if (e.target.value) setRange({ from: e.target.value, to: days.to < e.target.value ? e.target.value : days.to }); }} aria-label="From"
          className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]" />
        <span className="text-[12px] text-[var(--color-text-muted)]">to</span>
        <input type="date" value={days.to} min={days.from} onChange={(e) => { if (e.target.value) setRange({ from: days.from > e.target.value ? e.target.value : days.from, to: e.target.value }); }} aria-label="To"
          className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]" />
        <span className="text-[11.5px] text-[var(--color-text-muted)]">day and night shifts</span>
      </>)}
      {cover === "shift" && shiftRow}
    </>
  );
  const lhRow = lh && sel !== "sheet" && sel !== "timelog" && !(sel === "hourly" && format === "xlsx") ? (
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
          {coverRows}
          {row("Format", <>
            <span className="inline-flex rounded-lg border border-[var(--color-border-strong)] overflow-hidden" role="group" aria-label="Format">
              {(["pdf", "docx", "xlsx"] as const).map((f) => <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)} className={seg(format === f)}>{FORMAT_NAME[f]}</button>)}
            </span>
          </>)}
        </>
      )}
      {sel === "timelog" && (
        <>
          {coverRows}
          {row("Format", <><span className="text-[12.5px] font-semibold">Excel</span></>)}
        </>
      )}
      {sel === "workorders" && (
        <>
          {row("Which", <>
            <select value={woShow} onChange={(e) => { const v = e.target.value as Show | "one"; setWoShow(v); setWoAlso([]); if (v === "one" && !woKey) setWoKey(orders[0]?.key ?? ""); }} aria-label="Which work orders"
              className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]">
              {SHOWS.map(([k, l]) => <option key={k} value={k}>{l} ({findOrders(orders, woQuery).filter((o) => showsOrder(o, k, p.marks) && passes(wc, o.owner, woUnits, woTypes)).length})</option>)}
              <option value="one">One work order</option>
            </select>
            {woShow !== "one" && woQuery.trim() && (
              <span className="inline-flex items-center gap-1 h-7 px-2 rounded-full bg-[var(--color-surface-2)] text-[12px] font-semibold">“{woQuery.trim()}”
                <button type="button" onClick={() => { setWoQuery(""); setWoAlso([]); }} aria-label="Clear the search" className="text-[var(--color-text-muted)]"><X className="w-3.5 h-3.5" /></button>
              </span>
            )}
          </>)}
          {woShow !== "one" && (wc.choices.units.length > 1 || wc.choices.types.some((t) => t.code !== NONE) || woUnits.length > 0 || woTypes.length > 0) && row("Unit, type", <>
            <WoClassSelects c={wc} units={woUnits} types={woTypes} onUnits={(v) => { setWoUnits(v); setWoAlso([]); }} onTypes={(v) => { setWoTypes(v); setWoAlso([]); }} />
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
      {sel === "sheet" && (
        <>
          {row("Shift", <>
            <span className="inline-flex rounded-lg border border-[var(--color-border-strong)] overflow-hidden" role="group" aria-label="Day or night">
              {(["day", "night"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={sheetShift.kind === k} onClick={() => setSheetPick({ dayKey: sheetShift.dayKey, kind: k })} className={seg(sheetShift.kind === k)}>{k === "day" ? "Day" : "Night"}</button>
              ))}
            </span>
            <input type="date" value={sheetShift.dayKey} onChange={(e) => { if (e.target.value) setSheetPick({ dayKey: e.target.value, kind: sheetShift.kind }); }} aria-label="Date"
              className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]" />
            {sheetPick && <button type="button" onClick={() => setSheetPick(null)} className="h-8 px-2.5 rounded-lg border border-[var(--color-border)] text-[12px] font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Coming shift</button>}
          </>)}
          <div className="text-[12px] text-[var(--color-text-muted)] pl-0 sm:pl-[108px]">
            {sheet ? `${sheet.count} job${sheet.count === 1 ? "" : "s"}: carried over, going, planned, pulled ahead at the turnover, and ready to start early. Print it at the shift's start meeting.` : null}
          </div>
        </>
      )}
      {lhRow}
    </div>
  );

  const actions = sel === "schedule" ? null : (
    <div className="flex flex-wrap items-center gap-2">
      {sel === "hourly" && <button type="button" disabled={busy} onClick={() => void run("download")} className={primary}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download</button>}
      {sel === "hourly" && format !== "xlsx" && <button type="button" disabled={busy} onClick={() => void run("print")} className={secondary}><Printer className="w-4 h-4" /> Print</button>}
      {sel === "timelog" && <button type="button" disabled={busy} onClick={() => void run("download")} className={primary}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download</button>}
      {sel === "asbuilt" && <button type="button" disabled={busy} onClick={() => void run("download")} className={secondary}><Download className="w-4 h-4" /> Excel</button>}
      {(meeting || sel === "workorders" || sel === "sheet" || sel === "phase" || sel === "asbuilt") && (
        <button type="button" disabled={busy || (!!meeting && !doc) || (sel === "sheet" && !sheetDoc) || (sel === "workorders" && woShown.length === 0)} onClick={() => void run("print")} className={primary}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />} Print
        </button>
      )}
      {sel === "sheet" && <button type="button" onClick={() => setSheetEntry(true)} className={secondary}><ClipboardPen className="w-4 h-4" /> Enter what&apos;s written</button>}
      {meeting && <button type="button" disabled={busy || !doc} onClick={() => void run("email")} className={secondary}><Mail className="w-4 h-4" /> Copy for email</button>}
      {sel === "phase" && <button type="button" disabled={busy} onClick={() => void run("email")} className={secondary}><Mail className="w-4 h-4" /> Copy for email</button>}
      {meeting === "turnover" && doc?.form && <button type="button" disabled={busy} onClick={() => void run("word")} className={secondary}><FileText className="w-4 h-4" /> Export Word</button>}
      {(meeting === "kickoff" || meeting === "closeout") && (
        <>
          <button type="button" onClick={() => setOnScreen("open")} className={secondary} title="The whole meeting on screen: hide sections, lessons, copy as text"><Maximize2 className="w-4 h-4" /> Open</button>
          <button type="button" onClick={() => setOnScreen("present")} className={secondary}><Presentation className="w-4 h-4" /> Present</button>
        </>
      )}
      {/* What the job taught: kept for the next one before the project closes. */}
      {meeting === "closeout" && <button type="button" onClick={openFindingsReview} className={secondary}><Lightbulb className="w-4 h-4" /> Lessons &amp; findings</button>}
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
      ) : sel === "asbuilt" ? (
        <AsBuiltScheduleView projectId={projectId} orgId={live[0]?.orgId ?? null} milestones={p.milestones} childrenByParent={p.childrenByParent} cancelled={p.cancelled}
          phases={ph.phases} phase={ph.phase} tz={tz} times={times} canEdit={!!p.canEdit} userName={p.userName ?? null}
          onExcel={() => void run("download")} onPrint={() => void run("print")} />
      ) : (
        <div className="grid gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] items-start">
          <div className="space-y-4 min-w-0">
            {/* Closing the job (PSSR, turnover, punch, complete) is on its own tab. */}
            {sel === "closeout" && (
              <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("project:tab", { detail: "closeout" }))}
                className="w-full flex items-center gap-2 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2.5 text-left text-[13px] font-bold text-emerald-900 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-950/50">
                <span className="flex-1">PSSR, turnover documents, punch list and Mark complete are on the Close-out tab.</span>
                <span className="shrink-0 underline">Open Close-out</span>
              </button>
            )}
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
          <DocView preview={preview} busy={previewBusy} err={previewErr} onFull={() => setFull(true)} />
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
        {[{ head: "Reports", sub: "filled in from the project", items: REPORTS.filter((r) => !r.form && (r.id !== "phase" || ph.phases.length > 0)) }, { head: "Forms", sub: "blank, filled in by hand", items: REPORTS.filter((r) => r.form) }].map((g) => (
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
      {sheetEntry && sel === "sheet" && (
        <ShiftSheetEntry milestones={live} progress={p.progress} tz={tz} times={times} target={sheetShift} projectId={projectId}
          userId={p.userId} userName={p.userName} canEdit={p.canEdit} onClose={() => setSheetEntry(false)}
          onSaved={() => window.dispatchEvent(new CustomEvent("schedule:changed"))} />
      )}
      {full && sel !== "schedule" && (
        <FullView name={meta.name} onClose={() => setFull(false)} actions={actions}
          options={(!meeting || meeting === "turnover" || lhRow) ? options : null}>
          <DocView preview={preview} busy={previewBusy} err={previewErr} fill />
        </FullView>
      )}
      {onScreen && meeting && (
        <div className="fixed inset-0 z-[300] bg-[var(--color-bg,#f8fafc)] overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
            <b className="text-[14px]">{meta.name}</b>
            <button type="button" onClick={() => setOnScreen(null)} className="inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-[12.5px] font-bold"><X className="w-4 h-4" /> Close</button>
          </div>
          <div className="max-w-[1400px] mx-auto p-3 sm:p-5">
            <ShiftReportView {...base} meetingFixed={meeting} presentOnOpen={onScreen === "present"} />
          </div>
        </div>
      )}
    </div>
  );
}

const DESCRIBE: Record<ReportId, string> = {
  turnover: "Where the job stands, done, next, safety and the meetings, for one shift. The same update the Shift tab sends.",
  hourly: "The shift hour by hour: the meetings, each hour's work, breaks and overtime.",
  timelog: "Every step and the time each thing was done, for the project file.",
  schedule: "Complete, pace and the forecast finish, with what's blocked and overdue.",
  workorders: "Each work order opened up with all its steps: plan against actual, status, % and the latest comment.",
  asbuilt: "The job as it was really worked, shift by shift: when each activity moved, when it sat and why, when it was ready but its crew was elsewhere, and the hands against the work. Switch to Suggested for next time: this job with what it taught put in, a crew load and hands for each shift, and changes you tell it.",
  kickoff: "The start of the project: the job, the first shifts, readiness and safety.",
  closeout: "The end of the project: how it went, what was added, what's open, and the Lessons & findings review for next time.",
  phase: "How the phase picked at the top did: progress against plan day by day, the finish, the work added and its share of the budget, beside the other phases and the whole project. With All phases picked: every phase and the project.",
  sheet: "One page for the field, for one shift: only that shift's work, by equipment. Write start, % at lunch, % at the end of the shift and done by pen, then enter it here line for line.",
};

/** Rows shown of a spreadsheet report (the file has them all). */
const ROWS_SHOWN = 2000;
/** Pages drawn of a PDF report (the file has them all). */
const PAGES_SHOWN = 80;

/** Every page of a PDF as a picture (pdf.js), each passed on as it's drawn. */
async function pdfPages(bytes: Uint8Array, onPages: (pages: string[], total: number) => void, alive: () => boolean): Promise<void> {
  const { pdfjs } = await import("react-pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const { PDFJS_VERBOSITY } = await import("@/lib/pdfjsConfig");
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: PDFJS_VERBOSITY }).promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, PAGES_SHOWN) && alive(); i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1.6 });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("This browser can't draw the page.");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
      out.push(c.toDataURL("image/png"));
      onPages([...out], doc.numPages);
    }
  } finally { void doc.destroy(); }
}

type Preview = { kind: "html"; html: string; landscape?: boolean; pages?: number } | { kind: "pdf"; pages: string[]; total: number } | { kind: "rows"; head: string[]; rows: string[][]; total: number } | null;

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** The report, whole: every page as it will come out, to read through
 *  like a print preview. Fit to the width, or zoomed in and out; full
 *  screen from here. `fill`: it fills its box (full screen). */
function DocView({ preview, busy, err, onFull, fill }: { preview: Preview; busy: boolean; err: string | null; onFull?: () => void; fill?: boolean }) {
  const box = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [w, setW] = useState(0);
  const [z, setZ] = useState(1);
  const [h, setH] = useState(1056);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const landscape = preview?.kind === "html" && preview.landscape;
  const W = landscape ? 1056 : 816;
  // Fit: the page as wide as the box, never past its printed size; the
  // zoom from there (wider than the box: it scrolls sideways).
  const fit = w > 0 ? Math.min((w - 2) / W, 1) : 0.5;
  const k = fit * z;
  // Off paper the page has no margins: on screen it gets the printed ones.
  const html = preview?.kind === "html" ? (preview.html.includes("lh-frame") ? preview.html : preview.html.replace("</head>", "<style>@media screen{body{padding:12mm}}</style></head>")) : "";
  // The document's own height, so every page shows (read once it has
  // drawn, pictures and all).
  const measure = useCallback(() => {
    const d = frame.current?.contentDocument;
    if (!d?.documentElement) return;
    setH(Math.max(400, d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0));
  }, []);
  useEffect(() => { const t = setTimeout(measure, 400); return () => clearTimeout(t); }, [html, measure]);
  const step = (dir: 1 | -1) => setZ((v) => { const i = ZOOMS.indexOf(v); return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 2 : i) + dir))]; });
  const what = !preview ? "" : preview.kind === "pdf" ? `${preview.total} page${preview.total === 1 ? "" : "s"}${preview.total > preview.pages.length ? ` · ${busy ? "drawing" : "showing"} ${preview.pages.length}` : ""}`
    : preview.kind === "rows" ? `${preview.total} row${preview.total === 1 ? "" : "s"}${preview.total > preview.rows.length ? ` · first ${preview.rows.length} shown` : ""}`
      : preview.pages ? `${preview.pages} page${preview.pages === 1 ? "" : "s"}` : "Whole report";
  const btn = "inline-flex items-center justify-center whitespace-nowrap shrink-0 h-8 min-w-8 px-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40";
  return (
    <div className={`min-w-0 rounded-xl bg-slate-200/70 dark:bg-slate-800/60 flex flex-col ${fill ? "h-full" : "lg:sticky lg:top-4 lg:h-[calc(100vh-140px)] lg:min-h-[560px]"}`}>
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-300/70 dark:border-slate-700">
        <span className="min-w-0 text-[12px] font-semibold text-slate-700 dark:text-slate-200 mr-auto truncate">{busy && !preview ? "Getting it ready…" : what}{busy && preview ? " · updating" : ""}</span>
        {preview?.kind !== "rows" && (
          <>
            <button type="button" onClick={() => step(-1)} disabled={z === ZOOMS[0]} aria-label="Zoom out" className={btn}><Minus className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => setZ(1)} aria-label="Fit to width" className={`${btn} w-14`}>{z === 1 ? "Fit" : `${Math.round(z * 100)}%`}</button>
            <button type="button" onClick={() => step(1)} disabled={z === ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in" className={btn}><Plus className="w-3.5 h-3.5" /></button>
          </>
        )}
        {onFull && <button type="button" onClick={onFull} aria-label="Full screen" className={`${btn} gap-1`}><Maximize2 className="w-3.5 h-3.5" /> <span className="hidden min-[400px]:inline sm:inline">Full screen</span><span className="min-[400px]:hidden">Full</span></button>}
      </div>
      <div className={`min-h-0 p-3 sm:p-4 ${fill ? "flex-1 overflow-auto" : "lg:flex-1 lg:overflow-auto"}`}>
        <div ref={box} className="w-full">
          {err ? (
            <div className="rounded-lg bg-[var(--color-surface)] p-6 text-[12.5px] text-rose-700 dark:text-rose-400">Couldn&apos;t show it: {err}</div>
          ) : !preview ? (
            <div className="mx-auto rounded-sm bg-white shadow flex items-center justify-center text-[12px] text-slate-500" style={{ width: W * fit, height: 1056 * fit }}>
              {busy ? <span className="inline-flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Getting it ready…</span> : "Pick what to put on it."}
            </div>
          ) : preview.kind === "pdf" ? (
            <div className="space-y-4">
              {preview.pages.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element -- a page drawn in the browser
                <img key={i} src={src} alt={`Page ${i + 1}`} className={`block mx-auto max-w-none rounded-sm bg-white shadow ${busy ? "opacity-80" : ""}`} style={{ width: Math.max(120, Math.min(w - 2, 980) * z) }} />
              ))}
            </div>
          ) : preview.kind === "rows" ? (
            <div className={`rounded-sm bg-white shadow overflow-auto ${busy ? "opacity-60" : ""}`} style={fill ? undefined : { maxHeight: "calc(100vh - 220px)" }}>
              <table className="w-full border-collapse text-[11px] text-slate-900">
                <thead><tr>{preview.head.map((x) => <th key={x} className="sticky top-0 bg-slate-100 border border-slate-300 px-1.5 py-1 text-left font-bold whitespace-nowrap">{x}</th>)}</tr></thead>
                <tbody>
                  {preview.rows.length === 0 ? <tr><td colSpan={preview.head.length} className="px-2 py-4 text-center text-slate-500">Nothing in it yet.</td></tr>
                    : preview.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={`border border-slate-200 px-1.5 py-0.5 align-top ${c.length <= 24 ? "whitespace-nowrap" : "min-w-[220px]"}`}>{c}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={`mx-auto overflow-hidden rounded-sm bg-white shadow ${busy ? "opacity-60" : ""}`} style={{ width: W * k, height: h * k }}>
              {/* No scripts run in it; same origin only so its height can be read. */}
              <iframe ref={frame} title="The report" srcDoc={html} sandbox="allow-same-origin" tabIndex={-1} onLoad={measure}
                style={{ width: W, height: h, border: 0, transform: `scale(${k})`, transformOrigin: "0 0" }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The report full screen: its options beside it, as a print setup
 *  screen (above it on a phone, folded away), and what to do with it. */
function FullView({ name, onClose, actions, options, children }: { name: string; onClose: () => void; actions: React.ReactNode; options: React.ReactNode; children: React.ReactNode }) {
  const [opts, setOpts] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={name} className="fixed inset-0 z-[300] flex flex-col bg-[var(--color-bg,#f8fafc)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 sm:px-4 py-2">
        <b className="text-[14px] text-[var(--color-text)] mr-auto truncate">{name}</b>
        {options && (
          <button type="button" onClick={() => setOpts((v) => !v)} aria-pressed={opts} className="lg:hidden inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-[12.5px] font-bold text-[var(--color-text)]">
            <SlidersHorizontal className="w-4 h-4" /> Options
          </button>
        )}
        <button type="button" onClick={onClose} className="inline-flex items-center gap-1 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-[12.5px] font-bold text-[var(--color-text)]"><Minimize2 className="w-4 h-4" /> Close</button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <aside className={`${opts ? "block" : "hidden"} lg:block lg:w-[360px] shrink-0 max-h-[50vh] lg:max-h-none overflow-y-auto border-b lg:border-b-0 lg:border-r border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-4`}>
          {options}
          <div className="hidden lg:block">{actions}</div>
        </aside>
        <div className="flex-1 min-h-0 min-w-0 p-2 sm:p-3">{children}</div>
      </div>
      <div className="lg:hidden border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">{actions}</div>
    </div>
  );
}
