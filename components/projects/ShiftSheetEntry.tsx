"use client";

// Enter the shift sheet: what was written on it by pen, line for line, in
// the order it's printed (lib/shiftSheet). Each line: start time, % at
// lunch, % at the end of the shift, done time, a hold, a note. Saved as the
// step's updates at the times written (lib/shiftSheetSave). A step that
// isn't on the sheet (the crew jumped ahead) is found and added at the
// bottom.

import React, { useMemo, useState } from "react";
import { CheckCircle2, ClipboardPen, Loader2, Plus, Search, X } from "lucide-react";
import type { Milestone } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { leafPercent } from "@/lib/scheduleProgress";
import type { ShiftTimes, ShiftWindow } from "@/lib/shiftReport";
import { handoverKey } from "@/lib/shiftHandover";
import { entryLines, planEntry, sheetTimes, splitTag, groupSheet, type SheetEntry, type SheetGroup, type SheetLine } from "@/lib/shiftSheet";
import { saveSheetLine } from "@/lib/shiftSheetSave";
import { useShiftRecords } from "@/lib/shiftRecord";
import { woOf } from "@/lib/workOrderCrew";
import { startMsOf } from "@/lib/calendarPlacement";
import { searchMatcher, hasQuery } from "@/lib/fuzzySearch";

const field = "h-9 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-text)] disabled:opacity-50";
const has = (e?: SheetEntry) => !!e && !!(e.start?.trim() || e.lunchPct?.trim() || e.endPct?.trim() || e.done?.trim() || e.hold || e.note?.trim());

export default function ShiftSheetEntry({ milestones, progress, tz, times, target, projectId, userId, userName, canEdit, onClose, onSaved }: {
  milestones: Milestone[];
  progress?: Map<string, ProgressInfo>;
  tz: string;
  times: ShiftTimes;
  target: ShiftWindow;
  projectId: string;
  userId?: string;
  userName?: string;
  canEdit: boolean;
  onClose: () => void;
  /** After a save: the schedule is read again. */
  onSaved?: () => void;
}) {
  const { records } = useShiftRecords(projectId);
  const printed = records.get(handoverKey(target))?.sheet ?? null;
  const plan = records.get(handoverKey(target))?.plan;
  const byId = useMemo(() => new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m])), [milestones]);
  const pctOf = (m: Milestone) => (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
  // The lines as printed (or as they'd print), and those added here. Kept
  // as first worked out: a save mustn't reshuffle the list under the pen.
  const [now] = useState(() => Date.now());
  const sheetKey = printed ? printed.ids.join(",") : plan ? `plan:${plan.ids.join(",")}` : "";
  const base = useMemo(() => entryLines({ milestones, progress, tz, times, target, now, printed, plan }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list is fixed once open (and when the printed record arrives)
    [sheetKey, target.start]);
  const [added, setAdded] = useState<SheetLine[]>([]);
  const groups: SheetGroup[] = useMemo(() => (added.length ? [...base, ...groupSheet(added, milestones).map((g) => ({ ...g, key: `added:${g.key}` }))] : base), [base, added, milestones]);
  const [entry, setEntry] = useState<Record<string, SheetEntry>>({});
  const [result, setResult] = useState<Record<string, { ok: boolean; msg?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const at = sheetTimes(target, times, tz);
  const orgId = milestones[0]?.orgId ?? "";
  const set = (id: string, patch: Partial<SheetEntry>) => { setEntry((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } })); setResult((r) => { const n = { ...r }; delete n[id]; return n; }); };

  const lineIds = groups.flatMap((g) => g.lines.map((l) => l.id));
  const filled = lineIds.filter((id) => has(entry[id]) && !result[id]?.ok);

  const save = async () => {
    if (!userId || !orgId) return;
    setBusy(true); setSummary(null);
    const out: Record<string, { ok: boolean; msg?: string }> = {};
    const queue = [...filled];
    const run = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const m = byId.get(id);
        if (!m) { out[id] = { ok: false, msg: "This step isn't on the schedule any more." }; continue; }
        const started = m.status === "in_progress" || m.status === "completed" || pctOf(m) > 0 || !!m.actualStartAt;
        const plan = planEntry(entry[id], { target, tz, times, now: Date.now(), started, currentPct: Math.round(pctOf(m)) });
        if (plan.error) { out[id] = { ok: false, msg: plan.error }; continue; }
        try {
          const warn = await saveSheetLine(id, plan.events, { orgId, userId, userName });
          out[id] = { ok: true, msg: warn ?? undefined };
        } catch (e) { out[id] = { ok: false, msg: (e as Error).message }; }
      }
    };
    await Promise.all([run(), run(), run()]);
    setResult((r) => ({ ...r, ...out }));
    const ok = Object.values(out).filter((x) => x.ok).length, bad = Object.values(out).length - ok;
    setSummary(`${ok} line${ok === 1 ? "" : "s"} saved${bad ? `. ${bad} need${bad === 1 ? "s" : ""} a fix: see the red lines.` : "."}`);
    setBusy(false);
    if (ok) onSaved?.();
  };

  // ── Add a step that isn't on the sheet ──
  const [q, setQ] = useState("");
  const kids = useMemo(() => { const s = new Set<string>(); for (const m of milestones) if (m.parentId) s.add(m.parentId); return s; }, [milestones]);
  const found = useMemo(() => {
    if (!hasQuery(q)) return [];
    const match = searchMatcher(q);
    const on = new Set(lineIds);
    return milestones
      .filter((m) => m.id && !kids.has(m.id) && !on.has(m.id) && m.status !== "completed")
      .map((m) => {
        const parent = m.parentId ? byId.get(m.parentId) : undefined;
        return { m, parent, s: match(`${m.name} ${parent?.name ?? ""} ${woOf(m)} ${m.responsibleParty ?? ""}`) };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || startMsOf(a.m) - startMsOf(b.m))
      .slice(0, 8);
  }, [q, milestones, kids, byId, lineIds]);
  const addLine = (m: Milestone) => {
    setAdded((cur) => [...cur, { id: m.id!, name: m.name, crew: m.responsibleParty?.trim() ?? "", kind: "early", started: m.status === "in_progress" || pctOf(m) > 0, planStart: startMsOf(m), planFinish: Date.parse(String(m.plannedAt)), dueAt: Date.parse(String(m.plannedAt)), critical: false }]);
    setQ("");
  };

  const dayWord = new Date(target.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  const timeWord = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });

  const lineRow = (l: SheetLine) => {
    const m = byId.get(l.id);
    const e = entry[l.id] ?? {};
    const r = result[l.id];
    const done = r?.ok;
    const started = !!m && (m.status === "in_progress" || pctOf(m) > 0 || !!m.actualStartAt) && !done;
    const isDone = m?.status === "completed";
    const lock = !canEdit || busy || !!done;
    return (
      <div key={l.id} className={`px-3 py-2.5 ${r && !r.ok ? "bg-rose-50 dark:bg-rose-950/30" : done ? "bg-emerald-50/70 dark:bg-emerald-950/25" : ""}`}>
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-[minmax(0,1.5fr)_118px_72px_72px_118px_64px_minmax(0,1fr)] items-center">
          <div className="col-span-2 sm:col-span-1 min-w-0">
            <div className="text-[13px] font-bold text-[var(--color-text)] leading-snug">{l.name}</div>
            <div className="text-[11.5px] text-[var(--color-text-muted)]">
              {l.crew || "No crew named"}
              {isDone && <span className="ml-1.5 font-bold text-emerald-700 dark:text-emerald-400">done</span>}
              {!isDone && m && pctOf(m) > 0 && <span className="ml-1.5 font-semibold">at {Math.round(pctOf(m))}%</span>}
            </div>
          </div>
          <label className="min-w-0"><span className="sm:hidden block text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Start</span>
            {started ? <span className="flex h-9 items-center justify-center rounded-lg bg-[var(--color-surface-2)] text-[12px] font-semibold text-[var(--color-text-muted)]">going</span>
              : <input type="time" aria-label={`${l.name}: start time`} value={e.start ?? ""} disabled={lock} onChange={(x) => set(l.id, { start: x.target.value })} className={field} />}
          </label>
          <label className="min-w-0"><span className="sm:hidden block text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{at.lunchLabel}</span>
            <input inputMode="numeric" placeholder="%" aria-label={`${l.name}: ${at.lunchLabel}`} value={e.lunchPct ?? ""} disabled={lock} onChange={(x) => set(l.id, { lunchPct: x.target.value.replace(/[^\d]/g, "").slice(0, 3) })} className={`${field} text-center`} />
          </label>
          <label className="min-w-0"><span className="sm:hidden block text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">% end of shift</span>
            <input inputMode="numeric" placeholder="%" aria-label={`${l.name}: % at the end of the shift`} value={e.endPct ?? ""} disabled={lock} onChange={(x) => set(l.id, { endPct: x.target.value.replace(/[^\d]/g, "").slice(0, 3) })} className={`${field} text-center`} />
          </label>
          <label className="min-w-0"><span className="sm:hidden block text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Done</span>
            <input type="time" aria-label={`${l.name}: done time`} value={e.done ?? ""} disabled={lock} onChange={(x) => set(l.id, { done: x.target.value })} className={field} />
          </label>
          <label className="flex items-center gap-1.5 text-[12.5px] font-semibold cursor-pointer select-none">
            <input type="checkbox" checked={!!e.hold} disabled={lock} onChange={(x) => set(l.id, { hold: x.target.checked })} className="w-4 h-4 accent-amber-600" /> Hold
          </label>
          <input placeholder={e.hold ? "Why it's held" : "Note"} aria-label={`${l.name}: note`} value={e.note ?? ""} disabled={lock} onChange={(x) => set(l.id, { note: x.target.value })} className={`${field} col-span-2 sm:col-span-1`} />
        </div>
        {r && <div className={`mt-1 text-[12px] font-semibold ${r.ok ? (r.msg ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-400") : "text-rose-700 dark:text-rose-300"}`}>{r.ok ? (r.msg ?? "Saved") : r.msg}</div>}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/60 flex items-stretch sm:items-center justify-center sm:p-4" role="dialog" aria-modal="true" aria-label="Enter the shift sheet">
      <div className="w-full sm:max-w-6xl h-full sm:h-[94vh] flex flex-col bg-[var(--color-surface)] sm:rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-start gap-3 px-4 py-3 border-b border-[var(--color-border)]">
          <ClipboardPen className="w-5 h-5 mt-0.5 text-[var(--color-accent)] shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-black text-[var(--color-text)]">Enter the shift sheet</div>
            <div className="text-[12.5px] text-[var(--color-text-muted)]">
              {target.kind === "day" ? "Day" : "Night"} shift · {dayWord} · {timeWord(target.start)} to {timeWord(target.end)}
              {" · "}{printed ? "the lines as printed" : "the lines as the sheet would print now"}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-4 py-2 text-[12px] text-[var(--color-text-muted)] border-b border-[var(--color-border)] bg-[var(--color-surface-2)]">
          Fill in only what&apos;s written. The {at.lunchName} % is saved at {timeWord(at.lunch)}, the end of shift % at {timeWord(at.end)}. 100% with no done time is done then.
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Column names, on a wide screen */}
          <div className="hidden sm:grid sticky top-0 z-10 gap-2 px-3 py-1.5 grid-cols-[minmax(0,1.5fr)_118px_72px_72px_118px_64px_minmax(0,1fr)] bg-[var(--color-surface)] border-b border-[var(--color-border)] text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
            <span>Step · crew</span><span>Start</span><span>{at.lunchLabel}</span><span>% end</span><span>Done</span><span>Hold</span><span>Note</span>
          </div>
          {groups.length === 0 && <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">Nothing on this shift&apos;s sheet. Add what was worked below.</div>}
          {groups.map((g) => {
            const t = g.tag ? g : { ...g, ...splitTag(g.name) };
            return (
              <div key={g.key} className="border-b-2 border-[var(--color-border-strong)]">
                <div className="flex items-baseline gap-2 px-3 pt-2.5 pb-1 bg-[var(--color-surface-2)]/60">
                  <span className="text-[17px] font-black text-[var(--color-text)]">{t.tag ?? (g.wo ? `WO ${g.wo}` : "No WO")}</span>
                  <span className="min-w-0 truncate text-[12px] text-[var(--color-text-muted)]">{t.tag && g.wo ? `WO ${g.wo} · ` : ""}{t.rest}</span>
                  {g.key.startsWith("added:") && <span className="text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-accent)]">added</span>}
                </div>
                <div className="divide-y divide-[var(--color-border)]">{g.lines.map(lineRow)}</div>
              </div>
            );
          })}
          {/* Not on the sheet: find it on the schedule */}
          <div className="px-3 py-3 space-y-2">
            <div className="text-[12.5px] font-bold text-[var(--color-text)]">Written in at the bottom? Find it on the schedule</div>
            <div className="relative max-w-xl">
              <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-[var(--color-text-muted)]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="E-12, a WO number, a step or a crew" aria-label="Find a step" className={`${field} pl-8`} />
            </div>
            {found.length > 0 && (
              <div className="max-w-xl rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                {found.map(({ m, parent }) => (
                  <button key={m.id} type="button" onClick={() => addLine(m)} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-surface-2)]">
                    <Plus className="w-4 h-4 text-[var(--color-accent)] shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold text-[var(--color-text)] truncate">{m.name}</span>
                      <span className="block text-[11.5px] text-[var(--color-text-muted)] truncate">{[parent?.name, woOf(m) ? `WO ${woOf(m)}` : "", m.responsibleParty].filter(Boolean).join(" · ")}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="text-[11.5px] text-[var(--color-text-muted)]">Not on the schedule at all? Add it as discovery or a new work order from Work, then enter it here.</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-[var(--color-border)]">
          {summary && <span role="status" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--color-text)]"><CheckCircle2 className="w-4 h-4 text-emerald-600" />{summary}</span>}
          {!canEdit && <span className="text-[12.5px] text-[var(--color-text-muted)]">You can read this project; entering takes editing rights.</span>}
          <span className="ml-auto" />
          <button type="button" onClick={onClose} className="h-9 px-3.5 rounded-lg border border-[var(--color-border-strong)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">{summary ? "Close" : "Cancel"}</button>
          <button type="button" disabled={!canEdit || busy || filled.length === 0 || !userId} onClick={() => void save()}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save {filled.length || ""} line{filled.length === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
