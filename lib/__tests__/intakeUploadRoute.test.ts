// projects Round G — J1 INTAKE-DOOR: the external door as a boundary.
//
//   INTK-8 / SEC-8 / SEC-6   the token is checked before the body; an
//                            oversize Content-Length is refused unread; a
//                            per-token window answers 429 (and fails OPEN);
//                            a spent link budget answers 429.
//   INTK-11 / SEC-6 / SEC-1  the bytes decide the type; the stored
//                            ContentType is the sniffed one.
//   INTK-1 / SEC-3 / SEC-12  authorship is documents.authored_by_link_id; an
//                            assigned document, a never-approved one, and one
//                            whose last submission was rejected all go to
//                            review.
//   INTK-9 / SEC-11          every document read is the link's org's.
//   INTK-2 / SAF-5 / SEC-4   the trusted promote is publish_revision acting
//                            as the link's creator, then the post-publish
//                            pipeline under the service role; OWN-4's
//                            demotions (hold, checkout, authority) and the
//                            contract's refusals DEMOTE, never refuse.
//   INTK-4 / SAF-10          a displaced submission is resolved 'superseded'.
//   SEC-13 / SEC-14          a require-review policy and the MOC gate demote.
//   INTK-5                   a new document carries its uniqueness key; a
//                            number already in use is refused before storage.
//   REL-8 / INTK-13          a retry returns the original; errors carry a
//                            reference and no database text; the redline
//                            branch answers the same for "not yours" and
//                            "not there"; the intake folder never forks.
//   PM-2                     a link whose project is gone opens nothing.
//   INTK-10                  notices go through emit(), one per window.
//   INTK-2 dw3               every writer of current_version_id runs the
//                            post-publish pipeline or is allow-listed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  writes: [] as Array<{ table: string; method: string; args: unknown[]; filters: Array<[string, string, unknown]> }>,
  errors: {} as Record<string, Array<{ message: string; code?: string } | null>>,
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  r2Puts: [] as Array<Record<string, unknown>>,
  emits: [] as Array<Record<string, unknown>>,
  pipeline: [] as Array<{ input: Record<string, unknown>; boundToServiceRole: boolean }>,
  bound: false,
  seq: 0,
  user: null as null | { id: string; email: string },
}));

function parseOr(expr: string): (r: Row) => boolean {
  const parts = expr.split(/,(?![^(]*\))(?![^{]*\})/);
  const preds = parts.map((p) => {
    let m: RegExpExecArray | null;
    if ((m = /^(\w+)\.in\.\(([^)]*)\)$/.exec(p))) { const list = m[2].split(",").map((x) => x.replace(/"/g, "")); const col = m[1]; return (r: Row) => list.includes(String(r[col])); }
    if ((m = /^(\w+)\.ov\.\{([^}]*)\}$/.exec(p))) { const list = m[2].split(",").map((x) => x.replace(/"/g, "")); const col = m[1]; return (r: Row) => Array.isArray(r[col]) && (r[col] as string[]).some((x) => list.includes(x)); }
    if ((m = /^(\w+)\.is\.null$/.exec(p))) { const col = m[1]; return (r: Row) => r[col] == null; }
    if ((m = /^(\w+)\.neq\.(.+)$/.exec(p))) { const col = m[1]; const v = m[2]; return (r: Row) => r[col] != null && String(r[col]) !== v; }
    return () => false;
  });
  return (r) => preds.some((p) => p(r));
}

function chain(table: string) {
  const filters: Filter[] = [];
  let pending: { method: string; args: unknown[] } | null = null;
  let head = false;
  let limitN: number | null = null;
  const matches = (r: Row) => filters.every(([op, col, val]) => {
    const v = col.includes("->") ? undefined : r[col];
    if (op === "eq") return col.includes("->")
      ? String((((r.metadata as Row | undefined)?.intake_collision as Row | undefined)?.intakeLinkId) ?? "") === String(val)
      : v === val;
    if (op === "neq") return v !== val;
    if (op === "in") return (val as unknown[]).includes(v);
    if (op === "is") return val === null ? v == null : v === val;
    if (op === "not-is") return !(val === null ? v == null : v === val);
    if (op === "not-in") return !(val as string[]).includes(String(v));
    if (op === "gte") return v == null || String(v) >= String(val);
    if (op === "or") return (val as (r: Row) => boolean)(r);
    return true;
  });
  const rows = () => (db.tables[table] ?? []).filter(matches);
  const errFor = (method: string) => db.errors[`${table}.${method}`]?.shift() ?? null;
  const finish = (): { data: unknown; error: unknown; count?: number | null } => {
    if (pending) {
      db.writes.push({ table, method: pending.method, args: pending.args, filters: [...filters] });
      const err = errFor(pending.method);
      if (err) return { data: null, error: err };
      if (pending.method === "update") {
        const matched = rows();
        for (const r of matched) Object.assign(r, pending.args[0] as Row);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      if (pending.method === "delete") {
        const keep = (db.tables[table] ?? []).filter((r) => !matches(r));
        const gone = (db.tables[table] ?? []).length - keep.length;
        db.tables[table] = keep;
        return { data: Array.from({ length: gone }, () => ({})), error: null };
      }
      const payload = pending.args[0];
      const list = Array.isArray(payload) ? payload : [payload];
      const inserted = list.map((p) => ({ id: `${table}-new-${++db.seq}`, created_at: new Date().toISOString(), ...(p as Row) }));
      (db.tables[table] ??= []).push(...inserted);
      return { data: inserted, error: null };
    }
    const err = errFor("select");
    if (err) return { data: null, error: err };
    const all = rows();
    if (head) return { data: null, error: null, count: all.length };
    return { data: limitN != null ? all.slice(0, limitN) : all, error: null };
  };
  const one = (r: { data: unknown; error: unknown }) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error });
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(finish());
      return (...args: unknown[]) => {
        switch (prop) {
          case "select": if ((args[1] as { head?: boolean } | undefined)?.head) head = true; break;
          case "eq": filters.push(["eq", String(args[0]), args[1]]); break;
          case "neq": filters.push(["neq", String(args[0]), args[1]]); break;
          case "in": filters.push(["in", String(args[0]), args[1]]); break;
          case "is": filters.push(["is", String(args[0]), args[1]]); break;
          case "gte": filters.push(["gte", String(args[0]), args[1]]); break;
          case "or": filters.push(["or", "", parseOr(String(args[0]))]); break;
          case "not": {
            const [col, op, val] = args as [string, string, unknown];
            if (op === "is") filters.push(["not-is", col, val]);
            else if (op === "in") filters.push(["not-in", col, String(val).replace(/^\(|\)$/g, "").split(",")]);
            break;
          }
          case "limit": limitN = Number(args[0]); break;
          case "update": case "insert": case "upsert": case "delete": pending = { method: prop, args }; break;
          case "maybeSingle": case "single": return Promise.resolve(one(finish()));
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (t: string) => chain(t),
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      const h = db.rpc[fn];
      return h ? h(args) : { data: null, error: null };
    }),
    auth: {
      getUser: vi.fn(async () => db.user ? { data: { user: db.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
  },
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) },
  __setServerSupabaseClient: vi.fn(() => { db.bound = true; }),
  __resetServerSupabaseClient: vi.fn(() => { db.bound = false; }),
}));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async (cmd: { input: Row }) => { db.r2Puts.push(cmd.input); }) }, R2_BUCKET: "bucket" }));
vi.mock("@aws-sdk/client-s3", () => ({ PutObjectCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (e: Row) => { db.emits.push({ ...e, boundToServiceRole: db.bound }); }) }));
vi.mock("@/lib/postPublish", () => ({
  runPostPublishSideEffects: vi.fn(async (input: Row) => { db.pipeline.push({ input, boundToServiceRole: db.bound }); }),
}));
vi.mock("@/lib/intents", () => ({ listLiveIntents: vi.fn(async () => [{ userId: "intent-holder" }]) }));

import { POST } from "@/app/api/intake/upload/route";

const TOKEN = "t".repeat(40);
const ORG = "o1";
const LINK = "lnk1";
const D1 = "00000000-0000-4000-8000-0000000000d1";
const enc = (s: string) => new TextEncoder().encode(s);
const PDF = enc("%PDF-1.7\n%sheet\n");
const DWG = enc("AC1032\u0000\u0000drawing");

function link(over: Row = {}): Row {
  return {
    id: LINK, org_id: ORG, project_id: "p1", company_name: "Vendor Co", contact_email: "v@vendor.test",
    allow_auto_supersede: true, expires_at: null, revoked_at: null, assigned_doc_ids: [], created_by: "creator1",
    token: TOKEN, purpose: "documents", rfq_group: null,
    submission_count: 0, max_submissions: 500, bytes_received: 0, max_total_bytes: 5 * 1024 ** 3, ...over,
  };
}
function seed(opts: { link?: Row; doc?: Row | null; versions?: Row[] } = {}) {
  db.tables.project_intake_links = [link(opts.link)];
  db.tables.projects = [{ id: "p1", org_id: ORG, status: "active", name: "Unit 4", owner_user_id: "owner1", intake_library_id: "lib1", intake_collection_id: "col1" }];
  db.tables.libraries = [{ id: "lib1", org_id: ORG, uniqueness_keys: null }];
  db.tables.org_members = [
    { org_id: ORG, uid: "creator1", status: "active", role: "DocCtrl", roles: ["DocCtrl"], email: "c@x" },
    { org_id: ORG, uid: "ctl2", status: "active", role: "Admin", roles: ["Admin"], email: "a@x" },
  ];
  db.tables.documents = opts.doc === null ? [] : [{
    id: D1, org_id: ORG, authored_by_link_id: LINK, document_number: "V-100", title: "Skid", name: "Skid",
    rev: "B", status: "Issued", current_version_id: "v-cur", pending_version_id: null, library_id: "lib1",
    collection_id: "col1", review_control: null, checked_out_by: null, legal_hold: false, ...(opts.doc ?? {}),
  }];
  db.tables.document_versions = opts.versions ?? [
    { id: "v-cur", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", created_at: "2026-09-01T00:00:00Z" },
  ];
}
function upload(fields: Record<string, string>, file: { bytes: Uint8Array; name: string; type?: string } = { bytes: PDF, name: "sheet.pdf", type: "application/pdf" }, headers: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("file", new File([file.bytes as BlobPart], file.name, { type: file.type ?? "" }));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return POST(new NextRequest("http://x/api/intake/upload", { method: "POST", body: fd, headers: { "x-intake-token": TOKEN, ...headers } }));
}
const published = () => db.rpcCalls.find((c) => c.fn === "publish_revision");
const docWrites = () => db.writes.filter((w) => w.table === "documents" || w.table === "document_versions" || w.table === "cost_documents");

beforeEach(() => {
  db.tables = {}; db.writes = []; db.errors = {}; db.rpcCalls = []; db.r2Puts = []; db.emits = []; db.pipeline = [];
  db.bound = false; db.seq = 0; db.user = null;
  db.rpc = {
    review_control_mode_for: () => ({ data: "none", error: null }),
    user_can_publish_on_library: () => ({ data: false, error: null }),
    publish_revision: (a) => {
      const v = { id: "v-pub", org_id: ORG, record_id: a.p_doc, review_state: null, released_at: new Date().toISOString(), intake_link_id: null };
      (db.tables.document_versions ??= []).push(v);
      const d = (db.tables.documents ?? []).find((x) => x.id === a.p_doc);
      if (d) Object.assign(d, { current_version_id: "v-pub", rev: (a.p_version as Row).revision_label, status: "Issued" });
      return { data: { status: "published", version: { id: "v-pub" } }, error: null };
    },
  };
});

// ── The credential before the body (INTK-8 / SEC-8 / SEC-6) ─────────────────
describe("the door checks the credential before it reads a byte", () => {
  it("no token header: 400 about the link, with a reference — the body is never parsed and nothing is looked up", async () => {
    seed();
    const res = await POST(new NextRequest("http://x/api/intake/upload", { method: "POST", body: "not multipart at all" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/upload link is not valid/);
    expect(body.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(db.writes).toEqual([]);
  });
  it("a token in the multipart body is NOT a credential", async () => {
    seed();
    const fd = new FormData();
    fd.set("token", TOKEN);
    fd.set("file", new File([PDF as BlobPart], "a.pdf", { type: "application/pdf" }));
    const res = await POST(new NextRequest("http://x/api/intake/upload", { method: "POST", body: fd }));
    expect(res.status).toBe(400);
    expect(db.r2Puts).toEqual([]);
  });
  it("an oversize Content-Length is refused 413 without reading the body", async () => {
    seed();
    const res = await POST(new NextRequest("http://x/api/intake/upload", {
      method: "POST", body: "not multipart", headers: { "x-intake-token": TOKEN, "content-length": String(200 * 1024 * 1024) },
    }));
    expect(res.status).toBe(413);
  });
  it("429 once the per-token hourly window is full — nothing stored; the portal can render the message", async () => {
    seed();
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    db.tables.intake_attempts = Array.from({ length: 30 }, () => ({ token_hash: sha256Hex(TOKEN), ip: "unknown", outcome: "attempt", created_at: new Date().toISOString() }));
    const res = await upload({ title: "Skid GA" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect((await res.json()).error).toMatch(/Too many uploads on this link in the last hour \(limit 30\)/);
    expect(db.r2Puts).toEqual([]);
    expect(docWrites()).toEqual([]);
  });
  it("the per-IP window counts every token from one address", async () => {
    seed();
    db.tables.intake_attempts = Array.from({ length: 60 }, (_, i) => ({ token_hash: `h${i}`, ip: "203.0.113.9", outcome: "attempt", created_at: new Date().toISOString() }));
    const res = await upload({ title: "Skid GA" }, undefined, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/from your network/);
  });
  it("the limiter FAILS OPEN — an unreadable attempt log never locks the contractor out", async () => {
    seed({ doc: null });
    db.errors["intake_attempts.select"] = [{ message: "relation does not exist" }, { message: "relation does not exist" }];
    const res = await upload({ title: "Skid GA" });
    expect(res.status).toBe(200);
  });
  it("a link that has spent its submission budget answers 429 before the body", async () => {
    seed({ link: { submission_count: 500 } });
    const res = await upload({ title: "Skid GA" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/limit of 500 submissions/);
    expect(db.r2Puts).toEqual([]);
  });
  it("a link whose project no longer exists opens nothing — on the quote branch too, before any byte is stored (PM-2)", async () => {
    seed({ link: { purpose: "quote" } });
    db.tables.projects = [];
    const res = await upload({});
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe("link_gone");
    expect(body.error).toMatch(/no longer valid/);
    expect(db.r2Puts).toEqual([]);
  });
  it("a closed project's link accepts nothing", async () => {
    seed();
    db.tables.projects[0].status = "completed";
    const res = await upload({ title: "Skid GA" });
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("project_closed");
  });
});

// ── Content (INTK-11 / SEC-6 / SEC-1) ───────────────────────────────────────
describe("the bytes decide the type", () => {
  it("an HTML page named .pdf and declared application/pdf is refused before storage", async () => {
    seed({ doc: null });
    const res = await upload({ title: "x" }, { bytes: enc("<!doctype html><script>alert(1)</script>"), name: "plan.pdf", type: "application/pdf" });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/PDF, DWG, DXF or ZIP/);
    expect(db.r2Puts).toEqual([]);
  });
  it("a renamed .exe is refused with the accepted list named", async () => {
    seed({ doc: null });
    const res = await upload({ title: "x" }, { bytes: enc("MZ\u0090\u0000\u0003"), name: "drawing.pdf", type: "application/octet-stream" });
    expect(res.status).toBe(415);
  });
  it("the stored ContentType is the SNIFFED type, never the declared one", async () => {
    seed({ doc: null });
    const res = await upload({ title: "Skid GA", number: "V-200" }, { bytes: PDF, name: "ga.pdf", type: "application/octet-stream" });
    expect(res.status).toBe(200);
    expect(db.r2Puts[0].ContentType).toBe("application/pdf");
    const ver = db.writes.find((w) => w.table === "document_versions" && w.method === "insert");
    expect(ver?.args[0]).toMatchObject({ file_type: "application/pdf" });
  });
  it("a DWG is accepted for drawings and stored as image/vnd.dwg", async () => {
    seed({ doc: null });
    const res = await upload({ title: "Skid GA" }, { bytes: DWG, name: "ga.dwg", type: "" });
    expect(res.status).toBe(200);
    expect(db.r2Puts[0].ContentType).toBe("image/vnd.dwg");
  });
  it("a quote link takes PDF only", async () => {
    seed({ link: { purpose: "quote" } });
    const res = await upload({}, { bytes: DWG, name: "quote.dwg" });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/upload a PDF file/);
  });
  it("a revision label that is free text is refused; a 201-character title is refused", async () => {
    seed();
    expect((await upload({ docId: D1, revLabel: "C <script>" })).status).toBe(400);
    seed({ doc: null });
    expect((await upload({ title: "x".repeat(201) })).status).toBe(400);
  });
});

// ── Authorship and scope (INTK-1 / SEC-3 / SEC-12 / INTK-9 / SEC-11) ─────────
describe("authorship is a fact fixed at creation", () => {
  it("an ASSIGNED org document goes to review on every submission — even after a link version was approved (SEC-3 dw1)", async () => {
    seed({
      link: { assigned_doc_ids: [D1] },
      doc: { authored_by_link_id: null },
      versions: [
        { id: "v-org", org_id: ORG, record_id: D1, intake_link_id: null, review_state: null, created_at: "2026-01-01T00:00:00Z" },
        { id: "v-cur", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", created_at: "2026-09-01T00:00:00Z" },
      ],
    });
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("in_review");
    expect(published()).toBeUndefined();
    expect(db.writes.find((w) => w.table === "document_versions" && w.method === "insert")?.args[0]).toMatchObject({ review_state: "in_review" });
  });
  it("a document the link authored AND was assigned is treated as assigned — review", async () => {
    seed({ link: { assigned_doc_ids: [D1] } });
    await upload({ docId: D1, revLabel: "C" });
    expect(published()).toBeUndefined();
  });
  it("a link-authored document with no approved revision goes to review, and says why (SEC-12)", async () => {
    seed({ doc: { current_version_id: null, status: "Draft" } });
    const res = await upload({ docId: D1, revLabel: "B" });
    const body = await res.json();
    expect(body.status).toBe("in_review");
    expect(body.note).toMatch(/never had an approved revision/);
    expect(published()).toBeUndefined();
  });
  it("after a rejection, the next submission is reviewed — a rejected file is never re-published by resubmitting it", async () => {
    seed({ versions: [
      { id: "v-cur", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", created_at: "2026-09-01T00:00:00Z" },
      { id: "v-rej", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "rejected", created_at: "2026-09-20T00:00:00Z" },
    ] });
    db.tables.document_versions.reverse(); // newest first, as the ordered read returns them
    const body = await (await upload({ docId: D1, revLabel: "C" })).json();
    expect(body.status).toBe("in_review");
    expect(body.note).toMatch(/was not accepted/);
    expect(published()).toBeUndefined();
  });
  it("a document the link did not author and was not assigned is refused — whether or not it exists", async () => {
    seed({ doc: { authored_by_link_id: "someone-else" } });
    const a = await upload({ docId: D1, revLabel: "C" });
    const b = await upload({ docId: "00000000-0000-4000-8000-00000000beef", revLabel: "C" });
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect((await a.json()).error).toBe((await b.json()).error);
  });
  it("an assigned id that belongs to ANOTHER org resolves to nothing — no read of it, no write to it (INTK-9)", async () => {
    seed({ link: { assigned_doc_ids: [D1] }, doc: { org_id: "other-org", authored_by_link_id: null } });
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(404);
    const read = db.writes.length; // no writes at all
    expect(read).toBe(db.writes.filter((w) => w.table === "intake_attempts").length);
  });
});

// ── The trusted promote (INTK-2 / SAF-5 / SEC-4) ────────────────────────────
describe("the trusted promote is the publish contract plus the pipeline", () => {
  it("publishes through publish_revision acting as the link's creator, stamps provenance, and runs the pipeline bound to the service role", async () => {
    seed();
    const res = await upload({ docId: D1, revLabel: "C", changeNote: "tie-in moved" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("published");
    const call = published()!;
    expect(call.args).toMatchObject({ p_doc: D1, p_expected_base: "v-cur", p_op_class: "content", p_actor: "creator1", p_actor_name: "Vendor Co (intake)" });
    expect(call.args.p_version).toMatchObject({ revision_label: "C", file_type: "application/pdf", provenance: "external", created_by_name: "Vendor Co", change_log: "tie-in moved" });
    expect((call.args.p_version as Row).file_hash).toMatch(/^[0-9a-f]{64}$/);
    // no raw promote
    expect(db.writes.find((w) => w.table === "documents" && w.method === "update" && (w.args[0] as Row).current_version_id)).toBeUndefined();
    expect(db.writes.find((w) => w.table === "document_versions" && w.method === "update" && (w.args[0] as Row).intake_link_id === LINK)?.filters).toContainEqual(["eq", "id", "v-pub"]);
    expect(db.pipeline).toHaveLength(1);
    expect(db.pipeline[0].boundToServiceRole).toBe(true);
    expect(db.pipeline[0].input).toMatchObject({ orgId: ORG, documentId: D1, libraryId: "lib1", docLabel: "V-100", newRev: "C", actorUserId: "creator1", actorName: "Vendor Co (intake)", settle: true });
    expect(db.bound).toBe(false); // always unbound afterwards
  });
  it.each([
    ["an active hold", () => { db.tables.document_holds = [{ id: "h1", document_id: D1, released_at: null, reason: "MOC" }]; }, /active hold/],
    ["an unreadable hold state (fails closed)", () => { db.errors["document_holds.select"] = [{ message: "boom" }]; }, /hold status could not be verified/],
    ["a legal hold", () => { db.tables.documents[0].legal_hold = true; }, /legal hold/],
    ["a checkout", () => { db.tables.documents[0].checked_out_by = "eng1"; }, /checked out/],
    ["a creator without authority", () => { db.tables.org_members[0].role = "Viewer"; db.tables.org_members[0].roles = ["Viewer"]; }, /no longer holds publish authority/],
    ["a library that requires sign-off (SEC-13)", () => { db.rpc.review_control_mode_for = () => ({ data: "require", error: null }); }, /requires reviewer sign-off/],
    ["an unreadable review policy (fails closed)", () => { db.rpc.review_control_mode_for = () => ({ data: null, error: { message: "fn missing" } }); }, /review policy could not be verified/],
    ["the contract's hold gate", () => { db.rpc.publish_revision = () => ({ data: { status: "on_hold" }, error: null }); }, /active hold/],
    ["the contract's checkout lock", () => { db.rpc.publish_revision = () => ({ data: { status: "locked_by_other" }, error: null }); }, /checked out/],
    ["the contract's MOC gate on a drawing (SEC-14, the service-role path)", () => { db.rpc.publish_revision = () => ({ data: null, error: { message: "publish_revision: PSM requires an MOC reference to publish a non-minor revision of a drawing-class document" } }); }, /MOC\) reference/],
  ])("%s DEMOTES the upload to review — the file is kept, the promote withheld", async (_label, arrange, why) => {
    seed();
    arrange();
    const res = await upload({ docId: D1, revLabel: "C" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("in_review");
    expect(body.note).toMatch(why);
    expect(db.r2Puts).toHaveLength(1);
    expect(db.writes.find((w) => w.table === "document_versions" && w.method === "insert")?.args[0]).toMatchObject({ review_state: "in_review", intake_link_id: LINK });
    expect(db.pipeline).toEqual([]);
  });
  it("a moved base is a 409 the contractor can act on — nothing half-published", async () => {
    seed();
    db.rpc.publish_revision = () => ({ data: { status: "stale_base" }, error: null });
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/document changed/);
    expect(db.pipeline).toEqual([]);
  });
});

// ── The displaced submission (INTK-4 / SAF-10) ──────────────────────────────
describe("a displaced submission is resolved, never orphaned", () => {
  const withOwnPending = () => seed({
    doc: { pending_version_id: "v-pend" },
    versions: [
      { id: "v-cur", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", created_at: "2026-09-01T00:00:00Z" },
      { id: "v-pend", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "in_review", created_at: "2026-09-20T00:00:00Z" },
    ],
  });
  it("the auto path clears only the pointer it read and marks the displaced draft 'superseded' with an audit row and a forced notice", async () => {
    withOwnPending();
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    db.tables.intake_attempts = [{ token_hash: sha256Hex(TOKEN), ip: "unknown", outcome: "notified", created_at: new Date().toISOString() }];
    const res = await upload({ docId: D1, revLabel: "C" });
    expect((await res.json()).status).toBe("published");
    const clear = db.writes.find((w) => w.table === "documents" && w.method === "update" && (w.args[0] as Row).pending_version_id === null);
    expect(clear?.filters).toContainEqual(["eq", "pending_version_id", "v-pend"]);
    expect(db.tables.document_versions.find((v) => v.id === "v-pend")).toMatchObject({ review_state: "superseded" });
    // the orphan query is empty: no in_review version that the pointer does not name
    const doc = db.tables.documents[0];
    expect(db.tables.document_versions.filter((v) => v.review_state === "in_review" && doc.pending_version_id !== v.id)).toEqual([]);
    expect(db.tables.audit_logs.find((a) => a.action === "INTAKE_SUBMISSION_DISPLACED")).toMatchObject({ details: expect.objectContaining({ displacedVersionId: "v-pend", byVersionId: "v-pub" }) });
    // debounced submissions notwithstanding, a displacement is always told
    expect(db.emits.some((e) => String(e.body).includes("replaced their earlier submission"))).toBe(true);
  });
  it("a pre-20261105 database (review_state CHECK without 'superseded') keeps the superseded_at retirement", async () => {
    withOwnPending();
    db.rpc.review_control_mode_for = () => ({ data: "require", error: null }); // demoted: review path
    db.errors["document_versions.update"] = [{ message: "violates check constraint document_versions_review_state_check", code: "23514" }];
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(200);
    const fallback = db.writes.filter((w) => w.table === "document_versions" && w.method === "update" && w.filters.some(([, c, v]) => c === "id" && v === "v-pend"));
    expect(fallback.map((w) => Object.keys(w.args[0] as Row).sort())).toEqual([["review_state", "superseded_at"], ["superseded_at"]]);
  });
  it("a NON-trusted link cannot displace its pending submission — 409, stated for every link it reaches", async () => {
    withOwnPending();
    db.tables.project_intake_links[0].allow_auto_supersede = false;
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/still in review/);
  });
  it("a trusted link never displaces a pending draft that is not its OWN submission", async () => {
    withOwnPending();
    db.tables.document_versions.find((v) => v.id === "v-pend")!.intake_link_id = null; // an org draft
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(409);
  });
});

// ── New documents (INTK-5 / INTK-13 / INTK-1) ───────────────────────────────
describe("a new document", () => {
  it("is stamped authored_by_link_id and carries the uniqueness key the library's tuple computes", async () => {
    seed({ doc: null });
    db.tables.libraries[0].uniqueness_keys = ["documentNumber", "title"];
    const res = await upload({ title: " Skid GA ", number: "V-300" });
    expect(res.status).toBe(200);
    const ins = db.writes.find((w) => w.table === "documents" && w.method === "insert");
    expect(ins?.args[0]).toMatchObject({ authored_by_link_id: LINK, uniqueness_key: "v-300::skid ga", status: "Draft" });
  });
  it("a number already live in the library is refused BEFORE storage", async () => {
    seed({ doc: null });
    db.tables.documents = [{ id: "other", org_id: ORG, library_id: "lib1", uniqueness_key: "v-300", status: "Issued" }];
    const res = await upload({ title: "Skid GA", number: "V-300" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("number_in_use");
    expect(db.r2Puts).toEqual([]);
  });
  it("a pre-20261104 database without authored_by_link_id still creates the document", async () => {
    seed({ doc: null });
    db.errors["documents.insert"] = [{ message: "Could not find the 'authored_by_link_id' column of 'documents' in the schema cache", code: "PGRST204" }];
    const res = await upload({ title: "Skid GA" });
    expect(res.status).toBe(200);
    const inserts = db.writes.filter((w) => w.table === "documents" && w.method === "insert");
    expect(inserts).toHaveLength(2);
    expect(inserts[1].args[0]).not.toHaveProperty("authored_by_link_id");
  });
  it("two first submissions never fork the intake folder: the loser deletes its folder and files into the winner's", async () => {
    seed({ doc: null });
    db.tables.projects[0].intake_collection_id = null;
    // the claim write finds the pointer already taken (another submission won)
    const realUpdate = db.tables.projects[0];
    Object.defineProperty(db.tables, "projects", {
      configurable: true,
      get() { return [realUpdate]; },
    });
    db.errors["projects.update"] = [null];
    realUpdate.intake_collection_id = null;
    // make the CAS miss by flipping the pointer right before the claim
    const origPush = db.writes.push.bind(db.writes);
    db.writes.push = (w) => {
      if (w.table === "collections" && w.method === "insert") realUpdate.intake_collection_id = "col-winner";
      return origPush(w);
    };
    const res = await upload({ title: "Skid GA" });
    db.writes.push = origPush;
    expect(res.status).toBe(200);
    expect(db.writes.find((w) => w.table === "collections" && w.method === "delete")).toBeDefined();
    expect(db.writes.find((w) => w.table === "documents" && w.method === "insert")?.args[0]).toMatchObject({ collection_id: "col-winner" });
  });
  it("a refused intake-folder pointer write fails the request (checked) instead of forking a folder per submission", async () => {
    seed({ doc: null });
    db.tables.projects[0].intake_collection_id = null;
    db.errors["projects.update"] = [{ message: "permission denied for table projects" }];
    const res = await upload({ title: "Skid GA" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Couldn't prepare the intake folder/);
    expect(body.error).not.toMatch(/permission denied/);
    expect(body.ref).toBeTruthy();
  });
});

// ── Retries and errors (REL-8 / INTK-13) ────────────────────────────────────
describe("a retry returns the original; an error names no internals", () => {
  it("the same bytes resubmitted while the first is in review return the first record — nothing stored, nobody notified again", async () => {
    seed({ doc: null });
    const first = await (await upload({ title: "Skid GA" })).json();
    const putsAfterFirst = db.r2Puts.length;
    const emitsAfterFirst = db.emits.length;
    const again = await (await upload({ title: "Skid GA" })).json();
    expect(again).toMatchObject({ ok: true, duplicate: true, documentId: first.documentId, versionId: first.versionId, status: "in_review" });
    expect(db.r2Puts.length).toBe(putsAfterFirst);
    expect(db.emits.length).toBe(emitsAfterFirst);
  });
  it("a quote retried while still a draft returns the original quote", async () => {
    seed({ link: { purpose: "quote" } });
    const first = await (await upload({})).json();
    const again = await (await upload({})).json();
    expect(again).toMatchObject({ duplicate: true, quoteId: first.quoteId });
    expect(db.tables.cost_documents).toHaveLength(1);
    expect(db.tables.cost_documents[0]).toMatchObject({ mime_type: "application/pdf" });
  });
  it("a database error reaches the portal as a sentence and a reference — never the Postgres text", async () => {
    seed({ doc: null });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.errors["documents.insert"] = [{ message: 'new row violates row-level security policy "documents_insert_guard"' }];
    const res = await upload({ title: "Skid GA" });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("Couldn't create the document — try again shortly.");
    expect(JSON.stringify(body)).not.toMatch(/row-level|documents_insert_guard/);
    expect(spy.mock.calls.some((c) => String(c[0]).includes(body.ref) && String(c[0]).includes("documents_insert_guard"))).toBe(true);
    spy.mockRestore();
  });
  it("the redline branch answers the same for a ticket that is not this link's and one that does not exist", async () => {
    seed();
    db.tables.tickets = [{ id: "00000000-0000-4000-8000-00000000aaaa", org_id: ORG, ticket_id: "T-1", metadata: { intake_collision: { intakeLinkId: "another-link" } } }];
    const notMine = await upload({ ticketId: "00000000-0000-4000-8000-00000000aaaa" });
    const missing = await upload({ ticketId: "00000000-0000-4000-8000-00000000bbbb" });
    expect(notMine.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await notMine.json()).error).toBe((await missing.json()).error);
    expect(db.r2Puts).toEqual([]);
  });
});

// ── Notices (INTK-10 / SEC-8 dw2) and the app session (SEC-16 dw2) ──────────
describe("notices and attribution", () => {
  it("a review-routed submission notifies through emit(): controllers + owner + live intent holders, followers on, under the service role", async () => {
    seed({ link: { assigned_doc_ids: [D1] }, doc: { authored_by_link_id: null } });
    await upload({ docId: D1, revLabel: "C" });
    expect(db.emits).toHaveLength(1);
    const e = db.emits[0] as Row & { audience: { involved: string[]; followers: boolean } };
    expect(e.kind).toBe("review_requested");
    expect(e.boundToServiceRole).toBe(true);
    expect(e.audience.followers).toBe(true);
    expect(new Set(e.audience.involved)).toEqual(new Set(["creator1", "ctl2", "owner1", "intent-holder"]));
    expect(db.writes.find((w) => w.table === "notifications" || w.table === "email_notifications")).toBeUndefined();
  });
  it("a burst is ONE notice per link per window", async () => {
    seed({ doc: null });
    await upload({ title: "A" }, { bytes: enc("%PDF-1.7 a"), name: "a.pdf" });
    await upload({ title: "B" }, { bytes: enc("%PDF-1.7 b"), name: "b.pdf" });
    await upload({ title: "C" }, { bytes: enc("%PDF-1.7 c"), name: "c.pdf" });
    expect(db.emits).toHaveLength(1);
    expect(db.tables.intake_attempts.filter((a) => a.outcome === "notified")).toHaveLength(1);
  });
  it("a token used from a browser signed in to the app records that session on the audit row", async () => {
    seed({ doc: null });
    db.user = { id: "insider1", email: "insider@org.test" };
    await upload({ title: "Skid GA" }, undefined, { authorization: "Bearer app-session-jwt" });
    const row = db.tables.audit_logs.find((a) => a.action === "INTAKE_SUBMISSION");
    expect((row?.details as Row).appSession).toEqual({ userId: "insider1", email: "insider@org.test" });
  });
  it("the usage counter is bumped with the byte count (the per-link storage budget)", async () => {
    seed({ doc: null });
    await upload({ title: "Skid GA" });
    expect(db.rpcCalls.find((c) => c.fn === "bump_intake_use")?.args).toEqual({ p_link: LINK, p_bytes: PDF.length });
  });
});

// ── INTK-2 dw3: every writer of documents.current_version_id ────────────────
describe("census — every writer of current_version_id runs the post-publish pipeline", () => {
  const ROOTS = ["app", "lib", "components"];
  // First-version writers document-control P3 LIFECYCLE converts; remove an
  // entry when its file imports the pipeline (or stops writing the pointer).
  const ALLOW = new Set(["lib/documentLifecycle/common.ts", "app/(protected)/documents/[libraryId]/page.tsx"]);
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "__tests__") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
  const writers = ROOTS.flatMap((r) => walk(join(process.cwd(), r)))
    .filter((p) => /\.update\(\{[^}]*current_version_id:\s*(?!null\b)/.test(readFileSync(p, "utf8")))
    .map((p) => relative(process.cwd(), p).split("\\").join("/"));
  it("finds the known writers (the census is not vacuous)", () => {
    expect(writers).toEqual(expect.arrayContaining(["lib/revisions.ts", "lib/reviewControl.ts", "lib/documentLifecycle/common.ts"]));
  });
  it("each imports lib/postPublish (statically or dynamically) or is allow-listed", () => {
    for (const w of writers) {
      if (ALLOW.has(w)) continue;
      expect(readFileSync(join(process.cwd(), w), "utf8"), `${w} writes current_version_id without the post-publish pipeline`).toMatch(/@\/lib\/postPublish/);
    }
  });
  it("the intake route no longer writes the pointer itself — it publishes through the contract and runs the pipeline", () => {
    const r = readFileSync(join(process.cwd(), "app/api/intake/upload/route.ts"), "utf8");
    expect(r).not.toMatch(/current_version_id:\s*versionId/);
    expect(r).toMatch(/await import\("@\/lib\/postPublish"\)/);
    expect(readFileSync(join(process.cwd(), "lib/postPublish.ts"), "utf8")).toMatch(/app\/api\/intake\/upload\/route\.ts/);
  });
});

// ── GET /api/intake/resolve (PM-2, INTK-9 / SEC-11, SAF-9) ──────────────────
describe("the portal's resolve route", () => {
  const resolve = async () => {
    const { GET } = await import("@/app/api/intake/resolve/route");
    return GET(new NextRequest(`http://x/api/intake/resolve?token=${TOKEN}`));
  };
  it("a link whose project is gone answers a definite link_gone — no register under a generic 'Project'", async () => {
    seed();
    db.tables.projects = [];
    const res = await resolve();
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("link_gone");
  });
  it("a closed project's link answers project_closed", async () => {
    seed();
    db.tables.projects[0].status = "cancelled";
    expect((await (await resolve()).json()).error).toBe("project_closed");
  });
  it("an assigned id from ANOTHER org lists nothing; the link's own authored document lists even without a version stamp", async () => {
    seed({ link: { assigned_doc_ids: ["foreign-doc"] }, versions: [] });
    db.tables.documents.push({ id: "foreign-doc", org_id: "other-org", document_number: "SECRET-1", updated_at: "x" });
    const body = await (await resolve()).json();
    expect(body.items.map((i: Row) => i.label)).toEqual(["V-100"]);
    expect(JSON.stringify(body)).not.toMatch(/SECRET-1/);
  });
  it("a rejected submission carries the reviewer's reason; a trusted publish reads as approved; a displaced one has no outcome", async () => {
    seed({ versions: [
      { id: "v-rej", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "rejected", review_note: "Wrong tie-in elevation", released_at: null, created_at: "2026-09-20T00:00:00Z" },
    ] });
    let body = await (await resolve()).json();
    expect(body.items[0]).toMatchObject({ lastOutcome: "rejected", rejectionReason: "Wrong tie-in elevation" });
    seed({ versions: [
      { id: "v-pub", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: null, released_at: "2026-09-21T00:00:00Z", created_at: "2026-09-21T00:00:00Z" },
    ] });
    body = await (await resolve()).json();
    expect(body.items[0]).toMatchObject({ lastOutcome: "approved", rejectionReason: null });
    expect(body.expiresAt).toBeNull();
  });
});

// ── The surfaces (source pins; the repo has no component renderer) ──────────
describe("the Intake tab, the transition-in panel and the portal", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("IntakePanel approve: the version on screen, the chain-resolved review policy, the MOC reference (SAF-15 / SEC-13 / SEC-14)", () => {
    const p = src("components/projects/IntakePanel.tsx");
    const approve = p.slice(p.indexOf("const approve = async"), p.indexOf("const reject = async"));
    expect(approve).toMatch(/String\(doc\.pending_version_id \?\? ""\) !== p\.pendingVersionId/);
    expect(approve).toMatch(/await effectiveReviewControlForDocument\(\{/);
    expect(approve).toMatch(/const rosterRequired = control\.mode === "require";/);
    expect(approve).toMatch(/await openReviewRoster\(\{/);
    expect(approve).toMatch(/requireRosterComplete: rosterRequired,/);
    expect(approve).not.toMatch(/requireRosterComplete: false/);
    expect(approve).toMatch(/await effectiveDocClassForDocument\(/);
    expect(approve).toMatch(/\.update\(\{ moc_reference: moc\.trim\(\) \}\)/);
    expect(approve).toContain("throw new Error(finalizeReasonMessage(res.reason));");
    // the success message names what actually became current
    expect(approve).toMatch(/String\(after\?\.current_version_id \?\? ""\) === p\.pendingVersionId/);
  });
  it("IntakePanel reject: a required reason, stored for the portal and the audit (SAF-9)", () => {
    const p = src("components/projects/IntakePanel.tsx");
    const reject = p.slice(p.indexOf("const reject = async"), p.indexOf("const portalUrl"));
    expect(reject).toMatch(/const reason = await appPrompt\(\{/);
    expect(reject).toMatch(/reason\.trim\(\)\.length < 5/);
    expect(reject).toContain('.update({ review_state: "rejected", review_note: reason.trim() })');
    expect(reject).toContain("reason: reason.trim()");
  });
  it("IntakePanel links: document links only, an expiry always, the audit row names the link (SEC-5 / INTK-12 limb)", () => {
    const p = src("components/projects/IntakePanel.tsx");
    expect(p).toContain('.eq("project_id", projectId).eq("purpose", "documents")');
    expect(p).toContain("const expiry = intakeExpiryFor(expires);");
    expect(p).toContain("expires_at: expiry.iso,");
    expect(p).toMatch(/\}\)\.select\("id"\)\.single\(\);/);
    expect(p).toContain('resource_type: "project_intake_link", resource_id: String((created as { id: string }).id),');
    expect(p).not.toContain('resource_id: projectId,');
    expect(p).toContain("useState(() => isoDateInDays(INTAKE_LINK_DEFAULT_DAYS))");
  });
  it("TransitionInPanel: adopt controls for the controller tier only; a collision or an unapproved sheet cannot be adopted (SAF-13 / SAF-12 / INTK-3)", () => {
    const t = src("components/projects/TransitionInPanel.tsx");
    expect(t).toContain("const canAdopt = canManage && isControllerPrincipal({ role: activeRole, roles });");
    expect(t).toMatch(/disabled=\{busy === c\.docId \|\| !destLib \|\| !!c\.awaitingReview \|\| \(!!impact\.numberCollision && !\(renumber\.get\(c\.docId\) \?\? ""\)\.trim\(\)\)\}/);
    expect(t).toContain("const bulkable = (c: TransitionCandidate) => !c.awaitingReview && !!impacts.get(c.docId)?.clean;");
    expect(t).toContain("const clean = candidates.filter(bulkable);");
  });
  it("the portal sends the token in a header, renders a reference, a gone link, a closed project and a rejection reason", () => {
    const s = src("app/submit/[token]/page.tsx");
    expect(s).toContain("const headers: Record<string, string> = { [INTAKE_TOKEN_HEADER]: token };");
    expect(s).not.toMatch(/form\.set\("token"/);
    expect(s).toContain('${body.ref ? ` (reference ${body.ref})` : ""}');
    expect(s).toContain('state === "link_gone" ? LINK_GONE_MESSAGE');
    expect(s).toContain('state === "project_closed" ? PROJECT_CLOSED_MESSAGE');
    expect(s).toContain("Reviewer&apos;s reason: {i.rejectionReason}");
    expect(s).not.toMatch(/`HTTP \$\{res\.status\}`/);
  });
  it("the maintenance cron gains ONE intake step (prune + orphan health) and no new cron entry", () => {
    const c = src("app/api/cron/maintenance/route.ts");
    expect((c.match(/sb\.rpc\("prune_intake_attempts"\)/g) ?? []).length).toBe(1);
    expect(c).toMatch(/sb\.rpc\("orphaned_in_review_versions_count"\)/);
    const vercel = JSON.parse(src("vercel.json")) as { crons?: unknown[] };
    expect((vercel.crons ?? []).length).toBeLessThanOrEqual(2);
  });
});
