// lib/find/merge.ts — pure: fold layer evidence into results, group, hide.
//
// The ranker's evidence model is additive and explainable, so layers above
// L0 add NAMED evidence to a result rather than a second opaque score. A
// document the names never matched but whose page shows the tag is a
// candidate on that evidence alone — being drawn on a sheet is a stronger
// claim than being named after one.

import type { IndexEntry } from "@/lib/fileFinder/fileIndex";
import { STRONG_AT, POSSIBLE_AT, type RankedHit, type Verdict } from "@/lib/fileFinder/rank";
import type { ParsedQuery } from "@/lib/fileFinder/queryParse";
import { docTypeByKey } from "@/lib/fileFinder/docTypes";
import type { FindEvidence, FindRelation, FindResult } from "./types";

// Being drawn on a sheet is as strong a claim as being named after the tag.
export const REL_WEIGHT: Record<FindRelation["rel"], number> = {
  drawn_on: 55, mentioned_in: 35, tagged_to: 30, filed_under: 25, in_project: 25, linked_unit: 20,
};
export const TEXT_HIT = 22;

export interface LayerAdd {
  entryId: string;
  evidence: FindEvidence[];
  relations: FindRelation[];
  pages: FindResult["pages"];
}

export function verdictFor(score: number, rejected: boolean): Verdict {
  return rejected ? "rejected" : score >= STRONG_AT ? "strong" : score >= POSSIBLE_AT ? "possible" : "weak";
}

/** Combine L0 hits with what L1/L2 added. Entries that L0 skipped but a
 *  layer found become results on that evidence. */
export function foldLayers(
  entries: IndexEntry[],
  l0: RankedHit[],
  adds: LayerAdd[],
  sameBytesCount: (e: IndexEntry) => number,
): FindResult[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const hitById = new Map(l0.map((h) => [h.entry.id, h]));
  const addById = new Map<string, LayerAdd>();
  for (const a of adds) {
    const cur = addById.get(a.entryId);
    if (cur) { cur.evidence.push(...a.evidence); cur.relations.push(...a.relations); cur.pages.push(...a.pages); }
    else addById.set(a.entryId, { ...a, evidence: [...a.evidence], relations: [...a.relations], pages: [...a.pages] });
  }
  const ids = new Set<string>([...hitById.keys(), ...addById.keys()]);
  const out: FindResult[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) continue;
    const h = hitById.get(id);
    const a = addById.get(id);
    const evidence: FindEvidence[] = [
      ...(h?.evidence.map((x) => ({ ...x, layer: "L0" as const })) ?? []),
      ...(a?.evidence ?? []),
    ];
    const rejected = h?.verdict === "rejected" || e.sizeBytes === 0;
    const score = Math.round(evidence.reduce((s, x) => s + x.delta, 0));
    // De-duplicate relations on (rel, node, page).
    const seen = new Set<string>();
    const relations = (a?.relations ?? []).filter((r) => { const k = `${r.rel}|${r.node}|${r.page ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
    out.push({
      id, documentId: id.replace(/^doc:/, ""), name: e.name, title: e.title ?? null, number: e.number ?? null, rev: e.rev ?? null,
      status: e.status ?? null, libraryId: e.libraryId ?? "", libraryName: e.libraryName ?? null, folderId: e.folderId ?? null,
      path: e.path, href: e.href ?? "", docTypes: e.docTypes, sheet: e.sheet, score, verdict: verdictFor(score, rejected),
      evidence, relations, read: e.read ? { knowledgeDocId: e.read.knowledgeDocId, status: e.read.status, pages: e.read.pages } : undefined,
      pages: (a?.pages ?? []).slice(0, 5), sameBytes: sameBytesCount(e),
    });
  }
  const order: Record<Verdict, number> = { strong: 0, possible: 1, weak: 2, rejected: 3 };
  return out.sort((x, y) => order[x.verdict] - order[y.verdict] || y.score - x.score || x.name.localeCompare(y.name));
}

/** The query asked for a type: results of another known type step aside, counted. */
export function hideOtherTypes(results: FindResult[], q: ParsedQuery): { kept: FindResult[]; hidden: { count: number; byType: Record<string, number> } } {
  if (!q.docTypes.length) return { kept: results, hidden: { count: 0, byType: {} } };
  const asked = new Set(q.docTypes.map((c) => c.value));
  const byType: Record<string, number> = {};
  const kept: FindResult[] = [];
  for (const r of results) {
    const known = r.docTypes.length > 0;
    const matches = r.docTypes.some((t) => asked.has(t));
    // A result with a strong relation (drawn on / mentioned) stays even if its type differs — it is what was asked about.
    const anchored = r.relations.some((x) => x.rel === "drawn_on" || x.rel === "mentioned_in");
    if (known && !matches && !anchored) { for (const t of r.docTypes) byType[docTypeByKey(t)?.label ?? t] = (byType[docTypeByKey(t)?.label ?? t] ?? 0) + 1; continue; }
    kept.push(r);
  }
  return { kept, hidden: { count: results.length - kept.length, byType } };
}

/** Group by how a result relates to what was asked, then by kind. */
export function groupResults(results: FindResult[]): Array<{ key: string; label: string; ids: string[] }> {
  const groups = new Map<string, { label: string; ids: string[] }>();
  const push = (key: string, label: string, id: string) => { const g = groups.get(key) ?? { label, ids: [] }; g.ids.push(id); groups.set(key, g); };
  for (const r of results) {
    const rels = new Set(r.relations.map((x) => x.rel));
    if (rels.has("drawn_on")) push("drawn_on", "Drawn on these sheets", r.id);
    else if (rels.has("mentioned_in")) push("mentioned_in", "Mentioned in the text", r.id);
    else if (rels.has("tagged_to")) push("tagged_to", "Tagged to it", r.id);
    else if (rels.has("filed_under")) push("filed_under", "Filed in its folder", r.id);
    else if (rels.has("in_project")) push("in_project", "In the project", r.id);
    else {
      const t = r.docTypes[0];
      push(t ? `type:${t}` : "other", t ? `${docTypeByKey(t)?.label ?? t}s by name` : "Matched by name", r.id);
    }
  }
  const order = ["drawn_on", "mentioned_in", "tagged_to", "filed_under", "in_project"];
  return [...groups.entries()]
    .sort((a, b) => (order.indexOf(a[0]) === -1 ? 99 : order.indexOf(a[0])) - (order.indexOf(b[0]) === -1 ? 99 : order.indexOf(b[0])))
    .map(([key, g]) => ({ key, label: g.label, ids: g.ids }));
}

/** A readable snippet around the first term found. */
export function snippetAround(content: string, terms: string[], width = 90): string {
  const lower = content.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return content.slice(0, width * 2).replace(/\s+/g, " ").trim() + (content.length > width * 2 ? "…" : "");
  const start = Math.max(0, at - width), end = Math.min(content.length, at + width);
  return (start > 0 ? "…" : "") + content.slice(start, end).replace(/\s+/g, " ").trim() + (end < content.length ? "…" : "");
}
