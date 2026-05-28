"use client";

// /whiteboard — the Phase 8 turnaround whiteboard.
//
// Five columns, one per state. Equipment tiles auto-sort into the
// column for their current state. Click a tile to advance; right-
// click or ⋮ for the state menu. Scope chips at the top filter to
// plant / unit / system. State counts in the header.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle, Search, LayoutGrid, X } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  listEquipmentForWhiteboard, setEquipmentState, nextState,
  ALL_STATES, STATE_LABEL, STATE_TONE,
  type EquipmentState,
} from "@/lib/whiteboard";
import { getScopeTree, type ScopeNode } from "@/lib/operationalGraph";
import { translatePostgresError } from "@/lib/inputValidation";
import EquipmentTile from "@/components/whiteboard/EquipmentTile";
import StateMenu from "@/components/whiteboard/StateMenu";
import FirstRunHint from "@/components/ui/FirstRunHint";
import type { Asset } from "@/lib/assets";

const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl", "Drafter"]);

const TONE_COLUMN_BG: Record<string, string> = {
  slate:   "bg-slate-50/60 border-slate-200",
  blue:    "bg-blue-50/40 border-blue-200",
  amber:   "bg-amber-50/40 border-amber-200",
  emerald: "bg-emerald-50/40 border-emerald-200",
  red:     "bg-red-50/40 border-red-200",
};
const TONE_HEADER_TEXT: Record<string, string> = {
  slate:   "text-slate-700",
  blue:    "text-blue-700",
  amber:   "text-amber-700",
  emerald: "text-emerald-700",
  red:     "text-red-700",
};

export default function WhiteboardPage() {
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const canEdit = !!activeRole && ADMIN_ROLES.has(activeRole);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scopeTree, setScopeTree] = useState<ScopeNode[]>([]);

  const [plantId, setPlantId] = useState<string>("");
  const [unitId, setUnitId]   = useState<string>("");
  const [systemId, setSystemId] = useState<string>("");
  const [search, setSearch] = useState("");

  const [menu, setMenu] = useState<{ asset: Asset; anchor: { x: number; y: number } } | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const [list, tree] = await Promise.all([
        listEquipmentForWhiteboard({
          orgId: activeOrgId,
          plantId: plantId || undefined,
          unitId: unitId || undefined,
          systemId: systemId || undefined,
        }),
        getScopeTree(activeOrgId),
      ]);
      setAssets(list);
      setScopeTree(tree);
    } catch (e) {
      const f = translatePostgresError(e, { entity: "whiteboard" });
      setError(`${f.heading} — ${f.message}`);
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, plantId, unitId, systemId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Filter dropdowns: cascading. Picking a plant resets unit/system.
  const units = useMemo(() => {
    if (!plantId) return [] as { unit: { id?: string; name: string } }[];
    const p = scopeTree.find((n) => n.plant.id === plantId);
    return p?.units ?? [];
  }, [scopeTree, plantId]);
  const systems = useMemo(() => {
    if (!plantId || !unitId) return [] as Array<{ id?: string; name: string }>;
    const p = scopeTree.find((n) => n.plant.id === plantId);
    const u = p?.units.find((x) => x.unit.id === unitId);
    return u?.systems ?? [];
  }, [scopeTree, plantId, unitId]);

  // Apply free-text search client-side over the loaded set.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((a) =>
      a.tag.toLowerCase().includes(q) ||
      (a.description?.toLowerCase().includes(q) ?? false) ||
      (a.location?.toLowerCase().includes(q) ?? false));
  }, [assets, search]);

  // Group by state for column rendering.
  const byState = useMemo(() => {
    const groups: Record<EquipmentState, Asset[]> = {
      pending: [], drafting: [], executing: [], completed: [], blocked: [],
    };
    for (const a of filtered) groups[a.whiteboard_state as EquipmentState].push(a);
    return groups;
  }, [filtered]);

  // Optimistic state change: mutate local first, then sync. Revert on error.
  const onChangeState = async (asset: Asset, target: EquipmentState) => {
    if (!canEdit || !uid) return;
    const previous = asset.whiteboard_state as EquipmentState;
    if (previous === target) return;

    // Optimistic local update
    setAssets((arr) => arr.map((a) => (a.id === asset.id ? { ...a, whiteboard_state: target } : a)));
    try {
      await setEquipmentState({
        asset, newState: target,
        actorUserId: uid, actorEmail: userEmail ?? undefined, actorRole: activeRole ?? undefined,
      });
    } catch (e) {
      // Revert
      setAssets((arr) => arr.map((a) => (a.id === asset.id ? { ...a, whiteboard_state: previous } : a)));
      const f = translatePostgresError(e, { entity: "equipment state" });
      setError(`${f.heading} — ${f.message}`);
    }
  };

  const onAdvance = (asset: Asset) => {
    const target = nextState(asset.whiteboard_state as EquipmentState);
    void onChangeState(asset, target);
  };
  const onPickState = (asset: Asset, anchor: { x: number; y: number }) => {
    setMenu({ asset, anchor });
  };

  if (!activeOrgId) return <div className="p-6 text-sm text-slate-500">No active organization.</div>;

  return (
    <div className="min-h-screen bg-slate-100 p-4 pb-12">
      <div className="max-w-[1600px] mx-auto space-y-3">
        {/* Header */}
        <div className="bg-white rounded-2xl border border-slate-200 px-4 py-3 shadow-sm">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-xl font-black text-slate-900 flex items-center gap-2">
                <LayoutGrid className="w-5 h-5 text-blue-600" /> Turnaround Whiteboard
              </h1>
              <div className="text-xs text-slate-500 mt-0.5">
                {filtered.length} equipment item{filtered.length === 1 ? "" : "s"} in view
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Scope cascading filters */}
              <select
                value={plantId}
                onChange={(e) => { setPlantId(e.target.value); setUnitId(""); setSystemId(""); }}
                className="text-xs border border-slate-300 rounded px-2 py-1.5 bg-white"
              >
                <option value="">All plants</option>
                {scopeTree.map((n) => (
                  <option key={n.plant.id} value={n.plant.id}>{n.plant.name}</option>
                ))}
              </select>
              <select
                value={unitId}
                onChange={(e) => { setUnitId(e.target.value); setSystemId(""); }}
                disabled={!plantId}
                className="text-xs border border-slate-300 rounded px-2 py-1.5 bg-white disabled:opacity-40"
              >
                <option value="">All units</option>
                {units.map((u) => (
                  <option key={u.unit.id} value={u.unit.id}>{u.unit.name}</option>
                ))}
              </select>
              <select
                value={systemId}
                onChange={(e) => setSystemId(e.target.value)}
                disabled={!unitId}
                className="text-xs border border-slate-300 rounded px-2 py-1.5 bg-white disabled:opacity-40"
              >
                <option value="">All systems</option>
                {systems.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter…"
                  className="text-xs pl-7 pr-2 py-1.5 border border-slate-300 rounded bg-white w-44 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                {search && (
                  <button onClick={() => setSearch("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <FirstRunHint storageKey="whiteboard.intro" tone="info">
          One column per state. <b>Click a tile</b> to advance it to the next state. <b>Right-click</b> or <b>Shift-click</b> for the full state menu (including Blocked). Changes audit-log instantly.
        </FirstRunHint>

        {error && (
          <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-12 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading equipment…
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
            {ALL_STATES.map((state) => {
              const list = byState[state];
              const tone = STATE_TONE[state];
              return (
                <div
                  key={state}
                  className={`border rounded-2xl ${TONE_COLUMN_BG[tone]} flex flex-col min-h-[200px]`}
                >
                  <div className="px-3 py-2 border-b border-current/10 flex items-center justify-between">
                    <div className={`text-xs font-black uppercase tracking-widest ${TONE_HEADER_TEXT[tone]}`}>
                      {STATE_LABEL[state]}
                    </div>
                    <div className={`text-[11px] font-mono font-bold ${TONE_HEADER_TEXT[tone]}`}>{list.length}</div>
                  </div>
                  <div className="p-2 space-y-2 flex-1">
                    {list.length === 0 ? (
                      <div className="text-[11px] text-slate-400 text-center py-6 italic">empty</div>
                    ) : (
                      list.map((a) => (
                        <EquipmentTile
                          key={a.id}
                          asset={a}
                          onAdvance={onAdvance}
                          onPickState={onPickState}
                        />
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menu && (
        <StateMenu
          anchor={menu.anchor}
          current={menu.asset.whiteboard_state as EquipmentState}
          onPick={(s) => { void onChangeState(menu.asset, s); setMenu(null); }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
