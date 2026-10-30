"use client";

// DateTimePicker: when something happened. A date chip and a time chip.
// The date opens a month calendar (nothing after today; the planned day
// carries a dot). The time opens the wheels - hour, minute, AM or PM - in
// a sheet of their own, to spin or to type ("1130p"); nothing changes
// until Set. Picking a day with no time yet goes on to the wheels. Planned
// and Now fill both. Underneath, the shift the time falls on ("Mon night
// shift"), so 3 AM on Tuesday reads as Monday's night. Plant time. The
// value is "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" while the time isn't
// picked, or "".

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import { shiftAt, type ShiftTimes } from "@/lib/shiftReport";
import { fmtInTz, toDateTimeInput, fromDateTimeInput, dayKey } from "@/lib/scheduleTz";
import { parseTypedTime } from "@/lib/typedTime";
import { useJobStart } from "@/components/projects/JobStartContext";

const p2 = (n: number) => String(n).padStart(2, "0");
const ROW = 40;
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINS = Array.from({ length: 60 }, (_, i) => p2(i));
const AMPM = ["AM", "PM"];
/** "Mon, Oct 26" for a "YYYY-MM-DD". */
const dayWords = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
/** "10:30 PM" for "22:30". */
export const time12 = (hm: string) => { const h = Number(hm.slice(0, 2)); return `${h % 12 || 12}:${hm.slice(3, 5)} ${h < 12 ? "AM" : "PM"}`; };

/** "30 min", "2 h 15 min": how far ahead of now a picked time is. */
const aheadWords = (d: number) => { const m = Math.round(d / 60_000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };

export default function DateTimePicker({ label, value, onChange, tz, times, planned, shortcuts = [], showNow = true, disabled, hint, future = false }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  tz: string; times: ShiftTimes;
  /** The planned time: its day is dotted, and the wheels start there. */
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
  const [panel, setPanel] = useState<"date" | null>(null);
  const [wheels, setWheels] = useState(false);
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
    setPanel(null);
    if (!time) setWheels(true);
  };
  const openWheels = () => { setNowMs(Date.now()); setPanel(null); setWheels(true); };
  // The wheels open on its time, else the planned time of day, else now:
  // shown, not set until Set.
  const startHm = time || toDateTimeInput(hasPlan ? planned! : nowMs, tz).slice(11, 16);
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
        <button type="button" disabled={disabled} aria-haspopup="dialog" aria-label={`${label}: time`} onClick={openWheels} className={chip(wheels, !time)}>
          <Clock className="w-4 h-4 opacity-70" />{time ? time12(time) : "Pick time"}
        </button>
        {sh && (!future && t > nowMs + 60_000
          ? <span className="text-[12px] font-semibold text-amber-700 dark:text-amber-400">{aheadWords(t - nowMs)} from now</span>
          : <span className="text-[12px] text-[var(--color-text-muted)]" title="The shift this time counts for - not the date">{fmtInTz(sh.start, tz, { weekday: "short" })} {sh.kind} shift, {fmtInTz(sh.start, tz, { hour: "numeric", minute: "2-digit", hour12: true })} to {fmtInTz(sh.end, tz, { hour: "numeric", minute: "2-digit", hour12: true })}</span>)}
      </div>
      {date && firstDay && date < firstDay ? (
        <div className="text-[12px] font-semibold text-rose-700 dark:text-rose-400">Before the job started ({dayWords(firstDay)}). Pick the right day.</div>
      ) : early >= 2 && (
        <div className="text-[12px] font-semibold text-amber-700 dark:text-amber-400">{early} days before its planned day ({dayWords(plannedDay!)}). Check the day.</div>
      )}
      {panel === "date" && <Month value={date} today={today} planned={plannedDay} onPick={pickDay} future={future} earliest={firstDay} />}
      {wheels && <TimeSheet title={label} hm={time} start={startHm} onSet={(h, m) => { setTime(h, m); setWheels(false); }} onClose={() => setWheels(false)} />}
    </div>
  );
}

/** Just a time on the shift: a chip that opens the wheels. */
export function TimeChip({ value, onChange, tz, label = "Time" }: { value: string; onChange: (hm: string) => void; tz?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [startHm, setStartHm] = useState("");
  const show = () => { setStartHm(value || toDateTimeInput(Date.now(), tz ?? "UTC").slice(11, 16)); setOpen(true); };
  return (
    <>
      <button type="button" aria-haspopup="dialog" aria-label={label} onClick={show}
        className={`inline-flex items-center gap-1 h-7 px-2 rounded-md border text-[12px] font-semibold bg-[var(--color-surface)] ${value ? "border-[var(--color-border-strong)]" : "border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)]"}`}>
        <Clock className="w-3.5 h-3.5 opacity-70" />{value ? time12(value) : "Time"}
      </button>
      {open && <TimeSheet title={label} hm={value} start={startHm} onSet={(h, m) => { onChange(`${p2(h)}:${p2(m)}`); setOpen(false); }} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The time on wheels, in a sheet of its own: hour, minute, AM or PM, to
 *  spin (finger, mouse drag or scroll) or to type ("1130p"). Nothing is
 *  set until Set: the page behind doesn't move (no scroll going past can
 *  turn a wheel), the three wheels share one draft (spinning two at once
 *  can't undo either), and AM or PM sits on its own wheel, never guessed
 *  from typing. It opens on the time there is, else `start` - shown, not
 *  set. */
function TimeSheet({ title, hm, start, onSet, onClose }: { title: string; hm: string; start: string; onSet: (h: number, m: number) => void; onClose: () => void }) {
  const from = /^\d{2}:\d{2}/.test(hm) ? hm : start;
  const [d, setD] = useState(() => ({ h: Number(from.slice(0, 2)) % 12 || 12, m: Number(from.slice(3, 5)), pm: Number(from.slice(0, 2)) >= 12 }));
  const [typed, setTyped] = useState<string | null>(null);
  const bad = typed != null && typed.trim() !== "" && !parseTypedTime(typed);
  const shown = `${d.h}:${p2(d.m)} ${d.pm ? "PM" : "AM"}`;
  const set = () => { if (!bad) onSet((d.h % 12) + (d.pm ? 12 : 0), d.m); };
  const type = (v: string) => {
    setTyped(v);
    const r = v.trim() ? parseTypedTime(v) : null;
    if (r) setD({ h: r.h % 12 || 12, m: r.m, pm: r.h >= 12 });
  };
  const spun = (x: Partial<typeof d>) => { setTyped(null); setD((c) => ({ ...c, ...x })); };
  // Escape closes; the page behind stays where it is while it's open.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", k);
    const html = document.documentElement, was = html.style.overflow;
    html.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); html.style.overflow = was; };
  }, []);
  const [fine] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: fine)").matches);
  return createPortal(
    <div className="fixed inset-0 z-[400] bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="w-full sm:w-[340px] rounded-t-2xl sm:rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-xl px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[14px] font-bold">{title}</span>
          <input value={typed ?? shown} onChange={(e) => type(e.target.value)} onFocus={(e) => e.currentTarget.select()} autoFocus={fine}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); set(); } }}
            aria-label="Type the time" inputMode="text" autoComplete="off" spellCheck={false} enterKeyHint="done"
            className={`w-[118px] h-9 rounded-lg border px-2 text-right text-[17px] font-bold tabular-nums bg-[var(--color-surface)] focus:outline-none ${bad ? "border-rose-500" : "border-[var(--color-border-strong)] focus:border-[var(--color-accent-ring)]"}`} />
        </div>
        <div className="relative flex justify-center gap-2">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-10 rounded-lg bg-[var(--color-surface-2)]" />
          <Wheel label="Hour" items={HOURS} index={d.h - 1} onPick={(i) => spun({ h: i + 1 })} />
          <Wheel label="Minute" items={MINS} index={d.m} onPick={(i) => spun({ m: i })} />
          <Wheel label="AM or PM" items={AMPM} index={d.pm ? 1 : 0} onPick={(i) => spun({ pm: i === 1 })} />
        </div>
        <div className={`text-[11.5px] text-center ${bad ? "font-semibold text-rose-700 dark:text-rose-400" : "text-[var(--color-text-muted)]"}`}>
          {bad ? "Type it with its a or p: 1130p" : "Spin to the time, then Set. Or type it: 1130p"}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 h-11 rounded-xl border border-[var(--color-border-strong)] text-[14px] font-semibold">Cancel</button>
          <button type="button" onClick={set} disabled={bad} className="flex-[2] h-11 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[14px] font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">Set {shown}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One wheel: flick, drag or scroll it; it settles on the row in the band.
 *  A tap on a row picks it. What it picks goes to the draft, not the time. */
function Wheel({ label, items, index, onPick }: { label: string; items: string[]; index: number; onPick: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placed = useRef(false);
  // A mouse drag: where it started, how fast it's going.
  const drag = useRef<{ y: number; top: number; moved: boolean; lastY: number; lastT: number; v: number } | null>(null);
  const dragged = useRef(false);
  // Only a scroll the user made picks; the wheel rolling to a value set
  // elsewhere (typed) doesn't.
  const byUser = useRef(false);
  // Follow the draft: on opening (at once), then a typed time (rolled to).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || drag.current?.moved) return;
    const top = index * ROW;
    if (Math.abs(el.scrollTop - top) > 2) { byUser.current = false; el.scrollTo({ top, behavior: placed.current ? "smooth" : "auto" }); }
    placed.current = true;
  }, [index]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const clampI = (i: number) => Math.max(0, Math.min(items.length - 1, i));
  const settle = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = ref.current;
      if (!el || drag.current?.moved || !byUser.current) return;
      onPick(clampI(Math.round(el.scrollTop / ROW)));
    }, 120);
  };
  // Fingers and scroll wheels scroll it natively; a mouse drags it.
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    byUser.current = true;
    if (e.pointerType !== "mouse" || e.button !== 0 || !ref.current) return;
    drag.current = { y: e.clientY, top: ref.current.scrollTop, moved: false, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
    dragged.current = false;
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const dr = drag.current, el = ref.current;
    if (!dr || !el) return;
    const dy = e.clientY - dr.y;
    if (!dr.moved) {
      if (Math.abs(dy) < 4) return;
      dr.moved = true;
      el.setPointerCapture(e.pointerId);
      el.style.scrollSnapType = "none";
    }
    el.scrollTop = dr.top - dy;
    const dt = e.timeStamp - dr.lastT;
    if (dt > 0) dr.v = (e.clientY - dr.lastY) / dt;
    dr.lastY = e.clientY; dr.lastT = e.timeStamp;
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const dr = drag.current, el = ref.current;
    drag.current = null;
    if (!dr || !el || !dr.moved) return;
    dragged.current = true;
    el.style.scrollSnapType = "";
    // A flick carries on a little.
    const fling = e.timeStamp - dr.lastT < 80 ? dr.v * 250 : 0;
    const i = clampI(Math.round((el.scrollTop - fling) / ROW));
    el.scrollTo({ top: i * ROW, behavior: "smooth" });
    onPick(i);
  };
  const fade = "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,.35) 22%, #000 40%, #000 60%, rgba(0,0,0,.35) 78%, transparent 100%)";
  return (
    <div className="relative w-[72px]">
      <div ref={ref} onScroll={settle} role="listbox" aria-label={label} tabIndex={0}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onWheel={() => { byUser.current = true; }} onTouchStart={() => { byUser.current = true; }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); onPick(clampI(index + 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); onPick(clampI(index - 1)); }
        }}
        className="relative h-[200px] cursor-grab active:cursor-grabbing overflow-y-scroll overscroll-contain snap-y snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)] rounded-md"
        style={{ paddingBlock: ROW * 2, maskImage: fade, WebkitMaskImage: fade }}>
        {items.map((x, i) => (
          <div key={x} role="option" aria-selected={i === index} aria-label={`${label} ${x}`} onClick={() => { if (!dragged.current) onPick(i); dragged.current = false; }}
            className={`h-10 snap-center flex items-center justify-center text-[20px] tabular-nums select-none ${i === index ? "font-bold text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{x}</div>
        ))}
      </div>
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
