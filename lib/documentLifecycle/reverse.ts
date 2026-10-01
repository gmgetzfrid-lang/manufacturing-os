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
//       (its in-flight review draft voided, its share links revoked)
//     → un-supersede the source doc, back to the status it HELD before the
//       split (REV-12: recorded on the DOC_SPLIT event as priorStatus)
//     → write DOC_SPLIT_REVERSED audit event
//
//   reverseMerge(mergeAuditId)
//     → mark the merge target Superseded FIRST if it was newly created
//       by the merge (leave alone if it was an extended existing doc)
//     → un-supersede every source doc, each to the status it held
//       (DOC_MERGED carries priorStatuses for all siblings)
//     → write DOC_MERGE_REVERSED
//
//   A split or merge recorded before Round F carries no prior status: the
//   reversal REFUSES rather than guess one (it used to write 'Issued', which
//   resurrected Void and Draft sources as controlled copies) unless the caller
//   names the status explicitly. Reversal rewrites the supersession record,
//   whose rows only Document Control / Admin may delete (20261131) — so it is
//   their act, checked here before anything moves.
//
//   reverseRenumber(renumberAuditId)
//     → the SAME gate as renumberDocument (OWN-19 authority, HLD-1 hold) —
//       an undo is a renumber, not a way round its rules
//     → set documents.document_number back to the previous value
//       (carried in the original audit's details), checked for the row
//     → write DOC_RENUMBER_REVERSED
//
// We deliberately scope reversal to a single audit event so that
// "undo" can't accidentally unwind unrelated operations the user
// did in the same session.

import { supabase } from "@/lib/supabase";
import { logRevisionEvent } from "@/lib/audit";
import { resolveActorPrincipal } from "@/lib/principal";
import { isControllerPrincipal } from "@/lib/permissions";
import { resolveCanControlLibrary } from "@/lib/documentGuards";
import { isEffectiveOwnerOfDocument } from "@/lib/ownership";
import { assertNotOnHold } from "@/lib/holdGate";
import { voidPendingDraftAfterPublish, revokeLiveSharesForDocument } from "@/lib/revisions";

export interface ReverseResult {
  reversedDocIds: string[];
  preservedAsSuperseded: number;
  warnings: string[];
}

// ─── Shared internals ───────────────────────────────────────────

type AuditEventRow = {
  id: string; action: string; resource_id: string; details: Record<string, unknown> | null; timestamp?: string | null;
};

async function loadAuditEvent(auditId: string): Promise<AuditEventRow | null> {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, action, resource_id, details, timestamp")
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AuditEventRow | null) ?? null;
}

/** REV-12: the instant the reversed operation happened — the auditAt the
 *  forward operation now records, else the audit row's own timestamp. Never
 *  the epoch: a warning counted from 1970 counts the operation itself. */
export function operationInstant(ev: Pick<AuditEventRow, "details" | "timestamp">): string {
  const at = ev.details?.auditAt;
  if (typeof at === "string" && at) return at;
  if (ev.timestamp) return ev.timestamp;
  throw new Error("The operation's time is not recorded — cannot tell what happened after it.");
}

/** Statuses a caller may name for a legacy (pre-Round-F) reversal whose
 *  prior status was never recorded. */
export const LEGACY_RESTORE_STATUSES = ["Issued", "Draft", "In Review", "Void"] as const;

export class PriorStatusUnknownError extends Error {
  constructor(label: string) {
    super(
      `This operation was recorded before prior statuses were captured, so the reversal can't prove what status ${label} held — ` +
      "it will not guess (restoring Issued would make a withdrawn or draft document a controlled copy again). " +
      "Document Control can restore it with an explicit status.",
    );
    this.name = "PriorStatusUnknownError";
  }
}

/** REV-16: does reversing this event need the caller to NAME the status to
 *  restore? True for a split / merge recorded before prior statuses were
 *  captured (no `priorStatus` on a DOC_SPLIT; a DOC_MERGED whose
 *  `priorStatuses` does not cover every sibling). Pure — the reverse dialog
 *  asks it to decide whether to show its status picker; the reversal itself
 *  still prefers whatever IS recorded. */
export function reversalNeedsLegacyStatus(action: string, details: Record<string, unknown> | null | undefined): boolean {
  const d = details ?? {};
  const has = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (action === "DOC_SPLIT") return !has(d.priorStatus);
  if (action === "DOC_MERGED") {
    const recorded = (d.priorStatuses && typeof d.priorStatuses === "object" ? d.priorStatuses : {}) as Record<string, unknown>;
    const siblings = ((d.mergeSiblings as string[] | undefined) ?? []).filter(Boolean);
    if (siblings.length === 0) return !has(d.priorStatus);
    return !siblings.every((id) => has(recorded[id]));
  }
  return false;
}

/** REV-12: the status to restore — recorded on the event, else the caller's
 *  explicit (validated) choice for a legacy event, else refuse. */
function statusToRestore(recorded: unknown, explicit: string | undefined, label: string): string {
  if (typeof recorded === "string" && recorded.trim()) return recorded;
  if (explicit) {
    if (!(LEGACY_RESTORE_STATUSES as readonly string[]).includes(explicit)) {
      throw new Error(`Cannot restore to "${explicit}" — choose ${LEGACY_RESTORE_STATUSES.join(", ")}.`);
    }
    return explicit;
  }
  throw new PriorStatusUnknownError(label);
}

/** Reversal is a Document Control / Admin act (it deletes supersession rows,
 *  which the database reserves to them — 20261131). */
async function assertReversalAuthority(orgId: string, actorUserId: string, actorRole?: string): Promise<void> {
  const principal = await resolveActorPrincipal({ uid: actorUserId, orgId, headlineRole: actorRole });
  if (!isControllerPrincipal(principal)) {
    throw new Error("Reversing a split or merge rewrites the supersession record — ask Document Control or an Admin.");
  }
}

/** Park a document a reversal retires: mark it Superseded (checked), THEN
 *  void its in-flight review draft (REV-6) and revoke its share links
 *  (REV-10). The two irreversible steps run only once the park itself has
 *  landed — a refused park changes nothing and destroys no signature — and
 *  never throw: a failure is returned for the reversal's record (finalize
 *  refuses a retired document, REV-5; the share routes refuse its status). */
async function parkAsSuperseded(docId: string, supersessionReason: string, actorUserId: string, now: string): Promise<{ revokedShareLinks: number; shareRevokeError: string | null; voidedDraft: string | null; voidProblem: string | null }> {
  const { data, error } = await supabase.from("documents").update({
    status: "Superseded",
    superseded_at: now,
    superseded_by_user: actorUserId,
    supersession_reason: supersessionReason,
    updated_at: now,
    updated_by: actorUserId,
  }).eq("id", docId).select("id");
  if (error || ((data as unknown[] | null) ?? []).length === 0) {
    throw new Error(`Reversal stopped: ${docId} could not be parked as Superseded (${error?.message ?? "the write was refused"}).`);
  }
  const draftVoid = await voidPendingDraftAfterPublish(docId, actorUserId);
  const shares = await revokeLiveSharesForDocument(docId, actorUserId);
  return { revokedShareLinks: shares.revoked, shareRevokeError: shares.error, voidedDraft: draftVoid.voidedVersionId, voidProblem: draftVoid.problem };
}

/** Un-supersede one document to the status it held (checked). */
async function restoreStatus(docId: string, status: string, actorUserId: string, now: string): Promise<void> {
  const { data, error } = await supabase.from("documents").update({
    status,
    superseded_at: null,
    superseded_by_user: null,
    supersession_reason: null,
    supersession_moc: null,
    updated_at: now,
    updated_by: actorUserId,
  }).eq("id", docId).select("id");
  if (error || ((data as unknown[] | null) ?? []).length === 0) {
    throw new Error(`Reversal stopped: ${docId} could not be restored to ${status} (${error?.message ?? "the write was refused"}).`);
  }
}

/** Delete this operation's supersession rows (checked — a row left behind
 *  would keep asserting a replacement the reversal undid; a removal whose
 *  read-back fails is UNCONFIRMED, never reported clean). */
async function deleteLineage(filter: { supersededIds: string[]; replacementIds: string[] }): Promise<void> {
  const { error } = await supabase
    .from("document_supersessions")
    .delete()
    .in("superseded_doc_id", filter.supersededIds)
    .in("replacement_doc_id", filter.replacementIds);
  const { data: left, error: leftErr } = await supabase
    .from("document_supersessions").select("id")
    .in("superseded_doc_id", filter.supersededIds)
    .in("replacement_doc_id", filter.replacementIds);
  if (leftErr) {
    throw new Error(`The documents were restored, but whether this operation's supersession links were removed could not be confirmed (${leftErr.message})${error ? `; the delete answered: ${error.message}` : ""} — some may remain; Document Control must check them.`);
  }
  const remaining = ((left as unknown[] | null) ?? []).length;
  if (error || remaining > 0) {
    throw new Error(`The documents were restored, but ${remaining || "the"} supersession link(s) could not be removed${error ? ` (${error.message})` : ""} — Document Control must delete them.`);
  }
}

/** Best-effort check for "stuff happened on these new docs after
 *  the original op." Doesn't block the reversal — it surfaces
 *  warnings the UI can show in the confirmation. REV-12: counted from the
 *  operation's own instant, so the operation's own events never count. */
async function summarizeDerivativeWork(docIds: string[], sinceIso: string, opLabel: "split" | "merge" = "split"): Promise<string[]> {
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
  const interesting = ["CHECK_OUT", "DOCUMENT_CHECKOUT", "REV_UP", "DOWNLOAD", "HOLD_OPENED"];
  for (const a of interesting) {
    if (counts[a]) warnings.push(`${counts[a]} ${a.replace("_", " ").toLowerCase()} event${counts[a] === 1 ? "" : "s"} happened on the new docs since the ${opLabel}.`);
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
  /** Only for a split recorded before prior statuses were captured: the
   *  status to restore the source to, named explicitly (REV-12). */
  legacyRestoreStatus?: string;
}

export async function reverseSplit(input: ReverseSplitInput): Promise<ReverseResult> {
  const ev = await loadAuditEvent(input.splitAuditEventId);
  if (!ev || ev.action !== "DOC_SPLIT") throw new Error("Audit event is not a DOC_SPLIT.");
  const sourceDocId = ev.resource_id;
  const replacementIds = (ev.details?.replacementDocIds as string[] | undefined) ?? [];
  if (replacementIds.length === 0) throw new Error("Split event has no replacement doc ids — cannot reverse precisely.");

  await assertReversalAuthority(input.orgId, input.actorUserId, input.actorRole);
  const priorStatus = statusToRestore(ev.details?.priorStatus, input.legacyRestoreStatus, "the source");

  // Surface what'll get parked under Superseded — work done AFTER the split.
  const warnings = await summarizeDerivativeWork(replacementIds, operationInstant(ev), "split");

  const now = new Date().toISOString();
  let parked = 0;
  let revokedShareLinks = 0;
  const shareRevokeErrors: string[] = [];
  const voidedDrafts: string[] = [];
  const draftVoidProblems: string[] = [];
  for (const newId of replacementIds) {
    const r = await parkAsSuperseded(newId, `Reverted split — ${input.reason}`, input.actorUserId, now);
    parked++;
    revokedShareLinks += r.revokedShareLinks;
    if (r.shareRevokeError) shareRevokeErrors.push(r.shareRevokeError);
    if (r.voidedDraft) voidedDrafts.push(r.voidedDraft);
    if (r.voidProblem) draftVoidProblems.push(`${newId}: ${r.voidProblem}`);
  }

  // Un-supersede the source — to the status it actually held (REV-12).
  await restoreStatus(sourceDocId, priorStatus, input.actorUserId, now);

  // Delete the join rows; the audit log retains the relationship so
  // history is still reconstructable.
  await deleteLineage({ supersededIds: [sourceDocId], replacementIds });

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
      restoredStatus: priorStatus,
      restoredStatusSource: typeof ev.details?.priorStatus === "string" ? "recorded" : "explicit",
      revokedShareLinks,
      shareRevokeErrors,
      pendingDraftsVoided: voidedDrafts,
      pendingDraftVoidProblems: draftVoidProblems,
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
  /** Only for a merge recorded before prior statuses were captured (REV-12). */
  legacyRestoreStatus?: string;
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

  await assertReversalAuthority(input.orgId, input.actorUserId, input.actorRole);
  // REV-12: each sibling back to the status IT held. A post-Round-F event
  // carries all of them; a legacy event carries none (refused unless named).
  const recorded = (ev.details?.priorStatuses as Record<string, unknown> | undefined) ?? {};
  const restoreTo = new Map<string, string>();
  for (const sId of allSourceIds) {
    const own = sId === sourceDocId ? (recorded[sId] ?? ev.details?.priorStatus) : recorded[sId];
    restoreTo.set(sId, statusToRestore(own, input.legacyRestoreStatus, sId === sourceDocId ? "the source" : `merge source ${sId}`));
  }

  const warnings = await summarizeDerivativeWork([targetDocId], operationInstant(ev), "merge");

  const now = new Date().toISOString();
  let parked = 0;
  let revokedShareLinks = 0;
  let shareRevokeError: string | null = null;
  let voidedDraft: string | null = null;
  let voidProblem: string | null = null;

  // Park the target FIRST, if newly created — reverseSplit's order. Parking
  // can refuse (the checked status write); refused here, nothing has moved —
  // and nothing was voided (the draft void follows the park). Restoring the
  // sources first left them AND the merged sheet controlled at once, with
  // the lineage gone, when it refused.
  if (targetWasNewlyCreated) {
    const r = await parkAsSuperseded(targetDocId, `Reverted merge — ${input.reason}`, input.actorUserId, now);
    parked = 1;
    revokedShareLinks = r.revokedShareLinks;
    shareRevokeError = r.shareRevokeError;
    voidedDraft = r.voidedDraft;
    voidProblem = r.voidProblem;
    if (inferredFromLegacyHeuristic) {
      warnings.unshift("This merge predates explicit intent tracking — whether the target was newly created was inferred. It has been parked as Superseded; verify this was the merge-created document and not a pre-existing one before relying on the reversal.");
    }
  } else {
    warnings.unshift("Target was an existing document extended by the merge — it stays active. Its rev-up (if any) is NOT reverted by this action; use Revert on its version history if needed.");
  }

  // Then un-supersede every source.
  for (const sId of allSourceIds) {
    await restoreStatus(sId, restoreTo.get(sId)!, input.actorUserId, now);
  }

  // Then delete the supersession join rows for this merge.
  await deleteLineage({ supersededIds: allSourceIds, replacementIds: [targetDocId] });

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
      restoredStatuses: Object.fromEntries(restoreTo),
      revokedShareLinks,
      shareRevokeError,
      pendingDraftVoided: voidedDraft,
      pendingDraftVoidProblem: voidProblem,
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
  const { data: cur, error: curErr } = await supabase
    .from("documents")
    .select("document_number, library_id")
    .eq("id", docId)
    .maybeSingle();
  if (curErr || !cur) throw new Error(`Couldn't read the document (${curErr?.message ?? "not found"}) — nothing was changed.`);
  const curRow = cur as { document_number: string | null; library_id: string | null };
  const live = curRow.document_number ?? null;
  const libraryId = curRow.library_id ?? null;

  // The undo of a renumber IS a renumber: renumberDocument's own gate —
  // OWN-19 authority (per-library control, or effective ownership of this
  // document) and HLD-1 (a held document keeps the number its hold cards
  // were printed with; fails closed) — before anything is written.
  const principal = await resolveActorPrincipal({ uid: input.actorUserId, orgId: input.orgId, headlineRole: input.actorRole });
  let authorized = libraryId ? await resolveCanControlLibrary(libraryId, principal) : false;
  if (!authorized) authorized = await isEffectiveOwnerOfDocument(docId, input.actorUserId);
  if (!authorized) {
    throw new Error("You don't have authority to renumber this document, so you can't reverse its renumber either. Ask an Admin or Doc Control.");
  }
  await assertNotOnHold(docId, { action: "reversing its renumber" });
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
  const { data: swapped, error: swapErr } = await supabase.from("documents").update({
    document_number: previous,
    updated_at: now,
    updated_by: input.actorUserId,
  }).eq("id", docId).select("id");
  if (swapErr) {
    // Last-resort guard if a concurrent write slipped in between the check
    // and the swap.
    throw new Error(
      `Couldn't restore document number "${previous}": ${swapErr.message}. ` +
      `It may have just been taken by another document.`,
    );
  }
  if (((swapped as unknown[] | null) ?? []).length === 0) {
    throw new Error(`Couldn't restore document number "${previous}" — the write was refused. Nothing was changed.`);
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
