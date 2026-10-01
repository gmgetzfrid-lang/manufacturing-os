// intelligence Round G (I-03) — the pure pieces behind /api/knowledge/ask:
// the provider's stop reason and failed-call usage (ASK-3, GOV-8), the paged
// read (KACL-4), the recorded answer context and the team's record
// (ASK-1 / KACL-1 / IEDGE-5), the Reasoning Skills a block carries (IRLS-13),
// migration 20261153's shape, and the answer surface's markers.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callAiModel, AiCallError } from "@/lib/ai/providerCall";
import { readAll, columnMissing } from "@/lib/knowledgeAskGuards";
import { planVisibleHistory, parseAnswerContext, contextKnowledgeDocIds, type StoredAnswerRow } from "@/lib/knowledgeHistory";
import { buildAnswerSkills, buildAnswerSkillsBlock } from "@/lib/answerSkillsServer";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ── ASK-3 / GOV-8 — lib/ai/providerCall ─────────────────────────────────────

describe("ASK-3 / GOV-8 — the provider says why it stopped, and a failed call still carries what it spent", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const stubFetch = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
  const base = { model: "m", apiKey: "k", system: "s", user: "u", maxTokens: 50 };

  it("Anthropic: stop_reason max_tokens with text → truncated: true, stopReason 'max_tokens'; end_turn → 'end'", async () => {
    stubFetch({ stop_reason: "max_tokens", content: [{ type: "text", text: "Partial answer" }], usage: { input_tokens: 10, output_tokens: 50 } });
    const cut = await callAiModel({ provider: "anthropic", ...base });
    expect(cut).toMatchObject({ text: "Partial answer", truncated: true, stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 50 } });
    stubFetch({ stop_reason: "end_turn", content: [{ type: "text", text: "Done" }], usage: { input_tokens: 10, output_tokens: 5 } });
    expect(await callAiModel({ provider: "anthropic", ...base })).toMatchObject({ truncated: false, stopReason: "end" });
  });

  it("OpenAI: finish_reason length → truncated; stop → end", async () => {
    stubFetch({ choices: [{ message: { content: "Partial" }, finish_reason: "length" }], usage: { prompt_tokens: 9, completion_tokens: 50 } });
    expect(await callAiModel({ provider: "openai", ...base })).toMatchObject({ truncated: true, stopReason: "max_tokens" });
    stubFetch({ choices: [{ message: { content: "Whole" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    expect(await callAiModel({ provider: "openai", ...base })).toMatchObject({ truncated: false, stopReason: "end" });
  });

  it("Gemini: finishReason MAX_TOKENS → truncated", async () => {
    stubFetch({ candidates: [{ content: { parts: [{ text: "Partial" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 50 } });
    expect(await callAiModel({ provider: "gemini", ...base })).toMatchObject({ truncated: true, stopReason: "max_tokens" });
  });

  it("GOV-8: a refusal and an empty answer throw AiCallError carrying the tokens the provider reported", async () => {
    stubFetch({ stop_reason: "refusal", content: [], usage: { input_tokens: 1200, output_tokens: 7 } });
    const refused = await callAiModel({ provider: "anthropic", ...base }).catch((e) => e);
    expect(refused).toBeInstanceOf(AiCallError);
    expect(refused).toMatchObject({ status: 422, usage: { inputTokens: 1200, outputTokens: 7 } });
    stubFetch({ stop_reason: "max_tokens", content: [], usage: { input_tokens: 900, output_tokens: 50 } });
    expect(await callAiModel({ provider: "anthropic", ...base }).catch((e) => e)).toMatchObject({ status: 502, usage: { inputTokens: 900, outputTokens: 50 } });
    stubFetch({ choices: [{ message: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 0 } });
    expect(await callAiModel({ provider: "openai", ...base }).catch((e) => e)).toMatchObject({ usage: { inputTokens: 40, outputTokens: 0 } });
  });

  it("an HTTP failure reports no usage (the provider billed nothing it told us about)", async () => {
    stubFetch({ error: "bad key" }, 401);
    const e = await callAiModel({ provider: "openai", ...base }).catch((x) => x);
    expect(e).toBeInstanceOf(AiCallError);
    expect(e.usage).toBeUndefined();
  });

  it("the change is additive: AiCallError's two-argument form and callAiModel's signature are unchanged", () => {
    expect(new AiCallError("x", 400).usage).toBeUndefined();
    expect(src("lib/ai/providerCall.ts")).toMatch(/export async function callAiModel\(input: AiCallInput\): Promise<AiCallResult>/);
  });
});

// ── KACL-4 — readAll ────────────────────────────────────────────────────────

describe("KACL-4 — readAll pages past max-rows and never takes a short page for the last one", () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ i }));
  /** A PostgREST stand-in whose max-rows (300) is below the page asked for. */
  const capped = (from: number, to: number) => Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 300)), error: null });

  it("reads every row though every page comes back short", async () => {
    const out = await readAll<{ i: number }>(capped);
    expect(out.rows).toHaveLength(2500);
    expect(out.capped).toBe(false);
    expect(out.error).toBeNull();
  });

  it("stops past a ceiling and says it did", async () => {
    const out = await readAll<{ i: number }>(capped, 1000);
    expect(out.capped).toBe(true);
    expect(out.rows.length).toBeGreaterThan(1000);
  });

  it("an error is returned with what was read — never taken as the end", async () => {
    let n = 0;
    const out = await readAll<{ i: number }>((from, to) => ++n === 2
      ? Promise.resolve({ data: null, error: { code: "57014", message: "timeout" } })
      : capped(from, to));
    expect(out.error?.code).toBe("57014");
  });

  it("columnMissing knows a database that has not applied a migration", () => {
    expect(columnMissing({ code: "42703", message: 'column "x" does not exist' })).toBe(true);
    expect(columnMissing({ code: "PGRST204", message: "Could not find the 'context' column" })).toBe(true);
    expect(columnMissing({ code: "57014", message: "statement timeout" })).toBe(false);
    expect(columnMissing(null)).toBe(false);
  });
});

// ── ASK-1 / KACL-1 / IEDGE-5 — the team's record judges what reached the model ─

describe("ASK-1 / KACL-1 / IEDGE-5 — planVisibleHistory reads the recorded context", () => {
  const D1 = "00000000-0000-4000-8000-000000000001";
  const D2 = "00000000-0000-4000-8000-000000000002";
  const row = (over: Partial<StoredAnswerRow>): StoredAnswerRow => ({
    id: `r-${Math.random()}`, library_id: "L", user_id: "asker", question: "q", created_at: "2026-10-01T00:00:00Z",
    citations: [{ n: 1, documentId: D1, page: 1 }], mode: "library", ...over,
  });
  const ctx = (documents: string[], over: Record<string, unknown> = {}) => ({ v: 1, documents, complete: true, history: "none", ...over });

  it("reproduction → fix: a row citing D1 but built on D2 too is withheld from a reader who cannot read D2", () => {
    const r = row({ context: ctx([D1, D2]) });
    expect(planVisibleHistory([r], [], new Set([D1]), "reader").withheld).toEqual([r]);
    expect(planVisibleHistory([r], [], new Set([D1, D2]), "reader").visible).toEqual([r]);
  });

  it("a row whose context is incomplete, or rests on unverified client history, is its asker's alone", () => {
    for (const c of [ctx([D1], { complete: false }), ctx([D1], { history: "client" })]) {
      const r = row({ context: c });
      expect(planVisibleHistory([r], [], new Set([D1]), "reader").withheld).toEqual([r]);
      expect(planVisibleHistory([r], [], new Set([D1]), "asker").visible).toEqual([r]);
    }
  });

  it("a row written before 20261153 (no context) is judged by its citations, as before", () => {
    const r = row({});
    expect(planVisibleHistory([r], [], new Set([D1]), "reader").visible).toEqual([r]);
  });

  it("parseAnswerContext reads only a context the ask route wrote; contextKnowledgeDocIds lists its documents", () => {
    expect(parseAnswerContext(null)).toBeNull();
    expect(parseAnswerContext([D1])).toBeNull();
    expect(parseAnswerContext({ documents: "x" })).toBeNull();
    expect(parseAnswerContext({ documents: [D1, 7, ""], complete: true, history: "thread", partial: true, arithmetic: "unverified", skills: ["Basis of Design", 3] }))
      .toEqual({ v: 1, documents: [D1], complete: true, history: "thread", partial: true, arithmetic: "unverified", skills: ["Basis of Design"] });
    // anything not stated as complete is incomplete (fail-safe)
    expect(parseAnswerContext({ documents: [] })?.complete).toBe(false);
    expect(contextKnowledgeDocIds({ documents: [D1, D2] })).toEqual([D1, D2]);
    expect(contextKnowledgeDocIds(undefined)).toEqual([]);
  });
});

// ── IRLS-13 — the packs a block carries ─────────────────────────────────────

describe("IRLS-13 — buildAnswerSkills names the packs that rode the block, and only those", () => {
  const pack = (name: string, instructions: string, over: Record<string, unknown> = {}) => ({
    id: `id-${name}`, builtin_key: null, name, instructions, enabled: true, visibility: "org", created_by: null, ...over,
  });
  it("the included packs, in order; a pack the budget cut is not listed; the block is unchanged", () => {
    const rows = [pack("A", "APPLIES WHEN a."), pack("B", "x".repeat(9500)), pack("C", "APPLIES WHEN c.", { visibility: "private", created_by: "other" })];
    const out = buildAnswerSkills(rows, "me");
    expect(out.skills).toEqual([{ id: "id-A", name: "A", builtinKey: null }]);
    expect(out.block).toBe(buildAnswerSkillsBlock(rows, "me"));
    expect(buildAnswerSkills([], "me")).toEqual({ block: "", skills: [] });
  });
});

// ── KACL-9 — the boundary is named, and retrieval calls it ───────────────────

describe("KACL-9 — the AI boundary is documents.ai_excluded (aiReadability); the ask route calls it at retrieval", () => {
  const route = src("app/api/knowledge/ask/route.ts");
  it("the route runs aiReadability over every mirror's controlled document, and its comment names what it filters", () => {
    expect(route).toMatch(/import \{ aiReadability \} from "@\/lib\/aiBoundary";/);
    expect(route).toMatch(/const verdict = aiReadability\(\{[\s\S]*?aiExcluded: !!d\.ai_excluded,[\s\S]*?\}, true\);/);
    expect(route).not.toMatch(/AI-excluded documents are filtered HERE/);
    expect(route).toMatch(/the per-asker ACL set, plus controlled documents\s+\/\/ the AI may not read, KACL-9 \/ KACL-10/);
  });
  it("no code or doc names an is_indexed gatekeeper", () => {
    for (const f of ["lib/aiBoundary.ts", "lib/schemaExpectations.ts", "docs/ARCHITECTURE.md", "app/api/knowledge/ask/route.ts"]) {
      expect(src(f), f).not.toMatch(/is_?indexed/i);
    }
  });
});

// ── 20261153 ────────────────────────────────────────────────────────────────

describe("20261153 — knowledge_questions.context, one paste", () => {
  const sql = src("supabase/migrations/20261153_intel_roundG_ask_answer_context.sql");
  it("adds one nullable JSONB column and an object CHECK, idempotently, inside BEGIN/COMMIT; defines no function, policy or trigger", () => {
    const tx = sql.slice(sql.indexOf("BEGIN;"), sql.indexOf("COMMIT;"));
    expect(tx).toMatch(/ALTER TABLE knowledge_questions ADD COLUMN IF NOT EXISTS context JSONB;/);
    expect(tx).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint\s+WHERE conname = 'knowledge_questions_context_object'/);
    expect(tx).toMatch(/CHECK \(context IS NULL OR jsonb_typeof\(context\) = 'object'\)/);
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|POLICY|TRIGGER)/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b|DROP POLICY/i);
  });
  it("the inventory is captured before the transaction; the paste ends in ONE (check, ok, n) result set", () => {
    expect(sql.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g53_before")).toBeLessThan(sql.indexOf("BEGIN;"));
    const tail = sql.slice(sql.indexOf("COMMIT;") + "COMMIT;".length);
    expect((tail.match(/^SELECT /gm) ?? []).length).toBe(1 + (tail.match(/^UNION ALL\nSELECT /gm) ?? []).length);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s*NULL::text AS n/);
    expect(tail.trim().endsWith("FROM _intel_g53_before;")).toBe(true);
  });
});

// ── The answer surface (lib/knowledge.ts types, the knowledge page) ─────────

describe("the answer surface marks what the route now says", () => {
  const page = src("app/(protected)/knowledge/[id]/page.tsx");
  it("GOV-9: a vision-derived quote is marked 'AI transcription of this page' on its source card", () => {
    expect(page).toMatch(/c\.source === "vision" && \(\s*<span data-citation-source="vision"[\s\S]*?AI transcription of this page/);
  });
  it("PR-9: an answer with unverified arithmetic carries the label", () => {
    expect(page).toMatch(/answer\.arithmetic === "unverified" && \(\s*<span data-arithmetic="unverified"[\s\S]*?Unverified arithmetic — check every step/);
  });
  it("IRLS-13: the answer names the Reasoning Skills that shaped it", () => {
    expect(page).toMatch(/<span data-answer-skills="true"[\s\S]*?Shaped by: \{\(answer\.skills \?\? \[\]\)\.map\(\(k\) => k\.name\)\.join\(", "\)\}/);
  });
  it("SEM-3 / ASK-11: a library meaning search could not cover, and an answer that could not be saved, are said", () => {
    expect(page).toMatch(/data-meaning-notes="true"/);
    expect(page).toMatch(/answer\.saved === false && answer\.saveError && \(/);
  });
  it("KACL-6: where PDFs are added, the page says they are readable by every member", () => {
    expect(page).toMatch(/data-upload-visibility="true"[\s\S]*?PDFs added here are readable by every member of this workspace/);
  });
  it("SEM-3: removing the embeddings key never promises the vectors work again with any key", () => {
    const modal = src("components/knowledge/AiSettingsModal.tsx");
    expect(modal).not.toMatch(/start working again as soon as you add a key back/);
    expect(modal).toMatch(/they work again only with a key for the provider that built them/);
  });
  it("IEDGE-4: the memory card and the Conversations list badge an answer whose sources were revised since", () => {
    expect(page).toMatch(/\{pa\.revisedSince && \(\s*<div data-revised-since="true"/);
    expect(page).toMatch(/rows\.some\(\(r\) => r\.revisedSince\) && \(\s*<span data-revised-since="true"/);
  });
  it("PR-4: the equipment table marks a sheet an AI transcribed", () => {
    expect(src("components/knowledge/EquipmentTablePanel.tsx")).toMatch(/s\.viaVision && \(\s*<span data-via-vision="true"/);
  });
});
