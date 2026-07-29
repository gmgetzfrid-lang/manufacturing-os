"use client";

// OPERATING AREAS — the plant, one unit at a time. Each card is a unit;
// clicking through lands on its 3D laser-scan model (the first thing you
// see), with the model register and full version history behind it.
// Units themselves are managed under Equipment; this page is the walk-in
// door for anyone who wants to SEE the plant.

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Factory, Boxes, Loader2, ChevronRight, ScanLine } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { listAreaUnits, AreaUnit } from "@/lib/unitModels";

export default function OperatingAreasPage() {
  const { activeOrgId } = useRole();
  const [units, setUnits] = useState<AreaUnit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    (async () => {
      try {
        const rows = await listAreaUnits(activeOrgId);
        if (alive) setUnits(rows);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [activeOrgId]);

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
      </div>

      {loading && <div className="py-16 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-accent)]" /></div>}

      {!loading && units.length === 0 && (
        <div className="mt-10 text-center">
          <Boxes className="w-10 h-10 mx-auto text-[var(--color-text-faint)] mb-2" />
          <div className="text-sm font-bold text-[var(--color-text)]">No units yet</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-1">
            Define your plants and units under <Link href="/admin/assets" className="underline font-bold">Equipment</Link> — they&apos;ll appear here ready for 3D models.
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
