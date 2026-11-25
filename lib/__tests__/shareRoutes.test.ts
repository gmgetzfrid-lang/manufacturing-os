import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import { createFakeDb } from "./fakeShareDb";
import { hashShareCode, SHARE_SQL_MESSAGE } from "@/lib/shareLinks";

const ORG = "215b762d-7be4-4cbd-bdb1-4b2703d81296";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const D1 = "11111111-1111-4111-8111-111111111111"; // the caller can open this
const D2 = "22222222-2222-4222-8222-222222222222"; // and this
const SECRET = "33333333-3333-4333-8333-333333333333"; // but not this one
const MINE = "aaaaaaaa-0000-4000-8000-000000000001";
const THEIRS = "aaaaaaaa-0000-4000-8000-000000000002";
const HIDDEN = "aaaaaaaa-0000-4000-8000-000000000003";
const FOREIGN = "44444444-4444-4444-8444-444444444444"; // another workspace's

const fake = createFakeDb();
const fetched: string[] = [];
let pdfBytes: Uint8Array = new Uint8Array();

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (t: string) => fake.client.from(t),
    rpc: (fn: string, a: Record<string, unknown>) => fake.client.rpc(fn, a),
    auth: {
      getUser: async (tok: string) => (tok === "good" ? { data: { user: { id: "u1", email: "grant@kern.test" } }, error: null }
        : tok === "other" ? { data: { user: { id: "u2", email: "sam@kern.test" } }, error: null }
          : { data: { user: null }, error: { message: "bad" } }),
    },
  },
}));
// The public routes make their own service-role client.
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fake.client }));
vi.mock("@/lib/knowledgeAccess", () => ({
  loadPrincipal: async (org: string, uid: string) => (org === ORG && (uid === "u1" || uid === "u2") ? { orgId: org, uid } : null),
  readableControlledDocIds: async (_p: unknown, ids: string[]) => new Set(ids.filter((i) => i !== SECRET)),
}));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: { send: async (cmd: { input: { Key: string } }) => { fetched.push(cmd.input.Key); return { Body: { transformToByteArray: async () => pdfBytes } }; } },
}));

const json = (body: unknown, token = "good") => ({
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
});
async function create(body: Record<string, unknown>, token = "good") {
  const { POST } = await import("@/app/api/share/create/route");
  const res = await POST(new NextRequest("http://app.test/api/share/create", json(body, token)));
  return { status: res.status, body: await res.json() };
}
async function resolve(token: string, code?: string) {
  const { GET } = await import("@/app/api/share/resolve/route");
  const res = await GET(new NextRequest(`http://app.test/api/share/resolve?token=${token}`, { headers: code ? { "x-share-code": code } : {} }));
  return { status: res.status, body: await res.json() };
}
async function file(qs: string, code?: string) {
  const { GET } = await import("@/app/api/share/file/route");
  return GET(new NextRequest(`http://app.test/api/share/file?${qs}`, { headers: code ? { "x-share-code": code } : {} }));
}
const sendable = { orgId: ORG, recipient: "John, ABC Contractors", expiresDays: 7, withCode: true, allowDownload: false };

beforeEach(async () => {
  for (const k of Object.keys(fake.tables)) delete fake.tables[k];
  fake.state.legacy = false;
  fetched.length = 0;
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  pdfBytes = await pdf.save();
  fake.tables.org_members = [{ org_id: ORG, uid: "u1", display_name: "Grant Getzfrid", email: "grant@kern.test", status: "active" }];
  fake.tables.orgs = [{ id: ORG, name: "Kern Refining" }];
  fake.tables.documents = [
    { id: D1, org_id: ORG, document_number: "2002-D 2001", title: "CRUDE UNIT P&ID", name: null, rev: "3", current_version_id: "v1" },
    { id: D2, org_id: ORG, document_number: "2002-D 2002", title: "VACUUM UNIT P&ID", name: null, rev: "1", current_version_id: "v2" },
    { id: SECRET, org_id: ORG, document_number: "HR-001", title: "Hidden", name: null, rev: "0", current_version_id: "v3" },
    { id: FOREIGN, org_id: OTHER_ORG, document_number: "X-1", title: "Theirs", name: null, rev: "0", current_version_id: "v4" },
  ];
  fake.tables.document_versions = [
    { id: "v1", org_id: ORG, record_id: D1, file_url: `orgs/${ORG}/libraries/l/2001.pdf`, file_type: "application/pdf" },
    { id: "v2", org_id: ORG, record_id: D2, file_url: `orgs/${ORG}/libraries/l/2002.pdf`, file_type: "application/pdf" },
    { id: "v3", org_id: ORG, record_id: SECRET, file_url: `orgs/${ORG}/libraries/l/hr.pdf`, file_type: "application/pdf" },
    { id: "v4", org_id: OTHER_ORG, record_id: FOREIGN, file_url: `orgs/${OTHER_ORG}/x.pdf`, file_type: "application/pdf" },
  ];
});

describe("making a link", () => {
  it("refuses anyone not signed in or not in the workspace", async () => {
    expect((await create({ ...sendable, items: [{ documentId: D1 }] }, "")).status).toBe(401);
    expect((await create({ ...sendable, items: [{ documentId: D1 }] }, "nope")).status).toBe(401);
    expect((await create({ ...sendable, orgId: OTHER_ORG, items: [{ documentId: D1 }] })).status).toBe(403);
  });

  it("refuses a document the sender can't open, and makes nothing", async () => {
    const r = await create({ ...sendable, items: [{ documentId: D1 }, { documentId: SECRET }] });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("HR-001");
    expect(fake.tables.document_shares ?? []).toHaveLength(0);
  });

  it("refuses a document from another workspace", async () => {
    const r = await create({ ...sendable, items: [{ documentId: FOREIGN }] });
    expect(r.status).toBe(404);
    expect(fake.tables.document_shares ?? []).toHaveLength(0);
  });

  it("refuses a marked-up copy from outside this workspace's shares folder", async () => {
    for (const markupPath of [`orgs/${OTHER_ORG}/shares/m.pdf`, `orgs/${ORG}/shares/../libraries/l/hr.pdf`, `orgs/${ORG}/libraries/l/hr.pdf`]) {
      const r = await create({ ...sendable, items: [{ documentId: D1, markupPath }] });
      expect(r.status).toBe(400);
    }
    expect(fake.tables.document_shares ?? []).toHaveLength(0);
  });

  it("needs a name, a known expiry and at least one document", async () => {
    expect((await create({ ...sendable, recipient: "  ", items: [{ documentId: D1 }] })).status).toBe(400);
    expect((await create({ ...sendable, expiresDays: 90, items: [{ documentId: D1 }] })).status).toBe(400);
    expect((await create({ ...sendable, items: [] })).status).toBe(400);
  });

  it("makes the link, returns the code once and keeps only its hash", async () => {
    const markupPath = `orgs/${ORG}/shares/abc.pdf`;
    const r = await create({ ...sendable, items: [{ documentId: D1 }, { documentId: D2, markupPath }] });
    expect(r.status).toBe(200);
    expect(r.body.code).toMatch(/^\d{6}$/);
    expect(r.body.token).toHaveLength(32);
    expect(r.body.url).toBe(`http://app.test/share/${r.body.token}`);
    const row = fake.tables.document_shares[0];
    expect(row.code_hash).toMatch(/^scrypt1\$/);
    expect(JSON.stringify(row)).not.toContain(r.body.code);
    expect(row).toMatchObject({
      org_id: ORG, document_id: D1, document_ids: [D1, D2], recipient: "John, ABC Contractors",
      allow_download: false, created_by: "u1", created_by_name: "Grant Getzfrid", code_failures: 0,
      items: [{ documentId: D1, markupPath: null }, { documentId: D2, markupPath }],
    });
    const days = (new Date(String(row.expires_at)).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(fake.tables.audit_logs?.[0]).toMatchObject({ action: "SHARE_LINK_CREATED", resource_id: row.id, org_id: ORG, user_id: "u1" });
    expect(JSON.stringify(fake.tables.audit_logs)).not.toContain(r.body.code);
  });

  it("says which SQL to run when the columns aren't there yet", async () => {
    fake.state.legacy = true;
    const r = await create({ ...sendable, items: [{ documentId: D1 }] });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe(SHARE_SQL_MESSAGE);
  });
});

describe("opening a link from outside", () => {
  async function makeLink(over: Record<string, unknown> = {}) {
    const token = "Tok_" + "a".repeat(28);
    fake.tables.document_shares = [{
      id: "s1", token, org_id: ORG, document_id: D1, document_ids: [D1, D2],
      items: [{ documentId: D1, markupPath: null }, { documentId: D2, markupPath: `orgs/${ORG}/shares/m.pdf` }],
      recipient: "John, ABC Contractors", created_by: "u1", created_by_name: "Grant Getzfrid",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: null,
      allow_download: false, code_hash: await hashShareCode("123456", token), code_failures: 0, access_count: 0,
      ...over,
    }];
    return token;
  }

  it("keeps a link made before sets working: one document, no code, download allowed", async () => {
    fake.state.legacy = true;
    const token = "Old_" + "b".repeat(28);
    fake.tables.document_shares = [{ id: "old", token, org_id: ORG, document_id: D1, created_by: "u1", created_by_name: "grant", expires_at: null, revoked_at: null, note: "for John", access_count: 2 }];
    const r = await resolve(token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ allowDownload: true, recipient: "for John", orgName: "Kern Refining" });
    expect(r.body.items).toEqual([{ documentId: D1, documentNumber: "2002-D 2001", title: "CRUDE UNIT P&ID", rev: "3", markedUp: false, viewable: true }]);
    const res = await file(`token=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    // No source column yet: the row is kept, and the audit log says it was a download.
    expect(fake.tables.download_audits).toHaveLength(1);
    expect(fake.tables.audit_logs?.[0]).toMatchObject({ action: "SHARE_LINK_DOWNLOADED" });
  });

  it("asks for the code before showing anything, and never says more than wrong", async () => {
    const token = await makeLink();
    expect(await resolve(token)).toEqual({ status: 401, body: { error: "code" } });
    expect(await resolve(token, "000000")).toEqual({ status: 401, body: { error: "badcode" } });
    expect(fake.tables.document_shares[0].code_failures).toBe(1);
    expect((await file(`token=${token}&doc=${D1}&view=1`, "111111")).status).toBe(401);
    expect(fake.tables.document_shares[0].code_failures).toBe(2);
    const ok = await resolve(token, "123456");
    expect(ok.status).toBe(200);
    expect(ok.body.items.map((i: { documentId: string; markedUp: boolean }) => [i.documentId, i.markedUp])).toEqual([[D1, false], [D2, true]]);
    expect(ok.body).toMatchObject({ senderName: "Grant Getzfrid", recipient: "John, ABC Contractors", allowDownload: false });
    expect(fake.tables.document_shares[0].access_count).toBe(1);
  });

  it("locks after ten wrong codes", async () => {
    const token = await makeLink({ code_failures: 9 });
    expect((await resolve(token, "000000")).body).toEqual({ error: "locked" });
    expect((await resolve(token, "123456")).body).toEqual({ error: "locked" });
  });

  it("says turned off and expired", async () => {
    let token = await makeLink({ revoked_at: new Date().toISOString() });
    expect(await resolve(token, "123456")).toEqual({ status: 410, body: { error: "revoked" } });
    token = await makeLink({ expires_at: "2020-01-01T00:00:00Z" });
    expect(await resolve(token, "123456")).toEqual({ status: 410, body: { error: "expired" } });
    expect(await resolve("short")).toEqual({ status: 400, body: { error: "invalid" } });
    expect((await resolve("Nope_" + "c".repeat(28))).status).toBe(404);
  });

  it("shows a view-only link in the page but won't hand over the file", async () => {
    const token = await makeLink();
    const view = await file(`token=${token}&doc=${D1}&view=1`, "123456");
    expect(view.status).toBe(200);
    expect(view.headers.get("content-type")).toBe("application/pdf");
    expect(view.headers.get("content-disposition")).toMatch(/^inline/);
    expect(fetched).toEqual([`orgs/${ORG}/libraries/l/2001.pdf`]);
    // Stamped before it left.
    const out = await PDFDocument.load(new Uint8Array(await view.arrayBuffer()));
    expect(out.getPageCount()).toBe(1);
    expect(fake.tables.download_audits[0]).toMatchObject({ document_id: D1, version_id: "v1", user_id: "u1", source: "share_view" });

    const dl = await file(`token=${token}&doc=${D1}`, "123456");
    expect(dl.status).toBe(403);
    expect(await dl.json()).toEqual({ error: "nodownload" });
    expect(fake.tables.download_audits).toHaveLength(1);
  });

  it("serves the marked-up copy instead of the issued file, and downloads when allowed", async () => {
    const token = await makeLink({ allow_download: true });
    const res = await file(`token=${token}&doc=${D2}`, "123456");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="2002-D_2002_Rev1_markup\.pdf"/);
    expect(fetched).toEqual([`orgs/${ORG}/shares/m.pdf`]);
    expect(fake.tables.download_audits[0]).toMatchObject({ document_id: D2, source: "share_download_markup" });
  });

  it("won't serve a document that isn't on the link", async () => {
    const token = await makeLink();
    expect((await file(`token=${token}&doc=${SECRET}&view=1`, "123456")).status).toBe(404);
    expect(fetched).toHaveLength(0);
  });

  it("won't send a file it couldn't stamp", async () => {
    const token = await makeLink();
    pdfBytes = new TextEncoder().encode("not a pdf");
    const res = await file(`token=${token}&doc=${D1}&view=1`, "123456");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "unstampable" });
  });
});

describe("links already sent, and turning one off", () => {
  async function seed() {
    fake.tables.document_shares = [
      { id: MINE, token: "Mine_" + "d".repeat(27), org_id: ORG, document_id: D1, document_ids: [D1], items: [{ documentId: D1, markupPath: null }], recipient: "John", created_by: "u1", created_by_name: "Grant", created_at: "2026-11-20T10:00:00Z", expires_at: "2099-01-01T00:00:00Z", revoked_at: null, allow_download: false, code_hash: await hashShareCode("123456", "x"), code_failures: 0, access_count: 3, access_last_at: "2026-11-21T09:00:00Z" },
      { id: THEIRS, token: "Their_" + "e".repeat(26), org_id: ORG, document_id: D2, document_ids: [D2, D1], items: [{ documentId: D2, markupPath: null }, { documentId: D1, markupPath: null }], recipient: "Sue", created_by: "u2", created_by_name: "Sam", created_at: "2026-11-21T10:00:00Z", expires_at: "2099-01-01T00:00:00Z", revoked_at: null, allow_download: true, code_hash: null, code_failures: 0, access_count: 0 },
      { id: HIDDEN, token: "Hide_" + "f".repeat(27), org_id: ORG, document_id: SECRET, document_ids: [SECRET], items: null, recipient: "Ann", created_by: "u2", created_at: "2026-11-22T10:00:00Z", expires_at: null, revoked_at: null, allow_download: true, code_hash: null, code_failures: 0 },
    ];
  }
  async function list(docIds: string[], token = "good") {
    const { GET } = await import("@/app/api/share/list/route");
    const res = await GET(new NextRequest(`http://app.test/api/share/list?orgId=${ORG}&docIds=${docIds.join(",")}`, { headers: { authorization: `Bearer ${token}` } }));
    return { status: res.status, body: await res.json() };
  }

  it("lists the links covering these documents, the link itself only for its maker, never the hash", async () => {
    await seed();
    const r = await list([D1, SECRET]);
    expect(r.status).toBe(200);
    expect(r.body.links.map((l: { id: string }) => l.id)).toEqual([THEIRS, MINE]);
    const mine = r.body.links.find((l: { id: string }) => l.id === MINE);
    expect(mine).toMatchObject({ url: `http://app.test/share/${"Mine_" + "d".repeat(27)}`, withCode: true, allowDownload: false, accessCount: 3, recipient: "John" });
    expect(r.body.links.find((l: { id: string }) => l.id === THEIRS).url).toBeNull();
    expect(JSON.stringify(r.body)).not.toMatch(/scrypt1|code_hash|Their_/);
  });

  it("turns a link off and records who did it", async () => {
    await seed();
    const { POST } = await import("@/app/api/share/revoke/route");
    const res = await POST(new NextRequest("http://app.test/api/share/revoke", json({ orgId: ORG, id: THEIRS })));
    expect(res.status).toBe(200);
    expect(fake.tables.document_shares.find((s) => s.id === THEIRS)).toMatchObject({ revoked_by: "u1" });
    expect(fake.tables.audit_logs?.[0]).toMatchObject({ action: "SHARE_LINK_TURNED_OFF", resource_id: THEIRS });
    const notMember = await POST(new NextRequest("http://app.test/api/share/revoke", json({ orgId: OTHER_ORG, id: THEIRS })));
    expect(notMember.status).toBe(403);
  });
});
