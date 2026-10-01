// intelligence Round G, I-02b integration (2026-10-01) — the table-aware
// re-index's client (runTableAwareReindex in lib/knowledge.ts) tells a
// document the engine RESET but could not fully clear (a leftover: counted
// in `reset`, out of Ask, queued) from one it could NOT reset (an error),
// by matching RESET_WITH_LEFTOVERS against the route's free-text `errors`.
// The route returns no structured leftovers yet (ING-13), so the regex is
// coupled to the engine's wording in lib/knowledgeIngest.ts and to what
// app/api/knowledge/ingest/route.ts does with it — files the client does not
// own. This pins the coupling both ways:
//
//   1. Source: every message resetKnowledgeIndex pushes for a document it
//      reset with leftovers matches the regex, every other message it
//      pushes does not; once a document is counted reset
//      (`out.reset.push(id)`), every message pushed for it carries the mark;
//      no other literal in the engine carries the mark; and
//      reindexLibraryChunks (the route's reindex) reports only what
//      resetKnowledgeIndex reported.
//   2. Behaviour, end to end: runTableAwareReindex posts to the REAL ingest
//      route (its reindex action, over the real engine and the in-memory
//      database — lib/__tests__/ingestRoute.test.ts's harness). A failing
//      delete after the row is queued comes back as a leftover; a reset that
//      fails at the row comes back as an error. Whatever the route does to
//      `errors` on the way is inside the test.
//
// Review round 2 (2026-10-01): the verifier's probes P6 (a fourth clean-up
// push after `out.reset.push(id)` without the mark) and P8 (the route
// rewriting `errors` with a `.map`) passed every case of the first version;
// the order check and the route-driven half are what catch them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { NextRequest } from "next/server";
import { db, resetDb, rowsOf, type Op, type Row } from "./knowledgeFakeDb";

vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./knowledgeFakeDb")).fakeAdmin }));
// The client's bearer token: the in-memory admin's getUser takes "good" as
// a Doc Control member (u-ctrl).
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "good" } } }) } },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn() }));
vi.mock("@/lib/r2", () => ({ R2_BUCKET: "bucket", r2: { send: vi.fn() } }));
vi.mock("@/lib/knowledgeVision", () => ({ transcribePageImage: vi.fn() }));
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/mentionIndexer", () => ({ loadAliasDictionary: vi.fn(async () => []), indexDocumentMentions: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/usageServer", () => ({ getMonthUsage: vi.fn(async () => ({ spentUsd: 0 })), getCapUsd: vi.fn(async () => 0), recordAskUsage: vi.fn() }));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import { POST } from "@/app/api/knowledge/ingest/route";
import { resetKnowledgeIndex } from "@/lib/knowledgeIngest";
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

/** Every call `<callee>(…)` inside `node`, in source order. */
function calls(node: ts.Node, callee: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(source) === callee) out.push(n);
    n.forEachChild(walk);
  };
  walk(node);
  return out.sort((a, b) => a.getStart(source) - b.getStart(source));
}

/** Every `out.errors.push(…)` argument inside `node`. */
const errorPushes = (node: ts.Node): ts.Expression[] => calls(node, "out.errors.push").flatMap((c) => [...c.arguments]);

/** A message as it reads at run time, with each `${…}` filled by a stand-in
 *  (the dynamic parts — the document id, the failed steps — come before the
 *  mark, and the mark itself is literal text). Null for anything that is not
 *  a string or template literal. */
function rendered(e: ts.Expression): string | null {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => `«${s.expression.getText(source)}»${s.literal.text}`).join("");
  return null;
}
const marked = (e: ts.Expression): boolean => RESET_WITH_LEFTOVERS.test(rendered(e) ?? e.getText(source));

/** Whether the message names the leftovers list (`left`) — the reset-with-
 *  leftovers report, as opposed to a document the reset could not reset. */
const namesLeftovers = (e: ts.Expression): boolean => {
  let hit = false;
  const walk = (n: ts.Node) => { if (ts.isIdentifier(n) && n.text === "left") hit = true; n.forEachChild(walk); };
  walk(e);
  return hit;
};

describe("RESET_WITH_LEFTOVERS is the engine's own wording (source)", () => {
  const reset = fn("resetKnowledgeIndex");
  const pushes = errorPushes(reset);

  it("every message resetKnowledgeIndex pushes for a document it reset with leftovers matches; every other one does not", () => {
    const leftovers = pushes.filter(namesLeftovers);
    const others = pushes.filter((e) => !namesLeftovers(e));
    expect(leftovers.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    for (const e of leftovers) {
      expect(rendered(e), e.getText(source)).not.toBeNull();
      expect(marked(e), e.getText(source)).toBe(true);
    }
    for (const e of others) expect(marked(e), e.getText(source)).toBe(false);
  });

  it("once a document is counted reset, every message pushed for it carries the mark — and none before it does", () => {
    // The per-document loop, and the one place it counts a document reset.
    const resetPushes = calls(reset, "out.reset.push");
    expect(resetPushes.map((c) => c.getText(source))).toEqual(["out.reset.push(id)"]);
    const at = resetPushes[0].getStart(source);
    let loop: ts.Node = resetPushes[0];
    while (!ts.isForOfStatement(loop)) loop = loop.parent;
    const inLoop = errorPushes(loop);
    const after = inLoop.filter((e) => e.getStart(source) > at);
    const before = inLoop.filter((e) => e.getStart(source) < at);
    expect(after.length).toBeGreaterThan(0);
    for (const e of after) expect(marked(e), `after out.reset.push(id): ${e.getText(source)}`).toBe(true);
    for (const e of before) expect(marked(e), `before out.reset.push(id): ${e.getText(source)}`).toBe(false);
    // Every push of the function is in that loop.
    expect(inLoop.length).toBe(pushes.length);
  });

  it("no other string in the engine carries the mark — the leftovers report is the only message that does", () => {
    const leftoverNodes = new Set(pushes.filter(namesLeftovers));
    const carriers: string[] = [];
    const walk = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
        if (RESET_WITH_LEFTOVERS.test(rendered(n as ts.Expression) ?? "") && !leftoverNodes.has(n as ts.Expression)) {
          carriers.push(n.getText(source));
        }
        return;
      }
      n.forEachChild(walk);
    };
    walk(source);
    expect(carriers).toEqual([]);
  });

  it("the route's reindex reports only what resetKnowledgeIndex reported (reindexLibraryChunks adds no message of its own)", () => {
    expect(errorPushes(fn("reindexLibraryChunks")).map((e) => e.getText(source))).toEqual(["...res.errors"]);
  });
});

// ── 2. Through the real route, and how the client files it ──────────────

const DOC = "kd-1";
const row = (over: Row = {}): Row => ({
  id: DOC, org_id: "o1", library_id: "kl-1", name: "spec.pdf", file_key: "orgs/o1/spec.pdf",
  status: "ready", pages_indexed: 3, page_count: 3, last_section: null, created_by: "u-ctrl", created_at: "2026-09-01",
  error: null, source_id: null, source_document_id: null, source_version_id: null, source_rev: null,
  vision_pages: 2, empty_pages: 0, vision_failed_pages: [], vision_partial_accepted: false, chunk_version: 1,
  vision_retry_after: null, vision_retry_tried: [], ingest_failures: 0, ingest_claimed_by: null, ingest_claimed_at: null,
  ...over,
});
const seed = () => resetDb({
  org_members: [{ org_id: "o1", uid: "u-ctrl", role: "Viewer", roles: ["Viewer", "DocCtrl"], status: "active" }],
  knowledge_libraries: [{ id: "kl-1", org_id: "o1", name: "Specs", chunk_version: 1, ai_features: {} }],
  knowledge_documents: [row()],
  knowledge_chunks: [1, 2, 3].map((p) => ({ id: `c${p}`, document_id: DOC, org_id: "o1", library_id: "kl-1", page: p, seq: 0, content: `page ${p}` })),
  knowledge_page_entities: [{ id: "e1", document_id: DOC, org_id: "o1", library_id: "kl-1", page: 1, kind: "equipment", tag: "P-101" }],
  entity_mentions: [],
  ai_connections: [],
  audit_logs: [],
});
const failing = (table: string, kind: Op["kind"], when: (op: Op) => boolean = () => true) =>
  db.hooks.push((op) => (op.table === table && op.kind === kind && when(op)
    ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined));
const rowUpdate = (op: Op) => (op.payload as Record<string, unknown> | undefined)?.status === "stale";

/** Every reindex body the client posted, and the route's answers. */
let posted: Array<Record<string, unknown>> = [];
let answered: Array<{ status: number; body: Record<string, unknown> }> = [];

beforeEach(() => {
  seed();
  posted = []; answered = [];
  // The client's fetch IS the route: each POST is handed to its handler.
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    posted.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
    const res = await POST(new NextRequest(new URL(url, "http://x"), {
      method: init.method, headers: init.headers, body: init.body,
    }));
    answered.push({ status: res.status, body: await res.clone().json() as Record<string, unknown> });
    return res;
  }));
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
    failing("knowledge_documents", "update", rowUpdate);
    const out = await resetKnowledgeIndex([DOC]);
    expect(out.reset).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(RESET_WITH_LEFTOVERS.test(out.errors[0]), out.errors[0]).toBe(false);
  });

  it("through the real route: a document reset with part of its old index left is filed as a leftover, never as an error", async () => {
    failing("knowledge_chunks", "delete");
    const out = await runTableAwareReindex("kl-1");
    expect(posted).toEqual([{ action: "reindex", libraryId: "kl-1", chunker: 2 }]);
    expect(answered[0].status).toBe(207);
    expect(answered[0].body).toMatchObject({ reset: 1, remaining: 0 });
    expect(out).toMatchObject({ reset: 1, errors: [], stopped: null });
    expect(out.leftovers).toHaveLength(1);
    expect(out.leftovers[0]).toMatch(new RegExp(`^${DOC}: chunks: canceling statement due to statement timeout `));
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "stale", pages_indexed: 0 });
  });

  it("through the real route: a document the reset could not reset is filed as an error, never as a leftover", async () => {
    failing("knowledge_documents", "update", rowUpdate);
    const out = await runTableAwareReindex("kl-1");
    expect(answered[0].status).toBe(207);
    expect(answered[0].body).toMatchObject({ reset: 0, remaining: 1 });
    expect(out).toMatchObject({ reset: 0, leftovers: [], remaining: 1, stopped: null });
    expect(out.errors).toEqual([`${DOC}: row: canceling statement due to statement timeout`]);
    expect(rowsOf("knowledge_documents")[0]).toMatchObject({ status: "ready", pages_indexed: 3 });
  });
});
