"use client";

// /plot-plans/[id] — the spatial board. A background drawing with asset markers
// heat-mapped by operational state. View mode: tap a marker to see/advance its
// state or jump to the asset. Edit mode (controllers): place markers by picking
// an asset then clicking the drawing, drag to reposition, save.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft, Loader2, Save, Pencil, X, MapPin, Search, ExternalLink, ChevronRight,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { useRole } from "@/components/providers/RoleContext";
import { getPlotPlan, saveMarkers } from "@/lib/plotPlans";
import { listAssets, type Asset } from "@/lib/assets";
import { STATE_CONFIG, WHITEBOARD_STATES, nextState, setEquipmentState } from "@/lib/whiteboard";
import { SignedPlotImage } from "@/components/plotPlans/SignedPlotImage";
import { useToast } from "@/components/providers/ToastProvider";
import type { PlotPlan, PlotPlanMarker, WhiteboardState } from "@/types/schema";

export default function PlotPlanBoard() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const [plan, setPlan] = useState<PlotPlan | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [markers, setMarkers] = useState<PlotPlanMarker[]>([]);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [placingAssetId, setPlacingAssetId] = useState<string | null>(null);
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const imgWrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ assetId: string } | null>(null);

  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const load = useCallback(async () => {
    if (!activeOrgId || !id) return;
    setLoading(true);
    try {
      const [p, a] = await Promise.all([getPlotPlan(id), listAssets({ orgId: activeOrgId, archived: false })]);
      setPlan(p);
      setMarkers(p?.markers ?? []);
      setAssets(a);
    } catch (e) {
      showToast({ type: "error", title: "Couldn't load", message: (e as Error).message });
    } finally { setLoading(false); }
  }, [activeOrgId, id, showToast]);

  useEffect(() => { void load(); }, [load]);

  // Warn before leaving with unsaved marker edits.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const pctFromEvent = (clientX: number, clientY: number) => {
    const el = imgWrapRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * 100;
    const y = ((clientY - r.top) / r.height) * 100;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
  };

  const onBoardClick = (e: React.MouseEvent) => {
    if (!editing || !placingAssetId) return;
    const pt = pctFromEvent(e.clientX, e.clientY);
    if (!pt) return;
    setMarkers((prev) => {
      const without = prev.filter((m) => m.assetId !== placingAssetId);
      return [...without, { assetId: placingAssetId, xPct: pt.x, yPct: pt.y }];
    });
    setDirty(true);
    setPlacingAssetId(null);
  };

  // Drag an existing marker (pointer events → works on touch too).
  const onMarkerPointerDown = (e: React.PointerEvent, assetId: string) => {
    if (!editing) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { assetId };
  };
  const onBoardPointerMove = (e: React.PointerEvent) => {
    if (!editing || !dragRef.current) return;
    const pt = pctFromEvent(e.clientX, e.clientY);
    if (!pt) return;
    const { assetId } = dragRef.current;
    setMarkers((prev) => prev.map((m) => (m.assetId === assetId ? { ...m, xPct: pt.x, yPct: pt.y } : m)));
    setDirty(true);
  };
  const onBoardPointerUp = () => { dragRef.current = null; };

  const removeMarker = (assetId: string) => {
    setMarkers((prev) => prev.filter((m) => m.assetId !== assetId));
    setDirty(true);
    setSelectedMarker(null);
  };

  const save = async () => {
    if (!uid) return;
    setSaving(true);
    try {
      await saveMarkers({ id, markers, actorUserId: uid });
      setDirty(false);
      setEditing(false);
      showToast({ type: "success", title: "Saved", message: `${markers.length} marker${markers.length === 1 ? "" : "s"} placed.` });
    } catch (e) {
      showToast({ type: "error", title: "Save failed", message: (e as Error).message });
    } finally { setSaving(false); }
  };

  const advanceState = async (asset: Asset) => {
    if (!uid || !activeOrgId) return;
    const cur = (asset.whiteboard_state ?? "pending") as WhiteboardState;
    const next = nextState(cur);
    try {
      await setEquipmentState({ assetId: asset.id, orgId: activeOrgId, newState: next, previousState: cur, actorUserId: uid, actorEmail: userEmail ?? undefined, actorRole: activeRole ?? undefined });
      setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...a, whiteboard_state: next } : a)));
    } catch (e) {
      showToast({ type: "error", title: "Couldn't update state", message: (e as Error).message });
    }
  };

  const setBlocked = async (asset: Asset) => {
    if (!uid || !activeOrgId) return;
    try {
      await setEquipmentState({ assetId: asset.id, orgId: activeOrgId, newState: "blocked", previousState: (asset.whiteboard_state ?? "pending") as WhiteboardState, actorUserId: uid, actorEmail: userEmail ?? undefined, actorRole: activeRole ?? undefined });
      setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...a, whiteboard_state: "blocked" } : a)));
    } catch (e) { showToast({ type: "error", title: "Couldn't update state", message: (e as Error).message }); }
  };

  // Live state counts across markers.
  const counts = useMemo(() => {
    const c: Record<WhiteboardState, number> = { pending: 0, drafting: 0, executing: 0, completed: 0, blocked: 0 };
    for (const m of markers) {
      const a = assetById.get(m.assetId);
      const s = (a?.whiteboard_state ?? "pending") as WhiteboardState;
      c[s]++;
    }
    return c;
  }, [markers, assetById]);

  const placedIds = useMemo(() => new Set(markers.map((m) => m.assetId)), [markers]);
  const pickerAssets = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    return assets
      .filter((a) => !placedIds.has(a.id))
      .filter((a) => !q || a.tag.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q))
      .slice(0, 50);
  }, [assets, placedIds, pickerSearch]);

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>;
  if (!plan) return <div className="min-h-screen flex items-center justify-center text-[var(--color-text-muted)]">Plot plan not found.</div>;

  const selAsset = selectedMarker ? assetById.get(selectedMarker) : null;
  const selMarker = selectedMarker ? markers.find((m) => m.assetId === selectedMarker) : null;

  return (
    <div className="min-h-screen flex flex-col">
      <div className="px-5 py-3 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center gap-3 flex-wrap">
        <Link href="/plot-plans" className="p-2 rounded-full hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors"><ArrowLeft className="w-5 h-5" /></Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-black text-[var(--color-text)] truncate">{plan.name}</h1>
          <p className="text-xs text-[var(--color-text-muted)]">{markers.length} marker{markers.length === 1 ? "" : "s"}{dirty ? " · unsaved changes" : ""}</p>
        </div>
        {/* Legend */}
        <div className="flex items-center gap-2 flex-wrap">
          {WHITEBOARD_STATES.map((s) => (
            <span key={s} className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: STATE_CONFIG[s].hex }} />
              {STATE_CONFIG[s].label} <span className="text-slate-400">{counts[s]}</span>
            </span>
          ))}
        </div>
        {isController && (
          editing ? (
            <div className="flex items-center gap-2">
              <button onClick={() => { setMarkers(plan.markers); setDirty(false); setEditing(false); setPlacingAssetId(null); }} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold text-slate-600 hover:bg-slate-100"><X className="w-4 h-4" /> Cancel</button>
              <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-50">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save</button>
            </div>
          ) : (
            <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm font-bold"><Pencil className="w-4 h-4" /> Edit markers</button>
          )
        )}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Edit-mode asset picker rail */}
        {editing && (
          <div className="w-64 shrink-0 bg-white border-r border-slate-200 flex flex-col">
            <div className="p-3 border-b border-slate-200">
              <div className="text-xs font-black uppercase tracking-wider text-slate-500 mb-2">Place an asset</div>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} placeholder="Search equipment…" className="w-full h-8 pl-8 pr-2 rounded-lg border border-slate-200 text-xs outline-none focus:ring-2 focus:ring-orange-500/30" />
              </div>
              {placingAssetId && <div className="mt-2 text-[11px] font-bold text-orange-700 bg-orange-50 rounded px-2 py-1">Now click the drawing to place {assetById.get(placingAssetId)?.tag}.</div>}
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {pickerAssets.length === 0 ? (
                <div className="text-center text-[11px] text-slate-400 italic py-6">{placedIds.size > 0 ? "All matching assets are placed." : "No equipment found."}</div>
              ) : pickerAssets.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setPlacingAssetId(a.id)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2 transition ${placingAssetId === a.id ? "bg-orange-100 text-orange-900" : "hover:bg-slate-100 text-slate-700"}`}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: STATE_CONFIG[(a.whiteboard_state ?? "pending") as WhiteboardState].hex }} />
                  <span className="font-mono font-bold truncate">{a.tag}</span>
                  <MapPin className="w-3 h-3 ml-auto text-slate-300" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* The board */}
        <div className="flex-1 overflow-auto p-6 flex items-start justify-center">
          <div
            ref={imgWrapRef}
            onClick={onBoardClick}
            onPointerMove={onBoardPointerMove}
            onPointerUp={onBoardPointerUp}
            className={`relative inline-block max-w-full rounded-xl overflow-hidden shadow-lg bg-white ${editing && placingAssetId ? "cursor-crosshair" : ""}`}
            style={{ touchAction: editing ? "none" : "auto" }}
          >
            {plan.imagePath ? (
              <SignedPlotImage path={plan.imagePath} alt={plan.name} className="block max-w-full h-auto select-none" />
            ) : (
              <div className="w-[640px] max-w-full aspect-video bg-slate-100 flex items-center justify-center text-slate-400 text-sm">No background image — markers can still be placed on this blank canvas.</div>
            )}

            {markers.map((m) => {
              const a = assetById.get(m.assetId);
              const state = (a?.whiteboard_state ?? "pending") as WhiteboardState;
              const hex = STATE_CONFIG[state].hex;
              return (
                <button
                  key={m.assetId}
                  onPointerDown={(e) => onMarkerPointerDown(e, m.assetId)}
                  onClick={(e) => { e.stopPropagation(); setSelectedMarker((s) => (s === m.assetId ? null : m.assetId)); }}
                  title={a?.tag ?? "Unknown asset"}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md flex items-center justify-center ${editing ? "cursor-move" : "cursor-pointer hover:scale-110"} transition-transform`}
                  style={{ left: `${m.xPct}%`, top: `${m.yPct}%`, width: 22, height: 22, backgroundColor: hex }}
                >
                  {state === "blocked" && <span className="text-white text-[11px] font-black leading-none">!</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected marker popover (view mode) */}
        {!editing && selAsset && selMarker && (
          <div className="w-72 shrink-0 bg-white border-l border-slate-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="font-mono text-sm font-black text-slate-900">{selAsset.tag}</div>
              <button onClick={() => setSelectedMarker(null)} className="p-1 rounded text-slate-400 hover:bg-slate-100"><X className="w-4 h-4" /></button>
            </div>
            {selAsset.description && <p className="text-xs text-slate-500 mb-3">{selAsset.description}</p>}
            <div className="mb-3">
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${STATE_CONFIG[(selAsset.whiteboard_state ?? "pending") as WhiteboardState].chip}`}>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STATE_CONFIG[(selAsset.whiteboard_state ?? "pending") as WhiteboardState].hex }} />
                {STATE_CONFIG[(selAsset.whiteboard_state ?? "pending") as WhiteboardState].label}
              </span>
            </div>
            <div className="space-y-2">
              <button onClick={() => advanceState(selAsset)} className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-bold hover:bg-[var(--color-accent-hover)]">
                Advance to {STATE_CONFIG[nextState((selAsset.whiteboard_state ?? "pending") as WhiteboardState)].label} <ChevronRight className="w-4 h-4" />
              </button>
              {selAsset.whiteboard_state !== "blocked" && (
                <button onClick={() => setBlocked(selAsset)} className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-rose-200 text-rose-700 text-sm font-bold hover:bg-rose-50">
                  Mark blocked
                </button>
              )}
              <Link href={`/assets/${encodeURIComponent(selAsset.tag)}`} className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50">
                Open asset <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        )}

        {/* Selected marker actions (edit mode → remove) */}
        {editing && selectedMarker && (
          <div className="w-60 shrink-0 bg-white border-l border-slate-200 p-4">
            <div className="text-sm font-bold text-slate-900 mb-2">{assetById.get(selectedMarker)?.tag}</div>
            <button onClick={() => removeMarker(selectedMarker)} className="w-full px-3 py-2 rounded-lg border border-rose-200 text-rose-700 text-sm font-bold hover:bg-rose-50">Remove marker</button>
          </div>
        )}
      </div>
    </div>
  );
}
