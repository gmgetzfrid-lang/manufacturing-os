// workOrderCrew — a step with no crew named takes its work order's crew;
// one with no WO number takes its work order's number.
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

// A schedule's own WO column, by its name ("Work Order", "WO #", "W/O No.").
const WO_KEY = /^\s*(work\s*order|wo|w\/o)\s*(#|no\.?|num(ber)?|ref)?\s*$/i;

/** A task's WO number: the WO field, else the schedule file's WO column
 *  (an MS Project custom field keeps it there). */
export function woOf(m: Milestone): string {
  const own = m.workOrderRef?.trim();
  if (own) return own;
  for (const [k, v] of Object.entries((m.attributes ?? {}) as Record<string, unknown>)) {
    if (WO_KEY.test(k) && (typeof v === "string" || typeof v === "number") && String(v).trim()) return String(v).trim();
  }
  return "";
}

/** The WO number each step's reports show when the WO field is blank: its
 *  own WO column, else the nearest group above it that has one (the work
 *  order), by step id. */
export function inheritedWorkOrders(milestones: Milestone[]): Map<string, string> {
  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  const out = new Map<string, string>();
  for (const m of milestones) {
    if (!m.id || m.workOrderRef?.trim()) continue;
    const own = woOf(m);
    if (own) { out.set(m.id, own); continue; }
    const seen = new Set<string>();
    for (let p = m.parentId ? byId.get(m.parentId) : undefined; p?.id && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
      seen.add(p.id);
      const wo = woOf(p);
      if (wo) { out.set(m.id, wo); break; }
    }
  }
  return out;
}

/** The steps with blank crews and WO numbers filled from their work order
 *  (copies; the schedule itself is never changed). */
export function withWorkOrderCrews(milestones: Milestone[]): Milestone[] {
  const got = inheritedCrews(milestones);
  const wos = inheritedWorkOrders(milestones);
  if (got.size === 0 && wos.size === 0) return milestones;
  return milestones.map((m) => {
    if (!m.id || (!got.has(m.id) && !wos.has(m.id))) return m;
    return { ...m, ...(got.has(m.id) ? { responsibleParty: got.get(m.id)! } : {}), ...(wos.has(m.id) ? { workOrderRef: wos.get(m.id)! } : {}) };
  });
}
