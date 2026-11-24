"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useDraft, clearDraft } from '@/hooks/useDraft';
import { useFileDrag } from '@/hooks/useFileDrag';
import { tryUpload } from '@/lib/uploadRetry';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/Modal';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody, Card, StepLine, heroPrimary, heroQuiet, type HeroFact } from '@/components/ui/PageHero';
import { Button } from '@/components/ui/Button';
import CopyId from '@/components/ui/CopyId';
import ErrorNote from '@/components/ui/ErrorNote';
import { Skeleton, SkeletonRows, SkeletonText } from '@/components/ui/Skeleton';
import { friendlyError } from '@/lib/friendlyError';
import { field as kitField, label as kitLabel } from '@/components/admin/kit';
import UnderlineTabs from '@/components/requests/UnderlineTabs';
import { StatusTag, waitingOn, fmtDay, fmtWhen, relTime, historyWords, shortName, sentence } from '@/components/requests/RequestBits';
import { isActionRequired } from '@/lib/ticketAttention';
import { readAsk } from '@/lib/asks';
import RequestAsk from '@/components/requests/RequestAsk';
import FileThumb from '@/components/ui/FileThumb';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import MoreMenu from '@/components/ui/MoreMenu';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { uploadTicketAttachment, getSignedUrlForPath } from '@/lib/storage';
import { useRole } from '@/components/providers/RoleContext';
import { useToast } from '@/components/providers/ToastProvider';
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";
import { Ticket, TicketAttachment, TicketComment } from '@/types/schema';
import { WorkflowEngine, WorkflowAction } from '@/lib/workflow';
import { loadCapabilityPolicy, type CapabilityPolicy } from '@/lib/capabilityPolicy';
import EngineerPickerModal from '@/components/requests/EngineerPickerModal';
import MentionableTextarea from '@/components/requests/MentionableTextarea';
import TicketArchiveViewer from '@/components/archive/TicketArchiveViewer';
import CommentBody from '@/components/requests/CommentBody';
import WorkflowDiagramModal, { REQUEST_STEPS, requestStepIndex } from '@/components/requests/WorkflowDiagramModal';
import SignaturePanel from '@/components/signatures/SignaturePanel';
import { extractMentionUids, isPastDue, isNearingDue } from '@/lib/notifications';
import { downloadStampedPdf } from '@/lib/stamping';
import { publicOrigin } from '@/lib/publicOrigin';
import { logAuditAction } from '@/lib/audit';
// Code-split: the redline editor pulls react-pdf/pdfjs + fabric + pdf-lib, none
// of which the request-detail page needs until the user actually opens markup.
const AdvancedRedlineEditor = dynamic(() => import('@/components/drafting/AdvancedRedlineEditor'), { ssr: false });
import UserAvatar from '@/components/ui/UserAvatar';
import HelpTooltip from '@/components/ui/HelpTooltip';
import {
  CheckCircle2,
  FileText,
  Paperclip,
  Send,
  Download,
  Eye,
  X,
  Printer,
  Save,
  UploadCloud,
  Loader2,
  FileIcon,
  ShieldAlert,
  ChevronRight,
  UserPlus,
  CheckSquare,
  AlertTriangle,
  FileCheck,
  Stamp,
  Pen,
  Check,
  HelpCircle,
  Archive,
  QrCode,
  Pencil,
  Trash2,
  RotateCcw,
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

// A comment's author as a short name.
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
  onClose: () => void;
  onSubmit: (text: string, category?: string) => void;
  onRedline?: () => void;
  title: string;
  description: string;
  isDestructive?: boolean;
  isLoading?: boolean;
  defaultValue?: string;
  showCategorySelection?: boolean;
  /** Where the typed reason is kept until it's sent. */
  draftKey: string | null;
}

// Mounted only while open, so each opening starts from the prefilled text
// (or the unsent draft, which wins).
const ActionModal = ({ onClose, onSubmit, onRedline, title, description, isDestructive, isLoading, defaultValue, showCategorySelection, draftKey }: ActionModalProps) => {
  const [comment, setComment] = useState(defaultValue || '');
  const [category, setCategory] = useState(REVISION_REASONS[0]);
  const draft = useDraft<string>(draftKey, comment, setComment, (v) => !v.trim());

  return (
    <Modal onClose={onClose} dismissable={!isLoading}>
      <ModalHeader title={title} subtitle={description} onClose={isLoading ? undefined : onClose} />
      <ModalBody className="space-y-4">
          {showCategorySelection && (
            <div>
              <label htmlFor="action-reason" className={kitLabel}>Reason</label>
              <select
                id="action-reason"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={kitField}
              >
                {REVISION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="action-comment" className={kitLabel}>
              {showCategorySelection ? 'What to fix' : 'Comment'}
            </label>
            <textarea
              id="action-comment"
              className={`${kitField} !h-auto min-h-32 py-2.5 resize-y [field-sizing:content]`}
              placeholder="Say what and where"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              autoFocus
            />
            {draft.restored ? (
              <p className="text-[13px] text-[var(--color-text-muted)] mt-1.5">Your unsent note is back.</p>
            ) : defaultValue ? (
              <p className="text-[13px] text-[var(--color-text-muted)] mt-1.5">
                Filled in from your last comment.
              </p>
            ) : !comment.trim() ? (
              <p className="text-[13px] text-[var(--color-text-muted)] mt-1.5">{isDestructive ? 'Send back' : 'Confirm'} works once there&apos;s a note here.</p>
            ) : null}
          </div>
      </ModalBody>
      <ModalFooter className="justify-between">
            {onRedline ? (
              <button type="button" onClick={onRedline} className={heroQuiet} disabled={isLoading}>
                <Pen className="w-4 h-4" /> Add redlines
              </button>
            ) : <span />}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className={heroQuiet} disabled={isLoading}>Cancel</button>
              <Button variant={isDestructive ? 'danger' : 'primary'} onClick={() => onSubmit(comment, showCategorySelection ? category : undefined)} disabled={!comment.trim()} loading={isLoading}>
                {isDestructive ? 'Send back' : 'Confirm'}
              </Button>
            </div>
      </ModalFooter>
    </Modal>
  );
};

// =========================================================================================
// SUB-COMPONENT: ASSIGNMENT MODAL
// =========================================================================================
interface AssignmentModalProps {
  onClose: () => void;
  onSubmit: (drafterId: string, drafterName: string, reason?: string) => void;
  isLoading?: boolean;
  activeOrgId: string | null;
  isReassignment?: boolean;
  /** The drafter on it now (marked, so a reassignment picks someone else). */
  currentDrafterId?: string | null;
  draftKey: string | null;
}

// Mounted only while open.
const AssignmentModal = ({ onClose, onSubmit, isLoading, activeOrgId, isReassignment, currentDrafterId, draftKey }: AssignmentModalProps) => {
  const [drafters, setDrafters] = useState<{uid: string, email: string, role: string}[]>([]);
  const [loadingList, setLoadingList] = useState(!!activeOrgId);
  const [listError, setListError] = useState<unknown>(null);
  const [listTry, setListTry] = useState(0);
  const [reason, setReason] = useState('');
  useDraft<string>(isReassignment ? draftKey : null, reason, setReason, (v) => !v.trim());
  const [reasonMissing, setReasonMissing] = useState(false);

  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    void (async () => {
      setLoadingList(true);
      setListError(null);
      const { data, error } = await supabase
        .from('org_members')
        .select('uid, email, role')
        .eq('org_id', activeOrgId)
        .eq('role', 'Drafter')
        .eq('status', 'active');
      if (!alive) return;
      if (error) setListError(error);
      else setDrafters((data || []).map(r => ({ uid: r.uid, email: r.email, role: r.role })));
      setLoadingList(false);
    })();
    return () => { alive = false; };
  }, [activeOrgId, listTry]);

  return (
    <Modal onClose={onClose} dismissable={!isLoading} size="lg">
      <ModalHeader icon={UserPlus} title={isReassignment ? 'Reassign request' : 'Assign a drafter'} subtitle={isReassignment ? 'Pick the new drafter and say why.' : 'Pick who draws it.'} onClose={isLoading ? undefined : onClose} />
      <ModalBody className="space-y-4">
          {isReassignment && (
            <div>
              <label htmlFor="reassign-why" className={kitLabel}>Why the change</label>
              <textarea
                id="reassign-why"
                className={`${kitField} !h-auto py-2.5 resize-y [field-sizing:content]`}
                rows={3}
                placeholder="e.g. Out this week"
                value={reason}
                aria-invalid={reasonMissing || undefined}
                aria-describedby={reasonMissing ? 'reassign-why-err' : undefined}
                onChange={(e) => { setReason(e.target.value); setReasonMissing(false); }}
              />
              {reasonMissing && <p id="reassign-why-err" role="alert" className="mt-1.5 text-[13px] font-semibold text-[var(--state-overdue-text)]">Say why first, then pick the new drafter.</p>}
            </div>
          )}

          <div className="max-h-[300px] overflow-y-auto custom-scrollbar border border-[var(--color-border)] rounded-xl">
            {loadingList ? (
              <SkeletonRows rows={3} cols={1} what="drafters" sheet={false} />
            ) : listError != null ? (
              <ErrorNote compact className="p-4" error={listError} title="The drafters didn't load." onRetry={() => setListTry((n) => n + 1)} />
            ) : drafters.length === 0 ? (
              <p className="p-4 text-center text-[15px] text-[var(--color-text-muted)]">No drafters in this workspace yet.</p>
            ) : (
              <div className="grid grid-cols-1 divide-y divide-[var(--color-border)]">
                {drafters.map(drafter => (
                  <button
                    key={drafter.uid}
                    onClick={() => {
                      if (isReassignment && !reason.trim()) { setReasonMissing(true); return; }
                      onSubmit(drafter.uid, drafter.email.split('@')[0], reason);
                    }}
                    disabled={isLoading || drafter.uid === currentDrafterId}
                    className="flex items-center px-3 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors group text-left w-full disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <UserAvatar uid={drafter.uid} email={drafter.email} size={32} rounded="full" className="mr-3" />
                    <div className="min-w-0"><p className="font-semibold text-[var(--color-text)] text-[15px] truncate">{shortName(drafter.email)}</p><p className="text-[13px] text-[var(--color-text-muted)] truncate">{drafter.uid === currentDrafterId ? 'On it now' : drafter.email}</p></div>
                    <ChevronRight aria-hidden className="w-4 h-4 ml-auto text-[var(--color-text-faint)] group-hover:text-[var(--color-text-muted)]" />
                  </button>
                ))}
              </div>
            )}
          </div>
      </ModalBody>
      <ModalFooter><button type="button" onClick={onClose} disabled={isLoading} className={heroQuiet}>Cancel</button></ModalFooter>
    </Modal>
  );
};

// =========================================================================================
// SUB-COMPONENT: UPLOAD IFC MODAL
// =========================================================================================
interface UploadIFCModalProps {
  onClose: () => void;
  onSubmit: (file: File) => void;
  isLoading?: boolean;
  /** Why the last try didn't go through, shown in place. */
  error?: string | null;
}

const UploadIFCModal = ({ onClose, onSubmit, isLoading, error }: UploadIFCModalProps) => {
  const [file, setFile] = useState<File | null>(null);
  const drag = useFileDrag((fs) => { if (fs[0]) setFile(fs[0]); }, isLoading);

  return (
    <Modal onClose={onClose} dismissable={!isLoading}>
      <ModalHeader icon={Stamp} title="Issue for construction" subtitle="Add the final stamped PDF." onClose={isLoading ? undefined : onClose} />
      <ModalBody className="space-y-3">
          <label {...drag.bind} className={`flex flex-col items-center justify-center w-full min-h-32 p-4 border border-dashed border-[var(--color-border-control)] rounded-xl cursor-pointer bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] transition-colors ${drag.ring}`}>
            {drag.over ? (
              <p className="text-[15px] font-semibold text-[var(--color-text)]">{drag.say}</p>
            ) : file ? (
              <div className="flex items-center gap-3 min-w-0">
                <FileThumb file={file} />
                <div className="min-w-0 text-left">
                  <p className="text-[15px] font-semibold text-[var(--color-text)] truncate">{file.name}</p>
                  <p className="text-[13px] text-[var(--color-text-muted)]">PDF, {formatBytes(file.size)}. Tap to pick another.</p>
                </div>
              </div>
            ) : (
              <div className="text-center">
                <UploadCloud aria-hidden className="w-6 h-6 text-[var(--color-text-faint)] mx-auto mb-2" />
                <p className="text-[15px] text-[var(--color-text)]">Drop the stamped PDF here, or <span className="text-[var(--color-accent-text)]">pick it</span></p>
              </div>
            )}
            <input type="file" className="hidden" accept=".pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ''; }} />
          </label>
          {error && <ErrorNote compact title="The PDF didn't upload." next={`${error} The file is still picked: tap Try again.`} />}
      </ModalBody>
      <ModalFooter>
           <button type="button" onClick={onClose} disabled={isLoading} className={heroQuiet}>Cancel</button>
           <Button onClick={() => file && onSubmit(file)} disabled={!file} loading={isLoading} title={!file ? 'Pick the stamped PDF first' : undefined}>
             {isLoading ? 'Issuing' : error ? 'Try again' : 'Issue final package'}
           </Button>
      </ModalFooter>
    </Modal>
  );
};

// =========================================================================================
// SUB-COMPONENT: COMPLIANCE DOWNLOAD MODAL (Prevention Mechanism)
// =========================================================================================
interface DownloadComplianceModalProps {
  onClose: () => void;
  onConfirm: () => void;
  fileName: string;
}

const DownloadComplianceModal = ({ onClose, onConfirm, fileName }: DownloadComplianceModalProps) => (
  <Modal onClose={onClose} size="sm" zIndex={500}>
    <ModalHeader icon={AlertTriangle} title="This is a draft" onClose={onClose} />
    <ModalBody>
      <p className="text-[15px] text-[var(--color-text)]"><strong className="break-all">{fileName}</strong></p>
      <p className="mt-2 border-l-[3px] border-[var(--state-held)] pl-2.5 text-[15px] font-semibold text-[var(--state-held-text)]">Not for construction. For review only.</p>
    </ModalBody>
    <ModalFooter>
      <button type="button" onClick={onClose} className={heroQuiet}>Cancel</button>
      <Button onClick={onConfirm}><Download className="w-4 h-4" /> Download the draft</Button>
    </ModalFooter>
  </Modal>
);

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
            <span key={j} className="text-xl font-semibold text-[var(--color-text)]">
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
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (/^https?:\/\//i.test(file.url)) { if (alive) setResolvedUrl(file.url); return; }
      try {
        const u = await getSignedUrlForPath(file.url);
        if (alive) setResolvedUrl(u);
      } catch (e) {
        if (alive) setError(e ?? new Error('sign failed'));
      }
    })();
    return () => { alive = false; };
  }, [file.url]);
  if (error != null) {
    return (
      <Modal onClose={onClose} size="sm" zIndex={500}>
        <ModalHeader icon={AlertTriangle} title="Couldn't open the markup" onClose={onClose} />
        <ModalBody><ErrorNote compact error={error} title="The file didn't load." /></ModalBody>
      </Modal>
    );
  }
  if (!resolvedUrl) {
    return (
      <div className="fixed inset-0 z-[200] bg-slate-900/80 flex items-center justify-center">
        <div role="status" className="text-white text-[15px] inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Opening the file for markup</div>
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
  ticketRowId,
  deliverableRev,
  orgId,
  userId,
  onApprove,
  archived,
  archiveId,
}: {
  file: TicketAttachment | null;
  isOpen: boolean;
  onClose: () => void;
  ticketId?: string;
  /** Row UUID — powers the /verify-ticket QR stamped on downloads. */
  ticketRowId?: string;
  /** Current deliverable rev (1A while in review, 1 once issued). */
  deliverableRev?: string | null;
  orgId?: string;
  userId?: string;
  onApprove?: () => void;
  archived?: boolean;
  archiveId?: string | null;
}) => {
  const [showCompliance, setShowCompliance] = useState(false);
  // file.url is stored as the raw R2 storage path (orgs/<org>/tickets/...).
  // Resolve to a presigned download URL once the modal opens so the iframe
  // / img tags actually load. Without this they show "not found".
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<unknown>(null);
  const { userEmail } = useRole();
  const { showToast } = useToast();
  // Every pull is logged; if the log write fails, say so instead of
  // pretending it was recorded.
  const logPull = (row: Record<string, unknown>) => {
    void supabase.from("download_audits").insert(row).then(({ error }) => {
      if (error) showToast({ type: "error", title: "Not logged", message: `This copy wasn't added to the download log. ${friendlyError(error)}` });
    }, (e: unknown) => showToast({ type: "error", title: "Not logged", message: `This copy wasn't added to the download log. ${friendlyError(e)}` }));
  };

  // Escape closes the viewer (the warning on top closes first).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !showCompliance) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, showCompliance]);

  useEffect(() => {
    // Archived tickets have had their attachment binaries shed to the cold
    // archive — don't try to sign a URL for a key that no longer exists.
    if (!isOpen || !file?.url || archived) { setResolvedUrl(null); setResolveError(null); return; }
    let alive = true;
    setResolvedUrl(null);
    setResolveError(null);
    // If the stored value already looks like a fully-qualified URL (legacy
    // attachments uploaded before the path-only fix), pass it through.
    if (/^https?:\/\//i.test(file.url)) { setResolvedUrl(file.url); return; }
    getSignedUrlForPath(file.url)
      .then((u) => { if (alive) setResolvedUrl(u); })
      .catch((e) => { if (alive) setResolveError(e ?? new Error('sign failed')); });
    return () => { alive = false; };
  }, [isOpen, file?.url, archived]);

  if (!isOpen || !file) return null;

  const isPdf = file.type?.includes('pdf') || file.name.toLowerCase().endsWith('.pdf');
  const isImage = file.type?.includes('image') || file.name.match(/\.(jpeg|jpg|gif|png)$/i);

  const handlePrint = async () => {
    if (!resolvedUrl) { await appAlert({ message: 'Still loading file - try again in a moment.' }); return; }
    // Print the STAMPED stream, never the raw file: watermark + rev footer +
    // the verify QR, exactly like a download. Paper is where copies escape.
    let printUrl = resolvedUrl;
    let stamped = false;
    try {
      const { stampPdf } = await import("@/lib/stamping");
      const verifyUrl = ticketRowId && publicOrigin()
        ? `${publicOrigin()}/verify-ticket/${ticketRowId}${deliverableRev ? `?r=${encodeURIComponent(deliverableRev)}` : ""}`
        : undefined;
      const blob = await stampPdf(resolvedUrl, {
        userLabel: userEmail?.split("@")[0] || userId || "USER",
        email: userEmail || undefined,
        timestamp: new Date(),
        watermarkText: file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "UNCONTROLLED COPY",
        verifyUrl,
        footerNotice: deliverableRev
          ? `${ticketId ?? "Ticket"} deliverable Rev ${deliverableRev} at time of printing - scan the QR to confirm it is still the latest.`
          : undefined,
      });
      printUrl = URL.createObjectURL(blob);
      stamped = true;
    } catch {
      // Stamping failed (odd PDF / CORS): warn loudly instead of silently
      // printing an unmarked copy.
      const proceed = await appConfirm({
        title: "Print without the stamp?",
        message: "The watermark and QR stamp couldn't be added to this file. Print the unstamped copy anyway?",
        tone: "danger",
        confirmLabel: "Print unstamped",
      });
      if (!proceed) return;
    }
    // Record the print on the audit trail either way.
    if (orgId && userId) {
      logPull({
        org_id: orgId, ticket_id: ticketId ?? null, attachment_id: file.id,
        attachment_type: file.type, filename: file.name, user_id: userId,
        user_email: userEmail ?? null,
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        watermark_text: stamped ? "UNCONTROLLED COPY" : "UNSTAMPED (stamping failed)",
        source: "drafting_print",
      });
    }
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = printUrl;
    document.body.appendChild(iframe);
    iframe.onload = () => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    };
    setTimeout(() => {
      document.body.removeChild(iframe);
      if (stamped) URL.revokeObjectURL(printUrl);
    }, 60_000);
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

    let stamped = false;
    try {
      const downloadUrl = resolvedUrl || (await getSignedUrlForPath(file.url));
      // Every downloaded copy carries a QR that answers "is this still the
      // latest revision of this ticket's deliverable?" — so a copy a PM
      // handed out keeps warning for itself after a new revision lands.
      const verifyUrl = ticketRowId && publicOrigin()
        ? `${publicOrigin()}/verify-ticket/${ticketRowId}${deliverableRev ? `?r=${encodeURIComponent(deliverableRev)}` : ""}`
        : undefined;
      await downloadStampedPdf({
        url: downloadUrl,
        filename: file.name,
        options: {
          userLabel: userEmail?.split("@")[0] || userId || "USER",
          email: userEmail || undefined,
          timestamp: now,
          expiresAt,
          watermarkText: file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "CONTROLLED COPY",
          verifyUrl,
          footerNotice: deliverableRev
            ? `${ticketId ?? "Ticket"} deliverable Rev ${deliverableRev} at time of download - scan the QR to confirm it is still the latest.`
            : undefined,
        },
      });
      stamped = true;
    } catch (e) {
      console.warn("Stamp Generation Failed (likely CORS). Falling back to direct download.", e);
      // FALLBACK WITH A VOICE: the user still gets their file, but they are
      // told it's unmarked — a raw copy must never masquerade as a stamped one.
      await appAlert({
        message: "The watermark and QR stamp couldn't be added to this file, so you're getting the original, unmarked copy. Treat it as uncontrolled and don't hand it out.",
        tone: "danger",
      });
      const link = document.createElement("a");
      link.href = resolvedUrl || (await getSignedUrlForPath(file.url));
      link.download = file.name;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      // The audit row records the pull EITHER WAY — an unstamped fallback is
      // exactly the copy the distribution record most needs to know about.
      if (orgId && userId) {
        logPull({
          org_id: orgId, ticket_id: ticketId ?? null, attachment_id: file.id,
          attachment_type: file.type, filename: file.name, user_id: userId,
          user_email: userEmail ?? null, expires_at: expiresAt,
          watermark_text: stamped
            ? (file.type === "Draft" ? "REVIEW ONLY - DO NOT DISTRIBUTE" : "CONTROLLED COPY")
            : "UNSTAMPED (stamping failed)",
          source: "drafting",
        });
      }
      setShowCompliance(false);
    }
  };

  return (
    <>
      {showCompliance && (
        <DownloadComplianceModal
          onClose={() => setShowCompliance(false)}
          onConfirm={performDownload}
          fileName={file.name}
        />
      )}

      <div role="dialog" aria-modal="true" aria-label={file.name} className="fixed inset-0 z-[100] bg-slate-950/95 backdrop-blur-md flex flex-col animate-in fade-in duration-300">
        <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-4 bg-slate-900 border-b border-slate-800 text-white shadow-md relative z-50">
          <div className="flex items-center space-x-4 min-w-0">
            <div className="p-2 rounded-lg border bg-slate-800 border-slate-700 text-slate-300 shrink-0">
               {file.type === 'Draft' ? <AlertTriangle className="w-6 h-6 text-amber-400" /> : <FileCheck className="w-6 h-6" />}
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-lg leading-none flex items-center min-w-0">
                <span className="truncate">{file.name}</span>
                {file.type === 'Draft' && <span className="ml-3 shrink-0 px-2 py-0.5 border border-amber-400/60 text-amber-300 text-[13px] font-semibold rounded ">Draft, not for construction</span>}
              </h3>
              <div className="flex items-center text-xs text-slate-400 mt-1.5 space-x-2">
                <span className="bg-slate-800 px-2 py-0.5 rounded border border-slate-700">{file.type}</span>
                <span>•</span>
                <span>{file.size}</span>
                <span>•</span>
                <span>{fmtWhen(file.uploadedAt)}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!archived && file.type !== 'Draft' && (
               <button onClick={handlePrint} className="flex items-center px-3 sm:px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-colors border border-slate-700">
                 <Printer className="w-4 h-4 sm:mr-2" /><span className="hidden sm:inline">Print</span>
               </button>
            )}
            {/* One main button: Approve when it's yours to approve, else Download. */}
            {!archived && (
              <button
                onClick={handleDownloadClick}
                className={`flex items-center px-3 sm:px-4 py-2 rounded-lg text-sm font-bold transition-colors ${onApprove && file.type === 'Draft' ? 'bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white' : 'bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]'}`}
              >
                <Download className="w-4 h-4 sm:mr-2" /><span className="hidden sm:inline">Download</span>
              </button>
            )}
            {onApprove && file.type === 'Draft' && (
              <button
                onClick={onApprove}
                className="flex items-center px-4 py-2 rounded-lg text-sm font-bold transition-colors bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" /> Approve
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400 hover:text-white">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden relative bg-slate-900/50 flex items-center justify-center p-8">
          {/* VISUAL PROTECTION LAYER */}
          {file.type === 'Draft' && <WatermarkOverlay />}

          {archived ? (
            <div className="text-center p-12 bg-[var(--color-surface)] rounded-xl shadow-2xl max-w-md border border-[var(--color-border)] relative z-10">
              <div className="w-24 h-24 bg-[var(--color-surface-2)] rounded-full flex items-center justify-center mx-auto mb-6 border border-[var(--color-border)]">
                <Archive className="w-12 h-12 text-[var(--color-text-muted)]" />
              </div>
              <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">This file is in the archive</h3>
              <p className="text-[var(--color-text-muted)] leading-relaxed">
                The request closed a while ago, so its files moved to{' '}
                {archiveId ? <span className="font-display font-semibold">{archiveId}</span> : 'the offline archive'}.
                An admin can restore it{archiveId && <> from <code className="font-mono break-all">&lt;root&gt;/data/{archiveId}.zip</code></>}.
              </p>
            </div>
          ) : isPdf ? (
            resolvedUrl ? (
              <iframe src={`${resolvedUrl}#toolbar=0&navpanes=0`} className="w-full h-full rounded-lg shadow-2xl bg-[var(--color-surface)] border border-slate-700 relative z-0" title="PDF Viewer" />
            ) : resolveError != null ? (
              <div role="alert" className="max-w-md text-center text-slate-200 text-[15px]">{friendlyError(resolveError)}</div>
            ) : (
              <div role="status" className="text-slate-300 text-[15px] flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading the preview</div>
            )
          ) : isImage ? (
            resolvedUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- ephemeral signed-URL preview; optimizer can't cache short-lived URLs and intrinsic size is unknown
              <img src={resolvedUrl} alt="Preview" className="max-w-full max-h-full object-contain shadow-2xl rounded-lg border border-slate-700 relative z-0" />
            ) : resolveError != null ? (
              <div role="alert" className="max-w-md text-center text-slate-200 text-[15px]">{friendlyError(resolveError)}</div>
            ) : (
              <div role="status" className="text-slate-300 text-[15px] flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading the preview</div>
            )
          ) : (
            <div className="text-center p-12 bg-[var(--color-surface)] rounded-xl shadow-2xl max-w-md border border-[var(--color-border)] relative z-10">
              <div className="w-24 h-24 bg-[var(--color-surface-2)] rounded-full flex items-center justify-center mx-auto mb-6 border border-[var(--color-border)]">
                <FileIcon className="w-12 h-12 text-[var(--color-text-faint)]" />
              </div>
              <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">No preview for this type</h3>
              <p className="text-[var(--color-text-muted)] leading-relaxed">Download it to open it.</p>
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
  const { activeRole, roles, userEmail, activeOrgId, uid } = useRole();
  // The org's capability policy — so the buttons drawn here match what the
  // workflow-action route will actually allow (it re-derives with the same
  // policy). Undefined until loaded → defaults, which mirror historic rules.
  const [capPolicy, setCapPolicy] = useState<CapabilityPolicy | undefined>(undefined);
  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    void loadCapabilityPolicy(activeOrgId).then((p) => { if (alive) setCapPolicy(p); }).catch(() => {});
    return () => { alive = false; };
  }, [activeOrgId]);
  const { showToast } = useToast();
  const ticketId = params.id as string;

  // --- STATE ---
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  // Why it didn't open: a failed read (said in plain words, with Try
  // again) or a plain fact (not there, in another workspace).
  const [loadError, setLoadError] = useState<{ error?: unknown; words?: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The file going up now, and the last one that didn't (kept, so Try
  // again sends the same file as the same kind).
  const [upFile, setUpFile] = useState<{ file: File; type: 'Draft' | 'Final' | 'Source' | 'Reference' } | null>(null);
  const [failedUpload, setFailedUpload] = useState<{ file: File; type: 'Draft' | 'Final' | 'Source' | 'Reference' } | null>(null);
  const [ifcError, setIfcError] = useState<string | null>(null);
  // A redline that already went up, kept so pressing Send back again after a
  // failed step doesn't upload it twice.
  const redlineUpRef = useRef<{ blob: Blob; att: TicketAttachment } | null>(null);
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  // Right after sending a request (?sent=1): offer email updates now, when
  // they mean something, and say what they'll bring. Read from the
  // person's own notification settings so it never offers what's on.
  const justSent = searchParams.get('sent') === '1';
  const [emailAsk, setEmailAsk] = useState<'off' | 'on' | 'hidden' | null>(null);
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailDone, setEmailDone] = useState(false);
  const [emailError, setEmailError] = useState<unknown>(null);
  useEffect(() => {
    if (!justSent || !uid) return;
    let alive = true;
    void supabase.from('notification_preferences').select('*').eq('user_id', uid).maybeSingle().then(({ data, error }) => {
      if (!alive) return;
      if (error) { setEmailAsk('hidden'); return; }
      const p = (data ?? {}) as Record<string, unknown>;
      const on = p.email_enabled !== false && p.digest_frequency !== 'never' && p.email_on_status_change !== false && p.email_on_assignment !== false;
      setEmailAsk(on ? 'on' : 'off');
    }, () => { if (alive) setEmailAsk('hidden'); });
    return () => { alive = false; };
  }, [justSent, uid]);
  const closeSent = () => {
    setEmailAsk('hidden');
    try { const url = new URL(window.location.href); url.searchParams.delete('sent'); window.history.replaceState(null, '', url.toString()); } catch { /* address only */ }
  };
  const turnOnEmail = async () => {
    if (!uid) return;
    setEmailSaving(true); setEmailError(null);
    const { error } = await supabase.from('notification_preferences').upsert(
      { user_id: uid, email_enabled: true, email_on_status_change: true, email_on_assignment: true },
      { onConflict: 'user_id' },
    );
    setEmailSaving(false);
    if (error) { setEmailError(error); return; }
    setEmailDone(true);
    setEmailAsk('on');
  };

  // Chat State
  const [newComment, setNewComment] = useState('');
  const [newCommentMentions, setNewCommentMentions] = useState<string[]>([]);
  // Unsent comment survives a reload or leaving the page.
  useDraft<string>(ticketId ? `request-comment:${ticketId}` : null, newComment, setNewComment, (v) => !v.trim());
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [viewerFile, setViewerFile] = useState<TicketAttachment | null>(null);
  const [showArchiveViewer, setShowArchiveViewer] = useState(false);

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
      deliverableRev: r.deliverable_rev as string | null | undefined,
      draftIteration: r.draft_iteration as number | undefined,
      metadata: (r.metadata as Record<string, unknown> | null) ?? undefined,
      createdAt: r.created_at as string,
      lastModified: r.last_modified as string | undefined,
      updatedAt: r.updated_at as string | undefined,
      archivedAt: r.archived_at as string | null | undefined,
      archiveId: r.archive_id as string | null | undefined,
    });

    const fetchTicket = async () => {
      const { data, error } = await supabase.from('tickets').select('*').eq('id', ticketId).maybeSingle();
      if (!alive) return;
      // A failed read says so (it isn't the same as "not there").
      if (error) { setLoadError({ error }); setLoading(false); return; }
      if (!data) { setLoadError({ words: "It may have been removed, or it's in another workspace." }); setLoading(false); return; }
      const t = fromRow(data as Record<string, unknown>);
      if (activeOrgId && t.orgId && t.orgId !== activeOrgId) { setLoadError({ words: "It's in another workspace. Switch to that workspace in the sidebar to open it." }); setLoading(false); return; }
      setLoadError(null);
      setTicket(t);
      // Marking it seen happens in the background; a failure only means the
      // dot stays, so it's noted in the console, not in the way.
      if (uid && t.unreadBy?.includes(uid)) {
        void supabase.from('tickets').update({ unread_by: t.unreadBy.filter(id => id !== uid) }).eq('id', ticketId)
          .then(({ error: e }) => { if (e) console.warn('[request] mark seen failed', e.message); });
      }
      // Opening the ticket counts as reviewing its activity: mark this ticket's
      // in-app notifications read so the bell + sidebar bubble actually clears
      // (clearing unread_by alone left the notification rows unread).
      if (uid) {
        void supabase.from('notifications')
          .update({ read_at: new Date().toISOString() })
          .eq('user_id', uid).eq('resource_id', ticketId).is('read_at', null)
          .then(({ error: e }) => { if (e) console.warn('[request] mark notifications read failed', e.message); });
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
  }, [ticketId, activeOrgId, uid, reloadKey]);

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
      const { error: upErr } = await supabase.from('tickets').update({ comments: updatedComments }).eq('id', ticketId);
      if (upErr) throw upErr;
      await logAuditAction({
        action: 'TICKET_ROOT_CAUSE_UPDATE', resourceId: ticketId, resourceType: 'ticket',
        orgId: activeOrgId || undefined, userId: uid || 'unknown', userRole: activeRole,
        details: { commentId, newCategory: editCategoryVal }
      });
      setEditingCommentId(null);
    } catch (e) {
      console.error("Failed to update category", e);
      await appAlert({ title: "The reason wasn't changed", message: friendlyError(e), tone: "danger" });
    }
  };

  const handleFileUpload = async (type: 'Draft' | 'Final' | 'Source' | 'Reference', fileOverride?: File) => {
    const file = fileOverride || fileToUpload;
    if (!file || !ticket) return;
    if (!activeOrgId) { setUploadError("Pick a workspace first."); return; }
    setIsUploading(true);
    setUploadError(null);
    setFailedUpload(null);
    setUpFile({ file, type });
    setUploadProgress(0);
    const orgId = activeOrgId;
    const ticketNo = ticket.ticketId;
    // The transfer and the save after it, as one step that's safe to repeat:
    // it reads the current file list right before adding to it, and nothing
    // is added unless the file went up.
    const run = async () => {
      const result = await uploadTicketAttachment({
        file, orgId, ticketId: ticketNo,
        onProgress: (p) => setUploadProgress(p.percent),
      });
      const newAttachment: TicketAttachment = {
        id: crypto.randomUUID(), name: file.name, url: result.url, type,
        status: type === 'Source' ? 'submitted' : 'staged',
        size: formatBytes(file.size), uploadedBy: userEmail || 'Unknown', uploadedAt: new Date().toISOString()
      };
      const now = new Date().toISOString();
      const historyEntry = { action: 'File Uploaded', user: userEmail || 'Unknown', role: activeRole, date: now, details: `Uploaded ${type} file: ${file.name}` };
      const { data: cur, error: readErr } = await supabase.from('tickets').select('attachments, history').eq('id', ticketId).single();
      if (readErr) throw readErr;
      const { error: upErr } = await supabase.from('tickets').update({
        attachments: [...((cur?.attachments as TicketAttachment[] | null) ?? []), newAttachment],
        last_modified: now,
        history: [...((cur?.history as unknown[] | null) ?? []), historyEntry],
      }).eq('id', ticketId);
      if (upErr) throw new Error(`The file went up but wasn't added to the request: ${upErr.message}`);
    };
    try {
      await tryUpload(file.name, run, { onRetried: () => setUploadError(null) });
      await logAuditAction({
        action: 'TICKET_FILE_UPLOAD', resourceId: ticketId, resourceType: 'ticket',
        orgId, userId: uid || 'unknown', userEmail: userEmail || 'unknown', userRole: activeRole,
        details: { fileName: file.name, fileType: type, fileSize: file.size }
      });
      setFileToUpload(null);
    } catch (err) {
      console.error(err);
      setUploadError(friendlyError(err));
      setFailedUpload({ file, type });
      setFileToUpload(null);
    } finally {
      setIsUploading(false);
      setUpFile(null);
      setUploadProgress(0);
    }
  };

  // Drop a file anywhere on the Files card: it asks what kind it is, then adds it.
  const filesDrag = useFileDrag((fs) => { if (fs[0]) { setUploadError(null); setFileToUpload(fs[0]); } }, isUploading || !!ticket?.archivedAt);

  const initiateWorkflowAction = async (action: WorkflowAction) => {
    if (!ticket) return;
    if (action.requiresFile) {
      const hasFiles = ticket.attachments && ticket.attachments.length > 0;
      if (!hasFiles) { await appAlert({ title: "Add a file first", message: "This step needs at least one file on the request. Add it under Files, then try again.", tone: "danger" }); return; }
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
    setIfcError(null);
    const action = pendingAction;
    const toFinal = (url: string): TicketAttachment => ({
      id: crypto.randomUUID(), name: file.name, url, type: 'Final',
      status: 'submitted', size: formatBytes(file.size), uploadedBy: userEmail || 'Unknown',
      uploadedAt: new Date().toISOString()
    });
    let finalAttachment: TicketAttachment;
    try {
      if (!activeOrgId) throw new Error("No active workspace selected.");
      const orgId = activeOrgId;
      // Only the transfer is retried from the corner card; the issue step
      // then runs once with the file that went up.
      const result = await tryUpload(file.name, () => uploadTicketAttachment({ file, orgId, ticketId: ticket.ticketId }), {
        onRetried: (r) => { setIfcError(null); void executeWorkflowAction(action, undefined, undefined, toFinal(r.url)); },
      });
      finalAttachment = toFinal(result.url);
    } catch (err) {
      console.error(err);
      setIfcError(friendlyError(err));
      setActionLoading(null);
      return;
    }
    await executeWorkflowAction(action, undefined, undefined, finalAttachment);
  };

  const handleRedlineSave = async (blob: Blob) => {
    if (!ticket || !fileToRedline) return;
    // Store blob for later upload
    setPendingRedlineBlob(blob);
    setShowRedlineEditor(false);

    // Open the Rejection Modal (mocking the workflow action)
    const rejectAction: WorkflowAction = {
      label: 'Ask for a revision with markups',
      action: 'request_revision',
      variant: 'destructive',
      requiresComment: true
    };

    setPendingAction(rejectAction);
    setShowCommentModal(true);
  };

  // Where a dialog's typed reason waits until it's sent.
  const actionDraftKey = (a: WorkflowAction | null) => (a ? `request-action:${ticketId}:${a.action}${isReassigning ? ':reassign' : ''}` : null);

  // True when it went through; on failure the dialog stays open with what
  // was typed, and a toast says why.
  const executeWorkflowAction = async (
    action: WorkflowAction,
    comment?: string,
    assignmentData?: {id: string, name: string},
    newFinalFile?: TicketAttachment,
    category?: string,
    engineerData?: {id: string, name: string, email: string}
  ): Promise<boolean> => {
    if (!ticket) return false;
    setActionLoading(action.action);
    try {
      // Handle Redline Upload if pending — files upload from the client;
      // the transition itself is computed + enforced server-side.
      let finalComment = comment;
      let redlineAttachment: TicketAttachment | null = null;

      if (pendingRedlineBlob && fileToRedline) {
         if (!activeOrgId) throw new Error("No active workspace.");
         const blob = pendingRedlineBlob;
         const orgId = activeOrgId;
         const fileName = `REDLINE_${Date.now()}_${fileToRedline.name}`;
         const toAtt = (url: string): TicketAttachment => ({
           id: crypto.randomUUID(),
           name: fileName,
           url,
           type: 'Reference',
           status: 'submitted',
           size: formatBytes(blob.size),
           uploadedBy: userEmail || 'Unknown',
           uploadedAt: new Date().toISOString()
         });
         if (redlineUpRef.current?.blob === blob) {
           redlineAttachment = redlineUpRef.current.att;
         } else {
           // Only the transfer: a Try again from the corner card keeps the
           // file that went up, and the next Send back uses it.
           const redlineFile = new File([blob], fileName, { type: blob.type });
           const result = await tryUpload(fileName, () => uploadTicketAttachment({ file: redlineFile, orgId, ticketId: ticket.ticketId }), {
             onRetried: (r) => { redlineUpRef.current = { blob, att: toAtt(r.url) }; },
           });
           redlineAttachment = toAtt(result.url);
           redlineUpRef.current = { blob, att: redlineAttachment };
         }

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
        await appAlert({ message: "Someone else just changed this request, so this wasn't applied. The latest version is loading. Check it and try again.", tone: "danger" });
        return false;
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

      const sentKey = actionDraftKey(action);
      if (sentKey) clearDraft(sentKey);
      setActionLoading(null);
      setPendingAction(null);
      setShowCommentModal(false);
      setShowAssignModal(false);
      setIsReassigning(false);
      setShowUploadIFC(false);
      setIfcError(null);
      setPendingRedlineBlob(null); // Clear redline state
      setFileToRedline(null);
      redlineUpRef.current = null;
      return true;
    } catch (err) { console.error(err); showToast({ type: "error", title: "That didn't go through", message: friendlyError(err) }); setActionLoading(null); return false; }
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
      // Give the words back so nothing typed is lost.
      setNewComment((cur) => cur || text);
      console.error('Failed to post comment', err);
      await appAlert({ title: "Your comment wasn't posted", message: `${friendlyError(err)} Your words are back in the box.`, tone: "danger" });
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
      await appAlert({ title: "Your edit wasn't saved", message: friendlyError(err), tone: "danger" });
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
      await appAlert({ title: "The comment wasn't deleted", message: friendlyError(err), tone: "danger" });
    }
  };

  const toggleWatch = async () => {
    if (!ticket || !uid) return;
    const current = ticket.watchers ?? [];
    const next = current.includes(uid)
      ? current.filter((w) => w !== uid)
      : [...current, uid];
    // Shows at once; put back if the save fails.
    setTicket((prev) => prev ? { ...prev, watchers: next } : prev);
    const { error } = await supabase.from("tickets").update({ watchers: next }).eq("id", ticketId);
    if (error) {
      setTicket((prev) => prev ? { ...prev, watchers: current } : prev);
      await appAlert({ title: "Watching didn't change", message: friendlyError(error), tone: "danger" });
    }
  };

  if (loadError && !ticket) {
    const failed = loadError.error !== undefined;
    return (
      <PageShell width="form">
        <PageHero back={{ href: '/requests', label: 'Drafting requests' }} kicker="Drafting requests" size="md"
          title={failed ? "This request didn't open." : "This request isn't here."} />
        <PageBody>
          {failed
            ? <ErrorNote error={loadError.error} onRetry={() => { setLoadError(null); setLoading(true); setReloadKey((k) => k + 1); }} />
            : <p className="text-[15px] text-[var(--color-text)]">{loadError.words}</p>}
          <Link href="/requests" className={heroQuiet}>Go to drafting requests</Link>
        </PageBody>
      </PageShell>
    );
  }
  if (loading || !ticket) {
    return (
      <PageShell width="full">
        <div className="mx-auto max-w-[1920px]">
          <PageHero back={{ href: '/requests', label: 'Drafting requests' }} kicker="Drafting requests" size="md" title={<Skeleton className="h-7 w-96 max-w-full" />} />
          <PageBody>
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] gap-x-6 gap-y-8 items-start">
              <div className="space-y-8 min-w-0">
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"><SkeletonText lines={4} /></div>
                <SkeletonRows rows={4} cols={2} what="the request" />
              </div>
              <SkeletonRows rows={5} cols={0} what="the discussion" />
            </div>
          </PageBody>
        </div>
      </PageShell>
    );
  }

  const availableActions = WorkflowEngine.getActions(ticket, activeRole, uid ?? undefined, capPolicy);
  const sourceFiles = ticket.attachments?.filter(a => a.type === 'Source' || a.type === 'Reference') || [];

  // LOGIC: DRAFTS SORTING & VERSIONING
  const draftFilesRaw = ticket.attachments?.filter(a => a.type === 'Draft') || [];
  const sortedDrafts = draftFilesRaw.sort((a, b) => toDate(b.uploadedAt).getTime() - toDate(a.uploadedAt).getTime());

  const finalFiles = ticket.attachments?.filter(a => a.type === 'Final') || [];

  // LOGIC: Check for Staged Files
  const hasStagedFiles = ticket.attachments?.some(a => a.status === 'staged' && a.type === 'Draft');

  // Where the request is, in words.
  const stateWords = (() => {
    switch (ticket.status) {
      case 'NEW': return 'New. Waiting for a first look.';
      case 'PENDING_ENG_INITIAL':
      case 'PENDING_ENG_TEAM': return 'In engineering review.';
      case 'PENDING_ASSIGNMENT': return 'Waiting for a drafter.';
      case 'DRAFTING': return ticket.assignedDrafterName ? `Being drafted by ${ticket.assignedDrafterName}.` : 'Being drafted.';
      case 'REVISION_REQ': return 'Sent back for a revision.';
      case 'PENDING_REVIEW': return 'Draft out for review.';
      case 'PENDING_FINAL_APPROVAL': return 'Waiting for engineer sign-off.';
      case 'PENDING_IFC': return 'Approved. Ready to issue for construction.';
      case 'FINAL_DRAFT': return 'Issued. Waiting to close.';
      case 'CLOSED': return 'Closed.';
      case 'CANCELED': return 'Canceled.';
      default: return sentence(String(ticket.status).replace(/_/g, ' ')) + '.';
    }
  })();
  // One main step, the one you can take now (drafts waiting to go out come
  // first); up to two other steps quiet beside it; admin overrides,
  // reassigning and anything destructive in More. An override or a
  // destructive step is never the main one.
  const isDanger = (a: typeof availableActions[number]) => a.variant === 'destructive' || /force/i.test(a.label);
  const isOverride = (a: typeof availableActions[number]) => a.variant === 'ghost' || /\(admin\)/i.test(a.label);
  const mainAct = (hasStagedFiles ? availableActions.find((a) => a.action === 'submit_draft') : undefined)
    ?? availableActions.find((a) => !isDanger(a) && !isOverride(a) && a.variant !== 'outline') ?? null;
  const restActs = availableActions.filter((a) => a !== mainAct);
  const quietActs = restActs.filter((a) => !isDanger(a) && !isOverride(a)).slice(0, 2);
  const menuActs = restActs.filter((a) => !quietActs.includes(a));
  const iconOf = (a: typeof availableActions[number]) => actionLoading === a.action ? <Loader2 className="w-4 h-4 animate-spin" /> : a.action === 'save_progress' ? <Save className="w-4 h-4" /> : null;
  const moreMenu = [
    { icon: <HelpCircle className="w-4 h-4" />, label: "How a request flows", onClick: () => setShowWorkflowDiagram(true) },
    { icon: <QrCode className="w-4 h-4" />, label: "Print the traveler", onClick: async () => {
      const { printTicketTraveler } = await import("@/lib/physicalBridge");
      await printTicketTraveler({
        ticketRowId: ticketId,
        ticketNumber: ticket.ticketId ?? null,
        title: ticket.title,
        status: ticket.status,
        requesterName: ticket.requesterName ?? null,
        drafterName: ticket.assignedDrafterName ?? null,
        createdAt: ticket.createdAt ? String(ticket.createdAt) : null,
        deliverableRev: ticket.deliverableRev ?? null,
      });
    } },
    ...(isAdmin && ticket.assignedDrafterId && ticket.status !== 'CLOSED' ? [{ icon: <UserPlus className="w-4 h-4" />, label: "Reassign the drafter", onClick: () => handleReassignClick() }] : []),
    ...menuActs.map((a, i) => ({ icon: isDanger(a) ? <ShieldAlert className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />, label: sentence(a.label), onClick: () => initiateWorkflowAction(a), tone: isDanger(a) ? "bad" as const : undefined, line: i === 0 })),
  ];
  const stepAt = requestStepIndex(ticket.status);
  const canAddFile = activeRole === 'Drafter' || activeRole === 'Requester' || activeRole === 'Admin' || uid === ticket.requesterId;
  const pastDue = isPastDue(ticket);
  const nearDue = !pastDue && isNearingDue(ticket);
  const onYou = isActionRequired(ticket, { uid, roles });
  const who = waitingOn(ticket);
  const watching = (ticket.watchers ?? []).includes(uid ?? '');
  const lateDays = pastDue && ticket.targetCompletionAt ? Math.max(1, Math.floor((Date.now() - toDate(ticket.targetCompletionAt).getTime()) / 86_400_000)) : 0;
  // Words, not numbers: every fact the same small size.
  const facts: HeroFact[] = [
    { label: 'Waiting on', value: onYou ? 'You' : (who ?? 'Nobody'), tone: onYou ? 'warn' as const : undefined },
    { label: pastDue ? `Due, ${lateDays} day${lateDays === 1 ? '' : 's'} late` : 'Due', value: ticket.targetCompletionAt ? fmtDay(ticket.targetCompletionAt) : 'None', tone: pastDue ? 'bad' as const : nearDue ? 'warn' as const : undefined },
    { label: 'Priority', value: typeof ticket.priority === 'number' ? (ticket.priority === 1 ? 'P1 urgent' : `P${ticket.priority}`) : 'None', tone: ticket.priority === 1 ? 'bad' as const : undefined },
  ];
  const stagedNote = hasStagedFiles
    ? (availableActions.some((a) => a.action === 'submit_draft') ? ' Your drafts aren’t sent yet: Send draft for review sends them.' : ' Drafts are added but not sent to the requester yet.')
    : '';
  // Sent here because it waits on you (?ask=turn): the step, who asked and
  // by when go first, with the step's button (then the header's is quiet).
  const askTurn = readAsk(searchParams.get('ask')) === 'turn';
  const askHasPrimary = askTurn && onYou && !!mainAct;
  const quietButtons = quietActs.map((a) => (
    <button key={a.action + a.label} type="button" onClick={() => initiateWorkflowAction(a)} disabled={!!actionLoading} className={heroQuiet}>
      {iconOf(a)}{sentence(a.label)}
    </button>
  ));

  // Files, in the order the work needs them: drafts before the issued set
  // while it's being drawn, the issued set first once it's out.
  const issuedFirst = ['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status);
  type FileRow = { file: TicketAttachment; kind: string; tag?: React.ReactNode; faded?: boolean; redline?: boolean; issued?: boolean };
  const fileGroups: Array<{ key: string; label: React.ReactNode; empty: string; rows: FileRow[] }> = [
    { key: 'source', label: 'Source and reference', empty: 'No source files.', rows: sourceFiles.map((f) => ({ file: f, kind: f.name?.startsWith('REDLINE_') ? 'Redlines' : f.type === 'Reference' ? 'Reference' : 'Source' })) },
    { key: 'drafts', label: 'Drafts', empty: 'No drafts yet.', rows: sortedDrafts.map((f, i) => ({
      file: f, kind: i === 0 ? 'Latest draft' : 'Earlier draft', faded: i > 0,
      tag: f.status === 'staged' ? <StatusTag tone="warn">Not sent yet</StatusTag> : undefined,
      redline: i === 0 && ticket.status === 'PENDING_REVIEW' && ticket.requesterId === uid,
    })) },
    { key: 'issued', label: <>Issued for construction{finalFiles.length > 0 && ticket.deliverableRev && /^\d+$/.test(ticket.deliverableRev) ? `, Rev ${ticket.deliverableRev}` : ''}</>, empty: 'Nothing issued yet.', rows: finalFiles.map((f) => ({ file: f, kind: 'Issued', issued: true })) },
  ];
  if (issuedFirst) fileGroups.splice(1, 2, fileGroups[2], fileGroups[1]);
  const fileCount = fileGroups.reduce((n, g) => n + g.rows.length, 0);
  const pickFile = canAddFile && !ticket.archivedAt ? (
    <label className={`${heroQuiet} cursor-pointer ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
      <UploadCloud aria-hidden className="w-4 h-4" /> Add a file
      <input
        type="file"
        className="sr-only"
        disabled={isUploading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Everyone says what kind of file it is.
          if (file) { setUploadError(null); setFailedUpload(null); setFileToUpload(file); }
          e.target.value = '';
        }}
      />
    </label>
  ) : null;

  // The history, newest first, in days.
  const historyDays = (() => {
    const rows = [...(ticket.history ?? [])].reverse();
    const out: Array<{ day: string; items: typeof rows }> = [];
    for (const ev of rows) {
      const d = toDate(ev.date);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const diff = Math.round((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
      const day = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : fmtDay(d);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(ev); else out.push({ day, items: [ev] });
    }
    return out;
  })();

  return (
    <PageShell width="full">
      <div className="mx-auto max-w-[1920px]">

      {/* MODALS */}
      {showRedlineEditor && fileToRedline && (
        <RedlineEditorMount
          file={fileToRedline}
          onClose={() => setShowRedlineEditor(false)}
          onSave={handleRedlineSave}
          isSaving={isUploading}
        />
      )}
      {showArchiveViewer && ticket?.id && (
        <TicketArchiveViewer
          ticketRowId={ticket.id}
          ticketLabel={ticket.ticketId}
          archiveId={ticket.archiveId}
          onClose={() => setShowArchiveViewer(false)}
        />
      )}
      <FileViewerModal
        isOpen={!!viewerFile}
        file={viewerFile}
        onClose={() => setViewerFile(null)}
        ticketId={ticket?.ticketId}
        ticketRowId={ticket?.id}
        deliverableRev={ticket?.deliverableRev}
        orgId={activeOrgId ?? undefined}
        userId={uid ?? undefined}
        archived={!!ticket?.archivedAt}
        archiveId={ticket?.archiveId}
        onApprove={(() => {
          const action = availableActions.find(a => a.action === 'approve_draft_ifc');
          return action ? () => { setViewerFile(null); initiateWorkflowAction(action); } : undefined;
        })()}
      />
      {showCommentModal && (
      <ActionModal
        draftKey={actionDraftKey(pendingAction)}
        onClose={() => setShowCommentModal(false)}
        title={pendingAction?.action === 'approve_minor_correction' ? 'Approve with a small fix' : pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject' ? 'Ask for a revision' : pendingAction?.variant === 'destructive' ? 'Send it back' : (pendingAction?.label ?? 'Add a comment')}
        description={pendingAction?.action === 'approve_minor_correction' ? 'Say what to fix (a typo, a label). It is approved now; the drafter fixes it in the issued file with no new review.' : pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject' ? 'Say what needs to change.' : pendingAction?.variant === 'destructive' ? 'Say why it is going back.' : 'Add a comment for the record.'}
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
      )}
      {showAssignModal && (
        <AssignmentModal onClose={() => { setShowAssignModal(false); setIsReassigning(false); }} onSubmit={(id, name, reason) => pendingAction && executeWorkflowAction(pendingAction, reason, {id, name})} isLoading={!!actionLoading} activeOrgId={activeOrgId} isReassignment={isReassigning} currentDrafterId={isReassigning ? ticket.assignedDrafterId : null} draftKey={actionDraftKey(pendingAction)} />
      )}
      {showUploadIFC && (
        <UploadIFCModal onClose={() => { setShowUploadIFC(false); setIfcError(null); }} onSubmit={handleIFCUpload} isLoading={!!actionLoading} error={ifcError} />
      )}

      {showWorkflowDiagram && (
        <WorkflowDiagramModal current={ticket.status} onClose={() => setShowWorkflowDiagram(false)} />
      )}

      {showEngineerPicker && pendingAction && activeOrgId && (
        <EngineerPickerModal
          isOpen={showEngineerPicker}
          onClose={() => { setShowEngineerPicker(false); setPendingAction(null); }}
          orgId={activeOrgId}
          currentEngineerId={pendingAction.action === 'reassign_engineer' ? ticket?.assignedEngineerId ?? undefined : undefined}
          draftKey={actionDraftKey(pendingAction)}
          title={
            pendingAction.action === 'request_final_engineer_approval' ? 'Send for engineer sign-off' :
            pendingAction.action === 'reassign_engineer' ? 'Change the engineer reviewer' :
            'Send for engineering review'
          }
          description={
            pendingAction.action === 'request_final_engineer_approval'
              ? 'Drawings need an engineer sign-off before IFC. The engineer you pick is notified.'
              : pendingAction.action === 'reassign_engineer'
                ? 'Pick who takes over the sign-off.'
                : 'Pick the engineer who checks the scope.'
          }
          commentLabel={pendingAction.action === 'request_final_engineer_approval' ? 'Note to the engineer *' : 'What needs to be reviewed? *'}
          commentPlaceholder={
            pendingAction.action === 'request_final_engineer_approval'
              ? "e.g. Please confirm orifice plate sizing on FE-201 is correct for the new flow conditions."
              : "What specifically should they look at?"
          }
          onSubmit={async ({ engineerId, engineerName, engineerEmail, comment }) => {
            if (!pendingAction) return;
            const ok = await executeWorkflowAction(
              pendingAction,
              comment,
              undefined,
              undefined,
              undefined,
              { id: engineerId, name: engineerName, email: engineerEmail }
            );
            // Keeps the dialog (and the note) open when it didn't go through.
            if (!ok) throw new Error("It didn't go through. Your note is still here.");
          }}
        />
      )}

      {fileToUpload && !isUploading && (() => {
        // The likely kind goes first and is the main button: a
        // drafter's upload is a draft, anyone else's a source file.
        const draftFirst = activeRole === 'Drafter' || ticket.assignedDrafterId === uid;
        const kinds: Array<{ type: 'Source' | 'Draft' | 'Reference'; label: string; icon: React.ReactNode }> = [
          { type: 'Draft', label: 'Draft drawing', icon: <FileText className="w-4 h-4" /> },
          { type: 'Source', label: 'Source file', icon: <FileIcon className="w-4 h-4" /> },
          { type: 'Reference', label: 'Reference', icon: <Paperclip className="w-4 h-4" /> },
        ];
        const ordered = draftFirst ? kinds : [kinds[1], kinds[0], kinds[2]];
        return (
          <Modal onClose={() => setFileToUpload(null)} size="sm">
            <ModalHeader title="What kind of file is it?" onClose={() => setFileToUpload(null)} />
            <ModalBody>
              <div className="p-3 border border-[var(--color-border)] rounded-xl mb-4 flex items-center gap-3">
                <FileThumb file={fileToUpload} />
                <div className="overflow-hidden">
                  <p className="font-semibold text-[15px] truncate text-[var(--color-text)]">{fileToUpload.name}</p>
                  <p className="text-[13px] text-[var(--color-text-muted)]">{(fileToUpload.name.split('.').pop() || 'file').toUpperCase()}, {formatBytes(fileToUpload.size)}</p>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {ordered.map((k, i) => (
                  <button key={k.type} type="button" onClick={() => handleFileUpload(k.type)} className={`${i === 0 ? heroPrimary : heroQuiet} w-full h-11`}>
                    {k.icon} {k.label}
                  </button>
                ))}
              </div>
            </ModalBody>
          </Modal>
        );
      })()}

      {/* The title block: which request, where it is, the one next step. */}
      <PageHero
        back={{ onClick: () => router.back(), label: 'Back' }}
        size="md"
        kicker={<span className="inline-flex items-center gap-2 min-w-0 max-w-full"><Link href="/requests" className="shrink-0 hover:text-[var(--color-text)] hover:underline underline-offset-2">Drafting requests</Link><span aria-hidden className="text-[var(--color-text-faint)]">/</span><CopyId value={ticket.ticketId} label="request number" className="text-[15px] min-w-0" /></span>}
        title={ticket.title}
        sub={<>{stateWords}{stagedNote}{availableActions.length === 0 ? ' Nothing for you to do here.' : ''}</>}
        facts={facts}
        factsHero="none"
        tools={
          <>
            {quietButtons.length > 0 && <div className="max-lg:hidden flex items-center gap-2">{quietButtons}</div>}
            <MoreMenu items={moreMenu} iconOnly label="More: how it flows, traveler, reassign, admin steps" triggerClass={heroQuiet} />
          </>
        }
        primary={mainAct && !askHasPrimary ? (
          <button type="button" onClick={() => initiateWorkflowAction(mainAct)} disabled={!!actionLoading} className={heroPrimary}>
            {iconOf(mainAct)}{sentence(mainAct.label)}
          </button>
        ) : undefined}
      >
        <div className="space-y-4">
          {stepAt >= 0 && (
            <button type="button" onClick={() => setShowWorkflowDiagram(true)} title="See what each step means" className="block w-full text-left rounded-lg -m-1.5 p-1.5 hover:bg-[var(--color-surface)]">
              <span className="sm:hidden block mb-2.5 text-[14px] font-semibold text-[var(--color-text)]">Step {stepAt + 1} of {REQUEST_STEPS.length}: {REQUEST_STEPS[stepAt]}</span>
              <span className="hidden sm:block">
                <StepLine steps={REQUEST_STEPS.map((label, i) => ({ label, state: i < stepAt ? 'done' : i === stepAt ? 'now' : 'next' }))} />
              </span>
              <span className="sm:hidden block">
                <StepLine steps={REQUEST_STEPS.map((_, i) => ({ label: '', state: i < stepAt ? 'done' : i === stepAt ? 'now' : 'next' }))} />
              </span>
            </button>
          )}
          {quietButtons.length > 0 && <div className="lg:hidden flex flex-wrap gap-2">{quietButtons}</div>}
        </div>
      </PageHero>

      <PageBody>
      {askTurn && (
        <RequestAsk
          ticket={ticket}
          uid={uid ?? null}
          onYou={onYou}
          stateWords={stateWords}
          main={mainAct ? { label: sentence(mainAct.label), run: () => initiateWorkflowAction(mainAct) } : null}
          others={quietActs.map((a) => ({ label: sentence(a.label), run: () => initiateWorkflowAction(a) }))}
          busy={!!actionLoading}
          dueIso={ticket.targetCompletionAt ? toDate(ticket.targetCompletionAt).toISOString() : null}
          pastDue={pastDue}
        />
      )}
      {justSent && ticket.requesterId === uid && emailAsk && emailAsk !== 'hidden' && (
        // Sent: the one moment email updates mean something. Says what they
        // bring; never asks when they're already on.
        <section aria-label="Request sent" className="relative rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 sm:px-5 py-4 flex flex-wrap items-center gap-x-4 gap-y-3">
          <CheckCircle2 aria-hidden className="w-5 h-5 shrink-0 text-[var(--state-released)]" />
          <div className="min-w-0 flex-1 basis-[260px]">
            <p className="text-[15px] font-semibold text-[var(--color-text)]">Sent.{ticket.status === 'PENDING_ASSIGNMENT' ? ' A supervisor assigns a drafter next.' : ''}</p>
            {emailAsk === 'off' ? (
              <p className="text-[14px] text-[var(--color-text-muted)]">Email you when a drafter picks up {ticket.ticketId} and when the draft is ready for your review?</p>
            ) : (
              <p className="text-[14px] text-[var(--color-text-muted)]">
                {emailDone ? 'Email is on. ' : ''}You&apos;ll get an email when a drafter picks it up and when the draft is ready for your review. <Link href="/settings/notifications" className="text-[var(--color-accent-text)] hover:underline underline-offset-2">Email settings</Link>
              </p>
            )}
            {emailError != null && <ErrorNote compact className="mt-1" error={emailError} title="Email wasn't turned on." onRetry={() => void turnOnEmail()} />}
          </div>
          {emailAsk === 'off' ? (
            <div className="flex items-center gap-2">
              <button type="button" onClick={closeSent} className={heroQuiet}>Not now</button>
              <Button variant={mainAct ? 'secondary' : 'primary'} loading={emailSaving} onClick={() => void turnOnEmail()}>Turn on email</Button>
            </div>
          ) : (
            <button type="button" onClick={closeSent} aria-label="Close" title="Close" className="w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
          )}
        </section>
      )}
      {ticket.status === 'REVISION_REQ' && latestRevision && (() => {
        // Redlines sent with the revision, so the drafter finds them here.
        const redlines = (ticket.attachments || [])
          .filter((a) => a.name?.startsWith('REDLINE_'))
          .sort((a, b) => toDate(b.uploadedAt).getTime() - toDate(a.uploadedAt).getTime());
        return (
          <Card label="What to fix" action={redlines[0] ? (
            <button type="button" onClick={() => setViewerFile(redlines[0])} className={heroQuiet}><Pen className="w-4 h-4" /> Open the redlines</button>
          ) : undefined} className="relative overflow-hidden">
            <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-held)]" />
            {latestRevision.category && <StatusTag tone="warn">{latestRevision.category}</StatusTag>}
            <p className="text-[16px] text-[var(--color-text)] mt-1.5 whitespace-pre-wrap leading-relaxed max-w-[75ch]">{latestRevision.text}</p>
            <p className="text-[13px] text-[var(--color-text-muted)] mt-1.5">
              {authorLabel(latestRevision.user ?? 'Reviewer')}{latestRevision.date ? `, ${fmtWhen(latestRevision.date)}` : ''}
            </p>
          </Card>
        );
      })()}

      {ticket.archivedAt && (() => {
        const sum = (ticket.metadata?.archive_summary ?? {}) as {
          commentCount?: number; attachmentCount?: number; attachmentNames?: string[]; historyCount?: number;
        };
        const names = Array.isArray(sum.attachmentNames) ? sum.attachmentNames : [];
        const hasShape = !!(sum.commentCount || sum.attachmentCount || sum.historyCount);
        return (
          <Card label="Archived" action={
            <button type="button" onClick={() => setShowArchiveViewer(true)} className={heroQuiet}><Archive className="w-4 h-4" /> Open from the archive</button>
          }>
            <p className="text-[15px] text-[var(--color-text)]">
              Its files and comments moved to the archive{ticket.archiveId ? <> <span className="font-display font-semibold">{ticket.archiveId}</span></> : ''}.
              <HelpTooltip>Have the archive file{ticket.archiveId ? <> (<span className="break-all">&lt;root&gt;/data/{ticket.archiveId}.zip</span>)</> : ''}? Open it here. An admin can restore it fully on the Storage and backup page.</HelpTooltip>
            </p>
            {hasShape && (
              <p className="mt-2 text-[14px] text-[var(--color-text-muted)] tabular-nums">
                {sum.commentCount ?? 0} comments, {sum.attachmentCount ?? 0} files, {sum.historyCount ?? 0} history events{names.length > 0 ? `: ${names.join(', ')}${(sum.attachmentCount ?? 0) > names.length ? `, and ${(sum.attachmentCount ?? 0) - names.length} more` : ''}` : ''}
              </p>
            )}
          </Card>
        );
      })()}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] gap-x-6 gap-y-8 items-start">
        {/* LEFT: the request and its files */}
        <div className="space-y-8 min-w-0">
          <Card label="Scope of work">
            <p className="text-[16px] text-[var(--color-text)] leading-relaxed whitespace-pre-wrap max-w-[80ch]">{ticket.description || <Muted>No scope written.</Muted>}</p>
            <dl className="mt-4 pt-4 border-t border-[var(--color-border)] grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-[14px]">
              {([
                ['Unit', ticket.unit ? `Unit ${ticket.unit}` : <Muted key="u">None</Muted>],
                ['Type', ticket.requestType || <Muted key="t">None</Muted>],
                ['Requester', <span key="r" title={ticket.requesterEmail || undefined}>{ticket.requesterName || <Muted>Unknown</Muted>}</span>],
                ['Drafter', ticket.assignedDrafterName || <Muted key="d">None yet</Muted>],
                ['Started', fmtDay(ticket.createdAt)],
                ['Engineer reviewer', ticket.assignedEngineerName ? (
                  <span key="e" className="inline-flex flex-wrap items-center gap-x-2" title={ticket.assignedEngineerEmail || undefined}>
                    {ticket.assignedEngineerName}
                    {ticket.engineerApprovedAt && <StatusTag tone="good">Approved</StatusTag>}
                  </span>
                ) : <Muted key="e">None</Muted>],
                ['Deliverable', ticket.deliverableRev ? `Rev ${ticket.deliverableRev}` : <Muted key="rev">Not issued yet</Muted>],
                ['Watchers', (
                  <span key="w" className="inline-flex items-center gap-2">
                    <span className="tabular-nums">{(ticket.watchers ?? []).length}</span>
                    <button type="button" onClick={toggleWatch} aria-pressed={watching}
                      className="inline-flex items-center gap-1 text-[14px] font-semibold text-[var(--color-accent-text)] hover:underline underline-offset-2">
                      {watching ? <><Check aria-hidden className="w-3.5 h-3.5" /> Watching</> : <><Eye aria-hidden className="w-3.5 h-3.5" /> Watch</>}
                    </button>
                  </span>
                )],
              ] as Array<[string, React.ReactNode]>).map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-[13px] text-[var(--color-text-muted)]">{label}</dt>
                  <dd className="mt-0.5 text-[var(--color-text)] min-w-0 truncate">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          {/* Files: drop one anywhere here to add it. */}
          <section {...filesDrag.bind} aria-labelledby="req-files" className={`min-w-0 rounded-xl ${filesDrag.ring}`}>
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2 mb-3 min-h-8">
              <h2 id="req-files" className="font-display text-[20px] leading-tight font-semibold text-[var(--color-text)]">
                Files {fileCount > 0 && <span className="ui-count">{fileCount}</span>}
              </h2>
              <div className="flex-1" />
              {filesDrag.over
                ? <span className="text-[14px] font-semibold text-[var(--color-text)]">{filesDrag.say}</span>
                : !ticket.archivedAt && canAddFile && <span className="max-md:hidden text-[13px] text-[var(--color-text-muted)]">Drop a file here, or</span>}
              {pickFile}
            </div>
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
              {/* The file going up (or the one that didn't), first: its own progress and its own Try again. */}
              {(upFile || failedUpload) && (() => {
                const u = upFile ?? failedUpload!;
                const failed = !upFile;
                return (
                  <div className="relative flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]" aria-live="polite">
                    {failed && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
                    <FileThumb file={u.file} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-semibold text-[var(--color-text)] truncate">{u.file.name}</p>
                      {failed ? (
                        <p className="text-[13px] text-[var(--state-overdue-text)]">Not added. {uploadError}</p>
                      ) : (
                        <div className="mt-1 flex items-center gap-2">
                          <span className="block h-1.5 flex-1 max-w-64 rounded-full bg-[var(--color-surface-2)] overflow-hidden" role="progressbar" aria-label={`Uploading ${u.file.name}`} aria-valuenow={Math.round(uploadProgress)} aria-valuemin={0} aria-valuemax={100}>
                            <span className="block h-full bg-[var(--color-main)] transition-[width] duration-200" style={{ width: `${Math.max(3, uploadProgress)}%` }} />
                          </span>
                          <span className="text-[13px] tabular-nums text-[var(--color-text-muted)]">{uploadProgress.toFixed(0)}% of {formatBytes(u.file.size)}, as {u.type === 'Draft' ? 'a draft' : u.type.toLowerCase()}</span>
                        </div>
                      )}
                    </div>
                    {failed && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button type="button" onClick={() => void handleFileUpload(u.type, u.file)} className={`${heroQuiet} h-8`}><RotateCcw aria-hidden className="w-3.5 h-3.5" /> Try again</button>
                        <button type="button" onClick={() => { setFailedUpload(null); setUploadError(null); }} aria-label={`Remove ${u.file.name}`} title="Remove" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
                      </div>
                    )}
                  </div>
                );
              })()}
              <table className="w-full text-[14px]">
                <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
                  <tr>
                    <th className="font-semibold px-4 h-10 w-full">File</th>
                    <th className="font-semibold px-4 h-10 hidden sm:table-cell">Kind</th>
                    <th className="font-semibold px-4 h-10 hidden lg:table-cell text-right">Size</th>
                    <th className="font-semibold px-4 h-10 hidden sm:table-cell">Added</th>
                    <th className="h-10 pr-3"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                {fileGroups.map((g) => (
                  <tbody key={g.key} className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
                    <tr><th colSpan={5} scope="colgroup" className="px-4 pt-3 pb-1.5 text-left text-[13px] font-semibold text-[var(--color-text-muted)]">{g.label}</th></tr>
                    {g.rows.length === 0 ? (
                      <tr><td colSpan={5} className="px-4 pb-3 text-[13px] text-[var(--color-text-faint)]">{g.empty}</td></tr>
                    ) : g.rows.map((r) => (
                      <tr key={r.file.id || r.file.name} onClick={(e) => { if ((e.target as HTMLElement).closest('button,a')) return; setViewerFile(r.file); }}
                        className={`cursor-pointer hover:bg-[var(--color-surface-2)] ${r.faded ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text)]'}`}>
                        <td className="px-4 py-2.5 max-w-0">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span aria-hidden className={`shrink-0 ${r.issued ? 'text-[var(--state-released)]' : 'text-[var(--color-text-faint)]'}`}>
                              {r.issued ? <CheckSquare className="w-4 h-4" /> : r.kind.includes('draft') ? <FileText className="w-4 h-4" /> : <FileIcon className="w-4 h-4" />}
                            </span>
                            <button type="button" onClick={() => setViewerFile(r.file)} title={`Open ${r.file.name}`} className={`min-w-0 text-left truncate hover:text-[var(--color-accent-text)] ${r.faded ? '' : 'font-semibold'}`}>{r.file.name}</button>
                          </div>
                          <div className="sm:hidden pl-[26px] text-[13px] text-[var(--color-text-muted)] flex flex-wrap items-center gap-x-2">{r.kind}{r.file.uploadedAt ? `, ${fmtDay(r.file.uploadedAt)}` : ''}{r.tag}</div>
                        </td>
                        <td className="px-4 py-2.5 hidden sm:table-cell whitespace-nowrap">
                          <span className="flex flex-col items-start gap-0.5">
                            <span>{r.kind}</span>
                            {r.tag}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 hidden lg:table-cell whitespace-nowrap tabular-nums text-right text-[var(--color-text-muted)]">{r.file.size}</td>
                        <td className="px-4 py-2.5 hidden sm:table-cell whitespace-nowrap tabular-nums text-[var(--color-text-muted)]" title={fmtWhen(r.file.uploadedAt)}>
                          {fmtDay(r.file.uploadedAt)}{r.file.uploadedBy ? ` by ${shortName(r.file.uploadedBy)}` : ''}
                        </td>
                        <td className="pr-3 py-1.5 whitespace-nowrap text-right">
                          {r.redline && (
                            <button type="button" onClick={() => { setFileToRedline(r.file); setShowRedlineEditor(true); }} className={`${heroQuiet} h-8`}>
                              <Pen className="w-3.5 h-3.5" /> Redline
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          </section>

          {/* Formal approvals / e-signatures */}
          {ticket.id && (
            <SignaturePanel
              resourceType="ticket"
              resourceId={ticket.id}
              resourceLabel={`request ${ticket.ticketId}`}
              canSign={activeRole === 'Admin' || activeRole === 'DocCtrl' || (activeRole?.includes('Engineer') ?? false)}
              // The formal sign-off is due when the request waits on you for final approval.
              yourTurn={onYou && ticket.status === 'PENDING_FINAL_APPROVAL'}
            />
          )}
        </div>

        {/* RIGHT: discussion and history */}
        <section className="min-w-0 xl:sticky xl:top-4">
          <div className="mb-3 min-h-8 flex items-end">
            <UnderlineTabs size="lg" label="Discussion and history" idBase="req-activity" value={activeTab} onChange={setActiveTab}
              tabs={[{ key: 'discussion', label: 'Discussion', count: ticket.comments?.length ?? 0 }, { key: 'audit', label: 'History', count: ticket.history?.length ?? 0 }]} />
          </div>
          <div id="req-activity-panel" role="tabpanel" aria-labelledby={`req-activity-${activeTab}`}
            className="flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] h-[min(70dvh,640px)] xl:h-[calc(100dvh-170px)] min-h-[420px]">
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto custom-scrollbar relative">
            {activeTab === 'discussion' && (
              <>
                {(!ticket.comments || ticket.comments.length === 0) && <p className="px-4 py-10 text-center text-[15px] text-[var(--color-text-muted)]">No comments yet. Ask a question or leave a note below.</p>}
                <ol className="divide-y divide-[var(--color-border)]">
                {ticket.comments?.map((comment, idx) => {
                  const kindTag = comment.type === 'Rejection' || comment.type === 'Revision'
                    ? <StatusTag tone="warn">Revision asked</StatusTag>
                    : comment.type === 'Approval' ? <StatusTag tone="good">Approved</StatusTag>
                    : comment.type === 'Reassignment' ? <StatusTag>Reassigned</StatusTag>
                    : comment.type && comment.type !== 'General' ? <StatusTag>{comment.type}</StatusTag> : null;
                  const mine = comment.user === userEmail;
                  return (
                  <li key={`${comment.id}-${idx}`} id={`comment-${comment.id}`} className={`flex gap-3 px-4 py-3.5 transition-colors ${highlightCommentId === comment.id ? 'bg-[var(--color-surface-2)]' : ''}`}>
                    <UserAvatar email={comment.user} size={28} rounded="full" className="shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-x-2 gap-y-0.5">
                        <span className="text-[15px] font-semibold text-[var(--color-text)]">{mine ? 'You' : authorLabel(comment.user)}</span>
                        <span className="text-[13px] text-[var(--color-text-muted)] tabular-nums" title={fmtWhen(comment.date)}>{relTime(comment.date)}</span>
                        {(comment as TicketComment & { editedAt?: string }).editedAt && <span className="text-[13px] text-[var(--color-text-muted)]">, edited</span>}
                        <span className="flex-1" />
                        {(mine || isAdmin) && editingTextId !== comment.id && (
                          <MoreMenu iconOnly label="Comment actions" triggerClass="-my-1 w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]" items={[
                            { icon: <Pencil className="w-4 h-4" />, label: 'Edit', onClick: () => { setEditingTextId(comment.id); setEditTextDraft(comment.text); } },
                            { icon: <Trash2 className="w-4 h-4" />, label: 'Delete', tone: 'bad', line: true, onClick: async () => { if (await appConfirm({ title: 'Delete this comment?', message: 'It cannot be brought back.', tone: "danger", confirmLabel: "Delete" })) void handleDeleteComment(comment.id); } },
                          ]} />
                        )}
                      </div>
                      {kindTag && (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          {kindTag}
                          {/* The reason on a sent-back comment; an admin can correct it. */}
                          {(comment.type === 'Rejection' || comment.type === 'Revision') && (
                            editingCommentId === comment.id ? (
                              <span className="inline-flex items-center gap-1">
                                <select aria-label="Reason" value={editCategoryVal} onChange={(e) => setEditCategoryVal(e.target.value)}
                                  className="h-8 pointer-coarse:h-11 px-2 rounded-lg border border-[var(--color-border-control)] text-[13px] max-sm:text-[16px] text-[var(--color-text)] bg-[var(--color-surface)]">
                                  {REVISION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                                <button type="button" onClick={() => handleUpdateCategory(comment.id)} aria-label="Save reason" title="Save reason" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg border border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"><Check className="w-3.5 h-3.5" /></button>
                                <button type="button" onClick={() => setEditingCommentId(null)} aria-label="Cancel" title="Cancel" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-3.5 h-3.5" /></button>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[13px] text-[var(--color-text-muted)]">
                                {comment.category || 'No reason given'}
                                {isAdmin && (
                                  <button type="button" onClick={() => { setEditingCommentId(comment.id); setEditCategoryVal(comment.category || REVISION_REASONS[0]); }}
                                    className="w-7 h-7 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]" title="Change the reason" aria-label="Change the reason">
                                    <Pen className="w-3 h-3" />
                                  </button>
                                )}
                              </span>
                            )
                          )}
                        </div>
                      )}
                      {editingTextId === comment.id ? (
                        <div className="mt-1.5 space-y-2">
                          <textarea value={editTextDraft} onChange={(e) => setEditTextDraft(e.target.value)} autoFocus rows={3} aria-label="Edit comment"
                            className={`${kitField} !h-auto py-2 resize-y [field-sizing:content]`} />
                          <div className="flex items-center gap-2 justify-end">
                            <button type="button" onClick={() => { setEditingTextId(null); setEditTextDraft(''); }} className={`${heroQuiet} h-8`}>Cancel</button>
                            <button type="button" onClick={() => void handleSaveCommentEdit(comment.id)} disabled={!editTextDraft.trim()} className={`${heroQuiet} h-8`}>Save</button>
                          </div>
                        </div>
                      ) : (
                        <CommentBody text={comment.text} currentUserId={uid ?? undefined} className="mt-1 text-[15px] leading-relaxed text-[var(--color-text)]" />
                      )}
                    </div>
                  </li>
                  );
                })}
                </ol>
              </>
            )}
            {activeTab === 'audit' && (
              historyDays.length === 0
                ? <p className="px-4 py-10 text-center text-[15px] text-[var(--color-text-muted)]">Nothing has happened yet.</p>
                : (
                  // Newest first, by day: what happened, who did it, when; the
                  // reason they gave under it.
                  <div className="px-4 py-3">
                    {historyDays.map((g) => (
                      <section key={g.day} className="mb-3 last:mb-0">
                        <h3 className="text-[13px] font-semibold text-[var(--color-text-muted)] py-1.5">{g.day}</h3>
                        <ol className="relative ml-1 border-l border-[var(--color-border-strong)]">
                          {g.items.map((event, idx) => {
                            const what = historyWords(event.action, event.details);
                            const note = event.details && !/^ticket created via portal$/i.test(event.details) && !/^uploaded \w+ file:/i.test(event.details) && !/^assigned to /i.test(event.details) ? event.details : null;
                            const reason = /\[reason: (.+)\]\s*$/i.exec(event.details || '')?.[1];
                            return (
                              <li key={`${g.day}-${idx}`} className="relative pl-4 py-2">
                                <span aria-hidden className="absolute -left-[4.5px] top-[15px] w-2 h-2 rounded-full bg-[var(--color-surface)] border-2 border-[var(--color-border-control)]" />
                                <div className="flex items-baseline justify-between gap-3">
                                  <span className="text-[15px] font-semibold text-[var(--color-text)] min-w-0">{what}</span>
                                  <span className="shrink-0 text-[13px] text-[var(--color-text-muted)] tabular-nums">{toDate(event.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                                </div>
                                <p className="text-[13px] text-[var(--color-text-muted)]">
                                  by {event.user ? shortName(event.user) : 'someone'}
                                  {(note || reason) && <span className="block mt-0.5 text-[14px] text-[var(--color-text)] whitespace-pre-wrap line-clamp-3">{reason ?? note}</span>}
                                </p>
                              </li>
                            );
                          })}
                        </ol>
                      </section>
                    ))}
                  </div>
                )
            )}
          </div>
          {activeTab === 'discussion' && (
            ticket.archivedAt ? (
              <p className="px-4 py-3 border-t border-[var(--color-border)] text-[13px] text-[var(--color-text-muted)]">
                Archived. Restore it to comment again.
              </p>
            ) : (
            <div className="p-3 border-t border-[var(--color-border)]">
              {activeOrgId && (
                <MentionableTextarea
                  value={newComment}
                  onChange={(next, mentions) => { setNewComment(next); setNewCommentMentions(mentions); }}
                  orgId={activeOrgId}
                  rows={3}
                  placeholder="Write a comment"
                />
              )}
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-[13px] text-[var(--color-text-muted)] min-w-0">
                  {newCommentMentions.length > 0 ? `${newCommentMentions.length} ${newCommentMentions.length === 1 ? 'person' : 'people'} will be notified` : null}
                </p>
                {/* Quiet until there's something to send. */}
                <Button size="sm" variant={newComment.trim() ? 'primary' : 'secondary'} onClick={() => handlePostComment(newComment)} disabled={!newComment.trim()}>
                  <Send className="w-3.5 h-3.5" /> Send
                </Button>
              </div>
            </div>
            )
          )}
          </div>
        </section>
      </div>
      </PageBody>
      </div>
    </PageShell>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--color-text-faint)]">{children}</span>;
}
