// intelligence Round G, I-29 KNOWLEDGE VIEWER KEYS AND PICKER READS — the
// integrator's DEC-90 ruling (3) at the I-29 merge (2026-10-20): KACL-7
// criterion 3's remainder, built.
//
//   /api/knowledge/ask's named-document chips (mentionedDocs) no longer hand
//   the browser a SOURCE-LINKED mirror's file_key: a mirror's chip carries
//   its id, a null key and its revision (non-secret), and the knowledge page
//   opens it through /api/knowledge/mirror-url exactly as the viewer opens a
//   citation (the route's same-reader parity is pinned in
//   intelRoundGMirrorViewerKeys.test.ts). A direct upload's chip keeps its
//   current fields, exactly. (The locate route's "where else" jumps are
//   pinned in intelRoundGDrawingRoutes.test.ts.)
//
// The route runs for real over askRouteHarness (the in-memory database, the
// real ACL seam and gate stack); the provider is scripted.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetDb, type Row } from "./knowledgeFakeDb";
import { resetHarness, baseTables, kdoc, kchunk, dcDoc, h, ORG, LIB, DENY_VIEWER_ACL } from "./askRouteHarness";

vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./askRouteHarness")).adminStandIn }));
vi.mock("@/lib/ai/providerCall", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/providerCall")>()),
  callAiModel: vi.fn(async (input: { system: string; user: string; maxTokens?: number; images?: unknown[] }) =>
    (await import("./askRouteHarness")).scriptedCall(input)),
}));
vi.mock("@/lib/ai/embeddings", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/embeddings")>();
  const harness = await import("./askRouteHarness");
  return {
    ...real,
    embedPassages: vi.fn(async (req: { provider: string; model: string; passages: readonly string[] }) => harness.scriptedEmbed(req)),
    embedQuery: vi.fn(async (provider: string, model: string, _key: string, q: string) =>
      (await harness.scriptedEmbed({ provider, model, passages: [q] })).vectors[0]),
  };
});
vi.mock("@/lib/knowledgePageRender", () => ({ renderKnowledgePages: vi.fn(async () => []), MAX_DEEP_READ_PAGES: 6 }));
vi.mock("@/lib/codebookServer", async () => ({
  loadCodebookAdmin: vi.fn(async () => ({ legendDocIds: (await import("./askRouteHarness")).h.legendDocIds })),
  codebookToDecoderText: () => "",
}));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/answerSkillsServer", async () => {
  const harness = await import("./askRouteHarness");
  return {
    loadAnswerSkillsBlock: vi.fn(async () => harness.h.skills.block),
    loadAnswerSkills: vi.fn(async () => harness.h.skills),
  };
});
vi.mock("@/lib/knowledgeTagResolve", () => ({ resolveTagAgainstIndex: vi.fn(async (_o: string, t: string) => ({ resolved: t })) }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string | null) => k }));

import { POST } from "@/app/api/knowledge/ask/route";

const ask = (body: Record<string, unknown>, token = "viewer") => POST(new NextRequest("http://x/api/knowledge/ask", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ orgId: ORG, libraryId: LIB, ...body }),
}));

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const K_UPLOAD = U(11);
const K_MIRROR = U(12);
const UPLOAD_KEY = `orgs/${ORG}/knowledge/${K_UPLOAD}.pdf`;
const MIRROR_KEY = `orgs/${ORG}/libraries/dc/INC-0042-rev-B.pdf`;

const QUERY_GEN = { text: '["relief valve set pressure"]', usage: { inputTokens: 300, outputTokens: 20 } };
const REFINE_NONE = { text: '{"queries": [], "missing_documents": []}', usage: { inputTokens: 500, outputTokens: 15 } };
const ANSWER = {
  text: "**Answer:** The set pressure must not exceed the design pressure per STD-100 [1]; the trip is recorded in INC-0042 [2].",
  usage: { inputTokens: 4000, outputTokens: 120 },
};

function seed(dcOver: Row = {}) {
  const t = baseTables();
  resetDb({
    ...t,
    documents: [dcDoc("dc-1", dcOver)],
    knowledge_documents: [
      kdoc(K_UPLOAD, { name: "STD-100 Relief standard.pdf", file_key: UPLOAD_KEY }),
      kdoc(K_MIRROR, {
        name: "INC-0042 — Incident report", file_key: MIRROR_KEY,
        source_document_id: "dc-1", source_version_id: "v-dc-1", source_rev: "B",
      }),
    ],
    knowledge_chunks: [
      kchunk(K_UPLOAD, "The relief valve set pressure shall not exceed the design pressure of the vessel.", { id: "c-0up", page: 4 }),
      kchunk(K_MIRROR, "Incident finding: the relief valve set pressure was verified after the trip.", { id: "c-1mi", page: 2 }),
    ],
  });
}

beforeEach(() => { resetHarness(); });

describe("KACL-7 criterion 3 (DEC-90 ruling (3), I-29 merge) — the ask route's named-document chips never carry a mirror's key", () => {
  it("reproduction → fix: a mirror's chip is its id with a null key (and its revision); the mirror's storage key is nowhere in the answer", async () => {
    seed();
    h.script = [QUERY_GEN, REFINE_NONE, ANSWER];
    const res = await ask({ question: "What is the relief valve set pressure?" });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { mentionedDocs?: Array<Record<string, unknown>> };
    const chip = body.mentionedDocs?.find((d) => d.id === K_MIRROR);
    expect(chip).toEqual({
      id: K_MIRROR, name: "INC-0042 — Incident report", fileKey: null, page: 2, mention: "INC-0042",
      sourceVersionId: "v-dc-1", sourceRev: "B",
    });
    expect(text).not.toContain(MIRROR_KEY);
  });
  it("regression: a direct upload's chip keeps its current fields, exactly (its key opens it as before)", async () => {
    seed();
    h.script = [QUERY_GEN, REFINE_NONE, ANSWER];
    const body = await (await ask({ question: "What is the relief valve set pressure?" })).json() as { mentionedDocs?: Array<Record<string, unknown>> };
    expect(body.mentionedDocs?.find((d) => d.id === K_UPLOAD)).toEqual({
      id: K_UPLOAD, name: "STD-100 Relief standard.pdf", fileKey: UPLOAD_KEY, page: 4, mention: "STD-100",
    });
  });
  it("regression: a mirror the asker may not read is still never a chip (the roster's per-asker decision, unchanged)", async () => {
    seed({ acl: DENY_VIEWER_ACL });
    h.script = [QUERY_GEN, REFINE_NONE, ANSWER];
    const text = await (await ask({ question: "What is the relief valve set pressure?" })).text();
    const body = JSON.parse(text) as { mentionedDocs?: Array<{ id: string }> };
    expect((body.mentionedDocs ?? []).map((d) => d.id)).not.toContain(K_MIRROR);
    expect(text).not.toContain(MIRROR_KEY);
  });
  it("the page opens a chip through the viewer by id — a null key goes to /api/knowledge/mirror-url, an upload's key as before (source pins)", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/knowledge/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/fileKey: d\.fileKey \?\? null, page: d\.page, quote: null, title: d\.name, section: null, documentId: d\.id,/);
    const viewer = readFileSync(join(process.cwd(), "components/knowledge/CitedPageViewer.tsx"), "utf8");
    expect(viewer).toMatch(/const signed = view\.fileKey\s*\n\s*\/\/ SEC-7[^\n]*\n\s*\? getSignedUrlForPath\(view\.fileKey, undefined, \{ inline: true \}\)/);
  });
});
