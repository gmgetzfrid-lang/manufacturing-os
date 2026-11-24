"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle, XCircle, ShieldAlert, Lock, FileText, Download } from 'lucide-react';
import { useRole } from '@/components/providers/RoleContext';
import { logFileView } from '@/lib/audit';
import { supabase } from '@/lib/supabase';
import { recordIntent } from '@/lib/intents';
import BackupViewer from '@/components/archive/BackupViewer';
import { fileBlob, fileBlobIfStarted, fileLink } from '@/lib/docOpen';
import { previewKind, fileTypeName, sizeWords } from '@/lib/filePreview';
import { downloadStoredFile } from '@/lib/fileDownload';
import { logFileDownload } from '@/lib/audit';
import { friendlyError } from '@/lib/friendlyError';
import { FieldError } from "@/components/ui/Field";

interface SecureDocViewerProps {
  url: string;
  title: string;
  docNumber: string;
  /** The revision to show; empty when none is set (the bar leaves it out). */
  rev: string;
  /** The uploaded file's name and stored type: only PDFs and pictures
   *  preview. Anything else (Word, Excel, CAD) shows as a file card and
   *  downloads only when Download is pressed, so opening a panel never
   *  starts a download (a phone asked "Download this file?" at once). */
  fileName?: string;
  mime?: string | null;
  size?: number | null;
  /** Download for the file card; when absent the card saves the file itself. */
  onDownload?: () => Promise<void> | void;
  /** The host opens the file full size on a tap (the panel does). */
  tapToOpen?: boolean;
  documentId?: string;
  orgId?: string;
  watermarkText?: string;
  zoomLevel: number;
}

export default function SecureDocViewer({ 
  url, 
  title, 
  docNumber, 
  rev,
  fileName,
  mime,
  size,
  onDownload,
  tapToOpen = false,
  documentId,
  orgId, 
  watermarkText,
  zoomLevel 
}: SecureDocViewerProps) {
  const { userEmail, uid, activeRole } = useRole();
  // A browser without its own PDF viewer (Chrome on Android) downloads a
  // PDF put in a frame, just like a Word file: there the preview is a tap
  // to open it full size (drawn by the app's own viewer), never a frame.
  const [pdfInFrame] = useState(() => typeof navigator === 'undefined' || (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled !== false);
  const fileKind = previewKind({ fileName, mime, path: url });
  const kind = fileKind === 'pdf' && !pdfInFrame ? 'tap' as const : fileKind;
  const shownName = fileName || decodeURIComponent((url || '').split(/[?#]/)[0].split('/').pop() || '') || title;
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const download = async () => {
    setSaving(true); setSaveErr(null);
    try {
      if (onDownload) { await onDownload(); return; }
      await downloadStoredFile(url, shownName);
      if (documentId && orgId && uid) {
        void logFileDownload({ orgId, fileId: documentId, fileName: shownName, userId: uid, userEmail: userEmail || 'unknown', userRole: activeRole, version: rev || undefined }).catch(() => {});
      }
    } catch (e) { setSaveErr(e); } finally { setSaving(false); }
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  // Binary shed to an offline space archive — show the provide-the-zip prompt.
  const [archivedInfo, setArchivedInfo] = useState<{ archiveId: string | null; root: string | null; fileName: string } | null>(null);
  const viewerId = userEmail ?? uid ?? "USER_UNKNOWN";
  const containerRef = useRef<HTMLDivElement>(null);
  const blobUrlRef = useRef<string | null>(null);
  const loggedRef = useRef(false);

  // Print/save pressed while the preview is open: said on the preview itself.
  const [blockedNote, setBlockedNote] = useState(false);
  const blockedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (blockedTimer.current) clearTimeout(blockedTimer.current); }, []);

  // Ambient lock signal: who (else) holds the checkout on this document.
  const [lockHolder, setLockHolder] = useState<{ name: string | null; note: string | null; since: string | null } | null>(null);

  // --- LOG VIEW + ambient intent + lock lookup ---
  useEffect(() => {
    if (loggedRef.current || !documentId || !orgId || !uid) return;
    loggedRef.current = true;

    logFileView({
      orgId,
      fileId: documentId,
      fileName: title,
      userId: uid,
      userEmail: userEmail || 'unknown',
      userRole: activeRole
    }).catch(e => console.error("Audit log failed", e));

    // View intent (fire-and-forget) — the ambient work-in-progress layer.
    void recordIntent({
      orgId,
      documentId,
      userId: uid,
      userName: userEmail?.split('@')[0] ?? null,
      kind: 'view',
      source: 'viewer',
    });

    // Lock banner data: is someone ELSE actively working on this?
    void (async () => {
      try {
        const { data } = await supabase
          .from('documents')
          .select('checked_out_by, checked_out_by_name, checkout_note, checked_out_at')
          .eq('id', documentId)
          .maybeSingle();
        const row = data as { checked_out_by?: string | null; checked_out_by_name?: string | null; checkout_note?: string | null; checked_out_at?: string | null } | null;
        if (row?.checked_out_by && String(row.checked_out_by) !== String(uid)) {
          setLockHolder({
            name: row.checked_out_by_name ?? null,
            note: row.checkout_note ?? null,
            since: row.checked_out_at ?? null,
          });
        }
      } catch { /* banner is best-effort */ }
    })();
  }, [documentId, orgId, uid, userEmail, activeRole, title]);

  // --- 1. SECURITY: SOURCE OBFUSCATION ---
  // Shows the PDF from an in-memory copy (a temporary local URL), so the
  // storage link is not what the frame points at. The signed link and the
  // bytes come from the shared open cache (lib/docOpen): a file opened
  // before, or pressed on a moment ago, shows without fetching again.
  useEffect(() => {
    let active = true;
    const show = async () => {
      setError(null);
      setArchivedInfo(null);
      // Already here: no spinner at all.
      const ready = fileBlobIfStarted(url);
      if (!ready) setLoading(true);
      let resolvedUrl = url;
      try {
        if (url && !url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('blob:')) {
          const r = await fileLink(url);
          if (!active) return;
          if (r?.kind === 'archived') {
            setArchivedInfo({ archiveId: r.archiveId, root: r.root, fileName: r.fileName || url.split('/').pop() || 'file' });
            setLoading(false);
            return;
          }
          if (r?.kind === 'url') resolvedUrl = r.url;
        }
        const blob = url.startsWith('blob:') ? null : await fileBlob(url, resolvedUrl);
        if (!active) return;
        if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
        const objUrl = blob ? URL.createObjectURL(blob) : url;
        if (blob) blobUrlRef.current = objUrl;
        setBlobUrl(objUrl);
        setLoading(false);
      } catch (e: unknown) {
        console.warn("Secure fetch failed, falling back to direct stream", e);
        if (active) {
          if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
          setBlobUrl(resolvedUrl);
          setLoading(false);
        }
      }
    };

    // Only files the browser can draw are fetched: a frame given a Word or
    // CAD file downloads it instead of showing it.
    if (url && kind !== 'none' && kind !== 'tap') void show();

    // The local URL is this frame's own; the bytes stay in the cache.
    return () => {
      active = false;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [url, kind]);

  // --- 2. SECURITY: ANTI-EXFILTRATION ---
  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      // Block Print (Ctrl+P) and Save (Ctrl+S)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 's')) {
        e.preventDefault();
        e.stopPropagation();
        setBlockedNote(true);
        if (blockedTimer.current) clearTimeout(blockedTimer.current);
        blockedTimer.current = setTimeout(() => setBlockedNote(false), 6000);
      }
    };

    // Disable Right Click Context Menu
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener('keydown', handleKeydown);
    const container = containerRef.current;
    if (container) {
      container.addEventListener('contextmenu', handleContextMenu);
    }

    return () => {
      window.removeEventListener('keydown', handleKeydown);
      if (container) container.removeEventListener('contextmenu', handleContextMenu);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="surface-charcoal relative w-full h-full bg-[var(--color-ink)] overflow-hidden flex flex-col group select-none print:hidden"
    >
      {/* SECURITY WATERMARK OVERLAY */}
      <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden flex items-center justify-center">
        <div className="w-full h-full flex flex-col items-center justify-center opacity-[0.03] transform -rotate-12 select-none">
           {Array.from({ length: 10 }).map((_, i) => (
             <div key={i} className="text-hero font-medium text-[var(--color-text)] whitespace-nowrap mb-24">
                {watermarkText || "UNCONTROLLED COPY"} | {viewerId} | {new Date().toLocaleDateString()}
             </div>
           ))}
        </div>
      </div>

      {/* One quiet line: which file and revision this is. The host (side
          panel, history drawer) already shows the title big, so it isn't
          repeated. */}
      <div className="h-9 border-b border-[var(--color-border)] flex items-center gap-2 px-3 shrink-0 z-50 min-w-0" title={title}>
        <span className="font-display text-reading font-semibold tabular-nums text-[var(--color-text)] truncate">{docNumber}</span>
        {rev && rev !== '-'
          ? <span className="text-body text-[var(--color-text-muted)] shrink-0">Rev <span className="font-display tabular-nums font-semibold text-[var(--color-text)]">{rev}</span></span>
          : <span className="text-body text-[var(--color-text-muted)] shrink-0">No revision set</span>}
        <Lock className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0 ml-auto" aria-label="Print and save are off in this preview" />
      </div>

      {/* Print or save pressed: why nothing happened, said right here. */}
      {blockedNote && (
        <div role="status" className="px-3 py-1.5 border-b border-[var(--color-border)] text-body text-[var(--color-text)] shrink-0 z-50">
          Print and save are off in this preview. Open the drawing and use Print or Download there: it stamps the copy.
        </div>
      )}

      {/* Someone else is mid-change on this document: a plain line. */}
      {lockHolder && (
        <div className="px-3 py-1.5 border-b border-[var(--color-border)] flex items-center gap-2 text-body text-amber-300 shrink-0 z-50">
          <Lock className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">
            <b>{lockHolder.name || 'Another user'}</b> has this checked out
            {lockHolder.since ? <> since {new Date(lockHolder.since).toLocaleDateString()}</> : null}
            {lockHolder.note ? <>: <i>{lockHolder.note}</i></> : null}
            . It may change soon.
          </span>
        </div>
      )}

      {/* CONTENT AREA */}
      <div className="flex-1 relative bg-[var(--color-surface)]">
        {kind === 'tap' ? (
          <div className="absolute inset-0 z-[5] flex flex-col items-center justify-center gap-2 p-4 text-center bg-[var(--color-surface-2)] text-[var(--color-text)]">
            <FileText aria-hidden className="w-8 h-8 text-[var(--color-text-muted)]" />
            <p className="text-reading font-medium break-words max-w-full">{shownName}</p>
            <p className="text-body text-[var(--color-text-muted)]">{[fileTypeName({ fileName: shownName, mime, path: url }), sizeWords(size)].filter(Boolean).join(', ')}. {tapToOpen ? 'Tap to open it full size.' : "This browser can't show a PDF inside the page."}</p>
          </div>
        ) : kind === 'none' ? (
          // A file the browser can't show: what it is, and a Download that
          // only runs when pressed.
          <div className="absolute inset-0 z-[60] flex items-center justify-center p-4 bg-[var(--color-surface-2)]">
            <div className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-[var(--color-text)]">
              <div className="flex items-start gap-3">
                <FileText aria-hidden className="w-8 h-8 shrink-0 text-[var(--color-text-muted)]" />
                <div className="min-w-0">
                  <p className="text-reading font-medium break-words">{shownName}</p>
                  <p className="text-body text-[var(--color-text-muted)]">{[fileTypeName({ fileName: shownName, mime, path: url }), sizeWords(size)].filter(Boolean).join(', ')}</p>
                </div>
              </div>
              <p className="mt-3 text-body text-[var(--color-text-muted)]">This file type can&apos;t be shown here. Download it to open it in its own program.</p>
              <button type="button" onClick={() => void download()} disabled={saving}
                className="mt-3 inline-flex items-center justify-center gap-2 h-10 pointer-coarse:h-11 px-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-reading font-medium text-[var(--color-text)] disabled:opacity-60">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download
              </button>
              {saveErr != null && <div className="mt-2"><FieldError>The download didn&apos;t start. {friendlyError(saveErr)}</FieldError></div>}
            </div>
          </div>
        ) : archivedInfo ? (
          <div className="absolute inset-0 overflow-y-auto bg-[var(--color-canvas)] p-4 z-20">
            <BackupViewer
              target={{
                storageKey: url,
                fileName: archivedInfo.fileName || title,
                archiveId: archivedInfo.archiveId,
                root: archivedInfo.root,
                kind: "space",
              }}
            />
          </div>
        ) : loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-[var(--color-text-muted)] z-20">
            <Loader2 className="w-7 h-7 animate-spin mb-2" />
            <span className="text-body font-medium">Loading the preview…</span>
          </div>
        ) : error ? (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center z-20 px-6 text-center">
            <AlertTriangle className="w-8 h-8 mb-3 text-rose-400" />
            <h3 className="font-display text-section font-semibold text-[var(--color-text)]">Couldn&apos;t open the preview</h3>
            <p className="text-body mt-1 text-[var(--color-text-muted)] max-w-md">{error}</p>
          </div>
        ) : blobUrl && kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={blobUrl} alt={title} className="w-full h-full object-contain bg-[var(--color-surface)]" draggable={false} />
        ) : blobUrl ? (
          <iframe
            src={`${blobUrl}#toolbar=0&navpanes=0&scrollbar=0&zoom=${zoomLevel}`}
            className="w-full h-full border-none bg-[var(--color-surface)]"
            title={`Secure View - ${docNumber}`}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-muted)]">
            <XCircle className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-body">No file to show.</p>
          </div>
        )}
      </div>

      {/* PRINT PROTECTION CURTAIN (on paper, so plain black on white) */}
      <div className="hidden print:flex fixed inset-0 z-[9999] bg-white flex-col items-center justify-center p-10 text-center">
        <div className="border-2 border-slate-900 p-10 rounded-lg">
          <ShieldAlert className="w-16 h-16 text-slate-900 mb-6 mx-auto" />
          <h1 className="font-display text-title font-semibold text-[var(--color-text)] mb-3">Controlled document</h1>
          <p className="text-reading text-[var(--color-text-muted)] mb-6">
              This preview doesn&apos;t print. Open the full view and use Print: it stamps the copy.
          </p>
          <div className="text-left inline-block">
             <p className="font-mono text-body mb-1"><strong>User:</strong> {viewerId}</p>
             <p className="font-mono text-body mb-1"><strong>Date:</strong> {new Date().toLocaleString()}</p>
             <p className="font-mono text-body"><strong>Document:</strong> {docNumber}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
