// lib/reminders.ts
//
// Computes a user's scratchpad reminder state from the SERVER (service-role
// client), so the reminder cron can decide what to push without the user's
// session. Reuses the same pure task extraction + bucketing the in-app
// scratchpad uses, so "overdue / due today / aging" mean exactly the same.

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractTasks, bucketForTask, cleanTaskText } from "@/lib/notes";

export interface UserReminder {
  overdue: number;
  today: number;
  stale: number;
  total: number;
  sample: string | null;
}

const STALE_UNDATED_DAYS = 3;

/** Tally a user's open to-dos: overdue, due today, and undated-but-aging. */
export async function computeUserReminder(
  admin: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<UserReminder> {
  const empty: UserReminder = { overdue: 0, today: 0, stale: 0, total: 0, sample: null };
  const { data, error } = await admin
    .from("notes")
    .select("id, body, created_at, updated_at")
    .eq("created_by", userId)
    .eq("resolved", false)
    .limit(500);
  if (error || !data) return empty;

  const staleBefore = now.getTime() - STALE_UNDATED_DAYS * 86400000;
  let overdue = 0, today = 0, stale = 0;
  let sample: string | null = null;

  for (const row of data as Array<Record<string, unknown>>) {
    const note = { id: String(row.id), body: String(row.body ?? "") };
    const touched = new Date(String(row.updated_at ?? row.created_at ?? "")).getTime();
    for (const task of extractTasks(note, now)) {
      if (task.completed) continue;
      const bucket = bucketForTask(task, now);
      if (bucket === "overdue") { overdue += 1; if (!sample) sample = cleanTaskText(task); }
      else if (bucket === "today") today += 1;
      else if (bucket === "no-date") {
        if (Number.isFinite(touched) && touched < staleBefore) stale += 1;
      }
    }
  }
  return { overdue, today, stale, total: overdue + today + stale, sample };
}

/** Build the push payload, or null when there's nothing worth pinging about. */
export function reminderPayload(r: UserReminder): { title: string; body: string; url: string; tag: string } | null {
  if (r.total === 0) return null;
  const parts: string[] = [];
  if (r.overdue > 0) parts.push(`${r.overdue} overdue`);
  if (r.today > 0) parts.push(`${r.today} due today`);
  if (r.stale > 0) parts.push(`${r.stale} aging`);
  const title = r.overdue > 0
    ? `${r.overdue} scratchpad to-do${r.overdue === 1 ? "" : "s"} overdue`
    : "Scratchpad reminders";
  const lead = r.sample ? `e.g. “${r.sample.slice(0, 60)}” · ` : "";
  return { title, body: `${lead}${parts.join(" · ")}`, url: "/scratchpad", tag: "mfgos-scratchpad" };
}
