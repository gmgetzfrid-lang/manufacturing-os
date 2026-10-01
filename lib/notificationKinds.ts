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
// Parity (DEC-44 (N2)): icon = the bell's icon where the bell had one, else the
// feed's; tone and group = what the feed's substring predicates produced on
// b9cdfdc. lib/__tests__/notificationKinds.test.ts pins every value against
// those predecessors and lists each deliberate departure with its reason.
//
// Server-safe: a type-only import, no client code — the cron and N5's
// notification_kinds seed read it too.

import type { NotificationKind } from "@/lib/inAppNotifications";

/** The sidebar rows that badge a section (components/navigation/Sidebar.tsx
 *  spreads `badgeOf(sectionCounts.<section>)` on exactly these). A test pins
 *  the two lists equal, so no section is ever tallied and thrown away. */
export const NOTIFICATION_SECTIONS = ["requests", "documents", "projects"] as const;
export type NotificationSection = (typeof NOTIFICATION_SECTIONS)[number];

/** lucide-react component names; the surfaces map a name to its component. */
export type KindIcon =
  | "MessageSquare" | "FileText" | "UserPlus" | "MailPlus" | "AlertOctagon" | "Lock" | "GitBranch"
  | "FileSignature" | "Check" | "Briefcase" | "Bell" | "Send" | "HardDrive" | "Database";

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

// actionRequired (DEC-44 (N2) §2) — true for exactly the conflict class
// (checkout_conflict, checkout_released, overlap_advisory, branch_open): the
// feed's actionKinds on b9cdfdc, which now also turn the Documents badge red
// (TRAIL-5). Everything else is false, as it was on b9cdfdc — an FYI (someone
// else's sign-off, a completion, an escalation copy to the owner and
// controllers) and, for now, the PSM obligations too (ack_requested,
// review_requested, review_invalidated, access_recert_due, …). Deliberately:
// an action notification stays red, pulsing and in the Action count until
// its row is read, and nothing marks a PSM row read when the person
// acknowledges or signs (lib/acknowledgments.ts, lib/reviewControl.ts,
// lib/effectiveDate.ts never touch notifications.read_at; the hook reconciles
// ticket workflow rows only). Flipping an obligation to true is one line
// here, and lands with the change that clears its row once the obligation is
// discharged (the TRAIL-9 class) and after the badge's reduced-motion /
// accessible-name work (NEDGE-5) — DEC-44 (N2) §2.

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
  checkout_released:        { section: "documents", actionRequired: true, compliance: false, icon: "Lock", tone: "indigo", group: "locks" },
  overlap_advisory:         { section: "documents", actionRequired: true, compliance: false, icon: "AlertOctagon", tone: "slate", group: "other" },
  branch_open:              { section: "documents", actionRequired: true, compliance: false, icon: "GitBranch", tone: "slate", group: "other" },
  branch_resolved:          { section: "documents", actionRequired: false, compliance: false, icon: "Check", tone: "slate", group: "other" },
  doc_superseded:           { section: "documents", actionRequired: false, compliance: true, icon: "GitBranch", tone: "slate", group: "documents" },
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
  // review_requested is overloaded: besides a document's sign-off request, the
  // contractor-intake folded digest writes it (lib/intakeRateLimit.ts
  // foldedDigestKind — doc_superseded when a revision was published) with
  // resource_type 'project' and a /projects/<id> link, so that digest badges
  // Documents too. Recorded for ratification (DEC-44 (N2) §3); the digest's
  // own kind (section 'projects') belongs to that file's owner.
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

  // ── Projects (the 'projects' row) ─────────────────────────────────────────
  // Unchanged: project_member, project_status.
  project_member:           { section: "projects", actionRequired: false, compliance: false, icon: "Briefcase", tone: "slate", group: "other" },
  project_status:           { section: "projects", actionRequired: false, compliance: false, icon: "Briefcase", tone: "slate", group: "other" },
  // Moved from 'other': a comment on a project you are on (TRAIL-2 dw1).
  project_comment:          { section: "projects", actionRequired: false, compliance: false, icon: "Briefcase", tone: "blue", group: "mentions" },

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
  // Infrastructure (PROD-10 / TAX-11 — raw inserts before N2; lib/storageAlerts.ts,
  // lib/storageUsage.ts now go through notify()). The set is finite: the quota
  // watermark, and the two platform ceilings (storageUsage.ts hot[] keys).
  storage_alert:            { section: null, actionRequired: false, compliance: false, icon: "HardDrive", tone: "slate", group: "other" },
  storage_platform_r2:      { section: null, actionRequired: false, compliance: false, icon: "HardDrive", tone: "slate", group: "other" },
  storage_platform_db:      { section: null, actionRequired: false, compliance: false, icon: "Database", tone: "slate", group: "other" },
  // Written by raw inserts in files other packages own, found by the census
  // (lib/__tests__/notificationKinds.test.ts) and kept at today's behaviour:
  // a monthly AI cap changed (app/api/ai/usage/route.ts) …
  ai_cap_changed:           { section: null, actionRequired: false, compliance: false, icon: "Bell", tone: "slate", group: "other" },
  // … and the transmittal portal refused to stamp an issued PDF (TRX-15,
  // app/api/transmittal/route.ts) — links to /transmittals, no rail row.
  transmittal_unstampable:  { section: null, actionRequired: false, compliance: false, icon: "Send", tone: "blue", group: "documents" },
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
