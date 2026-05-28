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
  X, Upload, FileText, Loader2, ShieldCheck, History,
  ArrowUpFromLine, AlertTriangle, Info,
} from "lucide-react";
import { backfillVersion, listVersions } from "@/lib/revisions";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";

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

  const onPickFile = (f: File | null) => {
    setFile(f);
    if (f && !sourceFileName) setSourceFileName(f.name);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) { setError("Pick a PDF file first."); return; }
    if (!revisionLabel.trim()) { setError("Revision label is required."); return; }
    if (!changeLog.trim()) { setError("Change narrative is required."); return; }
    setBusy(true);
    setError(null);
    try {
      const newVersion = await backfillVersion({
        doc, libraryId, folderPath, file,
        revisionLabel, changeLog,
        issueType, changeType,
        drawnByName, checkedByName, approvedByName,
        mocReference, sourceFileName,
        releasedAt: releasedAtLocal ? new Date(releasedAtLocal).toISOString() : undefined,
        supersedesVersionId: supersedesVersionId || undefined,
        orgId, actorUserId, actorEmail, actorRole,
      });
      onSuccess(newVersion);
      onClose();
    } catch (e) {
      setError((e as Error).message || "Backfill failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden my-8"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-slate-600" />
            <div>
              <h2 className="font-black text-slate-900">Backfill Older Revision</h2>
              <div className="text-[11px] text-slate-500 font-mono">
                {doc.documentNumber || doc.title || doc.name} — current is Rev {doc.rev || "—"}
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-slate-200 text-slate-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Distinction banner — make it impossible to confuse with rev-up */}
        <div className="px-5 py-3 bg-blue-50 border-b border-blue-200 flex items-start gap-2 text-xs text-blue-900">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-blue-600" />
          <div>
            <div className="font-bold">This is a historical / backfill upload.</div>
            <div className="mt-0.5">
              The document&apos;s <b>current revision will not change</b>. Use this to
              retroactively populate prior revisions (e.g. so you can diff an old
              version against the current one). For a forward release, use Rev-Up.
            </div>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {/* File picker */}
          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">File (PDF) *</label>
            <div
              className="mt-1 border-2 border-dashed border-slate-300 rounded-xl p-4 hover:border-blue-400 hover:bg-blue-50/30 transition-colors cursor-pointer text-center"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); onPickFile(e.dataTransfer.files?.[0] ?? null); }}
            >
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <div className="flex items-center justify-center gap-2 text-sm text-slate-700">
                  <FileText className="w-4 h-4 text-blue-600" />
                  <span className="font-mono">{file.name}</span>
                  <span className="text-[11px] text-slate-500 font-mono">({(file.size / 1024).toFixed(0)} KB)</span>
                </div>
              ) : (
                <div className="text-sm text-slate-500">
                  <Upload className="w-5 h-5 mx-auto mb-1 opacity-60" />
                  Click or drag a PDF here
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
                className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm font-mono"
              />
            </Field>
            <Field label="Historical Release Date">
              <input
                type="datetime-local"
                value={releasedAtLocal}
                onChange={(e) => setReleasedAtLocal(e.target.value)}
                className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm"
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
                className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm bg-white"
              >
                {ISSUE_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Change Type">
              <select
                value={changeType ?? ""}
                onChange={(e) => setChangeType(e.target.value as DocumentVersion["changeType"])}
                className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm bg-white"
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
              className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm resize-y"
            />
          </Field>

          {/* Signoffs */}
          <div className="grid grid-cols-3 gap-3">
            <Field label="Drawn By"><input value={drawnByName} onChange={(e) => setDrawnByName(e.target.value)} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm" /></Field>
            <Field label="Checked By"><input value={checkedByName} onChange={(e) => setCheckedByName(e.target.value)} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm" /></Field>
            <Field label="Approved By"><input value={approvedByName} onChange={(e) => setApprovedByName(e.target.value)} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm" /></Field>
          </div>

          {/* MOC + source filename */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="MOC Reference">
              <input value={mocReference} onChange={(e) => setMocReference(e.target.value)} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm font-mono" />
            </Field>
            <Field label="Source CAD Filename">
              <input value={sourceFileName} onChange={(e) => setSourceFileName(e.target.value)} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm font-mono" />
            </Field>
          </div>

          {/* Supersedes picker — only shows if there are existing versions */}
          {existingVersions.length > 0 && (
            <Field label="Supersedes (optional — slot into the chain)">
              <select
                value={supersedesVersionId}
                onChange={(e) => setSupersedesVersionId(e.target.value)}
                className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-sm bg-white"
              >
                <option value="">— Free-floating (no chain link)</option>
                {existingVersions.map((v) => (
                  <option key={v.id} value={v.id}>
                    Rev {v.revisionLabel}{v.releasedAt ? ` (${new Date(v.releasedAt as string).toLocaleDateString()})` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-[11px] text-slate-500 inline-flex items-center gap-1.5">
            <ShieldCheck className="w-3 h-3 text-slate-400" />
            File will be SHA-256 hashed before upload. REV_BACKFILL audit event will be recorded.
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Cancel</button>
            <button
              type="submit"
              disabled={busy || !file || !revisionLabel.trim() || !changeLog.trim()}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpFromLine className="w-3.5 h-3.5" />}
              Backfill Revision
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
      <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
