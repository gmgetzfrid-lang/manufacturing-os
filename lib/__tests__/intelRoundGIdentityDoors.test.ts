// intelligence Round G, package I-12 review fix — KACL-9 done-when 3, "a test
// per door", for the three IDENTITY doors (find_documents, the orchestrator's
// show-me chips, the link proposer). Each keeps its SQL pre-filter
// (`.eq("ai_excluded", false)`, the column is NOT NULL) and asks
// lib/aiBoundary aiReadability by name; with the pre-filter in place the
// named check never sees a held-back row, so a source pin proved only text.
// These drive each door through a stand-in that does NOT apply the SQL
// filter, and assert the held-back row is still dropped — by aiReadability.
//
// find_documents and the chips run the real tools / the real route over the
// in-memory PostgREST stand-in (./knowledgeFakeDb) with a hook that drops
// the ai_excluded filter from every documents read; the proposer runs over
// helpers/fakeSupabase behind a wrapper that ignores the same filter.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { db, resetDb } from "./knowledgeFakeDb";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

const net = vi.hoisted(() => ({
  script: [] as string[],
  users: { dc: "u-dc" } as Record<string, string>,
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const { fakeAdmin } = await import("./knowledgeFakeDb");
  return {
    supabaseAdmin: {
      from: fakeAdmin.from,
      rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } }),
      auth: {
        getUser: async (token: string) => (net.users[token]
          ? { data: { user: { id: net.users[token] } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } }),
      },
    },
  };
});
vi.mock("@/lib/ai/providerCall", () => ({
  callAiModel: vi.fn(async () => ({ text: net.script.shift() ?? "Done.", usage: { inputTokens: 1, outputTokens: 1 } })),
  AiCallError: class AiCallError extends Error { status = 502; },
}));
vi.mock("@/lib/ai/usageServer", () => ({
  getMonthUsage: vi.fn(async () => ({ spentUsd: 0, inputTokens: 0, outputTokens: 0, asks: 0 })),
  getCapUsd: vi.fn(async () => 0),
  recordAskUsage: vi.fn(async () => undefined),
  reserveWithinCap: vi.fn(async () => ({ id: "reservation-1", reservedUsd: 0.01 })),
  settleUsage: vi.fn(async () => true),
  holdUsage: vi.fn(async () => true),
  releaseUsage: vi.fn(async () => undefined),
  ORCHESTRATOR_ROUND_OP: "orchestratorRound",
}));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/answerSkillsServer", () => ({ loadAnswerSkillsBlock: vi.fn(async () => ""), loadAnswerSkills: vi.fn(async () => ({ block: "", skills: [] })) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => {}), logRevisionEvent: vi.fn(async () => {}), logHoldEvent: vi.fn(async () => {}) }));

import { POST as runPOST } from "@/app/api/orchestrator/route";
import { toolByName, type ToolContext } from "@/lib/orchestrator/tools";
import { runLinkProposers } from "@/lib/linkProposerServer";
import type { KnowledgePrincipal } from "@/lib/knowledgeAccess";

const ORG = "o1";

/** The stand-in's documents reads no longer apply `.eq("ai_excluded", …)` —
 *  what a door sees when its SQL pre-filter is gone. */
function dropAiExcludedFilter(): void {
  db.hooks.push((op, filters) => {
    if (op.table !== "documents") return;
    for (let i = filters.length - 1; i >= 0; i -= 1) if (filters[i].col === "ai_excluded") filters.splice(i, 1);
  });
}

function seed(): void {
  resetDb({
    org_members: [
      { org_id: ORG, uid: "u-dc", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active", display_name: "Dana Control", email: "dana@example.com" },
    ],
    team_members: [], teams: [], collections: [],
    libraries: [{ id: "L-ops", org_id: ORG, name: "Operations", acl: null, visibility: "normal", owner_user_id: null, owner_team_id: null }],
    documents: [
      { id: "d-open", org_id: ORG, library_id: "L-ops", collection_id: null, document_number: "025-PID-0103", title: "P&ID 0103", rev: "C", acl: null, visibility: "normal", is_private: false, scope: null, created_by: "u-dc", owner_user_id: null, status: "Issued", ai_excluded: false, archived_at: null, current_version_id: "v1", updated_at: "2026-10-01T00:00:00Z" },
      { id: "d-held", org_id: ORG, library_id: "L-ops", collection_id: null, document_number: "025-PID-0999", title: "P&ID 0999", rev: "B", acl: null, visibility: "normal", is_private: false, scope: null, created_by: "u-dc", owner_user_id: null, status: "Issued", ai_excluded: true, archived_at: null, current_version_id: "v9", updated_at: "2026-10-02T00:00:00Z" },
    ],
    ai_connections: [{ org_id: ORG, user_id: "u-dc", provider: "anthropic", model: "test-model", api_key: "sealed" }],
    ai_key_agreements: [{ id: "ag1", org_id: ORG, user_id: "u-dc", scope: "use", agreement_version: AGREEMENT_VERSION }],
    knowledge_documents: [],
    drawing_audit_logs: [],
    audit_logs: [],
    orchestrator_proposals: [],
  });
}

const principal: KnowledgePrincipal = { uid: "u-dc", orgId: ORG, role: "Requester" as never, roles: ["Requester" as never, "DocCtrl" as never], isController: true, teamIds: [] };
const ctx = (): ToolContext => ({ orgId: ORG, userId: "u-dc", role: "Requester", principal, actorName: "Dana Control", approved: new Set() });

beforeEach(() => {
  seed();
  net.script = [];
});

describe("KACL-9 done-when 3 (I-12 review fix) — find_documents drops a held-back row by aiReadability, not only by its SQL pre-filter", () => {
  // The stand-in does not model ilike inside or() (the finder's text match);
  // both fixture rows match "PID", so the text filter is dropped for them.
  beforeEach(() => {
    db.hooks.push((op, filters) => {
      if (op.table !== "documents") return;
      for (let i = filters.length - 1; i >= 0; i -= 1) if (filters[i].op === "or") filters.splice(i, 1);
    });
  });
  const found = async () => ((await toolByName("find_documents")!.run({ query: "PID" }, ctx())).data as { matches: Array<{ document_id: string }> })
    .matches.map((m) => m.document_id);
  it("with the pre-filter in place, only the open document is found", async () => {
    expect(await found()).toEqual(["d-open"]);
  });
  it("with the pre-filter gone (the stand-in returns the held-back row), aiReadability still drops it", async () => {
    dropAiExcludedFilter();
    const docsRead = db.ops.length;
    expect(await found()).toEqual(["d-open"]);
    // the query still asks for the pre-filter (the review fix kept it) — the
    // stand-in is what dropped it (db.ops records a statement before hooks)
    expect(db.ops.slice(docsRead).some((o) => o.table === "documents" && o.filters.some((f) => f.col === "ai_excluded" && f.value === false))).toBe(true);
  });
  it("a superseded document is still found (identity, not text — only held_back binds here)", async () => {
    db.tables.documents[0].status = "Superseded";
    expect(await found()).toEqual(["d-open"]);
  });
});

describe("KACL-9 done-when 3 (I-12 review fix) — the orchestrator's show-me chips drop a held-back document by aiReadability", () => {
  async function chips(): Promise<string[]> {
    net.script = ["The sheets are 025-PID-0999 and 025-PID-0103."];
    const res = await runPOST(new NextRequest("http://test/api/orchestrator", {
      method: "POST",
      headers: { authorization: "Bearer dc", "content-type": "application/json" },
      body: JSON.stringify({ orgId: ORG, question: "which sheets?" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { mentionedDocs?: Array<{ id: string }> };
    return (body.mentionedDocs ?? []).map((d) => d.id);
  }
  it("with the pre-filter in place, only the open document becomes a chip", async () => {
    expect(await chips()).toEqual(["d-open"]);
  });
  it("with the pre-filter gone, the held-back document named in the answer is still no chip", async () => {
    dropAiExcludedFilter();
    expect(await chips()).toEqual(["d-open"]);
  });
});

describe("KACL-9 done-when 3 (I-12 review fix) — the link proposer drops a held-back document by aiReadability", () => {
  /** helpers/fakeSupabase behind a wrapper whose documents reads ignore
   *  `.eq("ai_excluded", …)`. */
  function blind(client: ReturnType<typeof makeFakeSupabase>): SupabaseClient {
    const wrap = (b: Record<string, unknown>): Record<string, unknown> => new Proxy(b, {
      get(target, prop: string) {
        const v = target[prop];
        if (prop === "then" || typeof v !== "function") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        return (...args: unknown[]) => {
          if (prop === "eq" && args[0] === "ai_excluded") return wrap(target);
          const out = (v as (...a: unknown[]) => unknown).apply(target, args);
          return out === target ? wrap(target) : out;
        };
      },
    });
    return { ...client, from: (t: string) => (t === "documents" ? wrap(client.from(t) as never) : client.from(t)) } as unknown as SupabaseClient;
  }
  function world(): FakeDb {
    const f = newFakeDb();
    f.unique = { proposed_links: [["document_id", "target_document_id", "proposer"]], document_related_resources: [["document_id", "target_document_id"]] };
    const t = (n: string) => (f.tables[n] ??= []);
    const doc = (id: string, num: string, held = false): Row => ({ id, org_id: ORG, document_number: num, rev: "1", ai_excluded: held });
    // two open documents numbered P-13 (so the reference is a proposal for
    // review, not one provable link) and a held-back one numbered the same
    t("documents").push(doc("sheet", "P-12"), doc("b-open", "P-13"), doc("b-open2", "P-13"), doc("b-held", "P-13", true));
    // the sheet's mirror page refers to P-13 (an off-page connector)
    t("knowledge_documents").push({ id: "k-sheet", org_id: ORG, source_document_id: "sheet" });
    t("knowledge_page_entities").push({ id: "e-1", org_id: ORG, document_id: "k-sheet", kind: "ref", tag: "P-13", raw: null, page: 1 });
    return f;
  }
  /** Every document a proposal links the sheet to (a pair is stored in
   *  either direction). */
  const targets = (f: FakeDb) => [...new Set((f.tables.proposed_links ?? [])
    .flatMap((r) => [r.document_id, r.target_document_id]).filter((id) => id !== "sheet"))].sort();
  it("with the pre-filter in place, the held-back target is never proposed", async () => {
    const f = world();
    await runLinkProposers(makeFakeSupabase(f) as unknown as SupabaseClient, ORG);
    expect(targets(f)).toEqual(["b-open", "b-open2"]);
  });
  it("with the pre-filter gone (the read returns the held-back row), aiReadability still keeps it out", async () => {
    const f = world();
    await runLinkProposers(blind(makeFakeSupabase(f)), ORG);
    expect(targets(f)).toEqual(["b-open", "b-open2"]);
    // the wrapper swallowed the pre-filter, so the stand-in's documents read never applied it
    expect(f.calls.some((c) => c.table === "documents" && c.method === "eq" && c.args[0] === "ai_excluded")).toBe(false);
    expect(f.calls.some((c) => c.table === "documents" && c.method === "select")).toBe(true);
  });
});
