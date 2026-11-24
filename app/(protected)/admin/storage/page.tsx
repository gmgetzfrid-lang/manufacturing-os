"use client";

// /admin/storage: storage, use and backup in one place.
//
// One place to answer the only questions that matter for cost:
//   • How full are we, and is it time to act?            (health watermark)
//   • What is safe to purge vs. what must we keep?        (category breakdown)
//   • Why is a table flagged?                             (hover any flag)
//   • Free up space now                                   (guarded purge)
//   • Get a real backup out (records + binaries)          (JSON / full ZIP)
//
// Stats are read-only and deployment-wide. Purge is destructive and scoped to
// your workspace. Backup folds in the data-export download actions so this is
// a single section, not two.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, RefreshCw, Loader2, Copy, Trash2, FileJson, FileArchive,
  Archive, Lock, CheckCircle2, FolderArchive, X,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { CATEGORY_LABEL, type DataClass } from "@/lib/storageClassify";
import { appConfirm } from "@/components/providers/DialogProvider";
import FileThumb from "@/components/ui/FileThumb";
import { tryUpload } from "@/lib/uploadRetry";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroQuiet } from "@/components/ui/PageHero";
import { fieldBox, field, label, btnQuiet, btnRow, btnDanger, btnLink, btnIcon, link, sheet, tbl, FormRow, Section, StatusTag, Problem, shortDate, shortDateTime, toneText, type Tone } from "@/components/admin/kit";
import { bandSelect, plural } from "@/components/admin/band";
import { said, responseError } from "@/components/admin/said";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { CopyId } from "@/components/ui/CopyId";
import MoreMenu from "@/components/ui/MoreMenu";
import HelpTooltip from "@/components/ui/HelpTooltip";
import Disclosure from "@/components/admin/Disclosure";

interface TableRow {
  name: string; rows: number; bytes: number;
  category: DataClass; reason: string; grower: boolean;
}
interface Stats {
  generatedAt: string;
  db: { totalBytes: number; tables: TableRow[]; byCategory: Record<DataClass, number> };
  r2Estimate: { totalBytes: number; versionsBytes: number; photosBytes: number; versionCount: number; photoCount: number };
  /** REAL bucket walk — actual object sizes, not row-recorded estimates. */
  r2Real: {
    bytes: number; objects: number; truncated: boolean; pct: number; band: "ok" | "warn" | "crit";
    segments?: Array<{ label: string; bytes: number; objects: number; newest: string | null }>;
    newest?: string | null;
  } | null;
  /** Why the bucket walk failed, when it did — the estimate that replaces it
   *  can't see knowledge PDFs at all, so this must never be silent. */
  r2Error?: string | null;
  freeTier?: {
    r2LimitBytes: number; dbLimitBytes: number; dbPct: number; dbBand: "ok" | "warn" | "crit";
    source?: "settings" | "env" | "default";
  };
  dedup: { totalVersions: number; totalBytes: number; distinctHashes: number; dupGroups: number; reclaimableBytes: number } | null;
  ai: { last24h: number; last30d: number } | null;
  note: string;
}
interface PurgePreview {
  cutoffDays: number;
  targets: Array<{ table: string; label: string; reason: string; rows: number; estBytes: number }>;
  totalRows: number;
  totalEstBytes: number;
  note: string;
}
interface CatalogArchive {
  archiveId: string; kind: string; fileCount: number; totalBytes: number;
  note: string; createdAt: string | null; createdByEmail: string | null;
  docPending: number; docCommitted: number; ticketPending: number; ticketCommitted: number;
  status: "full" | "producing" | "pending" | "committed" | "empty";
}

// Soft budget used to drive the watermark. This is a GUIDELINE default, not a
// hard hosting limit — change it to match your plan's storage allowance. The
// point is to nudge a backup + purge before you ever get close.
const SOFT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

function fmtBytes(n: number): string {
  if (!n || n < 1) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtNum(n: number): string {
  return n >= 1000 ? n.toLocaleString() : String(n);
}
// Compose "<root>/<sub>/" honoring the root's separator style (UNC vs POSIX).
function subfolder(root: string, sub: string): string {
  const base = root.trim().replace(/[/\\]+$/, "");
  const sep = base.includes("\\") ? "\\" : "/";
  return base ? `${base}${sep}${sub}${sep}` : `${sub}${sep}`;
}

const CATEGORY_BLURB: Record<DataClass, string> = {
  purge: "Byproducts. Safe to delete once old. No records are lost.",
  archive: "Real records. Never deleted. Kept live, then archived offline when old.",
  reference: "Small settings and lookup data. Kept live. Not a cost concern.",
};

/** A failed route's error: its own words when it sent some, else its
 *  status (said() turns that into plain words). */
function httpError(status: number, words?: unknown): Error {
  return typeof words === "string" && words ? new Error(words) : Object.assign(new Error("It didn't go through."), { status });
}

export default function StorageBackupPage() {
  const { activeOrgId, activeRole } = useRole();
  const canPurge = activeRole === "Admin" || activeRole === "DocCtrl";

  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Purge state
  const [purgeDays, setPurgeDays] = useState(90);
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [purging, setPurging] = useState(false);

  // Space-saver shed (archive older revision history off R2; keep last N hot)
  const [shedKeep, setShedKeep] = useState(5);
  const [shedPreview, setShedPreview] = useState<{ selectedCount: number; reclaimableBytes: number; eligibleCount: number; remainingCount?: number } | null>(null);
  const [shedBusy, setShedBusy] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<{ orgId: string; archiveId: string; files: string; bytes: number } | null>(null);
  const [committing, setCommitting] = useState(false);

  // Closed-ticket space-saver (archive whole closed tickets; keep a stub in the list)
  const [ticketDays, setTicketDays] = useState(90);
  const [ticketPreview, setTicketPreview] = useState<{ selectedCount: number; reclaimableBytes: number; eligibleCount: number } | null>(null);
  const [ticketBusy, setTicketBusy] = useState(false);
  const [pendingTicketArchive, setPendingTicketArchive] = useState<{ orgId: string; archiveId: string; tickets: string; files: string; bytes: number } | null>(null);
  const [ticketCommitting, setTicketCommitting] = useState(false);
  const [ticketRestoreBusy, setTicketRestoreBusy] = useState(false);
  const [ticketRestoreMsg, setTicketRestoreMsg] = useState<{ text: string; warn: boolean } | null>(null);
  const [ticketRestoreFile, setTicketRestoreFile] = useState<File | null>(null);
  // Reads that feed a panel. A failed one says so in its panel instead of
  // looking like "nothing to do".
  const [readErrors, setReadErrors] = useState<Partial<Record<"purge" | "shed" | "ticket" | "catalog" | "settings", unknown>>>({});
  const noteRead = useCallback((k: "purge" | "shed" | "ticket" | "catalog" | "settings", err: unknown) => {
    setReadErrors((prev) => {
      if (err == null && prev[k] == null) return prev;
      const next = { ...prev };
      if (err != null) next[k] = err; else delete next[k];
      return next;
    });
  }, []);

  // Offline archive catalog — every archive ever produced, with live commit
  // state. This is the recovery view: a produce whose tab was closed before
  // "I saved it" would otherwise be stranded invisibly (space never freed).
  const [catalog, setCatalog] = useState<CatalogArchive[] | null>(null);
  const [catalogBusyId, setCatalogBusyId] = useState<string | null>(null);
  const [catalogMsg, setCatalogMsg] = useState<{ text: string; warn: boolean } | null>(null);
  const [copiedArchiveId, setCopiedArchiveId] = useState<string | null>(null);

  // Backup state
  const [busyJson, setBusyJson] = useState(false);
  const [busyZip, setBusyZip] = useState(false);
  const [lastArchiveId, setLastArchiveId] = useState<string | null>(null);

  // Designated archive location (where the org keeps its offline backups) +
  // an optional free-text finder note appended to every archived-file prompt
  // (e.g. "ask IT for access to the DC-3 share").
  const [archiveRoot, setArchiveRoot] = useState<string | null>(null);
  const [finderNote, setFinderNote] = useState<string | null>(null);
  const [editingLoc, setEditingLoc] = useState(false);
  const [locDraft, setLocDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [savingLoc, setSavingLoc] = useState(false);

  // Real storage quota (drives the watermark + cron admin alerts)
  const [quotaBytes, setQuotaBytes] = useState<number | null>(null);
  const [editingQuota, setEditingQuota] = useState(false);
  const [quotaDraft, setQuotaDraft] = useState("");
  const [savingQuota, setSavingQuota] = useState(false);

  // Hosting-plan ceilings (platform_settings) — editable so a plan upgrade
  // is a 5-second change here, no redeploy.
  const [editingLimits, setEditingLimits] = useState(false);
  const [r2LimitDraft, setR2LimitDraft] = useState("");   // GB
  const [dbLimitDraft, setDbLimitDraft] = useState("");   // MB
  const [savingLimits, setSavingLimits] = useState(false);

  // Orphaned-file sweeper
  const [orphanScan, setOrphanScan] = useState<{
    orphans: Array<{ key: string; size: number; lastModified: string | null }>;
    orphanBytes: number; totalObjects: number; referencedKeys: number;
    skippedYoung: number; truncated: boolean;
  } | null>(null);
  const [orphanBusy, setOrphanBusy] = useState<"scan" | "delete" | null>(null);
  const [orphanMsg, setOrphanMsg] = useState<{ text: string; warn: boolean } | null>(null);

  const authToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }, []);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/storage-stats?orgId=${encodeURIComponent(activeOrgId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      setStats(body as Stats);
    } catch (e) {
      setError(said(e, "Couldn't measure storage."));
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, authToken]);

  const loadPreview = useCallback(async (days: number) => {
    if (!activeOrgId || !canPurge) return;
    setPreviewLoading(true);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/purge?orgId=${encodeURIComponent(activeOrgId)}&days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      setPreview(body as PurgePreview);
      noteRead("purge", null);
    } catch (e) { noteRead("purge", e); }
    finally { setPreviewLoading(false); }
  }, [activeOrgId, canPurge, authToken, noteRead]);

  const loadArchiveSettings = useCallback(async () => {
    if (!activeOrgId || !canPurge) return;
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/archive-settings?orgId=${encodeURIComponent(activeOrgId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      if (body?.settings) {
        setArchiveRoot(body.settings.location_hint || null);
        setLocDraft(body.settings.location_hint || "");
        setFinderNote(body.settings.naming || null);
        setNoteDraft(body.settings.naming || "");
        setQuotaBytes(body.settings.quota_bytes ?? null);
        setQuotaDraft(body.settings.quota_bytes ? String(Math.round((body.settings.quota_bytes / (1024 ** 3)) * 10) / 10) : "");
      }
      noteRead("settings", null);
    } catch (e) { noteRead("settings", e); }
  }, [activeOrgId, canPurge, authToken, noteRead]);

  const loadShedPreview = useCallback(async (keep: number) => {
    if (!activeOrgId || !canPurge) return;
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/shed?orgId=${encodeURIComponent(activeOrgId)}&keep=${keep}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      setShedPreview(body);
      noteRead("shed", null);
    } catch (e) { noteRead("shed", e); }
  }, [activeOrgId, canPurge, authToken, noteRead]);

  const loadTicketShedPreview = useCallback(async (days: number) => {
    if (!activeOrgId || !canPurge) return;
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/ticket-shed?orgId=${encodeURIComponent(activeOrgId)}&days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      setTicketPreview(body);
      noteRead("ticket", null);
    } catch (e) { noteRead("ticket", e); }
  }, [activeOrgId, canPurge, authToken, noteRead]);

  const loadCatalog = useCallback(async () => {
    if (!activeOrgId || !canPurge) return;
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/archives?orgId=${encodeURIComponent(activeOrgId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      if (Array.isArray(body?.archives)) setCatalog(body.archives as CatalogArchive[]);
      noteRead("catalog", null);
    } catch (e) { noteRead("catalog", e); }
  }, [activeOrgId, canPurge, authToken, noteRead]);

  useEffect(() => { void load(); }, [load]);
  // Uploads happen on OTHER pages (and usually other tabs). Without this the
  // page keeps showing the measurement it took on first mount, so a number
  // that is merely stale looks exactly like a number that is wrong — which is
  // precisely how "I uploaded a lot and it didn't move" happens.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  useEffect(() => { void loadPreview(purgeDays); }, [loadPreview, purgeDays]);
  useEffect(() => { void loadArchiveSettings(); }, [loadArchiveSettings]);
  useEffect(() => { void loadShedPreview(shedKeep); }, [loadShedPreview, shedKeep]);
  useEffect(() => { void loadTicketShedPreview(ticketDays); }, [loadTicketShedPreview, ticketDays]);
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  // Pending archives are workspace-specific and live only in component state —
  // clear them when the active workspace changes so a Step-2 card can never be
  // committed against the wrong org.
  useEffect(() => { setPendingArchive(null); setPendingTicketArchive(null); setTicketRestoreMsg(null); setCatalog(null); setCatalogMsg(null); }, [activeOrgId]);

  const saveArchiveLoc = async () => {
    if (!activeOrgId) return;
    setSavingLoc(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/archive-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, locationHint: locDraft, naming: noteDraft }),
      });
      if (!res.ok) throw await responseError(res);
      setArchiveRoot(locDraft.trim() || null);
      setFinderNote(noteDraft.trim() || null);
      setEditingLoc(false);
    } catch (e) {
      setError(said(e, "Couldn't save the archive folder."));
    } finally {
      setSavingLoc(false);
    }
  };

  const saveQuota = async () => {
    if (!activeOrgId) return;
    setSavingQuota(true); setError(null);
    try {
      const token = await authToken();
      const gb = Number(quotaDraft);
      const bytes = Number.isFinite(gb) && gb > 0 ? Math.round(gb * 1024 ** 3) : null;
      const res = await fetch(`/api/admin/archive-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, quotaBytes: bytes }),
      });
      if (!res.ok) throw await responseError(res);
      setQuotaBytes(bytes);
      setEditingQuota(false);
    } catch (e) {
      setError(said(e, "Couldn't save the limit."));
    } finally {
      setSavingQuota(false);
    }
  };

  // Hosting-plan ceilings: R2 in GB, DB in MB → platform_settings.
  const saveLimits = async () => {
    if (!activeOrgId) return;
    const r2Gb = Number(r2LimitDraft);
    const dbMb = Number(dbLimitDraft);
    if (!(r2Gb > 0) || !(dbMb > 0)) { setError("Enter both limits: files (R2) in GB, database in MB."); return; }
    setSavingLimits(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/storage-stats`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          orgId: activeOrgId,
          r2LimitBytes: Math.round(r2Gb * 1024 ** 3),
          dbLimitBytes: Math.round(dbMb * 1024 ** 2),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      setEditingLimits(false);
      await load();
    } catch (e) {
      setError(said(e, "Couldn't save the plan limits."));
    } finally { setSavingLimits(false); }
  };

  // Orphaned files: scan (read-only) then confirmed reclaim.
  const scanOrphanFiles = async () => {
    if (!activeOrgId) return;
    setOrphanBusy("scan"); setOrphanMsg(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/orphans?orgId=${encodeURIComponent(activeOrgId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      setOrphanScan(body);
    } catch (e) {
      setOrphanMsg({ text: said(e, "Couldn't scan for orphaned files."), warn: true });
    } finally { setOrphanBusy(null); }
  };

  const purgeOrphanFiles = async () => {
    if (!activeOrgId || !orphanScan || orphanScan.orphans.length === 0) return;
    const ok = await appConfirm({
      title: "Delete orphaned files?",
      message:
        `Permanently delete ${fmtNum(orphanScan.orphans.length)} file(s) (≈${fmtBytes(orphanScan.orphanBytes)}) that nothing in the ` +
        "database uses, like old knowledge uploads you deleted. The server checks each file again before deleting, and " +
        "files newer than 7 days are never touched. This cannot be undone.",
      tone: "danger",
      confirmLabel: "Delete orphans",
    });
    if (!ok) return;
    setOrphanBusy("delete"); setOrphanMsg(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/orphans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, confirm: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      setOrphanMsg({
        text: `Freed ${fmtBytes(body.freedBytes ?? 0)}: ${fmtNum(body.deleted ?? 0)} orphaned file(s) deleted.`,
        warn: (body.errors?.length ?? 0) > 0,
      });
      setOrphanScan(null);
      await load();
    } catch (e) {
      setOrphanMsg({ text: said(e, "Couldn't delete the orphaned files."), warn: true });
    } finally { setOrphanBusy(null); }
  };

  const runPurge = async () => {
    if (!activeOrgId || !preview || preview.totalRows === 0) return;
    const ok = await appConfirm({
      title: "Free up space",
      message: `Permanently delete ${fmtNum(preview.totalRows)} disposable row(s) older than ${preview.cutoffDays} days (≈${fmtBytes(preview.totalEstBytes)})? Records are never touched. This cannot be undone.`,
      tone: "danger",
      confirmLabel: "Purge now",
    });
    if (!ok) return;
    setPurging(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/purge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, days: purgeDays, confirm: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      await Promise.all([load(), loadPreview(purgeDays)]);
    } catch (e) {
      setError(said(e, "Couldn't free up space."));
    } finally {
      setPurging(false);
    }
  };

  const produceArchive = async () => {
    if (!activeOrgId || !shedPreview || shedPreview.selectedCount === 0) return;
    const ok = await appConfirm({
      title: "Archive superseded revisions",
      message: `Bundle ${fmtNum(shedPreview.selectedCount)} superseded revision file(s) (≈${fmtBytes(shedPreview.reclaimableBytes)}) into one offline archive zip? Nothing is deleted yet. You confirm the reclaim after saving it.`,
      confirmLabel: "Build & download",
    });
    if (!ok) return;
    setShedBusy(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/shed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, keep: shedKeep, confirm: true }),
      });
      if (!res.ok) throw await responseError(res);
      const archiveId = res.headers.get("X-Archive-Id") || "";
      const files = res.headers.get("X-Archive-Files") || "0";
      const bytes = Number(res.headers.get("X-Archive-Bytes") || "0");
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href; a.download = archiveId ? `${archiveId}.zip` : `space-archive.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(href);
      if (archiveId) setPendingArchive({ orgId: activeOrgId, archiveId, files, bytes });
      void loadCatalog();
    } catch (e) {
      setError(said(e, "Couldn't build the archive."));
    } finally {
      setShedBusy(false);
    }
  };

  const commitArchive = async () => {
    if (!activeOrgId || !pendingArchive) return;
    if (pendingArchive.orgId !== activeOrgId) {
      setError("This pending archive was produced for a different workspace. Switch back to it to reclaim, or discard it.");
      return;
    }
    const ok = await appConfirm({
      title: "Reclaim space",
      message: `Permanently delete ${pendingArchive.files} binary file(s) from live storage now that ${pendingArchive.archiveId}.zip is saved offline? Frees ≈${fmtBytes(pendingArchive.bytes)}. Those revisions will then need the archive to view. This cannot be undone.`,
      tone: "danger",
      confirmLabel: "Reclaim space",
    });
    if (!ok) return;
    setCommitting(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/shed/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, archiveId: pendingArchive.archiveId, confirm: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      setPendingArchive(null);
      // Delete-shortfall honesty: stamped-but-not-deleted objects keep billing.
      const reclaimed = Number(body?.reclaimed ?? 0);
      const keysDeleted = Number(body?.keysDeleted ?? reclaimed);
      if (keysDeleted < reclaimed || (Array.isArray(body?.errors) && body.errors.length > 0)) {
        setCatalogMsg({
          warn: true,
          text: `${pendingArchive.archiveId}: ${fmtNum(reclaimed)} revision(s) marked archived, but ${fmtNum(Math.max(0, reclaimed - keysDeleted))} cloud object(s) didn't delete and are still billed. Run Reclaim on it again from the catalog below. Running it again is safe.`,
        });
      }
      await Promise.all([load(), loadShedPreview(shedKeep), loadCatalog()]);
    } catch (e) {
      setError(said(e, "Couldn't reclaim the space."));
    } finally {
      setCommitting(false);
    }
  };

  const produceTicketArchive = async () => {
    if (!activeOrgId || !ticketPreview || ticketPreview.selectedCount === 0) return;
    const ok = await appConfirm({
      title: "Archive closed tickets",
      message: `Bundle ${fmtNum(ticketPreview.selectedCount)} closed ticket(s) with their comments, history and attachments (≈${fmtBytes(ticketPreview.reclaimableBytes)}) into one offline archive zip? Each leaves a small stub in the list. Nothing is deleted yet. You confirm the reclaim after saving it.`,
      confirmLabel: "Build & download",
    });
    if (!ok) return;
    setTicketBusy(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/ticket-shed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, days: ticketDays, confirm: true }),
      });
      if (!res.ok) throw await responseError(res);
      const archiveId = res.headers.get("X-Archive-Id") || "";
      const tickets = res.headers.get("X-Archive-Tickets") || "0";
      const files = res.headers.get("X-Archive-Files") || "0";
      const bytes = Number(res.headers.get("X-Archive-Bytes") || "0");
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href; a.download = archiveId ? `${archiveId}.zip` : `ticket-archive.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(href);
      if (archiveId) setPendingTicketArchive({ orgId: activeOrgId, archiveId, tickets, files, bytes });
      void loadCatalog();
    } catch (e) {
      setError(said(e, "Couldn't build the ticket archive."));
    } finally {
      setTicketBusy(false);
    }
  };

  const commitTicketArchive = async () => {
    if (!activeOrgId || !pendingTicketArchive) return;
    if (pendingTicketArchive.orgId !== activeOrgId) {
      setError("This pending archive was produced for a different workspace. Switch back to it to reclaim, or discard it.");
      return;
    }
    const ok = await appConfirm({
      title: "Reclaim space",
      message: `Permanently move ${pendingTicketArchive.tickets} closed ticket(s) to the archive now that ${pendingTicketArchive.archiveId}.zip is saved offline? Their comments, history and ${pendingTicketArchive.files} attachment file(s) leave live storage (≈${fmtBytes(pendingTicketArchive.bytes)} freed); a stub stays in the list. Viewing them then needs the archive. This cannot be undone.`,
      tone: "danger",
      confirmLabel: "Reclaim space",
    });
    if (!ok) return;
    setTicketCommitting(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/ticket-shed/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, archiveId: pendingTicketArchive.archiveId, confirm: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      setPendingTicketArchive(null);
      await Promise.all([load(), loadTicketShedPreview(ticketDays), loadCatalog()]);
    } catch (e) {
      setError(said(e, "Couldn't reclaim the space."));
    } finally {
      setTicketCommitting(false);
    }
  };

  // Abandon a produced-but-not-committed archive: unlinks its rows server-side so
  // they become eligible again, instead of being stranded with archive_id set.
  const cancelPending = async (archiveId: string, which: "doc" | "ticket") => {
    if (!activeOrgId) return;
    const ok = await appConfirm({
      title: "Discard pending archive",
      message: `Discard ${archiveId}? The ${which === "ticket" ? "ticket(s)" : "revision(s)"} it bundled stay live and can be archived again later. The ${archiveId}.zip you downloaded won't be used, so delete it. Nothing in live storage is removed.`,
      confirmLabel: "Discard",
    });
    if (!ok) return;
    const setBusy = which === "ticket" ? setTicketCommitting : setCommitting;
    setBusy(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/archive-cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, archiveId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      if (which === "ticket") setPendingTicketArchive(null); else setPendingArchive(null);
      await Promise.all([load(), which === "ticket" ? loadTicketShedPreview(ticketDays) : loadShedPreview(shedKeep), loadCatalog()]);
    } catch (e) {
      setError(said(e, "Couldn't discard the archive."));
    } finally {
      setBusy(false);
    }
  };

  // Reclaim straight from the catalog — the recovery path for a produce whose
  // tab closed before "I saved it". Routes to the right commit endpoint by
  // which table holds the pending rows, and reports delete shortfalls honestly.
  const commitFromCatalog = async (row: CatalogArchive) => {
    if (!activeOrgId) return;
    const which = row.docPending > 0 ? "doc" : "ticket";
    const what = which === "doc"
      ? `${fmtNum(row.docPending)} superseded revision file(s)`
      : `${fmtNum(row.ticketPending)} closed ticket(s)`;
    const ok = await appConfirm({
      title: "Reclaim space",
      message: `Permanently remove ${what} from live storage now that ${row.archiveId}.zip is saved offline (≈${fmtBytes(row.totalBytes)})? Only do this if you saved the zip when it was made. It becomes the only copy. This cannot be undone.`,
      tone: "danger",
      confirmLabel: "I saved it, reclaim",
    });
    if (!ok) return;
    setCatalogBusyId(row.archiveId); setError(null); setCatalogMsg(null);
    try {
      const token = await authToken();
      const endpoint = which === "doc" ? "/api/admin/shed/commit" : "/api/admin/ticket-shed/commit";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, archiveId: row.archiveId, confirm: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      const reclaimed = Number(body?.reclaimed ?? 0);
      const keysDeleted = Number(body?.keysDeleted ?? reclaimed);
      const errCount = Array.isArray(body?.errors) ? body.errors.length : 0;
      if (which === "doc" && (keysDeleted < reclaimed || errCount > 0)) {
        setCatalogMsg({
          warn: true,
          text: `${row.archiveId}: ${fmtNum(reclaimed)} revision(s) marked archived, but ${fmtNum(Math.max(0, reclaimed - keysDeleted))} cloud object(s) didn't delete and are still billed. Run Reclaim on it again. Running it again is safe.`,
        });
      } else {
        setCatalogMsg({ warn: false, text: `${row.archiveId}: space reclaimed.` });
      }
      await Promise.all([load(), loadShedPreview(shedKeep), loadTicketShedPreview(ticketDays), loadCatalog()]);
    } catch (e) {
      setError(said(e, "Couldn't reclaim the space."));
    } finally {
      setCatalogBusyId(null);
    }
  };

  const copyArchivePath = async (row: CatalogArchive) => {
    const sub = row.kind === "full" ? "full-backups" : "data";
    const path = archiveRoot ? `${subfolder(archiveRoot, sub)}${row.archiveId}.zip` : `${sub}/${row.archiveId}.zip`;
    try {
      await navigator.clipboard.writeText(path);
      setCopiedArchiveId(row.archiveId);
      setTimeout(() => setCopiedArchiveId((c) => (c === row.archiveId ? null : c)), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const restoreTicketsFromArchive = async (file: File) => {
    if (!activeOrgId || !file) return;
    const orgId = activeOrgId;
    setTicketRestoreBusy(true); setError(null); setTicketRestoreMsg(null); setTicketRestoreFile(file);
    // The upload and the restore are one step. Safe to repeat: tickets
    // already restored come back as "not an archived stub" and are skipped.
    const send = async () => {
      const token = await authToken();
      const res = await fetch(`/api/admin/ticket-shed/restore?orgId=${encodeURIComponent(orgId)}&confirm=true`, {
        method: "POST",
        headers: { "Content-Type": "application/zip", Authorization: `Bearer ${token}` },
        body: file,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body?.error);
      return body as unknown;
    };
    const report = (body: unknown) => {
      const r = (body ?? {}) as {
        restored?: number; partial?: number; filesUploaded?: number; filesMissing?: number;
        skippedForeign?: number; skippedForeignKey?: number; notArchived?: number;
      };
      const restored = r.restored || 0;
      const parts = [`Restored ${fmtNum(restored)} ticket(s)`];
      if (r.filesUploaded) parts.push(`${fmtNum(r.filesUploaded)} file(s) re-uploaded`);
      if (r.partial) parts.push(`${r.partial} left as stub (attachments missing from zip)`);
      if (r.skippedForeign) parts.push(`${r.skippedForeign} from another workspace (skipped)`);
      if (r.notArchived) parts.push(`${r.notArchived} not an archived stub (skipped)`);
      if (r.skippedForeignKey) parts.push(`${r.skippedForeignKey} foreign file key(s) ignored`);
      const warn = restored === 0 && ((r.partial || 0) + (r.skippedForeign || 0) + (r.notArchived || 0) + (r.filesMissing || 0)) > 0;
      setTicketRestoreMsg({
        text: parts.join(" · ") + "." + (warn ? " It matched 0 tickets in this workspace. Check it's this workspace's archive." : ""),
        warn,
      });
      setTicketRestoreFile(null);
      void Promise.all([load(), loadTicketShedPreview(ticketDays)]);
    };
    try {
      report(await tryUpload(file.name, send, { onRetried: report }));
    } catch (e) {
      setTicketRestoreMsg({ text: said(e, `Couldn't restore from ${file.name}.`), warn: true });
    } finally {
      setTicketRestoreBusy(false);
    }
  };

  const downloadFile = async (
    url: string, init: RequestInit, filename: string,
    setBusy: (b: boolean) => void,
  ) => {
    if (!activeOrgId) return;
    setBusy(true); setError(null);
    try {
      const token = await authToken();
      const headers = { ...(init.headers || {}), Authorization: `Bearer ${token}` };
      const res = await fetch(url, { ...init, headers });
      if (!res.ok) throw await responseError(res);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(href);
    } catch (e) {
      setError(said(e, "The download didn't finish."));
    } finally {
      setBusy(false);
    }
  };

  const downloadJson = () => downloadFile(
    `/api/data-export/structured?orgId=${activeOrgId}`, {},
    `manufacturing-os-backup-${Date.now()}.json`, setBusyJson,
  );

  // The ZIP carries a stable archive id in a header; name the saved file after
  // it and surface it so the admin can record which archive this is.
  const downloadZip = async () => {
    if (!activeOrgId) return;
    setBusyZip(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/data-export/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, includeFiles: true }),
      });
      if (!res.ok) throw await responseError(res);
      const archiveId = res.headers.get("X-Archive-Id") || "";
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = archiveId ? `manufacturing-os-backup-${archiveId}.zip` : `manufacturing-os-backup-${Date.now()}.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(href);
      if (archiveId) setLastArchiveId(archiveId);
    } catch (e) {
      setError(said(e, "The backup didn't finish."));
    } finally {
      setBusyZip(false);
    }
  };

  const tables = stats?.db.tables ?? [];
  const maxBytes = tables.reduce((m, t) => Math.max(m, t.bytes), 0);
  const isRealQuota = !!(quotaBytes && quotaBytes > 0);
  const budgetBytes = isRealQuota ? (quotaBytes as number) : SOFT_BUDGET_BYTES;
  const usedBytes = (stats?.db.totalBytes ?? 0) + (stats?.r2Real?.bytes ?? stats?.r2Estimate.totalBytes ?? 0);
  const pct = Math.min(100, Math.round((usedBytes / budgetBytes) * 100));
  const health: "ok" | "warn" | "crit" = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok";
  const byCat = stats?.db.byCategory ?? { purge: 0, archive: 0, reference: 0 };
  const reclaimNow = (preview?.totalEstBytes ?? 0) + (stats?.dedup?.reclaimableBytes ?? 0);
  const ticketRow = tables.find((t) => t.name === "tickets");
  const bandTone = (b: "ok" | "warn" | "crit"): Tone => (b === "crit" ? "bad" : b === "warn" ? "warn" : "none");
  const bandBar = (b: "ok" | "warn" | "crit") => (b === "crit" ? "bg-[var(--state-overdue)]" : b === "warn" ? "bg-[var(--state-held)]" : "bg-[var(--color-text-faint)]");
  const small = `${bandSelect} !h-9 pointer-coarse:!h-11`;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Storage and backup"
        back={{ href: "/settings", label: "Back to Settings" }}
        title={stats ? `${pct}% full.` : error && !loading ? "Couldn't measure storage." : "Storage and backup"}
        sub={stats
          ? (health === "crit" ? "Act now: take a full backup, then free up space." : health === "warn" ? "Time to take a full backup and free up space." : "Plenty of room. Take a full backup every quarter.")
          : "How full storage is, what can be cleared, and backups."}
        facts={stats ? [
          { label: "Used", value: fmtBytes(usedBytes), tone: health === "crit" ? "bad" : health === "warn" ? "warn" : undefined, hero: true },
          { label: isRealQuota ? "Limit" : "Soft budget", value: fmtBytes(budgetBytes) },
          { label: "Can free now", value: fmtBytes(reclaimNow) },
        ] : undefined}
        tools={
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="Measure again" title="Measure again" className={heroQuiet}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        }
        // The one main action here: a real backup out (records + files).
        primary={
          <Button loading={busyZip} disabled={!activeOrgId} onClick={() => void downloadZip()}>
            {!busyZip && <FileArchive className="w-4 h-4" />}
            {busyZip ? "Building backup" : "Full backup (ZIP)"}
          </Button>
        }
      >
        {stats && (
          <div className="h-2 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] overflow-hidden" role="img" aria-label={`${pct}% of storage used`}>
            <div className="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.max(2, pct)}%`, background: health === "crit" ? "var(--state-overdue)" : health === "warn" ? "var(--state-held)" : "var(--color-text-muted)" }} />
          </div>
        )}
      </PageHero>

      <PageBody>
      {error && stats && <Problem retry={() => void load()}>{error}</Problem>}
      {lastArchiveId && (
        <p role="status" className="text-body text-[var(--color-text)] flex items-start gap-2">
          <CheckCircle2 aria-hidden className="w-4 h-4 shrink-0 mt-0.5 text-[var(--state-released)]" />
          <span>Saved as archive <CopyId value={lastArchiveId} label="archive ID" />. Store it at <span className="font-mono text-body break-all">{archiveRoot ? subfolder(archiveRoot, "full-backups") : "<root>/full-backups/"}{lastArchiveId}.zip</span>. Quote this ID if anyone needs a file it holds.</span>
        </p>
      )}

      {loading && !stats ? (
        <SkeletonRows rows={4} cols={2} what="storage use" />
      ) : !stats ? (
        error ? <ErrorNote title="Couldn't measure storage." next={error} onRetry={() => void load()} /> : null
      ) : (
        <>
          {/* ── Where it stands: the limit, the database, the files ─────── */}
          <Section label="Where it stands">
            <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
              <FormRow label="Storage limit" hint={isRealQuota ? "Admins are alerted at 70% and 90%." : "A guide until you set your plan's real limit."}>
                <div className="@xl:pt-1 flex items-center gap-x-4 gap-y-2 flex-wrap">
                  <span className="font-display text-section font-semibold tabular-nums text-[var(--color-text)]">{fmtBytes(budgetBytes)}</span>
                  <StatusTag tone={health === "crit" ? "bad" : health === "warn" ? "warn" : "none"}>{health === "crit" ? "Act now" : health === "warn" ? "Plan a backup" : "Healthy"}</StatusTag>
                  {canPurge && (editingQuota ? (
                    <form className="inline-flex items-center gap-2 flex-wrap" onSubmit={(e) => { e.preventDefault(); void saveQuota(); }}>
                      <label className="text-body text-[var(--color-text-muted)]" htmlFor="quota-gb">Limit in GB</label>
                      <input id="quota-gb" value={quotaDraft} onChange={(e) => setQuotaDraft(e.target.value)} inputMode="decimal" placeholder="10"
                        className={`${fieldBox} h-9 pointer-coarse:h-11 w-24 text-reading tabular-nums`} />
                      <Button size="sm" variant="secondary" type="submit" loading={savingQuota}>Save</Button>
                      <button type="button" onClick={() => { setEditingQuota(false); setQuotaDraft(quotaBytes ? String(Math.round((quotaBytes / (1024 ** 3)) * 10) / 10) : ""); }} className={btnLink}>Cancel</button>
                    </form>
                  ) : (
                    <button type="button" onClick={() => setEditingQuota(true)} className={btnLink}>
                      {isRealQuota ? "Change the limit" : "Set your limit"}
                    </button>
                  ))}
                </div>
              </FormRow>
              <FormRow label="Database" hint="Postgres">
                <div className="@xl:pt-1"><span className="font-display text-section font-semibold tabular-nums">{fmtBytes(stats.db.totalBytes)}</span> <span className="text-body text-[var(--color-text-muted)]">in {plural(tables.length, "table")}</span></div>
              </FormRow>
              <FormRow label="Files" hint={stats.r2Real ? "Cloudflare R2, measured" : "Cloudflare R2, estimated"}>
                <div className="@xl:pt-1">
                  <span className="font-display text-section font-semibold tabular-nums">{stats.r2Real ? fmtBytes(stats.r2Real.bytes) : `~${fmtBytes(stats.r2Estimate.totalBytes)}`}</span>{" "}
                  <span className="text-body text-[var(--color-text-muted)]">
                    {stats.r2Real
                      ? `${plural(stats.r2Real.objects, "file")}, measured ${new Date(stats.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
                      : `${plural(stats.r2Estimate.versionCount, "revision")}, ${plural(stats.r2Estimate.photoCount, "photo")}`}
                    {stats.r2Real?.newest && `. Newest ${shortDateTime(stats.r2Real.newest)}`}
                  </span>
                </div>
              </FormRow>
            </div>

            {/* The measurement failed and the page fell back to a row-sum that
                can't see knowledge PDFs, templates or orphans. Say so: an
                estimate that never moves looks exactly like a wrong number. */}
            {!stats.r2Real && (
              <p role="alert" className="mt-3 text-body text-[var(--color-text)] flex items-start gap-2">
                <AlertTriangle aria-hidden className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-held)]" />
                <span>
                  <b className="font-medium">The file total is an estimate, not a measurement.</b> Measuring the bucket failed, so it
                  only counts document revisions and asset photos, not knowledge PDFs, request attachments, output templates or orphaned files.
                  {stats.r2Error && <> {said(stats.r2Error, "Why it failed:")}</>}
                </span>
              </p>
            )}
            {stats.r2Real?.truncated && (
              <p className="mt-3 text-body text-[var(--color-text)] flex items-start gap-2">
                <AlertTriangle aria-hidden className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-held)]" />
                <span>
                  <b className="font-medium">Measuring stopped early, so the real total is higher.</b> The bucket has more than 500,000
                  files. Treat {fmtBytes(stats.r2Real.bytes)} as the least it could be.
                </span>
              </p>
            )}

            <div className="mt-3 space-y-2">
              {/* WHERE the bytes are: the receipt behind the total. */}
              {stats.r2Real && (stats.r2Real.segments?.length ?? 0) > 0 && (
                <Disclosure title="Where the files are" meta={plural(stats.r2Real.segments!.length, "place")}>
                  <table className="w-full text-body tabular-nums">
                    <thead className="sr-only"><tr><th>Where</th><th>Share</th><th>Size</th><th>Files</th><th>Newest</th></tr></thead>
                    <tbody className="divide-y divide-[var(--color-border)]">
                      {stats.r2Real.segments!.map((s) => {
                        const share = stats.r2Real!.bytes > 0 ? Math.round((s.bytes / stats.r2Real!.bytes) * 100) : 0;
                        return (
                          <tr key={s.label}>
                            <td className="py-2 pr-3 font-medium text-[var(--color-text)]">{s.label}</td>
                            <td className="py-2 pr-3 w-[30%] max-sm:hidden">
                              <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                                <div className="h-full rounded-full bg-[var(--color-text-faint)]" style={{ width: `${Math.max(1, share)}%` }} />
                              </div>
                            </td>
                            <td className="py-2 pr-3 text-right whitespace-nowrap">{fmtBytes(s.bytes)}</td>
                            <td className="py-2 pr-3 text-right whitespace-nowrap text-[var(--color-text-muted)]">{plural(s.objects, "file")}</td>
                            <td className="py-2 text-right whitespace-nowrap text-[var(--color-text-muted)] max-sm:hidden">{s.newest ? `Newest ${shortDate(s.newest)}` : ""}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="mt-2 text-body text-[var(--color-text-muted)]">
                    These add up to the measured total. If a batch you just uploaded is missing, its row&apos;s newest date shows whether the files landed.
                  </p>
                </Disclosure>
              )}

              {/* Plan headroom: real use against the hosting plan's ceilings. */}
              {stats.freeTier && (
                <Disclosure title="Hosting plan limits"
                  meta={<StatusTag tone={bandTone(stats.freeTier.dbBand === "crit" || stats.r2Real?.band === "crit" ? "crit" : stats.freeTier.dbBand === "warn" || stats.r2Real?.band === "warn" ? "warn" : "ok")}>
                    {stats.freeTier.dbBand === "ok" && (stats.r2Real?.band ?? "ok") === "ok" ? "Within limits" : "Near a limit"}
                  </StatusTag>}
                  open={stats.freeTier.dbBand !== "ok" || stats.r2Real?.band === "warn" || stats.r2Real?.band === "crit"}>
                  <div className="space-y-3">
                    {stats.r2Real && (
                      <Meter label="Cloudflare R2 (files)" used={stats.r2Real.bytes} limit={stats.freeTier.r2LimitBytes} pct={stats.r2Real.pct} tone={bandTone(stats.r2Real.band)} bar={bandBar(stats.r2Real.band)} />
                    )}
                    <Meter label="Supabase (database)" used={stats.db.totalBytes} limit={stats.freeTier.dbLimitBytes} pct={stats.freeTier.dbPct} tone={bandTone(stats.freeTier.dbBand)} bar={bandBar(stats.freeTier.dbBand)} />
                  </div>
                  {editingLimits ? (
                    <form className="mt-4 flex items-end gap-3 flex-wrap" onSubmit={(e) => { e.preventDefault(); void saveLimits(); }}>
                      <label className="block">
                        <span className={label}>Files (GB)</span>
                        <input value={r2LimitDraft} onChange={(e) => setR2LimitDraft(e.target.value)} inputMode="decimal"
                          className={`${fieldBox} h-10 pointer-coarse:h-11 w-28 text-reading tabular-nums`} />
                      </label>
                      <label className="block">
                        <span className={label}>Database (MB)</span>
                        <input value={dbLimitDraft} onChange={(e) => setDbLimitDraft(e.target.value)} inputMode="decimal"
                          className={`${fieldBox} h-10 pointer-coarse:h-11 w-28 text-reading tabular-nums`} />
                      </label>
                      <Button variant="secondary" type="submit" loading={savingLimits}>Save limits</Button>
                      <button type="button" onClick={() => setEditingLimits(false)} className={`${btnLink} h-10`}>Cancel</button>
                    </form>
                  ) : (
                    <p className="mt-3 text-body text-[var(--color-text-muted)]">
                      Use is measured. The limits are your hosting plan&apos;s
                      {stats.freeTier.source === "settings" ? ", set by an admin here." : ": the free tiers until changed (R2 10 GB, Supabase 500 MB)."}{" "}
                      <button type="button" onClick={() => {
                        setR2LimitDraft(String(Math.round((stats.freeTier!.r2LimitBytes / 1024 ** 3) * 10) / 10));
                        setDbLimitDraft(String(Math.round(stats.freeTier!.dbLimitBytes / 1024 ** 2)));
                        setEditingLimits(true);
                      }} className={link}>
                        {stats.freeTier.source === "settings" ? "Change plan limits" : "Upgraded your plan? Set the real limits"}
                      </button>
                    </p>
                  )}
                </Disclosure>
              )}
            </div>
          </Section>

          {/* ── Free up space ─────────────────────────────────────────────── */}
          {canPurge ? (
            <Section label="Free up space" action={<span className="text-body text-[var(--color-text-muted)]">Your workspace only</span>}>
              <div className="space-y-3">
                {/* Purge: disposable rows only. */}
                <Panel title="Old byproducts" help="Rows the app makes as it works (logs, previews, old notices). Records are never touched. A purge is written to the audit log."
                  control={<label className="inline-flex items-center gap-2 text-body text-[var(--color-text-muted)]">Older than
                    <select value={purgeDays} onChange={(e) => setPurgeDays(Number(e.target.value))} className={small}>
                      {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
                    </select></label>}>
                  {readErrors.purge != null ? (
                    <ErrorNote compact error={readErrors.purge} title="Couldn't check what can be purged." onRetry={() => void loadPreview(purgeDays)} />
                  ) : previewLoading && !preview ? (
                    <SkeletonRows rows={2} cols={2} what="what can be purged" />
                  ) : (preview?.targets.length ?? 0) > 0 ? (
                    <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
                      <table className={tbl.table}>
                        <thead className={tbl.thead}><tr><th className={tbl.th}>What</th><th className={`${tbl.th} text-right`}>Rows</th><th className={`${tbl.th} text-right`}>Size</th></tr></thead>
                        <tbody className={tbl.tbody}>
                          {preview!.targets.map((t) => (
                            <tr key={t.table} title={t.reason}>
                              <td className="px-4 py-2"><div className="font-medium text-[var(--color-text)]">{t.label}</div><div className="text-body text-[var(--color-text-muted)] font-mono truncate">{t.table}</div></td>
                              <td className="px-4 py-2 text-right">{fmtNum(t.rows)}</td>
                              <td className="px-4 py-2 text-right text-[var(--color-text-muted)]">≈{fmtBytes(t.estBytes)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {readErrors.purge == null && (
                    <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
                      <p className="text-body text-[var(--color-text-muted)]">
                        {preview && preview.totalRows > 0
                          ? <>Frees about <b className="font-medium text-[var(--color-text)]">{fmtBytes(preview.totalEstBytes)}</b> across {plural(preview.totalRows, "row")}.</>
                          : preview ? `Nothing older than ${purgeDays} days to purge.` : ""}
                      </p>
                      {preview && preview.totalRows > 0 && (
                        <button type="button" onClick={() => void runPurge()} disabled={purging} className={btnDanger}>
                          {purging ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                          Purge {plural(preview.totalRows, "row")}
                        </button>
                      )}
                    </div>
                  )}
                </Panel>

                {/* The shed: older revision files go to an offline archive. */}
                <Panel title="Older revision files" help={`Keeps the last ${shedKeep} revisions of every document live and moves the files of older ones into one offline archive. Each revision's record, checksum and reason stay; only the file moves. The current revision is never touched.`}
                  control={<label className="inline-flex items-center gap-2 text-body text-[var(--color-text-muted)]">Keep the last
                    <select value={shedKeep} onChange={(e) => setShedKeep(Number(e.target.value))} className={small}>
                      {[3, 5, 10, 20].map((d) => <option key={d} value={d}>{d} revisions</option>)}
                    </select></label>}>
                  {readErrors.shed != null ? (
                    <ErrorNote compact error={readErrors.shed} title="Couldn't check older revisions." onRetry={() => void loadShedPreview(shedKeep)} />
                  ) : !shedPreview ? (
                    <SkeletonRows rows={1} cols={1} what="older revisions" sheet={false} />
                  ) : shedPreview.selectedCount > 0 ? (
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <p className="text-body text-[var(--color-text-muted)]">
                        <b className="font-medium text-[var(--color-text)]">{plural(shedPreview.selectedCount, "older file")}</b>, about <b className="font-medium text-[var(--color-text)]">{fmtBytes(shedPreview.reclaimableBytes)}</b>.
                        {(shedPreview.remainingCount ?? 0) > 0 && <> <span className="text-[var(--state-held-text)] font-medium">{fmtNum(shedPreview.remainingCount!)} more</span> past one archive&apos;s size limit; build again after reclaiming.</>}
                        {archiveRoot && <> Save to <span className="font-mono break-all">{subfolder(archiveRoot, "data")}&lt;id&gt;.zip</span></>}
                      </p>
                      <button type="button" onClick={() => void produceArchive()} disabled={shedBusy} className={btnQuiet}>
                        {shedBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />} Build and download archive
                      </button>
                    </div>
                  ) : (
                    <p className="text-body text-[var(--color-text-muted)]">No document has more than {shedKeep} revisions, so there&apos;s nothing older to archive.</p>
                  )}
                  {pendingArchive && (
                    <PendingStep
                      archiveId={pendingArchive.archiveId}
                      folder={archiveRoot ? subfolder(archiveRoot, "data") : "<root>/data/"}
                      what={<>Then reclaim about {fmtBytes(pendingArchive.bytes)} from live storage. Until you do, the files stay online.</>}
                      bytes={pendingArchive.bytes} busy={committing}
                      onReclaim={() => void commitArchive()} onDiscard={() => void cancelPending(pendingArchive.archiveId, "doc")} />
                  )}
                </Panel>

                {/* Closed requests go to an offline archive; a stub stays. */}
                <Panel title="Long-closed requests" help="Moves long-closed requests (comments, history and attachments) into one offline archive and leaves a small stub in the list. Opening a stub asks for the archive, and one restore brings it all back. Only closed or canceled requests; open ones are never touched."
                  control={<label className="inline-flex items-center gap-2 text-body text-[var(--color-text-muted)]">Closed over
                    <select value={ticketDays} onChange={(e) => setTicketDays(Number(e.target.value))} className={small}>
                      {[90, 180, 365, 730].map((d) => <option key={d} value={d}>{d} days</option>)}
                    </select></label>}>
                  {readErrors.ticket != null ? (
                    <ErrorNote compact error={readErrors.ticket} title="Couldn't check closed requests." onRetry={() => void loadTicketShedPreview(ticketDays)} />
                  ) : !ticketPreview ? (
                    <SkeletonRows rows={1} cols={1} what="closed requests" sheet={false} />
                  ) : ticketPreview.selectedCount > 0 ? (
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <p className="text-body text-[var(--color-text-muted)]">
                        <b className="font-medium text-[var(--color-text)]">{plural(ticketPreview.selectedCount, "closed request")}</b>, about <b className="font-medium text-[var(--color-text)]">{fmtBytes(ticketPreview.reclaimableBytes)}</b> of attachments.
                        {archiveRoot && <> Save to <span className="font-mono break-all">{subfolder(archiveRoot, "data")}&lt;id&gt;.zip</span></>}
                      </p>
                      <button type="button" onClick={() => void produceTicketArchive()} disabled={ticketBusy} className={btnQuiet}>
                        {ticketBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />} Build and download archive
                      </button>
                    </div>
                  ) : (
                    <p className="text-body text-[var(--color-text-muted)]">No request has been closed longer than {ticketDays} days.</p>
                  )}
                  {pendingTicketArchive && (
                    <PendingStep
                      archiveId={pendingTicketArchive.archiveId}
                      folder={archiveRoot ? subfolder(archiveRoot, "data") : "<root>/data/"}
                      what={<>Then move {pendingTicketArchive.tickets} request(s) to the archive and reclaim about {fmtBytes(pendingTicketArchive.bytes)}. Until you do, everything stays online.</>}
                      bytes={pendingTicketArchive.bytes} busy={ticketCommitting}
                      onReclaim={() => void commitTicketArchive()} onDiscard={() => void cancelPending(pendingTicketArchive.archiveId, "ticket")} />
                  )}
                  <div className="mt-4 pt-3 border-t border-[var(--color-border)] flex items-center justify-between gap-3 flex-wrap">
                    <p className="text-body text-[var(--color-text-muted)]">Bringing closed requests back? Restore them from the saved archive.</p>
                    <label className={`${btnQuiet} cursor-pointer ${ticketRestoreBusy ? "opacity-50 pointer-events-none" : ""}`}>
                      {ticketRestoreBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderArchive className="w-4 h-4" />} Restore from archive
                      <input type="file" accept=".zip" className="sr-only" disabled={ticketRestoreBusy}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) void restoreTicketsFromArchive(f); e.currentTarget.value = ""; }} />
                    </label>
                  </div>
                  {ticketRestoreFile && (
                    <div className="mt-2 flex items-center gap-2.5">
                      <FileThumb file={ticketRestoreFile} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-body font-medium text-[var(--color-text)] truncate">{ticketRestoreFile.name}</span>
                        <span className="block text-body text-[var(--color-text-muted)]">
                          {fmtBytes(ticketRestoreFile.size)}
                          {ticketRestoreBusy && <span className="inline-flex items-center gap-1 ml-2"><Loader2 aria-hidden className="w-3 h-3 animate-spin" /> Uploading and restoring</span>}
                        </span>
                      </span>
                      {!ticketRestoreBusy && (
                        <Button size="sm" variant="secondary" onClick={() => void restoreTicketsFromArchive(ticketRestoreFile)}>Try again</Button>
                      )}
                    </div>
                  )}
                  {ticketRestoreMsg && <p role="status" className={`mt-2 text-body font-medium ${ticketRestoreMsg.warn ? "text-[var(--state-held-text)]" : "text-[var(--color-text)]"}`}>{ticketRestoreMsg.text}</p>}
                </Panel>

                {/* Orphaned files: bucket objects nothing references. */}
                <Panel title="Orphaned files" help="Files in storage that nothing uses, like knowledge PDFs you deleted. Scanning changes nothing. Deleting checks each file again and never touches anything newer than 7 days."
                  control={<button type="button" onClick={() => void scanOrphanFiles()} disabled={orphanBusy !== null} className={btnRow}>
                    {orphanBusy === "scan" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {orphanScan ? "Scan again" : "Scan"}
                  </button>}>
                  {orphanMsg && (
                    <p role="status" className={`text-body font-medium ${orphanMsg.warn ? "text-[var(--state-held-text)]" : "text-[var(--color-text)]"}`}>{orphanMsg.text}</p>
                  )}
                  {!orphanScan && !orphanMsg && <p className="text-body text-[var(--color-text-muted)]">Scan to find files nothing uses.</p>}
                  {orphanScan && (
                    orphanScan.orphans.length === 0 ? (
                      <p className="text-body text-[var(--color-text)]">
                        All {fmtNum(orphanScan.totalObjects)} files in storage are in use.
                        {orphanScan.skippedYoung > 0 && <span className="text-[var(--color-text-muted)]"> {orphanScan.skippedYoung} too new to judge yet.</span>}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="font-display text-section font-semibold tabular-nums text-[var(--color-text)]">{fmtBytes(orphanScan.orphanBytes)}</span>
                          <span className="text-body text-[var(--color-text-muted)]">
                            in {plural(orphanScan.orphans.length, "orphaned file")}; {fmtNum(orphanScan.referencedKeys)} files in use checked
                            {orphanScan.skippedYoung > 0 && `, ${orphanScan.skippedYoung} under 7 days old skipped`}
                          </span>
                          <button type="button" onClick={() => void purgeOrphanFiles()} disabled={orphanBusy !== null} className={`sm:ml-auto ${btnDanger}`}>
                            {orphanBusy === "delete" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                            Delete them
                          </button>
                        </div>
                        <ul className="max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] text-body">
                          {orphanScan.orphans.slice(0, 50).map((o) => (
                            <li key={o.key} className="px-3 py-1.5 flex items-center gap-2">
                              <span className="truncate flex-1 font-mono text-[var(--color-text-muted)]" title={o.key}>{o.key}</span>
                              <span className="shrink-0 tabular-nums font-medium text-[var(--color-text)]">{fmtBytes(o.size)}</span>
                            </li>
                          ))}
                          {orphanScan.orphans.length > 50 && (
                            <li className="px-3 py-1.5 text-[var(--color-text-muted)]">And {fmtNum(orphanScan.orphans.length - 50)} more</li>
                          )}
                        </ul>
                      </div>
                    )
                  )}
                </Panel>
              </div>
            </Section>
          ) : (
            <p className="text-body text-[var(--color-text-muted)] flex items-center gap-2">
              <Lock aria-hidden className="w-4 h-4 shrink-0" /> Only Admin and Doc Control can free up space. You can still see use and download backups.
            </p>
          )}

          {/* ── Offline archives: every archive made, and where each stands ─ */}
          {canPurge && readErrors.catalog != null && (
            <ErrorNote compact error={readErrors.catalog} title="Couldn't load the offline archives." onRetry={() => void loadCatalog()} />
          )}
          {canPurge && catalog && catalog.length > 0 && (
            <Section label={<>Offline archives <HelpTooltip>Every archive this workspace has made, and where each stands. One that stopped before &ldquo;I saved it, reclaim&rdquo; (a closed tab, a crash) shows as waiting for reclaim. Running Reclaim again is safe: it retries any deletes that failed.</HelpTooltip></>}
              count={catalog.length}
              action={<button type="button" onClick={() => void loadCatalog()} title="Check again" aria-label="Check the archives again" className={btnIcon}><RefreshCw className="w-4 h-4" /></button>}>
              {catalogMsg && (
                <p role="status" className={`mb-3 text-body font-medium flex items-start gap-1.5 ${catalogMsg.warn ? "text-[var(--state-held-text)]" : "text-[var(--color-text)]"}`}>
                  {catalogMsg.warn ? <AlertTriangle aria-hidden className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 aria-hidden className="w-4 h-4 mt-0.5 shrink-0 text-[var(--state-released)]" />}
                  {catalogMsg.text}
                </p>
              )}
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={`${tbl.thead} max-md:hidden`}>
                    <tr>
                      <th className={tbl.th}>Archive</th>
                      <th className={tbl.th}>Status</th>
                      <th className={tbl.th}>Made</th>
                      <th className={`${tbl.th} text-right`}>Size</th>
                      <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {catalog.map((row) => {
                      const busy = catalogBusyId === row.archiveId;
                      const isTicket = row.ticketPending + row.ticketCommitted > 0;
                      const st: { tone: Tone; word: string } =
                        row.status === "producing" ? { tone: "bad", word: "Never finished building" } :
                        row.status === "pending" ? { tone: "warn", word: "Waiting for reclaim, still billed" } :
                        row.status === "committed" ? { tone: "none", word: "Reclaimed; the zip is the only copy" } :
                        row.status === "full" ? { tone: "none", word: "Full backup" } :
                        { tone: "none", word: "Nothing linked" };
                      const canDiscard = row.status === "pending" || row.status === "producing" || row.status === "empty";
                      return (
                        <tr key={row.archiveId} className={`${tbl.tr} max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-2 max-md:py-2`}>
                          <td className={`${tbl.td} max-md:py-1`}>
                            <CopyId value={row.archiveId} label="archive ID" className="font-mono text-body" />
                            {copiedArchiveId === row.archiveId && <span className="ml-2 text-caption text-[var(--color-text-muted)]">Save path copied</span>}
                            <div className="text-body text-[var(--color-text-muted)]">{row.kind === "full" ? "Full backup" : isTicket ? "Closed requests" : "Revision files"}</div>
                          </td>
                          <td className={`${tbl.td} max-md:col-span-2 max-md:row-start-2 max-md:py-0.5`}>
                            <StatusTag tone={st.tone}>{st.word}</StatusTag>
                            {row.status === "pending" && (
                              <div className="text-body text-[var(--color-text-muted)] mt-0.5">{row.docPending > 0 ? plural(row.docPending, "revision") : plural(row.ticketPending, "request")} waiting</div>
                            )}
                          </td>
                          <td className={`${tbl.td} max-md:col-span-2 max-md:row-start-3 max-md:py-0.5 text-[var(--color-text-muted)]`}>
                            {row.createdAt ? shortDateTime(row.createdAt) : <span className="text-[var(--color-text-faint)]">Not recorded</span>}
                            {row.createdByEmail && <div className="text-body truncate max-w-[24ch]">{row.createdByEmail}</div>}
                          </td>
                          <td className={`${tbl.td} max-md:col-span-2 max-md:row-start-4 max-md:py-0.5 md:text-right whitespace-nowrap`}>
                            {row.fileCount > 0 ? <>{fmtBytes(row.totalBytes)}<div className="text-body text-[var(--color-text-muted)]">{plural(row.fileCount, "file")}</div></> : <span className="text-[var(--color-text-faint)]">None</span>}
                          </td>
                          <td className={`${tbl.td} max-md:col-start-2 max-md:row-start-1 max-md:py-1 text-right whitespace-nowrap`}>
                            <span className="inline-flex items-center gap-1">
                              {row.status === "pending" && (
                                <button type="button" onClick={() => void commitFromCatalog(row)} disabled={busy} className={`${btnRow} !text-[var(--state-overdue-text)]`}>
                                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Reclaim
                                </button>
                              )}
                              <MoreMenu iconOnly label={`More for ${row.archiveId}`} triggerClass={btnIcon} items={[
                                { icon: <Copy className="w-4 h-4" />, label: "Copy save path", onClick: () => copyArchivePath(row) },
                                ...(canDiscard ? [{ icon: <X className="w-4 h-4" />, label: "Discard", tone: "bad" as const, line: true, onClick: () => cancelPending(row.archiveId, isTicket ? "ticket" : "doc") }] : []),
                              ]} />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* ── Backup and restore ─────────────────────────────────────────── */}
          <Section label={<>Backup and restore <HelpTooltip>The full backup (top of the page) holds every record and every file (PDF, DWG, photo), so you can rebuild from nothing. Take one every quarter.</HelpTooltip></>}>
            {canPurge && readErrors.settings != null && (
              <ErrorNote compact className="mb-3" error={readErrors.settings} title="Couldn't load the archive folder." onRetry={() => void loadArchiveSettings()} />
            )}
            <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
              {/* The archive folder: one place, shared, with a fixed layout under it. */}
              {canPurge && (
                <FormRow label="Archive folder" hint="Where your team keeps backups. Anyone asked for an archived file is pointed here.">
                  {!editingLoc && archiveRoot ? (
                    <div className="@xl:pt-1 text-body min-w-0">
                      <div className="flex items-start gap-3">
                        <span className="font-mono break-all text-[var(--color-text)] flex-1 min-w-0">{archiveRoot}</span>
                        <button type="button" onClick={() => setEditingLoc(true)} className={btnLink}>Change</button>
                      </div>
                      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-body text-[var(--color-text-muted)]">
                        <dt>Full backups</dt><dd className="font-mono break-all">{subfolder(archiveRoot, "full-backups")}</dd>
                        <dt>Space-saver</dt><dd className="font-mono break-all">{subfolder(archiveRoot, "data")}</dd>
                        {finderNote && <><dt>Finder note</dt><dd>{finderNote}</dd></>}
                      </dl>
                    </div>
                  ) : (
                    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void saveArchiveLoc(); }}>
                      {!archiveRoot && <StatusTag tone="warn">Not set yet</StatusTag>}
                      <label className="block">
                        <span className={label}>Folder</span>
                        <input value={locDraft} onChange={(e) => setLocDraft(e.target.value)} placeholder="\\fileserver\drafting\mos-archives"
                          className={`${field} font-mono`} />
                      </label>
                      <label className="block">
                        <span className={label}>Finder note <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></span>
                        <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Ask IT for access to the DC-3 share"
                          className={field} />
                      </label>
                      {locDraft.trim() && (
                        <p className="text-body text-[var(--color-text-muted)] break-all">People will be told: <span className="font-mono">{subfolder(locDraft, "data")}&lt;archive-id&gt;.zip</span>{noteDraft.trim() ? <> ({noteDraft.trim()})</> : null}</p>
                      )}
                      <div className="flex items-center gap-3">
                        <Button variant="secondary" type="submit" loading={savingLoc} disabled={!locDraft.trim()}>Save folder</Button>
                        {archiveRoot && (
                          <button type="button" onClick={() => { setEditingLoc(false); setLocDraft(archiveRoot || ""); }} className={btnLink}>Cancel</button>
                        )}
                      </div>
                    </form>
                  )}
                </FormRow>
              )}
              <FormRow label="Records only" hint="Every record as JSON, with links to the files that work for 24 hours.">
                <button type="button" onClick={() => void downloadJson()} disabled={busyJson || !activeOrgId} className={btnQuiet}>
                  {busyJson ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileJson className="w-4 h-4" />}
                  Download JSON
                </button>
              </FormRow>
              <FormRow label="From a backup">
                <div className="@xl:pt-1.5 flex flex-wrap items-center gap-x-5 gap-y-2">
                  <Link href="/admin/archive-view" className={link}>View files in a backup</Link>
                  <Link href="/admin/restore" className={link}>Restore records</Link>
                  <Link href="/admin/data-export" className={link}>Scheduled push to your own bucket</Link>
                </div>
              </FormRow>
            </div>
          </Section>

          {/* ── Details: measured, nothing here changes anything ────────── */}
          <Section label="Details">
            <div className="space-y-2">
              <Disclosure title="Database by kind" meta={`${fmtBytes(byCat.purge ?? 0)} can go`}>
                <table className="w-full text-body tabular-nums">
                  <thead className="text-left text-body text-[var(--color-text-muted)]"><tr><th className="font-medium pb-1.5 pr-3">Kind</th><th className="font-medium pb-1.5 pr-3 text-right">Size</th><th className="font-medium pb-1.5 max-sm:hidden">What it is</th></tr></thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {(["purge", "archive", "reference"] as DataClass[]).map((cat) => (
                      <tr key={cat}>
                        <td className="py-2 pr-3 font-medium whitespace-nowrap">{CATEGORY_LABEL[cat]}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">{fmtBytes(byCat[cat] ?? 0)}</td>
                        <td className="py-2 text-body text-[var(--color-text-muted)] max-sm:hidden">{CATEGORY_BLURB[cat]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Disclosure>

              {stats.dedup && stats.dedup.totalVersions > 0 && (
                <Disclosure title="Duplicate revision files" meta={`~${fmtBytes(stats.dedup.reclaimableBytes)}`}>
                  <dl className="flex flex-wrap gap-x-8 gap-y-2">
                    <div><dt className="text-body text-[var(--color-text-muted)]">Stored more than once</dt><dd className="text-reading font-medium tabular-nums">~{fmtBytes(stats.dedup.reclaimableBytes)}</dd></div>
                    <div><dt className="text-body text-[var(--color-text-muted)]">Files stored 2 or more times</dt><dd className="text-reading font-medium tabular-nums">{fmtNum(stats.dedup.dupGroups)}</dd></div>
                  </dl>
                  <p className="mt-2 text-body text-[var(--color-text-muted)]">Identical files are each stored on their own. This is measured only; nothing here changes them.</p>
                </Disclosure>
              )}

              <Disclosure title="AI use (shared key)" meta={stats.ai ? `${fmtNum(stats.ai.last24h)} calls today` : "Not counted"}>
                {stats.ai ? (
                  <>
                    <dl className="flex flex-wrap gap-x-8 gap-y-2">
                      <div><dt className="text-body text-[var(--color-text-muted)]">Last 24 hours</dt><dd className="text-reading font-medium tabular-nums">{plural(stats.ai.last24h, "call")}</dd></div>
                      <div><dt className="text-body text-[var(--color-text-muted)]">Last 30 days</dt><dd className="text-reading font-medium tabular-nums">{plural(stats.ai.last30d, "call")}</dd></div>
                    </dl>
                    <p className="mt-2 text-body text-[var(--color-text-muted)]">The shared key&apos;s free tier allows about 10 calls a minute and 1,000 a day, for everyone together.</p>
                  </>
                ) : (
                  <p className="text-body text-[var(--color-text-muted)]">AI use isn&apos;t counted yet. Apply migration <span className="font-mono">20260806</span>.</p>
                )}
              </Disclosure>

              <Disclosure title="Tables by size" meta={plural(tables.length, "table")}>
                {ticketRow && (
                  <p className="mb-2 text-body text-[var(--color-text-muted)]">
                    <b className="font-medium text-[var(--color-text)]">Why &ldquo;{ticketRow.name}&rdquo; is heavy per row:</b> {ticketRow.reason}
                  </p>
                )}
                <table className="w-full text-body tabular-nums">
                  <thead className="text-left text-body text-[var(--color-text-muted)]">
                    <tr>
                      <th className="font-medium pb-1.5 pr-3">Table</th>
                      <th className="font-medium pb-1.5 pr-3 max-sm:hidden">Kind</th>
                      <th className="font-medium pb-1.5 pr-3 w-[28%] max-md:hidden"><span className="sr-only">Share</span></th>
                      <th className="font-medium pb-1.5 pr-3 text-right">Size</th>
                      <th className="font-medium pb-1.5 text-right">Rows</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {tables.slice(0, 30).map((t) => (
                      <tr key={t.name} title={`${CATEGORY_LABEL[t.category]}: ${t.reason}`}>
                        <td className="py-1.5 pr-3 max-w-0 w-[40%]">
                          <span className="block font-mono text-body text-[var(--color-text)] truncate">{t.name}</span>
                          {t.grower && <span className="text-caption font-medium text-[var(--state-held-text)]">Grows fast</span>}
                        </td>
                        <td className="py-1.5 pr-3 text-body text-[var(--color-text-muted)] whitespace-nowrap max-sm:hidden">{CATEGORY_LABEL[t.category]}</td>
                        <td className="py-1.5 pr-3 max-md:hidden">
                          <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                            <div className="h-full rounded-full bg-[var(--color-text-faint)]" style={{ width: `${maxBytes > 0 ? Math.max(2, (t.bytes / maxBytes) * 100) : 0}%` }} />
                          </div>
                        </td>
                        <td className="py-1.5 pr-3 text-right whitespace-nowrap font-medium">{fmtBytes(t.bytes)}</td>
                        <td className="py-1.5 text-right whitespace-nowrap text-[var(--color-text-muted)]">{fmtNum(t.rows)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Disclosure>
            </div>
            <p className="mt-3 text-caption text-[var(--color-text-muted)]">{stats.note} Measured {shortDateTime(stats.generatedAt)}.</p>
          </Section>
        </>
      )}
      </PageBody>
    </PageShell>
  );
}

/** One way to free space: a title (the why in a tooltip), the one setting
 *  it takes on the right, then what it would do. */
function Panel({ title, help, control, children }: { title: string; help?: React.ReactNode; control?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-3">
        <h3 className="inline-flex items-center gap-1.5 text-reading font-medium text-[var(--color-text)]">{title}{help && <HelpTooltip>{help}</HelpTooltip>}</h3>
        {control}
      </div>
      {children}
    </div>
  );
}

/** Used against a limit: a gray bar unless it needs someone. */
function Meter({ label: text, used, limit, pct, tone, bar }: { label: string; used: number; limit: number; pct: number; tone: Tone; bar: string }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-body mb-1">
        <span className="font-medium text-[var(--color-text)]">{text}</span>
        <span className={`tabular-nums ${toneText(tone)} ${tone === "none" ? "!text-[var(--color-text-muted)]" : "font-semibold"}`}>{fmtBytes(used)} of {fmtBytes(limit)}, {pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, Math.max(1, pct))}%` }} />
      </div>
    </div>
  );
}

/** Step 2 of building an archive: save the zip, then reclaim the space
 *  (destructive, confirmed) or discard the archive. */
function PendingStep({ archiveId, folder, what, bytes, busy, onReclaim, onDiscard }: {
  archiveId: string; folder: string; what: React.ReactNode; bytes: number; busy: boolean;
  onReclaim: () => void; onDiscard: () => void;
}) {
  return (
    <div className="mt-4 relative pl-4">
      <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-held)]" />
      <StatusTag tone="warn">Step 2 of 2: reclaim the space</StatusTag>
      <p className="mt-1 text-body text-[var(--color-text)]">
        First save <span className="font-mono">{archiveId}.zip</span> to <span className="font-mono break-all">{folder}</span>. {what}
      </p>
      <div className="mt-2 flex items-center gap-4 flex-wrap">
        <button type="button" onClick={onReclaim} disabled={busy} className={btnDanger}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} I saved it, reclaim {fmtBytes(bytes)}
        </button>
        <button type="button" onClick={onDiscard} disabled={busy} className={`${btnLink} !text-[var(--color-text-muted)]`}>Discard</button>
      </div>
    </div>
  );
}
