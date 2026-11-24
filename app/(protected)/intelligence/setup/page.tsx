"use client";

// /intelligence/setup — ALL AI configuration on one page instead of a modal
// buried in Knowledge plus two admin pages. Your keys and usage meter live
// here inline; org-level teaching (playbooks, codebook) links out to its
// admin surface for those who hold the role.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useRole } from "@/components/providers/RoleContext";
import { getAiConnections } from "@/lib/knowledge";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import { KeyEditor, EmbeddingKeyEditor, UsagePanel, JobModelsFor } from "@/components/knowledge/AiSettingsModal";

export default function IntelligenceSetupPage() {
  const { activeOrgId, activeRole } = useRole();
  const isAdmin = activeRole === "Admin";
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";
  const [data, setData] = useState<Awaited<ReturnType<typeof getAiConnections>> | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!activeOrgId) return;
    let cancelled = false;
    getAiConnections(activeOrgId)
      .then((next) => { if (!cancelled) { setData(next); setLoadError(null); } })
      .catch((e) => { if (!cancelled) setLoadError(e ?? true); });
    return () => { cancelled = true; };
  }, [activeOrgId, reloadTick]);

  if (!activeOrgId) return <div className="p-8 text-body text-[var(--color-text-muted)]">Pick a workspace to continue.</div>;

  const answer = loadError ? "Couldn't load your AI setup."
    : !data ? "AI setup"
      : data.personal?.keyLast4 ? "Your AI key is saved." : "No AI key yet.";

  return (
    <PageShell>
      <PageHero
        kicker="Intelligence · Setup"
        title={answer}
        sub={loadError
          ? undefined
          : data ? (data.personal?.keyLast4 ? "Caps and models are below." : "Add your AI key below to start asking questions.") : "Your keys, spending caps and models."}
      >
        <ViewTabs tabs={INTELLIGENCE_VIEWS} variant="dark" />
      </PageHero>

      <PageBody>
      {/* Forms on white sheets; the usage table and the per-job menus get
          the full width, the key forms sit beside each other on a wide screen. */}
        {!data && !loadError && (
          <div className="grid gap-8 xl:grid-cols-2 items-start">
            <Card label="Your AI key"><SkeletonText lines={3} /></Card>
            <Card label="Embeddings key"><SkeletonText lines={3} /></Card>
          </div>
        )}
        {!!loadError && (
          <ErrorNote error={loadError} title="Couldn't load your AI setup." onRetry={() => { setLoadError(null); setReloadTick((t) => t + 1); }} />
        )}
        {data && (
          <>
            <div className="grid gap-8 xl:grid-cols-2 items-start">
              <KeyEditor orgId={activeOrgId} current={data.personal}
                onChanged={() => setReloadTick((t) => t + 1)} />
              <EmbeddingKeyEditor orgId={activeOrgId} current={data.personal}
                onChanged={() => setReloadTick((t) => t + 1)} />
            </div>
            <UsagePanel orgId={activeOrgId} />
            <JobModelsFor orgId={activeOrgId} data={data} onChanged={() => setReloadTick((t) => t + 1)} />
          </>
        )}

        {/* Org-level teaching + health, for the roles that hold them. */}
        <Card label="Teach the workspace" pad={false} className="overflow-hidden">
          <div className="divide-y divide-[var(--color-border)]">
          {isController && (
            <SetupLink href="/admin/ai-instructions"
              title="AI instructions (playbooks)"
              body="Standing instructions added to every AI prompt, like “our drawing types never include vendor codes”." />
          )}
          {isController && (
            <SetupLink href="/admin/codebook"
              title="Site codebook"
              body="Your numbering language: unit codes, equipment prefixes, drawing types. AI import reads your standard." />
          )}
          {isAdmin && (
            <SetupLink href="/admin/settings"
              title="Database health"
              body="Checks every table the AI features expect and names any migration still to run." />
          )}
          {!isController && (
            <p className="px-4 py-3 text-reading text-[var(--color-text-muted)]">
              Admin or Doc Control manage the org-level setup (playbooks, codebook).
            </p>
          )}
          </div>
        </Card>
      </PageBody>
    </PageShell>
  );
}

function SetupLink({ href, title, body }: {
  href: string; title: string; body: string;
}) {
  return (
    <Link href={href} className="group flex items-start gap-3 px-4 py-3 hover:bg-[var(--color-surface-2)] transition-colors">
      <div className="flex-1 min-w-0">
        <div className="text-reading font-medium text-[var(--color-text)] group-hover:text-[var(--color-accent-text)]">{title}</div>
        <p className="text-body text-[var(--color-text-muted)]">{body}</p>
      </div>
      <ArrowRight aria-hidden className="w-4 h-4 text-[var(--color-text-muted)] group-hover:text-[var(--color-accent-text)] mt-1.5 shrink-0" />
    </Link>
  );
}
