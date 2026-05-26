export type Timestamp = Date | number | string | null;

export type MemberStatus = "active" | "invited" | "suspended" | "inactive";

export type Role =
  | "Admin"
  | "DocCtrl"
  | "Manager"
  | "Supervisor"
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
  rev?: string;
  revision?: string;
  status?: DocumentStatus | string;

  currentVersionId?: string;

  metadata?: Record<string, MetadataValue>;
  metadataTemplateId?: string;
  metadataTags?: Record<string, string[]>;
  ingestion?: IngestionState;

  assetTags?: AssetTag[];
  tags?: string[];

  downloadPolicy?: DownloadPolicy;
  watermarkPolicyId?: string;

  checkedOutBy?: string | null;
  checkedOutByName?: string | null;
  checkedOutAt?: Timestamp | null;
  currentLockId?: string | null; // Unique ID for the current checkout cycle (for chat isolation)
  checkoutNote?: string | null;
  activeCollaborators?: string[]; // Names of users with active sessions

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

export interface OrgDraftingSettings {
  requestTypes: FormFieldConfig;
  units: FormFieldConfig; // If empty, falls back to text input? Or admin defines list.
  priorities: FormFieldConfig;
}
