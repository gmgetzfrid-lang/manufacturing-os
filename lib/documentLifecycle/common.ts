// lib/documentLifecycle/common.ts
//
// Shared internals for the document-lifecycle workflows. Not
// re-exported from the public barrel (lib/documentLifecycle.ts);
// callers go through the per-operation modules (split.ts /
// merge.ts / renumber.ts / setRevUp.ts / reverse.ts).

import { supabase } from "@/lib/supabase";
import { uploadToPath, makeLibraryStoragePath } from "@/lib/storage";
import { logRevisionEvent, logHoldEvent } from "@/lib/audit";
import type { AssetTag } from "@/types/schema";

export interface ActorContext {
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

// ─── Saga / compensating-rollback ────────────────────────────────
//
// supabase-js can't open a multi-statement transaction from the client,
// and these workflows also touch object storage (R2) which can't live
// inside a DB transaction anyway. So we use the saga pattern: each step
// registers a compensation, and if a later step throws we run the
// compensations in reverse to undo the partial work — turning a partial
// state into either full success or a clean rollback, never a
// success-shaped lie.

export interface Compensation {
  /** Human-readable label (surfaced if compensation itself fails). */
  describe: string;
  run: () => Promise<void>;
}

/**
 * Run `work`, giving it a `register` callback to record compensations as it
 * makes durable changes. On any throw, compensations run in reverse order
 * (best-effort) before the original error is re-thrown. Compensation failures
 * are collected and appended to the thrown error so an operator can finish
 * the cleanup by hand if needed.
 */
export async function withCompensation<T>(
  work: (register: (c: Compensation) => void) => Promise<T>,
): Promise<T> {
  const comps: Compensation[] = [];
  const register = (c: Compensation) => comps.push(c);
  try {
    return await work(register);
  } catch (err) {
    const failures: string[] = [];
    for (let i = comps.length - 1; i >= 0; i--) {
      try {
        await comps[i].run();
      } catch (compErr) {
        failures.push(`${comps[i].describe}: ${(compErr as Error).message}`);
      }
    }
    const base = (err as Error).message || String(err);
    if (failures.length > 0) {
      throw new Error(
        `${base}\n\nThe operation was rolled back, but some cleanup steps failed and may need manual attention:\n- ${failures.join("\n- ")}`,
      );
    }
    throw new Error(`${base} (the operation was rolled back — no partial changes were kept).`);
  }
}

/**
 * Compensation: park a doc that was created mid-operation but whose operation
 * later failed. We Archive rather than hard-delete so the audit row written at
 * creation stays consistent (the doc still exists, just retired). The partial
 * UNIQUE index on document_number excludes Archived, so the number is freed
 * for a retry.
 */
export async function archiveRolledBackDoc(docId: string, actor: ActorContext): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("documents")
    .update({
      status: "Archived",
      archived_at: now,
      updated_at: now,
      updated_by: actor.actorUserId,
      supersession_reason: "Rolled back — lifecycle operation failed before completion",
    })
    .eq("id", docId);
  if (error) throw new Error(error.message);
}

/** Compensation: restore a source doc that was marked Superseded back to its
 *  prior status, and drop the supersession join rows created for this op. */
export async function restoreSupersededSource(
  sourceDocId: string,
  priorStatus: string,
  replacementDocIds: string[],
  actor: ActorContext,
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from("documents")
    .update({
      status: priorStatus,
      superseded_at: null,
      superseded_by_user: null,
      supersession_reason: null,
      supersession_moc: null,
      updated_at: now,
      updated_by: actor.actorUserId,
    })
    .eq("id", sourceDocId);
  if (replacementDocIds.length > 0) {
    await supabase
      .from("document_supersessions")
      .delete()
      .eq("superseded_doc_id", sourceDocId)
      .in("replacement_doc_id", replacementDocIds);
  }
}

export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Insert a brand-new document row + first version row + set
 *  current_version_id, all in one go. Returns the inserted document id.
 *  This is the building block used by split and merge to materialize
 *  new sheets. */
export async function createNewDocWithFirstVersion(input: {
  orgId: string;
  libraryId: string;
  folderPath?: string[];
  collectionId?: string | null;
  setId?: string | null;
  sheetNumber?: number | null;
  documentNumber: string;
  title: string;
  name?: string;
  initialRevLabel: string;
  changeLog: string;
  assetTags: AssetTag[];
  // Optional scope FK inheritance
  plantId?: string | null;
  unitId?: string | null;
  systemId?: string | null;
  metadata?: Record<string, unknown>;
  file: File;
  actor: ActorContext;
  actorName?: string;
  /** Audit action type fired for the new doc — varies by caller
   *  (CREATED_FROM_SPLIT vs CREATED_FROM_MERGE). */
  creationAuditAction: "CREATED_FROM_SPLIT" | "CREATED_FROM_MERGE";
  /** Reference back to the operation that birthed this doc — the
   *  source doc id (for split) or array of source ids (for merge). */
  creationDetails: Record<string, unknown>;
}): Promise<{ documentId: string; versionId: string; fileUrl: string }> {
  const { orgId, libraryId, folderPath, file, actor } = input;
  const now = new Date().toISOString();

  // 1. Insert documents row first so we have an id to scope the version under.
  const { data: docData, error: docErr } = await supabase
    .from("documents")
    .insert({
      org_id: orgId,
      library_id: libraryId,
      collection_id: input.collectionId ?? null,
      set_id: input.setId ?? null,
      sheet_number: input.sheetNumber ?? null,
      document_number: input.documentNumber,
      title: input.title,
      name: input.name ?? input.title,
      rev: input.initialRevLabel,
      revision: input.initialRevLabel,
      status: "Issued",
      asset_tags: input.assetTags,
      plant_id: input.plantId ?? null,
      unit_id: input.unitId ?? null,
      system_id: input.systemId ?? null,
      metadata: input.metadata ?? {},
      created_by: actor.actorUserId,
      updated_by: actor.actorUserId,
    })
    .select("id")
    .single();
  if (docErr || !docData) throw new Error(docErr?.message || "Failed to create new document");
  const newDocId = (docData as { id: string }).id;

  // 2. Hash + upload the file.
  const fileHash = await sha256Hex(file);
  const safeRev = input.initialRevLabel.replace(/[^\w.\-]+/g, "_");
  const stem = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop() || "pdf";
  const versionedName = `${stem}__rev${safeRev}__${Date.now()}.${ext}`;
  const storagePath = makeLibraryStoragePath({ orgId, libraryId, folderPath, filename: versionedName });
  const uploadResult = await uploadToPath(file, storagePath, { contentType: file.type || undefined });

  // 3. Insert first version row.
  const { data: verData, error: verErr } = await supabase
    .from("document_versions")
    .insert({
      org_id: orgId,
      record_id: newDocId,
      revision_label: input.initialRevLabel,
      change_log: input.changeLog,
      file_url: uploadResult.url,
      file_type: file.type || "application/octet-stream",
      size: uploadResult.size,
      file_hash: fileHash,
      released_at: now,
      created_by: actor.actorUserId,
      created_by_name: input.actorName || actor.actorEmail || actor.actorUserId,
      created_at: now,
      source_file_name: file.name,
    })
    .select("id")
    .single();
  if (verErr || !verData) throw new Error(verErr?.message || "Failed to create version row");
  const versionId = (verData as { id: string }).id;

  // 4. Promote the version on the document.
  const { error: updErr } = await supabase
    .from("documents")
    .update({ current_version_id: versionId, updated_at: now })
    .eq("id", newDocId);
  if (updErr) throw new Error(updErr.message);

  // 5. Audit row.
  await logRevisionEvent({
    orgId,
    documentId: newDocId,
    versionId,
    userId: actor.actorUserId,
    userEmail: actor.actorEmail ?? "",
    userRole: actor.actorRole ?? "",
    type: input.creationAuditAction,
    details: {
      ...input.creationDetails,
      revisionLabel: input.initialRevLabel,
      narrative: input.changeLog,
      fileHash,
    },
  });

  return { documentId: newDocId, versionId, fileUrl: uploadResult.url };
}

/** Mark a document as superseded and link its replacements via the
 *  document_supersessions join table. Idempotent on the join rows. */
export async function markSupersededAndLink(input: {
  sourceDocId: string;
  replacementDocIds: string[];
  reason: string;
  mocReference?: string;
  actor: ActorContext;
  /** Audit action recorded on the SOURCE document. DOC_SPLIT for
   *  splits, DOC_MERGED for merges, SUPERSEDE_DOC for plain
   *  supersessions. */
  sourceAuditAction: "DOC_SPLIT" | "DOC_MERGED" | "SUPERSEDE_DOC";
  /** Extra detail to record in the audit row. */
  details?: Record<string, unknown>;
}): Promise<void> {
  const { sourceDocId, replacementDocIds, reason, mocReference, actor } = input;
  const now = new Date().toISOString();

  const { error: updErr } = await supabase
    .from("documents")
    .update({
      status: "Superseded",
      superseded_at: now,
      superseded_by_user: actor.actorUserId,
      supersession_reason: reason.trim(),
      supersession_moc: mocReference?.trim() || null,
      updated_at: now,
      updated_by: actor.actorUserId,
    })
    .eq("id", sourceDocId);
  if (updErr) throw new Error(updErr.message);

  if (replacementDocIds.length > 0) {
    const rows = replacementDocIds.map((rid) => ({
      org_id: actor.orgId,
      superseded_doc_id: sourceDocId,
      replacement_doc_id: rid,
      reason: reason.trim(),
      created_by: actor.actorUserId,
      created_at: now,
    }));
    // ON CONFLICT DO NOTHING — partial UNIQUE on (superseded, replacement)
    await supabase.from("document_supersessions").upsert(rows, { onConflict: "superseded_doc_id,replacement_doc_id" });
  }

  // Empty version id on the audit log — supersession is a document-
  // level state change, not a version creation.
  await logRevisionEvent({
    orgId: actor.orgId,
    documentId: sourceDocId,
    versionId: "",
    userId: actor.actorUserId,
    userEmail: actor.actorEmail ?? "",
    userRole: actor.actorRole ?? "",
    type: input.sourceAuditAction,
    details: {
      reason: reason.trim(),
      mocReference: mocReference?.trim() || null,
      replacementDocIds,
      ...(input.details ?? {}),
    },
  });
}

/** Copy any ACTIVE holds from the source document onto the target,
 *  with a note describing the carry-over. Skips any reason that's
 *  already open on the target (the partial UNIQUE constraint would
 *  reject it anyway). */
export async function copyActiveHoldsToDoc(input: {
  sourceDocId: string;
  targetDocId: string;
  originLabel: string;        // e.g. "Sheet 3 (split)"
  actor: ActorContext;
}): Promise<number> {
  const { sourceDocId, targetDocId, originLabel, actor } = input;

  const { data: openHolds } = await supabase
    .from("document_holds")
    .select("reason, notes, expected_release_at")
    .eq("document_id", sourceDocId)
    .is("released_at", null);

  const rows = (openHolds as Array<{ reason: string; notes: string | null; expected_release_at: string | null }>) ?? [];
  if (rows.length === 0) return 0;

  // Check existing open reasons on the target so we don't try to
  // insert duplicates (the partial unique would reject them).
  const { data: existing } = await supabase
    .from("document_holds")
    .select("reason")
    .eq("document_id", targetDocId)
    .is("released_at", null);
  const existingReasons = new Set(
    ((existing as Array<{ reason: string }>) ?? []).map((r) => r.reason)
  );

  let copied = 0;
  for (const h of rows) {
    if (existingReasons.has(h.reason)) continue;
    const note = `Carried over from ${originLabel}.${h.notes ? ` Original notes: ${h.notes}` : ""}`;
    const { data: insertedHold, error } = await supabase
      .from("document_holds")
      .insert({
        org_id: actor.orgId,
        document_id: targetDocId,
        reason: h.reason,
        notes: note,
        expected_release_at: h.expected_release_at,
        opened_by: actor.actorUserId,
        opened_by_name: actor.actorEmail ?? null,
      })
      .select("id")
      .single();
    if (!error && insertedHold) {
      copied++;
      // Mirror the hold audit event so the timeline shows it.
      await logHoldEvent({
        orgId: actor.orgId,
        documentId: targetDocId,
        holdId: (insertedHold as { id: string }).id,
        userId: actor.actorUserId,
        userEmail: actor.actorEmail,
        userRole: actor.actorRole,
        type: "HOLD_OPENED",
        reason: h.reason,
        details: { carriedOverFrom: sourceDocId, originLabel },
      });
    }
  }
  return copied;
}

/** Copy project_documents membership rows from source to target.
 *  The trigger maintains rows when checkouts happen; this manual copy
 *  is what gives a new doc immediate membership in the same projects
 *  its source belonged to. Uses source='manual' so the trigger
 *  doesn't fight it. */
export async function copyProjectMembershipToDoc(input: {
  sourceDocId: string;
  targetDocId: string;
  actor: ActorContext;
}): Promise<number> {
  const { sourceDocId, targetDocId, actor } = input;
  const { data: links } = await supabase
    .from("project_documents")
    .select("project_id")
    .eq("document_id", sourceDocId);
  const rows = ((links as Array<{ project_id: string }>) ?? []);
  if (rows.length === 0) return 0;

  const now = new Date().toISOString();
  const inserts = rows.map((r) => ({
    org_id: actor.orgId,
    project_id: r.project_id,
    document_id: targetDocId,
    first_seen_at: now,
    last_seen_at: now,
    source: "manual" as const,
  }));
  const { error } = await supabase
    .from("project_documents")
    .upsert(inserts, { onConflict: "project_id,document_id" });
  if (error) throw new Error(error.message);
  return inserts.length;
}
