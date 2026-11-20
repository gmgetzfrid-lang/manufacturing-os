"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle, XCircle, ShieldAlert, Lock } from 'lucide-react';
import { useRole } from '@/components/providers/RoleContext';
import { logFileView } from '@/lib/audit';
import { supabase } from '@/lib/supabase';
import { recordIntent } from '@/lib/intents';
import BackupViewer from '@/components/archive/BackupViewer';

interface SecureDocViewerProps {
  url: string;
  title: string;
  docNumber: string;
  rev: string;
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
  documentId,
  orgId, 
  watermarkText,
  zoomLevel 
}: SecureDocViewerProps) {
  const { userEmail, uid, activeRole } = useRole();
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
  // Fetches the PDF as a binary blob and creates a temporary local URL.
  // This prevents the actual Storage Bucket URL from being scraped.
  useEffect(() => {
    let active = true;
    const fetchSecurely = async () => {
      setLoading(true);
      setError(null);
      setArchivedInfo(null);
      let resolvedUrl = url;
      try {
        // If url is a storage path (not a full URL), resolve it to a presigned URL first
        if (url && !url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('blob:')) {
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.access_token) {
            const res = await fetch(
              `/api/storage/download-url?path=${encodeURIComponent(url)}&expiresIn=3600`,
              { headers: { authorization: `Bearer ${session.access_token}` } }
            );
            if (res.ok) {
              const { url: signedUrl } = await res.json();
              resolvedUrl = signedUrl;
            } else if (res.status === 409) {
              // Shed to an offline space archive — prompt instead of streaming.
              const body = await res.json().catch(() => null) as { archived?: boolean; archiveId?: string | null; root?: string | null; fileName?: string } | null;
              if (body?.archived && active) {
                setArchivedInfo({
                  archiveId: body.archiveId ?? null,
                  root: body.root ?? null,
                  fileName: body.fileName || url.split('/').pop() || 'file',
                });
                setLoading(false);
                return;
              }
            }
          }
        }

        const response = await fetch(resolvedUrl);
        if (!response.ok) throw new Error("Failed to retrieve secure stream");
        
        const blob = await response.blob();
        if (active) {
          if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
          }
          const objUrl = URL.createObjectURL(blob);
          blobUrlRef.current = objUrl;
          setBlobUrl(objUrl);
          setLoading(false);
        }
      } catch (e: unknown) {
        console.warn("Secure fetch failed, falling back to direct stream", e);
        if (active) {
          if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
          }
          setBlobUrl(resolvedUrl);
          setLoading(false);
        }
      }
    };

    if (url) fetchSecurely();
    
    // Cleanup to prevent memory leaks
    return () => { 
      active = false; 
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [url]);

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
             <div key={i} className="text-4xl font-black text-[var(--color-text)] whitespace-nowrap mb-24">
                {watermarkText || "UNCONTROLLED COPY"} | {viewerId} | {new Date().toLocaleDateString()}
             </div>
           ))}
        </div>
      </div>

      {/* One quiet line: which file and revision this is. The host (side
          panel, history drawer) already shows the title big, so it isn't
          repeated. */}
      <div className="h-9 border-b border-[var(--color-border)] flex items-center gap-2 px-3 shrink-0 z-50 min-w-0" title={title}>
        <span className="text-[12px] font-bold text-[var(--color-text)] truncate">{docNumber}</span>
        <span className="text-[12px] text-[var(--color-text-muted)] shrink-0">Rev {rev}</span>
        <Lock className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0 ml-auto" aria-label="Print and save are off in this preview" />
      </div>

      {/* Print or save pressed: why nothing happened, said right here. */}
      {blockedNote && (
        <div role="status" className="px-3 py-1.5 border-b border-[var(--color-border)] text-[12px] text-[var(--color-text)] shrink-0 z-50">
          Print and save are off in this preview. Open the drawing and use Print or Download there: it stamps the copy.
        </div>
      )}

      {/* Someone else is mid-change on this document: a plain line. */}
      {lockHolder && (
        <div className="px-3 py-1.5 border-b border-[var(--color-border)] flex items-center gap-2 text-[12px] text-amber-300 shrink-0 z-50">
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
        {archivedInfo ? (
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
            <span className="text-[13px] font-semibold">Loading the preview…</span>
          </div>
        ) : error ? (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center z-20 px-6 text-center">
            <AlertTriangle className="w-8 h-8 mb-3 text-rose-400" />
            <h3 className="text-[14px] font-bold text-[var(--color-text)]">Couldn&apos;t open the preview</h3>
            <p className="text-[13px] mt-1 text-[var(--color-text-muted)] max-w-md">{error}</p>
          </div>
        ) : blobUrl ? (
          <iframe
            src={`${blobUrl}#toolbar=0&navpanes=0&scrollbar=0&zoom=${zoomLevel}`}
            className="w-full h-full border-none bg-[var(--color-surface)]"
            title={`Secure View - ${docNumber}`}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-muted)]">
            <XCircle className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-[13px]">No file to show.</p>
          </div>
        )}
      </div>

      {/* PRINT PROTECTION CURTAIN (on paper, so plain black on white) */}
      <div className="hidden print:flex fixed inset-0 z-[9999] bg-white flex-col items-center justify-center p-10 text-center">
        <div className="border-2 border-slate-900 p-10 rounded-2xl">
          <ShieldAlert className="w-16 h-16 text-slate-900 mb-6 mx-auto" />
          <h1 className="text-3xl font-black text-slate-900 mb-3">Controlled document</h1>
          <p className="text-lg text-slate-700 mb-6">
              This preview doesn&apos;t print. Open the full view and use Print: it stamps the copy.
          </p>
          <div className="text-left inline-block">
             <p className="font-mono text-sm mb-1"><strong>User:</strong> {viewerId}</p>
             <p className="font-mono text-sm mb-1"><strong>Date:</strong> {new Date().toLocaleString()}</p>
             <p className="font-mono text-sm"><strong>Document:</strong> {docNumber}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
