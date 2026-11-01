"use client";

// The field tracker's print window: the whole job, one work order, one step
// (a sheet of its own, full of lines), or the work planned in a date range
// (a long job, printed a week or two at a time). Lines a step: from the
// plan, or a set number. The form is blank: nothing recorded on it
// (lib/fieldTracker).

import React, { useState } from "react";
import { Printer } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import type { FieldOrder } from "@/lib/fieldTracker";

export type FieldChoice =
  | { kind: "job"; lines: "auto" | number }
  | { kind: "wo"; key: string; lines: "auto" | number }
  | { kind: "step"; key: string; step: string }
  | { kind: "range"; from: string; to: string; lines: "auto" | number };

const selCls = "w-full h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-text)]";
const woLabel = (o: FieldOrder) => `${o.wo ? `WO ${o.wo} · ` : ""}${o.name}`;

export default function FieldTrackerPrint({ orders, today, onPrint, onClose }: {
  orders: FieldOrder[];
  /** "2026-11-01" in plant time: where the date range starts. */
  today: string;
  onPrint: (c: FieldChoice) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<FieldChoice["kind"]>("job");
  const [woKey, setWoKey] = useState(orders[0]?.key ?? "");
  const wo = orders.find((o) => o.key === woKey);
  const [stepId, setStepId] = useState(wo?.steps[0]?.id ?? "");
  const [lines, setLines] = useState<"auto" | number>("auto");
  const plus = (days: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(plus(6));
  const pickWo = (k: string) => { setWoKey(k); setStepId(orders.find((o) => o.key === k)?.steps[0]?.id ?? ""); };
  const ok = kind === "job" || (kind === "wo" && !!wo) || (kind === "step" && !!wo && !!stepId) || (kind === "range" && !!from && !!to && to >= from);
  const go = () => {
    if (!ok) return;
    onPrint(kind === "job" ? { kind, lines } : kind === "wo" ? { kind, key: woKey, lines } : kind === "step" ? { kind, key: woKey, step: stepId } : { kind, from, to, lines });
  };
  const opt = (k: FieldChoice["kind"], title: string, sub: string, extra?: React.ReactNode) => (
    <div className={`rounded-xl border px-3 py-2.5 ${kind === k ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)]"}`}>
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="radio" name="field-kind" checked={kind === k} onChange={() => setKind(k)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
        <span className="min-w-0"><b className="block text-[13px]">{title}</b><span className="block text-[12px] text-[var(--color-text-muted)]">{sub}</span></span>
      </label>
      {kind === k && extra && <div className="mt-2 pl-6 space-y-1.5">{extra}</div>}
    </div>
  );
  const woPicker = (
    <select value={woKey} onChange={(e) => pickWo(e.target.value)} aria-label="Work order" className={selCls}>
      {orders.map((o) => <option key={o.key} value={o.key}>{woLabel(o)}</option>)}
    </select>
  );
  return (
    <Modal onClose={onClose} size="md">
      <ModalHeader icon={Printer} title="Print field tracker" subtitle="A blank form to fill in by hand: the work orders, steps, their resource and plan; nothing else from the schedule." onClose={onClose} />
      <ModalBody>
        <div className="space-y-2">
          {opt("job", "Whole job", "Every work order and its steps")}
          {opt("wo", "One work order", "All its steps", woPicker)}
          {opt("step", "One step", "A sheet of its own, full of lines", <>
            {woPicker}
            <select value={stepId} onChange={(e) => setStepId(e.target.value)} aria-label="Step" className={selCls}>
              {(wo?.steps ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}{s.crew ? ` · ${s.crew}` : ""}</option>)}
            </select>
          </>)}
          {opt("range", "Work in a date range", "Only the work planned in those dates: a long job, a week or two at a time", <>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => { setFrom(today); setTo(plus(6)); }} className="h-7 px-2.5 rounded-full border border-[var(--color-border-strong)] text-[12px] font-semibold hover:bg-[var(--color-surface-2)]">Next 7 days</button>
              <button type="button" onClick={() => { setFrom(today); setTo(plus(13)); }} className="h-7 px-2.5 rounded-full border border-[var(--color-border-strong)] text-[12px] font-semibold hover:bg-[var(--color-surface-2)]">Next 14 days</button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className={`${selCls} w-auto`} />
              <span className="text-[var(--color-text-muted)]">to</span>
              <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" className={`${selCls} w-auto`} />
            </div>
          </>)}
          {kind !== "step" && (
            <div className="flex flex-wrap items-center gap-2 pt-1 text-[12.5px]">
              <span className="font-semibold">Lines a step</span>
              <div className="inline-flex flex-wrap rounded-lg border border-[var(--color-border-strong)] overflow-hidden" role="group" aria-label="Lines a step">
                {(["auto", 2, 3, 4, 5, 6, 7, 8] as const).map((n) => (
                  <button key={n} type="button" aria-pressed={lines === n} onClick={() => setLines(n)}
                    className={`h-7 px-2.5 text-[12px] font-bold ${lines === n ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "hover:bg-[var(--color-surface-2)]"}`}>
                    {n === "auto" ? "Auto" : n}
                  </button>
                ))}
              </div>
              <span className="text-[11.5px] text-[var(--color-text-muted)]">{lines === "auto" ? "From the plan: a few hours 2, a day 4, a week or more 8" : `${lines} for every step`}</span>
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <button type="button" onClick={onClose} className="text-[12.5px] text-[var(--color-text-muted)] hover:underline">Cancel</button>
        <button type="button" disabled={!ok} onClick={go}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold disabled:opacity-50">
          <Printer className="w-4 h-4" /> Print
        </button>
      </ModalFooter>
    </Modal>
  );
}
