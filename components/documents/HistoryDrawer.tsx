"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, History, Shield, Eye, FileDiff, CheckCircle2, Lock, Clock, Users, ArrowRight, Activity as ActivityIcon } from "lucide-react";
import type { DocumentRecord, DocumentVersion, CheckoutSession } from "@/types/schema";
import { AuditEntry } from "@/lib/audit";
import { supabase } from "@/lib/supabase";
import SecureDocViewer from "@/components/viewers/SecureDocViewer";
import TimelineFeed from "@/components/documents/TimelineFeed";
import RevisionChainStrip from "@/components/documents/RevisionChainStrip";
import ReverseConfirmModal from "@/components/documents/lifecycle/ReverseConfirmModal";
import { useRole } from "@/components/providers/RoleContext";
import { getDocumentTimeline, type TimelineEvent } from "@/lib/timeline";

interface HistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  docRecord: DocumentRecord;
}

function formatFirestoreTimestamp(value: unknown, withTime = false): string {
  if (!value) return "-";
  try {
    const d = value instanceof Date ? value : new Date(value as string | number);
    if (isNaN(d.getTime())) return "-";
    return withTime ? d.toLocaleString() : d.toLocaleDateString();
  } catch {
    return "-";
  }
}

export default function HistoryDrawer({ isOpen, onClose, docRecord }: HistoryDrawerProps) {
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [sessions, setSessions] = useState<CheckoutSession[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  // Phase 3 — Timeline tab is the default. Existing segmented tabs
  // (Revision History, Checkout Log, Audit Log) preserved for users
  // who want the focused view.
  const [tab, setTab] = useState<'timeline' | 'history' | 'checkouts' | 'audit'>('timeline');
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState<boolean>(false);
  const [reverseTarget, setReverseTarget] = useState<TimelineEvent | null>(null);
  const { uid, userEmail, activeRole } = useRole();
  const isReverseAuthorized = activeRole === "Admin" || activeRole === "DocCtrl";
  const [loading, setLoading] = useState<boolean>(true);
  const [activeSnapshot, setActiveSnapshot] = useState<DocumentVersion | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const headerSubtitle = useMemo(() => {
    const docNum = docRecord?.documentNumber ?? "";
    const title = docRecord?.title ?? "";
    return { docNum, title };
  }, [docRecord?.documentNumber, docRecord?.title]);

  const fetchData = useCallback(async (recordId: string, orgId: string, isStillValid: () => boolean) => {
    setLoading(true);
    try {
      const [vRes, sRes, aRes] = await Promise.all([
        supabase.from("document_versions").select("*").eq("org_id", orgId).eq("record_id", recordId).order("created_at", { ascending: false }),
        supabase.from("checkout_sessions").select("*").eq("org_id", orgId).eq("document_id", recordId).order("started_at", { ascending: false }),
        supabase.from("audit_logs").select("*").eq("org_id", orgId).eq("resource_id", recordId).order("timestamp", { ascending: false }),
      ]);

      if (!isStillValid()) return;

      setVersions((vRes.data || []).map(r => ({
        id: r.id, orgId: r.org_id, libraryId: r.library_id, documentId: r.document_id,
        recordId: r.record_id, revisionLabel: r.revision_label, fileUrl: r.file_url,
        fileKey: r.file_key, fileName: r.file_name, fileSize: r.file_size,
        changeType: r.change_type, changeLog: r.change_log, createdAt: r.created_at,
        createdBy: r.created_by ?? '', createdByName: r.created_by_name, status: r.status,
      } as unknown as DocumentVersion)));

      setSessions((sRes.data || []).map(r => ({
        id: r.id, orgId: r.org_id, documentId: r.document_id, libraryId: r.library_id,
        userId: r.user_id, userName: r.user_name, mode: r.mode, note: r.note,
        status: r.status, startedAt: r.started_at, lastSeenAt: r.last_seen_at, endedAt: r.ended_at,
      } as CheckoutSession)));

      setAuditLogs((aRes.data || []).map(r => ({
        action: r.action, resourceId: r.resource_id, resourceType: r.resource_type,
        orgId: r.org_id, userId: r.user_id, userEmail: r.user_email,
        userRole: r.user_role, details: r.details, timestamp: r.timestamp,
      } as AuditEntry)));
    } catch (e) {
      console.error("Data load failed", e);
      if (isStillValid()) {
        setVersions([]);
        setSessions([]);
        setAuditLogs([]);
      }
    } finally {
      if (isStillValid()) setLoading(false);
    }
  }, []);

  // Load history when opening (and only for current doc id)
  useEffect(() => {
    if (!isOpen) return;
    if (!docRecord?.id || !docRecord?.orgId) return;

    let alive = true;
    const isStillValid = () => alive && isOpen && !!docRecord?.id;

    void fetchData(docRecord.id, docRecord.orgId, isStillValid);

    return () => {
      alive = false;
    };
  }, [isOpen, docRecord?.id, docRecord?.orgId, fetchData]);

  // Phase 3 — fetch the unified timeline in parallel with the
  // segmented per-tab data. Cheap; same audit_logs and
  // document_versions queries, plus a small scope read.
  useEffect(() => {
    if (!isOpen || !docRecord?.id) return;
    let alive = true;
    setTimelineLoading(true);
    getDocumentTimeline({ documentId: docRecord.id, limit: 100 })
      .then((evts) => { if (alive) setTimelineEvents(evts); })
      .catch(() => { if (alive) setTimelineEvents([]); })
      .finally(() => { if (alive) setTimelineLoading(false); });
    return () => { alive = false; };
  }, [isOpen, docRecord?.id]);

  // ESC closes drawer (snapshot first, then drawer)
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (activeSnapshot) {
        setActiveSnapshot(null);
        return;
      }
      onClose();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, activeSnapshot, onClose]);

  if (!isOpen) return null;

  return (
    <>
      {/* BACKDROP */}
      <div
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] animate-in fade-in duration-300"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* DRAWER PANEL */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Audit Trail"
        className="fixed inset-y-0 right-0 w-[600px] bg-white shadow-2xl z-[70] flex flex-col animate-in slide-in-from-right duration-300 border-l border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER */}
        <div className="h-16 border-b border-slate-200 flex items-center justify-between px-6 bg-slate-50/80 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center">
              <History className="w-5 h-5 mr-2 text-blue-600" />
              Audit Trail
            </h2>
            <div className="flex items-center text-xs text-slate-500 font-mono mt-0.5 space-x-2">
              <span>{headerSubtitle.docNum}</span>
              <span className="text-slate-300">/</span>
              <span>{headerSubtitle.title}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded-full text-slate-400 hover:text-slate-600 transition-colors"
            aria-label="Close"
            type="button"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* CONTENT SCROLL AREA */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-50/30 relative">
          {/* SNAPSHOT PREVIEW (IF OPEN) */}
          {activeSnapshot && (
            <div className="mb-8 bg-slate-900 rounded-xl overflow-hidden shadow-2xl border border-slate-700 h-96 flex flex-col animate-in zoom-in-95 duration-200 ring-4 ring-slate-100">
              <div className="bg-slate-800 px-4 py-2 flex justify-between items-center shrink-0 border-b border-slate-700">
                <span className="text-xs font-bold text-white flex items-center">
                  <Shield className="w-3 h-3 mr-1.5 text-orange-500" />
                  SNAPSHOT: Rev {activeSnapshot.revisionLabel}
                  <span className="ml-2 text-slate-500 font-mono text-[10px]">
                    {formatFirestoreTimestamp(activeSnapshot.createdAt, true)}
                  </span>
                </span>
                <button
                  onClick={() => setActiveSnapshot(null)}
                  className="text-slate-400 hover:text-white bg-slate-700 hover:bg-slate-600 rounded p-1 transition-colors"
                  aria-label="Close snapshot preview"
                  type="button"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 relative bg-slate-950">
                <SecureDocViewer
                  url={activeSnapshot.fileUrl}
                  title={`ARCHIVE - ${docRecord.title}`}
                  docNumber={docRecord.documentNumber ?? ""}
                  rev={activeSnapshot.revisionLabel}
                  zoomLevel={60}
                  watermarkText="OBSOLETE - SUPERSEDED"
                />
              </div>
            </div>
          )}

          {/* CURRENT LIVE STATE */}
          <div className="mb-10 relative">
            <div className="absolute left-[15px] top-8 bottom-[-20px] w-0.5 bg-slate-200" />
            <div className="flex items-start relative">
              <div className="w-8 h-8 rounded-full bg-green-100 border-2 border-green-500 flex items-center justify-center shrink-0 z-10 mr-4 shadow-sm ring-4 ring-white">
                <div className="w-2.5 h-2.5 bg-green-600 rounded-full animate-pulse" />
              </div>
              <div className="flex-1 bg-white border border-green-200 rounded-xl p-4 shadow-sm">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Current Live Version</h3>
                    <p className="text-xs text-slate-500 font-medium">
                      Rev {docRecord.rev} / {docRecord.status}
                    </p>
                  </div>
                  <span className="px-2 py-1 bg-green-50 text-green-700 text-[10px] font-bold uppercase rounded border border-green-100 flex items-center">
                    <CheckCircle2 className="w-3 h-3 mr-1" /> Active
                  </span>
                </div>
                {docRecord.checkedOutBy && (
                  <div className="mt-2 p-2 bg-red-50 border border-red-100 rounded-lg flex items-center text-xs text-red-700 font-bold">
                    <Lock className="w-3 h-3 mr-2" />
                    Checked Out by {docRecord.checkedOutByName || "User"}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* TABS */}
          <div className="flex border-b border-slate-200 mb-6">
            <button
              onClick={() => setTab('timeline')}
              className={`flex-1 pb-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${tab === 'timeline' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >
              Timeline
            </button>
            <button
              onClick={() => setTab('history')}
              className={`flex-1 pb-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${tab === 'history' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >
              Revision History
            </button>
            <button
              onClick={() => setTab('checkouts')}
              className={`flex-1 pb-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${tab === 'checkouts' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >
              Checkout Log
            </button>
            <button
              onClick={() => setTab('audit')}
              className={`flex-1 pb-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${tab === 'audit' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >
              Audit Log
            </button>
          </div>

          {tab === 'timeline' ? (
            <div className="space-y-4">
              {docRecord.id && <RevisionChainStrip documentId={docRecord.id} />}
              {timelineLoading ? (
                <div className="flex justify-center p-8">
                  <div className="w-6 h-6 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin" />
                </div>
              ) : (
                <TimelineFeed
                  events={timelineEvents}
                  showScope={false}
                  emptyMessage="No history yet for this document."
                  onReverseRequest={isReverseAuthorized ? (e) => setReverseTarget(e) : undefined}
                />
              )}
            </div>
          ) : loading ? (
            <div className="flex justify-center p-8">
              <div className="w-8 h-8 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin" />
            </div>
          ) : tab === 'history' ? (
            versions.length === 0 ? (
            <div className="text-center p-8 border-2 border-dashed border-slate-200 rounded-xl">
              <History className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-400 font-medium">No previous revisions found.</p>
            </div>
            ) : (
            <div className="space-y-8 relative pb-12">
              <div className="absolute left-[15px] top-0 bottom-0 w-0.5 bg-slate-200" />

              {versions.map((ver) => (
                <div key={ver.id} className="flex items-start relative group">
                  {/* Revision Bubble */}
                  <div className="w-8 h-8 rounded-full bg-white border-2 border-slate-300 flex items-center justify-center shrink-0 z-10 mr-4 group-hover:border-blue-500 group-hover:scale-110 transition-all shadow-sm ring-4 ring-white text-[10px] font-bold text-slate-600">
                    {ver.revisionLabel}
                  </div>

                  <div className="flex-1 bg-white border border-slate-200 rounded-xl p-0 shadow-sm hover:shadow-md transition-all hover:border-blue-300 overflow-hidden">
                    {/* Card Header */}
                    <div className="px-4 py-3 border-b border-slate-50 bg-slate-50/50 flex justify-between items-center">
                      <div className="flex items-center space-x-2">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase ${
                            ver.changeType === "Major"
                              ? "bg-orange-50 text-orange-700 border-orange-100"
                              : "bg-slate-100 text-slate-600 border-slate-200"
                          }`}
                        >
                          {ver.changeType || "Revision"}
                        </span>
                        <span className="text-xs text-slate-400 font-mono">
                          {formatFirestoreTimestamp(ver.createdAt)}
                        </span>
                      </div>
                      <button
                        onClick={() => setActiveSnapshot(ver)}
                        className="flex items-center text-[10px] font-bold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
                        type="button"
                      >
                        <Eye className="w-3 h-3 mr-1" /> View Snapshot
                      </button>
                    </div>

                    {/* Card Body */}
                    <div className="p-4">
                      <p className="text-sm text-slate-700 font-medium mb-3">
                        {ver.changeLog || "No description provided."}
                      </p>

                      {/* Asset Impact Analysis (Visual Diff) */}
                      <div className="mt-3 p-3 bg-slate-50 rounded-lg border border-slate-100 text-xs">
                        <div className="flex items-center text-slate-400 font-bold uppercase text-[9px] mb-2">
                          <FileDiff className="w-3 h-3 mr-1" /> Automated Impact Analysis
                        </div>
                        <div className="flex gap-2">
                          <span className="text-green-600 font-medium">+ Updated File Source</span>
                          <span className="text-slate-300">|</span>
                          <span className="text-slate-500">
                            User: {ver.createdByName || "System"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            )
          ) : tab === 'checkouts' ? (
            // CHECKOUT LOGS
            sessions.length === 0 ? (
              <div className="text-center p-8 border-2 border-dashed border-slate-200 rounded-xl">
                <Clock className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                <p className="text-sm text-slate-400 font-medium">No checkout history found.</p>
              </div>
            ) : (
               <div className="space-y-4">
                 {sessions.map(s => (
                   <div key={s.id} className={`border rounded-xl p-4 bg-white ${s.status === 'active' ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-200'}`}>
                      {/* Session Details */}
                      <div className="flex justify-between items-start mb-2">
                         <div className="flex items-center gap-2">
                           <div className={`p-1.5 rounded-full ${s.status === 'active' ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'}`}>
                             <Users className="w-3 h-3" />
                           </div>
                           <div>
                             <p className="text-sm font-bold text-slate-900 leading-none">{s.userName}</p>
                             <p className="text-[10px] text-slate-400 uppercase mt-0.5">{s.mode}</p>
                           </div>
                         </div>
                         <span className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase ${s.status === 'active' ? 'bg-green-50 text-green-700 border-green-100' : 'bg-slate-50 text-slate-500 border-slate-100'}`}>
                           {s.status === 'checked_in' ? 'Checked In' : s.status}
                         </span>
                      </div>
                      <div className="text-xs text-slate-500 space-y-1 ml-9">
                         <div className="flex items-center gap-2">
                           <ArrowRight className="w-3 h-3 text-slate-300" />
                           <span>Started: {formatFirestoreTimestamp(s.startedAt, true)}</span>
                         </div>
                         {s.endedAt && (
                           <div className="flex items-center gap-2">
                             <CheckCircle2 className="w-3 h-3 text-green-500" />
                             <span>Ended: {formatFirestoreTimestamp(s.endedAt, true)}</span>
                           </div>
                         )}
                         {s.note && (
                           <div className="mt-2 p-2 bg-slate-50 rounded text-slate-600 italic border border-slate-100">
                             "{s.note}"
                           </div>
                         )}
                      </div>
                   </div>
                 ))}
               </div>
            )
          ) : (
            // AUDIT LOG TAB
            auditLogs.length === 0 ? (
              <div className="text-center p-8 border-2 border-dashed border-slate-200 rounded-xl">
                <Shield className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                <p className="text-sm text-slate-400 font-medium">No audit logs found.</p>
              </div>
            ) : (
              <div className="space-y-0 border rounded-xl overflow-hidden">
                {auditLogs.map((log: any, i) => (
                  <div key={i} className="p-4 border-b border-slate-100 bg-white last:border-0 hover:bg-slate-50 transition-colors">
                    <div className="flex justify-between items-start mb-1">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase 
                        ${log.action === 'FORCE_RELEASE' ? 'bg-red-50 text-red-700 border-red-100' : 
                          log.action === 'CHECK_OUT' ? 'bg-blue-50 text-blue-700 border-blue-100' :
                          log.action === 'VIEW' ? 'bg-slate-100 text-slate-600 border-slate-200' :
                          'bg-gray-50 text-gray-600 border-gray-200'
                        }`}>
                        {log.action.replace('_', ' ')}
                      </span>
                      <span className="text-xs text-slate-400 font-mono">
                        {formatFirestoreTimestamp(log.timestamp, true)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <div className="w-5 h-5 rounded-full bg-slate-200 flex items-center justify-center text-[9px] font-bold text-slate-600">
                        {(log.userEmail || 'U')[0].toUpperCase()}
                      </div>
                      <span className="text-xs font-bold text-slate-700">{log.userEmail}</span>
                      <span className="text-[10px] text-slate-400">({log.userRole})</span>
                    </div>
                    {log.details && (
                      <div className="mt-2 text-xs text-slate-500 font-mono bg-slate-50 p-2 rounded">
                        {JSON.stringify(log.details)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {reverseTarget && docRecord.orgId && uid && (
        <ReverseConfirmModal
          event={reverseTarget}
          orgId={docRecord.orgId}
          actorUserId={uid}
          actorEmail={userEmail ?? undefined}
          actorRole={activeRole ?? undefined}
          onCancel={() => setReverseTarget(null)}
          onSuccess={() => {
            setReverseTarget(null);
            // Re-fetch the timeline so the reversal event shows up.
            if (docRecord?.id) {
              setTimelineLoading(true);
              getDocumentTimeline({ documentId: docRecord.id, limit: 100 })
                .then((evts) => setTimelineEvents(evts))
                .catch(() => { /* noop */ })
                .finally(() => setTimelineLoading(false));
            }
          }}
        />
      )}
    </>
  );
}