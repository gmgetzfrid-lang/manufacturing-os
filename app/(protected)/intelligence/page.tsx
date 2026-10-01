"use client";

// /intelligence — the front door of everything AI, and the status board the
// system never had. The tabs (INTELLIGENCE_VIEWS) make one tool out of what
// used to be scattered surfaces.
//
// The Overview answers the two questions that cost the most time when they
// have no answer: "is the machine on?" (keys, migrations, index) and "what
// is it waiting on from me?" (pending link proposals, unembedded passages,
// the first Facility setup step not yet taken). Every ✗ links to the control
// that fixes it — or says who can, when the viewer cannot (HUB-5). A card
// whose source failed says so, with a retry (HUB-7). The card rules live in
// lib/hubStatus.ts.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  Bot, BookOpen, Waypoints, GitPullRequest, Settings2, Gauge, Compass,
  CheckCircle2, XCircle, ArrowRight, Sparkles, MessageSquare, RotateCw,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { getAiConnections } from "@/lib/knowledge";
import { isControllerPrincipal } from "@/lib/permissions";
import {
  hubSnapshotKey, hubGapsKey, legacyHubKeys, readHubSnapshot, writeHubSnapshot,
  meaningIndexCard, knowledgeFix, meaningIndexFix, recentQuestionsCopy, firstSetupStep,
} from "@/lib/hubStatus";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";

interface Status {
  chatKey: string | null;          // last4 or null
  embeddingKey: string | null;     // last4 or null
  libraries: number;
  firstLibraryId: string | null;   // the newest library — where a fix CTA lands
  docs: number;
  chunksTotal: number;
  chunksEmbedded: number;
  pendingProposals: number;
  schemaGaps: number | null;       // null = not admin / unknown
  assets: number;
  codebookEntries: number;
  recentAsks: Array<{ id: string; question: string; userName: string | null; libraryId: string; at: string }>;
  /** Per-source arrival flags: a card shows a shimmer until ITS data has
   *  landed (from snapshot or network) — never a default that reads as a
   *  false "No key saved". */
  keysKnown?: boolean;
  librariesKnown?: boolean;
  docsKnown?: boolean;
  proposalsKnown?: boolean;
  asksKnown?: boolean;
  coverageKnown?: boolean;
  setupKnown?: boolean;
  /** HUB-7: why a source could not be read — the card says so, with a retry.
   *  Never persisted in the snapshot. */
  keysFailed?: string;
  librariesFailed?: string;
  docsFailed?: string;
  proposalsFailed?: string;
  asksFailed?: string;
  coverageFailed?: string;
  gapsFailed?: string;
}

const EMPTY_STATUS: Status = {
  chatKey: null, embeddingKey: null, libraries: 0, firstLibraryId: null, docs: 0,
  chunksTotal: 0, chunksEmbedded: 0, pendingProposals: 0,
  schemaGaps: null, assets: 0, codebookEntries: 0, recentAsks: [],
};

const NO_FAILURES: Partial<Status> = {
  keysFailed: undefined, librariesFailed: undefined, docsFailed: undefined, proposalsFailed: undefined,
  asksFailed: undefined, coverageFailed: undefined, gapsFailed: undefined,
};

const why = (e: unknown) => (e as { message?: string } | null)?.message || "the request failed";

export default function IntelligencePage() {
  const { activeOrgId, uid, activeRole, roles, hasAnyRole } = useRole();
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  const isAdmin = hasAnyRole(["Admin"]);
  const isController = isControllerPrincipal({ role: activeRole, roles });
  const [status, setStatus] = useState<Status | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const retry = () => setReloadTick((t) => t + 1);

  // SUB-500ms CONTRACT. What actually made this page "take forever":
  //   (a) the WHOLE page (even static cards) waited on one Promise.all,
  //   (b) that Promise.all included the key check — a serverless function
  //       that can COLD-START for seconds — so five fast queries were
  //       gated by the one slow one, and
  //   (c) the snapshot lived in sessionStorage, which is per-tab: every
  //       new tab was a cold load.
  // Now: the scaffold renders unconditionally; each data source patches
  // ONLY its own cards the moment it lands (per-card shimmer until then, a
  // stated failure if it cannot — HUB-7); the snapshot lives in localStorage,
  // keyed by user AND org and carrying its uid (HUB-10), so any tab on this
  // device paints THIS person's last known status instantly.
  useEffect(() => {
    if (!activeOrgId || !uid) return;
    let cancelled = false;
    const snapKey = hubSnapshotKey(uid, activeOrgId);
    queueMicrotask(() => {
      if (cancelled) return;
      let snap: Status | null = null;
      try {
        // HUB-10: the org-only keys of before are another person's data on a
        // shared device — dropped, never read.
        for (const k of legacyHubKeys(activeOrgId)) {
          window.localStorage.removeItem(k);
          window.sessionStorage.removeItem(k);
        }
        snap = readHubSnapshot<Status>(window.localStorage.getItem(snapKey), uid);
      } catch { /* no snapshot */ }
      // A snapshot IS known data (last known) for the sources it knew; a
      // retry keeps what is on screen and clears the failures it re-asks.
      setStatus((prev) => prev
        ? { ...prev, ...NO_FAILURES }
        : { ...EMPTY_STATUS, ...(snap ?? {}), ...NO_FAILURES });
    });

    const patch = (p: Partial<Status>) => {
      if (cancelled) return;
      setStatus((prev) => {
        const next = { ...(prev ?? EMPTY_STATUS), ...p } as Status;
        try { window.localStorage.setItem(snapKey, writeHubSnapshot(uid, next)); } catch { /* quota */ }
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
      (e) => patch({ keysFailed: why(e) }),
    );

    // HUB-7: every source settles on its own — one failing query never
    // blanks the others, and each failure is said on its own card.
    void supabase.from("knowledge_libraries").select("id", { count: "exact" })
      .eq("org_id", activeOrgId).order("created_at", { ascending: false }).limit(1)
      .then((r) => r.error
        ? patch({ librariesFailed: r.error.message })
        : patch({
            libraries: r.count ?? 0,
            firstLibraryId: ((r.data ?? [])[0] as { id?: string } | undefined)?.id ?? null,
            librariesKnown: true,
          }), (e) => patch({ librariesFailed: why(e) }));
    void supabase.from("knowledge_documents").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId)
      .then((r) => r.error ? patch({ docsFailed: r.error.message }) : patch({ docs: r.count ?? 0, docsKnown: true }),
        (e) => patch({ docsFailed: why(e) }));
    void supabase.from("proposed_links").select("id", { count: "exact", head: true })
      .eq("org_id", activeOrgId).eq("status", "pending")
      .then((r) => r.error ? patch({ proposalsFailed: r.error.message }) : patch({ pendingProposals: r.count ?? 0, proposalsKnown: true }),
        (e) => patch({ proposalsFailed: why(e) }));
    void supabase.from("knowledge_questions")
      .select("id, question, user_name, library_id, created_at")
      .eq("org_id", activeOrgId)
      .order("created_at", { ascending: false })
      .limit(5)
      .then((r) => {
        if (r.error) { patch({ asksFailed: r.error.message }); return; }
        patch({
          recentAsks: ((r.data ?? []) as Array<Record<string, unknown>>).map((a) => ({
            id: String(a.id), question: String(a.question),
            userName: (a.user_name as string) ?? null,
            libraryId: String(a.library_id),
            at: String(a.created_at),
          })),
          asksKnown: true,
        });
      }, (e) => patch({ asksFailed: why(e) }));

    // supabase-js RESOLVES on an RPC 500 — the error is on the result, and a
    // missing row is an org with nothing indexed, not a reason to shimmer.
    void supabase.rpc("semantic_coverage", { p_org_id: activeOrgId }).then(
      (r) => {
        if (r.error) { patch({ coverageFailed: r.error.message }); return; }
        const row = (r.data?.[0] as { total?: number; embedded?: number } | undefined) ?? null;
        patch({ chunksTotal: Number(row?.total ?? 0), chunksEmbedded: Number(row?.embedded ?? 0), coverageKnown: true });
      },
      (e) => patch({ coverageFailed: why(e) }),
    );

    // HUB-3: has the workspace taken its first Facility setup steps?
    void Promise.all([
      supabase.from("codebook_entries").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId),
      supabase.from("assets").select("id", { count: "exact", head: true }).eq("org_id", activeOrgId).eq("archived", false),
    ]).then(([cb, as]) => {
      // a pre-migration table reads as "not started", which is what it is
      if (cb.error && as.error) return;
      patch({ codebookEntries: cb.count ?? 0, assets: as.count ?? 0, setupKnown: true });
    }, () => undefined);

    if (isAdmin) {
      void (async () => {
        const gapsKey = hubGapsKey(uid, activeOrgId);
        try {
          const cached = window.localStorage.getItem(gapsKey);
          const parsed = cached ? JSON.parse(cached) as { uid?: string; gaps: number; at: number } : null;
          if (parsed && parsed.uid === uid && Date.now() - parsed.at < 3600_000) { patch({ schemaGaps: parsed.gaps }); return; }
        } catch { /* recheck */ }
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const res = await fetch(`/api/admin/schema-health?orgId=${encodeURIComponent(activeOrgId)}`, {
            headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
          });
          if (!res.ok) { patch({ gapsFailed: `the database health check answered HTTP ${res.status}` }); return; }
          const j = await res.json();
          const gaps = (j.missingTables?.length ?? 0) + (j.missingColumns?.length ?? 0);
          patch({ schemaGaps: gaps });
          try { window.localStorage.setItem(gapsKey, JSON.stringify({ uid, gaps, at: Date.now() })); } catch { /* quota */ }
        } catch (e) { patch({ gapsFailed: why(e) }); }
      })();
    }

    return () => { cancelled = true; };
  }, [activeOrgId, uid, isAdmin, reloadTick]);

  if (!activeOrgId) return <div className="p-8 text-sm text-slate-500">Select a workspace to continue.</div>;

  const s = status ?? EMPTY_STATUS;
  const meaning = meaningIndexCard(s.chunksTotal, s.chunksEmbedded);
  const kFix = knowledgeFix({ isController, libraries: s.libraries, firstLibraryId: s.firstLibraryId });
  const mFix = meaningIndexFix({ isController, chunksTotal: s.chunksTotal, libraries: s.libraries, firstLibraryId: s.firstLibraryId });
  const asksCopy = recentQuestionsCopy(isController);
  const setupStep = s.setupKnown && s.librariesKnown
    ? firstSetupStep({ codebookEntries: s.codebookEntries, assets: s.assets, libraries: s.libraries })
    : null;
  const knowledgeFailed = s.librariesFailed ?? s.docsFailed;

  return (
    <PageShell>
      <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
      <PageHeaderBar
        title="Intelligence"
        subtitle="Everything AI in one place — status at a glance, every gap linked to its fix"
        icon={Sparkles}
      />

      <div className="space-y-4">
          {/* ── HUB-3: the first step, from the front door ── */}
          {setupStep && (
            <Link href="/setup" className="flex items-center gap-3 rounded-2xl border border-violet-300 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 p-4 hover:border-violet-400 transition-colors">
              <Compass className="w-6 h-6 text-violet-600 shrink-0" />
              <div className="flex-1">
                <div className="text-sm font-black text-[var(--color-text)]">Start here — Facility setup</div>
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  Next step: <b>{setupStep.stage}</b> — {setupStep.why}. Facility setup walks every step in order
                  and picks up where you left off.{isController ? "" : " Admin or Doc Control does these steps."}
                </p>
              </div>
              <ArrowRight className="w-4 h-4 text-violet-600" />
            </Link>
          )}

          {/* ── Is the machine on? ── */}
          <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${isAdmin ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
            <StatusCard
              pending={!s.keysKnown}
              failed={s.keysFailed}
              onRetry={retry}
              ok={!!s.chatKey}
              title="Chat key"
              okText={`Claude/OpenAI key active · ····${s.chatKey}`}
              fixText="No key saved — questions can't run"
              href="/intelligence/setup" cta="Add key"
            />
            <StatusCard
              pending={!s.keysKnown}
              failed={s.keysFailed}
              onRetry={retry}
              ok={!!s.embeddingKey}
              title="Embeddings key"
              okText={`Meaning-based search enabled · ····${s.embeddingKey}`}
              fixText="Keyword search only until a Voyage/OpenAI key is added"
              href="/intelligence/setup" cta="Add key"
            />
            <StatusCard
              pending={!(s.librariesKnown && s.docsKnown)}
              failed={knowledgeFailed}
              onRetry={retry}
              ok={s.docs > 0}
              title="Knowledge"
              okText={`${s.docs} document${s.docs === 1 ? "" : "s"} across ${s.libraries} librar${s.libraries === 1 ? "y" : "ies"}`}
              fixText="Nothing indexed — the AI has nothing to read yet"
              {...kFix}
            />
            {/* HUB-9: the meaning index holds its own slot — an Admin sees it too */}
            <StatusCard
              pending={!s.coverageKnown}
              failed={s.coverageFailed}
              onRetry={retry}
              ok={meaning.ok}
              title="Meaning index"
              okText={meaning.text}
              fixText={meaning.text}
              {...mFix}
            />
            {isAdmin && (
              <StatusCard
                pending={s.schemaGaps === null}
                failed={s.gapsFailed}
                onRetry={retry}
                ok={s.schemaGaps === 0}
                title="Database"
                okText="All expected tables present"
                fixText={`${s.schemaGaps} schema gap${s.schemaGaps === 1 ? "" : "s"} — features render empty until migrated`}
                href="/admin/settings" cta="Open Database health"
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
              {s.proposalsFailed && !s.proposalsKnown ? (
                <CouldNotCheck what="pending link proposals" reason={s.proposalsFailed} onRetry={retry} />
              ) : !s.proposalsKnown ? (
                <div className="space-y-2 animate-pulse">
                  <div className="h-10 rounded-xl bg-[var(--color-surface-2)]" />
                </div>
              ) : s.pendingProposals > 0 ? (
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
              {/* HUB-9: coverage is a library fact, not the viewer's key */}
              {s.coverageKnown && s.chunksTotal > 0 && s.chunksEmbedded < s.chunksTotal && (
                <Link href={mFix.href ?? "/knowledge"} className="mt-2 flex items-center gap-3 rounded-xl border border-[var(--color-border)] p-3 hover:border-[var(--color-border-strong)] transition-colors">
                  <Gauge className="w-5 h-5 text-violet-600" />
                  <div className="flex-1">
                    <div className="text-sm font-bold text-[var(--color-text)]">Meaning index {meaning.pct}% built</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      {s.chunksEmbedded} of {s.chunksTotal} passages embedded — {mFix.whoCan ?? "finish it from the library page."}
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[var(--color-text-faint)]" />
                </Link>
              )}
            </div>

            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] flex items-center gap-1.5 mb-3">
                <MessageSquare className="w-3.5 h-3.5" /> {asksCopy.title}
              </div>
              {s.asksFailed && !s.asksKnown ? (
                <CouldNotCheck what="recent questions" reason={s.asksFailed} onRetry={retry} />
              ) : !s.asksKnown ? (
                <div className="space-y-2 animate-pulse">
                  <div className="h-8 rounded-lg bg-[var(--color-surface-2)]" />
                  <div className="h-8 rounded-lg bg-[var(--color-surface-2)]" />
                  <div className="h-8 rounded-lg bg-[var(--color-surface-2)] w-3/4" />
                </div>
              ) : s.recentAsks.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">
                  {asksCopy.empty} <Link className="font-bold text-violet-700 hover:underline" href="/assistant">Ask the first question</Link> — try &ldquo;what do we have on E-101?&rdquo;
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
            <JumpCard href="/intelligence/setup" icon={Settings2} title="AI setup" body="Your AI keys, usage caps, playbooks, codebook — all AI configuration. (Facility setup is the order-of-operations navigator.)" />
          </div>
        </div>
    </PageShell>
  );
}

/** HUB-7: a source that could not be read, said — with a retry. */
function CouldNotCheck({ what, reason, onRetry }: { what: string; reason: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 flex items-start gap-2">
      <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-px" />
      <p className="flex-1 text-[11px] font-bold text-rose-700 dark:text-rose-300">Couldn&apos;t check {what} ({reason}).</p>
      <button onClick={onRetry} className="inline-flex items-center gap-1 text-[11px] font-black text-rose-700 dark:text-rose-300 hover:underline">
        <RotateCw className="w-3 h-3" /> Retry
      </button>
    </div>
  );
}

function StatusCard({ ok, title, okText, fixText, href, cta, whoCan, pending, failed, onRetry }: {
  ok: boolean; title: string; okText: string; fixText: string;
  /** The control that fixes it (HUB-5) — absent when the viewer can't. */
  href?: string; cta?: string;
  /** Said instead of a dead-end button when the viewer can't fix it. */
  whoCan?: string;
  /** Data for this card hasn't arrived yet — shimmer instead of a default
   *  that would read as a false "No key saved". */
  pending?: boolean;
  /** HUB-7: the source failed — say so (with the last known value, if any). */
  failed?: string;
  onRetry?: () => void;
}) {
  if (failed && pending) {
    return (
      <div role="alert" className="rounded-2xl border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 p-4">
        <div className="flex items-center gap-1.5 mb-1.5">
          <XCircle className="w-4 h-4 text-rose-600" />
          <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{title}</span>
        </div>
        <p className="text-xs font-bold text-rose-700 dark:text-rose-300">Couldn&apos;t check ({failed}).</p>
        {onRetry && (
          <button onClick={onRetry} className="mt-2 inline-flex items-center gap-1 text-[11px] font-black text-rose-700 dark:text-rose-300 hover:underline">
            <RotateCw className="w-3 h-3" /> Retry
          </button>
        )}
      </div>
    );
  }
  if (pending) {
    return (
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="w-4 h-4 rounded-full bg-[var(--color-surface-2)] animate-pulse" />
          <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{title}</span>
        </div>
        <div className="h-3 w-3/4 rounded bg-[var(--color-surface-2)] animate-pulse" />
      </div>
    );
  }
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
      {failed && (
        <p className="mt-1 text-[10px] font-bold text-rose-700 dark:text-rose-300">
          Last known — couldn&apos;t refresh ({failed}).{" "}
          {onRetry && <button onClick={onRetry} className="underline">Retry</button>}
        </p>
      )}
      {!ok && href && cta && (
        <Link href={href} className="mt-2 inline-flex items-center gap-1 text-[11px] font-black text-amber-700 dark:text-amber-300 hover:underline">
          {cta} <ArrowRight className="w-3 h-3" />
        </Link>
      )}
      {!ok && !href && whoCan && (
        <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">{whoCan}</p>
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
