"use client";

// SplitWizard — one source document → N new documents.
//
// Three steps:
//   1. Define targets (count + per-target rows with number, title,
//      rev label, sheet number, PDF file).
//   2. Distribute asset tags across the targets (checkboxes, tag ×
//      target grid). Source's existing tags are the pool.
//   3. Reason, MOC, carry-over toggles. Preview + confirm.
//
// Calls lib/documentLifecycle.ts:splitDocument which handles the
// side effects (asset_tags, holds, project_documents, scope FKs,
// audit, supersession links).

import React, { useMemo, useState } from "react";
import {
  X, Split as SplitIcon, Plus, Trash2, ArrowRight, AlertTriangle,
  Loader2, Check, Upload, FileText, ChevronLeft,
} from "lucide-react";
import { splitDocument, type SplitTargetSpec } from "@/lib/documentLifecycle";
import type { DocumentRecord, AssetTag } from "@/types/schema";

interface SplitWizardProps {
  doc: DocumentRecord;
  libraryId: string;
  folderPath?: string[];
  orgId: string;
  actorUserId: string;
  actorUserName?: string;
  actorEmail?: string;
  actorRole?: string;
  onCancel: () => void;
  onSuccess: () => void;
}

interface DraftTarget {
  documentNumber: string;
  title: string;
  sheetNumber: string;       // string in state, parsed on submit
  initialRevLabel: string;
  changeLog: string;
  file: File | null;
  assetTagKeys: Set<string>; // which source tags are routed here
}

function tagKey(t: AssetTag): string {
  return `${(t.type || "Equipment").toLowerCase()}::${t.tag.toLowerCase()}`;
}

export default function SplitWizard(props: SplitWizardProps) {
  const { doc, libraryId, folderPath, orgId, actorUserId, actorUserName, actorEmail, actorRole, onCancel, onSuccess } = props;
  const sourceTags = useMemo<AssetTag[]>(() => Array.isArray(doc.assetTags) ? doc.assetTags : [], [doc.assetTags]);

  // Step state
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Targets
  const [targets, setTargets] = useState<DraftTarget[]>([
    makeDraft(doc, "A"), makeDraft(doc, "B"),
  ]);

  // Step 3 fields
  const [reason, setReason] = useState("");
  const [mocReference, setMocReference] = useState("");
  const [copyHolds, setCopyHolds] = useState(true);
  const [copyProjects, setCopyProjects] = useState(true);
  const [copyScope, setCopyScope] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTarget = () => setTargets((ts) => [...ts, makeDraft(doc, suffixFor(ts.length))]);
  const removeTarget = (i: number) => setTargets((ts) => ts.filter((_, j) => j !== i));
  const updateTarget = (i: number, patch: Partial<DraftTarget>) =>
    setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  const toggleTagOnTarget = (i: number, key: string) => {
    setTargets((ts) => ts.map((t, j) => {
      if (j !== i) return t;
      const next = new Set(t.assetTagKeys);
      next.has(key) ? next.delete(key) : next.add(key);
      return { ...t, assetTagKeys: next };
    }));
  };

  const step1Valid = targets.length >= 2 && targets.every((t) =>
    t.documentNumber.trim() && t.title.trim() && t.initialRevLabel.trim() && t.file
  );
  const step3Valid = reason.trim().length > 0;

  const onSubmit = async () => {
    if (!step3Valid || !step1Valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const targetSpecs: SplitTargetSpec[] = targets.map((t) => ({
        documentNumber: t.documentNumber,
        title: t.title,
        sheetNumber: t.sheetNumber.trim() ? Number(t.sheetNumber) : null,
        initialRevLabel: t.initialRevLabel,
        changeLog: t.changeLog.trim() || `Created via split of ${doc.documentNumber ?? doc.id}`,
        assetTags: sourceTags.filter((tag) => t.assetTagKeys.has(tagKey(tag))),
        file: t.file!,
      }));

      await splitDocument({
        source: doc, libraryId, folderPath,
        targets: targetSpecs,
        reason, mocReference: mocReference || undefined,
        copyHolds, copyProjectMembership: copyProjects, copyScope,
        orgId, actorUserId, actorUserName, actorEmail, actorRole,
      });
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
      <form
        onSubmit={(e) => { e.preventDefault(); }}
        className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl overflow-hidden my-8"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <SplitIcon className="w-5 h-5 text-amber-600" />
            <div>
              <h2 className="font-black text-slate-900">Split Document</h2>
              <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                Source: {doc.documentNumber || doc.title || doc.id} · Rev {doc.rev || "—"}
              </div>
            </div>
          </div>
          <button type="button" onClick={onCancel} className="p-1.5 rounded hover:bg-slate-200 text-slate-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step indicator */}
        <Stepper step={step} />

        {/* Body */}
        <div className="p-5 space-y-4 min-h-[200px]">
          {step === 1 && (
            <Step1Targets
              doc={doc}
              targets={targets}
              onAdd={addTarget}
              onRemove={removeTarget}
              onUpdate={updateTarget}
            />
          )}
          {step === 2 && (
            <Step2Tags
              sourceTags={sourceTags}
              targets={targets}
              onToggle={toggleTagOnTarget}
            />
          )}
          {step === 3 && (
            <Step3Confirm
              doc={doc}
              targets={targets}
              sourceTagsCount={sourceTags.length}
              reason={reason} setReason={setReason}
              moc={mocReference} setMoc={setMocReference}
              copyHolds={copyHolds} setCopyHolds={setCopyHolds}
              copyProjects={copyProjects} setCopyProjects={setCopyProjects}
              copyScope={copyScope} setCopyScope={setCopyScope}
            />
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          <button
            type="button"
            onClick={step === 1 ? onCancel : () => setStep((s) => (s - 1) as 1 | 2 | 3)}
            disabled={submitting}
            className="text-sm text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> {step === 1 ? "Cancel" : "Back"}
          </button>
          {step < 3 ? (
            <button
              type="button"
              onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
              disabled={step === 1 ? !step1Valid : false}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded disabled:opacity-40"
            >
              Next <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSubmit}
              disabled={submitting || !step3Valid}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded disabled:opacity-40"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Confirm Split
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

// ─── Step 1 ─────────────────────────────────────────────────────

function Step1Targets({
  doc, targets, onAdd, onRemove, onUpdate,
}: {
  doc: DocumentRecord;
  targets: DraftTarget[];
  onAdd: () => void;
  onRemove: (i: number) => void;
  onUpdate: (i: number, patch: Partial<DraftTarget>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] text-slate-600">
        Define the new documents that will replace <b>{doc.documentNumber || doc.title}</b>.
        At least 2 are required. Each target needs a document number, title, initial rev label, and a PDF file.
      </div>

      <div className="space-y-2">
        {targets.map((t, i) => (
          <div key={i} className="border border-slate-200 rounded-lg p-3 bg-slate-50/40">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Target {i + 1}</div>
              {targets.length > 2 && (
                <button onClick={() => onRemove(i)} className="text-[11px] text-red-600 hover:text-red-800 inline-flex items-center gap-1">
                  <Trash2 className="w-3 h-3" /> Remove
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <input
                value={t.documentNumber}
                onChange={(e) => onUpdate(i, { documentNumber: e.target.value })}
                placeholder="Document number"
                className="text-xs border border-slate-300 rounded px-2 py-1.5 font-mono"
              />
              <input
                value={t.title}
                onChange={(e) => onUpdate(i, { title: e.target.value })}
                placeholder="Title"
                className="text-xs border border-slate-300 rounded px-2 py-1.5"
              />
              <input
                value={t.initialRevLabel}
                onChange={(e) => onUpdate(i, { initialRevLabel: e.target.value })}
                placeholder="Initial rev (e.g. 0)"
                className="text-xs border border-slate-300 rounded px-2 py-1.5 font-mono"
              />
              <input
                value={t.sheetNumber}
                onChange={(e) => onUpdate(i, { sheetNumber: e.target.value })}
                placeholder="Sheet # (optional)"
                className="text-xs border border-slate-300 rounded px-2 py-1.5 font-mono"
              />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="flex-1 border-2 border-dashed border-slate-300 rounded p-2 cursor-pointer hover:border-amber-400 hover:bg-amber-50/30 text-center">
                <input
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={(e) => onUpdate(i, { file: e.target.files?.[0] ?? null })}
                />
                {t.file ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-700">
                    <FileText className="w-3.5 h-3.5 text-blue-600" />
                    <span className="font-mono">{t.file.name}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                    <Upload className="w-3.5 h-3.5" /> Upload PDF
                  </span>
                )}
              </label>
            </div>
            <input
              value={t.changeLog}
              onChange={(e) => onUpdate(i, { changeLog: e.target.value })}
              placeholder={`Initial change note (default: "Created via split of ${doc.documentNumber ?? "source"}")`}
              className="mt-2 w-full text-xs border border-slate-300 rounded px-2 py-1.5"
            />
          </div>
        ))}
      </div>

      <button onClick={onAdd} className="text-xs font-bold text-amber-700 hover:text-amber-800 inline-flex items-center gap-1">
        <Plus className="w-3 h-3" /> Add another target sheet
      </button>
    </div>
  );
}

// ─── Step 2 ─────────────────────────────────────────────────────

function Step2Tags({
  sourceTags, targets, onToggle,
}: {
  sourceTags: AssetTag[];
  targets: DraftTarget[];
  onToggle: (i: number, key: string) => void;
}) {
  if (sourceTags.length === 0) {
    return (
      <div className="text-xs text-slate-500 italic py-6 text-center border border-dashed border-slate-200 rounded-lg">
        Source has no asset tags. New documents will start with no tags — you can add them later.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-slate-600">
        Distribute the source&apos;s {sourceTags.length} asset tag{sourceTags.length === 1 ? "" : "s"} across the new sheets.
        A tag can appear on multiple targets — some equipment legitimately spans sheets.
      </div>

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <div className="grid bg-slate-50 border-b border-slate-200 text-[10px] font-black text-slate-700 uppercase tracking-widest"
             style={{ gridTemplateColumns: `minmax(120px, 1fr) repeat(${targets.length}, minmax(80px, 100px))` }}>
          <div className="px-3 py-2">Tag</div>
          {targets.map((t, i) => (
            <div key={i} className="px-2 py-2 text-center border-l border-slate-200 truncate" title={t.documentNumber}>
              {t.documentNumber || `Target ${i + 1}`}
            </div>
          ))}
        </div>
        <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
          {sourceTags.map((tag) => {
            const key = tagKey(tag);
            return (
              <div key={key} className="grid items-center"
                   style={{ gridTemplateColumns: `minmax(120px, 1fr) repeat(${targets.length}, minmax(80px, 100px))` }}>
                <div className="px-3 py-2 text-xs">
                  <span className="font-mono font-bold text-slate-800">{tag.tag}</span>
                  {tag.type && <span className="ml-2 text-[10px] text-slate-500">({tag.type})</span>}
                </div>
                {targets.map((t, i) => (
                  <div key={i} className="px-2 py-2 text-center border-l border-slate-100">
                    <input
                      type="checkbox"
                      checked={t.assetTagKeys.has(key)}
                      onChange={() => onToggle(i, key)}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Step 3 ─────────────────────────────────────────────────────

function Step3Confirm({
  doc, targets, sourceTagsCount,
  reason, setReason, moc, setMoc,
  copyHolds, setCopyHolds, copyProjects, setCopyProjects, copyScope, setCopyScope,
}: {
  doc: DocumentRecord;
  targets: DraftTarget[];
  sourceTagsCount: number;
  reason: string; setReason: (v: string) => void;
  moc: string; setMoc: (v: string) => void;
  copyHolds: boolean; setCopyHolds: (v: boolean) => void;
  copyProjects: boolean; setCopyProjects: (v: boolean) => void;
  copyScope: boolean; setCopyScope: (v: boolean) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Preview */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
        <div className="font-bold text-slate-800 mb-2">What will happen</div>
        <ul className="list-disc ml-5 space-y-1 text-slate-700">
          <li>
            <span className="font-mono">{doc.documentNumber || doc.title}</span> Rev {doc.rev || "—"} →{" "}
            <span className="text-amber-700 font-bold">Superseded</span>
          </li>
          {targets.map((t, i) => (
            <li key={i}>
              New: <span className="font-mono font-bold">{t.documentNumber}</span> ({t.title}) at Rev{" "}
              <span className="font-mono">{t.initialRevLabel}</span> — {t.assetTagKeys.size} tag
              {t.assetTagKeys.size === 1 ? "" : "s"}
            </li>
          ))}
          <li className="text-slate-500">
            Asset tags assigned: {targets.reduce((a, t) => a + t.assetTagKeys.size, 0)} of {sourceTagsCount} source tags
          </li>
        </ul>
      </div>

      {/* Reason */}
      <label className="block">
        <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Reason for split *</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder='e.g. "Sheet 3 became too cluttered; split into 3A (north side) and 3B (south side)."'
          className="mt-1 w-full text-sm border border-slate-300 rounded px-2.5 py-1.5"
        />
      </label>

      {/* MOC */}
      <label className="block">
        <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">MOC Reference</span>
        <input
          value={moc}
          onChange={(e) => setMoc(e.target.value)}
          className="mt-1 w-full text-sm border border-slate-300 rounded px-2.5 py-1.5 font-mono"
        />
      </label>

      {/* Carry-over */}
      <div className="border border-slate-200 rounded-lg p-3 bg-white">
        <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest mb-2">Carry over from source</div>
        <div className="space-y-1.5 text-xs">
          <CarryOver label="Active holds (with origin note)" checked={copyHolds} onChange={setCopyHolds} />
          <CarryOver label="Project memberships" checked={copyProjects} onChange={setCopyProjects} />
          <CarryOver label="Plant / Unit / System scope" checked={copyScope} onChange={setCopyScope} />
        </div>
      </div>
    </div>
  );
}

function CarryOver({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-slate-700">{label}</span>
    </label>
  );
}

function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const labels = ["Define targets", "Distribute tags", "Reason & confirm"];
  return (
    <div className="px-5 py-2 border-b border-slate-200 flex items-center gap-3 text-[11px]">
      {labels.map((l, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const active = step === n;
        const done = step > n;
        return (
          <React.Fragment key={n}>
            <div className={`inline-flex items-center gap-1.5 ${active ? "text-amber-700 font-bold" : done ? "text-emerald-700" : "text-slate-400"}`}>
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-black ${
                active ? "bg-amber-600 text-white" : done ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-500"
              }`}>{done ? "✓" : n}</span>
              {l}
            </div>
            {n < 3 && <ArrowRight className="w-3 h-3 text-slate-300" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function makeDraft(source: DocumentRecord, suffix: string): DraftTarget {
  const base = source.documentNumber || "DOC";
  return {
    documentNumber: `${base}-${suffix}`,
    title: `${source.title || "Sheet"} — Part ${suffix}`,
    sheetNumber: "",
    initialRevLabel: "0",
    changeLog: "",
    file: null,
    assetTagKeys: new Set(),
  };
}

function suffixFor(n: number): string {
  const letters = ["A","B","C","D","E","F","G","H","I","J","K","L"];
  return letters[n] ?? `T${n + 1}`;
}
