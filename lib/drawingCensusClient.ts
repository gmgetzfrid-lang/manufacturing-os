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
  /** False when undo is unavailable (migration 20261021 not applied). */
  journaled: boolean;
}

export async function readDrawing(orgId: string, target: { documentId?: string; knowledgeDocumentId?: string }, onPage?: (page: number, pageCount: number) => void, runCtx?: { runId: string; runLabel: string }): Promise<CensusRun> {
  const run: CensusRun = { equipment: [], instruments: [], offSheet: [], correction: null, pages: 0, journaled: true };
  let page = 1;
  let kdoc = target.knowledgeDocumentId;
  for (let guard = 0; guard < 60; guard++) {
    const r = await estatePost<CensusPageResult & { knowledgeDocumentId: string }>("/api/drawings/census", { orgId, ...(kdoc ? { knowledgeDocumentId: kdoc } : { documentId: target.documentId }), page, ...(runCtx ?? {}) });
    kdoc = r.knowledgeDocumentId;
    run.equipment.push(...r.sheet.equipment.filter((e) => !run.equipment.some((x) => x.tag === e.tag)));
    for (const t of r.sheet.instruments) if (!run.instruments.includes(t)) run.instruments.push(t);
    run.offSheet.push(...r.sheet.offSheet.filter((o) => !run.offSheet.some((x) => x.tag === o.tag)));
    run.pages = r.pageCount;
    onPage?.(page, r.pageCount);
    if (r.correction) run.correction = r.correction;
    if (r.journaled === false) run.journaled = false;
    if (r.done) break;
    page++;
  }
  return run;
}

export async function pendingDrawings(orgId: string, libraryIds?: string[]): Promise<{ pending: Array<{ knowledgeDocumentId: string; name: string }>; total: number }> {
  return estatePost("/api/drawings/census", { orgId, action: "pending", libraryIds });
}

export async function undoRun(orgId: string, runId: string): Promise<{ drawings: number; columnsRestored: number; edgesRestored: number; edgesRemoved: number; assetsRemoved: number; assetsKept: string[]; readingsRestored: number; skipped: string[] }> {
  return estatePost("/api/estate/runs", { orgId, action: "undo", runId });
}

export function newRunId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
