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
  Download, FileJson, FileArchive, Loader2, AlertTriangle,
  Plus, Trash2, TestTube, RefreshCw,
  Lock, ExternalLink, Cpu,
  Webhook, HardDrive, Archive as ArchiveIcon, Edit3, X, Send, History,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { startGlobalBackup, subscribeBackup, cancelBackup, backupIsRunning, type BackupProgress } from "@/lib/clientBackup";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody } from "@/components/ui/PageHero";
import { bandSeg, bandSegItem } from "@/components/admin/band";
import { tbl, sheet, link, btnPrimary, btnQuiet, btnRow, btnIcon, FormRow, Section, StatusTag, Pill, RowEdge, Problem, shortDateTime } from "@/components/admin/kit";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { Input, Select } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { appConfirm } from "@/components/providers/DialogProvider";

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
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  useEffect(() => subscribeBackup(setBackupProgress), []);
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
      if (!destRes.ok) throw new Error(`Couldn't load destinations: ${(await destRes.text().catch(() => "")) || `HTTP ${destRes.status}`}`);
      if (!runRes.ok) throw new Error(`Couldn't load export history: ${(await runRes.text().catch(() => "")) || `HTTP ${runRes.status}`}`);
      setDestinations((await destRes.json()).destinations || []);
      setRuns((await runRes.json()).runs || []);
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

  // ─── Full backup, built in the browser ───────────────────────────────
  // One serverless function can neither hold nor finish a multi-GB zip —
  // the old server-built path hung forever and delivered nothing. Files now
  // stream browser→storage directly and pack into ~300MB zip parts with
  // live progress; a failed file lands in the report instead of killing
  // the run.
  const downloadZip = async () => {
    if (!activeOrgId || backupIsRunning()) return;
    setBusyZip(true); setError(null);
    try {
      await startGlobalBackup(activeOrgId);
      void refresh();
    } catch (e) {
      setError(`The backup didn't finish: ${(e as Error).message}`);
    } finally { setBusyZip(false); }
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
    if (!(await appConfirm({ message: "Delete this destination? Scheduled exports for it will stop. This cannot be undone.", tone: "danger" }))) return;
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/data-export/destinations/${id}?orgId=${activeOrgId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
    } catch (e) {
      setError(`Couldn't delete the destination: ${(e as Error).message}`);
      return;
    }
    void refresh();
  };

  // The answer: when the data last left the building.
  const lastRun = runs[0];
  const lastAt = lastRun ? new Date(lastRun.completed_at || lastRun.started_at) : null;
  const answer = !isAuthorized ? "Admin, Manager and Doc Control only."
    : loading ? "Data export"
    : lastAt ? `Last export ${lastAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${lastAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`
    : "No exports yet.";

  const failedRuns = runs.filter((r) => r.status === "failed").length;

  return (
    <PageShell width="work">
        <PageHero
          kicker="Admin · Data export and backup"
          title={answer}
          sub="Your data, yours to take any time. Every export is in the audit log."
          facts={isAuthorized && !loading ? [
            { label: "Destinations", value: destinations.length },
            { label: "Exports", value: runs.length },
            { label: "Failed", value: failedRuns, tone: failedRuns > 0 ? "bad" : undefined },
          ] : undefined}
          tools={<Link href="/data-portability" target="_blank" className={`text-[14px] inline-flex items-center gap-1 ${link}`}>Our data promise <ExternalLink className="w-3.5 h-3.5" /></Link>}
        />

        <PageBody>
        {!isAuthorized && (
          <p className="text-[15px] text-[var(--color-text-muted)] flex items-start gap-2">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" /> Only Admin, Manager or DocCtrl roles manage data exports.
          </p>
        )}

        {error && <Problem retry={() => void refresh()}>{error}</Problem>}

        {/* ──── DIRECT DOWNLOAD ──── */}
        {isAuthorized && (
          <Section label="Download now" icon={Download}>
            <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
              <FormRow label={<span className="inline-flex items-center gap-2"><span aria-hidden className="ui-icon-tile is-sm"><FileJson className="w-4 h-4" /></span> JSON only</span>} hint="Records, plus a list of files with links that work for 24 hours.">
                <button type="button" onClick={downloadJson} disabled={busyJson || !activeOrgId} className={btnQuiet}>
                  {busyJson ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download JSON
                </button>
              </FormRow>
              <FormRow label={<span className="inline-flex items-center gap-2"><span aria-hidden className="ui-icon-tile is-sm"><FileArchive className="w-4 h-4" /></span> Full ZIP with files</span>} hint="Records and every PDF and DWG, in parts of about 300 MB. Allow several downloads when the browser asks.">
                <button type="button" onClick={downloadZip} disabled={busyZip || !activeOrgId} className={btnPrimary}>
                  {busyZip ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  {busyZip ? "Building backup…" : "Download full ZIP"}
                </button>
                {backupProgress && busyZip && (
                  <div className="mt-3 space-y-1.5 max-w-xl">
                    <div className="h-2 rounded-sm bg-[var(--color-surface-2)] overflow-hidden">
                      <div className="h-full bg-[var(--color-text)] transition-all duration-300"
                        style={{ width: `${backupProgress.filesTotal > 0 ? Math.round((backupProgress.filesDone / backupProgress.filesTotal) * 100) : 5}%` }} />
                    </div>
                    <div className="flex items-center justify-between gap-3 text-[13px] text-[var(--color-text-muted)]">
                      <span className="truncate">
                        {backupProgress.phase === "envelope" && "Reading every table…"}
                        {backupProgress.phase === "files" &&
                          `File ${backupProgress.filesDone + 1} of ${backupProgress.filesTotal}, ${(backupProgress.bytesDone / 1048576).toFixed(0)} MB, part ${backupProgress.part}` +
                          (backupProgress.currentPath ? `: ${backupProgress.currentPath.split("/").pop()}` : "")}
                        {backupProgress.phase === "finalizing" && `Packing part ${backupProgress.part}…`}
                      </span>
                      <button type="button" onClick={cancelBackup} className={btnRow}>Cancel</button>
                    </div>
                    <div className="text-[13px] text-[var(--color-text-muted)]">You can keep working; the corner card follows it. Don&apos;t close the tab.</div>
                    {backupProgress.errors.length > 0 && (
                      <StatusTag tone="warn">{backupProgress.errors.length} file(s) didn&apos;t make it so far. They&apos;re listed in backup-report.json.</StatusTag>
                    )}
                  </div>
                )}
                {backupProgress?.phase === "done" && !busyZip && (
                  <p role="status" className="mt-2"><StatusTag tone="good">Backup complete: {backupProgress.part} part(s), every file checked (SHA-256).</StatusTag></p>
                )}
              </FormRow>
            </div>
          </Section>
        )}

        {/* ──── DESTINATIONS ──── */}
        {isAuthorized && (
          <Section icon={Send} label={<span className="inline-flex items-center gap-2">Scheduled destinations <HelpTooltip>Your own S3 or R2 bucket, or a webhook. A fresh export goes there on your schedule. Keys are stored encrypted (AES-256-GCM) and only opened at push time.</HelpTooltip></span>}
            action={<button type="button" onClick={() => setCreating(true)} className={btnQuiet}><Plus className="w-3.5 h-3.5" /> New destination</button>}>
            {loading ? (
              <div className={`${sheet} px-4 py-3 flex items-center gap-2 text-[15px] text-[var(--color-text-muted)]`}><Spinner size="sm" /> Loading destinations…</div>
            ) : destinations.length === 0 ? (
              <div className={`${sheet} px-4 py-6 text-center text-[15px] text-[var(--color-text-muted)]`}>No destinations yet.</div>
            ) : (
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={`${tbl.thead} max-md:hidden`}>
                    <tr>
                      <th className={tbl.th}>Destination</th>
                      <th className={tbl.th}>Schedule</th>
                      <th className={`${tbl.th} max-lg:hidden`}>Last run</th>
                      <th className={`${tbl.th} max-lg:hidden`}>Next run</th>
                      <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {destinations.map((d) => (
                      <DestinationRow
                        key={d.id}
                        dest={d}
                        busy={busyDestId === d.id}
                        onRun={() => runDestinationNow(d.id)}
                        onTest={() => testConnection(d.id)}
                        onEdit={() => setEditing(d)}
                        onDelete={() => deleteDestination(d.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}

        {/* ──── RUN HISTORY ──── */}
        {isAuthorized && (
          <Section label="Export history" icon={History}
            action={
              <button type="button" onClick={() => void refresh()} className={btnQuiet}>
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            }>
            {runs.length === 0 ? (
              <div className={`${sheet} px-4 py-6 text-center text-[15px] text-[var(--color-text-muted)]`}>No exports run yet.</div>
            ) : (
              <div className={tbl.wrap}>
                <table className={tbl.table}>
                  <thead className={`${tbl.thead} max-md:hidden`}>
                    <tr>
                      <th className={tbl.th}>When</th>
                      <th className={tbl.th}>Went to</th>
                      <th className={tbl.th}>Status</th>
                      <th className={`${tbl.th} max-lg:hidden`}>Run by</th>
                      <th className={`${tbl.th} text-right`}>Size</th>
                    </tr>
                  </thead>
                  <tbody className={tbl.tbody}>
                    {runs.map((r) => <RunRow key={r.id} run={r} />)}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}
        </PageBody>

      {(creating || editing) && activeOrgId && (
        <DestinationModal
          mode={creating ? "create" : "edit"}
          existing={editing ?? undefined}
          orgId={activeOrgId}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); void refresh(); }}
        />
      )}
    </PageShell>
  );
}

// ─── Destination row ──────────────────────────────────────────────────────

function DestinationRow({
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
    catch (e) { setTestResult({ ok: false, error: (e as Error).message }); }
    finally { setTesting(false); }
  };

  const Ico = dest.destination_type === "webhook" ? Webhook : dest.destination_type === "r2" ? HardDrive : ArchiveIcon;
  const icon = <span aria-hidden className={`ui-icon-tile is-sm ${dest.enabled ? "" : "!bg-[var(--color-surface-2)] !text-[var(--color-text-muted)]"}`}><Ico className="w-4 h-4" /></span>;
  const target = dest.destination_type === "webhook"
    ? dest.webhook_url
    : `${dest.endpoint || dest.region || ""} ${dest.bucket || ""}${dest.prefix ? "/" + dest.prefix : ""}`.trim();
  const sched = dest.schedule_kind === "manual" ? "By hand"
    : `${dest.schedule_kind[0].toUpperCase()}${dest.schedule_kind.slice(1)}${dest.schedule_hour_utc != null ? `, ${String(dest.schedule_hour_utc).padStart(2, "0")}:00 UTC` : ""}`;

  return (
    <tr className={`${tbl.tr} max-md:flex max-md:flex-col max-md:py-1`}>
      <td className={`${tbl.td} relative align-top max-md:py-1`}>
        {dest.last_run_status === "failed" && <RowEdge tone="bad" />}
        <div className="flex items-center gap-2 flex-wrap">
          {icon}
          <span className="font-semibold text-[var(--color-text)]">{dest.name}</span>
          <span className="ui-tag">{dest.destination_type === "webhook" ? "Webhook" : dest.destination_type.toUpperCase()}</span>
          {!dest.enabled && <Pill>Turned off</Pill>}
          {!dest.include_files && <Pill tone="brand">Records only</Pill>}
        </div>
        <div className="mt-0.5 text-[13px] text-[var(--color-text-muted)] truncate max-w-[52ch]" title={target ?? undefined}>{target}{dest.retention_days ? `, kept ${dest.retention_days} days` : ""}</div>
        {dest.last_run_error && <p className="mt-1 text-[13px] font-semibold text-[var(--state-overdue)]">{dest.last_run_error}</p>}
        {testResult && (
          <p role="status" className="mt-1">
            {testResult.ok ? <Pill tone="good">Connection works</Pill> : <StatusTag tone="bad" colored>Test failed: {testResult.error}</StatusTag>}
          </p>
        )}
      </td>
      <td className={`${tbl.td} align-top max-md:py-1 whitespace-nowrap text-[14px] text-[var(--color-text)]`}>{sched}</td>
      <td className={`${tbl.td} align-top max-lg:hidden whitespace-nowrap`}>
        {dest.last_run_at
          ? <Pill tone={dest.last_run_status === "failed" ? "bad" : "good"}>{shortDateTime(dest.last_run_at)}</Pill>
          : <span className="text-[14px] text-[var(--color-text-muted)]">Not yet</span>}
      </td>
      <td className={`${tbl.td} align-top max-lg:hidden whitespace-nowrap text-[14px] text-[var(--color-text-muted)]`}>{dest.next_run_at ? shortDateTime(dest.next_run_at) : ""}</td>
      <td className={`${tbl.td} align-top max-md:py-1`}>
        <div className="flex items-center md:justify-end gap-1">
          <button type="button" onClick={onRun} disabled={busy} className={btnRow}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cpu className="w-3.5 h-3.5" />} Run now
          </button>
          <button type="button" onClick={() => void doTest()} disabled={testing} title="Test connection" aria-label="Test connection" className={btnIcon}>
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <TestTube className="w-4 h-4" />}
          </button>
          <button type="button" onClick={onEdit} title="Edit" aria-label={`Edit ${dest.name}`} className={btnIcon}>
            <Edit3 className="w-4 h-4" />
          </button>
          <button type="button" onClick={onDelete} title="Delete" aria-label={`Delete ${dest.name}`} className={`${btnIcon} hover:text-[var(--state-overdue)]`}>
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Run history row ──────────────────────────────────────────────────────

function RunRow({ run }: { run: Run }) {
  const ago = run.completed_at || run.started_at;
  const dur = run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : null;
  const status = run.status === "succeeded" ? <Pill tone="good">Done</Pill>
    : run.status === "failed" ? <Pill tone="bad">Failed</Pill>
    : run.status === "running" ? <Pill tone="warn"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running</Pill>
    : <Pill>{run.status.charAt(0).toUpperCase() + run.status.slice(1)}</Pill>;
  return (
    <tr className={`${tbl.tr} max-md:flex max-md:flex-col max-md:py-1`}>
      <td className={`${tbl.td} relative align-top max-md:py-0.5 whitespace-nowrap text-[14px] text-[var(--color-text)]`}>
        {run.status === "failed" && <RowEdge tone="bad" />}
        {shortDateTime(ago)}{dur && <span className="text-[var(--color-text-muted)]">, {dur}</span>}
      </td>
      <td className={`${tbl.td} align-top max-md:py-0.5`}>
        <span className="font-semibold text-[var(--color-text)]">{run.destination_name || "Direct download"}</span>
        {run.trigger_type && <span className="ml-2 ui-tag !h-6 !text-[12.5px]">{run.trigger_type}</span>}
        {run.destination_path && <div className="text-[13px] text-[var(--color-text-muted)] truncate max-w-[48ch]" title={run.destination_path}>{run.destination_path}</div>}
        {run.error_message && <p className="mt-0.5 text-[13px] font-semibold text-[var(--state-overdue)]">{run.error_message}</p>}
      </td>
      <td className={`${tbl.td} align-top max-md:py-0.5`}>{status}</td>
      <td className={`${tbl.td} align-top max-lg:hidden text-[14px] text-[var(--color-text-muted)]`}>{run.triggered_by_email ?? ""}</td>
      <td className={`${tbl.td} align-top max-md:py-0.5 md:text-right text-[14px] text-[var(--color-text-muted)] whitespace-nowrap`}>
        {run.total_bytes != null && <span className="text-[var(--color-text)] tabular-nums">{formatBytes(run.total_bytes)}</span>}
        {(run.table_count != null || run.file_count != null) && (
          <div className="tabular-nums">{run.total_rows != null ? `${run.total_rows.toLocaleString()} rows` : ""}{run.file_count != null ? `, ${run.file_count} files` : ""}</div>
        )}
      </td>
    </tr>
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

  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

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
    <div role="dialog" aria-modal="true" aria-label={`${mode === "create" ? "New" : "Edit"} backup destination`} className="fixed inset-0 z-[200] bg-[var(--color-ink)]/60 animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-xl bg-[var(--color-surface)] rounded-lg shadow-2xl border border-[var(--color-border)] overflow-hidden my-8 animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <div className="font-display text-[19px] font-semibold text-[var(--color-text)]">{mode === "create" ? "New" : "Edit"} backup destination</div>
            <div className="text-[14px] text-[var(--color-text-muted)]">Keys are stored encrypted and only opened at push time.</div>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <Field label="Name *">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Cold Storage" />
          </Field>

          <Field label="Destination type">
            <div className={`${bandSeg} w-full`}>
              {(["s3", "r2", "webhook"] as const).map((t) => (
                <button key={t} onClick={() => setType(t)} className={`${bandSegItem(type === t)} flex-1 justify-center`}>
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </Field>

          {(type === "s3" || type === "r2") && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Endpoint" hint={type === "r2" ? "https://<account>.r2.cloudflarestorage.com" : "https://s3.<region>.amazonaws.com"}>
                  <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://..." />
                </Field>
                <Field label="Region"><Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Bucket *"><Input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-backups" /></Field>
                <Field label="Prefix" hint="Optional folder inside the bucket"><Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="manufacturing-os" /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Access Key ID *" hint={mode === "edit" && existing?.has_access_key ? "Already set; leave blank to keep" : ""}>
                  <Input type="password" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Secret Access Key *" hint={mode === "edit" && existing?.has_secret_key ? "Already set; leave blank to keep" : ""}>
                  <Input type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} autoComplete="off" />
                </Field>
              </div>
            </>
          )}

          {type === "webhook" && (
            <>
              <Field label="Webhook URL *">
                <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://example.com/backups/incoming" />
              </Field>
              <Field label="Signing secret" hint="If set, requests carry X-MOS-Signature: sha256=<HMAC>">
                <Input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} autoComplete="off" />
              </Field>
            </>
          )}

          <Field label="Schedule">
            <div className={`${bandSeg} w-full`}>
              {(["manual", "daily", "weekly", "monthly"] as const).map((s) => (
                <button key={s} onClick={() => setSchedule(s)} className={`${bandSegItem(schedule === s)} flex-1 justify-center`}>
                  {s}
                </button>
              ))}
            </div>
          </Field>

          {schedule !== "manual" && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Due from (UTC hour)">
                <Input type="number" min={0} max={23} value={hourUtc} onChange={(e) => setHourUtc(Number(e.target.value))} />
                <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">It goes out at the daily run (about 5:00 AM UTC) once due.</p>
              </Field>
              {schedule === "weekly" && (
                <Field label="Day of week">
                  <Select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </Select>
                </Field>
              )}
              {schedule === "monthly" && (
                <Field label="Day of month">
                  <Input type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} />
                </Field>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Include file binaries">
              <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} /> Include PDFs/DWGs inline</label>
            </Field>
            <Field label="Retention (days)" hint="Delete older exports in your bucket">
              <Input type="number" min={1} value={retentionDays === "" ? "" : retentionDays} onChange={(e) => setRetentionDays(e.target.value === "" ? "" : Number(e.target.value))} placeholder="(unlimited)" />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>

          {error && (
            <p role="alert" className="text-[14px] font-semibold text-[var(--state-overdue)] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </p>
          )}
        </div>

        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={btnQuiet}>Cancel</button>
          <button type="button" onClick={save} disabled={busy} className={btnPrimary}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {mode === "create" ? "Create Destination" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[13px] font-semibold text-[var(--color-text-muted)]">{label}</label>
      {hint && <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">{hint}</div>}
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
