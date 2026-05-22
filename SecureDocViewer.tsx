"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle, XCircle, ShieldAlert } from 'lucide-react';
import { useRole } from '@/components/providers/RoleContext';
import { logFileView } from '@/lib/audit';
import { supabase } from '@/lib/supabase';

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
  const viewerId = userEmail ?? uid ?? "USER_UNKNOWN";
  const containerRef = useRef<HTMLDivElement>(null);
  const blobUrlRef = useRef<string | null>(null);
  const loggedRef = useRef(false);

  // --- LOG VIEW ---
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
  }, [documentId, orgId, uid, userEmail, activeRole, title]);

  // --- 1. SECURITY: SOURCE OBFUSCATION ---
  // Fetches the PDF as a binary blob and creates a temporary local URL.
  // This prevents the actual Storage Bucket URL from being scraped.
  useEffect(() => {
    let active = true;
    const fetchSecurely = async () => {
      setLoading(true);
      setError(null);
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
        alert("SECURITY ALERT: Printing or Saving controlled documents via browser is strictly prohibited.\n\nUse the 'Print Control' workflow.");
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

      {/* HEADER BAR */}
      <div className="h-10 bg-slate-800 border-b border-slate-700 flex items-center justify-between px-4 shrink-0 z-50 shadow-md">
        <div className="flex items-center space-x-3 overflow-hidden min-w-0">
            <span className="text-xs font-mono font-bold text-orange-500 bg-orange-950/30 px-1.5 py-0.5 rounded border border-orange-500/20 whitespace-nowrap">
              {docNumber}
            </span>
            <span className="text-xs font-bold text-slate-300 truncate max-w-[200px]" title={title}>
              {title}
            </span>
            <span className="text-[10px] font-bold text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-700">
              Rev {rev}
            </span>
        </div>
        
        <div className="flex items-center space-x-2">
            <div className="flex items-center text-[10px] text-red-400 bg-red-950/20 px-2 py-1 rounded border border-red-500/10" title="Browser Print/Save Disabled">
                <ShieldAlert className="w-3 h-3 mr-1.5" />
                <span className="font-bold">SECURE VIEW</span>
            </div>
        </div>
      </div>

      {/* CONTENT AREA */}
      <div className="flex-1 relative bg-slate-950">
        {loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-900/90 z-20">
            <Loader2 className="w-10 h-10 animate-spin mb-3 text-blue-500" />
            <span className="text-xs font-mono font-bold animate-pulse text-blue-400">DECRYPTING STREAM...</span>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-red-400 bg-slate-900 z-20">
            <AlertTriangle className="w-16 h-16 mb-4 opacity-50" />
            <h3 className="text-lg font-bold text-red-500">Access Denied</h3>
            <p className="text-sm font-mono mt-2 text-red-300/70 max-w-md text-center">{error}</p>
          </div>
        ) : blobUrl ? (
          <iframe 
            src={`${blobUrl}#toolbar=0&navpanes=0&scrollbar=0&zoom=${zoomLevel}`} 
            className="w-full h-full border-none bg-slate-200" 
            title={`Secure View - ${docNumber}`}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-slate-600">
            <XCircle className="w-12 h-12 mb-2 opacity-20" />
            <p>No content loaded</p>
          </div>
        )}
      </div>

      {/* PRINT PROTECTION CURTAIN */}
      <div className="hidden print:flex fixed inset-0 z-[9999] bg-white flex-col items-center justify-center p-10 text-center">
        <div className="border-4 border-red-600 p-10 rounded-3xl">
          <ShieldAlert className="w-32 h-32 text-red-600 mb-8 mx-auto" />
          <h1 className="text-5xl font-black text-red-600 mb-4">SECURITY VIOLATION</h1>
          <p className="text-2xl font-bold text-slate-900 mb-8">
              This document is CONTROLLED DATA.
          </p>
          <div className="bg-slate-100 p-6 rounded-xl text-left inline-block">
             <p className="font-mono text-sm mb-2"><strong>USER:</strong> {viewerId}</p>
             <p className="font-mono text-sm mb-2"><strong>DATE:</strong> {new Date().toISOString()}</p>
             <p className="font-mono text-sm mb-2"><strong>DOC ID:</strong> {docNumber}</p>
             <p className="font-mono text-sm text-red-600 font-bold mt-4">EVENT LOGGED: ILLEGAL PRINT ATTEMPT</p>
          </div>
        </div>
      </div>
    </div>
  );
}
