// lib/shedKeyGuard.ts — SERVER-ONLY. The two guards every destructive
// storage step of the space-savers runs a key through before it is bundled
// or deleted (document-control RET-6 / RET-8).
//
//   RET-6 — the keys the shed reads (document_versions.file_url,
//   tickets.attachments[].url) live in member-writable columns. A member can
//   repoint a decade-old superseded row at ANY string; the commit routes fed
//   that string straight into DeleteObjects. Every key is now required to be
//   a plain, forward-only object key under THIS org's prefix — the same rule
//   ticket-shed/restore already applied on its write path — and a key that
//   fails is neither read into the archive nor deleted, only counted.
//
//   RET-8 — revertToVersion deliberately reuses the reverted-to revision's
//   storage key (two rows, one object). Shedding the old row deleted the
//   CURRENT revision's bytes. A key may only be freed when every non-archived
//   document_versions row that references it is part of the set being
//   archived; a key still referenced by a row OUTSIDE that set is skipped at
//   produce (never claimed) and at commit (never stamped, never deleted).
//   Both reads fail CLOSED: an error refuses the step rather than guessing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isSafeStorageKey } from "@/lib/storageKey";

/** The prefix every object this org owns lives under. */
export function orgKeyPrefix(orgId: string): string {
  return `orgs/${orgId}/`;
}

/** True when `key` is a safe, forward-only object key under this org's prefix. */
export function isOrgOwnedKey(key: string | null | undefined, orgId: string): key is string {
  if (!key || !orgId) return false;
  if (!isSafeStorageKey(key)) return false;
  return key.startsWith(orgKeyPrefix(orgId));
}

/** Split rows by whether their storage key is org-owned (see isOrgOwnedKey). */
export function partitionOrgKeys<T>(
  rows: readonly T[],
  orgId: string,
  keyOf: (row: T) => string | null | undefined,
): { owned: T[]; rejected: T[] } {
  const owned: T[] = [];
  const rejected: T[] = [];
  for (const r of rows) (isOrgOwnedKey(keyOf(r), orgId) ? owned : rejected).push(r);
  return { owned, rejected };
}

/** Pure half of the RET-8 rule: given every live (archived_at IS NULL)
 *  document_versions row that references any of the candidate keys, return the
 *  keys that some row OUTSIDE `insideIds` still references. */
export function keysSharedOutside(
  liveRows: ReadonlyArray<{ id: string; file_url: string | null }>,
  insideIds: ReadonlySet<string>,
): Set<string> {
  const shared = new Set<string>();
  for (const r of liveRows) {
    if (r.file_url && !insideIds.has(r.id)) shared.add(r.file_url);
  }
  return shared;
}

/** The keys among `keys` that a non-archived document_versions row outside
 *  `insideIds` still references. Throws on any read error (fail closed). */
export async function sharedLiveKeys(
  sb: SupabaseClient,
  orgId: string,
  keys: readonly string[],
  insideIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const uniq = Array.from(new Set(keys.filter(Boolean)));
  const live: Array<{ id: string; file_url: string | null }> = [];
  for (let i = 0; i < uniq.length; i += 200) {
    const chunk = uniq.slice(i, i + 200);
    const { data, error } = await sb
      .from("document_versions")
      .select("id, file_url")
      .eq("org_id", orgId)
      .in("file_url", chunk)
      .is("archived_at", null);
    if (error) {
      throw new Error(`Couldn't verify which revisions still share these storage keys (${error.message}); refusing to proceed.`);
    }
    live.push(...(((data ?? []) as Array<{ id: string; file_url: string | null }>)));
  }
  return keysSharedOutside(live, insideIds);
}
