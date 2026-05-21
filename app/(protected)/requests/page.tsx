"use client";

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  orderBy, 
  Timestamp, 
  doc, 
  updateDoc,
  writeBatch,
  getDoc
} from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket, TicketStatus, RequestType, OrgDraftingSettings, SelectOption } from '@/types/schema';
import { logAuditAction } from '@/lib/audit';
import { 
  Search,  
  Plus, 
  Clock, 
  AlertCircle, 
  CheckCircle2, 
  ArrowRight,
  Loader2,
  LayoutGrid,
  List as ListIcon,
  MoreVertical,
  Download,
  RefreshCw,
  ChevronDown,
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
  MoreHorizontal,
  Shield,
  Zap,
  FilterX,
  Inbox,
  FileCheck,
  MousePointerClick,
} from 'lucide-react';

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

interface ChartData {
  label: string;
  value: number;
  color: string;
}

// =========================================================================================
// SECTION 2: UTILITY FUNCTIONS
// =========================================================================================

const toDate = (date: any): Date => {
  if (!date) return new Date();
  if (typeof date.toDate === 'function') return date.toDate();
  if (date instanceof Date) return date;
  if (typeof date === 'string') return new Date(date);
  if (date.seconds) return new Date(date.seconds * 1000);
  return new Date(date); 
};

const calculateDaysOpen = (date: any) => {
  const start = toDate(date);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - start.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
};

const getStatusColor = (status: TicketStatus): string => {
  switch (status) {
    case 'NEW': return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'PENDING_ENG_INITIAL': return 'bg-indigo-50 text-indigo-700 border-indigo-200';
    case 'PENDING_ENG_TEAM': return 'bg-indigo-50 text-indigo-700 border-indigo-200';
    case 'PENDING_ASSIGNMENT': return 'bg-purple-50 text-purple-700 border-purple-200 animate-pulse'; 
    case 'DRAFTING': return 'bg-blue-50 text-blue-700 border-blue-200'; 
    case 'PENDING_REVIEW': return 'bg-yellow-50 text-yellow-700 border-yellow-200';
    case 'REVISION_REQ': return 'bg-amber-50 text-amber-700 border-amber-200 font-bold'; 
    case 'PENDING_IFC': return 'bg-teal-50 text-teal-700 border-teal-200';
    case 'FINAL_DRAFT': return 'bg-slate-100 text-slate-700 border-slate-200';
    case 'PENDING_FINAL_APPROVAL': return 'bg-lime-50 text-lime-700 border-lime-200';
    case 'CLOSED': return 'bg-gray-100 text-gray-500 border-gray-200 decoration-slate-400';
    default: return 'bg-white text-gray-900 border-gray-200';
  }
};

const getPriorityColor = (isUrgent: boolean, type: string) => {
  if (type === 'RFI') return 'text-pink-600 bg-pink-50 border-pink-100'; 
  if (isUrgent) return 'text-amber-600 bg-amber-50 border-amber-100'; 
  return 'text-slate-500 bg-slate-50 border-slate-100'; 
};

// =========================================================================================
// SECTION 4: MAIN COMPONENT - REQUEST PORTAL
// =========================================================================================

export default function RequestPortal() {
  const router = useRouter();
  const { activeRole, activeOrgId } = useRole();
  
  // --- STATE ---
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [processingBulk, setProcessingBulk] = useState<boolean>(false);
  const [requestTypeOptions, setRequestTypeOptions] = useState<SelectOption[]>([]);

  // --- STATE: VIEW & UI ---
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');
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
        const ref = doc(db, 'orgs', activeOrgId, 'configurations', 'drafting');
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const data = snap.data() as OrgDraftingSettings;
          if (data.requestTypes?.options) {
             setRequestTypeOptions(data.requestTypes.options);
          }
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
  const isActionRequired = useCallback((ticket: Ticket) => {
     const currentUser = auth.currentUser;
     const uid = currentUser?.uid;
     if (!uid) return false;

     if (ticket.assignedDrafterId === uid) {
        if (['DRAFTING', 'REVISION_REQ', 'PENDING_IFC'].includes(ticket.status)) return true;
     }

     if (ticket.requesterId === uid) {
        if (['PENDING_REVIEW', 'FINAL_DRAFT'].includes(ticket.status)) return true;
     }
     
     if (activeRole === 'Drafter') {
        if (ticket.status === 'PENDING_ASSIGNMENT') return true; 
     }

     if (['Admin', 'Manager', 'Supervisor'].includes(activeRole)) {
        if (ticket.status === 'PENDING_ASSIGNMENT') return true; 
        if (ticket.status === 'PENDING_ENG_INITIAL') return true; 
        if (ticket.status === 'PENDING_REVIEW') return true; 
        if (ticket.status === 'PENDING_FINAL_APPROVAL') return true; 
     }

     if (activeRole.includes('Engineer')) {
        if (['PENDING_ENG_INITIAL', 'PENDING_ENG_TEAM', 'PENDING_REVIEW'].includes(ticket.status)) return true;
     }

     if (activeRole === 'DocCtrl') {
        if (['FINAL_DRAFT', 'PENDING_IFC'].includes(ticket.status)) return true;
     }

     return false;
  }, [activeRole]);


  // --------------------------------------------------------------------
  // EFFECT: DATA SYNC ENGINE
  // --------------------------------------------------------------------
  useEffect(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) return;
    if (!activeOrgId) {
      setTickets([]);
      setLoading(false);
      return;
    }

    let unsubscribe: () => void;

    const fetchTickets = async () => {
      try {
        setLoading(true);
        const ticketsRef = collection(db, 'tickets');
        let q;

        if (['Admin', 'Manager', 'Supervisor', 'DocCtrl'].includes(activeRole) || activeRole.includes('Engineer')) {
          q = query(
            ticketsRef,
            where('orgId', '==', activeOrgId),
            orderBy('lastModified', 'desc')
          );

          unsubscribe = onSnapshot(q, (snapshot) => {
            const fetchedTickets: Ticket[] = [];
            snapshot.forEach((doc) => {
              fetchedTickets.push({ id: doc.id, ...doc.data() } as Ticket);
            });
            setTickets(fetchedTickets);
            setLoading(false);
            setRefreshing(false);
          }, (err) => {
             console.error("Firestore Listen Error:", err);
             setError("Access Restricted: Synchronizing allowed tickets only.");
             setLoading(false);
          });
        } 
        else if (activeRole === 'Drafter') {
          const assignedMap = new Map<string, Ticket>();
          const poolMap = new Map<string, Ticket>();

          const updateDrafterView = () => {
             const merged = [...Array.from(assignedMap.values()), ...Array.from(poolMap.values())];
             const unique = Array.from(new Map(merged.map(item => [item.id, item])).values());
             unique.sort((a, b) => {
                const dateA = a.lastModified ? toDate(a.lastModified).getTime() : 0;
                const dateB = b.lastModified ? toDate(b.lastModified).getTime() : 0;
                return dateB - dateA;
             });
             setTickets(unique);
             setLoading(false);
             setRefreshing(false);
          };

          const qAssigned = query(
            ticketsRef,
            where('orgId', '==', activeOrgId),
            where('assignedDrafterId', '==', currentUser.uid)
          );

          const unsub1 = onSnapshot(qAssigned, (snapshot) => {
             assignedMap.clear();
             snapshot.forEach(doc => assignedMap.set(doc.id, { id: doc.id, ...doc.data() } as Ticket));
             updateDrafterView();
          });

          const qPool = query(
             ticketsRef,
             where('orgId', '==', activeOrgId),
             where('status', '==', 'PENDING_ASSIGNMENT')
          );

          const unsub2 = onSnapshot(qPool, (snapshot) => {
             poolMap.clear();
             snapshot.forEach(doc => poolMap.set(doc.id, { id: doc.id, ...doc.data() } as Ticket));
             updateDrafterView();
          });

          unsubscribe = () => {
            unsub1();
            unsub2();
          };
        }
        else {
           q = query(
             ticketsRef,
             where('orgId', '==', activeOrgId),
             where('requesterId', '==', currentUser.uid),
             orderBy('lastModified', 'desc')
           );

           unsubscribe = onSnapshot(q, (snapshot) => {
            const fetchedTickets: Ticket[] = [];
            snapshot.forEach((doc) => {
              fetchedTickets.push({ id: doc.id, ...doc.data() } as Ticket);
            });
            setTickets(fetchedTickets);
            setLoading(false);
            setRefreshing(false);
          }, (err) => {
            console.error("Firestore Listen Error:", err);
            setLoading(false);
          });
        }


      } catch (err) {
        console.error("Setup Error:", err);
        setLoading(false);
      }
    };

    fetchTickets();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [activeRole, activeOrgId]);

  // --------------------------------------------------------------------
  // MEMO: ROLE-AWARE METRICS ENGINE
  // --------------------------------------------------------------------
  const metrics: DashboardMetrics = useMemo(() => {
    const currentUser = auth.currentUser;
    const uid = currentUser?.uid || '';

    const activeTickets = tickets.filter(t => t.status !== 'CLOSED'); 
    
    let myActionItems = tickets.filter(t => isActionRequired(t)).length;
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
    else if (['Manager', 'Admin', 'Supervisor'].includes(activeRole)) {
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
  }, [tickets, activeRole, isActionRequired]);

  const cardLabels = useMemo(() => {
    if (activeRole === 'Drafter') return { slot2: 'My Workload', slot3: 'Revisions Needed', slot4: 'Available to Claim' };
    if (activeRole === 'Requester') return { slot2: 'My Open Requests', slot3: 'Waiting on Review', slot4: 'Completed History' };
    if (['Admin', 'Manager', 'Supervisor'].includes(activeRole)) return { slot2: 'Pending Approval', slot3: 'Unassigned Pool', slot4: 'Revision Status' };
    if (activeRole === 'DocCtrl') return { slot2: 'Ready to Issue', slot3: 'Pending Closure', slot4: 'Total Archives' };
    return { slot2: 'Team Queue', slot3: 'Drawing Review', slot4: 'New Requests' }; 
  }, [activeRole]);

  // --------------------------------------------------------------------
  // MEMO: FILTERING & SORTING LOGIC
  // --------------------------------------------------------------------
  const filteredTickets = useMemo(() => {
    const currentUser = auth.currentUser;
    const uid = currentUser?.uid || '';
    
    return tickets.filter(ticket => {
      // Text Search
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const matches = 
          ticket.ticketId.toLowerCase().includes(q) ||
          ticket.title.toLowerCase().includes(q) ||
          (ticket.requesterName || '').toLowerCase().includes(q) ||
          (ticket.assignedDrafterName || '').toLowerCase().includes(q) ||
          ticket.unit.toLowerCase().includes(q);
        if (!matches) return false;
      }

      // Filters
      if (filters.status !== 'ALL' && ticket.status !== filters.status) return false;
      if (filters.type !== 'ALL' && ticket.requestType !== filters.type) return false;
      
      // Assignment Filter
      if (filters.assignedTo === 'me') {
        const isMyAssignment = ticket.assignedDrafterId === uid;
        const isMyRequest = ticket.requesterId === uid;
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

      let valA: any = fieldA;
      let valB: any = fieldB;

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
  }, [tickets, filters, sortConfig]);

  // --- PAGINATION ---
  const paginatedTickets = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    return filteredTickets.slice(start, end);
  }, [filteredTickets, currentPage, itemsPerPage]);

  const totalPages = Math.ceil(filteredTickets.length / itemsPerPage);

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
    setTimeout(() => setRefreshing(false), 800);
  };

  const handleBulkArchive = useCallback(async () => {
    if (selectedTicketIds.size === 0) return;
    if (!confirm(`Are you sure you want to archive ${selectedTicketIds.size} tickets?`)) return;

    setProcessingBulk(true);
    try {
      const batch = writeBatch(db);
      selectedTicketIds.forEach(id => {
        const docRef = doc(db, 'tickets', id);
        batch.update(docRef, { status: 'CLOSED', lastModified: Timestamp.now() });
      });
      await batch.commit();

      await logAuditAction({
        action: 'TICKET_BULK_ARCHIVE',
        resourceId: 'bulk',
        resourceType: 'ticket',
        orgId: activeOrgId || undefined,
        userId: auth.currentUser?.uid || 'unknown',
        userRole: activeRole,
        details: { count: selectedTicketIds.size, ticketIds: Array.from(selectedTicketIds) }
      });

      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error("Bulk Archive Failed:", error);
      alert("Failed to process bulk archive. Check permissions.");
    } finally {
      setProcessingBulk(false);
    }
  }, [selectedTicketIds]);

  const handleBulkUrgencyToggle = useCallback(async () => {
    if (selectedTicketIds.size === 0) return;
    setProcessingBulk(true);
    try {
      const batch = writeBatch(db);
      selectedTicketIds.forEach(id => {
        const docRef = doc(db, 'tickets', id);
        batch.update(docRef, { status: 'REVISION_REQ', lastModified: Timestamp.now() });
      });
      await batch.commit();

      await logAuditAction({
        action: 'TICKET_BULK_URGENT',
        resourceId: 'bulk',
        resourceType: 'ticket',
        orgId: activeOrgId || undefined,
        userId: auth.currentUser?.uid || 'unknown',
        userRole: activeRole,
        details: { count: selectedTicketIds.size, ticketIds: Array.from(selectedTicketIds) }
      });

      setSelectedTicketIds(new Set());
    } catch (error) {
      console.error("Bulk Update Failed:", error);
    } finally {
      setProcessingBulk(false);
    }
  }, [selectedTicketIds]);

  const handleQuickStatusUpdate = async (ticketId: string, newStatus: TicketStatus) => {
    try {
      await updateDoc(doc(db, 'tickets', ticketId), { status: newStatus, lastModified: Timestamp.now() });
      
      await logAuditAction({
        action: 'TICKET_QUICK_UPDATE',
        resourceId: ticketId,
        resourceType: 'ticket',
        orgId: activeOrgId || undefined,
        userId: auth.currentUser?.uid || 'unknown',
        userRole: activeRole,
        details: { newStatus: newStatus }
      });

      setOpenRowMenu(null);
    } catch (error) {
      console.error("Quick Update Failed:", error);
      alert("Failed to update status.");
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

  if (loading && tickets.length === 0) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-slate-50">
        <Loader2 className="w-12 h-12 text-orange-600 animate-spin mb-4" />
        <h2 className="text-xl font-bold text-slate-800">Loading Request Portal...</h2>
        <p className="text-slate-500">Synchronizing workflow states...</p>
        {error && <p className="text-red-500 text-sm font-bold mt-4 bg-red-50 px-4 py-2 rounded border border-red-200">{error}</p>}
      </div>
    );
  }

  if (!activeOrgId) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-3xl mx-auto bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow">
              <Layers className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-black text-slate-900">Workspace not selected</h2>
              <p className="text-sm text-slate-600 mt-2">
                Please select a workspace from the sidebar to view active workflows and tickets.
              </p>
              <p className="text-xs text-slate-500 mt-3">
                Tickets are isolated by organization to ensure data privacy.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      
      {/* 1. TOP METRICS DASHBOARD */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
            <div>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center">
                <Layers className="w-6 h-6 mr-3 text-orange-600" />
                Request Portal
              </h1>
              <p className="text-xs text-slate-500 mt-1 uppercase tracking-wide font-semibold">
                {activeRole} Console • {metrics.totalVolume} Total Records
              </p>
            </div>
            
            <div className="flex items-center space-x-3">
              <button onClick={handleRefresh} className={`p-2 rounded-lg bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-orange-600 transition-all ${refreshing ? 'animate-spin' : ''}`} title="Refresh Data">
                <RefreshCw className="w-5 h-5" />
              </button>
              <button onClick={handleExportCSV} className="flex items-center px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all">
                <Download className="w-4 h-4 mr-2 text-slate-400" />
                Export CSV
              </button>
              <Link href="/requests/new">
                <button className="flex items-center px-5 py-2 bg-orange-600 text-white rounded-lg text-sm font-bold shadow-lg shadow-orange-600/20 hover:bg-orange-700 hover:scale-105 transition-all">
                  <Plus className="w-5 h-5 mr-2" />
                  New Ticket
                </button>
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
            
            {/* SLOT 1: MY ACTION ITEMS */}
            <div 
              className={`border p-3 rounded-xl flex flex-col justify-between cursor-pointer transition-colors group relative overflow-hidden ${metrics.myActionItems > 0 ? 'bg-orange-50 border-orange-300 ring-2 ring-orange-500/20' : 'bg-slate-50 border-slate-200'}`}
              onClick={() => setFilters({ ...filters, assignedTo: 'me' })}
            >
              <div className="flex justify-between items-start z-10">
                <span className={`text-[10px] font-bold uppercase ${metrics.myActionItems > 0 ? 'text-orange-600' : 'text-slate-400'}`}>Action Required</span>
                <Zap className={`w-4 h-4 ${metrics.myActionItems > 0 ? 'text-orange-500 fill-orange-500 animate-pulse' : 'text-slate-300'}`} />
              </div>
              <div className="flex items-end justify-between mt-1 z-10">
                <div className={`text-2xl font-black ${metrics.myActionItems > 0 ? 'text-orange-700' : 'text-slate-800'}`}>{metrics.myActionItems}</div>
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
            <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl flex flex-col justify-between cursor-pointer hover:border-blue-300 transition-colors group">
              <div className="flex justify-between items-start"><span className="text-[10px] font-bold text-slate-400 uppercase">{cardLabels.slot4}</span><Briefcase className="w-4 h-4 text-slate-300 group-hover:text-blue-500" /></div>
              <div className="text-2xl font-black text-slate-800 mt-1">{metrics.slot4Count}</div>
            </div>

            {/* SLOT 5: IFC READY */}
            <div className="bg-teal-50/50 border border-teal-100 p-3 rounded-xl flex flex-col justify-between cursor-pointer hover:border-teal-300 transition-colors group" onClick={() => setFilters({ ...filters, status: 'PENDING_IFC' })}>
              <div className="flex justify-between items-start"><span className="text-[10px] font-bold text-teal-400 uppercase">IFC Ready</span><CheckCircle2 className="w-4 h-4 text-teal-300 group-hover:text-teal-500" /></div>
              <div className="text-2xl font-black text-teal-700 mt-1">{metrics.readyForIFC}</div>
            </div>

            {/* SLOT 6: STALE / ALERT */}
            <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl flex flex-col justify-between cursor-default">
              <div className="flex justify-between items-start">
                <span className="text-[10px] font-bold text-slate-400 uppercase">Stale (&gt; 7 Days)</span>
                <Clock className="w-4 h-4 text-slate-300" />
              </div>
              <div className="text-2xl font-black text-slate-600 mt-1">{metrics.staleTickets}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 2. ADVANCED FILTER BAR */}
      <div className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        
        {/* URGENT ACTION BANNER */}
        {metrics.myActionItems > 0 && (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 shadow-sm flex items-center justify-between text-orange-900 animate-in slide-in-from-top-4 mb-6">
            <div className="flex items-center space-x-4">
              <div className="p-2 bg-orange-100 rounded-lg">
                <AlertCircle className="w-6 h-6 text-orange-600 animate-pulse" />
              </div>
              <div>
                <h3 className="text-sm font-black tracking-tight uppercase text-orange-700">Action Required</h3>
                <p className="text-sm font-medium text-orange-800">
                  You have <span className="font-bold underline">{metrics.myActionItems} ticket{metrics.myActionItems > 1 ? 's' : ''}</span> waiting for your review or approval.
                </p>
              </div>
            </div>
            <button 
              onClick={() => setFilters({ ...filters, assignedTo: 'me', status: 'ALL' })}
              className="px-5 py-2 bg-white border border-orange-200 text-orange-700 text-xs font-bold rounded-lg hover:bg-orange-100 transition-colors shadow-sm"
            >
              View My Tasks
            </button>
          </div>
        )}

        {/* BULK ACTIONS HEADER */}
        {selectedTicketIds.size > 0 && (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-center justify-between animate-in fade-in slide-in-from-top-2">
            <div className="flex items-center space-x-3">
              <span className="bg-orange-600 text-white text-xs font-bold px-2 py-1 rounded-md">{selectedTicketIds.size} Selected</span>
              <span className="text-sm font-medium text-orange-900">Bulk actions active</span>
            </div>
            <div className="flex items-center space-x-2">
              <button onClick={handleExportCSV} className="flex items-center px-3 py-1.5 bg-white border border-orange-300 text-orange-700 rounded-lg text-sm font-bold hover:bg-orange-100"><Download className="w-4 h-4 mr-2" /> Export</button>
              <button onClick={handleBulkUrgencyToggle} className="flex items-center px-3 py-1.5 bg-white border border-orange-300 text-orange-700 rounded-lg text-sm font-bold hover:bg-orange-100" disabled={processingBulk}><Zap className="w-4 h-4 mr-2" /> Mark Urgent</button>
              <button onClick={handleBulkArchive} className="flex items-center px-3 py-1.5 bg-white border border-orange-300 text-orange-700 rounded-lg text-sm font-bold hover:bg-orange-100" disabled={processingBulk}><Archive className="w-4 h-4 mr-2" /> Archive</button>
              <button onClick={() => setSelectedTicketIds(new Set())} className="p-1.5 text-orange-600 hover:text-orange-800"><X className="w-5 h-5" /></button>
            </div>
          </div>
        )}

        {/* MAIN FILTER ROW */}
        <div className="flex flex-col xl:flex-row gap-4">
          <div className="relative flex-1 min-w-[300px]">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input type="text" placeholder="Search by ID, Requester, Drafter, or Keywords..." value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} className="w-full pl-12 pr-4 py-3 bg-white border border-slate-300 rounded-xl text-sm font-medium focus:ring-2 focus:ring-orange-500 focus:border-orange-500 shadow-sm transition-all" />
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <div className="bg-white border border-slate-300 rounded-lg p-1 flex shadow-sm mr-2">
              <button onClick={() => setViewMode('table')} className={`p-2 rounded-md transition-all ${viewMode === 'table' ? 'bg-slate-100 text-slate-900 shadow-inner' : 'text-slate-400 hover:text-slate-600'}`}><ListIcon className="w-5 h-5" /></button>
              <button onClick={() => setViewMode('grid')} className={`p-2 rounded-md transition-all ${viewMode === 'grid' ? 'bg-slate-100 text-slate-900 shadow-inner' : 'text-slate-400 hover:text-slate-600'}`}><LayoutGrid className="w-5 h-5" /></button>
            </div>
            <div className="relative">
              <select value={filters.assignedTo} onChange={(e) => setFilters({ ...filters, assignedTo: e.target.value as any })} className="appearance-none bg-white border border-slate-300 text-slate-700 py-3 pl-4 pr-10 rounded-xl text-sm font-semibold focus:ring-2 focus:ring-orange-500 shadow-sm cursor-pointer hover:border-slate-400 transition-colors"><option value="all">Assignee: All</option><option value="me">My Tickets</option><option value="unassigned">Unassigned Only</option></select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
            </div>
            <div className="relative">
              <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as any })} className="appearance-none bg-white border border-slate-300 text-slate-700 py-3 pl-4 pr-10 rounded-xl text-sm font-semibold focus:ring-2 focus:ring-orange-500 shadow-sm cursor-pointer hover:border-slate-400 transition-colors"><option value="ALL">Status: Any</option><option value="PENDING_ASSIGNMENT">Pending Assignment</option><option value="DRAFTING">In Drafting</option><option value="PENDING_REVIEW">In Review</option><option value="REVISION_REQ">Revisions Required</option><option value="PENDING_IFC">Ready for IFC</option><option value="FINAL_DRAFT">Finalized</option><option value="CLOSED">Closed</option></select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
            </div>
            <button onClick={() => setIsFilterPanelOpen(!isFilterPanelOpen)} className={`flex items-center px-4 py-3 rounded-xl text-sm font-bold border transition-all ${isFilterPanelOpen ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}><SlidersHorizontal className="w-4 h-4 mr-2" />More Filters</button>
          </div>
        </div>

        {/* EXPANDABLE FILTER PANEL */}
        {isFilterPanelOpen && (
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xl animate-in fade-in slide-in-from-top-4 grid grid-cols-1 md:grid-cols-4 gap-6">
             <div>
               <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Request Type</label>
               <div className="flex flex-wrap gap-2">
                 <button 
                   onClick={() => setFilters({...filters, type: 'ALL'})} 
                   className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filters.type === 'ALL' ? 'bg-orange-100 text-orange-800 border-orange-200' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
                 >
                   ALL
                 </button>
                 {requestTypeOptions.length > 0 ? requestTypeOptions.map(opt => (
                   <button 
                     key={String(opt.value)} 
                     onClick={() => setFilters({...filters, type: String(opt.value)})} 
                     className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filters.type === String(opt.value) ? 'bg-orange-100 text-orange-800 border-orange-200' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
                   >
                     {opt.label}
                   </button>
                 )) : (
                   // Fallback defaults if config not loaded
                   ['RFI', 'INSPECTION', 'ISO', 'MOC', 'ASBUILT'].map(type => (
                     <button key={type} onClick={() => setFilters({...filters, type})} className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filters.type === type ? 'bg-orange-100 text-orange-800 border-orange-200' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>{type}</button>
                   ))
                 )}
               </div>
             </div>
             <div><label className="block text-xs font-bold text-slate-500 uppercase mb-2">Timeframe</label><div className="flex flex-wrap gap-2">{['all', 'today', 'week', 'month'].map(range => (<button key={range} onClick={() => setFilters({...filters, dateRange: range as any})} className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filters.dateRange === range ? 'bg-blue-100 text-blue-800 border-blue-200' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>{range.charAt(0).toUpperCase() + range.slice(1)}</button>))}</div></div>
             <div><label className="block text-xs font-bold text-slate-500 uppercase mb-2">Urgency</label><div className="flex items-center space-x-2 bg-slate-50 p-2 rounded-lg border border-slate-200"><input type="checkbox" id="urgentOnly" checked={filters.priority === 'urgent'} onChange={(e) => setFilters({...filters, priority: e.target.checked ? 'urgent' : 'all'})} className="w-4 h-4 text-orange-600 border-slate-300 rounded focus:ring-orange-500" /><label htmlFor="urgentOnly" className="text-sm font-medium text-slate-700 cursor-pointer">Show Critical / RFI Only</label></div></div>
             <div className="flex items-end justify-end"><button onClick={clearAllFilters} className="flex items-center text-sm text-red-600 hover:text-red-800 font-bold hover:underline decoration-red-200 hover:decoration-red-800 transition-all"><FilterX className="w-4 h-4 mr-2" />Reset All Filters</button></div>
          </div>
        )}
      </div>

      {/* 3. CONTENT AREA */}
      <div className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8">
        
        {paginatedTickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 bg-white rounded-2xl border border-dashed border-slate-300 text-center">
            <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-6"><Search className="w-10 h-10 text-slate-300" /></div>
            <h3 className="text-xl font-bold text-slate-900 mb-2">No matching tickets found</h3>
            <p className="text-slate-500 max-w-md mx-auto mb-6">Adjust your filters or search terms.</p>
            <button onClick={clearAllFilters} className="bg-slate-900 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-slate-800 transition-colors">Clear Filters</button>
          </div>
        ) : (
          <>
            {/* VIEW: TABLE MODE */}
            {viewMode === 'table' && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden min-h-[500px]">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="w-12 px-6 py-4"><input type="checkbox" checked={selectedTicketIds.size === paginatedTickets.length && paginatedTickets.length > 0} onChange={handleSelectAll} className="rounded border-slate-300 text-orange-600 focus:ring-orange-500 w-4 h-4 cursor-pointer" /></th>
                        {[{ id: 'ticketId', label: 'Ticket ID' }, { id: 'status', label: 'Status' }, { id: 'title', label: 'Details' }, { id: 'unit', label: 'Unit' }, { id: 'priority', label: 'Priority' }, { id: 'lastModified', label: 'Last Activity' }].map((col) => (
                          <th key={col.id} className="px-6 py-4 text-left text-xs font-bold text-slate-500 uppercase tracking-wider cursor-pointer hover:text-orange-600 transition-colors group" onClick={() => handleSort(col.id as SortField)}><div className="flex items-center space-x-1"><span>{col.label}</span><ArrowUpDown className={`w-3 h-3 ${sortConfig.field === col.id ? 'text-orange-500' : 'text-slate-300'}`} /></div></th>
                        ))}
                        <th className="px-6 py-4 text-right text-xs font-bold text-slate-500 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-slate-200">
                      {paginatedTickets.map((ticket) => {
                         const daysOpen = calculateDaysOpen(ticket.createdAt);
                         const isStale = daysOpen > 14 && ticket.status !== 'CLOSED';
                         const isUrgent = ticket.status === 'REVISION_REQ' || ticket.requestType === 'RFI' || ticket.priority === 1;
                         const isSelected = selectedTicketIds.has(ticket.id!);
                         const isUnread = ticket.unreadBy?.includes(auth.currentUser?.uid || '');
                         const isActionNeeded = isActionRequired(ticket); // Use Helper

                         return (
                          <tr key={ticket.id} className={`transition-colors group ${isSelected ? 'bg-orange-50/50' : 'hover:bg-slate-50'}`}>
                            <td className="px-6 py-4"><input type="checkbox" checked={isSelected} onChange={() => toggleTicketSelection(ticket.id!)} className="rounded border-slate-300 text-orange-600 focus:ring-orange-500 w-4 h-4 cursor-pointer" /></td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex flex-col">
                                <div className="flex items-center">
                                  {/* DUAL BADGE LOGIC: Show Action OR Unread OR Both if room permits */}
                                  {isActionNeeded && <div className="w-2.5 h-2.5 bg-red-500 rounded-full mr-2 animate-pulse" title="Action Required" />}
                                  {!isActionNeeded && isUnread && <div className="w-2.5 h-2.5 bg-blue-500 rounded-full mr-2" title="New Updates" />}
                                  <Link href={`/requests/${ticket.id}`} className={`text-sm ${isUnread || isActionNeeded ? 'font-black text-slate-900' : 'font-bold text-slate-700'} hover:text-orange-600 hover:underline`}>{ticket.ticketId}</Link>
                                </div>
                                <span className="text-[10px] text-slate-400 mt-0.5 font-mono">{ticket.requestType}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap"><span className={`inline-flex px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase border ${getStatusColor(ticket.status)}`}>{ticket.status.replace(/_/g, ' ')}</span></td>
                            <td className="px-6 py-4"><div className="flex flex-col max-w-md"><span className={`text-sm ${isUnread ? 'font-bold text-slate-900' : 'font-medium text-slate-700'} truncate`}>{ticket.title}</span><div className="flex items-center mt-1 text-xs text-slate-500"><User className="w-3 h-3 mr-1" /><span className="mr-3">{ticket.requesterName}</span>{ticket.assignedDrafterName && (<><ArrowRight className="w-3 h-3 mr-1 text-slate-300" /><span className="font-semibold text-slate-700">{ticket.assignedDrafterName}</span></>)}</div></div></td>
                            <td className="px-6 py-4 whitespace-nowrap"><span className="text-sm font-mono text-slate-600 bg-slate-100 px-2 py-1 rounded border border-slate-200">{ticket.unit}</span></td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              {typeof ticket.priority === 'number' ? (
                                <div className={`flex items-center px-2 py-1 rounded border text-xs font-bold w-fit 
                                  ${ticket.priority === 1 ? 'text-red-600 bg-red-50 border-red-100' : 
                                    ticket.priority === 2 ? 'text-orange-600 bg-orange-50 border-orange-100' :
                                    ticket.priority === 3 ? 'text-blue-600 bg-blue-50 border-blue-100' :
                                    'text-slate-500 bg-slate-50 border-slate-100'
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
                            <td className="px-6 py-4 whitespace-nowrap"><div className="flex flex-col text-xs"><span className="font-medium text-slate-700">{toDate(ticket.lastModified).toLocaleDateString()}</span>{isStale && (<span className="text-red-500 font-bold flex items-center mt-0.5"><Clock className="w-3 h-3 mr-1" />Stale ({daysOpen}d)</span>)}</div></td>
                            
                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium relative">
                              <div className="flex items-center justify-end space-x-2">
                                {/* NEW COMMENT BADGE FOR TABLE */}
                                {(ticket.comments?.length || 0) > 0 && (
                                  <div className={`flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold mr-2 ${isUnread ? 'bg-blue-100 text-blue-600' : 'text-slate-400'}`}>
                                    <MessageCircle className="w-3 h-3 mr-1" /> {ticket.comments?.length}
                                  </div>
                                )}
                                <Link href={`/requests/${ticket.id}`} className="text-slate-400 hover:text-orange-600 transition-colors p-2 hover:bg-orange-50 rounded-full" title="View Details"><Eye className="w-4 h-4" /></Link>
                                
                                <div className="relative">
                                  <button onClick={() => setOpenRowMenu(openRowMenu === ticket.id ? null : ticket.id!)} className="text-slate-400 hover:text-slate-600 transition-colors p-2 hover:bg-slate-100 rounded-full"><MoreVertical className="w-4 h-4" /></button>
                                  {openRowMenu === ticket.id && (
                                    <>
                                      <div className="fixed inset-0 z-40" onClick={() => setOpenRowMenu(null)}></div>
                                      <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-xl border border-slate-200 z-50 animate-in fade-in zoom-in-95">
                                        <div className="py-1">
                                          <button onClick={() => handleQuickStatusUpdate(ticket.id!, 'REVISION_REQ')} className="flex w-full items-center px-4 py-2 text-xs text-amber-600 hover:bg-amber-50 font-bold"><AlertCircle className="w-3 h-3 mr-2" /> Mark Urgent</button>
                                          {['Manager', 'Admin'].includes(activeRole) && (<button onClick={() => handleQuickStatusUpdate(ticket.id!, 'CLOSED')} className="flex w-full items-center px-4 py-2 text-xs text-slate-600 hover:bg-slate-50 font-medium"><Trash2 className="w-3 h-3 mr-2" /> Force Close</button>)}
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
                <div className="bg-white px-6 py-4 border-t border-slate-200 flex items-center justify-between">
                  <div className="flex flex-col md:flex-row md:items-center text-sm text-slate-500"><span className="mr-4">Showing <span className="font-bold text-slate-900">{(currentPage - 1) * itemsPerPage + 1}</span> to <span className="font-bold text-slate-900">{Math.min(currentPage * itemsPerPage, filteredTickets.length)}</span> of <span className="font-bold text-slate-900">{filteredTickets.length}</span> results</span><select value={itemsPerPage} onChange={(e) => setItemsPerPage(Number(e.target.value))} className="mt-2 md:mt-0 bg-slate-50 border border-slate-200 rounded text-xs py-1 px-2 focus:ring-orange-500 focus:border-orange-500 cursor-pointer"><option value={10}>10 per page</option><option value={25}>25 per page</option><option value={50}>50 per page</option><option value={100}>100 per page</option></select></div>
                  <div className="flex items-center space-x-2"><button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors">Previous</button><button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors">Next</button></div>
                </div>
              </div>
            )}

            {/* VIEW: GRID MODE */}
            {viewMode === 'grid' && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-6">
                {paginatedTickets.map((ticket) => {
                   const isUrgent = ticket.status === 'REVISION_REQ' || ticket.requestType === 'RFI' || ticket.priority === 1;
                   const isUnread = ticket.unreadBy?.includes(auth.currentUser?.uid || '');
                   const isActionNeeded = isActionRequired(ticket);
                   const commentCount = ticket.comments?.length || 0;
                   return (
                    <div key={ticket.id} className="group bg-white rounded-2xl border border-slate-200 p-5 hover:shadow-xl hover:border-orange-300 hover:-translate-y-1 transition-all duration-300 flex flex-col relative overflow-hidden">
                      <div className={`absolute top-0 left-0 w-full h-1.5 ${isUrgent ? 'bg-red-500' : 'bg-slate-200 group-hover:bg-orange-500'}`} />
                      
                      {/* Grid Badges: Stacked */}
                      <div className="absolute top-2 right-2 flex flex-col gap-1 items-end">
                        {isActionNeeded && (
                           <div className="flex items-center bg-red-100 text-red-600 text-[10px] font-bold px-2 py-0.5 rounded-full border border-red-200 animate-pulse shadow-sm">
                             <MousePointerClick className="w-3 h-3 mr-1" /> Action
                           </div>
                        )}
                        {commentCount > 0 && (
                          <div className={`flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border shadow-sm ${isUnread ? 'bg-blue-100 text-blue-600 border-blue-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                            <MessageCircle className="w-3 h-3 mr-1" /> {commentCount} {isUnread && 'New'}
                          </div>
                        )}
                      </div>

                      <div className="flex justify-between items-start mb-4"><div className="flex flex-col"><span className="font-mono text-xs font-bold text-slate-400">{ticket.ticketId}</span><span className="text-[10px] font-bold text-slate-400 mt-0.5 uppercase tracking-wide">{ticket.requestType}</span></div><span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase border ${getStatusColor(ticket.status)}`}>{ticket.status.replace(/_/g, ' ')}</span></div>
                      <Link href={`/requests/${ticket.id}`} className="block mb-4"><h3 className={`text-lg leading-snug group-hover:text-orange-600 transition-colors line-clamp-2 ${isUnread ? 'font-black text-slate-900' : 'font-bold text-slate-900'}`}>{ticket.title}</h3></Link>
                      <div className="flex items-center text-xs text-slate-500 mb-6 bg-slate-50 p-2 rounded-lg border border-slate-100"><span className="font-semibold bg-white px-1.5 py-0.5 border rounded text-slate-700 mr-2 border-slate-200">{ticket.unit}</span><User className="w-3 h-3 mr-1" /><span className="truncate flex-1">{ticket.requesterName}</span></div>
                      <div className="mt-auto pt-4 border-t border-slate-100 flex items-center justify-between"><div className="flex flex-col"><span className="text-[10px] font-bold text-slate-400 uppercase">Assigned To</span><span className="text-xs font-semibold text-slate-700">{ticket.assignedDrafterName || 'Unassigned'}</span></div><Link href={`/requests/${ticket.id}`}><button className="h-8 w-8 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center group-hover:bg-orange-600 group-hover:text-white transition-all shadow-sm"><ArrowRight className="w-4 h-4" /></button></Link></div>
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
