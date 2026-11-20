"use client";

// /coordination — "Coordination". The org-wide situational board, built around
// the one question no personal inbox can answer: WHERE IS WORK COLLIDING right
// now?
//
// Two views, one page (the former standalone /control-tower board was folded
// in here — one situational board instead of two overlapping ones):
//   • Collisions    — scope-collision radar + blockers + equipment state +
//                     spatial boards (the original coordination content)
//   • Document flow — every controlled document by lifecycle column with
//                     aging heat (LifecycleBoard), plus the protection
//                     record and the Doc Control review queue.
// Deep-linkable: /coordination?view=flow opens Document flow (the old
// /control-tower route redirects there).
//
// The collision radar is SELF-EXPLAINING: it always states what it watches and
// reports its coverage (how many checked-out documents it could actually
// compare), so "all clear" is never confused with "not wired up".
//
// The plain "how many open requests / locks" counts deliberately live on Home
// now; here they're a thin context strip, not the headline — the value of this
// page is the coordination signal + analysis, not the totals.
//
// Dark "big board" theme, auto-refreshing so it can live on a wall display
// during a turnaround. Read-only intelligence — every signal deep-links to the
// surface where you act on it.

import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  RefreshCw, Map as MapIcon, ChevronRight,
  ShieldCheck, AlertTriangle, Users, Boxes, Clock, ArrowDownRight, ArrowUpRight,
  Radar, Info, Tag, LayoutGrid,
} from "lucide-react";
import { PageHero, PageBody, Card, heroQuiet } from "@/components/ui/PageHero";
import { PageShell } from "@/components/ui/PageShell";
import LifecycleBoard from "@/components/documents/LifecycleBoard";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { getStateCounts, STATE_CONFIG, WHITEBOARD_STATES } from "@/lib/whiteboard";
import { getHoldMetrics, type HoldMetrics } from "@/lib/holds";
import { listAllActiveCheckouts } from "@/lib/projects";
import { analyzeCheckoutCoordination, type CoordinationAnalysis } from "@/lib/consolidation";
import { listPlotPlans } from "@/lib/plotPlans";
import { MiniBars } from "@/components/ui/Sparkline";
import ViewTabs, { HOME_VIEWS } from "@/components/navigation/ViewTabs";
import LoadingBlock from "@/components/ui/LoadingBlock";
import type { WhiteboardState, PlotPlan, CheckoutSession } from "@/types/schema";

interface Snapshot {
  states: Record<WhiteboardState, number>;
  checkouts: CheckoutSession[];
  coordination: CoordinationAnalysis;
  holds: HoldMetrics;
  openRequests: number;
  plotPlans: PlotPlan[];
  /** Sources that couldn't be read: their panels say so, not "nothing". */
  failed: string[];
}

type CoordView = "collisions" | "flow";

// useSearchParams needs a Suspense boundary above it for prerendering; the
// default export is that thin wrapper.
export default function CoordinationPage() {
  return (
    <Suspense fallback={<PageShell><PageHero kicker="Home · Coordination" title="Coordination" /><PageBody><Card><LoadingBlock what="the coordination board" className="border-0 p-0" /></Card></PageBody></PageShell>}>
      <CoordinationInner />
    </Suspense>
  );
}

function CoordinationInner() {
  const { activeOrgId } = useRole();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  // View switch, deep-linkable via ?view=flow. Switching updates the URL
  // without a navigation so links stay shareable.
  const searchParams = useSearchParams();
  const [view, setView] = useState<CoordView>(searchParams.get("view") === "flow" ? "flow" : "collisions");
  const switchView = useCallback((v: CoordView) => {
    setView(v);
    try {
      const url = new URL(window.location.href);
      if (v === "flow") url.searchParams.set("view", "flow"); else url.searchParams.delete("view");
      window.history.replaceState(null, "", url.toString());
    } catch { /* cosmetic only */ }
  }, []);

  const load = useCallback(async (background?: boolean) => {
    if (!activeOrgId) return;
    if (!background) setLoading(true);
    // Each source is fetched independently so one failure (e.g. a column that
    // only exists after a not-yet-run migration) degrades that one panel
    // instead of blanking the whole page.
    const zeroStates = { pending: 0, drafting: 0, executing: 0, completed: 0, blocked: 0 } as Record<WhiteboardState, number>;
    let migrationMissing = false;
    const failed: string[] = [];

    // All five sources are independent — fetched in PARALLEL so the page's
    // wall-clock cost is the slowest single query, not the sum of all of them
    // (sequential awaits here used to stack ~5 round trips back to back).
    const [states, holds, checkouts, plotPlans, reqCount] = await Promise.all([
      getStateCounts({ orgId: activeOrgId }).catch(() => { migrationMissing = true; return zeroStates; }),
      getHoldMetrics(activeOrgId).catch(() => { failed.push("holds"); return { activeCount: 0, activeByReason: [], longestActiveDays: 0, avgClosedDurationDays: 0, openedLast7Days: 0, releasedLast7Days: 0 } as HoldMetrics; }),
      listAllActiveCheckouts(activeOrgId).catch(() => { failed.push("checkouts"); return [] as CheckoutSession[]; }),
      listPlotPlans(activeOrgId).catch(() => { migrationMissing = true; return [] as PlotPlan[]; }),
      supabase.from("tickets").select("id", { count: "exact", head: true })
        .eq("org_id", activeOrgId)
        .not("status", "in", '("CLOSED","CANCELED")')
        .then(({ count, error }) => { if (error) failed.push("requests"); return count ?? 0; }, () => { failed.push("requests"); return 0; }),
    ]);
    let coordination: CoordinationAnalysis = {
      overlaps: [], activeCheckouts: checkouts.length, documents: 0,
      assetLinkedDocuments: 0, scopedDocuments: 0, comparableDocuments: 0,
    };
    try { coordination = await analyzeCheckoutCoordination({ activeCheckouts: checkouts }); } catch { failed.push("the collision check"); }

    setSnap({ states, holds, checkouts, coordination, openRequests: reqCount, plotPlans, failed });
    setSetupNeeded(migrationMissing);
    setRefreshedAt(Date.now());
    setLoading(false);
  }, [activeOrgId]);

  useEffect(() => { void (async () => { await load(); })(); }, [load]);

  // Wall-display heartbeat: refresh every 45s in the background.
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, 45_000);
    return () => window.clearInterval(id);
  }, [load]);

  // Resolve a checkout session id → who holds it, for naming the people in a
  // collision. Uses the already-loaded sessions — no extra fetch.
  const sessionById = useMemo(() => {
    const m = new Map<string, CheckoutSession>();
    for (const s of snap?.checkouts ?? []) if (s.id) m.set(s.id, s);
    return m;
  }, [snap?.checkouts]);

  const band = (title: React.ReactNode, sub?: React.ReactNode, tools?: React.ReactNode) => (
    <PageHero kicker="Home · Coordination" title={title} sub={sub} tools={tools}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="[&>div]:mb-0"><ViewTabs tabs={HOME_VIEWS} variant="dark" /></div>
        {/* The two situational boards, one page. */}
        <div role="group" aria-label="Board" className="inline-flex items-center gap-1 p-1 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)]">
          {([
            { key: "collisions" as const, label: "Collisions", icon: Radar },
            { key: "flow" as const, label: "Document flow", icon: LayoutGrid },
          ]).map((t) => (
            <button key={t.key} type="button" onClick={() => switchView(t.key)} aria-pressed={view === t.key}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-semibold transition-colors ${view === t.key ? "bg-[var(--color-ink-fg)] text-[var(--color-ink)]" : "text-[var(--color-ink-muted)] hover:text-white"}`}>
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          ))}
        </div>
      </div>
    </PageHero>
  );

  if (loading && !snap) {
    return <PageShell>{band("Coordination")}<PageBody><Card><LoadingBlock what="the coordination board" rows={6} className="border-0 p-0" /></Card></PageBody></PageShell>;
  }
  if (!snap) {
    return (
      <PageShell>
        {band("Couldn't load the board.")}
        <PageBody>
          <Card>
            <p className="text-[14px] text-[var(--color-text-muted)]">If it keeps failing, the database updates may not be applied yet.</p>
            <button onClick={() => void load()} className="mt-3 inline-flex items-center h-9 px-3.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-bold hover:bg-[var(--color-accent-hover)]">Try again</button>
          </Card>
        </PageBody>
      </PageShell>
    );
  }

  const totalEquip = WHITEBOARD_STATES.reduce((s, k) => s + snap.states[k], 0);
  const blocked = snap.states.blocked;
  const lockCount = snap.checkouts.length;
  const isEmpty = totalEquip === 0 && lockCount === 0 && snap.holds.activeCount === 0 && snap.openRequests === 0 && snap.plotPlans.length === 0 && snap.failed.length === 0;
  const collisions = snap.coordination.overlaps.length;
  const holds = snap.holds.activeCount;
  // The one line that matters: collisions first, then what's blocked.
  const answer = collisions
    ? <>{collisions} collision{collisions === 1 ? "" : "s"}. <span className="text-[var(--color-ink-muted)]">Two people on the same scope.</span></>
    : holds
      ? <>No collisions. <span className="text-[var(--color-ink-muted)]">{holds} hold{holds === 1 ? "" : "s"} blocking work.</span></>
      : lockCount ? <>No collisions. <span className="text-[var(--color-ink-muted)]">Nothing blocked.</span></> : "No active work to compare.";
  const sub = view === "flow" ? "Every controlled document by where it is in its life."
    : <>
        <Link href="/requests" className="hover:text-white"><b className="text-white">{snap.openRequests}</b> open request{snap.openRequests === 1 ? "" : "s"}</Link>
        <span className="mx-2 text-[var(--color-ink-muted)]">·</span>
        <Link href="/checkouts" className="hover:text-white"><b className="text-white">{lockCount}</b> active checkout{lockCount === 1 ? "" : "s"}</Link>
        <span className="max-sm:hidden text-[var(--color-ink-muted)]"> · personal queues live on Home</span>
      </>;
  const refresh = view === "collisions" ? (
    <button type="button" onClick={() => void load()} className={heroQuiet}>
      <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
      {refreshedAt ? `Updated ${new Date(refreshedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "Refresh"}
    </button>
  ) : undefined;

  return (
    <PageShell>
      {band(view === "flow" ? "Document flow." : answer, sub, refresh)}
      <PageBody>
        {view === "flow" && <Card pad={false} className="p-3 sm:p-4 overflow-hidden"><LifecycleBoard /></Card>}

        {view === "collisions" && (<>
        {/* The collision radar: the signal only this page produces. Always
            says what it watches and what it could compare. */}
        <CoordinationRadar analysis={snap.coordination} sessionById={sessionById} notes={<>
          {setupNeeded && (
            <p className="mb-3 text-[13px] text-amber-800 dark:text-amber-200">
              <b>Not set up yet.</b> Equipment state and plot plans aren&apos;t turned on for this workspace. Ask your Admin to finish setup (Admin › Settings › Database updates).
            </p>
          )}
          {snap.failed.length > 0 && (
            <div role="alert" className="mb-3 text-[13px] text-rose-700 dark:text-rose-300 flex flex-wrap items-center gap-x-3">
              <span>Couldn&apos;t load {snap.failed.join(", ")}. The numbers for {snap.failed.length === 1 ? "it" : "them"} below may be missing.</span>
              <button onClick={() => void load()} className="text-[13px] font-bold text-[var(--color-accent-text)] hover:underline">Try again</button>
            </div>
          )}
          {isEmpty && !setupNeeded && (
            <div className="mb-3 pb-3 border-b border-[var(--color-border)]">
              <p className="text-[13px] text-[var(--color-text-muted)] mb-2">
                Quiet because there&apos;s no active work. It fills in once documents are checked out against tagged equipment.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href="/admin/assets" className={QUIET_LINK}>Register equipment</Link>
                <Link href="/plot-plans" className={QUIET_LINK}>Create a plot plan</Link>
                <Link href="/documents" className={QUIET_LINK}>Check out a document</Link>
              </div>
            </div>
          )}
        </>} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Equipment state distribution */}
          <Panel title="Equipment state" span={2}>
            {totalEquip === 0 ? (
              <div className="text-[13px] text-[var(--color-text-muted)]">No equipment tracked yet. <Link href="/admin/assets" className="text-[var(--color-accent-text)] font-bold hover:underline">Register assets</Link> to see how it&apos;s tracking.</div>
            ) : (
              <>
                <p className="text-[14px] mb-3"><b>{totalEquip} tracked equipment item{totalEquip === 1 ? "" : "s"}.</b>{blocked > 0 && <span className="ml-1 text-rose-700 dark:text-rose-400 font-bold">{blocked} blocked.</span>}</p>
                <MiniBars
                  height={12}
                  segments={WHITEBOARD_STATES.map((s) => ({ value: snap.states[s], color: STATE_CONFIG[s].hex, label: STATE_CONFIG[s].label }))}
                />
                <div className="flex flex-wrap gap-3 mt-3">
                  {WHITEBOARD_STATES.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-text-muted)]">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: STATE_CONFIG[s].hex }} />
                      {STATE_CONFIG[s].label} <span className="text-[var(--color-text)]">{snap.states[s]}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </Panel>

          {/* Blockers (holds): framed around health, not just a count. */}
          <Panel title="Blockers" href="/admin/holds">
            {snap.failed.includes("holds")
              ? <p className="text-[13px] text-rose-700 dark:text-rose-300 font-bold">Couldn&apos;t read the holds</p>
              : <p className="text-[14px] font-bold text-[var(--color-text)]">{holds === 0 ? "Nothing blocked right now." : `${holds} active hold${holds === 1 ? "" : "s"}.`}</p>}
            <div className="mt-2 space-y-1.5 text-[12px]">
              {snap.holds.longestActiveDays > 0 && (
                <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]"><Clock className="w-3 h-3 text-amber-600 dark:text-amber-400" /> Longest open <span className="text-[var(--color-text)] font-bold">{snap.holds.longestActiveDays}d</span></div>
              )}
              {snap.holds.avgClosedDurationDays > 0 && (
                <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]"><ShieldCheck className="w-3 h-3 text-emerald-600 dark:text-emerald-400" /> Average to clear <span className="text-[var(--color-text)] font-bold">{snap.holds.avgClosedDurationDays}d</span></div>
              )}
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]"><ArrowUpRight className="w-3 h-3" /> {snap.holds.openedLast7Days} opened in 7 days</span>
                <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]"><ArrowDownRight className="w-3 h-3" /> {snap.holds.releasedLast7Days} cleared</span>
              </div>
            </div>
            {snap.holds.activeByReason.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {snap.holds.activeByReason.slice(0, 4).map((r) => (
                  <span key={r.reason} className="inline-flex items-center gap-1 text-[12px] font-bold px-1.5 py-0.5 rounded-md bg-rose-500/10 text-rose-700 dark:text-rose-300">
                    {r.reason} <span className="text-rose-800 dark:text-rose-200">{r.count}</span>
                  </span>
                ))}
              </div>
            )}
          </Panel>

          {/* Plot plans */}
          <Panel title="Spatial boards" span={3}>
            {snap.plotPlans.length === 0 ? (
              <div className="text-[13px] text-[var(--color-text-muted)]">No plot plans yet. <Link href="/plot-plans" className="text-[var(--color-accent-text)] font-bold hover:underline">Create one</Link> to find equipment on a map.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {snap.plotPlans.slice(0, 8).map((p) => (
                  <Link key={p.id} href={`/plot-plans/${p.id}`} className={QUIET_LINK}>
                    <MapIcon className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> {p.name} <span className="text-[var(--color-text-muted)]">{p.markers.length}</span>
                  </Link>
                ))}
                {snap.plotPlans.length > 8 && <Link href="/plot-plans" className="inline-flex items-center h-9 px-2 text-[13px] font-bold text-[var(--color-accent-text)] hover:underline">Show {snap.plotPlans.length - 8} more</Link>}
              </div>
            )}
          </Panel>
        </div>
        </>)}
      </PageBody>
    </PageShell>
  );
}

/** A quiet link that looks like a button (ink on a warm fill). */
const QUIET_LINK = "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text)] text-[13px] font-bold hover:bg-[var(--color-border)]";

// ─── Coordination radar ─────────────────────────────────────────────────────
// The crown jewel — and the page's most-misunderstood feature, so it explains
// itself. It surfaces when two or more people hold DIFFERENT documents whose
// scope overlaps (same asset / unit / system), catching duplicate or
// conflicting revisions BEFORE they're finished.
//
// Three honest states, never conflated:
//   • collisions   → the amber list of overlaps
//   • all clear    → enough comparable docs, none overlap (a real signal)
//   • standing by  → not enough scope-linked docs to compare (NOT "all good";
//                    the detector is starved of input — tell the user how to
//                    feed it)

function CoordinationRadar({
  analysis, sessionById, notes,
}: {
  analysis: CoordinationAnalysis;
  sessionById: Map<string, CheckoutSession>;
  /** What's wrong with the board itself (not set up, couldn't load), said first. */
  notes?: React.ReactNode;
}) {
  const { overlaps, activeCheckouts, documents, comparableDocuments, assetLinkedDocuments, scopedDocuments } = analysis;
  const canCompare = comparableDocuments >= 2;

  // What it watches and what it could see: in every state, so the feature
  // is legible even at a glance.
  const Header = (
    <div className="mb-3">
      <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
        Two people with different documents checked out on the same equipment tag, unit or system. Checked every 45 seconds.
      </p>
      {/* Coverage: proof of what it actually examined. */}
      <p className="mt-1.5 text-[12px] text-[var(--color-text-muted)]">
        <b className="text-[var(--color-text)]">{activeCheckouts}</b> checkouts scanned · <b className="text-[var(--color-text)]">{documents}</b> documents · <b className="text-[var(--color-text)]">{assetLinkedDocuments}</b> on equipment · <b className="text-[var(--color-text)]">{scopedDocuments}</b> on a unit or system · <b className="text-[var(--color-text)]">{comparableDocuments}</b> comparable
      </p>
    </div>
  );

  // STATE 1: collisions found.
  if (overlaps.length > 0) {
    return (
      <Card label="Collision radar" pad={false} className="overflow-hidden" action={<span className="text-[12px] font-bold text-amber-800 dark:text-amber-300">{overlaps.length} active</span>}>
        <div className="px-4 sm:px-5">{notes}{Header}</div>
        <div className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {overlaps.slice(0, 8).map((o, i) => {
            const people = Array.from(new Set(
              o.checkoutIds.map((id) => sessionById.get(id)?.userName).filter((n): n is string => !!n),
            ));
            const scope = o.kind === "asset"
              ? { tag: o.assetTag, kind: "Asset" }
              : { tag: o.scopeName, kind: o.level === "system" ? "System" : o.level === "unit" ? "Unit" : "Plant" };
            // Straight to a document in the collision; the list when none can be named.
            const first = o.checkoutIds.map((id) => sessionById.get(id)).find((x) => x?.libraryId && x.documentId);
            const href = first ? `/documents/${first.libraryId}?doc=${first.documentId}` : "/checkouts";
            return (
              <Link key={i} href={href} className="flex items-center gap-3 px-4 sm:px-5 py-3 hover:bg-[var(--color-surface-2)] transition-colors">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-bold text-[var(--color-text)] truncate">
                    <span className="text-[13px] font-semibold text-[var(--color-text-muted)] mr-1.5">{scope.kind}</span>
                    {scope.tag}
                  </div>
                  <div className="text-[12px] text-[var(--color-text-muted)] flex items-center gap-1.5 mt-0.5">
                    <Users className="w-3 h-3" />
                    {people.length > 0 ? people.join(", ") : `${o.checkoutIds.length} people`}
                    <span className="text-[var(--color-text-faint)]">·</span>
                    {o.checkoutIds.length} checkouts on {o.documentIds.length} doc{o.documentIds.length === 1 ? "" : "s"}
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
              </Link>
            );
          })}
        </div>
        {overlaps.length > 8 && (
          <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)]">
            <Link href="/checkouts" className="text-[13px] font-bold text-[var(--color-accent-text)] hover:underline">Show {overlaps.length - 8} more</Link>
          </div>
        )}
      </Card>
    );
  }

  // STATE 2: genuinely clear: it had enough to compare, found no overlap.
  if (canCompare) {
    return (
      <Card label="Collision radar">
        {notes}{Header}
        <div className="pt-3 border-t border-[var(--color-border)] flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <div className="text-[14px] font-bold text-[var(--color-text)]">All clear: no scope collisions</div>
            <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5">
              Compared {comparableDocuments} scope-linked document{comparableDocuments === 1 ? "" : "s"} across {activeCheckouts} active checkout{activeCheckouts === 1 ? "" : "s"}. No two crews are working overlapping asset, unit, or system scope.
            </div>
          </div>
        </div>
      </Card>
    );
  }

  // STATE 3: standing by: not enough scope-linked docs to compare. Explain
  // how to light it up instead of implying everything's fine.
  return (
    <Card label="Collision radar">
      {notes}{Header}
      <div className="pt-3 border-t border-[var(--color-border)] flex items-start gap-3">
        <Info className="w-5 h-5 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
        <div className="min-w-0">
          <div className="text-[14px] font-bold text-[var(--color-text)]">Nothing to compare yet</div>
          <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
            {documents === 0
              ? "No documents are checked out."
              : <>Of the {documents} checked-out document{documents === 1 ? "" : "s"}, only <span className="text-[var(--color-text)] font-bold">{comparableDocuments}</span> {comparableDocuments === 1 ? "is" : "are"} tied to equipment or a unit or system. It needs at least two.</>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/documents" className={QUIET_LINK}>
              <Tag className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Tag documents to equipment
            </Link>
            <Link href="/admin/assets" className={QUIET_LINK}>
              <Boxes className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Equipment registry
            </Link>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Panel({
  title, children, span = 1, href,
}: {
  title: string;
  children: React.ReactNode;
  span?: 1 | 2 | 3;
  href?: string;
}) {
  const spanCls = span === 3 ? "lg:col-span-3" : span === 2 ? "lg:col-span-2" : "";
  return (
    <Card label={title} className={`${spanCls} h-full`}
      action={href ? <Link href={href} aria-label={`Open ${title.toLowerCase()}`} className="w-8 h-8 -my-1 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><ChevronRight className="w-4 h-4" /></Link> : undefined}>
      {children}
    </Card>
  );
}
