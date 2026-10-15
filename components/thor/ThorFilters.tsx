"use client";

// components/thor/ThorFilters.tsx — quick filters and the advanced panel for
// THOR results. Quick: file type, document kind, modified, size, order.
// Advanced (like Windows' advanced search): name contains, extensions, unit,
// folder, equipment number, folder role, exact date and size ranges, and
// whether to include files the indexer set aside (empty, OS junk).

import React, { useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { THOR_KINDS, THOR_TYPES, SORT_LABEL, unitName, type ThorSort } from "@/lib/thor/query";
import { EMPTY_FILTERS, filtersActive, type ThorFilters as Filters, type ThorOverview } from "@/lib/thor/client";

const MB = 1024 * 1024;
const SIZE_PRESETS: Array<{ key: string; label: string; min?: number; max?: number }> = [
  { key: "any", label: "Any size" },
  { key: "tiny", label: "Under 1 MB", max: MB },
  { key: "small", label: "1–10 MB", min: MB, max: 10 * MB },
  { key: "medium", label: "10–100 MB", min: 10 * MB, max: 100 * MB },
  { key: "large", label: "Over 100 MB", min: 100 * MB },
];
const DATE_PRESETS: Array<{ key: string; label: string; months?: number }> = [
  { key: "any", label: "Any date" },
  { key: "m1", label: "Past month", months: 1 },
  { key: "y1", label: "Past year", months: 12 },
  { key: "y5", label: "Past 5 years", months: 60 },
  { key: "custom", label: "Between dates…" },
];
const ROLES: Array<[string, string]> = [
  ["inspection", "Inspection"], ["drawings", "Drawings"], ["p_and_id", "P&ID"], ["datasheets", "Datasheets"],
  ["calculations", "Calculations"], ["code_documents", "Code documents"], ["archive", "Archive"],
  ["equipment_folder", "Equipment folder"], ["equipment_category", "Equipment category"],
];

const chip = (on: boolean) =>
  `rounded-full border px-2 py-0.5 text-[11px] font-semibold ${on ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-transparent" : "border-[var(--color-border)] bg-[var(--color-canvas)] hover:bg-[var(--color-surface)]"}`;
const input = "w-full text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1";
const label = "text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]";

const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
const monthsAgo = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 10); };
const list = (s: string) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

export default function ThorFilters({ filters, onChange, overview }: {
  filters: Filters; onChange: (f: Filters) => void; overview: ThorOverview | null;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [datePreset, setDatePreset] = useState("any");
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const sizeKey = SIZE_PRESETS.find((p) => p.min === filters.minSize && p.max === filters.maxSize)?.key ?? (filters.minSize != null || filters.maxSize != null ? "custom" : "any");
  const n = filtersActive(filters);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <div className={label}>Filter THOR</div>
        {(n > 0 || filters.sort) && (
          <button onClick={() => { onChange(EMPTY_FILTERS); setDatePreset("any"); }} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:underline inline-flex items-center gap-1">
            <RotateCcw className="w-3 h-3" /> Clear{n ? ` (${n})` : ""}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        {THOR_TYPES.map((t) => (
          <button key={t.key} onClick={() => set({ types: toggle(filters.types, t.key) })} className={chip(filters.types.includes(t.key))}
            title={`.${t.exts.join(", .")}${overview ? ` — ${t.exts.reduce((s, e) => s + (overview.exts[e] ?? 0), 0).toLocaleString()} on THOR` : ""}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {THOR_KINDS.map((k) => (
          <button key={k.key} onClick={() => set({ kinds: toggle(filters.kinds, k.key) })} className={chip(filters.kinds.includes(k.key))}
            title={k.exts ? `.${k.exts.join(", .")} files, or anything in a folder the indexer marked ${k.roles?.join(" / ")}` : `In a folder the indexer marked ${k.roles?.join(" / ")}`}>
            {k.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <select value={datePreset} onChange={(e) => {
          const p = DATE_PRESETS.find((x) => x.key === e.target.value)!;
          setDatePreset(p.key);
          if (p.key === "any") set({ after: undefined, before: undefined });
          else if (p.months) set({ after: monthsAgo(p.months), before: undefined });
          else setAdvanced(true);
        }} className={input} title="Filesystem modified date — when the file was last saved, not the engineering event date">
          {DATE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <select value={sizeKey} onChange={(e) => {
          const p = SIZE_PRESETS.find((x) => x.key === e.target.value);
          if (p) set({ minSize: p.min, maxSize: p.max });
        }} className={input}>
          {SIZE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          {sizeKey === "custom" && <option value="custom">Custom size</option>}
        </select>
        <select value={filters.sort ?? ""} onChange={(e) => set({ sort: (e.target.value || undefined) as ThorSort | undefined })} className={`${input} col-span-2`}>
          <option value="">Order: as the search says</option>
          {(Object.keys(SORT_LABEL) as ThorSort[]).map((s) => <option key={s} value={s}>Order: {SORT_LABEL[s]}</option>)}
        </select>
      </div>

      {filters.folder && (
        <div className="flex items-center gap-1 rounded-md border border-teal-200 bg-teal-50 px-2 py-1 text-[11px] text-teal-900">
          <span className="font-bold shrink-0">In</span> <span className="truncate flex-1" title={filters.folder}>{filters.folder}</span>
          <button onClick={() => set({ folder: undefined })}><X className="w-3 h-3" /></button>
        </div>
      )}

      <button onClick={() => setAdvanced((v) => !v)} className="text-[11px] font-bold inline-flex items-center gap-1 text-[var(--color-text)]">
        {advanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} <SlidersHorizontal className="w-3.5 h-3.5" /> Advanced
      </button>

      {advanced && (
        <div className="space-y-2 rounded-lg border border-[var(--color-border)] p-2">
          <Field label="Name contains">
            <input value={filters.nameContains ?? ""} onChange={(e) => set({ nameContains: e.target.value || undefined })} placeholder="scan data" className={input} />
          </Field>
          <Field label="Extensions">
            <input key={`x:${filters.exts.join(",")}`} defaultValue={filters.exts.join(", ")} onBlur={(e) => set({ exts: list(e.target.value).map((x) => x.replace(/^\./, "").toLowerCase()) })}
              placeholder="dwg, plf, fmscan" className={input} />
          </Field>
          <Field label="Equipment number">
            <input key={`e:${filters.equipment.join(",")}`} defaultValue={filters.equipment.join(", ")} onBlur={(e) => set({ equipment: list(e.target.value) })} placeholder="2010.03, 2030.14" className={input} />
          </Field>
          <Field label="Folder (path inside the share)">
            <input value={filters.folder ?? ""} onChange={(e) => set({ folder: e.target.value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || undefined })}
              placeholder="2000 - CRUDE UNIT/10 - VESSELS" className={input} />
          </Field>
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="Modified after">
              <input type="date" value={filters.after ?? ""} onChange={(e) => { setDatePreset("custom"); set({ after: e.target.value || undefined }); }} className={input} />
            </Field>
            <Field label="Modified before">
              <input type="date" value={filters.before ?? ""} onChange={(e) => { setDatePreset("custom"); set({ before: e.target.value || undefined }); }} className={input} />
            </Field>
            <Field label="Min size (MB)">
              <input type="number" min={0} step="any" value={filters.minSize != null ? +(filters.minSize / MB).toFixed(3) : ""} onChange={(e) => set({ minSize: e.target.value === "" ? undefined : Math.round(Number(e.target.value) * MB) })} className={input} />
            </Field>
            <Field label="Max size (MB)">
              <input type="number" min={0} step="any" value={filters.maxSize != null ? +(filters.maxSize / MB).toFixed(3) : ""} onChange={(e) => set({ maxSize: e.target.value === "" ? undefined : Math.round(Number(e.target.value) * MB) })} className={input} />
            </Field>
          </div>
          {overview && overview.units.length > 0 && (
            <Field label="Unit">
              <div className="max-h-36 overflow-y-auto space-y-0.5 rounded-md border border-[var(--color-border)] p-1">
                {overview.units.filter((u) => u.code).map((u) => (
                  <label key={u.folder} className="flex items-center gap-1.5 text-[11px]">
                    <input type="checkbox" checked={filters.units.includes(u.code!)} onChange={() => set({ units: toggle(filters.units, u.code!) })} />
                    <span className="font-mono">{u.code}</span> {unitName(u.folder)}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <Field label="Folder role (from the indexer)">
            <div className="flex flex-wrap gap-1">
              {ROLES.map(([k, l]) => <button key={k} onClick={() => set({ roles: toggle(filters.roles, k) })} className={chip(filters.roles.includes(k))}>{l}</button>)}
            </div>
          </Field>
          <label className="flex items-center gap-1.5 text-[11px]">
            <input type="checkbox" checked={!!filters.includeExcluded} onChange={(e) => set({ includeExcluded: e.target.checked || undefined })} />
            Include files the indexer set aside (empty files, OS junk)
          </label>
        </div>
      )}
    </div>
  );
}

function Field({ label: l, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{l}</span>
      {children}
    </label>
  );
}
