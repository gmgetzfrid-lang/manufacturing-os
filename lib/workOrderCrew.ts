// workOrderCrew — a step with no crew named takes its work order's crew;
// one with no WO number takes its work order's number.
//
// Crews are set per step, and a schedule file often leaves one blank
// (UIT-013's "Calibrate Equipment", under steps all done by Maintenance
// (KE)). Reports and night staffing read the step's crew as: its own; else
// the work order's (its parent's); else, when it's the one step of that work
// order left blank, the one crew every other step names. Two or more
// different crews there, or several steps blank: still unknown — never a
// guess (crews taken off many steps at once must not all turn into the one
// crew still named, as Schultz's steps once turned into Ancon).

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
    let blank = 0;
    for (const s of kids.get(m.parentId) ?? []) {
      if (s.id && kids.has(s.id)) continue;
      const c = s.responsibleParty?.trim();
      if (c) crews.set(c.toLowerCase(), c); else blank++;
    }
    if (crews.size === 1 && blank === 1) out.set(m.id, [...crews.values()][0]);
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
  // Another crew did the work (picked when updating the step): the reports
  // name that crew. The step's own planned crew stays as it is saved.
  const did = (m: Milestone) => m.actualParty?.trim() || "";
  if (got.size === 0 && wos.size === 0 && !milestones.some(did)) return milestones;
  return milestones.map((m) => {
    if (!m.id || (!got.has(m.id) && !wos.has(m.id) && !did(m))) return m;
    return {
      ...m,
      ...(got.has(m.id) ? { responsibleParty: got.get(m.id)! } : {}),
      ...(did(m) ? { responsibleParty: did(m) } : {}),
      ...(wos.has(m.id) ? { workOrderRef: wos.get(m.id)! } : {}),
    };
  });
}

/** A step's work order: the WO number (its own, or the nearest above), and
 *  the highest task carrying that number (the equipment's), not the step a
 *  copied-down number sits on. No WO: its parent task. */
export function workOrderOfStep(id: string, byId: Map<string, Milestone>): { key: string; wo: string | null; owner: Milestone } | null {
  const m = byId.get(id);
  if (!m) return null;
  let wo = "", at: Milestone | undefined = m;
  const seen = new Set<string>();
  for (; at?.id && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) { seen.add(at.id); wo = woOf(at); if (wo) break; }
  let owner = wo && at ? at : (m.parentId ? byId.get(m.parentId) : undefined) ?? m;
  if (wo) for (let up = owner.parentId ? byId.get(owner.parentId) : undefined; up?.id && !seen.has(up.id) && woOf(up) === wo; up = up.parentId ? byId.get(up.parentId) : undefined) { seen.add(up.id); owner = up; }
  return { key: `${wo || "-"}:${owner.id}`, wo: wo || null, owner };
}

/** Added work (discovery, added scope) stays with its equipment, even with
 *  a WO # of its own. */
const isAdded = (m: Milestone) => { const a = m.attributes as Record<string, unknown> | null | undefined; return !!a && a.discovery != null && a.discovery !== ""; };

type KidsOf = (id: string) => Milestone[];

/** A task's work order number: its own, or the one number typed on its
 *  steps (E-12 with its WO on its steps, or on one of them) - the same rule
 *  as the Work orders list. Sub-tasks with a number of their own are work
 *  orders of their own, so a folder holding them ("Work Orders", "PSVs")
 *  has none. `kidsOf`: each task's children. */
export function taskWorkOrder(task: Milestone, kidsOf: KidsOf): string {
  const own = woOf(task);
  if (own || !task.id) return own;
  const kids = kidsOf(task.id);
  if (kids.some((k) => k.id && kidsOf(k.id).length > 0 && woOf(k))) return "";
  const ws = kids.filter((k) => !isAdded(k)).map(woOf).filter(Boolean);
  return ws.length >= 1 && ws.every((w) => w === ws[0]) ? ws[0] : "";
}

const taskWo = (a: Milestone, kidsOf?: KidsOf) => (kidsOf ? taskWorkOrder(a, kidsOf) : woOf(a));

/** The WO number of a step that is a work order of its own: its number is
 *  on it and not its task's (one PSV in a folder of PSVs, or a WO set under
 *  another's equipment). "" when its work order is the task's. `chain`:
 *  the tasks above it, nearest first; `kidsOf`: each task's steps. */
export function ownWorkOrder(m: Milestone, chain: Milestone[], kidsOf?: KidsOf): string {
  const w = woOf(m);
  if (!w || isAdded(m)) return "";
  const above = chain.map((a) => taskWo(a, kidsOf)).find(Boolean);
  return above === w ? "" : w;
}

/** The task a step sits under on every report and card: its work order's
 *  task (the highest one carrying its WO number, the equipment's), else
 *  the task just above it when no WO is. Null: the step is a work order of
 *  its own, or nothing is above it. Folders of work orders ("PSVs", "Work
 *  Orders") are never a heading. */
export function workOrderTask(m: Milestone, chain: Milestone[], kidsOf?: KidsOf): Milestone | null {
  if (ownWorkOrder(m, chain, kidsOf)) return null;
  const wos = chain.map((a) => taskWo(a, kidsOf));
  const i = wos.findIndex(Boolean);
  if (i < 0) return chain[0] ?? null;
  let top = i;
  while (top + 1 < chain.length && wos[top + 1] === wos[i]) top++;
  return chain[top];
}
