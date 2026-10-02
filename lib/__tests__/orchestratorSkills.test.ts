// intelligence Round G, I-20 — IRLS-13 done-when 2, the orchestrator half.
// /api/orchestrator reads its Reasoning Skills through loadAnswerSkills
// (lib/answerSkillsServer.ts) — the same reads, seeding and author rule as
// loadAnswerSkillsBlock — so the packs that rode the run's prompt come back
// on the response as `skills` ({ id, name, builtinKey }, in the order they
// rode), exactly as the ask route returns them. No pack, no field.
//
// REGRESSION: the prompt the model is given is byte-for-byte the one it was
// given before (instructions + skills block + atlas), and a run with no pack
// answers with exactly the keys it answered with before.
//
// Driven through the real route, the real loop and the real tools over the
// in-memory PostgREST stand-in (./knowledgeFakeDb); the provider is a
// scripted model, the meter / key vault / instruction block are stubs and
// the skills loader is scripted (its own reads are pinned in
// skillsAuthority.test.ts and askRouteUnits.test.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { resetDb } from "./knowledgeFakeDb";
import { AGREEMENT_VERSION } from "@/lib/ai/pricing";

const net = vi.hoisted(() => ({
  script: [] as string[],
  systems: [] as string[],
  users: { dc: "u-dc" } as Record<string, string>,
}));
const skills = vi.hoisted(() => ({
  value: { block: "", skills: [] as Array<{ id: string | null; name: string; builtinKey: string | null }> },
  loadAnswerSkills: vi.fn(),
  loadAnswerSkillsBlock: vi.fn(),
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
  callAiModel: vi.fn(async (input: { system: string; user: string }) => {
    net.systems.push(input.system);
    const text = net.script[Math.min(net.systems.length - 1, net.script.length - 1)] ?? "Done.";
    return { text, usage: { inputTokens: 1, outputTokens: 1 } };
  }),
  AiCallError: class AiCallError extends Error { status = 502; },
}));
vi.mock("@/lib/ai/usageServer", () => ({
  getMonthUsage: vi.fn(async () => ({ spentUsd: 0, inputTokens: 0, outputTokens: 0, asks: 0 })),
  getCapUsd: vi.fn(async () => 0),
  recordAskUsage: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "\n\nORG INSTRUCTIONS BLOCK") }));
vi.mock("@/lib/answerSkillsServer", () => ({
  loadAnswerSkills: skills.loadAnswerSkills,
  loadAnswerSkillsBlock: skills.loadAnswerSkillsBlock,
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => {}), logRevisionEvent: vi.fn(async () => {}), logHoldEvent: vi.fn(async () => {}) }));

import { POST } from "@/app/api/orchestrator/route";
import { atlasForPrompt } from "@/lib/featureAtlas";

const ORG = "o1";
const PACKS = [
  { id: "s-rv", name: "Relief valve reasoning", builtinKey: null },
  { id: "s-std", name: "Standards first", builtinKey: "standards_first" },
];
const BLOCK = "\n\nREASONING SKILLS — test block\n<<<ORG SKILLS\n### Skill: Relief valve reasoning\n…\nORG SKILLS>>>";

function seed(): void {
  resetDb({
    org_members: [
      { org_id: ORG, uid: "u-dc", role: "Requester", roles: ["Requester", "DocCtrl"], status: "active", display_name: "Dana Control", email: "dana@example.com" },
    ],
    team_members: [], teams: [], collections: [], libraries: [], documents: [], knowledge_documents: [],
    ai_connections: [{ org_id: ORG, user_id: "u-dc", provider: "anthropic", model: "test-model", api_key: "sealed" }],
    ai_key_agreements: [{ id: "ag1", org_id: ORG, user_id: "u-dc", scope: "use", agreement_version: AGREEMENT_VERSION }],
    audit_logs: [], orchestrator_proposals: [],
  });
}
const ask = async () => {
  const res = await POST(new NextRequest("http://test/api/orchestrator", {
    method: "POST",
    headers: { authorization: "Bearer dc", "content-type": "application/json" },
    body: JSON.stringify({ orgId: ORG, question: "Do we have any standards about pipe supports?" }),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

beforeEach(() => {
  seed();
  net.script = ["No documents mention pipe supports."];
  net.systems = [];
  skills.loadAnswerSkills.mockReset();
  skills.loadAnswerSkillsBlock.mockReset();
  skills.loadAnswerSkills.mockImplementation(async () => skills.value);
  skills.loadAnswerSkillsBlock.mockImplementation(async () => skills.value.block);
});

describe("IRLS-13 — the orchestrator says which Reasoning Skills shaped its answer", () => {
  it("reproduction → fix: the packs that rode the prompt come back as `skills`, in the order they rode, from loadAnswerSkills", async () => {
    skills.value = { block: BLOCK, skills: PACKS };
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body.skills).toEqual(PACKS);
    expect(skills.loadAnswerSkills).toHaveBeenCalledWith(expect.anything(), ORG, "u-dc");
    expect(skills.loadAnswerSkillsBlock).not.toHaveBeenCalled();
    // the block those packs came from is the one the model was given
    expect(net.systems[0]).toContain(BLOCK);
  });

  it("REGRESSION: the model's prompt carries the instructions, the skills block and the atlas, in that order, as before", async () => {
    skills.value = { block: BLOCK, skills: PACKS };
    await ask();
    const playbook = "\n\nORG INSTRUCTIONS BLOCK" + BLOCK + atlasForPrompt();
    // the loop seats the playbook, trimmed, under SITE INSTRUCTIONS (lib/orchestrator/loop.ts)
    expect(net.systems[0]).toContain(`SITE INSTRUCTIONS\n${playbook.trim()}`);
  });

  it("REGRESSION: no pack, no field — the response answers with exactly the keys it answered with before", async () => {
    skills.value = { block: "", skills: [] };
    const { status, body } = await ask();
    expect(status).toBe(200);
    expect(body.skills).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(["answer", "budget", "model", "pending", "provider", "steps", "stoppedBecause"]);
    expect(body.answer).toBe("No documents mention pipe supports.");
  });
});
