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
import { renderNotificationEmail, requireEmailOrigin } from "@/lib/emailRender";
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
   *  actor, limited to ACTIVE members of `orgId` (NEDGE-3). Someone the
   *  producer names in `involved` gets the title as the email subject;
   *  someone reached only through a role pool or the follow list gets a
   *  subject derived from the category (NEDGE-6 — see broadcastSubject and
   *  emailSubjectFor). */
  audience: {
    involved?: string[];   // explicit stakeholders (requester/assignee/mentions)
    followers?: boolean;   // walk resolveFollowers(resource)
    roles?: string[];      // a role pool in the org
    projectId?: string;    // members of a project
  };
  /** Defaults to both channels (in-app and email). Pass a subset to
   *  force-limit a noisy event. */
  channels?: NotifChannel[];
  /** An explicit subject / body is sent as given, to everyone. Without one,
   *  the subject is decided per recipient (emailSubjectFor): the title for
   *  someone the producer named, broadcastSubject(category, resource.type)
   *  for anyone else in an event that reaches a role pool or the follow
   *  list, and for everyone when the kind's title carries a free-text
   *  reason (REASON_IN_TITLE) — the title then leads the body instead. */
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

/** NEDGE-6 (egress): the subject of an email to someone the producer did
 *  not name — reached only through a role pool or the follow list — and of
 *  every email of a kind whose title carries a free-text reason. A title can
 *  carry a document number and a free-text reason ("HOLD placed on
 *  PID-4412-R3 — litigation hold …"); a subject line is what a mail
 *  provider, a lock screen and an inbox list show, so this subject names
 *  only the category and the kind of resource. The title leads the email
 *  body instead. Exported for the test that pins every subject. */
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

/** NEDGE-6: the kinds whose title carries a free-text reason typed by a
 *  person — a hold's "HOLD placed on PID-4412 — <reason>" (lib/holds.ts
 *  notifyHoldChange) and the aging nudge's "Hold past its expected release —
 *  <label> (<reason>)" (scanStaleHolds). Their email subject is
 *  broadcastSubject for EVERY recipient, the named ones too: a hold's
 *  release pool is resolved from the policy's roles but passed as
 *  `involved`, so naming is no proof the reader should see the reason on a
 *  lock screen. A producer that passes `email.subject` overrides it.
 *  lib/__tests__/notificationDispatchMembership.test.ts pins every emit()
 *  title that interpolates a reason to a kind listed here. */
export const REASON_IN_TITLE: ReadonlySet<NotificationKind> = new Set<NotificationKind>(["hold_opened"]);

/** NEDGE-6: whether `uid`'s email of this event carries the title as its
 *  subject. Decided per recipient: someone the producer named in
 *  `involved` keeps the title — the document number they triage and search
 *  by — unless the kind's title carries a free-text reason; anyone else
 *  keeps it only when the event reaches no role pool and no follow list (an
 *  event to named people and project members, as before). */
export function titleIsSubjectFor(
  input: EmitInput, uid: string, named: ReadonlySet<string> = new Set(input.audience.involved ?? []),
): boolean {
  if (REASON_IN_TITLE.has(input.kind)) return false;
  const broadcast = !!input.audience.followers || (input.audience.roles?.length ?? 0) > 0;
  return !broadcast || named.has(uid);
}

/** NEDGE-6: the subject and plain-text body of `uid`'s email of this event
 *  (`named` — the producer's `involved`, as a set — is passed by emit() once
 *  per event). */
export function emailSubjectFor(
  input: EmitInput, uid: string, named: ReadonlySet<string> = new Set(input.audience.involved ?? []),
): { subject: string; bodyText: string } {
  const plain = titleIsSubjectFor(input, uid, named);
  return {
    subject: input.email?.subject ?? (plain ? input.title : broadcastSubject(input.category, input.resource.type)),
    bodyText: input.email?.bodyText
      ?? (!plain && input.body ? `${input.title}\n\n${input.body}` : input.body ?? input.title),
  };
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

/** What one emit() reached (DELIV-7 dw4): how many recipients the audience
 *  resolved to, and — when the bell channel ran — how many bell rows landed
 *  and how many were refused (notifyMany; each refusal is logged there). */
export interface EmitResult {
  recipients: number;
  inapp?: { sent: number; failed: number };
}

/** Fan one event out to every enabled channel. Fire-and-forget friendly:
 *  never throws for a refused row; a caller that needs to know reads the
 *  result. */
export async function emit(input: EmitInput): Promise<EmitResult> {
  const recipients = await resolveRecipients(input);
  if (recipients.length === 0) {
    // DELIV-7 dw4: a fan-out that reaches nobody is observable, not silent.
    console.warn("[notify] emit reached no recipient", {
      orgId: input.orgId, kind: input.kind, category: input.category,
      resource: `${input.resource.type}:${input.resource.id}`,
      audience: {
        involved: input.audience.involved?.length ?? 0, followers: !!input.audience.followers,
        roles: input.audience.roles ?? [], projectId: input.audience.projectId ?? null,
      },
    });
    return { recipients: 0 };
  }
  const channels = input.channels ?? ["inapp", "email"];
  const result: EmitResult = { recipients: recipients.length };

  // 1) In-app bell — reuse the existing fan-out helper (it also drops the actor
  //    and dedupes recipients defensively).
  if (channels.includes("inapp")) {
    result.inapp = await notifyMany({
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
    const named = new Set(input.audience.involved ?? []);
    // NEDGE-4 / NEDGE-10 (N6): the email carries the event's link, ABSOLUTE
    // on the public origin, and the footer — rendered once per recipient by
    // lib/emailRender.ts. No public origin (a server with nothing
    // configured): the email is still queued, in today's plain form, and the
    // gap is logged — a dropped notice is worse than one without a button. A
    // producer's own HTML (email.bodyHtml) is sent as given.
    let origin: string | null = null;
    try {
      origin = requireEmailOrigin();
    } catch (e) {
      console.warn(`[notify] ${(e as Error).message} (emit ${input.kind} — queued without a link or footer)`);
    }
    const orgName = origin && !input.email?.bodyHtml ? await orgNameFor(input.orgId) : null;
    await Promise.all(
      recipients.map((uid) => {
        const to = emailByUid.get(uid);
        if (!to) return Promise.resolve();
        // NEDGE-6: the subject is decided per recipient — never the title for
        // someone reached only through a role pool or the follow list.
        const { subject, bodyText } = emailSubjectFor(input, uid, named);
        const rendered = origin && !input.email?.bodyHtml
          ? renderNotificationEmail({ subject, body: bodyText, link: input.link, orgName, origin })
          : null;
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
          ...(rendered ? { rendered: { bodyText: rendered.bodyText, bodyHtml: rendered.bodyHtml }, link: rendered.link ?? undefined } : {}),
        });
      }),
    );
  }

  return result;
}

/** The workspace's name for the email's header and footer — read once per
 *  org and kept for the life of the module (an org rename shows on the next
 *  load). A read that fails or finds nothing renders "your workspace". */
const orgNames = new Map<string, string>();
async function orgNameFor(orgId: string): Promise<string | null> {
  const hit = orgNames.get(orgId);
  if (hit) return hit;
  try {
    const { data } = await supabase.from("orgs").select("name").eq("id", orgId).maybeSingle();
    const name = ((data as { name?: unknown } | null)?.name ?? null) as string | null;
    if (typeof name === "string" && name.trim()) {
      orgNames.set(orgId, name.trim());
      return name.trim();
    }
  } catch { /* the footer says "your workspace" */ }
  return null;
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
