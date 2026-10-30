"use client";

// TaskQuickLook — the card a supervisor opens mid-meeting when someone asks
// about a step. Answers first, in three tiles: where it should be by the
// end of the shift, when the step is done, when its equipment is done.
// Then every step on the equipment in start order with its times (this
// step and the next one marked), what else waits on it, and when each
// overall task above it is scheduled to be done.
// Plus a search box to pull up any step, on tonight's report or not.
// Screen only — the printout is unchanged.

import { createContext, useContext, useMemo, useRef, useState } from "react";
import { Search, Wrench } from "lucide-react";
import { Modal, ModalHeader, ModalBody } from "@/components/ui/Modal";
import { searchSteps, type QuickLook, type QuickLookIndex } from "@/lib/taskQuickLook";
import { equipmentTag } from "@/lib/safetyMoment";

/** Lets a step name anywhere in the report open its card. */
export const QuickLookOpen = createContext<((id: string) => void) | null>(null);
export const useQuickLookOpen = () => useContext(QuickLookOpen);

export interface QuickLookFmt {
  /** "Oct 27 4:00" */
  DTs: (ms: number) => string;
  /** "6:00" */
  T: (ms: number) => string;
}

function Tile({ label, sub, big, small, tone }: { label: string; sub?: string; big: React.ReactNode; small?: React.ReactNode; tone?: "accent" }) {
  return (
    <div className={`min-w-0 rounded-lg border px-2 py-1.5 sm:px-3 sm:py-2 ${tone === "accent" ? "border-orange-400 bg-orange-50 dark:border-orange-700 dark:bg-orange-950/40" : "border-[var(--color-border)] bg-[var(--color-surface-2)]"}`}>
      <div className="text-[9px] sm:text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">{label}{sub && <span className="hidden sm:inline normal-case font-semibold tracking-normal"> · {sub}</span>}</div>
      <div className="text-[13px] sm:text-[18px] font-black leading-tight text-[var(--color-text)] tabular-nums">{big}</div>
      {small && <div className="text-[10.5px] sm:text-[11.5px] leading-snug text-[var(--color-text-muted)]">{small}</div>}
    </div>
  );
}

function Heading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <h3 className="mt-4 mb-1.5 text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}{hint && <span className="ml-1.5 normal-case font-semibold tracking-normal text-[var(--color-text-faint)]">{hint}</span>}
    </h3>
  );
}

export function QuickLookCard({ look, goalAt, noteOf, fmt, onOpen, onClose }: {
  look: QuickLook;
  /** The shift the goal is for — the one being planned. */
  goalAt: { end: number; kind: "day" | "night" };
  /** The step's latest comment. */
  noteOf?: (id: string) => { body: string } | undefined;
  fmt: QuickLookFmt;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const note = noteOf?.(look.id)?.body ?? null;
  const done = look.percent >= 100;
  const behind = !done && look.percent + 5 < look.planNow;
  const eq = look.equipment;
  const eqName = eq ? (equipmentTag(eq.name) ?? eq.name) : null;
  const above = look.levels.slice(1);
  const link = (s: { id: string; name: string }, cls = "") => (
    <button type="button" onClick={() => onOpen(s.id)} className={`text-left hover:underline ${cls}`}>{s.name}</button>
  );
  return (
    <Modal onClose={onClose} size="lg">
      <ModalHeader icon={Wrench} title={look.name} onClose={onClose}
        subtitle={[eq?.name, look.who, look.wo ? `WO ${look.wo}` : null].filter(Boolean).join(" · ")} />
      <ModalBody>
        {/* The three questions, answered first. */}
        <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
          <Tile tone="accent" label={`Goal by ${fmt.T(goalAt.end)}`} sub={`end of ${goalAt.kind} shift`}
            big={done ? "Done" : `${look.goal}%`}
            small={done ? null : <>now {look.percent}% · <span className={behind ? "font-bold text-rose-700 dark:text-rose-300" : ""}>plan by now {look.planNow}%</span></>} />
          <Tile label="This step done by" big={fmt.DTs(look.finish)} small={`starts ${fmt.DTs(look.start)}`} />
          {eq ? (
            <Tile label={`${eqName} done by`} big={Number.isFinite(eq.finish) ? fmt.DTs(eq.finish) : "-"} small={`${eq.done} of ${eq.total} steps · ${eq.percent}%`} />
          ) : <Tile label="Next" big={look.next[0] ? fmt.DTs(look.next[0].start) : "-"} small={look.next[0]?.name ?? "nothing after it"} />}
        </div>

        {look.waitsOn.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] dark:border-amber-900 dark:bg-amber-950/30">
            <b className="text-amber-900 dark:text-amber-200">Can&apos;t start until done: </b>
            {look.waitsOn.map((s, i) => (
              <span key={s.id}>{i > 0 && " · "}{link(s, "font-semibold text-[var(--color-text)]")} <span className="text-[var(--color-text-muted)]">({s.percent}%, due {fmt.DTs(s.finish)})</span></span>
            ))}
          </div>
        )}

        {/* Every step on the equipment, in order, with its times. */}
        {look.order.length > 1 && (
          <>
            <Heading hint="in start order - tap a step to open it">Step order on {eqName ?? "this task"}</Heading>
            <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-[var(--color-surface-2)] text-[9.5px] font-black uppercase tracking-wider text-[var(--color-text-muted)] text-left">
                    <th className="px-2 py-1 w-[104px]">Starts</th>
                    <th className="px-2 py-1 w-[104px] hidden sm:table-cell">Done by</th>
                    <th className="px-2 py-1">Step</th>
                    <th className="px-2 py-1 hidden sm:table-cell">Who</th>
                    <th className="px-2 py-1 w-12 text-right">%</th>
                  </tr>
                </thead>
                <tbody>
                  {look.order.map((s) => {
                    const fin = s.percent >= 100;
                    return (
                      <tr key={s.id} className={`border-t border-[var(--color-border)] align-top ${s.isThis ? "bg-orange-50 dark:bg-orange-950/40" : ""}`}>
                        <td className="px-2 py-1 font-mono tabular-nums text-[11px] whitespace-nowrap">{fmt.DTs(s.start)}</td>
                        <td className="px-2 py-1 font-mono tabular-nums text-[11px] whitespace-nowrap hidden sm:table-cell">{fmt.DTs(s.finish)}</td>
                        <td className="px-2 py-1">
                          {s.isThis ? <b className="text-[var(--color-text)]">{s.name}</b> : link(s, fin ? "text-[var(--color-text-faint)] line-through" : "font-semibold text-[var(--color-text)]")}
                          {s.isThis && <span className="ml-1.5 rounded bg-[var(--color-accent)] px-1 py-px text-[9px] font-black uppercase text-[var(--color-accent-fg)]">This step</span>}
                          {s.isNext && <span className="ml-1.5 rounded bg-slate-800 px-1 py-px text-[9px] font-black uppercase text-white dark:bg-slate-200 dark:text-slate-900">Next</span>}
                        </td>
                        <td className="px-2 py-1 hidden sm:table-cell text-[11px] text-[var(--color-text-muted)]">{s.who}</td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-[11px]">{fin ? "✓" : `${s.percent}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {look.order.length > 0 && look.next.length === 0 && (
          <p className="mt-1.5 text-[12px] text-[var(--color-text-muted)]">This is the last step on {eqName ?? "this task"}.</p>
        )}

        {look.nextElsewhere.length > 0 && (
          <>
            <Heading>Also waiting on this step</Heading>
            <ul className="space-y-0.5 text-[12.5px]">
              {look.nextElsewhere.map((s) => (
                <li key={s.id}>{link(s, "font-semibold text-[var(--color-text)]")} <span className="text-[var(--color-text-muted)]">· {s.parentName} · starts {fmt.DTs(s.start)}</span></li>
              ))}
            </ul>
          </>
        )}

        {/* When each task above it is scheduled to be done. */}
        {above.length > 0 && (
          <>
            <Heading>Overall tasks it rolls up to</Heading>
            <ul className="space-y-1">
              {above.map((l, i) => (
                <li key={l.id} className="flex items-baseline gap-2 text-[12.5px]" style={{ paddingLeft: i * 10 }}>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">{l.name}</span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">done by <b className="font-mono text-[var(--color-text)]">{Number.isFinite(l.finish) ? fmt.DTs(l.finish) : "-"}</b> · {l.percent}%</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {(look.reason || note) && (
          <>
            <Heading>{look.reason ? "Reason it's held" : "Last comment"}</Heading>
            <p className="text-[12.5px] italic text-[var(--color-text)]">{look.reason ?? note}</p>
          </>
        )}
      </ModalBody>
    </Modal>
  );
}

/** Type a tag, a step or a crew — pick a step to open its card. */
export function TaskSearch({ idx, fmt, onPick }: { idx: QuickLookIndex; fmt: QuickLookFmt; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => searchSteps(q, idx), [q, idx]);
  const pick = (id: string) => { onPick(id); setOpen(false); setQ(""); };
  return (
    <div ref={box} className="relative shrink-0 w-full sm:w-auto"
      onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <label className="sr-only" htmlFor="report-task-search">Look up a step</label>
      <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] pointer-events-none" aria-hidden="true" />
      <input id="report-task-search" value={q} placeholder="Look up a step…" autoComplete="off"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, hits.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === "Enter" && hits[hi]) { e.preventDefault(); pick(hits[hi].id); }
          if (e.key === "Escape") { setOpen(false); (e.target as HTMLInputElement).blur(); }
        }}
        className="w-full sm:w-52 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] py-1 pl-7 pr-2 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]" />
      {open && q.trim() && (
        <div className="absolute right-0 top-full mt-1 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-lg py-1">
          {hits.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-[var(--color-text-muted)]">No step matches “{q.trim()}”.</div>
          ) : hits.map((h, i) => (
            <button key={h.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h.id)}
              className={`block w-full text-left px-3 py-1.5 ${i === hi ? "bg-[var(--color-surface-2)]" : "hover:bg-[var(--color-surface-2)]"}`}>
              <div className="text-[12px] font-semibold text-[var(--color-text)] truncate">{h.name}</div>
              <div className="text-[10.5px] text-[var(--color-text-muted)] truncate">{[h.parentName, fmt.DTs(h.start), h.who].filter(Boolean).join(" · ")}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
