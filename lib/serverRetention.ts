// lib/serverRetention.ts — SERVER-ONLY retention re-clock for relocated docs.
//
// Retention policy inherits doc → folder → library and retention_until is
// MATERIALIZED on the row, so ANY operation that changes a document's
// collection_id (bulk move, folder-delete step-up) must re-clock the moved
// docs against the destination's effective policy. Shares the exact pure
// rules the client uses (lib/retentionPolicy.ts) so no drift is possible.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveEffectiveRetentionPolicy,
  computeRetentionUntil,
  retentionBasisISO,
} from "@/lib/retentionPolicy";
import type { RetentionPolicy } from "@/types/schema";

export interface RetentionDocRow {
  id: string;
  retention_policy: RetentionPolicy | null;
  created_at: string | null;
  updated_at: string | null;
  effective_date: string | null;
  disposition_state: string | null;
  retention_until: string | null;
}

/** Columns a caller must select to feed reclockRetentionForDocs. */
export const RETENTION_DOC_COLUMNS =
  "id, retention_policy, created_at, updated_at, effective_date, disposition_state, retention_until";

/** Re-clock the given docs (all landing under ONE destination folder — or
 *  the library root) against that destination's effective policy. Disposed
 *  records are never touched. Returns honest counts: writes attempted,
 *  writes that FAILED (callers must surface failures, not swallow them). */
export async function reclockRetentionForDocs(
  admin: SupabaseClient,
  docs: RetentionDocRow[],
  folderPolicy: RetentionPolicy | null,
  libPolicy: RetentionPolicy | null,
): Promise<{ updated: number; failed: number; firstError: string | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const updates = docs
    .filter((d) => d.disposition_state !== "disposed")
    .map((d) => {
      const policy = resolveEffectiveRetentionPolicy(d.retention_policy, folderPolicy, libPolicy);
      const until = policy ? computeRetentionUntil(retentionBasisISO(policy, d), policy) : null;
      const state = !policy ? null : until && until <= today ? "eligible" : "active";
      if (until === d.retention_until && (state ?? null) === (d.disposition_state ?? null)) return null;
      return { id: d.id, retention_until: until, disposition_state: state };
    })
    .filter((u): u is { id: string; retention_until: string | null; disposition_state: string | null } => u !== null);

  let updated = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (let i = 0; i < updates.length; i += 25) {
    const results = await Promise.all(updates.slice(i, i + 25).map((u) =>
      admin.from("documents")
        .update({ retention_until: u.retention_until, disposition_state: u.disposition_state })
        .eq("id", u.id)));
    for (const r of results) {
      if (r.error) { failed += 1; if (!firstError) firstError = r.error.message; }
      else updated += 1;
    }
  }
  return { updated, failed, firstError };
}

/** Fetch a container's retention policies (destination folder + library). */
export async function loadDestinationPolicies(
  admin: SupabaseClient,
  libraryId: string,
  folderId: string | null,
): Promise<{ folderPolicy: RetentionPolicy | null; libPolicy: RetentionPolicy | null }> {
  let folderPolicy: RetentionPolicy | null = null;
  if (folderId) {
    const { data } = await admin.from("collections").select("retention_policy").eq("id", folderId).maybeSingle();
    folderPolicy = (data?.retention_policy as RetentionPolicy | null) ?? null;
  }
  const { data: lib } = await admin.from("libraries").select("retention_policy").eq("id", libraryId).maybeSingle();
  return { folderPolicy, libPolicy: (lib?.retention_policy as RetentionPolicy | null) ?? null };
}
