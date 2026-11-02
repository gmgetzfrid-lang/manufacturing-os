// shiftSheetSave - what was written on the shift sheet, into the schedule,
// line by line: each line's start, its % at lunch and at the end of the
// shift, done, a hold or a note, in the order they happened. Each is saved
// the way an update on the step is (lib/milestones) and filed at its time,
// so the turnover, the hourly log and the time log credit the shift that
// did it.

import { setMilestoneStatus, setMilestoneProgress, addMilestoneNote, creditProgressTo, type CreditResult } from "@/lib/milestones";
import type { SheetEvent } from "@/lib/shiftSheet";

export interface SaveCtx { orgId: string; userId: string; userName?: string }

/** Save one line's events in order. Returns a warning when a time couldn't
 *  be filed (the update itself is saved). Throws when an update fails. */
export async function saveSheetLine(id: string, events: SheetEvent[], ctx: SaveCtx): Promise<string | null> {
  const iso = (t: number) => new Date(t).toISOString();
  const actor = { actorUserId: ctx.userId, actorUserName: ctx.userName };
  let warn: string | null = null;
  const file = async (at: number) => {
    // Within a couple of minutes of now there's nothing to move.
    if (Math.abs(at - Date.now()) < 120_000) return;
    const r: CreditResult = await creditProgressTo(id, at);
    if (r === "missing") warn = "Saved, but logged at the time you entered it: filing it at the time written needs the database update 20261107_progress_times.sql.";
    else if (r === "changed") warn = "Saved, but logged at the time you entered it: the step has a later entry. Check its history.";
    else if (r === "error" || r === "range") warn = "Saved, but logged at the time you entered it.";
  };
  for (const e of events) {
    if (e.kind === "start") {
      await setMilestoneStatus({ id, status: "in_progress", percentComplete: 0, at: iso(e.at), ...actor });
      await file(e.at);
    } else if (e.kind === "pct") {
      await setMilestoneProgress({ id, percentComplete: e.pct, at: iso(e.at), resume: true, ...actor });
      await file(e.at);
    } else if (e.kind === "done") {
      await setMilestoneStatus({ id, status: "completed", at: iso(e.at), ...actor });
      await file(e.at);
    } else if (e.kind === "hold") {
      await setMilestoneStatus({ id, status: "on_hold", statusReason: e.reason, at: iso(e.at), ...actor });
      await file(e.at);
    } else if (e.kind === "note") {
      await addMilestoneNote({ orgId: ctx.orgId, milestoneId: id, kind: "note", body: e.text, createdBy: ctx.userId, createdByName: ctx.userName, happenedAt: iso(e.at) });
    }
  }
  return warn;
}
