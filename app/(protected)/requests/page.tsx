"use client";

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { lastLoaded, keepLoaded } from '@/lib/warmLoads';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket, TicketStatus, OrgDraftingSettings, SelectOption, Role } from '@/types/schema';
import { logAuditAction } from '@/lib/audit';
import { appAlert, appConfirm } from '@/components/providers/DialogProvider';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody, heroPrimary, heroQuiet, type HeroFact } from '@/components/ui/PageHero';
import MoreMenu, { type MoreItem } from '@/components/ui/MoreMenu';
import UserAvatar from '@/components/ui/UserAvatar';
import CopyId from '@/components/ui/CopyId';
import ErrorNote from '@/components/ui/ErrorNote';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { friendlyError } from '@/lib/friendlyError';
import { onTransitionClick, transitionPush } from '@/lib/viewTransition';
import UnderlineTabs from '@/components/requests/UnderlineTabs';
import {
  Search,
  Plus,
  AlertCircle,
  List as ListIcon,
  Download,
  RefreshCw,
  SlidersHorizontal,
  X,
  Eye,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Trash2,
  Archive,
  MessageCircle,
  Zap,
  Inbox,
  Users,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { bandInput, bandInputIcon, bandSelect, bandSeg, bandSegItem, plural } from '@/components/admin/band';
import { isPastDue, isNearingDue } from '@/lib/notifications';
import { StatusTag, stageLabel, stageTone, waitingOn, fmtDay, fmtWhen, relTime, lastChange, useNarrow } from '@/components/requests/RequestBits';
import {
  isActionRequired as ticketNeedsAction,
  isManagementRole,
} from '@/lib/ticketAttention';

// =========================================================================================
// SECTION 1: TYPES & CONFIGURATION INTERFACES
// =========================================================================================

type SortField = 'ticketId' | 'title' | 'createdAt' | 'lastModified' | 'targetCompletionAt' | 'status' | 'priority' | 'unit';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

interface FilterConfig {
  status: TicketStatus | 'ALL';
  type: string | 'ALL';
  dateRange: 'all' | 'today' | 'week' | 'month' | 'quarter';
  assignedTo: 'all' | 'me' | 'unassigned' | 'action';
  priority: 'all' | 'urgent' | 'normal';
  search: string;
}

interface DashboardMetrics {
  totalVolume: number;
  activeQueue: number;
  myActionItems: number;
  overdue: number;
  dueThisWeek: number;
  staleTickets: number;
  mine: number;
  unassigned: number;
}

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

// =========================================================================================
// SECTION 4: MAIN COMPONENT - REQUEST PORTAL
// =========================================================================================

/** The list as last read for this account, workspace, roles and closed
 *  choice: shown at once when the page opens again (lib/warmLoads). */
const requestsKey = (orgId: string, uid: string, roles: readonly string[], withClosed: boolean) =>
  `requests:${orgId}|${uid}|${roles.join(",")}|${withClosed ? "all" : "open"}`;

export default function RequestPortal() {
  const { activeRole, roles, activeOrgId, uid } = useRole();
  const router = useRouter();
  const narrow = useNarrow();

  // --- STATE ---
  // Opened again: the list as last read, at once (read afresh below). The
  // page opens on all statuses, closed included.
  const [tickets, setTickets] = useState<Ticket[]>(() => (uid && activeOrgId ? lastLoaded<Ticket[]>(requestsKey(activeOrgId, uid, roles, true)) : undefined) ?? []);
  const [loading, setLoading] = useState<boolean>(true);
  // When true, the fetch drops the `.neq('status','CLOSED')` filter so
  // closed tickets show up. Lets a user find a previously completed
  // request to pull old drafts or reopen it.
  const [showClosed, setShowClosed] = useState<boolean>(false);
  // The last failed read, said in plain words where the list would be.
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  // Bumped by "Refresh" so the list is fetched again for real.
  const [reloadKey, setReloadKey] = useState(0);
  const [processingBulk, setProcessingBulk] = useState<boolean>(false);
  const [requestTypeOptions, setRequestTypeOptions] = useState<SelectOption[]>([]);

  // --- STATE: VIEW & UI ---
  // 'team' is the supervisor lens: active work grouped by the drafter it sits
  // with (plus the unassigned pool). It is strictly OPT-IN from the view
  // switcher — the portal always opens on the classic table. (It briefly
  // auto-switched management roles onto the board, which replaced the page
  // people knew with one they never asked for. Never hijack the landing
  // view.) A user's last pick is remembered.
  const [viewMode, setViewMode] = useState<'table' | 'team'>('table');
  const isSupervisorView = isManagementRole(roles);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('requests.viewMode');
      // The old card grid shows as the table now (same rows, real columns).
      if (saved === 'table' || saved === 'team') setViewMode(saved);
    } catch { /* storage unavailable — keep the table default */ }
  }, []);
  const pickView = useCallback((mode: 'table' | 'team') => {
    setViewMode(mode);
    try { localStorage.setItem('requests.viewMode', mode); } catch { /* non-fatal */ }
  }, []);
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState<boolean>(false);
  const [selectedTicketIds, setSelectedTicketIds] = useState<Set<string>>(new Set());

  // --- STATE: FILTERING ---
  const [filters, setFilters] = useState<FilterConfig>({
    status: 'ALL',
    type: 'ALL',
    dateRange: 'all',
    assignedTo: activeRole === 'Drafter' ? 'me' : 'all',
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
  // needed" badges, the sidebar count, and the header bell stay identical — and
  // so supervisors get the PENDING_IFC flag the routing layer already sends them.
  const isActionRequired = useCallback(
    (ticket: Ticket) => ticketNeedsAction(ticket, { uid, roles }),
    [uid, roles],
  );


  // --------------------------------------------------------------------
  // EFFECT: DATA SYNC ENGINE
  // --------------------------------------------------------------------
  // "Any" means any — so ALL and CLOSED both pull closed tickets. The
  // "Show Closed" toggle additionally forces closed into narrow status views
  // (e.g. show Drafting + Closed together). Specific open statuses skip the
  // closed rows entirely unless that toggle is on.
  const includeClosed = showClosed || filters.status === 'ALL' || filters.status === 'CLOSED';
  useEffect(() => {
    if (!uid || !activeOrgId) {
      setTickets([]);
      setLoading(false);
      return;
    }
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
      try {
        setLoading(true);
        let rows: Record<string, unknown>[] = [];

        if ((['Admin', 'Manager', 'Supervisor', 'DraftingSupervisor', 'DocCtrl'] as Role[]).some((r) => roles.includes(r)) || roles.some((r) => r.includes('Engineer'))) {
          let q = supabase.from('tickets').select('*').eq('org_id', activeOrgId);
          if (!includeClosed) q = q.neq('status', 'CLOSED');
          const { data, error: readErr } = await q.order('last_modified', { ascending: false });
          if (readErr) throw readErr;
          rows = (data || []) as Record<string, unknown>[];
        } else if (roles.includes('Drafter')) {
          const [assigned, pool] = await Promise.all([
            supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('assigned_drafter_id', uid),
            supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('status', 'PENDING_ASSIGNMENT'),
          ]);
          if (assigned.error) throw assigned.error;
          if (pool.error) throw pool.error;
          const map = new Map<string, Record<string, unknown>>();
          for (const r of [...(assigned.data || []), ...(pool.data || [])]) {
            map.set(r.id as string, r as Record<string, unknown>);
          }
          rows = Array.from(map.values());
          if (!includeClosed) rows = rows.filter((r) => r.status !== 'CLOSED');
        } else {
          let q = supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('requester_id', uid);
          if (!includeClosed) q = q.neq('status', 'CLOSED');
          const { data, error: readErr } = await q.order('last_modified', { ascending: false });
          if (readErr) throw readErr;
          rows = (data || []) as Record<string, unknown>[];
        }

        if (alive) {
          setError(null);
          const list = rows.map(fromRow);
          setTickets(list);
          keepLoaded(requestsKey(activeOrgId, uid, roles, includeClosed), list);
          setLoading(false);
          setRefreshing(false);
        }
      } catch (err) {
        console.error("Fetch Error:", err);
        if (alive) { setError(err ?? new Error('read failed')); setLoading(false); setRefreshing(false); }
      }
    };

    fetchTickets();
    const channel = supabase
      .channel(`tickets-portal-${activeOrgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `org_id=eq.${activeOrgId}` },
        () => { if (alive) fetchTickets(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [roles, activeOrgId, uid, includeClosed, reloadKey]);

  // --------------------------------------------------------------------
  // MEMO: ROLE-AWARE METRICS ENGINE
  // --------------------------------------------------------------------
  const metrics: DashboardMetrics = useMemo(() => {
    const activeTickets = tickets.filter(t => t.status !== 'CLOSED' && t.status !== 'CANCELED');
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    return {
      totalVolume: tickets.length,
      activeQueue: activeTickets.length,
      myActionItems: tickets.filter(t => isActionRequired(t)).length,
      overdue: activeTickets.filter(t => isPastDue(t)).length,
      dueThisWeek: activeTickets.filter(t => {
        if (!t.targetCompletionAt) return false;
        const due = new Date(t.targetCompletionAt as string).getTime();
        return due >= now && due - now <= week;
      }).length,
      staleTickets: activeTickets.filter(t => calculateDaysOpen(t.lastModified) > 7).length,
      mine: activeTickets.filter(t => t.assignedDrafterId === uid || t.requesterId === uid).length,
      unassigned: activeTickets.filter(t => !t.assignedDrafterId).length,
    };
  }, [tickets, isActionRequired, uid]);

  // How many sit at each stage, shown beside each choice in the Stage filter.
  const stageCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tickets) m.set(t.status, (m.get(t.status) ?? 0) + 1);
    return m;
  }, [tickets]);

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
      if (filters.status !== 'ALL' && ticket.status !== filters.status && !(showClosed && ticket.status === 'CLOSED')) return false;
      if (filters.type !== 'ALL' && ticket.requestType !== filters.type) return false;

      // Assignment Filter
      if (filters.assignedTo === 'me') {
        const isMyAssignment = ticket.assignedDrafterId === currentUid;
        const isMyRequest = ticket.requesterId === currentUid;
        if (!isMyAssignment && !isMyRequest) return false;
      }
      else if (filters.assignedTo === 'unassigned' && ticket.assignedDrafterId) return false;
      else if (filters.assignedTo === 'action' && !isActionRequired(ticket)) return false;

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
      } else if (sortConfig.field === 'targetCompletionAt') {
        // No due date sorts last either way.
        valA = fieldA ? toDate(fieldA).getTime() : (sortConfig.direction === 'asc' ? Infinity : -Infinity);
        valB = fieldB ? toDate(fieldB).getTime() : (sortConfig.direction === 'asc' ? Infinity : -Infinity);
      } else if (fieldA == null || fieldB == null) {
        valA = fieldA == null ? '' : String(fieldA);
        valB = fieldB == null ? '' : String(fieldB);
      }

      if (typeof valA === 'string' && typeof valB === 'string') {
        return sortConfig.direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [tickets, filters, sortConfig, uid, showClosed, isActionRequired]);

  // --- PAGINATION ---
  const paginatedTickets = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    return filteredTickets.slice(start, end);
  }, [filteredTickets, currentPage, itemsPerPage]);

  const totalPages = Math.ceil(filteredTickets.length / itemsPerPage);

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
      if (t.status === 'CLOSED' && !includeClosed) continue; // live work by default; included when the user asks for closed
      const key = t.assignedDrafterId || UNASSIGNED;
      if (!groups.has(key)) {
        groups.set(key, {
          id: t.assignedDrafterId || null,
          name: t.assignedDrafterId ? (t.assignedDrafterName || 'Unnamed drafter') : 'No drafter yet',
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
      review: count(g.tickets, (t) => ['PENDING_REVIEW', 'PENDING_FINAL_APPROVAL', 'PENDING_ENG_INITIAL', 'PENDING_ENG_TEAM', 'PENDING_ASSIGNMENT'].includes(t.status)),
      actionable: count(g.tickets, (t) => isActionRequired(t)),
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
    const headers = ['ID', 'Title', 'Unit', 'Status', 'Type', 'Requester', 'Drafter', 'Created', 'Modified'];
    const rows = filteredTickets.map(t => [
      t.ticketId,
      `"${t.title.replace(/"/g, '""')}"`, // Correctly escape double quotes within the title
      t.unit,
      t.status,
      t.requestType,
      t.requesterName,
      t.assignedDrafterName || 'Unassigned',
      toDate(t.createdAt).toISOString().split('T')[0],
      toDate(t.lastModified).toISOString().split('T')[0]
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `drafting_export_${new Date().toISOString()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
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

  const handleBulkArchive = useCallback(async () => {
    if (selectedTicketIds.size === 0) return;
    const closeWhat = `${selectedTicketIds.size} request${selectedTicketIds.size === 1 ? '' : 's'}`;
    if (!(await appConfirm({ title: `Close ${closeWhat}?`, message: 'They move to the closed list.', tone: 'danger', confirmLabel: `Close ${closeWhat}` }))) return;

    setProcessingBulk(true);
    try {
      // Per-ticket through the enforced route: state-machine validation,
      // server audit, and fan-out — a non-management caller gets a 403.
      await Promise.all(Array.from(selectedTicketIds).map(id => callWorkflowAction(id, 'close_ticket')));

      await logAuditAction({
        action: 'TICKET_BULK_ARCHIVE', resourceId: 'bulk', resourceType: 'ticket',
        orgId: activeOrgId || undefined, userId: uid || 'unknown', userRole: activeRole,
        details: { count: selectedTicketIds.size, ticketIds: Array.from(selectedTicketIds) }
      });

      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error("Bulk Archive Failed:", error);
      await appAlert({ title: 'Not all of them were closed', message: friendlyError(error), tone: 'danger' });
    } finally {
      setProcessingBulk(false);
    }
  }, [selectedTicketIds, activeOrgId, activeRole, uid, callWorkflowAction]);

  // "Urgent" is a PRIORITY, not a workflow state. This used to set
  // status=REVISION_REQ, which hijacked the revision stage as an urgency flag
  // and corrupted the ticket's real position in the workflow.
  const handleBulkUrgencyToggle = useCallback(async () => {
    if (selectedTicketIds.size === 0) return;
    setProcessingBulk(true);
    try {
      const now = new Date().toISOString();
      const results = await Promise.all(Array.from(selectedTicketIds).map(id =>
        supabase.from('tickets').update({ priority: 1, last_modified: now }).eq('id', id)
      ));
      const failed = results.filter((r) => r.error).length;
      if (failed > 0) throw new Error(`${failed} of ${results.length} weren't marked urgent. Try again.`);

      await logAuditAction({
        action: 'TICKET_BULK_URGENT', resourceId: 'bulk', resourceType: 'ticket',
        orgId: activeOrgId || undefined, userId: uid || 'unknown', userRole: activeRole,
        details: { count: selectedTicketIds.size, ticketIds: Array.from(selectedTicketIds) }
      });

      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error("Bulk Update Failed:", error);
      await appAlert({ title: "Not all marked urgent", message: friendlyError(error), tone: 'danger' });
    } finally {
      setProcessingBulk(false);
    }
  }, [selectedTicketIds, activeOrgId, activeRole, uid]);

  const handleQuickMarkUrgent = async (ticketId: string) => {
    try {
      const { error: upErr } = await supabase.from('tickets').update({ priority: 1, last_modified: new Date().toISOString() }).eq('id', ticketId);
      if (upErr) throw upErr;
      await logAuditAction({
        action: 'TICKET_MARK_URGENT', resourceId: ticketId, resourceType: 'ticket',
        orgId: activeOrgId || undefined, userId: uid || 'unknown', userRole: activeRole,
        details: { priority: 1 }
      });
    } catch (error) {
      console.error("Mark urgent failed:", error);
      await appAlert({ title: "Not marked urgent", message: friendlyError(error), tone: 'danger' });
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
    } catch (error) {
      console.error("Quick close failed:", error);
      await appAlert({ title: "Not closed", message: friendlyError(error), tone: 'danger' });
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
    setShowClosed(false);
  };


  if (loading && tickets.length === 0 && !error) {
    return (
      <PageShell width="full">
        <div className="mx-auto max-w-[1920px]">
          <PageHero kicker="Drafting requests" title={<Skeleton className="h-7 w-72 max-w-full" />} />
          <PageBody>
            <SkeletonRows rows={6} cols={4} what="drafting requests" />
          </PageBody>
        </div>
      </PageShell>
    );
  }

  if (!activeOrgId) {
    return (
      <PageShell width="form">
        <PageHero kicker="Drafting requests" title="Pick a workspace." sub="Choose a workspace in the sidebar to see its drafting requests." />
      </PageShell>
    );
  }

  // The page's answer: what waits on you, else what's late, else what's open.
  const openN = metrics.activeQueue;
  const waitN = metrics.myActionItems;
  const answer = error != null && tickets.length === 0 ? "The requests didn't load."
    : metrics.totalVolume === 0 ? 'No requests yet.'
    : openN === 0 ? 'No open requests.'
    : waitN > 0 ? `${plural(waitN, 'request')} waiting on you.`
    : metrics.overdue > 0 ? `${plural(metrics.overdue, 'request')} overdue.`
    : `${plural(openN, 'open request')}.`;
  const facts: HeroFact[] = metrics.totalVolume === 0 ? [] : [
    { label: 'Waiting on you', value: waitN, tone: waitN > 0 ? 'warn' : undefined, hero: waitN > 0 },
    { label: 'Overdue', value: metrics.overdue, tone: metrics.overdue > 0 ? 'bad' : undefined, hero: waitN === 0 && metrics.overdue > 0 },
    ...(narrow ? [] : [{ label: 'Due this week', value: metrics.dueThisWeek }]),
    { label: 'Open', value: openN },
  ];
  const onlyMine = filters.assignedTo === 'action';
  const filtersOn = filters.status !== 'ALL' || filters.type !== 'ALL' || filters.dateRange !== 'all' || filters.assignedTo !== 'all' || filters.priority !== 'all' || !!filters.search || showClosed;
  const canForceClose = ['Manager', 'Admin'].includes(activeRole);
  const allOnPage = selectedTicketIds.size === paginatedTickets.length && paginatedTickets.length > 0;
  const count = (status: string) => stageCounts.get(status) ?? 0;
  const withN = (label: string, n: number) => (n > 0 ? `${label} (${n})` : label);
  const typeOptions = requestTypeOptions.length > 0 ? requestTypeOptions.map((o) => ({ v: String(o.value), l: o.label })) : [{ v: 'ISO', l: 'ISO' }, { v: 'RFI', l: 'RFI' }, { v: 'MOC', l: 'MOC' }, { v: 'ASBUILT', l: 'As-built' }, { v: 'INSPECTION', l: 'Inspection' }];
  // The filters behind "More filters", each said back as a chip that takes
  // it off, so nothing set is out of sight while the panel is closed.
  const extraChips: Array<{ key: string; label: string; clear: () => void }> = [
    ...(filters.type !== 'ALL' ? [{ key: 'type', label: `Type: ${typeOptions.find((o) => o.v === filters.type)?.l ?? filters.type}`, clear: () => setFilters((f) => ({ ...f, type: 'ALL' })) }] : []),
    ...(filters.dateRange !== 'all' ? [{ key: 'date', label: `Active ${filters.dateRange === 'today' ? 'today' : filters.dateRange === 'week' ? 'this week' : 'this month'}`, clear: () => setFilters((f) => ({ ...f, dateRange: 'all' })) }] : []),
    ...(filters.priority === 'urgent' ? [{ key: 'urgent', label: 'Urgent and RFI only', clear: () => setFilters((f) => ({ ...f, priority: 'all' })) }] : []),
    ...(showClosed && filters.status !== 'ALL' ? [{ key: 'closed', label: 'Closed ones too', clear: () => setShowClosed(false) }] : []),
  ];
  // A row waiting on you opens with that step and its button at the top.
  const href = (t: Ticket) => `/requests/${t.id}${isActionRequired(t) ? '?ask=turn' : ''}`;

  const rowProps = (t: Ticket) => ({
    ticket: t,
    actionNeeded: isActionRequired(t),
    unread: !!t.unreadBy?.includes(uid || ''),
    selected: selectedTicketIds.has(t.id!),
    onToggle: () => toggleTicketSelection(t.id!),
    onOpen: () => transitionPush(router, href(t)),
    onLink: (e: React.MouseEvent<HTMLElement>) => onTransitionClick(e, () => router.push(href(t))),
    onType: t.requestType ? () => { setFilters((f) => ({ ...f, type: f.type === t.requestType ? 'ALL' : t.requestType })); setCurrentPage(1); } : undefined,
    typeOn: !!t.requestType && filters.type === t.requestType,
    onUnit: t.unit ? () => { setFilters((f) => ({ ...f, search: f.search === t.unit ? '' : t.unit })); setCurrentPage(1); } : undefined,
    unitOn: !!t.unit && filters.search === t.unit,
    menu: [
      { icon: <Eye className="w-4 h-4" />, label: 'Open', onClick: () => transitionPush(router, href(t)) },
      { icon: <AlertCircle className="w-4 h-4" />, label: 'Mark urgent', onClick: () => handleQuickMarkUrgent(t.id!) },
      ...(canForceClose && t.status !== 'CLOSED' ? [{ icon: <Trash2 className="w-4 h-4" />, label: 'Force close', onClick: () => handleQuickForceClose(t.id!), tone: 'bad' as const, line: true }] : []),
    ],
  });

  // A column you can sort by: the arrow shows only on the one sorted now
  // (and on hover elsewhere), so the header reads as words.
  const sortHead = (field: SortField, label: string, className = '') => {
    const on = sortConfig.field === field;
    const Arrow = on ? (sortConfig.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
    return (
      <th className={`font-medium px-4 h-10 whitespace-nowrap ${className}`} aria-sort={on ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" onClick={() => handleSort(field)} className={`group/sort inline-flex items-center gap-1 hover:text-[var(--color-text)] ${on ? 'text-[var(--color-text)]' : ''}`}>
          {label}<Arrow aria-hidden className={`w-3.5 h-3.5 transition-opacity ${on ? '' : 'opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100'}`} />
        </button>
      </th>
    );
  };
  const tableHead = (
    <thead className="bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)] text-left">
      <tr>
        <th className="w-11 pl-4 h-10 rounded-tl-xl">
          <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={handleSelectAll} className="w-4 h-4 rounded border-[var(--color-border-strong)] cursor-pointer align-middle" />
        </th>
        {sortHead('ticketId', 'Request')}
        {sortHead('title', 'Title and last change', 'w-full min-w-[240px]')}
        {sortHead('status', 'Stage')}
        <th className="font-medium px-4 h-10 whitespace-nowrap hidden md:table-cell">Waiting on</th>
        {sortHead('targetCompletionAt', 'Due')}
        {sortHead('priority', 'Priority', 'hidden xl:table-cell')}
        <th className="font-medium px-4 h-10 whitespace-nowrap hidden 2xl:table-cell">Requester</th>
        {sortHead('lastModified', 'Updated', 'hidden lg:table-cell')}
        <th className="pr-3 h-10 rounded-tr-xl"><span className="sr-only">Comments and actions</span></th>
      </tr>
    </thead>
  );
  const COLS = 10;

  return (
    <PageShell width="full">
      <div className="mx-auto max-w-[1920px]">
      <PageHero
        kicker="Drafting requests"
        title={answer}
        facts={facts}
        sub={waitN > 0 && !onlyMine
          ? <button type="button" onClick={() => setFilters({ ...filters, assignedTo: 'action', status: 'ALL' })} className="text-[var(--color-accent-text)] hover:underline underline-offset-2">Show only what waits on you</button>
          : metrics.staleTickets > 0 ? `${plural(metrics.staleTickets, 'open request')} with no activity in 7 days.` : undefined}
        tools={
          <MoreMenu iconOnly label="More: refresh, export" triggerClass={heroQuiet} items={[
            { icon: <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />, label: refreshing ? "Refreshing" : "Refresh", onClick: handleRefresh },
            { icon: <Download className="w-4 h-4" />, label: "Export to CSV", onClick: handleExportCSV },
          ]} />
        }
        primary={<Link href="/requests/new" className={heroPrimary}><Plus className="w-4 h-4" /> New request</Link>}
      >
        <div className="space-y-3">
          {/* A supervisor's two ways to look at the work. */}
          {isSupervisorView && (
            <div className="border-b border-[var(--color-border)]">
              <UnderlineTabs label="Request views" value={viewMode} onChange={pickView} className="-mb-px"
                tabs={[{ key: 'table', label: 'List', icon: ListIcon }, { key: 'team', label: 'By drafter', icon: Users }]} />
            </div>
          )}
          {/* The daily filters: words, who, stage. The rest under More filters. On a phone they run in one line that scrolls sideways. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[240px] max-sm:basis-full">
              <Search className={bandInputIcon} />
              <label htmlFor="req-search" className="sr-only">Search requests</label>
              <input id="req-search" type="search" enterKeyHint="search" placeholder="Search by number, title or name" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} className={bandInput} />
            </div>
            <div className="flex flex-wrap gap-2 items-center max-sm:w-full">
              <label className="sr-only" htmlFor="req-assignee">Who it waits on</label>
              <select id="req-assignee" value={filters.assignedTo} onChange={(e) => setFilters({ ...filters, assignedTo: e.target.value as FilterConfig['assignedTo'] })} className={`${bandSelect} w-44 max-sm:w-auto max-sm:flex-1 max-sm:min-w-0`}>
                <option value="all">Anyone</option>
                <option value="action">{withN('Waiting on me', waitN)}</option>
                <option value="me">{withN('Mine', metrics.mine)}</option>
                <option value="unassigned">{withN('No drafter yet', metrics.unassigned)}</option>
              </select>
              <label className="sr-only" htmlFor="req-stage">Stage</label>
              <select id="req-stage" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as FilterConfig['status'] })} className={`${bandSelect} w-48 max-sm:w-auto max-sm:flex-1 max-sm:min-w-0`}>
                <option value="ALL">Any stage</option>
                {(['PENDING_ENG_INITIAL', 'PENDING_ENG_TEAM', 'PENDING_ASSIGNMENT', 'DRAFTING', 'REVISION_REQ', 'PENDING_REVIEW', 'PENDING_FINAL_APPROVAL', 'PENDING_IFC', 'FINAL_DRAFT', 'CLOSED'] as TicketStatus[]).map((st) => (
                  <option key={st} value={st}>{withN(st === 'PENDING_ENG_INITIAL' ? 'First review' : stageLabel(st), count(st))}</option>
                ))}
              </select>
              <button type="button" onClick={() => setIsFilterPanelOpen(!isFilterPanelOpen)} aria-expanded={isFilterPanelOpen} aria-controls="req-more-filters" title="More filters"
                className={`${heroQuiet} max-sm:px-3 ${isFilterPanelOpen ? 'bg-[var(--color-surface-2)]' : ''}`}>
                <SlidersHorizontal aria-hidden className="w-4 h-4" /><span className="max-sm:sr-only">More filters</span>{extraChips.length > 0 && <span className="font-normal tabular-nums text-[var(--color-text-muted)]">{extraChips.length}</span>}
              </button>
              {filtersOn && <span className="text-body text-[var(--color-text-muted)] tabular-nums whitespace-nowrap">{filteredTickets.length} of {tickets.length}</span>}
              {filtersOn && <button type="button" onClick={() => { clearAllFilters(); setCurrentPage(1); }} className="h-10 pointer-coarse:h-11 px-1 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Clear filters</button>}
            </div>
          </div>

          {!isFilterPanelOpen && extraChips.length > 0 && (
            <ul aria-label="Other filters on" className="flex flex-wrap gap-2">
              {extraChips.map((c) => (
                <li key={c.key}>
                  <button type="button" onClick={c.clear} aria-label={`Remove filter: ${c.label}`} className="ui-tag ui-hit !font-sans !font-medium gap-1.5">
                    {c.label}<X aria-hidden className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {isFilterPanelOpen && (
            <div id="req-more-filters" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 grid grid-cols-1 lg:grid-cols-[auto_auto_1fr] gap-x-8 gap-y-4 items-start">
              <div className="min-w-0">
                <div className="text-body font-medium text-[var(--color-text)] mb-1.5">Request type</div>
                <div className={bandSeg} role="group" aria-label="Request type">
                  <button type="button" onClick={() => setFilters({ ...filters, type: 'ALL' })} aria-pressed={filters.type === 'ALL'} className={bandSegItem(filters.type === 'ALL')}>All</button>
                  {typeOptions.map(({ v, l }) => (
                    <button key={v} type="button" onClick={() => setFilters({ ...filters, type: v })} aria-pressed={filters.type === v} className={bandSegItem(filters.type === v)}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-body font-medium text-[var(--color-text)] mb-1.5">Last activity</div>
                <div className={bandSeg} role="group" aria-label="Last activity">
                  {([['all', 'Any time'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month']] as const).map(([v, l]) => (
                    <button key={v} type="button" onClick={() => setFilters({ ...filters, dateRange: v })} aria-pressed={filters.dateRange === v} className={bandSegItem(filters.dateRange === v)}>{l}</button>
                  ))}
                </div>
              </div>
              <fieldset className="min-w-0">
                <legend className="text-body font-medium text-[var(--color-text)] mb-1.5">Also show</legend>
                <label className="flex items-center gap-2 min-h-9 text-reading text-[var(--color-text)] cursor-pointer">
                  <input type="checkbox" checked={filters.priority === 'urgent'} onChange={(e) => setFilters({ ...filters, priority: e.target.checked ? 'urgent' : 'all' })} className="w-4 h-4 rounded border-[var(--color-border-strong)]" />
                  Urgent and RFI only
                </label>
                <label className={`flex items-center gap-2 min-h-9 text-reading cursor-pointer ${filters.status === 'ALL' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text)]'}`}>
                  <input type="checkbox" checked={showClosed || filters.status === 'ALL'} disabled={filters.status === 'ALL'} onChange={(e) => setShowClosed(e.target.checked)} aria-describedby="req-closed-hint" className="w-4 h-4 rounded border-[var(--color-border-strong)]" />
                  Closed requests too
                </label>
                <p id="req-closed-hint" className="text-body text-[var(--color-text-muted)]">{filters.status === 'ALL' ? 'Any stage already includes closed ones.' : 'Adds closed requests to the stage you picked.'}</p>
              </fieldset>
            </div>
          )}
        </div>
      </PageHero>

      <PageBody className="!space-y-3">
        {selectedTicketIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-2">
            <span className="text-reading font-medium text-[var(--color-text)] mr-2 tabular-nums">{selectedTicketIds.size} selected</span>
            <Button variant="secondary" onClick={handleBulkUrgencyToggle} loading={processingBulk}><Zap className="w-4 h-4" /> Mark urgent</Button>
            <Button variant="secondary" onClick={handleBulkArchive} loading={processingBulk}><Archive className="w-4 h-4" /> Close</Button>
            <div className="flex-1" />
            <button type="button" onClick={() => setSelectedTicketIds(new Set())} aria-label="Clear selection" title="Clear selection" className="w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
          </div>
        )}

        {error != null && (
          <ErrorNote error={error} title={tickets.length > 0 ? "The list didn't refresh." : undefined} onRetry={handleRefresh} />
        )}

        {viewMode === 'team' ? (
          teamBoard.length === 0 ? (
            error != null ? null : <EmptySheet line="No open work. Nothing is assigned or waiting right now." />
          ) : (
            <>
              <div className="max-sm:hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                <table className="w-full text-body">
                  {tableHead}
                  {teamBoard.map((b) => (
                    <tbody key={b.id || 'pool'} className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border-strong)]">
                      <tr className="bg-[var(--color-canvas)]">
                        <td colSpan={COLS} className="px-4 py-2.5">
                          <DrafterHead b={b} />
                        </td>
                      </tr>
                      {b.tickets.map((t) => <RequestRow key={t.id} {...rowProps(t)} />)}
                    </tbody>
                  ))}
                </table>
              </div>
              <div className="sm:hidden space-y-6">
                {teamBoard.map((b) => (
                  <section key={b.id || 'pool'}>
                    <div className="mb-2"><DrafterHead b={b} /></div>
                    <ul className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
                      {b.tickets.map((t) => <RequestItem key={t.id} {...rowProps(t)} />)}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )
        ) : paginatedTickets.length === 0 ? (
          error != null ? null : (
            <EmptySheet
              line={tickets.length === 0 ? 'New requests show up here.' : 'Nothing matches these filters.'}
              action={tickets.length > 0
                ? <button type="button" onClick={() => { clearAllFilters(); setCurrentPage(1); }} className={heroQuiet}>Clear filters</button>
                : undefined}
            />
          )
        ) : (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-body max-sm:hidden">
              {tableHead}
              <tbody className="divide-y divide-[var(--color-border)]">
                {paginatedTickets.map((t) => <RequestRow key={t.id} {...rowProps(t)} />)}
              </tbody>
            </table>
            <ul className="sm:hidden divide-y divide-[var(--color-border)]">
              {paginatedTickets.map((t) => <RequestItem key={t.id} {...rowProps(t)} />)}
            </ul>
            {filteredTickets.length > 10 && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-t border-[var(--color-border)] text-body text-[var(--color-text-muted)]">
                <div className="flex items-center gap-3">
                  <span className="tabular-nums">{(currentPage - 1) * itemsPerPage + 1} to {Math.min(currentPage * itemsPerPage, filteredTickets.length)} of {filteredTickets.length}</span>
                  <label className="sr-only" htmlFor="req-per-page">Rows per page</label>
                  <select id="req-per-page" value={itemsPerPage} onChange={(e) => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1); }} className="h-8 pointer-coarse:h-11 px-2 rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] text-body pointer-coarse:text-reading text-[var(--color-text)]">
                    {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className={heroQuiet}>Previous</button>
                  <button type="button" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages} className={heroQuiet}>Next</button>
                </div>
              </div>
            )}
          </div>
        )}
      </PageBody>
      </div>
    </PageShell>
  );
}

// =========================================================================================
// ROWS
// =========================================================================================

interface RowProps {
  ticket: Ticket;
  actionNeeded: boolean;
  unread: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  /** The title link's click: opens the request inside a view transition. */
  onLink: (e: React.MouseEvent<HTMLElement>) => void;
  /** Filter the list to this request's type (again: all types). */
  onType?: () => void;
  typeOn?: boolean;
  /** Filter the list to this request's unit (again: every unit). */
  onUnit?: () => void;
  unitOn?: boolean;
  menu: MoreItem[];
}

const rowMenuTrigger = "w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]";

/** A type or unit as quiet words that filter the list on a click. */
function MetaFilter({ on, onClick, title, children }: { on?: boolean; onClick?: () => void; title: string; children: React.ReactNode }) {
  if (!onClick) return <span>{children}</span>;
  return (
    <button type="button" onClick={onClick} aria-pressed={on} title={title}
      className={`rounded hover:text-[var(--color-accent-text)] hover:underline underline-offset-2 ${on ? 'font-medium text-[var(--color-accent-text)] underline' : ''}`}>
      {children}
    </button>
  );
}

function DueText({ t }: { t: Ticket }) {
  if (!t.targetCompletionAt) return <span className="text-[var(--color-text-faint)]">None</span>;
  const late = isPastDue(t);
  const soon = !late && isNearingDue(t);
  return (
    <span className={`tabular-nums whitespace-nowrap ${late ? 'font-medium text-[var(--state-overdue-text)]' : soon ? 'font-medium text-[var(--state-held-text)]' : 'text-[var(--color-text)]'}`}>
      {fmtDay(t.targetCompletionAt)}{late && <span className="sr-only"> (overdue)</span>}{soon && <span className="sr-only"> (due soon)</span>}
    </span>
  );
}

function priorityText(t: Ticket): React.ReactNode {
  if (typeof t.priority === 'number') {
    return t.priority === 1
      ? <StatusTag tone="bad">P1 urgent</StatusTag>
      : <span className="tabular-nums text-[var(--color-text-muted)]">P{t.priority}</span>;
  }
  const urgent = t.status === 'REVISION_REQ' || t.requestType === 'RFI';
  return urgent ? <StatusTag tone="bad">Urgent</StatusTag> : <span className="text-[var(--color-text-muted)]">Normal</span>;
}

/** What changed last, in words: "Sent back for a revision by mleonard". */
function ChangeLine({ t, withTime = false }: { t: Ticket; withTime?: boolean }) {
  const lc = lastChange(t);
  if (!lc) return null;
  const when = withTime && lc.at ? relTime(lc.at) : '';
  return (
    <span className="block truncate text-body text-[var(--color-text-muted)]">
      {lc.what}{lc.who ? ` by ${lc.who}` : ''}{when ? `, ${/^\d|^[A-Z][a-z]{2} \d/.test(when) ? when : when.toLowerCase()}` : ''}
    </span>
  );
}

/** Who it waits on: "You" in the waiting color (it needs you), else a name. */
function WaitingCell({ t, actionNeeded }: { t: Ticket; actionNeeded: boolean }) {
  const who = waitingOn(t);
  if (actionNeeded) return <StatusTag tone="warn">You</StatusTag>;
  return who ? <span className="text-[var(--color-text)]">{who}</span> : <span className="text-[var(--color-text-faint)]">Nobody</span>;
}

/** One request as a table row: the whole row opens it. Late rows that wait
 *  on you carry the 3 px late edge; a selected row the brand edge. */
function RequestRow({ ticket: t, actionNeeded, unread, selected, onToggle, onOpen, onLink, onType, typeOn, onUnit, unitOn, menu }: RowProps) {
  const late = isPastDue(t);
  const comments = t.comments?.length ?? 0;
  return (
    <tr
      onClick={(e) => { if ((e.target as HTMLElement).closest('a,button,input,label,select,[role=menu]')) return; onOpen(); }}
      className={`cursor-pointer transition-colors ${selected ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface-2)]'}`}
    >
      <td className="pl-4 py-3 relative align-top">
        {late && actionNeeded ? <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />
          : selected && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--color-main)]" />}
        <input type="checkbox" aria-label={`Select ${t.ticketId}`} checked={selected} onChange={onToggle} className="mt-0.5 w-4 h-4 rounded border-[var(--color-border-strong)] cursor-pointer" />
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <div className="relative flex items-center">
          {unread && <span className="absolute -left-3 ui-dot !w-1.5 !h-1.5 !bg-[var(--color-main)]" title="New updates" aria-label="New updates" />}
          <CopyId value={t.ticketId} label="request number" className="text-reading" />
        </div>
        <div className="mt-0.5 text-body text-[var(--color-text-muted)] flex items-center gap-1.5">
          {t.requestType && <MetaFilter onClick={onType} on={typeOn} title={typeOn ? 'Show every type' : `Show only ${t.requestType} requests`}>{t.requestType}</MetaFilter>}
          {t.requestType && t.unit && <span aria-hidden>·</span>}
          {t.unit && <MetaFilter onClick={onUnit} on={unitOn} title={unitOn ? 'Show every unit' : `Show only unit ${t.unit}`}>Unit {t.unit}</MetaFilter>}
        </div>
      </td>
      <td className="px-4 py-3 align-top max-w-0">
        <Link href={`/requests/${t.id}`} onClick={onLink} className={`block line-clamp-2 text-reading leading-snug text-[var(--color-text)] hover:text-[var(--color-accent-text)] ${unread ? 'font-medium' : ''}`}>{t.title}</Link>
        <ChangeLine t={t} />
        {t.archivedAt && <span className="mt-1 inline-block"><StatusTag tone="none">Files archived</StatusTag></span>}
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <StatusTag tone={stageTone(t.status)} plain>{stageLabel(t.status)}</StatusTag>
      </td>
      <td className="px-4 py-3 align-top hidden md:table-cell whitespace-nowrap"><WaitingCell t={t} actionNeeded={actionNeeded} /></td>
      <td className="px-4 py-3 align-top"><DueText t={t} /></td>
      <td className="px-4 py-3 align-top hidden xl:table-cell whitespace-nowrap">{priorityText(t)}</td>
      <td className="px-4 py-3 align-top hidden 2xl:table-cell whitespace-nowrap text-[var(--color-text)]">{t.requesterName || <span className="text-[var(--color-text-faint)]">Unknown</span>}</td>
      <td className="px-4 py-3 align-top hidden lg:table-cell whitespace-nowrap tabular-nums text-[var(--color-text-muted)]" title={fmtWhen(t.lastModified)}>{relTime(t.lastModified)}</td>
      <td className="pr-3 py-2 align-top">
        <div className="flex items-center justify-end gap-1">
          {comments > 0 && (
            <span className="inline-flex items-center gap-1 text-body tabular-nums text-[var(--color-text-muted)]" title={`${comments} comment${comments === 1 ? '' : 's'}`}>
              <MessageCircle aria-hidden className="w-3.5 h-3.5" />{comments}<span className="sr-only"> comments</span>
            </span>
          )}
          <MoreMenu iconOnly label={`More for ${t.ticketId}`} triggerClass={rowMenuTrigger} items={menu} />
        </div>
      </td>
    </tr>
  );
}

/** The same request as a card on a phone: number and stage, the title,
 *  who it waits on and when it's due, and what changed last. */
function RequestItem({ ticket: t, actionNeeded, unread, menu, onLink }: RowProps) {
  const late = isPastDue(t);
  const who = waitingOn(t);
  return (
    <li className="relative flex items-start gap-1">
      {late && actionNeeded && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
      <div className="flex-1 min-w-0 pl-4 pr-1 py-3">
        <div className="flex items-center gap-2">
          {unread && <span className="ui-dot !w-1.5 !h-1.5 !bg-[var(--color-main)]" aria-label="New updates" />}
          <CopyId value={t.ticketId} label="request number" className="relative z-[1] text-reading min-w-0" />
          <span className="flex-1" />
          <StatusTag tone={stageTone(t.status)} plain>{stageLabel(t.status)}</StatusTag>
        </div>
        <Link href={`/requests/${t.id}`} onClick={onLink} className={`block mt-0.5 text-reading text-[var(--color-text)] line-clamp-2 after:absolute after:inset-0 after:content-[''] ${unread ? 'font-medium' : ''}`}>{t.title}</Link>
        <div className="mt-1 text-body text-[var(--color-text-muted)] flex flex-wrap gap-x-3">
          <span>Waiting on {actionNeeded ? <span className="font-medium text-[var(--state-held-text)]">you</span> : (who ?? 'nobody')}</span>
          {t.targetCompletionAt && <span>Due <DueText t={t} /></span>}
        </div>
        <ChangeLine t={t} withTime />
      </div>
      <div className="relative z-[1] pt-2 pr-2"><MoreMenu iconOnly label={`More for ${t.ticketId}`} triggerClass={rowMenuTrigger} items={menu} /></div>
    </li>
  );
}

interface DrafterGroup {
  id: string | null;
  name: string;
  total: number;
  closed: number;
  drafting: number;
  revision: number;
  awaitingIfc: number;
  review: number;
  actionable: number;
  overdue: number;
}

/** A drafter's group heading in the By drafter view: who, and how their load breaks down (zeros left out). */
function DrafterHead({ b }: { b: DrafterGroup }) {
  const parts: Array<[string, number, boolean?]> = [
    ['Active', b.total - b.closed],
    ['Waiting on you', b.actionable],
    ['Overdue', b.overdue, true],
    ['Drafting', b.drafting],
    ['Revision', b.revision],
    ['In review', b.review],
    ['Ready to issue', b.awaitingIfc],
    ['Closed', b.closed],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
      <span className="inline-flex items-center gap-2 min-w-0">
        {b.id === null
          ? <span className="w-7 h-7 rounded-full grid place-items-center border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"><Inbox aria-hidden className="w-3.5 h-3.5" /></span>
          : <UserAvatar uid={b.id} name={b.name} size={28} rounded="full" />}
        <span className="text-reading font-medium text-[var(--color-text)] truncate">{b.name}</span>
      </span>
      {parts.filter(([, n], i) => i === 0 || n > 0).map(([label, n, bad]) => (
        <span key={label} className="text-body text-[var(--color-text-muted)]">
          {label} <span className={`font-medium tabular-nums ${bad ? 'text-[var(--state-overdue-text)]' : 'text-[var(--color-text)]'}`}>{n}</span>
        </span>
      ))}
    </div>
  );
}

/** Nothing to list: one line, and at most one way forward. */
function EmptySheet({ line, action }: { line: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center">
      <p className="text-reading text-[var(--color-text)]">{line}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
