"use client";

// TicketArchiveViewer — read an archived ticket's WHOLE self straight out of the
// saved archive zip, in the browser, without restoring it.
//
// The "it's not gone — just view it" half of ticket archival: an archived stub
// shows this; the viewer drops the archive, pulls THIS ticket's row snapshot
// (tickets/<id>.json) + comment thread + history + attachment binaries, and
// renders them read-only. Nothing is re-uploaded; closing discards everything.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  UploadCloud, Loader2, AlertTriangle, X, Eye, Download, ShieldCheck,
  MessageSquare, Clock, Paperclip, FileText, Image as ImageIcon, File as FileIcon,
} from "lucide-react";
import { findInBackup } from "@/lib/archive";

type ZipFile = { async(type: "blob"): Promise<Blob>; async(type: "string"): Promise<string> };
type ZipLike = {
  files: Record<string, { dir: boolean }>;
  file(path: string): ZipFile | null;
};

interface ArchivedComment { id?: string; user?: string; text?: string; date?: string; type?: string; category?: string }
interface ArchivedHistory { action?: string; by?: string; user?: string; at?: string; date?: string; note?: string; detail?: string; from?: string; to?: string }
interface ArchivedAttachment { name?: string; url?: string; type?: string; size?: string }
interface ArchivedRow {
  ticket_id?: string; title?: string; status?: string; requester_name?: string; closed_at?: string;
  comments?: ArchivedComment[]; history?: ArchivedHistory[]; attachments?: ArchivedAttachment[];
}

function kindOf(name: string): "pdf" | "image" | "other" {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  return "other";
}
const fmtDate = (s?: string) => { if (!s) return ""; const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toLocaleString(); };

export default function TicketArchiveViewer({
  ticketRowId, ticketLabel, archiveId, onClose,
}: {
  ticketRowId: string;
  ticketLabel?: string;
  archiveId?: string | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [row, setRow] = useState<ArchivedRow | null>(null);
  const zipRef = useRef<ZipLike | null>(null);
  const entryPathsRef = useRef<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<{ name: string; url: string; kind: ReturnType<typeof kindOf> } | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const revoke = useCallback(() => {
    if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; }
  }, []);
  useEffect(() => () => revoke(), [revoke]);

  const handleFile = useCallback(async (file: File) => {
    if (!/\.zip$/i.test(file.name)) { setError("Drop the archive .zip you saved for this ticket."); return; }
    setLoading(true); setError(null); setRow(null); setPreview(null); revoke();
    try {
      const JSZip = (await import("jszip")).default;
      const z = await JSZip.loadAsync(file) as unknown as ZipLike;
      const paths = Object.keys(z.files);
      // Find THIS ticket's snapshot: tickets/<rowId>.json.
      const jsonPath = paths.find((p) => new RegExp(`(^|/)tickets/${ticketRowId}\\.json$`).test(p));
      if (!jsonPath) {
        setError(`This archive doesn't contain ${ticketLabel || "this ticket"}${archiveId ? ` — is it ${archiveId}.zip?` : "."}`);
        return;
      }
      const f = z.file(jsonPath);
      const parsed = JSON.parse(await f!.async("string")) as ArchivedRow;
      // The table comments snapshot is the same set the row carries; prefer the
      // row JSONB (the superset the app rendered).
      zipRef.current = z;
      entryPathsRef.current = paths;
      setRow(parsed);
    } catch (e) {
      setError(`Couldn't read that archive: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [ticketRowId, ticketLabel, archiveId, revoke]);

  const openAttachment = useCallback(async (att: ArchivedAttachment) => {
    const z = zipRef.current; const key = (att.url || "").toString();
    if (!z || !key) return;
    setError(null);
    const hit = findInBackup(entryPathsRef.current, key);
    if (!hit) { setError(`${att.name || "That file"} isn't in this archive.`); return; }
    try {
      const blob = await z.file(hit)!.async("blob");
      revoke();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setPreview({ name: att.name || key.split("/").pop() || "file", url, kind: kindOf(att.name || key) });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [revoke]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  const comments = Array.isArray(row?.comments) ? row!.comments! : [];
  const history = Array.isArray(row?.history) ? row!.history! : [];
  const attachments = Array.isArray(row?.attachments) ? row!.attachments! : [];

  return (
    <div className="fixed inset-0 z-[200] bg-slate-950/80 backdrop-blur-sm flex flex-col p-4 sm:p-8">
      <div className="mx-auto w-full max-w-5xl flex-1 min-h-0 rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <FileText className="w-4 h-4 text-sky-600 shrink-0" />
          <div className="text-sm font-black text-[var(--color-text)] truncate">
            View {ticketLabel || "ticket"} from archive{archiveId ? <span className="font-mono font-normal text-[var(--color-text-muted)]"> · {archiveId}</span> : null}
          </div>
          <span className="ml-auto text-[10px] text-emerald-600 inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> in-browser only</span>
          <button onClick={() => { revoke(); onClose(); }} className="p-1.5 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-5 h-5" /></button>
        </div>

        {!row ? (
          <div className="flex-1 grid place-items-center p-8">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={`w-full max-w-lg rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors ${dragging ? "border-sky-400 bg-sky-50" : "border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"}`}
            >
              <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
              {loading ? (
                <div className="inline-flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading archive…</div>
              ) : (
                <>
                  <UploadCloud className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
                  <div className="text-sm font-bold text-[var(--color-text)]">Drop {archiveId ? `${archiveId}.zip` : "the saved archive"} here, or click to choose</div>
                  <div className="text-[11px] text-[var(--color-text-muted)] mt-1">Its comment thread, history and files open here — nothing is re-uploaded, and closing discards it.</div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_18rem] gap-0">
            <div className="overflow-y-auto p-4 space-y-4">
              <div>
                <div className="text-base font-black text-[var(--color-text)]">{row.title || ticketLabel}</div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  {row.status} {row.requester_name ? `· ${row.requester_name}` : ""} {row.closed_at ? `· closed ${fmtDate(row.closed_at)}` : ""}
                </div>
              </div>

              <div>
                <div className="text-[11px] font-black text-[var(--color-text-muted)] uppercase tracking-wide mb-2 flex items-center gap-1.5"><MessageSquare className="w-3.5 h-3.5" /> Discussion ({comments.length})</div>
                <div className="space-y-2">
                  {comments.length === 0 && <div className="text-[11px] text-[var(--color-text-faint)] italic">No comments.</div>}
                  {comments.map((c, i) => (
                    <div key={c.id || i} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[11px] font-bold text-[var(--color-text)]">{c.user || "Unknown"}</span>
                        {c.type && c.type !== "General" && <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">{c.type}{c.category ? `: ${c.category}` : ""}</span>}
                        <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">{fmtDate(c.date)}</span>
                      </div>
                      <div className="text-[12px] text-[var(--color-text)] whitespace-pre-wrap">{c.text}</div>
                    </div>
                  ))}
                </div>
              </div>

              {history.length > 0 && (
                <div>
                  <div className="text-[11px] font-black text-[var(--color-text-muted)] uppercase tracking-wide mb-2 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> History ({history.length})</div>
                  <div className="space-y-1">
                    {history.map((h, i) => (
                      <div key={i} className="text-[11px] text-[var(--color-text-muted)] flex gap-2">
                        <span className="text-[var(--color-text-faint)] shrink-0">{fmtDate(h.at || h.date)}</span>
                        <span className="text-[var(--color-text)]">{h.action || h.note || h.detail}{h.from && h.to ? ` (${h.from} → ${h.to})` : ""}{h.by || h.user ? ` — ${h.by || h.user}` : ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {preview && (
                <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
                  <div className="px-2.5 py-1.5 border-b border-[var(--color-border)] flex items-center gap-2 bg-[var(--color-surface-2)]">
                    <Eye className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                    <span className="text-[11px] font-bold text-[var(--color-text)] truncate flex-1">{preview.name}</span>
                    <a href={preview.url} download={preview.name} className="text-[10px] font-bold text-sky-600 inline-flex items-center gap-1"><Download className="w-3 h-3" /> Save</a>
                  </div>
                  <div className="bg-[var(--color-surface-2)] grid place-items-center max-h-[40vh] overflow-auto">
                    {preview.kind === "pdf" ? (
                      <iframe src={preview.url} title={preview.name} className="w-full h-[40vh]" />
                    ) : preview.kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element -- in-memory object URL
                      <img src={preview.url} alt={preview.name} className="max-w-full max-h-[40vh] object-contain" />
                    ) : (
                      <a href={preview.url} download={preview.name} className="m-6 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-sky-600"><Download className="w-3.5 h-3.5" /> Download {preview.name}</a>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t lg:border-t-0 lg:border-l border-[var(--color-border)] overflow-y-auto p-3">
              <div className="text-[11px] font-black text-[var(--color-text-muted)] uppercase tracking-wide mb-2 flex items-center gap-1.5"><Paperclip className="w-3.5 h-3.5" /> Attachments ({attachments.length})</div>
              <div className="space-y-1">
                {attachments.length === 0 && <div className="text-[11px] text-[var(--color-text-faint)] italic">None.</div>}
                {attachments.map((a, i) => {
                  const k = kindOf(a.name || a.url || "");
                  const Icon = k === "pdf" ? FileText : k === "image" ? ImageIcon : FileIcon;
                  return (
                    <button key={i} onClick={() => void openAttachment(a)}
                      className="w-full px-2 py-1.5 flex items-center gap-2 text-left rounded-lg hover:bg-[var(--color-surface-2)]">
                      <Icon className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                      <span className="text-[11px] text-[var(--color-text)] truncate flex-1" title={a.name}>{a.name || "file"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="m-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}
      </div>
    </div>
  );
}
