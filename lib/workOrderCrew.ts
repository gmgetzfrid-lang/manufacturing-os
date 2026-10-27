// workOrderCrew — a step with no crew named takes its work order's crew.
//
// Crews are set per step, and a schedule file often leaves one blank
// (UIT-013's "Calibrate Equipment", under steps all done by Maintenance
// (KE)). Reports and night staffing read the step's crew as: its own; else
// the work order's (its parent's); else the one crew every other step of
// that work order names. Two or more different crews there: still unknown —
// never a guess.

import type { Milestone } from "@/types/schema";

/** The crew each blank step takes from its work order, by step id. */
export function inheritedCrews(milestones: Milestone[]): Map<string, string> {
  const byId = new Map<string, Milestone>();
  const kids = new Map<string, Milestone[]>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  for (const m of milestones) if (m.parentId && byId.has(m.parentId)) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
  const out = new Map<string, string>();
  for (const m of milestones) {
    if (!m.id || kids.has(m.id) || m.responsibleParty?.trim() || !m.parentId) continue;
    const parent = byId.get(m.parentId);
    const own = parent?.responsibleParty?.trim();
    if (own) { out.set(m.id, own); continue; }
    const crews = new Map<string, string>();
    for (const s of kids.get(m.parentId) ?? []) {
      const c = s.responsibleParty?.trim();
      if (c) crews.set(c.toLowerCase(), c);
    }
    if (crews.size === 1) out.set(m.id, [...crews.values()][0]);
  }
  return out;
}

/** The steps with blank crews filled from their work order (copies; the
 *  schedule itself is never changed). */
export function withWorkOrderCrews(milestones: Milestone[]): Milestone[] {
  const got = inheritedCrews(milestones);
  if (got.size === 0) return milestones;
  return milestones.map((m) => (m.id && got.has(m.id) ? { ...m, responsibleParty: got.get(m.id)! } : m));
}
