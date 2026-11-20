"use client";

// How the batch's file names were read — one line, not a form.
//
// Files from one place follow one convention, so the names are grouped by
// pattern (the shape of their pieces) and each pattern is shown once, as its
// first file cut into labelled pieces. Every piece is a small picker: change
// what a piece is and every file with that pattern follows, and the answer
// is remembered for this library. When everything was clear the line is
// quiet; when a piece was a guess it's highlighted — that's the one question.

import React, { useMemo, useState } from "react";
import { Wand2, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { ROLE_LABEL, type NameReading, type NameRole } from "@/lib/filenameRoles";

const TONE: Record<NameRole, string> = {
  number: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)] dark:bg-[var(--color-surface-2)] dark:text-[var(--color-text)] dark:border-[var(--color-border)]",
  title: "bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-800/60 dark:text-slate-200 dark:border-slate-700",
  rev: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900",
  sheet: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)] dark:bg-[var(--color-surface-2)] dark:text-[var(--color-text)] dark:border-[var(--color-border)]",
  date: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)] dark:bg-[var(--color-surface-2)] dark:text-[var(--color-text)] dark:border-[var(--color-border)]",
  skip: "bg-transparent text-[var(--color-text-faint)] border-dashed border-[var(--color-border)] line-through",
};
const ROLES: NameRole[] = ["number", "title", "rev", "sheet", "date", "skip"];

export default function NameReadingStrip({ readings, onChange }: {
  readings: Array<NameReading & { file: string }>;
  onChange: (shape: string, roles: NameRole[]) => void;
}) {
  const groups = useMemo(() => {
    const by = new Map<string, { shape: string; example: NameReading & { file: string }; count: number; unsure: number }>();
    for (const r of readings) {
      const g = by.get(r.shape) ?? { shape: r.shape, example: r, count: 0, unsure: 0 };
      g.count++;
      if (!r.sure) { g.unsure++; if (g.example.sure) g.example = r; }
      by.set(r.shape, g);
    }
    return [...by.values()].sort((a, b) => (b.unsure > 0 ? 1 : 0) - (a.unsure > 0 ? 1 : 0) || b.count - a.count);
  }, [readings]);
  const unsure = groups.reduce((n, g) => n + g.unsure, 0);
  const [open, setOpen] = useState(false);
  if (!groups.length) return null;
  const shown = unsure > 0 || open ? groups.filter((g) => open || g.unsure > 0).slice(0, 6) : groups.slice(0, 1);

  return (
    <div className={`mb-3 rounded-xl border px-3 py-2 text-[13px] ${unsure ? "border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20" : "border-[var(--color-border)] bg-[var(--color-surface-2)]/40"}`}>
      <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
        {unsure ? <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" /> : <Wand2 className="w-3.5 h-3.5 shrink-0" />}
        <span className="flex-1">
          {unsure
            ? <><b className="text-amber-900 dark:text-amber-200">Part of {unsure} file name{unsure === 1 ? "" : "s"} could be read two ways.</b> Pick what the highlighted piece is, it applies to every file named the same way, and is remembered for this library.</>
            : <>File names read as{groups.length > 1 ? ` (${groups.length} naming patterns)` : ""} - click a piece to change what it is.</>}
        </span>
        {groups.length > 1 && (
          <button onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-0.5 font-bold hover:text-[var(--color-text)]">
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} {open ? "Fewer" : "All patterns"}
          </button>
        )}
      </div>
      <div className="mt-1.5 space-y-1.5">
        {shown.map((g) => (
          <div key={g.shape} className="flex items-center gap-1 flex-wrap">
            {g.example.parts.map((p, i) => (
              <label key={i} className={`relative inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${TONE[p.role]} ${p.sure ? "" : "ring-2 ring-amber-400"}`} title={`“${p.text}” is read as ${ROLE_LABEL[p.role]}`}>
                <span className="font-display tabular-nums">{p.text}</span>
                <span className="text-[13px] font-semibold opacity-70">{ROLE_LABEL[p.role]}</span>
                <select
                  aria-label={`What “${p.text}” is`}
                  value={p.role}
                  onChange={(e) => onChange(g.shape, g.example.parts.map((q, j) => (j === i ? e.target.value as NameRole : q.role)))}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                >
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </label>
            ))}
            <span className="text-[13px] text-[var(--color-text-faint)] ml-1">{g.count} file{g.count === 1 ? "" : "s"}{g.unsure ? ` · ${g.unsure} unsure` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
