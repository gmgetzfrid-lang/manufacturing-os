// lib/notify/dispatch.ts
//
// THE single entry point every producer should call. One event in → resolved
// recipients (from all follow systems) → fanned out to every delivery channel
// (in-app bell, email, and — for the push-worthy kinds — Web Push), each
// honoring per-user, per-channel preferences.
//
// Push (notifications Round G, N10 — GAP-205, OS-9): the third leg runs only
// after the bell and email legs have finished, never throws into the caller
// and never changes what they did (a push failure is logged only — the
// deleted 0bb13ed sendPushSafe contract). It is sent only for a kind
// KIND_META marks pushWorthy, only to the recipients told IN FULL (a
// follower sent the redacted notice gets no push — DEC-106 item 2), and only
// beside the bell leg (push follows a bell row). In the browser the leg asks
// POST /api/push/notify (fire-and-forget, keepalive); on the server it calls
// the sender THE CALLER passes (EmitInput.serverPush — lib/push/sendPush.ts
// pushFromServer), and without one it pushes nothing (fix pass: no global
// registration, so a server emit never pushes because some other route
// loaded the sender into the same process). This file is bundled for the
// browser and never imports web-push or the service role. Who is actually
// pushed — push_enabled, a device the person turned on, the bell row that
// landed, VAPID configured — is decided in the sender.
//
// Library notices (notifications Round G, N16 — NEDGE-22): a notice about a
// library that names a document in it (EmitInput.namesDocuments) tells a
// follower the name only while they may discover the document — the same
// check a document's follower gets (DEC-106); a follower who may not gets the
// notice without the name (unnamedNotice), so nobody who follows the library
// stops hearing about it. Someone the producer names (a transmittal's
// document owner) is spared the check only for the document(s) they are
// involved with; every other document the notice names is checked for them
// too (NEDGE-22 done-when 2, DEC-90).
//
// It wraps the existing notifyMany()/queueEmail() helpers rather than replacing
// them, so producers can migrate to emit() one at a time with zero regression.

import { notify, notifyMany, notifyBatchWithReason, type NotificationKind } from "@/lib/inAppNotifications";
import { queueEmail } from "@/lib/notifications";
import { supabase } from "@/lib/supabase";
import { renderNotificationEmail, requireEmailOrigin } from "@/lib/emailRender";
import { KIND_META, kindMeta } from "@/lib/notificationKinds";
import {
  activeMembersOf,
  discoveringAmong,
  resolveFollowers,
  resolveRoleRecipients,
  resolveProjectMembers,
  type ResourceRef,
  type ResourceType,
} from "./recipients";
export type NotifChannel = "inapp" | "email" | "push";
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
    /** People left out whatever source reached them — the ones a personal
     *  notice of the same event already told (PROD-17: a follower's FYI
     *  beside the holder's own notice). */
    exclude?: string[];
  };
  /** Defaults to every channel (in-app, email, and push — which sends only
   *  for a KIND_META.pushWorthy kind, beside the in-app leg). Pass a subset
   *  to force-limit a noisy event: `["inapp"]` never attempts push. */
  channels?: NotifChannel[];
  /** The SERVER push sender (N10 fix pass), passed only by a server caller
   *  that is allowed to push: `serverPush: pushFromServer`
   *  (lib/push/sendPush.ts). On the server, an emit without it attempts no
   *  push — whichever modules the process has loaded; the maintenance cron
   *  passes none (DEC-90 ruling 3: the cron only prunes). In the browser it
   *  is ignored: the leg asks POST /api/push/notify. */
  serverPush?: PushSender;
  /** Write the in-app rows as ONE insert statement (notifyBatchWithReason)
   *  instead of one request per recipient (notifyMany). For a chatty fan-out
   *  written from the browser to many people (the schedule's notices to a
   *  project — lib/milestones.ts, N8's final review fix): 20261160 counts a
   *  repeat row (the same kind about the same resource to that person within
   *  the minute) again under the writer's advisory lock, one row after
   *  another, and each of notifyMany's parallel requests would hold a pooled
   *  connection while it waits; one statement holds one connection however
   *  the lock is taken. A row for someone the rail skips (not an active
   *  member) does not sink it; a cap refusal (P0001) refuses the whole
   *  statement, and is logged. */
  inappOneStatement?: boolean;
  /** DELIV-16 (notifications N15): write each bell row through
   *  lib/complianceNotify.ts notifyCompliance — retried where a read-back is
   *  authoritative, dead-lettered when it never lands (DEC-102) — even for a
   *  kind the registry does not flag compliance (a hold's stop-work notice,
   *  the hold-aging nudge). A compliance kind (KIND_META) always is. A
   *  scan's notice passes its `retryKey` (`<scan>:<row id>`) so its dead
   *  letter is sent again by the scan's next run (loadScanRetryPlan). */
  inappRetry?: { retryKey?: string };
  /** notifications N15 (fix pass — TAX-17 / PROD-17 deploy window): email
   *  only the recipients whose bell row LANDED. For a kind a paste declares
   *  (20261206), written from the browser if that paste is late:
   *  20261160's rail refuses the row as an undeclared kind, and without this
   *  the email would still go — a notice the reader cannot find in the app.
   *  The bell rows are written one per recipient (inappOneStatement is
   *  ignored); with no in-app channel it has no effect. */
  emailOnlyWithBell?: boolean;
  /** An explicit subject / body is sent as given, to everyone. Without one,
   *  the subject is decided per recipient (emailSubjectFor): the title for
   *  someone the producer named, broadcastSubject(category, resource.type)
   *  for anyone else in an event that reaches a role pool or the follow
   *  list, and for everyone when the kind's title carries a free-text
   *  reason (REASON_IN_TITLE) — the title then leads the body instead. */
  email?: { subject?: string; bodyText?: string; bodyHtml?: string };
  metadata?: Record<string, unknown>;
  /** NEDGE-22 (notifications N16): the documents this notice NAMES when its
   *  resource is not a document — a library's follower notice ("P-4412 →
   *  Rev C", "New document: P-101", a transmittal's list). A recipient
   *  reached ONLY through the follow list is told the names only while they
   *  may discover EVERY named document (discoveringAmong — the DEC-106 rules,
   *  the library rung the library page evaluates); a follower who may not
   *  gets `unnamed` instead (unnamedNotice — no document named, nobody
   *  dropped: they follow the library, not the document); a check that FAILS
   *  sends the follower it could not settle redactedNotice(), as DEC-106 does
   *  for a document; controllers are never dropped (DEC-43). Someone the
   *  producer names in `involved` is exempt from the check only for the
   *  named document(s) they are involved with (`involved` below — NEDGE-22
   *  done-when 2, the integrator's ruling under DEC-90, 2026-10-14); every
   *  OTHER named document is checked for them as for a follower, with the
   *  same three outcomes. A role pool and a project roster are not filtered.
   *  Ignored on a document resource (the document's own check runs). At most
   *  a handful of ids — only the ones the title and body actually name. */
  namesDocuments?: {
    ids: string[];
    /** What a follower who may not discover every named document reads: a
     *  title, body and link that name none of them (the link must not carry
     *  a document either). Absent: the category's generic subject, a generic
     *  body and the producer's link. */
    unnamed?: { title: string; body?: string; link?: string };
    /** NEDGE-22 done-when 2 (DEC-90, 2026-10-14): who in `audience.involved`
     *  is involved with each named document — document id → uids (a
     *  transmittal's document → its accountable owner). A person is exempt
     *  from the check for the documents listed for them and checked for
     *  every other named document. Absent: a notice that names ONE document
     *  exempts every involved person (they are involved with the one thing
     *  it names — unchanged); a notice that names several checks an involved
     *  person for every named document (fail safe: the notice without the
     *  names, never a name unchecked; nobody dropped). */
    involved?: Record<string, string[]>;
  };
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

/** NEDGE-22 (notifications N16): how many of one notice's named documents
 *  are asked about at once — a transmittal names at most five. The checks of
 *  one notice run side by side up to this bound (each is a round trip in the
 *  browser), and every outcome is the same as asking one after another.
 *  Exported for the test. */
export const NAMED_DOCUMENT_CHECKS_AT_ONCE = 5;

/** `fn` over `items`, at most `limit` running at once, answers in input
 *  order. Started in input order: with no more items than `limit`, every
 *  call starts before any answers. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** NEDGE-22 done-when 2 (DEC-90, 2026-10-14): whether `uid` (named in
 *  `audience.involved`) is involved with named document `documentId` — and
 *  so not asked about it. The producer's `namesDocuments.involved` decides;
 *  without it, a notice that names ONE document is about the thing every
 *  involved person is involved with (unchanged), and a notice that names
 *  several leaves every named document to the check (fail safe). Only
 *  people in `audience.involved` are ever involved. */
function involvementOf(input: EmitInput, named: readonly string[]): (uid: string, documentId: string) => boolean {
  const involved = new Set((input.audience.involved ?? []).filter(Boolean));
  const map = input.namesDocuments?.involved;
  if (map) {
    const by = new Map(Object.entries(map).map(([d, us]) => [d, new Set((Array.isArray(us) ? us : []).filter(Boolean))] as const));
    return (uid, documentId) => involved.has(uid) && (by.get(documentId)?.has(uid) ?? false);
  }
  const one = named.length === 1;
  return (uid) => one && involved.has(uid);
}

/** Resolve the deduped recipient set for an event: the union of every
 *  audience source, minus the actor, limited to ACTIVE members of the org
 *  (NEDGE-3 — once, centrally, involved[] included). emit() reads the same
 *  set (resolveAudience); it is exported so a "who will this notify" preview
 *  reads the set the send uses (no such preview exists yet — PROD-7). A
 *  recipient sent the REDACTED notice (resolveAudience) is in it: they get a
 *  row too. */
export async function resolveRecipients(input: EmitInput): Promise<string[]> {
  const { full, redacted, unnamed } = await resolveAudience(input);
  return [...full, ...redacted, ...unnamed];
}

/** emit()'s audience, in three parts: `full` — the people sent the notice as
 *  the producer wrote it; `redacted` — a document's followers the discover
 *  check could not settle (it ran and FAILED — a 503, a thrown fetch, an
 *  expired token), sent redactedNotice() instead (NEDGE-6, N15 fix pass).
 *  Before N15 every follower was told; a follower the check could not
 *  settle is neither cut off (a hold's stop-work notice must reach the
 *  people working the document) nor told the document's name or the
 *  reason (they might not be allowed to know it exists). `unnamed`
 *  (NEDGE-22, N16) — a library's followers the check ANSWERED for who may
 *  not discover a document the notice names (namesDocuments), sent
 *  unnamedNotice(): the library notice without the document. */
export async function resolveAudience(input: EmitInput): Promise<{ full: string[]; redacted: string[]; unnamed: string[] }> {
  const ids = new Set<string>();
  (input.audience.involved ?? []).forEach((u) => u && ids.add(u));

  const tasks: Promise<string[]>[] = [];
  if (input.audience.roles?.length) tasks.push(resolveRoleRecipients(input.orgId, input.audience.roles));
  if (input.audience.projectId) tasks.push(resolveProjectMembers(input.audience.projectId));
  const [followers, ...lists] = await Promise.all([
    input.audience.followers ? resolveFollowers(input.resource, input.orgId) : Promise.resolve([] as string[]),
    ...tasks,
  ]);
  // the people a role pool or a project roster reached (never filtered here)
  const pooled = new Set<string>();
  for (const list of lists) list.forEach((u) => { if (u) { ids.add(u); pooled.add(u); } });

  // NEDGE-6 done-when 3 (N15): a follower reached ONLY through the follow
  // list of a DOCUMENT is kept only while they may discover it — a hidden or
  // private document, or an ACL that no longer includes them, takes them out
  // (discoveringAmong; controllers are never dropped, DEC-43). Someone the
  // producer named, a role pool and a project roster are the producer's
  // choice and are not filtered here. A check that FAILS settles nobody but
  // the controllers: the rest are moved to the redacted notice (fix pass).
  const followerOnly = followers.filter((u) => u && !ids.has(u) && u !== input.actorUserId);
  followers.forEach((u) => u && ids.add(u));
  const unsettled = new Set<string>();
  if (input.resource.type === "document" && followerOnly.length > 0) {
    const filter = await discoveringAmong(input.orgId, input.resource.id, followerOnly);
    const kept = new Set(filter.uids);
    followerOnly.forEach((u) => {
      if (kept.has(u)) return;
      ids.delete(u);
      if (filter.outcome === "failed") unsettled.add(u);
    });
    if (unsettled.size > 0) {
      console.warn(`[notify] ${unsettled.size} follower(s) of document ${input.resource.id} the discover check could not settle get the ${input.kind} notice without its details`);
    }
  }

  // NEDGE-22 (N16): a notice about a LIBRARY (any non-document resource)
  // that NAMES documents tells a follower reached only through the follow
  // list those names only while they may discover every one of them — the
  // same check, for each named document (discoveringAmong). Nobody is
  // dropped: a follower a check ANSWERED for who may not discover one gets
  // the notice without the names (unnamedNotice); one a FAILED check could
  // not settle gets redactedNotice() (DEC-106 item 2); a controller passes
  // the check, and its failure path keeps them (DEC-43). The named
  // documents are asked about side by side, up to
  // NAMED_DOCUMENT_CHECKS_AT_ONCE at a time (in the browser, one round
  // trip's wait for up to five documents, not one per document — the notice
  // is fire-and-forget, and a closed tab loses whatever is still waiting):
  // told in full only when every answer keeps them; ruled out by any answer
  // that was given → unnamed; otherwise left out by a failed check →
  // redacted.
  //
  // NEDGE-22 done-when 2 (the integrator's ruling under DEC-90, 2026-10-14):
  // someone the producer names in `involved` (a transmittal's document
  // owner) is exempt only for the named document(s) they are involved with
  // (involvementOf); every OTHER named document is asked about them in the
  // same request as the followers, with the same three outcomes. A notice
  // that names one document asks nothing about the people involved with it
  // (unchanged). A role pool and a project roster are not filtered.
  const unnamed = new Set<string>();
  const named = input.resource.type === "document"
    ? []
    : [...new Set((input.namesDocuments?.ids ?? []).filter((d): d is string => typeof d === "string" && d.length > 0))];
  const involvedWith = involvementOf(input, named);
  const involvedChecked = named.length === 0 ? [] : [...new Set(input.audience.involved ?? [])]
    .filter((u) => !!u && u !== input.actorUserId && !pooled.has(u) && named.some((d) => !involvedWith(u, d)));
  const subjects = [...followerOnly, ...involvedChecked];
  if (named.length > 0 && subjects.length > 0) {
    // asked about each named document: every follower-only recipient, and
    // each involved person who is not involved with that document
    const asked = named.map((d) => subjects.filter((u) => !involvedWith(u, d)));
    const answers = await mapBounded(named, NAMED_DOCUMENT_CHECKS_AT_ONCE, (documentId, i) => discoveringAmong(input.orgId, documentId, asked[i]));
    const keptBy = answers.map((a) => new Set(a.uids));
    const askedAbout = asked.map((a) => new Set(a));
    for (const u of subjects) {
      const mine = named.map((_, i) => i).filter((i) => askedAbout[i].has(u));
      if (mine.every((i) => keptBy[i].has(u))) continue;
      const ruledOut = mine.some((i) => answers[i].outcome !== "failed" && !keptBy[i].has(u));
      (ruledOut ? unnamed : unsettled).add(u);
      ids.delete(u);
    }
    if (unsettled.size > 0) {
      console.warn(`[notify] ${unsettled.size} follower(s) of ${input.resource.type} ${input.resource.id} the discover check could not settle get the ${input.kind} notice without its details`);
    }
  }

  if (input.actorUserId) { ids.delete(input.actorUserId); unsettled.delete(input.actorUserId); unnamed.delete(input.actorUserId); }
  (input.audience.exclude ?? []).forEach((u) => { ids.delete(u); unsettled.delete(u); unnamed.delete(u); });
  const active = new Set(await activeMembersOf(input.orgId, [...ids, ...unsettled, ...unnamed]));
  return {
    full: [...ids].filter((u) => active.has(u)),
    redacted: [...unsettled].filter((u) => active.has(u)),
    unnamed: [...unnamed].filter((u) => active.has(u)),
  };
}

/** The redacted title of a kind whose generic category subject would hide
 *  what the reader must do (a hold is a stop-work signal). No document name,
 *  no reason. */
const REDACTED_TITLE: Partial<Record<NotificationKind, string>> = {
  hold_opened: "HOLD placed on a document you follow",
  hold_released: "Hold released on a document you follow",
};

/** NEDGE-6 (N15 fix pass): the notice a follower the discover check could
 *  not settle receives — the event's kind, resource, link and channels, but
 *  a generic title and body (REDACTED_TITLE, else broadcastSubject), no
 *  document label, no free-text reason, none of the producer's metadata or
 *  email copy. Opening the link shows the document only to someone allowed
 *  to read it (the page's own read). NEDGE-6 done-when 1's redaction model:
 *  nothing leaks, nothing is lost. Exported for the test. */
export function redactedNotice(input: EmitInput): EmitInput {
  const title = REDACTED_TITLE[input.kind] ?? broadcastSubject(input.category, input.resource.type);
  const body = `Open it to see which ${input.resource.type === "document" ? "document" : "item"} and what changed. The details are left out of this notice because whether you may see it could not be confirmed when it was sent.`;
  return {
    ...input,
    title,
    body,
    // NEDGE-22 (N16): a library notice's own link can carry the named
    // document (`?doc=`); the producer's document-free link replaces it.
    ...(input.resource.type !== "document" && input.namesDocuments?.unnamed?.link ? { link: input.namesDocuments.unnamed.link } : {}),
    audience: {},
    metadata: { redacted: true },
    email: { subject: title, bodyText: `${title}\n\n${body}` },
  };
}

/** NEDGE-22 (notifications N16): the body of a library notice that names no
 *  document, when its producer words none. */
export const UNNAMED_BODY = "Open it to see what you have access to.";

/** NEDGE-22 (N16): the notice a library's follower receives when the check
 *  ANSWERED that they may not discover a document it names — the producer's
 *  `namesDocuments.unnamed` wording (else the category's generic subject and
 *  UNNAMED_BODY), its document-free link, the same kind, resource and
 *  channels, none of the producer's metadata or email copy. No document
 *  number or title; marked `metadata.redacted`, so it never earns a push
 *  (DEC-108 §1). Exported for the test. */
export function unnamedNotice(input: EmitInput): EmitInput {
  const u = input.namesDocuments?.unnamed;
  const title = u?.title ?? broadcastSubject(input.category, input.resource.type);
  const body = u?.body ?? UNNAMED_BODY;
  return {
    ...input,
    title,
    body,
    link: u?.link ?? input.link,
    audience: {},
    metadata: { redacted: true },
    email: { subject: title, bodyText: `${title}\n\n${body}` },
  };
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
  const { full, redacted, unnamed } = await resolveAudience(input);
  if (full.length + redacted.length + unnamed.length === 0) {
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
  const result = await deliver(input, full, { push: true });
  // NEDGE-6 (N15 fix pass): the followers a failed discover check could not
  // settle — one row and one email each, without the document's name. No
  // push (N10, DEC-106 item 2): only a recipient told in full is pushed.
  // NEDGE-22 (N16): a library's followers who may not discover a document
  // the notice names — one row and one email each, the notice without the
  // document (unnamedNotice). No push either.
  const parts: Array<[EmitInput, string[]]> = [];
  if (redacted.length > 0) parts.push([redactedNotice(input), redacted]);
  if (unnamed.length > 0) parts.push([unnamedNotice(input), unnamed]);
  for (const [notice, to] of parts) {
    const r = await deliver(notice, to, { push: false });
    if (r.inapp) {
      result.inapp = {
        sent: (result.inapp?.sent ?? 0) + r.inapp.sent,
        failed: (result.inapp?.failed ?? 0) + r.inapp.failed,
      };
    }
  }
  return { ...result, recipients: full.length + redacted.length + unnamed.length };
}

/** One notice to `recipients` on every enabled channel (emit's body).
 *  `push`: whether these recipients may be pushed (the full audience; never
 *  the redacted one). */
async function deliver(input: EmitInput, recipients: string[], opts: { push: boolean }): Promise<EmitResult> {
  if (recipients.length === 0) return { recipients: 0 };
  const channels = input.channels ?? DEFAULT_CHANNELS;
  const result: EmitResult = { recipients: recipients.length };
  // emailOnlyWithBell: the recipients whose bell row landed (null: everyone)
  let bellLanded: Set<string> | null = null;
  // the push leg (N10): the recipients whose bell row landed, where the
  // in-app leg answers per recipient (null: not known — the sender checks)
  let pushLanded: Set<string> | null = null;

  // 1) In-app bell — reuse the existing fan-out helper (it also drops the actor
  //    and dedupes recipients defensively), or, when the producer asks for it,
  //    ONE statement for every recipient (inappOneStatement). Either way the
  //    result says how many bell rows landed (DELIV-7 dw4).
  if (channels.includes("inapp") && input.inappOneStatement && !input.emailOnlyWithBell) {
    const { landed, error } = await notifyBatchWithReason(recipients.map((uid) => ({
      orgId: input.orgId,
      userId: uid,
      kind: input.kind,
      title: input.title,
      body: input.body,
      link: input.link,
      resourceType: input.resource.type,
      resourceId: input.resource.id,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      metadata: input.metadata,
    })));
    if (error) console.warn(`[notify] the ${input.kind} notice reached none of its ${recipients.length} recipient(s): ${error}`);
    result.inapp = { sent: landed, failed: recipients.length - landed };
  } else if (channels.includes("inapp") && (KIND_META[input.kind]?.compliance || input.inappRetry)) {
    // DELIV-16 (N15): a compliance kind's bell row (and any row the producer
    // asks to be retried) goes through notifyCompliance, one row per
    // recipient as notifyMany writes them — the same typed row first, a
    // bounded retry where the writer can read it back, a dead letter when it
    // never lands. The answer counts what landed, as before.
    const { notifyCompliance } = await import("@/lib/complianceNotify");
    const opts = input.inappRetry?.retryKey ? { retryKey: input.inappRetry.retryKey } : undefined;
    const landed = await Promise.all(recipients.map((uid) => notifyCompliance({
      orgId: input.orgId,
      userId: uid,
      kind: input.kind,
      title: input.title,
      body: input.body,
      link: input.link,
      resourceType: input.resource.type,
      resourceId: input.resource.id,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      metadata: input.metadata,
    }, opts)));
    const sent = landed.filter(Boolean).length;
    result.inapp = { sent, failed: landed.length - sent };
    pushLanded = new Set(recipients.filter((_, i) => landed[i]));
    if (input.emailOnlyWithBell) bellLanded = pushLanded;
  } else if (channels.includes("inapp") && input.emailOnlyWithBell) {
    // one typed row per recipient, as notifyMany writes them, answering
    // which landed (the email follows only those)
    const landed = await Promise.all(recipients.map((uid) => notify({
      orgId: input.orgId,
      userId: uid,
      kind: input.kind,
      title: input.title,
      body: input.body,
      link: input.link,
      resourceType: input.resource.type,
      resourceId: input.resource.id,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      metadata: input.metadata,
    })));
    const sent = landed.filter(Boolean).length;
    result.inapp = { sent, failed: landed.length - sent };
    bellLanded = new Set(recipients.filter((_, i) => landed[i]));
    pushLanded = bellLanded;
    if (bellLanded.size < recipients.length) {
      console.warn(`[notify] ${recipients.length - bellLanded.size} ${input.kind} bell row(s) refused — no email for those recipients (emailOnlyWithBell)`);
    }
  } else if (channels.includes("inapp")) {
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
  const mailTo = bellLanded ? recipients.filter((u) => bellLanded!.has(u)) : recipients;
  if (channels.includes("email") && mailTo.length > 0) {
    const emailByUid = await emailsFor(input.orgId, mailTo);
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
      mailTo.map((uid) => {
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

  // 3) Push (N10 — OS-9): only after the bell and email legs are done, only
  //    for a push-worthy kind, only beside the bell leg, only for the
  //    recipients told in full whose bell row landed (when known). Never
  //    throws; never changes `result`.
  if (opts.push && channels.includes("push") && channels.includes("inapp") && kindMeta(input.kind)?.pushWorthy === true) {
    const pushTo = pushLanded ? recipients.filter((u) => pushLanded!.has(u)) : recipients;
    if (pushTo.length > 0 && (result.inapp?.sent ?? 0) > 0) {
      await pushLeg({ orgId: input.orgId, kind: input.kind, resourceId: input.resource.id, recipients: pushTo }, input.serverPush);
    }
  }

  return result;
}

// ─── Push (notifications Round G, N10 — GAP-205) ────────────────────────────

/** emit()'s channels when the producer names none. */
const DEFAULT_CHANNELS: NotifChannel[] = ["inapp", "email", "push"];

/** One emit's push request: who to push about which bell row. The sender
 *  (lib/push/sendPush.ts) re-checks every condition itself. `writerUid` is
 *  set by POST /api/push/notify only — the signed-in member who wrote the
 *  bell rows; the server path leaves it unset. */
export interface PushSendInput {
  orgId: string;
  kind: NotificationKind;
  resourceId: string;
  recipients: string[];
  writerUid?: string | null;
}
/** A server push sender (lib/push/sendPush.ts pushFromServer), passed per
 *  call as EmitInput.serverPush. There is no module-level sender: whether a
 *  server emit pushes is decided by its caller, never by load order. */
export type PushSender = (input: PushSendInput) => Promise<void>;

/** How long a server emit waits for its push leg before it returns (the bell
 *  and email legs have already finished). */
export const PUSH_LEG_TIMEOUT_MS = 8000;

/** A push_subscriptions row made before this instant was made for the push
 *  stack deleted in 0bb13ed (its "reminders"), never through
 *  components/settings/PushOptIn.tsx: the sender never pushes it, the
 *  settings card does not count it as on, and the maintenance cron removes
 *  it — its person turns the device on again (OS-10 done-when 3: nobody is
 *  pushed without having clicked THIS control). The instant precedes any
 *  row the opt-in can have written (the control did not exist before it). */
export const PUSH_OPT_IN_SINCE = "2026-10-14T00:00:00.000Z";

/** The most recipients one POST /api/push/notify is about; the browser leg
 *  sends a larger audience in parts (lib/push/sendPush.ts PUSH_MAX_RECIPIENTS
 *  is this number). */
export const PUSH_REQUEST_MAX_RECIPIENTS = 500;

/** POST /api/push/subscribe's 409 `code` when the endpoint is stored under
 *  OTHER keys than the caller presents (the caller has not shown it holds
 *  that subscription): components/settings/PushOptIn.tsx then starts a fresh
 *  subscription once. Here, not in lib/push/endpoints.ts, because the card
 *  is a browser module and that file is server-only (N10 fix pass 2). */
export const PUSH_KEYS_MISMATCH = "keys_mismatch";

let pushNoSenderLogged = false;

/** The push leg. Never throws. `sender`: the caller's EmitInput.serverPush
 *  (server only). */
async function pushLeg(input: PushSendInput, sender: PushSender | undefined): Promise<void> {
  if (typeof window !== "undefined") {
    browserPushRequest(input);
    return;
  }
  if (typeof sender !== "function") {
    if (!pushNoSenderLogged) {
      pushNoSenderLogged = true;
      console.info(`[notify] a server emit passed no push sender — ${input.kind} notices from it are not pushed (a server caller allowed to push passes serverPush: pushFromServer from lib/push/sendPush; the maintenance cron passes none)`);
    }
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => sender(input)).catch((e) => {
        console.warn(`[notify] the ${input.kind} push failed (bell and email are unaffected): ${(e as Error)?.message ?? e}`);
      }),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, PUSH_LEG_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** OS-14 (notifications N17): emit()'s push leg for a producer that writes
 *  its bell rows OUTSIDE emit() — the read-&-understood and sign-off rosters'
 *  requests (lib/acknowledgments.ts, lib/reviewControl.ts). The caller calls
 *  it only AFTER its rows landed, naming only the recipients whose row landed
 *  (never a refused row; these producers write no redacted one). Exactly the
 *  leg emit() runs: a KIND_META.pushWorthy kind only; in the browser a
 *  fire-and-forget POST /api/push/notify; on the server only through the
 *  caller's `serverPush` (none: no push, logged once). The sender re-checks
 *  the bell row, push_enabled and the device itself. Never throws. */
export async function pushAfterBellRows(input: PushSendInput, serverPush?: PushSender): Promise<void> {
  try {
    if (kindMeta(input.kind)?.pushWorthy !== true) return;
    const recipients = Array.from(new Set((input.recipients ?? []).filter((u): u is string => typeof u === "string" && u !== "")));
    if (!input.orgId || !input.resourceId || recipients.length === 0) return;
    await pushLeg({ orgId: input.orgId, kind: input.kind, resourceId: input.resourceId, recipients }, serverPush);
  } catch (e) {
    console.info(`[notify] the ${input?.kind} push did not go out (bell and email are unaffected): ${(e as Error)?.message ?? e}`);
  }
}

/** The BROWSER push leg: POST /api/push/notify with the member's own token,
 *  fire-and-forget (`keepalive`, so it survives a navigation) — the emit's
 *  caller never waits on it. The route pushes only for bell rows this member
 *  wrote just now. An audience past PUSH_REQUEST_MAX_RECIPIENTS goes in
 *  parts. Never throws. */
function browserPushRequest(input: PushSendInput): void {
  void (async () => {
    try {
      if (typeof fetch !== "function") return;
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) return;
      for (let i = 0; i < input.recipients.length; i += PUSH_REQUEST_MAX_RECIPIENTS) {
        await fetch("/api/push/notify", {
          method: "POST",
          keepalive: true,
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            orgId: input.orgId, kind: input.kind, resourceId: input.resourceId,
            recipients: input.recipients.slice(i, i + PUSH_REQUEST_MAX_RECIPIENTS),
          }),
        });
      }
    } catch (e) {
      console.info(`[notify] the ${input.kind} push request did not go out (bell and email are unaffected): ${(e as Error)?.message ?? e}`);
    }
  })();
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
