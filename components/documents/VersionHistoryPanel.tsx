"use client";

// VersionHistoryPanel — chronological audit-ready list of every revision
// of a single document. Newest first. Each row exposes the full engineering
// signoff, the change narrative, the MOC reference, the source CAD file,
// and a SHA-256 hash for tamper detection. Lets the user open a previous
// version in the viewer (always rendered as an uncontrolled copy since it
// is, by definition, no longer the current revision).

import React, { useCallback, useEffect, useState } from "react";
import {
  Clock, ShieldCheck, ShieldAlert, FileText, Eye, Download as DownloadIcon,
  Hash, Loader2, Layers, MessageSquare, User, CheckSquare, Stamp,
  Link as LinkIcon, History as HistoryIcon, RotateCcw,
} from "lucide-react";
import { listVersions } from "@/lib/revisions";
import { downloadDocumentPdf } from "@/lib/downloads";
import { supabase } from "@/lib/supabase";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";

interface VersionHistoryPanelProps {
  doc: DocumentRecord;
  currentUserId?: string;
  currentUserEmail?: string;
  onOpenVersion: (version: DocumentVersion) => void;
  /** Admin-only: opens the Revert confirm modal for the given old version. */
  onRevertVersion?: (version: DocumentVersion) => void;
  /** True when the caller is an Admin / DocCtrl who can revert. */
  canRevert?: boolean;
  refreshKey?: number;
}

export default function VersionHistoryPanel({
  doc, currentUserId, currentUserEmail, onOpenVersion,
  onRevertVersion, canRevert, refreshKey,
}: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!doc.id) return;
    setLoading(true);
    setError(null);
    try {
      const list = await listVersions(doc.id);
      setVersions(list);
    } catch (e) {
      setError((e as Error).message || "Could not load history");
    } finally {
      setLoading(false);
    }
  }, [doc.id]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  // For non-current versions we always force the uncontrolled stamp — even
  // if the user holds checkout on the document. The previous revisions are
  // never the authoritative drawing, so any copy of them must be marked.
  const handleDownload = async (v: DocumentVersion) => {
    if (!currentUserId || !v.id) return;
    setDownloadingId(v.id);
    try {
      // Resolve the storage path to a presigned URL before passing to downloadDocumentPdf
      let httpUrl = v.fileUrl;
      if (!httpUrl.startsWith("http") && !httpUrl.startsWith("blob:")) {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(
          `/api/storage/download-url?path=${encodeURIComponent(httpUrl)}&expiresIn=3600`,
          { headers: { authorization: `Bearer ${session?.access_token ?? ""}` } }
        );
        if (res.ok) httpUrl = (await res.json()).url;
      }
      // We pass a doc clone with checkedOutBy cleared, forcing the gate to
      // resolve "uncontrolled" regardless of the real checkout state.
      const docForDownload: DocumentRecord = { ...doc, checkedOutBy: undefined } as DocumentRecord;
      await downloadDocumentPdf({
        doc: docForDownload,
        versionId: v.id,
        fileUrl: httpUrl,
        userId: currentUserId,
        userEmail: currentUserEmail ?? null,
        userLabel: currentUserEmail ?? null,
      });
    } catch (e) {
      console.error(e);
      setError((e as Error).message || "Download failed");
    } finally {
      setDownloadingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500 px-3 py-4">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading history…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-red-600 px-3 py-3 bg-red-50 border border-red-200 rounded-lg">{error}</div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="text-xs text-slate-500 px-3 py-4 flex items-center gap-2">
        <HistoryIcon className="w-3.5 h-3.5" /> No revisions recorded yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest flex items-center gap-1.5">
          <Layers className="w-3 h-3" /> Version History
        </div>
        <div className="text-[10px] text-slate-500 font-mono">{versions.length} rev{versions.length === 1 ? "" : "s"}</div>
      </div>

      <div className="space-y-2">
        {versions.map((v) => {
          const isCurrent = v.id === doc.currentVersionId;
          return (
            <div
              key={v.id}
              className={`rounded-xl border p-3 ${
                isCurrent
                  ? "border-emerald-300 bg-emerald-50/40"
                  : "border-slate-200 bg-white"
              }`}
            >
              {/* Top row: rev label + status badges + actions */}
              <div className="flex items-start gap-3">
                <div className={`shrink-0 px-2 py-1 rounded-md font-black text-xs font-mono ${
                  isCurrent
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-200 text-slate-700"
                }`}>
                  Rev {v.revisionLabel || "—"}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isCurrent ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                        <ShieldCheck className="w-3 h-3" /> Current
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                        <ShieldAlert className="w-3 h-3" /> Superseded
                      </span>
                    )}
                    {v.issueType && (
                      <span className="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">{v.issueType}</span>
                    )}
                    {v.changeType && (
                      <span className="text-[10px] font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">{v.changeType}</span>
                    )}
                    {v.revertedFromVersionId && (
                      <span className="text-[10px] font-bold text-purple-700 bg-purple-50 border border-purple-200 px-1.5 py-0.5 rounded">Revert</span>
                    )}
                  </div>

                  <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-2">
                    <Clock className="w-3 h-3" />
                    {formatDate(v.createdAt)}
                    {v.createdByName && <> • by <b className="text-slate-700">{v.createdByName}</b></>}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => onOpenVersion(v)}
                    title="Open this revision in the viewer"
                    className="p-1.5 rounded-md text-slate-500 hover:text-orange-600 hover:bg-orange-50"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => void handleDownload(v)}
                    disabled={downloadingId === v.id || !currentUserId}
                    title="Download this revision (uncontrolled stamp)"
                    className="p-1.5 rounded-md text-slate-500 hover:text-orange-600 hover:bg-orange-50 disabled:opacity-40"
                  >
                    {downloadingId === v.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <DownloadIcon className="w-3.5 h-3.5" />}
                  </button>
                  {/* Revert button — superseded versions only, admin/DocCtrl only */}
                  {canRevert && !isCurrent && onRevertVersion && (
                    <button
                      onClick={() => onRevertVersion(v)}
                      title="Revert document to this revision"
                      className="p-1.5 rounded-md text-slate-500 hover:text-purple-700 hover:bg-purple-50"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Narrative */}
              {v.changeLog && (
                <div className="mt-2 pl-1 text-[11px] text-slate-700 flex items-start gap-1.5">
                  <MessageSquare className="w-3 h-3 mt-0.5 shrink-0 text-slate-400" />
                  <span className="whitespace-pre-wrap">{v.changeLog}</span>
                </div>
              )}

              {/* Signoff chain */}
              {(v.drawnByName || v.checkedByName || v.approvedByName) && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-1">
                  {v.drawnByName && <SignoffBit icon={<User className="w-3 h-3" />} label="Drawn" name={v.drawnByName} />}
                  {v.checkedByName && <SignoffBit icon={<CheckSquare className="w-3 h-3" />} label="Checked" name={v.checkedByName} />}
                  {v.approvedByName && <SignoffBit icon={<Stamp className="w-3 h-3" />} label="Approved" name={v.approvedByName} />}
                </div>
              )}

              {/* Cross-references */}
              {(v.mocReference || v.sourceFileName) && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-1 text-[10px] text-slate-500">
                  {v.mocReference && (
                    <span className="inline-flex items-center gap-1">
                      <LinkIcon className="w-3 h-3" /> MOC <b className="text-slate-700 font-mono">{v.mocReference}</b>
                    </span>
                  )}
                  {v.sourceFileName && (
                    <span className="inline-flex items-center gap-1">
                      <FileText className="w-3 h-3" /> <b className="text-slate-700 font-mono">{v.sourceFileName}</b>
                    </span>
                  )}
                </div>
              )}

              {/* Footer: size + hash */}
              <div className="mt-2 pl-1 flex items-center gap-3 text-[10px] text-slate-400 font-mono">
                {typeof v.size === "number" && <span>{(v.size / 1024).toFixed(0)} KB</span>}
                {v.fileHash && (
                  <span title={`SHA-256: ${v.fileHash}`} className="inline-flex items-center gap-1">
                    <Hash className="w-3 h-3" /> {v.fileHash.slice(0, 10)}…
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SignoffBit({ icon, label, name }: { icon: React.ReactNode; label: string; name: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
      <span className="text-slate-400">{icon}</span>
      <span className="font-bold uppercase tracking-wider text-[9px]">{label}</span>
      <span className="text-slate-700 font-medium">{name}</span>
    </span>
  );
}

function formatDate(ts: any): string {
  if (!ts) return "";
  try {
    const d = new Date(ts as string);
    return d.toLocaleString();
  } catch { return String(ts); }
}
