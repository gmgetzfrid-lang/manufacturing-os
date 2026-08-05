// The parser is where agent systems actually fail. Not "the model reasoned
// badly" — "the model emitted something almost-JSON and we ran it anyway", or
// "we showed the user a raw JSON blob and called it an answer".
//
// The bias throughout is: when in doubt, refuse. A rejected turn costs one
// retry. A misparsed turn checks out the wrong document.

import { describe, it, expect } from "vitest";
import {
  parseTurn, extractJsonBlock, validateParams, isRepeatCall,
  type ToolCall, type ParamSpec,
} from "@/lib/orchestrator/protocol";

const TOOLS = new Set(["search_documents", "checkout_document", "trace_pid_lines"]);

describe("extractJsonBlock", () => {
  it("finds the object inside prose and fences", () => {
    const wrapped = 'Sure, here you go:\n```json\n{"tool_name":"search_documents"}\n```\nHope that helps.';
    expect(extractJsonBlock(wrapped)).toBe('{"tool_name":"search_documents"}');
  });

  it("survives braces inside string values", () => {
    // A regex for /{.*}/ eats this alive, and line ids really do contain them.
    const raw = '{"tool_name":"search_documents","parameters":{"query":"line {L-44-098} spec"}}';
    expect(extractJsonBlock(raw)).toBe(raw);
  });

  it("survives escaped quotes inside string values", () => {
    const raw = '{"tool_name":"x","parameters":{"q":"the \\"north\\" exchanger"}}';
    expect(extractJsonBlock(raw)).toBe(raw);
  });

  it("returns null for truncated output rather than a broken fragment", () => {
    expect(extractJsonBlock('{"tool_name":"search_documents","parameters":{')).toBeNull();
  });

  it("returns null when there's no object at all", () => {
    expect(extractJsonBlock("There are four standards covering pipe supports.")).toBeNull();
  });
});

describe("parseTurn", () => {
  it("reads a well-formed call", () => {
    const r = parseTurn('{"tool_name":"search_documents","parameters":{"query":"pipe supports"}}', TOOLS);
    expect(r.kind).toBe("call");
    if (r.kind === "call") {
      expect(r.call.tool).toBe("search_documents");
      expect(r.call.parameters.query).toBe("pipe supports");
    }
  });

  it("accepts the spellings models reach for unprompted", () => {
    for (const raw of [
      '{"tool":"search_documents","arguments":{"query":"x"}}',
      '{"name":"search_documents","params":{"query":"x"}}',
    ]) {
      expect(parseTurn(raw, TOOLS).kind).toBe("call");
    }
  });

  it("treats plain prose as the final answer", () => {
    const r = parseTurn("You have four standards covering pipe supports.", TOOLS);
    expect(r.kind).toBe("answer");
  });

  it("refuses a tool nobody implemented instead of guessing", () => {
    const r = parseTurn('{"tool_name":"delete_everything","parameters":{}}', TOOLS);
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.reason).toMatch(/No tool named/);
  });

  it("refuses malformed JSON that was clearly meant as a call", () => {
    // Not prose with a stray brace — a real attempt that didn't parse. Showing
    // this to a user as an "answer" is the failure this test exists to stop.
    const r = parseTurn('{"tool_name":"search_documents", parameters:{}}', TOOLS);
    expect(r.kind).toBe("invalid");
  });

  it("treats prose that merely quotes JSON as an answer", () => {
    const raw = 'The config we store looks like {"tool_name": broken} — that\'s why the import failed, '
      + 'and you should fix the exporter before re-running the load.';
    expect(parseTurn(raw, TOOLS).kind).toBe("answer");
  });

  it("rejects non-object parameters", () => {
    const r = parseTurn('{"tool_name":"search_documents","parameters":"pipe supports"}', TOOLS);
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.reason).toMatch(/must be a JSON object/);
  });

  it("treats a JSON object that isn't a call as an answer", () => {
    expect(parseTurn('{"summary":"four standards found"}', TOOLS).kind).toBe("answer");
  });

  it("defaults missing parameters to an empty object", () => {
    const r = parseTurn('{"tool_name":"search_documents"}', TOOLS);
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.call.parameters).toEqual({});
  });

  it("refuses an empty turn", () => {
    expect(parseTurn("   ", TOOLS).kind).toBe("invalid");
  });
});

describe("validateParams", () => {
  const specs: ParamSpec[] = [
    { name: "query", type: "string", required: true, description: "" },
    { name: "limit", type: "number", description: "" },
    { name: "confirm", type: "boolean", description: "" },
  ];

  it("passes a clean call through, trimmed", () => {
    const r = validateParams({ query: "  pipe supports " }, specs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.query).toBe("pipe supports");
  });

  it("names the missing required parameter", () => {
    const r = validateParams({ limit: 5 }, specs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/"query"/);
  });

  it("treats empty string as missing, because a model sends it for 'unknown'", () => {
    expect(validateParams({ query: "" }, specs).ok).toBe(false);
  });

  it("accepts a quoted number, because models quote numbers constantly", () => {
    const r = validateParams({ query: "x", limit: "10" }, specs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.limit).toBe(10);
  });

  it("refuses a word where a number belongs rather than reading it as zero", () => {
    const r = validateParams({ query: "x", limit: "ten" }, specs);
    expect(r.ok).toBe(false);
  });

  it("accepts quoted booleans and refuses everything else", () => {
    expect(validateParams({ query: "x", confirm: "true" }, specs).ok).toBe(true);
    expect(validateParams({ query: "x", confirm: "yes" }, specs).ok).toBe(false);
  });

  it("drops parameters the tool never declared", () => {
    const r = validateParams({ query: "x", rm: "-rf" }, specs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.rm).toBeUndefined();
  });
});

describe("isRepeatCall", () => {
  const call = (tool: string, parameters: Record<string, unknown>): ToolCall => ({ tool, parameters });

  it("catches the same call fired twice in a row", () => {
    const history = [call("search_documents", { query: "pipe supports" })];
    expect(isRepeatCall(history, call("search_documents", { query: "pipe supports" }))).toBe(true);
  });

  it("allows the same tool with different parameters", () => {
    const history = [call("search_documents", { query: "pipe supports" })];
    expect(isRepeatCall(history, call("search_documents", { query: "hangers" }))).toBe(false);
  });

  it("allows a repeat that isn't consecutive — that's a real refinement loop", () => {
    const history = [
      call("search_documents", { query: "pipe supports" }),
      call("trace_pid_lines", { start_tag: "E-101" }),
    ];
    expect(isRepeatCall(history, call("search_documents", { query: "pipe supports" }))).toBe(false);
  });

  it("is false on an empty history", () => {
    expect(isRepeatCall([], call("search_documents", {}))).toBe(false);
  });
});
