"use client";

// TaskQuickLook — the card a supervisor opens mid-meeting when someone asks
// about a step: where it should be by the end of the shift, when it and its
// equipment are scheduled to finish, what comes after it, what it waits on.
// Plus a search box to pull up any step, on tonight's report or not.
// Screen only — the printout is unchanged.

import { createContext, useContext, useMemo, useRef, useState } from "react";
import { ArrowRight, Hourglass, Search, Target, Wrench } from "lucide-react";
import { Modal, ModalHeader, ModalBody } from "@/components/ui/Modal";
import { searchSteps, type QuickLook, type QuickLookIndex } from "@/lib/taskQuickLook";

/** Lets a step name anywhere in the report open its card. */
export const QuickLookOpen = createContext<((id: string) => void) | null>(null);
export const useQuickLookOpen = () => useContext(QuickLookOpen);

export interface QuickLookFmt {
  /** "Oct 27 4:00" */
  DTs: (ms: number) => string;
  /** "6:00" */
  T: (ms: number) => string;
}

function Line({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 py-1.5 border-t border-[var(--color-border)] first:border-t-0">
      <span className="mt-0.5 text-[var(--color-text-faint)] shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
        <div className="text-[13px] text-[var(--color-text)]">{children}</div>
      </div>
    </div>
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
  const goalLabel = `By ${fmt.T(goalAt.end)} (end of ${goalAt.kind} shift)`;
  const note = noteOf?.(look.id)?.body ?? null;
  const done = look.percent >= 100;
  const behind = !done && look.percent + 5 < look.planNow;
  const stepLink = (s: QuickLook["next"][number]) => (
    <button type="button" onClick={() => onOpen(s.id)} className="text-left font-semibold text-[var(--color-accent)] hover:underline">
      {s.name}
    </button>
  );
  return (
    <Modal onClose={onClose} size="sm">
      <ModalHeader icon={Wrench} title={look.name} onClose={onClose}
        subtitle={[look.parentName, look.who, look.wo ? `WO ${look.wo}` : null].filter(Boolean).join(" · ")} />
      <ModalBody>
        <div className="-mt-1">
          <Line icon={<Target className="w-4 h-4" />} label={goalLabel}>
            {done ? <b>Done</b> : (
              <>
                <b className="text-[15px]">{look.goal}%</b>
                <span className="text-[var(--color-text-muted)]"> · now {look.percent}%</span>
                <span className={behind ? "text-rose-700 dark:text-rose-300 font-semibold" : "text-[var(--color-text-muted)]"}> · plan by now {look.planNow}%</span>
              </>
            )}
          </Line>
          <Line icon={<Hourglass className="w-4 h-4" />} label="Scheduled">
            This step {fmt.DTs(look.start)} → <b>{fmt.DTs(look.finish)}</b>
            {look.equipment && (
              <div className="text-[12px] text-[var(--color-text-muted)]">
                {look.equipment.name}: done <b className="text-[var(--color-text)]">{fmt.DTs(look.equipment.finish)}</b> · {look.equipment.done}/{look.equipment.total} steps · {look.equipment.percent}%
              </div>
            )}
          </Line>
          <Line icon={<ArrowRight className="w-4 h-4" />} label="Next after it">
            {look.next.length === 0 ? <span className="text-[var(--color-text-muted)]">Nothing — it&apos;s the last step{look.equipment ? ` on ${look.equipment.name}` : ""}.</span> : (
              <ul className="space-y-0.5">
                {look.next.map((s) => (
                  <li key={s.id}>
                    {stepLink(s)}
                    <span className="text-[12px] text-[var(--color-text-muted)]"> · {fmt.DTs(s.start)}{s.who ? ` · ${s.who}` : ""}{s.parentName && s.parentName !== look.parentName ? ` · ${s.parentName}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </Line>
          {look.waitsOn.length > 0 && (
            <Line icon={<Hourglass className="w-4 h-4" />} label="Waits on">
              <ul className="space-y-0.5">
                {look.waitsOn.map((s) => (
                  <li key={s.id}>{stepLink(s)} <span className="text-[12px] text-[var(--color-text-muted)]">· {s.percent}% · due {fmt.DTs(s.finish)}</span></li>
                ))}
              </ul>
            </Line>
          )}
          {(look.reason || note) && (
            <Line icon={<span className="block w-4 text-center font-black">“</span>} label={look.reason ? "Reason" : "Last comment"}>
              <span className="italic">{look.reason ?? note}</span>
            </Line>
          )}
        </div>
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
