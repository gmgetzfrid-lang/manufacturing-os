"use client";

// ShiftReportView — the job's MEETINGS, as agendas you run live and hand out.
//
//   Kick-off   before / on day one — the job, readiness, equipment windows,
//              the critical chain, who's who, the first day and night shifts.
//   Turnover   every shift change — where we stand, safety & people, last
//              shift's results, decisions, the next shift's plan, close.
//   Close-out  at the end — final standing, what's open, lessons, sign-off.
//
// Built for running a meeting from it: a numbered agenda bar that stays on
// screen and jumps to each item (with its count and a red/amber flag when
// it needs attention), Present mode that shows one item at a time (← → keys),
// collapsible items, and dense tables — one line per step, grouped under
// its equipment — instead of a card per equipment.
//
// Copying: each agenda item also describes itself as data, written out as
// plain text or as an email (inline-styled tables Outlook keeps) — the same
// report as an update for management, minus the meeting's prompts and
// sign-off lines.
//
// Printing: the same agendas render a second time into a portal at the
// document root (hidden on screen) in a compact print layout: small type,
// one-line header, tables that may break across pages between rows (never
// mid-row), so a turnover fits on one or two sheets instead of leaving half
// pages blank.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Printer, ChevronLeft, ChevronRight, ChevronDown, Sun, Moon, AlertTriangle, CheckCircle2, Flag, FastForward,
  TrendingUp, TrendingDown, Minus, Zap, Presentation, X, Settings2, Rocket, ArrowLeftRight, Trophy,
  Copy, Mail, FileText, Check,
} from "lucide-react";
import type { Milestone } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import {
  buildShiftReport, shiftWindow, nextShift, previousShift, defaultReviewShift, nextShiftWithWork,
  DEFAULT_SHIFT_TIMES, type ShiftTimes, type ShiftRow, type ShiftWindow, type ShiftReport,
} from "@/lib/shiftReport";
import { buildKickoff, buildCloseout, defaultMeeting, type MeetingKind, type PlanRow } from "@/lib/meetingPlan";
import { clockLabel, fmtInTz, tzAbbrev } from "@/lib/scheduleTz";
import { completionNote } from "@/lib/scheduleRules";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { toPlainText, toEmailHtml, type ExportBlock, type ExportDoc, type ExportStepRow } from "@/lib/reportExport";

interface Props {
  milestones: Milestone[];
  progress?: Map<string, ProgressInfo>;
  criticalIds: Set<string>;
  projectId: string;
  projectName?: string;
}

function loadTimes(projectId: string): ShiftTimes {
  try {
    const raw = localStorage.getItem(`shiftTimes:${projectId}`);
    if (raw) { const p = JSON.parse(raw) as Partial<ShiftTimes>; return { ...DEFAULT_SHIFT_TIMES, ...p }; }
  } catch { /* private mode etc. */ }
  return DEFAULT_SHIFT_TIMES;
}

const MEETINGS: Array<{ id: MeetingKind; label: string; Icon: typeof Rocket }> = [
  { id: "kickoff", label: "Kick-off", Icon: Rocket },
  { id: "turnover", label: "Shift turnover", Icon: ArrowLeftRight },
  { id: "closeout", label: "Close-out", Icon: Trophy },
];

export default function ShiftReportView({ milestones, progress, criticalIds, projectId, projectName }: Props) {
  const tz = useScheduleTz();
  const [times, setTimes] = useState<ShiftTimes>(DEFAULT_SHIFT_TIMES);
  useEffect(() => { setTimes(loadTimes(projectId)); }, [projectId]);
  const saveTimes = (t: ShiftTimes) => {
    setTimes(t);
    try { localStorage.setItem(`shiftTimes:${projectId}`, JSON.stringify(t)); } catch { /* ignore */ }
  };
  const [showTimes, setShowTimes] = useState(false);

  // Re-evaluated every minute so a tab left open rolls over a shift
  // boundary (and "as of now" stays current) without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(id); }, []);

  const [meetingPick, setMeetingPick] = useState<MeetingKind | null>(null);
  const meeting = meetingPick ?? defaultMeeting(milestones, now, progress);

  const [sel, setSel] = useState<{ dayKey: string; kind: "day" | "night" } | null>(null);
  const shift: ShiftWindow = useMemo(
    () => (sel ? shiftWindow(sel.dayKey, sel.kind, tz, times) : defaultReviewShift(milestones, now, tz, times)),
    [sel, now, tz, times, milestones],
  );
  const pick = (w: ShiftWindow) => setSel({ dayKey: w.dayKey, kind: w.kind });

  // "As of": now while the shift is under way; the shift's end once it is
  // over, and ALSO for a shift in the future so the page can be rehearsed.
  const asOf = now >= shift.start && now < shift.end ? now : shift.end;
  const report = useMemo(
    () => buildShiftReport({ milestones, progress, criticalIds, tz, times, shift, now: asOf }),
    [milestones, progress, criticalIds, tz, times, shift, asOf],
  );
  const kickoff = useMemo(() => buildKickoff({ milestones, progress, criticalIds, tz, times }), [milestones, progress, criticalIds, tz, times]);
  const closeout = useMemo(() => buildCloseout({ milestones, progress, criticalIds }), [milestones, progress, criticalIds]);
  const rehearsal = now < shift.start;
  const jumpTarget = useMemo(() => (report.review.scheduled.length === 0 ? nextShiftWithWork(milestones, shift, tz, times) : null), [report.review.scheduled.length, milestones, shift, tz, times]);
  const byId = useMemo(() => { const m = new Map<string, Milestone>(); for (const x of milestones) if (x.id) m.set(x.id, x); return m; }, [milestones]);

  const ctx = useMemo(() => makeCtx(tz, byId, progress), [tz, byId, progress]);
  const sections = useMemo(() => meeting === "kickoff"
    ? kickoffSections(kickoff, ctx)
    : meeting === "closeout"
      ? closeoutSections(closeout, report, ctx)
      : turnoverSections(report, ctx, { onJump: jumpTarget ? () => pick(jumpTarget) : undefined, jumpTarget }),
  [meeting, kickoff, closeout, report, ctx, jumpTarget]);

  // ── live-meeting navigation ──
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [presenting, setPresenting] = useState<number | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const goTo = useCallback((id: string) => {
    if (presenting != null) { setPresenting(Math.max(0, sections.findIndex((s) => s.id === id))); return; }
    setCollapsed((c) => { const n = new Set(c); n.delete(id); return n; });
    requestAnimationFrame(() => refs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [presenting, sections]);
  useEffect(() => { setPresenting((p) => (p == null ? null : Math.min(p, sections.length - 1))); }, [sections.length]);
  useEffect(() => {
    if (presenting == null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); setPresenting((p) => Math.min(sections.length - 1, (p ?? 0) + 1)); }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); setPresenting((p) => Math.max(0, (p ?? 0) - 1)); }
      if (e.key === "Escape") setPresenting(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, sections.length]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // The report as data — for Copy (text / email).
  const exportDoc = (): ExportDoc => {
    const { overall, shift: sh, next } = report;
    const kind = meeting === "kickoff" ? "Kick-off meeting" : meeting === "closeout" ? "Close-out meeting" : "Shift turnover";
    const when = meeting === "turnover"
      ? `${shiftName(sh)} ${ctx.D(sh.start)} ${ctx.win(sh)} → ${shiftName(next)} ${ctx.D(next.start)} ${ctx.win(next)}`
      : meeting === "kickoff"
        ? (kickoff.start != null ? `Job starts ${ctx.DL(kickoff.start)} ${ctx.T(kickoff.start)} · ${kickoff.daysTotal} days` : "No dated work yet")
        : (closeout.finish != null ? `Planned finish ${ctx.DT(closeout.finish)}` : "");
    const status: ExportDoc["status"] = meeting === "kickoff" ? undefined
      : meeting === "closeout"
        ? (closeout.done >= closeout.steps ? { label: "COMPLETE", tone: "emerald" } : { label: `${closeout.steps - closeout.done} OPEN`, tone: "amber" })
        : { label: overall.standing === "ahead" ? "AHEAD" : overall.standing === "behind" ? "BEHIND" : "ON TRACK",
          tone: overall.standing === "ahead" ? "emerald" : overall.standing === "behind" ? "rose" : "slate",
          detail: `${overall.actualPct}% vs ${overall.plannedPct}% plan` };
    return {
      kind, project: projectName ?? "Schedule", when,
      asOf: `${ctx.DT(meeting === "turnover" ? asOf : now)} ${tzAbbrev(ctx.tz, now)}`,
      status,
      sections: sections.filter((x) => x.data).map((x) => ({ title: x.title, sub: x.sub, flag: x.flag ?? null, blocks: x.data!() })),
      footer: `${meeting === "turnover" ? "Plan % = work the schedule expected done by now, hour-weighted; actual % = progress entered. " : ""}Critical = on the chain that drives the finish date. Hours are planned work-hours.`,
    };
  };

  const head = (print: boolean) => (
    <Masthead meeting={meeting} report={report} kickoff={kickoff} closeout={closeout} ctx={ctx} asOf={asOf} now={now}
      rehearsal={rehearsal} projectName={projectName} print={print} />
  );

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03]">
      <style>{`
        [data-shift-print-root] { display: none; }
        @media print {
          @page { size: auto; margin: 9mm; }
          body > *:not([data-shift-print-root]) { display: none !important; }
          [data-shift-print-root] { display: block !important; width: 100%; max-width: 100%; margin: 0; font-size: 9pt; line-height: 1.3; color: #0f172a; background: #fff; }
          [data-shift-print-root] * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          [data-shift-print-root] .sec-head { break-after: avoid; }
          [data-shift-print-root] tr, [data-shift-print-root] .keep { break-inside: avoid; }
          [data-shift-print-root] thead { display: table-header-group; }
          [data-shift-print-root] .no-print { display: none !important; }
        }
      `}</style>

      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap rounded-t-2xl bg-gradient-to-b from-white to-slate-50/40 dark:from-transparent dark:to-transparent">
        <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-lg p-0.5 gap-0.5" role="tablist" aria-label="Meeting">
          {MEETINGS.map(({ id, label, Icon }) => (
            <button key={id} role="tab" aria-selected={meeting === id} onClick={() => { setMeetingPick(id); setPresenting(null); }}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold transition-colors ${meeting === id ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              <Icon className="w-3 h-3" /> {label}
            </button>
          ))}
        </div>

        {meeting === "turnover" && (
          <>
            <span className="mx-0.5 w-px h-4 bg-[var(--color-border)]" />
            <button onClick={() => pick(previousShift(shift, tz, times))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Previous shift"><ChevronLeft className="w-4 h-4" /></button>
            <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-md p-0.5 gap-0.5">
              {(["day", "night"] as const).map((k) => (
                <button key={k} onClick={() => setSel({ dayKey: shift.dayKey, kind: k })} className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold ${shift.kind === k ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                  {k === "day" ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />} {k === "day" ? "Day" : "Night"}
                </button>
              ))}
            </div>
            <input type="date" value={shift.dayKey} onChange={(e) => { if (e.target.value) setSel({ dayKey: e.target.value, kind: shift.kind }); }}
              className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-2 bg-[var(--color-surface)]" title="Which day's shift to close" />
            <button onClick={() => pick(nextShift(shift, tz, times))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Next shift"><ChevronRight className="w-4 h-4" /></button>
            <button onClick={() => setSel(null)} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">Current shift</button>
          </>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative">
            <button onClick={() => setShowTimes((v) => !v)} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Shift times" aria-expanded={showTimes}><Settings2 className="w-4 h-4" /></button>
            {showTimes && (
              <div className="absolute right-0 top-full mt-1 z-30 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-2.5 space-y-1.5 text-[11px] w-52">
                <div className="font-bold text-[var(--color-text)]">Shift change times (plant time)</div>
                <label className="flex items-center justify-between gap-2 text-[var(--color-text-muted)]"><span className="inline-flex items-center gap-1"><Sun className="w-3 h-3" /> Day starts</span>
                  <input type="time" value={times.dayStart} onChange={(e) => saveTimes({ ...times, dayStart: e.target.value || DEFAULT_SHIFT_TIMES.dayStart })} className="h-7 border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
                </label>
                <label className="flex items-center justify-between gap-2 text-[var(--color-text-muted)]"><span className="inline-flex items-center gap-1"><Moon className="w-3 h-3" /> Night starts</span>
                  <input type="time" value={times.nightStart} onChange={(e) => saveTimes({ ...times, nightStart: e.target.value || DEFAULT_SHIFT_TIMES.nightStart })} className="h-7 border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
                </label>
              </div>
            )}
          </div>
          <button onClick={() => setPresenting(presenting == null ? 0 : null)}
            className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg border ${presenting != null ? "bg-slate-900 text-white border-slate-900" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}
            title="Run the meeting one agenda item at a time (← → keys, Esc to leave)">
            {presenting != null ? <><X className="w-3.5 h-3.5" /> Leave present</> : <><Presentation className="w-3.5 h-3.5" /> Present</>}
          </button>
          <CopyMenu doc={exportDoc} />
          <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-3 py-1.5 rounded-lg shadow-sm">
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
        </div>
      </div>

      {head(false)}

      {/* ── Agenda bar: stays on screen, jumps to each item ───────────── */}
      <nav className="sticky top-0 z-20 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur flex items-center gap-1 overflow-x-auto" aria-label="Agenda">
        {sections.map((s, i) => {
          const active = presenting === i;
          const tone = s.flag === "rose" ? "border-rose-300 bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900"
            : s.flag === "amber" ? "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900"
              : "border-[var(--color-border)] text-[var(--color-text)]";
          return (
            <button key={s.id} onClick={() => goTo(s.id)}
              className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border pl-1 pr-2.5 py-0.5 text-[11px] font-bold hover:brightness-95 ${tone} ${active ? "ring-2 ring-[var(--color-accent)]" : ""}`}>
              <span className="w-[18px] h-[18px] rounded-full bg-slate-900 text-white text-[10px] font-black flex items-center justify-center">{i + 1}</span>
              {s.short}
              {s.count != null && <span className="font-mono font-bold opacity-70">{s.count}</span>}
            </button>
          );
        })}
      </nav>

      {/* ── Screen body ─────────────────────────────────────────────── */}
      {presenting != null && sections[presenting] ? (
        <div className="px-6 py-5 min-h-[420px] text-[14px]">
          <SectionHead n={presenting + 1} s={sections[presenting]} big />
          <div className="mt-3">{sections[presenting].body(false)}</div>
          <div className="mt-6 flex items-center justify-between no-print">
            <button disabled={presenting === 0} onClick={() => setPresenting(presenting - 1)} className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-[12px] font-bold disabled:opacity-30">
              <ChevronLeft className="w-4 h-4" /> {presenting > 0 ? sections[presenting - 1].short : "Back"}
            </button>
            <span className="text-[11px] text-[var(--color-text-muted)]">{presenting + 1} of {sections.length} · ← → to move · Esc to leave</span>
            <button disabled={presenting === sections.length - 1} onClick={() => setPresenting(presenting + 1)} className="inline-flex items-center gap-1 rounded-lg bg-slate-900 text-white px-3 py-2 text-[12px] font-bold disabled:opacity-30">
              {presenting < sections.length - 1 ? sections[presenting + 1].short : "Done"} <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 sm:px-5 py-3 space-y-3 text-[12.5px] text-[var(--color-text)]">
          {sections.map((s, i) => {
            const isCollapsed = collapsed.has(s.id);
            return (
              <section key={s.id} ref={(el) => { if (el) refs.current.set(s.id, el); else refs.current.delete(s.id); }} className="scroll-mt-12">
                <button className="w-full text-left" onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} aria-expanded={!isCollapsed}>
                  <SectionHead n={i + 1} s={s} collapsed={isCollapsed} />
                </button>
                {!isCollapsed && <div className="mt-2">{s.body(false)}</div>}
              </section>
            );
          })}
          <Footnote meeting={meeting} ctx={ctx} asOf={asOf} now={now} projectName={projectName} />
        </div>
      )}

      {/* Print copy — a direct child of <body>, so the page layout never
          offsets or clips it. Hidden on screen by the style above. */}
      {mounted && createPortal(
        <div data-shift-print-root>
          {head(true)}
          <div style={{ padding: "4px 0" }}>
            {sections.map((s, i) => (
              <section key={s.id} style={{ marginTop: 8 }}>
                <div className="sec-head"><SectionHead n={i + 1} s={s} print /></div>
                <div style={{ marginTop: 3 }}>{s.body(true)}</div>
              </section>
            ))}
            <Footnote meeting={meeting} ctx={ctx} asOf={asOf} now={now} projectName={projectName} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Copy ────────────────────────────────────────────────────────────

/** Rich copy: HTML for an email body, plain text alongside for anything
 *  that can't take HTML. Falls back to copying a selection where the
 *  clipboard API can't write HTML. */
async function copyRich(html: string, text: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
      return true;
    }
  } catch { /* fall through */ }
  const el = document.createElement("div");
  el.innerHTML = html;
  el.style.cssText = "position:fixed;left:-10000px;top:0;";
  document.body.appendChild(el);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges(); sel?.addRange(range);
  const ok = document.execCommand("copy");
  sel?.removeAllRanges(); el.remove();
  return ok;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.cssText = "position:fixed;left:-10000px;top:0;";
  document.body.appendChild(ta); ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

/** Copy ▾ — the report for an email (tables and colors kept; paste into
 *  Outlook, Gmail…) or as plain text (Teams, a text message). */
function CopyMenu({ doc }: { doc: () => ExportDoc }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{ what: "email" | "text"; ok: boolean; subject: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), 8000);
    return () => clearTimeout(t);
  }, [done]);

  const run = async (what: "email" | "text") => {
    setOpen(false);
    const d = doc();
    const text = toPlainText(d);
    const ok = what === "email" ? await copyRich(toEmailHtml(d), text) : await copyText(text);
    setDone({ what, ok, subject: `${d.project} — ${d.kind} — ${d.when.split(" → ").pop()}` });
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg border ${done?.ok ? "border-emerald-400 text-emerald-700 dark:text-emerald-300" : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}
        title="Copy this report to paste into an email or a message">
        {done?.ok ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {done?.ok ? "Copied" : "Copy"} <ChevronDown className="w-3 h-3 opacity-70" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-30 w-72 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-1">
          <button role="menuitem" onClick={() => void run("email")} className="w-full text-left flex items-start gap-2 rounded-md px-2.5 py-2 hover:bg-[var(--color-surface-2)]">
            <Mail className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-accent)]" />
            <span>
              <span className="block text-[12px] font-bold text-[var(--color-text)]">Copy for email</span>
              <span className="block text-[11px] text-[var(--color-text-muted)]">Paste into Outlook, Gmail or any email — keeps the tables and colors.</span>
            </span>
          </button>
          <button role="menuitem" onClick={() => void run("text")} className="w-full text-left flex items-start gap-2 rounded-md px-2.5 py-2 hover:bg-[var(--color-surface-2)]">
            <FileText className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
            <span>
              <span className="block text-[12px] font-bold text-[var(--color-text)]">Copy as plain text</span>
              <span className="block text-[11px] text-[var(--color-text-muted)]">For Teams, a text message, or a plain-text email.</span>
            </span>
          </button>
        </div>
      )}
      {done && !open && (
        <div role="status" className={`absolute right-0 top-full mt-1 z-30 w-72 rounded-lg border shadow-lg px-3 py-2 text-[11px] ${done.ok ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100 dark:border-emerald-900" : "border-rose-300 bg-rose-50 text-rose-900"}`}>
          {done.ok ? (
            <>
              <div className="font-bold">{done.what === "email" ? "Copied — paste it into your email (Ctrl+V)." : "Copied as text — paste it anywhere (Ctrl+V)."}</div>
              {done.what === "email" && (
                <a href={`mailto:?subject=${encodeURIComponent(done.subject)}`} className="mt-0.5 inline-flex items-center gap-1 font-bold underline">
                  <Mail className="w-3 h-3" /> Start a new email with the subject filled in
                </a>
              )}
            </>
          ) : <div className="font-bold">Your browser blocked the copy. Try again, or use Print.</div>}
        </div>
      )}
    </div>
  );
}

// ─── Formatting context ──────────────────────────────────────────────

interface Ctx {
  tz: string;
  D: (ms: number) => string;
  DL: (ms: number) => string;
  T: (ms: number) => string;
  DT: (ms: number) => string;
  /** Short date + time for table cells: "Oct 22 7:30". */
  DTs: (ms: number) => string;
  hrs: (h: number) => string;
  win: (w: ShiftWindow) => string;
  span: (a: number, b: number) => string;
  group: (parentId: string | null, parentName: string | null, crumbs: string[], fallback: string) => TGroup;
}

function makeCtx(tz: string, byId: Map<string, Milestone>, progress?: Map<string, ProgressInfo>): Ctx {
  const D = (ms: number) => fmtInTz(ms, tz, { weekday: "short", month: "short", day: "numeric" });
  const DL = (ms: number) => fmtInTz(ms, tz, { weekday: "long", month: "long", day: "numeric" });
  const T = (ms: number) => clockLabel(ms, tz) || "0:00";
  const DT = (ms: number) => `${D(ms)} ${T(ms)}`;
  const day = (ms: number) => fmtInTz(ms, tz, { year: "numeric", month: "numeric", day: "numeric" });
  const DS = (ms: number) => fmtInTz(ms, tz, { month: "short", day: "numeric" });
  const DTs = (ms: number) => `${DS(ms)} ${T(ms)}`;
  const span = (a: number, b: number) => (!Number.isFinite(a) || !Number.isFinite(b) ? "—" : day(a) === day(b) ? `${DS(a)} ${T(a)}–${T(b)}` : `${DTs(a)} → ${DTs(b)}`);
  return {
    tz, D, DL, T, DT, DTs, span,
    hrs: (h: number) => `${Math.round(h * 10) / 10} h`,
    win: (w) => `${T(w.start)}–${T(w.end)}${day(w.start) === day(w.end) ? "" : ` (${D(w.end)})`}`,
    group: (parentId, parentName, crumbs, fallback) => {
      const parent = parentId ? byId.get(parentId) : undefined;
      const info = parentId ? progress?.get(parentId) : undefined;
      const ps = parent ? startMsOf(parent) : NaN, pf = parent ? finishMsOf(parent) : NaN;
      return {
        key: parentId ?? `solo:${fallback}`,
        title: parentName ?? "",
        crumbs: crumbs.join(" › "),
        meta: [Number.isFinite(ps) && Number.isFinite(pf) ? span(ps, pf) : null, info ? `${info.leafDone}/${info.leafTotal} steps · ${info.percent}%` : null].filter(Boolean).join(" · "),
      };
    },
  };
}

// ─── Agenda items ────────────────────────────────────────────────────

type Flag = "rose" | "amber" | null;
interface Sec {
  id: string;
  title: string;
  /** Short label for the agenda bar. */
  short: string;
  sub?: string;
  count?: number;
  flag?: Flag;
  body: (print: boolean) => React.ReactNode;
  /** The item as data for a copied report (text / email). Absent for the
   *  talk-track items — prompts and sign-off — which an update leaves out. */
  data?: () => ExportBlock[];
}

/** Table rows as export rows: same text, tags without the null slots. */
function exportRows(rows: TRow[]): ExportStepRow[] {
  return rows.map((r) => ({
    group: r.group.title ? { title: r.group.title, crumbs: r.group.crumbs || undefined, meta: r.group.meta || undefined } : undefined,
    n: r.n?.num, when: r.when, name: r.name,
    tags: (r.tags ?? []).filter((t): t is TagT => !!t).map((t) => ({ t: t.t, tone: t.tone })),
    who: r.who, wo: r.wo, right: r.right, note: r.note,
  }));
}
const stepsBlock = (rows: TRow[], rightHead: string, whenHead = "When", flat?: boolean): ExportBlock =>
  ({ k: "steps", rows: exportRows(rows), rightHead, whenHead, flat });

const shiftName = (w: ShiftWindow) => (w.kind === "day" ? "Day shift" : "Night shift");

function rowFromShift(r: ShiftRow, c: Ctx, o: { when: string; n?: { num: number; tone: NumTone }; box?: boolean; right: string; done?: boolean; extraTags?: Array<TagT | null>; note?: string }): TRow {
  return {
    id: r.leaf.id ?? r.leaf.name,
    group: c.group(r.parentId, r.parentName, r.path.slice(0, -1), r.leaf.name),
    n: o.n, box: o.box, when: o.when, name: r.leaf.name, done: o.done,
    tags: [r.critical ? { t: "critical", tone: "rose" } : null, ...(o.extraTags ?? [])],
    who: r.leaf.responsibleParty ?? undefined, wo: r.leaf.workOrderRef ?? undefined,
    right: o.right, note: o.note,
  };
}

function rowFromPlan(r: PlanRow, c: Ctx, o: { when?: string; right?: string; n?: { num: number; tone: NumTone }; note?: string; extraTags?: Array<TagT | null>; noCriticalTag?: boolean }): TRow {
  return {
    id: r.leaf.id ?? r.leaf.name,
    group: c.group(r.parentId, r.parentName, r.crumbs, r.leaf.name),
    n: o.n, when: o.when ?? c.span(r.start, r.finish), name: r.leaf.name,
    tags: [r.critical && !o.noCriticalTag ? { t: "critical", tone: "rose" } : null, ...(o.extraTags ?? [])],
    who: r.who ?? undefined, wo: r.leaf.workOrderRef ?? undefined,
    right: o.right ?? c.hrs(r.hours), note: o.note,
  };
}

function turnoverSections(report: ShiftReport, c: Ctx, o: { onJump?: () => void; jumpTarget: ShiftWindow | null }): Sec[] {
  const { overall, review, goals, blocked, shift, next } = report;
  const rowTime = (r: ShiftRow, w: ShiftWindow) => {
    const s = r.start >= w.start && r.start < w.end ? c.T(r.start) : null;
    const f = r.finish > w.start && r.finish <= w.end ? c.T(r.finish) : null;
    if (!s && !f) return "all shift";
    return `${s ?? "…"}–${f ?? "…"}`;
  };
  const seen = new Set<string>();
  const didNotFinish: ShiftRow[] = [];
  // This crew's unfinished work — another crew's leftovers are theirs.
  const ownWork = (r: ShiftRow) => r.work === "both" || r.work === shift.kind;
  for (const r of [...review.carryOver, ...review.inProgress, ...review.notStarted]) {
    if (!ownWork(r)) continue;
    if (!r.leaf.id || seen.has(r.leaf.id)) continue;
    seen.add(r.leaf.id); didNotFinish.push(r);
  }
  didNotFinish.sort((a, b) => Number(b.critical) - Number(a.critical) || Number(b.carryOver) - Number(a.carryOver) || a.start - b.start);
  const priorityOf = new Map<string, number>();
  goals.all.forEach((r, i) => { if (r.leaf.id) priorityOf.set(r.leaf.id, i + 1); });
  const gap = goals.gapHours;
  const stretchHours = goals.stretch.reduce((a, r) => a + r.hoursLeft, 0);
  const stretchMsg = gap > 0.5
    ? (goals.backOnTrackAt
      ? `About ${c.hrs(gap)} behind plan. Must-do holds the line; stretch 1–${goals.backOnTrackAt} (${c.hrs(goals.stretch.slice(0, goals.backOnTrackAt).reduce((a, r) => a + r.hoursLeft, 0))}) gets you back on plan.`
      : goals.stretch.length
        ? `About ${c.hrs(gap)} behind plan. Every stretch item closes the gap; all ${goals.stretch.length} are ${c.hrs(stretchHours)}.`
        : `About ${c.hrs(gap)} behind plan. Nothing else is ready to pull forward — clearing must-do is the whole job.`)
    : gap < -0.5 ? `About ${c.hrs(-gap)} ahead of plan. Anything here banks more time.` : "On plan. Anything here puts you ahead.";
  const critCarry = goals.carryOver.filter((r) => r.critical).length;
  // "After #2": a step waiting on another must-do step names its number;
  // on something off this list, its name.
  const waitTag = (r: ShiftRow): TagT | null => {
    if (r.waitingOn.length === 0) return null;
    const nums = r.waitingOn.map((w) => priorityOf.get(w.id)).filter((n): n is number => n != null);
    return nums.length === r.waitingOn.length
      ? { t: `after #${nums.join(", #")}`, tone: "amber" }
      : { t: `waits on ${r.waitingOn[0].name}${r.waitingOn.length > 1 ? ` +${r.waitingOn.length - 1}` : ""}`, tone: "amber" };
  };
  const waiting = goals.all.filter((r) => r.waitingOn.length > 0);
  const waitingMsg = waiting.length > 0
    ? `${waiting.length} step${waiting.length === 1 ? "" : "s"} (${waiting.map((r) => `#${priorityOf.get(r.leaf.id ?? "") ?? "?"}`).join(", ")}) can't start until the steps before ${waiting.length === 1 ? "it are" : "them are"} done — ${waiting.length === 1 ? "it" : "they"} will run late unless those are cleared first.`
    : null;

  const lastRows = didNotFinish.map((r) => rowFromShift(r, c, {
    when: r.offSchedule ? `due ${c.DTs(r.finish)}` : rowTime(r, shift),
    n: undefined,
    right: r.percent > 0 ? `${r.percent}%` : "not started",
    extraTags: [
      r.status === "blocked" ? { t: "blocked", tone: "rose" } : r.status === "on_hold" ? { t: "on hold", tone: "amber" } : null,
      r.overdue ? { t: "overdue", tone: "amber" } : r.lateStart ? { t: "late start", tone: "amber" } : null,
    ],
  }));
  const doneItems = review.done.map((r) => ({
    id: r.leaf.id ?? r.leaf.name,
    text: `${r.parentName ? `${r.parentName} › ` : ""}${r.leaf.name}`,
    note: [r.offSchedule ? `planned ${c.D(r.start)}` : rowTime(r, shift), completionNote(r.leaf.actualAt, r.finish, c.tz)].filter(Boolean).join(" · "),
  }));
  const decideRows = blocked.map((r) => rowFromShift(r, c, {
    when: `${r.percent}%`,
    right: c.DTs(r.finish),
    extraTags: [r.status === "blocked" ? { t: "blocked", tone: "rose" } : { t: "on hold", tone: "amber" }],
    note: r.reason ? `Reason: ${r.reason}` : "No reason recorded — ask the crew lead.",
  }));
  const nextRows = goals.all.map((r) => rowFromShift(r, c, {
    when: r.carryOver ? `due ${c.DTs(r.finish)}` : rowTime(r, next),
    n: { num: priorityOf.get(r.leaf.id ?? "") ?? 0, tone: r.critical ? "rose" : r.carryOver ? "amber" : "slate" },
    right: `${r.percent > 0 ? `${r.percent}% · ` : ""}${c.hrs(r.hoursLeft)}`,
    extraTags: [
      r.carryOver ? { t: "carry-over", tone: "amber" } : null,
      !r.carryOver && r.lateStart ? { t: "late start", tone: "amber" } : null,
      waitTag(r),
      !r.carryOver && r.start < next.start ? { t: `since ${c.D(r.start)}`, tone: "muted" } : null,
      r.finish > next.end ? { t: `to ${c.D(r.finish)}`, tone: "muted" } : null,
    ],
  }));
  const otherKind = next.kind === "day" ? "night" : "day";
  const otherRows = goals.otherShift.map((r) => rowFromShift(r, c, {
    when: `due ${c.DTs(r.finish)}`,
    right: r.percent > 0 ? `${r.percent}% · ${c.hrs(r.hoursLeft)}` : c.hrs(r.hoursLeft),
    extraTags: [r.status === "blocked" ? { t: "blocked", tone: "rose" } : r.status === "on_hold" ? { t: "on hold", tone: "amber" } : null],
  }));
  const otherTitle = `Waiting for the ${otherKind} shift — ${otherKind} work, not on this shift's list`;
  const stretchRows = goals.stretch.map((r, i) => {
    const closes = goals.backOnTrackAt != null && i + 1 <= goals.backOnTrackAt;
    return rowFromShift(r, c, {
      when: `planned ${c.DTs(r.start)}`,
      n: { num: i + 1, tone: closes ? "amber" : "slate" },
      right: c.hrs(r.hoursLeft),
      extraTags: [closes ? { t: "back on track", tone: "amber" } : null],
    });
  });
  const standStats = [
    { label: "Actual", value: `${overall.actualPct}%`, tone: (overall.standing === "behind" ? "rose" : overall.standing === "ahead" ? "emerald" : "slate") as "rose" | "emerald" | "slate" },
    { label: "Plan by now", value: `${overall.plannedPct}%`, tone: "slate" as const },
    { label: "Gap", value: gap > 0.5 ? `−${c.hrs(gap)}` : gap < -0.5 ? `+${c.hrs(-gap)}` : "even", tone: (gap > 0.5 ? "rose" : gap < -0.5 ? "emerald" : "slate") as "rose" | "emerald" | "slate" },
    { label: "Steps done", value: `${overall.stepsDone}/${overall.stepsTotal}`, tone: "slate" as const },
    { label: "Carry-over", value: `${review.carryOver.length}`, tone: (review.carryOver.length ? "amber" : "emerald") as "amber" | "emerald" },
  ];
  const nothingLast = review.scheduled.length === 0 && review.done.length === 0 && didNotFinish.length === 0;

  return [
    {
      id: "stand", title: "Where we stand", short: "Status",
      sub: [overall.plannedFinish ? `Day ${overall.daysElapsed} of ${overall.daysTotal} · planned finish ${c.DT(overall.plannedFinish)}` : null,
        overall.planBasis === "baseline" ? `vs baseline${overall.baselineSetAt ? ` of ${c.D(Date.parse(overall.baselineSetAt))}` : ""}` : "vs live dates (no baseline)"].filter(Boolean).join(" · "),
      flag: overall.standing === "behind" ? "rose" : null,
      body: () => (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 keep">
          {standStats.map((x) => <Stat key={x.label} label={x.label} value={x.value} tone={x.tone} />)}
        </div>
      ),
      data: () => [{ k: "stats", items: standStats }],
    },
    {
      id: "safety", title: "Safety & people", short: "Safety",
      sub: "Open every turnover here — then the work.",
      body: (print) => <Prompts print={print} items={[
        "Safety moment — incidents, near misses, first aid since last turnover",
        "Permits, isolations and lock-outs that stay open across the change",
        "Manpower and equipment — who is short, what is down, what arrives",
        "Hazards on the next shift's work (lifts, confined space, hot work, line breaks)",
      ]} />,
    },
    {
      id: "last", title: `Last shift — ${shiftName(shift)} ${c.D(shift.start)} ${c.win(shift)}`, short: "Last shift",
      sub: `${review.scheduled.length} planned · ${review.done.length} done · ${didNotFinish.length} did not finish`,
      count: didNotFinish.length, flag: didNotFinish.some((r) => r.critical) ? "rose" : didNotFinish.length ? "amber" : null,
      data: () => nothingLast ? [{ k: "empty", text: "Nothing was planned for this shift." }] : [
        { k: "sub", title: "Did not finish — carries over", count: didNotFinish.length, tone: "amber" },
        didNotFinish.length === 0 ? { k: "empty", text: "Everything planned for this shift is done." } : stepsBlock(lastRows, "Done"),
        { k: "sub", title: "Completed", count: review.done.length, tone: "emerald" },
        review.done.length === 0 ? { k: "empty", text: "Nothing was completed on this shift." } : { k: "list", items: doneItems },
      ],
      body: (print) => nothingLast ? (
        <Empty>
          Nothing was planned for this shift.
          {o.onJump && o.jumpTarget && !print && (
            <button onClick={o.onJump} className="ml-2 inline-flex items-center gap-1 font-bold text-[var(--color-accent)] hover:underline">
              <FastForward className="w-3.5 h-3.5" /> Jump to {o.jumpTarget.kind} shift, {c.D(o.jumpTarget.start)}
            </button>
          )}
        </Empty>
      ) : (
        <div className="space-y-2">
          <Sub tone="amber" icon={<AlertTriangle className="w-3.5 h-3.5" />} title="Did not finish — carries over" count={didNotFinish.length} />
          {didNotFinish.length === 0 ? <Empty>Everything planned for this shift is done.</Empty> : (
            <StepTable print={print} rightHead="Done" rows={lastRows} />
          )}
          <Sub tone="emerald" icon={<CheckCircle2 className="w-3.5 h-3.5" />} title="Completed" count={review.done.length} />
          {review.done.length === 0 ? <Empty>Nothing was completed on this shift.</Empty> : (
            <DoneList print={print} items={doneItems} />
          )}
        </div>
      ),
    },
    {
      id: "decide", title: "Needs a decision", short: "Decisions",
      sub: blocked.length === 0 ? "No blocked or on-hold work." : `${blocked.length} blocked or on hold — name an owner for each`,
      count: blocked.length, flag: blocked.some((r) => r.status === "blocked") ? "rose" : blocked.length ? "amber" : null,
      body: (print) => blocked.length === 0 ? <Empty>Nothing is blocked or on hold.</Empty> : (
        <StepTable print={print} rightHead="Due" ownerLine rows={decideRows} whenHead="Done" />
      ),
      data: () => [blocked.length === 0 ? { k: "empty", text: "Nothing is blocked or on hold." } : stepsBlock(decideRows, "Due", "Done")],
    },
    {
      id: "next", title: `Next shift — ${shiftName(next)} ${c.D(next.start)} ${c.win(next)}`, short: "Next shift",
      sub: `Must do: ${goals.all.length} steps · ${c.hrs(goals.mustDoHours)} · ${goals.carryOver.length} carried over · ${goals.critical.length} critical`,
      count: goals.all.length, flag: critCarry ? "rose" : goals.carryOver.length ? "amber" : null,
      body: (print) => (
        <div className="space-y-2">
          <Sub tone="slate" icon={<Flag className="w-3.5 h-3.5" />} title="Must do — in this order" count={goals.all.length} />
          {waitingMsg && <div className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-300 keep">{waitingMsg}</div>}
          {goals.all.length === 0 ? <Empty>Nothing is scheduled for the next shift.</Empty> : (
            <StepTable print={print} box rightHead="Left" rows={nextRows} />
          )}
          <Sub tone={gap > 0.5 ? "amber" : "emerald"} icon={<Zap className="w-3.5 h-3.5" />} title="Stretch — if you have the hands" count={goals.stretch.length} />
          <div className={`text-[11.5px] font-semibold ${gap > 0.5 ? "text-amber-800 dark:text-amber-300" : "text-emerald-800 dark:text-emerald-300"}`}>{stretchMsg}</div>
          {goals.stretch.length > 0 && <StepTable print={print} box rightHead="Left" rows={stretchRows} />}
          {goals.otherShift.length > 0 && (
            <>
              <Sub tone="slate" icon={next.kind === "day" ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />} title={otherTitle} count={goals.otherShift.length} />
              <StepTable print={print} rightHead="Left" rows={otherRows} />
            </>
          )}
        </div>
      ),
      data: () => [
        { k: "sub", title: "Must do — in this order", count: goals.all.length, tone: "slate" },
        ...(waitingMsg ? [{ k: "note", text: waitingMsg, tone: "amber" } as ExportBlock] : []),
        goals.all.length === 0 ? { k: "empty", text: "Nothing is scheduled for the next shift." } : stepsBlock(nextRows, "Left"),
        { k: "sub", title: "Stretch — if you have the hands", count: goals.stretch.length, tone: gap > 0.5 ? "amber" : "emerald" },
        { k: "note", text: stretchMsg, tone: gap > 0.5 ? "amber" : "emerald" },
        ...(goals.stretch.length > 0 ? [stepsBlock(stretchRows, "Left")] : []),
        ...(goals.otherShift.length > 0 ? [{ k: "sub", title: otherTitle, count: goals.otherShift.length, tone: "slate" } as ExportBlock, stepsBlock(otherRows, "Left")] : []),
      ],
    },
    closeSection("Close", ["Outgoing supervisor", "Incoming supervisor", "Crew lead"]),
  ];
}

function kickoffSections(k: ReturnType<typeof buildKickoff>, c: Ctx): Sec[] {
  const jobStats = [
    { label: "Days", value: `${k.daysTotal}`, tone: "slate" as const },
    { label: "Steps", value: `${k.steps}`, tone: "slate" as const },
    { label: "Work-hours", value: c.hrs(k.hours), tone: "slate" as const },
    { label: "Equipment / areas", value: `${k.groups.length}`, tone: "slate" as const },
    { label: "On critical path", value: `${k.critical.length}`, tone: (k.critical.length ? "rose" : "slate") as "rose" | "slate" },
  ];
  const unscheduledMsg = k.unscheduled > 0 ? `${k.unscheduled} step${k.unscheduled === 1 ? " has" : "s have"} no planned dates yet — not in the numbers above.` : null;
  const notReadyRows = k.notReady.map((r) => rowFromPlan(r, c, {
    extraTags: [r.leaf.status === "blocked" ? { t: "blocked", tone: "rose" } : { t: "on hold", tone: "amber" }],
    note: r.leaf.statusReason ? `Reason: ${r.leaf.statusReason}` : "No reason recorded.",
  }));
  const critRows = k.critical.map((r, i) => rowFromPlan(r, c, { n: { num: i + 1, tone: "rose" }, noCriticalTag: true }));
  const shiftRowsOf = (s: (typeof k.firstShifts)[number]) => s.rows.map((r, j) => rowFromShift(r, c, {
    when: (() => { const a = r.start >= s.window.start ? c.T(r.start) : "…"; const b = r.finish <= s.window.end ? c.T(r.finish) : "…"; return `${a}–${b}`; })(),
    n: { num: j + 1, tone: r.critical ? "rose" : "slate" }, right: c.hrs(r.hoursLeft),
    extraTags: [r.finish > s.window.end ? { t: `to ${c.D(r.finish)}`, tone: "muted" } : null],
  }));
  const secs: Sec[] = [
    {
      id: "job", title: "The job at a glance", short: "The job",
      sub: k.start != null && k.finish != null ? `${c.DT(k.start)} → ${c.DT(k.finish)}` : "No dated steps yet",
      flag: k.unscheduled > 0 ? "amber" : null,
      body: () => (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 keep">
            {jobStats.map((x) => <Stat key={x.label} label={x.label} value={x.value} tone={x.tone} />)}
          </div>
          {unscheduledMsg && <div className="text-[11.5px] font-semibold text-amber-800 dark:text-amber-300">{unscheduledMsg}</div>}
        </div>
      ),
      data: () => [{ k: "stats", items: jobStats }, ...(unscheduledMsg ? [{ k: "note", text: unscheduledMsg, tone: "amber" } as ExportBlock] : [])],
    },
    {
      id: "ready", title: "Safety & readiness", short: "Readiness",
      sub: k.notReady.length ? `${k.notReady.length} step${k.notReady.length === 1 ? "" : "s"} blocked or on hold before day one` : "Nothing blocked or on hold",
      count: k.notReady.length || undefined, flag: k.notReady.length ? "rose" : null,
      body: (print) => (
        <div className="space-y-2">
          <Prompts print={print} items={[
            "Job safety plan reviewed — hazards, permits, rescue plans, emergency muster",
            "Isolations, blinds and lock-out list agreed with operations",
            "Materials, tools, cranes and scaffold on site or dated",
            "Contacts — operations, safety, QA/QC, each contractor's lead",
          ]} />
          {k.notReady.length > 0 && <StepTable print={print} rightHead="Hours" ownerLine rows={notReadyRows} />}
        </div>
      ),
      data: () => [k.notReady.length ? stepsBlock(notReadyRows, "Hours") : { k: "empty", text: "Nothing blocked or on hold before day one." }],
    },
    {
      id: "equip", title: "Equipment & windows", short: "Equipment",
      sub: "Each piece of work, its window, and who does it — in start order",
      count: k.groups.length,
      body: (print) => k.groups.length === 0 ? <Empty>No dated work yet.</Empty> : (
        <SimpleTable print={print} head={["Equipment / area", "Window", "Steps", "Hours", "Who"]}
          rows={k.groups.map((g) => ({
            id: g.id,
            cells: [
              <span key="n"><b>{g.name}</b>{g.crumbs.length ? <span className="text-[var(--color-text-faint)]"> · {g.crumbs.join(" › ")}</span> : null}{g.critical ? <> <TagChip t={`${g.critical} critical`} tone="rose" /></> : null}</span>,
              c.span(g.start, g.finish), `${g.steps}`, c.hrs(g.hours), g.who.join(", ") || "—",
            ],
          }))} />
      ),
      data: () => [k.groups.length === 0 ? { k: "empty", text: "No dated work yet." } : {
        k: "table", head: ["Equipment / area", "Window", "Steps", "Hours", "Who"],
        rows: k.groups.map((g) => [`${g.name}${g.critical ? ` (${g.critical} critical)` : ""}`, c.span(g.start, g.finish), `${g.steps}`, c.hrs(g.hours), g.who.join(", ") || "—"]),
      }],
    },
    {
      id: "crit", title: "Critical path — what drives the finish date", short: "Critical path",
      sub: k.critical.length ? `${k.critical.length} steps · any slip here moves the end date` : "No critical chain computed",
      count: k.critical.length,
      body: (print) => k.critical.length === 0 ? <Empty>No critical chain — check the step links.</Empty> : (
        <StepTable print={print} flat rightHead="Hours" rows={critRows} />
      ),
      data: () => [k.critical.length === 0 ? { k: "empty", text: "No critical chain computed." } : stepsBlock(critRows, "Hours", "When", true)],
    },
    {
      id: "who", title: "Who's who", short: "Who's who",
      sub: k.people.length ? `${k.people.length} crews / companies named on the schedule` : "No responsible parties on the schedule",
      count: k.people.length,
      body: (print) => k.people.length === 0 ? <Empty>Add a responsible party to steps to see who does what.</Empty> : (
        <SimpleTable print={print} head={["Crew / company", "Steps", "Hours", "First on the job", "Contact"]}
          rows={k.people.map((p) => ({ id: p.name, cells: [<b key="n">{p.name}</b>, `${p.steps}`, c.hrs(p.hours), c.DT(p.first), <Blank key="b" print={print} />] }))} />
      ),
      data: () => [k.people.length === 0 ? { k: "empty", text: "No responsible parties on the schedule." } : {
        k: "table", head: ["Crew / company", "Steps", "Hours", "First on the job"],
        rows: k.people.map((p) => [p.name, `${p.steps}`, c.hrs(p.hours), c.DT(p.first)]),
      }],
    },
    ...k.firstShifts.map((s, i): Sec => ({
      id: `first${i}`, title: `${i === 0 ? "First" : "Then"}: ${shiftName(s.window)} ${c.D(s.window.start)} ${c.win(s.window)}`,
      short: i === 0 ? `Day 1 ${s.window.kind}` : `${s.window.kind === "day" ? "Day" : "Night"} ${c.D(s.window.start).split(",")[0]}`,
      sub: `${s.rows.length} steps · ${c.hrs(s.hours)}`,
      count: s.rows.length,
      body: (print) => s.rows.length === 0 ? <Empty>Nothing scheduled on this shift.</Empty> : (
        <StepTable print={print} box rightHead="Hours" rows={shiftRowsOf(s)} />
      ),
      data: () => [s.rows.length === 0 ? { k: "empty", text: "Nothing scheduled on this shift." } : stepsBlock(shiftRowsOf(s), "Hours")],
    })),
    closeSection("Close", ["Project / turnaround lead", "Operations", "Safety", "Each contractor lead"], "Attendance and sign-off"),
  ];
  return secs;
}

function closeoutSections(co: ReturnType<typeof buildCloseout>, report: ShiftReport, c: Ctx): Sec[] {
  const finalStats = [
    { label: "Complete", value: `${co.actualPct}%`, tone: (co.actualPct >= 100 ? "emerald" : "amber") as "emerald" | "amber" },
    { label: "Steps done", value: `${co.done}/${co.steps}`, tone: "slate" as const },
    { label: "On time", value: `${co.onTime}`, tone: "emerald" as const },
    { label: "Late", value: `${co.late}`, tone: (co.late ? "amber" : "slate") as "amber" | "slate" },
    { label: "vs plan", value: `${report.overall.variancePct > 0 ? "+" : ""}${report.overall.variancePct} pts`, tone: (report.overall.standing === "behind" ? "rose" : "slate") as "rose" | "slate" },
  ];
  const openRows = co.open.map((r) => rowFromPlan(r, c, { right: `${r.percent}%` }));
  const blockedRows = co.blocked.map((r) => rowFromPlan(r, c, {
    right: `${r.percent}%`,
    extraTags: [r.leaf.status === "blocked" ? { t: "blocked", tone: "rose" } : { t: "on hold", tone: "amber" }],
    note: r.leaf.statusReason ? `Reason: ${r.leaf.statusReason}` : undefined,
  }));
  return [
    {
      id: "final", title: "Final standing", short: "Standing",
      sub: co.finish != null ? `Planned finish ${c.DT(co.finish)}${co.lastActual ? ` · last step completed ${c.DT(co.lastActual)}` : ""}` : undefined,
      flag: co.done < co.steps ? "amber" : null,
      body: () => (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 keep">
          {finalStats.map((x) => <Stat key={x.label} label={x.label} value={x.value} tone={x.tone} />)}
        </div>
      ),
      data: () => [{ k: "stats", items: finalStats }],
    },
    {
      id: "open", title: "Still open", short: "Open work", count: co.open.length, flag: co.open.some((r) => r.critical) ? "rose" : co.open.length ? "amber" : null,
      sub: co.open.length ? "Finish, hand over to operations, or move to the punch list" : "Every step is done",
      body: (print) => co.open.length === 0 ? <Empty>Nothing open.</Empty> : (
        <StepTable print={print} box ownerLine rightHead="Done" rows={openRows} />
      ),
      data: () => [co.open.length === 0 ? { k: "empty", text: "Nothing open." } : stepsBlock(openRows, "Done")],
    },
    {
      id: "blocked", title: "Blocked / on hold", short: "Blocked", count: co.blocked.length, flag: co.blocked.length ? "rose" : null,
      body: (print) => co.blocked.length === 0 ? <Empty>Nothing blocked or on hold.</Empty> : (
        <StepTable print={print} ownerLine rightHead="Done" rows={blockedRows} />
      ),
      data: () => [co.blocked.length === 0 ? { k: "empty", text: "Nothing blocked or on hold." } : stepsBlock(blockedRows, "Done")],
    },
    {
      id: "lessons", title: "Hand-back & lessons", short: "Lessons",
      body: (print) => <Prompts print={print} lines={2} items={[
        "Equipment handed back to operations — isolations removed, blinds out, permits closed",
        "Punch list and turnover documents — what's outstanding and who owns it",
        "What went well — keep doing",
        "What didn't — change next time",
      ]} />,
    },
    closeSection("Sign-off", ["Project / turnaround lead", "Operations", "Safety"]),
  ];
}

function closeSection(title: string, signers: string[], sub = "Notes, actions and sign-off"): Sec {
  return {
    id: "close", title, short: title, sub,
    body: (print) => (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 keep">
        <div className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5">
          <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Notes & actions</div>
          {Array.from({ length: print ? 4 : 3 }).map((_, i) => <div key={i} className="h-5 border-b border-dotted border-[var(--color-border-strong)]" />)}
        </div>
        <div className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 space-y-2">
          <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Sign-off</div>
          {signers.map((who) => (
            <div key={who} className="flex items-end gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span className="w-40 shrink-0">{who}</span>
              <span className="flex-1 border-b border-[var(--color-border-strong)]" />
              <span className="w-12 border-b border-[var(--color-border-strong)] text-center text-[9px]">time</span>
            </div>
          ))}
        </div>
      </div>
    ),
  };
}

// ─── Masthead & footnote ─────────────────────────────────────────────

function Masthead({ meeting, report, kickoff, closeout, ctx: c, asOf, now, rehearsal, projectName, print }: {
  meeting: MeetingKind; report: ShiftReport; kickoff: ReturnType<typeof buildKickoff>; closeout: ReturnType<typeof buildCloseout>;
  ctx: Ctx; asOf: number; now: number; rehearsal: boolean; projectName?: string; print: boolean;
}) {
  const { overall, shift, next } = report;
  const standing = overall.standing;
  const pill = meeting === "kickoff" ? null
    : meeting === "closeout"
      ? { label: closeout.done >= closeout.steps ? "COMPLETE" : `${closeout.steps - closeout.done} OPEN`, cls: closeout.done >= closeout.steps ? "emerald" : "amber", Icon: CheckCircle2 }
      : standing === "ahead" ? { label: "AHEAD", cls: "emerald", Icon: TrendingUp }
        : standing === "behind" ? { label: "BEHIND", cls: "rose", Icon: TrendingDown } : { label: "ON TRACK", cls: "slate", Icon: Minus };
  const pillCls = !pill ? "" : print
    ? `border-2 ${pill.cls === "emerald" ? "border-emerald-700 text-emerald-800" : pill.cls === "rose" ? "border-rose-700 text-rose-800" : pill.cls === "amber" ? "border-amber-700 text-amber-800" : "border-slate-700 text-slate-800"}`
    : pill.cls === "emerald" ? "bg-emerald-600 text-white" : pill.cls === "rose" ? "bg-rose-600 text-white" : pill.cls === "amber" ? "bg-amber-500 text-white" : "bg-slate-700 text-white";
  const title = meeting === "kickoff" ? "Kick-off meeting" : meeting === "closeout" ? "Close-out meeting" : "Shift turnover";
  const when = meeting === "turnover"
    ? <>{shiftName(shift)} {c.D(shift.start)} {c.win(shift)} <span className="opacity-60">→</span> <b>{shiftName(next)} {c.D(next.start)} {c.win(next)}</b></>
    : meeting === "kickoff"
      ? <>{kickoff.start != null ? <>Job starts <b>{c.DL(kickoff.start)} {c.T(kickoff.start)}</b> · {kickoff.daysTotal} days</> : "No dated work yet"}</>
      : <>{closeout.finish != null ? <>Planned finish <b>{c.DT(closeout.finish)}</b></> : null}</>;
  return (
    <header className={print ? "pb-1.5 border-b-2 border-slate-900" : "px-4 sm:px-5 py-2.5 bg-slate-900 text-white"}>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className={`text-[10px] font-black uppercase tracking-[0.18em] ${print ? "text-slate-500" : "text-slate-400"}`}>{title}</span>
            <h2 className={`${print ? "text-[13pt]" : "text-[17px]"} font-black leading-tight truncate`}>{projectName ?? "Schedule"}</h2>
          </div>
          <div className={`text-[11px] ${print ? "text-slate-700" : "text-slate-300"}`}>
            {when} · as of {c.T(meeting === "turnover" ? asOf : now)} {tzAbbrev(c.tz, now)}
            {rehearsal && meeting === "turnover" && !print && <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-400 text-slate-900 text-[10px] font-black uppercase">Rehearsal — shift not started</span>}
          </div>
        </div>
        {pill && (
          <div className={`rounded-lg px-2.5 py-1 text-right shrink-0 ${pillCls}`}>
            <div className="inline-flex items-center gap-1 text-[13px] font-black leading-none"><pill.Icon className="w-3.5 h-3.5" /> {pill.label}</div>
            {meeting === "turnover" && <div className="text-[10px] font-bold opacity-90">{overall.actualPct}% vs {overall.plannedPct}% plan</div>}
          </div>
        )}
      </div>
    </header>
  );
}

function Footnote({ meeting, ctx: c, asOf, now, projectName }: { meeting: MeetingKind; ctx: Ctx; asOf: number; now: number; projectName?: string }) {
  return (
    <footer className="pt-2 mt-2 border-t border-[var(--color-border)] text-[9.5px] text-[var(--color-text-faint)] flex justify-between gap-3 flex-wrap">
      <span>
        {meeting === "turnover" ? `Plan % = work the schedule expected done by ${c.DT(asOf)}, hour-weighted; actual % = progress entered. Gap = the difference in planned work-hours. ` : ""}
        Critical = on the chain that drives the finish date. Hours are planned work-hours.
      </span>
      <span className="shrink-0">Printed {c.DT(now)}{projectName ? ` · ${projectName}` : ""}</span>
    </footer>
  );
}

// ─── Building blocks ─────────────────────────────────────────────────

function SectionHead({ n, s, collapsed, big, print }: { n: number; s: Sec; collapsed?: boolean; big?: boolean; print?: boolean }) {
  const ring = s.flag === "rose" ? "bg-rose-600" : s.flag === "amber" ? "bg-amber-500" : "bg-slate-900";
  return (
    <div className={`flex items-center gap-2 ${print ? "pb-0.5 border-b border-slate-900" : "pb-1 border-b-2 border-slate-900 dark:border-slate-500"}`}>
      <span className={`${big ? "w-7 h-7 text-[13px]" : "w-5 h-5 text-[10.5px]"} rounded-full ${ring} text-white font-black flex items-center justify-center shrink-0`}>{n}</span>
      <span className={`${big ? "text-[18px]" : print ? "text-[10.5pt]" : "text-[13.5px]"} font-black uppercase tracking-wide`}>{s.title}</span>
      {s.sub && <span className={`min-w-0 truncate ${big ? "text-[12px]" : "text-[11px]"} text-[var(--color-text-muted)]`}>— {s.sub}</span>}
      {!print && !big && <ChevronDown className={`ml-auto w-4 h-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${collapsed ? "-rotate-90" : ""}`} />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "emerald" | "rose" | "amber" | "slate" }) {
  const t = tone === "emerald" ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-900"
    : tone === "rose" ? "border-rose-300 bg-rose-50 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200 dark:border-rose-900"
      : tone === "amber" ? "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-900"
        : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]";
  return (
    <div className={`rounded-md border px-2.5 py-1 ${t}`}>
      <div className="text-[8.5px] font-black uppercase tracking-widest opacity-70">{label}</div>
      <div className="text-[17px] font-black leading-tight tabular-nums">{value}</div>
    </div>
  );
}

function Sub({ tone, icon, title, count }: { tone: "emerald" | "amber" | "rose" | "slate"; icon: React.ReactNode; title: string; count: number }) {
  const t = tone === "emerald" ? "text-emerald-700 dark:text-emerald-400" : tone === "amber" ? "text-amber-700 dark:text-amber-400" : tone === "rose" ? "text-rose-700 dark:text-rose-400" : "text-slate-700 dark:text-slate-300";
  return <div className={`inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-wide ${t}`}>{icon} {title} <span className="font-mono opacity-80">({count})</span></div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-1 text-[11.5px] text-[var(--color-text-muted)] italic">{children}</div>;
}

function Blank({ print }: { print: boolean }) {
  return <span className={`inline-block ${print ? "w-28" : "w-24"} border-b border-dotted border-[var(--color-border-strong)]`}>&nbsp;</span>;
}

/** Talking points the meeting covers, with a box to tick. */
function Prompts({ items, print, lines = 0 }: { items: string[]; print: boolean; lines?: number }) {
  return (
    <ul className={`grid ${lines ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"} gap-x-4 gap-y-1 keep`}>
      {items.map((t) => (
        <li key={t} className="text-[11.5px]">
          <label className="flex items-start gap-1.5">
            {print ? <Box /> : <input type="checkbox" className="mt-0.5 shrink-0" />}
            <span>{t}</span>
          </label>
          {Array.from({ length: lines }).map((_, i) => <div key={i} className="ml-5 h-4 border-b border-dotted border-[var(--color-border-strong)]" />)}
        </li>
      ))}
    </ul>
  );
}

/** Completed work as a compact multi-column list — read, not worked. */
function DoneList({ items, print }: { items: Array<{ id: string; text: string; note: string }>; print: boolean }) {
  const [all, setAll] = useState(false);
  const shown = print || all ? items : items.slice(0, 8);
  return (
    <div>
      <ul className="columns-1 sm:columns-2 gap-6 text-[11.5px]">
        {shown.map((i) => (
          <li key={i.id} className="break-inside-avoid flex gap-1.5 py-px">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-px" />
            <span className="min-w-0"><span className="text-[var(--color-text)]">{i.text}</span> <span className="text-[var(--color-text-faint)] font-mono text-[10.5px]">{i.note}</span></span>
          </li>
        ))}
      </ul>
      {!print && items.length > 8 && (
        <button onClick={() => setAll((v) => !v)} className="mt-0.5 text-[11px] font-bold text-[var(--color-accent)] hover:underline">
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

type TagTone = "rose" | "amber" | "muted";
interface TagT { t: string; tone: TagTone }
function TagChip({ t, tone }: TagT) {
  const cls = tone === "rose" ? "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900"
    : tone === "amber" ? "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900"
      : "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700";
  return <span className={`inline-block whitespace-nowrap px-1 py-px rounded border text-[8.5px] font-black uppercase tracking-wider align-middle ${cls}`}>{t}</span>;
}

type NumTone = "rose" | "amber" | "slate";
function Num({ n, tone }: { n: number; tone: NumTone }) {
  const cls = tone === "rose" ? "bg-rose-600 text-white" : tone === "amber" ? "bg-amber-500 text-white" : "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100";
  return <span className={`inline-flex w-[18px] h-[18px] rounded-full text-[9.5px] font-black items-center justify-center ${cls}`}>{n}</span>;
}

function Box() {
  return <span className="inline-block w-3 h-3 mt-0.5 rounded-[2px] border-[1.5px] border-slate-500 shrink-0" aria-hidden />;
}

interface TGroup { key: string; title: string; crumbs: string; meta: string }
interface TRow {
  id: string;
  group: TGroup;
  n?: { num: number; tone: NumTone };
  box?: boolean;
  when: string;
  name: string;
  done?: boolean;
  tags?: Array<TagT | null>;
  who?: string;
  wo?: string;
  right: string;
  /** A second line under the step (a reason). */
  note?: string;
}

/** One line per step, grouped under its equipment with the equipment's
 *  window and progress on a thin header row. */
function StepTable({ rows, print, box, rightHead = "", whenHead = "When", ownerLine, flat }: {
  rows: TRow[]; print: boolean; box?: boolean; rightHead?: string; whenHead?: string;
  /** One list in the given order, the equipment named on each line (a
   *  sequence — the critical chain — reads in order, not by equipment). */
  flat?: boolean;
  /** Adds a blank "owner / decision" line under each row (decisions). */
  ownerLine?: boolean;
}) {
  // Group consecutive-by-first-appearance, keeping each group's rows in order.
  const groups: Array<{ g: TGroup; rows: TRow[] }> = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const k = r.group.title && !flat ? r.group.key : "__solo";
    if (!at.has(k)) { at.set(k, groups.length); groups.push({ g: r.group.title && !flat ? r.group : { key: "__solo", title: "", crumbs: "", meta: "" }, rows: [] }); }
    groups[at.get(k)!].rows.push(r);
  }
  const hasN = rows.some((r) => r.n);
  const hasWho = rows.some((r) => r.who);
  const hasWo = rows.some((r) => r.wo);
  const cols = (box ? 1 : 0) + (hasN ? 1 : 0) + 3 + (hasWho ? 1 : 0) + (hasWo ? 1 : 0);
  const one = "whitespace-nowrap overflow-hidden text-ellipsis";
  const cell = print ? "px-1 py-[1px]" : "px-1.5 py-[3px]";
  return (
    <div className="rounded-md border border-slate-300 dark:border-slate-700 overflow-x-auto">
      <table className={`w-full border-collapse table-fixed ${print ? "text-[8.5pt]" : "text-[12px]"}`}>
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800/60 text-[9px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 text-left">
            {box && <th className={`${cell} w-5`} />}
            {hasN && <th className={`${cell} w-6`}>#</th>}
            <th className={`${cell} ${print ? "w-[104px]" : "w-[124px]"}`}>{whenHead}</th>
            <th className={cell}>Step</th>
            {hasWho && <th className={`${cell} hidden sm:table-cell print:table-cell w-[132px]`}>Who</th>}
            {hasWo && <th className={`${cell} hidden md:table-cell print:table-cell w-[64px]`}>WO</th>}
            <th className={`${cell} w-[78px] text-right`}>{rightHead}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ g, rows: list }) => (
            <React.Fragment key={g.key}>
              {g.title && (
                <tr className="bg-slate-100 dark:bg-slate-800 border-t border-slate-300 dark:border-slate-700">
                  <td colSpan={cols} className={`${cell} text-[11px]`}>
                    <b>{g.title}</b>
                    {g.crumbs && <span className="text-slate-500 dark:text-slate-400"> · {g.crumbs}</span>}
                    {g.meta && <span className="float-right font-mono text-[10px] text-slate-600 dark:text-slate-300">{g.meta}</span>}
                  </td>
                </tr>
              )}
              {list.map((r) => (
                <React.Fragment key={r.id}>
                  <tr className="border-t border-slate-200 dark:border-slate-700/60 align-top">
                    {box && <td className={cell}><Box /></td>}
                    {hasN && <td className={cell}>{r.n ? <Num n={r.n.num} tone={r.n.tone} /> : null}</td>}
                    <td className={`${cell} font-mono tabular-nums font-bold text-[10.5px] break-words overflow-hidden`}>{r.when}</td>
                    <td className={cell}>
                      {flat && r.group.title && <span className="text-slate-500 dark:text-slate-400">{r.group.title} › </span>}
                      <span className={r.done ? "line-through text-slate-400" : "font-semibold"}>{r.name}</span>
                      {r.tags?.filter((t): t is TagT => !!t).map((t) => <span key={t.t} className="ml-1"><TagChip t={t.t} tone={t.tone} /></span>)}
                      {r.note && <div className="text-[10.5px] text-slate-600 dark:text-slate-300">{r.note}</div>}
                      {ownerLine && <div className="text-[10px] text-slate-500 mt-0.5">Owner / decision: <span className="inline-block w-44 border-b border-dotted border-slate-400 align-baseline">&nbsp;</span></div>}
                    </td>
                    {hasWho && <td className={`${cell} hidden sm:table-cell print:table-cell text-[10.5px] text-slate-600 dark:text-slate-300 max-w-[132px] ${one}`} title={r.who}>{r.who}</td>}
                    {hasWo && <td className={`${cell} hidden md:table-cell print:table-cell font-mono text-[10px] text-slate-600 dark:text-slate-300 ${one}`}>{r.wo}</td>}
                    <td className={`${cell} text-right font-mono font-bold text-[10.5px] text-slate-700 dark:text-slate-200 whitespace-nowrap`}>{r.right}</td>
                  </tr>
                </React.Fragment>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A plain table: header + rows of cells. */
function SimpleTable({ head, rows, print }: { head: string[]; rows: Array<{ id: string; cells: React.ReactNode[] }>; print: boolean }) {
  const cell = print ? "px-1 py-[1px]" : "px-1.5 py-[3px]";
  return (
    <div className="rounded-md border border-slate-300 dark:border-slate-700 overflow-x-auto">
      <table className={`w-full border-collapse ${print ? "text-[8.5pt]" : "text-[12px]"}`}>
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800/60 text-[9px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 text-left">
            {head.map((h) => <th key={h} className={cell}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-slate-200 dark:border-slate-700/60 align-top">
              {r.cells.map((c, i) => <td key={i} className={`${cell} ${i === 0 ? "" : "whitespace-nowrap font-mono text-[10.5px]"}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
