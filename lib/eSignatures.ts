// lib/eSignatures.ts
//
// Formal e-signature capture + read. A signature is an immutable, attributable
// affirmation of intent against a resource. It also mirrors an audit event so
// the signature shows up in the resource's existing timeline.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";

export type SignatureIntent = "Approved" | "Reviewed" | "Rejected" | "Witnessed" | "Acknowledged";

export interface ESignature {
  id: string;
  orgId: string;
  resourceType: string;
  resourceId: string;
  documentVersionId?: string | null;
  contentHash?: string | null;
  intent: SignatureIntent;
  statement: string;
  signerUserId: string;
  signerName: string;
  signerRole?: string | null;
  signerEmail?: string | null;
  signedAt: string;
}

function rowTo(r: Record<string, unknown>): ESignature {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    resourceType: String(r.resource_type),
    resourceId: String(r.resource_id),
    documentVersionId: (r.document_version_id as string) ?? null,
    contentHash: (r.content_hash as string) ?? null,
    intent: r.intent as SignatureIntent,
    statement: String(r.statement),
    signerUserId: String(r.signer_user_id),
    signerName: String(r.signer_name),
    signerRole: (r.signer_role as string) ?? null,
    signerEmail: (r.signer_email as string) ?? null,
    signedAt: String(r.signed_at),
  };
}

export async function listSignatures(resourceType: string, resourceId: string): Promise<ESignature[]> {
  const { data, error } = await supabase
    .from("e_signatures")
    .select("*")
    .eq("resource_type", resourceType)
    .eq("resource_id", resourceId)
    .order("signed_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data as Array<Record<string, unknown>>) ?? []).map(rowTo);
}

export async function recordSignature(input: {
  orgId: string;
  resourceType: string;
  resourceId: string;
  documentVersionId?: string | null;
  contentHash?: string | null;
  intent: SignatureIntent;
  statement: string;
  signerUserId: string;
  signerName: string;
  signerRole?: string;
  signerEmail?: string;
}): Promise<ESignature> {
  const { data, error } = await supabase
    .from("e_signatures")
    .insert({
      org_id: input.orgId,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      document_version_id: input.documentVersionId ?? null,
      content_hash: input.contentHash ?? null,
      intent: input.intent,
      statement: input.statement,
      signer_user_id: input.signerUserId,
      signer_name: input.signerName,
      signer_role: input.signerRole ?? null,
      signer_email: input.signerEmail ?? null,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to record signature");

  // Mirror into the audit trail so it appears in the resource timeline.
  await logAuditAction({
    orgId: input.orgId,
    userId: input.signerUserId,
    userEmail: input.signerEmail,
    userRole: input.signerRole,
    action: "ESIGNATURE_CAPTURED",
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    details: { intent: input.intent, statement: input.statement, signerName: input.signerName },
  }).catch(() => { /* audit best-effort */ });

  return rowTo(data as Record<string, unknown>);
}
