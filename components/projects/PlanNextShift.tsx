"use client";

// PlanNextShift — change what the next shift does, in the schedule: swap a
// work order on its list for one from later on, pull one in, push one out.
// Opened from the calendar ("Plan" on the next shift) and from the shift
// report's Next section — the same panel either way. Before saving: what
// moves, what the step pulled in still waits on, the critical path and the
// turnaround's forecast finish (lib/shiftPlan). Saving moves the planned
// dates (the baseline stays), so the calendar, the report and the email
// follow.

import React, { useMemo, useState } from "react";
import { useProjectTypeCtx } from "@/components/projects/ProjectTypeContext";
import { ArrowLeft, ArrowLeftRight, CalendarClock, LogOut, Plus, Search, X, CircleAlert } from "lucide-react";
import { Modal, ModalHeader, ModalBody } from "@/components/ui/Modal";
import type { Milestone } from "@/types/schema";
import { buildShiftReport, nextShift, previousShift, type LookAheadItem, type ShiftRow, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { filterLookAhead } from "@/lib/pullAhead";
import { planShiftChange, laterShifts, type ShiftPlanAction, type ShiftPlanChange } from "@/lib/shiftPlan";
import type { CriticalMode } from "@/lib/criticalPath";
import { fmtInTz } from "@/lib/scheduleTz";
import { withWorkOrderCrews } from "@/lib/workOrderCrew";
import StepPath from "@/components/ui/StepPath";
import { useDraft } from "@/hooks/useDraft";

const WINDOWS = [
  { id: "1", label: "Next day", days: 1 },
  { id: "3", label: "3 days", days: 3 },
  { id: "7", label: "7 days", days: 7 },
  { id: "all", label: "Whole job", days: Infinity },
] as const;
const SHOW = 80;
const RANK = { ready: 0, "after-tonight": 1, waiting: 2, held: 3 } as const;

type View = { v: "list" } | { v: "pick"; outId?: string } | { v: "push"; outId: string } | { v: "confirm"; action: ShiftPlanAction; back: View };

export default function PlanNextShift({ milestones, next, now, tz, times, mode, criticalIds, onSave, onClose }: {
  milestones: Milestone[];
  /** The shift being planned. */
  next: ShiftWindow;
  /** The schedule's clock (the one the report reads). */
  now: number;
  tz: string; times: ShiftTimes;
  mode?: CriticalMode | null;
  criticalIds?: Set<string>;
  onSave: (c: ShiftPlanChange, reason: string) => Promise<boolean>;
  onClose: () => void;
}) {
  // The next crew's list as the shift report has it (crews and WO numbers
  // filled from the work order, as there), and everything later with how
  // ready it is — the same report, so the two can't disagree.
  const live = useMemo(() => withWorkOrderCrews(milestones), [milestones]);
  const report = useMemo(() => buildShiftReport({ milestones: live, tz, times, shift: previousShift(next, tz, times), now, criticalIds, lookAheadUntil: Infinity }), [live, tz, times, next, now, criticalIds]);
  const list = report.goals.all;
  const [view, setView] = useState<View>({ v: "list" });
  const [saved, setSaved] = useState<string | null>(null);

  const T = (t: number) => fmtInTz(t, tz, { hour: "numeric", minute: "2-digit", hour12: true });
  const D = (t: number) => fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" });
  const when = (t: number) => `${fmtInTz(t, tz, { weekday: "short" })} ${T(t)}`;
  // "Tue 18:00–22:00", or across midnight "Tue 15:00 → Wed 09:00".
  const span = (a: number, b: number) => (fmtInTz(a, tz, { month: "numeric", day: "numeric" }) === fmtInTz(b, tz, { month: "numeric", day: "numeric" }) ? `${when(a)}–${T(b)}` : `${when(a)} → ${when(b)}`);
  const shiftName = (w: ShiftWindow) => `${fmtInTz(w.start, tz, { weekday: "short" })} ${w.kind}`;
  const rowById = useMemo(() => new Map(list.map((r) => [r.leaf.id, r])), [list]);
  const crews = useMemo(() => [...new Set(live.map((m) => m.responsibleParty?.trim()).filter((x): x is string => !!x))].sort(), [live]);
  const wo = (m: { workOrderRef?: string | null }) => m.workOrderRef?.trim() || null;

  return (
    <Modal onClose={onClose} size="xl">
      <ModalHeader icon={CalendarClock} title={`Plan the ${shiftName(next)} shift`}
        subtitle={`${D(next.start)} ${T(next.start)}–${T(next.end)} · changes move the schedule (the baseline stays); the calendar, the report and the email follow`} onClose={onClose} />
      <ModalBody className="p-0">
        {/* The crew's list, then pick, then check and save: one path, joined
            by a line, the step you're on ringed. A done step takes you back. */}
        <StepPath className="px-4 pt-3 pb-2 border-b border-[var(--color-border)]" current={view.v === "list" ? 0 : view.v === "confirm" ? 2 : 1}
          steps={[`The ${next.kind} crew's list`, (view.v === "confirm" ? view.back.v : view.v) === "push" ? "Pick the shift" : "Pick the work", "Check and save"]}
          onPick={view.v === "list" ? undefined : (i) => { if (i === 0) setView({ v: "list" }); else if (view.v === "confirm") setView(view.back); }} />
        {view.v === "list" && (
          <div>
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[var(--color-border)] text-caption">
              <span className="flex-1 text-body text-[var(--color-text-muted)]"><b className="text-[var(--color-text)]">{list.length} step{list.length === 1 ? "" : "s"}</b> on the {next.kind} crew&apos;s list · {report.goals.mustDoHours} h</span>
              <button type="button" onClick={() => { setSaved(null); setView({ v: "pick" }); }}
                className="inline-flex items-center gap-1.5 h-10 rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-4 text-body font-medium text-[var(--color-accent-fg)]">
                <Plus className="w-3.5 h-3.5" /> Pull in work
              </button>
            </div>
            {saved && <div role="status" className="px-4 py-2 border-b border-[var(--color-border)] text-caption font-medium text-[var(--state-released-text)]">{saved}</div>}
            {list.length === 0 && <div className="px-4 py-10 text-center text-body text-[var(--color-text-muted)]">Nothing on the {next.kind} shift. Pull in work to give it some.</div>}
            <div className="divide-y divide-[var(--color-border)]">
              {list.map((r) => (
                <div key={r.leaf.id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-2.5">
                  <div className="flex-1 min-w-[200px]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-body font-medium text-[var(--color-text)] break-words">{r.leaf.name}</span>
                      {r.critical && <Tag tone="rose">critical</Tag>}
                      {r.carryOver && <Tag tone="amber">carried over</Tag>}
                    </div>
                    <Where r={r} />
                    <div className="mt-0.5 text-caption text-[var(--color-text-muted)]">
                      {r.carryOver ? `was due ${when(r.dueAt)}` : `planned ${span(r.crewStart, r.crewFinish)}`} · {r.hoursNext ?? r.hoursLeft} h this shift{r.percent > 0 ? ` · ${r.percent}% done` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => { setSaved(null); setView({ v: "pick", outId: r.leaf.id! }); }}
                      className="inline-flex items-center gap-1 h-10 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                      <ArrowLeftRight className="w-3.5 h-3.5" /> Swap
                    </button>
                    <button type="button" onClick={() => { setSaved(null); setView({ v: "push", outId: r.leaf.id! }); }}
                      className="inline-flex items-center gap-1 h-10 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                      <LogOut className="w-3.5 h-3.5" /> Push out
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {view.v === "pick" && (
          <Picker items={report.goals.lookAhead} out={view.outId ? rowById.get(view.outId) : undefined} next={next} span={span}
            onBack={() => setView({ v: "list" })}
            onPick={(x) => setView({ v: "confirm", action: view.outId ? { kind: "swap", inId: x.row.leaf.id!, outId: view.outId } : { kind: "pull", inId: x.row.leaf.id! }, back: view })} />
        )}

        {view.v === "push" && (() => {
          const r = rowById.get(view.outId);
          // The shifts its crew works.
          const later = laterShifts(next, (w) => nextShift(w, tz, times), 12).filter((w) => !r || r.work === "both" || r.work === w.kind).slice(0, 6);
          return (
            <div className="px-4 py-3 space-y-3 text-caption">
              <BackLink onClick={() => setView({ v: "list" })} />
              <div><span className="text-[var(--color-text-muted)]">Push out:</span> <b className="text-[var(--color-text)]">{r?.leaf.name}</b>{r && wo(r.leaf) ? <span className="text-[var(--color-text-muted)]"> · WO {wo(r.leaf)}</span> : null}</div>
              <div>
                <div className="font-medium text-[var(--color-text)] mb-1">To start on</div>
                <div className="flex flex-wrap gap-1.5">
                  {later.map((w) => (
                    <button key={w.start} type="button" onClick={() => setView({ v: "confirm", action: { kind: "push", outId: view.outId, to: w.start }, back: view })}
                      className="h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                      {shiftName(w)} <span className="text-[var(--color-text-muted)] font-normal">{T(w.start)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}

        {view.v === "confirm" && (
          <Confirm key={JSON.stringify(view.action)} milestones={live} action={view.action} next={next} now={now} tz={tz} times={times} mode={mode} crews={crews}
            when={when} span={span} shiftName={shiftName}
            onBack={() => setView(view.back)}
            onSave={async (c, reason) => {
              const ok = await onSave(c, reason);
              if (ok) {
                setSaved(`Saved: ${[c.in ? `${c.in.name} in` : null, c.out ? `${c.out.name} out (to ${when(c.out.to[0])})` : null].filter(Boolean).join(" · ")}`);
                setView({ v: "list" });
              }
              return ok;
            }} />
        )}
      </ModalBody>
    </Modal>
  );
}

function Picker({ items, out, next, span, onBack, onPick }: {
  items: LookAheadItem[]; out?: ShiftRow; next: ShiftWindow;
  span: (a: number, b: number) => string;
  onBack: () => void; onPick: (x: LookAheadItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [readyOnly, setReadyOnly] = useState(true);
  const [win, setWin] = useState<(typeof WINDOWS)[number]["id"]>("3");
  const [more, setMore] = useState(false);
  const days = WINDOWS.find((w) => w.id === win)!.days;
  const until = days === Infinity ? Infinity : next.end + days * 86_400_000;
  const crew = out?.leaf.responsibleParty?.trim().toLowerCase() ?? "";
  const task = out?.parentId ?? "";
  const kind = next.kind;
  // In place of a step: the same crew first, then the same equipment; then
  // the readiest, then the soonest.
  const { shown, same } = useMemo(() => {
    const same = new Map<string, { crew: boolean; task: boolean }>();
    for (const x of items) same.set(x.row.leaf.id ?? "", { crew: !!crew && x.row.leaf.responsibleParty?.trim().toLowerCase() === crew, task: !!task && x.row.parentId === task });
    const k = (x: LookAheadItem) => same.get(x.row.leaf.id ?? "")!;
    // Work the shift's crew doesn't do (day-crew work on a night with no
    // night crew on it) after the rest — picked, you say who does it.
    const off = (x: LookAheadItem) => Number(x.row.work !== "both" && x.row.work !== kind);
    const shown = filterLookAhead(items, { query, readyOnly, criticalOnly: false, until })
      .sort((a, b) => off(a) - off(b) || Number(k(b).crew) - Number(k(a).crew) || Number(k(b).task) - Number(k(a).task) || RANK[a.readiness] - RANK[b.readiness] || a.row.crewStart - b.row.crewStart);
    return { shown, same };
  }, [items, query, readyOnly, until, crew, task, kind]);
  const rows = more ? shown : shown.slice(0, SHOW);
  return (
    <div>
      <div className="px-4 pt-2.5 pb-2 border-b border-[var(--color-border)] space-y-2">
        <BackLink onClick={onBack} />
        {out && (
          <div className="text-caption"><span className="text-[var(--color-text-muted)]">Swapping out:</span> <b className="text-[var(--color-text)]">{out.leaf.name}</b>
            <span className="text-[var(--color-text-muted)]">{[out.parentName, out.leaf.workOrderRef?.trim() ? `WO ${out.leaf.workOrderRef.trim()}` : null, out.leaf.responsibleParty].filter(Boolean).map((x) => ` · ${x}`).join("")}: pick what the {next.kind} shift does instead</span></div>
        )}
        <label className="relative block">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
          <input autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setMore(false); }} aria-label="Search the job for a work order"
            placeholder="Search a work order #, equipment (E-17), step or crew, the whole job"
            className="w-full h-10 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] pl-8 pr-8 text-body text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="ui-hit absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>}
        </label>
        <div className="flex flex-wrap items-center gap-1.5 text-caption">
          {query ? <span className="text-[var(--color-text-muted)]">Searching the whole job · {shown.length} found</span> : (
            <>
              <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5" role="group" aria-label="How far ahead">
                {WINDOWS.map((w) => (
                  <button key={w.id} type="button" onClick={() => { setWin(w.id); setMore(false); }} aria-pressed={win === w.id}
                    className={`px-2 py-1 pointer-coarse:min-h-11 rounded-md font-medium ${win === w.id ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-text)] ring-1 ring-inset ring-[var(--color-accent-text)]/30" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{w.label}</button>
                ))}
              </div>
              <button type="button" onClick={() => setReadyOnly((v) => !v)} aria-pressed={readyOnly}
                className={`rounded-full border px-2.5 py-1 font-medium ${readyOnly ? "border-[var(--color-text)] bg-[var(--color-text)] dark:bg-[var(--color-surface-2)] text-[var(--color-surface)] dark:text-[var(--color-text)]" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>
                {readyOnly ? "✓ " : ""}Ready to start
              </button>
            </>
          )}
        </div>
      </div>
      {shown.length === 0 && <div className="px-4 py-10 text-center text-body text-[var(--color-text-muted)]">{query ? <>No work order matches &ldquo;{query}&rdquo;.</> : `Nothing ${readyOnly ? "ready to start " : ""}in this window. Widen it${readyOnly ? " or turn off Ready to start" : ""}.`}</div>}
      <div className="divide-y divide-[var(--color-border)]">
        {rows.map((x) => {
          const r = x.row, offShift = r.work !== "both" && r.work !== next.kind;
          const cant = x.readiness === "held" || !!x.blockedBy;
          return (
            <div key={r.leaf.id} className="flex items-start gap-3 px-4 py-2.5">
              <button type="button" disabled={cant} onClick={() => onPick(x)} aria-label={`Pick ${r.leaf.name}${r.parentName ? ` (${r.parentName})` : ""}`}
                title={cant ? (x.blockedBy ? `Can't start: it waits on ${x.blockedBy}, which is blocked or on hold` : "Blocked or on hold") : offShift ? `${r.work === "day" ? "Day" : "Night"}-crew work: you'll say who does it on the ${next.kind} shift` : "Pick this one"}
                className="shrink-0 mt-0.5 rounded-lg border border-[var(--color-border-strong)] px-3 py-1.5 text-caption font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">Pick</button>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-body font-medium text-[var(--color-text)] break-words">{r.leaf.name}</span>
                  {r.critical && <Tag tone="rose">critical</Tag>}
                  <Ready x={x} />
                  {offShift && <Tag tone="slate">{r.work} crew work</Tag>}
                  {same.get(r.leaf.id ?? "")?.crew && <Tag tone="slate">same crew</Tag>}
                  {same.get(r.leaf.id ?? "")?.task && <Tag tone="slate">same equipment</Tag>}
                </div>
                <Where r={r} />
                <div className="mt-0.5 text-caption text-[var(--color-text-muted)]">planned {span(r.crewStart, r.crewFinish)} · {r.hoursLeft} h{r.percent > 0 ? ` · ${r.percent}% done` : ""}</div>
              </div>
            </div>
          );
        })}
      </div>
      {!more && shown.length > SHOW && <button type="button" onClick={() => setMore(true)} className="w-full py-2.5 text-caption font-medium text-[var(--color-accent-text)] hover:bg-[var(--color-surface-2)]">Show all {shown.length}</button>}
    </div>
  );
}

function Confirm({ milestones, action, next, now, tz, times, mode, crews, when, span, shiftName, onBack, onSave }: {
  milestones: Milestone[]; action: ShiftPlanAction; next: ShiftWindow; now: number; tz: string; times: ShiftTimes; mode?: CriticalMode | null; crews: string[];
  when: (t: number) => string; span: (a: number, b: number) => string; shiftName: (w: ShiftWindow) => string;
  onBack: () => void; onSave: (c: ShiftPlanChange, reason: string) => Promise<boolean>;
}) {
  const ptype = useProjectTypeCtx();
  // Who does the step pulled in: in a swap, the crew that was on the one
  // it replaces ("they're already there"); else its own.
  const byId = useMemo(() => new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m])), [milestones]);
  const [crew, setCrew] = useState(() => {
    const own = action.kind !== "push" ? byId.get(action.inId)?.responsibleParty?.trim() ?? "" : "";
    return action.kind === "swap" ? byId.get(action.outId)?.responsibleParty?.trim() || own : own;
  });
  const plan = useMemo(() => planShiftChange(milestones, action, { next, now, tz, times, mode, crew }), [milestones, action, next, now, tz, times, mode, crew]);
  const [reason, setReason] = useState("");
  // Why, as typed: comes back after a reload until it's saved.
  const why = useDraft<string>(`plan-why:${next.start}:${action.kind}:${action.kind === "push" ? action.outId : action.inId}`, reason, setReason, (v) => !v.trim());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!plan) return <div className="px-4 py-6 text-body text-[var(--color-text-muted)]"><BackLink onClick={onBack} /> <div className="mt-2">Nothing would change.</div></div>;
  const [f0, f1] = plan.impact.finish;
  const dh = Math.round(((f1 - f0) / 3_600_000) * 10) / 10;
  const moved = Number.isFinite(dh) && Math.abs(dh) >= 0.1;
  const wo = (n: string | null) => (n ? ` · WO ${n}` : "");
  const save = async () => {
    if (!reason.trim()) { setMsg("Put in why: it goes on each step moved."); return; }
    setBusy(true);
    const ok = await onSave(plan, reason.trim());
    setBusy(false);
    if (ok) why.clear();
    else setMsg("Not saved. Try again.");
  };
  return (
    <div className="px-4 py-3 space-y-3 text-caption text-[var(--color-text)]">
      <BackLink onClick={onBack} />
      {/* The swap, in and out: two lines apart, no box in the dialog's box. */}
      <div className="grid gap-2">
        {plan.in && (
          <div>
            <span className="inline-block w-10 font-medium text-[var(--color-text-muted)]">In</span>
            <b>{plan.in.name}</b><span className="text-[var(--color-text-muted)]">{wo(plan.in.wo)}</span>
            <div className="pl-10 text-[var(--color-text-muted)]">{shiftName(next)} shift: {span(plan.in.to[0], plan.in.to[1])} · was planned {when(plan.in.from[0])}</div>
            <label className="pl-10 mt-1 flex flex-wrap items-center gap-1.5">
              <span className="font-medium">Who does it</span>
              <select value={crew} onChange={(e) => setCrew(e.target.value)} aria-label="Who does it"
                className="h-8 pointer-coarse:h-11 max-w-[220px] rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-caption text-[var(--color-text)]">
                {[...new Set([crew, ...crews])].map((c) => <option key={c || "none"} value={c}>{c || "Not named"}</option>)}
              </select>
            </label>
          </div>
        )}
        {plan.out && (
          <div>
            <span className="inline-block w-10 font-medium text-[var(--color-text-muted)]">Out</span>
            <b>{plan.out.name}</b><span className="text-[var(--color-text-muted)]">{wo(plan.out.wo)}</span>
            <div className="pl-10 text-[var(--color-text-muted)]">to {span(plan.out.to[0], plan.out.to[1])} · was planned {when(plan.out.from[0])}</div>
          </div>
        )}
      </div>
      {(plan.waits.length > 0 || plan.crewHours.length > 0) && (
        <div className="border-l-2 border-[var(--state-held)] pl-3 py-0.5 space-y-0.5 text-[var(--state-held-text)]">
          {plan.waits.map((w) => <div key={w.name}>It waits on <b>{w.name}</b>, planned to finish {when(w.until)}. Make sure it can start.</div>)}
          {plan.crewHours.map((x) => <div key={x}>{x}: saving puts it on the {next.kind} shift&apos;s hours{crew ? ` for ${crew}` : ""}. Check they&apos;re on.</div>)}
        </div>
      )}
      <div className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 space-y-1 ${plan.impact.critical || (moved && dh > 0) ? "border-l-2 border-l-[var(--state-overdue)]" : ""}`}>
        <div className="font-medium text-body text-[var(--color-text-muted)]">What it does to the schedule</div>
        <div>{ptype.word} (forecast): {Number.isFinite(f0) ? `${when(f0)} → ` : ""}<b className={moved && dh > 0 ? "text-[var(--state-overdue-text)]" : ""}>{Number.isFinite(f1) ? when(f1) : "-"}</b>{!moved ? ": unchanged" : dh > 0 ? `: ${dh} h later` : `: ${-dh} h sooner`}</div>
        {plan.impact.critical && <div className="font-medium text-[var(--state-overdue-text)]">Touches the critical path.</div>}
        {plan.pushed.length > 0
          ? <div>Pushes {plan.pushed.length} linked step{plan.pushed.length === 1 ? "" : "s"} later in the forecast (their plan stays): {plan.pushed.slice(0, 5).map((p) => `${p.name} +${p.hours} h`).join(", ")}{plan.pushed.length > 5 ? ` + ${plan.pushed.length - 5} more` : ""}</div>
          : <div className="text-[var(--color-text-muted)]">No other work moves.</div>}
      </div>
      <label className="block">
        <span className="block font-medium mb-1">Why <span className="font-normal text-[var(--color-text-muted)]">(required)</span></span>
        <textarea value={reason} onChange={(e) => { setReason(e.target.value); setMsg(null); }} rows={2} disabled={busy}
          placeholder="e.g. Crew's already in the area, faster to do it now than wait till Wednesday"
          className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-caption" />
      </label>
      {msg && <div role="alert" className="font-medium text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-0.5" /><span>{msg}</span></div>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onBack} className="h-9 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-strong)] font-medium">Back</button>
        <button type="button" onClick={() => void save()} disabled={busy}
          className="h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
          {busy ? "Saving…" : "Save to the schedule"}
        </button>
      </div>
      <div className="text-caption text-[var(--color-text-faint)]">The planned dates move; the baseline doesn&apos;t, so the close-out still shows what was planned. Undo is offered after saving.</div>
    </div>
  );
}

/** Which equipment, its WO and crew — what tells two like-named steps
 *  apart; the full path on hover. */
function Where({ r }: { r: ShiftRow }) {
  const wo = r.leaf.workOrderRef?.trim();
  return (
    <div className="mt-0.5 text-caption text-[var(--color-text-muted)] break-words" title={r.path.join(" › ")}>
      <span className="font-medium text-[var(--color-text)]">{r.parentName ?? r.path[r.path.length - 1]}</span>
      {wo ? <> · WO <span className="font-display tabular-nums">{wo}</span></> : null}{r.leaf.responsibleParty ? ` · ${r.leaf.responsibleParty}` : ""}
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-body text-[var(--color-accent-text)] hover:underline"><ArrowLeft className="w-3.5 h-3.5" /> Back to the list</button>;
}

function Tag({ tone, children }: { tone: "rose" | "amber" | "emerald" | "slate"; children: React.ReactNode }) {
  const cls = tone === "rose" ? "bg-transparent text-[var(--state-overdue-text)] border-[var(--color-border)]"
    : tone === "amber" ? "bg-transparent text-[var(--state-held-text)] border-[var(--color-border)]"
      : tone === "emerald" ? "bg-transparent text-[var(--state-released-text)] border-[var(--color-border)]"
        : "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border-strong)]";
  return <span className={`inline-block max-w-full break-words px-1.5 py-px rounded border text-body font-medium ${cls}`}>{children}</span>;
}

function Ready({ x }: { x: LookAheadItem }) {
  const w = x.waits.length ? `${x.waits[0]}${x.waits.length > 1 ? ` +${x.waits.length - 1}` : ""}` : "";
  if (x.readiness === "ready") return <Tag tone="emerald">ready</Tag>;
  if (x.blockedBy) return <Tag tone="rose">can&apos;t start: {x.blockedBy} is blocked</Tag>;
  if (x.readiness === "after-tonight") return <Tag tone="amber">after {w}</Tag>;
  if (x.readiness === "held") return <Tag tone="rose">{x.row.status === "blocked" ? "blocked" : "on hold"}</Tag>;
  return <Tag tone="slate">waits on {w}</Tag>;
}
