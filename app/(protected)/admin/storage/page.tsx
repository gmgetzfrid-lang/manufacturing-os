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
  Archive, Recycle, Lock, Info, CheckCircle2, ServerCog, UploadCloud,
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

  // Backup state
  const [busyJson, setBusyJson] = useState(false);
  const [busyZip, setBusyZip] = useState(false);

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

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadPreview(purgeDays); }, [loadPreview, purgeDays]);

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
  const downloadZip = () => downloadFile(
    `/api/data-export/run`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId: activeOrgId, includeFiles: true }) },
    `manufacturing-os-backup-${Date.now()}.zip`, setBusyZip,
  );

  const tables = stats?.db.tables ?? [];
  const maxBytes = tables.reduce((m, t) => Math.max(m, t.bytes), 0);
  const usedBytes = (stats?.db.totalBytes ?? 0) + (stats?.r2Estimate.totalBytes ?? 0);
  const pct = Math.min(100, Math.round((usedBytes / SOFT_BUDGET_BYTES) * 100));
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
                  {fmtBytes(usedBytes)} <span className="text-sm font-bold text-[var(--color-text-muted)]">/ {fmtBytes(SOFT_BUDGET_BYTES)} soft budget</span>
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
                  : `At ${pct}% of the soft budget it's time to take a full backup and free up space below.`}
                {reclaimNow > 0 && <> You can reclaim ≈<b>{fmtBytes(reclaimNow)}</b> now (purge + dedup).</>}
                {" "}Soft budget is a guideline — set it to your plan&apos;s limit in code.
              </span>
            </div>
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

          {/* ── Backup (records + binaries) ──────────────────────────────── */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-5">
            <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)] mb-1">
              <ShieldCheck className="w-4 h-4 text-emerald-600" /> Backup &amp; restore-from-scratch
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] mb-3 max-w-2xl">
              A full ZIP is a self-contained, org-wide snapshot — every record <b>and</b> every binary (PDF/DWG/photo) inline —
              so you can come back from scratch. Recommended quarterly. Files are pulled straight from R2.
            </p>
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
            <div className="mt-3 space-y-2 text-[11px]">
              <span className="inline-flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> Binaries now sign against R2 — the ZIP really contains your files.</span>
              <div className="flex items-center gap-4 flex-wrap">
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
