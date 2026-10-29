"use client";

// Shift notes, hour by hour — on the turnover report. One tap writes a
// draft from the shift's own entries (lib/shiftHourly); every line shows
// what the check found against those entries, and the times the draft left
// out. Each line can be fixed or removed, lines can be added by hand, and
// nothing goes in the email or on paper until someone approves it.

import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Pencil, Plus, Sparkles, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { appConfirm } from "@/components/providers/DialogProvider";
import { TimeChip } from "@/components/projects/DateTimePicker";
import { clockOnShift } from "@/components/projects/ShiftRecordParts";
import type { ShiftWindow } from "@/lib/shiftReport";
import type { TimeLogRow } from "@/lib/timeLog";
import { checkHourly, clock24, hourlyClocks, hourlyPrompt, parseHourly, type HourlyLine, type HourlyNotes } from "@/lib/shiftHourly";
import { modelName } from "@/lib/ai/jobModels";
import { newId } from "@/lib/shiftRecord";

const inputCls = "rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1 text-[12.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent-ring)]";
const btn = "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-bold disabled:opacity-60";

export interface HourlyCtx {
  notes?: HourlyNotes;
  save: (next: HourlyNotes | null) => Promise<void>;
  /** The shift's entries (the time log for its window). */
  rows: () => Promise<TimeLogRow[]>;
  orgId: string;
  projectId: string;
  by: string | null;
  shiftTitle: string;
  window: string;
}

export function ShiftHourlyBox({ h, edit, print, shift, tz }: {
  h: HourlyCtx; edit: boolean; print: boolean; shift: ShiftWindow; tz: string;
}) {
  const [busy, setBusy] = useState<"draft" | "save" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const n = h.notes;
  const lines = [...(n?.lines ?? [])].sort((a, b) => a.at - b.at);
  const approved = !!n?.approved;
  const clocks = hourlyClocks(lines.map((l) => l.at), tz);

  const save = async (next: HourlyNotes | null) => {
    setBusy("save");
    try { await h.save(next); setMsg(null); } catch (e) { setMsg((e as Error).message); }
    setBusy(null);
  };

  const draft = async () => {
    if (lines.length && !(await appConfirm({
      title: "Write the notes again?",
      message: "This replaces the lines below, including any you changed, with a new draft from the entries.",
      confirmLabel: "Write again",
    }))) return;
    setBusy("draft"); setMsg(null);
    try {
      const rows = await h.rows();
      if (rows.length === 0) throw new Error("Nothing has been entered on this shift yet — no starts, progress, comments or notes to write from.");
      const { data } = await supabase.auth.getSession();
      const res = await fetch("/api/projects/shift-notes", {
        method: "POST",
        headers: { "content-type": "application/json", ...(data.session?.access_token ? { authorization: `Bearer ${data.session.access_token}` } : {}) },
        body: JSON.stringify({ orgId: h.orgId, projectId: h.projectId, prompt: hourlyPrompt(rows, { tz, shiftTitle: h.shiftTitle, window: h.window }) }),
      });
      const out = await res.json().catch(() => null) as { text?: string; model?: string; error?: string } | null;
      if (!res.ok || !out?.text) throw new Error(out?.error || `Couldn't write the notes (HTTP ${res.status}).`);
      const parsed = parseHourly(out.text);
      if (parsed.length === 0) throw new Error("The model's answer had no lines in it — try again.");
      const checked = checkHourly(parsed, rows, tz);
      const drafted: HourlyLine[] = checked.lines.map((l) => {
        const on = l.at ?? (() => { const r = clockOnShift(shift, l.time, tz); return "at" in r ? r.at : shift.start; })();
        return { id: newId(), at: on, text: l.text, ...(l.flags.length ? { flags: l.flags } : {}) };
      });
      await h.save({ lines: drafted, missing: checked.missing, model: out.model, madeAt: Date.now(), madeBy: h.by, approved: null });
    } catch (e) { setMsg((e as Error).message); }
    setBusy(null);
  };

  const setLine = (id: string, v: { at: number; text: string } | null) => {
    if (!n) return;
    const rest = n.lines.filter((l) => l.id !== id);
    // A line someone fixed by hand has been checked by them: its flags go.
    void save({ ...n, lines: v ? [...rest, { id, at: v.at, text: v.text }] : rest });
    setEditing(null);
  };
  const addLine = (v: { at: number; text: string }) => {
    void save({ ...(n ?? { lines: [], approved: null }), lines: [...(n?.lines ?? []), { id: newId(), at: v.at, text: v.text }] });
  };
  const flagged = lines.filter((l) => l.flags?.length).length;
  const approve = async () => {
    if (!n) return;
    if (flagged > 0 && !(await appConfirm({
      title: "Approve with lines still to check?",
      message: `${flagged} line${flagged === 1 ? "" : "s"} still say${flagged === 1 ? "s" : ""} something the shift's entries don't. Approve only if you've checked ${flagged === 1 ? "it" : "them"} and ${flagged === 1 ? "it's" : "they're"} right.`,
      confirmLabel: "Approve anyway",
    }))) return;
    await save({ ...n, approved: { at: Date.now(), by: h.by } });
  };

  if (print) {
    if (!approved || lines.length === 0) return <div className="text-[8pt] text-slate-500">Not written yet.</div>;
    return (
      <ul className="space-y-0.5 text-[8.5pt]">
        {lines.map((l, i) => <li key={l.id} className="flex gap-2"><span className="w-14 shrink-0 font-semibold whitespace-nowrap">{clocks[i]}</span><span>{l.text}</span></li>)}
      </ul>
    );
  }

  return (
    <div className="space-y-2">
      {lines.length > 0 && !approved && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200 space-y-1">
          <div className="font-bold">Draft — check each line, then approve. It isn&apos;t in the email until you do.</div>
          <div className="text-[11.5px]">
            Written from {n?.model ? `this shift's entries by ${modelName(n.model)}` : "this shift's entries"}.
            {flagged > 0 ? ` ${flagged} line${flagged === 1 ? "" : "s"} below say${flagged === 1 ? "s" : ""} something the entries don't — fix or remove ${flagged === 1 ? "it" : "them"}.` : " Every line matched the entries."}
          </div>
          {(n?.missing?.length ?? 0) > 0 && (
            <div className="text-[11.5px]"><b>Left out:</b> {n!.missing!.join(" · ")} — add them with “Add a line”, or write it again.</div>
          )}
        </div>
      )}
      {lines.length > 0 && approved && (
        <div className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5" /> Approved{n?.approved?.by ? ` by ${n.approved.by}` : ""} — in the email and on paper.
        </div>
      )}

      {lines.length === 0 && !edit && <div className="text-[12px] text-[var(--color-text-muted)]">Not written yet.</div>}

      {lines.length > 0 && (
        <ul className="space-y-1.5">
          {lines.map((l, i) => editing === l.id ? (
            <li key={l.id}><LineForm shift={shift} tz={tz} init={{ clock: clock24(l.at, tz), text: l.text }} onDone={(v) => setLine(l.id, v)} onCancel={() => setEditing(null)} /></li>
          ) : (
            <li key={l.id} className="group">
              <div className="flex items-baseline gap-2 text-[12.5px] leading-snug">
                <span className="w-[66px] shrink-0 font-bold text-[var(--color-text)] whitespace-nowrap tabular-nums">{clocks[i]}</span>
                <span className="min-w-0 flex-1 break-words text-[var(--color-text)]">{l.text}</span>
                {edit && (
                  <span className="shrink-0 flex gap-1">
                    <button type="button" onClick={() => setEditing(l.id)} aria-label={`Edit the ${clocks[i]} line`} className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><Pencil className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={() => setLine(l.id, null)} aria-label={`Remove the ${clocks[i]} line`} className="p-1 rounded text-[var(--color-text-muted)] hover:text-rose-700 hover:bg-[var(--color-surface-2)]"><X className="w-3.5 h-3.5" /></button>
                  </span>
                )}
              </div>
              {l.flags?.length ? (
                <div className="ml-[74px] mt-0.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300 flex items-start gap-1">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-[2px]" /> Check: {l.flags.join("; ")}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {edit && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" onClick={() => void draft()} disabled={busy !== null}
            className={`${btn} ${lines.length ? "border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]" : "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"}`}>
            {busy === "draft" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {busy === "draft" ? "Writing…" : lines.length ? "Write again" : "Write it from this shift's entries"}
          </button>
          {lines.length > 0 && !approved && (
            <button type="button" onClick={() => void approve()} disabled={busy !== null}
              className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>
              <CheckCircle2 className="w-3.5 h-3.5" /> Approve for the report
            </button>
          )}
          {lines.length > 0 && approved && (
            <button type="button" onClick={() => void save({ ...n!, approved: null })} disabled={busy !== null}
              className="text-[11.5px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline">Take back to draft</button>
          )}
          {lines.length === 0 && <span className="text-[11px] text-[var(--color-text-muted)]">AI writes a draft from the starts, progress, holds, comments and notes logged on the shift. You check it before it goes anywhere.</span>}
        </div>
      )}
      {edit && <AddLine shift={shift} tz={tz} onAdd={addLine} />}
      {msg && <div role="alert" className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
    </div>
  );
}

function LineForm({ shift, tz, init, onDone, onCancel }: {
  shift: ShiftWindow; tz: string; init: { clock: string; text: string };
  onDone: (v: { at: number; text: string }) => void; onCancel: () => void;
}) {
  const [clock, setClock] = useState(init.clock);
  const [text, setText] = useState(init.text);
  const [msg, setMsg] = useState<string | null>(null);
  const done = () => {
    const r = clockOnShift(shift, clock, tz);
    if ("error" in r) { setMsg(r.error); return; }
    if (!text.trim()) { setMsg("Type what happened."); return; }
    onDone({ at: r.at, text: text.replace(/\s+/g, " ").trim() });
  };
  return (
    <div className="rounded-lg border border-[var(--color-accent)]/50 bg-[var(--color-surface-2)]/50 p-2 space-y-1.5">
      <div className="flex items-start gap-2">
        <TimeChip value={clock} onChange={(v) => { setClock(v); setMsg(null); }} tz={tz} />
        <textarea value={text} onChange={(e) => { setText(e.target.value); setMsg(null); }} rows={2} aria-label="What happened"
          className={`${inputCls} flex-1 min-w-0 resize-y`} />
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={done} className={`${btn} !h-7 bg-[var(--color-accent)] text-[var(--color-accent-fg)]`}>Save line</button>
        <button type="button" onClick={onCancel} className="text-[11.5px] text-[var(--color-text-muted)] hover:underline">Cancel</button>
        {msg && <span className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-400">{msg}</span>}
      </div>
    </div>
  );
}

function AddLine({ shift, tz, onAdd }: { shift: ShiftWindow; tz: string; onAdd: (v: { at: number; text: string }) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[var(--color-accent)] hover:underline">
        <Plus className="w-3.5 h-3.5" /> Add a line (crane on site, hydro sold, shift change meeting…)
      </button>
    );
  }
  return <LineForm shift={shift} tz={tz} init={{ clock: "", text: "" }} onDone={(v) => { onAdd(v); setOpen(false); }} onCancel={() => setOpen(false)} />;
}
