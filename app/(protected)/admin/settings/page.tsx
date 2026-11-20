"use client";

// /admin/settings — workspace-level settings.
//
// Currently surfaces:
//   - AI provider status (live vs mock, env var hint)
//   - Email delivery status (Resend env vars present?)
//   - Workspace identity (name, type)
//   - Member count, license tier hint
//
// Read-only diagnostics today; future commits will let admins toggle
// org-wide categories from here directly.

import React, { useEffect, useState } from "react";
import { Loader2, AlertTriangle, Zap, Mail, Briefcase, Users, CheckCircle2, XCircle, ExternalLink, RefreshCw, Hash, Save } from "lucide-react";
import Link from "next/link";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { kickEmailDrain } from "@/lib/notifications";
import { formatTicketNumber, getTicketNumberConfig, TICKET_NUMBER_DEFAULTS, type TicketNumberConfig } from "@/lib/ticketNumber";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import { plural } from "@/components/admin/band";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { appAlert } from "@/components/providers/DialogProvider";

const ADMIN_ROLES = new Set(["Admin", "DocCtrl"]);

interface OrgSummary {
  id: string;
  name: string;
  type: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  subscribed_plan: string | null;
  subscription_status: string;
}

export default function WorkspaceSettingsPage() {
  const { activeRole, activeOrgId } = useRole();
  const canRead = !!activeRole && ADMIN_ROLES.has(activeRole);
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [libraryCount, setLibraryCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [emailQueueStatus, setEmailQueueStatus] = useState<"unknown" | "ok" | "no-key">("unknown");
  const [failedEmails, setFailedEmails] = useState<number | null>(null);
  const [requeuing, setRequeuing] = useState(false);
  const [numbering, setNumbering] = useState<TicketNumberConfig>(TICKET_NUMBER_DEFAULTS);
  const [savingNum, setSavingNum] = useState(false);
  const [numSaved, setNumSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!activeOrgId) return;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data, error: orgErr } = await supabase.from("orgs").select("*").eq("id", activeOrgId).single();
        if (orgErr) throw orgErr;
        setOrg(data as OrgSummary);
        setNumbering(await getTicketNumberConfig(activeOrgId));
        const [{ count: members }, { count: libs }] = await Promise.all([
          supabase.from("org_members").select("*", { count: "exact", head: true }).eq("org_id", activeOrgId).eq("status", "active"),
          supabase.from("libraries").select("*", { count: "exact", head: true }).eq("org_id", activeOrgId),
        ]);
        setMemberCount(members ?? 0);
        setLibraryCount(libs ?? 0);

        // Dead-letter emails: failed AND past the auto-retry cap (5 attempts).
        const { count: dead } = await supabase
          .from("email_notifications")
          .select("id", { count: "exact", head: true })
          .eq("org_id", activeOrgId)
          .eq("status", "failed")
          .gte("attempt_count", 5);
        setFailedEmails(dead ?? 0);

        // Probe the queue endpoint
        try {
          const res = await kickEmailDrain();
          if (res?.ok) {
            const j = await res.json();
            setEmailQueueStatus(j?.configured === false ? "no-key" : "ok");
          }
        } catch { /* leave unknown */ }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));
      } finally { setLoading(false); }
    })();
  }, [activeOrgId, reloadTick]);

  // Reset dead-letter emails to 'queued' so the next drain retries them.
  const requeueFailed = async () => {
    if (!activeOrgId || requeuing) return;
    setRequeuing(true);
    try {
      const { error: upErr } = await supabase.from("email_notifications")
        .update({ status: "queued", attempt_count: 0 })
        .eq("org_id", activeOrgId).eq("status", "failed").gte("attempt_count", 5);
      if (upErr) throw upErr;
      await kickEmailDrain();
      const { count: dead } = await supabase.from("email_notifications")
        .select("id", { count: "exact", head: true })
        .eq("org_id", activeOrgId).eq("status", "failed").gte("attempt_count", 5);
      setFailedEmails(dead ?? 0);
    } catch (e) {
      await appAlert({ title: "Couldn't send them again", message: e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e), tone: "danger" });
    } finally { setRequeuing(false); }
  };

  const saveNumbering = async () => {
    if (!activeOrgId || savingNum) return;
    setSavingNum(true);
    setNumSaved(false);
    try {
      const { error } = await supabase.from("orgs").update({
        ticket_prefix: numbering.prefix.trim() || null,
        ticket_record_code: numbering.recordCode.trim() || TICKET_NUMBER_DEFAULTS.recordCode,
        ticket_number_pad: Math.min(9, Math.max(1, numbering.pad || 4)),
      }).eq("id", activeOrgId);
      if (error) throw error;
      setNumSaved(true);
    } catch (e) {
      await appAlert({ message: `Couldn't save numbering: ${e instanceof Error ? e.message : String(e)}`, tone: "danger" });
    } finally {
      setSavingNum(false);
    }
  };

  if (!canRead) {
    return (
      <PageShell width="form">
        <PageHero kicker="Admin · Workspace settings" title="Admin and Doc Control only." sub="Only Admin and Doc Control see workspace settings." size="md" overlap={false} />
      </PageShell>
    );
  }

  if (loading) {
    return <PageShell width="form"><PageHero kicker="Admin · Workspace settings" title="Workspace settings" size="md" overlap={false} /><LoadingBlock what="workspace settings" /></PageShell>;
  }

  // The answer: what needs attention here, else what the workspace holds.
  const answer = loadError && !org ? "Couldn't load the settings."
    : failedEmails ? `${plural(failedEmails, "email")} didn't send.`
    : emailQueueStatus === "no-key" ? "Email isn't set up yet."
    : memberCount == null || libraryCount == null ? "Workspace settings"
    : `${plural(memberCount, "member")}, ${plural(libraryCount, "library", "libraries")}.`;

  return (
    <PageShell width="form">
      <PageHero
        kicker={<>Admin · Workspace settings{org?.name ? ` · ${org.name}` : ""}</>}
        title={answer}
        size="md"
        sub="Request numbering, email delivery and the database check. Saved changes apply to everyone in the workspace."
      />

      <PageBody>
        {/* Identity */}
        <Card label="Workspace">
          {loadError && (
            <p role="alert" className="mb-3 text-[13px] text-red-700 dark:text-red-400">
              Couldn&apos;t load the workspace settings: {loadError}{" "}
              <button type="button" onClick={() => setReloadTick((n) => n + 1)} className="font-bold underline">Try again</button>
            </p>
          )}
          <Row icon={Briefcase} label="Name" value={org?.name ?? "-"} />
          <Row icon={Users} label="Members" value={memberCount?.toString() ?? "-"} />
          <Row icon={Briefcase} label="Libraries" value={libraryCount?.toString() ?? "-"} />
          {org?.subscribed_plan && <Row icon={Briefcase} label="Plan" value={org.subscribed_plan} />}
          {org?.subscription_status && <Row icon={Briefcase} label="Status" value={org.subscription_status} />}
        </Card>

        {/* Request numbering */}
        <Card label={<span className="inline-flex items-center gap-1.5"><Hash className="w-3.5 h-3.5" /> Request numbering</span>}>
          <p className="text-[13px] text-[var(--color-text-muted)] mb-4">
            How new request numbers are built. The count restarts each year and never repeats, even when two are sent at once.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-[0.12em]">Workspace code</span>
              <input
                value={numbering.prefix}
                onChange={(e) => { setNumbering((n) => ({ ...n, prefix: e.target.value.toUpperCase() })); setNumSaved(false); }}
                placeholder="e.g. KE"
                maxLength={8}
                className="mt-1 w-full h-10 px-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg text-[14px] font-semibold text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-[0.12em]">Record code</span>
              <input
                value={numbering.recordCode}
                onChange={(e) => { setNumbering((n) => ({ ...n, recordCode: e.target.value.toUpperCase() })); setNumSaved(false); }}
                placeholder="DDRT"
                maxLength={10}
                className="mt-1 w-full h-10 px-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg text-[14px] font-semibold text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-[0.12em]">Number digits</span>
              <input
                type="number" min={1} max={9}
                value={numbering.pad}
                onChange={(e) => { setNumbering((n) => ({ ...n, pad: Math.min(9, Math.max(1, parseInt(e.target.value || "4", 10))) })); setNumSaved(false); }}
                className="mt-1 w-full h-10 px-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-lg text-[14px] font-semibold text-[var(--color-text)] focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
              />
            </label>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="text-[13px] text-[var(--color-text-muted)]">
              Preview:{" "}
              <span className="font-mono font-bold text-[var(--color-text)]">{formatTicketNumber(numbering, new Date().getFullYear(), 1)}</span>
            </div>
            <button
              onClick={() => void saveNumbering()}
              disabled={savingNum}
              type="button"
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-xl text-[14px] font-extrabold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] shadow-[0_12px_24px_-12px_var(--color-accent)] disabled:opacity-50"
            >
              {savingNum ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : numSaved ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
              {numSaved ? "Saved" : "Save numbering"}
            </button>
          </div>
        </Card>

        {/* AI status */}
        <Card label="AI assistance">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg border bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-text-muted)]">
              <Zap className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <span className="text-[14px] font-bold text-[var(--color-text)]">Per-user keys in Knowledge Libraries</span>
              <p className="text-[13px] text-[var(--color-text-muted)] mt-1">
                AI runs only inside Knowledge Libraries, with a key each person connects and only
                after they accept the data-use agreement. Use is counted per person with a monthly
                spend limit. Nothing runs over your data on its own. Set providers in Knowledge, AI settings.
              </p>
            </div>
          </div>
        </Card>

        {/* Email delivery */}
        <Card label="Email delivery">
          <div className="flex items-start gap-3">
            <div className={`p-2.5 rounded-lg border ${
              emailQueueStatus === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-300"
              : emailQueueStatus === "no-key" ? "bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-300"
              : "bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-text-muted)]"
            }`}>
              <Mail className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="text-[14px] font-bold text-[var(--color-text)] inline-flex items-center gap-2 flex-wrap">
                Outbound email
                {emailQueueStatus === "ok" && <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="w-3 h-3" /> Set up</span>}
                {emailQueueStatus === "no-key" && <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700 dark:text-amber-400"><XCircle className="w-3 h-3" /> No RESEND_API_KEY</span>}
              </div>
              <p className="text-[13px] text-[var(--color-text-muted)] mt-1">
                Resend sends outbound email. Without RESEND_API_KEY, emails wait as <code className="text-[11px] bg-[var(--color-surface-2)] px-1 rounded">queued</code> and all go out once the key is set.
                {emailQueueStatus === "no-key" && <> Set <code className="text-[11px] bg-[var(--color-surface-2)] px-1 rounded">RESEND_API_KEY</code> and <code className="text-[11px] bg-[var(--color-surface-2)] px-1 rounded">RESEND_FROM_EMAIL</code> in the server settings.</>} Each person picks what they get on their own notification settings page.
              </p>
              <Link href="/settings/notifications" className="inline-flex items-center gap-1 text-[13px] font-bold text-[var(--color-text)] underline underline-offset-2 mt-2">
                Open my notification preferences <ExternalLink className="w-2.5 h-2.5" />
              </Link>
            </div>
          </div>

          {/* Dead-letter requeue — failed past the auto-retry cap. */}
          {failedEmails !== null && failedEmails > 0 && (
            <div className="mt-4 border-l-2 border-rose-500 pl-3 flex items-center gap-3">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold text-rose-700 dark:text-rose-400">{failedEmails} email{failedEmails === 1 ? "" : "s"} didn&apos;t send</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">Each was tried 5 times. Send them again once the cause is fixed (for example RESEND_API_KEY).</div>
              </div>
              <button
                onClick={() => void requeueFailed()}
                disabled={requeuing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${requeuing ? "animate-spin" : ""}`} /> Try again
              </button>
            </div>
          )}
          {failedEmails === 0 && (
            <div className="mt-3 text-[13px] text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Nothing failed to send.</div>
          )}
        </Card>

        {/* Database health: are the hand-applied migrations actually applied? */}
        <SchemaHealthCard orgId={activeOrgId} />
      </PageBody>
    </PageShell>
  );
}

// Migrations are pasted into the Supabase SQL editor by hand, and most of
// lib/ silently tolerates missing tables — so a skipped migration shows up
// as a feature that "looks empty", not an error. This card probes every
// expected table/column and names the exact migration files to run.
function SchemaHealthCard({ orgId }: { orgId: string | null }) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | {
        phase: "done";
        healthy: boolean;
        checkedTables: number;
        missingTables: Array<{ table: string; migration: string }>;
        missingColumns: Array<{ table: string; column: string; migration: string; feature: string }>;
        migrationsToRun: string[];
      }
  >({ phase: "idle" });

  const check = React.useCallback(async () => {
    if (!orgId) return;
    setState({ phase: "loading" });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/schema-health?orgId=${encodeURIComponent(orgId)}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setState({ phase: "done", ...j });
    } catch (e) {
      setState({ phase: "error", message: (e as Error).message });
    }
  }, [orgId]);

  useEffect(() => { void check(); }, [check]);

  return (
    <Card label="Database health" action={
        <button
          type="button"
          onClick={() => void check()}
          disabled={state.phase === "loading"}
          className="inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${state.phase === "loading" ? "animate-spin" : ""}`} /> Re-check
        </button>
      }>

      {state.phase === "loading" || state.phase === "idle" ? (
        <div className="text-xs text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking every table the app expects…</div>
      ) : state.phase === "error" ? (
        <div role="alert" className="text-xs text-rose-700 dark:text-rose-400 inline-flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Couldn&apos;t check: {state.message}</div>
      ) : state.healthy ? (
        <div className="text-xs text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" /> All {state.checkedTables} expected tables are there.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-xs font-bold text-amber-800 dark:text-amber-300 inline-flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            {state.missingTables.length + state.missingColumns.length} missing piece{state.missingTables.length + state.missingColumns.length === 1 ? "" : "s"}. Features that use them show nothing until their migration runs.
          </div>
          {state.missingTables.length > 0 && (
            <div className="border-l-2 border-amber-500 pl-3 text-[11px] text-[var(--color-text)] space-y-1">
              {state.missingTables.map((t) => (
                <div key={t.table}><code className="bg-[var(--color-surface-2)] px-1 rounded">{t.table}</code>: run <code className="bg-[var(--color-surface-2)] px-1 rounded">{t.migration}</code></div>
              ))}
            </div>
          )}
          {state.missingColumns.length > 0 && (
            <div className="border-l-2 border-amber-500 pl-3 text-[11px] text-[var(--color-text)] space-y-1">
              {state.missingColumns.map((c) => (
                <div key={`${c.table}.${c.column}`}>
                  <code className="bg-[var(--color-surface-2)] px-1 rounded">{c.table}.{c.column}</code> ({c.feature}): run <code className="bg-[var(--color-surface-2)] px-1 rounded">{c.migration}</code>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Paste the named files from <code className="bg-[var(--color-surface-2)] px-1 rounded">supabase/migrations/</code> into the Supabase SQL editor in filename order, then re-check.
          </p>
        </div>
      )}
    </Card>
  );
}

function Row({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <Icon className="w-4 h-4 text-[var(--color-text-faint)]" />
      <span className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-[0.12em] w-24">{label}</span>
      <span className="text-[14px] text-[var(--color-text)]">{value}</span>
    </div>
  );
}
