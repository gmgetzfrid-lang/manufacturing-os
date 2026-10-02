// lib/notify/dispatch.ts
//
// THE single entry point every producer should call. One event in → resolved
// recipients (from all follow systems) → fanned out to every delivery channel
// (in-app bell, email), each honoring per-user, per-channel preferences.
//
// It wraps the existing notifyMany()/queueEmail() helpers rather than replacing
// them, so producers can migrate to emit() one at a time with zero regression.

import { notifyMany, type NotificationKind } from "@/lib/inAppNotifications";
import { queueEmail } from "@/lib/notifications";
import { supabase } from "@/lib/supabase";
import {
  activeMembersOf,
  resolveFollowers,
  resolveRoleRecipients,
  resolveProjectMembers,
  type ResourceRef,
  type ResourceType,
} from "./recipients";
export type NotifChannel = "inapp" | "email";
export type NotifCategory = "mention" | "assignment" | "status" | "watched" | "sla" | "system" | "recall" | "safety";

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
  /** Who hears about it. The union of every provided source, minus the
   *  actor, limited to ACTIVE members of `orgId` (NEDGE-3). A role pool or the
   *  follow list makes the event a broadcast: its email subject is derived
   *  from the category, never the title (NEDGE-6 — see broadcastSubject). */
  audience: {
    involved?: string[];   // explicit stakeholders (requester/assignee/mentions)
    followers?: boolean;   // walk resolveFollowers(resource)
    roles?: string[];      // a role pool in the org
    projectId?: string;    // members of a project
  };
  /** Defaults to both channels (in-app and email). Pass a subset to
   *  force-limit a noisy event. */
  channels?: NotifChannel[];
  /** An explicit subject / body is sent as given. Without one, an email to
   *  named people only takes the title as its subject; a broadcast's subject
   *  is broadcastSubject(category, resource.type) and the title leads the
   *  body instead. */
  email?: { subject?: string; bodyText?: string; bodyHtml?: string };
  metadata?: Record<string, unknown>;
}

// Map our preference category to the eventType string queueEmail understands,
// so the existing per-category email toggles keep working unchanged.
// Exported for the test that pins which categories are un-mutable.
export function categoryToEventType(c: NotifCategory): string {
  switch (c) {
    case "mention": return "comment_mention";
    case "assignment": return "assignment";
    case "status": return "ticket_status_changed";
    case "watched": return "watcher_activity";
    case "sla": return "sla_warning";
    // DIST-13: a drawing recall is a SAFETY message, not ticket churn — it
    // must never ride a toggle someone muted for noise. "safety_recall" is
    // unknown to shouldSendForEvent's switch, so it falls to the default and
    // is always emailed.
    case "recall": return "safety_recall";
    // LIFE-7: a PSM finding (an undocumented field change) is the same class
    // as a recall — "safety_alert" is likewise unknown to shouldSendForEvent,
    // so no per-category toggle can silence it.
    case "safety": return "safety_alert";
    default: return "system";
  }
}

// queueEmail only types these three resource kinds; others email with no link
// scope (still delivered, just not resource-typed).
const EMAILABLE: ResourceType[] = ["ticket", "project", "document"];

const RESOURCE_NOUN: Record<ResourceType, string> = {
  ticket: "a request",
  document: "a document",
  project: "a project",
  asset: "an asset",
  library: "a library",
};

/** NEDGE-6 (egress): the subject of a BROADCAST email — one whose audience
 *  includes a role pool or the follow list, people the producer did not name.
 *  A title can carry a document number and a free-text reason ("HOLD placed
 *  on PID-4412-R3 — litigation hold …"); a subject line is what a mail
 *  provider, a lock screen and an inbox list show, so a broadcast's subject
 *  names only the category and the kind of resource. The title leads the
 *  email body instead. Exported for the test that pins every subject. */
export function broadcastSubject(c: NotifCategory, resourceType: ResourceType): string {
  const noun = RESOURCE_NOUN[resourceType] ?? "an item";
  switch (c) {
    case "mention": return `You were mentioned on ${noun}`;
    case "assignment": return `New assignment on ${noun}`;
    case "status": return `Status change on ${noun}`;
    case "watched": return `New activity on ${noun}`;
    case "sla": return `Overdue: ${noun} needs attention`;
    case "recall": return `Recall notice for ${noun}`;
    case "safety": return `Safety alert on ${noun}`;
    default: return `Workspace notice about ${noun}`;
  }
}

/** Resolve the deduped recipient set for an event: the union of every
 *  audience source, minus the actor, limited to ACTIVE members of the org
 *  (NEDGE-3 — once, centrally, involved[] included). emit() is its only
 *  caller today; it is exported so a "who will this notify" preview reads
 *  the same set the send uses (no such preview exists yet — PROD-7). */
export async function resolveRecipients(input: EmitInput): Promise<string[]> {
  const ids = new Set<string>();
  (input.audience.involved ?? []).forEach((u) => u && ids.add(u));

  const tasks: Promise<string[]>[] = [];
  if (input.audience.followers) tasks.push(resolveFollowers(input.resource, input.orgId));
  if (input.audience.roles?.length) tasks.push(resolveRoleRecipients(input.orgId, input.audience.roles));
  if (input.audience.projectId) tasks.push(resolveProjectMembers(input.audience.projectId));
  for (const list of await Promise.all(tasks)) list.forEach((u) => u && ids.add(u));

  if (input.actorUserId) ids.delete(input.actorUserId);
  return activeMembersOf(input.orgId, Array.from(ids));
}

/** Fan one event out to every enabled channel. Fire-and-forget friendly. */
export async function emit(input: EmitInput): Promise<void> {
  const recipients = await resolveRecipients(input);
  if (recipients.length === 0) return;
  const channels = input.channels ?? ["inapp", "email"];

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
    // NEDGE-6: a broadcast never puts the title in the subject line.
    const broadcast = !!input.audience.followers || (input.audience.roles?.length ?? 0) > 0;
    const subject = input.email?.subject
      ?? (broadcast ? broadcastSubject(input.category, input.resource.type) : input.title);
    const bodyText = input.email?.bodyText
      ?? (broadcast && input.body ? `${input.title}\n\n${input.body}` : input.body ?? input.title);
    await Promise.all(
      recipients.map((uid) => {
        const to = emailByUid.get(uid);
        if (!to) return Promise.resolve();
        return queueEmail({
          orgId: input.orgId,
          toUserId: uid,
          toEmail: to,
          subject,
          bodyText,
          bodyHtml: input.email?.bodyHtml,
          resourceType,
          resourceId: input.resource.id,
          eventType: categoryToEventType(input.category),
          metadata: input.metadata,
        });
      }),
    );
  }

}

/** uid → email lookup for an org, limited to the given recipients who are
 *  ACTIVE members (NEDGE-3 done-when 2 — the second layer: a suspended or
 *  inactive member's address is never read even when the recipient filter
 *  could not run). */
async function emailsFor(orgId: string, uids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (uids.length === 0) return map;
  const { data } = await supabase
    .from("org_members")
    .select("uid, email")
    .eq("org_id", orgId)
    .eq("status", "active")
    .in("uid", uids);
  ((data as Array<{ uid: string; email: string | null }> | null) ?? []).forEach((m) => {
    if (m.email) map.set(m.uid, m.email);
  });
  return map;
}
