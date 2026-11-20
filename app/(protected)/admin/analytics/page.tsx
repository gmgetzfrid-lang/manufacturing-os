"use client";

import React, { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { AlertTriangle, ChevronRight, X, BarChart3, RotateCcw, Users, ListX } from 'lucide-react';
import { Ticket, DocumentRecord } from '@/types/schema';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody } from '@/components/ui/PageHero';
import { tbl, sheet, btnQuiet, btnIcon, Pill, Section, Problem } from '@/components/admin/kit';
import { plural, bandSeg, bandSegItem } from '@/components/admin/band';
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
    : "No request has stalled.";
  const people = viewMode === 'drafter' ? metrics.drafterStats : metrics.requesterStats;
  const maxVol = Math.max(...metrics.volumeData.map(v => v.count), 1);
  const totalRevisions = metrics.rootCauseData.reduce((acc, curr) => acc + curr.count, 0);

  return (
    <PageShell width="work">

      {/* Drill down: one reason's tickets */}
      {selectedReason && (
        <Modal onClose={() => setSelectedReason(null)} size="xl" zIndex={50}>
          <ModalHeader icon={AlertTriangle} title={selectedReason} subtitle={plural(selectedTickets.length, "time")} onClose={() => setSelectedReason(null)} />
            <ModalBody>
              {selectedTickets.length === 0 ? (
                <div className="text-center py-12 text-[var(--color-text-muted)]">No details found.</div>
              ) : (
                <div className={tbl.wrap}>
                  <table className={tbl.table}>
                    <thead className={`${tbl.thead} max-sm:hidden`}>
                      <tr><th className={tbl.th}>Request</th><th className={tbl.th}>What was said</th><th className={tbl.th}>Who, when</th></tr>
                    </thead>
                    <tbody className={tbl.tbody}>
                      {selectedTickets.map((item, idx) => (
                        <tr key={idx} className={`${tbl.tr} max-sm:flex max-sm:flex-col`}>
                          <td className={`${tbl.td} align-top max-sm:pb-1`}>
                            <Link href={`/requests/${item.id}`} target="_blank" className="group block">
                              <span className="ui-id text-[16px] group-hover:text-[var(--color-accent-text)]">{item.ticketId}</span>
                              <span className="block text-[14px] text-[var(--color-text-muted)] line-clamp-2">{item.ticketTitle}</span>
                            </Link>
                          </td>
                          <td className={`${tbl.td} align-top max-sm:py-1 text-[15px] text-[var(--color-text)]`}>&ldquo;{item.commentText}&rdquo;</td>
                          <td className={`${tbl.td} align-top max-sm:pt-1 text-[14px] text-[var(--color-text-muted)] whitespace-nowrap`}>{item.reportedBy.split('@')[0]}<br className="max-sm:hidden" /><span className="sm:hidden">, </span>{item.date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ModalBody>
          <ModalFooter>
            <button type="button" onClick={() => setSelectedReason(null)} className={btnQuiet}>Close</button>
          </ModalFooter>
        </Modal>
      )}

      {/* One person's profile */}
      {userProfile && (
        <Modal onClose={() => setSelectedUser(null)} size="2xl" zIndex={50}>
            <div className="relative px-5 sm:px-6 py-5 pr-14 border-b border-[var(--color-border)] flex justify-between items-center gap-4 flex-wrap shrink-0">
              <div className="flex items-center gap-3">
                <UserAvatar uid={userProfile.metric.uid} name={userProfile.metric.name} size={44} rounded="full" />
                <div>
                  <h2 className="font-display text-[26px] leading-none font-semibold text-[var(--color-text)]">{userProfile.metric.name}</h2>
                  <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">{viewMode === 'drafter' ? 'Drafter' : 'Requester'}</p>
                </div>
              </div>
              <dl className="flex">
                <div className="px-4 border-l border-[var(--color-border-strong)]">
                  <dt className="text-[13px] text-[var(--color-text-muted)]">Average revisions</dt>
                  <dd className="font-display text-[24px] leading-tight font-semibold tabular-nums text-[var(--color-text)]">{userProfile.metric.avgRevisions.toFixed(2)}</dd>
                </div>
                <div className="px-4 border-l border-[var(--color-border-strong)]">
                  <dt className="text-[13px] text-[var(--color-text-muted)]">Sent back</dt>
                  <dd className={`font-display text-[24px] leading-tight font-semibold tabular-nums ${userProfile.metric.revisionRate > 0.3 ? 'text-[var(--state-held)]' : 'text-[var(--color-text)]'}`}>{formatPercent(userProfile.metric.revisionRate)}</dd>
                </div>
              </dl>
              <button type="button" onClick={() => setSelectedUser(null)} aria-label="Close" className={`absolute top-4 right-4 ${btnIcon}`}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 sm:p-6 bg-[var(--color-canvas)]">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <Section label="Why it came back" icon={RotateCcw} className="lg:col-span-1">
                  <div className={`${sheet} p-4`}>
                    {userProfile.causes.length === 0 ? (
                      <p className="text-[15px] text-[var(--color-text-muted)]">No revisions recorded.</p>
                    ) : (
                      <div className="space-y-3">
                        {userProfile.causes.map((c, idx) => (
                          <div key={idx}>
                            <div className="flex justify-between text-[14px] text-[var(--color-text)] mb-1">
                              <span className="truncate pr-2">{c.reason}</span>
                              <span className="shrink-0 tabular-nums font-semibold">{formatPercent(c.percent)}</span>
                            </div>
                            <div className="w-full bg-[var(--color-surface-2)] h-2 rounded-sm overflow-hidden">
                              <div className="bg-[var(--color-main)] h-full" style={{ width: `${c.percent * 100}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </Section>

                <Section label="Requests sent back" icon={ListX} className="lg:col-span-2">
                  {userProfile.tickets.length === 0 ? (
                    <div className={`${sheet} p-6 text-center`}><Pill tone="good">No revisions found</Pill></div>
                  ) : (
                    <div className={`${tbl.wrap} max-h-[420px] overflow-y-auto`}>
                      <table className={tbl.table}>
                        <thead className={tbl.thead}>
                          <tr><th className={tbl.th}>Request</th><th className={`${tbl.th} max-sm:hidden`}>Status</th><th className={`${tbl.th} text-right`}>Revisions</th></tr>
                        </thead>
                        <tbody className={tbl.tbody}>
                          {userProfile.tickets.map(t => (
                            <tr key={t.id} className={tbl.tr}>
                              <td className={tbl.td}>
                                <Link href={`/requests/${t.id}`} target="_blank" className="group block min-w-0">
                                  <span className="ui-id text-[16px] group-hover:text-[var(--color-accent-text)]">{t.ticketId}</span>
                                  <span className="block text-[14px] text-[var(--color-text-muted)] truncate max-w-[40ch]">{t.title}</span>
                                </Link>
                              </td>
                              <td className={`${tbl.td} max-sm:hidden`}><Pill tone={t.status === 'CLOSED' ? 'good' : 'warn'}>{t.status === 'CLOSED' ? 'Closed' : 'Open'}</Pill></td>
                              <td className={`${tbl.td} text-right font-display text-[16px] font-semibold tabular-nums`}>{t.revisionCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>
              </div>
            </div>
        </Modal>
      )}

      <PageHero
        kicker="Admin · Analytics"
        title={answer}
        sub={`${metrics.totalDocs.toLocaleString()} documents: ${metrics.issuedDocs.toLocaleString()} issued, ${metrics.supersededDocs.toLocaleString()} superseded. ${metrics.volumeData[metrics.volumeData.length - 1]?.count || 0} requests in the latest period.`}
        facts={[
          { label: "Requests", value: metrics.totalTickets.toLocaleString() },
          { label: "Right first time", value: formatPercent(1 - metrics.globalRevisionRate), tone: metrics.globalRevisionRate > 0.3 ? "warn" : undefined },
          { label: "Stalled", value: metrics.staleTickets, tone: metrics.staleTickets > 0 ? "warn" : undefined },
        ]}
      />

      <PageBody>
      {loadError && <Problem>Couldn&apos;t load the numbers, so these may be empty: {loadError}</Problem>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-x-6 gap-y-8">
        <Section label="Request volume" icon={BarChart3} className="lg:col-span-2" action={
          <div className={bandSeg} role="group" aria-label="Time range">
            {(['1M', '3M', '6M', '1Y'] as TimeRange[]).map(r => (
              <button key={r} type="button" aria-pressed={timeRange === r} onClick={() => setTimeRange(r)} className={bandSegItem(timeRange === r)}>
                {r === '1M' ? '1 month' : r === '3M' ? '3 months' : r === '6M' ? '6 months' : '1 year'}
              </button>
            ))}
          </div>
        }>
          <div className={`${sheet} p-4 sm:p-5`}>
            <div className="h-56 flex items-end gap-1.5 sm:gap-2 border-b border-[var(--color-border-strong)]">
              {metrics.volumeData.map((d, i) => (
                <div key={i} className="flex-1 min-w-0 h-full flex flex-col justify-end items-center group" title={`${d.label}: ${d.count}`}>
                  <span className="text-[12px] font-semibold tabular-nums text-[var(--color-text-muted)] mb-1">{d.count > 0 ? d.count : ""}</span>
                  <div className="w-full max-w-[44px] rounded-t-sm bg-[var(--color-main)] group-hover:bg-[var(--color-heading)] transition-colors min-h-[2px]" style={{ height: `${(d.count / maxVol) * 85}%` }} />
                </div>
              ))}
            </div>
            <div className="flex gap-1.5 sm:gap-2 mt-1.5">
              {metrics.volumeData.map((d, i) => (
                <span key={i} className="flex-1 min-w-0 text-center text-[12px] text-[var(--color-text-muted)] truncate">{d.label}</span>
              ))}
            </div>
          </div>
        </Section>

        <Section label="Why work came back" icon={RotateCcw} action={<span className="text-[13px] text-[var(--color-text-muted)]">{plural(totalRevisions, "revision")}</span>}>
          {metrics.rootCauseData.length === 0 ? (
            <div className={`${sheet} px-4 py-8 text-center text-[15px] text-[var(--color-text-muted)]`}>No revisions recorded yet.</div>
          ) : (
            <ul className={`${sheet} divide-y divide-[var(--color-border)] overflow-hidden`}>
              {metrics.rootCauseData.map((item, i) => (
                <li key={i}>
                  <button type="button" onClick={() => setSelectedReason(item.reason)} className="w-full text-left px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors group">
                    <div className="flex justify-between gap-2 text-[15px] text-[var(--color-text)] mb-1.5">
                      <span className="inline-flex items-center gap-1 min-w-0"><span className="truncate group-hover:text-[var(--color-accent-text)]">{item.reason}</span><ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" /></span>
                      <span className="shrink-0 tabular-nums"><b className="font-semibold">{item.count}</b> <span className="text-[var(--color-text-muted)]">({formatPercent(item.percentage)})</span></span>
                    </div>
                    <div className="w-full bg-[var(--color-surface-2)] h-2 rounded-sm overflow-hidden">
                      <div className="h-full bg-[var(--color-main)] group-hover:bg-[var(--color-heading)]" style={{ width: `${item.percentage * 100}%` }} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section label={viewMode === 'drafter' ? 'Drafters' : 'Requesters'} icon={Users} count={people.length} action={
        <div className={bandSeg} role="group" aria-label="Whose work">
          <button type="button" aria-pressed={viewMode === 'drafter'} onClick={() => setViewMode('drafter')} className={bandSegItem(viewMode === 'drafter')}>Drafters</button>
          <button type="button" aria-pressed={viewMode === 'requester'} onClick={() => setViewMode('requester')} className={bandSegItem(viewMode === 'requester')}>Requesters</button>
        </div>
      }>
        <div className={tbl.wrap}>
          <table className={tbl.table}>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>{viewMode === 'drafter' ? 'Drafter' : 'Requester'}</th>
                <th className={`${tbl.th} text-right`}>Assigned</th>
                <th className={`${tbl.th} text-right max-sm:hidden`}>Completed</th>
                <th className={`${tbl.th} max-md:hidden`}>Average revisions</th>
                <th className={`${tbl.th} text-right`}>Sent back</th>
                <th className={`${tbl.th} text-right max-md:hidden`}>Score</th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {people.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--color-text-muted)]">No requests to measure yet.</td></tr>
              ) : people.map((d) => {
                // Efficiency score: 100, less half the sent-back rate and ten per average revision.
                const score = Math.max(0, 100 - (d.revisionRate * 100 * 0.5) - (d.avgRevisions * 10));
                return (
                  <tr key={d.uid} onClick={() => setSelectedUser(d.uid)} className={`${tbl.tr} cursor-pointer`}>
                    <td className={tbl.td}>
                      <button type="button" onClick={(e) => { e.stopPropagation(); setSelectedUser(d.uid); }} className="inline-flex items-center gap-3 font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)] text-left">
                        <UserAvatar uid={d.uid} name={d.name} size={30} rounded="full" />
                        {d.name}
                      </button>
                    </td>
                    <td className={`${tbl.td} text-right font-display tabular-nums font-semibold`}>{d.totalAssigned}</td>
                    <td className={`${tbl.td} text-right font-display tabular-nums font-semibold max-sm:hidden`}>{d.completed}</td>
                    <td className={`${tbl.td} max-md:hidden`}>
                      <div className="flex items-center gap-2">
                        <span className={`tabular-nums w-8 ${d.avgRevisions > 2 ? 'font-semibold text-[var(--state-held)]' : 'text-[var(--color-text)]'}`}>{d.avgRevisions.toFixed(1)}</span>
                        <div className="w-20 h-1.5 bg-[var(--color-surface-2)] rounded-sm overflow-hidden">
                          <div className={`h-full ${d.avgRevisions > 2 ? 'bg-[var(--state-held)]' : 'bg-[var(--color-main)]'}`} style={{ width: `${Math.min(100, d.avgRevisions * 20)}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className={`${tbl.td} text-right`}>
                      <span className={`ui-pill ${d.revisionRate > 0.3 ? 'is-warn' : d.revisionRate === 0 ? 'is-good' : 'is-muted'} font-display tabular-nums`}>{formatPercent(d.revisionRate)}</span>
                    </td>
                    <td className={`${tbl.td} text-right max-md:hidden whitespace-nowrap`}>
                      <span className={`ui-count !h-7 !text-[15px] font-display ${score >= 80 ? 'is-solid' : score >= 60 ? 'is-warn' : 'is-bad'}`}>{score.toFixed(0)}</span>
                      <span className="text-[13px] text-[var(--color-text-muted)]"> / 100</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
      </PageBody>

    </PageShell>
  );
}
