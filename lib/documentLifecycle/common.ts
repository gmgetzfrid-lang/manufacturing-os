// lib/documentLifecycle/common.ts
//
// Shared internals for the document-lifecycle workflows. Not
// re-exported from the public barrel (lib/documentLifecycle.ts);
// callers go through the per-operation modules (split.ts /
// merge.ts / renumber.ts / setRevUp.ts / reverse.ts).

import { supabase } from "@/lib/supabase";
import { uploadToPath, makeLibraryStoragePath } from "@/lib/storage";
import { logRevisionEvent, logHoldEvent } from "@/lib/audit";
import {
  voidPendingDraftAfterPublish,
  revokeLiveSharesForDocument,
  writeSupersessionLineage,
  type CreationStatus,
} from "@/lib/revisions";
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
 *
 * OWN-19: this UPDATE is 'advancing' at the database (20261060 — entering
 * Archived takes the publisher tier). It passes because the target was born
 * owned by the actor (createNewDocWithFirstVersion), so the guard's
 * effective-owner arm admits them whatever their library authority.
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

/** The supersession fields a source held before a lifecycle operation
 *  retired it — what a rollback puts back (a re-run on a document that was
 *  already Superseded keeps its first supersession). */
export interface PriorSupersessionFields {
  superseded_at?: unknown;
  superseded_by_user?: unknown;
  supersession_reason?: unknown;
  supersession_moc?: unknown;
}

/** Compensation: restore a source doc that was marked Superseded back to its
 *  prior status (and, when given, its prior supersession fields), and drop
 *  the supersession join rows created for this op. Checked (REV-12 /
 *  DRLS-13): a refused restore, a lineage row that could not be removed, or
 *  a removal that could not be CONFIRMED (the read-back failed) THROWS, so
 *  withCompensation reports it for manual cleanup instead of calling the
 *  rollback clean. Lineage DELETE is Document Control / Admin only at the
 *  database (20261131) — for any other actor the leftover rows are named in
 *  the error. */
export async function restoreSupersededSource(
  sourceDocId: string,
  priorStatus: string,
  replacementDocIds: string[],
  actor: ActorContext,
  prior: PriorSupersessionFields = {},
): Promise<void> {
  const now = new Date().toISOString();
  const { data: restored, error: restoreErr } = await supabase
    .from("documents")
    .update({
      status: priorStatus,
      superseded_at: prior.superseded_at ?? null,
      superseded_by_user: prior.superseded_by_user ?? null,
      supersession_reason: prior.supersession_reason ?? null,
      supersession_moc: prior.supersession_moc ?? null,
      updated_at: now,
      updated_by: actor.actorUserId,
    })
    .eq("id", sourceDocId)
    .select("id");
  if (restoreErr || ((restored as unknown[] | null) ?? []).length === 0) {
    throw new Error(`source ${sourceDocId} is still Superseded — restore it to ${priorStatus} (${restoreErr?.message ?? "the write was refused"})`);
  }
  if (replacementDocIds.length > 0) {
    const { error: delErr } = await supabase
      .from("document_supersessions")
      .delete()
      .eq("superseded_doc_id", sourceDocId)
      .in("replacement_doc_id", replacementDocIds);
    const { data: left, error: leftErr } = await supabase
      .from("document_supersessions").select("replacement_doc_id")
      .eq("superseded_doc_id", sourceDocId).in("replacement_doc_id", replacementDocIds);
    if (leftErr) {
      throw new Error(`the removal of up to ${replacementDocIds.length} supersession link(s) from ${sourceDocId} could not be confirmed (${leftErr.message})${delErr ? `; the delete answered: ${delErr.message}` : ""} — Document Control must check them`);
    }
    const remaining = ((left as unknown[] | null) ?? []).length;
    if (delErr || remaining > 0) {
      throw new Error(`${remaining || replacementDocIds.length} supersession link(s) from ${sourceDocId} could not be removed${delErr ? ` (${delErr.message})` : ""} — Document Control must delete them`);
    }
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
 *  new sheets.
 *
 *  OWN-19: the target is born OWNED by the actor (document-level
 *  owner_user_id / owner_name). The actor reached this call through the
 *  Inspector's lifecycle gate (controller, granted publisher, or the
 *  SOURCE's effective owner) — but a document-level owner of the source is
 *  nobody on the target, and the compensation that archives a half-built
 *  target when a later step fails (archiveRolledBackDoc) is an ordinary
 *  client-session UPDATE that enforce_document_publish_guard now treats as
 *  advancing (20261060). Stamping the actor makes them the target's
 *  effective owner at the database, so the rollback passes the guard for
 *  every actor the gate admits. The database's own cascade lets any member
 *  first-assign an unowned, unrestricted document (DEC-6); the actor who
 *  materialised the record is its accountable owner from the start. */
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
  /** REV-11: the status the new document is born with — the caller's
   *  decision, made after it resolved the publish authority and the review
   *  policy for the target (never a hardcoded "Issued" here). */
  initialStatus: CreationStatus;
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
      status: input.initialStatus,
      asset_tags: input.assetTags,
      plant_id: input.plantId ?? null,
      unit_id: input.unitId ?? null,
      system_id: input.systemId ?? null,
      metadata: input.metadata ?? {},
      owner_user_id: actor.actorUserId,
      owner_name: input.actorName || actor.actorEmail || null,
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

  // 4. Promote the version on the document. REV-11: checked for the row
  // count too, as createDocumentWithFile's first pointer write is — a
  // zero-row answer (a policy refusing the write) is a refusal, and a sheet
  // with no current revision must never read as created.
  const { data: promoted, error: updErr } = await supabase
    .from("documents")
    .update({ current_version_id: versionId, updated_at: now })
    .eq("id", newDocId)
    .select("id");
  if (updErr) throw new Error(updErr.message);
  if (((promoted as unknown[] | null) ?? []).length === 0) {
    throw new Error(`The new document ${input.documentNumber} was created but its first revision could not be made current (the write was refused).`);
  }

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
      initialStatus: input.initialStatus,
    },
  });

  return { documentId: newDocId, versionId, fileUrl: uploadResult.url };
}

/** What a lifecycle operation retired, for the step that finishes the
 *  retirement once nothing can roll back (completeSourceRetirement). */
export interface SupersededSource {
  sourceDocId: string;
  /** REV-12: the status the source held, read fresh. */
  priorStatus: string;
  /** REV-12: the operation's instant, recorded as `auditAt`. */
  auditAt: string;
}

/** Mark a document as superseded and link its replacements via the
 *  document_supersessions join table — the part of a split / merge
 *  retirement that CAN still be rolled back. Idempotent on the join rows.
 *
 *  Round F (P3 LIFECYCLE), in order:
 *   · REV-12 — the status the source held (and its supersession fields) are
 *     read FRESH from the database, never the caller's possibly-stale
 *     record; the status goes onto the audit event as `priorStatus`, with
 *     the operation's own timestamp as `auditAt`, so a reversal restores
 *     what was there and counts only work done after it.
 *   · REV-14 — the source's restore is REGISTERED with the caller's saga
 *     BEFORE anything is written, so a failure at ANY later point — this
 *     call's own status flip or lineage write included — puts it back: the
 *     prior status and supersession fields, and only the lineage pairs this
 *     attempt added. It runs only if the flip landed (a flip that never
 *     landed has nothing to undo). A document is never left Superseded with
 *     fewer links than were named while its replacements are archived.
 *   · REV-14 / DRLS-13 — the lineage write is a checked upsert on the pair.
 *
 *  What cannot be undone — voiding the source's in-flight review (REV-6:
 *  a voided sign-off never returns, 20261070) and revoking its share links
 *  (REV-10: revoked_at is frozen, 20261080) — is NOT done here: the caller
 *  runs completeSourceRetirement after its last step that can still roll
 *  back. Until then the source is retired at the database, so finalize
 *  refuses its draft (REV-5) and the share routes refuse its status (P1). */
export async function markSupersededAndLink(input: {
  sourceDocId: string;
  replacementDocIds: string[];
  reason: string;
  mocReference?: string;
  actor: ActorContext;
  /** The caller's compensation register (withCompensation). */
  register: (c: Compensation) => void;
  /** How the source is named in a compensation failure. */
  label: string;
}): Promise<SupersededSource> {
  const { sourceDocId, replacementDocIds, reason, mocReference, actor, register, label } = input;
  const now = new Date().toISOString();

  const { data: cur, error: curErr } = await supabase
    .from("documents")
    .select("status, superseded_at, superseded_by_user, supersession_reason, supersession_moc")
    .eq("id", sourceDocId).maybeSingle();
  if (curErr || !cur) throw new Error(`Couldn't read the source document's status (${curErr?.message ?? "not found"}) — nothing was retired.`);
  // A copy, taken now: what the rollback puts back is the state BEFORE the flip.
  const prior: PriorSupersessionFields & { status?: string | null } = { ...(cur as PriorSupersessionFields & { status?: string | null }) };
  const priorStatus = String(prior.status ?? "Issued");

  // The pairs that already exist are not this attempt's to remove.
  let preExisting = new Set<string>();
  if (replacementDocIds.length > 0) {
    const { data: pairs, error: pairsErr } = await supabase
      .from("document_supersessions").select("replacement_doc_id")
      .eq("superseded_doc_id", sourceDocId).in("replacement_doc_id", replacementDocIds);
    if (pairsErr) throw new Error(`Couldn't read ${label}'s existing replacement links (${pairsErr.message}) — nothing was retired.`);
    preExisting = new Set(((pairs as Array<{ replacement_doc_id: string }> | null) ?? []).map((r) => r.replacement_doc_id));
  }
  const addedPairs = replacementDocIds.filter((id) => !preExisting.has(id));

  let flipped = false;
  register({
    describe: `restore ${label} from Superseded`,
    run: async () => {
      if (!flipped) return; // the flip never landed — nothing to put back
      await restoreSupersededSource(sourceDocId, priorStatus, addedPairs, actor, {
        superseded_at: prior.superseded_at, superseded_by_user: prior.superseded_by_user,
        supersession_reason: prior.supersession_reason, supersession_moc: prior.supersession_moc,
      });
    },
  });

  const { data: flippedRows, error: updErr } = await supabase
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
    .eq("id", sourceDocId)
    .select("id");
  if (updErr) throw new Error(updErr.message);
  if (((flippedRows as unknown[] | null) ?? []).length === 0) {
    throw new Error("The source document was NOT superseded — you don't have authority to retire it.");
  }
  flipped = true;

  if (replacementDocIds.length > 0) {
    const rows = replacementDocIds.map((rid) => ({
      org_id: actor.orgId,
      superseded_doc_id: sourceDocId,
      replacement_doc_id: rid,
      reason: reason.trim(),
      created_by: actor.actorUserId,
      created_at: now,
    }));
    await writeSupersessionLineage(rows, sourceDocId, replacementDocIds);
  }

  return { sourceDocId, priorStatus, auditAt: now };
}

/** The retirement's irreversible half, run by split / merge only AFTER their
 *  last step that can still roll back: void the source's in-flight review
 *  draft (REV-6) and revoke its live share links (REV-10) — neither can be
 *  undone — then write the source's audit event carrying both outcomes and
 *  the REV-12 `priorStatus` / `auditAt`. Never throws: the retirement has
 *  committed, so a refused void or revocation is put on the record
 *  (`pendingDraftVoidProblem`, `shareRevokeError`) — finalize refuses a
 *  retired document (REV-5) and the share routes refuse a retired status
 *  (P1) meanwhile — as archive does. */
export async function completeSourceRetirement(input: {
  source: SupersededSource;
  replacementDocIds: string[];
  reason: string;
  mocReference?: string;
  actor: ActorContext;
  /** Audit action recorded on the SOURCE document. DOC_SPLIT for
   *  splits, DOC_MERGED for merges. */
  sourceAuditAction: "DOC_SPLIT" | "DOC_MERGED";
  /** Extra detail to record in the audit row. */
  details?: Record<string, unknown>;
}): Promise<void> {
  const { source, replacementDocIds, reason, mocReference, actor } = input;
  const draftVoid = await voidPendingDraftAfterPublish(source.sourceDocId, actor.actorUserId);
  const shares = await revokeLiveSharesForDocument(source.sourceDocId, actor.actorUserId);

  // Empty version id on the audit log — supersession is a document-
  // level state change, not a version creation.
  await logRevisionEvent({
    orgId: actor.orgId,
    documentId: source.sourceDocId,
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
      priorStatus: source.priorStatus,
      auditAt: source.auditAt,
      pendingDraftVoided: draftVoid.voidedVersionId,
      pendingDraftVoidProblem: draftVoid.problem,
      revokedShareLinks: shares.revoked,
      shareRevokeError: shares.error,
    },
  });
}

/** Copy any ACTIVE holds from the source document onto the target,
 *  with a note describing the carry-over. Skips any reason that's
 *  already open on the target (the partial UNIQUE constraint would
 *  reject it anyway).
 *
 *  HLD-2: every read and every insert is CHECKED — a hold that fails to
 *  carry over THROWS (the caller runs this inside its compensation register,
 *  BEFORE the source is superseded, so the whole operation rolls back rather
 *  than laundering a stop-work signal into a smaller number). Returns the
 *  ids it placed so a rollback can release exactly those. */
export async function copyActiveHoldsToDoc(input: {
  sourceDocId: string;
  targetDocId: string;
  originLabel: string;        // e.g. "Sheet 3 (split)"
  actor: ActorContext;
}): Promise<{ copied: number; holdIds: string[] }> {
  const { sourceDocId, targetDocId, originLabel, actor } = input;

  const { data: openHolds, error: readErr } = await supabase
    .from("document_holds")
    .select("reason, notes, expected_release_at")
    .eq("document_id", sourceDocId)
    .is("released_at", null);
  if (readErr) throw new Error(`Couldn't read the source's active holds (${readErr.message}) — they must carry over, so nothing was changed.`);

  const rows = (openHolds as Array<{ reason: string; notes: string | null; expected_release_at: string | null }>) ?? [];
  if (rows.length === 0) return { copied: 0, holdIds: [] };

  // Check existing open reasons on the target so we don't try to
  // insert duplicates (the partial unique would reject them).
  const { data: existing, error: existingErr } = await supabase
    .from("document_holds")
    .select("reason")
    .eq("document_id", targetDocId)
    .is("released_at", null);
  if (existingErr) throw new Error(`Couldn't read the new document's holds (${existingErr.message}) — the source's holds were not carried over.`);
  const existingReasons = new Set(
    ((existing as Array<{ reason: string }>) ?? []).map((r) => r.reason)
  );

  let copied = 0;
  const holdIds: string[] = [];
  try {
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
      if (error || !insertedHold) {
        throw new Error(`The "${h.reason}" hold could not be carried over to the new document (${error?.message ?? "the write was refused"}).`);
      }
      copied++;
      holdIds.push((insertedHold as { id: string }).id);
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
  } catch (e) {
    // HLD-2: a carry that fails part-way never returns, so the caller has no
    // ids to register for its rollback — release the holds THIS call already
    // placed on the target before rethrowing (checked: one left open is
    // named in the error for the hold queue).
    const base = (e as Error).message || String(e);
    if (holdIds.length === 0) throw e;
    try {
      await releaseCarriedHolds(holdIds, actor);
    } catch (relErr) {
      throw new Error(`${base} ${(relErr as Error).message}.`);
    }
    throw new Error(`${base} The ${holdIds.length} hold(s) already carried onto it were released.`);
  }
  return { copied, holdIds };
}

/** HLD-2 compensation: release exactly the holds a rolled-back operation
 *  carried onto a document it created (the document itself is archived by
 *  archiveRolledBackDoc). The 20261073 guard pins the release to the session
 *  and writes the HOLD_RELEASED record. Checked: a hold left open is named. */
export async function releaseCarriedHolds(holdIds: string[], actor: ActorContext): Promise<void> {
  if (holdIds.length === 0) return;
  const { data, error } = await supabase
    .from("document_holds")
    .update({
      released_at: new Date().toISOString(),
      released_by: actor.actorUserId,
      released_by_name: actor.actorEmail ?? null,
      released_reason: "Rolled back — the lifecycle operation that carried this hold over did not complete",
    })
    .in("id", holdIds)
    .is("released_at", null)
    .select("id");
  const n = ((data as unknown[] | null) ?? []).length;
  if (error || n < holdIds.length) {
    throw new Error(`${holdIds.length - n} carried-over hold(s) on a rolled-back document are still open${error ? ` (${error.message})` : ""} — release them from the hold queue`);
  }
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
