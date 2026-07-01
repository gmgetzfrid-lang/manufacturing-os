"use client";

// ReviewGateSection — the pre-publish review panel in the document Inspector.
// While a draft (2A) is in review it shows the reviewer roster; a reviewer signs
// off with a touchpad signature; the owner/DocCtrl (canManage) can activate an
// alternate and — once every required sign-off is in — publish the approved
// revision (2A -> Rev 2). When nothing is in review it shows the effective mode.

import React, { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Loader2, PenLine, CheckCircle2, Clock, UserPlus, ArrowUpFromLine, FileText } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { resolveFileUrl } from "@/lib/storage";
import { useRole } from "@/components/providers/RoleContext";
import SignatureCeremony from "@/components/signatures/SignatureCeremony";
import {
  listDraftRoster, recordReviewSignoff, activateAlternate,
  finalizeReviewedRevision, resolveEffectiveReviewControl,
  type ReviewSignoffRow,
} from "@/lib/reviewControl";
import type { DocumentRecord, ReviewControl } from "@/types/schema";

export default function ReviewGateSection({ doc, orgId, canManage, onChanged }: {
  doc: DocumentRecord;
  orgId: string;
  canManage: boolean;
  onChanged?: () => void;
}) {
  const { uid, userEmail, activeRole } = useRole();
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null);
  const [draftFileUrl, setDraftFileUrl] = useState<string | null>(null);
  const [roster, setRoster] = useState<ReviewSignoffRow[]>([]);
  const [control, setControl] = useState<ReviewControl | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(false);

  const load = useCallback(async () => {
    if (!doc.id) return;
    setLoading(true);
    try {
      const [{ data: d }, { data: lib }] = await Promise.all([
        supabase.from("documents").select("pending_version_id, review_control, collection_id").eq("id", doc.id).maybeSingle(),
        supabase.from("libraries").select("review_control").eq("id", doc.libraryId).maybeSingle(),
      ]);
      const pv = (d?.pending_version_id as string | null) ?? null;
      setPendingVersionId(pv);
      let folder: ReviewControl | null = null;
      const colId = (d?.collection_id as string | null) ?? doc.collectionId ?? null;
      if (colId) {
        const { data: c } = await supabase.from("collections").select("review_control").eq("id", colId).maybeSingle();
        folder = (c?.review_control as ReviewControl) ?? null;
      }
      setControl(resolveEffectiveReviewControl((d?.review_control as ReviewControl) ?? null, folder, (lib?.review_control as ReviewControl) ?? null));
      if (pv) {
        const [roster, { data: ver }] = await Promise.all([
          listDraftRoster(doc.id, pv),
          supabase.from("document_versions").select("file_url").eq("id", pv).maybeSingle(),
        ]);
        setRoster(roster);
        setDraftFileUrl((ver?.file_url as string) ?? null);
      } else { setRoster([]); setDraftFileUrl(null); }
    } finally { setLoading(false); }
  }, [doc.id, doc.libraryId, doc.collectionId]);

  useEffect(() => { void load(); }, [load]);

  const primaries = roster.filter((r) => r.slot === "primary");
  const signedCount = roster.filter((r) => r.status === "signed").length;
  const complete = primaries.length > 0 && signedCount >= primaries.length;
  const draftLabel = roster[0]?.revisionLabel || null;
  const mine = roster.find((r) => r.reviewerUserId === uid && r.status === "pending" && (r.slot === "primary" || r.activated));
  const signerName = (userEmail?.split("@")[0] ?? "").trim() || "user";
  const label = doc.documentNumber || doc.title || doc.name || "this document";

  // Who may SEE the in-review draft: reviewers/alternates + owner/publisher +
  // Admin/DocCtrl + explicitly-configured draft viewers. Everyone else only
  // learns that a review is in progress.
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";
  const canSeeDraft = isController || canManage
    || roster.some((r) => r.reviewerUserId === uid)
    || (uid ? (control?.draftViewerIds ?? []).includes(uid) : false)
    || (control?.draftViewerRoles ?? []).includes((activeRole as string) ?? "");

  // ── Actions ──
  const doSign = async (_i: unknown, statement: string, signatureImage?: string | null) => {
    if (!uid || !doc.id || !mine || !pendingVersionId) return;
    setBusy(true);
    try {
      await recordReviewSignoff({
        orgId, documentId: doc.id, libraryId: doc.libraryId, versionId: pendingVersionId,
        revisionLabel: draftLabel || "", contentHash: mine.contentHash,
        signoffId: mine.id, signerUserId: uid, signerName, signerRole: activeRole ?? null, signerEmail: userEmail ?? null,
        statement, signatureImage: signatureImage ?? null,
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
  const publish = async () => {
    if (!doc.id) return;
    setBusy(true);
    try {
      const res = await finalizeReviewedRevision({ orgId, documentId: doc.id, actorId: uid, actorName: userEmail });
      if (!res.published) { window.alert(res.reason === "incomplete" ? "Not all required reviewers have signed off yet." : `Couldn't publish: ${res.reason ?? "unknown"}`); }
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
        {!loading && <span className="ml-auto text-[10px] font-bold text-violet-700">{signedCount}/{primaries.length} signed</span>}
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
                  {r.slot === "alternate" && <span className="text-[var(--color-text-muted)]"> · alt</span>}
                  {r.reviewerRole ? <span className="text-[var(--color-text-muted)]"> · {r.reviewerRole}</span> : null}
                </span>
                <span className="ml-auto shrink-0">{statusChip(r)}</span>
                {canManage && r.slot === "alternate" && !r.activated && r.status === "pending" && (
                  <button title="Activate alternate" onClick={() => void activate(r.id)} disabled={busy} className="shrink-0 p-1 rounded hover:bg-white text-violet-600"><UserPlus className="w-3 h-3" /></button>
                )}
              </div>
            ))}
          </div>

          {canManage && (
            <button
              onClick={() => void publish()}
              disabled={busy || !complete}
              title={complete ? "Publish the approved revision" : "Waiting on reviewer sign-off"}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-black shadow hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpFromLine className="w-3.5 h-3.5" />} Publish approved revision
            </button>
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
