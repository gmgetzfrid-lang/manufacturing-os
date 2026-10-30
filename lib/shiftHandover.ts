// shiftHandover — the turnover as decided and shipped.
//
// The report the app builds is a draft until it's shipped. At the meeting
// the supervisor marks only the exceptions: a step the other crew's work
// that the next shift "could try", and which crew. Everything left alone is
// confirmed as the report reads when Ship is pressed. Ship saves what was
// handed over; the next shift's report reads it back — what was asked, and
// how far each step got (as entered).

import { supabase } from "@/lib/supabase";
import { whoOf, type PullCrew, type ShiftReport, type ShiftRow, type ShiftWindow } from "@/lib/shiftReport";

export interface HandoverDecision {
  /** The next shift could try it (it isn't that crew's planned work). */
  tryIt?: boolean;
  /** Which crew, if one is named. */
  crew?: string | null;
  note?: string | null;
  /** Where it stood when the turnover was shipped. */
  pctAtShip?: number;
  /** Its name then — shown even if the step is renamed or removed later. */
  name?: string;
  /** Pulled forward from later in the schedule (not the other crew's
   *  carried work), and when it was planned. */
  pulled?: boolean;
  plannedStart?: number;
  /** Why it was on the list, as shipped. */
  why?: "pulled ahead" | "carry-over" | "other crew's work";
}

export interface Handover {
  shiftKey: string;
  decisions: Record<string, HandoverDecision>;
  /** The crew kept for pulled-forward work on this shift, and its size —
   *  this turnover's, else the project's default. */
  pull?: PullCrew | null;
  shippedAt: string | null;
  shippedByName: string | null;
}

/** The shift the work is handed to — "2026-10-26:night". */
export const handoverKey = (w: ShiftWindow) => `${w.dayKey}:${w.kind}`;

const MISSING = "Shipping turnovers needs a one-time database update (20261103_shift_handovers.sql) - ask your admin to run it.";
const missing = (msg: string) => /shift_handovers/.test(msg) || /does not exist/.test(msg);

// The crew & size ride in the same JSON as the decisions, under a key no
// step id can have.
const PULL_KEY = "_pull";
type Stored = Record<string, HandoverDecision> & { [PULL_KEY]?: PullCrew };
function split(raw: Stored | null): { decisions: Record<string, HandoverDecision>; pull: PullCrew | null } {
  const { [PULL_KEY]: pull, ...decisions } = raw ?? {};
  return { decisions, pull: pull ?? null };
}
const join = (decisions: Record<string, HandoverDecision>, pull?: PullCrew | null): Stored => (pull ? { ...decisions, [PULL_KEY]: pull } : { ...decisions });

/** The handover for a shift, or null when there's none yet. Throws a
 *  plain message when the table isn't there. */
export async function loadHandover(projectId: string, shiftKey: string): Promise<Handover | null> {
  const { data, error } = await supabase.from("shift_handovers")
    .select("shift_key, decisions, shipped_at, shipped_by_name").eq("project_id", projectId).eq("shift_key", shiftKey).maybeSingle();
  if (error) throw new Error(missing(error.message) ? MISSING : error.message);
  if (!data) return null;
  const r = data as { shift_key: string; decisions: Stored | null; shipped_at: string | null; shipped_by_name: string | null };
  return { shiftKey: r.shift_key, ...split(r.decisions), shippedAt: r.shipped_at, shippedByName: r.shipped_by_name };
}

/** Save the draft's decisions (anyone at the meeting sees the same). */
export async function saveHandover(input: {
  orgId: string; projectId: string; shiftKey: string; decisions: Record<string, HandoverDecision>;
  pull?: PullCrew | null;
  ship?: { snapshot: unknown; byName?: string } | "unship"; userId: string;
}): Promise<Handover> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    org_id: input.orgId, project_id: input.projectId, shift_key: input.shiftKey,
    decisions: join(input.decisions, input.pull), updated_at: now, updated_by: input.userId,
  };
  if (input.ship === "unship") { row.shipped_at = null; row.shipped_by = null; row.shipped_by_name = null; }
  else if (input.ship) { row.shipped_at = now; row.shipped_by = input.userId; row.shipped_by_name = input.ship.byName ?? null; row.snapshot = input.ship.snapshot; }
  const { data, error } = await supabase.from("shift_handovers").upsert(row, { onConflict: "project_id,shift_key" })
    .select("shift_key, decisions, shipped_at, shipped_by_name").single();
  if (error) throw new Error(missing(error.message) ? MISSING : error.message);
  const r = data as { shift_key: string; decisions: Stored | null; shipped_at: string | null; shipped_by_name: string | null };
  return { shiftKey: r.shift_key, ...split(r.decisions), shippedAt: r.shipped_at, shippedByName: r.shipped_by_name };
}

/** Decisions that still mean something: marked to try, with where each
 *  stood at ship time filled in. */
export function decisionsToShip(decisions: Record<string, HandoverDecision>, rows: ShiftRow[], pullCrew?: string | null): Record<string, HandoverDecision> {
  const byId = new Map(rows.map((r) => [r.leaf.id ?? "", r]));
  const out: Record<string, HandoverDecision> = {};
  for (const [id, d] of Object.entries(decisions)) {
    const r = byId.get(id);
    if (!d.tryIt || !r) continue;
    out[id] = {
      // Pulled work with no crew of its own went with the extra-work crew.
      tryIt: true, crew: d.crew ?? (d.pulled ? pullCrew ?? null : null), note: d.note?.trim() || null, pctAtShip: r.percent, name: r.leaf.name,
      ...(d.pulled ? { pulled: true, plannedStart: r.crewStart } : {}),
      why: d.pulled ? "pulled ahead" : r.carryOver ? "carry-over" : "other crew's work",
    };
  }
  return out;
}

/** Crews to offer for a step the next shift could try — the app's best
 *  guess first, with why, never "available": the app doesn't know
 *  headcount or skills. Crews already working the same job on that shift,
 *  then the next shift's crews with the lightest planned load. */
export function suggestCrews(row: ShiftRow, report: ShiftReport): Array<{ crew: string; why: string }> {
  const load = new Map<string, { hours: number; sameJob: boolean }>();
  for (const r of report.goals.all) {
    const w = whoOf(r);
    if (!r.leaf.responsibleParty?.trim()) continue;
    const e = load.get(w) ?? { hours: 0, sameJob: false };
    e.hours += r.hoursNext ?? 0;
    if (row.parentId && r.parentId === row.parentId) e.sameJob = true;
    load.set(w, e);
  }
  const kind = report.next.kind;
  return [...load].sort((a, b) => Number(b[1].sameJob) - Number(a[1].sameJob) || a[1].hours - b[1].hours || a[0].localeCompare(b[0]))
    .map(([crew, e]) => ({ crew, why: e.sameJob ? `on ${row.parentName ?? "this job"} this ${kind}` : `${Math.round(e.hours * 10) / 10} h planned this ${kind}` }));
}

/** What became of the steps the last turnover asked this shift to try —
 *  as entered so far (progress is often caught up later). */
export function askedOutcomes(prior: Handover | null, pctOf: (id: string) => number | undefined): Array<{ id: string; name: string; crew: string | null; from: number; now: number | null; pulled: boolean; why: string }> {
  // Only what was shipped: a draft nobody shipped wasn't handed over.
  if (!prior?.shippedAt) return [];
  return Object.entries(prior.decisions).filter(([, d]) => d.tryIt)
    .map(([id, d]) => ({ id, name: d.name ?? id, crew: d.crew ?? null, from: d.pctAtShip ?? 0, now: pctOf(id) ?? null, pulled: !!d.pulled, why: d.why ?? (d.pulled ? "pulled ahead" : "carry-over") }));
}

/** What became of an asked step, in words: done, how far, or no progress. */
export function askedResult(a: { from: number; now: number | null }): string {
  if (a.now == null) return "-";
  if (a.now >= 100) return "done ✓";
  if (a.now > a.from) return `${a.now}%`;
  return a.from > 0 ? "no progress" : "not started";
}

/** Hours a step would take on one shift: what's left, at most a shift. */
export const shiftShare = (r: ShiftRow, shiftHours: number) => Math.min(r.hoursLeft, shiftHours);

/** The crew kept for pulled-forward work, and how full it is. */
export function capacityOf(pull: PullCrew | null | undefined, picked: ShiftRow[], shiftHours: number): { hours: number; used: number; over: boolean } {
  const hours = pull ? Math.round(pull.hands * Math.min(pull.hours, shiftHours) * 10) / 10 : 0;
  const used = Math.round(picked.reduce((a, r) => a + shiftShare(r, shiftHours), 0) * 10) / 10;
  return { hours, used, over: hours > 0 && used > hours };
}
