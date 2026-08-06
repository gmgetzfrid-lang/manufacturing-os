"use client";

// /intelligence/setup — ALL AI configuration on one page instead of a modal
// buried in Knowledge plus two admin pages. Your keys and usage meter live
// here inline; org-level teaching (playbooks, codebook) links out to its
// admin surface for those who hold the role.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Settings2, GraduationCap, BookMarked, Database, ArrowRight, Loader2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { getAiConnections } from "@/lib/knowledge";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import { KeyEditor, EmbeddingKeyEditor, UsagePanel } from "@/components/knowledge/AiSettingsModal";

export default function IntelligenceSetupPage() {
  const { activeOrgId, activeRole } = useRole();
  const isAdmin = activeRole === "Admin";
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";
  const [data, setData] = useState<Awaited<ReturnType<typeof getAiConnections>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!activeOrgId) return;
    let cancelled = false;
    getAiConnections(activeOrgId)
      .then((next) => { if (!cancelled) { setData(next); setLoadError(null); } })
      .catch((e) => { if (!cancelled) setLoadError((e as Error).message); });
    return () => { cancelled = true; };
  }, [activeOrgId, reloadTick]);

  if (!activeOrgId) return <div className="p-8 text-sm text-slate-500">Select a workspace to continue.</div>;

  return (
    <PageShell>
      <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
      <PageHeaderBar
        title="AI setup"
        subtitle="Your keys, your money, your caps — plus the org-level teaching surfaces"
        icon={Settings2}
      />

      <div className="max-w-2xl space-y-4">
        {loadError && (
          <div className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs font-bold text-rose-700 dark:text-rose-300">{loadError}</div>
        )}
        {!data && !loadError && (
          <div className="py-10 text-center text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
        )}
        {data && (
          <>
            <UsagePanel orgId={activeOrgId} />
            <KeyEditor orgId={activeOrgId} current={data.personal}
              onChanged={() => setReloadTick((t) => t + 1)} />
            <EmbeddingKeyEditor orgId={activeOrgId} current={data.personal}
              onChanged={() => setReloadTick((t) => t + 1)} />
          </>
        )}

        {/* Org-level teaching + health, for the roles that hold them. */}
        <div className="rounded-xl border border-[var(--color-border)] p-4 space-y-1">
          <div className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
            Teach the workspace
          </div>
          {isController && (
            <SetupLink href="/admin/ai-instructions" icon={GraduationCap}
              title="AI instructions (playbooks)"
              body="Standing org instructions folded into every AI prompt — 'our drawing types never include vendor codes'." />
          )}
          {isController && (
            <SetupLink href="/admin/codebook" icon={BookMarked}
              title="Site codebook"
              body="Your numbering language: unit codes, equipment prefixes, drawing types. AI import reads your standard." />
          )}
          {isAdmin && (
            <SetupLink href="/admin/settings" icon={Database}
              title="Database health"
              body="Probes every table the AI features expect and names any migration still to run." />
          )}
          {!isController && (
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Org-level configuration (playbooks, codebook) is managed by Admin / Doc Control.
            </p>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function SetupLink({ href, icon: Icon, title, body }: {
  href: string; icon: React.ComponentType<{ className?: string }>; title: string; body: string;
}) {
  return (
    <Link href={href} className="flex items-start gap-3 rounded-lg px-2 py-2 -mx-2 hover:bg-[var(--color-surface-2)] transition-colors">
      <Icon className="w-4 h-4 text-violet-600 mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="text-sm font-bold text-[var(--color-text)]">{title}</div>
        <p className="text-[11px] text-[var(--color-text-muted)]">{body}</p>
      </div>
      <ArrowRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] mt-1" />
    </Link>
  );
}
