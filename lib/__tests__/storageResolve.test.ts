// drafting-flow Round G, DF-P11 AFTER-DC — the two bytes doors:
//   * AUTHZ-4: /api/storage/resolve applies /api/storage/download-url's read
//     decision (lib/documentKeyGate.ts — the REAL gate runs here) and refuses
//     a key no workspace can be attributed to; the key's own orgs/<org>/
//     prefix names its workspace (a planted row in another workspace never
//     moves the membership check);
//   * EVID-16 done-when 2's remainder (DEC-90 ruling (2)): an
//     orgs/<org>/tickets/ key is signed only for a member who may read a
//     ticket naming it (lib/ticketKeyGate.ts — lib/ticketReadScope.ts's rule),
//     on BOTH doors; every member who is not Contractor-only keeps exactly
//     today's access (no ticket lookup at all); a document-backed key keeps
//     the DEC-43 controller rail and its CONTROLLER_RESTRICTED_READ row; an
//     undecidable read is 503;
//   * admin-and-org ORG-20: `missing: true` only for storage's NotFound; any
//     other HEAD failure (or a signing failure) is a 503;
//   * projects-tab GAP-401 remainder (b): both doors sign a contractor door
//     upload for UNTRUSTED_CONTENT_ORIGIN when it is set, and exactly as
//     before when it is not (the REAL presigner, offline).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Res = { data?: unknown; error?: unknown };
type Q = { table: string; op: string; select: string; filters: Array<[string, string, unknown]>; payload?: unknown };

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com" } as { id: string; email?: string } | null,
  resolve: (_q: Q): Res => ({ data: null, error: null }),
  rpc: (_name: string, _args: unknown): Res => ({ data: false, error: null }),
  queries: [] as Q[],
  head: null as null | (() => unknown),
}));

function chain(table: string) {
  const q: Q = { table, op: "select", select: "", filters: [] };
  state.queries.push(q);
  const settle = () => {
    const r = state.resolve(q);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  const self: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (ok: (v: unknown) => void, bad?: (e: unknown) => void) => {
          try { ok(settle()); } catch (e) { bad?.(e); }
        };
      }
      return (...args: unknown[]) => {
        if (prop === "select") { if (q.op === "select") q.select = String(args[0] ?? ""); }
        else if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") { q.op = prop; q.payload = args[0]; }
        else if (["eq", "neq", "is", "in", "contains", "not", "lte", "gte", "lt", "gt", "or"].includes(prop)) q.filters.push([prop, String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") {
          const r = settle();
          const d = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
          return Promise.resolve({ data: d, error: r.error });
        }
        return new Proxy(self, handler);
      };
    },
  };
  return new Proxy(self, handler);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () =>
        state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
    from: (t: string) => chain(t),
    rpc: vi.fn(async (name: string, args: unknown) => state.rpc(name, args)),
  },
}));
vi.mock("@/lib/r2", async () => {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    credentials: { accessKeyId: "AKTEST", secretAccessKey: "SKTEST" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  Object.assign(client, {
    send: vi.fn(async () => {
      if (state.head) return state.head();
      return { ContentLength: 10 };
    }),
  });
  return { r2: client, R2_BUCKET: "test-bucket" };
});

import { GET as resolveGET, isStorageNotFound } from "@/app/api/storage/resolve/route";
import { GET as downloadGET } from "@/app/api/storage/download-url/route";

const ORG = "12345678-1234-1234-1234-123456789abc";
const OTHER_ORG = "abcdefab-cdef-abcd-efab-cdefabcdefab";
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const TICKET_KEY = `orgs/${ORG}/tickets/KE-26-0001/1700000000000_scope.pdf`;
const DOC_KEY = `orgs/${ORG}/libraries/l1/P-101.pdf`;

const has = (q: Q, op: string, col: string, val?: unknown) =>
  q.filters.some(([o, c, v]) => o === op && c === col && (val === undefined || v === val));

/** The member's row; role(s) decide Contractor-only. */
let member: { uid: string; role: string; roles: string[] } | null;
let memberError: unknown = null;
/** Rows naming the key as a revision file: [] → no document behind it. */
let namingVersions: Array<{ record_id: string }>;
let doc: Record<string, unknown> | null;
let tickets: Array<Record<string, unknown>>;
let ticketsError: unknown = null;
let mentions: unknown[];
let mentionsError: unknown = null;
let resolveVersion: Record<string, unknown> | null;
let audits: unknown[];

function resolver(q: Q): Res {
  switch (q.table) {
    case "org_members":
      if (memberError) return { error: memberError };
      return { data: member };
    case "team_members":
      return { data: [] };
    case "document_versions":
      if (q.select === "record_id") return { data: has(q, "eq", "file_url") ? namingVersions : [] };
      // resolve's archive / attribution read, and download-url's archive read
      if (q.select.includes("archive")) return { data: resolveVersion };
      return { data: null };
    case "documents":
      return { data: doc };
    case "libraries":
      return { data: { id: "L1", acl: null, read_access: null } };
    case "tickets":
      if (q.select.includes("requester_id")) return ticketsError ? { error: ticketsError } : { data: tickets };
      // resolve's attribution read (org_id, archived_at, archive_id)
      return { data: tickets.length ? { org_id: ORG, archived_at: null, archive_id: null } : null };
    case "ticket_comments":
      return mentionsError ? { error: mentionsError } : { data: mentions };
    case "archive_settings":
      return { data: null };
    case "audit_logs":
      if (q.op === "insert") audits.push(q.payload);
      return { data: null, error: null };
    case "download_deny_index":
    default:
      return { data: null };
  }
}

const reqFor = (route: "resolve" | "download-url", key: string) =>
  new NextRequest(`https://app/api/storage/${route}?path=${encodeURIComponent(key)}`, { headers: { authorization: "Bearer t" } });
const callResolve = async (key: string) => { const r = await resolveGET(reqFor("resolve", key)); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
const callDownload = async (key: string) => { const r = await downloadGET(reqFor("download-url", key)); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
const gateTicketReads = () => state.queries.filter((q) => q.table === "tickets" && q.select.includes("requester_id"));

beforeEach(() => {
  process.env.R2_ACCOUNT_ID = "acct";
  process.env.R2_BUCKET_NAME = "test-bucket";
  process.env.R2_ACCESS_KEY_ID = "AKTEST";
  process.env.R2_SECRET_ACCESS_KEY = "SKTEST";
  delete process.env.UNTRUSTED_CONTENT_ORIGIN;
  state.user = { id: U1, email: "u1@example.com" };
  state.queries = [];
  state.head = null;
  state.resolve = resolver;
  state.rpc = () => ({ data: false, error: null });
  member = { uid: U1, role: "Viewer", roles: ["Viewer"] };
  memberError = null;
  namingVersions = [];
  doc = null;
  tickets = [];
  ticketsError = null;
  mentions = [];
  mentionsError = null;
  resolveVersion = null;
  audits = [];
});
afterEach(() => { delete process.env.UNTRUSTED_CONTENT_ORIGIN; });

describe("AUTHZ-4 — /api/storage/resolve applies download-url's document decision", () => {
  const privateDraftOf = (createdBy: string) => ({
    id: "d1", org_id: ORG, visibility: "normal", acl: null, acl_index: null, owner_user_id: null,
    collection_id: null, library_id: "L1", is_private: true, scope: "private", created_by: createdBy,
  });

  it("a member the document's ACL does not admit gets 403 from BOTH doors, and no URL", async () => {
    namingVersions = [{ record_id: "d1" }];
    doc = privateDraftOf(U2);
    resolveVersion = { org_id: ORG, archived_at: null, archive_id: null };
    const r = await callResolve(DOC_KEY);
    expect(r.status).toBe(403);
    expect(r.body.url).toBeUndefined();
    expect(r.body.error).toBe("Not authorized for this document");
    const d = await callDownload(DOC_KEY);
    expect(d.status).toBe(403);
    expect(d.body.error).toBe(r.body.error);
  });

  it("the same document's creator is served by both doors (no regression)", async () => {
    namingVersions = [{ record_id: "d1" }];
    doc = privateDraftOf(U1);
    resolveVersion = { org_id: ORG, archived_at: null, archive_id: null };
    const r = await callResolve(DOC_KEY);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ archived: false });
    expect(typeof r.body.url).toBe("string");
    expect((await callDownload(DOC_KEY)).status).toBe(200);
  });

  it("DEC-43: a controller is served at resolve too, and the controller-only read is recorded", async () => {
    member = { uid: U1, role: "DocCtrl", roles: ["DocCtrl"] };
    namingVersions = [{ record_id: "d1" }];
    doc = privateDraftOf(U2);
    resolveVersion = { org_id: ORG, archived_at: null, archive_id: null };
    const r = await callResolve(DOC_KEY);
    expect(r.status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "CONTROLLER_RESTRICTED_READ", resource_id: "d1", org_id: ORG, user_id: U1 });
  });

  it("a lookup that cannot be made is 503 at resolve (fail closed), never a URL", async () => {
    state.resolve = (q) => (q.table === "document_versions" && q.select === "record_id" ? { error: { message: "down" } } : resolver(q));
    resolveVersion = { org_id: ORG, archived_at: null, archive_id: null };
    const r = await callResolve(DOC_KEY);
    expect(r.status).toBe(503);
    expect(r.body.url).toBeUndefined();
  });

  it("done-when 2: a key no workspace can be attributed to is refused, never signed", async () => {
    const r = await callResolve("legacy/uploads/file.pdf");
    expect(r.status).toBe(403);
    expect(r.body.url).toBeUndefined();
  });

  it("a legacy key attributed through its revision row is still judged and served to a member", async () => {
    resolveVersion = { org_id: ORG, archived_at: null, archive_id: null };
    const r = await callResolve("legacy/uploads/file.pdf");
    expect(r.status).toBe(200);
  });

  it("the key's own prefix names its workspace: a member of another workspace only is refused even when their workspace's row names the key", async () => {
    // The caller is a member of OTHER_ORG only; the key is ORG's.
    state.resolve = (q) => {
      if (q.table === "org_members") return { data: has(q, "eq", "org_id", OTHER_ORG) ? member : null };
      if (q.table === "tickets" && !q.select.includes("requester_id")) {
        // a planted attachment in the caller's own workspace names ORG's key
        return { data: has(q, "eq", "org_id", ORG) ? null : { org_id: OTHER_ORG, archived_at: null, archive_id: null } };
      }
      return resolver(q);
    };
    const r = await callResolve(TICKET_KEY);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("Not a member of this workspace");
    // the attribution reads were scoped to the key's workspace
    const scoped = state.queries.filter((q) => (q.table === "document_versions" || q.table === "tickets") && q.select.includes("archive"));
    expect(scoped.length).toBeGreaterThan(0);
    for (const q of scoped) {
      // the revision read admits this workspace's rows and org-less legacy ones (never another's)
      if (q.table === "document_versions") expect(has(q, "or", `org_id.eq.${ORG},org_id.is.null`)).toBe(true);
      else expect(has(q, "eq", "org_id", ORG)).toBe(true);
    }
  });

  it("fix pass: a legacy shed revision with a NULL org_id still gets its NAMED archive prompt", async () => {
    // the revision row carries no org_id (nullable column); its key carries the prefix
    state.resolve = (q) => {
      if (q.table === "document_versions" && q.select.includes("archive")) {
        return { data: has(q, "or", `org_id.eq.${ORG},org_id.is.null`) ? { org_id: null, archived_at: "2026-01-01T00:00:00Z", archive_id: "ARC-LEGACY" } : null };
      }
      return resolver(q);
    };
    state.head = () => { throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }); };
    const r = await callResolve(DOC_KEY);
    expect(r.body.archived).toBe(true);
    expect(r.body.archiveId).toBe("ARC-LEGACY");
  });
});

describe("EVID-16 / DEC-90 ruling (2) — a ticket file is signed only for a member who may read the ticket", () => {
  const otherTicket = { id: "t1", requester_id: U2, assigned_drafter_id: null, assigned_engineer_id: null, watchers: [] };

  for (const door of ["resolve", "download-url"] as const) {
    const call = door === "resolve" ? callResolve : callDownload;

    it(`${door}: a member who is not Contractor-only keeps today's access — signed, with no ticket lookup`, async () => {
      for (const m of [
        { uid: U1, role: "Viewer", roles: ["Viewer"] },
        { uid: U1, role: "Drafter", roles: ["Drafter"] },
        { uid: U1, role: "Manager", roles: ["Contractor", "Manager"] },
        { uid: U1, role: "Admin", roles: [] },
      ]) {
        member = m;
        tickets = [otherTicket];
        state.queries = [];
        const r = await call(TICKET_KEY);
        expect(r.status, JSON.stringify(m)).toBe(200);
        expect(typeof r.body.url).toBe("string");
        expect(gateTicketReads(), JSON.stringify(m)).toHaveLength(0);
      }
    });

    it(`${door}: a Contractor-only member outside the ticket's read scope is refused 403, no URL`, async () => {
      member = { uid: U1, role: "Contractor", roles: ["Contractor"] };
      tickets = [otherTicket];
      const r = await call(TICKET_KEY);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("Not authorized for this file");
      expect(r.body.url).toBeUndefined();
      // the lookup was scoped to the key's workspace and the key itself
      const q = gateTicketReads()[0];
      expect(has(q, "eq", "org_id", ORG)).toBe(true);
      expect(has(q, "contains", "attachments")).toBe(true);
    });

    it(`${door}: a Contractor-only member inside the scope (requester, drafter, engineer, watcher, mentioned) is served`, async () => {
      member = { uid: U1, role: "Contractor", roles: ["Contractor"] };
      for (const t of [
        { ...otherTicket, requester_id: U1 },
        { ...otherTicket, assigned_drafter_id: U1 },
        { ...otherTicket, assigned_engineer_id: U1 },
        { ...otherTicket, watchers: [U1] },
      ]) {
        tickets = [t];
        const r = await call(TICKET_KEY);
        expect(r.status, JSON.stringify(t)).toBe(200);
      }
      tickets = [otherTicket];
      mentions = [{ id: "c1" }];
      expect((await call(TICKET_KEY)).status).toBe(200);
    });

    it(`${door}: an undecidable read is 503 — the member row, the ticket lookup, the mention lookup`, async () => {
      member = { uid: U1, role: "Contractor", roles: ["Contractor"] };
      tickets = [otherTicket];
      mentionsError = { message: "down" };
      expect((await call(TICKET_KEY)).status).toBe(503);
      mentionsError = null;
      ticketsError = { message: "down" };
      expect((await call(TICKET_KEY)).status).toBe(503);
    });

    it(`${door}: a Contractor-only member's own staged upload is theirs; another member's is not`, async () => {
      member = { uid: U1, role: "Contractor", roles: ["Contractor"] };
      const batch = "33333333-3333-3333-3333-333333333333";
      expect((await call(`orgs/${ORG}/tickets/pending/${U1}/${batch}/1700000000000_a.pdf`)).status).toBe(200);
      expect((await call(`orgs/${ORG}/tickets/pending/${U2}/${batch}/1700000000000_a.pdf`)).status).toBe(403);
    });

    it(`${door}: a ticket-prefix key a revision names is the document gate's — the ticket gate stands aside`, async () => {
      member = { uid: U1, role: "Contractor", roles: ["Contractor"] };
      namingVersions = [{ record_id: "d1" }];
      doc = { id: "d1", org_id: ORG, visibility: "normal", acl: null, acl_index: null, owner_user_id: null, collection_id: null, library_id: "L1" };
      resolveVersion = { org_id: ORG, archived_at: null, archive_id: null };
      const r = await call(TICKET_KEY);
      expect(r.status).toBe(200);
      expect(gateTicketReads()).toHaveLength(0);
    });
  }

  it("resolve: the gate runs before the archive answer — a refused caller learns nothing of the archive", async () => {
    member = { uid: U1, role: "Contractor", roles: ["Contractor"] };
    tickets = [otherTicket];
    state.resolve = (q) => (q.table === "tickets" && !q.select.includes("requester_id")
      ? { data: { org_id: ORG, archived_at: "2026-01-01T00:00:00Z", archive_id: "ARC-1" } }
      : resolver(q));
    const r = await callResolve(TICKET_KEY);
    expect(r.status).toBe(403);
    expect(r.body.archiveId).toBeUndefined();
  });
});

describe("ORG-20 — `missing: true` only for storage's NotFound", () => {
  it("isStorageNotFound reads the name, the code and the HTTP status", () => {
    expect(isStorageNotFound(Object.assign(new Error("x"), { name: "NotFound" }))).toBe(true);
    expect(isStorageNotFound(Object.assign(new Error("x"), { name: "NoSuchKey" }))).toBe(true);
    expect(isStorageNotFound({ name: "Unknown", $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isStorageNotFound({ name: "InternalError", $metadata: { httpStatusCode: 500 } })).toBe(false);
    expect(isStorageNotFound(Object.assign(new Error("socket hang up"), { name: "TimeoutError" }))).toBe(false);
    expect(isStorageNotFound(null)).toBe(false);
  });

  it("a NotFound HEAD answers 200 missing: true (the archive prompt, as before)", async () => {
    state.head = () => { throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }); };
    const r = await callResolve(DOC_KEY);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ archived: true, missing: true });
  });

  it("a 5xx HEAD answers 503, never missing", async () => {
    state.head = () => { throw Object.assign(new Error("We encountered an internal error"), { name: "InternalError", $metadata: { httpStatusCode: 500 } }); };
    const r = await callResolve(DOC_KEY);
    expect(r.status).toBe(503);
    expect(r.body.missing).toBeUndefined();
    expect(r.body.retryable).toBe(true);
  });

  it("a timed-out HEAD answers 503, never missing", async () => {
    state.head = () => { throw Object.assign(new Error("Connection timed out"), { name: "TimeoutError" }); };
    const r = await callResolve(DOC_KEY);
    expect(r.status).toBe(503);
    expect(r.body.missing).toBeUndefined();
  });

  it("a file present is signed as before", async () => {
    const r = await callResolve(DOC_KEY);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ archived: false });
  });
});

describe("GAP-401 remainder (b) — both doors sign a door upload for UNTRUSTED_CONTENT_ORIGIN when set", () => {
  const DOOR_KEY = `orgs/${ORG}/project-intake/p1/abc-drawing.pdf`;

  it("unset: a door upload and a controlled file are both signed on the bucket host (exactly as before)", async () => {
    for (const key of [DOOR_KEY, DOC_KEY]) {
      const r = await callResolve(key);
      expect(new URL(String(r.body.url)).host, key).toBe("test-bucket.acct.r2.cloudflarestorage.com");
      const d = await callDownload(key);
      expect(new URL(String(d.body.url)).host, key).toBe("test-bucket.acct.r2.cloudflarestorage.com");
    }
  });

  it("set: the door upload is signed path-style on the account host; a controlled file stays on the bucket host", async () => {
    process.env.UNTRUSTED_CONTENT_ORIGIN = "https://acct.r2.cloudflarestorage.com";
    for (const call of [callResolve, callDownload]) {
      const door = new URL(String((await call(DOOR_KEY)).body.url));
      expect(door.host).toBe("acct.r2.cloudflarestorage.com");
      expect(door.pathname.startsWith("/test-bucket/orgs/")).toBe(true);
      const ctl = new URL(String((await call(DOC_KEY)).body.url));
      expect(ctl.host).toBe("test-bucket.acct.r2.cloudflarestorage.com");
    }
  });
});
