"use client";

// /admin/data-export: take your data out, any time.
//
//   1. Download now: the records as JSON, or the full backup (records and
//      every file) built in the browser, in parts.
//   2. Scheduled destinations: a fresh export pushed to the customer's own
//      S3 / R2 bucket or a webhook, on a schedule.
//   3. Export history: every export, manual or scheduled.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Download, Loader2, Plus, Trash2, TestTube, RefreshCw, Lock, ExternalLink, Edit3, Play } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { startGlobalBackup, subscribeBackup, cancelBackup, backupIsRunning, type BackupProgress } from "@/lib/clientBackup";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody } from "@/components/ui/PageHero";
import { bandSeg, bandSegItem, plural } from "@/components/admin/band";
import { tbl, sheet, link, btnQuiet, btnRow, btnIcon, FormRow, Section, StatusTag, RowEdge, Problem, shortDateTime, type Tone } from "@/components/admin/kit";
import { said, responseError } from "@/components/admin/said";
import { errorKind } from "@/lib/friendlyError";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { Field, Input, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { SkeletonRows } from "@/components/ui/Skeleton";
import MoreMenu from "@/components/ui/MoreMenu";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
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

const TYPE_WORD: Record<Destination["destination_type"], string> = { s3: "S3", r2: "R2", webhook: "Webhook" };

/** A push that failed, in plain words. A refused or unreachable address is
 *  the destination's side, not this person's connection. */
function pushError(e: unknown, lead?: string): string {
  if (errorKind(e) === "network") return `${lead ? `${lead} ` : ""}The destination didn't answer. Check its address and that it's online.`;
  return said(e, lead);
}

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
      if (!destRes.ok) throw await responseError(destRes);
      if (!runRes.ok) throw await responseError(runRes);
      setDestinations((await destRes.json()).destinations || []);
      setRuns((await runRes.json()).runs || []);
      setError(null);
    } catch (e) {
      setError(said(e, "Couldn't load the destinations and export history."));
    } finally { setLoading(false); }
  }, [activeOrgId, isAuthorized]);

  useEffect(() => { void refresh(); }, [refresh]);

  // ─── Records as JSON, straight down ──────────────────────────────────
  const downloadJson = async () => {
    if (!activeOrgId) return;
    setBusyJson(true); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/data-export/structured?orgId=${activeOrgId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw await responseError(res);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `manufacturing-os-export-${Date.now()}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { setError(said(e, "The JSON download didn't finish.")); }
    finally { setBusyJson(false); }
  };

  // ─── Full backup, built in the browser ───────────────────────────────
  // One server function can neither hold nor finish a multi-GB zip, so
  // files stream browser→storage and pack into ~300 MB parts with live
  // progress; a failed file lands in the report instead of ending the run.
  const downloadZip = async () => {
    if (!activeOrgId || backupIsRunning()) return;
    setBusyZip(true); setError(null);
    try {
      await startGlobalBackup(activeOrgId);
      void refresh();
    } catch (e) {
      setError(said(e, "The backup didn't finish."));
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
      if (!res.ok) throw await responseError(res);
      void refresh();
    } catch (e) { setError(said(e, "Couldn't start the export.")); }
    finally { setBusyDestId(null); }
  };

  // ─── Test connection ─────────────────────────────────────────────────
  const testConnection = async (id: string): Promise<{ ok: boolean; error?: string }> => {
    if (!activeOrgId) return { ok: false, error: "Pick a workspace first." };
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    const res = await fetch(`/api/data-export/destinations/${id}/test?orgId=${activeOrgId}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, error: (await responseError(res)).message };
    return await res.json();
  };

  const deleteDestination = async (d: Destination) => {
    if (!activeOrgId) return;
    if (!(await appConfirm({ message: `Delete ${d.name}? Scheduled exports to it stop. Files already sent stay where they are. This can't be undone.`, tone: "danger", confirmLabel: "Delete" }))) return;
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/data-export/destinations/${d.id}?orgId=${activeOrgId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw await responseError(res);
    } catch (e) {
      setError(said(e, "Couldn't delete the destination."));
      return;
    }
    void refresh();
  };

  // The answer: when the data last left the building.
  const lastRun = runs[0];
  const lastAt = lastRun ? (lastRun.completed_at || lastRun.started_at) : null;
  const answer = !isAuthorized ? "Admin, Manager and Doc Control only."
    : loading && runs.length === 0 ? "Data export"
    : lastAt ? `Last export ${shortDateTime(lastAt)}.`
    : "No exports yet.";

  const failedRuns = runs.filter((r) => r.status === "failed").length;
  const progressPct = backupProgress && backupProgress.filesTotal > 0 ? Math.round((backupProgress.filesDone / backupProgress.filesTotal) * 100) : null;

  return (
    <PageShell width="work">
        <PageHero
          kicker="Admin · Data export"
          title={answer}
          sub={isAuthorized ? "Your data, yours to take any time. Every export is written to the audit log." : "Ask an admin to export the workspace's data."}
          factsHero={failedRuns > 0 ? "auto" : "none"}
          facts={isAuthorized && !(loading && runs.length === 0) ? [
            ...(failedRuns > 0 ? [{ label: "Failed exports", value: failedRuns, tone: "bad" as const, hero: true }] : []),
            { label: "Destinations", value: destinations.length },
            { label: "Exports", value: runs.length },
          ] : undefined}
          tools={<Link href="/data-portability" target="_blank" className={`text-body inline-flex items-center gap-1 ${link}`}>Our data promise <ExternalLink aria-hidden className="w-3.5 h-3.5" /></Link>}
        />

        <PageBody>
        {!isAuthorized && (
          <p className="text-reading text-[var(--color-text-muted)] flex items-start gap-2">
            <Lock aria-hidden className="w-4 h-4 mt-0.5 shrink-0" /> Only Admin, Manager and Doc Control manage data exports.
          </p>
        )}

        {error && <Problem retry={() => void refresh()}>{error}</Problem>}

        {/* ──── DOWNLOAD NOW ──── */}
        {isAuthorized && (
          <Section label="Download now">
            <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
              <FormRow label="Full backup" hint="Records and every PDF and DWG, in parts of about 300 MB. Allow several downloads when the browser asks.">
                <div className="flex flex-wrap items-center gap-3">
                  <Button loading={busyZip} disabled={!activeOrgId} onClick={() => void downloadZip()}>
                    {!busyZip && <Download className="w-4 h-4" />}
                    {busyZip ? "Building backup" : "Download full backup"}
                  </Button>
                  {busyZip && backupProgress && <button type="button" onClick={cancelBackup} className={btnRow}>Stop</button>}
                </div>
                {backupProgress && busyZip && (
                  <div className="mt-3 space-y-1.5 max-w-xl" aria-live="polite">
                    <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct ?? undefined} aria-label="Backup progress">
                      <div className="h-full rounded-full bg-[var(--color-text)] transition-[width] duration-300 motion-reduce:transition-none"
                        style={{ width: `${progressPct ?? 5}%` }} />
                    </div>
                    <p className="text-body text-[var(--color-text-muted)] tabular-nums truncate">
                      {backupProgress.phase === "envelope" && "Step 1 of 3: reading every table"}
                      {backupProgress.phase === "files" &&
                        `Step 2 of 3: file ${(backupProgress.filesDone + 1).toLocaleString()} of ${backupProgress.filesTotal.toLocaleString()}, ${(backupProgress.bytesDone / 1048576).toFixed(0)} MB, part ${backupProgress.part}` +
                        (backupProgress.currentPath ? `: ${backupProgress.currentPath.split("/").pop()}` : "")}
                      {backupProgress.phase === "finalizing" && `Step 3 of 3: packing part ${backupProgress.part}`}
                    </p>
                    <p className="text-body text-[var(--color-text-muted)]">You can keep working; the corner card follows it. Keep this tab open.</p>
                    {backupProgress.errors.length > 0 && (
                      <StatusTag tone="warn">{plural(backupProgress.errors.length, "file")} didn&apos;t make it so far. They&apos;re listed in backup-report.json.</StatusTag>
                    )}
                  </div>
                )}
                {backupProgress?.phase === "done" && !busyZip && (
                  <p role="status" className="mt-2 text-body text-[var(--color-text)]">Backup complete: {plural(backupProgress.part, "part")}, every file checked (SHA-256).</p>
                )}
              </FormRow>
              <FormRow label="Records only" hint="Every record as JSON, with a list of files whose links work for 24 hours.">
                <button type="button" onClick={() => void downloadJson()} disabled={busyJson || !activeOrgId} className={btnQuiet}>
                  {busyJson ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download JSON
                </button>
              </FormRow>
            </div>
          </Section>
        )}

        {/* ──── DESTINATIONS ──── */}
        {isAuthorized && (
          <Section label={<>Scheduled destinations <HelpTooltip>Your own S3 or R2 bucket, or a webhook. A fresh export goes there on your schedule. Keys are stored encrypted (AES-256-GCM) and only opened at push time.</HelpTooltip></>}
            count={destinations.length}
            action={<button type="button" onClick={() => setCreating(true)} className={btnQuiet}><Plus className="w-4 h-4" /> New destination</button>}>
            {loading && destinations.length === 0 ? (
              <SkeletonRows rows={2} cols={3} what="destinations" />
            ) : destinations.length === 0 ? (
              <div className={`${sheet} px-4 py-6 text-center`}>
                <p className="text-reading text-[var(--color-text)]">Nothing is pushed out on a schedule yet.</p>
                <button type="button" onClick={() => setCreating(true)} className={`${link} mt-1.5 font-medium`}>Add a destination</button>
              </div>
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
                        onDelete={() => deleteDestination(d)}
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
          <Section label="Export history"
            action={
              <button type="button" onClick={() => void refresh()} disabled={loading} className={btnIcon} aria-label="Check again" title="Check again">
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </button>
            }>
            {loading && runs.length === 0 ? (
              <SkeletonRows rows={3} cols={3} what="export history" />
            ) : runs.length === 0 ? (
              <div className={`${sheet} px-4 py-6 text-center text-reading text-[var(--color-text-muted)]`}>Every export, by hand or on a schedule, shows here.</div>
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

function scheduleWords(d: Destination): string {
  if (d.schedule_kind === "manual") return "By hand";
  const kind = `${d.schedule_kind[0].toUpperCase()}${d.schedule_kind.slice(1)}`;
  return d.schedule_hour_utc != null ? `${kind}, from ${String(d.schedule_hour_utc).padStart(2, "0")}:00 UTC` : kind;
}

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
    catch (e) { setTestResult({ ok: false, error: said(e) }); }
    finally { setTesting(false); }
  };

  const target = dest.destination_type === "webhook"
    ? dest.webhook_url
    : `${dest.endpoint || dest.region || ""} ${dest.bucket || ""}${dest.prefix ? "/" + dest.prefix : ""}`.trim();
  const failed = dest.last_run_status === "failed";

  return (
    <tr className={`${tbl.tr} max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:py-1.5`}>
      <td className={`${tbl.td} relative align-top max-md:py-1`}>
        {failed && <RowEdge tone="bad" />}
        <div className="flex items-baseline gap-x-2 gap-y-0.5 flex-wrap">
          <span className="font-medium text-[var(--color-text)]">{dest.name}</span>
          <span className="text-body text-[var(--color-text-muted)]">{TYPE_WORD[dest.destination_type]}{dest.include_files ? "" : ", records only"}</span>
          {!dest.enabled && <StatusTag tone="none">Turned off</StatusTag>}
        </div>
        <div className="mt-0.5 text-body text-[var(--color-text-muted)] truncate max-w-[52ch]" title={target ?? undefined}>{target}{dest.retention_days ? `, kept ${dest.retention_days} days` : ""}</div>
        {dest.last_run_error && <p className="mt-1 text-body font-medium text-[var(--state-overdue-text)]">{pushError(dest.last_run_error, "The last push failed.")}</p>}
        {testResult && (
          <p role="status" className="mt-1 text-body">
            {testResult.ok ? <StatusTag tone="good" colored={false}>Connection works</StatusTag> : <span className="font-medium text-[var(--state-overdue-text)]">{pushError(testResult.error, "The test failed.")}</span>}
          </p>
        )}
      </td>
      <td className={`${tbl.td} align-top max-md:col-span-2 max-md:row-start-2 max-md:py-0.5 whitespace-nowrap text-body text-[var(--color-text)]`}>
        {scheduleWords(dest)}
        <div className="lg:hidden text-body text-[var(--color-text-muted)]">
          {dest.last_run_at ? `Last ${shortDateTime(dest.last_run_at)}${failed ? ", failed" : ""}` : "Not run yet"}
        </div>
      </td>
      <td className={`${tbl.td} align-top max-lg:hidden whitespace-nowrap`}>
        {dest.last_run_at
          ? <StatusTag tone={failed ? "bad" : "none"} colored={failed}>{failed ? "Failed " : ""}{shortDateTime(dest.last_run_at)}</StatusTag>
          : <span className="text-body text-[var(--color-text-muted)]">Not yet</span>}
      </td>
      <td className={`${tbl.td} align-top max-lg:hidden whitespace-nowrap text-body text-[var(--color-text-muted)]`}>{dest.next_run_at ? shortDateTime(dest.next_run_at) : <span className="text-[var(--color-text-faint)]">By hand</span>}</td>
      <td className={`${tbl.td} align-top max-md:col-start-2 max-md:row-start-1 max-md:py-1`}>
        <div className="flex items-center justify-end gap-1">
          <button type="button" onClick={onRun} disabled={busy} className={btnRow}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run now
          </button>
          {testing
            ? <span className={btnIcon} role="status" aria-label="Testing the connection"><Loader2 className="w-4 h-4 animate-spin" /></span>
            : <MoreMenu iconOnly label={`More for ${dest.name}`} triggerClass={btnIcon} items={[
                { icon: <TestTube className="w-4 h-4" />, label: "Test the connection", onClick: () => doTest() },
                { icon: <Edit3 className="w-4 h-4" />, label: "Edit", onClick: onEdit },
                { icon: <Trash2 className="w-4 h-4" />, label: "Delete", tone: "bad", line: true, onClick: onDelete },
              ]} />}
        </div>
      </td>
    </tr>
  );
}

// ─── Run history row ──────────────────────────────────────────────────────

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const RUN_STATUS: Record<Run["status"], { tone: Tone; word: string }> = {
  succeeded: { tone: "good", word: "Done" },
  failed: { tone: "bad", word: "Failed" },
  running: { tone: "none", word: "Running" },
  pending: { tone: "none", word: "Waiting" },
  cancelled: { tone: "none", word: "Stopped" },
};
const TRIGGER_WORD: Record<Run["trigger_type"], string> = { manual: "by hand", scheduled: "on schedule", api: "through the API" };

function RunRow({ run }: { run: Run }) {
  const at = run.completed_at || run.started_at;
  const st = RUN_STATUS[run.status] ?? { tone: "none" as Tone, word: run.status };
  return (
    <tr className={`${tbl.tr} max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:py-1.5`}>
      <td className={`${tbl.td} relative align-top max-md:py-0.5 whitespace-nowrap text-body text-[var(--color-text)]`}>
        {run.status === "failed" && <RowEdge tone="bad" />}
        {shortDateTime(at)}
        {run.duration_ms ? <div className="text-body text-[var(--color-text-muted)]">Took {duration(run.duration_ms)}</div> : null}
      </td>
      <td className={`${tbl.td} align-top max-md:col-span-2 max-md:row-start-2 max-md:py-0.5`}>
        <span className="font-medium text-[var(--color-text)]">{run.destination_name || "Direct download"}</span>
        {run.trigger_type && <span className="ml-1.5 text-body text-[var(--color-text-muted)]">{TRIGGER_WORD[run.trigger_type] ?? run.trigger_type}</span>}
        {run.destination_path && <div className="text-body text-[var(--color-text-muted)] truncate max-w-[48ch]" title={run.destination_path}>{run.destination_path}</div>}
        {run.error_message && <p className="mt-0.5 text-body font-medium text-[var(--state-overdue-text)]">{pushError(run.error_message)}</p>}
      </td>
      <td className={`${tbl.td} align-top max-md:col-start-2 max-md:row-start-1 max-md:py-0.5 whitespace-nowrap`}>
        <StatusTag tone={st.tone} colored={st.tone === "bad"}>{run.status === "running" && <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin" />}{st.word}</StatusTag>
      </td>
      <td className={`${tbl.td} align-top max-lg:hidden text-body text-[var(--color-text-muted)]`}>{run.triggered_by_email ?? (run.trigger_type === "scheduled" ? "Schedule" : "")}</td>
      <td className={`${tbl.td} align-top max-md:col-span-2 max-md:row-start-3 max-md:py-0.5 md:text-right text-body text-[var(--color-text-muted)] whitespace-nowrap`}>
        {run.total_bytes != null && <span className="text-[var(--color-text)] tabular-nums">{formatBytes(run.total_bytes)}</span>}
        {(run.total_rows != null || run.file_count != null) && (
          <div className="tabular-nums text-body">{[run.total_rows != null ? plural(run.total_rows, "row") : "", run.file_count != null ? plural(run.file_count, "file") : ""].filter(Boolean).join(", ")}</div>
        )}
      </td>
    </tr>
  );
}

// ─── Destination create/edit dialog ───────────────────────────────────────

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

  // What's still missing, said before Save (the server checks again).
  const bucketType = type === "s3" || type === "r2";
  const missing = !name.trim() ? "Give it a name."
    : bucketType && !bucket.trim() ? "Enter the bucket."
    : bucketType && mode === "create" && (!accessKeyId || !secretAccessKey) ? "Enter both keys."
    : bucketType && mode === "edit" && ((!accessKeyId && !existing?.has_access_key) || (!secretAccessKey && !existing?.has_secret_key)) ? "Enter both keys."
    : type === "webhook" && !/^https?:\/\/\S+/i.test(webhookUrl.trim()) ? "Enter the webhook address, starting with https://."
    : null;

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
      if (!res.ok) throw await responseError(res);
      onSaved();
    } catch (e) { setError(said(e, "Couldn't save the destination.")); }
    finally { setBusy(false); }
  };

  const kept = "Already set; leave blank to keep it.";
  return (
    <Modal onClose={onClose} size="lg" dismissable={!busy}>
      <ModalHeader title={mode === "create" ? "New backup destination" : `Edit ${existing?.name ?? "destination"}`}
        subtitle="Keys are stored encrypted and only opened at push time." onClose={busy ? undefined : onClose} />
      <ModalBody className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Kern cold storage" />
        </Field>

        <div>
          <span className="block text-body font-medium text-[var(--color-text)] mb-1.5">Where to</span>
          <div role="radiogroup" aria-label="Where to" className={bandSeg}>
            {(["s3", "r2", "webhook"] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)} className={bandSegItem(type === t)}>
                {TYPE_WORD[t]}
              </button>
            ))}
          </div>
        </div>

        {bucketType && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Endpoint" hint={type === "r2" ? "https://<account>.r2.cloudflarestorage.com" : "https://s3.<region>.amazonaws.com"}>
                <Input type="url" inputMode="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://" />
              </Field>
              <Field label="Region"><Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" /></Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Bucket"><Input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="kern-backups" /></Field>
              <Field label="Folder in the bucket" hint="Optional"><Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="manufacturing-os" /></Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Access key ID" hint={mode === "edit" && existing?.has_access_key ? kept : undefined}>
                <Input type="password" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Secret access key" hint={mode === "edit" && existing?.has_secret_key ? kept : undefined}>
                <Input type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} autoComplete="off" />
              </Field>
            </div>
          </>
        )}

        {type === "webhook" && (
          <>
            <Field label="Webhook address">
              <Input type="url" inputMode="url" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://example.com/backups/incoming" />
            </Field>
            <Field label="Signing secret" hint={mode === "edit" && existing?.has_webhook_secret ? kept : "Optional. When set, requests carry X-MOS-Signature: sha256=<HMAC>."}>
              <Input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} autoComplete="off" />
            </Field>
          </>
        )}

        <div>
          <span className="block text-body font-medium text-[var(--color-text)] mb-1.5">How often</span>
          <div role="radiogroup" aria-label="How often" className={bandSeg}>
            {(["manual", "daily", "weekly", "monthly"] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={schedule === s} onClick={() => setSchedule(s)} className={bandSegItem(schedule === s)}>
                {s === "manual" ? "By hand" : s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {schedule !== "manual" && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Due from (UTC hour)" hint="It goes out at the daily run (about 5:00 AM UTC) once due.">
              <Input type="number" inputMode="numeric" min={0} max={23} value={hourUtc} onChange={(e) => setHourUtc(Number(e.target.value))} />
            </Field>
            {schedule === "weekly" && (
              <Field label="Day of the week">
                <Select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                  {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={i} value={i}>{d}</option>)}
                </Select>
              </Field>
            )}
            {schedule === "monthly" && (
              <Field label="Day of the month">
                <Input type="number" inputMode="numeric" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} />
              </Field>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
          <label className="flex items-start gap-2.5 text-reading text-[var(--color-text)] min-h-11 pt-2">
            <input type="checkbox" className="mt-1 w-4 h-4" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} />
            <span>Include the files<span className="block text-body text-[var(--color-text-muted)]">PDFs and DWGs, not only records</span></span>
          </label>
          <Field label="Keep exports for (days)" hint="Older exports in your bucket are deleted. Blank keeps them all.">
            <Input type="number" inputMode="numeric" min={1} value={retentionDays === "" ? "" : retentionDays} onChange={(e) => setRetentionDays(e.target.value === "" ? "" : Number(e.target.value))} />
          </Field>
        </div>

        <label className="flex items-center gap-2.5 text-reading text-[var(--color-text)]">
          <input type="checkbox" className="w-4 h-4" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Turned on
        </label>

        {error && <p role="alert" className="text-body font-medium text-[var(--state-overdue-text)]">{error}</p>}
      </ModalBody>
      <ModalFooter>
        {missing && <span className="mr-auto text-body text-[var(--color-text-muted)]">{missing}</span>}
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={() => void save()} loading={busy} disabled={!!missing}>
          {mode === "create" ? "Add destination" : "Save changes"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
