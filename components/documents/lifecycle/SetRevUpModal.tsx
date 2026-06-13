"use client";

// SetRevUpModal — batch rev-up of every active sheet in a set.
// Shared change_log + MOC + issue/change type across all sheets.
// Each sheet gets a file picker and a per-sheet new-rev-label
// (defaults to a sensible suggestion from the current rev).

import React, { useCallback, useEffect, useState } from "react";
import { X, Repeat2, Loader2, AlertTriangle, Check, Upload, FileText } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { setLevelRevUp } from "@/lib/documentLifecycle";
import { suggestNextRevisionLabel } from "@/lib/revisions";
import { docRowToDocumentRecord } from "@/lib/documentRows";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";

interface SetRevUpModalProps {
  setId: string;
  libraryId: string;
  folderPath?: string[];
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onCancel: () => void;
  onSuccess: () => void;
}

interface SheetDraft {
  doc: DocumentRecord;
  file: File | null;
  newRevLabel: string;
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

export default function SetRevUpModal(props: SetRevUpModalProps) {
  const { setId, libraryId, folderPath, orgId, actorUserId, actorEmail, actorRole, onCancel, onSuccess } = props;
  const [sheets, setSheets] = useState<SheetDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Shared metadata
  const [sharedChangeLog, setSharedChangeLog] = useState("");
  const [sharedMoc, setSharedMoc] = useState("");
  const [issueType, setIssueType] = useState<DocumentVersion["issueType"]>("Issued for Construction");
  const [changeType, setChangeType] = useState<DocumentVersion["changeType"]>("Major");

  // Per-run result
  const [result, setResult] = useState<{ succeeded: number; failed: Array<{ documentNumber: string | null; error: string }> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from("documents")
        .select("*")
        .eq("org_id", orgId)
        .eq("set_id", setId)
        .neq("status", "Archived")
        .neq("status", "Superseded")
        .order("sheet_number", { ascending: true })
        .order("document_number", { ascending: true });
      if (err) throw new Error(err.message);
      const recs = ((data as Array<Record<string, unknown>>) ?? []).map(docRowToDocumentRecord);
      setSheets(recs.map((doc) => ({ doc, file: null, newRevLabel: suggestNextRevisionLabel(doc.rev) })));
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, [setId, orgId]);

  useEffect(() => { void load(); }, [load]);

  const updateSheet = (i: number, patch: Partial<SheetDraft>) => {
    setSheets((arr) => arr.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };

  const valid =
    sharedChangeLog.trim().length > 0 &&
    sheets.length > 0 &&
    sheets.every((s) => s.file && s.newRevLabel.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await setLevelRevUp({
        setId,
        sheets: sheets.map((s) => ({ doc: s.doc, file: s.file!, revisionLabel: s.newRevLabel.trim() })),
        libraryId, folderPath,
        sharedChangeLog,
        sharedMocReference: sharedMoc || undefined,
        issueType, changeType,
        orgId, actorUserId, actorEmail, actorRole,
      });
      setResult({ succeeded: r.succeeded, failed: r.failed });
      if (r.failed.length === 0) {
        onSuccess();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-3xl bg-[var(--color-surface)] rounded-2xl shadow-2xl overflow-hidden my-8 animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between bg-[var(--color-surface-2)]">
          <div className="flex items-center gap-2">
            <Repeat2 className="w-5 h-5 text-emerald-600" />
            <div>
              <h2 className="font-black text-[var(--color-text)]">Bump Set Revision</h2>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">Every active sheet in this set, in one operation.</div>
            </div>
          </div>
          <button onClick={onCancel} className="p-1.5 rounded hover:bg-slate-200 text-[var(--color-text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Shared metadata */}
          <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg p-3 space-y-2">
            <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Shared across all sheets</div>
            <div className="grid grid-cols-2 gap-2">
              <select value={issueType ?? ""} onChange={(e) => setIssueType(e.target.value as DocumentVersion["issueType"])} className="text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5 bg-[var(--color-surface)]">
                {ISSUE_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select value={changeType ?? ""} onChange={(e) => setChangeType(e.target.value as DocumentVersion["changeType"])} className="text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5 bg-[var(--color-surface)]">
                {CHANGE_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <input value={sharedMoc} onChange={(e) => setSharedMoc(e.target.value)} placeholder="MOC reference" className="w-full text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5 font-mono" />
            <textarea
              value={sharedChangeLog}
              onChange={(e) => setSharedChangeLog(e.target.value)}
              rows={2}
              placeholder='Shared change narrative (required) — applied to every sheet in this set.'
              className="w-full text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5"
            />
          </div>

          {/* Sheets */}
          <div>
            <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-1">Sheets ({sheets.length})</div>
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] py-4 justify-center">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading sheets…
              </div>
            ) : sheets.length === 0 ? (
              <div className="text-xs text-[var(--color-text-muted)] italic py-6 text-center border border-dashed border-[var(--color-border)] rounded">
                No active sheets in this set.
              </div>
            ) : (
              <div className="border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)] max-h-96 overflow-y-auto">
                {sheets.map((s, i) => (
                  <div key={s.doc.id} className="px-3 py-2 grid grid-cols-12 gap-2 items-center text-xs">
                    <div className="col-span-3 min-w-0">
                      <div className="font-mono font-bold text-[var(--color-text)] truncate">{s.doc.documentNumber || "—"}</div>
                      <div className="text-[10px] text-[var(--color-text-muted)] truncate">{s.doc.title || s.doc.name}</div>
                    </div>
                    <div className="col-span-2 font-mono text-[var(--color-text-muted)]">Rev {s.doc.rev || "—"}</div>
                    <div className="col-span-2">
                      <input value={s.newRevLabel} onChange={(e) => updateSheet(i, { newRevLabel: e.target.value })}
                        className="w-full text-xs border border-[var(--color-border-strong)] rounded px-1.5 py-1 font-mono"
                        placeholder="New rev" />
                    </div>
                    <div className="col-span-5">
                      <label className="block border border-dashed border-[var(--color-border-strong)] rounded p-1 cursor-pointer hover:border-emerald-400 hover:bg-emerald-50/30 text-center text-[11px]">
                        <input type="file" accept="application/pdf" className="hidden" onChange={(e) => updateSheet(i, { file: e.target.files?.[0] ?? null })} />
                        {s.file ? (
                          <span className="inline-flex items-center gap-1 text-[var(--color-text)]">
                            <FileText className="w-3 h-3 text-blue-600" /> <span className="font-mono truncate">{s.file.name}</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]">
                            <Upload className="w-3 h-3" /> Upload PDF
                          </span>
                        )}
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {result && (
            <div className="text-xs space-y-1">
              <div className="text-emerald-700">Succeeded: <b>{result.succeeded}</b></div>
              {result.failed.length > 0 && (
                <div className="text-red-700">
                  Failed: <b>{result.failed.length}</b>
                  <ul className="list-disc ml-5">
                    {result.failed.map((f, i) => <li key={i}>{f.documentNumber}: {f.error}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5">Cancel</button>
          <button onClick={submit} disabled={!valid || busy || loading} className="inline-flex items-center gap-1.5 text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded disabled:opacity-40">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Bump All
          </button>
        </div>
      </div>
    </div>
  );
}
