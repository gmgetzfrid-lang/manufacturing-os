// intelligence Round G, I-02b integration (2026-10-01) — the table-aware
// re-index's client (runTableAwareReindex in lib/knowledge.ts) tells a
// document the engine RESET but could not fully clear (a leftover: counted
// in `reset`, out of Ask, queued) from one it could NOT reset (an error),
// by matching RESET_WITH_LEFTOVERS against the route's free-text `errors`.
// The route returns no structured leftovers yet (ING-13), so the regex is
// coupled to the engine's wording in lib/knowledgeIngest.ts — a file the
// client does not own. This pins the coupling both ways:
//
//   1. Source: every message resetKnowledgeIndex pushes for a document it
//      reset with leftovers matches the regex, every other message it
//      pushes does not, no other literal in the engine carries the mark, and
//      reindexLibraryChunks (the route's reindex) reports only what
//      resetKnowledgeIndex reported.
//   2. Behaviour: resetKnowledgeIndex and reindexLibraryChunks run under the
//      in-memory client with a failing delete produce a message the regex
//      matches, and the client files it as a leftover; a reset that fails at
//      the row produces one it does not, and the client files it as an error.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { db, resetDb, rowsOf, type Op } from "./knowledgeFakeDb";

vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./knowledgeFakeDb")).fakeAdmin }));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn() }));
vi.mock("@/lib/r2", () => ({ R2_BUCKET: "bucket", r2: { send: vi.fn() } }));
vi.mock("@/lib/knowledgeVision", () => ({ transcribePageImage: vi.fn() }));
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/usageServer", () => ({ getMonthUsage: vi.fn(), getCapUsd: vi.fn(), recordAskUsage: vi.fn() }));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import { resetKnowledgeIndex, reindexLibraryChunks } from "@/lib/knowledgeIngest";
import { RESET_WITH_LEFTOVERS, runTableAwareReindex } from "@/lib/knowledge";

const ENGINE = join(process.cwd(), "lib/knowledgeIngest.ts");

// ── 1. The engine's source ──────────────────────────────────────────────

const source = ts.createSourceFile(ENGINE, readFileSync(ENGINE, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function fn(name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  source.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n; });
  if (!found) throw new Error(`${name} is not a top-level function in lib/knowledgeIngest.ts`);
  return found;
}

/** Every `out.errors.push(…)` argument inside `node`. */
function errorPushes(node: ts.Node): ts.Expression[] {
  const out: ts.Expression[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(source) === "out.errors.push") out.push(...n.arguments);
    n.forEachChild(walk);
  };
  walk(node);
  return out;
}

/** A message as it reads at run time, with each `${…}` filled by a stand-in
 *  (the dynamic parts — the document id, the failed steps — come before the
 *  mark, and the mark itself is literal text). Null for anything that is not
 *  a string or template literal. */
function rendered(e: ts.Expression): string | null {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => `«${s.expression.getText(source)}»${s.literal.text}`).join("");
  return null;
}

/** Whether the message names the leftovers list (`left`) — the reset-with-
 *  leftovers report, as opposed to a document the reset could not reset. */
const namesLeftovers = (e: ts.Expression): boolean => {
  let hit = false;
  const walk = (n: ts.Node) => { if (ts.isIdentifier(n) && n.text === "left") hit = true; n.forEachChild(walk); };
  walk(e);
  return hit;
};

describe("RESET_WITH_LEFTOVERS is the engine's own wording (source)", () => {
  const pushes = errorPushes(fn("resetKnowledgeIndex"));

  it("every message resetKnowledgeIndex pushes for a document it reset with leftovers matches; every other one does not", () => {
    const leftovers = pushes.filter(namesLeftovers);
    const others = pushes.filter((e) => !namesLeftovers(e));
    expect(leftovers.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    for (const e of leftovers) {
      const msg = rendered(e);
      expect(msg, e.getText(source)).not.toBeNull();
      expect(RESET_WITH_LEFTOVERS.test(msg!), msg!).toBe(true);
    }
    for (const e of others) {
      const msg = rendered(e) ?? e.getText(source);
      expect(RESET_WITH_LEFTOVERS.test(msg), msg).toBe(false);
    }
  });

  it("no other string in the engine carries the mark — the leftovers report is the only message that does", () => {
    const leftoverNodes = new Set(pushes.filter(namesLeftovers));
    const carriers: string[] = [];
    const walk = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
        const msg = rendered(n as ts.Expression) ?? "";
        if (RESET_WITH_LEFTOVERS.test(msg) && !leftoverNodes.has(n as ts.Expression)) carriers.push(n.getText(source));
        return;
      }
      n.forEachChild(walk);
    };
    walk(source);
    expect(carriers).toEqual([]);
  });

  it("the route's reindex reports only what resetKnowledgeIndex reported (reindexLibraryChunks adds no message of its own)", () => {
    const pushed = errorPushes(fn("reindexLibraryChunks")).map((e) => e.getText(source));
    expect(pushed).toEqual(["...res.errors"]);
  });
});

// ── 2. What the engine produces, and how the client files it ────────────

const DOC = "kd-1";
const row = (over: Record<string, unknown> = {}) => ({
  id: DOC, org_id: "o1", library_id: "kl-1", name: "spec.pdf", file_key: "orgs/o1/spec.pdf",
  status: "ready", pages_indexed: 3, page_count: 3, last_section: null, created_by: "u1", created_at: "2026-09-01",
  error: null, source_id: null, source_document_id: null, source_version_id: null,
  vision_pages: 2, empty_pages: 0, vision_failed_pages: [], vision_partial_accepted: false, chunk_version: 1,
  vision_retry_after: null, vision_retry_tried: [], ingest_failures: 0, ingest_claimed_by: null, ingest_claimed_at: null,
  ...over,
});
const failing = (table: string, kind: Op["kind"], when: (op: Op) => boolean = () => true) =>
  db.hooks.push((op) => (op.table === table && op.kind === kind && when(op)
    ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined));

/** The route's answer to one reindex call, from the engine's own result. */
const answerFrom = (out: Awaited<ReturnType<typeof reindexLibraryChunks>>) => ({
  ok: out.errors.length === 0, chunker: 2, reset: out.reset.length, busy: out.busy.length,
  errors: out.errors.slice(0, 20), remaining: out.remaining,
});

beforeEach(() => {
  resetDb({
    knowledge_libraries: [{ id: "kl-1", org_id: "o1", name: "Specs", chunk_version: 1 }],
    knowledge_documents: [row()],
    knowledge_chunks: [1, 2, 3].map((p) => ({ id: `c${p}`, document_id: DOC, org_id: "o1", library_id: "kl-1", page: p, seq: 0, content: `page ${p}` })),
    knowledge_page_entities: [{ id: "e1", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, kind: "equipment", tag: "P-101" }],
    entity_mentions: [],
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("RESET_WITH_LEFTOVERS matches what the engine produces (behaviour)", () => {
  for (const [what, table] of [["chunks", "knowledge_chunks"], ["page entities", "knowledge_page_entities"], ["machine mentions", "entity_mentions"]] as const) {
    it(`a reset whose ${what} delete fails is reset — and its message carries the mark`, async () => {
      failing(table, "delete");
      const out = await resetKnowledgeIndex([DOC]);
      expect(out.reset).toEqual([DOC]);
      expect(out.errors).toHaveLength(1);
      expect(out.errors[0].startsWith(`${DOC}: `)).toBe(true);
      expect(RESET_WITH_LEFTOVERS.test(out.errors[0]), out.errors[0]).toBe(true);
      expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "stale", pages_indexed: 0 });
    });
  }

  it("a reset that fails at the row is NOT reset — and its message does not carry the mark", async () => {
    failing("knowledge_documents", "update", (op) => (op.payload as Record<string, unknown> | undefined)?.status === "stale");
    const out = await resetKnowledgeIndex([DOC]);
    expect(out.reset).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(RESET_WITH_LEFTOVERS.test(out.errors[0]), out.errors[0]).toBe(false);
  });

  it("through the route's reindex and the client: a leftover is filed as a leftover, a document not reset as an error", async () => {
    vi.stubGlobal("fetch", vi.fn());
    // Leftovers: the chunk delete fails after the row is queued.
    failing("knowledge_chunks", "delete");
    const left = await reindexLibraryChunks("kl-1", 2, {});
    expect(left.reset).toEqual([DOC]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 207, json: async () => answerFrom(left) } as unknown as Response);
    const asLeftover = await runTableAwareReindex("kl-1");
    expect(asLeftover).toMatchObject({ reset: 1, errors: [], leftovers: [left.errors[0]] });

    // Not reset: the row update fails, so the document stays in the selector.
    resetDb({ knowledge_libraries: [{ id: "kl-1", org_id: "o1", name: "Specs", chunk_version: 1 }], knowledge_documents: [row()] });
    failing("knowledge_documents", "update", (op) => (op.payload as Record<string, unknown> | undefined)?.status === "stale");
    const notReset = await reindexLibraryChunks("kl-1", 2, {});
    expect(notReset.reset).toEqual([]);
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 207, json: async () => answerFrom(notReset) } as unknown as Response);
    const asError = await runTableAwareReindex("kl-1");
    expect(asError).toMatchObject({ reset: 0, leftovers: [], errors: [notReset.errors[0]] });
  });
});
