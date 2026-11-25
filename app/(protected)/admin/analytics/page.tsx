"use client";

import React, { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { ChevronRight, X } from 'lucide-react';
import { Ticket, DocumentRecord } from '@/types/schema';
import { PageShell } from '@/components/ui/PageShell';
import { PageHero, PageBody } from '@/components/ui/PageHero';
import { tbl, sheet, btnQuiet, btnIcon, Section, StatusTag } from '@/components/admin/kit';
import { plural, bandSeg, bandSegItem } from '@/components/admin/band';
import UserAvatar from '@/components/ui/UserAvatar';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { CopyId } from '@/components/ui/CopyId';
import HelpTooltip from '@/components/ui/HelpTooltip';
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
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

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
        setLoadError(e);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [activeOrgId, reload]);

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
                  date: toDate(c.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
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
        label = d.toLocaleString('en-US', { month: 'short' });
        count = tickets.filter(t => {
          const tDate = toDate(t.createdAt);
          return tDate.getMonth() === d.getMonth() && tDate.getFullYear() === d.getFullYear();
        }).length;
      } else if (labelFormat === 'day') {
        const d = new Date();
        d.setDate(now.getDate() - i);
        label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        count = tickets.filter(t => {
          const tDate = toDate(t.createdAt);
          return tDate.getDate() === d.getDate() && tDate.getMonth() === d.getMonth();
        }).length;
      } else if (labelFormat === 'week') {
        const endD = new Date();
        endD.setDate(now.getDate() - (i * 7));
        const startD = new Date(endD);
        startD.setDate(endD.getDate() - 7);
        // A week is named by the day it ends ("Nov 16").
        label = endD.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
        <PageHero kicker="Admin · Analytics" title="Management and document control only."
          sub="An admin can change this under Admin, Permissions, Action permissions." />
      </PageShell>
    );
  }
  if (loading) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Analytics" title="Analytics" />
        <PageBody><SkeletonRows rows={6} cols={3} what="analytics" /></PageBody>
      </PageShell>
    );
  }

  // The answer: how many requests, and how many have stalled.
  const answer = loadError != null ? "Couldn't load the numbers."
    : metrics.staleTickets > 0 ? `${plural(metrics.staleTickets, "request")} untouched for a week.`
    : metrics.totalTickets === 0 ? "No requests yet."
    : "No request has stalled.";
  const people = viewMode === 'drafter' ? metrics.drafterStats : metrics.requesterStats;
  const maxVol = Math.max(...metrics.volumeData.map(v => v.count), 1);
  const peakIdx = metrics.volumeData.reduce((best, v, i, arr) => (v.count > arr[best].count ? i : best), 0);
  const lastIdx = metrics.volumeData.length - 1;
  const totalRevisions = metrics.rootCauseData.reduce((acc, curr) => acc + curr.count, 0);
  const rangeWord = timeRange === '1M' ? 'day' : timeRange === '3M' ? 'week' : 'month';
  const periodTotal = metrics.volumeData.reduce((s, v) => s + v.count, 0);

  return (
    <PageShell width="work">

      {/* Drill down: one reason's requests */}
      {selectedReason && (
        <Modal onClose={() => setSelectedReason(null)} size="xl" zIndex={50}>
          <ModalHeader title={selectedReason} subtitle={`Sent back ${plural(selectedTickets.length, "time")}`} onClose={() => setSelectedReason(null)} />
            <ModalBody>
              {selectedTickets.length === 0 ? (
                <p className="text-center py-12 text-[var(--color-text-muted)]">These were archived; only the count was kept.</p>
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
                            <CopyId value={item.ticketId} label="request number" className="text-reading" />
                            <Link href={`/requests/${item.id}`} target="_blank" className="block text-body text-[var(--color-text-muted)] line-clamp-2 hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">{item.ticketTitle}</Link>
                          </td>
                          <td className={`${tbl.td} align-top max-sm:py-1 text-reading text-[var(--color-text)]`}>&ldquo;{item.commentText}&rdquo;</td>
                          <td className={`${tbl.td} align-top max-sm:pt-1 text-body text-[var(--color-text-muted)] whitespace-nowrap`}>{item.reportedBy.split('@')[0]}<br className="max-sm:hidden" /><span className="sm:hidden">, </span>{item.date}</td>
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

      {/* One person's work */}
      {userProfile && (
        <Modal onClose={() => setSelectedUser(null)} size="2xl" zIndex={50}>
            <div className="px-5 sm:px-6 py-5 border-b border-[var(--color-border)] flex items-start gap-4 shrink-0">
              <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-6 gap-y-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <UserAvatar uid={userProfile.metric.uid} name={userProfile.metric.name} size={44} rounded="full" />
                  <div className="min-w-0">
                    <h2 className="font-display text-title leading-none font-semibold text-[var(--color-text)] truncate">{userProfile.metric.name}</h2>
                    <p className="mt-1 text-body text-[var(--color-text-muted)]">{viewMode === 'drafter' ? 'Drafter' : 'Requester'}, {plural(userProfile.metric.totalAssigned, "request")}</p>
                  </div>
                </div>
                <dl className="flex gap-6">
                  <div>
                    <dt className="text-body text-[var(--color-text-muted)]">Average revisions</dt>
                    <dd className="font-display text-section leading-tight font-semibold tabular-nums text-[var(--color-text)]">{userProfile.metric.avgRevisions.toFixed(1)}</dd>
                  </div>
                  <div>
                    <dt className="text-body text-[var(--color-text-muted)]">Sent back</dt>
                    <dd className={`font-display text-section leading-tight font-semibold tabular-nums ${userProfile.metric.revisionRate > 0.3 ? 'text-[var(--state-held-text)]' : 'text-[var(--color-text)]'}`}>{formatPercent(userProfile.metric.revisionRate)}</dd>
                  </div>
                </dl>
              </div>
              <button type="button" onClick={() => setSelectedUser(null)} aria-label="Close" title="Close" className={`-mr-2 -mt-1 shrink-0 ${btnIcon}`}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 sm:p-6">
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,38fr)_minmax(0,62fr)] gap-x-6 gap-y-8">
                <Section label="Why it came back">
                  <div className={`${sheet} p-4`}>
                    {userProfile.causes.length === 0 ? (
                      <p className="text-reading text-[var(--color-text-muted)]">No revisions recorded.</p>
                    ) : (
                      <RankBars items={userProfile.causes.map((c) => ({ label: c.reason, value: c.count, note: formatPercent(c.percent) }))} />
                    )}
                  </div>
                </Section>

                <Section label="Requests sent back" count={userProfile.tickets.length}>
                  {userProfile.tickets.length === 0 ? (
                    <div className={`${sheet} p-6 text-center text-reading text-[var(--color-text-muted)]`}>Nothing was sent back.</div>
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
                                <CopyId value={t.ticketId} label="request number" className="text-reading" />
                                <Link href={`/requests/${t.id}`} target="_blank" className="block text-body text-[var(--color-text-muted)] truncate max-w-[40ch] hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">{t.title}</Link>
                              </td>
                              <td className={`${tbl.td} max-sm:hidden`}><StatusTag tone="none">{t.status === 'CLOSED' ? 'Closed' : 'Open'}</StatusTag></td>
                              <td className={`${tbl.td} text-right font-medium tabular-nums`}>{t.revisionCount}</td>
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
        facts={loadError != null ? undefined : [
          { label: "Right first time", value: metrics.totalTickets > 0 ? formatPercent(1 - metrics.globalRevisionRate) : "-", tone: metrics.globalRevisionRate > 0.3 ? "warn" : undefined, hero: metrics.totalTickets > 0 },
          { label: "Requests", value: metrics.totalTickets.toLocaleString() },
          // None untouched isn't news; it shows only when some are (B7).
          ...(metrics.staleTickets > 0 ? [{ label: "Untouched a week", value: metrics.staleTickets, tone: "warn" as const }] : []),
          { label: "Documents issued", value: `${metrics.issuedDocs.toLocaleString()} of ${metrics.totalDocs.toLocaleString()}` },
        ]}
      />

      <PageBody>
      {loadError != null && <ErrorNote error={loadError} title="Couldn't load the numbers." onRetry={() => setReload((n) => n + 1)} />}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,62fr)_minmax(0,38fr)] gap-x-6 gap-y-8">
        <Section label="New requests" action={
          <div className={bandSeg} role="group" aria-label="Time range">
            {(['1M', '3M', '6M', '1Y'] as TimeRange[]).map(r => (
              <button key={r} type="button" aria-pressed={timeRange === r} onClick={() => setTimeRange(r)} className={bandSegItem(timeRange === r)}>
                {r === '1M' ? '1 month' : r === '3M' ? '3 months' : r === '6M' ? '6 months' : '1 year'}
              </button>
            ))}
          </div>
        }>
          <figure className={`${sheet} p-4 sm:p-5`}>
            <figcaption className="text-body text-[var(--color-text-muted)] mb-3 tabular-nums">
              {periodTotal > 0 ? `${plural(periodTotal, "request")} in this range, by ${rangeWord}.` : `By ${rangeWord}.`}
              {metrics.volumeData[peakIdx]?.count > 0 && <> Most: <b className="font-medium text-[var(--color-text)]">{metrics.volumeData[peakIdx].count}</b> in {metrics.volumeData[peakIdx].label}.</>}
            </figcaption>
            {/* Bars from zero. The latest {rangeWord} in the brand, the rest gray;
                each bar carries its own count, so no axis or legend is needed. */}
            {periodTotal === 0 && <p className="sr-only">No new requests in this range.</p>}
            <div className="relative h-52 flex items-end gap-1 sm:gap-2 border-b border-[var(--color-border-strong)]" role="img"
              aria-label={metrics.volumeData.map((d) => `${d.label}: ${d.count}`).join(", ")}>
              {periodTotal === 0 && (
                <span aria-hidden className="absolute inset-0 grid place-items-center text-body text-[var(--color-text-muted)]">No new requests in this range.</span>
              )}
              {metrics.volumeData.map((d, i) => {
                const latest = i === lastIdx;
                return (
                  <div key={i} className="flex-1 min-w-0 h-full flex flex-col justify-end items-center" title={`${d.label}: ${plural(d.count, "request")}`}>
                    {d.count > 0 && (metrics.volumeData.length <= 12 || latest || i === peakIdx) && (
                      <span className={`text-caption tabular-nums mb-1 ${latest ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{d.count}</span>
                    )}
                    <div className="w-full max-w-[44px] rounded-t-[3px] min-h-px transition-[height] duration-300 motion-reduce:transition-none"
                      style={{ height: `${(d.count / maxVol) * 85}%`, background: latest ? "var(--color-main)" : "var(--viz-neutral)" }} />
                  </div>
                );
              })}
            </div>
            <div className="flex gap-1 sm:gap-2 mt-1.5" aria-hidden>
              {metrics.volumeData.map((d, i) => (
                <span key={i} className={`flex-1 min-w-0 text-center text-caption truncate ${i === lastIdx ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"} ${metrics.volumeData.length > 12 && i % 5 !== 0 && i !== lastIdx ? "invisible" : ""}`}>{d.label}</span>
              ))}
            </div>
          </figure>
        </Section>

        <Section label="Why work came back" action={<span className="text-body text-[var(--color-text-muted)] tabular-nums">{plural(totalRevisions, "revision")}</span>}>
          {metrics.rootCauseData.length === 0 ? (
            <div className={`${sheet} px-4 py-8 text-center text-reading text-[var(--color-text-muted)]`}>Nothing has been sent back yet.</div>
          ) : (
            // A short list of reasons: space between, no rule under each (B3).
            <ul className={`${sheet} py-1.5 overflow-hidden`}>
              {metrics.rootCauseData.map((item, i) => (
                <li key={i}>
                  <button type="button" onClick={() => setSelectedReason(item.reason)} className="w-full text-left px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors group">
                    <div className="flex justify-between gap-2 text-body text-[var(--color-text)] mb-1.5">
                      <span className="inline-flex items-center gap-1 min-w-0"><span className="truncate font-medium">{item.reason}</span><ChevronRight aria-hidden className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)] group-hover:translate-x-0.5 transition-transform motion-reduce:transition-none" /></span>
                      <span className="shrink-0 tabular-nums"><b className="font-medium">{item.count}</b> <span className="text-[var(--color-text-muted)]">{formatPercent(item.percentage)}</span></span>
                    </div>
                    <div className="w-full bg-[var(--viz-track)] h-2 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(2, item.percentage * 100)}%`, background: i === 0 ? "var(--color-main)" : "var(--viz-neutral)" }} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section label={viewMode === 'drafter' ? 'Drafters' : 'Requesters'} count={people.length} action={
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
                <th className={`${tbl.th} text-right max-md:hidden`}>Average revisions</th>
                <th className={`${tbl.th} text-right`}>Sent back</th>
                <th className={`${tbl.th} text-right max-md:hidden`}>
                  <span className="inline-flex items-center gap-1">Score <HelpTooltip placement="left">100, less half the sent-back rate and 10 points for each average revision.</HelpTooltip></span>
                </th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {people.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--color-text-muted)]">Nothing to measure until requests are {viewMode === 'drafter' ? 'assigned' : 'made'}.</td></tr>
              ) : people.map((d) => {
                // Score: 100, less half the sent-back rate and ten per average revision.
                const score = Math.max(0, 100 - (d.revisionRate * 100 * 0.5) - (d.avgRevisions * 10));
                return (
                  <tr key={d.uid} onClick={() => setSelectedUser(d.uid)} className={`${tbl.tr} cursor-pointer`}>
                    <td className={tbl.td}>
                      <button type="button" onClick={(e) => { e.stopPropagation(); setSelectedUser(d.uid); }} className="inline-flex items-center gap-3 font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)] text-left">
                        <UserAvatar uid={d.uid} name={d.name} size={30} rounded="full" />
                        {d.name}
                      </button>
                    </td>
                    <td className={`${tbl.td} text-right`}>{d.totalAssigned}</td>
                    <td className={`${tbl.td} text-right max-sm:hidden`}>{d.completed}</td>
                    <td className={`${tbl.td} text-right max-md:hidden ${d.avgRevisions > 2 ? 'font-medium text-[var(--state-held-text)]' : ''}`}>{d.avgRevisions.toFixed(1)}</td>
                    <td className={`${tbl.td} text-right ${d.revisionRate > 0.3 ? 'font-medium text-[var(--state-held-text)]' : ''}`}>{formatPercent(d.revisionRate)}</td>
                    <td className={`${tbl.td} text-right max-md:hidden whitespace-nowrap`}>
                      <span className={score < 60 ? 'font-medium text-[var(--state-overdue-text)]' : 'text-[var(--color-text)]'}>{score.toFixed(0)}</span>
                      <span className="text-body text-[var(--color-text-muted)]"> of 100</span>
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

/** A ranked list as bars from zero: the top one in the brand, the rest gray,
 *  each with its own number. */
function RankBars({ items }: { items: Array<{ label: string; value: number; note?: string }> }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-3">
      {items.map((it, i) => (
        <li key={`${it.label}-${i}`}>
          <div className="flex justify-between gap-2 text-body text-[var(--color-text)] mb-1">
            <span className="truncate">{it.label}</span>
            <span className="shrink-0 tabular-nums"><b className="font-medium">{it.value}</b>{it.note && <span className="text-[var(--color-text-muted)]"> {it.note}</span>}</span>
          </div>
          <div className="w-full bg-[var(--viz-track)] h-2 rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, (it.value / max) * 100)}%`, background: i === 0 ? "var(--color-main)" : "var(--viz-neutral)" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
