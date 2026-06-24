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
import { canPublishOnLibrary, isControllerRole, type Principal } from "@/lib/permissions";
import type { AccessControl, DocumentHold } from "@/types/schema";

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
  /** Precomputed per-library publish authority (see canPublishOnLibrary). Lets a
   *  non-controller granted "publish" on this document's library override a
   *  foreign CHECKOUT when forcing — but NOT an active hold, which stays
   *  controller-only. */
  canControlLibrary?: boolean;
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
 * Is a document currently CHECKED OUT (i.e. locked by someone)?
 *
 * The single source of truth is the authoritative lock holder
 * (`checked_out_by`). `active_collaborators` is a *display* list of session
 * participants that can drift out of lockstep with the lock: an admin
 * force-release or a non-holder check-in clears the lock columns but may leave
 * a name behind in the collaborator list, and legacy rows predate the lock
 * columns entirely. A populated collaborator list with NO lock holder is a
 * "zombie" — the document is NOT locked, and the UI must not present it as
 * such, or users see phantom checkouts they have no way to clear.
 * (CheckoutFlowModal detects the same condition as `isZombieCollaborator` and
 * offers a repair path.)
 */
export function isDocumentCheckedOut(
  doc: { checkedOutBy?: string | null } | null | undefined,
): boolean {
  return !!doc?.checkedOutBy;
}

/**
 * True when a document carries collaborator names but has NO authoritative
 * lock — the "zombie"/stale state described above. Useful for surfacing a
 * faint repair hint without treating the document as locked.
 */
export function hasStaleCollaborators(
  doc: { checkedOutBy?: string | null; activeCollaborators?: string[] | null } | null | undefined,
): boolean {
  return !doc?.checkedOutBy && (doc?.activeCollaborators?.length ?? 0) > 0;
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
  const forcing = ctx.force === true;
  const isController = isControllerRoleName(ctx.actorRole);
  // A controller (Admin/DocCtrl) forces past EVERYTHING. A per-library publisher
  // (canControlLibrary, e.g. a granted Drafting Supervisor) may force past a
  // foreign CHECKOUT — but an active HOLD still stops them: holds are deliberate
  // "do not advance" flags reserved for the controller tier.
  const canForceLock = forcing && (isController || ctx.canControlLibrary === true);
  const canForceHold = forcing && isController;

  // 1. Lock held by someone other than the actor.
  if (
    state.checkedOutBy &&
    String(state.checkedOutBy) !== String(ctx.actorUserId) &&
    !canForceLock
  ) {
    const who = state.checkedOutByName || "another user";
    return {
      ok: false,
      code: "locked_by_other",
      message: `This document is checked out by ${who}. Ask them to check in — or force-unlock it — before publishing a new revision.`,
    };
  }

  // 2. Active holds block advancing the document.
  if (state.activeHolds.length > 0 && !canForceHold) {
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
 * DocumentMutationBlockedError (with a UI-safe message) if not. Returns the
 * authoritative pre-publish state so the caller can drive the override flow
 * (it tells you whether — and by whom — the document was checked out).
 */
export async function assertCanPublishRevision(
  documentId: string,
  ctx: PublishGuardContext,
): Promise<PublishGuardState> {
  const state = await fetchPublishGuardState(documentId);
  const decision = evaluatePublishGuard(state, ctx);
  if (!decision.ok) throw new DocumentMutationBlockedError(decision);
  return state;
}

/**
 * Resolve a principal's per-library publish authority by loading the library's
 * ACL and delegating to canPublishOnLibrary. Admin/DocCtrl short-circuit to true
 * without a fetch. This is the one place the lib mutators read the library ACL,
 * so the rule lives in exactly one spot on the app side (the DB trigger mirrors
 * it for direct-to-Postgres writes).
 */
export async function resolveCanControlLibrary(
  libraryId: string,
  principal: Principal,
): Promise<boolean> {
  if (isControllerRole(principal.role)) return true;
  if (!libraryId) return false;
  const { data } = await supabase
    .from("libraries")
    .select("acl")
    .eq("id", libraryId)
    .maybeSingle();
  return canPublishOnLibrary({
    principal,
    libraryAcl: (data?.acl as AccessControl | undefined) ?? undefined,
  });
}
