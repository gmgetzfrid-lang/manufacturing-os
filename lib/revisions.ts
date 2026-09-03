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
import type { Principal } from "@/lib/permissions";
import type { DocumentRecord, DocumentVersion, DocumentStatus } from "@/types/schema";
import { letterLabelFor, openReviewRoster, invalidateDraftSignoffs, effectiveReviewControlForDocument } from "@/lib/reviewControl";
import { applyEffectiveDate } from "@/lib/effectiveDate";
import { isEffectiveOwnerOfDocument } from "@/lib/ownership";
import { runPostPublishSideEffects } from "@/lib/postPublish";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import { recomputeRetention } from "@/lib/retention";

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

/** True when the publish_revision RPC isn't installed yet (pre-migration). */
function isMissingPublishRpc(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "PGRST202" || err.code === "42883") return true;
  const msg = (err.message ?? "").toLowerCase();
  return msg.includes("publish_revision") &&
    (msg.includes("does not exist") || msg.includes("could not find") || msg.includes("schema cache"));
}
/**
 * Call publish_revision. OWN-5 / DEC-11: the v1-signature retry is RETIRED —
 * it silently upgraded a checkout-override (p_override_lock, note required,
 * holder notified) into a controller force (p_force, bypasses lock AND hold)
 * whenever the deployed function looked old. The v2+ signature has been the
 * applied, probe-verified reality since 20260828; a genuinely missing RPC is
 * a deployment error to surface, not to paper over with weaker semantics.
 */
async function callPublishRevisionRpc(args: Record<string, unknown>): Promise<{
  data: unknown; error: { code?: string; message?: string } | null;
}> {
  return supabase.rpc("publish_revision", args);
}


// The RPC can look "missing" transiently — PostgREST returns PGRST202 while
// its schema cache reloads (which happens right after applying the very
// migration that adds the function). Never downgrade this tab permanently:
// remember the miss for 60s, then probe the RPC again. The mark is only set
// after callPublishRevisionRpc has already retried the v1 shape, so a real
// missing-function deployment still falls back instantly within the window.
let publishRpcMissingUntil = 0;
function publishRpcUnavailable(): boolean { return Date.now() < publishRpcMissingUntil; }
function markPublishRpcMissing(): void { publishRpcMissingUntil = Date.now() + 60_000; }
/** Test hook / manual reset after applying the 20260823 migration. */
export function resetPublishRpcFlag(): void { publishRpcMissingUntil = 0; }

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

/**
 * Authorize a publish on `libraryId` and evaluate the lock/hold guard, returning
 * the authoritative pre-publish state. Throws a UI-safe error when the actor
 * lacks per-library publish authority, when a required override reason is missing,
 * or when the guard blocks (foreign lock without authority, or an active hold).
 *
 * `force` is set ONLY when the doc is locked by ANOTHER user — so a normal publish
 * still respects an active hold exactly as before; we never silently blow past a
 * hold on an ordinary rev-up.
 */
async function authorizePublish(opts: {
  documentId: string;
  libraryId: string;
  orgId: string;
  actorUserId: string;
  actorRole?: string;
  overrideReason?: string;
  /** Controller's explicit emergency force (bypasses lock AND hold). */
  force?: boolean;
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
  if (lockedByOther && !opts.overrideReason?.trim() && opts.force !== true) {
    throw new Error("A reason is required to publish over another user's checkout.");
  }
  // The override-with-reason passes the LOCK check only. Holds are evaluated
  // independently and are never satisfied by an override — only a
  // controller's explicit force clears them (evaluatePublishGuard enforces
  // that split; the publish_revision RPC re-checks it transactionally).
  const decision = evaluatePublishGuard(state, {
    actorUserId: opts.actorUserId,
    actorRole: opts.actorRole,
    actorRoles: principal.roles ?? null,
    canControlLibrary,
    force: opts.force === true,
    overrideLock: lockedByOther && !!opts.overrideReason?.trim(),
  });
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

/**
 * Create a BRAND-NEW document and attach its first version from an uploaded file.
 *
 * Distinct from revUpDocument (which publishes a new revision over an EXISTING
 * doc and is gated by per-library publish authority): this is a creation, gated
 * by library write access at the UI/RLS layer, so it does NOT run the publish
 * guard. Used by the "upload & link a drawing" flow.
 */
export async function createDocumentWithFile(input: {
  orgId: string;
  libraryId: string;
  collectionId?: string | null;
  folderPath?: string[];
  documentNumber: string;
  title?: string;
  file: File;
  status?: DocumentStatus;
  actorUserId: string;
  actorEmail?: string;
}): Promise<{ documentId: string }> {
  const now = new Date().toISOString();
  const docNum = input.documentNumber.trim();
  if (!docNum) throw new Error("A document number is required.");
  const title = input.title?.trim() || docNum;

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
      status: input.status ?? "Issued",
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

  await supabase.from("documents").update({ current_version_id: ver.id, updated_at: now }).eq("id", documentId);
  // Seed the review clock so a new doc picks up any library/folder review cycle.
  await onDocumentIssued({ orgId: input.orgId, documentId, userId: input.actorUserId, userName: input.actorEmail });
  // Open the read-&-understood roster if an ack policy covers this new doc.
  await onDocumentIssuedAck({ orgId: input.orgId, documentId, actorId: input.actorUserId, actorName: input.actorEmail });
  // Seed retention state so a doc created AFTER a library/folder retention
  // policy exists is not invisible to the retention system.
  try { await recomputeRetention(documentId); } catch { /* best-effort */ }
  return { documentId };
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
    const { data: freshDoc } = await supabase
      .from("documents").select("current_version_id").eq("id", doc.id).maybeSingle();
    const liveCurrent = (freshDoc?.current_version_id as string | null) ?? null;
    if (freshDoc && liveCurrent !== expectedBase) {
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
  let result: RevUpResult | null = null;
  if (!publishRpcUnavailable()) {
    const { data, error } = await callPublishRevisionRpc({
      p_doc: doc.id,
      p_expected_base: expectedBase,
      p_op_class: "content",
      p_version: versionPayload,
      p_actor: actorUserId,
      p_actor_name: actorEmail || actorUserId,
      p_force: input.force === true,
      p_override_lock: lockedByOther,
      p_as_branch: input.asBranch === true,
      p_branch_reason: input.branchReason?.trim() || null,
      p_new_status: "Issued",
    });
    if (error) {
      if (isMissingPublishRpc(error)) {
        markPublishRpcMissing(); // fall through to the legacy path below
      } else {
        throw new Error(error.message);
      }
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

  // 3b. Pre-migration fallback — the legacy three-step path (no base check).
  if (!result) {
    result = await legacyRevUpAfterUpload({
      doc, orgId, actorUserId, actorEmail,
      versionPayload, previousVersionId: doc.currentVersionId ?? null,
    });
  }

  const { newVersion, supersededVersionId, branched, branchId } = result;

  // 3c. A direct (non-branch) publish supersedes any in-review draft: clear
  //     the pending pointer and void the draft's roster, so a stale draft can
  //     never be finalized OVER this newer revision. Best-effort — a
  //     pre-review-migration environment has no pending column.
  if (!branched) {
    try {
      const nowIso = new Date().toISOString();
      const { data: pendingRow } = await supabase.from("documents").select("pending_version_id").eq("id", doc.id).maybeSingle();
      const stalePendingId = (pendingRow?.pending_version_id as string | null) ?? null;
      if (stalePendingId) {
        await supabase.from("documents").update({ pending_version_id: null }).eq("id", doc.id);
        await supabase.from("document_versions").update({ superseded_at: nowIso }).eq("id", stalePendingId);
        const { error: voidErr } = await supabase.from("document_review_signoffs")
          .update({ status: "void", updated_at: nowIso })
          .eq("document_version_id", stalePendingId).in("status", ["pending", "signed"]);
        if (voidErr) console.warn("[revUp] voiding superseded draft's sign-offs failed (roster may need the 20260830 policy migration):", voidErr.message);
      }
    } catch { /* best-effort */ }

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

/** Legacy (pre-20260823) three-step publish. No base check — kept only so
 *  environments that haven't applied the migration keep working. */
async function legacyRevUpAfterUpload(input: {
  doc: DocumentRecord;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  versionPayload: Record<string, unknown>;
  previousVersionId: string | null;
}): Promise<RevUpResult> {
  const { doc, orgId, actorUserId, versionPayload, previousVersionId } = input;
  const now = new Date().toISOString();

  const insertBody: Record<string, unknown> = {
    org_id: orgId,
    record_id: doc.id,
    created_by: actorUserId,
    created_at: now,
    released_at: now,
    supersedes_version_id: previousVersionId,
    ...versionPayload,
  };
  // Contract-era columns may not exist pre-migration; retry without them.
  let insertedRow: Record<string, unknown> | null = null;
  {
    const { data, error } = await supabase
      .from("document_versions").insert(insertBody).select("*").single();
    if (error) {
      const msg = (error.message ?? "").toLowerCase();
      if (msg.includes("provenance") || msg.includes("source_file_key") || msg.includes("related_ticket_id")) {
        delete insertBody.provenance;
        delete insertBody.source_file_key;
        delete insertBody.related_ticket_id;
        const retry = await supabase
          .from("document_versions").insert(insertBody).select("*").single();
        if (retry.error || !retry.data) {
          throw new Error(retry.error?.message || "Failed to write new version row");
        }
        insertedRow = retry.data as Record<string, unknown>;
      } else {
        throw new Error(error.message);
      }
    } else {
      insertedRow = data as Record<string, unknown>;
    }
  }
  if (!insertedRow) throw new Error("Failed to write new version row");

  if (previousVersionId) {
    const { error: supErr } = await supabase
      .from("document_versions")
      .update({ superseded_at: now })
      .eq("id", previousVersionId);
    if (supErr) console.error("revUp: failed to stamp superseded_at:", supErr.message);
  }

  const label = String(versionPayload.revision_label ?? "");
  const { error: docErr } = await supabase
    .from("documents")
    .update({
      current_version_id: insertedRow.id,
      rev: label,
      revision: label,
      status: "Issued",
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id);

  if (docErr) {
    try {
      await supabase.rpc("revup_rollback_orphan", {
        p_version: insertedRow.id as string,
        p_prev: previousVersionId,
      });
    } catch { /* surface the original failure below regardless */ }
    throw new Error(docErr.message);
  }

  return { newVersion: rowToVersion(insertedRow), supersededVersionId: previousVersionId };
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
  await authorizePublish({ documentId: doc.id, libraryId, orgId, actorUserId, actorRole, overrideReason: input.overrideReason });

  // Base numeric target + letter label. If a draft is already in review, bump its
  // letter (2A -> 2B).
  const { data: docRow } = await supabase.from("documents").select("pending_version_id, rev, current_version_id").eq("id", doc.id).maybeSingle();
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
  const now = new Date().toISOString();

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

  let insertedRow: Record<string, unknown> | null = null;

  // Same contract as a rev-up: the revert must be built on the revision the
  // actor is looking at. If the doc moved since their screen loaded, they get
  // the stale-base conflict instead of silently reverting away someone's work.
  if (!publishRpcUnavailable()) {
    const { data, error } = await callPublishRevisionRpc({
      p_doc: doc.id,
      p_expected_base: previousVersionId,
      p_op_class: "content",
      p_version: revertPayload,
      p_actor: actorUserId,
      p_actor_name: actorEmail || actorUserId,
      p_force: input.force === true,
      p_override_lock: lockedByOther,
      p_as_branch: false,
      p_branch_reason: null,
      p_new_status: "Issued",
    });
    if (error) {
      if (isMissingPublishRpc(error)) markPublishRpcMissing();
      else throw new Error(error.message);
    } else {
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
      insertedRow = res.version as Record<string, unknown>;
    }
  }

  if (!insertedRow) {
    // Legacy pre-migration path.
    const legacyBody: Record<string, unknown> = {
      org_id: orgId,
      record_id: doc.id,
      created_by: actorUserId,
      created_at: now,
      released_at: now,
      supersedes_version_id: previousVersionId,
      ...revertPayload,
    };
    delete legacyBody.provenance;
    const { data, error: insertErr } = await supabase
      .from("document_versions")
      .insert(legacyBody)
      .select("*")
      .single();
    if (insertErr || !data) throw new Error(insertErr?.message || "Failed to create revert version");
    insertedRow = data as Record<string, unknown>;

    if (previousVersionId) {
      await supabase
        .from("document_versions")
        .update({ superseded_at: now })
        .eq("id", previousVersionId);
    }

    const { error: docErr } = await supabase
      .from("documents")
      .update({
        current_version_id: insertedRow.id,
        rev: revertedLabel,
        revision: revertedLabel,
        status: "Issued",
        updated_at: now,
        updated_by: actorUserId,
      })
      .eq("id", doc.id);

    if (docErr) throw new Error(docErr.message);
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

export async function archiveDocument(input: ArchiveInput): Promise<void> {
  const { doc, reason, orgId, actorUserId, actorEmail, actorRole } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (!reason.trim()) throw new Error("Archive reason is required");

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("documents")
    .update({
      status: "Archived",
      archived_at: now,
      archived_by: actorUserId,
      archive_reason: reason.trim(),
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id);

  if (error) throw new Error(error.message);

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: doc.currentVersionId ?? "",
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "ARCHIVE_DOC",
    details: { reason: reason.trim(), action: "archive" },
  });
}

/** OWN-15: the statuses an unarchive may restore to — never an arbitrary
 *  string (documents.status has no CHECK constraint). */
export const UNARCHIVE_RESTORE_STATUSES = ["Issued", "Draft", "In Review"] as const;

export async function unarchiveDocument(input: ArchiveInput & { restoreStatus?: string }): Promise<void> {
  const { doc, reason, orgId, actorUserId, actorEmail, actorRole, restoreStatus } = input;
  if (!doc.id) throw new Error("Document is missing an id");
  if (restoreStatus && !(UNARCHIVE_RESTORE_STATUSES as readonly string[]).includes(restoreStatus)) {
    throw new Error(`Cannot restore to "${restoreStatus}" — choose Issued, Draft or In Review.`);
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("documents")
    .update({
      status: restoreStatus || "Issued",
      archived_at: null,
      archived_by: null,
      archive_reason: null,
      updated_at: now,
      updated_by: actorUserId,
    })
    .eq("id", doc.id);

  if (error) throw new Error(error.message);

  await logRevisionEvent({
    orgId,
    documentId: doc.id,
    versionId: doc.currentVersionId ?? "",
    userId: actorUserId,
    userEmail: actorEmail ?? "",
    userRole: actorRole ?? "",
    type: "ARCHIVE_DOC",
    details: { reason: reason?.trim() || "Restored from archive", action: "unarchive" },
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
  unresolvedDocNumbers: string[];         // doc numbers that couldn't be looked up
};

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
    overrideReason: input.overrideReason, force: input.force,
  });

  const now = new Date().toISOString();

  // Resolve replacement document numbers to UUIDs scoped to this library.
  const resolved: string[] = [];
  const unresolved: string[] = [];
  if (replacementDocNumbers.length > 0) {
    const { data } = await supabase
      .from("documents")
      .select("id, document_number")
      .eq("org_id", orgId)
      .eq("library_id", libraryId)
      .in("document_number", replacementDocNumbers);

    const map = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ id: string; document_number: string }>) {
      map.set(row.document_number, row.id);
    }
    for (const dn of replacementDocNumbers) {
      const id = map.get(dn);
      if (id) resolved.push(id);
      else unresolved.push(dn);
    }
  }

  // Mark the original document as Superseded with full metadata.
  const { error: updErr } = await supabase
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
    .eq("id", doc.id);

  if (updErr) throw new Error(updErr.message);

  // Record the (old → new) join rows. Idempotent via UNIQUE constraint —
  // we ignore duplicate-key errors so re-running the action is safe.
  if (resolved.length > 0) {
    const rows = resolved.map((replacementId) => ({
      org_id: orgId,
      superseded_doc_id: doc.id,
      replacement_doc_id: replacementId,
      reason: reason.trim(),
      created_by: actorUserId,
      created_at: now,
    }));
    await supabase.from("document_supersessions").insert(rows);
  }

  // DIST-1: a public share link must stop serving a retired drawing. Revoke
  // what this actor may revoke (RLS can leave another creator's links to a
  // controller — the count on the audit record keeps that honest).
  let revokedShareLinks = 0;
  try {
    const { data: revokedRows } = await supabase
      .from("document_shares")
      .update({ revoked_at: now, revoked_by: actorUserId })
      .eq("document_id", doc.id)
      .is("revoked_at", null)
      .select("id");
    revokedShareLinks = revokedRows?.length ?? 0;
  } catch { /* best-effort */ }

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
    },
  });

  // If we superseded a doc someone else had checked out, leave their checkout open
  // but tell them it was retired (and why), with a link to the document.
  const holder = preState.checkedOutBy;
  if (holder && String(holder) !== String(actorUserId)) {
    const who = actorEmail || actorUserId;
    try {
      const episode = await getActiveEpisode(doc.id);
      await postEpisodeSystemMessage({
        orgId, documentId: doc.id, episodeId: episode?.id ?? null,
        text: `${who} superseded this document while you have it checked out — your checkout stays open. Reason: ${reason.trim()}`,
      });
    } catch {
      /* best-effort */
    }
    await notify({
      orgId, userId: String(holder),
      kind: "revision_published_over_checkout",
      title: "Document superseded while you're checked out",
      body: `Superseded by ${who}: ${reason.trim()}`,
      link: `/documents/${libraryId}?doc=${doc.id}`,
      resourceType: "document", resourceId: doc.id,
      actorUserId, actorName: who,
      metadata: { action: "supersede", reason: reason.trim() },
    });
  }

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
