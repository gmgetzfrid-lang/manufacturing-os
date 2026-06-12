"use client";

// /war-room — "Coordination". The org-wide situational board, built around the
// one question no personal inbox can answer: WHERE IS WORK COLLIDING right now?
//
// It leads with scope-collision detection (two crews holding different
// documents that touch the same physical asset / unit / system), then the
// operational context that decides whether that work can move — blockers
// (holds) with aging, equipment-state distribution, and the spatial boards.
//
// The plain "how many open requests / locks" counts deliberately live on Home
// now; here they're a thin context strip, not the headline — the value of this
// page is the coordination signal + analysis, not the totals.
//
// Dark "big board" theme, auto-refreshing so it can live on a wall display
// during a turnaround. Read-only intelligence — every signal deep-links to the
// surface where you act on it.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Network, Loader2, RefreshCw, Lock, AlertOctagon, Map as MapIcon, ChevronRight,
  ShieldCheck, AlertTriangle, Users, Boxes, Clock, MailPlus, ArrowDownRight, ArrowUpRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { getStateCounts, STATE_CONFIG, WHITEBOARD_STATES } from "@/lib/whiteboard";
import { getHoldMetrics, type HoldMetrics } from "@/lib/holds";
import { listAllActiveCheckouts } from "@/lib/projects";
import { findCheckoutOverlaps, type ConsolidationOverlap } from "@/lib/consolidation";
import { listPlotPlans } from "@/lib/plotPlans";
import { MiniBars } from "@/components/ui/Sparkline";
import ViewTabs, { HOME_VIEWS } from "@/components/navigation/ViewTabs";
import type { WhiteboardState, PlotPlan, CheckoutSession } from "@/types/schema";

interface Snapshot {
  states: Record<WhiteboardState, number>;
  checkouts: CheckoutSession[];
  overlaps: ConsolidationOverlap[];
  holds: HoldMetrics;
  openRequests: number;
  plotPlans: PlotPlan[];
}

export default function CoordinationPage() {
  const { activeOrgId } = useRole();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);

  const load = useCallback(async (background?: boolean) => {
    if (!activeOrgId) return;
    if (!background) setLoading(true);
    // Each source is fetched independently so one failure (e.g. a column that
    // only exists after a not-yet-run migration) degrades that one panel
    // instead of blanking the whole page.
    const zeroStates = { pending: 0, drafting: 0, executing: 0, completed: 0, blocked: 0 } as Record<WhiteboardState, number>;
    let migrationMissing = false;

    const states = await getStateCounts({ orgId: activeOrgId }).catch(() => { migrationMissing = true; return zeroStates; });
    const holds = await getHoldMetrics(activeOrgId).catch(() => ({ activeCount: 0, activeByReason: [], longestActiveDays: 0, avgClosedDurationDays: 0, openedLast7Days: 0, releasedLast7Days: 0 } as HoldMetrics));
    const checkouts = await listAllActiveCheckouts(activeOrgId).catch(() => [] as CheckoutSession[]);
    const plotPlans = await listPlotPlans(activeOrgId).catch(() => { migrationMissing = true; return []; });
    let reqCount = 0;
    try {
      const { count } = await supabase.from("tickets").select("id", { count: "exact", head: true })
        .eq("org_id", activeOrgId)
        .not("status", "in", '("CLOSED","CANCELED")');
      reqCount = count ?? 0;
    } catch { reqCount = 0; }
    let overlaps: ConsolidationOverlap[] = [];
    try { overlaps = await findCheckoutOverlaps({ activeCheckouts: checkouts }); } catch { /* non-fatal */ }

    setSnap({ states, holds, checkouts, overlaps, openRequests: reqCount, plotPlans });
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
    return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-orange-500" /></div>;
  }
  if (!snap) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-center p-6">
        <Network className="w-10 h-10 text-orange-500 mb-3" />
        <h1 className="text-lg font-black text-white">Coordination</h1>
        <p className="text-sm text-slate-400 mt-2 max-w-sm">Couldn&apos;t load the operational picture. Try refresh — if this persists, the database migrations may not be applied yet.</p>
        <button onClick={() => void load()} className="mt-4 px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-bold">Refresh</button>
      </div>
    );
  }

  const totalEquip = WHITEBOARD_STATES.reduce((s, k) => s + snap.states[k], 0);
  const blocked = snap.states.blocked;
  const lockCount = snap.checkouts.length;
  const isEmpty = totalEquip === 0 && lockCount === 0 && snap.holds.activeCount === 0 && snap.openRequests === 0 && snap.plotPlans.length === 0;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-6">
      <div className="max-w-7xl mx-auto">
        <ViewTabs title="Home" tabs={HOME_VIEWS} variant="dark" />
        <div className="flex items-start justify-between mb-2 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-black text-white flex items-center gap-3">
              <Network className="w-7 h-7 text-orange-500" /> Coordination
            </h1>
            <p className="text-sm text-slate-400 mt-1">Where work overlaps, what&apos;s blocking it, and how the floor is tracking — org-wide and live.</p>
          </div>
          <button onClick={() => void load()} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs font-bold text-slate-300 hover:bg-slate-800">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            {refreshedAt ? `Updated ${new Date(refreshedAt).toLocaleTimeString()}` : "Refresh"}
          </button>
        </div>

        {/* Demoted context strip — the plain totals (these are Home's job now). */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-5 text-[11px] text-slate-500">
          <Link href="/requests" className="inline-flex items-center gap-1.5 hover:text-slate-300">
            <MailPlus className="w-3 h-3" /> <span className="font-bold text-slate-300">{snap.openRequests}</span> open requests
          </Link>
          <Link href="/checkouts" className="inline-flex items-center gap-1.5 hover:text-slate-300">
            <Lock className="w-3 h-3" /> <span className="font-bold text-slate-300">{lockCount}</span> active locks
          </Link>
          <span className="text-slate-600 hidden sm:inline">Personal queues live on Home</span>
        </div>

        {setupNeeded && (
          <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
            <span className="font-black">Setup needed.</span> Some panels couldn&apos;t load because their database tables/columns don&apos;t exist yet. Apply the latest Supabase migrations (<code className="font-mono text-amber-100">20260719_plot_plans_and_whiteboard.sql</code> and friends) to enable equipment state and plot plans.
          </div>
        )}

        {isEmpty && !setupNeeded && (
          <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-base font-black text-white mb-2">What you&apos;re looking at</h2>
            <p className="text-sm text-slate-400 leading-relaxed mb-4">
              Coordination is the shared, org-wide board: it watches every active checkout and flags when two crews are working scope that overlaps (the same asset, unit, or system), alongside what&apos;s blocked and how equipment is tracking. It&apos;s quiet right now because there&apos;s no active work. To see it come alive:
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href="/admin/assets" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-bold hover:bg-slate-700">Register equipment</Link>
              <Link href="/plot-plans" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-bold hover:bg-slate-700">Create a plot plan</Link>
              <Link href="/documents" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-bold hover:bg-slate-700">Check out a document</Link>
            </div>
          </div>
        )}

        {/* ── HERO: scope collisions ─ the signal only this page produces. ── */}
        <CollisionHero overlaps={snap.overlaps} scannedLocks={lockCount} sessionById={sessionById} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
          {/* Equipment state distribution */}
          <Panel title="Equipment state" icon={Boxes} accent="text-cyan-400" span={2}>
            {totalEquip === 0 ? (
              <div className="text-xs text-slate-500">No equipment tracked yet — <Link href="/admin/assets" className="text-cyan-400 font-bold">register assets</Link> to see the turnaround distribution.</div>
            ) : (
              <>
                <div className="flex items-end gap-4 mb-3">
                  <div className="text-4xl font-black text-white">{totalEquip}</div>
                  <div className="text-xs text-slate-400 pb-1">tracked equipment items{blocked > 0 && <span className="ml-2 text-rose-400 font-bold">· {blocked} blocked</span>}</div>
                </div>
                <MiniBars
                  height={12}
                  segments={WHITEBOARD_STATES.map((s) => ({ value: snap.states[s], color: STATE_CONFIG[s].hex, label: STATE_CONFIG[s].label }))}
                />
                <div className="flex flex-wrap gap-3 mt-3">
                  {WHITEBOARD_STATES.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: STATE_CONFIG[s].hex }} />
                      {STATE_CONFIG[s].label} <span className="text-slate-200">{snap.states[s]}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </Panel>

          {/* Blockers (holds) — framed around health, not just a count. */}
          <Panel title="Blockers" icon={AlertOctagon} accent="text-rose-400" href="/admin/holds">
            <div className="flex items-end gap-3">
              <div className="text-4xl font-black text-white">{snap.holds.activeCount}</div>
              <div className="text-xs text-slate-400 pb-1">active hold{snap.holds.activeCount === 1 ? "" : "s"}</div>
            </div>
            <div className="mt-3 space-y-1.5 text-[11px]">
              {snap.holds.longestActiveDays > 0 && (
                <div className="flex items-center gap-1.5 text-slate-400"><Clock className="w-3 h-3 text-amber-400" /> Longest open <span className="text-slate-200 font-bold">{snap.holds.longestActiveDays}d</span></div>
              )}
              {snap.holds.avgClosedDurationDays > 0 && (
                <div className="flex items-center gap-1.5 text-slate-400"><ShieldCheck className="w-3 h-3 text-emerald-400" /> Avg resolution <span className="text-slate-200 font-bold">{snap.holds.avgClosedDurationDays}d</span></div>
              )}
              <div className="flex items-center gap-3 pt-1">
                <span className="inline-flex items-center gap-1 text-rose-300"><ArrowUpRight className="w-3 h-3" /> {snap.holds.openedLast7Days} opened/7d</span>
                <span className="inline-flex items-center gap-1 text-emerald-300"><ArrowDownRight className="w-3 h-3" /> {snap.holds.releasedLast7Days} cleared/7d</span>
              </div>
            </div>
            {snap.holds.activeByReason.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {snap.holds.activeByReason.slice(0, 4).map((r) => (
                  <span key={r.reason} className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-rose-500/10 text-rose-300 border border-rose-500/20">
                    {r.reason} <span className="text-rose-200">{r.count}</span>
                  </span>
                ))}
              </div>
            )}
            {snap.holds.activeCount === 0 && (
              <div className="mt-3 text-xs text-emerald-400 font-bold">Nothing blocked right now</div>
            )}
          </Panel>

          {/* Plot plans */}
          <Panel title="Spatial boards" icon={MapIcon} accent="text-cyan-400" span={3}>
            {snap.plotPlans.length === 0 ? (
              <div className="text-xs text-slate-400">No plot plans yet — <Link href="/plot-plans" className="text-cyan-400 font-bold">create one</Link> to navigate equipment spatially.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {snap.plotPlans.slice(0, 8).map((p) => (
                  <Link key={p.id} href={`/plot-plans/${p.id}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs font-bold text-slate-300 hover:border-cyan-500/50">
                    <MapIcon className="w-3.5 h-3.5 text-cyan-400" /> {p.name} <span className="text-slate-500">{p.markers.length}</span>
                  </Link>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

// ─── Collision hero ─────────────────────────────────────────────────────────
// The crown jewel: surfaces when two or more people hold DIFFERENT documents
// whose scope overlaps (same asset / unit / system), so duplicate or
// conflicting revisions get caught BEFORE they're finished.

function CollisionHero({
  overlaps, scannedLocks, sessionById,
}: {
  overlaps: ConsolidationOverlap[];
  scannedLocks: number;
  sessionById: Map<string, CheckoutSession>;
}) {
  if (overlaps.length === 0) {
    return (
      <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-slate-900 p-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <div className="text-base font-black text-white">No scope collisions</div>
            <div className="text-xs text-slate-400 mt-0.5">
              Scanned {scannedLocks} active checkout{scannedLocks === 1 ? "" : "s"} — no two crews are working overlapping asset, unit, or system scope right now.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-500/40 bg-gradient-to-br from-amber-500/10 to-slate-900 overflow-hidden">
      <div className="px-5 py-4 border-b border-amber-500/20 flex items-center gap-2">
        <Network className="w-5 h-5 text-amber-400" />
        <span className="text-base font-black text-white">Scope collisions</span>
        <span className="inline-flex items-center justify-center min-w-[22px] h-6 px-2 rounded-full bg-amber-500 text-slate-950 text-xs font-black">{overlaps.length}</span>
        <span className="ml-auto text-[11px] text-amber-200/80 hidden sm:inline">Coordinate before conflicting revisions land</span>
      </div>
      <div className="divide-y divide-amber-500/10">
        {overlaps.slice(0, 8).map((o, i) => {
          const people = Array.from(new Set(
            o.checkoutIds.map((id) => sessionById.get(id)?.userName).filter((n): n is string => !!n),
          ));
          const scope = o.kind === "asset"
            ? { tag: o.assetTag, kind: "Asset" }
            : { tag: o.scopeName, kind: o.level === "system" ? "System" : o.level === "unit" ? "Unit" : "Plant" };
          return (
            <Link
              key={i}
              href="/checkouts"
              className="flex items-center gap-3 px-5 py-3 hover:bg-amber-500/[0.06] transition-colors"
            >
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-white truncate">
                  <span className="text-[10px] font-black uppercase tracking-wider text-amber-300/80 mr-1.5">{scope.kind}</span>
                  {scope.tag}
                </div>
                <div className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                  <Users className="w-3 h-3" />
                  {people.length > 0 ? people.join(", ") : `${o.checkoutIds.length} people`}
                  <span className="text-slate-600">·</span>
                  {o.checkoutIds.length} checkouts on {o.documentIds.length} doc{o.documentIds.length === 1 ? "" : "s"}
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />
            </Link>
          );
        })}
      </div>
      {overlaps.length > 8 && (
        <div className="px-5 py-2 border-t border-amber-500/10">
          <Link href="/checkouts" className="text-xs font-bold text-amber-300 hover:text-amber-200">View all {overlaps.length} collisions →</Link>
        </div>
      )}
    </div>
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
    <div className={`rounded-2xl bg-slate-900 border border-slate-800 p-5 h-full ${href ? "hover:border-slate-700 transition-colors" : ""}`}>
      <div className="flex items-center gap-2 mb-3">
        <Icon className={`w-4 h-4 ${accent}`} />
        <span className="text-xs font-black uppercase tracking-wider text-slate-400">{title}</span>
        {href && <ChevronRight className="w-3.5 h-3.5 text-slate-600 ml-auto" />}
      </div>
      {children}
    </div>
  );
  return <div className={spanCls}>{href ? <Link href={href} className="block h-full">{body}</Link> : body}</div>;
}
