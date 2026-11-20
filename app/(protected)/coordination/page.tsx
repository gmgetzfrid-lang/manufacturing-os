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
  ShieldCheck, AlertTriangle, Users, Boxes,
  Radar, Info, Tag, LayoutGrid,
} from "lucide-react";
import { PageHero, PageBody, Card, heroQuiet, type HeroFact } from "@/components/ui/PageHero";
import { bandSeg, bandSegItem } from "@/components/admin/band";
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
import HelpTooltip from "@/components/ui/HelpTooltip";
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

  const band = (title: React.ReactNode, sub?: React.ReactNode, tools?: React.ReactNode, facts?: HeroFact[]) => (
    <PageHero kicker="Home · Coordination" title={title} sub={sub} tools={tools} facts={facts}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="[&>div]:mb-0"><ViewTabs tabs={HOME_VIEWS} /></div>
        {/* The two situational boards, one page. */}
        <div role="group" aria-label="Board" className={bandSeg}>
          {([
            { key: "collisions" as const, label: "Collisions", icon: Radar },
            { key: "flow" as const, label: "Document flow", icon: LayoutGrid },
          ]).map((t) => (
            <button key={t.key} type="button" onClick={() => switchView(t.key)} aria-pressed={view === t.key} className={bandSegItem(view === t.key)}>
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
            <p className="text-[15px] text-[var(--color-text-muted)]">If it keeps failing, the database updates may not be applied yet.</p>
            <button type="button" onClick={() => void load()} className="mt-3 inline-flex items-center h-10 px-4 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[15px] font-semibold hover:bg-[var(--color-accent-hover)]">Try again</button>
          </Card>
        </PageBody>
      </PageShell>
    );
  }

  const totalEquip = WHITEBOARD_STATES.reduce((s, k) => s + snap.states[k], 0);
  const blocked = snap.states.blocked;
  const lockCount = snap.checkouts.length;
  const collisions = snap.coordination.overlaps.length;
  const holds = snap.holds.activeCount;
  // The one line that matters: collisions first; what's blocked and the
  // work in flight are the facts beside it.
  const answer = collisions
    ? `${collisions} collision${collisions === 1 ? "" : "s"}: two people on the same scope.`
    : lockCount ? "No collisions." : "No active work to compare.";
  const sub = view === "flow" ? "Every controlled document by where it is in its life."
    : <Link href="/requests" className="text-[var(--color-accent-text)] hover:underline">{snap.openRequests} open request{snap.openRequests === 1 ? "" : "s"}</Link>;
  const factLink = (href: string, n: number) => <Link href={href} className="hover:text-[var(--color-accent-text)]">{n}</Link>;
  const facts: HeroFact[] | undefined = view === "flow" ? undefined : [
    { label: "Collisions", value: collisions, tone: collisions ? "bad" : undefined },
    { label: "Holds", value: factLink("/admin/holds", holds), tone: holds ? "warn" : undefined },
    { label: "Checkouts", value: factLink("/checkouts", lockCount) },
  ];
  const refresh = view === "collisions" ? (
    <button type="button" onClick={() => void load()} className={heroQuiet}>
      <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
      {refreshedAt ? `Updated ${new Date(refreshedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "Refresh"}
    </button>
  ) : undefined;

  return (
    <PageShell>
      {band(view === "flow" ? "Document flow." : answer, sub, refresh, facts)}
      <PageBody>
        {view === "flow" && <Card pad={false} className="p-3 sm:p-4 overflow-hidden"><LifecycleBoard /></Card>}

        {view === "collisions" && (<>
        {/* The collision radar: the signal only this page produces. Always
            says what it watches and what it could compare. */}
        <CoordinationRadar analysis={snap.coordination} sessionById={sessionById} notes={<>
          {setupNeeded && (
            <p className="mb-3 text-[14px] text-[var(--color-text)]">
              <span className="font-semibold text-[var(--state-held)]">Not set up yet.</span> Equipment state and plot plans are off for this workspace. <HelpTooltip>Ask your Admin to finish setup: Admin › Settings › Database updates.</HelpTooltip>
            </p>
          )}
          {snap.failed.length > 0 && (
            <div role="alert" className="mb-3 text-[14px] text-[var(--state-overdue)] font-semibold flex flex-wrap items-center gap-x-3">
              <span>Couldn&apos;t load {snap.failed.join(", ")}. Numbers below may be missing.</span>
              <button type="button" onClick={() => void load()} className="font-normal text-[var(--color-accent-text)] hover:underline">Try again</button>
            </div>
          )}
        </>} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Equipment state distribution */}
          <Panel title="Equipment state" span={2}>
            {totalEquip === 0 ? (
              <div className="text-[15px] text-[var(--color-text-muted)]">No equipment tracked yet. <Link href="/admin/assets" className="text-[var(--color-accent-text)] hover:underline">Register equipment</Link></div>
            ) : (
              <>
                <p className="text-[15px] mb-3 text-[var(--color-text)]"><span className="font-display text-[19px] font-semibold tabular-nums">{totalEquip}</span> tracked{blocked > 0 && <span className="ml-3 font-semibold text-[var(--state-overdue)]"><span className="font-display tabular-nums">{blocked}</span> blocked</span>}</p>
                <MiniBars
                  height={12}
                  segments={WHITEBOARD_STATES.map((s) => ({ value: snap.states[s], color: STATE_CONFIG[s].hex, label: STATE_CONFIG[s].label }))}
                />
                <div className="flex flex-wrap gap-3 mt-3">
                  {WHITEBOARD_STATES.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STATE_CONFIG[s].hex }} />
                      {STATE_CONFIG[s].label} <span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{snap.states[s]}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </Panel>

          {/* Blockers (holds): framed around health, not just a count. */}
          <Panel title="Blockers" href="/admin/holds">
            {snap.failed.includes("holds")
              ? <p className="text-[15px] font-semibold text-[var(--state-overdue)]">Couldn&apos;t read the holds</p>
              : <p className="text-[15px] text-[var(--color-text)]">{holds === 0 ? "Nothing blocked right now." : <><span className="font-display text-[19px] font-semibold tabular-nums text-[var(--state-held)]">{holds}</span> active hold{holds === 1 ? "" : "s"}</>}</p>}
            {/* How holds are going: one fact a row. */}
            <dl className="mt-2 divide-y divide-[var(--color-border)] border-t border-[var(--color-border)] text-[14px]">
              {([
                snap.holds.longestActiveDays > 0 ? ["Longest open", `${snap.holds.longestActiveDays}d`] : null,
                snap.holds.avgClosedDurationDays > 0 ? ["Average to clear", `${snap.holds.avgClosedDurationDays}d`] : null,
                ["Opened in 7 days", String(snap.holds.openedLast7Days)],
                ["Cleared in 7 days", String(snap.holds.releasedLast7Days)],
              ].filter(Boolean) as Array<[string, string]>).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3 py-1.5">
                  <dt className="text-[var(--color-text-muted)]">{k}</dt>
                  <dd className="font-display font-semibold tabular-nums text-[var(--color-text)]">{v}</dd>
                </div>
              ))}
            </dl>
            {snap.holds.activeByReason.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                {snap.holds.activeByReason.slice(0, 4).map((r) => (
                  <span key={r.reason} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)]">
                    <span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-held)]" />
                    {r.reason} <span className="font-display tabular-nums text-[var(--color-text-muted)]">{r.count}</span>
                  </span>
                ))}
              </div>
            )}
          </Panel>

          {/* Plot plans */}
          <Panel title="Spatial boards" span={3}>
            {snap.plotPlans.length === 0 ? (
              <div className="text-[15px] text-[var(--color-text-muted)]">No plot plans yet. <Link href="/plot-plans" className="text-[var(--color-accent-text)] hover:underline">Create a plot plan</Link></div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {snap.plotPlans.slice(0, 8).map((p) => (
                  <Link key={p.id} href={`/plot-plans/${p.id}`} className={QUIET_LINK}>
                    <MapIcon className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> {p.name} <span className="text-[var(--color-text-muted)]">{p.markers.length}</span>
                  </Link>
                ))}
                {snap.plotPlans.length > 8 && <Link href="/plot-plans" className="inline-flex items-center h-9 px-2 text-[14px] text-[var(--color-accent-text)] hover:underline">Show {snap.plotPlans.length - 8} more</Link>}
              </div>
            )}
          </Panel>
        </div>
        </>)}
      </PageBody>
    </PageShell>
  );
}

/** The radar's heading, with what it watches one tap away. */
const RADAR_LABEL = <>Collision radar <HelpTooltip>Two people with different documents checked out on the same equipment tag, unit or system. Checked every 45 seconds.</HelpTooltip></>;

/** A quiet link that looks like a button (ink on a warm fill). */
const QUIET_LINK = heroQuiet;

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
  // (What it watches is the page's subtitle.) Coverage: proof of what it
  // actually examined, one ruled cell a number.
  const cover: Array<[string, number]> = [["Checkouts scanned", activeCheckouts], ["Documents", documents], ["On equipment", assetLinkedDocuments], ["On a unit or system", scopedDocuments], ["Comparable", comparableDocuments]];
  const Header = (
    <dl className="mb-4 grid grid-cols-2 sm:grid-cols-5 border-y border-[var(--color-border)]">
      {cover.map(([k, v], i) => (
        <div key={k} className={`py-2 pr-3 border-[var(--color-border)] ${i % 2 ? "max-sm:pl-3 max-sm:border-l" : ""} ${i > 0 ? "sm:pl-4 sm:border-l" : ""} ${i >= 2 ? "max-sm:border-t" : ""}`}>
          <dt className="text-[13px] text-[var(--color-text-muted)]">{k}</dt>
          <dd className="font-display text-[22px] leading-tight font-semibold tabular-nums text-[var(--color-text)]">{v}</dd>
        </div>
      ))}
    </dl>
  );

  // STATE 1: collisions found.
  if (overlaps.length > 0) {
    return (
      <Card label={RADAR_LABEL} pad={false} className="overflow-hidden" action={<span className="text-[14px] font-semibold text-[var(--state-overdue)]">{overlaps.length} active</span>}>
        <div className="px-4 sm:px-5 pt-4">{notes}{Header}</div>
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
                <AlertTriangle className="w-4 h-4 text-[var(--state-overdue)] shrink-0" />
                <div className="min-w-0 flex-1 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-center sm:gap-4">
                  <div className="text-[15px] font-semibold text-[var(--color-text)] truncate">
                    <span className="text-[13px] font-normal text-[var(--color-text-muted)] mr-1.5">{scope.kind}</span>
                    <span className="font-display tabular-nums">{scope.tag}</span>
                  </div>
                  <div className="text-[14px] text-[var(--color-text)] flex items-center gap-1.5 min-w-0">
                    <Users className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
                    <span className="truncate">{people.length > 0 ? people.join(", ") : `${o.checkoutIds.length} people`}</span>
                  </div>
                  <div className="text-[13px] text-[var(--color-text-muted)] whitespace-nowrap">{o.checkoutIds.length} checkouts on {o.documentIds.length} doc{o.documentIds.length === 1 ? "" : "s"}</div>
                </div>
                <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
              </Link>
            );
          })}
        </div>
        {overlaps.length > 8 && (
          <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)]">
            <Link href="/checkouts" className="text-[14px] text-[var(--color-accent-text)] hover:underline">Show {overlaps.length - 8} more</Link>
          </div>
        )}
      </Card>
    );
  }

  // STATE 2: genuinely clear: it had enough to compare, found no overlap.
  if (canCompare) {
    return (
      <Card label={RADAR_LABEL}>
        {notes}{Header}
        <div className="flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 mt-0.5 shrink-0 text-[var(--state-released)]" />
          <div>
            <div className="text-[15px] font-semibold text-[var(--color-text)]">All clear: no scope collisions</div>
            <div className="text-[14px] text-[var(--color-text-muted)] mt-0.5">No two crews hold documents on the same equipment, unit or system.</div>
          </div>
        </div>
      </Card>
    );
  }

  // STATE 3: standing by: not enough scope-linked docs to compare. Explain
  // how to light it up instead of implying everything's fine.
  return (
    <Card label={RADAR_LABEL}>
      {notes}{Header}
      <div className="flex items-start gap-3">
        <Info className="w-5 h-5 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-[var(--color-text)]">Nothing to compare yet</div>
          <div className="text-[14px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
            {documents === 0
              ? "No documents are checked out."
              : <>Only {comparableDocuments} of {documents} checked-out document{documents === 1 ? "" : "s"} {comparableDocuments === 1 ? "is" : "are"} tied to equipment, a unit or a system. It needs two.</>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/documents" className={QUIET_LINK}>
              <Tag className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Tag documents to equipment
            </Link>
            <Link href="/admin/assets" className={QUIET_LINK}>
              <Boxes className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Equipment registry
            </Link>
            <Link href="/plot-plans" className={QUIET_LINK}>
              <MapIcon className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Plot plans
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
    <Card label={title} className={spanCls}
      action={href ? <Link href={href} className="text-[14px] text-[var(--color-accent-text)] hover:underline">Open {title.toLowerCase()}</Link> : undefined}>
      {children}
    </Card>
  );
}
