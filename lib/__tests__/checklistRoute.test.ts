// projects Round G — /api/projects/checklist `assess`: every proposal carries
// the item's CURRENT state so the per-item review can name the proposals
// that target a satisfied or evidence-bearing item (QUAL-5 dw3 / SAF-2),
// and the response shape stays additive (proposals[].itemId / applicability /
// rationale unchanged; `current` and `protectedNaCount` added).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { resetState, type MemoryState } from "./helpers/memoryDb";

const state = vi.hoisted<MemoryState>(() => ({
  tables: {}, calls: [], writes: [], refuse: false, writeError: null, readError: {}, nextId: 1,
}));
const ai = vi.hoisted(() => ({ text: "" as string }));

vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeSupabase } = await import("./helpers/memoryDb");
  const db = makeSupabase(state);
  return { supabaseAdmin: { from: db.from, auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })) } } };
});
vi.mock("@/lib/ai/governedCall", () => ({
  governedAiCall: vi.fn(async () => ({ text: ai.text })),
  GovernedCallError: class extends Error { status = 400; },
}));
vi.mock("@/lib/knowledgePageRender", () => ({ renderKnowledgePages: vi.fn(async () => []) }));
vi.mock("@/lib/docFileServer", () => ({ resolveDocumentFile: vi.fn(async () => null) }));

import { POST } from "@/app/api/projects/checklist/route";

const post = (body: unknown) => POST(new NextRequest("http://x/api/projects/checklist", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));

beforeEach(() => {
  resetState(state);
  state.tables.org_members = [{ org_id: "o1", uid: "u1", status: "active" }];
  state.tables.projects = [{ id: "p1", org_id: "o1", name: "Unit 300 repipe", purpose: null, goals: null, success_criteria: null, job_kind: "standard", sow_document_id: null, intake_collection_id: null }];
  state.tables.project_checklists = [{ id: "cl1", project_id: "p1", title: "PSSR", kind: "pssr" }];
  state.tables.checklist_items = [
    { id: "aaaaaaaa-1", checklist_id: "cl1", seq: 1, section: "Docs", text: "Weld log reviewed", manual_note: null, status: "open", evidence: [] },
    { id: "bbbbbbbb-2", checklist_id: "cl1", seq: 2, section: null, text: "NDE reports on file", manual_note: null, status: "satisfied", evidence: [{ label: "x", source: "auto" }] },
    { id: "cccccccc-3", checklist_id: "cl1", seq: 3, section: null, text: "Ops trained", manual_note: "trained 8/12", status: "open", evidence: [] },
    { id: "dddddddd-4", checklist_id: "cl1", seq: 4, section: null, text: "P&ID redlines", manual_note: null, status: "open", evidence: [{ label: "walked down", source: "manual" }] },
  ];
  state.tables.milestones = []; state.tables.documents = []; state.tables.assets = [];
  ai.text = JSON.stringify({ assessments: [
    { ref: "aaaaaaaa", applicability: "na", rationale: "no welding" },
    { ref: "bbbbbbbb", applicability: "na", rationale: "no NDE" },
    { ref: "cccccccc", applicability: "na", rationale: "no training" },
    { ref: "dddddddd", applicability: "applies", rationale: "P&IDs change" },
    { ref: "zzzzzzzz", applicability: "na", rationale: "unknown ref — dropped" },
  ] });
});

describe("POST /api/projects/checklist — assess", () => {
  it("each proposal carries the item's current state; protectedNaCount names the N/As that target satisfied or evidence-bearing items", async () => {
    const res = await post({ orgId: "o1", projectId: "p1", action: "assess", checklistId: "cl1" });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      proposals: Array<{ itemId: string; applicability: string; rationale: string; current: Record<string, unknown> }>;
      humanDecided: number; protectedNaCount: number;
    };
    expect(body.proposals.map((p) => p.itemId)).toEqual(["aaaaaaaa-1", "bbbbbbbb-2", "cccccccc-3", "dddddddd-4"]);
    expect(body.proposals[0]).toEqual({
      itemId: "aaaaaaaa-1", applicability: "na", rationale: "no welding",
      current: { text: "Weld log reviewed", section: "Docs", status: "open", hasEvidence: false, humanDecided: false, protectedFromDowngrade: false },
    });
    expect(body.proposals[1].current).toMatchObject({ status: "satisfied", hasEvidence: true, protectedFromDowngrade: true });
    expect(body.proposals[2].current).toMatchObject({ humanDecided: true, protectedFromDowngrade: false });
    // a person-attached chip is human territory too — the database refuses a
    // machine-stamped write on it (20261091), so the review locks it
    expect(body.proposals[3].current).toMatchObject({ hasEvidence: true, humanDecided: true, protectedFromDowngrade: true });
    expect(body.humanDecided).toBe(2);
    // only the N/A on the satisfied item counts (the evidence-bearing one is proposed `applies`)
    expect(body.protectedNaCount).toBe(1);
  });

  it("the route never writes — proposals are for review (the human saves)", async () => {
    await post({ orgId: "o1", projectId: "p1", action: "assess", checklistId: "cl1" });
    expect(state.writes).toEqual([]);
  });

  it("refuses a non-member and an unknown checklist", async () => {
    state.tables.org_members = [];
    expect((await post({ orgId: "o1", projectId: "p1", action: "assess", checklistId: "cl1" })).status).toBe(403);
    state.tables.org_members = [{ org_id: "o1", uid: "u1", status: "active" }];
    expect((await post({ orgId: "o1", projectId: "p1", action: "assess", checklistId: "nope" })).status).toBe(404);
  });
});
