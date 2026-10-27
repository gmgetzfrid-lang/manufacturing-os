"use client";

// Add work for the next shift — pull steps forward from later in the
// schedule for hands that would otherwise run out of work. Search any work
// order, equipment or step across the whole job, or browse what's ready in
// the next few days. Each pick shows if it's ready, whose scope it is, and
// how much of the crew's shift it fills. Nothing on the schedule moves:
// it's a suggestion on the turnover.

import React, { useMemo, useRef, useState } from "react";
import { Check, Plus, Search, Users, X, Zap } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { filterLookAhead, scopeOf } from "@/lib/pullAhead";
import { capacityOf } from "@/lib/shiftHandover";
import type { LookAheadItem, PullCrew, ShiftRow, ShiftWindow } from "@/lib/shiftReport";

const WINDOWS = [
  { id: "1", label: "Next day", days: 1 },
  { id: "3", label: "3 days", days: 3 },
  { id: "7", label: "7 days", days: 7 },
  { id: "all", label: "Whole job", days: Infinity },
] as const;
const SHOW = 120;

export function PullAheadPicker({ items, onLists, next, shiftHours, picked, counted, pull, sizeSet, crews, fmt, locked, onToggle, onPull, onSaveDefault, onClose }: {
  /** Every upcoming step not on a list yet (goals.lookAhead, whole job). */
  items: LookAheadItem[];
  /** Steps already on a list — found by a search, said where. */
  onLists: Array<{ row: ShiftRow; where: string }>;
  next: ShiftWindow;
  shiftHours: number;
  /** Steps already pulled for the next shift. */
  picked: ShiftRow[];
  /** Everything the shift is asked to try (pulled + the other crew's), as
   *  the report counts it against the crew size. */
  counted: ShiftRow[];
  pull: PullCrew;
  /** A crew size has been set (else the meter waits for one). */
  sizeSet: boolean;
  crews: string[];
  fmt: { D: (ms: number) => string; T: (ms: number) => string };
  locked: boolean;
  onToggle: (row: ShiftRow, on: boolean) => void;
  onPull: (p: PullCrew) => void;
  /** Keep this crew and size as the project's default. */
  onSaveDefault?: (p: PullCrew) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [readyOnly, setReadyOnly] = useState(true);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [win, setWin] = useState<(typeof WINDOWS)[number]["id"]>("3");
  const [more, setMore] = useState(false);
  const [defaultState, setDefaultState] = useState<{ for: PullCrew; ok: boolean; msg?: string } | null>(null);
  const defaultNow = defaultState && JSON.stringify(defaultState.for) === JSON.stringify(pull) ? defaultState : null;
  const searchRef = useRef<HTMLInputElement>(null);
  const days = WINDOWS.find((w) => w.id === win)!.days;
  const until = days === Infinity ? Infinity : next.end + days * 86_400_000;
  // Soonest first, so each day appears once.
  const list = useMemo(() => filterLookAhead(items, { query, readyOnly, criticalOnly, until })
    .sort((a, b) => a.row.crewStart - b.row.crewStart || a.row.leaf.name.localeCompare(b.row.leaf.name)), [items, query, readyOnly, criticalOnly, until]);
  // A search also says where it found steps that are already listed.
  const listedHits = useMemo(() => {
    const k = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!k.length) return [];
    return onLists.filter((x) => { const t = [x.row.leaf.name, ...x.row.path, x.row.leaf.workOrderRef ?? "", x.row.leaf.responsibleParty ?? ""].join(" ").toLowerCase(); return k.every((w) => t.includes(w)); });
  }, [onLists, query]);
  const pickedIds = useMemo(() => new Set(picked.map((r) => r.leaf.id)), [picked]);
  const shown = more ? list : list.slice(0, SHOW);
  const addable = (x: LookAheadItem) => x.readiness !== "held" && !x.blockedBy;
  const only = list.length === 1 && addable(list[0]) && !pickedIds.has(list[0].row.leaf.id) && !locked ? list[0] : null;

  const share = (r: ShiftRow) => Math.min(r.hoursLeft, shiftHours);
  // The report's own count (capacityOf): everything asked of the shift.
  const capa = capacityOf(sizeSet ? pull : null, counted, shiftHours);
  const used = capa.used, cap = capa.hours, over = capa.over;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const kind = next.kind === "day" ? "day" : "night";

  // Grouped by the day each step is planned to start on its crew's hours.
  const groups: Array<{ day: string; key: string; rows: LookAheadItem[] }> = [];
  for (const x of shown) {
    const day = fmt.D(x.row.crewStart);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.rows.push(x); else groups.push({ day, key: `${day}:${groups.length}`, rows: [x] });
  }

  const num = (v: string, max: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; };
  return (
    <Modal onClose={onClose} size="xl">
      <ModalHeader icon={Zap} title={`Add work for the ${kind} shift`} subtitle={`${fmt.D(next.start)} ${fmt.T(next.start)}–${fmt.T(next.end)} · pull steps forward for hands with time to spare. The schedule doesn't move.`} onClose={onClose} />
      <ModalBody className="p-0">
        {/* Crew and how much of its shift is filled */}
        <div className="px-4 pt-3 pb-2.5 border-b border-[var(--color-border)] space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px]">
            <span className="inline-flex items-center gap-1.5 font-bold text-[var(--color-text)]"><Users className="w-4 h-4 text-[var(--color-accent)]" /> Crew</span>
            <select value={pull.crew ?? ""} disabled={locked} onChange={(e) => onPull({ ...pull, crew: e.target.value || null })} aria-label="Crew for the extra work"
              className="h-8 max-w-[240px] rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-text)]">
              <option value="">Not named</option>
              {crews.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label className="inline-flex items-center gap-1.5 text-[var(--color-text-muted)]">
              <input type="number" min={0} max={50} step={1} disabled={locked} value={pull.hands} onChange={(e) => onPull({ ...pull, hands: num(e.target.value, 50) })}
                className="h-8 w-14 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[12.5px] text-[var(--color-text)]" aria-label="Hands" /> hands ×
              <input type="number" min={0} max={24} step={0.5} disabled={locked} value={pull.hours} onChange={(e) => onPull({ ...pull, hours: num(e.target.value, 24) })}
                className="h-8 w-16 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-[12.5px] text-[var(--color-text)]" aria-label="Hours each" /> h
            </label>
            {onSaveDefault && !locked && (
              <button type="button" onClick={() => { const p = pull; onSaveDefault(p).then(() => setDefaultState({ for: p, ok: true }), (e: Error) => setDefaultState({ for: p, ok: false, msg: e.message })); }}
                className="text-[11.5px] font-semibold text-[var(--color-accent)] hover:underline">
                {defaultNow?.ok ? "✓ Default for every shift" : "Make this the default"}
              </button>
            )}
            {defaultNow && !defaultNow.ok && <span className="w-full text-[11.5px] text-rose-700 dark:text-rose-300">{defaultNow.msg}</span>}
          </div>
          {cap > 0 ? (
            <div className="flex items-center gap-2.5">
              <div className="flex-1 h-2.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(used, cap)} aria-valuetext={`${used} of ${cap} hours`} aria-label="Hours asked of the crew">
                <div className={`h-full rounded-full ${over ? "bg-rose-500" : pct >= 85 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
              </div>
              <span className={`shrink-0 text-[12px] font-bold tabular-nums ${over ? "text-rose-700 dark:text-rose-300" : "text-[var(--color-text)]"}`}>
                {used} h of {cap} h{over ? " — over" : ""}
              </span>
            </div>
          ) : (
            <div className="text-[11.5px] text-[var(--color-text-muted)]">{used > 0 ? `${used} h asked of the shift. ` : ""}Set the crew size to see how full the shift is.</div>
          )}
        </div>

        {/* Search and filters */}
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] space-y-2 bg-slate-50/60 dark:bg-[var(--color-surface-2)]">
          <label className="relative block">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
            <input ref={searchRef} autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setMore(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" && query && only) onToggle(only.row, true); }}
              aria-label="Search the job for a step to add"
              placeholder="Search a work order #, equipment (E-17), step or crew — the whole job"
              className="w-full h-10 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] pl-8 pr-8 text-[13.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40" />
            {query && <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-4 h-4" /></button>}
          </label>
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            {query ? (
              <span className="text-[var(--color-text-muted)]">Searching the whole job · {list.length} to add{listedHits.length ? ` · ${listedHits.length} already listed` : ""}{only ? " — Enter adds it" : ""}</span>
            ) : (
              <>
                <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5" role="group" aria-label="How far ahead">
                  {WINDOWS.map((w) => (
                    <button key={w.id} type="button" onClick={() => { setWin(w.id); setMore(false); }} aria-pressed={win === w.id}
                      className={`px-2 py-1 rounded-md font-semibold ${win === w.id ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{w.label}</button>
                  ))}
                </div>
                <Chip on={readyOnly} onClick={() => setReadyOnly((v) => !v)}>Ready to start</Chip>
              </>
            )}
            <Chip on={criticalOnly} onClick={() => setCriticalOnly((v) => !v)}>Critical only</Chip>
          </div>
        </div>

        {/* The steps */}
        <div className="divide-y divide-[var(--color-border)]">
          {list.length === 0 && (
            <div className="px-4 py-10 text-center text-[13px] text-[var(--color-text-muted)]">
              {query
                ? (listedHits.length ? "Nothing new to add — what matches is already listed (below)." : <>No step matches &ldquo;{query}&rdquo;{criticalOnly ? " among critical steps" : ""}.</>)
                : `Nothing ${readyOnly ? "ready to start" : "planned"}${criticalOnly ? " on the critical path" : ""} ${days === Infinity ? "in the rest of the job" : "in this window"}${days === Infinity ? "." : " — widen it"}${readyOnly ? ", or turn off Ready to start." : "."}`}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.key}>
              <div className="sticky top-0 z-10 px-4 py-1 bg-slate-100 dark:bg-slate-800 text-[10.5px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-300">{g.day}</div>
              {g.rows.map((x) => {
                const r = x.row, on = pickedIds.has(r.leaf.id);
                const scope = scopeOf(x, pull.crew);
                const cant = !addable(x);
                const early = x.readiness === "waiting";
                return (
                  <div key={r.leaf.id} className={`flex items-start gap-3 px-4 py-2.5 ${on ? "bg-indigo-50/70 dark:bg-indigo-950/30" : ""}`}>
                    <button type="button" disabled={locked || (cant && !on)} onClick={() => onToggle(r, !on)} aria-pressed={on}
                      aria-label={`${on ? "Remove" : "Add"} ${r.leaf.name}${r.parentName ? ` (${r.parentName})` : ""}`}
                      title={cant ? (x.blockedBy ? `Can't start — it waits on ${x.blockedBy}, which is blocked or on hold` : `Blocked or on hold${r.reason ? `: ${r.reason}` : ""}`) : on ? "Remove from the shift" : early ? "Not ready yet — add only if you know it can start" : "Add to the shift"}
                      className={`shrink-0 mt-0.5 inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-bold whitespace-nowrap transition-colors disabled:opacity-40 ${on
                        ? "border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-700"
                        : early ? "border-amber-400 text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40"
                          : "border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                      {on ? <><Check className="w-3.5 h-3.5" /> Added</> : <><Plus className="w-3.5 h-3.5" /> {early && !cant ? "Add anyway" : "Add"}</>}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-bold text-[var(--color-text)] break-words">{r.leaf.name}</span>
                        {r.critical && <Tag tone="rose">critical</Tag>}
                        <Ready x={x} kind={kind} />
                        {scope && <Tag tone="amber">{scope}&apos;s scope — coordinate</Tag>}
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)] break-words">
                        {r.path.slice(0, -1).join(" › ") || r.parentName}
                        {r.leaf.workOrderRef ? <> · WO <span className="font-mono">{r.leaf.workOrderRef}</span></> : null}
                        {!scope && r.leaf.responsibleParty ? <> · {r.leaf.responsibleParty}</> : null}
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
                        planned {fmt.T(r.crewStart)}{r.crewFinish - r.crewStart < 86_400_000 ? `–${fmt.T(r.crewFinish)}` : ` → ${fmt.D(r.crewFinish)}`}{r.reflowed ? " (crew hours)" : ""} · <b className="text-[var(--color-text)]">{share(r)} h</b> on one shift{r.hoursLeft > shiftHours ? ` (of ${r.hoursLeft} h left)` : ""}{r.percent > 0 ? ` · ${r.percent}% done` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {listedHits.length > 0 && (
            <div>
              <div className="px-4 py-1 bg-slate-100 dark:bg-slate-800 text-[10.5px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-300">Already listed</div>
              {listedHits.map((x) => (
                <div key={x.row.leaf.id} className="flex items-start gap-3 px-4 py-2 text-[12.5px]">
                  <span className="shrink-0 mt-0.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--color-text-muted)] whitespace-nowrap">Listed</span>
                  <div className="min-w-0"><b className="text-[var(--color-text)] break-words">{x.row.leaf.name}</b> <span className="text-[var(--color-text-muted)]">· {x.row.parentName} · {x.where}</span></div>
                </div>
              ))}
            </div>
          )}
          {!more && list.length > SHOW && (
            <button type="button" onClick={() => setMore(true)} className="w-full py-2.5 text-[12px] font-semibold text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]">Show all {list.length}</button>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex items-center w-full gap-2">
          <span className="flex-1 text-[12px] text-[var(--color-text-muted)]">
            {picked.length ? <><b className="text-[var(--color-text)]">{picked.length} step{picked.length === 1 ? "" : "s"}</b> · {used} h{cap > 0 ? ` of ${cap} h` : ""} · listed under Next shift as &ldquo;could try if possible&rdquo;</> : "Nothing added yet."}
          </span>
          <button type="button" onClick={onClose} className="rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] px-4 py-2 text-[12.5px] font-bold">Done</button>
        </div>
      </ModalFooter>
    </Modal>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-semibold ${on
        ? "border-[var(--color-accent)] bg-orange-50 dark:bg-orange-950/40 text-orange-800 dark:text-orange-200"
        : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
      {on && <Check className="w-3 h-3" />}{children}
    </button>
  );
}

function Tag({ tone, children }: { tone: "rose" | "amber" | "emerald" | "slate"; children: React.ReactNode }) {
  const cls = tone === "rose" ? "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900"
    : tone === "amber" ? "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900"
      : tone === "emerald" ? "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900"
        : "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700";
  return <span className={`inline-block max-w-full break-words px-1.5 py-px rounded border text-[9.5px] font-black uppercase tracking-wider ${cls}`}>{children}</span>;
}

function Ready({ x, kind }: { x: LookAheadItem; kind: string }) {
  const w = x.waits.length ? `${x.waits[0]}${x.waits.length > 1 ? ` +${x.waits.length - 1}` : ""}` : "";
  if (x.readiness === "ready") return <Tag tone="emerald">ready</Tag>;
  if (x.blockedBy) return <Tag tone="rose">can&apos;t start — {x.blockedBy} is blocked</Tag>;
  if (x.readiness === "after-tonight") return <Tag tone="amber">after {w} — planned to finish on the {kind} shift</Tag>;
  if (x.readiness === "held") return <Tag tone="rose">{x.row.status === "blocked" ? "blocked" : "on hold"}{x.row.reason ? ` — ${x.row.reason}` : ""}</Tag>;
  return <Tag tone="slate">waits on {w}</Tag>;
}
