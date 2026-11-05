// quickUpdate - "Update by note": what a supervisor types or says about the
// job ("E-02 channel head is on the ground, they pulled it and washed it,
// staging to put it back") read into step updates for them to check.
//
// The AI only reads. It's given every open step on the job (whatever the
// schedule's order) and returns what the note reports, with the note's own
// words for each. Nothing is saved until the person has seen every line and
// tapped Save, and this file decides what can't be saved without them:
//
//   Which step   - the AI picks from the steps listed, by a key it was given.
//                  A step it can't be sure of comes back with the choices,
//                  and the person picks. Anything else it couldn't place is
//                  listed, never dropped.
//   What changed - started, a %, done, on hold, back on, a comment. A % only
//                  when it was said ("50", "about half") or the note's counts
//                  give it (37 out, 5 left = 88%); with none ("making
//                  progress") it goes on as under way with the words, the %
//                  left as it is - never guessed, never holding up Save.
//                  A step the note implies but doesn't name comes unticked.
//                  What's already in (done, further along) comes unticked,
//                  checked against the step as the earlier lines leave it.
//   When         - the time said, read by this file again, not taken on the
//                  AI's word: "2" with no AM or PM, two readings both in the
//                  past, is asked; "yesterday" must be yesterday; a time not
//                  come yet is an expectation (a comment), never done;
//                  "earlier" or "last night" with no time is asked; before
//                  the step started is asked. A log of a known shift (a
//                  pasted email, lib/emailShifts): its times are read in that
//                  shift ("4:30" on a day shift is PM) and "earlier" goes in
//                  at the end of it. No time said: the time chosen
//                  for the batch (now, the last shift, or a time picked), shown
//                  on every line. Times go to the nearest half hour, never
//                  later than now.

import type { Milestone, MilestoneStatus } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { leafPercent } from "@/lib/scheduleProgress";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { workOrderOfStep } from "@/lib/workOrderCrew";
import { fmtInTz, wallClockToMs, wallClock, dayKey, addDays } from "@/lib/scheduleTz";
import { shiftAt, previousShift, meetingLeadMin, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import type { SheetEvent } from "@/lib/shiftSheet";
import type { MilestoneNote } from "@/types/schema";
import { searchIndex } from "@/lib/fuzzySearch";

// ── The steps the AI picks from ──

export interface CatalogStep {
  /** The short key the AI answers with ("s12"): no ids to copy wrong. */
  key: string;
  id: string;
  wo: string;
  /** The work order's task and the tasks above the step ("V-01 - De-Butanizer Column"). */
  place: string;
  name: string;
  crew: string;
  status: MilestoneStatus;
  pct: number;
  planStart: number;
  planFinish: number;
  actStart: number | null;
  actFinish: number | null;
  /** Going around now: under way or held, planned around the notes' shift,
   *  or started or finished in the last day and a half. */
  live?: boolean;
  /** The first step not done on its work order. */
  next?: boolean;
  /** How the field described it lately (its latest comments). */
  said?: string[];
}

const ms = (v: unknown): number => (v == null || v === "" ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

/** Every step on the job (not cancelled), by work order in plan order, each
 *  with a short key. Done steps are listed too: a note can say something
 *  about one, and the AI must not mistake it for another. */
export function stepCatalog(milestones: Milestone[], progress?: Map<string, ProgressInfo>, o: {
  /** Now, the shift the notes are about, and the steps' comments - to say
   *  which steps are going (live), which is next on each work order, and
   *  how the field has been describing each one. */
  now?: number; window?: { start: number; end: number }; notes?: MilestoneNote[];
} = {}): CatalogStep[] {
  const live = milestones.filter((m) => !m.cancelledAt);
  const byId = new Map(live.filter((m) => m.id).map((m) => [m.id!, m]));
  const parents = new Set(live.map((m) => m.parentId).filter(Boolean));
  const leaves = live.filter((m) => m.id && !parents.has(m.id));
  const rows = leaves.map((m) => {
    const g = workOrderOfStep(m.id!, byId);
    const above: string[] = [];
    for (let p = m.parentId ? byId.get(m.parentId) : undefined, n = 0; p && n < 6; p = p.parentId ? byId.get(p.parentId) : undefined, n++) above.unshift(p.name);
    const owner = g?.owner && g.owner.id !== m.id ? g.owner.name : null;
    const place = owner ?? above[above.length - 1] ?? "";
    const pct = (m.id ? progress?.get(m.id)?.percent : undefined) ?? leafPercent(m);
    const a0 = ms(m.actualStartAt), a1 = m.status === "completed" ? ms(m.actualAt) : NaN;
    return {
      key: "", id: m.id!, wo: g?.wo ?? "", place, name: m.name, crew: m.responsibleParty?.trim() ?? "",
      status: m.status, pct: Math.round(pct), planStart: startMsOf(m), planFinish: finishMsOf(m),
      actStart: Number.isFinite(a0) ? a0 : null, actFinish: Number.isFinite(a1) ? a1 : null,
    } as CatalogStep;
  });
  rows.sort((a, b) => (a.wo || "~").localeCompare(b.wo || "~", "en", { numeric: true }) || a.place.localeCompare(b.place) || a.planStart - b.planStart || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.key = `s${i + 1}`; });
  if (o.now != null) {
    const now = o.now, H = 3_600_000;
    // The notes' shift, or the last 12 hours and the next 4.
    const w = o.window ?? { start: now - 12 * H, end: now + 4 * H };
    const near = (t: number | null) => t != null && t >= w.start - 6 * H && t <= Math.min(w.end, now) + H;
    const seenWo = new Set<string>();
    for (const r of rows) {
      const open = r.status !== "completed" && r.pct < 100;
      r.live = r.status === "in_progress" || r.status === "on_hold" || r.status === "blocked"
        || (open && r.planStart < w.end && r.planFinish > w.start)
        || near(r.actStart) || near(r.actFinish);
      const g = r.wo || r.place;
      if (open && !seenWo.has(g)) { r.next = true; seenWo.add(g); }
    }
  }
  if (o.notes?.length) {
    const recent = (o.now ?? Date.now()) - 5 * 86_400_000;
    const by = new Map<string, MilestoneNote[]>();
    for (const n of o.notes) {
      if (n.kind !== "note" || !n.body?.trim()) continue;
      const t = ms(n.happenedAt ?? n.createdAt);
      if (!(t >= recent)) continue;
      by.set(n.milestoneId, [...(by.get(n.milestoneId) ?? []), n]);
    }
    for (const r of rows) {
      const ns = (by.get(r.id) ?? []).sort((a, b) => ms(b.happenedAt ?? b.createdAt) - ms(a.happenedAt ?? a.createdAt)).slice(0, 2);
      if (ns.length) r.said = ns.map((n) => (n.body ?? "").trim().replace(/\s+/g, " ").slice(0, 90));
    }
  }
  return rows;
}

const clock = (t: number, tz: string) => fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const STATE: Record<string, string> = { planned: "not started", in_progress: "in progress", completed: "done", on_hold: "on hold", blocked: "blocked", missed: "missed" };

/** The steps as the AI reads them, one line each. */
export function catalogText(cat: CatalogStep[], tz: string): string {
  return cat.map((c) => [
    c.key,
    c.wo ? `WO ${c.wo}` : "no WO",
    c.place ? `${c.place} > ${c.name}` : c.name,
    c.crew || "no crew",
    `${STATE[c.status] ?? c.status} ${c.pct}%`,
    Number.isFinite(c.planStart) ? `plan ${clock(c.planStart, tz)} to ${clock(c.planFinish, tz)}` : "",
    c.actStart != null ? `started ${clock(c.actStart, tz)}` : "",
    c.actFinish != null ? `done ${clock(c.actFinish, tz)}` : "",
    c.live ? "LIVE" : "",
    c.next ? "NEXT" : "",
    c.said?.length ? `said lately: ${c.said.map((x) => `"${x.replace(/"/g, "'")}"`).join("; ")}` : "",
  ].filter(Boolean).join(" | ")).join("\n");
}

// ── What the AI is asked ──

export const QUICK_SYSTEM = [
  "You read a turnaround supervisor's field notes and say which steps on their schedule each part reports on, and what it reports. You only read: a person checks everything you return before anything is saved.",
  "Work is done out of order. Never assume the schedule's order or dates say what was worked. Match by what the note says: equipment tags (V-01, V1 and V-1 are the same tag; E-2 is E-02), WO numbers, step words, crews.",
  "Use only step keys from the list (s1, s2...). Never invent a step. If you can't place a part, put it in unplaced.",
  "Notes are often short and vague (\"pulled the bundle\", \"blinds in\", \"head's off\", \"hydro passed\"). To find the step: (1) the equipment or WO named in that part; (2) if none, the equipment named earlier in the note (a log usually keeps talking about the last thing named until it names another) - then copy those earlier words into context; (3) the crew named; (4) steps marked LIVE (going now) and NEXT (next up on its work order) are the likely ones; (5) the \"said lately\" words show how the field describes each step.",
  "Notes are often speech-to-text from a loud plant. Tags and numbers come out as words or sound-alikes: E-2 as \"e two\", \"echo two\", \"eat two\", \"me too\" or \"mee too\"; V-1 as \"v one\", \"victor one\", \"be one\"; PSV as \"p s v\"; numbers as words (\"two oh nine\" = 209). When you read words like that as a tag, put them in heard: {\"said\": the words as written, \"as\": the tag}. Words the person uses are listed under \"This person's words\" when known: they mean what they say there.",
  "basis: \"named\" (this part names the equipment, WO or a step only one piece of equipment has), \"context\" (named earlier in the note: put those exact words in context), \"only\" (the words fit one open step on the whole job), \"group\" (it says the same thing about several steps: \"all four bottles\", \"3 of 4 compressor bottles\", \"both bundles\" - give no step and every step it covers in candidates), \"guess\" (more than one step fits). For guess, give no step: put every step that fits in candidates, likeliest first, up to 6. Never pick between two pieces of equipment that both have the step (Pull Bundle on E-02 and on E-22) unless the note says which.",
  "When a WO number in the note and the equipment named disagree (WO# 310357 -V-4- when 310357 is V-03's), go by the equipment and say so in comment.",
  "Actions: start, progress, done, hold (with its reason), resume (back on after a hold), comment.",
  "percent: only when the note gives an amount. percentFrom: \"said\" for a percent (\"50\", \"50%\"), \"words\" for an amount in words (\"about half\" = 50, \"almost done\" = 90), \"counts\" for counts of the step's own things (\"37 total removed\" with \"5 remaining\" = 37 of 42 = 88; \"6 of 8 bundles\" = 75). A count alone is not a percent: \"5 trays out\" with no total is percent null. A step described but with no amount (\"making progress\", \"staging\", \"working on it\") is progress with percent null, percentFrom \"guess\" and your best suggestion in suggest. Finished, complete, done, removed, pulled, washed (when the step is that action) = done.",
  "implied: true for a step the note doesn't name but must be finished for what it says to be true (washed the head means the head was removed). Only direct prerequisites, never more.",
  "A log with a shift named above it: every time written is in that shift (\"4:30\" on a 6 AM to 6 PM day shift is 4:30 PM). Lines under \"Work Completed\" with no time happened during that shift: kind none.",
  "when: copy the note's exact words about time into words (null if none). kind: \"none\" (no time words; \"already\" alone is none), \"clock\" (a time of day: 2pm, at 2, 0730, noon), \"day\" (a day with or without a time: yesterday at 3, Monday night, last night at 11), \"relative\" (2 hours ago, an hour ago), \"unclear\" (past with no time to place it: earlier, this morning, last night, yesterday, before lunch), \"future\" (not happened yet: will be done in a couple hours, should finish by 2, tonight they'll start). local: your reading as \"YYYY-MM-DD HH:MM\" in plant time, given now; null for none, unclear and future.",
  "evidence: the exact words from the note this update comes from. comment: anything else the note says about the step worth keeping (a reason, what they're waiting on), in the note's words.",
  "Return STRICT JSON only: {\"updates\":[{\"step\":\"s12\",\"candidates\":[],\"basis\":\"named\",\"context\":null,\"heard\":null,\"action\":\"done\",\"percent\":null,\"percentFrom\":null,\"suggest\":null,\"reason\":null,\"comment\":null,\"implied\":false,\"evidence\":\"...\",\"when\":{\"words\":null,\"kind\":\"none\",\"local\":null}}],\"unplaced\":[{\"text\":\"...\",\"why\":\"...\"}]}",
].join("\n");

export function quickUserPrompt(o: { note: string; catalog: string; now: number; tz: string; shift: string; notesFrom?: string; words?: Array<{ said: string; as: string }> }): string {
  return [
    ...(o.words?.length ? [`This person's words: ${o.words.slice(0, 40).map((w) => `"${w.said}" = ${w.as}`).join("; ")}.`] : []),
    `Now: ${clock(o.now, o.tz)} (plant time, ${o.tz}). ${o.shift}`,
    o.notesFrom ?? "The note is about now: a time without a date is the last time it came round (today, or last night).",
    "",
    "Steps on the job (key | WO | work order > step | crew | state | plan | actual):",
    o.catalog,
    "",
    "The note:",
    o.note.trim(),
  ].join("\n");
}

// ── What comes back ──

type Action = "start" | "progress" | "done" | "hold" | "resume" | "comment";
const ACTIONS: Action[] = ["start", "progress", "done", "hold", "resume", "comment"];
type TimeKind = "none" | "clock" | "day" | "relative" | "unclear" | "future";
const KINDS: TimeKind[] = ["none", "clock", "day", "relative", "unclear", "future"];

export type Basis = "named" | "context" | "only" | "group" | "guess";
export interface RawUpdate {
  step: string | null; candidates: string[]; action: Action;
  /** How the AI found the step, and the earlier words it used. */
  basis: Basis | null; context: string | null;
  /** Words read as a tag ("mee too" as E-2): speech-to-text in the noise. */
  heard: { said: string; as: string } | null;
  percent: number | null; percentFrom: "said" | "words" | "counts" | "guess" | null; suggest: number | null;
  reason: string | null; comment: string | null; implied: boolean; evidence: string;
  when: { words: string | null; kind: TimeKind; local: string | null };
}
export interface RawReply { updates: RawUpdate[]; unplaced: Array<{ text: string; why: string }> }

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** The AI's reply, shaped and cleaned: anything malformed is dropped from
 *  updates and listed as unplaced (never lost). */
export function parseReply(raw: unknown): RawReply {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const updates: RawUpdate[] = [];
  const unplaced: RawReply["unplaced"] = [];
  for (const u of Array.isArray(o.updates) ? o.updates : []) {
    const x = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
    const action = ACTIONS.includes(x.action as Action) ? (x.action as Action) : null;
    const evidence = str(x.evidence) ?? "";
    if (!action) { if (evidence) unplaced.push({ text: evidence, why: "Not sure what it says happened." }); continue; }
    const w = (x.when && typeof x.when === "object" ? x.when : {}) as Record<string, unknown>;
    const pf = x.percentFrom === "said" || x.percentFrom === "words" || x.percentFrom === "counts" || x.percentFrom === "guess" ? x.percentFrom : null;
    updates.push({
      step: str(x.step), candidates: Array.isArray(x.candidates) ? x.candidates.map(str).filter((c): c is string => !!c) : [],
      basis: x.basis === "named" || x.basis === "context" || x.basis === "only" || x.basis === "group" || x.basis === "guess" ? x.basis : null, context: str(x.context),
      heard: (() => { const h = (x.heard && typeof x.heard === "object" ? x.heard : null) as Record<string, unknown> | null; const said = str(h?.said), as = str(h?.as); return said && as ? { said, as } : null; })(),
      action, percent: num(x.percent), percentFrom: pf, suggest: num(x.suggest),
      reason: str(x.reason), comment: str(x.comment), implied: x.implied === true, evidence,
      when: { words: str(w.words), kind: KINDS.includes(w.kind as TimeKind) ? (w.kind as TimeKind) : "none", local: str(w.local) },
    });
  }
  for (const p of Array.isArray(o.unplaced) ? o.unplaced : []) {
    const x = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const text = str(x.text);
    if (text) unplaced.push({ text, why: str(x.why) ?? "Couldn't match it to a step." });
  }
  return { updates, unplaced };
}

// ── Times ──

const HALF = 30 * 60_000;
/** To the nearest half hour, never later than now - and, given the shift
 *  times, never into another shift (5:45 AM on a night log stays 5:30 AM,
 *  not 6:00 AM on the day shift). */
export function roundTime(t: number, now: number, keep?: { tz: string; times: ShiftTimes }): number {
  const r = Math.round(t / HALF) * HALF;
  const down = Math.floor(t / HALF) * HALF;
  if (r > now) return down;
  if (keep && r !== down && shiftAt(r, keep.tz, keep.times).start !== shiftAt(t, keep.tz, keep.times).start) return down;
  return r;
}

/** "2026-11-03 14:00" in plant time. */
export function localToMs(s: string | null, tz: string): number {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(s.trim()) : null;
  if (!m) return NaN;
  return wallClockToMs({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: 0 }, tz);
}

/** The words settle AM or PM: "2pm", "2 p.m.", "7:30a", a 24-hour time
 *  ("0730", "1430", "14:30"), noon, midnight, morning, afternoon, evening. */
export function hasMeridiem(w: string): boolean {
  return /\d\s*[ap]\.?\s*m?\.?(?![a-z])/i.test(w)
    || /\b(noon|midnight|morning|afternoon|evening)\b/i.test(w)
    || /\b([01]\d|2[0-3])[0-5]\d\b/.test(w)
    || /\b(0\d|1[3-9]|2[0-3]):[0-5]\d\b/.test(w);
}

/** The hour and minute the words say, when they say them plainly ("2pm",
 *  "2:30 pm", "1430", "0730", "noon"). Null when they don't. */
export function saidClock(w: string): { h: number; m: number } | null {
  const lw = w.toLowerCase();
  if (/\bnoon\b/.test(lw)) return { h: 12, m: 0 };
  if (/\bmidnight\b/.test(lw)) return { h: 0, m: 0 };
  let x = /(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m?\.?(?![a-z])/.exec(lw);
  if (x) { const h = Number(x[1]) % 12 + (x[3] === "p" ? 12 : 0); return h < 24 ? { h, m: Number(x[2] ?? 0) } : null; }
  x = /\b([01]\d|2[0-3]):?([0-5]\d)\b/.exec(lw);
  if (x && (x[0].length === 4 || /^(0\d|1[3-9]|2[0-3])/.test(x[0]))) return { h: Number(x[1]), m: Number(x[2]) };
  return null;
}

export interface TimeCtx {
  now: number; tz: string; times: ShiftTimes;
  /** The shift the notes are a log of (picked, or from a file): times with
   *  no date are in it. Unset: the notes are about now. */
  window?: ShiftWindow;
}

export type TimeRead =
  | { at: number; from: "said" | "default" }
  | { ask: "ampm"; options: [number, number]; why: string }
  | { ask: "time"; why: string }
  | { future: true };

/** The time an update happened, from the note's words and the AI's reading. */
export function readTime(when: RawUpdate["when"], defaultAt: number, ctx: TimeCtx): TimeRead {
  const { now, tz } = ctx;
  const words = when.words ?? "";
  if (when.kind === "future") return { future: true };
  if (when.kind === "none" && !words) return { at: defaultAt, from: "default" };
  // A log of a known shift: "earlier", or a day with no time, happened in
  // that shift - it goes in at that shift's time, not asked.
  if (ctx.window && (when.kind === "unclear" || (when.kind === "none" && words) || (when.kind === "day" && !/\d|noon|midnight/.test(words.toLowerCase())))) return { at: defaultAt, from: "default" };
  if (when.kind === "unclear" || (when.kind === "none" && words)) return { ask: "time", why: `You said “${words || "earlier"}” but not when.` };
  const L = localToMs(when.local, tz);
  if (!Number.isFinite(L)) return { ask: "time", why: `Couldn't read a time from “${words}”.` };
  const soon = now + 5 * 60_000;
  const lw = words.toLowerCase();
  // The AI's reading checked against the words: "2pm" must read 2:00 PM.
  const plain = saidClock(words);
  if (plain) {
    const w = fmtInTz(L, tz, { hour: "numeric", minute: "2-digit", hour12: false }).split(":").map((x) => Number(x.replace(/\D/g, "")));
    if ((w[0] % 24) !== plain.h || w[1] !== plain.m) return { ask: "time", why: `Couldn't be sure of “${words}”. Pick the time.` };
  }
  // A day with no time of day ("yesterday", "Monday"): asked.
  if (when.kind === "day" && !/\d|noon|midnight/.test(lw)) return { ask: "time", why: `You said “${words}” but not what time.` };
  // A log of a shift: a clock time is in that shift ("0200" on a night log
  // is 2 AM that night). Not in it, or in it twice (AM and PM): asked.
  const win = ctx.window;
  if (win && when.kind === "clock") {
    const wc = wallClock(L, tz);
    const hm = plain ?? { h: wc.hour, m: wc.minute };
    const hours = plain || hasMeridiem(words) ? [hm.h] : [hm.h % 12, (hm.h % 12) + 12];
    const inShift: number[] = [];
    for (const day of [dayKey(win.start, tz), dayKey(win.end - 1, tz)]) {
      const [y, mo, d] = day.split("-").map(Number);
      for (const h of hours) {
        const t = wallClockToMs({ year: y, month: mo, day: d, hour: h, minute: hm.m, second: 0 }, tz);
        if (t >= win.start && t < win.end && !inShift.includes(t)) inShift.push(t);
      }
    }
    if (inShift.length === 1) return inShift[0] > soon ? { future: true } : { at: roundTime(inShift[0], now, ctx), from: "said" };
    // Just outside it (the 5:30 meeting before a 6:00 start): the one reading
    // within an hour and a half of the shift, kept inside it.
    if (inShift.length === 0) {
      const near: number[] = [];
      for (const day of [dayKey(win.start, tz), dayKey(win.end - 1, tz)]) {
        const [y, mo, d] = day.split("-").map(Number);
        for (const h of hours) {
          const t = wallClockToMs({ year: y, month: mo, day: d, hour: h, minute: hm.m, second: 0 }, tz);
          if (t >= win.start - 90 * 60_000 && t < win.end + 90 * 60_000 && !near.includes(t)) near.push(t);
        }
      }
      if (near.length === 1) { const t = Math.min(win.end - 60_000, Math.max(win.start, near[0])); return t > soon ? { future: true } : { at: roundTime(t, now, ctx), from: "said" }; }
    }
    if (inShift.length === 2) return { ask: "ampm", options: [roundTime(Math.min(...inShift), now, ctx), roundTime(Math.max(...inShift), now, ctx)] as [number, number], why: `“${words}”: AM or PM?` };
    return { ask: "time", why: `“${words}” isn't in the shift these notes are from. Pick the time.` };
  }
  if (win && (L < win.start - 3_600_000 || L > win.end + 3_600_000)) return { ask: "time", why: `“${words}” (${clock(L, tz)}) is outside the shift these notes are from. Pick the time.` };
  // The day words must agree with the reading ("yesterday" is yesterday).
  const today = dayKey(now, tz), yest = dayKey(addDays(now, -1, tz), tz), d = dayKey(L, tz);
  const hour = Number(fmtInTz(L, tz, { hour: "numeric", hour12: false }).replace(/\D/g, "")) % 24;
  const cur = shiftAt(now, tz, ctx.times);
  const night = cur.kind === "night" ? cur : previousShift(cur, tz, ctx.times);
  const nightBefore = previousShift(previousShift(night, tz, ctx.times), tz, ctx.times);
  const wrong =
    (/\blast night\b/.test(lw) && !(L >= nightBefore.start && L <= night.end && shiftAt(L, tz, ctx.times).kind === "night"))
    || (/\byesterday\b/.test(lw) && !/\bnight\b/.test(lw) && d !== yest)
    || (/\bthis morning\b/.test(lw) && !(d === today && hour < 12))
    || (/\btoday\b/.test(lw) && d !== today)
    || (/\bthis afternoon\b/.test(lw) && !(d === today && hour >= 12 && hour < 18));
  if (wrong) return { ask: "time", why: `“${words}” and the time read (${clock(L, tz)}) don't line up. Pick the time.` };
  // A clock time with no AM or PM: the last time it was AM and the last time
  // it was PM are both past, so it's asked, never picked.
  if (when.kind === "clock" && !hasMeridiem(words)) {
    const H = 3_600_000;
    const past = [L + 12 * H, L, L - 12 * H, L - 24 * H].filter((t) => t <= soon).sort((a, b) => b - a).slice(0, 2);
    if (past.length === 2) return { ask: "ampm", options: [roundTime(past[1], now, ctx), roundTime(past[0], now, ctx)] as [number, number], why: `“${words}”: AM or PM?` };
  }
  // Not come yet: what's expected, never entered as done.
  if (L > soon) return { future: true };
  if (L < now - 14 * 86_400_000) return { ask: "time", why: `“${words}” reads as more than two weeks ago. Pick the time.` };
  return { at: roundTime(L, now, ctx), from: "said" };
}

/** The times offered for updates with no time said: now, the end of the
 *  last shift (when its turnover meeting started), and the start of this one. */
export function defaultTimes(ctx: TimeCtx): Array<{ id: "window" | "now" | "last" | "start"; at: number; label: string }> {
  const { now, tz, times } = ctx;
  const cur: ShiftWindow = shiftAt(now, tz, times);
  const prev = previousShift(cur, tz, times);
  const name = (w: ShiftWindow) => `${fmtInTz(w.start, tz, { weekday: "short" })} ${w.kind}`;
  const lastAt = roundTime(prev.end - meetingLeadMin(times) * 60_000, now);
  const w = ctx.window;
  // Notes from an earlier shift: its end (its turnover) comes first.
  if (w && w.end <= now && w.start !== prev.start) {
    const at = roundTime(w.end - meetingLeadMin(times) * 60_000, now);
    return [
      { id: "window", at, label: `End of that shift (${name(w)}), ${clock(at, tz)}` },
      { id: "now", at: roundTime(now, now), label: `Now, ${clock(roundTime(now, now), tz)}` },
    ];
  }
  if (w && w.start === prev.start) {
    return [
      { id: "last", at: lastAt, label: `End of last shift (${name(prev)}), ${clock(lastAt, tz)}` },
      { id: "now", at: roundTime(now, now), label: `Now, ${clock(roundTime(now, now), tz)}` },
    ];
  }
  return [
    { id: "now", at: roundTime(now, now), label: `Now, ${clock(roundTime(now, now), tz)}` },
    { id: "last", at: lastAt, label: `Last shift (${name(prev)}), ${clock(lastAt, tz)}` },
    { id: "start", at: cur.start, label: `Start of this shift, ${clock(cur.start, tz)}` },
  ];
}

// ── The lines to check ──

export interface QuickLine {
  id: string;
  stepId: string | null;
  /** The steps it could be, when the AI wasn't sure (ids). */
  options: string[];
  action: Action;
  percent: number | null;
  percentFrom: RawUpdate["percentFrom"];
  suggest: number | null;
  reason: string | null;
  comment: string | null;
  /** The note's own words. */
  evidence: string;
  implied: boolean;
  /** When: the time it goes in at (null while asked), where it came from. */
  at: number | null;
  timeFrom: "said" | "default" | "picked" | null;
  timeWords: string | null;
  ampm?: [number, number];
  timeWhy?: string;
  /** Not happened yet: kept as a comment, not entered as done. */
  expected: boolean;
  include: boolean;
  /** How the step was found: named in these words, named earlier in the
   *  note (`context`, its words), the only step by that name, or by meaning
   *  (no word in common with the step's name: check it). */
  found?: "named" | "context" | "only" | "meaning";
  context?: string | null;
  /** Why it's asked which step ("doesn't say which equipment"). */
  unsure?: string;
  /** The words given aren't in the note: never saved as is. */
  notInNote?: boolean;
  /** Words read as a tag ("mee too" as E-2), the step it pointed to, and
   *  whether this person's words already say so (learned). */
  heard?: { said: string; as: string; stepId: string; known: boolean };
  /** The comment that goes on the step, as edited (null: none). Unset: the
   *  note's own words. */
  noteText?: string | null;
  /** Put in by hand on the check screen. */
  added?: boolean;
  /** It changes nothing (the step is already there): left out, words kept
   *  if ticked. The reason, said plainly. */
  already?: string;
  /** The note's WO number isn't this step's: what it was, said plainly. */
  woNote?: string;
  /** The shift of a pasted email it came from ("2026-11-04:day") and its name. */
  part?: { key: string; label: string };
  /** One of several steps the same words cover ("3 of 4 bottles"). */
  group?: number;
  /** The % worked out from the note's counts ("37 out, 5 left"). */
  counts?: string;
}

/** A % from the note's counts of the step's own things: "37 total removed"
 *  with "5 remaining" is 37 of 42; "6 of 8 bundles" is 6 of 8. A count with
 *  no total ("5 trays out") gives none. */
const COUNTABLE = "trays?|tubes?|plugs?|bolts?|studs?|blinds?|flanges?|nozzles?|spools?|welds?|joints?|manways?|bundles?|elements?|valves?|psvs?|sections?|panels?|bays?|cells?|beds?";
export function pctFromCounts(text: string): { pct: number; words: string } | null {
  const t = text.toLowerCase();
  const last = (re: RegExp) => { let m: RegExpExecArray | null, out: RegExpExecArray | null = null; while ((m = re.exec(t))) out = m; return out; };
  const done = last(new RegExp(`(\\d+)\\s*(?:total|overall|in total|so far)\\s*(?:(?:${COUNTABLE})\\s*)?(?:removed|pulled|out|done|installed|completed?|cleaned|replaced)`, "g"))
    ?? last(new RegExp(`(\\d+)\\s*(?:(?:${COUNTABLE})\\s*)?(?:removed|pulled|out|done|installed|completed?|cleaned|replaced)\\s*(?:total|overall|in total|so far)`, "g"));
  const left = last(new RegExp(`(\\d+)\\s*(?:(?:${COUNTABLE})\\s*)?(?:remaining|left|to go)`, "g"));
  if (done && left) {
    const d = Number(done[1]), r = Number(left[1]);
    if (d + r > 0) return { pct: Math.round((d / (d + r)) * 100), words: `${d} done, ${r} left` };
  }
  const of = last(new RegExp(`(\\d+)\\s*(?:of|/)\\s*(\\d+)\\s*(?:${COUNTABLE})\\b`, "g"));
  if (of) {
    const x = Number(of[1]), y = Number(of[2]);
    if (y > 0 && x <= y) return { pct: Math.round((x / y) * 100), words: `${x} of ${y}` };
  }
  return null;
}

/** A "%" the AI read that is really a count ("5 trays out" read as 5%). */
function countNotPct(pct: number, text: string): boolean {
  if (/%|percent|pct/i.test(text)) return false;
  return new RegExp(`\\b${pct}\\s*(?:${COUNTABLE})\\b`, "i").test(text);
}

/** WO numbers written in some words ("WO# 310357", "WO#310457", "AFE#25206"). */
export const woNumbersIn = (text: string) => [...text.matchAll(/\b(?:WO|AFE)\s*#?\s*(\d{4,7})\b/gi)].map((m) => m[1]);


/** The person's own words put in as they talk: what speech-to-text keeps
 *  hearing ("mee too") written as what they meant ("E-2"). Whole words only,
 *  longest first, any case. */
export function applyWords(text: string, words: Array<{ said: string; as: string }>): string {
  let out = text;
  for (const w of [...words].sort((a, b) => b.said.length - a.said.length)) {
    const said = w.said.trim();
    if (!said || !w.as.trim()) continue;
    const re = new RegExp(`(^|[^a-z0-9])${said.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?=$|[^a-z0-9])`, "gi");
    out = out.replace(re, (_m, pre: string) => `${pre}${w.as.trim()}`);
  }
  return out;
}

/** Tags said by letter and number, as speech-to-text writes them, made
 *  tags: "echo two" and "e two" are E-2, "victor one" V-1, "papa sierra
 *  victor two oh nine" PSV-209. Only a letter followed by a number, and not
 *  "mike two hours". Words it isn't sure of are left as they are. */
export function spokenToTags(text: string): string {
  const NATO: Record<string, string> = { alpha: "A", alfa: "A", bravo: "B", charlie: "C", delta: "D", echo: "E", foxtrot: "F", golf: "G", hotel: "H", india: "I", juliet: "J", kilo: "K", lima: "L", mike: "M", november: "N", oscar: "O", papa: "P", quebec: "Q", romeo: "R", sierra: "S", tango: "T", uniform: "U", victor: "V", whiskey: "W", xray: "X", "x-ray": "X", yankee: "Y", zulu: "Z" };
  const NUM: Record<string, string> = { zero: "0", oh: "0", o: "0", one: "1", won: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50" };
  const UNIT = /^(hours?|hrs?|minutes?|mins?|guys|men|people|percent|%|inch(es)?|in|feet|ft|days?|of|and)$/i;
  const toks = text.split(/(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i];
    const w = raw.toLowerCase().replace(/[.,;:!?]+$/, "");
    const letters: string[] = [];
    let j = i;
    // Letters: phonetic words, or single letters (not "a" or "i").
    while (j < toks.length) {
      const x = toks[j].toLowerCase().replace(/[.,;:!?]+$/, "");
      if (!x.trim()) { j++; continue; }
      if (NATO[x]) { letters.push(NATO[x]); j++; continue; }
      if (/^[b-hj-z]$/.test(x)) { letters.push(x.toUpperCase()); j++; continue; }
      break;
    }
    if (!letters.length || letters.length > 3) { out.push(raw); continue; }
    // Then a number: digits, or number words ("two oh nine", "twenty two").
    const digits: string[] = [];
    let k = j, last = j;
    while (k < toks.length) {
      const x = toks[k].toLowerCase().replace(/[.,;:!?]+$/, "");
      if (!x.trim()) { k++; continue; }
      if (/^\d{1,4}[a-z]?$/.test(x)) { digits.push(x.toUpperCase()); last = k + 1; k++; continue; }
      // "to" and "too" are how E-2 is often heard; "for" and "o" aren't read
      // as the first digit ("v for", "e o").
      if (NUM[x] != null && !(digits.length === 0 && (x === "for" || x === "o" || ((x === "to" || x === "too") && letters.length > 1)))) {
        // "twenty two" is 22.
        const prev = digits[digits.length - 1];
        if (prev && /^[2-5]0$/.test(prev) && /^[1-9]$/.test(NUM[x])) digits[digits.length - 1] = String(Number(prev) + Number(NUM[x]));
        else digits.push(NUM[x]);
        last = k + 1; k++; continue;
      }
      break;
    }
    const next = toks.slice(last).find((t) => t.trim())?.toLowerCase().replace(/[.,;:!?]+$/, "") ?? "";
    const spoken = letters.length > 1 || toks.slice(i, j).some((t) => NATO[t.toLowerCase().replace(/[.,;:!?]+$/, "")]) || /^[b-hj-z]$/.test(w);
    if (!digits.length || !spoken || UNIT.test(next) || (letters.length === 1 && w === "mike" && /^(and|said|is|was|has)$/.test(next))) { out.push(raw); continue; }
    const tail = toks[last - 1]?.match(/[.,;:!?]+$/)?.[0] ?? "";
    out.push(`${letters.join("")}-${digits.join("")}${tail}`);
    i = last - 1;
  }
  return out.join("");
}

// ── Which step: checked here, not taken on the AI's word ──

const plainWords = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** The words are in the note: spacing, case and punctuation aside, or all
 *  but a word or two of them. */
export function inNote(words: string | null | undefined, note: string): boolean {
  const w = plainWords(words ?? ""), n = plainWords(note);
  if (!w) return false;
  if (n.includes(w)) return true;
  const toks = w.split(" ").filter((x) => x.length >= 2);
  if (!toks.length) return false;
  const have = new Set(n.split(" "));
  return toks.filter((x) => have.has(x)).length / toks.length >= 0.8;
}

/** The words name this step's equipment or work order: its tag any way it's
 *  written (V-1 for V-01), or its WO number. */
export function namesStep(words: string, c: CatalogStep): boolean {
  const said = searchIndex(words);
  const own = searchIndex(`${c.place} ${c.name}`);
  for (const t of own.tags) if (said.tags.has(t)) return true;
  return !!c.wo && said.nums.includes(c.wo.replace(/^0+(?=\d)/, ""));
}

const STOP = new Set(["the", "and", "for", "of", "to", "on", "in", "at", "by", "up", "or", "as", "is", "it", "be", "no", "with", "from", "a", "an", "all", "new", "set", "verify", "check",
  // Words for how it stands, not what the task is.
  "complete", "completed", "done", "finish", "finished", "start", "started"]);
/** The step's own words, tags and numbers aside: what kind of task it is
 *  (short ones too: QC, UT, VT). */
const taskWords = (name: string) => plainWords(name).split(" ").filter((w) => w.length >= 2 && !/\d/.test(w) && !STOP.has(w));
const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, 4)) && b.startsWith(a.slice(0, 4))));

/** The note's words share a word with the step's name ("pulled" and Pull
 *  Bundle, "trays" and Remove Trays). */
export function fitsStep(words: string, c: CatalogStep): boolean {
  const said = plainWords(words).split(" ");
  return taskWords(c.name).some((t) => said.some((w) => near(w, t)));
}

/** The same task on other equipment: Pull Bundle on E-02 and on E-22. */
export function sameTask(a: CatalogStep, b: CatalogStep): boolean {
  const x = new Set(taskWords(a.name)), y = new Set(taskWords(b.name));
  if (!x.size || !y.size) return false;
  const both = [...x].filter((w) => y.has(w)).length;
  return both / new Set([...x, ...y]).size >= 0.8;
}

/** How sure the step is, from the note itself:
 *  - named here or earlier in the note: sure (by meaning, it's said);
 *  - not named, and the same task is open on other equipment: asked;
 *  - not named, the only step by that name: sure; no word in common: asked. */
export function stepCheck(step: CatalogStep, u: Pick<RawUpdate, "evidence" | "context"> & { heard?: RawUpdate["heard"] }, note: string, cat: CatalogStep[],
  /** This person's words ("mee too" = E-2), confirmed before. */
  words: Array<{ said: string; as: string }> = []):
  { found: QuickLine["found"]; context: string | null; options?: string[]; unsure?: string; heard?: QuickLine["heard"] } {
  const ctx = u.context && inNote(u.context, note) ? u.context : null;
  // Their own words for a tag read as the tag.
  const own = (t: string) => words.reduce((acc, w) => (plainWords(acc).includes(plainWords(w.said)) ? `${acc} ${w.as}` : acc), t);
  const ev = own(u.evidence), cx = ctx ? own(ctx) : null;
  const fits = fitsStep(`${u.evidence} ${ctx ?? ""}`, step);
  if (namesStep(ev, step)) {
    const learned = ev !== u.evidence && !namesStep(u.evidence, step) ? words.find((w) => plainWords(u.evidence).includes(plainWords(w.said))) : undefined;
    return { found: fits ? "named" : "meaning", context: null, ...(learned ? { heard: { said: learned.said, as: learned.as, stepId: step.id, known: true } } : {}) };
  }
  if (cx && namesStep(cx, step)) return { found: fits ? "context" : "meaning", context: ctx };
  // Words read as a tag in the noise: the first time, one tap to say yes.
  const h = u.heard;
  if (h && inNote(h.said, `${u.evidence} ${ctx ?? ""}`) && namesStep(h.as, step)) {
    return { found: fits ? "named" : "meaning", context: null, options: [step.id], heard: { said: h.said, as: h.as, stepId: step.id, known: false },
      unsure: `Heard “${h.said}” as ${h.as}. Is this the step?` };
  }
  const open = (c: CatalogStep) => c.status !== "completed" && c.pct < 100;
  const twins = cat.filter((c) => c.id !== step.id && open(c) && sameTask(c, step));
  if (twins.length) {
    const rank = (c: CatalogStep) => (c.id === step.id ? 0 : c.live ? 1 : c.next ? 2 : 3);
    const options = [step, ...twins].sort((a, b) => rank(a) - rank(b)).slice(0, 8).map((c) => c.id);
    return { found: undefined, context: null, options, unsure: `Your note doesn't say which equipment, and ${twins.length + 1} open steps are “${step.name}”.` };
  }
  if (!fits) return { found: undefined, context: null, options: [step.id], unsure: "Your note doesn't name the equipment or the step. Is this the one?" };
  return { found: "only", context: null };
}

/** The AI's updates as lines: steps checked against the job, times read. */
export function toLines(reply: RawReply, cat: CatalogStep[], defaultAt: number, ctx: TimeCtx, note = "", words: Array<{ said: string; as: string }> = []): { lines: QuickLine[]; unplaced: RawReply["unplaced"] } {
  const byKey = new Map(cat.map((c) => [c.key, c]));
  const unplaced = [...reply.unplaced];
  const lines: QuickLine[] = [];
  reply.updates.forEach((u, i) => {
    const step = u.step ? byKey.get(u.step) : undefined;
    const opts = [...new Set([...(u.step ? [u.step] : []), ...u.candidates])].map((k) => byKey.get(k)).filter((c): c is CatalogStep => !!c);
    if (!step && opts.length === 0) { unplaced.push({ text: u.evidence || "(no words)", why: u.step ? "That step isn't on the schedule." : "Couldn't tell which step." }); return; }
    // The same words about several steps ("3 of 4 bottles"): one line each,
    // when every one of them is in the note's words.
    const group = u.basis === "group" && opts.length > 1 && (!note || inNote(u.evidence, note)) ? opts : null;
    let action = u.action, percent = u.percent != null ? Math.round(u.percent) : null;
    let percentFrom = u.percentFrom;
    let counts: string | undefined;
    if (percent != null && percentFrom !== "counts" && countNotPct(percent, u.evidence)) { percent = null; percentFrom = "guess"; }
    // Counts in the note's words decide the % (worked out here, not taken on the AI's word).
    if (action === "progress" && !group) {
      const c = pctFromCounts(u.evidence);
      if (c && (percent == null || percentFrom === "guess" || percentFrom === "counts")) { percent = c.pct; percentFrom = "counts"; counts = c.words; }
      else if (percentFrom === "counts" && !c) { percent = null; percentFrom = "guess"; }
    }
    if (action === "progress" && percent != null && percent >= 100) { action = "done"; percent = null; }
    if (percent != null) percent = Math.max(0, Math.min(100, percent));
    const t = readTime(u.when, defaultAt, ctx);
    const expected = "future" in t;
    const base = (id: string): Omit<QuickLine, "stepId" | "options"> => ({
      id,
      ...(note && !inNote(u.evidence, note) ? { notInNote: true } : {}),
      // Not happened yet: what was said is kept as a comment.
      action: expected ? "comment" : action,
      percent: expected ? null : percent,
      percentFrom,
      ...(counts ? { counts } : {}),
      suggest: u.suggest != null ? Math.max(0, Math.min(100, Math.round(u.suggest))) : null,
      reason: u.reason, comment: expected ? `Expected: ${u.evidence}` : u.comment,
      evidence: u.evidence, implied: u.implied,
      at: "at" in t ? t.at : expected ? defaultAt : null,
      timeFrom: "at" in t ? t.from : expected ? "default" : null,
      timeWords: u.when.words,
      ...("ask" in t && t.ask === "ampm" ? { ampm: t.options } : {}),
      ...("ask" in t ? { timeWhy: t.why } : {}),
      expected,
      include: !u.implied,
    });
    if (group) {
      group.forEach((g, j) => lines.push({ ...base(`q${i}g${j}`), stepId: g.id, options: [], found: "named", group: group.length, ...woNoteFor(u.evidence, g, cat) }));
      return;
    }
    // Unsure between steps: the person picks, never the first one. Sure
    // only when the note itself says which (stepCheck).
    const picked = !(opts.length > 1) ? (step ?? opts[0]) : undefined;
    const chk = picked && note ? stepCheck(picked, u, note, cat, words) : null;
    const unsure = opts.length > 1 || !!chk?.options;
    const sid = unsure ? null : (step ?? opts[0]).id;
    lines.push({
      ...base(`q${i}`),
      stepId: sid,
      options: chk?.options ?? (unsure ? opts.map((c) => c.id) : []),
      ...(chk ? { found: chk.found, context: chk.context, ...(chk.unsure ? { unsure: chk.unsure } : {}), ...(chk.heard ? { heard: chk.heard } : {}) } : {}),
      ...(picked && sid ? woNoteFor(u.evidence, picked, cat) : {}),
    });
  });
  return { lines: markAlready(mergeLines(lines), cat, ctx.now, ctx.tz), unplaced };
}

/** Each line's step as it will stand just before that line saves: the
 *  step now, then every earlier line on it in time order (on hold at 2:30
 *  makes "back on" at 3:30 a change; started Monday makes done Tuesday one). */
export function stepsBefore(lines: QuickLine[], cat: CatalogStep[], now: number, tz: string): Map<string, CatalogStep> {
  const byId = new Map(cat.map((c) => [c.id, c]));
  const state = new Map<string, CatalogStep>();
  const out = new Map<string, CatalogStep>();
  const rank = (a: QuickLine["action"]) => (a === "start" ? 0 : a === "progress" ? 1 : a === "hold" ? 2 : a === "resume" ? 3 : a === "done" ? 4 : 5);
  const timed = lines.filter((l) => l.stepId && l.at != null).sort((a, b) => a.at! - b.at! || rank(a.action) - rank(b.action));
  for (const l of timed) {
    const cur = state.get(l.stepId!) ?? byId.get(l.stepId!);
    if (!cur) continue;
    out.set(l.id, cur);
    if (!l.include || l.expected) continue;
    const c = checkLine(l, cur, now, tz);
    if (c.nothing || c.needs.length) continue;
    const next = { ...cur };
    if (l.action === "start") next.status = "in_progress";
    else if (l.action === "progress") { next.status = "in_progress"; if (l.percent != null) next.pct = l.percent; }
    else if (l.action === "done") { next.status = "completed"; next.pct = 100; }
    else if (l.action === "hold") next.status = "on_hold";
    else if (l.action === "resume") next.status = "in_progress";
    if (next.actStart == null && l.action !== "comment" && l.action !== "hold") next.actStart = l.at!;
    state.set(l.stepId!, next);
  }
  for (const l of lines) if (l.stepId && !out.has(l.id)) { const c = state.get(l.stepId) ?? byId.get(l.stepId); if (c) out.set(l.id, c); }
  return out;
}

/** What would change nothing (already done, already further along) left
 *  out, so a pasted thread with older updates in it doesn't repeat them;
 *  one left out before that now would change something, put back. */
export function markAlready(lines: QuickLine[], cat: CatalogStep[], now: number, tz: string): QuickLine[] {
  // Undecided first: what was left out only for being "already" counts again.
  let ls = lines.map((l) => (l.already ? { ...l, include: true, already: undefined } : l));
  const before = stepsBefore(ls, cat, now, tz);
  ls = ls.map((l) => {
    const st = before.get(l.id);
    if (!st || !l.include || l.expected) return l;
    const c = checkLine(l, st, now, tz);
    return c.nothing ? { ...l, include: false, already: c.nothing } : l;
  });
  return ls;
}

/** The note's WO number isn't the step's: said, never silently. */
function woNoteFor(evidence: string, step: CatalogStep, cat: CatalogStep[]): { woNote?: string } {
  const nums = woNumbersIn(evidence);
  if (!nums.length || !step.wo || nums.includes(step.wo) || nums.some((n) => step.wo.includes(n))) return {};
  const n = nums[0];
  const other = cat.find((c) => c.wo === n);
  return { woNote: other ? `Your note says WO ${n}, which is ${other.place || other.name}'s. Matched by the equipment named.` : `WO ${n} isn't on the schedule. Matched by the equipment named.` };
}

/** The same thing said twice (the hour by hour and the shift's summary):
 *  one line, the one with a time said (the earliest), the other's words
 *  added to its comment. Progress to the same %, and the same comment, too. */
export function mergeLines(lines: QuickLine[]): QuickLine[] {
  const keep: QuickLine[] = [];
  const keyOf = (l: QuickLine) => (!l.stepId ? null
    : l.action === "progress" ? `${l.stepId}|progress|${l.percent ?? "?"}`
      : l.action === "comment" ? `${l.stepId}|comment|${plainWords(l.evidence)}`
        : `${l.stepId}|${l.action}`);
  const at = new Map<string, number>();
  for (const l of lines) {
    const k = keyOf(l);
    if (!k || l.expected) { keep.push(l); continue; }
    const i = at.get(k);
    if (i == null) { at.set(k, keep.length); keep.push(l); continue; }
    const a = keep[i];
    const better = (l.timeFrom === "said" && a.timeFrom !== "said") || (l.timeFrom === "said" && a.timeFrom === "said" && l.at != null && a.at != null && l.at < a.at)
      || (a.at == null && l.at != null);
    const [win, lose] = better ? [l, a] : [a, l];
    const extra = lose.evidence && !plainWords(`${win.evidence} ${win.comment ?? ""}`).includes(plainWords(lose.evidence)) ? lose.evidence : null;
    keep[i] = { ...win, include: win.include || lose.include, comment: [win.comment, extra].filter(Boolean).join(" · ") || null };
  }
  return keep;
}

/** Several lines for one: the same words on each step it could be ("All of these"). */
export function toAll(l: QuickLine): QuickLine[] {
  return l.options.map((id, j) => ({ ...l, id: `${l.id}a${j}`, stepId: id, options: [], unsure: undefined, group: l.options.length, found: "named" as const }));
}

/** What still needs the person before a line can be saved, and what it
 *  will do. Empty `needs`: ready. `nothing`: it would change nothing. */
export function checkLine(l: QuickLine, step: CatalogStep | undefined, now: number, tz: string): { needs: string[]; nothing?: string; says: string } {
  const needs: string[] = [];
  if (l.notInNote) needs.push("These words aren't in your note. Untick it, or check the step by hand.");
  if (!step) {
    needs.push(l.unsure ?? (l.options.length ? "Which step is it?" : "Pick the step."));
    return { needs, says: sayLine(l, undefined) };
  }
  if (l.at == null) needs.push(l.ampm ? "AM or PM?" : l.timeWhy ?? "When did it happen?");
  else if (l.at > now + 5 * 60_000) needs.push("That time hasn't come yet. Pick when it happened.");
  // No % said: it goes on as under way with your words, the % left as it
  // is (tap one to set it). Never held up for a number nobody said.
  if (l.action === "hold" && !(l.reason ?? l.comment)?.trim()) needs.push("Why is it on hold?");
  if (l.at != null && step.actStart != null && (l.action === "progress" || l.action === "done") && l.at < step.actStart - 60_000) {
    needs.push(`That's before it started (${clock(step.actStart, tz)}).`);
  }
  let nothing: string | undefined;
  if (l.action === "done" && step.status === "completed") nothing = "Already done.";
  else if (l.action === "start" && (step.status !== "planned" || step.pct > 0)) nothing = "Already started.";
  else if (l.action === "progress" && l.percent != null && l.percent === step.pct) nothing = `Already at ${step.pct}%.`;
  else if (l.action === "progress" && l.percent != null && l.percent < step.pct) nothing = `Already further along (${step.pct}%).`;
  else if (l.action === "progress" && l.percent == null && (step.status === "completed")) nothing = "Already done.";
  else if (l.action === "resume" && step.status !== "on_hold" && step.status !== "blocked") nothing = "It isn't on hold.";
  else if (l.action === "hold" && (step.status === "on_hold" || step.status === "blocked")) nothing = "Already on hold.";
  // A no-change line still keeps what was said, as a comment.
  if (nothing) return { needs: needs.filter((n) => !/what %|how far|before it started|already/i.test(n)), nothing, says: sayLine(l, step) };
  return { needs, says: sayLine(l, step) };
}

/** The change in words: "2% → 50%", "Done", "On hold: no scaffold". */
export function sayLine(l: QuickLine, step: CatalogStep | undefined): string {
  switch (l.action) {
    case "start": return "Started";
    case "progress": return l.percent == null
      ? (step && step.status === "planned" && step.pct === 0 ? "Started (no % said)" : `Under way (no % said${step ? `, stays at ${step.pct}%` : ""})`)
      : `${step ? `${step.pct}% → ` : ""}${l.percent}%`;
    case "done": return "Done";
    case "hold": return `On hold${(l.reason ?? l.comment) ? `: ${l.reason ?? l.comment}` : ""}`;
    case "resume": return "Back on (off hold)";
    default: return l.expected ? "Comment (expected, not entered as done)" : "Comment";
  }
}

/** The shift a time is credited to, said plainly: "Tue Nov 3, 9:30 AM, day shift". */
export function whenWords(at: number, tz: string, times: ShiftTimes): string {
  const s = shiftAt(at, tz, times);
  return `${clock(at, tz)}, ${fmtInTz(s.start, tz, { weekday: "short" })} ${s.kind} shift`;
}

/** The comment a line puts on its step unless it's edited: the note's own
 *  words (and anything else it said about the step), with a misheard tag
 *  written as the tag it was taken for ("mee too" = E-2). */
export function lineComment(l: QuickLine): string {
  const parts = [l.comment, l.evidence].filter((x, i, a): x is string => !!x && a.indexOf(x) === i && !(i === 1 && !!a[0]?.includes(x)));
  const text = parts.join(" · ");
  return l.heard && (l.heard.known || l.heard.stepId === l.stepId) ? applyWords(text, [{ said: l.heard.said, as: l.heard.as }]) : text;
}

/** Each step's updates, to save in time order, with the person's words kept
 *  as a comment on it (once). Only included lines that are ready. */
export function saveEvents(lines: QuickLine[], cat: CatalogStep[], now: number, tz: string): Map<string, SheetEvent[]> {
  const byId = new Map(cat.map((c) => [c.id, c]));
  const before = stepsBefore(lines, cat, now, tz);
  const out = new Map<string, SheetEvent[]>();
  const words = new Map<string, { at: number; text: string[] }>();
  for (const l of lines) {
    if (!l.include || !l.stepId || l.at == null) continue;
    const step = before.get(l.id) ?? byId.get(l.stepId);
    const c = checkLine(l, step, now, tz);
    if (c.needs.length) continue;
    const ev = out.get(l.stepId) ?? [];
    const at = l.at;
    if (!c.nothing) {
      if (l.action === "start") ev.push({ kind: "start", at });
      else if (l.action === "progress" && l.percent != null) ev.push({ kind: "pct", at, pct: l.percent });
      else if (l.action === "progress" && step && step.status === "planned" && step.pct === 0) ev.push({ kind: "start", at });
      else if (l.action === "done") ev.push({ kind: "done", at });
      else if (l.action === "hold") ev.push({ kind: "hold", at, reason: (l.reason ?? l.comment ?? "").trim() });
      else if (l.action === "resume") ev.push({ kind: "pct", at, pct: step?.pct ?? 0 });
    }
    // The comment: as edited on the check screen, else the note's own words.
    const said = [l.noteText !== undefined ? l.noteText : lineComment(l)].map((x) => x?.trim()).filter((x): x is string => !!x);
    if (said.length) {
      const w = words.get(l.stepId) ?? { at, text: [] };
      for (const s of said) if (!w.text.some((t) => t.includes(s) || s.includes(t))) w.text.push(s);
      w.at = Math.max(w.at, at);
      words.set(l.stepId, w);
    }
    out.set(l.stepId, ev);
  }
  for (const [id, w] of words) {
    const ev = out.get(id) ?? [];
    ev.push({ kind: "note", at: w.at, text: w.text.join(" · ") });
    out.set(id, ev);
  }
  // One start per step, and only before anything else (a start after a %
  // would set it back to 0).
  for (const [id, ev] of out) {
    const sorted = ev.sort((a, b) => a.at - b.at || order(a) - order(b));
    const firstWork = sorted.findIndex((e) => e.kind !== "note");
    out.set(id, sorted.filter((e, i) => e.kind !== "start" || i === firstWork));
  }
  return out;
}
const order = (e: SheetEvent) => (e.kind === "start" ? 0 : e.kind === "pct" ? 1 : e.kind === "done" ? 2 : e.kind === "hold" ? 3 : 4);
