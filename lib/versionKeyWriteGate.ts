// lib/versionKeyWriteGate.ts — document-control PKG-1 / PKG-15: a signed
// write to a key that is already the stored bytes of a document version is
// never authorized.
//
// Every upload the app mints targets a FRESH, timestamped key, so a request
// to write a key that is already a document version's bytes is never a
// legitimate upload — it is an in-place overwrite of an issued,
// hash-recorded, approved revision, which changes what every QR, doc pack
// and download serves while every database fact (rev, file_hash, approvals)
// stays untouched. The immutable revision bytes can only be replaced by
// publishing a new version (a fresh key). Checked against both the rendered
// bytes (file_url) and the native source (source_file_key).
//
// Two exact-equality lookups rather than a PostgREST .or() raw string:
// assertSafeStorageKey permits commas and parentheses, which would break or
// inject an .or() filter expression. Fail closed — never authorize a write
// that could not be cleared against the version ledger, because the write is
// irreversible.
//
// Moved here verbatim from app/api/storage/upload-url/route.ts (PKG-1) so
// /api/storage/multipart asks exactly the same question with the same words
// and codes (PKG-15).

import type { SupabaseClient } from "@supabase/supabase-js";

export const VERSION_KEY_UNVERIFIED = "Couldn't verify the target key; upload refused.";
export const VERSION_KEY_REFUSAL = "That file already belongs to a published revision and cannot be overwritten. Publish a new revision instead.";

/** null when a write to `path` may be authorized; otherwise the refusal. */
export async function versionKeyWriteRefusal(
  sb: Pick<SupabaseClient, "from">,
  path: string,
): Promise<{ status: number; error: string } | null> {
  for (const col of ["file_url", "source_file_key"] as const) {
    const { data: clash, error: clashErr } = await sb
      .from("document_versions")
      .select("id")
      .eq(col, path)
      .limit(1)
      .maybeSingle();
    if (clashErr) return { status: 503, error: VERSION_KEY_UNVERIFIED };
    if (clash) return { status: 409, error: VERSION_KEY_REFUSAL };
  }
  return null;
}
