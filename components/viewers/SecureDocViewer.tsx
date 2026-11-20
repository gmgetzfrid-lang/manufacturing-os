"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle, XCircle, ShieldAlert, Lock } from 'lucide-react';
import { useRole } from '@/components/providers/RoleContext';
import { logFileView } from '@/lib/audit';
import { supabase } from '@/lib/supabase';
import { recordIntent } from '@/lib/intents';
import { appAlert } from '@/components/providers/DialogProvider';
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
    const handleKeydown = async (e: KeyboardEvent) => {
      // Block Print (Ctrl+P) and Save (Ctrl+S)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 's')) {
        e.preventDefault();
        e.stopPropagation();
        await appAlert({ title: "Print and save are off here", message: "Controlled documents don't print or save from the browser. Open the full view and use Print or Download there: it stamps the copy." });
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
      className="relative w-full h-full bg-slate-900 overflow-hidden flex flex-col group select-none print:hidden"
    >
      {/* SECURITY WATERMARK OVERLAY */}
      <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden flex items-center justify-center">
        <div className="w-full h-full flex flex-col items-center justify-center opacity-[0.03] transform -rotate-12 select-none">
           {Array.from({ length: 10 }).map((_, i) => (
             <div key={i} className="text-4xl font-black text-white whitespace-nowrap mb-24">
                {watermarkText || "UNCONTROLLED COPY"} | {viewerId} | {new Date().toLocaleDateString()}
             </div>
           ))}
        </div>
      </div>

      {/* One quiet line: which file and revision this is. The host (side
          panel, history drawer) already shows the title, so it isn't repeated. */}
      <div className="h-8 bg-slate-800 border-b border-slate-700 flex items-center gap-2 px-3 shrink-0 z-50 min-w-0" title={title}>
        <span className="text-xs font-mono font-bold text-slate-200 truncate">{docNumber}</span>
        <span className="text-[11px] font-bold text-slate-400 shrink-0">Rev {rev}</span>
        <Lock className="w-3 h-3 text-slate-500 shrink-0 ml-auto" aria-label="Print and save are off in this preview" />
      </div>

      {/* Someone else is mid-change on this document: a plain line. */}
      {lockHolder && (
        <div className="border-l-2 border-amber-500 bg-slate-900 px-3 py-1 flex items-center gap-2 text-[11px] text-amber-300 shrink-0 z-50">
          <span className="truncate">
            <b>{lockHolder.name || 'Another user'}</b> has this checked out
            {lockHolder.since ? <> since {new Date(lockHolder.since).toLocaleDateString()}</> : null}
            {lockHolder.note ? <>: <i>{lockHolder.note}</i></> : null}
            . It may change soon.
          </span>
        </div>
      )}

      {/* CONTENT AREA */}
      <div className="flex-1 relative bg-slate-950">
        {archivedInfo ? (
          <div className="absolute inset-0 overflow-y-auto bg-slate-100 p-4 z-20">
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
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-900/90 z-20">
            <Loader2 className="w-7 h-7 animate-spin mb-2 text-slate-400" />
            <span className="text-xs font-semibold text-slate-300">Loading the preview…</span>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-red-400 bg-slate-900 z-20">
            <AlertTriangle className="w-8 h-8 mb-3 opacity-60" />
            <h3 className="text-sm font-bold text-red-400">Couldn&apos;t open the preview</h3>
            <p className="text-xs mt-1 text-red-300/80 max-w-md text-center">{error}</p>
          </div>
        ) : blobUrl ? (
          <iframe 
            src={`${blobUrl}#toolbar=0&navpanes=0&scrollbar=0&zoom=${zoomLevel}`} 
            className="w-full h-full border-none bg-slate-200" 
            title={`Secure View - ${docNumber}`}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-slate-600">
            <XCircle className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs">No file to show.</p>
          </div>
        )}
      </div>

      {/* PRINT PROTECTION CURTAIN */}
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
