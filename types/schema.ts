import type { DependencyLink } from "@/lib/scheduleLinks";

export type { DependencyLink, LinkType } from "@/lib/scheduleLinks";

export type Timestamp = Date | number | string | null;

export type MemberStatus = "active" | "invited" | "suspended" | "inactive";

export type Role =
  | "Admin"
  | "DocCtrl"
  | "Manager"
  | "Supervisor"
  | "DraftingSupervisor"
  | "Engineer-1"
  | "Engineer-2"
  | "Engineer-3"
  | "Engineer-4"
  | "Requester"
  | "Drafter"
  | "Accounting"
  | "Safety"
  | "HR"
  | "Maintenance"
  | "Operations"
  | "Contractor"
  | "Viewer"
  | "Auditor";

export const ALL_ROLES: Role[] = [
  "Admin",
  "DocCtrl",
  "Manager",
  "Supervisor",
  "DraftingSupervisor",
  "Engineer-1",
  "Engineer-2",
  "Engineer-3",
  "Engineer-4",
  "Requester",
  "Drafter",
  "Accounting",
  "Safety",
  "HR",
  "Maintenance",
  "Operations",
  "Contractor",
  "Viewer",
  "Auditor",
];

export type OrgType = "personal" | "business";

export interface Org {
  id?: string;
  name: string;
  type: OrgType;
  createdAt: Timestamp;
  createdBy: string;

  billing?: {
    plan?: string;
    seats?: number;
    status?: "active" | "trialing" | "past_due" | "canceled" | "incomplete";
    renewalAt?: Timestamp;
  };
}

export interface OrgMember {
  orgId: string;
  uid: string;
  email: string;
  role: Role;
  status: MemberStatus;

  displayName?: string;

  createdAt: Timestamp;
  createdBy: string;

  invitedAt?: Timestamp;
  invitedBy?: string;
}

export type NodeVisibility = "normal" | "hidden" | "private";

export type PermissionAction =
  | "discover"
  | "read"
  | "download"
  | "upload"
  | "createFolder"
  | "editMetadata"
  | "write"
  | "managePermissions"
  | "admin";

export type PermissionEffect = "allow" | "deny";
export type PermissionSubjectType = "user" | "team" | "role" | "org";

export interface PermissionSubject {
  type: PermissionSubjectType;
  id: string;
}

export interface AccessRule {
  effect: PermissionEffect;
  subject: PermissionSubject;
  actions: PermissionAction[];
  expiresAt?: Timestamp;
}

export interface AccessControl {
  inherit?: boolean;
  visibility?: NodeVisibility;
  rules: AccessRule[];
}

export type AclIndexBucket = {
  roles: Record<PermissionAction, Role[]>;
  users: Record<PermissionAction, string[]>;
  teams?: Record<PermissionAction, string[]>;
  orgs?: Record<PermissionAction, string[]>;
};

export interface AclIndex {
  allow: AclIndexBucket;
  deny: AclIndexBucket;
}

export type FolderSecurityMode = "Flat" | "Inherit" | "Inherited" | "Granular";

export type MetadataFieldType =
  | "text"
  | "number"
  | "date"
  | "boolean"
  | "select"
  | "multi"
  | "tags"
  | "user"
  | "link";

export type MetadataValue = string | number | boolean | string[] | null;

export interface MetadataFieldDefinition {
  key: string;
  label: string;
  type: MetadataFieldType;
  description?: string;
  options?: string[];
  searchable?: boolean;
  required?: boolean;
  visible?: boolean;
  width?: number;
  isPill?: boolean;
  pillGroupLabel?: string;
}

export interface MetadataTemplate {
  id?: string;
  orgId?: string;
  name: string;
  scope: "global" | "library" | "collection";
  libraryId?: string;
  collectionId?: string;
  fields: MetadataFieldDefinition[];
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export type LibraryCustomColumn = MetadataFieldDefinition;
export type ViewColumn = MetadataFieldDefinition;

export type LibraryType =
  | "Engineering"
  | "Operations"
  | "Maintenance"
  | "Safety"
  | "HR"
  | "Accounting"
  | "Quality"
  | "Business"
  | "Procedure"
  | "General"
  | "UserSpace";

/** Optional customizable library home ("web parts"). Absent/disabled =
 *  the library shows its folders + documents as normal. */
export type WebPartType = "about" | "quickFolders" | "recentDocs" | "stats" | "text";

export interface WebPart {
  id: string;
  type: WebPartType;
  title?: string;
  width?: "full" | "half" | "third";
  settings?: {
    folderIds?: string[];   // quickFolders: explicit pins (else auto top folders)
    count?: number;         // recentDocs: how many
    body?: string;          // text: announcement/markdown-ish body
  };
}

export interface LibraryHomeConfig {
  enabled?: boolean;
  parts: WebPart[];
}

export interface LibraryConfig {
  id?: string;
  orgId: string;

  name: string;
  type: LibraryType;
  description?: string;

  createdAt: Timestamp;
  createdBy: string;
  updatedAt?: Timestamp;
  updatedBy?: string;

  visibility?: NodeVisibility;
  acl?: AccessControl;

  readAccess?: Role[] | "ALL";
  writeAccess?: Role[];
  adminAccess?: Role[];
  visibleTo?: Role[];

  folderSecurity?: FolderSecurityMode;

  defaultNewVisibility?: NodeVisibility;
  defaultNewAcl?: AccessControl;

  customColumns?: LibraryCustomColumn[];

  // Presentational customization (does not affect access).
  color?: string;
  icon?: string;
  coverImageUrl?: string;
  coverTint?: "none" | "brand" | "mono";
  pageConfig?: PageConfig;

  /** Optional customizable home board (web parts) for the library root. */
  homeConfig?: LibraryHomeConfig;

  /** Admin-defined renames of system columns. Keyed by column key,
   *  value is the override label. e.g. { documentNumber: "Sheet No" }. */
  columnLabelOverrides?: Record<string, string>;

  /** Field keys that compose the document uniqueness tuple. Default
   *  (undefined or empty) is ["documentNumber"] — one doc number per
   *  library. Use e.g. ["documentNumber","sheet"] to allow many
   *  sheets per number. An explicit empty array opts out of any
   *  uniqueness enforcement. See lib/uniqueness.ts. */
  uniquenessKeys?: string[];
}

export type HeaderHeight = "none" | "compact" | "standard" | "tall";

/** Per-page (library root / folder) presentation: a hero header and an
 *  optional page background. All optional; resolved with inheritance. */
export interface PageConfig {
  header?: {
    height?: HeaderHeight;
    layout?: "overlay" | "plain";
  };
  background?: {
    type?: "none" | "tint" | "image";
    imagePath?: string;     // R2 storage path (signed at render)
    opacity?: number;       // 0..1, capped for legibility
    tint?: "brand" | "neutral";
  };
}

/** Presentational customization for a library or folder (SharePoint-style).
 *  `coverTint` recolors the cover image with the workspace palette:
 *  'brand' = duotone using primary→secondary, 'mono' = grayscale,
 *  'none'/undefined = the original image. */
export interface NodeAppearance {
  color?: string;          // hex brand color for the card/header
  icon?: string;           // lucide icon key
  coverImageUrl?: string;  // header/cover image
  coverTint?: "none" | "brand" | "mono";
  description?: string;
}

export interface LibraryCollection {
  id?: string;

  orgId?: string;
  libraryId: string;

  parentId?: string | null;
  name: string;

  path?: string[];
  pathIds?: string[];
  pathNames?: string[];

  visibility?: NodeVisibility;
  acl?: AccessControl;
  aclIndex?: AclIndex;

  columnOverrides?: LibraryCustomColumn[];

  // Presentational customization (does not affect access).
  description?: string;
  color?: string;
  icon?: string;
  coverImageUrl?: string;
  coverTint?: "none" | "brand" | "mono";
  pageConfig?: PageConfig;
  /** Optional customizable web-part home for this folder. */
  homeConfig?: LibraryHomeConfig;

  createdAt: Timestamp;
  createdBy: string;
  updatedAt?: Timestamp;
  updatedBy?: string;
}

export type CollectionNode = LibraryCollection;

export interface AssetTag {
  tag: string;
  type?: string;
  category?: string;
}

// ─── Milestones (Phase 7) ────────────────────────────────────────
// Lightweight scheduling layer. See lib/milestones.ts.

export type MilestoneStatus =
  | "planned" | "in_progress" | "completed" | "missed" | "blocked" | "on_hold";

export type MilestoneSource = "manual" | "p6" | "msproject" | "csv" | "mpxj";

export type MilestoneShift = "day" | "night" | "swing";

/** A self-describing bag of source columns we have no first-class
 *  field for — custom Text1-30 fields, resource lists, predecessors,
 *  etc. Keyed by the source schedule's own column label. */
export type MilestoneAttributes = Record<string, string | number | boolean | null>;

/** Per-milestone activity log entry: a status change, a reschedule,
 *  or a free-form note. Builds the breadcrumb trail on a task. */
export interface MilestoneNote {
  id?: string;
  orgId: string;
  milestoneId: string;
  kind: "status" | "reschedule" | "note" | "field";
  /** Status the milestone was in at the time of the note. */
  statusAt?: MilestoneStatus | null;
  body?: string | null;
  createdAt?: Timestamp;
  createdBy: string;
  createdByName?: string | null;
}

export interface Milestone {
  id?: string;
  orgId: string;
  projectId?: string | null;
  documentId?: string | null;
  /** Parent task in the WBS. Null = top-level. */
  parentId?: string | null;
  name: string;
  description?: string | null;
  weight: number;
  /** When work is scheduled to BEGIN. */
  plannedStartAt?: Timestamp | null;
  /** When work is scheduled to FINISH (legacy "planned_at"). */
  plannedAt: Timestamp;
  /** When work actually began. */
  actualStartAt?: Timestamp | null;
  actualAt?: Timestamp;
  status: MilestoneStatus;
  /** True when this row rolls up children (a "summary task"). */
  isSummary?: boolean;
  /** 1-based outline depth, cached from source. */
  outlineLevel?: number | null;
  /** Decorative WBS code from source ("1.2.3"). */
  wbs?: string | null;
  /** Execution shift the work runs on. */
  shift?: MilestoneShift | null;
  /** EAM / CMMS work order reference (Infor EAM, Maximo, SAP PM…). */
  workOrderRef?: string | null;
  /** PLANNED owner — who the schedule says should do this. */
  responsibleParty?: string | null;
  responsibleKind?: string | null;   // 'employee' | 'contractor' | free text
  responsibleOrg?: string | null;    // department or contractor company
  /** Structured assignment: the project MEMBER responsible for this
   *  deliverable (distinct from the free-text responsibleParty). */
  responsibleUserId?: string | null;
  responsibleUserName?: string | null;
  /** ACTUAL owner — who really executed it (may differ from plan). */
  actualParty?: string | null;
  actualKind?: string | null;
  actualOrg?: string | null;
  /** Where the work happens — area / unit / equipment tag. */
  location?: string | null;
  /** Planned work in hours (MS Project Work / P6 budgeted units). */
  durationHours?: number | null;
  /** Self-describing bag of extra source columns. */
  attributes?: MilestoneAttributes | null;
  /** Explicit predecessor task ids (finish-to-start): this task can't start
   *  until all of them finish. Empty/undefined = no dependencies. LEGACY —
   *  kept in sync with dependencyLinks (which carries type + lag) so older
   *  readers and the FS-only arrow fallback keep working. */
  dependsOn?: string[] | null;
  /** Typed dependency edges (FS / SS / FF / SF + lag), the full
   *  MS-Project / P6 relationship model. See lib/scheduleLinks.ts.
   *  When present this is the source of truth; dependsOn mirrors its ids. */
  dependencyLinks?: DependencyLink[] | null;
  /** Approved-plan baseline. NULL until a baseline is captured; the
   *  live plannedStartAt/plannedAt drift from these. */
  baselineStartAt?: Timestamp | null;
  baselineFinishAt?: Timestamp | null;
  baselineSetAt?: Timestamp | null;
  baselineSetBy?: string | null;
  /** Optional decorative reference — "Rev 3 release" etc. Not enforced. */
  linkedRevisionLabel?: string | null;
  linkedTicketId?: string | null;
  source: MilestoneSource;
  externalRef?: string | null;
  createdAt?: Timestamp;
  createdBy: string;
  createdByName?: string | null;
  updatedAt?: Timestamp;
  updatedBy?: string;
  completedBy?: string | null;
  completedByName?: string | null;
  statusReason?: string | null;
}

// ─── Holds (Phase 5) ─────────────────────────────────────────────
// A document_holds row is an explicit operational block on a
// document. released_at = NULL means active. See lib/holds.ts.

/** The four directive-named reasons + an extensible "Other" slot.
 *  The DB column has no CHECK; orgs can record free-form reason
 *  strings, but the UI picks from this list by default. */
export type HoldReason =
  | "Awaiting Engineering"
  | "Field Verification Needed"
  | "Missing Vendor Data"
  | "Client Review"
  | "Other";

export interface DocumentHold {
  id?: string;
  orgId: string;
  documentId: string;
  reason: string;             // typically a HoldReason value; free text allowed
  notes?: string | null;
  expectedReleaseAt?: Timestamp;
  openedBy: string;
  openedByName?: string | null;
  openedAt: Timestamp;
  releasedBy?: string | null;
  releasedByName?: string | null;
  releasedAt?: Timestamp;
  releasedReason?: string | null;
}

// ─── Operational entity graph (Phase 1) ──────────────────────────
// Plant → Unit → System → (Asset | Document). Scope rows are
// optional metadata: every existing document and asset works
// without them. See migrations/20260606_operational_entity_graph.sql.

export interface Plant {
  id?: string;
  orgId: string;
  name: string;
  code?: string | null;
  description?: string | null;
  location?: string | null;
  metadata?: Record<string, unknown>;
  archived?: boolean;
  createdAt?: Timestamp;
  createdBy: string;
  updatedAt?: Timestamp;
  updatedBy?: string;
}

export interface Unit {
  id?: string;
  orgId: string;
  plantId: string;
  name: string;
  code?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  archived?: boolean;
  createdAt?: Timestamp;
  createdBy: string;
  updatedAt?: Timestamp;
  updatedBy?: string;
}

/** A logically-grouped piece of a Unit — feed system, overhead
 *  system, instrument-air system, etc. Named PlantSystem in TS to
 *  avoid collision with the global `System` type. The DB table is
 *  `systems`. */
export interface PlantSystem {
  id?: string;
  orgId: string;
  unitId: string;
  plantId: string;
  name: string;
  code?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  archived?: boolean;
  createdAt?: Timestamp;
  createdBy: string;
  updatedAt?: Timestamp;
  updatedBy?: string;
}

export type DocumentStatus = "Draft" | "Issued" | "Superseded" | "Void" | "Archived" | "Locked";

export interface DocumentRecord {
  id?: string;

  orgId?: string;
  libraryId: string;
  collectionId?: string | null;
  setId?: string | null;
  sheetNumber?: number | null;
  sheetTotal?: number | null;

  name?: string;
  documentNumber?: string;
  title?: string;
  /** Canonical revision label. Read this, not `revision`. */
  rev?: string;
  /**
   * @deprecated Mirror of `rev` written by legacy code. No active reader.
   * Future writers should set only `rev`. See docs/ARCHITECTURE.md
   * "Canonical sources of truth".
   */
  revision?: string;
  status?: DocumentStatus | string;

  currentVersionId?: string;

  metadata?: Record<string, MetadataValue>;
  metadataTemplateId?: string;
  metadataTags?: Record<string, string[]>;
  ingestion?: IngestionState;

  assetTags?: AssetTag[];
  tags?: string[];

  // Phase 1 operational entity graph — see types/schema.ts Plant/Unit/PlantSystem.
  // All three are optional; existing documents keep working with NULL scope.
  plantId?: string | null;
  unitId?: string | null;
  systemId?: string | null;

  downloadPolicy?: DownloadPolicy;
  watermarkPolicyId?: string;

  checkedOutBy?: string | null;
  checkedOutByName?: string | null;
  checkedOutAt?: Timestamp | null;
  currentLockId?: string | null; // Unique ID for the current checkout cycle (for chat isolation)
  checkoutNote?: string | null;
  activeCollaborators?: string[]; // Names of users with active sessions

  /**
   * @deprecated Legacy JSONB array kept in sync alongside the canonical
   * `document_versions` table. No active reader (audit confirmed
   * Phase 0). Treat as write-only legacy; do not add new readers.
   * Use `lib/revisions.ts:listVersions(documentId)` instead.
   */
  revisionHistory?: Array<{
    rev: string;
    date: Timestamp;
    user: string;
    description: string;
  }>;

  createdAt: Timestamp;
  createdBy: string;
  updatedAt?: Timestamp;
  updatedBy?: string;

  visibility?: NodeVisibility;
  acl?: AccessControl;
  aclIndex?: AclIndex;

  isPrivate?: boolean;
  scope?: "private" | "org";
}

export interface DocumentSet {
  id?: string;
  orgId?: string;
  libraryId: string;

  title: string;
  currentSetRev?: string;
  sheetCount?: number;
  assetIndex?: Record<string, string[]>;

  visibility?: NodeVisibility;
  acl?: AccessControl;
  aclIndex?: AclIndex;

  updatedAt?: Timestamp;
  createdAt?: Timestamp;
}

export interface DocumentVersion {
  id?: string;
  orgId?: string;
  recordId: string;

  revisionLabel: string;
  issueType?: "Internal Review" | "Issued for Construction" | "As-Built" | "Void";
  changeType?: "Major" | "Minor" | "Correction";

  fileUrl: string;
  fileType?: string;
  size?: number;

  isFlattened?: boolean;
  hasWatermark?: boolean;

  watermarkPolicyId?: string;
  downloadPolicy?: DownloadPolicy;

  changeLog?: string;
  relatedTicketId?: string;

  createdBy: string;
  createdByName?: string;
  createdAt: Timestamp;
  approvedBy?: string;

  // Document-control fields (Phase 1 — see supabase/migrations/20260526_document_version_control.sql)
  supersedesVersionId?: string;        // The version this one replaced
  drawnBy?: string;                    // Engineering signoff chain
  drawnByName?: string;
  checkedBy?: string;
  checkedByName?: string;
  approvedByName?: string;
  approvedAt?: Timestamp;
  releasedAt?: Timestamp;
  supersededAt?: Timestamp;            // Set when a newer version replaces this one
  mocReference?: string;               // Management of Change ticket #
  sourceFileName?: string;             // e.g. "P-101_Rev3.dwg"
  revertedFromVersionId?: string;      // If this rev was created via Revert
  fileHash?: string;                   // SHA-256 of the uploaded bytes
}

export interface TableViewConfig {
  id?: string;
  orgId?: string;
  ownerUserId?: string;
  name: string;
  libraryId: string;
  collectionId?: string | null;
  columns: string[];
  columnConfig?: Record<string, { width?: number; pinned?: "left" | "right" }>;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export type IngestionStatus = "queued" | "processing" | "completed" | "failed";

export interface IngestionState {
  status: IngestionStatus;
  updatedAt: Timestamp;
  error?: string;
  extractedFields?: Record<string, MetadataValue>;
  confidence?: Record<string, number>;
}

export interface IngestionJob {
  id?: string;
  orgId?: string;
  documentId: string;
  versionId?: string;
  storagePath: string;
  status: IngestionStatus;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  error?: string;
}

export interface DownloadStamp {
  includeUser?: boolean;
  includeEmail?: boolean;
  includeTimestamp?: boolean;
  includeDocId?: boolean;
  textTemplate?: string;
  expiresAt?: Timestamp;
}

export interface DownloadPolicy {
  requireStampedDownload?: boolean;
  defaultStamp?: DownloadStamp;
  defaultExpiresInHours?: number;
}

export interface WatermarkPolicy {
  id?: string;
  orgId?: string;
  name: string;
  enabled: boolean;
  stamp: DownloadStamp;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

export interface DownloadAudit {
  id?: string;
  orgId?: string;
  documentId: string;
  versionId?: string;
  userId: string;
  userEmail?: string;
  createdAt: Timestamp;
  expiresAt?: Timestamp;
  watermarkPolicyId?: string;
}

export type CheckoutMode = "view" | "markup" | "edit" | "drafting";
export type CheckoutStatus = "active" | "checked_in" | "abandoned" | "expired";

export interface CheckoutSession {
  id?: string;
  orgId?: string;
  documentId: string;
  libraryId: string;
  userId: string;
  userName?: string;
  mode: CheckoutMode;
  note?: string;
  status: CheckoutStatus;
  linkedTicketId?: string;
  lockId?: string; // Grouping ID for collaborative sessions
  startedAt: Timestamp;
  lastSeenAt: Timestamp;
  expiresAt?: Timestamp;
  endedAt?: Timestamp;

  // Phase 3 collaboration fields
  projectId?: string;                // nullable: ad-hoc checkouts have none
  purpose?: string;                  // richer than `note`
  expectedReleaseAt?: Timestamp;     // soft user-set deadline
  autoExpiresAt?: Timestamp;         // hard 24h cap for ad-hoc
  releasedAt?: Timestamp;
  releasedBy?: string;
  releasedReason?: string;
}

export type ProjectStatus = "active" | "paused" | "completed" | "cancelled" | "archived";
export type ProjectVisibility = "public" | "private";
export type ProjectMemberRole = "owner" | "collaborator" | "observer";

export interface Project {
  id?: string;
  orgId: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  ownerUserId: string;
  ownerUserName?: string;
  visibility: ProjectVisibility;
  mocReference?: string;
  linkedTicketId?: string;
  startedAt?: Timestamp;
  targetCompletionDate?: Timestamp;
  completedAt?: Timestamp;
  cancelledAt?: Timestamp;
  cancelledReason?: string;
  lastActivityAt?: Timestamp;
  createdAt?: Timestamp;
  createdBy: string;
  updatedAt?: Timestamp;
  updatedBy?: string;
}

export interface ProjectMember {
  id?: string;
  projectId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  role: ProjectMemberRole;
  /** Free text: what this member owns / will own on the project. */
  responsibility?: string | null;
  joinedAt?: Timestamp;
}

export type ProjectActivityType =
  | "comment" | "checkout_added" | "checkout_released"
  | "member_joined" | "member_left" | "status_changed"
  | "markup_requested" | "markup_shared"
  | "doc_added" | "doc_removed" | "ownership_transferred";

export interface ProjectActivity {
  id?: string;
  projectId: string;
  orgId: string;
  userId?: string;
  userName?: string;
  type: ProjectActivityType;
  body?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Timestamp;
}

export type MarkupRequestStatus = "open" | "shared" | "declined" | "cancelled";

export interface MarkupRequest {
  id?: string;
  orgId: string;
  projectId?: string;
  documentId: string;
  checkoutSessionId?: string;
  requestedByUserId: string;
  requestedByName?: string;
  requestedFromUserId: string;
  requestedFromName?: string;
  status: MarkupRequestStatus;
  message?: string;
  response?: string;
  sharedMarkupUrl?: string;
  createdAt?: Timestamp;
  resolvedAt?: Timestamp;
}

export type RequestType = string;

export type TicketStatus =
  | "NEW"
  | "PENDING_ENG_INITIAL"
  | "PENDING_ENG_TEAM"
  | "PENDING_ASSIGNMENT"
  | "DRAFTING"
  | "REVISION_REQ"
  | "PENDING_REVIEW"
  | "PENDING_IFC"
  | "FINAL_DRAFT"
  | "PENDING_FINAL_APPROVAL"
  | "CLOSED"
  | "CANCELED";

export type TicketAttachmentStatus = "staged" | "submitted" | "approved" | "rejected";
export type TicketAttachmentType = "Source" | "Reference" | "Draft" | "Final";

export interface TicketAttachment {
  id: string;
  name: string;
  url: string;
  type: TicketAttachmentType;
  status: TicketAttachmentStatus;
  size?: string;
  uploadedBy?: string;
  uploadedAt?: Timestamp;
}

export interface TicketComment {
  id: string;
  user: string;
  text: string;
  type?: "General" | "Approval" | "Rejection" | "Update" | "Revision" | "Reassignment";
  category?: string; // e.g., "Drafting Error", "Missing Info", "Scope Change"
  date: Timestamp;
  /** UUIDs of users mentioned in `text` via @[name](uid) syntax. */
  mentionedUserIds?: string[];
}

export interface NotificationPreferences {
  userId: string;
  emailEnabled: boolean;
  emailOnMention: boolean;
  emailOnAssignment: boolean;
  emailOnStatusChange: boolean;
  emailOnWatchedActivity: boolean;
  emailOnSlaWarning: boolean;
  digestFrequency: "instant" | "hourly" | "daily" | "never";
}

export type EmailNotificationStatus = "queued" | "sending" | "sent" | "failed" | "suppressed";
export type EmailEventType =
  | "ticket_status_changed" | "comment_mention" | "watcher_activity"
  | "sla_warning" | "engineer_review_requested" | "assignment"
  | "ticket_approved" | "ticket_revision_requested" | "ticket_closed";

export interface EmailNotification {
  id?: string;
  orgId: string;
  toUserId: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  resourceType?: "ticket" | "project" | "document";
  resourceId?: string;
  eventType: EmailEventType;
  metadata?: Record<string, unknown>;
  status: EmailNotificationStatus;
  attemptCount: number;
  lastAttemptedAt?: Timestamp;
  sentAt?: Timestamp;
  errorMessage?: string;
  createdAt?: Timestamp;
}

export interface TicketHistoryEntry {
  action: string;
  user?: string;
  role?: Role;
  date: Timestamp;
  details?: string;
  revisionRound?: number;
}

export interface Ticket {
  id?: string;
  orgId: string;
  ticketId: string;
  title: string;
  description?: string;
  unit: string;
  requestType: string;
  status: TicketStatus;
  priority?: number;

  requesterId: string;
  requesterName?: string;
  requesterEmail?: string;
  requesterRole?: Role;

  assignedDrafterId?: string | null;
  assignedDrafterName?: string | null;

  // Phase A engineer-routing — see lib/workflow.ts
  assignedEngineerId?: string | null;
  assignedEngineerName?: string | null;
  assignedEngineerEmail?: string | null;
  engineerReviewRequestedAt?: Timestamp | null;
  engineerApprovedAt?: Timestamp | null;
  engineerReviewReason?: string | null;

  // Phase B notification fields
  watchers?: string[];                // UUIDs of subscribed users
  targetCompletionAt?: Timestamp | null;  // SLA deadline
  slaBreachWarnedAt?: Timestamp | null;
  slaBreachedAt?: Timestamp | null;

  attachments?: TicketAttachment[];
  comments?: TicketComment[];
  history?: TicketHistoryEntry[];
  unreadBy?: string[];
  revisionCount?: number;

  searchKeywords?: string[];

  createdAt: Timestamp;
  lastModified?: Timestamp;
  updatedAt?: Timestamp;
}

// --- CONFIGURATION SCHEMA ---

export interface SelectOption {
  label: string;
  value: string | number;
  color?: string; // For badges
}

export interface FormFieldConfig {
  label: string; // The label shown on the form (e.g., "Unit / Area")
  enabled: boolean;
  options: SelectOption[];
}

/** Field types supported in admin-defined custom drafting categories.
 *  Kept conservative on purpose — these have to round-trip cleanly
 *  through the ticket's `metadata` JSONB and render in the existing
 *  ticket detail surface. */
export type CustomFieldType = "text" | "textarea" | "number" | "select" | "multiselect" | "date" | "boolean";

export interface CustomFieldDef {
  /** Stable key used as the metadata JSON key on the ticket. Snake_case. */
  key: string;
  label: string;
  type: CustomFieldType;
  required?: boolean;
  description?: string;
  /** For select / multiselect only. */
  options?: SelectOption[];
  /** Placeholder for text / textarea / number. */
  placeholder?: string;
}

export interface CustomCategoryConfig {
  /** Stable id (uuid). Used as the metadata sub-object key on the ticket. */
  id: string;
  /** Display label for the section header. */
  label: string;
  /** Optional one-line description shown under the header. */
  description?: string;
  enabled: boolean;
  fields: CustomFieldDef[];
}

export interface OrgDraftingSettings {
  requestTypes: FormFieldConfig;
  units: FormFieldConfig; // If empty, falls back to text input? Or admin defines list.
  priorities: FormFieldConfig;
  /** Admin-defined custom categories. Each renders as its own section
   *  in /requests/new and stores values on the ticket's metadata under
   *  metadata.custom_categories[category.id][field.key]. */
  customCategories?: CustomCategoryConfig[];
}

// ─── Phase 8 (delivered): equipment whiteboard state + spatial plot plans ───

/** Five operational states for an equipment item on the turnaround board
 *  and plot-plan markers. */
export type WhiteboardState =
  | "pending"     // not yet started
  | "drafting"    // documents being authored / redlined
  | "executing"   // field work happening
  | "completed"   // done; sign-off captured
  | "blocked";    // progress blocked (off the click-to-advance cycle)

/** One asset marker placed on a plot-plan background image, in 0..100
 *  percentage coordinates so it survives image rescaling. */
export interface PlotPlanMarker {
  assetId: string;
  xPct: number;
  yPct: number;
}

export interface PlotPlan {
  id: string;
  orgId: string;
  name: string;
  description?: string | null;
  plantId?: string | null;
  unitId?: string | null;
  systemId?: string | null;
  /** Storage PATH to the background image (presigned on read). */
  imagePath?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  markers: PlotPlanMarker[];
  createdBy?: string | null;
  createdByName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string | null;
}
