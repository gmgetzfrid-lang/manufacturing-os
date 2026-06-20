"use client";

// /admin/storage — read-only "Storage & Usage" dashboard.
//
// Shows where data and cost actually sit (deployment-wide): total DB size, the
// biggest / fastest-growing tables (with the audit's "watch" tables flagged),
// and an R2 binary estimate. Pure measurement — it changes and deletes nothing.
// This is step 0 of the data-lifecycle plan: decide with numbers, not guesses.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Database, HardDrive, AlertTriangle, RefreshCw, Loader2, Gauge, Sparkles } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";

interface TableRow { name: string; rows: number; bytes: number; watch: boolean }
interface Stats {
  generatedAt: string;
  db: { totalBytes: number; tables: TableRow[] };
  r2Estimate: { totalBytes: number; versionsBytes: number; photosBytes: number; versionCount: number; photoCount: number };
  ai: { last24h: number; last30d: number } | null;
  note: string;
}

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

export default function StorageUsagePage() {
  const { activeOrgId } = useRole();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true); setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(`/api/admin/storage-stats?orgId=${encodeURIComponent(activeOrgId)}`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setStats(body as Stats);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => { void load(); }, [load]);

  const maxBytes = stats?.db.tables.reduce((m, t) => Math.max(m, t.bytes), 0) ?? 0;

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="flex items-start gap-3 mb-5">
        <Link href="/dashboard" className="p-2 mt-1 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-black text-[var(--color-text)] flex items-center gap-2">
            <Gauge className="w-5 h-5 text-[var(--color-accent)]" /> Storage &amp; Usage
          </h1>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            Deployment-wide. Read-only — measures where data and cost sit so the lifecycle plan runs on numbers, not guesses.
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
          {/* Headline totals */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex items-center gap-2 text-[var(--color-text-muted)] text-xs font-bold uppercase tracking-widest mb-1">
                <Database className="w-3.5 h-3.5" /> Database (Postgres)
              </div>
              <div className="text-2xl font-black text-[var(--color-text)]">{fmtBytes(stats.db.totalBytes)}</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">{stats.db.tables.length} tables on disk</div>
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

          {/* AI usage (shared-key load) */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-5">
            <div className="flex items-center gap-2 text-[var(--color-text-muted)] text-xs font-bold uppercase tracking-widest mb-2">
              <Sparkles className="w-3.5 h-3.5" /> AI usage (shared key)
            </div>
            {stats.ai ? (
              <div className="flex items-center gap-6">
                <div>
                  <div className="text-2xl font-black text-[var(--color-text)]">{fmtNum(stats.ai.last24h)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">calls · last 24h</div>
                </div>
                <div>
                  <div className="text-2xl font-black text-[var(--color-text)]">{fmtNum(stats.ai.last30d)}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">calls · last 30d</div>
                </div>
                <div className="flex-1 text-[11px] text-[var(--color-text-faint)] leading-relaxed">
                  Free Gemini tier is ~10 calls/min and ~1,000/day, shared across everyone. Per-org limits and
                  bring-your-own-key come in a later phase; this is the visibility groundwork.
                </div>
              </div>
            ) : (
              <div className="text-xs text-[var(--color-text-muted)]">
                AI metering isn&apos;t recording yet — apply migration <span className="font-mono">20260806</span>.
              </div>
            )}
          </div>

          {/* Per-table breakdown */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden mb-4">
            <div className="px-4 py-3 border-b border-[var(--color-border)] text-sm font-bold text-[var(--color-text)]">
              Tables by size <span className="text-xs font-medium text-[var(--color-text-faint)]">· ⚠ = unbounded grower (archive first)</span>
            </div>
            <div className="divide-y divide-[var(--color-border)]">
              {stats.db.tables.slice(0, 25).map((t) => (
                <div key={t.name} className="px-4 py-2 flex items-center gap-3">
                  <div className="w-40 sm:w-56 min-w-0 flex items-center gap-1.5">
                    {t.watch && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                    <span className="font-mono text-xs text-[var(--color-text)] truncate">{t.name}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                      <div
                        className={`h-full rounded-full ${t.watch ? "bg-amber-500" : "bg-[var(--color-accent)]"}`}
                        style={{ width: `${maxBytes > 0 ? Math.max(2, (t.bytes / maxBytes) * 100) : 0}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-20 text-right text-xs font-bold text-[var(--color-text)]">{fmtBytes(t.bytes)}</div>
                  <div className="w-24 text-right text-[11px] text-[var(--color-text-muted)]">{fmtNum(t.rows)} rows</div>
                </div>
              ))}
            </div>
          </div>

          <p className="text-[11px] text-[var(--color-text-faint)] leading-relaxed">{stats.note}</p>
          <p className="text-[10px] text-[var(--color-text-faint)] mt-2">Snapshot {new Date(stats.generatedAt).toLocaleString()}</p>
        </>
      ) : null}
    </div>
  );
}
