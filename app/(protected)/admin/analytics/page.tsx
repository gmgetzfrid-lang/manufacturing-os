"use client";

import React, { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { 
  collection, 
  query, 
  where, 
  getDocs, 
  Timestamp,
  orderBy
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useRole } from '@/components/providers/RoleContext';
import { 
  BarChart3, 
  TrendingUp, 
  AlertTriangle, 
  CheckCircle2, 
  Clock, 
  FileText, 
  Users, 
  Server,
  ArrowUpRight,
  ArrowDownRight,
  Calendar,
  Filter,
  UserCircle,
  HelpCircle,
  X,
  ExternalLink,
  ChevronRight,
  MousePointerClick
} from 'lucide-react';
import { Ticket, DocumentRecord } from '@/types/schema';

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
const getDaysDiff = (date: any) => {
  if (!date) return 0;
  const d = date.toDate ? date.toDate() : new Date(date);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 3600 * 24));
};

const formatPercent = (val: number) => `${(val * 100).toFixed(1)}%`;

const toDate = (date: any): Date => {
  if (!date) return new Date();
  if (typeof date.toDate === 'function') return date.toDate();
  if (date instanceof Date) return date;
  if (typeof date === 'string') return new Date(date);
  if (date.seconds) return new Date(date.seconds * 1000);
  return new Date(date); 
};

// --- COMPONENT ---
export default function AnalyticsPage() {
  const { activeOrgId } = useRole();
  const [loading, setLoading] = useState(true);
  
  // STATE
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  
  // CONTROLS
  const [timeRange, setTimeRange] = useState<TimeRange>('6M');
  const [viewMode, setViewMode] = useState<ViewMode>('drafter');
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);

  // FETCH DATA
  useEffect(() => {
    if (!activeOrgId) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        const ticketsSnap = await getDocs(query(collection(db, 'tickets'), where('orgId', '==', activeOrgId)));
        const ticketsData = ticketsSnap.docs.map(d => ({ id: d.id, ...d.data() } as Ticket));
        setTickets(ticketsData);

        const docsSnap = await getDocs(query(collection(db, 'documents'), where('orgId', '==', activeOrgId)));
        const docsData = docsSnap.docs.map(d => ({ id: d.id, ...d.data() } as DocumentRecord));
        setDocuments(docsData);

      } catch (e) {
        console.error("Analytics Load Error:", e);
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
      if (t.comments) {
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


  if (loading) {
    return <div className="p-8 text-center text-slate-500 animate-pulse">Loading Analytics Engine...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-8 space-y-8 pb-20">
      
      {/* --------------------------------------------------------------------------- */}
      {/* MODAL 1: ROOT CAUSE DRILL DOWN */}
      {/* --------------------------------------------------------------------------- */}
      {selectedReason && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col border border-slate-200 animate-in zoom-in-95">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50 rounded-t-xl">
              <div>
                <h3 className="text-lg font-bold text-slate-900 flex items-center">
                  <AlertTriangle className="w-5 h-5 mr-2 text-orange-600" />
                  {selectedReason}
                </h3>
                <p className="text-xs text-slate-500 mt-1">Found {selectedTickets.length} occurrences across tickets.</p>
              </div>
              <button onClick={() => setSelectedReason(null)} className="p-2 hover:bg-slate-200 rounded-full text-slate-500 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="overflow-y-auto p-6 custom-scrollbar bg-slate-50/50">
              {selectedTickets.length === 0 ? (
                <div className="text-center py-12 text-slate-400">No details found.</div>
              ) : (
                <div className="space-y-4">
                  {selectedTickets.map((item, idx) => (
                    <div key={idx} className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm hover:shadow-md transition-shadow group">
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center">
                          <span className="font-mono text-xs font-bold text-slate-500 bg-slate-100 px-2 py-1 rounded mr-3">{item.ticketId}</span>
                          <h4 className="text-sm font-bold text-slate-900">{item.ticketTitle}</h4>
                        </div>
                        <Link href={`/requests/${item.id}`} target="_blank">
                          <button className="text-xs font-bold text-blue-600 flex items-center hover:underline bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-100 group-hover:border-blue-200 transition-colors">
                            View Ticket <ExternalLink className="w-3 h-3 ml-1" />
                          </button>
                        </Link>
                      </div>
                      
                      <div className="ml-1 pl-4 border-l-2 border-orange-200 py-1">
                        <p className="text-xs text-slate-600 italic">"{item.commentText}"</p>
                      </div>
                      
                      <div className="mt-3 flex items-center text-[10px] text-slate-400 uppercase tracking-wider font-medium">
                        <span className="flex items-center mr-4"><UserCircle className="w-3 h-3 mr-1" /> {item.reportedBy.split('@')[0]}</span>
                        <span className="flex items-center"><Clock className="w-3 h-3 mr-1" /> {item.date}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-slate-200 bg-white rounded-b-xl flex justify-end">
              <button onClick={() => setSelectedReason(null)} className="px-6 py-2 bg-slate-100 text-slate-700 font-bold rounded-lg hover:bg-slate-200 transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------------------- */}
      {/* MODAL 2: USER PERFORMANCE PROFILE */}
      {/* --------------------------------------------------------------------------- */}
      {userProfile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col border border-slate-200 animate-in zoom-in-95">
            
            {/* HEADER */}
            <div className="px-8 py-6 border-b border-slate-200 bg-slate-50 rounded-t-xl flex justify-between items-start">
              <div className="flex items-center">
                <div className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-xl shadow-lg mr-4">
                  {userProfile.metric.name.charAt(0)}
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-slate-900">{userProfile.metric.name}</h2>
                  <p className="text-sm text-slate-500 font-medium uppercase tracking-wide">{viewMode === 'drafter' ? 'Drafter Profile' : 'Requester Profile'}</p>
                </div>
              </div>
              <div className="flex flex-col items-end">
                 <div className="flex items-center space-x-4">
                    <div className="text-right">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Avg Revisions</p>
                      <p className={`text-xl font-black ${userProfile.metric.avgRevisions > 1.5 ? 'text-orange-600' : 'text-slate-700'}`}>{userProfile.metric.avgRevisions.toFixed(2)}</p>
                    </div>
                    <div className="w-px h-8 bg-slate-300 mx-2" />
                    <div className="text-right">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Revision Rate</p>
                      <p className={`text-xl font-black ${userProfile.metric.revisionRate > 0.3 ? 'text-red-600' : 'text-green-600'}`}>{formatPercent(userProfile.metric.revisionRate)}</p>
                    </div>
                 </div>
              </div>
              <button onClick={() => setSelectedUser(null)} className="absolute top-4 right-4 p-2 hover:bg-slate-200 rounded-full text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-slate-50/30">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                
                {/* COLUMN 1: ROOT CAUSE BREAKDOWN */}
                <div className="lg:col-span-1">
                  <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm h-full">
                    <h3 className="font-bold text-slate-900 mb-4 flex items-center text-sm uppercase tracking-wide">
                      <AlertTriangle className="w-4 h-4 mr-2 text-orange-500" />
                      Primary Issue Drivers
                    </h3>
                    {userProfile.causes.length === 0 ? (
                      <p className="text-sm text-slate-400 italic">No revisions recorded.</p>
                    ) : (
                      <div className="space-y-4">
                        {userProfile.causes.map((c, idx) => (
                          <div key={idx}>
                            <div className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                              <span className="truncate pr-2">{c.reason}</span>
                              <span className="shrink-0">{formatPercent(c.percent)}</span>
                            </div>
                            <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                              <div className="bg-slate-800 h-full rounded-full" style={{ width: `${c.percent * 100}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-100 text-xs text-blue-800 leading-relaxed">
                      <p className="font-bold mb-1">Analysis Tip:</p>
                      This chart shows the specific reasons why this user's work is being revised (if Drafter) or rejected (if Requester). Use this to identify training gaps or communication issues.
                    </div>
                  </div>
                </div>

                {/* COLUMN 2: PROBLEMATIC TICKETS */}
                <div className="lg:col-span-2">
                  <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm h-full flex flex-col">
                    <h3 className="font-bold text-slate-900 mb-4 flex items-center text-sm uppercase tracking-wide">
                      <FileText className="w-4 h-4 mr-2 text-blue-500" />
                      Tickets Requiring Attention
                    </h3>
                    <div className="flex-1 overflow-hidden">
                      {userProfile.tickets.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-slate-400">
                          <CheckCircle2 className="w-12 h-12 mb-3 text-green-100" />
                          <p>No revisions found! Perfect record.</p>
                        </div>
                      ) : (
                        <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                          {userProfile.tickets.map(t => (
                            <div key={t.id} className="flex items-center justify-between p-3 border border-slate-100 rounded-lg hover:border-blue-200 hover:bg-blue-50/50 transition-all group">
                              <div className="min-w-0">
                                <div className="flex items-center mb-1">
                                  <span className="text-xs font-mono font-bold text-slate-500 mr-2">{t.ticketId}</span>
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${t.status === 'CLOSED' ? 'bg-slate-100 text-slate-500 border-slate-200' : 'bg-green-100 text-green-700 border-green-200'}`}>{t.status}</span>
                                </div>
                                <p className="text-sm font-bold text-slate-900 truncate pr-4">{t.title}</p>
                              </div>
                              <div className="flex items-center space-x-4 shrink-0">
                                <div className="text-right">
                                  <p className="text-[10px] font-bold text-slate-400 uppercase">Revisions</p>
                                  <p className="text-lg font-black text-orange-600">{t.revisionCount}</p>
                                </div>
                                <Link href={`/requests/${t.id}`} target="_blank">
                                  <button className="p-2 bg-white border border-slate-200 text-slate-400 hover:text-blue-600 hover:border-blue-200 rounded-lg shadow-sm transition-all">
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
          </div>
        </div>
      )}


      {/* HEADER */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center">
          <BarChart3 className="w-8 h-8 mr-3 text-orange-600" />
          System Analytics
        </h1>
        <p className="text-slate-500 mt-1">Real-time performance metrics for Document Control and Drafting Operations.</p>
      </div>

      {/* KPI GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Total Requests */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start mb-4">
            <div><p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total Requests</p><h3 className="text-3xl font-black text-slate-900 mt-1">{metrics.totalTickets}</h3></div>
            <div className="p-2 bg-blue-50 text-blue-600 rounded-lg"><FileText className="w-5 h-5" /></div>
          </div>
          <div className="flex items-center text-xs font-medium text-slate-500">
            <span className="text-green-600 flex items-center mr-2"><ArrowUpRight className="w-3 h-3 mr-1" /> +{metrics.volumeData[metrics.volumeData.length-1]?.count || 0}</span> recent
          </div>
        </div>

        {/* Managed Docs */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start mb-4">
            <div><p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Managed Documents</p><h3 className="text-3xl font-black text-slate-900 mt-1">{metrics.totalDocs}</h3></div>
            <div className="p-2 bg-purple-50 text-purple-600 rounded-lg"><Server className="w-5 h-5" /></div>
          </div>
          <div className="flex items-center text-xs font-medium text-slate-500"><span className="text-slate-700 font-bold mr-1">{metrics.issuedDocs}</span> Issued • <span className="text-slate-700 font-bold mx-1">{metrics.supersededDocs}</span> Superseded</div>
        </div>

        {/* First Time Quality */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start mb-4">
            <div><p className="text-xs font-bold text-slate-400 uppercase tracking-wider">First-Time Quality</p><h3 className="text-3xl font-black text-slate-900 mt-1">{formatPercent(1 - metrics.globalRevisionRate)}</h3></div>
            <div className={`p-2 rounded-lg ${metrics.globalRevisionRate > 0.3 ? 'bg-amber-50 text-amber-600' : 'bg-green-50 text-green-600'}`}><CheckCircle2 className="w-5 h-5" /></div>
          </div>
          <div className="w-full bg-slate-100 h-1.5 rounded-full mt-2 overflow-hidden"><div className={`h-full rounded-full ${metrics.globalRevisionRate > 0.3 ? 'bg-amber-500' : 'bg-green-500'}`} style={{ width: `${(1 - metrics.globalRevisionRate) * 100}%` }} /></div>
        </div>

        {/* Stale Tickets */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex justify-between items-start mb-4">
            <div><p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Stale Tickets</p><h3 className="text-3xl font-black text-slate-900 mt-1">{metrics.staleTickets}</h3></div>
            <div className="p-2 bg-amber-50 text-amber-600 rounded-lg"><Clock className="w-5 h-5" /></div>
          </div>
          <p className="text-xs text-slate-500">Active tickets untouched for &gt;7 days.</p>
        </div>
      </div>

      {/* SECTION 2: CHARTS & LISTS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* CHART: DYNAMIC VOLUME */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-bold text-slate-900 flex items-center"><TrendingUp className="w-5 h-5 mr-2 text-slate-400" /> Request Volume</h3>
            <div className="flex bg-slate-100 rounded-lg p-1 space-x-1">
              {(['1M', '3M', '6M', '1Y'] as TimeRange[]).map(r => (
                <button 
                  key={r} 
                  onClick={() => setTimeRange(r)}
                  className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${timeRange === r ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div className="h-64 flex items-end justify-between space-x-2 px-4 pt-8 border-b border-slate-100 pb-2">
            {metrics.volumeData.map((d, i) => {
              const max = Math.max(...metrics.volumeData.map(v => v.count), 1); 
              const height = (d.count / max) * 100;
              return (
                <div key={i} className="flex flex-col items-center flex-1 group min-w-[20px]">
                  <div className="w-full bg-slate-100 rounded-t-sm relative flex items-end justify-center transition-all group-hover:bg-slate-200" style={{ height: '100%' }}>
                    <div 
                      className="w-full mx-0.5 bg-orange-500 rounded-t-sm transition-all duration-500 ease-out group-hover:bg-orange-600 relative min-h-[4px]" 
                      style={{ height: `${height}%` }}
                    >
                       <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs font-bold text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity bg-white px-2 py-1 rounded shadow-sm z-10 border border-slate-200">{d.count}</span>
                    </div>
                  </div>
                  <span className="text-[9px] font-bold text-slate-400 mt-2 uppercase tracking-wider truncate w-full text-center">{d.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* WIDGET: ROOT CAUSE ANALYSIS */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 flex flex-col">
          <div className="mb-6">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold text-slate-900 flex items-center"><HelpCircle className="w-5 h-5 mr-2 text-slate-400" /> Root Cause Analysis</h3>
                <p className="text-xs text-slate-500 mt-1">Click on a category to see associated tickets.</p>
              </div>
              <span className="bg-orange-50 text-orange-600 text-[10px] font-bold px-2 py-1 rounded-lg border border-orange-100 animate-pulse flex items-center">
                <MousePointerClick className="w-3 h-3 mr-1" /> Interactive
              </span>
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
            {metrics.rootCauseData.length === 0 ? (
               <div className="flex flex-col items-center justify-center h-48 text-center">
                 <AlertTriangle className="w-8 h-8 text-slate-200 mb-2" />
                 <p className="text-xs text-slate-400">No revision data available yet.</p>
               </div>
            ) : (
               <div className="space-y-4">
                  {metrics.rootCauseData.map((item, i) => (
                    <div 
                      key={i} 
                      onClick={() => setSelectedReason(item.reason)}
                      className="cursor-pointer hover:bg-slate-50 p-2 rounded-lg transition-colors group"
                    >
                      <div className="flex justify-between text-xs font-bold text-slate-700 mb-1 group-hover:text-orange-700">
                        <span className="flex items-center">
                          {item.reason}
                          <ChevronRight className="w-3 h-3 ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-orange-400" />
                        </span>
                        <span>{item.count} ({formatPercent(item.percentage)})</span>
                      </div>
                      <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full transition-colors ${
                            item.reason.includes('Drafter') || item.reason.includes('Drafting') ? 'bg-orange-500 group-hover:bg-orange-600' :
                            item.reason.includes('Requester') || item.reason.includes('Info') ? 'bg-blue-500 group-hover:bg-blue-600' :
                            'bg-slate-500 group-hover:bg-slate-600'
                          }`} 
                          style={{ width: `${item.percentage * 100}%` }} 
                        />
                      </div>
                    </div>
                  ))}
               </div>
            )}
          </div>
          <div className="mt-6 pt-4 border-t border-slate-100">
             <div className="flex items-center justify-between text-[10px] text-slate-400 uppercase tracking-wider font-bold">
               <span>Total Revisions Logged</span>
               <span>{metrics.rootCauseData.reduce((acc, curr) => acc + curr.count, 0)}</span>
             </div>
          </div>
        </div>
      </div>

      {/* SECTION 3: PERFORMANCE TABLE */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/50 flex justify-between items-center">
          <div>
            <h3 className="font-bold text-slate-900 flex items-center"><Users className="w-5 h-5 mr-2 text-slate-400" /> {viewMode === 'drafter' ? 'Drafter Performance' : 'Requester Quality'}</h3>
            <p className="text-xs text-slate-500 mt-1 flex items-center"><MousePointerClick className="w-3 h-3 mr-1" /> Click on a user row to investigate performance factors.</p>
          </div>
          <div className="flex bg-slate-200 rounded-lg p-1 space-x-1">
             <button onClick={() => setViewMode('drafter')} className={`px-3 py-1.5 text-xs font-bold rounded transition-all ${viewMode === 'drafter' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>Drafters</button>
             <button onClick={() => setViewMode('requester')} className={`px-3 py-1.5 text-xs font-bold rounded transition-all ${viewMode === 'requester' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>Requesters</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 text-slate-500 uppercase font-bold text-xs">
              <tr>
                <th className="px-6 py-3">{viewMode === 'drafter' ? 'Drafter' : 'Requester'}</th>
                <th className="px-6 py-3">Assigned Load</th>
                <th className="px-6 py-3">Completed</th>
                <th className="px-6 py-3">Avg Revisions</th>
                <th className="px-6 py-3">Revision Rate</th>
                <th className="px-6 py-3 text-right">Efficiency Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(viewMode === 'drafter' ? metrics.drafterStats : metrics.requesterStats).length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-slate-400 italic">No data available for this view.</td></tr>
              ) : (viewMode === 'drafter' ? metrics.drafterStats : metrics.requesterStats).map((d) => {
                // Efficiency Score Calculation
                const score = Math.max(0, 100 - (d.revisionRate * 100 * 0.5) - (d.avgRevisions * 10));
                
                return (
                  <tr 
                    key={d.uid} 
                    onClick={() => setSelectedUser(d.uid)}
                    className="hover:bg-blue-50/50 transition-colors cursor-pointer group"
                  >
                    <td className="px-6 py-4 font-bold text-slate-700 flex items-center group-hover:text-blue-600">
                      <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center mr-3 text-xs text-slate-500 group-hover:bg-blue-100 group-hover:text-blue-600">{d.name.charAt(0)}</div>
                      {d.name}
                    </td>
                    <td className="px-6 py-4 font-mono text-slate-600">{d.totalAssigned}</td>
                    <td className="px-6 py-4 font-mono text-slate-600">{d.completed}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center">
                        <span className={`font-bold mr-2 ${d.avgRevisions > 2 ? 'text-amber-500' : 'text-slate-700'}`}>{d.avgRevisions.toFixed(1)}</span>
                        <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                           <div className={`h-full rounded-full ${d.avgRevisions > 2 ? 'bg-amber-400' : 'bg-blue-400'}`} style={{ width: `${Math.min(100, d.avgRevisions * 20)}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                       <span className={`px-2 py-1 rounded text-xs font-bold ${d.revisionRate > 0.3 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                         {formatPercent(d.revisionRate)}
                       </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                       <span className="font-black text-slate-900 text-lg group-hover:text-blue-600">{score.toFixed(0)}</span>
                       <span className="text-xs text-slate-400 ml-1">/ 100</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
