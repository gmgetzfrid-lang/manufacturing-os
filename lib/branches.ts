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
// revision that was current at divergence) and the DocCtrl pool are notified
// when a branch opens; the brancher and the DocCtrl pool when it resolves,
// and the pool's branch_open alerts are then marked read (PROD-3).

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

/** DRLS-9: what a refused 'merged' resolution means (the database ties a
 *  merge claim to a later current revision — 20261139). */
export const BRANCH_MERGE_REFUSED =
  "A merged resolution needs a later revision to be current — publish it first, or record the branch as withdrawn.";

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
  if (error) {
    // DRLS-9 (20261139): the UPDATE's WITH CHECK admits 'merged' only when a
    // later revision is the document's current one. Its other rules — the
    // USING's authority, a resolution, a trimmed non-empty note, resolved_by
    // = the signed-in user (DocControlQueue passes currentUser.uid) — this
    // write meets, so a WITH CHECK refusal (42501, a raw "new row violates
    // row-level security policy") on a merge claim is that rule; said plainly.
    if (error.code === "42501" && input.resolution === "merged") {
      throw new Error(BRANCH_MERGE_REFUSED);
    }
    throw new Error(error.message);
  }
  // OWN-21 / DEC-11: resolution is a controller-or-effective-owner act at
  // the database (revision_branches_org_update). A refusal is zero rows, the
  // same signal as the CAS losing — say both, never claim someone else did it.
  if (!data) throw new Error("Branch was not resolved — it was already resolved by someone else, or resolving it takes a controller or the document's owner.");

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

  // PROD-3: the closing half reaches the audience the opening half did — the
  // brancher and the DocCtrl pool announceBranchOpened alerted (the actor is
  // dropped by the dispatcher, so a brancher resolving their own branch still
  // tells the pool).
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
      audience: { involved: [branch.createdBy], roles: ["DocCtrl"] },
      metadata: { branchId: branch.id },
    });
  } catch { /* non-blocking */ }

  await clearBranchOpenAlerts(branch.id);
}

/** PROD-3 dw2: the branch_open alerts about a resolved branch are marked
 *  read for every recipient, so the DocCtrl queue clears itself — a browser
 *  may mark only its own rows read (20261161), so the database does it:
 *  clear_resolved_branch_alerts (20261181, SECURITY DEFINER; a resolved
 *  branch of an org the caller is active in, read_at only). Before that
 *  paste (42883 / PGRST202) the alerts stay unread, as they always did, and
 *  the miss is logged. Never thrown: the branch is already resolved.
 *  Answers how many alerts were cleared (null when it could not run). */
export async function clearBranchOpenAlerts(branchId: string): Promise<number | null> {
  try {
    const { data, error } = await supabase.rpc("clear_resolved_branch_alerts", { p_branch: branchId });
    if (error) {
      const missing = error.code === "42883" || error.code === "PGRST202";
      console.warn(missing
        ? "[branches] clear_resolved_branch_alerts is not deployed (paste 20261181) — the branch_open alerts stay unread"
        : `[branches] couldn't clear the branch_open alerts: ${error.message}`);
      return null;
    }
    return typeof data === "number" ? data : 0;
  } catch (e) {
    console.warn("[branches] couldn't clear the branch_open alerts", e);
    return null;
  }
}
