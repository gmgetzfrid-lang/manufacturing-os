// lib/revisions.ts
// Document-control business logic for the Rev-Up workflow.
//
// A Rev-Up is the canonical "I'm publishing a new revision of an existing
// document" operation. It:
//   1. Hashes the uploaded file (SHA-256) so future audits can prove which
//      bytes were attached to which revision.
//   2. Uploads the new file to a revision-scoped storage path (so the
//      previous file remains intact and readable).
//   3. Creates a new `document_versions` row with the full engineering
//      signoff chain, MOC reference, source CAD filename, and a link to
//      the version it supersedes.
//   4. Marks the previous version's `superseded_at` so version-history
//      queries can render "Superseded YYYY-MM-DD" without joining sibling
//      rows.
//   5. Flips `documents.current_version_id` and rolls the human-readable
//      `documents.rev` label forward.
//   6. Writes a `REV_UP` row to `audit_logs` with everything needed for a
//      PSM-style audit reconstruction.

import { supabase } from "@/lib/supabase";
import { uploadToPath, makeLibraryStoragePath, uniqueUploadName } from "@/lib/storage";
import { logRevisionEvent, logAuditAction } from "@/lib/audit";
import {
  fetchPublishGuardState,
  evaluatePublishGuard,
  resolveCanControlLibrary,
  assertRevertableTarget,
  DocumentMutationBlockedError,
  type PublishGuardState,
} from "@/lib/documentGuards";
import { resolveActorPrincipal } from "@/lib/principal";
import { getActiveEpisode, postEpisodeSystemMessage } from "@/lib/checkoutEpisodes";
import { notify } from "@/lib/inAppNotifications";
import { getMyEditBase, recordIntent } from "@/lib/intents";
import { announceBranchOpened } from "@/lib/branches";
import { isControllerPrincipal, type Principal } from "@/lib/permissions";
import type { DocumentRecord, DocumentVersion, ReviewControl } from "@/types/schema";
import { letterLabelFor, openReviewRoster, invalidateDraftSignoffs, effectiveReviewControlForDocument, draftRosterCompleteChecked } from "@/lib/reviewControl";
import { applyEffectiveDate } from "@/lib/effectiveDate";
import { isEffectiveOwnerOfDocument } from "@/lib/ownership";
import { runPostPublishSideEffects } from "@/lib/postPublish";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import { recomputeRetention } from "@/lib/retention";
import { assertNotOnHold } from "@/lib/holdGate";
import { isControlledIssueStatus, isRetiredStatus, isIssueTransition, RETIRED_NOT_ISSUED_STAMP, WORK_IN_PROGRESS_STATUSES } from "@/lib/issueStatus";
import { requestUnitCodeDecode } from "@/lib/unitCodeClient";

// ─── Publish contract errors ─────────────────────────────────────────────
//
// A stale base is NOT an error string — it's a structured event the UI turns
// into the conflict screen (diff / message / publish-as-branch). Nothing was
// written when this throws; cancelling costs nothing.

export interface StaleBaseInfo {
  currentVersionId: string | null;
  currentRev: string | null;
  currentBy: string | null;
  currentByName: string | null;
  currentAt: string | null;
  currentChangeLog: string | null;
}

export class StaleBaseError extends Error {
  info: StaleBaseInfo;
  constructor(info: StaleBaseInfo) {
    super(
      `This document changed while you were working: ${info.currentByName || "another user"} published Rev ${info.currentRev ?? "?"}${info.currentAt ? ` on ${new Date(info.currentAt).toLocaleDateString()}` : ""}. Your upload is based on an older revision.`,
    );
    this.name = "StaleBaseError";
    this.info = info;
  }
}

export class DuplicateLabelError extends Error {
  label: string;
  constructor(label: string) {
    super(`Revision label "${label}" already exists on this document. Pick the next label.`);
    this.name = "DuplicateLabelError";
    this.label = label;
  }
}

/** True when PostgREST cannot find the publish_revision RPC — its schema
 *  cache is reloading (PGRST202 right after a migration is applied) or the
 *  function genuinely is not installed. */
export function isMissingPublishRpc(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "PGRST202" || err.code === "42883") return true;
  const msg = (err.message ?? "").toLowerCase();
  return msg.includes("publish_revision") &&
    (msg.includes("does not exist") || msg.includes("could not find") || msg.includes("schema cache"));
}

/** REV-8: the publish contract could not be reached — NOTHING was published.
 *  There is no unguarded fallback any more: a publish without the RPC's
 *  row lock, base check and single transaction is exactly the lost update
 *  the contract exists to prevent. */
export class PublishContractUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `Nothing was published: the publish contract (publish_revision) could not be reached (${detail}). ` +
      "If a database migration was just applied, wait a few seconds and try again; if it keeps happening, " +
      "ask an administrator to confirm the publish migrations are applied.",
    );
    this.name = "PublishContractUnavailableError";
  }
}

/** How long to wait before the one retry of a transient "function not found"
 *  (PostgREST reloads its schema cache in about a second). Exported so tests
 *  can shorten it. */
export const PUBLISH_RPC_RETRY_MS = { value: 1500 };

/**
 * Call publish_revision. OWN-5 / DEC-11: the v1-signature retry is RETIRED —
 * it silently upgraded a checkout-override (p_override_lock, note required,
 * holder notified) into a controller force (p_force, bypasses lock AND hold)
 * whenever the deployed function looked old.
 *
 * REV-8: a transient miss (PGRST202 while the schema cache reloads) is
 * retried ONCE against the RPC itself — never downgraded. A miss that
 * survives the retry throws PublishContractUnavailableError: the legacy
 * three-step path (no row lock, no transaction, no base check on revert) and
 * the 60-second module flag that routed every publish in the tab to it are
 * gone. A missing contract is a deployment error to surface loudly.
 */
async function callPublishRevisionRpc(args: Record<string, unknown>): Promise<{
  data: unknown; error: { code?: string; message?: string } | null;
}> {
  const first = await supabase.rpc("publish_revision", args);
  if (!isMissingPublishRpc(first.error)) return first;
  await new Promise((r) => setTimeout(r, PUBLISH_RPC_RETRY_MS.value));
  const second = await supabase.rpc("publish_revision", args);
  if (!isMissingPublishRpc(second.error)) return second;
  // DCK-8 deploy order: an override publish names p_override_reason, which
  // only the 20261130 signature has — say so rather than "unavailable".
  if ("p_override_reason" in args) {
    throw new PublishContractUnavailableError(
      "publishing over another user's checkout needs migration 20261130 (the override reason is recorded by the database) — it is not applied yet",
    );
  }
  throw new PublishContractUnavailableError(second.error?.message || second.error?.code || "function not found");
}

export type RevUpInput = {
  doc: DocumentRecord;
  libraryId: string;
  folderPath?: string[];
  file: File;

  // Required engineering metadata (form-validated upstream)
  revisionLabel: string;
  changeLog: string;

  // Optional fields the user may fill in
  issueType?: DocumentVersion["issueType"];
  changeType?: DocumentVersion["changeType"];
  drawnByName?: string;
  checkedByName?: string;
  approvedByName?: string;
  mocReference?: string;
  sourceFileName?: string;
  /** Date this revision comes into force. Omit / null = effective immediately;
   *  a future date shows "Effective <date>" until it arrives. */
  effectiveDate?: string | null;

  // Actor context (the user performing the rev-up)
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** Controllers (Admin/DocCtrl) may force past a foreign lock or active hold. */
  force?: boolean;
  /** Required when publishing over ANOTHER user's checkout. The message shown to
   *  that user (what's happening + why). Their checkout is left OPEN; they're
   *  notified and deep-linked to the new revision. */
  overrideReason?: string;
  // ── Publish-contract fields ──
  /**
   * The revision this work is based on. Resolution order when omitted:
   * the actor's live edit-intent base (checkout/download capture) → the
   * doc's currentVersionId as the client sees it. The RevUpModal passes an
   * explicit value from its "based on rev" picker when no intent exists.
   */
  expectedBaseVersionId?: string | null;
  /** Publish as an unreconciled BRANCH (stale-base override). Requires branchReason. */
  asBranch?: boolean;
  branchReason?: string;
  /** Optional native CAD source (DWG / zip of xrefs) stored alongside the PDF. */
  sourceFile?: File | null;
  /** GAP-6 / DEC-22: the drafting ticket this revision DELIVERS. Provenance
   *  only — written to document_versions.related_ticket_id; since DEC-23 it
   *  waives nothing (a ticket approval never satisfies a document sign-off). */
  relatedTicketId?: string | null;
};

export type RevUpResult = {
  newVersion: DocumentVersion;
  supersededVersionId: string | null;
  /** TRUE when the publish went in as an unreconciled branch, not current. */
  branched?: boolean;
  branchId?: string | null;
};
async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function suggestRevLabel(current?: string | null): string {
  if (!current) return "0";
  const trimmed = current.trim();
  // Numeric (0, 1, 2, …) — increment by 1
  if (/^\d+$/.test(trimmed)) return String(parseInt(trimmed, 10) + 1);
  // Prefixed numeric (R0, R1, Rev 3, …)
  const m = trimmed.match(/^(.*?)(\d+)$/);
  if (m) return `${m[1]}${parseInt(m[2], 10) + 1}`;
  // Single alpha (A, B, C, …)
  if (/^[A-Y]$/i.test(trimmed)) return String.fromCharCode(trimmed.charCodeAt(0) + 1);
  // Fallback: append "_next"
  return `${trimmed}_next`;
}

/** Public helper so the modal can pre-fill the rev label input. */
export function suggestNextRevisionLabel(currentRev?: string | null): string {
  return suggestRevLabel(currentRev);
}

/** DCK-8: the shortest reason that may accompany a publish over another
 *  user's checkout. publish_revision (20261130) refuses a shorter one at the
 *  database; the app says so before anything is uploaded. It binds only the
 *  callers that publish through that function (rev-up, revert): supersede,
 *  split, merge and a review submission reuse the same gate, where the
 *  reason is the message the holder is shown and any non-blank one serves. */
export const OVERRIDE_REASON_MIN = 5;

/** What the caller of authorizePublish is doing — it words the refusal, and
 *  only "publish" (a publish_revision call) carries OVERRIDE_REASON_MIN. */
export type GuardedOperation = "publish" | "supersede" | "split" | "merge" | "submit for review";

function overrideReasonVerb(op: GuardedOperation): string {
  switch (op) {
    case "publish": return "publish over another user's checkout";
    case "submit for review": return "submit a revision for review while another user has the document checked out";
    default: return `${op} a document another user has checked out`;
  }
}

/** HLD-2 (review fix 4): what a split or merge does with a source under an
 *  active stop-work hold. A controller (Admin / DocCtrl, held anywhere in the
 *  role collection — the database's `is_org_controller`) proceeds OVER the
 *  hold with an explicit acknowledgement, and the hold is carried to every
 *  new sheet (split) or onto the merge target; the operation then passes
 *  `force`. Anyone else is refused (the database refuses them too: status →
 *  Superseded advances the document) — and is NOT told to release the hold:
 *  releasing a stop-work hold in order to split or merge is exactly how it
 *  would be laundered away (the new sheets would carry nothing). Pure: the
 *  Split / Merge wizards and `authorizePublish`'s refusal share the wording. */
export type HeldRetirementDecision =
  | { kind: "clear" }
  | { kind: "acknowledge"; text: string }
  | { kind: "refused"; message: string };

export function heldRetirementDecision(opts: {
  operation: "split" | "merge";
  /** One entry per held source: its label and its active holds' reasons. */
  held: ReadonlyArray<{ label: string; reasons: readonly string[] }>;
  isController: boolean;
}): HeldRetirementDecision {
  const held = opts.held.filter((h) => h.reasons.length > 0);
  if (held.length === 0) return { kind: "clear" };
  const count = held.reduce((n, h) => n + h.reasons.length, 0);
  const holdWord = count === 1 ? "hold" : "holds";
  const list = held.map((h) => `${h.label} (${h.reasons.join(", ")})`).join("; ");
  const where = opts.operation === "split" ? "every new sheet" : "the merge target";
  const carried = `${count === 1 ? "It is" : "They are"} carried to ${where}.`;
  if (opts.isController) {
    return { kind: "acknowledge", text: `Proceed over the active ${holdWord} on ${list}. ${carried}` };
  }
  const leftBare = opts.operation === "split" ? "the new sheets" : "the merge target";
  return {
    kind: "refused",
    message:
      `Active ${holdWord} on ${list}. Only Doc Control or an Admin can ${opts.operation} a held document: ` +
      `they proceed over the hold, and it is carried to ${where}. Ask them to run this ${opts.operation}. ` +
      `Do not release the hold to get past this — ${leftBare} would then carry no hold.`,
  };
}

/**
 * Authorize a publish on `libraryId` and evaluate the lock/hold guard, returning
 * the authoritative pre-publish state. Throws a UI-safe error when the actor
 * lacks per-library publish authority, when a required override reason is missing,
 * or when the guard blocks (foreign lock without authority, or an active hold).
 *
 * `force` is set ONLY when the doc is locked by ANOTHER user — so a normal publish
 * still respects an active hold exactly as before; we never silently blow past a
 * hold on an ordinary rev-up.
 *
 * Exported (HLD-2 / REV-11) so the lifecycle operations that retire or replace
 * a controlled document — split, merge — run the SAME gate as supersede.
 */
export async function authorizePublish(opts: {
  documentId: string;
  libraryId: string;
  orgId: string;
  actorUserId: string;
  actorRole?: string;
  overrideReason?: string;
  /** Controller's explicit emergency force (bypasses lock AND hold). */
  force?: boolean;
  /** What the caller does with the gate (default "publish"). Only a publish
   *  holds the override reason to OVERRIDE_REASON_MIN — the database's rule
   *  for publish_revision; the others need a non-blank reason. */
  operation?: GuardedOperation;
  /** "ignore" asks authority and the lock ONLY — for a write that does not
   *  advance the document (HLD-2, review fix 3: an existing merge target
   *  kept without a rev-up takes more holds and a tag union; its content is
   *  unchanged and the database does not treat either as advancing, so its
   *  own holds do not stop it). Default "block". The returned state still
   *  carries the holds. */
  holds?: "block" | "ignore";
  /** How a split / merge refusal over a hold names the document (HLD-2,
   *  review fix 4). Defaults to "This document". */
  subjectLabel?: string;
}): Promise<PublishGuardState> {
  // OWN-3 / OWN-6: the principal carries the actor's full role collection
  // and team memberships — resolved from the same rows the DB guard reads —
  // so an additively-held DocCtrl is a controller and a team publish grant
  // is honored here exactly as the database honors it.
  const principal: Principal = await resolveActorPrincipal({
    uid: opts.actorUserId, orgId: opts.orgId, headlineRole: opts.actorRole,
  });
  let canControlLibrary = await resolveCanControlLibrary(opts.libraryId, principal);
  // The document's effective owner may publish it even without library authority.
  if (!canControlLibrary) {
    canControlLibrary = await isEffectiveOwnerOfDocument(opts.documentId, opts.actorUserId);
  }
  if (!canControlLibrary) {
    throw new Error(
      "You don't have authority to publish revisions in this library. Ask an Admin or Doc Control to grant it.",
    );
  }
  const state = await fetchPublishGuardState(opts.documentId);
  const lockedByOther =
    !!state.checkedOutBy && String(state.checkedOutBy) !== String(opts.actorUserId);
  // DCK-8: only a CONTROLLER's explicit force passes a foreign lock without a
  // reason (the RPC re-derives the controller tier from org_members); every
  // other override states why, and the database records it.
  const controllerForce = opts.force === true && isControllerPrincipal(principal);
  const operation: GuardedOperation = opts.operation ?? "publish";
  if (lockedByOther && !controllerForce && !opts.overrideReason?.trim()) {
    throw new Error(`A reason is required to ${overrideReasonVerb(operation)}.`);
  }
  if (operation === "publish" && lockedByOther && !controllerForce && (opts.overrideReason?.trim().length ?? 0) < OVERRIDE_REASON_MIN) {
    throw new Error(`Say why you're publishing over another user's checkout (at least ${OVERRIDE_REASON_MIN} characters) — they are shown this reason.`);
  }
  // The override-with-reason passes the LOCK check only. Holds are evaluated
  // independently and are never satisfied by an override — only a
  // controller's explicit force clears them (evaluatePublishGuard enforces
  // that split; the publish_revision RPC re-checks it transactionally).
  const decision = evaluatePublishGuard(opts.holds === "ignore" ? { ...state, activeHolds: [] } : state, {
    actorUserId: opts.actorUserId,
    actorRole: opts.actorRole,
    actorRoles: principal.roles ?? null,
    canControlLibrary,
    force: opts.force === true,
    overrideLock: lockedByOther && !!opts.overrideReason?.trim(),
  });
  if (!decision.ok && decision.code === "on_hold" && (operation === "split" || operation === "merge")) {
    // HLD-2 (review fix 4): the generic refusal tells the actor to release
    // the hold "before publishing a new revision" — for a split or merge
    // that is the unsafe path (the new sheets would carry no hold). A
    // controller is told to proceed over it explicitly; anyone else that
    // only Doc Control can, and never to release it.
    const label = opts.subjectLabel?.trim() || "This document";
    const reasons = (decision.blockingHolds ?? state.activeHolds).map((h) => h.reason);
    const held = heldRetirementDecision({ operation, held: [{ label, reasons }], isController: isControllerPrincipal(principal) });
    const where = operation === "split" ? "every new sheet" : "the merge target";
    const message = held.kind === "refused" ? held.message
      : held.kind === "acknowledge"
        ? `${label} has an active ${reasons.length === 1 ? "hold" : "holds"} (${reasons.join(", ")}). ` +
          `Confirm "Proceed over the active hold" to ${operation} over it — it is carried to ${where}. ` +
          "Do not release the hold to get past this."
        : decision.message;
    throw new DocumentMutationBlockedError({ ...decision, message });
  }
  if (!decision.ok) throw new DocumentMutationBlockedError(decision);
  return state;
}

/**
 * After a successful publish over another user's checkout: leave their checkout
 * OPEN, but (a) write a system note onto their active checkout episode and (b)
 * send them an in-app notification deep-linked to the new revision — both carrying
 * what changed + why. Fire-and-forget: a notification hiccup never fails the
 * publish that already committed.
 */
async function noteOverrideOnHolder(opts: {
  preState: PublishGuardState;
  documentId: string;
  libraryId: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  revisionLabel: string;
  changeNarrative: string;
  overrideReason?: string;
  newVersionId?: string | null;
}): Promise<void> {
  const holder = opts.preState.checkedOutBy;
  if (!holder || String(holder) === String(opts.actorUserId)) return;
  const who = opts.actorEmail || opts.actorUserId;
  const reason = opts.overrideReason?.trim() || "(no reason given)";
  try {
    const episode = await getActiveEpisode(opts.documentId);
    await postEpisodeSystemMessage({
      orgId: opts.orgId,
      documentId: opts.documentId,
      episodeId: episode?.id ?? null,
      text: `${who} published Rev ${opts.revisionLabel} while you have this checked out — your checkout stays open. What changed: ${opts.changeNarrative}. Why now: ${reason}`,
    });
  } catch {
    /* best-effort: the notification below is the primary signal */
  }
  await notify({
    orgId: opts.orgId,
    userId: String(holder),
    kind: "revision_published_over_checkout",
    title: `New Rev ${opts.revisionLabel} published while you're checked out`,
    body: `What changed: ${opts.changeNarrative} — ${reason}`,
    link: `/documents/${opts.libraryId}?doc=${opts.documentId}`,
    resourceType: "document",
    resourceId: opts.documentId,
    actorUserId: opts.actorUserId,
    actorName: who,
    metadata: { newVersionId: opts.newVersionId ?? null, newRev: opts.revisionLabel, reason },
  });
}

/** A retirement (supersede, split, merge) of a document ANOTHER user has
 *  checked out leaves their checkout open but tells them it was retired, and
 *  why, with a link — on their episode thread and in-app. Best-effort: the
 *  retirement already committed. */
export async function notifyHolderOfRetirement(opts: {
  preState: PublishGuardState;
  documentId: string;
  libraryId: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  verb: "superseded" | "split" | "merged";
  action: "supersede" | "split" | "merge";
  reason: string;
}): Promise<void> {
  const holder = opts.preState.checkedOutBy;
  if (!holder || String(holder) === String(opts.actorUserId)) return;
  const who = opts.actorEmail || opts.actorUserId;
  try {
    const episode = await getActiveEpisode(opts.documentId);
    await postEpisodeSystemMessage({
      orgId: opts.orgId, documentId: opts.documentId, episodeId: episode?.id ?? null,
      text: `${who} ${opts.verb} this document while you have it checked out — your checkout stays open. Reason: ${opts.reason}`,
    });
  } catch {
    /* best-effort */
  }
  try {
    await notify({
      orgId: opts.orgId, userId: String(holder),
      kind: "revision_published_over_checkout",
      title: `Document ${opts.verb} while you're checked out`,
      body: `${opts.verb[0].toUpperCase()}${opts.verb.slice(1)} by ${who}: ${opts.reason}`,
      link: `/documents/${opts.libraryId}?doc=${opts.documentId}`,
      resourceType: "document", resourceId: opts.documentId,
      actorUserId: opts.actorUserId, actorName: who,
      metadata: { action: opts.action, reason: opts.reason },
    });
  } catch {
    /* best-effort */
  }
}

// ─── REV-6: retiring the in-flight review draft ───────────────────────────
//
// Exactly one path used to retire a stale draft (a direct rev-up, best-effort
// and unchecked). Every path that changes or retires the controlled copy —
// revert, supersede, archive, split, merge, and the reversal that parks a
// split/merge's sheets — now runs the same routine, checked at every step,
// and runs it only AFTER the change it belongs to has landed and nothing can
// roll that change back: a voided sign-off never returns to pending or
// signed (20261070), so a void ahead of a step that can still fail would
// destroy a review the operation then claims to have left untouched.
// Order matters: the roster is voided and the draft retired BEFORE the
// pointer is released, so a failure part-way leaves the draft still pointed
// at but unsignable (never a live roster nobody can find), and a retry
// finishes the job.

export type PendingDraftVoid = { voidedVersionId: string | null; problem: string | null };

export class PendingDraftVoidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingDraftVoidError";
  }
}

/** Void the document's in-flight review draft, if it has one: void its open
 *  sign-offs, stamp the draft superseded, then release the pending pointer
 *  (compare-and-set on the draft it read). Throws PendingDraftVoidError
 *  naming the state it leaves when any write is refused. Returns the voided
 *  draft's id, or null when there was none. */
export async function voidPendingDraft(documentId: string): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const { data: docRow, error: readErr } = await supabase
    .from("documents").select("pending_version_id").eq("id", documentId).maybeSingle();
  if (readErr) throw new PendingDraftVoidError(`Couldn't read whether a revision is in review on this document (${readErr.message}) — nothing was changed.`);
  const draftId = ((docRow as { pending_version_id?: string | null } | null)?.pending_version_id) ?? null;
  if (!draftId) return null;

  // 1. The roster: every open (pending / signed) sign-off on the draft → void.
  const { data: open, error: rosterReadErr } = await supabase
    .from("document_review_signoffs").select("id")
    .eq("document_version_id", draftId).in("status", ["pending", "signed"]);
  if (rosterReadErr) throw new PendingDraftVoidError(`Couldn't read the in-review draft's sign-offs (${rosterReadErr.message}) — nothing was changed.`);
  const openIds = ((open as Array<{ id: string }> | null) ?? []).map((r) => r.id);
  if (openIds.length > 0) {
    const { data: voided, error: voidErr } = await supabase
      .from("document_review_signoffs")
      .update({ status: "void", updated_at: nowIso })
      .in("id", openIds).in("status", ["pending", "signed"])
      .select("id");
    if (voidErr) throw new PendingDraftVoidError(`The in-review draft's sign-offs could not be voided (${voidErr.message}) — the draft is still in review.`);
    const n = ((voided as unknown[] | null) ?? []).length;
    if (n < openIds.length) {
      throw new PendingDraftVoidError(`Only ${n} of ${openIds.length} sign-offs on the in-review draft could be voided (the rest were refused) — the draft is still in review.`);
    }
  }

  // 2. The draft itself: retired (a draft already retired is left as is).
  const { data: ver, error: verReadErr } = await supabase
    .from("document_versions").select("id, superseded_at").eq("id", draftId).maybeSingle();
  if (verReadErr) throw new PendingDraftVoidError(`Couldn't read the in-review draft (${verReadErr.message}); its sign-offs are voided and it is still pointed at.`);
  if (ver && !(ver as { superseded_at?: string | null }).superseded_at) {
    const { data: retired, error: retireErr } = await supabase
      .from("document_versions").update({ superseded_at: nowIso })
      .eq("id", draftId).is("superseded_at", null).select("id");
    if (retireErr || ((retired as unknown[] | null) ?? []).length === 0) {
      throw new PendingDraftVoidError(`The in-review draft could not be retired (${retireErr?.message ?? "the write was refused"}); its sign-offs are voided and it is still pointed at.`);
    }
  }

  // 3. The pointer — compare-and-set on the draft we just retired.
  const { data: released, error: ptrErr } = await supabase
    .from("documents").update({ pending_version_id: null })
    .eq("id", documentId).eq("pending_version_id", draftId).select("id");
  if (ptrErr) throw new PendingDraftVoidError(`The in-review draft is retired but the document still points at it (${ptrErr.message}).`);
  if (((released as unknown[] | null) ?? []).length === 0) {
    // A zero-row answer is either a refusal or a pointer someone else already
    // moved — only a successful re-read can tell which (an unreadable answer
    // is never "released").
    const { data: again, error: againErr } = await supabase.from("documents").select("pending_version_id").eq("id", documentId).maybeSingle();
    if (againErr) {
      throw new PendingDraftVoidError(`The in-review draft is retired, but whether the document still points at it could not be confirmed (${againErr.message}).`);
    }
    if (((again as { pending_version_id?: string | null } | null)?.pending_version_id ?? null) === draftId) {
      throw new PendingDraftVoidError("The in-review draft is retired but the document still points at it (the write was refused).");
    }
  }
  return draftId;
}

/** After a publish or retirement that already committed (rev-up, revert,
 *  archive, supersede, split, merge, a reversal's parking): void the draft
 *  and report — never throw, never swallow. Exported for the lifecycle
 *  operations, which run it only once nothing can roll back (REV-6). */
export async function voidPendingDraftAfterPublish(documentId: string, actorUserId: string): Promise<PendingDraftVoid> {
  try {
    return { voidedVersionId: await voidPendingDraft(documentId), problem: null };
  } catch (e) {
    const problem = (e as Error).message;
    console.error(`[publish] the in-review draft on ${documentId} was not voided (actor ${actorUserId}):`, problem);
    return { voidedVersionId: null, problem };
  }
}

// ─── REV-10 / DIST-1: a retired document's share links stop, durably ───────
//
// The share routes refuse a retired document at serve time (P1, DRLS-5), but
// a flag is only as durable as the status: an unarchive or a split/merge
// reversal lifts it and the link serves again. Retirement REVOKES — live rows
// only (20261080 freezes revoked_at once set), what this actor may revoke
// under RLS (the creator or a controller), with the count and any refusal on
// the retirement's own audit event.
//
// Review fix 3: each revoked link gets P1's SHARE_LINK_REVOKED row (the
// DRLS-7 external-access trail — revokeShareLink writes the same row, with
// the same shareId), and the links still live afterwards — another creator's,
// which a non-controller retirer may not revoke under 20261022 — are COUNTED
// and returned (`liveLeft`), so the retirement's record flags them for
// Document Control instead of reading as "revoked: 0" and nothing more.
//
// Review fix 4: "live" is P1's definition (20261080: revoked_at IS NULL AND
// (expires_at IS NULL OR expires_at > now())) — an expired link that was
// never revoked serves nothing and is not counted. The console line runs in
// the RETIRER'S BROWSER (this is client-side code), not in a server log; the
// durable flag is the count on the retirement's audit event.

export type ShareRevocation = {
  revoked: number;
  /** Live links (unrevoked and unexpired — P1's definition) left on the
   *  document after the revoke, as far as this actor can see them (the
   *  20261066 read rule shows a reader of the document every link on it):
   *  another creator's, for a non-controller. Document Control must revoke
   *  them. null when the count could not be read. */
  liveLeft: number | null;
  error: string | null;
  /** SHARE_LINK_REVOKED rows that could not be written, if any. */
  auditError: string | null;
};

export async function revokeLiveSharesForDocument(documentId: string, actorUserId: string): Promise<ShareRevocation> {
  let revoked = 0;
  let error: string | null = null;
  const auditFailures: string[] = [];
  try {
    const { data, error: revokeErr } = await supabase
      .from("document_shares")
      .update({ revoked_at: new Date().toISOString(), revoked_by: actorUserId })
      .eq("document_id", documentId)
      .is("revoked_at", null)
      .select("id, org_id");
    if (revokeErr) {
      error = revokeErr.message;
    } else {
      const rows = (data as Array<{ id: string; org_id?: string | null }> | null) ?? [];
      revoked = rows.length;
      for (const row of rows) {
        const { error: auditErr } = await logAuditAction({
          action: "SHARE_LINK_REVOKED",
          resourceId: documentId,
          resourceType: "document",
          orgId: row.org_id ?? undefined,
          userId: actorUserId,
          details: { shareId: row.id, via: "retirement" },
        });
        if (auditErr) auditFailures.push(`${row.id}: ${auditErr}`);
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }
  let liveLeft: number | null = null;
  try {
    // P1's live rule, applied to the unrevoked rows (a document carries a
    // handful of links): an expired, never-revoked link is not live.
    const nowMs = Date.now();
    const { data: unrevoked, error: countErr } = await supabase
      .from("document_shares")
      .select("id, expires_at")
      .eq("document_id", documentId)
      .is("revoked_at", null);
    if (!countErr && Array.isArray(unrevoked)) {
      liveLeft = (unrevoked as Array<{ expires_at: string | null }>)
        // An unparseable expiry counts as live (flagged, never hidden).
        .filter((r) => r.expires_at == null || !(Date.parse(r.expires_at) <= nowMs)).length;
    }
  } catch { /* unreadable → null: the record says the count is unknown */ }
  if (liveLeft !== 0) {
    console.error(`[retire] ${documentId}: ${liveLeft ?? "an unknown number of"} share link(s) are still live after the retirement — Document Control must revoke them.`);
  }
  return {
    revoked, liveLeft, error,
    auditError: auditFailures.length > 0 ? `${auditFailures.length} SHARE_LINK_REVOKED row(s) not written (${auditFailures.join("; ")})` : null,
  };
}

/** REV-11: the initial statuses a created document may be born with — a
 *  deliberate choice by the caller, never a default. */
export const CREATION_STATUSES = ["Draft", "Issued"] as const;
export type CreationStatus = (typeof CREATION_STATUSES)[number];

/** REV-15 / REV-17 / REV-18: which statuses ISSUE a revision, and which status
 *  changes make a document a controlled issue — lib/issueStatus.ts (pure, so
 *  the client status editors can ask it too). Re-exported here, where every
 *  creation door already imports them. */
export { WORK_IN_PROGRESS_STATUSES, isControlledIssueStatus, isIssueTransition, isRetiredStatus } from "@/lib/issueStatus";

/** REV-15: the compliance clocks a newly ISSUED document starts — the
 *  periodic-review clock and the read-&-understood roster its governing
 *  policies call for. The ONE call every creation door makes for an issued
 *  first revision (createDocumentWithFile, the split / merge sheets once
 *  their operation can no longer roll back, the library's bulk upload) —
 *  never a parallel path. A rev-up starts them through
 *  runPostPublishSideEffects instead.
 *
 *  It THROWS as onDocumentIssued throws (the review certification event
 *  could not be written — the roster is then not opened). Otherwise it
 *  RETURNS the write errors the two helpers report instead of throwing: the
 *  review-basis reset and the next_review_date write (onDocumentIssued), each
 *  roster write and a roster recompute that stopped on an error
 *  (onDocumentIssuedAck). Empty when every write answered without an error.
 *  A write the database filtered to zero rows answers no error and is not in
 *  the list.
 *  REV-19 (P14 review fix): `reviewClock: false` leaves the periodic-review
 *  clock exactly as it is (no onDocumentIssued: last_reviewed_at,
 *  next_review_date and the review history untouched) and opens only the
 *  roster — for a status-change issue the retirement stamp cannot place
 *  (recordStatusIssue). Every other caller omits it. */
export async function startIssuedDocumentClocks(input: {
  orgId: string; documentId: string; actorUserId: string; actorName?: string | null; reviewClock?: boolean;
}): Promise<string[]> {
  const writeErrors: string[] = [];
  // Seed the review clock so a new doc picks up any library/folder review cycle.
  if (input.reviewClock !== false) await onDocumentIssued({ orgId: input.orgId, documentId: input.documentId, userId: input.actorUserId, userName: input.actorName, writeErrors });
  // Open the read-&-understood roster if an ack policy covers this new doc.
  await onDocumentIssuedAck({ orgId: input.orgId, documentId: input.documentId, actorId: input.actorUserId, actorName: input.actorName, writeErrors });
  return writeErrors;
}

/** REV-11: the review policy that governs a NEW controlled document in this
 *  folder / library, and whether it may be issued without reviewers. The
 *  first issue of a document is outside the database's revision gate (RG-7),
 *  so creation paths that issue content decide here, and the decision is
 *  recorded with the creation (`recorded`, onto CREATED_FROM_SPLIT /
 *  CREATED_FROM_MERGE `reviewPolicy`, or returned to the caller):
 *   - `publisher_choice` / `none` issue;
 *   - `require` issues only for a CONTROLLER (Doc Control / Admin — the
 *     people who own the policy), and the record names them and says the
 *     required sign-off was not collected; anyone else is refused, with how
 *     to proceed (DEC-63 (P3 LIFECYCLE) §2) — that refusal is the finding's
 *     own bypass closed (an owner splitting past a mandatory review);
 *   - an unreadable policy refuses (RG-6: "couldn't read" is never "no
 *     policy"). */
export async function resolveCreationReviewGate(target: {
  libraryId: string; collectionId?: string | null; what: string;
  /** Who is issuing — asked only when the policy requires sign-off. */
  actor: { orgId: string; actorUserId: string; actorRole?: string };
}): Promise<{ mode: string; recorded: string }> {
  let control;
  try {
    control = await effectiveReviewControlForDocument({ reviewControl: null, collectionId: target.collectionId ?? null, libraryId: target.libraryId });
  } catch (e) {
    throw new Error(`Couldn't verify the review policy for ${target.what} — nothing was created: ${(e as Error).message}`);
  }
  const mode = control?.mode ?? "none";
  if (mode === "require") {
    const principal: Principal = await resolveActorPrincipal({
      uid: target.actor.actorUserId, orgId: target.actor.orgId, headlineRole: target.actor.actorRole,
    });
    if (!isControllerPrincipal(principal)) {
      throw new Error(
        `This library requires reviewer sign-off, so ${target.what} can't be issued unreviewed. ` +
        "Create it as a Draft and submit it for review, then retire the old document once it is approved — or ask Document Control, who may issue it and is recorded doing so.",
      );
    }
    return {
      mode,
      recorded:
        `require — issued WITHOUT the sign-off the policy requires, by controller ${target.actor.actorUserId} ` +
        "(Doc Control / Admin decision; a first issue is outside the database's revision gate, RG-7)",
    };
  }
  return {
    mode,
    recorded: mode === "publisher_choice"
      ? "publisher_choice — the publisher chose to issue directly by running this operation"
      : "none — the governing policy does not require sign-off",
  };
}

/** REV-11: may this actor put a NEW document's first revision into this
 *  folder / library? The population the publish guard reads on the first
 *  pointer write (NULL → version, an advancing write for every status) when
 *  the document has no owner of its own: a controller, a publisher on the
 *  library, or the folder / library's effective owner (asked of the
 *  database's own user_is_effective_owner with no document owner). An
 *  unreadable answer is "no". */
export async function canPutFirstRevisionInContainer(opts: {
  orgId: string; libraryId: string; collectionId?: string | null; actorUserId: string; actorRole?: string;
}): Promise<boolean> {
  const principal: Principal = await resolveActorPrincipal({ uid: opts.actorUserId, orgId: opts.orgId, headlineRole: opts.actorRole });
  if (await resolveCanControlLibrary(opts.libraryId, principal)) return true;
  const { data: owns, error: ownErr } = await supabase.rpc("user_is_effective_owner", {
    p_doc_owner: null, p_collection: opts.collectionId ?? null, p_library: opts.libraryId, p_uid: opts.actorUserId,
  });
  return !ownErr && owns === true;
}

/**
 * Create a BRAND-NEW document and attach its first version from an uploaded file.
 *
 * Distinct from revUpDocument (which publishes a new revision over an EXISTING
 * doc). Used by the "upload & link a drawing" flow and by output-template
 * filing.
 *
 * REV-11: the initial status is REQUIRED — "Draft" (filed for reference, not
 * a controlled copy; no compliance clocks) or "Issued" (a controlled first
 * revision). Issuing resolves the governing review policy first; the clocks
 * start only for an issued document. EVERY creation — a Draft too — is
 * checked for the authority the database's publish guard reads on the first
 * pointer write (NULL → version is advancing for every status): a controller,
 * a library publisher, or the folder / library owner. Asked BEFORE anything
 * is inserted, so a member without it is refused cleanly instead of leaving
 * a document row with no file that only a controller can delete.
 *
 * Review fix 3 (REV-11 / DEC-63 §2): the creation is RECORDED — a
 * DOCUMENT_CREATED audit row, written once the first pointer write has
 * landed, carries the initial status, the review policy decision (for a
 * controller issuing unreviewed in a require-mode library: that the required
 * sign-off was not collected, and by whom) and the actor. A refused audit
 * write is returned (`creationAuditError`), never dropped.
 */
export async function createDocumentWithFile(input: {
  orgId: string;
  libraryId: string;
  collectionId?: string | null;
  folderPath?: string[];
  documentNumber: string;
  title?: string;
  file: File;
  status: CreationStatus;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** GAP-314: false when the caller decodes its documents' unit codes itself,
   *  in one batched call (a door that creates many — the template filing). */
  decodeUnitCode?: boolean;
}): Promise<{ documentId: string; status: CreationStatus; reviewPolicy: string | null; creationAuditError: string | null }> {
  const now = new Date().toISOString();
  const docNum = input.documentNumber.trim();
  if (!docNum) throw new Error("A document number is required.");
  if (!(CREATION_STATUSES as readonly string[]).includes(input.status)) {
    throw new Error(`A new document is created as Draft or Issued — not "${String(input.status)}".`);
  }
  const title = input.title?.trim() || docNum;

  // Same authority population as a rev-up of a document in this library:
  // library publish authority, or effective ownership — which, for a
  // document with no owner of its own yet, is the folder / library owner
  // cascade (the rung the publish guard reads on the first pointer write).
  const authorized = await canPutFirstRevisionInContainer({
    orgId: input.orgId, libraryId: input.libraryId, collectionId: input.collectionId ?? null,
    actorUserId: input.actorUserId, actorRole: input.actorRole,
  });
  if (!authorized) {
    throw new Error(input.status === "Issued"
      ? "You don't have authority to issue controlled documents in this library — ask an Admin or Doc Control, or a publisher on this library."
      : "You don't have authority to add documents to this library (attaching a new document's file takes publish authority here, or ownership of the folder / library) — ask an Admin or Doc Control. Nothing was created.");
  }
  let reviewPolicy: string | null = null;
  let reviewPolicyMode: string | null = null;
  if (input.status === "Issued") {
    const gate = await resolveCreationReviewGate({
      libraryId: input.libraryId, collectionId: input.collectionId ?? null, what: `${docNum}`,
      actor: { orgId: input.orgId, actorUserId: input.actorUserId, actorRole: input.actorRole },
    });
    reviewPolicy = gate.recorded;
    reviewPolicyMode = gate.mode;
  }

  const { data: docRow, error: docErr } = await supabase
    .from("documents")
    .insert({
      org_id: input.orgId,
      library_id: input.libraryId,
      collection_id: input.collectionId ?? null,
      document_number: docNum,
      title,
      name: title,
      rev: "0",
      revision: "0",
      status: input.status,
      created_at: now,
      created_by: input.actorUserId,
      updated_at: now,
      updated_by: input.actorUserId,
    })
    .select("id")
    .single();
  if (docErr || !docRow) throw new Error(docErr?.message || "Failed to create document");
  const documentId = docRow.id as string;

  const fileHash = await sha256Hex(input.file);
  // PKG-3: salted per-upload name — a deterministic `Rev0_<name>` key let two
  // same-named documents share (and silently overwrite) one storage object.
  const storagePath = makeLibraryStoragePath({
    orgId: input.orgId,
    libraryId: input.libraryId,
    folderPath: input.folderPath,
    filename: uniqueUploadName(input.file.name, "0"),
  });
  const uploadResult = await uploadToPath(input.file, storagePath, { contentType: input.file.type });

  const { data: ver, error: verErr } = await supabase
    .from("document_versions")
    .insert({
      org_id: input.orgId,
      record_id: documentId,
      revision_label: "0",
      file_url: uploadResult.url,
      file_type: input.file.type || null,
      size: uploadResult.size,
      change_log: "Initial upload",
      created_by: input.actorUserId,
      created_by_name: input.actorEmail || input.actorUserId,
      created_at: now,
      released_at: now,
      file_hash: fileHash,
    })
    .select("id")
    .single();
  if (verErr || !ver) throw new Error(verErr?.message || "Failed to create the document's file version");

  // The first pointer write is checked: the publish guard refuses it for an
  // actor without authority, and a zero-row answer is a refusal too — a
  // document with no current file must never read as created.
  const { data: promoted, error: ptrErr } = await supabase
    .from("documents").update({ current_version_id: ver.id, updated_at: now }).eq("id", documentId).select("id");
  if (ptrErr || ((promoted as unknown[] | null) ?? []).length === 0) {
    throw new Error(`The document was created but its file could not be attached (${ptrErr?.message ?? "the write was refused"}) — ask Doc Control to remove ${docNum} or attach its file.`);
  }
  // REV-11 / DEC-63 §2: the creation — and, for an issue, the review policy
  // decision and who made it — is on the record (split / merge record theirs
  // on CREATED_FROM_SPLIT / CREATED_FROM_MERGE).
  const { error: creationAuditError } = await logAuditAction({
    action: "DOCUMENT_CREATED",
    resourceId: documentId,
    resourceType: "document",
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorEmail,
    userRole: input.actorRole,
    details: {
      versionId: ver.id,
      documentNumber: docNum,
      revisionLabel: "0",
      initialStatus: input.status,
      reviewPolicyMode,
      reviewPolicy,
      fileHash,
    },
  });
  if (input.status === "Issued") {
    // REV-15: the one clock-start path every creation door shares.
    await startIssuedDocumentClocks({ orgId: input.orgId, documentId, actorUserId: input.actorUserId, actorName: input.actorEmail });
  }
  // Seed retention state so a doc created AFTER a library/folder retention
  // policy exists is not invisible to the retention system.
  try { await recomputeRetention(documentId); } catch { /* best-effort */ }
  // GAP-314: the unit decode at create time (documents.unit_code, written by
  // the service role from the stored number) — best-effort, after the
  // creation is complete, and NOT awaited (P13 review fix): the creation is
  // done whatever the route does (the call is bounded besides). What it left
  // undone is logged; the route records a document it left without a code,
  // with why. A caller filing many documents passes decodeUnitCode: false
  // and decodes them in one call.
  if (input.decodeUnitCode !== false) {
    void requestUnitCodeDecode(input.orgId, [documentId], "upload").then((unitCode) => {
      if (unitCode.note) console.warn(`[createDocumentWithFile] ${unitCode.note}`);
    });
  }
  return { documentId, status: input.status, reviewPolicy, creationAuditError };
}

/** REV-18 (addendum 1; P13 review fix): would this rev-up ISSUE the document
 *  for the first time, and may THIS actor publish that issue directly?
 *  A first issue: the document has no current revision (a register row's
 *  first file — a CSV import) or its status is not one the app calls an
 *  issue (a Draft: every direct rev-up writes Issued). Under a policy that
 *  requires sign-off — read as the database reads it (DEC-71): the
 *  folder / library chain OR the document's own, so a document-level 'none'
 *  does not exempt it — only a controller publishes it unreviewed (DEC-63
 *  §2); anyone else must take it through review (`mustReview`), and the
 *  Minor / Correction hatch does not open it (effectiveModeForRevUp's
 *  `firstIssueMustReview`). Every rev-up door asks it BEFORE it writes
 *  anything: revUpDocument (refuses), RevUpModal and setLevelRevUp (route it
 *  to review), mergeDocuments' gate (refuses before a source is superseded).
 *  `requiresSignOff` says the policy requires it (a controller's direct
 *  first issue is then recorded as made without it). The live pointer,
 *  status and document policy are read here unless the caller has just read
 *  them. An unreadable policy THROWS (RG-6) — never
 *  "no policy". Nothing is written.
 *
 *  A RETIRED document (Superseded / Void / Archived — isRetiredStatus) is no
 *  first issue and no revision either (P13 second review fix): `retired` is
 *  set and nothing else is asked. A review of it could never be published
 *  (finalizeReviewedRevision refuses a retired document, REV-5) and a direct
 *  publish would bring it back to life as Issued, so every door refuses it
 *  up front with describeRetiredRevUp — restore it first.
 *
 *  `controllerOnly` (P13 final review fix): the chain requires sign-off and
 *  the document's OWN policy is 'none'. DEC-71 does not honour that
 *  'none' for a first issue, but submitForReview opens the roster from the
 *  policy that resolves for the document — its own 'none', so NO reviewers —
 *  and the in-review draft could never be published. So for a non-controller
 *  (never for a controller, who issues it directly) every door refuses it up
 *  front with describeControllerOnlyFirstIssue instead of routing it to a
 *  review that cannot complete; `mustReview` stays true (the actor still may
 *  not publish it unreviewed). */
export async function firstIssueGateForRevUp(opts: {
  doc: Pick<DocumentRecord, "id" | "collectionId" | "currentVersionId" | "status" | "reviewControl">;
  libraryId: string;
  actor: { orgId: string; actorUserId: string; actorRole?: string };
  live?: { current: string | null; status: string | null; reviewControl?: ReviewControl | null };
}): Promise<{ firstIssue: boolean; retired: boolean; hasCurrentRevision: boolean; status: string | null; requiresSignOff: boolean; mustReview: boolean; controllerOnly: boolean }> {
  let live = opts.live;
  if (!live) {
    const { data, error } = await supabase
      .from("documents").select("current_version_id, status, review_control").eq("id", opts.doc.id ?? "").maybeSingle();
    if (error) throw new Error(`Couldn't read the document's current state: ${error.message}`);
    live = data
      ? {
        current: (data.current_version_id as string | null) ?? null,
        status: (data.status as string | null) ?? null,
        reviewControl: (data.review_control as ReviewControl | null) ?? null,
      }
      : { current: opts.doc.currentVersionId ?? null, status: opts.doc.status ?? null };
  }
  const seen = { hasCurrentRevision: !!live.current, status: live.status, retired: false, controllerOnly: false };
  if (isRetiredStatus(live.status)) return { ...seen, retired: true, firstIssue: false, requiresSignOff: false, mustReview: false };
  if (live.current && isControlledIssueStatus(live.status)) return { ...seen, firstIssue: false, requiresSignOff: false, mustReview: false };
  const chain = await effectiveReviewControlForDocument({
    reviewControl: null, collectionId: opts.doc.collectionId ?? null, libraryId: opts.libraryId,
  });
  const own = live.reviewControl !== undefined ? live.reviewControl : (opts.doc.reviewControl ?? null);
  if (chain.mode !== "require" && own?.mode !== "require") return { ...seen, firstIssue: true, requiresSignOff: false, mustReview: false };
  const principal: Principal = await resolveActorPrincipal({
    uid: opts.actor.actorUserId, orgId: opts.actor.orgId, headlineRole: opts.actor.actorRole,
  });
  const controller = isControllerPrincipal(principal);
  return {
    ...seen, firstIssue: true, requiresSignOff: true, mustReview: !controller,
    controllerOnly: !controller && chain.mode === "require" && own?.mode === "none",
  };
}

/** REV-18 (P13 second review fix): the refusal of a rev-up of a RETIRED
 *  document, in one sentence every door uses (revUpDocument, submitForReview,
 *  RevUpModal, setLevelRevUp, mergeDocuments' gate) — never the first-issue
 *  wording ("is not issued yet"), which would be untrue of it. */
export function describeRetiredRevUp(label: string, status: string | null): string {
  return `${label} is ${(status ?? "").trim() || "retired"}, and a retired document isn't revised — a review of it could never be published, and publishing onto it would bring it back as Issued. ` +
    "Restore it first (un-archive it, or ask Document Control to un-void it or reverse the supersession), then publish the revision.";
}

/** REV-18 (P13 final review fix): the refusal of a first issue only a
 *  controller can make (firstIssueGateForRevUp's `controllerOnly`), in one
 *  sentence every door uses (revUpDocument, RevUpModal, setLevelRevUp,
 *  mergeDocuments' gate) — never "submit it for review", which would open a
 *  review with no reviewers. */
export function describeControllerOnlyFirstIssue(label: string): string {
  return `Only Document Control can issue ${label}: this library requires reviewer sign-off for its first issue, but its own review policy is none, so a review would have no reviewers and could never be published. ` +
    "Ask Document Control to issue it, or to change its review policy.";
}

/** REV-18: why a rev-up is a first issue, in one clause (the refusals of
 *  revUpDocument and mergeDocuments' gate both say it). */
export function describeFirstIssue(label: string, gate: { hasCurrentRevision: boolean; status: string | null; retired?: boolean }, revisionLabel?: string): string {
  const rev = revisionLabel?.trim() ? `Rev ${revisionLabel.trim()}` : "this revision";
  // a retired document is not "not issued yet" (P13 second review fix)
  if (gate.retired) return `${label} is ${(gate.status ?? "").trim() || "retired"} (retired), so ${rev} can't be published onto it until it is restored`;
  return gate.hasCurrentRevision
    ? `${label} is not issued yet (${gate.status || "Draft"}), so publishing ${rev} makes it a controlled issue for the first time`
    : `${label} has no current revision, so ${rev} would be its first controlled issue`;
}

export async function revUpDocument(input: RevUpInput): Promise<RevUpResult> {
  const {
    doc, libraryId, folderPath, file,
    revisionLabel, changeLog, issueType, changeType,
    drawnByName, checkedByName, approvedByName,
    mocReference, sourceFileName,
    orgId, actorUserId, actorEmail, actorRole,
  } = input;

  if (!doc.id) throw new Error("Document is missing an id");
  if (!revisionLabel.trim()) throw new Error("Revision label is required");
  if (!changeLog.trim()) throw new Error("Change narrative is required");
  if (input.asBranch && !input.branchReason?.trim()) {
    throw new Error("Publishing as a branch requires a reason");
  }

  // 0. Authorize BEFORE we upload anything: per-library publish authority
  //    (Admin/DocCtrl, granted "publish", or the doc's effective owner), and
  //    either own the lock / find it clear, or supply an override reason to
  //    publish over another user's checkout. Returns the pre-publish state so
  //    we know whose checkout (if any) to notify afterward. The RPC below
  //    re-checks lock/hold transactionally — this fails fast and cheap.
  const preState = await authorizePublish({
    documentId: doc.id, libraryId, orgId, actorUserId, actorRole,
    overrideReason: input.overrideReason, force: input.force,
  });
  const lockedByOther =
    !!preState.checkedOutBy && String(preState.checkedOutBy) !== String(actorUserId);
  // REV-18: the first-issue answer, kept for the REV_UP record (a branch
  // publish moves neither the pointer nor the status, so it is not asked).
  let firstIssue: Awaited<ReturnType<typeof firstIssueGateForRevUp>> | null = null;

  // 1. Resolve the base this work is built on + the provenance class.
  //    session    → actor holds an active checkout session on the doc
  //    declared   → no session, but a live edit intent or an explicit picker value
  //    unverified → nothing recorded and nothing declared
  const { data: mySession } = await supabase
    .from("checkout_sessions")
    .select("id")
    .eq("document_id", doc.id)
    .eq("user_id", actorUserId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  let expectedBase: string | null;
  let provenance: "session" | "declared" | "unverified";
  if (input.expectedBaseVersionId !== undefined) {
    expectedBase = input.expectedBaseVersionId;
    provenance = mySession ? "session" : "declared";
  } else {
    const intentBase = await getMyEditBase(doc.id, actorUserId);
    if (intentBase !== undefined) {
      expectedBase = intentBase;
      provenance = mySession ? "session" : "declared";
    } else {
      expectedBase = doc.currentVersionId ?? null;
      provenance = mySession ? "session" : "unverified";
    }
  }

  // 1b. PRE-FLIGHT the base check before spending an upload: if the doc has
  //     visibly moved past the declared base, fail now with the same conflict
  //     screen — no orphaned object in storage per conflict. The RPC still
  //     re-checks transactionally (this is an optimization, not the guard).
  if (!input.asBranch) {
    const label = doc.documentNumber || doc.title || "this document";
    // P13 final review fix: this read feeds the first-issue and retired
    // refusals below, so it fails CLOSED like the gate's own read — an error,
    // or no row (deleted, or no longer visible), refuses before anything is
    // uploaded; never the caller's cached row.
    const { data: freshDoc, error: freshErr } = await supabase
      .from("documents").select("current_version_id, status, review_control").eq("id", doc.id).maybeSingle();
    if (freshErr) throw new Error(`Couldn't verify the review policy for ${label} — nothing was uploaded or published: ${freshErr.message}`);
    if (!freshDoc) throw new Error(`Couldn't verify the review policy for ${label} — nothing was uploaded or published: the document was not found.`);
    const liveCurrent = (freshDoc.current_version_id as string | null) ?? null;
    // REV-18 (addendum 1): a rev-up that makes the document a controlled
    // issue for the FIRST time — its first file (no current revision: a
    // register row, e.g. a CSV import) or the publish of a document whose
    // status is not an issue (a Draft: this publish writes Issued) — is a
    // first issue, not a revision through the review gate, so the Minor /
    // Correction escape hatch (effectiveModeForRevUp) does not open it. The
    // creation gate is asked here, before anything is uploaded, so the
    // refusal comes in this flow's words (the database refuses the same
    // write: 20261139 for a first pointer, 20261144 for an issue).
    const live = {
      current: liveCurrent,
      status: (freshDoc.status as string | null) ?? null,
      reviewControl: (freshDoc.review_control as ReviewControl | null) ?? null,
    };
    if (liveCurrent !== expectedBase) {
      const { data: cur } = liveCurrent
        ? await supabase.from("document_versions")
            .select("id, revision_label, created_by, created_by_name, created_at, change_log")
            .eq("id", liveCurrent).maybeSingle()
        : { data: null };
      const c = cur as Record<string, unknown> | null;
      throw new StaleBaseError({
        currentVersionId: (c?.id as string | null) ?? liveCurrent,
        currentRev: (c?.revision_label as string | null) ?? null,
        currentBy: (c?.created_by as string | null) ?? null,
        currentByName: (c?.created_by_name as string | null) ?? null,
        currentAt: (c?.created_at as string | null) ?? null,
        currentChangeLog: (c?.change_log as string | null) ?? null,
      });
    }
    let gate: Awaited<ReturnType<typeof firstIssueGateForRevUp>>;
    try {
      gate = await firstIssueGateForRevUp({ doc, libraryId, actor: { orgId, actorUserId, actorRole }, live });
    } catch (e) {
      throw new Error(`Couldn't verify the review policy for ${label} — nothing was uploaded or published: ${(e as Error).message}`);
    }
    firstIssue = gate;
    // P13 second review fix: a retired document is not revised (restore it first).
    if (gate.retired) throw new Error(`${describeRetiredRevUp(label, gate.status)} Nothing was uploaded.`);
    // P13 final review fix: a review of it would have no reviewers.
    if (gate.controllerOnly) throw new Error(`${describeControllerOnlyFirstIssue(label)} Nothing was uploaded.`);
    if (gate.mustReview) {
      throw new Error(
        `This library requires reviewer sign-off, and ${describeFirstIssue(label, gate, revisionLabel)} — a first issue is not a revision through the review gate, so a Minor or Correction change doesn't exempt it. ` +
        "Nothing was uploaded. Choose Major and submit it for review, or ask Document Control, who may issue it.",
      );
    }
  }

  // 2. Hash + upload the PDF (and the optional CAD source) to revision-scoped
  //    paths. The previous files remain intact and readable.
  const fileHash = await sha256Hex(file);
  const safeRev = revisionLabel.trim().replace(/[^\w.\-]+/g, "_");
  const stem = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop() || "pdf";
  const versionedName = `${stem}__rev${safeRev}__${Date.now()}.${ext}`;

  const storagePath = makeLibraryStoragePath({
    orgId, libraryId, folderPath, filename: versionedName,
  });
  const uploadResult = await uploadToPath(file, storagePath, {
    contentType: file.type || undefined,
  });

  let sourceFileKey: string | null = null;
  let effectiveSourceFileName = sourceFileName?.trim() || null;
  if (input.sourceFile) {
    const srcStem = input.sourceFile.name.replace(/\.[^.]+$/, "");
    const srcExt = input.sourceFile.name.split(".").pop() || "dwg";
    const srcName = `${srcStem}__rev${safeRev}__source__${Date.now()}.${srcExt}`;
    const srcPath = makeLibraryStoragePath({
      orgId, libraryId, folderPath, filename: srcName,
    });
    const srcUpload = await uploadToPath(input.sourceFile, srcPath, {
      contentType: input.sourceFile.type || "application/octet-stream",
    });
    sourceFileKey = srcUpload.url;
    effectiveSourceFileName = effectiveSourceFileName ?? input.sourceFile.name;
  }

  const versionPayload = {
    revision_label: revisionLabel.trim(),
    issue_type: issueType ?? null,
    change_type: changeType ?? null,
    file_url: uploadResult.url,
    file_type: file.type || "application/octet-stream",
    size: uploadResult.size,
    change_log: changeLog.trim(),
    created_by_name: actorEmail || actorUserId,
    drawn_by_name: drawnByName?.trim() || null,
    checked_by_name: checkedByName?.trim() || null,
    approved_by_name: approvedByName?.trim() || null,
    moc_reference: mocReference?.trim() || null,
    source_file_name: effectiveSourceFileName,
    source_file_key: sourceFileKey,
    file_hash: fileHash,
    provenance,
    related_ticket_id: input.relatedTicketId ?? null,
  };

  // 3. THE PUBLISH CONTRACT. One transaction, serialized per document by a
  //    row lock. A stale base writes NOTHING and comes back as a structured
  //    status the UI turns into the conflict screen.
  let result: RevUpResult;
  {
    const { data, error } = await callPublishRevisionRpc({
      p_doc: doc.id,
      p_expected_base: expectedBase,
      p_op_class: "content",
      p_version: versionPayload,
      p_actor: actorUserId,
      p_actor_name: actorEmail || actorUserId,
      p_force: input.force === true,
      p_override_lock: lockedByOther,
      // DCK-8: the override is asserted WITH its reason; the database refuses
      // a blank one and records the override itself (20261130).
      ...(lockedByOther ? { p_override_reason: input.overrideReason?.trim() || null } : {}),
      p_as_branch: input.asBranch === true,
      p_branch_reason: input.branchReason?.trim() || null,
      p_new_status: "Issued",
    });
    if (error) {
      throw new Error(error.message);
    } else {
      const res = data as Record<string, unknown>;
      const status = res?.status as string;
      if (status === "stale_base") {
        // The contract just prevented a silent overwrite — that's the whole
        // point of the system, so it goes on the record (and powers the
        // "protection record" counters).
        void logAuditAction({
          action: "REV_CONFLICT_BLOCKED",
          resourceId: doc.id,
          resourceType: "document",
          orgId,
          userId: actorUserId,
          userEmail: actorEmail,
          userRole: actorRole,
          details: {
            attemptedRev: revisionLabel.trim(),
            attemptedBase: expectedBase,
            currentVersionId: (res.current_version_id as string | null) ?? null,
            currentRev: (res.current_rev as string | null) ?? null,
            currentByName: (res.current_by_name as string | null) ?? null,
          },
        });
        throw new StaleBaseError({
          currentVersionId: (res.current_version_id as string | null) ?? null,
          currentRev: (res.current_rev as string | null) ?? null,
          currentBy: (res.current_by as string | null) ?? null,
          currentByName: (res.current_by_name as string | null) ?? null,
          currentAt: (res.current_at as string | null) ?? null,
          currentChangeLog: (res.current_change_log as string | null) ?? null,
        });
      }
      if (status === "duplicate_label") {
        throw new DuplicateLabelError((res.label as string) ?? revisionLabel.trim());
      }
      if (status === "locked_by_other") {
        throw new DocumentMutationBlockedError({
          ok: false,
          code: "locked_by_other",
          message: `This document is checked out by ${(res.holder_name as string) || "another user"}. Ask them to check in — or force-unlock it — before publishing a new revision.`,
        });
      }
      if (status === "on_hold") {
        throw new DocumentMutationBlockedError({
          ok: false,
          code: "on_hold",
          message: "This document has an active hold. Release it before publishing a new revision.",
        });
      }
      const versionRow = res.version as Record<string, unknown>;
      result = {
        newVersion: rowToVersion(versionRow),
        supersededVersionId: (res.superseded_version_id as string | null) ?? null,
        branched: status === "branched",
        branchId: (res.branch_id as string | null) ?? null,
      };
    }
  }

  const { newVersion, supersededVersionId, branched, branchId } = result;

  // 3c. A direct (non-branch) publish supersedes any in-review draft: clear
  //     the pending pointer and void the draft's roster, so a stale draft can
  //     never be finalized OVER this newer revision. REV-6: every write is
  //     checked; the publish has committed, so a failure is put on the REV_UP
  //     record (and logged) instead of being swallowed. A BRANCH publish
  //     leaves the draft alone on purpose: the controlled copy did not move,
  //     so the draft's base is still the current revision.
  let draftVoid: PendingDraftVoid = { voidedVersionId: null, problem: null };
  if (!branched) {
    draftVoid = await voidPendingDraftAfterPublish(doc.id, actorUserId);

    // Effective date — denormalize onto the version + document (future dates
    // get a badge + a "now in effect" notice when they arrive). Best-effort:
    // a hiccup here must not skip the audit row below.
    try {
      await applyEffectiveDate({ documentId: doc.id, versionId: newVersion.id ?? "", effectiveDate: input.effectiveDate ?? null });
    } catch { /* best-effort */ }
  }

  // 4. Audit row — captures everything needed to reconstruct the change.
  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: newVersion.id ?? "",
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: branched ? "REV_BRANCH" : "REV_UP",
    details: {
      previousRev: doc.rev ?? null,
      newRev: revisionLabel.trim(),
      previousVersionId: supersededVersionId,
      expectedBaseVersionId: expectedBase,
      provenance,
      branched: branched === true,
      branchId: branchId ?? null,
      branchReason: input.branchReason?.trim() || null,
      narrative: changeLog.trim(),
      issueType: issueType ?? null,
      changeType: changeType ?? null,
      mocReference: mocReference?.trim() || null,
      sourceFileName: effectiveSourceFileName,
      sourceFileKey,
      fileHash,
      drawnByName: drawnByName?.trim() || null,
      checkedByName: checkedByName?.trim() || null,
      approvedByName: approvedByName?.trim() || null,
      relatedTicketId: input.relatedTicketId ?? null,
      pendingDraftVoided: draftVoid.voidedVersionId,
      pendingDraftVoidProblem: draftVoid.problem,
      // REV-18 / DEC-63 §2 (P13 second review fix): a controller's direct
      // FIRST issue under a policy that requires sign-off is admitted — and
      // recorded as such, as the merge door records it, so it is never read
      // as an ordinary Minor revision.
      ...(!branched && firstIssue?.firstIssue && firstIssue.requiresSignOff && !firstIssue.mustReview
        ? {
          reviewPolicy: `require — Rev ${revisionLabel.trim()} is ${doc.documentNumber || doc.title || "the document"}'s FIRST controlled issue, published WITHOUT the sign-off the policy requires, by controller ${actorUserId} (DEC-63 §2)`,
          firstIssueWithoutSignOff: true,
        }
        : {}),
    },
  });

  // 5. Tell the people this actually affects (personal interrupts only —
  //    holders of live intents on the doc, watchers via emit's follower
  //    resolution). Fire-and-forget; a notify failure never fails a publish.
  const docLabel = doc.documentNumber || doc.title || doc.name || "document";
  if (branched && branchId) {
    let divergedAuthor: string | null = null;
    if (supersededVersionId || doc.currentVersionId) {
      const { data: cur } = await supabase
        .from("document_versions")
        .select("created_by")
        .eq("id", doc.currentVersionId ?? "")
        .maybeSingle();
      divergedAuthor = ((cur as { created_by?: string } | null)?.created_by) ?? null;
    }
    void announceBranchOpened({
      orgId,
      documentId: doc.id,
      documentLabel: String(docLabel),
      libraryId,
      branchId,
      reason: input.branchReason?.trim() || "",
      actorUserId,
      actorName: actorEmail || actorUserId,
      divergedFromAuthorId: divergedAuthor,
      divergedFromRev: doc.rev ?? null,
    });
  } else if (!branched) {
    // Shared pipeline: stale-copy signal, package pin-drift alerts, and the
    // compliance clocks — identical to every other path that changes the
    // current revision (finalize-after-review, revert).
    void runPostPublishSideEffects({
      orgId, documentId: doc.id, libraryId,
      docLabel: String(docLabel),
      newRev: revisionLabel.trim(),
      actorUserId, actorName: actorEmail || actorUserId, actorEmail,
    });
  }

  // 5b. Gentle author feedback when the publish landed UNVERIFIED: the one
  //     person who can change the pattern is the publisher, and shaming is
  //     off the table — so tell them privately, kindly, with the fix.
  if (provenance === "unverified") {
    void notify({
      orgId,
      userId: actorUserId,
      kind: "provenance_flag",
      title: `Rev ${revisionLabel.trim()} published without a work trail`,
      body: "It went through fine — but there was no checkout or recorded download behind it, so Document Control will double-check the base with you. Next time, one click on Quick hold (⚡) before you start covers it.",
      link: `/documents/${libraryId}?doc=${doc.id}`,
      resourceType: "document",
      resourceId: doc.id,
      actorName: "System",
    });
  }

  // 5c. If we published over another user's checkout, leave it open but note
  //     what happened on their episode and notify them with a link to the new
  //     revision.
  await noteOverrideOnHolder({
    preState, documentId: doc.id, libraryId, orgId, actorUserId, actorEmail,
    revisionLabel: revisionLabel.trim(), changeNarrative: changeLog.trim(),
    overrideReason: input.overrideReason, newVersionId: newVersion.id ?? null,
  });

  // 6. The publisher's own edit intent now anchors to the NEW revision.
  void recordIntent({
    orgId, documentId: doc.id, libraryId,
    userId: actorUserId, userName: actorEmail || actorUserId,
    kind: "edit", source: "declared",
    baseVersionId: newVersion.id,
  });

  return result;
}

/**
 * Submit a revision FOR REVIEW instead of publishing it (the require-review /
 * publisher-chose path). Uploads the file and creates an in-review DRAFT version
 * labeled with a letter suffix (e.g. "2A") WITHOUT touching the live controlled
 * rev — everyone keeps seeing the current published copy. A reviewer roster is
 * opened; the draft only becomes the controlled "Rev 2" once reviewers sign off
 * (see finalizeReviewedRevision in lib/reviewControl.ts). Resubmitting bumps the
 * letter (2A -> 2B) and voids the prior sign-offs.
 */
export async function submitForReview(input: RevUpInput): Promise<{ versionId: string; revisionLabel: string }> {
  const {
    doc, libraryId, folderPath, file, revisionLabel, changeLog, issueType, changeType,
    drawnByName, checkedByName, approvedByName, mocReference, sourceFileName,
    orgId, actorUserId, actorEmail, actorRole,
  } = input;

  if (!doc.id) throw new Error("Document is missing an id");
  if (!changeLog.trim()) throw new Error("Change narrative is required");

  // Same authority as a publish — you can't open a controlled review unless you
  // could publish here (an effective owner qualifies).
  await authorizePublish({ documentId: doc.id, libraryId, orgId, actorUserId, actorRole, overrideReason: input.overrideReason, operation: "submit for review" });

  // Base numeric target + letter label. If a draft is already in review, bump its
  // letter (2A -> 2B).
  const { data: docRow } = await supabase.from("documents").select("pending_version_id, rev, current_version_id, status").eq("id", doc.id).maybeSingle();
  // REV-18 (P13 second review fix): a review of a RETIRED document could
  // never be published (finalizeReviewedRevision refuses it, REV-5) — the
  // draft would be stranded. Refused before anything is uploaded.
  const liveStatus = docRow ? ((docRow.status as string | null | undefined) ?? null) : (doc.status ?? null);
  if (isRetiredStatus(liveStatus)) {
    throw new Error(`${describeRetiredRevUp(doc.documentNumber || doc.title || "This document", liveStatus)} Nothing was uploaded or submitted.`);
  }
  const existingPendingId = (docRow?.pending_version_id as string | null) ?? null;
  let existingLabel: string | null = null;
  if (existingPendingId) {
    const { data: pv } = await supabase.from("document_versions").select("revision_label").eq("id", existingPendingId).maybeSingle();
    existingLabel = (pv?.revision_label as string) ?? null;
  }
  const baseRev = (revisionLabel?.trim() || suggestRevLabel((docRow?.rev as string) ?? doc.rev)).trim();
  const draftLabel = letterLabelFor(baseRev, existingLabel);

  const fileHash = await sha256Hex(file);
  const safeRev = draftLabel.replace(/[^\w.\-]+/g, "_");
  const stem = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop() || "pdf";
  const versionedName = `${stem}__rev${safeRev}__${Date.now()}.${ext}`;
  const storagePath = makeLibraryStoragePath({ orgId, libraryId, folderPath, filename: versionedName });
  const uploadResult = await uploadToPath(file, storagePath, { contentType: file.type || undefined });

  const now = new Date().toISOString();
  const liveVersionId = (docRow?.current_version_id as string | null) ?? doc.currentVersionId ?? null;

  const { data: insertedRow, error: insertErr } = await supabase
    .from("document_versions")
    .insert({
      org_id: orgId, record_id: doc.id,
      revision_label: draftLabel, base_rev: baseRev, review_state: "in_review",
      issue_type: issueType ?? "Internal Review", change_type: changeType ?? null,
      file_url: uploadResult.url, file_type: file.type || "application/octet-stream", size: uploadResult.size,
      change_log: changeLog.trim(), created_by: actorUserId, created_by_name: actorEmail || actorUserId, created_at: now,
      supersedes_version_id: liveVersionId,
      drawn_by_name: drawnByName?.trim() || null, checked_by_name: checkedByName?.trim() || null, approved_by_name: approvedByName?.trim() || null,
      moc_reference: mocReference?.trim() || null, source_file_name: sourceFileName?.trim() || null, file_hash: fileHash,
      related_ticket_id: input.relatedTicketId ?? null,
      effective_date: input.effectiveDate ? input.effectiveDate.slice(0, 10) : null,
      // No released_at — an in-review draft isn't released until it's approved.
    })
    .select("*")
    .single();
  if (insertErr || !insertedRow) throw new Error(insertErr?.message || "Failed to create the in-review draft");

  // Move the pending pointer only; the live controlled rev is untouched.
  // COMPARE-AND-SET on the pending pointer we read above: a double-click (or
  // two publishers racing) must not create two live drafts each with a full
  // reviewer roster. The loser's insert is superseded immediately.
  let pointerQuery = supabase.from("documents")
    .update({ pending_version_id: insertedRow.id, updated_at: now, updated_by: actorUserId })
    .eq("id", doc.id);
  pointerQuery = existingPendingId
    ? pointerQuery.eq("pending_version_id", existingPendingId)
    : pointerQuery.is("pending_version_id", null);
  const { data: pointerRows, error: pointerErr } = await pointerQuery.select("id");
  if (pointerErr) throw new Error(pointerErr.message);
  if (((pointerRows as unknown[]) ?? []).length === 0) {
    // Someone else won the race — retire our just-inserted draft and stop.
    await supabase.from("document_versions").update({ superseded_at: now }).eq("id", insertedRow.id);
    throw new Error("Another submission for review just landed on this document — refresh to see it.");
  }

  // Resubmit: supersede the prior draft + void its sign-offs (re-review needed).
  if (existingPendingId && existingPendingId !== insertedRow.id) {
    await supabase.from("document_versions").update({ superseded_at: now }).eq("id", existingPendingId);
    await invalidateDraftSignoffs({ orgId, documentId: doc.id, libraryId, oldVersionId: existingPendingId, newRevisionLabel: draftLabel });
  }

  await logRevisionEvent({
    orgId, documentId: doc.id, versionId: insertedRow.id as string, userId: actorUserId, userEmail: actorEmail ?? "", userRole: actorRole ?? "",
    type: "SUBMIT_FOR_REVIEW",
    details: { draftLabel, baseRev, narrative: changeLog.trim(), fileHash, resubmit: !!existingPendingId },
  });

  const control = await effectiveReviewControlForDocument({ reviewControl: doc.reviewControl ?? null, collectionId: doc.collectionId ?? null, libraryId });
  await openReviewRoster({
    orgId, documentId: doc.id, libraryId, versionId: insertedRow.id as string,
    revisionLabel: draftLabel, contentHash: fileHash, control, actorId: actorUserId, actorName: actorEmail,
  });

  return { versionId: insertedRow.id as string, revisionLabel: draftLabel };
}

/** Map a Supabase row to the TS interface. Exposed so other panels can reuse. */
export function rowToVersion(r: Record<string, unknown>): DocumentVersion {
  return {
    id: r.id as string,
    orgId: r.org_id as string | undefined,
    recordId: r.record_id as string,
    revisionLabel: r.revision_label as string,
    issueType: r.issue_type as DocumentVersion["issueType"],
    changeType: r.change_type as DocumentVersion["changeType"],
    fileUrl: r.file_url as string,
    fileType: r.file_type as string | undefined,
    size: r.size as number | undefined,
    isFlattened: r.is_flattened as boolean | undefined,
    hasWatermark: r.has_watermark as boolean | undefined,
    watermarkPolicyId: r.watermark_policy_id as string | undefined,
    downloadPolicy: r.download_policy as DocumentVersion["downloadPolicy"],
    changeLog: r.change_log as string | undefined,
    relatedTicketId: r.related_ticket_id as string | undefined,
    createdBy: r.created_by as string,
    createdByName: r.created_by_name as string | undefined,
    createdAt: r.created_at as unknown as DocumentVersion["createdAt"],
    approvedBy: r.approved_by as string | undefined,
    supersedesVersionId: r.supersedes_version_id as string | undefined,
    drawnBy: r.drawn_by as string | undefined,
    drawnByName: r.drawn_by_name as string | undefined,
    checkedBy: r.checked_by as string | undefined,
    checkedByName: r.checked_by_name as string | undefined,
    approvedByName: r.approved_by_name as string | undefined,
    approvedAt: r.approved_at as unknown as DocumentVersion["approvedAt"],
    releasedAt: r.released_at as unknown as DocumentVersion["releasedAt"],
    supersededAt: r.superseded_at as unknown as DocumentVersion["supersededAt"],
    mocReference: r.moc_reference as string | undefined,
    sourceFileName: r.source_file_name as string | undefined,
    revertedFromVersionId: r.reverted_from_version_id as string | undefined,
    fileHash: r.file_hash as string | undefined,
    isBranch: (r.is_branch as boolean | undefined) ?? undefined,
    publishedBaseVersionId: r.published_base_version_id as string | undefined,
    provenance: r.provenance as DocumentVersion["provenance"],
    provenanceVerifiedAt: r.provenance_verified_at as unknown as DocumentVersion["provenanceVerifiedAt"],
    provenanceVerifiedBy: r.provenance_verified_by as string | undefined,
    sourceFileKey: r.source_file_key as string | undefined,
    reviewState: r.review_state as DocumentVersion["reviewState"],
    baseRev: r.base_rev as string | null | undefined,
  };
}

/** List every version of a document, newest first. */
export async function listVersions(documentId: string): Promise<DocumentVersion[]> {
  const { data, error } = await supabase
    .from("document_versions")
    .select("*")
    .eq("record_id", documentId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToVersion);
}

// ─── REVISION LABEL CORRECTION ────────────────────────────────────────────
// Fixing a mislabel after the fact ("uploaded as Rev 0, the stamp actually
// reads Rev 38") is a controlled correction, not a rewrite: it needs the same
// authority as publishing in the library (or effective ownership of the doc),
// the label must stay unique within the document's chain, in-review drafts
// are off limits (the review workflow owns their letter labels), and the
// audit log records old → new, who, and why.

export type RevLabelCheckInput = {
  newLabel: string;
  currentLabel: string;
  /** Labels of every OTHER version in this document's chain. */
  siblingLabels: string[];
  reviewState?: string | null;
};

/** Pure validation for a label correction — unit-testable without a DB. */
export function checkRevLabelCorrection(input: RevLabelCheckInput):
  { ok: true; label: string } | { ok: false; reason: string } {
  const label = input.newLabel.trim();
  if (!label) return { ok: false, reason: "Revision label can't be blank." };
  if (label.length > 24) return { ok: false, reason: "Revision label is too long (24 characters max)." };
  if (input.reviewState === "in_review") {
    return { ok: false, reason: "This revision is an in-review draft — its label is managed by the review workflow." };
  }
  if (label === input.currentLabel.trim()) {
    return { ok: false, reason: "That's already this revision's label." };
  }
  const clash = input.siblingLabels.some((l) => (l ?? "").trim().toLowerCase() === label.toLowerCase());
  if (clash) return { ok: false, reason: `Rev "${label}" is already used by another revision of this document.` };
  return { ok: true, label };
}

export type CorrectRevLabelInput = {
  doc: DocumentRecord;
  versionId: string;
  newLabel: string;
  /** Why the label is being corrected — recorded in the audit trail. */
  reason?: string;
  libraryId: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
};

/**
 * Correct the revision label on one version row. When that version is the
 * document's CURRENT revision, the parent document's `rev`/`revision` labels
 * are synced in the same operation so the list, register, and inspector all
 * agree. Blocked while a review draft is in flight against the current rev
 * (the draft's derived labels would be stranded).
 */
export async function correctRevisionLabel(input: CorrectRevLabelInput):
  Promise<{ oldLabel: string; newLabel: string; syncedCurrent: boolean }> {
  const { doc, versionId, libraryId, orgId, actorUserId, actorEmail, actorRole } = input;
  if (!doc.id) throw new Error("Document id missing.");

  // Same authority population as publish/revert: per-library control, or
  // effective ownership of this document.
  const principal: Principal = await resolveActorPrincipal({ uid: actorUserId, orgId, headlineRole: actorRole });
  let authorized = await resolveCanControlLibrary(libraryId, principal);
  if (!authorized) authorized = await isEffectiveOwnerOfDocument(doc.id, actorUserId);
  if (!authorized) {
    throw new Error("You don't have authority to correct revision labels here. Ask an Admin or Doc Control.");
  }
  // HLD-1: a held document's revision label is what every hold card printed —
  // it does not move until the hold is released (the shared gate; fails
  // closed on an unreadable hold set). 20261074 holds the same rule at the
  // database for non-controllers.
  await assertNotOnHold(doc.id, { action: "correcting its revision label" });

  // One read gets the target's fresh state AND the sibling labels for the
  // uniqueness check.
  const { data: rows, error: qErr } = await supabase
    .from("document_versions")
    .select("id, revision_label, review_state")
    .eq("record_id", doc.id);
  if (qErr) throw new Error(qErr.message);
  const target = (rows ?? []).find((r) => r.id === versionId);
  if (!target) throw new Error("Revision not found on this document.");

  const check = checkRevLabelCorrection({
    newLabel: input.newLabel,
    currentLabel: (target.revision_label as string) ?? "",
    siblingLabels: (rows ?? []).filter((r) => r.id !== versionId).map((r) => (r.revision_label as string) ?? ""),
    reviewState: (target.review_state as string | null) ?? null,
  });
  if (!check.ok) throw new Error(check.reason);

  const isCurrent = doc.currentVersionId === versionId;
  if (isCurrent) {
    const { data: d } = await supabase
      .from("documents").select("pending_version_id").eq("id", doc.id).maybeSingle();
    if (d?.pending_version_id) {
      throw new Error("This document has a revision in review. Publish or void that draft first — its review labels are derived from the current rev.");
    }
  }

  const oldLabel = (target.revision_label as string) ?? "";
  // OWN-17/EGRESS-6: a zero-row refusal (the shape an RLS denial takes) must
  // not read as a corrected label.
  const { data: corrected, error: upErr } = await supabase
    .from("document_versions")
    .update({ revision_label: check.label })
    .eq("id", versionId)
    .select("id");
  if (upErr) throw new Error(upErr.message);
  if (!corrected || corrected.length === 0) {
    throw new Error("The label was NOT corrected — you don't have authority over this revision.");
  }

  // Keep the parent document's label in step when the corrected rev is current.
  let syncedCurrent = false;
  if (isCurrent) {
    const { error: docErr } = await supabase
      .from("documents")
      .update({ rev: check.label, revision: check.label, updated_at: new Date().toISOString(), updated_by: actorUserId })
      .eq("id", doc.id);
    if (docErr) {
      throw new Error(`The revision was corrected, but the document row failed to sync: ${docErr.message}. Re-run the correction or fix the document label via Metadata.`);
    }
    syncedCurrent = true;
  }

  await logRevisionEvent({
    orgId, documentId: doc.id, versionId, userId: actorUserId,
    userEmail: actorEmail ?? "", userRole: actorRole ?? "",
    type: "REV_LABEL_CORRECTED",
    details: { oldLabel, newLabel: check.label, reason: input.reason?.trim() || null, syncedCurrent },
  });

  return { oldLabel, newLabel: check.label, syncedCurrent };
}

// ─── REVERT ───────────────────────────────────────────────────────────────
// Rolling back to a previous version is never a silent flip of
// current_version_id. We create a brand-new version row that COPIES the file
// payload of the chosen old version, sets reverted_from_version_id, and goes
// through the same supersedes_version_id chain as any other rev-up. The audit
// log gets a REVERT entry with the reason and (optional) MOC. The result is
// that the version history can always be replayed forward — no rewrites.

export type RevertInput = {
  doc: DocumentRecord;
  libraryId: string;                  // scopes the per-library publish-authority check
  targetVersion: DocumentVersion;     // the older version we're reverting to
  reason: string;                     // required free text
  mocReference?: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** Controllers (Admin/DocCtrl) may force past a foreign lock or active hold. */
  force?: boolean;
  /** Required when reverting a doc someone else has checked out. */
  overrideReason?: string;
};

export async function revertToVersion(input: RevertInput): Promise<DocumentVersion> {
  const { doc, libraryId, targetVersion, reason, mocReference, orgId, actorUserId, actorEmail, actorRole } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (!targetVersion.id) throw new Error("Target version is missing an id");
  if (!reason.trim()) throw new Error("Revert reason is required");

  // REV-2: only a previously-issued revision can be restored — an in-review/
  // rejected draft or an unreconciled branch must never become the controlled
  // copy through revert (the DB review gate can't see it: the fresh revert
  // row has no roster). The RPC enforces the same rule (20261034).
  assertRevertableTarget(targetVersion);

  // Same invariants as a rev-up: only an authorized publisher for this library
  // (or the doc's effective owner), and either own/clear lock or an override
  // reason for a foreign checkout.
  const preState = await authorizePublish({
    documentId: doc.id, libraryId, orgId, actorUserId, actorRole,
    overrideReason: input.overrideReason, force: input.force,
  });
  const lockedByOther =
    !!preState.checkedOutBy && String(preState.checkedOutBy) !== String(actorUserId);

  const previousVersionId = doc.currentVersionId ?? null;

  // The new version row reuses the target version's file_url. We deliberately
  // do NOT copy the file in storage — the new row points to the same bytes the
  // older row points to. file_hash carries forward so integrity verification
  // still works. If you want a literal file copy later, we can add that.
  //
  // REV-3: a revert is a NEW forward revision that restores older content —
  // its label advances the document's own scheme like any other publish. The
  // old `<label>-revert-<epoch-millis>` machine string became the controlled
  // revision identifier on every print footer, filename, register row and
  // title-block comparison; the revert itself is already on the record via
  // reverted_from_version_id and the change log. (A current rev carrying the
  // legacy machine suffix is first stripped back to its base label.)
  const baseRev = (doc.rev ?? targetVersion.revisionLabel ?? "0").replace(/-revert-\d+$/, "");
  const revertedLabel = suggestNextRevisionLabel(baseRev);

  const revertPayload = {
    revision_label: revertedLabel,
    issue_type: targetVersion.issueType ?? null,
    change_type: "Correction",
    file_url: targetVersion.fileUrl,
    file_type: targetVersion.fileType ?? null,
    size: targetVersion.size ?? null,
    change_log: `REVERT to Rev ${targetVersion.revisionLabel}: ${reason.trim()}`,
    created_by_name: actorEmail || actorUserId,
    moc_reference: mocReference?.trim() || null,
    reverted_from_version_id: targetVersion.id,
    file_hash: targetVersion.fileHash ?? null,
    provenance: "declared",
  };

  let insertedRow: Record<string, unknown>;

  // Same contract as a rev-up: the revert must be built on the revision the
  // actor is looking at. If the doc moved since their screen loaded, they get
  // the stale-base conflict instead of silently reverting away someone's work.
  // REV-8: there is no legacy fallback — the old one had no base check at
  // all, the sharpest instance of the unguarded path. No contract, no revert.
  {
    const { data, error } = await callPublishRevisionRpc({
      p_doc: doc.id,
      p_expected_base: previousVersionId,
      p_op_class: "content",
      p_version: revertPayload,
      p_actor: actorUserId,
      p_actor_name: actorEmail || actorUserId,
      p_force: input.force === true,
      p_override_lock: lockedByOther,
      ...(lockedByOther ? { p_override_reason: input.overrideReason?.trim() || null } : {}),
      p_as_branch: false,
      p_branch_reason: null,
      p_new_status: "Issued",
    });
    if (error) throw new Error(error.message);
    const res = data as Record<string, unknown>;
    const status = res?.status as string;
    if (status === "stale_base") {
      throw new StaleBaseError({
        currentVersionId: (res.current_version_id as string | null) ?? null,
        currentRev: (res.current_rev as string | null) ?? null,
        currentBy: (res.current_by as string | null) ?? null,
        currentByName: (res.current_by_name as string | null) ?? null,
        currentAt: (res.current_at as string | null) ?? null,
        currentChangeLog: (res.current_change_log as string | null) ?? null,
      });
    }
    if (status === "duplicate_label") throw new DuplicateLabelError(revertedLabel);
    if (status === "locked_by_other" || status === "on_hold") {
      throw new DocumentMutationBlockedError({
        ok: false,
        code: status as "locked_by_other" | "on_hold",
        message: status === "locked_by_other"
          ? `This document is checked out by ${(res.holder_name as string) || "another user"}.`
          : "This document has an active hold. Release it before reverting.",
      });
    }
    if (!res?.version) throw new Error(`The revert did not complete (publish_revision answered ${String(status)}).`);
    insertedRow = res.version as Record<string, unknown>;
  }

  // REV-6: a revert changes the controlled revision exactly as a rev-up does,
  // so an in-flight review draft built on the old current is voided — the
  // pointer cleared, the draft retired, its roster voided — or it could be
  // finalized over the revert later. Checked; the revert already committed,
  // so a failure goes on the record rather than undoing it.
  const draftVoid = await voidPendingDraftAfterPublish(doc.id, actorUserId);

  // REV-13: the revert row carries no effective date — reconcile the
  // document's denormalized copy with the version now in force, so the
  // withdrawn revision's future date stops badging the register and can
  // never be announced by the daily scan.
  let effectiveDateError: string | null = null;
  try {
    await applyEffectiveDate({ documentId: doc.id, versionId: insertedRow.id as string, effectiveDate: null });
  } catch (e) {
    effectiveDateError = (e as Error).message;
    console.error("[revert] could not reconcile the effective date:", effectiveDateError);
  }

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: insertedRow.id as string,
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "REVERT",
    details: {
      revertedFromVersionId: targetVersion.id,
      revertedFromRev: targetVersion.revisionLabel,
      previousVersionId,
      reason: reason.trim(),
      mocReference: mocReference?.trim() || null,
      pendingDraftVoided: draftVoid.voidedVersionId,
      pendingDraftVoidProblem: draftVoid.problem,
      effectiveDateReconcileError: effectiveDateError,
    },
  });

  await noteOverrideOnHolder({
    preState, documentId: doc.id, libraryId, orgId, actorUserId, actorEmail,
    revisionLabel: revertedLabel,
    changeNarrative: `Reverted to Rev ${targetVersion.revisionLabel}: ${reason.trim()}`,
    overrideReason: input.overrideReason, newVersionId: insertedRow.id as string,
  });

  // A revert CHANGES THE CURRENT REVISION — it gets the same post-publish
  // pipeline as a rev-up: stale-copy signals, package alerts, clocks.
  void runPostPublishSideEffects({
    orgId, documentId: doc.id, libraryId,
    docLabel: String(doc.documentNumber || doc.title || doc.name || "document"),
    newRev: revertedLabel,
    actorUserId, actorName: actorEmail || actorUserId, actorEmail,
  });

  return rowToVersion(insertedRow);
}

// ─── ARCHIVE / UNARCHIVE ──────────────────────────────────────────────────

export type ArchiveInput = {
  doc: DocumentRecord;
  reason: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
};

/** REV-6: archive's pre-gate — the database's own refusals of an archive,
 *  asked BEFORE anything is written, so a refusal changes nothing (an
 *  in-flight review's signatures cannot be un-voided: 20261070's sign-off
 *  guard never lets a row return to pending or signed). It mirrors the two
 *  guards an archive meets, tier for tier:
 *   - enforce_document_publish_guard (20261060, OWN-19): archiving takes the
 *     publisher tier — a controller, a granted publisher or the document's
 *     effective owner — and a non-controller is refused while an
 *     operational hold is open (fail-closed on an unreadable hold set, as
 *     every HLD-1 door is);
 *   - enforce_document_retention_guard (20261077): a legal hold refuses the
 *     archive for EVERYONE, controllers included, and an open hold refuses a
 *     non-controller.
 *  The checkout lock is not an archive gate (it never was, at either layer). */
async function authorizeArchive(opts: {
  documentId: string; libraryId: string; orgId: string; actorUserId: string; actorRole?: string;
}): Promise<void> {
  const principal: Principal = await resolveActorPrincipal({
    uid: opts.actorUserId, orgId: opts.orgId, headlineRole: opts.actorRole,
  });
  if (!isControllerPrincipal(principal)) {
    let canArchive = await resolveCanControlLibrary(opts.libraryId, principal);
    if (!canArchive) canArchive = await isEffectiveOwnerOfDocument(opts.documentId, opts.actorUserId);
    if (!canArchive) {
      throw new Error("The document was NOT archived — archiving takes publish authority in this library (Doc Control, a granted publisher or the document's owner). Nothing was changed.");
    }
    await assertNotOnHold(opts.documentId, { action: "archiving it" });
  }
  const { data, error } = await supabase
    .from("documents").select("legal_hold").eq("id", opts.documentId).maybeSingle();
  if (error) {
    throw new Error(`Couldn't confirm this document is free of a legal hold (${error.message}) — nothing was archived.`);
  }
  if ((data as { legal_hold?: boolean | null } | null)?.legal_hold === true) {
    throw new Error("This document is under legal hold and cannot be archived — a controller must release the legal hold first. Nothing was changed.");
  }
}

export async function archiveDocument(input: ArchiveInput): Promise<void> {
  const { doc, reason, orgId, actorUserId, actorEmail, actorRole } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (!reason.trim()) throw new Error("Archive reason is required");

  // REV-6: every refusal the database would give an archive is asked first;
  // nothing has been written yet.
  await authorizeArchive({ documentId: doc.id, libraryId: doc.libraryId, orgId, actorUserId, actorRole });

  const now = new Date().toISOString();
  const { data: archived, error } = await supabase
    .from("documents")
    .update({
      status: "Archived",
      archived_at: now,
      archived_by: actorUserId,
      archive_reason: reason.trim(),
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id)
    .select("id");

  if (error) throw new Error(`The document was NOT archived (${error.message}) — nothing was changed.`);
  if (((archived as unknown[] | null) ?? []).length === 0) {
    throw new Error("The document was NOT archived — you don't have authority to archive it. Nothing was changed.");
  }

  // REV-6: the in-flight review draft is voided AFTER the archive committed,
  // so a refused archive (an authority, hold or legal-hold refusal the
  // pre-gate could not foresee, a transient error) never destroys the review.
  // A void that fails here is on the ARCHIVE_DOC record, never swallowed; the
  // draft cannot publish meanwhile — finalize refuses a retired document
  // (REV-5) — and a retry of the void is the same checked routine.
  const draftVoid = await voidPendingDraftAfterPublish(doc.id, actorUserId);

  // REV-10: its share links stop durably — an unarchive must not revive them.
  const shares = await revokeLiveSharesForDocument(doc.id, actorUserId);

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: doc.currentVersionId ?? "",
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "ARCHIVE_DOC",
    details: {
      reason: reason.trim(), action: "archive",
      pendingDraftVoided: draftVoid.voidedVersionId,
      pendingDraftVoidProblem: draftVoid.problem,
      revokedShareLinks: shares.revoked, shareRevokeError: shares.error,
      liveShareLinksLeft: shares.liveLeft, shareRevokeAuditError: shares.auditError,
    },
  });
}

/** OWN-15: the statuses an unarchive may restore to — never an arbitrary
 *  string (documents.status has no CHECK constraint). */
export const UNARCHIVE_RESTORE_STATUSES = ["Issued", "Draft", "In Review"] as const;

/** REV-18 (P13 second review fix; third review fix): which status the
 *  un-archive dialog offers first, and why. 20261144's retirement stamp
 *  (written only by the publish guard; read here, never written) says what
 *  an archived document WAS: an issue whose revision is still current
 *  (`issued`) comes back Issued — the put-back the rule spares; a retirement
 *  that took away no issue of the revision that is current now
 *  (`not-issued`, RETIRED_NOT_ISSUED_STAMP, with a current revision) comes
 *  back a Draft, so a Draft is never issued by its un-archive — the evidence
 *  is the guard's own record. Anything else is NOT evidence of a Draft
 *  (`unknown`) and keeps the default every un-archive had before 20261144:
 *  Issued — archived before 20261144 or by the service role (no stamp), its
 *  stamped revision no longer current, no current revision (a register row:
 *  a 'not-issued' stamp cannot tell an Issued row from a Draft one, and
 *  restoring it issues no revision), a database without the stamp columns
 *  (the app running ahead of the paste), an unreadable row. The database
 *  decides that restore (20261144: the publisher tier, the hold, and under
 *  require the roster unless it is the stamped put-back), and a refused one
 *  leaves the Draft restore open. The dialog offers every
 *  UNARCHIVE_RESTORE_STATUSES either way. Read-only. */
export async function unarchiveRestoreDefault(documentId: string): Promise<{
  status: (typeof UNARCHIVE_RESTORE_STATUSES)[number]; basis: "issued" | "not-issued" | "unknown";
}> {
  const { data, error } = await supabase.from("documents")
    .select("current_version_id, retired_issue_status, retired_issue_version_id").eq("id", documentId).maybeSingle();
  if (error || !data) return { status: "Issued", basis: "unknown" };
  const current = (data.current_version_id as string | null) ?? null;
  const stampedVersion = (data.retired_issue_version_id as string | null) ?? null;
  if (current && stampedVersion === current) return { status: "Issued", basis: "issued" };
  if (current && !stampedVersion && data.retired_issue_status === RETIRED_NOT_ISSUED_STAMP) return { status: "Draft", basis: "not-issued" };
  return { status: "Issued", basis: "unknown" };
}

export async function unarchiveDocument(input: ArchiveInput & { restoreStatus?: string }): Promise<StatusIssueOutcome> {
  const { doc, reason, orgId, actorUserId, actorEmail, actorRole, restoreStatus } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (restoreStatus && !(UNARCHIVE_RESTORE_STATUSES as readonly string[]).includes(restoreStatus)) {
    throw new Error(`Cannot restore to "${restoreStatus}" — choose Issued, Draft or In Review.`);
  }

  const restoredStatus = restoreStatus || "Issued";
  // REV-19: what this restore issues, read BEFORE the write — the publish
  // guard (20261144) clears the retirement stamp as the document leaves its
  // retirement, so afterwards it can no longer say whether this is the
  // put-back of the issue the archive took away.
  const before = isControlledIssueStatus(restoredStatus) ? await readStatusIssueBasis(doc.id, doc) : null;
  const now = new Date().toISOString();
  // P13 third review fix: a checked write, as archiveDocument's — a restore
  // the database filtered to zero rows (no edit access to the row) is a
  // refusal, never a silent success, and writes no un-archive event.
  const { data: restored, error } = await supabase
    .from("documents")
    .update({
      status: restoredStatus,
      archived_at: null,
      archived_by: null,
      archive_reason: null,
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id)
    .select("id");

  if (error) throw new Error(`The document was NOT restored (${error.message}) — nothing was changed.`);
  if (((restored as unknown[] | null) ?? []).length === 0) {
    throw new Error("The document was NOT restored — you don't have authority to change it, or it is no longer visible to you. Nothing was changed.");
  }

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: doc.currentVersionId ?? "",
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "ARCHIVE_DOC",
    details: { reason: reason?.trim() || "Restored from archive", action: "unarchive", restoredStatus },
  });

  // REV-19: an un-archive into an issue status is an issue — its clocks and
  // its record (a put-back of the stamped issue keeps the clocks it had).
  if (before && isIssueTransition({ fromStatus: before.fromStatus, toStatus: restoredStatus, hasCurrentRevision: !!before.versionId })) {
    return await recordStatusIssue({
      orgId, documentId: doc.id, fromStatus: before.fromStatus, toStatus: restoredStatus,
      versionId: before.versionId, rev: before.rev, putBack: before.putBack, door: "unarchive",
      actorUserId, actorEmail: actorEmail ?? null, actorRole: actorRole ?? null,
    });
  }
  return NO_STATUS_ISSUE;
}

// ─── REV-19: a status change that issues starts the clocks and is recorded ──
// 20261144 (REV-18) made a status change that makes a document a controlled
// issue a guarded write; the write it admits still started no compliance
// clock and recorded nothing. These are the app's doors for it: the
// un-archive above, and changeDocumentStatus — the one function a status
// editor calls (the bulk editor's issuing rows go through it since
// document-control P17; the library page's metadata save adopts it as its
// next owner touches the page: identity IS-P1 / intelligence I-12).

export type StatusIssueDoor = "metadata" | "bulk" | "unarchive";

export interface StatusIssueOutcome {
  /** The write made the document a controlled issue (isIssueTransition). */
  issued: boolean;
  /** The put-back of the issue its retirement took away, read from
   *  20261144's retirement stamp — three-state (P14 review fix):
   *   - true: the stamp names this revision — the clocks it had keep running
   *     and are not restarted;
   *   - false: evidence of a NEW issue — the document left a Draft / In
   *     Review, or a retirement the guard stamped 'not-issued' — the review
   *     clock and the acknowledgment roster start;
   *   - null: no evidence either way — the retirement carries no stamp
   *     (retired before 20261144 or by the service role), its stamp names
   *     another revision, the stamp columns are absent, or the row could not
   *     be read. The review clock is NOT reset (a reset would mark the
   *     document reviewed today by whoever restored it and could hide a
   *     review already due); only the acknowledgment roster is opened
   *     (idempotent per revision). */
  putBack: boolean | null;
  /** What of the review clock / acknowledgment roster did not start. */
  complianceClockErrors: string[];
  /** The issue record could not be written (the issue itself stands). */
  recordError: string | null;
}

const NO_STATUS_ISSUE: StatusIssueOutcome = { issued: false, putBack: false, complianceClockErrors: [], recordError: null };

interface StatusIssueBasis { fromStatus: string | null; versionId: string | null; rev: string | null; putBack: boolean | null }

/** P14 review fix (REV-19): is an issue out of this status the put-back of
 *  the issue its retirement took away? Three-state, from the evidence alone
 *  (StatusIssueOutcome.putBack): `true` only when 20261144's stamp names the
 *  current revision; `false` only on evidence of a new issue — the document
 *  is leaving a Draft / In Review (WORK_IN_PROGRESS_STATUSES), or a
 *  retirement the guard stamped 'not-issued' (RETIRED_NOT_ISSUED_STAMP, no
 *  revision); `null` otherwise — a retirement with no stamp (before
 *  20261144, or the service role), a stamp naming another revision, a
 *  database without the stamp columns. A missing stamp is no evidence
 *  (P13 third review fix), so it never restarts the review clock. */
export function putBackFromRetirementStamp(row: {
  status: string | null; currentVersionId: string | null;
  retiredIssueStatus?: string | null; retiredIssueVersionId?: string | null;
}): boolean | null {
  if (WORK_IN_PROGRESS_STATUSES.has((row.status ?? "").trim())) return false;
  if (!isRetiredStatus(row.status)) return null;
  const stampedVersion = row.retiredIssueVersionId ?? null;
  if (row.currentVersionId && stampedVersion === row.currentVersionId) return true;
  if (!stampedVersion && row.retiredIssueStatus === RETIRED_NOT_ISSUED_STAMP) return false;
  return null;
}

/** The document as a status change finds it — its status, current revision
 *  and whether an exit from its retirement puts back the stamped issue
 *  (putBackFromRetirementStamp). `select("*")` so a database without
 *  20261144's stamp columns still answers (the stamp reads as absent: the
 *  put-back unknown). An unreadable row falls back to what the caller holds,
 *  with the put-back unknown. */
async function readStatusIssueBasis(documentId: string, held?: Pick<DocumentRecord, "status" | "currentVersionId" | "rev">): Promise<StatusIssueBasis> {
  const { data, error } = await supabase.from("documents").select("*").eq("id", documentId).maybeSingle();
  if (error || !data) {
    return { fromStatus: held?.status ?? null, versionId: held?.currentVersionId ?? null, rev: held?.rev ?? null, putBack: null };
  }
  const row = data as Record<string, unknown>;
  const fromStatus = (row.status as string | null) ?? null;
  const versionId = (row.current_version_id as string | null) ?? null;
  return {
    fromStatus, versionId, rev: (row.rev as string | null) ?? null,
    putBack: putBackFromRetirementStamp({
      status: fromStatus, currentVersionId: versionId,
      retiredIssueStatus: (row.retired_issue_status as string | null | undefined) ?? null,
      retiredIssueVersionId: (row.retired_issue_version_id as string | null | undefined) ?? null,
    }),
  };
}

/** What a landed status-change issue did to its compliance clocks, by the
 *  put-back's three states — the sentence DOCUMENT_ISSUED records. */
const STATUS_ISSUE_CLOCKS_NOTE = {
  putBack: "the put-back of the issue its retirement took away (the retirement stamp names this revision): the review clock and the acknowledgment roster it had keep running, not restarted",
  newIssue: "a new issue: the review clock and the acknowledgment roster were started",
  unknown: "no evidence whether this puts back the issue its retirement took away (the retirement carries no stamp — retired before 20261144 or by the service role — names another revision, or could not be read): the review clock was NOT reset (a reset would mark the document reviewed today and could hide a review already due); only the acknowledgment roster was opened for this revision",
} as const;

/** REV-19: what a landed status-change issue owes. A NEW issue (putBack
 *  false) starts the compliance clocks through the one path every creation
 *  door uses (startIssuedDocumentClocks: the review clock and the
 *  read-&-understood roster); the put-back of a stamped issue (true) does
 *  not (its clocks were never stopped — restarting them would mark it
 *  reviewed today and could hide a review already due); an issue the stamp
 *  cannot place (null — P14 review fix) does not reset the review clock
 *  either, on no evidence, and opens only the acknowledgment roster
 *  (onDocumentIssuedAck, idempotent per revision: nobody who already
 *  acknowledged this revision is asked again). Either way the issue is
 *  RECORDED, with what the clocks did and why: DOCUMENT_ISSUED
 *  naming the document, the revision, the status before and after, the door,
 *  the actor, and the policy decision (DEC-63 §2: an issue under a policy
 *  that requires sign-off made without a complete roster — which only a
 *  controller, or the put-back of a stamped issue, gets past the database).
 *  Never throws: the issue has landed; what did not follow is returned and
 *  on the record. */
export async function recordStatusIssue(input: {
  orgId: string; documentId: string; fromStatus: string | null; toStatus: string;
  versionId: string | null; rev?: string | null; putBack: boolean | null; door: StatusIssueDoor;
  actorUserId: string; actorEmail?: string | null; actorRole?: string | null;
}): Promise<StatusIssueOutcome> {
  const complianceClockErrors: string[] = [];
  if (input.putBack !== true) {
    try {
      complianceClockErrors.push(...await startIssuedDocumentClocks({
        orgId: input.orgId, documentId: input.documentId, actorUserId: input.actorUserId, actorName: input.actorEmail ?? null,
        // No evidence (null): the review clock is left as it was; only the
        // roster for this revision is opened.
        reviewClock: input.putBack === false,
      }));
    } catch (e) {
      complianceClockErrors.push(`the start failed (${(e as Error).message})`);
    }
  }
  // The policy decision, best-effort: an unreadable policy or roster is
  // recorded as unknown (null), never guessed. P14 final review: the roster
  // is read CHECKED (draftRosterCompleteChecked) — the unchecked read counted
  // a failed read as an empty roster, so it recorded rosterComplete: false
  // and issuedWithoutSignOff: true on no evidence — and the verdict is
  // unknown whenever either half is.
  let reviewPolicyMode: string | null = null;
  let rosterComplete: boolean | null = null;
  try {
    const { data: row, error: rowErr } = await supabase.from("documents")
      .select("collection_id, library_id, review_control").eq("id", input.documentId).maybeSingle();
    if (row && !rowErr) {
      const chain = await effectiveReviewControlForDocument({
        reviewControl: null, collectionId: (row.collection_id as string | null) ?? null, libraryId: row.library_id as string,
      });
      const own = (row.review_control as ReviewControl | null) ?? null;
      reviewPolicyMode = chain.mode === "require" || own?.mode === "require" ? "require" : (chain.mode ?? null);
    }
  } catch { reviewPolicyMode = null; /* recorded as unknown */ }
  if (input.versionId) {
    try { rosterComplete = await draftRosterCompleteChecked(input.documentId, input.versionId); }
    catch { rosterComplete = null; /* recorded as unknown */ }
  }
  const issuedWithoutSignOff = reviewPolicyMode === null || rosterComplete === null
    ? null
    : reviewPolicyMode === "require" && !rosterComplete;
  const { error: recordErr } = await logAuditAction({
    action: "DOCUMENT_ISSUED",
    resourceType: "document",
    resourceId: input.documentId,
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorEmail ?? undefined,
    userRole: input.actorRole ?? undefined,
    details: {
      door: input.door,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      versionId: input.versionId,
      rev: input.rev ?? null,
      putBack: input.putBack,
      reviewPolicyMode,
      rosterComplete,
      issuedWithoutSignOff,
      complianceClocksStarted: input.putBack === false,
      reviewClockReset: input.putBack === false,
      acknowledgmentRosterOpened: input.putBack !== true,
      complianceClocksNote: input.putBack === true ? STATUS_ISSUE_CLOCKS_NOTE.putBack
        : input.putBack === false ? STATUS_ISSUE_CLOCKS_NOTE.newIssue : STATUS_ISSUE_CLOCKS_NOTE.unknown,
      complianceClockErrors: complianceClockErrors.length > 0 ? complianceClockErrors : null,
    },
  });
  if (complianceClockErrors.length > 0) {
    console.warn(`[revisions] REV-19: the review clock / acknowledgment roster of document ${input.documentId} did not fully start (${complianceClockErrors.join("; ")})`);
  }
  return { issued: true, putBack: input.putBack, complianceClockErrors, recordError: recordErr ?? null };
}

/** REV-19: THE status write for a status editor — one checked UPDATE of the
 *  status (and any other columns the editor saves with it), then, when it
 *  made the document a controlled issue, recordStatusIssue. A refusal is
 *  thrown in the database's own words (the publish guard's sentences, which
 *  isIssueRefusal recognises); a write that matched no row is a refusal,
 *  never a silent success. */
export async function changeDocumentStatus(input: {
  orgId: string; documentId: string; toStatus: string; door: Exclude<StatusIssueDoor, "unarchive">;
  actorUserId: string; actorEmail?: string | null; actorRole?: string | null;
  /** Other columns written in the same checked UPDATE (a metadata save). */
  patch?: Record<string, unknown>;
}): Promise<StatusIssueOutcome> {
  const before = await readStatusIssueBasis(input.documentId);
  const now = new Date().toISOString();
  const { data: rows, error } = await supabase.from("documents")
    .update({ ...(input.patch ?? {}), status: input.toStatus, updated_at: now, updated_by: input.actorUserId })
    .eq("id", input.documentId)
    .select("id");
  if (error) throw new Error(error.message);
  if (((rows as unknown[] | null) ?? []).length === 0) {
    throw new Error("The status was NOT changed — you don't have authority to change this document, or it is no longer visible to you. Nothing was changed.");
  }
  if (!isIssueTransition({ fromStatus: before.fromStatus, toStatus: input.toStatus, hasCurrentRevision: !!before.versionId })) {
    return NO_STATUS_ISSUE;
  }
  return await recordStatusIssue({
    orgId: input.orgId, documentId: input.documentId, fromStatus: before.fromStatus, toStatus: input.toStatus,
    versionId: before.versionId, rev: before.rev, putBack: before.putBack, door: input.door,
    actorUserId: input.actorUserId, actorEmail: input.actorEmail ?? null, actorRole: input.actorRole ?? null,
  });
}

// ─── SUPERSEDE DOCUMENT ───────────────────────────────────────────────────
// One whole document is replaced by zero or more *different* documents.
// (Rev-Up is for a new revision of the same document; this is for retiring
// or splitting a drawing.)

export type SupersedeInput = {
  doc: DocumentRecord;                    // the document being retired
  replacementDocNumbers: string[];        // document_number strings for the replacement(s)
  libraryId: string;                      // scope the doc-number lookup
  reason: string;                         // required
  mocReference?: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** Controllers (Admin/DocCtrl) may force past a foreign lock or active hold. */
  force?: boolean;
  /** Required when superseding a doc someone else has checked out. */
  overrideReason?: string;
};

export type SupersedeResult = {
  resolvedReplacementIds: string[];
  /** Always empty since REV-14: an unresolved replacement refuses the
   *  supersede before anything is written (UnresolvedReplacementsError). */
  unresolvedDocNumbers: string[];
};

/** REV-14: a named replacement did not resolve to a document in this library
 *  — nothing was superseded. */
export class UnresolvedReplacementsError extends Error {
  unresolved: string[];
  constructor(unresolved: string[]) {
    super(
      `Nothing was superseded: ${unresolved.length === 1 ? "this replacement doesn't" : "these replacements don't"} match a document in this library: ${unresolved.join(", ")}. ` +
      "Fix or remove them — a supersession records exactly the successors it names.",
    );
    this.name = "UnresolvedReplacementsError";
    this.unresolved = unresolved;
  }
}

/** REV-14: the lineage write did not record every named pair. `outcome`
 *  says what is known about the rows: "refused" — the statement failed, so
 *  it wrote nothing; "incomplete" — it answered but pairs are missing (an RLS
 *  refusal answers zero rows); "unconfirmed" — it answered but the read-back
 *  failed. The message names no outcome for the document: each caller states
 *  its own (supersede restores the prior status; split / merge roll back). */
export class SupersessionLineageError extends Error {
  readonly outcome: "refused" | "incomplete" | "unconfirmed";
  readonly missing: string[];
  constructor(outcome: "refused" | "incomplete" | "unconfirmed", message: string, missing: string[] = []) {
    super(message);
    this.name = "SupersessionLineageError";
    this.outcome = outcome;
    this.missing = missing;
  }
}

/** REV-14 / DRLS-13: write supersession lineage rows as an upsert on the
 *  unique pair (ON CONFLICT DO NOTHING) and CHECK it: a refused write, or a
 *  pair that is still missing afterwards (an RLS refusal answers with zero
 *  rows, not an error), throws SupersessionLineageError. Shared by
 *  supersedeDocument and the split / merge lifecycle. */
export async function writeSupersessionLineage(
  rows: Array<Record<string, unknown>>,
  supersededDocId: string,
  replacementIds: string[],
): Promise<void> {
  const { error } = await supabase
    .from("document_supersessions")
    .upsert(rows, { onConflict: "superseded_doc_id,replacement_doc_id", ignoreDuplicates: true });
  if (error) {
    throw new SupersessionLineageError("refused", `The replacement links could not be recorded (${error.message}).`, replacementIds);
  }
  const { data: present, error: readErr } = await supabase
    .from("document_supersessions").select("replacement_doc_id")
    .eq("superseded_doc_id", supersededDocId).in("replacement_doc_id", replacementIds);
  if (readErr) {
    throw new SupersessionLineageError("unconfirmed", `The replacement links could not be confirmed after they were written (${readErr.message}).`);
  }
  const have = new Set(((present as Array<{ replacement_doc_id: string }> | null) ?? []).map((r) => r.replacement_doc_id));
  const missing = replacementIds.filter((id) => !have.has(id));
  if (missing.length > 0) {
    throw new SupersessionLineageError(
      "incomplete",
      `${missing.length} of ${replacementIds.length} replacement link(s) were not recorded (the write was refused).`,
      missing,
    );
  }
}

/** REV-14: a supersede whose lineage failed AFTER the status flip is put
 *  back — the prior status and supersession fields restored, and any pair
 *  this attempt added removed — so the document is never left Superseded
 *  with fewer successors than were named (and the Inspector, which offers
 *  Supersede only on a live document, can run it again). Checked: what could
 *  not be undone is named in the thrown error. Nothing irreversible has
 *  happened yet: the in-review draft is voided and the share links revoked
 *  only after the lineage confirms (REV-6 / REV-10). */
async function undoFailedSupersede(opts: {
  docId: string;
  prior: Record<string, unknown>;
  addedPairs: string[];
  failure: SupersessionLineageError;
  actorUserId: string;
}): Promise<never> {
  const { docId, prior, failure } = opts;
  const priorStatus = String(prior.status ?? "Issued");
  const { data: restored, error: restoreErr } = await supabase
    .from("documents")
    .update({
      status: priorStatus,
      superseded_at: prior.superseded_at ?? null,
      superseded_by_user: prior.superseded_by_user ?? null,
      supersession_reason: prior.supersession_reason ?? null,
      supersession_moc: prior.supersession_moc ?? null,
      updated_at: new Date().toISOString(),
      updated_by: opts.actorUserId,
    })
    .eq("id", docId)
    .select("id");
  if (restoreErr || ((restored as unknown[] | null) ?? []).length === 0) {
    throw new Error(
      `${failure.message} The document is now Superseded and its previous status could not be restored ` +
      `(${restoreErr?.message ?? "the write was refused"}) — ask Doc Control to restore it to ${priorStatus} or record the replacement links.`,
    );
  }
  let leftover = 0;
  if (failure.outcome !== "refused" && opts.addedPairs.length > 0) {
    const { error: delErr } = await supabase
      .from("document_supersessions").delete()
      .eq("superseded_doc_id", docId).in("replacement_doc_id", opts.addedPairs);
    const { data: left, error: leftErr } = await supabase
      .from("document_supersessions").select("replacement_doc_id")
      .eq("superseded_doc_id", docId).in("replacement_doc_id", opts.addedPairs);
    leftover = delErr || leftErr ? opts.addedPairs.length : ((left as unknown[] | null) ?? []).length;
  }
  throw new Error(
    `Nothing was superseded: ${failure.message} The document is back to ${priorStatus}.` +
    (leftover > 0 ? ` ${leftover} replacement link(s) this attempt wrote could not be removed — ask Doc Control to delete them.` : "") +
    " Fix the cause and supersede it again.",
  );
}

export async function supersedeDocument(input: SupersedeInput): Promise<SupersedeResult> {
  const {
    doc, replacementDocNumbers, libraryId, reason, mocReference,
    orgId, actorUserId, actorEmail, actorRole,
  } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (!reason.trim()) throw new Error("Supersession reason is required");

  // DCK-1: superseding a drawing-class document changes which sheet is the
  // controlled copy — the same PSM MOC requirement as a non-minor revision.
  // Rev-up and revert are gated inside publish_revision at the database;
  // supersede flips documents.status directly, so the gate lives here.
  // Unresolvable class (pre-migration env) does not block — the DB rail model.
  try {
    const { effectiveDocClassForDocument } = await import("@/lib/docClass");
    const cls = await effectiveDocClassForDocument({
      id: doc.id, collectionId: doc.collectionId ?? null, libraryId,
    });
    if (cls === "drawing" && (mocReference?.trim().length ?? 0) < 3) {
      throw new Error(
        "This is a drawing-class document — PSM requires the MOC reference to supersede it (OSHA 1910.119(l)).",
      );
    }
  } catch (e) {
    if ((e as Error).message.includes("MOC reference")) throw e;
    /* class unresolvable — do not block */
  }

  // Retiring a document is a canonical-state change too: same per-library publish
  // authority + lock/hold guard, and an override reason if someone else is
  // actively editing it.
  const preState = await authorizePublish({
    documentId: doc.id, libraryId, orgId, actorUserId, actorRole,
    overrideReason: input.overrideReason, force: input.force, operation: "supersede",
  });

  const now = new Date().toISOString();

  // Resolve replacement document numbers to UUIDs scoped to this library.
  // REV-14: resolved BEFORE anything is written — a replacement that does not
  // resolve refuses the whole supersede, so the record is never "Superseded,
  // with fewer successors than the controller named".
  const resolved: string[] = [];
  const unresolved: string[] = [];
  if (replacementDocNumbers.length > 0) {
    const { data, error: lookupErr } = await supabase
      .from("documents")
      .select("id, document_number")
      .eq("org_id", orgId)
      .eq("library_id", libraryId)
      .in("document_number", replacementDocNumbers);
    if (lookupErr) throw new Error(`Couldn't look up the replacement documents (${lookupErr.message}) — nothing was superseded.`);

    const map = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ id: string; document_number: string }>) {
      map.set(row.document_number, row.id);
    }
    for (const dn of replacementDocNumbers) {
      const id = map.get(dn);
      if (id && id !== doc.id) resolved.push(id);
      else unresolved.push(dn);
    }
  }
  if (unresolved.length > 0) {
    throw new UnresolvedReplacementsError(unresolved);
  }

  // REV-14: what a failed lineage write puts back — the status and
  // supersession fields as they are NOW (a re-run on a Superseded document
  // keeps its first supersession), and the pairs that already exist (an
  // undo removes only the ones this attempt added). Read before any write.
  const { data: priorRow, error: priorErr } = await supabase
    .from("documents")
    .select("status, superseded_at, superseded_by_user, supersession_reason, supersession_moc")
    .eq("id", doc.id).maybeSingle();
  if (priorErr || !priorRow) {
    throw new Error(`Couldn't read the document's current status (${priorErr?.message ?? "not found"}) — nothing was superseded.`);
  }
  const priorState: Record<string, unknown> = { ...(priorRow as Record<string, unknown>) };
  let preExistingPairs = new Set<string>();
  if (resolved.length > 0) {
    const { data: pairs, error: pairsErr } = await supabase
      .from("document_supersessions").select("replacement_doc_id")
      .eq("superseded_doc_id", doc.id).in("replacement_doc_id", resolved);
    if (pairsErr) throw new Error(`Couldn't read the document's existing replacement links (${pairsErr.message}) — nothing was superseded.`);
    preExistingPairs = new Set(((pairs as Array<{ replacement_doc_id: string }> | null) ?? []).map((r) => r.replacement_doc_id));
  }

  // Mark the original document as Superseded with full metadata. REV-6: the
  // in-flight review draft is NOT voided yet — a voided sign-off never
  // returns (20261070), and the status write or the lineage below can still
  // be refused and undone; the void runs once both have landed.
  const { data: superseded, error: updErr } = await supabase
    .from("documents")
    .update({
      status: "Superseded",
      superseded_at: now,
      superseded_by_user: actorUserId,
      supersession_reason: reason.trim(),
      supersession_moc: mocReference?.trim() || null,
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id)
    .select("id");

  if (updErr) throw new Error(updErr.message);
  if (((superseded as unknown[] | null) ?? []).length === 0) {
    throw new Error("The document was NOT superseded — you don't have authority to supersede it.");
  }

  // Record the (old → new) join rows. REV-14 / DRLS-13: an UPSERT on the
  // unique pair (ON CONFLICT DO NOTHING) — re-running a supersede with an
  // added replacement records the new pair instead of losing the whole batch
  // to the one that already exists — and the result is CHECKED: a refused
  // lineage write puts the document back (undoFailedSupersede) and says so,
  // never a success and never a Superseded record short of its successors.
  if (resolved.length > 0) {
    const rows = resolved.map((replacementId) => ({
      org_id: orgId,
      superseded_doc_id: doc.id,
      replacement_doc_id: replacementId,
      reason: reason.trim(),
      created_by: actorUserId,
      created_at: now,
    }));
    try {
      await writeSupersessionLineage(rows, doc.id, resolved);
    } catch (e) {
      if (!(e instanceof SupersessionLineageError)) throw e;
      await undoFailedSupersede({
        docId: doc.id, prior: priorState,
        addedPairs: resolved.filter((id) => !preExistingPairs.has(id)),
        failure: e, actorUserId,
      });
    }
  }

  // REV-6: nothing below can be rolled back, so the retired record's
  // in-flight review draft is voided now — a failure is on the SUPERSEDE_DOC
  // record (pendingDraftVoidProblem), never swallowed; the draft cannot
  // publish meanwhile, because finalize refuses a retired document (REV-5).
  const draftVoid = await voidPendingDraftAfterPublish(doc.id, actorUserId);

  // DIST-1: a public share link must stop serving a retired drawing. Revoke
  // what this actor may revoke (RLS can leave another creator's links to a
  // controller — the count on the audit record keeps that honest). Also
  // irreversible (20261080), so also only now.
  const shares = await revokeLiveSharesForDocument(doc.id, actorUserId);
  const revokedShareLinks = shares.revoked;

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: doc.currentVersionId ?? "",
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "SUPERSEDE_DOC",
    details: {
      reason: reason.trim(),
      mocReference: mocReference?.trim() || null,
      replacementDocNumbers,
      resolvedReplacementIds: resolved,
      unresolvedDocNumbers: unresolved,
      revokedShareLinks,
      shareRevokeError: shares.error,
      liveShareLinksLeft: shares.liveLeft,
      shareRevokeAuditError: shares.auditError,
      pendingDraftVoided: draftVoid.voidedVersionId,
      pendingDraftVoidProblem: draftVoid.problem,
    },
  });

  // If we superseded a doc someone else had checked out, leave their checkout open
  // but tell them it was retired (and why), with a link to the document.
  await notifyHolderOfRetirement({
    preState, documentId: doc.id, libraryId, orgId, actorUserId, actorEmail,
    verb: "superseded", action: "supersede", reason: reason.trim(),
  });

  // Open work packages holding this document must hear it was retired — the
  // pin still "matches", so drift detection can't see it.
  void import("@/lib/postPublish").then(({ notifyPackagesOfRetirement }) =>
    notifyPackagesOfRetirement({
      orgId, documentId: doc.id!,
      docLabel: String(doc.documentNumber || doc.title || doc.name || "document"),
      newStatus: "Superseded",
      actorUserId, actorName: actorEmail || actorUserId,
    }),
  ).catch(() => { /* non-blocking */ });

  // DIST-4: a retired document's pending confirmations no longer bind —
  // close them all, or the cron nags people to confirm a drawing that no
  // longer exists.
  void import("@/lib/distributionAcks").then(({ closeStaleAcksForDocument }) =>
    closeStaleAcksForDocument(doc.id!, null),
  ).catch(() => { /* non-blocking */ });

  // DIST-1: retirement is the loudest recall event in document control — it
  // must reach every copy holder automatically, not only package owners and
  // the checkout holder via a controller finding the inspector button.
  void import("@/lib/staleCopies").then(({ recallRetiredDocument }) =>
    recallRetiredDocument({
      orgId, documentId: doc.id!, libraryId,
      docLabel: String(doc.documentNumber || doc.title || doc.name || "document"),
      newStatus: "Superseded",
      replacementNote: replacementDocNumbers.length > 0
        ? `Replaced by ${replacementDocNumbers.join(", ")}.`
        : null,
      actorUserId, actorName: actorEmail || actorUserId,
    }),
  ).catch(() => { /* non-blocking */ });

  return { resolvedReplacementIds: resolved, unresolvedDocNumbers: unresolved };
}

// ─── BACKFILL HISTORICAL VERSION ─────────────────────────────────────────
//
// `backfillVersion` is for adding a HISTORICAL revision to a document
// after the fact. Use case: existing app users have been uploading
// only the current version of each drawing, and now they want to
// retroactively populate the chain so the Phase 4 Compare/diff
// overlay has something to diff against.
//
// Key difference from revUpDocument:
//   - Does NOT update documents.current_version_id
//   - Does NOT update documents.rev / revision / status
//   - Does NOT mark any other version as superseded
//   - released_at defaults to NOW() but can be set to a historical
//     date the user provides
//   - The backfilled row's supersedes_version_id is optional — pass
//     a value to slot into the chain, omit to leave the row
//     "free-floating" (still searchable, still diffable, just not
//     part of the linked-list chain)
//
// Fires a REV_BACKFILL audit event so the timeline shows this was
// added historically, not released forward.

export type BackfillInput = {
  doc: DocumentRecord;
  libraryId: string;
  folderPath?: string[];
  file: File;

  // Required engineering metadata
  revisionLabel: string;
  changeLog: string;

  // Optional fields
  issueType?: DocumentVersion["issueType"];
  changeType?: DocumentVersion["changeType"];
  drawnByName?: string;
  checkedByName?: string;
  approvedByName?: string;
  mocReference?: string;
  sourceFileName?: string;

  /** Historical release timestamp (ISO 8601). Defaults to NOW(). */
  releasedAt?: string;
  /** Optional: this backfilled rev supersedes which existing version. */
  supersedesVersionId?: string;

  // Actor context
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
};

export async function backfillVersion(input: BackfillInput): Promise<DocumentVersion> {
  const {
    doc, libraryId, folderPath, file,
    revisionLabel, changeLog, issueType, changeType,
    drawnByName, checkedByName, approvedByName,
    mocReference, sourceFileName,
    releasedAt, supersedesVersionId,
    orgId, actorUserId, actorEmail, actorRole,
  } = input;

  if (!doc.id) throw new Error("Document is missing an id");
  if (!revisionLabel.trim()) throw new Error("Revision label is required");
  if (!changeLog.trim()) throw new Error("Change narrative is required");

  // Injecting rows into a controlled document's revision history — with
  // caller-chosen released_at, approved_by_name and file_hash — is
  // publish-shaped authority. Same authority population as publish, revert
  // and label correction: per-library control, or effective ownership of
  // this document. Checked before anything is hashed or uploaded.
  const principal: Principal = await resolveActorPrincipal({ uid: actorUserId, orgId, headlineRole: actorRole });
  let authorized = await resolveCanControlLibrary(libraryId, principal);
  if (!authorized) authorized = await isEffectiveOwnerOfDocument(doc.id, actorUserId);
  if (!authorized) {
    throw new Error("You don't have authority to backfill revisions here. Ask an Admin or Doc Control to grant publish authority on this library.");
  }

  // Hash + upload to a revision-scoped path. Suffix marks the file as
  // a backfilled historical version so it doesn't collide with a
  // forward rev-up under the same label.
  const fileHash = await sha256Hex(file);
  const safeRev = revisionLabel.trim().replace(/[^\w.\-]+/g, "_");
  const stem = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop() || "pdf";
  const versionedName = `${stem}__rev${safeRev}__backfill__${Date.now()}.${ext}`;

  const storagePath = makeLibraryStoragePath({
    orgId, libraryId, folderPath, filename: versionedName,
  });
  const uploadResult = await uploadToPath(file, storagePath, {
    contentType: file.type || undefined,
  });

  const now = new Date().toISOString();
  const effectiveReleasedAt = releasedAt || now;

  // Insert the historical version row. Critically: we do NOT change
  // documents.current_version_id / rev / status here. The current
  // revision of the document is whatever it was before this call.
  const { data: insertedRow, error: insertErr } = await supabase
    .from("document_versions")
    .insert({
      org_id: orgId,
      record_id: doc.id,
      revision_label: revisionLabel.trim(),
      issue_type: issueType ?? null,
      change_type: changeType ?? null,
      file_url: uploadResult.url,
      file_type: file.type || "application/octet-stream",
      size: uploadResult.size,
      change_log: changeLog.trim(),
      created_by: actorUserId,
      created_by_name: actorEmail || actorUserId,
      created_at: now,                         // when the row was inserted
      released_at: effectiveReleasedAt,        // when the file was historically released
      supersedes_version_id: supersedesVersionId ?? null,
      drawn_by_name: drawnByName?.trim() || null,
      checked_by_name: checkedByName?.trim() || null,
      approved_by_name: approvedByName?.trim() || null,
      moc_reference: mocReference?.trim() || null,
      source_file_name: sourceFileName?.trim() || null,
      file_hash: fileHash,
    })
    .select("*")
    .single();

  if (insertErr || !insertedRow) {
    throw new Error(insertErr?.message || "Failed to write backfilled version row");
  }

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: insertedRow.id as string,
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "REV_BACKFILL",
    details: {
      revisionLabel: revisionLabel.trim(),
      narrative: changeLog.trim(),
      issueType: issueType ?? null,
      changeType: changeType ?? null,
      releasedAt: effectiveReleasedAt,
      supersedesVersionId: supersedesVersionId ?? null,
      mocReference: mocReference?.trim() || null,
      sourceFileName: sourceFileName?.trim() || null,
      fileHash,
    },
  });

  return rowToVersion(insertedRow);
}
