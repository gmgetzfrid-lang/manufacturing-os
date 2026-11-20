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
  Network, RefreshCw, Lock, AlertOctagon, Map as MapIcon, ChevronRight,
  ShieldCheck, AlertTriangle, Users, Boxes, Clock, MailPlus, ArrowDownRight, ArrowUpRight,
  Radar, Info, Tag, Layers, LayoutGrid,
} from "lucide-react";
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
    <Suspense fallback={<div className="p-6 max-w-7xl mx-auto"><LoadingBlock what="the coordination board" /></div>}>
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

  if (loading && !snap) {
    return <div className="min-h-full bg-[var(--color-canvas)] p-6"><div className="max-w-7xl mx-auto"><LoadingBlock what="the coordination board" rows={6} /></div></div>;
  }
  if (!snap) {
    return (
      <div className="min-h-full bg-[var(--color-canvas)] flex flex-col items-center justify-center text-center p-6">
        <Network className="w-10 h-10 text-[var(--color-text-muted)] mb-3" />
        <h1 className="text-lg font-black text-[var(--color-text)]">Coordination</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-2 max-w-sm">Couldn&apos;t load the board. If it keeps failing, the database updates may not be applied yet.</p>
        <button onClick={() => void load()} className="mt-4 px-4 py-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-sm font-bold hover:bg-[var(--color-accent-hover)]">Try again</button>
      </div>
    );
  }

  const totalEquip = WHITEBOARD_STATES.reduce((s, k) => s + snap.states[k], 0);
  const blocked = snap.states.blocked;
  const lockCount = snap.checkouts.length;
  const isEmpty = totalEquip === 0 && lockCount === 0 && snap.holds.activeCount === 0 && snap.openRequests === 0 && snap.plotPlans.length === 0 && snap.failed.length === 0;
  const collisions = snap.coordination.overlaps.length;
  // The one line that matters: collisions first, then what's blocked.
  const headline = collisions
    ? `${collisions} place${collisions === 1 ? "" : "s"} where two people are working the same scope right now.`
    : snap.holds.activeCount
      ? `No scope collisions. ${snap.holds.activeCount} hold${snap.holds.activeCount === 1 ? " is" : "s are"} blocking work.`
      : lockCount ? `No scope collisions across ${lockCount} active checkout${lockCount === 1 ? "" : "s"}, and nothing blocked.` : "No active work to compare right now.";

  return (
    <div className="min-h-full bg-[var(--color-canvas)] text-[var(--color-text)] p-6">
      <div className="max-w-7xl mx-auto">
        <ViewTabs title="Home" tabs={HOME_VIEWS} />
        <div className="flex items-start justify-between mb-2 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-black text-[var(--color-text)] flex items-center gap-3">
              <Network className="w-7 h-7 text-[var(--color-text-muted)]" /> Coordination
            </h1>
            <p className={`text-sm mt-1 ${collisions ? "font-bold text-amber-800 dark:text-amber-300" : "text-[var(--color-text-muted)]"}`}>{view === "collisions" ? headline : "Every controlled document by where it is in its life."}</p>
          </div>
          {view === "collisions" && (
            <button onClick={() => void load()} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              {refreshedAt ? `Updated ${new Date(refreshedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "Refresh"}
            </button>
          )}
        </div>

        {/* View switch — the two situational boards, one page. */}
        <div className="inline-flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 mb-4">
          {([
            { key: "collisions" as const, label: "Collisions", icon: Radar },
            { key: "flow" as const, label: "Document flow", icon: LayoutGrid },
          ]).map((t) => (
            <button
              key={t.key}
              onClick={() => switchView(t.key)}
              aria-pressed={view === t.key}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                view === t.key
                  ? "bg-[var(--color-text)] text-[var(--color-surface)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          ))}
        </div>

        {view === "flow" && <LifecycleBoard />}

        {view === "collisions" && (<>
        {/* Demoted context strip — the plain totals (these are Home's job now). */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-5 text-[11px] text-[var(--color-text-muted)]">
          <Link href="/requests" className="inline-flex items-center gap-1.5 hover:text-[var(--color-text)]">
            <MailPlus className="w-3 h-3" /> <span className="font-bold text-[var(--color-text)]">{snap.openRequests}</span> open requests
          </Link>
          <Link href="/checkouts" className="inline-flex items-center gap-1.5 hover:text-[var(--color-text)]">
            <Lock className="w-3 h-3" /> <span className="font-bold text-[var(--color-text)]">{lockCount}</span> active locks
          </Link>
          <span className="text-[var(--color-text-faint)] hidden sm:inline">Personal queues live on Home</span>
        </div>

        {setupNeeded && (
          <p className="mb-4 border-l-2 border-amber-500 pl-3 text-sm text-amber-800 dark:text-amber-200">
            <span className="font-black">Not set up yet.</span> Equipment state and plot plans aren&apos;t turned on for this workspace. Ask your Admin to finish setup (Admin › Settings › Database updates).
          </p>
        )}

        {snap.failed.length > 0 && (
          <div role="alert" className="mb-4 border-l-2 border-rose-500 pl-3 text-sm text-rose-700 dark:text-rose-300 flex flex-wrap items-center gap-x-3">
            <span>Couldn&apos;t load {snap.failed.join(", ")}. The numbers for {snap.failed.length === 1 ? "it" : "them"} below may be missing.</span>
            <button onClick={() => void load()} className="text-xs font-bold text-[var(--color-accent)] hover:underline">Try again</button>
          </div>
        )}

        {isEmpty && !setupNeeded && (
          <div className="mb-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <p className="text-sm text-[var(--color-text-muted)] mb-3">
              Quiet because there&apos;s no active work. It fills in once documents are checked out against tagged equipment.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href="/admin/assets" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text)] text-xs font-bold hover:bg-[var(--color-border-strong)]">Register equipment</Link>
              <Link href="/plot-plans" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text)] text-xs font-bold hover:bg-[var(--color-border-strong)]">Create a plot plan</Link>
              <Link href="/documents" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text)] text-xs font-bold hover:bg-[var(--color-border-strong)]">Check out a document</Link>
            </div>
          </div>
        )}

        {/* ── HERO: collision radar — the signal only this page produces.
            Always self-explaining + reports exactly what it could compare. ── */}
        <CoordinationRadar analysis={snap.coordination} sessionById={sessionById} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
          {/* Equipment state distribution */}
          <Panel title="Equipment state" icon={Boxes} accent="text-[var(--color-text-muted)]" span={2}>
            {totalEquip === 0 ? (
              <div className="text-xs text-[var(--color-text-muted)]">No equipment tracked yet. <Link href="/admin/assets" className="text-[var(--color-accent)] font-bold hover:underline">Register assets</Link> to see how it&apos;s tracking.</div>
            ) : (
              <>
                <div className="flex items-end gap-4 mb-3">
                  <div className="text-4xl font-black text-[var(--color-text)]">{totalEquip}</div>
                  <div className="text-xs text-[var(--color-text-muted)] pb-1">tracked equipment items{blocked > 0 && <span className="ml-2 text-rose-600 dark:text-rose-400 font-bold">· {blocked} blocked</span>}</div>
                </div>
                <MiniBars
                  height={12}
                  segments={WHITEBOARD_STATES.map((s) => ({ value: snap.states[s], color: STATE_CONFIG[s].hex, label: STATE_CONFIG[s].label }))}
                />
                <div className="flex flex-wrap gap-3 mt-3">
                  {WHITEBOARD_STATES.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-muted)]">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: STATE_CONFIG[s].hex }} />
                      {STATE_CONFIG[s].label} <span className="text-[var(--color-text)]">{snap.states[s]}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </Panel>

          {/* Blockers (holds) — framed around health, not just a count. */}
          <Panel title="Blockers" icon={AlertOctagon} accent="text-rose-600 dark:text-rose-400" href="/admin/holds">
            <div className="flex items-end gap-3">
              <div className="text-4xl font-black text-[var(--color-text)]">{snap.holds.activeCount}</div>
              <div className="text-xs text-[var(--color-text-muted)] pb-1">active hold{snap.holds.activeCount === 1 ? "" : "s"}</div>
            </div>
            <div className="mt-3 space-y-1.5 text-[11px]">
              {snap.holds.longestActiveDays > 0 && (
                <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]"><Clock className="w-3 h-3 text-amber-600 dark:text-amber-400" /> Longest open <span className="text-[var(--color-text)] font-bold">{snap.holds.longestActiveDays}d</span></div>
              )}
              {snap.holds.avgClosedDurationDays > 0 && (
                <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]"><ShieldCheck className="w-3 h-3 text-emerald-600 dark:text-emerald-400" /> Avg resolution <span className="text-[var(--color-text)] font-bold">{snap.holds.avgClosedDurationDays}d</span></div>
              )}
              <div className="flex items-center gap-3 pt-1">
                <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300"><ArrowUpRight className="w-3 h-3" /> {snap.holds.openedLast7Days} opened/7d</span>
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><ArrowDownRight className="w-3 h-3" /> {snap.holds.releasedLast7Days} cleared/7d</span>
              </div>
            </div>
            {snap.holds.activeByReason.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {snap.holds.activeByReason.slice(0, 4).map((r) => (
                  <span key={r.reason} className="inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-md bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/20">
                    {r.reason} <span className="text-rose-800 dark:text-rose-200">{r.count}</span>
                  </span>
                ))}
              </div>
            )}
            {snap.holds.activeCount === 0 && !snap.failed.includes("holds") && (
              <div className="mt-3 text-xs text-emerald-600 dark:text-emerald-400 font-bold">Nothing blocked right now</div>
            )}
            {snap.failed.includes("holds") && <div className="mt-3 text-xs text-rose-700 dark:text-rose-300 font-bold">Couldn&apos;t read the holds</div>}
          </Panel>

          {/* Plot plans */}
          <Panel title="Spatial boards" icon={MapIcon} accent="text-[var(--color-text-muted)]" span={3}>
            {snap.plotPlans.length === 0 ? (
              <div className="text-xs text-[var(--color-text-muted)]">No plot plans yet. <Link href="/plot-plans" className="text-[var(--color-accent)] font-bold hover:underline">Create one</Link> to find equipment on a map.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {snap.plotPlans.slice(0, 8).map((p) => (
                  <Link key={p.id} href={`/plot-plans/${p.id}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-bold text-[var(--color-text)] hover:border-[var(--color-border-strong)]">
                    <MapIcon className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> {p.name} <span className="text-[var(--color-text-muted)]">{p.markers.length}</span>
                  </Link>
                ))}
              </div>
            )}
          </Panel>
        </div>
        </>)}
      </div>
    </div>
  );
}

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
  analysis, sessionById,
}: {
  analysis: CoordinationAnalysis;
  sessionById: Map<string, CheckoutSession>;
}) {
  const { overlaps, activeCheckouts, documents, comparableDocuments, assetLinkedDocuments, scopedDocuments } = analysis;
  const canCompare = comparableDocuments >= 2;

  // Shared "what this is + what it can see" header — present in every state so
  // the feature is legible even at a glance.
  const Header = (
    <div className="px-5 pt-4 pb-3">
      <div className="flex items-center gap-2">
        <Radar className="w-5 h-5 text-[var(--color-text-muted)]" />
        <span className="text-base font-black text-[var(--color-text)]">Collision radar</span>
        <span className="ml-auto text-[11px] font-bold text-[var(--color-text-muted)]">Updates every 45 seconds</span>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mt-1.5 leading-relaxed">
        Two people with different documents checked out on the same equipment tag, unit or system.
      </p>
      {/* Coverage readout — proof of what it actually examined. */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Coverage icon={Lock} label="checkouts scanned" value={activeCheckouts} />
        <Coverage icon={Boxes} label="documents" value={documents} />
        <Coverage icon={Tag} label="asset-linked" value={assetLinkedDocuments} />
        <Coverage icon={Layers} label="unit/system-scoped" value={scopedDocuments} />
        <Coverage icon={Radar} label="comparable" value={comparableDocuments} highlight />
      </div>
    </div>
  );

  // STATE 1 — collisions found.
  if (overlaps.length > 0) {
    return (
      <div className="rounded-2xl border border-amber-500/40 overflow-hidden bg-[var(--color-surface-2)]">
        {Header}
        <div className="px-5 pb-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          <span className="text-sm font-black text-amber-800 dark:text-amber-200">{overlaps.length} active collision{overlaps.length === 1 ? "" : "s"}</span>
          <span className="ml-auto text-[11px] text-amber-800 dark:text-amber-200 hidden sm:inline">Talk before conflicting revisions land</span>
        </div>
        <div className="border-t border-amber-500/20 divide-y divide-amber-500/10">
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
              <Link key={i} href={href} className="flex items-center gap-3 px-5 py-3 hover:bg-amber-500/[0.06] transition-colors">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-[var(--color-text)] truncate">
                    <span className="text-[11px] font-black uppercase tracking-wider text-amber-700/80 dark:text-amber-300/80 mr-1.5">{scope.kind}</span>
                    {scope.tag}
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)] flex items-center gap-1.5 mt-0.5">
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
          <div className="px-5 py-2 border-t border-amber-500/10">
            <Link href="/checkouts" className="text-xs font-bold text-[var(--color-accent)] hover:underline">See all {overlaps.length} collisions</Link>
          </div>
        )}
      </div>
    );
  }

  // STATE 2 — genuinely clear: it had enough to compare, found no overlap.
  if (canCompare) {
    return (
      <div className="rounded-2xl border border-emerald-500/30 overflow-hidden bg-[var(--color-surface-2)]">
        {Header}
        <div className="px-5 pb-4 pt-1 flex items-center gap-3 border-t border-emerald-500/15">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0 mt-1">
            <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <div className="text-sm font-black text-[var(--color-text)]">All clear: no scope collisions</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
              Compared {comparableDocuments} scope-linked document{comparableDocuments === 1 ? "" : "s"} across {activeCheckouts} active checkout{activeCheckouts === 1 ? "" : "s"}. No two crews are working overlapping asset, unit, or system scope.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // STATE 3 — standing by: not enough scope-linked docs to compare. Explain how
  // to light it up instead of implying everything's fine.
  return (
    <div className="rounded-2xl border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface-2)]">
      {Header}
      <div className="px-5 pb-4 pt-1 border-t border-[var(--color-border)]">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border-strong)] flex items-center justify-center shrink-0 mt-0.5">
            <Info className="w-5 h-5 text-[var(--color-text-muted)]" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Nothing to compare yet</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1 leading-relaxed">
              {documents === 0
                ? "No documents are checked out."
                : <>Of the {documents} checked-out document{documents === 1 ? "" : "s"}, only <span className="text-[var(--color-text)] font-bold">{comparableDocuments}</span> {comparableDocuments === 1 ? "is" : "are"} tied to equipment or a unit or system. It needs at least two.</>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/documents" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text)] text-xs font-bold hover:bg-[var(--color-border-strong)]">
                <Tag className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Tag documents to equipment
              </Link>
              <Link href="/admin/assets" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text)] text-xs font-bold hover:bg-[var(--color-border-strong)]">
                <Boxes className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Equipment registry
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Coverage({ icon: Icon, label, value, highlight }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number; highlight?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] font-bold text-[var(--color-text-muted)] ${highlight ? "bg-[var(--color-surface-2)] border-[var(--color-border-strong)]" : "bg-[var(--color-surface)] border-[var(--color-border)]"}`}>
      <Icon className="w-3 h-3" />
      <span className="text-[var(--color-text)]">{value}</span> {label}
    </span>
  );
}

function Panel({
  title, icon: Icon, accent, children, span = 1, href,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  children: React.ReactNode;
  span?: 1 | 2 | 3;
  href?: string;
}) {
  const spanCls = span === 3 ? "lg:col-span-3" : span === 2 ? "lg:col-span-2" : "";
  const body = (
    <div className={`rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] p-5 h-full ${href ? "hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] transition-colors" : ""}`}>
      <div className="flex items-center gap-2 mb-3">
        <Icon className={`w-4 h-4 ${accent}`} />
        <span className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">{title}</span>
        {href && <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-faint)] ml-auto" />}
      </div>
      {children}
    </div>
  );
  return <div className={spanCls}>{href ? <Link href={href} className="block h-full">{body}</Link> : body}</div>;
}
