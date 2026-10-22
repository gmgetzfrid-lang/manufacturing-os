"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket, TicketStatus, OrgDraftingSettings, SelectOption, Role } from '@/types/schema';
import { logAuditAction } from '@/lib/audit';
import { appAlert, appConfirm } from '@/components/providers/DialogProvider';
import { Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import UserAvatar from '@/components/ui/UserAvatar';
import {
  Search,
  Plus,
  Clock,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
  LayoutGrid,
  List as ListIcon,
  MoreVertical,
  Download,
  RefreshCw,
  User,
  SlidersHorizontal,
  X,
  Eye,
  ArrowUpDown,
  Briefcase,
  Layers,
  Flag,
  TrendingUp,
  Trash2,
  Archive,
  MessageCircle,
  Zap,
  FilterX,
  Inbox,
  MousePointerClick,
  Users,
  GitBranch,
  Megaphone,
  ShieldAlert,
} from 'lucide-react';
import {
  isActionRequired as ticketNeedsAction,
  isQueueViewer,
} from '@/lib/ticketAttention';
import { isEngineerRole } from '@/lib/workflow';
import { reviewModelFieldsFromRow } from '@/lib/reviewModel';
import { loadCapabilityPolicyEntry, type CapabilityPolicy } from '@/lib/capabilityPolicy';
import { affordancePolicyFault } from '@/lib/checkoutAffordances';
import { flaggedRequestTypes } from '@/lib/requestTypes';
import { isTerminalTicketStatus, TERMINAL_TICKET_STATUSES } from '@/lib/ticketShed';
import { csvLine } from '@/lib/csvSafe';
import { isPastDue, isNearingDue } from '@/lib/notifications';
import { creationNoticeOwed } from '@/lib/ticketLibrary';
import { parseSourceDocuments } from '@/lib/sourceDocRef';
import { driftedSources } from '@/components/requests/SourceDriftBanner';
import WorkflowDiagramModal from '@/components/requests/WorkflowDiagramModal';
import { ticketStatusLabel, ticketUnitDisplay, TICKET_STATUS_FILTER_ORDER } from '@/lib/ticketStatusLabels';
import { loadRequesterRoles } from '@/lib/ticketRequesterRoles';
import { readQueueScope, foldHistoryChunk, historySearchFilter, historyBeforeCursor, HISTORY_CHUNK, HISTORY_SEARCH_MAX, type HistoryState, type QueueQuery, type QueueReadResult } from '@/lib/ticketQueueRead';
import { OUTCOME_LABEL, isTicketOutcome } from '@/lib/ticketOutcome';
import { reasonForOutcome } from '@/components/requests/RequestOutcomes';

// =========================================================================================
// SECTION 1: TYPES & CONFIGURATION INTERFACES
// =========================================================================================

type SortField = 'ticketId' | 'createdAt' | 'lastModified' | 'status' | 'priority' | 'unit';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

interface FilterConfig {
  status: TicketStatus | 'ALL';
  type: string | 'ALL';
  dateRange: 'all' | 'today' | 'week' | 'month' | 'quarter';
  assignedTo: 'all' | 'me' | 'unassigned';
  priority: 'all' | 'urgent' | 'normal';
  search: string;
}

interface DashboardMetrics {
  totalVolume: number;
  activeQueue: number;
  staleTickets: number; 
  readyForIFC: number;  
  myActionItems: number;
  slot2Count: number;
  slot3Count: number;
  slot4Count: number;
  totalActive: number;
  myAssignments: number;
  unassigned: number;
  urgentAttention: number;
  pendingReview: number;
}

/** ROUTE-13 done-when 2 (DF-P14 integrator ruling, DEC-90): how long the
 *  realtime listener waits for a burst of tickets events to settle before it
 *  re-reads the list once; and the longest an unread event waits while events
 *  keep arriving. */
const REALTIME_SETTLE_MS = 500;
const REALTIME_MAX_WAIT_MS = 5_000;

// =========================================================================================
// SECTION 2: UTILITY FUNCTIONS
// =========================================================================================

const toDate = (date: unknown): Date => {
  if (!date) return new Date();
  const maybe = date as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === 'function') return maybe.toDate();
  if (date instanceof Date) return date;
  if (typeof date === 'string') return new Date(date);
  if (maybe.seconds) return new Date(maybe.seconds * 1000);
  return new Date(date as string | number | Date);
};

const calculateDaysOpen = (date: unknown) => {
  const start = toDate(date);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - start.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
};

const getStatusColor = (status: TicketStatus): string => {
  switch (status) {
    case 'PENDING_ENG_TEAM': return 'bg-indigo-50 text-indigo-700 border-indigo-200';
    case 'PENDING_ASSIGNMENT': return 'bg-purple-50 text-purple-700 border-purple-200'; 
    case 'DRAFTING': return 'bg-blue-50 text-blue-700 border-blue-200'; 
    case 'PENDING_REVIEW': return 'bg-yellow-50 text-yellow-700 border-yellow-200';
    case 'REVISION_REQ': return 'bg-amber-50 text-amber-700 border-amber-200 font-bold'; 
    case 'PENDING_IFC': return 'bg-teal-50 text-teal-700 border-teal-200';
    case 'FINAL_DRAFT': return 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]';
    case 'PENDING_FINAL_APPROVAL': return 'bg-lime-50 text-lime-700 border-lime-200';
    case 'CLOSED': return 'bg-gray-100 text-gray-500 border-gray-200 decoration-slate-400';
    case 'CANCELED': return 'bg-rose-50 text-rose-700 border-rose-200 line-through decoration-rose-300';
    default: return 'bg-[var(--color-surface)] text-gray-900 border-gray-200';
  }
};

const getPriorityColor = (isUrgent: boolean, type: string) => {
  if (type === 'RFI') return 'text-pink-600 bg-pink-50 border-pink-100';
  if (isUrgent) return 'text-amber-600 bg-amber-50 border-amber-100';
  return 'text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]';
};

// A small count pill used in the supervisor board's column header to summarise
// how a drafter's load breaks down by stage.
const StageChip = ({ label, n, className, title, lane }: { label: string; n: number; className: string; title?: string; lane: string }) => (
  <span data-testid={`lane-chip-${lane}`} title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${className}`}>
    {n}<span className="font-medium opacity-80">{label}</span>
  </span>
);

// UI-7 (DF-P9 integrator fix pass, DEC-90): the board's lane chips. A chip that
// counts ONE status reads that status's shared label (lib/ticketStatusLabels.ts),
// the words its cards below carry. The `review` bucket counts FOUR statuses, so
// it never borrows one of their labels ("In review" is PENDING_REVIEW's alone):
// it says what it holds, and its tooltip names the four in the shared words.
// "Overdue" is a due-date count (lib/notifications.ts isPastDue), not a status.
const REVIEW_BUCKET_STATUSES: readonly TicketStatus[] = ['PENDING_ASSIGNMENT', 'PENDING_ENG_TEAM', 'PENDING_REVIEW', 'PENDING_FINAL_APPROVAL'];
const REVIEW_BUCKET_LABEL = 'Review or assignment';
const REVIEW_BUCKET_TITLE = `Waiting at one of: ${REVIEW_BUCKET_STATUSES.map((st) => ticketStatusLabel(st)).join(', ')}`;

/** PERS-3 / PERS-7 (DF-P9 integrator fix pass): what a bulk action does not
 *  touch, in words — the selected requests outside the list on screen (kept
 *  selected) and those no longer loaded (dropped) — said before the action
 *  (`when: 'before'`, a confirm) or after it. Empty when it touches every
 *  selected request. */
const untouchedNote = (outOfView: number, gone: number, verb: string, when: 'before' | 'after' = 'after'): string[] => {
  const out: string[] = [];
  const one = (n: number) => n === 1;
  const not = (n: number) => (when === 'before' ? `${one(n) ? 'it' : 'they'} will not be ${verb}` : `${one(n) ? 'it was' : 'they were'} not ${verb}`);
  if (outOfView > 0) out.push(`${outOfView} selected request${one(outOfView) ? ' is' : 's are'} not in the list on screen, so ${not(outOfView)} — ${one(outOfView) ? 'it stays' : 'they stay'} selected; show ${one(outOfView) ? 'it' : 'them'} (change the filters or the view) to include ${one(outOfView) ? 'it' : 'them'}.`);
  if (gone > 0) out.push(`${gone} selected request${one(gone) ? ' is' : 's are'} no longer loaded in this list (hidden as closed, deleted, or no longer visible to you), so ${not(gone)}.`);
  return out;
};

/** drafting-flow DF-P16 (ROUTE-13 done-when 1): the queue's role scope — the
 *  whole workspace for these roles, else the Drafter's or the requester's own
 *  requests — one rule for the open read and the closed history, so the two
 *  can never read different scopes. (The rule itself is unchanged.) */
const readsWholeWorkspace = (roles: readonly string[]): boolean =>
  (['Admin', 'Manager', 'Supervisor', 'DraftingSupervisor', 'DocCtrl'] as Role[]).some((r) => roles.includes(r)) || roles.some((r) => r.includes('Engineer'));

/**
 * ROUTE-13 done-when 1 (drafting-flow DF-P16; the integrator's ruling under
 * DEC-90 — fail-safe, no regression): every closed or canceled request is
 * reachable from the queue ON DEMAND. Nothing here runs until someone opens
 * it, and nothing here touches the queue: the open read, its counts, Needs
 * me, the realtime debounce and Export CSV are exactly as before. It reads
 * through the queue's keyset reader (lib/ticketQueueRead.ts — a failed read
 * is said, never an empty or short list shown as whole; a short read says N
 * of M), in the queue's role scope and as the signed-in member (RLS, the
 * Contractor-only read included, decides as it does for the queue): CLOSED
 * and CANCELED requests, most recently active first, HISTORY_CHUNK at a time;
 * "Show older" carries on from the last one shown, so nothing bounds how far
 * back it reaches. A search over the request number and title, and a "last
 * active on or before" date, narrow it on the server.
 */
function ClosedHistory({ orgId, uid, roles, onClose }: { orgId: string; uid: string; roles: readonly string[]; onClose: () => void }) {
  const scope: 'workspace' | 'drafter' | 'requester' = readsWholeWorkspace(roles) ? 'workspace' : roles.includes('Drafter') ? 'drafter' : 'requester';
  const [search, setSearch] = useState('');
  const [before, setBefore] = useState('');
  // What the list on screen was read for (the last Find).
  const [asked, setAsked] = useState<{ search: string; before: string }>({ search: '', before: '' });
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  // The panel opens reading (the mount's read below).
  const [busy, setBusy] = useState(true);
  // Only the latest read's answer is applied (a Find during a read wins).
  const seqRef = useRef(0);

  // One chunk of the history: closed and canceled requests in the queue's
  // scope, the search on the server, from the start, a date, or where the
  // list on screen stopped. Callers mark the panel busy; state is set only
  // once the read answers, and only for the latest read.
  const read = useCallback((from: { search: string; before: string }, prev: HistoryState | null) => {
    const seq = ++seqRef.current;
    const filter = historySearchFilter(from.search);
    const build = (counted: boolean) => {
      let q = supabase.from('tickets').select('*', counted ? { count: 'exact' } : undefined)
        .eq('org_id', orgId)
        .in('status', [...TERMINAL_TICKET_STATUSES]);
      if (scope === 'drafter') q = q.eq('assigned_drafter_id', uid);
      else if (scope === 'requester') q = q.eq('requester_id', uid);
      if (filter) q = q.or(filter);
      return q as unknown as QueueQuery;
    };
    return readQueueScope(build, { ceiling: HISTORY_CHUNK, after: prev ? prev.next : historyBeforeCursor(from.before) }).then((res) => {
      if (seq !== seqRef.current) return;
      setBusy(false);
      if (!res.ok) { setFault(res.error); return; }
      setFault(null);
      setHistory(foldHistoryChunk(prev, res));
    });
  }, [orgId, uid, scope]);

  const start = useCallback((from: { search: string; before: string }) => {
    setAsked(from);
    setHistory(null);
    setFault(null);
    setBusy(true);
    void read(from, null);
  }, [read]);

  // Opening the panel is the ask: the newest closed requests, read once (the
  // state starts as a fresh read's: nothing asked, nothing held, no fault,
  // busy).
  useEffect(() => { void read({ search: '', before: '' }, null); }, [read]);

  const narrowed = [
    asked.search.trim() ? `matching \u201c${asked.search.trim().slice(0, HISTORY_SEARCH_MAX)}\u201d` : '',
    asked.before ? `last active on or before ${asked.before}` : '',
  ].filter(Boolean).join(', ');
  const what = `closed and canceled requests${narrowed ? ` ${narrowed}` : ''}`;
  const n = history?.rows.length ?? 0;
  const whose = scope === 'workspace' ? 'in this workspace' : scope === 'drafter' ? 'assigned to you' : 'you requested';

  return (
    <section data-testid="closed-history" aria-labelledby="closed-history-heading" className="mb-6 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 id="closed-history-heading" className="text-lg font-black text-[var(--color-text)] flex items-center"><Archive className="w-5 h-5 mr-2 text-[var(--color-text-faint)]" />Closed history</h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">Every closed and canceled request {whose}, most recently active first, {HISTORY_CHUNK} at a time — read only while this is open. The queue below is not changed by it.</p>
        </div>
        <button type="button" onClick={onClose} data-testid="closed-history-close" className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]" title="Close the closed history"><X className="w-5 h-5" /></button>
      </div>
      <form
        className="flex flex-wrap items-end gap-3 mb-4"
        onSubmit={(e) => { e.preventDefault(); start({ search, before }); }}
      >
        <label className="flex-1 min-w-[220px]">
          <span className="block text-xs font-bold text-[var(--color-text-muted)] uppercase mb-1">Request number or title</span>
          <input type="text" data-testid="closed-history-search" value={search} maxLength={HISTORY_SEARCH_MAX} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. KE-1042 or pump iso" className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg text-sm" />
        </label>
        <label>
          <span className="block text-xs font-bold text-[var(--color-text-muted)] uppercase mb-1">Last active on or before</span>
          <input type="date" data-testid="closed-history-before" value={before} onChange={(e) => setBefore(e.target.value)} className="px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg text-sm" />
        </label>
        <button type="submit" data-testid="closed-history-find" className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-bold hover:bg-slate-800">Find</button>
      </form>

      {fault && (
        <div role="alert" data-testid="closed-history-failed" className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 flex items-start gap-3 text-red-900">
          <AlertCircle className="w-5 h-5 mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm flex-1">
            {history
              ? <><span className="font-bold">The older closed requests could not be read</span> — {fault}. What is listed is as read so far; nothing past it is shown.</>
              : <><span className="font-bold">The closed history could not be read</span> — {fault}. Nothing is shown rather than a list that may be missing requests.</>}
          </div>
          <button type="button" onClick={() => { setBusy(true); void read(asked, history); }} className="px-3 py-1.5 bg-[var(--color-surface)] border border-red-300 rounded-lg text-xs font-bold text-red-800 hover:bg-red-100">Try again</button>
        </div>
      )}

      {history && (n === 0
        ? <p data-testid="closed-history-empty" className="text-sm text-[var(--color-text-muted)]">No {what} {narrowed ? 'were found' : whose}.</p>
        : (
          <ul data-testid="closed-history-list" className="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-xl">
            {history.rows.map((r) => {
              const id = String(r.id);
              const status = String(r.status ?? '');
              const outcome = isTicketOutcome(r.outcome) ? OUTCOME_LABEL[r.outcome] : null;
              // DF-P16 fix pass: only a reason recorded with the outcome the
              // request has now — a reopen leaves the old one behind (SM-16).
              const reason = reasonForOutcome(r.outcome, r.metadata as Record<string, unknown> | null | undefined)?.label;
              const lm = typeof r.last_modified === 'string' ? r.last_modified : null;
              return (
                <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                  <Link href={`/requests/${id}`} data-testid="closed-history-row" className="font-bold text-orange-700 hover:underline">{String(r.ticket_id ?? id)}</Link>
                  <span className="flex-1 min-w-0 truncate text-[var(--color-text)]">{String(r.title ?? '')}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${getStatusColor(status as TicketStatus)}`}>{ticketStatusLabel(status)}</span>
                  {outcome && <span className="text-xs text-[var(--color-text-muted)]">{outcome}{reason ? ` — ${reason}` : ''}</span>}
                  {lm && <span className="text-xs text-[var(--color-text-faint)]">last active {new Date(lm).toLocaleDateString()}</span>}
                </li>
              );
            })}
          </ul>
        ))}

      {history && n > 0 && (
        <p role="status" data-testid="closed-history-count" className="text-sm text-[var(--color-text-muted)] mt-3">
          {history.next
            ? (history.total !== null
                ? <>Showing the {n} most recently active of the {history.total} {what}. Show older reads the next {HISTORY_CHUNK}.</>
                : <>Showing the {n} most recently active {what}; more may exist. Show older reads the next {HISTORY_CHUNK}.</>)
            : history.short
              ? (history.total !== null
                  ? <>This list shows {n} of the {history.total} requests in this view — requests changed while it was being read. Refresh to read it again.</>
                  : <>This list shows the {n} requests that could be read, but the total could not be counted, so more may exist. Refresh to read it again.</>)
              : <>All {n} {what} {narrowed ? 'are' : `${whose} are`} listed.</>}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 mt-3">
        {history?.next && (
          <button type="button" data-testid="closed-history-older" disabled={busy} onClick={() => { setBusy(true); void read(asked, history); }} className="px-4 py-2 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Show older</button>
        )}
        {history && !busy && (
          <button type="button" data-testid="closed-history-refresh" onClick={() => start(asked)} className="text-sm font-bold text-[var(--color-text-muted)] hover:underline">Refresh</button>
        )}
        {busy && <span className="flex items-center text-sm text-[var(--color-text-muted)]"><Spinner size="sm" className="mr-2" />Reading closed requests…</span>}
      </div>
    </section>
  );
}

// =========================================================================================
// SECTION 4: MAIN COMPONENT - REQUEST PORTAL
// =========================================================================================

export default function RequestPortal() {
  const { activeRole, roles, activeOrgId, uid, hasAnyRole } = useRole();
  
  // --- STATE ---
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  // When true, the fetch drops the terminal-status filter (CLOSED and
  // CANCELED — WF-17) so finished tickets show up. Lets a user find a
  // previously completed request to pull old drafts or reopen it.
  const [showClosed, setShowClosed] = useState<boolean>(false);
  // ROUTE-13 done-when 1 (DF-P16): the closed history is open — read on
  // demand, beside the queue, never into it.
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // ROUTE-12 (DF-P14; the integrator's ruling under DEC-90): the list's own
  // read, stated. `listFault` — the last read failed (a page of it failed:
  // the whole read is refused, never a short list shown as whole);
  // `listLoadedFor` — the scope (workspace, member, roles, closed toggle) a
  // read last succeeded for, so a later failure in THAT scope keeps its list,
  // said to be as last read, and a failure after the scope changed never
  // presents another scope's list; `listShort` — the read ended with fewer
  // rows than its count (the ceiling, or requests that changed mid-read), or
  // with no count at all; `openComplete` — at the ceiling, every OPEN request
  // was still read (fix pass: the open scope is read on its own), so only
  // closed history is bounded.
  const [listFault, setListFault] = useState<string | null>(null);
  const [listLoadedFor, setListLoadedFor] = useState<string | null>(null);
  // `merged` (DF-P14 integrator ruling (4), DEC-90): the list is the union of
  // more than one scope read (the Drafter's assigned scope and the pool),
  // whose counts may overlap — no total is claimed (`total` null) unless an
  // exact de-duplicated one is known.
  const [listShort, setListShort] = useState<{ shown: number; total: number | null; capped: boolean; openComplete: boolean; closedShown: number; merged: boolean } | null>(null);
  const [listReadAt, setListReadAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [processingBulk, setProcessingBulk] = useState<boolean>(false);
  const [requestTypeOptions, setRequestTypeOptions] = useState<SelectOption[]>([]);
  // DRAFT-2 / WF-15: the type-level flags the ticket page evaluates, read
  // from the same drafting row, so a row's "action needed" marker matches
  // the page (an engineering-first type disables pick-up in the queue).
  const [engineeringFirstTypes, setEngineeringFirstTypes] = useState<string[]>([]);
  const [closeWithoutReviewTypes, setCloseWithoutReviewTypes] = useState<string[] | undefined>(undefined);

  // --- STATE: VIEW & UI ---
  // 'team' is the supervisor lens: active work grouped by the drafter it sits
  // with (plus the unassigned pool). It is strictly OPT-IN from the view
  // switcher — the portal always opens on the classic table. (It briefly
  // auto-switched management roles onto the board, which replaced the page
  // people knew with one they never asked for. Never hijack the landing
  // view.) A user's last pick is remembered.
  const [viewMode, setViewMode] = useState<'table' | 'grid' | 'team'>('table');
  const isSupervisorView = isQueueViewer(roles);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('requests.viewMode');
      if (saved === 'table' || saved === 'grid' || saved === 'team') setViewMode(saved);
    } catch { /* storage unavailable — keep the table default */ }
  }, []);
  const pickView = useCallback((mode: 'table' | 'grid' | 'team') => {
    setViewMode(mode);
    try { localStorage.setItem('requests.viewMode', mode); } catch { /* non-fatal */ }
  }, []);
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState<boolean>(false);
  const [selectedTicketIds, setSelectedTicketIds] = useState<Set<string>>(new Set());
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);
  // UI-2: the workflow map, reachable from the queue (not only a ticket).
  const [showWorkflowMap, setShowWorkflowMap] = useState(false);

  // --- STATE: FILTERING ---
  // FRIC-9 / UI-6 (DF-P9; ruled under DEC-90): the queue opens on what needs
  // ME — the engine's action-required set (lib/ticketAttention.ts), for every
  // role — with "All open" one click away, and both counts on screen either
  // way. The assignee filter starts at "all" for everyone: the needs-me lens
  // is the default narrowing now (it used to be `assignedTo: 'me'` for a
  // Drafter only, a proxy for this set).
  const [attentionView, setAttentionView] = useState<'needs_me' | 'all'>('needs_me');
  const [filters, setFilters] = useState<FilterConfig>({
    status: 'ALL',
    type: 'ALL',
    dateRange: 'all',
    assignedTo: 'all',
    priority: 'all',
    search: ''
  });

  const [sortConfig, setSortConfig] = useState<SortConfig>({
    field: 'lastModified',
    direction: 'desc'
  });

  // --- STATE: PAGINATION ---
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [itemsPerPage, setItemsPerPage] = useState<number>(25);

  // --- FETCH CONFIG FOR FILTERS ---
  useEffect(() => {
    if (!activeOrgId) return;
    const fetchConfig = async () => {
      try {
        const { data } = await supabase
          .from('org_configurations')
          .select('data')
          .eq('org_id', activeOrgId)
          .eq('key', 'drafting')
          .single();
        if (data?.data) {
          const cfg = data.data as OrgDraftingSettings;
          if (cfg.requestTypes?.options) setRequestTypeOptions(cfg.requestTypes.options);
          setEngineeringFirstTypes(flaggedRequestTypes(data.data, 'engineeringFirst'));
          const closeTypes = flaggedRequestTypes(data.data, 'closeWithoutReview');
          setCloseWithoutReviewTypes(closeTypes.length > 0 ? closeTypes : undefined);
        }
      } catch (e) {
        console.error("Failed to load filter config", e);
      }
    };
    fetchConfig();
  }, [activeOrgId]);

  // --------------------------------------------------------------------
  // HELPER: ACTION REQUIRED CHECKER
  // --------------------------------------------------------------------
  // Delegates to the shared rule in lib/ticketAttention so the portal's "action
  // needed" badges, the sidebar count, and the header bell stay identical.
  // WF-24: that rule is derived from the workflow engine under the org's own
  // capability policy, so a row is marked exactly when the ticket page would
  // offer this viewer a live action.
  const [capPolicy, setCapPolicy] = useState<CapabilityPolicy | undefined>(undefined);
  // AUTHZ-15 (DF-P9; the integrator's ruling under DEC-89): the policy could
  // not be read and no last good copy was served (`unreadable`, or a read
  // that threw). The shipped defaults are NOT the org's policy, so the
  // policy-dependent parts of the queue — the "needs you" markers, the
  // needs-me list and its count, the Action Required tile's count (shown as
  // unknown, never 0), Archive and Force Close (whether the viewer may use
  // them is the policy's answer) — are held back with the reason and a Try
  // again. The page claims nothing about the server: the workflow route reads
  // the policy on its own (DEC-89 item 3). A `stale` answer is the last good
  // policy and is drawn as is.
  const [policyFault, setPolicyFault] = useState<string | null>(null);
  const [policyAttempt, setPolicyAttempt] = useState(0);
  // GAP-2 / DEC-12: the active member count the ticket page evaluates the
  // engine under — separation of duties (3+) disables a Drafter-requester's
  // pick-up, so without it the row was marked for a ticket the page showed
  // as view-only.
  const [activeMemberCount, setActiveMemberCount] = useState<number | undefined>(undefined);
  // FRIC-7: the requesters' current collections, read with the tickets — the
  // engine's input on the ticket page and the route (an entry [] = the
  // requester is no longer an active member). null = unknown.
  const [requesterRoles, setRequesterRoles] = useState<ReadonlyMap<string, readonly string[]> | null>(null);
  useEffect(() => {
    let alive = true;
    if (!activeOrgId) return;
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
      .then(({ count }) => { if (alive && typeof count === 'number') setActiveMemberCount(count); }, () => {});
    return () => { alive = false; };
  }, [activeOrgId, policyAttempt]);
  const isActionRequired = useCallback(
    (ticket: Ticket) => !policyFault && ticketNeedsAction(ticket, { uid, roles, policy: capPolicy, engineeringFirstTypes, closeWithoutReviewTypes, activeMemberCount, requesterRoles }),
    [uid, roles, capPolicy, policyFault, engineeringFirstTypes, closeWithoutReviewTypes, activeMemberCount, requesterRoles],
  );


  // --------------------------------------------------------------------
  // EFFECT: DATA SYNC ENGINE
  // --------------------------------------------------------------------
  // "Any" means any — so ALL, CLOSED and CANCELED all pull finished tickets.
  // The "Show Closed" toggle additionally forces them into narrow status
  // views (e.g. show Drafting + Closed together). Specific open statuses skip
  // the finished rows entirely unless that toggle is on.
  const includeClosed = showClosed || filters.status === 'ALL' || isTerminalTicketStatus(filters.status);
  // ROUTE-12 (DF-P14): the scope the list is read for.
  const listScopeKey = `${activeOrgId ?? ''}|${uid ?? ''}|${roles.join(',')}|${includeClosed ? 1 : 0}`;
  const listLoaded = listLoadedFor === listScopeKey;
  // PERS-3 (DF-P9 fix pass): a way to re-read the list on demand — a mark
  // urgent that found the list's copy stale cannot wait on a realtime event
  // that may never come (a dropped channel, a tab woken from sleep).
  const refetchTicketsRef = useRef<(() => void) | null>(null);
  // ROUTE-12 fix pass: every list read is numbered; only the LATEST read's
  // answer is applied (rows, fault, short, scope, time), so two overlapping
  // reads — a realtime event during a multi-page read — can never land out of
  // order: a late stale failure never covers a fresh list, and a late stale
  // success never replaces a newer one or clears a real failure.
  const readSeqRef = useRef(0);
  useEffect(() => {
    if (!uid || !activeOrgId) {
      setTickets([]);
      setLoading(false);
      return;
    }
    let alive = true;
    const scopeKey = listScopeKey;

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
      // drafting-flow GAP-105 / TIER-4 (DF-P19): the library, the work and
      // code class and the review-model columns, from the one mapper the
      // route's rowToTicket and the request page spread — so the list's
      // attention marks read the same capability resource and engineering
      // gate as the page and the route (undefined / null before the pastes).
      ...reviewModelFieldsFromRow(r),
      watchers: (r.watchers as string[] | undefined) ?? [],
      targetCompletionAt: r.target_completion_at as string | null | undefined,
      attachments: (r.attachments as Ticket['attachments']) ?? [],
      comments: (r.comments as Ticket['comments']) ?? [],
      history: (r.history as Ticket['history']) ?? [],
      unreadBy: (r.unread_by as string[]) ?? [],
      revisionCount: r.revision_count as number | undefined,
      metadata: (r.metadata as Record<string, unknown> | null) ?? undefined,
      archivedAt: r.archived_at as string | null | undefined,
      createdAt: r.created_at as string,
      lastModified: r.last_modified as string | undefined,
      updatedAt: r.updated_at as string | undefined,
    });

    const fetchTickets = async () => {
      const seq = ++readSeqRef.current;
      const latest = () => alive && readSeqRef.current === seq;
      try {
        setLoading(true);
        let rows: Record<string, unknown>[] = [];

        // ROUTE-12 (DF-P14): each scope is read in keyset pages until it
        // ends (lib/ticketQueueRead.ts — every row whatever PostgREST's
        // max-rows is, newest-modified first), and a page that fails fails
        // the read: the list is never a silently short or empty queue.
        // `select` starts a fresh query: the select (with the exact count on
        // the first page) and the scope's filters, as before.
        const select = (counted: boolean) => supabase.from('tickets').select('*', counted ? { count: 'exact' } : undefined);
        type Sel = ReturnType<typeof select>;
        type Ok = Extract<QueueReadResult, { ok: true }>;
        // ROUTE-12 fix pass: a scope that holds closed requests and stops at
        // the ceiling (QUEUE_READ_CEILING, newest-modified first) is read a
        // second time for its OPEN requests alone, so every open request —
        // the list, Needs me, the Action Required tile, every count of open
        // work — is whole whatever the history holds; only closed history is
        // bounded, and the page says so (drafting-flow ROUTE-13).
        const readScope = async (filter: (q: Sel) => Sel, holdsClosed: boolean): Promise<{ read: QueueReadResult; open?: QueueReadResult }> => {
          const read = await readQueueScope((counted) => filter(select(counted)) as unknown as QueueQuery);
          if (!holdsClosed || !read.ok || !read.capped) return { read };
          const open = await readQueueScope((counted) => filter(select(counted)).not('status', 'in', '("CLOSED","CANCELED")') as unknown as QueueQuery);
          return { read, open };
        };
        let reads: Array<{ read: QueueReadResult; open?: QueueReadResult }>;
        if (readsWholeWorkspace(roles)) {
          reads = [await readScope((q) => {
            const scoped = q.eq('org_id', activeOrgId);
            return includeClosed ? scoped : scoped.not('status', 'in', '("CLOSED","CANCELED")');
          }, includeClosed)];
        } else if (roles.includes('Drafter')) {
          reads = await Promise.all([
            // the assigned scope holds closed requests whatever the toggle
            // (the client filter below leaves them out), as before
            readScope((q) => q.eq('org_id', activeOrgId).eq('assigned_drafter_id', uid), true),
            readScope((q) => q.eq('org_id', activeOrgId).eq('status', 'PENDING_ASSIGNMENT'), false),
          ]);
        } else {
          reads = [await readScope((q) => {
            const scoped = q.eq('org_id', activeOrgId).eq('requester_id', uid);
            return includeClosed ? scoped : scoped.not('status', 'in', '("CLOSED","CANCELED")');
          }, includeClosed)];
        }
        const failed = reads.flatMap((r) => (r.open ? [r.read, r.open] : [r.read]))
          .find((r): r is Extract<QueueReadResult, { ok: false }> => !r.ok);
        if (failed) {
          console.error("Fetch Error:", failed.error);
          if (latest()) { setListFault(failed.error); setLoading(false); setRefreshing(false); }
          return;
        }
        const done = reads as Array<{ read: Ok; open?: Ok }>;
        if (done.length === 1 && !done[0].open) {
          rows = done[0].read.rows;
        } else {
          // Each request once, in the order first read (the open scope's
          // extra rows are older than every row of the capped read).
          const map = new Map<string, Record<string, unknown>>();
          for (const r of done.flatMap((d) => [...d.read.rows, ...(d.open?.rows ?? [])])) {
            map.set(r.id as string, r as Record<string, unknown>);
          }
          rows = Array.from(map.values());
          if (!includeClosed) rows = rows.filter((r) => !isTerminalTicketStatus(r.status as string));
        }
        const short = done.some((d) => !d.read.complete)
          ? {
              shown: rows.length,
              // DF-P14 integrator ruling (4), DEC-90: overlapping scope counts
              // are never summed into a total — one scope's exact count, or none.
              total: done.length === 1 ? done[0].read.total : null,
              capped: done.some((d) => d.read.capped),
              // every OPEN request is in the list: each read is whole, or it
              // stopped at the ceiling and its open requests were read whole
              // on their own (a read short for any other reason is not).
              openComplete: done.every((d) => d.read.complete || (d.read.capped && !!d.open && d.open.complete)),
              merged: done.length > 1,
              closedShown: rows.filter((r) => isTerminalTicketStatus(r.status as string)).length,
            }
          : null;

        const mapped = rows.map(fromRow);
        // FRIC-7: the requesters' current collections, in one batched read
        // (a failed read is null — every requester assumed present).
        const reqRoles = await loadRequesterRoles(activeOrgId, mapped.map((t) => t.requesterId));
        if (latest()) {
          setTickets(mapped);
          setRequesterRoles(reqRoles);
          setListFault(null);
          setListLoadedFor(scopeKey);
          setListShort(short);
          setListReadAt(new Date().toISOString());
          setLoading(false);
          setRefreshing(false);
        }
      } catch (err) {
        console.error("Fetch Error:", err);
        if (latest()) { setError("Failed to load tickets."); setListFault((err as Error)?.message || "the request list could not be read"); setLoading(false); setRefreshing(false); }
      }
    };

    // ROUTE-12 review fix pass 2: realtime re-reads are COALESCED. A read of
    // the whole scope is several select('*') pages; one tickets event each
    // (a bulk close of 20 requests is 20 events) used to start that many
    // overlapping reads per open tab. While a read started here is in
    // flight, further events only mark the list dirty; when it settles, ONE
    // trailing read runs if anything arrived meanwhile — so a burst costs at
    // most two reads. Explicit reads (Try again, Refresh, a stale-row
    // re-read) go straight to fetchTickets; readSeqRef still applies only
    // the latest answer.
    //
    // ROUTE-13 done-when 2 (ruled by the integrator at the DF-P14 merge,
    // 2026-10-20, DEC-90): on top of that coalescing, the listener is a
    // TRAILING DEBOUNCE — an event only (re)arms a REALTIME_SETTLE_MS timer,
    // so a burst of events starts ONE read after it settles (at most one
    // re-read per tab per burst). An event during an in-flight read still
    // costs one trailing read. A stream of events that never settles cannot
    // starve the list: REALTIME_MAX_WAIT_MS after the first unread event the
    // read starts anyway. The first read on mount, Try again and Refresh stay
    // immediate (fetchTickets; readSeqRef applies only the latest answer).
    let readInFlight = false;
    let dirty = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let firstPendingAt: number | null = null;
    const coalescedRead = async (): Promise<void> => {
      readInFlight = true;
      try { await fetchTickets(); } finally { readInFlight = false; }
      if (dirty && alive) { dirty = false; await coalescedRead(); }
    };
    const onSettled = () => {
      settleTimer = null;
      firstPendingAt = null;
      if (!alive) return;
      if (readInFlight) { dirty = true; return; }
      void coalescedRead();
    };
    const onTicketsEvent = () => {
      if (!alive) return;
      const now = Date.now();
      if (firstPendingAt === null) firstPendingAt = now;
      if (settleTimer !== null) clearTimeout(settleTimer);
      const wait = Math.max(0, Math.min(REALTIME_SETTLE_MS, firstPendingAt + REALTIME_MAX_WAIT_MS - now));
      settleTimer = setTimeout(onSettled, wait);
    };

    void coalescedRead();
    refetchTicketsRef.current = () => { if (alive) void fetchTickets(); };
    const channel = supabase
      .channel(`tickets-portal-${activeOrgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `org_id=eq.${activeOrgId}` },
        () => { onTicketsEvent(); })
      // notifications RT-4 (DF-P9): Supabase does not filter DELETE events,
      // so the org-filtered listener above never hears one. This unfiltered
      // companion (the attention feed's pattern, DEC-105 §4) hears every
      // tenant's tickets DELETEs — the old row's primary key alone — and acts
      // only on a ticket this list holds: it drops that row, nothing else.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tickets' },
        (payload) => {
          if (!alive) return;
          const gone = (payload as { old?: { id?: string } | null } | undefined)?.old?.id;
          if (!gone) return;
          setTickets((prev) => (prev.some((t) => t.id === gone) ? prev.filter((t) => t.id !== gone) : prev));
        })
      .subscribe();

    return () => { alive = false; if (settleTimer !== null) clearTimeout(settleTimer); refetchTicketsRef.current = null; supabase.removeChannel(channel); };
  }, [roles, activeOrgId, uid, includeClosed, listScopeKey]);

  // --------------------------------------------------------------------
  // MEMO: ROLE-AWARE METRICS ENGINE
  // --------------------------------------------------------------------
  const metrics: DashboardMetrics = useMemo(() => {
    const activeTickets = tickets.filter(t => !isTerminalTicketStatus(t.status)); 
    
    const myActionItems = tickets.filter(t => isActionRequired(t)).length;
    let slot2Count = 0;
    let slot3Count = 0;
    let slot4Count = 0;

    // SESS-6: no role is known yet (activeRole null) — no role lens, so the
    // three role tiles stay 0, exactly as the old "Viewer" placeholder fell
    // through every branch. The lens is the headline's (display only).
    if (activeRole === null) {
      // nothing to count
    }
    else if (activeRole === 'Drafter') {
      slot2Count = activeTickets.filter(t => t.assignedDrafterId === uid).length; 
      slot3Count = activeTickets.filter(t => t.assignedDrafterId === uid && t.status === 'REVISION_REQ').length; 
      slot4Count = activeTickets.filter(t => t.status === 'PENDING_ASSIGNMENT').length; 
    } 
    else if (activeRole === 'Requester') {
      slot2Count = activeTickets.filter(t => t.requesterId === uid).length; 
      slot3Count = activeTickets.filter(t => t.requesterId === uid && t.status === 'PENDING_REVIEW').length; 
      slot4Count = tickets.filter(t => t.requesterId === uid && t.status === 'CLOSED').length; 
    }
    else if (['Manager', 'Admin', 'Supervisor', 'DraftingSupervisor'].includes(activeRole)) {
      slot2Count = activeTickets.filter(t => t.status === 'PENDING_ENG_TEAM').length;
      slot3Count = activeTickets.filter(t => t.status === 'PENDING_ASSIGNMENT').length; 
      slot4Count = activeTickets.filter(t => t.status === 'REVISION_REQ').length; 
    }
    else if (isEngineerRole(activeRole)) {
      slot2Count = activeTickets.filter(t => t.status === 'PENDING_ENG_TEAM').length; 
      slot3Count = activeTickets.filter(t => t.status === 'PENDING_REVIEW').length; 
      slot4Count = activeTickets.filter(t => t.status === 'PENDING_FINAL_APPROVAL').length; 
    }
    else if (activeRole === 'DocCtrl') {
      slot2Count = activeTickets.filter(t => t.status === 'PENDING_IFC').length; 
      slot3Count = activeTickets.filter(t => t.status === 'FINAL_DRAFT').length; 
      slot4Count = tickets.filter(t => t.status === 'CLOSED').length; 
    }

    return {
      totalVolume: tickets.length,
      activeQueue: activeTickets.length,
      myActionItems,
      slot2Count,
      slot3Count,
      slot4Count,
      totalActive: activeTickets.length,
      myAssignments: tickets.filter(t => t.assignedDrafterId === uid).length,
      unassigned: activeTickets.filter(t => t.status === 'PENDING_ASSIGNMENT').length,
      urgentAttention: activeTickets.filter(t => t.status === 'REVISION_REQ' || t.requestType === 'RFI').length,
      pendingReview: activeTickets.filter(t => t.status === 'PENDING_REVIEW').length,
      readyForIFC: activeTickets.filter(t => t.status === 'PENDING_IFC').length,
      staleTickets: activeTickets.filter(t => calculateDaysOpen(t.lastModified) > 7).length,
    };
  }, [tickets, activeRole, isActionRequired, uid]);

  const cardLabels = useMemo(() => {
    if (activeRole === 'Drafter') return { slot2: 'My Workload', slot3: 'Revisions Needed', slot4: 'Available to Claim' };
    if (activeRole === 'Requester') return { slot2: 'My Open Requests', slot3: 'Waiting on Review', slot4: 'Completed History' };
    if (activeRole !== null && ['Admin', 'Manager', 'Supervisor', 'DraftingSupervisor'].includes(activeRole)) return { slot2: 'Engineering Review', slot3: 'Unassigned Pool', slot4: 'Revision Status' };
    if (activeRole === 'DocCtrl') return { slot2: 'Ready to Issue', slot3: 'Pending Closure', slot4: 'Total Archives' };
    // DEC-14: the retired initial-review stage's tiles now count the
    // engineering-review queue (management) and final sign-offs (engineers).
    return { slot2: 'Team Queue', slot3: 'Drawing Review', slot4: 'Final Approvals' }; 
  }, [activeRole]);

  // --------------------------------------------------------------------
  // MEMO: FILTERING & SORTING LOGIC
  // --------------------------------------------------------------------
  const filteredTickets = useMemo(() => {
    const currentUid = uid || '';

    return tickets.filter(ticket => {
      // Text Search
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const matches = 
          ticket.ticketId.toLowerCase().includes(q) ||
          ticket.title.toLowerCase().includes(q) ||
          (ticket.requesterName || '').toLowerCase().includes(q) ||
          (ticket.assignedDrafterName || '').toLowerCase().includes(q) ||
          (ticket.unit || '').toLowerCase().includes(q);
        if (!matches) return false;
      }

      // Filters. A narrow status hides everything else, except that "Show
      // Closed" lets closed rows ride alongside the selected status.
      if (filters.status !== 'ALL' && ticket.status !== filters.status && !(showClosed && isTerminalTicketStatus(ticket.status))) return false;
      if (filters.type !== 'ALL' && ticket.requestType !== filters.type) return false;
      
      // Assignment Filter
      if (filters.assignedTo === 'me') {
        const isMyAssignment = ticket.assignedDrafterId === currentUid;
        const isMyRequest = ticket.requesterId === currentUid;
        if (!isMyAssignment && !isMyRequest) return false;
      }
      else if (filters.assignedTo === 'unassigned' && ticket.assignedDrafterId) return false;

      // Date Range
      if (filters.dateRange !== 'all') {
        const days = calculateDaysOpen(ticket.lastModified);
        if (filters.dateRange === 'today' && days > 1) return false;
        if (filters.dateRange === 'week' && days > 7) return false;
        if (filters.dateRange === 'month' && days > 30) return false;
      }

      // Priority
      if (filters.priority === 'urgent') {
        const isUrgent = ticket.status === 'REVISION_REQ' || ticket.requestType === 'RFI' || ticket.priority === 1;
        if (!isUrgent) return false;
      }

      return true;
    }).sort((a, b) => {
      const fieldA = a[sortConfig.field];
      const fieldB = b[sortConfig.field];

      let valA: string | number = fieldA as string | number;
      let valB: string | number = fieldB as string | number;

      if (sortConfig.field === 'lastModified' || sortConfig.field === 'createdAt') {
        valA = toDate(fieldA).getTime();
        valB = toDate(fieldB).getTime();
      }

      if (typeof valA === 'string' && typeof valB === 'string') {
        return sortConfig.direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [tickets, filters, sortConfig, uid, showClosed]);

  // FRIC-9 / UI-6: the needs-me lens over the filtered list — the table and
  // the cards. (The supervisor board is the team's live work by design and
  // keeps the whole filtered list.) Both counts are on screen either way.
  const needsMeTickets = useMemo(() => filteredTickets.filter((t) => isActionRequired(t)), [filteredTickets, isActionRequired]);
  const listTickets = attentionView === 'needs_me' ? needsMeTickets : filteredTickets;
  const pickAttentionView = (v: 'needs_me' | 'all') => { setAttentionView(v); setCurrentPage(1); };

  // --- PAGINATION ---
  const paginatedTickets = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    return listTickets.slice(start, end);
  }, [listTickets, currentPage, itemsPerPage]);

  const totalPages = Math.ceil(listTickets.length / itemsPerPage);

  // HAND-7 done-when 2 (DF-P2's hand-off): a "source moved" chip on a queue
  // row whose source document's register revision has moved since the
  // request was raised — lib/sourceDocRef revDrift through SourceDriftBanner's
  // driftedSources, by version id when the request captured one. One
  // documents read per page of rows (id, rev, current_version_id, in this
  // workspace, read as the viewer — a document they cannot see says nothing),
  // and a failed read says nothing either.
  const [driftByTicket, setDriftByTicket] = useState<Record<string, string[]>>({});
  const pageSourceKey = paginatedTickets
    .map((t) => `${t.id}:${parseSourceDocuments(t.metadata).map((r) => `${r.id}@${r.versionId ?? ''}@${r.rev ?? ''}`).join(',')}`)
    .join('|');
  useEffect(() => {
    let alive = true;
    const refsByTicket = paginatedTickets
      .map((t) => ({ id: t.id ?? '', refs: parseSourceDocuments(t.metadata) }))
      .filter((x) => x.id && x.refs.length > 0);
    const ids = Array.from(new Set(refsByTicket.flatMap((x) => x.refs.map((r) => r.id))));
    void (async () => {
      if (!activeOrgId || ids.length === 0) { if (alive) setDriftByTicket({}); return; }
      const live = new Map<string, { currentVersionId: string | null; rev: string | null }>();
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await supabase
          .from('documents').select('id, rev, current_version_id').eq('org_id', activeOrgId).in('id', ids.slice(i, i + 100));
        if (error) { if (alive) setDriftByTicket({}); return; }
        for (const d of (data ?? []) as Array<{ id: string; rev: string | null; current_version_id: string | null }>) {
          live.set(d.id, { currentVersionId: d.current_version_id ?? null, rev: d.rev ?? null });
        }
      }
      const out: Record<string, string[]> = {};
      for (const x of refsByTicket) {
        const moved = driftedSources(x.refs, live);
        if (moved.length > 0) out[x.id] = moved.map((m) => m.ref.documentNumber || m.ref.title || 'the source document');
      }
      if (alive) setDriftByTicket(out);
    })().catch(() => { if (alive) setDriftByTicket({}); });
    return () => { alive = false; };
    // `pageSourceKey` carries every row and reference the read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, pageSourceKey]);

  /** The row chips the queue shows beside a request's title: the unit when
   *  none is on the record or it is not on the list (FRIC-3 / FRIC-8 readers),
   *  "not announced" (EDGE-8 — the assignment queue was never told about it,
   *  lib/ticketLibrary.ts creationNoticeOwed), and "source moved" (HAND-7). */
  const rowChips = (t: Ticket) => {
    const unit = ticketUnitDisplay(t.unit, t.metadata);
    const moved = t.id ? driftByTicket[t.id] : undefined;
    const notAnnounced = creationNoticeOwed(t.status, t.metadata);
    if (!unit.note && !notAnnounced && !moved) return null;
    return (
      <div className="flex flex-wrap items-center gap-1 mt-1">
        {unit.note && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-800 text-[10px] font-bold" title={`Unit ${unit.text}: ${unit.note}`}>
            Unit {unit.note}
          </span>
        )}
        {notAnnounced && (
          <span data-testid="chip-not-announced" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-red-200 bg-red-50 text-red-700 text-[10px] font-bold" title="The assignment queue was never told about this request (nobody received its creation notice). Assign it from here, or tell the drafting supervisor.">
            <Megaphone className="w-3 h-3" /> Not announced
          </span>
        )}
        {moved && (
          <span data-testid="chip-source-moved" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800 text-[10px] font-bold" title={`The source revision has moved since this request was raised: ${moved.join(', ')}`}>
            <AlertCircle className="w-3 h-3" /> Source moved
          </span>
        )}
      </div>
    );
  };

  // --------------------------------------------------------------------
  // MEMO: SUPERVISOR "BY DRAFTER" BOARD
  // The oversight lens a Drafting Supervisor / Admin was missing: live work
  // grouped by the drafter it's sitting with, plus the unassigned pool up
  // front for triage. Honors the active search + filters so it can be
  // narrowed just like the table.
  // --------------------------------------------------------------------
  interface DrafterBucket {
    id: string | null;
    name: string;
    tickets: Ticket[];
    total: number;
    closed: number;
    drafting: number;
    revision: number;
    awaitingIfc: number;
    review: number;
    actionable: number;
    overdue: number;
    stale: number;
  }
  const teamBoard: DrafterBucket[] = useMemo(() => {
    const UNASSIGNED = '__unassigned__';
    const groups = new Map<string, { id: string | null; name: string; tickets: Ticket[] }>();
    for (const t of filteredTickets) {
      if (isTerminalTicketStatus(t.status) && !includeClosed) continue; // live work by default; included when the user asks for closed
      const key = t.assignedDrafterId || UNASSIGNED;
      if (!groups.has(key)) {
        groups.set(key, {
          id: t.assignedDrafterId || null,
          name: t.assignedDrafterId ? (t.assignedDrafterName || 'Unnamed drafter') : 'Unassigned · Pool',
          tickets: [],
        });
      }
      groups.get(key)!.tickets.push(t);
    }
    const count = (list: Ticket[], pred: (t: Ticket) => boolean) => list.filter(pred).length;
    const buckets: DrafterBucket[] = Array.from(groups.values()).map((g) => ({
      ...g,
      total: g.tickets.length,
      closed: count(g.tickets, (t) => t.status === 'CLOSED'),
      drafting: count(g.tickets, (t) => t.status === 'DRAFTING'),
      revision: count(g.tickets, (t) => t.status === 'REVISION_REQ'),
      awaitingIfc: count(g.tickets, (t) => t.status === 'PENDING_IFC'),
      review: count(g.tickets, (t) => REVIEW_BUCKET_STATUSES.includes(t.status)),
      actionable: count(g.tickets, (t) => isActionRequired(t)),
      // EDGE-7 done-when 3: one rule for overdue (lib/notifications.ts
      // isPastDue) — a CLOSED or CANCELED ticket past its target is not.
      overdue: count(g.tickets, (t) => isPastDue(t)),
      stale: count(g.tickets, (t) => calculateDaysOpen(t.lastModified) > 7),
    }));
    // Pool first (it's the supervisor's triage queue), then heaviest workloads.
    buckets.sort((a, b) => {
      if ((a.id === null) !== (b.id === null)) return a.id === null ? -1 : 1;
      return b.total - a.total;
    });
    // Keep each drafter's column ordered by urgency: action-needed, then most
    // recently touched.
    for (const b of buckets) {
      b.tickets.sort((x, y) => {
        const ax = isActionRequired(x) ? 1 : 0;
        const ay = isActionRequired(y) ? 1 : 0;
        if (ax !== ay) return ay - ax;
        return toDate(y.lastModified).getTime() - toDate(x.lastModified).getTime();
      });
    }
    return buckets;
  }, [filteredTickets, isActionRequired, includeClosed]);

  // --------------------------------------------------------------------
  // HANDLERS: SORT, EXPORT, REFRESH
  // --------------------------------------------------------------------
  
  const handleSort = (field: SortField) => {
    setSortConfig(prev => ({
      field,
      direction: prev.field === field && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const handleExportCSV = () => {
    // ROUTE-12 review fix pass 2: a list that could not be read is never
    // exported as the queue (the buttons are disabled too).
    if (listFault && !listLoaded) return;
    const headers = ['ID', 'Title', 'Unit', 'Status', 'Type', 'Requester', 'Drafter', 'Created', 'Modified'];
    const rows = filteredTickets.map(t => [
      t.ticketId,
      t.title,
      t.unit,
      t.status,
      t.requestType,
      t.requesterName,
      t.assignedDrafterName || 'Unassigned',
      toDate(t.createdAt).toISOString().split('T')[0],
      toDate(t.lastModified).toISOString().split('T')[0]
    ]);

    // PM-15: every cell through lib/csvSafe (quotes, commas, newlines AND a
    // formula-leading title or requester name, written as text).
    const csvContent = [csvLine(headers), ...rows.map(r => csvLine(r))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    // ROUTE-12 review fix pass 2: a list that holds fewer than its scope's
    // requests says so in the file's name ("N of M"), as the banner does.
    // DF-P14 integrator ruling (3), DEC-90: N is what the file holds (the
    // filtered rows written), and no suffix is added when the file cannot be
    // missing a row — every open request was read and the filter shows one
    // open status alone (no closed rows riding along with Show Closed).
    const exportWhole = !!listShort && listShort.openComplete && filters.status !== 'ALL' && !isTerminalTicketStatus(filters.status) && !showClosed;
    const partial = listShort && !exportWhole ? `_partial_${filteredTickets.length}_of_${listShort.total ?? 'uncounted'}` : '';
    link.setAttribute('download', `drafting_export_${new Date().toISOString()}${partial}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ROUTE-12 fix pass: the header's Refresh Data re-reads the list (it only
  // spun before — a dropped realtime channel left the list stale behind a
  // button that seemed to refresh it); the spin ends when the read lands.
  const handleRefresh = () => {
    const refetch = refetchTicketsRef.current;
    if (!refetch) return;
    setRefreshing(true);
    refetch();
  };

  // Run a workflow action through the server-enforced route (state machine +
  // audit + fan-out), instead of writing status directly from the client.
  const callWorkflowAction = useCallback(async (ticketId: string, actionType: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Not authenticated');
    const res = await fetch('/api/tickets/workflow-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ ticketId, actionType }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error((j as { error?: string }).error || `Action failed (HTTP ${res.status})`);
    }
  }, []);

  // PERS-3 / PERS-7 (DF-P9 integrator fix pass, DEC-90 — fail-safe: never act
  // on a request the person cannot see): what a bulk action may touch. A
  // selection outlives the view it was made in — a filter, the Needs-me lens,
  // Show Closed, a refetch or the DELETE companion can move a selected request
  // out of the list on screen. So the selection splits three ways: `inView`
  // (in the list as currently filtered — every page of it — or on the board in
  // the board view), acted on; `outOfView` (still loaded, not in that list),
  // NOT acted on and kept selected, said before and after; `gone` (no longer
  // loaded at all), not acted on, said, and dropped from the selection.
  const viewTicketIds = useMemo(() => {
    const shown = viewMode === 'team' ? teamBoard.flatMap((b) => b.tickets) : listTickets;
    return new Set(shown.map((t) => t.id).filter((id): id is string => !!id));
  }, [viewMode, teamBoard, listTickets]);
  const selection = useMemo(() => {
    const loaded = new Set(tickets.map((t) => t.id).filter((id): id is string => !!id));
    const inView = tickets.filter((t) => !!t.id && selectedTicketIds.has(t.id) && viewTicketIds.has(t.id));
    const outOfView: string[] = [];
    const gone: string[] = [];
    for (const id of selectedTicketIds) {
      if (!loaded.has(id)) gone.push(id);
      else if (!viewTicketIds.has(id)) outOfView.push(id);
    }
    return { inView, outOfView, gone };
  }, [tickets, selectedTicketIds, viewTicketIds]);

  const handleBulkArchive = useCallback(async () => {
    if (selectedTicketIds.size === 0) return;
    // PERS-7 (DF-P9): no signed-in member, no action — never an 'unknown'
    // stand-in on the audit row.
    if (!uid || !activeOrgId) { await appAlert({ message: "You're not signed in to a workspace, so nothing was archived.", tone: 'danger' }); return; }
    const { inView, outOfView, gone } = selection;
    if (inView.length === 0) {
      await appAlert({ message: `Nothing was archived. ${untouchedNote(outOfView.length, gone.length, 'archived').join(' ')}`, tone: 'danger' });
      setSelectedTicketIds(new Set(outOfView));
      return;
    }
    const ids = inView.map((t) => t.id as string);
    const untouched = untouchedNote(outOfView.length, gone.length, 'archived', 'before');
    if (!(await appConfirm({ message: `Are you sure you want to archive ${ids.length} tickets?${untouched.length > 0 ? ` ${untouched.join(' ')}` : ''}`, tone: 'danger' }))) return;

    setProcessingBulk(true);
    try {
      // Per-ticket through the enforced route: state-machine validation,
      // server audit, and fan-out — a non-management caller gets a 403.
      await Promise.all(ids.map(id => callWorkflowAction(id, 'close_ticket')));

      const audit = await logAuditAction({
        action: 'TICKET_BULK_ARCHIVE', resourceId: 'bulk', resourceType: 'ticket',
        orgId: activeOrgId, userId: uid, userRole: activeRole ?? undefined,
        details: { count: ids.length, ticketIds: ids }
      });
      // PERS-7: the closes landed (each with the route's own audit row); a
      // refused bulk summary row is said, never passed over.
      if (!audit.ok) await appAlert({ message: `The tickets were archived, but the bulk record of it could not be written: ${audit.error}`, tone: 'danger' });

      // What was not in view stays selected (said in the confirm above).
      setSelectedTicketIds(new Set(outOfView));
    } catch (error) {
      console.error("Bulk Archive Failed:", error);
      await appAlert({ message: "Failed to process bulk archive.", tone: 'danger' });
    } finally {
      setProcessingBulk(false);
    }
  }, [selectedTicketIds, selection, activeOrgId, activeRole, uid, callWorkflowAction]);

  // "Urgent" is a PRIORITY, not a workflow state. This used to set
  // status=REVISION_REQ, which hijacked the revision stage as an urgency flag
  // and corrupted the ticket's real position in the workflow.
  //
  // PERS-3 / LEAK-4 / PERS-7 (DF-P9): priority stays a member's own write
  // (one of the four columns a client keeps — 20261208's ticket_update_guard),
  // but it can no longer fail silently or race the workflow route: the write
  // compare-and-sets on the ticket's last_modified as this list read it (a
  // null token is its own leg, as the route's — EDGE-15), returns the row it
  // matched, and a refusal or a lost race is SAID. The audit row follows only
  // a confirmed write, names the signed-in member (no 'unknown' stand-in),
  // and a refused audit row is said too.
  //
  // Fix pass: a compare-and-set that misses does not lean on the realtime
  // refresh (it may never come). It re-reads the row: already urgent is done
  // (nothing written, so no audit row of ours); otherwise it retries ONCE on
  // the row's fresh last_modified. `stale` asks the caller to re-read the
  // list, so the next attempt starts from what the database holds.
  type UrgentResult = { err: string | null; wrote: boolean; stale: boolean };
  const markUrgentChecked = useCallback(async (t: Ticket): Promise<UrgentResult> => {
    if (!activeOrgId || !t.id) return { err: 'no active workspace', wrote: false, stale: false };
    const id = t.id;
    const casWrite = async (token: unknown) => {
      let q = supabase.from('tickets').update({ priority: 1, last_modified: new Date().toISOString() }).eq('id', id).eq('org_id', activeOrgId);
      q = token ? q.eq('last_modified', String(token)) : q.is('last_modified', null);
      const { data: hit, error } = await q.select('id');
      return { landed: !!hit && hit.length > 0, error };
    };
    const first = await casWrite(t.lastModified);
    if (first.error) return { err: first.error.message || 'the write was refused', wrote: false, stale: false };
    if (first.landed) return { err: null, wrote: true, stale: false };
    const { data: fresh, error: readErr } = await supabase.from('tickets')
      .select('id, last_modified, priority').eq('id', id).eq('org_id', activeOrgId).maybeSingle();
    if (readErr) return { err: `it changed since the list was read, and it could not be re-read: ${readErr.message || 'the read was refused'}`, wrote: false, stale: true };
    if (!fresh) return { err: 'it is no longer in this workspace (deleted, or no longer visible to you)', wrote: false, stale: true };
    const row = fresh as { last_modified?: string | null; priority?: number | null };
    if (row.priority === 1) return { err: null, wrote: false, stale: true };
    const second = await casWrite(row.last_modified ?? null);
    if (second.error) return { err: second.error.message || 'the write was refused', wrote: false, stale: true };
    if (second.landed) return { err: null, wrote: true, stale: true };
    return { err: 'it is being changed by someone else right now — try again in a moment', wrote: false, stale: true };
  }, [activeOrgId]);

  const handleBulkUrgencyToggle = useCallback(async () => {
    if (selectedTicketIds.size === 0) return;
    if (!uid || !activeOrgId) { await appAlert({ message: "You're not signed in to a workspace, so nothing was marked urgent.", tone: 'danger' }); return; }
    setProcessingBulk(true);
    try {
      // Fail-safe (DEC-90): only the selected requests in the list on screen
      // are written; the rest are said, never dropped in silence (`selection`).
      const { inView: chosen, outOfView, gone } = selection;
      const results = await Promise.all(chosen.map(async (t) => ({ id: t.id as string, ...(await markUrgentChecked(t)) })));
      // Only the rows THIS write changed are recorded; one already urgent is done, not ours.
      const done = results.filter((r) => !r.err && r.wrote).map((r) => r.id);
      const failed = results.filter((r) => r.err);
      if (results.some((r) => r.stale)) refetchTicketsRef.current?.();
      const problems: string[] = [];
      if (failed.length > 0) problems.push(`${failed.length} of ${chosen.length} were not marked urgent: ${failed[0].err}.`);
      problems.push(...untouchedNote(outOfView.length, gone.length, 'marked urgent'));
      if (done.length > 0) {
        const audit = await logAuditAction({
          action: 'TICKET_BULK_URGENT', resourceId: 'bulk', resourceType: 'ticket',
          orgId: activeOrgId, userId: uid, userRole: activeRole ?? undefined,
          details: { count: done.length, ticketIds: done }
        });
        if (!audit.ok) problems.push(`${done.length} were marked urgent, but the record of it could not be written: ${audit.error}`);
      }
      // Only what failed, and what was not in view, stays selected — so a
      // retry touches nothing twice and nothing unseen is lost from the pick.
      setSelectedTicketIds(new Set([...failed.map((r) => r.id), ...outOfView]));
      if (problems.length > 0) await appAlert({ message: problems.join(' '), tone: 'danger' });
    } catch (error) {
      console.error("Bulk Update Failed:", error);
      await appAlert({ message: "Failed to mark the selection urgent.", tone: 'danger' });
    } finally {
      setProcessingBulk(false);
    }
  }, [selectedTicketIds, selection, markUrgentChecked, activeOrgId, activeRole, uid]);

  const handleQuickMarkUrgent = async (ticketId: string) => {
    if (!uid || !activeOrgId) { await appAlert({ message: "You're not signed in to a workspace, so it was not marked urgent.", tone: 'danger' }); return; }
    const t = tickets.find((x) => x.id === ticketId);
    if (!t) return;
    try {
      const { err, wrote, stale } = await markUrgentChecked(t);
      if (stale) refetchTicketsRef.current?.();
      if (err) { await appAlert({ message: `Not marked urgent: ${err}.`, tone: 'danger' }); return; }
      if (!wrote) { setOpenRowMenu(null); return; } // already urgent — nothing written, nothing to record
      const audit = await logAuditAction({
        action: 'TICKET_MARK_URGENT', resourceId: ticketId, resourceType: 'ticket',
        orgId: activeOrgId, userId: uid, userRole: activeRole ?? undefined,
        details: { priority: 1 }
      });
      setOpenRowMenu(null);
      if (!audit.ok) await appAlert({ message: `Marked urgent, but the record of it could not be written: ${audit.error}`, tone: 'danger' });
    } catch (error) {
      console.error("Mark urgent failed:", error);
      await appAlert({ message: "Failed to mark urgent.", tone: 'danger' });
    }
  };

  const handleQuickForceClose = async (ticketId: string) => {
    const ok = await appConfirm({
      title: "Force close this request?",
      message: "This ends the request immediately, past its normal workflow. The requester and drafter are not asked. You can reopen it later from the closed list.",
      tone: "danger",
      confirmLabel: "Force close",
    });
    if (!ok) return;
    try {
      await callWorkflowAction(ticketId, 'close_ticket');
      setOpenRowMenu(null);
    } catch (error) {
      console.error("Quick close failed:", error);
      await appAlert({ message: error instanceof Error ? error.message : "Failed to close.", tone: 'danger' });
    }
  };

  const toggleTicketSelection = (id: string) => {
    const newSet = new Set(selectedTicketIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedTicketIds(newSet);
  };

  const handleSelectAll = () => {
    if (selectedTicketIds.size === paginatedTickets.length) {
      setSelectedTicketIds(new Set());
    } else {
      setSelectedTicketIds(new Set(paginatedTickets.map(t => t.id!)));
    }
  };

  const clearAllFilters = () => {
    setFilters({ status: 'ALL', type: 'ALL', dateRange: 'all', assignedTo: 'all', priority: 'all', search: '' });
    setCurrentPage(1);
  };

  // AUTHZ-15 (DF-P9 integrator fix pass, DEC-90): the Action Required count
  // the page can state. During a policy fault it is UNKNOWN (null), never 0 —
  // isActionRequired answers false for every row then, which is "not worked
  // out", not "nothing needs you". The tile says so with the reason; the
  // banner, which only states a computed count, stays away.
  const actionItems: number | null = policyFault ? null : metrics.myActionItems;
  const actionItemCount = actionItems ?? 0;
  const hasActionItems = actionItems !== null && actionItems > 0;

  if (loading && tickets.length === 0) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center">
        <Spinner size="lg" className="mb-4" />
        <h2 className="text-xl font-bold text-[var(--color-text)]">Loading Drafting Request Portal...</h2>
        <p className="text-[var(--color-text-muted)]">Synchronizing workflow states...</p>
        {error && <p className="text-red-500 text-sm font-bold mt-4 bg-red-50 px-4 py-2 rounded border border-red-200">{error}</p>}
      </div>
    );
  }

  if (!activeOrgId) {
    return (
      <div className="p-8">
        <div className="max-w-3xl mx-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow">
              <Layers className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-black text-[var(--color-text)]">Workspace not selected</h2>
              <p className="text-sm text-[var(--color-text-muted)] mt-2">
                Please select a workspace from the sidebar to view active workflows and tickets.
              </p>
              <p className="text-xs text-[var(--color-text-muted)] mt-3">
                Tickets are isolated by organization to ensure data privacy.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ROUTE-12 (DF-P14): the list could not be read and no read of THIS scope
  // succeeded — say so in place of the list, with Try again, and show no
  // count or list derived from rows (an empty queue would read as "nothing to
  // do"; the rows held may be another scope's). Fix pass: the page shell —
  // the header, the filter bar, the status filter, Show Closed, the view
  // switcher — stays, so a failure confined to one scope (the default "Any
  // status" whole-history read timing out, say) never locks the user out of a
  // narrower scope that would still load: choosing an open status reads only
  // open requests.
  const listUnread = !!listFault && !listLoaded;

  return (
    <div className="pb-20">

      {showWorkflowMap && <WorkflowDiagramModal onClose={() => setShowWorkflowMap(false)} />}

      {/* 1. TOP METRICS DASHBOARD */}
      {/* Wide canvas (matches the ticket page + libraries) — this portal was
          born at 1920px; a narrower wrap strands it in dead margins. */}
      <div className="bg-[var(--color-surface)] border-b border-[var(--color-border)] sticky top-0 z-20 shadow-sm">
        <div className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
            <div>
              <h1 className="text-2xl font-black text-[var(--color-text)] tracking-tight flex items-center">
                <Layers className="w-6 h-6 mr-3 text-[var(--color-accent)]" />
                Drafting Request Portal
              </h1>
              <p className="text-sm text-[var(--color-text-muted)] mt-1">
                {activeRole} Console • {listUnread ? 'Total records unknown — the list could not be read' : `${metrics.totalVolume} Total Records`}
              </p>
            </div>
            
            <div className="flex items-center space-x-3">
              <button onClick={handleRefresh} className={`p-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-orange-600 transition-all ${refreshing ? 'animate-spin' : ''}`} title="Refresh Data">
                <RefreshCw className="w-5 h-5" />
              </button>
              <button
                onClick={handleExportCSV}
                disabled={listUnread}
                title={listUnread ? 'The request list could not be read — there is nothing to export' : undefined}
                data-testid="requests-export-csv"
                className="flex items-center px-4 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" />
                Export CSV
              </button>
              {/* UI-2: the workflow map, from the queue — a labelled button, not a hover hint. */}
              <button
                type="button"
                onClick={() => setShowWorkflowMap(true)}
                className="flex items-center px-4 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] transition-all"
              >
                <GitBranch className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" />
                How requests flow
              </button>
              <Link href="/requests/new">
                <button className="flex items-center px-5 py-2 bg-orange-600 text-white rounded-lg text-sm font-bold shadow-lg shadow-orange-600/20 hover:bg-orange-700 hover:scale-105 transition-all">
                  <Plus className="w-5 h-5 mr-2" />
                  New Request
                </button>
              </Link>
            </div>
          </div>

          {/* ROUTE-12 fix pass: no tile counts rows that could not be read. */}
          {!listUnread && (
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
            
            {/* SLOT 1: MY ACTION ITEMS — AUTHZ-15: during a policy fault the
                count is unknown and says why (the Needs-me toggle's "—"), never 0. */}
            <div 
              data-testid="tile-action-required"
              className={`border p-3 rounded-xl flex flex-col justify-between cursor-pointer transition-colors group relative overflow-hidden ${hasActionItems ? 'bg-orange-50 border-orange-300 ring-2 ring-orange-500/20' : 'bg-[var(--color-surface-2)] border-[var(--color-border)]'}`}
              onClick={() => { setFilters({ ...filters, status: 'ALL' }); pickAttentionView('needs_me'); }}
              title={actionItems === null ? `Unknown — permissions could not be read: ${policyFault}` : undefined}
            >
              <div className="flex justify-between items-start z-10">
                <span className={`text-[10px] font-bold uppercase ${hasActionItems ? 'text-orange-600' : 'text-[var(--color-text-faint)]'}`}>Action Required</span>
                <Zap className={`w-4 h-4 ${hasActionItems ? 'text-orange-500 fill-orange-500 animate-pulse' : 'text-slate-300'}`} />
              </div>
              <div className="flex items-end justify-between mt-1 z-10">
                {actionItems === null ? (
                  <div className="flex flex-col">
                    <div data-testid="tile-action-required-count" className="text-2xl font-black text-[var(--color-text-muted)]">—</div>
                    <div data-testid="tile-action-required-unknown" className="text-[10px] font-bold text-amber-700">Unknown — permissions could not be read</div>
                  </div>
                ) : (
                  <div data-testid="tile-action-required-count" className={`text-2xl font-black ${hasActionItems ? 'text-orange-700' : 'text-[var(--color-text)]'}`}>{actionItems}</div>
                )}
              </div>
            </div>

            {/* SLOT 2: DYNAMIC CONTEXT */}
            <div className="bg-blue-50/50 border border-blue-100 p-3 rounded-xl flex flex-col justify-between cursor-pointer hover:border-blue-300 transition-colors group">
              <div className="flex justify-between items-start">
                <span className="text-[10px] font-bold text-blue-400 uppercase">{cardLabels.slot2}</span>
                <Inbox className="w-4 h-4 text-blue-300 group-hover:text-blue-500" />
              </div>
              <div className="text-2xl font-black text-blue-700 mt-1">{metrics.slot2Count}</div>
            </div>

            {/* SLOT 3: DYNAMIC CONTEXT */}
            <div className="bg-purple-50/50 border border-purple-100 p-3 rounded-xl flex flex-col justify-between cursor-pointer hover:border-purple-300 transition-colors group">
              <div className="flex justify-between items-start">
                <span className="text-[10px] font-bold text-purple-400 uppercase">{cardLabels.slot3}</span>
                <User className="w-4 h-4 text-purple-300 group-hover:text-purple-500" />
              </div>
              <div className="text-2xl font-black text-purple-700 mt-1">{metrics.slot3Count}</div>
            </div>

            {/* SLOT 4: DYNAMIC CONTEXT */}
            <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] p-3 rounded-xl flex flex-col justify-between cursor-pointer hover:border-blue-300 transition-colors group">
              <div className="flex justify-between items-start"><span className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase">{cardLabels.slot4}</span><Briefcase className="w-4 h-4 text-slate-300 group-hover:text-blue-500" /></div>
              <div className="text-2xl font-black text-[var(--color-text)] mt-1">{metrics.slot4Count}</div>
            </div>

            {/* SLOT 5: IFC READY */}
            <div className="bg-teal-50/50 border border-teal-100 p-3 rounded-xl flex flex-col justify-between cursor-pointer hover:border-teal-300 transition-colors group" onClick={() => setFilters({ ...filters, status: 'PENDING_IFC' })}>
              <div className="flex justify-between items-start"><span className="text-[10px] font-bold text-teal-400 uppercase">IFC Ready</span><CheckCircle2 className="w-4 h-4 text-teal-300 group-hover:text-teal-500" /></div>
              <div className="text-2xl font-black text-teal-700 mt-1">{metrics.readyForIFC}</div>
            </div>

            {/* SLOT 6: STALE / ALERT */}
            <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] p-3 rounded-xl flex flex-col justify-between cursor-default">
              <div className="flex justify-between items-start">
                <span className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase">Stale (&gt; 7 Days)</span>
                <Clock className="w-4 h-4 text-slate-300" />
              </div>
              <div className="text-2xl font-black text-[var(--color-text-muted)] mt-1">{metrics.staleTickets}</div>
            </div>
          </div>
          )}
        </div>
      </div>

      {/* 2. ADVANCED FILTER BAR */}
      <div className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        
        {/* URGENT ACTION BANNER — only for a count the page computed (AUTHZ-15:
            during a policy fault the notice below says why it is unknown). */}
        {hasActionItems && !listUnread && (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 shadow-sm flex items-center justify-between text-orange-900 animate-in slide-in-from-top-4 mb-6">
            <div className="flex items-center space-x-4">
              <div className="p-2 bg-orange-100 rounded-lg">
                <AlertCircle className="w-6 h-6 text-orange-600 animate-pulse" />
              </div>
              <div>
                <h3 className="text-sm font-black tracking-tight uppercase text-orange-700">Action Required</h3>
                <p className="text-sm font-medium text-orange-800">
                  You have <span className="font-bold underline">{actionItemCount} ticket{actionItemCount > 1 ? 's' : ''}</span> waiting for your review or approval.
                </p>
              </div>
            </div>
            <button 
              onClick={() => { setFilters({ ...filters, status: 'ALL' }); pickAttentionView('needs_me'); }}
              className="px-5 py-2 bg-[var(--color-surface)] border border-orange-200 text-orange-700 text-xs font-bold rounded-lg hover:bg-orange-100 transition-colors shadow-sm"
            >
              View My Tasks
            </button>
          </div>
        )}

        {/* AUTHZ-15: the policy could not be read — what it decides is held back, said, retryable. */}
        {policyFault && (
          <div role="alert" data-testid="requests-policy-fault" className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex items-start gap-3 text-amber-900">
            <ShieldAlert className="w-5 h-5 mt-0.5 shrink-0 text-amber-600" />
            <div className="text-sm flex-1">
              <span className="font-bold">Permissions could not be read</span> — {policyFault}. They decide which requests need you and who may archive or force close, so the Action Required and Needs me counts are unknown, and Archive and Force Close are held back, until they can be read.
            </div>
            <button type="button" onClick={() => setPolicyAttempt((n) => n + 1)} className="px-3 py-1.5 bg-[var(--color-surface)] border border-amber-300 rounded-lg text-xs font-bold text-amber-800 hover:bg-amber-100">Try again</button>
          </div>
        )}

        {/* ROUTE-12 (DF-P14): a refresh that failed keeps the list as last read, said. */}
        {listFault && listLoaded && (
          <div role="alert" data-testid="requests-read-failed" className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 text-red-900">
            <AlertCircle className="w-5 h-5 mt-0.5 shrink-0 text-red-600" />
            <div className="text-sm flex-1">
              <span className="font-bold">The request list could not be refreshed</span> — {listFault}. What is shown is the list as last read{listReadAt ? ` at ${new Date(listReadAt).toLocaleTimeString()}` : ''}, and may be out of date.
            </div>
            <button type="button" onClick={() => refetchTicketsRef.current?.()} className="px-3 py-1.5 bg-[var(--color-surface)] border border-red-300 rounded-lg text-xs font-bold text-red-800 hover:bg-red-100">Try again</button>
          </div>
        )}
        {/* ROUTE-12 (DF-P14): a read that ended short of its count says N of M. */}
        {listShort && !listFault && (
          <div role="status" data-testid="requests-read-short" className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex items-start gap-3 text-amber-900">
            <AlertCircle className="w-5 h-5 mt-0.5 shrink-0 text-amber-600" />
            <div className="text-sm flex-1">
              {listShort.capped && listShort.openComplete
                ? <>Every open request in this view is listed, with the {listShort.closedShown} most recently active closed or canceled ones{listShort.total !== null ? <> — {listShort.total} requests in all</> : null}, more than one list holds. Older closed and canceled requests are not listed here (choosing Closed or Canceled reads the same most recent ones); the open counts above are whole, the closed ones count only those listed. <button type="button" data-testid="closed-history-from-banner" onClick={() => setHistoryOpen(true)} className="font-bold underline">Open Closed history</button> to find any of them.</>
                : listShort.capped && listShort.merged
                  ? <>This list shows the {listShort.shown} most recent requests in this view — the list is longer than one read, open requests included. Choose an open status to narrow it and see the rest; the counts above are of the {listShort.shown} shown.</>
                  : listShort.capped
                    ? <>This list shows the {listShort.shown} most recently active of {listShort.total !== null ? `the ${listShort.total}` : 'the'} requests in this view — more than one list holds, open requests included. Choose an open status to narrow it and see the rest; the counts above are of the {listShort.shown} shown.</>
                    : listShort.merged
                      ? <>This list shows the {listShort.shown} requests that could be read — the list may be longer than what was read (requests changed while it was being read, or the total could not be counted). Refresh to read it again.</>
                      : listShort.total !== null
                        ? <>This list shows {listShort.shown} of the {listShort.total} requests in this view — requests changed while it was being read. Refresh to read it again.</>
                        : <>This list shows the {listShort.shown} requests that could be read, but the total could not be counted, so more may exist. Refresh to read it again.</>}
            </div>
            <button type="button" onClick={() => refetchTicketsRef.current?.()} className="px-3 py-1.5 bg-[var(--color-surface)] border border-amber-300 rounded-lg text-xs font-bold text-amber-800 hover:bg-amber-100">Refresh list</button>
          </div>
        )}

        {/* BULK ACTIONS HEADER */}
        {selectedTicketIds.size > 0 && !listUnread && (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-center justify-between animate-in fade-in slide-in-from-top-2">
            <div className="flex items-center space-x-3">
              <span className="bg-orange-600 text-white text-xs font-bold px-2 py-1 rounded-md">{selectedTicketIds.size} Selected</span>
              {selection.outOfView.length + selection.gone.length > 0 ? (
                // Fail-safe (DEC-90), said BEFORE the action: Mark Urgent and Archive
                // touch only what is on screen (Export writes the filtered list, as before).
                <span data-testid="bulk-out-of-view" className="text-sm font-medium text-orange-900">
                  {selection.outOfView.length + selection.gone.length} of them {selection.outOfView.length + selection.gone.length === 1 ? 'is' : 'are'} not in the list on screen — {policyFault ? 'Mark Urgent acts' : 'Mark Urgent and Archive act'} only on the {selection.inView.length} that {selection.inView.length === 1 ? 'is' : 'are'}
                </span>
              ) : (
                <span className="text-sm font-medium text-orange-900">Bulk actions active</span>
              )}
            </div>
            <div className="flex items-center space-x-2">
              <button onClick={handleExportCSV} disabled={listUnread} className="flex items-center px-3 py-1.5 bg-[var(--color-surface)] border border-orange-300 text-orange-700 rounded-lg text-sm font-bold hover:bg-orange-100"><Download className="w-4 h-4 mr-2" /> Export</button>
              <button onClick={handleBulkUrgencyToggle} className="flex items-center px-3 py-1.5 bg-[var(--color-surface)] border border-orange-300 text-orange-700 rounded-lg text-sm font-bold hover:bg-orange-100" disabled={processingBulk}><Zap className="w-4 h-4 mr-2" /> Mark Urgent</button>
              {!policyFault && <button onClick={handleBulkArchive} className="flex items-center px-3 py-1.5 bg-[var(--color-surface)] border border-orange-300 text-orange-700 rounded-lg text-sm font-bold hover:bg-orange-100" disabled={processingBulk}><Archive className="w-4 h-4 mr-2" /> Archive</button>}
              <button onClick={() => setSelectedTicketIds(new Set())} className="p-1.5 text-orange-600 hover:text-orange-800"><X className="w-5 h-5" /></button>
            </div>
          </div>
        )}

        {/* MAIN FILTER ROW */}
        <div className="flex flex-col xl:flex-row gap-4">
          <div className="relative flex-1 min-w-0 xl:min-w-[300px]">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-text-faint)]" />
            <input type="text" placeholder="Search by ID, Requester, Drafter, or Keywords..." value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} className="w-full pl-12 pr-4 py-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-xl text-sm font-medium focus:ring-2 focus:ring-orange-500 focus:border-orange-500 shadow-sm transition-all" />
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <div className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg p-1 flex shadow-sm mr-2">
              {isSupervisorView && (
                <button onClick={() => pickView('team')} title="By Drafter — supervisor board" className={`p-2 rounded-md transition-all ${viewMode === 'team' ? 'bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-inner' : 'text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'}`}><Users className="w-5 h-5" /></button>
              )}
              <button onClick={() => pickView('table')} title="Table" className={`p-2 rounded-md transition-all ${viewMode === 'table' ? 'bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-inner' : 'text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'}`}><ListIcon className="w-5 h-5" /></button>
              <button onClick={() => pickView('grid')} title="Cards" className={`p-2 rounded-md transition-all ${viewMode === 'grid' ? 'bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-inner' : 'text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'}`}><LayoutGrid className="w-5 h-5" /></button>
            </div>
            {viewMode !== 'team' && (
              <div role="group" aria-label="Which requests to list" className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg p-1 flex shadow-sm">
                <button
                  type="button"
                  data-testid="view-needs-me"
                  aria-pressed={attentionView === 'needs_me'}
                  onClick={() => pickAttentionView('needs_me')}
                  className={`px-3 py-1.5 rounded-md text-sm font-bold transition-all ${attentionView === 'needs_me' ? 'bg-orange-100 text-orange-800' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
                >
                  Needs me <span className="ml-1 font-black">{policyFault || listUnread ? '—' : needsMeTickets.length}</span>
                </button>
                <button
                  type="button"
                  data-testid="view-all"
                  aria-pressed={attentionView === 'all'}
                  onClick={() => pickAttentionView('all')}
                  className={`px-3 py-1.5 rounded-md text-sm font-bold transition-all ${attentionView === 'all' ? 'bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-inner' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
                >
                  All <span className="ml-1 font-black">{listUnread ? '—' : filteredTickets.length}</span>
                </button>
              </div>
            )}
            <Select value={filters.assignedTo} onChange={(e) => setFilters({ ...filters, assignedTo: e.target.value as FilterConfig['assignedTo'] })} className="w-44"><option value="all">Assignee: All</option><option value="me">My Tickets</option><option value="unassigned">Unassigned Only</option></Select>
            <Select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as FilterConfig['status'] })} className="w-44"><option value="ALL">Status: Any</option>{TICKET_STATUS_FILTER_ORDER.map((st) => <option key={st} value={st}>{ticketStatusLabel(st)}</option>)}</Select>
            <button onClick={() => setIsFilterPanelOpen(!isFilterPanelOpen)} className={`flex items-center px-4 py-3 rounded-xl text-sm font-bold border transition-all ${isFilterPanelOpen ? 'bg-slate-800 text-white border-slate-800' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]'}`}><SlidersHorizontal className="w-4 h-4 mr-2" />More Filters</button>
            <button
              onClick={() => setShowClosed((v) => !v)}
              className={`flex items-center px-4 py-3 rounded-xl text-sm font-bold border transition-all ${showClosed ? 'bg-slate-900 text-white border-slate-900' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]'}`}
              title="Toggle whether closed tickets are included in the list. Use to find a past request you need to reopen or pull old drafts from."
            >
              {showClosed ? 'Hide Closed' : 'Show Closed'}
            </button>
            <button
              type="button"
              data-testid="closed-history-toggle"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((v) => !v)}
              className={`flex items-center px-4 py-3 rounded-xl text-sm font-bold border transition-all ${historyOpen ? 'bg-slate-900 text-white border-slate-900' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]'}`}
              title="Find any closed or canceled request, as far back as the history goes — read only when you open it."
            >
              <Archive className="w-4 h-4 mr-2" />Closed history
            </button>
          </div>
        </div>

        {/* EXPANDABLE FILTER PANEL */}
        {isFilterPanelOpen && (
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 shadow-xl animate-in fade-in slide-in-from-top-4 grid grid-cols-1 md:grid-cols-4 gap-6">
             <div>
               <label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase mb-2">Request Type</label>
               <div className="flex flex-wrap gap-2">
                 <button 
                   onClick={() => setFilters({...filters, type: 'ALL'})} 
                   className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filters.type === 'ALL' ? 'bg-orange-100 text-orange-800 border-orange-200' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}
                 >
                   ALL
                 </button>
                 {requestTypeOptions.length > 0 ? requestTypeOptions.map(opt => (
                   <button 
                     key={String(opt.value)} 
                     onClick={() => setFilters({...filters, type: String(opt.value)})} 
                     className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filters.type === String(opt.value) ? 'bg-orange-100 text-orange-800 border-orange-200' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}
                   >
                     {opt.label}
                   </button>
                 )) : (
                   // Fallback defaults if config not loaded
                   ['RFI', 'INSPECTION', 'ISO', 'MOC', 'ASBUILT'].map(type => (
                     <button key={type} onClick={() => setFilters({...filters, type})} className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filters.type === type ? 'bg-orange-100 text-orange-800 border-orange-200' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}>{type}</button>
                   ))
                 )}
               </div>
             </div>
             <div><label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase mb-2">Timeframe</label><div className="flex flex-wrap gap-2">{['all', 'today', 'week', 'month'].map(range => (<button key={range} onClick={() => setFilters({...filters, dateRange: range as FilterConfig['dateRange']})} className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filters.dateRange === range ? 'bg-blue-100 text-blue-800 border-blue-200' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}>{range.charAt(0).toUpperCase() + range.slice(1)}</button>))}</div></div>
             <div><label className="block text-xs font-bold text-[var(--color-text-muted)] uppercase mb-2">Urgency</label><div className="flex items-center space-x-2 bg-[var(--color-surface-2)] p-2 rounded-lg border border-[var(--color-border)]"><input type="checkbox" id="urgentOnly" checked={filters.priority === 'urgent'} onChange={(e) => setFilters({...filters, priority: e.target.checked ? 'urgent' : 'all'})} className="w-4 h-4 text-orange-600 border-[var(--color-border-strong)] rounded focus:ring-orange-500" /><label htmlFor="urgentOnly" className="text-sm font-medium text-[var(--color-text)] cursor-pointer">Show Critical / RFI Only</label></div></div>
             <div className="flex items-end justify-end"><button onClick={clearAllFilters} className="flex items-center text-sm text-red-600 hover:text-red-800 font-bold hover:underline decoration-red-200 hover:decoration-red-800 transition-all"><FilterX className="w-4 h-4 mr-2" />Reset All Filters</button></div>
          </div>
        )}
      </div>

      {/* 3. CONTENT AREA */}
      <div className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8">

        {/* ROUTE-13 done-when 1 (DF-P16): the closed history, on demand. */}
        {historyOpen && activeOrgId && uid && (
          <ClosedHistory key={`${activeOrgId}|${uid}|${roles.join(',')}`} orgId={activeOrgId} uid={uid} roles={roles} onClose={() => setHistoryOpen(false)} />
        )}

        {listUnread ? (
          /* ROUTE-12 (DF-P14): the list could not be read — said in its place. */
          <div role="alert" data-testid="requests-read-failed" className="bg-red-50 border border-red-200 rounded-2xl p-6 shadow-sm text-red-900">
            <div className="flex items-start gap-4">
              <AlertCircle className="h-6 w-6 shrink-0 text-red-600" />
              <div className="flex-1">
                <h2 className="text-lg font-black">The request list could not be read</h2>
                <p className="text-sm mt-2">{listFault}. Nothing is shown rather than a list that may be missing requests — no count or list here would be your queue.</p>
                {includeClosed && (
                  <p data-testid="requests-read-failed-narrow" className="text-sm mt-2">This view reads closed requests too{showClosed ? ' (Show Closed is on)' : ''}. To read a narrower list, {showClosed ? 'turn Show Closed off and ' : ''}choose an open status above — it reads only open requests.</p>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => refetchTicketsRef.current?.()} className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-bold hover:bg-slate-800">Try again</button>
                  <Link href="/requests/new" className="text-sm font-bold text-red-800 hover:underline">New Request</Link>
                </div>
              </div>
            </div>
          </div>
        ) : viewMode === 'team' ? (
          /* VIEW: BY-DRAFTER SUPERVISOR BOARD */
          teamBoard.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-32 bg-[var(--color-surface)] rounded-2xl border border-dashed border-[var(--color-border-strong)] text-center">
              <div className="w-20 h-20 bg-[var(--color-surface-2)] rounded-full flex items-center justify-center mb-6"><Users className="w-10 h-10 text-slate-300" /></div>
              <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">No active work in the queue</h3>
              <p className="text-[var(--color-text-muted)] max-w-md mx-auto mb-6">Nothing is currently assigned or waiting. New requests will appear here grouped by the drafter handling them.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 items-start">
              {teamBoard.map((b) => {
                const isPool = b.id === null;
                // Pool column wears the portal's own orange (triage =
                // attention), not an off-brand purple.
                return (
                  <section key={b.id || 'pool'} className={`rounded-2xl border shadow-sm flex flex-col overflow-hidden ${isPool ? 'border-orange-300 bg-orange-50/30' : 'border-[var(--color-border)] bg-[var(--color-surface)]'}`}>
                    <header className={`px-4 py-3 border-b ${isPool ? 'border-orange-200 bg-orange-50/60' : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {isPool ? (
                            <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-xs font-black bg-purple-600 text-white">
                              <Inbox className="w-4 h-4" />
                            </div>
                          ) : (
                            <UserAvatar uid={b.id} name={b.name} size={36} rounded="full" />
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-black text-[var(--color-text)] truncate">{b.name}</div>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]">{b.total - b.closed} active{b.closed > 0 ? ` · ${b.closed} closed` : ''}{b.actionable > 0 ? ` · ${b.actionable} need action` : ''}</div>
                          </div>
                        </div>
                        {b.actionable > 0 && (
                          <span className="shrink-0 inline-flex items-center gap-1 bg-red-100 text-red-700 text-[10px] font-black px-2 py-0.5 rounded-full border border-red-200"><AlertCircle className="w-3 h-3" />{b.actionable}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {b.drafting > 0 && <StageChip lane="drafting" className="bg-blue-50 text-blue-700 border-blue-200" label={ticketStatusLabel('DRAFTING')} n={b.drafting} />}
                        {b.revision > 0 && <StageChip lane="revision" className="bg-amber-50 text-amber-700 border-amber-200" label={ticketStatusLabel('REVISION_REQ')} n={b.revision} />}
                        {b.awaitingIfc > 0 && <StageChip lane="ifc" className="bg-teal-50 text-teal-700 border-teal-200" label={ticketStatusLabel('PENDING_IFC')} n={b.awaitingIfc} />}
                        {b.review > 0 && <StageChip lane="review" className="bg-indigo-50 text-indigo-700 border-indigo-200" label={REVIEW_BUCKET_LABEL} title={REVIEW_BUCKET_TITLE} n={b.review} />}
                        {b.overdue > 0 && <StageChip lane="overdue" className="bg-red-50 text-red-700 border-red-200" label="Overdue" n={b.overdue} />}
                        {b.closed > 0 && <StageChip lane="closed" className="bg-gray-100 text-gray-500 border-gray-200" label={ticketStatusLabel('CLOSED')} n={b.closed} />}
                      </div>
                    </header>
                    <div className="p-2 space-y-1.5 max-h-[60vh] overflow-y-auto">
                      {b.tickets.map((t) => {
                        const actionNeeded = isActionRequired(t);
                        const due = t.targetCompletionAt ? new Date(t.targetCompletionAt as string) : null;
                        const overdue = isPastDue(t);
                        return (
                          <Link key={t.id} href={`/requests/${t.id}`} className="block">
                            <div className={`group rounded-lg border p-2.5 transition-colors hover:border-orange-300 hover:bg-orange-50/40 ${actionNeeded ? 'border-red-200 bg-red-50/30' : 'border-[var(--color-border)] bg-[var(--color-surface)]'}`}>
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {actionNeeded && <span className="shrink-0 w-2 h-2 rounded-full bg-red-500 animate-pulse" title="Action needed" />}
                                  <span className="font-mono text-[11px] font-bold text-[var(--color-text)] truncate">{t.ticketId}</span>
                                </div>
                                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border ${getStatusColor(t.status)}`}>{ticketStatusLabel(t.status)}</span>
                              </div>
                              <div className="text-xs text-[var(--color-text-muted)] mt-1 line-clamp-1">{t.title}</div>
                              {creationNoticeOwed(t.status, t.metadata) && (
                                <div className="mt-1"><span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-red-200 bg-red-50 text-red-700 text-[10px] font-bold" title="The assignment queue was never told about this request (nobody received its creation notice)."><Megaphone className="w-3 h-3" /> Not announced</span></div>
                              )}
                              <div className="flex items-center gap-3 mt-1.5 text-[10px] text-[var(--color-text-faint)]">
                                <span className="font-mono">{ticketUnitDisplay(t.unit, t.metadata).text}</span>
                                {due && <span className={`flex items-center gap-0.5 font-bold ${overdue ? 'text-red-600' : 'text-[var(--color-text-muted)]'}`}><Clock className="w-3 h-3" />{overdue ? 'Past due' : due.toLocaleDateString()}</span>}
                                {(t.comments?.length || 0) > 0 && <span className="flex items-center gap-0.5"><MessageCircle className="w-3 h-3" />{t.comments?.length}</span>}
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          )
        ) : paginatedTickets.length === 0 && attentionView === 'needs_me' && filteredTickets.length > 0 ? (
          <div data-testid="needs-me-empty" className="flex flex-col items-center justify-center py-24 bg-[var(--color-surface)] rounded-2xl border border-dashed border-[var(--color-border-strong)] text-center">
            <div className="w-20 h-20 bg-[var(--color-surface-2)] rounded-full flex items-center justify-center mb-6"><CheckCircle2 className="w-10 h-10 text-emerald-400" /></div>
            <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">{policyFault ? 'Which requests need you cannot be worked out right now' : 'Nothing needs you right now'}</h3>
            <p className="text-[var(--color-text-muted)] max-w-md mx-auto mb-6">{policyFault ? 'Permissions could not be read (see above).' : 'No request in this view is waiting on you.'} {filteredTickets.length} request{filteredTickets.length === 1 ? '' : 's'} match your filters.</p>
            <button onClick={() => pickAttentionView('all')} className="bg-slate-900 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-slate-800 transition-colors">Show all {filteredTickets.length}</button>
          </div>
        ) : paginatedTickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 bg-[var(--color-surface)] rounded-2xl border border-dashed border-[var(--color-border-strong)] text-center">
            <div className="w-20 h-20 bg-[var(--color-surface-2)] rounded-full flex items-center justify-center mb-6"><Search className="w-10 h-10 text-slate-300" /></div>
            <h3 className="text-xl font-bold text-[var(--color-text)] mb-2">No matching tickets found</h3>
            <p className="text-[var(--color-text-muted)] max-w-md mx-auto mb-6">Adjust your filters or search terms.</p>
            <button onClick={clearAllFilters} className="bg-slate-900 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-slate-800 transition-colors">Clear Filters</button>
          </div>
        ) : (
          <>
            {attentionView === 'needs_me' && (
              <div data-testid="needs-me-summary" className="mb-3 flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-muted)]">
                <span>Showing the <span className="font-bold text-[var(--color-text)]">{needsMeTickets.length}</span> request{needsMeTickets.length === 1 ? '' : 's'} that need you, of {filteredTickets.length}.</span>
                <button type="button" onClick={() => pickAttentionView('all')} className="font-bold text-orange-700 hover:underline">Show all</button>
              </div>
            )}
            {/* VIEW: TABLE MODE */}
            {viewMode === 'table' && (
              <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden min-h-[500px]">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-[var(--color-border)]">
                    <thead className="bg-[var(--color-surface-2)]">
                      <tr>
                        <th className="w-12 px-6 py-4"><input type="checkbox" checked={selectedTicketIds.size === paginatedTickets.length && paginatedTickets.length > 0} onChange={handleSelectAll} className="rounded border-[var(--color-border-strong)] text-orange-600 focus:ring-orange-500 w-4 h-4 cursor-pointer" /></th>
                        {[{ id: 'ticketId', label: 'Request ID' }, { id: 'status', label: 'Status' }, { id: 'title', label: 'Details' }, { id: 'unit', label: 'Unit' }, { id: 'priority', label: 'Priority' }, { id: 'lastModified', label: 'Last Activity' }].map((col) => (
                          <th key={col.id} className="px-6 py-4 text-left text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider cursor-pointer hover:text-orange-600 transition-colors group" onClick={() => handleSort(col.id as SortField)}><div className="flex items-center space-x-1"><span>{col.label}</span><ArrowUpDown className={`w-3 h-3 ${sortConfig.field === col.id ? 'text-orange-500' : 'text-slate-300'}`} /></div></th>
                        ))}
                        <th className="px-6 py-4 text-right text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
                      {paginatedTickets.map((ticket) => {
                         const daysOpen = calculateDaysOpen(ticket.createdAt);
                         const isStale = daysOpen > 14 && !isTerminalTicketStatus(ticket.status);
                         const isUrgent = ticket.status === 'REVISION_REQ' || ticket.requestType === 'RFI' || ticket.priority === 1;
                         const isSelected = selectedTicketIds.has(ticket.id!);
                         const isUnread = ticket.unreadBy?.includes(uid || '');
                         const isActionNeeded = isActionRequired(ticket); // Use Helper

                         return (
                          <tr key={ticket.id} className={`transition-colors group ${isSelected ? 'bg-orange-50/50' : 'hover:bg-[var(--color-surface-2)]'}`}>
                            <td className="px-6 py-4"><input type="checkbox" checked={isSelected} onChange={() => toggleTicketSelection(ticket.id!)} className="rounded border-[var(--color-border-strong)] text-orange-600 focus:ring-orange-500 w-4 h-4 cursor-pointer" /></td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex flex-col">
                                <div className="flex items-center">
                                  {/* DUAL BADGE LOGIC: Show Action OR Unread OR Both if room permits */}
                                  {isActionNeeded && <div className="w-2.5 h-2.5 bg-red-500 rounded-full mr-2 animate-pulse" title="Action Required" />}
                                  {!isActionNeeded && isUnread && <div className="w-2.5 h-2.5 bg-blue-500 rounded-full mr-2" title="New Updates" />}
                                  <Link href={`/requests/${ticket.id}`} className={`text-sm ${isUnread || isActionNeeded ? 'font-black text-[var(--color-text)]' : 'font-bold text-[var(--color-text)]'} hover:text-orange-600 hover:underline`}>{ticket.ticketId}</Link>
                                </div>
                                <span className="text-[10px] text-[var(--color-text-faint)] mt-0.5 font-mono">{ticket.requestType}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap"><span className={`inline-flex px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase border ${getStatusColor(ticket.status)}`}>{ticketStatusLabel(ticket.status)}</span>{ticket.archivedAt && <span className="ml-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border border-sky-300 text-sky-700 bg-sky-50" title="Content archived for space — restore from the saved archive to view">Archived</span>}</td>
                            <td className="px-6 py-4"><div className="flex flex-col max-w-md"><span className={`text-sm ${isUnread ? 'font-bold text-[var(--color-text)]' : 'font-medium text-[var(--color-text)]'} truncate`}>{ticket.title}</span>{rowChips(ticket)}<div className="flex items-center mt-1 text-xs text-[var(--color-text-muted)]"><User className="w-3 h-3 mr-1" /><span className="mr-3">{ticket.requesterName}</span>{ticket.assignedDrafterName && (<><ArrowRight className="w-3 h-3 mr-1 text-slate-300" /><span className="font-semibold text-[var(--color-text)]">{ticket.assignedDrafterName}</span></>)}</div></div></td>
                            <td className="px-6 py-4 whitespace-nowrap">{(() => { const u = ticketUnitDisplay(ticket.unit, ticket.metadata); return <span title={u.note ?? undefined} className={`text-sm ${u.unknown ? 'italic text-[var(--color-text-faint)]' : 'font-mono text-[var(--color-text-muted)]'} bg-[var(--color-surface-2)] px-2 py-1 rounded border border-[var(--color-border)]`}>{u.text}</span>; })()}</td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              {typeof ticket.priority === 'number' ? (
                                <div className={`flex items-center px-2 py-1 rounded border text-xs font-bold w-fit 
                                  ${ticket.priority === 1 ? 'text-red-600 bg-red-50 border-red-100' : 
                                    ticket.priority === 2 ? 'text-orange-600 bg-orange-50 border-orange-100' :
                                    ticket.priority === 3 ? 'text-blue-600 bg-blue-50 border-blue-100' :
                                    'text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]'
                                  }`}>
                                  {ticket.priority === 1 && <AlertCircle className="w-3 h-3 mr-1" />}
                                  {ticket.priority === 2 && <TrendingUp className="w-3 h-3 mr-1" />}
                                  {ticket.priority >= 3 && <Flag className="w-3 h-3 mr-1" />}
                                  P{ticket.priority}
                                </div>
                              ) : (
                                <div className={`flex items-center px-2 py-1 rounded border text-xs font-bold w-fit ${getPriorityColor(isUrgent, ticket.requestType)}`}>{isUrgent ? <AlertCircle className="w-3 h-3 mr-1" /> : <Flag className="w-3 h-3 mr-1" />}{isUrgent ? 'URGENT' : 'Normal'}</div>
                              )}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex flex-col text-xs">
                                <span className="font-medium text-[var(--color-text)]">{toDate(ticket.lastModified).toLocaleDateString()}</span>
                                {ticket.targetCompletionAt && (() => {
                                  const due = new Date(ticket.targetCompletionAt as string);
                                  // EDGE-7 done-when 3: the one overdue rule (lib/notifications.ts).
                                  const past = isPastDue(ticket);
                                  const soon = !past && isNearingDue(ticket);
                                  return (
                                    <span className={`font-bold flex items-center mt-0.5 ${past ? "text-red-600" : soon ? "text-amber-600" : "text-[var(--color-text-muted)]"}`}>
                                      <Clock className="w-3 h-3 mr-1" />
                                      {past ? `Past Due (${due.toLocaleDateString()})` : soon ? `Due Soon (${due.toLocaleDateString()})` : `Due ${due.toLocaleDateString()}`}
                                    </span>
                                  );
                                })()}
                                {isStale && !ticket.targetCompletionAt && (
                                  <span className="text-red-500 font-bold flex items-center mt-0.5"><Clock className="w-3 h-3 mr-1" />Stale ({daysOpen}d)</span>
                                )}
                              </div>
                            </td>
                            
                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium relative">
                              <div className="flex items-center justify-end space-x-2">
                                {/* NEW COMMENT BADGE FOR TABLE */}
                                {(ticket.comments?.length || 0) > 0 && (
                                  <div className={`flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold mr-2 ${isUnread ? 'bg-blue-100 text-blue-600' : 'text-[var(--color-text-faint)]'}`}>
                                    <MessageCircle className="w-3 h-3 mr-1" /> {ticket.comments?.length}
                                  </div>
                                )}
                                <Link href={`/requests/${ticket.id}`} className="text-[var(--color-text-faint)] hover:text-orange-600 transition-colors p-2 hover:bg-orange-50 rounded-full" title="View Details"><Eye className="w-4 h-4" /></Link>
                                
                                <div className="relative">
                                  <button onClick={() => setOpenRowMenu(openRowMenu === ticket.id ? null : ticket.id!)} className="text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] transition-colors p-2 hover:bg-[var(--color-surface-2)] rounded-full"><MoreVertical className="w-4 h-4" /></button>
                                  {openRowMenu === ticket.id && (
                                    <>
                                      <div className="fixed inset-0 z-40" onClick={() => setOpenRowMenu(null)}></div>
                                      <div className="absolute right-0 mt-2 w-48 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg z-50 origin-top-right animate-in fade-in zoom-in-95 duration-150">
                                        <div className="py-1">
                                          <button onClick={() => handleQuickMarkUrgent(ticket.id!)} className="flex w-full items-center px-4 py-2 text-xs text-amber-600 hover:bg-amber-50 font-bold"><AlertCircle className="w-3 h-3 mr-2" /> Mark Urgent</button>
                                          {hasAnyRole(['Manager', 'Admin']) && (!policyFault && <button onClick={() => handleQuickForceClose(ticket.id!)} className="flex w-full items-center px-4 py-2 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] font-medium"><Trash2 className="w-3 h-3 mr-2" /> Force Close</button>)}
                                        </div>
                                      </div>
                                    </>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                         );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="bg-[var(--color-surface)] px-6 py-4 border-t border-[var(--color-border)] flex items-center justify-between">
                  <div className="flex flex-col md:flex-row md:items-center text-sm text-[var(--color-text-muted)]"><span className="mr-4">Showing <span className="font-bold text-[var(--color-text)]">{(currentPage - 1) * itemsPerPage + 1}</span> to <span className="font-bold text-[var(--color-text)]">{Math.min(currentPage * itemsPerPage, listTickets.length)}</span> of <span className="font-bold text-[var(--color-text)]">{listTickets.length}</span> results</span><select value={itemsPerPage} onChange={(e) => setItemsPerPage(Number(e.target.value))} className="mt-2 md:mt-0 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-xs py-1 px-2 focus:ring-orange-500 focus:border-orange-500 cursor-pointer"><option value={10}>10 per page</option><option value={25}>25 per page</option><option value={50}>50 per page</option><option value={100}>100 per page</option></select></div>
                  <div className="flex items-center space-x-2"><button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 border border-[var(--color-border-strong)] rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--color-surface-2)] transition-colors">Previous</button><button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 border border-[var(--color-border-strong)] rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--color-surface-2)] transition-colors">Next</button></div>
                </div>
              </div>
            )}

            {/* VIEW: GRID MODE */}
            {viewMode === 'grid' && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-6">
                {paginatedTickets.map((ticket) => {
                   const isUrgent = ticket.status === 'REVISION_REQ' || ticket.requestType === 'RFI' || ticket.priority === 1;
                   const isUnread = ticket.unreadBy?.includes(uid || '');
                   const isActionNeeded = isActionRequired(ticket);
                   const commentCount = ticket.comments?.length || 0;
                   return (
                    <div key={ticket.id} className="group bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-5 hover:shadow-xl hover:border-orange-300 hover:-translate-y-1 transition-all duration-300 flex flex-col relative overflow-hidden">
                      <div className={`absolute top-0 left-0 w-full h-1.5 ${isUrgent ? 'bg-red-500' : 'bg-slate-200 group-hover:bg-orange-500'}`} />
                      
                      {/* Grid Badges: Stacked */}
                      <div className="absolute top-2 right-2 flex flex-col gap-1 items-end">
                        {isActionNeeded && (
                           <div className="flex items-center bg-red-100 text-red-600 text-[10px] font-bold px-2 py-0.5 rounded-full border border-red-200 animate-pulse shadow-sm">
                             <MousePointerClick className="w-3 h-3 mr-1" /> Action
                           </div>
                        )}
                        {commentCount > 0 && (
                          <div className={`flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border shadow-sm ${isUnread ? 'bg-blue-100 text-blue-600 border-blue-200' : 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]'}`}>
                            <MessageCircle className="w-3 h-3 mr-1" /> {commentCount} {isUnread && 'New'}
                          </div>
                        )}
                      </div>

                      <div className="flex justify-between items-start mb-4"><div className="flex flex-col"><span className="font-mono text-xs font-bold text-[var(--color-text-faint)]">{ticket.ticketId}</span><span className="text-[10px] font-bold text-[var(--color-text-faint)] mt-0.5 uppercase tracking-wide">{ticket.requestType}</span></div><div className="flex flex-col items-end gap-1"><span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase border ${getStatusColor(ticket.status)}`}>{ticketStatusLabel(ticket.status)}</span>{ticket.archivedAt && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border border-sky-300 text-sky-700 bg-sky-50" title="Content archived for space — restore from the saved archive to view">Archived</span>}</div></div>
                      <Link href={`/requests/${ticket.id}`} className="block mb-4"><h3 className={`text-lg leading-snug group-hover:text-orange-600 transition-colors line-clamp-2 ${isUnread ? 'font-black text-[var(--color-text)]' : 'font-bold text-[var(--color-text)]'}`}>{ticket.title}</h3>{rowChips(ticket)}</Link>
                      <div className="flex items-center text-xs text-[var(--color-text-muted)] mb-6 bg-[var(--color-surface-2)] p-2 rounded-lg border border-[var(--color-border)]"><span className="font-semibold bg-[var(--color-surface)] px-1.5 py-0.5 border rounded text-[var(--color-text)] mr-2 border-[var(--color-border)]">{ticketUnitDisplay(ticket.unit, ticket.metadata).text}</span><User className="w-3 h-3 mr-1" /><span className="truncate flex-1">{ticket.requesterName}</span></div>
                      <div className="mt-auto pt-4 border-t border-[var(--color-border)] flex items-center justify-between"><div className="flex flex-col"><span className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase">Assigned To</span><span className="text-xs font-semibold text-[var(--color-text)]">{ticket.assignedDrafterName || 'Unassigned'}</span></div><Link href={`/requests/${ticket.id}`}><button className="h-8 w-8 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-faint)] flex items-center justify-center group-hover:bg-orange-600 group-hover:text-white transition-all shadow-sm"><ArrowRight className="w-4 h-4" /></button></Link></div>
                    </div>
                   );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
