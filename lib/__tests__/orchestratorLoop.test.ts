// The loop is where an agent stops being a demo. These tests drive whole
// conversations with a scripted model — no network, no key, no provider — so
// the failure modes that only show up in production (a model that loops, a
// model that never stops calling tools, a tool that throws mid-run) are
// ordinary unit tests here.
//
// The one invariant behind most of them: THE USER ALWAYS GETS PROSE. However
// badly the run goes, the thing handed back is an answer, not a JSON dump and
// not silence.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake tools, so the loop is tested against the loop and not against Postgres.
const ranWith: Array<Record<string, unknown>> = [];
let searchImpl: (args: Record<string, unknown>) => Promise<{ data: unknown; pending?: unknown }>;

vi.mock("@/lib/orchestrator/tools", () => {
  const search = {
    name: "search_documents",
    description: "Search text.",
    params: [
      { name: "query", type: "string", required: true, description: "What to look for." },
      { name: "limit", type: "number", description: "Max." },
    ],
    run: (args: Record<string, unknown>) => { ranWith.push(args); return searchImpl(args); },
  };
  const checkout = {
    name: "checkout_document",
    description: "Check out a document.",
    writes: true,
    params: [{ name: "document_id", type: "string", required: true, description: "UUID." }],
    run: async (args: Record<string, unknown>) => ({
      data: { status: "awaiting_confirmation" },
      pending: {
        fingerprint: `checkout_document(document_id=${args.document_id})`,
        tool: "checkout_document", summary: "Check out D-1",
        parameters: args, href: "/documents/lib?doc=D-1",
      },
    }),
  };
  const TOOLS = [search, checkout];
  return {
    TOOLS,
    TOOL_NAMES: new Set(["search_documents", "checkout_document"]),
    toolByName: (n: string) => TOOLS.find((t) => t.name === n),
    toolCatalogue: () => "- search_documents(query: string)\n- checkout_document(document_id: string) [WRITE]",
  };
});

import { runOrchestrator, systemPrompt, type ModelCall } from "@/lib/orchestrator/loop";
import type { ToolContext } from "@/lib/orchestrator/tools";

const CTX: ToolContext = {
  orgId: "org-1", userId: "u-1", role: "DocCtrl", approved: new Set(),
  // SURF-7: the caller's ACL principal rides in the context.
  principal: { uid: "u-1", orgId: "org-1", role: "DocCtrl", roles: ["DocCtrl"], isController: true, teamIds: [] },
  actorName: "Doc Control",
};

/** A model that replies with a fixed script, then repeats its last line. */
function scripted(lines: string[]): ModelCall & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const fn = (async (_system: string, user: string) => {
    prompts.push(user);
    const text = lines[Math.min(i, lines.length - 1)];
    i += 1;
    return { text, usage: { inputTokens: 10, outputTokens: 5 } };
  }) as ModelCall & { prompts: string[] };
  fn.prompts = prompts;
  return fn;
}

const callFor = (query: string) =>
  JSON.stringify({ tool_name: "search_documents", parameters: { query } });

beforeEach(() => {
  ranWith.length = 0;
  searchImpl = async () => ({ data: { passages: [{ document: "STD-14", page: 7, text: "Pipe supports…" }] } });
});

describe("runOrchestrator — the happy path", () => {
  it("calls a tool, then answers from the result", async () => {
    const model = scripted([callFor("pipe supports"), "You have one standard: STD-14, page 7."]);
    const run = await runOrchestrator({ question: "any standards about pipe supports?", ctx: CTX, call: model });

    expect(run.answer).toContain("STD-14");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].tool).toBe("search_documents");
    expect(ranWith[0]).toEqual({ query: "pipe supports" });
  });

  it("feeds the tool result back into the next prompt", async () => {
    const model = scripted([callFor("pipe supports"), "Done."]);
    await runOrchestrator({ question: "q", ctx: CTX, call: model });
    // The second prompt must actually contain the evidence, or the model is
    // answering from nothing while appearing to have researched.
    expect(model.prompts[1]).toContain("STD-14");
    expect(model.prompts[1]).toContain("search_documents");
  });

  it("answers directly when no tool is needed", async () => {
    const model = scripted(["A P&ID is a piping and instrumentation diagram."]);
    const run = await runOrchestrator({ question: "what is a P&ID?", ctx: CTX, call: model });
    expect(run.steps).toHaveLength(0);
    expect(run.answer).toMatch(/piping and instrumentation/);
  });

  it("adds up token usage across every turn", async () => {
    const model = scripted([callFor("x"), "Answer."]);
    const run = await runOrchestrator({ question: "q", ctx: CTX, call: model });
    expect(run.usage.inputTokens).toBe(20);
    expect(run.usage.outputTokens).toBe(10);
  });
});

describe("runOrchestrator — bounding a model that misbehaves", () => {
  it("corrects malformed JSON instead of showing it to the user", async () => {
    const model = scripted(['{"tool_name":"search_documents", parameters:{}}', "Recovered answer."]);
    const run = await runOrchestrator({ question: "q", ctx: CTX, call: model });
    expect(run.answer).toBe("Recovered answer.");
    expect(model.prompts[1]).toMatch(/REJECTED/);
  });

  it("gives up on a model that will never emit valid JSON — with prose, not silence", async () => {
    const model = scripted(['{"tool_name":"search_documents", oops}']);
    const run = await runOrchestrator({ question: "q", ctx: CTX, call: model });
    expect(run.stoppedBecause).toMatch(/malformed/);
    expect(run.answer.length).toBeGreaterThan(0);
    expect(run.answer).not.toMatch(/tool_name/);
  });

  it("refuses to run the same call twice and says why", async () => {
    const model = scripted([callFor("pipe supports"), callFor("pipe supports"), "Fine, here's the answer."]);
    const run = await runOrchestrator({ question: "q", ctx: CTX, call: model });
    expect(ranWith).toHaveLength(1);                       // ran once, not twice
    expect(run.steps[1].error).toMatch(/Repeated/);
    expect(run.answer).toMatch(/here's the answer/);
  });

  it("rejects bad parameters without touching the tool", async () => {
    const model = scripted([
      JSON.stringify({ tool_name: "search_documents", parameters: { limit: 5 } }),   // no query
      "Answered anyway.",
    ]);
    const run = await runOrchestrator({ question: "q", ctx: CTX, call: model });
    expect(ranWith).toHaveLength(0);
    expect(run.steps[0].error).toMatch(/"query"/);
  });

  it("stops at the step budget and still returns an answer", async () => {
    // A model that only ever calls tools, with a fresh query each time so the
    // repeat guard never fires. The budget is the only thing that stops it.
    let n = 0;
    const model: ModelCall = async () => ({ text: callFor(`query ${n++}`) });
    const run = await runOrchestrator({ question: "q", ctx: CTX, call: model, maxSteps: 3 });
    expect(run.steps).toHaveLength(3);
    expect(run.stoppedBecause).toMatch(/limit/);
    expect(run.answer.length).toBeGreaterThan(0);
  });

  it("demands prose on the forced close, and takes it", async () => {
    let n = 0;
    const model: ModelCall = async (_s, user) => {
      if (user.includes("STOP CALLING TOOLS")) return { text: "Closing answer from what I found." };
      return { text: callFor(`q${n++}`) };
    };
    const run = await runOrchestrator({ question: "q", ctx: CTX, call: model, maxSteps: 2 });
    expect(run.answer).toBe("Closing answer from what I found.");
  });
});

describe("runOrchestrator — failures that must not become confident answers", () => {
  it("surfaces a provider error rather than inventing a reply", async () => {
    const model: ModelCall = async () => { throw new Error("Anthropic rejected the API key."); };
    const run = await runOrchestrator({ question: "q", ctx: CTX, call: model });
    expect(run.answer).toMatch(/rejected the API key/);
    expect(run.stoppedBecause).toBe("provider error");
  });

  it("keeps going when a tool throws, and records it", async () => {
    searchImpl = async () => { throw new Error("relation does not exist"); };
    const model = scripted([callFor("x"), "I couldn't search, here's what I know."]);
    const run = await runOrchestrator({ question: "q", ctx: CTX, call: model });
    expect(run.steps[0].error).toMatch(/relation does not exist/);
    expect(model.prompts[1]).toMatch(/That tool failed/);
    expect(run.answer).toMatch(/couldn't search/);
  });

  it("stops on the wall clock without waiting for the step budget", async () => {
    let t = 0;
    const model: ModelCall = async () => { t += 30_000; return { text: callFor(`q${t}`) }; };
    const run = await runOrchestrator({
      question: "q", ctx: CTX, call: model, maxSteps: 10,
      budgetMs: 40_000, now: () => t,
    });
    expect(run.steps.length).toBeLessThan(10);
    expect(run.stoppedBecause).toMatch(/time/);
  });

  it("truncates a huge tool result instead of blowing the context", async () => {
    searchImpl = async () => ({ data: { passages: Array.from({ length: 5000 }, (_, i) => `passage ${i}`) } });
    const model = scripted([callFor("x"), "Answer."]);
    await runOrchestrator({ question: "q", ctx: CTX, call: model });
    expect(model.prompts[1].length).toBeLessThan(10_000);
    expect(model.prompts[1]).toMatch(/truncated/);
  });
});

describe("runOrchestrator — write proposals", () => {
  it("collects a pending action rather than performing it", async () => {
    const model = scripted([
      JSON.stringify({ tool_name: "checkout_document", parameters: { document_id: "D-1" } }),
      "I've asked you to confirm the checkout.",
    ]);
    const run = await runOrchestrator({ question: "check out D-1", ctx: CTX, call: model });
    expect(run.pending).toHaveLength(1);
    expect(run.pending[0].tool).toBe("checkout_document");
    expect(run.pending[0].href).toBe("/documents/lib?doc=D-1");
  });

  it("counts the same proposal once, however many times it's proposed", async () => {
    const propose = JSON.stringify({ tool_name: "checkout_document", parameters: { document_id: "D-1" } });
    // Separated by another call so the repeat guard doesn't swallow the second.
    const model = scripted([propose, callFor("x"), propose, "Done."]);
    const run = await runOrchestrator({ question: "q", ctx: CTX, call: model });
    expect(run.pending).toHaveLength(1);
  });
});

describe("systemPrompt", () => {
  it("lists the real tools, so the manual can't drift from what exists", () => {
    expect(systemPrompt()).toContain("search_documents");
    expect(systemPrompt()).toContain("checkout_document");
  });

  it("folds in the org's own instructions when there are any", () => {
    expect(systemPrompt("Always cite the unit number.")).toContain("Always cite the unit number.");
    expect(systemPrompt()).not.toContain("SITE INSTRUCTIONS");
  });
});
