// lib/documentLifecycle/renumber.ts
//
// Change documents.document_number with a full audit trail.
// Existing revisions and history are preserved; only the
// document_number field is modified.

import { supabase } from "@/lib/supabase";
import { logRevisionEvent } from "@/lib/audit";
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
