// lib/estate/settle.ts - what the machine recorded earlier, checked again.
//
// A link the resolver applied by itself stands only while the rules still
// prove it, and a proposal it left in Review only while it would still make
// it. When the targets are resolved again:
//   applied, still proven         stays applied
//   applied, now only a question  steps down to pending, with today's reason
//   applied, no longer said       is taken away (its basis is gone: a file
//                                 under a folder whose own link stepped down)
//   pending, now proven           is applied
//   pending, no longer asked      is taken away (a question built on a guess)
//   on a folder or file that no longer exists: taken away
// A person's link (drawn, marked or decided by someone) is never touched,
// and neither is anything the run did not look at. Pure.

import { byPerson, strongestEdge } from "./ids";
import type { ProposedEdge } from "./resolver";

export interface StoredEdge {
  id: string; a: string; b: string; type: string; origin: string; status: string;
  /** Someone approved or dismissed it. */
  decidedBy: string | null;
  /** What it was drawn from (a nickname proposal names its folder here). */
  evidence?: Record<string, unknown> | null;
}

export interface SettlePlan {
  /** Applied by the machine, now only a proposal: back to Review. */
  demote: Array<{ id: string; tier: ProposedEdge["tier"]; confidence: number; summary: string; origin: string; evidence: Record<string, unknown> }>;
  /** Left in Review by the machine, proven now. */
  promote: Array<{ id: string; summary: string; origin: string; evidence: Record<string, unknown> }>;
  /** Recorded by the machine, with nothing saying it any more. */
  remove: string[];
  /** Recorded by the machine on a folder or file that no longer exists. */
  gone: string[];
}

/** The types the machine applies by itself from names and folders. */
const SETTLED = new Set(["belongs_to_unit"]);

/** `resolved`: the node ids this run worked out again. `gone`: node ids of
 *  folders and files that no longer exist. */
export function settleStored(stored: StoredEdge[], proposals: ProposedEdge[], resolved: ReadonlySet<string>, gone: ReadonlySet<string> = new Set()): SettlePlan {
  const now = new Map<string, ProposedEdge>();
  for (const p of proposals) {
    const k = `${p.a}|${p.b}|${p.type}`;
    const had = now.get(k);
    // The same link said twice (proven and as a question): proven counts.
    if (!had || (p.tier === "provable" && had.tier !== "provable")) now.set(k, p);
  }
  const plan: SettlePlan = { demote: [], promote: [], remove: [], gone: [] };
  for (const e of stored) {
    if (e.status !== "applied" && e.status !== "pending") continue;
    if (byPerson(e.origin) || e.decidedBy) continue;
    if (gone.has(e.a) || gone.has(e.b)) { plan.gone.push(e.id); continue; }
    // A nickname proposed from a folder's name goes by that folder.
    if (e.type === "alias_of" && e.status === "pending") {
      const from = typeof e.evidence?.folder === "string" ? e.evidence.folder : null;
      if (from && gone.has(from)) plan.gone.push(e.id);
      else if (from && resolved.has(from) && !now.has(`${e.a}|${e.b}|${e.type}`)) plan.remove.push(e.id);
      continue;
    }
    if (!SETTLED.has(e.type) || !resolved.has(e.a)) continue;
    const p = now.get(`${e.a}|${e.b}|${e.type}`);
    if (!p) { plan.remove.push(e.id); continue; }
    if (e.status === "applied" && p.tier !== "provable") plan.demote.push({ id: e.id, tier: p.tier, confidence: p.confidence, summary: p.summary, origin: p.origin, evidence: p.evidence });
    if (e.status === "pending" && p.tier === "provable") plan.promote.push({ id: e.id, summary: p.summary, origin: p.origin, evidence: p.evidence });
  }
  return plan;
}

/** Each folder's unit from the applied links on it: a person's first, then
 *  what the site's numbers prove, then what was worked out. */
export function folderUnitsFrom(edges: Array<{ a: string; b: string; type: string; origin?: string | null }>): { units: Map<string, string>; byPerson: Set<string> } {
  const per = new Map<string, Array<{ b: string; origin?: string | null }>>();
  for (const e of edges) {
    if (e.type !== "belongs_to_unit" || !e.a.startsWith("folder:") || !e.b.startsWith("cbunit:")) continue;
    const fid = e.a.slice("folder:".length);
    per.set(fid, [...(per.get(fid) ?? []), { b: e.b, origin: e.origin }]);
  }
  const units = new Map<string, string>(), person = new Set<string>();
  for (const [fid, rows] of per) {
    const best = strongestEdge(rows)!;
    units.set(fid, best.b.slice("cbunit:".length));
    if (byPerson(best.origin)) person.add(fid);
  }
  return { units, byPerson: person };
}
