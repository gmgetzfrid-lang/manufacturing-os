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
vi.mock("@/lib/knowledgeVision", () => ({ VISION_MODEL: { anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini", gemini: "gemini-2.5-flash" }, transcribePageImage: vi.fn() }));
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
import { INGEST_LEASE_TTL_MS } from "@/lib/knowledgeIngest";

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
    db.tables.knowledge_documents.find((d) => d.id === "u-102")!.status = "indexing";
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
    db.tables.knowledge_documents.find((d) => d.id === "c-106")!.status = "indexing";
    await record("kl-1");
    const first = logRows().find((r) => r.library_id === "kl-1" && r.sheet_number === "025-PID-0106")!;
    expect(first.status).toBe("skipped");
    first.audited_at = "2026-09-01T00:00:00.000Z";
    db.tables.knowledge_documents.find((d) => d.id === "c-106")!.status = "ready";
    const again = await record("kl-1");
    expect(again.body.recorded).toBe(1);
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
    // The cheaper remedy first: a keyed rebuild reads such pages page by page.
    expect(said).toMatch(/1 sheet\(s\) look like SHX exports[\s\S]*Hit "Rebuild index" with your AI key saved: a page like that is read by AI vision during indexing, page by page/);
    // No key has been used in this library: the every-page switch is not offered.
    expect(said).not.toMatch(/index every page as an image/);
    expect(said).not.toMatch(/normal for prose documents/);
  });

  it("the library-wide every-page switch is offered only once a keyed rebuild has evidently left SHX sheets unread (review fix pass 3)", async () => {
    seed({
      knowledge_documents: [kdoc("x-1"), kdoc("v-1", { vision_pages: 3 })],
      knowledge_page_entities: [ent("x-1", "self", "025-PID-0104"), ent("x-1", "ref", "025-PID-0104-SH1"), ent("v-1", "equipment", "V-1")],
      knowledge_chunks: [chunk("x-1", "DRAWING NO: 025-PID-0104 SHEET 1 GENERAL ARRANGEMENT"), chunk("v-1", "V-1 SUCTION DRUM")],
    });
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(body.sheets.find((s: { id: string }) => s.id === "x-1")).toMatchObject({ shxLike: true });
    const said = body.suggestions.join(" ");
    expect(said).toMatch(/Hit "Rebuild index" with your AI key saved[\s\S]*1 document\(s\) here were read by AI vision[\s\S]*if a rebuild with your key saved still leaves these sheets unread[\s\S]*Text doesn't extract from these files — index every page as an image/);
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
    const cost = estimateCostUsd("claude-haiku-4-5", big);
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
        kdoc("s-2", { name: "2002-D-2001 SH2.pdf", source_document_id: "d-s2", source_version_id: "v-s2", source_rev: "0", status: "indexing" }),
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
    db.tables.knowledge_documents.find((d) => d.id === "s-2")!.status = "ready";
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

  it("while a sheet is being indexed, no verdict is re-decided by its half-built index — and the response says so", async () => {
    twoLibraries();
    db.tables.knowledge_page_entities.push(ent("c-104", "opc", "14", 1, { raw: "OPC 14: DWG 025-PID-0105 SH 1 — TO V-1402" }));
    await record("kl-1");
    // 0105 is mid-rebuild: some of its boxes are back, it is not finished.
    db.tables.knowledge_documents.find((d) => d.id === "c-105")!.status = "indexing";
    db.tables.knowledge_page_entities.push(ent("c-105", "opc", "7", 1, { raw: "OPC 7: DWG 025-PID-0199 — TO V-7" }));
    const during = await record("kl-1");
    expect(during.body.indexingNow).toEqual(["025-PID-0105.pdf"]);
    expect(during.body.alreadyRecorded.map((a: { sheetNumber: string }) => a.sheetNumber)).toContain("025-PID-0104");
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ status: "flagged" });
    // Finished: 0104 is re-judged against what 0105 now holds.
    db.tables.knowledge_documents.find((d) => d.id === "c-105")!.status = "ready";
    const after = await record("kl-1");
    expect(after.body.indexingNow).toBeUndefined();
    expect(logRows().find((r) => r.sheet_number === "025-PID-0104")).toMatchObject({ status: "broken_connectors" });
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
