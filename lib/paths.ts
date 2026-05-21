// lib/paths.ts
// Centralized storage/document path builders.
// Goal: support BOTH legacy single-tenant paths and org-scoped multi-tenant paths
// without breaking existing data. If orgId is present, we namespace under /orgs/{orgId}/...

export type TenantScope = {
  orgId?: string | null; // undefined/null => legacy/single-tenant mode
};

function cleanSegment(v: string) {
  return v.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function storageBaseForLibrary(args: TenantScope & { libraryId: string }) {
  const libraryId = cleanSegment(args.libraryId);
  const orgId = args.orgId ? cleanSegment(args.orgId) : null;

  // Legacy: libraries/{libraryId}/...
  // Multi-tenant: orgs/{orgId}/libraries/{libraryId}/...
  return orgId ? `orgs/${orgId}/libraries/${libraryId}` : `libraries/${libraryId}`;
}

export function storageBaseForTickets(args: TenantScope & { ticketId: string }) {
  const ticketId = cleanSegment(args.ticketId);
  const orgId = args.orgId ? cleanSegment(args.orgId) : null;

  // Legacy: tickets/{ticketId}/...
  // Multi-tenant: orgs/{orgId}/tickets/{ticketId}/...
  return orgId ? `orgs/${orgId}/tickets/${ticketId}` : `tickets/${ticketId}`;
}

export function storageBaseForUserPrivate(args: TenantScope & { uid: string }) {
  const uid = cleanSegment(args.uid);
  const orgId = args.orgId ? cleanSegment(args.orgId) : null;

  // Legacy: user_private/{uid}/...
  // Multi-tenant: orgs/{orgId}/user_private/{uid}/...
  return orgId ? `orgs/${orgId}/user_private/${uid}` : `user_private/${uid}`;
}

/**
 * Controlled library file upload target
 * Example:
 *  storageLibraryFilePath({orgId, libraryId, collectionPath: ["Unit 20","P&IDs"], filename})
 */
export function storageLibraryFilePath(args: TenantScope & {
  libraryId: string;
  collectionPath?: string[]; // folder path segments (human names), optional
  filename: string;
}) {
  const base = storageBaseForLibrary({ orgId: args.orgId, libraryId: args.libraryId });
  const folders = (args.collectionPath ?? []).map(cleanSegment).filter(Boolean);
  const filename = cleanSegment(args.filename);
  return [base, ...folders, filename].join("/");
}

/**
 * Ticket attachment upload target
 */
export function storageTicketAttachmentPath(args: TenantScope & {
  ticketId: string;
  filename: string;
}) {
  const base = storageBaseForTickets({ orgId: args.orgId, ticketId: args.ticketId });
  const filename = cleanSegment(args.filename);
  return `${base}/attachments/${filename}`;
}

/**
 * (Future) stamped downloads / generated artifacts (watermark, expiry)
 * Keep separate from source files.
 */
export function storageGeneratedDownloadPath(args: TenantScope & {
  uid: string;
  documentId: string;
  token: string;     // random id for the generated file
  filename: string;  // display name (pdf)
}) {
  const orgId = args.orgId ? cleanSegment(args.orgId) : null;
  const uid = cleanSegment(args.uid);
  const documentId = cleanSegment(args.documentId);
  const token = cleanSegment(args.token);
  const filename = cleanSegment(args.filename);

  // Legacy: drafting_support/generated/{uid}/{documentId}/{token}/{filename}
  // Multi-tenant: orgs/{orgId}/drafting_support/generated/{uid}/{documentId}/{token}/{filename}
  const root = orgId ? `orgs/${orgId}/drafting_support/generated` : `drafting_support/generated`;
  return `${root}/${uid}/${documentId}/${token}/${filename}`;
}
