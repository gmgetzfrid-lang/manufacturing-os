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
//                  when it was said ("50", "about half"); a % guessed from
//                  words ("making progress") is never saved, it's asked.
//                  A step the note implies but doesn't name comes unticked.
//                  A % below where the step already is isn't saved here.
//   When         - the time said, read by this file again, not taken on the
//                  AI's word: "2" with no AM or PM, two readings both in the
//                  past, is asked; "yesterday" must be yesterday; a time not
//                  come yet is an expectation (a comment), never done;
//                  "earlier" or "last night" with no time is asked; before
//                  the step started is asked. No time said: the time chosen
//                  for the batch (now, the last shift, or a time picked), shown
//                  on every line. Times go to the nearest half hour, never
//                  later than now.

import type { Milestone, MilestoneStatus } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { leafPercent } from "@/lib/scheduleProgress";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { workOrderOfStep } from "@/lib/workOrderCrew";
import { fmtInTz, wallClockToMs, dayKey, addDays } from "@/lib/scheduleTz";
import { shiftAt, previousShift, meetingLeadMin, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import type { SheetEvent } from "@/lib/shiftSheet";

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
}

const ms = (v: unknown): number => (v == null || v === "" ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

/** Every step on the job (not cancelled), by work order in plan order, each
 *  with a short key. Done steps are listed too: a note can say something
 *  about one, and the AI must not mistake it for another. */
export function stepCatalog(milestones: Milestone[], progress?: Map<string, ProgressInfo>): CatalogStep[] {
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
  ].filter(Boolean).join(" | ")).join("\n");
}

// ── What the AI is asked ──

export const QUICK_SYSTEM = [
  "You read a turnaround supervisor's field notes and say which steps on their schedule each part reports on, and what it reports. You only read: a person checks everything you return before anything is saved.",
  "Work is done out of order. Never assume the schedule's order or dates say what was worked. Match by what the note says: equipment tags (V-01, V1 and V-1 are the same tag; E-2 is E-02), WO numbers, step words, crews.",
  "Use only step keys from the list (s1, s2...). Never invent a step. If a part could be more than one step, give the candidates and no step. If you can't place a part, put it in unplaced.",
  "Actions: start, progress, done, hold (with its reason), resume (back on after a hold), comment.",
  "percent: only when the note gives an amount. percentFrom: \"said\" for a number (\"50\", \"50%\"), \"words\" for an amount in words (\"about half\" = 50, \"almost done\" = 90). A step described but with no amount (\"making progress\", \"staging\", \"working on it\") is progress with percent null, percentFrom \"guess\" and your best suggestion in suggest. Finished, complete, done, removed, pulled, washed (when the step is that action) = done.",
  "implied: true for a step the note doesn't name but must be finished for what it says to be true (washed the head means the head was removed). Only direct prerequisites, never more.",
  "when: copy the note's exact words about time into words (null if none). kind: \"none\" (no time words; \"already\" alone is none), \"clock\" (a time of day: 2pm, at 2, 0730, noon), \"day\" (a day with or without a time: yesterday at 3, Monday night, last night at 11), \"relative\" (2 hours ago, an hour ago), \"unclear\" (past with no time to place it: earlier, this morning, last night, yesterday, before lunch), \"future\" (not happened yet: will be done in a couple hours, should finish by 2, tonight they'll start). local: your reading as \"YYYY-MM-DD HH:MM\" in plant time, given now; null for none, unclear and future.",
  "evidence: the exact words from the note this update comes from. comment: anything else the note says about the step worth keeping (a reason, what they're waiting on), in the note's words.",
  "Return STRICT JSON only: {\"updates\":[{\"step\":\"s12\",\"candidates\":[],\"action\":\"done\",\"percent\":null,\"percentFrom\":null,\"suggest\":null,\"reason\":null,\"comment\":null,\"implied\":false,\"evidence\":\"...\",\"when\":{\"words\":null,\"kind\":\"none\",\"local\":null}}],\"unplaced\":[{\"text\":\"...\",\"why\":\"...\"}]}",
].join("\n");

export function quickUserPrompt(o: { note: string; catalog: string; now: number; tz: string; shift: string }): string {
  return [
    `Now: ${clock(o.now, o.tz)} (plant time, ${o.tz}). ${o.shift}`,
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

export interface RawUpdate {
  step: string | null; candidates: string[]; action: Action;
  percent: number | null; percentFrom: "said" | "words" | "guess" | null; suggest: number | null;
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
    const pf = x.percentFrom === "said" || x.percentFrom === "words" || x.percentFrom === "guess" ? x.percentFrom : null;
    updates.push({
      step: str(x.step), candidates: Array.isArray(x.candidates) ? x.candidates.map(str).filter((c): c is string => !!c) : [],
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
/** To the nearest half hour, never later than now. */
export function roundTime(t: number, now: number): number {
  const r = Math.round(t / HALF) * HALF;
  return r > now ? Math.floor(t / HALF) * HALF : r;
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

export interface TimeCtx { now: number; tz: string; times: ShiftTimes }

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
    if (past.length === 2) return { ask: "ampm", options: [roundTime(past[1], now), roundTime(past[0], now)] as [number, number], why: `“${words}”: AM or PM?` };
  }
  // Not come yet: what's expected, never entered as done.
  if (L > soon) return { future: true };
  if (L < now - 14 * 86_400_000) return { ask: "time", why: `“${words}” reads as more than two weeks ago. Pick the time.` };
  return { at: roundTime(L, now), from: "said" };
}

/** The times offered for updates with no time said: now, the end of the
 *  last shift (when its turnover meeting started), and the start of this one. */
export function defaultTimes(ctx: TimeCtx): Array<{ id: "now" | "last" | "start"; at: number; label: string }> {
  const { now, tz, times } = ctx;
  const cur: ShiftWindow = shiftAt(now, tz, times);
  const prev = previousShift(cur, tz, times);
  const name = (w: ShiftWindow) => `${fmtInTz(w.start, tz, { weekday: "short" })} ${w.kind}`;
  const lastAt = roundTime(prev.end - meetingLeadMin(times) * 60_000, now);
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
}

/** The AI's updates as lines: steps checked against the job, times read. */
export function toLines(reply: RawReply, cat: CatalogStep[], defaultAt: number, ctx: TimeCtx): { lines: QuickLine[]; unplaced: RawReply["unplaced"] } {
  const byKey = new Map(cat.map((c) => [c.key, c]));
  const unplaced = [...reply.unplaced];
  const lines: QuickLine[] = [];
  reply.updates.forEach((u, i) => {
    const step = u.step ? byKey.get(u.step) : undefined;
    const opts = [...new Set([...(u.step ? [u.step] : []), ...u.candidates])].map((k) => byKey.get(k)).filter((c): c is CatalogStep => !!c);
    if (!step && opts.length === 0) { unplaced.push({ text: u.evidence || "(no words)", why: u.step ? "That step isn't on the schedule." : "Couldn't tell which step." }); return; }
    // Unsure between steps: the person picks, never the first one.
    const unsure = opts.length > 1;
    let action = u.action, percent = u.percent != null ? Math.round(u.percent) : null;
    if (action === "progress" && percent != null && percent >= 100) { action = "done"; percent = null; }
    if (percent != null) percent = Math.max(0, Math.min(100, percent));
    const t = readTime(u.when, defaultAt, ctx);
    const expected = "future" in t;
    lines.push({
      id: `q${i}`,
      stepId: unsure ? null : (step ?? opts[0]).id,
      options: unsure ? opts.map((c) => c.id) : [],
      // Not happened yet: what was said is kept as a comment.
      action: expected ? "comment" : action,
      percent: expected ? null : percent,
      percentFrom: u.percentFrom,
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
  });
  return { lines, unplaced };
}

/** What still needs the person before a line can be saved, and what it
 *  will do. Empty `needs`: ready. `nothing`: it would change nothing. */
export function checkLine(l: QuickLine, step: CatalogStep | undefined, now: number, tz: string): { needs: string[]; nothing?: string; says: string } {
  const needs: string[] = [];
  if (!step) {
    needs.push(l.options.length ? "Which step is it?" : "Pick the step.");
    return { needs, says: sayLine(l, undefined) };
  }
  if (l.at == null) needs.push(l.ampm ? "AM or PM?" : l.timeWhy ?? "When did it happen?");
  else if (l.at > now + 5 * 60_000) needs.push("That time hasn't come yet. Pick when it happened.");
  if (l.action === "progress") {
    if (l.percent == null) needs.push(l.percentFrom === "guess" ? "How far along? (not said)" : "What %?");
    else if (l.percent < step.pct) needs.push(`It's at ${step.pct}% already. Leave it out, or fix it in the step's history.`);
  }
  if (l.action === "hold" && !(l.reason ?? l.comment)?.trim()) needs.push("Why is it on hold?");
  if (l.at != null && step.actStart != null && (l.action === "progress" || l.action === "done") && l.at < step.actStart - 60_000) {
    needs.push(`That's before it started (${clock(step.actStart, tz)}).`);
  }
  let nothing: string | undefined;
  if (l.action === "done" && step.status === "completed") nothing = "Already done.";
  else if (l.action === "start" && (step.status !== "planned" || step.pct > 0)) nothing = "Already started.";
  else if (l.action === "progress" && l.percent != null && l.percent === step.pct) nothing = `Already at ${step.pct}%.`;
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
    case "progress": return l.percent == null ? "Moved forward, % not said" : `${step ? `${step.pct}% → ` : ""}${l.percent}%`;
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

/** Each step's updates, to save in time order, with the person's words kept
 *  as a comment on it (once). Only included lines that are ready. */
export function saveEvents(lines: QuickLine[], cat: CatalogStep[], now: number, tz: string): Map<string, SheetEvent[]> {
  const byId = new Map(cat.map((c) => [c.id, c]));
  const out = new Map<string, SheetEvent[]>();
  const words = new Map<string, { at: number; text: string[] }>();
  for (const l of lines) {
    if (!l.include || !l.stepId || l.at == null) continue;
    const step = byId.get(l.stepId);
    const c = checkLine(l, step, now, tz);
    if (c.needs.length) continue;
    const ev = out.get(l.stepId) ?? [];
    const at = l.at;
    if (!c.nothing) {
      if (l.action === "start") ev.push({ kind: "start", at });
      else if (l.action === "progress" && l.percent != null) ev.push({ kind: "pct", at, pct: l.percent });
      else if (l.action === "done") ev.push({ kind: "done", at });
      else if (l.action === "hold") ev.push({ kind: "hold", at, reason: (l.reason ?? l.comment ?? "").trim() });
      else if (l.action === "resume") ev.push({ kind: "pct", at, pct: step?.pct ?? 0 });
    }
    const said = [l.comment, l.evidence].map((x) => x?.trim()).filter((x): x is string => !!x);
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
  for (const [id, ev] of out) out.set(id, ev.sort((a, b) => a.at - b.at || order(a) - order(b)));
  return out;
}
const order = (e: SheetEvent) => (e.kind === "start" ? 0 : e.kind === "pct" ? 1 : e.kind === "done" ? 2 : e.kind === "hold" ? 3 : 4);
