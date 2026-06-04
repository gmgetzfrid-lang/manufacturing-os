"use client";

// /plot-plans — spatial navigation. List of plot plans / P&IDs / unit layouts.
// Each is a background image with asset markers heat-mapped by operational
// state. This turns the list-based DMS into a spatial operating picture: click
// equipment on the drawing to see and advance its state, or jump to the asset.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Map as MapIcon, Plus, Loader2, ImageIcon, X, Trash2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { listPlotPlans, createPlotPlan, deletePlotPlan } from "@/lib/plotPlans";
import { SignedPlotImage } from "@/components/plotPlans/SignedPlotImage";
import { EmptyState } from "@/components/ui/EmptyState";
import ViewTabs, { EQUIPMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { useToast } from "@/components/providers/ToastProvider";
import type { PlotPlan } from "@/types/schema";

export default function PlotPlansPage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const [plans, setPlans] = useState<PlotPlan[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { setPlans(await listPlotPlans(activeOrgId)); }
    catch (e) { showToast({ type: "error", title: "Couldn't load plot plans", message: (e as Error).message }); }
  }, [activeOrgId, showToast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onDelete = async (p: PlotPlan) => {
    if (!confirm(`Delete plot plan "${p.name}"? Markers are removed; assets are untouched.`)) return;
    try { await deletePlotPlan(p.id); await refresh(); }
    catch (e) { showToast({ type: "error", title: "Delete failed", message: (e as Error).message }); }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-6xl mx-auto">
        <ViewTabs title="Equipment" tabs={EQUIPMENT_VIEWS} />
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
              <MapIcon className="w-7 h-7 text-orange-500" /> Plot Plans
            </h1>
            <p className="text-sm text-slate-500 mt-1">Navigate documents and equipment spatially. Markers are colored by operational state.</p>
          </div>
          {isController && (
            <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-bold shadow-sm">
              <Plus className="w-4 h-4" /> New plot plan
            </button>
          )}
        </div>

        {!plans ? (
          <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : plans.length === 0 ? (
          <EmptyState
            icon={MapIcon}
            title="No plot plans yet"
            description="Upload a plot plan, P&ID, or unit layout, then drop markers on the equipment it shows. Each marker glows with that asset's live operational state."
            action={isController ? <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-bold"><Plus className="w-4 h-4" /> New plot plan</button> : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {plans.map((p) => (
              <div key={p.id} className="group relative bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
                <Link href={`/plot-plans/${p.id}`} className="block">
                  <div className="aspect-video bg-slate-100 flex items-center justify-center overflow-hidden">
                    {p.imagePath ? (
                      <SignedPlotImage path={p.imagePath} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <ImageIcon className="w-10 h-10 text-slate-300" />
                    )}
                  </div>
                  <div className="p-3">
                    <div className="font-bold text-slate-900 truncate">{p.name}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{p.markers.length} marker{p.markers.length === 1 ? "" : "s"}</div>
                  </div>
                </Link>
                {isController && (
                  <button onClick={() => onDelete(p)} title="Delete" className="absolute top-2 right-2 p-1.5 rounded-lg bg-white/90 text-slate-400 hover:text-red-600 shadow opacity-0 group-hover:opacity-100 transition">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && activeOrgId && uid && (
        <CreatePlotPlanModal
          orgId={activeOrgId}
          actorUserId={uid}
          actorName={userEmail ?? undefined}
          onClose={() => setShowCreate(false)}
          onCreated={async () => { setShowCreate(false); await refresh(); }}
        />
      )}
    </div>
  );
}

function CreatePlotPlanModal({
  orgId, actorUserId, actorName, onClose, onCreated,
}: {
  orgId: string;
  actorUserId: string;
  actorName?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const onPick = (f: File | null) => {
    setFile(f);
    if (f) {
      const img = new Image();
      img.onload = () => setDims({ w: img.naturalWidth, h: img.naturalHeight });
      img.src = URL.createObjectURL(f);
    } else setDims(null);
  };

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await createPlotPlan({
        orgId, name, image: file ?? undefined,
        imageWidth: dims?.w, imageHeight: dims?.h,
        actorUserId, actorName,
      });
      onCreated();
    } catch (e) {
      showToast({ type: "error", title: "Couldn't create", message: (e as Error).message });
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-black text-slate-900">New plot plan</h2>
          <button onClick={onClose} className="p-1.5 rounded-md text-slate-400 hover:bg-slate-100"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Unit 200 Plot Plan" className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-orange-500/30" />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Background image</label>
            <label className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 cursor-pointer hover:border-slate-400">
              <ImageIcon className="w-6 h-6 text-slate-400" />
              <span className="text-xs font-medium text-slate-600">{file ? file.name : "Plot plan, P&ID, or unit layout (PNG/JPG)"}</span>
              <input type="file" accept="image/*" className="sr-only" onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-200">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-bold text-slate-600 hover:bg-slate-100">Cancel</button>
          <button onClick={submit} disabled={!name.trim() || busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-bold disabled:opacity-50">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Create
          </button>
        </div>
      </div>
    </div>
  );
}
