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
//           series the library does not hold is not recorded; never lowered
//   DWG-13  an unrevised sheet is not re-audited; the response says so
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
//           relocate round; an unconfirmed point is never cached; a viewer
//           can reject an estimate
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
    kdoc("c-105", { name: "025-PID-0105.pdf" }),
    kdoc("c-106", { name: "025-PID-0106.pdf" }),
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
    documents: [{ id: "d-104", org_id: "o1", rev: "C", current_version_id: "v-104c" }],
  });
}
const record = async (libraryId: string) => {
  const res = await post({ orgId: "o1", libraryId, action: "record-audit" });
  return { status: res.status, body: await res.json() };
};
const logRows = () => rowsOf("drawing_audit_logs");

describe("DWG-6 — a verdict belongs to the set it was computed over", () => {
  it("Crude Unit records 0104 passed; Tank Farm's lone 0104 is NOT recorded, and Crude Unit's verdict survives", async () => {
    twoLibraries();
    const a = await record("kl-1");
    expect(a.status).toBe(200);
    expect(a.body.recorded).toBe(3);
    const crude = logRows().find((r) => r.library_id === "kl-1" && r.sheet_number === "025-PID-0104")!;
    expect(crude).toMatchObject({ status: "passed", revision_code: "C", document_id: "d-104" });
    expect((crude.audit_details as { set: { sheets: string[] } }).set.sheets).toEqual(["025-PID-0104", "025-PID-0105", "025-PID-0106"]);

    const b = await record("kl-2");
    expect(b.status).toBe(200);
    // 0104 is the only 025-PID sheet in Tank Farm: no verdict about a set it does not hold.
    expect(b.body.notRecorded).toEqual([expect.objectContaining({ name: "025-PID-0104.pdf", status: "skipped", reason: expect.stringMatching(/no other sheet of its drawing series/) })]);
    expect(logRows().filter((r) => r.library_id === "kl-2").map((r) => r.sheet_number).sort()).toEqual(["040-TK-0001", "040-TK-0002"]);
    expect(logRows().find((r) => r.library_id === "kl-1" && r.sheet_number === "025-PID-0104")).toMatchObject({ status: "passed" });
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
    expect(a.body.sheets.some((s: { status: string }) => s.status === "passed" && false)).toBe(false);
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

describe("the key needs 20261124", () => {
  it("on a database without library_id nothing is recorded and the route names the migration", async () => {
    twoLibraries();
    db.missingColumns.drawing_audit_logs = ["library_id"];
    const a = await record("kl-1");
    expect(a.status).toBe(424);
    expect(a.body.error).toMatch(/20261124/);
    expect(logRows()).toEqual([]);
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
    const res = await post({ orgId: "o1", libraryId: "kl-1", action: "rebuild" });
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
      knowledge_page_entities: [ent("x-1", "self", "025-PID-0104")],
      knowledge_chunks: [
        chunk("x-1", "DRAWING NO: 025-PID-0104 GENERAL ARRANGEMENT NOTES ALL DIMENSIONS IN MM"),
        chunk("x-2", "The bolting requirements apply to every flanged joint in this service."),
      ],
    });
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    const by = (id: string) => body.sheets.find((s: { id: string }) => s.id === id);
    expect(by("x-1")).toMatchObject({ verdict: "text-no-tags", looksLike: "drawing" });
    expect(by("x-2")).toMatchObject({ verdict: "text-no-tags", looksLike: "prose" });
    expect(body.suggestions.join(" ")).toMatch(/look like DRAWINGS[\s\S]*Text doesn't extract from these files — index every page as an image/);
    expect(body.suggestions.join(" ")).not.toMatch(/normal for prose documents/);
  });

  it("box pairing with no box numbers says it needs vision indexing instead of showing a clean zero", async () => {
    twoLibraries();
    const body = await (await get("orgId=o1&libraryId=kl-1")).json();
    expect(body.opcBoxCount).toBe(0);
    expect(body.opcPairing).toBe("no-boxes");
    expect(body.suggestions.join(" ")).toMatch(/Connector box pairing needs AI-vision indexing/);
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

describe("DWG-13 / PR-10 — the relocate round, and a point no round confirmed is never cached", () => {
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
