// lib/branches.ts
//
// REVISION BRANCHES — the debt ledger behind "publish anyway".
//
// When a stale-base publish is deliberately overridden, the version row is
// written but NOT promoted, and an open revision_branches row is created.
// A branch is never dismissed — only *resolved*, with a note, on the record:
//
//   merged    → its content was reconciled into a later current revision
//   withdrawn → the branch work was abandoned, explicitly
//
// Open branches surface on the document (badge), in version history, and in
// the DocCtrl review queue. Both authors (the brancher and the author of the
// revision that was current at divergence) are notified when a branch opens
// and when it resolves.

import { supabase } from "@/lib/supabase";
import { emit } from "@/lib/notify/dispatch";
import { logAuditAction } from "@/lib/audit";

export interface RevisionBranch {
  id: string;
  orgId: string;
  documentId: string;
  branchVersionId: string;
  divergedFromVersionId: string | null;
  reason: string;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolution: "merged" | "withdrawn" | null;
  resolutionNote: string | null;
}

function rowToBranch(r: Record<string, unknown>): RevisionBranch {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    documentId: r.document_id as string,
    branchVersionId: r.branch_version_id as string,
    divergedFromVersionId: (r.diverged_from_version_id as string | null) ?? null,
    reason: r.reason as string,
    createdBy: String(r.created_by),
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: r.created_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    resolvedBy: (r.resolved_by as string | null) ?? null,
    resolvedByName: (r.resolved_by_name as string | null) ?? null,
    resolution: (r.resolution as "merged" | "withdrawn" | null) ?? null,
    resolutionNote: (r.resolution_note as string | null) ?? null,
  };
}

// Pre-migration tolerance, same convention as checkoutEpisodes / intents.
let branchSchemaMissing = false;
export function resetBranchSchemaFlag(): void { branchSchemaMissing = false; }

function isMissingBranchSchema(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const code = e.code ?? "";
  if (code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST205") return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("revision_branches") &&
    (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find"));
}

/** Open branches for one document. Empty on pre-migration envs. */
export async function listOpenBranchesForDocument(documentId: string): Promise<RevisionBranch[]> {
  if (branchSchemaMissing) return [];
  const { data, error } = await supabase
    .from("revision_branches")
    .select("*")
    .eq("document_id", documentId)
    .is("resolved_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingBranchSchema(error)) { branchSchemaMissing = true; return []; }
    throw new Error(error.message);
  }
  return ((data as Record<string, unknown>[]) ?? []).map(rowToBranch);
}

/** Every branch (open + resolved) for a document, newest first. */
export async function listBranchesForDocument(documentId: string): Promise<RevisionBranch[]> {
  if (branchSchemaMissing) return [];
  const { data, error } = await supabase
    .from("revision_branches")
    .select("*")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingBranchSchema(error)) { branchSchemaMissing = true; return []; }
    throw new Error(error.message);
  }
  return ((data as Record<string, unknown>[]) ?? []).map(rowToBranch);
}

/** Org-wide open branches — the DocCtrl review queue read. */
export async function listOpenBranchesForOrg(orgId: string): Promise<RevisionBranch[]> {
  if (branchSchemaMissing) return [];
  const { data, error } = await supabase
    .from("revision_branches")
    .select("*")
    .eq("org_id", orgId)
    .is("resolved_at", null)
    .order("created_at", { ascending: true }); // oldest debt first
  if (error) {
    if (isMissingBranchSchema(error)) { branchSchemaMissing = true; return []; }
    throw new Error(error.message);
  }
  return ((data as Record<string, unknown>[]) ?? []).map(rowToBranch);
}

/**
 * Notify both sides that a branch opened. Called by the publish path after
 * publish_revision returns status='branched'. Fire-and-forget.
 */
export async function announceBranchOpened(input: {
  orgId: string;
  documentId: string;
  documentLabel: string;      // number/title for human-readable copy
  libraryId?: string | null;
  branchId: string;
  reason: string;
  actorUserId: string;
  actorName: string;
  /** Author of the revision that was current at divergence (the overwritten-ish party). */
  divergedFromAuthorId?: string | null;
  divergedFromRev?: string | null;
}): Promise<void> {
  try {
    const involved = [input.actorUserId];
    if (input.divergedFromAuthorId) involved.push(input.divergedFromAuthorId);
    await emit({
      orgId: input.orgId,
      category: "status",
      kind: "branch_open",
      title: `Unreconciled branch opened on ${input.documentLabel}`,
      body: `${input.actorName} published a branch based on an older revision${input.divergedFromRev ? ` (diverged from Rev ${input.divergedFromRev})` : ""}: "${input.reason}". It must be merged or withdrawn — it is not the current revision.`,
      link: input.libraryId ? `/documents/${input.libraryId}?doc=${input.documentId}` : undefined,
      resource: { type: "document", id: input.documentId },
      // Deliberately NOT excluding the actor: the brancher owns this debt and
      // needs the trail in their own feed too.
      audience: { involved, roles: ["DocCtrl"] },
      metadata: { branchId: input.branchId },
    });
  } catch (e) {
    console.warn("[branches] announce failed (non-blocking)", e);
  }
}

/** Resolve a branch — the only way it leaves the queue. */
export async function resolveBranch(input: {
  branchId: string;
  resolution: "merged" | "withdrawn";
  note: string;
  orgId: string;
  actorUserId: string;
  actorName: string;
  actorEmail?: string;
  actorRole?: string;
}): Promise<void> {
  if (!input.note.trim()) throw new Error("A resolution note is required");
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("revision_branches")
    .update({
      resolved_at: now,
      resolved_by: input.actorUserId,
      resolved_by_name: input.actorName,
      resolution: input.resolution,
      resolution_note: input.note.trim(),
    })
    .eq("id", input.branchId)
    .is("resolved_at", null) // CAS: only resolve a still-open branch
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Branch was already resolved by someone else.");

  const branch = rowToBranch(data as Record<string, unknown>);

  await logAuditAction({
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorEmail ?? "",
    userRole: input.actorRole ?? "",
    action: "BRANCH_RESOLVED",
    resourceType: "document",
    resourceId: branch.documentId,
    details: {
      branchId: branch.id,
      branchVersionId: branch.branchVersionId,
      resolution: input.resolution,
      note: input.note.trim(),
    },
  });

  try {
    await emit({
      orgId: input.orgId,
      category: "status",
      kind: "branch_resolved",
      title: `Branch ${input.resolution === "merged" ? "merged" : "withdrawn"}`,
      body: `${input.actorName} resolved the open branch: "${input.note.trim()}"`,
      resource: { type: "document", id: branch.documentId },
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      audience: { involved: [branch.createdBy] },
      metadata: { branchId: branch.id },
    });
  } catch { /* non-blocking */ }
}
