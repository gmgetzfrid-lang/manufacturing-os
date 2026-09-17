// lib/documentShares.ts
//
// Tokenized public share links for a single document. Token is a
// 32-char url-safe random string (collision-safe at this scale).

import { supabase } from "@/lib/supabase";

export interface DocumentShare {
  id: string;
  /** null when the server withheld it: the caller cannot read the document
   *  (EGRESS-8), so the link is unusable and only revocation remains. */
  token: string | null;
  orgId: string;
  documentId: string;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  note: string | null;
  accessCount: number;
  accessLastAt: string | null;
}

function randomToken(len = 32): string {
  // url-safe base64 of crypto bytes — guaranteed unguessable at 32 chars
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
    .slice(0, len);
}

export async function createShareLink(input: {
  orgId: string;
  documentId: string;
  expiresInDays?: number;   // default 30
  note?: string;
  createdBy: string;
  createdByName?: string;
}): Promise<DocumentShare> {
  const expiresAt = input.expiresInDays === undefined
    ? new Date(Date.now() + 30 * 86_400_000).toISOString()
    : input.expiresInDays === 0
      ? null
      : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
  const { data, error } = await supabase.from("document_shares").insert({
    token: randomToken(),
    org_id: input.orgId,
    document_id: input.documentId,
    created_by: input.createdBy,
    created_by_name: input.createdByName ?? null,
    expires_at: expiresAt,
    note: input.note ?? null,
  }).select("*").single();
  if (error) throw error;
  return rowToShare(data as Record<string, unknown>);
}

export interface ShareLinkListing {
  /** Whether the caller can currently read the document. When false, only the
   *  caller's own links are listed and none of them carries a token. */
  readable: boolean;
  shares: DocumentShare[];
}

export async function listShareLinks(documentId: string): Promise<ShareLinkListing> {
  // Listed by the server (/api/share/list), never by a client-side SELECT:
  // the route applies the caller's OWN read decision on the document and
  // withholds tokens from anyone who cannot read it (EGRESS-8). Migration
  // 20261066 states the same rule at the database for direct PostgREST reads.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");
  const res = await fetch(`/api/share/list?documentId=${encodeURIComponent(documentId)}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const out = (await res.json().catch(() => ({}))) as {
    readable?: boolean; shares?: Array<Record<string, unknown>>; error?: string;
  };
  if (!res.ok) throw new Error(out.error || "Failed to load share links");
  return { readable: out.readable === true, shares: (out.shares ?? []).map(rowToShare) };
}

export async function revokeShareLink(id: string, actorUserId: string): Promise<void> {
  // .select() back the touched row: under the per-verb policies (20261022)
  // only the creator or an org controller matches the UPDATE, and RLS turns a
  // non-match into a 0-row success — error === null while the public token
  // keeps serving bytes. Zero rows here MUST throw, or the modal reports a
  // revocation that never happened (EGRESS-7).
  const { data, error } = await supabase.from("document_shares").update({
    revoked_at: new Date().toISOString(),
    revoked_by: actorUserId,
  }).eq("id", id).select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("This link was not revoked — only its creator or a Document Control/Admin can revoke it.");
  }
}

function rowToShare(r: Record<string, unknown>): DocumentShare {
  return {
    id: r.id as string,
    token: (r.token as string | null) ?? null,
    orgId: r.org_id as string,
    documentId: r.document_id as string,
    createdBy: r.created_by as string,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: r.created_at as string,
    expiresAt: (r.expires_at as string | null) ?? null,
    revokedAt: (r.revoked_at as string | null) ?? null,
    revokedBy: (r.revoked_by as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    accessCount: (r.access_count as number) ?? 0,
    accessLastAt: (r.access_last_at as string | null) ?? null,
  };
}
