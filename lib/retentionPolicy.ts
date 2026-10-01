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

export type RetentionStatus = "none" | "active" | "eligible" | "disposed" | "hold";

/** Pill/state for a document. Legal hold wins (it's the loudest); then disposed;
 *  then eligible (past retention); then active (retained); else none.
 *  (Moved here from lib/retention.ts, which re-exports it, so the storage
 *  delete route reads the same verdict as the register and the pill without
 *  importing the browser client — intelligence DACL-2.) */
export function retentionStatusFor(input: { retentionUntil?: string | null; dispositionState?: string | null; legalHold?: boolean | null }): RetentionStatus {
  if (input.legalHold) return "hold";
  if (input.dispositionState === "disposed") return "disposed";
  if (input.dispositionState === "eligible") return "eligible";
  if (input.retentionUntil) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due = new Date(`${input.retentionUntil.slice(0, 10)}T00:00:00`);
    if (!Number.isNaN(due.getTime()) && due.getTime() <= today.getTime()) return "eligible";
    return "active";
  }
  return "none";
}

// ── RET-11: the scheduled end-of-life action ─────────────────────────────────
// RetentionPolicy.action ('review' | 'archive' | 'destroy') was edited, stored
// and inherited but read by nothing: a records schedule configured "then
// destroy" was notified and disposed exactly like "then review". These are the
// ONE reading of the field — the scan's notice, the Inspector's description,
// and the disposition default all come through here.

export type ScheduledAction = NonNullable<RetentionPolicy["action"]>;

/** The action a policy schedules at end of life; 'review' when unset (the
 *  type's own default — a prompt to the controller, never automatic). */
export function scheduledActionFor(policy: RetentionPolicy | null | undefined): ScheduledAction {
  return policy?.action ?? "review";
}

/** Human wording for the scheduled action, as the notice and the panel say it. */
export function scheduledActionLabel(policy: RetentionPolicy | null | undefined): string {
  const a = scheduledActionFor(policy);
  return a === "destroy" ? "destroy" : a === "archive" ? "archive" : "flag for review";
}

/** What disposeDocument records when the caller names no action: the schedule's
 *  'destroy' or 'archive'; a 'review' schedule disposes as an archive (the
 *  review is the disposition decision being taken). */
export function disposeActionFor(policy: RetentionPolicy | null | undefined): "archive" | "destroy" {
  return scheduledActionFor(policy) === "destroy" ? "destroy" : "archive";
}

/** One sentence for a policy, naming the schedule's action so a controller who
 *  chose "then destroy" sees it outside the open editor. */
export function describeRetentionPolicy(p?: RetentionPolicy | null): string {
  if (!p || !p.enabled || !p.years) return "No retention policy";
  return `Retain ${p.years} year${p.years === 1 ? "" : "s"} from ${p.basis ?? "created"}, then ${scheduledActionLabel(p)}`;
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
