// lib/documentLifecycle/renumber.ts
//
// Change documents.document_number with a full audit trail.
// Existing revisions and history are preserved; only the
// document_number field is modified.
//
// OWN-19: renumbering a controlled document is a lifecycle act of the same
// shape as split / merge / supersede, and the Inspector offers it behind
// publish authority — so the mutator takes the same authority (per-library
// control or effective ownership of this document, the population
// authorizePublish and backfillVersion use). The database gates
// document_number on membership only; this check is the mutator-side rail,
// the same posture OWN-17 recorded for backfillVersion.

import { supabase } from "@/lib/supabase";
import { logRevisionEvent } from "@/lib/audit";
import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";
import { resolveActorPrincipal } from "@/lib/principal";
import { resolveCanControlLibrary } from "@/lib/documentGuards";
import { knownInactive, NOT_ACTIVE_MEMBER_MESSAGE } from "@/lib/permissions";
import { isEffectiveOwnerOfDocument } from "@/lib/ownership";
import { assertNotOnHold } from "@/lib/holdGate";
import type { DocumentRecord } from "@/types/schema";
import { requestUnitCodeDecode } from "@/lib/unitCodeClient";

export interface RenumberInput {
  doc: DocumentRecord;
  newDocumentNumber: string;
  reason: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

/** GAP-314: `unitCodeNote` says when the renumbered document's unit decode
 *  did not run (the renumber stands; 20261138 dropped the old decode, and the
 *  next unit-identity run places it); null when it ran. */
export async function renumberDocument(input: RenumberInput): Promise<{ unitCodeNote: string | null }> {
  const { doc, newDocumentNumber, reason, orgId, actorUserId, actorEmail, actorRole } = input;
  if (!doc.id) throw new Error("Document is missing an id.");
  if (!newDocumentNumber.trim()) throw new Error("New document number is required.");
  if (!reason.trim()) throw new Error("Reason is required.");
  const oldNumber = doc.documentNumber ?? null;

  const principal = await resolveActorPrincipal({ uid: actorUserId, orgId, headlineRole: actorRole });
  let authorized = await resolveCanControlLibrary(doc.libraryId, principal);
  // ORG-23: the owner rung is a member's (lib/permissions knownInactive).
  if (!authorized && !knownInactive(principal)) authorized = await isEffectiveOwnerOfDocument(doc.id, actorUserId);
  if (!authorized) {
    throw new Error(knownInactive(principal) ? NOT_ACTIVE_MEMBER_MESSAGE : "You don't have authority to renumber this document. Ask an Admin or Doc Control to grant publish authority on this library.");
  }
  // HLD-1: a held document keeps the number its hold cards were printed
  // with until the hold is released (the shared gate; fails closed).
  await assertNotOnHold(doc.id, { action: "renumbering it" });

  const now = new Date().toISOString();

  // SAF-18 class (a): a renumber that matched no row did not happen — no
  // DOC_RENUMBERED row claims it, and the modal says so.
  const { data: renumbered, error } = await supabase
    .from("documents")
    .update({
      document_number: newDocumentNumber.trim(),
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id)
    .select("id");
  if (error) throw new Error(error.message);
  if (!renumbered || renumbered.length === 0) throw new Error(`The document was not renumbered. ${CHECKED_WRITE_REFUSED}`);

  await logRevisionEvent({
    orgId, documentId: doc.id, versionId: "",
    userId: actorUserId, userEmail: actorEmail ?? "", userRole: actorRole ?? "",
    type: "DOC_RENUMBERED",
    details: {
      previousDocumentNumber: oldNumber,
      newDocumentNumber: newDocumentNumber.trim(),
      reason: reason.trim(),
    },
  });

  // GAP-314: 20261138's guard dropped the old decode with the number; decode
  // the new one now (server-side, from the stored number) — best-effort.
  const unitCode = await requestUnitCodeDecode(orgId, [doc.id], "renumber");
  if (unitCode.note) console.warn(`[renumberDocument] ${unitCode.note}`);
  return { unitCodeNote: unitCode.note };
}
