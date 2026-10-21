// lib/documentLifecycle/common.ts
//
// Shared internals for the document-lifecycle workflows. Not
// re-exported from the public barrel (lib/documentLifecycle.ts);
// callers go through the per-operation modules (split.ts /
// merge.ts / renumber.ts / setRevUp.ts / reverse.ts).

import { supabase } from "@/lib/supabase";
import { uploadToPath, makeLibraryStoragePath } from "@/lib/storage";
import { logRevisionEvent, logHoldEvent, logAuditAction } from "@/lib/audit";
import { OTHER_HOLD_REASON, holdReasonLabel, openHoldKey } from "@/lib/holds";
import {
  voidPendingDraftAfterPublish,
  revokeLiveSharesForDocument,
  writeSupersessionLineage,
  startIssuedDocumentClocks,
  putBackRetiredIssue,
  describePutBackStatus,
  retireOverHold,
  showsSupersessionAt,
  type CreationStatus,
  type RetireOverHoldDoor,
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
  /** REV-29 (P25 review fix): a compensation that LANDED, but not exactly as
   *  a put-back of what was there (a NULL status put back as 'Issued' on an
   *  older database body), answers a one-sentence NOTE, said in the thrown
   *  error after the rollback sentence — never silently. A failure throws. */
  run: () => Promise<void | string>;
}

/** REV-36 (document-control P36 review fix): why a saga rolled back — set by
 *  withCompensation once `work` has thrown, before any compensation runs, for
 *  a compensation that puts it on the record (correctRetiredOverHold). */
export interface RollbackCause { reason: string | null }

/**
 * Run `work`, giving it a `register` callback to record compensations as it
 * makes durable changes. On any throw, compensations run in reverse order
 * (best-effort) before the original error is re-thrown. Compensation failures
 * are collected and appended to the thrown error so an operator can finish
 * the cleanup by hand if needed; a note a compensation answered is appended
 * too ("Rollback note: …"). `rollback` (P36 review fix) carries the thrown
 * error's message to the compensations that record why the saga rolled back.
 */
export async function withCompensation<T>(
  work: (register: (c: Compensation) => void, rollback: RollbackCause) => Promise<T>,
): Promise<T> {
  const comps: Compensation[] = [];
  const register = (c: Compensation) => comps.push(c);
  const rollback: RollbackCause = { reason: null };
  try {
    return await work(register, rollback);
  } catch (err) {
    rollback.reason = (err as Error)?.message || String(err);
    const failures: string[] = [];
    const notes: string[] = [];
    for (let i = comps.length - 1; i >= 0; i--) {
      try {
        const note = await comps[i].run();
        if (typeof note === "string" && note.trim()) notes.push(note.trim());
      } catch (compErr) {
        failures.push(`${comps[i].describe}: ${(compErr as Error).message}`);
      }
    }
    const base = (err as Error).message || String(err);
    const noted = notes.length > 0 ? ` Rollback note: ${notes.join(" ")}` : "";
    if (failures.length > 0) {
      throw new Error(
        `${base}\n\nThe operation was rolled back, but some cleanup steps failed and may need manual attention:\n- ${failures.join("\n- ")}${noted}`,
      );
    }
    throw new Error(`${base} (the operation was rolled back — no partial changes were kept).${noted}`);
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

/** REV-36 (document-control P36 review fix): the compensation for a
 *  supersession retire_over_hold RECORDED as a pass over a hold (it answered
 *  superseded_over_hold — a split / merge source flip, a reversal's park)
 *  when the saga then rolls back and puts the document back. The
 *  REV_HOLD_OVERRIDDEN row stays (audit rows are append-only), so this writes
 *  the correction beside it — REV_HOLD_OVERRIDE_UNDONE (corrects
 *  REV_HOLD_OVERRIDDEN, the door's `via`, the status it was put back to and
 *  why the saga rolled back) — as reverse.ts correctRecordedPass corrects a
 *  recorded restore (P18). REGISTER IT BEFORE the put-back's own
 *  compensation, so the LIFO rollback runs it AFTER the put-back; it writes
 *  only once the row reads back out of Superseded (the put-back landed — a
 *  recorded pass is always taken from a status other than Superseded): if the
 *  put-back did not land, the pass over the hold stands and its record is
 *  true (the put-back's own failure is already named). A correction that
 *  cannot be confirmed or written throws, so withCompensation names it for
 *  manual attention. `pass.recorded` is set by the caller once the write
 *  answered superseded_over_hold; until then this does nothing.
 *  REV-37 (document-control P37): `"unknown"` — the write's answer was lost
 *  (lib/revisions.ts retireOverHold) — is decided from the record: the
 *  correction is written when the newest REV_HOLD_OVERRIDDEN on the document
 *  by this actor through this door stands uncorrected (no
 *  REV_HOLD_OVERRIDE_UNDONE of the same door after it), as reverse.ts
 *  findUncorrectedPass decides a lost restore's; a read that fails throws
 *  (named for manual attention). P37 fix pass: only a row THIS call could
 *  have written counts — `thisCall`, the reason the call sent (retire_over_hold
 *  records it, trimmed) and the instant it sent (the row is stamped by the
 *  database at the call, so nothing earlier than that instant less
 *  LOST_ANSWER_CLOCK_SKEW_MS) — so an earlier operation's stale, uncorrected
 *  pass through the same door never draws a correction for a pass this call
 *  never made. */
export function correctRetiredOverHold(input: {
  documentId: string;
  via: RetireOverHoldDoor;
  label: string;
  pass: { recorded: boolean | "unknown" };
  actor: ActorContext;
  rollback?: RollbackCause | null;
  /** What this call sent to retire_over_hold: its reason and its instant (p_at). */
  thisCall: { reason: string; at: string };
}): Compensation {
  const { documentId, via, label, pass, actor, thisCall } = input;
  return {
    describe: `correct the hold-override record on ${label}`,
    run: async () => {
      if (!pass.recorded) return;
      const { data, error } = await supabase.from("documents").select("status").eq("id", documentId).maybeSingle();
      if (error || !data) {
        throw new Error(`whether ${label} was put back could not be confirmed (${error?.message ?? "not found"}), so the record of its supersession over its hold (REV_HOLD_OVERRIDDEN) was not corrected — check its status and history`);
      }
      const putBackTo = (data as { status?: string | null }).status ?? null;
      if (putBackTo === "Superseded") return;
      if (pass.recorded === "unknown" && !(await standingRetiredOverHold(documentId, via, actor, label, thisCall))) return;
      const { error: logErr } = await logAuditAction({
        action: "REV_HOLD_OVERRIDE_UNDONE",
        resourceId: documentId,
        resourceType: "document",
        orgId: actor.orgId,
        userId: actor.actorUserId,
        userEmail: actor.actorEmail,
        userRole: actor.actorRole,
        details: {
          via,
          corrects: "REV_HOLD_OVERRIDDEN",
          putBackTo,
          rollbackReason: input.rollback?.reason ?? null,
        },
      });
      if (logErr) {
        throw new Error(`the record of ${label}'s supersession over its hold (REV_HOLD_OVERRIDDEN) could not be corrected (${logErr}) — its history shows a hold override that did not stand`);
      }
    },
  };
}

/** REV-37 (P37 fix pass): how far the browser's clock (the instant a call
 *  sends) may run ahead of the database's (the instant it stamps the record)
 *  for a lost answer's record still to be read as this call's. */
export const LOST_ANSWER_CLOCK_SKEW_MS = 10 * 60 * 1000;

/** REV-37 (P37): whether a pass over a hold THIS call recorded on the
 *  document still stands uncorrected — among this actor's REV_HOLD_OVERRIDDEN
 *  / REV_HOLD_OVERRIDE_UNDONE rows through `via` stamped no earlier than the
 *  call's instant (less LOST_ANSWER_CLOCK_SKEW_MS), the newest is a
 *  REV_HOLD_OVERRIDDEN carrying the reason this call sent (P37 fix pass: an
 *  earlier operation's pass through the same door is not this call's).
 *  A failed read THROWS. */
async function standingRetiredOverHold(documentId: string, via: RetireOverHoldDoor, actor: ActorContext, label: string, thisCall: { reason: string; at: string }): Promise<boolean> {
  type Row = { action: string; user_id: string | null; details: Record<string, unknown> | null };
  const sent = Date.parse(thisCall.at);
  const since = new Date((Number.isFinite(sent) ? sent : Date.now()) - LOST_ANSWER_CLOCK_SKEW_MS).toISOString();
  const { data, error } = await supabase
    .from("audit_logs")
    .select("action, user_id, details")
    .eq("org_id", actor.orgId)
    .eq("resource_id", documentId)
    .in("action", ["REV_HOLD_OVERRIDDEN", "REV_HOLD_OVERRIDE_UNDONE"])
    .gte("timestamp", since)
    .order("timestamp", { ascending: false })
    .limit(50);
  if (error) {
    throw new Error(`whether ${label}'s lost supersession recorded a pass over its hold could not be read (${error.message}), so no correction was written — check its history`);
  }
  const reason = thisCall.reason.trim();
  const newest = ((data as Row[] | null) ?? []).find((r) => r.user_id === actor.actorUserId && r.details?.via === via
    && (r.action === "REV_HOLD_OVERRIDE_UNDONE" || String(r.details?.reason ?? "").trim() === reason));
  return newest?.action === "REV_HOLD_OVERRIDDEN";
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
 *  the error.
 *
 *  REV-23 (P19): the status put-back goes through put_back_retired_issue
 *  (20261165) — the same write, run as the caller, recorded
 *  (REV_HOLD_OVERRIDDEN) when Document Control puts a held source it retired
 *  back into the issue the split / merge stamped, which the guard no longer
 *  admits bare — and the direct write only while the function is absent.
 *
 *  REV-29 (P25): `priorStatus` is what the source WAS, a NULL (or blank)
 *  status included — put back as that, never as "Issued". On a database
 *  whose put_back_retired_issue predates 20261192 (it refuses a NULL
 *  status) a NULL is put back as "Issued", exactly as before P25 (an older
 *  body takes today's path) — and SAID (P25 review fix): the status it was
 *  put back as is answered when it is not the one asked for, so the saga
 *  names it in its rollback note (markSupersededAndLink's compensation),
 *  as undoFailedSupersede's sentence names it; with no function at all the
 *  direct write puts back the NULL (the guard there judges it as it judged
 *  'Issued'). Answers undefined when put back as asked. */
export async function restoreSupersededSource(
  sourceDocId: string,
  priorStatus: string | null,
  replacementDocIds: string[],
  actor: ActorContext,
  prior: PriorSupersessionFields = {},
): Promise<string | undefined> {
  const now = new Date().toISOString();
  // The rollback puts back the state from before the flip: it asks for the
  // pass — given only for the retirement this actor just made.
  const door = await putBackRetiredIssue({
    documentId: sourceDocId, status: priorStatus, door: "lifecycle_rollback",
    reason: "A split or merge that retired this document did not complete; its rollback put the document back.",
    supersession: prior, forceHold: true,
    ...(priorStatus === null ? { olderBodyStatus: "Issued" } : {}),
  });
  if (door.kind === "refused") {
    throw new Error(`source ${sourceDocId} is still Superseded — restore it to ${describePutBackStatus(priorStatus)} (${door.reason})`);
  }
  const putBackAs = door.kind === "landed" ? door.putBackAs : undefined;
  if (door.kind === "absent") {
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
      throw new Error(`source ${sourceDocId} is still Superseded — restore it to ${describePutBackStatus(priorStatus)} (${restoreErr?.message ?? "the write was refused"})`);
    }
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
  return putBackAs;
}

export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** REV-15: start the compliance clocks of the documents a split / merge just
 *  ISSUED — startIssuedDocumentClocks, the one call createDocumentWithFile
 *  makes for an issued first revision. The CALLER runs it only after its
 *  saga has committed (the acknowledgment roster notifies people, so it is
 *  never opened for a sheet a rollback would archive) — which is why
 *  createNewDocWithFirstVersion, inside the saga, does not. Neither outcome
 *  rolls the operation back (it is irreversible by then); each is one
 *  warning per document, logged and returned for the caller's result
 *  (`complianceClockWarnings`): a start that THREW (the review certification
 *  event could not be written), or the write errors the helper REPORTS (the
 *  review-basis reset, the next review date, each acknowledgment roster write,
 *  a roster recompute that stopped on an error). A write the database
 *  filtered to zero rows answers no error and is not reported. The split /
 *  merge creation events (CREATED_FROM_SPLIT / CREATED_FROM_MERGE) are written
 *  inside the saga, before this runs, so they do not carry it.
 *
 *  REV-15 (P13): a sheet whose clocks did not (fully) start records WHY on a
 *  persisted event — a follow-up COMPLIANCE_CLOCKS_NOT_STARTED audit row on
 *  the document, written right after the clock start, naming the creation
 *  event it follows (`creation.event`) and the operation (`creation.details`,
 *  e.g. the split / merge source). The saga's order is untouched: the
 *  creation event is still written inside it, and the clocks still start
 *  only after it committed. A follow-up row that could not be written is
 *  said in the document's warning (never silent). */
export async function startClocksForIssuedDocuments(
  documentIds: string[],
  actor: ActorContext,
  creation?: { event: "CREATED_FROM_SPLIT" | "CREATED_FROM_MERGE"; details?: Record<string, unknown> },
  /** notifications N17 (the integrator's rule R2, DEC-90): `notifyPush:
   *  false` from a door that opens rosters for many documents in one action
   *  (the split) — bell rows and emails unchanged, no push. The merge's one
   *  created target omits it. */
  opts?: { notifyPush?: boolean },
): Promise<string[]> {
  const warnings: string[] = [];
  for (const documentId of documentIds) {
    let msg: string | null = null;
    let problems: string[] = [];
    let threw = false;
    try {
      const writeErrors = await startIssuedDocumentClocks({ orgId: actor.orgId, documentId, actorUserId: actor.actorUserId, actorName: actor.actorEmail ?? null, ...(opts?.notifyPush === false ? { notifyPush: false } : {}) });
      if (writeErrors.length > 0) {
        problems = writeErrors;
        msg = `The review clock / acknowledgment roster of document ${documentId} did not fully start (${writeErrors.join("; ")}); Document Control can set it from the document.`;
      }
    } catch (e) {
      threw = true;
      problems = [`the start failed (${(e as Error).message})`];
      msg = `The review clock / acknowledgment roster of document ${documentId} did not start (${(e as Error).message}); Document Control can set it from the document.`;
    }
    if (!msg) continue;
    if (creation) {
      const { error: recordErr } = await logAuditAction({
        action: "COMPLIANCE_CLOCKS_NOT_STARTED",
        resourceId: documentId,
        resourceType: "document",
        orgId: actor.orgId,
        userId: actor.actorUserId,
        userEmail: actor.actorEmail,
        userRole: actor.actorRole,
        details: {
          followsUp: creation.event,
          ...(creation.details ?? {}),
          complianceClockErrors: problems,
          startThrew: threw,
        },
      });
      if (recordErr) msg += ` (The record of this on the document could not be written either: ${recordErr}.)`;
    }
    console.warn(`[documentLifecycle] ${msg}`);
    warnings.push(msg);
  }
  return warnings;
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
  /** REV-12: the status the source held, read fresh — REV-29 (P25): a NULL
   *  one kept as NULL (recorded so, and put back so), never "Issued". */
  priorStatus: string | null;
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
 *  refuses its draft (REV-5) and the share routes refuse its status (P1).
 *
 *  REV-36 (document-control P36, 20261253): when Document Control chose to
 *  proceed over the source's active hold (`forceHold` — the split / merge's
 *  HLD-2 `force`), the flip goes through lib/revisions.ts retireOverHold —
 *  the same write, recorded as REV_HOLD_OVERRIDDEN in its transaction, which
 *  the publish guard now requires for a controller's entry into Superseded
 *  over a hold — and the direct write only while the function is absent
 *  (today's path). Without `forceHold` the flip is the direct write, as
 *  before. P36 review fix: a flip that function RECORDED (a pass over the
 *  hold) is corrected on the record — REV_HOLD_OVERRIDE_UNDONE — when the
 *  saga then puts the source back (correctRetiredOverHold, registered before
 *  the restore so it runs after it). */
export async function markSupersededAndLink(input: {
  sourceDocId: string;
  replacementDocIds: string[];
  reason: string;
  mocReference?: string;
  actor: ActorContext;
  /** REV-36 (P36): the door ("split" / "merge") when Document Control chose
   *  to proceed over the source's active hold (its HLD-2 `force`). */
  forceHold?: "split" | "merge";
  /** The caller's compensation register (withCompensation). */
  register: (c: Compensation) => void;
  /** P36 review fix: the caller's saga's rollback cause (withCompensation's
   *  second argument), for the correction of a recorded pass it undoes. */
  rollback?: RollbackCause;
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
  // REV-29 (P25): what the source WAS — a NULL status kept as NULL, so the
  // rollback puts it back as that and the DOC_SPLIT / DOC_MERGED event
  // records it, and a reversal restores it (never "Issued", which put a
  // document that had no status in force, unreviewed).
  const priorStatus: string | null = prior.status ?? null;

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

  // P36 review fix: a flip retire_over_hold recorded as a pass over a hold is
  // corrected on the record if the saga then puts the source back —
  // registered BEFORE the restore, so the LIFO rollback runs it after it.
  const recordedPass: { recorded: boolean | "unknown" } = { recorded: false };
  if (input.forceHold) {
    register(correctRetiredOverHold({ documentId: sourceDocId, via: input.forceHold, label, pass: recordedPass, actor, rollback: input.rollback, thisCall: { reason: reason.trim(), at: now } }));
  }
  let flipped = false;
  // REV-37 (P37): the recorded flip's answer was lost and could not be read
  // back — the rollback re-reads before it puts anything back.
  let flipUnconfirmed = false;
  register({
    describe: `restore ${label} from Superseded`,
    run: async () => {
      if (!flipped && flipUnconfirmed) {
        const { data: again, error: againErr } = await supabase
          .from("documents").select("status, superseded_at").eq("id", sourceDocId).maybeSingle();
        if (againErr) throw new Error(`whether ${label}'s supersession landed could not be confirmed (${againErr.message}) — check its status`);
        if (!showsSupersessionAt(again as { status?: string | null; superseded_at?: string | null } | null, now)) return; // it never landed
        flipped = true;
      }
      if (!flipped) return; // the flip never landed — nothing to put back
      const putBackAs = await restoreSupersededSource(sourceDocId, priorStatus, addedPairs, actor, {
        superseded_at: prior.superseded_at, superseded_by_user: prior.superseded_by_user,
        supersession_reason: prior.supersession_reason, supersession_moc: prior.supersession_moc,
      });
      // REV-29 (P25 review fix): landed, but as the older body's status —
      // said in the saga's rollback note, never silently.
      if (putBackAs !== undefined) {
        return `${label} was put back as ${putBackAs}, not as ${describePutBackStatus(priorStatus)} — this database's put_back_retired_issue predates 20261192 and cannot put back no status.`;
      }
    },
  });

  // REV-36 (P36): over a hold Document Control chose to proceed over, the
  // recorded door; absent (before 20261253), the direct write below.
  const door = input.forceHold
    ? await retireOverHold({ documentId: sourceDocId, door: input.forceHold, reason: reason.trim(), at: now, supersessionMoc: mocReference?.trim() || null })
    : null;
  if (door?.kind === "refused") {
    if (door.unconfirmed) { flipUnconfirmed = true; recordedPass.recorded = "unknown"; }
    throw new Error(door.noRow ? "The source document was NOT superseded — you don't have authority to retire it." : door.reason);
  }
  if (door?.kind === "landed") recordedPass.recorded = door.recorded;
  if (door?.kind !== "landed") {
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
      liveShareLinksLeft: shares.liveLeft,
      shareRevokeAuditError: shares.auditError,
    },
  });
}

/** Copy any ACTIVE holds from the source document onto the target,
 *  with a note describing the carry-over. Skips a hold that is already
 *  open on the target, keyed the way the partial UNIQUE index keys it
 *  (`openHoldKey`, 20261152): the reason — and for an "Other" hold its
 *  note, so two different custom holds (both "Other" since VFY-6) are both
 *  carried, never the second dropped. Each carried "Other" note names its
 *  source ("Carried over from <label>. …"), so holds from two sources never
 *  share a key. Before 20261152 is pasted the old (document, reason) index
 *  refuses a second open "Other" hold: the carry THROWS (below) and the
 *  operation rolls back — fails closed, never a dropped hold.
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

  // The holds already open on the target, by the unique index's key
  // (openHoldKey — VFY-6: an "Other" hold by its note too), so a hold that
  // is already there is not inserted twice.
  const { data: existing, error: existingErr } = await supabase
    .from("document_holds")
    .select("reason, notes")
    .eq("document_id", targetDocId)
    .is("released_at", null);
  if (existingErr) throw new Error(`Couldn't read the new document's holds (${existingErr.message}) — the source's holds were not carried over.`);
  const openKeys = new Set(
    ((existing as Array<{ reason: string; notes: string | null }>) ?? []).map((r) => openHoldKey(r))
  );

  let copied = 0;
  const holdIds: string[] = [];
  try {
    for (const h of rows) {
      const note = `Carried over from ${originLabel}.${h.notes ? ` Original notes: ${h.notes}` : ""}`;
      const key = openHoldKey({ reason: h.reason, notes: note });
      if (openKeys.has(key)) continue;
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
        // VFY-6: before 20261152 a document holds one open "Other" hold at a
        // time — said so, and the operation rolls back (nothing dropped).
        if (error?.code === "23505" && h.reason === OTHER_HOLD_REASON) {
          throw new Error(`The "${holdReasonLabel(h)}" hold could not be carried over to the new document: it already has an open "${OTHER_HOLD_REASON}" hold, and until database update 20261152 is applied a document holds one at a time. Apply 20261152 (a prerequisite of this version) and try again.`);
        }
        throw new Error(`The "${holdReasonLabel(h)}" hold could not be carried over to the new document (${error?.message ?? "the write was refused"}).`);
      }
      openKeys.add(key);
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
