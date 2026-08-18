"use client";

// /intelligence — the front door of everything AI, and the status board the
// system never had. Six tabs (Overview · Ask · Knowledge · Graph · Review ·
// Setup) make one tool out of what used to be six scattered surfaces.
//
// The Overview answers the two questions that cost the most time when they
// have no answer: "is the machine on?" (keys, migrations, index) and "what
// is it waiting on from me?" (pending link proposals, unembedded passages).
// Every ✗ links directly to its fix.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  Bot, BookOpen, Waypoints, GitPullRequest, Settings2, Gauge,
  CheckCircle2, XCircle, ArrowRight, Sparkles, MessageSquare, Loader2,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { getAiConnections } from "@/lib/knowledge";
import { countPendingProposals } from "@/lib/linkProposals";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";

interface Status {
  chatKey: string | null;          // last4 or null
  embeddingKey: string | null;     // last4 or null
  libraries: number;
  docs: number;
  chunksTotal: number;
  chunksEmbedded: number;
  pendingProposals: number;
  schemaGaps: number | null;       // null = not admin / unknown
  recentAsks: Array<{ id: string; question: string; userName: string | null; libraryId: string; at: string }>;
}

export default function IntelligencePage() {
  const { activeOrgId, activeRole } = useRole();
  const isAdmin = activeRole === "Admin";
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  // SUB-500ms CONTRACT, in three moves. The old load rendered NOTHING until
  // all seven queries finished — the page was as slow as the SLOWEST one
  // (the admin schema probe walks ~100 tables). Now:
  //   1. Last known status paints from sessionStorage instantly (<50ms).
  //   2. The FAST core (key status, head counts, recent asks — one quick
  //      round trip each, in parallel) replaces it as soon as it lands.
  //   3. The two SLOW extras (org-wide vector coverage, admin schema probe)
  //      PATCH the status whenever they arrive — they never gate the page.
  //      Schema gaps only change when a migration runs, so that result is
  //      also cached for an hour.
  useEffect(() => {
    if (!activeOrgId) return;
    let cancelled = false;
    const snapKey = `intel-status-${activeOrgId}`;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const cached = window.sessionStorage.getItem(snapKey);
        if (cached) setStatus((prev) => prev ?? (JSON.parse(cached) as Status));
      } catch { /* no snapshot — skeleton it is */ }
    });

    const patch = (p: Partial<Status>) => {
      if (cancelled) return;
      setStatus((prev) => {
        const next = { ...(prev ?? {
          chatKey: null, embeddingKey: null, libraries: 0, docs: 0,
          chunksTotal: 0, chunksEmbedded: 0, pendingProposals: 0,
          schemaGaps: null, recentAsks: [],
        }), ...p } as Status;
        try { window.sessionStorage.setItem(snapKey, JSON.stringify(next)); } catch { /* quota */ }
        return next;
      });
    };

    (async () => {
      try {
        const [conns, libsRes, docsRes, pending, asks] = await Promise.all([
          getAiConnections(activeOrgId).catch(() => null),
          supabase.from("knowledge_libraries").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId),
          supabase.from("knowledge_documents").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId),
          countPendingProposals(activeOrgId),
          supabase.from("knowledge_questions")
            .select("id, question, user_name, library_id, created_at")
            .eq("org_id", activeOrgId)
            .order("created_at", { ascending: false })
            .limit(5)
            .then((r) => r.data ?? [], () => []),
        ]);
        patch({
          chatKey: conns?.personal?.keyLast4 ?? null,
          embeddingKey: conns?.personal?.embeddingKeyLast4 ?? null,
          libraries: libsRes.count ?? 0,
          docs: docsRes.count ?? 0,
          pendingProposals: pending,
          recentAsks: (asks as Array<Record<string, unknown>>).map((a) => ({
            id: String(a.id), question: String(a.question),
            userName: (a.user_name as string) ?? null,
            libraryId: String(a.library_id),
            at: String(a.created_at),
          })),
        });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();

    void supabase.rpc("semantic_coverage", { p_org_id: activeOrgId }).then(
      (r) => {
        const row = (r.data?.[0] as { total?: number; embedded?: number } | undefined) ?? null;
        if (row) patch({ chunksTotal: Number(row.total ?? 0), chunksEmbedded: Number(row.embedded ?? 0) });
      },
      () => undefined,
    );

    if (isAdmin) {
      void (async () => {
        const gapsKey = `schema-gaps-${activeOrgId}`;
        try {
          const cached = window.sessionStorage.getItem(gapsKey);
          if (cached) {
            const { gaps, at } = JSON.parse(cached) as { gaps: number; at: number };
            if (Date.now() - at < 3600_000) { patch({ schemaGaps: gaps }); return; }
          }
        } catch { /* recheck */ }
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const res = await fetch(`/api/admin/schema-health?orgId=${encodeURIComponent(activeOrgId)}`, {
            headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
          });
          if (!res.ok) return;
          const j = await res.json();
          const gaps = (j.missingTables?.length ?? 0) + (j.missingColumns?.length ?? 0);
          patch({ schemaGaps: gaps });
          try { window.sessionStorage.setItem(gapsKey, JSON.stringify({ gaps, at: Date.now() })); } catch { /* quota */ }
        } catch { /* badge just stays unknown */ }
      })();
    }

    return () => { cancelled = true; };
  }, [activeOrgId, isAdmin]);

  if (!activeOrgId) return <div className="p-8 text-sm text-slate-500">Select a workspace to continue.</div>;

  const s = status;
  const coveragePct = s && s.chunksTotal > 0 ? Math.round((s.chunksEmbedded / s.chunksTotal) * 100) : 0;

  return (
    <PageShell>
      <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
      <PageHeaderBar
        title="Intelligence"
        subtitle="Everything AI in one place — status at a glance, every gap linked to its fix"
        icon={Sparkles}
      />

      {error && (
        <div className="mb-4 rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-xs font-bold text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {!s ? (
        <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin inline text-[var(--color-text-faint)]" /></div>
      ) : (
        <div className="space-y-4">
          {/* ── Is the machine on? ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <StatusCard
              ok={!!s.chatKey}
              title="Chat key"
              okText={`Claude/OpenAI key active · ····${s.chatKey}`}
              fixText="No key saved — questions can't run"
              href="/intelligence/setup" cta="Add key"
            />
            <StatusCard
              ok={!!s.embeddingKey}
              title="Embeddings key"
              okText={`Meaning-based search enabled · ····${s.embeddingKey}`}
              fixText="Keyword search only until a Voyage/OpenAI key is added"
              href="/intelligence/setup" cta="Add key"
            />
            <StatusCard
              ok={s.docs > 0}
              title="Knowledge"
              okText={`${s.docs} document${s.docs === 1 ? "" : "s"} across ${s.libraries} librar${s.libraries === 1 ? "y" : "ies"}`}
              fixText="Nothing indexed — the AI has nothing to read yet"
              href="/knowledge" cta="Upload documents"
            />
            {s.schemaGaps !== null ? (
              <StatusCard
                ok={s.schemaGaps === 0}
                title="Database"
                okText="All expected tables present"
                fixText={`${s.schemaGaps} schema gap${s.schemaGaps === 1 ? "" : "s"} — features render empty until migrated`}
                href="/admin/settings" cta="Open Database health"
              />
            ) : (
              <StatusCard
                ok={s.chunksTotal > 0 ? s.chunksEmbedded > 0 : true}
                title="Meaning index"
                okText={s.chunksTotal > 0 ? `${coveragePct}% of passages embedded` : "Builds after your first uploads"}
                fixText="Index not built yet — semantic linking is off"
                href="/knowledge" cta="Build index"
              />
            )}
          </div>

          {/* ── What is it waiting on from me? ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] flex items-center gap-1.5">
                  <GitPullRequest className="w-3.5 h-3.5" /> Waiting on you
                </div>
              </div>
              {s.pendingProposals > 0 ? (
                <Link href="/admin/proposed-links" className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 p-3 hover:border-amber-300 transition-colors">
                  <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-black">{s.pendingProposals > 99 ? "99+" : s.pendingProposals}</span>
                  <div className="flex-1">
                    <div className="text-sm font-bold text-[var(--color-text)]">Proposed connections to review</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">Links the system found in your own data — approve or dismiss, each with its evidence.</div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-amber-600" />
                </Link>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)]">Nothing pending. New link proposals appear here as documents get indexed.</p>
              )}
              {s.chunksTotal > 0 && s.chunksEmbedded < s.chunksTotal && !!s.embeddingKey && (
                <Link href="/knowledge" className="mt-2 flex items-center gap-3 rounded-xl border border-[var(--color-border)] p-3 hover:border-[var(--color-border-strong)] transition-colors">
                  <Gauge className="w-5 h-5 text-violet-600" />
                  <div className="flex-1">
                    <div className="text-sm font-bold text-[var(--color-text)]">Meaning index {coveragePct}% built</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">{s.chunksEmbedded} of {s.chunksTotal} passages embedded — finish it from the library page.</div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[var(--color-text-faint)]" />
                </Link>
              )}
            </div>

            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] flex items-center gap-1.5 mb-3">
                <MessageSquare className="w-3.5 h-3.5" /> Recent questions
              </div>
              {s.recentAsks.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Nobody has asked anything yet. <Link className="font-bold text-violet-700 hover:underline" href="/assistant">Ask the first question</Link> — try &ldquo;what do we have on E-101?&rdquo;
                </p>
              ) : (
                <ul className="space-y-2">
                  {s.recentAsks.map((a) => (
                    <li key={a.id}>
                      <Link href={`/knowledge/${a.libraryId}`} className="block rounded-lg px-2 py-1.5 -mx-2 hover:bg-[var(--color-surface-2)] transition-colors">
                        <div className="text-xs font-bold text-[var(--color-text)] truncate">{a.question}</div>
                        <div className="text-[10px] text-[var(--color-text-faint)]">{a.userName ?? "someone"} · {new Date(a.at).toLocaleString()}</div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── Jump in ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <JumpCard href="/assistant" icon={Bot} title="Ask" body="Plain-English questions; it calls the system's tools and shows its work." />
            <JumpCard href="/knowledge" icon={BookOpen} title="Knowledge" body="Upload P&IDs and standards; extraction runs at ingest." />
            <JumpCard href="/graph" icon={Waypoints} title="Graph" body="The whole org as one zoomable relationship map." />
            <JumpCard href="/intelligence/setup" icon={Settings2} title="Setup" body="Keys, usage caps, playbooks, codebook — all configuration." />
          </div>
        </div>
      )}
    </PageShell>
  );
}

function StatusCard({ ok, title, okText, fixText, href, cta }: {
  ok: boolean; title: string; okText: string; fixText: string; href: string; cta: string;
}) {
  return (
    <div className={`rounded-2xl border p-4 ${ok
      ? "border-[var(--color-border)] bg-[var(--color-surface)]"
      : "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30"}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        {ok
          ? <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          : <XCircle className="w-4 h-4 text-amber-600" />}
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{title}</span>
      </div>
      <p className={`text-xs ${ok ? "text-[var(--color-text)]" : "font-bold text-amber-800 dark:text-amber-300"}`}>
        {ok ? okText : fixText}
      </p>
      {!ok && (
        <Link href={href} className="mt-2 inline-flex items-center gap-1 text-[11px] font-black text-amber-700 dark:text-amber-300 hover:underline">
          {cta} <ArrowRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}

function JumpCard({ href, icon: Icon, title, body }: {
  href: string; icon: React.ComponentType<{ className?: string }>; title: string; body: string;
}) {
  return (
    <Link href={href} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:border-[var(--color-border-strong)] hover:shadow-sm transition-all">
      <Icon className="w-5 h-5 text-violet-600 mb-2" />
      <div className="text-sm font-black text-[var(--color-text)]">{title}</div>
      <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">{body}</p>
    </Link>
  );
}
