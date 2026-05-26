"use client";

import React, { useState } from 'react';
import { X, Maximize2, Download, Printer, ShieldCheck, ShieldAlert, Loader2, Pencil } from 'lucide-react';
import SecureDocViewer from '@/components/viewers/SecureDocViewer';
import CheckoutStatusCell from '@/components/documents/CheckoutStatusCell';
import PdfMarkupEditor from '@/components/viewers/PdfMarkupEditor';
import type { DocumentRecord } from '@/types/schema';
import { downloadDocumentPdf, printDocumentPdf, determineControlState } from '@/lib/downloads';

interface FullScreenViewerProps {
  isOpen: boolean;
  onClose: () => void;
  url: string;
  title: string;
  docNumber: string;
  rev: string;
  document?: DocumentRecord;
  userRole?: string | null;
  currentUserId?: string;
  currentUserEmail?: string;
  onCheckout?: (doc: DocumentRecord) => void;
}

type PendingAction = null | { type: "download" | "print"; state: "controlled" | "uncontrolled" };

export default function FullScreenViewer({
  isOpen,
  onClose,
  url,
  title,
  docNumber,
  rev,
  document,
  userRole,
  currentUserId,
  currentUserEmail,
  onCheckout
}: FullScreenViewerProps) {
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markupOpen, setMarkupOpen] = useState(false);

  if (!isOpen) return null;

  const controlState = document && currentUserId
    ? determineControlState(document, currentUserId)
    : "uncontrolled";
  const isControlled = controlState === "controlled";

  const handleClickDownload = () => {
    if (!document || !currentUserId) return;
    if (isControlled) {
      void execute("download");
    } else {
      setPending({ type: "download", state: "uncontrolled" });
    }
  };

  const handleClickPrint = () => {
    if (!document || !currentUserId) return;
    if (isControlled) {
      void execute("print");
    } else {
      setPending({ type: "print", state: "uncontrolled" });
    }
  };

  const execute = async (type: "download" | "print") => {
    if (!document || !currentUserId) return;
    setBusy(true);
    setError(null);
    try {
      const ctx = {
        doc: document,
        fileUrl: url,
        userId: currentUserId,
        userEmail: currentUserEmail ?? null,
        userLabel: currentUserEmail ?? null,
      };
      if (type === "download") await downloadDocumentPdf(ctx);
      else await printDocumentPdf(ctx);
      setPending(null);
    } catch (e: unknown) {
      setError((e as Error).message || "Action failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/95 backdrop-blur-sm flex flex-col animate-in fade-in duration-200">
      {/* Header */}
      <div className="h-16 px-6 bg-slate-900 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-6 min-w-0">
          <div className="flex items-center space-x-4 min-w-0">
            <div className="p-2 bg-slate-800 rounded-lg shrink-0">
              <Maximize2 className="w-5 h-5 text-slate-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-white font-bold text-lg truncate">{title}</h2>
              <p className="text-slate-400 text-xs font-mono truncate">{docNumber} • Rev {rev}</p>
            </div>
          </div>

          {document && onCheckout && (
            <div className="pl-6 border-l border-slate-700 shrink-0">
              <CheckoutStatusCell
                docRecord={document}
                currentUserId={currentUserId}
                currentUserEmail={currentUserEmail}
                userRole={userRole}
                onCheckout={onCheckout}
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Control-state indicator */}
          {document && (
            <div className={`hidden md:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold ${
              isControlled
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
            }`}>
              {isControlled ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
              {isControlled ? "Controlled" : "Uncontrolled"}
            </div>
          )}

          <button
            onClick={() => setMarkupOpen(true)}
            disabled={!url}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-orange-600 hover:bg-orange-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Open in markup editor"
          >
            <Pencil className="w-3.5 h-3.5" /> Markup
          </button>
          <button
            onClick={handleClickDownload}
            disabled={!document || !currentUserId || busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Download PDF"
          >
            <Download className="w-3.5 h-3.5" /> Download
          </button>
          <button
            onClick={handleClickPrint}
            disabled={!document || !currentUserId || busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Print PDF"
          >
            <Printer className="w-3.5 h-3.5" /> Print
          </button>

          <button
            onClick={onClose}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-full transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Viewer Container - explicit dimensions to ensure fill */}
      <div className="flex-1 w-full h-full relative overflow-hidden bg-black">
        <SecureDocViewer
          url={url}
          title={title}
          docNumber={docNumber}
          rev={rev}
          zoomLevel={100}
          watermarkText={isControlled ? "CONTROLLED VIEW — FULLSCREEN" : "UNCONTROLLED VIEW"}
        />
      </div>

      {/* Markup editor — opens on top of the fullscreen view */}
      <PdfMarkupEditor
        isOpen={markupOpen}
        fileUrl={url}
        title={title}
        docNumber={docNumber}
        rev={rev}
        onClose={() => setMarkupOpen(false)}
      />

      {/* Uncontrolled-copy confirmation modal */}
      {pending && (
        <div className="fixed inset-0 z-[110] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
              <div className="p-2 bg-amber-100 rounded-lg">
                <ShieldAlert className="w-5 h-5 text-amber-700" />
              </div>
              <div>
                <div className="text-sm font-black text-slate-900">Uncontrolled Copy</div>
                <div className="text-xs text-slate-500">You don&apos;t currently have this document checked out.</div>
              </div>
            </div>
            <div className="px-6 py-4 text-sm text-slate-700 space-y-3">
              <p>
                Continuing will produce an <b>uncontrolled copy</b>. Every page will be stamped
                with a diagonal &quot;UNCONTROLLED — FOR REVIEW ONLY&quot; watermark plus a footer with
                your email and the timestamp. The action will be logged to the audit trail.
              </p>
              <p className="text-xs text-slate-500">
                If you need a controlled copy, close this dialog and check the document out first.
              </p>
              {error && (
                <p className="text-xs text-red-600 font-mono bg-red-50 border border-red-200 rounded-lg p-2">{error}</p>
              )}
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                onClick={() => { setPending(null); setError(null); }}
                disabled={busy}
                className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void execute(pending.type)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60"
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {pending.type === "download" ? "Download stamped copy" : "Print stamped copy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
