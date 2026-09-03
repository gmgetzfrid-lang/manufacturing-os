// lib/eSignatures.ts
//
// Formal e-signature capture + read. A signature is an immutable, attributable
// affirmation of intent against a resource. SURF-14 / RG-9 / EVID-3: the row is
// MINTED BY THE SERVER (/api/signatures/sign) — the browser sends what the
// signer affirmed plus their re-authentication credential; the route verifies
// the credential, derives the signer's name / role / email from org_members and
// the content hash from the version row, writes the row on the service-role key
// and mirrors the audit event. No client insert path exists (20261050).

import { supabase } from "@/lib/supabase";

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
  /** RG-9: how the signer re-authenticated at the moment of signing, set server-side. */
  reauthMethod?: "password" | "sso" | null;
  reauthAt?: string | null;
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
    reauthMethod: (r.reauth_method as "password" | "sso" | null) ?? null,
    reauthAt: (r.reauth_at as string | null) ?? null,
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

/** The credential the ceremony collected, verified by the SERVER at the moment
 *  of signing (never here — a client-side check binds nothing to the row). */
export type SigningCredential =
  | { method: "password"; password: string }
  | { method: "sso" };

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

/** Run the signing ceremony's server half. `signerUserId` / `signerName` /
 *  `signerRole` / `signerEmail` are accepted for call-site compatibility but
 *  the SERVER derives every one of them from the bearer and the membership
 *  row — nothing the browser says about who is signing reaches the row. */
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
  /** The re-authentication the ceremony collected; verified server-side. */
  reauth?: SigningCredential | null;
}): Promise<ESignature> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");
  const res = await fetch("/api/signatures/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({
      orgId: input.orgId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      documentVersionId: input.documentVersionId ?? null,
      contentHash: input.contentHash ?? null,
      intent: input.intent,
      statement: input.statement,
      signatureImage: input.signatureImage ?? null,
      reauth: input.reauth ?? { method: "sso" },
    }),
  });
  const out = (await res.json().catch(() => ({}))) as { signature?: Record<string, unknown>; error?: string };
  if (!res.ok || !out.signature) throw new Error(out.error || "Failed to record signature");
  return rowTo(out.signature);
}
