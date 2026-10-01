// intelligence Round G (I-03) — the pure pieces behind /api/knowledge/ask:
// the provider's stop reason and failed-call usage (ASK-3, GOV-8), the paged
// read (KACL-4), the recorded answer context and the team's record
// (ASK-1 / KACL-1 / IEDGE-5), the Reasoning Skills a block carries (IRLS-13),
// migration 20261153's shape, and the answer surface's markers.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callAiModel, AiCallError } from "@/lib/ai/providerCall";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  readAll, readAllByKey, columnsMissing, provenPageCurrent, sourceColumnMissing, drawingFactsScope, drawingFactsDocuments,
  insertAnswerRow, type PgErr,
} from "@/lib/knowledgeAskGuards";
import EquipmentTablePanel from "@/components/knowledge/EquipmentTablePanel";
import type { EquipmentTable } from "@/lib/knowledge";
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

  it("reproduction → fix (fix pass 6): readAllByKey pages by key — a row deleted between pages never shifts another out of the read, as it does an offset page", async () => {
    const table = () => Array.from({ length: 7 }, (_, i) => ({ id: `r${i}` }));
    /** max-rows 3; row r0 is deleted once the first page has been read. */
    const run = () => {
      let live = table();
      let pages = 0;
      const deleteAfterFirst = () => { if (++pages === 2) live = live.filter((r) => r.id !== "r0"); };
      return {
        byOffset: (from: number, to: number) => { deleteAfterFirst(); return Promise.resolve({ data: live.slice(from, Math.min(to + 1, from + 3)), error: null }); },
        byKey: (after: string | null) => { deleteAfterFirst(); return Promise.resolve({ data: live.filter((r) => after === null || r.id > after).slice(0, 3), error: null }); },
      };
    };
    // An offset page skips r3 (it moved into the first page's range).
    expect((await readAll<{ id: string }>(run().byOffset)).rows.map((r) => r.id)).toEqual(["r0", "r1", "r2", "r4", "r5", "r6"]);
    // By key, every row still there is read.
    const out = await readAllByKey<{ id: string }>(run().byKey);
    expect(out.rows.map((r) => r.id)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(out).toMatchObject({ error: null, capped: false });
    // An error is returned with what was read — never taken as the end.
    let n = 0;
    const failed = await readAllByKey<{ id: string }>((after) => ++n === 2
      ? Promise.resolve({ data: null, error: { code: "57014", message: "timeout" } })
      : run().byKey(after));
    expect(failed.error?.code).toBe("57014");
  });

  it("columnsMissing knows a database that has not applied the migration adding THOSE columns — and nothing else (fix pass 4)", () => {
    expect(columnsMissing({ code: "42703", message: 'column "context" does not exist' }, "context")).toBe(true);
    expect(columnsMissing({ code: "PGRST204", message: "Could not find the 'context' column of 'knowledge_questions' in the schema cache" }, "context")).toBe(true);
    expect(columnsMissing({ code: "PGRST204", message: "Could not find the 'source_model' column of 'knowledge_chunks' in the schema cache" }, "source", "source_model")).toBe(true);
    // a schema-cache miss on ANOTHER column is a failed read, not this migration
    expect(columnsMissing({ code: "PGRST204", message: "Could not find the 'library_id' column of 'knowledge_chunks' in the schema cache" }, "source", "source_model")).toBe(false);
    // "source" is not "source_document_id", nor the other way round
    expect(columnsMissing({ code: "PGRST204", message: "Could not find the 'source_document_id' column of 'knowledge_documents' in the schema cache" }, "source")).toBe(false);
    // an error whose message merely mentions a column is a failed read
    expect(columnsMissing({ code: "42702", message: 'column reference "id" is ambiguous' }, "context", "vision_pages")).toBe(false);
    expect(columnsMissing({ code: "PGRST100", message: "failed to parse filter on column vision_pages" }, "vision_pages")).toBe(false);
    expect(columnsMissing({ code: "57014", message: "statement timeout" }, "context")).toBe(false);
    expect(columnsMissing(null, "context")).toBe(false);
  });

  it("reproduction → fix (fix pass 5): an undefined column (42703) is a missing migration only when it NAMES one of the columns — Postgres always names it", () => {
    // Both of Postgres's spellings name the column.
    expect(columnsMissing({ code: "42703", message: "column knowledge_questions.thread_id does not exist" }, "thread_id", "mode")).toBe(true);
    expect(columnsMissing({ code: "42703", message: 'column "mode" of relation "knowledge_questions" does not exist' }, "thread_id", "mode")).toBe(true);
    // Fix pass 4 took every 42703 as these columns missing: a trigger's, or a
    // later migration's, undefined column took the pre-migration path too.
    expect(columnsMissing({ code: "42703", message: 'column "rated_at" does not exist' }, "context")).toBe(false);
    expect(columnsMissing({ code: "42703", message: "column knowledge_documents.library_id does not exist" }, "source_document_id")).toBe(false);
    expect(columnsMissing({ code: "42703", message: 'column "context_hint" does not exist' }, "context")).toBe(false);
    expect(columnsMissing({ code: "42703", message: 'record "new" has no field "thread_id_x"' }, "thread_id")).toBe(false);
  });
});

describe("ASK-11 — insertAnswerRow retries only for the column the error names, keeping the context when the database has it", () => {
  const missing = (col: string): PgErr => ({ code: "PGRST204", message: `Could not find the '${col}' column of 'knowledge_questions' in the schema cache` });
  /** A database lacking `lacks`: an insert naming one of them fails naming the first. */
  const dbLacking = (lacks: string[], other: PgErr | null = null) => {
    const writes: Array<Record<string, unknown>> = [];
    const insert = async (values: Record<string, unknown>) => {
      writes.push(values);
      if (other) return { error: other };
      const col = lacks.find((c) => c in values);
      return { error: col ? missing(col) : null };
    };
    return { insert, writes };
  };
  const core = { question: "q", answer: "a" };
  const row = { ...core, mode: "library", thread_id: "T", missing_docs: null };
  const context = { v: 1, documents: [] };

  it("every column present: one write, with the context", async () => {
    const d = dbLacking([]);
    expect((await insertAnswerRow(d.insert, row, core, context)).error).toBeNull();
    expect(d.writes).toEqual([{ ...row, context }]);
  });

  it("no context column (before 20261153): saved without it", async () => {
    const d = dbLacking(["context"]);
    expect((await insertAnswerRow(d.insert, row, core, context)).error).toBeNull();
    expect(d.writes.at(-1)).toEqual(row);
  });

  it("reproduction → fix: context but no thread_id (20261153 pasted before 20261008) — the core set KEEPS the context", async () => {
    const d = dbLacking(["thread_id"]);
    expect((await insertAnswerRow(d.insert, row, core, context)).error).toBeNull();
    expect(d.writes.at(-1)).toEqual({ ...core, context });
  });

  it("neither (in either order the database names them): the core set alone", async () => {
    for (const lacks of [["context", "thread_id"], ["thread_id", "context"]]) {
      const d = dbLacking(lacks);
      expect((await insertAnswerRow(d.insert, row, core, context)).error).toBeNull();
      expect(d.writes.at(-1)).toEqual(core);
    }
  });

  it("reproduction → fix: any other error — another column's 42703, a PGRST204 naming another column, a type error — is returned after ONE write, never retried without the context", async () => {
    for (const other of [
      { code: "42703", message: 'column "rated_at" does not exist' },
      { code: "PGRST204", message: "Could not find the 'provider' column of 'knowledge_questions' in the schema cache" },
      { code: "22P02", message: "invalid input syntax for type json" },
    ]) {
      const d = dbLacking([], other);
      expect((await insertAnswerRow(d.insert, row, core, context)).error).toEqual(other);
      expect(d.writes).toEqual([{ ...row, context }]);
    }
  });

  it("no context to record (a complete web answer): the row as given", async () => {
    const d = dbLacking(["mode"]);
    expect((await insertAnswerRow(d.insert, row, core, null)).error).toBeNull();
    expect(d.writes).toEqual([row, core]);
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

  it("reproduction → fix: a CONTEXT document deleted since never withholds its asker's own row — a teammate's view stays withheld", () => {
    const r = row({ context: ctx([D1, D2]) });
    const gone = new Set([D2]);
    // D2 (uncited) was deleted after the ask: nothing resolves it now.
    expect(planVisibleHistory([r], [], new Set([D1]), "asker", gone).visible).toEqual([r]);
    expect(planVisibleHistory([r], [], new Set([D1]), "reader", gone).withheld).toEqual([r]);
    // A later turn of the asker's thread is not poisoned by it either.
    const t1 = row({ id: "t1", thread_id: "T", created_at: "2026-10-01T00:00:00Z", context: ctx([D1, D2]) });
    const t2 = row({ id: "t2", thread_id: "T", created_at: "2026-10-01T00:01:00Z", context: ctx([D1]) });
    expect(planVisibleHistory([t1, t2], [t1, t2], new Set([D1]), "asker", gone).visible.map((x) => x.id)).toEqual(["t1", "t2"]);
    expect(planVisibleHistory([t1, t2], [t1, t2], new Set([D1]), "reader", gone).visible).toEqual([]);
  });

  it("reproduction → fix (fix pass 5): a deleted context document the row records as an UPLOAD withholds no one — every member could read it when the answer was given; a deleted one NOT recorded as an upload (a mirror) still withholds a teammate's view", () => {
    const D3 = "00000000-0000-4000-8000-000000000003";
    // D2 an upload, D3 a mirror; both uncited.
    const r = row({ context: ctx([D1, D2, D3], { uploads: [D1, D2] }) });
    // Fix pass 4: D2 (a tagged upload replaced by its next revision) gone →
    // withheld from every teammate.
    expect(planVisibleHistory([r], [], new Set([D1, D3]), "reader", new Set([D2])).visible).toEqual([r]);
    expect(planVisibleHistory([r], [], new Set([D1, D3]), "asker", new Set([D2])).visible).toEqual([r]);
    // The mirror gone: its controlled document's ACL can no longer be judged.
    expect(planVisibleHistory([r], [], new Set([D1, D2]), "reader", new Set([D3])).withheld).toEqual([r]);
    expect(planVisibleHistory([r], [], new Set([D1, D2]), "asker", new Set([D3])).visible).toEqual([r]);
    // A context that does not say which were uploads: every gone document
    // may have been a mirror (fail-safe).
    const unsaid = row({ context: ctx([D1, D2]) });
    expect(planVisibleHistory([unsaid], [], new Set([D1]), "reader", new Set([D2])).withheld).toEqual([unsaid]);
    // An upload that still exists but is unreadable (another org's) is no
    // deletion: still withheld.
    expect(planVisibleHistory([r], [], new Set([D1, D3]), "reader", new Set()).withheld).toEqual([r]);
    // A later turn of the thread follows the same rule.
    const t1 = row({ id: "u1", thread_id: "T", created_at: "2026-10-01T00:00:00Z", context: ctx([D1, D2], { uploads: [D1, D2] }) });
    const t2 = row({ id: "u2", thread_id: "T", created_at: "2026-10-01T00:01:00Z", context: ctx([D1], { uploads: [D1] }) });
    expect(planVisibleHistory([t1, t2], [t1, t2], new Set([D1]), "reader", new Set([D2])).visible.map((x) => x.id)).toEqual(["u1", "u2"]);
  });

  it("a context document that still exists but the asker can no longer read, or a CITED document deleted since, still withholds the asker's own row", () => {
    const r = row({ context: ctx([D1, D2]) });
    expect(planVisibleHistory([r], [], new Set([D1]), "asker").withheld).toEqual([r]);
    const cited = row({ citations: [{ n: 1, documentId: D2, page: 1 }], context: ctx([D2]) });
    expect(planVisibleHistory([cited], [], new Set(), "asker", new Set([D2])).withheld).toEqual([cited]);
  });

  it("a row written before 20261153 (no context) is judged by its citations, as before", () => {
    const r = row({});
    expect(planVisibleHistory([r], [], new Set([D1]), "reader").visible).toEqual([r]);
  });

  it("a library row that cites nothing: without a context it is its asker's alone (as before); WITH one it is judged by that context", () => {
    const bare = row({ citations: [] });
    expect(planVisibleHistory([bare], [], new Set([D1, D2]), "reader").withheld).toEqual([bare]);
    expect(planVisibleHistory([bare], [], new Set([D1, D2]), "asker").visible).toEqual([bare]);
    // "Nothing matches" with an empty context: nothing reached the model — shown.
    const none = row({ citations: [], context: ctx([]) });
    expect(planVisibleHistory([none], [], new Set(), "reader").visible).toEqual([none]);
    // An uncited answer built on D2: shown only to a reader who can read D2.
    const uncited = row({ citations: [], context: ctx([D2]) });
    expect(planVisibleHistory([uncited], [], new Set([D1]), "reader").withheld).toEqual([uncited]);
    expect(planVisibleHistory([uncited], [], new Set([D2]), "reader").visible).toEqual([uncited]);
    // Incomplete or client-history contexts stay the asker's alone.
    const partialCtx = row({ citations: [], context: ctx([], { complete: false }) });
    expect(planVisibleHistory([partialCtx], [], new Set(), "reader").withheld).toEqual([partialCtx]);
    // A nothing-matched turn with its context no longer taints the turn after it.
    const t1 = row({ id: "n1", thread_id: "T", citations: [], context: ctx([]), created_at: "2026-10-01T00:00:00Z" });
    const t2 = row({ id: "n2", thread_id: "T", context: ctx([D1]), created_at: "2026-10-01T00:01:00Z" });
    expect(planVisibleHistory([t1, t2], [t1, t2], new Set([D1]), "reader").visible.map((x) => x.id)).toEqual(["n1", "n2"]);
  });

  it("parseAnswerContext reads only a context the ask route wrote; contextKnowledgeDocIds lists its documents", () => {
    expect(parseAnswerContext(null)).toBeNull();
    expect(parseAnswerContext([D1])).toBeNull();
    expect(parseAnswerContext({ documents: "x" })).toBeNull();
    expect(parseAnswerContext({ documents: [D1, 7, ""], complete: true, history: "thread", partial: true, arithmetic: "unverified", skills: ["Basis of Design", 3] }))
      .toEqual({ v: 1, documents: [D1], complete: true, history: "thread", partial: true, arithmetic: "unverified", skills: ["Basis of Design"] });
    expect(parseAnswerContext({ documents: [D1, D2], uploads: [D1, 4, ""], complete: true })?.uploads).toEqual([D1]);
    expect(parseAnswerContext({ documents: [D1], uploads: "all", complete: true })).not.toHaveProperty("uploads");
    // anything not stated as complete is incomplete (fail-safe)
    expect(parseAnswerContext({ documents: [] })?.complete).toBe(false);
    expect(contextKnowledgeDocIds({ documents: [D1, D2] })).toEqual([D1, D2]);
    expect(contextKnowledgeDocIds(undefined)).toEqual([]);
  });
});

// ── IEDGE-4 — provenPageCurrent ─────────────────────────────────────────────

describe("IEDGE-4 — provenPageCurrent: a rated page is seated only while it is the version the rating saw", () => {
  const ANSWERED = "2026-09-01T00:00:00Z";
  const mirror = (over: Record<string, unknown> = {}) => ({ source_document_id: "dc-1", source_version_id: "v1", source_rev: "B", ...over });
  const since = (map: Record<string, string>) => (id: string) => map[id];

  it("an upload is always the page that was rated", () => {
    expect(provenPageCurrent({}, { source_document_id: null }, ANSWERED, () => undefined)).toBe(true);
  });
  it("a recorded version: seated only while the mirror still points at it (a same-label re-release is not)", () => {
    expect(provenPageCurrent({ sourceVersionId: "v1", sourceRev: "B" }, mirror(), ANSWERED, () => undefined)).toBe(true);
    expect(provenPageCurrent({ sourceVersionId: "v1", sourceRev: "B" }, mirror({ source_version_id: "v2" }), ANSWERED, () => undefined)).toBe(false);
  });
  it("nothing recorded (a rating made before I-03): seated when the mirror's version became current no later than the answer", () => {
    expect(provenPageCurrent({}, mirror(), ANSWERED, since({ v1: "2026-08-01T00:00:00Z" }))).toBe(true);
    expect(provenPageCurrent({}, mirror(), ANSWERED, since({ v1: ANSWERED }))).toBe(true);
    expect(provenPageCurrent({}, mirror(), ANSWERED, since({ v1: "2026-09-02T00:00:00Z" }))).toBe(false);
    expect(provenPageCurrent({}, mirror(), ANSWERED, since({}))).toBe(false);
    expect(provenPageCurrent({}, mirror(), null, since({ v1: "2026-08-01T00:00:00Z" }))).toBe(false);
  });
  it("nothing recorded, and a mirror with no version: nothing to compare — seated, as before", () => {
    expect(provenPageCurrent({}, mirror({ source_version_id: null }), ANSWERED, () => undefined)).toBe(true);
  });
  it("only the label recorded: a different label is never seated; the same label still needs the version to predate the answer", () => {
    expect(provenPageCurrent({ sourceRev: "A" }, mirror(), ANSWERED, since({ v1: "2026-08-01T00:00:00Z" }))).toBe(false);
    expect(provenPageCurrent({ sourceRev: "B" }, mirror(), ANSWERED, since({ v1: "2026-08-01T00:00:00Z" }))).toBe(true);
    expect(provenPageCurrent({ sourceRev: "B" }, mirror(), ANSWERED, since({ v1: "2026-09-02T00:00:00Z" }))).toBe(false);
    expect(provenPageCurrent({ sourceRev: "B" }, mirror({ source_version_id: null }), ANSWERED, () => undefined)).toBe(true);
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
  it("ASK-2: a register built from a partial census is RENDERED as a floor — 'at least', and how many sheets were not counted; a whole one is not", () => {
    const table: EquipmentTable = {
      total: 1, truncated: false, filteredTo: "Pumps",
      categories: [{ prefix: "P", label: "Pumps", count: 1, items: [{ tag: "P-5001", note: null, sheets: [{ documentId: "d", documentName: "025-PID-0005.pdf", page: 1 }] }] }],
      partial: { uncountedSheets: 2 },
    };
    const partial = renderToStaticMarkup(React.createElement(EquipmentTablePanel, { table, onOpenTag: () => undefined }));
    expect(partial).toMatch(/Pumps — (<!-- -->)?at least (<!-- -->)?1(<!-- -->)? distinct tag/);
    expect(partial).toMatch(/data-partial-register="true"[^>]*>PARTIAL — (<!-- -->)?2(<!-- -->)? sheet(<!-- -->)?s were(<!-- -->)? not\s+counted; this list is a floor/);
    const whole = renderToStaticMarkup(React.createElement(EquipmentTablePanel, { table: { ...table, partial: undefined }, onOpenTag: () => undefined }));
    expect(whole).not.toMatch(/PARTIAL|at least/);
    expect(whole).toMatch(/Pumps — (<!-- -->)?1(<!-- -->)? distinct tag/);
  });
});

// ── ASK-1 / KACL-4 — what the drawing facts name ─────────────────────────────

describe("ASK-1 — the row records what the drawing facts' text can name", () => {
  it("drawingFactsScope: the root series of the sheets with a drawing number, with their holders — never a fragment of another document's filename", () => {
    const docs = [
      { id: "a", name: "025-PID-0001.pdf" },
      { id: "b", name: "025-PID-0002.pdf" },
      { id: "c", name: "030-PID-0001 Secret unit.pdf" },
      { id: "m", name: "Unrelated controlled procedure" },
      { id: "u", name: "Relief standard.pdf" },
    ];
    const scope = drawingFactsScope(docs, new Map());
    expect(scope.series).toEqual(["025-PID", "030-PID"]);
    expect(scope.holders.get("025-PID")).toEqual(["a", "b"]);
    expect(scope.holders.get("030-PID")).toEqual(["c"]);
    // a title block's declared number counts like a filename's
    expect(drawingFactsScope([{ id: "t", name: "scan 7.pdf" }], new Map([["t", ["040-PID-0003"]]])).series).toEqual(["040-PID"]);
  });

  it("drawingFactsDocuments: tag-row sheets, unread sheets, sheets a printed name names, and mirrors that alone hold a printed series — nothing that only adds to a count", () => {
    const docs = [
      { id: "t", name: "025-PID-0001.pdf" },              // tag rows
      { id: "x", name: "025-PID-0002 SECRET.pdf" },       // named as a one-way target
      { id: "s", name: "030-PID-0001.pdf" },              // the only holder of 030-PID, a mirror
      { id: "same", name: "025-PID-0003.pdf" },           // a mirror of a series a recorded sheet holds
      { id: "up40", name: "040-PID-0001.pdf" },           // an upload holding 040-PID
      { id: "m40", name: "040-PID-0002.pdf" },            // a mirror of 040-PID beside that upload
      { id: "r", name: "Unrelated controlled procedure" }, // counted only
      { id: "late", name: "025-PID-0009.pdf" },           // past the census ceiling
    ];
    const mirrors = new Set(["x", "s", "same", "m40", "r", "late"]);
    const scope = drawingFactsScope(docs, new Map());
    const recorded = drawingFactsDocuments({
      docs, tagDocIds: ["t"], unreadDocIds: ["late"], namesShown: ["025-PID-0001.pdf", "025-PID-0002 SECRET.pdf"],
      scopeHolders: scope.holders, isMirror: (id) => mirrors.has(id),
    });
    expect(recorded.sort()).toEqual(["late", "s", "t", "x"].sort());
  });

  it("KACL-4 sourceColumnMissing: only an undefined column, or a schema-cache miss naming source_document_id, means a database without mirrors", () => {
    expect(sourceColumnMissing({ code: "42703", message: 'column "source_document_id" does not exist' })).toBe(true);
    expect(sourceColumnMissing({ code: "PGRST204", message: "Could not find the 'source_document_id' column of 'knowledge_documents' in the schema cache" })).toBe(true);
    expect(sourceColumnMissing({ code: "PGRST204", message: "Could not find the 'library_id' column of 'knowledge_documents' in the schema cache" })).toBe(false);
    expect(sourceColumnMissing({ code: "PGRST100", message: "failed to parse filter on column source_document_id" })).toBe(false);
    expect(sourceColumnMissing({ code: "42702", message: 'column reference "id" is ambiguous' })).toBe(false);
    expect(sourceColumnMissing(null)).toBe(false);
  });
});
