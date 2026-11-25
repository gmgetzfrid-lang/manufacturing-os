"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, History, Shield, Eye, Lock, Clock } from "lucide-react";
import type { DocumentRecord, DocumentVersion, CheckoutSession } from "@/types/schema";
import { AuditEntry } from "@/lib/audit";
import { supabase } from "@/lib/supabase";
import SecureDocViewer from "@/components/viewers/SecureDocViewer";
import { shownRevision, uploadedName } from "@/lib/revisionShown";
import TimelineFeed from "@/components/documents/TimelineFeed";
import Timeline from "@/components/ui/Timeline";
import RevisionChainStrip from "@/components/documents/RevisionChainStrip";
import ReverseConfirmModal from "@/components/documents/lifecycle/ReverseConfirmModal";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { useRole } from "@/components/providers/RoleContext";
import { getDocumentTimeline, type TimelineEvent } from "@/lib/timeline";
import { escapeStackBusy } from "@/components/documents/useEscapeClose";

import { friendlyError } from "@/lib/friendlyError";
import { FieldError } from "@/components/ui/Field";
interface HistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  docRecord: DocumentRecord;
}

/** A stored time as ms (or its string) for the timeline. */
const atOf = (t: unknown): number | string => (t instanceof Date ? t.getTime() : typeof t === "number" || typeof t === "string" ? t : 0);

function formatFirestoreTimestamp(value: unknown, withTime = false): string {
  if (!value) return "-";
  try {
    const d = value instanceof Date ? value : new Date(value as string | number);
    if (isNaN(d.getTime())) return "-";
    const sameYear = d.getFullYear() === new Date().getFullYear();
    const day: Intl.DateTimeFormatOptions = sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
    return withTime ? d.toLocaleString("en-US", { ...day, hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString("en-US", day);
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
  // A failed read says so; it is never shown as "nothing here".
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [timelineErr, setTimelineErr] = useState<string | null>(null);
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
        supabase.from("document_versions").select("*").eq("org_id", orgId).eq("record_id", recordId).or("review_state.is.null,review_state.eq.approved").order("created_at", { ascending: false }),
        supabase.from("checkout_sessions").select("*").eq("org_id", orgId).eq("document_id", recordId).order("started_at", { ascending: false }),
        supabase.from("audit_logs").select("*").eq("org_id", orgId).eq("resource_id", recordId).order("timestamp", { ascending: false }),
      ]);

      if (!isStillValid()) return;
      const readErr = vRes.error ?? sRes.error ?? aRes.error;
      setLoadErr(readErr ? readErr.message : null);

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
        setLoadErr(friendlyError(e));
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
    setTimelineErr(null);
    getDocumentTimeline({ documentId: docRecord.id, limit: 100 })
      .then((evts) => { if (alive) setTimelineEvents(evts); })
      .catch((e: unknown) => { if (alive) { setTimelineEvents([]); setTimelineErr(friendlyError(e)); } })
      .finally(() => { if (alive) setTimelineLoading(false); });
    return () => { alive = false; };
  }, [isOpen, docRecord?.id]);

  // ESC closes drawer (snapshot first, then drawer)
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A dialog open over the drawer (e.g. reverse) closes first.
      if (escapeStackBusy()) return;
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
        className="fixed inset-0 bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] z-[60] animate-in fade-in duration-300"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* DRAWER PANEL */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Audit trail"
        className="fixed inset-y-0 right-0 w-[600px] max-w-[94vw] bg-[var(--color-surface)] shadow-2xl z-[70] flex flex-col animate-in slide-in-from-right duration-300 border-l border-[var(--color-border)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER */}
        <div className="h-16 border-b border-[var(--color-border)] flex items-center justify-between px-6 bg-[var(--color-surface)] shrink-0">
          <div>
            <h2 className="font-display text-section font-semibold text-[var(--color-text)] flex items-center gap-1">
              <History className="w-5 h-5 mr-2 text-[var(--color-text-muted)]" />
              Audit trail
              <HelpTooltip>
                <b>Timeline</b> shows everything that happened to this document - release / revert / supersede / hold / view / download - newest first.
                <b className="block mt-1">Revision history</b> is just the version-release events with their files and signoffs.
                <b className="block mt-1">Checkout log</b> is who&apos;s held the file and when.
                <b className="block mt-1">Audit log</b> is the raw audit_logs rows for forensic inspection.
              </HelpTooltip>
            </h2>
            <div className="flex items-center text-body text-[var(--color-text-muted)] font-display tabular-nums mt-0.5 space-x-2">
              <span>{headerSubtitle.docNum}</span>
              <span className="text-[var(--color-text-faint)]">/</span>
              <span>{headerSubtitle.title}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="ui-hit p-2 hover:bg-[var(--color-surface-2)] rounded-full text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] transition-colors"
            aria-label="Close"
            type="button"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* CONTENT SCROLL AREA */}
        <div className="flex-1 overflow-y-auto p-6 bg-[var(--color-surface-2)]/30 relative">
          {/* SNAPSHOT PREVIEW (IF OPEN) */}
          {activeSnapshot && (
            <div className="surface-charcoal mb-8 rounded-xl overflow-hidden shadow-2xl border border-[var(--color-border-strong)] h-96 flex flex-col animate-in zoom-in-95 duration-200">
              <div className="bg-[var(--color-surface)] px-4 py-2 flex justify-between items-center shrink-0 border-b border-[var(--color-border-strong)]">
                <span className="text-body font-medium text-[var(--color-text)] flex items-center">
                  <Shield className="w-3 h-3 mr-1.5 text-[var(--color-text-muted)]" />
                  SNAPSHOT: Rev {activeSnapshot.revisionLabel}
                  <span className="ml-2 text-[var(--color-text-muted)] font-display tabular-nums text-body">
                    {formatFirestoreTimestamp(activeSnapshot.createdAt, true)}
                  </span>
                </span>
                <button
                  onClick={() => setActiveSnapshot(null)}
                  className="ui-hit text-[var(--color-text-faint)] hover:text-[var(--color-text)] bg-[var(--color-surface-2)] hover:bg-[var(--color-border-strong)] rounded p-1 transition-colors"
                  aria-label="Close snapshot preview"
                  type="button"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 relative bg-[var(--color-canvas)]">
                <SecureDocViewer
                  url={activeSnapshot.fileUrl}
                  title={`ARCHIVE - ${docRecord.title}`}
                  docNumber={docRecord.documentNumber ?? ""}
                  rev={shownRevision(activeSnapshot.revisionLabel, uploadedName(docRecord)) ?? ""}
                  fileName={uploadedName(docRecord)}
                  mime={activeSnapshot.fileType}
                  zoomLevel={60}
                  watermarkText="OBSOLETE - SUPERSEDED"
                />
              </div>
            </div>
          )}

          {/* CURRENT LIVE STATE */}
          <div className="mb-10 relative">
            <div className="absolute left-[15px] top-8 bottom-[-20px] w-0.5 bg-[var(--color-border)]" />
            <div className="flex items-start relative">
              <div className="w-8 h-8 rounded-full bg-[var(--color-surface)] border-2 border-[var(--color-border-strong)] flex items-center justify-center shrink-0 z-10 mr-4 ring-4 ring-[var(--color-surface)]">
                <div className="w-2.5 h-2.5 bg-[var(--state-released)] rounded-full" />
              </div>
              <div className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-md p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h3 className="font-display text-section font-semibold text-[var(--color-text)]">Current live version</h3>
                    <p className="text-body text-[var(--color-text-muted)] font-medium">
                      Rev {docRecord.rev} / {docRecord.status}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-body font-medium text-[var(--color-text)]">
                    <span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-released)]" /> Active
                  </span>
                </div>
                {docRecord.checkedOutBy && (
                  <div className="mt-2 border-l-[3px] border-[var(--state-held)] pl-2 flex items-center text-body text-[var(--color-text)] font-medium">
                    <Lock className="w-3 h-3 mr-2" />
                    Checked out by {docRecord.checkedOutByName || "someone"}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* TABS */}
          <div className="flex border-b border-[var(--color-border)] mb-6">
            <button
              onClick={() => setTab('timeline')}
              className={`flex-1 pb-3 text-body font-medium transition-colors border-b-2 ${tab === 'timeline' ? 'border-[var(--color-text)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'}`}
            >
              Timeline
            </button>
            <button
              onClick={() => setTab('history')}
              className={`flex-1 pb-3 text-body font-medium transition-colors border-b-2 ${tab === 'history' ? 'border-[var(--color-text)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'}`}
            >
              Revision history
            </button>
            <button
              onClick={() => setTab('checkouts')}
              className={`flex-1 pb-3 text-body font-medium transition-colors border-b-2 ${tab === 'checkouts' ? 'border-[var(--color-text)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'}`}
            >
              Checkout log
            </button>
            <button
              onClick={() => setTab('audit')}
              className={`flex-1 pb-3 text-body font-medium transition-colors border-b-2 ${tab === 'audit' ? 'border-[var(--color-text)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]'}`}
            >
              Audit log
            </button>
          </div>

          {tab === 'timeline' ? (
            <div className="space-y-4">
              {docRecord.id && <RevisionChainStrip documentId={docRecord.id} />}
              {timelineLoading ? (
                <div className="flex items-center justify-center gap-2 p-8 text-body text-[var(--color-text-muted)]">
                  <div className="w-5 h-5 border-4 border-[var(--color-border)] border-t-[var(--color-border-strong)] rounded-full animate-spin" />
                  Loading the timeline…
                </div>
              ) : timelineErr ? (
                <FieldError>Couldn&apos;t load the timeline: {timelineErr}</FieldError>
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
            <div className="flex items-center justify-center gap-2 p-8 text-body text-[var(--color-text-muted)]">
              <div className="w-5 h-5 border-4 border-[var(--color-border)] border-t-[var(--color-border-strong)] rounded-full animate-spin" />
              Loading the history…
            </div>
          ) : loadErr ? (
            <FieldError>Couldn&apos;t load the history: {loadErr}</FieldError>
          ) : tab === 'history' ? (
            versions.length === 0 ? (
            <div className="text-center p-8 border-2 border-dashed border-[var(--color-border)] rounded-xl">
              <History className="w-8 h-8 text-[var(--color-text-faint)] mx-auto mb-2" />
              <p className="text-body text-[var(--color-text-muted)] font-medium">No earlier revisions yet. Each revision issued shows here.</p>
            </div>
            ) : (
            // Each revision as a history entry: by day, who as an avatar.
            <Timeline items={versions.map((ver, n) => ({
              id: ver.id ?? `rev-${n}`,
              at: atOf(ver.createdAt),
              kind: `Rev ${ver.revisionLabel || "-"}`,
              tone: "muted" as const,
              title: <span className="text-[var(--color-text-muted)]">{ver.changeType || "Revision"}</span>,
              detail: (
                <div className="grid gap-1">
                  <span className="text-body text-[var(--color-text)]">{ver.changeLog || "No description provided."}</span>
                  <span className="-ml-2">
                    <button
                      onClick={() => setActiveSnapshot(ver)}
                      className="ui-hit inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-2 rounded-md text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                      type="button"
                    >
                      <Eye className="w-3.5 h-3.5" /> View Snapshot
                    </button>
                  </span>
                </div>
              ),
              who: { uid: ver.createdBy || null, name: ver.createdByName || "System" },
            }))} />
            )
          ) : tab === 'checkouts' ? (
            // CHECKOUT LOGS
            sessions.length === 0 ? (
              <div className="text-center p-8 border-2 border-dashed border-[var(--color-border)] rounded-xl">
                <Clock className="w-8 h-8 text-[var(--color-text-faint)] mx-auto mb-2" />
                <p className="text-body text-[var(--color-text-muted)] font-medium">Nobody has checked this out yet. Each checkout shows here.</p>
              </div>
            ) : (
              // Each checkout as a history entry, when it started; who as
              // an avatar, how it ended and the note under it.
              <Timeline items={sessions.map((s, n) => ({
                id: s.id ?? `co-${n}`,
                at: atOf(s.startedAt),
                kind: s.status === 'active' ? "Checked out" : s.status === 'checked_in' ? "Checked in" : String(s.status),
                tone: s.status === 'active' ? "warn" as const : "muted" as const,
                title: <span className="text-[var(--color-text-muted)]">{s.mode}</span>,
                detail: (s.endedAt || s.note) ? (
                  <div className="grid gap-0.5">
                    {s.endedAt && <span>Ended {formatFirestoreTimestamp(s.endedAt, true)}</span>}
                    {s.note && <span className="text-body text-[var(--color-text)]">&ldquo;{s.note}&rdquo;</span>}
                  </div>
                ) : undefined,
                who: { uid: s.userId || null, name: s.userName || null },
              }))} />
            )
          ) : (
            // AUDIT LOG TAB
            auditLogs.length === 0 ? (
              <div className="text-center p-8 border-2 border-dashed border-[var(--color-border)] rounded-xl">
                <Shield className="w-8 h-8 text-[var(--color-text-faint)] mx-auto mb-2" />
                <p className="text-body text-[var(--color-text-muted)] font-medium">Nothing logged yet. Views, checkouts and changes show here.</p>
              </div>
            ) : (
              // The audit log as a history: who as an avatar (not their
              // email on every line), their role and the details under it.
              <Timeline items={auditLogs.filter((log) => !!log.timestamp).map((log, i) => ({
                id: `${i}:${log.timestamp}`,
                at: log.timestamp!,
                kind: log.action.replace('_', ' '),
                tone: log.action === 'FORCE_RELEASE' ? "bad" as const : "muted" as const,
                title: null,
                detail: (log.userRole || log.details) ? (
                  <div className="grid gap-1">
                    {log.userRole && <span>{log.userRole}</span>}
                    {log.details && <span className="font-mono break-all">{JSON.stringify(log.details)}</span>}
                  </div>
                ) : undefined,
                who: { uid: log.userId || null, email: log.userEmail ?? null },
              }))} />
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
                .then((evts) => { setTimelineEvents(evts); setTimelineErr(null); })
                .catch((e: unknown) => setTimelineErr(friendlyError(e)))
                .finally(() => setTimelineLoading(false));
            }
          }}
        />
      )}
    </>
  );
}