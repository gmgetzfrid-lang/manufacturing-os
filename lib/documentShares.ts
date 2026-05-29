// lib/documentShares.ts
//
// Tokenized public share links for a single document. Token is a
// 32-char url-safe random string (collision-safe at this scale).

import { supabase } from "@/lib/supabase";

export interface DocumentShare {
  id: string;
  token: string;
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

export async function listShareLinks(documentId: string): Promise<DocumentShare[]> {
  const { data } = await supabase
    .from("document_shares")
    .select("*")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });
  return ((data ?? []) as Array<Record<string, unknown>>).map(rowToShare);
}

export async function revokeShareLink(id: string, actorUserId: string): Promise<void> {
  await supabase.from("document_shares").update({
    revoked_at: new Date().toISOString(),
    revoked_by: actorUserId,
  }).eq("id", id);
}

function rowToShare(r: Record<string, unknown>): DocumentShare {
  return {
    id: r.id as string,
    token: r.token as string,
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
