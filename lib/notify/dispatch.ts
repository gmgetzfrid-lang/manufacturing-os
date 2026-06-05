// lib/notify/dispatch.ts
//
// THE single entry point every producer should call. One event in → resolved
// recipients (from all follow systems) → fanned out to every delivery channel
// (in-app bell, email, browser push), each honoring per-user, per-channel
// preferences.
//
// It wraps the existing notifyMany()/queueEmail() helpers rather than replacing
// them, so producers can migrate to emit() one at a time with zero regression.

import { notifyMany, type NotificationKind } from "@/lib/inAppNotifications";
import { queueEmail } from "@/lib/notifications";
import { supabase } from "@/lib/supabase";
import {
  resolveFollowers,
  resolveRoleRecipients,
  resolveProjectMembers,
  type ResourceRef,
  type ResourceType,
} from "./recipients";
import { sendPushSafe } from "./push";

export type NotifChannel = "inapp" | "email" | "push";
export type NotifCategory = "mention" | "assignment" | "status" | "watched" | "sla" | "system";

export interface EmitInput {
  orgId: string;
  /** Drives which per-category preference toggle gates the email channel. */
  category: NotifCategory;
  /** Bell icon + tone. */
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
  resource: ResourceRef;
  actorUserId?: string;
  actorName?: string;
  /** Who hears about it. The union of every provided source, minus the actor. */
  audience: {
    involved?: string[];   // explicit stakeholders (requester/assignee/mentions)
    followers?: boolean;   // walk resolveFollowers(resource)
    roles?: string[];      // a role pool in the org
    projectId?: string;    // members of a project
  };
  /** Defaults to all three. Pass a subset to force-limit a noisy event. */
  channels?: NotifChannel[];
  email?: { subject?: string; bodyText?: string; bodyHtml?: string };
  metadata?: Record<string, unknown>;
}

// Map our preference category to the eventType string queueEmail understands,
// so the existing per-category email toggles keep working unchanged.
function categoryToEventType(c: NotifCategory): string {
  switch (c) {
    case "mention": return "comment_mention";
    case "assignment": return "assignment";
    case "status": return "ticket_status_changed";
    case "watched": return "watcher_activity";
    case "sla": return "sla_warning";
    default: return "system";
  }
}

// queueEmail only types these three resource kinds; others email with no link
// scope (still delivered, just not resource-typed).
const EMAILABLE: ResourceType[] = ["ticket", "project", "document"];

/** Resolve the deduped recipient set for an event (minus the actor). Exported
 *  so callers can preview/whom-would-this-notify without sending. */
export async function resolveRecipients(input: EmitInput): Promise<string[]> {
  const ids = new Set<string>();
  (input.audience.involved ?? []).forEach((u) => u && ids.add(u));

  const tasks: Promise<string[]>[] = [];
  if (input.audience.followers) tasks.push(resolveFollowers(input.resource));
  if (input.audience.roles?.length) tasks.push(resolveRoleRecipients(input.orgId, input.audience.roles));
  if (input.audience.projectId) tasks.push(resolveProjectMembers(input.audience.projectId));
  for (const list of await Promise.all(tasks)) list.forEach((u) => u && ids.add(u));

  if (input.actorUserId) ids.delete(input.actorUserId);
  return Array.from(ids);
}

/** Fan one event out to every enabled channel. Fire-and-forget friendly. */
export async function emit(input: EmitInput): Promise<void> {
  const recipients = await resolveRecipients(input);
  if (recipients.length === 0) return;
  const channels = input.channels ?? ["inapp", "email", "push"];

  // 1) In-app bell — reuse the existing fan-out helper (it also drops the actor
  //    and dedupes recipients defensively).
  if (channels.includes("inapp")) {
    await notifyMany({
      orgId: input.orgId,
      userIds: recipients,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      kind: input.kind,
      title: input.title,
      body: input.body,
      link: input.link,
      resourceType: input.resource.type,
      resourceId: input.resource.id,
      metadata: input.metadata,
    });
  }

  // 2) Email — queueEmail already checks notification_preferences + dedupes
  //    within a 60s window, so per-user opt-outs are honored automatically.
  if (channels.includes("email")) {
    const emailByUid = await emailsFor(input.orgId, recipients);
    const resourceType = EMAILABLE.includes(input.resource.type)
      ? (input.resource.type as "ticket" | "project" | "document")
      : undefined;
    await Promise.all(
      recipients.map((uid) => {
        const to = emailByUid.get(uid);
        if (!to) return Promise.resolve();
        return queueEmail({
          orgId: input.orgId,
          toUserId: uid,
          toEmail: to,
          subject: input.email?.subject ?? input.title,
          bodyText: input.email?.bodyText ?? input.body ?? input.title,
          bodyHtml: input.email?.bodyHtml,
          resourceType,
          resourceId: input.resource.id,
          eventType: categoryToEventType(input.category),
          metadata: input.metadata,
        });
      }),
    );
  }

  // 3) Browser push — additive + fail-safe. No-op until Phase 5 wiring + VAPID
  //    keys exist; never throws into the caller.
  if (channels.includes("push")) {
    try {
      await sendPushSafe({
        orgId: input.orgId,
        userIds: recipients,
        title: input.title,
        body: input.body,
        link: input.link,
      });
    } catch {
      /* push must never break the core flow */
    }
  }
}

/** uid → email lookup for an org, limited to the given recipients. */
async function emailsFor(orgId: string, uids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (uids.length === 0) return map;
  const { data } = await supabase
    .from("org_members")
    .select("uid, email")
    .eq("org_id", orgId)
    .in("uid", uids);
  ((data as Array<{ uid: string; email: string | null }> | null) ?? []).forEach((m) => {
    if (m.email) map.set(m.uid, m.email);
  });
  return map;
}
