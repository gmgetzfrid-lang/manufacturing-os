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
import { ArrowRight } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { badgeText } from "@/lib/badge";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import Timeline, { type TimelineItem } from "@/components/ui/Timeline";
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
  /** The index couldn't be checked (said plainly, not as ready). */
  coverageFailed?: boolean;
}

/** How long this tab reuses the meaning-index count (it reads every
 *  passage in the workspace). */
const COVERAGE_TTL_MS = 10 * 60_000;

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
  const [error, setError] = useState<unknown>(null);

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
        if (!cancelled) setError(e ?? true);
      }
    })();

    // No row means nothing to embed yet; a failure is said as "couldn't
    // check", never a skeleton that waits forever.
    // The count reads every passage in the workspace, so this tab asks at
    // most every 10 minutes and shows the last answer in between.
    const coverageKey = `intel-coverage-${activeOrgId}`;
    let coverageCached = false;
    try {
      const hit = window.sessionStorage.getItem(coverageKey);
      if (hit) {
        const c = JSON.parse(hit) as { total: number; embedded: number; at: number };
        if (Date.now() - c.at < COVERAGE_TTL_MS) {
          coverageCached = true;
          // After the snapshot above has painted (it only fills an empty status).
          queueMicrotask(() => patch({ chunksTotal: Number(c.total) || 0, chunksEmbedded: Number(c.embedded) || 0, coverageKnown: true, coverageFailed: false }));
        }
      }
    } catch { /* ask again */ }
    if (!coverageCached) void supabase.rpc("semantic_coverage", { p_org_id: activeOrgId }).then(
      (r) => {
        if (r.error) { patch({ coverageKnown: true, coverageFailed: true }); return; }
        const row = (r.data?.[0] as { total?: number; embedded?: number } | undefined) ?? null;
        const total = Number(row?.total ?? 0), embedded = Number(row?.embedded ?? 0);
        patch({ chunksTotal: total, chunksEmbedded: embedded, coverageKnown: true, coverageFailed: false });
        try { window.sessionStorage.setItem(coverageKey, JSON.stringify({ total, embedded, at: Date.now() })); } catch { /* quota */ }
      },
      () => patch({ coverageKnown: true, coverageFailed: true }),
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

  if (!activeOrgId) return <div className="p-8 text-body text-[var(--color-text-muted)]">Pick a workspace to continue.</div>;

  const s = status ?? EMPTY_STATUS;
  const coveragePct = s.chunksTotal > 0 ? Math.round((s.chunksEmbedded / s.chunksTotal) * 100) : 0;
  // The one thing that matters most right now, and its one button.
  const lead: { text: string; href: string; cta: string } | null =
    !s.keysKnown || !s.countsKnown ? null
      : !s.chatKey ? { text: "Questions can't run yet: no AI key saved.", href: "/intelligence/setup", cta: "Add a key" }
      : s.docs === 0 ? { text: "The AI has nothing to read yet.", href: "/knowledge", cta: "Add documents" }
      : s.pendingProposals > 0 ? { text: `${s.pendingProposals} proposed connection${s.pendingProposals === 1 ? "" : "s"} wait for you.`, href: "/admin/proposed-links", cta: "Review them" }
      : { text: "AI is set up and reading your documents.", href: "/assistant", cta: "Ask a question" };

  // The four checks, one row each.
  const checks: CheckRow[] = [
    { pending: !s.keysKnown, ok: !!s.chatKey, title: "Chat key",
      okText: `Claude or OpenAI key active, ending ${s.chatKey}`, fixText: "No key saved, so questions can't run",
      href: "/intelligence/setup", cta: "Add a key" },
    { pending: !s.keysKnown, ok: !!s.embeddingKey, title: "Embeddings key",
      okText: `Meaning-based search on, key ending ${s.embeddingKey}`, fixText: "Keyword search only until a Voyage or OpenAI key is added",
      href: "/intelligence/setup", cta: "Add a key" },
    { pending: !s.countsKnown, ok: s.docs > 0, title: "Knowledge",
      okText: `${s.docs} document${s.docs === 1 ? "" : "s"} across ${s.libraries} librar${s.libraries === 1 ? "y" : "ies"}`, fixText: "Nothing indexed, so the AI has nothing to read yet",
      href: "/knowledge", cta: "Upload documents" },
    s.schemaGaps !== null
      ? { ok: s.schemaGaps === 0, title: "Database", okText: "All expected tables present",
        fixText: `${s.schemaGaps} schema gap${s.schemaGaps === 1 ? "" : "s"}: some features stay empty until migrated`,
        href: "/admin/settings", cta: "Open database health" }
      : { pending: !s.coverageKnown, unknown: !!s.coverageFailed, ok: s.chunksTotal > 0 ? s.chunksEmbedded > 0 : true, title: "Meaning index",
        okText: s.chunksTotal > 0 ? `${coveragePct}% of passages embedded` : "Builds after your first uploads",
        fixText: "Index not built yet, so meaning-based linking is off", href: "/knowledge", cta: "Build the index" },
  ];
  const known = checks.filter((c) => !c.pending);
  const ready = known.filter((c) => c.ok && !c.unknown).length;
  const facts = s.countsKnown ? [
    ...(s.pendingProposals > 0 ? [{ label: "Waiting on you", value: s.pendingProposals.toLocaleString(), tone: "warn" as const, hero: true }] : []),
    // Zeros stay out: "Is it on" below says what's missing, in words.
    ...(s.docs > 0 ? [{ label: "Documents", value: s.docs.toLocaleString() }] : []),
    ...(s.libraries > 0 ? [{ label: "Libraries", value: s.libraries.toLocaleString() }] : []),
    ...(s.chunksTotal > 0 ? [{ label: "Indexed", value: `${coveragePct}%` }] : []),
  ] : undefined;

  return (
    <PageShell>
      <PageHero
        kicker="Intelligence · Status"
        title={lead ? lead.text : error ? "Couldn't check the AI." : <span className="inline-flex items-center gap-3"><span className="sr-only">Checking the AI</span><Skeleton className="!h-7 w-[22rem] max-w-[70vw]" /></span>}
        facts={facts}
        factsHero={s.pendingProposals > 0 ? "auto" : "none"}
        primary={lead ? (
          <Link href={lead.href} className={heroPrimary}>
            {lead.cta} <ArrowRight className="w-4 h-4" />
          </Link>
        ) : undefined}
      >
        <ViewTabs tabs={INTELLIGENCE_VIEWS} variant="dark" />
      </PageHero>

      <PageBody>
          {!!error && <ErrorNote error={error} title="Couldn't load the AI status." onRetry={() => window.location.reload()} />}
          {/* ── Is the machine on? Four checks, one ruled row each. ── */}
          <Card label={<span className="inline-flex items-baseline gap-2.5">Is it on {known.length === checks.length && <span className={`ui-count ${ready < checks.length ? "is-warn" : ""}`}>{ready} of {checks.length} ready</span>}</span>} pad={false} className="overflow-hidden">
            <table className="w-full text-body">
              <thead className="bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)] text-left">
                <tr>
                  <th className="font-medium px-4 h-10 w-[30%] sm:w-[22%]">Check</th>
                  <th className="font-medium px-4">State</th>
                  <th className="font-medium px-4 hidden sm:table-cell text-right">Fix</th>
                </tr>
              </thead>
              {/* Four checks: space between them, no line under each. */}
              <tbody>
                {checks.map((c) => <CheckLine key={c.title} c={c} />)}
              </tbody>
            </table>
          </Card>

          {/* ── What is it waiting on from me? ── */}
          <Card label={<span className="inline-flex items-baseline gap-2.5">Waiting on you{s.countsKnown && s.pendingProposals > 0 ? <span className="ui-count is-warn">{badgeText(s.pendingProposals)}</span> : null}</span>} pad={false} className="overflow-hidden">
            {!s.countsKnown ? (
              <SkeletonRows rows={1} cols={0} sheet={false} what="what waits on you" />
            ) : (
              <ul className="py-1">
                {s.pendingProposals > 0 ? (
                  <li>
                    <Link href="/admin/proposed-links" className="flex items-center gap-4 px-4 py-3 hover:bg-[var(--color-surface-2)] transition-colors">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-reading font-medium text-[var(--color-text)]"><span className="ui-pill is-warn">{badgeText(s.pendingProposals)}</span> Proposed connections to review</span>
                        <span className="block text-body text-[var(--color-text-muted)]">Approve or dismiss each, with its evidence.</span>
                      </span>
                      <ArrowRight aria-hidden className="w-4 h-4 text-[var(--color-text-muted)]" />
                    </Link>
                  </li>
                ) : (
                  <li className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="flex-1 min-w-[14rem] text-reading text-[var(--color-text-muted)]">Nothing waits on you. New link proposals show up here as documents get read.</span>
                    <Link href="/admin/proposed-links" className="text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Open Review</Link>
                  </li>
                )}
                {s.chunksTotal > 0 && s.chunksEmbedded < s.chunksTotal && !!s.embeddingKey && (
                  <li>
                    <Link href="/knowledge" className="flex items-center gap-4 px-4 py-3 hover:bg-[var(--color-surface-2)] transition-colors">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-reading font-medium text-[var(--color-text)]"><span className="font-display tabular-nums">{coveragePct}%</span> of the meaning index built</span>
                        <span className="block text-body text-[var(--color-text-muted)]">{s.chunksEmbedded.toLocaleString()} of {s.chunksTotal.toLocaleString()} passages. Finish it from the library page.</span>
                      </span>
                      <ArrowRight className="w-4 h-4 text-[var(--color-text-muted)]" />
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </Card>

          <Card label={<span className="inline-flex items-baseline gap-2.5">Recent questions{s.recentAsks.length > 0 ? <span className="ui-count">{s.recentAsks.length}</span> : null}</span>} pad={false} className="overflow-hidden"
            action={<Link href="/assistant" className="text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">All conversations</Link>}>
            {!s.countsKnown ? (
              <SkeletonRows rows={3} cols={2} sheet={false} what="recent questions" />
            ) : s.recentAsks.length === 0 ? (
              <div className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="flex-1 min-w-[14rem] text-reading text-[var(--color-text-muted)]">Nobody has asked anything yet.</p>
                <Link href={`/assistant?q=${encodeURIComponent("What do we have on E-101?")}`} className="inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 px-3.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                  Ask &ldquo;What do we have on E-101?&rdquo;
                </Link>
              </div>
            ) : (
              // Who asked what, newest first, by day: a timeline, the asker
              // as an avatar. Each question opens its conversation.
              <div className="px-4 sm:px-5 py-4">
                <Timeline items={s.recentAsks.map((a): TimelineItem => ({
                  id: a.id,
                  at: a.at,
                  kind: "Asked",
                  tone: "muted",
                  title: <Link href={`/assistant?thread=${a.threadId ?? a.id}`} className="text-[var(--color-text)] hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">{a.question}</Link>,
                  who: { name: (a.userName ?? "someone").split("@")[0], email: a.userName },
                }))} />
              </div>
            )}
          </Card>

          {/* Ask, Knowledge, Graph and Setup live in the tabs above: one home each. */}
      </PageBody>
    </PageShell>
  );
}

interface CheckRow {
  /** Couldn't be checked right now. */
  unknown?: boolean;
  ok: boolean; title: string; okText: string; fixText: string; href: string; cta: string;
  /** Data for this row hasn't arrived yet — "Checking" instead of a default
   *  that would read as a false "No key saved". */
  pending?: boolean;
}

function CheckLine({ c }: { c: CheckRow }) {
  const fix = !c.pending && !c.unknown && !c.ok
    ? <Link href={c.href} className="inline-flex items-center gap-1 text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2 whitespace-nowrap">{c.cta}</Link>
    : null;
  return (
    // Top-aligned: with no line under each row, the check's name sits
    // level with its state, even when the state wraps on a phone.
    <tr className="align-top">
      <td className="px-4 py-3 pt-3.5 font-medium text-[var(--color-text)]">{c.title}</td>
      <td className="px-4 py-3">
        {c.pending ? (
          <span role="status" className="flex items-center gap-2.5"><span className="sr-only">Checking</span><Skeleton className="!w-16" /><Skeleton className="!w-56 max-w-full" /></span>
        ) : c.unknown ? (
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-body pt-0.5">
            <span className="ui-pill is-muted">Unknown</span>
            <span className="text-[var(--color-text-muted)]">Couldn&apos;t check it right now. Reload to try again.</span>
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-body pt-0.5">
            <span className={`ui-pill ${c.ok ? "is-good" : "is-warn"}`}>{c.ok ? "Ready" : "Needs you"}</span>
            <span className={c.ok ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}>{c.ok ? c.okText : c.fixText}</span>
          </span>
        )}
        {fix && <div className="sm:hidden mt-1">{fix}</div>}
      </td>
      <td className="px-4 py-3 hidden sm:table-cell text-right">{fix}</td>
    </tr>
  );
}
