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
import { isMissingSchemaError } from "@/lib/checkedWrite";
import { isControlledIssueStatus, isRetiredStatus, isIssueTransition, RETIRED_NOT_ISSUED_STAMP, WORK_IN_PROGRESS_STATUSES } from "@/lib/issueStatus";
import { isUnguardedEntryIntoForce } from "@/lib/documentStatusOptions";
import { IN_FORCE_STATUSES } from "@/lib/verifyVerdict";
import { requestUnitCodeDecode } from "@/lib/unitCodeClient";
import type { recallRetiredDocument as RecallRetiredDocument } from "@/lib/staleCopies";

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
  /** notifications N17 (the integrator's rule R2, DEC-90): false when this
   *  call is one of MANY documents a single action opens rosters for — the
   *  read-&-understood / sign-off requests keep their bell rows and emails and
   *  skip only the push leg (lib/acknowledgments.ts recomputeDocumentAck). */
  notifyPush?: boolean;
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
export type GuardedOperation = "publish" | "supersede" | "split" | "merge" | "submit for review"
  // REV-33 (document-control P34): the metadata editor's save to Void takes
  // the same authority / lock / hold pre-check (gateStatusEditorRetirement).
  | "void";

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
 *  retirement already committed.
 *
 *  REV-34 (c) (document-control P34): also the status editors' supersession
 *  (and, REV-33, the metadata editor's void) of a document someone else has
 *  checked out — the same notice, the same kind. It now answers what did not
 *  reach the holder (the in-app notice refused or thrown), for a caller that
 *  names it; every caller before P34 ignores the answer, so for them nothing
 *  changed. */
export async function notifyHolderOfRetirement(opts: {
  preState: PublishGuardState;
  documentId: string;
  libraryId: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  verb: "superseded" | "split" | "merged" | "voided";
  action: "supersede" | "split" | "merge" | "void";
  reason: string;
}): Promise<string[]> {
  const holder = opts.preState.checkedOutBy;
  if (!holder || String(holder) === String(opts.actorUserId)) return [];
  const who = opts.actorEmail || opts.actorUserId;
  const missed: string[] = [];
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
    const sent = await notify({
      orgId: opts.orgId, userId: String(holder),
      kind: "revision_published_over_checkout",
      title: `Document ${opts.verb} while you're checked out`,
      body: `${opts.verb[0].toUpperCase()}${opts.verb.slice(1)} by ${who}: ${opts.reason}`,
      link: `/documents/${opts.libraryId}?doc=${opts.documentId}`,
      resourceType: "document", resourceId: opts.documentId,
      actorUserId: opts.actorUserId, actorName: who,
      metadata: { action: opts.action, reason: opts.reason },
    });
    if (sent === false) missed.push("the checkout holder's notice could not be sent");
  } catch {
    /* best-effort */
    missed.push("the checkout holder's notice could not be sent");
  }
  return missed;
}

/** PROD-17 (document-control P26): a retirement door's recall — the copy
 *  holders' doc_recalled and its DISTRIBUTION_RECALL row first, then the
 *  watchers' doc_retired FYI (lib/staleCopies.ts recallRetiredDocument,
 *  which orders them) — sent ONCE for the retirement and never awaited, as
 *  supersedeDocument sends its own: the door returns exactly when it did,
 *  and an FYI that stalls (a hung discover check) never holds it. Used by
 *  the doors that recalled nothing before: archiveDocument,
 *  changeDocumentStatus into a retired status, and split / merge retiring
 *  their sources (lib/documentLifecycle). One call per retirement: a door
 *  that routes a write through another door that already calls it must
 *  not call it again. Each door passes `recallCopyHolders:
 *  recallsCopyHolders(priorStatus)` (P26 fix pass 4, the integrator's
 *  ruling under DEC-90): a document that was never issued gets the
 *  watchers' FYI and no copy-holder recall. No label in hand (a status
 *  write): the row is read for it here, off the door's path; unreadable,
 *  the notice names "A document" and still goes — a recall is never
 *  dropped for want of a label. The module is loaded once and shared, so
 *  a merge's several recalls wait on one load. */
let staleCopiesLoad: Promise<typeof import("@/lib/staleCopies")> | null = null;
export function recallOnRetirement(
  input: Omit<Parameters<typeof RecallRetiredDocument>[0], "docLabel" | "libraryId"> & { docLabel?: string | null; libraryId?: string | null },
): void {
  void (async () => {
    let docLabel = input.docLabel ?? null;
    let libraryId = input.libraryId ?? null;
    if (!docLabel) {
      try {
        const { data } = await supabase.from("documents").select("library_id, document_number, title, name").eq("id", input.documentId).maybeSingle();
        const row = (data as { library_id?: string | null; document_number?: string | null; title?: string | null; name?: string | null } | null) ?? null;
        docLabel = row ? (row.document_number || row.title || row.name || null) : null;
        libraryId = libraryId ?? row?.library_id ?? null;
      } catch { /* named generically below */ }
    }
    staleCopiesLoad ??= import("@/lib/staleCopies").catch((e) => { staleCopiesLoad = null; throw e; });
    const { recallRetiredDocument } = await staleCopiesLoad;
    await recallRetiredDocument({ ...input, docLabel: docLabel || "A document", libraryId });
  })().catch((e) => {
    // Non-blocking (the retirement has landed), never silent: a recall that
    // failed to run (a failed module load, a throw past it) is logged as an
    // error, as this file logs a retirement's other dropped duties ([retire],
    // [publish]) — P26 fix pass 2 logged it as a warning; fix pass 4 (the
    // integrator, DEC-90) as an error. The door is unaffected and the next
    // recall retries the load. A failed download_audits read INSIDE
    // recallRetiredDocument resolves, so it never reaches this catch: it is
    // logged and recorded there (notifications DELIV-17, document-control P28).
    console.error(`[revisions] PROD-17: the retirement recall of document ${input.documentId} did not run`, e);
  });
}

/** DIST-16 done-when 2 (the P28 integrator fix pass, 2026-10-21): the
 *  retirement doors no longer ask this — archiveDocument, changeDocumentStatus,
 *  the split, the merge, a reversal's park, a disposal and the two bulk doors
 *  pass their prior as `retiredFrom` and lib/staleCopies.ts
 *  recallRetiredDocument / recallRetiredBatch decide "already retired" from
 *  the document's recall record. Only supersedeDocument still reads it (a
 *  re-run on a Superseded / Archived document recalls as it always has).
 *  What follows is the rule as it stood.
 *
 *  PROD-17 (P26 fix pass 2): does a door that retires a document out of
 *  `priorStatus` (the status read fresh before its write) skip the whole
 *  recall call — the copy holders' recall AND the watchers' FYI — because
 *  an earlier retirement may already have sent both? Only a Superseded or
 *  Archived prior is "already retired" here: supersede, a split and a
 *  merge (Superseded) and the Archive dialog (Archived) send the call.
 *  "May have" is all it says — a Superseded / Archived set by a status
 *  editor's bare write, the library page's bulk archive, a reversal's
 *  parking or a retention disposal sent nothing, so its watchers are never
 *  told (PROD-17 residual, document-control P28). A Void prior is NOT
 *  skipped: no live door that writes Void recalls or tells a watcher (both
 *  status editors write it bare; changeDocumentStatus would, but no caller
 *  routes a retirement there). What a Void prior gets is
 *  recallsCopyHolders's to say: the watchers' FYI, and no copy-holder
 *  recall (P26 fix pass 4). A prior the read did not give (null) is not
 *  skipped. Interim: once a door that writes Void tells the watchers, a
 *  Void prior gives them a second FYI, until "already told" is decided
 *  from the document's record (document-control DIST-16). */
export function skipsRetirementRecall(priorStatus: string | null | undefined): boolean {
  return isRetiredStatus(priorStatus) && (priorStatus ?? "").trim() !== "Void";
}

/** PROD-17 (P26 fix pass 4; the integrator's ruling under DEC-90,
 *  2026-10-14): does a retirement out of `priorStatus` (the status read
 *  fresh before the door's write) recall the document's COPY HOLDERS?
 *  Only when it takes away a controlled issue — the prior status is one
 *  lib/issueStatus.ts isControlledIssueStatus counts (Issued, IFC, a
 *  library's own; the helper also counts an empty or missing status, so a
 *  prior the read did not give recalls: a second recall over none).
 *  Retiring a controlled
 *  issue means telling the holders of its copies to stop using them, as
 *  supersede does. A document never issued — a Draft, In Review or Void
 *  prior, which the helper does not count — gets the watchers' FYI only:
 *  "destroy old prints" (a preference-exempt safety_recall email) is false
 *  for it. A Void prior is a document already out of force; its copies
 *  are for the door that voids it to recall, once that door recalls
 *  (PROD-17 residual, document-control P28) — a row voided by a status
 *  editor's bare write before then has its copies recalled by no door.
 *  Superseded / Archived priors never get here (skipsRetirementRecall). */
export function recallsCopyHolders(priorStatus: string | null | undefined): boolean {
  return isControlledIssueStatus(priorStatus);
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
 *  (recordStatusIssue). Every other caller omits it.
 *  notifications N17 (R2, the integrator at the N17 merge): `notifyPush:
 *  false` — a door opening rosters for many documents in one action — is
 *  passed to onDocumentIssuedAck; the bell rows and emails are unchanged. */
export async function startIssuedDocumentClocks(input: {
  orgId: string; documentId: string; actorUserId: string; actorName?: string | null; reviewClock?: boolean; notifyPush?: boolean;
}): Promise<string[]> {
  const writeErrors: string[] = [];
  // Seed the review clock so a new doc picks up any library/folder review cycle.
  if (input.reviewClock !== false) await onDocumentIssued({ orgId: input.orgId, documentId: input.documentId, userId: input.actorUserId, userName: input.actorName, writeErrors });
  // Open the read-&-understood roster if an ack policy covers this new doc.
  await onDocumentIssuedAck({ orgId: input.orgId, documentId: input.documentId, actorId: input.actorUserId, actorName: input.actorName, writeErrors, ...(input.notifyPush === false ? { notifyPush: false } : {}) });
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
 *
 * drafting-flow DCW-4 (DF-P12): `relatedTicketId` (optional) names the
 * drafting ticket whose deliverable this NEW document is — "Publish as a new
 * document in <library>". It is checked to be a ticket of this workspace
 * BEFORE anything is written, and recorded on the first version
 * (document_versions.related_ticket_id, as revUpDocument records a revision's
 * — GAP-6 / DEC-22: provenance only, never a review waiver, DEC-23) and on the
 * DOCUMENT_CREATED row. Absent, nothing about the creation changes: the
 * insert payloads and the audit details are exactly as before.
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
  /** drafting-flow DCW-4: the drafting ticket this new document delivers
   *  (provenance only — see above). */
  relatedTicketId?: string | null;
  /** notifications N17 (the integrator's rule R2, DEC-90): false when this
   *  call is one of MANY documents a single action opens rosters for — the
   *  read-&-understood / sign-off requests keep their bell rows and emails and
   *  skip only the push leg (lib/acknowledgments.ts recomputeDocumentAck). */
  notifyPush?: boolean;
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
  // DCW-4: the deliverable's provenance names a ticket of THIS workspace, or
  // nothing is written (a read that cannot be made refuses too).
  const relatedTicketId = input.relatedTicketId ?? null;
  if (relatedTicketId !== null) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(relatedTicketId)) {
      throw new Error("The drafting request this document delivers is not identified correctly. Nothing was created.");
    }
    const { data: tk, error: tkErr } = await supabase
      .from("tickets").select("id").eq("id", relatedTicketId).eq("org_id", input.orgId).maybeSingle();
    if (tkErr) throw new Error(`Couldn't confirm the drafting request this document delivers (${tkErr.message}). Nothing was created.`);
    if (!tk) throw new Error("The drafting request this document delivers is not one of this workspace's. Nothing was created.");
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
      // DCW-4: provenance only (DEC-22 / DEC-23), and only when given.
      ...(relatedTicketId ? { related_ticket_id: relatedTicketId } : {}),
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
      ...(relatedTicketId ? { relatedTicketId } : {}),
    },
  });
  if (input.status === "Issued") {
    // REV-15: the one clock-start path every creation door shares.
    await startIssuedDocumentClocks({ orgId: input.orgId, documentId, actorUserId: input.actorUserId, actorName: input.actorEmail, ...(input.notifyPush === false ? { notifyPush: false } : {}) });
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
 *  not publish it unreviewed).
 *
 *  REV-28 option (a) (document-control P25; DEC-77, decided by the
 *  integrator under the user's delegation at the P16 merge): a document in
 *  an issue status that NO gate reads as in force — IFC, an empty status, a
 *  case or spacing variant, a library's own, NULL — with a current revision
 *  is a first issue too. Its current revision was never put in force, so
 *  nothing says it was reviewed, and a rev-up writes 'Issued': the new
 *  revision would enter force for the first time. RG-7's Minor / Correction
 *  hatch assumes a reviewed base in force (Issued / Locked — IN_FORCE_STATUSES,
 *  compared exactly as the gates compare), so it does not open such a
 *  rev-up: RevUpModal, setLevelRevUp and the merge rev-up route it to review
 *  for a non-controller under a policy that requires sign-off, exactly as a
 *  Draft's, and revertToVersion (the same write, as a Correction) refuses it
 *  up front naming the route (P25 review fix). The database refuses the same
 *  write (20261193). Every rev-up of a document in force (Issued / Locked)
 *  answers exactly as before. */
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
  // A revision through the gate: the document is IN FORCE (REV-28 (a): an
  // issue status no gate reads as in force — IFC — is not; it falls through).
  if (live.current && isControlledIssueStatus(live.status) && IN_FORCE_STATUSES.has(live.status ?? "")) {
    return { ...seen, firstIssue: false, requiresSignOff: false, mustReview: false };
  }
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
  // REV-28 (a) (P25): an issue status no gate reads as in force (IFC) — named as what it is
  if (gate.hasCurrentRevision && isControlledIssueStatus(gate.status)) {
    return `${label} is ${gate.status?.trim() ? `"${gate.status}"` : "in no status"} — not a status any gate reads as in force — so publishing ${rev} puts it in force for the first time`;
  }
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
      await applyEffectiveDate({ documentId: doc.id, versionId: newVersion.id ?? "", effectiveDate: input.effectiveDate ?? null, orgId });
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
      ...(input.notifyPush === false ? { notifyPush: false } : {}),
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
  // letter (2A -> 2B). RG-14 (P17 integrator fix): the same read carries the
  // document's own review policy and folder — the roster below opens under
  // the policy stored NOW, not the page's cached copy (see the resolution).
  const { data: docRow } = await supabase.from("documents").select("pending_version_id, rev, current_version_id, status, review_control, collection_id").eq("id", doc.id).maybeSingle();
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

  // RG-14 (P17 integrator fix): the policy the roster opens under is the
  // document's own review_control and folder as STORED — read above, in this
  // request — not the page's cached DocumentRecord. 20261159's stamp
  // (trg_review_signoff_owner_stamp) reads documents.review_control and
  // collection_id fresh at the roster's first row; a policy changed after the
  // page loaded (say to ownerMustApprove) would otherwise open a roster with
  // no owner slot under an owner:<uid> stamp, and the publish would be
  // refused after every reviewer signed. The folders and the library are
  // read fresh by effectiveReviewControlForDocument itself. A row the read
  // could not return falls back to the page's values, as the status check
  // above does. Unchanged policy → the same control as before.
  const control = await effectiveReviewControlForDocument({
    reviewControl: docRow ? ((docRow.review_control as ReviewControl | null | undefined) ?? null) : (doc.reviewControl ?? null),
    collectionId: docRow ? ((docRow.collection_id as string | null | undefined) ?? null) : (doc.collectionId ?? null),
    libraryId,
  });
  await openReviewRoster({
    orgId, documentId: doc.id, libraryId, versionId: insertedRow.id as string,
    revisionLabel: draftLabel, contentHash: fileHash, control, actorId: actorUserId, actorName: actorEmail,
    ...(input.notifyPush === false ? { notifyPush: false } : {}),
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

  // REV-28 (a) (document-control P25 review fix): a revert is the write a
  // rev-up makes — publish_revision moves the pointer and writes 'Issued'
  // (as a Correction) — so the first-issue rule binds it the same way: a
  // document whose status no gate reads as in force (IFC, an empty status,
  // a variant, a library's own, NULL) has no revision in force, and the
  // revert would put the earlier file in force for the first time,
  // unreviewed. 20261193 refuses that write for a non-controller under a
  // policy that requires sign-off; this door says so up front, in its own
  // words — a revert cannot be "submitted for review", so the route it names
  // is a Major revision of the earlier file through review, or Document
  // Control. Nothing is written before it. A document in force (Issued /
  // Locked) is asked nothing (RG-7's hatch, no policy read), and a retired
  // document is not refused here (the revert's own rules decide it, as
  // before). A controller's revert of such a document is recorded on the
  // REVERT event as a first issue made without the sign-off (DEC-63 §2).
  const label = doc.documentNumber || doc.title || "this document";
  let firstIssue: Awaited<ReturnType<typeof firstIssueGateForRevUp>>;
  try {
    firstIssue = await firstIssueGateForRevUp({ doc, libraryId, actor: { orgId, actorUserId, actorRole } });
  } catch (e) {
    throw new Error(`Couldn't verify the review policy for ${label} — nothing was reverted: ${(e as Error).message}`);
  }
  if (firstIssue.controllerOnly) throw new Error(`${describeControllerOnlyFirstIssue(label)} Nothing was reverted.`);
  if (firstIssue.mustReview) {
    throw new Error(
      `This library requires reviewer sign-off, and ${describeFirstIssue(label, firstIssue, revertedLabel)} — a first issue is not a revision through the review gate, so a revert (a Correction) doesn't exempt it. ` +
      "Nothing was reverted. Publish the earlier file as a Major revision through review, or ask Document Control, who may issue it.",
    );
  }

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
      // REV-28 (a) / DEC-63 §2 (P25 review fix): a controller's revert that
      // puts the document in force for the first time under a policy that
      // requires sign-off is recorded as such, as a rev-up's is.
      ...(firstIssue.firstIssue && firstIssue.requiresSignOff && !firstIssue.mustReview
        ? {
          reviewPolicy: `require — Rev ${revertedLabel} is ${doc.documentNumber || doc.title || "the document"}'s FIRST controlled issue, published WITHOUT the sign-off the policy requires, by controller ${actorUserId} (DEC-63 §2)`,
          firstIssueWithoutSignOff: true,
        }
        : {}),
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
}): Promise<{ priorStatus: string | null }> {
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
    .from("documents").select("legal_hold, status").eq("id", opts.documentId).maybeSingle();
  if (error) {
    throw new Error(`Couldn't confirm this document is free of a legal hold (${error.message}) — nothing was archived.`);
  }
  if ((data as { legal_hold?: boolean | null } | null)?.legal_hold === true) {
    throw new Error("This document is under legal hold and cannot be archived — a controller must release the legal hold first. Nothing was changed.");
  }
  // PROD-17 (P26): the status the archive retires it from, read with the
  // legal hold (no extra round trip); unknown is null.
  return { priorStatus: (data as { status?: string | null } | null)?.status ?? null };
}

export async function archiveDocument(input: ArchiveInput): Promise<void> {
  const { doc, reason, orgId, actorUserId, actorEmail, actorRole } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (!reason.trim()) throw new Error("Archive reason is required");

  // REV-6: every refusal the database would give an archive is asked first;
  // nothing has been written yet.
  const { priorStatus } = await authorizeArchive({ documentId: doc.id, libraryId: doc.libraryId, orgId, actorUserId, actorRole });

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

  // PROD-17 (document-control P26): an archive is a retirement — the
  // document's watchers are told and, when it takes away a controlled
  // issue, every copy holder is recalled, once, never awaited. (Until the
  // P28 integrator fix pass a Superseded row read just before the write got
  // neither again — skipsRetirementRecall — whether or not anything had
  // been sent for it; see DIST-16 done-when 2 below.)
  // P26 fix pass 4 (the integrator's ruling under DEC-90): the copy holders
  // are recalled only out of a controlled issue (recallsCopyHolders): a
  // Draft, In Review or Void row archived gets the watchers' FYI only. A
  // status the read did not give recalls (a second recall over none). The
  // archive tells no checkout holder or package owner itself, so they stay
  // in the watchers' audience.
  // DIST-16 done-when 2 (the P28 integrator fix pass): "already retired"
  // is the record's to say (`retiredFrom`, lib/staleCopies.ts
  // recallRetiredDocument), no longer this door's from the prior status.
  recallOnRetirement({
    orgId, documentId: doc.id, libraryId: doc.libraryId,
    docLabel: String(doc.documentNumber || doc.title || doc.name || "document"),
    newStatus: "Archived", replacementNote: null,
    actorUserId, actorName: actorEmail || actorUserId,
    personallyToldElsewhere: { checkoutHolder: false, packageOwners: false },
    recallCopyHolders: recallsCopyHolders(priorStatus),
    retiredFrom: priorStatus,
  });
}

// ─── REV-31 (the P28 integrator fix pass): a bulk archive's duties ──────────

/** One archived row's duties that did not complete, said by the door. */
export type BulkArchiveProblem = { documentId: string; label: string; problems: string[] };

/** REV-31 (document-control P28, the integrator's fix pass at the merge,
 *  2026-10-21, DEC-90): what archiveDocument does around each archive that a
 *  BULK archive did not — for every row the bulk write ARCHIVED (the library
 *  page's bulk archive, the bulk editor's Archived), after that write landed:
 *  the in-flight review draft voided (voidPendingDraftAfterPublish, REV-6),
 *  the live share links revoked (revokeLiveSharesForDocument, REV-10 /
 *  DIST-1), and the ARCHIVE_DOC record written with the ONE reason asked for
 *  the whole apply (`via` names the door) — the same checked routines and the
 *  same record fields archiveDocument writes. The retirement recall is NOT
 *  sent here: the door sends ONE batched recall per apply (lib/staleCopies.ts
 *  recallRetiredBatch), never one chain per row (PROD-17's burst). Rows run a
 *  few at a time. Never throws: every duty that did not complete — a draft
 *  not voided, a revoke refused, links still live, a SHARE_LINK_REVOKED row
 *  or the ARCHIVE_DOC record not written, a throw — is returned against its
 *  row, for the door to name; nothing is silently skipped. */
export async function finishBulkArchive(input: {
  orgId: string; actorUserId: string; actorEmail?: string | null; actorRole?: string | null;
  reason: string; via: "bulk_archive" | "bulk_edit";
  // REV-34 (a) / (d) (document-control P34): the library page's bulk archive
  // now gives each row's prior (`retiredFrom`), or says the row was already
  // Archived (`alreadyRetired`) — the record finishRetirementDuties writes.
  docs: Array<{ documentId: string; label: string; versionId?: string | null; retiredFrom?: string | null; priorStatusUnknown?: boolean; alreadyRetired?: boolean }>;
}): Promise<{ problems: BulkArchiveProblem[] }> {
  // document-control P31: the archive is now one case of
  // finishRetirementDuties — the same routines, the same record, unchanged.
  return finishRetirementDuties({ ...input, toStatus: "Archived" });
}

// ─── REV-31 (document-control P31 RETIREMENT DOOR PARITY) ────────────────────

/** The door a retirement's duties ran for (the record's `via`). */
export type RetirementDutyDoor = "bulk_archive" | "bulk_edit" | "metadata";

/** REV-31 (document-control P31 RETIREMENT DOOR PARITY, 2026-10-21, DEC-90):
 *  finishBulkArchive generalised to the three retired statuses, so every
 *  status-editor door that RETIRES a document does, after its write landed,
 *  the three retirement duties DEC-90 lists — the draft void, the link
 *  revocation and the record — in the single door's order (the status write
 *  first — the caller's — then the draft void and the link revocation, then
 *  the record). It is not all of what the single doors do: supersedeDocument
 *  also gates the write (the drawing-class MOC reference, authorizePublish —
 *  REV-33) and, after it, closes the pending distribution acks
 *  (closeStaleAcksForDocument, DIST-4) and sends the checkout holder and the
 *  package owners their own notices (REV-34); none of those is done here.
 *  The record per status:
 *   - Archived  (archiveDocument):  the ARCHIVE_DOC record, as before;
 *   - Superseded (supersedeDocument): the SUPERSEDE_DOC record, with the
 *     fields supersedeDocument writes — this door names no replacements and
 *     no MOC, so they are empty / null;
 *   - Void (the metadata editor's save — no single door voids a document;
 *     changeDocumentStatus is its door): the VOID_DOC record (registered in
 *     lib/auditActions.ts — no existing action meant "voided by a status
 *     change").
 *  Each: the in-flight review draft voided (voidPendingDraftAfterPublish,
 *  REV-6), the live share links revoked (revokeLiveSharesForDocument, REV-10
 *  / DIST-1), the record with the ONE reason for the apply (or the door's
 *  fixed sentence), `via` and — when the caller gives it — `retiredFrom`
 *  (the status the row was retired from, as the door read it; null =
 *  unknown, with `priorStatusUnknown: true` when the read failed) or, for a
 *  row the door read as already in the status it wrote (`alreadyRetired`:
 *  no retirement was made — the bulk editor's Archived over an Archived
 *  row), `alreadyRetired: true` and no `retiredFrom`. The
 *  retirement recall is NOT sent here (the door's own: ONE batched recall
 *  per bulk apply, changeDocumentStatus's for the metadata save). Rows run a
 *  few at a time. Never throws: every duty that did not complete is returned
 *  against its row, for the door to name.
 *
 *  REV-34 (c) / REV-33 (document-control P34, ruled by the integrator at
 *  the P31 merge, DEC-90): after the record, what supersedeDocument also does
 *  after its write —
 *   - a Superseded row's pending distribution acknowledgments are closed
 *     (DIST-4: `superseded_at` stamped on every pending ack of the document,
 *     closeStaleAcksForDocument's statement with the current version null)
 *     — checked: a refusal is returned against the row (a database before
 *     the column, 42703 / PGRST204, has nothing to close: today's path).
 *     Run for an already-Superseded row too (fail-safe, like the link
 *     revocation: acks an older door left open are closed);
 *   - the checkout holder's notice (notifyHolderOfRetirement, the existing
 *     revision_published_over_checkout kind, with the reason) for a row the
 *     door's gate found checked out by someone else (`checkoutHolder`, from
 *     gateStatusEditorRetirement) and actually retired by it (never for an
 *     `alreadyRetired` row: no retirement was made) — Superseded, and Void
 *     (its recorded lock override); a notice that could not be sent is
 *     returned against the row.
 *  And the SUPERSEDE_DOC record carries the MOC reference the door's gate
 *  accepted (`mocReference`, as supersedeDocument records it; null when none
 *  was given, as before). The package owners' own notice
 *  (notifyPackagesOfRetirement) is not sent here: the batched recall keeps
 *  them in the watchers' audience (not ruled — REV-34's residual). */
export async function finishRetirementDuties(input: {
  orgId: string; actorUserId: string; actorEmail?: string | null; actorRole?: string | null;
  toStatus: string; reason: string; via: RetirementDutyDoor;
  docs: Array<{
    documentId: string; label: string; versionId?: string | null; retiredFrom?: string | null; priorStatusUnknown?: boolean; alreadyRetired?: boolean;
    /** REV-33: the MOC reference the gate accepted (Superseded only). */
    mocReference?: string | null;
    /** REV-34 (c): the lock state the gate read — the holder told after the write. */
    checkoutHolder?: { checkedOutBy: string | null; checkedOutByName?: string | null } | null;
    /** The library, for the holder's notice link. */
    libraryId?: string | null;
  }>;
}): Promise<{ problems: BulkArchiveProblem[] }> {
  const problems: BulkArchiveProblem[] = [];
  const reason = input.reason.trim();
  const to = input.toStatus.trim();
  const kind = to === "Archived" ? { action: "ARCHIVE_DOC", noun: "archive" }
    : to === "Superseded" ? { action: "SUPERSEDE_DOC", noun: "supersession" }
    : to === "Void" ? { action: "VOID_DOC", noun: "void" }
    : null;
  const one = async (d: (typeof input.docs)[number]): Promise<void> => {
    const mine: string[] = [];
    try {
      if (!kind) throw new Error(`${input.toStatus} is not a retired status`);
      const draftVoid = await voidPendingDraftAfterPublish(d.documentId, input.actorUserId);
      if (draftVoid.problem) mine.push(`its review draft was not voided (${draftVoid.problem})`);
      const shares = await revokeLiveSharesForDocument(d.documentId, input.actorUserId);
      if (shares.error) mine.push(`its share links could not be revoked (${shares.error})`);
      if (shares.liveLeft === null) mine.push("whether share links are still live on it could not be read");
      else if (shares.liveLeft > 0) mine.push(`${shares.liveLeft} share link${shares.liveLeft === 1 ? " is" : "s are"} still live on it (another person's — Document Control must revoke ${shares.liveLeft === 1 ? "it" : "them"})`);
      if (shares.auditError) mine.push(shares.auditError);
      const duties = {
        pendingDraftVoided: draftVoid.voidedVersionId,
        pendingDraftVoidProblem: draftVoid.problem,
        revokedShareLinks: shares.revoked, shareRevokeError: shares.error,
        liveShareLinksLeft: shares.liveLeft, shareRevokeAuditError: shares.auditError,
      };
      // P31 final fix pass (DEC-90): a row the door read as ALREADY in this
      // status (the bulk editor's Archived over an Archived row — the duties
      // still run, fail-safe) made no retirement, so its record claims none:
      // `alreadyRetired: true`, and no `retiredFrom`.
      const prior = d.alreadyRetired === true
        ? { alreadyRetired: true }
        : "retiredFrom" in d
          ? { retiredFrom: d.retiredFrom ?? null, ...(d.priorStatusUnknown === true ? { priorStatusUnknown: true } : {}) }
          : {};
      const actor = {
        orgId: input.orgId,
        documentId: d.documentId,
        versionId: d.versionId ?? "",
        userId: input.actorUserId,
        userEmail: input.actorEmail ?? "",
        userRole: input.actorRole ?? "",
      };
      const res = kind.action === "ARCHIVE_DOC"
        ? await logRevisionEvent({ ...actor, type: "ARCHIVE_DOC", details: { reason, action: "archive", via: input.via, ...duties, ...prior } })
        : kind.action === "SUPERSEDE_DOC"
          ? await logRevisionEvent({
            ...actor, type: "SUPERSEDE_DOC",
            details: {
              reason, mocReference: d.mocReference?.trim() || null, replacementDocNumbers: [], resolvedReplacementIds: [], unresolvedDocNumbers: [],
              via: input.via, ...duties, ...prior,
            },
          })
          // logRevisionEvent's shape, written directly: its type list is lib/audit.ts's.
          : await logAuditAction({
            action: "VOID_DOC",
            resourceId: d.documentId,
            resourceType: "document",
            orgId: input.orgId,
            userId: input.actorUserId,
            userEmail: input.actorEmail ?? "",
            userRole: input.actorRole ?? "",
            details: { reason, action: "void", via: input.via, ...duties, ...prior, versionId: d.versionId ?? "" },
          });
      if (res && res.ok === false) mine.push(`its ${kind.action} record could not be written (${res.error ?? "refused"}), so the ${kind.noun} and its reason are not on its history`);
      // REV-34 (c) (P34): the checkout holder's notice, as supersedeDocument
      // sends it — only for a retirement this door made over someone else's
      // checkout (the gate read it before the write).
      const holder = d.checkoutHolder?.checkedOutBy ?? null;
      if (holder && d.alreadyRetired !== true && (kind.action === "SUPERSEDE_DOC" || kind.action === "VOID_DOC")) {
        mine.push(...await notifyHolderOfRetirement({
          preState: { checkedOutBy: holder, checkedOutByName: d.checkoutHolder?.checkedOutByName ?? null, activeHolds: [] },
          documentId: d.documentId, libraryId: d.libraryId ?? "", orgId: input.orgId,
          actorUserId: input.actorUserId, actorEmail: input.actorEmail ?? undefined,
          verb: kind.action === "SUPERSEDE_DOC" ? "superseded" : "voided",
          action: kind.action === "SUPERSEDE_DOC" ? "supersede" : "void",
          reason,
        }));
      }
      // REV-34 (c) (P34): DIST-4 — a superseded document's pending
      // confirmations no longer bind; close them, checked.
      if (kind.action === "SUPERSEDE_DOC") {
        const { data: closedAcks, error: ackErr } = await supabase
          .from("distribution_acks")
          .update({ superseded_at: new Date().toISOString() })
          .eq("document_id", d.documentId)
          .is("acknowledged_at", null)
          .is("superseded_at", null)
          .select("id");
        if (ackErr && !isMissingSchemaError(ackErr)) {
          mine.push(`its pending acknowledgment requests could not be closed (${ackErr.message}), so they still read as open`);
        } else if (!ackErr && ((closedAcks as unknown[] | null) ?? []).length > 0) {
          console.info(`[retire] DIST-4: ${((closedAcks as unknown[] | null) ?? []).length} pending acknowledgment request(s) of ${d.documentId} closed by the ${input.via} supersession`);
        }
      }
    } catch (e) {
      mine.push(`its ${kind?.noun ?? "retirement"} duties stopped part-way (${(e as Error)?.message ?? String(e)})`);
    }
    if (mine.length > 0) {
      console.error(`[retire] REV-31: the ${input.via} ${kind?.noun ?? "retirement"} of ${d.documentId} did not complete: ${mine.join("; ")}`);
      problems.push({ documentId: d.documentId, label: d.label, problems: mine });
    }
  };
  const queue = [...new Map(input.docs.map((d) => [d.documentId, d])).values()];
  const worker = async () => { for (let d = queue.shift(); d; d = queue.shift()) await one(d); };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  const order = new Map(input.docs.map((d, i) => [d.documentId, i]));
  problems.sort((a, b) => (order.get(a.documentId) ?? 0) - (order.get(b.documentId) ?? 0));
  return { problems };
}

// ─── REV-23 (P19): the stamped put-back's recorded door ─────────────────────
// 20261165 binds a controller's bare put-back of a held, stamped retirement
// (the revision a Superseded / Archived / Void retirement took away, put back
// into an issue status — the guard's v_restoring) as REV-20 / REV-22 bound
// every other controller write that issues over a hold: it passes only under
// the transaction-local flag a recording function sets. The app's put-backs
// therefore go through put_back_retired_issue (SECURITY INVOKER: the same
// write, run as the caller under their row-level policies and the guard),
// which — for Document Control putting back a held stamped retirement into
// an issue status, when the caller asks for the force (forceHold — the
// un-archive dialog only after Document Control confirmed restoring over the
// holds it showed; the rollbacks always, as they put back the state from
// before the operation) and, for a rollback, only for a retirement the
// caller made (superseded_by_user = the session), and only then — sets the
// flag around its own write and records REV_HOLD_OVERRIDDEN in the same
// transaction. Anyone else's call is exactly the bare write. Each caller
// keeps its own direct write for a database without the function (PGRST202 /
// 42883), byte for byte as before.

/** Which put-back is being made — put_back_retired_issue's p_via, and the
 *  write it makes: the un-archive's (the archive fields cleared) or a
 *  rollback's (the supersession fields put back as they were). */
export type RetiredIssuePutBackDoor = "unarchive" | "supersede_rollback" | "lifecycle_rollback" | "reversal_rollback";

/** The supersession fields a rollback puts back (as read before the
 *  retirement; absent = NULL). */
export interface PutBackSupersessionFields {
  superseded_at?: unknown;
  superseded_by_user?: unknown;
  supersession_reason?: unknown;
  supersession_moc?: unknown;
}

/** What put_back_retired_issue answered: `landed` (restored — `recorded`
 *  when it was Document Control's recorded pass over a hold,
 *  restored_over_hold), `refused` (the guard's or the policies' refusal, an
 *  unknown answer, or — `noRow` — a write that matched no row the caller may
 *  change: the caller's refusal, no direct write is tried), or `absent` (the
 *  database predates 20261165: the caller makes its own direct write, as
 *  before). */
export type RetiredIssuePutBack =
  /** `putBackAs` (REV-29, P25): set only when the status written is not the
   *  one asked for — a NULL prior status put back as `olderBodyStatus` on a
   *  database whose put_back_retired_issue predates 20261192. */
  | { kind: "landed"; recorded: boolean; putBackAs?: string }
  | { kind: "refused"; reason: string; noRow?: boolean }
  | { kind: "absent" };

/** REV-29 (P25): put_back_retired_issue's refusal of a blank status. Since
 *  20261192 its rollback doors take a NULL (or blank) status — what the
 *  document was — and only the un-archive door refuses one; before that
 *  paste (20261165's body) every door refused it. */
export const PUT_BACK_BLANK_STATUS_REFUSAL = "put_back_retired_issue: name the status to put the document back to.";

/** REV-29 (P25): how a rollback names the status it puts back — a NULL or
 *  blank one as what it is, never as "Issued". */
export function describePutBackStatus(status: string | null | undefined): string {
  if (status === null || status === undefined) return "no status (the status it had)";
  return status.trim() ? status : "an empty status (the status it had)";
}

/** REV-23 (P19): PostgREST's answer for a function that does not exist yet
 *  (PGRST202 — its schema cache — or Postgres' undefined_function): the
 *  database predates 20261165, so the put-back takes the direct write. */
export function isMissingPutBackRpc(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!e) return false;
  const code = String(e.code ?? "");
  return code === "PGRST202" || code === "42883"
    || /could not find the function|function .*put_back_retired_issue.* does not exist/i.test(e.message ?? "");
}

/** REV-23 (P19): put a retired document back through put_back_retired_issue
 *  — the write the caller would make (the un-archive's, or a rollback's with
 *  the supersession fields it names), recorded when Document Control puts a
 *  held, stamped retirement back into an issue status AND asks for the force
 *  (`forceHold` — an override over a hold is chosen, never implied: without
 *  it the write is the bare one, which the guard refuses over a hold for
 *  Document Control). Never throws: the caller turns `refused` into its own
 *  refusal and makes its direct write on `absent`. */
export async function putBackRetiredIssue(input: {
  documentId: string;
  /** REV-29 (P25): what the document WAS — a NULL (or blank) status
   *  included, for a rollback door (since 20261192 the function takes it). */
  status: string | null;
  door: RetiredIssuePutBackDoor;
  reason?: string | null;
  /** Ask for Document Control's recorded pass over an active hold (p_force_hold). */
  forceHold?: boolean;
  /** REV-19 (a) (P23 fix pass): whether to name this door to the database's
   *  issue record (20261205) — the caller's own probe answer when it asked
   *  one (the un-archive); absent, this put-back asks it. */
  nameDoor?: boolean;
  supersession?: PutBackSupersessionFields;
  /** REV-29 (P25): the status this rollback put back before P25 for a NULL
   *  prior status (`?? "Issued"`). Put back INSTEAD only when the database's
   *  put_back_retired_issue predates 20261192 and refuses the NULL in its
   *  blank-status sentence — the rollback then lands exactly as it did
   *  before that paste (an older body takes today's path). Never used once
   *  20261192 is pasted. */
  olderBodyStatus?: string;
}): Promise<RetiredIssuePutBack> {
  const s = input.supersession;
  // REV-19 (a) (P23): every put-back names its door (p_via: the un-archive,
  // or the rollback of a failed supersede / split / merge / reversal) to the
  // database's issue record (20261205) — withIssueDoor — so a rollback's
  // put-back is never recorded as a direct database write. P23 fix pass:
  // named only once that record exists (the probe), so a database before the
  // paste is sent no custom header at all.
  const nameDoor = input.nameDoor ?? await isStatusIssueRecordedByDatabase();
  const putBack = (status: string | null) => withIssueDoor(supabase.rpc("put_back_retired_issue", {
    p_document_id: input.documentId,
    p_status: status,
    p_via: input.door,
    p_reason: input.reason?.trim() || null,
    p_force_hold: input.forceHold === true,
    ...(input.door === "unarchive" ? {} : {
      p_superseded_at: s?.superseded_at ?? null,
      p_superseded_by_user: s?.superseded_by_user ?? null,
      p_supersession_reason: s?.supersession_reason ?? null,
      p_supersession_moc: s?.supersession_moc ?? null,
    }),
  }), nameDoor ? input.door : null);
  let { data, error } = await putBack(input.status);
  // REV-29 (P25): 20261165's body refuses a NULL status (raised before any
  // write: nothing was changed) — before 20261192 the rollback takes today's
  // path, the status it put back before P25.
  let putBackAs: string | undefined;
  if (error && input.olderBodyStatus !== undefined && input.status === null && (error.message ?? "").includes(PUT_BACK_BLANK_STATUS_REFUSAL)) {
    putBackAs = input.olderBodyStatus;
    ({ data, error } = await putBack(putBackAs));
  }
  if (error) {
    return isMissingPutBackRpc(error) ? { kind: "absent" } : { kind: "refused", reason: error.message || "the put-back was refused" };
  }
  // REV-29 (P25): landed as the older body's status — said so to the caller.
  if (putBackAs !== undefined && (data === "restored" || data === "restored_over_hold")) return { kind: "landed", recorded: data === "restored_over_hold", putBackAs };
  if (data === "restored" || data === "restored_over_hold") return { kind: "landed", recorded: data === "restored_over_hold" };
  if (data === "no_match") return { kind: "refused", reason: "the write was refused", noRow: true };
  return { kind: "refused", reason: `the database answered ${JSON.stringify(data ?? null)}` };
}

/** OWN-15: the statuses an unarchive may restore to — never an arbitrary
 *  string (documents.status has no CHECK constraint). REV-27 (P25): beside
 *  them, only the archive's own stamped status when no gate reads it as in
 *  force (unarchiveStampedRestoreStatus) — the put-back of what it was. */
export const UNARCHIVE_RESTORE_STATUSES = ["Issued", "Draft", "In Review"] as const;

/** REV-27 (document-control P25; decided and recorded with DEC-77): the
 *  status an un-archive may restore BESIDES UNARCHIVE_RESTORE_STATUSES — the
 *  archive's own stamped status (20261144's retirement stamp), when the
 *  stamp names the current revision and its status is one no gate reads as
 *  in force (an IFC drawing archived as IFC, a library's own status).
 *  Restoring it puts back exactly what the document was — the guard's
 *  v_restoring, the put-back 20261185 still spares — so it is offered as a
 *  put-back, never as a new choice (DEC-77 §1 keeps IFC out of the
 *  editors). Null otherwise: no stamp, a stamp naming another revision, an
 *  Issued / Locked stamp (Issued is offered anyway), 'not-issued', and a
 *  NULL or blank stamp (put_back_retired_issue's un-archive door refuses a
 *  blank status, so what it was cannot be restored — the dialog says so and
 *  defaults to a Draft). Pure. */
export function unarchiveStampedRestoreStatus(row: {
  currentVersionId: string | null; retiredIssueStatus?: string | null; retiredIssueVersionId?: string | null;
}): string | null {
  const stamp = row.retiredIssueStatus ?? null;
  if (!row.currentVersionId || (row.retiredIssueVersionId ?? null) !== row.currentVersionId) return null;
  if (stamp === null || !stamp.trim() || stamp === RETIRED_NOT_ISSUED_STAMP || IN_FORCE_STATUSES.has(stamp)) return null;
  if ((UNARCHIVE_RESTORE_STATUSES as readonly string[]).includes(stamp)) return null;
  return isControlledIssueStatus(stamp) ? stamp : null;
}

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
 *  UNARCHIVE_RESTORE_STATUSES either way. Read-only.
 *
 *  REV-27 (document-control P25): `issued` now means what it says — the
 *  stamp names the current revision AND an in-force status (Issued /
 *  Locked), whose restore into Issued is the put-back of that issue. A stamp
 *  naming the current revision with a status no gate reads as in force (an
 *  IFC drawing archived; 20261185 judges its restore into Issued as a first
 *  entry into force, not a put-back) is `not-in-force`: it is read as what
 *  it was — `stampedStatus` — and comes back as that status (`stampedRestore`,
 *  unarchiveStampedRestoreStatus), or as a Draft when what it was cannot be
 *  restored (a NULL or blank status: `stampedRestore` null). Never Issued
 *  by default: that would put an unreviewed revision in force. */
export async function unarchiveRestoreDefault(documentId: string): Promise<{
  status: string; basis: "issued" | "not-in-force" | "not-issued" | "unknown";
  stampedStatus?: string | null; stampedRestore?: string | null;
}> {
  const { data, error } = await supabase.from("documents")
    .select("current_version_id, retired_issue_status, retired_issue_version_id").eq("id", documentId).maybeSingle();
  if (error || !data) return { status: "Issued", basis: "unknown" };
  const current = (data.current_version_id as string | null) ?? null;
  const stampedVersion = (data.retired_issue_version_id as string | null) ?? null;
  if (current && stampedVersion === current) {
    const stamp = (data.retired_issue_status as string | null) ?? null;
    if (IN_FORCE_STATUSES.has(stamp ?? "")) return { status: "Issued", basis: "issued" };
    const own = unarchiveStampedRestoreStatus({ currentVersionId: current, retiredIssueStatus: stamp, retiredIssueVersionId: stampedVersion });
    return { status: own ?? "Draft", basis: "not-in-force", stampedStatus: stamp, stampedRestore: own };
  }
  if (current && !stampedVersion && data.retired_issue_status === RETIRED_NOT_ISSUED_STAMP) return { status: "Draft", basis: "not-issued" };
  return { status: "Issued", basis: "unknown" };
}

/** REV-27 (P25): the archive's own stamped status this un-archive may
 *  restore besides UNARCHIVE_RESTORE_STATUSES (unarchiveStampedRestoreStatus),
 *  read from the row now — null when the row is not Archived, carries no
 *  such stamp, or cannot be read (fails closed: nothing more is admitted). */
async function readArchiveStampedRestore(documentId: string): Promise<string | null> {
  const { data: row, error } = await supabase.from("documents")
    .select("status, current_version_id, retired_issue_status, retired_issue_version_id").eq("id", documentId).maybeSingle();
  if (error || !row || row.status !== "Archived") return null;
  return unarchiveStampedRestoreStatus({
    currentVersionId: (row.current_version_id as string | null) ?? null,
    retiredIssueStatus: (row.retired_issue_status as string | null) ?? null,
    retiredIssueVersionId: (row.retired_issue_version_id as string | null) ?? null,
  });
}

export async function unarchiveDocument(input: ArchiveInput & {
  restoreStatus?: string;
  /** REV-23 (P19): Document Control confirmed restoring over the active
   *  holds the dialog showed — the recorded pass (put_back_retired_issue's
   *  p_force_hold). Never set without that confirmation. */
  forceHold?: boolean;
}): Promise<StatusIssueOutcome> {
  const { doc, reason, orgId, actorUserId, actorEmail, actorRole, restoreStatus } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (restoreStatus && !(UNARCHIVE_RESTORE_STATUSES as readonly string[]).includes(restoreStatus)) {
    // REV-27 (P25): beside the three, only the archive's own stamped status
    // (what it was — unarchiveStampedRestoreStatus), for that stamp only,
    // read now (fails closed: an unreadable row admits nothing more).
    const own = await readArchiveStampedRestore(doc.id);
    if (own === null || own !== restoreStatus) {
      throw new Error(`Cannot restore to "${restoreStatus}" — choose Issued, Draft or In Review.`);
    }
  }

  const restoredStatus = restoreStatus || "Issued";
  // REV-19: what this restore issues, read BEFORE the write — the publish
  // guard (20261144) clears the retirement stamp as the document leaves its
  // retirement, so afterwards it can no longer say whether this is the
  // put-back of the issue the archive took away. REV-27 (P25): read for the
  // restore's target, so a restore into Issued of a stamp no gate reads as
  // in force is a first entry into force (isEntryIntoForce), not a put-back.
  const before = isControlledIssueStatus(restoredStatus) ? await readStatusIssueBasis(doc.id, doc, restoredStatus) : null;
  const now = new Date().toISOString();
  const notRestored = "The document was NOT restored — you don't have authority to change it, or it is no longer visible to you. Nothing was changed.";
  // REV-23 (P19): through put_back_retired_issue (20261165) — the same write,
  // run as the caller, recorded (REV_HOLD_OVERRIDDEN) when Document Control
  // un-archives a held, stamped document into an issue status having
  // confirmed restoring over the hold (forceHold), which the guard no longer
  // admits bare. Without that confirmation the write is the bare one — over
  // a hold the guard refuses it in the new-door sentence, and the dialog
  // offers the Draft restore. Its refusal is this restore's refusal; the
  // direct write below only while the function is absent.
  // REV-19 (a) (P23 fix pass): asked once, before the write, only for a
  // restore into an issue status — it decides whether the write names its
  // door (no custom header before 20261205) and who writes the record.
  const recordedByDatabase = before ? await isStatusIssueRecordedByDatabase() : false;
  const door = await putBackRetiredIssue({
    documentId: doc.id, status: restoredStatus, door: "unarchive", reason: reason?.trim() || "Restored from archive",
    nameDoor: recordedByDatabase,
    forceHold: input.forceHold === true,
  });
  if (door.kind === "refused") {
    throw new Error(door.noRow ? notRestored : `The document was NOT restored (${door.reason}) — nothing was changed.`);
  }
  if (door.kind === "absent") {
    // P13 third review fix: a checked write, as archiveDocument's — a restore
    // the database filtered to zero rows (no edit access to the row) is a
    // refusal, never a silent success, and writes no un-archive event.
    const { data: restored, error } = await withIssueDoor(supabase
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
      .select("id"), recordedByDatabase ? "unarchive" : null);

    if (error) throw new Error(`The document was NOT restored (${error.message}) — nothing was changed.`);
    if (((restored as unknown[] | null) ?? []).length === 0) {
      throw new Error(notRestored);
    }
  }

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: doc.currentVersionId ?? "",
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "ARCHIVE_DOC",
    details: {
      reason: reason?.trim() || "Restored from archive", action: "unarchive", restoredStatus,
      // REV-23 (P19): the restore passed an active hold, recorded beside it
      ...(door.kind === "landed" && door.recorded ? { holdOverridden: "REV_HOLD_OVERRIDDEN" } : {}),
    },
  });
  // DIST-16 (document-control P28): back in force — the retirement recall
  // standing on it is withdrawn (lib/staleCopies.ts withdrawRetirementRecall;
  // nothing for a restore into Draft / In Review), fired, never awaited.
  void import("@/lib/staleCopies").then(({ withdrawRetirementRecall }) => withdrawRetirementRecall({
    orgId, documentId: doc.id!, libraryId: doc.libraryId,
    docLabel: String(doc.documentNumber || doc.title || doc.name || "") || null,
    restoredStatus, door: "unarchive", actorUserId, actorName: actorEmail || actorUserId,
  })).catch((e) => console.error(`[revisions] DIST-16: the recall withdrawal of document ${doc.id} did not run`, e));

  // REV-19: an un-archive into an issue status is an issue — its clocks and
  // its record (a put-back of the stamped issue keeps the clocks it had; a
  // first entry into force — REV-27 — opens the roster and keeps the review
  // clock as it was).
  if (before && isIssueTransition({ fromStatus: before.fromStatus, toStatus: restoredStatus, hasCurrentRevision: !!before.versionId })) {
    return await recordStatusIssue({
      orgId, documentId: doc.id, fromStatus: before.fromStatus, toStatus: restoredStatus,
      versionId: before.versionId, rev: before.rev, putBack: before.putBack, door: "unarchive",
      actorUserId, actorEmail: actorEmail ?? null, actorRole: actorRole ?? null,
      entryIntoForce: before.entryIntoForce, recordedByDatabase,
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

/** REV-19 (a) (P23 fix pass): every door the database's issue record names
 *  from the request header — the status editors', the un-archive's, and the
 *  rollbacks' put-backs (put_back_retired_issue's p_via). */
export type IssueRecordDoor = StatusIssueDoor | Exclude<RetiredIssuePutBackDoor, "unarchive">;

/** REV-19 (a) (document-control P23, 20261205): the request header an app
 *  door sends with its status write, naming the door on the record the
 *  database writes (record_document_status_issue reads it from PostgREST's
 *  request.headers; any write without it is recorded as door 'direct'). */
export const ISSUE_DOOR_HEADER = "x-mos-issue-door";

/** REV-19 (a) (P23): name the app's door on a status write. A client (or
 *  test double) without supabase-js's per-request `setHeader` sends the
 *  write as before — the database then records the door as 'direct'; the
 *  record itself is never skipped. `door` null: the write is unchanged. */
export function withIssueDoor<T>(builder: T, door: IssueRecordDoor | null): T {
  const b = builder as unknown as { setHeader?: (name: string, value: string) => T };
  return door && typeof b?.setHeader === "function" ? b.setHeader(ISSUE_DOOR_HEADER, door) : builder;
}

/** REV-19 (a) (P23, DEC-104): does the database write DOCUMENT_ISSUED for
 *  a status-change issue itself? True once 20261205's AFTER UPDATE trigger
 *  is bound and enabled (document_status_issue_recorded_by_database) — the
 *  ONE writer of that record: the app's doors then write none of their own.
 *  Missing (PGRST202 / 42883: a database before 20261205), false, or any
 *  error: the app writes the record, as before 20261205 (a failed probe on a
 *  database that has the trigger means two rows, never none). Asked on every
 *  write to an issue status, just BEFORE it (P23 fix pass: the answer also
 *  decides whether the write names its door — no custom header is sent to a
 *  database before 20261205) — never cached, so a paste mid-session takes
 *  effect at once (a paste between the probe and the write: two rows). */
export async function isStatusIssueRecordedByDatabase(): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("document_status_issue_recorded_by_database");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

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
  /** The issue record could not be written (the issue itself stands). P23
   *  fix pass: also set, on an outcome that issued nothing, when a
   *  read-failed write's follow-up row (the database recorded it; this door
   *  started no clock) could not be written. */
  recordError: string | null;
  /** REV-26 / REV-27 (document-control P25): set (true) only when the
   *  issue put the current revision in force for the FIRST time — out of an
   *  issue status no gate reads as in force (IFC, an empty status, a variant,
   *  a library's own, NULL), directly or out of a retirement stamped with it
   *  (isEntryIntoForce). `putBack` is then false (nothing in force was taken
   *  away), the acknowledgment roster was opened, and the review clock was
   *  NOT reset (no evidence the revision was reviewed now). Absent on every
   *  other outcome. */
  entryIntoForce?: true;
  /** REV-19 (P17 integrator fix): set only by changeDocumentStatus, only
   *  when it wrote a controlled issue status but recorded no issue — the
   *  basis its pre-write read gave (StatusIssueNotRecorded). Absent on every
   *  other outcome. */
  notRecordedBecause?: StatusIssueNotRecorded;
  /** REV-31 (document-control P31): set only by changeDocumentStatus, asked
   *  with reportRetirement, only when its write RETIRED the document — the same rule its retirement
   *  recall fires on (into Superseded / Void / Archived from another status,
   *  or from a prior its read could not give). `retiredFrom` is the prior the
   *  read gave (null when unknown or empty); `priorStatusUnknown` that the
   *  read failed. The caller runs the retirement's duties from it
   *  (finishRetirementDuties). Absent on every other outcome. */
  retired?: { retiredFrom: string | null; priorStatusUnknown: boolean };
}

/** REV-19 (P17 integrator fix): why changeDocumentStatus wrote an issue
 *  status without recording an issue (it started no clock and wrote no
 *  DOCUMENT_ISSUED either way):
 *   - 'read_failed': the row's state before the write could not be read —
 *     whether this write issued it is unknown, so nothing was recorded; the
 *     editor says to check its history and start its clocks if owed;
 *   - 'already_issued': the row was already in an issue status — this write
 *     issued nothing (it was issued by another change, e.g. after the
 *     editor's page loaded), so nothing is owed for this write;
 *   - 'no_current_revision': the row has no current revision — there was
 *     nothing to issue (a register row). */
export type StatusIssueNotRecorded = "read_failed" | "already_issued" | "no_current_revision";

const NO_STATUS_ISSUE: StatusIssueOutcome = { issued: false, putBack: false, complianceClockErrors: [], recordError: null };

/** `readFailed`: the row could not be read and the other fields are the
 *  caller's fallback (REV-19, P17 integrator fix). */
interface StatusIssueBasis { fromStatus: string | null; versionId: string | null; rev: string | null; putBack: boolean | null; entryIntoForce: boolean; readFailed?: boolean }

/** The document as a status-change issue reads it (its status, current
 *  revision and 20261144's retirement stamp). */
interface StatusIssueRow {
  status: string | null; currentVersionId: string | null;
  retiredIssueStatus?: string | null; retiredIssueVersionId?: string | null;
}

/** REV-26 / REV-27 (document-control P25; DEC-77's REV-26 line): does this
 *  status change put the current revision IN FORCE (IN_FORCE_STATUSES — the
 *  field pack prints it, a scan reads it current) for the FIRST time, out of
 *  an issue status no gate reads as in force — an existing IFC row, an empty
 *  status, a case or spacing variant, a library's own, a NULL status?
 *  Either directly (lib/documentStatusOptions.ts isUnguardedEntryIntoForce —
 *  the guard's REV-21 limb of v_issuing, 20261185) or out of a retirement
 *  whose stamp names the current revision with such a status (an IFC drawing
 *  archived, then restored into Issued: 20261185's second block takes it
 *  out of the guard's v_restoring, so it is no put-back). Nothing in force
 *  was taken away, so it is not a put-back; nothing records that its
 *  revision was reviewed now. Decided (REV-26, recorded on DEC-77): such a
 *  move OWES REV-19's record — DOCUMENT_ISSUED, the policy decision — and
 *  opens the acknowledgment roster for the revision (it is now the copy the
 *  field works from), but it does NOT reset the review clock: a reset would
 *  mark the document reviewed today on no evidence and could hide a review
 *  already due. Pure. */
export function isEntryIntoForce(row: StatusIssueRow, toStatus: string | null | undefined): boolean {
  if (!row.currentVersionId || !IN_FORCE_STATUSES.has(toStatus ?? "")) return false;
  if (isUnguardedEntryIntoForce({ fromStatus: row.status, toStatus, hasCurrentRevision: true })) return true;
  return isRetiredStatus(row.status)
    && (row.retiredIssueVersionId ?? null) === row.currentVersionId
    && !IN_FORCE_STATUSES.has(row.retiredIssueStatus ?? "");
}

/** P14 review fix (REV-19): is an issue out of this status the put-back of
 *  the issue its retirement took away? Three-state, from the evidence alone
 *  (StatusIssueOutcome.putBack): `true` only when 20261144's stamp names the
 *  current revision; `false` only on evidence of a new issue — the document
 *  is leaving a Draft / In Review (WORK_IN_PROGRESS_STATUSES), or a
 *  retirement the guard stamped 'not-issued' (RETIRED_NOT_ISSUED_STAMP, no
 *  revision); `null` otherwise — a retirement with no stamp (before
 *  20261144, or the service role), a stamp naming another revision, a
 *  database without the stamp columns. A missing stamp is no evidence
 *  (P13 third review fix), so it never restarts the review clock.
 *
 *  REV-27 (document-control P25): it answers the guard's v_restoring FOR
 *  THE RESTORE'S TARGET when the caller names one (`toStatus`): since
 *  20261185 a put-back INTO Issued / Locked of a stamp outside them (an IFC
 *  drawing archived, restored into Issued) is not v_restoring — nothing in
 *  force was taken away — so it is `false`, not a put-back (isEntryIntoForce
 *  says what it owes instead). A put-back to the stamped status itself, and
 *  an Issued / Locked stamp put back into Issued, stay `true`. Without a
 *  target the answer is the one it always gave. */
export function putBackFromRetirementStamp(row: StatusIssueRow, toStatus?: string | null): boolean | null {
  if (WORK_IN_PROGRESS_STATUSES.has((row.status ?? "").trim())) return false;
  if (!isRetiredStatus(row.status)) return null;
  const stampedVersion = row.retiredIssueVersionId ?? null;
  if (row.currentVersionId && stampedVersion === row.currentVersionId) return !isEntryIntoForce(row, toStatus);
  if (!stampedVersion && row.retiredIssueStatus === RETIRED_NOT_ISSUED_STAMP) return false;
  return null;
}

/** The document as a status change finds it — its status, current revision
 *  and whether an exit from its retirement puts back the stamped issue
 *  (putBackFromRetirementStamp). `select("*")` so a database without
 *  20261144's stamp columns still answers (the stamp reads as absent: the
 *  put-back unknown). An unreadable row falls back to what the caller holds,
 *  with the put-back unknown. REV-26 / REV-27 (P25): read for the write's
 *  target (`toStatus`), so a first entry into force (isEntryIntoForce) is
 *  told apart — `entryIntoForce`, and `putBack` false: no put-back. */
async function readStatusIssueBasis(documentId: string, held?: Pick<DocumentRecord, "status" | "currentVersionId" | "rev">, toStatus?: string | null): Promise<StatusIssueBasis> {
  const { data, error } = await supabase.from("documents").select("*").eq("id", documentId).maybeSingle();
  if (error || !data) {
    return { fromStatus: held?.status ?? null, versionId: held?.currentVersionId ?? null, rev: held?.rev ?? null, putBack: null, entryIntoForce: false, readFailed: true };
  }
  const row = data as Record<string, unknown>;
  const fromStatus = (row.status as string | null) ?? null;
  const versionId = (row.current_version_id as string | null) ?? null;
  const stamped: StatusIssueRow = {
    status: fromStatus, currentVersionId: versionId,
    retiredIssueStatus: (row.retired_issue_status as string | null | undefined) ?? null,
    retiredIssueVersionId: (row.retired_issue_version_id as string | null | undefined) ?? null,
  };
  const entryIntoForce = isEntryIntoForce(stamped, toStatus);
  return {
    fromStatus, versionId, rev: (row.rev as string | null) ?? null,
    putBack: entryIntoForce ? false : putBackFromRetirementStamp(stamped, toStatus),
    entryIntoForce,
  };
}

/** What a landed status-change issue did to its compliance clocks, by the
 *  put-back's three states — the sentence DOCUMENT_ISSUED records. */
export const STATUS_ISSUE_CLOCKS_NOTE = {
  putBack: "the put-back of the issue its retirement took away (the retirement stamp names this revision): the review clock and the acknowledgment roster it had keep running, not restarted",
  newIssue: "a new issue: the review clock and the acknowledgment roster were started",
  unknown: "no evidence whether this puts back the issue its retirement took away (the retirement carries no stamp — retired before 20261144 or by the service role — names another revision, or could not be read): the review clock was NOT reset (a reset would mark the document reviewed today and could hide a review already due); only the acknowledgment roster was opened for this revision",
  entryIntoForce: "a first entry into force out of a status no gate reads as in force (IFC, an empty status, a variant, a library's own, or no status — directly, or out of a retirement stamped with it): nothing in force was taken away, so it is no put-back, and nothing records that this revision was reviewed now, so the review clock was NOT reset (a reset would mark the document reviewed today and could hide a review already due); the acknowledgment roster was opened for this revision (DEC-77, REV-26)",
} as const;

/** REV-19 (a) (P23 fix pass): the follow-up rows an app door writes after the
 *  database's DOCUMENT_ISSUED (20261205) — what it started, or what did not
 *  start. Absence of both reads as "nothing was started". */
export const CLOCKS_STARTED_ACTION = "COMPLIANCE_CLOCKS_STARTED";
export const CLOCKS_NOT_STARTED_ACTION = "COMPLIANCE_CLOCKS_NOT_STARTED";
const OWED_FOLLOW_UP = "This record was written with the status change, before any clock could start: an app door that starts them records the outcome on the row that follows (COMPLIANCE_CLOCKS_STARTED, or COMPLIANCE_CLOCKS_NOT_STARTED for what did not start); with neither row, nothing was started";
/** REV-19 (a) (P23 fix pass): the sentence the DATABASE's DOCUMENT_ISSUED
 *  records (20261205 record_document_status_issue — pinned to its body by
 *  test), by the put-back's three states: what the issue OWES its compliance
 *  clocks, never that a clock started — the row is written in the status
 *  change's own transaction, before any door could start one, and whatever
 *  header the write carried (a header is the caller's claim). A put-back owes
 *  nothing and is never told to restart the review clock, whichever door
 *  (or none) made it. */
export const STATUS_ISSUE_CLOCKS_OWED_NOTE = {
  putBack: "the put-back of the issue its retirement took away (the retirement stamp names this revision): nothing is owed — the review clock and the acknowledgment roster it had keep running and are not to be restarted (a restart would mark the document reviewed today and could hide a review already due)",
  newIssue: `a new issue: it owes the review clock and the acknowledgment roster for this revision. ${OWED_FOLLOW_UP} — Document Control then starts both from the document`,
  unknown: `no evidence whether this puts back the issue its retirement took away (the retirement carries no stamp — retired before 20261144 or by the service role — or names another revision): it owes the acknowledgment roster for this revision only — the review clock is not to be reset (a reset would mark the document reviewed today and could hide a review already due). ${OWED_FOLLOW_UP} — Document Control then opens the roster from the document and leaves the review clock as it is`,
  entryIntoForce: `a first entry into force out of a status no gate reads as in force (IFC, an empty status, a variant, a library's own, or no status — directly, or out of a retirement stamped with it): it owes the acknowledgment roster for this revision only — the review clock is not to be reset (nothing records that this revision was reviewed now; a reset would mark the document reviewed today and could hide a review already due). ${OWED_FOLLOW_UP} — Document Control then opens the roster from the document and leaves the review clock as it is`,
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
  /** REV-26 / REV-27 (P25): a first entry into force (isEntryIntoForce) —
   *  recorded as an issue, the acknowledgment roster opened, the review
   *  clock NOT reset (no evidence the revision was reviewed now). */
  entryIntoForce?: boolean;
  /** REV-19 (a) (P23 fix pass): the door's own probe answer, asked before its
   *  write (isStatusIssueRecordedByDatabase); absent, asked here. */
  recordedByDatabase?: boolean;
  /** notifications N17 (R2): false from a multi-document door (the bulk
   *  status editor, through changeDocumentStatus) — passed to
   *  startIssuedDocumentClocks; the bell rows and emails are unchanged. */
  notifyPush?: boolean;
}): Promise<StatusIssueOutcome> {
  const complianceClockErrors: string[] = [];
  const entryIntoForce = input.entryIntoForce === true;
  // A NEW issue on evidence resets the review clock; a first entry into
  // force (P25) does not — nothing says its revision was reviewed now.
  const reviewClock = input.putBack === false && !entryIntoForce;
  if (input.putBack !== true) {
    try {
      complianceClockErrors.push(...await startIssuedDocumentClocks({
        orgId: input.orgId, documentId: input.documentId, actorUserId: input.actorUserId, actorName: input.actorEmail ?? null,
        // No evidence (null), or a first entry into force: the review clock
        // is left as it was; only the roster for this revision is opened.
        reviewClock,
        ...(input.notifyPush === false ? { notifyPush: false } : {}),
      }));
    } catch (e) {
      complianceClockErrors.push(`the start failed (${(e as Error).message})`);
    }
  }
  // REV-19 (a) (P23, DEC-104): since 20261205 the database writes
  // DOCUMENT_ISSUED itself, in the write's own transaction, in this shape
  // (the door this caller named — withIssueDoor —, the statuses, the
  // revision, putBack, entryIntoForce, the policy decision, the clock
  // fields) — the ONE writer, which a direct write cannot skip. The door
  // then writes no second row. P23 fix pass: the database's row says what
  // the issue OWES (STATUS_ISSUE_CLOCKS_OWED_NOTE), never that a clock
  // started — so whenever something was owed (not a put-back) the door
  // records the outcome on a follow-up row: COMPLIANCE_CLOCKS_STARTED when
  // everything owed started, COMPLIANCE_CLOCKS_NOT_STARTED with what did not
  // (REV-15's precedent, lib/documentLifecycle/common.ts) — so the absence
  // of both reads as "nothing was started", never as success. Before
  // 20261205 (or when the probe cannot tell) the door writes the record
  // below, exactly as it did.
  if (input.recordedByDatabase ?? await isStatusIssueRecordedByDatabase()) {
    if (input.putBack !== true) {
      const notStarted = complianceClockErrors.length > 0;
      const { error: followErr } = await logAuditAction({
        action: notStarted ? CLOCKS_NOT_STARTED_ACTION : CLOCKS_STARTED_ACTION,
        resourceType: "document",
        resourceId: input.documentId,
        orgId: input.orgId,
        userId: input.actorUserId,
        userEmail: input.actorEmail ?? undefined,
        userRole: input.actorRole ?? undefined,
        details: {
          followsUp: "DOCUMENT_ISSUED",
          door: input.door,
          versionId: input.versionId,
          putBack: input.putBack,
          ...(entryIntoForce ? { entryIntoForce: true } : {}),
          ...(notStarted
            ? { complianceClockErrors: [...complianceClockErrors] }
            : { reviewClockReset: reviewClock, acknowledgmentRosterOpened: true }),
        },
      });
      // The issue's record stands (the database wrote it); only this
      // follow-up is missing from the history — said with the clocks.
      if (followErr) {
        complianceClockErrors.push(notStarted
          ? `the record of what did not start could not be written (${followErr}), so it is not on the document's history`
          : `the clocks started, but the record that they did could not be written (${followErr}), so the document's history reads as if they had not — do not start them again`);
      }
      if (complianceClockErrors.length > 0) {
        console.warn(`[revisions] REV-19: the review clock / acknowledgment roster of document ${input.documentId} did not fully start or record (${complianceClockErrors.join("; ")})`);
      }
    }
    return { issued: true, putBack: input.putBack, ...(entryIntoForce ? { entryIntoForce: true as const } : {}), complianceClockErrors, recordError: null };
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
      ...(entryIntoForce ? { entryIntoForce: true } : {}),
      reviewPolicyMode,
      rosterComplete,
      issuedWithoutSignOff,
      complianceClocksStarted: reviewClock,
      reviewClockReset: reviewClock,
      acknowledgmentRosterOpened: input.putBack !== true,
      complianceClocksNote: input.putBack === true ? STATUS_ISSUE_CLOCKS_NOTE.putBack
        : entryIntoForce ? STATUS_ISSUE_CLOCKS_NOTE.entryIntoForce
        : input.putBack === false ? STATUS_ISSUE_CLOCKS_NOTE.newIssue : STATUS_ISSUE_CLOCKS_NOTE.unknown,
      complianceClockErrors: complianceClockErrors.length > 0 ? complianceClockErrors : null,
    },
  });
  if (complianceClockErrors.length > 0) {
    console.warn(`[revisions] REV-19: the review clock / acknowledgment roster of document ${input.documentId} did not fully start (${complianceClockErrors.join("; ")})`);
  }
  return { issued: true, putBack: input.putBack, ...(entryIntoForce ? { entryIntoForce: true as const } : {}), complianceClockErrors, recordError: recordErr ?? null };
}

/** REV-19: THE status write for a status editor — one checked UPDATE of the
 *  status (and any other columns the editor saves with it), then, when it
 *  made the document a controlled issue, recordStatusIssue. A refusal is
 *  thrown in the database's own words (the publish guard's sentences, which
 *  isIssueRefusal recognises); a write that matched no row is a refusal,
 *  never a silent success. A write to an issue status that recorded no
 *  issue says why (`notRecordedBecause` — P17 integrator fix).
 *
 *  REV-26 (document-control P25; DEC-77's REV-26 line): a write that puts
 *  the current revision in force for the first time out of an issue status
 *  no gate reads as in force (an existing IFC row -> Issued / Locked:
 *  isUnguardedEntryIntoForce, read from the database row as every other
 *  basis here) is recorded as an issue too — the guard judges it as one
 *  since 20261185 — with the acknowledgment roster opened and the review
 *  clock left as it was (isEntryIntoForce). It answered
 *  `notRecordedBecause: 'already_issued'` before. isIssueTransition is not
 *  widened (it still names a NEW issue on evidence). */
export async function changeDocumentStatus(input: {
  orgId: string; documentId: string; toStatus: string; door: Exclude<StatusIssueDoor, "unarchive">;
  actorUserId: string; actorEmail?: string | null; actorRole?: string | null;
  /** Other columns written in the same checked UPDATE (a metadata save). */
  patch?: Record<string, unknown>;
  /** notifications N17 (R2): false from the bulk status editor (one action,
   *  many documents) — the roster's requests keep their bell rows and
   *  emails and skip the push leg; the metadata save (one document) omits it. */
  notifyPush?: boolean;
  /** DIST-16 (document-control P28 fix pass): false from the bulk status
   *  editor — it withdraws the recalls of every row it put back in force
   *  ONCE per apply (lib/staleCopies.ts withdrawRetirementBatch), never one
   *  preference-exempt withdrawal per row; the metadata save omits it. */
  withdrawRecall?: boolean;
  /** PROD-17 (document-control P28 fix pass): the status the caller's own
   *  copy of the row holds (the metadata save's selectedDoc). Given, a
   *  pre-write read that fails is retried ONCE (P28 second fix pass). Ruled
   *  by the integrator at the P28 merge, 2026-10-21 (DEC-90): that is all it
   *  does. If the read fails again the prior is UNKNOWN, and an unknown
   *  prior recalls the copy holders (recallsCopyHolders(null)) and tells the
   *  watchers — whatever the caller's copy holds (a title fix on an Archived
   *  document can send a second recall: the accepted cost of never retiring
   *  a document silently — the copy may be stale, another session having
   *  put the document back in force). */
  heldStatus?: string | null;
  /** REV-31 (document-control P31): true from the metadata save — a write
   *  that RETIRED the document then says so on the outcome (`retired`), for
   *  the caller to run the retirement's duties. Omitted, the outcome is
   *  exactly what it was. */
  reportRetirement?: boolean;
}): Promise<StatusIssueOutcome> {
  let before = await readStatusIssueBasis(input.documentId, undefined, input.toStatus);
  // P28 second fix pass: the caller's held status is a possibly stale copy,
  // so the database row is asked once more before it is leaned on.
  if (before.readFailed === true && input.heldStatus !== undefined) {
    before = await readStatusIssueBasis(input.documentId, undefined, input.toStatus);
  }
  const now = new Date().toISOString();
  // REV-19 (a) (P23): a write to an issue status names its door to the
  // database's issue record (20261205), which decides from the row whether
  // it issued. P23 fix pass: the probe is asked first, and the header sent
  // only when the database records — a database before 20261205 is sent no
  // custom header.
  const recordedByDatabase = isControlledIssueStatus(input.toStatus) ? await isStatusIssueRecordedByDatabase() : false;
  const { data: rows, error } = await withIssueDoor(supabase.from("documents")
    .update({ ...(input.patch ?? {}), status: input.toStatus, updated_at: now, updated_by: input.actorUserId })
    .eq("id", input.documentId)
    .select("id"), recordedByDatabase ? input.door : null);
  if (error) throw new Error(error.message);
  if (((rows as unknown[] | null) ?? []).length === 0) {
    throw new Error("The status was NOT changed — you don't have authority to change this document, or it is no longer visible to you. Nothing was changed.");
  }
  // PROD-17 (document-control P26): a write that RETIRES the document (into
  // Superseded / Void / Archived — isRetiredStatus — out of a status that is
  // not one, or out of Void) tells its watchers, once, never awaited, and
  // recalls every copy holder when it takes away a controlled issue
  // (recallsCopyHolders, P26 fix pass 4 — the integrator's ruling under
  // DEC-90: a Draft or In Review moved straight into a retired status, or
  // a Void moved into another, gets the watchers' FYI only); the outcome
  // returned is unchanged. A re-save of the status it already has sends
  // nothing; a move out of Superseded or Archived (into another retired
  // status) is the record's to decide since the P28 integrator fix pass
  // (DIST-16 done-when 2, below). A pre-write read that failed (fromStatus
  // unknown) recalls: a second recall over none. This door tells no
  // checkout holder or package owner, so they stay in the watchers'
  // audience. (document-control P28: the library page's metadata save routes
  // its retirements here; a caller that routes one here must not also call
  // recallOnRetirement: that would be a second recall.) Ruled by the
  // integrator at the P28 merge, 2026-10-21 (DEC-90): a read that failed
  // twice (heldStatus given) leaves the prior UNKNOWN, and the copy holders
  // ARE recalled (P26's fail-safe — a possible second recall is the accepted
  // cost); the caller's held status never withholds a recall.
  // DIST-16 done-when 2 (the P28 integrator fix pass): "already retired" is
  // decided from the document's RECORD, not from the prior status — every
  // retirement here calls the recall with the prior as `retiredFrom`, and
  // lib/staleCopies.ts recallRetiredDocument sends nothing again only for a
  // prior not in force with a retirement notice standing since the last
  // return to force (a Void told at the void, archived later: no second
  // FYI; a Superseded / Archived retired by a door that told nobody: its
  // watchers told now). An unknown prior (null) is in force for that rule.
  const retires = isRetiredStatus(input.toStatus) && input.toStatus.trim() !== (before.fromStatus ?? "").trim();
  if (retires) {
    recallOnRetirement({
      orgId: input.orgId, documentId: input.documentId,
      newStatus: input.toStatus.trim(), replacementNote: null,
      actorUserId: input.actorUserId, actorName: input.actorEmail || input.actorUserId,
      personallyToldElsewhere: { checkoutHolder: false, packageOwners: false },
      recallCopyHolders: recallsCopyHolders(before.fromStatus),
      retiredFrom: before.readFailed === true ? null : (before.fromStatus ?? null),
    });
  }
  // DIST-16 (document-control P28): an issue status written over a prior
  // that was not one — a retired document put back, a document restored into
  // Draft / In Review and issued later (P28 fix pass), or a prior that could
  // not be read — withdraws the retirement recall standing on it (the record
  // decides; nothing is sent when none stands), fired, never awaited. The
  // bulk editor passes withdrawRecall: false and withdraws once per apply.
  if (input.withdrawRecall !== false && isControlledIssueStatus(input.toStatus)
    && (before.readFailed === true || !isControlledIssueStatus(before.fromStatus))) {
    void import("@/lib/staleCopies").then(({ withdrawRetirementRecall }) => withdrawRetirementRecall({
      orgId: input.orgId, documentId: input.documentId, restoredStatus: input.toStatus, door: "put_back",
      actorUserId: input.actorUserId, actorName: input.actorEmail || input.actorUserId,
    })).catch((e) => console.error(`[revisions] DIST-16: the recall withdrawal of document ${input.documentId} did not run`, e));
  }
  const change = { fromStatus: before.fromStatus, toStatus: input.toStatus, hasCurrentRevision: !!before.versionId };
  if (!isIssueTransition(change) && !isUnguardedEntryIntoForce(change)) {
    // A write that is not to an issue status: exactly as before. REV-31
    // (document-control P31): a write that retired the document says so to a
    // caller that asks (reportRetirement), for it to run the retirement's
    // duties.
    if (!isControlledIssueStatus(input.toStatus)) {
      return retires && input.reportRetirement === true
        ? { ...NO_STATUS_ISSUE, retired: { retiredFrom: before.readFailed === true ? null : (before.fromStatus ?? null), priorStatusUnknown: before.readFailed === true } }
        : NO_STATUS_ISSUE;
    }
    // REV-19 (P17 integrator fix): an issue status written but not recorded
    // as an issue — say which basis the read gave, so an editor tells a
    // failed read (unknown: nothing recorded, the history to be checked)
    // from a row someone else already issued (nothing owed for this write).
    const notRecordedBecause: StatusIssueNotRecorded = before.readFailed ? "read_failed"
      : isControlledIssueStatus(before.fromStatus) ? "already_issued"
      : "no_current_revision";
    // REV-19 (a) (P23): since 20261205 the database recorded this write if
    // it was an issue (it reads the row as it was — OLD — which this read
    // could not), with the clocks this door owes; this door, not knowing,
    // started none — said on the follow-up row the database's record
    // points to. Before 20261205: nothing is written, as before.
    if (notRecordedBecause === "read_failed" && recordedByDatabase) {
      // P23 fix pass: checked — a follow-up that cannot be written is
      // returned (recordError), never a silent success.
      const { error: followErr } = await logAuditAction({
        action: CLOCKS_NOT_STARTED_ACTION,
        resourceType: "document",
        resourceId: input.documentId,
        orgId: input.orgId,
        userId: input.actorUserId,
        userEmail: input.actorEmail ?? undefined,
        userRole: input.actorRole ?? undefined,
        details: {
          followsUp: "DOCUMENT_ISSUED",
          door: input.door,
          toStatus: input.toStatus,
          readFailed: true,
          complianceClockErrors: ["the document could not be read just before this write, so whether it issued the document was unknown to the app and no review clock or acknowledgment roster was started; if the database recorded this write as an issue (DOCUMENT_ISSUED just before this row), start what it owes from the document"],
        },
      });
      if (followErr) {
        // The database's refusal, as recordError always carries it; the
        // editors say what it means (the record that no clock was started).
        return { ...NO_STATUS_ISSUE, notRecordedBecause, recordError: followErr };
      }
    }
    return { ...NO_STATUS_ISSUE, notRecordedBecause };
  }
  return await recordStatusIssue({
    orgId: input.orgId, documentId: input.documentId, fromStatus: before.fromStatus, toStatus: input.toStatus,
    versionId: before.versionId, rev: before.rev, putBack: before.putBack, door: input.door,
    actorUserId: input.actorUserId, actorEmail: input.actorEmail ?? null, actorRole: input.actorRole ?? null,
    entryIntoForce: before.entryIntoForce, recordedByDatabase,
    ...(input.notifyPush === false ? { notifyPush: false } : {}),
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
 *  only after the lineage confirms (REV-6 / REV-10).
 *
 *  REV-23 (P19): the put-back goes through put_back_retired_issue (20261165)
 *  — the same write, run as the caller, recorded (REV_HOLD_OVERRIDDEN) when
 *  Document Control puts a held document back into the issue the supersede
 *  stamped, which the guard no longer admits bare — and the direct write
 *  only while the function is absent.
 *
 *  REV-29 (P25): the status put back is the one read before the
 *  retirement, a NULL (or blank) one included — never "Issued" for a
 *  document that had none (that put it in force, unreviewed). On a database
 *  whose put_back_retired_issue predates 20261192 (it refuses a NULL
 *  status) a NULL prior status is put back as "Issued", exactly as before
 *  P25 (an older body takes today's path); with no function at all the
 *  direct write puts back the NULL (the guard there judges it as it judged
 *  'Issued'). */
async function undoFailedSupersede(opts: {
  docId: string;
  prior: Record<string, unknown>;
  addedPairs: string[];
  failure: SupersessionLineageError;
  actorUserId: string;
}): Promise<never> {
  const { docId, prior, failure } = opts;
  const priorStatus = (prior.status as string | null | undefined) ?? null;
  let putBackAs: string | null = priorStatus;
  let restoreProblem: string | null = null;
  // The rollback puts back the state from before the supersede (its own
  // force over a hold, if any, was the supersede's): it asks for the pass —
  // given only for the retirement this actor just made.
  const door = await putBackRetiredIssue({
    documentId: docId, status: priorStatus, door: "supersede_rollback",
    reason: `The supersede was rolled back: ${failure.message}`, supersession: prior, forceHold: true,
    ...(priorStatus === null ? { olderBodyStatus: "Issued" } : {}),
  });
  if (door.kind === "landed" && door.putBackAs !== undefined) putBackAs = door.putBackAs;
  if (door.kind === "refused") restoreProblem = door.reason;
  if (door.kind === "absent") {
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
      restoreProblem = restoreErr?.message ?? "the write was refused";
    }
  }
  if (restoreProblem !== null) {
    throw new Error(
      `${failure.message} The document is now Superseded and its previous status could not be restored ` +
      `(${restoreProblem}) — ask Doc Control to restore it to ${describePutBackStatus(priorStatus)} or record the replacement links.`,
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
    `Nothing was superseded: ${failure.message} The document is back to ${describePutBackStatus(putBackAs)}.` +
    (leftover > 0 ? ` ${leftover} replacement link(s) this attempt wrote could not be removed — ask Doc Control to delete them.` : "") +
    " Fix the cause and supersede it again.",
  );
}

// ─── REV-33 (document-control P34): the supersession's pre-write gates, ─────
// shared by supersedeDocument and the status editors' save to Superseded /
// Void (the bulk editor, the library page's metadata save).

/** DCK-1's refusal, word for word as supersedeDocument has always said it. */
export const SUPERSEDE_MOC_REQUIRED =
  "This is a drawing-class document — PSM requires the MOC reference to supersede it (OSHA 1910.119(l)).";

/** DCK-1: a drawing-class document superseded without an MOC reference of at
 *  least three characters. `name` lets a door that can ask for one tell this
 *  refusal from the others (isSupersessionMocRequired). */
export class SupersessionMocRequiredError extends Error {
  constructor() {
    super(SUPERSEDE_MOC_REQUIRED);
    this.name = "SupersessionMocRequiredError";
  }
}
export function isSupersessionMocRequired(e: unknown): boolean {
  return e instanceof SupersessionMocRequiredError || (e as { name?: string } | null)?.name === "SupersessionMocRequiredError";
}

/** DCK-1 — supersedeDocument's MOC rule, the one copy of it: a document
 *  whose effective class is drawing is superseded only with an MOC reference
 *  of at least three characters; a class that cannot be resolved (a database
 *  before the class columns, a failed read) does not block — the database
 *  rail model, as it always was. */
export async function assertSupersessionMoc(
  doc: { id: string; collectionId?: string | null; libraryId?: string | null },
  mocReference: string | null | undefined,
): Promise<void> {
  try {
    const { effectiveDocClassForDocument } = await import("@/lib/docClass");
    const cls = await effectiveDocClassForDocument({
      id: doc.id, collectionId: doc.collectionId ?? null, libraryId: doc.libraryId ?? null,
    });
    if (cls === "drawing" && (mocReference?.trim().length ?? 0) < 3) throw new SupersessionMocRequiredError();
  } catch (e) {
    if (isSupersessionMocRequired(e)) throw e;
    /* class unresolvable — do not block */
  }
}

/** What a status editor's retirement gate found: the lock state it read (the
 *  checkout holder, for the holder's notice after the write — REV-34 (c)) and
 *  the MOC reference it accepted (for the SUPERSEDE_DOC record). */
export type StatusEditorRetirementGate = {
  preState: PublishGuardState | null;
  mocReference: string | null;
};

/** REV-33 (document-control P34; ruled by the integrator at the P31 merge,
 *  2026-10-21, DEC-90 — fail-safe, PSM / OSHA 1910.119(l)): the pre-write
 *  gates a status editor runs before it writes a status that RETIRES a
 *  document, as the single door does. Nothing is written here; a refusal is
 *  thrown in plain words and the caller writes nothing for that document.
 *   - Superseded (supersedeDocument's gates, as the ruling names them): the
 *     drawing-class MOC reference (assertSupersessionMoc — the same rule and
 *     the same sentence), then the checkout lock: a document another person
 *     has checked out is superseded only with a reason, which — as the
 *     Supersede dialog passes it — is the override recorded to the holder
 *     (their notice after the write, finishRetirementDuties); no reason, the
 *     authorizePublish refusal. Publish authority and the hold are NOT asked
 *     here: the database's publish guard already refuses a non-controller's
 *     Superseded write without the publisher tier or over an active hold, and
 *     the ruling keeps a non-drawing, unlocked row writing exactly as today.
 *   - Void: authorizePublish itself (operation "void") — publish authority in
 *     the library or the document's effective ownership, the foreign checkout
 *     lock (the reason is the override), an active hold refuses — the same
 *     pre-check supersedeDocument runs, no force (the Supersede dialog never
 *     passes one). The database's guard does not treat entry into Void as an
 *     advancing write, so this is the only layer that asks.
 *   - Archived: nothing (not ruled; the database decides the archive's
 *     refusals — OWN-19's publisher tier, the legal hold).
 *  The lock state is read fresh (never the page's copy); a read that fails
 *  refuses (fail-closed, as authorizePublish's own read does). */
export async function gateStatusEditorRetirement(input: {
  documentId: string; libraryId: string; collectionId?: string | null; orgId: string;
  actorUserId: string; actorRole?: string | null; toStatus: string;
  /** The one reason the door asked (null: none asked — a retirement the page did not see). */
  reason: string | null;
  mocReference?: string | null;
}): Promise<StatusEditorRetirementGate> {
  const to = input.toStatus.trim();
  const reason = input.reason?.trim() || null;
  const moc = input.mocReference?.trim() || null;
  if (to === "Superseded") {
    await assertSupersessionMoc({ id: input.documentId, collectionId: input.collectionId ?? null, libraryId: input.libraryId }, moc);
    const { data, error } = await supabase
      .from("documents").select("checked_out_by, checked_out_by_name").eq("id", input.documentId).maybeSingle();
    if (error) throw new Error(`Couldn't read whether the document is checked out (${error.message}) — nothing was superseded.`);
    const row = (data as { checked_out_by?: string | null; checked_out_by_name?: string | null } | null) ?? null;
    const preState: PublishGuardState = {
      checkedOutBy: row?.checked_out_by ?? null, checkedOutByName: row?.checked_out_by_name ?? null, activeHolds: [],
    };
    const lockedByOther = !!preState.checkedOutBy && String(preState.checkedOutBy) !== String(input.actorUserId);
    if (lockedByOther && !reason) throw new Error(`A reason is required to ${overrideReasonVerb("supersede")}.`);
    return { preState, mocReference: moc };
  }
  if (to === "Void") {
    try {
      const preState = await authorizePublish({
        documentId: input.documentId, libraryId: input.libraryId, orgId: input.orgId,
        actorUserId: input.actorUserId, actorRole: input.actorRole ?? undefined,
        overrideReason: reason ?? undefined, operation: "void",
      });
      return { preState, mocReference: null };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      // authorizePublish speaks of publishing; a void is said as what it is.
      if (/^You don't have authority to publish revisions in this library/.test(msg)) {
        throw new Error("Voiding a document takes publish authority in this library (Doc Control, a granted publisher or the document's owner) — ask an Admin or Doc Control to grant it, or to void it.");
      }
      if (e instanceof DocumentMutationBlockedError && e.code === "on_hold") {
        throw new Error(msg.replace(/ Release it before publishing a new revision\.$/, " A held document is not voided — ask Document Control to resolve the hold first."));
      }
      throw e;
    }
  }
  return { preState: null, mocReference: null };
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
  // REV-33 (document-control P34): the one rule, shared with the status
  // editors' save to Superseded (assertSupersessionMoc) — unchanged here.
  await assertSupersessionMoc({ id: doc.id, collectionId: doc.collectionId ?? null, libraryId }, mocReference);

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
      // PROD-17 (document-control P28; DEC-90 R1 at the P26 merge): the copy
      // holders are recalled only for a document that was issued — a
      // controlled-issue prior (or one the read could not give), or a re-run
      // on a document already Superseded / Archived, which recalls as it
      // always has. A Draft, In Review or Void document superseded gets the
      // watchers' FYI only, as at every other retirement door.
      recallCopyHolders: recallsCopyHolders(priorState.status as string | null) || skipsRetirementRecall(priorState.status as string | null),
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
