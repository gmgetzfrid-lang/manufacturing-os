// document-control Round F wave 2 — P13 STATUS-TRANSITION: intelligence
// GAP-314's document-control half — the unit decode at create time.
//
//   * POST /api/documents/unit-code (member-callable) re-reads each
//     document's STORED number with the service role, in the caller's org,
//     for documents the caller's own session can read, and writes
//     documents.unit_code with the backfill's planner and guarded writes
//     (lib/unitCodeDecode.ts, extracted from POST /api/admin/unit-identity);
//     a number that does not decode is left NULL and its reason recorded.
//   * acceptance 3: a document is CREATED (its row lands with unit_code NULL,
//     as 20261138's guard makes a person's insert) and then RENUMBERED (the
//     guard drops the old decode), driven through the browser helper
//     (lib/unitCodeClient.ts requestUnitCodeDecode → fetch → the route) — and
//     the decode follows the number each time.
//   * every creation door and renumber path this package owns asks for it,
//     best-effort, after its write (pinned by source); the helper never
//     throws.
//
// The database is helpers/graphFakeDb.ts (the unit-identity tests' stand-in);
// 20261138's renumber rule is transcribed as its BEFORE UPDATE trigger.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { GraphFakeDb, Row } from "./helpers/graphFakeDb";

const h = vi.hoisted(() => {
  const mk = () => ({
    tables: {}, missingTables: new Set<string>(), missingColumns: {}, readError: {}, hidden: {},
    refuseWrites: new Set<string>(), writeError: {}, rpc: {}, calls: [], seq: 0, triggers: {}, insertTriggers: {}, maxRows: 1000, beforeWrite: null,
  });
  return { admin: mk() as unknown as GraphFakeDb, caller: mk() as unknown as GraphFakeDb, session: "good" as string | null };
});

vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeGraphFake } = await import("./helpers/graphFakeDb");
  const fake = makeGraphFake(h.admin);
  return {
    supabaseAdmin: {
      ...fake,
      auth: {
        getUser: async (t: string) => t === "good"
          ? { data: { user: { id: "uid-1", email: "a@x.test" } }, error: null }
          : t === "outsider"
            ? { data: { user: { id: "uid-9", email: "o@x.test" } }, error: null }
            : { data: { user: null }, error: { message: "bad token" } },
      },
    },
  };
});
// The caller's own session: the same tables, with the documents RLS hides from them.
vi.mock("@/lib/serverAuth", async () => {
  const { makeGraphFake } = await import("./helpers/graphFakeDb");
  return { callerScopedClient: () => makeGraphFake(h.caller) };
});
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: h.session ? { access_token: h.session } : null } }) } },
}));

import { POST } from "@/app/api/documents/unit-code/route";
import { requestUnitCodeDecode } from "@/lib/unitCodeClient";
import { decodeDocumentUnitCodes, DECODE_MAX_DOCUMENTS } from "@/lib/unitCodeDecode";

const ORG = "org-1";
const o = <T extends Row>(r: T): T & { org_id: string } => ({ org_id: ORG, ...r });
const SEGMENTS = [{ kind: "unit", digits: 2 }, { kind: "drawing_type", digits: 2 }, { kind: "size", letters: 1 }, { kind: "iterable" }, { kind: "sheet" }];

function seed() {
  h.admin.tables = {
    org_members: [
      o({ uid: "uid-1", role: "Engineer", roles: ["Engineer"], status: "active", email: "a@x.test" }),
      { org_id: "org-2", uid: "uid-9", role: "Engineer", roles: ["Engineer"], status: "active" },
    ],
    codebook_entries: [
      o({ id: "e20", kind: "unit", code: "20", label: "Crude Unit", meta: {}, sort: 0, origin: "manual" }),
      o({ id: "e30", kind: "unit", code: "30", label: "Coker", meta: {}, sort: 1, origin: "manual" }),
    ],
    codebook_config: [o({ drawing_number: { segments: SEGMENTS }, iterable_rule: { mirrorsTag: true, padTo: 0 }, legend_doc_ids: [] })],
    units: [o({ id: "u20", codebook_code: "20", archived: false }), o({ id: "u30", codebook_code: "30", archived: false })],
    documents: [
      o({ id: "hidden1", document_number: "2002-D-5", unit_code: null, unit_id: null, visibility: "restricted" }),
      { id: "other-org", org_id: "org-2", document_number: "2002-D-6", unit_code: null, unit_id: null },
    ],
    audit_logs: [],
  } as Record<string, Row[]>;
  for (const db of [h.admin, h.caller]) {
    db.missingTables = new Set(); db.missingColumns = {}; db.readError = {}; db.hidden = {};
    db.refuseWrites = new Set(); db.writeError = {}; db.rpc = {}; db.calls = []; db.seq = 0;
    db.triggers = {}; db.insertTriggers = {}; db.maxRows = 1000; db.beforeWrite = null;
  }
  h.caller.tables = h.admin.tables; // one database, two sessions
  h.caller.hidden = { documents: (r) => r.visibility === "restricted" };
  // 20261138's trg_documents_unit_code_guard, its renumber rule (the service role too):
  // a renumbered document's old decode is dropped unless the same write sets a new one.
  h.admin.triggers!.documents = (row, patch) =>
    "document_number" in patch && patch.document_number !== row.document_number && !("unit_code" in patch)
      ? { ...patch, unit_code: null } : patch;
  h.session = "good";
}
const doc = (id: string) => h.admin.tables.documents.find((r) => r.id === id)!;
/** A person's INSERT: 20261138 lands unit_code NULL whatever is sent. */
const create = (id: string, number: string | null, extra: Row = {}) =>
  h.admin.tables.documents.push(o({ id, document_number: number, unit_code: null, unit_id: null, visibility: null, ...extra }));
/** A person's renumber, through the transcribed trigger. */
const renumber = (id: string, number: string) => {
  const r = doc(id);
  Object.assign(r, h.admin.triggers!.documents!(r, { document_number: number }));
};
const call = (body: unknown, token: string | null = "good") => POST(new NextRequest("http://x/api/documents/unit-code", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}));

beforeEach(() => seed());

describe("GAP-314 acceptance 3 — a document created and then renumbered carries the codebook's decode, through the browser helper and the route", () => {
  const g = globalThis as unknown as { window?: unknown; fetch: typeof fetch };
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = g.fetch;
    g.window = {};
    g.fetch = (async (url: string, init?: RequestInit) => POST(new NextRequest(`http://x${url}`, init as never))) as typeof fetch;
  });
  afterEach(() => { delete g.window; g.fetch = realFetch; });

  it("created: NULL at insert, the decode follows; renumbered: the old decode drops and the new one follows; renumbered to a number that does not decode: NULL, with the reason recorded", async () => {
    create("n1", "2002-D-10001");
    expect(doc("n1").unit_code).toBeNull();
    const created = await requestUnitCodeDecode(ORG, ["n1"], "upload");
    expect(created.note).toBeNull();
    expect(created.results).toEqual([{ documentId: "n1", unitCode: "20", outcome: "decoded", reason: null }]);
    expect(doc("n1").unit_code).toBe("20");

    renumber("n1", "3002-D-10001");
    expect(doc("n1").unit_code).toBeNull(); // 20261138 dropped the old decode
    const moved = await requestUnitCodeDecode(ORG, ["n1"], "renumber");
    expect(moved.results[0]).toMatchObject({ unitCode: "30", outcome: "decoded" });
    expect(doc("n1").unit_code).toBe("30");

    renumber("n1", "PID-OLD-7");
    const lost = await requestUnitCodeDecode(ORG, ["n1"], "renumber");
    expect(lost.results[0]).toMatchObject({ documentId: "n1", unitCode: null, outcome: "not_decoded" });
    expect(lost.results[0].reason).toMatch(/expects 2 digits/);
    expect(doc("n1").unit_code).toBeNull();
    // recorded: one UNIT_CODE_DECODE row per call that wrote or left a reason
    const rows = h.admin.tables.audit_logs.filter((r) => r.action === "UNIT_CODE_DECODE");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ resource_type: "org", resource_id: ORG, org_id: ORG, user_id: "uid-1", details: { via: "upload", documents: [{ id: "n1", outcome: "decoded", unitCode: "20", reason: null }] } });
    expect(rows[2].details).toMatchObject({ via: "renumber", documents: [{ id: "n1", outcome: "not_decoded", unitCode: null }] });
    expect(String((rows[2].details as { documents: Array<{ reason: string }> }).documents[0].reason)).toMatch(/expects 2 digits/);
  });

  it("a stale code on a number that no longer decodes is CLEARED (never left pointing at the old unit)", async () => {
    create("n2", "PID-OLD-8", { unit_code: "20" }); // as if decoded before a renumber the trigger could not see
    const r = await requestUnitCodeDecode(ORG, ["n2"], "metadata_edit");
    expect(r.results[0]).toMatchObject({ outcome: "cleared", unitCode: null });
    expect(doc("n2").unit_code).toBeNull();
  });

  it("the helper never throws: no session, a refusal, a network failure and a server context each come back as a note (or nothing)", async () => {
    create("n3", "2002-D-3");
    h.session = null;
    expect((await requestUnitCodeDecode(ORG, ["n3"], "upload")).note).toMatch(/not decoded \(not signed in\) — the next unit-identity run/);
    h.session = "bad";
    expect((await requestUnitCodeDecode(ORG, ["n3"], "upload")).note).toMatch(/was not decoded \(Not authenticated\)/);
    h.session = "good";
    g.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect((await requestUnitCodeDecode(ORG, ["n3"], "upload")).note).toMatch(/not decoded \(network down\)/);
    delete g.window;
    await expect(requestUnitCodeDecode(ORG, ["n3"], "upload")).resolves.toEqual({ results: [], note: null });
    expect(doc("n3").unit_code).toBeNull();
  });
});

describe("POST /api/documents/unit-code — who may ask, what is read, what is recorded", () => {
  it("refuses an anonymous caller, a bad token and a non-member; requires ids; bounds the call", async () => {
    create("a1", "2002-D-1");
    expect((await call({ orgId: ORG, documentIds: ["a1"] }, null)).status).toBe(401);
    expect((await call({ orgId: ORG, documentIds: ["a1"] }, "nope")).status).toBe(401);
    expect((await call({ orgId: ORG, documentIds: ["a1"] }, "outsider")).status).toBe(403);
    expect((await call({ orgId: ORG, documentIds: [] })).status).toBe(400);
    const many = Array.from({ length: DECODE_MAX_DOCUMENTS + 1 }, (_, i) => `x${i}`);
    expect((await call({ orgId: ORG, documentIds: many })).status).toBe(400);
    expect(doc("a1").unit_code).toBeNull();
  });

  it("never trusts a number or a code in the body: it decodes the STORED number", async () => {
    create("a2", "3002-D-2");
    const r = await (await call({ orgId: ORG, documentIds: ["a2"], unitCode: "20", documentNumber: "2002-D-2" })).json();
    expect(r.results).toEqual([{ documentId: "a2", unitCode: "30", outcome: "decoded", reason: null }]);
    expect(doc("a2").unit_code).toBe("30");
  });

  it("a document the caller's session cannot read, or another org's, is answered as not found and never decoded or named", async () => {
    const r = await (await call({ orgId: ORG, documentIds: ["hidden1", "other-org"] })).json();
    expect(r.results.map((x: { documentId: string; outcome: string }) => [x.documentId, x.outcome]).sort()).toEqual([["hidden1", "not_found"], ["other-org", "not_found"]]);
    expect(doc("hidden1").unit_code).toBeNull();
    expect(doc("other-org").unit_code).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/2002-D-5|2002-D-6/);
    expect(h.admin.tables.audit_logs).toHaveLength(0);
  });

  it("an unknown unit and a missing number are left NULL with their reasons; a call that only confirms current codes records nothing", async () => {
    create("a3", "9902-D-1");
    create("a4", null);
    create("a5", "2002-D-9", { unit_code: "20" });
    const r = await (await call({ orgId: ORG, documentIds: ["a3", "a4", "a5"], via: "csv_import" })).json();
    const by = Object.fromEntries(r.results.map((x: { documentId: string }) => [x.documentId, x]));
    expect(by.a3).toMatchObject({ outcome: "not_decoded", unitCode: null, reason: "The number decodes to unit 99, which the Site Codebook does not hold." });
    expect(by.a4).toMatchObject({ outcome: "not_decoded", unitCode: null, reason: "The document has no number to decode." });
    expect(by.a5).toMatchObject({ outcome: "unchanged", unitCode: "20", reason: null });
    const row = h.admin.tables.audit_logs[0];
    expect(row.details).toMatchObject({ via: "csv_import" });
    expect((row.details as { documents: Array<{ id: string }> }).documents.map((d) => d.id).sort()).toEqual(["a3", "a4"]);
    h.admin.tables.audit_logs = [];
    await call({ orgId: ORG, documentIds: ["a5"] });
    expect(h.admin.tables.audit_logs).toHaveLength(0);
  });

  it("an empty codebook (no number format) has no opinion: nothing is written or cleared", async () => {
    h.admin.tables.codebook_config = [];
    create("a6", "2002-D-6", { unit_code: "20" });
    const r = await (await call({ orgId: ORG, documentIds: ["a6"] })).json();
    expect(r.results[0]).toMatchObject({ outcome: "no_opinion", unitCode: "20" });
    expect(r.results[0].reason).toMatch(/no drawing-number format/);
    expect(doc("a6").unit_code).toBe("20");
  });

  it("a number that changes between the read and the write is left as it is (the backfill's guarded write), and said", async () => {
    create("a7", "2002-D-7");
    h.admin.beforeWrite = (t) => { if (t === "documents") { doc("a7").document_number = "3002-D-7"; h.admin.beforeWrite = null; } };
    const r = await (await call({ orgId: ORG, documentIds: ["a7"] })).json();
    expect(r.results[0]).toMatchObject({ outcome: "changed", unitCode: null });
    expect(doc("a7").unit_code).toBeNull(); // never the old number's unit on the new number
  });

  it("before 20261138 it decodes nothing and says so", async () => {
    h.admin.missingColumns = { units: ["codebook_code"], documents: ["unit_code"] };
    create("a8", "2002-D-8");
    const r = await (await call({ orgId: ORG, documentIds: ["a8"] })).json();
    expect(r.results).toEqual([]);
    expect(r.notes[0]).toMatch(/20261138/);
  });

  it("the helper is the backfill's own: decodeDocumentUnitCodes uses the extracted planner and guarded writes", async () => {
    create("a9", "2002-D-9");
    await expect(decodeDocumentUnitCodes({ orgId: ORG, documentIds: ["a9", "a9", ""] })).resolves.toMatchObject({ results: [{ documentId: "a9", outcome: "decoded", unitCode: "20" }] });
    const helper = readFileSync(join(process.cwd(), "lib/unitCodeDecode.ts"), "utf8");
    expect(helper).toMatch(/planUnitIdentity\(\{ docs, assets: \[\], units: units\.rows, book, dryRun: false, seesRestricted: true \}\)/);
    expect(helper).toMatch(/for \(const chunk of documentChunks\(\[\[value, wIds\]\], numberOf\)\)/);
    const route = readFileSync(join(process.cwd(), "app/api/admin/unit-identity/route.ts"), "utf8");
    expect(route).toMatch(/from "@\/lib\/unitCodeDecode"/);
    expect(route).not.toMatch(/async function readAll|function documentChunks|async function applyWrites|async function readCodebookUnits/);
  });
});

describe("GAP-314 — every door this package owns asks for the decode after its write, best-effort", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("createDocumentWithFile, split, merge (a created target), renumber, the reversal of a renumber, the CSV import and the metadata editor's renumber", () => {
    const rev = src("lib/revisions.ts");
    const create = rev.slice(rev.indexOf("export async function createDocumentWithFile"), rev.indexOf("/** REV-18 (addendum 1): the up-front refusal"));
    expect(create.indexOf('requestUnitCodeDecode(input.orgId, [documentId], "upload")')).toBeGreaterThan(create.indexOf("recomputeRetention(documentId)"));
    expect(src("lib/documentLifecycle/split.ts")).toMatch(/const unitCode = await requestUnitCodeDecode\(orgId, newDocumentIds, "split"\);/);
    expect(src("lib/documentLifecycle/merge.ts")).toMatch(/target\.kind === "create_new"\s*\? \(await requestUnitCodeDecode\(orgId, \[targetDocumentId\], "merge"\)\)\.note/);
    const ren = src("lib/documentLifecycle/renumber.ts");
    expect(ren.indexOf('requestUnitCodeDecode(orgId, [doc.id], "renumber")')).toBeGreaterThan(ren.indexOf('type: "DOC_RENUMBERED"'));
    const rv = src("lib/documentLifecycle/reverse.ts");
    expect(rv.indexOf('requestUnitCodeDecode(input.orgId, [docId], "renumber_reversed")')).toBeGreaterThan(rv.indexOf('type: "DOC_RENUMBER_REVERSED"'));
    expect(src("components/documents/CsvImportModal.tsx")).toMatch(/const answer = await requestUnitCodeDecode\(orgId, ids, "csv_import"\);/);
    expect(src("components/documents/MetadataEditor.tsx")).toMatch(/void requestUnitCodeDecode\(orgId, \[document\.id\], "metadata_edit"\)/);
    // the wizards show a decode that did not run with the other follow-ups
    for (const w of ["components/documents/lifecycle/SplitWizard.tsx", "components/documents/lifecycle/MergeWizard.tsx"]) {
      expect(src(w)).toMatch(/\.\.\.\(result\?\.unitCodeNote \? \[result\.unitCodeNote\] : \[\]\)/);
    }
  });
  it("the browser never writes documents.unit_code itself (20261138 refuses a person's write; only the route's service role writes it)", () => {
    for (const f of ["lib/revisions.ts", "lib/documentLifecycle/common.ts", "lib/documentLifecycle/split.ts", "lib/documentLifecycle/merge.ts", "lib/documentLifecycle/renumber.ts", "lib/documentLifecycle/reverse.ts", "components/documents/CsvImportModal.tsx", "components/documents/MetadataEditor.tsx", "lib/unitCodeClient.ts"]) {
      expect(src(f), f).not.toMatch(/unit_code\s*:/);
    }
    expect(src("lib/unitCodeClient.ts")).not.toMatch(/from "@\/lib\/(supabaseAdmin|unitCodeDecode)"/);
  });
});
