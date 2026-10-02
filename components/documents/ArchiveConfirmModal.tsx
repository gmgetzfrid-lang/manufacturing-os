"use client";

// ArchiveConfirmModal — soft-delete a document. Records actor + reason on
// the documents row and writes an ARCHIVE_DOC audit entry. Archived rows
// are hidden from the default library list but recoverable by admins.
//
// REV-18 (P13 second review fix): the un-archive asks what the document
// comes back as (UNARCHIVE_RESTORE_STATUSES). Restoring to Issued is a
// controlled issue the database decides (20261144): a Draft archived after
// that migration (the guard stamped it 'not-issued') comes back a Draft by
// default, and a refused restore to Issued says the Draft restore is still
// open — never a dead end — where it would land, and otherwise what to do
// (final review fix: afterIssueRefusal). Anything the stamp does not record
// keeps the default every un-archive had before (Issued — third review fix):
// Draft is pre-selected only on the guard's evidence, never by default.
//
// REV-23 (P19 review fix): Document Control's un-archive of a held, stamped
// document back to Issued passes the hold only as a recorded override
// (put_back_retired_issue's p_force_hold, recorded as REV_HOLD_OVERRIDDEN),
// and an override is chosen, never implied: the dialog reads the active
// holds when it opens and, for a controller restoring the archived issue,
// names them and requires an explicit "Required." confirmation (the Split /
// Merge wizards' HeldSourceNotice) before the restore passes forceHold.
// Without it no force is sent: over a hold the guard refuses the restore in
// the new-door sentence, and the dialog offers the Draft restore.

import React, { useEffect, useState } from "react";
import { X, Archive, AlertTriangle, Loader2, ArchiveRestore, Check } from "lucide-react";
import {
  archiveDocument, unarchiveDocument, unarchiveRestoreDefault, UNARCHIVE_RESTORE_STATUSES,
  type StatusIssueOutcome,
} from "@/lib/revisions";
import { isIssueRefusal, ISSUE_REFUSAL, isControlledIssueStatus } from "@/lib/issueStatus";
import { resolveActorPrincipal } from "@/lib/principal";
import { isControllerPrincipal } from "@/lib/permissions";
import { readActiveHolds, holdReasonLabel } from "@/lib/holdGate";
import HeldSourceNotice from "@/components/documents/lifecycle/HeldSourceNotice";
import type { DocumentRecord } from "@/types/schema";

type RestoreStatus = (typeof UNARCHIVE_RESTORE_STATUSES)[number];

/** REV-19 (P14 final review): what of a landed un-archive's issue did not
 *  complete — unarchiveDocument's StatusIssueOutcome (the review clock /
 *  acknowledgment roster that did not start, the issue record that could not
 *  be written). The dialog says so before it closes, as the Split / Merge
 *  wizards show REV-15's complianceClockWarnings (LifecycleFollowUps). */
type RestoreFollowUps = { clockErrors: string[]; recordError: string | null };
function restoreFollowUps(outcome: StatusIssueOutcome | null | undefined): RestoreFollowUps | null {
  const clockErrors = outcome?.complianceClockErrors ?? [];
  const recordError = outcome?.recordError ?? null;
  return clockErrors.length > 0 || recordError ? { clockErrors, recordError } : null;
}

/** REV-18 (P13 final review fix): what is still open after the guard refused
 *  a restore to Issued. The Draft restore is offered only where it would
 *  land: the require limb (an unreviewed revision) never decides a Draft, and
 *  the new-door hold refuses only the issue, so a controller's Draft restore
 *  passes. For anyone short of a controller the publisher tier (OWN-15)
 *  refuses an un-archive in ANY status over a hold or without the authority,
 *  so a Draft is no way round those: release the hold, or ask Document
 *  Control. The controller tier is read as the guard reads it (the role
 *  collection, not the headline). */
async function afterIssueRefusal(
  message: string, actor: { orgId: string; actorUserId: string; actorRole?: string },
): Promise<string> {
  if (message.includes(ISSUE_REFUSAL.unreviewed)) {
    return "You can restore it as a Draft instead (choose Draft above), then submit its revision for review.";
  }
  const holdFirst = "Restoring it as a Draft is refused the same way: the hold must be released first (or ask Document Control).";
  if (message.includes(ISSUE_REFUSAL.newDoorHold)) {
    const principal = await resolveActorPrincipal({ uid: actor.actorUserId, orgId: actor.orgId, headlineRole: actor.actorRole });
    return isControllerPrincipal(principal)
      ? "You can restore it as a Draft instead (choose Draft above) — the hold refuses only the issue — and issue it once the hold is released."
      : holdFirst;
  }
  if (message.includes(ISSUE_REFUSAL.publishHold)) return holdFirst;
  return "Restoring it as a Draft needs the same authority — ask Document Control to restore it.";
}

/** REV-23 (P19 review fix): the active holds a controller's restore of the
 *  archived issue would pass — read when the dialog opens. `none` when there
 *  are none, or the actor is not Document Control (below it the publisher
 *  tier refuses any un-archive over a hold — OWN-15 — in words the dialog
 *  already answers, so there is nothing to confirm). */
type HeldRestore =
  | { kind: "none" }
  | { kind: "held"; reasons: string[] }
  | { kind: "unreadable"; error: string };

/** REV-23 (P19 review fix): read the holds, and ask who the actor is only
 *  when there are any (or they cannot be read) — the controller tier read as
 *  the guard reads it (the role collection, not the headline). Never throws:
 *  an unanswered question is `none`, and the restore then sends no force
 *  (the guard decides it bare). */
async function heldRestoreFor(
  documentId: string, actor: { orgId: string; actorUserId: string; actorRole?: string },
): Promise<HeldRestore> {
  try {
    const read = await readActiveHolds(documentId);
    if (read.readable && read.holds.length === 0) return { kind: "none" };
    const principal = await resolveActorPrincipal({ uid: actor.actorUserId, orgId: actor.orgId, headlineRole: actor.actorRole });
    if (!isControllerPrincipal(principal)) return { kind: "none" };
    if (!read.readable) return { kind: "unreadable", error: read.error };
    return { kind: "held", reasons: Array.from(new Set(read.holds.map(holdReasonLabel))) };
  } catch {
    return { kind: "none" };
  }
}

interface ArchiveConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  doc: DocumentRecord;
  /** True if the doc is already archived and we're un-archiving. */
  mode: "archive" | "unarchive";
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  /** Called after the write landed; an un-archive passes the status the
   *  document was restored to. */
  onSuccess: (restoredStatus?: string) => void;
}

export default function ArchiveConfirmModal({
  isOpen, onClose, doc, mode,
  orgId, actorUserId, actorEmail, actorRole, onSuccess,
}: ArchiveConfirmModalProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // REV-18: what an un-archive restores to, defaulted from what the document
  // WAS (unarchiveRestoreDefault reads the guard's retirement stamp; when it
  // records nothing, Issued — the default before 20261144).
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus>("Issued");
  const [basis, setBasis] = useState<"loading" | "issued" | "not-issued" | "unknown">("loading");
  const [followUps, setFollowUps] = useState<RestoreFollowUps | null>(null);
  // REV-23 (P19 review fix): the holds a controller's restore of the archived
  // issue would pass, and their confirmation.
  const [heldRestore, setHeldRestore] = useState<HeldRestore>({ kind: "none" });
  const [holdAck, setHoldAck] = useState(false);

  useEffect(() => {
    if (!isOpen || mode !== "unarchive") return;
    let alive = true;
    setBasis("loading");
    setHeldRestore({ kind: "none" });
    setHoldAck(false);
    (async () => {
      const d = doc.id
        ? await unarchiveRestoreDefault(doc.id).catch(() => ({ status: "Issued" as RestoreStatus, basis: "unknown" as const }))
        : { status: "Issued" as RestoreStatus, basis: "unknown" as const };
      // REV-23 (P19 review fix): only the restore that puts the archived issue
      // back (the stamp names the current revision — basis "issued") can pass
      // a hold, as Document Control's recorded override; any other restore to
      // Issued over a hold is refused (the new door, or below Document Control
      // the publisher tier's hold), which the dialog answers after the refusal.
      // That includes Document Control's exit of an archive whose stamp names
      // ANOTHER revision (basis "unknown" after a pointer move while archived):
      // since 20261174 (REV-24, P20) the guard judges it as the new door,
      // refused over a hold for everyone with no override, and a pointer move
      // on a held archive needs a recorded force. Before that paste the guard
      // admitted that exit unrecorded.
      const held: HeldRestore = d.basis === "issued" && doc.id
        ? await heldRestoreFor(doc.id, { orgId, actorUserId, actorRole })
        : { kind: "none" };
      if (alive) { setRestoreStatus(d.status); setBasis(d.basis); setHeldRestore(held); }
    })();
    return () => { alive = false; };
  }, [isOpen, mode, doc.id, orgId, actorUserId, actorRole]);

  if (!isOpen) return null;

  const isArchive = mode === "archive";
  // REV-23 (P19 review fix): restoring the held archived issue as Issued is
  // Document Control's override of the hold — confirmed here, or not sent.
  const needsHoldAck = !isArchive && heldRestore.kind === "held" && isControlledIssueStatus(restoreStatus);
  const forceHold = needsHoldAck && holdAck ? true : undefined;

  const submit = async () => {
    if (isArchive && !reason.trim()) return setError("Reason is required when archiving.");
    setBusy(true); setError(null);
    try {
      if (isArchive) {
        await archiveDocument({ doc, reason, orgId, actorUserId, actorEmail, actorRole });
        onSuccess();
      } else {
        const outcome = await unarchiveDocument({ doc, reason, orgId, actorUserId, actorEmail, actorRole, restoreStatus, forceHold });
        // The restore landed; what did not follow it is said before the
        // dialog closes (Done finishes it — onSuccess, then onClose).
        const pending = restoreFollowUps(outcome);
        if (pending) { setFollowUps(pending); return; }
        onSuccess(restoreStatus);
      }
      setReason("");
      onClose();
    } catch (e) {
      const message = (e as Error).message || `Failed to ${mode}`;
      // REV-18: a refused restore to Issued is the issue rule — the dialog
      // says what is still open (the Draft restore only where it would land).
      setError(!isArchive && restoreStatus === "Issued" && isIssueRefusal(message)
        ? `${message} ${await afterIssueRefusal(message, { orgId, actorUserId, actorRole })}`
        : message);
    } finally {
      setBusy(false);
    }
  };

  if (followUps) {
    const n = followUps.clockErrors.length + (followUps.recordError ? 1 : 0);
    const done = () => { onSuccess(restoreStatus); setReason(""); setFollowUps(null); onClose(); };
    return (
      <div className="fixed inset-0 z-[210] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
        <div role="alertdialog" aria-label="The restore completed with follow-up steps outstanding" className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden">
          <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
            <div className="text-sm font-black text-[var(--color-text)]">
              Restored as {restoreStatus} — {n} follow-up step{n === 1 ? "" : "s"} did not complete
            </div>
          </div>
          <div className="px-6 py-5 space-y-3 text-xs text-[var(--color-text)]">
            <p>
              The restore stands and is not rolled back — do not restore it again.
              {followUps.clockErrors.length > 0 && !followUps.recordError && <> What did not complete is recorded on the document&apos;s history; Document Control can set it from the document.</>}
            </p>
            <ul data-testid="restore-follow-ups" className="ml-5 list-disc space-y-1 max-h-64 overflow-y-auto">
              {followUps.clockErrors.map((m, i) => <li key={i}>{m}</li>)}
              {followUps.recordError && <li>The issue record could not be written ({followUps.recordError}), so this issue is not on the document&apos;s history.</li>}
            </ul>
          </div>
          <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex justify-end">
            <button type="button" onClick={done} className="inline-flex items-center gap-1.5 text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white px-3 py-2 rounded-lg">
              <Check className="w-3.5 h-3.5" /> Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[210] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className={`p-2 ${isArchive ? "bg-[var(--color-surface-2)]" : "bg-emerald-100"} rounded-lg`}>
            {isArchive
              ? <Archive className="w-5 h-5 text-[var(--color-text)]" />
              : <ArchiveRestore className="w-5 h-5 text-emerald-700" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">
              {isArchive ? "Archive Document" : "Restore from Archive"}
            </div>
            <div className="text-xs text-[var(--color-text-muted)] truncate">
              {doc.documentNumber || doc.title || doc.name}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="text-sm text-[var(--color-text)]">
            {isArchive ? (
              <p>
                The document and its entire revision history will be hidden from the default library view.
                Nothing is deleted — admins can restore it any time. The action is logged.
              </p>
            ) : (
              <div className="space-y-2">
                <p>
                  The document will be returned to <b>{restoreStatus}</b> status and visible in the library list again.
                </p>
                <label className="block">
                  <span className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Restore as</span>
                  <select
                    aria-label="Restore as"
                    value={restoreStatus}
                    onChange={(e) => setRestoreStatus(e.target.value as RestoreStatus)}
                    disabled={busy || basis === "loading"}
                    className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]"
                  >
                    {UNARCHIVE_RESTORE_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                  </select>
                </label>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {basis === "loading" && "Checking what it was before it was archived…"}
                  {basis === "issued" && "It was issued when it was archived — restoring it as Issued puts that issue back."}
                  {basis === "not-issued" && "It was not issued when it was archived (a Draft or In Review), so it comes back as a Draft unless you choose otherwise."}
                  {basis === "unknown" && "What it was before it was archived isn't recorded, so it comes back as Issued, as un-archiving always has, unless you choose otherwise. The database decides that restore: if it is refused, nothing changes and you can restore it as a Draft."}
                </p>
                {needsHoldAck && heldRestore.kind === "held" && (
                  <HeldSourceNotice
                    decision={{
                      kind: "acknowledge",
                      text: `Restore it as ${restoreStatus} over the active ${heldRestore.reasons.length === 1 ? "hold" : "holds"} (${heldRestore.reasons.join(", ")}): it comes back into force while ${heldRestore.reasons.length === 1 ? "the hold stands" : "they stand"}. Restoring it as a Draft needs no override.`,
                    }}
                    readError={null}
                    ack={holdAck}
                    setAck={setHoldAck}
                  />
                )}
                {heldRestore.kind === "unreadable" && isControlledIssueStatus(restoreStatus) && (
                  <HeldSourceNotice decision={{ kind: "clear" }} readError={heldRestore.error} ack={false} setAck={() => {}} />
                )}
                {restoreStatus === "Issued" && basis === "not-issued" && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
                    Restoring as <b>Issued</b> makes its current revision a controlled issue: in a library that requires
                    reviewer sign-off an unreviewed revision needs Document Control, and an active hold refuses it.
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">
              {isArchive ? "Reason *" : "Note"}
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:outline-none resize-y"
              placeholder={isArchive
                ? "e.g. Equipment removed during 2026 turnaround. Drawing no longer applicable."
                : "Optional note for the audit log"}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || (!isArchive && basis === "loading") || (needsHoldAck && !holdAck)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-60 ${
              isArchive ? "bg-slate-700 hover:bg-slate-800" : "bg-emerald-600 hover:bg-emerald-500"
            }`}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (isArchive ? <Archive className="w-3.5 h-3.5" /> : <ArchiveRestore className="w-3.5 h-3.5" />)}
            {busy ? "Saving…" : (isArchive ? "Archive Document" : "Restore Document")}
          </button>
        </div>
      </div>
    </div>
  );
}
