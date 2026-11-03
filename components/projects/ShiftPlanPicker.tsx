"use client";

// Plan the next shift: tick the work it's given. Starts empty (or with the
// plan saved before); each box puts a step on or takes it off. The list
// is grouped the way the report sees the work (late, on the schedule, the
// other crew's, ready early), each by work order, and a search finds any
// open step on the job. Saved, it's the shift's list on the turnover, the
// meeting, the email and the shift sheet (lib/nightPlan). Nothing on the
// schedule moves.

import React, { useMemo, useRef, useState } from "react";
import { ListChecks, Search, X } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { searchPlanPool, planToSave, type PlanChoiceGroup } from "@/lib/nightPlan";
import { workOrderOfStep } from "@/lib/shiftSheet";
import type { ShiftPlan, ShiftRow, ShiftWindow } from "@/lib/shiftReport";
import type { Milestone } from "@/types/schema";

const MAX_HITS = 60;

export function ShiftPlanPicker({ next, groups, pool, byId, plan, locked, fmt, by, onSave, onRemove, onClose }: {
  next: ShiftWindow;
  /** What to pick from (lib/shiftPlan planChoices). */
  groups: PlanChoiceGroup[];
  /** Every open step a search can find. */
  pool: Array<{ row: ShiftRow; held: boolean }>;
  byId: Map<string, Milestone>;
  /** The plan saved before, if any: its steps start ticked. */
  plan?: ShiftPlan;
  locked: boolean;
  fmt: { D: (ms: number) => string; T: (ms: number) => string; DTs: (ms: number) => string };
  by: string | null;
  onSave: (plan: ShiftPlan) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
}) {
  const kind = next.kind;
  const [picked, setPicked] = useState<string[]>(() => plan?.ids ?? []);
  const [expect, setExpect] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(plan?.expect ?? {}).map(([k, v]) => [k, String(v)])));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const on = useMemo(() => new Set(picked), [picked]);
  const rowOf = useMemo(() => new Map(pool.map((x) => [x.row.leaf.id!, x])), [pool]);
  const shiftHours = (next.end - next.start) / 3_600_000;
  const toggle = (id: string, yes: boolean) => setPicked((cur) => (yes ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id)));
  const setMany = (ids: string[], yes: boolean) => setPicked((cur) => (yes ? [...cur, ...ids.filter((id) => !cur.includes(id))] : cur.filter((x) => !ids.includes(x))));

  // Steps ticked from a search, in none of the groups.
  const inGroups = useMemo(() => new Set(groups.flatMap((g) => g.rows.map((r) => r.leaf.id))), [groups]);
  const fromSearch = picked.filter((id) => !inGroups.has(id)).map((id) => rowOf.get(id)?.row).filter((r): r is ShiftRow => !!r);
  const hits = useMemo(() => searchPlanPool(pool, query, (id) => workOrderOfStep(id, byId)?.wo), [pool, query, byId]);
  const hrs = Math.round(picked.reduce((a, id) => a + Math.min(rowOf.get(id)?.row.hoursLeft ?? 0, shiftHours), 0) * 10) / 10;
  // A saved step no longer open (finished, or gone from the schedule).
  const gone = (plan?.ids ?? []).filter((id) => !rowOf.has(id)).length;

  const save = async () => {
    setBusy(true); setErr(null);
    try { await onSave(planToSave(picked.filter((id) => rowOf.has(id)), expect, by, Date.now())); onClose(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setErr(null);
    try { await onRemove(); onClose(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  // A group's steps, by work order.
  const byWo = (rows: ShiftRow[]) => {
    const out: Array<{ key: string; label: string; rows: ShiftRow[] }> = [];
    const at = new Map<string, number>();
    for (const r of rows) {
      const g = r.leaf.id ? workOrderOfStep(r.leaf.id, byId) : null;
      const key = g?.key ?? `-:${r.leaf.id}`;
      const label = [g?.wo ? `WO ${g.wo}` : null, g?.owner.name && g.owner.id !== r.leaf.id ? g.owner.name : null].filter(Boolean).join(" · ") || "No work order";
      if (!at.has(key)) { at.set(key, out.length); out.push({ key, label, rows: [] }); }
      out[at.get(key)!].rows.push(r);
    }
    return out;
  };

  const row = (r: ShiftRow, isHeld = false) => {
    const id = r.leaf.id!;
    const yes = on.has(id);
    const when = r.start >= next.end ? `planned ${fmt.DTs(r.start)}` : r.carryOver ? `was due ${fmt.DTs(r.dueAt)}` : r.start < next.start ? "under way" : `planned ${fmt.T(r.start)}`;
    const left = Math.round(Math.min(r.hoursLeft, shiftHours) * 10) / 10;
    return (
      <div key={id} className={`flex items-start gap-3 px-4 py-2.5 ${yes ? "bg-indigo-50/70 dark:bg-indigo-950/30" : ""}`}>
        <label className="flex flex-1 min-w-0 items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={yes} disabled={locked || (isHeld && !yes)} onChange={(e) => toggle(id, e.target.checked)}
            aria-label={`${yes ? "Take off" : "Put on"} the plan: ${r.leaf.name}`}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-[var(--color-border-strong)] accent-indigo-600" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] font-bold text-[var(--color-text)] break-words">{r.leaf.name}</span>
              {r.critical && <Tag tone="rose">critical</Tag>}
              {r.carryOver && <Tag tone="amber">late</Tag>}
              {isHeld && <Tag tone="rose">{r.status === "blocked" ? "blocked" : "on hold"}</Tag>}
            </span>
            <span className="mt-0.5 block text-[11.5px] text-[var(--color-text-muted)] break-words">
              {[r.leaf.responsibleParty?.trim() || "no crew named", when, `${r.percent}% done`, left > 0 ? `${left} h left` : null].filter(Boolean).join(" · ")}
            </span>
          </span>
        </label>
        {yes && (
          <label className="shrink-0 flex items-center gap-1 text-[11.5px] text-[var(--color-text-muted)]">
            <input inputMode="numeric" value={expect[id] ?? ""} disabled={locked} onChange={(e) => setExpect((cur) => ({ ...cur, [id]: e.target.value.replace(/[^\d]/g, "").slice(0, 3) }))}
              placeholder={r.goalPct != null && r.goalPct > r.percent ? String(r.goalPct) : "-"} aria-label={`% expected by the end of the shift: ${r.leaf.name}`}
              className="h-8 w-12 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-right text-[12.5px] text-[var(--color-text)] tabular-nums" />
            % by end
          </label>
        )}
      </div>
    );
  };

  const section = (title: string, rows: ShiftRow[], key: string) => {
    const ids = rows.map((r) => r.leaf.id!);
    const all = ids.every((id) => on.has(id));
    return (
      <div key={key}>
        <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-slate-100 dark:bg-slate-800">
          <span className="flex-1 min-w-0 text-[10.5px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-300">{title} · {rows.length}</span>
          {!locked && (
            <button type="button" onClick={() => setMany(ids, !all)} className="shrink-0 text-[11.5px] font-bold text-[var(--color-accent)] hover:underline">
              {all ? "Untick all" : "Tick all"}
            </button>
          )}
        </div>
        {byWo(rows).map((g) => (
          <div key={g.key} className="border-b border-[var(--color-border)] last:border-b-0">
            <div className="px-4 pt-2 text-[11px] font-bold text-[var(--color-text-muted)] break-words">{g.label}</div>
            <div className="divide-y divide-[var(--color-border)]">{g.rows.map((r) => row(r))}</div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <Modal onClose={onClose} size="xl" dismissable={!busy}>
      <ModalHeader icon={ListChecks} title={`Plan the ${kind} shift`}
        subtitle={`${fmt.D(next.start)} ${fmt.T(next.start)} to ${fmt.T(next.end)} · tick the work you're giving it. The schedule's dates don't move.`} onClose={busy ? undefined : onClose} />
      <ModalBody className="p-0">
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)]">
          <label className="relative block">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the job for a step"
              placeholder="Find any step: WO #, equipment (V-01), step or crew"
              className="w-full h-10 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] pl-8 pr-8 text-[13.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40" />
            {query && <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>}
          </label>
          {!plan && !query && picked.length === 0 && (
            <div className="mt-2 text-[12px] text-[var(--color-text-muted)]">Nothing is on the plan yet. Tick each job the {kind} shift will work.</div>
          )}
          {gone > 0 && !query && (
            <div className="mt-2 text-[12px] text-[var(--color-text-muted)]">{gone} step{gone === 1 ? "" : "s"} on the saved plan {gone === 1 ? "is" : "are"} done or off the schedule, and drop off when you save.</div>
          )}
        </div>
        {query ? (
          <div className="divide-y divide-[var(--color-border)]">
            {hits.length === 0
              ? <div className="px-4 py-10 text-center text-[13px] text-[var(--color-text-muted)]">No open step matches &ldquo;{query}&rdquo;.</div>
              : hits.slice(0, MAX_HITS).map((x) => row(x.row, x.held))}
            {hits.length > MAX_HITS && <div className="px-4 py-2 text-[11.5px] text-[var(--color-text-muted)]">{hits.length - MAX_HITS} more match. Add a word to narrow it.</div>}
          </div>
        ) : (
          <>
            {fromSearch.length > 0 && section("Added from the search", fromSearch, "search")}
            {groups.map((g) => section(g.title, g.rows, g.id))}
            {groups.length === 0 && fromSearch.length === 0 && (
              <div className="px-4 py-10 text-center text-[13px] text-[var(--color-text-muted)]">Nothing open on the schedule around the {kind} shift. Search to add any step.</div>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full flex-wrap items-center gap-2">
          <span className="mr-auto text-[12.5px] font-bold text-[var(--color-text)] tabular-nums">
            {picked.length} step{picked.length === 1 ? "" : "s"}{picked.length ? ` · ${hrs} h` : ""}
          </span>
          {err && <span className="w-full text-[12px] text-rose-700 dark:text-rose-300" role="alert">{err}</span>}
          {plan && !locked && (
            <button type="button" disabled={busy} onClick={() => void remove()}
              className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
              Remove plan
            </button>
          )}
          <button type="button" disabled={busy} onClick={onClose}
            className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
            {locked ? "Close" : "Cancel"}
          </button>
          {!locked && (
            <button type="button" disabled={busy || picked.length === 0} onClick={() => void save()}
              className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-[12.5px] font-bold text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {busy ? "Saving…" : "Save plan"}
            </button>
          )}
        </div>
      </ModalFooter>
    </Modal>
  );
}

function Tag({ tone, children }: { tone: "rose" | "amber"; children: React.ReactNode }) {
  const c = tone === "rose" ? "border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300" : "border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300";
  return <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-bold ${c}`}>{children}</span>;
}
