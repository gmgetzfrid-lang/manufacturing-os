"use client";

// DateTimePicker: when something happened. A date chip and a time box.
// The date opens a month calendar (nothing after today; the planned day
// carries a dot). Picking a day moves on to the time: a wheel of hour,
// minute and AM/PM to spin (finger, mouse drag or scroll), or type the
// time in the box and the wheel follows. Planned and Now fill both.
// Underneath, the shift the time falls on ("Mon night shift"), so 3 AM on
// Tuesday reads as Monday's night. Plant time. The value is
// "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" while the time isn't picked, or "".

import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CalendarDays, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import { shiftAt, type ShiftTimes } from "@/lib/shiftReport";
import { fmtInTz, toDateTimeInput, fromDateTimeInput, dayKey } from "@/lib/scheduleTz";
import { parseTypedTime } from "@/lib/typedTime";

const ROW = 36;
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINS = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
const AMPM = ["AM", "PM"];
const p2 = (n: number) => String(n).padStart(2, "0");
/** "Mon, Oct 26" for a "YYYY-MM-DD". */
const dayWords = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
/** "10:30 PM" for "22:30". */
export const time12 = (hm: string) => { const h = Number(hm.slice(0, 2)); return `${h % 12 || 12}:${hm.slice(3, 5)} ${h < 12 ? "AM" : "PM"}`; };

export default function DateTimePicker({ label, value, onChange, tz, times, planned, shortcuts = [], showNow = true, disabled, hint }: {
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
}) {
  // "Today" and the future, as of when it's opened, or when Now is tapped.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const today = dayKey(nowMs, tz);
  const [panel, setPanel] = useState<"date" | "time" | null>(null);
  const date = value.slice(0, 10), time = value.length >= 16 ? value.slice(11, 16) : "";
  const hasPlan = planned != null && Number.isFinite(planned);
  const plannedDay = hasPlan ? dayKey(planned!, tz) : null;

  const take = (at: number) => { onChange(toDateTimeInput(at, tz)); setPanel(null); };
  const now = () => { const t = Date.now(); setNowMs(t); take(t); };
  const pickDay = (d: string) => {
    setNowMs(Date.now());
    onChange(time ? `${d}T${time}` : d);
    setPanel("time");
  };
  // A time not picked yet starts at the planned time of day, or now.
  const openTime = () => {
    if (!time) {
      const t = Date.now(); setNowMs(t);
      const hm = toDateTimeInput(hasPlan ? planned! : t, tz).slice(11, 16);
      onChange(`${date || dayKey(t, tz)}T${hm}`);
    }
    setPanel("time");
  };
  const h24 = time ? Number(time.slice(0, 2)) : 0, mi = time ? Number(time.slice(3, 5)) : 0;
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
        {sh && (t > nowMs + 60_000
          ? <span className="text-[12px] font-semibold text-rose-700 dark:text-rose-400">in the future</span>
          : <span className="text-[12px] text-[var(--color-text-muted)]">{fmtInTz(sh.start, tz, { weekday: "short" })} {sh.kind} shift</span>)}
      </div>
      {panel === "date" && <Month value={date} today={today} planned={plannedDay} onPick={pickDay} />}
      {panel === "time" && (
        <div className="space-y-1">
          <TimeWheels h24={h24} mi={mi} onSet={setTime} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
          <div className="text-[11px] text-[var(--color-text-muted)]">Spin it, or type in the box: 1030p, 22:30</div>
        </div>
      )}
    </div>
  );
}

/** Just a time on the shift: a chip that opens the wheel. Opens on now. */
export function TimeChip({ value, onChange, tz, label = "Time" }: { value: string; onChange: (hm: string) => void; tz: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const h24 = value ? Number(value.slice(0, 2)) : 0, mi = value ? Number(value.slice(3, 5)) : 0;
  const set = (h: number, m: number) => onChange(`${p2(h)}:${p2(m)}`);
  const show = () => {
    if (!value) onChange(toDateTimeInput(Date.now(), tz).slice(11, 16));
    setOpen(true);
  };
  return (
    <div className="relative inline-block">
      <TimeBox value={value} label={label} open={open} onOpen={show} onSet={set} placeholder="Time"
        className={`relative z-50 inline-flex items-center gap-1 h-7 px-2 rounded-md border text-[12px] font-semibold bg-[var(--color-surface)] ${value ? "border-[var(--color-border-strong)]" : "border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`} />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <TimeWheels h24={h24} mi={mi} onSet={set} className="absolute left-0 top-full mt-1 z-50 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-lg" />
        </>
      )}
    </div>
  );
}

/** The time box: shows "10:30 PM". Tap it for the wheel; type in it
 *  ("1030p", "22:30") and the wheel follows. With a mouse it's ready to
 *  type at once; on a touch screen the first tap opens the wheel (no
 *  keyboard), a second tap types. */
function TimeBox({ value, label, open, onOpen, onSet, className, disabled, placeholder = "Pick time" }: {
  value: string; label: string; open: boolean; onOpen: () => void; onSet: (h: number, m: number) => void;
  className: string; disabled?: boolean; placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const ptr = useRef("");
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  // What it was before typing — put back if what's typed isn't a time.
  const before = useRef<string | null>(null);
  const pm = value ? Number(value.slice(0, 2)) >= 12 : false;
  const bad = draft != null && draft.trim() !== "" && !parseTypedTime(draft, pm);
  const startTyping = () => {
    flushSync(() => setTyping(true));
    const el = ref.current;
    if (el) { el.blur(); el.focus(); el.select(); }
  };
  return (
    <label className={`${className} cursor-text ${bad ? "!border-rose-500 !ring-rose-500" : ""}`}>
      <Clock className="w-4 h-4 shrink-0 opacity-70" />
      <input ref={ref} value={draft ?? (value ? time12(value) : "")} placeholder={placeholder} aria-label={label} disabled={disabled}
        readOnly={!typing} autoComplete="off" spellCheck={false} enterKeyHint="done" size={8}
        onPointerDown={(e) => { ptr.current = e.pointerType; }}
        // A mouse or the keyboard: ready to type.
        onFocus={() => { if (ptr.current !== "touch") setTyping(true); }}
        onClick={() => {
          if (!open) onOpen();
          if (ptr.current === "touch") { if (open && !typing) startTyping(); return; }
          // After the time it opens on is in.
          ref.current?.select();
          requestAnimationFrame(() => { if (before.current == null) ref.current?.select(); });
        }}
        onChange={(e) => {
          if (draft == null) before.current = value;
          setDraft(e.target.value);
          if (!open) onOpen();
          const r = parseTypedTime(e.target.value, pm);
          if (r) onSet(r.h, r.m);
        }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); ref.current?.blur(); } }}
        onBlur={() => {
          const b = before.current;
          if (bad && b) onSet(Number(b.slice(0, 2)), Number(b.slice(3, 5)));
          before.current = null; setDraft(null); setTyping(false); ptr.current = "";
        }}
        className="w-[70px] min-w-0 bg-transparent font-semibold outline-none placeholder:text-[var(--color-text-muted)] placeholder:font-semibold" />
    </label>
  );
}

/** Hour, minute, AM/PM. */
function TimeWheels({ h24, mi, onSet, className = "" }: { h24: number; mi: number; onSet: (h: number, m: number) => void; className?: string }) {
  return (
    <div className={`relative flex justify-center gap-1 py-1 px-1 w-fit max-w-full ${className}`}>
      <div className="pointer-events-none absolute inset-x-1 top-1/2 -translate-y-1/2 h-9 rounded-md bg-[var(--color-surface-2)]" />
      <Wheel label="Hour" items={HOURS} index={(h24 % 12 || 12) - 1} onPick={(i) => onSet(((i + 1) % 12) + (h24 >= 12 ? 12 : 0), mi)} />
      <Wheel label="Minute" items={MINS} index={mi} onPick={(i) => onSet(h24, i)} />
      <Wheel label="AM or PM" items={AMPM} index={h24 >= 12 ? 1 : 0} onPick={(i) => onSet((h24 % 12) + (i ? 12 : 0), mi)} />
    </div>
  );
}

/** A month to tap a day on: no days after today. */
function Month({ value, today, planned, onPick }: { value: string; today: string; planned: string | null; onPick: (d: string) => void }) {
  const from = value || today;
  const [ym, setYm] = useState(() => Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1);
  const y = Math.floor(ym / 12), mo = ym % 12;
  const lead = new Date(Date.UTC(y, mo, 1)).getUTCDay();
  const n = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const latest = ym >= Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  const key = (d: number) => `${y}-${p2(mo + 1)}-${p2(d)}`;
  const nav = "w-8 h-8 inline-flex items-center justify-center rounded-md hover:bg-[var(--color-surface-2)] disabled:opacity-30";
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 w-[280px] max-w-full">
      <div className="flex items-center justify-between mb-1">
        <button type="button" aria-label="Previous month" onClick={() => setYm(ym - 1)} className={nav}><ChevronLeft className="w-4 h-4" /></button>
        <span className="text-[13px] font-bold">{new Date(Date.UTC(y, mo, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</span>
        <button type="button" aria-label="Next month" disabled={latest} onClick={() => setYm(ym + 1)} className={nav}><ChevronRight className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-[10.5px] font-semibold text-[var(--color-text-muted)]">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i} className="py-1">{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: n }, (_, i) => {
          const k = key(i + 1), on = k === value, later = k > today;
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

/** One wheel: flick or tap; it settles on the row in the band. */
function Wheel({ label, items, index, onPick }: { label: string; items: string[]; index: number; onPick: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placed = useRef(false);
  // A mouse drag: where it started, how fast it's going.
  const drag = useRef<{ y: number; top: number; moved: boolean; lastY: number; lastT: number; v: number } | null>(null);
  const dragged = useRef(false);
  // A scroll the user made (finger, scroll wheel, keys) picks; the wheel
  // rolling to a value set elsewhere doesn't.
  const byUser = useRef(false);
  // Follow the value: Planned, Now, a tap, or a typed time.
  useEffect(() => {
    const el = ref.current;
    if (!el || drag.current?.moved) return;
    const top = index * ROW;
    if (Math.abs(el.scrollTop - top) > 2) { byUser.current = false; el.scrollTo({ top, behavior: placed.current ? "smooth" : "auto" }); }
    placed.current = true;
  }, [index]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const settle = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = ref.current;
      if (!el || drag.current?.moved || !byUser.current) return;
      const i = Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / ROW)));
      if (i !== index) onPick(i);
    }, 120);
  };
  const clampI = (i: number) => Math.max(0, Math.min(items.length - 1, i));
  // Fingers and scroll wheels scroll it natively; a mouse drags it.
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    byUser.current = true;
    if (e.pointerType !== "mouse" || e.button !== 0 || !ref.current) return;
    drag.current = { y: e.clientY, top: ref.current.scrollTop, moved: false, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
    dragged.current = false;
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current, el = ref.current;
    if (!d || !el) return;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dy) < 4) return;
      d.moved = true;
      el.setPointerCapture(e.pointerId);
      el.style.scrollSnapType = "none";
    }
    el.scrollTop = d.top - dy;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY; d.lastT = e.timeStamp;
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current, el = ref.current;
    drag.current = null;
    if (!d || !el || !d.moved) return;
    dragged.current = true;
    el.style.scrollSnapType = "";
    // A flick carries on a little.
    const fling = e.timeStamp - d.lastT < 80 ? d.v * 250 : 0;
    const i = clampI(Math.round((el.scrollTop - fling) / ROW));
    el.scrollTo({ top: i * ROW, behavior: "smooth" });
    if (i !== index) onPick(i);
  };
  const fade = "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,.35) 22%, #000 40%, #000 60%, rgba(0,0,0,.35) 78%, transparent 100%)";
  return (
    <div className="relative w-16">
      <div ref={ref} onScroll={settle} role="listbox" aria-label={label} tabIndex={0}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onWheel={() => { byUser.current = true; }} onTouchStart={() => { byUser.current = true; }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); onPick(Math.min(items.length - 1, index + 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); onPick(Math.max(0, index - 1)); }
        }}
        className="relative h-[180px] cursor-grab active:cursor-grabbing overflow-y-scroll overscroll-contain snap-y snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)] rounded-md"
        style={{ paddingBlock: ROW * 2, maskImage: fade, WebkitMaskImage: fade }}>
        {items.map((x, i) => (
          <div key={x} role="option" aria-selected={i === index} onClick={() => { if (!dragged.current) onPick(i); dragged.current = false; }}
            className={`h-9 snap-center flex items-center justify-center text-[18px] tabular-nums select-none ${i === index ? "font-bold text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{x}</div>
        ))}
      </div>
    </div>
  );
}
