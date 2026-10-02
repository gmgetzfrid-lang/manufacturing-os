// intelligence Round G (I-11) — the Bridge's routes.
//
//   * /api/equipment-bridge — BR-1: the caller's ACL per document (a writer-
//     tier member applying into a library they cannot read writes nothing;
//     the documents they cannot read are skipped and counted; additive roles
//     admit); BR-11: the sweep is paged with a cursor and a wall-clock budget
//     and a 500+ document library is swept whole; BR-9: a tag subset and
//     dismissals reach the server; the settings keep the library's review
//     mark and record who turned auto-apply on (BR-8).
//   * /api/equipment/sheets — GM-14: the sheets an equipment tag is on, per
//     caller — the relation read AS the caller, the extracted copies filtered
//     through the knowledge ACL; the entity index never reaches a client.
//   * /api/admin/unit-identity GET — GAP-314 acceptance 2: how many
//     documents carry no decode since the last run.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { newFakeDb, type FakeDb, type Row } from "./helpers/fakeSupabase";

const st = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  callerDb: null as unknown as FakeDb,
  readable: new Set<string>(),
  users: { good: "u-mgr" } as Record<string, string>,
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeFakeSupabase: make, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  st.db = fresh();
  const auth = {
    getUser: async (token: string) => st.users[token]
      ? { data: { user: { id: st.users[token], email: `${st.users[token]}@x` } }, error: null }
      : { data: { user: null }, error: { message: "bad token" } },
  };
  return { supabaseAdmin: new Proxy({}, { get: (_t, p: string) => (p === "auth" ? auth : (make(st.db) as Record<string, unknown>)[p]) }) };
});
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: async (orgId: string, uid: string) => {
    const m = (st.db.tables.org_members ?? []).find((r) => r.uid === uid && r.org_id === orgId && r.status === "active");
    if (!m) return null;
    return { uid, orgId, role: m.role, roles: m.roles ?? [m.role], isController: false, teamIds: [] };
  },
  readableControlledDocIds: async (_p: unknown, ids: string[]) => new Set(ids.filter((i) => st.readable.has(i))),
}));
vi.mock("@/lib/serverAuth", async () => {
  const { makeFakeSupabase: make, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  st.callerDb = fresh();
  return { callerScopedClient: () => make(st.callerDb) };
});
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/unitCodeDecode", () => ({ decodeDocumentUnitCodes: async () => ({ results: [], notApplied: false }) }));

import { GET, POST, SWEEP_PAGE, SWEEP_BUDGET_MS } from "@/app/api/equipment-bridge/route";
import { GET as sheetsGET } from "@/app/api/equipment/sheets/route";
import { GET as unitIdentityGET } from "@/app/api/admin/unit-identity/route";

const req = (body: Record<string, unknown>, token = "good") => new NextRequest("http://x/api/equipment-bridge", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
const getReq = (url: string, token = "good") => new NextRequest(url, { headers: { authorization: `Bearer ${token}` } });

const entry = (kind: string, code: string, label: string, tagPrefixes?: string[]): Row =>
  ({ id: `${kind}-${code}`, org_id: "o1", kind, code, label, meta: tagPrefixes ? { tagPrefixes } : {}, sort: 0 });

function baseDb(): void {
  Object.assign(st.db, newFakeDb());
  st.db.tables = {
    org_members: [
      { org_id: "o1", uid: "u-mgr", role: "Manager", roles: ["Manager"], status: "active" },
      { org_id: "o1", uid: "u-view", role: "Viewer", roles: ["Viewer"], status: "active" },
      // A document controller held additively under a Viewer headline.
      { org_id: "o1", uid: "u-dc", role: "Viewer", roles: ["Viewer", "DocCtrl"], status: "active" },
    ],
    codebook_entries: [entry("unit", "20", "Crude"), entry("equipment_type", "30", "Exchangers", ["E"]), entry("equipment_type", "50", "Pumps", ["P"])],
    codebook_config: [],
    libraries: [{ id: "lib1", org_id: "o1", equipment_bridge: { targetColumnKey: "equipment", reviewedAt: "2026-09-01T00:00:00Z", reviewedBy: "u-dc" }, custom_columns: [] }],
    documents: [],
    knowledge_documents: [],
    knowledge_page_entities: [],
    knowledge_chunks: [],
    assets: [],
    asset_types: [],
    document_equipment_suggestions: [],
    document_assets: [],
    audit_logs: [],
  };
  st.db.unique = { assets: [["org_id", "tag_normalized"]], document_assets: [["document_id", "asset_id"]] };
  st.readable = new Set();
  st.users = { good: "u-mgr", viewer: "u-view", dc: "u-dc" };
}

/** n documents in lib1, each with a ready copy carrying one tag. */
function library(n: number) {
  for (let i = 0; i < n; i++) {
    const id = `d${String(i).padStart(4, "0")}`;
    st.db.tables.documents.push({ id, org_id: "o1", library_id: "lib1", document_number: `N-${i}`, status: "Issued", metadata: {}, current_version_id: null });
    st.db.tables.knowledge_documents.push({ id: `k${id}`, org_id: "o1", source_document_id: id, status: "ready", source_version_id: null, source_rev: "A", vision_failed_pages: [] });
    st.db.tables.knowledge_page_entities.push({ id: `e${id}`, document_id: `k${id}`, page: 1, kind: "equipment", tag: `P-${i + 1}`, raw: "" });
  }
}

beforeEach(() => baseDb());
afterEach(() => vi.restoreAllMocks());

describe("BR-1 — /api/equipment-bridge evaluates the caller's ACL on every document", () => {
  it("a Viewer is refused; a DocCtrl held additively is admitted (ADD-1)", async () => {
    expect((await POST(req({ action: "apply", orgId: "o1", documentIds: ["d0000"] }, "viewer"))).status).toBe(403);
    expect((await POST(req({ action: "coverage", orgId: "o1" }, "dc"))).status).toBe(200);
  });
  it("reproduction → fix: a Manager applying to an ACL-restricted document writes nothing to it; the readable one is applied; the skip is counted", async () => {
    library(2);
    st.readable = new Set(["d0000"]);
    // Proposals exist for both (computed by the service at ingest).
    for (const d of ["d0000", "d0001"]) {
      st.db.tables.document_equipment_suggestions.push({
        org_id: "o1", document_id: d, applied: [], dismissed: [],
        suggested: [{ tag: d === "d0000" ? "P-1" : "P-2", code: null, pages: [1], assetId: null, assetStatus: "new", unitCode: null }],
      });
    }
    const res = await POST(req({ action: "apply", orgId: "o1", documentIds: ["d0000", "d0001"] }));
    const json = await res.json();
    expect(json.unreadable).toBe(1);
    expect(json.results.find((r: Row) => r.documentId === "d0001")).toEqual({ documentId: "d0001", skipped: "unreadable" });
    expect(st.db.tables.assets.map((a) => a.tag)).toEqual(["P-1"]);
    expect(st.db.tables.documents.find((d) => d.id === "d0001")!.metadata).toEqual({});
    expect(st.db.tables.document_assets.map((r) => r.document_id)).toEqual(["d0000"]);
  });
  it("GET lists only the documents the caller can read and says how many it left out", async () => {
    library(3);
    st.readable = new Set(["d0000", "d0002"]);
    for (const d of ["d0000", "d0001", "d0002"]) st.db.tables.document_equipment_suggestions.push({ org_id: "o1", document_id: d, suggested: [], applied: [] });
    const json = await (await GET(getReq("http://x/api/equipment-bridge?orgId=o1&libraryId=lib1"))).json();
    expect(json.suggestions.map((s: Row) => s.document_id).sort()).toEqual(["d0000", "d0002"]);
    expect(json.unreadable).toBe(1);
  });
  it("dismiss / vanished on a document the caller cannot read is refused (403)", async () => {
    library(1);
    const r = await POST(req({ action: "dismiss", orgId: "o1", documentId: "d0000", tags: ["P-1"] }));
    expect(r.status).toBe(403);
  });
});

describe("BR-11 — the sweep is paged with a cursor and a budget; a 500+ document library is swept whole", () => {
  it("520 documents: each call takes one page and returns the next cursor; every document is computed exactly once", async () => {
    library(520);
    st.readable = new Set(st.db.tables.documents.map((d) => String(d.id)));
    let cursor: string | null = null;
    let calls = 0;
    let computed = 0;
    for (;;) {
      const json = await (await POST(req({ action: "sweep", orgId: "o1", libraryId: "lib1", cursor }))).json();
      calls++;
      computed += json.counts.computed;
      if (json.done) { expect(json.nextCursor).toBeNull(); break; }
      cursor = json.nextCursor;
      expect(calls).toBeLessThan(10);
    }
    expect(calls).toBe(Math.ceil(520 / SWEEP_PAGE));
    expect(computed).toBe(520);
    expect(st.db.tables.document_equipment_suggestions).toHaveLength(520);
  });
  it("a call that reaches its wall-clock budget stops cleanly, says how far it got, and the next call resumes from there", async () => {
    library(10);
    st.readable = new Set(st.db.tables.documents.map((d) => String(d.id)));
    // The budget runs out after the third document.
    let seen = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => { seen++; return seen > 4 ? SWEEP_BUDGET_MS + 1 : 0; });
    const first = await (await POST(req({ action: "sweep", orgId: "o1", libraryId: "lib1" }))).json();
    expect(first.done).toBe(false);
    expect(first.counts.computed).toBe(3);
    expect(first.nextCursor).toBe("d0002");
    spy.mockImplementation(() => 0);
    const second = await (await POST(req({ action: "sweep", orgId: "o1", libraryId: "lib1", cursor: first.nextCursor }))).json();
    expect(second).toMatchObject({ done: true, nextCursor: null });
    expect(second.counts.computed).toBe(7);
    expect(st.db.tables.document_equipment_suggestions).toHaveLength(10);
  });
  it("documents the caller cannot read are counted, never computed", async () => {
    library(4);
    st.readable = new Set(["d0000", "d0001"]);
    const json = await (await POST(req({ action: "sweep", orgId: "o1", libraryId: "lib1" }))).json();
    expect(json.counts).toMatchObject({ computed: 2, unreadable: 2 });
    expect(st.db.tables.document_equipment_suggestions.map((s) => s.document_id).sort()).toEqual(["d0000", "d0001"]);
  });
});

describe("BR-9 — a tag subset and dismissals reach the server", () => {
  it("apply with tags applies only those; dismiss writes the dismissal", async () => {
    library(1);
    st.readable = new Set(["d0000"]);
    st.db.tables.knowledge_page_entities.push({ id: "e2", document_id: "kd0000", page: 1, kind: "equipment", tag: "E-5", raw: "" });
    await POST(req({ action: "sweep", orgId: "o1", libraryId: "lib1" }));
    const applied = await (await POST(req({ action: "apply", orgId: "o1", documentIds: ["d0000"], tags: ["E-5"] }))).json();
    expect(applied.results[0].appliedTags).toEqual(["E-5"]);
    const d = await (await POST(req({ action: "dismiss", orgId: "o1", documentId: "d0000", tags: ["P-1"] }))).json();
    expect(d).toMatchObject({ ok: true, dismissed: ["P-1"] });
    expect((st.db.tables.document_equipment_suggestions[0].dismissed as Row[]).map((x) => x.tag)).toEqual(["P-1"]);
  });
});

describe("settings — the library's review mark is kept; who turned auto-apply on is recorded (BR-8)", () => {
  it("turning auto-apply on records the caller; the first review stays", async () => {
    const json = await (await POST(req({ action: "settings", orgId: "o1", libraryId: "lib1", targetColumnKey: "equipment", autoApply: true }))).json();
    expect(json.bridge).toMatchObject({ autoApply: true, autoApplyBy: "u-mgr", reviewedAt: "2026-09-01T00:00:00Z", reviewedBy: "u-dc" });
    expect(st.db.tables.libraries[0].equipment_bridge).toMatchObject({ autoApplyBy: "u-mgr", reviewedBy: "u-dc" });
    const off = await (await POST(req({ action: "settings", orgId: "o1", libraryId: "lib1", autoApply: false }))).json();
    expect(off.bridge.autoApplyBy).toBeUndefined();
  });
  it("a library of another workspace is refused", async () => {
    st.db.tables.libraries.push({ id: "lib-x", org_id: "o2" });
    expect((await POST(req({ action: "settings", orgId: "o1", libraryId: "lib-x" }))).status).toBe(404);
  });
});

describe("GM-14 — /api/equipment/sheets serves an equipment tag's sheets per caller", () => {
  function sheets() {
    // The caller's own view: documents RLS hides d-priv; their relation read
    // returns what the database lets them see.
    st.callerDb.tables = {
      assets: [{ id: "a-e22", org_id: "o1", tag: "E-22", tag_normalized: "e22", archived: false }],
      document_assets: [
        { document_id: "d-open", asset_id: "a-e22", source: "drawing", sheet_label: "2002-D-10001 SHT 4", pages: [1], asserted_by: "machine", model: null, source_revision: "B", vanished_at: null, superseded_at: null },
        { document_id: "d-priv", asset_id: "a-e22", source: "manual", sheet_label: null, pages: null },
      ],
      documents: [{ id: "d-open", org_id: "o1", library_id: "lib1", document_number: "2002-D-10001", title: "P&ID", rev: "B", status: "Issued" }],
    };
    st.db.tables.knowledge_documents = [
      { id: "k-open2", org_id: "o1", name: "2002-D-10002.pdf", source_document_id: "d-open2", source_version_id: "v1", status: "ready" },
      { id: "k-priv", org_id: "o1", name: "secret.pdf", source_document_id: "d-priv", source_version_id: "v1", status: "ready" },
      { id: "k-stale", org_id: "o1", name: "old.pdf", source_document_id: "d-old", source_version_id: "v1", status: "ready" },
      { id: "k-up", org_id: "o1", name: "upload.pdf", source_document_id: null, status: "ready" },
    ];
    st.db.tables.documents = [
      { id: "d-open2", org_id: "o1", library_id: "lib1", document_number: "2002-D-10002", current_version_id: "v1", status: "Issued" },
      { id: "d-priv", org_id: "o1", library_id: "lib1", document_number: "SECRET", current_version_id: "v1", status: "Issued" },
      { id: "d-old", org_id: "o1", library_id: "lib1", document_number: "OLD", current_version_id: "v2", status: "Issued" },
    ];
    st.db.tables.knowledge_page_entities = [
      { id: "1", org_id: "o1", document_id: "k-open2", page: 2, kind: "equipment", tag: "E-22" },
      { id: "2", org_id: "o1", document_id: "k-open2", page: 2, kind: "self", tag: "2002-D-10002-SH2", raw: "DWG 2002-D-10002 SH 2 REV A" },
      { id: "3", org_id: "o1", document_id: "k-priv", page: 1, kind: "equipment", tag: "E-22" },
      { id: "4", org_id: "o1", document_id: "k-stale", page: 1, kind: "equipment", tag: "E-22" },
      { id: "5", org_id: "o1", document_id: "k-up", page: 7, kind: "equipment", tag: "E-22" },
    ];
    st.db.tables.knowledge_chunks = [{ id: "c", document_id: "k-open2", page: 2, source: "vision" }];
    st.readable = new Set(["d-open", "d-open2", "d-old"]);
  }
  it("relations come from the caller's own reads; extracted sheets are filtered by the ACL and the revision; an AI-read title block is marked", async () => {
    sheets();
    const json = await (await sheetsGET(getReq("http://x/api/equipment/sheets?orgId=o1&tag=e%2022"))).json();
    expect(json.asset).toMatchObject({ id: "a-e22" });
    expect(json.relations).toEqual([expect.objectContaining({
      documentId: "d-open", sheetLabel: "2002-D-10001 SHT 4", assertedBy: "machine", sourceRevision: "B", vanished: false,
    })]);
    expect(json.extracted.map((x: Row) => x.knowledgeDocumentId).sort()).toEqual(["k-open2", "k-up"]);
    expect(json.extracted.find((x: Row) => x.knowledgeDocumentId === "k-open2").sheets).toEqual(["2002-D-10002 SHT 2 (AI-read, unconfirmed)"]);
    expect(json.extracted.find((x: Row) => x.knowledgeDocumentId === "k-up")).toMatchObject({ documentId: null, pages: [7], sheets: ["page 7 (no title block read)"] });
  });
  it("refuses an anonymous caller and a non-member", async () => {
    sheets();
    expect((await sheetsGET(getReq("http://x/api/equipment/sheets?orgId=o1&tag=E-22", "nope"))).status).toBe(401);
    st.users.outsider = "u-out";
    expect((await sheetsGET(getReq("http://x/api/equipment/sheets?orgId=o1&tag=E-22", "outsider"))).status).toBe(403);
  });
  it("the entity index stays service-role only: no client reads knowledge_page_entities", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    const clientFiles = [...walk(join(process.cwd(), "components")), ...walk(join(process.cwd(), "app"))]
      .filter((p) => /\.tsx?$/.test(p) && !p.includes(`${join("app", "api")}`))
      .filter((p) => readFileSync(p, "utf8").includes('from("knowledge_page_entities")'));
    expect(clientFiles).toEqual([]);
  });
});

describe("GAP-314 acceptance 2 — how many documents carry no decode since the last run", () => {
  it("counts numbered documents without a decode created or changed since the last finished run (all of them before any run)", async () => {
    st.db.tables.org_members.push({ org_id: "o1", uid: "u-admin", role: "Admin", roles: ["Admin"], status: "active" });
    st.users.admin = "u-admin";
    st.db.tables.documents = [
      { id: "a", org_id: "o1", document_number: "2002-D-1", unit_code: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
      { id: "b", org_id: "o1", document_number: "2002-D-2", unit_code: null, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" },
      { id: "c", org_id: "o1", document_number: "2002-D-3", unit_code: "20", created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" },
      { id: "d", org_id: "o1", document_number: null, unit_code: null, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" },
    ];
    const never = await (await unitIdentityGET(getReq("http://x/api/admin/unit-identity?orgId=o1", "admin"))).json();
    expect(never).toEqual({ lastRunAt: null, undecodedSince: 2 });
    st.db.tables.audit_logs = [
      { org_id: "o1", action: "UNIT_IDENTITY_BACKFILL", created_at: "2026-09-10T00:00:00Z", details: { phase: "finished" } },
      { org_id: "o1", action: "UNIT_IDENTITY_BACKFILL", created_at: "2026-09-11T00:00:00Z", details: { phase: "started" } },
    ];
    const since = await (await unitIdentityGET(getReq("http://x/api/admin/unit-identity?orgId=o1", "admin"))).json();
    expect(since).toEqual({ lastRunAt: "2026-09-10T00:00:00Z", undecodedSince: 1 });
  });
  it("is refused to a member outside the scope writer tier", async () => {
    expect((await unitIdentityGET(getReq("http://x/api/admin/unit-identity?orgId=o1", "viewer"))).status).toBe(403);
  });
});
