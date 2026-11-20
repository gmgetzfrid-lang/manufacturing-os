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
import { Loader2, CheckCircle2, RefreshCw, Hash, Save } from "lucide-react";
import Link from "next/link";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { kickEmailDrain } from "@/lib/notifications";
import { formatTicketNumber, getTicketNumberConfig, TICKET_NUMBER_DEFAULTS, type TicketNumberConfig } from "@/lib/ticketNumber";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody } from "@/components/ui/PageHero";
import { tbl, sheet, field, link, btnPrimary, btnQuiet, FormRow, Section, StatusTag, Problem } from "@/components/admin/kit";
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
      <PageShell width="work">
        <PageHero kicker="Admin · Workspace settings" title="Admin and Doc Control only." sub="Only Admin and Doc Control see workspace settings." overlap={false} />
      </PageShell>
    );
  }

  if (loading) {
    return <PageShell width="work"><PageHero kicker="Admin · Workspace settings" title="Workspace settings" overlap={false} /><LoadingBlock what="workspace settings" /></PageShell>;
  }

  // The answer: what needs attention here, else which workspace this is.
  const answer = loadError && !org ? "Couldn't load the settings."
    : failedEmails ? `${plural(failedEmails, "email")} didn't send.`
    : emailQueueStatus === "no-key" ? "Email isn't set up yet."
    : org?.name ?? "Workspace settings";
  const preview = formatTicketNumber(numbering, new Date().getFullYear(), 1);

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Workspace settings"
        title={answer}
        sub="Saved changes apply to everyone in the workspace."
        facts={memberCount != null && libraryCount != null ? [
          { label: "Members", value: memberCount },
          { label: "Libraries", value: libraryCount },
          ...(failedEmails != null ? [{ label: "Emails not sent", value: failedEmails, tone: failedEmails > 0 ? "bad" as const : undefined }] : []),
        ] : undefined}
      />

      <PageBody>
        {loadError && (
          <Problem retry={() => setReloadTick((n) => n + 1)}>Couldn&apos;t load the workspace settings: {loadError}</Problem>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-6 gap-y-8 items-start">
          {/* Identity */}
          <Section label="Workspace">
            <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
              <FormRow label="Name"><div className="@xl:pt-2 text-[15px] text-[var(--color-text)]">{org?.name ?? "-"}</div></FormRow>
              {org?.subscribed_plan && <FormRow label="Plan"><div className="@xl:pt-2 text-[15px] text-[var(--color-text)] capitalize">{org.subscribed_plan}</div></FormRow>}
              {org?.subscription_status && <FormRow label="Subscription"><div className="@xl:pt-2 text-[15px] text-[var(--color-text)] capitalize">{org.subscription_status}</div></FormRow>}
              <FormRow label="AI assistance" hint="Set providers in Knowledge, AI settings.">
                <p className="@xl:pt-2 text-[15px] text-[var(--color-text)]">Runs only in Knowledge Libraries, on each person&apos;s own key, with a monthly spend limit.</p>
              </FormRow>
            </div>
          </Section>

          {/* Request numbering */}
          <Section label={<span className="inline-flex items-center gap-1.5"><Hash className="w-4 h-4" /> Request numbering</span>}>
            <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
              <FormRow label="Workspace code" htmlFor="num-prefix">
                <input id="num-prefix" value={numbering.prefix}
                  onChange={(e) => { setNumbering((n) => ({ ...n, prefix: e.target.value.toUpperCase() })); setNumSaved(false); }}
                  placeholder="e.g. KE" maxLength={8} className={`${field} max-w-[220px]`} />
              </FormRow>
              <FormRow label="Record code" htmlFor="num-code">
                <input id="num-code" value={numbering.recordCode}
                  onChange={(e) => { setNumbering((n) => ({ ...n, recordCode: e.target.value.toUpperCase() })); setNumSaved(false); }}
                  placeholder="DDRT" maxLength={10} className={`${field} max-w-[220px]`} />
              </FormRow>
              <FormRow label="Number digits" htmlFor="num-pad">
                <input id="num-pad" type="number" min={1} max={9} value={numbering.pad}
                  onChange={(e) => { setNumbering((n) => ({ ...n, pad: Math.min(9, Math.max(1, parseInt(e.target.value || "4", 10))) })); setNumSaved(false); }}
                  className={`${field} max-w-[120px]`} />
              </FormRow>
              <FormRow label="Next number looks like" hint="The count restarts each year and never repeats.">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                  <span className="font-display text-[22px] font-semibold tabular-nums text-[var(--color-text)]">{preview}</span>
                  <button onClick={() => void saveNumbering()} disabled={savingNum} type="button" className={`${btnPrimary} ml-auto`}>
                    {savingNum ? <Loader2 className="w-4 h-4 animate-spin" /> : numSaved ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                    {numSaved ? "Saved" : "Save numbering"}
                  </button>
                </div>
              </FormRow>
            </div>
          </Section>
        </div>

        {/* Email delivery */}
        <Section label="Email delivery" action={<Link href="/settings/notifications" className={`text-[14px] ${link}`}>My notification preferences</Link>}>
          <div className={`${sheet} divide-y divide-[var(--color-border)]`}>
            <FormRow label="Outbound email" hint="Sent through Resend. Each person picks what they get.">
              <div className="@xl:pt-2">
                {emailQueueStatus === "ok" && <StatusTag tone="good">Set up</StatusTag>}
                {emailQueueStatus === "no-key" && (
                  <>
                    <StatusTag tone="warn">Not set up: no RESEND_API_KEY</StatusTag>
                    <p className="mt-1 text-[14px] text-[var(--color-text-muted)]">Emails wait as <code className="font-mono text-[13px]">queued</code> until <code className="font-mono text-[13px]">RESEND_API_KEY</code> and <code className="font-mono text-[13px]">RESEND_FROM_EMAIL</code> are set on the server, then all go out.</p>
                  </>
                )}
                {emailQueueStatus === "unknown" && <span className="text-[15px] text-[var(--color-text-muted)]">Not checked yet</span>}
              </div>
            </FormRow>
            {/* Dead-letter requeue — failed past the auto-retry cap. */}
            {failedEmails !== null && (
              <FormRow label="Didn't send" hint={failedEmails > 0 ? "Each was tried 5 times. Send them again once the cause is fixed." : undefined}>
                <div className="@xl:pt-1 flex flex-wrap items-center gap-4">
                  <span className={`font-display text-[22px] font-semibold tabular-nums ${failedEmails > 0 ? "text-[var(--state-overdue)]" : "text-[var(--color-text)]"}`}>{failedEmails}</span>
                  {failedEmails > 0 ? (
                    <button type="button" onClick={() => void requeueFailed()} disabled={requeuing} className={btnQuiet}>
                      <RefreshCw className={`w-3.5 h-3.5 ${requeuing ? "animate-spin" : ""}`} /> Send again
                    </button>
                  ) : <span className="text-[15px] text-[var(--color-text-muted)]">Nothing failed to send.</span>}
                </div>
              </FormRow>
            )}
          </div>
        </Section>

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

  const missing = state.phase === "done" ? state.missingTables.length + state.missingColumns.length : 0;
  return (
    <Section label="Database health" action={
        <button type="button" onClick={() => void check()} disabled={state.phase === "loading"} className={btnQuiet}>
          <RefreshCw className={`w-3.5 h-3.5 ${state.phase === "loading" ? "animate-spin" : ""}`} /> Check again
        </button>
      }>
      {state.phase === "loading" || state.phase === "idle" ? (
        <div className={`${sheet} px-4 py-3 text-[15px] text-[var(--color-text-muted)] inline-flex w-full items-center gap-2`}><Loader2 className="w-4 h-4 animate-spin" /> Checking every table the app expects…</div>
      ) : state.phase === "error" ? (
        <Problem>Couldn&apos;t check: {state.message}</Problem>
      ) : state.healthy ? (
        <div className={`${sheet} px-4 py-3`}><StatusTag tone="good">All {state.checkedTables} expected tables are there.</StatusTag></div>
      ) : (
        <div className={tbl.wrap}>
          <div className="px-4 py-3 border-b border-[var(--color-border)]">
            <StatusTag tone="warn">{missing} missing piece{missing === 1 ? "" : "s"}</StatusTag>
            <span className="ml-2 text-[14px] text-[var(--color-text-muted)]">Features that use them show nothing until their migration runs.</span>
          </div>
          <table className={tbl.table}>
            <thead className={tbl.thead}>
              <tr><th className={tbl.th}>Missing</th><th className={`${tbl.th} max-sm:hidden`}>Used by</th><th className={tbl.th}>Run this migration</th></tr>
            </thead>
            <tbody className={`${tbl.tbody} text-[14px]`}>
              {state.missingTables.map((t) => (
                <tr key={t.table}><td className={tbl.td}><code className="font-mono text-[13px]">{t.table}</code></td><td className={`${tbl.td} max-sm:hidden text-[var(--color-text-muted)]`}>Table</td><td className={tbl.td}><code className="font-mono text-[13px]">{t.migration}</code></td></tr>
              ))}
              {state.missingColumns.map((c) => (
                <tr key={`${c.table}.${c.column}`}><td className={tbl.td}><code className="font-mono text-[13px]">{c.table}.{c.column}</code></td><td className={`${tbl.td} max-sm:hidden text-[var(--color-text-muted)]`}>{c.feature}</td><td className={tbl.td}><code className="font-mono text-[13px]">{c.migration}</code></td></tr>
              ))}
            </tbody>
          </table>
          <p className={`${tbl.foot} text-[var(--color-text-muted)]`}>
            Paste the files from supabase/migrations/ into the Supabase SQL editor in filename order, then check again.
          </p>
        </div>
      )}
    </Section>
  );
}

