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
  /** the restore surface's gate (lib/adminGate.ts), for `?exists=1` */
  adminGate: { userId: "u1" } as Record<string, unknown>,
  adminGateCalls: [] as Array<{ orgId: string; surface: string }>,
}));
vi.mock("@/lib/adminGate", () => ({
  authorizeAdminSurface: vi.fn(async (_req: unknown, orgId: string, surface: string) => {
    state.adminGateCalls.push({ orgId, surface });
    return state.adminGate;
  }),
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
        else if (["eq", "neq", "is", "in", "contains", "not", "lte", "gte", "lt", "gt", "or", "range"].includes(prop)) q.filters.push([prop, String(args[0]), args[1]]);
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
/** When set, the mention lookup answers only for a page of ids holding it. */
let mentionOn: string | null = null;
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
      if (q.select === "id") {
        // the mention leg's paged walk over every ticket naming the key
        if (ticketsError) return { error: ticketsError };
        const r = q.filters.find(([o]) => o === "range");
        const from = r ? Number(r[1]) : 0;
        const to = r ? Number(r[2]) : tickets.length - 1;
        return { data: tickets.slice(from, to + 1).map((t) => ({ id: t.id })) };
      }
      // resolve's attribution read (org_id, archived_at, archive_id)
      return { data: tickets.length ? { org_id: ORG, archived_at: null, archive_id: null } : null };
    case "ticket_comments": {
      if (mentionsError) return { error: mentionsError };
      if (mentionOn) {
        const ids = (q.filters.find(([o, c]) => o === "in" && c === "ticket_id")?.[2] ?? []) as string[];
        return { data: ids.includes(mentionOn) ? [{ id: "c-hit" }] : [] };
      }
      return { data: mentions };
    }
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
  state.adminGate = { userId: U1 };
  state.adminGateCalls = [];
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
  mentionOn = null;
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

describe("DF-P11 fix pass 2 — a legacy key whose revision row has a NULL org_id is attributed through its document", () => {
  it("no prefix, revision org_id NULL: the document's org_id attributes it — judged and served to a member (no 'can't be attributed')", async () => {
    resolveVersion = { org_id: null, archived_at: null, archive_id: null, record_id: "d-legacy" };
    doc = null;
    state.resolve = (q) => {
      if (q.table === "documents" && q.select === "org_id") return { data: has(q, "eq", "id", "d-legacy") ? { org_id: ORG } : null };
      return resolver(q);
    };
    const r = await callResolve("legacy/uploads/rev-a.pdf");
    expect(r.status).toBe(200);
    expect(typeof r.body.url).toBe("string");
    // the version read asked for record_id; the attribution read was one lookup
    expect(state.queries.some((q) => q.table === "document_versions" && q.select.includes("record_id") && q.select.includes("archive"))).toBe(true);
    expect(state.queries.filter((q) => q.table === "documents" && q.select === "org_id")).toHaveLength(1);
  });
  it("the membership gate then applies to THAT workspace: a non-member is refused 403", async () => {
    resolveVersion = { org_id: null, archived_at: null, archive_id: null, record_id: "d-legacy" };
    state.resolve = (q) => {
      if (q.table === "documents" && q.select === "org_id") return { data: { org_id: ORG } };
      if (q.table === "org_members") return { data: null };
      return resolver(q);
    };
    const r = await callResolve("legacy/uploads/rev-a.pdf");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("Not a member of this workspace");
  });
  it("nothing attributes it (no document either) → still refused 403; a document lookup that fails → 503, never a refusal or a URL", async () => {
    resolveVersion = { org_id: null, archived_at: null, archive_id: null, record_id: "d-gone" };
    state.resolve = (q) => (q.table === "documents" && q.select === "org_id" ? { data: null } : resolver(q));
    expect((await callResolve("legacy/uploads/rev-a.pdf")).status).toBe(403);
    state.resolve = (q) => (q.table === "documents" && q.select === "org_id" ? { error: { message: "down" } } : resolver(q));
    const r = await callResolve("legacy/uploads/rev-a.pdf");
    expect(r.status).toBe(503);
    expect(r.body.url).toBeUndefined();
  });
});

describe("DF-P11 fix pass 2 (ORG-20 / AUTHZ-4) — the restore's existence probe (`?exists=1`)", () => {
  const callExists = async (key: string) => {
    const r = await resolveGET(new NextRequest(`https://app/api/storage/resolve?path=${encodeURIComponent(key)}&exists=1`, { headers: { authorization: "Bearer t" } }));
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  it("an Admin (the restore surface's gate) learns only that the file exists — no document gate, no signed URL, no CONTROLLER_RESTRICTED_READ row", async () => {
    member = { uid: U1, role: "Admin", roles: ["Admin"] };
    namingVersions = [{ record_id: "d1" }];
    doc = { id: "d1", org_id: ORG, visibility: "normal", acl: null, acl_index: null, owner_user_id: null, collection_id: null, library_id: "L1", is_private: true, scope: "private", created_by: U2 };
    resolveVersion = { org_id: ORG, archived_at: null, archive_id: null };
    const r = await callExists(DOC_KEY);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ archived: false, exists: true, fileName: "P-101.pdf" });
    expect(audits).toEqual([]);
    expect(state.adminGateCalls).toEqual([{ orgId: ORG, surface: "restore" }]);
    // the document gate never ran (its record_id read is absent)
    expect(state.queries.some((q) => q.table === "document_versions" && q.select === "record_id")).toBe(false);
  });

  it("a key the document gate would refuse (an explicit download deny, a broken chain) still answers 'exists' — never read as absent", async () => {
    state.resolve = (q) => (q.table === "document_versions" && q.select === "record_id" ? { error: { message: "chain broken" } } : resolver(q));
    resolveVersion = { org_id: ORG, archived_at: null, archive_id: null };
    const r = await callExists(DOC_KEY);
    expect(r.status).toBe(200);
    expect(r.body.exists).toBe(true);
  });

  it("the restore surface's gate refuses → its status; nothing about the file is said", async () => {
    state.adminGate = { error: "Only Admins can restore a workspace.", status: 403 };
    resolveVersion = { org_id: ORG, archived_at: "2026-01-01T00:00:00Z", archive_id: "ARC-1" };
    const r = await callExists(DOC_KEY);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Only Admins can restore a workspace." });
  });

  it("shed → archived with its archive; NotFound → missing; any other HEAD failure → 503 (ORG-20)", async () => {
    resolveVersion = { org_id: ORG, archived_at: "2026-01-01T00:00:00Z", archive_id: "ARC-1" };
    expect((await callExists(DOC_KEY)).body).toMatchObject({ archived: true, archiveId: "ARC-1" });
    resolveVersion = { org_id: ORG, archived_at: null, archive_id: null };
    state.head = () => { throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }); };
    expect((await callExists(DOC_KEY)).body).toMatchObject({ archived: true, missing: true });
    state.head = () => { throw Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } }); };
    expect((await callExists(DOC_KEY)).status).toBe(503);
  });

  it("the restore page asks the probe, and a refusal other than 503 is reported and NOT uploaded", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(`${process.cwd()}/app/(protected)/admin/restore/page.tsx`, "utf8");
    expect(page).toContain("fetch(`/api/storage/resolve?path=${encodeURIComponent(key)}&exists=1`");
    expect(page).toContain("if (!check.ok && check.status !== 503) {");
    expect(page.indexOf("if (!check.ok && check.status !== 503) {")).toBeLessThan(page.indexOf("const blob = await zips[item.zip]"));
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

  it("fix pass 2: no cap becomes a 403 — 30 tickets name the key and the member's leg is on the 30th (requester, or mentioned): served at both doors", async () => {
    member = { uid: U1, role: "Contractor", roles: ["Contractor"] };
    const many = Array.from({ length: 30 }, (_, i) => ({ ...otherTicket, id: `t${i + 1}` }));
    // the direct legs are filtered in the query (requester / drafter / engineer / watcher)
    tickets = many.map((t, i) => (i === 29 ? { ...t, requester_id: U1 } : t));
    state.queries = [];
    expect((await callResolve(TICKET_KEY)).status).toBe(200);
    const leg = gateTicketReads()[0];
    expect(has(leg, "or", `requester_id.eq.${U1},assigned_drafter_id.eq.${U1},assigned_engineer_id.eq.${U1},watchers.cs.{${U1}}`)).toBe(true);
    // the mention leg pages over every naming ticket's id
    tickets = many;
    mentionOn = "t30";
    expect((await callDownload(TICKET_KEY)).status).toBe(200);
    // and a ticket past the first page of ids (TICKET_PAGE = 200) is still found
    tickets = Array.from({ length: 450 }, (_, i) => ({ ...otherTicket, id: `t${i + 1}` }));
    mentionOn = "t433";
    expect((await callResolve(TICKET_KEY)).status).toBe(200);
    mentionOn = "nowhere";
    expect((await callResolve(TICKET_KEY)).status).toBe(403);
  });

  it("fix pass 2: past the page bound the answer is 503 (retry), never 403", async () => {
    const { MAX_TICKET_PAGES, TICKET_PAGE } = await import("@/lib/ticketKeyGate");
    member = { uid: U1, role: "Contractor", roles: ["Contractor"] };
    tickets = Array.from({ length: MAX_TICKET_PAGES * TICKET_PAGE + 1 }, (_, i) => ({ ...otherTicket, id: `t${i + 1}` }));
    mentionOn = "nowhere";
    const r = await callResolve(TICKET_KEY);
    expect(r.status).toBe(503);
    expect(r.body.url).toBeUndefined();
  });

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

  // DF-P11 fix pass 3: the routes hand the gate the membership row they read
  // (role / roles ride along), so a member who is not Contractor-only is
  // decided with no second org_members read — a failure of such a read can no
  // longer turn today's signed URL into a 503.
  for (const door of ["resolve", "download-url"] as const) {
    const call = door === "resolve" ? callResolve : callDownload;
    it(`${door}: fix pass 3 — a non-Contractor member is decided from the route's own membership row; the gate makes no org_members read of its own`, async () => {
      for (const m of [
        { uid: U1, role: "Manager", roles: ["Manager"] },
        { uid: U1, role: "Manager", roles: ["Contractor", "Manager"] },
      ]) {
        member = m;
        tickets = [otherTicket];
        state.queries = [];
        // any read shaped like the gate's own member lookup fails
        state.resolve = (q) => (q.table === "org_members" && q.select === "role, roles" ? { error: { message: "transient" } } : resolver(q));
        const r = await call(TICKET_KEY);
        expect(r.status, JSON.stringify(m)).toBe(200);
        expect(typeof r.body.url).toBe("string");
        expect(state.queries.filter((q) => q.table === "org_members" && q.select === "role, roles")).toHaveLength(0);
        // the route's own membership read carries the roles
        expect(state.queries.some((q) => q.table === "org_members" && q.select === "uid, role, roles")).toBe(true);
      }
    });
    it(`${door}: fix pass 3 — a Contractor-only member is still judged from that same row (refused outside scope, served inside)`, async () => {
      member = { uid: U1, role: "Contractor", roles: ["Contractor"] };
      state.resolve = (q) => (q.table === "org_members" && q.select === "role, roles" ? { error: { message: "transient" } } : resolver(q));
      tickets = [otherTicket];
      expect((await call(TICKET_KEY)).status).toBe(403);
      tickets = [{ ...otherTicket, requester_id: U1 }];
      expect((await call(TICKET_KEY)).status).toBe(200);
    });
  }

  it("fix pass 3: called without a membership row, the gate reads it, and a failed read is 503 (never a URL)", async () => {
    const { ticketKeyGate } = await import("@/lib/ticketKeyGate");
    memberError = { message: "down" };
    const res = await ticketKeyGate(ORG, TICKET_KEY, { id: U1 });
    expect(res?.status).toBe(503);
    memberError = null;
    member = { uid: U1, role: "Manager", roles: ["Manager"] };
    expect(await ticketKeyGate(ORG, TICKET_KEY, { id: U1 })).toBeNull();
    // handed a row, it makes no read
    state.queries = [];
    memberError = { message: "down" };
    expect(await ticketKeyGate(ORG, TICKET_KEY, { id: U1 }, { role: "Manager", roles: ["Manager"] })).toBeNull();
    expect(state.queries.filter((q) => q.table === "org_members")).toHaveLength(0);
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
