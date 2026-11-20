"use client";

// RevUpModal — the "publish a new revision" form.
//
// Used by admin / DocCtrl roles to push a new PDF (typically just published
// from AutoCAD) onto an existing document. Captures everything a refinery
// audit needs: engineering signoff chain, MOC reference, source CAD
// filename, narrative of what changed.
//
// PUBLISH CONTRACT (20260823): the form declares which revision the work is
// BASED ON (auto-filled from the user's recorded checkout/download intent,
// adjustable via the picker). If the document moved past that base while the
// user was working, the publish writes NOTHING and the CONFLICT SCREEN takes
// over: see exactly who moved it and when, view the visual diff, message
// them in the document thread, or deliberately publish as an unreconciled
// BRANCH (with a required reason — it becomes open debt in the DocCtrl
// queue, never a silent overwrite).
//
// PRE-PUBLISH REVIEW: when the library/folder/document carries a review
// policy, the revision is submitted as an in-review draft (2A) for reviewer
// sign-off instead of publishing directly — the live rev stays the
// controlled copy until approval. A Minor/Correction change escapes the
// gate. Publishing over another user's checkout requires a note to them;
// their checkout stays open and they're notified.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  X, Upload, Loader2, ShieldCheck,
  ArrowUpFromLine, AlertTriangle, ChevronRight, Lock,
  GitBranch, MessageSquare, Diff, FileBox,
} from "lucide-react";
import {
  revUpDocument, submitForReview, suggestNextRevisionLabel, listVersions,
  StaleBaseError, DuplicateLabelError, type StaleBaseInfo,
} from "@/lib/revisions";
import { effectiveReviewControlForDocument, effectiveModeForRevUp } from "@/lib/reviewControl";
import { effectiveDocClassForDocument, type DocClass } from "@/lib/docClass";
import { getMyEditBase } from "@/lib/intents";
import { postActivity } from "@/lib/activityThread";
import CompareRevisionsModal from "@/components/documents/CompareRevisionsModal";
import type { DocumentRecord, DocumentVersion, ReviewControl } from "@/types/schema";
import IsoGuidance from "@/components/ui/IsoGuidance";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { useDraft } from "@/hooks/useDraft";
import { tryUpload } from "@/lib/uploadRetry";
import { appAlert } from "@/components/providers/DialogProvider";
import { useEscapeClose } from "@/components/documents/useEscapeClose";

interface RevUpModalProps {
  isOpen: boolean;
  onClose: () => void;
  doc: DocumentRecord;
  libraryId: string;
  folderPath?: string[];
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onSuccess: (newVersion: DocumentVersion) => void;
  /** Fired when the publish entered the REVIEW GATE instead of landing
   *  directly (submitForReview path). Optional — most callers only care
   *  about direct publishes; the check-in flow needs both outcomes. */
  onReviewSubmitted?: (draft: { versionId: string; revisionLabel: string }) => void;
  /** Like onSuccess but carries whether the publish landed as an
   *  UNRECONCILED BRANCH — callers recording outcomes need the distinction
   *  (a branch is NOT the current revision). Fired before onSuccess. */
  onDirectPublished?: (v: DocumentVersion, branched: boolean) => void;
  /** Force the initial change type, overriding the per-library remembered
   *  value — the check-in "Minor correction" card presets "Correction" so
   *  its no-MOC / no-review promise is actually enforced. */
  presetChangeType?: DocumentVersion["changeType"];
  /** Prefill the change-log narrative (e.g. the typed correction note). */
  presetChangeLog?: string;
}

const ISSUE_TYPES: { value: NonNullable<DocumentVersion["issueType"]>; label: string }[] = [
  { value: "Internal Review", label: "Internal Review (IFR)" },
  { value: "Issued for Construction", label: "Issued for Construction (IFC)" },
  { value: "As-Built", label: "As-Built (AB)" },
  { value: "Void", label: "Void" },
];

const CHANGE_TYPES: { value: NonNullable<DocumentVersion["changeType"]>; label: string }[] = [
  { value: "Major", label: "Major" },
  { value: "Minor", label: "Minor" },
  { value: "Correction", label: "Correction" },
];

const inputClass =
  "w-full px-2.5 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:outline-none";

export default function RevUpModal({
  isOpen, onClose, doc, libraryId, folderPath,
  orgId, actorUserId, actorEmail, actorRole, onSuccess, onReviewSubmitted,
  onDirectPublished, presetChangeType, presetChangeLog,
}: RevUpModalProps) {
  // Escape closes the whole flow (the conflict screen too), like the X.
  useEscapeClose(() => { if (!submitting) { setConflict(null); onClose(); } }, isOpen);
  const [file, setFile] = useState<File | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [revisionLabel, setRevisionLabel] = useState("");
  const [issueType, setIssueType] = useState<DocumentVersion["issueType"]>("Issued for Construction");
  const [changeType, setChangeType] = useState<DocumentVersion["changeType"]>("Minor");
  const [changeLog, setChangeLog] = useState("");
  const [drawnByName, setDrawnByName] = useState(actorEmail ?? "");
  const [checkedByName, setCheckedByName] = useState("");
  const [approvedByName, setApprovedByName] = useState("");
  const [mocReference, setMocReference] = useState("");
  const [sourceFileName, setSourceFileName] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [reviewControl, setReviewControl] = useState<ReviewControl | null>(null);
  const [routeThroughReview, setRouteThroughReview] = useState(true);
  const [showMore, setShowMore] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState("");

  // Base declaration ("what my work is built on").
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [baseVersionId, setBaseVersionId] = useState<string | "none">("none");
  const [baseWasRecorded, setBaseWasRecorded] = useState(false);

  // Conflict state — set when the contract rejects a stale base.
  const [conflict, setConflict] = useState<StaleBaseInfo | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [showBranchInput, setShowBranchInput] = useState(false);
  const [branchReason, setBranchReason] = useState("");
  const [conflictMsg, setConflictMsg] = useState("");
  const [msgSent, setMsgSent] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);

  // Remember the last-used issue purpose + change type PER LIBRARY — a
  // publisher shipping ten IFC sheets should not re-pick both dropdowns ten
  // times (and shouldn't get a governance-relevant default they never chose).
  const memoryKey = `mfg.revup.${libraryId}`;

  // On open: suggest the next rev label, load the version list for the base
  // picker, and resolve the user's RECORDED base (their checkout / download
  // intent) — the honest default for "what is your work built on?".
  useEffect(() => {
    if (!isOpen || !doc.id) return;
    setRevisionLabel(suggestNextRevisionLabel(doc.rev));
    try {
      const remembered = JSON.parse(localStorage.getItem(memoryKey) ?? "null") as
        { issueType?: DocumentVersion["issueType"]; changeType?: DocumentVersion["changeType"] } | null;
      if (remembered?.issueType) setIssueType(remembered.issueType);
      if (remembered?.changeType) setChangeType(remembered.changeType);
    } catch { /* private mode */ }
    // An explicit caller preset beats the remembered value — the launcher
    // knows what this publish IS (e.g. check-in's Correction card).
    if (presetChangeType) setChangeType(presetChangeType);
    if (presetChangeLog) setChangeLog(presetChangeLog);
    setError(null);
    setConflict(null);
    setShowBranchInput(false);
    setBranchReason("");
    setMsgSent(false);
    setOverrideReason("");
    setEffectiveDate("");
    let alive = true;
    (async () => {
      try {
        const [vs, recordedBase] = await Promise.all([
          listVersions(doc.id!),
          getMyEditBase(doc.id!, actorUserId),
        ]);
        if (!alive) return;
        setVersions(vs);
        if (recordedBase !== undefined) {
          setBaseVersionId(recordedBase ?? "none");
          setBaseWasRecorded(true);
        } else {
          setBaseVersionId(doc.currentVersionId ?? "none");
          setBaseWasRecorded(false);
        }
      } catch {
        if (!alive) return;
        setBaseVersionId(doc.currentVersionId ?? "none");
        setBaseWasRecorded(false);
      }
    })();
    return () => { alive = false; };
  }, [isOpen, doc.id, doc.rev, doc.currentVersionId, actorUserId, memoryKey, presetChangeType, presetChangeLog]);

  // Typed words survive a reload or a closed window (declared after the
  // reset above so a restored draft wins). A caller's preset text wins
  // over a draft, so no draft is kept then.
  useDraft<string>(isOpen && doc.id && !presetChangeLog ? `revup:${doc.id}` : null, changeLog, setChangeLog, (v) => !v.trim());
  useDraft<string>(isOpen && doc.id ? `revup-note:${doc.id}` : null, overrideReason, setOverrideReason, (v) => !v.trim());
  useDraft<string>(isOpen && doc.id ? `revup-branch:${doc.id}` : null, branchReason, setBranchReason, (v) => !v.trim());

  // Resolve this library/folder/document's pre-publish review policy when the
  // modal opens, so we know whether to publish directly or open an in-review
  // draft — and its declared document class, which drives the MOC gate.
  const [docClass, setDocClass] = useState<DocClass | null>(null);
  // "We couldn't check the class" is NOT "no class declared" — on a transient
  // resolution failure the MOC gate fails CLOSED (drawing rules assumed).
  const [docClassUnknown, setDocClassUnknown] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    (async () => {
      try {
        const c = await effectiveReviewControlForDocument({ reviewControl: doc.reviewControl ?? null, collectionId: doc.collectionId ?? null, libraryId });
        if (alive) setReviewControl(c);
      } catch { if (alive) setReviewControl(null); }
      try {
        const cls = await effectiveDocClassForDocument({ id: doc.id, collectionId: doc.collectionId ?? null, libraryId });
        if (alive) { setDocClass(cls); setDocClassUnknown(false); }
      } catch {
        if (alive) { setDocClass(null); setDocClassUnknown(true); }
      }
    })();
    return () => { alive = false; };
  }, [isOpen, doc.id, doc.reviewControl, doc.collectionId, libraryId]);

  // The mode that actually applies to THIS rev-up — a Minor/Correction change is
  // an escape hatch that always publishes directly (no sign-off cycle).
  const effMode = effectiveModeForRevUp({ control: reviewControl ?? { mode: "none" }, changeType });
  const willReview = effMode === "require" || (effMode === "publisher_choice" && routeThroughReview);

  // THE PSM GATE (OSHA 1910.119(l)): a non-minor revision of a declared
  // DRAWING requires its Management of Change reference before it may
  // publish. Minor/Correction is replacement-in-kind and stays exempt —
  // the same boundary the review gate already draws. An UNKNOWN class
  // (resolution failed) is treated as drawing: PSM gates fail closed.
  const isMinorLike = changeType === "Minor" || changeType === "Correction";
  const mocRequired = (docClass === "drawing" || docClassUnknown) && !isMinorLike;

  // The document is held by SOMEONE ELSE — publishing will leave their checkout
  // open, note it on their thread, and notify them. Requires an override message.
  const lockedByOther = !!doc.checkedOutBy && String(doc.checkedOutBy) !== String(actorUserId);

  // Auto-fill source filename from the picked file (common workflow: the
  // engineer publishes the DWG to PDF; the PDF filename mirrors the DWG).
  useEffect(() => {
    if (file && !sourceFileName) {
      // Strip the file extension and suggest as the .dwg name
      const stem = file.name.replace(/\.[^.]+$/, "");
      setSourceFileName(`${stem}.dwg`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const handleFile = useCallback((f: File | null) => {
    setFile(f);
    setError(null);
  }, []);

  const pdfDrag = useFileDrag((fs) => handleFile(fs[0] ?? null), submitting);
  const srcDrag = useFileDrag((fs) => setSourceFile(fs[0] ?? null), submitting);

  const doPublish = async (asBranch: boolean) => {
    setError(null);
    if (!file) return setError("Please attach the new PDF.");
    if (!revisionLabel.trim()) return setError("Revision label is required.");
    if (!changeLog.trim()) return setError("Describe what changed (required).");
    if (asBranch && branchReason.trim().length < 5) {
      return setError("A branch needs a reason (at least 5 characters) - it becomes an open item until reconciled.");
    }
    if (lockedByOther && !overrideReason.trim()) {
      return setError(
        `${doc.checkedOutByName || "Another user"} has this checked out - add a note explaining why you're publishing now.`,
      );
    }
    if (mocRequired && mocReference.trim().length < 3) {
      return setError(
        "This is a drawing-class document - PSM requires the MOC reference for a non-minor revision. Enter the MOC number, or set the change type to Minor/Correction if this is replacement-in-kind.",
      );
    }

    setSubmitting(true);
    try {
      const common = {
        doc, libraryId, folderPath, file,
        revisionLabel, changeLog,
        issueType, changeType,
        drawnByName, checkedByName, approvedByName,
        mocReference, sourceFileName,
        effectiveDate: effectiveDate || null,
        orgId, actorUserId, actorEmail, actorRole,
        overrideReason: lockedByOther ? overrideReason : undefined,
      };
      // The upload and its save run through tryUpload, so a failed one gets
      // "Try again" on the corner card with the same file. Safe to repeat: a
      // second run that finds its revision already saved stops on the
      // duplicate label instead of saving it twice. On the first run a
      // conflict or duplicate is handed back to this form (it has its own
      // screen for those); a retry from the card reports them as failures.
      const review = willReview && !asBranch;
      let attempt = 0;
      const run = async () => {
        const first = attempt++ === 0;
        try {
          if (review) return { kind: "review" as const, submitted: await submitForReview(common) };
          const r = await revUpDocument({
            ...common,
            expectedBaseVersionId: baseVersionId === "none" ? null : baseVersionId,
            asBranch,
            branchReason: asBranch ? branchReason.trim() : undefined,
            sourceFile,
          });
          return { kind: "direct" as const, newVersion: r.newVersion, branched: !!r.branched };
        } catch (err) {
          if (first && (err instanceof StaleBaseError || err instanceof DuplicateLabelError)) return { kind: "stop" as const, err };
          throw err;
        }
      };
      const out = await tryUpload(file.name, run, {
        onRetried: (o) => {
          if (o.kind === "direct") { onDirectPublished?.(o.newVersion, o.branched); onSuccess(o.newVersion); }
          else if (o.kind === "review") onReviewSubmitted?.(o.submitted);
        },
      });
      if (out.kind === "stop") throw out.err;
      if (out.kind === "review") {
        // Open an in-review draft (2A) instead of publishing. The live rev stays
        // the controlled copy; reviewers are notified. The list's realtime refresh
        // surfaces the "in review" pill. Base conflicts don't apply here — the
        // draft never touches the current revision.
        const submitted = out.submitted;
        // The most consequential outcome in publishing must not be silent:
        // tell the user exactly what happened and what happens next.
        void appAlert({
          title: `Sent for review: draft ${submitted.revisionLabel}`,
          message: "The reviewers were told. The current revision stays in force until the last reviewer signs, then the draft publishes.",
        });
        onReviewSubmitted?.(submitted);
      } else {
        const { newVersion, branched } = out;
        onDirectPublished?.(newVersion, branched);
        onSuccess(newVersion);
        if (branched) {
          // The branch is real but NOT current — make sure that lands.
          void appAlert({
            title: "Saved as a branch, not the current revision",
            message: `Rev ${newVersion.revisionLabel} is saved but is not the current revision. It stays on the Doc Control open items until it is merged into a later revision or withdrawn.`,
          });
        }
      }
      // Remember the choices that worked for next time (per library).
      try { localStorage.setItem(memoryKey, JSON.stringify({ issueType, changeType })); } catch { /* ignore */ }
      // Reset form state
      setFile(null);
      setSourceFile(null);
      setChangeLog("");
      setMocReference("");
      setCheckedByName("");
      setApprovedByName("");
      setOverrideReason("");
      setConflict(null);
      onClose();
    } catch (e) {
      if (e instanceof StaleBaseError) {
        // The document moved under this user. Nothing was written — switch
        // to the conflict screen. Refresh the version list so the diff can
        // show the interloper's revision.
        setConflict(e.info);
        setShowBranchInput(false);
        try { setVersions(await listVersions(doc.id!)); } catch { /* diff falls back */ }
      } else if (e instanceof DuplicateLabelError) {
        setError(`${e.message} Someone may have published while this was open. The next label is filled in: check it and publish again.`);
        setRevisionLabel(suggestNextRevisionLabel(doc.rev));
      } else {
        console.error("Rev up failed", e);
        setError(`It didn't publish: ${(e as Error).message || "try again"}.`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendConflictMessage = async () => {
    if (!conflict || !doc.id || !doc.orgId) return;
    const text = conflictMsg.trim() ||
      `Heads up - I was about to publish Rev ${revisionLabel} of ${doc.documentNumber || doc.title || "this document"} based on an older revision, and hit your Rev ${conflict.currentRev}. Let's coordinate before I re-publish.`;
    try {
      await postActivity({
        orgId: doc.orgId,
        documentId: doc.id,
        userId: actorUserId,
        userName: actorEmail?.split("@")[0] || "User",
        text,
      });
      setMsgSent(true);
    } catch (e) {
      setError(`Couldn't send the message: ${(e as Error).message || "try again"}.`);
    }
  };

  if (!isOpen) return null;

  const myBaseVersion = versions.find((v) => v.id === baseVersionId) ?? null;
  const conflictCurrentVersion = conflict
    ? versions.find((v) => v.id === conflict.currentVersionId) ?? null
    : null;

  // ─── CONFLICT SCREEN ───────────────────────────────────────────────────
  if (conflict) {
    return (
      <div className="fixed inset-0 z-[200] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
        <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden my-8 animate-in fade-in zoom-in-95">
          <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
            {/* Arrow = one step back (to the form). X = close the flow. */}
            <button onClick={() => setConflict(null)} disabled={submitting} aria-label="Back to the form" title="Back to the form"
              className="p-2 -ml-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded-lg">
              <ChevronRight className="w-4 h-4 rotate-180" />
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-black text-amber-800 dark:text-amber-300 inline-flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> This document changed while you were working</div>
              <div className="text-xs text-[var(--color-text-muted)] truncate">
                {doc.documentNumber || doc.title || doc.name}
              </div>
            </div>
            <button aria-label="Close" onClick={() => { setConflict(null); onClose(); }} disabled={submitting} title="Close" className="p-2 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded-lg">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5 space-y-4">
            <div className="text-sm text-[var(--color-text)] leading-relaxed">
              <b>{conflict.currentByName || "Another user"}</b> published{" "}
              <b>Rev {conflict.currentRev ?? "?"}</b>
              {conflict.currentAt ? <> on <b>{new Date(conflict.currentAt).toLocaleString()}</b></> : null}
              {" "}while you were working.
              {conflict.currentChangeLog && (
                <span className="block mt-1 text-xs italic text-[var(--color-text-muted)]">
                  Their change: &ldquo;{conflict.currentChangeLog}&rdquo;
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              Your file is based on <b>Rev {myBaseVersion?.revisionLabel ?? doc.rev ?? "?"}</b> and doesn&apos;t have their changes.
              <b> Nothing was published.</b> Add their change to your CAD file, then publish on top of Rev {conflict.currentRev}.
            </p>

            {/* Actions */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                onClick={() => setShowDiff(true)}
                disabled={!myBaseVersion || !conflictCurrentVersion}
                className="flex items-center gap-2 p-3 rounded-xl border-2 border-[var(--color-border)] hover:border-[var(--color-border-strong)] text-left disabled:opacity-40"
              >
                <Diff className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                <div>
                  <div className="text-xs font-bold text-[var(--color-text)]">View what changed</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">Visual diff: your base → their Rev {conflict.currentRev}</div>
                </div>
              </button>
              <div className="p-3 rounded-xl border-2 border-[var(--color-border)]">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                  <div className="text-xs font-bold text-[var(--color-text)]">
                    Message {conflict.currentByName || "them"} in the document thread
                  </div>
                </div>
                {msgSent ? (
                  <div className="mt-2 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">Sent to the document thread.</div>
                ) : (
                  <div className="mt-2 flex gap-1.5">
                    <input
                      value={conflictMsg}
                      onChange={(e) => setConflictMsg(e.target.value)}
                      placeholder="Your note, or leave blank for a short heads-up"
                      className="flex-1 px-2 py-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs"
                    />
                    <button
                      onClick={handleSendConflictMessage}
                      className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-[var(--color-text)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
                    >
                      Send
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Branch escape hatch — deliberate, reasoned, tracked. */}
            <div className="border border-[var(--color-border)] rounded-xl p-3">
              {!showBranchInput ? (
                <button
                  onClick={() => setShowBranchInput(true)}
                  className="flex items-center gap-2 text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >
                  <GitBranch className="w-3.5 h-3.5" />
                  I still need to publish my file: save it as a branch…
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-[var(--color-text)]">
                    <GitBranch className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                    Save as a branch
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                    Your file is saved but does <b>not</b> become the current revision. It stays an open item for
                    Doc Control and both of you until it is merged into a later revision or withdrawn.
                  </div>
                  <textarea
                    value={branchReason}
                    onChange={(e) => setBranchReason(e.target.value)}
                    rows={2}
                    placeholder="Why it can't wait (required)"
                    className={`${inputClass} resize-y`}
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => { setShowBranchInput(false); setBranchReason(""); }}
                      className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border border-[var(--color-border)]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => doPublish(true)}
                      disabled={submitting || branchReason.trim().length < 5}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                    >
                      {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitBranch className="w-3 h-3" />}
                      Save branch
                    </button>
                  </div>
                </div>
              )}
            </div>

            {error && (
              <p role="alert" className="border-l-2 border-rose-500 pl-3 text-xs text-rose-700 dark:text-rose-300">{error}</p>
            )}
          </div>

          <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end">
            <button
              onClick={() => { setConflict(null); onClose(); }}
              className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
            >
              Close, I&apos;ll talk to them first
            </button>
          </div>
        </div>

        {showDiff && myBaseVersion && conflictCurrentVersion && (
          <CompareRevisionsModal
            isOpen={showDiff}
            onClose={() => setShowDiff(false)}
            doc={doc}
            initialBaseVersionId={myBaseVersion.id}
            initialCompareVersionId={conflictCurrentVersion.id}
          />
        )}
      </div>
    );
  }

  // ─── NORMAL FORM ───────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-[200] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden my-8 animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 bg-[var(--color-surface-2)] rounded-lg">
            <ArrowUpFromLine className="w-5 h-5 text-[var(--color-text-muted)]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Publish a new revision</div>
            <div className="text-xs text-[var(--color-text-muted)] truncate">
              {doc.documentNumber || doc.title || doc.name}, now at Rev {doc.rev || "-"}
            </div>
          </div>
          <button aria-label="Close" onClick={onClose} disabled={submitting} className="p-2 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* File drop zone */}
          <div>
            <label className="text-[11px] font-black text-[var(--color-text)] uppercase tracking-widest">New PDF</label>
            <div
              {...pdfDrag.bind}
              onClick={() => fileInputRef.current?.click()}
              role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
              className={`mt-1.5 rounded-xl border-2 border-dashed transition-colors cursor-pointer p-4 ${
                file ? "border-[var(--color-border-strong)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] hover:border-slate-400 bg-[var(--color-surface-2)] text-center"
              } ${pdfDrag.ring}`}
            >
              {pdfDrag.over ? (
                <div className="text-sm font-bold text-[var(--color-text)] text-center">{pdfDrag.say}</div>
              ) : file ? (
                <div className="flex items-center gap-3 text-left">
                  <FileThumb file={file} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[var(--color-text)] truncate">{file.name}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">{formatSize(file.size)} · tap to pick another</div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
                  <Upload className="w-4 h-4" />
                  Drop the PDF here, or tap to pick it
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
            </div>
          </div>

          {/* Base declaration — the publish contract's expected base. */}
          <Field
            label="Based On Revision *"
            hint={baseWasRecorded
              ? "Filled in from your checkout or download."
              : "No checkout or download of yours is on record. Pick the revision you started from."}
          >
            <select
              value={baseVersionId}
              onChange={(e) => { setBaseVersionId(e.target.value as string); setBaseWasRecorded(false); }}
              className={inputClass}
            >
              {versions.length === 0 && <option value="none">First revision (no prior version)</option>}
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  Rev {v.revisionLabel}
                  {v.id === doc.currentVersionId ? " (current)" : ""}
                  {v.supersededAt ? " - superseded" : ""}
                </option>
              ))}
            </select>
            {baseVersionId !== "none" && baseVersionId !== (doc.currentVersionId ?? "none") && (
              <p className="mt-1.5 border-l-2 border-amber-500 pl-2 text-[11px] text-amber-800 dark:text-amber-300">
                That isn&apos;t the current revision, so publishing will stop and show what changed since.
              </p>
            )}
          </Field>

          {/* Rev label + Issue purpose + Change type */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Revision Label *" hint="Free text - e.g. 1, R3, IFC-A">
              <input
                value={revisionLabel}
                onChange={(e) => setRevisionLabel(e.target.value)}
                className={inputClass}
                placeholder="0"
              />
            </Field>
            <Field label="Issue Purpose" isoTopic="ifc_release">
              <select value={issueType} onChange={(e) => setIssueType(e.target.value as DocumentVersion["issueType"])} className={inputClass}>
                {ISSUE_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Change Type">
              <select value={changeType} onChange={(e) => setChangeType(e.target.value as DocumentVersion["changeType"])} className={inputClass}>
                {CHANGE_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>

          {/* The escape hatch made visible: a review-gated library where the
              chosen change type (Minor/Correction) bypasses the gate. The
              default dropdown value must never silently decide governance. */}
          {reviewControl && reviewControl.mode !== "none" && effMode === "none" && (
            <p className="border-l-2 border-amber-500 pl-3 text-[12px] text-amber-800 dark:text-amber-300">
              A <b>{changeType}</b> change skips this library&apos;s reviewers. If it&apos;s more than that, set Change Type to <b>Major</b>.
            </p>
          )}

          {/* Pre-publish review banner — this library gates revisions behind
              reviewer sign-off. A Minor/Correction change escapes the gate. */}
          {effMode !== "none" && (
            <div className="text-[12px] text-[var(--color-text)] space-y-2">
              <div className="flex items-start gap-2">
                <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                <span>
                  {willReview
                    ? <>Goes to the reviewers as draft <b>{revisionLabel || "?"}A</b>. It goes live once they sign.</>
                    : <>Publishes now, without review.</>}
                </span>
              </div>
              {effMode === "publisher_choice" && (
                <label className="flex items-center gap-2 font-bold cursor-pointer">
                  <input type="checkbox" checked={routeThroughReview} onChange={(e) => setRouteThroughReview(e.target.checked)} />
                  Route this revision through review
                </label>
              )}
            </div>
          )}

          {/* Change narrative */}
          <Field label="What changed *" hint="What changed and why">
            <textarea
              value={changeLog}
              onChange={(e) => setChangeLog(e.target.value)}
              rows={4}
              className={`${inputClass} resize-y`}
              placeholder="e.g. Added isolation valve on PSV-201 discharge per MOC-2026-0142. Updated line numbers on north flare header."
            />
          </Field>

          {/* THE PSM GATE — when the declared class makes MOC mandatory, the
              field leaves the fold and stands where it can't be missed. */}
          {mocRequired && (
            <Field
              label={docClassUnknown ? "MOC Reference (required - class unverified)" : "MOC Reference (required - drawing class)"}
              hint={docClassUnknown
                ? "The document's class couldn't be verified right now, so drawing rules apply: a non-minor revision needs its Management of Change."
                : "PSM: a non-minor drawing revision needs its Management of Change. Minor/Correction change types are replacement-in-kind and exempt."}
              isoTopic="moc_reference"
            >
              <input
                value={mocReference}
                onChange={(e) => setMocReference(e.target.value)}
                className={`${inputClass} ${mocReference.trim().length >= 3 ? "" : "border-amber-400 bg-amber-50/40"}`}
                placeholder="MOC-2026-0142"
              />
            </Field>
          )}
          {/* The exemption must be VISIBLE, not silent: a remembered "Minor"
              change type on a drawing waives the MOC — say so, so a real
              process change doesn't slip out under last week's setting. */}
          {docClass === "drawing" && isMinorLike && (
            <p className="border-l-2 border-amber-500 pl-2 text-[11px] text-amber-800 dark:text-amber-300">
              No MOC needed for a <b>{changeType}</b> drawing change. If it changes the process, set Change Type to <b>Major</b>.
            </p>
          )}

          {/* THE FOLD — everyday publishes are: PDF, base, label, narrative.
              The audit metered ~14 decisions on this form; the signoff chain,
              MOC, source-CAD naming, effective date, and CAD attach are
              real but rare — one click away, not in every face. */}
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            <span>More: sign-offs, MOC, effective date, CAD file</span>
            <span>{showMore ? "▲" : "▼"}</span>
          </button>
          {showMore && (<>
          {/* Signoff chain */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Drawn By"><input value={drawnByName} onChange={(e) => setDrawnByName(e.target.value)} className={inputClass} /></Field>
            <Field label="Checked By"><input value={checkedByName} onChange={(e) => setCheckedByName(e.target.value)} className={inputClass} /></Field>
            <Field label="Approved By"><input value={approvedByName} onChange={(e) => setApprovedByName(e.target.value)} className={inputClass} /></Field>
          </div>

          {/* Cross-references. When the class makes MOC mandatory it already
              stands above the fold — no duplicate field here. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {!mocRequired && (
              <Field label="MOC Reference" hint="Optional ticket # from change platform" isoTopic="moc_reference">
                <input value={mocReference} onChange={(e) => setMocReference(e.target.value)} className={inputClass} placeholder="MOC-2026-0142" />
              </Field>
            )}
            <Field label="Source CAD File" hint="e.g. P-101_Rev3.dwg">
              <input value={sourceFileName} onChange={(e) => setSourceFileName(e.target.value)} className={inputClass} placeholder="P-101_Rev3.dwg" />
            </Field>
          </div>

          {/* Effective date — optional future in-force date. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Effective Date" hint="When this rev comes into force. Blank = effective immediately.">
              <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={inputClass} />
            </Field>
          </div>

          {/* Source custody: attach the native CAD file so the NEXT drafter
              pulls the authoritative DWG from the vault, not a desktop folder. */}
          <Field
            label="Attach CAD Source (recommended)"
            hint="DWG or a zip with its xrefs. Kept with this revision for the next drafter."
          >
            <div
              onClick={() => sourceInputRef.current?.click()}
              {...srcDrag.bind}
              className={`rounded-xl border-2 border-dashed cursor-pointer p-3 transition-colors ${
                sourceFile ? "border-[var(--color-border-strong)] bg-[var(--color-surface)]" : "border-[var(--color-border-strong)] hover:border-slate-400 bg-[var(--color-surface-2)] text-center"
              } ${srcDrag.ring}`}
            >
              {srcDrag.over ? (
                <div className="text-xs font-bold text-[var(--color-text)] text-center">{srcDrag.say}</div>
              ) : sourceFile ? (
                <div className="flex items-center gap-2.5 text-xs text-left">
                  <FileThumb file={sourceFile} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-[var(--color-text)] truncate">{sourceFile.name}</span>
                    <span className="block text-[11px] text-[var(--color-text-muted)]">{formatSize(sourceFile.size)}</span>
                  </span>
                  <button aria-label="Remove file"
                    onClick={(e) => { e.stopPropagation(); setSourceFile(null); }}
                    className="ml-1 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    title="Remove"
                  ><X className="w-3 h-3" /></button>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <FileBox className="w-3.5 h-3.5" />
                  Drop the DWG or zip here, or tap to pick it (optional)
                </div>
              )}
              <input
                ref={sourceInputRef}
                type="file"
                accept=".dwg,.dxf,.zip,.rvt,.step,.stp,application/zip,application/octet-stream"
                className="hidden"
                onChange={(e) => setSourceFile(e.target.files?.[0] ?? null)}
              />
            </div>
          </Field>

          </>)}

          {/* Override: the doc is checked out by someone else. Publishing leaves
              their checkout open; they're notified and pointed to the new rev. */}
          {lockedByOther && (
            <div className="border-l-2 border-amber-500 pl-3 space-y-2">
              <div className="flex items-start gap-2 text-[12px] text-amber-800 dark:text-amber-300">
                <Lock className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  <b>{doc.checkedOutByName || "Another user"}</b> has this checked out. They stay checked
                  out and are told about your new revision.
                </span>
              </div>
              <div>
                <label className="text-[11px] font-black text-[var(--color-text)] uppercase tracking-widest">
                  Note to {doc.checkedOutByName || "the checkout holder"} *
                </label>
                <textarea
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  rows={2}
                  className={`${inputClass} resize-y mt-1`}
                  placeholder="e.g. Fixed the callout on detail B. Minor, won't affect your edits."
                />
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="border-l-2 border-rose-500 pl-3 text-xs text-rose-700 dark:text-rose-300">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between gap-2">
          <div className="text-[11px] text-[var(--color-text-muted)]">
            Rev <b>{doc.rev || "-"}</b> to {willReview
              ? <b className="text-[var(--color-text)]">{revisionLabel || "?"}A (in review)</b>
              : <b className="text-[var(--color-text)]">Rev {revisionLabel || "?"}</b>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => doPublish(false)}
              disabled={submitting || !file}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
              {submitting ? (willReview ? "Sending…" : "Publishing…") : (willReview ? "Send for review" : "Publish revision")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Field({ label, hint, isoTopic, children }: { label: string; hint?: string; isoTopic?: import("@/components/ui/IsoGuidance").IsoTopic | undefined; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-black text-[var(--color-text)] uppercase tracking-widest inline-flex items-center gap-1">
        {label}
        {isoTopic && <IsoGuidance topic={isoTopic} />}
      </label>
      {hint && <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">{hint}</div>}
      <div className="mt-1">{children}</div>
    </div>
  );
}
