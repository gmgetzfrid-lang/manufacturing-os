// lib/documentLifecycle/reverse.ts
//
// Selective undo for the lifecycle operations.
//
// Lifecycle operations are reversed via "compensating actions"
// rather than hard deletes — this preserves audit immutability,
// which the directive requires and which any PSM-style audit
// reconstruction depends on.
//
// Each reverse* function reads the original audit_logs row by id,
// extracts the doc IDs it touched, and performs the inverse:
//
//   reverseSplit(splitAuditId)
//     → mark each new doc Superseded with reason "reverted_split"
//     → un-supersede the source doc (status back to Issued)
//     → write DOC_SPLIT_REVERSED audit event
//
//   reverseMerge(mergeAuditId)
//     → un-supersede every source doc
//     → mark the merge target Superseded if it was newly created
//       by the merge (leave alone if it was an extended existing doc)
//     → write DOC_MERGE_REVERSED
//
//   reverseRenumber(renumberAuditId)
//     → set documents.document_number back to the previous value
//       (carried in the original audit's details)
//     → write DOC_RENUMBER_REVERSED
//
// We deliberately scope reversal to a single audit event so that
// "undo" can't accidentally unwind unrelated operations the user
// did in the same session.

import { supabase } from "@/lib/supabase";
import { logRevisionEvent } from "@/lib/audit";

export interface ReverseResult {
  reversedDocIds: string[];
  preservedAsSuperseded: number;
  warnings: string[];
}

// ─── Shared internals ───────────────────────────────────────────

async function loadAuditEvent(auditId: string): Promise<{
  id: string; action: string; resource_id: string; details: Record<string, unknown> | null;
} | null> {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, action, resource_id, details")
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { id: string; action: string; resource_id: string; details: Record<string, unknown> | null } | null) ?? null;
}

/** Best-effort check for "stuff happened on these new docs after
 *  the original op." Doesn't block the reversal — it surfaces
 *  warnings the UI can show in the confirmation. */
async function summarizeDerivativeWork(docIds: string[], sinceIso: string): Promise<string[]> {
  if (docIds.length === 0) return [];
  const warnings: string[] = [];
  const { data: events } = await supabase
    .from("audit_logs")
    .select("action, resource_id, timestamp")
    .in("resource_id", docIds)
    .gt("timestamp", sinceIso)
    .order("timestamp", { ascending: false })
    .limit(200);
  const rows = (events as Array<{ action: string; resource_id: string; timestamp: string }>) ?? [];
  if (rows.length === 0) return [];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.action] = (counts[r.action] ?? 0) + 1;
  const interesting = ["CHECK_OUT", "REV_UP", "DOWNLOAD", "HOLD_OPENED"];
  for (const a of interesting) {
    if (counts[a]) warnings.push(`${counts[a]} ${a.replace("_", " ").toLowerCase()} event${counts[a] === 1 ? "" : "s"} happened on the new docs since the split.`);
  }
  return warnings;
}

// ─── reverseSplit ───────────────────────────────────────────────

interface ReverseSplitInput {
  splitAuditEventId: string;
  reason: string;                // why the user is reversing
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

export async function reverseSplit(input: ReverseSplitInput): Promise<ReverseResult> {
  const ev = await loadAuditEvent(input.splitAuditEventId);
  if (!ev || ev.action !== "DOC_SPLIT") throw new Error("Audit event is not a DOC_SPLIT.");
  const sourceDocId = ev.resource_id;
  const replacementIds = (ev.details?.replacementDocIds as string[] | undefined) ?? [];
  if (replacementIds.length === 0) throw new Error("Split event has no replacement doc ids — cannot reverse precisely.");

  // Surface what'll get parked under Superseded.
  const auditAt = (ev.details?.auditAt as string) ?? "1970-01-01T00:00:00Z";
  const warnings = await summarizeDerivativeWork(replacementIds, auditAt);

  const now = new Date().toISOString();
  let parked = 0;
  for (const newId of replacementIds) {
    const { error } = await supabase.from("documents").update({
      status: "Superseded",
      superseded_at: now,
      superseded_by_user: input.actorUserId,
      supersession_reason: `Reverted split — ${input.reason}`,
      updated_at: now,
      updated_by: input.actorUserId,
    }).eq("id", newId);
    if (!error) parked++;
  }

  // Un-supersede the source. Restore status to 'Issued' as the
  // safest default — the source's history says where it was before.
  await supabase.from("documents").update({
    status: "Issued",
    superseded_at: null,
    superseded_by_user: null,
    supersession_reason: null,
    supersession_moc: null,
    updated_at: now,
    updated_by: input.actorUserId,
  }).eq("id", sourceDocId);

  // Hard-delete the join rows; the audit log retains the relationship
  // so history is still reconstructable.
  await supabase
    .from("document_supersessions")
    .delete()
    .eq("superseded_doc_id", sourceDocId)
    .in("replacement_doc_id", replacementIds);

  await logRevisionEvent({
    orgId: input.orgId,
    documentId: sourceDocId,
    versionId: "",
    userId: input.actorUserId,
    userEmail: input.actorEmail ?? "",
    userRole: input.actorRole ?? "",
    type: "DOC_SPLIT_REVERSED",
    details: {
      reversedAuditEventId: input.splitAuditEventId,
      reversedNewDocIds: replacementIds,
      reason: input.reason.trim(),
      derivativeWorkWarnings: warnings,
    },
  });

  return { reversedDocIds: replacementIds, preservedAsSuperseded: parked, warnings };
}

// ─── reverseMerge ──────────────────────────────────────────────

interface ReverseMergeInput {
  mergeAuditEventId: string;       // the DOC_MERGED event on ONE of the source docs (we'll find siblings)
  reason: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

export async function reverseMerge(input: ReverseMergeInput): Promise<ReverseResult> {
  const ev = await loadAuditEvent(input.mergeAuditEventId);
  if (!ev || ev.action !== "DOC_MERGED") throw new Error("Audit event is not a DOC_MERGED.");
  const sourceDocId = ev.resource_id;
  const targetDocId = ev.details?.mergedIntoDocumentId as string | undefined;
  const allSourceIds = ((ev.details?.mergeSiblings as string[] | undefined) ?? [sourceDocId]).filter(Boolean);
  if (!targetDocId) throw new Error("Merge event has no mergedIntoDocumentId — cannot reverse precisely.");

  // Was the target newly created? Prefer the explicit flag recorded on the
  // DOC_MERGED event itself (merges after this fix carry it). Only fall back
  // to the legacy note-string heuristic for older events that predate the
  // flag — and even then, default to the SAFE branch (treat as extended /
  // leave active) when we genuinely can't tell, so we never silently park a
  // drafter's live working document.
  let targetWasNewlyCreated: boolean;
  let inferredFromLegacyHeuristic = false;
  if (typeof ev.details?.targetWasNewlyCreated === "boolean") {
    targetWasNewlyCreated = ev.details.targetWasNewlyCreated as boolean;
  } else {
    const { data: targetCreate } = await supabase
      .from("audit_logs")
      .select("details")
      .eq("resource_id", targetDocId)
      .eq("action", "CREATED_FROM_MERGE")
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();
    const targetCreateDetails = (targetCreate as { details: Record<string, unknown> | null } | null)?.details ?? null;
    if (!targetCreateDetails) {
      // No creation record at all — cannot prove the target was new.
      // Choose the non-destructive branch.
      targetWasNewlyCreated = false;
      inferredFromLegacyHeuristic = true;
    } else {
      targetWasNewlyCreated = targetCreateDetails.note !== "Existing document extended via merge";
      inferredFromLegacyHeuristic = true;
    }
  }

  const auditAt = (ev.details?.auditAt as string) ?? "1970-01-01T00:00:00Z";
  const warnings = await summarizeDerivativeWork([targetDocId], auditAt);

  const now = new Date().toISOString();
  let parked = 0;

  // Un-supersede every source.
  for (const sId of allSourceIds) {
    const { error } = await supabase.from("documents").update({
      status: "Issued",
      superseded_at: null,
      superseded_by_user: null,
      supersession_reason: null,
      supersession_moc: null,
      updated_at: now,
      updated_by: input.actorUserId,
    }).eq("id", sId);
    if (error) throw new Error(error.message);
  }

  // Delete the supersession join rows for this merge.
  await supabase
    .from("document_supersessions")
    .delete()
    .in("superseded_doc_id", allSourceIds)
    .eq("replacement_doc_id", targetDocId);

  // Park the target if newly created.
  if (targetWasNewlyCreated) {
    const { error } = await supabase.from("documents").update({
      status: "Superseded",
      superseded_at: now,
      superseded_by_user: input.actorUserId,
      supersession_reason: `Reverted merge — ${input.reason}`,
      updated_at: now,
      updated_by: input.actorUserId,
    }).eq("id", targetDocId);
    if (!error) parked = 1;
    if (inferredFromLegacyHeuristic) {
      warnings.unshift("This merge predates explicit intent tracking — whether the target was newly created was inferred. It has been parked as Superseded; verify this was the merge-created document and not a pre-existing one before relying on the reversal.");
    }
  } else {
    warnings.unshift("Target was an existing document extended by the merge — it stays active. Its rev-up (if any) is NOT reverted by this action; use Revert on its version history if needed.");
  }

  await logRevisionEvent({
    orgId: input.orgId,
    documentId: sourceDocId,
    versionId: "",
    userId: input.actorUserId,
    userEmail: input.actorEmail ?? "",
    userRole: input.actorRole ?? "",
    type: "DOC_MERGE_REVERSED",
    details: {
      reversedAuditEventId: input.mergeAuditEventId,
      reversedSourceDocIds: allSourceIds,
      targetDocId,
      targetWasNewlyCreated,
      targetIntentSource: inferredFromLegacyHeuristic ? "inferred" : "explicit",
      reason: input.reason.trim(),
      derivativeWorkWarnings: warnings,
    },
  });

  return { reversedDocIds: [...allSourceIds, targetDocId], preservedAsSuperseded: parked, warnings };
}

// ─── reverseRenumber ───────────────────────────────────────────

interface ReverseRenumberInput {
  renumberAuditEventId: string;
  reason: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

export async function reverseRenumber(input: ReverseRenumberInput): Promise<ReverseResult> {
  const ev = await loadAuditEvent(input.renumberAuditEventId);
  if (!ev || ev.action !== "DOC_RENUMBERED") throw new Error("Audit event is not a DOC_RENUMBERED.");
  const docId = ev.resource_id;
  const previous = (ev.details?.previousDocumentNumber as string | null) ?? null;
  const current  = (ev.details?.newDocumentNumber as string | null) ?? null;
  if (!previous) throw new Error("Renumber event has no previousDocumentNumber — cannot reverse.");

  // Make sure the doc still has the renumbered value before we swap
  // it back, otherwise something else changed it in between and we
  // shouldn't blindly overwrite.
  const { data: cur } = await supabase
    .from("documents")
    .select("document_number, library_id")
    .eq("id", docId)
    .maybeSingle();
  const curRow = cur as { document_number: string | null; library_id: string | null } | null;
  const live = curRow?.document_number ?? null;
  const libraryId = curRow?.library_id ?? null;
  const warnings: string[] = [];
  if (current && live !== current) {
    warnings.push(`Document number is now "${live}", not the "${current}" that this renumber set. Another change happened since. Reverse only if you're sure.`);
  }

  // Re-check uniqueness BEFORE swapping. The original number may have been
  // reused by another active doc since the renumber. The DB partial unique
  // index excludes Archived/Superseded, so we mirror that here and surface
  // an actionable error rather than letting the UPDATE die on a 23505.
  if (libraryId) {
    const { data: conflicts } = await supabase
      .from("documents")
      .select("id, status, title")
      .eq("library_id", libraryId)
      .eq("document_number", previous)
      .neq("id", docId)
      .not("status", "in", '("Archived","Superseded")')
      .limit(1);
    const clash = (conflicts as Array<{ id: string; status: string; title: string | null }> | null)?.[0];
    if (clash) {
      throw new Error(
        `Cannot restore document number "${previous}" — it's already in use by another active document ("${clash.title ?? clash.id}") in this library. ` +
        `Renumber or retire that document first, then reverse this renumber.`,
      );
    }
  }

  const now = new Date().toISOString();
  const { error: swapErr } = await supabase.from("documents").update({
    document_number: previous,
    updated_at: now,
    updated_by: input.actorUserId,
  }).eq("id", docId);
  if (swapErr) {
    // Last-resort guard if a concurrent write slipped in between the check
    // and the swap.
    throw new Error(
      `Couldn't restore document number "${previous}": ${swapErr.message}. ` +
      `It may have just been taken by another document.`,
    );
  }

  await logRevisionEvent({
    orgId: input.orgId,
    documentId: docId,
    versionId: "",
    userId: input.actorUserId,
    userEmail: input.actorEmail ?? "",
    userRole: input.actorRole ?? "",
    type: "DOC_RENUMBER_REVERSED",
    details: {
      reversedAuditEventId: input.renumberAuditEventId,
      restoredToDocumentNumber: previous,
      wasAtDocumentNumber: live,
      reason: input.reason.trim(),
      warnings,
    },
  });

  return { reversedDocIds: [docId], preservedAsSuperseded: 0, warnings };
}
