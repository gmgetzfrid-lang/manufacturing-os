"use client";

// ReviewGateSection — the pre-publish review panel in the document Inspector.
// While a draft (2A) is in review it shows the reviewer roster; a reviewer signs
// off with a touchpad signature; the owner/DocCtrl (canManage) can activate an
// alternate and — once every required sign-off is in — publish the approved
// revision (2A -> Rev 2). When nothing is in review it shows the effective mode.
//
// REV-20 (P14 final review): after 20261151 the publish guard refuses a
// controller's review promote of a held Draft / In Review document unless it
// carries the recorded override. When — and only when — the hold refused the
// promote, a controller (the role collection) is offered "Proceed over the
// active hold" (the HLD-2 acknowledgement, HeldSourceNotice); the publish
// then passes the force, which finalize_reviewed_promote records
// (REV_HOLD_OVERRIDDEN) in the same transaction. Anyone else is told to
// release the hold (finalizeReasonMessage).

import React, { useCallback, useEffect, useState } from "react";
import { appAlert } from "@/components/providers/DialogProvider";
import { ShieldCheck, Loader2, PenLine, CheckCircle2, Clock, UserPlus, ArrowUpFromLine, FileText } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { resolveFileUrl } from "@/lib/storage";
import { getMyTeamIds } from "@/lib/teams";
import { useRole } from "@/components/providers/RoleContext";
import SignatureCeremony from "@/components/signatures/SignatureCeremony";
import type { SigningCredential } from "@/lib/eSignatures";
import {
  listDraftRoster, recordReviewSignoff, activateAlternate,
  finalizeReviewedRevision, finalizeReasonMessage, isFinalizeHoldRefusal, effectiveReviewControlForDocument, evaluateSlotCompletion,
  type ReviewSignoffRow,
} from "@/lib/reviewControl";
import HeldSourceNotice from "@/components/documents/lifecycle/HeldSourceNotice";
import type { DocumentRecord, ReviewControl } from "@/types/schema";
import { describeProjectSweep } from "@/lib/checklists";

export default function ReviewGateSection({ doc, orgId, canManage, onChanged }: {
  doc: DocumentRecord;
  orgId: string;
  canManage: boolean;
  onChanged?: () => void;
}) {
  const { uid, userEmail, activeRole, roles, hasAnyRole, member } = useRole();
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null);
  const [draftFileUrl, setDraftFileUrl] = useState<string | null>(null);
  const [roster, setRoster] = useState<ReviewSignoffRow[]>([]);
  // RG-4: every row of the draft, voided ones included — the completion
  // evaluator is fed this, never the displayable subset.
  const [rosterAll, setRosterAll] = useState<ReviewSignoffRow[]>([]);
  const [control, setControl] = useState<ReviewControl | null>(null);
  // RG-6: "we couldn't read the policy" is shown as exactly that — never as
  // "no gate" (the old load swallowed the error and rendered nothing).
  const [policyUnknown, setPolicyUnknown] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(false);
  // REV-20 (P14 final review): the document whose promote the hold refused
  // (a controller is then offered the recorded force), the acknowledgement,
  // and the optional reason recorded with it.
  const [holdRefusedFor, setHoldRefusedFor] = useState<string | null>(null);
  const [holdAck, setHoldAck] = useState(false);
  const [holdReason, setHoldReason] = useState("");

  const load = useCallback(async () => {
    if (!doc.id) return;
    setLoading(true);
    try {
      const { data: d } = await supabase.from("documents").select("pending_version_id, review_control, collection_id").eq("id", doc.id).maybeSingle();
      const pv = (d?.pending_version_id as string | null) ?? null;
      setPendingVersionId(pv);
      // RG-3: the whole container chain (folder → ancestors → library) through
      // the one shared resolver, not a hand-rolled two-hop copy.
      const colId = (d?.collection_id as string | null) ?? doc.collectionId ?? null;
      try {
        setControl(await effectiveReviewControlForDocument({ reviewControl: (d?.review_control as ReviewControl | null) ?? null, collectionId: colId, libraryId: doc.libraryId }));
        setPolicyUnknown(null);
      } catch (e) {
        setControl(null);
        setPolicyUnknown((e as Error).message || "unknown error");
      }
      if (pv) {
        const [all, { data: ver }] = await Promise.all([
          listDraftRoster(doc.id, pv, { allStatuses: true }),
          supabase.from("document_versions").select("file_url").eq("id", pv).maybeSingle(),
        ]);
        setRosterAll(all);
        setRoster(all.filter((r) => r.status === "pending" || r.status === "signed"));
        setDraftFileUrl((ver?.file_url as string) ?? null);
      } else { setRosterAll([]); setRoster([]); setDraftFileUrl(null); }
    } finally { setLoading(false); }
  }, [doc.id, doc.libraryId, doc.collectionId]);

  useEffect(() => { void load(); }, [load]);

  // Team memberships — a draft-viewer grant can name a whole department.
  const [myTeamIds, setMyTeamIds] = useState<string[]>([]);
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    getMyTeamIds(uid).then((t) => { if (alive) setMyTeamIds(t); }).catch(() => {});
    return () => { alive = false; };
  }, [uid]);

  const primaries = roster.filter((r) => r.slot === "primary");
  // RG-4: the panel judges completion PER SLOT with the same evaluator — AND
  // the same input (every row, all statuses) — as the finalize step and the
  // database guard, so "2/2 signed" can no longer mean two piping signatures
  // and no instrumentation review, and a voided primary still counts as an
  // unfilled slot here exactly as it does at publish time.
  const completion = evaluateSlotCompletion(rosterAll);
  const signedCount = completion.satisfied;
  const complete = completion.complete;
  const draftLabel = roster[0]?.revisionLabel || null;
  const mine = roster.find((r) => r.reviewerUserId === uid && r.status === "pending" && (r.slot === "primary" || r.activated));
  // RG-9: the typed-name check compares against the membership display name (the server records the same).
  const signerName = (member?.displayName ?? "").trim() || (userEmail?.split("@")[0] ?? "").trim() || "user";
  const label = doc.documentNumber || doc.title || doc.name || "this document";

  // Who may SEE the in-review draft: reviewers/alternates + owner/publisher +
  // Admin/DocCtrl + explicitly-configured draft viewers. Everyone else only
  // learns that a review is in progress.
  const isController = hasAnyRole(["Admin", "DocCtrl"]); // OWN-3: collection, not headline
  const canSeeDraft = isController || canManage
    || roster.some((r) => r.reviewerUserId === uid)
    || (uid ? (control?.draftViewerIds ?? []).includes(uid) : false)
    // ADD-1: a draft-viewer ROLE grant matches any role the member holds.
    || roles.some((r) => (control?.draftViewerRoles ?? []).includes(r))
    || (control?.draftViewerTeamIds ?? []).some((t) => myTeamIds.includes(t));

  // ── Actions ──
  const doSign = async (_i: unknown, statement: string, signatureImage?: string | null, reauth?: SigningCredential) => {
    if (!uid || !doc.id || !mine || !pendingVersionId) return;
    setBusy(true);
    try {
      await recordReviewSignoff({
        orgId, documentId: doc.id, libraryId: doc.libraryId, versionId: pendingVersionId,
        revisionLabel: draftLabel || "", contentHash: mine.contentHash,
        signoffId: mine.id, signerUserId: uid, signerName, signerRole: activeRole ?? null, signerEmail: userEmail ?? null,
        statement, signatureImage: signatureImage ?? null,
        reauth: reauth ?? null,
      });
      setSigning(false); await load(); onChanged?.();
    } finally { setBusy(false); }
  };
  const activate = async (signoffId: string) => {
    if (!doc.id) return;
    setBusy(true);
    try { await activateAlternate({ orgId, documentId: doc.id, libraryId: doc.libraryId, signoffId, actorId: uid }); await load(); }
    finally { setBusy(false); }
  };
  const viewDraft = async () => {
    if (!draftFileUrl) return;
    const url = await resolveFileUrl(draftFileUrl);
    if (url) window.open(url, "_blank", "noopener");
  };
  const publish = async (forceHold = false) => {
    if (!doc.id) return;
    setBusy(true);
    try {
      // The call without a force is exactly the call it always was.
      const res = forceHold
        ? await finalizeReviewedRevision({ orgId, documentId: doc.id, actorId: uid, actorName: userEmail, actorEmail: userEmail ?? null, forceHold: true, overrideReason: holdReason.trim() || null })
        : await finalizeReviewedRevision({ orgId, documentId: doc.id, actorId: uid, actorName: userEmail, actorEmail: userEmail ?? null });
      if (!res.published) {
        // REV-20 (P14 final review): the hold refused a controller's promote —
        // offer the recorded force (nothing was changed); any other refusal,
        // and anyone else's, is said as before.
        if (!forceHold && isController && isFinalizeHoldRefusal(res.reason)) {
          setHoldRefusedFor(doc.id); setHoldAck(false); setHoldReason("");
        } else {
          await appAlert({ tone: "danger", message: finalizeReasonMessage(res.reason) });
        }
      } else {
        setHoldRefusedFor(null); setHoldAck(false); setHoldReason("");
      }
      // UX-16: the publish swept the open checklists of the projects citing
      // this document; a sweep that could not finish is said, never silent.
      const swept = res.published && res.evidenceSweep ? describeProjectSweep(res.evidenceSweep) : null;
      if (swept && !swept.ok) await appAlert({ tone: "danger", message: swept.text });
      await load(); onChanged?.();
    } finally { setBusy(false); }
  };

  const statusChip = (r: ReviewSignoffRow) => {
    if (r.status === "signed") return <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700"><CheckCircle2 className="w-3 h-3" /> {r.signedAt?.slice(0, 10)}</span>;
    if (r.slot === "alternate" && !r.activated) return <span className="text-[10px] font-bold text-[var(--color-text-faint)]">Standby</span>;
    return <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-600"><Clock className="w-3 h-3" /> Pending</span>;
  };

  // Nothing in review: show the effective mode (and stay quiet if none).
  if (!loading && !pendingVersionId) {
    if (policyUnknown) {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] text-red-800">
          <b>Pre-publish review policy could not be read</b> ({policyUnknown}). Until it can, this document is treated as gated — a revision can&apos;t be published directly.
        </div>
      );
    }
    if (!control || control.mode === "none") return null;
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[var(--color-text-muted)]" />
          <span className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">Pre-publish review</span>
        </div>
        <div className="text-[11px] text-[var(--color-text-muted)] mt-1.5">
          {control.mode === "require" ? "Revisions in this library require reviewer sign-off before they publish." : "The publisher may route a revision through review before it publishes."}
        </div>
      </div>
    );
  }

  // In review, but this viewer isn't cleared to see the draft — tell them only
  // that a review is in progress; the live rev stays controlled.
  if (!loading && pendingVersionId && !canSeeDraft) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[var(--color-text-muted)]" />
          <span className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">Pre-publish review</span>
        </div>
        <div className="text-[11px] text-[var(--color-text-muted)] mt-1.5">A new revision is in review by the assigned reviewers. The current Rev {doc.rev || "—"} remains the controlled copy.</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-violet-300 bg-violet-50/40 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-violet-600" />
        <span className="text-xs font-black uppercase tracking-wider text-violet-700">In review{draftLabel ? ` · ${draftLabel}` : ""}</span>
        {!loading && <span className="ml-auto text-[10px] font-bold text-violet-700" title="Required sign-offs satisfied, per reviewer slot">{signedCount}/{completion.requiredPrimaries || primaries.length} signed</span>}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
      ) : (
        <>
          {draftFileUrl && (
            <button onClick={() => void viewDraft()} className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-violet-300 bg-white text-violet-700 text-xs font-bold hover:bg-violet-50">
              <FileText className="w-3.5 h-3.5" /> View draft{draftLabel ? ` ${draftLabel}` : ""}
            </button>
          )}
          {mine && (
            <button onClick={() => setSigning(true)} className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600 text-white text-xs font-black shadow hover:bg-violet-500">
              <PenLine className="w-3.5 h-3.5" /> Review &amp; sign off{draftLabel ? ` ${draftLabel}` : ""}
            </button>
          )}

          <div className="space-y-0.5 max-h-40 overflow-y-auto">
            {roster.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-[11px] py-0.5">
                <span className="min-w-0 truncate text-[var(--color-text)]">
                  {r.reviewerName || r.reviewerUserId}
                  {r.slot === "alternate" && <span className="text-[var(--color-text-muted)]"> · alt{r.slotGroup ? "" : " (unpaired — fills no slot)"}</span>}
                  {r.reviewerRole ? <span className="text-[var(--color-text-muted)]"> · {r.reviewerRole}</span> : null}
                </span>
                <span className="ml-auto shrink-0">{statusChip(r)}</span>
                {canManage && r.slot === "alternate" && !r.activated && r.status === "pending" && (
                  <button title="Activate alternate" onClick={() => void activate(r.id)} disabled={busy} className="shrink-0 p-1 rounded hover:bg-white text-violet-600"><UserPlus className="w-3 h-3" /></button>
                )}
              </div>
            ))}
          </div>

          {canManage && roster.length === 0 ? (
            // RESCUE, not a dead end: a zero-person roster can never complete,
            // so the disabled button would strand this draft forever.
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[11px] text-rose-800">
              <b>No reviewers are configured for this library</b> — this draft can never complete review as-is.
              Set reviewers in the library&apos;s review policy, or lower the review mode, then resubmit.
              <a href="/admin/libraries" className="block mt-1 font-black underline">Open library settings →</a>
            </div>
          ) : canManage && (
            <button
              onClick={() => void publish()}
              disabled={busy || !complete}
              title={complete ? "Publish the approved revision" : "Waiting on reviewer sign-off"}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-black shadow hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpFromLine className="w-3.5 h-3.5" />} Publish approved revision
            </button>
          )}
          {canManage && isController && holdRefusedFor === doc.id && (
            <div data-testid="review-hold-force" className="space-y-2">
              <div className="text-[11px] text-amber-900">
                This document has an active hold, so the reviewed revision was not published and nothing was changed. Release the hold, or proceed over it as Document Control — the override is recorded on the document&apos;s history.
              </div>
              <HeldSourceNotice
                decision={{ kind: "acknowledge", text: "Proceed over the active hold: publish the reviewed revision while the hold stays open." }}
                readError={null}
                ack={holdAck}
                setAck={setHoldAck}
              />
              <input
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
                placeholder="Why (optional — recorded with the override)"
                aria-label="Reason for proceeding over the hold"
                className="w-full text-[11px] rounded-lg border border-amber-300 bg-white px-2 py-1.5"
              />
              <button
                onClick={() => void publish(true)}
                disabled={busy || !holdAck || !complete}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 text-white text-xs font-black shadow hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpFromLine className="w-3.5 h-3.5" />} Publish over the hold
              </button>
            </div>
          )}
          <div className="text-[10px] text-[var(--color-text-muted)]">The current Rev {doc.rev || "—"} stays the controlled copy until this draft is approved &amp; published.</div>
        </>
      )}

      {signing && (
        <SignatureCeremony
          signerName={signerName}
          resourceLabel={`${label}${draftLabel ? ` ${draftLabel}` : ""}`}
          defaultIntent="Reviewed"
          defaultStatement={`I, ${signerName}, have reviewed ${label}${draftLabel ? ` draft ${draftLabel}` : ""} and approve it for publication, and affirm this as my electronic signature.`}
          lockIntent
          busy={busy}
          onCancel={() => !busy && setSigning(false)}
          onSign={doSign}
        />
      )}
    </div>
  );
}
