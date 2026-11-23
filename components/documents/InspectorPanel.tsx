"use client";

import React, { useEffect, useState } from "react";
import { Search, Pencil, History, ArrowRight, Lock, Trash2, Maximize2, Shield, Layers, LogIn, LogOut, FileText, User, Calendar, ArrowUpFromLine, Archive, ArchiveRestore, Send, GitBranch, GitCompare, Wrench, Check, Package, ChevronRight, Tag, Users, ClipboardCheck, Hand, StickyNote } from "lucide-react";
import NextLink from "next/link";
import SecureDocViewer from "@/components/viewers/SecureDocViewer";
import CheckoutStatusCell from "@/components/documents/CheckoutStatusCell";
import VersionHistoryPanel from "@/components/documents/VersionHistoryPanel";
import HoldStrip from "@/components/documents/HoldStrip";
import WatchButton from "@/components/ui/WatchButton";
import QuickNoteComposer from "@/components/notes/QuickNoteComposer";
import PresenceIndicator from "@/components/ui/PresenceIndicator";
import SendSheet from "@/components/documents/SendSheet";
import { Share as ShareIcon } from "lucide-react";
import ModifyDocumentRouter from "@/components/documents/lifecycle/ModifyDocumentRouter";
import ImpactPanel from "@/components/documents/ImpactPanel";
import RelatedPanel from "@/components/documents/RelatedPanel";
import AiBoundaryChip from "@/components/documents/AiBoundaryChip";
import DistributionRecall from "@/components/documents/DistributionRecall";
import DistributionAcks from "@/components/documents/DistributionAcks";
import EquipmentTagsStrip from "@/components/assets/EquipmentTagsStrip";
import AssetTagChip from "@/components/assets/AssetTagChip";
import ReviewSection from "@/components/documents/ReviewSection";
import AckSection from "@/components/documents/AckSection";
import ReviewGateSection from "@/components/documents/ReviewGateSection";
import RetentionSection from "@/components/documents/RetentionSection";
import OriginSection from "@/components/documents/OriginSection";
import EffectivePill from "@/components/documents/EffectivePill";
import ReviewPill from "@/components/documents/ReviewPill";
import RetentionPill from "@/components/documents/RetentionPill";
import OriginBadge from "@/components/documents/OriginBadge";
import DocClassControl from "@/components/documents/DocClassControl";
import AddToPackageButton from "@/components/documents/AddToPackageButton";
import MoreMenu, { type MoreItem } from "@/components/ui/MoreMenu";
import { heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { docStatusTone, humanDate } from "@/components/documents/StatusTag";
import CopyId from "@/components/ui/CopyId";
import { SkeletonText } from "@/components/ui/Skeleton";
import quietTags from "@/components/documents/quietTags.module.css";
import CheckoutHistoryPanel from "@/components/documents/CheckoutHistoryPanel";
import CompareRevisionsModal from "@/components/documents/CompareRevisionsModal";
import { effectiveOwnerForDocument, requestDeletion } from "@/lib/ownership";
import { appAlert, appPrompt } from "@/components/providers/DialogProvider";
import { supabase } from "@/lib/supabase";
import { openEvidencePack } from "@/lib/evidencePack";
import { isDocumentCheckedOut } from "@/lib/documentGuards";
import { collectTagGroups } from "@/lib/documentTags";
import type { DocumentRecord, DocumentVersion, LibraryCustomColumn } from "@/types/schema";
import { AuditEntry } from "@/lib/audit";

import { friendlyError } from "@/lib/friendlyError";
interface InspectorPanelProps {
  selectedDoc: DocumentRecord | null;
  selectedVersion: DocumentVersion | null;
  activeRole: string;
  uid: string | null;
  userEmail: string | null;
  onClose: () => void;
  onMetadata: () => void;
  onHistory: () => void;
  onMove: () => void;
  onPermissions: () => void;
  onDelete: () => void;
  onCheckout: (doc: DocumentRecord) => void;
  onForceUnlock?: (doc: DocumentRecord) => void;
  onFullScreen: () => void;
  onToggleStage?: (doc: DocumentRecord) => void;
  isStaged?: boolean;
  folderPath?: string;
  /** Open the Rev-Up modal. Inspector hides the button when not provided. */
  onRevUp?: () => void;
  /** Per-library publish authority (Admin/DocCtrl, or a role/user granted "publish"
   *  on THIS library). Gates the Publish-New-Revision button and Revert — these are
   *  no longer broad-controller-only. Defaults to false. */
  canPublish?: boolean;
  /** Open the Supersede modal — admin/DocCtrl only. */
  onSupersede?: () => void;
  /** Open the Archive (or Unarchive) confirm modal — admin/DocCtrl only. */
  onArchive?: () => void;
  /** Open the Revert confirm modal for a specific previous version. */
  onRevertVersion?: (v: DocumentVersion) => void;
  /** Force a re-fetch of the version history list (bump after rev-up commits). */
  versionHistoryRefreshKey?: number;
  /** Open a specific historical version in the full-screen viewer. */
  onOpenVersion?: (v: DocumentVersion) => void;
  // Asset-tag chip integration — when provided, the inspector renders a
  // tag-photo strip directly so users don't have to open Metadata Editor.
  orgId?: string;
  customColumns?: LibraryCustomColumn[];
}

function formatBytes(bytes?: number): string {
  if (!bytes && bytes !== 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** "today at 1:37 PM", "yesterday at 9:05 AM", else "Nov 11". */
function whenText(value: unknown): string {
  if (!value) return "";
  const v = value as { toDate?: () => Date; seconds?: number };
  const d = value instanceof Date ? value
    : typeof v.toDate === "function" ? v.toDate()
    : typeof v.seconds === "number" ? new Date(v.seconds * 1000)
    : new Date(value as string);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `today at ${time}`;
  if (d.toDateString() === new Date(now.getTime() - 86400e3).toDateString()) return `yesterday at ${time}`;
  return humanDate(d);
}

function formatTs(value: unknown): string {
  if (!value) return "-";
  try {
    const d = typeof value === "string" ? new Date(value) : value instanceof Date ? value : null;
    if (!d) return "-";
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "-";
  }
}

export default function InspectorPanel({
  selectedDoc,
  selectedVersion,
  activeRole,
  uid,
  userEmail,
  onMetadata,
  onHistory,
  onMove,
  onPermissions,
  onDelete,
  onCheckout,
  onForceUnlock,
  onFullScreen,
  onToggleStage,
  isStaged,
  onRevUp,
  canPublish = false,
  onSupersede,
  onArchive,
  onRevertVersion,
  versionHistoryRefreshKey,
  onOpenVersion,
  orgId,
  customColumns,
}: InspectorPanelProps) {
  const canManageAssets = activeRole === 'Admin' || activeRole === 'Manager' || activeRole === 'Supervisor'
    || (activeRole?.includes('Engineer') ?? false) || activeRole === 'Drafter' || activeRole === 'DocCtrl';
  const [recentAudits, setRecentAudits] = useState<AuditEntry[]>([]);
  const [modifyOpen, setModifyOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [pkgAsk, setPkgAsk] = useState(0);
  const [openBranches, setOpenBranches] = useState<import("@/lib/branches").RevisionBranch[]>([]);

  // Open branch debt for the selected doc — the banner below must appear
  // wherever the document does. Cheap: one indexed query per selection.
  useEffect(() => {
    let alive = true;
    // All state mutations inside the async IIFE so render stays pure.
    (async () => {
      setOpenBranches([]);
      if (!selectedDoc?.id) return;
      try {
        const { listOpenBranchesForDocument } = await import("@/lib/branches");
        const rows = await listOpenBranchesForDocument(selectedDoc.id!);
        if (alive) setOpenBranches(rows);
      } catch { /* pre-migration env: no banner */ }
    })();
    return () => { alive = false; };
  }, [selectedDoc?.id]);
  const isController = activeRole === 'Admin' || activeRole === 'DocCtrl';

  // Cheap per-selection counts: they let the ALERTS zone render only when
  // something is actually wrong, and give drawer headers honest summaries
  // ("3 issued · 8/12 confirmed") without opening them.
  const [activeHoldCount, setActiveHoldCount] = useState(0);
  const [staleHolderCount, setStaleHolderCount] = useState(0);
  const [distSummary, setDistSummary] = useState<{ issued: number; issuedCapped: boolean; ackDone: number; ackTotal: number } | null>(null);
  const [holdsRefresh, setHoldsRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    // Reset SYNCHRONOUSLY before any await — switching documents must never
    // show the previous document's alerts/pills against the new one while
    // the fresh counts are still in flight.
    setActiveHoldCount(0);
    setStaleHolderCount(0);
    setDistSummary(null);
    (async () => {
      if (!selectedDoc?.id || !selectedDoc.orgId) return;
      try {
        const { listActiveHoldsForDocument } = await import("@/lib/holds");
        const holds = await listActiveHoldsForDocument(selectedDoc.id);
        if (alive) setActiveHoldCount(holds.length);
      } catch { if (alive) setActiveHoldCount(0); }
      try {
        const { getDocumentRecall } = await import("@/lib/staleCopies");
        const holders = await getDocumentRecall(selectedDoc.id, selectedDoc.currentVersionId ?? null);
        if (alive) setStaleHolderCount(holders.filter((h) => !h.hasCurrent).length);
      } catch { if (alive) setStaleHolderCount(0); }
      try {
        const { listTransmittalsForDocument } = await import("@/lib/transmittals");
        const list = await listTransmittalsForDocument(selectedDoc.orgId, selectedDoc.id);
        // listTransmittalsForDocument caps at 50 rows — an honest pill says so.
        const issued = list.filter((t) => t.status === "issued" || t.status === "acknowledged").length;
        const issuedCapped = list.length >= 50;
        let ackDone = 0;
        let ackTotal = 0;
        if (selectedDoc.currentVersionId) {
          // COUNT queries, not truncated row fetches — the collapsed pill must
          // agree with the DistributionAcks panel it summarizes.
          const base = () => supabase.from("distribution_acks")
            .select("id", { count: "exact", head: true })
            .eq("document_id", selectedDoc.id!)
            .eq("version_id", selectedDoc.currentVersionId!);
          const [{ count: total }, { count: done }] = await Promise.all([
            base(),
            base().not("acknowledged_at", "is", null),
          ]);
          ackTotal = total ?? 0;
          ackDone = done ?? 0;
        }
        if (alive) setDistSummary({ issued, issuedCapped, ackDone, ackTotal });
      } catch { if (alive) setDistSummary(null); }
    })();
    return () => { alive = false; };
  }, [selectedDoc?.id, selectedDoc?.orgId, selectedDoc?.currentVersionId, holdsRefresh]);

  // Pull the stored CAD source for the current revision. Records an EDIT
  // intent pinned to that revision (the drafter's base is now on record) and
  // audit-logs the pull. The selfish pitch: the vault always has the current
  // DWG — never discover mid-job that a desktop copy was two revs old.
  const handleGetSource = async () => {
    if (!selectedDoc?.id || !selectedDoc.orgId || !uid || !selectedVersion?.sourceFileKey) return;
    setSourceBusy(true);
    try {
      let url = selectedVersion.sourceFileKey;
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("blob:")) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error("Not authenticated");
        const res = await fetch(
          `/api/storage/download-url?path=${encodeURIComponent(url)}&expiresIn=3600`,
          { headers: { authorization: `Bearer ${session.access_token}` } },
        );
        if (!res.ok) throw new Error("Could not resolve the source file");
        url = (await res.json()).url as string;
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = selectedVersion.sourceFileName || "source.dwg";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      const { recordIntent } = await import("@/lib/intents");
      void recordIntent({
        orgId: selectedDoc.orgId,
        documentId: selectedDoc.id,
        libraryId: selectedDoc.libraryId ?? null,
        userId: uid,
        userName: userEmail?.split("@")[0] ?? null,
        kind: "edit",
        source: "source_pull",
        baseVersionId: selectedVersion.id ?? selectedDoc.currentVersionId ?? null,
      });
      const { logFileDownload } = await import("@/lib/audit");
      void logFileDownload({
        orgId: selectedDoc.orgId,
        fileId: selectedDoc.id,
        fileName: selectedVersion.sourceFileName || "source",
        userId: uid,
        userEmail: userEmail || "unknown",
        userRole: activeRole,
        version: selectedVersion.revisionLabel,
      });
    } catch (e) {
      await appAlert({ message: `Could not fetch the CAD source: ${friendlyError(e)}`, tone: "danger" });
    } finally {
      setSourceBusy(false);
    }
  };
  const [compareOpen, setCompareOpen] = useState(false);
  // Which document's equipment pills are showing in full ("+N" pressed).
  const [allTagsFor, setAllTagsFor] = useState<string | null>(null);

  // Ownership grant (Phase 2): the document's effective owner may manage it —
  // publish/supersede/archive/edit — even without a controller role or library
  // publish authority. Hard-delete and force-unlock stay controller-only.
  const [isOwner, setIsOwner] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!selectedDoc?.id || !uid) { if (alive) setIsOwner(false); return; }
      try {
        const o = await effectiveOwnerForDocument({ ownerUserId: selectedDoc.ownerUserId, ownerName: selectedDoc.ownerName, collectionId: selectedDoc.collectionId, libraryId: selectedDoc.libraryId });
        if (alive) setIsOwner(!!o.userId && o.userId === uid);
      } catch { if (alive) setIsOwner(false); }
    })();
    return () => { alive = false; };
  }, [selectedDoc?.id, selectedDoc?.ownerUserId, selectedDoc?.ownerName, selectedDoc?.collectionId, selectedDoc?.libraryId, uid]);
  const canManage = isController || isOwner;
  const canPublishEff = canPublish || isOwner;
  // Authoritative lock only — a stale collaborator list with no lock holder is
  // NOT a checkout (see isDocumentCheckedOut).
  const isCheckedOut = isDocumentCheckedOut(selectedDoc);
  const checkedOutByMe = selectedDoc?.checkedOutBy === uid;

  const [auditState, setAuditState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!selectedDoc?.id || !selectedDoc.orgId) {
        if (alive) { setRecentAudits([]); setAuditState("ready"); }
        return;
      }
      setAuditState("loading");
      const { data, error: auditErr } = await supabase
        .from("audit_logs")
        .select("*")
        .eq("org_id", selectedDoc.orgId)
        .eq("resource_id", selectedDoc.id)
        .order("timestamp", { ascending: false })
        .limit(3);
      if (alive) setAuditState(auditErr ? "failed" : "ready");
      if (alive && data) {
        setRecentAudits(data.map((r) => ({
          action: r.action,
          resourceId: r.resource_id,
          resourceType: r.resource_type,
          orgId: r.org_id,
          userId: r.user_id,
          userEmail: r.user_email,
          userRole: r.user_role,
          details: r.details,
          timestamp: r.timestamp,
        } as AuditEntry)));
      }
    })();
    return () => { alive = false; };
  }, [selectedDoc?.id, selectedDoc?.orgId]);

  if (!selectedDoc) {
    return (
      <div className="text-center py-12 text-[var(--color-text-faint)] bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border)] border-dashed">
        <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p className="text-[14px]">Select a document to view details.</p>
      </div>
    );
  }

  const title = selectedDoc.title || selectedDoc.name || "Untitled";
  const meta = (selectedDoc.metadata ?? {}) as Record<string, unknown>;
  const sizeBytes = selectedVersion?.size ?? (typeof meta.size_bytes === "string" ? Number(meta.size_bytes) : undefined);
  const fileType = selectedVersion?.fileType || (typeof meta.mime_type === "string" ? meta.mime_type : undefined) || "-";
  const ext = (typeof meta.extension === "string" ? meta.extension : "") || (selectedDoc.name?.split(".").pop() ?? "");
  // The big line is the item's number; the title shows under it when it says more.
  const bigName = selectedDoc.documentNumber || title;
  const showTitle = !!selectedDoc.documentNumber && title.trim() !== selectedDoc.documentNumber.trim();
  const statusPill = { good: "ui-pill is-good", warn: "ui-pill is-warn", bad: "ui-pill is-bad", none: "ui-pill is-muted" }[docStatusTone(selectedDoc.status)];
  const sheetRaw = meta.sheet ?? selectedDoc.sheetNumber;
  const sheet = sheetRaw == null || sheetRaw === "" ? null : String(sheetRaw);
  // Equipment as pills you can press (photos, linked drawings): four, then "+N".
  const tags = collectTagGroups(selectedDoc.metadata as Record<string, unknown> | null, customColumns)
    .flatMap((g) => g.tags.map((t) => ({ tag: t, label: g.label, referenceKind: g.referenceKind })));
  const allTags = allTagsFor === (selectedDoc.id ?? "");
  const shownTags = allTags ? tags : tags.slice(0, 4);

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">

      {/* HEADER: the drawing number (click to copy), its title, then its
          facts in one quiet row (rev, status, who has it, sheet) and what
          changed last, so the panel answers "is this the one I want". ── */}
      <div>
        <h2 className="font-display text-[26px] leading-[1.15] font-semibold tabular-nums text-[var(--color-heading)] break-words [&_button]:!text-[26px]">
          {selectedDoc.documentNumber
            ? <CopyId value={selectedDoc.documentNumber} label="document number" />
            : bigName}
        </h2>
        {showTitle && (
          <p className="mt-1 text-[16px] text-[var(--color-text)] break-words">{title}</p>
        )}
        <dl className="mt-4 flex flex-wrap items-start gap-x-8 gap-y-3">
          <div className="min-w-0">
            <dt className="text-[13px] text-[var(--color-text-muted)]">Rev</dt>
            <dd className="mt-0.5 text-[20px] leading-tight">
              {selectedDoc.rev ? <CopyId value={selectedDoc.rev} label="revision" /> : <span className="text-[var(--color-text-faint)]">-</span>}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[13px] text-[var(--color-text-muted)]">Status</dt>
            <dd className="mt-1.5 min-w-0">
              <span className={`${statusPill} !text-[15px] max-w-full`}>
                <span className="truncate">{selectedDoc.status || "None"}</span>
              </span>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[13px] text-[var(--color-text-muted)]">Checked out</dt>
            <dd className="mt-1.5 min-w-0"
              title={isCheckedOut ? `Checked out by ${checkedOutByMe ? "you" : selectedDoc.checkedOutByName || "someone else"}` : undefined}>
              {isCheckedOut
                ? <span className="ui-pill is-warn !text-[15px] max-w-full"><span className="truncate">{checkedOutByMe ? "By you" : `By ${selectedDoc.checkedOutByName || "someone"}`}</span></span>
                : <span className="ui-pill is-muted !text-[15px]">No</span>}
            </dd>
          </div>
          {sheet && (
            <div className="min-w-0">
              <dt className="text-[13px] text-[var(--color-text-muted)]">Sheet</dt>
              <dd className="mt-0.5 ui-id text-[20px] leading-tight">{sheet}</dd>
            </div>
          )}
        </dl>
        {/* What changed last, in words: who issued which rev, and when. */}
        {(() => {
          const by = (selectedVersion?.createdByName || "").split("@")[0];
          const when = selectedVersion?.releasedAt ?? selectedVersion?.createdAt ?? selectedDoc.updatedAt;
          const verb = selectedDoc.status === "Draft" ? "uploaded" : "issued";
          const rev = selectedVersion?.revisionLabel ?? selectedDoc.rev;
          return (
            <p className="mt-3 text-[14px] text-[var(--color-text-muted)]">
              {rev ? <>Rev <span className="ui-id text-[var(--color-text)]">{rev}</span> {verb}</> : "Updated"}
              {by ? <> by <span className="text-[var(--color-text)]">{by}</span></> : null}
              {when ? <>, {whenText(when)}</> : null}
              {isCheckedOut && selectedDoc.checkedOutAt ? <>. Checked out {checkedOutByMe ? "by you" : `by ${selectedDoc.checkedOutByName || "someone"}`} {whenText(selectedDoc.checkedOutAt)}</> : null}
              .
            </p>
          );
        })()}
        {(tags.length > 0 || selectedDoc.effectiveDate) && (
          <div className={`${quietTags.quiet} mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[14px]`}>
            {tags.length > 0 && (
              <span className="min-w-0 inline-flex flex-wrap items-center gap-1">
                <span className="text-[var(--color-text-muted)] mr-1">Equipment</span>
                {shownTags.map((t, i) => (
                  <AssetTagChip key={`${t.tag}-${i}`} tag={t.tag} type={t.label} referenceKind={t.referenceKind}
                    orgId={orgId ?? selectedDoc.orgId ?? undefined} userId={uid || undefined} canManage={canManageAssets || isOwner} />
                ))}
                {tags.length > 4 && (
                  <button type="button" className="ui-tag is-more tabular-nums" aria-expanded={allTags}
                    onClick={() => setAllTagsFor(allTags ? null : selectedDoc.id ?? "")}
                    title={allTags ? "Show fewer" : `Show ${tags.slice(4).map((t) => t.tag).join(", ")}`}>
                    {allTags ? "Less" : `+${tags.length - 4}`}
                  </button>
                )}
              </span>
            )}
            {selectedDoc.effectiveDate && <EffectivePill effectiveDate={selectedDoc.effectiveDate} />}
          </div>
        )}
      </div>

      {/* UNRECONCILED BRANCH — the most serious exception state a document
          can carry. A doc with unmerged parallel work must look WRONG
          everywhere you meet it, not just in specialist views. */}
      {openBranches.length > 0 && (
        <div className="border-l-[3px] border-[var(--state-held)] pl-3 text-[14px] text-[var(--color-text)]">
          <b className="inline-flex items-center gap-1"><GitBranch className="w-3.5 h-3.5" /> The current revision is missing parallel work.</b>
          {openBranches.map((b) => (
            <span key={b.id} className="block mt-1 text-[13px] text-[var(--color-text-muted)]">
              {b.createdByName || b.createdBy} published it on {humanDate(b.createdAt)}: &ldquo;{b.reason}&rdquo;
            </span>
          ))}
          <span className="block mt-1 text-[13px] text-[var(--color-text-muted)]">Merge it into a new revision or withdraw it from the Control Tower open items.</span>
        </div>
      )}

      {/* ALERTS — exception states only. A healthy document renders NOTHING
          here: active holds surface loudly; placing a first hold lives under
          Manage & lifecycle. */}
      {selectedDoc.id && selectedDoc.orgId && uid && activeHoldCount > 0 && (
        <HoldStrip
          documentId={selectedDoc.id}
          orgId={selectedDoc.orgId}
          userId={uid}
          userName={userEmail || undefined}
          userEmail={userEmail || undefined}
          userRole={activeRole || undefined}
          canEdit={canManageAssets || isOwner}
          refreshKey={holdsRefresh}
          onChange={() => setHoldsRefresh((k) => k + 1)}
        />
      )}
      {staleHolderCount > 0 && (
        <p className="border-l-[3px] border-[var(--state-held)] pl-3 text-[14px] text-[var(--color-text)]">
          <b>{staleHolderCount} {staleHolderCount === 1 ? "person may be" : "people may be"} using an old revision.</b>{" "}
          They took an older copy in the last 60 days. See who under Who has a copy below.
        </p>
      )}

      {/* ACTIONS: one main button (Open; Publish once you have it checked
          out), the rest quiet in one row. ──────────────────────────────── */}
      {(() => {
        const canPub = !!(canPublishEff && onRevUp);
        const pubLocked = selectedDoc.status === "Archived" || (isCheckedOut && !checkedOutByMe);
        const publishMain = canPub && checkedOutByMe && !pubLocked;
        const main = `${heroPrimary} disabled:cursor-not-allowed`;
        const quiet = `${heroQuiet} !h-10 disabled:cursor-not-allowed`;
        const publish = (cls: string) => (
          <button onClick={onRevUp} disabled={pubLocked} className={cls}
            title={isCheckedOut && !checkedOutByMe ? `Locked: ${selectedDoc.checkedOutByName || "another user"} has this checked out. Publishing over their work is blocked: coordinate or ask them to check in.` : "Publish a new revision"}>
            {isCheckedOut && !checkedOutByMe ? <><Lock className="w-3.5 h-3.5" /> Locked by {selectedDoc.checkedOutByName || "another user"}</> : <><ArrowUpFromLine className="w-3.5 h-3.5" /> Publish new revision</>}
          </button>
        );
        return (
          <div className="flex flex-wrap items-center gap-2">
            {publishMain ? publish(main) : (
              <button onClick={onFullScreen} disabled={!selectedVersion?.fileUrl} className={main}>
                <Maximize2 className="w-4 h-4" /> Open
              </button>
            )}
            {publishMain && (
              <button onClick={onFullScreen} disabled={!selectedVersion?.fileUrl} className={quiet}><Maximize2 className="w-4 h-4" /> Open</button>
            )}
            <button onClick={() => onCheckout(selectedDoc)} className={quiet}
              title={checkedOutByMe ? "You have it checked out" : isCheckedOut ? `Checked out by ${selectedDoc.checkedOutByName || "someone else"}` : "Check out"}>
              {checkedOutByMe ? <LogOut className="w-4 h-4" /> : <LogIn className="w-4 h-4" />}
              {checkedOutByMe ? "Check in" : isCheckedOut ? "Checked out" : "Check out"}
            </button>
            {(() => {
              const more: MoreItem[] = [];
              if (canPub && !publishMain && !pubLocked) more.push({ icon: <ArrowUpFromLine className="w-4 h-4" />, label: "Publish new revision", onClick: () => onRevUp?.() });
              if (onToggleStage) more.push({ icon: isStaged ? <Check className="w-4 h-4" /> : <Layers className="w-4 h-4" />, label: isStaged ? "Remove from staging" : "Add to staging", onClick: () => onToggleStage(selectedDoc) });
              more.push({ icon: <Pencil className="w-4 h-4" />, label: "Edit metadata", onClick: () => onMetadata() });
              // Source custody: the CAD file from the vault (records an edit intent at this revision).
              if (selectedVersion?.sourceFileKey && selectedDoc.id && selectedDoc.orgId && uid) more.push({ icon: <FileText className="w-4 h-4" />, label: sourceBusy ? "Fetching CAD source…" : "Download CAD source", onClick: () => { if (!sourceBusy) void handleGetSource(); } });
              // Pin this drawing into a job's work package, from where it lives.
              if (selectedDoc.id && selectedDoc.orgId && uid) more.push({ icon: <Package className="w-4 h-4" />, label: "Add to a work package", onClick: () => setPkgAsk((n) => n + 1) });
              return <>
                <MoreMenu items={more} triggerClass={quiet} />
                {selectedDoc.id && selectedDoc.orgId && uid && (
                  <AddToPackageButton doc={selectedDoc} orgId={selectedDoc.orgId} userId={uid} userName={userEmail?.split("@")[0] ?? null} openSignal={pkgAsk} hideTrigger />
                )}
                {/* Follow, and who else is looking */}
                {selectedDoc.id && selectedDoc.orgId && uid && (
                  <>
                    <WatchButton
                      orgId={selectedDoc.orgId}
                      userId={uid}
                      resourceType="document"
                      resourceId={selectedDoc.id}
                      className="!h-10 !px-3.5 !rounded-md !border-[var(--color-border-strong)] !bg-[var(--color-surface)] hover:!bg-[var(--color-surface-2)] !text-[14px] !font-semibold !text-[var(--color-text)]"
                    />
                    <PresenceIndicator
                      resourceType="document"
                      resourceId={selectedDoc.id}
                      userId={uid}
                      userName={userEmail?.split("@")[0]}
                      role={activeRole || undefined}
                    />
                  </>
                )}
              </>;
            })()}
            {isCheckedOut && !checkedOutByMe && <span className="basis-full text-[14px] text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Publishing waits until {selectedDoc.checkedOutByName || "they"} check{selectedDoc.checkedOutByName ? "s" : ""} it in.</span>}
          </div>
        );
      })()}

      {/* PREVIEW ────────────────────────────────────────────────────── */}
      {selectedVersion?.fileUrl ? (
        <div className="relative group rounded-lg overflow-hidden h-[40vh] min-h-72 bg-[var(--color-ink)]">
          <SecureDocViewer
            url={selectedVersion.fileUrl}
            title={title}
            docNumber={selectedDoc.documentNumber || selectedDoc.id || ""}
            rev={selectedDoc.rev || "-"}
            zoomLevel={75}
            watermarkText="PREVIEW"
          />
          {/* Click-catcher overlay — iframe absorbs pointer events otherwise */}
          <button
            type="button"
            onClick={onFullScreen}
            className="absolute inset-0 z-10 bg-black/0 hover:bg-black/10 transition-colors cursor-zoom-in"
            title="Open full size"
            aria-label="Open full size"
          />
        </div>
      ) : (
        <div className="h-40 rounded-lg bg-[var(--color-surface-2)] flex items-center justify-center text-[14px] text-[var(--color-text-muted)]">
          No preview for this file
        </div>
      )}

      {/* SECTIONS: one line each, opened in place. ───────────────────── */}
      <div className="border-t border-[var(--color-border)]">
      {/* RELATIONSHIPS & IMPACT — what this document touches: where-used
          impact, AI readability, curated/automatic relations, equipment. */}
      {selectedDoc.id && selectedDoc.orgId && (
        <PanelSection
          id="relationships"
          title="Equipment and related documents"
          icon={<Tag className="w-4 h-4" />}
          summary={(() => {
            // Cheap synchronous count for the collapsed header — equipment tags
            // come straight from metadata; impact/related counts load on open.
            const tagCount = collectTagGroups(
              selectedDoc.metadata as Record<string, unknown> | null,
              customColumns,
            ).reduce((n, g) => n + g.tags.length, 0);
            return tagCount > 0
              ? <span className="inline-flex items-center gap-1.5">
                  <span className="ui-count">{tagCount}</span> equipment tag{tagCount === 1 ? "" : "s"}
                </span>
              : undefined;
          })()}
        >
      {/* IMPACT — what changing this document touches. */}
      {selectedDoc.id && selectedDoc.orgId && (
        <ImpactPanel documentId={selectedDoc.id} orgId={selectedDoc.orgId} />
      )}

      {/* AI BOUNDARY — whether AI features can read this document, stated
          plainly, with the per-document carve-out for controllers. */}
      {selectedDoc.id && selectedDoc.orgId && selectedDoc.libraryId && (
        <div className="px-4 pt-2">
          <AiBoundaryChip
            documentId={selectedDoc.id}
            libraryId={selectedDoc.libraryId}
            orgId={selectedDoc.orgId}
            canManage={isController}
          />
        </div>
      )}

      {/* RELATED — the document's relationship web: curated pins (documents +
          external links), automatic matches, the graph, and the short link. */}
      {selectedDoc.id && selectedDoc.orgId && (
        <div className="px-4 py-3 border-t border-[var(--color-border)]">
          <RelatedPanel
            documentId={selectedDoc.id}
            orgId={selectedDoc.orgId}
            documentNumber={selectedDoc.documentNumber}
            userId={uid ?? undefined}
            userName={userEmail ?? undefined}
            canManage={["Admin", "DocCtrl", "Manager", "Supervisor"].includes(activeRole ?? "")}
          />
        </div>
      )}

      {/* EQUIPMENT TAGS ─────────────────────────────────────────────
          Quick-glance asset chips. Click any to open the photo popover
          without going through Metadata. Auto-hides if the doc has
          no tag-typed metadata fields. */}
      {selectedDoc?.metadata && orgId && (
        <EquipmentTagsStrip
          metadata={selectedDoc.metadata as Record<string, unknown>}
          customColumns={customColumns}
          orgId={orgId}
          userId={uid || undefined}
          canManage={canManageAssets || isOwner}
          variant="stacked"
        />
      )}

        </PanelSection>
      )}

      {/* DISTRIBUTION & SHARING — one drawer for the whole "who has this
          document" story: share links, transmittals (and their trail),
          read confirmations, and stale-copy recall. */}
      {selectedDoc.id && selectedDoc.orgId && uid && (
        <PanelSection
          id="distribution"
          title="Who has a copy"
          icon={<Users className="w-4 h-4" />}
          summary={(distSummary && (distSummary.issued > 0 || distSummary.ackTotal > 0)) || staleHolderCount > 0
            ? <>
                {staleHolderCount > 0 && (
                  <span className="inline-flex items-center gap-1.5"><span className="ui-count is-warn">{staleHolderCount}</span> on an old rev</span>
                )}
                {distSummary && distSummary.issued > 0 && (
                  <span className="inline-flex items-center gap-1.5"><span className="ui-count">{distSummary.issued}{distSummary.issuedCapped ? "+" : ""}</span> issued</span>
                )}
                {distSummary && distSummary.ackTotal > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`ui-count ${distSummary.ackDone >= distSummary.ackTotal ? "" : "is-warn"}`}>{distSummary.ackDone}/{distSummary.ackTotal}</span> confirmed
                  </span>
                )}
              </>
            : undefined}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setShareOpen(true)}
              title="Send a link: to someone outside the company (no sign-in, controlled) or to someone in this workspace"
              className="inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <ShareIcon className="w-3.5 h-3.5" /> Send
            </button>
            <NextLink
              href={`/transmittals?compose=1&doc=${selectedDoc.id}`}
              title="Issue this document on a transmittal: a cover sheet to someone, with a receipt"
              className="inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <Send className="w-3 h-3" /> Transmit
            </NextLink>
          </div>
          <TransmittalTrail orgId={selectedDoc.orgId} documentId={selectedDoc.id} currentRev={selectedDoc.rev ?? null} />
      {/* DISTRIBUTION CONFIRMATIONS — "8 of 12 confirmed they have Rev 5",
          plus the recipient's own unmissable confirm bar. */}
      {selectedDoc.id && selectedDoc.orgId && uid && (
        <DistributionAcks
          documentId={selectedDoc.id}
          orgId={selectedDoc.orgId}
          libraryId={selectedDoc.libraryId ?? null}
          docLabel={String(selectedDoc.documentNumber || selectedDoc.title || selectedDoc.name || "Document")}
          currentRev={selectedDoc.rev ?? null}
          currentVersionId={selectedDoc.currentVersionId ?? null}
          currentUserId={uid}
          currentUserName={userEmail?.split("@")[0] ?? null}
          isController={isController}
        />
      )}

      {/* DISTRIBUTION — who pulled copies, and are they still current. */}
      {selectedDoc.id && selectedDoc.orgId && uid && (
        <DistributionRecall
          documentId={selectedDoc.id}
          orgId={selectedDoc.orgId}
          libraryId={selectedDoc.libraryId ?? null}
          docLabel={String(selectedDoc.documentNumber || selectedDoc.title || selectedDoc.name || "Document")}
          currentRev={selectedDoc.rev ?? null}
          currentVersionId={selectedDoc.currentVersionId ?? null}
          currentUserId={uid}
          currentUserName={userEmail?.split("@")[0] ?? null}
        />
      )}

        </PanelSection>
      )}

      {/* HISTORY & ACTIVITY — the revision record plus the audit tail. */}
      <PanelSection id="history" title="Revisions and activity" icon={<History className="w-4 h-4" />}>
        {/* The deep views live HERE, nested — not as a duplicate top-level
            button showing the same list through a second door. */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setCompareOpen(true)}
            disabled={!selectedDoc.id}
            title="Overlay any two revisions: grey unchanged, red removed, green added"
            className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <GitCompare className="w-3.5 h-3.5" /> Compare revisions
          </button>
          <button
            onClick={onHistory}
            title="Open the full history drawer"
            className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <History className="w-3.5 h-3.5" /> Full history
          </button>
        </div>
      {/* VERSION HISTORY ────────────────────────────────────────────── */}
      <div className="pt-1">
        <VersionHistoryPanel
          doc={selectedDoc}
          currentUserId={uid ?? undefined}
          currentUserEmail={userEmail ?? undefined}
          userRole={activeRole}
          refreshKey={versionHistoryRefreshKey}
          onOpenVersion={(v) => onOpenVersion?.(v)}
          canRevert={canPublishEff}
          onRevertVersion={onRevertVersion}
        />
      </div>

        {auditState === "loading" ? (
          <SkeletonText lines={3} />
        ) : auditState === "failed" ? (
          <div className="text-[13px] text-[var(--state-overdue)]">Couldn&apos;t load recent activity.</div>
        ) : recentAudits.length === 0 ? (
          <div className="text-[13px] text-[var(--color-text-muted)]">No recent activity.</div>
        ) : (
          <div>
            {recentAudits.map((log, i) => (
              <div key={i} className="flex items-baseline gap-3 py-1.5 border-b border-[var(--color-border)] last:border-b-0 text-[14px]">
                <span className="flex-1 min-w-0 font-semibold text-[var(--color-text)]">{(() => { const t = log.action.replace(/_/g, " ").toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); })()}</span>
                <span className="shrink-0 text-[13px] text-[var(--color-text-muted)]">{log.userEmail?.split('@')[0]}</span>
                <span className="shrink-0 text-[13px] text-[var(--color-text-muted)] tabular-nums">{formatTs(log.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </PanelSection>

      {/* COMPLIANCE & CONTROL — review cycle, read-&-understood, pre-publish
          review, retention/legal hold, and origin, grouped behind ONE header.
          The header's pills keep the at-a-glance status visible while the
          bodies stay tucked away until needed. */}
      {selectedDoc?.id && orgId && (
        <PanelSection
          id="compliance"
          title="Review and sign-off"
          icon={<ClipboardCheck className="w-4 h-4" />}
          summary={
            <>
              <ReviewPill nextReviewDate={selectedDoc.nextReviewDate} compact />
              <RetentionPill retentionUntil={selectedDoc.retentionUntil} dispositionState={selectedDoc.dispositionState} legalHold={selectedDoc.legalHold} compact />
              {selectedDoc.origin === "external" && (
                <OriginBadge origin="external" source={selectedDoc.externalSource} reference={selectedDoc.externalReference} />
              )}
            </>
          }
        >
          <ReviewSection
            doc={selectedDoc}
            orgId={orgId}
            canManage={canPublishEff}
            uid={uid}
            userName={userEmail}
          />
          <AckSection
            doc={selectedDoc}
            orgId={orgId}
            canManage={canPublishEff}
          />
          <ReviewGateSection
            doc={selectedDoc}
            orgId={orgId}
            canManage={canPublishEff}
          />
          <RetentionSection
            doc={selectedDoc}
            orgId={orgId}
            canManage={canManage}
          />
          <OriginSection
            doc={selectedDoc}
            orgId={orgId}
            canManage={canManage}
          />
        </PanelSection>
      )}

      {/* CHECKOUT — status, force release, and the sealed episode record,
          in ONE place instead of three. */}
      {selectedDoc.id && selectedDoc.orgId && (
        <PanelSection
          id="checkout"
          title="Checkout"
          icon={<LogIn className="w-4 h-4" />}
          summary={isCheckedOut
            ? <span className="ui-pill is-warn">
                <Lock className="w-3 h-3" />
                {checkedOutByMe ? "Checked out by you" : `Checked out by ${selectedDoc.checkedOutByName || "someone"}`}
              </span>
            : <span className="ui-pill is-muted">Not checked out</span>}
        >
        <CheckoutStatusCell
          docRecord={selectedDoc}
          currentUserId={uid ?? undefined}
          currentUserEmail={userEmail ?? undefined}
          userRole={activeRole}
          onCheckout={onCheckout}
        />
        {isController && isCheckedOut && onForceUnlock && (
          <button
            onClick={() => onForceUnlock(selectedDoc)}
            className="mt-3 inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)] transition-colors"
          >
            <Shield className="w-3.5 h-3.5" />
            Force release the lock
          </button>
        )}
          <CheckoutHistoryPanel orgId={selectedDoc.orgId} documentId={selectedDoc.id} />
        </PanelSection>
      )}

      {/* HOLDS — placing the FIRST hold. Every hold-authorized role
          (Manager/Supervisor/Engineer/Drafter/controllers/owner) must be able
          to stop work from a document — a safety control, not an admin
          convenience — so this cannot live inside the controller-gated
          Manage drawer. Collapsed: zero chrome on a healthy document. Once a
          hold is active this disappears and the ALERTS zone takes over. */}
      {selectedDoc.id && selectedDoc.orgId && uid && activeHoldCount === 0 && (canManageAssets || isOwner) && (
        <PanelSection id="placehold" title="Holds" icon={<Hand className="w-4 h-4" />}>
          <HoldStrip
            documentId={selectedDoc.id}
            orgId={selectedDoc.orgId}
            userId={uid}
            userName={userEmail || undefined}
            userEmail={userEmail || undefined}
            userRole={activeRole || undefined}
            canEdit
            refreshKey={holdsRefresh}
            onChange={() => setHoldsRefresh((k) => k + 1)}
          />
        </PanelSection>
      )}

      {/* MANAGE & LIFECYCLE — admin/owner actions behind one header. */}
      {canManage && (
        <PanelSection id="manage" title="Manage" icon={<Wrench className="w-4 h-4" />}>
          {/* Unified lifecycle entry-point (Rev-Up, Split, Merge, Renumber, etc.) */}
          {selectedDoc.id && selectedDoc.orgId && selectedDoc.libraryId && uid && (
            <button
              onClick={() => setModifyOpen(true)}
              disabled={selectedDoc.status === "Archived"}
              title="Structural changes beyond a rev-up: split into sheets, merge documents, renumber, correct a label"
              className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors w-full"
            >
              <Wrench className="w-3.5 h-3.5" /> Split, merge or renumber…
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button onClick={onMove} className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ArrowRight className="w-3.5 h-3.5" /> Move
            </button>
            <button onClick={onPermissions} className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <Lock className="w-3.5 h-3.5" /> Permissions
            </button>
          </div>

          {/* Document-class override (controller-only): the per-document
              declaration that drives the MOC gate + check-in routing. */}
          {isController && selectedDoc.id && (
            <DocClassControl
              documentId={selectedDoc.id}
              collectionId={selectedDoc.collectionId ?? null}
              libraryId={selectedDoc.libraryId ?? null}
              fileName={selectedDoc.name ?? null}
            />
          )}
          {/* Lifecycle actions */}
          <div className="grid grid-cols-2 gap-2">
            {onSupersede && (
              <button
                onClick={onSupersede}
                disabled={selectedDoc.status === "Archived" || selectedDoc.status === "Superseded"}
                className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Layers className="w-3.5 h-3.5" /> Supersede
              </button>
            )}
            {onArchive && (
              <button
                onClick={onArchive}
                className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {selectedDoc.status === "Archived"
                  ? <><ArchiveRestore className="w-3.5 h-3.5" /> Restore</>
                  : <><Archive className="w-3.5 h-3.5" /> Archive</>}
              </button>
            )}
          </div>
          {/* Compliance evidence pack — chain-of-custody, one click. */}
          {selectedDoc.id && (
            <button
              onClick={async () => {
                try { await openEvidencePack(selectedDoc.id!, selectedDoc.orgId); }
                catch (e) { await appAlert({ message: friendlyError(e), tone: "danger" }); }
              }}
              title="Put the chain of custody (revisions, holds, audit trail) into a report you can print to PDF"
              className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Shield className="w-3.5 h-3.5" /> Evidence pack
            </button>
          )}
          {/* Danger zone — hard delete is controller-only; owners request. */}
          {/* DESTRUCTIVE ────────────────────────────────────────────────── */}
          {isController && (
            <button
              onClick={onDelete}
              className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors !text-[var(--state-overdue-text)]"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete document
            </button>
          )}
          {/* Owners can't hard-delete (that would break the audit trail) — they
              request it, and Admin/DocCtrl approve by deleting. */}
          {!isController && isOwner && selectedDoc.id && selectedDoc.orgId && (
            <button
              onClick={async () => {
                const reason = await appPrompt({ title: "Request deletion", message: "Admin / Doc Control will review. Why should this document be deleted?", placeholder: "Reason" });
                if (!reason?.trim() || !uid) return;
                try {
                  await requestDeletion({
                    orgId: selectedDoc.orgId!, documentId: selectedDoc.id!,
                    docLabel: selectedDoc.documentNumber || selectedDoc.title || selectedDoc.name || "Document",
                    libraryId: selectedDoc.libraryId, requesterId: uid, requesterName: userEmail, reason: reason.trim(),
                  });
                  await appAlert({ message: "Sent. Admin or Doc Control will review it." });
                } catch (e) { await appAlert({ message: friendlyError(e), tone: "danger" }); }
              }}
              className="inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors !text-[var(--state-overdue-text)]"
            >
              <Trash2 className="w-3.5 h-3.5" /> Request deletion
            </button>
          )}
        </PanelSection>
      )}

      {/* FILE DETAILS ───────────────────────────────────────────────── */}
      <PanelSection id="filedetails" title="File details" icon={<FileText className="w-4 h-4" />}
        summary={ext ? <span className="ui-tag !h-6">.{ext}</span> : undefined}>
        <div className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[14px]">
          <div className="text-[var(--color-text-muted)]">Type</div>
          <div className="text-[var(--color-text)] truncate" title={fileType}>{ext ? `.${ext}` : fileType}</div>

          <div className="text-[var(--color-text-muted)]">Size</div>
          <div className="text-[var(--color-text)] tabular-nums">{formatBytes(sizeBytes)}</div>

          <div className="text-[var(--color-text-muted)] flex items-center gap-1"><Calendar className="w-3 h-3" /> Created</div>
          <div className="text-[var(--color-text)]">{formatTs(selectedDoc.createdAt)}</div>

          <div className="text-[var(--color-text-muted)] flex items-center gap-1"><Calendar className="w-3 h-3" /> Modified</div>
          <div className="text-[var(--color-text)]">{formatTs(selectedDoc.updatedAt)}</div>

          {selectedVersion?.createdByName && (
            <>
              <div className="text-[var(--color-text-muted)] flex items-center gap-1"><User className="w-3 h-3" /> By</div>
              <div className="text-[var(--color-text)] truncate">{selectedVersion.createdByName}</div>
            </>
          )}
        </div>
      </PanelSection>

      {/* QUICK NOTES — drop ad-hoc context anywhere (collapsed by default) */}
      {selectedDoc.id && selectedDoc.orgId && uid && (
        <PanelSection id="quicknote" title="Quick note" icon={<StickyNote className="w-4 h-4" />}>
          <QuickNoteComposer
            orgId={selectedDoc.orgId}
            userId={uid}
            userEmail={userEmail || undefined}
            userName={userEmail?.split("@")[0]}
            scope={{ documentId: selectedDoc.id }}
          />
        </PanelSection>
      )}

      </div>

      {modifyOpen && selectedDoc.id && selectedDoc.orgId && selectedDoc.libraryId && uid && (
        <ModifyDocumentRouter
          isOpen
          onClose={() => setModifyOpen(false)}
          doc={selectedDoc}
          libraryId={selectedDoc.libraryId}
          orgId={selectedDoc.orgId}
          actorUserId={uid}
          actorUserName={userEmail ?? undefined}
          actorEmail={userEmail ?? undefined}
          actorRole={activeRole ?? undefined}
          onSuccess={() => { setModifyOpen(false); /* parent refreshes via realtime channel */ }}
        />
      )}

      {compareOpen && selectedDoc.id && (
        <CompareRevisionsModal
          isOpen
          onClose={() => setCompareOpen(false)}
          doc={selectedDoc}
        />
      )}

      {shareOpen && selectedDoc.id && selectedDoc.orgId && uid && (
        <SendSheet
          orgId={selectedDoc.orgId}
          docs={[{
            id: selectedDoc.id,
            documentNumber: selectedDoc.documentNumber || null,
            title: selectedDoc.title || selectedDoc.name || null,
            rev: selectedDoc.rev ?? null,
            libraryId: selectedDoc.libraryId ?? "",
          }]}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}


// ─── Transmittal trail ────────────────────────────────────────────────────
// "Which transmittals carried this document?" — the impact question nobody
// could answer from the document side. Renders nothing when the doc was
// never transmitted; flags recipients now holding a superseded rev.
function TransmittalTrail({ orgId, documentId, currentRev }: { orgId: string; documentId: string; currentRev: string | null }) {
  const [rows, setRows] = React.useState<Array<{ id: string; number: string; rev: string | null; purpose: string | null; status: string; recipient: string; issuedAt: string | null }>>([]);
  const [state, setState] = React.useState<"loading" | "ready" | "failed">("loading");
  React.useEffect(() => {
    let alive = true;
    setState("loading");
    (async () => {
      const { listTransmittalsForDocument } = await import("@/lib/transmittals");
      const list = await listTransmittalsForDocument(orgId, documentId);
      if (!alive) return;
      setState("ready");
      setRows(list
        .filter((t) => t.status === "issued" || t.status === "acknowledged")
        .map((t) => ({
          id: t.id,
          number: t.number,
          rev: t.items.find((i) => i.documentId === documentId)?.rev ?? null,
          purpose: t.purpose ?? null,
          status: t.status,
          recipient: t.recipientCompany || t.recipientName || "-",
          issuedAt: t.issuedAt ?? null,
        })));
    })().catch(() => { if (alive) setState("failed"); });
    return () => { alive = false; };
  }, [orgId, documentId]);

  if (state === "loading") return <p className="mt-3 text-[13px] text-[var(--color-text-muted)]">Checking transmittals…</p>;
  if (state === "failed") return <p className="mt-3 text-[13px] text-[var(--state-overdue)]">Couldn&apos;t load the transmittals for this document.</p>;
  // Never transmitted: nothing to show.
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-[var(--color-border)] px-3 py-2.5">
      <div className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5">Transmitted on</div>
      <ul className="space-y-1">
        {rows.map((r) => {
          const stale = !!(r.rev && currentRev && r.rev !== currentRev);
          return (
            <li key={r.id} className="flex items-center gap-2 text-[13px] flex-wrap">
              <NextLink href={`/transmittals?t=${r.id}`} className="ui-id text-[15px]">{r.number}</NextLink>
              <span className="text-[var(--color-text-muted)]">
                Rev {r.rev ?? "-"} · {r.purpose ?? "-"} · to {r.recipient}
                {r.issuedAt ? ` · ${humanDate(r.issuedAt)}` : ""}
              </span>
              {r.status === "acknowledged"
                ? <span className="ui-pill is-good">Received</span>
                : <span className="ui-pill is-warn">Not confirmed yet</span>}
              {stale && (
                <span className="ui-pill is-bad" title={`They have Rev ${r.rev}. Current is Rev ${currentRev}.`}>
                  Has an old rev
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}


// ─── One line per section ────────────────────────────────────────────────
// A plain row (name, what's in it, ›) that opens in place. Remembers whether
// it was left open, per section, like the rest of the inspector did.
function PanelSection({ id, title, summary, defaultOpen = false, children }: {
  id: string;
  title: string;
  /** Kept for callers; headings are text now, so it isn't drawn. */
  icon?: React.ReactNode;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const storageKey = `mfg.inspector.sec.${id}`;
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const v = localStorage.getItem(storageKey);
        if (alive && v !== null) setOpen(v === "1");
      } catch { /* private mode: keep the default */ }
    })();
    return () => { alive = false; };
  }, [storageKey]);
  const toggle = () => setOpen((o) => {
    const next = !o;
    try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* ignore */ }
    return next;
  });
  return (
    <section className="border-b border-[var(--color-border)] last:border-b-0">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="w-full min-h-12 py-2 flex items-center gap-3 text-left group">
        {/* Headings are text: the icon names the section for screen readers only. */}
        <span className="flex-1 min-w-0 text-[16px] font-semibold text-[var(--color-heading)] group-hover:underline underline-offset-4 decoration-[var(--color-border-strong)]">{title}</span>
        {summary && <span className="flex items-center gap-1.5 flex-wrap justify-end min-w-0 text-[13px] text-[var(--color-text-muted)]">{summary}</span>}
        <ChevronRight aria-hidden className={`ui-chevron w-4 h-4 shrink-0 text-[var(--color-text-muted)] ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="pb-5 space-y-3">{children}</div>}
    </section>
  );
}
