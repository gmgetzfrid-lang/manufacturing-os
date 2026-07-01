"use client";

// RevUpModal — the "publish a new revision" form.
//
// Used by admin / DocCtrl roles to push a new PDF (typically just published
// from AutoCAD) onto an existing document. Captures everything a refinery
// audit needs: engineering signoff chain, MOC reference, source CAD
// filename, narrative of what changed.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  X, Upload, FileText, Loader2, ShieldCheck,
  ArrowUpFromLine, AlertTriangle, ChevronRight, Lock,
} from "lucide-react";
import { revUpDocument, submitForReview, suggestNextRevisionLabel } from "@/lib/revisions";
import { effectiveReviewControlForDocument, effectiveModeForRevUp } from "@/lib/reviewControl";
import type { DocumentRecord, DocumentVersion, ReviewControl } from "@/types/schema";
import IsoGuidance from "@/components/ui/IsoGuidance";
import AiDraftButton from "@/components/ai/AiDraftButton";

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
  orgId, actorUserId, actorEmail, actorRole, onSuccess,
}: RevUpModalProps) {
  const [file, setFile] = useState<File | null>(null);
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

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-suggest the next rev label when the modal opens
  useEffect(() => {
    if (isOpen) {
      setRevisionLabel(suggestNextRevisionLabel(doc.rev));
      setOverrideReason("");
      setError(null);
    }
  }, [isOpen, doc.rev]);

  // Resolve this library/folder/document's pre-publish review policy when the
  // modal opens, so we know whether to publish directly or open an in-review draft.
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    (async () => {
      try {
        const c = await effectiveReviewControlForDocument({ reviewControl: doc.reviewControl ?? null, collectionId: doc.collectionId ?? null, libraryId });
        if (alive) setReviewControl(c);
      } catch { if (alive) setReviewControl(null); }
    })();
    return () => { alive = false; };
  }, [isOpen, doc.id, doc.reviewControl, doc.collectionId, libraryId]);

  // The mode that actually applies to THIS rev-up — a Minor/Correction change is
  // an escape hatch that always publishes directly (no sign-off cycle).
  const effMode = effectiveModeForRevUp({ control: reviewControl ?? { mode: "none" }, changeType });
  const willReview = effMode === "require" || (effMode === "publisher_choice" && routeThroughReview);

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

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!file) return setError("Please attach the new PDF.");
    if (!revisionLabel.trim()) return setError("Revision label is required.");
    if (!changeLog.trim()) return setError("Describe what changed (required).");
    if (lockedByOther && !overrideReason.trim()) {
      return setError(
        `${doc.checkedOutByName || "Another user"} has this checked out — add a note explaining why you're publishing now.`,
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
        orgId, actorUserId, actorEmail, actorRole,
        overrideReason: lockedByOther ? overrideReason : undefined,
      };
      if (willReview) {
        // Open an in-review draft (2A) instead of publishing. The live rev stays
        // the controlled copy; reviewers are notified. The list's realtime refresh
        // surfaces the "in review" pill.
        await submitForReview(common);
      } else {
        const { newVersion } = await revUpDocument(common);
        onSuccess(newVersion);
      }
      // Reset form state
      setFile(null);
      setChangeLog("");
      setMocReference("");
      setCheckedByName("");
      setApprovedByName("");
      setOverrideReason("");
      onClose();
    } catch (e) {
      console.error("Rev up / submit-for-review failed", e);
      setError((e as Error).message || "Failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden my-8 animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 bg-orange-100 rounded-lg">
            <ArrowUpFromLine className="w-5 h-5 text-orange-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Publish New Revision</div>
            <div className="text-xs text-[var(--color-text-muted)] truncate">
              {doc.documentNumber || doc.title || doc.name} — currently Rev {doc.rev || "—"}
            </div>
          </div>
          <button onClick={onClose} disabled={submitting} className="p-2 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* File drop zone */}
          <div>
            <label className="text-[11px] font-black text-[var(--color-text)] uppercase tracking-widest">New PDF</label>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`mt-1.5 rounded-xl border-2 border-dashed transition-colors cursor-pointer p-6 text-center ${
                dragOver ? "border-orange-500 bg-orange-50" :
                file ? "border-emerald-400 bg-emerald-50" : "border-[var(--color-border-strong)] hover:border-slate-400 bg-[var(--color-surface-2)]"
              }`}
            >
              {file ? (
                <div className="flex items-center justify-center gap-2 text-sm text-emerald-700">
                  <FileText className="w-4 h-4" />
                  <span className="font-medium">{file.name}</span>
                  <span className="text-xs text-emerald-600">({(file.size / 1024).toFixed(0)} KB)</span>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
                  <Upload className="w-4 h-4" />
                  Drop the published PDF here, or click to browse
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

          {/* Rev label + Issue purpose + Change type */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Revision Label *" hint="Free text — e.g. 1, R3, IFC-A">
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

          {/* Pre-publish review banner — this library gates revisions behind
              reviewer sign-off. A Minor/Correction change escapes the gate. */}
          {effMode !== "none" && (
            <div className="rounded-lg border border-violet-300 bg-violet-50 p-3 text-[12px] text-violet-900 space-y-2">
              <div className="flex items-start gap-2">
                <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-violet-600" />
                <span>
                  This library requires <b>pre-publish review</b>.{" "}
                  {willReview
                    ? <>Your revision will be submitted as an <b>in-review draft ({revisionLabel || "?"}A)</b> for reviewer sign-off — it won&apos;t go live until approved.</>
                    : <>You&apos;ve chosen to publish directly, without review.</>}
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
          <Field label="Change Narrative *" hint="What changed and why (PSM-required)">
            <div className="flex items-center justify-end mb-1.5">
              <AiDraftButton
                label="Draft narrative"
                mode="handoff"
                buildContext={() => [
                  "Write a concise, professional engineering change narrative for a document revision (PSM audit quality).",
                  doc?.documentNumber ? `Document: ${doc.documentNumber}${doc.title ? ` — ${doc.title}` : ""}.` : "",
                  revisionLabel ? `New revision: ${revisionLabel} (${changeType}, ${issueType}).` : "",
                  changeLog.trim() ? `Expand these notes into a clear narrative:\n${changeLog}` : "Ask the user to add a few keywords first.",
                ].filter(Boolean).join("\n")}
                onUse={(text) => setChangeLog(text)}
              />
            </div>
            <textarea
              value={changeLog}
              onChange={(e) => setChangeLog(e.target.value)}
              rows={4}
              className={`${inputClass} resize-y`}
              placeholder="e.g. Added isolation valve on PSV-201 discharge per MOC-2026-0142. Updated line numbers on north flare header."
            />
          </Field>

          {/* Signoff chain */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Drawn By"><input value={drawnByName} onChange={(e) => setDrawnByName(e.target.value)} className={inputClass} /></Field>
            <Field label="Checked By"><input value={checkedByName} onChange={(e) => setCheckedByName(e.target.value)} className={inputClass} /></Field>
            <Field label="Approved By"><input value={approvedByName} onChange={(e) => setApprovedByName(e.target.value)} className={inputClass} /></Field>
          </div>

          {/* Cross-references */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="MOC Reference" hint="Optional ticket # from change platform" isoTopic="moc_reference">
              <input value={mocReference} onChange={(e) => setMocReference(e.target.value)} className={inputClass} placeholder="MOC-2026-0142" />
            </Field>
            <Field label="Source CAD File" hint="e.g. P-101_Rev3.dwg">
              <input value={sourceFileName} onChange={(e) => setSourceFileName(e.target.value)} className={inputClass} placeholder="P-101_Rev3.dwg" />
            </Field>
          </div>

          {/* Override: the doc is checked out by someone else. Publishing leaves
              their checkout open; they're notified and pointed to the new rev. */}
          {lockedByOther && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
              <div className="flex items-start gap-2 text-[12px] text-amber-900">
                <Lock className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
                <span>
                  <b>{doc.checkedOutByName || "Another user"}</b> has this checked out.
                  Publishing won&apos;t release their checkout — they stay in, but get
                  notified and pointed to your new revision. Best for minor changes.
                </span>
              </div>
              <div>
                <label className="text-[10px] font-black text-amber-900 uppercase tracking-widest">
                  Note to {doc.checkedOutByName || "the checkout holder"} *
                </label>
                <textarea
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  rows={2}
                  className={`${inputClass} resize-y mt-1`}
                  placeholder="e.g. Fixed the callout on detail B — minor, won't affect your edits."
                />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg p-3">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
            <span>
              The previous revision will be archived (not deleted) and remain accessible in Version History.
              A SHA-256 hash of the new file is recorded for audit integrity.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between gap-2">
          <div className="text-[11px] text-[var(--color-text-muted)]">
            Going from <b>Rev {doc.rev || "—"}</b> → {willReview
              ? <b className="text-violet-600">{revisionLabel || "?"}A (in review)</b>
              : <b className="text-orange-600">Rev {revisionLabel || "?"}</b>}
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
              onClick={handleSubmit}
              disabled={submitting || !file}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50 ${willReview ? "bg-violet-600 hover:bg-violet-500" : "bg-orange-600 hover:bg-orange-500"}`}
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
              {submitting ? (willReview ? "Submitting…" : "Publishing…") : (willReview ? "Submit for Review" : "Publish Revision")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, isoTopic, children }: { label: string; hint?: string; isoTopic?: import("@/components/ui/IsoGuidance").IsoTopic | undefined; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest inline-flex items-center gap-1">
        {label}
        {isoTopic && <IsoGuidance topic={isoTopic} />}
      </label>
      {hint && <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{hint}</div>}
      <div className="mt-1">{children}</div>
    </div>
  );
}
