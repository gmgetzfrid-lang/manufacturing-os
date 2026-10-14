// lib/drawingCensusClient.ts — the browser side of reading a drawing sheet
// with the person's model: page by page until the drawing is done.

import { estatePost } from "@/lib/estate/client";
import type { CensusPageResult, CensusSheet } from "@/lib/drawingCensus";

export interface CensusRun {
  equipment: CensusSheet["equipment"];
  instruments: string[];
  offSheet: CensusSheet["offSheet"];
  correction: CensusPageResult["correction"] | null;
  pages: number;
}

export async function readDrawing(orgId: string, target: { documentId?: string; knowledgeDocumentId?: string }, onPage?: (page: number, pageCount: number) => void): Promise<CensusRun> {
  const run: CensusRun = { equipment: [], instruments: [], offSheet: [], correction: null, pages: 0 };
  let page = 1;
  let kdoc = target.knowledgeDocumentId;
  for (let guard = 0; guard < 60; guard++) {
    const r = await estatePost<CensusPageResult & { knowledgeDocumentId: string }>("/api/drawings/census", { orgId, ...(kdoc ? { knowledgeDocumentId: kdoc } : { documentId: target.documentId }), page });
    kdoc = r.knowledgeDocumentId;
    run.equipment.push(...r.sheet.equipment.filter((e) => !run.equipment.some((x) => x.tag === e.tag)));
    for (const t of r.sheet.instruments) if (!run.instruments.includes(t)) run.instruments.push(t);
    run.offSheet.push(...r.sheet.offSheet.filter((o) => !run.offSheet.some((x) => x.tag === o.tag)));
    run.pages = r.pageCount;
    onPage?.(page, r.pageCount);
    if (r.correction) run.correction = r.correction;
    if (r.done) break;
    page++;
  }
  return run;
}

export async function pendingDrawings(orgId: string): Promise<{ pending: Array<{ knowledgeDocumentId: string; name: string }>; total: number }> {
  return estatePost("/api/drawings/census", { orgId, action: "pending" });
}
