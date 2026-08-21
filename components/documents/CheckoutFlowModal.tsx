"use client";

import React, { useState, useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { createProject, writeActivity, listProjects } from "@/lib/projects";
import type { Project } from "@/types/schema";
import ActivityThread from "@/components/documents/ActivityThread";
import CheckoutHistoryPanel from "@/components/documents/CheckoutHistoryPanel";
import MarkupRequestModal from "@/components/documents/MarkupRequestModal";
import CheckInPanel from "@/components/documents/CheckInPanel";
import { notifyMany } from "@/lib/inAppNotifications";
import {
  type CheckoutEpisode,
  getActiveEpisode,
  ensureActiveEpisode,
  adoptInFlightCheckout,
  episodeSchemaIsMissing,
  reconcileDocumentCheckoutState,
  activeCollaboratorNames,
  postEpisodeSystemMessage,
  quickHold,
} from "@/lib/checkoutEpisodes";
import { recordIntent } from "@/lib/intents";
import {
  X,
  Clock,
  User,
  AlertTriangle,
  Check,
  Loader2,
  RefreshCw,
  Briefcase,
  Zap
} from "lucide-react";
import type { CheckoutSession, DocumentRecord, CheckoutMode } from "@/types/schema";
import { useToast } from "@/components/providers/ToastProvider";
import { logCheckoutEvent } from "@/lib/audit";

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

/** "3 days ago" / "2 hours ago" / "just now" from a session timestamp. */
function formatSince(ts: unknown): string {
  const ms = typeof ts === "string" || typeof ts === "number" ? Date.parse(String(ts)) : NaN;
  if (!Number.isFinite(ms)) return "just now";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

interface CheckoutFlowModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: DocumentRecord;
  currentUser: { uid: string; email: string | null; role: string | null };
  /** Per-library publish authority (canPublishOnLibrary) — the SAME grant the
   *  inspector uses, so publish shows up in both places or neither. */
  canPublish?: boolean;
  /** The document's folder-name chain — threads through to RevUpModal so a
   *  revision published from check-in lands under the same storage prefix as
   *  every other publish of the document. */
  folderPath?: string[];
}

export default function CheckoutFlowModal({ isOpen, onClose, document, currentUser, canPublish = false, folderPath }: CheckoutFlowModalProps) {
  const [activeSessions, setActiveSessions] = useState<CheckoutSession[]>([]);
  const [, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [purposeCategory, setPurposeCategory] = useState<string>("");
  // "Options" fold — project linkage + timing live behind it so the default
  // path is two fields and one button. Friction is why people skip systems.
  const [showOptions, setShowOptions] = useState(false);

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
  
  const [processing, setProcessing] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const [showMarkupRequest, setShowMarkupRequest] = useState(false);
  const { showToast } = useToast();

  // Focus follows the sequence: pick a purpose (step ①), and the cursor jumps
  // to the reason box (step ②). No autoFocus on a later step.
  const noteInputRef = useRef<HTMLInputElement>(null);
  const prevPurposeRef = useRef("");
  useEffect(() => {
    if (purposeCategory && !prevPurposeRef.current) noteInputRef.current?.focus();
    prevPurposeRef.current = purposeCategory;
  }, [purposeCategory]);

  const mySession = activeSessions.find(s => s.userId === currentUser.uid);

  // Mode is DERIVED from the purpose, never asked. A form field nothing
  // downstream enforces is a decision the user shouldn't have to make.
  const mode: CheckoutMode =
    purposeCategory === "Redline / Markup" ? "markup"
    : purposeCategory === "Revision / Update" || purposeCategory === "As-Built Verification" ? "edit"
    : "view";

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
        // purpose + episodeId MUST survive this mapping — CheckInPanel derives
        // its entire outcome card set from mySession.purpose. Dropping it here
        // silently degrades every check-in to the generic card set.
        setActiveSessions((data || []).map(r => ({
          id: r.id, orgId: r.org_id, documentId: r.document_id, libraryId: r.library_id,
          userId: r.user_id, userName: r.user_name, mode: r.mode, note: r.note,
          status: r.status, startedAt: r.started_at, lastSeenAt: r.last_seen_at,
          purpose: r.purpose, episodeId: r.episode_id,
          expectedReleaseAt: r.expected_release_at, autoExpiresAt: r.auto_expires_at,
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
    // One act, one session: never start a full checkout while a quick hold is
    // in flight or while we already hold an active session — otherwise the
    // register shows two simultaneous checkouts for one person, one act.
    if (processing || quickBusy || mySession) return;
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

      // Ambient intent: this checkout is an EDIT intent anchored to the
      // revision that is current right now — the publish contract's
      // expected-base source. Fire-and-forget.
      void recordIntent({
        orgId: document.orgId,
        documentId: document.id!,
        libraryId: document.libraryId ?? null,
        userId: currentUser.uid,
        userName,
        kind: "edit",
        source: "checkout",
        baseVersionId: document.currentVersionId ?? null,
        sessionId: (insertedSession?.id as string | undefined) ?? null,
      });

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
        // The register records JOINS too — a join is a checkout act, and a
        // later CHECK_IN with no matching CHECK_OUT is a hole in the story.
        await logCheckoutEvent({
          orgId: document.orgId, fileId: document.id!,
          userId: currentUser.uid, userEmail: currentUser.email || "unknown",
          userRole: currentUser.role || "unknown",
          type: "CHECK_OUT",
          details: {
            joined: true, documentNumber: document.documentNumber ?? null,
            mode, purpose: purposeCategory, reason: note.trim(),
            sessionId: insertedSession?.id ?? null,
            episodeId: checkoutEpisode?.id ?? null,
            checkoutNumber: checkoutEpisode?.seq ?? null,
          },
        });
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
      // One event family for the whole system — the popover, quick hold, and
      // this modal all write CHECK_OUT/CHECK_IN, so the register is one query.
      await logCheckoutEvent({
        orgId: document.orgId, fileId: document.id!,
        userId: currentUser.uid, userEmail: currentUser.email || "unknown",
        userRole: currentUser.role || "unknown",
        type: "CHECK_OUT",
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

  // One-click lightweight tier, offered INSIDE the modal too: the person who
  // opened the full form and balked still gets the honest cheap option.
  const handleQuickHold = async () => {
    if (!document.id || !document.orgId || !currentUser.uid || quickBusy || processing) return;
    setQuickBusy(true);
    try {
      const userName = currentUser.email?.split("@")[0] || "User";
      const result = await quickHold({
        orgId: document.orgId,
        documentId: document.id,
        libraryId: document.libraryId ?? null,
        currentVersionId: document.currentVersionId ?? null,
        userId: currentUser.uid,
        userName,
      });
      await logCheckoutEvent({
        orgId: document.orgId, fileId: document.id,
        userId: currentUser.uid, userEmail: currentUser.email || "unknown",
        userRole: currentUser.role || "unknown",
        type: "CHECK_OUT",
        details: { quickHold: true, autoExpires: "end of day", joined: result === "joined" },
      });
      // Honesty over convenience: a quick hold on a locked document JOINS the
      // holder's checkout — say so, same as the full-checkout path does.
      if (result === "joined") {
        showToast({
          type: "warning",
          title: "Joined an active checkout",
          message: "Someone else holds the lock — your quick hold put you on their checkout ticket. Coordinate before editing.",
          duration: 8000,
        });
      }
      setQuickBusy(false);
      onClose();
    } catch (e) {
      console.error(e);
      showToast({ type: "error", title: "Quick hold failed", message: (e as Error).message });
      setQuickBusy(false);
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

  // IDLE = nobody has this document out and nothing is broken. The modal is
  // then just the two-question form — no collaborator panel, no history, no
  // thread pane. The multi-person dashboard appears only when there IS a
  // checkout in motion. Overload is why people bounce off systems.
  // document.checkedOutBy matters too: a foreign lock with lost session rows
  // (someone ELSE's orphan) must show the full layout, not a slim form whose
  // button confusingly reads "Join Session" on an apparently idle document.
  const isIdle = activeSessions.length === 0 && !mySession && !isOrphaned && !episode && !document.checkedOutBy;

  return (
    <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
      <div className={`bg-[var(--color-surface)] w-full rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col md:flex-row animate-in fade-in zoom-in-95 ${isIdle ? "max-w-xl max-h-[88vh]" : "max-w-4xl h-[80vh]"}`}>

        {/* LEFT: SESSION & ACTIONS */}
        <div className={`flex-1 flex flex-col bg-[var(--color-surface-2)] ${isIdle ? "" : "border-r border-[var(--color-border)]"}`}>
          <div className="px-6 py-4 border-b border-[var(--color-border)] flex justify-between items-center bg-[var(--color-surface)]">
            <div>
              <h2 className="text-lg font-bold text-[var(--color-text)]">Document Checkout</h2>
              <p className="text-xs text-[var(--color-text-muted)] truncate max-w-[200px]">{document.title}</p>
            </div>
            {/* Close button must be visible on every breakpoint — previously
                md:hidden on desktop meant a user who just wanted to PEEK at
                their own checkout had no way out without committing to a
                check-in action. */}
            <button onClick={onClose} title="Close" className="p-2 rounded-lg hover:bg-[var(--color-surface-2)]"><X className="w-5 h-5" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            
            {/* Active Sessions List — only when there IS a session story to
                tell. An idle document opens straight to the form. */}
            {!isIdle && (
            <div>
              <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-3">Active Collaborators</h3>
              {activeSessions.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-[var(--color-border-strong)] text-center text-[var(--color-text-faint)] text-sm">
                  {isOrphaned
                    ? "This checkout got out of sync — fix it below."
                    : document.checkedOutBy
                      ? `Held by ${document.checkedOutByName || "another user"}, but their session went missing. An Admin/DocCtrl can force-release it from the row's checkout popover.`
                      : "No one is currently working on this file."}
                </div>
              ) : (
                <div className="space-y-2">
                  {activeSessions.map(s => (
                    <div key={s.id} className={`p-3 rounded-xl border flex items-start gap-3 ${s.userId === currentUser.uid ? 'bg-blue-50 border-blue-200 ring-1 ring-blue-100' : 'bg-[var(--color-surface)] border-[var(--color-border)]'}`}>
                      <div className={`p-2 rounded-full ${s.userId === currentUser.uid ? 'bg-blue-200 text-blue-700' : 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)]'}`}>
                        <User className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between items-start">
                          <p className="text-sm font-bold text-[var(--color-text)]">{s.userName}</p>
                          <span className="text-[10px] bg-[var(--color-surface)] border border-[var(--color-border)] px-2 py-0.5 rounded-full text-[var(--color-text-muted)] uppercase">{s.mode}</span>
                        </div>
                        {s.note && <p className="text-xs text-[var(--color-text-muted)] mt-1 italic">&ldquo;{s.note}&rdquo;</p>}
                        <p className="text-[10px] text-[var(--color-text-faint)] mt-2 flex items-center">
                          <Clock className="w-3 h-3 mr-1" /> Checked out {formatSince(s.startedAt)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}

            {/* ACTION AREA */}
            <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-5 shadow-sm">
              {mySession ? (
                // CHECK IN FLOW — "How did it go?" One question, cards derived
                // from the checkout purpose + document class + authority.
                // Everything (attestation, MOC gate, redline uploads, ticket
                // routing, publish, owner routing, handoff) lives in the panel.
                <CheckInPanel
                  document={document}
                  currentUser={currentUser}
                  episode={episode}
                  mySession={mySession}
                  activeSessions={activeSessions}
                  canPublish={canPublish}
                  folderPath={folderPath}
                  onDone={onClose}
                />
              ) : (
                // CHECK OUT FLOW (Start New Session or Recover)
                <div className="space-y-4">
                  {isOrphaned ? (
                    <div className="flex items-center gap-2 p-3 bg-blue-50 text-blue-800 rounded-lg text-xs">
                      <RefreshCw className="w-4 h-4 shrink-0" />
                      <span><strong>Out of sync:</strong> you&apos;re shown as holding this document, but your session was lost. Check out again to keep working — or release the lock if you&apos;re done.</span>
                    </div>
                  ) : (
                    <h3 className="text-sm font-bold text-[var(--color-text)]">Check out this document</h3>
                  )}

                  {/* The friction-free tier, offered here too — whoever opens
                      the full form and balks still gets the honest cheap path. */}
                  {!isOrphaned && (
                    <button
                      type="button"
                      onClick={handleQuickHold}
                      disabled={quickBusy || processing}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-200 bg-blue-50/60 hover:bg-blue-50 text-left transition-colors disabled:opacity-50"
                    >
                      {quickBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 shrink-0" /> : <Zap className="w-3.5 h-3.5 text-blue-600 shrink-0" />}
                      <span className="text-[11px] text-blue-900">
                        <b>Just need it for today?</b> Quick hold — one click, no questions, auto-releases tonight.
                      </span>
                    </button>
                  )}

                  {/* THE WHOLE DEFAULT FORM: what + why. Everything else is
                      behind Options — the honest path must be the cheap one. */}
                  <div>
                    <label className="text-xs font-bold text-[var(--color-text-muted)] uppercase mb-1 block">What are you doing? <span className="text-rose-500">*</span></label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {CHECKOUT_PURPOSES.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setPurposeCategory(p)}
                          className={`px-2.5 py-2 rounded-lg text-xs font-bold border text-left transition-all ${
                            purposeCategory === p
                              ? "bg-blue-600 border-blue-600 text-white shadow"
                              : "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-blue-300 hover:bg-blue-50/40"
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold text-[var(--color-text-muted)] uppercase mb-1 block">In a few words, why? <span className="text-rose-500">*</span></label>
                    <input
                      ref={noteInputRef}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Updating pump specs per MOC-2026-014..."
                      className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                    <div className="text-[10px] text-[var(--color-text-muted)] mt-1">
                      Shown to everyone who looks at this document while you have it out.
                    </div>
                  </div>

                  {/* OPTIONS FOLD — project linkage + timing. Collapsed by
                      default; the summary line always says what will happen. */}
                  <button
                    type="button"
                    onClick={() => setShowOptions((v) => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-dashed border-[var(--color-border-strong)] text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-slate-400 transition-colors"
                  >
                    <span>
                      {projectChoice === "adhoc"
                        ? <>Quick checkout — auto-releases in <b>{{ "24h": "24 hours", "3d": "3 days", "1w": "1 week", "1mo": "1 month" }[adhocDuration]}</b></>
                        : projectChoice === "existing"
                          ? <>Linked to project <b>{projects.find((p) => p.id === selectedProjectId)?.name || "…"}</b></>
                          : <>Creating a new project</>}
                    </span>
                    <span className="font-bold shrink-0 ml-2">{showOptions ? "Hide options ▴" : "Change timing / project ▾"}</span>
                  </button>

                  {showOptions && (
                  <div className="space-y-4 animate-in fade-in slide-in-from-top-1 duration-150">
                  {/* PROJECT PICKER ─────────────────────────────────────── */}
                  <div>
                    <label className="text-xs font-bold text-[var(--color-text-muted)] uppercase mb-1 block flex items-center gap-1.5">
                      <Briefcase className="w-3.5 h-3.5" /> Project
                    </label>
                    <div className="flex bg-[var(--color-surface-2)] p-1 rounded-lg mb-2">
                      <button
                        onClick={() => setProjectChoice("adhoc")}
                        className={`flex-1 py-1.5 text-[11px] font-bold rounded-md transition-all ${projectChoice === "adhoc" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
                      >
                        Ad-hoc (24h)
                      </button>
                      <button
                        onClick={() => setProjectChoice("existing")}
                        disabled={projects.length === 0}
                        className={`flex-1 py-1.5 text-[11px] font-bold rounded-md transition-all ${projectChoice === "existing" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"} disabled:opacity-40 disabled:cursor-not-allowed`}
                      >
                        Existing
                      </button>
                      <button
                        onClick={() => setProjectChoice("new")}
                        className={`flex-1 py-1.5 text-[11px] font-bold rounded-md transition-all ${projectChoice === "new" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
                      >
                        New Project
                      </button>
                    </div>
                    {projectChoice === "adhoc" && (
                      <div className="space-y-1.5 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg p-2">
                        <div className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Auto-release after</div>
                        <div className="flex bg-[var(--color-surface)] p-1 rounded-md border border-[var(--color-border)]">
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
                                adhocDuration === opt.v ? "bg-slate-900 text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        <div className="text-[10px] text-[var(--color-text-muted)]">
                          Ad-hoc checkouts auto-release so the doc never gets stuck. Pick a window that matches what you&apos;re doing — 1 month is the cap.
                        </div>
                      </div>
                    )}
                    {projectChoice === "existing" && (
                      <select
                        value={selectedProjectId}
                        onChange={(e) => setSelectedProjectId(e.target.value)}
                        className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm bg-[var(--color-surface)] focus:ring-2 focus:ring-blue-500 outline-none"
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
                          className="w-full px-2.5 py-1.5 border border-[var(--color-border)] rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                        <textarea
                          value={newProjectDescription}
                          onChange={(e) => setNewProjectDescription(e.target.value)}
                          placeholder="Description * — what's the team going to do?"
                          rows={2}
                          className="w-full px-2.5 py-1.5 border border-[var(--color-border)] rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-y"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            value={newProjectMoc}
                            onChange={(e) => setNewProjectMoc(e.target.value)}
                            placeholder="MOC ref (optional)"
                            className="px-2.5 py-1.5 border border-[var(--color-border)] rounded-md text-xs"
                          />
                          <select
                            value={newProjectVisibility}
                            onChange={(e) => setNewProjectVisibility(e.target.value as "public" | "private")}
                            className="px-2.5 py-1.5 border border-[var(--color-border)] rounded-md text-xs bg-[var(--color-surface)]"
                          >
                            <option value="public">Public (visible to all)</option>
                            <option value="private">Private (members only)</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>

                  {projectChoice !== "adhoc" && (
                    <div>
                      <label className="text-xs font-bold text-[var(--color-text-muted)] uppercase mb-1 block">Expected release (optional)</label>
                      <input
                        type="date"
                        value={expectedReleaseAt ? expectedReleaseAt.slice(0, 10) : ""}
                        onChange={(e) => setExpectedReleaseAt(e.target.value ? new Date(e.target.value).toISOString() : "")}
                        className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                      <div className="text-[10px] text-[var(--color-text-muted)] mt-1">
                        Helps the team know when this might be released. Stale checkouts surface a warning past this date.
                      </div>
                    </div>
                  )}
                  </div>
                  )}

                  {activeSessions.length > 0 && !isOrphaned && (
                    <div className="p-3 bg-amber-50 text-amber-800 rounded-lg text-xs flex items-start">
                      <AlertTriangle className="w-4 h-4 mr-2 shrink-0 mt-0.5" />
                      Others are currently working on this file. Coordinate via chat to avoid conflicts.
                    </div>
                  )}

                  {/* EVERYTHING STATED UP FRONT — the checklist shows both
                      requirements with live state, and the button narrates
                      exactly what it's waiting on. No surprise on click, ever. */}
                  {(() => {
                    const purposeDone = !!purposeCategory;
                    const noteLen = note.trim().length;
                    const noteDone = noteLen >= 5;
                    const ready = purposeDone && noteDone;
                    const StepMark = ({ done, n }: { done: boolean; n: string }) =>
                      done
                        ? <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        : <span className="w-3.5 h-3.5 shrink-0 rounded-full border border-[var(--color-border-strong)] text-[9px] font-black text-[var(--color-text-muted)] inline-flex items-center justify-center">{n}</span>;
                    const buttonLabel = processing ? "Working…"
                      : !purposeDone ? "Pick a purpose to continue"
                      : !noteDone ? (noteLen === 0 ? "Add a few words on why" : `Add ${5 - noteLen} more character${5 - noteLen === 1 ? "" : "s"}`)
                      : isOrphaned ? "Restore Session"
                      : document.checkedOutBy ? "Join Session" : "Check Out Now";
                    return (
                      <div className="space-y-2">
                        {!ready && (
                          <div className="flex items-center gap-4 text-[11px] text-[var(--color-text-muted)]">
                            <span className={`flex items-center gap-1.5 ${purposeDone ? "text-emerald-700" : ""}`}>
                              <StepMark done={purposeDone} n="1" /> What you&apos;re doing
                            </span>
                            <span className={`flex items-center gap-1.5 ${noteDone ? "text-emerald-700" : ""}`}>
                              <StepMark done={noteDone} n="2" /> Why (5+ characters)
                            </span>
                          </div>
                        )}
                        <div className="flex gap-2">
                          {isOrphaned && (
                            <button
                              onClick={handleForceUnlock}
                              className="px-4 py-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] text-[var(--color-text)] rounded-xl font-bold text-sm hover:bg-[var(--color-surface-2)]"
                              title="Release the lock without starting a session"
                            >
                              Release Lock
                            </button>
                          )}
                          <button
                            onClick={handleCheckout}
                            disabled={processing || quickBusy || !ready}
                            className={`flex-1 py-3 rounded-xl font-bold text-sm flex items-center justify-center shadow-lg ${document.checkedOutBy && !isOrphaned ? 'bg-[var(--color-surface)] border-2 border-blue-600 text-blue-700 hover:bg-blue-50' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-900/20'} disabled:opacity-60 disabled:cursor-not-allowed`}
                          >
                            {processing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Clock className="w-4 h-4 mr-2" />}
                            {buttonLabel}
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            {/* Sealed records of previous checkouts: participants, who/why,
                conversation, and revisions published in each window. Hidden on
                the idle two-question form — the inspector's Checkout drawer
                carries the same register. */}
            {!isIdle && document.id && document.orgId && (
              <CheckoutHistoryPanel
                orgId={document.orgId}
                documentId={document.id}
                activeEpisodeId={episode?.id ?? null}
              />
            )}

          </div>
        </div>

        {/* RIGHT: ACTIVITY THREAD (scoped to the live checkout episode) —
            only when a checkout is actually in motion. */}
        {!isIdle && document.id && document.orgId && (
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

    </div>
  );
}