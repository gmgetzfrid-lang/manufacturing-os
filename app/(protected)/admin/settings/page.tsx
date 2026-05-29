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
import {
  Settings, Loader2, AlertTriangle, Sparkles, Mail, Briefcase, Users,
  CheckCircle2, XCircle, ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { getAiProvider } from "@/lib/ai";

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

  const provider = getAiProvider();

  useEffect(() => {
    if (!activeOrgId) return;
    (async () => {
      setLoading(true);
      try {
        const { data } = await supabase.from("orgs").select("*").eq("id", activeOrgId).single();
        setOrg(data as OrgSummary);
        const [{ count: members }, { count: libs }] = await Promise.all([
          supabase.from("org_members").select("*", { count: "exact", head: true }).eq("org_id", activeOrgId).eq("status", "active"),
          supabase.from("libraries").select("*", { count: "exact", head: true }).eq("org_id", activeOrgId),
        ]);
        setMemberCount(members ?? 0);
        setLibraryCount(libs ?? 0);

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

        {/* AI status */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-4">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">AI Assistance</div>
          <div className="flex items-start gap-3">
            <div className={`p-2.5 rounded-lg border ${provider.isReal ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-slate-100 border-slate-200 text-slate-600"}`}>
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-900">{provider.name}</span>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider border ${
                  provider.isReal ? "bg-emerald-50 text-emerald-700 border-emerald-300" : "bg-slate-100 text-slate-600 border-slate-300"
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${provider.isReal ? "bg-emerald-500 animate-pulse" : "bg-slate-400"}`} />
                  {provider.isReal ? "Live" : "Mock"}
                </span>
              </div>
              <p className="text-xs text-slate-600 mt-1">
                {provider.isReal
                  ? `Real provider connected. Scratchpad summaries / extractions / follow-ups use the model.`
                  : `Local heuristic fallback. Outputs are regex-based and run entirely in-browser. Set NEXT_PUBLIC_AI_PROVIDER=gemini + GEMINI_API_KEY to enable live AI.`}
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
        </div>

        {/* Help banner — what's left unconfigured */}
        {(emailQueueStatus === "no-key" || !provider.isReal) && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
            <div className="font-bold flex items-center gap-1.5 mb-1"><AlertTriangle className="w-4 h-4" /> Setup checklist</div>
            <ul className="ml-5 list-disc space-y-0.5">
              {!provider.isReal && <li>Set <code className="bg-amber-100 px-1 rounded">NEXT_PUBLIC_AI_PROVIDER=gemini</code> and <code className="bg-amber-100 px-1 rounded">GEMINI_API_KEY</code> in your env to enable AI assistance.</li>}
              {emailQueueStatus === "no-key" && <li>Set <code className="bg-amber-100 px-1 rounded">RESEND_API_KEY</code> and <code className="bg-amber-100 px-1 rounded">RESEND_FROM_EMAIL</code> in your env to enable outbound email.</li>}
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
