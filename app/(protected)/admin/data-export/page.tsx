"use client";

// /admin/data-export — the complete data-portability admin surface.
//
// Three sections:
//   1. Quick actions  — direct JSON download + direct full-ZIP download
//   2. Destinations   — configure scheduled push to customer-owned S3 / R2 / webhook
//   3. Run history    — chronological audit of every export, manual or scheduled

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Database, Download, FileJson, FileArchive, Loader2, AlertTriangle,
  ShieldCheck, Plus, Server, Trash2, TestTube, RefreshCw, Clock,
  CheckCircle2, XCircle, Lock, ExternalLink, Calendar, Cpu,
  Webhook, HardDrive, Archive as ArchiveIcon, Edit3,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";

type Destination = {
  id: string;
  org_id: string;
  name: string;
  destination_type: "s3" | "r2" | "webhook";
  enabled: boolean;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  webhook_url?: string;
  schedule_kind: "manual" | "daily" | "weekly" | "monthly";
  schedule_hour_utc?: number | null;
  schedule_day_of_week?: number | null;
  schedule_day_of_month?: number | null;
  next_run_at?: string | null;
  include_files: boolean;
  retention_days?: number | null;
  last_run_at?: string | null;
  last_run_status?: string | null;
  last_run_error?: string | null;
  last_run_bytes?: number | null;
  has_access_key?: boolean;
  has_secret_key?: boolean;
  has_webhook_secret?: boolean;
};

type Run = {
  id: string;
  destination_id?: string | null;
  destination_name?: string;
  destination_type?: string;
  trigger_type: "manual" | "scheduled" | "api";
  triggered_by_email?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  table_count?: number;
  total_rows?: number;
  file_count?: number;
  total_bytes?: number;
  destination_path?: string | null;
  error_message?: string | null;
  started_at: string;
  completed_at?: string | null;
  duration_ms?: number | null;
};

export default function DataExportPage() {
  const { activeOrgId, activeRole } = useRole();
  const isAuthorized = ["Admin", "Manager", "DocCtrl"].includes(activeRole);

  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [busyJson, setBusyJson] = useState(false);
  const [busyZip, setBusyZip] = useState(false);
  const [busyDestId, setBusyDestId] = useState<string | null>(null);

  const [editing, setEditing] = useState<Destination | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId || !isAuthorized) return;
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const [destRes, runRes] = await Promise.all([
        fetch(`/api/data-export/destinations?orgId=${activeOrgId}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/data-export/runs?orgId=${activeOrgId}&limit=50`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (destRes.ok) setDestinations((await destRes.json()).destinations || []);
      if (runRes.ok) setRuns((await runRes.json()).runs || []);
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, [activeOrgId, isAuthorized]);

  useEffect(() => { void refresh(); }, [refresh]);

  // ─── Inline JSON download ────────────────────────────────────────────
  const downloadJson = async () => {
    if (!activeOrgId) return;
    setBusyJson(true); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/data-export/structured?orgId=${activeOrgId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `manufacturing-os-export-${Date.now()}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message); }
    finally { setBusyJson(false); }
  };

  // ─── Inline ZIP download (D4) ────────────────────────────────────────
  const downloadZip = async () => {
    if (!activeOrgId) return;
    setBusyZip(true); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/data-export/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, includeFiles: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `manufacturing-os-export-${Date.now()}.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      void refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusyZip(false); }
  };

  // ─── Run a destination now ───────────────────────────────────────────
  const runDestinationNow = async (id: string) => {
    if (!activeOrgId) return;
    setBusyDestId(id); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/data-export/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: activeOrgId, destinationId: id }),
      });
      if (!res.ok) throw new Error(await res.text());
      void refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusyDestId(null); }
  };

  // ─── Test connection ─────────────────────────────────────────────────
  const testConnection = async (id: string): Promise<{ ok: boolean; error?: string }> => {
    if (!activeOrgId) return { ok: false, error: "no org" };
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    const res = await fetch(`/api/data-export/destinations/${id}/test?orgId=${activeOrgId}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, error: await res.text() };
    return await res.json();
  };

  const deleteDestination = async (id: string) => {
    if (!activeOrgId) return;
    if (!confirm("Delete this destination? Scheduled exports for it will stop. This cannot be undone.")) return;
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    await fetch(`/api/data-export/destinations/${id}?orgId=${activeOrgId}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    });
    void refresh();
  };

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-20">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
            <Database className="w-7 h-7 text-emerald-600" />
            Data Export & Backup
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Your data, available to you any time. Direct download, ZIP with files inline, or scheduled push to your own storage.
          </p>
        </div>

        {!isAuthorized && (
          <div className="mb-6 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Only <b>Admin</b>, <b>Manager</b>, or <b>DocCtrl</b> roles can manage data exports. Your role: <b>{activeRole}</b>.</span>
          </div>
        )}

        {/* ──── DIRECT DOWNLOAD ──── */}
        {isAuthorized && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
              <div className="flex items-start gap-3 mb-3">
                <div className="p-2.5 bg-blue-100 rounded-xl"><FileJson className="w-5 h-5 text-blue-700" /></div>
                <div className="flex-1">
                  <div className="text-sm font-black text-slate-900">JSON only</div>
                  <div className="text-xs text-slate-600 mt-0.5">Structured records + a file manifest with 24h presigned URLs.</div>
                </div>
              </div>
              <button
                onClick={downloadJson} disabled={busyJson || !activeOrgId}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-bold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
              >
                {busyJson ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Download JSON
              </button>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
              <div className="flex items-start gap-3 mb-3">
                <div className="p-2.5 bg-emerald-100 rounded-xl"><FileArchive className="w-5 h-5 text-emerald-700" /></div>
                <div className="flex-1">
                  <div className="text-sm font-black text-slate-900">Full ZIP with binaries</div>
                  <div className="text-xs text-slate-600 mt-0.5">JSON + every PDF/DWG inline. Self-contained archive. Heavier — wait for it to build.</div>
                </div>
              </div>
              <button
                onClick={downloadZip} disabled={busyZip || !activeOrgId}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
              >
                {busyZip ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Download Full ZIP
              </button>
            </div>
          </div>
        )}

        {/* ──── DESTINATIONS ──── */}
        {isAuthorized && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-black text-slate-900 flex items-center gap-2">
                <Server className="w-4 h-4 text-slate-500" /> Scheduled Push Destinations
              </h2>
              <button
                onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow"
              ><Plus className="w-3.5 h-3.5" /> New Destination</button>
            </div>
            <p className="text-xs text-slate-500 mb-3 max-w-3xl">
              Configure your own S3 / R2 bucket or webhook URL. We push a fresh export on your schedule. We never see the
              destination credentials in plaintext — they&apos;re encrypted at rest with AES-256-GCM and decrypted only at push time.
            </p>

            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 p-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : destinations.length === 0 ? (
              <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-8 text-center">
                <Server className="w-10 h-10 mx-auto text-slate-300 mb-2" />
                <div className="text-sm text-slate-500 mb-3">No destinations configured yet.</div>
                <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">
                  <Plus className="w-3.5 h-3.5" /> Add your first destination
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {destinations.map((d) => (
                  <DestinationCard
                    key={d.id}
                    dest={d}
                    busy={busyDestId === d.id}
                    onRun={() => runDestinationNow(d.id)}
                    onTest={() => testConnection(d.id)}
                    onEdit={() => setEditing(d)}
                    onDelete={() => deleteDestination(d.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ──── RUN HISTORY ──── */}
        {isAuthorized && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-black text-slate-900 flex items-center gap-2">
                <Clock className="w-4 h-4 text-slate-500" /> Export History
              </h2>
              <button onClick={() => void refresh()} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100">
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            </div>
            <p className="text-xs text-slate-500 mb-3">Chain-of-custody for every export. Auditable, immutable.</p>
            {runs.length === 0 ? (
              <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-6 text-center text-xs text-slate-500">
                No exports run yet.
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
                <div className="divide-y divide-slate-100">
                  {runs.map((r) => <RunRow key={r.id} run={r} />)}
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Trust footer */}
        <div className="mt-8 p-4 rounded-2xl border border-slate-200 bg-white text-xs text-slate-600 flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
          <span>
            Every export is recorded in <b>audit_logs</b> and visible above. Credentials use AES-256-GCM at rest.
            Public commitment: <Link href="/data-portability" target="_blank" className="text-emerald-700 font-bold hover:underline inline-flex items-center gap-1">data-portability page <ExternalLink className="w-3 h-3" /></Link>.
          </span>
        </div>
      </div>

      {(creating || editing) && activeOrgId && (
        <DestinationModal
          mode={creating ? "create" : "edit"}
          existing={editing ?? undefined}
          orgId={activeOrgId}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Destination card ─────────────────────────────────────────────────────

function DestinationCard({
  dest, busy, onRun, onTest, onEdit, onDelete,
}: {
  dest: Destination;
  busy: boolean;
  onRun: () => void;
  onTest: () => Promise<{ ok: boolean; error?: string }>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const doTest = async () => {
    setTesting(true);
    setTestResult(null);
    try { setTestResult(await onTest()); }
    finally { setTesting(false); }
  };

  const icon = dest.destination_type === "webhook" ? <Webhook className="w-4 h-4 text-purple-700" />
    : dest.destination_type === "r2" ? <HardDrive className="w-4 h-4 text-amber-700" />
    : <ArchiveIcon className="w-4 h-4 text-blue-700" />;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-slate-100 rounded-lg">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-black text-slate-900 truncate">{dest.name}</span>
            <span className="text-[10px] font-bold uppercase bg-slate-100 px-1.5 py-0.5 rounded">{dest.destination_type}</span>
            {!dest.enabled && <span className="text-[10px] font-bold bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">DISABLED</span>}
            <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border ${
              dest.schedule_kind === "manual"
                ? "bg-slate-50 text-slate-600 border-slate-200"
                : "bg-blue-50 text-blue-700 border-blue-200"
            }`}>
              <Calendar className="w-2.5 h-2.5" /> {dest.schedule_kind}
              {dest.schedule_kind !== "manual" && dest.schedule_hour_utc != null ? ` @ ${String(dest.schedule_hour_utc).padStart(2, "0")}:00 UTC` : ""}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-slate-500 font-mono truncate">
            {dest.destination_type === "webhook"
              ? dest.webhook_url
              : `${dest.endpoint || dest.region || ""} ${dest.bucket || ""}${dest.prefix ? "/" + dest.prefix : ""}`.trim()}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
            {dest.last_run_at && (
              <span className={`inline-flex items-center gap-1 ${dest.last_run_status === "failed" ? "text-red-600" : "text-emerald-700"}`}>
                {dest.last_run_status === "succeeded" ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                last: {new Date(dest.last_run_at).toLocaleString()}
              </span>
            )}
            {dest.next_run_at && <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> next: {new Date(dest.next_run_at).toLocaleString()}</span>}
            {dest.retention_days && <span>retention: {dest.retention_days}d</span>}
            {!dest.include_files && <span className="text-amber-700">JSON only (no binaries)</span>}
          </div>
          {dest.last_run_error && (
            <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-700 font-mono">{dest.last_run_error}</div>
          )}
          {testResult && (
            <div className={`mt-2 p-2 border rounded text-[11px] ${testResult.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-700"}`}>
              {testResult.ok ? "Connection test passed — credentials work." : `Test failed: ${testResult.error}`}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1">
            <button onClick={() => void doTest()} disabled={testing} title="Test connection" className="p-1.5 rounded-md text-slate-500 hover:text-blue-700 hover:bg-blue-50 disabled:opacity-40">
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TestTube className="w-3.5 h-3.5" />}
            </button>
            <button onClick={onEdit} title="Edit" className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100">
              <Edit3 className="w-3.5 h-3.5" />
            </button>
            <button onClick={onDelete} title="Delete" className="p-1.5 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            onClick={onRun} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Cpu className="w-3 h-3" />} Run Now
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Run history row ──────────────────────────────────────────────────────

function RunRow({ run }: { run: Run }) {
  const ago = run.completed_at || run.started_at;
  const dur = run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : null;
  return (
    <div className="px-4 py-3 flex items-start gap-3">
      <div className={`p-1.5 rounded-md shrink-0 ${
        run.status === "succeeded" ? "bg-emerald-100" :
        run.status === "failed" ? "bg-red-100" :
        run.status === "running" ? "bg-blue-100" : "bg-slate-100"
      }`}>
        {run.status === "succeeded" ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" /> :
         run.status === "failed" ? <XCircle className="w-3.5 h-3.5 text-red-700" /> :
         run.status === "running" ? <Loader2 className="w-3.5 h-3.5 text-blue-700 animate-spin" /> :
         <Clock className="w-3.5 h-3.5 text-slate-500" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap text-xs">
          <span className="font-bold text-slate-900">{run.destination_name || "Direct download"}</span>
          <span className="text-[10px] uppercase font-bold bg-slate-100 px-1.5 py-0.5 rounded">{run.trigger_type}</span>
          {run.triggered_by_email && <span className="text-slate-500">by {run.triggered_by_email}</span>}
          <span className="text-slate-400">{new Date(ago).toLocaleString()}</span>
          {dur && <span className="text-slate-400">in {dur}</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
          {run.table_count != null && <span>{run.table_count} tables · {run.total_rows ?? 0} rows</span>}
          {run.file_count != null && <span>{run.file_count} files</span>}
          {run.total_bytes != null && <span>{formatBytes(run.total_bytes)}</span>}
          {run.destination_path && <span className="font-mono truncate max-w-[40ch]" title={run.destination_path}>→ {run.destination_path}</span>}
        </div>
        {run.error_message && (
          <div className="mt-1 p-2 bg-red-50 border border-red-200 rounded text-[10px] text-red-700 font-mono">{run.error_message}</div>
        )}
      </div>
    </div>
  );
}

// ─── Destination create/edit modal ────────────────────────────────────────

function DestinationModal({
  mode, existing, orgId, onClose, onSaved,
}: {
  mode: "create" | "edit";
  existing?: Destination;
  orgId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name || "");
  const [type, setType] = useState<"s3" | "r2" | "webhook">(existing?.destination_type || "s3");
  const [endpoint, setEndpoint] = useState(existing?.endpoint || "");
  const [region, setRegion] = useState(existing?.region || "us-east-1");
  const [bucket, setBucket] = useState(existing?.bucket || "");
  const [prefix, setPrefix] = useState(existing?.prefix || "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [webhookUrl, setWebhookUrl] = useState(existing?.webhook_url || "");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [schedule, setSchedule] = useState<"manual" | "daily" | "weekly" | "monthly">(existing?.schedule_kind || "manual");
  const [hourUtc, setHourUtc] = useState(existing?.schedule_hour_utc ?? 5);
  const [dayOfWeek, setDayOfWeek] = useState(existing?.schedule_day_of_week ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(existing?.schedule_day_of_month ?? 1);
  const [includeFiles, setIncludeFiles] = useState(existing?.include_files ?? true);
  const [retentionDays, setRetentionDays] = useState<number | "">(existing?.retention_days ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const body: Record<string, unknown> = {
        orgId, name, destination_type: type, enabled,
        endpoint: endpoint || undefined,
        region: region || undefined,
        bucket: bucket || undefined,
        prefix: prefix || undefined,
        webhook_url: webhookUrl || undefined,
        schedule_kind: schedule,
        schedule_hour_utc: schedule === "manual" ? null : hourUtc,
        schedule_day_of_week: schedule === "weekly" ? dayOfWeek : null,
        schedule_day_of_month: schedule === "monthly" ? dayOfMonth : null,
        include_files: includeFiles,
        retention_days: retentionDays === "" ? null : Number(retentionDays),
      };
      if (accessKeyId) body.access_key_id = accessKeyId;
      if (secretAccessKey) body.secret_access_key = secretAccessKey;
      if (webhookSecret) body.webhook_secret = webhookSecret;

      const res = await fetch(
        mode === "create"
          ? `/api/data-export/destinations`
          : `/api/data-export/destinations/${existing!.id}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) throw new Error(await res.text());
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-8">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className="text-sm font-black text-slate-900">{mode === "create" ? "New" : "Edit"} Backup Destination</div>
            <div className="text-xs text-slate-500">Credentials are encrypted with AES-256-GCM and only decrypted at push time.</div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <Field label="Name *">
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Acme Cold Storage" />
          </Field>

          <Field label="Destination type">
            <div className="flex bg-slate-100 p-1 rounded-lg">
              {(["s3", "r2", "webhook"] as const).map((t) => (
                <button key={t} onClick={() => setType(t)} className={`flex-1 py-1.5 text-xs font-bold rounded-md ${type === t ? "bg-white shadow text-slate-900" : "text-slate-500"}`}>
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </Field>

          {(type === "s3" || type === "r2") && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Endpoint" hint={type === "r2" ? "https://<account>.r2.cloudflarestorage.com" : "https://s3.<region>.amazonaws.com"}>
                  <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="input" placeholder="https://..." />
                </Field>
                <Field label="Region"><input value={region} onChange={(e) => setRegion(e.target.value)} className="input" placeholder="us-east-1" /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Bucket *"><input value={bucket} onChange={(e) => setBucket(e.target.value)} className="input" placeholder="my-backups" /></Field>
                <Field label="Prefix" hint="Optional folder inside the bucket"><input value={prefix} onChange={(e) => setPrefix(e.target.value)} className="input" placeholder="manufacturing-os" /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Access Key ID *" hint={mode === "edit" && existing?.has_access_key ? "Already set; leave blank to keep" : ""}>
                  <input type="password" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} className="input" autoComplete="off" />
                </Field>
                <Field label="Secret Access Key *" hint={mode === "edit" && existing?.has_secret_key ? "Already set; leave blank to keep" : ""}>
                  <input type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} className="input" autoComplete="off" />
                </Field>
              </div>
            </>
          )}

          {type === "webhook" && (
            <>
              <Field label="Webhook URL *">
                <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} className="input" placeholder="https://example.com/backups/incoming" />
              </Field>
              <Field label="Signing secret" hint="If set, requests carry X-MOS-Signature: sha256=<HMAC>">
                <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} className="input" autoComplete="off" />
              </Field>
            </>
          )}

          <Field label="Schedule">
            <div className="flex bg-slate-100 p-1 rounded-lg">
              {(["manual", "daily", "weekly", "monthly"] as const).map((s) => (
                <button key={s} onClick={() => setSchedule(s)} className={`flex-1 py-1.5 text-xs font-bold rounded-md ${schedule === s ? "bg-white shadow text-slate-900" : "text-slate-500"}`}>
                  {s}
                </button>
              ))}
            </div>
          </Field>

          {schedule !== "manual" && (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Hour (UTC)">
                <input type="number" min={0} max={23} value={hourUtc} onChange={(e) => setHourUtc(Number(e.target.value))} className="input" />
              </Field>
              {schedule === "weekly" && (
                <Field label="Day of week">
                  <select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))} className="input">
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </Field>
              )}
              {schedule === "monthly" && (
                <Field label="Day of month">
                  <input type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} className="input" />
                </Field>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Include file binaries">
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} /> Include PDFs/DWGs inline</label>
            </Field>
            <Field label="Retention (days)" hint="Delete older exports in your bucket">
              <input type="number" min={1} value={retentionDays === "" ? "" : retentionDays} onChange={(e) => setRetentionDays(e.target.value === "" ? "" : Number(e.target.value))} className="input" placeholder="(unlimited)" />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200">Cancel</button>
          <button onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {mode === "create" ? "Create Destination" : "Save Changes"}
          </button>
        </div>

        <style jsx>{`
          :global(.input) {
            width: 100%;
            padding: 0.5rem 0.625rem;
            border-radius: 0.5rem;
            border: 1px solid rgb(203 213 225);
            background: white;
            font-size: 0.8125rem;
            color: rgb(15 23 42);
          }
          :global(.input:focus) {
            outline: 2px solid rgb(16 185 129);
            outline-offset: -1px;
            border-color: rgb(16 185 129);
          }
        `}</style>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">{label}</label>
      {hint && <div className="text-[10px] text-slate-500 mt-0.5">{hint}</div>}
      <div className="mt-1">{children}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
