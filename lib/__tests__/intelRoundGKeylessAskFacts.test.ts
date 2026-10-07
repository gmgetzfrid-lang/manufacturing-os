// intelligence Round G (I-22) — ING-6 criterion (a): the ask route's DRAWING
// FACTS state how many pages AI vision could not read — the pages waiting on
// (or accepted without) an AI vision read (vision_failed_pages, 20261122)
// and the pages indexed from their text layer only because no AI key was
// available (vision_keyless_pages, 20261186) — and the drawing rules stop
// telling the model to TRUST the counts while any are missing.
//
// Driven through the real route under the I-03 harness (askRouteHarness.ts).
// REGRESSION: a library where every page was read, and a database without
// either column, get the prompt they got before, byte for byte.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db, resetDb, type Row } from "./knowledgeFakeDb";
import { h, resetHarness, baseTables, kdoc, ORG, LIB } from "./askRouteHarness";

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
import { DATA_OPEN, DATA_CLOSE } from "@/lib/knowledgeAskGuards";
import {
  VISION_UNREAD_RULE, VISION_UNREAD_UNKNOWN_RULE, visionUnreadFactsLine, summarizeVisionUnread, keylessTextOnlyLabel,
  keylessPagesShown, keylessCount, headroomWaitLine, headroomWaitNote,
} from "@/lib/knowledgeKeyless";

const ask = (body: Record<string, unknown>) => POST(new NextRequest("http://x/api/knowledge/ask", {
  method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" },
  body: JSON.stringify({ orgId: ORG, libraryId: LIB, ...body }),
}));
const ent = (document_id: string, kind: string, tag: string, page = 1): Row => ({
  id: `e-${document_id}-${kind}-${tag}-${page}`, org_id: ORG, library_id: LIB, document_id, page, kind, tag, raw: tag,
});
const answerCall = () => h.calls[h.calls.length - 1];
const fenced = (user: string) => user.slice(user.indexOf(DATA_OPEN), user.indexOf(DATA_CLOSE) + DATA_CLOSE.length);
const DRAW_Q = { text: '["vessels"]', usage: { inputTokens: 100, outputTokens: 10 } };
const REFINE_NONE = { text: '{"queries": [], "missing_documents": []}', usage: { inputTokens: 500, outputTokens: 15 } };
const DRAW_A = { text: "**Answer:** The census lists the vessels.", usage: { inputTokens: 2000, outputTokens: 50 } };

/** Four sheets, three tags each; `over(d)` adds columns to sheet d. */
function sheets(over: (d: number) => Row = () => ({})) {
  const docs: Row[] = [];
  const ents: Row[] = [];
  for (let d = 0; d < 4; d++) {
    const id = `k-s${String(d).padStart(4, "0")}`;
    docs.push(kdoc(id, { name: `025-PID-${String(d).padStart(4, "0")}.pdf`, page_count: 3, pages_indexed: 3, ...over(d) }));
    for (let t = 0; t < 3; t++) ents.push(ent(id, "equipment", `V-${d * 1000 + t}`));
  }
  resetDb({ ...baseTables(), knowledge_documents: docs, knowledge_page_entities: ents });
}
async function prompt(): Promise<{ data: string; system: string }> {
  h.script = [DRAW_Q, REFINE_NONE, DRAW_A];
  const res = await ask({ question: "How many vessels are in this unit?" });
  expect(res.status).toBe(200);
  const call = answerCall();
  return { data: fenced(call.user), system: call.system };
}

beforeEach(() => {
  resetHarness();
});

describe("ING-6 (a) / I-22 — the DRAWING FACTS say how many pages AI vision could not read", () => {
  it("pages waiting on AI vision and pages indexed without a key are counted, as plain facts, and the rules stop saying TRUST", async () => {
    sheets((d) => (d === 0 ? { vision_failed_pages: [2, 3] } : d === 1 ? { vision_keyless_pages: 1 } : d === 2 ? { vision_failed_pages: [1], vision_keyless_pages: 2 } : {}));
    const { data, system } = await prompt();
    expect(data).toContain(
      "- Pages AI vision could not read: 6 (on 3 of 4 sheets) — 3 are waiting for an AI vision read or were accepted unread; " +
      "3 were indexed from their text layer only because no AI key was available. The tags and text on those pages may be missing.\n",
    );
    // The facts are still tallied over every sheet.
    expect(data).toContain("- Sheets: 4");
    expect(data).toContain("Equipment, distinct tags: 12");
    expect(system).not.toMatch(/TRUST them for counts/);
    expect(system).toContain(`Prefer them over the passages for counts and totals. ${VISION_UNREAD_RULE}`);
  });

  it("with sheets an AI transcribed too, both hedges ride the rules", async () => {
    sheets((d) => (d === 0 ? { vision_pages: 1 } : d === 1 ? { vision_keyless_pages: 1 } : {}));
    const { data, system } = await prompt();
    expect(data).toMatch(/Sheets whose tags came \(at least in part\) from an AI transcription of the page image: 1 of 4/);
    expect(data).toContain("- Pages AI vision could not read: 1 (on 1 of 4 sheets) — 1 was indexed from its text layer only because no AI key was available.");
    expect(system).toMatch(/transcribed from page images by an AI model during indexing: a count that includes them is only as good as that transcription — say so when you give one, and treat a title-block identity read that way as unconfirmed\. Some pages were not read by AI vision/);
  });

  it("an accepted partial index's unread pages are still unread", async () => {
    sheets((d) => (d === 3 ? { vision_failed_pages: [4], vision_partial_accepted: true, status: "ready" } : {}));
    const { data } = await prompt();
    expect(data).toContain("- Pages AI vision could not read: 1 (on 1 of 4 sheets) — 1 is waiting for an AI vision read or was accepted unread.");
  });

  it("a database without 20261186 still states the pages waiting on AI vision (vision_failed_pages); the keyless count is simply not there", async () => {
    sheets((d) => (d === 0 ? { vision_failed_pages: [2] } : {}));
    db.missingColumns.knowledge_documents = ["vision_keyless_pages"];
    const { data, system } = await prompt();
    expect(data).toContain("- Pages AI vision could not read: 1 (on 1 of 4 sheets) — 1 is waiting for an AI vision read or was accepted unread.");
    expect(system).toContain(VISION_UNREAD_RULE);
  });

  it("a count that cannot be read is said as unknown — the facts still ride, never trusted, never taken as none", async () => {
    sheets();
    db.hooks.push((op) => op.table === "knowledge_documents" && op.kind === "select"
      && Array.isArray(op.columns) && op.columns.join(",") === "id,vision_failed_pages,vision_keyless_pages"
      ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : undefined);
    const { data, system } = await prompt();
    expect(data).toContain("- Sheets: 4");
    expect(data).toContain("- Pages AI vision could not read: unknown — the count could not be read this time");
    expect(system).not.toMatch(/TRUST them for counts/);
    // The app does not know that any page went unread, so the rules never
    // say so: they say only that it could not be checked.
    expect(system).toContain(`Prefer them over the passages for counts and totals. ${VISION_UNREAD_UNKNOWN_RULE}`);
    expect(system).not.toContain(VISION_UNREAD_RULE);
    expect(system).not.toMatch(/Some pages were not read by AI vision/);
  });

  it("…while a known non-zero count keeps the rule that pages went unread, and never the could-not-check one", async () => {
    sheets((d) => (d === 0 ? { vision_failed_pages: [2] } : {}));
    const { system } = await prompt();
    expect(system).toContain(VISION_UNREAD_RULE);
    expect(system).not.toContain(VISION_UNREAD_UNKNOWN_RULE);
  });
});

describe("I-22 — REGRESSION: every page read → the prompt is exactly as before", () => {
  it("a library with no unread page, a database without 20261186, and one without 20261122 either all get the same prompt — the one that says TRUST", async () => {
    sheets();
    const now = await prompt();
    expect(now.data).not.toContain("Pages AI vision could not read");
    expect(now.system).toMatch(/TRUST them for counts and totals\./);
    expect(now.system).not.toContain(VISION_UNREAD_RULE);
    expect(now.system).not.toContain(VISION_UNREAD_UNKNOWN_RULE);

    resetHarness();
    sheets();
    db.missingColumns.knowledge_documents = ["vision_keyless_pages"];
    const no186 = await prompt();

    resetHarness();
    sheets();
    db.missingColumns.knowledge_documents = ["vision_failed_pages", "vision_keyless_pages"];
    const no122 = await prompt();

    expect(no186).toEqual(now);
    expect(no122).toEqual(now);
  });

  it("the sheets' own read is untouched (the facts' columns and its fail-closed path, I-03's tests pin it)", async () => {
    sheets((d) => (d === 1 ? { vision_keyless_pages: 2 } : {}));
    await prompt();
    const reads = db.ops.filter((o) => o.table === "knowledge_documents" && o.kind === "select" && Array.isArray(o.columns))
      .map((o) => (o.columns as string[]).join(","));
    expect(reads).toContain("id,name,library_id,vision_pages");
    expect(reads).toContain("id,vision_failed_pages,vision_keyless_pages");
  });
});

describe("I-22 — the shared wording (lib/knowledgeKeyless.ts)", () => {
  it("the library page's marker", () => {
    expect(keylessTextOnlyLabel(0)).toBeNull();
    expect(keylessTextOnlyLabel(1)).toBe("1 page indexed from its text layer only (no AI key)");
    expect(keylessTextOnlyLabel(14)).toBe("14 pages indexed from their text layer only (no AI key)");
    expect(keylessCount(undefined)).toBe(0);
    expect(keylessCount(null)).toBe(0);
    expect(keylessCount("3")).toBe(3);
    expect(keylessCount(-2)).toBe(0);
    // Only where the current index stands behind it, and never past the pages indexed.
    expect(keylessPagesShown(3, 0)).toBe(0);
    expect(keylessPagesShown(3, 10)).toBe(3);
    expect(keylessPagesShown(30, 10)).toBe(0);
  });

  it("the facts line is empty when every page was read", () => {
    expect(visionUnreadFactsLine(summarizeVisionUnread([{ vision_failed_pages: [] }, { vision_keyless_pages: 0 }, {}]), 3)).toBe("");
    // Duplicates and junk in a page list are not pages.
    expect(summarizeVisionUnread([{ vision_failed_pages: [2, 2, 0, "x"] }])).toEqual({ failedPages: 1, keylessPages: 0, sheets: 1 });
  });

  it("GOV-5 residual: the headroom note is the payer's figures in the third person — never the reservation's 'your … cap'", () => {
    // The figures reserveWithinCap puts on its refusal (GovernedCallError.details).
    expect(headroomWaitNote({ spentUsd: 9.94, capUsd: 10, reservedUsd: 0.11, locked: false }))
      .toBe("the payer's $10.00 monthly AI cap has $0.06 left, and the next batch could cost up to $0.11.");
    // A tiny embedding batch never reads "$0.00".
    expect(headroomWaitNote({ spentUsd: 9.9995, capUsd: 10, reservedUsd: 0.0012 }))
      .toBe("the payer's $10.00 monthly AI cap has $0.0005 left, and the next batch could cost up to $0.0012.");
    expect(headroomWaitNote({ spentUsd: 9.99999999, capUsd: 10, reservedUsd: 0.0012 }))
      .toBe("the payer's $10.00 monthly AI cap has under $0.0001 left, and the next batch could cost up to $0.0012.");
    // Figures missing or junk: no note (the panel says the bare line).
    expect(headroomWaitNote(undefined)).toBeUndefined();
    expect(headroomWaitNote({ spentUsd: 9.94, capUsd: 10 })).toBeUndefined();
    expect(headroomWaitNote({ spentUsd: "9.94", capUsd: 10, reservedUsd: 0.11 })).toBeUndefined();
    expect(headroomWaitNote({ spentUsd: Number.NaN, capUsd: 10, reservedUsd: 0.11 })).toBeUndefined();
    expect(headroomWaitNote({ spentUsd: 0, capUsd: 0, reservedUsd: 0.11 })).toBeUndefined();
    expect(headroomWaitNote({ spentUsd: 1, capUsd: 2, reservedUsd: 3 })).not.toMatch(/\byour\b/i);
  });

  it("GOV-5 residual: the headroom wait is said only while passages remain and no dated hold is in force", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    const at = "2026-10-07T03:00:00Z";
    expect(headroomWaitLine({ headroomWaitAt: at }, 40, now)).toBe("Waiting for AI budget headroom — retried each run");
    expect(headroomWaitLine({ headroomWaitAt: at }, 0, now)).toBeNull();
    expect(headroomWaitLine({}, 40, now)).toBeNull();
    expect(headroomWaitLine(null, 40, now)).toBeNull();
    expect(headroomWaitLine({ headroomWaitAt: at, blockedUntil: "2026-11-01T00:00:00Z" }, 40, now)).toBeNull();
    expect(headroomWaitLine({ headroomWaitAt: at, blockedUntil: "2026-10-01T00:00:00Z" }, 40, now)).toBe("Waiting for AI budget headroom — retried each run");
  });
});
