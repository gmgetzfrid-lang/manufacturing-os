// lib/documentGuards.ts
//
// Preconditions that protect the document state machine. The product's
// whole value proposition is *control*, yet historically locks and holds
// were advisory: nothing stopped you from publishing a new revision of a
// document that was checked out by someone else, or one that was on an
// active hold. This module turns those invariants into enforced rules.
//
// Two layers use this:
//   1. The lib mutators (revUpDocument / revertToVersion / supersedeDocument)
//      call `assertCanPublishRevision` before they touch the DB, re-fetching
//      the AUTHORITATIVE lock + hold state (never trusting the possibly-stale
//      `doc` the client passed in).
//   2. A defense-in-depth Postgres trigger (see the matching migration)
//      enforces the same rule at the DB layer for any path that bypasses
//      the lib.
//
// The decision itself is a pure function (`evaluatePublishGuard`) so it can
// be unit-tested exhaustively without a database.

import { supabase } from "@/lib/supabase";
import { listActiveHoldsForDocument } from "@/lib/holds";
import type { DocumentHold } from "@/types/schema";

export type PublishBlockCode = "locked_by_other" | "on_hold";

export interface PublishGuardState {
  /** Authoritative lock holder uid from the DB (null = unlocked). */
  checkedOutBy: string | null;
  checkedOutByName?: string | null;
  /** Active (unreleased) holds on the document. */
  activeHolds: DocumentHold[];
}

export interface PublishGuardContext {
  actorUserId: string;
  actorRole?: string | null;
  /** A controller (Admin/DocCtrl) may pass `force` to override a lock/hold. */
  force?: boolean;
}

export interface GuardDecision {
  ok: boolean;
  code?: PublishBlockCode;
  /** Human-readable message safe to surface directly in the UI. */
  message?: string;
  /** Populated when code === "on_hold". */
  blockingHolds?: DocumentHold[];
}

const CONTROLLER_ROLES = new Set(["Admin", "DocCtrl"]);

export function isControllerRoleName(role?: string | null): boolean {
  return !!role && CONTROLLER_ROLES.has(role);
}

/**
 * PURE decision: may `actor` publish a new canonical revision
 * (rev-up / revert / supersede) given the document's current lock and hold
 * state?
 *
 *   - A lock held by *another* user blocks the operation (you'd silently
 *     clobber whatever they're editing).
 *   - Any active hold blocks the operation (the hold exists precisely to
 *     stop the document from advancing).
 *   - A controller (Admin/DocCtrl) may pass `force: true` to override either.
 */
export function evaluatePublishGuard(
  state: PublishGuardState,
  ctx: PublishGuardContext,
): GuardDecision {
  const canForce = isControllerRoleName(ctx.actorRole) && ctx.force === true;
  if (canForce) return { ok: true };

  // 1. Lock held by someone other than the actor.
  if (
    state.checkedOutBy &&
    String(state.checkedOutBy) !== String(ctx.actorUserId)
  ) {
    const who = state.checkedOutByName || "another user";
    return {
      ok: false,
      code: "locked_by_other",
      message: `This document is checked out by ${who}. Ask them to check in — or force-unlock it — before publishing a new revision.`,
    };
  }

  // 2. Active holds block advancing the document.
  if (state.activeHolds.length > 0) {
    const reasons = state.activeHolds.map((h) => h.reason).join(", ");
    const plural = state.activeHolds.length > 1 ? "holds" : "hold";
    return {
      ok: false,
      code: "on_hold",
      message: `This document has an active ${plural} (${reasons}). Release it before publishing a new revision.`,
      blockingHolds: state.activeHolds,
    };
  }

  return { ok: true };
}

export class DocumentMutationBlockedError extends Error {
  code: PublishBlockCode;
  constructor(decision: GuardDecision) {
    super(decision.message ?? "This document cannot be modified right now.");
    this.name = "DocumentMutationBlockedError";
    this.code = decision.code ?? "locked_by_other";
  }
}

/**
 * Re-fetch the authoritative lock + hold state from the DB. We deliberately
 * do NOT trust the `doc` object the client passed in — it may be seconds or
 * minutes stale, which is exactly the window a race lives in.
 */
export async function fetchPublishGuardState(
  documentId: string,
): Promise<PublishGuardState> {
  const { data, error } = await supabase
    .from("documents")
    .select("checked_out_by, checked_out_by_name")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row =
    (data as { checked_out_by: string | null; checked_out_by_name: string | null } | null) ?? null;
  const activeHolds = await listActiveHoldsForDocument(documentId);
  return {
    checkedOutBy: row?.checked_out_by ?? null,
    checkedOutByName: row?.checked_out_by_name ?? null,
    activeHolds,
  };
}

/**
 * Assert the actor may publish a new revision; throws
 * DocumentMutationBlockedError (with a UI-safe message) if not.
 */
export async function assertCanPublishRevision(
  documentId: string,
  ctx: PublishGuardContext,
): Promise<void> {
  const state = await fetchPublishGuardState(documentId);
  const decision = evaluatePublishGuard(state, ctx);
  if (!decision.ok) throw new DocumentMutationBlockedError(decision);
}
