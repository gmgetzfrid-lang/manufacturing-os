// quickUpdateSave - saving what Update by note checked, step by step, and
// taking it back again with one tap if it turned out wrong.
//
// Each step's updates are saved the way an update on the step is (lib/
// milestones), filed at the time they happened, like the shift sheet. What
// was saved is kept: how many changes went on the step's history, what it
// stood at after, and the comments written. Undo takes those changes back
// with the step's own Take back (undo_last_progress), newest first, and
// removes those comments - only while nobody has changed the step since.

import { setMilestoneStatus, setMilestoneProgress, addMilestoneNote, creditProgressTo, undoLastProgress, deleteMilestoneNote, type CreditResult } from "@/lib/milestones";
import { supabase } from "@/lib/supabase";
import type { SheetEvent } from "@/lib/shiftSheet";
import type { Milestone } from "@/types/schema";

export interface SavedStep {
  id: string;
  name: string;
  /** Lines put on the step's history (a start, a %, done, a hold). */
  changes: number;
  /** Comments written with it (the step's status notes too). */
  noteIds: string[];
  /** Where it stood once saved: Undo only while it still does. */
  after: { status: string; pct: number };
  warn: string | null;
}

const pctOf = (m: Milestone) => Math.round(Number(m.percentComplete ?? 0));

/** Save one step's updates in order. Throws when one fails (what was saved
 *  before it is in the result's error as `partial`). */
export async function saveQuickStep(id: string, name: string, events: SheetEvent[], before: { status: string; pct: number },
  ctx: { orgId: string; userId: string; userName?: string }): Promise<SavedStep> {
  const iso = (t: number) => new Date(t).toISOString();
  const actor = { actorUserId: ctx.userId, actorUserName: ctx.userName };
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  let warn: string | null = null, changes = 0;
  let state = { ...before };
  const noteIds: string[] = [];
  const file = async (at: number) => {
    if (Math.abs(at - Date.now()) < 120_000) return;
    const r: CreditResult = await creditProgressTo(id, at);
    if (r === "missing") warn = "Saved, but logged at the time you entered it: filing it at the time written needs the database update 20261107_progress_times.sql.";
    else if (r === "changed") warn = "Saved, but logged at the time you entered it: the step has a later entry. Check its history.";
    else if (r === "error" || r === "range") warn = "Saved, but logged at the time you entered it.";
  };
  const took = async (m: Milestone, at: number) => {
    const next = { status: m.status, pct: pctOf(m) };
    if (next.status !== state.status || next.pct !== state.pct) changes++;
    state = next;
    await file(at);
  };
  for (const e of events) {
    if (e.kind === "start") await took(await setMilestoneStatus({ id, status: "in_progress", percentComplete: 0, at: iso(e.at), ...actor }), e.at);
    else if (e.kind === "pct") await took(await setMilestoneProgress({ id, percentComplete: e.pct, at: iso(e.at), resume: true, ...actor }), e.at);
    else if (e.kind === "done") await took(await setMilestoneStatus({ id, status: "completed", at: iso(e.at), ...actor }), e.at);
    else if (e.kind === "hold") await took(await setMilestoneStatus({ id, status: "on_hold", statusReason: e.reason, at: iso(e.at), ...actor }), e.at);
    else if (e.kind === "note") {
      const n = await addMilestoneNote({ orgId: ctx.orgId, milestoneId: id, kind: "note", body: e.text, createdBy: ctx.userId, createdByName: ctx.userName, happenedAt: iso(e.at) });
      if (n.id) noteIds.push(n.id);
    }
  }
  // The status notes the updates wrote, by this person, just now.
  const { data } = await supabase.from("milestone_notes").select("id").eq("milestone_id", id).eq("created_by", ctx.userId).gte("created_at", startedAt);
  for (const r of (data ?? []) as Array<{ id: string }>) if (!noteIds.includes(r.id)) noteIds.push(r.id);
  return { id, name, changes, noteIds, after: state, warn };
}

/** Take a saved step's updates back. "changed": someone changed the step
 *  since (fix it in its history); "missing": the database update for Take
 *  back isn't run. */
export async function undoQuickStep(s: SavedStep): Promise<"ok" | "changed" | "missing" | "error"> {
  const { data } = await supabase.from("milestones").select("status, percent_complete").eq("id", s.id).maybeSingle();
  const now = data as { status: string; percent_complete: number | null } | null;
  if (!now || now.status !== s.after.status || Math.round(Number(now.percent_complete ?? 0)) !== s.after.pct) return "changed";
  for (let i = 0; i < s.changes; i++) {
    const r = await undoLastProgress(s.id);
    if (r === "missing") return "missing";
    if (r !== "ok") return "error";
  }
  for (const n of s.noteIds) await deleteMilestoneNote(n).catch(() => undefined);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("schedule:changed", { detail: { ids: [s.id] } }));
    window.dispatchEvent(new CustomEvent("milestone-notes:changed"));
  }
  return "ok";
}
