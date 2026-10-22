// lib/ask/askTrace.ts — the research record behind every answer.
//
// When an answer misses, the question is always WHERE: the right page was
// never found, was found and ranked out, was given to the model and not
// used, or was used and misread. Without a record each fix is a guess. The
// engine notes what each stage did — the queries it wrote, the pages each
// search returned, what reached the model, what the chase looked for — and
// the record is saved beside the answer.
//
// It holds ids, pages, ranks and short snippets — never whole passages — so
// it can be summarised for a developer without sending document text.

export interface TraceHit {
  chunkId: string;
  documentId: string;
  page: number;
  rank?: number;
  /** ≤160 characters, for a person reading the record. */
  snippet?: string;
}

export interface TraceStage {
  name: string;
  /** Milliseconds since the ask started. */
  at: number;
  data: Record<string, unknown>;
}

const SNIPPET = 160;

type ChunkLike = { id: string; document_id: string; page: number; content?: string | null; rank?: number };

export class AskTrace {
  readonly started = Date.now();
  readonly stages: TraceStage[] = [];
  /** Model calls: which step, which model, tokens. */
  readonly calls: Array<{ step: string; model: string; inputTokens: number; outputTokens: number }> = [];

  stage(name: string, data: Record<string, unknown> = {}): void {
    if (this.stages.length >= 80) return;   // a runaway loop can't bloat the row
    this.stages.push({ name, at: Date.now() - this.started, data });
  }

  /** A stage whose result is a list of passages. */
  hits(name: string, chunks: ChunkLike[], extra: Record<string, unknown> = {}, max = 40): void {
    this.stage(name, { count: chunks.length, hits: chunks.slice(0, max).map(compactHit), ...extra });
  }

  call(step: string, model: string, usage: { inputTokens?: number; outputTokens?: number } | undefined): void {
    this.calls.push({ step, model, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 });
  }

  toJSON() {
    return { stages: this.stages, calls: this.calls, totalMs: Date.now() - this.started };
  }
}

export function compactHit(c: ChunkLike, i?: number): TraceHit {
  const snippet = (c.content ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET);
  return {
    chunkId: c.id, documentId: c.document_id, page: c.page,
    ...(typeof c.rank === "number" ? { rank: c.rank } : typeof i === "number" ? { rank: i + 1 } : {}),
    ...(snippet ? { snippet } : {}),
  };
}

/** Which version of the engine produced an answer: the deployed commit. */
export function engineVersion(): string {
  return (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "dev").slice(0, 12);
}

/** Where an expected page dropped out — read straight off a record. The
 *  stages are checked in the order the engine runs them. */
export type Funnel = "never_found" | "found_not_given" | "given_not_cited" | "cited";

export function funnelFor(
  stages: TraceStage[],
  expected: { documentId?: string; documentName?: RegExp; page: number; tolerance?: number },
  docNames: Map<string, string>,
  citations: Array<{ documentId: string; page: number }>,
): Funnel {
  const tol = expected.tolerance ?? 1;
  const matches = (documentId: string, page: number) =>
    (expected.documentId ? documentId === expected.documentId : !!expected.documentName?.test(docNames.get(documentId) ?? ""))
    && Math.abs(page - expected.page) <= tol;
  if (citations.some((c) => matches(c.documentId, c.page))) return "cited";
  const given = stages.find((s) => s.name === "passages");
  const givenHits = (given?.data.hits as TraceHit[] | undefined) ?? [];
  if (givenHits.some((h) => matches(h.documentId, h.page))) return "given_not_cited";
  const anyHit = stages.some((s) => ((s.data.hits as TraceHit[] | undefined) ?? []).some((h) => matches(h.documentId, h.page)));
  return anyHit ? "found_not_given" : "never_found";
}
