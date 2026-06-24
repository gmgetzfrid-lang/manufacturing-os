"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { uploadTicketAttachment, getSignedUrlForPath } from '@/lib/storage';
import { useRole } from '@/components/providers/RoleContext';
import { useToast } from '@/components/providers/ToastProvider';
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";
import { Ticket, TicketStatus, TicketAttachment, TicketComment } from '@/types/schema';
import { WorkflowEngine, WorkflowAction } from '@/lib/workflow';
import EngineerPickerModal from '@/components/requests/EngineerPickerModal';
import MentionableTextarea from '@/components/requests/MentionableTextarea';
import CommentBody from '@/components/requests/CommentBody';
import WorkflowDiagramModal from '@/components/requests/WorkflowDiagramModal';
import SignaturePanel from '@/components/signatures/SignaturePanel';
import { extractMentionUids, isPastDue, isNearingDue } from '@/lib/notifications';
import { downloadStampedPdf } from '@/lib/stamping';
import { logAuditAction } from '@/lib/audit';
import AdvancedRedlineEditor from '@/components/drafting/AdvancedRedlineEditor';
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  FileText,
  MessageSquare,
  Paperclip,
  Send,
  User,
  AlertCircle,
  Download,
  Eye,
  X,
  Printer,
  Save,
  UploadCloud,
  Loader2,
  FileIcon,
  Maximize2,
  Flag,
  ShieldAlert,
  ChevronDown,
  Trash2,
  UserPlus,
  CheckSquare,
  AlertTriangle,
  FileCheck,
  Stamp,
  Pen,
  TrendingUp,
  Check, // Added Check icon
  HelpCircle,
  RotateCcw,
  Archive,
} from 'lucide-react';

// =========================================================================================
// UTILITY: SAFE DATE CONVERTER & FORMATTERS
// =========================================================================================

const toDate = (date: unknown): Date => {
  if (!date) return new Date();
  if (typeof date === 'object' && date !== null) {
    const obj = date as { toDate?: () => Date; seconds?: number };
    if (typeof obj.toDate === 'function') return obj.toDate();
    if (date instanceof Date) return date;
    if (typeof obj.seconds === 'number') return new Date(obj.seconds * 1000);
  }
  if (typeof date === 'string') return new Date(date);
  return new Date(date as string | number);
};

// Distinct, stable bubble colors per comment author, so a multi-person thread
// is readable at a glance. "You" stays blue + right-aligned; everyone else gets
// a deterministic color (more people in a thread -> more colors).
const AUTHOR_BUBBLE_PALETTE = [
  'bg-violet-50 border border-violet-200 text-violet-900',
  'bg-teal-50 border border-teal-200 text-teal-900',
  'bg-rose-50 border border-rose-200 text-rose-900',
  'bg-sky-50 border border-sky-200 text-sky-900',
  'bg-indigo-50 border border-indigo-200 text-indigo-900',
  'bg-lime-50 border border-lime-200 text-lime-900',
  'bg-fuchsia-50 border border-fuchsia-200 text-fuchsia-900',
  'bg-cyan-50 border border-cyan-200 text-cyan-900',
];
const AUTHOR_AVATAR_PALETTE = [
  'bg-violet-200 text-violet-700',
  'bg-teal-200 text-teal-700',
  'bg-rose-200 text-rose-700',
  'bg-sky-200 text-sky-700',
  'bg-indigo-200 text-indigo-700',
  'bg-lime-200 text-lime-700',
  'bg-fuchsia-200 text-fuchsia-700',
  'bg-cyan-200 text-cyan-700',
];
function authorColorIndex(user: string): number {
  let h = 0;
  for (let i = 0; i < (user || '').length; i++) h = (h * 31 + user.charCodeAt(i)) >>> 0;
  return h % AUTHOR_BUBBLE_PALETTE.length;
}
function authorLabel(user: string): string {
  return (user || 'Unknown').split('@')[0];
}

const formatBytes = (bytes: number, decimals = 2) => {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// =========================================================================================
// CONSTANTS
// =========================================================================================
const REVISION_REASONS = [
  "Drafting Error",
  "Missing Information",
  "Incorrect Information",
  "Standards Violation",
  "Scope Change",
  "Design Update",
  "Other"
];

// =========================================================================================
// SUB-COMPONENT: ACTION MODAL (Comments / Rejection)
// =========================================================================================
interface ActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (text: string, category?: string) => void;
  onRedline?: () => void;
  title: string;
  description: string;
  isDestructive?: boolean;
  isLoading?: boolean;
  defaultValue?: string;
  showCategorySelection?: boolean;
}

const ActionModal = ({ isOpen, onClose, onSubmit, onRedline, title, description, isDestructive, isLoading, defaultValue, showCategorySelection }: ActionModalProps) => {
  const [comment, setComment] = useState('');
  const [category, setCategory] = useState(REVISION_REASONS[0]);

  useEffect(() => {
    if (!isOpen) return;
    // Seed fields when the modal opens; IIFE keeps these out of the effect's
    // direct body so they aren't read as cascading synchronous updates.
    void (async () => {
      setComment(defaultValue || '');
      setCategory(REVISION_REASONS[0]);
    })();
  }, [isOpen, defaultValue]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center overflow-y-auto p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-[var(--color-border)] animate-in fade-in zoom-in-95">
        <div className={`px-6 py-4 border-b ${isDestructive ? 'bg-red-50 border-red-100' : 'bg-[var(--color-surface-2)] border-[var(--color-border)]'}`}>
          <h3 className={`text-lg font-bold ${isDestructive ? 'text-red-900' : 'text-[var(--color-text)]'}`}>{title}</h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">{description}</p>
        </div>
        <div className="p-6 space-y-4">
          {showCategorySelection && (
            <div>
              <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                Reason Category <span className="text-red-500">*</span>
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full p-2.5 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface-2)] focus:ring-2 focus:ring-orange-500 outline-none"
              >
                {REVISION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
              {showCategorySelection ? 'Additional Details' : 'Reason / Comment'} <span className="text-red-500">*</span>
            </label>
            <textarea 
              className="w-full h-32 p-3 border border-[var(--color-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-orange-500 outline-none resize-none"
              placeholder="Please provide details..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            {defaultValue && (
              <p className="text-[10px] text-green-600 mt-2 flex items-center">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Pre-filled from your recent comment.
              </p>
            )}
          </div>
          <div className="flex justify-between pt-2">
            {onRedline && (
              <button 
                onClick={onRedline}
                className="flex items-center px-3 py-2 text-sm font-bold text-orange-600 hover:bg-orange-50 rounded-lg transition-colors border border-orange-200"
                disabled={isLoading}
              >
                <Pen className="w-4 h-4 mr-2" /> Add Redlines
              </button>
            )}
            <div className="flex space-x-3 ml-auto">
              <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] rounded-lg transition-colors" disabled={isLoading}>Cancel</button>
              <button onClick={() => onSubmit(comment, showCategorySelection ? category : undefined)} disabled={!comment.trim() || isLoading} className={`px-6 py-2 text-sm font-bold text-white rounded-lg shadow-sm transition-all flex items-center ${isDestructive ? 'bg-red-600 hover:bg-red-700 disabled:bg-red-300' : 'bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400'}`}>
                {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Confirm
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// =========================================================================================
// SUB-COMPONENT: ASSIGNMENT MODAL
// =========================================================================================
interface AssignmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (drafterId: string, drafterName: string, reason?: string) => void;
  isLoading?: boolean;
  activeOrgId: string | null;
  isReassignment?: boolean;
}

const AssignmentModal = ({ isOpen, onClose, onSubmit, isLoading, activeOrgId, isReassignment }: AssignmentModalProps) => {
  const [drafters, setDrafters] = useState<{uid: string, email: string, role: string}[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (isOpen) {
      setReason(''); // Reset reason on open
      if (activeOrgId) {
        const fetchDrafters = async () => {
          try {
            const { data } = await supabase
              .from('org_members')
              .select('uid, email, role')
              .eq('org_id', activeOrgId)
              .eq('role', 'Drafter')
              .eq('status', 'active');
            setDrafters((data || []).map(r => ({ uid: r.uid, email: r.email, role: r.role })));
          } catch (error) {
            console.error("Error fetching drafters:", error);
          } finally {
            setLoadingList(false);
          }
        };
        fetchDrafters();
      }
    }
  }, [isOpen, activeOrgId]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center overflow-y-auto p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden border border-[var(--color-border)] animate-in fade-in zoom-in-95">
        <div className={`px-6 py-4 border-b ${isReassignment ? 'bg-orange-50 border-orange-200' : 'bg-[var(--color-surface-2)] border-[var(--color-border)]'}`}>
          <h3 className={`text-lg font-bold ${isReassignment ? 'text-orange-900' : 'text-[var(--color-text)]'}`}>{isReassignment ? 'Reassign Ticket' : 'Assign Ticket'}</h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">{isReassignment ? 'Select a new drafter and provide a reason.' : 'Select a Drafter to handle this request.'}</p>
        </div>
        
        <div className="p-4 space-y-4">
          {isReassignment && (
            <div>
              <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                Reason for Change <span className="text-red-500">*</span>
              </label>
              <textarea 
                className="w-full p-3 border border-[var(--color-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-orange-500 outline-none resize-none bg-[var(--color-surface-2)]"
                rows={3}
                placeholder="Why is this ticket being reassigned?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}

          <div className="max-h-[300px] overflow-y-auto custom-scrollbar border border-[var(--color-border)] rounded-lg">
            {loadingList ? (
              <div className="flex justify-center py-8"><Loader2 className="w-8 h-8 animate-spin text-orange-500" /></div>
            ) : drafters.length === 0 ? (
              <div className="p-4 text-center text-[var(--color-text-muted)] italic">No drafters found in the system.</div>
            ) : (
              <div className="grid grid-cols-1 gap-1">
                {drafters.map(drafter => (
                  <button 
                    key={drafter.uid} 
                    onClick={async () => {
                      if (isReassignment && !reason.trim()) {
                        await appAlert({ message: "Please provide a reason for reassignment." });
                        return;
                      }
                      onSubmit(drafter.uid, drafter.email.split('@')[0], reason);
                    }}
                    disabled={isLoading} 
                    className="flex items-center p-3 hover:bg-orange-50 rounded-lg transition-colors group text-left w-full border border-transparent hover:border-orange-100"
                  >
                    <div className="h-10 w-10 rounded-full bg-[var(--color-surface-2)] group-hover:bg-[var(--color-surface)] flex items-center justify-center text-[var(--color-text-muted)] group-hover:text-orange-600 mr-4 border border-[var(--color-border)]"><User className="w-5 h-5" /></div>
                    <div><p className="font-bold text-[var(--color-text)] text-sm">{drafter.email}</p><p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide">Drafter</p></div>
                    <ChevronDown className="w-4 h-4 ml-auto text-slate-300 group-hover:text-orange-400 -rotate-90" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex justify-end"><button onClick={onClose} className="text-sm font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button></div>
      </div>
    </div>
  );
};

// =========================================================================================
// SUB-COMPONENT: UPLOAD IFC MODAL
// =========================================================================================
interface UploadIFCModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (file: File) => void;
  isLoading?: boolean;
}

const UploadIFCModal = ({ isOpen, onClose, onSubmit, isLoading }: UploadIFCModalProps) => {
  const [file, setFile] = useState<File | null>(null);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center overflow-y-auto p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-[var(--color-border)] animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 bg-teal-50 border-b border-teal-100">
          <h3 className="text-lg font-bold text-teal-900 flex items-center">
            <Stamp className="w-5 h-5 mr-2 text-teal-600" />
            Issue For Construction
          </h3>
          <p className="text-xs text-teal-700 mt-1">Please upload the finalized, stamped PDF.</p>
        </div>
        <div className="p-6">
          <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-teal-200 rounded-xl cursor-pointer bg-teal-50/30 hover:bg-teal-50 transition-colors">
            {file ? (
              <div className="text-center">
                <FileCheck className="w-8 h-8 text-teal-600 mx-auto mb-2" />
                <p className="text-sm font-bold text-teal-900">{file.name}</p>
                <p className="text-xs text-teal-600">{formatBytes(file.size)}</p>
              </div>
            ) : (
              <div className="text-center">
                <UploadCloud className="w-8 h-8 text-teal-400 mx-auto mb-2" />
                <p className="text-sm font-medium text-teal-800">Click to upload Stamped PDF</p>
              </div>
            )}
            <input type="file" className="hidden" accept=".pdf" onChange={(e) => e.target.files && setFile(e.target.files[0])} />
          </label>
        </div>
        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex justify-end space-x-3">
           <button onClick={onClose} className="text-sm font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
           <button 
             onClick={() => file && onSubmit(file)}
             disabled={!file || isLoading}
             className="px-4 py-2 bg-teal-600 text-white text-sm font-bold rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center"
           >
             {isLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
             Issue Final Package
           </button>
        </div>
      </div>
    </div>
  );
};

// =========================================================================================
// SUB-COMPONENT: COMPLIANCE DOWNLOAD MODAL (Prevention Mechanism)
// =========================================================================================
interface DownloadComplianceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  fileName: string;
}

const DownloadComplianceModal = ({ isOpen, onClose, onConfirm, fileName }: DownloadComplianceModalProps) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-start sm:items-center justify-center overflow-y-auto p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden border-2 border-amber-300 animate-in fade-in zoom-in-95">
        <div className="p-6 text-center">
          <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
             <AlertTriangle className="w-8 h-8 text-amber-600" />
          </div>
          <h3 className="text-lg font-bold text-[var(--color-text)] mb-2">Preliminary Document</h3>
          <p className="text-sm text-[var(--color-text-muted)] mb-6">
            You are downloading <strong>{fileName}</strong>. This file is <span className="font-bold text-red-600">NOT FOR CONSTRUCTION</span>. It is for review purposes only.
          </p>
          <div className="space-y-3">
            <button 
              onClick={onConfirm}
              className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg transition-colors shadow-lg"
            >
              I Acknowledge
            </button>
            <button 
              onClick={onClose}
              className="w-full py-3 bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] font-bold rounded-lg hover:bg-[var(--color-surface-2)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// =========================================================================================
// SUB-COMPONENT: WATERMARK OVERLAY
// =========================================================================================
// Subtle, evenly-tiled diagonal watermark — the professional way to mark a
// preliminary sheet, instead of a few giant garish words stamped across it.
// Low opacity + letter-spaced caps reads as a real document watermark.
const WatermarkOverlay = () => (
  <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden select-none" aria-hidden>
    <div className="absolute inset-[-25%] flex flex-col justify-around -rotate-[24deg]">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="flex justify-around whitespace-nowrap opacity-[0.07]">
          {Array.from({ length: 3 }).map((__, j) => (
            <span key={j} className="text-xl font-semibold uppercase tracking-[0.45em] text-[var(--color-text)]">
              Preliminary&nbsp;·&nbsp;Not for Construction
            </span>
          ))}
        </div>
      ))}
    </div>
  </div>
);

// =========================================================================================
// SUB-COMPONENT: REDLINE EDITOR MOUNT
// Resolves the attachment's R2 path to a presigned URL before mounting
// the editor. AdvancedRedlineEditor takes a plain fileUrl prop, so we
// can't pass the raw storage path — it would 404 inside the iframe.
// =========================================================================================
function RedlineEditorMount({
  file, onClose, onSave, isSaving,
}: {
  file: TicketAttachment;
  onClose: () => void;
  onSave: (blob: Blob) => Promise<void>;
  isSaving: boolean;
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (/^https?:\/\//i.test(file.url)) { if (alive) setResolvedUrl(file.url); return; }
      try {
        const u = await getSignedUrlForPath(file.url);
        if (alive) setResolvedUrl(u);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [file.url]);
  if (error) {
    return (
      <div className="fixed inset-0 z-[200] bg-slate-900/80 flex items-start sm:items-center justify-center overflow-y-auto p-6">
        <div className="bg-[var(--color-surface)] rounded-2xl p-6 max-w-md text-center">
          <p className="text-sm text-red-700 font-bold">Couldn&apos;t load the file: {error}</p>
          <button onClick={onClose} className="mt-3 px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold">Close</button>
        </div>
      </div>
    );
  }
  if (!resolvedUrl) {
    return (
      <div className="fixed inset-0 z-[200] bg-slate-900/80 flex items-center justify-center">
        <div className="text-white text-sm inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Preparing redline editor…</div>
      </div>
    );
  }
  return (
    <AdvancedRedlineEditor
      fileUrl={resolvedUrl}
      onClose={onClose}
      onSave={onSave}
      isSaving={isSaving}
    />
  );
}

// =========================================================================================
// SUB-COMPONENT: FILE VIEWER MODAL (With Protection)
// =========================================================================================
const FileViewerModal = ({
  file,
  isOpen,
  onClose,
  ticketId,
  orgId,
  userId,
  onApprove,
}: {
  file: TicketAttachment | null;
  isOpen: boolean;
  onClose: () => void;
  ticketId?: string;
  orgId?: string;
  userId?: string;
  onApprove?: () => void;
}) => {
  const [showCompliance, setShowCompliance] = useState(false);
  // file.url is stored as the raw R2 storage path (orgs/<org>/tickets/...).
  // Resolve to a presigned download URL once the modal opens so the iframe
  // / img tags actually load. Without this they show "not found".
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const { userEmail } = useRole();

  useEffect(() => {
    if (!isOpen || !file?.url) { setResolvedUrl(null); setResolveError(null); return; }
    let alive = true;
    setResolvedUrl(null);
    setResolveError(null);
    // If the stored value already looks like a fully-qualified URL (legacy
    // attachments uploaded before the path-only fix), pass it through.
    if (/^https?:\/\//i.test(file.url)) { setResolvedUrl(file.url); return; }
    getSignedUrlForPath(file.url)
      .then((u) => { if (alive) setResolvedUrl(u); })
      .catch((e) => { if (alive) setResolveError((e as Error).message); });
    return () => { alive = false; };
  }, [isOpen, file?.url]);

  if (!isOpen || !file) return null;

  const isPdf = file.type?.includes('pdf') || file.name.toLowerCase().endsWith('.pdf');
  const isImage = file.type?.includes('image') || file.name.match(/\.(jpeg|jpg|gif|png)$/i);

  const handlePrint = async () => {
    // If draft, block print or warn? For high fidelity, we just warn on download for now.
    // Real implementation would watermark the print stream.
    if (!resolvedUrl) { await appAlert({ message: 'Still loading file — try again in a moment.' }); return; }
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = resolvedUrl;
    document.body.appendChild(iframe);
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => document.body.removeChild(iframe), 2000);
  };

  const handleDownloadClick = () => {
    if (file.type === 'Draft') {
      setShowCompliance(true);
    } else {
      performDownload();
    }
  };

  const performDownload = async () => {
    const now = new Date();
    const expiresAt = file.type === "Draft"
      ? new Date(now.getTime() + 72 * 60 * 60 * 1000)
      : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    try {
      const downloadUrl = resolvedUrl || (await getSignedUrlForPath(file.url));
      await downloadStampedPdf({
        url: downloadUrl,
        filename: file.name,
        options: {
          userLabel: userEmail?.split("@")[0] || userId || "USER",
          email: userEmail || undefined,
          timestamp: now,
          expiresAt,
          watermarkText: file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "CONTROLLED COPY",
        },
      });

      if (orgId && userId) {
        await supabase.from("download_audits").insert({
          org_id: orgId, ticket_id: ticketId ?? null, attachment_id: file.id,
          attachment_type: file.type, filename: file.name, user_id: userId,
          user_email: userEmail ?? null, expires_at: expiresAt,
          watermark_text: file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "CONTROLLED COPY",
          source: "drafting",
        });
      }
    } catch (e) {
      console.warn("Stamp Generation Failed (likely CORS). Falling back to direct download.", e);
      
      // SILENT FALLBACK:
      // If stamping fails, we simply give the user the original file.
      // We do not show an alert to avoid disrupting the user workflow.
      
      const link = document.createElement("a");
      link.href = resolvedUrl || (await getSignedUrlForPath(file.url));
      link.download = file.name;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setShowCompliance(false);
    }
  };

  return (
    <>
      <DownloadComplianceModal 
        isOpen={showCompliance} 
        onClose={() => setShowCompliance(false)} 
        onConfirm={performDownload}
        fileName={file.name}
      />
      
      <div className="fixed inset-0 z-[100] bg-slate-950/95 backdrop-blur-md flex flex-col animate-in fade-in duration-300">
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900 border-b border-slate-800 text-white shadow-md relative z-50">
          <div className="flex items-center space-x-4">
            <div className={`p-2 rounded-lg border ${file.type === 'Draft' ? 'bg-amber-900/50 border-amber-500/50 text-amber-500' : 'bg-slate-800 border-slate-700 text-teal-500'}`}>
               {file.type === 'Draft' ? <AlertTriangle className="w-6 h-6" /> : <FileCheck className="w-6 h-6" />}
            </div>
            <div>
              <h3 className="font-bold text-lg leading-none flex items-center">
                {file.name}
                {file.type === 'Draft' && <span className="ml-3 px-2 py-0.5 bg-amber-500 text-black text-[10px] font-black rounded uppercase tracking-wider">Preliminary</span>}
              </h3>
              <div className="flex items-center text-xs text-[var(--color-text-faint)] mt-1.5 space-x-2">
                <span className="bg-slate-800 px-2 py-0.5 rounded border border-slate-700">{file.type}</span>
                <span>•</span>
                <span>{file.size}</span>
                <span>•</span>
                <span>{toDate(file.uploadedAt).toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            {onApprove && file.type === 'Draft' && (
              <button 
                onClick={onApprove}
                className="flex items-center px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-sm font-bold transition-colors shadow-lg animate-in fade-in slide-in-from-right-4"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" /> Approve
              </button>
            )}
            {file.type !== 'Draft' && (
               <button onClick={handlePrint} className="flex items-center px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-colors border border-slate-700">
                 <Printer className="w-4 h-4 mr-2" /> Print
               </button>
            )}
            <button 
              onClick={handleDownloadClick}
              className={`flex items-center px-4 py-2 rounded-lg text-sm font-bold transition-colors shadow-lg ${file.type === 'Draft' ? 'bg-amber-600 hover:bg-amber-700 text-white' : 'bg-orange-600 hover:bg-orange-700 text-white'}`}
            >
              <Download className="w-4 h-4 mr-2" /> {file.type === 'Draft' ? 'Download w/ Warning' : 'Download'}
            </button>
            <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-full transition-colors text-[var(--color-text-faint)] hover:text-white">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        
        <div className="flex-1 overflow-hidden relative bg-slate-900/50 flex items-center justify-center p-8">
          {/* VISUAL PROTECTION LAYER */}
          {file.type === 'Draft' && <WatermarkOverlay />}

          {isPdf ? (
            resolvedUrl ? (
              <iframe src={`${resolvedUrl}#toolbar=0&navpanes=0`} className="w-full h-full rounded-lg shadow-2xl bg-[var(--color-surface)] border border-slate-700 relative z-0" title="PDF Viewer" />
            ) : resolveError ? (
              <div className="text-red-300 text-sm">Couldn&apos;t load the file: {resolveError}</div>
            ) : (
              <div className="text-slate-300 text-sm flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Preparing preview…</div>
            )
          ) : isImage ? (
            resolvedUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- ephemeral signed-URL preview; optimizer can't cache short-lived URLs and intrinsic size is unknown
              <img src={resolvedUrl} alt="Preview" className="max-w-full max-h-full object-contain shadow-2xl rounded-lg border border-slate-700 relative z-0" />
            ) : resolveError ? (
              <div className="text-red-300 text-sm">Couldn&apos;t load the file: {resolveError}</div>
            ) : (
              <div className="text-slate-300 text-sm flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Preparing preview…</div>
            )
          ) : (
            <div className="text-center p-12 bg-[var(--color-surface)] rounded-xl shadow-2xl max-w-md border border-[var(--color-border)] relative z-10">
              <div className="w-24 h-24 bg-[var(--color-surface-2)] rounded-full flex items-center justify-center mx-auto mb-6 border border-[var(--color-border)]">
                <FileIcon className="w-12 h-12 text-slate-300" />
              </div>
              <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">Preview Unavailable</h3>
              <p className="text-[var(--color-text-muted)] mb-8 leading-relaxed">This file format cannot be previewed directly.<br/>Please download to view.</p>
              <button onClick={handleDownloadClick} className="inline-flex items-center px-8 py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg transition-colors shadow-lg">
                <Download className="w-4 h-4 mr-2" /> Download File
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

// =========================================================================================
// MAIN PAGE COMPONENT
// =========================================================================================

export default function TicketDetailView() {
  const params = useParams();
  const router = useRouter();
  const { activeRole, userEmail, activeOrgId, uid } = useRole();
  const { showToast } = useToast();
  const ticketId = params.id as string;

  // --- STATE ---
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  
  // Tab State
  const [activeTab, setActiveTab] = useState<'discussion' | 'audit'>('discussion');
  
  // Workflow Actions State
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<WorkflowAction | null>(null);
  
  // Modal States
  const [showCommentModal, setShowCommentModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showEngineerPicker, setShowEngineerPicker] = useState(false);
  const [showUploadIFC, setShowUploadIFC] = useState(false);
  const [preFilledComment, setPreFilledComment] = useState<string>('');
  
  // Redline State
  const [showWorkflowDiagram, setShowWorkflowDiagram] = useState(false);
  const [showRedlineEditor, setShowRedlineEditor] = useState(false);
  const [fileToRedline, setFileToRedline] = useState<TicketAttachment | null>(null);
  const [pendingRedlineBlob, setPendingRedlineBlob] = useState<Blob | null>(null);
  const [isReassigning, setIsReassigning] = useState(false);

  const handleReassignClick = () => {
    setIsReassigning(true);
    setPendingAction({ action: 'assign', label: 'Reassign Ticket', variant: 'warning' });
    setShowAssignModal(true);
  };

  // File Staging State
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  
  // Chat State
  const [newComment, setNewComment] = useState('');
  const [newCommentMentions, setNewCommentMentions] = useState<string[]>([]);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [viewerFile, setViewerFile] = useState<TicketAttachment | null>(null);

  // Admin Override State
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCategoryVal, setEditCategoryVal] = useState<string>('');
  // Per-comment text editing
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editTextDraft, setEditTextDraft] = useState<string>('');

  const isAdmin = ['Admin', 'DocCtrl'].includes(activeRole);

  // --- 1. DATA SYNC ---
  useEffect(() => {
    if (!ticketId) return;
    let alive = true;

    const fromRow = (r: Record<string, unknown>): Ticket => ({
      id: r.id as string, orgId: r.org_id as string, ticketId: r.ticket_id as string,
      title: r.title as string, description: r.description as string | undefined,
      unit: r.unit as string, requestType: r.request_type as string,
      status: r.status as Ticket['status'], priority: r.priority as number | undefined,
      requesterId: r.requester_id as string, requesterName: r.requester_name as string | undefined,
      requesterEmail: r.requester_email as string | undefined,
      requesterRole: r.requester_role as Ticket['requesterRole'],
      assignedDrafterId: r.assigned_drafter_id as string | null | undefined,
      assignedDrafterName: r.assigned_drafter_name as string | null | undefined,
      assignedEngineerId: r.assigned_engineer_id as string | null | undefined,
      assignedEngineerName: r.assigned_engineer_name as string | null | undefined,
      assignedEngineerEmail: r.assigned_engineer_email as string | null | undefined,
      engineerReviewRequestedAt: r.engineer_review_requested_at as string | null | undefined,
      engineerApprovedAt: r.engineer_approved_at as string | null | undefined,
      engineerReviewReason: r.engineer_review_reason as string | null | undefined,
      watchers: (r.watchers as string[] | undefined) ?? [],
      targetCompletionAt: r.target_completion_at as string | null | undefined,
      slaBreachWarnedAt: r.sla_breach_warned_at as string | null | undefined,
      slaBreachedAt: r.sla_breached_at as string | null | undefined,
      attachments: (r.attachments as Ticket['attachments']) ?? [],
      comments: (r.comments as Ticket['comments']) ?? [],
      history: (r.history as Ticket['history']) ?? [],
      unreadBy: (r.unread_by as string[]) ?? [],
      revisionCount: r.revision_count as number | undefined,
      metadata: (r.metadata as Record<string, unknown> | null) ?? undefined,
      createdAt: r.created_at as string,
      lastModified: r.last_modified as string | undefined,
      updatedAt: r.updated_at as string | undefined,
      archivedAt: r.archived_at as string | null | undefined,
      archiveId: r.archive_id as string | null | undefined,
    });

    const fetchTicket = async () => {
      const { data } = await supabase.from('tickets').select('*').eq('id', ticketId).single();
      if (!alive) return;
      if (!data) { router.push('/requests'); return; }
      const t = fromRow(data as Record<string, unknown>);
      if (activeOrgId && t.orgId && t.orgId !== activeOrgId) { router.push('/requests'); return; }
      setTicket(t);
      if (uid && t.unreadBy?.includes(uid)) {
        supabase.from('tickets').update({ unread_by: t.unreadBy.filter(id => id !== uid) }).eq('id', ticketId).then(() => {});
      }
      // Opening the ticket counts as reviewing its activity: mark this ticket's
      // in-app notifications read so the bell + sidebar bubble actually clears
      // (clearing unread_by alone left the notification rows unread).
      if (uid) {
        supabase.from('notifications')
          .update({ read_at: new Date().toISOString() })
          .eq('user_id', uid).eq('resource_id', ticketId).is('read_at', null)
          .then(() => {});
      }
      setLoading(false);
    };

    fetchTicket();
    const channel = supabase
      .channel(`ticket-detail-${ticketId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tickets', filter: `id=eq.${ticketId}` },
        () => { if (alive) fetchTicket(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [ticketId, router, activeOrgId, uid]);

  // --- 2. SAFE SCROLL ---
  useEffect(() => {
    if (chatContainerRef.current && activeTab === 'discussion') {
      const container = chatContainerRef.current;
      container.scrollTop = container.scrollHeight;
    }
  }, [ticket?.comments, activeTab]);

  // When a ticket is bounced back for revision, the reason lives in the comment
  // thread where a drafter has to hunt for it. Surface the most recent Revision
  // comment as a pinned banner so "here's what to fix" is the first thing seen.
  const latestRevision = useMemo(() => {
    if (!ticket?.comments) return null;
    for (let i = ticket.comments.length - 1; i >= 0; i--) {
      const c = ticket.comments[i] as { type?: string; text?: string; user?: string; date?: string; category?: string | null };
      if (c.type === "Revision" && c.text) return c;
    }
    return null;
  }, [ticket?.comments]);

  // --- 3. ACTIONS & HANDLERS ---

  const handleUpdateCategory = async (commentId: string) => {
    if (!ticket || !ticket.comments) return;
    
    // Create a new array with the updated comment
    const updatedComments = ticket.comments.map(c => {
      if (c.id === commentId) {
        return { ...c, category: editCategoryVal };
      }
      return c;
    });

    try {
      await supabase.from('tickets').update({ comments: updatedComments }).eq('id', ticketId);
      await logAuditAction({
        action: 'TICKET_ROOT_CAUSE_UPDATE', resourceId: ticketId, resourceType: 'ticket',
        orgId: activeOrgId || undefined, userId: uid || 'unknown', userRole: activeRole,
        details: { commentId, newCategory: editCategoryVal }
      });
      setEditingCommentId(null);
    } catch (e) {
      console.error("Failed to update category", e);
      await appAlert({ message: "Failed to update root cause.", tone: "danger" });
    }
  };

  const handleFileUpload = async (type: 'Draft' | 'Final' | 'Source' | 'Reference', fileOverride?: File) => {
    const file = fileOverride || fileToUpload;
    if (!file || !ticket) return;
    setIsUploading(true);
    try {
      if (!activeOrgId) throw new Error("No active workspace selected.");
      const result = await uploadTicketAttachment({
        file, orgId: activeOrgId, ticketId: ticket.ticketId,
        onProgress: (p) => setUploadProgress(p.percent),
      });
      const newAttachment: TicketAttachment = {
        id: crypto.randomUUID(), name: file.name, url: result.url, type,
        status: type === 'Source' ? 'submitted' : 'staged',
        size: formatBytes(file.size), uploadedBy: userEmail || 'Unknown', uploadedAt: new Date().toISOString()
      };
      const now = new Date().toISOString();
      const historyEntry = { action: 'File Uploaded', user: userEmail || 'Unknown', role: activeRole, date: now, details: `Uploaded ${type} file: ${file.name}` };
      const currentAttachments = ticket.attachments || [];
      const currentHistory = ticket.history || [];
      await supabase.from('tickets').update({
        attachments: [...currentAttachments, newAttachment],
        last_modified: now,
        history: [...currentHistory, historyEntry],
      }).eq('id', ticketId);

      await logAuditAction({
        action: 'TICKET_FILE_UPLOAD', resourceId: ticketId, resourceType: 'ticket',
        orgId: activeOrgId, userId: uid || 'unknown', userEmail: userEmail || 'unknown', userRole: activeRole,
        details: { fileName: file.name, fileType: type, fileSize: file.size }
      });

      setIsUploading(false);
      setFileToUpload(null);
      setUploadProgress(0);
    } catch (err) { console.error(err); await appAlert({ message: "Upload failed. Please try again.", tone: "danger" }); setIsUploading(false); }
  };

  const initiateWorkflowAction = async (action: WorkflowAction) => {
    if (!ticket) return;
    if (action.requiresFile) {
      const hasFiles = ticket.attachments && ticket.attachments.length > 0;
      if (!hasFiles) { await appAlert({ message: "Compliance Check Failed: You must upload at least one file before proceeding.", tone: "danger" }); return; }
    }
    
    // Open IFC Upload Modal
    if (action.action === 'submit_final') {
      setPendingAction(action);
      setShowUploadIFC(true);
    }
    // Any action that needs an engineer routed to it opens the picker first.
    // The picker collects the engineer + a comment, then calls
    // executeWorkflowAction with engineerData filled in.
    else if (action.requiresEngineerPick) {
      setPendingAction(action);
      setShowEngineerPicker(true);
    }
    else if (action.requiresComment) {
      let defaultText = '';
      if (ticket.comments && ticket.comments.length > 0) {
        const lastComment = ticket.comments[ticket.comments.length - 1];
        const now = new Date().getTime();
        const commentTime = toDate(lastComment.date).getTime();
        if (lastComment.user === userEmail && (now - commentTime) < (5 * 60 * 1000)) { defaultText = lastComment.text; }
      }
      setPreFilledComment(defaultText);
      setPendingAction(action);
      setShowCommentModal(true);
    } 
    // MERGED FLOW: Approval now directly triggers Assignment
    else if (action.action === 'assign' || action.action === 'approve_initial') { 
      // If approving, we swap the action to 'assign' so the backend logic moves it straight to DRAFTING
      const effectiveAction = action.action === 'approve_initial' 
        ? { ...action, action: 'assign', label: 'Approve & Assign' } 
        : action;
      
      setPendingAction(effectiveAction); 
      setShowAssignModal(true); 
    } 
    else { executeWorkflowAction(action); }
  };

  // Handler for IFC Upload Modal
  const handleIFCUpload = async (file: File) => {
    if (!ticket || !pendingAction) return;
    setActionLoading('submit_final');
    try {
      if (!activeOrgId) throw new Error("No active workspace selected.");
      const result = await uploadTicketAttachment({ file, orgId: activeOrgId, ticketId: ticket.ticketId });
      const finalAttachment: TicketAttachment = {
        id: crypto.randomUUID(), name: file.name, url: result.url, type: 'Final',
        status: 'submitted', size: formatBytes(file.size), uploadedBy: userEmail || 'Unknown',
        uploadedAt: new Date().toISOString()
      };
      await executeWorkflowAction(pendingAction, undefined, undefined, finalAttachment);
    } catch (err) {
      console.error(err);
      await appAlert({ message: "Failed to upload IFC package.", tone: "danger" });
      setActionLoading(null);
    }
  };

  const handleRedlineSave = async (blob: Blob) => {
    if (!ticket || !fileToRedline) return;
    // Store blob for later upload
    setPendingRedlineBlob(blob);
    setShowRedlineEditor(false);

    // Open the Rejection Modal (mocking the workflow action)
    const rejectAction: WorkflowAction = {
      label: 'Request Revision with Redlines',
      action: 'request_revision',
      variant: 'destructive',
      requiresComment: true
    };
    
    setPendingAction(rejectAction);
    setShowCommentModal(true);
  };

  const executeWorkflowAction = async (
    action: WorkflowAction,
    comment?: string,
    assignmentData?: {id: string, name: string},
    newFinalFile?: TicketAttachment,
    category?: string,
    engineerData?: {id: string, name: string, email: string}
  ) => {
    if (!ticket) return;
    setActionLoading(action.action);
    try {
      // Handle Redline Upload if pending — files upload from the client;
      // the transition itself is computed + enforced server-side.
      let finalComment = comment;
      let redlineAttachment: TicketAttachment | null = null;

      if (pendingRedlineBlob && fileToRedline) {
         if (!activeOrgId) throw new Error("No active workspace.");
         const fileName = `REDLINE_${Date.now()}_${fileToRedline.name}`;
         const redlineFile = new File([pendingRedlineBlob], fileName, { type: pendingRedlineBlob.type });
         const result = await uploadTicketAttachment({ file: redlineFile, orgId: activeOrgId, ticketId: ticket.ticketId });

         redlineAttachment = {
           id: crypto.randomUUID(),
           name: fileName,
           url: result.url,
           type: 'Reference',
           status: 'submitted',
           size: formatBytes(pendingRedlineBlob.size),
           uploadedBy: userEmail || 'Unknown',
           uploadedAt: new Date().toISOString()
         };

         // Append system note to comment
         finalComment = `${comment || ''}\n\n[System: Attached Redlines for ${fileToRedline.name}]`;

         await logAuditAction({
            action: 'TICKET_REDLINE_CREATED', resourceId: ticketId, resourceType: 'ticket',
            orgId: activeOrgId, userId: uid || 'unknown', userRole: activeRole,
            details: { originalFile: fileToRedline.name, newFile: fileName }
         });
      }

      // Server-enforced transition: /api/tickets/workflow-action validates this
      // action against the state machine for our role and the ticket's CURRENT
      // status, recomputes the update server-side, applies it compare-and-set,
      // writes the audit row, and fans out notifications + emails — none of
      // which a tampered client or a closed tab can skip.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");
      const res = await fetch('/api/tickets/workflow-action', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          ticketId,
          actionType: action.action,
          comment: finalComment || null,
          preFilledComment: preFilledComment || null,
          category: category || null,
          isReassigning,
          assignment: assignmentData || null,
          engineer: engineerData || null,
          redlineAttachment,
          finalAttachment: newFinalFile || null,
        }),
      });

      if (res.status === 409) {
        setActionLoading(null);
        setPendingAction(null);
        setShowCommentModal(false);
        setShowAssignModal(false);
        setShowUploadIFC(false);
        setPendingRedlineBlob(null);
        setFileToRedline(null);
        await appAlert({ message: "This request was just updated by someone else, so your action wasn't applied. The latest state is loading — please review the change and try again.", tone: "danger" });
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || `Workflow action failed (HTTP ${res.status})`);
      }

      // Confirm save-progress explicitly — it stages files but doesn't change
      // status, so without a message users couldn't tell it worked.
      if (action.action === 'save_progress') {
        showToast({ type: "success", title: "Progress saved", message: "Files staged. The request stays in Drafting until you submit." });
      }

      setActionLoading(null);
      setPendingAction(null);
      setShowCommentModal(false);
      setShowAssignModal(false);
      setShowUploadIFC(false);
      setPendingRedlineBlob(null); // Clear redline state
      setFileToRedline(null);
    } catch (err) { console.error(err); showToast({ type: "error", title: "Workflow action failed", message: (err as Error).message }); setActionLoading(null); }
  };

  const handlePostComment = async (text: string) => {
    if (!text.trim() || !ticket) return;

    // Optimistic update — the comment shows immediately; the server is the
    // authority. /api/tickets/comment enforces membership, posts ATOMICALLY
    // (no more lost comments when two people comment at once), and fans out
    // bell + email notifications server-side with the ?c= deep-link.
    const mentions = extractMentionUids(text);
    const optimistic = {
      id: crypto.randomUUID(),
      text,
      user: userEmail || 'Unknown',
      role: activeRole,
      date: new Date().toISOString(),
      type: 'General' as const,
      mentionedUserIds: mentions,
    } as unknown as TicketComment;
    const prevComments = ticket.comments || [];
    setTicket((prev) => prev ? { ...prev, comments: [...prevComments, optimistic] } : prev);
    setNewComment('');
    setNewCommentMentions([]);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');
      const res = await fetch('/api/tickets/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ ticketId, text }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || `Couldn't post comment (HTTP ${res.status})`);
      }
    } catch (err) {
      // Roll back the optimistic state and surface the error.
      setTicket((prev) => prev ? { ...prev, comments: prevComments } : prev);
      console.error('Failed to post comment', err);
      await appAlert({ message: err instanceof Error ? err.message : 'Couldn\'t post comment.', tone: "danger" });
    }
  };

  // Deep-link from a notification (?c=<commentId>) — jump to & highlight the
  // exact comment instead of making the user hunt for it on the ticket.
  // Fires ONCE per comment id: without the guard, every new realtime comment
  // (comments.length dep) re-scrolled the thread back to the deep-linked one,
  // fighting the user's scroll.
  const handledDeepLink = useRef<string | null>(null);
  useEffect(() => {
    const c = searchParams.get('c');
    if (!c || !ticket) return;
    if (handledDeepLink.current === c) return;
    setActiveTab('discussion');
    const timer = window.setTimeout(() => {
      const el = document.getElementById(`comment-${c}`);
      if (!el) return; // not delivered yet — retry on the next comments change
      handledDeepLink.current = c;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightCommentId(c);
      window.setTimeout(() => setHighlightCommentId(null), 3000);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchParams, ticket]);

  // Edit / delete a comment — server-enforced (author or Admin), and the
  // server keeps the ticket_comments table in lockstep with the JSONB.
  // Optimistic UI with rollback, same as posting.
  const callCommentApi = async (method: 'PATCH' | 'DELETE', payload: Record<string, unknown>) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Not authenticated');
    const res = await fetch('/api/tickets/comment', {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error((j as { error?: string }).error || `Request failed (HTTP ${res.status})`);
    }
  };

  const handleSaveCommentEdit = async (commentId: string) => {
    if (!ticket) return;
    const prevComments = ticket.comments || [];
    const next = prevComments.map((c) =>
      c.id === commentId
        ? { ...c, text: editTextDraft, editedAt: new Date().toISOString() } as TicketComment & { editedAt?: string }
        : c
    );
    setTicket((prev) => prev ? { ...prev, comments: next } : prev);
    setEditingTextId(null);
    const draft = editTextDraft;
    setEditTextDraft('');
    try {
      await callCommentApi('PATCH', { ticketId, commentId, text: draft });
    } catch (err) {
      setTicket((prev) => prev ? { ...prev, comments: prevComments } : prev);
      await appAlert({ message: `Couldn't save edit: ${err instanceof Error ? err.message : String(err)}`, tone: "danger" });
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!ticket) return;
    const prevComments = ticket.comments || [];
    setTicket((prev) => prev ? { ...prev, comments: prevComments.filter((c) => c.id !== commentId) } : prev);
    try {
      await callCommentApi('DELETE', { ticketId, commentId });
    } catch (err) {
      setTicket((prev) => prev ? { ...prev, comments: prevComments } : prev);
      await appAlert({ message: `Couldn't delete: ${err instanceof Error ? err.message : String(err)}`, tone: "danger" });
    }
  };

  const toggleWatch = async () => {
    if (!ticket || !uid) return;
    const current = ticket.watchers ?? [];
    const next = current.includes(uid)
      ? current.filter((w) => w !== uid)
      : [...current, uid];
    await supabase.from("tickets").update({ watchers: next }).eq("id", ticketId);
  };

  const getStatusStyle = (status: TicketStatus) => {
    switch (status) {
      case 'DRAFTING': return 'bg-blue-100 text-blue-800 border-blue-200'; 
      case 'PENDING_IFC': return 'bg-teal-100 text-teal-800 border-teal-200';
      case 'REVISION_REQ': return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'PENDING_ASSIGNMENT': return 'bg-purple-100 text-purple-800 border-purple-200';
      default: return 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]';
    }
  };

  if (loading || !ticket) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-4">
        <Loader2 className="w-16 h-16 animate-spin text-orange-600" />
        <div className="flex flex-col items-center"><h2 className="text-xl font-bold text-[var(--color-text)]">Loading Ticket Details...</h2><p className="text-[var(--color-text-muted)] text-sm">Retrieving latest workflow state and assets.</p></div>
      </div>
    );
  }

  const availableActions = WorkflowEngine.getActions(ticket, activeRole, uid ?? undefined);
  const sourceFiles = ticket.attachments?.filter(a => a.type === 'Source' || a.type === 'Reference') || [];
  
  // LOGIC: DRAFTS SORTING & VERSIONING
  const draftFilesRaw = ticket.attachments?.filter(a => a.type === 'Draft') || [];
  const sortedDrafts = draftFilesRaw.sort((a, b) => toDate(b.uploadedAt).getTime() - toDate(a.uploadedAt).getTime());
  
  const latestDraft = sortedDrafts[0];
  const previousDrafts = sortedDrafts.slice(1);

  const finalFiles = ticket.attachments?.filter(a => a.type === 'Final') || [];

  // LOGIC: Check for Staged Files
  const hasStagedFiles = ticket.attachments?.some(a => a.status === 'staged' && a.type === 'Draft');

  return (
    <div className="pb-20">

      {/* MODALS */}
      {showRedlineEditor && fileToRedline && (
        <RedlineEditorMount
          file={fileToRedline}
          onClose={() => setShowRedlineEditor(false)}
          onSave={handleRedlineSave}
          isSaving={isUploading}
        />
      )}
      <FileViewerModal
        isOpen={!!viewerFile}
        file={viewerFile}
        onClose={() => setViewerFile(null)}
        ticketId={ticket?.ticketId}
        orgId={activeOrgId ?? undefined}
        userId={uid ?? undefined}
        onApprove={(() => {
          const action = availableActions.find(a => a.action === 'approve_draft_ifc');
          return action ? () => { setViewerFile(null); initiateWorkflowAction(action); } : undefined;
        })()}
      />
      <ActionModal 
        isOpen={showCommentModal} 
        onClose={() => setShowCommentModal(false)} 
        title={pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject' ? 'Request Revision' : pendingAction?.variant === 'destructive' ? 'Reject & Return' : 'Workflow Comment'} 
        description={pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject' ? 'Please provide feedback on what needs to be revised.' : pendingAction?.variant === 'destructive' ? 'Please explain why this request is being returned or rejected.' : 'Add an optional comment to this action.'} 
        isDestructive={pendingAction?.variant === 'destructive' || pendingAction?.action === 'request_revision'} 
        showCategorySelection={pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject'}
        onSubmit={(comment, category) => pendingAction && executeWorkflowAction(pendingAction, comment, undefined, undefined, category)}
        isLoading={!!actionLoading} 
        defaultValue={preFilledComment}
        onRedline={
          (pendingAction?.action === 'reject' || pendingAction?.action === 'request_revision') && sortedDrafts.length > 0 
          ? async () => {
              if (sortedDrafts.length === 1) {
                setFileToRedline(sortedDrafts[0]);
                setShowRedlineEditor(true);
                setShowCommentModal(false);
              } else {
                if (await appConfirm({ message: `Start redlining the latest draft: ${sortedDrafts[0].name}?` })) {
                   setFileToRedline(sortedDrafts[0]);
                   setShowRedlineEditor(true);
                   setShowCommentModal(false);
                }
              }
            }
          : undefined
        }
      />
      <AssignmentModal isOpen={showAssignModal} onClose={() => { setShowAssignModal(false); setIsReassigning(false); }} onSubmit={(id, name, reason) => pendingAction && executeWorkflowAction(pendingAction, reason, {id, name})} isLoading={!!actionLoading} activeOrgId={activeOrgId} isReassignment={isReassigning} />
      <UploadIFCModal isOpen={showUploadIFC} onClose={() => setShowUploadIFC(false)} onSubmit={handleIFCUpload} isLoading={!!actionLoading} />

      {showWorkflowDiagram && (
        <WorkflowDiagramModal current={ticket.status} onClose={() => setShowWorkflowDiagram(false)} />
      )}

      {showEngineerPicker && pendingAction && activeOrgId && (
        <EngineerPickerModal
          isOpen={showEngineerPicker}
          onClose={() => { setShowEngineerPicker(false); setPendingAction(null); }}
          orgId={activeOrgId}
          currentEngineerId={pendingAction.action === 'reassign_engineer' ? ticket?.assignedEngineerId ?? undefined : undefined}
          title={
            pendingAction.action === 'request_final_engineer_approval' ? 'Send for Engineer Final Approval' :
            pendingAction.action === 'reassign_engineer' ? 'Reassign Engineer Reviewer' :
            'Flag for Engineering Review'
          }
          description={
            pendingAction.action === 'request_final_engineer_approval'
              ? 'Engineering policy: drawings need an engineer sign-off before IFC. The engineer you pick will get a notification and review the draft.'
              : pendingAction.action === 'reassign_engineer'
                ? 'Pick a different engineer to take over the final approval review.'
                : 'Route this ticket to a specific engineer for a scope review.'
          }
          commentLabel={pendingAction.action === 'request_final_engineer_approval' ? 'Note to the engineer *' : 'What needs to be reviewed? *'}
          commentPlaceholder={
            pendingAction.action === 'request_final_engineer_approval'
              ? "e.g. Please confirm orifice plate sizing on FE-201 is correct for the new flow conditions."
              : "What specifically should they look at?"
          }
          onSubmit={async ({ engineerId, engineerName, engineerEmail, comment }) => {
            if (!pendingAction) return;
            await executeWorkflowAction(
              pendingAction,
              comment,
              undefined,
              undefined,
              undefined,
              { id: engineerId, name: engineerName, email: engineerEmail }
            );
          }}
        />
      )}

      {/* HEADER */}
      <div className="bg-[var(--color-surface)] border-b border-[var(--color-border)] sticky top-0 z-20 shadow-sm px-4 sm:px-6 lg:px-8 py-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 max-w-[1920px] mx-auto">
          <div className="flex items-center gap-4">
            <button onClick={() => router.back()} className="p-2 hover:bg-[var(--color-surface-2)] rounded-full text-[var(--color-text-muted)] transition-colors"><ArrowLeft className="w-5 h-5" /></button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold text-[var(--color-text)] tracking-tight">{ticket.ticketId}</h1>
                <button
                  type="button"
                  onClick={() => setShowWorkflowDiagram(true)}
                  title="See where this request is in the workflow"
                  className={`px-3 py-1 rounded-full text-xs font-bold border uppercase tracking-wider inline-flex items-center gap-1.5 hover:brightness-95 transition ${getStatusStyle(ticket.status)}`}
                >
                  {ticket.status.replace(/_/g, ' ')}
                  <HelpCircle className="w-3 h-3 opacity-70" />
                </button>
                {typeof ticket.priority === 'number' && (
                  <span className={`px-2 py-0.5 text-[10px] font-bold rounded border flex items-center
                    ${ticket.priority === 1 ? 'text-red-700 bg-red-100 border-red-200' : 
                      ticket.priority === 2 ? 'text-orange-700 bg-orange-100 border-orange-200' :
                      ticket.priority === 3 ? 'text-blue-700 bg-blue-100 border-blue-200' :
                      'text-[var(--color-text)] bg-[var(--color-surface-2)] border-[var(--color-border)]'
                    }`}>
                    {ticket.priority === 1 && <AlertCircle className="w-3 h-3 mr-1" />}
                    {ticket.priority === 2 && <TrendingUp className="w-3 h-3 mr-1" />}
                    {ticket.priority >= 3 && <Flag className="w-3 h-3 mr-1" />}
                    P{ticket.priority}
                  </span>
                )}
                {/* Dynamically checking if requestType matches any known flag type would require config, but keeping RFI hardcheck for now as it's likely standard */}
                {ticket.requestType === 'RFI' && <span className="px-2 py-0.5 bg-pink-100 text-pink-700 text-[10px] font-bold rounded border border-pink-200 flex items-center"><Flag className="w-3 h-3 mr-1" /> RFI</span>}
              </div>
              <p className="text-sm text-[var(--color-text-muted)] mt-1 font-medium">{ticket.title}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            {(activeRole === 'Drafter' || activeRole === 'Requester' || activeRole === 'Admin' || uid === ticket.requesterId) && (
              <>
                <label className={`cursor-pointer px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all flex items-center bg-[var(--color-surface)] border-2 border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                  {isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UploadCloud className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" />} 
                  {isUploading ? `Uploading ${uploadProgress.toFixed(0)}%` : 'Add New File'}
                  <input 
                    type="file" 
                    className="hidden" 
                    onChange={(e) => { 
                      const file = e.target.files?.[0];
                      if (file) {
                        const isPrivileged = activeRole === 'Drafter' || activeRole === 'Admin';
                        if (!isPrivileged) {
                          handleFileUpload('Source', file);
                        } else {
                          setFileToUpload(file); 
                        }
                      }
                    }} 
                  />
                </label>

                {fileToUpload && !isUploading && (
                  <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-[var(--color-surface)] p-6 rounded-2xl shadow-2xl max-w-sm w-full animate-in fade-in zoom-in-95 border border-[var(--color-border)]">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="font-bold text-lg text-[var(--color-text)]">Classify Upload</h3>
                        <button onClick={() => setFileToUpload(null)} className="p-1 hover:bg-[var(--color-surface-2)] rounded-full transition-colors"><X className="w-5 h-5 text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]"/></button>
                      </div>
                      <div className="p-3 bg-[var(--color-surface-2)] rounded-lg mb-6 border border-[var(--color-border)] flex items-center">
                        <FileIcon className="w-8 h-8 text-blue-500 mr-3" />
                        <div className="overflow-hidden">
                          <p className="font-bold text-sm truncate text-[var(--color-text)]">{fileToUpload.name}</p>
                          <p className="text-xs text-[var(--color-text-muted)]">{formatBytes(fileToUpload.size)}</p>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <p className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-widest mb-1">Select File Category</p>
                        <button onClick={() => handleFileUpload('Source')} className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition-colors flex items-center justify-center shadow-md shadow-blue-900/10">
                          <FileIcon className="w-4 h-4 mr-2"/> Source Asset
                        </button>
                        <button onClick={() => handleFileUpload('Draft')} className="w-full py-3 bg-orange-600 text-white rounded-lg font-bold hover:bg-orange-700 transition-colors flex items-center justify-center shadow-md shadow-orange-900/10">
                          <FileText className="w-4 h-4 mr-2"/> Draft Drawing
                        </button>
                        <button onClick={() => handleFileUpload('Reference')} className="w-full py-3 bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] rounded-lg font-bold hover:bg-[var(--color-surface-2)] transition-colors flex items-center justify-center">
                          Supporting Doc / Reference
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {isAdmin && ticket.assignedDrafterId && ticket.status !== 'CLOSED' && (
              <button 
                onClick={handleReassignClick}
                className="px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all flex items-center bg-[var(--color-surface)] border-2 border-orange-200 text-orange-700 hover:bg-orange-50 hover:border-orange-300"
              >
                <UserPlus className="w-4 h-4 mr-2" /> Reassign
              </button>
            )}
            {availableActions.length === 0 ? (
               <div className="flex items-center px-4 py-2 bg-[var(--color-surface-2)] rounded-lg border border-[var(--color-border)] text-xs font-medium text-[var(--color-text-faint)] italic"><ShieldAlert className="w-4 h-4 mr-2" /> View Only - No Actions Available</div>
            ) : (
              availableActions.map((action, idx) => (
                <button 
                  key={idx} 
                  onClick={() => initiateWorkflowAction(action)} 
                  disabled={!!actionLoading} 
                  className={`
                    px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all flex items-center relative overflow-hidden group disabled:opacity-50 disabled:cursor-not-allowed
                    ${action.variant === 'success' ? 'bg-green-600 text-white hover:bg-green-700' : 
                      action.variant === 'destructive' ? 'bg-red-600 text-white hover:bg-red-700' : 
                      action.variant === 'outline' ? 'bg-[var(--color-surface)] border-2 border-[var(--color-border-strong)] text-[var(--color-text)] hover:border-slate-400 hover:bg-[var(--color-surface-2)]' : 
                      action.variant === 'warning' ? 'bg-amber-500 text-white hover:bg-amber-600' : 
                      'bg-slate-900 text-white hover:bg-slate-800'}
                    ${action.action === 'submit_draft' && hasStagedFiles ? 'ring-4 ring-orange-400/50 animate-pulse' : ''}
                  `}
                >
                  {actionLoading === action.action ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : action.action === 'save_progress' ? <Save className="w-4 h-4 mr-2" /> : action.action === 'submit_draft' ? <Send className="w-4 h-4 mr-2" /> : action.action === 'assign' ? <UserPlus className="w-4 h-4 mr-2" /> : action.action === 'submit_final' ? <FileCheck className="w-4 h-4 mr-2" /> : null}
                  {action.label}
                  {action.action === 'submit_draft' && hasStagedFiles && (
                    <span className="absolute top-0 right-0 w-3 h-3 bg-orange-500 rounded-full border-2 border-white translate-x-1 -translate-y-1"></span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* NOTIFICATION: Staged Files Warning */}
      {hasStagedFiles && (
        <div className="bg-orange-600 text-white px-4 py-3 shadow-md relative z-10 animate-in slide-in-from-top-2">
          <div className="max-w-[1920px] mx-auto flex items-center justify-between px-4 sm:px-6 lg:px-8">
             <div className="flex items-center">
               <AlertTriangle className="w-5 h-5 mr-3 animate-bounce" />
               <p className="text-sm font-bold">You have unsubmitted drafts. Please click &ldquo;Submit Draft for Review&rdquo; to notify the requester.</p>
             </div>
             <button 
               onClick={() => {
                 const submitAction = availableActions.find(a => a.action === 'submit_draft');
                 if (submitAction) initiateWorkflowAction(submitAction);
               }}
               className="px-4 py-1 bg-[var(--color-surface)] text-orange-600 text-xs font-bold rounded hover:bg-orange-50 transition-colors shadow-sm"
             >
               Submit Now
             </button>
          </div>
        </div>
      )}

      {ticket.status === 'REVISION_REQ' && latestRevision && (
        <div className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 pt-6">
          <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 flex items-start gap-3">
            <RotateCcw className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-black text-amber-900">Revision requested — here&apos;s what to fix</h3>
                {latestRevision.category && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 text-[10px] font-bold uppercase tracking-wider">{latestRevision.category}</span>
                )}
              </div>
              <p className="text-sm text-amber-900 mt-1 whitespace-pre-wrap leading-relaxed">{latestRevision.text}</p>
              <p className="text-[11px] text-amber-700 mt-1.5">
                {latestRevision.user ?? 'Reviewer'}{latestRevision.date ? ` · ${new Date(latestRevision.date).toLocaleString()}` : ''}
              </p>
              {(() => {
                // Surface redline markups attached with the revision so the
                // drafter finds them here instead of hunting the references list.
                const redlines = (ticket.attachments || [])
                  .filter((a) => a.name?.startsWith('REDLINE_'))
                  .sort((a, b) => toDate(b.uploadedAt).getTime() - toDate(a.uploadedAt).getTime());
                return redlines[0] ? (
                  <button
                    onClick={() => setViewerFile(redlines[0])}
                    className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-sm"
                  >
                    <Pen className="w-3.5 h-3.5" /> View redline markups
                  </button>
                ) : null;
              })()}
            </div>
          </div>
        </div>
      )}

      {ticket.archivedAt && (() => {
        const sum = (ticket.metadata?.archive_summary ?? {}) as {
          commentCount?: number; attachmentCount?: number; attachmentNames?: string[]; historyCount?: number;
        };
        const names = Array.isArray(sum.attachmentNames) ? sum.attachmentNames : [];
        const plural = (n: number | undefined, w: string) => `${n ?? 0} ${w}${(n ?? 0) === 1 ? '' : 's'}`;
        const hasShape = !!(sum.commentCount || sum.attachmentCount || sum.historyCount);
        return (
          <div className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 pt-6">
            <div className="rounded-xl border-2 border-sky-300 bg-sky-50 p-4 flex items-start gap-3">
              <Archive className="w-5 h-5 text-sky-600 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h3 className="text-sm font-black text-sky-900">It&apos;s not gone — just archived because it&apos;s old</h3>
                <p className="text-sm text-sky-900 mt-1 leading-relaxed">
                  Because this ticket has been closed a while, its full content was moved to the offline archive{' '}
                  {ticket.archiveId ? <span className="font-mono font-bold">{ticket.archiveId}</span> : 'a backup'} to save storage. What you see here is a lightweight stub.
                </p>
                {hasShape && (
                  <p className="text-[13px] text-sky-800 mt-2">
                    <span className="font-bold">What was here:</span>{' '}
                    {plural(sum.commentCount, 'comment')}, {plural(sum.attachmentCount, 'attachment')}
                    {names.length > 0 && <> (<span className="italic">{names.join(', ')}</span>)</>}, {plural(sum.historyCount, 'history event')}.
                  </p>
                )}
                <p className="text-[13px] text-sky-800 mt-2">
                  <span className="font-bold">To view it all again:</span> an admin can restore it in one click from{' '}
                  {ticket.archiveId ? <span className="font-mono break-all">&lt;root&gt;/data/{ticket.archiveId}.zip</span> : 'the saved archive'} on the Storage &amp; Backup page.
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="max-w-[1920px] mx-auto p-4 sm:p-6 lg:p-8 grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* LEFT: DETAILS & FILES */}
        <div className="xl:col-span-2 space-y-8">
          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-6 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-orange-500" />
            <div className="flex items-center justify-between mb-6 border-b border-[var(--color-border)] pb-4"><h2 className="text-sm font-bold text-[var(--color-text)] uppercase tracking-wide flex items-center"><FileText className="w-4 h-4 mr-2 text-orange-500" /> Project Specifications</h2><span className="text-xs text-[var(--color-text-faint)] font-mono">ID: {ticket.id}</span></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
              <div><label className="text-[10px] text-[var(--color-text-faint)] font-bold uppercase tracking-wider">Unit</label><div className="font-mono text-sm font-bold text-[var(--color-text)] bg-[var(--color-surface-2)] px-2 py-1 rounded w-fit mt-1 border border-[var(--color-border)]">{ticket.unit}</div></div>
              <div><label className="text-[10px] text-[var(--color-text-faint)] font-bold uppercase tracking-wider">Requester</label><div className="min-w-0 text-sm font-semibold text-[var(--color-text)] mt-1 flex items-center group cursor-help" title={ticket.requesterId}><User className="w-4 h-4 mr-2 text-slate-300 group-hover:text-orange-500 transition-colors shrink-0" /><span className="truncate">{ticket.requesterName}</span></div></div>
              <div><label className="text-[10px] text-[var(--color-text-faint)] font-bold uppercase tracking-wider">Assigned Lead</label><div className="min-w-0 text-sm font-semibold text-[var(--color-text)] mt-1">{ticket.assignedDrafterName ? (<div className="flex items-center text-orange-700"><div className="w-2 h-2 rounded-full bg-green-500 mr-2 shrink-0" /><span className="truncate">{ticket.assignedDrafterName}</span></div>) : <span className="text-[var(--color-text-faint)] italic">Unassigned</span>}</div></div>
              <div>
                <label className="text-[10px] text-[var(--color-text-faint)] font-bold uppercase tracking-wider">Engineer Reviewer</label>
                <div className="min-w-0 text-sm font-semibold text-[var(--color-text)] mt-1">
                  {ticket.assignedEngineerName ? (
                    <div className="flex items-center text-blue-700">
                      <div className={`w-2 h-2 rounded-full mr-2 shrink-0 ${ticket.engineerApprovedAt ? "bg-emerald-500" : "bg-blue-500 animate-pulse"}`} />
                      <span className="truncate" title={ticket.assignedEngineerEmail || ticket.assignedEngineerName}>{ticket.assignedEngineerName}</span>
                      {ticket.engineerApprovedAt && <span className="ml-2 text-[10px] text-emerald-600 font-bold uppercase">approved</span>}
                    </div>
                  ) : <span className="text-[var(--color-text-faint)] italic">Not yet assigned</span>}
                </div>
              </div>
              <div><label className="text-[10px] text-[var(--color-text-faint)] font-bold uppercase tracking-wider">Initiated</label><div className="text-sm font-semibold text-[var(--color-text)] mt-1 flex items-center"><Calendar className="w-4 h-4 mr-2 text-slate-300 shrink-0" />{toDate(ticket.createdAt).toLocaleDateString()}</div></div>
              <div>
                <label className="text-[10px] text-[var(--color-text-faint)] font-bold uppercase tracking-wider">Target Completion</label>
                <div className="text-sm font-semibold mt-1 flex items-center gap-1.5">
                  {ticket.targetCompletionAt ? (
                    <>
                      <Calendar className={`w-4 h-4 shrink-0 ${isPastDue(ticket) ? "text-red-500" : isNearingDue(ticket) ? "text-amber-500" : "text-slate-300"}`} />
                      <span className={isPastDue(ticket) ? "text-red-700" : "text-[var(--color-text)]"}>{toDate(ticket.targetCompletionAt).toLocaleDateString()}</span>
                      {isPastDue(ticket) && <span className="text-[9px] font-black uppercase bg-red-100 text-red-700 px-1.5 py-0.5 rounded">Past Due</span>}
                      {!isPastDue(ticket) && isNearingDue(ticket) && <span className="text-[9px] font-black uppercase bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Due Soon</span>}
                    </>
                  ) : (
                    <span className="text-[var(--color-text-faint)] italic text-xs">No target set</span>
                  )}
                </div>
              </div>
              <div>
                <label className="text-[10px] text-[var(--color-text-faint)] font-bold uppercase tracking-wider">Watching</label>
                <div className="text-sm font-semibold mt-1 flex items-center gap-2">
                  <button
                    onClick={toggleWatch}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold transition-colors ${
                      (ticket.watchers ?? []).includes(uid ?? "")
                        ? "bg-orange-50 border-orange-200 text-orange-700"
                        : "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"
                    }`}
                  >
                    {(ticket.watchers ?? []).includes(uid ?? "") ? "Watching" : "Watch"}
                  </button>
                  <span className="text-[10px] text-[var(--color-text-faint)]">{(ticket.watchers ?? []).length} subscriber{(ticket.watchers ?? []).length === 1 ? "" : "s"}</span>
                </div>
              </div>
            </div>
            <div className="mt-6 pt-6 border-t border-[var(--color-border)]"><label className="text-[10px] text-[var(--color-text-faint)] font-bold uppercase tracking-wider mb-2 block">Scope of Work</label><div className="bg-[var(--color-surface-2)] rounded-lg p-4 text-sm text-[var(--color-text)] leading-relaxed border border-[var(--color-border)] shadow-inner">{ticket.description}</div></div>
          </div>

          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden flex flex-col">
             <div className="px-6 py-4 border-b border-[var(--color-border)] bg-slate-50/50 flex flex-col sm:flex-row justify-between items-center gap-4">
               <div><h2 className="text-sm font-bold text-[var(--color-text)] uppercase tracking-wide flex items-center"><Paperclip className="w-4 h-4 mr-2 text-orange-500" /> Project Assets</h2></div>
             </div>

             <div className="p-4 bg-slate-50/50 border-b border-[var(--color-border)] order-1">
               <h3 className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-widest mb-3">Incoming Assets (Source)</h3>
               <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                 {sourceFiles.length === 0 ? <p className="text-xs text-[var(--color-text-faint)] italic pl-2">No source files provided.</p> : sourceFiles.map((file, idx) => (
                   <div key={idx} className="flex items-center justify-between bg-[var(--color-surface)] p-2.5 rounded-lg border border-[var(--color-border)] shadow-sm hover:border-[var(--color-border-strong)]">
                     <div className="flex items-center space-x-3 overflow-hidden"><div className="p-1.5 bg-[var(--color-surface-2)] rounded text-[var(--color-text-muted)]"><FileIcon className="w-4 h-4" /></div><span className="text-xs font-bold text-[var(--color-text)] truncate">{file.name}</span></div>
                     <button onClick={() => setViewerFile(file)} className="text-[var(--color-text-faint)] hover:text-blue-600"><Eye className="w-4 h-4" /></button>
                   </div>
                 ))}
               </div>
             </div>

             <div className={`p-4 border-b border-[var(--color-border)] ${['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) ? 'order-3 opacity-60 grayscale-[0.5]' : 'order-2'}`}>
               <h3 className="text-[10px] font-bold text-orange-600 uppercase tracking-widest mb-3 flex items-center"><Loader2 className="w-3 h-3 mr-1 animate-spin-slow" /> Work In Progress (Drafts)</h3>
               <div className="space-y-4">
                 {sortedDrafts.length === 0 ? <p className="text-xs text-[var(--color-text-faint)] italic pl-2">No drafts started yet.</p> : (
                    <>
                      {/* LATEST DRAFT */}
                      {latestDraft && (
                         <div className="bg-orange-50/50 border border-orange-200 rounded-lg p-4 shadow-sm relative overflow-hidden group">
                           <div className="absolute top-0 right-0 bg-orange-500 text-white text-[9px] font-bold px-2 py-0.5 rounded-bl-lg uppercase tracking-wider">Latest Revision</div>
                           <div className="flex items-center justify-between relative z-10">
                              <div className="flex items-center space-x-4 min-w-0">
                                <div className="p-2.5 bg-orange-100 text-orange-600 rounded-lg">
                                  <FileText className="w-6 h-6" />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-bold text-[var(--color-text)] truncate hover:text-orange-700 transition-colors cursor-pointer" onClick={() => setViewerFile(latestDraft)}>{latestDraft.name}</p>
                                  <div className="flex items-center text-xs text-[var(--color-text-muted)] mt-0.5 space-x-2">
                                     <span>{latestDraft.size}</span>
                                     <span className="w-1 h-1 rounded-full bg-slate-300"/>
                                     <span>{toDate(latestDraft.uploadedAt).toLocaleString()}</span>
                                     <span className="w-1 h-1 rounded-full bg-slate-300"/>
                                     <span className="text-orange-600 font-medium">Current Version</span>
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center space-x-2">
                                {(ticket.status === 'PENDING_REVIEW' && ticket.requesterId === uid) && (
                                   <button 
                                     onClick={() => { setFileToRedline(latestDraft); setShowRedlineEditor(true); }}
                                     className="px-3 py-1.5 rounded-lg font-bold text-xs flex items-center bg-[var(--color-surface)] border border-orange-200 text-orange-600 hover:bg-orange-600 hover:text-white transition-all shadow-sm"
                                   >
                                     <Pen className="w-3 h-3 mr-1.5"/> Redline
                                   </button>
                                )}
                                <button onClick={() => setViewerFile(latestDraft)} className="p-2 text-[var(--color-text-faint)] hover:text-orange-600 hover:bg-orange-100 rounded-lg transition-colors"><Eye className="w-5 h-5" /></button>
                              </div>
                           </div>
                         </div>
                      )}

                      {/* PREVIOUS VERSIONS */}
                      {previousDrafts.length > 0 && (
                        <div className="space-y-3 pt-2">
                          <div className="flex items-center gap-3">
                            <div className="h-px bg-slate-200 flex-1"/>
                            <span className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-widest">Previous Versions</span>
                            <div className="h-px bg-slate-200 flex-1"/>
                          </div>
                          <div className="grid grid-cols-1 gap-2">
                            {previousDrafts.map((file, idx) => (
                              <div key={idx} className="flex items-center justify-between bg-[var(--color-surface)] p-2.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-faint)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-muted)] transition-all opacity-80 hover:opacity-100">
                                 <div className="flex items-center space-x-3 min-w-0">
                                   <FileIcon className="w-4 h-4 shrink-0" />
                                   <div className="min-w-0">
                                      <p className="text-xs font-medium truncate decoration-slate-300">{file.name}</p>
                                      <p className="text-xs opacity-70">{toDate(file.uploadedAt).toLocaleString()}</p>
                                   </div>
                                 </div>
                                 <button onClick={() => setViewerFile(file)} className="p-1.5 hover:bg-[var(--color-surface-2)] rounded"><Eye className="w-3.5 h-3.5" /></button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                 )}
               </div>
             </div>

             <div className={`p-4 ${['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) ? 'bg-teal-50 order-2 border-b border-teal-100 shadow-sm relative overflow-hidden' : 'bg-teal-50/30 order-3'}`}>
               <h3 className={`text-[10px] font-bold uppercase tracking-widest mb-3 flex items-center ${['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) ? 'text-teal-800' : 'text-teal-700'}`}><CheckCircle2 className="w-3 h-3 mr-1" /> Final Issued Deliverables</h3>
               <div className="space-y-2 relative z-10">
                 {finalFiles.length === 0 ? <div className="text-center py-6 text-[var(--color-text-faint)] text-xs border-2 border-dashed border-[var(--color-border)] rounded-lg">Nothing issued for construction yet.</div> : finalFiles.map((file, idx) => (
                   <div key={idx} className={`flex items-center justify-between bg-[var(--color-surface)] p-3 rounded-lg border shadow-sm ${['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) ? 'border-teal-300 ring-1 ring-teal-100' : 'border-teal-200'}`}>
                     <div className="flex items-center space-x-4 min-w-0">
                       <div className="p-2 bg-teal-100 text-teal-700 rounded"><CheckSquare className="w-5 h-5" /></div>
                       <div className="min-w-0">
                         <p className="text-sm font-bold text-[var(--color-text)] truncate">{file.name}</p>
                         <p className="text-xs text-teal-600 font-semibold">ISSUED: {toDate(file.uploadedAt).toLocaleDateString()}</p>
                         {['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) && <span className="inline-block mt-1 px-2 py-0.5 bg-teal-600 text-white text-[9px] font-bold rounded uppercase tracking-wider shadow-sm">Issued For Construction</span>}
                       </div>
                     </div>
                     <button onClick={() => setViewerFile(file)} className="p-2 text-[var(--color-text-faint)] hover:text-teal-600 hover:bg-teal-50 rounded"><Maximize2 className="w-4 h-4" /></button>
                   </div>
                 ))}
               </div>
             </div>
          </div>

          {/* Formal approvals / e-signatures */}
          {ticket.id && (
            <SignaturePanel
              resourceType="ticket"
              resourceId={ticket.id}
              resourceLabel={`request ${ticket.ticketId}`}
              canSign={activeRole === 'Admin' || activeRole === 'DocCtrl' || (activeRole?.includes('Engineer') ?? false)}
            />
          )}
        </div>

        {/* RIGHT: ACTIVITY */}
        <div className="h-[calc(100vh-140px)] flex flex-col bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden sticky top-24">
          <div className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-surface-2)]"><button onClick={() => setActiveTab('discussion')} className={`flex-1 py-3 text-xs font-bold transition-all ${activeTab === 'discussion' ? 'text-[var(--color-text)] border-b-2 border-orange-500 bg-[var(--color-surface)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-slate-100/50'}`}>Discussion</button><button onClick={() => setActiveTab('audit')} className={`flex-1 py-3 text-xs font-bold transition-all ${activeTab === 'audit' ? 'text-[var(--color-text)] border-b-2 border-orange-500 bg-[var(--color-surface)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-slate-100/50'}`}>Audit Log</button></div>
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 space-y-6 bg-slate-50/30 custom-scrollbar relative">
            {activeTab === 'discussion' && (
              <>
                {(!ticket.comments || ticket.comments.length === 0) && <div className="absolute inset-0 flex flex-col items-center justify-center opacity-40 pointer-events-none"><MessageSquare className="w-12 h-12 text-slate-300 mb-2" /><p className="text-sm text-[var(--color-text-faint)] font-medium">No comments yet</p></div>}
                {ticket.comments?.map((comment, idx) => (
                  <div key={`${comment.id}-${idx}`} id={`comment-${comment.id}`} className={`flex flex-col ${comment.user === userEmail ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2 ${highlightCommentId === comment.id ? 'rounded-2xl ring-2 ring-orange-400 ring-offset-2 transition-shadow' : ''}`}>
                    <div className="flex items-end gap-2 max-w-[90%]">
                       {comment.user !== userEmail && <div className={`w-6 h-6 rounded-full ${AUTHOR_AVATAR_PALETTE[authorColorIndex(comment.user)]} flex items-center justify-center text-[10px] font-bold shrink-0 mb-1`}>{comment.user.charAt(0).toUpperCase()}</div>}
                       <div className={`rounded-2xl p-3.5 shadow-sm text-sm relative group ${comment.type === 'Rejection' || comment.type === 'Revision' ? 'bg-amber-50 border border-amber-200 text-amber-900 rounded-bl-none' : comment.type === 'Approval' ? 'bg-green-50 border border-green-100 text-green-900 rounded-bl-none' : comment.user === userEmail ? 'bg-blue-600 text-white rounded-br-none shadow-blue-900/10' : `${AUTHOR_BUBBLE_PALETTE[authorColorIndex(comment.user)]} rounded-bl-none`}`}>
                          {comment.user !== userEmail && comment.type === 'General' && (
                            <div className="text-[10px] font-black uppercase tracking-wider mb-1 opacity-60">{authorLabel(comment.user)}</div>
                          )}
                          
                          {/* HEADER: Type & Category */}
                          {comment.type !== 'General' && (
                            <div className={`text-[10px] font-bold uppercase mb-1.5 flex items-center justify-between ${comment.user === userEmail ? 'opacity-80' : 'opacity-60'} ${comment.type === 'Reassignment' ? 'text-orange-600 border-b border-orange-100 pb-1 italic' : ''}`}>
                              <div className="flex items-center">
                                {comment.type === 'Rejection' || comment.type === 'Revision' ? <AlertTriangle className="w-3 h-3 mr-1" /> : 
                                 comment.type === 'Reassignment' ? <UserPlus className="w-3 h-3 mr-1" /> :
                                 <CheckCircle2 className="w-3 h-3 mr-1" />}
                                
                                {comment.type === 'Rejection' || comment.type === 'Revision' ? 'Revision Requested' : 
                                 comment.type === 'Reassignment' ? 'Reassigned' : 
                                 comment.type}
                              </div>
                              
                              {/* ADMIN OVERRIDE CONTROLS */}
                              {(comment.type === 'Rejection' || comment.type === 'Revision') && (
                                <div className="ml-2">
                                  {editingCommentId === comment.id ? (
                                    <div className="flex items-center space-x-1" onClick={(e) => e.stopPropagation()}>
                                       <select 
                                         value={editCategoryVal} 
                                         onChange={(e) => setEditCategoryVal(e.target.value)}
                                         className="text-[10px] p-1 rounded border border-[var(--color-border-strong)] text-[var(--color-text)] bg-[var(--color-surface)] focus:ring-1 focus:ring-orange-500"
                                       >
                                         {REVISION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                                       </select>
                                       <button onClick={() => handleUpdateCategory(comment.id)} className="p-1 bg-green-500 text-white rounded hover:bg-green-600"><Check className="w-3 h-3" /></button>
                                       <button onClick={() => setEditingCommentId(null)} className="p-1 bg-slate-300 text-[var(--color-text-muted)] rounded hover:bg-slate-400"><X className="w-3 h-3" /></button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center">
                                      <span className="bg-white/50 px-1.5 py-0.5 rounded text-[9px] border border-black/10 mr-1">
                                        {comment.category || 'Uncategorized'}
                                      </span>
                                      {isAdmin && (
                                        <button 
                                          onClick={() => { setEditingCommentId(comment.id); setEditCategoryVal(comment.category || REVISION_REASONS[0]); }} 
                                          className="p-1 hover:bg-black/10 rounded transition-colors"
                                          title="Edit Root Cause"
                                        >
                                          <Pen className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {editingTextId === comment.id ? (
                            <div className="space-y-1.5">
                              <textarea
                                value={editTextDraft}
                                onChange={(e) => setEditTextDraft(e.target.value)}
                                autoFocus
                                rows={3}
                                className="w-full p-2 rounded text-xs border border-[var(--color-border-strong)] text-[var(--color-text)] bg-[var(--color-surface)] focus:ring-2 focus:ring-blue-500 outline-none"
                              />
                              <div className="flex items-center gap-1.5 justify-end">
                                <button onClick={() => { setEditingTextId(null); setEditTextDraft(''); }} className="px-2 py-1 rounded text-[11px] bg-slate-200 hover:bg-slate-300 text-[var(--color-text)] font-bold">Cancel</button>
                                <button onClick={() => void handleSaveCommentEdit(comment.id)} className="px-2 py-1 rounded text-[11px] bg-emerald-600 hover:bg-emerald-500 text-white font-bold">Save</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <CommentBody text={comment.text} currentUserId={uid ?? undefined} className="leading-relaxed" />
                              {(comment as TicketComment & { editedAt?: string }).editedAt && (
                                <div className="mt-1 text-[10px] italic opacity-70">edited</div>
                              )}
                            </>
                          )}
                          {/* Edit / delete affordances — author OR admin only */}
                          {editingTextId !== comment.id && (comment.user === userEmail || isAdmin) && (
                            <div className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
                              <button
                                onClick={() => { setEditingTextId(comment.id); setEditTextDraft(comment.text); }}
                                className="w-5 h-5 rounded bg-slate-700 hover:bg-slate-900 text-white inline-flex items-center justify-center"
                                title="Edit"
                              >
                                <Pen className="w-2.5 h-2.5" />
                              </button>
                              <button
                                onClick={async () => { if (await appConfirm({ message: 'Delete this comment? This cannot be undone.', tone: "danger" })) void handleDeleteComment(comment.id); }}
                                className="w-5 h-5 rounded bg-red-600 hover:bg-red-500 text-white inline-flex items-center justify-center"
                                title="Delete"
                              >
                                <Trash2 className="w-2.5 h-2.5" />
                              </button>
                            </div>
                          )}
                          <div className="absolute -bottom-5 right-0 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-[var(--color-text-faint)] whitespace-nowrap">{toDate(comment.date).toLocaleString()}</div>
                       </div>
                    </div>
                  </div>
                ))}
              </>
            )}
            {activeTab === 'audit' && (
              <div className="space-y-6 pl-2">
                 {ticket.history?.map((event, idx) => (
                   <div key={`history-${idx}`} className="flex gap-4 relative animate-in fade-in slide-in-from-left-2">
                     {idx !== (ticket.history?.length || 0) - 1 && <div className="absolute left-[11px] top-8 bottom-[-24px] w-0.5 bg-slate-200" />}
                     <div className="relative z-10"><div className="w-6 h-6 rounded-full bg-[var(--color-surface)] border-2 border-[var(--color-border)] flex items-center justify-center"><div className="w-2 h-2 rounded-full bg-slate-400" /></div></div>
                     <div className="flex-1 pb-1">
                       <div className="flex items-center justify-between"><span className="text-xs font-bold text-[var(--color-text)]">{event.action.replace(/_/g, ' ')}</span><span className="text-[10px] text-[var(--color-text-faint)] font-mono">{toDate(event.date).toLocaleDateString()}</span></div>
                       <p className="text-xs text-[var(--color-text-muted)] mt-0.5">by <span className="font-semibold text-[var(--color-text)]">{event.user?.split('@')[0]}</span></p>
                       {event.details && <div className="mt-2 text-xs bg-[var(--color-surface-2)] border border-[var(--color-border)] p-2 rounded text-[var(--color-text-muted)] italic">&ldquo;{event.details}&rdquo;</div>}
                     </div>
                   </div>
                 ))}
                 {(!ticket.history || ticket.history.length === 0) && <div className="text-center py-8 text-[var(--color-text-faint)] text-xs italic">No history recorded yet.</div>}
              </div>
            )}
          </div>
          {activeTab === 'discussion' && (
            <div className="p-4 bg-[var(--color-surface)] border-t border-[var(--color-border)]">
              <div className="relative group">
                {activeOrgId && (
                  <MentionableTextarea
                    value={newComment}
                    onChange={(next, mentions) => { setNewComment(next); setNewCommentMentions(mentions); }}
                    orgId={activeOrgId}
                    rows={3}
                    placeholder="Type a comment... use @ to mention someone"
                  />
                )}
                <button
                  onClick={() => handlePostComment(newComment)}
                  disabled={!newComment.trim()}
                  className="absolute right-2 bottom-2 p-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:hover:bg-orange-600 transition-all shadow-md shadow-orange-900/20"
                ><Send className="w-4 h-4" /></button>
              </div>
              <p className="text-[10px] text-[var(--color-text-faint)] mt-2 text-center">
                <span className="font-bold">Enter</span> to send • <span className="font-bold">Shift+Enter</span> for new line
                {newCommentMentions.length > 0 && <> • <span className="text-orange-600 font-bold">{newCommentMentions.length} user(s) will be notified</span></>}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
