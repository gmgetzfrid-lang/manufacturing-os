"use client";

// DateTimePicker: when something happened. A date chip and a time box.
// The date opens a month calendar (nothing after today; the planned day
// carries a dot). Picking a day moves on to the time: tap the hour, the
// minutes and AM or PM, or type it in the box ("1130p"). Only a tap or a
// keystroke changes it: nothing scrolls, nothing is filled in on its own,
// and AM or PM is never guessed. Planned and Now fill both.
// Underneath, the shift the time falls on ("Mon night shift"), so 3 AM on
// Tuesday reads as Monday's night. Plant time. The value is
// "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" while the time isn't picked, or "".

import React, { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CalendarDays, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import { shiftAt, type ShiftTimes } from "@/lib/shiftReport";
import { fmtInTz, toDateTimeInput, fromDateTimeInput, dayKey } from "@/lib/scheduleTz";
import { parseTypedTime } from "@/lib/typedTime";
import { useJobStart } from "@/components/projects/JobStartContext";

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const p2 = (n: number) => String(n).padStart(2, "0");
/** "Mon, Oct 26" for a "YYYY-MM-DD". */
const dayWords = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
/** "10:30 PM" for "22:30". */
export const time12 = (hm: string) => { const h = Number(hm.slice(0, 2)); return `${h % 12 || 12}:${hm.slice(3, 5)} ${h < 12 ? "AM" : "PM"}`; };

export default function DateTimePicker({ label, value, onChange, tz, times, planned, shortcuts = [], showNow = true, disabled, hint, future = false }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  tz: string; times: ShiftTimes;
  /** The planned time: its day is dotted, and an unpicked time starts there. */
  planned?: number;
  /** One-tap fills, e.g. Planned. */
  shortcuts?: Array<{ label: string; at: number }>;
  showNow?: boolean;
  disabled?: boolean;
  /** Next to the label, e.g. "optional". */
  hint?: string;
  /** For planning: days after today can be picked. */
  future?: boolean;
}) {
  // "Today" and the future, as of when it's opened, or when Now is tapped.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const today = dayKey(nowMs, tz);
  const [panel, setPanel] = useState<"date" | "time" | null>(null);
  const date = value.slice(0, 10), time = value.length >= 16 ? value.slice(11, 16) : "";
  const hasPlan = planned != null && Number.isFinite(planned);
  const plannedDay = hasPlan ? dayKey(planned!, tz) : null;
  // When work happened: not before the job started.
  const jobStart = useJobStart();
  const firstDay = !future && jobStart != null ? dayKey(jobStart, tz) : null;
  const dayGap = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
  const early = !future && date && plannedDay ? dayGap(date, plannedDay) : 0;

  const take = (at: number) => { onChange(toDateTimeInput(at, tz)); setPanel(null); };
  const now = () => { const t = Date.now(); setNowMs(t); take(t); };
  const pickDay = (d: string) => {
    setNowMs(Date.now());
    onChange(time ? `${d}T${time}` : d);
    setPanel("time");
  };
  // Opening the time fills nothing in: the time is what's tapped.
  const openTime = () => setPanel("time");
  const setTime = (h: number, m: number) => { setNowMs(Date.now()); onChange(`${date || today}T${p2(h)}:${p2(m)}`); };

  const iso = time ? fromDateTimeInput(value, tz) : null;
  const t = iso ? Date.parse(iso) : NaN;
  const sh = Number.isFinite(t) ? shiftAt(t, tz, times) : null;
  const chip = (on: boolean, empty: boolean) => `inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border text-[13px] font-semibold disabled:opacity-50 ${on ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)] bg-[var(--color-surface)]" : empty ? "border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text-muted)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"}`;
  const small = "h-7 px-2.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12px] font-semibold hover:bg-[var(--color-surface-2)] disabled:opacity-50";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{label}{hint && <span className="ml-1 font-normal text-[var(--color-text-muted)]">{hint}</span>}</span>
        <span className="flex gap-1">
          {shortcuts.filter((x) => Number.isFinite(x.at)).map((x) => <button key={x.label} type="button" disabled={disabled} onClick={() => take(x.at)} className={small}>{x.label}</button>)}
          {showNow && <button type="button" disabled={disabled} onClick={now} className={small}>Now</button>}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" disabled={disabled} aria-expanded={panel === "date"} aria-label={`${label}: day`} onClick={() => setPanel((x) => (x === "date" ? null : "date"))} className={chip(panel === "date", !date)}>
          <CalendarDays className="w-4 h-4 opacity-70" />{date ? (date === today ? `Today, ${dayWords(date).split(", ")[1]}` : dayWords(date)) : "Pick day"}
        </button>
        <TimeBox value={time} label={`${label}: time`} open={panel === "time"} onOpen={openTime} onSet={setTime} disabled={disabled} className={chip(panel === "time", !time)} />
        {sh && (!future && t > nowMs + 60_000
          ? <span className="text-[12px] font-semibold text-rose-700 dark:text-rose-400">in the future</span>
          : <span className="text-[12px] text-[var(--color-text-muted)]">{fmtInTz(sh.start, tz, { weekday: "short" })} {sh.kind} shift</span>)}
      </div>
      {date && firstDay && date < firstDay ? (
        <div className="text-[12px] font-semibold text-rose-700 dark:text-rose-400">Before the job started ({dayWords(firstDay)}). Pick the right day.</div>
      ) : early >= 2 && (
        <div className="text-[12px] font-semibold text-amber-700 dark:text-amber-400">{early} days before its planned day ({dayWords(plannedDay!)}). Check the day.</div>
      )}
      {panel === "date" && <Month value={date} today={today} planned={plannedDay} onPick={pickDay} future={future} earliest={firstDay} />}
      {panel === "time" && (
        <div className="space-y-1">
          <TimeGrid hm={time} onSet={setTime} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
          <div className="text-[11px] text-[var(--color-text-muted)]">Tap the hour, minutes and AM or PM, or type it with its a or p: 1130p</div>
        </div>
      )}
    </div>
  );
}

/** Just a time on the shift: a chip that opens the hour, minutes and AM
 *  or PM to tap. Empty until they're tapped. */
export function TimeChip({ value, onChange, label = "Time" }: { value: string; onChange: (hm: string) => void; tz?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const set = (h: number, m: number) => onChange(`${p2(h)}:${p2(m)}`);
  const show = () => setOpen(true);
  return (
    <div className="relative inline-block">
      <TimeBox value={value} label={label} open={open} onOpen={show} onSet={set} placeholder="Time"
        className={`relative z-50 inline-flex items-center gap-1 h-7 px-2 rounded-md border text-[12px] font-semibold bg-[var(--color-surface)] ${value ? "border-[var(--color-border-strong)]" : "border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`} />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <TimeGrid hm={value} onSet={set} className="absolute left-0 top-full mt-1 z-50 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-lg" />
        </>
      )}
    </div>
  );
}

/** The time box: shows "10:30 PM". Tap it for the hour and minute buttons;
 *  type in it ("1030p", "22:30") and they follow. With a mouse it's ready
 *  to type at once; on a touch screen the first tap opens the buttons (no
 *  keyboard), a second tap types. */
function TimeBox({ value, label, open, onOpen, onSet, className, disabled, placeholder = "Pick time" }: {
  value: string; label: string; open: boolean; onOpen: () => void; onSet: (h: number, m: number) => void;
  className: string; disabled?: boolean; placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const ptr = useRef("");
  const [typing, setTyping] = useState(false);
  // A finger's first tap: no keyboard (the box takes no typing until the
  // second). A mouse or the keyboard is never held off.
  const [held, setHeld] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  // What it was before typing — put back if what's typed isn't a time.
  const before = useRef<string | null>(null);
  const bad = draft != null && draft.trim() !== "" && !parseTypedTime(draft);
  const startTyping = () => {
    flushSync(() => { setTyping(true); setHeld(false); });
    const el = ref.current;
    if (el) { el.blur(); el.focus(); el.select(); }
  };
  return (
    <label className={`${className} cursor-text ${bad ? "!border-rose-500 !ring-rose-500" : ""}`}>
      <Clock className="w-4 h-4 shrink-0 opacity-70" />
      <input ref={ref} value={draft ?? (value ? time12(value) : "")} placeholder={placeholder} aria-label={label} disabled={disabled}
        readOnly={held} autoComplete="off" spellCheck={false} enterKeyHint="done" size={8}
        onPointerDown={(e) => { ptr.current = e.pointerType; if (e.pointerType === "touch" && !typing) setHeld(true); }}
        // A mouse click: the whole time selected, so typing replaces it
        // (not a caret dropped in the middle of "2:00 AM").
        onMouseDown={(e) => {
          const el = ref.current;
          if (!el || ptr.current === "touch" || disabled) return;
          e.preventDefault(); el.focus(); el.select();
        }}
        // A mouse or the keyboard: ready to type.
        onFocus={() => { if (ptr.current !== "touch") setTyping(true); }}
        onClick={() => {
          if (!open) onOpen();
          if (ptr.current === "touch") { if (open && !typing) startTyping(); return; }
          // After the time it opens on is in.
          requestAnimationFrame(() => { if (before.current == null && document.activeElement === ref.current) ref.current?.select(); });
        }}
        onChange={(e) => {
          if (draft == null) before.current = value;
          setDraft(e.target.value);
          if (!open) onOpen();
          const r = parseTypedTime(e.target.value);
          if (r) onSet(r.h, r.m);
        }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); ref.current?.blur(); } }}
        onBlur={() => {
          const b = before.current;
          if (bad && b) onSet(Number(b.slice(0, 2)), Number(b.slice(3, 5)));
          before.current = null; setDraft(null); setTyping(false); setHeld(false); ptr.current = "";
        }}
        className="w-[70px] min-w-0 bg-transparent font-semibold outline-none placeholder:text-[var(--color-text-muted)] placeholder:font-semibold" />
    </label>
  );
}

/** Hour, minutes, AM or PM: buttons to tap. Nothing changes unless it's
 *  tapped (there's no wheel to catch a scroll going past). A time isn't
 *  set until it has its hour and its AM or PM; minutes start at :00. */
function TimeGrid({ hm, onSet, className = "" }: { hm: string; onSet: (h: number, m: number) => void; className?: string }) {
  const has = /^\d{2}:\d{2}/.test(hm);
  const [draft, setDraft] = useState<{ h: number | null; m: number; pm: boolean | null }>({ h: null, m: 0, pm: null });
  const cur = has ? { h: Number(hm.slice(0, 2)) % 12 || 12, m: Number(hm.slice(3, 5)), pm: Number(hm.slice(0, 2)) >= 12 } : draft;
  const put = (x: Partial<{ h: number; m: number; pm: boolean }>) => {
    const n = { ...cur, ...x };
    if (n.h != null && n.pm != null) onSet((n.h % 12) + (n.pm ? 12 : 0), n.m);
    else setDraft(n);
  };
  const cell = (on: boolean) => `h-9 rounded-md border text-[14px] font-semibold tabular-nums ${on ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`;
  return (
    <div className={`p-2 w-[288px] max-w-full space-y-1.5 ${className}`}>
      <div role="group" aria-label="Hour" className="grid grid-cols-6 gap-1">
        {HOURS.map((h) => <button key={h} type="button" aria-pressed={cur.h === h} aria-label={`${h} o'clock`} onClick={() => put({ h })} className={cell(cur.h === h)}>{h}</button>)}
      </div>
      <div role="group" aria-label="Minutes" className="grid grid-cols-6 gap-1">
        {MINUTES.map((m) => <button key={m} type="button" aria-pressed={cur.m === m} aria-label={`${p2(m)} minutes`} onClick={() => put({ m })} className={cell(cur.m === m)}>:{p2(m)}</button>)}
      </div>
      <div role="group" aria-label="AM or PM" className="grid grid-cols-2 gap-1">
        {[false, true].map((pm) => <button key={String(pm)} type="button" aria-pressed={cur.pm === pm} onClick={() => put({ pm })} className={cell(cur.pm === pm)}>{pm ? "PM" : "AM"}</button>)}
      </div>
      {cur.h != null && cur.pm == null && <div role="status" className="text-[12px] font-semibold text-amber-700 dark:text-amber-400">Pick AM or PM.</div>}
    </div>
  );
}

/** A month to tap a day on: no days after today (unless for planning). */
function Month({ value, today, planned, onPick, future, earliest }: { value: string; today: string; planned: string | null; onPick: (d: string) => void; future?: boolean; earliest?: string | null }) {
  const from = value || today;
  const [ym, setYm] = useState(() => Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1);
  const y = Math.floor(ym / 12), mo = ym % 12;
  const lead = new Date(Date.UTC(y, mo, 1)).getUTCDay();
  const n = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const latest = !future && ym >= Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  // No month, and no day, before the job started.
  const first = !!earliest && ym <= Number(earliest.slice(0, 4)) * 12 + Number(earliest.slice(5, 7)) - 1;
  const key = (d: number) => `${y}-${p2(mo + 1)}-${p2(d)}`;
  const nav = "w-8 h-8 inline-flex items-center justify-center rounded-md hover:bg-[var(--color-surface-2)] disabled:opacity-30";
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 w-[280px] max-w-full">
      <div className="flex items-center justify-between mb-1">
        <button type="button" aria-label="Previous month" disabled={first} onClick={() => setYm(ym - 1)} className={nav}><ChevronLeft className="w-4 h-4" /></button>
        <span className="text-[13px] font-bold">{new Date(Date.UTC(y, mo, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</span>
        <button type="button" aria-label="Next month" disabled={latest} onClick={() => setYm(ym + 1)} className={nav}><ChevronRight className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-[10.5px] font-semibold text-[var(--color-text-muted)]">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i} className="py-1">{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: n }, (_, i) => {
          const k = key(i + 1), on = k === value, later = (!future && k > today) || (!!earliest && k < earliest);
          return (
            <button key={k} type="button" disabled={later} aria-pressed={on} aria-label={dayWords(k)} onClick={() => onPick(k)}
              className={`relative mx-auto w-9 h-9 rounded-full text-[13px] tabular-nums ${on ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-bold" : later ? "text-[var(--color-text-faint)] opacity-40" : `hover:bg-[var(--color-surface-2)] ${k === today ? "font-bold text-[var(--color-accent)] ring-1 ring-inset ring-[var(--color-accent)]" : ""}`}`}>
              {i + 1}
              {k === planned && <span title="Planned" className={`absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${on ? "bg-[var(--color-accent-fg)]" : "bg-[var(--color-accent)]"}`} />}
            </button>
          );
        })}
      </div>
      {planned && <div className="mt-1 text-[10.5px] text-[var(--color-text-muted)]"><span className="inline-block w-1 h-1 rounded-full bg-[var(--color-accent)] align-middle mr-1" />planned day</div>}
    </div>
  );
}
