"use client";

// /war-room — the turnaround command center. A single dark-themed ops console
// that aggregates the org-wide operational picture for execution windows:
// equipment state distribution, active checkouts + coordination collisions,
// open holds (and their impact), drafting work needing action, and quick
// access to spatial plot plans. Auto-refreshes so it can live on a wall display
// during a turnaround. Read-only intelligence — every number deep-links to the
// surface where you act on it.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Radio, Loader2, RefreshCw, Lock, AlertOctagon, Network, MailPlus, Map as MapIcon, ChevronRight,
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
import type { WhiteboardState, PlotPlan } from "@/types/schema";

interface Snapshot {
  states: Record<WhiteboardState, number>;
  checkouts: number;
  overlaps: ConsolidationOverlap[];
  holds: HoldMetrics;
  openRequests: number;
  plotPlans: PlotPlan[];
}

export default function WarRoomPage() {
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
    const checkouts = await listAllActiveCheckouts(activeOrgId).catch(() => []);
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

    setSnap({ states, holds, checkouts: checkouts.length, overlaps, openRequests: reqCount, plotPlans });
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

  if (loading && !snap) {
    return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-orange-500" /></div>;
  }
  if (!snap) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-center p-6">
        <Radio className="w-10 h-10 text-orange-500 mb-3" />
        <h1 className="text-lg font-black text-white">War Room</h1>
        <p className="text-sm text-slate-400 mt-2 max-w-sm">Couldn&apos;t load the operational picture. Try refresh — if this persists, the database migrations may not be applied yet.</p>
        <button onClick={() => void load()} className="mt-4 px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-bold">Refresh</button>
      </div>
    );
  }

  const totalEquip = WHITEBOARD_STATES.reduce((s, k) => s + snap.states[k], 0);
  const blocked = snap.states.blocked;
  // Nothing to show yet: no equipment, locks, holds, requests, or plans.
  const isEmpty = totalEquip === 0 && snap.checkouts === 0 && snap.holds.activeCount === 0 && snap.openRequests === 0 && snap.plotPlans.length === 0;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-6">
      <div className="max-w-7xl mx-auto">
        <ViewTabs title="Home" tabs={HOME_VIEWS} variant="dark" />
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-black text-white flex items-center gap-3">
              <Radio className="w-7 h-7 text-orange-500" /> War Room
            </h1>
            <p className="text-sm text-slate-400 mt-1">Live turnaround command center · org-wide operational picture</p>
          </div>
          <button onClick={() => void load()} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs font-bold text-slate-300 hover:bg-slate-800">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            {refreshedAt ? `Updated ${new Date(refreshedAt).toLocaleTimeString()}` : "Refresh"}
          </button>
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
              The War Room is a single live overview of your whole operation — equipment status, document locks, blockers, and the drafting queue, all on one auto-refreshing screen. It&apos;s blank right now because there&apos;s nothing happening yet. As you start using the app, these panels fill in. To see it come alive:
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href="/admin/assets" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-bold hover:bg-slate-700">Register equipment</Link>
              <Link href="/plot-plans" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-bold hover:bg-slate-700">Create a plot plan</Link>
              <Link href="/requests" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-bold hover:bg-slate-700">Open the request portal</Link>
              <Link href="/documents" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-bold hover:bg-slate-700">Check out a document</Link>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Equipment state distribution */}
          <Panel title="Equipment state" icon={Radio} accent="text-cyan-400" span={2}>
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
          </Panel>

          {/* Active checkouts + collisions */}
          <Panel title="Active locks" icon={Lock} accent="text-blue-400" href="/checkouts">
            <div className="text-4xl font-black text-white">{snap.checkouts}</div>
            <div className="text-xs text-slate-400 mt-1">documents checked out</div>
            {snap.overlaps.length > 0 ? (
              <div className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-amber-400 bg-amber-500/10 rounded-lg px-2.5 py-1.5">
                <Network className="w-3.5 h-3.5" /> {snap.overlaps.length} coordination collision{snap.overlaps.length === 1 ? "" : "s"}
              </div>
            ) : (
              <div className="mt-3 text-xs text-emerald-400 font-bold">No overlapping work detected</div>
            )}
          </Panel>

          {/* Holds */}
          <Panel title="Open holds" icon={AlertOctagon} accent="text-rose-400" href="/admin/holds">
            <div className="text-4xl font-black text-white">{snap.holds.activeCount}</div>
            <div className="text-xs text-slate-400 mt-1">active blockers</div>
            <div className="mt-3 space-y-1 text-[11px] text-slate-400">
              {snap.holds.longestActiveDays > 0 && <div>Longest open: <span className="text-slate-200 font-bold">{snap.holds.longestActiveDays}d</span></div>}
              {snap.holds.avgClosedDurationDays > 0 && <div>Avg resolution: <span className="text-slate-200 font-bold">{snap.holds.avgClosedDurationDays}d</span></div>}
            </div>
          </Panel>

          {/* Drafting work */}
          <Panel title="Drafting queue" icon={MailPlus} accent="text-orange-400" href="/requests">
            <div className="text-4xl font-black text-white">{snap.openRequests}</div>
            <div className="text-xs text-slate-400 mt-1">open drafting requests</div>
          </Panel>

          {/* Coordination collisions detail */}
          {snap.overlaps.length > 0 && (
            <Panel title="Coordination collisions" icon={Network} accent="text-amber-400" span={3} href="/checkouts">
              <div className="space-y-1.5">
                {snap.overlaps.slice(0, 6).map((o, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                    <span className="text-slate-300">
                      {o.kind === "asset" ? <>Asset <span className="font-mono font-bold text-white">{o.assetTag}</span></> : <>{o.level === "system" ? "System" : "Unit"} <span className="font-bold text-white">{o.scopeName}</span></>}
                    </span>
                    <span className="text-slate-500">— {o.checkoutIds.length} concurrent checkouts</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* Plot plans */}
          <Panel title="Spatial boards" icon={MapIcon} accent="text-cyan-400" span={3} href="/plot-plans">
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
