"use client";

import React, { useState, useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { logCheckoutEvent } from "@/lib/audit";
import { createProject, writeActivity, listProjects } from "@/lib/projects";
import type { Project } from "@/types/schema";
import {
  X,
  Clock,
  User,
  MessageSquare,
  AlertTriangle,
  CheckCircle2,
  FileText,
  ArrowRight,
  Send,
  Loader2,
  Shield,
  RefreshCw,
  Briefcase
} from "lucide-react";
import type { CheckoutSession, DocumentRecord, CheckoutMode } from "@/types/schema";
import { useRouter } from "next/navigation";

interface CheckoutFlowModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: DocumentRecord;
  currentUser: { uid: string; email: string | null; role: string | null };
}

interface ChatMessage {
  id: string;
  text: string;
  userId: string;
  userName: string;
  createdAt: any;
}

export default function CheckoutFlowModal({ isOpen, onClose, document, currentUser }: CheckoutFlowModalProps) {
  const router = useRouter();
  const [activeSessions, setActiveSessions] = useState<CheckoutSession[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<CheckoutMode>("view");
  const [note, setNote] = useState("");
  const [newMessage, setNewMessage] = useState("");

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
  
  // Check-in State
  const [checkInReason, setCheckInReason] = useState<'abandon' | 'revise' | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [processing, setProcessing] = useState(false);

  const mySession = activeSessions.find(s => s.userId === currentUser.uid);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!isOpen || !document.id || !document.orgId || !document.currentLockId) {
      setMessages([]);
      return;
    }
    let alive = true;

    const fetchMessages = async () => {
      const { data } = await supabase
        .from("checkout_messages")
        .select("*")
        .eq("org_id", document.orgId!)
        .eq("document_id", document.id!)
        .eq("lock_id", document.currentLockId!)
        .order("created_at", { ascending: true });
      if (alive) {
        setMessages((data || []).map(r => ({
          id: r.id, text: r.text, userId: r.user_id, userName: r.user_name, createdAt: r.created_at,
        } as ChatMessage)));
        setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 100);
      }
    };

    fetchMessages();
    const channel = supabase
      .channel(`modal-messages-${document.id}-${document.currentLockId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "checkout_messages", filter: `document_id=eq.${document.id}` },
        () => { if (alive) fetchMessages(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [isOpen, document.id, document.orgId, document.currentLockId]);

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !currentUser.uid || !document.currentLockId) return;
    try {
      await supabase.from("checkout_messages").insert({
        org_id: document.orgId, document_id: document.id, lock_id: document.currentLockId,
        text: newMessage.trim(), user_id: currentUser.uid,
        user_name: currentUser.email?.split('@')[0] || "User",
      });
      setNewMessage("");
    } catch (e) {
      console.error("Failed to send message", e);
    }
  };

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

      // 2. Ad-hoc checkouts get a hard 24h auto-expiry; project checkouts
      //    are unlimited (only released manually or when the project ends).
      const now = new Date();
      const autoExpiresAt = projectChoice === "adhoc"
        ? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
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
      const docUpdate: Record<string, unknown> = { active_collaborators: newCollaborators };

      if (!document.checkedOutBy || String(document.checkedOutBy) === String(currentUser.uid)) {
        docUpdate.checked_out_by = currentUser.uid;
        docUpdate.checked_out_by_name = userName;
        docUpdate.checked_out_at = new Date().toISOString();
        docUpdate.checkout_note = note || null;
        docUpdate.current_lock_id = lockId;
      }

      await supabase.from("documents").update(docUpdate).eq("id", document.id!);

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
      alert(`Checkout failed: ${(e as Error).message}`);
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

      if (String(document.checkedOutBy) === String(currentUser.uid)) {
        await supabase.from("documents").update({
          checked_out_by: null, checked_out_by_name: null, checked_out_at: null,
          current_lock_id: null, checkout_note: null,
        }).eq("id", document.id!);
      }

      const remaining = (document.activeCollaborators ?? []).filter(n => n !== userName);
      await supabase.from("documents").update({ active_collaborators: remaining }).eq("id", document.id!);

      if (checkInReason === 'revise') {
        const { data: ticketRow } = await supabase.from("tickets").insert({
          org_id: document.orgId,
          title: `Revision Request: ${document.title}`,
          description: `Generated from Check-in. User Note: ${revisionNote}`,
          request_type: 'Revision',
          status: 'NEW',
          priority: 2,
          requester_id: currentUser.uid,
          requester_name: currentUser.email?.split('@')[0] || "User",
          requester_email: currentUser.email,
          requester_role: currentUser.role,
          history: [{ action: 'Created via Check-in', user: currentUser.email, date: new Date().toISOString(), details: `Source Document: ${document.documentNumber}` }],
        }).select('id').single();

        await supabase.from("checkout_messages").insert({
          org_id: document.orgId, document_id: document.id, lock_id: document.currentLockId,
          text: `Checked in (Revision Requested). Ticket #${ticketRow?.id} created.`,
          user_id: "system", user_name: "System",
        });

        router.push(`/requests/${ticketRow?.id}`);
      } else {
        await supabase.from("checkout_messages").insert({
          org_id: document.orgId, document_id: document.id, lock_id: document.currentLockId,
          text: `Checked in (Abandoned).`, user_id: "system", user_name: "System",
        });
        onClose();
      }

      setProcessing(false);
    } catch (e: unknown) {
      console.error(e);
      alert(`Check-in failed: ${(e as Error).message}`);
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
      <div className="bg-white w-full max-w-4xl h-[80vh] rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col md:flex-row">
        
        {/* LEFT: SESSION & ACTIONS */}
        <div className="flex-1 flex flex-col border-r border-slate-200 bg-slate-50">
          <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-white">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Document Checkout</h2>
              <p className="text-xs text-slate-500 truncate max-w-[200px]">{document.title}</p>
            </div>
            <button onClick={onClose} className="md:hidden p-2 rounded-lg hover:bg-slate-100"><X className="w-5 h-5" /></button>
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
                        {s.note && <p className="text-xs text-slate-600 mt-1 italic">"{s.note}"</p>}
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
                      <div className="text-[10px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-2">
                        Quick look only. Auto-releases after 24 hours so it doesn&apos;t block the team.
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
                          placeholder="Short description"
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

        {/* RIGHT: CHAT */}
        <div className="w-full md:w-80 bg-white flex flex-col h-[400px] md:h-auto">
          {/* ... Chat UI ... */}
          <div className="px-4 py-3 border-b border-slate-200 flex justify-between items-center bg-white sticky top-0">
            <h3 className="text-sm font-bold text-slate-900 flex items-center"><MessageSquare className="w-4 h-4 mr-2" /> Session Chat</h3>
            <button onClick={onClose} className="hidden md:block p-2 hover:bg-slate-100 rounded-full"><X className="w-4 h-4 text-slate-400" /></button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/30" ref={scrollRef}>
            {messages.length === 0 ? (
              <div className="text-center text-slate-400 text-xs mt-10">
                {document.currentLockId ? "No messages yet." : "Start session to chat."}<br/>
              </div>
            ) : (
              messages.map(msg => (
                <div key={msg.id} className={`flex flex-col ${msg.userId === currentUser.uid ? 'items-end' : 'items-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs ${msg.userId === 'system' ? 'bg-slate-100 text-slate-500 italic mx-auto text-center border border-slate-200 w-full' : msg.userId === currentUser.uid ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-white border border-slate-200 text-slate-700 rounded-bl-sm shadow-sm'}`}>
                    {msg.userId !== currentUser.uid && msg.userId !== 'system' && <span className="block font-bold text-[10px] mb-0.5 opacity-70">{msg.userName}</span>}
                    {msg.text}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="p-3 border-t border-slate-200 bg-white">
            <div className="relative">
              <input 
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                placeholder={document.currentLockId ? "Type a message..." : "Locked until session starts"}
                disabled={!document.currentLockId}
                className="w-full pl-4 pr-10 py-2 rounded-full border border-slate-200 bg-slate-50 text-xs focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50"
              />
              <button 
                onClick={handleSendMessage}
                disabled={!newMessage.trim() || !document.currentLockId}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <Send className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}