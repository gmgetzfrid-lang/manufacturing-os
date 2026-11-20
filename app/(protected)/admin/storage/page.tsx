"use client";

// /admin/storage — "Storage, Usage & Backup" control center.
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
  Database, HardDrive, AlertTriangle, RefreshCw, Loader2, Gauge,
  Sparkles, Copy, Trash2, ShieldCheck, FileJson, FileArchive,
  Archive, Recycle, Lock, Info, CheckCircle2, ServerCog, UploadCloud, FolderArchive,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { CATEGORY_LABEL, type DataClass } from "@/lib/storageClassify";
import { appConfirm } from "@/components/providers/DialogProvider";
import LoadingBlock from "@/components/ui/LoadingBlock";
import FileThumb from "@/components/ui/FileThumb";
import { tryUpload } from "@/lib/uploadRetry";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";

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

const CATEGORY_META: Record<DataClass, { icon: typeof Recycle; tint: string; bar: string; blurb: string }> = {
  purge: {
    icon: Recycle, tint: "text-emerald-600", bar: "bg-emerald-500",
    blurb: "Byproducts. Safe to delete once old. No records are lost.",
  },
  archive: {
    icon: Archive, tint: "text-amber-600", bar: "bg-amber-500",
    blurb: "Real records. Never deleted. Kept live, then archived offline when old.",
  },
  reference: {
    icon: ShieldCheck, tint: "text-[var(--color-text)]", bar: "bg-[var(--color-text-muted)]",
    blurb: "Small settings and lookup data. Kept live. Not a cost concern.",
  },
};

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
  const [readErrors, setReadErrors] = useState<Partial<Record<"purge" | "shed" | "ticket" | "catalog" | "settings", string>>>({});
  const noteRead = useCallback((k: "purge" | "shed" | "ticket" | "catalog" | "settings", err: string | null) => {
    setReadErrors((prev) => {
      if (!err && !prev[k]) return prev;
      const next = { ...prev };
      if (err) next[k] = err; else delete next[k];
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setStats(body as Stats);
    } catch (e) {
      setError((e as Error).message);
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setPreview(body as PurgePreview);
      noteRead("purge", null);
    } catch (e) { noteRead("purge", (e as Error).message || "Couldn't check."); }
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      if (body?.settings) {
        setArchiveRoot(body.settings.location_hint || null);
        setLocDraft(body.settings.location_hint || "");
        setFinderNote(body.settings.naming || null);
        setNoteDraft(body.settings.naming || "");
        setQuotaBytes(body.settings.quota_bytes ?? null);
        setQuotaDraft(body.settings.quota_bytes ? String(Math.round((body.settings.quota_bytes / (1024 ** 3)) * 10) / 10) : "");
      }
      noteRead("settings", null);
    } catch (e) { noteRead("settings", (e as Error).message || "Couldn't load."); }
  }, [activeOrgId, canPurge, authToken, noteRead]);

  const loadShedPreview = useCallback(async (keep: number) => {
    if (!activeOrgId || !canPurge) return;
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/shed?orgId=${encodeURIComponent(activeOrgId)}&keep=${keep}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setShedPreview(body);
      noteRead("shed", null);
    } catch (e) { noteRead("shed", (e as Error).message || "Couldn't check."); }
  }, [activeOrgId, canPurge, authToken, noteRead]);

  const loadTicketShedPreview = useCallback(async (days: number) => {
    if (!activeOrgId || !canPurge) return;
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/ticket-shed?orgId=${encodeURIComponent(activeOrgId)}&days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setTicketPreview(body);
      noteRead("ticket", null);
    } catch (e) { noteRead("ticket", (e as Error).message || "Couldn't check."); }
  }, [activeOrgId, canPurge, authToken, noteRead]);

  const loadCatalog = useCallback(async () => {
    if (!activeOrgId || !canPurge) return;
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/archives?orgId=${encodeURIComponent(activeOrgId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      if (Array.isArray(body?.archives)) setCatalog(body.archives as CatalogArchive[]);
      noteRead("catalog", null);
    } catch (e) { noteRead("catalog", (e as Error).message || "Couldn't load."); }
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
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
      setArchiveRoot(locDraft.trim() || null);
      setFinderNote(noteDraft.trim() || null);
      setEditingLoc(false);
    } catch (e) {
      setError((e as Error).message);
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
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
      setQuotaBytes(bytes);
      setEditingQuota(false);
    } catch (e) {
      setError((e as Error).message);
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setEditingLimits(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setOrphanScan(body);
    } catch (e) {
      setOrphanMsg({ text: (e as Error).message, warn: true });
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setOrphanMsg({
        text: `Freed ${fmtBytes(body.freedBytes ?? 0)}: ${fmtNum(body.deleted ?? 0)} orphaned file(s) deleted.`,
        warn: (body.errors?.length ?? 0) > 0,
      });
      setOrphanScan(null);
      await load();
    } catch (e) {
      setOrphanMsg({ text: (e as Error).message, warn: true });
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      await Promise.all([load(), loadPreview(purgeDays)]);
    } catch (e) {
      setError((e as Error).message);
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
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
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
      setError((e as Error).message);
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
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
      setError((e as Error).message);
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
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
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
      setError((e as Error).message);
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setPendingTicketArchive(null);
      await Promise.all([load(), loadTicketShedPreview(ticketDays), loadCatalog()]);
    } catch (e) {
      setError((e as Error).message);
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      if (which === "ticket") setPendingTicketArchive(null); else setPendingArchive(null);
      await Promise.all([load(), which === "ticket" ? loadTicketShedPreview(ticketDays) : loadShedPreview(shedKeep), loadCatalog()]);
    } catch (e) {
      setError((e as Error).message);
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
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
      setError((e as Error).message);
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
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
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
      setTicketRestoreMsg({ text: `Couldn't restore from ${file.name}: ${(e as Error).message}`, warn: true });
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
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(href);
    } catch (e) {
      setError((e as Error).message);
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
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
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
      setError((e as Error).message);
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

  return (
    <PageShell width="form">
      <PageHero
        kicker="Admin · Storage, usage and backup"
        back={{ href: "/dashboard", label: "Back to Home" }}
        size="md"
        title={stats ? `${pct}% full.` : error ? "Couldn't measure storage." : "Storage and backup"}
        sub={stats ? (
          <>
            Using <b className="text-white">{fmtBytes(usedBytes)}</b> of {fmtBytes(budgetBytes)}.{" "}
            <span className={health === "crit" ? "font-bold text-rose-200" : health === "warn" ? "font-bold text-amber-300" : ""}>
              {health === "crit" ? "Act now: take a full backup, then free up space." : health === "warn" ? "Time to take a full backup and free up space." : "Plenty of room. Take a full backup every quarter."}
            </span>
          </>
        ) : "How full storage is, what can be cleared, and backups."}
        tools={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh"
            title="Refresh"
            className={heroQuiet}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        }
        // The one main action here: a real backup out (records + files).
        primary={
          <button type="button" onClick={() => void downloadZip()} disabled={busyZip || !activeOrgId} className={heroPrimary}>
            {busyZip ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileArchive className="w-4 h-4" />}
            {busyZip ? "Building backup…" : "Full backup (ZIP)"}
          </button>
        }
      >
        {stats && (
          <div className="h-2.5 rounded-full bg-[var(--color-ink-2)] overflow-hidden" aria-label={`${pct}% of storage used`}>
            <div className={`h-full rounded-full transition-all ${health === "crit" ? "bg-red-500" : health === "warn" ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
        )}
      </PageHero>

      <PageBody>
      {(error || lastArchiveId) && (
        <Card>
          {error && (
            <p role="alert" className="text-[14px] text-red-700 dark:text-red-400 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </p>
          )}
          {lastArchiveId && (
            <p role="status" className={`${error ? "mt-2" : ""} text-[13px] text-emerald-800 dark:text-emerald-300 flex items-start gap-1.5`}>
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Saved as archive <b className="font-mono">{lastArchiveId}</b>. Store it at <span className="font-mono break-all">{archiveRoot ? subfolder(archiveRoot, "full-backups") : "<root>/full-backups/"}{lastArchiveId}.zip</span>. Quote this id if anyone needs a file it holds.</span>
            </p>
          )}
        </Card>
      )}

      {loading && !stats ? (
        <Card><LoadingBlock what="storage use" rows={5} className="border-0 p-0" /></Card>
      ) : stats ? (
        <>
          {/* ── Health watermark ─────────────────────────────────────────── */}
          <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
              <div className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Total footprint</div>
              <div className={`text-[13px] font-bold ${health === "crit" ? "text-red-700 dark:text-red-400" : health === "warn" ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                {health === "crit" ? "Act now" : health === "warn" ? "Plan a backup" : "Healthy"}
              </div>
            </div>
            <div className="text-[15px] font-bold text-[var(--color-text)]">
              {fmtBytes(usedBytes)} <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">of {fmtBytes(budgetBytes)} {isRealQuota ? "limit" : "soft budget"}</span>
            </div>
            <div className="mt-2 flex items-start gap-1.5 text-[13px] text-[var(--color-text-muted)] leading-relaxed">
              <Info className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>
                {health === "ok"
                  ? "Plenty of room."
                  : `At ${pct}%, take a full backup and free up space below.`}
                {reclaimNow > 0 && <> About <b>{fmtBytes(reclaimNow)}</b> can be freed now (purge and duplicates).</>}
                {!isRealQuota && " The limit is a guide until you set your plan's real limit."}
              </span>
            </div>
            {canPurge && (
              <div className="mt-2 flex items-center gap-2 flex-wrap text-[11px]">
                {editingQuota ? (
                  <>
                    <span className="text-[var(--color-text-muted)]">Storage limit (GB):</span>
                    <input value={quotaDraft} onChange={(e) => setQuotaDraft(e.target.value)} inputMode="decimal" placeholder="e.g. 10"
                      className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-text)] font-mono" />
                    <button onClick={() => void saveQuota()} disabled={savingQuota}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">
                      {savingQuota ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Save
                    </button>
                    <button onClick={() => { setEditingQuota(false); setQuotaDraft(quotaBytes ? String(Math.round((quotaBytes / (1024 ** 3)) * 10) / 10) : ""); }}
                      className="text-[var(--color-text-muted)] font-bold">Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setEditingQuota(true)} className="inline-flex items-center gap-1 font-bold text-[var(--color-accent-text)] hover:underline">
                    <Gauge className="w-3.5 h-3.5" /> {isRealQuota ? "Change storage limit" : "Set your storage limit"}
                  </button>
                )}
                {isRealQuota && !editingQuota && <span className="text-[var(--color-text-faint)]">Admins are alerted at 70% / 90%.</span>}
              </div>
            )}
          </div>

          {/* ── DB / R2 headline ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-center gap-2 text-[var(--color-text-muted)] text-xs font-bold uppercase tracking-widest mb-1">
                <Database className="w-3.5 h-3.5" /> Database (Postgres)
              </div>
              <div className="text-[15px] font-bold text-[var(--color-text)]">{fmtBytes(stats.db.totalBytes)}</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">{tables.length} tables on disk</div>
            </div>
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-center gap-2 text-[var(--color-text-muted)] text-xs font-bold uppercase tracking-widest mb-1">
                <HardDrive className="w-3.5 h-3.5" /> Files (R2{stats.r2Real ? ", measured" : ", estimated"})
              </div>
              <div className="text-[15px] font-bold text-[var(--color-text)]">
                {stats.r2Real ? fmtBytes(stats.r2Real.bytes) : `~${fmtBytes(stats.r2Estimate.totalBytes)}`}
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                {stats.r2Real
                  ? `${fmtNum(stats.r2Real.objects)} objects in the bucket · measured ${new Date(stats.generatedAt).toLocaleTimeString()}`
                  : `${fmtNum(stats.r2Estimate.versionCount)} revisions · ${fmtNum(stats.r2Estimate.photoCount)} photos`}
              </div>
              {stats.r2Real?.newest && (
                <div className="text-[11px] text-[var(--color-text-faint)] mt-0.5">
                  Newest file in the bucket: {new Date(stats.r2Real.newest).toLocaleString()}
                </div>
              )}
            </div>
          </div>

          {/* The measurement failed and the page fell back to a row-sum that
              structurally cannot see knowledge PDFs, templates, or orphans.
              Silently showing that as "storage used" is worse than showing
              nothing — it never moves no matter how much you upload. */}
          {!stats.r2Real && (
            <p role="alert" className="px-1 border-l-2 border-red-500 pl-3 text-[13px] text-red-700 dark:text-red-400 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                <b>The file total above is an estimate, not a measurement.</b> Measuring the bucket failed, so it
                only counts document revisions and asset photos. Knowledge-library PDFs, ticket attachments,
                output templates and orphaned files are not counted.
                {stats.r2Error && <> Reason: <span className="font-mono">{stats.r2Error}</span></>}
              </span>
            </p>
          )}
          {stats.r2Real?.truncated && (
            <p className="px-1 border-l-2 border-amber-500 pl-3 text-[13px] text-amber-800 dark:text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                <b>Measuring stopped early, so the real total is higher.</b> The bucket has more than 500,000
                files. Treat {fmtBytes(stats.r2Real.bytes)} as the least it could be.
              </span>
            </p>
          )}

          {/* WHERE the bytes are. A single total invites "is that even right?";
              an itemized breakdown with object counts and a newest-file stamp
              is the receipt that answers it. */}
          {stats.r2Real && (stats.r2Real.segments?.length ?? 0) > 0 && (
            <details className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                Where the files are
              </summary>
              <div className="mt-2.5" />
              <div className="space-y-2">
                {stats.r2Real.segments!.map((s) => {
                  const share = stats.r2Real!.bytes > 0
                    ? Math.round((s.bytes / stats.r2Real!.bytes) * 100) : 0;
                  return (
                    <div key={s.label}>
                      <div className="flex items-baseline justify-between gap-2 text-[11px]">
                        <span className="font-bold text-[var(--color-text)] truncate">{s.label}</span>
                        <span className="text-[var(--color-text-muted)] shrink-0 tabular-nums">
                          {fmtBytes(s.bytes)} · {fmtNum(s.objects)} files
                          {s.newest && <> · newest {new Date(s.newest).toLocaleDateString()}</>}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                        <div className="h-full rounded-full bg-[var(--color-text-muted)]" style={{ width: `${Math.max(1, share)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2.5 text-[11px] text-[var(--color-text-faint)]">
                These add up to the measured total. If a batch you just uploaded is missing, its row&apos;s
                newest date shows whether the files landed.
              </p>
            </details>
          )}

          {/* ── Plan headroom: REAL usage vs the hosting plan's ceilings ──── */}
          {stats.freeTier && (
            <details className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5" open={stats.freeTier.dbBand !== "ok" || stats.r2Real?.band === "warn" || stats.r2Real?.band === "crit"}>
              <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                Hosting plan limits
              </summary>
              <div className="space-y-3 mt-2.5">
                {stats.r2Real && (
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="font-bold text-[var(--color-text)]">Cloudflare R2 (files)</span>
                      <span className={`font-black ${stats.r2Real.band === "crit" ? "text-red-600" : stats.r2Real.band === "warn" ? "text-amber-600" : "text-emerald-700 dark:text-emerald-400"}`}>
                        {fmtBytes(stats.r2Real.bytes)} of {fmtBytes(stats.freeTier.r2LimitBytes)} · {stats.r2Real.pct}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                      <div className={`h-full rounded-full ${stats.r2Real.band === "crit" ? "bg-red-500" : stats.r2Real.band === "warn" ? "bg-amber-500" : "bg-emerald-500"}`}
                        style={{ width: `${Math.min(100, Math.max(1, stats.r2Real.pct))}%` }} />
                    </div>
                  </div>
                )}
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="font-bold text-[var(--color-text)]">Supabase (database)</span>
                    <span className={`font-black ${stats.freeTier.dbBand === "crit" ? "text-red-600" : stats.freeTier.dbBand === "warn" ? "text-amber-600" : "text-emerald-700 dark:text-emerald-400"}`}>
                      {fmtBytes(stats.db.totalBytes)} of {fmtBytes(stats.freeTier.dbLimitBytes)} · {stats.freeTier.dbPct}%
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                    <div className={`h-full rounded-full ${stats.freeTier.dbBand === "crit" ? "bg-red-500" : stats.freeTier.dbBand === "warn" ? "bg-amber-500" : "bg-emerald-500"}`}
                      style={{ width: `${Math.min(100, Math.max(1, stats.freeTier.dbPct))}%` }} />
                  </div>
                </div>
              </div>
              {editingLimits ? (
                <div className="mt-2.5 flex items-center gap-2 flex-wrap text-[11px]">
                  <span className="text-[var(--color-text-muted)] font-bold">R2 (GB):</span>
                  <input value={r2LimitDraft} onChange={(e) => setR2LimitDraft(e.target.value)} inputMode="decimal"
                    className="w-16 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] px-2 py-1 font-mono" />
                  <span className="text-[var(--color-text-muted)] font-bold">Database (MB):</span>
                  <input value={dbLimitDraft} onChange={(e) => setDbLimitDraft(e.target.value)} inputMode="decimal"
                    className="w-16 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] px-2 py-1 font-mono" />
                  <button onClick={() => void saveLimits()} disabled={savingLimits}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">
                    {savingLimits ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Save limits
                  </button>
                  <button onClick={() => setEditingLimits(false)} className="text-[var(--color-text-muted)] font-bold">Cancel</button>
                </div>
              ) : (
                <p className="mt-2.5 text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                  Use is measured. The limits are your hosting plan&apos;s
                  {stats.freeTier.source === "settings"
                    ? " (set by an admin here)"
                    : " (the free tiers until changed: R2 10 GB, Supabase 500 MB)"}.
                  Admins get a notification at 70% and 90%.{" "}
                  <button onClick={() => {
                    setR2LimitDraft(String(Math.round((stats.freeTier!.r2LimitBytes / 1024 ** 3) * 10) / 10));
                    setDbLimitDraft(String(Math.round(stats.freeTier!.dbLimitBytes / 1024 ** 2)));
                    setEditingLimits(true);
                  }} className="font-bold text-[var(--color-accent-text)] hover:underline">
                    {stats.freeTier.source === "settings" ? "Change plan limits" : "Upgraded your plan? Set the real limits"}
                  </button>
                </p>
              )}
            </details>
          )}

          {/* ── Orphaned files: bucket objects nothing references ─────────── */}
          <details className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5" open={!!orphanScan || !!orphanMsg}>
            <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Orphaned files</summary>
            <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  Files in storage that nothing uses, like knowledge PDFs you deleted. Scanning changes nothing.
                  Deleting checks each file again and never touches anything newer than 7 days.
                </p>
              </div>
              <button onClick={() => void scanOrphanFiles()} disabled={orphanBusy !== null}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-all">
                {orphanBusy === "scan" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Scan
              </button>
            </div>
            {orphanMsg && (
              <div role="status" className={`mt-2 text-[11px] font-bold ${orphanMsg.warn ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>{orphanMsg.text}</div>
            )}
            {orphanScan && (
              orphanScan.orphans.length === 0 ? (
                <div className="mt-2 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                  Clean: all {fmtNum(orphanScan.totalObjects)} files in storage are in use.
                  {orphanScan.skippedYoung > 0 && ` (${orphanScan.skippedYoung} too new to judge yet.)`}
                </div>
              ) : (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm font-black text-[var(--color-text)]">
                      {fmtBytes(orphanScan.orphanBytes)} reclaimable
                    </span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      {fmtNum(orphanScan.orphans.length)} orphan(s) · {fmtNum(orphanScan.referencedKeys)} referenced keys checked
                      {orphanScan.skippedYoung > 0 && ` · ${orphanScan.skippedYoung} skipped (under 7 days old)`}
                    </span>
                    <button onClick={() => void purgeOrphanFiles()} disabled={orphanBusy !== null}
                      className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-red-300 dark:border-red-900 text-red-700 dark:text-red-400 bg-[var(--color-surface)] hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50 transition-all">
                      {orphanBusy === "delete" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      Delete orphans, free {fmtBytes(orphanScan.orphanBytes)}
                    </button>
                  </div>
                  <ul className="max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] text-[11px]">
                    {orphanScan.orphans.slice(0, 50).map((o) => (
                      <li key={o.key} className="px-2.5 py-1 flex items-center gap-2">
                        <span className="truncate flex-1 font-mono text-[var(--color-text-muted)]" title={o.key}>{o.key}</span>
                        <span className="shrink-0 tabular-nums font-bold text-[var(--color-text)]">{fmtBytes(o.size)}</span>
                      </li>
                    ))}
                    {orphanScan.orphans.length > 50 && (
                      <li className="px-2.5 py-1 text-[var(--color-text-muted)] italic">…and {fmtNum(orphanScan.orphans.length - 50)} more</li>
                    )}
                  </ul>
                </div>
              )
            )}
          </details>

          {/* ── Category breakdown: purge vs keep vs reference ───────────── */}
          <details className="group/cat rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
            <summary className="cursor-pointer mb-2 text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Database by kind: what can go, what stays</summary>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(["purge", "archive", "reference"] as DataClass[]).map((cat) => {
              const M = CATEGORY_META[cat];
              const Icon = M.icon;
              const bytes = byCat[cat] ?? 0;
              const share = stats.db.totalBytes > 0 ? Math.round((bytes / stats.db.totalBytes) * 100) : 0;
              return (
                <div key={cat} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                  <div className={`flex items-center gap-2 text-xs font-bold mb-1 ${M.tint}`}>
                    <Icon className="w-4 h-4" /> {CATEGORY_LABEL[cat]}
                  </div>
                  <div className="text-[15px] font-bold text-[var(--color-text)]">{fmtBytes(bytes)}</div>
                  <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden my-1.5">
                    <div className={`h-full rounded-full ${M.bar}`} style={{ width: `${Math.max(1, share)}%` }} />
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{M.blurb}</div>
                </div>
              );
            })}
          </div>
          </details>

          {/* ── Free up space (purge) ────────────────────────────────────── */}
          {canPurge ? (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                  <Recycle className="w-4 h-4" /> Free up space
                  <span className="text-[11px] font-medium text-[var(--color-text-muted)]">· your workspace · byproducts only</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-[var(--color-text-muted)]">older than</span>
                  <select
                    value={purgeDays}
                    onChange={(e) => setPurgeDays(Number(e.target.value))}
                    className="text-xs font-bold rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-text)]"
                  >
                    {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
                  </select>
                </div>
              </div>

              <div className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden mb-3">
                {readErrors.purge ? (
                  <div role="alert" className="px-3 py-3 text-xs text-red-700 dark:text-red-400">
                    Couldn&apos;t check what can be purged: {readErrors.purge}{" "}
                    <button type="button" onClick={() => void loadPreview(purgeDays)} className="font-bold underline">Try again</button>
                  </div>
                ) : previewLoading && !preview ? (
                  <div className="px-3 py-3 text-xs text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking what can be purged…</div>
                ) : (preview?.targets ?? []).map((t) => (
                  <div key={t.table} className="px-3 py-2 flex items-center gap-3" title={t.reason}>
                    <Recycle className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-[var(--color-text)]">{t.label}</div>
                      <div className="text-[11px] text-[var(--color-text-muted)] font-mono truncate">{t.table}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-bold text-[var(--color-text)]">{fmtNum(t.rows)} rows</div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">≈{fmtBytes(t.estBytes)}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-[11px] text-[var(--color-text-muted)] max-w-md">
                  {preview && preview.totalRows > 0
                    ? <>Frees about <b className="text-[var(--color-text)]">{fmtBytes(preview.totalEstBytes)}</b> across {fmtNum(preview.totalRows)} rows. It&apos;s written to the audit log.</>
                    : readErrors.purge ? "" : "Nothing old enough to purge in this window."}
                </div>
                <button
                  onClick={() => void runPurge()}
                  disabled={purging || !preview || preview.totalRows === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 transition-colors"
                >
                  {purging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Purge {preview && preview.totalRows > 0 ? `${fmtNum(preview.totalRows)} rows` : "now"}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5 text-xs text-[var(--color-text-muted)] flex items-center gap-2">
              <Lock className="w-4 h-4 shrink-0" /> Only Admin and Doc Control can free up space. You can still see usage and download backups.
            </div>
          )}

          {/* ── Archive for space (the shed) ─────────────────────────────── */}
          {canPurge && (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)]">
                  <Archive className="w-4 h-4 text-[var(--color-text-muted)]" /> Archive older revision history for space
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-[var(--color-text-muted)]">keep last</span>
                  <select value={shedKeep} onChange={(e) => setShedKeep(Number(e.target.value))}
                    className="text-xs font-bold rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-text)]">
                    {[3, 5, 10, 20].map((d) => <option key={d} value={d}>{d} revisions</option>)}
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)] mb-3 max-w-2xl">
                Keeps the <b>last {shedKeep} revisions</b> of every document live and moves the files of older ones into one offline archive. Each revision&apos;s record, checksum and reason stay. Only the file moves. The current revision is never touched.
              </p>

              {readErrors.shed ? (
                <div role="alert" className="text-[11px] text-red-700 dark:text-red-400">
                  Couldn&apos;t check older revisions: {readErrors.shed}{" "}
                  <button type="button" onClick={() => void loadShedPreview(shedKeep)} className="font-bold underline">Try again</button>
                </div>
              ) : shedPreview && shedPreview.selectedCount > 0 ? (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    <b className="text-[var(--color-text)]">{fmtNum(shedPreview.selectedCount)}</b> superseded file(s) · reclaim ≈<b className="text-[var(--color-text)]">{fmtBytes(shedPreview.reclaimableBytes)}</b>
                    {(shedPreview.remainingCount ?? 0) > 0 && <> · <b className="text-amber-700 dark:text-amber-400">{fmtNum(shedPreview.remainingCount!)} more</b> past this archive&apos;s size limit. Build again after reclaiming.</>}
                    {archiveRoot && <> → save to <span className="font-mono break-all">{subfolder(archiveRoot, "data")}&lt;id&gt;.zip</span></>}
                  </div>
                  <button onClick={() => void produceArchive()} disabled={shedBusy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">
                    {shedBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />} Build &amp; download archive
                  </button>
                </div>
              ) : (
                <div className="text-[11px] text-[var(--color-text-muted)]">{shedPreview ? `No document has more than ${shedKeep} revisions, so there's nothing older to archive yet.` : <span className="inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Checking older revisions…</span>}</div>
              )}

              {pendingArchive && (
                <div className="mt-3 border-l-2 border-amber-500 pl-3">
                  <div className="text-[11px] text-amber-800 dark:text-amber-300 font-bold mb-1 flex items-center gap-1.5"><FolderArchive className="w-3.5 h-3.5" /> Step 2 of 2: reclaim the space</div>
                  <div className="text-[11px] text-[var(--color-text)] mb-2">
                    First save <span className="font-mono">{pendingArchive.archiveId}.zip</span> to <span className="font-mono break-all">{archiveRoot ? subfolder(archiveRoot, "data") : "<root>/data/"}</span>. Then reclaim about {fmtBytes(pendingArchive.bytes)} from live storage. Until you do, the files stay online.
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => void commitArchive()} disabled={committing}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-red-300 dark:border-red-900 text-red-700 dark:text-red-400 bg-[var(--color-surface)] hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40">
                      {committing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} I saved it, reclaim {fmtBytes(pendingArchive.bytes)}
                    </button>
                    <button onClick={() => void cancelPending(pendingArchive.archiveId, "doc")} disabled={committing} className="text-[11px] font-bold text-[var(--color-text-muted)] hover:text-red-600">Discard</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Archive closed tickets for space ─────────────────────────── */}
          {canPurge && (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)]">
                  <Archive className="w-4 h-4 text-[var(--color-text-muted)]" /> Archive closed tickets for space
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-[var(--color-text-muted)]">closed over</span>
                  <select value={ticketDays} onChange={(e) => setTicketDays(Number(e.target.value))}
                    className="text-xs font-bold rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-text)]">
                    {[90, 180, 365, 730].map((d) => <option key={d} value={d}>{d} days</option>)}
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)] mb-3 max-w-2xl">
                Moves <b>long-closed tickets</b> (comments, history and attachments) into one offline archive and leaves a small stub in the list. Opening a stub asks for the archive, and one restore brings it all back. Only <b>closed or canceled</b> tickets. Open requests are never touched.
              </p>

              {readErrors.ticket ? (
                <div role="alert" className="text-[11px] text-red-700 dark:text-red-400">
                  Couldn&apos;t check closed tickets: {readErrors.ticket}{" "}
                  <button type="button" onClick={() => void loadTicketShedPreview(ticketDays)} className="font-bold underline">Try again</button>
                </div>
              ) : ticketPreview && ticketPreview.selectedCount > 0 ? (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    <b className="text-[var(--color-text)]">{fmtNum(ticketPreview.selectedCount)}</b> closed ticket(s) · reclaim ≈<b className="text-[var(--color-text)]">{fmtBytes(ticketPreview.reclaimableBytes)}</b> of attachments
                    {archiveRoot && <> → save to <span className="font-mono break-all">{subfolder(archiveRoot, "data")}&lt;id&gt;.zip</span></>}
                  </div>
                  <button onClick={() => void produceTicketArchive()} disabled={ticketBusy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">
                    {ticketBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />} Build &amp; download archive
                  </button>
                </div>
              ) : (
                <div className="text-[11px] text-[var(--color-text-muted)]">{ticketPreview ? `No ticket has been closed longer than ${ticketDays} days, so there's nothing to archive yet.` : <span className="inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Checking closed tickets…</span>}</div>
              )}

              {pendingTicketArchive && (
                <div className="mt-3 border-l-2 border-amber-500 pl-3">
                  <div className="text-[11px] text-amber-800 dark:text-amber-300 font-bold mb-1 flex items-center gap-1.5"><FolderArchive className="w-3.5 h-3.5" /> Step 2 of 2: reclaim the space</div>
                  <div className="text-[11px] text-[var(--color-text)] mb-2">
                    First save <span className="font-mono">{pendingTicketArchive.archiveId}.zip</span> to <span className="font-mono break-all">{archiveRoot ? subfolder(archiveRoot, "data") : "<root>/data/"}</span>. Then move {pendingTicketArchive.tickets} ticket(s) to the archive and reclaim about {fmtBytes(pendingTicketArchive.bytes)}. Until you do, everything stays online.
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => void commitTicketArchive()} disabled={ticketCommitting}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-red-300 dark:border-red-900 text-red-700 dark:text-red-400 bg-[var(--color-surface)] hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40">
                      {ticketCommitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} I saved it, reclaim {fmtBytes(pendingTicketArchive.bytes)}
                    </button>
                    <button onClick={() => void cancelPending(pendingTicketArchive.archiveId, "ticket")} disabled={ticketCommitting} className="text-[11px] font-bold text-[var(--color-text-muted)] hover:text-red-600">Discard</button>
                  </div>
                </div>
              )}

              <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex items-center justify-between gap-3 flex-wrap">
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  Bringing closed tickets back? Restore their comments, history and files from the saved archive.
                </div>
                <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] cursor-pointer ${ticketRestoreBusy ? "opacity-40 pointer-events-none" : ""}`}>
                  {ticketRestoreBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderArchive className="w-3.5 h-3.5" />} Restore from archive…
                  <input type="file" accept=".zip" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void restoreTicketsFromArchive(f); e.currentTarget.value = ""; }} />
                </label>
              </div>
              {ticketRestoreFile && (
                <div className="mt-2 flex items-center gap-2.5">
                  <FileThumb file={ticketRestoreFile} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11px] font-bold text-[var(--color-text)] truncate">{ticketRestoreFile.name}</span>
                    <span className="block text-[11px] text-[var(--color-text-muted)]">
                      {fmtBytes(ticketRestoreFile.size)}
                      {ticketRestoreBusy && <span className="inline-flex items-center gap-1 ml-2"><Loader2 className="w-3 h-3 animate-spin" /> Uploading and restoring…</span>}
                    </span>
                  </span>
                  {!ticketRestoreBusy && (
                    <button type="button" onClick={() => void restoreTicketsFromArchive(ticketRestoreFile)}
                      className="shrink-0 px-2 py-1 rounded-md border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                      Try again
                    </button>
                  )}
                </div>
              )}
              {ticketRestoreMsg && <div role="status" className={`mt-2 text-[11px] font-bold ${ticketRestoreMsg.warn ? "text-amber-700 dark:text-amber-400" : "text-[var(--color-text)]"}`}>{ticketRestoreMsg.text}</div>}
            </div>
          )}

          {/* ── Offline archive catalog ──────────────────────────────────── */}
          {canPurge && readErrors.catalog && (
            <p role="alert" className="px-1 border-l-2 border-red-500 pl-3 text-[13px] text-red-700 dark:text-red-400">
              Couldn&apos;t load the offline archive catalog: {readErrors.catalog}{" "}
              <button type="button" onClick={() => void loadCatalog()} className="font-bold underline">Try again</button>
            </p>
          )}
          {canPurge && catalog && catalog.length > 0 && (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)]">
                  <FolderArchive className="w-4 h-4 text-[var(--color-text-muted)]" /> Offline archive catalog
                </div>
                <button onClick={() => void loadCatalog()} title="Refresh" aria-label="Refresh the catalog"
                  className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)] mb-3 max-w-2xl">
                Every archive this workspace has made, and where each stands. One that stopped before
                <b> “I saved it, reclaim”</b> (closed tab, crash) shows as <b>awaiting reclaim</b>. Running Reclaim again is
                safe: it retries any deletes that failed.
              </p>

              {catalogMsg && (
                <div role="status" className={`mb-3 border-l-2 pl-2.5 text-[11px] font-bold ${catalogMsg.warn ? "border-amber-500 text-amber-800 dark:text-amber-300" : "border-emerald-500 text-emerald-700 dark:text-emerald-300"}`}>
                  {catalogMsg.warn ? <AlertTriangle className="w-3.5 h-3.5 inline -mt-0.5 mr-1" /> : <CheckCircle2 className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />}
                  {catalogMsg.text}
                </div>
              )}

              <div className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] overflow-hidden">
                {catalog.map((row) => {
                  const busy = catalogBusyId === row.archiveId;
                  const isTicket = row.ticketPending + row.ticketCommitted > 0;
                  const chip =
                    row.status === "producing" ? { cls: "text-red-700 dark:text-red-400", label: "never finished building" } :
                    row.status === "pending" ? { cls: "text-amber-700 dark:text-amber-400", label: "awaiting reclaim, still billed" } :
                    row.status === "committed" ? { cls: "text-emerald-700 dark:text-emerald-400", label: "reclaimed, the zip is the only copy" } :
                    row.status === "full" ? { cls: "text-[var(--color-text-muted)]", label: "full backup" } :
                    { cls: "text-[var(--color-text-faint)]", label: "no linked rows" };
                  return (
                    <div key={row.archiveId} className="px-3 py-2.5 flex items-center gap-3 flex-wrap bg-[var(--color-surface)]">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-bold text-[var(--color-text)]">{row.archiveId}</span>
                          <span className={`text-[11px] font-bold ${chip.cls}`}>{chip.label}</span>
                          <span className="text-[11px] text-[var(--color-text-faint)]">{row.kind === "full" ? "full backup" : isTicket ? "closed tickets" : "revision history"}</span>
                        </div>
                        <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                          {row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}
                          {row.createdByEmail ? <> · by {row.createdByEmail}</> : null}
                          {row.fileCount > 0 && <> · {fmtNum(row.fileCount)} file(s), {fmtBytes(row.totalBytes)}</>}
                          {row.status === "pending" && (
                            <> · pending: {row.docPending > 0 ? `${fmtNum(row.docPending)} revision(s)` : `${fmtNum(row.ticketPending)} ticket(s)`}</>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button onClick={() => void copyArchivePath(row)} title="Copy the conventional save path for this archive"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                          <Copy className="w-3 h-3" /> {copiedArchiveId === row.archiveId ? "Copied" : "Path"}
                        </button>
                        {row.status === "pending" && (
                          <button onClick={() => void commitFromCatalog(row)} disabled={busy}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border border-red-300 dark:border-red-900 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40">
                            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} I saved it, reclaim
                          </button>
                        )}
                        {(row.status === "pending" || row.status === "producing" || row.status === "empty") && (
                          <button onClick={() => void cancelPending(row.archiveId, isTicket ? "ticket" : "doc")} disabled={busy}
                            className="px-2 py-1 rounded-lg text-[11px] font-bold text-[var(--color-text-muted)] hover:text-red-600">
                            Discard
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Backup (records + binaries) ──────────────────────────────── */}
          <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
            <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)] mb-1">
              <ShieldCheck className="w-4 h-4 text-[var(--color-text-muted)]" /> Backup and restore
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] mb-3 max-w-2xl">
              The full backup (top of the page) holds every record <b>and</b> every file (PDF, DWG, photo), so you can
              rebuild from nothing. Take one every quarter.
            </p>
            {canPurge && readErrors.settings && (
              <p role="alert" className="mb-3 text-[11px] text-red-700 dark:text-red-400">
                Couldn&apos;t load the archive settings: {readErrors.settings}{" "}
                <button type="button" onClick={() => void loadArchiveSettings()} className="font-bold underline">Try again</button>
              </p>
            )}

            {/* Archive root folder — one place, shared, with a fixed convention underneath */}
            {canPurge && (
              <div className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 mb-3 ${archiveRoot || editingLoc ? "" : "border-l-2 border-l-amber-500"}`}>
                {!editingLoc && archiveRoot ? (
                  <div className="flex items-start gap-2">
                    <FolderArchive className="w-4 h-4 text-[var(--color-text-muted)] mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0 text-[11px]">
                      <div className="text-[var(--color-text)]"><b>Archive root:</b> <span className="font-mono break-all">{archiveRoot}</span></div>
                      <div className="text-[var(--color-text-muted)] mt-1 leading-relaxed">
                        Full backups → <span className="font-mono break-all">{subfolder(archiveRoot, "full-backups")}</span><br />
                        Space-saver exports → <span className="font-mono break-all">{subfolder(archiveRoot, "data")}</span>
                      </div>
                      {finderNote && <div className="text-[var(--color-text-muted)] mt-1"><b>Finder note:</b> {finderNote}</div>}
                      <div className="text-[var(--color-text-faint)] mt-1">Anyone asked to view an archived file is pointed to the exact path under here{finderNote ? ", plus your note" : ""}.</div>
                    </div>
                    <button onClick={() => setEditingLoc(true)} className="text-[11px] font-bold text-[var(--color-accent-text)] hover:underline shrink-0">Edit</button>
                  </div>
                ) : (
                  <div>
                    <div className={`flex items-center gap-1.5 text-[11px] font-bold mb-1 ${archiveRoot ? "text-[var(--color-text)]" : "text-amber-800 dark:text-amber-300"}`}>
                      <FolderArchive className="w-4 h-4 shrink-0" /> Set your archive root folder
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mb-2 leading-relaxed">
                      One folder, shared with your team. Full backups go in <span className="font-mono">/full-backups</span>, space-saver exports in <span className="font-mono">/data</span>. People are told to fetch archives from there.
                    </div>
                    <div className="space-y-2">
                      <input value={locDraft} onChange={(e) => setLocDraft(e.target.value)} placeholder="e.g.  \\fileserver\drafting\mos-archives   or   /Volumes/Backups/MOS"
                        className="w-full text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-[var(--color-text)] font-mono" />
                      <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Optional finder note, e.g. “ask IT for access to the DC-3 share”"
                        className="w-full text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-[var(--color-text)]" />
                      {locDraft.trim() && (
                        <div className="text-[11px] text-[var(--color-text-muted)] break-all">Users will be told: <span className="font-mono">{subfolder(locDraft, "data")}&lt;archive-id&gt;.zip</span>{noteDraft.trim() ? <> ({noteDraft.trim()})</> : null}</div>
                      )}
                      <div className="flex items-center gap-2">
                        <button onClick={() => void saveArchiveLoc()} disabled={savingLoc || !locDraft.trim()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">
                          {savingLoc ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Save root
                        </button>
                        {archiveRoot && (
                          <button onClick={() => { setEditingLoc(false); setLocDraft(archiveRoot || ""); }}
                            className="text-[11px] font-bold text-[var(--color-text-muted)]">Cancel</button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={() => void downloadJson()} disabled={busyJson || !activeOrgId}
              className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors"
            >
              {busyJson ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileJson className="w-4 h-4" />}
              Records only (JSON)
            </button>
            <div className="mt-3 space-y-2 text-[11px]">
              <div className="flex items-center gap-4 flex-wrap">
                <Link href="/admin/archive-view" className="inline-flex items-center gap-1.5 font-bold text-[var(--color-accent-text)] hover:underline">
                  <Archive className="w-3.5 h-3.5" /> View from a backup →
                </Link>
                <Link href="/admin/restore" className="inline-flex items-center gap-1.5 font-bold text-[var(--color-accent-text)] hover:underline">
                  <UploadCloud className="w-3.5 h-3.5" /> Restore from a backup →
                </Link>
                <Link href="/admin/data-export" className="inline-flex items-center gap-1.5 font-bold text-[var(--color-accent-text)] hover:underline">
                  <ServerCog className="w-3.5 h-3.5" /> Scheduled push to your own bucket →
                </Link>
              </div>
            </div>
          </div>

          {/* ── Dedup opportunity ────────────────────────────────────────── */}
          {stats.dedup && stats.dedup.totalVersions > 0 && (
            <details className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <summary className="cursor-pointer flex items-center gap-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-xs font-bold uppercase tracking-widest mb-2">
                <Copy className="w-3.5 h-3.5" /> Duplicate revision files
              </summary>
              <div className="flex items-center gap-6 flex-wrap">
                <div>
                  <div className="text-[15px] font-bold text-[var(--color-text)]">~{fmtBytes(stats.dedup.reclaimableBytes)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">stored more than once</div>
                </div>
                <div>
                  <div className="text-[15px] font-bold text-[var(--color-text)]">{fmtNum(stats.dedup.dupGroups)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">files stored 2+ times</div>
                </div>
                <div className="flex-1 min-w-[12rem] text-[11px] text-[var(--color-text-faint)] leading-relaxed">
                  Identical files are each stored on their own. This is measured only; nothing here changes them.
                </div>
              </div>
            </details>
          )}

          {/* ── AI usage ─────────────────────────────────────────────────── */}
          <details className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
            <summary className="cursor-pointer flex items-center gap-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-xs font-bold uppercase tracking-widest mb-2">
              <Sparkles className="w-3.5 h-3.5" /> AI usage (shared key)
            </summary>
            {stats.ai ? (
              <div className="flex items-center gap-6 flex-wrap">
                <div>
                  <div className="text-[15px] font-bold text-[var(--color-text)]">{fmtNum(stats.ai.last24h)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">calls · last 24h</div>
                </div>
                <div>
                  <div className="text-[15px] font-bold text-[var(--color-text)]">{fmtNum(stats.ai.last30d)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">calls · last 30d</div>
                </div>
                <div className="flex-1 min-w-[12rem] text-[11px] text-[var(--color-text-faint)] leading-relaxed">
                  The free Gemini tier allows about 10 calls a minute and 1,000 a day, shared by everyone.
                </div>
              </div>
            ) : (
              <div className="text-xs text-[var(--color-text-muted)]">
                AI use isn&apos;t being counted yet. Apply migration <span className="font-mono">20260806</span>.
              </div>
            )}
          </details>

          {/* ── Ticket design-issue callout ──────────────────────────────── */}
          {/* ── Tables by size ───────────────────────────────────────────── */}
          <details className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden">
            <summary className="cursor-pointer px-4 sm:px-5 py-3.5 border-b border-[var(--color-border)] flex items-center justify-between flex-wrap gap-2">
              <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Tables by size</span>
              <span className="text-[11px] font-medium text-[var(--color-text-faint)] inline-flex items-center gap-2">
                <span className="inline-flex items-center gap-1"><Recycle className="w-3 h-3 text-emerald-500" /> purge</span>
                <span className="inline-flex items-center gap-1"><Archive className="w-3 h-3 text-amber-500" /> keep</span>
                <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3 text-[var(--color-text-muted)]" /> ref</span>
                <span className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-amber-500" /> grower</span>
                <span className="text-[var(--color-text-muted)]">· hover a row for why</span>
              </span>
            </summary>
            {ticketRow && (
              <p className="px-4 py-2 border-b border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                <b className="text-[var(--color-text)]">Why “{ticketRow.name}” is heavy per row:</b> {ticketRow.reason}
              </p>
            )}
            <div className="divide-y divide-[var(--color-border)]">
              {tables.slice(0, 30).map((t) => {
                const M = CATEGORY_META[t.category];
                const Icon = M.icon;
                return (
                  <div key={t.name} className="px-4 py-2 flex items-center gap-3 cursor-help" title={`${CATEGORY_LABEL[t.category]}: ${t.reason}`}>
                    <div className="w-40 sm:w-56 min-w-0 flex items-center gap-1.5">
                      <Icon className={`w-3.5 h-3.5 shrink-0 ${M.tint}`} />
                      {t.grower && <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />}
                      <span className="font-mono text-xs text-[var(--color-text)] truncate">{t.name}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                        <div className={`h-full rounded-full ${M.bar}`} style={{ width: `${maxBytes > 0 ? Math.max(2, (t.bytes / maxBytes) * 100) : 0}%` }} />
                      </div>
                    </div>
                    <div className="w-20 text-right text-xs font-bold text-[var(--color-text)]">{fmtBytes(t.bytes)}</div>
                    <div className="w-24 text-right text-[11px] text-[var(--color-text-muted)]">{fmtNum(t.rows)} rows</div>
                  </div>
                );
              })}
            </div>
          </details>

          <p className="px-1 text-[12px] text-[var(--color-text-muted)] leading-relaxed">{stats.note} Snapshot {new Date(stats.generatedAt).toLocaleString()}.</p>
        </>
      ) : null}
      </PageBody>
    </PageShell>
  );
}
