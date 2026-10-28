"use client";

// StepCard — one step, opened from the calendar or the report. Kept to
// what's needed: the work order, crew and hours; planned against actual
// start and finish; one main button (Start, or Finish); when it happened
// (opens on now; a calendar and a time wheel for earlier, or Planned); an
// optional comment. The shift works itself out from the time. The last
// few things that happened sit underneath.

import React, { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Play, Check } from "lucide-react";
import type { Milestone, MilestoneNote, MilestoneStatus } from "@/types/schema";
import { workHours, type ShiftTimes } from "@/lib/shiftReport";
import { fmtInTz, toDateTimeInput, fromDateTimeInput } from "@/lib/scheduleTz";
import DateTimePicker from "@/components/projects/DateTimePicker";
import PctSlider from "@/components/projects/PctSlider";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { updateMilestoneNote } from "@/lib/milestones";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { describeChange } from "@/lib/timeLog";

/** What a change saves (the schedule's one save — ExecutionView.updateStep). */
export interface StepUpdate {
  status: MilestoneStatus;
  /** For work in progress: the new %. Null = as it is. */
  pct: number | null;
  /** A comment for the report — optional, except a hold's reason. */
  note: string;
  /** When it happened. */
  at: number;
  /** Why it's behind, when given. */
  why?: string;
}

type Action = "start" | "progress" | "finish" | "hold" | "resume" | "edit" | "reopen";
const ms = (v: unknown) => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));
const H = 3_600_000;

export default function StepCard({ m, wo, pct, hours, rows, notes, tz, times, now, canEdit, onUpdate, onFixTimes, onMoveDays }: {
  m: Milestone;
  wo?: string;
  pct: number;
  /** Work-hours ahead (+) / behind (−) of plan by now. */
  hours: number;
  /** Its progress log and its notes — what's happened. */
  rows: ProgressLogRow[];
  notes: MilestoneNote[];
  tz: string; times: ShiftTimes; now: number;
  canEdit: boolean;
  onUpdate?: (u: StepUpdate) => Promise<boolean>;
  /** Correct when it really started / finished. */
  onFixTimes?: (t: { start?: number | null; finish?: number | null }) => Promise<boolean>;
  onMoveDays?: (id: string, delta: number) => void;
}) {
  // "Sat 10:00 PM" this week; further off "Oct 24, 10:00 PM".
  const when = (t: number) => fmtInTz(t, tz, Math.abs(t - now) < 6 * 86_400_000
    ? { weekday: "short", hour: "numeric", minute: "2-digit", hour12: true }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

  const ps = startMsOf(m), pf = finishMsOf(m);
  const as = ms(m.actualStartAt), af = m.status === "completed" ? ms(m.actualAt) : NaN;
  const done = m.status === "completed", held = m.status === "on_hold" || m.status === "blocked";
  const started = done || m.status === "in_progress" || held || Number.isFinite(as);
  const allotted = Math.round((m.durationHours != null && m.durationHours > 0 ? m.durationHours : workHours(m, tz)) * 10) / 10;
  // One tag: how it stands against the plan.
  const tag = (() => {
    const d = done && Number.isFinite(af) ? af - pf : Number.isFinite(as) ? as - ps : Number.isFinite(ps) && now > ps ? now - ps : NaN;
    if (!Number.isFinite(d)) return null;
    const h = Math.abs(d) / H;
    if (h < 0.25) return { t: "on time", tone: "text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40" };
    const v = h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h * 10) / 10} h`;
    const what = done ? "finished" : Number.isFinite(as) ? "started" : "not started";
    return d > 0 ? { t: what === "not started" ? `${v} past planned start` : `${what} ${v} late`, tone: "text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-950/40" }
      : { t: `${what} ${v} early`, tone: "text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40" };
  })();

  // What's happened, newest first: started and finished at the times they
  // really happened (the step's actual times — the log's own time is when
  // it was typed in), progress and holds from the log, and each comment on
  // the event it came with.
  const history = useMemo(() => {
    const ev: Array<{ key: string; at: number; text: string; said: Array<{ text: string; note: MilestoneNote | null }> }> = [];
    if (Number.isFinite(as)) ev.push({ key: "start", at: as, text: "Started", said: [] });
    if (done && Number.isFinite(af)) ev.push({ key: "finish", at: af, text: "Finished", said: [] });
    // Each saved change, by when it was saved — a comment goes with the
    // change it was saved with.
    const saves: Array<{ at: number; key: string }> = [];
    for (const x of rows) {
      if (x.old_status == null || (x.old_status === x.new_status && Number(x.old_percent ?? 0) === Number(x.new_percent ?? 0))) continue;
      const savedAt = Date.parse(x.entered_at ?? x.at);
      // Starts and finishes are told by the actual times.
      if (x.new_status === "completed") { if (done) saves.push({ at: savedAt, key: "finish" }); continue; }
      if (x.new_status === "in_progress" && (x.old_status === "planned" || x.old_status === "missed")) { if (Number.isFinite(as)) saves.push({ at: savedAt, key: "start" }); continue; }
      const key = `r${x.at}${x.new_status}${x.new_percent}`;
      ev.push({ key, at: Date.parse(x.at), text: `${describeChange(x.old_status, x.old_percent, x.new_status, x.new_percent)}${x.new_status === "in_progress" ? ` · ${Number(x.new_percent ?? 0)}%` : ""}`, said: [] });
      saves.push({ at: savedAt, key });
    }
    const near = 10 * 60_000;
    for (const n of notes) {
      const body = n.body?.trim();
      if (!body || n.kind === "reschedule" || /^Progress → \d+%$/.test(body) || /^Actual times corrected/.test(body)) continue;
      if (n.kind === "status" && !(n.statusAt === "on_hold" || n.statusAt === "blocked")) continue;
      const at = ms(n.happenedAt ?? n.createdAt);
      if (!Number.isFinite(at)) continue;
      const line = { text: n.kind === "behind" ? `why behind: “${body}”` : `“${body}”`, note: n.kind === "note" && n.id ? n : null };
      const typed = ms(n.createdAt);
      const viaSave = saves.filter((x) => Math.abs(x.at - typed) <= near).sort((a, b) => Math.abs(a.at - typed) - Math.abs(b.at - typed))[0];
      const host = (viaSave ? ev.find((e) => e.key === viaSave.key) : undefined)
        ?? ev.filter((e) => Math.abs(e.at - at) <= near).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
      if (host) host.said.push(line); else ev.push({ key: `n${n.id ?? n.createdAt}`, at, text: "", said: [line] });
    }
    return ev.filter((e) => Number.isFinite(e.at)).sort((a, b) => b.at - a.at);
  }, [rows, notes, as, af, done]);
  const [allHistory, setAllHistory] = useState(false);

  const [action, setAction] = useState<Action | null>(null);
  const [atV, setAtV] = useState("");
  const [startV, setStartV] = useState("");
  const [p, setP] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [why, setWhy] = useState("");
  const [showWhy, setShowWhy] = useState(false);
  const [holdKind, setHoldKind] = useState<"on_hold" | "blocked">("on_hold");
  const [msg, setMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = (a: Action) => {
    setAction(a); setMsg(null); setSaved(null); setNote(""); setWhy(""); setShowWhy(false); setP(null);
    // Opens on now (entering it as it happens); earlier is a tap away.
    setAtV(a === "edit" ? (Number.isFinite(af) ? toDateTimeInput(af, tz) : "") : toDateTimeInput(Date.now(), tz));
    setStartV(a === "edit" && Number.isFinite(as) ? toDateTimeInput(as, tz) : "");
  };
  const toMs = (v: string) => { const iso = fromDateTimeInput(v, tz); return iso ? Date.parse(iso) : NaN; };
  const need = (v: string, what: string): number | string => {
    const t = v.length >= 16 ? toMs(v) : NaN;
    if (!Number.isFinite(t)) return `Pick ${what}${v ? " — the time" : ""}.`;
    if (t > Date.now() + 60_000) return "That time is in the future.";
    return t;
  };

  const save = async () => {
    if (!action || busy) return;
    const run = async (u: StepUpdate) => (onUpdate ? onUpdate(u) : false);
    const extra = showWhy && why.trim() ? { why: why.trim() } : {};
    let ok = false, said = "";
    setMsg(null);
    setBusy(true);
    try {
      if (action === "start" || action === "resume") {
        const t = need(atV, "when it started");
        if (typeof t === "string") { setMsg(t); return; }
        ok = await run({ status: "in_progress", pct: null, note: note.trim(), at: t, ...extra });
        said = `Started ${when(t)}`;
      } else if (action === "progress") {
        if (p == null || p === Math.round(pct)) { setMsg("Slide it to the new %."); return; }
        const t = need(atV, "when");
        if (typeof t === "string") { setMsg(t); return; }
        // 100% is finished.
        if (p >= 100) {
          if (Number.isFinite(as) && t < as) { setMsg(`It started ${when(as)} — it can't finish before that.`); return; }
          ok = await run({ status: "completed", pct: null, note: note.trim(), at: t, ...extra });
          said = `Finished ${when(t)}`;
        } else {
          ok = await run({ status: "in_progress", pct: p, note: note.trim(), at: t, ...extra });
          said = `${p}% at ${when(t)}`;
        }
      } else if (action === "finish") {
        const f = need(atV, "when it finished");
        if (typeof f === "string") { setMsg(f); return; }
        let s: number | null = null;
        if (!started && startV.length >= 16) {
          const t = need(startV, "when it started");
          if (typeof t === "string") { setMsg(t); return; }
          if (t > f) { setMsg("It can't finish before it started."); return; }
          s = t;
        }
        if (Number.isFinite(as) && f < as) { setMsg(`It started ${when(as)} — it can't finish before that.`); return; }
        // Not started yet: its start goes in first.
        if (s != null && !(await run({ status: "in_progress", pct: null, note: "", at: s }))) { setMsg("Not saved."); return; }
        ok = await run({ status: "completed", pct: null, note: note.trim(), at: f, ...extra });
        said = `Finished ${when(f)}`;
      } else if (action === "hold") {
        if (!note.trim()) { setMsg("Say why."); return; }
        const t = need(atV, "when it stopped");
        if (typeof t === "string") { setMsg(t); return; }
        ok = await run({ status: holdKind, pct: null, note: note.trim(), at: t });
        said = `${holdKind === "blocked" ? "Blocked" : "On hold"} ${when(t)}`;
      } else if (action === "reopen") {
        if (!note.trim()) { setMsg("Say why."); return; }
        const t = need(atV, "when");
        if (typeof t === "string") { setMsg(t); return; }
        ok = await run({ status: "in_progress", pct: p ?? 90, note: note.trim(), at: t });
        said = "Reopened";
      } else if (action === "edit") {
        if (!onFixTimes) return;
        const s = startV ? need(startV, "the start") : null;
        if (typeof s === "string") { setMsg(s); return; }
        const f = done ? (atV ? need(atV, "the finish") : null) : undefined;
        if (typeof f === "string") { setMsg(f); return; }
        if (s != null && f != null && f < s) { setMsg("The finish can't be before the start."); return; }
        ok = await onFixTimes({ start: s, ...(done ? { finish: f ?? null } : {}) });
        said = "Times fixed";
      }
      if (ok) { setSaved(said); setAction(null); } else setMsg((x) => x ?? "Not saved.");
    } catch (e) { setMsg((e as Error).message || "Not saved."); }
    finally { setBusy(false); }
  };

  // One main button; the rest are small.
  const main: { a: Action; label: string; icon: React.ReactNode } | null = !canEdit || !onUpdate ? null
    : done ? null : held ? { a: "resume", label: "Resume", icon: <Play className="w-3.5 h-3.5" /> }
      : started ? { a: "finish", label: "Finish", icon: <Check className="w-3.5 h-3.5" /> } : { a: "start", label: "Start", icon: <Play className="w-3.5 h-3.5" /> };
  const more: Array<{ a: Action; label: string }> = !canEdit || !onUpdate ? [] : [
    ...(started && !done && !held ? [{ a: "progress" as Action, label: "Update %" }] : []),
    ...(!started || held ? [{ a: "finish" as Action, label: "Finish" }] : []),
    ...(!done && !held ? [{ a: "hold" as Action, label: "Hold" }] : []),
    ...(started && onFixTimes ? [{ a: "edit" as Action, label: "Fix times" }] : []),
    ...(done ? [{ a: "reopen" as Action, label: "Reopen" }] : []),
  ].filter((x) => x.a !== main?.a);

  const cell = "py-0.5 pr-3 whitespace-nowrap";
  const shown = allHistory ? history : history.slice(0, 6);
  const pickLabel = action === "start" || action === "resume" ? "Started" : action === "finish" ? "Finished" : action === "hold" ? "Stopped" : action === "edit" ? "Finished" : "When";
  return (
    <div className="px-3 pb-3 pl-7 space-y-2 bg-[var(--color-surface)] text-[12.5px]">
      {m.description?.trim() && <div className="text-[var(--color-text-muted)] line-clamp-2 break-words">{m.description.trim()}</div>}
      <div className="text-[var(--color-text-muted)]">{[wo ? `WO ${wo}` : null, m.responsibleParty?.trim() || null, `${allotted} h`].filter(Boolean).join(" · ")}</div>
      <table className="text-[12.5px]">
        <thead><tr className="text-[11px] text-[var(--color-text-muted)]"><th /><th className={`${cell} text-left font-medium`}>Start</th><th className={`${cell} text-left font-medium`}>Finish</th></tr></thead>
        <tbody>
          <tr><td className={`${cell} text-[var(--color-text-muted)]`}>Plan</td><td className={cell}>{Number.isFinite(ps) ? when(ps) : "—"}</td><td className={cell}>{Number.isFinite(pf) ? when(pf) : "—"}</td></tr>
          <tr className="font-semibold"><td className={`${cell} font-normal text-[var(--color-text-muted)]`}>Actual</td><td className={cell}>{Number.isFinite(as) ? when(as) : "—"}</td><td className={cell}>{Number.isFinite(af) ? when(af) : held ? (m.status === "blocked" ? "blocked" : "on hold") : started ? `${pct}%` : "—"}</td></tr>
        </tbody>
      </table>
      {tag && <span className={`inline-block rounded px-1.5 py-0.5 text-[11.5px] font-bold ${tag.tone}`}>{tag.t}</span>}
      {held && m.statusReason && <div className="text-amber-800 dark:text-amber-300">“{m.statusReason}”</div>}
      {saved && <div role="status" className="font-semibold text-emerald-700 dark:text-emerald-400">✓ {saved}</div>}

      {(main || more.length > 0) && !action && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {main && (
            <button type="button" onClick={() => open(main.a)} className="inline-flex items-center gap-1 h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold hover:bg-[var(--color-accent-hover)]">
              {main.icon}{main.label}
            </button>
          )}
          {more.map((x) => <button key={x.a} type="button" onClick={() => open(x.a)} className="font-semibold text-[var(--color-accent)] hover:underline">{x.label}</button>)}
        </div>
      )}

      {action && (
        <div className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-2.5 space-y-2">
          {action === "progress" && <PctSlider value={p ?? Math.round(pct)} was={Math.round(pct)} onChange={(v) => { setP(v); setMsg(null); }} />}
          {action === "hold" && (
            <div className="flex gap-1">
              {([["on_hold", "On hold"], ["blocked", "Blocked"]] as const).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={holdKind === k} onClick={() => setHoldKind(k)}
                  className={`h-8 px-3 rounded-md border text-[12px] font-bold ${holdKind === k ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"}`}>{l}</button>
              ))}
            </div>
          )}
          {(action === "edit" || (action === "finish" && !started)) && (
            <DateTimePicker label="Started" hint={action === "finish" ? "(if known)" : undefined} value={startV} onChange={(v) => { setStartV(v); setMsg(null); }} tz={tz} times={times} planned={ps}
              shortcuts={[{ label: "Planned", at: ps }]} showNow={action !== "edit"} />
          )}
          {(action !== "edit" || done) && (
            <DateTimePicker label={pickLabel} value={atV} onChange={(v) => { setAtV(v); setMsg(null); }} tz={tz} times={times}
              planned={action === "finish" || action === "edit" ? pf : ps}
              shortcuts={[{ label: "Planned", at: action === "finish" || action === "edit" ? pf : action === "start" || action === "resume" ? ps : NaN }]}
              showNow={action !== "edit"} />
          )}
          {action !== "edit" && (
            <input value={note} onChange={(e) => { setNote(e.target.value); setMsg(null); }} onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
              placeholder={action === "hold" ? "Why? (required)" : action === "reopen" ? "Why reopen? (required)" : "Comment (optional)"} aria-label="Comment"
              className="h-9 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]" />
          )}
          {hours < -0.05 && !done && (action === "start" || action === "progress" || action === "finish" || action === "resume") && (
            showWhy
              ? <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why it's behind (optional)" aria-label="Why it's behind"
                className="h-9 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]" />
              : <button type="button" onClick={() => setShowWhy(true)} className="text-[11.5px] font-semibold text-[var(--color-accent)] hover:underline">+ Why it&apos;s behind</button>
          )}
          {msg && <div role="alert" className="font-semibold text-rose-700 dark:text-rose-400">{msg}</div>}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void save()} disabled={busy}
              className="h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold hover:bg-[var(--color-accent-hover)] disabled:opacity-60">{busy ? "Saving…" : action === "progress" && p === 100 ? "Save as finished" : "Save"}</button>
            <button type="button" onClick={() => setAction(null)} className="h-9 px-3 rounded-lg text-[var(--color-text-muted)] font-semibold hover:text-[var(--color-text)]">Cancel</button>
          </div>
        </div>
      )}

      <div className="border-t border-[var(--color-border)] pt-1.5">
        <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-0.5">History</div>
        {history.length === 0 ? <div className="text-[var(--color-text-muted)]">Nothing yet.</div> : (
          <ol className="space-y-0.5">
            {shown.map((x) => (
              <li key={x.key} className="text-[12px] break-words">
                <span className="text-[var(--color-text-muted)] mr-1.5 whitespace-nowrap">{when(x.at)}</span>
                {x.text && <b className="text-[var(--color-text)]">{x.text}</b>}
                {x.said.map((c, i) => <HistoryNote key={i} text={c.text} note={canEdit ? c.note : null} lead={!!x.text || i > 0} />)}
              </li>
            ))}
          </ol>
        )}
        {history.length > 6 && <button type="button" onClick={() => setAllHistory((v) => !v)} className="mt-0.5 text-[11.5px] font-semibold text-[var(--color-accent)] hover:underline">{allHistory ? "Less" : `All ${history.length}`}</button>}
      </div>

      {canEdit && onMoveDays && m.id && !started && (
        <div className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
          Move plan a day
          <button type="button" onClick={() => onMoveDays(m.id!, -1)} title="1 day earlier" className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--color-surface-2)]"><ChevronLeft className="w-3.5 h-3.5" /></button>
          <button type="button" onClick={() => onMoveDays(m.id!, 1)} title="1 day later" className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--color-surface-2)]"><ChevronRight className="w-3.5 h-3.5" /></button>
        </div>
      )}
    </div>
  );
}

/** A comment on an event — fixed in place. */
function HistoryNote({ text, note, lead }: { text: string; note: MilestoneNote | null; lead: boolean }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!note?.id || edit == null) return;
    if (!edit.trim()) { setErr("A comment can't be empty."); return; }
    setBusy(true);
    try { await updateMilestoneNote(note.id, edit); setEdit(null); setErr(null); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  if (edit != null) return (
    <span className="flex flex-wrap items-center gap-1 w-full mt-0.5">
      <input value={edit} autoFocus onChange={(e) => setEdit(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEdit(null); }}
        className="h-8 flex-1 min-w-[160px] rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12.5px]" aria-label="Edit comment" />
      <button type="button" disabled={busy} onClick={() => void save()} className="h-8 px-2.5 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[12px] font-bold">{busy ? "Saving…" : "Save"}</button>
      <button type="button" onClick={() => setEdit(null)} className="h-8 px-2 rounded-md text-[12px] text-[var(--color-text-muted)]">Cancel</button>
      {err && <span className="w-full text-rose-700 dark:text-rose-400">{err}</span>}
    </span>
  );
  return (
    <span className="text-[var(--color-text)]">{lead ? " — " : ""}{text}
      {note && <button type="button" onClick={() => setEdit((note.body ?? "").trim())} className="ml-1 text-[11px] font-semibold text-[var(--color-accent)] hover:underline">edit</button>}
    </span>
  );
}
