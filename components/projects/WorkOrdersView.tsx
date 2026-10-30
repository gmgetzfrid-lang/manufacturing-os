"use client";

// WorkOrdersView: the job by work order. Each WO's equipment, crews,
// plan against actual (start and finish), how far along it is, and how
// many hours ahead or behind. Search for a WO number, equipment, step or
// crew. Open one and its steps are there to update, each with the step
// card: start, %, finish, fix times, and the history with Edit. Steps with
// no WO are listed under their equipment. Print puts the work orders shown
// on paper, every one opened up with all its steps, in a format of its own
// — report, report with history, or the pen-and-paper field tracker
// (lib/workOrdersPrint) — without changing the view.

import React, { useMemo, useState } from "react";
import { Search, ChevronRight, Printer, Ban } from "lucide-react";
import type { Milestone, MilestoneNote, MilestoneStatus } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { leafPercent } from "@/lib/scheduleProgress";
import { expectedFraction, workHours, type ShiftTimes } from "@/lib/shiftReport";
import { dayKey } from "@/lib/scheduleTz";
import { whenDated } from "@/lib/timeWords";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { woOf } from "@/lib/workOrderCrew";
import { discoveryOf, kindOf, ADDED, type AddedKind } from "@/lib/discovery";
import type { PathMarks } from "@/lib/criticalPath";
import CalendarQuickView, { type StepUpdate } from "@/components/projects/CalendarQuickView";
import { notesFor } from "@/lib/milestones";
import { loadProgressLog } from "@/lib/progressHistory";
import { buildTimeLog, type TimeLogRow } from "@/lib/timeLog";
import { useLetterhead } from "@/lib/letterheadStore";
import { letterheadDocument } from "@/lib/letterhead";
import { workOrdersHtml, PRINT_CSS, type PrintOrder, type PrintFormat } from "@/lib/workOrdersPrint";
import { CancelJobForm } from "@/components/projects/CancelledJobs";

const STEP_STATUS: Record<MilestoneStatus, string> = { planned: "Not started", in_progress: "In progress", completed: "Done", on_hold: "On hold", blocked: "Blocked", missed: "Missed" };
const SHOW_WORD: Record<string, string> = { all: "All work orders", open: "Open work orders", behind: "Work orders behind plan", held: "Held work orders", done: "Done work orders" };
const noteAt = (n: MilestoneNote) => ms(n.happenedAt ?? n.createdAt);

type Standing = "not_started" | "in_progress" | "held" | "done";
const STANDING: Record<Standing, { word: string; cls: string }> = {
  not_started: { word: "Not started", cls: "text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]" },
  in_progress: { word: "In progress", cls: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-900" },
  held: { word: "Held", cls: "text-amber-800 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-900" },
  done: { word: "Done", cls: "text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-900" },
};
type Show = "all" | "open" | "behind" | "held" | "done";
/** Its description — not the schedule file's "Summary (rolls up children)". */
const descOf = (m: Milestone) => { const d = m.description?.trim() ?? ""; return /^summary \(rolls up children\)$/i.test(d) ? "" : d; };
const ms = (v: unknown) => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

interface WorkOrder {
  key: string;
  wo: string | null;
  /** The task (or single step) the WO is on. */
  owner: Milestone;
  steps: Milestone[];
  crews: string[];
  planStart: number; planFinish: number;
  actStart: number; actFinish: number;
  pct: number; plan: number; hours: number;
  standing: Standing;
  done: number;
  /** Put in after the plan — discovery, added scope — steps and hours of each. */
  added: Array<{ kind: AddedKind; n: number; h: number }>;
  find: string;
}

export default function WorkOrdersView({ milestones, childrenByParent, tz, times, progress, canEdit, onUpdate, onFixTimes, onOpenDetail, onMoveDays, marks, onDiscovery, projectId, projectName, user, onCancelled }: {
  milestones: Milestone[];
  /** For printing: the project's letterhead, history and name. */
  projectId?: string; projectName?: string;
  /** Who's working: cancelling a work order is stamped with it. */
  user?: { id: string; name?: string; email?: string };
  /** A work order came off the schedule. */
  onCancelled?: () => void;
  childrenByParent: Map<string, Milestone[]>;
  tz: string; times: ShiftTimes;
  progress?: Map<string, ProgressInfo>;
  canEdit: boolean;
  onUpdate?: (id: string, u: StepUpdate) => Promise<boolean>;
  onFixTimes?: (id: string, t: { start?: number | null; finish?: number | null }) => Promise<boolean>;
  onOpenDetail?: (m: Milestone) => void;
  onMoveDays?: (id: string, delta: number) => void;
  marks?: PathMarks;
  onDiscovery?: (task: Milestone) => void;
}) {
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  // The work order being taken off the schedule (its key).
  const [cancelling, setCancelling] = useState<string | null>(null);

  const orders = useMemo(() => {
    const byId = new Map<string, Milestone>();
    for (const m of milestones) if (m.id) byId.set(m.id, m);
    const pctOf = (m: Milestone) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
    // Each step's work order: its own, else the nearest group above with one.
    const groups = new Map<string, { wo: string | null; owner: Milestone; steps: Milestone[] }>();
    for (const m of milestones) {
      if (!m.id || (childrenByParent.get(m.id)?.length ?? 0) > 0) continue;
      let x: Milestone | undefined = m, wo = "", owner: Milestone | undefined;
      const seen = new Set<string>();
      while (x && x.id && !seen.has(x.id)) {
        seen.add(x.id);
        wo = woOf(x);
        if (wo) { owner = x; break; }
        x = x.parentId ? byId.get(x.parentId) : undefined;
      }
      if (!owner) owner = (m.parentId ? byId.get(m.parentId) : undefined) ?? m;
      const key = `${wo || "-"}:${owner.id}`;
      const g = groups.get(key) ?? { wo: wo || null, owner, steps: [] };
      g.steps.push(m);
      groups.set(key, g);
    }
    const out: WorkOrder[] = [];
    for (const [key, g] of groups) {
      const steps = [...g.steps].sort((a, b) => startMsOf(a) - startMsOf(b));
      let wSum = 0, pSum = 0, planSum = 0, hours = 0, done = 0, held = false, started = false;
      let planStart = Infinity, planFinish = -Infinity, actStart = Infinity, actFinish = -Infinity;
      for (const s of steps) {
        const w = Math.max(0.1, s.durationHours != null && s.durationHours > 0 ? s.durationHours : workHours(s, tz));
        const p = pctOf(s), e = Math.round(expectedFraction(s, now, tz, times) * 100);
        wSum += w; pSum += p * w; planSum += e * w; hours += ((p - e) / 100) * w;
        if (s.status === "completed") done++;
        if (s.status === "on_hold" || s.status === "blocked") held = true;
        if (s.status !== "planned" && s.status !== "missed") started = true;
        planStart = Math.min(planStart, startMsOf(s)); planFinish = Math.max(planFinish, finishMsOf(s));
        const a0 = ms(s.actualStartAt), a1 = s.status === "completed" ? ms(s.actualAt) : NaN;
        if (Number.isFinite(a0)) actStart = Math.min(actStart, a0);
        if (Number.isFinite(a1)) actFinish = Math.max(actFinish, a1);
      }
      const all = done === steps.length;
      const crews = [...new Set(steps.map((s) => s.responsibleParty?.trim()).filter((c): c is string => !!c))].sort();
      const added = (["discovery", "added"] as const).map((kind) => {
        const xs = steps.filter((s) => { const d = discoveryOf(s); return d && kindOf(d) === kind; });
        return { kind, n: xs.length, h: Math.round(xs.reduce((a, s) => a + (s.durationHours != null && s.durationHours > 0 ? s.durationHours : workHours(s, tz)), 0) * 10) / 10 };
      }).filter((x) => x.n > 0);
      out.push({
        key, wo: g.wo, owner: g.owner, steps, crews,
        planStart, planFinish, actStart, actFinish: all ? actFinish : NaN,
        pct: Math.round(pSum / wSum), plan: Math.round(planSum / wSum), hours: Math.round(hours * 10) / 10,
        standing: all ? "done" : held ? "held" : started ? "in_progress" : "not_started", done,
        added,
        find: [g.wo, g.owner.name, ...crews, ...steps.flatMap((s) => [s.name, s.description, woOf(s)]), ...added.map((x) => ADDED[x.kind].lower)].filter(Boolean).join(" ").toLowerCase(),
      });
    }
    return out.sort((a, b) => a.planStart - b.planStart || (a.wo ?? "~").localeCompare(b.wo ?? "~"));
  }, [milestones, childrenByParent, progress, tz, times, now]);

  const is: Record<Show, (o: WorkOrder) => boolean> = {
    all: () => true,
    open: (o) => o.standing !== "done",
    behind: (o) => o.standing !== "done" && o.hours <= -0.5,
    held: (o) => o.standing === "held",
    done: (o) => o.standing === "done",
  };
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = orders.filter((o) => words.every((w) => o.find.includes(w)));
  // One you have open stays while you work in it, whatever the filter.
  const shown = found.filter((o) => is[show](o) || open.has(o.key));
  const today = dayKey(now, tz);
  // Always with its date — a multi-week job has more than one Monday.
  const fmt = (t: number) => whenDated(t, tz);
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  // ── Print: the work orders shown, each opened up with all its steps.
  const { lh } = useLetterhead(projectId);
  const [printMenu, setPrintMenu] = useState(false);
  const [printMsg, setPrintMsg] = useState<string | null>(null);
  const printIt = async (format: PrintFormat) => {
    const history = format === "history";
    setPrintMenu(false); setPrintMsg(null);
    // Opened at the tap, so the browser doesn't take it for a pop-up.
    const w = window.open("", "_blank");
    if (!w) { setPrintMsg("Your browser blocked the print window - allow pop-ups for this site and try again."); return; }
    w.document.write(`<p style="font:14px Arial,sans-serif;padding:24px">Getting ${shown.length} work order${shown.length === 1 ? "" : "s"} ready to print…</p>`);
    try {
      const ids = shown.flatMap((o) => o.steps.map((s) => s.id)).filter((id): id is string => !!id);
      const notes = await notesFor(ids);
      const latest = new Map<string, { at: number; text: string }>();
      for (const n of notes) {
        const text = n.body?.trim();
        // What people wrote: comments, why it's behind, and hold / block
        // reasons — not the app's own status lines ("Progress → 67%").
        const said = n.kind === "note" || n.kind === "field" || n.kind === "behind"
          || (n.kind === "status" && (n.statusAt === "on_hold" || n.statusAt === "blocked"));
        if (!text || !said) continue;
        const at = noteAt(n), cur = latest.get(n.milestoneId);
        if (Number.isFinite(at) && (!cur || at >= cur.at)) latest.set(n.milestoneId, { at, text });
      }
      const hist = new Map<string, TimeLogRow[]>();
      if (history && projectId) {
        const log = await loadProgressLog(projectId);
        for (const r of buildTimeLog({ milestones, log: log ?? [], notes, tz, times })) {
          if (!r.id) continue;
          const list = hist.get(r.id);
          if (list) list.push(r); else hist.set(r.id, [r]);
        }
      }
      const pctOf = (m: Milestone) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
      const orders: PrintOrder[] = shown.map((o) => ({
        wo: o.wo, name: o.owner.name, desc: descOf(o.owner), crews: o.crews,
        standing: STANDING[o.standing].word, pct: o.pct, plan: o.plan, hours: o.hours,
        planStart: o.planStart, planFinish: o.planFinish, actStart: o.actStart, actFinish: o.actFinish,
        added: o.added.map((x) => `${x.n} ${ADDED[x.kind].lower} step${x.n === 1 ? "" : "s"} (${x.h} h)`),
        done: o.done,
        steps: o.steps.map((s) => {
          const d = discoveryOf(s);
          return {
            id: s.id ?? "", name: s.name, crew: s.responsibleParty?.trim() ?? "",
            planStart: startMsOf(s), planFinish: finishMsOf(s),
            actStart: ms(s.actualStartAt), actFinish: s.status === "completed" ? ms(s.actualAt) : NaN,
            status: STEP_STATUS[s.status] ?? s.status, done: s.status === "completed", pct: Math.round(pctOf(s)),
            added: d ? ADDED[kindOf(d)].word : undefined,
            latest: s.id ? latest.get(s.id) ?? null : null,
            history: s.id ? hist.get(s.id) : undefined,
          };
        }),
      }));
      const project = projectName?.trim() || "Schedule";
      const scope = `${SHOW_WORD[show]}${query.trim() ? ` · search “${query.trim()}”` : ""}${history ? " · with each step's history" : ""}`;
      const body = workOrdersHtml({ project, scope, tz, orders, format });
      const title = `${project} - ${format === "field" ? "Field tracker" : "Work orders"}`;
      const doc = lh ? letterheadDocument(lh, title, body, PRINT_CSS)
        : `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title><style>@page{size:landscape;margin:10mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}${PRINT_CSS}</style></head><body>${body}</body></html>`;
      w.document.open(); w.document.write(doc); w.document.close();
      w.focus();
      setTimeout(() => w.print(), 300);
    } catch (e) {
      w.document.body.textContent = `Couldn't get the work orders ready: ${(e as Error).message}`;
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 h-9 flex-1 min-w-[220px] max-w-[420px] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 focus-within:border-[var(--color-accent-ring)]">
          <Search className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="WO #, equipment, step, crew…" aria-label="Search work orders"
            className="flex-1 min-w-0 bg-transparent text-[13px] outline-none" />
          {query && <button type="button" onClick={() => setQuery("")} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Clear</button>}
        </label>
        <div className="inline-flex flex-wrap gap-1" role="group" aria-label="Show">
          {([["all", "All"], ["open", "Open"], ["behind", "Behind"], ["held", "Held"], ["done", "Done"]] as const).map(([k, l]) => {
            const n = found.filter(is[k]).length;
            return (
              <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)}
                className={`h-8 px-2.5 rounded-full border text-[12px] font-semibold ${show === k ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                {l} <span className="tabular-nums opacity-80">{n}</span>
              </button>
            );
          })}
        </div>
        <span className="relative ml-auto inline-flex">
          <button type="button" onClick={() => setPrintMenu((v) => !v)} aria-expanded={printMenu} disabled={shown.length === 0}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
          {printMenu && (
            <>
              <span className="fixed inset-0 z-[40]" onClick={() => setPrintMenu(false)} aria-hidden />
              <span className="absolute right-0 top-full mt-1 z-[41] w-72 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg p-1.5 flex flex-col text-[12px]">
                <span className="px-2 pt-1 pb-1.5 text-[11px] text-[var(--color-text-muted)]">The {shown.length} work order{shown.length === 1 ? "" : "s"} shown, each opened up with all its steps. Your view here stays as it is.</span>
                <button type="button" onClick={() => void printIt("report")} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)]">
                  <span className="font-semibold">Report</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">Plan, actual, status, % and the latest comment</span>
                </button>
                <button type="button" onClick={() => void printIt("history")} disabled={!projectId} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                  <span className="font-semibold">Report with history</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">Every start, % update, hold and comment, with its time</span>
                </button>
                <button type="button" onClick={() => void printIt("field")} className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)]">
                  <span className="font-semibold">Field tracker - fill in by pen</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">Lines to write starts, finishes, % and notes; spare rows for steps not on the schedule; what should have happened by now marked</span>
                </button>
              </span>
            </>
          )}
        </span>
      </div>
      {printMsg && <div role="alert" className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{printMsg}</div>}

      {shown.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">
          {orders.length === 0 ? "No steps on the schedule yet." : "No work orders match."}
        </div>
      ) : (
        <ul className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden divide-y divide-[var(--color-border)]">
          {shown.map((o) => {
            const isOpen = open.has(o.key);
            const st = STANDING[o.standing];
            const single = o.steps.length === 1 && o.steps[0].id === o.owner.id;
            return (
              <li key={o.key}>
                <button type="button" onClick={() => toggle(o.key)} aria-expanded={isOpen}
                  className={`w-full text-left px-3 py-2.5 hover:bg-[var(--color-surface-2)] ${isOpen ? "bg-[var(--color-surface-2)]" : ""}`}>
                  <div className="flex items-start gap-2">
                    <ChevronRight className={`w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)] transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className={`font-mono text-[12.5px] font-bold ${o.wo ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{o.wo ? `WO ${o.wo}` : "No WO"}</span>
                        <span className="text-[13px] font-semibold text-[var(--color-text)] break-words">{o.owner.name}</span>
                      </div>
                      {descOf(o.owner) && <div className="text-[12px] text-[var(--color-text)] line-clamp-2 break-words">{descOf(o.owner)}</div>}
                      <div className="text-[11.5px] text-[var(--color-text-muted)]">
                        {[o.crews.join(", ") || null, single ? null : `${o.done} of ${o.steps.length} steps done`].filter(Boolean).join(" · ")}
                        {o.added.map((x) => (
                          <span key={x.kind} className={`ml-1.5 font-semibold ${x.kind === "added" ? "text-teal-700 dark:text-teal-300" : "text-violet-700 dark:text-violet-300"}`} title={ADDED[x.kind].tip}>
                            + {x.n} {ADDED[x.kind].lower} step{x.n === 1 ? "" : "s"} ({x.h} h)
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[11.5px]">
                        <span className="text-[var(--color-text-muted)]">Plan</span>
                        <span className="text-[var(--color-text)]">{fmt(o.planStart)} → {fmt(o.planFinish)}</span>
                        <span className="text-[var(--color-text-muted)]">Actual</span>
                        <span className="font-semibold text-[var(--color-text)]">{Number.isFinite(o.actStart) ? `${fmt(o.actStart)} → ${Number.isFinite(o.actFinish) ? fmt(o.actFinish) : "…"}` : "not started"}</span>
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold ${st.cls}`}>{st.word}</span>
                      <span className="text-[12px] font-bold tabular-nums text-[var(--color-text)]">{o.pct}%</span>
                      {o.standing !== "done" && Math.abs(o.hours) >= 0.1 && (
                        <span className={`font-mono text-[11px] font-bold ${o.hours < 0 ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{o.hours > 0 ? "+" : "−"}{Math.abs(o.hours)} h</span>
                      )}
                    </div>
                  </div>
                  {/* Done against where the plan says it should be by now. */}
                  <span className="relative mt-1.5 ml-6 block h-1.5 rounded-full bg-slate-200 dark:bg-slate-700" aria-hidden>
                    <span className={`absolute inset-y-0 left-0 rounded-full ${o.standing === "done" ? "bg-emerald-500" : "bg-[var(--color-text)]"}`} style={{ width: `${Math.min(100, o.pct)}%` }} />
                    {o.standing !== "done" && <span className="absolute -top-[3px] w-0.5 h-3 bg-rose-700" style={{ left: `calc(${Math.min(100, o.plan)}% - 1px)` }} title={`Plan ${o.plan}% by now`} />}
                  </span>
                </button>
                {isOpen && (
                  <div className="border-t border-[var(--color-border)]">
                    <CalendarQuickView whole task={o.owner} onDay={o.steps} others={[]} dayKey={today} band={null} dayLabel="" marks={marks}
                      tz={tz} times={times} progress={progress} canEdit={canEdit}
                      onUpdate={onUpdate} onFixTimes={onFixTimes} onOpenDetail={onOpenDetail} onMoveDays={canEdit ? onMoveDays : undefined} onDiscovery={onDiscovery} />
                    {/* Off this schedule — still done, somewhere else (Put back is above the schedule). */}
                    {canEdit && user && o.owner.id && (
                      <div className="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-surface-2)]/50">
                        {cancelling === o.key ? (
                          <CancelJobForm id={o.owner.id} name={`${o.wo ? `WO ${o.wo} · ` : ""}${o.owner.name}`} steps={o.steps.length}
                            userId={user.id} userName={user.name} userEmail={user.email}
                            onClose={() => setCancelling(null)}
                            onDone={() => { setCancelling(null); toggle(o.key); onCancelled?.(); }} />
                        ) : (
                          <button type="button" onClick={() => setCancelling(o.key)} title="Take it off this schedule - it's still done, somewhere else"
                            className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 px-2 py-1 rounded-md">
                            <Ban className="w-3.5 h-3.5" /> Cancel work order
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="px-1 text-[11px] text-[var(--color-text-muted)]">{shown.length} of {orders.length} work orders · tap one to update its steps</div>
    </div>
  );
}
