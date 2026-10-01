// projects Round G — J1 INTAKE-DOOR: the external door as a boundary.
//
//   INTK-8 / SEC-8 / SEC-6   the token is checked before the body; an
//                            oversize Content-Length is refused unread; a
//                            per-token window answers 429 (and fails OPEN);
//                            a spent link budget answers 429.
//   INTK-11 / SEC-6 / SEC-1  the bytes decide the type; the stored
//                            ContentType is the sniffed one.
//   INTK-1 / SEC-3 / SEC-12  authorship is documents.authored_by_link_id; an
//                            assigned document, a never-approved one, one
//                            whose last submission was rejected, one with a
//                            rejection against its current revision, a
//                            rejected file resent, and one with the link's
//                            own submission still pending all go to review
//                            (the reject → throwaway → resend bypass is
//                            closed).
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
//   REL-8 / INTK-13          a retry returns the original — only a LIVE one
//                            of the same record; a withdrawn row never
//                            answers, another document's never leaks; a
//                            lost retry race removes what it made; errors
//                            carry a reference and no database text; the
//                            redline branch answers the same for "not
//                            yours" and "not there"; the intake folder
//                            never forks.
//   COST-12 / DEC-40         a quote carries the party its company names; a
//                            new document is referenced from the project.
//   PM-2                     a link whose project is gone opens nothing.
//   INTK-10                  notices go through emit(), one per window.
//   INTK-10 / SEC-8 dw2      a published revision is always told; a folded
//                            submission is counted into the next notice.
//   INTK-2 dw3               every writer of current_version_id — per call
//                            site, shorthand and prebuilt patches included —
//                            runs the post-publish pipeline in the same
//                            function or is pinned with its reason.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import ts from "typescript";
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
  /** INTK-15: objects a direct upload staged (key → bytes) and the reads of them. */
  r2Objects: new Map<string, Uint8Array>(),
  r2Reads: [] as Array<{ op: string; key: string; range?: string }>,
  presigns: [] as Array<{ input: Record<string, unknown>; opts: Record<string, unknown> }>,
  /** INTK-15: called after each staged GET (a re-PUT between the reads);
   *  `ignoreIfMatch` is a storage that does not honour If-Match. */
  afterGet: null as null | ((key: string, range?: string) => void),
  ignoreIfMatch: false,
  r2Deletes: [] as Array<Record<string, unknown>>,
  emits: [] as Array<Record<string, unknown>>,
  pipeline: [] as Array<{ input: Record<string, unknown>; boundToServiceRole: boolean }>,
  /** lib/serverClientScope.ts's reader, registered on the (mocked) shared
   *  client module — "bound" means the CURRENT async context resolves the
   *  shared client to the service role. */
  scopeRead: null as null | (() => unknown),
  seq: 0,
  user: null as null | { id: string; email: string },
}));
const scopedToAdmin = () => (db.scopeRead?.() as { __admin?: boolean } | undefined)?.__admin === true;

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
  const orders: Array<[string, boolean]> = [];
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
  const rows = () => {
    const all = db.tables[table] ?? [];
    const hit = all.filter(matches);
    if (orders.length === 0) return hit;
    // ORDER BY, ties broken by insertion order in the same direction (a
    // later insert is "newer") — the route relies on newest-first reads.
    const pos = new Map(hit.map((r) => [r, all.indexOf(r)]));
    return [...hit].sort((a, b) => {
      for (const [col, asc] of orders) {
        const x = String(a[col] ?? ""), y = String(b[col] ?? "");
        if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
      }
      return ((pos.get(a) ?? 0) - (pos.get(b) ?? 0)) * (orders[0][1] ? 1 : -1);
    });
  };
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
          case "order": orders.push([String(args[0]), (args[1] as { ascending?: boolean } | undefined)?.ascending !== false]); break;
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
    __admin: true,
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
  // INTK-16: adopt_intake_document answers as a database before 20261141, so
  // the adoption cases below exercise the direct-update path (the database
  // path is lib/__tests__/transitionIn.test.ts's and the scratch cluster's).
  supabase: {
    from: (t: string) => chain(t),
    rpc: async (fn: string) => (fn === "adopt_intake_document"
      ? { data: null, error: { message: `Could not find the function public.${fn}`, code: "PGRST202" } }
      : { data: null, error: null }),
  },
  __registerScopedServerClient: vi.fn((read: () => unknown) => { db.scopeRead = read; }),
}));
vi.mock("@/lib/r2", () => ({
  r2: {
    send: vi.fn(async (cmd: { input: Row; op: string }) => {
      // INTK-15: a staged object answers HEAD and (ranged) GET.
      if (cmd.op === "head" || cmd.op === "get") {
        const key = String(cmd.input.Key);
        db.r2Reads.push({ op: cmd.op, key, ...(cmd.input.Range ? { range: String(cmd.input.Range) } : {}) });
        const obj = db.r2Objects.get(key);
        if (!obj) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        // an ETag that changes with the bytes (FNV-1a + length)
        let h = 2166136261;
        for (const x of obj) { h ^= x; h = Math.imul(h, 16777619) >>> 0; }
        const etag = `"${h.toString(16)}-${obj.byteLength}"`;
        if (cmd.op === "head") return { ContentLength: obj.byteLength, ETag: etag };
        if (cmd.input.IfMatch && !db.ignoreIfMatch && cmd.input.IfMatch !== etag) {
          throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
        }
        const m = /^bytes=(\d+)-(\d+)$/.exec(String(cmd.input.Range ?? ""));
        const part = new Uint8Array(m ? obj.subarray(Number(m[1]), Number(m[2]) + 1) : obj);
        db.afterGet?.(key, cmd.input.Range ? String(cmd.input.Range) : undefined);
        return { Body: { transformToByteArray: async () => part } };
      }
      (cmd.op === "delete" ? db.r2Deletes : db.r2Puts).push(cmd.input);
      if (cmd.op === "delete") db.r2Objects.delete(String(cmd.input.Key));
    }),
  },
  R2_BUCKET: "bucket",
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client: unknown, cmd: { input: Row }, opts: Row) => {
    db.presigns.push({ input: cmd.input, opts });
    return `https://r2.test/${String(cmd.input.Key)}?X-Amz-Expires=${String(opts.expiresIn)}`;
  }),
}));
vi.mock("@aws-sdk/client-s3", () => ({
  PutObjectCommand: class { op = "put"; constructor(public input: unknown) {} },
  DeleteObjectCommand: class { op = "delete"; constructor(public input: unknown) {} },
  GetObjectCommand: class { op = "get"; constructor(public input: unknown) {} },
  HeadObjectCommand: class { op = "head"; constructor(public input: unknown) {} },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (e: Row) => { db.emits.push({ ...e, boundToServiceRole: scopedToAdmin() }); }) }));
vi.mock("@/lib/postPublish", () => ({
  runPostPublishSideEffects: vi.fn(async (input: Row) => { db.pipeline.push({ input, boundToServiceRole: scopedToAdmin() }); }),
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
    // SEC-19 (20261141): the link is found by the token's SHA-256.
    token: null, token_hash: createHash("sha256").update(TOKEN).digest("hex"), purpose: "documents", rfq_group: null,
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
  db.tables = {}; db.writes = []; db.errors = {}; db.rpcCalls = []; db.r2Puts = []; db.r2Deletes = []; db.emits = []; db.pipeline = [];
  db.r2Objects = new Map(); db.r2Reads = []; db.presigns = []; db.afterGet = null; db.ignoreIfMatch = false;
  db.seq = 0; db.user = null;
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
  it("a closed or gone project is answered BEFORE the body is received — an unparseable body still reads 410, never 400 (PC brief)", async () => {
    seed();
    db.tables.projects[0].status = "cancelled";
    const closed = await POST(new NextRequest("http://x/api/intake/upload", { method: "POST", body: "not multipart at all", headers: { "x-intake-token": TOKEN } }));
    expect(closed.status).toBe(410);
    expect((await closed.json()).code).toBe("project_closed");
    db.tables.projects = [];
    const gone = await POST(new NextRequest("http://x/api/intake/upload", { method: "POST", body: "not multipart at all", headers: { "x-intake-token": TOKEN } }));
    expect(gone.status).toBe(410);
    expect((await gone.json()).code).toBe("link_gone");
    // and the project is read before the budget and the body in the source order
    const r = readFileSync(join(process.cwd(), "app/api/intake/upload/route.ts"), "utf8");
    const post = r.slice(r.indexOf("export async function POST"));
    expect(post.indexOf('.from("projects").select("id, name, status')).toBeLessThan(post.indexOf("readLinkBudget(supabaseAdmin, linkId)"));
    expect(post.indexOf("readLinkBudget(supabaseAdmin, linkId)")).toBeLessThan(post.indexOf("await req.formData()"));
  });
  it("a link the database does not hold (a deleted project's links are DELETED by the trigger) answers a definite sentence, never the bare token 'notfound' (PM-2 dw2)", async () => {
    seed();
    db.tables.project_intake_links = [];
    const res = await upload({ title: "Skid GA" });
    expect(res.status).toBe(404);
    const body = await res.json();
    const { LINK_INVALID_MESSAGE } = await import("@/lib/intakeLinks");
    expect(body).toMatchObject({ error: LINK_INVALID_MESSAGE, code: "notfound" });
    expect(body.error).toMatch(/no longer valid — it may have been withdrawn or mistyped/);
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
  it("an authorship read that FAILS is 'try again' (503) — never 'this link may not revise its own drawing' (403)", async () => {
    seed();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // the document read succeeds; the authorship read fails transiently
    db.errors["documents.select"] = [null, { message: "connection reset by peer" }];
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/could not be checked right now — try again shortly/);
    expect(JSON.stringify(body)).not.toMatch(/connection reset/);
    expect(db.r2Puts).toEqual([]);
    spy.mockRestore();
  });
});

// ── INTK-1 dw3: a rejected file is never re-published without a person ──────
describe("a rejected submission is never re-published by resubmitting it", () => {
  const F = enc("%PDF-1.7\n% sheet F, rejected\n");
  const G = enc("%PDF-1.7\n% throwaway G\n");
  const doc = () => db.tables.documents[0];
  it("reject F → submit G (review) → submit F again, or F plus one byte: each lands IN REVIEW, publish_revision is never called", async () => {
    seed();
    // Step 1: F arrives while a hold demotes it, and the team rejects it.
    db.tables.document_holds = [{ id: "h1", document_id: D1, released_at: null }];
    const f = await (await upload({ docId: D1, revLabel: "C" }, { bytes: F, name: "f.pdf", type: "application/pdf" })).json();
    expect(f.status).toBe("in_review");
    db.tables.document_holds = [];
    Object.assign(db.tables.document_versions.find((v) => v.id === f.versionId)!, { review_state: "rejected", review_note: "Wrong elevation" });
    doc().pending_version_id = null;
    // Step 2: a throwaway G goes to review (a rejection stands against the current revision).
    const g = await (await upload({ docId: D1, revLabel: "C" }, { bytes: G, name: "g.pdf", type: "application/pdf" })).json();
    expect(g.status).toBe("in_review");
    expect(doc().pending_version_id).toBe(g.versionId);
    // Step 3: F again — then F with a trailing byte. Neither publishes.
    for (const bytes of [F, new Uint8Array([...F, 0x0a])]) {
      const res = await upload({ docId: D1, revLabel: "C" }, { bytes, name: "f.pdf", type: "application/pdf" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("in_review");
      expect(body.note).toMatch(/Automatic publication was withheld/);
    }
    expect(published()).toBeUndefined();
    expect(db.pipeline).toEqual([]);
    expect(doc().current_version_id).toBe("v-cur");
  });
  it("the throwaway route is closed by the pending gate on its own: with the link's own submission awaiting review, new bytes do not publish", async () => {
    seed({ doc: { pending_version_id: "v-G" }, versions: [
      { id: "v-old", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", created_at: "2026-01-01T00:00:00Z" },
      // rejected long ago, against an older base — no other rule applies
      { id: "v-F", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "rejected", file_hash: "0".repeat(64), supersedes_version_id: "v-old", created_at: "2026-02-01T00:00:00Z" },
      { id: "v-cur", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", supersedes_version_id: "v-old", created_at: "2026-03-01T00:00:00Z" },
      { id: "v-G", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "in_review", supersedes_version_id: "v-cur", file_hash: "1".repeat(64), created_at: "2026-04-01T00:00:00Z" },
    ] });
    const body = await (await upload({ docId: D1, revLabel: "D" })).json();
    expect(body.status).toBe("in_review");
    expect(body.note).toMatch(/your previous submission for this document is still awaiting review/);
    expect(published()).toBeUndefined();
    expect(db.tables.document_versions.find((v) => v.id === "v-G")).toMatchObject({ review_state: "superseded" });
  });
  it("the rejected bytes are reviewed again however long ago they were refused", async () => {
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    seed({ doc: { current_version_id: "v-G" }, versions: [
      { id: "v-cur", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", created_at: "2026-01-01T00:00:00Z" },
      { id: "v-F", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "rejected", file_hash: sha256Hex(F), supersedes_version_id: "v-cur", created_at: "2026-02-01T00:00:00Z" },
      { id: "v-G", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", supersedes_version_id: "v-cur", created_at: "2026-03-01T00:00:00Z" },
    ] });
    const body = await (await upload({ docId: D1, revLabel: "D" }, { bytes: F, name: "f.pdf", type: "application/pdf" })).json();
    expect(body.status).toBe("in_review");
    expect(body.note).toMatch(/this file was not accepted when it was submitted before/);
    expect(published()).toBeUndefined();
  });
  it("once the team has approved a later submission, the trusted link publishes new work again — the rule waits for a person, not forever", async () => {
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    seed({ doc: { current_version_id: "v-G" }, versions: [
      { id: "v-cur", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", created_at: "2026-01-01T00:00:00Z" },
      { id: "v-F", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "rejected", file_hash: sha256Hex(F), supersedes_version_id: "v-cur", created_at: "2026-02-01T00:00:00Z" },
      { id: "v-G", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", supersedes_version_id: "v-cur", created_at: "2026-03-01T00:00:00Z" },
    ] });
    const body = await (await upload({ docId: D1, revLabel: "D" })).json();
    expect(body.status).toBe("published");
    expect(published()?.args).toMatchObject({ p_expected_base: "v-G" });
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
    // I-08: the proposal sweep runs in-process on the door's service-role client.
    const { supabaseAdmin } = await import("@/lib/supabaseAdmin");
    expect((db.pipeline[0].input as Row).serviceClient).toBe(supabaseAdmin);
    expect(scopedToAdmin()).toBe(false); // bound only inside the request's async context
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
  it("a trusted link with its own submission still in review does NOT auto-publish: the upload replaces it IN REVIEW — CAS on that draft, 'superseded', an audit row, a forced notice (INTK-1 dw3 / INTK-4)", async () => {
    withOwnPending();
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    db.tables.intake_attempts = [{ token_hash: sha256Hex(TOKEN), ip: "unknown", outcome: "notified", created_at: new Date().toISOString() }];
    const res = await upload({ docId: D1, revLabel: "C" });
    const body = await res.json();
    expect(body.status).toBe("in_review");
    expect(body.note).toMatch(/previous submission for this document is still awaiting review/);
    expect(published()).toBeUndefined();
    expect(db.pipeline).toEqual([]);
    const repoint = db.writes.find((w) => w.table === "documents" && w.method === "update" && (w.args[0] as Row).pending_version_id === body.versionId);
    expect(repoint?.filters).toContainEqual(["eq", "pending_version_id", "v-pend"]);
    expect(db.tables.document_versions.find((v) => v.id === "v-pend")).toMatchObject({ review_state: "superseded" });
    // the orphan query is empty: no in_review version that the pointer does not name
    const doc = db.tables.documents[0];
    expect(db.tables.document_versions.filter((v) => v.review_state === "in_review" && doc.pending_version_id !== v.id)).toEqual([]);
    expect(db.tables.audit_logs.find((a) => a.action === "INTAKE_SUBMISSION_DISPLACED")).toMatchObject({ details: expect.objectContaining({ displacedVersionId: "v-pend", byVersionId: body.versionId }) });
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
  it("the displaced draft is retired BEFORE the replacement is inserted — so a corrected resubmission under the SAME label is taken (INTK-4 b)", async () => {
    withOwnPending();
    db.tables.document_versions[1].revision_label = "C";
    // the active-label index (record_id, revision_label) WHERE superseded_at IS NULL
    const origPush = db.writes.push.bind(db.writes);
    db.writes.push = (w) => {
      if (w.table === "document_versions" && w.method === "insert") {
        const row = w.args[0] as Row;
        if (db.tables.document_versions.some((v) => v.record_id === row.record_id && v.revision_label === row.revision_label && v.superseded_at == null)) {
          db.errors["document_versions.insert"] = [{ code: "23505", message: 'duplicate key value violates unique constraint "document_versions_active_label_uniq_v2"' }];
        }
      }
      return origPush(w);
    };
    const res = await upload({ docId: D1, revLabel: "C" });
    db.writes.push = origPush;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("in_review");
    const order = db.writes.filter((w) => w.table === "document_versions" && (w.method === "insert" || w.filters.some(([, c, v]) => c === "id" && v === "v-pend")));
    expect(order[0].method).toBe("update"); // the retire
    expect(order[0].filters).toEqual(expect.arrayContaining([["eq", "review_state", "in_review"], ["is", "superseded_at", null]]));
    expect(order[1].method).toBe("insert");
    expect(db.tables.documents[0].pending_version_id).toBe(body.versionId);
  });
  it("a replacement that fails after the retire RESTORES the displaced draft — still in review, still pointed at, stamp cleared", async () => {
    withOwnPending();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.errors["document_versions.insert"] = [{ message: "boom" }];
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(500);
    expect(db.tables.document_versions.find((v) => v.id === "v-pend")).toMatchObject({ review_state: "in_review", superseded_at: null });
    expect(db.tables.documents[0].pending_version_id).toBe("v-pend");
    expect((db.tables.audit_logs ?? []).find((a) => a.action === "INTAKE_SUBMISSION_DISPLACED")).toBeUndefined();
    expect(db.r2Deletes).toHaveLength(1);
    spy.mockRestore();
  });
  it("a lost pointer race after the retire withdraws the replacement FIRST, then restores the displaced draft (its label is free again)", async () => {
    withOwnPending();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.errors["documents.update"] = [{ message: "could not serialize access" }];
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(409);
    const vs = db.writes.filter((w) => w.table === "document_versions" && w.method === "update");
    const withdrawIdx = vs.findIndex((w) => (w.args[0] as Row).review_state === "superseded" && !w.filters.some(([, c, v]) => c === "id" && v === "v-pend"));
    const restoreIdx = vs.findIndex((w) => (w.args[0] as Row).superseded_at === null);
    expect(withdrawIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(withdrawIdx);
    expect(db.tables.document_versions.find((v) => v.id === "v-pend")).toMatchObject({ review_state: "in_review", superseded_at: null });
    spy.mockRestore();
  });
  it("a draft a reviewer decided meanwhile is not retired — the upload is refused with a sentence, nothing stored", async () => {
    withOwnPending();
    db.tables.document_versions[1].review_state = "approved"; // decided, pointer not yet cleared
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/was just decided — reload the portal/);
    expect(db.tables.document_versions.find((v) => v.id === "v-pend")).toMatchObject({ review_state: "approved" });
    expect(db.r2Deletes).toHaveLength(1);
  });
  it("a retire that errors is retried once, then refuses (503) — never a displacement recorded over a live draft", async () => {
    withOwnPending();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.errors["document_versions.update"] = [{ message: "network" }, { message: "network" }];
    const res = await upload({ docId: D1, revLabel: "C" });
    expect(res.status).toBe(503);
    expect(db.tables.document_versions.find((v) => v.id === "v-pend")).toMatchObject({ review_state: "in_review" });
    expect(db.writes.filter((w) => w.table === "document_versions" && w.method === "insert")).toEqual([]);
    spy.mockRestore();
  });
  it("a restore that cannot land is recorded as INTAKE_DISPLACE_UNRESOLVED (the cron surfaces it)", async () => {
    withOwnPending();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.errors["document_versions.insert"] = [{ message: "boom" }];
    db.errors["document_versions.update"] = [null, { message: "down" }, { message: "down" }];
    await upload({ docId: D1, revLabel: "C" });
    expect(db.tables.audit_logs.find((a) => a.action === "INTAKE_DISPLACE_UNRESOLVED")).toMatchObject({ details: expect.objectContaining({ displacedVersionId: "v-pend" }) });
    spy.mockRestore();
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
  it("a multi-sheet library (['documentNumber','sheet']): two same-numbered sheets are BOTH accepted — unkeyed, no pre-check — and both adopt into a multi-sheet library (INTK-5 blocker)", async () => {
    seed({ doc: null });
    db.tables.libraries[0].uniqueness_keys = ["documentNumber", "sheet"];
    // a live sheet 1 of the same number already in the intake library, keyed the way the plain helper would
    db.tables.documents = [{ id: "sheet0", org_id: ORG, library_id: "lib1", document_number: "P-100", uniqueness_key: "p-100::", status: "Issued" }];
    const s1 = await upload({ title: "P&ID sheet 1", number: "P-100" }, { bytes: enc("%PDF-1.7 sheet one"), name: "s1.pdf" });
    const s2 = await upload({ title: "P&ID sheet 2", number: "P-100" }, { bytes: enc("%PDF-1.7 sheet two"), name: "s2.pdf" });
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    const inserts = db.writes.filter((w) => w.table === "documents" && w.method === "insert");
    expect(inserts.map((w) => (w.args[0] as Row).uniqueness_key)).toEqual([null, null]);
    // (a partial key 'p-100::' would have met sheet0 in the pre-check and refused both)
    // the team approves both; a controller adopts both into a multi-sheet destination
    const ids = [(await s1.json()).documentId, (await s2.json()).documentId];
    for (const d of db.tables.documents.filter((x) => ids.includes(x.id))) Object.assign(d, { current_version_id: `v-${d.id}`, pending_version_id: null, status: "Issued", metadata: {} });
    db.tables.libraries.push({ id: "lib-dest", org_id: ORG, uniqueness_keys: ["documentNumber", "sheet"] });
    db.tables.assets = []; db.tables.document_assets = [];
    const { adoptDocument } = await import("@/lib/transitionIn");
    const adopt = (id: string) => adoptDocument({ orgId: ORG, projectId: "p1", docId: id, libraryId: "lib-dest", collectionId: null, newNumber: null, linkAssets: [], actorId: "ctl2", actorEmail: "a@x" });
    // SAF-12 (fix pass 3): while sheet0 — a LIVE P-100 — sits in ANOTHER
    // library, adopting a P-100 into lib-dest would make two sources of
    // truth for one number: refused, even though lib-dest numbers sheets
    const refused = await adopt(ids[0]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/collides with P-100 \(Rev —\) in another library — renumber it/);
    // once sheet 1 of the set lives in the destination, its siblings adopt beside it
    Object.assign(db.tables.documents.find((d) => d.id === "sheet0")!, { library_id: "lib-dest" });
    for (const id of ids) {
      const res = await adopt(id);
      expect(res.ok, res.error).toBe(true);
      expect(res.note).toMatch(/without a uniqueness key/);
    }
    expect(db.tables.documents.filter((d) => ids.includes(d.id)).map((d) => [d.library_id, d.uniqueness_key])).toEqual([["lib-dest", null], ["lib-dest", null]]);
  });
  it("a number + title library is still keyed and pre-checked in full at the door", async () => {
    seed({ doc: null });
    db.tables.libraries[0].uniqueness_keys = ["documentNumber", "title"];
    db.tables.documents = [{ id: "other", org_id: ORG, library_id: "lib1", uniqueness_key: "v-300::skid ga", status: "Issued" }];
    const res = await upload({ title: "Skid GA", number: "V-300" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("number_in_use");
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
  it("a WITHDRAWN earlier row (superseded_at stamped) is not 'already received' — the resend is taken", async () => {
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    seed({ doc: null });
    db.tables.documents = [{ id: "d-old", org_id: ORG, library_id: "lib1", current_version_id: null, pending_version_id: null, status: "Draft" }];
    db.tables.document_versions = [{ id: "v-withdrawn", org_id: ORG, record_id: "d-old", intake_link_id: LINK, file_hash: sha256Hex(PDF), review_state: "in_review", superseded_at: "2026-09-29T00:00:00Z", created_at: new Date().toISOString() }];
    const body = await (await upload({ title: "Skid GA" })).json();
    expect(body.duplicate).toBeUndefined();
    expect(body.status).toBe("in_review");
    expect(body.documentId).not.toBe("d-old");
    expect(db.r2Puts).toHaveLength(1);
  });
  it("the door's own lost pointer race RESOLVES the new version ('superseded'), so the contractor's resend of the same file is taken, not answered as a duplicate", async () => {
    seed({ link: { assigned_doc_ids: [D1], allow_auto_supersede: false }, doc: { authored_by_link_id: null } });
    db.errors["documents.update"] = [{ message: "could not serialize access" }];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lost = await upload({ docId: D1, revLabel: "C" });
    expect(lost.status).toBe(409);
    const withdrawn = db.tables.document_versions.find((v) => v.review_state !== "approved")!;
    expect(withdrawn).toMatchObject({ review_state: "superseded" });
    expect(withdrawn.superseded_at).toBeTruthy();
    const again = await (await upload({ docId: D1, revLabel: "C" })).json();
    expect(again.duplicate).toBeUndefined();
    expect(again.status).toBe("in_review");
    expect(db.tables.documents[0].pending_version_id).toBe(again.versionId);
    spy.mockRestore();
  });
  it("the same bytes LIVE on another document answer with a sentence — never that document's ids — and nothing is stored", async () => {
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    const D2 = "00000000-0000-4000-8000-0000000000d2";
    seed({ link: { assigned_doc_ids: [D2] }, doc: { pending_version_id: "v-on-A" }, versions: [
      { id: "v-cur", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "approved", created_at: "2026-09-01T00:00:00Z" },
      { id: "v-on-A", org_id: ORG, record_id: D1, intake_link_id: LINK, review_state: "in_review", file_hash: sha256Hex(PDF), created_at: new Date().toISOString() },
    ] });
    db.tables.documents.push({ id: D2, org_id: ORG, authored_by_link_id: null, document_number: "B-200", current_version_id: "v-b", pending_version_id: null, library_id: "lib1", collection_id: "col1", checked_out_by: null, legal_hold: false });
    const res = await upload({ docId: D2, revLabel: "C" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("same_file_in_review");
    expect(JSON.stringify(body)).not.toContain(D1);
    expect(JSON.stringify(body)).not.toContain("v-on-A");
    expect(db.r2Puts).toEqual([]);
  });
  it("a retry that lost the in-flight index answers with the original — and removes the document and the object it made", async () => {
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    seed({ doc: null });
    // The original: a new document still in its first review (sent before
    // the pre-check window, so only the index sees it).
    db.tables.documents = [{ id: "d-orig", org_id: ORG, library_id: "lib1", current_version_id: null, pending_version_id: "v-orig", status: "Draft" }];
    db.tables.document_versions = [{ id: "v-orig", org_id: ORG, record_id: "d-orig", intake_link_id: LINK, file_hash: sha256Hex(PDF), review_state: "in_review", superseded_at: null, created_at: "2026-01-01T00:00:00Z" }];
    db.errors["document_versions.insert"] = [{ code: "23505", message: 'duplicate key value violates unique constraint "document_versions_intake_inflight_uniq"' }];
    const res = await upload({ title: "Skid GA" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true, documentId: "d-orig", versionId: "v-orig", status: "in_review" });
    expect(db.writes.find((w) => w.table === "documents" && w.method === "delete")).toBeDefined();
    expect(db.tables.documents.map((d) => d.id)).toEqual(["d-orig"]); // no empty document left behind
    expect(db.r2Deletes.map((d) => d.Key)).toEqual([db.r2Puts[0].Key]);
    expect(db.tables.project_documents ?? []).toEqual([]);
    expect(db.emits).toEqual([]);
  });
  it("a numbered new document whose retry raced its original answers with the original, never 'number already in use'", async () => {
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    seed({ doc: null });
    db.tables.documents = [{ id: "d-orig", org_id: ORG, library_id: "lib1", uniqueness_key: "v-900", current_version_id: null, pending_version_id: "v-orig", status: "Draft" }];
    db.tables.document_versions = [{ id: "v-orig", org_id: ORG, record_id: "d-orig", intake_link_id: LINK, file_hash: sha256Hex(PDF), review_state: "in_review", superseded_at: null, created_at: "2026-01-01T00:00:00Z" }];
    // the pre-insert number check misses (the original committed after it)
    db.tables.documents[0].uniqueness_key = "other";
    const origInsert = db.writes.push.bind(db.writes);
    db.writes.push = (w) => { if (w.table === "documents" && w.method === "insert") db.errors["documents.insert"] = [{ code: "23505", message: 'duplicate key value violates unique constraint "documents_uniqueness_key_live_uniq"' }]; return origInsert(w); };
    const res = await upload({ title: "Skid GA", number: "V-900" });
    db.writes.push = origInsert;
    const body = await res.json();
    expect(body).toMatchObject({ duplicate: true, documentId: "d-orig" });
    expect(body.code).not.toBe("number_in_use");
    expect(db.r2Deletes).toHaveLength(1);
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
  it("a redline may be a phone photo or a scan: PNG and JPEG are accepted and stored as the sniffed image type", async () => {
    seed();
    const T = "00000000-0000-4000-8000-00000000cccc";
    db.tables.tickets = [{ id: T, org_id: ORG, ticket_id: "T-9", title: "Collision", attachments: [], history: [], metadata: { intake_collision: { intakeLinkId: LINK } } }];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
    expect((await upload({ ticketId: T }, { bytes: png, name: "markup.png", type: "image/png" })).status).toBe(200);
    expect((await upload({ ticketId: T }, { bytes: jpg, name: "photo.JPG", type: "image/jpeg" })).status).toBe(200);
    expect(db.r2Puts.map((p) => p.ContentType)).toEqual(["image/png", "image/jpeg"]);
    // a drawing submission still refuses an image
    const doc = await upload({ title: "Photo" }, { bytes: png, name: "markup.png", type: "image/png" });
    expect(doc.status).toBe(415);
  });
  it("a redline whose ticket update fails removes the object it stored", async () => {
    seed();
    const T = "00000000-0000-4000-8000-00000000dddd";
    db.tables.tickets = [{ id: T, org_id: ORG, ticket_id: "T-9", title: "Collision", attachments: [], history: [], metadata: { intake_collision: { intakeLinkId: LINK } } }];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.errors["tickets.update"] = [{ message: "boom" }];
    const res = await upload({ ticketId: T });
    expect(res.status).toBe(500);
    expect(db.r2Deletes.map((d) => d.Key)).toEqual([db.r2Puts[0].Key]);
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
  it("a controlled revision published without review is told even inside a burst's window (under the per-window cap)", async () => {
    seed();
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    db.tables.intake_attempts = [{ token_hash: sha256Hex(TOKEN), ip: "unknown", outcome: "notified", created_at: new Date().toISOString() }];
    expect((await (await upload({ docId: D1, revLabel: "C" })).json()).status).toBe("published");
    const told = db.emits.find((e) => e.kind === "doc_superseded") as Row & { audience: { involved: string[] } };
    expect(told).toBeDefined();
    expect(new Set(told.audience.involved)).toEqual(new Set(["creator1", "ctl2", "owner1"]));
  });
  it("SEC-8 dw2: a burst of trusted publishes is NOT one notice per upload — at most three notices per window; the rest are counted by kind into the next notice", async () => {
    seed();
    const { sha256Hex } = await import("@/lib/intakeRateLimit");
    db.tables.intake_attempts = [{ token_hash: sha256Hex(TOKEN), ip: "unknown", outcome: "notified", created_at: new Date().toISOString() }];
    for (const [i, rev] of ["C", "D", "E", "F"].entries()) {
      const b = await (await upload({ docId: D1, revLabel: rev }, { bytes: enc(`%PDF-1.7 rev ${rev} ${i}`), name: `${rev}.pdf` })).json();
      expect(b.status).toBe("published");
    }
    // one notice already in the window: two more go out, then the cap folds
    expect(db.emits.filter((e) => e.kind === "doc_superseded")).toHaveLength(2);
    expect(db.tables.intake_attempts.filter((a) => a.outcome === "suppressed_published")).toHaveLength(2);
    // the window passes; the next notice names what was folded, by kind
    for (const a of db.tables.intake_attempts) if (a.outcome === "notified") a.created_at = new Date(Date.now() - 20 * 60_000).toISOString();
    seed({ link: { assigned_doc_ids: [D1] }, doc: { authored_by_link_id: null } });
    db.tables.intake_attempts = [
      { token_hash: sha256Hex(TOKEN), ip: "unknown", outcome: "notified", created_at: new Date(Date.now() - 20 * 60_000).toISOString() },
      { token_hash: sha256Hex(TOKEN), ip: "unknown", outcome: "suppressed_published", created_at: new Date(Date.now() - 10 * 60_000).toISOString() },
      { token_hash: sha256Hex(TOKEN), ip: "unknown", outcome: "suppressed_published", created_at: new Date(Date.now() - 9 * 60_000).toISOString() },
    ];
    db.emits = [];
    await upload({ docId: D1, revLabel: "G" }, { bytes: enc("%PDF-1.7 rev G"), name: "g.pdf" });
    expect(String(db.emits[0].body)).toMatch(/2 more submissions arrived on this link since the last notice \(2 published without review\) — see the project's Intake tab\./);
  });
  it("a folded submission is COUNTED, and the next notice on the link says how many more arrived", async () => {
    seed({ doc: null });
    await upload({ title: "A" }, { bytes: enc("%PDF-1.7 a"), name: "a.pdf" });
    await upload({ title: "B" }, { bytes: enc("%PDF-1.7 b"), name: "b.pdf" });
    await upload({ title: "C" }, { bytes: enc("%PDF-1.7 c"), name: "c.pdf" });
    expect(db.emits).toHaveLength(1);
    expect(db.tables.intake_attempts.filter((a) => a.outcome === "suppressed")).toHaveLength(2);
    // the window passes
    for (const a of db.tables.intake_attempts) if (a.outcome === "notified") a.created_at = new Date(Date.now() - 20 * 60_000).toISOString();
    await upload({ title: "D" }, { bytes: enc("%PDF-1.7 d"), name: "d.pdf" });
    expect(db.emits).toHaveLength(2);
    expect(String(db.emits[1].body)).toMatch(/2 more submissions arrived on this link since the last notice — see the project's Intake tab\./);
    expect(String(db.emits[0].body)).not.toMatch(/more submission/);
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

// ── COST-12's intake limb and DEC-40 ────────────────────────────────────────
describe("what the door files where", () => {
  it("a quote is filed against the project party the link's company names (COST-12 intake limb)", async () => {
    seed({ link: { purpose: "quote" } });
    db.tables.project_parties = [
      { id: "party-1", org_id: ORG, project_id: "p1", name: "Vendor Co, Inc." },
      { id: "party-2", org_id: ORG, project_id: "p1", name: "Other Mechanical" },
      { id: "party-x", org_id: ORG, project_id: "p-other", name: "Vendor Co" },
    ];
    await upload({});
    expect(db.tables.cost_documents[0]).toMatchObject({ party_id: "party-1", vendor_name: "Vendor Co", kind: "quote" });
  });
  it("an ambiguous or unmatched company binds no party — and an unreadable party list never refuses the quote", async () => {
    seed({ link: { purpose: "quote" } });
    db.tables.project_parties = [
      { id: "party-1", org_id: ORG, project_id: "p1", name: "Vendor LLC" },
      { id: "party-2", org_id: ORG, project_id: "p1", name: "Vendor Incorporated" },
    ];
    await upload({});
    expect(db.tables.cost_documents[0]).toMatchObject({ party_id: null });
    seed({ link: { purpose: "quote" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.errors["project_parties.select"] = [{ message: "boom" }];
    const res = await upload({}, { bytes: enc("%PDF-1.7 another quote"), name: "q.pdf" });
    expect(res.status).toBe(200);
    expect(db.tables.cost_documents[0]).toMatchObject({ party_id: null });
    spy.mockRestore();
  });
  it("a document the door CREATES is referenced from the project (DEC-40: project_documents, never a copy); a revision writes none", async () => {
    seed({ doc: null });
    const body = await (await upload({ title: "Skid GA" })).json();
    expect(db.tables.project_documents).toEqual([expect.objectContaining({ org_id: ORG, project_id: "p1", document_id: body.documentId, source: "manual" })]);
    seed({ link: { assigned_doc_ids: [D1] }, doc: { authored_by_link_id: null } });
    db.tables.project_documents = [];
    await upload({ docId: D1, revLabel: "C" });
    expect(db.tables.project_documents).toEqual([]);
  });
});

// ── INTK-2 dw3: every writer of documents.current_version_id ────────────────
// A census PER CALL SITE (TypeScript's parser, not a regex over the file):
// every `.update(…)` / `.insert(…)` / `.upsert(…)` whose argument sets
// `current_version_id` to anything but null — an inline literal, a
// `{ current_version_id }` shorthand, a spread, or a patch object built
// earlier in the same function (`const patch = { … }`, `patch.current_version_id
// = …`) — and every call of an RPC that moves the pointer in the database
// (`.rpc("publish_revision", …)`, or a call of a pinned wrapper of it) must
// run `runPostPublishSideEffects` in the SAME function — a real CALL, found
// in the syntax tree (a comment or a string naming it does not count) — or
// be pinned below by file:function with the reason it is exempt. A new
// writer anywhere, or a new pointer write added to an exempt function's file
// under another name, fails the build.
const KEY = "current_version_id";
/** SQL functions that set documents.current_version_id themselves. */
const POINTER_RPCS = new Set(["publish_revision"]);
type Writer = { site: string; method: string; line: number; pipeline: boolean };
/** Does this function CALL the pipeline? Syntax-tree calls only. */
function callsPipeline(body: ts.Node | null): boolean {
  if (!body) return false;
  let hit = false;
  const scan = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if ((ts.isIdentifier(callee) && callee.text === "runPostPublishSideEffects")
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === "runPostPublishSideEffects")) { hit = true; return; }
    }
    ts.forEachChild(n, scan);
  };
  scan(body);
  return hit;
}
function enclosingFn(node: ts.Node): { name: string; body: ts.Node | null } {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return { name: n.name.getText(), body: n };
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return { name: p.name.text, body: n };
      if (ts.isPropertyAssignment(p)) return { name: p.name.getText(), body: n };
    }
  }
  return { name: "<module>", body: null };
}
function literalSetsKey(obj: ts.ObjectLiteralExpression, scope: ts.Node): boolean {
  return obj.properties.some((pr) => {
    if (ts.isShorthandPropertyAssignment(pr)) return pr.name.text === KEY;
    if (ts.isPropertyAssignment(pr)) {
      const name = ts.isIdentifier(pr.name) || ts.isStringLiteral(pr.name) ? pr.name.text : null;
      return name === KEY && pr.initializer.kind !== ts.SyntaxKind.NullKeyword;
    }
    if (ts.isSpreadAssignment(pr)) return argSetsKey(pr.expression, scope);
    return false;
  });
}
function argSetsKey(arg: ts.Expression | undefined, scope: ts.Node): boolean {
  if (!arg) return false;
  if (ts.isObjectLiteralExpression(arg)) return literalSetsKey(arg, scope);
  if (ts.isArrayLiteralExpression(arg)) return arg.elements.some((e) => argSetsKey(e as ts.Expression, scope));
  if (ts.isParenthesizedExpression(arg) || ts.isAsExpression(arg)) return argSetsKey(arg.expression, scope);
  if (!ts.isIdentifier(arg)) return false;
  // A patch object: its declaration in scope, or a later assignment to its key.
  const name = arg.text;
  let hit = false;
  const scan = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && ts.isObjectLiteralExpression(n.initializer) && literalSetsKey(n.initializer, scope)) hit = true;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.right.kind !== ts.SyntaxKind.NullKeyword) {
      const l = n.left;
      if (ts.isPropertyAccessExpression(l) && l.name.text === KEY && l.expression.getText() === name) hit = true;
      if (ts.isElementAccessExpression(l) && l.expression.getText() === name && ts.isStringLiteral(l.argumentExpression) && l.argumentExpression.text === KEY) hit = true;
    }
    if (ts.isCallExpression(n) && n.expression.getText() === "Object.assign" && n.arguments[0]?.getText() === name
        && n.arguments.slice(1).some((a) => ts.isObjectLiteralExpression(a) && literalSetsKey(a, scope))) hit = true;
    ts.forEachChild(n, scan);
  };
  scan(scope);
  return hit;
}
function pointerWriters(file: string, src: string, rpcWrappers: ReadonlySet<string> = new Set()): Writer[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Writer[] = [];
  const push = (node: ts.CallExpression, method: string) => {
    const { name, body } = enclosingFn(node);
    out.push({ site: `${file}:${name}`, method, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, pipeline: callsPipeline(body) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["update", "insert", "upsert"].includes(node.expression.name.text)) {
      const { body } = enclosingFn(node);
      if (argSetsKey(node.arguments[0], body ?? sf)) push(node, node.expression.name.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "rpc"
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && POINTER_RPCS.has(node.arguments[0].text)) {
      push(node, `rpc ${node.arguments[0].text}`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && rpcWrappers.has(node.expression.text)) {
      push(node, `rpc via ${node.expression.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("census — every writer of current_version_id runs the post-publish pipeline", () => {
  const ROOTS = ["app", "lib", "components"];
  // Pinned exemptions, by file:function, each with its reason. Remove an
  // entry when its function runs the pipeline (or stops writing the pointer).
  const EXEMPT: Record<string, { reason: string; via?: string; wrapper?: boolean }> = {
    "lib/revisions.ts:callPublishRevisionRpc": { reason: "the one wrapper of rpc('publish_revision') in lib/revisions.ts — every call of it is censused as a writer in its caller", wrapper: true },
    "app/api/intake/upload/route.ts:publishThroughContract": { reason: "the intake door's trusted promote — POST runs the pipeline after it returns a published outcome", via: "app/api/intake/upload/route.ts:POST" },
    "lib/revisions.ts:createDocumentWithFile": { reason: "first-version seed of a brand-new document — nothing is superseded; the review clock and ack roster are seeded inline" },
    "lib/documentLifecycle/common.ts:createNewDocWithFirstVersion": { reason: "first-version seed of a split / merge sheet — nothing is superseded by the pointer write itself; the review clock and ack roster it does NOT start are open finding document-control REV-15 (unassigned)" },
    "app/(protected)/documents/[libraryId]/page.tsx:uploadOne": { reason: "first-version seed of a bulk upload — the review clock and ack roster it does NOT start are open finding document-control REV-15 (unassigned; the library page's half)" },
  };
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "__tests__") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
  const sources = new Map(ROOTS.flatMap((r) => walk(join(process.cwd(), r)))
    .map((p) => [relative(process.cwd(), p).split("\\").join("/"), readFileSync(p, "utf8")] as const)
    .filter(([, src]) => src.includes(KEY) || [...POINTER_RPCS].some((f) => src.includes(f))));
  // A pinned wrapper of a pointer RPC makes every call of it a writer site.
  const wrappers = new Set(Object.entries(EXEMPT).filter(([, e]) => e.wrapper).map(([site]) => site.split(":")[1]));
  const writers = [...sources].flatMap(([file, src]) => pointerWriters(file, src, wrappers));
  // INTK-15 (J11): the intake route's POST is a thin wrapper that removes a
  // direct upload's staged object when the request ends; the door's body —
  // the caller of publishThroughContract that runs the pipeline — is `door`.
  // (Pinned here, apart from the table above, so the table's own edits merge.)
  EXEMPT["app/api/intake/upload/route.ts:publishThroughContract"] = {
    reason: "the intake door's trusted promote — door (POST's body) runs the pipeline after it returns a published outcome",
    via: "app/api/intake/upload/route.ts:door",
  };

  it("the detector sees inline, shorthand, spread and prebuilt-patch writes — and ignores clears and reads", () => {
    const probe = (body: string) => pointerWriters("probe.ts", `async function f(v: string, supabase: any) {\n${body}\n}`).length;
    expect(probe(`await supabase.from("documents").update({ current_version_id: v });`)).toBe(1);
    expect(probe(`const current_version_id = v; await supabase.from("documents").update({ current_version_id });`)).toBe(1);
    expect(probe(`const patch = { current_version_id: v, rev: "B" }; await supabase.from("documents").update(patch);`)).toBe(1);
    expect(probe(`const patch: Record<string, unknown> = {}; patch.current_version_id = v; await supabase.from("documents").update(patch);`)).toBe(1);
    expect(probe(`const base = { current_version_id: v }; await supabase.from("documents").update({ ...base, updated_at: "x" });`)).toBe(1);
    expect(probe(`const patch = {}; Object.assign(patch, { current_version_id: v }); await supabase.from("documents").update(patch);`)).toBe(1);
    expect(probe(`await supabase.from("documents").update({ current_version_id: null });`)).toBe(0);
    expect(probe(`const { data } = await supabase.from("documents").select("current_version_id"); await supabase.from("x").update({ id: data.current_version_id ? 1 : 0 });`)).toBe(0);
    // an RPC that moves the pointer in the database is a writer too; another RPC is not
    expect(probe(`await supabase.rpc("publish_revision", { p_doc: v });`)).toBe(1);
    expect(probe(`await supabase.rpc("review_control_mode_for", {});`)).toBe(0);
    expect(pointerWriters("probe.ts", `async function g(v: string) { await callPublishRevisionRpc({ p_doc: v }); }`, new Set(["callPublishRevisionRpc"]))).toHaveLength(1);
    // only a real CALL of the pipeline satisfies the census — never a comment or a string naming it
    const piped = (body: string) => pointerWriters("probe.ts", `async function f(v: string, supabase: any) {\n${body}\n}`)[0]?.pipeline;
    expect(piped(`await supabase.rpc("publish_revision", {}); await runPostPublishSideEffects({});`)).toBe(true);
    expect(piped(`await supabase.rpc("publish_revision", {}); const { runPostPublishSideEffects: run } = await import("x"); await mod.runPostPublishSideEffects({});`)).toBe(true);
    expect(piped(`await supabase.rpc("publish_revision", {}); // then runPostPublishSideEffects(input) — someday`)).toBe(false);
    expect(piped(`await supabase.rpc("publish_revision", {}); const note = "runPostPublishSideEffects(";`)).toBe(false);
  });
  it("finds the known writers (the census is not vacuous)", () => {
    const sites = new Set(writers.map((w) => w.site));
    // (REV-8 retired lib/revisions.ts:legacyRevUpAfterUpload — the legacy leg no longer exists)
    for (const s of ["lib/reviewControl.ts:finalizeReviewedRevision", "lib/revisions.ts:revertToVersion", "lib/documentLifecycle/common.ts:createNewDocWithFirstVersion",
      "lib/revisions.ts:callPublishRevisionRpc", "app/api/intake/upload/route.ts:publishThroughContract"]) {
      expect(sites.has(s), s).toBe(true);
    }
  });
  it("every writer runs the pipeline in the same function, or is pinned with its reason", () => {
    const unpiped = writers.filter((w) => !w.pipeline && !EXEMPT[w.site]).map((w) => `${w.site} (${w.method}, line ${w.line})`);
    expect(unpiped, `current_version_id written without runPostPublishSideEffects in the same function: ${unpiped.join("; ")}`).toEqual([]);
  });
  it("no pinned exemption is stale, and an exemption 'via' a caller is honoured by that caller", () => {
    const sites = new Set(writers.map((w) => w.site));
    for (const [site, e] of Object.entries(EXEMPT)) {
      expect(sites.has(site), `stale exemption: ${site} no longer writes the pointer — remove it`).toBe(true);
      if (e.wrapper) {
        // a wrapper's callers are censused — there must be some, each seen as a writer
        const name = site.split(":")[1];
        expect(writers.some((w) => w.method === `rpc via ${name}`), `${site}: no censused caller`).toBe(true);
      }
      if (e.via) {
        const [viaFile, viaFn] = e.via.split(":");
        const sf = ts.createSourceFile(viaFile, sources.get(viaFile) ?? "", ts.ScriptTarget.Latest, true);
        let fn: ts.Node | null = null;
        sf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === viaFn) fn = n; });
        const callee = site.split(":")[1];
        expect((fn as ts.Node | null)?.getText() ?? "", `${e.via} must call ${callee}`).toMatch(new RegExp(`\\b${callee}\\(`));
        expect(callsPipeline(fn), `${e.via} must run the pipeline`).toBe(true);
      }
    }
  });
  it("the intake route no longer writes the pointer itself — it publishes through the contract and runs the pipeline", () => {
    const r = readFileSync(join(process.cwd(), "app/api/intake/upload/route.ts"), "utf8");
    // its only pointer mover is the contract RPC in publishThroughContract (pinned, via POST)
    expect(pointerWriters("app/api/intake/upload/route.ts", r).map((w) => `${w.site} ${w.method}`)).toEqual(["app/api/intake/upload/route.ts:publishThroughContract rpc publish_revision"]);
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
  it("a link the database no longer holds (the project-delete trigger deleted it) answers notfound WITH the definite sentence (PM-2 dw2)", async () => {
    seed();
    db.tables.project_intake_links = [];
    const res = await resolve();
    expect(res.status).toBe(404);
    const { LINK_INVALID_MESSAGE } = await import("@/lib/intakeLinks");
    expect(await res.json()).toEqual({ error: "notfound", message: LINK_INVALID_MESSAGE });
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
    // a policy that resolves NOBODY opens no roster — say so, never "sent to
    // its reviewers" (which looped every later Approve on the same prompt)
    const afterOpen = approve.slice(approve.indexOf("await openReviewRoster({"));
    expect(afterOpen).toMatch(/const opened = await listDraftRoster\(p\.docId, p\.pendingVersionId\);\s*\n[\s\S]*?setMsg\(hasPrimary\(opened\)/);
    expect(afterOpen).toContain("No reviewer could be resolved for ${p.label}'s library — set its reviewers before this submission can be approved.");
    expect(approve).toContain('rows.some((r) => r.slot === "primary")');
    expect(approve).toMatch(/requireRosterComplete: rosterRequired,/);
    expect(approve).not.toMatch(/requireRosterComplete: false/);
    expect(approve).toMatch(/await effectiveDocClassForDocument\(/);
    expect(approve).toMatch(/\.update\(\{ moc_reference: moc\.trim\(\) \}\)/);
    // SEC-14 on the roster path too: the MOC is captured BEFORE the roster
    // opens (the review panel that publishes later has no MOC prompt)
    expect(approve.indexOf("await effectiveDocClassForDocument(")).toBeLessThan(approve.indexOf("await openReviewRoster({"));
    expect(approve.indexOf(".update({ moc_reference: moc.trim() })")).toBeLessThan(approve.indexOf("await openReviewRoster({"));
    // SEC-13: the roster's sign-offs are bound to the submitted bytes
    expect(approve).toContain('.select("moc_reference, file_hash").eq("id", p.pendingVersionId)');
    expect(approve).toContain("contentHash: ((ver as { file_hash?: string | null } | null)?.file_hash ?? null),");
    expect(approve).not.toContain("contentHash: null");
    expect(approve).toContain("it publishes when the last of them signs off on the document's review panel (in the document library), not from this tab.");
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
    // SEC-5: the picker's dates are LOCAL calendar dates (a UTC date is a day
    // ahead west of UTC in the evening and offered a 91-day "maximum")
    expect(p).toContain("d.setDate(d.getDate() + days);");
    expect(p).not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
    expect(p).toContain("min={isoDateInDays(0)} max={isoDateInDays(INTAKE_LINK_MAX_DAYS)}");
  });
  it("TransitionInPanel: adopt controls for the controller tier only; a collision or an unapproved sheet cannot be adopted (SAF-13 / SAF-12 / INTK-3)", () => {
    const t = src("components/projects/TransitionInPanel.tsx");
    expect(t).toContain("const canAdopt = canManage && isControllerPrincipal({ role: activeRole, roles });");
    expect(t).toMatch(/disabled=\{busy === c\.docId \|\| !destLib \|\| candidateInReview\(c\) \|\| \(blocksOnNumber\(impact\) && !\(renumber\.get\(c\.docId\) \?\? ""\)\.trim\(\)\)\}/);
    // INTK-5: a same number inside a multi-part destination is expected;
    // SAF-12 (fix pass 3): one in ANOTHER library still blocks — the gate is
    // the lib's blockingNumberCollision, judged against the picked destination
    expect(t).toContain("const numberDecides = numberIsTheKey(libs.find((l) => l.id === destLib)?.uniqueness_keys ?? null);");
    expect(t).toContain("const blockingCollider = (impact: TransitionImpact | undefined) => blockingNumberCollision(impact, destLib || null, numberDecides);");
    expect(t).toContain("const blocksOnNumber = (impact: TransitionImpact | undefined) => !!blockingCollider(impact);");
    expect(t).not.toContain("!!impact?.numberCollision && numberDecides");
    // the "shared number is expected" sentence only when nothing blocks
    expect(t).toMatch(/\{blocking\s*\? "Renumber this sheet below[^"]*"\s*: "It is a sheet of the destination library, which numbers sheets separately/);
    expect(t).toContain('supabase.from("libraries").select("id, name, uniqueness_keys")');
    // INTK-3 dw2 (fix pass 3): an approved sheet with a newer submission in
    // review (pendingReview) is never clean, counted, bulk-adopted or offered
    expect(t).toContain("const bulkable = (c: TransitionCandidate) => !candidateInReview(c) && !!impacts.get(c.docId)?.clean;");
    expect(t).toContain("() => candidates.filter((c) => !candidateInReview(c) && !!impacts.get(c.docId)?.clean).length,");
    expect(t).toContain("return candidateInReview(c) || (i && !i.clean);");
    expect(t).toContain("{impact?.clean && !candidateInReview(c) && <span");
    expect(t).toContain('{candidateInReview(c) && <span className="text-[10px] font-bold text-amber-700 dark:text-amber-400">{c.pendingRetired ? "stuck" : c.pendingReview ? "in review" : "not approved"}</span>}');
    // verification fix: a pending pointer on a RETIRED draft is never sent to
    // the review queue (the queue lists in-review drafts only) — the note and
    // the Adopt title come from the lib, which says Document Control clears it
    expect(t).toContain("{candidateReviewNote(c)}");
    expect(t).not.toContain("— approve or reject it in the review queue above before it can be adopted.");
    expect(t).toContain('candidateInReview(c) ? (c.pendingRetired ? "Document Control must clear its retired pending revision first" : "Approve or reject the submission first")');
    expect(t).not.toMatch(/!c\.awaitingReview && !!impacts/);
    expect(t).toContain("const clean = candidates.filter(bulkable);");
  });
  it("the portal sends the token in a header, renders a reference, a gone link, a closed project and a rejection reason", () => {
    const s = src("app/submit/[token]/page.tsx");
    expect(s).toContain("const headers: Record<string, string> = { [INTAKE_TOKEN_HEADER]: token };");
    expect(s).not.toMatch(/form\.set\("token"/);
    expect(s).toContain('${body.ref ? ` (reference ${body.ref})` : ""}');
    expect(s).toContain('state === "link_gone" ? LINK_GONE_MESSAGE');
    expect(s).toContain('state === "project_closed" ? PROJECT_CLOSED_MESSAGE');
    // PM-2 dw2: a link the database no longer holds is answered definitely
    expect(s).toContain('state === "notfound" ? LINK_INVALID_MESSAGE');
    expect(s).not.toContain("it may have been mistyped.\"");
    expect(s).toContain('accept=".pdf,.dwg,.dxf,.zip,.png,.jpg,.jpeg"');
    expect(s).toContain("Reviewer&apos;s reason: {i.rejectionReason}");
    expect(s).not.toMatch(/`HTTP \$\{res\.status\}`/);
  });
  it("the maintenance cron gains ONE intake step (prune + orphan health) and no new cron entry", () => {
    const c = src("app/api/cron/maintenance/route.ts");
    expect((c.match(/sb\.rpc\("prune_intake_attempts"\)/g) ?? []).length).toBe(1);
    expect(c).toMatch(/sb\.rpc\("orphaned_in_review_versions_count"\)/);
    // the remedy it names is one a person can run — no screen lists a version nothing points at
    expect(c).toContain("that no document points at and nothing withdrew — a document controller must resolve each one");
    expect(c).not.toMatch(/resolve them from the Intake tab/);
    // INTK-4 (fix pass 3): a pending pointer on a retired draft is counted
    // from STATE on every run until 0 — not from a 25-hour audit window
    expect(c).toMatch(/sb\.rpc\("pending_on_retired_version_count"\)/);
    expect(c).not.toContain('.eq("action", "INTAKE_DISPLACE_UNRESOLVED").gte("timestamp", since)');
    expect(c).toContain("document(s) whose pending revision names a retired draft");
    // INTK-10 / SEC-8 (fix pass 3): folded publishes a quiet link never
    // announced get one digest per link, request-scoped service role, drained at 6c
    expect(c).toMatch(/import \{\n\s+flushFoldedIntakeNotices, deliverFoldedDigest, foldedDigestKind, foldedDigestMetadata,/);
    // verification fix (item 1): the digest's send REPORTS what landed — the
    // bell rows are inserted and checked by deliverFoldedDigest; emit() is
    // the email leg only (it swallows its failures, so it cannot report)
    expect(c).toMatch(/const flushed = await flushFoldedIntakeNotices\(sb, \{\n\s+send: \(d\) => deliverFoldedDigest\(sb, d, \(dd\) => runWithServerClient\(sb, \(\) => emit\(\{/);
    expect(c).toContain("audience: { involved: dd.involved, followers: false },");
    expect(c).toContain('channels: ["email"],');
    // item 2: one digest per project, keyed on the project
    expect(c).toContain('resource: { type: "project", id: dd.projectId }, actorName: dd.actorName,');
    expect(c).toContain("if (flushed.unrecorded > 0) {");
    expect(c.indexOf("flushFoldedIntakeNotices(sb")).toBeLessThan(c.indexOf("// 6c. Drain anything"));
    // item 3: every intake line is logged (the cron's log shows console
    // output, not the JSON body); an RPC error is reported unless the
    // function does not exist yet — never matched on the function's name
    expect(c).toContain("const intakeLine = (line: string) => { result.errors.push(line); console.error(`[cron/maintenance] ${line}`); };");
    expect(c).not.toMatch(/result\.errors\.push\(`review-health:/);
    expect(c).not.toMatch(/if \(!orphanErr\) \{|if \(!stuckErr\) \{/);
    expect(c).toContain("if (!isMissingFunction(orphanErr)) intakeLine(`intake-door: health count unavailable (orphaned_in_review_versions_count)");
    expect(c).toContain("if (!isMissingFunction(stuckErr)) intakeLine(`intake-door: health count unavailable (pending_on_retired_version_count)");
    expect(c).toContain("if (!isMissingFunction(pruneErr)) intakeLine(`intake-attempts: ${pruneErr.message}`);");
    expect(c).not.toMatch(/prune_intake_attempts\|PGRST202/);
    // …and a per-org nudge to each controller pool, once a day, through emit()
    expect(c).toMatch(/sb\.rpc\("intake_review_health_by_org"\)/);
    expect(c).toContain("const nudged = await nudgeReviewHealth(sb, {");
    expect(c).toContain('audience: { roles: ["Admin", "DocCtrl"] },');
    // second verification: a NULL org is kept NULL (never the string "null") and reported, not nudged
    expect(c).toContain("orgId: r.org_id == null ? null : String(r.org_id),");
    expect(c).toContain("if (nudged.orgless > 0) intakeLine(`review-health: ${nudged.orgless} group(s) of rows name no org");
    const vercel = JSON.parse(src("vercel.json")) as { crons?: unknown[] };
    expect((vercel.crons ?? []).length).toBeLessThanOrEqual(2);
  });
});

// ── INTK-15 (projects Round G J11): the direct door ─────────────────────────
// The portal sends the bytes straight to storage on a PUT the door presigned
// for the link's own staging key; finalize sniffs the STORED bytes (a ranged
// read first) and from there runs exactly the multipart pipeline. Every J1
// guarantee is asserted through the finalize step. Staging
// (lib/intakeStaging.ts): a begin RESERVES its declared bytes against the
// link's budget; a finalize CLAIMS the reservation before any other answer
// and then owns — and deletes — the staged object, whatever it answers.
describe("INTK-15 — the direct door: begin presigns, finalize checks the stored bytes", () => {
  const STAGING = "intake-staging/o1/p1/lnk1/";
  const HASH = createHash("sha256").update(TOKEN).digest("hex");
  const json = (step: "begin" | "finalize", payload: Row, headers: Record<string, string> = {}) => POST(new NextRequest(
    `http://x/api/intake/upload?step=${step}`,
    { method: "POST", body: JSON.stringify(payload), headers: { "x-intake-token": TOKEN, "content-type": "application/json", ...headers } },
  ));
  /** begin, then "PUT" the bytes to the staged key the door chose. */
  const stage = async (bytes: Uint8Array, name = "sheet.pdf", type = "application/pdf") => {
    const res = await json("begin", { fileName: name, size: bytes.byteLength, contentType: type });
    const body = await res.json() as { ok: boolean; uploadKey: string; uploadUrl: string; contentType: string; expiresIn: number };
    db.r2Objects.set(body.uploadKey, bytes);
    return { res, body };
  };
  const finalize = (uploadKey: string, fields: Record<string, string>, name = "sheet.pdf", type = "application/pdf") =>
    json("finalize", { uploadKey, fileName: name, contentType: type, fields });
  /** A staged object and its reservation, as a begin leaves them. */
  const reserve = (id: string, bytes: Uint8Array | null, over: Row = {}) => {
    (db.tables.intake_attempts ??= []).push({ id, token_hash: HASH, ip: "unknown", link_id: LINK, outcome: "staged", bytes: bytes?.byteLength ?? 100, created_at: new Date().toISOString(), ...over });
    if (bytes) db.r2Objects.set(`${STAGING}${id}`, bytes);
    return `${STAGING}${id}`;
  };
  const rows = (outcome: string) => (db.tables.intake_attempts ?? []).filter((a) => a.outcome === outcome);
  const deleted = () => db.r2Deletes.map((d) => String(d.Key));

  it("begin: the credential first; a PUT presigned for a FRESH key under the link's own prefix of the ONE staging root, Content-Length signed to the declared size, 10 minutes, never cached — the declared size reserved, nothing stored, nothing filed", async () => {
    seed({ doc: null });
    const { res, body } = await stage(PDF);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.uploadKey.startsWith(STAGING)).toBe(true);
    const id = body.uploadKey.slice(STAGING.length);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.presigns).toHaveLength(1);
    expect(db.presigns[0].input).toMatchObject({ Key: body.uploadKey, ContentLength: PDF.byteLength, ContentType: "application/octet-stream" });
    expect([...(db.presigns[0].opts.signableHeaders as Set<string>)].sort()).toEqual(["content-length", "content-type"]);
    expect(db.presigns[0].opts.expiresIn).toBe(600);
    expect(body.contentType).toBe("application/octet-stream");
    // the reservation: the staged object's id, the link, the declared bytes
    expect(rows("staged")).toEqual([expect.objectContaining({ id, token_hash: HASH, link_id: LINK, bytes: PDF.byteLength })]);
    expect(db.r2Puts).toEqual([]);
    expect(docWrites()).toEqual([]);
    // a second begin is a different key
    const again = await stage(PDF);
    expect(again.body.uploadKey).not.toBe(body.uploadKey);
  });

  it("begin refuses what the door refuses — a bad token, a revoked link, a closed project, a size over the limit or the budget — and presigns nothing", async () => {
    seed({ doc: null });
    expect((await json("begin", { size: 10 }, { "x-intake-token": "short" })).status).toBe(400);
    seed({ doc: null, link: { revoked_at: "2026-09-01T00:00:00Z" } });
    expect((await json("begin", { size: 10 })).status).toBe(410);
    seed({ doc: null });
    db.tables.projects[0].status = "completed";
    expect((await json("begin", { size: 10 })).status).toBe(410);
    seed({ doc: null });
    expect((await json("begin", { size: 100 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await json("begin", { size: 0 })).status).toBe(400);
    seed({ doc: null, link: { bytes_received: 5 * 1024 ** 3 - 10 } });
    const over = await json("begin", { size: 1000 });
    expect(over.status).toBe(429);
    expect((await over.json()).code).toBe("link_budget");
    expect(db.presigns).toEqual([]);
    expect(rows("staged")).toEqual([]);
  });

  it("INTK-8 on the direct path: staged-but-unclaimed bytes count against the link's budget — a link cannot stage past it by never finalizing; a claim releases its reservation", async () => {
    seed({ doc: null, link: { bytes_received: 5 * 1024 ** 3 - 150 } });
    const first = await json("begin", { size: 100 });
    expect(first.status).toBe(200);
    // the first 100 bytes are reserved: a second 100 would pass the old check (bytes_received alone) but not this one
    const second = await json("begin", { size: 100 });
    expect(second.status).toBe(429);
    expect((await second.json()).code).toBe("link_budget");
    expect(db.presigns).toHaveLength(1);
    // the first is finalized (here: its claim) — its reservation is released
    const key = String((await first.json()).uploadKey);
    db.r2Objects.set(key, PDF.subarray(0, 0));   // an empty PUT: refused after the claim
    expect((await finalize(key, { title: "x" })).status).toBe(400);
    expect(rows("staged")).toEqual([]);
    expect((await json("begin", { size: 100 })).status).toBe(200);
  });

  it("an abandoned begin stops counting once it is swept: the link's next begin removes its expired reservations — the object first, then the row", async () => {
    seed({ doc: null, link: { bytes_received: 5 * 1024 ** 3 - 150 } });
    const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const staleKey = reserve("00000000-0000-4000-8000-0000000000e1", PDF, { bytes: 140, created_at: old });
    const res = await json("begin", { size: 100 });
    expect(res.status).toBe(200);
    expect(deleted()).toEqual([staleKey]);
    expect(db.r2Objects.has(staleKey)).toBe(false);
    expect(rows("staged").map((r) => r.id)).not.toContain("00000000-0000-4000-8000-0000000000e1");
  });

  it("begin is the upload's attempt; finalize is counted in its OWN window (per token and per IP) — never unthrottled", async () => {
    seed({ doc: null });
    const { body } = await stage(PDF);
    expect(rows("attempt")).toHaveLength(1);
    const res = await finalize(body.uploadKey, { title: "Skid GA" });
    expect(res.status).toBe(200);
    expect(rows("attempt")).toHaveLength(1);
    expect(rows("finalize")).toEqual([expect.objectContaining({ token_hash: HASH })]);
    // a full attempt window refuses the BEGIN …
    db.tables.intake_attempts = Array.from({ length: 30 }, () => ({ token_hash: HASH, ip: "unknown", outcome: "attempt", created_at: new Date().toISOString() }));
    expect((await json("begin", { size: 10 })).status).toBe(429);
    // … a full finalize window refuses a FINALIZE before the link is even read — guessing through ?step=finalize is throttled too
    db.tables.intake_attempts = Array.from({ length: 30 }, () => ({ token_hash: HASH, ip: "unknown", outcome: "finalize", created_at: new Date().toISOString() }));
    db.r2Reads = [];
    const key = reserve("00000000-0000-4000-8000-0000000000f1", PDF);
    const limited = await finalize(key, { title: "x" });
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe("rate_limited");
    db.tables.intake_attempts = Array.from({ length: 60 }, (_, i) => ({ token_hash: `h${i}`, ip: "203.0.113.9", outcome: "finalize", created_at: new Date().toISOString() }));
    const perIp = await json("finalize", { uploadKey: key }, { "x-forwarded-for": "203.0.113.9" });
    expect(perIp.status).toBe(429);
    expect((await perIp.json()).error).toMatch(/from your network/);
    expect(db.r2Reads).toEqual([]);
  });

  it("finalize files a new document exactly as the multipart door does — sniffed type, the link's authorship, review — from the STORED bytes; the staged object is removed", async () => {
    seed({ doc: null });
    const { body } = await stage(PDF, "skid.pdf", "application/octet-stream");
    const res = await finalize(body.uploadKey, { title: "Skid GA", number: "V-300" }, "skid.pdf", "application/octet-stream");
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.status).toBe("in_review");
    // the sniff read a RANGE of the stored object before the whole of it
    expect(db.r2Reads.map((r) => `${r.op}${r.range ? ` ${r.range}` : ""}`)).toEqual(["head", "get bytes=0-63", "get"]);
    // stored under the door's own key with the SNIFFED type — never the staged key
    expect(db.r2Puts).toHaveLength(1);
    expect(db.r2Puts[0]).toMatchObject({ ContentType: "application/pdf" });
    expect(String(db.r2Puts[0].Key)).toMatch(/^orgs\/o1\/project-intake\/p1\/[0-9a-f-]{36}-skid\.pdf$/);
    expect(db.tables.documents.find((d) => d.id === out.documentId)).toMatchObject({ authored_by_link_id: LINK, uniqueness_key: "v-300" });
    expect(deleted()).toEqual([body.uploadKey]);
    expect(db.r2Objects.has(body.uploadKey)).toBe(false);
    expect(rows("staged")).toEqual([]);
  });

  it("finalize refuses (and deletes) a disallowed type sniffed from the STORED bytes — an HTML file named .pdf never reaches storage under a door key", async () => {
    seed({ doc: null });
    const html = enc("<!doctype html><script>alert(1)</script>");
    const { body } = await stage(html, "drawing.pdf", "application/pdf");
    const res = await finalize(body.uploadKey, { title: "Skid GA" }, "drawing.pdf", "application/pdf");
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe("file_type");
    // only the head was read — the rest of the object never was
    expect(db.r2Reads.filter((r) => r.op === "get").map((r) => r.range)).toEqual(["bytes=0-63"]);
    expect(db.r2Puts).toEqual([]);
    expect(docWrites()).toEqual([]);
    expect(deleted()).toEqual([body.uploadKey]);
  });

  it("the bytes filed are the bytes sniffed: a re-PUT between the head and the full read is refused (If-Match on the HEAD's ETag) — and so is a full read whose head differs, should storage ignore If-Match", async () => {
    seed({ doc: null });
    const pdfish = enc("%PDF-1.7\n" + "x".repeat(80));
    const html = enc("<!doctype html>" + "y".repeat(pdfish.byteLength - 15));
    expect(html.byteLength).toBe(pdfish.byteLength);
    const { body } = await stage(pdfish);
    db.afterGet = (key, range) => { if (range) db.r2Objects.set(key, html); };
    const res = await finalize(body.uploadKey, { title: "Skid GA" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("upload_changed");
    expect(db.r2Puts).toEqual([]);
    expect(docWrites()).toEqual([]);
    expect(deleted()).toEqual([body.uploadKey]);
    // a storage that does not honour If-Match: the full read's head is compared with the sniffed one
    seed({ doc: null });
    db.r2Puts = []; db.r2Deletes = []; db.ignoreIfMatch = true;
    const again = await stage(pdfish);
    db.afterGet = (key, range) => { if (range) db.r2Objects.set(key, html); };
    const res2 = await finalize(again.body.uploadKey, { title: "Skid GA" });
    expect(res2.status).toBe(409);
    expect(db.r2Puts).toEqual([]);
    expect(deleted()).toEqual([again.body.uploadKey]);
  });

  it("finalize runs the trusted publish contract and the post-publish pipeline under the service role, as the multipart door does", async () => {
    seed();
    const { body } = await stage(DWG, "skid.dwg", "application/acad");
    const res = await finalize(body.uploadKey, { docId: D1, revLabel: "C" }, "skid.dwg", "application/acad");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("published");
    expect(published()?.args).toMatchObject({ p_doc: D1, p_actor: "creator1" });
    expect(db.pipeline).toHaveLength(1);
    expect(db.pipeline[0].boundToServiceRole).toBe(true);
  });

  it("a retry of the same bytes through finalize answers with the original, and the second staged copy is removed", async () => {
    seed({ doc: null });
    const first = await stage(PDF);
    const a = await (await finalize(first.body.uploadKey, { title: "Skid GA" })).json();
    const second = await stage(PDF);
    const res = await finalize(second.body.uploadKey, { title: "Skid GA" });
    const b = await res.json();
    expect(b).toMatchObject({ ok: true, duplicate: true, documentId: a.documentId });
    expect(deleted()).toEqual(expect.arrayContaining([first.body.uploadKey, second.body.uploadKey]));
  });

  it("one staged object, one finalize: concurrent finalizes of the same key — exactly one reads and files it; the others are refused before a byte is read", async () => {
    seed({ doc: null });
    const { body } = await stage(PDF);
    const answers = await Promise.all(Array.from({ length: 5 }, () => finalize(body.uploadKey, { title: "Skid GA" })));
    const statuses = answers.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    for (const r of answers.filter((x) => x.status === 409)) expect((await r.json()).code).toBe("upload_claimed");
    expect(db.r2Reads.filter((r) => r.op === "head")).toHaveLength(1);
    expect(db.r2Puts).toHaveLength(1);
    expect(deleted()).toEqual([body.uploadKey]);
    // and a later finalize of the same key (a replay) is refused the same way
    expect((await finalize(body.uploadKey, { title: "Skid GA" })).status).toBe(409);
  });

  it("finalize names only the link's own staged objects: another link's key, the old in-org prefix, a door key or a path is refused before storage is read; an unreserved key is refused; a reserved key with no object is a sentence", async () => {
    seed({ doc: null });
    for (const key of [
      "intake-staging/o1/p1/OTHERLINK/00000000-0000-4000-8000-000000000000",
      "orgs/o1/project-intake/p1/staging/lnk1/00000000-0000-4000-8000-000000000000",
      "orgs/o1/project-intake/p1/00000000-0000-4000-8000-000000000000-skid.pdf",
      `${STAGING}../../../libraries/x.pdf`,
      `${STAGING}00000000-0000-4000-8000-000000000000/extra`,
    ]) {
      const res = await finalize(key, { title: "x" });
      expect(res.status, key).toBe(400);
    }
    expect(db.r2Reads).toEqual([]);
    // a well-formed key no begin of THIS token reserved — never read, never deleted
    const unreserved = await finalize(`${STAGING}00000000-0000-4000-8000-000000000000`, { title: "x" });
    expect(unreserved.status).toBe(409);
    expect((await unreserved.json()).code).toBe("upload_claimed");
    reserve("00000000-0000-4000-8000-0000000000a2", null, { token_hash: "someone-else" });
    expect((await finalize(`${STAGING}00000000-0000-4000-8000-0000000000a2`, { title: "x" })).status).toBe(409);
    expect(db.r2Reads).toEqual([]);
    expect(db.r2Deletes).toEqual([]);
    // reserved, but the PUT never landed
    const key = reserve("00000000-0000-4000-8000-0000000000a1", null);
    const missing = await finalize(key, { title: "x" });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("upload_missing");
  });

  it("finalize re-checks the link: a link revoked between begin and finalize files nothing, and the staged object it claimed is removed (never read)", async () => {
    seed({ doc: null });
    const { body } = await stage(PDF);
    db.tables.project_intake_links[0].revoked_at = new Date().toISOString();
    const res = await finalize(body.uploadKey, { title: "Skid GA" });
    expect(res.status).toBe(410);
    expect(docWrites()).toEqual([]);
    expect(db.r2Reads).toEqual([]);
    expect(deleted()).toEqual([body.uploadKey]);
    expect(db.r2Objects.has(body.uploadKey)).toBe(false);
    expect(rows("staged")).toEqual([]);
  });

  it("every answer after the claim deletes the staged object — an expired link, a closed or gone project, a spent budget", async () => {
    const cases: Array<[string, () => void, number]> = [
      ["expired", () => { db.tables.project_intake_links[0].expires_at = "2026-01-01T00:00:00Z"; }, 410],
      ["closed", () => { db.tables.projects[0].status = "cancelled"; }, 410],
      ["gone", () => { db.tables.projects = []; }, 410],
      ["spent", () => { db.tables.project_intake_links[0].submission_count = 500; }, 429],
    ];
    for (const [name, mutate, status] of cases) {
      seed({ doc: null });
      db.r2Deletes = [];
      const { body } = await stage(PDF);
      mutate();
      const res = await finalize(body.uploadKey, { title: "x" });
      expect(res.status, name).toBe(status);
      expect(deleted(), name).toEqual([body.uploadKey]);
      expect(db.r2Reads, name).toEqual([]);
    }
  });

  it("finalize holds the stored size to the limit and the budget; only the six form fields are read from its body", async () => {
    seed({ doc: null, link: { bytes_received: 5 * 1024 ** 3 - 5 } });
    const key = reserve("00000000-0000-4000-8000-0000000000aa", PDF);
    const over = await finalize(key, { title: "Skid GA" });
    expect(over.status).toBe(429);
    expect(deleted()).toEqual([key]);
    seed({ doc: null });
    reserve("00000000-0000-4000-8000-0000000000aa", PDF);
    const res = await json("finalize", { uploadKey: key, fileName: "a.pdf", contentType: "application/pdf", fields: { title: "Skid GA", token: "x", file: "y", orgId: "evil" } });
    expect(res.status).toBe(200);
    const ins = db.writes.find((w) => w.table === "documents" && w.method === "insert")!;
    expect(ins.args[0]).toMatchObject({ org_id: ORG, title: "Skid GA" });
  });

  it("a JSON step body is small: a large declared one is refused unread", async () => {
    seed({ doc: null });
    const res = await POST(new NextRequest("http://x/api/intake/upload?step=begin", {
      method: "POST", body: "{}", headers: { "x-intake-token": TOKEN, "content-type": "application/json", "content-length": String(64 * 1024) },
    }));
    expect(res.status).toBe(413);
  });

  it("the multipart fallback names its begin (x-intake-begun): the attempt the begin counted is not counted again — once — and anything its PUT left is removed", async () => {
    seed({ doc: null });
    const { body } = await stage(PDF);
    expect(rows("attempt")).toHaveLength(1);
    const res = await upload({ title: "Skid GA" }, undefined, { "x-intake-begun": body.uploadKey });
    expect(res.status).toBe(200);
    expect(rows("attempt")).toHaveLength(1);
    expect(rows("staged")).toEqual([]);
    expect(deleted()).toContain(body.uploadKey);
    // naming it again is an ordinary, counted attempt
    seed({ doc: null });
    db.tables.intake_attempts = [{ token_hash: HASH, ip: "unknown", outcome: "attempt", created_at: new Date().toISOString() }];
    await upload({ title: "Other GA" }, { bytes: enc("%PDF-1.7\nother"), name: "o.pdf", type: "application/pdf" }, { "x-intake-begun": body.uploadKey });
    expect(rows("attempt")).toHaveLength(2);
    // a begin another token made is never this token's to claim
    seed({ doc: null });
    db.tables.intake_attempts = [];
    reserve("00000000-0000-4000-8000-0000000000b1", null, { token_hash: "someone-else" });
    await upload({ title: "Third GA" }, { bytes: enc("%PDF-1.7\nthird"), name: "t.pdf", type: "application/pdf" }, { "x-intake-begun": `${STAGING}00000000-0000-4000-8000-0000000000b1` });
    expect(rows("attempt")).toHaveLength(1);
    expect(rows("staged")).toHaveLength(1);
  });

  it("a begin that cannot presign keeps its reservation and hands the portal the key, so the fallback is counted once", async () => {
    seed({ doc: null });
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    vi.mocked(getSignedUrl).mockRejectedValueOnce(new Error("no credentials"));
    const res = await json("begin", { size: PDF.byteLength });
    expect(res.status).toBe(503);
    const b = await res.json();
    expect(b).toMatchObject({ code: "direct_unavailable" });
    expect(String(b.uploadKey).startsWith(STAGING)).toBe(true);
    expect((await upload({ title: "Skid GA" }, undefined, { "x-intake-begun": b.uploadKey })).status).toBe(200);
    expect(rows("attempt")).toHaveLength(1);
  });

  it("the portal uses the direct door (begin → PUT → finalize) and falls back to the multipart POST — naming the begin — when the door cannot presign, the browser cannot reach storage, or storage refuses a file the multipart door can take", () => {
    const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    const p = read("app/submit/[token]/page.tsx");
    expect(p).toContain('fetch(`/api/intake/upload?step=${step}`');
    expect(p).toContain("await putWithXhr(b.uploadUrl, file, b.contentType ?? \"application/octet-stream\");");
    expect(p).toContain('const fin = await json("finalize", { uploadKey: b.uploadKey, fileName: file.name, contentType: file.type, fields });');
    expect(p).toContain('if (b?.code === "direct_unavailable" || !b) return multipart(b?.uploadKey);');
    expect(p).toContain("if (e instanceof UploadCancelledError) throw e;");
    expect(p).toContain("if (/network error/i.test((e as Error).message) || file.size <= MULTIPART_SAFE_BYTES) return multipart(b.uploadKey);");
    expect(p).toContain("if (begunKey) headers[INTAKE_BEGUN_HEADER] = begunKey;");
    expect(p).toMatch(/const MULTIPART_SAFE_BYTES = 4 \* 1024 \* 1024;/);
    expect((p.match(/await sendToDoor\(token, /g) ?? []).length).toBe(3);
    expect(read("lib/storage.ts")).toMatch(/export function putWithXhr\(/);
  });

  it("the maintenance cron sweeps the staging root (no new cron entry): objects past the TTL, then their reservations", () => {
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    const c = src("app/api/cron/maintenance/route.ts");
    expect(c).toContain('import { sweepIntakeStaging } from "@/lib/intakeStaging";');
    expect(c).toContain("const staging = await sweepIntakeStaging(sb);");
    expect(c).toContain("for (const e of staging.errors) intakeLine(`intake-staging: ${e}`);");
    const vercel = JSON.parse(src("vercel.json")) as { crons?: unknown[] };
    expect((vercel.crons ?? []).length).toBeLessThanOrEqual(2);
  });
});
