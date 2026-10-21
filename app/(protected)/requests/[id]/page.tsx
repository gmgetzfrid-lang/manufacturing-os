"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { uploadTicketAttachment, getSignedUrlForPath, ArchivedFileError } from '@/lib/storage';
import { useRole } from '@/components/providers/RoleContext';
import { useToast } from '@/components/providers/ToastProvider';
import { appAlert, appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import { Ticket, TicketStatus, TicketAttachment, TicketComment, DocumentRecord, type CustomCategoryConfig, type OrgDraftingSettings } from '@/types/schema';
import { WorkflowEngine, WorkflowAction, ticketResource, issueAsIsConfirmation, issueAsIsBanner, ISSUE_MARK_ACTIONS, currentRoster, routedNoRosterReason, workflowRefusalMessage, engineerPickQuestionApplies, separationOfDutiesActive } from '@/lib/workflow';
import { ticketReviewRouting } from '@/lib/routingControl';
import { loadCapabilityPolicyEntry, type CapabilityPolicy } from '@/lib/capabilityPolicy';
import { affordancePolicyFault } from '@/lib/checkoutAffordances';
import { flaggedRequestTypes } from '@/lib/requestTypes';
// drafting-flow Round G, DF-P9 TICKET-PAGE: the page's display layer and
// decisions (UI-1 / UI-4 / UI-7, EDGE-6 / ROUTE-8, SM-13, DCW-1 / DCW-7,
// PROJ-9, LEAK-9, HAND-7 / HAND-3, FRIC-3 / FRIC-8, DCW-5).
import { ticketStatusLabel, ticketUnitDisplay } from '@/lib/ticketStatusLabels';
import { attentionLabel, holdersFor, waitingSince, waitedFor, explainNoActions } from '@/lib/ticketAttention';
import { drafterCandidates, NO_DRAFTER_CANDIDATES, missingRequiredFile, triagePayload, customCategorySections, projectRefOf, engineerCandidates, type DrafterCandidate } from '@/lib/ticketPage';
import { reviewModelFieldsFromRow, engineerPickAvailable as pickAvailableFrom, engineeringOverrideOf, ticketAsDeclarationChecked, type DeclarationCheck } from '@/lib/reviewModel';
import { loadPickerMembers } from '@/lib/ticketPickerMembers';
import { loadRoutingContext, queuePool } from '@/lib/ticketRouting';
import { unitOptionsFor, type UnitOption } from '@/lib/ticketCreate';
import { loadCodebookUnitList } from '@/lib/ticketCreateClient';
import { OUTCOME_LABEL, type TicketOutcome } from '@/lib/ticketOutcome';
import { parseOutcomeReasons, outcomeChoiceGroups, decodeOutcomeChoice, type OutcomeReason } from '@/lib/ticketOutcomeReasons';
import LibraryPicker from '@/components/requests/LibraryPicker';
import SourceDriftBanner from '@/components/requests/SourceDriftBanner';
import EngineerPickerModal from '@/components/requests/EngineerPickerModal';
import TicketRosterPanel from '@/components/requests/TicketRosterPanel';
import DeclarationCard from '@/components/requests/DeclarationCard';
import MentionableTextarea from '@/components/requests/MentionableTextarea';
import TicketArchiveViewer from '@/components/archive/TicketArchiveViewer';
import CommentBody from '@/components/requests/CommentBody';
import WorkflowDiagramModal from '@/components/requests/WorkflowDiagramModal';
import SignaturePanel from '@/components/signatures/SignaturePanel';
import { extractMentionUids, isPastDue, isNearingDue } from '@/lib/notifications';
import { downloadStampedPdf } from '@/lib/stamping';
import { parseSourceDocument, revDrift } from '@/lib/sourceDocRef';
import { heldRoles } from '@/lib/roleHeld';
// GAP-6 / DEC-22: the ticket → document hand-back. Publish authority on the
// document's LIBRARY (or effective ownership) — never ticket authority.
import { docRowToDocumentRecord } from '@/lib/documentRows';
import { resolveCanControlLibrary } from '@/lib/documentGuards';
import { isEffectiveOwnerOfDocument } from '@/lib/ownership';
import { getMyTeamIds } from '@/lib/teams';
import { handbackPreset, latestFinalAttachment, deliverableStateOf } from '@/lib/ticketHandback';
import RevUpModal from '@/components/documents/RevUpModal';
import PublishNewDocumentModal from '@/components/requests/PublishNewDocumentModal';
import { findTicketNewDocumentVersion, newDocumentNotRecordedMessage, type TicketNewDocumentVersion } from '@/lib/ticketNewDocumentHandback';
import TicketCopyRecallPanel from '@/components/requests/TicketCopyRecallPanel';
import { canPutFirstRevisionInContainer } from '@/lib/revisions';
import { publicOrigin } from '@/lib/publicOrigin';
import { ticketCopyPlan, recordTicketCopy, type TicketCopyLiveFacts } from '@/lib/ticketDeliverableCopy';
import { ticketFileCopyPath, takeTicketCopy, serverUnavailableNotice, BROWSER_PATH_NOTE, NON_PDF_PRINT_NOTE, type TicketCopyContext, type TicketCopyRequestChannel } from '@/lib/ticketCopyRequest';
import { logAuditAction } from '@/lib/audit';
// Code-split: the redline editor pulls react-pdf/pdfjs + fabric + pdf-lib, none
// of which the request-detail page needs until the user actually opens markup.
const AdvancedRedlineEditor = dynamic(() => import('@/components/drafting/AdvancedRedlineEditor'), { ssr: false });
import UserAvatar from '@/components/ui/UserAvatar';
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
  QrCode,
} from 'lucide-react';
import { effectiveReviewControlForDocument } from '@/lib/reviewControl';

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
  onSubmit: (text: string, category?: string, outcome?: TicketOutcome, outcomeReason?: string) => void;
  onRedline?: () => void;
  title: string;
  description: string;
  isDestructive?: boolean;
  isLoading?: boolean;
  defaultValue?: string;
  showCategorySelection?: boolean;
  /** LEAK-9 (DF-P9): an action that ends the request (`requiresOutcome`)
   *  must say HOW — one of the engine action's `outcomes` (lib/ticketOutcome.ts),
   *  chosen here and sent as `outcome`; the free text stays the comment. */
  outcomeOptions?: readonly TicketOutcome[];
  /** GAP-13 / GAP-107 acceptance 1 (DF-P14): the workspace's own reasons
   *  (lib/ticketOutcomeReasons.ts). None → the categories, exactly as before;
   *  some → grouped under their categories (a category with none of its own
   *  offered bare), and the chosen reason is sent beside its category. */
  outcomeReasons?: readonly OutcomeReason[];
  /** The reasons could not be read: the categories are offered, and said
   *  (the route still refuses a bare category the workspace keeps reasons
   *  under, when it can read them — DF-P14 fix pass). */
  outcomeReasonsUnreadable?: boolean;
}

const ActionModal = ({ isOpen, onClose, onSubmit, onRedline, title, description, isDestructive, isLoading, defaultValue, showCategorySelection, outcomeOptions, outcomeReasons, outcomeReasonsUnreadable }: ActionModalProps) => {
  const [comment, setComment] = useState('');
  const [category, setCategory] = useState(REVISION_REASONS[0]);
  // The select's value: a category, or a configured reason ("reason:<id>").
  const [outcome, setOutcome] = useState<string>('');
  const needsOutcome = !!outcomeOptions && outcomeOptions.length > 0;
  const outcomeChoices = outcomeChoiceGroups(outcomeOptions ?? [], outcomeReasons ?? []);
  const chosen = outcome ? decodeOutcomeChoice(outcome, outcomeChoices.groups) : null;

  useEffect(() => {
    if (!isOpen) return;
    // Seed fields when the modal opens; IIFE keeps these out of the effect's
    // direct body so they aren't read as cascading synchronous updates.
    void (async () => {
      setComment(defaultValue || '');
      setCategory(REVISION_REASONS[0]);
      setOutcome('');
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
          {needsOutcome && (
            <div>
              <label className="block text-sm font-bold text-[var(--color-text)] mb-2">
                How does this request end? <span className="text-red-500">*</span>
              </label>
              <select
                data-testid="outcome-picker"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                className="w-full p-2.5 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface-2)] focus:ring-2 focus:ring-orange-500 outline-none"
              >
                <option value="">Choose one…</option>
                {outcomeChoices.grouped
                  ? outcomeChoices.groups.map((g) => (
                      <optgroup key={g.outcome} label={g.label}>
                        {g.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </optgroup>
                    ))
                  : outcomeOptions!.map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}
              </select>
              <p className="text-[10px] text-[var(--color-text-muted)] mt-1">Recorded on the request and counted in Admin → Analytics (&ldquo;How Requests Ended&rdquo;). Your reason below stays in the thread.</p>
              {outcomeReasonsUnreadable && (
                <p data-testid="outcome-reasons-unreadable" className="text-[10px] text-amber-700 mt-1">This workspace&rsquo;s own reasons could not be read, so only the categories are offered. If it keeps reasons under the one you choose, the request is refused and says so &mdash; reload and choose one of them.</p>
              )}
            </div>
          )}
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
              <button onClick={() => onSubmit(comment, showCategorySelection ? category : undefined, chosen?.outcome, chosen?.reasonId ?? undefined)} disabled={!comment.trim() || isLoading || (needsOutcome && !chosen)} className={`px-6 py-2 text-sm font-bold text-white rounded-lg shadow-sm transition-all flex items-center ${isDestructive ? 'bg-red-600 hover:bg-red-700 disabled:bg-red-300' : 'bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400'}`}>
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
  onSubmit: (drafterId: string, drafterName: string, reason?: string, triage?: { libraryId?: string; unit?: string }) => void;
  isLoading?: boolean;
  activeOrgId: string | null;
  isReassignment?: boolean;
  /** The ticket being assigned: its resource decides who may draft it, and
   *  triage reads its library and unit (DCW-1 / DCW-7). */
  ticket: Ticket;
  /** The org's capability policy (undefined → the shipped defaults, the
   *  same fallback the action buttons use while it loads). */
  policy: CapabilityPolicy | undefined;
  /** DCW-1 / DCW-7 (DF-P9): the assign action at PENDING_ASSIGNMENT carries
   *  the triage library and unit; a reassignment does not. */
  triage: boolean;
  /** The workspace's unit list (lib/ticketCreate.ts unitOptionsFor — the
   *  list the form offers and the route checks), and whether it could be read. */
  unitOptions: UnitOption[];
  unitListState: 'loading' | 'ready' | 'unreadable';
  /** Active members in the workspace: in an org of 3+ the route refuses the
   *  requester as their own request's drafter (separation of duties). */
  activeMemberCount: number;
}

const AssignmentModal = ({ isOpen, onClose, onSubmit, isLoading, activeOrgId, isReassignment, ticket, policy, triage, unitOptions, unitListState, activeMemberCount }: AssignmentModalProps) => {
  const [members, setMembers] = useState<Array<Record<string, unknown>>>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  // DCW-1: the picker starts on the ticket's own library (sent back
  // unchanged it is no change at the route); DCW-7: no unit change by default.
  const [libraryId, setLibraryId] = useState<string | null>(ticket.libraryId ?? null);
  const [unit, setUnit] = useState('');

  useEffect(() => {
    if (isOpen) {
      setReason(''); // Reset reason on open
      setLibraryId(ticket.libraryId ?? null);
      setUnit('');
      if (activeOrgId) {
        const fetchDrafters = async () => {
          setListError(null);
          try {
            // EDGE-6 / ROUTE-8: the role COLLECTION, never the headline alone
            // (the picker used to filter .eq('role', 'Drafter')) — so every
            // active member is read, in keyset pages (lib/ticketPickerMembers.ts),
            // so PostgREST's max-rows never hides someone the route accepts.
            const read = await loadPickerMembers(activeOrgId);
            if (!read.ok) { setListError(read.error); setMembers([]); return; }
            setMembers(read.rows);
          } catch (error) {
            console.error("Error fetching drafters:", error);
            setListError((error as Error)?.message || 'the members list could not be read');
          } finally {
            setLoadingList(false);
          }
        };
        fetchDrafters();
      }
    }
  }, [isOpen, activeOrgId, ticket.libraryId]);

  // Who the route will accept: holders of drafting authority on THIS
  // ticket (lib/ticketPage.ts drafterCandidates — the route's own test),
  // less the route's per-ticket refusals: the drafter already assigned is
  // not offered on a reassignment, and the requester (org of 3+) is shown
  // disabled with the reason.
  const drafters: DrafterCandidate[] = useMemo(
    () => drafterCandidates(members, policy, ticketResource(ticket), {
      requesterId: ticket.requesterId ?? null,
      assignedDrafterId: ticket.assignedDrafterId ?? null,
      isReassignment: !!isReassignment,
      activeMemberCount,
    }),
    [members, policy, ticket, isReassignment, activeMemberCount],
  );

  if (!isOpen) return null;

  const currentUnit = ticketUnitDisplay(ticket.unit, ticket.metadata);

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

          {triage && (
            <div data-testid="triage-fields" className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]">Triage details (optional)</p>
              <LibraryPicker orgId={ticket.orgId} currentLibraryId={ticket.libraryId ?? null} value={libraryId} onChange={setLibraryId} />
              <label className="block">
                <span className="block text-xs font-bold text-[var(--color-text-muted)] mb-1">Unit <span className="font-normal">(now: {currentUnit.text}{currentUnit.note ? ` — ${currentUnit.note}` : ''})</span></span>
                {unitListState === 'loading' ? (
                  <span className="block text-[11px] text-[var(--color-text-muted)]">Loading the unit list…</span>
                ) : unitListState === 'unreadable' ? (
                  <span role="alert" className="block text-[11px] text-amber-700">Couldn&apos;t load this workspace&apos;s unit list — assign now with no unit change, or set the unit later.</span>
                ) : unitOptions.length > 0 ? (
                  <select data-testid="triage-unit" value={unit} onChange={(e) => setUnit(e.target.value)} className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm">
                    <option value="">No change</option>
                    {unitOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input data-testid="triage-unit" value={unit} onChange={(e) => setUnit(e.target.value.toUpperCase())} placeholder="No change (this workspace has no unit list yet)" className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm" />
                )}
              </label>
            </div>
          )}

          <div className="max-h-[300px] overflow-y-auto custom-scrollbar border border-[var(--color-border)] rounded-lg">
            {loadingList ? (
              <div className="flex justify-center py-8"><Loader2 className="w-8 h-8 animate-spin text-orange-500" /></div>
            ) : listError ? (
              <div role="alert" className="p-4 text-center text-amber-800 text-sm">Couldn&apos;t load who can draft — {listError}. Close and try again.</div>
            ) : drafters.length === 0 ? (
              <div data-testid="no-drafters" className="p-4 text-center text-[var(--color-text-muted)] text-sm">{NO_DRAFTER_CANDIDATES}</div>
            ) : (
              <div className="grid grid-cols-1 gap-1">
                {drafters.map(drafter => (
                  <button 
                    key={drafter.uid} 
                    data-refused={drafter.refusedReason ? 'true' : undefined}
                    title={drafter.refusedReason}
                    onClick={async () => {
                      if (drafter.refusedReason) return;
                      if (isReassignment && !reason.trim()) {
                        await appAlert({ message: "Please provide a reason for reassignment." });
                        return;
                      }
                      onSubmit(drafter.uid, drafter.name, reason, triage ? triagePayload(ticket, { libraryId, unit }) : undefined);
                    }}
                    disabled={isLoading || !!drafter.refusedReason} 
                    className="flex items-center p-3 hover:bg-orange-50 rounded-lg transition-colors group text-left w-full border border-transparent hover:border-orange-100 disabled:opacity-60 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                  >
                    <div className="h-10 w-10 rounded-full bg-[var(--color-surface-2)] group-hover:bg-[var(--color-surface)] flex items-center justify-center text-[var(--color-text-muted)] group-hover:text-orange-600 mr-4 border border-[var(--color-border)]"><User className="w-5 h-5" /></div>
                    <div className="min-w-0"><p className="font-bold text-[var(--color-text)] text-sm truncate">{drafter.name}</p><p className="text-xs text-[var(--color-text-muted)] truncate">{drafter.email}{drafter.roles.length > 0 ? ` · ${drafter.roles.join(', ')}` : ''}</p>{drafter.refusedReason && <p className="text-[11px] text-amber-700">{drafter.refusedReason}</p>}</div>
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
/** EVID-16 done-when 2 (DF-P15): the bearer the server copy route is called with. */
const copyToken = async (): Promise<string | null> => {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  } catch {
    return null;
  }
};

const FileViewerModal = ({
  file,
  isOpen,
  onClose,
  ticketId,
  ticketRowId,
  orgId,
  userId,
  onApprove,
  archived,
  archiveId,
  liveTicket,
  copyContext,
}: {
  file: TicketAttachment | null;
  isOpen: boolean;
  onClose: () => void;
  ticketId?: string;
  /** Row UUID — powers the /verify-ticket QR stamped on downloads. The
   *  revision on the QR and in the footer is the FILE's own (file.rev —
   *  PHYS-2), never the ticket's live deliverable_rev. */
  ticketRowId?: string;
  orgId?: string;
  userId?: string;
  onApprove?: () => void;
  archived?: boolean;
  archiveId?: string | null;
  /** The ticket as this page holds it — a WARNING input only (PHYS-2): a
   *  file the page knows is superseded, or whose ticket is being re-worked,
   *  is confirmed before stamping and stamped as such. Never the QR's rev. */
  liveTicket?: TicketCopyLiveFacts | null;
  /** EVID-16 done-when 2 (DF-P15): what decides whether the server copy
   *  route can issue this file (lib/ticketCopyRequest.ts ticketFileCopyPath)
   *  — the ticket's workspace, request number, requester and file list. */
  copyContext?: Omit<TicketCopyContext, 'ticketRowId'> | null;
}) => {
  const [showCompliance, setShowCompliance] = useState(false);
  // file.url is stored as the raw R2 storage path (orgs/<org>/tickets/...).
  // Resolve to a presigned download URL once the modal opens so the iframe
  // / img tags actually load. Without this they show "not found".
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // EVID-16 done-when 2 (DF-P15): the PDF preview of a file the server can
  // issue is the STAMPED server stream (POST /api/tickets/copy, channel
  // "view" — recorded as a VIEW on the ticket's audit trail); `previewStamped`
  // is set only then (false: the file could not be stamped, so the preview
  // is the original, said). `serverNote`: the route said it cannot issue this
  // file after all — the browser path, said.
  const [previewStamped, setPreviewStamped] = useState<boolean | null>(null);
  const [serverNote, setServerNote] = useState<string | null>(null);
  // EVID-16 transient fallback (ruled by the integrator at the DF-P15 merge,
  // 2026-10-20, DEC-90): the server copy was UNAVAILABLE for a print or
  // download (not refused) — serverNote is then said as such.
  const [serverUnavailable, setServerUnavailable] = useState(false);
  // DF-P15 fix (review): the route refused the stamped preview for a
  // TRANSIENT reason (a storage, membership or scope read failed) — the
  // presigned inline frame shows the original, said; copies still go
  // through the server (lib/ticketCopyRequest.ts takeTicketCopy).
  const [previewFallbackNote, setPreviewFallbackNote] = useState<string | null>(null);
  const { userEmail, activeRole } = useRole();
  const copyPath = file ? ticketFileCopyPath(file, { ...(copyContext ?? {}), ticketRowId: ticketRowId ?? null }) : null;
  const viaServer = copyPath?.kind === 'server';
  const fileIsPdf = !!file && (file.type?.includes('pdf') || file.name.toLowerCase().endsWith('.pdf'));

  useEffect(() => {
    // Archived tickets have had their attachment binaries shed to the cold
    // archive — don't try to sign a URL for a key that no longer exists.
    if (!isOpen || !file?.url || archived) { setResolvedUrl(null); setResolveError(null); setPreviewStamped(null); setServerNote(null); setServerUnavailable(false); setPreviewFallbackNote(null); return; }
    let alive = true;
    let objectUrl: string | null = null;
    setResolvedUrl(null);
    setResolveError(null);
    setPreviewStamped(null);
    setServerNote(null);
    setServerUnavailable(false);
    setPreviewFallbackNote(null);
    // If the stored value already looks like a fully-qualified URL (legacy
    // attachments uploaded before the path-only fix), pass it through.
    if (/^https?:\/\//i.test(file.url)) { setResolvedUrl(file.url); return; }
    const presign = () => {
      // SEC-7 / DEC-49: this viewer frames the PDF preview — a reviewed inline caller.
      getSignedUrlForPath(file.url, undefined, { inline: true })
        .then((u) => { if (alive) setResolvedUrl(u); })
        .catch((e) => { if (alive) setResolveError((e as Error).message); });
    };
    if (viaServer && fileIsPdf && ticketRowId && file.id) {
      void takeTicketCopy({
        ticketRowId, attachmentId: file.id, channel: 'view', fallbackName: file.name,
        getToken: copyToken, confirm: async () => true,
      }).then((out) => {
        if (!alive) return;
        if (out.kind === 'file') {
          objectUrl = URL.createObjectURL(out.blob);
          setResolvedUrl(objectUrl);
          setPreviewStamped(out.stamped);
        } else if (out.kind === 'browser' && out.previewOnly) {
          setPreviewFallbackNote(out.message);
          presign();
        } else if (out.kind === 'browser') {
          setServerNote(out.message);
          presign();
        } else {
          setResolveError(out.kind === 'refused' ? out.message : 'The preview was not shown.');
        }
      });
    } else {
      presign();
    }
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [isOpen, file?.url, file?.id, file?.name, archived, viaServer, fileIsPdf, ticketRowId]);

  if (!isOpen || !file) return null;

  const isPdf = fileIsPdf;
  const isImage = file.type?.includes('image') || file.name.match(/\.(jpeg|jpg|gif|png)$/i);

  // PHYS-2 / PHYS-9 / HAND-3: what this file's copy says — its OWN revision
  // on the QR and in the footer (none recorded → no ?r=, "cannot confirm"),
  // one control state for both marks, and "not a controlled document
  // revision". lib/ticketDeliverableCopy.ts.
  const planFor = (channel: "print" | "download") =>
    ticketCopyPlan({ file, ticketNumber: ticketId, ticketRowId, origin: publicOrigin(), channel, live: liveTicket });
  // A superseded or re-worked file is never stamped silently: the user is
  // asked first, and the stamp says what the page knows.
  const confirmStanding = async (plan: ReturnType<typeof planFor>) =>
    !plan.confirmMessage || (await appConfirm({ message: plan.confirmMessage, tone: "danger" }));

  // EVID-5 / PHYS-8: the copy's record is awaited and checked; a refusal never
  // blocks the copy, and it is said rather than swallowed.
  const recordCopy = async (channel: "print" | "download", stamped: boolean, watermark: string, expiresAt: Date) => {
    if (!orgId || !userId) return;
    const res = await recordTicketCopy(supabase, logAuditAction, {
      orgId, userId, userEmail: userEmail ?? null, userRole: activeRole ?? null,
      ticketRowId: ticketRowId ?? null, ticketNumber: ticketId ?? null,
      file, channel, stamped, watermark: stamped ? watermark : null, expiresAt,
    });
    if (!res.recorded) {
      await appAlert({
        message: `This ${channel === "print" ? "print" : "download"} is not fully recorded: ${res.error}. Tell Document Control which file you took, so the copy can be recalled if it changes.`,
        tone: "danger",
      });
    }
  };

  // EVID-16 done-when 2 (DF-P15): a file the server can issue is copied
  // through POST /api/tickets/copy — stamped and recorded in the request that
  // issues its bytes; its questions (a superseded file, an unstampable one)
  // are asked here and the answer sent back. The presigned URL is never used
  // to copy it. A file the server cannot issue keeps the browser path below,
  // and the viewer says so (BROWSER_PATH_NOTE / serverNote).
  const serverCopy = async (channel: Exclude<TicketCopyRequestChannel, 'view'>) => {
    if (!ticketRowId || !file.id) return { kind: 'browser' as const, message: BROWSER_PATH_NOTE.unaddressable };
    return takeTicketCopy({
      ticketRowId, attachmentId: file.id, channel, fallbackName: file.name,
      getToken: copyToken,
      confirm: (message) => appConfirm({ message, tone: "danger" }),
    });
  };

  // DF-P15 fix: only a PDF prints from the server's stream. A hidden frame
  // handed a non-PDF blob (application/octet-stream) makes the browser
  // DOWNLOAD it rather than print it — so an image or other non-PDF file
  // prints by the browser path (loaded from the file itself, recorded from
  // the tab, as before DF-P15), and the viewer says so. Its download still
  // goes through the server.
  const printViaServer = viaServer && fileIsPdf;
  const handlePrint = async () => {
    if (!printViaServer) return browserPrint();
    const out = await serverCopy("print");
    if (out.kind === 'declined') return;
    if (out.kind === 'browser') {
      setServerNote(out.message);
      setServerUnavailable(out.transient === true);
      await appAlert({ message: out.transient ? serverUnavailableNotice(out.message) : `The server could not issue this file (${out.message}). It will be stamped and recorded from your browser instead.` });
      // DF-P15 fix (review): a question the route already asked is not asked again.
      return browserPrint({ standingConfirmed: out.acknowledged === true });
    }
    if (out.kind === 'refused') { await appAlert({ message: out.message, tone: "danger" }); return; }
    const printUrl = URL.createObjectURL(out.blob);
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = printUrl;
    document.body.appendChild(frame);
    frame.onload = () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    };
    setTimeout(() => {
      document.body.removeChild(frame);
      URL.revokeObjectURL(printUrl);
    }, 60_000);
  };

  // The browser path (before DF-P15 every file's): the file is fetched from a
  // presigned URL, stamped in the tab and recorded from the tab. Kept for a
  // file the server cannot issue (lib/ticketCopyRequest.ts ticketFileCopyPath).
  // A preview that is the server's stamped stream is never re-stamped here:
  // the raw file is signed afresh.
  const browserSourceUrl = async (): Promise<string> =>
    (previewStamped === null ? resolvedUrl : null) || (/^https?:\/\//i.test(file.url) ? file.url : await getSignedUrlForPath(file.url));

  const browserPrint = async (opts: { standingConfirmed?: boolean } = {}) => {
    let sourceUrl: string;
    try { sourceUrl = await browserSourceUrl(); } catch { await appAlert({ message: 'Still loading file — try again in a moment.' }); return; }
    // Print the STAMPED stream, never the raw file: watermark + rev footer +
    // the verify QR, exactly like a download. Paper is where copies escape.
    let printUrl = sourceUrl;
    let stamped = false;
    const plan = planFor("print");
    if (!opts.standingConfirmed && !(await confirmStanding(plan))) return;
    try {
      const { stampPdf } = await import("@/lib/stamping");
      const blob = await stampPdf(sourceUrl, {
        userLabel: userEmail?.split("@")[0] || userId || "USER",
        email: userEmail || undefined,
        timestamp: new Date(),
        controlState: plan.controlState,
        verifyUrl: plan.verifyUrl,
        footerNotice: plan.footerNotice,
      });
      printUrl = URL.createObjectURL(blob);
      stamped = true;
    } catch {
      // Stamping failed (odd PDF / CORS): warn loudly instead of silently
      // printing an unmarked copy.
      const proceed = window.confirm(
        "Couldn't apply the watermark/QR stamp to this file. Print the UNSTAMPED copy anyway?",
      );
      if (!proceed) return;
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
    // Record the print on the audit trail either way — AFTER the print has
    // started, as the download path does: a slow or refused record never
    // delays or blocks the copy, and a refusal is said once it settles.
    await recordCopy("print", stamped, plan.watermark, new Date(Date.now() + 30 * 24 * 3600 * 1000));
  };

  const handleDownloadClick = () => {
    if (file.type === 'Draft') {
      setShowCompliance(true);
    } else {
      performDownload();
    }
  };

  const performDownload = async () => {
    if (!viaServer) return browserDownload();
    let fallBack = false;
    let standingConfirmed = false;
    try {
      const out = await serverCopy("download");
      if (out.kind === 'declined') return;
      if (out.kind === 'browser') {
        setServerNote(out.message);
        setServerUnavailable(out.transient === true);
        await appAlert({ message: out.transient ? serverUnavailableNotice(out.message) : `The server could not issue this file (${out.message}). It will be stamped and recorded from your browser instead.` });
        fallBack = true;
        standingConfirmed = out.acknowledged === true;
        return;
      }
      if (out.kind === 'refused') { await appAlert({ message: out.message, tone: "danger" }); return; }
      const href = URL.createObjectURL(out.blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = out.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } finally {
      setShowCompliance(false);
      if (fallBack) await browserDownload({ standingConfirmed });
    }
  };

  const browserDownload = async (opts: { standingConfirmed?: boolean } = {}) => {
    const now = new Date();
    const expiresAt = file.type === "Draft"
      ? new Date(now.getTime() + 72 * 60 * 60 * 1000)
      : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    let stamped = false;
    const plan = planFor("download");
    if (!opts.standingConfirmed && !(await confirmStanding(plan))) { setShowCompliance(false); return; }
    try {
      const downloadUrl = await browserSourceUrl();
      // Every downloaded copy carries a QR that answers "is this still the
      // latest revision of this ticket's deliverable?" — so a copy a PM
      // handed out keeps warning for itself after a new revision lands.
      await downloadStampedPdf({
        url: downloadUrl,
        filename: file.name,
        options: {
          userLabel: userEmail?.split("@")[0] || userId || "USER",
          email: userEmail || undefined,
          timestamp: now,
          expiresAt,
          controlState: plan.controlState,
          verifyUrl: plan.verifyUrl,
          footerNotice: plan.footerNotice,
        },
      });
      stamped = true;
    } catch (e) {
      console.warn("Stamp Generation Failed (likely CORS). Falling back to direct download.", e);
      // FALLBACK WITH A VOICE: the user still gets their file, but they are
      // told it's unmarked — a raw copy must never masquerade as a stamped one.
      await appAlert({
        message: "The watermark/QR stamp couldn't be applied to this file, so you're getting the ORIGINAL, unmarked copy. Treat it as uncontrolled and don't distribute it.",
        tone: "danger",
      });
      const link = document.createElement("a");
      link.href = await browserSourceUrl();
      link.download = file.name;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      // The record names the pull EITHER WAY — an unstamped fallback is
      // exactly the copy the distribution record most needs to know about —
      // and it records the watermark the stamper printed for this file's
      // control state (PHYS-9), never a caller literal.
      setShowCompliance(false);
      await recordCopy("download", stamped, plan.watermark, expiresAt);
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
            {!archived && file.type !== 'Draft' && (
               <button onClick={handlePrint} className="flex items-center px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-colors border border-slate-700">
                 <Printer className="w-4 h-4 mr-2" /> Print
               </button>
            )}
            {!archived && (
              <button
                onClick={handleDownloadClick}
                className={`flex items-center px-4 py-2 rounded-lg text-sm font-bold transition-colors shadow-lg ${file.type === 'Draft' ? 'bg-amber-600 hover:bg-amber-700 text-white' : 'bg-orange-600 hover:bg-orange-700 text-white'}`}
              >
                <Download className="w-4 h-4 mr-2" /> {file.type === 'Draft' ? 'Download w/ Warning' : 'Download'}
              </button>
            )}
            <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-full transition-colors text-[var(--color-text-faint)] hover:text-white">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        
        {/* EVID-16 done-when 2 (DF-P15): a file that keeps the browser path says so,
            and an unstamped server preview is marked. */}
        {!archived && (serverNote || previewFallbackNote || copyPath?.kind === 'browser' || previewStamped === false || (viaServer && !printViaServer && file.type !== 'Draft')) && (
          <div role="note" className="px-6 py-2 bg-amber-900/60 border-b border-amber-700 text-amber-100 text-xs relative z-50">
            {previewStamped === false
              ? 'Unstamped preview: the watermark / QR stamp could not be applied to this file, so this is the original. Treat it as uncontrolled.'
              : previewFallbackNote && !serverNote
                ? `Unstamped preview: the server could not show its stamped preview right now (${previewFallbackNote}), so this is the original from storage. Print and download still go through the server, stamped and recorded there.`
              : serverNote && serverUnavailable
                ? serverUnavailableNotice(serverNote)
              : serverNote
                ? `The server could not issue this file (${serverNote}). Its copies are stamped and recorded from your browser.`
                : copyPath?.kind === 'browser' ? BROWSER_PATH_NOTE[copyPath.reason]
                  : NON_PDF_PRINT_NOTE}
          </div>
        )}

        <div className="flex-1 overflow-hidden relative bg-slate-900/50 flex items-center justify-center p-8">
          {/* VISUAL PROTECTION LAYER */}
          {file.type === 'Draft' && <WatermarkOverlay />}

          {archived ? (
            <div className="text-center p-12 bg-[var(--color-surface)] rounded-xl shadow-2xl max-w-md border border-sky-200 relative z-10">
              <div className="w-24 h-24 bg-sky-50 rounded-full flex items-center justify-center mx-auto mb-6 border border-sky-200">
                <Archive className="w-12 h-12 text-sky-500" />
              </div>
              <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">This file is in the archive</h3>
              <p className="text-[var(--color-text-muted)] leading-relaxed">
                It&apos;s not gone — because this ticket is long-closed, its files were moved to{' '}
                {archiveId ? <span className="font-mono font-bold">{archiveId}</span> : 'the offline archive'} to save storage.
                An admin can restore the ticket{archiveId && <> from <span className="font-mono break-all">&lt;root&gt;/data/{archiveId}.zip</span></>} to open it again.
              </p>
            </div>
          ) : isPdf ? (
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
  const { activeRole, roles, userEmail, activeOrgId, uid, hasAnyRole, member } = useRole();
  // The org's capability policy — so the buttons drawn here match what the
  // workflow-action route will actually allow (it re-derives with the same
  // policy). Undefined until loaded → defaults, which mirror historic rules.
  const [capPolicy, setCapPolicy] = useState<CapabilityPolicy | undefined>(undefined);
  // AUTHZ-15 (DF-P9; the integrator's ruling under DEC-89): the policy could
  // not be read and no last good copy was served (`unreadable`, or a read
  // that threw). Which actions this viewer may take is the policy's answer,
  // so the page offers none — it says why and offers Try again — instead of
  // drawing the shipped defaults as if they were the org's. (The workflow
  // route reads the policy on its own, through the service role, and refuses
  // every action when ITS read fails — DEC-89 item 3; the page cannot know
  // whether that read fails too, so it claims nothing about it.) A `stale`
  // answer is the last good policy and is drawn as is.
  const [policyFault, setPolicyFault] = useState<string | null>(null);
  const [policyAttempt, setPolicyAttempt] = useState(0);
  // DCW-7 (DF-P9): the unit list triage picks from — the list the request
  // form offers and the route checks (lib/ticketCreate.ts unitOptionsFor).
  const [unitOptions, setUnitOptions] = useState<UnitOption[]>([]);
  const [unitListState, setUnitListState] = useState<'loading' | 'ready' | 'unreadable'>('loading');
  // PROJ-9: the request form's custom categories, to label the answers.
  const [customCategoryConfig, setCustomCategoryConfig] = useState<CustomCategoryConfig[]>([]);
  // GAP-13 / GAP-107 (DF-P14): the workspace's own reasons for ending a
  // request (the drafting configuration's `outcomeReasons`); none → the
  // categories, as before. Unreadable → the categories, said in the dialog.
  const [outcomeReasons, setOutcomeReasons] = useState<OutcomeReason[]>([]);
  const [outcomeReasonsUnreadable, setOutcomeReasonsUnreadable] = useState(false);
  // Separation-of-duties binds at >= 3 active members, and close-without-review
  // is a property of the configured request type — both fetched here so the
  // buttons match the workflow-action route's evaluation of the same context.
  const [activeMemberCount, setActiveMemberCount] = useState(0);
  const [closeWithoutReviewTypes, setCloseWithoutReviewTypes] = useState<string[]>(['RFI']);
  // DRAFT-2: "engineering first" types gate assignment until engineering has
  // been in the loop — read from the same configured option list.
  const [engineeringFirstTypes, setEngineeringFirstTypes] = useState<string[]>([]);
  // DEC-16: the requester's CURRENT role collection, so the buttons drawn here
  // match the gate the route enforces (snapshot OR current). null = unknown.
  const [requesterRoles, setRequesterRoles] = useState<string[] | null>(null);
  // DF-P6 fix pass (review, issues 1 and 2): can the requester pick an
  // engineer at all? Read only where the route reads it
  // (engineerPickQuestionApplies); undefined = not asked / unknown.
  const [engineerPickAvailable, setEngineerPickAvailable] = useState<boolean | undefined>(undefined);
  // DF-P6 fix pass 4 (review, minor 6): the DeclarationCard's e-signature
  // check — a declaration that does not stand is evaluated as undeclared
  // here too (ticketAsDeclarationChecked), as the route does.
  const [declarationCheck, setDeclarationCheck] = useState<DeclarationCheck | 'pending'>('pending');
  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    void loadCapabilityPolicyEntry(activeOrgId).then((entry) => {
      if (!alive) return;
      const fault = affordancePolicyFault(entry);
      setPolicyFault(fault);
      setCapPolicy(fault ? undefined : entry.policy);
    }).catch((e: unknown) => {
      if (!alive) return;
      setPolicyFault((e as Error)?.message || 'the capability policy could not be read');
      setCapPolicy(undefined);
    });
    void supabase
      .from('org_members')
      .select('uid', { count: 'exact', head: true })
      .eq('org_id', activeOrgId)
      .eq('status', 'active')
      .then(({ count }) => { if (alive && typeof count === 'number') setActiveMemberCount(count); });
    void supabase
      .from('org_configurations')
      .select('data')
      .eq('org_id', activeOrgId)
      .eq('key', 'drafting')
      .maybeSingle()
      .then(({ data: cfgRow, error: cfgErr }) => {
        if (!alive) return;
        const opts = ((cfgRow?.data as { requestTypes?: { options?: Array<{ value?: string; closeWithoutReview?: boolean }> } } | null)
          ?.requestTypes?.options) ?? [];
        const flagged = opts.filter((o) => o.closeWithoutReview === true).map((o) => String(o.value ?? '')).filter(Boolean);
        if (flagged.length > 0) setCloseWithoutReviewTypes(flagged);
        setEngineeringFirstTypes(flaggedRequestTypes(cfgRow?.data, 'engineeringFirst'));
        const cfg = (cfgRow?.data ?? null) as OrgDraftingSettings | null;
        setCustomCategoryConfig(Array.isArray(cfg?.customCategories) ? cfg!.customCategories! : []);
        setOutcomeReasons(cfgErr ? [] : parseOutcomeReasons(cfgRow?.data));
        setOutcomeReasonsUnreadable(!!cfgErr);
        // DCW-7: the list the route checks a triage unit against — the saved
        // units, else the Site Codebook's. A list that cannot be read offers
        // no unit (the route would 503 an unchecked one).
        if (cfgErr) { setUnitListState('unreadable'); setUnitOptions([]); return; }
        void loadCodebookUnitList(activeOrgId).then(({ units, failure }) => {
          if (!alive) return;
          const options = unitOptionsFor(cfg, units);
          if (failure === 'unreadable' && options.length === 0) { setUnitListState('unreadable'); setUnitOptions([]); return; }
          setUnitOptions(options);
          setUnitListState('ready');
        });
      });
    return () => { alive = false; };
  }, [activeOrgId, policyAttempt]);
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

  // WF-18: the Reassign button used to post `assign` at DRAFTING, where the
  // engine never offers it — a guaranteed 403. It now carries the engine's
  // own `reassign_drafter` action (offered to `ticket.assign` holders once a
  // drafter is set), so the button exists exactly when the route will accept it.
  const handleReassignClick = (action: WorkflowAction) => {
    setIsReassigning(true);
    setPendingAction(action);
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
  const [showArchiveViewer, setShowArchiveViewer] = useState(false);
  // GAP-6 / DEC-22: the hand-back — a publish-authority holder publishes the
  // Final deliverable as the source document's next revision.
  const [showHandback, setShowHandback] = useState(false);
  const [handbackDoc, setHandbackDoc] = useState<DocumentRecord | null>(null);
  const [handbackFile, setHandbackFile] = useState<File | null>(null);
  const [handbackBusy, setHandbackBusy] = useState(false);
  const [canPublishSource, setCanPublishSource] = useState(false);
  // DCW-4 (DF-P15): "Publish as a new document in <library>" — a request
  // with a target library and no source document.
  const [canPublishNew, setCanPublishNew] = useState(false);
  const [targetLibraryName, setTargetLibraryName] = useState<string | null>(null);
  const [newDocFile, setNewDocFile] = useState<File | null>(null);
  const [newDocBusy, setNewDocBusy] = useState(false);
  // DCW-4 (DF-P15 fix, on review): a new document that already carries this
  // request but is not recorded on it (the hand-back failed after the
  // create) — offered as "Record <number> on the request", never re-created.
  // `versionId: null`: created, but its version could not be read back here.
  const [existingNewDoc, setExistingNewDoc] = useState<(Omit<TicketNewDocumentVersion, 'versionId' | 'documentNumber'> & { versionId: string | null; documentNumber: string | null }) | null>(null);
  const [recordingExisting, setRecordingExisting] = useState(false);
  // DCW-4 remainder (ruled by the integrator at the DF-P15 merge, 2026-10-20,
  // DEC-90; DEC-107 stands): a request with neither a source document nor a
  // library — the libraries where this publisher may put a first revision,
  // one of which they choose when publishing it as a new document.
  const [newDocLibraryChoices, setNewDocLibraryChoices] = useState<Array<{ id: string; name: string }>>([]);

  // Admin Override State
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCategoryVal, setEditCategoryVal] = useState<string>('');
  // Per-comment text editing
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editTextDraft, setEditTextDraft] = useState<string>('');

  // ADD-1: authority by the role COLLECTION, never the headline alone.
  const isAdmin = hasAnyRole(['Admin', 'DocCtrl']);

  // --- 1. DATA SYNC ---
  useEffect(() => {
    if (!ticketId) return;
    let alive = true;

    const fromRow = (r: Record<string, unknown>): Ticket => ({
      id: r.id as string, orgId: r.org_id as string, ticketId: r.ticket_id as string,
      title: r.title as string, description: r.description as string | undefined,
      // PERS-6: a NULL unit is a designed value ("Unit unknown"), never cast.
      unit: typeof r.unit === 'string' ? r.unit : null, requestType: r.request_type as string,
      status: r.status as Ticket['status'], priority: r.priority as number | undefined,
      requesterId: r.requester_id as string, requesterName: r.requester_name as string | undefined,
      requesterEmail: r.requester_email as string | undefined,
      requesterRole: r.requester_role as Ticket['requesterRole'],
      assignedDrafterId: r.assigned_drafter_id as string | null | undefined,
      assignedDrafterName: r.assigned_drafter_name as string | null | undefined,
      assignedEngineerId: r.assigned_engineer_id as string | null | undefined,
      assignedEngineerName: r.assigned_engineer_name as string | null | undefined,
      assignedEngineerEmail: r.assigned_engineer_email as string | null | undefined,
      // DCW-1: the triage picker starts on the ticket's library (20261208;
      // absent before the paste — no library, as today).
      libraryId: typeof r.library_id === 'string' ? r.library_id : null,
      // DF-P6 (20261250): the engine's engineering gate reads the work, not
      // who asked — undefined before the paste (today's gate decides). The
      // one mapper the route's rowToTicket shares (lib/reviewModel.ts).
      ...reviewModelFieldsFromRow(r),
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
      const { data } = await supabase.from('tickets').select('*').eq('id', ticketId).single();
      if (!alive) return;
      if (!data) { router.push('/requests'); return; }
      const t = fromRow(data as Record<string, unknown>);
      if (activeOrgId && t.orgId && t.orgId !== activeOrgId) { router.push('/requests'); return; }
      setTicket(t);
      // PERS-3 / LEAK-4 (DF-P9): clearing MY unread marker is the one ticket
      // write this page still makes (20261208's guard lets a client remove
      // only its own uid). It is checked now: a refusal, or a write that
      // matched no row, is said instead of passing as read.
      if (uid && t.unreadBy?.includes(uid)) {
        void supabase.from('tickets').update({ unread_by: t.unreadBy.filter(id => id !== uid) }).eq('id', ticketId).select('id')
          .then(({ data: hit, error }) => {
            if (!alive) return;
            if (error || !hit || hit.length === 0) {
              showToast({ type: 'warning', title: 'Not marked as read', message: `This request still shows as unread for you: ${error?.message || 'the update matched no row'}.` });
            }
          }, () => {});
      }
      // Opening the ticket counts as reviewing its activity: mark this ticket's
      // in-app notifications read so the bell + sidebar bubble actually clears
      // (clearing unread_by alone left the notification rows unread).
      if (uid) {
        void supabase.from('notifications')
          .update({ read_at: new Date().toISOString() })
          .eq('user_id', uid).eq('resource_id', ticketId).is('read_at', null)
          .then(({ error }) => {
            if (error) console.warn('[ticket] notifications for this request were not marked read:', error.message);
          }, () => {});
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
    // showToast is the provider's stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId, router, activeOrgId, uid]);

  // The ticket's source-document backlink (metadata.source_document), plus a
  // live read of that document's CURRENT revision so the drafter can see when
  // the base has advanced since the request was raised. RLS decides access:
  // maybeSingle() returns no row for a document the viewer cannot see, and the
  // card then renders the captured reference as plain text — never an error,
  // and never a freshness claim it cannot back.
  const sourceRef = useMemo(() => parseSourceDocument(ticket?.metadata), [ticket?.metadata]);
  const sourceRefId = sourceRef?.id ?? null;
  const [sourceDoc, setSourceDoc] = useState<{
    state: 'idle' | 'loading' | 'loaded' | 'unavailable' | 'error';
    doc?: { id: string; libraryId: string | null; rev: string | null; documentNumber: string | null; title: string | null; collectionId?: string | null; currentVersionId?: string | null };
    /** LIFE-12: the document's review requirement — a ticket approval never
     *  satisfies it, and the drafter should see that before the deliverable
     *  is approved. */
    review?: { mode: 'require' | 'publisher_choice' | 'none'; configured: number } | null;
  }>({ state: 'idle' });
  const ticketOrgId = ticket?.orgId ?? null;
  useEffect(() => {
    let alive = true;
    if (!sourceRefId || !ticketOrgId) { setSourceDoc({ state: 'idle' }); return; }
    setSourceDoc((s) => (s.state === 'loaded' && s.doc?.id === sourceRefId ? s : { state: 'loading' }));
    supabase
      .from('documents')
      .select('id, library_id, collection_id, rev, document_number, title, current_version_id')
      .eq('id', sourceRefId)
      // Scoped to the TICKET's org, not just RLS: a viewer who belongs to two
      // workspaces can otherwise resolve a same-id document from the other
      // one and render it as this ticket's source.
      .eq('org_id', ticketOrgId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        // A failed read proves nothing about access — it is not "restricted".
        if (error) { setSourceDoc({ state: 'error' }); return; }
        // DCW-5: no row = the viewer may not discover it (documents_acl_select),
        // or it is no longer in this workspace.
        if (!data) { setSourceDoc({ state: 'unavailable' }); return; }
        const d = data as Record<string, unknown>;
        const doc = {
          id: d.id as string,
          libraryId: (d.library_id as string | null) ?? null,
          collectionId: (d.collection_id as string | null) ?? null,
          rev: (d.rev as string | null) ?? null,
          documentNumber: (d.document_number as string | null) ?? null,
          title: (d.title as string | null) ?? null,
          currentVersionId: (d.current_version_id as string | null) ?? null,
        };
        setSourceDoc({ state: 'loaded', doc });
        if (doc.libraryId) {
          void effectiveReviewControlForDocument({ collectionId: doc.collectionId, libraryId: doc.libraryId })
            .then((rc) => {
              if (!alive) return;
              const configured = (rc.reviewerIds?.length ?? 0) + (rc.reviewerRoles?.length ?? 0) + (rc.reviewerTeamIds?.length ?? 0);
              setSourceDoc((s) => (s.state === 'loaded' && s.doc?.id === doc.id ? { ...s, review: { mode: rc.mode, configured } } : s));
            })
            .catch(() => { /* the card simply shows no requirement line */ });
        }
      });
    return () => { alive = false; };
  }, [sourceRefId, ticketOrgId]);

  // UI-1 / GAP-108: who the ticket waits on — the assignment queue named by
  // its members when the current step is the queue's (lib/ticketRouting.ts
  // queuePool over the org's active members, read through RLS).
  const [queueNames, setQueueNames] = useState<string[] | null>(null);
  const waitsOnQueue = !!ticket && holdersFor(ticket).some((h) => h.kind === 'queue');
  useEffect(() => {
    let alive = true;
    if (!waitsOnQueue || !ticketOrgId) { setQueueNames(null); return; }
    void loadRoutingContext(ticketOrgId).then((ctx) => {
      if (!alive) return;
      if (!ctx.ok) { setQueueNames(null); return; }
      const pool = new Set(queuePool(ctx));
      setQueueNames(ctx.members.filter((m) => pool.has(m.uid))
        .map((m) => (m.name || m.email?.split('@')[0] || '').trim()).filter(Boolean));
    }, () => { if (alive) setQueueNames(null); });
    return () => { alive = false; };
  }, [waitsOnQueue, ticketOrgId]);

  // TIER-5 (DF-P5 fix pass 3): a routed ticket in review with NO roster
  // (reopened, or in review before the routing was set) is not approved on
  // the serial path — the engine renders those approvals disabled with the
  // way forward, and the route refuses them. Read through RLS only while it
  // can matter; a read that fails leaves the decision to the route.
  const [reviewRouted, setReviewRouted] = useState(false);
  // DF-P5 fix pass 4: a routing table that can't be used is named (a
  // revision would be refused too) — the reason travels with the flag.
  const [reviewRoutedReason, setReviewRoutedReason] = useState<string | null>(null);
  const routedCheckKey = ticket && ticket.libraryId && !currentRoster(ticket)
    && (ticket.status === 'PENDING_REVIEW' || ticket.status === 'PENDING_FINAL_APPROVAL')
    ? `${ticket.id ?? ''}|${ticket.libraryId}|${ticket.status}` : null;
  useEffect(() => {
    let alive = true;
    if (!routedCheckKey || !ticket?.id || !ticketOrgId) { setReviewRouted(false); setReviewRoutedReason(null); return; }
    void ticketReviewRouting({ id: ticket.id, orgId: ticketOrgId, libraryId: ticket.libraryId ?? null, sourceDocumentId: sourceRefId })
      .then((r) => { if (alive) { setReviewRouted(r.routed); setReviewRoutedReason(r.routed ? routedNoRosterReason(r.routing) : null); } },
        () => { if (alive) { setReviewRouted(false); setReviewRoutedReason(null); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the facts the answer depends on
  }, [routedCheckKey, ticketOrgId, sourceRefId]);

  // PROJ-9: the project a request is linked to (an intake collision names it),
  // read through RLS — a project the viewer cannot see shows as a reference only.
  const projectRef = useMemo(() => projectRefOf(ticket?.metadata), [ticket?.metadata]);
  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!projectRef || !ticketOrgId) { setProjectName(null); return; }
    void supabase.from('projects').select('name').eq('id', projectRef).eq('org_id', ticketOrgId).maybeSingle()
      .then(({ data }) => { if (alive) setProjectName(((data as { name?: string } | null)?.name ?? '').trim() || null); }, () => { if (alive) setProjectName(null); });
    return () => { alive = false; };
  }, [projectRef, ticketOrgId]);

  const requesterId = ticket?.requesterId ?? null;
  useEffect(() => {
    let alive = true;
    if (!requesterId || !ticketOrgId) { setRequesterRoles(null); return; }
    // FRIC-7 (DF-P9 fix pass): a failed read never invents a departure — an
    // error is "unknown, assumed present" (null), exactly as
    // lib/ticketRequesterRoles.ts loadRequesterRoles answers; `[]` (left the
    // workspace) only when the read SUCCEEDED and found no active row. The
    // waiting line and explainNoActions show what this decides.
    supabase.from('org_members').select('role, roles')
      .eq('org_id', ticketOrgId).eq('uid', requesterId).eq('status', 'active').maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { setRequesterRoles(null); return; }
        setRequesterRoles(data ? heldRoles(data as { role?: unknown; roles?: unknown }) : []);
      })
      .then(undefined, () => { if (alive) setRequesterRoles(null); });
    return () => { alive = false; };
  }, [requesterId, ticketOrgId]);

  // DF-P6 fix pass (review, issues 1 and 2): the same member read and rule
  // as the workflow route, so the override and "Send for Engineer Final
  // Approval" render exactly as the route will take them.
  const pickQuestion = !!ticket && activeRole !== null && !policyFault
    && engineerPickQuestionApplies(ticketAsDeclarationChecked(ticket, declarationCheck), uid, activeRole, roles, capPolicy, requesterRoles);
  useEffect(() => {
    let alive = true;
    if (!pickQuestion || !ticket || !ticketOrgId) { setEngineerPickAvailable(undefined); return; }
    const t = ticket;
    void loadPickerMembers(ticketOrgId).then((read) => {
      if (!alive) return;
      if (!read.ok) { setEngineerPickAvailable(undefined); return; }
      const cands = engineerCandidates(read.rows, capPolicy, 'ticket.final_approve', ticketResource(t)).map((c) => c.uid);
      setEngineerPickAvailable(pickAvailableFrom(cands, t, uid, separationOfDutiesActive(activeMemberCount)));
    }, () => { if (alive) setEngineerPickAvailable(undefined); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the question, the policy or the head-count changes, not on every ticket render
  }, [pickQuestion, ticketOrgId, capPolicy, activeMemberCount, uid]);

  // GAP-6 / DEC-22: may THIS caller publish a revision of the source document?
  // Library publish authority (controller, publish grant, index) OR the
  // document's effective owner — the same pair `authorizePublish` checks when
  // the publish runs, so the button and the mutator cannot disagree. Ticket
  // authority plays no part.
  useEffect(() => {
    let alive = true;
    const docId = sourceDoc.state === 'loaded' ? sourceDoc.doc?.id ?? null : null;
    const libId = sourceDoc.state === 'loaded' ? sourceDoc.doc?.libraryId ?? null : null;
    // SESS-6: no role known (activeRole null) is the least-privileged state —
    // no publish affordance, exactly as an unknown caller gets.
    if (!docId || !libId || !uid || activeRole === null) { setCanPublishSource(false); return; }
    (async () => {
      try {
        const teamIds = await getMyTeamIds(uid);
        const principal = { uid, role: activeRole, roles, orgId: activeOrgId ?? undefined, teamIds, isActiveMember: true };
        const [viaLibrary, viaOwner] = await Promise.all([
          resolveCanControlLibrary(libId, principal),
          isEffectiveOwnerOfDocument(docId, uid).catch(() => false),
        ]);
        if (alive) setCanPublishSource(viaLibrary || viaOwner);
      } catch { if (alive) setCanPublishSource(false); }
    })();
    return () => { alive = false; };
  }, [sourceDoc, uid, activeRole, roles, activeOrgId]);

  // DCW-4 (DF-P15): may THIS caller put a new document's first revision into
  // the request's target library? The same check createDocumentWithFile runs
  // first (canPutFirstRevisionInContainer: a controller, a publisher on the
  // library, or the library's owner), so the offer and the creation cannot
  // disagree. A request with a source document hands back through "Publish
  // as revision of …" instead. SESS-6: no role known offers nothing.
  const newDocLibraryId = !sourceRefId && ticket?.libraryId ? ticket.libraryId : null;
  useEffect(() => {
    let alive = true;
    if (!newDocLibraryId || !ticketOrgId || !uid || activeRole === null) { setCanPublishNew(false); setTargetLibraryName(null); return; }
    (async () => {
      try {
        const may = await canPutFirstRevisionInContainer({ orgId: ticketOrgId, libraryId: newDocLibraryId, collectionId: null, actorUserId: uid, actorRole: activeRole ?? undefined });
        if (!alive) return;
        setCanPublishNew(may);
        if (!may) { setTargetLibraryName(null); return; }
        const { data } = await supabase.from('libraries').select('name').eq('id', newDocLibraryId).eq('org_id', ticketOrgId).maybeSingle();
        if (alive) setTargetLibraryName((((data as { name?: string | null } | null)?.name) ?? '').trim() || 'the target library');
      } catch { if (alive) { setCanPublishNew(false); setTargetLibraryName(null); } }
    })();
    return () => { alive = false; };
  }, [newDocLibraryId, ticketOrgId, uid, activeRole]);

  // DCW-4 (DF-P15 fix, on review): a document in the target library that
  // already carries this request, while the request does not record it (a
  // hand-back that failed after the create, here or in an earlier visit) —
  // the page offers to record THAT document and does not offer a second
  // create. A failed read proves nothing: the offer stays as it was.
  const newDocRecorded = deliverableStateOf(ticket?.metadata)?.state === 'published';
  useEffect(() => {
    let alive = true;
    if (!newDocLibraryId || !ticketOrgId || !ticket?.id || !canPublishNew || newDocRecorded) {
      if (newDocRecorded) setExistingNewDoc(null);
      return;
    }
    void findTicketNewDocumentVersion(supabase, { orgId: ticketOrgId, ticketRowId: ticket.id, libraryId: newDocLibraryId }).then((found) => {
      if (alive && found.kind === 'found') setExistingNewDoc(found.version);
    });
    return () => { alive = false; };
  }, [newDocLibraryId, ticketOrgId, ticket?.id, canPublishNew, newDocRecorded]);

  // DCW-4 remainder (ruled by the integrator at the DF-P15 merge, 2026-10-20,
  // DEC-90): a request with NEITHER a source document NOR a library (DEC-107:
  // a library is never required at filing) offers "Publish as a new document"
  // with a library chosen by the publisher — from the libraries of the
  // workspace they can see where they may put a first revision: the same
  // gate as the library offer above (canPutFirstRevisionInContainer),
  // evaluated per library. None → no offer. A failed read offers nothing
  // (fail-safe). The request's own library field is never written; the
  // hand-back route re-checks the publisher's authority on the chosen library.
  const chooseNewDocLibrary = !!ticket?.id && !sourceRefId && !ticket?.libraryId;
  useEffect(() => {
    let alive = true;
    if (!chooseNewDocLibrary || !ticketOrgId || !uid || activeRole === null) { setNewDocLibraryChoices([]); return; }
    (async () => {
      try {
        const { data, error } = await supabase.from('libraries').select('id, name').eq('org_id', ticketOrgId);
        if (error) throw error;
        const rows = ((data as Array<{ id?: string | null; name?: string | null }> | null) ?? []).filter((r): r is { id: string; name?: string | null } => typeof r.id === 'string' && !!r.id);
        const allowed = await Promise.all(rows.map((r) =>
          canPutFirstRevisionInContainer({ orgId: ticketOrgId, libraryId: r.id, collectionId: null, actorUserId: uid, actorRole: activeRole ?? undefined }).catch(() => false)));
        if (!alive) return;
        setNewDocLibraryChoices(rows.filter((_, i) => allowed[i]).map((r) => ({ id: r.id, name: (r.name ?? '').trim() || 'Untitled library' })));
      } catch { if (alive) setNewDocLibraryChoices([]); }
    })();
    return () => { alive = false; };
  }, [chooseNewDocLibrary, ticketOrgId, uid, activeRole]);
  const newDocChoiceIds = useMemo(() => newDocLibraryChoices.map((c) => c.id).join(','), [newDocLibraryChoices]);
  useEffect(() => {
    let alive = true;
    if (!chooseNewDocLibrary || !ticketOrgId || !ticket?.id || !newDocChoiceIds || newDocRecorded) return;
    void findTicketNewDocumentVersion(supabase, { orgId: ticketOrgId, ticketRowId: ticket.id, libraryId: newDocChoiceIds.split(',') }).then((found) => {
      if (alive && found.kind === 'found') setExistingNewDoc(found.version);
    });
    return () => { alive = false; };
  }, [chooseNewDocLibrary, ticketOrgId, ticket?.id, newDocChoiceIds, newDocRecorded]);

  const recordExistingNewDocument = async () => {
    if (!existingNewDoc?.versionId || recordingExisting) return;
    setRecordingExisting(true);
    try {
      const ok = await recordHandback(existingNewDoc.versionId, existingNewDoc.revisionLabel, { newDocumentNumber: existingNewDoc.documentNumber || 'The new document' });
      if (ok) setExistingNewDoc(null);
    } finally {
      setRecordingExisting(false);
    }
  };

  // PHYS-18 (DF-P15): the copy recall on the page — shown to the people who
  // may recall a request's copies: its requester, its assigned drafter and a
  // controller (Admin / DocCtrl, by the role collection). The ticket as the
  // recall reads it is memoized on what the verdict reads, so the panel
  // re-reads the record only when the ticket moves.
  const canRecallCopies = !!ticket && !!uid && !ticket.archivedAt
    && (ticket.requesterId === uid || ticket.assignedDrafterId === uid || isAdmin);
  const recallTicket = useMemo(() => (ticket?.id && ticket.orgId ? {
    id: ticket.id, orgId: ticket.orgId, status: ticket.status ?? null, deliverableRev: ticket.deliverableRev ?? null,
    history: ticket.history, revisionCount: ticket.revisionCount ?? null, attachments: ticket.attachments,
  } : null), [ticket?.id, ticket?.orgId, ticket?.status, ticket?.deliverableRev, ticket?.history, ticket?.revisionCount, ticket?.attachments]);

  // DCW-4 (DF-P15): fetch the Final deliverable's bytes for the new-document
  // path (as openHandback does for a revision). Nothing is created here.
  const openNewDocument = async () => {
    if (!ticket) return;
    const final = latestFinalAttachment(ticket.attachments);
    if (!final) return;
    setNewDocBusy(true);
    try {
      const url = /^https?:\/\//i.test(final.url) ? final.url : await getSignedUrlForPath(final.url);
      const res = await fetch(url);
      if (!res.ok) throw new Error('The Final deliverable could not be fetched from storage.');
      const blob = await res.blob();
      setNewDocFile(new File([blob], final.name, { type: blob.type || 'application/pdf' }));
    } catch (e) {
      const msg = e instanceof ArchivedFileError
        ? 'The Final deliverable was archived offline — restore the archive before publishing it.'
        : (e as Error).message;
      showToast({ type: 'error', title: 'Cannot start the publish', message: msg });
    } finally {
      setNewDocBusy(false);
    }
  };

  // Pre-seed the existing rev-up flow with the Final deliverable and open it.
  // Nothing is published here — RevUpModal → revUpDocument does that, with
  // every guard and post-publish side effect (DEC-22: never a second path).
  const openHandback = async () => {
    if (!ticket || sourceDoc.state !== 'loaded' || !sourceDoc.doc) return;
    const final = latestFinalAttachment(ticket.attachments);
    if (!final) return;
    setHandbackBusy(true);
    try {
      const { data: row } = await supabase.from('documents').select('*').eq('id', sourceDoc.doc.id).eq('org_id', ticket.orgId).maybeSingle();
      if (!row) throw new Error('The source document is not accessible to you.');
      const url = /^https?:\/\//i.test(final.url) ? final.url : await getSignedUrlForPath(final.url);
      const res = await fetch(url);
      if (!res.ok) throw new Error('The Final deliverable could not be fetched from storage.');
      const blob = await res.blob();
      setHandbackDoc(docRowToDocumentRecord(row as Record<string, unknown>));
      setHandbackFile(new File([blob], final.name, { type: blob.type || 'application/pdf' }));
      setShowHandback(true);
    } catch (e) {
      const msg = e instanceof ArchivedFileError
        ? 'The Final deliverable was archived offline — restore the archive before publishing it.'
        : (e as Error).message;
      showToast({ type: 'error', title: 'Cannot start the publish', message: msg });
    } finally {
      setHandbackBusy(false);
    }
  };

  // After the publish landed (or opened a review draft), record it on the
  // ticket through the server, which verifies the version row is this
  // request's deliverable before writing anything.
  // DF-P15 fix: the toast says what the register holds — the hand-back
  // route's own answer (metadata.deliverable.filed_as_draft) decides it, so a
  // new document filed as a Draft is never announced as an issued revision.
  const recordHandback = async (versionId: string, revisionLabel: string, opts: { newDocumentNumber?: string } = {}): Promise<boolean> => {
    if (!ticket?.id) return false;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');
      const res = await fetch('/api/tickets/handback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ ticketId: ticket.id, versionId }),
      });
      const out = await res.json().catch(() => ({} as Record<string, unknown>)) as { error?: string; warning?: string; metadata?: Record<string, unknown>; history?: Ticket['history'] };
      if (!res.ok) throw new Error(out.error || 'Could not record the publish on the request');
      setTicket((t) => (t ? { ...t, metadata: out.metadata ?? t.metadata, history: out.history ?? t.history } : t));
      const filedAsDraft = (out.metadata?.deliverable as { filed_as_draft?: unknown } | undefined)?.filed_as_draft === true;
      showToast(filedAsDraft
        ? { type: 'success', title: 'Filed as a Draft document on the request', message: out.warning ?? 'The deliverable is in the register as a Draft — not issued — and the request knows it.' }
        : { type: 'success', title: `Rev ${revisionLabel} recorded on the request`, message: out.warning ?? 'The deliverable is in the register and the request knows it.' });
      return true;
    } catch (e) {
      // DF-P15 fix (review): a new document's failed hand-back points at the
      // existing document ("Record … on the request"), never at a second create.
      showToast(opts.newDocumentNumber
        ? { type: 'error', title: 'Created, but not recorded on the request', message: newDocumentNotRecordedMessage(opts.newDocumentNumber, (e as Error).message, true) }
        : { type: 'error', title: 'Published, but not recorded on the request', message: (e as Error).message });
      return false;
    }
  };

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

    // WF-9: the classification rides the comment route (author or Admin,
    // compare-and-set on the ticket, audited server-side) instead of a
    // whole-array client write of `tickets.comments`.
    const prevComments = ticket.comments;
    setTicket((prev) => prev ? { ...prev, comments: updatedComments } : prev);
    setEditingCommentId(null);
    try {
      await callCommentApi('PATCH', { ticketId, commentId, category: editCategoryVal });
    } catch (e) {
      setTicket((prev) => prev ? { ...prev, comments: prevComments } : prev);
      console.error("Failed to update category", e);
      await appAlert({ message: `Failed to update root cause: ${e instanceof Error ? e.message : String(e)}`, tone: "danger" });
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
      // WF-9: the bytes are in storage; the ticket row's attachments +
      // history write is a workflow action (`attach_file`) — the same
      // authority evaluation, compare-and-set, server audit row and history
      // entry as every transition. A stale tab can no longer clobber an
      // approval's history, and only the ticket's participants can attach.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");
      const res = await fetch('/api/tickets/workflow-action', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ ticketId, actionType: 'attach_file', attachment: newAttachment }),
      });
      if (res.status === 409) {
        throw new Error("This request was just updated by someone else, so the file was not attached. The latest state is loading — please try again.");
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || `Upload failed (HTTP ${res.status})`);
      }

      setIsUploading(false);
      setFileToUpload(null);
      setUploadProgress(0);
    } catch (err) {
      console.error(err);
      await appAlert({ message: err instanceof Error ? err.message : "Upload failed. Please try again.", tone: "danger" });
      setIsUploading(false);
    }
  };

  // FRIC-5 (DF-P5 fix pass 3): the approval the approver CONFIRMED as an
  // issue-as-is — sent with it as `issueAsIsAcknowledged`; the route refuses
  // an as-is issue the approver was never asked about (a mark made after the
  // page loaded).
  const asIsAckRef = useRef<string | null>(null);
  const initiateWorkflowAction = async (action: WorkflowAction) => {
    if (!ticket) return;
    asIsAckRef.current = null;
    if (action.disabledReason) {
      // Separation-of-duties: the server refuses this with the same message,
      // so stop it here with the explanation instead of a round-trip 403.
      await appAlert({ message: action.disabledReason, tone: "danger" });
      return;
    }
    // WF-18: reassignment collects the new drafter AND the reason in one modal.
    if (action.action === 'reassign_drafter') { handleReassignClick(action); return; }
    // SM-13 (DF-P9): the file the action needs, by TYPE — Submit Draft needs
    // a Draft on the ticket; Issue Final gets its Final from the IFC upload
    // that opens next (checked again before it is sent). Any attachment at
    // all used to pass.
    const missingFile = missingRequiredFile(action, ticket.attachments);
    if (missingFile) { await appAlert({ message: `Compliance Check Failed: ${missingFile}`, tone: "danger" }); return; }
    // FRIC-5 (DF-P5 fix pass 2): an approval that issues a marked draft
    // as-is is never taken blind — the approver confirms what it does (the
    // draft becomes the issued Final; no stamped upload follows).
    const asIs = issueAsIsConfirmation(action, ticket);
    if (asIs && !(await appConfirm({ title: 'Approve and issue as-is?', message: asIs }))) return;
    if (asIs) asIsAckRef.current = action.action;
    
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
    // Assignment opens the drafter picker. (The former approve_initial →
    // assign rewrite is gone with the NEW stage — DEC-14 / WF-17.)
    else if (action.action === 'assign') {
      setPendingAction(action);
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
    engineerData?: {id: string, name: string, email: string},
    triage?: { libraryId?: string; unit?: string },
    outcome?: TicketOutcome,
    outcomeReason?: string,
  ) => {
    if (!ticket) return;
    // SM-13: Issue Final carries a file typed Final, or nothing is sent.
    if (action.action === 'submit_final') {
      const missingFinal = missingRequiredFile(action, ticket.attachments, newFinalFile ?? null);
      if (missingFinal) { await appAlert({ message: `Compliance Check Failed: ${missingFinal}`, tone: "danger" }); return; }
    }
    // LEAK-9: an action that ends the request says how (the engine's
    // `requiresOutcome`); the dialog requires the choice before it sends.
    if (action.requiresOutcome && !outcome) {
      await appAlert({ message: "Choose how this request ends before confirming.", tone: "danger" });
      return;
    }
    setActionLoading(action.action);
    try {
      // Handle Redline Upload if pending — files upload from the client;
      // the transition itself is computed + enforced server-side.
      let finalComment = comment;
      let redlineAttachment: TicketAttachment | null = null;

      // PERS-7 (DF-P9; integrator fix pass): the session the action is sent
      // with is read FIRST — before any redline goes to storage — so an action
      // that cannot be sent leaves no orphaned file behind.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error(pendingRedlineBlob && fileToRedline ? "Not authenticated, so the redline was not uploaded." : "Not authenticated");

      if (pendingRedlineBlob && fileToRedline) {
         // PERS-7 (DF-P9): no workspace or signed-in member, no action — and
         // checked BEFORE the redline goes to storage, so a refused action
         // leaves no orphaned file behind.
         if (!activeOrgId) throw new Error("No active workspace.");
         if (!uid) throw new Error("You're not signed in, so the redline was not uploaded.");
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
      }

      // Server-enforced transition: /api/tickets/workflow-action validates this
      // action against the state machine for our role and the ticket's CURRENT
      // status, recomputes the update server-side, applies it compare-and-set,
      // writes the audit row, and fans out notifications + emails — none of
      // which a tampered client or a closed tab can skip. (The session was
      // read above, before the redline upload.)
      // LIFE-6 / DEC-25: a close over a hold this ticket opened comes back
      // 409 holds_open; the closer chooses — release now, or keep with a
      // stated reason — and the action is re-sent with that resolution.
      let holdResolution: { action: 'release' | 'keep'; reason?: string | null } | null = null;
      const send = () => fetch('/api/tickets/workflow-action', {
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
          holdResolution,
          // DCW-1 / DCW-7: the triage library and unit (assign at
          // PENDING_ASSIGNMENT only; the route validates both, neither required).
          ...(triage?.libraryId ? { libraryId: triage.libraryId } : {}),
          ...(triage?.unit ? { unit: triage.unit } : {}),
          // LEAK-9: how the request ended (cancel_request).
          ...(outcome ? { outcome } : {}),
          // GAP-13 / GAP-107 (DF-P14): the workspace's own reason, beside its category.
          ...(outcome && outcomeReason ? { outcomeReason } : {}),
          // FRIC-5 (DF-P5 fix pass 3): the approver confirmed the as-is issue.
          ...(asIsAckRef.current === action.action ? { issueAsIsAcknowledged: true } : {}),
        }),
      });
      let res = await send();
      if (res.status === 409 && !holdResolution) {
        const j = await res.clone().json().catch(() => ({})) as { code?: string; holds?: Array<{ reason: string }> };
        if (j.code === 'holds_open') {
          const holdLabel = (j.holds ?? []).map((h) => h.reason).join(', ') || 'a hold';
          const release = await appConfirm({
            title: 'This request opened a hold that is still active',
            message: `${holdLabel} is still blocking the document. Release it now? Choose No to keep it open and record why.`,
            confirmLabel: 'Release the hold',
            cancelLabel: 'Keep it open',
          });
          if (release) {
            const reason = await appPrompt({ title: 'Release reason (optional)', message: 'Recorded on the hold and the audit trail.', placeholder: 'e.g. field verified against Rev B' });
            if (reason === null) { setActionLoading(null); return; }
            holdResolution = { action: 'release', reason };
          } else {
            const reason = await appPrompt({ title: 'Why does the hold stay open?', message: 'Required — the document stays blocked after this request closes.', placeholder: 'e.g. awaiting vendor data; hold owned by the owner' });
            if (reason === null || !reason.trim()) { setActionLoading(null); return; }
            holdResolution = { action: 'keep', reason };
          }
          res = await send();
        }
      }

      if (res.status === 409) {
        setActionLoading(null);
        setPendingAction(null);
        setShowCommentModal(false);
        setShowAssignModal(false);
        setShowUploadIFC(false);
        setPendingRedlineBlob(null);
        setFileToRedline(null);
        // DF-P5 fix pass 4: a refusal with its own code (the routing needs a
        // roster, an unconfirmed issue-as-is, a routing table that can't be
        // used…) is said with its way forward — only the compare-and-set
        // conflict is "someone else updated it".
        const refusal = workflowRefusalMessage(await res.clone().json().catch(() => null));
        await appAlert(refusal
          ? { title: "Your action wasn't applied", message: refusal, tone: "danger" }
          : { message: "This request was just updated by someone else, so your action wasn't applied. The latest state is loading — please review the change and try again.", tone: "danger" });
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
      // PERS-7 (DF-P9): the redline's audit row follows the action that
      // attached it — written only once the route accepted the request with
      // the redline on it (never an 'unknown' stand-in), and a refused row is
      // said. Before, it was written (and its refusal toasted as "attached")
      // before the action was even sent, which could still 409 or 403.
      if (redlineAttachment && fileToRedline && uid && activeOrgId) {
        const redlineAudit = await logAuditAction({
          action: 'TICKET_REDLINE_CREATED', resourceId: ticketId, resourceType: 'ticket',
          orgId: activeOrgId, userId: uid, userRole: activeRole ?? undefined,
          details: { originalFile: fileToRedline.name, newFile: redlineAttachment.name }
        });
        if (!redlineAudit.ok) {
          showToast({ type: 'warning', title: 'Redline attached, record not written', message: `The redline is attached to the request, but its audit record could not be written: ${redlineAudit.error}` });
        }
      }
      // DF-P1's hand-off (EVID-12 / LIFE-6): an action that landed can still
      // carry a warning — a close whose hold could not be released (the
      // document stays blocked: `holdsNotReleased`), a library the database
      // could not record yet. It is said, never dropped.
      const landed = await res.json().catch(() => ({})) as { warning?: string; holdsNotReleased?: string[] };
      if (landed.warning) {
        showToast({
          type: 'warning',
          title: Array.isArray(landed.holdsNotReleased) && landed.holdsNotReleased.length > 0 ? 'Done — but a hold is still active' : 'Done, with a warning',
          message: landed.warning,
        });
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

  // WF-9: following rides a server route (membership-checked, only ever the
  // caller's own follow, compare-and-set on the ticket) — the whole-array
  // client write could clobber a concurrent workflow transition.
  const toggleWatch = async () => {
    if (!ticket || !uid) return;
    const watching = !(ticket.watchers ?? []).includes(uid);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');
      const res = await fetch('/api/tickets/watch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ ticketId, watching }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; watchers?: string[] };
      if (!res.ok) throw new Error(j.error || `Couldn't update (HTTP ${res.status})`);
      if (Array.isArray(j.watchers)) setTicket((prev) => prev ? { ...prev, watchers: j.watchers } : prev);
    } catch (err) {
      await appAlert({ message: `Couldn't update your follow: ${err instanceof Error ? err.message : String(err)}`, tone: "danger" });
    }
  };

  const getStatusStyle = (status: TicketStatus) => {
    switch (status) {
      case 'DRAFTING': return 'bg-blue-100 text-blue-800 border-blue-200'; 
      case 'PENDING_IFC': return 'bg-teal-100 text-teal-800 border-teal-200';
      case 'REVISION_REQ': return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'PENDING_ASSIGNMENT': return 'bg-purple-100 text-purple-800 border-purple-200';
      case 'CANCELED': return 'bg-rose-50 text-rose-700 border-rose-200 line-through decoration-rose-300';
      default: return 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]';
    }
  };

  if (loading || !ticket) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4">
        <Loader2 className="w-16 h-16 animate-spin text-orange-600" />
        <div className="flex flex-col items-center"><h2 className="text-xl font-bold text-[var(--color-text)]">Loading Ticket Details...</h2><p className="text-[var(--color-text-muted)] text-sm">Retrieving latest workflow state and assets.</p></div>
      </div>
    );
  }

  // SESS-6: no role known (activeRole null) offers no action at all — the
  // engine is asked only with a real role.
  const availableActions = activeRole === null ? [] : WorkflowEngine.getActions(ticketAsDeclarationChecked(ticket, declarationCheck), activeRole, uid ?? undefined, capPolicy, {
    reviewRouted, // TIER-5 (DF-P5 fix pass 3): a routed review with no roster
    reviewRoutedReason,
    userRoles: roles,
    activeMemberCount,
    ...(engineerPickAvailable === undefined ? {} : { engineerPickAvailable }), // DF-P6 fix pass (issues 1 and 2)
    engineeringFirstTypes,
    closeWithoutReviewTypes,
    requesterRoles,
  });
  // AUTHZ-15: an unreadable policy → the route refuses every action (503
  // policy_unreadable), so none is offered; the header says why.
  const liveActions = policyFault ? [] : availableActions;
  // WF-9 / WF-18: the upload affordance and the Reassign button are derived
  // from the engine's actions, never from a role list of their own — they
  // exist exactly when the route will accept the write. Both have their own
  // UI, so they are not rendered as generic action buttons.
  const canAttach = liveActions.some((a) => a.action === 'attach_file');
  const reassignAction = liveActions.find((a) => a.action === 'reassign_drafter');
  const buttonActions = liveActions.filter((a) => a.action !== 'attach_file' && a.action !== 'reassign_drafter' && !a.requiresSignature);

  // UI-1 / GAP-108: what the request is waiting for, on whom, since when —
  // and whether the ball is in the viewer's court (the engine offers them a
  // live, non-optional action: the attention rule).
  const requesterRolesCtx = requesterRoles !== null && ticket.requesterId ? new Map([[ticket.requesterId, requesterRoles]]) : null;
  const holders = holdersFor(ticket, { queueNames, requesterRoles });
  const waitingLabel = attentionLabel(ticket.status, { hasDrafter: !!ticket.assignedDrafterId });
  const waited = waitedFor(waitingSince(ticket));
  const yourTurn = liveActions.some((a) => !a.optional && !a.disabledReason);
  const isTerminalStatus = ticket.status === 'CLOSED' || ticket.status === 'CANCELED';
  // DF-P6 fix pass (review, issue 7): the request was issued by a management
  // override of the engineering sign-off (and no engineer signed since).
  const engineeringOverride = engineeringOverrideOf(ticket);
  // UI-4: why there is nothing to do here, naming who to talk to.
  // DF-P5 fix pass 2: the drafter's optional issue-as-is mark / withdrawal
  // is offered BESIDE the explanation, never in place of it — the request
  // still waits on someone else.
  const awaitedButtons = buttonActions.filter((a) => !ISSUE_MARK_ACTIONS.has(a.action));
  const noActionsWhy = awaitedButtons.length === 0 && !policyFault
    ? explainNoActions(ticket, { uid, roles, policy: capPolicy, activeMemberCount, engineeringFirstTypes, closeWithoutReviewTypes, requesterRoles: requesterRolesCtx, holders })
    : null;
  // FRIC-5 (DF-P5 fix pass 2): a marked draft waiting on a serial approval
  // says so to everyone who opens it (a routed review says it on its panel).
  const asIsBanner = issueAsIsBanner(ticket);
  const unitShown = ticketUnitDisplay(ticket.unit, ticket.metadata);
  const customSections = customCategorySections(ticket.metadata, customCategoryConfig);
  const sourceFiles = ticket.attachments?.filter(a => a.type === 'Source' || a.type === 'Reference') || [];
  
  // LOGIC: DRAFTS SORTING & VERSIONING
  const draftFilesRaw = ticket.attachments?.filter(a => a.type === 'Draft') || [];
  const sortedDrafts = draftFilesRaw.sort((a, b) => toDate(b.uploadedAt).getTime() - toDate(a.uploadedAt).getTime());
  
  const latestDraft = sortedDrafts[0];
  const previousDrafts = sortedDrafts.slice(1);

  const finalFiles = ticket.attachments?.filter(a => a.type === 'Final') || [];

  // LOGIC: Check for Staged Files
  const hasStagedFiles = ticket.attachments?.some(a => a.status === 'staged' && a.type === 'Draft');

  // GAP-6: what the hand-back pre-seeds (computed here, where `ticket` is known).
  const handbackLibraryId = sourceDoc.state === 'loaded' ? sourceDoc.doc?.libraryId ?? null : null;
  const handback = handbackLibraryId
    ? { ...handbackPreset(ticket), libraryId: handbackLibraryId, ticketId: ticket.id ?? '', label: `request ${ticket.ticketId}` }
    : null;
  const deliverable = deliverableStateOf(ticket.metadata);
  const canOfferHandback = !!handback && canPublishSource && !!latestFinalAttachment(ticket.attachments) && deliverable?.state !== 'published';
  // DCW-4 (DF-P15): the new-document offer — same conditions, on the library.
  const canOfferNewDocument = !!newDocLibraryId && canPublishNew && !ticket.archivedAt && !!latestFinalAttachment(ticket.attachments) && deliverable?.state !== 'published' && !existingNewDoc;
  // DF-P15 fix (review): the existing new document, offered for recording instead.
  const canRecordExistingNewDocument = !!newDocLibraryId && canPublishNew && !ticket.archivedAt && deliverable?.state !== 'published' && !!existingNewDoc;
  // DCW-4 remainder (DEC-90 ruling at the DF-P15 merge): the same offer for a
  // request with neither a source document nor a library — the publisher
  // chooses the library (shown only when there is one they may publish into).
  const canOfferChosenLibraryDocument = chooseNewDocLibrary && newDocLibraryChoices.length > 0 && !ticket.archivedAt && !!latestFinalAttachment(ticket.attachments) && deliverable?.state !== 'published' && !existingNewDoc;
  const canRecordExistingChosenLibraryDocument = chooseNewDocLibrary && newDocLibraryChoices.length > 0 && !ticket.archivedAt && deliverable?.state !== 'published' && !!existingNewDoc;
  const onNewDocumentCreated = async (r: { versionId: string | null; revisionLabel: string; versionReadError: string | null; documentId: string; documentNumber: string; creationAuditError: string | null }) => {
    setNewDocFile(null);
    // DF-P15 fix (review): from here on the page offers to RECORD this
    // document, never to create another (cleared once it is recorded).
    setExistingNewDoc({ versionId: r.versionId, documentId: r.documentId, documentNumber: r.documentNumber, revisionLabel: r.revisionLabel });
    if (r.creationAuditError) {
      await appAlert({ message: `${r.documentNumber} was created, but its creation record could not be written (${r.creationAuditError}). Tell Document Control so the record can be completed.`, tone: "danger" });
    }
    if (!r.versionId) {
      showToast({ type: 'error', title: 'Created, but not recorded on the request', message: newDocumentNotRecordedMessage(r.documentNumber, `its first version could not be read back: ${r.versionReadError ?? 'no reason given'}`, false) });
      return;
    }
    if (await recordHandback(r.versionId, r.revisionLabel, { newDocumentNumber: r.documentNumber })) setExistingNewDoc(null);
  };

  return (
    <div className="pb-20">

      {/* MODALS */}
      {showHandback && handbackDoc && handbackFile && activeOrgId && uid && handback && handback.ticketId && (
        <RevUpModal
          isOpen={showHandback}
          onClose={() => setShowHandback(false)}
          doc={handbackDoc}
          libraryId={handback.libraryId}
          orgId={activeOrgId}
          actorUserId={uid}
          actorEmail={userEmail || undefined}
          actorRole={activeRole ?? undefined}
          presetFile={handbackFile}
          presetIssueType={handback.issueType}
          presetIssueTypeNote={handback.issueTypeNote}
          presetMocOrigin={handback.mocOrigin ? { ...handback.mocOrigin, label: handback.label } : null}
          presetChangeLog={handback.changeLog}
          relatedTicketId={handback.ticketId}
          onSuccess={() => { /* onDirectPublished / onReviewSubmitted record the outcome */ }}
          onDirectPublished={(v) => { setShowHandback(false); if (v.id) void recordHandback(v.id, v.revisionLabel); }}
          onReviewSubmitted={(d) => { setShowHandback(false); void recordHandback(d.versionId, d.revisionLabel); }}
        />
      )}
      {newDocFile && newDocLibraryId && canPublishNew && ticket.id && uid && (
        <PublishNewDocumentModal
          orgId={ticket.orgId}
          libraryId={newDocLibraryId}
          libraryName={targetLibraryName || 'the target library'}
          ticketRowId={ticket.id}
          ticketNumber={ticket.ticketId}
          defaultTitle={ticket.title || ''}
          file={newDocFile}
          actorUserId={uid}
          actorEmail={userEmail || undefined}
          actorRole={activeRole ?? undefined}
          onClose={() => setNewDocFile(null)}
          onCreated={onNewDocumentCreated}
        />
      )}
      {/* DCW-4 remainder (DEC-90 ruling at the DF-P15 merge): a request with neither a
          source document nor a library — the publisher chooses the library. */}
      {newDocFile && chooseNewDocLibrary && newDocLibraryChoices.length > 0 && ticket.id && uid && (
        <PublishNewDocumentModal
          orgId={ticket.orgId}
          libraryId={null}
          libraryName=""
          libraryChoices={newDocLibraryChoices}
          ticketRowId={ticket.id}
          ticketNumber={ticket.ticketId}
          defaultTitle={ticket.title || ''}
          file={newDocFile}
          actorUserId={uid}
          actorEmail={userEmail || undefined}
          actorRole={activeRole ?? undefined}
          onClose={() => setNewDocFile(null)}
          onCreated={onNewDocumentCreated}
        />
      )}
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
        orgId={activeOrgId ?? undefined}
        userId={uid ?? undefined}
        archived={!!ticket?.archivedAt}
        archiveId={ticket?.archiveId}
        liveTicket={ticket ? { status: ticket.status, deliverableRev: ticket.deliverableRev ?? null, history: ticket.history, revisionCount: ticket.revisionCount ?? null } : null}
        copyContext={ticket ? { orgId: ticket.orgId, ticketNumber: ticket.ticketId, requesterId: ticket.requesterId, attachments: ticket.attachments } : null}
        onApprove={(() => {
          const action = liveActions.find(a => a.action === 'approve_draft_ifc' && !a.disabledReason);
          return action ? () => { setViewerFile(null); initiateWorkflowAction(action); } : undefined;
        })()}
      />
      <ActionModal 
        isOpen={showCommentModal} 
        onClose={() => setShowCommentModal(false)} 
        title={pendingAction?.action === 'approve_minor_correction' ? 'Approve with Minor Correction' : pendingAction?.action === 'cancel_request' ? 'Cancel this request' : pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject' ? 'Request Revision' : pendingAction?.variant === 'destructive' ? 'Reject & Return' : 'Workflow Comment'}
        description={pendingAction?.action === 'approve_minor_correction' ? 'Describe the small fix (typo, mislabel). The deliverable is approved NOW — your note goes to the drafter to fold into the issued file, with no new review round.' : pendingAction?.action === 'cancel_request' ? 'Say how this request ends and why. It is closed as canceled and cannot be reopened — a new request can be filed.' : pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject' ? 'Please provide feedback on what needs to be revised.' : pendingAction?.variant === 'destructive' ? 'Please explain why this request is being returned or rejected.' : 'Add an optional comment to this action.'}
        isDestructive={pendingAction?.variant === 'destructive' || pendingAction?.action === 'request_revision'} 
        showCategorySelection={pendingAction?.action === 'request_revision' || pendingAction?.action === 'reject'}
        outcomeOptions={pendingAction?.requiresOutcome ? pendingAction.outcomes : undefined}
        outcomeReasons={outcomeReasons}
        outcomeReasonsUnreadable={outcomeReasonsUnreadable}
        onSubmit={(comment, category, outcome, outcomeReason) => pendingAction && executeWorkflowAction(pendingAction, comment, undefined, undefined, category, undefined, undefined, outcome, outcomeReason)}
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
      <AssignmentModal
        isOpen={showAssignModal}
        onClose={() => { setShowAssignModal(false); setIsReassigning(false); }}
        onSubmit={(id, name, reason, triage) => pendingAction && executeWorkflowAction(pendingAction, reason, {id, name}, undefined, undefined, undefined, triage)}
        isLoading={!!actionLoading}
        activeOrgId={activeOrgId}
        isReassignment={isReassigning}
        ticket={ticket}
        policy={capPolicy}
        triage={pendingAction?.action === 'assign' && ticket.status === 'PENDING_ASSIGNMENT' && !isReassigning}
        unitOptions={unitOptions}
        unitListState={unitListState}
        activeMemberCount={activeMemberCount}
      />
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
          policy={capPolicy}
          resource={ticketResource(ticket)}
          pickActionType={pendingAction.action}
          independentOf={[ticket?.requesterId, ticket?.assignedDrafterId, uid]}
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
                {/* UI-7: the status in words (lib/ticketStatusLabels.ts) — the
                    enum value stays the database's. UI-2: it opens the map. */}
                <button
                  type="button"
                  data-testid="status-pill"
                  onClick={() => setShowWorkflowDiagram(true)}
                  title="See where this request is in the workflow"
                  aria-label={`Status: ${ticketStatusLabel(ticket.status)} — see where this request is in the workflow`}
                  className={`px-3 py-1 rounded-full text-xs font-bold border uppercase tracking-wider inline-flex items-center gap-1.5 hover:brightness-95 transition ${getStatusStyle(ticket.status)}`}
                >
                  {ticketStatusLabel(ticket.status)}
                  <HelpCircle className="w-3 h-3 opacity-70" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowWorkflowDiagram(true)}
                  className="text-xs font-bold text-blue-600 hover:text-blue-800 hover:underline"
                >
                  See the workflow
                </button>
                {ticket.deliverableRev && (
                  <span
                    title={/^\d+$/.test(ticket.deliverableRev)
                      ? `Issued deliverable revision ${ticket.deliverableRev}`
                      : `Review draft ${ticket.deliverableRev} — the letter drops when it's approved`}
                    className={`px-2 py-0.5 text-[10px] font-black rounded border uppercase tracking-wider ${
                      /^\d+$/.test(ticket.deliverableRev)
                        ? 'text-emerald-700 bg-emerald-100 border-emerald-200'
                        : 'text-amber-700 bg-amber-100 border-amber-200'
                    }`}
                  >
                    Rev {ticket.deliverableRev}
                  </span>
                )}
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
              {/* UI-1 / GAP-108: where the request is, on whom, since when — and
                  whether it is the viewer's move. */}
              <p data-testid="waiting-on" className="text-xs mt-1.5 flex flex-wrap items-center gap-x-1.5">
                {isTerminalStatus ? (
                  <span className="text-[var(--color-text-muted)]">{ticket.status === 'CANCELED' ? 'Canceled' : 'Closed'} — nothing is waiting on anyone.</span>
                ) : yourTurn ? (
                  <span className="font-bold text-orange-700">Your turn: {waitingLabel.toLowerCase()}.</span>
                ) : (
                  <span className="text-[var(--color-text)]">
                    <span className="font-bold">Waiting on {holders.map((h) => h.name).join(', ') || 'nobody'}</span>
                    {holders[0] && <span className="text-[var(--color-text-muted)]"> ({holders[0].part})</span>}
                    <span className="text-[var(--color-text-muted)]"> — {waitingLabel.toLowerCase()}</span>
                  </span>
                )}
                {!isTerminalStatus && waited && <span className="text-[var(--color-text-faint)]">· for {waited}</span>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            {/* Traveler: the one-pager that rides the paper folder. Its QR
                shows live status — paper goes stale, the QR doesn't. */}
            <button
              onClick={async () => {
                const { printTicketTraveler } = await import("@/lib/physicalBridge");
                await printTicketTraveler({
                  ticketRowId: ticketId,
                  ticketNumber: ticket.ticketId ?? null,
                  title: ticket.title,
                  // UI-7 (DF-P9 integrator fix pass): "Status at printing" in
                  // words — the pill's label, never the stored identifier.
                  status: ticketStatusLabel(ticket.status),
                  requesterName: ticket.requesterName ?? null,
                  drafterName: ticket.assignedDrafterName ?? null,
                  createdAt: ticket.createdAt ? String(ticket.createdAt) : null,
                  deliverableRev: ticket.deliverableRev ?? null,
                });
              }}
              title="Print a traveler sheet for the paper folder — anyone can scan its QR (no login) to check the deliverable is still the latest revision"
              className="px-3 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all flex items-center gap-1.5 bg-[var(--color-surface)] border-2 border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"
            >
              <QrCode className="w-4 h-4" /> <span className="hidden sm:inline">Traveler</span>
            </button>
            {canAttach && (
              <>
                <label className={`cursor-pointer px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all flex items-center bg-[var(--color-surface)] border-2 border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                  {isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UploadCloud className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" />} 
                  {isUploading ? `Uploading ${uploadProgress.toFixed(0)}%` : 'Add New File'}
                  <input 
                    type="file" 
                    className="hidden" 
                    onChange={(e) => { 
                      const file = e.target.files?.[0];
                      // Everyone classifies their upload — silently force-filing
                      // a requester's redline as a "Source" asset misled both
                      // sides of the review.
                      if (file) setFileToUpload(file);
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

            {reassignAction && (
              <button 
                onClick={() => handleReassignClick(reassignAction)}
                title={reassignAction.description}
                className="px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-all flex items-center bg-[var(--color-surface)] border-2 border-orange-200 text-orange-700 hover:bg-orange-50 hover:border-orange-300"
              >
                <UserPlus className="w-4 h-4 mr-2" /> Reassign
              </button>
            )}
            {policyFault ? (
               // AUTHZ-15: held back, said, retryable — never the defaults.
               <div role="alert" data-testid="ticket-policy-fault" className="flex items-center gap-2 px-4 py-2 bg-amber-50 rounded-lg border border-amber-300 text-xs text-amber-900 max-w-md">
                 <ShieldAlert className="w-4 h-4 shrink-0 text-amber-600" />
                 <span><span className="font-bold">Permissions could not be read</span> — {policyFault}. They decide which actions you may take here, so none is offered until they can be read.</span>
                 <button type="button" onClick={() => setPolicyAttempt((n) => n + 1)} className="shrink-0 px-2 py-1 rounded border border-amber-300 bg-[var(--color-surface)] font-bold text-amber-800 hover:bg-amber-100">Try again</button>
               </div>
            ) : buttonActions.length === 0 ? (
               // UI-4: why there is nothing to do here, and who to talk to.
               <div data-testid="no-actions-why" className="flex items-start px-4 py-2 bg-[var(--color-surface-2)] rounded-lg border border-[var(--color-border)] text-xs font-medium text-[var(--color-text-muted)] max-w-md"><ShieldAlert className="w-4 h-4 mr-2 mt-0.5 shrink-0" /> <span>{noActionsWhy?.text ?? 'No action is open to you on this request.'}</span></div>
            ) : (
              <>
              {noActionsWhy && (
                // UI-4: the only buttons are optional (the issue-as-is mark),
                // so who the request waits on is still said.
                <div data-testid="no-actions-why" className="flex items-start px-4 py-2 bg-[var(--color-surface-2)] rounded-lg border border-[var(--color-border)] text-xs font-medium text-[var(--color-text-muted)] max-w-md"><ShieldAlert className="w-4 h-4 mr-2 mt-0.5 shrink-0" /> <span>{noActionsWhy.text}</span></div>
              )}
              {buttonActions.map((action, idx) => (
                action.disabledReason ? (
                  // Separation-of-duties: the action stays VISIBLE but disabled,
                  // with the reason spelled out — a vanished button reads as a bug.
                  <div key={idx} className="flex flex-col items-start gap-0.5 max-w-xs">
                    <button
                      disabled
                      title={action.disabledReason}
                      className="px-5 py-2.5 rounded-lg text-sm font-bold shadow-sm flex items-center bg-[var(--color-surface-2)] border-2 border-dashed border-[var(--color-border-strong)] text-[var(--color-text-faint)] cursor-not-allowed"
                    >
                      <ShieldAlert className="w-4 h-4 mr-2" />
                      {action.label}
                    </button>
                    <p className="text-[10px] leading-tight text-[var(--color-text-faint)] px-1">{action.disabledReason}</p>
                  </div>
                ) : (
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

                  `}
                >
                  {actionLoading === action.action ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : action.action === 'save_progress' ? <Save className="w-4 h-4 mr-2" /> : action.action === 'submit_draft' ? <Send className="w-4 h-4 mr-2" /> : action.action === 'assign' ? <UserPlus className="w-4 h-4 mr-2" /> : action.action === 'submit_final' ? <FileCheck className="w-4 h-4 mr-2" /> : null}
                  {action.label}
                  {action.action === 'submit_draft' && hasStagedFiles && (
                    <span className="absolute top-0 right-0 w-3 h-3 bg-orange-500 rounded-full border-2 border-white translate-x-1 -translate-y-1"></span>
                  )}
                </button>
                )
              ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* NOTIFICATION: Staged Files Warning */}
      {hasStagedFiles && (
        <div className="bg-orange-600 text-white px-4 py-3 shadow-md relative z-10 animate-in slide-in-from-top-2">
          <div className="max-w-[1920px] mx-auto flex items-center justify-between px-4 sm:px-6 lg:px-8">
             <div className="flex items-center">
               <AlertTriangle className="w-5 h-5 mr-3 " />
               <p className="text-sm font-bold">You have unsubmitted drafts. Please click &ldquo;Submit Draft for Review&rdquo; to notify the requester.</p>
             </div>
             <button 
               onClick={() => {
                 const submitAction = liveActions.find(a => a.action === 'submit_draft');
                 if (submitAction) initiateWorkflowAction(submitAction);
               }}
               className="px-4 py-1 bg-[var(--color-surface)] text-orange-600 text-xs font-bold rounded hover:bg-orange-50 transition-colors shadow-sm"
             >
               Submit Now
             </button>
          </div>
        </div>
      )}

      {asIsBanner && (
        <div role="note" data-testid="issue-as-is-banner" className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 pt-6">
          <div className="flex items-start gap-2 px-4 py-3 rounded-lg border border-amber-300 bg-amber-50 text-sm text-amber-900">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
            <p><span className="font-bold">Issue as-is.</span> {asIsBanner}</p>
          </div>
        </div>
      )}

      <div className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 pt-6 empty:hidden"><DeclarationCard ticket={ticket} onDeclarationCheck={setDeclarationCheck} /></div>
      <div className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 pt-6 empty:hidden"><TicketRosterPanel ticket={ticket} orgId={activeOrgId} uid={uid} userName={(member?.displayName ?? '').trim() || (userEmail?.split('@')[0] ?? '').trim() || null} capPolicy={capPolicy} activeMemberCount={activeMemberCount} requesterRoles={requesterRoles} reviewRouted={reviewRouted} reviewRoutedReason={reviewRoutedReason} /></div>

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
                    {names.length > 0 && <> (<span className="italic">{names.join(', ')}{(sum.attachmentCount ?? 0) > names.length ? `, +${(sum.attachmentCount ?? 0) - names.length} more` : ''}</span>)</>}, {plural(sum.historyCount, 'history event')}.
                  </p>
                )}
                <p className="text-[13px] text-sky-800 mt-2">
                  <span className="font-bold">To view it all again:</span> have the saved archive{' '}
                  {ticket.archiveId ? <span className="font-mono break-all">&lt;root&gt;/data/{ticket.archiveId}.zip</span> : 'zip'}? Open it right here — or an admin can fully restore it from the Storage &amp; Backup page.
                </p>
                <button
                  onClick={() => setShowArchiveViewer(true)}
                  className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-sky-600 hover:bg-sky-500"
                >
                  <Archive className="w-3.5 h-3.5" /> View from archive…
                </button>
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
              <div><label className="text-[11px] text-[var(--color-text-faint)] font-medium">Unit</label><div data-testid="ticket-unit" className={`text-sm font-bold bg-[var(--color-surface-2)] px-2 py-1 rounded w-fit mt-1 border border-[var(--color-border)] ${unitShown.unknown ? 'italic text-[var(--color-text-muted)]' : 'font-mono text-[var(--color-text)]'}`}>{unitShown.text}</div>{unitShown.note && <div className="text-[10px] text-amber-700 mt-0.5">{unitShown.note}</div>}</div>
              <div><label className="text-[11px] text-[var(--color-text-faint)] font-medium">Requester</label><div className="min-w-0 text-sm text-[var(--color-text)] mt-1 flex items-center group cursor-help" title={ticket.requesterId}><User className="w-4 h-4 mr-2 text-slate-300 group-hover:text-orange-500 transition-colors shrink-0" /><span className="truncate">{ticket.requesterName}</span></div></div>
              <div><label className="text-[11px] text-[var(--color-text-faint)] font-medium">Assigned Lead</label><div className="min-w-0 text-sm text-[var(--color-text)] mt-1">{ticket.assignedDrafterName ? (<div className="flex items-center text-orange-700"><div className="w-2 h-2 rounded-full bg-green-500 mr-2 shrink-0" /><span className="truncate">{ticket.assignedDrafterName}</span></div>) : <span className="text-[var(--color-text-faint)] italic">Unassigned</span>}</div></div>
              <div>
                <label className="text-[11px] text-[var(--color-text-faint)] font-medium">Engineer Reviewer</label>
                <div className="min-w-0 text-sm text-[var(--color-text)] mt-1">
                  {ticket.assignedEngineerName ? (
                    <div className="flex items-center text-blue-700">
                      {/* DF-P6 fix pass (review, issue 7): an issue by management override is not a sign-off still pending. */}
                      <div className={`w-2 h-2 rounded-full mr-2 shrink-0 ${ticket.engineerApprovedAt && !engineeringOverride ? "bg-emerald-500" : engineeringOverride ? "bg-amber-500" : "bg-blue-500 animate-pulse"}`} />
                      <span className="truncate" title={ticket.assignedEngineerEmail || ticket.assignedEngineerName}>{ticket.assignedEngineerName}</span>
                      {ticket.engineerApprovedAt && !engineeringOverride && <span className="ml-2 text-[10px] text-emerald-600 font-bold uppercase">approved</span>}
                    </div>
                  ) : engineeringOverride ? null : <span className="text-[var(--color-text-faint)] italic">Not yet assigned</span>}
                  {engineeringOverride && (
                    <div data-testid="engineering-override" className="text-[11px] text-amber-700 mt-0.5">Issued by management override — no engineer sign-off{engineeringOverride.by ? ` (${engineeringOverride.by})` : ''}</div>
                  )}
                </div>
              </div>
              <div><label className="text-[11px] text-[var(--color-text-faint)] font-medium">Initiated</label><div className="text-sm font-semibold text-[var(--color-text)] mt-1 flex items-center"><Calendar className="w-4 h-4 mr-2 text-slate-300 shrink-0" />{toDate(ticket.createdAt).toLocaleDateString()}</div></div>
              <div>
                <label className="text-[11px] text-[var(--color-text-faint)] font-medium">Target Completion</label>
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
                <label className="text-[11px] text-[var(--color-text-faint)] font-medium">Watching</label>
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
            {/* PROJ-9: what the request form collected, and the project the
                request is linked to — no longer write-only. */}
            {customSections.map((sec) => (
              <div key={sec.id} data-testid="custom-category" className="mt-6 pt-6 border-t border-[var(--color-border)]">
                <label className="text-[10px] text-[var(--color-text-faint)] font-bold uppercase tracking-wider mb-2 block">{sec.label}</label>
                <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2">
                  {sec.fields.map((f) => (
                    <div key={f.key} className="min-w-0"><dt className="text-[11px] text-[var(--color-text-faint)] font-medium">{f.label}</dt><dd className="text-sm text-[var(--color-text)] break-words">{f.value}</dd></div>
                  ))}
                </dl>
              </div>
            ))}
            {projectRef && (
              <div data-testid="project-link" className="mt-6 pt-6 border-t border-[var(--color-border)]">
                <label className="text-[10px] text-[var(--color-text-faint)] font-bold uppercase tracking-wider mb-2 block">Project</label>
                <Link href={`/projects/${projectRef}`} className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-800 border border-blue-200 bg-blue-50 rounded-md px-2 py-1">
                  {projectName ?? 'Open the linked project'}
                </Link>
              </div>
            )}
          </div>

          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden flex flex-col">
             <div className="px-6 py-4 border-b border-[var(--color-border)] bg-slate-50/50 flex flex-col sm:flex-row justify-between items-center gap-4">
               <div><h2 className="text-sm font-bold text-[var(--color-text)] uppercase tracking-wide flex items-center"><Paperclip className="w-4 h-4 mr-2 text-orange-500" /> Project Assets</h2></div>
             </div>

             <div className="p-4 bg-slate-50/50 border-b border-[var(--color-border)] order-1">
               <h3 className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-widest mb-3">Incoming Assets (Source)</h3>
               {/* HAND-7 / HAND-3 (DF-P2's component): the source revision has moved. */}
               <div className="mb-3"><SourceDriftBanner metadata={ticket.metadata} orgId={ticket.orgId} /></div>
               {sourceRef && (
                 <div className="mb-3 bg-[var(--color-surface)] p-3 rounded-lg border border-[var(--color-border)] shadow-sm">
                   <div className="flex items-center justify-between gap-3 flex-wrap">
                     <div className="flex items-center space-x-3 overflow-hidden">
                       <div className="p-1.5 bg-blue-50 rounded text-blue-600"><FileText className="w-4 h-4" /></div>
                       <div className="min-w-0">
                         {/* DCW-5 (DEC-107 item 4 as amended): a viewer who may not
                             discover the source sees it marked restricted — its
                             recorded number and title under that label, never a link.
                             No row back means EITHER restricted OR gone from the
                             workspace (the read cannot tell them apart), and who else
                             can open it is per person — so the label claims neither. */}
                         {sourceDoc.state === 'unavailable' && (
                           <p data-testid="source-restricted" className="text-[10px] font-black uppercase tracking-wider text-rose-700">Restricted or no longer in this workspace — you can&apos;t open it here; ask whoever runs its library</p>
                         )}
                         <p className="text-xs font-bold text-[var(--color-text)] truncate">
                           {sourceRef.documentNumber || sourceDoc.doc?.documentNumber || 'Controlled document'}
                           {(sourceRef.title || sourceDoc.doc?.title) && (
                             <span className="font-normal text-[var(--color-text-muted)]"> — {sourceRef.title || sourceDoc.doc?.title}</span>
                           )}
                         </p>
                         <p className="text-[10px] text-[var(--color-text-faint)] mt-0.5">
                           {sourceRef.rev ? `Raised against Rev ${sourceRef.rev}` : 'Source revision not recorded on this request'}
                         </p>
                         {sourceDoc.state === 'loaded' && sourceDoc.review && sourceDoc.review.mode !== 'none' && (
                           <p className="text-[10px] font-semibold text-amber-800 mt-1">
                             {sourceDoc.review.mode === 'require'
                               ? `Publishing the deliverable to this document requires reviewer sign-off (${sourceDoc.review.configured} configured reviewer${sourceDoc.review.configured === 1 ? '' : 's'}) — approving this ticket does not satisfy it.`
                               : 'Publishing the deliverable to this document may route through review — approving this ticket does not satisfy a document sign-off.'}
                           </p>
                         )}
                       </div>
                     </div>
                     <div className="flex items-center gap-2 shrink-0">
                       {sourceDoc.state === 'loaded' && (() => {
                         // HAND-3 done-when 3: version ids decide when the request
                         // captured one (a relabelled or re-issued rev cannot fool it).
                         const drift = revDrift(
                           { versionId: sourceRef.versionId, rev: sourceRef.rev },
                           { versionId: sourceDoc.doc?.currentVersionId ?? null, rev: sourceDoc.doc?.rev ?? null },
                         );
                         if (drift === 'drifted') {
                           return (
                             <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                               <AlertTriangle className="w-3 h-3" /> Rev advanced — register now at Rev {sourceDoc.doc?.rev}
                             </span>
                           );
                         }
                         if (drift === 'same') {
                           return (
                             <span className="text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1">
                               Current (Rev {sourceDoc.doc?.rev})
                             </span>
                           );
                         }
                         return sourceDoc.doc?.rev ? (
                           <span className="text-[10px] text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md px-2 py-1">
                             Register: Rev {sourceDoc.doc.rev}
                           </span>
                         ) : null;
                       })()}
                       {deliverable?.state === 'published' && (
                         <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1">
                           <CheckCircle2 className="w-3 h-3" /> {deliverable.in_review ? `Draft ${deliverable.revision_label} in document review` : `Published as Rev ${deliverable.revision_label}`}
                         </span>
                       )}
                       {deliverable?.state === 'not_in_register' && (
                         <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                           <AlertTriangle className="w-3 h-3" /> Closed — deliverable not in the register{deliverable.register_rev ? ` (still Rev ${deliverable.register_rev})` : ''}
                         </span>
                       )}
                       {canOfferHandback && sourceDoc.state === 'loaded' && sourceDoc.doc && (
                         <button
                           type="button"
                           onClick={() => { void openHandback(); }}
                           disabled={handbackBusy}
                           title="Publish this request's Final deliverable as the next revision of the source document — offered to publish authority on the document's library, not to whoever can close the request (DEC-22)"
                           className="text-[10px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-2 py-1"
                         >
                           {handbackBusy ? 'Preparing…' : `Publish as revision of ${sourceRef.documentNumber || sourceDoc.doc.documentNumber || 'document'}`}
                         </button>
                       )}
                       {sourceDoc.state === 'loaded' && sourceDoc.doc?.libraryId ? (
                         <Link
                           href={`/documents/${sourceDoc.doc.libraryId}?doc=${sourceDoc.doc.id}`}
                           className="text-[10px] font-bold text-blue-600 hover:text-blue-800 border border-blue-200 bg-blue-50 rounded-md px-2 py-1"
                         >
                           Open in register
                         </Link>
                       ) : sourceDoc.state === 'unavailable' ? (
                         <span className="text-[10px] text-[var(--color-text-faint)] italic">Document not accessible to you</span>
                       ) : sourceDoc.state === 'error' ? (
                         <span className="text-[10px] text-amber-700 italic">Couldn&apos;t check the source document right now</span>
                       ) : null}
                     </div>
                   </div>
                 </div>
               )}
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
               <h3 className={`text-[10px] font-bold uppercase tracking-widest mb-3 flex items-center ${['FINAL_DRAFT', 'PENDING_FINAL_APPROVAL', 'CLOSED'].includes(ticket.status) ? 'text-teal-800' : 'text-teal-700'}`}>
                 <CheckCircle2 className="w-3 h-3 mr-1" /> Final Issued Deliverables
                 {ticket.deliverableRev && /^\d+$/.test(ticket.deliverableRev) && (
                   <span className="ml-2 px-1.5 py-0.5 bg-teal-600 text-white text-[9px] font-black rounded normal-case tracking-normal">Rev {ticket.deliverableRev}</span>
                 )}
               </h3>
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
               {/* DCW-4 (DF-P15): a request with a target library and no source document —
                   where its deliverable stands in the register, and the offer to publish it
                   as a new document there (to someone who may). */}
               {newDocLibraryId && (deliverable || canOfferNewDocument || canRecordExistingNewDocument) && (
                 <div className="mt-3 flex flex-wrap items-center gap-2 relative z-10">
                   {deliverable?.state === 'published' && (
                     <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1">
                       <CheckCircle2 className="w-3 h-3" /> {deliverable.in_review ? `Draft ${deliverable.revision_label} in document review` : (deliverable as { filed_as_draft?: boolean }).filed_as_draft ? 'Filed in the register as a Draft document' : `Published as Rev ${deliverable.revision_label}`}
                     </span>
                   )}
                   {deliverable?.state === 'not_in_register' && (
                     <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                       <AlertTriangle className="w-3 h-3" /> Closed — deliverable not in the register
                     </span>
                   )}
                   {canOfferNewDocument && (
                     <button
                       type="button"
                       onClick={() => { void openNewDocument(); }}
                       disabled={newDocBusy}
                       title="Create a new document in the request's target library from its Final deliverable — offered to whoever may add a document there, not to whoever can close the request (DEC-22)"
                       className="text-[10px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-2 py-1"
                     >
                       {newDocBusy ? 'Preparing…' : `Publish as a new document in ${targetLibraryName || 'the target library'}`}
                     </button>
                   )}
                   {canRecordExistingNewDocument && existingNewDoc && (existingNewDoc.versionId ? (
                     <button
                       type="button"
                       onClick={() => { void recordExistingNewDocument(); }}
                       disabled={recordingExisting}
                       title="This request's new document is already in the register but not recorded here — record it (the server checks it carries this request and sits in its library). It is never created a second time."
                       className="text-[10px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-2 py-1"
                     >
                       {recordingExisting ? 'Recording…' : `Record ${existingNewDoc.documentNumber || 'the existing document'} on the request`}
                     </button>
                   ) : (
                     <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                       <AlertTriangle className="w-3 h-3" /> {existingNewDoc.documentNumber || 'A new document'} was created but is not recorded here — refresh the page, or tell Document Control
                     </span>
                   ))}
                 </div>
               )}
               {/* DCW-4 remainder (DEC-90 ruling at the DF-P15 merge): a request with neither a
                   source document nor a library — where its deliverable stands, and the offer to
                   publish it as a new document in a library the publisher chooses. */}
               {chooseNewDocLibrary && (deliverable?.state === 'published' || canOfferChosenLibraryDocument || canRecordExistingChosenLibraryDocument) && (
                 <div className="mt-3 flex flex-wrap items-center gap-2 relative z-10">
                   {deliverable?.state === 'published' && (
                     <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1">
                       <CheckCircle2 className="w-3 h-3" /> {deliverable.in_review ? `Draft ${deliverable.revision_label} in document review` : (deliverable as { filed_as_draft?: boolean }).filed_as_draft ? 'Filed in the register as a Draft document' : `Published as Rev ${deliverable.revision_label}`}
                     </span>
                   )}
                   {canOfferChosenLibraryDocument && (
                     <button
                       type="button"
                       onClick={() => { void openNewDocument(); }}
                       disabled={newDocBusy}
                       title="This request names no library: create a new document from its Final deliverable in a library you choose — one where you may add a document. The request itself is not changed (DEC-107)."
                       className="text-[10px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-2 py-1"
                     >
                       {newDocBusy ? 'Preparing…' : 'Publish as a new document'}
                     </button>
                   )}
                   {canRecordExistingChosenLibraryDocument && existingNewDoc && (existingNewDoc.versionId ? (
                     <button
                       type="button"
                       onClick={() => { void recordExistingNewDocument(); }}
                       disabled={recordingExisting}
                       title="This request's new document is already in the register but not recorded here — record it (the server checks it carries this request and that you may publish into its library). It is never created a second time."
                       className="text-[10px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-2 py-1"
                     >
                       {recordingExisting ? 'Recording…' : `Record ${existingNewDoc.documentNumber || 'the existing document'} on the request`}
                     </button>
                   ) : (
                     <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                       <AlertTriangle className="w-3 h-3" /> {existingNewDoc.documentNumber || 'A new document'} was created but is not recorded here — refresh the page, or tell Document Control
                     </span>
                   ))}
                 </div>
               )}
               {/* PHYS-18 (DF-P15): who took a copy of this request's files, and the recall. */}
               {canRecallCopies && recallTicket && uid && (
                 <TicketCopyRecallPanel ticket={recallTicket} ticketNumber={ticket.ticketId ?? null} currentUserId={uid} currentUserName={userEmail ?? null} />
               )}
             </div>
          </div>

          {/* Formal approvals / e-signatures */}
          {ticket.id && (
            <SignaturePanel
              resourceType="ticket"
              resourceId={ticket.id}
              resourceLabel={`request ${ticket.ticketId}`}
              canSign={hasAnyRole(['Admin', 'DocCtrl']) || roles.some((r) => r.startsWith('Engineer'))}
            />
          )}
        </div>

        {/* RIGHT: ACTIVITY */}
        <div className="h-[calc(100dvh-140px)] flex flex-col bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden sticky top-24">
          <div className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-surface-2)]"><button onClick={() => setActiveTab('discussion')} className={`flex-1 py-3 text-xs font-bold transition-all ${activeTab === 'discussion' ? 'text-[var(--color-text)] border-b-2 border-orange-500 bg-[var(--color-surface)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-slate-100/50'}`}>Discussion</button><button onClick={() => setActiveTab('audit')} className={`flex-1 py-3 text-xs font-bold transition-all ${activeTab === 'audit' ? 'text-[var(--color-text)] border-b-2 border-orange-500 bg-[var(--color-surface)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-slate-100/50'}`}>Audit Log</button></div>
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 space-y-6 bg-slate-50/30 custom-scrollbar relative">
            {activeTab === 'discussion' && (
              <>
                {(!ticket.comments || ticket.comments.length === 0) && <div className="absolute inset-0 flex flex-col items-center justify-center opacity-40 pointer-events-none"><MessageSquare className="w-12 h-12 text-slate-300 mb-2" /><p className="text-sm text-[var(--color-text-faint)] font-medium">No comments yet</p></div>}
                {ticket.comments?.map((comment, idx) => (
                  <div key={`${comment.id}-${idx}`} id={`comment-${comment.id}`} className={`flex flex-col ${comment.user === userEmail ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2 ${highlightCommentId === comment.id ? 'rounded-2xl ring-2 ring-orange-400 ring-offset-2 transition-shadow' : ''}`}>
                    <div className="flex items-end gap-2 max-w-[90%]">
                       {comment.user !== userEmail && <UserAvatar email={comment.user} size={24} rounded="full" className="mb-1" />}
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
                            <div className="absolute -top-2 -right-2 opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
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
                          <div className="absolute -bottom-5 right-0 opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-[var(--color-text-faint)] whitespace-nowrap">{toDate(comment.date).toLocaleString()}</div>
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
            ticket.archivedAt ? (
              <div className="p-4 bg-sky-50 border-t border-sky-200 text-[11px] text-sky-800 flex items-center gap-2 flex-wrap">
                <Archive className="w-4 h-4 text-sky-600 shrink-0" />
                <span>This ticket is archived — its discussion lives in the offline archive.</span>
                <button onClick={() => setShowArchiveViewer(true)} className="font-bold text-sky-700 hover:underline">View from archive…</button>
                <span className="text-sky-600">Restore it to comment again.</span>
              </div>
            ) : (
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
            )
          )}
        </div>
      </div>
    </div>
  );
}
