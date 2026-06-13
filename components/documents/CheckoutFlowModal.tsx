"use client";

import React, { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { createProject, writeActivity, listProjects } from "@/lib/projects";
import type { Project } from "@/types/schema";
import ActivityThread from "@/components/documents/ActivityThread";
import CheckoutHistoryPanel from "@/components/documents/CheckoutHistoryPanel";
import MarkupRequestModal from "@/components/documents/MarkupRequestModal";
import RevUpModal from "@/components/documents/RevUpModal";
import { notifyMany } from "@/lib/inAppNotifications";
import { generateTicketNumber } from "@/lib/ticketNumber";
import { resolveTicketRecipients } from "@/lib/ticketRouting";
import {
  type CheckoutEpisode,
  getActiveEpisode,
  ensureActiveEpisode,
  adoptInFlightCheckout,
  episodeSchemaIsMissing,
  finishMySession,
  reconcileDocumentCheckoutState,
  activeCollaboratorNames,
  postEpisodeSystemMessage,
} from "@/lib/checkoutEpisodes";
import { postHandoff } from "@/lib/activityThread";
import {
  X,
  Clock,
  User,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  Loader2,
  RefreshCw,
  Briefcase
} from "lucide-react";
import type { CheckoutSession, DocumentRecord, CheckoutMode } from "@/types/schema";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/providers/ToastProvider";
import { logAuditAction } from "@/lib/audit";

// ISO-style document control: every checkout must say WHY. The category is the
// machine-readable purpose (filterable, reportable); the reason is the
// human-readable note everyone sees on the lock badge, the checkouts register,
// and the inbox.
const CHECKOUT_PURPOSES = [
  "Revision / Update",
  "Redline / Markup",
  "Review / Approval",
  "Field Reference",
  "As-Built Verification",
  "Other",
] as const;

interface CheckoutFlowModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: DocumentRecord;
  currentUser: { uid: string; email: string | null; role: string | null };
}

export default function CheckoutFlowModal({ isOpen, onClose, document, currentUser }: CheckoutFlowModalProps) {
  const router = useRouter();
  const [activeSessions, setActiveSessions] = useState<CheckoutSession[]>([]);
  const [, setLoading] = useState(true);
  const [mode, setMode] = useState<CheckoutMode>("view");
  const [note, setNote] = useState("");
  const [purposeCategory, setPurposeCategory] = useState<string>("");

  // The live checkout episode ("ticket"). null = none active. When the env
  // predates the episode migration we stay in legacy document-scoped mode.
  const [episode, setEpisode] = useState<CheckoutEpisode | null>(null);
  const [episodesSupported, setEpisodesSupported] = useState(true);

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
    if (!document.id || !document.orgId || !currentUser.uid) return;
    setProcessing(true);
    try {
      // Rebuild the document's checkout state from its ACTIVE SESSION ROWS —
      // the one true source. Heals every orphan shape: lock with no session
      // (clears it), zombie collaborator names (drops them), sessions with a
      // missing holder (transfers the lock).
      await reconcileDocumentCheckoutState(document.id, {
        orgId: document.orgId,
        actorUserId: currentUser.uid,
        actorName: currentUser.email?.split('@')[0] || "User",
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

  // Resolve the live checkout episode. If the document is mid-checkout but
  // predates the episode model (active sessions, no episode), ADOPT it so
  // the thread + close-out work; the adopted episode is backdated to the
  // senior session's start. Realtime keeps the modal in step when someone
  // else opens/closes the episode.
  useEffect(() => {
    if (!isOpen || !document.id || !document.orgId) return;
    let alive = true;

    const resolveEpisode = async () => {
      try {
        let ep = await getActiveEpisode(document.id!);
        if (!ep && !episodeSchemaIsMissing()) {
          ep = await adoptInFlightCheckout({
            orgId: document.orgId!,
            documentId: document.id!,
            libraryId: document.libraryId ?? null,
          });
        }
        if (alive) {
          setEpisode(ep);
          setEpisodesSupported(!episodeSchemaIsMissing());
        }
      } catch (e) {
        console.warn("[checkout] episode resolve failed", e);
      }
    };

    void resolveEpisode();
    const channel = supabase
      .channel(`modal-episode-${document.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "checkout_episodes", filter: `document_id=eq.${document.id}` },
        () => { if (alive) void resolveEpisode(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [isOpen, document.id, document.orgId, document.libraryId]);

  // ActivityThread handles its own fetch + send for the episode's
  // messages. No local mirroring needed here.

  const handleCheckout = async () => {
    if (!currentUser.uid || !document.orgId) return;
    // The forced flow: no checkout without a stated purpose + reason. This is
    // the document-control record every other member sees.
    if (!purposeCategory) {
      showToast({ type: "warning", title: "Purpose required", message: "Pick what you're checking this document out for." });
      return;
    }
    if (note.trim().length < 5) {
      showToast({ type: "warning", title: "Reason required", message: "Briefly describe what you'll be doing (at least 5 characters)." });
      return;
    }
    setProcessing(true);
    try {
      const userName = currentUser.email?.split('@')[0] || "User";

      // The checkout "ticket": first one in opens it, everyone after joins
      // it. Its id doubles as the lock id so chat, sessions, and the lock
      // all share one grouping key. Null only on pre-migration envs.
      const ensured = await ensureActiveEpisode({
        orgId: document.orgId,
        documentId: document.id!,
        libraryId: document.libraryId ?? null,
        userId: currentUser.uid,
        userName,
      });
      const checkoutEpisode = ensured?.episode ?? null;
      const lockId = checkoutEpisode?.id ?? document.currentLockId ?? crypto.randomUUID();

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

      const sessionRow: Record<string, unknown> = {
        org_id: document.orgId, document_id: document.id, library_id: document.libraryId,
        user_id: currentUser.uid, user_name: userName, mode, note: note.trim() || null,
        status: "active", lock_id: lockId,
        project_id: projectId,
        purpose: purposeCategory,
        expected_release_at: expectedReleaseAt || null,
        auto_expires_at: autoExpiresAt,
      };
      if (checkoutEpisode) sessionRow.episode_id = checkoutEpisode.id;
      const { data: insertedSession, error: sessionErr } = await supabase
        .from("checkout_sessions").insert(sessionRow).select("id").single();
      if (sessionErr) throw new Error(sessionErr.message);

      // Rebuild the display list from the ACTIVE SESSION ROWS (which now
      // include ours) — never patch the possibly-stale array; that's how
      // zombie collaborator names were born.
      const { data: freshSessions } = await supabase
        .from("checkout_sessions")
        .select("id, user_id, user_name, started_at")
        .eq("document_id", document.id!)
        .eq("status", "active");
      const newCollaborators = activeCollaboratorNames(
        ((freshSessions as Array<{ id: string; user_id: string; user_name: string | null; started_at: string | null }>) ?? [])
          .map((r) => ({ id: r.id, userId: String(r.user_id), userName: r.user_name, startedAt: r.started_at })),
      );
      if (!newCollaborators.includes(userName)) newCollaborators.push(userName);

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
          checkout_note: `${purposeCategory} — ${note.trim()}`,
          current_lock_id: lockId,
          active_collaborators: newCollaborators,
        })
        .eq("id", document.id!)
        .or(`checked_out_by.is.null,checked_out_by.eq.${currentUser.uid}`)
        .select("id")
        .maybeSingle();

      if (!lockedRow) {
        // Someone else holds the lock (they had it already, or won the race).
        // Join THEIR episode as a collaborator — do NOT seize the lock.
        await supabase
          .from("documents")
          .update({ active_collaborators: newCollaborators })
          .eq("id", document.id!);
        await postEpisodeSystemMessage({
          orgId: document.orgId,
          documentId: document.id!,
          episodeId: checkoutEpisode?.id ?? null,
          text: `${userName} joined the checkout — ${purposeCategory}: "${note.trim()}".`,
        });
        // Tell the crew already on this checkout — especially the lock
        // holder — that someone jumped on their ticket.
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
              title: `${userName} joined your checkout`,
              body: `${document.documentNumber || document.title || "Document"} · ${purposeCategory}: "${note.trim()}"`,
              link: `/documents/${document.libraryId}?doc=${document.id}`,
              resourceType: "document",
              resourceId: document.id,
              metadata: { mode, note: note.trim(), episodeId: checkoutEpisode?.id ?? null },
            });
          }
        } catch (e) { console.warn("[checkout] join notify failed", e); }
        setEpisode(checkoutEpisode);
        setProcessing(false);
        showToast({
          type: "warning",
          title: "Joined an active checkout",
          message: "Someone else holds the lock. You're on their checkout ticket now — coordinate in the thread before editing.",
          duration: 8000,
        });
        return;
      }

      // We hold the lock: open the episode's visible record in the thread.
      await postEpisodeSystemMessage({
        orgId: document.orgId,
        documentId: document.id!,
        episodeId: checkoutEpisode?.id ?? null,
        text: `${userName} checked out (${mode}) — ${purposeCategory}: "${note.trim()}".`,
      });
      setEpisode(checkoutEpisode);

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

      // Document-control audit record: who, what, why, expected return.
      await logAuditAction({
        action: "DOCUMENT_CHECKOUT", resourceId: document.id!, resourceType: "document",
        orgId: document.orgId, userId: currentUser.uid, userEmail: currentUser.email || undefined,
        userRole: currentUser.role || undefined,
        details: {
          documentNumber: document.documentNumber ?? null,
          mode, purpose: purposeCategory, reason: note.trim(),
          projectId, expectedReleaseAt: expectedReleaseAt || autoExpiresAt || null,
          sessionId: insertedSession?.id ?? null,
          episodeId: checkoutEpisode?.id ?? null,
          checkoutNumber: checkoutEpisode?.seq ?? null,
        },
      });

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

      // Close the loop in the audit trail: checkout + check-in are paired
      // records for the document-control register.
      await logAuditAction({
        action: "DOCUMENT_CHECKIN", resourceId: document.id!, resourceType: "document",
        orgId: document.orgId, userId: currentUser.uid, userEmail: currentUser.email || undefined,
        userRole: currentUser.role || undefined,
        details: {
          documentNumber: document.documentNumber ?? null,
          outcome: checkInReason, sessionId: mySession.id ?? null,
          episodeId: episode?.id ?? null,
          checkoutNumber: episode?.seq ?? null,
          handoffNote: handoffNote.trim() || null,
        },
      });

      // Post a handoff note FIRST so it lands before the system event —
      // makes the thread read more naturally ("here's where I left it" →
      // "I checked in").
      if (handoffNote.trim()) {
        await postHandoff({
          orgId: document.orgId!, documentId: document.id!,
          lockId: document.currentLockId ?? null, episodeId: episode?.id ?? null,
          userId: currentUser.uid, userName,
          text: handoffNote.trim(),
        });
      }

      // Settle the episode: last one out closes the ticket; if we hold the
      // lock and others remain it TRANSFERS (the checkout continues until
      // everyone is done); a non-holder just drops off the list. System
      // events for each land in the thread.
      const finish = await finishMySession({
        orgId: document.orgId!,
        documentId: document.id!,
        userId: currentUser.uid,
        userName,
        episodeId: episode?.id ?? null,
        sessionStatus: checkInReason === 'abandon' ? 'abandoned' : 'checked_in',
        releasedReason: checkInReason === 'revise' ? 'Checked in with revision request' : null,
      });
      if (finish.episodeClosed) setEpisode(null);

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

        // Tell the assignment queue (DraftingSupervisor → Admin fallback) the
        // same way a normal new request does — this fork previously created
        // the ticket silently and nobody was notified.
        void (async () => {
          try {
            const recipients = await resolveTicketRecipients(document.orgId!, 'PENDING_ASSIGNMENT', currentUser.uid);
            if (recipients.length === 0) return;
            await notifyMany({
              orgId: document.orgId!,
              userIds: recipients.map((m) => m.uid),
              actorUserId: currentUser.uid,
              actorName: currentUser.email?.split('@')[0],
              kind: 'request_pending_approval',
              title: `New drafting request: Revision Request: ${document.title}`,
              body: 'Created from a document check-in. Ready for a drafter to be assigned.',
              link: `/requests/${ticketRow.id}`,
              resourceType: 'ticket',
              resourceId: ticketRow.id as string,
            });
          } catch (e) {
            console.warn('[checkout] revision-request notify failed (non-blocking)', e);
          }
        })();

        // Attach the ticket pointer to the (possibly just-sealed) episode
        // record — the explicit id keeps it out of the NEXT checkout's thread.
        await postEpisodeSystemMessage({
          orgId: document.orgId!, documentId: document.id!,
          episodeId: episode?.id ?? null,
          text: `Revision requested at check-in — ticket ${ticketNumber} created.`,
        });

        router.push(`/requests/${ticketRow?.id}`);
      } else {
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
      <div className="bg-white w-full max-w-4xl h-[80vh] rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col md:flex-row animate-in fade-in zoom-in-95">
        
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
                            {p.name}{p.visibility === "private" ? " (private)" : ""}
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
                    <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Purpose <span className="text-rose-500">*</span></label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {CHECKOUT_PURPOSES.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setPurposeCategory(p)}
                          className={`px-2.5 py-2 rounded-lg text-xs font-bold border text-left transition-all ${
                            purposeCategory === p
                              ? "bg-blue-600 border-blue-600 text-white shadow"
                              : "bg-white border-slate-200 text-slate-600 hover:border-blue-300 hover:bg-blue-50/40"
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Reason <span className="text-rose-500">*</span></label>
                    <input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Updating pump specs per MOC-2026-014..."
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                    <div className="text-[10px] text-slate-500 mt-1">
                      Part of the document-control record — everyone can see who has this file and why.
                    </div>
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
                      disabled={processing || !purposeCategory || note.trim().length < 5}
                      title={!purposeCategory ? "Pick a purpose first" : note.trim().length < 5 ? "Add a brief reason (5+ characters)" : undefined}
                      className={`flex-1 py-3 rounded-xl font-bold text-sm flex items-center justify-center shadow-lg ${document.checkedOutBy && !isOrphaned ? 'bg-white border-2 border-blue-600 text-blue-700 hover:bg-blue-50' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-900/20'} disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {processing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Clock className="w-4 h-4 mr-2" />}
                      {isOrphaned ? "Restore Session" : document.checkedOutBy ? "Join Session" : "Check Out Now"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Sealed records of previous checkouts: participants, who/why,
                conversation, and revisions published in each window. */}
            {document.id && document.orgId && (
              <CheckoutHistoryPanel
                orgId={document.orgId}
                documentId={document.id}
                activeEpisodeId={episode?.id ?? null}
              />
            )}

          </div>
        </div>

        {/* RIGHT: ACTIVITY THREAD (scoped to the live checkout episode) */}
        {document.id && document.orgId && (
          <ActivityThread
            orgId={document.orgId}
            documentId={document.id}
            currentLockId={episode?.id ?? document.currentLockId ?? null}
            episodeId={episodesSupported ? (episode?.id ?? null) : undefined}
            episodeSeq={episode?.seq ?? null}
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
            // Post a system event into the episode's thread so the rest of
            // the crew sees the new rev landed.
            void postEpisodeSystemMessage({
              orgId: document.orgId!,
              documentId: document.id!,
              episodeId: episode?.id ?? null,
              text: `New revision published by ${currentUser.email?.split('@')[0] || 'someone'}.`,
            });
          }}
        />
      )}
    </div>
  );
}