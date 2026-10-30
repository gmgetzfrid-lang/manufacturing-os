"use client";

// DiscoveryForm — work found when the equipment is opened, into the
// schedule. What was found and when it was found; the steps it adds (crew,
// hours); the step it follows and the ones it holds up; when the work can
// start — as soon as it can, or a set time (two different times: found
// is history, the start is the plan); who approved it. Before it's saved,
// what it does to the schedule (lib/discovery): the task's finish, the
// turnaround's, the critical path, and the steps it holds up (a forecast —
// no other step's planned dates are changed).

import React, { useMemo, useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import type { Milestone } from "@/types/schema";
import type { ShiftTimes } from "@/lib/shiftReport";
import { fmtInTz, toDateTimeInput, fromDateTimeInput, dayKeyToMs } from "@/lib/scheduleTz";
import { planDiscovery, defaultAfter, defaultHolds, impactLine, earliestStart, followsUntil, ADDED, NEW_WO, type DiscoveryDraft, type AddedKind } from "@/lib/discovery";
import type { CriticalMode } from "@/lib/criticalPath";
import DateTimePicker from "@/components/projects/DateTimePicker";
import CrewPicker from "@/components/projects/CrewPicker";
import { inheritedWorkOrders } from "@/lib/workOrderCrew";

const ms = (v: unknown) => (v == null ? NaN : Date.parse(String(v)));
// The time at the tap (saving), not at render.
const clock = () => Date.now();

export default function DiscoveryForm({ milestones, task: startTask, newWo, tz, times, crews, now: clockNow, mode, day, onSave, onClose }: {
  milestones: Milestone[];
  /** Where it was found (a task, or one of its steps). None: a new work order. */
  task?: Milestone;
  /** Open as a new work order of its own (not under one on the schedule). */
  newWo?: boolean;
  tz: string; times: ShiftTimes;
  /** Crews on the schedule, to pick from. */
  crews: string[];
  /** The schedule's clock (the same the report and calendar read). */
  now?: number;
  /** The project's critical-path setting. */
  mode?: CriticalMode | null;
  /** Added from a calendar day ("YYYY-MM-DD"): the work goes on that day.
   *  An earlier day: found then, and starting then (the times to pick). A
   *  later day: found now, starting then. From an hour of the shift notes
   *  ("YYYY-MM-DDTHH:mm"): found and starting at that hour. */
  day?: string;
  /** Saved with the moment its preview was worked out, so the record says
   *  what the preview said. */
  onSave: (d: DiscoveryDraft, at: number) => Promise<boolean>;
  onClose: () => void;
}) {
  const [now] = useState(() => clockNow ?? Date.now());
  const kids = useMemo(() => {
    const k = new Map<string, Milestone[]>();
    for (const m of milestones) if (m.parentId) k.set(m.parentId, [...(k.get(m.parentId) ?? []), m]);
    return k;
  }, [milestones]);
  // Tasks with steps under them: where discovery work goes.
  const tasks = useMemo(() => milestones.filter((m) => m.id && (kids.get(m.id) ?? []).some((c) => !c.id || !(kids.get(c.id) ?? []).length))
    .sort((a, b) => a.name.localeCompare(b.name)), [milestones, kids]);
  // Added from a calendar day other than today: the work goes on that day.
  const nowV = toDateTimeInput(now, tz);
  const dayIn = typeof day === "string" && /^\d{4}-\d{2}-\d{2}/.test(day) ? day : null;
  const atHour = dayIn && dayIn.length >= 16 ? dayIn.slice(0, 16) : null;
  const onDay = atHour ?? (dayIn && dayIn !== nowV.slice(0, 10) ? dayIn.slice(0, 10) : null);
  const dayFrom = useMemo(() => {
    if (!onDay) return undefined;
    const from = onDay.length >= 16 ? Date.parse(fromDateTimeInput(onDay, tz) ?? "") : dayKeyToMs(onDay, tz);
    return Number.isFinite(from) ? { from, now } : undefined;
  }, [onDay, tz, now]);
  const start: Partial<Milestone> = startTask ?? {};
  const initialTask = start.id && kids.get(start.id)?.length ? start.id : start.parentId ?? start.id ?? tasks[0]?.id ?? "";
  const [isNew, setIsNew] = useState(!!newWo || !startTask);
  const [pickedTask, setTaskId] = useState(initialTask);
  const taskId = isNew ? NEW_WO : pickedTask;
  // A new work order: its name, and the group it goes under (an area like
  // Towers or Exchangers: a group with work orders in it).
  const [woName, setWoName] = useState("");
  const groups = useMemo(() => {
    const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
    const pathOf = (m: Milestone) => { const out: string[] = []; const seen = new Set<string>(); for (let x: Milestone | undefined = m; x?.id && !seen.has(x.id); x = x.parentId ? byId.get(x.parentId) : undefined) { seen.add(x.id); out.unshift(x.name); } return out.join(" › "); };
    const out = milestones.filter((m) => m.id && !m.cancelledAt && (kids.get(m.id) ?? []).some((c) => c.id && (kids.get(c.id) ?? []).length))
      .map((m) => ({ id: m.id!, label: pathOf(m) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    // The whole job's name, said once: "Transmix-1 - Maintenance › Towers".
    const root = out.length > 1 && out.every((g) => g.label === out[0].label || g.label.startsWith(`${out[0].label} › `)) ? out[0].label : null;
    return root ? out.map((g) => ({ id: g.id, label: g.label === root ? `${root} (top level)` : g.label.slice(root.length + 3) })) : out;
  }, [milestones, kids]);
  // From a work order: the group it's in; otherwise picked.
  const [underId, setUnderId] = useState(() => {
    const t = milestones.find((m) => m.id === initialTask);
    return startTask && t?.parentId && groups.some((g) => g.id === t.parentId) ? t.parentId : "";
  });
  const steps = useMemo(() => (kids.get(taskId) ?? []).filter((m) => m.id && !(kids.get(m.id) ?? []).length)
    .sort((a, b) => ms(a.plannedStartAt ?? a.plannedAt) - ms(b.plannedStartAt ?? b.plannedAt)), [kids, taskId]);
  const [afterId, setAfterId] = useState<string | null>(() => (isNew ? null : start.id && !kids.get(start.id)?.length ? start.id : defaultAfter(milestones, initialTask, dayFrom)));
  const [holds, setHolds] = useState<string[]>(() => (isNew ? [] : defaultHolds(milestones, initialTask, start.id && !kids.get(start.id)?.length ? start.id : defaultAfter(milestones, initialTask, dayFrom))));
  // Its work order number: asked every time - the task's, its own, or none yet.
  const wos = useMemo(() => inheritedWorkOrders(milestones), [milestones]);
  const woOfTask = (id: string) => milestones.find((m) => m.id === id)?.workOrderRef?.trim() || wos.get(id) || "";
  const [wo, setWo] = useState("");
  const [noWo, setNoWo] = useState(false);
  const taskWo = woOfTask(taskId);
  const pickTask = (id: string) => {
    if (wo.trim() && wo.trim() === woOfTask(pickedTask)) setWo("");
    setTaskId(id);
    const a = defaultAfter(milestones, id, dayFrom);
    setAfterId(a); setHolds(defaultHolds(milestones, id, a));
  };
  const pickAfter = (id: string | null) => { setAfterId(id); setHolds(defaultHolds(milestones, taskId, id)); };
  const [what, setWhat] = useState("");
  // Discovery — found when it was opened — or added scope: known work
  // that wasn't on the schedule.
  // A work order of its own is most often unplanned work: added scope.
  const [kind, setKind] = useState<AddedKind>(newWo || !startTask ? "added" : "discovery");
  const k = ADDED[kind];
  const [rows, setRows] = useState<Array<{ name: string; crew: string; hours: string }>>(() => [{ name: "", crew: steps.find((s) => s.id === afterId)?.responsibleParty ?? "", hours: "" }]);
  const [approvedBy, setApprovedBy] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // When it was found (history) — and when the work starts (the plan).
  const toMs = (v: string) => { const x = v.length >= 16 ? fromDateTimeInput(v, tz) : null; return x ? Date.parse(x) : NaN; };
  const [foundV, setFoundV] = useState(() => (onDay && onDay < nowV ? onDay : nowV));
  const [startMode, setStartMode] = useState<"asap" | "set">(onDay ? "set" : "asap");
  const [startV, setStartV] = useState(onDay ?? "");
  // As soon as it can: right after it was found, or once what it starts
  // after is done.
  const foundMs = toMs(foundV);
  const asap = useMemo(() => earliestStart(milestones, afterId, now, Number.isFinite(foundMs) ? foundMs : undefined), [milestones, afterId, now, foundMs]);
  const afterStep = afterId ? milestones.find((m) => m.id === afterId) : undefined;
  const follows = useMemo(() => followsUntil(milestones, afterId), [milestones, afterId]);
  const afterName = steps.find((s) => s.id === afterId)?.name;
  const foundAt = toMs(foundV);
  const startAt = startMode === "set" ? toMs(startV) : null;
  // What's wrong with the times, if anything.
  const timeProblem = !Number.isFinite(foundAt) ? `Put in when it was ${k.found} - the day and the time.`
      : startMode === "set" && !Number.isFinite(startAt as number) ? "Pick when the work starts - the day and the time."
        : startAt != null && startAt < foundAt ? `The work can't start before it was ${k.found}.`
          : startAt != null && follows != null && startAt < follows ? `It starts after “${afterName ?? "the step it follows"}”, planned to be done ${fmt(follows)} - pick that or later, or change what it starts after.`
            : null;

  // Under a work order, or a new one: what it starts after starts again.
  const goNew = (v: boolean) => {
    setIsNew(v); setMsg(null);
    const a = v ? null : defaultAfter(milestones, pickedTask, dayFrom);
    setAfterId(a); setHolds(v ? [] : defaultHolds(milestones, pickedTask, a));
    if (v && wo.trim() === woOfTask(pickedTask)) setWo("");
  };
  const filled = rows.map((r) => ({ name: r.name.trim(), crew: r.crew.trim(), hours: Number(r.hours) })).filter((r) => r.name && Number.isFinite(r.hours) && r.hours > 0);
  const draft: DiscoveryDraft | null = taskId && filled.length && !timeProblem
    ? { taskId, kind, what: what.trim(), foundAt, approvedBy: approvedBy.trim() || undefined, steps: filled, afterId, holdsIds: holds, startAt,
        ...(isNew ? { newTask: { name: woName.trim(), parentId: underId || null } } : {}) }
    : null;
  // Worked out again only when what's entered changes.
  const draftKey = draft ? JSON.stringify(draft) : "";
  const plan = useMemo(() => (draftKey ? planDiscovery(milestones, JSON.parse(draftKey) as DiscoveryDraft, { now, tz, mode }) : null), [milestones, now, tz, mode, draftKey]);
  function fmt(t: number) { return Number.isFinite(t) ? fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "-"; }
  const hrs = (h: number) => `${Math.round(h * 10) / 10} h`;
  const taskName = isNew ? woName.trim() || "The new work order" : tasks.find((t) => t.id === taskId)?.name ?? start.name ?? "";

  const save = async () => {
    if (isNew && !woName.trim()) { setMsg("Name the work order - the equipment and the job."); return; }
    if (isNew && !underId) { setMsg("Pick where it goes in the schedule."); return; }
    if (!what.trim()) { setMsg(kind === "added" ? "Say what's being added." : "Say what was found."); return; }
    if (!wo.trim() && !noWo) { setMsg(`Put in its work order #${taskWo ? `, or tap Same as the task (${taskWo})` : ""}, or No WO # yet.`); return; }
    if (!filled.length) { setMsg("Add the work it needs - a step with its hours."); return; }
    if (timeProblem) { setMsg(timeProblem); return; }
    if (foundAt > clock() + 60_000) { setMsg(`When it was ${k.found} can't be in the future.`); return; }
    if (!draft) return;
    setBusy(true); setMsg(null);
    const ok = await onSave({ ...draft, wo: noWo ? null : wo.trim() }, now).catch((e: Error) => { setMsg(e.message); return false; });
    setBusy(false);
    if (ok) onClose();
  };

  const inp = "h-8 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent-ring)]";
  const lbl = "block font-bold text-[var(--color-text)] mb-1";
  return (
    <div className="fixed inset-0 z-[185] bg-black/30" onClick={onClose}>
      <div role="dialog" aria-label="Add work to the schedule" onClick={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-10 -translate-x-1/2 w-[560px] max-w-[96vw] max-h-[88dvh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-xl text-[12px] max-sm:left-0 max-sm:right-0 max-sm:top-auto max-sm:bottom-0 max-sm:translate-x-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:max-h-[92dvh]">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
          <div>
            <div className="text-[14px] font-black">{isNew ? `New work order - ${k.lower}` : k.word === "Discovery" ? "Discovery work" : "Added scope"}</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">Work that wasn&apos;t in the plan, into the schedule - and what it does to it.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-7 h-7 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div className="space-y-1">
            <div className="flex flex-wrap gap-1" role="group" aria-label="What kind of work">
              {(["discovery", "added"] as const).map((x) => (
                <button key={x} type="button" aria-pressed={kind === x} onClick={() => { setKind(x); setMsg(null); }}
                  className={`h-8 px-3 rounded-md border text-[12px] font-bold ${kind === x ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"}`}>{ADDED[x].word}</button>
              ))}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]">{kind === "added" ? "Known work that wasn't on the schedule." : "Found when the equipment was opened."} You can change this later.</div>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Where it goes">
            {([[false, "Under a work order"], [true, "A new work order"]] as const).map(([v, l]) => (
              <button key={l} type="button" aria-pressed={isNew === v} onClick={() => goNew(v)}
                className={`h-8 px-3 rounded-md border text-[12px] font-bold ${isNew === v ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"}`}>{l}</button>
            ))}
          </div>
          {isNew ? (
            <>
              <label className="block">
                <span className={lbl}>Work order name <span className="font-bold text-amber-700 dark:text-amber-400">- required</span></span>
                <input value={woName} onChange={(e) => { setWoName(e.target.value); setMsg(null); }} placeholder="e.g. P-7C - Replace pump seal" className={`${inp} w-full`} />
              </label>
              <label className="block">
                <span className={lbl}>Goes under <span className="font-bold text-amber-700 dark:text-amber-400">- required</span></span>
                <select value={underId} onChange={(e) => { setUnderId(e.target.value); setMsg(null); }} aria-label="Goes under" className={`${inp} w-full`}>
                  <option value="">Pick where it goes</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                </select>
              </label>
            </>
          ) : (
            <label className="block">
              <span className={lbl}>Equipment / task</span>
              <select value={taskId} onChange={(e) => pickTask(e.target.value)} className={`${inp} w-full`}>
                {tasks.map((t) => <option key={t.id} value={t.id!}>{t.name}{t.workOrderRef ? ` - WO ${t.workOrderRef}` : ""}</option>)}
              </select>
            </label>
          )}
          <label className="block">
            <span className={lbl}>{k.what} <span className="font-bold text-amber-700 dark:text-amber-400">- required</span></span>
            <textarea value={what} onChange={(e) => { setWhat(e.target.value); setMsg(null); }} rows={2} placeholder={kind === "added" ? "e.g. Clean the downcomers while the tower is open" : "e.g. Tray 14 cracked at the weld - needs repair before close-up"}
              className={`${inp} w-full h-auto py-1.5`} />
          </label>
          <div className="space-y-1">
            <span className={lbl}>Work order # <span className="font-bold text-amber-700 dark:text-amber-400">- required</span></span>
            <div className="flex flex-wrap items-center gap-1.5">
              <input value={wo} onChange={(e) => { setWo(e.target.value); setNoWo(false); setMsg(null); }} placeholder="e.g. 310990" aria-label="Work order number"
                className={`${inp} w-36 font-mono`} />
              {taskWo && (
                <button type="button" aria-pressed={!noWo && wo.trim() === taskWo} onClick={() => { setWo(taskWo); setNoWo(false); setMsg(null); }}
                  className={`h-8 px-3 rounded-md border text-[12px] font-bold ${!noWo && wo.trim() === taskWo ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"}`}>Same as the task: {taskWo}</button>
              )}
              <button type="button" aria-pressed={noWo} onClick={() => { setNoWo(true); setWo(""); setMsg(null); }}
                className={`h-8 px-3 rounded-md border text-[12px] font-bold ${noWo ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"}`}>No WO # yet</button>
            </div>
            {noWo && <div className="text-[11px] text-[var(--color-text-muted)]">{taskWo ? `It shows under the task's WO ${taskWo} until you add its own (the step's Edit).` : "Add it later on the step (Edit)."}</div>}
          </div>
          <DateTimePicker label={`When was it ${k.found}?`} hint="- required" value={foundV} onChange={(v) => { setFoundV(v); setMsg(null); }} tz={tz} times={times} />
          <div>
            <span className={lbl}>Work it adds</span>
            <div className="space-y-1.5">
              {rows.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <input value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Step - e.g. Weld repair tray 14" aria-label="Step"
                    className={`${inp} flex-1 min-w-[180px]`} />
                  <CrewPicker value={r.crew} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, crew: v } : x)))} crews={crews} className="w-40" />
                  <span className="inline-flex items-center gap-1">
                    <input value={r.hours} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, hours: e.target.value.replace(/[^0-9.]/g, "").slice(0, 5) } : x)))} inputMode="decimal" placeholder="hrs" aria-label="Hours"
                      className={`${inp} w-14 text-right font-mono`} />
                    <span className="text-[var(--color-text-muted)]">h</span>
                  </span>
                  {rows.length > 1 && <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove this step" className="w-7 h-7 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><Trash2 className="w-3.5 h-3.5" /></button>}
                </div>
              ))}
              <button type="button" onClick={() => setRows([...rows, { name: "", crew: rows[rows.length - 1]?.crew ?? "", hours: "" }])} className="inline-flex items-center gap-1 font-bold text-[var(--color-accent)] hover:underline"><Plus className="w-3.5 h-3.5" /> Another step (done after the one above)</button>
            </div>
          </div>
          {isNew ? (
            <div className="text-[11px] text-[var(--color-text-muted)]">On its own: its steps run one after the other, linked to nothing else. If it waits on or holds up other work, link it from the step&apos;s Edit plan.</div>
          ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className={lbl}>Starts after</span>
              <select value={afterId ?? ""} onChange={(e) => pickAfter(e.target.value || null)} className={`${inp} w-full`}>
                <option value="">{startMode === "set" ? "Nothing before it" : "Nothing - starts now"}</option>
                {steps.map((s) => <option key={s.id} value={s.id!}>{s.name}{s.status === "completed" ? " (done)" : s.status === "in_progress" ? " (under way)" : ""}</option>)}
              </select>
              {/* After work that isn't done: it waits for it — say so, so two
                  jobs meant to run side by side aren't put one after the other. */}
              {afterId && steps.find((s) => s.id === afterId)?.status !== "completed" && (
                <span className="mt-1 block text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                  One after the other: it waits until “{afterName}” is done{follows != null ? ` (planned ${fmt(follows)})` : ""}. Running side by side? Pick what they both start after.
                </span>
              )}
            </label>
            <div>
              <span className={lbl}>Holds up <span className="font-normal text-[var(--color-text-muted)]">- can&apos;t start until it&apos;s done</span></span>
              <div className="max-h-28 overflow-y-auto rounded-md border border-[var(--color-border)] px-2 py-1 space-y-0.5">
                {steps.filter((s) => s.id !== afterId && s.status !== "completed").map((s) => (
                  <label key={s.id} className="flex items-start gap-1.5">
                    <input type="checkbox" className="mt-0.5" checked={holds.includes(s.id!)} onChange={(e) => setHolds(e.target.checked ? [...holds, s.id!] : holds.filter((x) => x !== s.id))} />
                    <span className="break-words">{s.name}</span>
                  </label>
                ))}
                {steps.filter((s) => s.id !== afterId && s.status !== "completed").length === 0 && <span className="text-[var(--color-text-muted)] italic">Nothing left on this task</span>}
              </div>
            </div>
          </div>
          )}
          <div className="space-y-1.5">
            <span className={lbl}>When can the work start?</span>
            <div className="flex flex-wrap gap-1" role="group" aria-label="When the work starts">
              {([["asap", `As soon as it can - ${fmt(asap)}`], ["set", "At a set time"]] as const).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={startMode === k} onClick={() => { setStartMode(k); setMsg(null); if (k === "set" && !startV) setStartV(toDateTimeInput(asap, tz)); }}
                  className={`h-8 px-3 rounded-md border text-[12px] font-bold ${startMode === k ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"}`}>{l}</button>
              ))}
            </div>
            {startMode === "asap"
              ? <div className="text-[11px] text-[var(--color-text-muted)]">{(() => {
                if (afterStep && afterStep.status !== "completed") return follows != null && follows >= now ? `When “${afterName}” is planned to be done.` : `When “${afterName}” is done - it isn't yet, so from now.`;
                const end = afterStep ? ms(afterStep.actualAt ?? afterStep.plannedAt) : NaN;
                if (Number.isFinite(end) && Number.isFinite(foundMs) && end > foundMs) return `When “${afterName}” was done.`;
                return `Right when it was ${k.found}.`;
              })()}</div>
              : <DateTimePicker label="Planned start" value={startV} onChange={(v) => { setStartV(v); setMsg(null); }} tz={tz} times={times} future showNow={false} />}
          </div>
          <label className="block">
            <span className={lbl}>Approved by <span className="font-normal text-[var(--color-text-muted)]">- optional</span></span>
            <input value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} placeholder="e.g. TA manager / owner rep" className={`${inp} w-full`} />
          </label>

          {/* What it does to the schedule — before it's saved. */}
          <div className={`rounded-lg border px-3 py-2 space-y-1 ${plan?.impact.critical ? "border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30" : "border-[var(--color-border)] bg-[var(--color-surface-2)]"}`}>
            <div className="font-black text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">What it does to the schedule</div>
            {!plan ? <div className="text-[var(--color-text-muted)]">{timeProblem && filled.length ? timeProblem : "Add the work it needs (a step and its hours) to see."}</div> : (
              <>
                <div className="font-bold">{impactLine(plan.impact, hrs)}</div>
                <div>{isNew ? <>{taskName}: done <b>{fmt(plan.impact.taskFinish[1])}</b></> : <>{taskName}: finish {fmt(plan.impact.taskFinish[0])} → <b>{fmt(plan.impact.taskFinish[1])}</b></>}</div>
                <div>Turnaround (forecast): {fmt(plan.impact.finish[0])} → <b className={plan.impact.finish[1] > plan.impact.finish[0] + 6 * 60_000 ? "text-rose-700 dark:text-rose-400" : ""}>{fmt(plan.impact.finish[1])}</b>
                  {!isNew && plan.impact.finish[1] <= plan.impact.finish[0] + 6 * 60_000 && plan.impact.taskFinish[1] > plan.impact.taskFinish[0] ? " - it fits in the float" : ""}</div>
                <div className="text-[var(--color-text-muted)]">New work: {plan.steps.map((s) => `${s.name} ${fmt(Date.parse(s.plannedStartAt))} → ${fmt(Date.parse(s.plannedAt))}`).join("; ")}</div>
                {plan.impact.pushed.length > 0 && (
                  <div>Holds up {plan.impact.pushed.length} planned step{plan.impact.pushed.length === 1 ? "" : "s"} (forecast): {plan.impact.pushed.slice(0, 5).map((p) => `${p.name} +${hrs(p.hours)}`).join(", ")}{plan.impact.pushed.length > 5 ? ` + ${plan.impact.pushed.length - 5} more` : ""}. Their planned dates don&apos;t change.</div>
                )}
              </>
            )}
          </div>
          {msg && <div role="alert" className="font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-9 px-3 rounded-lg border border-[var(--color-border-strong)] font-semibold">Cancel</button>
            <button type="button" onClick={() => void save()} disabled={busy}
              className="h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
              {busy ? "Adding…" : "Add to the schedule"}
            </button>
          </div>
          <div className="text-[10.5px] text-[var(--color-text-faint)]">{isNew
            ? <>It goes in as a new work order{underId ? ` under ${groups.find((g) => g.id === underId)?.label.split(" › ").pop()}` : ""}, its steps marked as {k.lower}. No other step&apos;s planned dates change.</>
            : <>It goes in as steps under {taskName}, marked as {k.lower}, linked after the step it follows; what it holds up waits on it. No other step&apos;s planned dates change - the delay shows as the forecast finish, against the plan.</>}</div>
        </div>
      </div>
    </div>
  );
}
