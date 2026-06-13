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
  ArrowUpFromLine, AlertTriangle, ChevronRight,
} from "lucide-react";
import { revUpDocument, suggestNextRevisionLabel } from "@/lib/revisions";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";
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
  "w-full px-2.5 py-2 rounded-lg border border-slate-300 bg-white text-[13px] text-slate-900 focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:outline-none";

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

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-suggest the next rev label when the modal opens
  useEffect(() => {
    if (isOpen) {
      setRevisionLabel(suggestNextRevisionLabel(doc.rev));
      setError(null);
    }
  }, [isOpen, doc.rev]);

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

    setSubmitting(true);
    try {
      const { newVersion } = await revUpDocument({
        doc, libraryId, folderPath, file,
        revisionLabel, changeLog,
        issueType, changeType,
        drawnByName, checkedByName, approvedByName,
        mocReference, sourceFileName,
        orgId, actorUserId, actorEmail, actorRole,
      });
      onSuccess(newVersion);
      // Reset form state
      setFile(null);
      setChangeLog("");
      setMocReference("");
      setCheckedByName("");
      setApprovedByName("");
      onClose();
    } catch (e) {
      console.error("Rev up failed", e);
      setError((e as Error).message || "Rev up failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-8 animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className="p-2 bg-orange-100 rounded-lg">
            <ArrowUpFromLine className="w-5 h-5 text-orange-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-slate-900">Publish New Revision</div>
            <div className="text-xs text-slate-500 truncate">
              {doc.documentNumber || doc.title || doc.name} — currently Rev {doc.rev || "—"}
            </div>
          </div>
          <button onClick={onClose} disabled={submitting} className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* File drop zone */}
          <div>
            <label className="text-[11px] font-black text-slate-700 uppercase tracking-widest">New PDF</label>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`mt-1.5 rounded-xl border-2 border-dashed transition-colors cursor-pointer p-6 text-center ${
                dragOver ? "border-orange-500 bg-orange-50" :
                file ? "border-emerald-400 bg-emerald-50" : "border-slate-300 hover:border-slate-400 bg-slate-50"
              }`}
            >
              {file ? (
                <div className="flex items-center justify-center gap-2 text-sm text-emerald-700">
                  <FileText className="w-4 h-4" />
                  <span className="font-medium">{file.name}</span>
                  <span className="text-xs text-emerald-600">({(file.size / 1024).toFixed(0)} KB)</span>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-sm text-slate-600">
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

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2 text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
            <span>
              The previous revision will be archived (not deleted) and remain accessible in Version History.
              A SHA-256 hash of the new file is recorded for audit integrity.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
          <div className="text-[11px] text-slate-500">
            Going from <b>Rev {doc.rev || "—"}</b> → <b className="text-orange-600">Rev {revisionLabel || "?"}</b>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || !file}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-orange-600 hover:bg-orange-500 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
              {submitting ? "Publishing…" : "Publish Revision"}
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
      <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest inline-flex items-center gap-1">
        {label}
        {isoTopic && <IsoGuidance topic={isoTopic} />}
      </label>
      {hint && <div className="text-[10px] text-slate-500 mt-0.5">{hint}</div>}
      <div className="mt-1">{children}</div>
    </div>
  );
}
