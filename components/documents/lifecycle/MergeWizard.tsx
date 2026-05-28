"use client";

// MergeWizard — N source documents → 1 target.
//
// Steps:
//   1. Pick additional source documents (one is already in context).
//   2. Target — create new or extend existing.
//   3. Asset tag union + reason + carry-over toggles.

import React, { useEffect, useMemo, useState } from "react";
import {
  X, Merge, Plus, Trash2, ArrowRight, AlertTriangle,
  Loader2, Check, Upload, FileText, ChevronLeft, Search,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { mergeDocuments, type MergeTargetSpec } from "@/lib/documentLifecycle";
import type { DocumentRecord, AssetTag } from "@/types/schema";
import { docRowToDocumentRecord } from "@/lib/documentRows";
import FirstRunHint from "@/components/ui/FirstRunHint";
import DuplicateAwareInput from "@/components/ui/DuplicateAwareInput";
import { translatePostgresError } from "@/lib/inputValidation";

interface MergeWizardProps {
  sourceDoc: DocumentRecord;
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

function tagKey(t: AssetTag): string {
  return `${(t.type || "Equipment").toLowerCase()}::${t.tag.toLowerCase()}`;
}

export default function MergeWizard(props: MergeWizardProps) {
  const { sourceDoc, libraryId, folderPath, orgId, actorUserId, actorUserName, actorEmail, actorRole, onCancel, onSuccess } = props;

  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1: sources (sourceDoc is always included; user adds more)
  const [otherSources, setOtherSources] = useState<DocumentRecord[]>([]);

  // Step 2: target mode
  const [targetMode, setTargetMode] = useState<"create_new" | "extend_existing">("create_new");
  // create_new fields
  const [newDocNumber, setNewDocNumber] = useState(sourceDoc.documentNumber || "");
  const [newDocNumberConflict, setNewDocNumberConflict] = useState(false);
  const [newTitle, setNewTitle] = useState(sourceDoc.title || "");
  const [newRev, setNewRev] = useState("0");
  const [newSheetNumber, setNewSheetNumber] = useState("");
  const [newFile, setNewFile] = useState<File | null>(null);
  const [newChangeLog, setNewChangeLog] = useState("");
  // extend_existing fields
  const [extendTarget, setExtendTarget] = useState<DocumentRecord | null>(sourceDoc);
  const [extendRevUp, setExtendRevUp] = useState(true);
  const [extendRevLabel, setExtendRevLabel] = useState("");
  const [extendFile, setExtendFile] = useState<File | null>(null);
  const [extendChangeLog, setExtendChangeLog] = useState("");

  // Step 3: tag union + reason
  const allSources = useMemo(() => [sourceDoc, ...otherSources], [sourceDoc, otherSources]);
  const tagUnion = useMemo<AssetTag[]>(() => {
    const seen = new Map<string, AssetTag>();
    for (const s of allSources) {
      for (const t of (s.assetTags ?? [])) {
        const k = tagKey(t);
        if (!seen.has(k)) seen.set(k, t);
      }
    }
    return Array.from(seen.values());
  }, [allSources]);
  const [excludedTagKeys, setExcludedTagKeys] = useState<Set<string>>(new Set());

  const [reason, setReason] = useState("");
  const [mocReference, setMocReference] = useState("");
  const [copyHolds, setCopyHolds] = useState(true);
  const [copyProjects, setCopyProjects] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const step1Valid = otherSources.length >= 1;
  const step2Valid = targetMode === "create_new"
    ? !!(newDocNumber.trim() && newTitle.trim() && newRev.trim() && newFile && !newDocNumberConflict)
    : !!(extendTarget?.id && (!extendRevUp || (extendRevLabel.trim() && extendFile)));
  const step3Valid = reason.trim().length > 0;

  const onSubmit = async () => {
    if (!step1Valid || !step2Valid || !step3Valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const finalTags = tagUnion.filter((t) => !excludedTagKeys.has(tagKey(t)));
      const target: MergeTargetSpec = targetMode === "create_new"
        ? {
            kind: "create_new",
            libraryId, folderPath,
            documentNumber: newDocNumber,
            title: newTitle,
            sheetNumber: newSheetNumber.trim() ? Number(newSheetNumber) : null,
            initialRevLabel: newRev,
            changeLog: newChangeLog,
            file: newFile!,
            assetTags: finalTags,
          }
        : {
            kind: "extend_existing",
            target: extendTarget!,
            libraryId, folderPath,
            assetTagsUnion: finalTags,
            revUp: extendRevUp ? {
              file: extendFile!,
              revisionLabel: extendRevLabel,
              changeLog: extendChangeLog || `Merge target — absorbed ${otherSources.length + 1} sheets`,
            } : undefined,
          };

      await mergeDocuments({
        sources: allSources, target,
        reason, mocReference: mocReference || undefined,
        copyHolds, copyProjectMembership: copyProjects,
        orgId, actorUserId, actorUserName, actorEmail, actorRole,
      });
      onSuccess();
    } catch (e) {
      const f = translatePostgresError(e, { entity: "document", field: "document_number" });
      setError(`${f.heading} — ${f.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl overflow-hidden my-8">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <Merge className="w-5 h-5 text-amber-600" />
            <div>
              <h2 className="font-black text-slate-900">Merge Documents</h2>
              <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                Starting from: {sourceDoc.documentNumber || sourceDoc.title}
              </div>
            </div>
          </div>
          <button onClick={onCancel} className="p-1.5 rounded hover:bg-slate-200 text-slate-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="px-5 py-2 border-b border-slate-200 flex items-center gap-3 text-[11px]">
          <StepLabel n={1} active={step === 1} done={step > 1} label="Pick sources" />
          <ArrowRight className="w-3 h-3 text-slate-300" />
          <StepLabel n={2} active={step === 2} done={step > 2} label="Target" />
          <ArrowRight className="w-3 h-3 text-slate-300" />
          <StepLabel n={3} active={step === 3} done={false} label="Tags & confirm" />
        </div>

        <div className="p-5 space-y-4 min-h-[200px]">
          <FirstRunHint storageKey="lifecycle.merge.intro" tone="info">
            A merge takes two or more sheets and retires them all into one combined document.
            <b className="block mt-1">You can reverse this later</b> from the Timeline tab — the source sheets come back, and a newly-created target gets parked under Superseded.
          </FirstRunHint>
          {step === 1 && (
            <Step1Sources
              orgId={orgId}
              libraryId={libraryId}
              sourceDoc={sourceDoc}
              others={otherSources}
              setOthers={setOtherSources}
            />
          )}
          {step === 2 && (
            <Step2Target
              libraryId={libraryId}
              mode={targetMode} setMode={setTargetMode}
              newDocNumber={newDocNumber} setNewDocNumber={setNewDocNumber}
              setNewDocNumberConflict={setNewDocNumberConflict}
              newTitle={newTitle} setNewTitle={setNewTitle}
              newRev={newRev} setNewRev={setNewRev}
              newSheetNumber={newSheetNumber} setNewSheetNumber={setNewSheetNumber}
              newFile={newFile} setNewFile={setNewFile}
              newChangeLog={newChangeLog} setNewChangeLog={setNewChangeLog}
              extendTarget={extendTarget} setExtendTarget={setExtendTarget}
              sources={allSources}
              extendRevUp={extendRevUp} setExtendRevUp={setExtendRevUp}
              extendRevLabel={extendRevLabel} setExtendRevLabel={setExtendRevLabel}
              extendFile={extendFile} setExtendFile={setExtendFile}
              extendChangeLog={extendChangeLog} setExtendChangeLog={setExtendChangeLog}
            />
          )}
          {step === 3 && (
            <Step3TagsAndConfirm
              sources={allSources}
              tagUnion={tagUnion}
              excludedTagKeys={excludedTagKeys}
              setExcludedTagKeys={setExcludedTagKeys}
              targetMode={targetMode}
              targetLabel={targetMode === "create_new" ? `${newDocNumber} (new)` : `${extendTarget?.documentNumber} (extended)`}
              reason={reason} setReason={setReason}
              moc={mocReference} setMoc={setMocReference}
              copyHolds={copyHolds} setCopyHolds={setCopyHolds}
              copyProjects={copyProjects} setCopyProjects={setCopyProjects}
            />
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          <button
            onClick={step === 1 ? onCancel : () => setStep((s) => (s - 1) as 1 | 2 | 3)}
            disabled={submitting}
            className="text-sm text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> {step === 1 ? "Cancel" : "Back"}
          </button>
          {step < 3 ? (
            <button
              onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
              disabled={step === 1 ? !step1Valid : !step2Valid}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded disabled:opacity-40"
            >
              Next <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={onSubmit}
              disabled={submitting || !step3Valid}
              className="inline-flex items-center gap-1.5 text-sm font-bold bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded disabled:opacity-40"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Confirm Merge
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Step 1: source picker ──────────────────────────────────────

function Step1Sources({
  orgId, libraryId, sourceDoc, others, setOthers,
}: {
  orgId: string; libraryId: string; sourceDoc: DocumentRecord;
  others: DocumentRecord[]; setOthers: (v: DocumentRecord[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    // All state mutations happen inside the timeout callback so the
    // effect body itself contains no synchronous setState calls.
    const handle = window.setTimeout(async () => {
      if (!alive) return;
      const trimmed = query.trim();
      if (trimmed.length < 2) {
        setResults([]); setLoading(false);
        return;
      }
      setLoading(true);
      const { data } = await supabase
        .from("documents")
        .select("*")
        .eq("org_id", orgId)
        .eq("library_id", libraryId)
        .neq("id", sourceDoc.id)
        .or(`document_number.ilike.%${trimmed}%,title.ilike.%${trimmed}%`)
        .limit(15);
      if (!alive) return;
      const recs = (data as Array<Record<string, unknown>> || []).map(docRowToDocumentRecord);
      const otherIds = new Set(others.map((o) => o.id));
      setResults(recs.filter((d) => !otherIds.has(d.id)));
      setLoading(false);
    }, 200);
    return () => { alive = false; window.clearTimeout(handle); };
  }, [query, orgId, libraryId, sourceDoc.id, others]);

  const add = (d: DocumentRecord) => { setOthers([...others, d]); setQuery(""); };
  const remove = (id: string) => setOthers(others.filter((o) => o.id !== id));

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-slate-600">
        Add the other documents being merged into one. The current sheet is always a source.
        At least 1 additional source is required to merge.
      </div>

      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
        <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Sources ({others.length + 1})</div>
        <SourceChip doc={sourceDoc} primary />
        {others.map((d) => (
          <SourceChip key={d.id} doc={d} onRemove={() => remove(d.id!)} />
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search other documents in this library by number or title…"
          className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-300 rounded"
        />
      </div>

      {loading && <div className="text-xs text-slate-500 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Searching…</div>}

      {results.length > 0 && (
        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-60 overflow-y-auto">
          {results.map((d) => (
            <button
              key={d.id}
              onClick={() => add(d)}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-mono font-bold text-slate-800">{d.documentNumber || "—"}</div>
                <div className="text-[11px] text-slate-500 truncate">{d.title || d.name || "(untitled)"}</div>
              </div>
              <Plus className="w-3.5 h-3.5 text-slate-400" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SourceChip({ doc, primary, onRemove }: { doc: DocumentRecord; primary?: boolean; onRemove?: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs bg-white border border-slate-200 rounded px-2 py-1.5">
      <span className={`text-[9px] font-bold uppercase tracking-widest px-1 py-0.5 rounded ${primary ? "bg-amber-100 text-amber-800 border border-amber-200" : "bg-slate-100 text-slate-600 border border-slate-200"}`}>
        {primary ? "Primary" : "Source"}
      </span>
      <span className="font-mono font-bold text-slate-800">{doc.documentNumber || "—"}</span>
      <span className="text-slate-500 truncate flex-1">{doc.title || doc.name}</span>
      {onRemove && (
        <button onClick={onRemove} className="p-1 text-slate-400 hover:text-red-600">
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ─── Step 2: target ─────────────────────────────────────────────

function Step2Target(props: {
  libraryId: string;
  mode: "create_new" | "extend_existing"; setMode: (v: "create_new" | "extend_existing") => void;
  newDocNumber: string; setNewDocNumber: (v: string) => void;
  setNewDocNumberConflict: (v: boolean) => void;
  newTitle: string; setNewTitle: (v: string) => void;
  newRev: string; setNewRev: (v: string) => void;
  newSheetNumber: string; setNewSheetNumber: (v: string) => void;
  newFile: File | null; setNewFile: (v: File | null) => void;
  newChangeLog: string; setNewChangeLog: (v: string) => void;
  extendTarget: DocumentRecord | null; setExtendTarget: (v: DocumentRecord | null) => void;
  sources: DocumentRecord[];
  extendRevUp: boolean; setExtendRevUp: (v: boolean) => void;
  extendRevLabel: string; setExtendRevLabel: (v: string) => void;
  extendFile: File | null; setExtendFile: (v: File | null) => void;
  extendChangeLog: string; setExtendChangeLog: (v: string) => void;
}) {
  const { mode, setMode } = props;
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <ModeButton active={mode === "create_new"} onClick={() => setMode("create_new")} label="Create new combined sheet" sub="Source sheets all retired into a brand-new document." />
        <ModeButton active={mode === "extend_existing"} onClick={() => setMode("extend_existing")} label="Extend an existing source" sub="Pick one source to keep; absorb the others into it." />
      </div>

      {mode === "create_new" && (
        <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/40 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <DuplicateAwareInput
              value={props.newDocNumber}
              onChange={props.setNewDocNumber}
              onDuplicateChange={(isDup) => props.setNewDocNumberConflict(isDup)}
              check={{ table: "documents", column: "document_number", scope: { library_id: props.libraryId } }}
              fieldLabel="document number"
              placeholder="Document number"
              className="font-mono"
            />
            <input value={props.newTitle} onChange={(e) => props.setNewTitle(e.target.value)} placeholder="Title" className="text-xs border border-slate-300 rounded px-2 py-1.5" />
            <input value={props.newRev} onChange={(e) => props.setNewRev(e.target.value)} placeholder="Initial rev" className="text-xs border border-slate-300 rounded px-2 py-1.5 font-mono" />
            <input value={props.newSheetNumber} onChange={(e) => props.setNewSheetNumber(e.target.value)} placeholder="Sheet # (optional)" className="text-xs border border-slate-300 rounded px-2 py-1.5 font-mono" />
          </div>
          <label className="block border-2 border-dashed border-slate-300 rounded p-2 cursor-pointer hover:border-amber-400 hover:bg-amber-50/30 text-center">
            <input type="file" accept="application/pdf" className="hidden" onChange={(e) => props.setNewFile(e.target.files?.[0] ?? null)} />
            {props.newFile ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-700">
                <FileText className="w-3.5 h-3.5 text-blue-600" /> <span className="font-mono">{props.newFile.name}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                <Upload className="w-3.5 h-3.5" /> Upload the combined PDF
              </span>
            )}
          </label>
          <input value={props.newChangeLog} onChange={(e) => props.setNewChangeLog(e.target.value)} placeholder="Initial change note" className="w-full text-xs border border-slate-300 rounded px-2 py-1.5" />
        </div>
      )}

      {mode === "extend_existing" && (
        <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/40 space-y-2">
          <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Pick the source to keep</div>
          <div className="space-y-1">
            {props.sources.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="extend_target"
                  checked={props.extendTarget?.id === s.id}
                  onChange={() => props.setExtendTarget(s)}
                />
                <span className="font-mono font-bold text-slate-800">{s.documentNumber || "—"}</span>
                <span className="text-slate-600 truncate flex-1">{s.title || s.name}</span>
              </label>
            ))}
          </div>

          <label className="flex items-center gap-2 text-xs pt-2 border-t border-slate-200">
            <input type="checkbox" checked={props.extendRevUp} onChange={(e) => props.setExtendRevUp(e.target.checked)} />
            <span>Also push a new revision on the target with the merged PDF</span>
          </label>

          {props.extendRevUp && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <input value={props.extendRevLabel} onChange={(e) => props.setExtendRevLabel(e.target.value)} placeholder="New rev label" className="text-xs border border-slate-300 rounded px-2 py-1.5 font-mono" />
              </div>
              <label className="block border-2 border-dashed border-slate-300 rounded p-2 cursor-pointer hover:border-amber-400 hover:bg-amber-50/30 text-center">
                <input type="file" accept="application/pdf" className="hidden" onChange={(e) => props.setExtendFile(e.target.files?.[0] ?? null)} />
                {props.extendFile ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-700">
                    <FileText className="w-3.5 h-3.5 text-blue-600" /> <span className="font-mono">{props.extendFile.name}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                    <Upload className="w-3.5 h-3.5" /> Upload merged PDF
                  </span>
                )}
              </label>
              <input value={props.extendChangeLog} onChange={(e) => props.setExtendChangeLog(e.target.value)} placeholder="Rev change narrative" className="w-full text-xs border border-slate-300 rounded px-2 py-1.5" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ModeButton({ active, onClick, label, sub }: { active: boolean; onClick: () => void; label: string; sub: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 text-left p-3 border-2 rounded-lg ${active ? "border-amber-500 bg-amber-50" : "border-slate-200 bg-white hover:border-slate-300"}`}
    >
      <div className="text-sm font-bold text-slate-900">{label}</div>
      <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>
    </button>
  );
}

// ─── Step 3: tags + confirm ────────────────────────────────────

function Step3TagsAndConfirm(props: {
  sources: DocumentRecord[];
  tagUnion: AssetTag[];
  excludedTagKeys: Set<string>;
  setExcludedTagKeys: (v: Set<string>) => void;
  targetMode: "create_new" | "extend_existing";
  targetLabel: string;
  reason: string; setReason: (v: string) => void;
  moc: string; setMoc: (v: string) => void;
  copyHolds: boolean; setCopyHolds: (v: boolean) => void;
  copyProjects: boolean; setCopyProjects: (v: boolean) => void;
}) {
  const toggle = (key: string) => {
    const next = new Set(props.excludedTagKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    props.setExcludedTagKeys(next);
  };

  return (
    <div className="space-y-4">
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
        <div className="font-bold text-slate-800 mb-2">What will happen</div>
        <ul className="list-disc ml-5 space-y-1 text-slate-700">
          {props.sources.map((s) => (
            <li key={s.id}>
              <span className="font-mono">{s.documentNumber || s.title}</span> →{" "}
              <span className="text-amber-700 font-bold">Superseded</span>
              {props.targetMode === "extend_existing" && props.sources[0]?.id === s.id && " (will be kept and extended)"}
            </li>
          ))}
          <li>Merged target: <b>{props.targetLabel}</b></li>
          <li className="text-slate-500">{props.tagUnion.length - props.excludedTagKeys.size} asset tags will be attached to the target</li>
        </ul>
      </div>

      {props.tagUnion.length > 0 && (
        <div>
          <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest mb-1">Asset tag union — uncheck to exclude</div>
          <div className="border border-slate-200 rounded-lg p-2 max-h-48 overflow-y-auto grid grid-cols-2 md:grid-cols-3 gap-1">
            {props.tagUnion.map((t) => {
              const k = tagKey(t);
              const excluded = props.excludedTagKeys.has(k);
              return (
                <label key={k} className={`flex items-center gap-1.5 text-[11px] px-1.5 py-1 rounded cursor-pointer ${excluded ? "opacity-50" : ""}`}>
                  <input type="checkbox" checked={!excluded} onChange={() => toggle(k)} />
                  <span className="font-mono font-bold">{t.tag}</span>
                  {t.type && <span className="text-slate-500">({t.type})</span>}
                </label>
              );
            })}
          </div>
        </div>
      )}

      <label className="block">
        <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Reason for merge *</span>
        <textarea
          value={props.reason}
          onChange={(e) => props.setReason(e.target.value)}
          rows={2}
          placeholder='e.g. "Consolidated overhead sheets 3 and 4 — equipment count after relief redesign no longer justifies two sheets."'
          className="mt-1 w-full text-sm border border-slate-300 rounded px-2.5 py-1.5"
        />
      </label>
      <label className="block">
        <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">MOC Reference</span>
        <input value={props.moc} onChange={(e) => props.setMoc(e.target.value)} className="mt-1 w-full text-sm border border-slate-300 rounded px-2.5 py-1.5 font-mono" />
      </label>

      <div className="border border-slate-200 rounded-lg p-3 bg-white">
        <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest mb-2">Carry over from sources</div>
        <div className="space-y-1.5 text-xs">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={props.copyHolds} onChange={(e) => props.setCopyHolds(e.target.checked)} />
            <span className="text-slate-700">Active holds (with origin notes)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={props.copyProjects} onChange={(e) => props.setCopyProjects(e.target.checked)} />
            <span className="text-slate-700">Project memberships</span>
          </label>
        </div>
      </div>
    </div>
  );
}

function StepLabel({ n, active, done, label }: { n: number; active: boolean; done: boolean; label: string }) {
  return (
    <div className={`inline-flex items-center gap-1.5 ${active ? "text-amber-700 font-bold" : done ? "text-emerald-700" : "text-slate-400"}`}>
      <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-black ${
        active ? "bg-amber-600 text-white" : done ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-500"
      }`}>{done ? "✓" : n}</span>
      {label}
    </div>
  );
}
