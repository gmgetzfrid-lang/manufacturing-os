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
import { resolveActorPrincipal } from "@/lib/principal";
import { resolveCanControlLibrary } from "@/lib/documentGuards";
import { isEffectiveOwnerOfDocument } from "@/lib/ownership";
import type { DocumentRecord } from "@/types/schema";

export interface RenumberInput {
  doc: DocumentRecord;
  newDocumentNumber: string;
  reason: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
}

export async function renumberDocument(input: RenumberInput): Promise<void> {
  const { doc, newDocumentNumber, reason, orgId, actorUserId, actorEmail, actorRole } = input;
  if (!doc.id) throw new Error("Document is missing an id.");
  if (!newDocumentNumber.trim()) throw new Error("New document number is required.");
  if (!reason.trim()) throw new Error("Reason is required.");
  const oldNumber = doc.documentNumber ?? null;

  const principal = await resolveActorPrincipal({ uid: actorUserId, orgId, headlineRole: actorRole });
  let authorized = await resolveCanControlLibrary(doc.libraryId, principal);
  if (!authorized) authorized = await isEffectiveOwnerOfDocument(doc.id, actorUserId);
  if (!authorized) {
    throw new Error("You don't have authority to renumber this document. Ask an Admin or Doc Control to grant publish authority on this library.");
  }

  const now = new Date().toISOString();

  const { error } = await supabase
    .from("documents")
    .update({
      document_number: newDocumentNumber.trim(),
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id);
  if (error) throw new Error(error.message);

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
}
