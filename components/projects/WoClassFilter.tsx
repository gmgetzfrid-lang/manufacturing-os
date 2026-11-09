"use client";

// WoClassFilter - filter work by unit and equipment type, the same way in
// every view: Work orders, the calendar and schedule, the reports. A work
// order's unit and type come from Setup › Units & equipment (lib/woClass):
// confirmed there, else read from its equipment number.

import React, { useMemo } from "react";
import type { Milestone } from "@/types/schema";
import { useProjectEquipment, withSavedHere } from "@/components/projects/EquipmentSetup";
import { classChoices, classOfStep, classPasses, type WoClass } from "@/lib/woClass";
import type { Codebook } from "@/lib/codebook";

export interface WoClasses {
  /** Read (the codebook and the project's units are in). */
  ready: boolean;
  book: Codebook | null;
  /** By the work order's task id. */
  classes: Map<string, WoClass>;
  /** A step's or task's class: its work order's. */
  classOf: (m: Milestone) => WoClass | null;
  choices: ReturnType<typeof classChoices>;
}

const EMPTY_CHOICES = { units: [], types: [] };

/** Every work order's unit and type on this project. */
export function useWoClasses(projectId: string | null | undefined, milestones: Milestone[]): WoClasses {
  const orgId = milestones.find((m) => m.orgId)?.orgId ?? null;
  const pid = projectId ?? milestones.find((m) => m.projectId)?.projectId ?? "";
  const ms = useMemo(() => (pid ? withSavedHere(pid, milestones) : milestones), [pid, milestones]);
  const { data, matches } = useProjectEquipment(pid ? orgId : null, pid, ms);
  return useMemo(() => {
    const classes = new Map(matches.map((m) => [m.ownerId, m.cls]));
    const byId = new Map<string, Milestone>();
    for (const m of ms) if (m.id) byId.set(m.id, m);
    return {
      ready: !!data,
      book: data?.book ?? null,
      classes,
      classOf: (m: Milestone) => classOfStep(m, byId, classes),
      choices: data ? classChoices(classes.values(), data.book) : EMPTY_CHOICES,
    };
  }, [data, matches, ms]);
}

/** Filter a list by the picked unit and type (none picked: all). */
export function passes(c: WoClasses, m: Milestone, units: string[], types: string[]): boolean {
  if (!units.length && !types.length) return true;
  return classPasses(c.classOf(m), units, types);
}

/** The Unit and Type pickers. Hidden while there's nothing to pick from:
 *  the unit when the work is all on one, the type when none is known. */
export function WoClassSelects({ c, units, types, onUnits, onTypes, className = "" }: {
  c: WoClasses; units: string[]; types: string[];
  onUnits: (v: string[]) => void; onTypes: (v: string[]) => void; className?: string;
}) {
  const showUnit = c.choices.units.length > 1 || units.length > 0;
  const showType = c.choices.types.some((t) => t.code !== "-") || types.length > 0;
  if (!c.ready || (!showUnit && !showType)) return null;
  // On a phone the two share the row, each shrinking to fit (never wider than the screen).
  const sel = (on: boolean) => `h-8 min-w-0 flex-1 basis-[8rem] sm:flex-none sm:basis-auto max-w-[14rem] truncate rounded-lg border px-2 text-[12px] font-semibold bg-[var(--color-surface)] text-[var(--color-text)] ${on ? "border-[var(--color-accent)]" : "border-[var(--color-border-strong)]"}`;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 min-w-0 max-w-full ${className}`}>
      {showUnit && (
        <select value={units[0] ?? ""} onChange={(e) => onUnits(e.target.value ? [e.target.value] : [])} aria-label="Unit" className={sel(units.length > 0)}>
          <option value="">All units</option>
          {c.choices.units.map((u) => <option key={u.code} value={u.code}>{u.label} · {u.n}</option>)}
        </select>
      )}
      {showType && (
        <select value={types[0] ?? ""} onChange={(e) => onTypes(e.target.value ? [e.target.value] : [])} aria-label="Equipment type" className={sel(types.length > 0)}>
          <option value="">All equipment types</option>
          {c.choices.types.map((t) => <option key={t.code} value={t.code}>{t.label} · {t.n}</option>)}
        </select>
      )}
    </span>
  );
}
