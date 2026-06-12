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
import { Settings, Loader2, AlertTriangle, Zap, Mail, Briefcase, Users, CheckCircle2, XCircle, ExternalLink, RefreshCw, Hash, Save } from "lucide-react";
import Link from "next/link";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { getAiProvider } from "@/lib/ai";
import { formatTicketNumber, getTicketNumberConfig, TICKET_NUMBER_DEFAULTS, type TicketNumberConfig } from "@/lib/ticketNumber";

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

  const provider = getAiProvider();

  useEffect(() => {
    if (!activeOrgId) return;
    (async () => {
      setLoading(true);
      try {
        const { data } = await supabase.from("orgs").select("*").eq("id", activeOrgId).single();
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
          const res = await fetch("/api/notifications/send-queued", { method: "POST" });
          if (res.ok) {
            const j = await res.json();
            setEmailQueueStatus(j?.suppressed_no_key ? "no-key" : "ok");
          }
        } catch { /* leave unknown */ }
      } finally { setLoading(false); }
    })();
  }, [activeOrgId]);

  // Reset dead-letter emails to 'queued' so the next drain retries them.
  const requeueFailed = async () => {
    if (!activeOrgId || requeuing) return;
    setRequeuing(true);
    try {
      await supabase.from("email_notifications")
        .update({ status: "queued", attempt_count: 0 })
        .eq("org_id", activeOrgId).eq("status", "failed").gte("attempt_count", 5);
      await fetch("/api/notifications/send-queued", { method: "POST" }).catch(() => {});
      const { count: dead } = await supabase.from("email_notifications")
        .select("id", { count: "exact", head: true })
        .eq("org_id", activeOrgId).eq("status", "failed").gte("attempt_count", 5);
      setFailedEmails(dead ?? 0);
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
      alert(`Couldn't save numbering: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingNum(false);
    }
  };

  if (!canRead) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-3xl mx-auto bg-white rounded-2xl border border-slate-200 p-6 shadow-sm flex items-start gap-3">
          <Settings className="w-6 h-6 text-slate-500 shrink-0" />
          <div>
            <h1 className="text-xl font-black text-slate-900">Workspace Settings</h1>
            <p className="text-sm text-slate-600 mt-1">Admin-class only.</p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="text-2xl font-black text-slate-900 inline-flex items-center gap-3 mb-6">
          <Settings className="w-7 h-7 text-slate-500" /> Workspace Settings
        </h1>

        {/* Identity */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-4">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Workspace</div>
          <Row icon={Briefcase} label="Name" value={org?.name ?? "—"} />
          <Row icon={Users} label="Members" value={memberCount?.toString() ?? "—"} />
          <Row icon={Briefcase} label="Libraries" value={libraryCount?.toString() ?? "—"} />
          {org?.subscribed_plan && <Row icon={Briefcase} label="Plan" value={org.subscribed_plan} />}
          {org?.subscription_status && <Row icon={Briefcase} label="Status" value={org.subscription_status} />}
        </div>

        {/* Request numbering */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-4">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5" /> Request Numbering
          </div>
          <p className="text-xs text-slate-600 mb-4">
            How new request numbers are built. The sequence is allocated atomically and resets each year, so every number is unique — no collisions even under simultaneous submissions.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Workspace code</span>
              <input
                value={numbering.prefix}
                onChange={(e) => { setNumbering((n) => ({ ...n, prefix: e.target.value.toUpperCase() })); setNumSaved(false); }}
                placeholder="e.g. KE"
                maxLength={8}
                className="mt-1 w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Record code</span>
              <input
                value={numbering.recordCode}
                onChange={(e) => { setNumbering((n) => ({ ...n, recordCode: e.target.value.toUpperCase() })); setNumSaved(false); }}
                placeholder="DDRT"
                maxLength={10}
                className="mt-1 w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Number digits</span>
              <input
                type="number" min={1} max={9}
                value={numbering.pad}
                onChange={(e) => { setNumbering((n) => ({ ...n, pad: Math.min(9, Math.max(1, parseInt(e.target.value || "4", 10))) })); setNumSaved(false); }}
                className="mt-1 w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </label>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs text-slate-500">
              Preview:{" "}
              <span className="font-mono font-bold text-slate-900">{formatTicketNumber(numbering, new Date().getFullYear(), 1)}</span>
            </div>
            <button
              onClick={() => void saveNumbering()}
              disabled={savingNum}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50"
            >
              {savingNum ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : numSaved ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
              {numSaved ? "Saved" : "Save"}
            </button>
          </div>
        </div>

        {/* AI status */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-4">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">AI Assistance</div>
          <div className="flex items-start gap-3">
            <div className={`p-2.5 rounded-lg border ${provider.isReal ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-slate-100 border-slate-200 text-slate-600"}`}>
              <Zap className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-900">{provider.isReal ? "External AI" : "Built-in rules engine"}</span>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider border ${
                  provider.isReal ? "bg-emerald-50 text-emerald-700 border-emerald-300" : "bg-slate-100 text-slate-600 border-slate-300"
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${provider.isReal ? "bg-emerald-500 animate-pulse" : "bg-slate-400"}`} />
                  {provider.isReal ? "Connected" : "Local"}
                </span>
              </div>
              <p className="text-xs text-slate-600 mt-1">
                {provider.isReal
                  ? `An external AI provider is connected. It runs ONLY on explicit actions (e.g. "Analyze note") — never automatically on org data.`
                  : `Everything runs in-browser with zero data egress: capture organizing, reminders, ask-the-site answers, and note intelligence are all deterministic rules over your own database. An external AI provider can optionally be connected via server environment variables; when connected it still only runs on explicit actions.`}
              </p>
            </div>
          </div>
        </div>

        {/* Email delivery */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-4">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Email Delivery</div>
          <div className="flex items-start gap-3">
            <div className={`p-2.5 rounded-lg border ${
              emailQueueStatus === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-700"
              : emailQueueStatus === "no-key" ? "bg-amber-50 border-amber-200 text-amber-700"
              : "bg-slate-100 border-slate-200 text-slate-600"
            }`}>
              <Mail className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-bold text-slate-900 inline-flex items-center gap-2">
                Outbound email
                {emailQueueStatus === "ok" && <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700"><CheckCircle2 className="w-3 h-3" /> Configured</span>}
                {emailQueueStatus === "no-key" && <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700"><XCircle className="w-3 h-3" /> No RESEND_API_KEY</span>}
              </div>
              <p className="text-xs text-slate-600 mt-1">
                Resend powers outbound delivery. Without RESEND_API_KEY set, queued rows are marked as <code className="text-[10px] bg-slate-100 px-1 rounded">suppressed</code> so the queue doesn&apos;t pile up. Per-user opt-outs live at the user&apos;s notification settings page.
              </p>
              <Link href="/settings/notifications" className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-700 hover:text-blue-900 mt-2">
                Open my notification preferences <ExternalLink className="w-2.5 h-2.5" />
              </Link>
            </div>
          </div>

          {/* Dead-letter requeue — failed past the auto-retry cap. */}
          {failedEmails !== null && failedEmails > 0 && (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 flex items-center gap-3">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold text-rose-900">{failedEmails} email{failedEmails === 1 ? "" : "s"} failed to send</div>
                <div className="text-[11px] text-rose-700">They exceeded the {5}-attempt auto-retry. Requeue to try again (e.g. after fixing RESEND_API_KEY).</div>
              </div>
              <button
                onClick={() => void requeueFailed()}
                disabled={requeuing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-50 shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${requeuing ? "animate-spin" : ""}`} /> Requeue
              </button>
            </div>
          )}
          {failedEmails === 0 && (
            <div className="mt-3 text-[11px] text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> No failed deliveries.</div>
          )}
        </div>

        {/* Help banner — what's left unconfigured */}
        {emailQueueStatus === "no-key" && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
            <div className="font-bold flex items-center gap-1.5 mb-1"><AlertTriangle className="w-4 h-4" /> Setup checklist</div>
            <ul className="ml-5 list-disc space-y-0.5">
              <li>Set <code className="bg-amber-100 px-1 rounded">RESEND_API_KEY</code> and <code className="bg-amber-100 px-1 rounded">RESEND_FROM_EMAIL</code> in your env to enable outbound email.</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <Icon className="w-4 h-4 text-slate-400" />
      <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest w-24">{label}</span>
      <span className="text-sm text-slate-900">{value}</span>
    </div>
  );
}
