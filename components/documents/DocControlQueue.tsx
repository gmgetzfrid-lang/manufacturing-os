"use client";

// DocControlQueue — Document Control's open-items review queue.
//
// Three item classes, all "debt that cannot be dismissed, only resolved":
//
//   1. OPEN BRANCHES — stale-base overrides awaiting merge/withdraw. The
//      escape hatch is allowed, but every use lands here with an owner.
//   2. UNVERIFIED PROVENANCE — revisions published with no recorded
//      checkout/download trail. Verified with one click after confirming
//      with the author — QA receiving inspection, not a scoreboard.
//   3. LONG-HELD CHECKOUTS (14d+) — a stale lock stops being the holder's
//      private secret; DocCtrl decides: nudge or force-release.
//
// Rendered for Admin/DocCtrl on the control tower. Quiet when empty.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GitBranch, Flag, KeyRound, Check, Loader2, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useDraft } from "@/hooks/useDraft";
import { listOpenBranchesForOrg, resolveBranch, type RevisionBranch } from "@/lib/branches";

import { friendlyError } from "@/lib/friendlyError";
const STALE_DAYS = 14;

interface UnverifiedRev {
  id: string;
  recordId: string;
  revisionLabel: string;
  createdByName: string | null;
  createdAt: string;
  libraryId: string | null;
  docLabel: string;
}

interface StaleCheckout {
  sessionId: string;
  documentId: string;
  libraryId: string | null;
  userName: string | null;
  startedAt: string;
  purpose: string | null;
  docLabel: string;
}

interface DeletionRequest {
  auditId: string;
  documentId: string;
  label: string;
  reason: string | null;
  requestedBy: string | null;
  requestedAt: string;
  libraryId: string | null;
}

interface DocControlQueueProps {
  orgId: string;
  currentUser: { uid: string; email: string | null; role: string | null };
}

export default function DocControlQueue({ orgId, currentUser }: DocControlQueueProps) {
  const [branches, setBranches] = useState<RevisionBranch[]>([]);
  const [unverified, setUnverified] = useState<UnverifiedRev[]>([]);
  const [stale, setStale] = useState<StaleCheckout[]>([]);
  const [deletionRequests, setDeletionRequests] = useState<DeletionRequest[]>([]);
  const [docLabels, setDocLabels] = useState<Map<string, { label: string; libraryId: string | null }>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolveFor, setResolveFor] = useState<string | null>(null);
  const [resolveNote, setResolveNote] = useState("");
  // The resolution note is kept on this device until it's on the record.
  useDraft<string>(resolveFor ? `branch-resolve:${resolveFor}` : null, resolveNote, setResolveNote, (v) => !v.trim());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [openBranches, unverifiedRes, staleRes, delReqRes, delResolvedRes] = await Promise.all([
        listOpenBranchesForOrg(orgId),
        supabase
          .from("document_versions")
          .select("id, record_id, revision_label, created_by_name, created_at")
          .eq("org_id", orgId)
          .eq("provenance", "unverified")
          .is("provenance_verified_at", null)
          .order("created_at", { ascending: true })
          .limit(25),
        supabase
          .from("checkout_sessions")
          .select("id, document_id, library_id, user_name, started_at, purpose")
          .eq("org_id", orgId)
          .eq("status", "active")
          .lt("started_at", new Date(Date.now() - STALE_DAYS * 24 * 3600 * 1000).toISOString())
          .order("started_at", { ascending: true })
          .limit(25),
        // Deletion requests live as audit rows (no dedicated table); a
        // matching DELETION_REQUEST_RESOLVED row closes them. This queue is
        // what makes the request durable — before it, every controller
        // dismissing the bell made the request evaporate.
        supabase
          .from("audit_logs")
          .select("id, resource_id, user_email, timestamp, details")
          .eq("org_id", orgId)
          .eq("action", "DELETION_REQUESTED")
          .gt("timestamp", new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString())
          .order("timestamp", { ascending: true })
          .limit(25),
        supabase
          .from("audit_logs")
          .select("resource_id, timestamp")
          .eq("org_id", orgId)
          .eq("action", "DELETION_REQUEST_RESOLVED")
          .gt("timestamp", new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()),
      ]);

      const unverifiedRows = ((unverifiedRes.data as Array<Record<string, unknown>>) ?? []);
      const staleRows = ((staleRes.data as Array<Record<string, unknown>>) ?? []);

      // Resolve doc labels for everything in one query.
      const docIds = [...new Set([
        ...openBranches.map((b) => b.documentId),
        ...unverifiedRows.map((r) => String(r.record_id)),
        ...staleRows.map((r) => String(r.document_id)),
      ])];
      const labels = new Map<string, { label: string; libraryId: string | null }>();
      if (docIds.length > 0) {
        const { data: docs } = await supabase
          .from("documents")
          .select("id, document_number, title, name, library_id")
          .in("id", docIds);
        for (const d of (docs as Array<Record<string, unknown>>) ?? []) {
          labels.set(String(d.id), {
            label: String(d.document_number || d.title || d.name || "Document"),
            libraryId: (d.library_id as string | null) ?? null,
          });
        }
      }

      setBranches(openBranches);
      setUnverified(unverifiedRows.map((r) => ({
        id: String(r.id),
        recordId: String(r.record_id),
        revisionLabel: String(r.revision_label ?? "?"),
        createdByName: (r.created_by_name as string | null) ?? null,
        createdAt: String(r.created_at),
        libraryId: labels.get(String(r.record_id))?.libraryId ?? null,
        docLabel: labels.get(String(r.record_id))?.label ?? "Document",
      })));
      setStale(staleRows.map((r) => ({
        sessionId: String(r.id),
        documentId: String(r.document_id),
        libraryId: (r.library_id as string | null) ?? labels.get(String(r.document_id))?.libraryId ?? null,
        userName: (r.user_name as string | null) ?? null,
        startedAt: String(r.started_at),
        purpose: (r.purpose as string | null) ?? null,
        docLabel: labels.get(String(r.document_id))?.label ?? "Document",
      })));
      const resolvedAt = new Map<string, string>();
      for (const r of ((delResolvedRes.data as Array<Record<string, unknown>>) ?? [])) {
        const key = String(r.resource_id);
        const at = String(r.timestamp);
        if (!resolvedAt.has(key) || at > (resolvedAt.get(key) ?? "")) resolvedAt.set(key, at);
      }
      setDeletionRequests((((delReqRes.data as Array<Record<string, unknown>>) ?? []))
        .filter((r) => {
          const res = resolvedAt.get(String(r.resource_id));
          return !res || res < String(r.timestamp);
        })
        .map((r) => {
          const det = (r.details as Record<string, unknown> | null) ?? {};
          return {
            auditId: String(r.id),
            documentId: String(r.resource_id),
            label: String(det.label || labels.get(String(r.resource_id))?.label || "Document"),
            reason: (det.reason as string | null) ?? null,
            requestedBy: (r.user_email as string | null) ?? null,
            requestedAt: String(r.timestamp),
            libraryId: labels.get(String(r.resource_id))?.libraryId ?? null,
          };
        }));
      setDocLabels(labels);
    } catch (e) {
      // Pre-migration environments simply render nothing.
      console.warn("[DocControlQueue] load failed", e);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const handleResolve = async (branch: RevisionBranch, resolution: "merged" | "withdrawn") => {
    if (resolveNote.trim().length < 5) {
      setError("A resolution note is required (at least 5 characters) - it goes on the record.");
      return;
    }
    setBusyId(branch.id);
    setError(null);
    try {
      await resolveBranch({
        branchId: branch.id,
        resolution,
        note: resolveNote.trim(),
        orgId,
        actorUserId: currentUser.uid,
        actorName: currentUser.email?.split("@")[0] || "User",
        actorEmail: currentUser.email ?? undefined,
        actorRole: currentUser.role ?? undefined,
      });
      setResolveFor(null);
      setResolveNote("");
      await load();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleVerify = async (rev: UnverifiedRev) => {
    setBusyId(rev.id);
    setError(null);
    try {
      const { error: vErr } = await supabase
        .from("document_versions")
        .update({
          provenance: "declared",
          provenance_verified_at: new Date().toISOString(),
          provenance_verified_by: currentUser.email?.split("@")[0] || currentUser.uid,
        })
        .eq("id", rev.id);
      if (vErr) setError(`Couldn't mark it checked: ${vErr.message}`);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const handleResolveDeletion = async (req: DeletionRequest) => {
    setBusyId(req.auditId);
    setError(null);
    try {
      const { error: rErr } = await supabase.from("audit_logs").insert({
        action: "DELETION_REQUEST_RESOLVED",
        resource_id: req.documentId,
        resource_type: "document",
        org_id: orgId,
        user_id: currentUser.uid,
        user_email: currentUser.email,
        details: { requestAuditId: req.auditId },
      });
      if (rErr) setError(`Couldn't close the request: ${rErr.message}`);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const total = branches.length + unverified.length + stale.length + deletionRequests.length;
  if (total === 0) return null;

  const docLink = (docId: string, libraryId: string | null) =>
    libraryId ? `/documents/${libraryId}?doc=${docId}` : "/documents";

  return (
    <div className="mb-4 rounded-lg border-2 border-[var(--color-border)] bg-[var(--color-surface-2)] overflow-hidden">
      <div className="px-4 py-2.5 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] flex items-center gap-2">
        <Flag className="w-4 h-4 text-[var(--color-text-muted)]" />
        <span className="text-[13px] font-semibold text-[var(--color-text)] ">
          Document Control - open items ({total})
        </span>
        <span className="text-[13px] text-[var(--color-text)]">resolved on the record, never dismissed</span>
      </div>

      <div className="p-3 space-y-2">
        {/* Open branches */}
        {branches.map((b) => {
          const meta = docLabels.get(b.documentId);
          return (
            <div key={b.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="flex items-start gap-2">
                <GitBranch className="w-4 h-4 mt-0.5 text-[var(--color-text-muted)] shrink-0" />
                <div className="flex-1 min-w-0 text-[13px]">
                  <b>Unreconciled branch</b> on{" "}
                  <Link href={docLink(b.documentId, meta?.libraryId ?? null)} className="text-[var(--color-accent-text)] hover:underline">
                    {meta?.label ?? "Document"}
                  </Link>{" "}
                  by <b>{b.createdByName || b.createdBy}</b> · {new Date(b.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5 italic">&ldquo;{b.reason}&rdquo;</div>
                </div>
                {resolveFor === b.id ? null : (
                  <button
                    onClick={() => { setResolveFor(b.id); setResolveNote(""); setError(null); }}
                    className="shrink-0 px-2 py-1 rounded-lg text-[13px] font-bold border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                  >
                    Resolve…
                  </button>
                )}
              </div>
              {resolveFor === b.id && (
                <div className="mt-2 pl-6 space-y-1.5">
                  <input
                    value={resolveNote}
                    onChange={(e) => setResolveNote(e.target.value)}
                    placeholder='How was it reconciled? e.g. "both changes merged into Rev 5"'
                    className="w-full px-2 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-[13px]"
                  />
                  {error && <div className="text-[13px] text-[var(--state-overdue)] font-bold">{error}</div>}
                  <div className="flex gap-1.5 justify-end">
                    <button onClick={() => setResolveFor(null)} className="px-2 py-1 rounded-lg text-[13px] font-bold border border-[var(--color-border)]">Cancel</button>
                    <button
                      onClick={() => void handleResolve(b, "withdrawn")}
                      disabled={busyId === b.id}
                      className="px-2 py-1 rounded-lg text-[13px] font-bold border border-[color-mix(in_srgb,var(--state-overdue)_35%,transparent)] text-[var(--state-overdue)] hover:bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] disabled:opacity-50"
                    >
                      Withdrawn
                    </button>
                    <button
                      onClick={() => void handleResolve(b, "merged")}
                      disabled={busyId === b.id}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[13px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                    >
                      {busyId === b.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      Merged
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Unverified provenance */}
        {unverified.map((rev) => (
          <div key={rev.id} className="rounded-xl border border-[color-mix(in_srgb,var(--state-overdue)_35%,transparent)] bg-[var(--color-surface)] p-3 flex items-start gap-2">
            <Flag className="w-4 h-4 mt-0.5 text-[var(--state-overdue)] shrink-0" />
            <div className="flex-1 min-w-0 text-[13px]">
              <b>Rev {rev.revisionLabel}</b> of{" "}
              <Link href={docLink(rev.recordId, rev.libraryId)} className="text-[var(--color-accent-text)] hover:underline">
                {rev.docLabel}
              </Link>{" "}
              was published with <b>no recorded checkout or download trail</b>
              {rev.createdByName ? <> by <b>{rev.createdByName}</b></> : null} · {new Date(rev.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.
              <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">
                Confirm with the author what their work was based on, then verify.
              </div>
            </div>
            <button
              onClick={() => void handleVerify(rev)}
              disabled={busyId === rev.id}
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[13px] font-bold border border-[color-mix(in_srgb,var(--state-released)_35%,transparent)] text-[var(--state-released)] hover:bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)] disabled:opacity-50"
            >
              {busyId === rev.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Verified with author
            </button>
          </div>
        ))}

        {/* Long-held checkouts */}
        {stale.map((s) => {
          const days = Math.floor((Date.now() - Date.parse(s.startedAt)) / 86400000);
          return (
            <div key={s.sessionId} className="rounded-xl border border-[color-mix(in_srgb,var(--state-held)_40%,transparent)] bg-[var(--color-surface)] p-3 flex items-start gap-2">
              <KeyRound className="w-4 h-4 mt-0.5 text-[var(--state-held)] shrink-0" />
              <div className="flex-1 min-w-0 text-[13px]">
                <Link href={docLink(s.documentId, s.libraryId)} className="text-[var(--color-accent-text)] hover:underline">
                  {s.docLabel}
                </Link>{" "}
                has been checked out by <b>{s.userName || "a user"}</b> for <b>{days} days</b>
                {s.purpose ? <> ({s.purpose})</> : null}.
                <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">
                  Nudge them, or force-release from the document&apos;s checkout popover if the work is done.
                </div>
              </div>
            </div>
          );
        })}

        {/* Deletion requests — durable queue, not just a dismissible bell. */}
        {deletionRequests.map((req) => (
          <div key={req.auditId} className="rounded-xl border border-[color-mix(in_srgb,var(--state-overdue)_35%,transparent)] bg-[var(--color-surface)] p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--state-overdue)] shrink-0" />
            <div className="flex-1 min-w-0 text-[13px]">
              <Link href={docLink(req.documentId, req.libraryId)} className="text-[var(--color-accent-text)] hover:underline">
                {req.label}
              </Link>{" "}
              - <b>deletion requested</b> by {req.requestedBy || "the owner"} on {new Date(req.requestedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.
              {req.reason && <div className="text-[13px] italic text-[var(--color-text-muted)] mt-0.5">&ldquo;{req.reason}&rdquo;</div>}
              <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">
                Review the document, then delete/archive it (or decline) - and mark this request handled.
              </div>
            </div>
            <button
              onClick={() => void handleResolveDeletion(req)}
              disabled={busyId === req.auditId}
              className="shrink-0 px-2 py-1 rounded-md text-[13px] font-bold border border-[color-mix(in_srgb,var(--state-overdue)_35%,transparent)] text-[var(--state-overdue)] hover:bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] disabled:opacity-50"
            >
              Mark handled
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
