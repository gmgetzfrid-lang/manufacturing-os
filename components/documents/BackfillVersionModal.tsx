"use client";

// BackfillVersionModal — add a HISTORICAL revision to a document.
//
// Use case: the user uploaded only the current version of each
// drawing. Now they want to retroactively add prior revisions so
// the Phase 4 Compare/diff overlay has something to diff against,
// and the timeline shows accurate history.
//
// Critically: backfilling does NOT change the document's current
// revision. The current version stays current; this just adds a
// historical row to document_versions, optionally linked into the
// supersedes chain.
//
// Modeled after RevUpModal so the user sees a familiar form, but
// the prominent banner up top makes the distinction clear: this is
// retroactive documentation, not a forward release.

import React, { useEffect, useRef, useState } from "react";
import {
  X, Upload, Loader2, History,
  ArrowUpFromLine,
} from "lucide-react";
import FileThumb from "@/components/ui/FileThumb";
import { useDraft } from "@/hooks/useDraft";
import { tryUpload } from "@/lib/uploadRetry";
import { backfillVersion, listVersions } from "@/lib/revisions";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";
import { useFileDrag } from "@/hooks/useFileDrag";
import { useEscapeClose } from "@/components/documents/useEscapeClose";

interface BackfillVersionModalProps {
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

export default function BackfillVersionModal({
  isOpen, onClose, doc, libraryId, folderPath,
  orgId, actorUserId, actorEmail, actorRole, onSuccess,
}: BackfillVersionModalProps) {
  // Escape closes this dialog (only the top one when they stack).
  useEscapeClose(() => onClose(), isOpen);
  const [file, setFile] = useState<File | null>(null);
  const [revisionLabel, setRevisionLabel] = useState("");
  const [changeLog, setChangeLog] = useState("");
  const [issueType, setIssueType] = useState<DocumentVersion["issueType"]>("Issued for Construction");
  const [changeType, setChangeType] = useState<DocumentVersion["changeType"]>("Major");
  const [drawnByName, setDrawnByName] = useState("");
  const [checkedByName, setCheckedByName] = useState("");
  const [approvedByName, setApprovedByName] = useState("");
  const [mocReference, setMocReference] = useState("");
  const [sourceFileName, setSourceFileName] = useState("");
  // Historical release date, datetime-local format (YYYY-MM-DDTHH:mm).
  // Defaults to empty (= now). User picks an older date for the diff.
  const [releasedAtLocal, setReleasedAtLocal] = useState("");
  // Supersedes pointer — pick from existing versions on this doc.
  const [supersedesVersionId, setSupersedesVersionId] = useState("");

  const [existingVersions, setExistingVersions] = useState<DocumentVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load existing versions so the "supersedes" picker has options.
  useEffect(() => {
    if (!isOpen || !doc.id) return;
    let alive = true;
    listVersions(doc.id)
      .then((vs) => { if (alive) setExistingVersions(vs); })
      .catch(() => { if (alive) setExistingVersions([]); });
    return () => { alive = false; };
  }, [isOpen, doc.id]);

  // Reset form on open/close.
  useEffect(() => {
    if (!isOpen) return;
    setFile(null);
    setRevisionLabel("");
    setChangeLog("");
    setIssueType("Issued for Construction");
    setChangeType("Major");
    setDrawnByName(""); setCheckedByName(""); setApprovedByName("");
    setMocReference(""); setSourceFileName("");
    setReleasedAtLocal("");
    setSupersedesVersionId("");
    setError(null);
    setBusy(false);
  }, [isOpen, doc.id]);

  // The narrative survives a reload (after the reset above, so it wins).
  useDraft<string>(isOpen && doc.id ? `backfill:${doc.id}` : null, changeLog, setChangeLog, (v) => !v.trim());

  const onPickFile = (f: File | null) => {
    setFile(f);
    if (f && !sourceFileName) setSourceFileName(f.name);
  };
  const fileDrag = useFileDrag((fs) => onPickFile(fs[0] ?? null), busy);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) { setError("Pick a PDF file first."); return; }
    if (!revisionLabel.trim()) { setError("Revision label is required."); return; }
    if (!changeLog.trim()) { setError("Change narrative is required."); return; }
    setBusy(true);
    setError(null);
    try {
      // Upload + save, wrapped so a failure offers "Try again" with the same
      // file. A retry first looks for the revision a failed run may already
      // have saved, so it is never saved twice.
      const input = {
        doc, libraryId, folderPath, file,
        revisionLabel, changeLog,
        issueType, changeType,
        drawnByName, checkedByName, approvedByName,
        mocReference, sourceFileName,
        releasedAt: releasedAtLocal ? new Date(releasedAtLocal).toISOString() : undefined,
        supersedesVersionId: supersedesVersionId || undefined,
        orgId, actorUserId, actorEmail, actorRole,
      };
      let attempt = 0;
      const run = async () => {
        if (attempt++ > 0 && doc.id) {
          const saved = (await listVersions(doc.id)).find((v) => v.revisionLabel === revisionLabel.trim());
          if (saved) return saved;
        }
        return backfillVersion(input);
      };
      const newVersion = await tryUpload(file.name, run, { onRetried: (v) => onSuccess(v) });
      setChangeLog("");
      onSuccess(newVersion);
      onClose();
    } catch (e) {
      setError(`It didn't save: ${(e as Error).message || "try again"}.`);
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-2xl bg-[var(--color-surface)] rounded-lg shadow-2xl border border-[var(--color-border)] overflow-hidden my-8 animate-in fade-in zoom-in-95"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between bg-[var(--color-surface-2)]">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-[var(--color-text-muted)]" />
            <div>
              <h2 className="font-semibold text-[var(--color-text)]">Add an older revision</h2>
              <div className="text-[13px] text-[var(--color-text-muted)] font-display tabular-nums">
                {doc.documentNumber || doc.title || doc.name} - current is Rev {doc.rev || "-"}
              </div>
            </div>
          </div>
          <button aria-label="Close" type="button" onClick={onClose} className="p-1.5 rounded hover:bg-slate-200 text-[var(--color-text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* One line so it can't be mistaken for a new revision. */}
        <p className="px-5 py-2.5 border-b border-[var(--color-border)] text-[13px] text-[var(--color-text)]">
          <b>The current revision stays as it is.</b> This adds a past revision to the history.
        </p>

        <div className="p-5 space-y-4">
          {/* File picker */}
          <div>
            <label className="text-[13px] font-semibold text-[var(--color-text)] ">File (PDF) *</label>
            <div
              className={`mt-1 border-2 border-dashed border-[var(--color-border-strong)] rounded-xl p-4 hover:bg-[var(--color-surface-2)] transition-colors cursor-pointer text-center ${fileDrag.ring}`}
              onClick={() => inputRef.current?.click()}
              {...fileDrag.bind}
            >
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
              />
              {fileDrag.over ? (
                <div className="text-sm font-bold text-[var(--color-text)]">{fileDrag.say}</div>
              ) : file ? (
                <div className="flex items-center gap-3 text-left">
                  <FileThumb file={file} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-[var(--color-text)] truncate">{file.name}</span>
                    <span className="block text-[13px] text-[var(--color-text-muted)]">{file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(0)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`} · tap to pick another</span>
                  </span>
                </div>
              ) : (
                <div className="text-sm text-[var(--color-text-muted)]">
                  <Upload className="w-5 h-5 mx-auto mb-1 opacity-60" />
                  Drop the PDF here, or tap to pick it
                </div>
              )}
            </div>
          </div>

          {/* Rev label + historical date */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Revision Label *">
              <input
                value={revisionLabel}
                onChange={(e) => setRevisionLabel(e.target.value)}
                placeholder="e.g. 0, 1, A, R2"
                className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm font-display tabular-nums"
              />
            </Field>
            <Field label="Historical Release Date">
              <input
                type="datetime-local"
                value={releasedAtLocal}
                onChange={(e) => setReleasedAtLocal(e.target.value)}
                className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm"
                title="When the file was originally released. Leave empty for now."
              />
            </Field>
          </div>

          {/* Issue + change types */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Issue Type">
              <select
                value={issueType ?? ""}
                onChange={(e) => setIssueType(e.target.value as DocumentVersion["issueType"])}
                className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm bg-[var(--color-surface)]"
              >
                {ISSUE_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Change Type">
              <select
                value={changeType ?? ""}
                onChange={(e) => setChangeType(e.target.value as DocumentVersion["changeType"])}
                className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm bg-[var(--color-surface)]"
              >
                {CHANGE_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>

          {/* Narrative */}
          <Field label="Change Narrative *">
            <textarea
              value={changeLog}
              onChange={(e) => setChangeLog(e.target.value)}
              placeholder="What this revision contained / what changed since the prior one."
              rows={3}
              className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm resize-y"
            />
          </Field>

          {/* Signoffs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Drawn By"><input value={drawnByName} onChange={(e) => setDrawnByName(e.target.value)} className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm" /></Field>
            <Field label="Checked By"><input value={checkedByName} onChange={(e) => setCheckedByName(e.target.value)} className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm" /></Field>
            <Field label="Approved By"><input value={approvedByName} onChange={(e) => setApprovedByName(e.target.value)} className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm" /></Field>
          </div>

          {/* MOC + source filename */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="MOC Reference">
              <input value={mocReference} onChange={(e) => setMocReference(e.target.value)} className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm font-display tabular-nums" />
            </Field>
            <Field label="Source CAD Filename">
              <input value={sourceFileName} onChange={(e) => setSourceFileName(e.target.value)} className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm font-mono" />
            </Field>
          </div>

          {/* Supersedes picker — only shows if there are existing versions */}
          {existingVersions.length > 0 && (
            <Field label="Supersedes (optional - slot into the chain)">
              <select
                value={supersedesVersionId}
                onChange={(e) => setSupersedesVersionId(e.target.value)}
                className="w-full border border-[var(--color-border-strong)] rounded px-2.5 py-1.5 text-sm bg-[var(--color-surface)]"
              >
                <option value="">- Free-floating (no chain link)</option>
                {existingVersions.map((v) => (
                  <option key={v.id} value={v.id}>
                    Rev {v.revisionLabel}{v.releasedAt ? ` (${new Date(v.releasedAt as string).toLocaleDateString()})` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {error && (
            <p role="alert" className="border-l-2 border-rose-500 pl-3 text-[13px] text-rose-700 dark:text-rose-300">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-end">
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5">Cancel</button>
            <button
              type="submit"
              disabled={busy || !file || !revisionLabel.trim() || !changeLog.trim()}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] px-3 py-1.5 rounded disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpFromLine className="w-3.5 h-3.5" />}
              Add revision
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-semibold text-[var(--color-text)] ">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
