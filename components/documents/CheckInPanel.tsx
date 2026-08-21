"use client";

// CheckInPanel — "How did it go?"
//
// The check-in half of the checkout modal. One question, 2–5 outcome cards
// derived by lib/checkinOutcomes from three facts the system already holds:
// the checkout PURPOSE, the document's declared CLASS, and the user's release
// AUTHORITY. Each card routes into existing machinery:
//
//   field_verified       → the walkdown attestation (audit FIELD_VERIFIED)
//   discrepancy/revision → drafting ticket w/ source-doc link, redline
//                          uploads, and the PSM MOC gate (drawing class)
//   correction           → minor-correction ticket, or a Correction publish
//   published/review     → RevUpModal inline (review gate auto-honored)
//   sent_to_owner        → durable notify to the effective owner
//   handoff              → thread note + lock transfer
//
// Honesty rules live in the lib: claim branches demand a typed note, the
// "no MOC exists" path is never blocked — it flags an undocumented field
// change to Document Control instead. The register records the outcome on
// the session row (pre-migration tolerant — see finishMySession).

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, CheckCircle2, Loader2, Paperclip, ShieldAlert, Upload, X,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/components/providers/ToastProvider";
import RevUpModal from "@/components/documents/RevUpModal";
import {
  checkInCardsFor,
  validateCheckIn,
  type CheckInCard,
  type CheckInOutcome,
  type MocStatus,
} from "@/lib/checkinOutcomes";
import { effectiveDocClassForDocument, type DocClass } from "@/lib/docClass";
import { effectiveOwnerForDocument, getOrgControllers } from "@/lib/ownership";
import { finishMySession, postEpisodeSystemMessage, type CheckoutEpisode } from "@/lib/checkoutEpisodes";
import { endMyIntents } from "@/lib/intents";
import { logAuditAction, logCheckoutEvent } from "@/lib/audit";
import { generateTicketNumber } from "@/lib/ticketNumber";
import { resolveTicketRecipients } from "@/lib/ticketRouting";
import { notifyMany } from "@/lib/inAppNotifications";
import { uploadTicketAttachment } from "@/lib/storage";
import { openHold } from "@/lib/holds";
import { postHandoff } from "@/lib/activityThread";
import type { CheckoutSession, DocumentRecord, DocumentVersion } from "@/types/schema";

interface CheckInPanelProps {
  document: DocumentRecord;
  currentUser: { uid: string; email: string | null; role: string | null };
  episode: CheckoutEpisode | null;
  mySession: CheckoutSession;
  activeSessions: CheckoutSession[];
  /** Per-library publish grant from the page (canPublishOnLibrary). */
  canPublish: boolean;
  onDone: () => void;
}

const MOC_STATES: Array<{ v: MocStatus; label: string }> = [
  { v: "completed", label: "MOC completed" },
  { v: "in_progress", label: "MOC in progress" },
  { v: "none", label: "No MOC exists" },
];

const TONE_SELECTED: Record<CheckInCard["tone"], string> = {
  positive: "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500",
  neutral: "border-slate-500 bg-slate-50 ring-1 ring-slate-400",
  action: "border-blue-500 bg-blue-50 ring-1 ring-blue-500",
  publish: "border-orange-500 bg-orange-50 ring-1 ring-orange-500",
};

export default function CheckInPanel({
  document: doc, currentUser, episode, mySession, activeSessions, canPublish, onDone,
}: CheckInPanelProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const userName = currentUser.email?.split("@")[0] || "User";

  // The two async facts the card derivation needs. Until they resolve we show
  // the generic set — never a spinner wall for an impatient person.
  const [docClass, setDocClass] = useState<DocClass | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [cls, owner] = await Promise.all([
          effectiveDocClassForDocument({ id: doc.id, collectionId: doc.collectionId ?? null, libraryId: doc.libraryId ?? null }),
          effectiveOwnerForDocument({
            ownerUserId: doc.ownerUserId ?? null, ownerName: doc.ownerName ?? null,
            collectionId: doc.collectionId ?? null, libraryId: doc.libraryId ?? "",
          }),
        ]);
        if (!alive) return;
        setDocClass(cls);
        setIsOwner(!!owner.userId && owner.userId === currentUser.uid);
      } catch { /* derivation degrades to generic */ }
    })();
    return () => { alive = false; };
  }, [doc.id, doc.collectionId, doc.libraryId, doc.ownerUserId, doc.ownerName, currentUser.uid]);

  const canPublishEff = canPublish || isOwner;
  const othersRemain = activeSessions.some((s) => s.userId !== currentUser.uid);

  const cards = useMemo(
    () => checkInCardsFor({ purpose: mySession.purpose ?? null, docClass, canPublishEff, othersRemain }),
    [mySession.purpose, docClass, canPublishEff, othersRemain],
  );

  // The most likely honest answer is pre-selected — releasing takes one click.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = cards.find((c) => c.id === selectedId) ?? cards.find((c) => c.recommended) ?? cards[0];

  const [note, setNote] = useState("");
  const [mocStatus, setMocStatus] = useState<MocStatus | null>(null);
  const [mocNumber, setMocNumber] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [alsoHold, setAlsoHold] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showRevUp, setShowRevUp] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const problem = selected ? validateCheckIn(selected, { note, mocStatus, mocNumber }) : "…";
  const docLabel = String(doc.documentNumber || doc.title || doc.name || "Document");

  // ── The shared closing move: audit + session end + outcome record ─────────
  const finishAndRecord = async (
    outcome: CheckInOutcome,
    ref?: Record<string, unknown>,
    systemLine?: string,
  ) => {
    await logCheckoutEvent({
      orgId: doc.orgId || "unknown",
      fileId: doc.id!,
      userId: currentUser.uid,
      userEmail: currentUser.email || "unknown",
      userRole: currentUser.role || "unknown",
      type: "CHECK_IN",
      details: {
        outcome, note: note.trim() || null, ref: ref ?? null,
        purpose: mySession.purpose ?? null,
        episodeId: episode?.id ?? null, checkoutNumber: episode?.seq ?? null,
      },
    });
    if (systemLine) {
      await postEpisodeSystemMessage({
        orgId: doc.orgId!, documentId: doc.id!,
        episodeId: episode?.id ?? null, text: systemLine,
      });
    }
    await finishMySession({
      orgId: doc.orgId!, documentId: doc.id!,
      userId: currentUser.uid, userName,
      episodeId: episode?.id ?? null,
      sessionStatus: "checked_in",
      releasedReason: `Checked in — ${outcome.replace(/_/g, " ")}`,
      outcome: { outcome, note: note.trim() || null, ref: ref ?? null },
    });
    void endMyIntents({ documentId: doc.id!, userId: currentUser.uid, sources: ["checkout"] });
  };

  // ── Drafting ticket for discrepancy / revision / minor correction ─────────
  const createDraftingTicket = async (card: CheckInCard): Promise<{ id: string; number: string }> => {
    if (!doc.orgId) throw new Error("This document has no workspace set.");
    const ticketNumber = await generateTicketNumber(doc.orgId);

    const attachments: Array<Record<string, unknown>> = [];
    for (const file of files) {
      const up = await uploadTicketAttachment({ orgId: doc.orgId, ticketId: ticketNumber, file });
      attachments.push({
        id: crypto.randomUUID(), name: file.name, url: up.url,
        type: "Source", status: "submitted",
        size: (file.size / 1024 / 1024).toFixed(2) + " MB",
        uploadedBy: currentUser.email || "Unknown", uploadedAt: new Date().toISOString(),
      });
    }

    const undocumented = card.moc === "required" && mocStatus === "none";
    const mocLine = card.moc === "required"
      ? mocStatus === "none"
        ? "MOC: NONE ON RECORD — flagged as an undocumented field change."
        : `MOC ${mocStatus === "completed" ? "completed" : "in progress"}: ${mocNumber.trim()}`
      : null;
    const kindTitle = card.ticketKind === "asbuilt"
      ? "As-Built Discrepancy" : card.ticketKind === "minor" ? "Minor Correction" : "Revision Request";
    // Request type follows the org's configured vocabulary where a match
    // exists (ASBUILT is in the default set); free text by design.
    const requestType = card.ticketKind === "asbuilt" ? "ASBUILT" : "Revision";

    const { data: row, error } = await supabase.from("tickets").insert({
      org_id: doc.orgId,
      ticket_id: ticketNumber,
      title: `${kindTitle}: ${doc.title || doc.documentNumber || "Document"}`,
      description: [note.trim(), mocLine].filter(Boolean).join("\n\n"),
      request_type: requestType,
      status: "PENDING_ASSIGNMENT",
      priority: undocumented ? 1 : 2,
      requester_id: currentUser.uid,
      requester_name: userName,
      requester_email: currentUser.email,
      requester_role: currentUser.role,
      attachments,
      watchers: [currentUser.uid],
      comments: [], unread_by: [],
      history: [{
        action: "Created via Check-in", user: currentUser.email, role: currentUser.role,
        date: new Date().toISOString(),
        details: `Source Document: ${docLabel} Rev ${doc.rev || "?"}${mocLine ? ` · ${mocLine}` : ""}`,
      }],
      // metadata.source_document keeps this ticket visible to the document's
      // Impact panel (lib/impact.ts queries this exact JSON path).
      metadata: {
        source_document: { id: doc.id, document_number: doc.documentNumber ?? null, title: doc.title ?? null, rev: doc.rev ?? null, path: null },
        checkin: { episodeId: episode?.id ?? null, checkoutNumber: episode?.seq ?? null, purpose: mySession.purpose ?? null, outcome: card.outcome },
        ...(card.moc === "required" ? { moc: { status: mocStatus, number: mocNumber.trim() || null } } : {}),
        ...(card.ticketKind === "minor" ? { minor_correction: true } : {}),
        ...(undocumented ? { undocumented_change: true } : {}),
      },
    }).select("id").single();
    if (error || !row) throw new Error(error?.message || "Couldn't create the drafting request.");

    // Assignment queue — same routing as a portal request.
    void (async () => {
      try {
        const recipients = await resolveTicketRecipients(doc.orgId!, "PENDING_ASSIGNMENT", currentUser.uid);
        if (recipients.length > 0) {
          await notifyMany({
            orgId: doc.orgId!, userIds: recipients.map((m) => m.uid),
            actorUserId: currentUser.uid, actorName: userName,
            kind: "request_pending_approval",
            title: `New drafting request: ${kindTitle}: ${doc.title || docLabel}`,
            body: "Created from a document check-in. Ready for a drafter to be assigned.",
            link: `/requests/${row.id}`, resourceType: "ticket", resourceId: row.id as string,
          });
        }
      } catch (e) { console.warn("[checkin] routing notify failed (non-blocking)", e); }
    })();

    // PSM escalation: an undocumented field change goes straight to the
    // controllers, loudly — reporting it must be frictionless, burying it
    // impossible.
    if (undocumented) {
      void (async () => {
        try {
          const controllers = (await getOrgControllers(doc.orgId!)).filter((u) => u !== currentUser.uid);
          if (controllers.length > 0) {
            await notifyMany({
              orgId: doc.orgId!, userIds: controllers,
              actorUserId: currentUser.uid, actorName: userName,
              kind: "request_pending_approval",
              title: `PSM alert: undocumented field change — ${docLabel}`,
              body: `${userName} reported the field differs from ${docLabel} with no MOC on record: "${note.trim()}"`,
              link: `/requests/${row.id}`, resourceType: "ticket", resourceId: row.id as string,
            });
          }
        } catch (e) { console.warn("[checkin] PSM escalation notify failed (non-blocking)", e); }
      })();
    }

    return { id: row.id as string, number: ticketNumber };
  };

  // ── Confirm — one button, every branch ────────────────────────────────────
  const confirm = async () => {
    if (!selected || problem || busy) return;
    if (selected.action === "open_publish") { setShowRevUp(true); return; }
    setBusy(true);
    try {
      switch (selected.action) {
        case "release": {
          await finishAndRecord(selected.outcome);
          break;
        }
        case "attest_release": {
          await logAuditAction({
            action: "FIELD_VERIFIED", resourceType: "document", resourceId: doc.id!,
            orgId: doc.orgId, userId: currentUser.uid,
            userEmail: currentUser.email || undefined, userRole: currentUser.role || undefined,
            details: {
              documentNumber: doc.documentNumber ?? null, rev: doc.rev ?? null,
              versionId: doc.currentVersionId ?? null,
              episodeId: episode?.id ?? null, checkoutNumber: episode?.seq ?? null,
            },
          });
          await finishAndRecord(
            "field_verified",
            { rev: doc.rev ?? null, versionId: doc.currentVersionId ?? null },
            `${userName} verified the field matches Rev ${doc.rev || "?"}.`,
          );
          showToast({ type: "success", title: "Field verification recorded", message: `Walkdown attested against Rev ${doc.rev || "?"} — it's on the document's record.` });
          break;
        }
        case "draft_ticket": {
          const ticket = await createDraftingTicket(selected);
          if (alsoHold && selected.allowHoldOffer) {
            try {
              await openHold({
                orgId: doc.orgId!, documentId: doc.id!,
                reason: "Field Verification Needed", notes: note.trim(),
                openedBy: currentUser.uid, openedByName: userName,
                openedByEmail: currentUser.email ?? undefined, openedByRole: currentUser.role ?? undefined,
              });
            } catch (e) {
              showToast({ type: "warning", title: "Hold not placed", message: (e as Error).message });
            }
          }
          const mocRef = selected.moc === "required" ? { status: mocStatus, number: mocNumber.trim() || null } : null;
          await finishAndRecord(
            selected.outcome,
            { ticketId: ticket.id, ticketNumber: ticket.number, ...(mocRef ? { moc: mocRef } : {}) },
            selected.outcome === "discrepancy"
              ? `${userName} reported a field discrepancy — ticket ${ticket.number}${mocStatus === "none" ? " (no MOC on record — flagged)" : mocNumber ? ` (${mocNumber.trim()})` : ""}.`
              : `${userName} requested ${selected.ticketKind === "minor" ? "a minor correction" : "a revision"} — ticket ${ticket.number}.`,
          );
          router.push(`/requests/${ticket.id}`);
          break;
        }
        case "notify_owner": {
          const owner = await effectiveOwnerForDocument({
            ownerUserId: doc.ownerUserId ?? null, ownerName: doc.ownerName ?? null,
            collectionId: doc.collectionId ?? null, libraryId: doc.libraryId ?? "",
          });
          const targets = owner.userId ? [owner.userId] : await getOrgControllers(doc.orgId!);
          try {
            const { emit } = await import("@/lib/notify/dispatch");
            await emit({
              orgId: doc.orgId!, category: "assignment", kind: "review_requested",
              title: `Change proposed to ${docLabel}`,
              body: `${userName} checked in with a proposed change: "${note.trim()}" — review and release it if it's right.`,
              resource: { type: "document", id: doc.id! },
              actorUserId: currentUser.uid, actorName: userName,
              audience: { involved: targets.filter((u) => u !== currentUser.uid) },
            });
          } catch (e) { console.warn("[checkin] owner notify failed", e); }
          await finishAndRecord(
            "sent_to_owner",
            { ownerUserId: owner.userId ?? null, ownerName: owner.name ?? null },
            `${userName} sent a proposed change to ${owner.name || "Document Control"}: "${note.trim()}".`,
          );
          break;
        }
        case "handoff_release": {
          await postHandoff({
            orgId: doc.orgId!, documentId: doc.id!,
            lockId: doc.currentLockId ?? null, episodeId: episode?.id ?? null,
            userId: currentUser.uid, userName, text: note.trim(),
          });
          await finishAndRecord("handoff");
          break;
        }
      }
      setBusy(false);
      onDone();
    } catch (e) {
      console.error(e);
      showToast({ type: "error", title: "Check-in failed", message: (e as Error).message });
      setBusy(false);
    }
  };

  // Publish path completion: RevUpModal ran (direct or review-gated). Record
  // the honest outcome from what actually happened to the version.
  const completePublish = async (v: DocumentVersion) => {
    setShowRevUp(false);
    setBusy(true);
    try {
      const reviewed = v.reviewState === "in_review";
      await finishAndRecord(
        reviewed ? "submitted_for_review" : "published",
        { versionId: v.id ?? null, revisionLabel: v.revisionLabel ?? null },
        reviewed
          ? `${userName} submitted Rev ${v.revisionLabel || "?"} for review and checked in.`
          : `${userName} published Rev ${v.revisionLabel || "?"} and checked in.`,
      );
      setBusy(false);
      onDone();
    } catch (e) {
      console.error(e);
      showToast({ type: "error", title: "Published, but check-in failed", message: (e as Error).message });
      setBusy(false);
    }
  };

  const buttonLabel = busy ? "Working…"
    : problem ? problem
    : selected?.action === "open_publish" ? "Open publish…"
    : selected?.action === "attest_release" ? "Record verification & release"
    : selected?.action === "draft_ticket" ? "Send request & release"
    : selected?.action === "notify_owner" ? "Send to owner & release"
    : selected?.action === "handoff_release" ? "Hand off & release"
    : "Release checkout";

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-bold text-[var(--color-text)] flex items-center">
        <CheckCircle2 className="w-4 h-4 mr-2 text-green-600" /> You are checked out
        {mySession.purpose && (
          <span className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">
            {mySession.purpose}
          </span>
        )}
      </h3>

      <div>
        <div className="text-xs font-bold text-[var(--color-text-muted)] uppercase mb-1.5">How did it go?</div>
        <div className="space-y-1.5">
          {cards.map((card) => {
            const isSel = selected?.id === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => { setSelectedId(card.id); setMocStatus(null); setAlsoHold(false); }}
                className={`w-full p-3 rounded-xl border-2 text-left transition-all ${isSel ? TONE_SELECTED[card.tone] : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}
              >
                <div className="font-bold text-sm text-[var(--color-text)]">{card.label}</div>
                {isSel && <p className="text-[10px] text-[var(--color-text-muted)] leading-snug mt-1">{card.hint}</p>}
              </button>
            );
          })}
        </div>
      </div>

      {selected?.requiresNote && (
        <div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={selected.notePrompt}
            rows={3}
            className="w-full p-3 rounded-xl border border-[var(--color-border)] text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
          <div className="text-[10px] text-[var(--color-text-muted)] mt-1">
            Recorded verbatim on the register — this is the record the next person reads.
          </div>
        </div>
      )}

      {/* THE PSM GATE — a drawing change states its MOC position, always. */}
      {selected?.moc === "required" && (
        <div className="space-y-1.5 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg p-2.5">
          <div className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
            Management of Change <span className="text-rose-500">*</span>
          </div>
          <div className="flex bg-[var(--color-surface)] p-1 rounded-md border border-[var(--color-border)]">
            {MOC_STATES.map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setMocStatus(opt.v)}
                className={`flex-1 py-1 text-[10px] font-bold rounded transition-colors ${mocStatus === opt.v ? "bg-slate-900 text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {mocStatus && mocStatus !== "none" && (
            <input
              value={mocNumber}
              onChange={(e) => setMocNumber(e.target.value)}
              placeholder="MOC number — e.g. MOC-2026-014"
              className="w-full px-2.5 py-1.5 border border-[var(--color-border)] rounded-md text-xs focus:ring-2 focus:ring-blue-500 outline-none"
            />
          )}
          {mocStatus === "none" && (
            <div className="flex items-start gap-1.5 text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                A drawing change with no MOC is an <b>undocumented field change</b> — this report goes to
                Document Control flagged as a PSM finding. Reporting it is the right move; it will never be blocked.
              </span>
            </div>
          )}
        </div>
      )}

      {selected?.allowUploads && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length) setFiles((prev) => [...prev, ...picked]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-slate-400 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" /> Attach redline photos or marked-up files
          </button>
          {files.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                  <Paperclip className="w-3 h-3 shrink-0" />
                  <span className="truncate flex-1">{f.name}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="p-0.5 rounded hover:bg-[var(--color-surface-2)]"
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selected?.allowHoldOffer && (
        <label className="flex items-start gap-2 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
          <input
            type="checkbox"
            checked={alsoHold}
            onChange={(e) => setAlsoHold(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Also place a <b>Field Verification Needed</b> hold — stops new revisions publishing until the
            discrepancy is resolved. Use it when the document is unsafe to work from.
          </span>
        </label>
      )}

      {/* The button narrates what's missing — no click-punishment, ever. */}
      <button
        onClick={confirm}
        disabled={busy || !!problem}
        className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold text-sm hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ArrowRight className="w-4 h-4 mr-2" />}
        {buttonLabel}
      </button>

      {showRevUp && doc.orgId && doc.libraryId && doc.id && (
        <RevUpModal
          isOpen={showRevUp}
          onClose={() => setShowRevUp(false)}
          doc={doc}
          libraryId={doc.libraryId}
          orgId={doc.orgId}
          actorUserId={currentUser.uid}
          actorEmail={currentUser.email ?? undefined}
          actorRole={currentUser.role ?? undefined}
          onSuccess={(v) => { void completePublish(v); }}
          onReviewSubmitted={(d) => {
            void completePublish({ id: d.versionId, revisionLabel: d.revisionLabel, reviewState: "in_review" } as DocumentVersion);
          }}
        />
      )}
    </div>
  );
}
