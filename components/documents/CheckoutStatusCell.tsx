"use client";

import React, { useState, useRef, useEffect } from "react";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  Clock,
  Info,
  Lock,
  Shield,
  Loader2,
  Zap,
  Check,
  LogIn,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { logCheckoutEvent } from "@/lib/audit";
import { isDocumentCheckedOut } from "@/lib/documentGuards";
import { forceReleaseDocument, quickHold } from "@/lib/checkoutEpisodes";
import UserAvatar from "@/components/ui/UserAvatar";
import type { DocumentRecord, CheckoutSession } from "@/types/schema";

// Tolerant timestamp → Date. Sessions come back from PostgREST as ISO strings;
// the old code called .toDate() on them, which threw and crashed the popover —
// the reason "who has this checked out?" showed nothing.
function toSafeDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe?.toDate === "function") return maybe.toDate();
  if (typeof maybe?.seconds === "number") return new Date(maybe.seconds * 1000);
  return new Date(v as string | number);
}

function timeAgo(date: Date) {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + "y";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + "mo";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + "d";
  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + "h";
  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + "m";
  return "now";
}

// Custom Tooltip/Popover Component
const CheckoutInfoPopover = ({ 
  doc: docRecord, 
  onClose,
  userRole,
  currentUserId,
  currentUserEmail
}: { 
  doc: DocumentRecord; 
  onClose: () => void;
  userRole?: string | null;
  currentUserId?: string;
  currentUserEmail?: string;
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [processing, setProcessing] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [sessions, setSessions] = useState<CheckoutSession[]>([]);
  const [loading, setLoading] = useState(true);
  // Passive context: who ELSE recently pulled a copy (view/reference intents).
  // Informational gray text — never an alarm; only edit×edit alarms anywhere.
  const [recentPulls, setRecentPulls] = useState<Array<{ name: string; when: string; kind: string }>>([]);

  // My own auto-expiry, if I have a session — shown as a countdown.
  const mySession = sessions.find((s) => String(s.userId) === String(currentUserId));

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Fetch Live Sessions for Notes
  useEffect(() => {
    if (!docRecord.id || !docRecord.orgId) return;
    let alive = true;

    const fetch = async () => {
      const { data } = await supabase
        .from("checkout_sessions")
        .select("*")
        .eq("org_id", docRecord.orgId!)
        .eq("document_id", docRecord.id!)
        .eq("status", "active");
      if (alive) {
        setSessions((data || []).map((r) => ({
          id: r.id, orgId: r.org_id, documentId: r.document_id,
          libraryId: r.library_id, userId: r.user_id, userName: r.user_name,
          mode: r.mode, note: r.note, status: r.status,
          startedAt: r.started_at, lastSeenAt: r.last_seen_at,
          purpose: r.purpose, expectedReleaseAt: r.expected_release_at,
          autoExpiresAt: r.auto_expires_at,
        }) as CheckoutSession));
        setLoading(false);
      }
      // Passive pulls — best-effort, quiet.
      try {
        const { listLiveIntents } = await import("@/lib/intents");
        const intents = await listLiveIntents(docRecord.id!);
        if (alive) {
          const sessionUserIds = new Set((data || []).map((r) => String(r.user_id)));
          setRecentPulls(
            intents
              .filter((i) => i.kind !== "edit" && !sessionUserIds.has(i.userId) && i.userId !== currentUserId)
              .sort((a, b) => Date.parse(b.refreshedAt) - Date.parse(a.refreshedAt))
              .slice(0, 3)
              .map((i) => ({
                name: i.userName || "Someone",
                when: timeAgo(toSafeDate(i.refreshedAt)),
                kind: i.source === "download" || i.source === "print" ? "pulled a copy" : "viewed",
              })),
          );
        }
      } catch { /* context only */ }
    };

    fetch();
    const channel = supabase.channel(`checkout-popover-${docRecord.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "checkout_sessions", filter: `document_id=eq.${docRecord.id}` }, () => { if (alive) fetch(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [docRecord.id, docRecord.orgId, currentUserId]);

  // One-click way OUT — leaving must be as cheap as arriving. Ends only MY
  // session; the episode machinery settles the lock (transfer/close).
  const handleReleaseMine = async () => {
    if (!docRecord.id || !docRecord.orgId || !currentUserId || releasing) return;
    setReleasing(true);
    try {
      const userName = currentUserEmail?.split("@")[0] || "User";
      const { finishMySession } = await import("@/lib/checkoutEpisodes");
      await finishMySession({
        orgId: docRecord.orgId,
        documentId: docRecord.id,
        userId: currentUserId,
        userName,
        sessionStatus: "checked_in",
        releasedReason: "Released from the checkout popover (no changes)",
        // The button says "no changes" — record it, so the register never
        // shows a blank row for a deliberate release.
        outcome: { outcome: "all_clear", note: null, ref: null },
      });
      const { endMyIntents } = await import("@/lib/intents");
      void endMyIntents({ documentId: docRecord.id, userId: currentUserId, sources: ["checkout"] });
      await logCheckoutEvent({
        orgId: docRecord.orgId,
        fileId: docRecord.id,
        userId: currentUserId,
        userEmail: currentUserEmail || "unknown",
        userRole: userRole || "unknown",
        type: "CHECK_IN",
        details: { oneClickRelease: true },
      });
      onClose();
    } catch (e) {
      console.error("One-click release failed", e);
    } finally {
      setReleasing(false);
    }
  };

  /** "auto-releases in 5h" / "was due back Mar 3" — one honest clock line. */
  const clockLine = (s: CheckoutSession): { text: string; overdue: boolean } | null => {
    const hard = s.autoExpiresAt ? toSafeDate(s.autoExpiresAt).getTime() : null;
    const soft = s.expectedReleaseAt ? toSafeDate(s.expectedReleaseAt).getTime() : null;
    const now = Date.now();
    if (hard) {
      if (hard < now) return { text: "auto-release pending", overdue: true };
      const hrs = Math.round((hard - now) / 3600000);
      return { text: hrs < 48 ? `auto-releases in ${Math.max(1, hrs)}h` : `auto-releases in ${Math.round(hrs / 24)}d`, overdue: false };
    }
    if (soft) {
      if (soft < now) return { text: `was due back ${toSafeDate(s.expectedReleaseAt!).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, overdue: true };
      return { text: `due back ${toSafeDate(s.expectedReleaseAt!).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, overdue: false };
    }
    return null;
  };

  const handleForceRelease = async () => {
    if (!docRecord.id || processing) return;
    // Force-release ends EVERY active session on this document and the
    // holders get notified by name — never a one-click accident.
    const holder = docRecord.checkedOutByName || "the current holder";
    const confirmed = await appConfirm({
      title: "Force-release this checkout?",
      message: `Every active session on this document ends immediately, and ${holder} (plus any collaborators) will be notified that you released it. Their unpublished work is not deleted, but their lock is gone. Only do this if the work is done or truly abandoned.`,
      tone: "danger",
      confirmLabel: "Force release",
    });
    if (!confirmed) return;
    setProcessing(true);
    try {
      // 1. Audit Log
      await logCheckoutEvent({
        orgId: docRecord.orgId || 'unknown',
        fileId: docRecord.id,
        userId: currentUserId || 'unknown',
        userEmail: currentUserEmail || 'unknown',
        userRole: userRole || 'unknown',
        type: "FORCE_RELEASE",
        details: {
          releasedUser: docRecord.checkedOutByName,
          releasedUserId: docRecord.checkedOutBy
        }
      });

      // 2. Release everything: ends every active session, closes the
      //    checkout episode (close_reason 'force_released'), clears the lock
      //    columns + collaborator list, and logs the system alert into the
      //    episode's thread.
      await forceReleaseDocument({
        orgId: docRecord.orgId || 'unknown',
        documentId: docRecord.id!,
        actorUserId: currentUserId || 'unknown',
        actorName: currentUserEmail?.split('@')[0] || 'Admin',
      });

      setProcessing(false);
      onClose();
    } catch (e) {
      console.error("Failed to force release:", e);
      setProcessing(false);
    }
  };

  const canAdmin = userRole === 'Admin' || userRole === 'DocCtrl';

  return (
    <div 
      ref={popoverRef}
      className="absolute right-0 top-full mt-2 w-80 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg z-50 animate-in fade-in zoom-in-95 duration-150 origin-top-right overflow-hidden"
      onClick={(e) => e.stopPropagation()} 
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex justify-between items-center bg-[var(--color-surface-2)]">
        <h4 className="text-body font-medium text-[var(--color-text-muted)] flex items-center">
          <Clock className="w-3.5 h-3.5 mr-1.5 text-[var(--color-text-muted)]" /> Who has it
        </h4>
        {loading ? <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-faint)]" /> : (
           <span className="text-body font-medium tabular-nums text-[var(--color-text)]">
             {sessions.length} {sessions.length !== 1 ? 'people' : 'person'}
           </span>
        )}
      </div>

      <div className="p-4 space-y-4 max-h-[300px] overflow-y-auto custom-scrollbar">
        {loading ? (
          <div className="text-center py-4 text-body text-[var(--color-text-muted)]">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-4 text-body text-[var(--color-text-muted)]">No one is working on it now. The lock may be left over.</div>
        ) : (
          <div className="space-y-3">
            {sessions.map(session => (
              <div key={session.userId} className={`rounded-xl p-3 border ${session.userId === docRecord.checkedOutBy ? 'bg-[var(--color-surface-2)] border-[var(--color-border)]' : 'bg-[var(--color-surface-2)]/50 border-[var(--color-border)]'}`}>
                <div className="flex items-center gap-3 mb-2">
                  <UserAvatar uid={session.userId} name={session.userName} size={24} className="shadow-sm" />
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-center">
                      <p className="text-body font-medium text-[var(--color-text)] truncate">{session.userName}</p>
                      {session.userId === docRecord.checkedOutBy && (
                        <span className="flex items-center text-body font-medium text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded-full border border-[var(--color-border)] shadow-sm" title="This person holds the lock, they're the one publishing wins for">
                          <Lock className="w-2.5 h-2.5 mr-1" /> Holds the lock
                        </span>
                      )}
                    </div>
                    <p className="text-body text-[var(--color-text-faint)] flex items-center mt-0.5">
                       {session.mode} • {session.startedAt ? timeAgo(toSafeDate(session.startedAt)) : ''}
                    </p>
                  </div>
                </div>
                {/* The document-control "why": purpose category + stated reason. */}
                <div className="ml-9 space-y-1.5">
                  {session.purpose && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-body font-medium bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)]">
                      {session.purpose}
                    </span>
                  )}
                  {session.note ? (
                    <div className="text-body text-[var(--color-text)] bg-[var(--color-surface-2)] p-2 rounded-lg border border-[var(--color-border)] italic">
                      &ldquo;{session.note}&rdquo;
                    </div>
                  ) : !session.purpose ? (
                    <div className="text-body text-[var(--color-text-faint)] italic">No stated reason (pre-policy checkout)</div>
                  ) : null}
                  {(() => {
                    const clock = clockLine(session);
                    return clock ? (
                      <div className={`text-body font-medium ${clock.overdue ? "text-[var(--state-held)]" : "text-[var(--color-text-muted)]"}`}>
                        <Clock className="w-2.5 h-2.5 inline mr-1 -mt-0.5" />{clock.text}
                      </div>
                    ) : null;
                  })()}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Passive context — who else recently pulled a copy. Gray info,
            never an alarm. */}
        {recentPulls.length > 0 && (
          <div className="pt-2 border-t border-dashed border-[var(--color-border)] space-y-0.5">
            {recentPulls.map((p, i) => (
              <div key={i} className="text-body text-[var(--color-text-faint)]">
                {p.name} {p.kind} · {p.when}
              </div>
            ))}
          </div>
        )}

        {/* MY ONE-CLICK EXIT — leaving must be as cheap as arriving. */}
        {mySession && (
          <button
            onClick={handleReleaseMine}
            disabled={releasing}
            className="w-full py-2 bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded-lg text-body font-medium flex items-center justify-center transition-colors disabled:opacity-50"
            title="Ends your session only. If others are still on the checkout, the lock passes to them."
          >
            {releasing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
            {releasing ? "Releasing…" : "Release my checkout, no changes"}
          </button>
        )}

        {/* ADMIN ACTION */}
        {canAdmin && (
           <div className="pt-3 border-t border-[var(--color-border)] space-y-2">
             <button
               onClick={handleForceRelease}
               disabled={processing}
               className="w-full py-2 bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] text-[var(--state-overdue)] border border-[var(--color-border)] rounded-lg text-body font-medium flex items-center justify-center transition-colors disabled:opacity-50"
             >
               <Shield className="w-3.5 h-3.5 mr-1.5" />
               {processing ? "Releasing…" : "Force release (admin)"}
             </button>
           </div>
        )}
      </div>
    </div>
  );
}

export default function CheckoutStatusCell({
  docRecord,
  currentUserId,
  currentUserEmail,
  userRole,
  onCheckout,
  quiet = false,
}: {
  docRecord: DocumentRecord;
  currentUserId?: string;
  currentUserEmail?: string;
  userRole?: string | null;
  onCheckout: (doc: DocumentRecord) => void;
  /** In a table row: the column reads as who has what. A free document
   *  says "Available"; pointing at the row (or tabbing into the cell)
   *  turns that into Check out and Quick hold. A touchscreen, with no
   *  hover, always shows the buttons. */
  quiet?: boolean;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // The AUTHORITATIVE lock is `checkedOutBy`. A non-empty `activeCollaborators`
  // list with no lock holder is a stale/zombie remnant (see isDocumentCheckedOut)
  // and must NOT read as "checked out" — that was the phantom-checkout bug.
  const isCheckedOut = isDocumentCheckedOut(docRecord);
  // Robust string comparison to prevent type mismatches
  const isLockedByMe = String(docRecord.checkedOutBy) === String(currentUserId);

  const handleQuickHold = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!docRecord.id || !docRecord.orgId || !currentUserId || quickBusy) return;
    setQuickBusy(true);
    try {
      await quickHold({
        orgId: docRecord.orgId,
        documentId: docRecord.id,
        libraryId: docRecord.libraryId ?? null,
        currentVersionId: docRecord.currentVersionId ?? null,
        userId: currentUserId,
        userName: currentUserEmail?.split("@")[0] || "User",
      });
      await logCheckoutEvent({
        orgId: docRecord.orgId,
        fileId: docRecord.id,
        userId: currentUserId,
        userEmail: currentUserEmail || "unknown",
        userRole: userRole || "unknown",
        type: "CHECK_OUT",
        details: { quickHold: true, autoExpires: "end of day" },
      });
    } catch (err) {
      console.error("Quick hold failed", err);
    } finally {
      setQuickBusy(false);
    }
  };

  const small = "inline-flex items-center gap-1 h-8 pointer-coarse:h-10 px-2.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-control)] disabled:opacity-50 transition-colors whitespace-nowrap";
  if (!isCheckedOut && quiet) {
    return (
      <div className="relative flex items-center gap-1 min-h-8 group/cell">
        <span className="text-body text-[var(--color-text-faint)] group-hover:invisible group-focus-within/cell:invisible [@media(hover:none)]:hidden">Available</span>
        <div className="absolute inset-y-0 left-0 flex items-center gap-1 invisible group-hover:visible group-focus-within/cell:visible [@media(hover:none)]:visible [@media(hover:none)]:static">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCheckout(docRecord); }}
            className={small}
          >
            Check out
          </button>
          {currentUserId && docRecord.orgId && (
            <button
              type="button"
              onClick={handleQuickHold}
              disabled={quickBusy}
              title="Quick hold: one click, no form. Marks you as working on this until end of day, then releases it. Upgrade to a full checkout any time."
              aria-label="Quick hold until end of day"
              className={`${small} !w-8 !px-0 justify-center`}
            >
              {quickBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!isCheckedOut) {
    return (
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCheckout(docRecord); }}
          className={small}
        >
          {!quiet && <LogIn className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />}
          Check out
        </button>
        {/* One-click lightweight tier: friction is why people skip checkout
            systems, so the honest path is the cheapest one. Labeled, not a
            mystery icon. */}
        {currentUserId && docRecord.orgId && (
          <button
            type="button"
            onClick={handleQuickHold}
            disabled={quickBusy}
            title="Quick hold: one click, no form. Marks you as working on this until end of day, then releases it. Upgrade to a full checkout any time."
            aria-label="Quick hold until end of day"
            className={quiet ? `${small} !w-7 !px-0 justify-center` : small}
          >
            {quickBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />}
            {/* Labeled wherever there's room; in a table row the tooltip says it. */}
            {!quiet && "Quick hold"}
          </button>
        )}
      </div>
    );
  }

  // Checked out: who has it, as a quiet tag (waiting color). Click it to
  // check in or join; the info button says how long and who else.
  const holder = isLockedByMe ? "You" : (docRecord.checkedOutByName || docRecord.activeCollaborators?.[0] || "Someone");
  const others = Math.max(0, (docRecord.activeCollaborators?.length ?? 0) - 1);
  return (
    <div className="flex items-center gap-1 relative group/co min-w-0" ref={containerRef}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onCheckout(docRecord); }}
        title={isLockedByMe ? "Checked out by you. Open to check in." : `Checked out by ${holder}`}
        className="min-w-0 inline-flex items-center gap-1.5 h-8 px-1.5 -ml-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-body font-medium text-[var(--color-text)]"
      >
        <span aria-hidden className="w-2 h-2 rounded-full shrink-0 bg-[var(--state-held)]" />
        <span className="truncate">{holder}{others > 0 ? ` +${others}` : ""}</span>
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setShowInfo(!showInfo); }}
        aria-label="Checkout details"
        title="Checkout details"
        aria-expanded={showInfo}
        className={`shrink-0 w-7 h-7 grid place-items-center rounded-md transition-colors ${
          showInfo
            ? "bg-[var(--color-surface-2)] text-[var(--color-text)]"
            : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
        }`}
      >
        <Info className="w-3.5 h-3.5" />
      </button>

      {showInfo &&
        <CheckoutInfoPopover
          doc={docRecord}
          onClose={() => setShowInfo(false)}
          userRole={userRole}
          currentUserId={currentUserId}
          currentUserEmail={currentUserEmail}
        />
      }
    </div>
  );
}
