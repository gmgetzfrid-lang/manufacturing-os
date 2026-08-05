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
  signatureImage?: string | null;
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
    signatureImage: (r.signature_image as string) ?? null,
    signedAt: String(r.signed_at),
  };
}

// ─── Re-authentication at the moment of signing ─────────────────────────────
// A signature that anyone at an unlocked workstation can produce is a click,
// not a signature. Password accounts re-enter their password; SSO accounts
// count as re-authenticated only when their sign-in is recent, and are sent
// back through the provider (prompt=login) when it isn't.

/** SSO sign-ins older than this require a fresh provider round-trip. */
export const SSO_REAUTH_WINDOW_MS = 15 * 60 * 1000;

export type SigningReauth =
  | { method: "password"; email: string }
  | { method: "sso"; email: string; fresh: boolean };

/** How the current user must prove it's them before signing. */
export async function signingReauthState(): Promise<SigningReauth | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;
  const provider = (user.app_metadata as { provider?: string } | null)?.provider ?? "email";
  if (provider === "email") return { method: "password", email: user.email };
  const last = user.last_sign_in_at ? new Date(user.last_sign_in_at).getTime() : 0;
  return { method: "sso", email: user.email, fresh: Date.now() - last < SSO_REAUTH_WINDOW_MS };
}

/** Verify a password account's credential at the moment of signing. Throws
 *  with a human message on a wrong password. */
export async function verifySigningCredential(email: string, password: string): Promise<void> {
  if (!password) throw new Error("Enter your password to sign.");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error("That password doesn't match — signature not applied.");
}

/** Send an SSO account back through its provider with a forced login prompt,
 *  returning to `returnTo` (defaults to the current page) to finish signing. */
export async function reauthWithProvider(returnTo?: string): Promise<void> {
  await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: {
      scopes: "openid email profile",
      redirectTo: returnTo ?? (typeof window !== "undefined" ? window.location.href : "/"),
      queryParams: { prompt: "login" },
    },
  });
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
  /** Optional touchpad-drawn signature, stored as a PNG data URL. */
  signatureImage?: string | null;
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
      signature_image: input.signatureImage ?? null,
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
