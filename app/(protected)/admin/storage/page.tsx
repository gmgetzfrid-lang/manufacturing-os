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
  ArrowLeft, Database, HardDrive, AlertTriangle, RefreshCw, Loader2, Gauge,
  Sparkles, Copy, Trash2, ShieldCheck, FileJson, FileArchive,
  Archive, Recycle, Lock, Info, CheckCircle2, ServerCog, UploadCloud, FolderArchive,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { CATEGORY_LABEL, type DataClass } from "@/lib/storageClassify";
import { appConfirm } from "@/components/providers/DialogProvider";

interface TableRow {
  name: string; rows: number; bytes: number;
  category: DataClass; reason: string; grower: boolean;
}
interface Stats {
  generatedAt: string;
  db: { totalBytes: number; tables: TableRow[]; byCategory: Record<DataClass, number> };
  r2Estimate: { totalBytes: number; versionsBytes: number; photosBytes: number; versionCount: number; photoCount: number };
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
    blurb: "Disposable byproducts. Safe to delete once aged — no records lost.",
  },
  archive: {
    icon: Archive, tint: "text-amber-600", bar: "bg-amber-500",
    blurb: "Real records. Never deleted — kept hot, then archived off-box (saved locally) when cold.",
  },
  reference: {
    icon: ShieldCheck, tint: "text-sky-600", bar: "bg-sky-500",
    blurb: "Small config / lookup data. Kept hot; not a cost concern.",
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
  const [shedPreview, setShedPreview] = useState<{ selectedCount: number; reclaimableBytes: number; eligibleCount: number } | null>(null);
  const [shedBusy, setShedBusy] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<{ archiveId: string; files: string; bytes: number } | null>(null);
  const [committing, setCommitting] = useState(false);

  // Closed-ticket space-saver (archive whole closed tickets; keep a stub in the list)
  const [ticketDays, setTicketDays] = useState(365);
  const [ticketPreview, setTicketPreview] = useState<{ selectedCount: number; reclaimableBytes: number; eligibleCount: number } | null>(null);
  const [ticketBusy, setTicketBusy] = useState(false);
  const [pendingTicketArchive, setPendingTicketArchive] = useState<{ archiveId: string; tickets: string; files: string; bytes: number } | null>(null);
  const [ticketCommitting, setTicketCommitting] = useState(false);

  // Backup state
  const [busyJson, setBusyJson] = useState(false);
  const [busyZip, setBusyZip] = useState(false);
  const [lastArchiveId, setLastArchiveId] = useState<string | null>(null);

  // Designated archive location (where the org keeps its offline backups).
  const [archiveRoot, setArchiveRoot] = useState<string | null>(null);
  const [editingLoc, setEditingLoc] = useState(false);
  const [locDraft, setLocDraft] = useState("");
  const [savingLoc, setSavingLoc] = useState(false);

  // Real storage quota (drives the watermark + cron admin alerts)
  const [quotaBytes, setQuotaBytes] = useState<number | null>(null);
  const [editingQuota, setEditingQuota] = useState(false);
  const [quotaDraft, setQuotaDraft] = useState("");
  const [savingQuota, setSavingQuota] = useState(false);

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
      if (res.ok) setPreview(body as PurgePreview);
    } catch { /* preview is best-effort */ }
    finally { setPreviewLoading(false); }
  }, [activeOrgId, canPurge, authToken]);

  const loadArchiveSettings = useCallback(async () => {
    if (!activeOrgId || !canPurge) return;
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/archive-settings?orgId=${encodeURIComponent(activeOrgId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.settings) {
        setArchiveRoot(body.settings.location_hint || null);
        setLocDraft(body.settings.location_hint || "");
        setQuotaBytes(body.settings.quota_bytes ?? null);
        setQuotaDraft(body.settings.quota_bytes ? String(Math.round((body.settings.quota_bytes / (1024 ** 3)) * 10) / 10) : "");
      }
    } catch { /* best-effort */ }
  }, [activeOrgId, canPurge, authToken]);

  const loadShedPreview = useCallback(async (keep: number) => {
    if (!activeOrgId || !canPurge) return;
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/shed?orgId=${encodeURIComponent(activeOrgId)}&keep=${keep}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (res.ok) setShedPreview(body);
    } catch { /* best-effort */ }
  }, [activeOrgId, canPurge, authToken]);

  const loadTicketShedPreview = useCallback(async (days: number) => {
    if (!activeOrgId || !canPurge) return;
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/ticket-shed?orgId=${encodeURIComponent(activeOrgId)}&days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (res.ok) setTicketPreview(body);
    } catch { /* best-effort */ }
  }, [activeOrgId, canPurge, authToken]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadPreview(purgeDays); }, [loadPreview, purgeDays]);
  useEffect(() => { void loadArchiveSettings(); }, [loadArchiveSettings]);
  useEffect(() => { void loadShedPreview(shedKeep); }, [loadShedPreview, shedKeep]);
  useEffect(() => { void loadTicketShedPreview(ticketDays); }, [loadTicketShedPreview, ticketDays]);

  const saveArchiveLoc = async () => {
    if (!activeOrgId) return;
    setSavingLoc(true); setError(null);
    try {
      const token = await authToken();
      const res = await fetch(`/api/admin/archive-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, locationHint: locDraft }),
      });
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
      setArchiveRoot(locDraft.trim() || null);
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
      message: `Bundle ${fmtNum(shedPreview.selectedCount)} superseded revision file(s) (≈${fmtBytes(shedPreview.reclaimableBytes)}) into one offline archive zip? Nothing is deleted yet — you confirm the reclaim after saving it.`,
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
      if (archiveId) setPendingArchive({ archiveId, files, bytes });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setShedBusy(false);
    }
  };

  const commitArchive = async () => {
    if (!activeOrgId || !pendingArchive) return;
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
      await Promise.all([load(), loadShedPreview(shedKeep)]);
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
      message: `Bundle ${fmtNum(ticketPreview.selectedCount)} closed ticket(s) — comments, history and attachments (≈${fmtBytes(ticketPreview.reclaimableBytes)}) — into one offline archive zip? Each leaves a lightweight stub in the list. Nothing is deleted yet — you confirm the reclaim after saving it.`,
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
      if (archiveId) setPendingTicketArchive({ archiveId, tickets, files, bytes });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTicketBusy(false);
    }
  };

  const commitTicketArchive = async () => {
    if (!activeOrgId || !pendingTicketArchive) return;
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
      await Promise.all([load(), loadTicketShedPreview(ticketDays)]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTicketCommitting(false);
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
  const usedBytes = (stats?.db.totalBytes ?? 0) + (stats?.r2Estimate.totalBytes ?? 0);
  const pct = Math.min(100, Math.round((usedBytes / budgetBytes) * 100));
  const health: "ok" | "warn" | "crit" = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok";
  const byCat = stats?.db.byCategory ?? { purge: 0, archive: 0, reference: 0 };
  const reclaimNow = (preview?.totalEstBytes ?? 0) + (stats?.dedup?.reclaimableBytes ?? 0);
  const ticketRow = tables.find((t) => t.name === "tickets");

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-start gap-3 mb-5">
        <Link href="/dashboard" className="p-2 mt-1 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-black text-[var(--color-text)] flex items-center gap-2">
            <Gauge className="w-5 h-5 text-[var(--color-accent)]" /> Storage, Usage &amp; Backup
          </h1>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            Where data &amp; cost sit, what&apos;s safe to purge vs. keep, and one-click backups (records + binaries).
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-all"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {loading && !stats ? (
        <div className="text-sm text-[var(--color-text-muted)] inline-flex items-center gap-2 py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> Measuring…
        </div>
      ) : stats ? (
        <>
          {/* ── Health watermark ─────────────────────────────────────────── */}
          <div className={`rounded-2xl border p-4 mb-5 ${
            health === "crit" ? "border-red-300 bg-red-50" :
            health === "warn" ? "border-amber-300 bg-amber-50" :
            "border-[var(--color-border)] bg-[var(--color-surface)]"
          }`}>
            <div className="flex items-end justify-between gap-3 flex-wrap mb-2">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">Total footprint</div>
                <div className="text-2xl font-black text-[var(--color-text)]">
                  {fmtBytes(usedBytes)} <span className="text-sm font-bold text-[var(--color-text-muted)]">/ {fmtBytes(budgetBytes)} {isRealQuota ? "limit" : "soft budget"}</span>
                </div>
              </div>
              <div className={`text-right ${health === "crit" ? "text-red-700" : health === "warn" ? "text-amber-700" : "text-emerald-700"}`}>
                <div className="text-2xl font-black">{pct}%</div>
                <div className="text-[11px] font-bold">{health === "crit" ? "Act now" : health === "warn" ? "Plan a backup" : "Healthy"}</div>
              </div>
            </div>
            <div className="h-2.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
              <div className={`h-full rounded-full transition-all ${health === "crit" ? "bg-red-500" : health === "warn" ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
            <div className="mt-2 flex items-start gap-1.5 text-[11px] text-[var(--color-text-muted)] leading-relaxed">
              <Info className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>
                {health === "ok"
                  ? "Plenty of headroom. Still recommended: take a full backup quarterly so you can restore from scratch."
                  : `At ${pct}% it's time to take a full backup and free up space below.`}
                {reclaimNow > 0 && <> You can reclaim ≈<b>{fmtBytes(reclaimNow)}</b> now (purge + dedup).</>}
                {!isRealQuota && " The limit shown is a guideline until you set your plan's real quota."}
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
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg font-bold text-white bg-[var(--color-accent)] hover:opacity-90 disabled:opacity-40">
                      {savingQuota ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Save
                    </button>
                    <button onClick={() => { setEditingQuota(false); setQuotaDraft(quotaBytes ? String(Math.round((quotaBytes / (1024 ** 3)) * 10) / 10) : ""); }}
                      className="text-[var(--color-text-muted)] font-bold">Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setEditingQuota(true)} className="inline-flex items-center gap-1 font-bold text-[var(--color-accent)] hover:underline">
                    <Gauge className="w-3.5 h-3.5" /> {isRealQuota ? "Change storage limit" : "Set your storage limit"}
                  </button>
                )}
                {isRealQuota && !editingQuota && <span className="text-[var(--color-text-faint)]">Admins are alerted at 70% / 90%.</span>}
              </div>
            )}
          </div>

          {/* ── DB / R2 headline ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex items-center gap-2 text-[var(--color-text-muted)] text-xs font-bold uppercase tracking-widest mb-1">
                <Database className="w-3.5 h-3.5" /> Database (Postgres)
              </div>
              <div className="text-2xl font-black text-[var(--color-text)]">{fmtBytes(stats.db.totalBytes)}</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">{tables.length} tables on disk</div>
            </div>
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex items-center gap-2 text-[var(--color-text-muted)] text-xs font-bold uppercase tracking-widest mb-1">
                <HardDrive className="w-3.5 h-3.5" /> Files (R2, estimated)
              </div>
              <div className="text-2xl font-black text-[var(--color-text)]">~{fmtBytes(stats.r2Estimate.totalBytes)}</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                {fmtNum(stats.r2Estimate.versionCount)} revisions · {fmtNum(stats.r2Estimate.photoCount)} photos
              </div>
            </div>
          </div>

          {/* ── Category breakdown: purge vs keep vs reference ───────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
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
                  <div className="text-xl font-black text-[var(--color-text)]">{fmtBytes(bytes)}</div>
                  <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden my-1.5">
                    <div className={`h-full rounded-full ${M.bar}`} style={{ width: `${Math.max(1, share)}%` }} />
                  </div>
                  <div className="text-[10.5px] text-[var(--color-text-muted)] leading-relaxed">{M.blurb}</div>
                </div>
              );
            })}
          </div>

          {/* ── Free up space (purge) ────────────────────────────────────── */}
          {canPurge ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 mb-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)]">
                  <Recycle className="w-4 h-4 text-emerald-600" /> Free up space
                  <span className="text-[11px] font-medium text-[var(--color-text-muted)]">· your workspace · disposable rows only</span>
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

              <div className="divide-y divide-emerald-200/60 rounded-xl border border-emerald-200/60 bg-[var(--color-surface)] overflow-hidden mb-3">
                {previewLoading && !preview ? (
                  <div className="px-3 py-3 text-xs text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…</div>
                ) : (preview?.targets ?? []).map((t) => (
                  <div key={t.table} className="px-3 py-2 flex items-center gap-3" title={t.reason}>
                    <Recycle className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-[var(--color-text)]">{t.label}</div>
                      <div className="text-[10.5px] text-[var(--color-text-muted)] font-mono truncate">{t.table}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-bold text-[var(--color-text)]">{fmtNum(t.rows)} rows</div>
                      <div className="text-[10.5px] text-[var(--color-text-muted)]">≈{fmtBytes(t.estBytes)}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-[11px] text-[var(--color-text-muted)] max-w-md">
                  {preview && preview.totalRows > 0
                    ? <>Reclaims ≈<b className="text-[var(--color-text)]">{fmtBytes(preview.totalEstBytes)}</b> across {fmtNum(preview.totalRows)} rows. The action is written to the audit log.</>
                    : "Nothing to purge in this window — your disposable data is already lean."}
                </div>
                <button
                  onClick={() => void runPurge()}
                  disabled={purging || !preview || preview.totalRows === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 transition-colors"
                >
                  {purging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Purge {preview && preview.totalRows > 0 ? `${fmtNum(preview.totalRows)} rows` : "now"}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-5 text-xs text-[var(--color-text-muted)] flex items-center gap-2">
              <Lock className="w-4 h-4 shrink-0" /> Freeing space is limited to Admin / DocCtrl. You can still view usage and download backups.
            </div>
          )}

          {/* ── Archive for space (the shed) ─────────────────────────────── */}
          {canPurge && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)]">
                  <Archive className="w-4 h-4 text-amber-600" /> Archive older revision history for space
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
                Keeps the <b>last {shedKeep} revisions</b> of every document instantly available and moves the heavy binaries of older history into one offline archive. The revision, its checksum and its change reason stay forever — only the file moves. The current revision is never touched.
              </p>

              {shedPreview && shedPreview.selectedCount > 0 ? (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    <b className="text-[var(--color-text)]">{fmtNum(shedPreview.selectedCount)}</b> superseded file(s) · reclaim ≈<b className="text-[var(--color-text)]">{fmtBytes(shedPreview.reclaimableBytes)}</b>
                    {archiveRoot && <> → save to <span className="font-mono break-all">{subfolder(archiveRoot, "data")}&lt;id&gt;.zip</span></>}
                  </div>
                  <button onClick={() => void produceArchive()} disabled={shedBusy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-40">
                    {shedBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />} Build &amp; download archive
                  </button>
                </div>
              ) : (
                <div className="text-[11px] text-[var(--color-text-muted)]">No document has more than {shedKeep} revisions — nothing older to archive yet.</div>
              )}

              {pendingArchive && (
                <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
                  <div className="text-[11px] text-amber-900 font-bold mb-1 flex items-center gap-1.5"><FolderArchive className="w-3.5 h-3.5" /> Step 2 — reclaim the space</div>
                  <div className="text-[11px] text-amber-900 mb-2">
                    Save <span className="font-mono">{pendingArchive.archiveId}.zip</span> to <span className="font-mono break-all">{archiveRoot ? subfolder(archiveRoot, "data") : "<root>/data/"}</span> first. Then reclaim ≈{fmtBytes(pendingArchive.bytes)} from live storage. Until you do, the files stay online — nothing is lost.
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => void commitArchive()} disabled={committing}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-red-600 hover:bg-red-500 disabled:opacity-40">
                      {committing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} I saved it — reclaim {fmtBytes(pendingArchive.bytes)}
                    </button>
                    <button onClick={() => setPendingArchive(null)} className="text-[11px] font-bold text-[var(--color-text-muted)]">Not yet</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Archive closed tickets for space ─────────────────────────── */}
          {canPurge && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)]">
                  <Archive className="w-4 h-4 text-sky-600" /> Archive closed tickets for space
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-[var(--color-text-muted)]">closed over</span>
                  <select value={ticketDays} onChange={(e) => setTicketDays(Number(e.target.value))}
                    className="text-xs font-bold rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-text)]">
                    {[180, 365, 730, 1095].map((d) => <option key={d} value={d}>{d} days</option>)}
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)] mb-3 max-w-2xl">
                Moves the <b>whole of long-closed tickets</b> — comment thread, history and attachment files — into one offline archive and leaves a lightweight stub in the list. Nothing is tossed; opening a stub prompts for the archive, and one restore brings it all back. Only <b>CLOSED/CANCELED</b> tickets are eligible — open requests are never touched.
              </p>

              {ticketPreview && ticketPreview.selectedCount > 0 ? (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    <b className="text-[var(--color-text)]">{fmtNum(ticketPreview.selectedCount)}</b> closed ticket(s) · reclaim ≈<b className="text-[var(--color-text)]">{fmtBytes(ticketPreview.reclaimableBytes)}</b> of attachments
                    {archiveRoot && <> → save to <span className="font-mono break-all">{subfolder(archiveRoot, "data")}&lt;id&gt;.zip</span></>}
                  </div>
                  <button onClick={() => void produceTicketArchive()} disabled={ticketBusy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-40">
                    {ticketBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />} Build &amp; download archive
                  </button>
                </div>
              ) : (
                <div className="text-[11px] text-[var(--color-text-muted)]">No closed ticket has been quiet longer than {ticketDays} days — nothing to archive yet.</div>
              )}

              {pendingTicketArchive && (
                <div className="mt-3 rounded-xl border border-sky-300 bg-sky-50 p-3">
                  <div className="text-[11px] text-sky-900 font-bold mb-1 flex items-center gap-1.5"><FolderArchive className="w-3.5 h-3.5" /> Step 2 — reclaim the space</div>
                  <div className="text-[11px] text-sky-900 mb-2">
                    Save <span className="font-mono">{pendingTicketArchive.archiveId}.zip</span> to <span className="font-mono break-all">{archiveRoot ? subfolder(archiveRoot, "data") : "<root>/data/"}</span> first. Then move {pendingTicketArchive.tickets} ticket(s) to the archive and reclaim ≈{fmtBytes(pendingTicketArchive.bytes)}. Until you do, everything stays online — nothing is lost.
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => void commitTicketArchive()} disabled={ticketCommitting}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-red-600 hover:bg-red-500 disabled:opacity-40">
                      {ticketCommitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} I saved it — reclaim {fmtBytes(pendingTicketArchive.bytes)}
                    </button>
                    <button onClick={() => setPendingTicketArchive(null)} className="text-[11px] font-bold text-[var(--color-text-muted)]">Not yet</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Backup (records + binaries) ──────────────────────────────── */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-5">
            <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)] mb-1">
              <ShieldCheck className="w-4 h-4 text-emerald-600" /> Backup &amp; restore-from-scratch
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] mb-3 max-w-2xl">
              A full ZIP is a self-contained, org-wide snapshot — every record <b>and</b> every binary (PDF/DWG/photo) inline —
              so you can come back from scratch. Recommended quarterly. Files are pulled straight from R2.
            </p>

            {/* Archive root folder — one place, shared, with a fixed convention underneath */}
            {canPurge && (
              <div className={`rounded-xl border p-3 mb-3 ${archiveRoot && !editingLoc ? "border-[var(--color-border)] bg-[var(--color-surface-2)]" : "border-amber-200 bg-amber-50"}`}>
                {!editingLoc && archiveRoot ? (
                  <div className="flex items-start gap-2">
                    <FolderArchive className="w-4 h-4 text-[var(--color-text-muted)] mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0 text-[11px]">
                      <div className="text-[var(--color-text)]"><b>Archive root:</b> <span className="font-mono break-all">{archiveRoot}</span></div>
                      <div className="text-[var(--color-text-muted)] mt-1 leading-relaxed">
                        Full backups → <span className="font-mono break-all">{subfolder(archiveRoot, "full-backups")}</span><br />
                        Space-saver exports → <span className="font-mono break-all">{subfolder(archiveRoot, "data")}</span>
                      </div>
                      <div className="text-[var(--color-text-faint)] mt-1">Anyone asked to view an archived file is pointed to the exact path under here.</div>
                    </div>
                    <button onClick={() => setEditingLoc(true)} className="text-[11px] font-bold text-[var(--color-accent)] hover:underline shrink-0">Edit</button>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-900 mb-1">
                      <FolderArchive className="w-4 h-4 shrink-0" /> Set your archive root folder
                    </div>
                    <div className="text-[10.5px] text-amber-900/80 mb-2 leading-relaxed">
                      One folder, shared with your team. Full backups go in <span className="font-mono">/full-backups</span>, periodic space-saver exports in <span className="font-mono">/data</span> — it&apos;s the path users are told to fetch from.
                    </div>
                    <div className="space-y-2">
                      <input value={locDraft} onChange={(e) => setLocDraft(e.target.value)} placeholder="e.g.  \\fileserver\drafting\mos-archives   or   /Volumes/Backups/MOS"
                        className="w-full text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-[var(--color-text)] font-mono" />
                      {locDraft.trim() && (
                        <div className="text-[10.5px] text-[var(--color-text-muted)] break-all">Users will be told: <span className="font-mono">{subfolder(locDraft, "data")}&lt;archive-id&gt;.zip</span></div>
                      )}
                      <div className="flex items-center gap-2">
                        <button onClick={() => void saveArchiveLoc()} disabled={savingLoc || !locDraft.trim()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-[var(--color-accent)] hover:opacity-90 disabled:opacity-40">
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                onClick={() => void downloadZip()} disabled={busyZip || !activeOrgId}
                className="inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-colors"
              >
                {busyZip ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileArchive className="w-4 h-4" />}
                Full ZIP (records + binaries)
              </button>
              <button
                onClick={() => void downloadJson()} disabled={busyJson || !activeOrgId}
                className="inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-bold text-[var(--color-text)] bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:bg-[var(--color-border)] disabled:opacity-50 transition-colors"
              >
                {busyJson ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileJson className="w-4 h-4" />}
                JSON only (records)
              </button>
            </div>
            {lastArchiveId && (
              <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900 flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>Saved as archive <b className="font-mono">{lastArchiveId}</b> — store it at <span className="font-mono break-all">{archiveRoot ? subfolder(archiveRoot, "full-backups") : "<root>/full-backups/"}{lastArchiveId}.zip</span>. Quote this id if anyone needs a file it holds.</span>
              </div>
            )}
            <div className="mt-3 space-y-2 text-[11px]">
              <span className="inline-flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> Binaries now sign against R2 — the ZIP really contains your files.</span>
              <div className="flex items-center gap-4 flex-wrap">
                <Link href="/admin/archive-view" className="inline-flex items-center gap-1.5 font-bold text-[var(--color-accent)] hover:underline">
                  <Archive className="w-3.5 h-3.5" /> View from a backup →
                </Link>
                <Link href="/admin/restore" className="inline-flex items-center gap-1.5 font-bold text-[var(--color-accent)] hover:underline">
                  <UploadCloud className="w-3.5 h-3.5" /> Restore from a backup →
                </Link>
                <Link href="/admin/data-export" className="inline-flex items-center gap-1.5 font-bold text-[var(--color-accent)] hover:underline">
                  <ServerCog className="w-3.5 h-3.5" /> Scheduled push to your own bucket →
                </Link>
              </div>
            </div>
          </div>

          {/* ── Dedup opportunity ────────────────────────────────────────── */}
          {stats.dedup && stats.dedup.totalVersions > 0 && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-5">
              <div className="flex items-center gap-2 text-[var(--color-text-muted)] text-xs font-bold uppercase tracking-widest mb-2">
                <Copy className="w-3.5 h-3.5" /> Duplication (revision files)
              </div>
              <div className="flex items-center gap-6 flex-wrap">
                <div>
                  <div className="text-2xl font-black text-emerald-600">~{fmtBytes(stats.dedup.reclaimableBytes)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">reclaimable by dedup</div>
                </div>
                <div>
                  <div className="text-lg font-black text-[var(--color-text)]">{fmtNum(stats.dedup.dupGroups)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">files stored 2+ times</div>
                </div>
                <div className="flex-1 min-w-[12rem] text-[11px] text-[var(--color-text-faint)] leading-relaxed">
                  Identical files already carry a SHA-256 fingerprint but are stored separately. Content-addressed storage
                  would keep one copy and reclaim the above — measured here before any change to the upload path.
                </div>
              </div>
            </div>
          )}

          {/* ── AI usage ─────────────────────────────────────────────────── */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-5">
            <div className="flex items-center gap-2 text-[var(--color-text-muted)] text-xs font-bold uppercase tracking-widest mb-2">
              <Sparkles className="w-3.5 h-3.5" /> AI usage (shared key)
            </div>
            {stats.ai ? (
              <div className="flex items-center gap-6 flex-wrap">
                <div>
                  <div className="text-2xl font-black text-[var(--color-text)]">{fmtNum(stats.ai.last24h)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">calls · last 24h</div>
                </div>
                <div>
                  <div className="text-2xl font-black text-[var(--color-text)]">{fmtNum(stats.ai.last30d)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">calls · last 30d</div>
                </div>
                <div className="flex-1 min-w-[12rem] text-[11px] text-[var(--color-text-faint)] leading-relaxed">
                  Free Gemini tier is ~10 calls/min and ~1,000/day, shared across everyone. Per-org limits and
                  bring-your-own-key come later; this is the visibility groundwork.
                </div>
              </div>
            ) : (
              <div className="text-xs text-[var(--color-text-muted)]">
                AI metering isn&apos;t recording yet — apply migration <span className="font-mono">20260806</span>.
              </div>
            )}
          </div>

          {/* ── Ticket design-issue callout ──────────────────────────────── */}
          {ticketRow && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 mb-5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="text-[11px] text-amber-900 leading-relaxed">
                  <b>Why “{ticketRow.name}” is heavy per row — and that it&apos;s fixable.</b> {ticketRow.reason}
                  {" "}It&apos;s a <b>design</b> issue (in-row JSONB rewritten on every action), not an inherent cost —
                  flattening history/comments/attachments into child rows removes the bloat.
                </div>
              </div>
            </div>
          )}

          {/* ── Tables by size ───────────────────────────────────────────── */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden mb-4">
            <div className="px-4 py-3 border-b border-[var(--color-border)] text-sm font-bold text-[var(--color-text)] flex items-center justify-between flex-wrap gap-2">
              <span>Tables by size</span>
              <span className="text-[11px] font-medium text-[var(--color-text-faint)] inline-flex items-center gap-2">
                <span className="inline-flex items-center gap-1"><Recycle className="w-3 h-3 text-emerald-500" /> purge</span>
                <span className="inline-flex items-center gap-1"><Archive className="w-3 h-3 text-amber-500" /> keep</span>
                <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3 text-sky-500" /> ref</span>
                <span className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-amber-500" /> grower</span>
                <span className="text-[var(--color-text-muted)]">· hover a row for why</span>
              </span>
            </div>
            <div className="divide-y divide-[var(--color-border)]">
              {tables.slice(0, 30).map((t) => {
                const M = CATEGORY_META[t.category];
                const Icon = M.icon;
                return (
                  <div key={t.name} className="px-4 py-2 flex items-center gap-3 cursor-help" title={`${CATEGORY_LABEL[t.category]} — ${t.reason}`}>
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
          </div>

          <p className="text-[11px] text-[var(--color-text-faint)] leading-relaxed">{stats.note}</p>
          <p className="text-[10px] text-[var(--color-text-faint)] mt-2">Snapshot {new Date(stats.generatedAt).toLocaleString()}</p>
        </>
      ) : null}
    </div>
  );
}
