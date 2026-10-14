// lib/notificationKinds.ts
//
// THE kind registry (notifications Round G, N2 KIND-REGISTRY — GAP-201 and the
// table GAP-207 derives from). One literal classifies every NotificationKind:
//
//   section        which sidebar row badges it — or null: bell-only (the
//                  header bell's count, its drawer, the Notification Center and
//                  /inbox list it; no rail row counts it)
//   actionRequired whether the feed says "Action" and the row's badge turns red
//   compliance     whether it rides the daily compliance digest email
//                  (COMPLIANCE_KINDS in app/api/cron/maintenance/route.ts — N6
//                  derives that list from this column)
//   icon / tone    the bell icon and the feed tile's tone (N3 derives the
//                  bell's KIND_ICON and the feed's attentionVisual from these)
//   group          the Notification Center's "what is it about" chip (N3
//                  derives KIND_GROUPS from it)
//   pushWorthy     set by the push channel (N10, GAP-205); unset = not pushed
//
// `satisfies Record<NotificationKind, KindMeta>` makes a kind added to the
// union without an entry here a `tsc` error, and an entry for a kind the union
// does not declare one too. The hook's sectionForKind adds a `never` guard on
// top. Each section decision is written next to its kind: "it went to
// 'other'" is not a decision anyone made (GAP-201).
//
// Parity (DEC-81): icon = the bell's icon where the bell had one, else the
// feed's; tone and group = what the feed's substring predicates produced on
// b9cdfdc. lib/__tests__/notificationKinds.test.ts pins every value against
// those predecessors and lists each deliberate departure with its reason.
//
// Server-safe: a type-only import, no client code — the cron and N5's
// notification_kinds seed read it too.
//
// The database keeps a copy (N5, DEC-86): notification_kinds()
// (20261160) lists every kind and its compliance flag, a browser's row of a
// kind it does not list is refused, and the delete policy (20261161) keeps a
// compliance kind dismiss-only. A kind added or re-flagged here needs a
// migration that re-creates notification_kinds() to match;
// lib/__tests__/notificationWriteRails.test.ts fails until the two agree.
// Re-create it from its NEWEST definition plus the new rows, in the same
// package as the entry here, and paste it BEFORE the deploy that writes the
// kind: a browser's row of a kind the live function does not list is
// refused and only logged (99-fix-sequencing.md, the N5 hand-off).
//
// A browser row names its writer (20261160, rule 1): once that migration is
// live, a signed-in member's row whose actor_user_id is anyone else is
// refused (42501) and only logged by notify(). So a browser producer passes
// as `actorUserId` the signed-in member or nothing (the trigger stamps the
// caller), never a stored uid (a document's owner, a ticket's requester, a
// hold's opener), not even on someone's behalf. A function that forwards an
// actor hands the same obligation to its callers.
// lib/__tests__/notificationWriteRails.test.ts pins every producer's actor
// and the callers one hop up (DEC-86 §2).

import type { NotificationKind } from "@/lib/inAppNotifications";

/** The sidebar rows that badge a section (components/navigation/Sidebar.tsx
 *  spreads `badgeOf(sectionCounts.<section>)` on exactly these). A test pins
 *  the two lists equal, so no section is ever tallied and thrown away. */
export const NOTIFICATION_SECTIONS = ["requests", "documents", "projects"] as const;
export type NotificationSection = (typeof NOTIFICATION_SECTIONS)[number];

/** lucide-react component names; the surfaces map a name to its component. */
export type KindIcon =
  | "MessageSquare" | "FileText" | "UserPlus" | "MailPlus" | "AlertOctagon" | "Lock" | "GitBranch"
  | "FileSignature" | "Check" | "Briefcase" | "Bell" | "Send" | "HardDrive" | "Database" | "Flag";

/** The feed's tile tones (components/cockpit/AttentionFeed.tsx FEED_TONES). */
export type KindTone = "orange" | "blue" | "indigo" | "violet" | "rose" | "amber" | "emerald" | "slate";

/** The Notification Center's group chips (AttentionFeed KIND_GROUPS keys);
 *  'other' has no chip and shows under "Everything". */
export type KindGroup = "mentions" | "documents" | "requests" | "locks" | "other";

export interface KindMeta {
  section: NotificationSection | null;
  actionRequired: boolean;
  compliance: boolean;
  icon: KindIcon;
  tone: KindTone;
  group: KindGroup;
  pushWorthy?: boolean;
}

// actionRequired (DEC-81 §2) — true for exactly the conflict class
// (checkout_conflict, checkout_released, overlap_advisory, branch_open, and
// since N9 the two kinds split off checkout_released, checkout_force_released
// and checkout_auto_released): the feed's actionKinds on b9cdfdc, which now
// also turn the Documents badge red (TRAIL-5). Everything else is false, as it was on b9cdfdc — someone else's
// sign-off, a completion, and, for now, the PSM obligations (ack_requested,
// review_requested, review_invalidated, access_recert_due, …) with their
// overdue copies to the owner and controllers (ack_overdue, review_overdue).
// The flag is per kind, whoever receives the row, so no rule here makes an
// escalation copy FYI: the conflict class fans out to controllers as an
// action — escalateStaleCheckouts (app/api/cron/maintenance/route.ts) writes
// checkout_released with metadata.escalation to every active Admin / DocCtrl
// but the holder, and announceBranchOpened (lib/branches.ts) writes
// branch_open to every DocCtrl. An action notification stays red, pulsing
// and in the Action count until its row is read, and nothing reads a row
// when its condition ends: not a PSM row when the person acknowledges or
// signs (lib/acknowledgments.ts, lib/reviewControl.ts, lib/effectiveDate.ts
// never touch notifications.read_at; the hook reconciles ticket workflow rows
// only), and not those controller copies when the checkout is released or
// the branch resolves (branch_resolved reaches only the branch's creator).
// Clearing a row whose condition is gone is the TRAIL-9 class (N4), for the
// controller copies as much as for the PSM obligations. Flipping an
// obligation to true is one line here, and lands with that clearing and
// after the badge's reduced-motion / accessible-name work (NEDGE-5) —
// DEC-81 §2.

export const KIND_META = {
  // ── Drafting requests (the 'requests' row) ────────────────────────────────
  // Unchanged: these five were 'requests' on b9cdfdc.
  ticket_comment:           { section: "requests", actionRequired: false, compliance: false, icon: "MessageSquare", tone: "blue", group: "mentions" },
  ticket_mention:           { section: "requests", actionRequired: false, compliance: false, icon: "MessageSquare", tone: "violet", group: "mentions" },
  ticket_status:            { section: "requests", actionRequired: false, compliance: false, icon: "FileText", tone: "slate", group: "requests" },
  ticket_assigned:          { section: "requests", actionRequired: false, compliance: false, icon: "UserPlus", tone: "orange", group: "requests" },
  request_pending_approval: { section: "requests", actionRequired: false, compliance: false, icon: "MailPlus", tone: "orange", group: "requests" },

  // ── Documents (the 'documents' row) ───────────────────────────────────────
  // Unchanged: these twelve were 'documents' on b9cdfdc.
  checkout_conflict:        { section: "documents", actionRequired: true, compliance: false, icon: "AlertOctagon", tone: "amber", group: "locks" },
  // checkout_handoff: now emitted by the checkout thread's handoff post
  // (lib/activityThread.ts — PROD-8), which used to collapse into checkout_message.
  checkout_handoff:         { section: "documents", actionRequired: false, compliance: false, icon: "Lock", tone: "indigo", group: "locks" },
  checkout_message:         { section: "documents", actionRequired: false, compliance: false, icon: "MessageSquare", tone: "blue", group: "mentions" },
  // checkout_released: declared for LEGACY rows only (TAX-17, notifications
  // N15). Since N15 the maintenance cron's stale-checkout escalation to the
  // controllers ("Checkout held N days — review needed") writes
  // checkout_stale_escalation, and 20261206 re-files the escalations written
  // before (a still-active session's row once its session closes and the
  // file is pasted again); nothing writes checkout_released any more. The holder's own
  // notices have their own kinds, both actions as before:
  //   checkout_force_released: someone force-released YOUR checkout
  //     (lib/checkoutEpisodes.ts forceReleaseDocument);
  //   checkout_auto_released: your ad-hoc checkout expired and was released
  //     (lib/projects.ts autoReleaseExpiredAdHoc — the browser sweep and the
  //     cron).
  checkout_released:        { section: "documents", actionRequired: true, compliance: false, icon: "Lock", tone: "indigo", group: "locks" },
  checkout_stale_escalation: { section: "documents", actionRequired: true, compliance: false, icon: "Lock", tone: "indigo", group: "locks" },
  checkout_force_released:  { section: "documents", actionRequired: true, compliance: false, icon: "Lock", tone: "indigo", group: "locks" },
  // checkout_force_released_fyi (notifications N15 fix pass — PROD-17): a
  //   document you WATCH was force-released by someone — the watchers' FYI
  //   beside the holder's own checkout_force_released (lib/checkoutEpisodes.ts
  //   forceReleaseDocument). Its own name, so the checkout thread's chat kind
  //   (checkout_message — Mentions, bell-only) keeps one meaning: a lock
  //   notice under Locks, not an action, not a compliance kind; its email
  //   rides the watcher's own toggle (category 'watched').
  checkout_force_released_fyi: { section: "documents", actionRequired: false, compliance: false, icon: "Lock", tone: "indigo", group: "locks" },
  checkout_auto_released:   { section: "documents", actionRequired: true, compliance: false, icon: "Lock", tone: "indigo", group: "locks" },
  overlap_advisory:         { section: "documents", actionRequired: true, compliance: false, icon: "AlertOctagon", tone: "slate", group: "other" },
  branch_open:              { section: "documents", actionRequired: true, compliance: false, icon: "GitBranch", tone: "slate", group: "other" },
  branch_resolved:          { section: "documents", actionRequired: false, compliance: false, icon: "Check", tone: "slate", group: "other" },
  doc_superseded:           { section: "documents", actionRequired: false, compliance: true, icon: "GitBranch", tone: "slate", group: "documents" },
  // ── The doc_superseded / checkout_released split (notifications N9 —
  // PROD-13 / TAX-13; names from the plan, DEC-90 delegation). One name per
  // human meaning: until N9 the two kinds carried eight. Each split-off kind
  // keeps its parent's badge (Documents), action flag and compliance flag,
  // so no badge, action count, digest line or dismiss rule moves — only the
  // name does (a compliance kind stays dismiss-only, 20261161). icon / tone /
  // group are the feed's predicates on the new name, as for every kind (the
  // bell, N3's, has no entry for them yet: BELL_ICON_GAPS).
  //   doc_recalled: YOUR copy is out of date / the document was retired —
  //     lib/staleCopies.ts nudgeStaleHolders, recallRetiredDocument.
  //   doc_upstream_changed: a document connected to work you have checked
  //     out was revised — lib/revisionImpact.ts notifyConnectedWork.
  //   package_doc_stale / package_doc_retired: a document pinned in your
  //     work package moved past its pin / was retired — lib/workPackages.ts
  //     notifyPackagesOfRevUp, lib/postPublish.ts notifyPackagesOfRetirement.
  // doc_superseded keeps its one meaning: a revision was published (the
  // post-publish signal, the intake door's trusted publish, the intake
  // digest of folded publishes). Manual distribution-ack requests moved to
  // ack_requested (lib/distributionAcks.ts). 20261191 re-files the rows
  // already written by their metadata discriminators.
  doc_recalled:             { section: "documents", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "documents" },
  // doc_retired (notifications N15 — PROD-17): a document you WATCH was
  //   retired — lib/staleCopies.ts recallRetiredDocument's follower notice.
  //   doc_recalled's badge, icon and group, but NOT a compliance kind: a
  //   watcher holds nothing to destroy, so the FYI stays out of the daily
  //   compliance digest, is deletable once read (20261161 keeps only
  //   compliance kinds dismiss-only) and is not retried as an obligation;
  //   its email rides the watcher's own toggle (category 'watched').
  doc_retired:              { section: "documents", actionRequired: false, compliance: false, icon: "Bell", tone: "slate", group: "documents" },
  doc_upstream_changed:     { section: "documents", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "documents" },
  package_doc_stale:        { section: "documents", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "documents" },
  package_doc_retired:      { section: "documents", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "documents" },
  // markup_request: about a markup request on a document — the person asked
  // (PROD-14, N8's producer) or the request's markups shared to the thread
  // (the checkout thread's markup_ref post, lib/activityThread.ts — PROD-8).
  markup_request:           { section: "documents", actionRequired: false, compliance: false, icon: "FileSignature", tone: "violet", group: "requests" },
  provenance_flag:          { section: "documents", actionRequired: false, compliance: false, icon: "FileText", tone: "slate", group: "other" },
  hold_opened:              { section: "documents", actionRequired: false, compliance: false, icon: "AlertOctagon", tone: "rose", group: "locks" },
  hold_released:            { section: "documents", actionRequired: false, compliance: false, icon: "Check", tone: "rose", group: "locks" },
  // Moved from 'other' to 'documents' — each is about a document, folder or
  // library and links into the tree (PROD-1 / TRAIL-2 / DELIV-3 / TAX-2 /
  // OS-12 / RT-6 name them; TRAIL-2 done-when 1 lists exactly this set).
  revision_published_over_checkout: { section: "documents", actionRequired: false, compliance: false, icon: "GitBranch", tone: "indigo", group: "documents" },
  library_doc_added:        { section: "documents", actionRequired: false, compliance: false, icon: "Bell", tone: "slate", group: "documents" },
  library_doc_revised:      { section: "documents", actionRequired: false, compliance: false, icon: "GitBranch", tone: "blue", group: "documents" },
  owner_assigned:           { section: "documents", actionRequired: false, compliance: false, icon: "Briefcase", tone: "orange", group: "requests" },
  owner_behind:             { section: "documents", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "other" },
  deletion_requested:       { section: "documents", actionRequired: false, compliance: true, icon: "Briefcase", tone: "orange", group: "other" },
  // the acknowledgment family — read & acknowledge an issued revision
  ack_requested:            { section: "documents", actionRequired: false, compliance: true, icon: "Briefcase", tone: "orange", group: "documents" },
  ack_complete:             { section: "documents", actionRequired: false, compliance: false, icon: "Bell", tone: "slate", group: "documents" },
  ack_overdue:              { section: "documents", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "documents" },
  ack_unsatisfiable:        { section: "documents", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "documents" },
  // the review family — periodic review and the pre-publish sign-off
  review_due:               { section: "documents", actionRequired: false, compliance: true, icon: "GitBranch", tone: "blue", group: "documents" },
  // review_requested: a document's sign-off request (lib/reviewControl.ts,
  // CheckInPanel). Until N9 the contractor-intake path also wrote it for
  // three notices that open a project — the overload DEC-81 §3 recorded and
  // DEC-90 A13 ratified as an interim only, the split ordered: those notices
  // now carry intake_quote / intake_submission (section 'projects', below).
  review_requested:         { section: "documents", actionRequired: false, compliance: true, icon: "GitBranch", tone: "blue", group: "documents" },
  review_signed:            { section: "documents", actionRequired: false, compliance: false, icon: "GitBranch", tone: "blue", group: "documents" },
  review_invalidated:       { section: "documents", actionRequired: false, compliance: true, icon: "GitBranch", tone: "blue", group: "documents" },
  review_complete:          { section: "documents", actionRequired: false, compliance: true, icon: "GitBranch", tone: "blue", group: "documents" },
  review_overdue:           { section: "documents", actionRequired: false, compliance: true, icon: "GitBranch", tone: "blue", group: "documents" },
  review_alternate_activated: { section: "documents", actionRequired: false, compliance: true, icon: "GitBranch", tone: "blue", group: "documents" },
  effective_now:            { section: "documents", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "documents" },
  retention_eligible:       { section: "documents", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "documents" },
  legal_hold_placed:        { section: "documents", actionRequired: false, compliance: false, icon: "AlertOctagon", tone: "rose", group: "locks" },
  legal_hold_released:      { section: "documents", actionRequired: false, compliance: false, icon: "AlertOctagon", tone: "rose", group: "locks" },
  access_recert_due:        { section: "documents", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "other" },
  // transmittal_issued (N9 — PROD-12): a transmittal carrying a document you
  // own, or one in a library you follow, was issued to an outside party — a
  // controlled copy left the building (lib/transmittals.ts issueTransmittal).
  // Links to /transmittals; FYI. (transmittal_unstampable badges Documents
  // too since N9 — its entry is the registry's last, below.)
  transmittal_issued:       { section: "documents", actionRequired: false, compliance: false, icon: "Send", tone: "blue", group: "documents" },

  // ── Projects (the 'projects' row) ─────────────────────────────────────────
  // Unchanged: project_member, project_status.
  project_member:           { section: "projects", actionRequired: false, compliance: false, icon: "Briefcase", tone: "slate", group: "other" },
  project_status:           { section: "projects", actionRequired: false, compliance: false, icon: "Briefcase", tone: "slate", group: "other" },
  // Moved from 'other': a comment on a project you are on (TRAIL-2 dw1).
  project_comment:          { section: "projects", actionRequired: false, compliance: false, icon: "Briefcase", tone: "blue", group: "mentions" },
  // Added by notifications N8 PRODUCERS-FREE (PROD-6 / PROD-11) — the
  // controls program and the schedule were silent. Each badges Projects (it
  // is about a project and links into it) and is FYI (DEC-81 §2: nothing
  // clears a row when its condition ends). icon / tone / group are what the
  // feed's predicates give the name today (AttentionFeed: 'milestone' →
  // Flag / emerald; 'assign' → the Requests chip), so the feed draws them as
  // it would have.
  //   change_order_status: a change order was proposed, approved or rejected
  //     — to the project's members and its owner (lib/changeOrders.ts).
  //   milestone_assigned: you were made responsible for a task.
  //   milestone_slipped: a move pushed baselined tasks past their baseline —
  //     to the project owner, once per move (lib/milestones.ts).
  change_order_status:      { section: "projects", actionRequired: false, compliance: false, icon: "Bell", tone: "slate", group: "other" },
  milestone_assigned:       { section: "projects", actionRequired: false, compliance: false, icon: "Flag", tone: "emerald", group: "requests" },
  milestone_slipped:        { section: "projects", actionRequired: false, compliance: false, icon: "Flag", tone: "emerald", group: "other" },
  // The contractor-intake notices (notifications N9 — DEC-90 A13, DEC-81 §3:
  // one name per concept; a project notice must not light the Documents
  // badge or ride the PSM sign-off kind). Both open the project and badge
  // Projects; FYI; compliance kept from review_requested, the kind they
  // rode, so the daily digest and the dismiss-only rule treat them as before
  // (one line here to change either).
  //   intake_quote: a contractor's quote arrived (app/api/intake/upload/route.ts
  //     notifyTeam — "Quote received: …", /projects/<id>?tab=costs).
  //   intake_submission: a contractor submission awaits review (the same
  //     notifyTeam — "Intake submission awaiting review: …"), and the digest
  //     of folded submissions when none was published (lib/intakeRateLimit.ts
  //     foldedDigestKind; doc_superseded when one was).
  intake_quote:             { section: "projects", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "other" },
  intake_submission:        { section: "projects", actionRequired: false, compliance: true, icon: "Bell", tone: "slate", group: "other" },

  // ── Bell-only (section null) ──────────────────────────────────────────────
  // Were 'other' (tallied, rendered by no row) on b9cdfdc; the header bell
  // owns them (Sidebar.tsx: "The header bell owns the org-wide total").
  // A person's message relayed by the document-controller assistant: it is
  // addressed to the person, not filed in the tree.
  orchestrator_message:     { section: null, actionRequired: false, compliance: false, icon: "MessageSquare", tone: "blue", group: "mentions" },
  // Workspace security: a full export was run — links to Admin → Data export.
  security_export:          { section: null, actionRequired: false, compliance: false, icon: "Bell", tone: "slate", group: "other" },
  // Admin housekeeping: a removed member's ownership was cleared — links to
  // the register's unowned filter. Departure: today's feed drew GitBranch /
  // blue / "Documents & revisions" only because 'revoked' contains 'rev'.
  member_revoked:           { section: null, actionRequired: false, compliance: false, icon: "Bell", tone: "slate", group: "other" },
  // Admin housekeeping: a Save-As library was born unowned — links to Admin →
  // Permissions & ownership.
  library_unowned:          { section: null, actionRequired: false, compliance: false, icon: "Bell", tone: "slate", group: "other" },
  // Admin housekeeping (PROD-2, N8): someone asked to join the workspace —
  // to the Admin / DocCtrl pool, links to Admin → Users, where the pending
  // requests are listed. Bell-only like the other admin notices; FYI until a
  // decision clears it (DEC-81 §2).
  access_request_pending:   { section: null, actionRequired: false, compliance: false, icon: "Briefcase", tone: "orange", group: "other" },
  // Infrastructure (PROD-10 / TAX-11 — raw inserts before N2; lib/storageAlerts.ts,
  // lib/storageUsage.ts now go through notify()). The set is finite: the quota
  // watermark, and the two platform ceilings (storageUsage.ts hot[] keys).
  storage_alert:            { section: null, actionRequired: false, compliance: false, icon: "HardDrive", tone: "slate", group: "other" },
  storage_platform_r2:      { section: null, actionRequired: false, compliance: false, icon: "HardDrive", tone: "slate", group: "other" },
  storage_platform_db:      { section: null, actionRequired: false, compliance: false, icon: "Database", tone: "slate", group: "other" },
  // Written by a raw insert in a file another package owns, found by the
  // census (lib/__tests__/notificationKinds.test.ts) and kept at today's
  // behaviour: a monthly AI cap changed (app/api/ai/usage/route.ts).
  ai_cap_changed:           { section: null, actionRequired: false, compliance: false, icon: "Bell", tone: "slate", group: "other" },

  // ── Moved from bell-only to Documents (notifications N9) ─────────────────
  // transmittal_unstampable: the transmittal portal refused to stamp an
  // issued PDF, or released it unmarked (TRX-15, app/api/transmittal/route.ts;
  // a raw insert until N8) — links to /transmittals. Bell-only until N9; it
  // badges Documents since: ratified by the integrator under the user's
  // delegation, 2026-10-07 (DEC-90 A12) — a controlled copy released without
  // its UNCONTROLLED marking is a document-control integrity event the issuer
  // may need to act on (ISO 9001 §7.5.3); the other eight bell-only kinds stay
  // bell-only. Kept last, where it has always been in the registry (and in
  // notification_kinds()), so the move changes one field.
  transmittal_unstampable:  { section: "documents", actionRequired: false, compliance: false, icon: "Send", tone: "blue", group: "documents" },
} as const satisfies Record<NotificationKind, KindMeta>;

/** The kinds this table classifies. Equal to NotificationKind while the
 *  registry is complete — which the `satisfies` above enforces, and which the
 *  hook's `never` guard checks a second time through this type. */
export type ClassifiedKind = keyof typeof KIND_META;

/** Every declared kind, in registry order. */
export const NOTIFICATION_KINDS = Object.keys(KIND_META) as ClassifiedKind[];

/** Is this string a classified kind? A row's kind is a string at runtime: a
 *  row written before a kind was retired (task_nudge, morning_digest, … —
 *  PROD-8) is still in the table. */
export function isNotificationKind(kind: string): kind is ClassifiedKind {
  return Object.prototype.hasOwnProperty.call(KIND_META, kind);
}

/** The registry entry for a row's kind, or null for a kind no union declares
 *  (a legacy row). Callers treat null as bell-only and FYI — where such a row
 *  landed before the registry ('scratchpad' / 'other', rendered by no row). */
export function kindMeta(kind: string): KindMeta | null {
  return isNotificationKind(kind) ? KIND_META[kind] : null;
}
