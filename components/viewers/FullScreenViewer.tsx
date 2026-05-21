"use client";

import React from 'react';
import { X, Maximize2 } from 'lucide-react';
import SecureDocViewer from '@/components/viewers/SecureDocViewer';
import CheckoutStatusCell from '@/components/documents/CheckoutStatusCell';
import type { DocumentRecord } from '@/types/schema';

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
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/95 backdrop-blur-sm flex flex-col animate-in fade-in duration-200">
      {/* Header */}
      <div className="h-16 px-6 bg-slate-900 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-4">
            <div className="p-2 bg-slate-800 rounded-lg">
              <Maximize2 className="w-5 h-5 text-slate-400" />
            </div>
            <div>
              <h2 className="text-white font-bold text-lg">{title}</h2>
              <p className="text-slate-400 text-xs font-mono">{docNumber} • Rev {rev}</p>
            </div>
          </div>

          {/* CHECKOUT STATUS */}
          {document && onCheckout && (
            <div className="pl-6 border-l border-slate-700">
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

        <button 
          onClick={onClose}
          className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-full transition-colors"
        >
          <X className="w-6 h-6" />
        </button>
      </div>

      {/* Viewer Container - explicit dimensions to ensure fill */}
      <div className="flex-1 w-full h-full relative overflow-hidden bg-black">
        <SecureDocViewer
          url={url}
          title={title}
          docNumber={docNumber}
          rev={rev}
          zoomLevel={100} // Default to 100% for full screen
          watermarkText="CONTROLLED VIEW - FULLSCREEN"
        />
      </div>
    </div>
  );
}