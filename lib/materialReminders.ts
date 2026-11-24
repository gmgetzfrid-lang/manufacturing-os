// lib/materialReminders.ts - the materials register's reminders.
//
// Once a day (app/api/cron/maintenance) each open line not yet in hand and
// checked, whose verify-by date (its own, else its need-by date less
// VERIFY_LEAD_DAYS) is within REMIND_DAYS or past, reminds its warehouse
// owner in the app (the bell). The owner is the person named on the line,
// found among the project's people by name or email; a name nobody on the
// project has gets no reminder (the register shows the line as needing
// someone either way). One reminder per line per person per day.
//
// Written against the shared client, which the cron swaps to the service
// role for the run (as the other daily scans).

import { supabase } from "@/lib/supabase";
import { verifyDate, type MaterialStatus } from "@/lib/materials";

/** Days before the verify-by date the reminders start. */
export const REMIND_DAYS = 3;
const DAY = 86_400_000;

interface Line { id: string; project_id: string; item: string; owner: string | null; status: MaterialStatus; need_by: string | null; verify_by?: string | null; kind: string }

/** Whole days from today (UTC) to a "YYYY-MM-DD" date; negative once past. */
export function daysTo(day: string, now: number): number {
  const t = Date.parse(`${day}T00:00:00Z`);
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((t - today) / DAY);
}

/** The reminder's words for a line, or null when none is due. */
export function reminderFor(l: Pick<Line, "item" | "status" | "need_by" | "verify_by">, now: number): { title: string; body: string } | null {
  if (l.status === "checked" || l.status === "used" || l.status === "cancelled") return null;
  const d = verifyDate({ verifyBy: l.verify_by ?? null, needBy: l.need_by });
  if (!d) return null;
  const n = daysTo(d, now);
  if (n > REMIND_DAYS) return null;
  const when = new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const title = n < 0 ? `${l.item}: not checked, due ${when}` : n === 0 ? `${l.item}: to be checked today` : `${l.item}: to be checked by ${when}`;
  const body = n < 0
    ? `It was to be in hand and checked by ${when}, ${-n} day${n === -1 ? "" : "s"} ago. Mark it "Received, checked" once it is, or set a new date on its line.`
    : `It is to be in hand and checked by ${when}${n ? `, in ${n} day${n === 1 ? "" : "s"}` : ""}. Mark it "Received, checked" on the register once it is.`;
  return { title, body };
}

export async function scanMaterialReminders(orgId: string, now = Date.now()): Promise<number> {
  const { data, error } = await supabase.from("project_materials").select("*").eq("org_id", orgId).not("status", "in", "(checked,used,cancelled)");
  if (error) {
    // No register table in this workspace's database yet: nothing to remind.
    if (/does not exist|schema cache|could not find the table/i.test(error.message)) return 0;
    throw new Error(error.message);
  }
  const due = ((data ?? []) as Line[]).map((l) => ({ l, r: reminderFor(l, now) })).filter((x) => x.r && x.l.owner?.trim());
  if (!due.length) return 0;

  // The project's people, to find each owner by the name or email on the line.
  const projects = [...new Set(due.map((x) => x.l.project_id))];
  const { data: members } = await supabase.from("project_members").select("project_id, user_id, user_name, user_email").in("project_id", projects);
  const key = (s: string) => s.trim().toLowerCase();
  const who = new Map<string, string>();
  for (const m of (members ?? []) as Array<{ project_id: string; user_id: string; user_name: string | null; user_email: string | null }>) {
    for (const n of [m.user_name, m.user_email]) if (n?.trim()) who.set(`${m.project_id}|${key(n)}`, m.user_id);
  }

  // Already reminded today: not again.
  const since = new Date(now - 20 * 3_600_000).toISOString();
  const { data: sent } = await supabase.from("notifications").select("user_id, resource_id").eq("org_id", orgId).eq("kind", "material_verify").gte("created_at", since);
  const done = new Set(((sent ?? []) as Array<{ user_id: string; resource_id: string | null }>).map((s) => `${s.user_id}|${s.resource_id}`));

  const rows = due.flatMap(({ l, r }) => {
    const uid = who.get(`${l.project_id}|${key(l.owner!)}`);
    if (!uid || done.has(`${uid}|${l.id}`)) return [];
    return [{
      org_id: orgId, user_id: uid, kind: "material_verify", title: r!.title, body: r!.body,
      link: `/projects/${l.project_id}?tab=materials`, resource_type: "project_material", resource_id: l.id,
      metadata: { item: l.item, status: l.status },
    }];
  });
  if (!rows.length) return 0;
  const { error: insErr } = await supabase.from("notifications").insert(rows);
  if (insErr) throw new Error(insErr.message);
  return rows.length;
}
