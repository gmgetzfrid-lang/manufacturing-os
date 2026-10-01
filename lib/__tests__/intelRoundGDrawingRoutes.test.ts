// intelligence Round G (I-07) — /api/knowledge/drawing and
// /api/knowledge/locate, driven through the routes against the in-memory
// database (knowledgeFakeDb.ts) behind a PostgREST stand-in that, like the
// real one, CAPS every response at max-rows (1,000) without an error, and
// serves 20261124's two functions (or refuses them, as an unmigrated
// database does). The real knowledgeAccess, resetKnowledgeIndex and
// drawing libs run; the provider, renderer and canvas are scripted.
//
//   DWG-11  the census pages to exhaustion — whole sheets no longer vanish
//           at 1,000 rows — on both the aggregate and the raw-row path; past
//           the ceiling it stops at a whole document, says PARTIAL, and the
//           audit refuses to record from it
//   DWG-6   verdicts keyed (org, library, sheet, revision): two libraries
//           holding the same sheet keep two verdicts; a lone sheet of a
//           series is recorded for what is its own, and no gap is judged in
//           a series the library does not hold; never lowered
//   DWG-13  an unrevised sheet is not re-audited; the response says so; a
//           sheet whose revision is unknown always is, and takes the latest
//           verdict
//   DWG-10  the number recorded is the number the lens shows
//   DWG-1   (handed over by I-06) the indexed revision is filed; a mirror on
//           an older version, or with a disagreeing label, is skipped with
//           the reason and not recorded
//   ING-1/8/12 (handed over by I-06) the rebuild is resetKnowledgeIndex:
//           under the claim, every counter zeroed, a busy document left alone
//   ING-6   (handed over) a parked document shows as indexing, with the
//           pages it waits on and why
//   DWG-7   text with no tags says drawing or prose
//   DWG-4   box pairing with no input says so
//   DWG-5 / GOV-8  every locate call is metered in one row written after the
//           last; the cap is re-consulted before each extra call
//   DWG-13 / PR-10  a close-up that refutes the coarse point triggers the
//           relocate round; a refuted point is never cached; a point no
//           close-up checked is cached as an estimate; a viewer can reject one
//   DWG-12  'where else' never answers with a sheet that merely cites a number

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { db, resetDb, rowsOf, type Row } from "./knowledgeFakeDb";

const net = vi.hoisted(() => ({ maxRows: 1000, rpcMissing: false, rpcCalls: [] as string[] }));
const ai = vi.hoisted(() => ({
  script: [] as Array<{ text?: string; throws?: string; usage?: { inputTokens: number; outputTokens: number } }>,
  calls: [] as Array<{ user: string }>,
  log: [] as string[],
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const { fakeAdmin, db: fdb } = await import("./knowledgeFakeDb");
  const { rollUpEntities } = await import("@/lib/drawingText");
  type Res = { data: unknown; error: unknown };
  const capRes = (res: Res): Res => ({ ...res, data: Array.isArray(res.data) ? res.data.slice(0, net.maxRows) : res.data });
  const capped = <B extends { then: (...a: never[]) => unknown }>(b: B): B => {
    const orig = (b as unknown as { then: (f: (r: Res) => unknown, r?: (e: unknown) => unknown) => unknown }).then.bind(b);
    (b as unknown as { then: unknown }).then = (f: (r: Res) => unknown, r?: (e: unknown) => unknown) =>
      orig((res: Res) => (f ? f(capRes(res)) : capRes(res)), r);
    return b;
  };
  class Rpc {
    private from = 0; private to = Number.POSITIVE_INFINITY;
    constructor(private fn: string, private args: { p_document_ids: string[] }) {}
    order() { return this; }
    range(a: number, b: number) { this.from = a; this.to = b; return this; }
    then(f: (r: Res) => unknown, r?: (e: unknown) => unknown) {
      return Promise.resolve().then(() => {
        net.rpcCalls.push(this.fn);
        if (net.rpcMissing) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${this.fn}` } };
        const ids = new Set(this.args.p_document_ids);
        let rows: unknown[];
        if (this.fn === "drawing_entity_rollup") {
          rows = rollUpEntities((fdb.tables.knowledge_page_entities ?? [])
            .filter((e) => ids.has(e.document_id as string) && ["equipment", "ref", "opc", "self"].includes(e.kind as string))
            .map((e) => ({ document_id: e.document_id as string, page: e.page as number, kind: e.kind as string, tag: e.tag as string })));
        } else if (this.fn === "knowledge_doc_text_stats") {
          const by = new Map<string, { document_id: string; chunks: number; chars: number; lower_letters: number; upper_letters: number }>();
          for (const c of fdb.tables.knowledge_chunks ?? []) {
            if (!ids.has(c.document_id as string)) continue;
            const t = String(c.content ?? "");
            const s = by.get(c.document_id as string) ?? { document_id: c.document_id as string, chunks: 0, chars: 0, lower_letters: 0, upper_letters: 0 };
            s.chunks++; s.chars += t.length;
            s.lower_letters += (t.match(/[a-z]/g) ?? []).length; s.upper_letters += (t.match(/[A-Z]/g) ?? []).length;
            by.set(s.document_id, s);
          }
          rows = [...by.values()];
        } else return { data: null, error: { code: "PGRST202", message: "unknown function" } };
        return capRes({ data: rows.slice(this.from, this.to + 1), error: null });
      }).then(f, r);
    }
  }
  return {
    supabaseAdmin: {
      from: (t: string) => capped(fakeAdmin.from(t)),
      rpc: (fn: string, args: { p_document_ids: string[] }) => new Rpc(fn, args),
      auth: fakeAdmin.auth,
    },
  };
});
vi.mock("@/lib/codebookServer", () => ({ loadCodebookAdmin: vi.fn(async () => null), codebookToDecoderText: () => "" }));
vi.mock("@/lib/r2", () => ({ R2_BUCKET: "bucket", r2: { send: async () => ({ Body: new Uint8Array([37, 80, 68, 70]) }) } }));
// Placeholder ids: priced by lib/ai/pricing's fallback, never a real model.
vi.mock("@/lib/knowledgeVision", () => ({ VISION_MODEL: { anthropic: "vision-model-a", openai: "vision-model-o", gemini: "vision-model-g" }, transcribePageImage: vi.fn() }));
vi.mock("unpdf", async (orig) => ({
  ...(await orig<typeof import("unpdf")>()),
  getDocumentProxy: vi.fn(async () => ({})),
  renderPageAsImage: vi.fn(async () => new Uint8Array([137, 80, 78, 71]).buffer),
}));
vi.mock("@napi-rs/canvas", () => ({
  loadImage: vi.fn(async () => ({ width: 1800, height: 1200 })),
  createCanvas: vi.fn(() => ({ getContext: () => ({ drawImage: () => undefined }), toBuffer: () => Buffer.from("png") })),
}));
vi.mock("@/lib/ai/providerCall", () => ({
  callAiModel: vi.fn(async (input: { user: string }) => {
    ai.calls.push({ user: input.user });
    const next = ai.script.shift();
    if (!next) throw new Error("no scripted answer");
    ai.log.push("call");
    if (next.throws) throw Object.assign(new Error(next.throws), next.usage ? { usage: next.usage } : {});
    return { text: next.text ?? "", usage: next.usage ?? { inputTokens: 1000, outputTokens: 50 }, webSources: [], liveWeb: false };
  }),
}));
vi.mock("@/lib/equipmentBridgeServer", () => ({ computeForKnowledgeDoc: vi.fn(async () => undefined) }));
vi.mock("@/lib/mentionIndexer", () => ({ loadAliasDictionary: vi.fn(async () => []), indexDocumentMentions: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/usageServer", () => ({
  getMonthUsage: vi.fn(async () => ({ spentUsd: 0 })),
  getCapUsd: vi.fn(async () => 0),
  monthStartIso: () => "2026-10-01T00:00:00.000Z",
  recordAskUsage: vi.fn(async () => { ai.log.push("meter"); }),
}));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string) => k }));

import { GET as drawingGET, POST as drawingPOST } from "@/app/api/knowledge/drawing/route";
import { POST as locatePOST } from "@/app/api/knowledge/locate/route";
import { recordAskUsage, getCapUsd } from "@/lib/ai/usageServer";
import { estimateCostUsd, AGREEMENT_VERSION } from "@/lib/ai/pricing";
import { VISION_MODEL } from "@/lib/knowledgeVision";
import { INGEST_LEASE_TTL_MS } from "@/lib/knowledgeIngest";
import { pageNeedsVision, extractEquipmentTags, extractDrawingRefs, isDrawingLikePage } from "@/lib/drawingText";

const CTRL = [{ org_id: "o1", uid: "u-ctrl", role: "Viewer", roles: ["Viewer", "DocCtrl"], status: "active" }];
const get = (q: string) => drawingGET(new NextRequest(`http://x/api/knowledge/drawing?${q}`, { headers: { authorization: "Bearer good" } }));
const post = (body: unknown) => drawingPOST(new NextRequest("http://x/api/knowledge/drawing", {
  method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const locate = (body: unknown) => locatePOST(new NextRequest("http://x/api/knowledge/locate", {
  method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify(body),
}));

let seq = 0;
const kdoc = (id: string, over: Row = {}): Row => ({
  id, org_id: "o1", library_id: "kl-1", name: `${id}.pdf`, file_key: `orgs/o1/knowledge/${id}.pdf`, status: "ready",
  page_count: 1, pages_indexed: 1, vision_pages: 0, error: null, source_document_id: null, source_version_id: null, source_rev: null,
  vision_failed_pages: [], vision_retry_after: null, empty_pages: 0, vision_retry_tried: [], vision_partial_accepted: false,
  chunk_version: null, ingest_failures: 0, ingest_claimed_by: null, ingest_claimed_at: null, last_section: null, ...over,
});
const ent = (document_id: string, kind: string, tag: string, page = 1, over: Row = {}): Row => ({
  id: `e-${++seq}`, org_id: "o1", library_id: "kl-1", document_id, page, kind, tag, raw: tag, nx: null, ny: null, pos_source: null, ...over,
});
const chunk = (document_id: string, content: string): Row => ({ id: `c-${++seq}`, document_id, page: 1, seq: ++seq, content });

function seed(tables: Record<string, Row[]>) {
  resetDb({
    org_members: CTRL, team_members: [], knowledge_libraries: [{ id: "kl-1", org_id: "o1", ai_features: {} }, { id: "kl-2", org_id: "o1", ai_features: {} }],
    knowledge_documents: [], knowledge_page_entities: [], knowledge_chunks: [], entity_mentions: [], drawing_audit_logs: [], documents: [],
    ...tables,
  });
}

beforeEach(() => {
  net.maxRows = 1000; net.rpcMissing = false; net.rpcCalls = [];
  ai.script = []; ai.calls = []; ai.log = [];
  vi.mocked(recordAskUsage).mockClear();
  vi.mocked(getCapUsd).mockResolvedValue(0);
});
afterEach(() => { vi.unstubAllEnvs(); });

// ── DWG-11 ──────────────────────────────────────────────────────────────────

/** 60 sheets × 25 distinct tags = 1,500 equipment rows: more than one
 *  PostgREST response holds. */
function bigLibrary() {
  const docs: Row[] = [];
  const ents: Row[] = [];
  const chunks: Row[] = [];
  for (let d = 0; d < 60; d++) {
    const id = `k-${String(d).padStart(2, "0")}`;
    docs.push(kdoc(id));
    for (let t = 0; t < 25; t++) ents.push(ent(id, "equipment", `V-${d * 100 + t}`));
    ents.push(ent(id, "self", `025-PID-${String(100 + d).padStart(4, "0")}`));
    chunks.push(chunk(id, "V-1 SUCTION DRUM"));
  }
  seed({ knowledge_documents: docs, knowledge_page_entities: ents, knowledge_chunks: chunks });
}

describe("DWG-11 — the census is whole, or says it is not", () => {
  it("raw-row path (before 20261124): every sheet is counted past the 1,000-row response cap", async () => {
    bigLibrary();
    net.rpcMissing = true;
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(body.indexSource).toBe("rows");
    expect(body.truncated).toBe(false);
    expect(body.census.totalOccurrences).toBe(1500);
    expect(body.census.totalDistinct).toBe(1500);
    expect(body.sheets.every((s: { tags: number }) => s.tags === 25)).toBe(true);
  });

  it("aggregate path: the database's roll-up gives the same census", async () => {
    bigLibrary();
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(body.indexSource).toBe("aggregate");
    expect(net.rpcCalls).toContain("drawing_entity_rollup");
    expect(body.census.totalOccurrences).toBe(1500);
    expect(body.truncated).toBe(false);
  });

  it("past the ceiling the read stops at a whole document, says PARTIAL, and the audit refuses to record", async () => {
    bigLibrary();
    net.rpcMissing = true;
    vi.stubEnv("KNOWLEDGE_INDEX_MAX_ROWS", "1000");
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(body.truncated).toBe(true);
    expect(body.notCounted.length).toBeGreaterThan(0);
    // No sheet is counted in part: every counted sheet has all 25 tags.
    for (const s of body.sheets as Array<{ tags: number; notCounted: boolean }>) {
      expect(s.notCounted ? s.tags === 0 : s.tags === 25).toBe(true);
    }
    expect(body.suggestions[0]).toMatch(/PARTIAL/);
    const res = await post({ orgId: "o1", libraryId: "kl-1", action: "record-audit" });
    expect(res.status).toBe(409);
    expect(rowsOf("drawing_audit_logs")).toEqual([]);
    const csv = await get("orgId=o1&libraryId=kl-1&action=export");
    expect(csv.status).toBe(409);
  });
});

// ── DWG-6 / DWG-13 / DWG-10 / DWG-1 ─────────────────────────────────────────

/** Crude Unit (kl-1): three sheets of 025-PID, all referencing each other.
 *  Tank Farm (kl-2): 025-PID-0104 mirrored alone, plus two 040-TK sheets. */
function twoLibraries(over: { tankFarmHolds0105?: boolean } = {}) {
  const docs: Row[] = [
    kdoc("c-104", { name: "025-PID-0104.pdf", source_document_id: "d-104", source_version_id: "v-104c", source_rev: "C" }),
    kdoc("c-105", { name: "025-PID-0105.pdf", source_document_id: "d-105", source_version_id: "v-105a", source_rev: "A" }),
    kdoc("c-106", { name: "025-PID-0106.pdf", source_document_id: "d-106", source_version_id: "v-106b", source_rev: "B" }),
    kdoc("t-104", { library_id: "kl-2", name: "025-PID-0104.pdf", source_document_id: "d-104", source_version_id: "v-104c", source_rev: "C" }),
    kdoc("t-001", { library_id: "kl-2", name: "040-TK-0001.pdf" }),
    kdoc("t-002", { library_id: "kl-2", name: "040-TK-0002.pdf" }),
  ];
  if (over.tankFarmHolds0105) docs.push(kdoc("t-105", { library_id: "kl-2", name: "025-PID-0105.pdf" }));
  const ents: Row[] = [];
  const self = (id: string, n: string) => ents.push(ent(id, "self", n), ent(id, "self", `${n}-SH1`));
  self("c-104", "025-PID-0104"); self("c-105", "025-PID-0105"); self("c-106", "025-PID-0106");
  self("t-104", "025-PID-0104"); self("t-001", "040-TK-0001"); self("t-002", "040-TK-0002");
  if (over.tankFarmHolds0105) self("t-105", "025-PID-0105");
  for (const [from, to] of [["c-104", "025-PID-0105"], ["c-105", "025-PID-0104"], ["c-105", "025-PID-0106"], ["c-106", "025-PID-0105"],
    ["t-104", "025-PID-0105"], ["t-104", "025-PID-0107"], ["t-001", "040-TK-0002"], ["t-002", "040-TK-0001"]]) {
    ents.push(ent(from, "ref", to));
  }
  for (const d of docs) ents.push(ent(d.id as string, "equipment", "V-1"));
  for (const e of ents) e.library_id = docs.find((d) => d.id === e.document_id)!.library_id;
  seed({
    knowledge_documents: docs, knowledge_page_entities: ents,
    documents: [
      { id: "d-104", org_id: "o1", rev: "C", current_version_id: "v-104c" },
      { id: "d-105", org_id: "o1", rev: "A", current_version_id: "v-105a" },
      { id: "d-106", org_id: "o1", rev: "B", current_version_id: "v-106b" },
    ],
  });
}
const record = async (libraryId: string) => {
  const res = await post({ orgId: "o1", libraryId, action: "record-audit" });
  return { status: res.status, body: await res.json() };
};
const logRows = () => rowsOf("drawing_audit_logs");

describe("DWG-6 — a verdict belongs to the set it was computed over", () => {
  it("Crude Unit records 0104 passed; Tank Farm judges no gap in a series it holds one sheet of, and Crude Unit's verdict survives", async () => {
    twoLibraries();
    const a = await record("kl-1");
    expect(a.status).toBe(200);
    expect(a.body.recorded).toBe(3);
    const crude = logRows().find((r) => r.library_id === "kl-1" && r.sheet_number === "025-PID-0104")!;
    expect(crude).toMatchObject({ status: "passed", revision_code: "C", document_id: "d-104" });
    expect((crude.audit_details as { set: { sheets: string[] } }).set.sheets).toEqual(["025-PID-0104", "025-PID-0105", "025-PID-0106"]);
    expect(a.body.seriesNotJudged).toEqual([]);

    const b = await record("kl-2");
    expect(b.status).toBe(200);
    // 0104 is the only 025-PID sheet in Tank Farm. It IS recorded — for what
    // is its own — but its references to 0105 and 0107 are out of this set's
    // scope, never "isn't in the set" (the base filed a gap here).
    expect(b.body.notRecorded).toEqual([]);
    expect(b.body.seriesNotJudged).toEqual(["025-PID"]);
    const tank104 = logRows().find((r) => r.library_id === "kl-2" && r.sheet_number === "025-PID-0104")!;
    expect(tank104).toMatchObject({ status: "passed", revision_code: "C" });
    expect((tank104.audit_details as { missingReferences: string[]; set: { seriesNotJudged: string[] } }))
      .toMatchObject({ missingReferences: [], set: { seriesNotJudged: ["025-PID"] } });
    expect(logRows().filter((r) => r.library_id === "kl-2").map((r) => r.sheet_number).sort())
      .toEqual(["025-PID-0104", "040-TK-0001", "040-TK-0002"]);
    expect(logRows().find((r) => r.library_id === "kl-1" && r.sheet_number === "025-PID-0104")).toMatchObject({ status: "passed" });
  });

  it("a lone sheet's own defect is still recorded: a connector that names no drawing is broken in any set (fix pass)", async () => {
    twoLibraries();
    db.tables.knowledge_page_entities.push(ent("t-104", "opc", "7", 1, { library_id: "kl-2", raw: "OPC 7: DWG NONE — FROM DESALTER" }));
    await record("kl-2");
    const tank104 = logRows().find((r) => r.library_id === "kl-2" && r.sheet_number === "025-PID-0104")!;
    expect(tank104.status).toBe("broken_connectors");
    expect((tank104.audit_details as { brokenConnectors: string[] }).brokenConnectors[0]).toMatch(/Connector 7 names no destination/);
  });

  it("a single combined PDF, and a single-sheet library, are recorded (the base recorded them; round one dropped them)", async () => {
    seed({
      knowledge_documents: [kdoc("k-1", { name: "Crude PIDs.pdf", page_count: 3 })],
      knowledge_page_entities: [
        ent("k-1", "self", "025-PID-0101", 1), ent("k-1", "self", "025-PID-0102", 2), ent("k-1", "self", "025-PID-0103", 3),
        ent("k-1", "ref", "025-PID-0102", 1), ent("k-1", "ref", "025-PID-0104", 3), ent("k-1", "equipment", "V-1", 1),
      ],
    });
    const a = await record("kl-1");
    expect(a.body.notRecorded).toEqual([]);
    // The PDF holds the 025-PID series itself, so 0104 IS a gap in it.
    expect(logRows()).toEqual([expect.objectContaining({ sheet_number: "025-PID-0101", status: "flagged" })]);
    expect((logRows()[0].audit_details as { missingReferences: string[] }).missingReferences[0]).toMatch(/025-PID-0104/);

    seed({
      knowledge_documents: [kdoc("s-1", { name: "025-PID-0101.pdf" })],
      knowledge_page_entities: [ent("s-1", "self", "025-PID-0101"), ent("s-1", "ref", "025-PID-0102"), ent("s-1", "equipment", "V-1")],
    });
    const b = await record("kl-1");
    expect(b.body.recorded).toBe(1);
    expect(logRows()).toEqual([expect.objectContaining({ sheet_number: "025-PID-0101", status: "passed" })]);
  });

  it("when both libraries hold the series, each keeps its own row for the same sheet and revision", async () => {
    twoLibraries({ tankFarmHolds0105: true });
    await record("kl-1");
    await record("kl-2");
    const rows104 = logRows().filter((r) => r.sheet_number === "025-PID-0104" && r.revision_code === "C");
    expect(rows104.map((r) => [r.library_id, r.status]).sort()).toEqual([["kl-1", "passed"], ["kl-2", "flagged"]]);
    // The narrower library's gap (0107 is not in Tank Farm) is Tank Farm's alone.
    expect((rows104.find((r) => r.library_id === "kl-2")!.audit_details as { missingReferences: string[] }).missingReferences[0]).toMatch(/025-PID-0107/);
  });
});

describe("DWG-13 — an unrevised sheet is never re-audited, and the response says so", () => {
  it("a sheet whose revision is unknown is re-audited every time, and its row takes the latest verdict (fix pass)", async () => {
    // Library-only PDFs (no controlled document): revision "".
    seed({
      knowledge_documents: [kdoc("u-101", { name: "025-PID-0101.pdf" }), kdoc("u-102", { name: "025-PID-0102.pdf" })],
      knowledge_page_entities: [
        ent("u-101", "self", "025-PID-0101"), ent("u-102", "self", "025-PID-0102"),
        ent("u-101", "ref", "025-PID-0107"), ent("u-101", "ref", "025-PID-0102"), ent("u-102", "ref", "025-PID-0101"),
        ent("u-101", "equipment", "V-1"), ent("u-102", "equipment", "V-2"),
      ],
    });
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0101")).toMatchObject({ revision_code: "", status: "flagged" });
    // 0107 arrives: the set is widened.
    db.tables.knowledge_documents.push(kdoc("u-107", { name: "025-PID-0107.pdf" }));
    db.tables.knowledge_page_entities.push(ent("u-107", "self", "025-PID-0107"), ent("u-107", "ref", "025-PID-0101"), ent("u-107", "equipment", "V-7"));
    const again = await record("kl-1");
    expect(again.body.alreadyRecorded).toEqual([]);
    const rows101 = logRows().filter((r) => r.sheet_number === "025-PID-0101");
    expect(rows101).toHaveLength(1);
    expect(rows101[0]).toMatchObject({ revision_code: "", status: "passed" });
    // …but a sheet that cannot be read right now never erases its verdict.
    // (Its indexing failed: a sheet still being indexed refuses the whole
    // record — review fix pass 4.)
    db.tables.knowledge_documents.find((d) => d.id === "u-102")!.status = "error";
    db.tables.knowledge_page_entities.push(ent("u-102", "opc", "4", 1, { raw: "OPC 4: DWG NONE — TO FLARE" }));
    const third = await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0102")).toMatchObject({ status: "passed" });
    expect(third.body.keptStored).toEqual([expect.objectContaining({ sheetNumber: "025-PID-0102", stored: "passed", computed: "skipped" })]);
  });

  it("a second record writes nothing and lists every sheet as already recorded at its revision", async () => {
    twoLibraries();
    await record("kl-1");
    const writesBefore = db.ops.filter((o) => o.table === "drawing_audit_logs" && o.kind === "upsert").length;
    const again = await record("kl-1");
    expect(again.body.recorded).toBe(0);
    expect(again.body.alreadyRecorded.map((a: { sheetNumber: string }) => a.sheetNumber).sort())
      .toEqual(["025-PID-0104", "025-PID-0105", "025-PID-0106"]);
    expect(db.ops.filter((o) => o.table === "drawing_audit_logs" && o.kind === "upsert").length).toBe(writesBefore);
  });

  it("a 'skipped' verdict is re-audited once the sheet can be read — re-stamped, never lowered", async () => {
    twoLibraries();
    // Its indexing failed (a sheet still being indexed refuses the whole
    // record — review fix pass 4); it declares its number, so its skip is
    // filed under it.
    db.tables.knowledge_documents.find((d) => d.id === "c-106")!.status = "error";
    await record("kl-1");
    const first = logRows().find((r) => r.library_id === "kl-1" && r.sheet_number === "025-PID-0106")!;
    expect(first.status).toBe("skipped");
    first.audited_at = "2026-09-01T00:00:00.000Z";
    db.tables.knowledge_documents.find((d) => d.id === "c-106")!.status = "ready";
    const again = await record("kl-1");
    // 0106 is re-audited — and so are 0104 and 0105: the set they were
    // judged against held a sheet not read whole, and now does not (review
    // fix pass 4). Same verdicts, re-stamped.
    expect(again.body.recorded).toBe(3);
    expect(logRows().filter((r) => r.library_id === "kl-1").map((r) => [r.sheet_number, r.status]).sort())
      .toEqual([["025-PID-0104", "passed"], ["025-PID-0105", "passed"], ["025-PID-0106", "passed"]]);
    expect((await record("kl-1")).body.recorded).toBe(0);
    const now = logRows().find((r) => r.library_id === "kl-1" && r.sheet_number === "025-PID-0106")!;
    expect(now.status).toBe("passed");
    expect(now.audited_at).not.toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("DWG-10 — the number on the record is the number on screen", () => {
  it("a sheet-addressed self row coming back first changes neither", async () => {
    twoLibraries();
    // Put the -SH1 row physically first for c-104.
    const ents = db.tables.knowledge_page_entities;
    const i = ents.findIndex((e) => e.document_id === "c-104" && e.tag === "025-PID-0104-SH1");
    ents.unshift(...ents.splice(i, 1));
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.sheets.find((s: { id: string }) => s.id === "c-104").declared).toBe("025-PID-0104");
    await record("kl-1");
    expect(logRows().some((r) => r.sheet_number === "025-PID-0104-SH1")).toBe(false);
    expect(logRows().some((r) => r.sheet_number === "025-PID-0104")).toBe(true);
  });
});

describe("DWG-1 (criteria 3 and 4, handed over by I-06) — the revision filed is the revision indexed", () => {
  it("a mirror indexed from an older version is reported skipped with the reason and NOT recorded", async () => {
    twoLibraries();
    db.tables.documents[0].current_version_id = "v-104d";
    db.tables.documents[0].rev = "D";
    const a = await record("kl-1");
    expect(a.body.notRecorded).toEqual([expect.objectContaining({
      name: "025-PID-0104.pdf", status: "skipped", reason: expect.stringMatching(/earlier version \(C\).*current one \(D\)/),
    })]);
    expect(logRows().some((r) => r.sheet_number === "025-PID-0104")).toBe(false);
    // The response files no verdict for it either.
    expect(a.body.sheets.map((s: { sheetNumber: string }) => s.sheetNumber)).not.toContain("025-PID-0104");
    expect(a.body.sheets.map((s: { sheetNumber: string }) => s.sheetNumber).sort()).toEqual(["025-PID-0105", "025-PID-0106"]);
    expect(a.body.recorded).toBe(2);
  });

  it("an indexed label that disagrees with the controlled document's is refused; a match files source_rev", async () => {
    twoLibraries();
    db.tables.documents[0].rev = "C1";
    const a = await record("kl-1");
    expect(a.body.notRecorded[0].reason).toMatch(/indexed revision \(C\) disagrees with the controlled document's \(C1\)/);
    db.tables.documents[0].rev = " c ";
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")!.revision_code).toBe("C");
  });
});

describe("before 20261124 the audit is still recorded, on the key that database has (review fix pass 2)", () => {
  it("on a database without library_id: the org-wide key, never lowered, and the route says so", async () => {
    twoLibraries();
    db.missingColumns.drawing_audit_logs = ["library_id"];
    const a = await record("kl-1");
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ recorded: 3, legacyKey: true, notice: expect.stringMatching(/20261124/) });
    // The base's write path: upsert on (org, sheet, revision), no library_id column.
    const ups = db.ops.filter((o) => o.table === "drawing_audit_logs" && o.kind === "upsert");
    expect(ups).toHaveLength(1);
    expect((ups[0].payload as Row[]).every((r) => !("library_id" in r))).toBe(true);
    expect(logRows().map((r) => r.sheet_number).sort()).toEqual(["025-PID-0104", "025-PID-0105", "025-PID-0106"]);
    // The library is still on the record.
    expect((logRows()[0].audit_details as { libraryId: string }).libraryId).toBe("kl-1");
    // A narrower library computes 0104 against a different set; the stored
    // verdict on the shared key is never lowered (the base overwrote it).
    logRows().find((r) => r.sheet_number === "025-PID-0104")!.status = "flagged";
    const b = await record("kl-2");
    expect(b.status).toBe(200);
    expect(logRows().filter((r) => r.sheet_number === "025-PID-0104")).toEqual([expect.objectContaining({ status: "flagged" })]);
    expect(b.body.keptStored).toEqual([expect.objectContaining({ sheetNumber: "025-PID-0104", stored: "flagged", computed: "passed" })]);
  });
});

// ── ING-1 / ING-8 / ING-12 — the rebuild is the one reset ───────────────────

describe("the rebuild goes through resetKnowledgeIndex (DEC-58 handoff)", () => {
  it("zeroes every counter under the claim, clears chunks and entities, and leaves a document another driver holds alone", async () => {
    seed({
      knowledge_documents: [
        kdoc("r-1", { name: "A.pdf", vision_pages: 7, ingest_failures: 2, vision_retry_after: "2026-10-01T05:00:00Z", error: "x", vision_failed_pages: [3] }),
        kdoc("r-2", { name: "B.pdf", ingest_claimed_by: "ingest:other", ingest_claimed_at: new Date().toISOString() }),
      ],
      knowledge_page_entities: [ent("r-1", "equipment", "V-1"), ent("r-2", "equipment", "V-2")],
      knowledge_chunks: [chunk("r-1", "text"), chunk("r-2", "text")],
    });
    // The panel's call: it follows the cursor and shows `busy` itself.
    const res = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild", cursor: null });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ docs: 1, busy: ["B.pdf"], errors: [], remaining: 0, ok: false });
    const r1 = rowsOf("knowledge_documents").find((d) => d.id === "r-1")!;
    expect(r1).toMatchObject({
      status: "stale", pages_indexed: 0, vision_pages: 0, ingest_failures: 0, vision_retry_after: null,
      error: null, vision_failed_pages: [], ingest_claimed_by: null,
    });
    expect(rowsOf("knowledge_page_entities").map((e) => e.document_id)).toEqual(["r-2"]);
    expect(rowsOf("knowledge_chunks").map((c) => c.document_id)).toEqual(["r-2"]);
    // The held document is untouched.
    expect(rowsOf("knowledge_documents").find((d) => d.id === "r-2")).toMatchObject({ status: "ready", ingest_claimed_by: "ingest:other" });
    expect(INGEST_LEASE_TTL_MS).toBeGreaterThan(0);
  });

  it("a continuation cursor never resets the same document twice", async () => {
    seed({ knowledge_documents: [kdoc("a-1"), kdoc("a-2"), kdoc("a-3")] });
    const res = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild", cursor: "a-2" });
    expect((await res.json()).docs).toBe(1);
    expect(rowsOf("knowledge_documents").filter((d) => d.status === "stale").map((d) => d.id)).toEqual(["a-3"]);
  });

  it("a caller that sends no cursor (the library page's Re-index all) can never read a partial reset as done (fix pass)", async () => {
    seed({
      knowledge_documents: [
        kdoc("r-1", { name: "A.pdf" }),
        kdoc("r-2", { name: "B.pdf", ingest_claimed_by: "ingest:other", ingest_claimed_at: new Date().toISOString() }),
      ],
    });
    const res = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild" });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ partial: true, docs: 1, busy: ["B.pdf"] });
    expect(body.error).toMatch(/Re-index is not complete: 1 of 2 document\(s\) were queued .*1 were being indexed right then and were left alone \(B\.pdf\)/);
    // A complete reset still answers 200 to that caller.
    seed({ knowledge_documents: [kdoc("r-3", { name: "C.pdf" })] });
    const ok = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ docs: 1, remaining: 0 });
  });

  it("a budget spent before the first reset answers the cursor it was given, not a crash (fix pass)", async () => {
    seed({ knowledge_documents: [kdoc("a-1"), kdoc("a-2"), kdoc("a-3")] });
    const real = Date.now.bind(Date);
    let calls = 0;
    // The listing alone outlasts the 40 s budget: every clock read is a
    // minute after the one before it.
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + 60_000 * calls++);
    try {
      const res = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild", cursor: "a-1" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ docs: 0, remaining: 2, cursor: "a-1" });
      const first = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild", cursor: null });
      expect(await first.json()).toMatchObject({ docs: 0, remaining: 3, cursor: null });
    } finally { spy.mockRestore(); }
    expect(rowsOf("knowledge_documents").filter((d) => d.status === "stale")).toEqual([]);
  });
});

// ── ING-6 / DWG-7 / DWG-4 — what the lens says ──────────────────────────────

describe("the lens tells parked, drawing and prose sheets apart", () => {
  it("a parked document is indexing, with the pages it waits on and why — never ready", async () => {
    seed({
      knowledge_documents: [
        kdoc("p-1", { status: "indexing", vision_failed_pages: [7, 3], vision_retry_after: "2026-10-01T05:00:00Z", error: "2 pages could not be read by AI vision (overloaded)" }),
        kdoc("p-2", { status: "ready", error: "a failed batch is backing off" }),
        kdoc("p-3"),
        kdoc("p-4", { vision_partial_accepted: true, vision_failed_pages: [5] }),
      ],
      knowledge_page_entities: [ent("p-1", "equipment", "V-1"), ent("p-2", "equipment", "V-2"), ent("p-3", "equipment", "V-3"), ent("p-4", "equipment", "V-4")],
      knowledge_chunks: [chunk("p-1", "V-1"), chunk("p-2", "V-2"), chunk("p-3", "V-3"), chunk("p-4", "V-4")],
    });
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    const p1 = body.sheets.find((s: { id: string }) => s.id === "p-1");
    expect(p1.verdict).toBe("indexing");
    expect(p1.waiting).toEqual({ pages: [3, 7], reason: "2 pages could not be read by AI vision (overloaded)", retryAfter: "2026-10-01T05:00:00Z" });
    expect(body.sheets.find((s: { id: string }) => s.id === "p-2").verdict).toBe("indexing");
    // An accepted partial index is finished — its unread pages listed, not "waiting".
    expect(body.sheets.find((s: { id: string }) => s.id === "p-4")).toMatchObject({ verdict: "text", waiting: null, acceptedUnread: [5] });
    expect(body.readyCount).toBe(2);
    expect(body.suggestions.join(" ")).toMatch(/2 sheet\(s\) are still waiting on AI vision/);
  });

  it("text with no tags says drawing (capitals, a title block) or prose — and the advice differs", async () => {
    seed({
      knowledge_documents: [kdoc("x-1"), kdoc("x-2")],
      // What ingest writes for a TrueType title block on a sparse page: the
      // border's number as the sheet's identity AND, ref-shaped, as a ref
      // row (extractDrawingRefs over every text item) — review fix pass 3.
      knowledge_page_entities: [ent("x-1", "self", "025-PID-0104"), ent("x-1", "ref", "025-PID-0104")],
      knowledge_chunks: [
        chunk("x-1", "DRAWING NO: 025-PID-0104 GENERAL ARRANGEMENT NOTES ALL DIMENSIONS IN MM"),
        chunk("x-2", "The bolting requirements apply to every flanged joint in this service."),
      ],
    });
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    const by = (id: string) => body.sheets.find((s: { id: string }) => s.id === id);
    // Its own number is the sheet itself, never a reference to another drawing.
    expect(by("x-1")).toMatchObject({ verdict: "text-no-tags", looksLike: "drawing", shxLike: true });
    expect(by("x-2")).toMatchObject({ verdict: "text-no-tags", looksLike: "prose", shxLike: false });
    const said = body.suggestions.join(" ");
    // The cheaper remedy first: a keyed rebuild USUALLY reads such pages page
    // by page — not always (review fix pass 4).
    expect(said).toMatch(/1 sheet\(s\) look like SHX exports[\s\S]*Hit "Rebuild index" with your AI key saved: a page with almost no text and no tags is usually read by AI vision during indexing, page by page/);
    expect(said).not.toMatch(/a page like that is read by AI vision/);
    // …then the one remaining remedy, conditionally, with its billing.
    expect(said).toMatch(/If a rebuild with your key saved still leaves these sheets unread, the remaining switch is library-wide[\s\S]*index every page as an image/);
    expect(said).not.toMatch(/normal for prose documents/);
  });

  it("an all-SHX library whose title blocks read like sentences: no page is vision-read on a rebuild, and the every-page switch is still offered (review fix pass 4)", async () => {
    // The reviewer's probe: an SHX title block's "DRAWING NO. … REV. … DWG.
    // … CHK'D." has more than two sentence enders, so pageNeedsVision passes
    // the page over; numbered notes do the same. No document here was ever
    // vision-read — fix pass 3 then never offered the only remedy.
    const titleBlock = "DRAWING NO. 025-PID-0104\nREV. A\nSCALE NTS\nDWG. BY JS\nCHK'D. AB\nTITLE CRUDE UNIT PIPING AND INSTRUMENT DIAGRAM\nACME REFINING CO";
    const tags = extractEquipmentTags(titleBlock).length + extractDrawingRefs(titleBlock).length;
    expect(tags).toBe(1);
    expect(isDrawingLikePage(titleBlock)).toBe(true);
    expect(pageNeedsVision(titleBlock, tags)).toBe(false);
    seed({
      knowledge_documents: [kdoc("x-1", { name: "025-PID-0104.pdf" }), kdoc("x-2", { name: "025-PID-0105.pdf" })],
      knowledge_page_entities: [
        ent("x-1", "self", "025-PID-0104"), ent("x-1", "ref", "025-PID-0104"),
        ent("x-2", "self", "025-PID-0105"), ent("x-2", "ref", "025-PID-0105"),
      ],
      knowledge_chunks: [chunk("x-1", titleBlock), chunk("x-2", titleBlock.replace("0104", "0105"))],
    });
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(body.sheets.map((s: { shxLike: boolean }) => s.shxLike)).toEqual([true, true]);
    const said = body.suggestions.join(" ");
    expect(said).toMatch(/2 sheet\(s\) look like SHX exports[\s\S]*usually read by AI vision[\s\S]*a page whose title block or notes read like sentences can be passed over/);
    expect(said).toMatch(/If a rebuild with your key saved still leaves these sheets unread[\s\S]*Text doesn't extract from these files — index every page as an image/);
    // The switch is library-wide and bills: said plainly.
    expect(said).toMatch(/reads EVERY page of EVERY document in this library with AI vision and bills each page to your key/);
  });

  it("a drawing sheet whose text layer gave references (a legend, an index) is never told to vision-read the library (review fix pass 2)", async () => {
    const dense = `DRAWING NO: 025-PID-0001 SHEET 1 OF 1 REV 0 ${"LEGEND SYMBOLS VALVE GATE GLOBE CHECK BALL ".repeat(40)}`;
    seed({
      knowledge_documents: [kdoc("l-1", { name: "Index.pdf" }), kdoc("l-2", { name: "Legend.pdf" })],
      knowledge_page_entities: [
        // The drawing index: a title block and references to every sheet.
        ent("l-1", "self", "025-PID-0000"), ent("l-1", "ref", "025-PID-0104"), ent("l-1", "ref", "025-PID-0105"),
        // A dense legend: lots of capital text, no tags, past the thin line.
        ent("l-2", "self", "025-PID-0001"),
      ],
      knowledge_chunks: [chunk("l-1", "DRAWING NO: 025-PID-0000 DRAWING INDEX 025-PID-0104 025-PID-0105"), chunk("l-2", dense)],
    });
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    const by = (id: string) => body.sheets.find((s: { id: string }) => s.id === id);
    expect(by("l-1")).toMatchObject({ verdict: "text-no-tags", looksLike: "drawing", shxLike: false });
    expect(by("l-2")).toMatchObject({ verdict: "text-no-tags", looksLike: "drawing", shxLike: false });
    expect(body.suggestions.join(" ")).not.toMatch(/index every page as an image/);
  });

  it("box pairing with no box numbers says it has no input instead of showing a clean zero", async () => {
    twoLibraries();
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(body.opcBoxCount).toBe(0);
    expect(body.opcPairing).toBe("no-boxes");
    const said = body.suggestions.join(" ");
    expect(said).toMatch(/Connector box pairing has no input here/);
    // A text-layer set is never told to pay for every page to be read as an image (fix pass).
    expect(said).not.toMatch(/index every page as an image/);
    expect(said).not.toMatch(/rebuilding re-reads them/);
  });

  it("a set already read by AI vision before the connector contract is told a rebuild re-reads its boxes — and re-bills", async () => {
    twoLibraries();
    db.tables.knowledge_documents.find((d) => d.id === "c-105")!.vision_pages = 1;
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(body.suggestions.join(" ")).toMatch(/1 sheet\(s\) were read by AI vision before connector lines were transcribed; rebuilding re-reads them with box numbers \(and bills those pages again\)/);
  });

  it("a sheet past the text-stats read is not counted — never 'Nothing read', never sent to vision (fix pass)", async () => {
    const docs: Row[] = [];
    const ents: Row[] = [];
    const chunks: Row[] = [];
    for (let d = 0; d < 6; d++) {
      const id = `t-${d}`;
      docs.push(kdoc(id));
      ents.push(ent(id, "equipment", `V-${d}`));
      for (let c = 0; c < 300; c++) chunks.push(chunk(id, "V-1 SUCTION DRUM"));
    }
    seed({ knowledge_documents: docs, knowledge_page_entities: ents, knowledge_chunks: chunks });
    net.rpcMissing = true;                          // before 20261124: chunks read whole
    vi.stubEnv("KNOWLEDGE_INDEX_MAX_ROWS", "1000");
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(body.truncated).toBe(true);
    const unread = (body.sheets as Array<{ id: string; verdict: string; notCounted: boolean }>).filter((s) => s.notCounted);
    expect(unread.length).toBeGreaterThan(0);
    expect(unread.every((s) => s.verdict === "not-counted")).toBe(true);
    expect(body.sheets.some((s: { verdict: string }) => s.verdict === "empty")).toBe(false);
    expect(body.textlessCount).toBe(0);
    expect(body.suggestions.join(" ")).not.toMatch(/no machine-readable text/);
    expect(body.notCounted).toEqual(expect.arrayContaining(unread.map((s) => `${s.id}.pdf`)));
  });

  it("before 20261124 the text statistics COUNT chunks and never ship their content (review fix pass 2)", async () => {
    seed({
      knowledge_documents: [kdoc("q-1"), kdoc("q-2"), kdoc("q-3")],
      knowledge_page_entities: [ent("q-1", "equipment", "V-1")],
      knowledge_chunks: [chunk("q-1", "V-1 SUCTION DRUM"), chunk("q-2", "Some text with no tags at all.")],
    });
    net.rpcMissing = true;
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    const chunkReads = db.ops.filter((o) => o.table === "knowledge_chunks" && o.kind === "select");
    expect(chunkReads.length).toBeGreaterThan(0);
    expect(chunkReads.every((o) => JSON.stringify(o.columns) === JSON.stringify(["document_id"]))).toBe(true);
    expect(body.textStats).toBe("counts");
    const by = (id: string) => body.sheets.find((s: { id: string }) => s.id === id);
    // Counted: a sheet with chunks has text, one without is textless…
    expect(by("q-2")).toMatchObject({ verdict: "text-no-tags", looksLike: "unknown", chars: null, shxLike: false });
    expect(by("q-3")).toMatchObject({ verdict: "empty" });
    expect(body.textlessCount).toBe(1);
    // …and never advised to buy vision on a guess about letter case.
    expect(body.suggestions.join(" ")).not.toMatch(/look like SHX exports/);
    // With 20261124 the readout is measured.
    net.rpcMissing = false;
    const measured = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(measured.textStats).toBe("measured");
    expect(measured.sheets.find((s: { id: string }) => s.id === "q-2")).toMatchObject({ looksLike: "prose", chars: 30 });
  });

  it("an accepted partial index is never recorded passed: the unread pages are a finding (fix pass)", async () => {
    twoLibraries();
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-105")!, { vision_partial_accepted: true, vision_failed_pages: [6, 5] });
    await record("kl-1");
    const row = logRows().find((r) => r.sheet_number === "025-PID-0105")!;
    expect(row.status).toBe("flagged");
    expect((row.audit_details as { unreadPages: string[] }).unreadPages[0]).toMatch(/Page\(s\) 5, 6 were never read by AI vision/);
  });
});

// ── locate ──────────────────────────────────────────────────────────────────

function locateSheet(over: { agreement?: boolean; spent?: number } = {}) {
  seed({
    knowledge_documents: [
      kdoc("s-1", { name: "025-PID-0104.pdf", source_rev: "C", vision_pages: 1 }),
      kdoc("s-2", { name: "025-PID-0105.pdf" }),
      kdoc("s-3", { name: "025-PID-0106.pdf" }),
    ],
    knowledge_page_entities: [
      ent("s-1", "equipment", "V-3"), ent("s-1", "equipment", "P-101A"),
      ent("s-1", "equipment", "E-9", 1, { nx: 0.2, ny: 0.3, pos_source: "text" }),
      // 025-PID-0106 is cited on s-2 (a ref) and IS s-3 (its self row, page 2).
      ent("s-2", "ref", "025-PID-0106", 1), ent("s-3", "self", "025-PID-0106", 2),
    ],
    ai_connections: [{ org_id: "o1", user_id: "u-ctrl", provider: "anthropic", model: "m", api_key: "k" }],
    ai_key_agreements: over.agreement === false ? [] : [{ id: "ag-1", org_id: "o1", user_id: "u-ctrl", scope: "use", agreement_version: AGREEMENT_VERSION }],
    ai_usage_events: over.spent ? [{ id: "u-1", org_id: "o1", user_id: "u-ctrl", est_cost_usd: over.spent, created_at: "2026-10-01T01:00:00Z" }] : [],
  });
}
const U = { inputTokens: 1000, outputTokens: 50 };

describe("DWG-5 / GOV-8 — every locate call is metered, once, after the last", () => {
  it("one coarse pass + four close-ups = five calls, one metering row covering all five, written after the last call", async () => {
    locateSheet();
    ai.script = [
      { text: '{"V-3": [0.5, 0.5], "P-101A": [0.2, 0.8]}', usage: U },
      { text: '{"V-3": [0.5, 0.5]}', usage: U }, { text: '{"V-3": [0.5, 0.5]}', usage: U },
      { text: '{"P-101A": [0.5, 0.5]}', usage: U }, { text: '{"P-101A": [0.5, 0.5]}', usage: U },
    ];
    const body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["V-3", "P-101A"] })).json();
    expect(ai.calls).toHaveLength(5);
    expect(vi.mocked(recordAskUsage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordAskUsage).mock.calls[0][0]).toMatchObject({
      op: "drawingLocate", ok: true, usage: { inputTokens: 5000, outputTokens: 250 },
    });
    expect(ai.log.at(-1)).toBe("meter");
    expect(body.positions.find((p: { tag: string }) => p.tag === "V-3")).toMatchObject({ source: "vision", approximate: true, readOnRevision: "C" });
  });

  it("the cap is re-consulted before each extra call: a coarse pass that reaches it stops the refining", async () => {
    const big = { inputTokens: 200_000, outputTokens: 100 };
    // The connection's provider is anthropic: the route prices the call by
    // that provider's (mocked, placeholder) vision model.
    const cost = estimateCostUsd(VISION_MODEL.anthropic, big);
    locateSheet({ spent: 1 });
    vi.mocked(getCapUsd).mockResolvedValue(1 + cost * 1.5);   // room for the coarse pass, not for two more
    ai.script = [{ text: '{"V-3": [0.5, 0.5]}', usage: big }, { text: '{"V-3": [0.5, 0.5]}', usage: big }];
    await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["V-3"] });
    expect(ai.calls).toHaveLength(2);   // coarse + ONE close-up; the second close-up would cross the cap
    expect(vi.mocked(recordAskUsage).mock.calls[0][0].usage).toEqual({ inputTokens: 400_000, outputTokens: 200 });
  });

  it("a refine call that throws still counts the usage it carries; the coarse point is kept", async () => {
    locateSheet();
    ai.script = [{ text: '{"V-3": [0.5, 0.5]}', usage: U }, { throws: "overloaded", usage: { inputTokens: 700, outputTokens: 0 } }];
    const body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["V-3"] })).json();
    expect(vi.mocked(recordAskUsage).mock.calls[0][0].usage).toEqual({ inputTokens: 1700, outputTokens: 50 });
    expect(body.positions.find((p: { tag: string }) => p.tag === "V-3")).toMatchObject({ nx: 0.5, ny: 0.5 });
  });

  it("a user over this month's cap — counting every op, not only asks — sends nothing", async () => {
    locateSheet({ spent: 9.5 });
    vi.mocked(getCapUsd).mockResolvedValue(9);
    const body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["V-3"] })).json();
    expect(body.skipped).toMatch(/Monthly AI budget reached/);
    expect(ai.calls).toHaveLength(0);
    expect(vi.mocked(recordAskUsage)).not.toHaveBeenCalled();
  });

  it("an unreadable ledger refuses rather than assume $0; an unsigned agreement sends nothing", async () => {
    locateSheet();
    db.hooks.push((op) => (op.table === "ai_usage_events" && op.kind === "select" ? { error: { code: "XX000", message: "down" } } : undefined));
    let body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["V-3"] })).json();
    expect(body.skipped).toMatch(/Couldn't read your AI usage/);
    locateSheet({ agreement: false });
    body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["V-3"] })).json();
    expect(body).toMatchObject({ agreementRequired: true, agreementVersion: AGREEMENT_VERSION });
    expect(ai.calls).toHaveLength(0);
  });
});

describe("DWG-13 / PR-10 — the relocate round: a refuted point is never cached", () => {
  it("a close-up that does not see the tag triggers buildRelocateUser; the relocated point is cached as an estimate", async () => {
    locateSheet();
    ai.script = [
      { text: '{"V-3": [0.5, 0.05]}', usage: U },   // the equipment summary row
      { text: "{}", usage: U },                      // close-up: not there
      { text: '{"V-3": [0.3, 0.6]}', usage: U },     // relocate
    ];
    const body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["V-3"] })).json();
    expect(ai.calls[2].user).toMatch(/A previous attempt placed V-3 at \[0\.50, 0\.05\] — but a close-up of that spot does NOT show/);
    expect(body.positions.find((p: { tag: string }) => p.tag === "V-3")).toMatchObject({ nx: 0.3, ny: 0.6, approximate: true });
    expect(rowsOf("knowledge_page_entities").find((e) => e.tag === "V-3")).toMatchObject({ nx: 0.3, ny: 0.6, pos_source: "vision" });
    expect(vi.mocked(recordAskUsage).mock.calls[0][0].usage.inputTokens).toBe(3000);
  });

  it("when the relocate round finds nothing either, the tag is not visible and nothing is cached", async () => {
    locateSheet();
    ai.script = [{ text: '{"V-3": [0.5, 0.05]}', usage: U }, { text: "{}", usage: U }, { text: "{}", usage: U }];
    const body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["V-3"] })).json();
    expect(body.notVisible).toEqual(["V-3"]);
    expect(rowsOf("knowledge_page_entities").find((e) => e.tag === "V-3")).toMatchObject({ nx: null, pos_source: null });
  });

  it("a point no close-up checked (past REFINE_MAX) is cached as the coarse estimate it is — approximate, rejectable", async () => {
    locateSheet();
    const extra = ["V-10", "V-11", "V-12", "V-13"];
    db.tables.knowledge_page_entities.push(...extra.map((t) => ent("s-1", "equipment", t)));
    const tags = ["V-3", "P-101A", ...extra];
    ai.script = [
      { text: JSON.stringify(Object.fromEntries(tags.map((t, i) => [t, [0.1 + i * 0.1, 0.5]]))), usage: U },
      // Two close-ups for each of the first four tags, all confirming.
      ...tags.slice(0, 4).flatMap((t) => [{ text: JSON.stringify({ [t]: [0.5, 0.5] }), usage: U }, { text: JSON.stringify({ [t]: [0.5, 0.5] }), usage: U }]),
    ];
    const body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags })).json();
    expect(ai.calls).toHaveLength(9);
    // V-12 / V-13 never got a close-up: their coarse points ship and cache as estimates.
    for (const t of ["V-12", "V-13"]) {
      expect(body.positions.find((p: { tag: string }) => p.tag === t)).toMatchObject({ source: "vision", approximate: true });
      expect(rowsOf("knowledge_page_entities").find((e) => e.tag === t)).toMatchObject({ pos_source: "vision" });
    }
  });

  it("a viewer can reject an AI estimate — and only an estimate", async () => {
    locateSheet();
    const v3 = rowsOf("knowledge_page_entities").find((e) => e.tag === "V-3")!;
    Object.assign(v3, { nx: 0.5, ny: 0.05, pos_source: "vision" });
    let body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["V-3"], action: "reject" })).json();
    expect(body.cleared).toBe(1);
    expect(v3).toMatchObject({ nx: null, ny: null, pos_source: null });
    body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["E-9"], action: "reject" })).json();
    expect(body.cleared).toBe(0);
    expect(rowsOf("knowledge_page_entities").find((e) => e.tag === "E-9")).toMatchObject({ nx: 0.2, pos_source: "text" });
  });
});

describe("DWG-12 — 'where else' answers with the sheet that IS the number, never one that cites it", () => {
  it("a drawing number cited on another sheet (a ref) jumps to the sheet that declares it", async () => {
    locateSheet();
    const body = await (await locate({ orgId: "o1", documentId: "s-1", page: 1, tags: ["025-PID-0106"] })).json();
    expect(body.elsewhere).toEqual([expect.objectContaining({ tag: "025-PID-0106", documentId: "s-3", page: 2 })]);
  });
});

// ── review fix pass 2 ───────────────────────────────────────────────────────

describe("DWG-4 — a connector into a sheet with no box numbers read is unpaired, never broken (review fix pass 2)", () => {
  it("the lens lists it as not paired, and the record files the source flagged — never broken_connectors", async () => {
    twoLibraries();
    // 0104 is vision-read under the contract; 0105 (a text layer, or read
    // before connector boxes were transcribed) carries no opc rows at all.
    db.tables.knowledge_page_entities.push(ent("c-104", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" }));
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnreturned).toEqual([]);
    expect(lens.opcNoRef).toEqual([]);
    expect(lens.opcUnpaired).toEqual([expect.objectContaining({ box: "14", from: "025-PID-0104.pdf", to: "025-PID-0105.pdf" })]);
    expect(lens.suggestions.join(" ")).toMatch(/1 connector box\(es\) could not be paired[\s\S]*NOT counted as broken/);
    await record("kl-1");
    const row = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(row.status).toBe("flagged");
    expect((row.audit_details as { unpairedConnectors: string[] }).unpairedConnectors[0])
      .toMatch(/Connector 14 continues to 025-PID-0105\.pdf, whose box numbers were never read/);
  });

  it("a sheet-only connector (DWG SAME SH n) pairs inside its own drawing — a missing box there is the broken one", async () => {
    const docs: Row[] = [kdoc("d-3", { name: "SH3.pdf" }), kdoc("d-4", { name: "SH4.pdf" })];
    seed({
      knowledge_documents: docs,
      knowledge_page_entities: [
        ent("d-3", "self", "2002-D-2001"), ent("d-3", "self", "2002-D-2001-SH3"), ent("d-3", "equipment", "V-1"),
        ent("d-4", "self", "2002-D-2001"), ent("d-4", "self", "2002-D-2001-SH4"), ent("d-4", "equipment", "V-2"),
        ent("d-3", "opc", "14", 1, { raw: "OPC 14: DWG SAME SH 4 — TO V-1402" }),
        ent("d-4", "opc", "15", 1, { raw: "OPC 15: DWG SAME SH 3 — FROM V-1401" }),
      ],
    });
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcNoRef).toEqual([]);
    // SH4's boxes were read and 14 is not among them; SH3's carry no 15.
    expect(lens.opcUnreturned.map((u: { box: string }) => u.box).sort()).toEqual(["14", "15"]);
  });
});

describe("DWG-13 — 'already recorded' means the row covered this sheet, from this index (review fix pass 2)", () => {
  /** 2002-D-2001 SH1 and SH2: separate controlled documents, both Rev 0 —
   *  both filed under the drawing's number. */
  function siblingSheets() {
    seed({
      knowledge_documents: [
        kdoc("s-1", { name: "2002-D-2001 SH1.pdf", source_document_id: "d-s1", source_version_id: "v-s1", source_rev: "0" }),
        // Parked: waiting on AI vision for its page (a sheet still being
        // indexed refuses the whole record — review fix pass 4).
        kdoc("s-2", {
          name: "2002-D-2001 SH2.pdf", source_document_id: "d-s2", source_version_id: "v-s2", source_rev: "0", status: "indexing",
          vision_failed_pages: [1], vision_retry_after: "2026-10-01T05:00:00Z", error: "1 page could not be read by AI vision (overloaded)",
        }),
      ],
      knowledge_page_entities: [
        ent("s-1", "self", "2002-D-2001"), ent("s-1", "self", "2002-D-2001-SH1"), ent("s-1", "equipment", "V-1"),
        ent("s-2", "self", "2002-D-2001"), ent("s-2", "self", "2002-D-2001-SH2"), ent("s-2", "equipment", "V-2"),
      ],
      documents: [
        { id: "d-s1", org_id: "o1", rev: "0", current_version_id: "v-s1" },
        { id: "d-s2", org_id: "o1", rev: "0", current_version_id: "v-s2" },
      ],
    });
  }

  it("a sibling's verdict never stands for a sheet that was skipped: once SH2 is read, the shared row is re-audited", async () => {
    siblingSheets();
    await record("kl-1");
    expect(logRows()).toEqual([expect.objectContaining({ sheet_number: "2002-D-2001", revision_code: "0", status: "passed" })]);
    expect((logRows()[0].audit_details as { coverage: Record<string, string> }).coverage).toHaveProperty("s-1");
    expect((logRows()[0].audit_details as { coverage: Record<string, string> }).coverage).not.toHaveProperty("s-2");
    // SH2 finishes indexing — and carries a connector that names nowhere.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "s-2")!, {
      status: "ready", vision_failed_pages: [], vision_retry_after: null, error: null,
    });
    db.tables.knowledge_page_entities.push(ent("s-2", "opc", "15", 1, { raw: "OPC 15: DWG NONE — TO FLARE" }));
    const again = await record("kl-1");
    expect(again.body.alreadyRecorded).toEqual([]);
    expect(logRows()).toEqual([expect.objectContaining({ sheet_number: "2002-D-2001", status: "broken_connectors" })]);
    expect(Object.keys((logRows()[0].audit_details as { coverage: Record<string, string> }).coverage).sort()).toEqual(["s-1", "s-2"]);
    // Both covered, nothing changed: done.
    const third = await record("kl-1");
    expect(third.body.recorded).toBe(0);
    expect(third.body.alreadyRecorded).toHaveLength(2);
  });

  it("a rebuild that changed a sheet's index re-audits it at the same revision: the new NONE box is recorded broken", async () => {
    twoLibraries();
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0105")).toMatchObject({ revision_code: "A", status: "passed" });
    // The controller rebuilds; the vision re-read now transcribes the boxes.
    db.tables.knowledge_page_entities.push(ent("c-105", "opc", "15", 1, { raw: "OPC 15: DWG NONE — FROM DESALTER" }));
    const again = await record("kl-1");
    // 0105 is re-audited — and so are 0104 and 0106, which point at it: what
    // 0105 holds decides their verdicts too (review fix pass 3).
    expect(again.body.recorded).toBe(3);
    expect(again.body.alreadyRecorded).toEqual([]);
    expect(logRows().find((r) => r.sheet_number === "025-PID-0105")).toMatchObject({ revision_code: "A", status: "broken_connectors" });
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    // Nothing changed since: all done.
    expect((await record("kl-1")).body.recorded).toBe(0);
  });
});

describe("DWG-13 — a verdict that depends on a neighbour is re-judged when the neighbour changes (review fix pass 3)", () => {
  /** 0105 rev-upped to B and vision-read: its box numbers are {7, 9}. */
  const revUp0105 = (boxes: string[]) => {
    db.tables.documents.find((d) => d.id === "d-105")!.rev = "B";
    db.tables.documents.find((d) => d.id === "d-105")!.current_version_id = "v-105b";
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-105")!, { source_version_id: "v-105b", source_rev: "B", vision_pages: 1 });
    for (const box of boxes) db.tables.knowledge_page_entities.push(ent("c-105", "opc", box, 1, { raw: `OPC ${box}: DWG 025-PID-0199 — TO V-${box}` }));
  };

  it("0104 recorded flagged (0105's boxes never read); 0105 re-read without box 14 — 0104 is re-judged broken, not 'already recorded'", async () => {
    twoLibraries();
    db.tables.knowledge_page_entities.push(ent("c-104", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" }));
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "flagged" });
    revUp0105(["7", "9"]);
    // The lens says it…
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnreturned).toEqual([expect.objectContaining({ box: "14", from: "025-PID-0104.pdf", to: "025-PID-0105.pdf" })]);
    // …and so does the record: 0104's own index is unchanged, its neighbour's is not.
    const again = await record("kl-1");
    expect(again.body.alreadyRecorded.map((a: { sheetNumber: string }) => a.sheetNumber)).not.toContain("025-PID-0104");
    const row = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(row).toMatchObject({ revision_code: "C", status: "broken_connectors" });
    expect((row.audit_details as { brokenConnectors: string[] }).brokenConnectors[0]).toMatch(/Connector 14 continues to 025-PID-0105\.pdf, which has no matching box/);
  });

  it("0104 recorded passed while 0105 carried box 14; 0105 re-read at the same revision without it — the record no longer says passed", async () => {
    twoLibraries();
    db.tables.knowledge_page_entities.push(
      ent("c-104", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" }),
      ent("c-105", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0104 SH 1 — FROM V-1401" }),
    );
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ status: "passed" });
    // A rebuild of 0105 transcribes a different box.
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => !(e.document_id === "c-105" && e.kind === "opc"));
    db.tables.knowledge_page_entities.push(ent("c-105", "opc", "7", 1, { raw: "OPC 7: DWG 025-PID-0199 — TO V-7" }));
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "broken_connectors" });
  });

  it("a sheet added that makes a series held re-judges the gaps it now can see", async () => {
    twoLibraries();
    await record("kl-2");
    // Tank Farm's 0104 is the only 025-PID number there: its references to
    // 0105 and 0107 are not judged.
    expect(logRows().find((r) => r.library_id === "kl-2" && r.sheet_number === "025-PID-0104")).toMatchObject({ status: "passed" });
    // 025-PID-0110 joins Tank Farm (nobody references it): the series is held now.
    db.tables.knowledge_documents.push(kdoc("t-110", { library_id: "kl-2", name: "025-PID-0110.pdf" }));
    db.tables.knowledge_page_entities.push(ent("t-110", "self", "025-PID-0110", 1, { library_id: "kl-2" }), ent("t-110", "equipment", "V-9", 1, { library_id: "kl-2" }));
    const again = await record("kl-2");
    expect(again.body.seriesNotJudged).not.toContain("025-PID");
    const tank104 = logRows().find((r) => r.library_id === "kl-2" && r.sheet_number === "025-PID-0104")!;
    expect(tank104.status).toBe("flagged");
    expect((tank104.audit_details as { missingReferences: string[] }).missingReferences.join(" ")).toMatch(/025-PID-0107/);
  });

  it("while a sheet is being indexed the record goes on: a verdict that waits on it is provisional and never overwrites a settled one (review fix pass 5; fix pass 4 refused with 409)", async () => {
    // The fix-pass-4 reviewer's half-built probe: box 14 carried both ways;
    // 0104 recorded passed.
    twoLibraries();
    db.tables.knowledge_page_entities.push(
      ent("c-104", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" }),
      ent("c-105", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0104 SH 1 — FROM V-1401" }),
    );
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    // A library-wide rebuild: 0105 is reset (queued, its entities cleared by
    // resetKnowledgeIndex); 0104 is already re-read, with one extra row — so
    // 0104 is re-audited for its OWN change.
    const saved105 = db.tables.knowledge_page_entities.filter((e) => e.document_id === "c-105");
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.document_id !== "c-105");
    db.tables.knowledge_documents.find((d) => d.id === "c-105")!.status = "stale";
    db.tables.knowledge_page_entities.push(ent("c-104", "equipment", "P-7"));
    const before = JSON.stringify(logRows());
    const during = await record("kl-1");
    // Not refused for the whole library…
    expect(during.status).toBe(200);
    // …and nothing settled is overwritten: 0104 and 0106 compute "flagged"
    // only for what 0105 — not read whole yet — was not found to hold. They
    // wait on it; their rows (and coverage) are untouched.
    expect(during.body.recorded).toBe(0);
    expect(during.body.waitingOn.map((w: { sheetNumber: string }) => w.sheetNumber).sort()).toEqual(["025-PID-0104", "025-PID-0106"]);
    expect(during.body.waitingOn[0]).toMatchObject({
      stored: "passed", computed: "flagged", waitingOn: ["025-PID-0105.pdf (not finished indexing)"],
    });
    expect(JSON.stringify(logRows())).toBe(before);
    // 0105 has no number yet: reported, never filed under its filename.
    expect(during.body.notRecorded).toEqual([expect.objectContaining({ name: "025-PID-0105.pdf" })]);
    expect(logRows().map((r) => r.sheet_number)).not.toContain("025-PID-0105.pdf");
    // 0105 finishes with identical rows: 0104 is judged against a whole 0105
    // — passed, as it is.
    db.tables.knowledge_page_entities.push(...saved105);
    db.tables.knowledge_documents.find((d) => d.id === "c-105")!.status = "ready";
    const after = await record("kl-1");
    expect(after.status).toBe(200);
    expect(after.body.keptStored).toEqual([]);
    expect(after.body.waitingOn).toEqual([]);
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    expect(logRows().map((r) => r.sheet_number)).not.toContain("025-PID-0105.pdf");
  });
});

describe("DWG-4 / DWG-13 — a neighbour not read whole is no evidence of what it lacks (review fix pass 4)", () => {
  /** 0105 parked: page 1 read (box 7), page 2 waits on AI vision. */
  const park0105 = () => Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-105")!, {
    status: "indexing", page_count: 2, pages_indexed: 2, vision_failed_pages: [2], vision_retry_after: "2026-10-01T05:00:00Z",
    error: "1 page could not be read by AI vision (overloaded)",
  });

  it("a box on a parked neighbour's unread page is unpaired, never broken_connectors — and is re-judged once the page is read", async () => {
    // The reviewer's probe. 0105 is one drawing on two pages, each with its
    // title block; box 14 stands on page 2. (A box pairs on the page whose
    // title block declares the number the connector names — review fix pass
    // 5 — so the connector names the drawing, not sheet 1.)
    twoLibraries();
    park0105();
    db.tables.knowledge_page_entities.push(
      ent("c-104", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 — TO V-1402" }),
      ent("c-105", "opc", "7", 1, { raw: "OPC 7: DWG 025-PID-0199 — TO V-7" }),
    );
    // The lens says it…
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnreturned).toEqual([]);
    expect(lens.opcUnpaired).toEqual([expect.objectContaining({ box: "14", to: "025-PID-0105.pdf", unread: "page(s) 2 never read" })]);
    // …and so does the record: a parked sheet is no reason to refuse it.
    const first = await record("kl-1");
    expect(first.status).toBe(200);
    const row = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(row).toMatchObject({ revision_code: "C", status: "flagged" });
    const details = row.audit_details as { brokenConnectors: string[]; unpairedConnectors: string[] };
    expect(details.brokenConnectors).toEqual([]);
    expect(details.unpairedConnectors[0]).toMatch(/Connector 14 continues to 025-PID-0105\.pdf, which was not read whole \(page\(s\) 2 never read\)/);
    // 0105 itself is skipped — and nobody accepted its partial index: its
    // finding says it waits on AI vision (review fix pass 4, minor).
    const r105 = logRows().find((r) => r.sheet_number === "025-PID-0105")!;
    expect(r105.status).toBe("skipped");
    expect((r105.audit_details as { unreadPages: string[] }).unreadPages[0]).toMatch(/Page\(s\) 2 were never read by AI vision \(waiting on AI vision\)/);
    const said105 = first.body.sheets.find((x: { sheetNumber: string }) => x.sheetNumber === "025-PID-0105");
    expect(said105.findings.join(" ")).not.toMatch(/accepted/);
    // That flagged waits on 0105, which is only parked: it is provisional,
    // and says what is settled without it (review fix pass 5).
    expect((row.audit_details as { provisional: unknown }).provisional).toEqual({
      waitingOn: ["025-PID-0105.pdf (page(s) 2 never read)"], settledStatus: "passed",
    });
    expect(first.body.sheets.find((x: { sheetNumber: string }) => x.sheetNumber === "025-PID-0104"))
      .toMatchObject({ status: "flagged", waitingOn: ["025-PID-0105.pdf (page(s) 2 never read)"], settledStatus: "passed" });
    // The retry reads page 2: box 14 is there. 0104 is re-judged (its
    // neighbour changed) — passed — and the provisional flagged gives way:
    // fix pass 4 kept it at that revision for good.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-105")!, {
      status: "ready", vision_failed_pages: [], vision_retry_after: null, error: null,
    });
    db.tables.knowledge_page_entities.push(
      ent("c-105", "self", "025-PID-0105", 2),
      ent("c-105", "opc", "14", 2, { raw: "OPC 14: DWG 025-PID-0104 SH 1 — FROM V-1401" }),
    );
    const second = await record("kl-1");
    expect(second.body.keptStored).toEqual([]);
    const healed = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(healed).toMatchObject({ revision_code: "C", status: "passed" });
    expect(healed.audit_details).not.toHaveProperty("provisional");
    expect(logRows().map((r) => r.status)).not.toContain("broken_connectors");
  });

  it("a verified passed is never raised by a neighbour that is only parked: it waits, and is passed again once the page is read (review fix pass 5 — the fix-pass-4 reviewer's probe)", async () => {
    // 0104 and 0105 carry box 14 both ways; 0104 recorded passed at C. 0105
    // is one drawing on two pages, each with its title block: box 14 and the
    // reference back to 0104 stand on page 2.
    twoLibraries();
    db.tables.knowledge_page_entities.find((e) => e.document_id === "c-105" && e.kind === "ref" && e.tag === "025-PID-0104")!.page = 2;
    db.tables.knowledge_page_entities.push(
      ent("c-104", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 — TO V-1402" }),
      ent("c-105", "self", "025-PID-0105", 2),
      ent("c-105", "opc", "14", 2, { raw: "OPC 14: DWG 025-PID-0104 SH 1 — FROM V-1401" }),
    );
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-105")!, { page_count: 2, pages_indexed: 2 });
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    const stamped = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    stamped.audited_at = "2026-09-01T00:00:00.000Z";
    // A rebuild re-reads 0105: page 2 (box 14, and the reference back) parks
    // on a vision error.
    const page2 = db.tables.knowledge_page_entities.filter((e) => e.document_id === "c-105" && e.page === 2);
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => !(e.document_id === "c-105" && e.page === 2));
    park0105();
    const parked = await record("kl-1");
    expect(parked.status).toBe(200);
    // 0104 computes flagged — only for what page 2 was not found to hold. It
    // waits; its passed row, and when it was decided, are untouched.
    expect(parked.body.waitingOn).toEqual(expect.arrayContaining([expect.objectContaining({
      sheetNumber: "025-PID-0104", revision: "C", stored: "passed", computed: "flagged",
      waitingOn: ["025-PID-0105.pdf (page(s) 2 never read)"],
    })]));
    // (0105 itself cannot be read right now: its own skip never erases its
    // passed — kept, as ever.)
    expect(parked.body.keptStored).toEqual([expect.objectContaining({ sheetNumber: "025-PID-0105", stored: "passed", computed: "skipped" })]);
    const during = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(during).toMatchObject({ status: "passed", audited_at: "2026-09-01T00:00:00.000Z" });
    // The retry reads page 2; the index is what it was before.
    db.tables.knowledge_page_entities.push(...page2);
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-105")!, {
      status: "ready", vision_failed_pages: [], vision_retry_after: null, error: null,
    });
    const after = await record("kl-1");
    expect(after.body.keptStored).toEqual([]);
    expect(after.body.waitingOn).toEqual([]);
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    // …and stays done.
    expect((await record("kl-1")).body.recorded).toBe(0);
  });

  it("an accepted partial index: a box, or a reference back, that may stand on its unread page is never broken or one-way", async () => {
    twoLibraries();
    // 0105 accepted with page 2 unread; its reference back to 0104 is on page
    // 2, so only 0106's reference stands; box 14 is on page 2 too.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-105")!, {
      page_count: 2, pages_indexed: 2, vision_failed_pages: [2], vision_partial_accepted: true,
    });
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) =>
      !(e.document_id === "c-105" && e.kind === "ref" && e.tag === "025-PID-0104"));
    db.tables.knowledge_page_entities.push(
      ent("c-104", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" }),
      ent("c-105", "opc", "7", 1, { raw: "OPC 7: DWG 025-PID-0199 — TO V-7" }),
    );
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.audit.oneWay).toEqual([]);
    expect(lens.audit.oneWayUnread).toEqual([expect.objectContaining({ from: "025-PID-0104.pdf", to: "025-PID-0105.pdf", unread: "page(s) 2 never read" })]);
    expect(lens.suggestions.join(" ")).toMatch(/1 reference\(s\) could not be checked: they need a sheet that was not read whole \(025-PID-0105\.pdf — page\(s\) 2 never read\)/);
    await record("kl-1");
    const row = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(row.status).toBe("flagged");
    const details = row.audit_details as { brokenConnectors: string[]; oneWay: string[]; uncheckedReferences: string[]; unpairedConnectors: string[] };
    expect(details.brokenConnectors).toEqual([]);
    expect(details.oneWay).toEqual([]);
    expect(details.uncheckedReferences).toEqual([
      "References 025-PID-0105.pdf, which was not read whole (page(s) 2 never read) — whether it references back was not checked",
    ]);
    expect(details.unpairedConnectors[0]).toMatch(/not read whole \(page\(s\) 2 never read\)/);
    // The accepted sheet's own finding says it was accepted.
    const r105 = logRows().find((r) => r.sheet_number === "025-PID-0105")!;
    expect(r105.status).toBe("flagged");
    expect((r105.audit_details as { unreadPages: string[] }).unreadPages[0]).toMatch(/\(partial index accepted\)/);
  });

  it("a sheet not found in what was read of the set is no gap while the sheet that may hold it is parked — and is judged once it is read whole", async () => {
    twoLibraries();
    park0105();
    // 0106 points only at 0105's sheet 2 — on the page nobody read yet.
    const ref106 = db.tables.knowledge_page_entities.find((e) => e.document_id === "c-106" && e.kind === "ref")!;
    ref106.tag = ref106.raw = "025-PID-0105-SH2";
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.audit.missingInSeries).toEqual([]);
    expect(lens.audit.missingUnread).toEqual([expect.objectContaining({ ref: "025-PID-0105-SH2", maybeIn: ["025-PID-0105.pdf (page(s) 2 never read)"] })]);
    await record("kl-1");
    const first = logRows().find((r) => r.sheet_number === "025-PID-0106")!;
    expect(first.status).toBe("flagged");
    expect((first.audit_details as { missingReferences: string[]; uncheckedReferences: string[] }))
      .toMatchObject({ missingReferences: [], uncheckedReferences: [expect.stringMatching(/References 025-PID-0105-SH2, which was not found in what was read of the set — it may be in 025-PID-0105\.pdf \(page\(s\) 2 never read\)/)] });
    // Page 2 is read — and no number is read from its title block. Page 1
    // is sheet 1; page 2 may be sheet 2: unchecked, never a gap (review fix
    // pass 10 — a gap here was never lowered at a known revision once the
    // sheet field was read). 0106 points at no sheet of 0105, so only the
    // set says what changed: it is re-judged.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-105")!, {
      status: "ready", vision_failed_pages: [], vision_retry_after: null, error: null,
    });
    const again = await record("kl-1");
    expect(again.body.alreadyRecorded.map((a: { sheetNumber: string }) => a.sheetNumber)).not.toContain("025-PID-0106");
    const read = logRows().find((r) => r.sheet_number === "025-PID-0106")!;
    expect(read.status).toBe("flagged");
    expect((read.audit_details as { missingReferences: string[]; uncheckedReferences: string[] })).toMatchObject({
      missingReferences: [],
      uncheckedReferences: [
        "References 025-PID-0105-SH2, which no title block in the set declares — it may be in 025-PID-0105.pdf (its sheet number was not read on page(s) 2), so whether it is in the set was not checked",
      ],
    });
    // Its title block is read: sheet 3 — not sheet 2 after all. Now it is a
    // gap.
    db.tables.knowledge_page_entities.push(ent("c-105", "self", "025-PID-0105", 2), ent("c-105", "self", "025-PID-0105-SH3", 2));
    await record("kl-1");
    const now = logRows().find((r) => r.sheet_number === "025-PID-0106")!;
    expect(now.status).toBe("flagged");
    expect((now.audit_details as { missingReferences: string[]; uncheckedReferences: string[] }))
      .toMatchObject({ missingReferences: ["References 025-PID-0105-SH2, which isn't in the set"], uncheckedReferences: [] });
  });

  it("a sheet that is not ready and declares no drawing number is reported, never filed under its filename (review fix pass 4, minor)", async () => {
    twoLibraries();
    // 0106 waits on AI vision for page 1 — its title block — so it declares
    // nothing yet.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-106")!, {
      status: "indexing", vision_failed_pages: [1], vision_retry_after: "2026-10-01T05:00:00Z", error: "1 page could not be read by AI vision",
    });
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => !(e.document_id === "c-106" && e.kind === "self"));
    const res = await record("kl-1");
    expect(res.status).toBe(200);
    expect(res.body.notRecorded).toEqual([expect.objectContaining({
      name: "025-PID-0106.pdf", status: "skipped", reason: expect.stringMatching(/still waiting to finish indexing — its drawing number is not read yet/),
    })]);
    expect(logRows().map((r) => r.sheet_number)).not.toContain("025-PID-0106.pdf");
    // A failed one says so.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-106")!, { status: "error", vision_retry_after: null });
    const failed = await record("kl-1");
    expect(failed.body.notRecorded).toEqual([expect.objectContaining({ reason: expect.stringMatching(/its indexing failed before its drawing number was read/) })]);
    expect(logRows().map((r) => r.sheet_number)).not.toContain("025-PID-0106.pdf");
  });
});

// ── review fix pass 5 ───────────────────────────────────────────────────────

describe("DWG-4 — a box pairs on the SHEET its connector names, never on another page's boxes (review fix pass 5)", () => {
  /** 0104, and a ready two-page combined PDF: page 1 declares 025-PID-0105
   *  from a TrueType text layer (not vision-read: no box rows); page 2
   *  (025-PID-0106) is SHX, read by AI vision, with box 3. */
  function combined(page1Boxes: string[] = []) {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf" }),
        kdoc("b", { name: "combined.pdf", page_count: 2, pages_indexed: 2, vision_pages: 1 }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1401"),
        ent("a", "ref", "025-PID-0105-SH1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" }),
        ent("b", "self", "025-PID-0105", 1), ent("b", "self", "025-PID-0105-SH1", 1), ent("b", "equipment", "V-1402", 1),
        ent("b", "ref", "025-PID-0104", 1),
        ent("b", "self", "025-PID-0106", 2), ent("b", "self", "025-PID-0106-SH1", 2), ent("b", "equipment", "P-3", 2),
        ent("b", "opc", "3", 2, { raw: "OPC 3: DWG 025-PID-0199 — TO P-3" }),
        ...page1Boxes.map((box) => ent("b", "opc", box, 1, { raw: `OPC ${box}: DWG 025-PID-0199 — TO V-${box}` })),
      ],
    });
  }

  it("the reviewer's probe: a connector into a combined PDF's text-layer page is unpaired with which page — never unreturned, never broken_connectors", async () => {
    combined();
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnreturned).toEqual([]);
    expect(lens.opcUnpaired).toEqual([expect.objectContaining({
      box: "14", to: "combined.pdf", why: "page 1 of it is the sheet named, and no box numbers were read there",
    })]);
    const res = await record("kl-1");
    expect(res.status).toBe(200);
    const row = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(row.status).toBe("flagged");
    const details = row.audit_details as { brokenConnectors: string[]; unpairedConnectors: string[] };
    expect(details.brokenConnectors).toEqual([]);
    expect(details.unpairedConnectors).toEqual([
      "Connector 14 continues to combined.pdf: page 1 of it is the sheet named, and no box numbers were read there — the pairing was not checked; check the box on that sheet",
    ]);
    // Settled, not provisional: the document IS read whole; only its page 1
    // carries no box numbers (a text layer prints a pennant, not a box).
    expect(row.audit_details).not.toHaveProperty("provisional");
    expect(logRows().map((r) => r.status)).not.toContain("broken_connectors");
  });

  it("page 1 vision-read with its boxes, and 14 not among them: that one is unreturned — broken where the sheet named was read", async () => {
    combined(["7"]);
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnreturned).toEqual([expect.objectContaining({ box: "14", to: "combined.pdf" })]);
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ status: "broken_connectors" });
    // …and with 14 on page 1, paired.
    combined(["14"]);
    expect((await (await get("orgId=o1&libraryId=kl-1")).json()).opcUnpaired).toEqual([]);
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ status: "passed" });
  });
});

describe("DWG-13 — nothing is refused while a sheet is being indexed (review fix pass 5); a gap a document still being read may yet fill is never filed settled (review fix pass 6)", () => {
  it("a combined PDF mid-index: a drawing of its series it has not read yet is no gap — provisional — and is settled once it is read", async () => {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0110.pdf" }),
        // The combined PDF has read page 1 of 3 so far.
        kdoc("x", { name: "Crude PIDs.pdf", status: "indexing", page_count: 3, pages_indexed: 1 }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0110"), ent("a", "equipment", "V-10"), ent("a", "ref", "025-PID-0102"),
        ent("x", "self", "025-PID-0101", 1), ent("x", "equipment", "V-1", 1),
      ],
    });
    const first = await record("kl-1");
    expect(first.status).toBe(200);
    const row = logRows().find((r) => r.sheet_number === "025-PID-0110")!;
    expect(row.status).toBe("flagged");
    const details = row.audit_details as { missingReferences: string[]; uncheckedReferences: string[]; provisional: unknown };
    expect(details.missingReferences).toEqual([]);
    expect(details.uncheckedReferences[0]).toMatch(/References 025-PID-0102, which was not found in what was read of the set — it may be in Crude PIDs\.pdf \(not finished indexing\)/);
    expect(details.provisional).toEqual({ waitingOn: ["Crude PIDs.pdf (not finished indexing)"], settledStatus: "passed" });
    // The PDF finishes: page 2 is 0102, and references 0110 back.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "x")!, { status: "ready", pages_indexed: 3 });
    db.tables.knowledge_page_entities.push(
      ent("x", "self", "025-PID-0102", 2), ent("x", "ref", "025-PID-0110", 2), ent("x", "self", "025-PID-0103", 3),
    );
    const after = await record("kl-1");
    expect(after.body.keptStored).toEqual([]);
    const settled = logRows().find((r) => r.sheet_number === "025-PID-0110")!;
    expect(settled.status).toBe("passed");
    expect(settled.audit_details).not.toHaveProperty("provisional");
  });
});

describe("DWG-13 / DWG-4 — what a document still being read may hold is never filed settled, and a provisional verdict never overwrites a settled one under any revision (review fix pass 6)", () => {
  /** The reviewer's probe A: 0104 (rev C) references 0105; 0106 makes
   *  025-PID held; "Unit PIDs.pdf" is a combined PDF holding 026-PID-0201
   *  (page 1) and 025-PID-0105 (page 2). */
  function unitPids() {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }),
        kdoc("b", { name: "025-PID-0106.pdf" }),
        kdoc("x", { name: "Unit PIDs.pdf", page_count: 2, pages_indexed: 2 }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "equipment", "V-1"), ent("a", "ref", "025-PID-0105"),
        ent("b", "self", "025-PID-0106"), ent("b", "equipment", "V-2"),
        ent("x", "self", "026-PID-0201", 1), ent("x", "equipment", "V-3", 1),
        ent("x", "self", "025-PID-0105", 2), ent("x", "ref", "025-PID-0104", 2), ent("x", "equipment", "V-4", 2),
      ],
      documents: [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }],
    });
  }
  /** x is reset by a rebuild and has re-read only its 026-PID page. */
  const rebuildX = () => {
    const page2 = db.tables.knowledge_page_entities.filter((e) => e.document_id === "x" && e.page === 2);
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => !(e.document_id === "x" && e.page === 2));
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "x")!, { status: "indexing", pages_indexed: 1 });
    return () => {
      db.tables.knowledge_page_entities.push(...page2);
      Object.assign(db.tables.knowledge_documents.find((d) => d.id === "x")!, { status: "ready", pages_indexed: 2 });
    };
  };

  it("the reviewer's probe A: a combined PDF of two series, mid-rebuild, has not declared 025-PID yet — 0104's reference into it waits, and 0104 stays passed", async () => {
    unitPids();
    expect((await record("kl-1")).status).toBe(200);
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    const finish = rebuildX();
    // The lens: no gap — unchecked, may be in the PDF still being read.
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.audit.missingInSeries).toEqual([]);
    expect(lens.audit.missingUnread).toEqual([expect.objectContaining({ ref: "025-PID-0105", maybeIn: ["Unit PIDs.pdf (not finished indexing)"] })]);
    // The record: 0104 computes flagged only for what x has yet to read — it
    // waits; its passed row is untouched. Fix pass 5 filed a SETTLED gap
    // here ("References 025-PID-0105, which isn't in the set"), never lowered.
    const before = JSON.stringify(logRows().find((r) => r.sheet_number === "025-PID-0104"));
    const during = await record("kl-1");
    expect(during.status).toBe(200);
    expect(during.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0104", revision: "C", stored: "passed", computed: "flagged", waitingOn: ["Unit PIDs.pdf (not finished indexing)"],
    })]);
    expect(JSON.stringify(logRows().find((r) => r.sheet_number === "025-PID-0104"))).toBe(before);
    // x finishes, identical to before: 0104 is passed, nothing kept.
    finish();
    const after = await record("kl-1");
    expect(after.body.keptStored).toEqual([]);
    expect(after.body.waitingOn).toEqual([]);
    const row = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(row).toMatchObject({ revision_code: "C", status: "passed" });
    expect((row.audit_details as { missingReferences: string[] }).missingReferences).toEqual([]);
  });

  it("first recorded mid-rebuild, 0104 is filed provisional — and settles passed once the PDF is read", async () => {
    unitPids();
    const finish = rebuildX();
    await record("kl-1");
    const first = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(first.status).toBe("flagged");
    expect((first.audit_details as { missingReferences: string[]; provisional: unknown }))
      .toMatchObject({ missingReferences: [], provisional: { waitingOn: ["Unit PIDs.pdf (not finished indexing)"], settledStatus: "passed" } });
    finish();
    await record("kl-1");
    const settled = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(settled.status).toBe("passed");
    expect(settled.audit_details).not.toHaveProperty("provisional");
  });

  /** The reviewer's probes C and D: 0104 carries box 14 into 0105 SH 1; 0105
   *  has its boxes read, but not 14. */
  function boxInto0105(revised: boolean) {
    seed({
      knowledge_documents: [
        kdoc("a", revised
          ? { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }
          : { name: "025-PID-0104.pdf" }),
        kdoc("b", { name: "025-PID-0105.pdf" }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" }),
        ent("b", "self", "025-PID-0105"), ent("b", "self", "025-PID-0105-SH1"), ent("b", "equipment", "V-2"),
        ent("b", "opc", "7", 1, { raw: "OPC 7: DWG 025-PID-0104 SH 1 — FROM V-7" }),
      ],
      documents: revised ? [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }] : [],
    });
  }
  /** A rebuild resets 0105: queued, its entities cleared. */
  const reset0105 = () => {
    const saved = db.tables.knowledge_page_entities.filter((e) => e.document_id === "b");
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.document_id !== "b");
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "b")!, { status: "queued", pages_indexed: 0 });
    return () => {
      db.tables.knowledge_page_entities.push(...saved);
      Object.assign(db.tables.knowledge_documents.find((d) => d.id === "b")!, { status: "ready", pages_indexed: 1 });
    };
  };

  it("the reviewer's probe C: an unrevised broken_connectors is not overwritten while the destination is reset — the connector waits on it", async () => {
    boxInto0105(false);
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "", status: "broken_connectors" });
    const finish = reset0105();
    // The lens: the box is not paired — no sheet declares 0105 yet.
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnreturned).toEqual([]);
    expect(lens.opcUnpaired).toEqual([expect.objectContaining({
      box: "14", to: "025-PID-0105-SH1", maybeInIds: ["b"],
      why: "no sheet in the set declares it yet, and it may be in 025-PID-0105.pdf (not finished indexing), not read whole yet",
    })]);
    // Fix pass 5 dropped the connector and filed 0104 a settled passed over
    // its broken_connectors.
    const during = await record("kl-1");
    expect(during.status).toBe(200);
    expect(during.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0104", revision: "", stored: "broken_connectors", computed: "flagged",
      waitingOn: ["025-PID-0105.pdf (not finished indexing)"],
    })]);
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ status: "broken_connectors" });
    // 0105 is read again, still without box 14: broken, as recorded.
    finish();
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "", status: "broken_connectors" });
  });

  it("the reviewer's probe D: first recorded at a known revision while the destination is reset — provisional, never a settled passed; broken once it is read", async () => {
    boxInto0105(true);
    const finish = reset0105();
    await record("kl-1");
    const first = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(first).toMatchObject({ revision_code: "C", status: "flagged" });
    expect((first.audit_details as { unpairedConnectors: string[]; provisional: unknown })).toMatchObject({
      unpairedConnectors: [
        "Connector 14 continues to 025-PID-0105-SH1: no sheet in the set declares it yet, and it may be in 025-PID-0105.pdf (not finished indexing), not read whole yet — the pairing was not checked; check the box on that sheet",
      ],
      provisional: { waitingOn: ["025-PID-0105.pdf (not finished indexing)"], settledStatus: "passed" },
    });
    finish();
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "broken_connectors" });
  });

  it("the reviewer's probe B: under an unknown revision a verdict waiting on a parked neighbour never overwrites a verified broken_connectors", async () => {
    boxInto0105(false);
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "", status: "broken_connectors" });
    // 0105 is parked: page 2 waits on AI vision.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "b")!, {
      status: "indexing", page_count: 2, pages_indexed: 2, vision_failed_pages: [2], vision_retry_after: "2026-10-01T05:00:00Z", error: "overloaded",
    });
    const parked = await record("kl-1");
    expect(parked.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0104", revision: "", stored: "broken_connectors", computed: "flagged",
      waitingOn: ["025-PID-0105.pdf (page(s) 2 never read)"],
    })]);
    const row = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(row.status).toBe("broken_connectors");
    expect(row.audit_details).not.toHaveProperty("provisional");
  });

  it("a failed document whose number was never read never suspends a gap: the gap is recorded, unchecked and settled (the reviewer's probe E)", async () => {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }),
        kdoc("b", { name: "025-PID-0105.pdf" }),
        kdoc("c", { name: "025-PID-0106.pdf" }),
        kdoc("f", { name: "scan_001.pdf", status: "error", error: "corrupt PDF" }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "equipment", "V-1"), ent("a", "ref", "025-PID-0105"),
        ent("b", "self", "025-PID-0105"), ent("b", "equipment", "V-2"), ent("b", "ref", "025-PID-0104"),
        ent("c", "self", "025-PID-0106"), ent("c", "equipment", "V-3"),
      ],
      documents: [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }],
    });
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ status: "passed" });
    // 0105 leaves the library. Fix pass 5 left 0104 passed, "waiting" on the
    // failed scan for as long as it stayed failed.
    db.tables.knowledge_documents = db.tables.knowledge_documents.filter((d) => d.id !== "b");
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.document_id !== "b");
    const res = await record("kl-1");
    expect(res.body.waitingOn).toEqual([]);
    const row = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(row.status).toBe("flagged");
    expect(row.audit_details).not.toHaveProperty("provisional");
    expect((row.audit_details as { uncheckedReferences: string[] }).uncheckedReferences).toEqual([
      "References 025-PID-0105, which was not found in what was read of the set — it may be in scan_001.pdf (its indexing failed), not read whole",
    ]);
  });

  it("a finding about a failed document itself still waits on it, and says to re-index it", async () => {
    twoLibraries();
    await record("kl-1");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    // 0105's re-index failed after its title block was read again, before
    // its references: whether it references 0104 back was not checked.
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => !(e.document_id === "c-105" && e.kind === "ref"));
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "c-105")!, { status: "error", error: "corrupt PDF" });
    const res = await record("kl-1");
    expect(res.body.waitingOn).toEqual(expect.arrayContaining([expect.objectContaining({
      sheetNumber: "025-PID-0104", stored: "passed", computed: "flagged",
      waitingOn: ["025-PID-0105.pdf (its indexing failed — re-index it)"],
    })]));
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
  });

  it("the reviewer's probe F: a connector naming the drawing, into a page indexed text-only (no title block, no boxes read), is unpaired — never broken_connectors", async () => {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf" }),
        kdoc("b", { name: "025-PID-0105.pdf", page_count: 2, pages_indexed: 2, vision_pages: 1 }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1401"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 — TO V-1402" }),
        // Page 1 read by AI vision: title block and box 7. Page 2 (sheet 2,
        // SHX) indexed text-only: nothing of it in the index but its text.
        ent("b", "self", "025-PID-0105", 1), ent("b", "self", "025-PID-0105-SH1", 1), ent("b", "equipment", "V-1402", 1),
        ent("b", "opc", "7", 1, { raw: "OPC 7: DWG 025-PID-0199 — TO V-7" }),
      ],
    });
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnreturned).toEqual([]);
    expect(lens.opcUnpaired).toEqual([expect.objectContaining({
      box: "14", to: "025-PID-0105.pdf",
      why: "page 2 of it declares no drawing number and no box numbers were read there — it may be the sheet named",
    })]);
    await record("kl-1");
    const row = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(row.status).toBe("flagged");
    expect((row.audit_details as { brokenConnectors: string[] }).brokenConnectors).toEqual([]);
    // Settled: the document IS read whole; what its page 2 holds was never read.
    expect(row.audit_details).not.toHaveProperty("provisional");
  });
});

describe("DWG-13 / DWG-4 — no verdict is lowered under an unknown revision for what a document not read whole may yet hold, and a large library mid-rebuild stays fast and small (review fix pass 7)", () => {
  const row = (sheet: string) => logRows().find((r) => r.sheet_number === sheet)!;
  /** A rebuild resets a document: queued, its entities cleared. */
  const resetDoc = (id: string, over: Row = {}) => {
    const saved = db.tables.knowledge_page_entities.filter((e) => e.document_id === id);
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.document_id !== id);
    const doc = db.tables.knowledge_documents.find((d) => d.id === id)!;
    const was = { ...doc };
    Object.assign(doc, { status: "queued", pages_indexed: 0, ...over });
    return () => {
      db.tables.knowledge_page_entities.push(...saved);
      Object.assign(doc, was);
    };
  };

  it("the reviewer's probe provprov: a provisional verdict never lowers what a provisional unrevised row SETTLED", async () => {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf" }),
        kdoc("b", { name: "025-PID-0105.pdf" }),
        kdoc("c", { name: "025-PID-0106.pdf", status: "indexing", page_count: 2, pages_indexed: 2, vision_failed_pages: [2], vision_retry_after: "2026-10-01T05:00:00Z", error: "overloaded" }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" }),
        ent("a", "opc", "15", 1, { raw: "OPC 15: DWG 025-PID-0106 SH 1 — TO V-1502" }),
        ent("b", "self", "025-PID-0105"), ent("b", "self", "025-PID-0105-SH1"), ent("b", "equipment", "V-2"),
        ent("b", "opc", "7", 1, { raw: "OPC 7: DWG 025-PID-0104 SH 1 — FROM V-7" }),
        ent("c", "self", "025-PID-0106", 1), ent("c", "self", "025-PID-0106-SH1", 1), ent("c", "equipment", "V-3", 1),
        ent("c", "opc", "8", 1, { raw: "OPC 8: DWG 025-PID-0104 SH 1 — FROM V-8" }),
      ],
    });
    await record("kl-1");
    // Box 14 is verified unreturned on 0105 (read whole); box 15 waits on the
    // parked 0106: broken_connectors, provisional, SETTLED broken.
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "", status: "broken_connectors" });
    expect((row("025-PID-0104").audit_details as { provisional: { settledStatus: string } }).provisional.settledStatus).toBe("broken_connectors");
    const before = JSON.stringify(row("025-PID-0104"));
    const finish = resetDoc("b");
    // 0105 reset: box 14 now waits too, so the computation settles passed.
    // Fix pass 6 wrote it over the row (flagged, settled passed, no broken
    // connector). It waits.
    const during = await record("kl-1");
    expect(during.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0104", stored: "broken_connectors", computed: "flagged",
      waitingOn: ["025-PID-0105.pdf (not finished indexing)", "025-PID-0106.pdf (page(s) 2 never read)"],
    })]);
    expect(JSON.stringify(row("025-PID-0104"))).toBe(before);
    finish();
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ status: "broken_connectors" });
  });

  /** Per-sheet PDFs of 025-PID-0105 share its key; SH2 carries a connector
   *  that names nowhere (broken). */
  function perSheet(sh2: Row = {}) {
    seed({
      knowledge_documents: [
        kdoc("s1", { name: "025-PID-0105 SH1.pdf" }),
        kdoc("s2", { name: "025-PID-0105 SH2.pdf", ...sh2 }),
        kdoc("c", { name: "025-PID-0106.pdf" }),
      ],
      knowledge_page_entities: [
        ent("s1", "self", "025-PID-0105"), ent("s1", "self", "025-PID-0105-SH1"), ent("s1", "equipment", "V-1"),
        ent("s2", "self", "025-PID-0105"), ent("s2", "self", "025-PID-0105-SH2"), ent("s2", "equipment", "V-2"),
        ent("s2", "opc", "9", 1, { raw: "OPC 9: DWG NONE — TO V-9" }),
        ent("c", "self", "025-PID-0106"), ent("c", "equipment", "V-3"),
      ],
    });
  }

  it("the reviewer's probe sib2: a parked sibling under the shared key never lets the other sheet's passed overwrite broken_connectors", async () => {
    perSheet({ page_count: 2, pages_indexed: 2 });
    await record("kl-1");
    expect(row("025-PID-0105")).toMatchObject({ revision_code: "", status: "broken_connectors" });
    const before = JSON.stringify(row("025-PID-0105"));
    // SH2 parked: page 2 waits on AI vision. Its NONE connector is still in
    // the index (the lens lists it), but a parked sheet is skipped.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "s2")!, {
      status: "indexing", vision_failed_pages: [2], vision_retry_after: "2026-10-01T05:00:00Z", error: "overloaded",
    });
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcNoRef).toEqual([expect.objectContaining({ box: "9", sheet: "025-PID-0105 SH2.pdf" })]);
    const parked = await record("kl-1");
    expect(parked.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0105", stored: "broken_connectors", computed: "passed", waitingOn: ["025-PID-0105 SH2.pdf (page(s) 2 never read)"],
    })]);
    expect(JSON.stringify(row("025-PID-0105"))).toBe(before);
    // Read whole again: the shared row is broken_connectors, from both.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "s2")!, {
      status: "ready", vision_failed_pages: [], vision_retry_after: null, error: null,
    });
    const after = await record("kl-1");
    expect(after.body.waitingOn).toEqual([]);
    expect(row("025-PID-0105")).toMatchObject({ status: "broken_connectors" });
  });

  it("the reviewer's probe sib: a sibling reset by a rebuild (no number declared yet) never lets the other sheet's passed overwrite broken_connectors", async () => {
    perSheet();
    await record("kl-1");
    const before = JSON.stringify(row("025-PID-0105"));
    expect((row("025-PID-0105").audit_details as { coverage: Record<string, string> }).coverage).toHaveProperty("s2");
    const finish = resetDoc("s2");
    const during = await record("kl-1");
    // SH2 is not filed (no number yet) — the stored row covered it.
    expect(during.body.notRecorded).toEqual([expect.objectContaining({ name: "025-PID-0105 SH2.pdf" })]);
    expect(during.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0105", stored: "broken_connectors", computed: "passed", waitingOn: ["025-PID-0105 SH2.pdf (not finished indexing)"],
    })]);
    expect(JSON.stringify(row("025-PID-0105"))).toBe(before);
    // SH2 re-read its title block only (in flight, skipped): still waits.
    db.tables.knowledge_page_entities.push(ent("s2", "self", "025-PID-0105"), ent("s2", "self", "025-PID-0105-SH2"));
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "s2")!, { status: "indexing" });
    expect((await record("kl-1")).body.waitingOn).toEqual([expect.objectContaining({ sheetNumber: "025-PID-0105", stored: "broken_connectors" })]);
    expect(JSON.stringify(row("025-PID-0105"))).toBe(before);
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.document_id !== "s2");
    finish();
    await record("kl-1");
    expect(row("025-PID-0105")).toMatchObject({ status: "broken_connectors" });
  });

  /** 0104 carries box 14 into 0105 SH 1; 0105 has its boxes read, not 14. */
  function boxInto0105(revised: boolean) {
    seed({
      knowledge_documents: [
        kdoc("a", revised
          ? { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }
          : { name: "025-PID-0104.pdf" }),
        kdoc("b", { name: "025-PID-0105.pdf" }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" }),
        ent("a", "ref", "025-PID-0105-SH1"),
        ent("b", "self", "025-PID-0105"), ent("b", "self", "025-PID-0105-SH1"), ent("b", "equipment", "V-2"),
        ent("b", "opc", "7", 1, { raw: "OPC 7: DWG 025-PID-0104 SH 1 — FROM V-7" }),
        ent("b", "ref", "025-PID-0104-SH1"),
      ],
      documents: revised ? [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }] : [],
    });
  }

  for (const revised of [false, true]) {
    it(`the reviewer's probe failed (${revised ? "rev C" : "unknown revision"}): a destination whose re-index FAILED after a rebuild reset it keeps the connector unpaired, waiting on it — never a settled passed`, async () => {
      boxInto0105(revised);
      await record("kl-1");
      expect(row("025-PID-0104")).toMatchObject({ revision_code: revised ? "C" : "", status: "broken_connectors" });
      const before = JSON.stringify(row("025-PID-0104"));
      resetDoc("b", { status: "error", error: "corrupt PDF", page_count: null });
      const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
      expect(lens.opcUnreturned).toEqual([]);
      expect(lens.opcUnpaired).toEqual([expect.objectContaining({
        box: "14", to: "025-PID-0105-SH1", maybeInIds: ["b"],
        why: "no sheet in the set declares it yet, and it may be in 025-PID-0105.pdf (its indexing failed), not read whole yet",
      })]);
      const during = await record("kl-1");
      expect(during.body.waitingOn).toEqual([expect.objectContaining({
        sheetNumber: "025-PID-0104", stored: "broken_connectors", computed: "flagged",
        waitingOn: ["025-PID-0105.pdf (its indexing failed — re-index it)"],
      })]);
      expect(JSON.stringify(row("025-PID-0104"))).toBe(before);
    });
  }

  it("a first record while the destination's re-index has failed is provisional, never a settled passed", async () => {
    boxInto0105(true);
    resetDoc("b", { status: "error", error: "corrupt PDF", page_count: null });
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "flagged" });
    expect((row("025-PID-0104").audit_details as { provisional: unknown }).provisional)
      .toEqual({ waitingOn: ["025-PID-0105.pdf (its indexing failed — re-index it)"], settledStatus: "passed" });
  });

  it("the reviewer's probe held: the document that made the series held is reset — the unrevised gap waits, unchecked, and is filed again once it is read", async () => {
    seed({
      knowledge_documents: [kdoc("a", { name: "025-PID-0104.pdf" }), kdoc("b", { name: "scan_b.pdf" })],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "equipment", "V-1"), ent("a", "ref", "025-PID-0199"), ent("a", "ref", "025-PID-0105"),
        ent("b", "self", "025-PID-0105"), ent("b", "equipment", "V-2"), ent("b", "ref", "025-PID-0104"),
      ],
    });
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "", status: "flagged" });
    expect((row("025-PID-0104").audit_details as { missingReferences: string[] }).missingReferences)
      .toEqual(["References 025-PID-0199, which isn't in the set"]);
    const before = JSON.stringify(row("025-PID-0104"));
    const finish = resetDoc("b");
    // The lens: unchecked, waiting on the scan — never dropped.
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.audit.missingInSeries).toEqual([]);
    expect(lens.audit.missingUnread.map((m: { ref: string; maybeIn: string[] }) => [m.ref, m.maybeIn]).sort()).toEqual([
      ["025-PID-0105", ["scan_b.pdf (not finished indexing)"]], ["025-PID-0199", ["scan_b.pdf (not finished indexing)"]],
    ]);
    // Fix pass 6 dropped both and wrote 0104 passed, settled, over its gap.
    const during = await record("kl-1");
    expect(during.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0104", stored: "flagged", computed: "flagged", waitingOn: ["scan_b.pdf (not finished indexing)"],
    })]);
    expect(JSON.stringify(row("025-PID-0104"))).toBe(before);
    finish();
    await record("kl-1");
    expect((row("025-PID-0104").audit_details as { missingReferences: string[] }).missingReferences)
      .toEqual(["References 025-PID-0199, which isn't in the set"]);
  });

  it("while a document is in flight, a settled verdict that would lower an unrevised row waits — even one whose finding the document's reset took out of the set's scope", async () => {
    // b is a combined PDF of 040-TK-0001/0002 under an unrelated filename.
    // Reset, it answers to its filename only: 040-TK leaves the set's scope,
    // so 0104's reference into 040-TK-0009 is out of scope — no finding.
    seed({
      knowledge_documents: [kdoc("a", { name: "025-PID-0104.pdf" }), kdoc("b", { name: "026-PID-0200.pdf" })],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "equipment", "V-1"), ent("a", "ref", "040-TK-0009"), ent("a", "ref", "040-TK-0001"),
        ent("b", "self", "040-TK-0001", 1), ent("b", "self", "040-TK-0002", 2), ent("b", "equipment", "TK-1"), ent("b", "ref", "025-PID-0104"),
      ],
    });
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "", status: "flagged" });
    const before = JSON.stringify(row("025-PID-0104"));
    const finish = resetDoc("b");
    const during = await record("kl-1");
    expect(during.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0104", stored: "flagged", computed: "passed", waitingOn: ["026-PID-0200.pdf (not finished indexing)"],
    })]);
    expect(JSON.stringify(row("025-PID-0104"))).toBe(before);
    finish();
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ status: "flagged" });
    // Nothing in flight: the latest settled verdict is written, as before —
    // 040-TK-0009 uploaded, the gap is gone.
    db.tables.knowledge_documents.push(kdoc("t9", { name: "040-TK-0009.pdf" }));
    db.tables.knowledge_page_entities.push(ent("t9", "self", "040-TK-0009"), ent("t9", "ref", "025-PID-0104"));
    const widened = await record("kl-1");
    expect(widened.body.waitingOn).toEqual([]);
    expect(row("025-PID-0104")).toMatchObject({ status: "passed" });
  });

  it("the reviewer's probe parked: a parked single-drawing PDF with its number declared never hides a real gap in another series as unchecked — the gap is filed, waits on it, and settles once it is read (corrected in review fix pass 8)", async () => {
    seed({
      knowledge_documents: [
        kdoc("t1", { name: "040-TK-0001.pdf", source_document_id: "d-t1", source_version_id: "v-t1", source_rev: "B" }),
        kdoc("t2", { name: "040-TK-0002.pdf" }),
        kdoc("t9", { name: "040-TK-0009.pdf" }),
        kdoc("p", { name: "025-PID-0107.pdf", page_count: 2, pages_indexed: 2 }),
      ],
      knowledge_page_entities: [
        ent("t1", "self", "040-TK-0001"), ent("t1", "equipment", "TK-1"), ent("t1", "ref", "040-TK-0009"),
        ent("t2", "self", "040-TK-0002"), ent("t2", "equipment", "TK-2"),
        ent("t9", "self", "040-TK-0009"), ent("t9", "equipment", "TK-9"), ent("t9", "ref", "040-TK-0001"),
        ent("p", "self", "025-PID-0107", 1), ent("p", "equipment", "V-7", 1),
      ],
      documents: [{ id: "d-t1", org_id: "o1", rev: "B", current_version_id: "v-t1" }],
    });
    await record("kl-1");
    expect(row("040-TK-0001")).toMatchObject({ revision_code: "B", status: "passed" });
    // 0009 leaves the library; p's page 2 waits on AI vision until next month.
    db.tables.knowledge_documents = db.tables.knowledge_documents.filter((d) => d.id !== "t9");
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "p")!, {
      status: "indexing", vision_failed_pages: [2], vision_retry_after: "2026-11-01T00:00:00Z", error: "monthly AI cap reached",
    });
    // The lens: a gap — said to be unsettled while p's page 2 is unread —
    // never an unchecked reference (fix pass 6's suspension).
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.audit.missingUnread).toEqual([]);
    expect(lens.audit.missingInSeries).toEqual([expect.objectContaining({
      ref: "040-TK-0009", pendingIn: ["025-PID-0107.pdf (page(s) 2 never read)"],
    })]);
    expect(lens.audit.missingInSeries[0]).not.toHaveProperty("pendingIds");
    expect(lens.suggestions.join("\n")).toContain("They are not settled yet: 025-PID-0107.pdf (page(s) 2 never read) still has pages waiting on AI vision");
    // The record: the gap is filed and waits on p. Fix pass 7 wrote it over
    // the passed row SETTLED — and had page 2 turned out to declare 0009,
    // that flagged at B was never lowered (the reviewer's probe parked2).
    const res = await record("kl-1");
    expect(res.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "040-TK-0001", revision: "B", stored: "passed", computed: "flagged", waitingOn: ["025-PID-0107.pdf (page(s) 2 never read)"],
    })]);
    expect(row("040-TK-0001")).toMatchObject({ revision_code: "B", status: "passed" });
    // Page 2 is read: sheet 2 of 0107, nothing of 040-TK. The gap is settled.
    Object.assign(db.tables.knowledge_documents.find((d) => d.id === "p")!, {
      status: "ready", vision_failed_pages: [], vision_retry_after: null, error: null,
    });
    db.tables.knowledge_page_entities.push(ent("p", "self", "025-PID-0107-SH2", 2), ent("p", "equipment", "V-8", 2));
    const after = await record("kl-1");
    expect(after.body.waitingOn).toEqual([]);
    expect(row("040-TK-0001")).toMatchObject({ revision_code: "B", status: "flagged" });
    expect((row("040-TK-0001").audit_details as { missingReferences: string[] }).missingReferences)
      .toEqual(["References 040-TK-0009, which isn't in the set"]);
    expect(row("040-TK-0001").audit_details).not.toHaveProperty("provisional");
  });

  it("the reviewer's probes perf and size: 600 sheets mid-rebuild record in bounded time, each verdict naming at most six documents, under 1 MB", async () => {
    const N = 600;
    const docs: Row[] = [];
    const ents: Row[] = [];
    const num = (i: number) => `025-PID-${String(1000 + i).padStart(4, "0")}`;
    for (let i = 0; i < N; i++) {
      const id = `d${String(i).padStart(4, "0")}`;
      docs.push(kdoc(id, { name: `${num(i)}.pdf`, ...(i >= N / 2 ? { status: "stale", pages_indexed: 0, page_count: null } : {}) }));
      if (i < N / 2) {
        ents.push(ent(id, "self", num(i)), ent(id, "self", `${num(i)}-SH1`), ent(id, "equipment", `V-${i}`));
        for (let k = 0; k < 4; k++) ents.push(ent(id, "opc", String(k + 1), 1, { raw: `OPC ${k + 1}: DWG ${num((i + N / 2 + k) % N)} SH 1 — TO V-${i}` }));
        ents.push(ent(id, "ref", num((i + N / 2) % N)));
      }
    }
    seed({ knowledge_documents: docs, knowledge_page_entities: ents });
    const t0 = performance.now();
    const res = await post({ orgId: "o1", libraryId: "kl-1", action: "record-audit" });
    const text = await res.text();
    const ms = performance.now() - t0;
    expect(res.status).toBe(200);
    const body = JSON.parse(text) as { recorded: number; sheets: Array<{ waitingOn?: string[] }> };
    expect(body.recorded).toBe(N / 2);
    // Fix pass 6: 4.41 MB here, every row naming all 300 documents in flight.
    expect(text.length).toBeLessThan(1_000_000);
    expect(Math.max(...body.sheets.map((s) => s.waitingOn?.length ?? 0))).toBe(7);
    expect(body.sheets[0].waitingOn![6]).toBe("294 more document(s) not read whole");
    const stored = logRows().map((r) => (r.audit_details as { provisional?: { waitingOn: string[] } }).provisional?.waitingOn.length ?? 0);
    expect(Math.max(...stored)).toBe(7);
    expect(logRows().reduce((n, r) => n + JSON.stringify(r.audit_details).length, 0)).toBeLessThan(1_000_000);
    // A regression guard, not a benchmark: fix pass 6 took tens of seconds
    // at this size (the route's limit is 60 s).
    expect(ms).toBeLessThan(15_000);
    const lens = await get("orgId=o1&libraryId=kl-1");
    expect(lens.status).toBe(200);
    expect((await lens.text()).length).toBeLessThan(1_000_000);
  }, 60_000);
});

describe("DWG-13 / DWG-4 — a document mid-read, a parked one, or a reset or failed per-sheet sibling never raises a known revision's verdict for good, nor lowers an unrevised one (review fix pass 8)", () => {
  const row = (sheet: string) => logRows().find((r) => r.sheet_number === sheet)!;
  const doc = (id: string) => db.tables.knowledge_documents.find((d) => d.id === id)!;
  type Details = {
    missingReferences: string[]; uncheckedReferences: string[]; unpairedConnectors: string[];
    provisional?: { waitingOn: string[]; settledStatus: string };
  };
  const details = (sheet: string) => row(sheet).audit_details as Details;
  const MIDREAD = "Unit 25 P&IDs.pdf (not finished indexing, page(s) 3 queued for AI vision)";

  it("the reviewer's probe midread-ref: a combined PDF still mid-read, with a page already queued for AI vision, may hold any sheet — a gap on a page it has yet to reach is never filed settled at rev B", async () => {
    seed({
      knowledge_documents: [
        kdoc("t1", { name: "030-PID-0201.pdf", source_document_id: "d-t1", source_version_id: "v-t1", source_rev: "B" }),
        kdoc("t2", { name: "030-PID-0202.pdf" }),
        // 6 of 20 pages read; batch 1 queued page 3 for AI vision (committed
        // with the batch — 'indexing', no error, no retry time): not parked.
        kdoc("c", { name: "Unit 25 P&IDs.pdf", status: "indexing", page_count: 20, pages_indexed: 6, vision_failed_pages: [3] }),
      ],
      knowledge_page_entities: [
        ent("t1", "self", "030-PID-0201"), ent("t1", "equipment", "V-1"), ent("t1", "ref", "030-PID-0203"), ent("t1", "ref", "030-PID-0202"),
        ent("t2", "self", "030-PID-0202"), ent("t2", "equipment", "V-2"), ent("t2", "ref", "030-PID-0201"),
        ent("c", "self", "025-PID-0101", 1), ent("c", "self", "025-PID-0102", 2), ent("c", "equipment", "P-1", 1),
      ],
      documents: [{ id: "d-t1", org_id: "o1", rev: "B", current_version_id: "v-t1" }],
    });
    // The lens: unchecked, and the why names every page not reached — fix
    // pass 7 said "page(s) 3 never read" and filed the sheet a gap.
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.audit.missingInSeries).toEqual([]);
    expect(lens.audit.missingUnread).toEqual([expect.objectContaining({ ref: "030-PID-0203", maybeIn: [MIDREAD], maybeInIds: ["c"] })]);
    await record("kl-1");
    expect(row("030-PID-0201")).toMatchObject({ revision_code: "B", status: "flagged" });
    expect(details("030-PID-0201")).toMatchObject({ missingReferences: [], provisional: { waitingOn: [MIDREAD], settledStatus: "passed" } });
    // c finishes: page 15 is 030-PID-0203, and references 0201 back.
    Object.assign(doc("c"), { status: "ready", pages_indexed: 20, vision_failed_pages: [] });
    db.tables.knowledge_page_entities.push(ent("c", "self", "030-PID-0203", 15), ent("c", "ref", "030-PID-0201", 15), ent("c", "equipment", "P-15", 15));
    const after = await record("kl-1");
    // Fix pass 7: computed passed, kept flagged at B for good.
    expect(after.body.keptStored).toEqual([]);
    expect(row("030-PID-0201")).toMatchObject({ revision_code: "B", status: "passed" });
    expect(row("030-PID-0201").audit_details).not.toHaveProperty("provisional");
  });

  it("the reviewer's probe midread-opc: an unrevised broken_connectors is never lowered while its destination's re-read is mid-way with a page already queued", async () => {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf" }),
        kdoc("t", { name: "030-PID-0201.pdf" }),
        kdoc("c", { name: "Unit 25 P&IDs.pdf", page_count: 20, pages_indexed: 20 }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 030-PID-0203 SH 1 — TO V-1402" }),
        ent("t", "self", "030-PID-0201"), ent("t", "equipment", "V-9"),
        ent("c", "self", "025-PID-0101", 1), ent("c", "self", "025-PID-0102", 2),
        ent("c", "self", "030-PID-0203", 15), ent("c", "self", "030-PID-0203-SH1", 15), ent("c", "equipment", "P-15", 15),
        ent("c", "opc", "7", 15, { raw: "OPC 7: DWG 025-PID-0104 SH 1 — FROM V-7" }),
      ],
    });
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "", status: "broken_connectors" });
    const before = JSON.stringify(row("025-PID-0104"));
    // A rebuild resets c; batch 1 reads pages 1-6 and queues page 3.
    const page15 = db.tables.knowledge_page_entities.filter((e) => e.document_id === "c" && e.page === 15);
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => !(e.document_id === "c" && e.page === 15));
    Object.assign(doc("c"), { status: "indexing", pages_indexed: 6, vision_failed_pages: [3] });
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnreturned).toEqual([]);
    expect(lens.opcUnpaired).toEqual([expect.objectContaining({ box: "14", to: "030-PID-0203-SH1", maybeInIds: ["c"] })]);
    // Fix pass 7: the connector dropped, nothing in flight, passed written.
    const during = await record("kl-1");
    expect(during.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0104", revision: "", stored: "broken_connectors", computed: "flagged", waitingOn: [MIDREAD],
    })]);
    expect(JSON.stringify(row("025-PID-0104"))).toBe(before);
    // c finishes, page 15 still without box 14: broken, as recorded.
    db.tables.knowledge_page_entities.push(...page15);
    Object.assign(doc("c"), { status: "ready", pages_indexed: 20, vision_failed_pages: [] });
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "", status: "broken_connectors" });
  });

  /** 025-PID-0107.pdf: page 1 is 0107; page 2 holds 0108 (box 3 back to
   *  0104), which a re-index has parked on AI vision under the cap. */
  const PARKED = "025-PID-0107.pdf (page(s) 2 never read)";
  const park0107 = () => {
    const page2 = db.tables.knowledge_page_entities.filter((e) => e.document_id === "p" && e.page === 2);
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => !(e.document_id === "p" && e.page === 2));
    Object.assign(doc("p"), {
      status: "indexing", vision_failed_pages: [2], vision_retry_after: "2026-11-01T00:00:00Z", error: "monthly AI cap reached",
    });
    return () => {
      db.tables.knowledge_page_entities.push(...page2);
      Object.assign(doc("p"), { status: "ready", vision_failed_pages: [], vision_retry_after: null, error: null });
    };
  };

  it("the reviewer's probe parked2: a gap at rev B that the parked PDF's unread page may hold is filed as a gap, waiting on it — and heals once the page is read", async () => {
    seed({
      knowledge_documents: [
        kdoc("t1", { name: "025-PID-0101.pdf", source_document_id: "d-t1", source_version_id: "v-t1", source_rev: "B" }),
        kdoc("t2", { name: "025-PID-0102.pdf" }),
        kdoc("p", { name: "025-PID-0107.pdf", page_count: 2, pages_indexed: 2 }),
      ],
      knowledge_page_entities: [
        ent("t1", "self", "025-PID-0101"), ent("t1", "equipment", "V-1"), ent("t1", "ref", "025-PID-0108"),
        ent("t2", "self", "025-PID-0102"), ent("t2", "equipment", "V-2"),
        ent("p", "self", "025-PID-0107", 1), ent("p", "equipment", "V-7", 1),
        ent("p", "self", "025-PID-0108", 2), ent("p", "ref", "025-PID-0101", 2),
      ],
      documents: [{ id: "d-t1", org_id: "o1", rev: "B", current_version_id: "v-t1" }],
    });
    const finish = park0107();
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.audit.missingUnread).toEqual([]);
    expect(lens.audit.missingInSeries).toEqual([expect.objectContaining({ ref: "025-PID-0108", pendingIn: [PARKED] })]);
    await record("kl-1");
    // Fix pass 7 filed this gap SETTLED at B: once page 2 was read the
    // computed passed was kept below it for good.
    expect(row("025-PID-0101")).toMatchObject({ revision_code: "B", status: "flagged" });
    expect(details("025-PID-0101")).toMatchObject({
      missingReferences: ["References 025-PID-0108, which isn't in the set"], uncheckedReferences: [],
      provisional: { waitingOn: [PARKED], settledStatus: "passed" },
    });
    finish();
    const after = await record("kl-1");
    expect(after.body.keptStored).toEqual([]);
    expect(row("025-PID-0101")).toMatchObject({ revision_code: "B", status: "passed" });
    expect(row("025-PID-0101").audit_details).not.toHaveProperty("provisional");
  });

  it("the reviewer's probe parked-opc: a connector into the parked page of its destination waits — an unrevised broken_connectors is never lowered", async () => {
    seed({
      knowledge_documents: [kdoc("a", { name: "025-PID-0104.pdf" }), kdoc("p", { name: "025-PID-0107.pdf", page_count: 2, pages_indexed: 2 })],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0108 SH 1 — TO V-1402" }),
        ent("p", "self", "025-PID-0107", 1), ent("p", "equipment", "V-7", 1),
        ent("p", "self", "025-PID-0108", 2), ent("p", "self", "025-PID-0108-SH1", 2),
        ent("p", "opc", "3", 2, { raw: "OPC 3: DWG 025-PID-0104 SH 1 — FROM V-3" }),
      ],
    });
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "", status: "broken_connectors" });
    const before = JSON.stringify(row("025-PID-0104"));
    const finish = park0107();
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnpaired).toEqual([expect.objectContaining({
      box: "14", to: "025-PID-0108-SH1", maybeInIds: ["p"],
      why: `no sheet in the set declares it yet, and it may be in ${PARKED}, not read whole yet`,
    })]);
    // Fix pass 7: the parked document held only its own drawing by the
    // settled rule, the connector was dropped, and passed was written.
    const during = await record("kl-1");
    expect(during.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0104", revision: "", stored: "broken_connectors", computed: "flagged", waitingOn: [PARKED],
    })]);
    expect(JSON.stringify(row("025-PID-0104"))).toBe(before);
    finish();
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "", status: "broken_connectors" });
  });

  it("while a document is parked, a settled verdict that would lower an unrevised row waits — even one whose destination only its unread page declared (outside the set's scope)", async () => {
    // 030-PID-0203 stands only on p's page 2: parked, 030-PID leaves the
    // set's scope and the connector into it is dropped — no finding.
    seed({
      knowledge_documents: [kdoc("a", { name: "025-PID-0104.pdf" }), kdoc("p", { name: "025-PID-0107.pdf", page_count: 2, pages_indexed: 2 })],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 030-PID-0203 SH 1 — TO V-1402" }),
        ent("p", "self", "025-PID-0107", 1), ent("p", "equipment", "V-7", 1),
        ent("p", "self", "030-PID-0203", 2), ent("p", "self", "030-PID-0203-SH1", 2),
        ent("p", "opc", "3", 2, { raw: "OPC 3: DWG 025-PID-0104 SH 1 — FROM V-3" }),
      ],
    });
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "", status: "broken_connectors" });
    const before = JSON.stringify(row("025-PID-0104"));
    const finish = park0107();
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnpaired).toEqual([]);
    // Fix pass 7 applied the guard to documents in flight only: passed was
    // written until next month.
    const during = await record("kl-1");
    expect(during.body.waitingOn).toEqual([expect.objectContaining({
      sheetNumber: "025-PID-0104", revision: "", stored: "broken_connectors", computed: "passed", waitingOn: [PARKED],
    })]);
    expect(JSON.stringify(row("025-PID-0104"))).toBe(before);
    finish();
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "", status: "broken_connectors" });
  });

  /** Per-sheet PDFs of 025-PID-0105: SH1's title block read only the base
   *  number; SH2 declares 0105-SH2 and carries box 14 back to 0104. */
  function undeclaredSheets() {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }),
        kdoc("s1", { name: "025-PID-0105 SH1.pdf" }),
        kdoc("s2", { name: "025-PID-0105 SH2.pdf" }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 2 — TO V-1402" }),
        ent("s1", "self", "025-PID-0105"), ent("s1", "equipment", "V-2"),
        ent("s2", "self", "025-PID-0105"), ent("s2", "self", "025-PID-0105-SH2"), ent("s2", "equipment", "V-3"),
        ent("s2", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0104 SH 1 — FROM V-1402" }),
      ],
      documents: [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }],
    });
  }

  for (const state of ["reset", "failed"] as const) {
    it(`the reviewer's probe undecl-${state}: a sheet whose own PDF is ${state === "reset" ? "reset by a rebuild" : "reset and its re-index failed"} is never guessed into its drawing's other PDF — the connector waits on SH2, and rev C stays passed, then heals`, async () => {
      undeclaredSheets();
      await record("kl-1");
      expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
      const before = JSON.stringify(row("025-PID-0104"));
      const saved = db.tables.knowledge_page_entities.filter((e) => e.document_id === "s2");
      db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.document_id !== "s2");
      Object.assign(doc("s2"), state === "reset" ? { status: "queued", pages_indexed: 0 } : { status: "error", error: "corrupt PDF" });
      const label = state === "reset" ? "025-PID-0105 SH2.pdf (not finished indexing)" : "025-PID-0105 SH2.pdf (its indexing failed)";
      // The lens points at SH2 — fix pass 7 paired the box against SH1.pdf
      // ("no page of it declares sheet 2").
      const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
      expect(lens.opcUnpaired).toEqual([expect.objectContaining({
        box: "14", to: "025-PID-0105-SH2", maybeInIds: ["s2"],
        why: `no sheet in the set declares it yet, and it may be in ${label}, not read whole yet`,
      })]);
      expect(lens.opcUnpaired[0]).not.toHaveProperty("toId");
      // Fix pass 7 wrote a SETTLED flagged over passed at C, never lowered.
      const during = await record("kl-1");
      expect(during.body.waitingOn).toEqual(expect.arrayContaining([expect.objectContaining({
        sheetNumber: "025-PID-0104", revision: "C", stored: "passed", computed: "flagged",
        waitingOn: [state === "reset" ? label : "025-PID-0105 SH2.pdf (its indexing failed — re-index it)"],
      })]));
      expect(JSON.stringify(row("025-PID-0104"))).toBe(before);
      db.tables.knowledge_page_entities.push(...saved);
      Object.assign(doc("s2"), { status: "ready", pages_indexed: 1, error: null });
      const after = await record("kl-1");
      expect(after.body.keptStored).toEqual([]);
      expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
      expect(row("025-PID-0104").audit_details).not.toHaveProperty("provisional");
    });
  }

  it("with no other document that may hold it, the undeclared sheet is still paired against its drawing's sole declarer — unpaired, settled", async () => {
    undeclaredSheets();
    // SH2's file is gone; SH1 is all the library holds of 0105, its box
    // numbers read (box 9).
    db.tables.knowledge_documents = db.tables.knowledge_documents.filter((d) => d.id !== "s2");
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.document_id !== "s2");
    db.tables.knowledge_page_entities.push(ent("s1", "opc", "9", 1, { raw: "OPC 9: DWG 025-PID-0199 — TO V-9" }));
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "flagged" });
    expect(details("025-PID-0104").unpairedConnectors).toEqual([
      "Connector 14 continues to 025-PID-0105 SH1.pdf: no page of it declares sheet 2, so which of its pages is the sheet named is not known — the pairing was not checked; check the box on that sheet",
    ]);
    expect(row("025-PID-0104").audit_details).not.toHaveProperty("provisional");
  });

  it("the reviewer's probe scan (minor): a scanned drawing parked under the cap, numbered by its filename, is not in flight — a real gap in another series is filed as a gap, waiting on it, never hidden as unchecked", async () => {
    seed({
      knowledge_documents: [
        kdoc("t1", { name: "040-TK-0001.pdf", source_document_id: "d-t1", source_version_id: "v-t1", source_rev: "B" }),
        kdoc("t2", { name: "040-TK-0002.pdf" }),
        kdoc("p", { name: "025-PID-0107.pdf", status: "indexing", page_count: 1, pages_indexed: 1, vision_failed_pages: [1], vision_retry_after: "2026-11-01T00:00:00Z", error: "monthly AI cap reached" }),
      ],
      knowledge_page_entities: [
        ent("t1", "self", "040-TK-0001"), ent("t1", "equipment", "TK-1"), ent("t1", "ref", "040-TK-0009"),
        ent("t2", "self", "040-TK-0002"), ent("t2", "equipment", "TK-2"),
      ],
      documents: [{ id: "d-t1", org_id: "o1", rev: "B", current_version_id: "v-t1" }],
    });
    const scan = "025-PID-0107.pdf (page(s) 1 never read)";
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    // Fix pass 7: unchecked, "may be in 025-PID-0107.pdf", until November.
    expect(lens.audit.missingUnread).toEqual([]);
    expect(lens.audit.missingInSeries).toEqual([expect.objectContaining({ ref: "040-TK-0009", pendingIn: [scan] })]);
    await record("kl-1");
    expect(row("040-TK-0001")).toMatchObject({ revision_code: "B", status: "flagged" });
    expect(details("040-TK-0001")).toMatchObject({
      missingReferences: ["References 040-TK-0009, which isn't in the set"], uncheckedReferences: [],
      provisional: { waitingOn: [scan], settledStatus: "passed" },
    });
  });
});

describe("DWG-13 / DWG-6 — a provisional verdict is judged again until it settles, whether the document it waits on is read, accepted or fails; a parked scan hides no gap; a prose document is no series (review fix pass 9)", () => {
  const row = (sheet: string) => logRows().find((r) => r.sheet_number === sheet)!;
  const doc = (id: string) => db.tables.knowledge_documents.find((d) => d.id === id)!;
  type Details = {
    missingReferences: string[]; uncheckedReferences: string[]; unpairedConnectors: string[];
    provisional?: { waitingOn: string[]; settledStatus: string };
    set: { seriesNotJudged?: string[] };
  };
  const details = (sheet: string) => row(sheet).audit_details as Details;
  const PARKED_UNDER_CAP = {
    status: "indexing", page_count: 2, pages_indexed: 2, vision_failed_pages: [2],
    vision_retry_after: "2026-11-01T00:00:00Z", error: "monthly AI cap reached",
  };
  /** 025-PID-0104 at rev C: connector 14 into 025-PID-0108 SH1, which no
   *  sheet declares; 030-PID-0201.pdf is parked under the cap with page 2
   *  unread — a parked document may hold any destination in the set's
   *  scope (review fix pass 8), so rev C is filed provisional. */
  function parkedDestination() {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }),
        kdoc("b", { name: "025-PID-0101.pdf" }),
        kdoc("p", { name: "030-PID-0201.pdf", ...PARKED_UNDER_CAP }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0108 SH 1 — TO V-1402" }),
        ent("a", "ref", "025-PID-0108-SH1"),
        ent("b", "self", "025-PID-0101"), ent("b", "equipment", "V-2"),
        ent("p", "self", "030-PID-0201", 1), ent("p", "equipment", "P-1", 1),
      ],
      documents: [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }],
    });
  }
  const WAITING = "030-PID-0201.pdf (page(s) 2 never read)";

  it("the reviewer's probe accept: a controller accepts the parked document's partial index — rev C is judged again and settles passed, never 'already recorded' flagged", async () => {
    parkedDestination();
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "flagged" });
    expect(details("025-PID-0104").provisional).toEqual({ waitingOn: [WAITING], settledStatus: "passed" });
    // app/api/knowledge/ingest acceptPartial: ready, accepted, nothing else
    // changes — its unread pages, and so its "page(s) 2 never read", stay.
    Object.assign(doc("p"), { vision_partial_accepted: true, status: "ready", error: null, vision_retry_after: null });
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.opcUnpaired).toEqual([]);
    const after = await record("kl-1");
    // Fix pass 8: alreadyRecorded, flagged, still "waiting on" it for good.
    expect(after.body.alreadyRecorded).toEqual([]);
    expect(after.body.keptStored).toEqual([]);
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    expect(row("025-PID-0104").audit_details).not.toHaveProperty("provisional");
    // Settled now: the next record leaves it be.
    const again = await record("kl-1");
    expect(again.body.alreadyRecorded).toEqual(expect.arrayContaining([
      { name: "025-PID-0104.pdf", sheetNumber: "025-PID-0104", revision: "C", status: "passed" },
    ]));
  });

  it("the reviewer's probe failed: the parked document's indexing then fails — rev C is judged again, never stuck flagged until someone re-indexes it", async () => {
    parkedDestination();
    await record("kl-1");
    expect(details("025-PID-0104").provisional).toEqual({ waitingOn: [WAITING], settledStatus: "passed" });
    Object.assign(doc("p"), { status: "error", error: "provider refused 5 times", vision_retry_after: null });
    const after = await record("kl-1");
    expect(after.body.alreadyRecorded.map((r: { sheetNumber: string }) => r.sheetNumber)).not.toContain("025-PID-0104");
    // A failed document holds by the settled rule (030-PID-0201's sheets
    // only): the connector into 025-PID-0108 no longer waits on it.
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    expect(row("025-PID-0104").audit_details).not.toHaveProperty("provisional");
  });

  it("a provisional row re-judged while it still waits is kept provisional, and never lowered below what it settled", async () => {
    parkedDestination();
    await record("kl-1");
    const before = JSON.stringify(details("025-PID-0104").provisional);
    const again = await record("kl-1");
    // Judged again — not "already recorded" — and filed as it was.
    expect(again.body.alreadyRecorded.map((r: { sheetNumber: string }) => r.sheetNumber)).not.toContain("025-PID-0104");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "flagged" });
    expect(JSON.stringify(details("025-PID-0104").provisional)).toBe(before);
  });

  it("the reviewer's probe accept-gap: a gap filed while another series' PDF was parked settles, with no stale provisional marker, once its partial index is accepted", async () => {
    seed({
      knowledge_documents: [
        kdoc("t1", { name: "025-PID-0101.pdf", source_document_id: "d-t1", source_version_id: "v-t1", source_rev: "B" }),
        kdoc("t2", { name: "025-PID-0102.pdf" }),
        kdoc("p", { name: "040-TK-0001.pdf", ...PARKED_UNDER_CAP }),
      ],
      knowledge_page_entities: [
        ent("t1", "self", "025-PID-0101"), ent("t1", "equipment", "V-1"), ent("t1", "ref", "025-PID-0108"),
        ent("t2", "self", "025-PID-0102"), ent("t2", "equipment", "V-2"),
        ent("p", "self", "040-TK-0001", 1), ent("p", "equipment", "TK-1", 1),
      ],
      documents: [{ id: "d-t1", org_id: "o1", rev: "B", current_version_id: "v-t1" }],
    });
    await record("kl-1");
    expect(details("025-PID-0101")).toMatchObject({
      missingReferences: ["References 025-PID-0108, which isn't in the set"],
      provisional: { waitingOn: ["040-TK-0001.pdf (page(s) 2 never read)"], settledStatus: "passed" },
    });
    Object.assign(doc("p"), { vision_partial_accepted: true, status: "ready", error: null, vision_retry_after: null });
    await record("kl-1");
    // The accepted partial index never changes, and holds no 025-PID sheet:
    // the gap is settled — flagged, and no longer "waiting".
    expect(row("025-PID-0101")).toMatchObject({ revision_code: "B", status: "flagged" });
    expect(details("025-PID-0101").missingReferences).toEqual(["References 025-PID-0108, which isn't in the set"]);
    expect(row("025-PID-0101").audit_details).not.toHaveProperty("provisional");
  });

  it("the reviewer's probe retry-then-park: a verdict recorded while a document was in flight is judged again once it is parked, and again once accepted — the set's basis names which kind each document is", async () => {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }),
        kdoc("b", { name: "025-PID-0101.pdf" }),
        // Main pass through, page 2 queued, the retry not run yet: in flight.
        kdoc("p", { name: "025-PID-0107.pdf", status: "indexing", page_count: 2, pages_indexed: 2, vision_failed_pages: [2] }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "self", "025-PID-0104-SH1"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 030-PID-0203 SH 1 — TO V-1402" }),
        ent("b", "self", "025-PID-0101"), ent("b", "equipment", "V-2"),
        ent("p", "self", "025-PID-0107", 1), ent("p", "equipment", "V-7", 1),
      ],
      documents: [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }],
    });
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    // Parked under the cap: the same "page(s) 2 never read", another kind.
    Object.assign(doc("p"), { vision_retry_after: "2026-11-01T00:00:00Z", error: "monthly AI cap reached" });
    const parked = await record("kl-1");
    expect(parked.body.alreadyRecorded).toEqual([]);
    Object.assign(doc("p"), { vision_partial_accepted: true, status: "ready", error: null, vision_retry_after: null });
    const accepted = await record("kl-1");
    expect(accepted.body.alreadyRecorded).toEqual([]);
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    // Nothing changed since: done.
    const again = await record("kl-1");
    expect(again.body.alreadyRecorded.map((r: { sheetNumber: string }) => r.sheetNumber)).toContain("025-PID-0104");
  });

  it("the reviewer's probe unnum: a parked scan whose number was never read hides no real gap as unchecked — it is filed as a gap that waits on the scan, and settles once the page is read", async () => {
    seed({
      knowledge_documents: [
        kdoc("t1", { name: "040-TK-0001.pdf", source_document_id: "d-t1", source_version_id: "v-t1", source_rev: "B" }),
        kdoc("t2", { name: "040-TK-0002.pdf" }),
        kdoc("p", { name: "Scan_0001.pdf", ...PARKED_UNDER_CAP, page_count: 1, pages_indexed: 1, vision_failed_pages: [1] }),
      ],
      knowledge_page_entities: [
        ent("t1", "self", "040-TK-0001"), ent("t1", "equipment", "TK-1"), ent("t1", "ref", "040-TK-0009"),
        ent("t2", "self", "040-TK-0002"), ent("t2", "equipment", "TK-2"),
      ],
      documents: [{ id: "d-t1", org_id: "o1", rev: "B", current_version_id: "v-t1" }],
    });
    const scan = "Scan_0001.pdf (page(s) 1 never read)";
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    // Fix pass 8: missingUnread, "NOT counted as one-way or missing".
    expect(lens.audit.missingUnread).toEqual([]);
    expect(lens.audit.missingInSeries).toEqual([expect.objectContaining({ ref: "040-TK-0009", pendingIn: [scan] })]);
    expect(lens.suggestions.join("\n")).not.toMatch(/could not be checked/);
    await record("kl-1");
    expect(row("040-TK-0001")).toMatchObject({ revision_code: "B", status: "flagged" });
    expect(details("040-TK-0001")).toMatchObject({
      missingReferences: ["References 040-TK-0009, which isn't in the set"], uncheckedReferences: [],
      provisional: { waitingOn: [scan], settledStatus: "passed" },
    });
    // The scan is read: a pump datasheet, no 040-TK-0009 on it. The gap
    // settles flagged, with no marker left.
    Object.assign(doc("p"), { status: "ready", vision_failed_pages: [], vision_retry_after: null, error: null });
    db.tables.knowledge_page_entities.push(ent("p", "equipment", "P-101", 1));
    await record("kl-1");
    expect(row("040-TK-0001")).toMatchObject({ revision_code: "B", status: "flagged" });
    expect(row("040-TK-0001").audit_details).not.toHaveProperty("provisional");
  });

  it("the reviewer's probe notjudged: a prose document's filename names no series 'not judged' — on the lens or on the record", async () => {
    seed({
      knowledge_documents: [
        kdoc("t1", { name: "040-TK-0001.pdf" }), kdoc("t2", { name: "040-TK-0002.pdf" }),
        kdoc("m", { name: "Pump Manual.pdf" }), kdoc("s", { name: "Spec Section 15000.pdf" }),
        kdoc("p", { name: "Scan_0001.pdf", ...PARKED_UNDER_CAP, page_count: 1, pages_indexed: 1, vision_failed_pages: [1] }),
      ],
      knowledge_page_entities: [
        ent("t1", "self", "040-TK-0001"), ent("t1", "equipment", "TK-1"), ent("t2", "self", "040-TK-0002"), ent("t2", "equipment", "TK-2"),
      ],
      knowledge_chunks: [chunk("m", "Install the pump on a level base and grout it."), chunk("s", "Section 15000 mechanical general requirements.")],
    });
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    // Fix pass 8: ["PUMP", "SPEC-SECTION"] (and "SCAN_0001.PDF").
    expect(lens.seriesNotJudged).toEqual([]);
    const res = await record("kl-1");
    expect(res.body.seriesNotJudged).toEqual([]);
    for (const r of logRows()) expect((r.audit_details as Details).set).not.toHaveProperty("seriesNotJudged");
    // A real lone drawing is still named.
    db.tables.knowledge_documents.push(kdoc("d", { name: "030-PID-0201.pdf" }));
    db.tables.knowledge_page_entities.push(ent("d", "self", "030-PID-0201"), ent("d", "equipment", "P-9"));
    expect((await (await get("orgId=o1&libraryId=kl-1")).json()).seriesNotJudged).toEqual(["030-PID"]);
  });
});

describe("DWG-4 / DWG-13 — a sheet whose title block gave its drawing number but not the sheet is never a settled gap, a one-way, or a dropped connector; a provisional row settled below its floor is written back as what it settled; a parked scan holds no destination outside the set (review fix pass 10)", () => {
  const row = (sheet: string) => logRows().find((r) => r.sheet_number === sheet)!;
  const doc = (id: string) => db.tables.knowledge_documents.find((d) => d.id === id)!;
  type Details = {
    missingReferences: string[]; uncheckedReferences: string[]; unpairedConnectors: string[]; oneWay: string[]; brokenConnectors: string[];
    provisional?: { waitingOn: string[]; settledStatus: string };
  };
  const details = (sheet: string) => row(sheet).audit_details as Details;

  /** 025-PID-0104 (rev C) references 025-PID-0105-SH2. SH1's title block
   *  declared 025-PID-0105 and its SH1; SH2's gave only 025-PID-0105. */
  function perSheet(sh2Name: string) {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }),
        kdoc("s1", { name: "025-PID-0105-SH1.pdf" }),
        kdoc("s2", { name: sh2Name }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "equipment", "V-1"), ent("a", "ref", "025-PID-0105-SH2"),
        ent("s1", "self", "025-PID-0105"), ent("s1", "self", "025-PID-0105-SH1"), ent("s1", "equipment", "V-5"),
        ent("s2", "self", "025-PID-0105"), ent("s2", "equipment", "V-6"), ent("s2", "ref", "025-PID-0104"),
      ],
      documents: [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }],
    });
  }

  it("the reviewer's probe p3: SH2's sheet field unread — its filename names the sheet, so 0104 and SH2 pass, and nothing is kept once the field is read", async () => {
    perSheet("025-PID-0105-SH2.pdf");
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    // Fix pass 9: a gap ("isn't in the set") and SH2 one-way.
    expect(lens.audit.missingInSeries).toEqual([]);
    expect(lens.audit.missingSheetUnread).toEqual([]);
    expect(lens.audit.oneWay).toEqual([]);
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    expect(details("025-PID-0104").missingReferences).toEqual([]);
    // A rebuild reads SH2's sheet field: nothing to keep.
    db.tables.knowledge_page_entities.push(ent("s2", "self", "025-PID-0105-SH2"));
    const after = await record("kl-1");
    expect(after.body.keptStored).toEqual([]);
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
  });

  it("…named for nothing: 0104's reference is unchecked, settled — never a gap — and SH2's reference back is unchecked, never one-way", async () => {
    perSheet("025-PID-0105 scan.pdf");
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.audit.missingInSeries).toEqual([]);
    expect(lens.audit.missingSheetUnread).toEqual([expect.objectContaining({
      ref: "025-PID-0105-SH2", maybeIn: ["025-PID-0105 scan.pdf (its sheet number was not read on page(s) 1)"], maybeInIds: ["s2"],
    })]);
    expect(lens.audit.missingSheetUnread[0]).not.toHaveProperty("referencedByAll");
    expect(lens.audit.oneWay).toEqual([]);
    expect(lens.audit.oneWaySheetUnread).toEqual([expect.objectContaining({ from: "025-PID-0105 scan.pdf", to: "025-PID-0104.pdf", via: "025-PID-0105-SH2" })]);
    expect(lens.suggestions.join("\n")).toMatch(/2 reference\(s\) could not be checked: they name a sheet no title block in the set declares/);
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "flagged" });
    expect(details("025-PID-0104")).toMatchObject({
      missingReferences: [],
      uncheckedReferences: [
        "References 025-PID-0105-SH2, which no title block in the set declares — it may be in 025-PID-0105 scan.pdf (its sheet number was not read on page(s) 1), so whether it is in the set was not checked",
      ],
    });
    expect(row("025-PID-0104").audit_details).not.toHaveProperty("provisional");
    expect(details("025-PID-0105")).toMatchObject({ oneWay: [] });
  });

  /** A combined PDF: page 1 declares 0105 and its SH1, page 2 only 0105,
   *  page 3 0105 and its SH3. 0104 (rev C) carries connector 16 into sheet 2
   *  and references it; page 2 carries a box (16 or 99) back to 0104. */
  function combined(boxOnPage2: string) {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }),
        kdoc("b", { name: "025-PID-0105.pdf", page_count: 3, pages_indexed: 3, vision_pages: 3 }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "16", 1, { raw: "OPC 16: DWG 025-PID-0105 SH 2 — TO V-1402" }),
        ent("a", "ref", "025-PID-0105-SH2"),
        ent("b", "self", "025-PID-0105", 1), ent("b", "self", "025-PID-0105-SH1", 1),
        ent("b", "self", "025-PID-0105", 2),
        ent("b", "self", "025-PID-0105", 3), ent("b", "self", "025-PID-0105-SH3", 3),
        ent("b", "opc", boxOnPage2, 2, { raw: `OPC ${boxOnPage2}: DWG 025-PID-0104 — FROM V-1` }),
        ent("b", "equipment", "V-5", 1), ent("b", "ref", "025-PID-0104", 2),
      ],
      documents: [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }],
    });
  }

  for (const boxOnPage2 of ["16", "99"]) {
    it(`the reviewer's probe p2 (box ${boxOnPage2} on page 2): a page that declares only the drawing number never rules sheet 2 out — the connector is unpaired, the reference unchecked, and 0104 is never passed with its pairing unchecked`, async () => {
      combined(boxOnPage2);
      const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
      expect(lens.audit.missingInSeries).toEqual([]);
      expect(lens.audit.missingSheetUnread).toEqual([expect.objectContaining({
        ref: "025-PID-0105-SH2", maybeIn: ["025-PID-0105.pdf (its sheet number was not read on page(s) 2)"],
      })]);
      expect(lens.opcUnpaired).toEqual([expect.objectContaining({ box: "16", toId: "b" })]);
      expect(lens.audit.oneWay).toEqual([]);
      await record("kl-1");
      expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "flagged" });
      expect(details("025-PID-0104")).toMatchObject({
        brokenConnectors: [], missingReferences: [],
        unpairedConnectors: [
          "Connector 16 continues to 025-PID-0105.pdf: no page of it declares sheet 2, so which of its pages is the sheet named is not known — the pairing was not checked; check the box on that sheet",
        ],
        uncheckedReferences: [expect.stringMatching(/^References 025-PID-0105-SH2, which no title block in the set declares/)],
      });
      expect(row("025-PID-0104").audit_details).not.toHaveProperty("provisional");
    });
  }

  it("the reviewer's probe p1: a provisional row re-judged below what it settled is written back as that — no marker, no stale finding — and is then already recorded", async () => {
    seed({
      knowledge_documents: [
        kdoc("t1", { name: "025-PID-0101.pdf", source_document_id: "d-t1", source_version_id: "v-t1", source_rev: "B" }),
        kdoc("t2", { name: "025-PID-0102.pdf" }),
        kdoc("p", {
          name: "030-PID-0201.pdf", status: "indexing", page_count: 2, pages_indexed: 2, vision_failed_pages: [2],
          vision_retry_after: "2026-11-01T00:00:00Z", error: "monthly AI cap reached",
        }),
      ],
      knowledge_page_entities: [
        ent("t1", "self", "025-PID-0101"), ent("t1", "equipment", "V-1"), ent("t1", "ref", "025-PID-0102"),
        ent("t1", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0108 SH 1 — TO V-1402" }),
        ent("t2", "self", "025-PID-0102"), ent("t2", "equipment", "V-2"),
        ent("p", "self", "030-PID-0201", 1), ent("p", "equipment", "P-1", 1),
      ],
      documents: [{ id: "d-t1", org_id: "o1", rev: "B", current_version_id: "v-t1" }],
    });
    await record("kl-1");
    // Settled flagged by the one-way finding; the connector waits on the parked PDF.
    expect(row("025-PID-0101")).toMatchObject({ revision_code: "B", status: "flagged" });
    expect(details("025-PID-0101").provisional).toEqual({ waitingOn: ["030-PID-0201.pdf (page(s) 2 never read)"], settledStatus: "flagged" });
    expect(row("025-PID-0101").audit_details).toMatchObject({ waitingFindings: { unpairedConnectors: [0] } });
    // 0102 references back, and the parked PDF's partial index is accepted:
    // the computation is passed — below what the row settled at rev B.
    db.tables.knowledge_page_entities.push(ent("t2", "ref", "025-PID-0101"));
    Object.assign(doc("p"), { vision_partial_accepted: true, status: "ready", error: null, vision_retry_after: null });
    const r2 = await record("kl-1");
    expect(r2.body.keptStored).toEqual([{ sheetNumber: "025-PID-0101", revision: "B", stored: "flagged", computed: "passed" }]);
    expect(r2.body.sheets.map((x: { sheetNumber: string }) => x.sheetNumber)).not.toContain("025-PID-0101");
    // Fix pass 9: kept with its marker and "may be in 030-PID-0201.pdf", for good.
    expect(row("025-PID-0101")).toMatchObject({ revision_code: "B", status: "flagged" });
    expect(row("025-PID-0101").audit_details).not.toHaveProperty("provisional");
    expect(row("025-PID-0101").audit_details).not.toHaveProperty("waitingFindings");
    expect(details("025-PID-0101")).toMatchObject({
      unpairedConnectors: [], oneWay: ["References 025-PID-0102.pdf, which never references back"],
    });
    const r3 = await record("kl-1");
    expect(r3.body.keptStored).toEqual([]);
    expect(r3.body.alreadyRecorded).toEqual(expect.arrayContaining([
      { name: "025-PID-0101.pdf", sheetNumber: "025-PID-0101", revision: "B", status: "flagged" },
    ]));
  });

  it("the reviewer's probe p4: a parked scan whose number was never read holds no connector into a unit the set was never given — 0104 passes; one into the set's scope still waits on it", async () => {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }),
        kdoc("b", { name: "025-PID-0101.pdf" }),
        kdoc("p", {
          name: "Scan_0001.pdf", status: "indexing", page_count: 1, pages_indexed: 1, vision_failed_pages: [1],
          vision_retry_after: "2026-11-01T00:00:00Z", error: "monthly AI cap reached",
        }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "3", 1, { raw: "OPC 3: DWG 999-PID-0001 SH 1 — TO V-9901" }), ent("a", "ref", "999-PID-0001-SH1"),
        ent("b", "self", "025-PID-0101"), ent("b", "equipment", "V-2"),
      ],
      documents: [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }],
    });
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.audit.outOfScope).toEqual([expect.objectContaining({ series: "999-PID-0001" })]);
    // Fix pass 9: also unpaired, "may be in Scan_0001.pdf".
    expect(lens.opcUnpaired).toEqual([]);
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "passed" });
    expect(row("025-PID-0104").audit_details).not.toHaveProperty("provisional");
    // Into the set's scope, it still waits on the scan.
    db.tables.knowledge_page_entities.push(ent("b", "opc", "4", 1, { raw: "OPC 4: DWG 025-PID-0108 SH 1 — TO V-2" }));
    const lens2 = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens2.opcUnpaired).toEqual([expect.objectContaining({ box: "4", maybeInIds: ["p"] })]);
  });

  it("a provisional row written again only because it still waits is counted apart (stillWaiting)", async () => {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }),
        kdoc("b", { name: "025-PID-0101.pdf" }),
        kdoc("p", {
          name: "030-PID-0201.pdf", status: "indexing", page_count: 2, pages_indexed: 2, vision_failed_pages: [2],
          vision_retry_after: "2026-11-01T00:00:00Z", error: "monthly AI cap reached",
        }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0108 SH 1 — TO V-1402" }),
        ent("b", "self", "025-PID-0101"), ent("b", "equipment", "V-2"),
        ent("p", "self", "030-PID-0201", 1), ent("p", "equipment", "P-1", 1),
      ],
      documents: [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }],
    });
    const first = await record("kl-1");
    expect(first.body.stillWaiting).toBe(0);
    const again = await record("kl-1");
    expect(again.body.sheets.map((x: { sheetNumber: string }) => x.sheetNumber)).toContain("025-PID-0104");
    expect(again.body.stillWaiting).toBe(1);
  });
});

describe("DWG-13 — a row shared by per-sheet PDFs settles with the finding that settled it; a recorded verdict is said to stay until its sheet is revised (review fix pass 11)", () => {
  const row = (sheet: string) => logRows().find((r) => r.sheet_number === sheet)!;
  const doc = (id: string) => db.tables.knowledge_documents.find((d) => d.id === id)!;
  type Details = {
    missingReferences: string[]; uncheckedReferences: string[]; unpairedConnectors: string[]; oneWay: string[]; brokenConnectors: string[];
    provisional?: { waitingOn: string[]; settledStatus: string };
  };
  const details = (sheet: string) => row(sheet).audit_details as Details;
  const oneWay = "References 025-PID-0101.pdf, which never references back";

  // The reviewer's probes m1 and m1b: SH1 and SH2 of 025-PID-0105 (rev C)
  // share the key. SH1's connector waits on the parked 030-PID-0201.pdf;
  // SH2's one-way into 0101 is settled. Listed by name, so the documents'
  // order in the library never changes the row.
  for (const sh1First of [true, false]) {
    it(`the reviewer's probe ${sh1First ? "m1" : "m1b"}: the shared row names SH2's settled one-way; settled below it, it is written back with that finding — never flagged with nothing named`, async () => {
      const sh1 = kdoc("s1", { name: "025-PID-0105-SH1.pdf", source_document_id: "d-1", source_version_id: "v-1", source_rev: "C" });
      const rest = [
        kdoc("s2", { name: "025-PID-0105-SH2.pdf", source_document_id: "d-2", source_version_id: "v-2", source_rev: "C" }),
        kdoc("t", { name: "025-PID-0101.pdf" }),
        kdoc("p", {
          name: "030-PID-0201.pdf", status: "indexing", page_count: 2, pages_indexed: 2, vision_failed_pages: [2],
          vision_retry_after: "2026-11-01T00:00:00Z", error: "monthly AI cap reached",
        }),
      ];
      seed({
        knowledge_documents: sh1First ? [sh1, ...rest] : [...rest, sh1],
        knowledge_page_entities: [
          ent("s1", "self", "025-PID-0105"), ent("s1", "self", "025-PID-0105-SH1"), ent("s1", "equipment", "V-1"),
          ent("s1", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0108 SH 1 — TO V-1402" }),
          ent("s2", "self", "025-PID-0105"), ent("s2", "self", "025-PID-0105-SH2"), ent("s2", "equipment", "V-2"),
          ent("s2", "ref", "025-PID-0101"),
          ent("t", "self", "025-PID-0101"), ent("t", "equipment", "V-3"),
          ent("p", "self", "030-PID-0201", 1), ent("p", "equipment", "P-1", 1),
        ],
        documents: [
          { id: "d-1", org_id: "o1", rev: "C", current_version_id: "v-1" },
          { id: "d-2", org_id: "o1", rev: "C", current_version_id: "v-2" },
        ],
      });
      const r1 = await record("kl-1");
      expect(r1.status).toBe(200);
      expect(row("025-PID-0105")).toMatchObject({ revision_code: "C", status: "flagged" });
      expect(details("025-PID-0105").provisional).toEqual({ waitingOn: ["030-PID-0201.pdf (page(s) 2 never read)"], settledStatus: "flagged" });
      // Fix pass 10: oneWay [] — the row held SH1's waiting connector alone.
      expect(details("025-PID-0105").oneWay).toEqual([oneWay]);
      expect(details("025-PID-0105").unpairedConnectors).toEqual([expect.stringMatching(/^Connector 14 continues to 025-PID-0108-SH1: /)]);
      expect(row("025-PID-0105").audit_details).toMatchObject({ waitingFindings: { unpairedConnectors: [0] } });
      // 0101 references SH2 back, and the parked PDF's partial index is
      // accepted: the computation is passed, below what the row settled.
      db.tables.knowledge_page_entities.push(ent("t", "ref", "025-PID-0105-SH2"));
      Object.assign(doc("p"), { vision_partial_accepted: true, status: "ready", error: null, vision_retry_after: null });
      const r2 = await record("kl-1");
      expect(r2.body.keptStored).toEqual([{ sheetNumber: "025-PID-0105", revision: "C", stored: "flagged", computed: "passed" }]);
      expect(row("025-PID-0105")).toMatchObject({ revision_code: "C", status: "flagged" });
      expect(row("025-PID-0105").audit_details).not.toHaveProperty("provisional");
      expect(row("025-PID-0105").audit_details).not.toHaveProperty("waitingFindings");
      // Fix pass 10: every list empty — flagged for no reason, for good.
      expect(details("025-PID-0105")).toMatchObject({
        oneWay: [oneWay], unpairedConnectors: [], missingReferences: [], uncheckedReferences: [], brokenConnectors: [],
      });
      const r3 = await record("kl-1");
      expect(r3.body.keptStored).toEqual([]);
      expect(r3.body.alreadyRecorded).toEqual(expect.arrayContaining([
        { name: "025-PID-0105-SH1.pdf", sheetNumber: "025-PID-0105", revision: "C", status: "flagged" },
      ]));
    });
  }

  // The reviewer's probe c1: the remedy the lens gives for a reference into
  // a sheet whose page gave only its drawing number promised the re-index
  // would judge it. A verdict recorded at a known revision is never lowered:
  // the copy says so, and the verdict is listed as kept.
  it("the reviewer's probe c1: the lens says a verdict already recorded at a known revision stays as recorded, and the record lists it as kept once the field is read", async () => {
    seed({
      knowledge_documents: [
        kdoc("a", { name: "025-PID-0104.pdf", source_document_id: "d-a", source_version_id: "v-a", source_rev: "C" }),
        kdoc("b", { name: "025-PID-0105.pdf", page_count: 3, pages_indexed: 3, vision_pages: 3 }),
      ],
      knowledge_page_entities: [
        ent("a", "self", "025-PID-0104"), ent("a", "equipment", "V-1"),
        ent("a", "opc", "16", 1, { raw: "OPC 16: DWG 025-PID-0105 SH 2 — TO V-1402" }),
        ent("a", "ref", "025-PID-0105-SH2"),
        ent("b", "self", "025-PID-0105", 1), ent("b", "self", "025-PID-0105-SH1", 1),
        ent("b", "self", "025-PID-0105", 2),
        ent("b", "self", "025-PID-0105", 3), ent("b", "self", "025-PID-0105-SH3", 3),
        ent("b", "opc", "16", 2, { raw: "OPC 16: DWG 025-PID-0104 — FROM V-1" }),
        ent("b", "equipment", "V-5", 1), ent("b", "ref", "025-PID-0104", 2),
      ],
      documents: [{ id: "d-a", org_id: "o1", rev: "C", current_version_id: "v-a" }],
    });
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    const said = (lens.suggestions as string[]).find((x) => /name a sheet no title block in the set declares/.test(x)) ?? "";
    expect(said).toMatch(/re-index that drawing so its sheet numbers are read, and they are judged here/);
    expect(said).toMatch(/Judging them can raise a recorded verdict but never lowers a settled one: a sheet whose verdict is already recorded at a known revision keeps it \(listed as kept when the audit is recorded\) until the sheet is revised\./);
    expect(said).not.toMatch(/stays as recorded/);
    await record("kl-1");
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "flagged" });
    // A re-index reads page 2's sheet field: the lens judges it — nothing
    // unchecked, nothing unpaired — and the recorded verdict is kept.
    db.tables.knowledge_page_entities.push(ent("b", "self", "025-PID-0105-SH2", 2));
    const lens2 = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens2.opcUnpaired).toEqual([]);
    expect(lens2.audit.missingSheetUnread).toEqual([]);
    const r2 = await record("kl-1");
    expect(r2.body.keptStored).toEqual([{ sheetNumber: "025-PID-0104", revision: "C", stored: "flagged", computed: "passed" }]);
    expect(row("025-PID-0104")).toMatchObject({ revision_code: "C", status: "flagged" });
  });
});

describe("DWG-13 / DWG-6 — a missing sheet is a finding against EVERY sheet that references it (review fix pass 5)", () => {
  it("eight sheets reference 025-PID-0199: all eight are flagged — the lens lists six, the record files eight", async () => {
    const docs = Array.from({ length: 8 }, (_, i) => kdoc(`m-${i + 1}`, { name: `025-PID-010${i + 1}.pdf` }));
    seed({
      knowledge_documents: docs,
      knowledge_page_entities: docs.flatMap((d, i) => [
        ent(d.id as string, "self", `025-PID-010${i + 1}`), ent(d.id as string, "equipment", `V-${i + 1}`),
        ent(d.id as string, "ref", "025-PID-0199"),
      ]),
    });
    const lens = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(lens.audit.missingInSeries).toHaveLength(1);
    expect(lens.audit.missingInSeries[0].referencedBy).toHaveLength(6);
    expect(lens.audit.missingInSeries[0]).not.toHaveProperty("referencedByAll");
    const res = await record("kl-1");
    expect(res.body.recorded).toBe(8);
    expect(logRows().map((r) => [r.sheet_number, r.status]).sort()).toEqual(
      docs.map((_, i) => [`025-PID-010${i + 1}`, "flagged"]),
    );
    for (const r of logRows()) {
      expect((r.audit_details as { missingReferences: string[] }).missingReferences).toEqual(["References 025-PID-0199, which isn't in the set"]);
    }
  });
});

describe("DWG-6 — the lens judges gaps by the record's rule (review fix pass 3)", () => {
  it("a reference into a series the library does not hold is no gap on screen either; the series is named", async () => {
    twoLibraries();
    db.tables.knowledge_page_entities.push(ent("c-106", "ref", "025-PID-0107"));
    // Crude Unit holds 025-PID: 0107 IS a gap there.
    const crude = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(crude.audit.missingInSeries.map((m: { ref: string }) => m.ref)).toEqual(["025-PID-0107"]);
    expect(crude.seriesNotJudged).toEqual([]);
    // Tank Farm holds one 025-PID number: its references to 0105 and 0107
    // are not judged — the same as its record.
    const tank = await (await get("orgId=o1&libraryId=kl-2")).json();
    expect(tank.audit.missingInSeries).toEqual([]);
    expect(tank.seriesNotJudged).toEqual(["025-PID"]);
    expect(tank.suggestions.join(" ")).not.toMatch(/gaps in the set/);
    expect((await record("kl-2")).body.seriesNotJudged).toEqual(tank.seriesNotJudged);
  });
});

describe("DWG-6 — before 20261124, another library's unknown-revision verdict is never lowered (review fix pass 3)", () => {
  it("library B's computation never replaces library A's row on the org-wide key; A's own row still takes its latest verdict", async () => {
    seed({
      knowledge_documents: [kdoc("a-1", { name: "A 100-E-001.pdf" }), kdoc("b-1", { library_id: "kl-2", name: "B 100-E-001.pdf" })],
      knowledge_page_entities: [
        ent("a-1", "self", "100-E-001"), ent("a-1", "equipment", "V-1"), ent("a-1", "opc", "7", 1, { raw: "OPC 7: DWG NONE — FROM DESALTER" }),
        ent("b-1", "self", "100-E-001", 1, { library_id: "kl-2" }), ent("b-1", "equipment", "V-1", 1, { library_id: "kl-2" }),
      ],
    });
    db.missingColumns.drawing_audit_logs = ["library_id"];
    await record("kl-1");
    expect(logRows()).toEqual([expect.objectContaining({ sheet_number: "100-E-001", revision_code: "", status: "broken_connectors" })]);
    const b = await record("kl-2");
    expect(b.body.legacyKey).toBe(true);
    expect(b.body.notice).toMatch(/a verdict another library recorded is never lowered by this one/);
    expect(b.body.keptStored).toEqual([expect.objectContaining({ sheetNumber: "100-E-001", revision: "", stored: "broken_connectors", computed: "passed" })]);
    expect(logRows()).toEqual([expect.objectContaining({ status: "broken_connectors" })]);
    // Library A fixes its own sheet: its own unknown-revision row takes the latest verdict.
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.kind !== "opc");
    await record("kl-1");
    expect(logRows()).toEqual([expect.objectContaining({ status: "passed" })]);
  });
});

describe("DWG-6 — one multi-sheet drawing never makes its parent series 'held' (review fix pass 2)", () => {
  it("Tank Farm holding 025-PID-0104 as per-sheet PDFs files no gap against 025-PID", async () => {
    seed({
      knowledge_documents: [
        kdoc("t-s1", { name: "025-PID-0104 SH1.pdf" }), kdoc("t-s2", { name: "025-PID-0104 SH2.pdf" }), kdoc("t-tf", { name: "TF-PID-0001.pdf" }),
      ],
      knowledge_page_entities: [
        ent("t-s1", "self", "025-PID-0104"), ent("t-s1", "self", "025-PID-0104-SH1"),
        ent("t-s2", "self", "025-PID-0104"), ent("t-s2", "self", "025-PID-0104-SH2"),
        ent("t-tf", "self", "TF-PID-0001"),
        ent("t-s1", "ref", "025-PID-0107"), ent("t-s1", "ref", "025-PID-0104-SH2"), ent("t-s2", "ref", "025-PID-0104-SH1"),
        ent("t-s1", "equipment", "V-1"), ent("t-s2", "equipment", "V-2"), ent("t-tf", "equipment", "TK-1"),
      ],
    });
    const a = await record("kl-1");
    expect(a.body.seriesNotJudged).toEqual(["025-PID", "TF-PID"]);
    const r104 = logRows().find((r) => r.sheet_number === "025-PID-0104")!;
    expect(r104.status).toBe("passed");
    expect((r104.audit_details as { missingReferences: string[] }).missingReferences).toEqual([]);
  });
});

describe("ING-12 — the library page's Re-index all continues where it stopped (review fix pass 2)", () => {
  it("a cursorless call that runs out of time keeps its place on the library row; the next press continues and clears it", async () => {
    const docs = Array.from({ length: 8 }, (_, i) => kdoc(`r-${i}`, { name: `D${i}.pdf` }));
    seed({ knowledge_documents: docs });
    db.tables.knowledge_libraries[0].ai_features = { decoder: "first two digits = unit" };
    // Each reset "takes" 30 s: the 40 s budget admits one round of six.
    const real = Date.now();
    let clock = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real + clock);
    db.hooks.push((op) => {
      if (op.table === "knowledge_documents" && op.kind === "update" && (op.payload as Row)?.status === "stale") clock += 30_000;
    });
    try {
      const first = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild" });
      const a = await first.json();
      expect(first.status).toBe(409);
      expect(a).toMatchObject({ docs: 6, remaining: 2, cursor: "r-5", resumedFrom: null, partial: true });
      expect(a.error).toMatch(/2 were not reached in time[\s\S]*Press the button again \(within 6 hours\) to continue from where this call stopped/);
      const ai1 = db.tables.knowledge_libraries[0].ai_features as Record<string, unknown>;
      expect(ai1).toMatchObject({ decoder: "first two digits = unit", rebuildCursor: { cursor: "r-5" } });

      const resets = () => db.ops.filter((o) => o.table === "knowledge_documents" && o.kind === "update" && (o.payload as Row)?.status === "stale")
        .map((o) => o.filters.find((f) => f.col === "id")?.value);
      const before = resets().length;
      const second = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild" });
      expect(second.status).toBe(200);
      const b = await second.json();
      expect(b).toMatchObject({ docs: 2, remaining: 0, resumedFrom: "r-5" });
      // A press that finished what an earlier one began says so (review fix pass 3).
      expect(b.notice).toMatch(/Continued from where the last press stopped: 2 document\(s\) queued by this press; the documents earlier presses queued were not reset again/);
      // Only the two it had not reached: no document reset twice.
      expect(resets().slice(before)).toEqual(["r-6", "r-7"]);
      // Done: the place is cleared, the rest of the library's setup kept.
      expect(db.tables.knowledge_libraries[0].ai_features).toEqual({ decoder: "first two digits = unit" });
    } finally { spy.mockRestore(); }
  });

  it("a place older than the resume window is ignored: the press starts from the first document", async () => {
    seed({ knowledge_documents: [kdoc("a-1"), kdoc("a-2"), kdoc("a-3")] });
    db.tables.knowledge_libraries[0].ai_features = { rebuildCursor: { cursor: "a-2", at: new Date(Date.now() - 7 * 3600_000).toISOString() } };
    const stale = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild" });
    const fromTop = await stale.json();
    expect(fromTop).toMatchObject({ docs: 3, resumedFrom: null });
    expect(fromTop.notice).toBeUndefined();
    // A fresh one is followed.
    seed({ knowledge_documents: [kdoc("a-1"), kdoc("a-2"), kdoc("a-3")] });
    db.tables.knowledge_libraries[0].ai_features = { rebuildCursor: { cursor: "a-2", at: new Date(Date.now() - 3600_000).toISOString() } };
    const fresh = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild" });
    expect(await fresh.json()).toMatchObject({ docs: 1, resumedFrom: "a-2", remaining: 0 });
    expect(rowsOf("knowledge_documents").filter((d) => d.status === "stale").map((d) => d.id)).toEqual(["a-3"]);
    expect(db.tables.knowledge_libraries[0].ai_features).toEqual({});
  });

  it("the panel's own calls (a cursor key, even null) never read or write the kept place", async () => {
    seed({ knowledge_documents: [kdoc("a-1"), kdoc("a-2")] });
    db.tables.knowledge_libraries[0].ai_features = { rebuildCursor: { cursor: "a-1", at: new Date().toISOString() } };
    const res = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild", cursor: null });
    expect(await res.json()).toMatchObject({ docs: 2 });
    expect(db.tables.knowledge_libraries[0].ai_features).toEqual({ rebuildCursor: expect.objectContaining({ cursor: "a-1" }) });
  });
});
