"use client";

// ReviewClassesSection — the workspace's own work classes and code classes on
// Admin → Request forms (drafting-flow DF-P6: GAP-101, TIER-4).
//
// Both live in org_configurations 'drafting' beside the request types
// (DEC-90 ruling (4) for DF-P6), seeded EMPTY: an unclassified request is the
// safe reading (engineered unless declared like-in-kind). The names are the
// facility's own — no vocabulary in code (DEC-35). A class marked
// "Requires engineering" makes engineering review required when triage picks
// it; it never lowers the requirement (DEC-33). Saved with the page's own
// Save Changes (the 20261209 write rule decides who may).
//
// DF-P18 (drafting-flow TIER-7, TIER-6): a WORK class may also be flagged
// "Minor correction" (the workspace's declared minor correction — the
// minor-correction approval names it) and "Needs MOC" (the hand-back asks
// for the MOC number whatever the change type). Both only add; unflagged
// classes, and requests with no class, behave as before. A code class
// carries neither.

import React from "react";
import { Plus, Trash2, Tags } from "lucide-react";
import type { OrgDraftingSettings, ReviewClassConfig, ReviewClassOption } from "@/types/schema";
import type { ReviewClassEntry } from "@/lib/reviewModel";

type Key = "workClasses" | "codeClasses";

const SECTIONS: Array<{ key: Key; title: string; desc: string; fallbackLabel: string }> = [
  {
    key: "workClasses", fallbackLabel: "Work class", title: "Work Classes",
    desc: "Optional. What kind of change a request is, in your facility's words — set at triage, never asked of the requester. A request with no class is treated as engineered work unless its requester declared it like-in-kind.",
  },
  {
    key: "codeClasses", fallbackLabel: "Code class", title: "Code Classes",
    desc: "Optional. Which governing code or service class applies, in your facility's words — set at triage, shown to the reviewer before they approve.",
  },
];

/** The class lists as the editor holds them (pure; exported for tests). */
export function editableClasses(settings: Partial<OrgDraftingSettings> | null | undefined, key: Key): ReviewClassConfig {
  const raw = (settings as Record<string, unknown> | null | undefined)?.[key] as ReviewClassConfig | undefined;
  const options = Array.isArray(raw?.options)
    ? raw!.options.filter((o): o is ReviewClassOption => !!o && typeof o === "object").map((o): ReviewClassEntry => ({
      label: typeof o.label === "string" ? o.label : "",
      value: typeof o.value === "string" ? o.value : "",
      ...(o.engineering === true ? { engineering: true } : {}),
      // DF-P18: a work class's flags are kept through every edit.
      ...(key === "workClasses" && (o as ReviewClassEntry).minorCorrection === true ? { minorCorrection: true as const } : {}),
      ...(key === "workClasses" && (o as ReviewClassEntry).moc === true ? { moc: true as const } : {}),
    }))
    : [];
  return { ...(typeof raw?.label === "string" ? { label: raw.label } : {}), options };
}

/** One flag on or off, every other field and flag kept (pure; exported for tests). */
export function withFlag(o: ReviewClassEntry, flag: "engineering" | "minorCorrection" | "moc", on: boolean): ReviewClassEntry {
  const next: ReviewClassEntry = { ...o };
  if (on) (next as unknown as Record<string, unknown>)[flag] = true;
  else delete (next as unknown as Record<string, unknown>)[flag];
  return next;
}

export default function ReviewClassesSection({
  settings, onChange,
}: {
  settings: OrgDraftingSettings;
  onChange: (patch: Partial<OrgDraftingSettings>) => void;
}) {
  return (
    <>
      {SECTIONS.map(({ key, title, desc }) => {
        const cfg = editableClasses(settings, key);
        const set = (options: ReviewClassOption[]) => onChange({ [key]: { ...cfg, options } } as Partial<OrgDraftingSettings>);
        return (
          <div key={key} data-testid={`review-classes-${key}`} className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-6 shadow-sm">
            <h2 className="text-sm font-bold text-[var(--color-text)] uppercase tracking-wide mb-1 flex items-center"><Tags className="w-4 h-4 mr-2 text-orange-500" />{title}</h2>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">{desc}</p>
            {cfg.options.length === 0 && <p className="text-xs text-[var(--color-text-faint)] mb-3">None configured.</p>}
            <div className="space-y-2">
              {cfg.options.map((o, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <input aria-label={`${title} label`} className="flex-1 min-w-[10rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                    placeholder="Label" value={o.label}
                    onChange={(e) => set(cfg.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  <input aria-label={`${title} value`} className="w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-mono"
                    placeholder="Value" value={o.value}
                    onChange={(e) => set(cfg.options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                    <input type="checkbox" checked={o.engineering === true}
                      onChange={(e) => set(cfg.options.map((x, j) => (j === i ? withFlag(x, "engineering", e.target.checked) : x)))} />
                    Requires engineering
                  </label>
                  {key === "workClasses" && (
                    <>
                      <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]" title="This class is your minor correction: the minor-correction approval names it, and the class's own reviewer requirement applies.">
                        <input type="checkbox" data-testid="review-class-minor-correction" checked={(o as ReviewClassEntry).minorCorrection === true}
                          onChange={(e) => set(cfg.options.map((x, j) => (j === i ? withFlag(x, "minorCorrection", e.target.checked) : x)))} />
                        Minor correction
                      </label>
                      <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]" title="A request of this class needs an MOC position: its hand-back asks for the MOC number whatever the change type.">
                        <input type="checkbox" data-testid="review-class-moc" checked={(o as ReviewClassEntry).moc === true}
                          onChange={(e) => set(cfg.options.map((x, j) => (j === i ? withFlag(x, "moc", e.target.checked) : x)))} />
                        Needs MOC
                      </label>
                    </>
                  )}
                  <button type="button" aria-label="Remove" className="p-1 text-[var(--color-text-muted)] hover:text-red-600"
                    onClick={() => set(cfg.options.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
            <button type="button" className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
              onClick={() => set([...cfg.options, { label: "", value: "" }])}><Plus className="w-3.5 h-3.5" />Add</button>
          </div>
        );
      })}
    </>
  );
}
