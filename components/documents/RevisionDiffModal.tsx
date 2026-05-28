"use client";

// RevisionDiffModal — modal wrapper around PdfRevisionDiff.
//
// Takes two DocumentVersion rows, resolves their storage paths to
// presigned URLs (mirroring the pattern in VersionHistoryPanel and
// FullScreenViewer), and renders the rasterized diff.
//
// Convention: `baseVersion` is the older revision, `compareVersion`
// is the newer (typically the current revision). Red highlights what
// existed in base but not compare ("removed"); green highlights what
// appeared in compare but not base ("added").

import React, { useEffect, useState } from "react";
import { X, Loader2, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { DocumentVersion } from "@/types/schema";
import PdfRevisionDiff from "@/components/viewers/PdfRevisionDiff";

interface RevisionDiffModalProps {
  isOpen: boolean;
  onClose: () => void;
  baseVersion: DocumentVersion;
  compareVersion: DocumentVersion;
}

async function resolveToHttpUrl(raw: string): Promise<string> {
  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("blob:")) {
    return raw;
  }
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(
    `/api/storage/download-url?path=${encodeURIComponent(raw)}&expiresIn=3600`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("Failed to resolve storage URL");
  const { url } = await res.json();
  return url as string;
}

export default function RevisionDiffModal({
  isOpen, onClose, baseVersion, compareVersion,
}: RevisionDiffModalProps) {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [compareUrl, setCompareUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    // All state mutations inside the async IIFE so render stays pure.
    (async () => {
      try {
        const [b, c] = await Promise.all([
          resolveToHttpUrl(baseVersion.fileUrl),
          resolveToHttpUrl(compareVersion.fileUrl),
        ]);
        if (!alive) return;
        setBaseUrl(b);
        setCompareUrl(c);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
        setBaseUrl(null);
        setCompareUrl(null);
      }
    })();
    return () => { alive = false; };
  }, [isOpen, baseVersion.fileUrl, compareVersion.fileUrl]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[220] bg-slate-900/80 backdrop-blur-sm flex flex-col p-4">
      <div className="flex-1 bg-slate-900 border border-slate-700 rounded-2xl overflow-hidden flex flex-col shadow-2xl">
        {/* Title bar */}
        <div className="h-12 px-4 flex items-center justify-between bg-slate-800 border-b border-slate-700 shrink-0">
          <div className="flex items-center gap-3 text-xs">
            <span className="font-black text-slate-200 uppercase tracking-widest">Revision Diff</span>
            <span className="text-slate-500">·</span>
            <span className="font-mono text-red-300">Rev {baseVersion.revisionLabel}</span>
            <span className="text-slate-500">→</span>
            <span className="font-mono text-emerald-300">Rev {compareVersion.revisionLabel}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-700"
            title="Close"
          ><X className="w-4 h-4" /></button>
        </div>

        {/* Diff body */}
        <div className="flex-1 relative">
          {error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-red-400">
              <AlertTriangle className="w-10 h-10 mb-2 opacity-60" />
              <span className="text-sm font-bold">Could not load revisions</span>
              <span className="text-xs font-mono mt-1 max-w-md text-center text-red-300/70">{error}</span>
            </div>
          ) : !baseUrl || !compareUrl ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-blue-400 mb-2" />
              <span className="text-xs font-mono">Resolving revisions…</span>
            </div>
          ) : (
            <PdfRevisionDiff
              baseUrl={baseUrl}
              baseLabel={`Rev ${baseVersion.revisionLabel}`}
              compareUrl={compareUrl}
              compareLabel={`Rev ${compareVersion.revisionLabel}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
