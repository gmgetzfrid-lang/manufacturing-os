"use client";

import React, { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { createProject, writeActivity, listProjects } from "@/lib/projects";
import type { Project } from "@/types/schema";
import ActivityThread from "@/components/documents/ActivityThread";
import MarkupRequestModal from "@/components/documents/MarkupRequestModal";
import RevUpModal from "@/components/documents/RevUpModal";
import { notifyMany } from "@/lib/inAppNotifications";
import { generateTicketNumber } from "@/lib/ticketNumber";
import {
  X,
  Clock,
  User,
  AlertTriangle,
  CheckCircle2,
  FileText,
  ArrowRight,
  Loader2,
  Shield,
  RefreshCw,
  Briefcase
} from "lucide-react";
import type { CheckoutSession, DocumentRecord, CheckoutMode } from "@/types/schema";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/providers/ToastProvider";

interface CheckoutFlowModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: DocumentRecord;
  currentUser: { uid: string; email: string | null; role: string | null };
}

export default function CheckoutFlowModal({ isOpen, onClose, document, currentUser }: CheckoutFlowModalProps) {
  const router = useRouter();
  const [activeSessions, setActiveSessions] = useState<CheckoutSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<CheckoutMode>("view");
  const [note, setNote] = useState("");

  // Project linkage state. Default to "adhoc" so quick reviews don't get
  // friction. Users explicitly opt into a project when starting real work.
  const [projectChoice, setProjectChoice] = useState<"existing" | "new" | "adhoc">("adhoc");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const [newProjectVisibility, setNewProjectVisibility] = useState<"public" | "private">("public");
  const [newProjectMoc, setNewProjectMoc] = useState("");
  const [expectedReleaseAt, setExpectedReleaseAt] = useState("");
  // Ad-hoc duration choice. 1 month is the absolute cap so an "ad-hoc"
  // checkout can never silently park a doc forever.
  const [adhocDuration, setAdhocDuration] = useState<"24h" | "3d" | "1w" | "1mo">("24h");
  
  // Check-in State
  const [checkInReason, setCheckInReason] = useState<'abandon' | 'revise' | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  // Handoff note — short message left in the activity thread so the
  // next collaborator knows where this user left off. Always optional;
  // never blocks check-in.
  const [handoffNote, setHandoffNote] = useState("");
  const [processing, setProcessing] = useState(false);
  const [showMarkupRequest, setShowMarkupRequest] = useState(false);
  const [showRevUp, setShowRevUp] = useState(false);
  const { showToast } = useToast();

  const mySession = activeSessions.find(s => s.userId === currentUser.uid);

  const handleForceUnlock = async () => {
    if (!document.id || !currentUser.uid) return;
    setProcessing(true);
    try {
      const nameToRemove = document.checkedOutByName || currentUser.email?.split('@')[0] || "User";
      const remaining = (document.activeCollaborators ?? []).filter(n => n !== nameToRemove);

      await supabase.from("documents").update({
        checked_out_by: null, checked_out_by_name: null, checked_out_at: null,
        current_lock_id: null, active_collaborators: remaining,
      }).eq("id", document.id);

      await supabase.from("checkout_messages").insert({
        org_id: document.orgId, document_id: document.id,
        text: `SYSTEM ALERT: Lock force released by ${currentUser.email}.`,
        user_id: "system", user_name: "System", lock_id: document.currentLockId,
      });

      setProcessing(false);
      onClose();
    } catch (e) {
      console.error(e);
      showToast({ type: "error", title: "Force-unlock failed", message: (e as Error).message });
      setProcessing(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !document.id || !document.orgId) return;
    let alive = true;

    const fetchSessions = async () => {
      const { data } = await supabase
        .from("checkout_sessions")
        .select("*")
        .eq("org_id", document.orgId!)
        .eq("document_id", document.id!)
        .eq("status", "active")
        .order("started_at", { ascending: false });
      if (alive) {
        setActiveSessions((data || []).map(r => ({
          id: r.id, orgId: r.org_id, documentId: r.document_id, libraryId: r.library_id,
          userId: r.user_id, userName: r.user_name, mode: r.mode, note: r.note,
          status: r.status, startedAt: r.started_at, lastSeenAt: r.last_seen_at,
        } as CheckoutSession)));
        setLoading(false);
      }
    };

    fetchSessions();
    const channel = supabase
      .channel(`modal-sessions-${document.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "checkout_sessions", filter: `document_id=eq.${document.id}` },
        () => { if (alive) fetchSessions(); })
      .subscribe();

    // Load the current user's active/visible projects so they can attach this
    // checkout to one of them. Restricted to status=active so the dropdown
    // doesn't surface cancelled/completed.
    if (document.orgId) {
      (async () => {
        try {
          const list = await listProjects({
            orgId: document.orgId!,
            status: "active",
            visibleToUserId: currentUser.uid,
          });
          if (alive) setProjects(list);
        } catch (e) {
          console.error("Failed to load projects for checkout modal", e);
        }
      })();
    }

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [isOpen, document.id, document.orgId, currentUser.uid]);

  // ActivityThread handles its own fetch + send for the document's
  // messages. No local mirroring needed here.

  const handleCheckout = async () => {
    if (!currentUser.uid || !document.orgId) return;
    setProcessing(true);
    try {
      const userName = currentUser.email?.split('@')[0] || "User";
      const lockId = document.currentLockId || crypto.randomUUID();

      // 1. Resolve project_id based on the user's choice.
      let projectId: string | null = null;
      if (projectChoice === "new") {
        if (!newProjectName.trim()) throw new Error("New project name is required");
        if (!newProjectDescription.trim()) throw new Error("New project description is required");
        const project = await createProject({
          orgId: document.orgId,
          name: newProjectName,
          description: newProjectDescription,
          visibility: newProjectVisibility,
          mocReference: newProjectMoc,
          actorUserId: currentUser.uid,
          actorEmail: currentUser.email ?? undefined,
          actorRole: currentUser.role ?? undefined,
        });
        projectId = project.id ?? null;
      } else if (projectChoice === "existing") {
        if (!selectedProjectId) throw new Error("Please pick a project");
        projectId = selectedProjectId;
      }

      // 2. Ad-hoc checkouts get a hard auto-expiry chosen by the user (max
      //    1 month). Project checkouts are unlimited — released manually or
      //    when the project ends.
      const now = new Date();
      const durationMs: Record<typeof adhocDuration, number> = {
        "24h": 24 * 60 * 60 * 1000,
        "3d":   3 * 24 * 60 * 60 * 1000,
        "1w":   7 * 24 * 60 * 60 * 1000,
        "1mo": 30 * 24 * 60 * 60 * 1000,
      };
      const autoExpiresAt = projectChoice === "adhoc"
        ? new Date(now.getTime() + durationMs[adhocDuration]).toISOString()
        : null;

      const { data: insertedSession } = await supabase.from("checkout_sessions").insert({
        org_id: document.orgId, document_id: document.id, library_id: document.libraryId,
        user_id: currentUser.uid, user_name: userName, mode, note: note || null,
        status: "active", lock_id: lockId,
        project_id: projectId,
        purpose: note || null,
        expected_release_at: expectedReleaseAt || null,
        auto_expires_at: autoExpiresAt,
      }).select("id").single();

      const newCollaborators = [...new Set([...(document.activeCollaborators ?? []), userName])];

      // Acquire the exclusive lock ATOMICALLY. We only claim it if it is
      // still free (or already ours) AT WRITE TIME — the `.or()` filter makes
      // this a conditional update. This closes the read-then-write race where
      // two people both saw "unlocked", both claimed the lock, and last-write
      // -wins left an orphaned session + a mismatched collaborator list.
      // (The active_collaborators array is still a read-modify-write; that is
      // a benign list, not the authoritative lock.)
      const { data: lockedRow } = await supabase
        .from("documents")
        .update({
          checked_out_by: currentUser.uid,
          checked_out_by_name: userName,
          checked_out_at: new Date().toISOString(),
          checkout_note: note || null,
          current_lock_id: lockId,
          active_collaborators: newCollaborators,
        })
        .eq("id", document.id!)
        .or(`checked_out_by.is.null,checked_out_by.eq.${currentUser.uid}`)
        .select("id")
        .maybeSingle();

      if (!lockedRow) {
        // Someone else holds the lock (they had it already, or won the race).
        // Join as a collaborator but do NOT seize the lock, and tell the user.
        await supabase
          .from("documents")
          .update({ active_collaborators: newCollaborators })
          .eq("id", document.id!);
        setProcessing(false);
        showToast({
          type: "warning",
          title: "Document just locked by someone else",
          message: "You've joined as a collaborator, but they hold the active checkout. Coordinate in the activity thread before editing.",
          duration: 8000,
        });
        return;
      }

      // Notify everyone else who's currently in this doc's checkout that
      // a new collaborator joined. Skip the current user (notifyMany
      // dedupes them out automatically).
      try {
        const otherUserIds = (activeSessions || [])
          .map((s) => s.userId)
          .filter((id): id is string => !!id && id !== currentUser.uid);
        if (otherUserIds.length > 0 && document.orgId && document.id) {
          void notifyMany({
            orgId: document.orgId,
            userIds: otherUserIds,
            actorUserId: currentUser.uid,
            actorName: userName,
            kind: "checkout_conflict",
            title: `${userName} joined the checkout`,
            body: `${document.documentNumber || document.title || "Document"} · Mode: ${mode}${note ? ` · "${note}"` : ""}`,
            link: `/documents/${document.libraryId}?doc=${document.id}`,
            resourceType: "document",
            resourceId: document.id,
            metadata: { mode, note },
          });
        }
      } catch (e) { console.warn("[checkout] notify-conflict failed", e); }

      // 3. Post a system activity entry on the project so the team can see
      //    a doc joined the project.
      if (projectId) {
        await writeActivity({
          projectId,
          orgId: document.orgId,
          userId: currentUser.uid,
          userName: userName,
          type: "checkout_added",
          body: `Checked out ${document.documentNumber || document.title || "a document"} (${mode})`,
          metadata: {
            documentId: document.id,
            documentNumber: document.documentNumber,
            documentTitle: document.title,
            checkoutSessionId: insertedSession?.id,
            mode,
            purpose: note,
          },
        });
      }

      setProcessing(false);
      onClose();
    } catch (e: unknown) {
      console.error(e);
      showToast({ type: "error", title: "Checkout failed", message: (e as Error).message });
      setProcessing(false);
    }
  };

  const handleCheckIn = async () => {
    if (!mySession || !checkInReason || !currentUser.uid) return;
    setProcessing(true);

    try {
      const userName = currentUser.email?.split('@')[0] || "User";

      await supabase.from("checkout_sessions").update({
        status: checkInReason === 'abandon' ? 'abandoned' : 'checked_in',
        ended_at: new Date().toISOString(),
      }).eq("id", mySession.id!);

      // Clear the lock ONLY if we still hold it at write time. The extra
      // `.eq("checked_out_by", uid)` means a concurrent force-unlock or a
      // re-checkout by another user can't have their lock cleared out from
      // under them by our stale view of `document.checkedOutBy`.
      await supabase.from("documents").update({
        checked_out_by: null, checked_out_by_name: null, checked_out_at: null,
        current_lock_id: null, checkout_note: null,
      }).eq("id", document.id!).eq("checked_out_by", currentUser.uid);

      const remaining = (document.activeCollaborators ?? []).filter(n => n !== userName);
      await supabase.from("documents").update({ active_collaborators: remaining }).eq("id", document.id!);

      // Post a handoff note FIRST so it lands before the system event —
      // makes the thread read more naturally ("here's where I left it" →
      // "I checked in").
      if (handoffNote.trim()) {
        await supabase.from("checkout_messages").insert({
          org_id: document.orgId, document_id: document.id, lock_id: document.currentLockId,
          text: handoffNote.trim(), user_id: currentUser.uid, user_name: userName,
          kind: "handoff",
        });
      }

      if (checkInReason === 'revise') {
        if (!document.orgId) throw new Error("This document has no workspace set.");
        const ticketNumber = await generateTicketNumber(document.orgId);
        const { data: ticketRow, error: ticketErr } = await supabase.from("tickets").insert({
          org_id: document.orgId,
          ticket_id: ticketNumber,
          title: `Revision Request: ${document.title}`,
          description: `Generated from Check-in. User Note: ${revisionNote}`,
          request_type: 'Revision',
          status: 'PENDING_ASSIGNMENT',
          priority: 2,
          requester_id: currentUser.uid,
          requester_name: currentUser.email?.split('@')[0] || "User",
          requester_email: currentUser.email,
          requester_role: currentUser.role,
          history: [{ action: 'Created via Check-in', user: currentUser.email, date: new Date().toISOString(), details: `Source Document: ${document.documentNumber}` }],
        }).select('id').single();
        if (ticketErr || !ticketRow) throw new Error(ticketErr?.message || "Couldn't create the revision request ticket.");

        await supabase.from("checkout_messages").insert({
          org_id: document.orgId, document_id: document.id, lock_id: document.currentLockId,
          text: `Checked in (Revision Requested). Ticket #${ticketRow?.id} created.`,
          user_id: "system", user_name: "System", kind: "system",
        });

        router.push(`/requests/${ticketRow?.id}`);
      } else {
        await supabase.from("checkout_messages").insert({
          org_id: document.orgId, document_id: document.id, lock_id: document.currentLockId,
          text: `Checked in (Abandoned).`, user_id: "system", user_name: "System", kind: "system",
        });
        onClose();
      }

      setProcessing(false);
    } catch (e: unknown) {
      console.error(e);
      showToast({ type: "error", title: "Check-in failed", message: (e as Error).message });
      setProcessing(false);
    }
  };

  if (!isOpen) return null;

  // Orphaned State: 
  // 1. I hold the lock (checkedOutBy == me) but have no active session doc (mySession is missing).
  // 2. I am in activeCollaborators list, but checkedOutBy is null (Zombie State).
  // 3. I am in activeCollaborators list, but have no session doc (Stale Collaborator).
  const isLockHolderWithoutSession = String(document.checkedOutBy) === String(currentUser.uid) && !mySession;
  const isZombieCollaborator = !document.checkedOutBy && document.activeCollaborators?.includes(currentUser.email?.split('@')[0] || "User");
  const isStaleCollaborator = document.activeCollaborators?.includes(currentUser.email?.split('@')[0] || "User") && !mySession;
  
  const isOrphaned = isLockHolderWithoutSession || isZombieCollaborator || isStaleCollaborator;

  return (
    <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
      <div className="bg-white w-full max-w-4xl h-[80vh] rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col md:flex-row">
        
        {/* LEFT: SESSION & ACTIONS */}
        <div className="flex-1 flex flex-col border-r border-slate-200 bg-slate-50">
          <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-white">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Document Checkout</h2>
              <p className="text-xs text-slate-500 truncate max-w-[200px]">{document.title}</p>
            </div>
            {/* Close button must be visible on every breakpoint — previously
                md:hidden on desktop meant a user who just wanted to PEEK at
                their own checkout had no way out without committing to a
                check-in action. */}
            <button onClick={onClose} title="Close" className="p-2 rounded-lg hover:bg-slate-100"><X className="w-5 h-5" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            
            {/* Active Sessions List */}
            <div>
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Active Collaborators</h3>
              {activeSessions.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-slate-300 text-center text-slate-400 text-sm">
                  {isOrphaned ? "Session tracking inconsistent. Please restore session below." : "No one is currently working on this file."}
                </div>
              ) : (
                <div className="space-y-2">
                  {activeSessions.map(s => (
                    <div key={s.id} className={`p-3 rounded-xl border flex items-start gap-3 ${s.userId === currentUser.uid ? 'bg-blue-50 border-blue-200 ring-1 ring-blue-100' : 'bg-white border-slate-200'}`}>
                      <div className={`p-2 rounded-full ${s.userId === currentUser.uid ? 'bg-blue-200 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                        <User className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between items-start">
                          <p className="text-sm font-bold text-slate-900">{s.userName}</p>
                          <span className="text-[10px] bg-white border border-slate-200 px-2 py-0.5 rounded-full text-slate-500 uppercase">{s.mode}</span>
                        </div>
                        {s.note && <p className="text-xs text-slate-600 mt-1 italic">&ldquo;{s.note}&rdquo;</p>}
                        <p className="text-[10px] text-slate-400 mt-2 flex items-center">
                          <Clock className="w-3 h-3 mr-1" /> Checked out just now
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ACTION AREA */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              {mySession ? (
                // CHECK IN FLOW (Existing Session)
                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-slate-900 flex items-center"><CheckCircle2 className="w-4 h-4 mr-2 text-green-600" /> You are checked out</h3>

                  {/* In-flight revision publish: while still checked out, user
                      can push a new revision (typically from CAD) without
                      first checking in. Opens RevUpModal scoped to this doc. */}
                  {(currentUser.role === 'Admin' || currentUser.role === 'DocCtrl') && (
                    <button
                      onClick={() => setShowRevUp(true)}
                      className="w-full p-3 rounded-xl border-2 border-emerald-200 hover:border-emerald-400 bg-emerald-50 text-left flex items-center gap-3 transition-all"
                    >
                      <div className="p-2 bg-emerald-500 rounded-lg text-white shrink-0">
                        <ArrowRight className="w-3.5 h-3.5" />
                      </div>
                      <div>
                        <div className="font-bold text-sm text-emerald-900">Publish a new revision</div>
                        <div className="text-[10px] text-emerald-800 leading-tight">Upload an updated PDF (e.g. from CAD) onto this document while still checked out. Captures signoffs + MOC reference.</div>
                      </div>
                    </button>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <button 
                      onClick={() => setCheckInReason('abandon')}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${checkInReason === 'abandon' ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500' : 'border-slate-100 hover:border-amber-300'}`}
                    >
                      <div className="font-bold text-sm text-slate-900 mb-1">Abandon / Cancel</div>
                      <p className="text-[10px] text-slate-500 leading-tight">Release lock without changes.</p>
                    </button>
                    <button 
                      onClick={() => setCheckInReason('revise')}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${checkInReason === 'revise' ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-slate-100 hover:border-blue-300'}`}
                    >
                      <div className="font-bold text-sm text-slate-900 mb-1">Submit Changes</div>
                      <p className="text-[10px] text-slate-500 leading-tight">Create revision request.</p>
                    </button>
                  </div>

                  {checkInReason === 'revise' && (
                    <textarea
                      value={revisionNote}
                      onChange={(e) => setRevisionNote(e.target.value)}
                      placeholder="Describe your changes or markups..."
                      className="w-full p-3 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                      rows={3}
                    />
                  )}

                  {checkInReason && (
                    <div>
                      <label className="text-[10px] font-black text-slate-600 uppercase tracking-widest">
                        Handoff note (optional)
                      </label>
                      <textarea
                        value={handoffNote}
                        onChange={(e) => setHandoffNote(e.target.value)}
                        placeholder="Where are you leaving this for the next person? e.g. &ldquo;Sheet 3 still needs vendor data, sheet 4 ready for review.&rdquo;"
                        rows={2}
                        className="mt-1 w-full p-2.5 rounded-lg border border-blue-200 bg-blue-50/40 text-xs focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        Posted to the document&apos;s activity thread so anyone still checked out (or the next person to take this on) sees it.
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleCheckIn}
                    disabled={!checkInReason || processing}
                    className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold text-sm hover:bg-slate-800 disabled:opacity-50 flex items-center justify-center"
                  >
                    {processing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ArrowRight className="w-4 h-4 mr-2" />}
                    {checkInReason === 'revise' ? 'Create Ticket & Check In' : 'Confirm Check In'}
                  </button>
                </div>
              ) : (
                // CHECK OUT FLOW (Start New Session or Recover)
                <div className="space-y-4">
                  {isOrphaned ? (
                    <div className="flex items-center gap-2 p-3 bg-blue-50 text-blue-800 rounded-lg text-xs">
                      <RefreshCw className="w-4 h-4 shrink-0" />
                      <span><strong>Session Recovery:</strong> You hold the lock, but your session data was cleared. Start a new session to continue working.</span>
                    </div>
                  ) : (
                    <h3 className="text-sm font-bold text-slate-900">Start working</h3>
                  )}

                  {/* PROJECT PICKER ─────────────────────────────────────── */}
                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase mb-1 block flex items-center gap-1.5">
                      <Briefcase className="w-3.5 h-3.5" /> Project
                    </label>
                    <div className="flex bg-slate-100 p-1 rounded-lg mb-2">
                      <button
                        onClick={() => setProjectChoice("adhoc")}
                        className={`flex-1 py-1.5 text-[11px] font-bold rounded-md transition-all ${projectChoice === "adhoc" ? "bg-white shadow text-slate-900" : "text-slate-500 hover:text-slate-700"}`}
                      >
                        Ad-hoc (24h)
                      </button>
                      <button
                        onClick={() => setProjectChoice("existing")}
                        disabled={projects.length === 0}
                        className={`flex-1 py-1.5 text-[11px] font-bold rounded-md transition-all ${projectChoice === "existing" ? "bg-white shadow text-slate-900" : "text-slate-500 hover:text-slate-700"} disabled:opacity-40 disabled:cursor-not-allowed`}
                      >
                        Existing
                      </button>
                      <button
                        onClick={() => setProjectChoice("new")}
                        className={`flex-1 py-1.5 text-[11px] font-bold rounded-md transition-all ${projectChoice === "new" ? "bg-white shadow text-slate-900" : "text-slate-500 hover:text-slate-700"}`}
                      >
                        New Project
                      </button>
                    </div>
                    {projectChoice === "adhoc" && (
                      <div className="space-y-1.5 bg-slate-50 border border-slate-200 rounded-lg p-2">
                        <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Auto-release after</div>
                        <div className="flex bg-white p-1 rounded-md border border-slate-200">
                          {([
                            { v: "24h", label: "24 hr" },
                            { v: "3d", label: "3 days" },
                            { v: "1w", label: "1 week" },
                            { v: "1mo", label: "1 month" },
                          ] as const).map((opt) => (
                            <button
                              key={opt.v}
                              onClick={() => setAdhocDuration(opt.v)}
                              className={`flex-1 py-1 text-[10px] font-bold rounded transition-colors ${
                                adhocDuration === opt.v ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-900"
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          Ad-hoc checkouts auto-release so the doc never gets stuck. Pick a window that matches what you&apos;re doing — 1 month is the cap.
                        </div>
                      </div>
                    )}
                    {projectChoice === "existing" && (
                      <select
                        value={selectedProjectId}
                        onChange={(e) => setSelectedProjectId(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                      >
                        <option value="">Select a project…</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}{p.visibility === "private" ? " 🔒" : ""}
                          </option>
                        ))}
                      </select>
                    )}
                    {projectChoice === "new" && (
                      <div className="space-y-2 bg-blue-50/50 border border-blue-200 rounded-lg p-3">
                        <input
                          value={newProjectName}
                          onChange={(e) => setNewProjectName(e.target.value)}
                          placeholder="Project name * (e.g. 2026 Q1 Turnaround)"
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                        <textarea
                          value={newProjectDescription}
                          onChange={(e) => setNewProjectDescription(e.target.value)}
                          placeholder="Description * — what's the team going to do?"
                          rows={2}
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-y"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            value={newProjectMoc}
                            onChange={(e) => setNewProjectMoc(e.target.value)}
                            placeholder="MOC ref (optional)"
                            className="px-2.5 py-1.5 border border-slate-200 rounded-md text-xs"
                          />
                          <select
                            value={newProjectVisibility}
                            onChange={(e) => setNewProjectVisibility(e.target.value as "public" | "private")}
                            className="px-2.5 py-1.5 border border-slate-200 rounded-md text-xs bg-white"
                          >
                            <option value="public">Public (visible to all)</option>
                            <option value="private">Private (members only)</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Mode</label>
                    <div className="flex bg-slate-100 p-1 rounded-lg">
                      {(['view', 'markup', 'edit'] as const).map(m => (
                        <button
                          key={m}
                          onClick={() => setMode(m)}
                          className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all capitalize ${mode === m ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Reason / Note</label>
                    <input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Updating pump specs..."
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>

                  {projectChoice !== "adhoc" && (
                    <div>
                      <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Expected release (optional)</label>
                      <input
                        type="date"
                        value={expectedReleaseAt ? expectedReleaseAt.slice(0, 10) : ""}
                        onChange={(e) => setExpectedReleaseAt(e.target.value ? new Date(e.target.value).toISOString() : "")}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                      <div className="text-[10px] text-slate-500 mt-1">
                        Helps the team know when this might be released. Stale checkouts surface a warning past this date.
                      </div>
                    </div>
                  )}
                  
                  {activeSessions.length > 0 && !isOrphaned && (
                    <div className="p-3 bg-amber-50 text-amber-800 rounded-lg text-xs flex items-start">
                      <AlertTriangle className="w-4 h-4 mr-2 shrink-0 mt-0.5" />
                      Others are currently working on this file. Coordinate via chat to avoid conflicts.
                    </div>
                  )}

                  <div className="flex gap-2">
                    {isOrphaned && (
                      <button
                        onClick={handleForceUnlock}
                        className="px-4 py-3 bg-white border border-slate-300 text-slate-700 rounded-xl font-bold text-sm hover:bg-slate-50"
                        title="Release the lock without starting a session"
                      >
                        Release Lock
                      </button>
                    )}
                    
                    <button 
                      onClick={handleCheckout}
                      disabled={processing}
                      className={`flex-1 py-3 rounded-xl font-bold text-sm flex items-center justify-center shadow-lg ${document.checkedOutBy && !isOrphaned ? 'bg-white border-2 border-blue-600 text-blue-700 hover:bg-blue-50' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-900/20'} disabled:opacity-50`}
                    >
                      {processing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Clock className="w-4 h-4 mr-2" />}
                      {isOrphaned ? "Restore Session" : document.checkedOutBy ? "Join Session" : "Check Out Now"}
                    </button>
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>

        {/* RIGHT: ACTIVITY THREAD */}
        {document.id && document.orgId && (
          <ActivityThread
            orgId={document.orgId}
            documentId={document.id}
            currentLockId={document.currentLockId ?? null}
            currentUserId={currentUser.uid}
            currentUserName={currentUser.email?.split("@")[0] || "User"}
            onRequestMarkup={() => setShowMarkupRequest(true)}
          />
        )}

      </div>

      {/* Markup request composer — opened from the activity thread */}
      {showMarkupRequest && document.orgId && document.checkedOutBy && (
        <MarkupRequestModal
          isOpen={showMarkupRequest}
          onClose={() => setShowMarkupRequest(false)}
          document={document}
          holderUserId={String(document.checkedOutBy)}
          holderUserName={document.checkedOutByName ?? undefined}
          orgId={document.orgId}
          actorUserId={currentUser.uid}
          actorEmail={currentUser.email ?? undefined}
          actorRole={currentUser.role ?? undefined}
        />
      )}

      {/* New-revision publish — inline so the user doesn't have to
          close the checkout to push an update. */}
      {showRevUp && document.orgId && document.libraryId && document.id && (
        <RevUpModal
          isOpen={showRevUp}
          onClose={() => setShowRevUp(false)}
          doc={document}
          libraryId={document.libraryId}
          orgId={document.orgId}
          actorUserId={currentUser.uid}
          actorEmail={currentUser.email ?? undefined}
          actorRole={currentUser.role ?? undefined}
          onSuccess={() => {
            setShowRevUp(false);
            // Post a system event into the thread so the rest of the
            // crew sees the new rev landed.
            void supabase.from("checkout_messages").insert({
              org_id: document.orgId,
              document_id: document.id,
              lock_id: document.currentLockId,
              text: `New revision published by ${currentUser.email?.split('@')[0] || 'someone'}.`,
              user_id: "system",
              user_name: "System",
              kind: "system",
            });
          }}
        />
      )}
    </div>
  );
}