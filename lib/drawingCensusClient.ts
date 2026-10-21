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
  /** Pages not fully read this time — still listed as due. */
  failedPages: number[];
}

export async function readDrawing(orgId: string, target: { documentId?: string; knowledgeDocumentId?: string }, onPage?: (page: number, pageCount: number) => void, runCtx?: { runId: string; runLabel: string },
  /** Only these pages (a catch-up of the pages still due). Default: all. */
  pages?: number[]): Promise<CensusRun> {
  const run: CensusRun = { equipment: [], instruments: [], offSheet: [], correction: null, pages: 0, journaled: true, failedPages: [] };
  let kdoc = target.knowledgeDocumentId;
  const take = (r: CensusPageResult & { knowledgeDocumentId: string }) => {
    kdoc = r.knowledgeDocumentId;
    run.equipment.push(...r.sheet.equipment.filter((e) => !run.equipment.some((x) => x.tag === e.tag)));
    for (const t of r.sheet.instruments) if (!run.instruments.includes(t)) run.instruments.push(t);
    run.offSheet.push(...r.sheet.offSheet.filter((o) => !run.offSheet.some((x) => x.tag === o.tag)));
    run.pages = r.pageCount;
    if (r.sheet.complete === false) run.failedPages.push(r.page);
    if (r.correction) run.correction = r.correction;
    if (r.journaled === false) run.journaled = false;
  };
  const post = (page: number, finalize?: boolean) => estatePost<CensusPageResult & { knowledgeDocumentId: string }>("/api/drawings/census",
    { orgId, ...(kdoc ? { knowledgeDocumentId: kdoc } : { documentId: target.documentId }), page, ...(finalize !== undefined ? { finalize } : {}), ...(runCtx ?? {}) });

  if (pages?.length) {
    // One sheet that can't be read is a gap to retry later, not a reason to
    // leave the rest of the set unread.
    let lastError: Error | null = null;
    for (let i = 0; i < pages.length; i++) {
      try {
        const r = await post(pages[i], i === pages.length - 1);
        take(r);
        onPage?.(pages[i], r.pageCount);
      } catch (e) {
        lastError = e as Error;
        run.failedPages.push(pages[i]);
        // Out of budget or no key: every next page would fail the same way.
        if (/budget|key|agreement/i.test(lastError.message)) throw lastError;
      }
    }
    if (lastError && run.failedPages.length === pages.length) throw lastError;
    return run;
  }

  let page = 1;
  for (let guard = 0; guard < 60; guard++) {
    const r = await post(page);
    take(r);
    onPage?.(page, r.pageCount);
    if (r.done) break;
    page++;
  }
  return run;
}

/** Add equipment the reader missed to one drawing. Undoable by `runId`. */
export async function addEquipment(orgId: string, documentId: string, input: { tag: string; name?: string; page?: number; runId: string }): Promise<{ tag: string; correction: CensusPageResult["correction"] | null; journaled: boolean }> {
  return estatePost("/api/drawings/census", { orgId, documentId, action: "addEquipment", tag: input.tag, name: input.name, page: input.page ?? 1, runId: input.runId, runLabel: `Added ${input.tag.toUpperCase()} by hand` });
}

export async function pendingDrawings(orgId: string, libraryIds?: string[]): Promise<{ pending: Array<{ knowledgeDocumentId: string; name: string; pages: number[]; pageCount: number }>; total: number; pagesDue: number }> {
  return estatePost("/api/drawings/census", { orgId, action: "pending", libraryIds });
}

export async function undoRun(orgId: string, runId: string): Promise<{ drawings: number; columnsRestored: number; edgesRestored: number; edgesRemoved: number; assetsRemoved: number; assetsKept: string[]; readingsRestored: number; skipped: string[] }> {
  return estatePost("/api/estate/runs", { orgId, action: "undo", runId });
}

export function newRunId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
