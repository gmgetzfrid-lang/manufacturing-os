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
  GitPullRequest, Gauge, Loader2,
  CheckCircle2, XCircle, ArrowRight, MessageSquare,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { badgeText } from "@/lib/badge";
import { supabase } from "@/lib/supabase";
import { getAiConnections } from "@/lib/knowledge";
import { countPendingProposals } from "@/lib/linkProposals";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";
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
  recentAsks: Array<{ id: string; question: string; userName: string | null; libraryId: string; threadId: string | null; at: string }>;
  /** Per-source arrival flags: a card shows a shimmer until ITS data has
   *  landed (from snapshot or network) — never a default that reads as a
   *  false "No key saved". */
  keysKnown?: boolean;
  countsKnown?: boolean;
  coverageKnown?: boolean;
}

const EMPTY_STATUS: Status = {
  chatKey: null, embeddingKey: null, libraries: 0, docs: 0,
  chunksTotal: 0, chunksEmbedded: 0, pendingProposals: 0,
  schemaGaps: null, recentAsks: [],
  keysKnown: false, countsKnown: false, coverageKnown: false,
};

export default function IntelligencePage() {
  const { activeOrgId, activeRole } = useRole();
  const isAdmin = activeRole === "Admin";
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  // SUB-500ms CONTRACT. What actually made this page "take forever":
  //   (a) the WHOLE page (even static cards) waited on one Promise.all,
  //   (b) that Promise.all included the key check — a serverless function
  //       that can COLD-START for seconds — so five fast queries were
  //       gated by the one slow one, and
  //   (c) the snapshot lived in sessionStorage, which is per-tab: every
  //       new tab was a cold load.
  // Now: the scaffold renders unconditionally; each data source patches
  // ONLY its own cards the moment it lands (per-card shimmer until then);
  // the snapshot lives in localStorage so any tab on this device paints
  // the last known status instantly.
  useEffect(() => {
    if (!activeOrgId) return;
    let cancelled = false;
    const snapKey = `intel-status-${activeOrgId}`;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        // sessionStorage fallback reads snapshots written before the move.
        const cached = window.localStorage.getItem(snapKey) ?? window.sessionStorage.getItem(snapKey);
        if (cached) {
          const snap = JSON.parse(cached) as Status;
          // A snapshot IS known data (last known) — no shimmer over it.
          setStatus((prev) => prev ?? { ...snap, keysKnown: true, countsKnown: true, coverageKnown: true });
          return;
        }
      } catch { /* no snapshot */ }
      setStatus((prev) => prev ?? { ...EMPTY_STATUS });
    });

    const patch = (p: Partial<Status>) => {
      if (cancelled) return;
      setStatus((prev) => {
        const next = { ...(prev ?? EMPTY_STATUS), ...p } as Status;
        try { window.localStorage.setItem(snapKey, JSON.stringify(next)); } catch { /* quota */ }
        return next;
      });
    };

    // Key status rides a serverless function (possible multi-second cold
    // start) — it patches its two cards whenever it answers, gating nothing.
    void getAiConnections(activeOrgId).then(
      (conns) => patch({
        chatKey: conns?.personal?.keyLast4 ?? null,
        embeddingKey: conns?.personal?.embeddingKeyLast4 ?? null,
        keysKnown: true,
      }),
      () => patch({ keysKnown: true }),
    );

    // Direct-to-database head counts + recent asks: quick, parallel.
    void (async () => {
      try {
        const [libsRes, docsRes, pending, asks] = await Promise.all([
          supabase.from("knowledge_libraries").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId),
          supabase.from("knowledge_documents").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId),
          countPendingProposals(activeOrgId),
          supabase.from("knowledge_questions")
            .select("id, question, user_name, library_id, thread_id, created_at")
            .eq("org_id", activeOrgId)
            .order("created_at", { ascending: false })
            .limit(5)
            .then((r) => r.data ?? [], () => []),
        ]);
        patch({
          libraries: libsRes.count ?? 0,
          docs: docsRes.count ?? 0,
          pendingProposals: pending,
          recentAsks: (asks as Array<Record<string, unknown>>).map((a) => ({
            id: String(a.id), question: String(a.question),
            userName: (a.user_name as string) ?? null,
            libraryId: String(a.library_id),
            threadId: (a.thread_id as string | null) ?? null,
            at: String(a.created_at),
          })),
          countsKnown: true,
        });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();

    void supabase.rpc("semantic_coverage", { p_org_id: activeOrgId }).then(
      (r) => {
        const row = (r.data?.[0] as { total?: number; embedded?: number } | undefined) ?? null;
        if (row) patch({ chunksTotal: Number(row.total ?? 0), chunksEmbedded: Number(row.embedded ?? 0), coverageKnown: true });
      },
      () => undefined,
    );

    if (isAdmin) {
      void (async () => {
        const gapsKey = `schema-gaps-${activeOrgId}`;
        try {
          const cached = window.localStorage.getItem(gapsKey) ?? window.sessionStorage.getItem(gapsKey);
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
          try { window.localStorage.setItem(gapsKey, JSON.stringify({ gaps, at: Date.now() })); } catch { /* quota */ }
        } catch { /* badge just stays unknown */ }
      })();
    }

    return () => { cancelled = true; };
  }, [activeOrgId, isAdmin]);

  if (!activeOrgId) return <div className="p-8 text-[14px] text-[var(--color-text-muted)]">Pick a workspace to continue.</div>;

  const s = status ?? EMPTY_STATUS;
  const coveragePct = s.chunksTotal > 0 ? Math.round((s.chunksEmbedded / s.chunksTotal) * 100) : 0;
  // The one thing that matters most right now, and its one button.
  const lead: { text: string; href: string; cta: string } | null =
    !s.keysKnown || !s.countsKnown ? null
      : !s.chatKey ? { text: "Questions can't run yet: no AI key saved.", href: "/intelligence/setup", cta: "Add a key" }
      : s.docs === 0 ? { text: "The AI has nothing to read yet.", href: "/knowledge", cta: "Add documents" }
      : s.pendingProposals > 0 ? { text: `${s.pendingProposals} proposed connection${s.pendingProposals === 1 ? "" : "s"} wait for you.`, href: "/admin/proposed-links", cta: "Review them" }
      : { text: "AI is set up and reading your documents.", href: "/assistant", cta: "Ask a question" };

  return (
    <PageShell>
      <PageHero
        kicker="Intelligence · Status"
        title={lead ? lead.text : error ? "Couldn't check the AI." : "Checking the AI…"}
        sub={error
          ? <span className="text-rose-300 font-semibold">Couldn&apos;t load the AI status: {error}</span>
          : s.countsKnown ? `${s.docs.toLocaleString()} document${s.docs === 1 ? "" : "s"} across ${s.libraries} librar${s.libraries === 1 ? "y" : "ies"}${s.chunksTotal > 0 ? `, ${coveragePct}% of passages in the meaning index` : ""}.` : undefined}
        primary={lead ? (
          <Link href={lead.href} className={heroPrimary}>
            {lead.cta} <ArrowRight className="w-4 h-4" />
          </Link>
        ) : undefined}
      >
        <ViewTabs tabs={INTELLIGENCE_VIEWS} variant="dark" />
      </PageHero>

      <PageBody>
          {/* ── Is the machine on? One card, four checks. ── */}
          <Card label="Is it on" pad={false}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-[var(--color-border)] border-t border-[var(--color-border)] rounded-b-2xl overflow-hidden [&>*]:bg-[var(--color-surface)]">
            <StatusCard
              pending={!s.keysKnown}
              ok={!!s.chatKey}
              title="Chat key"
              okText={`Claude/OpenAI key active · ····${s.chatKey}`}
              fixText="No key saved, so questions can't run"
              href="/intelligence/setup" cta="Add key"
            />
            <StatusCard
              pending={!s.keysKnown}
              ok={!!s.embeddingKey}
              title="Embeddings key"
              okText={`Meaning-based search enabled · ····${s.embeddingKey}`}
              fixText="Keyword search only until a Voyage/OpenAI key is added"
              href="/intelligence/setup" cta="Add key"
            />
            <StatusCard
              pending={!s.countsKnown}
              ok={s.docs > 0}
              title="Knowledge"
              okText={`${s.docs} document${s.docs === 1 ? "" : "s"} across ${s.libraries} librar${s.libraries === 1 ? "y" : "ies"}`}
              fixText="Nothing indexed, so the AI has nothing to read yet"
              href="/knowledge" cta="Upload documents"
            />
            {s.schemaGaps !== null ? (
              <StatusCard
                ok={s.schemaGaps === 0}
                title="Database"
                okText="All expected tables present"
                fixText={`${s.schemaGaps} schema gap${s.schemaGaps === 1 ? "" : "s"}: some features stay empty until migrated`}
                href="/admin/settings" cta="Open Database health"
              />
            ) : (
              <StatusCard
                pending={!s.coverageKnown}
                ok={s.chunksTotal > 0 ? s.chunksEmbedded > 0 : true}
                title="Meaning index"
                okText={s.chunksTotal > 0 ? `${coveragePct}% of passages embedded` : "Builds after your first uploads"}
                fixText="Index not built yet, so meaning-based linking is off"
                href="/knowledge" cta="Build index"
              />
            )}
          </div>
          </Card>

          {/* ── What is it waiting on from me? ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card label={<span className="inline-flex items-center gap-1.5"><GitPullRequest className="w-3.5 h-3.5" /> Waiting on you</span>}>
              {!s.countsKnown ? (
                <p className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking what waits on you…</p>
              ) : s.pendingProposals > 0 ? (
                <Link href="/admin/proposed-links" className="flex items-center gap-3 border-t border-[var(--color-border)] py-3 hover:bg-[var(--color-surface-2)] -mx-4 sm:-mx-5 px-4 sm:px-5 transition-colors">
                  <span className="text-[15px] font-black text-[var(--color-text)] tabular-nums w-9">{badgeText(s.pendingProposals)}</span>
                  <div className="flex-1">
                    <div className="text-[14px] font-bold text-[var(--color-text)]">Proposed connections to review</div>
                    <div className="text-[13px] text-[var(--color-text-muted)]">Links found in your own data. Approve or dismiss each, with its evidence.</div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[var(--color-text-faint)]" />
                </Link>
              ) : (
                <p className="text-[13.5px] text-[var(--color-text-muted)]">Nothing pending. New link proposals appear here as documents get indexed.</p>
              )}
              {s.chunksTotal > 0 && s.chunksEmbedded < s.chunksTotal && !!s.embeddingKey && (
                <Link href="/knowledge" className="flex items-center gap-3 border-t border-[var(--color-border)] py-3 hover:bg-[var(--color-surface-2)] -mx-4 sm:-mx-5 px-4 sm:px-5 transition-colors">
                  <Gauge className="w-5 h-5 text-[var(--color-text-muted)]" />
                  <div className="flex-1">
                    <div className="text-[14px] font-bold text-[var(--color-text)]">Meaning index {coveragePct}% built</div>
                    <div className="text-[13px] text-[var(--color-text-muted)]">{s.chunksEmbedded} of {s.chunksTotal} passages embedded. Finish it from the library page.</div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[var(--color-text-faint)]" />
                </Link>
              )}
            </Card>

            <Card label={<span className="inline-flex items-center gap-1.5"><MessageSquare className="w-3.5 h-3.5" /> Recent questions</span>}>
              {!s.countsKnown ? (
                <p className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading recent questions…</p>
              ) : s.recentAsks.length === 0 ? (
                <p className="text-[13.5px] text-[var(--color-text-muted)]">
                  Nobody has asked anything yet. Try &ldquo;what do we have on E-101?&rdquo;
                </p>
              ) : (
                <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)] -mx-4 sm:-mx-5">
                  {s.recentAsks.map((a) => (
                    <li key={a.id}>
                      {/* The conversation itself: new asks carry the chat thread id;
                          older rows were backfilled as one-turn threads under their own id. */}
                      <Link href={`/assistant?thread=${a.threadId ?? a.id}`} className="block px-4 sm:px-5 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors">
                        <div className="text-[14px] font-semibold text-[var(--color-text)] truncate">{a.question}</div>
                        <div className="text-[12px] text-[var(--color-text-muted)]">{a.userName ?? "someone"} · {new Date(a.at).toLocaleString()}</div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Ask, Knowledge, Graph and Setup live in the tabs above: one home each. */}
      </PageBody>
    </PageShell>
  );
}

function StatusCard({ ok, title, okText, fixText, href, cta, pending }: {
  ok: boolean; title: string; okText: string; fixText: string; href: string; cta: string;
  /** Data for this card hasn't arrived yet — shimmer instead of a default
   *  that would read as a false "No key saved". */
  pending?: boolean;
}) {
  if (pending) {
    return (
      <div className="px-4 sm:px-5 py-3.5">
        <div className="flex items-center gap-1.5 mb-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-text-muted)]" />
          <span className="text-[13px] font-bold text-[var(--color-text)]">{title}</span>
        </div>
        <p className="text-[13px] text-[var(--color-text-muted)]">Checking…</p>
      </div>
    );
  }
  return (
    <div className="px-4 sm:px-5 py-3.5">
      <div className="flex items-center gap-1.5 mb-1">
        {ok
          ? <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          : <XCircle className="w-4 h-4 text-amber-600" />}
        <span className="text-[13px] font-bold text-[var(--color-text)]">{title}</span>
      </div>
      <p className={`text-[13px] ${ok ? "text-[var(--color-text-muted)]" : "font-semibold text-amber-800 dark:text-amber-300"}`}>
        {ok ? okText : fixText}
      </p>
      {!ok && (
        <Link href={href} className="mt-1.5 inline-flex items-center gap-1 text-[13px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
          {cta} <ArrowRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}


