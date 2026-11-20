"use client";

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket, TicketStatus, OrgDraftingSettings, SelectOption, Role } from '@/types/schema';
import { logAuditAction } from '@/lib/audit';
import { appAlert, appConfirm } from '@/components/providers/DialogProvider';
import LoadingBlock from '@/components/ui/LoadingBlock';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from '@/components/ui/PageHero';
import MoreMenu from '@/components/ui/MoreMenu';
import { badgeText } from '@/lib/badge';
import UserAvatar from '@/components/ui/UserAvatar';
import {
  Search,
  Plus,
  Clock,
  AlertCircle,
  ArrowRight,
  LayoutGrid,
  List as ListIcon,
  MoreVertical,
  Download,
  RefreshCw,
  User,
  SlidersHorizontal,
  X,
  ChevronDown,
  Eye,
  ArrowUpDown,
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
} from 'lucide-react';
import {
  isActionRequired as ticketNeedsAction,
  isManagementRole,
} from '@/lib/ticketAttention';

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
  assignedTo: 'all' | 'me' | 'unassigned' | 'action';
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
    case 'NEW': return 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]';
    case 'PENDING_ENG_INITIAL': return 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]';
    case 'PENDING_ENG_TEAM': return 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]';
    case 'PENDING_ASSIGNMENT': return 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]'; 
    case 'DRAFTING': return 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]'; 
    case 'PENDING_REVIEW': return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'REVISION_REQ': return 'bg-amber-50 text-amber-700 border-amber-200 font-bold'; 
    case 'PENDING_IFC': return 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]';
    case 'FINAL_DRAFT': return 'bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]';
    case 'PENDING_FINAL_APPROVAL': return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'CLOSED': return 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]';
    default: return 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)]';
  }
};

const getPriorityColor = (isUrgent: boolean, type: string) => {
  if (type === 'RFI') return 'text-[var(--color-text)] bg-[var(--color-surface-2)] border-[var(--color-border)]';
  if (isUrgent) return 'text-amber-600 bg-amber-50 border-amber-100';
  return 'text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]';
};

// A small count pill used in the supervisor board's column header to summarise
// how a drafter's load breaks down by stage.
const StageChip = ({ label, n, className }: { label: string; n: number; className: string }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${className}`}>
    {n}<span className="font-medium opacity-80">{label}</span>
  </span>
);

// =========================================================================================
// SECTION 4: MAIN COMPONENT - REQUEST PORTAL
// =========================================================================================

export default function RequestPortal() {
  const { activeRole, roles, activeOrgId, uid } = useRole();
  
  // --- STATE ---
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  // When true, the fetch drops the `.neq('status','CLOSED')` filter so
  // closed tickets show up. Lets a user find a previously completed
  // request to pull old drafts or reopen it.
  const [showClosed, setShowClosed] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
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
  const [viewMode, setViewMode] = useState<'table' | 'grid' | 'team'>('table');
  const isSupervisorView = isManagementRole(roles);
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
          setTickets(rows.map(fromRow));
          setLoading(false);
          setRefreshing(false);
        }
      } catch (err) {
        console.error("Fetch Error:", err);
        if (alive) { setError(`Couldn't load the requests: ${err instanceof Error ? err.message : String(err)}`); setLoading(false); setRefreshing(false); }
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
    const activeTickets = tickets.filter(t => t.status !== 'CLOSED'); 
    
    const myActionItems = tickets.filter(t => isActionRequired(t)).length;
    let slot2Count = 0;
    let slot3Count = 0;
    let slot4Count = 0;

    if (activeRole === 'Drafter') {
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
      slot2Count = activeTickets.filter(t => t.status === 'PENDING_ENG_INITIAL').length;
      slot3Count = activeTickets.filter(t => t.status === 'PENDING_ASSIGNMENT').length; 
      slot4Count = activeTickets.filter(t => t.status === 'REVISION_REQ').length; 
    }
    else if (activeRole.includes('Engineer')) {
      slot2Count = activeTickets.filter(t => t.status === 'PENDING_ENG_TEAM').length; 
      slot3Count = activeTickets.filter(t => t.status === 'PENDING_REVIEW').length; 
      slot4Count = activeTickets.filter(t => t.status === 'PENDING_ENG_INITIAL').length; 
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
    if (['Admin', 'Manager', 'Supervisor', 'DraftingSupervisor'].includes(activeRole)) return { slot2: 'Pending Approval', slot3: 'Unassigned Pool', slot4: 'Revision Status' };
    if (activeRole === 'DocCtrl') return { slot2: 'Ready to Issue', slot3: 'Pending Closure', slot4: 'Total Archives' };
    return { slot2: 'Team Queue', slot3: 'Drawing Review', slot4: 'New Requests' }; 
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
      review: count(g.tickets, (t) => ['PENDING_REVIEW', 'PENDING_FINAL_APPROVAL', 'PENDING_ENG_INITIAL', 'PENDING_ENG_TEAM', 'PENDING_ASSIGNMENT'].includes(t.status)),
      actionable: count(g.tickets, (t) => isActionRequired(t)),
      overdue: count(g.tickets, (t) => !!t.targetCompletionAt && new Date(t.targetCompletionAt as string) < new Date()),
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
    if (!(await appConfirm({ message: `Close ${selectedTicketIds.size} request${selectedTicketIds.size === 1 ? '' : 's'}?`, tone: 'danger', confirmLabel: 'Close them' }))) return;

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
      await appAlert({ message: `Not all of them were closed: ${error instanceof Error ? error.message : String(error)}`, tone: 'danger' });
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
      if (failed > 0) throw new Error(`${failed} of ${results.length} weren't marked urgent: ${results.find((r) => r.error)?.error?.message ?? ''}`);

      await logAuditAction({
        action: 'TICKET_BULK_URGENT', resourceId: 'bulk', resourceType: 'ticket',
        orgId: activeOrgId || undefined, userId: uid || 'unknown', userRole: activeRole,
        details: { count: selectedTicketIds.size, ticketIds: Array.from(selectedTicketIds) }
      });

      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error("Bulk Update Failed:", error);
      await appAlert({ title: "Not all marked urgent", message: error instanceof Error ? error.message : "Couldn't mark them urgent.", tone: 'danger' });
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
      setOpenRowMenu(null);
    } catch (error) {
      console.error("Mark urgent failed:", error);
      await appAlert({ message: `Couldn't mark it urgent: ${error instanceof Error ? error.message : String(error)}`, tone: 'danger' });
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
  };

  if (loading && tickets.length === 0 && !error) {
    return (
      <PageShell width="full">
        <div className="mx-auto max-w-[1920px]">
          <PageHero kicker="Drafting requests" title="Drafting requests" />
          <PageBody>
            <Card><LoadingBlock what="drafting requests" rows={6} className="border-0 p-0" /></Card>
          </PageBody>
        </div>
      </PageShell>
    );
  }

  if (!activeOrgId) {
    return (
      <PageShell width="form">
        <PageHero kicker="Drafting requests" title="Pick a workspace." />
        <PageBody>
          <Card>
            <p className="text-[14px] text-[var(--color-text-muted)]">Choose a workspace in the sidebar to see its drafting requests.</p>
          </Card>
        </PageBody>
      </PageShell>
    );
  }

  // The page's answer: how many are open, and how many wait on you.
  const openN = metrics.activeQueue;
  const answer = openN === 0
    ? (metrics.totalVolume === 0 ? 'No requests yet.' : 'No open requests.')
    : `${openN} open request${openN === 1 ? '' : 's'}${metrics.myActionItems > 0 ? `, ${metrics.myActionItems} waiting on you.` : '.'}`;
  // Controls on the dark band.
  const bandField = 'h-10 rounded-[10px] border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-[13px] font-semibold text-[var(--color-ink-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]';
  const bandToggle = (on: boolean) => `inline-flex items-center gap-1.5 h-10 px-3 rounded-[10px] border text-[13px] font-semibold transition-colors ${on ? 'bg-white text-[var(--color-ink)] border-white' : 'border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-[var(--color-ink-fg)] hover:bg-[var(--color-ink-line)]'}`;
  const chipOff = 'border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-[var(--color-ink-text)]';

  return (
    <PageShell width="full">
      <div className="mx-auto max-w-[1920px]">
      <PageHero
        kicker="Drafting requests"
        title={answer}
        sub={metrics.myActionItems > 0
          ? <button type="button" onClick={() => setFilters({ ...filters, assignedTo: 'action', status: 'ALL' })} className="font-semibold text-white underline underline-offset-4 decoration-[var(--color-ink-line)] hover:decoration-white">Show only what waits on you</button>
          : openN > 0 ? 'Nothing waiting on you.' : metrics.totalVolume > 0 ? `${metrics.totalVolume} in all, every one closed.` : 'New requests show up here.'}
        tools={
          <MoreMenu iconOnly label="More: refresh, export" triggerClass={heroQuiet} items={[
            { icon: <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />, label: refreshing ? "Refreshing…" : "Refresh", onClick: handleRefresh },
            { icon: <Download className="w-4 h-4" />, label: "Export to CSV", onClick: handleExportCSV },
          ]} />
        }
        primary={<Link href="/requests/new" className={heroPrimary}><Plus className="w-4 h-4" /> New request</Link>}
      >
        <div className="space-y-3">
          <div className="flex flex-col xl:flex-row gap-2">
            <div className="relative flex-1 min-w-0 xl:min-w-[300px]">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-ink-muted)]" />
              <label htmlFor="req-search" className="sr-only">Search requests</label>
              <input id="req-search" type="search" placeholder="Search by ID, requester, drafter or words" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                className="w-full h-11 pl-10 pr-4 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-[15px] text-white placeholder:text-[var(--color-ink-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]" />
            </div>
            {/* On a phone the controls run in one line that scrolls sideways (cut off at the edge, so it's plain there are more). */}
            <div className="flex gap-2 items-center sm:flex-wrap max-sm:overflow-x-auto max-sm:-mx-5 max-sm:px-5 max-sm:pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
              <div className="h-10 inline-flex items-center gap-0.5 p-1 rounded-[10px] border border-[var(--color-ink-line)] bg-[var(--color-ink-2)]" role="group" aria-label="View">
                {isSupervisorView && (
                  <button onClick={() => pickView('team')} title="By drafter" aria-label="By drafter" aria-pressed={viewMode === 'team'} className={`h-8 w-8 grid place-items-center rounded-lg transition-colors ${viewMode === 'team' ? 'bg-[var(--color-ink-line)] text-white' : 'text-[var(--color-ink-muted)] hover:text-white'}`}><Users className="w-4 h-4" /></button>
                )}
                <button onClick={() => pickView('table')} title="Table" aria-label="Table" aria-pressed={viewMode === 'table'} className={`h-8 w-8 grid place-items-center rounded-lg transition-colors ${viewMode === 'table' ? 'bg-[var(--color-ink-line)] text-white' : 'text-[var(--color-ink-muted)] hover:text-white'}`}><ListIcon className="w-4 h-4" /></button>
                <button onClick={() => pickView('grid')} title="Cards" aria-label="Cards" aria-pressed={viewMode === 'grid'} className={`h-8 w-8 grid place-items-center rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-[var(--color-ink-line)] text-white' : 'text-[var(--color-ink-muted)] hover:text-white'}`}><LayoutGrid className="w-4 h-4" /></button>
              </div>
              <div className="relative">
                <select aria-label="Assignee" value={filters.assignedTo} onChange={(e) => setFilters({ ...filters, assignedTo: e.target.value as FilterConfig['assignedTo'] })} className={`${bandField} appearance-none pl-3 pr-8 w-40`}><option value="all">Assignee: All</option><option value="action">Waiting on me</option><option value="me">Mine</option><option value="unassigned">Unassigned only</option></select>
                <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-ink-muted)]" />
              </div>
              <div className="relative">
                <select aria-label="Status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as FilterConfig['status'] })} className={`${bandField} appearance-none pl-3 pr-8 w-40`}><option value="ALL">Status: Any</option><option value="PENDING_ASSIGNMENT">Pending Assignment</option><option value="DRAFTING">In Drafting</option><option value="PENDING_REVIEW">In Review</option><option value="REVISION_REQ">Revisions Required</option><option value="PENDING_IFC">Ready for IFC</option><option value="FINAL_DRAFT">Finalized</option><option value="CLOSED">Closed</option></select>
                <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-ink-muted)]" />
              </div>
              <button onClick={() => setIsFilterPanelOpen(!isFilterPanelOpen)} aria-expanded={isFilterPanelOpen} className={bandToggle(isFilterPanelOpen)}><SlidersHorizontal className="w-4 h-4" />More filters</button>
              <button onClick={() => setShowClosed((v) => !v)} className={bandToggle(showClosed)} aria-pressed={showClosed}>
                {showClosed ? 'Hide closed' : 'Show closed'}
              </button>
            </div>
          </div>
          {/* The counts, each a filter where it can be one. */}
          <div className="flex gap-2 text-[13px] sm:flex-wrap max-sm:overflow-x-auto max-sm:-mx-5 max-sm:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 [&>*]:whitespace-nowrap">
            {([
              { label: cardLabels.slot2, n: metrics.slot2Count },
              { label: cardLabels.slot3, n: metrics.slot3Count },
              { label: cardLabels.slot4, n: metrics.slot4Count },
              { label: "IFC ready", n: metrics.readyForIFC, on: () => setFilters({ ...filters, status: 'PENDING_IFC' }) },
              { label: "No activity in 7 days", n: metrics.staleTickets },
            ] as Array<{ label: string; n: number; on?: () => void }>).map((c) => {
              const body = <><span className="font-bold text-white tabular-nums">{c.n}</span> <span>{c.label}</span></>;
              return c.on
                ? <button key={c.label} type="button" onClick={c.on} className={`h-8 px-3 rounded-full border ${chipOff} hover:text-white hover:bg-[var(--color-ink-line)] cursor-pointer`}>{body}</button>
                : <span key={c.label} className={`h-8 px-3 inline-flex items-center gap-1 rounded-full border ${chipOff}`}>{body}</span>;
            })}
          </div>
        </div>
      </PageHero>

      <PageBody>
        {/* BULK ACTIONS */}
        {selectedTicketIds.size > 0 && (
          <Card className="flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-2">
            <span className="text-[14px] font-bold text-[var(--color-text)]">{selectedTicketIds.size} selected</span>
            <div className="flex items-center gap-2">
              <button onClick={handleBulkUrgencyToggle} className="inline-flex items-center gap-1.5 h-9 px-3 border border-[var(--color-border-strong)] text-[var(--color-text)] rounded-lg text-[13px] font-bold hover:bg-[var(--color-surface-2)]" disabled={processingBulk}><Zap className="w-4 h-4" /> Mark urgent</button>
              <button onClick={handleBulkArchive} className="inline-flex items-center gap-1.5 h-9 px-3 border border-[var(--color-border-strong)] text-[var(--color-text)] rounded-lg text-[13px] font-bold hover:bg-[var(--color-surface-2)]" disabled={processingBulk}><Archive className="w-4 h-4" /> Close</button>
              <button onClick={() => setSelectedTicketIds(new Set())} aria-label="Clear selection" title="Clear selection" className="p-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
            </div>
          </Card>
        )}

        {/* MORE FILTERS */}
        {isFilterPanelOpen && (
          <Card label="More filters" className="animate-in fade-in slide-in-from-top-2">
           <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
             <div>
               <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] mb-2">Request type</div>
               <div className="flex flex-wrap gap-2">
                 <button 
                   onClick={() => setFilters({...filters, type: 'ALL'})} 
                   className={`px-3 h-8 rounded-full text-[12.5px] font-semibold border transition-colors ${filters.type === 'ALL' ? 'bg-[var(--color-text)] text-[var(--color-surface)] border-[var(--color-text)]' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}
                 >
                   All
                 </button>
                 {requestTypeOptions.length > 0 ? requestTypeOptions.map(opt => (
                   <button 
                     key={String(opt.value)} 
                     onClick={() => setFilters({...filters, type: String(opt.value)})} 
                     className={`px-3 h-8 rounded-full text-[12.5px] font-semibold border transition-colors ${filters.type === String(opt.value) ? 'bg-[var(--color-text)] text-[var(--color-surface)] border-[var(--color-text)]' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}
                   >
                     {opt.label}
                   </button>
                 )) : (
                   // Fallback defaults if config not loaded
                   ['RFI', 'INSPECTION', 'ISO', 'MOC', 'ASBUILT'].map(type => (
                     <button key={type} onClick={() => setFilters({...filters, type})} className={`px-3 h-8 rounded-full text-[12.5px] font-semibold border transition-colors ${filters.type === type ? 'bg-[var(--color-text)] text-[var(--color-surface)] border-[var(--color-text)]' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}>{type}</button>
                   ))
                 )}
               </div>
             </div>
             <div><div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] mb-2">Timeframe</div><div className="flex flex-wrap gap-2">{['all', 'today', 'week', 'month'].map(range => (<button key={range} onClick={() => setFilters({...filters, dateRange: range as FilterConfig['dateRange']})} className={`px-3 h-8 rounded-full text-[12.5px] font-semibold border transition-colors ${filters.dateRange === range ? 'bg-[var(--color-text)] text-[var(--color-surface)] border-[var(--color-text)]' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}>{range.charAt(0).toUpperCase() + range.slice(1)}</button>))}</div></div>
             <div><div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] mb-2">Urgency</div><div className="flex items-center gap-2 h-8"><input type="checkbox" id="urgentOnly" checked={filters.priority === 'urgent'} onChange={(e) => setFilters({...filters, priority: e.target.checked ? 'urgent' : 'all'})} className="w-4 h-4 text-[var(--color-text)] border-[var(--color-border-strong)] rounded focus:ring-[var(--color-accent-ring)]" /><label htmlFor="urgentOnly" className="text-[14px] text-[var(--color-text)] cursor-pointer">Urgent and RFI only</label></div></div>
             <div className="flex items-end md:justify-end"><button onClick={clearAllFilters} className="flex items-center text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] font-bold transition-all"><FilterX className="w-4 h-4 mr-2" />Reset filters</button></div>
           </div>
          </Card>
        )}

        {/* CONTENT: a load problem sits on the list it is about. */}
        {error && (
          <Card>
            <p role="alert" className="text-[14px] font-semibold text-red-700 dark:text-red-400">
              The requests didn&apos;t load: {error} <button type="button" onClick={handleRefresh} className="font-bold underline">Try again</button>
            </p>
          </Card>
        )}

        {viewMode === 'team' ? (
          /* VIEW: BY-DRAFTER SUPERVISOR BOARD */
          teamBoard.length === 0 ? (
            <Card className="py-16 text-center">
              <Users className="w-6 h-6 mx-auto mb-3 text-[var(--color-text-faint)]" />
              <h3 className="text-[15px] font-bold text-[var(--color-text)]">No open work</h3>
              <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">Nothing is assigned or waiting right now.</p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 items-start">
              {teamBoard.map((b) => {
                const isPool = b.id === null;
                return (
                  <section key={b.id || 'pool'} className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] flex flex-col overflow-hidden">
                    <header className="px-4 py-3 border-b border-[var(--color-border)]">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {isPool ? (
                            <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-xs font-black bg-[var(--color-surface-2)] text-[var(--color-text)]">
                              <Inbox className="w-4 h-4" />
                            </div>
                          ) : (
                            <UserAvatar uid={b.id} name={b.name} size={36} rounded="full" />
                          )}
                          <div className="min-w-0">
                            <div className="text-[14px] font-bold text-[var(--color-text)] truncate">{b.name}</div>
                            <div className="text-[12px] text-[var(--color-text-muted)]">{b.total - b.closed} active{b.closed > 0 ? ` · ${b.closed} closed` : ''}{b.actionable > 0 ? ` · ${b.actionable} need action` : ''}</div>
                          </div>
                        </div>
                        {b.actionable > 0 && (
                          <span title={`${b.actionable} need action`} className="shrink-0 inline-flex items-center gap-1 bg-red-600 text-white text-[11px] font-black px-2 py-0.5 rounded-full">{badgeText(b.actionable)}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {b.drafting > 0 && <StageChip className="bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" label="Drafting" n={b.drafting} />}
                        {b.revision > 0 && <StageChip className="bg-amber-50 text-amber-700 border-amber-200" label="Revisions" n={b.revision} />}
                        {b.awaitingIfc > 0 && <StageChip className="bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" label="Awaiting IFC" n={b.awaitingIfc} />}
                        {b.review > 0 && <StageChip className="bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" label="In review" n={b.review} />}
                        {b.overdue > 0 && <StageChip className="bg-red-50 text-red-700 border-red-200" label="Overdue" n={b.overdue} />}
                        {b.closed > 0 && <StageChip className="bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" label="Closed" n={b.closed} />}
                      </div>
                    </header>
                    <div className="px-2 py-1 divide-y divide-[var(--color-border)] max-h-[60vh] overflow-y-auto">
                      {b.tickets.map((t) => {
                        const actionNeeded = isActionRequired(t);
                        const due = t.targetCompletionAt ? new Date(t.targetCompletionAt as string) : null;
                        const overdue = !!due && due < new Date();
                        return (
                          <Link key={t.id} href={`/requests/${t.id}`} className="block">
                            <div className="group rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--color-surface-2)]">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {actionNeeded && <span className="shrink-0 w-2 h-2 rounded-full bg-red-500" title="Action needed" />}
                                  <span className="font-mono text-[12px] font-bold text-[var(--color-text)] truncate">{t.ticketId}</span>
                                </div>
                                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold uppercase border ${getStatusColor(t.status)}`}>{t.status.replace(/_/g, ' ')}</span>
                              </div>
                              <div className="text-[13.5px] text-[var(--color-text)] mt-0.5 line-clamp-1">{t.title}</div>
                              <div className="flex items-center gap-3 mt-1 text-[12px] text-[var(--color-text-muted)]">
                                <span className="font-mono">{t.unit}</span>
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
        ) : paginatedTickets.length === 0 ? (
          error ? null : (
          <Card className="py-16 text-center">
            <Search className="w-6 h-6 mx-auto mb-3 text-[var(--color-text-faint)]" />
            <h3 className="text-[15px] font-bold text-[var(--color-text)]">{tickets.length === 0 ? "No requests yet" : "Nothing matches"}</h3>
            <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">{tickets.length === 0 ? "New requests show up here." : "Try fewer filters or other words."}</p>
            {tickets.length > 0 && <button onClick={clearAllFilters} className="mt-4 h-10 border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] px-5 rounded-lg text-[14px] font-bold hover:bg-[var(--color-surface-2)] transition-colors">Clear filters</button>}
          </Card>
          )
        ) : (
          <>
            {/* VIEW: TABLE MODE */}
            {viewMode === 'table' && (
              <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-[var(--color-border)]">
                    <thead>
                      <tr>
                        <th className="w-12 px-4 sm:px-5 py-3"><input type="checkbox" checked={selectedTicketIds.size === paginatedTickets.length && paginatedTickets.length > 0} onChange={handleSelectAll} className="rounded border-[var(--color-border-strong)] text-[var(--color-text)] focus:ring-[var(--color-accent-ring)] w-4 h-4 cursor-pointer" /></th>
                        {[{ id: 'ticketId', label: 'Request ID' }, { id: 'status', label: 'Status' }, { id: 'title', label: 'Details' }, { id: 'unit', label: 'Unit' }, { id: 'priority', label: 'Priority' }, { id: 'lastModified', label: 'Last Activity' }].map((col) => (
                          <th key={col.id} className="px-4 py-3 text-left text-[11px] font-extrabold text-[var(--color-text-muted)] uppercase tracking-[0.12em] cursor-pointer hover:text-[var(--color-text)] transition-colors group" onClick={() => handleSort(col.id as SortField)}><div className="flex items-center space-x-1"><span>{col.label}</span><ArrowUpDown className={`w-3 h-3 ${sortConfig.field === col.id ? 'text-[var(--color-text)]' : 'text-[var(--color-text-faint)]'}`} /></div></th>
                        ))}
                        <th className="px-4 sm:px-5 py-3 text-right text-[11px] font-extrabold text-[var(--color-text-muted)] uppercase tracking-[0.12em]"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody className="bg-[var(--color-surface)] divide-y divide-[var(--color-border)]">
                      {paginatedTickets.map((ticket) => {
                         const daysOpen = calculateDaysOpen(ticket.createdAt);
                         const isStale = daysOpen > 14 && ticket.status !== 'CLOSED';
                         const isUrgent = ticket.status === 'REVISION_REQ' || ticket.requestType === 'RFI' || ticket.priority === 1;
                         const isSelected = selectedTicketIds.has(ticket.id!);
                         const isUnread = ticket.unreadBy?.includes(uid || '');
                         const isActionNeeded = isActionRequired(ticket); // Use Helper

                         return (
                          <tr key={ticket.id} className={`transition-colors group ${isSelected ? 'bg-[var(--color-surface-2)]' : 'hover:bg-[var(--color-surface-2)]'}`}>
                            <td className="px-4 sm:px-5 py-3"><input type="checkbox" checked={isSelected} onChange={() => toggleTicketSelection(ticket.id!)} className="rounded border-[var(--color-border-strong)] text-[var(--color-text)] focus:ring-[var(--color-accent-ring)] w-4 h-4 cursor-pointer" /></td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="flex flex-col">
                                <div className="flex items-center">
                                  {/* DUAL BADGE LOGIC: Show Action OR Unread OR Both if room permits */}
                                  {isActionNeeded && <div className="w-2.5 h-2.5 bg-red-500 rounded-full mr-2" title="Action Required" />}
                                  {!isActionNeeded && isUnread && <div className="w-2.5 h-2.5 bg-[var(--color-text-muted)] rounded-full mr-2" title="New Updates" />}
                                  <Link href={`/requests/${ticket.id}`} className={`text-sm ${isUnread || isActionNeeded ? 'font-black text-[var(--color-text)]' : 'font-bold text-[var(--color-text)]'} hover:text-[var(--color-accent-hover)] hover:underline`}>{ticket.ticketId}</Link>
                                </div>
                                <span className="text-[11px] text-[var(--color-text-faint)] mt-0.5 font-mono">{ticket.requestType}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap"><span className={`inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase border ${getStatusColor(ticket.status)}`}>{ticket.status.replace(/_/g, ' ')}</span>{ticket.archivedAt && <span className="ml-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase border border-[var(--color-border)] text-[var(--color-text)] bg-[var(--color-surface-2)]" title="Content archived for space - restore from the saved archive to view">Archived</span>}</td>
                            <td className="px-4 py-3"><div className="flex flex-col max-w-md"><span className={`text-sm ${isUnread ? 'font-bold text-[var(--color-text)]' : 'font-medium text-[var(--color-text)]'} truncate`}>{ticket.title}</span><div className="flex items-center mt-1 text-xs text-[var(--color-text-muted)]"><User className="w-3 h-3 mr-1" /><span className="mr-3">{ticket.requesterName}</span>{ticket.assignedDrafterName && (<><ArrowRight className="w-3 h-3 mr-1 text-[var(--color-text-faint)]" /><span className="font-semibold text-[var(--color-text)]">{ticket.assignedDrafterName}</span></>)}</div></div></td>
                            <td className="px-4 py-3 whitespace-nowrap"><span className="text-[13px] font-mono text-[var(--color-text-muted)]">{ticket.unit}</span></td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              {typeof ticket.priority === 'number' ? (
                                <div className={`flex items-center px-2 py-1 rounded border text-xs font-bold w-fit 
                                  ${ticket.priority === 1 ? 'text-red-600 bg-red-50 border-red-100' : 
                                    ticket.priority === 2 ? 'text-[var(--color-text)] bg-[var(--color-surface-2)] border-[var(--color-border)]' :
                                    ticket.priority === 3 ? 'text-[var(--color-text)] bg-[var(--color-surface-2)] border-[var(--color-border)]' :
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
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="flex flex-col text-xs">
                                <span className="font-medium text-[var(--color-text)]">{toDate(ticket.lastModified).toLocaleDateString()}</span>
                                {ticket.targetCompletionAt && (() => {
                                  const due = new Date(ticket.targetCompletionAt as string);
                                  const past = due < new Date() && ticket.status !== 'CLOSED' && ticket.status !== 'CANCELED';
                                  const soon = !past && due.getTime() - Date.now() < 24 * 60 * 60 * 1000 && ticket.status !== 'CLOSED' && ticket.status !== 'CANCELED';
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
                            
                            <td className="px-4 sm:px-5 py-3 whitespace-nowrap text-right text-sm font-medium relative">
                              <div className="flex items-center justify-end space-x-2">
                                {/* NEW COMMENT BADGE FOR TABLE */}
                                {(ticket.comments?.length || 0) > 0 && (
                                  <div className={`flex items-center px-1.5 py-0.5 rounded text-[11px] font-bold mr-2 ${isUnread ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]' : 'text-[var(--color-text-faint)]'}`}>
                                    <MessageCircle className="w-3 h-3 mr-1" /> {ticket.comments?.length}
                                  </div>
                                )}
                                <Link href={`/requests/${ticket.id}`} className="text-[var(--color-text-faint)] hover:text-[var(--color-text)] transition-colors p-2 hover:bg-[var(--color-surface-2)] rounded-full" title="Open" aria-label={`Open ${ticket.ticketId}`}><Eye className="w-4 h-4" /></Link>
                                
                                <div className="relative">
                                  <button onClick={() => setOpenRowMenu(openRowMenu === ticket.id ? null : ticket.id!)} aria-label="More" aria-haspopup="menu" aria-expanded={openRowMenu === ticket.id} className="text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] transition-colors p-2 hover:bg-[var(--color-surface-2)] rounded-full"><MoreVertical className="w-4 h-4" /></button>
                                  {openRowMenu === ticket.id && (
                                    <>
                                      <div className="fixed inset-0 z-40" onClick={() => setOpenRowMenu(null)}></div>
                                      <div className="absolute right-0 mt-2 w-48 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg z-50 origin-top-right animate-in fade-in zoom-in-95 duration-150">
                                        <div className="py-1">
                                          <button onClick={() => handleQuickMarkUrgent(ticket.id!)} className="flex w-full items-center px-4 py-2 text-xs text-amber-600 hover:bg-amber-50 font-bold"><AlertCircle className="w-3 h-3 mr-2" /> Mark urgent</button>
                                          {['Manager', 'Admin'].includes(activeRole) && (<button onClick={() => handleQuickForceClose(ticket.id!)} className="flex w-full items-center px-4 py-2 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] font-medium"><Trash2 className="w-3 h-3 mr-2" /> Force close</button>)}
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
                <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] flex items-center justify-between gap-3">
                  <div className="flex flex-col md:flex-row md:items-center text-[13px] text-[var(--color-text-muted)]"><span className="mr-4">Showing <span className="font-bold text-[var(--color-text)]">{(currentPage - 1) * itemsPerPage + 1}</span> to <span className="font-bold text-[var(--color-text)]">{Math.min(currentPage * itemsPerPage, filteredTickets.length)}</span> of <span className="font-bold text-[var(--color-text)]">{filteredTickets.length}</span> results</span><select value={itemsPerPage} onChange={(e) => setItemsPerPage(Number(e.target.value))} className="mt-2 md:mt-0 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-xs py-1 px-2 focus:ring-[var(--color-accent-ring)] focus:border-[var(--color-accent)] cursor-pointer"><option value={10}>10 per page</option><option value={25}>25 per page</option><option value={50}>50 per page</option><option value={100}>100 per page</option></select></div>
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
                    <div key={ticket.id} className={`group bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] p-5 flex flex-col ${isUrgent ? 'border-l-2 border-l-red-500' : ''}`}>
                      {(isActionNeeded || commentCount > 0) && (
                        <div className="flex flex-wrap items-center gap-1.5 mb-2">
                          {isActionNeeded && (
                            <span className="inline-flex items-center text-red-700 dark:text-red-400 text-[11px] font-bold">
                              <MousePointerClick className="w-3 h-3 mr-1" /> Waiting on you
                            </span>
                          )}
                          {commentCount > 0 && (
                            <span className={`inline-flex items-center text-[11px] font-bold ${isUnread ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>
                              <MessageCircle className="w-3 h-3 mr-1" /> {commentCount}{isUnread ? ' new' : ''}
                            </span>
                          )}
                        </div>
                      )}

                      <div className="flex justify-between items-start mb-4"><div className="flex flex-col"><span className="font-mono text-xs font-bold text-[var(--color-text-faint)]">{ticket.ticketId}</span><span className="text-[11px] font-bold text-[var(--color-text-faint)] mt-0.5 uppercase tracking-wide">{ticket.requestType}</span></div><div className="flex flex-col items-end gap-1"><span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase border ${getStatusColor(ticket.status)}`}>{ticket.status.replace(/_/g, ' ')}</span>{ticket.archivedAt && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase border border-[var(--color-border)] text-[var(--color-text)] bg-[var(--color-surface-2)]" title="Content archived for space - restore from the saved archive to view">Archived</span>}</div></div>
                      <Link href={`/requests/${ticket.id}`} className="block mb-4"><h3 className={`text-[15px] leading-snug line-clamp-2 ${isUnread ? 'font-extrabold text-[var(--color-text)]' : 'font-bold text-[var(--color-text)]'}`}>{ticket.title}</h3></Link>
                      <div className="flex items-center text-[13px] text-[var(--color-text-muted)] mb-5"><span className="font-mono font-semibold text-[var(--color-text)] mr-2">{ticket.unit}</span><User className="w-3 h-3 mr-1" /><span className="truncate flex-1">{ticket.requesterName}</span></div>
                      <div className="mt-auto pt-4 border-t border-[var(--color-border)] flex items-center justify-between"><div className="flex flex-col"><span className="text-[11px] font-bold text-[var(--color-text-faint)] uppercase">Assigned To</span><span className="text-xs font-semibold text-[var(--color-text)]">{ticket.assignedDrafterName || 'Unassigned'}</span></div><Link href={`/requests/${ticket.id}`} aria-label={`Open ${ticket.ticketId}`} className="h-8 w-8 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-muted)] flex items-center justify-center group-hover:text-[var(--color-text)] transition-colors"><ArrowRight className="w-4 h-4" /></Link></div>
                    </div>
                   );
                })}
              </div>
            )}
          </>
        )}
      </PageBody>
      </div>
    </PageShell>
  );
}
