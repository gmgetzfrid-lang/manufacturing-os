// lib/retentionPolicy.ts
//
// The PURE half of records-management retention: policy resolution and date
// arithmetic, no I/O and no client imports. lib/retention.ts (browser) and
// the server move route both build on these, so a document moved between
// folders is re-clocked by exactly the same rules everywhere.

import type { RetentionPolicy } from "@/types/schema";

/** Most specific DEFINED policy wins: document > folder > library. A defined
 *  but disabled policy STOPS inheritance (an explicit "no retention here"). */
export function resolveEffectiveRetentionPolicy(
  docP?: RetentionPolicy | null, folderP?: RetentionPolicy | null, libP?: RetentionPolicy | null,
): RetentionPolicy | null {
  for (const p of [docP, folderP, libP]) {
    if (p) return p.enabled ? p : null;
  }
  return null;
}

export function computeRetentionUntil(basisISO: string | null, policy: RetentionPolicy | null): string | null {
  if (!policy || !policy.enabled || !policy.years || !basisISO) return null;
  const d = new Date(basisISO);
  if (Number.isNaN(d.getTime())) return null;
  d.setFullYear(d.getFullYear() + policy.years);
  return d.toISOString().slice(0, 10);
}

/** The basis date a policy clocks from, given the doc's raw timestamps. */
export function retentionBasisISO(
  policy: RetentionPolicy,
  doc: { created_at: string | null; updated_at: string | null; effective_date: string | null },
): string | null {
  const basis = policy.basis ?? "created";
  return basis === "created" ? doc.created_at
    : basis === "effective" ? (doc.effective_date || doc.updated_at || doc.created_at)
    : /* issued | superseded */ (doc.updated_at || doc.created_at);
}
