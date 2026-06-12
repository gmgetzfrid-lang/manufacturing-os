// lib/taskNudge.ts
//
// "Nudge a person" — send a scratchpad task to a teammate as a one-off
// in-app heads-up. Deliberately NOT a workflow: no assignment, no state,
// no ticket. Just the bell notification with your task text on it.

import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/inAppNotifications";

export interface NudgeTarget {
  uid: string;
  name: string;
}

/** Active members of the org, for the picker. Display name falls back
 *  to email so every row is identifiable. */
export async function listNudgeTargets(orgId: string, excludeUid?: string): Promise<NudgeTarget[]> {
  const { data, error } = await supabase
    .from("org_members")
    .select("uid, display_name, email")
    .eq("org_id", orgId)
    .eq("status", "active")
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data as Array<{ uid: string; display_name: string | null; email: string | null }>) ?? [])
    .filter((m) => m.uid && m.uid !== excludeUid)
    .map((m) => ({ uid: m.uid, name: m.display_name || m.email || "Unnamed member" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SendTaskNudgeInput {
  orgId: string;
  toUserId: string;
  fromUserId: string;
  fromName?: string;
  taskText: string;
  /** Optional one-liner the sender adds ("can you grab this Friday?"). */
  message?: string;
}

export async function sendTaskNudge(input: SendTaskNudgeInput): Promise<void> {
  await notify({
    orgId: input.orgId,
    userId: input.toUserId,
    kind: "task_nudge",
    title: `${input.fromName || "A teammate"} nudged you: ${input.taskText.slice(0, 90)}`,
    body: input.message?.trim() || undefined,
    link: "/scratchpad",
    actorUserId: input.fromUserId,
    actorName: input.fromName,
  });
}
