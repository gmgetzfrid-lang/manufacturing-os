"use client";

import React, { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { 
  TrendingUp, 
  AlertTriangle, 
  CheckCircle2, 
  Clock, 
  FileText, 
  Users, 
  Server,
  ArrowUpRight,
  UserCircle,
  HelpCircle,
  X,
  ExternalLink,
  ChevronRight,
  MousePointerClick
} from 'lucide-react';
import { Ticket, DocumentRecord } from '@/types/schema';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody, Card } from '@/components/ui/PageHero';
import { plural } from '@/components/admin/band';
import UserAvatar from '@/components/ui/UserAvatar';
import LoadingBlock from '@/components/ui/LoadingBlock';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/Modal';

// --- TYPES ---
interface PerformanceMetric {
  uid: string;
  name: string;
  totalAssigned: number;
  completed: number;
  avgRevisions: number;
  revisionRate: number;
}

interface VolumePoint {
  label: string;
  count: number;
}

interface RootCausePoint {
  reason: string;
  count: number;
  percentage: number;
}

interface RootCauseTicket {
  id: string;
  ticketId: string;
  ticketTitle: string;
  commentId: string;
  commentText: string;
  reportedBy: string;
  date: string;
}

type TimeRange = '1M' | '3M' | '6M' | '1Y';
type ViewMode = 'drafter' | 'requester';

// --- UTILS ---
const getDaysDiff = (date: unknown) => {
  if (!date) return 0;
  const maybe = date as { toDate?: () => Date };
  const d = maybe.toDate ? maybe.toDate() : new Date(date as string | number | Date);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 3600 * 24));
};

const formatPercent = (val: number) => `${(val * 100).toFixed(1)}%`;

const toDate = (date: unknown): Date => {
  if (!date) return new Date();
  const maybe = date as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === 'function') return maybe.toDate();
  if (date instanceof Date) return date;
  if (typeof date === 'string') return new Date(date);
  if (maybe.seconds) return new Date(maybe.seconds * 1000);
  return new Date(date as string | number | Date);
};

// --- COMPONENT ---
export default function AnalyticsPage() {
  const { activeOrgId, activeRole } = useRole();
  // Policy-gated (default: Admin/Manager/Supervisor/DocCtrl). This page was
  // previously reachable by ANY member via direct URL — nav hiding is not a
  // permission model.
  const [allowed, setAllowed] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (!activeOrgId || !activeRole) return;
    let alive = true;
    void import("@/lib/capabilityPolicy").then(async ({ loadCapabilityPolicy, policyAllows }) => {
      const p = await loadCapabilityPolicy(activeOrgId);
      if (alive) setAllowed(policyAllows(p, "admin.analytics_view", activeRole));
    }).catch(() => { if (alive) setAllowed(true); });
    return () => { alive = false; };
  }, [activeOrgId, activeRole]);
  const [loading, setLoading] = useState(true);
  
  // STATE
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  
  // CONTROLS
  const [timeRange, setTimeRange] = useState<TimeRange>('6M');
  const [viewMode, setViewMode] = useState<ViewMode>('drafter');
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // FETCH DATA
  useEffect(() => {
    if (!activeOrgId) return;

    const fetchData = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data: ticketsData, error: tErr } = await supabase
          .from('tickets')
          .select('*')
          .eq('org_id', activeOrgId);
        if (tErr) throw tErr;
        setTickets((ticketsData || []).map(r => ({
          id: r.id, orgId: r.org_id, ticketId: r.ticket_id,
          title: r.title, description: r.description, unit: r.unit,
          requestType: r.request_type, priority: r.priority, status: r.status,
          requesterId: r.requester_id, requesterName: r.requester_name,
          requesterEmail: r.requester_email, requesterRole: r.requester_role,
          assignedDrafterId: r.assigned_drafter_id, assignedDrafterName: r.assigned_drafter_name,
          revisionCount: r.revision_count, attachments: r.attachments ?? [],
          comments: r.comments ?? [], history: r.history ?? [],
          createdAt: r.created_at, lastModified: r.last_modified,
          archivedAt: r.archived_at ?? null, metadata: r.metadata ?? null,
        } as Ticket)));

        const { data: docsData, error: dErr } = await supabase
          .from('documents')
          .select('id, org_id, status, document_number, title')
          .eq('org_id', activeOrgId);
        if (dErr) throw dErr;
        setDocuments((docsData || []).map(r => ({
          id: r.id, orgId: r.org_id, status: r.status,
          documentNumber: r.document_number, title: r.title,
        } as unknown as DocumentRecord)));

      } catch (e) {
        console.error("Analytics Load Error:", e);
        setLoadError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? "Couldn't load the numbers."));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [activeOrgId]);

  // --- METRICS COMPUTATION ---
  const metrics = useMemo(() => {
    // 1. Ticket Metrics
    const totalTickets = tickets.length;
    const closedTickets = tickets.filter(t => t.status === 'CLOSED').length;
    const activeTickets = totalTickets - closedTickets;
    
    const ticketsWithRevisions = tickets.filter(t => (t.revisionCount || 0) > 0).length;
    const globalRevisionRate = totalTickets > 0 ? ticketsWithRevisions / totalTickets : 0;
    
    const staleTickets = tickets.filter(t => t.status !== 'CLOSED' && getDaysDiff(t.lastModified) > 7).length;

    // 2. Document Metrics
    const totalDocs = documents.length;
    const supersededDocs = documents.filter(d => d.status === 'Superseded').length;
    const issuedDocs = documents.filter(d => d.status === 'Issued').length;

    // 3. Performance Aggregation
    const drafterMap = new Map<string, PerformanceMetric>();
    const requesterMap = new Map<string, PerformanceMetric>();
    
    // 4. Root Cause Analysis
    const revisionReasons = new Map<string, number>();
    let totalRevisionEvents = 0;

    // 5. Drill Down Data Preparation
    const drillDownMap = new Map<string, RootCauseTicket[]>();

    tickets.forEach(t => {
      // Drafter Stats
      if (t.assignedDrafterId) {
        const uid = t.assignedDrafterId;
        if (!drafterMap.has(uid)) drafterMap.set(uid, { uid, name: t.assignedDrafterName || 'Unknown', totalAssigned: 0, completed: 0, avgRevisions: 0, revisionRate: 0 });
        const m = drafterMap.get(uid)!;
        m.totalAssigned++;
        if (t.status === 'CLOSED' || t.status === 'FINAL_DRAFT') m.completed++;
        m.avgRevisions += (t.revisionCount || 0);
      }

      // Requester Stats
      if (t.requesterId) {
        const uid = t.requesterId;
        if (!requesterMap.has(uid)) requesterMap.set(uid, { uid, name: t.requesterName || 'Unknown', totalAssigned: 0, completed: 0, avgRevisions: 0, revisionRate: 0 });
        const m = requesterMap.get(uid)!;
        m.totalAssigned++;
        if (t.status === 'CLOSED') m.completed++;
        m.avgRevisions += (t.revisionCount || 0);
      }

      // Root Cause Parsing & Drill Down Population
      if (t.comments && t.comments.length > 0) {
        t.comments.forEach(c => {
            if (c.type === 'Revision' || c.type === 'Rejection') {
                const cat = c.category || 'Uncategorized';
                revisionReasons.set(cat, (revisionReasons.get(cat) || 0) + 1);
                totalRevisionEvents++;

                // Add to drill down map
                if (!drillDownMap.has(cat)) drillDownMap.set(cat, []);
                drillDownMap.get(cat)!.push({
                  id: t.id || '',
                  ticketId: t.ticketId,
                  ticketTitle: t.title,
                  commentId: c.id,
                  commentText: c.text,
                  reportedBy: c.user,
                  date: toDate(c.date).toLocaleDateString()
                });
            }
        });
      } else if (t.archivedAt) {
        // Archived stub: comments are gone, but the per-category revision tally was
        // preserved at archive time — fold it into the breakdown so long-closed
        // tickets aren't silently dropped from the root-cause report.
        const preserved = (t.metadata as { archive_summary?: { revisionCategories?: Record<string, number> } } | null)?.archive_summary?.revisionCategories;
        if (preserved) {
          for (const [cat, n] of Object.entries(preserved)) {
            const count = Number(n) || 0;
            revisionReasons.set(cat, (revisionReasons.get(cat) || 0) + count);
            totalRevisionEvents += count;
          }
        }
      }
    });

    const finalizeStats = (map: Map<string, PerformanceMetric>, isRequester = false) => Array.from(map.values()).map(m => ({
      ...m,
      avgRevisions: m.totalAssigned > 0 ? m.avgRevisions / m.totalAssigned : 0,
      revisionRate: m.totalAssigned > 0 ? (tickets.filter(t => (isRequester ? t.requesterId : t.assignedDrafterId) === m.uid && (t.revisionCount || 0) > 0).length / m.totalAssigned) : 0
    }));

    const drafterStats = finalizeStats(drafterMap);
    const requesterStats = finalizeStats(requesterMap, true);

    const rootCauseData: RootCausePoint[] = Array.from(revisionReasons.entries())
        .map(([reason, count]) => ({ reason, count, percentage: totalRevisionEvents > 0 ? count / totalRevisionEvents : 0 }))
        .sort((a, b) => b.count - a.count);

    // 5. Volume Data
    const volumeData: VolumePoint[] = [];
    const now = new Date();
    
    let iterations = 6;
    let labelFormat: 'day' | 'week' | 'month' = 'month';
    
    if (timeRange === '1M') { iterations = 30; labelFormat = 'day'; }
    else if (timeRange === '3M') { iterations = 12; labelFormat = 'week'; }
    else if (timeRange === '6M') { iterations = 6; labelFormat = 'month'; }
    else if (timeRange === '1Y') { iterations = 12; labelFormat = 'month'; }

    for (let i = iterations - 1; i >= 0; i--) {
      let label = '';
      let count = 0;

      if (labelFormat === 'month') {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        label = d.toLocaleString('default', { month: 'short' });
        count = tickets.filter(t => {
          const tDate = toDate(t.createdAt);
          return tDate.getMonth() === d.getMonth() && tDate.getFullYear() === d.getFullYear();
        }).length;
      } else if (labelFormat === 'day') {
        const d = new Date();
        d.setDate(now.getDate() - i);
        label = d.toLocaleDateString('default', { day: 'numeric', month: 'short' });
        count = tickets.filter(t => {
          const tDate = toDate(t.createdAt);
          return tDate.getDate() === d.getDate() && tDate.getMonth() === d.getMonth();
        }).length;
      } else if (labelFormat === 'week') {
        const endD = new Date();
        endD.setDate(now.getDate() - (i * 7));
        const startD = new Date(endD);
        startD.setDate(endD.getDate() - 7);
        label = `W${i+1}`; 
        count = tickets.filter(t => {
          const tDate = toDate(t.createdAt);
          return tDate >= startD && tDate <= endD;
        }).length;
      }
      
      volumeData.push({ label, count });
    }

    return {
      totalTickets, closedTickets, activeTickets, globalRevisionRate, staleTickets,
      totalDocs, supersededDocs, issuedDocs,
      drafterStats, requesterStats, volumeData, rootCauseData, drillDownMap
    };
  }, [tickets, documents, timeRange]);

  const selectedTickets = selectedReason ? metrics.drillDownMap.get(selectedReason) || [] : [];

  // --- USER PROFILE COMPUTATION ---
  const userProfile = useMemo(() => {
    if (!selectedUser) return null;
    
    const userStats = (viewMode === 'drafter' ? metrics.drafterStats : metrics.requesterStats).find(m => m.uid === selectedUser);
    if (!userStats) return null;

    const userTickets = tickets.filter(t => 
      (viewMode === 'drafter' ? t.assignedDrafterId : t.requesterId) === selectedUser
    );
    
    // Filter for tickets with revisions
    const problemTickets = userTickets.filter(t => (t.revisionCount || 0) > 0);
    
    // Calc Root Causes for this user
    const userCauses = new Map<string, number>();
    let totalCauses = 0;
    userTickets.forEach(t => {
       t.comments?.forEach(c => {
          if ((c.type === 'Revision' || c.type === 'Rejection') && c.category) {
             userCauses.set(c.category, (userCauses.get(c.category) || 0) + 1);
             totalCauses++;
          }
       });
    });
    
    const sortedCauses = Array.from(userCauses.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count, percent: totalCauses > 0 ? count / totalCauses : 0 }));

    return {
      metric: userStats,
      tickets: problemTickets.sort((a,b) => (b.revisionCount||0) - (a.revisionCount||0)),
      causes: sortedCauses
    };
  }, [selectedUser, tickets, viewMode, metrics]);


  if (allowed === false) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Analytics" title="Management and document control only." overlap={false}
          sub="An Admin can change this under Admin, Permissions, Action permissions." />
      </PageShell>
    );
  }
  if (loading) {
    return <PageShell width="work"><PageHero kicker="Admin · Analytics" title="Analytics" overlap={false} /><LoadingBlock what="analytics" rows={6} /></PageShell>;
  }

  // The answer: how many requests, and how many have stalled.
  const answer = metrics.staleTickets > 0
    ? `${plural(metrics.staleTickets, "request")} untouched for a week.`
    : metrics.totalTickets === 0 ? "No requests yet."
    : `${plural(metrics.totalTickets, "request")}, none stalled.`;

  return (
    <PageShell width="work">
      
      {/* --------------------------------------------------------------------------- */}
      {/* MODAL 1: ROOT CAUSE DRILL DOWN */}
      {/* --------------------------------------------------------------------------- */}
      {selectedReason && (
        <Modal onClose={() => setSelectedReason(null)} size="xl" zIndex={50}>
          <ModalHeader icon={AlertTriangle} title={selectedReason} subtitle={`Found ${selectedTickets.length} occurrences across tickets.`} onClose={() => setSelectedReason(null)} />
            <ModalBody className="bg-[var(--color-surface-2)]">
              {selectedTickets.length === 0 ? (
                <div className="text-center py-12 text-[var(--color-text-faint)]">No details found.</div>
              ) : (
                <div className="space-y-4">
                  {selectedTickets.map((item, idx) => (
                    <div key={idx} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-4 shadow-sm hover:shadow-md transition-shadow group">
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center">
                          <span className="font-mono text-xs font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-2 py-1 rounded mr-3">{item.ticketId}</span>
                          <h4 className="text-sm font-bold text-[var(--color-text)]">{item.ticketTitle}</h4>
                        </div>
                        <Link href={`/requests/${item.id}`} target="_blank">
                          <button className="text-xs font-bold text-[var(--color-text)] flex items-center hover:underline bg-[var(--color-surface-2)] px-3 py-1.5 rounded-lg border border-[var(--color-border)] group-hover:border-[var(--color-border)] transition-colors">
                            View Ticket <ExternalLink className="w-3 h-3 ml-1" />
                          </button>
                        </Link>
                      </div>
                      
                      <div className="ml-1 pl-4 border-l-2 border-[var(--color-border)] py-1">
                        <p className="text-xs text-[var(--color-text-muted)] italic">&ldquo;{item.commentText}&rdquo;</p>
                      </div>
                      
                      <div className="mt-3 flex items-center text-[11px] text-[var(--color-text-faint)] uppercase tracking-wider font-medium">
                        <span className="flex items-center mr-4"><UserCircle className="w-3 h-3 mr-1" /> {item.reportedBy.split('@')[0]}</span>
                        <span className="flex items-center"><Clock className="w-3 h-3 mr-1" /> {item.date}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ModalBody>
          <ModalFooter>
            <button onClick={() => setSelectedReason(null)} className="px-6 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)] font-bold rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">Close</button>
          </ModalFooter>
        </Modal>
      )}

      {/* --------------------------------------------------------------------------- */}
      {/* MODAL 2: USER PERFORMANCE PROFILE */}
      {/* --------------------------------------------------------------------------- */}
      {userProfile && (
        <Modal onClose={() => setSelectedUser(null)} size="2xl" zIndex={50}>

            {/* HEADER */}
            <div className="relative px-6 sm:px-8 py-6 pr-16 border-b border-[var(--color-border)] rounded-t-2xl flex justify-between items-start gap-4 flex-wrap shrink-0">
              <div className="flex items-center">
                <UserAvatar uid={userProfile.metric.uid} name={userProfile.metric.name} size={48} rounded="full" className="shadow-lg mr-4" />
                <div>
                  <h2 className="text-[28px] leading-none font-black tracking-[-0.02em] text-[var(--color-text)]">{userProfile.metric.name}</h2>
                  <p className="text-sm text-[var(--color-text-muted)] font-medium uppercase tracking-wide">{viewMode === 'drafter' ? 'Drafter Profile' : 'Requester Profile'}</p>
                </div>
              </div>
              <div className="flex flex-col items-end">
                 <div className="flex items-center space-x-4">
                    <div className="text-right">
                      <p className="text-[11px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider">Avg Revisions</p>
                      <p className="text-[15px] font-bold text-[var(--color-text)]">{userProfile.metric.avgRevisions.toFixed(2)}</p>
                    </div>
                    <div className="w-px h-8 bg-[var(--color-border-strong)] mx-2" />
                    <div className="text-right">
                      <p className="text-[11px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider">Revision Rate</p>
                      <p className={`text-[15px] font-bold ${userProfile.metric.revisionRate > 0.3 ? 'text-red-600' : 'text-emerald-600'}`}>{formatPercent(userProfile.metric.revisionRate)}</p>
                    </div>
                 </div>
              </div>
              <button onClick={() => setSelectedUser(null)} aria-label="Close" className="absolute top-4 right-4 p-2 hover:bg-[var(--color-border)] rounded-full text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-[var(--color-surface-2)]">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                
                {/* COLUMN 1: ROOT CAUSE BREAKDOWN */}
                <div className="lg:col-span-1">
                  <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm h-full">
                    <h3 className="font-bold text-[var(--color-text)] mb-4 flex items-center text-sm uppercase tracking-wide">
                      <AlertTriangle className="w-4 h-4 mr-2 text-[var(--color-text-muted)]" />
                      Primary Issue Drivers
                    </h3>
                    {userProfile.causes.length === 0 ? (
                      <p className="text-sm text-[var(--color-text-faint)] italic">No revisions recorded.</p>
                    ) : (
                      <div className="space-y-4">
                        {userProfile.causes.map((c, idx) => (
                          <div key={idx}>
                            <div className="flex justify-between text-xs font-bold text-[var(--color-text)] mb-1">
                              <span className="truncate pr-2">{c.reason}</span>
                              <span className="shrink-0">{formatPercent(c.percent)}</span>
                            </div>
                            <div className="w-full bg-[var(--color-surface-2)] h-2 rounded-full overflow-hidden">
                              <div className="bg-[var(--color-text)] h-full rounded-full" style={{ width: `${c.percent * 100}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="mt-6 text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                      {viewMode === 'drafter' ? "Why this person's work was sent back for revision." : "Why this person's requests were sent back."}
                    </p>
                  </div>
                </div>

                {/* COLUMN 2: PROBLEMATIC TICKETS */}
                <div className="lg:col-span-2">
                  <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm h-full flex flex-col">
                    <h3 className="font-bold text-[var(--color-text)] mb-4 flex items-center text-sm uppercase tracking-wide">
                      <FileText className="w-4 h-4 mr-2 text-[var(--color-text-muted)]" />
                      Tickets Requiring Attention
                    </h3>
                    <div className="flex-1 overflow-hidden">
                      {userProfile.tickets.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-[var(--color-text-faint)]">
                          <CheckCircle2 className="w-12 h-12 mb-3 text-[var(--color-text-faint)]" />
                          <p>No revisions found.</p>
                        </div>
                      ) : (
                        <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                          {userProfile.tickets.map(t => (
                            <div key={t.id} className="flex items-center justify-between p-3 border border-[var(--color-border)] rounded-lg hover:border-[var(--color-accent-ring)] hover:bg-[var(--color-surface-2)] transition-all group">
                              <div className="min-w-0">
                                <div className="flex items-center mb-1">
                                  <span className="text-xs font-mono font-bold text-[var(--color-text-muted)] mr-2">{t.ticketId}</span>
                                  <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded border ${t.status === 'CLOSED' ? 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]' : 'bg-green-100 text-green-700 border-green-200'}`}>{t.status}</span>
                                </div>
                                <p className="text-sm font-bold text-[var(--color-text)] truncate pr-4">{t.title}</p>
                              </div>
                              <div className="flex items-center space-x-4 shrink-0">
                                <div className="text-right">
                                  <p className="text-[11px] font-bold text-[var(--color-text-faint)] uppercase">Revisions</p>
                                  <p className="text-[15px] font-bold text-[var(--color-text)]">{t.revisionCount}</p>
                                </div>
                                <Link href={`/requests/${t.id}`} target="_blank">
                                  <button className="p-2 bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-[var(--color-accent-text)] hover:border-[var(--color-accent-ring)] rounded-lg shadow-sm transition-all">
                                    <ExternalLink className="w-4 h-4" />
                                  </button>
                                </Link>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

              </div>
            </div>
        </Modal>
      )}


      {/* HEADER */}
      <PageHero
        kicker="Admin · Analytics"
        title={answer}
        sub={`${plural(metrics.totalTickets, "request")} · ${plural(metrics.totalDocs, "document")}. First-time quality ${formatPercent(1 - metrics.globalRevisionRate)}.`}
      />

      <PageBody>
      {/* At a glance: one compact row instead of big-number tiles. */}
      <Card label="At a glance">
        {loadError && (
          <p role="alert" className="mb-3 text-[13px] text-red-700 dark:text-red-400">
            Couldn&apos;t load the numbers, so these may be empty: {loadError}
          </p>
        )}
        <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] flex items-center gap-1.5"><FileText className="w-3.5 h-3.5" /> Requests</dt>
            <dd className="mt-1 text-[15px] font-bold text-[var(--color-text)]">{metrics.totalTickets.toLocaleString()}</dd>
            <dd className="text-[12px] text-[var(--color-text-muted)] flex items-center"><ArrowUpRight className="w-3 h-3 mr-0.5 text-emerald-600" /> {metrics.volumeData[metrics.volumeData.length - 1]?.count || 0} in the latest period</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] flex items-center gap-1.5"><Server className="w-3.5 h-3.5" /> Documents</dt>
            <dd className="mt-1 text-[15px] font-bold text-[var(--color-text)]">{metrics.totalDocs.toLocaleString()}</dd>
            <dd className="text-[12px] text-[var(--color-text-muted)]">{metrics.issuedDocs} issued · {metrics.supersededDocs} superseded</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> First-time quality</dt>
            <dd className={`mt-1 text-[15px] font-bold ${metrics.globalRevisionRate > 0.3 ? "text-amber-700 dark:text-amber-400" : "text-[var(--color-text)]"}`}>{formatPercent(1 - metrics.globalRevisionRate)}</dd>
            <dd className="mt-1.5 w-full max-w-[10rem] bg-[var(--color-surface-2)] h-1.5 rounded-full overflow-hidden"><div className={`h-full rounded-full ${metrics.globalRevisionRate > 0.3 ? 'bg-amber-500' : 'bg-green-500'}`} style={{ width: `${(1 - metrics.globalRevisionRate) * 100}%` }} /></dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-muted)] flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> Stalled</dt>
            <dd className={`mt-1 text-[15px] font-bold ${metrics.staleTickets > 0 ? "text-amber-700 dark:text-amber-400" : "text-[var(--color-text)]"}`}>{metrics.staleTickets}</dd>
            <dd className="text-[12px] text-[var(--color-text-muted)]">Active, untouched for over 7 days</dd>
          </div>
        </dl>
      </Card>

      {/* SECTION 2: CHARTS & LISTS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        
        {/* CHART: DYNAMIC VOLUME */}
        <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] flex items-center"><TrendingUp className="w-3.5 h-3.5 mr-2" /> Request volume</h3>
            <div className="flex bg-[var(--color-surface-2)] rounded-lg p-1 space-x-1">
              {(['1M', '3M', '6M', '1Y'] as TimeRange[]).map(r => (
                <button 
                  key={r} 
                  type="button"
                  aria-pressed={timeRange === r}
                  onClick={() => setTimeRange(r)}
                  className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${timeRange === r ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div className="h-64 flex items-end justify-between space-x-2 px-4 pt-8 border-b border-[var(--color-border)] pb-2">
            {metrics.volumeData.map((d, i) => {
              const max = Math.max(...metrics.volumeData.map(v => v.count), 1); 
              const height = (d.count / max) * 100;
              return (
                <div key={i} className="flex flex-col items-center flex-1 group min-w-[20px]">
                  <div className="w-full bg-[var(--color-surface-2)] rounded-t-sm relative flex items-end justify-center transition-all group-hover:bg-[var(--color-border)]" style={{ height: '100%' }}>
                    <div 
                      className="w-full mx-0.5 bg-[var(--color-text-muted)] rounded-t-sm transition-all duration-500 ease-out group-hover:bg-[var(--color-text)] relative min-h-[4px]" 
                      style={{ height: `${height}%` }}
                    >
                       <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs font-bold text-[var(--color-text-muted)] opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity bg-[var(--color-surface)] px-2 py-1 rounded shadow-sm z-10 border border-[var(--color-border)]">{d.count}</span>
                    </div>
                  </div>
                  <span className="text-[11px] font-bold text-[var(--color-text-faint)] mt-2 uppercase tracking-wider truncate w-full text-center">{d.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* WIDGET: ROOT CAUSE ANALYSIS */}
        <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] p-5 flex flex-col">
          <div className="mb-6">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] flex items-center"><HelpCircle className="w-3.5 h-3.5 mr-2" /> Why work came back</h3>
                <p className="text-[13px] text-[var(--color-text-muted)] mt-1">Tap a reason to see its tickets.</p>
              </div>
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
            {metrics.rootCauseData.length === 0 ? (
               <div className="flex flex-col items-center justify-center h-48 text-center">
                 <AlertTriangle className="w-8 h-8 text-[var(--color-text-faint)] mb-2" />
                 <p className="text-xs text-[var(--color-text-faint)]">No revision data available yet.</p>
               </div>
            ) : (
               <div className="space-y-4">
                  {metrics.rootCauseData.map((item, i) => (
                    <div 
                      key={i} 
                      onClick={() => setSelectedReason(item.reason)}
                      className="cursor-pointer hover:bg-[var(--color-surface-2)] p-2 rounded-lg transition-colors group"
                    >
                      <div className="flex justify-between text-xs font-bold text-[var(--color-text)] mb-1 group-hover:text-[var(--color-text)]">
                        <span className="flex items-center">
                          {item.reason}
                          <ChevronRight className="w-3 h-3 ml-1 opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity text-[var(--color-text-muted)]" />
                        </span>
                        <span>{item.count} ({formatPercent(item.percentage)})</span>
                      </div>
                      <div className="w-full bg-[var(--color-surface-2)] h-2 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full transition-colors ${
                            item.reason.includes('Drafter') || item.reason.includes('Drafting') ? 'bg-[var(--color-text-muted)] group-hover:bg-[var(--color-text)]' :
                            item.reason.includes('Requester') || item.reason.includes('Info') ? 'bg-[var(--color-text-muted)] group-hover:bg-[var(--color-text)]' :
                            'bg-[var(--color-text-faint)] group-hover:bg-[var(--color-text)]'
                          }`} 
                          style={{ width: `${item.percentage * 100}%` }} 
                        />
                      </div>
                    </div>
                  ))}
               </div>
            )}
          </div>
          <div className="mt-6 pt-4 border-t border-[var(--color-border)]">
             <div className="flex items-center justify-between text-[11px] text-[var(--color-text-faint)] uppercase tracking-wider font-bold">
               <span>Total Revisions Logged</span>
               <span>{metrics.rootCauseData.reduce((acc, curr) => acc + curr.count, 0)}</span>
             </div>
          </div>
        </div>
      </div>

      {/* SECTION 3: PERFORMANCE TABLE */}
      <div className="bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-card)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex justify-between items-center gap-3 flex-wrap">
          <div>
            <h3 className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] flex items-center"><Users className="w-3.5 h-3.5 mr-2" /> {viewMode === 'drafter' ? 'Drafter performance' : 'Requester quality'}</h3>
            <p className="text-[13px] text-[var(--color-text-muted)] mt-1 flex items-center"><MousePointerClick className="w-3 h-3 mr-1" /> Tap a person to see why their work came back.</p>
          </div>
          <div className="flex bg-[var(--color-border)] rounded-lg p-1 space-x-1">
             <button type="button" aria-pressed={viewMode === 'drafter'} onClick={() => setViewMode('drafter')} className={`px-3 py-1.5 text-xs font-bold rounded transition-all ${viewMode === 'drafter' ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)]'}`}>Drafters</button>
             <button type="button" aria-pressed={viewMode === 'requester'} onClick={() => setViewMode('requester')} className={`px-3 py-1.5 text-xs font-bold rounded transition-all ${viewMode === 'requester' ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)]'}`}>Requesters</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-[var(--color-text-muted)] uppercase font-bold text-[11px] tracking-[0.12em]">
              <tr>
                <th className="px-6 py-3">{viewMode === 'drafter' ? 'Drafter' : 'Requester'}</th>
                <th className="px-6 py-3">Assigned Load</th>
                <th className="px-6 py-3">Completed</th>
                <th className="px-6 py-3">Avg Revisions</th>
                <th className="px-6 py-3">Revision Rate</th>
                <th className="px-6 py-3 text-right">Efficiency Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {(viewMode === 'drafter' ? metrics.drafterStats : metrics.requesterStats).length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-[var(--color-text-faint)] italic">No data available for this view.</td></tr>
              ) : (viewMode === 'drafter' ? metrics.drafterStats : metrics.requesterStats).map((d) => {
                // Efficiency Score Calculation
                const score = Math.max(0, 100 - (d.revisionRate * 100 * 0.5) - (d.avgRevisions * 10));
                
                return (
                  <tr 
                    key={d.uid} 
                    onClick={() => setSelectedUser(d.uid)}
                    className="hover:bg-[var(--color-surface-2)] transition-colors cursor-pointer group"
                  >
                    <td className="px-6 py-4 font-bold text-[var(--color-text)] flex items-center group-hover:text-[var(--color-text)] transition-colors">
                      <UserAvatar uid={d.uid} name={d.name} size={32} rounded="full" className="mr-3" />
                      {d.name}
                    </td>
                    <td className="px-6 py-4 font-mono text-[var(--color-text-muted)]">{d.totalAssigned}</td>
                    <td className="px-6 py-4 font-mono text-[var(--color-text-muted)]">{d.completed}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center">
                        <span className={`font-bold mr-2 ${d.avgRevisions > 2 ? 'text-amber-500' : 'text-[var(--color-text)]'}`}>{d.avgRevisions.toFixed(1)}</span>
                        <div className="w-16 h-1.5 bg-[var(--color-surface-2)] rounded-full overflow-hidden">
                           <div className={`h-full rounded-full ${d.avgRevisions > 2 ? 'bg-amber-400' : 'bg-[var(--color-text-muted)]'}`} style={{ width: `${Math.min(100, d.avgRevisions * 20)}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                       <span className={`px-2 py-1 rounded text-xs font-bold ${d.revisionRate > 0.3 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'}`}>
                         {formatPercent(d.revisionRate)}
                       </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                       <span className="font-bold text-[var(--color-text)] text-[15px]">{score.toFixed(0)}</span>
                       <span className="text-xs text-[var(--color-text-faint)] ml-1">/ 100</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      </PageBody>

    </PageShell>
  );
}
