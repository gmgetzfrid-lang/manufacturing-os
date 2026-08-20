"use client";

// GraphControls — the settings drawer.
//
// Obsidian's four sections (Filters / Groups / Display / Forces), because
// that grouping is genuinely well designed, with one addition of its own:
// every force is live, so the layout answers while you drag. Sliders that
// only apply on release are the difference between a toy and an instrument.

import React from "react";
import {
  SlidersHorizontal, Filter, Palette, Eye, Waves, ChevronDown, Plus, X,
  RotateCcw, Boxes, Square,
} from "lucide-react";
import type { GraphNodeType } from "@/lib/orgGraph";
import {
  DEFAULT_GRAPH_SETTINGS, GROUP_PALETTE,
  type GraphSettings, type ColorGroup,
} from "@/lib/graphSettings";
import { NODE_COLORS } from "@/components/graph/graphTheme";

const TYPE_LABELS: Record<GraphNodeType, string> = {
  document: "Documents", asset: "Equipment", unit: "Units",
  library: "Libraries", project: "Projects", plant: "Plants", plot: "Plot plans",
};
const TYPE_ORDER: GraphNodeType[] = ["unit", "asset", "document", "library", "project", "plant", "plot"];

function Section({ icon: Icon, title, children, defaultOpen = false }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="border-b border-[var(--color-border)] last:border-0">
      <button onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-surface-2)]">
        <Icon className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
        <span className="flex-1 text-left text-[11px] font-black uppercase tracking-widest text-[var(--color-text)]">{title}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-[var(--color-text-faint)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="px-3 pb-3 space-y-2.5">{children}</div>}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, hint }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; hint?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-[10px] font-bold text-[var(--color-text-muted)]">
        {label}
        <span className="font-mono text-[var(--color-text-faint)]">{value.toFixed(step < 1 ? 2 : 0)}</span>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-violet-600 h-1.5"
      />
      {hint && <span className="block text-[9px] text-[var(--color-text-faint)] -mt-0.5">{hint}</span>}
    </label>
  );
}

function Toggle({ label, checked, onChange, hint }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-violet-600" />
      <span className="min-w-0">
        <span className="block text-[11px] font-bold text-[var(--color-text)]">{label}</span>
        {hint && <span className="block text-[9px] text-[var(--color-text-faint)]">{hint}</span>}
      </span>
    </label>
  );
}

export default function GraphControls({
  settings, onChange, counts, onReset,
}: {
  settings: GraphSettings;
  onChange: (patch: Partial<GraphSettings>) => void;
  counts: Record<GraphNodeType, number>;
  onReset: () => void;
}) {
  const [open, setOpen] = React.useState(false);

  const toggleType = (t: GraphNodeType) => {
    const hidden = settings.hiddenTypes.includes(t)
      ? settings.hiddenTypes.filter((x) => x !== t)
      : [...settings.hiddenTypes, t];
    onChange({ hiddenTypes: hidden });
  };

  const addGroup = () => {
    const g: ColorGroup = {
      id: `g${Date.now().toString(36)}`,
      query: "",
      color: GROUP_PALETTE[settings.groups.length % GROUP_PALETTE.length],
      enabled: true,
    };
    onChange({ groups: [...settings.groups, g] });
  };
  const patchGroup = (id: string, patch: Partial<ColorGroup>) => {
    onChange({ groups: settings.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) });
  };
  const removeGroup = (id: string) => {
    onChange({ groups: settings.groups.filter((g) => g.id !== id) });
  };

  return (
    <div className="absolute top-2 right-3 z-10 flex flex-col items-end gap-2 max-h-[calc(100%-1rem)]">
      <div className="flex items-center gap-1.5">
        {/* 2D / 3D — the switch people will reach for first. */}
        <div className="inline-flex rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)]/90 backdrop-blur p-0.5 shadow-sm">
          <button onClick={() => onChange({ mode: "2d" })}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-black transition-colors ${
              settings.mode === "2d" ? "bg-violet-600 text-white" : "text-[var(--color-text-muted)]"
            }`}>
            <Square className="w-3 h-3" /> 2D
          </button>
          <button onClick={() => onChange({ mode: "3d" })}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-black transition-colors ${
              settings.mode === "3d" ? "bg-violet-600 text-white" : "text-[var(--color-text-muted)]"
            }`}>
            <Boxes className="w-3 h-3" /> 3D
          </button>
        </div>
        <button onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] font-black shadow-sm ${
            open ? "border-violet-400 text-violet-700 bg-[var(--color-surface)]"
                 : "border-[var(--color-border-strong)] text-[var(--color-text)] bg-[var(--color-surface)]/90 backdrop-blur"
          }`}>
          <SlidersHorizontal className="w-3.5 h-3.5" /> Settings
        </button>
      </div>

      {open && (
        <div className="w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/97 backdrop-blur shadow-2xl overflow-y-auto">
          <Section icon={Filter} title="Filters" defaultOpen>
            <div className="space-y-1">
              {TYPE_ORDER.map((t) => (
                (t === "plant" && counts[t] === 0) ? null : (
                  <label key={t} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!settings.hiddenTypes.includes(t)}
                      onChange={() => toggleType(t)} className="accent-violet-600" />
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[t] }} />
                    <span className="flex-1 text-[11px] font-bold text-[var(--color-text)]">{TYPE_LABELS[t]}</span>
                    <span className="text-[10px] font-mono text-[var(--color-text-faint)]">{counts[t]}</span>
                  </label>
                )
              ))}
            </div>
            <div className="pt-1.5 space-y-1.5 border-t border-[var(--color-border)]">
              <Toggle label="Library links" checked={settings.showLibraryEdges}
                onChange={(v) => onChange({ showLibraryEdges: v })}
                hint="Every document links to its library — usually noise." />
              <Toggle label="Hide unlinked" checked={settings.hideUnlinked}
                onChange={(v) => onChange({ hideUnlinked: v })}
                hint="Drop nodes with no connections in this view." />
              <Toggle label="Proposed connections" checked={settings.showProposals}
                onChange={(v) => onChange({ showProposals: v })}
                hint="Dashed gold: found, awaiting your review." />
            </div>
          </Section>

          <Section icon={Palette} title="Groups">
            <p className="text-[9px] text-[var(--color-text-faint)]">
              Paint your own meaning onto the map. Matches a node&apos;s name, or use
              <code className="mx-1 px-1 rounded bg-[var(--color-surface-2)]">type:asset</code>
              to colour a whole kind. First match wins.
            </p>
            {settings.groups.map((g) => (
              <div key={g.id} className="flex items-center gap-1.5">
                <input type="checkbox" checked={g.enabled}
                  onChange={(e) => patchGroup(g.id, { enabled: e.target.checked })}
                  className="accent-violet-600" />
                <input value={g.query} onChange={(e) => patchGroup(g.id, { query: e.target.value })}
                  placeholder="e.g. 44-  ·  crude  ·  type:unit"
                  className="flex-1 min-w-0 px-2 py-1 border border-[var(--color-border-strong)] rounded-lg text-[11px] bg-[var(--color-surface)]" />
                <input type="color" value={g.color}
                  onChange={(e) => patchGroup(g.id, { color: e.target.value })}
                  aria-label="Group colour"
                  className="w-6 h-6 rounded cursor-pointer border border-[var(--color-border)] bg-transparent p-0" />
                <button onClick={() => removeGroup(g.id)} aria-label="Remove group"
                  className="p-0.5 text-[var(--color-text-faint)] hover:text-rose-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button onClick={addGroup}
              className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-violet-700 border border-dashed border-[var(--color-border-strong)] rounded-lg px-2 py-1">
              <Plus className="w-3 h-3" /> Add colour group
            </button>
          </Section>

          <Section icon={Eye} title="Display">
            <Slider label="Node size" value={settings.nodeScale} min={0.4} max={3} step={0.05}
              onChange={(v) => onChange({ nodeScale: v })} />
            <Slider label="Link thickness" value={settings.linkThickness} min={0.2} max={4} step={0.1}
              onChange={(v) => onChange({ linkThickness: v })} />
            <Slider label="Link opacity" value={settings.linkOpacity} min={0.1} max={1.5} step={0.05}
              onChange={(v) => onChange({ linkOpacity: v })} />
            <Slider label="Label threshold" value={settings.labelThreshold} min={0.1} max={2} step={0.05}
              onChange={(v) => onChange({ labelThreshold: v })}
              hint="How close you must be before names appear." />
            <div className="space-y-1.5 pt-1">
              <Toggle label="Arrows" checked={settings.showArrows}
                onChange={(v) => onChange({ showArrows: v })}
                hint="Direction on supersession and curated links." />
              <Toggle label="Curved links" checked={settings.curvedLinks}
                onChange={(v) => onChange({ curvedLinks: v })} />
              <Toggle label="Glow" checked={settings.glow}
                onChange={(v) => onChange({ glow: v })}
                hint="Halos in 2D, additive blending in 3D." />
            </div>
          </Section>

          <Section icon={Waves} title="Forces">
            <Slider label="Centre force" value={settings.centerForce} min={0} max={3} step={0.05}
              onChange={(v) => onChange({ centerForce: v })}
              hint="Pull toward the middle. 0 lets islands drift." />
            <Slider label="Repel force" value={settings.repelForce} min={0.1} max={4} step={0.05}
              onChange={(v) => onChange({ repelForce: v })}
              hint="How hard nodes push each other away." />
            <Slider label="Link force" value={settings.linkForce} min={0} max={3} step={0.05}
              onChange={(v) => onChange({ linkForce: v })} />
            <Slider label="Link distance" value={settings.linkDistance} min={20} max={320} step={5}
              onChange={(v) => onChange({ linkDistance: v })} />
            <Slider label="Neighbourhood depth" value={settings.localDepth} min={1} max={5} step={1}
              onChange={(v) => onChange({ localDepth: v })}
              hint="Hops shown when you focus a single node." />
          </Section>

          <div className="p-2">
            <button onClick={onReset}
              className="w-full inline-flex items-center justify-center gap-1.5 text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border-strong)] rounded-lg py-1.5">
              <RotateCcw className="w-3 h-3" /> Reset to defaults
            </button>
            {JSON.stringify(settings) === JSON.stringify(DEFAULT_GRAPH_SETTINGS) && (
              <div className="text-[9px] text-center text-[var(--color-text-faint)] pt-1">Settings are saved per workspace.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
