// lib/bulkEdit.ts — change a name on every task at once.
//
// Contractors get swapped, crews renamed, a company changes its name: the
// same text sits on dozens of tasks, and editing each by hand is the job of
// an afternoon. Here a value is replaced wherever it appears — including
// inside a list ("Acme Mechanical, Bay Crane" — the import joins several
// resources with commas), where only that name changes and the rest of the
// list stays. Or one value is set on a chosen set of tasks. Pure: the plan
// of what changes; lib/milestones.ts writes it.

import type { Milestone } from "@/types/schema";

export interface BulkField {
  key: "responsibleParty" | "responsibleOrg" | "responsibleKind" | "actualParty" | "actualOrg" | "actualKind" | "location" | "workOrderRef";
  label: string;
  /** Holds a comma-separated list of names (several resources on one task). */
  list: boolean;
}

export const BULK_FIELDS: BulkField[] = [
  { key: "responsibleParty", label: "Responsible — person / crew / contractor", list: true },
  { key: "responsibleOrg", label: "Responsible — company / department", list: true },
  { key: "responsibleKind", label: "Responsible — type", list: false },
  { key: "actualParty", label: "Did the work — person / crew", list: true },
  { key: "actualOrg", label: "Did the work — company / department", list: true },
  { key: "actualKind", label: "Did the work — type", list: false },
  { key: "location", label: "Location / area", list: false },
  { key: "workOrderRef", label: "Work order #", list: false },
];

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const split = (v: string, list: boolean) => (list ? v.split(/\s*[,;]\s*/) : [v]).map((x) => x.trim()).filter(Boolean);

/** Every value in use for a field, with how many tasks carry it, most
 *  used first. Names inside a list count on their own. Spelling variants
 *  that differ only in case or spacing are one value. */
export function valuesIn(milestones: Milestone[], field: BulkField): Array<{ value: string; count: number }> {
  const out = new Map<string, { value: string; count: number }>();
  for (const m of milestones) {
    const v = (m[field.key] as string | null | undefined) ?? "";
    const seen = new Set<string>();
    for (const t of split(v, field.list)) {
      const k = norm(t);
      if (seen.has(k)) continue;
      seen.add(k);
      const e = out.get(k) ?? { value: t, count: 0 };
      e.count++;
      out.set(k, e);
    }
  }
  return [...out.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export interface BulkChange { id: string; name: string; before: string | null; after: string | null }

/** Replace `from` with `to` wherever it appears in the field. `to` empty =
 *  remove the name. In a list only the matching name changes, and a name
 *  that would then appear twice appears once. */
export function planReplace(milestones: Milestone[], field: BulkField, from: string, to: string): BulkChange[] {
  const f = norm(from), t = to.trim().replace(/\s+/g, " ");
  if (!f) return [];
  const out: BulkChange[] = [];
  for (const m of milestones) {
    if (!m.id) continue;
    const before = (m[field.key] as string | null | undefined) ?? null;
    if (!before) continue;
    const parts = split(before, field.list);
    if (!parts.some((p) => norm(p) === f)) continue;
    const next: string[] = [];
    for (const p of parts) {
      const v = norm(p) === f ? t : p;
      if (v && !next.some((x) => norm(x) === norm(v))) next.push(v);
    }
    const after = next.length ? next.join(", ") : null;
    if (after !== before) out.push({ id: m.id, name: m.name, before, after });
  }
  return out;
}

/** Set the field to `value` on the chosen tasks (empty = clear it). */
export function planSet(milestones: Milestone[], field: BulkField, ids: Set<string>, value: string): BulkChange[] {
  const v = value.trim().replace(/\s+/g, " ") || null;
  return milestones
    .filter((m) => m.id && ids.has(m.id))
    .map((m) => ({ id: m.id!, name: m.name, before: (m[field.key] as string | null | undefined) ?? null, after: v }))
    .filter((c) => c.before !== c.after);
}
