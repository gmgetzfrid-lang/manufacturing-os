"use client";

// OPERATING AREAS — the plant, one unit at a time. Each card is a unit;
// clicking through lands on its 3D laser-scan model (the first thing you
// see), with the model register and full version history behind it.
// Units themselves are managed under Equipment; this page is the walk-in
// door for anyone who wants to SEE the plant.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Factory, Boxes, Loader2, ChevronRight, ScanLine, Plus, X, Check } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { listAreaUnits, listPlants, createAreaUnit, AreaUnit } from "@/lib/unitModels";

export default function OperatingAreasPage() {
  const { activeOrgId, uid, userEmail, hasAnyRole } = useRole();
  const canManage = hasAnyRole(["Admin", "DocCtrl"]);
  const router = useRouter();
  const [units, setUnits] = useState<AreaUnit[]>([]);
  const [plants, setPlants] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  // Add-unit form (controllers)
  const [showAdd, setShowAdd] = useState(false);
  const [fPlant, setFPlant] = useState("");
  const [fNewPlant, setFNewPlant] = useState("");
  const [fName, setFName] = useState("");
  const [fCode, setFCode] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    try {
      const [rows, ps] = await Promise.all([listAreaUnits(activeOrgId), listPlants(activeOrgId)]);
      setUnits(rows);
      setPlants(ps);
    } finally { setLoading(false); }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const submitAddUnit = async () => {
    if (!activeOrgId || !uid) return;
    if (!fName.trim()) { setMsg("Give the unit a name (e.g. Sulfur Recovery Unit)."); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await createAreaUnit({
        orgId: activeOrgId,
        plantId: fPlant || null,
        newPlantName: fPlant ? null : (fNewPlant.trim() || (plants.length === 0 ? "Refinery" : null)),
        name: fName, code: fCode || null, description: fDesc || null,
        actor: { uid, email: userEmail ?? null },
      });
      if (!res.ok) throw new Error(res.error);
      setShowAdd(false);
      setFPlant(""); setFNewPlant(""); setFName(""); setFCode(""); setFDesc("");
      if (res.unitId) router.push(`/areas/${res.unitId}`);
      else await refresh();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  const byPlant = useMemo(() => {
    const m = new Map<string, { plantName: string; units: AreaUnit[] }>();
    for (const u of units) {
      const g = m.get(u.plantId) ?? { plantName: u.plantName, units: [] };
      g.units.push(u);
      m.set(u.plantId, g);
    }
    return [...m.values()].sort((a, b) => a.plantName.localeCompare(b.plantName));
  }, [units]);

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <div className="flex items-center gap-3 mb-1">
        <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-600 border border-cyan-500/20">
          <Factory className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-black text-[var(--color-text)]">Operating Areas</h1>
          <p className="text-xs text-[var(--color-text-muted)]">Walk the plant unit by unit — 3D laser-scan models, kept current under document control.</p>
        </div>
        {canManage && (
          <button
            onClick={() => { setShowAdd((s) => !s); setMsg(null); }}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)]"
          >
            <Plus className="w-3.5 h-3.5" /> Add unit
          </button>
        )}
      </div>

      {msg && <div className="mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-bold text-[var(--color-text)]">{msg}</div>}

      {showAdd && canManage && (
        <div className="mt-3 rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-black text-[var(--color-text)]">New operating unit</span>
            <button onClick={() => setShowAdd(false)} className="ml-auto p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Unit name (e.g. Sulfur Recovery Unit)" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
            <input value={fCode} onChange={(e) => setFCode(e.target.value)} placeholder="Unit code (e.g. SRU / U-400) — optional" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
            {plants.length > 0 && (
              <select value={fPlant} onChange={(e) => setFPlant(e.target.value)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs">
                <option value="">Plant: pick existing…</option>
                {plants.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            {!fPlant && (
              <input value={fNewPlant} onChange={(e) => setFNewPlant(e.target.value)}
                placeholder={plants.length === 0 ? "Plant name (e.g. Refinery)" : "…or name a new plant"}
                className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
            )}
            <input value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder="Description — optional" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs sm:col-span-2" />
          </div>
          <div className="text-[10px] text-[var(--color-text-faint)]">Units are one shared registry — anything you add here also shows under Equipment, and vice versa.</div>
          <button onClick={() => void submitAddUnit()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Create unit
          </button>
        </div>
      )}

      {loading && <div className="py-16 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-accent)]" /></div>}

      {!loading && units.length === 0 && !showAdd && (
        <div className="mt-10 text-center">
          <Boxes className="w-10 h-10 mx-auto text-[var(--color-text-faint)] mb-2" />
          <div className="text-sm font-bold text-[var(--color-text)]">No operating units yet</div>
          {canManage ? (
            <div className="text-xs text-[var(--color-text-muted)] mt-1">
              Hit <b>Add unit</b> above to create your first one (e.g. Sulfur Recovery Unit) — then load its 3D scans.
            </div>
          ) : (
            <div className="text-xs text-[var(--color-text-muted)] mt-1">
              Document Control can add units and their 3D models here.
            </div>
          )}
          <div className="text-[10px] text-[var(--color-text-faint)] mt-2">
            Units are the same registry the <Link href="/admin/assets" className="underline">Equipment</Link> section uses — one source of truth.
          </div>
        </div>
      )}

      {byPlant.map((g) => (
        <div key={g.plantName} className="mt-6">
          <div className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-2">{g.plantName}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {g.units.map((u) => (
              <Link
                key={u.id}
                href={`/areas/${u.id}`}
                className="group rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:border-[var(--color-accent-ring)] hover:shadow-md transition-all"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base font-black text-[var(--color-text)]">{u.name}</span>
                  {u.code && <span className="text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] rounded px-1.5 py-0.5">{u.code}</span>}
                  <ChevronRight className="w-4 h-4 ml-auto text-[var(--color-text-faint)] group-hover:text-[var(--color-accent)] transition-colors" />
                </div>
                {u.description && <div className="mt-1 text-xs text-[var(--color-text-muted)] line-clamp-2">{u.description}</div>}
                <div className="mt-2.5 flex items-center gap-2 text-[11px] font-bold">
                  {u.modelCount > 0 ? (
                    <span className="inline-flex items-center gap-1 text-cyan-700 dark:text-cyan-300">
                      <ScanLine className="w-3.5 h-3.5" />
                      {u.modelCount} 3D model{u.modelCount === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <span className="text-[var(--color-text-faint)]">No 3D model yet</span>
                  )}
                  {u.latestCapturedAt && (
                    <span className="text-[var(--color-text-faint)]">· scanned {new Date(u.latestCapturedAt).toLocaleDateString()}</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
