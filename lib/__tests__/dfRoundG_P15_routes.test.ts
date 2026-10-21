// drafting-flow Round G, DF-P15 DELIVERABLE PAGE WIRING — the two ticket
// routes this package holds, driven through the REAL handlers (the
// notifications N6 / DF-P14 harness: a stateful service-role stand-in).
//
//   SM-15     the workflow route mints every new attachment's id on the
//             server; a client id already on the ticket is never kept, and
//             every attachment already on the ticket keeps its id.
//   SM-16     reopen_ticket removes metadata.outcome_reason on the same
//             compare-and-set write that nulls tickets.outcome; the reopen's
//             history line keeps the old reason.
//   DACL-10   (intelligence, the I-31 remainder) the close notice's library
//             label reads the rung's columns: a legacy library is named, or
//             not, the same before and after 20261228.
//   PHYS-18   (public-surfaces) an issuing transition recalls the holders of
//             the superseded copies, best-effort after the response.
//   DCW-4     (page half) /api/tickets/handback accepts a NEW document's
//             version in the request's library carrying the ticket; the close
//             believes a library-only request's recorded publication only
//             when the register backs it.
//   REGRESSION: every path that worked before works as before (pinned
//             alongside each change).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { TicketAttachment } from "@/types/schema";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Row[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  /** `${table}.${method}` → errors handed out one per call, in order. */
  errors: {} as Record<string, Array<{ code?: string; message: string } | null>>,
  seq: 0,
  /** The 1-based org_configurations 'drafting' read that fails, or 0. */
  failDraftingRead: 0,
  draftingReads: 0,
  /** rpc name → its answer (the database evaluators the hand-back asks). */
  rpc: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}));

const at = (r: Row, k: string): unknown => {
  const m = /^(\w+)->>(\w+)$/.exec(k);
  if (!m) return r[k];
  const v = (r[m[1]] as Row | null | undefined)?.[m[2]];
  return v == null ? null : String(v);
};

/** The service-role client: filters applied, writes land. */
function chain(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let method: string | null = null;
  let payload: unknown = null;
  let head = false;
  const eqs: Array<[string, unknown]> = [];
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const errOf = () => {
    if (table === "org_configurations" && method === null && eqs.some(([k, v]) => k === "key" && v === "drafting")) {
      state.draftingReads += 1;
      if (state.draftingReads === state.failDraftingRead) return { message: "canceling statement due to statement timeout" };
    }
    return state.errors[`${table}.${method ?? "select"}`]?.shift() ?? null;
  };
  const settle = () => {
    const err = errOf();
    if (err) return { data: null, error: err };
    if (method === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
      const landed = list.map((r) => ({ id: `${table}-${++state.seq}`, ...r }));
      state.rows[table] = [...(state.rows[table] ?? []), ...landed];
      return { data: landed, error: null };
    }
    if (method === "update") {
      const hit = rows();
      for (const r of hit) Object.assign(r, payload as Row);
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    if (head) return { data: null, error: null, count: rows().length };
    return { data: rows().map((r) => ({ ...r })), error: null, count: rows().length };
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(settle());
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (["insert", "update", "upsert", "delete"].includes(prop) && method === null) { method = prop; payload = args[0]; }
        if (prop === "eq") { eqs.push([String(args[0]), args[1]]); filters.push((r) => at(r, String(args[0])) === args[1]); }
        if (prop === "in") { const s = new Set(args[1] as unknown[]); filters.push((r) => s.has(at(r, String(args[0])))); }
        if (prop === "neq") filters.push((r) => at(r, String(args[0])) !== args[1]);
        if (prop === "lt") filters.push((r) => { const x = at(r, String(args[0])); return x != null && String(x) < String(args[1]); });
        if (prop === "is") filters.push((r) => (args[1] === null ? at(r, String(args[0])) == null : at(r, String(args[0])) === args[1]));
        if (prop === "not" && args[1] === "is" && args[2] === null) filters.push((r) => at(r, String(args[0])) != null);
        if (prop === "contains") filters.push((r) => Array.isArray(r[String(args[0])]) && (args[1] as unknown[]).every((x) => (r[String(args[0])] as unknown[]).includes(x)));
        if (prop === "maybeSingle" || prop === "single") {
          const out = settle();
          const list = (out.data as Row[] | null) ?? [];
          return Promise.resolve({ data: out.error ? null : (Array.isArray(out.data) ? list[0] ?? null : out.data), error: out.error });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
const admin = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/supabaseAdmin", () => {
  const client = {
    auth: {
      getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
      admin: { getUserById: vi.fn(async () => ({ data: { user: null }, error: { message: "nope" } })) },
    },
    from: (t: string) => chain(t),
    rpc: vi.fn(async (fn: string, args: unknown) => {
      state.calls.push({ table: "rpc", method: fn, args: [args] });
      if (fn === "email_gate") return { data: true, error: null };
      if (state.rpc[fn]) return state.rpc[fn];
      return { data: null, error: null };
    }),
  };
  admin.client = client;
  return { supabaseAdmin: client };
});
// The shared client: the anon key with no session (RLS shows nothing, refuses
// writes) unless a request is bound to the service role (lib/serverClientScope).
vi.mock("@/lib/supabase", () => {
  let scoped: (() => unknown) | null = null;
  const anonChain = (table: string) => {
    let write = false;
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => {
          state.calls.push({ table: `anon:${table}`, method: write ? "write" : "select", args: [] });
          resolve(write ? { data: null, error: { code: "42501", message: "row-level security" } } : { data: [], error: null });
        };
        return () => {
          if (["insert", "update", "upsert", "delete"].includes(prop)) write = true;
          if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: null, error: null });
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  };
  const anon = {
    from: anonChain,
    rpc: async () => ({ data: null, error: { code: "42501", message: "not allowed" } }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  };
  return {
    __registerScopedServerClient: (read: () => unknown) => { scoped = read; },
    supabase: new Proxy({}, {
      get(_t, prop) {
        const impl = (scoped?.() ?? anon) as Record<PropertyKey, unknown>;
        const v = impl[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(impl) : v;
      },
    }),
  };
});
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/r2", () => ({
  r2: { send: vi.fn(async () => ({ ContentLength: 1048576, ETag: '"etag-1"' })) },
  R2_BUCKET: "test-bucket",
}));

import { after } from "next/server";
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { POST as handback } from "@/app/api/tickets/handback/route";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REQ = U(1), DRAFTER = U(2), W_ACTIVE = U(3), W_SUSP = U(4), W_INACTIVE = U(5);
const ORG = "o1";
const LM = "2026-10-02T00:00:00.000Z";
const ORIGIN = "https://ops.example.com";
const member = (uid: string, role: string, status = "active") =>
  ({ org_id: ORG, uid, role, roles: [role], email: `${uid.slice(-2)}@x.io`, display_name: null, status });
const ticketRow = (over: Row = {}) => ({
  id: "t1", org_id: ORG, ticket_id: "REQ-1", title: "Pump iso", status: "DRAFTING", request_type: "ISO", unit: "U-100",
  requester_id: REQ, requester_role: "Requester", assigned_drafter_id: DRAFTER, assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [W_ACTIVE, W_SUSP, W_INACTIVE], unread_by: [], revision_count: 0, last_modified: LM,
  metadata: {}, ...over,
});
const KEY = (name: string) => `orgs/o1/tickets/REQ-1/1727000000000_${name}`;
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: KEY("iso_1A.pdf"), type: "Draft", status: "staged", uploadedBy: "02@x.io" } as TicketAttachment;
const req = (path: string, body: unknown) => new NextRequest(`http://app.local${path}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});
const inserted = (table: string) => state.calls.filter((c) => c.table === table && c.method === "insert")
  .flatMap((c) => (Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Row[]);

const SUP = U(7), HOLDER = U(8);
const UUIDV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", UUIDD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", LIB = "11111111-2222-4333-8444-555555555555";
const ticketUpdates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as Row);
const auditRows = () => inserted("audit_logs");
const act = (body: Row) => workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", ...body }));
const seedMembers = (...extra: Row[]) => {
  state.rows.org_members = [
    member(REQ, "Requester"), member(DRAFTER, "Drafter"), member(W_ACTIVE, "Engineer"),
    member(W_SUSP, "Engineer", "suspended"), member(W_INACTIVE, "Engineer", "inactive"), member(SUP, "Admin"), ...extra,
  ];
  state.rows.orgs = [{ id: ORG, name: "Baytown Ops" }];
};
const FINAL1 = { id: "f-1", name: "iso_IFC.pdf", url: KEY("iso_IFC.pdf"), type: "Final", status: "submitted", rev: "1", uploadedBy: "02@x.io" } as TicketAttachment;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.seq = 0; state.failDraftingRead = 0; state.draftingReads = 0; state.rpc = {};
  vi.mocked(after).mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  delete process.env.CRON_SECRET;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { delete process.env.NEXT_PUBLIC_SITE_URL; vi.restoreAllMocks(); });

// ─── SM-15 ───────────────────────────────────────────────────────────────────
describe("SM-15 — a ticket file's id is minted by the server, never the client's", () => {
  it("reproduction → fix: an attachment posted with the id of the current Final does not produce a second attachment carrying that id", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "PENDING_IFC", deliverable_rev: "1", attachments: [DRAFT, FINAL1] })];
    state.user = { id: DRAFTER };
    const res = await act({ actionType: "attach_file", attachment: { id: "f-1", name: "other.pdf", url: KEY("other.pdf"), type: "Reference" } });
    expect(res.status).toBe(200);
    const atts = ticketUpdates()[0].attachments as TicketAttachment[];
    // every attachment already on the ticket keeps its id, untouched
    expect(atts.slice(0, 2)).toEqual([DRAFT, FINAL1]);
    // the new one: a server UUID, never the client's
    expect(atts[2]).toMatchObject({ name: "other.pdf", url: KEY("other.pdf"), type: "Reference" });
    expect(atts[2].id).toMatch(UUID_V4);
    expect(atts.filter((a) => a.id === "f-1")).toHaveLength(1);
    // the audit row names the file by the id it was stored under
    const audit = auditRows().find((r) => r.action === "TICKET_ATTACH_FILE")!;
    expect((audit.details as Row).attachment).toMatchObject({ id: atts[2].id, url: KEY("other.pdf") });
  });
  it("a client id that is new to the ticket is not kept either (every new attachment's id is the server's); a file with no id gets one, as before", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ attachments: [DRAFT] })];
    state.user = { id: DRAFTER };
    expect((await act({ actionType: "attach_file", attachment: { id: "client-made", name: "a.pdf", url: KEY("a.pdf"), type: "Draft" } })).status).toBe(200);
    const a1 = (ticketUpdates()[0].attachments as TicketAttachment[])[1];
    expect(a1.id).not.toBe("client-made");
    expect(a1.id).toMatch(UUID_V4);
    state.calls = [];
    state.rows.tickets = [ticketRow({ attachments: [DRAFT] })];
    expect((await act({ actionType: "attach_file", attachment: { name: "b.pdf", url: KEY("b.pdf"), type: "Draft" } })).status).toBe(200);
    expect((ticketUpdates()[0].attachments as TicketAttachment[])[1].id).toMatch(UUID_V4);
  });
  it("REGRESSION: the vetting is unchanged — a key outside the ticket's prefix is still refused, nothing written", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ attachments: [DRAFT] })];
    state.user = { id: DRAFTER };
    const res = await act({ actionType: "attach_file", attachment: { id: "x", name: "a.pdf", url: "orgs/o1/tickets/REQ-2/a.pdf", type: "Draft" } });
    expect(res.status).toBe(400);
    expect(ticketUpdates()).toEqual([]);
  });
});

// ─── SM-16 ───────────────────────────────────────────────────────────────────
describe("SM-16 — a reopen clears the reason the request ended for, on the same write that clears its outcome", () => {
  const REASON = { id: "left_site", label: "Requester left the site", category: "withdrawn" };
  it("close with a reason → reopen → the row carries no outcome_reason; the rest of metadata stays; the history line keeps the old reason", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "CLOSED", outcome: "withdrawn", deliverable_rev: "1", revision_count: 0, metadata: { source_document: { id: "d1" }, outcome_reason: REASON } })];
    state.user = { id: REQ };
    const res = await act({ actionType: "reopen_ticket", comment: "needs another pass" });
    expect(res.status).toBe(200);
    const upd = ticketUpdates()[0];
    expect(upd).toMatchObject({ status: "PENDING_REVIEW", outcome: null });
    expect(upd.metadata).toEqual({ source_document: { id: "d1" } });
    const hist = upd.history as Row[];
    expect(String(hist[hist.length - 1].details)).toContain("[The reason it had ended, cleared by the reopen: Withdrawn — Requester left the site]");
    // one write: the compare-and-set that nulls the outcome carries the metadata too
    expect(ticketUpdates()).toHaveLength(1);
  });
  it("REGRESSION: a reopen of a request with no recorded reason writes no metadata at all, as before", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "CLOSED", outcome: "completed", deliverable_rev: "1", metadata: { source_document: { id: "d1" } } })];
    state.user = { id: REQ };
    expect((await act({ actionType: "reopen_ticket", comment: "again" })).status).toBe(200);
    const upd = ticketUpdates()[0];
    expect("metadata" in upd).toBe(false);
    expect(upd.outcome).toBeNull();
  });
});

// ─── DACL-10 remainder ───────────────────────────────────────────────────────
describe("DACL-10 remainder — the close notice's library label reads the library's effective ACL (the rung)", () => {
  const close = async (lib: Row) => {
    seedMembers();
    state.rows.libraries = [{ id: LIB, org_id: ORG, owner_user_id: null, ...lib }];
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", library_id: LIB, deliverable_rev: "1", attachments: [DRAFT, FINAL1] })];
    state.user = { id: REQ };
    const res = await act({ actionType: "close_ticket" });
    expect(res.status).toBe(200);
    const hist = ticketUpdates()[0].history as Row[];
    return String(hist[hist.length - 1].details);
  };
  it("a legacy library whose lists restrict (no ACL yet) is 'the target library' — before 20261228 as after it (on base the raw read named it)", async () => {
    const before = await close({ name: "HR records", acl: null, visibility: "normal", read_access: ["HR"], visible_to: [], write_access: [], admin_access: [] });
    expect(before).toContain("not published into the target library");
    expect(before).not.toContain("HR records");
    state.calls = [];
    const after20261228 = await close({ name: "HR records", visibility: "normal", read_access: ["HR"], visible_to: [], write_access: [], admin_access: [],
      acl: { inherit: true, visibility: "normal", rules: [{ effect: "allow", subject: { type: "role", id: "HR" }, actions: ["discover", "read", "download"] }] } });
    expect(after20261228).toBe(before);
  });
  it("REGRESSION: an open legacy library (read_access ALL, no ACL) keeps its name; a hidden one stays unnamed", async () => {
    expect(await close({ name: "Piping", acl: null, visibility: "normal", read_access: "ALL", visible_to: [], write_access: [], admin_access: [] })).toContain("not published into Piping");
    state.calls = [];
    expect(await close({ name: "Secret", acl: null, visibility: "hidden", read_access: "ALL", visible_to: [], write_access: [], admin_access: [] })).toContain("the target library");
  });
  it("the label's read selects the rung's columns (the lists ride with the ACL)", async () => {
    await close({ name: "Piping", acl: null, visibility: "normal", read_access: "ALL", visible_to: [], write_access: [], admin_access: [] });
    const sel = state.calls.filter((c) => c.table === "libraries" && c.method === "select").map((c) => String(c.args[0]));
    expect(sel).toContain("id, name, acl, visibility, read_access, visible_to, write_access, admin_access");
  });
});

// ─── DCW-4 — the close believes a library-only request's publication only when the register backs it ───
describe("DCW-4 (DF-P15) — a library-only request's recorded publication, at the close", () => {
  const seed = (deliverable: Row | null, versions: Row[] = [], documents: Row[] = [{ id: UUIDD, org_id: ORG, library_id: LIB }]) => {
    seedMembers();
    state.rows.libraries = [{ id: LIB, org_id: ORG, name: "Piping", acl: null, visibility: "normal", read_access: "ALL", visible_to: [], write_access: [], admin_access: [] }];
    state.rows.document_versions = versions;
    state.rows.documents = documents;
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", library_id: LIB, deliverable_rev: "1", attachments: [DRAFT, FINAL1], metadata: deliverable ? { deliverable } : {} })];
    state.user = { id: REQ };
  };
  const published = { state: "published", version_id: UUIDV, revision_label: "0", document_id: UUIDD, published_at: LM, published_by: SUP, library_id: LIB, new_document: true };
  it("backed (a version in this org, of the recorded document, carrying this ticket): closes clean — no not-in-register state, no note", async () => {
    seed(published, [{ id: UUIDV, org_id: ORG, record_id: UUIDD, related_ticket_id: "t1" }]);
    expect((await act({ actionType: "close_ticket" })).status).toBe(200);
    const upd = ticketUpdates()[0];
    expect("metadata" in upd).toBe(false);
    expect((upd.history as Row[]).some((h) => h.action === "Closed — deliverable not in the register")).toBe(false);
  });
  it("unbacked (a hand-written 'published', no such version): closes visibly NOT in the register, the false state replaced", async () => {
    seed(published, []);
    expect((await act({ actionType: "close_ticket" })).status).toBe(200);
    const upd = ticketUpdates()[0];
    expect((upd.metadata as Row).deliverable).toMatchObject({ state: "not_in_register", document_id: null, library_id: LIB });
    const hist = upd.history as Row[];
    expect(hist[hist.length - 1]).toMatchObject({ action: "Closed — deliverable not in the register" });
    expect(String(hist[hist.length - 1].details)).toContain("could not be matched to a document in Piping");
  });
  it("DF-P15 fix (review): a backed version whose document sits in ANOTHER library (or in no readable row) is unbacked — the close names it not in the register, as the hand-back would have refused it", async () => {
    const OTHER_LIB = "99999999-2222-4333-8444-555555555555";
    seed(published, [{ id: UUIDV, org_id: ORG, record_id: UUIDD, related_ticket_id: "t1" }], [{ id: UUIDD, org_id: ORG, library_id: OTHER_LIB }]);
    expect((await act({ actionType: "close_ticket" })).status).toBe(200);
    expect(((ticketUpdates()[0].metadata as Row).deliverable as Row).state).toBe("not_in_register");
    expect(state.calls.some((c) => c.table === "documents" && c.method === "eq" && c.args[0] === "org_id" && c.args[1] === ORG)).toBe(true);
  });
  it("DF-P15 fix (review): a document in another workspace carrying the same id is not read as backing", async () => {
    seed(published, [{ id: UUIDV, org_id: ORG, record_id: UUIDD, related_ticket_id: "t1" }], [{ id: UUIDD, org_id: "o2", library_id: LIB }]);
    expect((await act({ actionType: "close_ticket" })).status).toBe(200);
    expect(((ticketUpdates()[0].metadata as Row).deliverable as Row).state).toBe("not_in_register");
  });
  it("DF-P15 fix (review): the document read failing proves nothing — 503 register_unreadable, nothing written", async () => {
    seed(published, [{ id: UUIDV, org_id: ORG, record_id: UUIDD, related_ticket_id: "t1" }]);
    state.errors["documents.select"] = [{ message: "statement timeout" }];
    const res = await act({ actionType: "close_ticket" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("register_unreadable");
    expect(ticketUpdates()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });
  it("a register read that fails proves nothing: 503 register_unreadable, nothing written", async () => {
    seed(published, []);
    state.errors["document_versions.select"] = [{ message: "statement timeout" }];
    const res = await act({ actionType: "close_ticket" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("register_unreadable");
    expect(ticketUpdates()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });
  it("a non-UUID recorded id is unbacked with no read", async () => {
    seed({ ...published, version_id: "not-a-uuid" }, []);
    expect((await act({ actionType: "close_ticket" })).status).toBe(200);
    expect(state.calls.some((c) => c.table === "document_versions")).toBe(false);
    expect(((ticketUpdates()[0].metadata as Row).deliverable as Row).state).toBe("not_in_register");
  });
  it("REGRESSION: a library-only request with nothing recorded closes as DF-P4 made it (not in the library, named)", async () => {
    seed(null);
    expect((await act({ actionType: "close_ticket" })).status).toBe(200);
    const hist = ticketUpdates()[0].history as Row[];
    expect(hist[hist.length - 1].details).toBe("Closed without a register document: the deliverable was not published into Piping.");
  });
});

// ─── PHYS-18 — the recall at an issue ────────────────────────────────────────
describe("PHYS-18 — an issuing transition recalls the holders of the superseded copies (best-effort, after the response)", () => {
  const recent = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const seed = () => {
    seedMembers(member(HOLDER, "Viewer"));
    const D2 = { id: "d-2", name: "iso_2A.pdf", url: KEY("iso_2A.pdf"), type: "Draft", status: "submitted", rev: "2A", uploadedBy: "02@x.io" } as TicketAttachment;
    state.rows.tickets = [ticketRow({
      status: "PENDING_REVIEW", deliverable_rev: "2A", revision_count: 1, draft_iteration: 1,
      history: [{ action: "Approve (Issue for Construction) — issued Rev 1", user: "e@x.io" }],
      attachments: [FINAL1, D2],
    })];
    state.rows.download_audits = [
      { org_id: ORG, ticket_id: "t1", attachment_id: "f-1", user_id: HOLDER, user_email: "holder@x.io", created_at: recent, source: "drafting_print" },
    ];
    state.user = { id: SUP };
  };
  const lastAfter = () => {
    const calls = vi.mocked(after).mock.calls;
    return calls[calls.length - 1]?.[0] as (() => Promise<unknown>) | undefined;
  };
  it("approve_draft_ifc issues Rev 2; after the response the Rev 1 holder is told and the recall is on the ticket's audit trail (source auto)", async () => {
    seed();
    const res = await act({ actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    expect(ticketUpdates()[0]).toMatchObject({ status: "PENDING_IFC", deliverable_rev: "2" });
    // nothing is recalled before the response — it is scheduled after it
    expect(auditRows().some((r) => r.action === "DISTRIBUTION_RECALL")).toBe(false);
    expect(vi.mocked(after).mock.calls.length).toBe(3); // the email drain, the EVID-12 file hashes (DF-P5 fix pass 2: after the response), then the recall
    await lastAfter()!();
    const recall = auditRows().find((r) => r.action === "DISTRIBUTION_RECALL")!;
    expect(recall).toMatchObject({ resource_type: "ticket", resource_id: "t1", org_id: ORG, user_id: SUP });
    expect(recall.details).toMatchObject({ source: "auto", latestIssuedRev: "2", recipientCount: 1, recipients: [expect.objectContaining({ userId: HOLDER, heldRevs: ["1"] })] });
    const bell = inserted("notifications").filter((n) => n.user_id === HOLDER);
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ kind: "doc_recalled" });
  });
  it("a copy record that cannot be read (before 20261223) is recorded as such and tells nobody — and never fails the issue", async () => {
    seed();
    state.errors["download_audits.select"] = [{ code: "42703", message: "column download_audits.ticket_id does not exist" }];
    const res = await act({ actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    await expect(lastAfter()!()).resolves.toBe(0);
    const recall = auditRows().find((r) => r.action === "DISTRIBUTION_RECALL")!;
    expect(recall.details).toMatchObject({ source: "auto", unavailable: true, recipientCount: 0 });
    expect(inserted("notifications").filter((n) => n.user_id === HOLDER)).toEqual([]);
  });
  it("no holders: nothing recorded, nobody told; a transition that issues nothing schedules no recall", async () => {
    seed();
    state.rows.download_audits = [];
    expect((await act({ actionType: "approve_draft_ifc" })).status).toBe(200);
    await lastAfter()!();
    expect(auditRows().some((r) => r.action === "DISTRIBUTION_RECALL")).toBe(false);
    vi.mocked(after).mockReset();
    state.calls = [];
    state.rows.tickets = [ticketRow({ attachments: [DRAFT] })];
    state.user = { id: DRAFTER };
    expect((await act({ actionType: "submit_draft" })).status).toBe(200);
    expect(vi.mocked(after).mock.calls.length).toBe(1); // the email drain only
  });
});

// ─── DCW-4 — /api/tickets/handback accepts a NEW document's version ──────────
describe("DCW-4 (DF-P15) — /api/tickets/handback records a new document published from a library-only request", () => {
  const post = (body: Row) => handback(req("/api/tickets/handback", body));
  const seed = (over: Row = {}, doc: Row = {}) => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", library_id: LIB, deliverable_rev: "1", attachments: [DRAFT, FINAL1], ...over })];
    state.rows.document_versions = [{ id: UUIDV, org_id: ORG, record_id: UUIDD, revision_label: "0", related_ticket_id: "t1", review_state: null, created_by: SUP }];
    state.rows.documents = [{ id: UUIDD, org_id: ORG, library_id: LIB, document_number: "P-101-ISO-001", status: "Issued", ...doc }];
    state.user = { id: SUP };
  };
  it("an Issued new document in the request's library, carrying the ticket: recorded as published, named, with the library", async () => {
    seed();
    const res = await post({ ticketId: "t1", versionId: UUIDV });
    expect(res.status).toBe(200);
    const upd = ticketUpdates()[0];
    expect((upd.metadata as Row).deliverable).toMatchObject({ state: "published", version_id: UUIDV, document_id: UUIDD, revision_label: "0", library_id: LIB, new_document: true });
    expect(((upd.metadata as Row).deliverable as Row).filed_as_draft).toBeUndefined();
    const hist = upd.history as Row[];
    expect(hist[hist.length - 1]).toMatchObject({ action: "Deliverable published to the register", details: "P-101-ISO-001 Rev 0 — published as a new document from this request's Final deliverable." });
    expect(auditRows().find((r) => r.action === "TICKET_HANDBACK_PUBLISHED")!.details).toMatchObject({ versionId: UUIDV, documentId: UUIDD, newDocument: true, libraryId: LIB, initialStatus: "Issued" });
  });
  it("a Draft new document is said as filed, not published", async () => {
    seed({}, { status: "Draft" });
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(200);
    const upd = ticketUpdates()[0];
    expect(((upd.metadata as Row).deliverable as Row).filed_as_draft).toBe(true);
    const hist = upd.history as Row[];
    expect(hist[hist.length - 1].action).toBe("Deliverable filed in the register as a Draft");
  });
  it("refused, nothing written: a document in another library, another workspace's version, a version not carrying the ticket", async () => {
    seed({}, { library_id: "other-lib" });
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(409);
    seed({}, { org_id: "o2" });
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(409);
    seed();
    state.rows.document_versions[0].related_ticket_id = "t-other";
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(409);
    seed();
    state.rows.document_versions[0].org_id = "o2";
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(409);
    expect(ticketUpdates()).toEqual([]);
  });
  it("a register read that fails is a 503, nothing written; a request with neither a source document nor a library is checked, not trusted (a version not carrying the ticket is a 409 — DEC-90 ruling at the DF-P15 merge, below)", async () => {
    seed();
    state.errors["documents.select"] = [{ message: "timeout" }];
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(503);
    seed({ library_id: null });
    state.rows.document_versions[0].related_ticket_id = "t-other";
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(409);
    expect(ticketUpdates()).toEqual([]);
  });
  it("REGRESSION: a request with a source document still accepts only a version of THAT document (a new document in its library is refused), and records it as before", async () => {
    seed({ metadata: { source_document: { id: "dddddddd-0000-4000-8000-000000000001", document_number: "P-9" } } });
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(409);
    state.rows.document_versions[0].record_id = "dddddddd-0000-4000-8000-000000000001";
    const ok = await post({ ticketId: "t1", versionId: UUIDV });
    expect(ok.status).toBe(200);
    const upd = ticketUpdates()[0];
    expect((upd.metadata as Row).deliverable).toEqual(expect.objectContaining({ state: "published", document_id: "dddddddd-0000-4000-8000-000000000001" }));
    expect(((upd.metadata as Row).deliverable as Row).new_document).toBeUndefined();
    const hist = upd.history as Row[];
    expect(hist[hist.length - 1].details).toBe("Rev 0 of P-9 — published from this request's Final deliverable.");
  });
});

// ─── Rulings by the integrator at the DF-P15 merge, 2026-10-20 (DEC-90) ─────
const UUIDV0 = "a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIB2 = "22222222-2222-4333-8444-555555555555";

describe("Item 3 (DEC-90 ruling) — the hand-back labels a version 'new document' only when it is its document's FIRST version", () => {
  const post = (body: Row) => handback(req("/api/tickets/handback", body));
  const seed = (over: Row = {}, doc: Row = {}) => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", library_id: LIB, deliverable_rev: "1", attachments: [DRAFT, FINAL1], ...over })];
    state.rows.libraries = [{ id: LIB, org_id: ORG, name: "Piping", acl: null, visibility: "normal", read_access: "ALL", visible_to: [], write_access: [], admin_access: [] }];
    state.rows.document_versions = [
      { id: UUIDV0, org_id: ORG, record_id: UUIDD, revision_label: "0", related_ticket_id: null, review_state: null, created_by: SUP, created_at: "2026-09-01T00:00:00.000Z" },
      { id: UUIDV, org_id: ORG, record_id: UUIDD, revision_label: "1", related_ticket_id: "t1", review_state: null, created_by: SUP, created_at: "2026-10-01T00:00:00.000Z" },
    ];
    state.rows.documents = [{ id: UUIDD, org_id: ORG, library_id: LIB, document_number: "P-101-ISO-001", status: "Issued", ...doc }];
    state.user = { id: SUP };
  };
  it("a SECOND version of an existing document in the request's library: recorded as 'Rev 1 of <doc> — published into <library>', never as a new document", async () => {
    seed();
    const res = await post({ ticketId: "t1", versionId: UUIDV });
    expect(res.status).toBe(200);
    const upd = ticketUpdates()[0];
    const d = (upd.metadata as Row).deliverable as Row;
    expect(d).toMatchObject({ state: "published", version_id: UUIDV, document_id: UUIDD, revision_label: "1", library_id: LIB });
    expect(d.new_document).toBeUndefined();
    const hist = upd.history as Row[];
    expect(hist[hist.length - 1]).toMatchObject({ action: "Deliverable published to the register", details: "Rev 1 of P-101-ISO-001 — published into Piping from this request's Final deliverable." });
    expect(String(hist[hist.length - 1].details)).not.toMatch(/new document/);
    expect(auditRows().find((r) => r.action === "TICKET_HANDBACK_PUBLISHED")!.details).toMatchObject({ newDocument: false, libraryId: LIB, documentStatus: "Issued" });
    // the read is the checked one: versions of THIS document created before v
    const lt = state.calls.find((c) => c.table === "document_versions" && c.method === "lt");
    expect(lt?.args).toEqual(["created_at", "2026-10-01T00:00:00.000Z"]);
    // the notice says the same
    const bell = inserted("notifications");
    expect(bell.length).toBeGreaterThan(0);
    for (const n of bell) expect(String(n.title)).toBe("REQ-1: deliverable published as Rev 1 of P-101-ISO-001 into Piping");
  });
  it("the FIRST version (no earlier version of its document) keeps the new-document record and says 'created as a new document' in its notice", async () => {
    seed();
    state.rows.document_versions = [state.rows.document_versions[1]];
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(200);
    const upd = ticketUpdates()[0];
    expect(((upd.metadata as Row).deliverable as Row).new_document).toBe(true);
    expect(inserted("notifications").length).toBeGreaterThan(0);
    for (const n of inserted("notifications")) expect(String(n.title)).toBe("REQ-1: deliverable created as a new document (P-101-ISO-001 Rev 1)");
  });
  it("the earlier-version read failing is a 503 before anything is written", async () => {
    seed();
    state.errors["document_versions.select"] = [null, { message: "statement timeout" }];
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(503);
    expect(ticketUpdates()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });
  it("REGRESSION: a source-document request reads no earlier versions and records exactly as before", async () => {
    seed({ metadata: { source_document: { id: UUIDD, document_number: "P-9" } } });
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(200);
    expect(state.calls.some((c) => c.table === "document_versions" && c.method === "lt")).toBe(false);
    const hist = ticketUpdates()[0].history as Row[];
    expect(hist[hist.length - 1].details).toBe("Rev 1 of P-9 — published from this request's Final deliverable.");
  });
});

describe("DCW-4 remainder (DEC-90 ruling) — a request with neither a source document nor a library publishes into a library the publisher chooses", () => {
  const post = (body: Row) => handback(req("/api/tickets/handback", body));
  const PUBLISHER = U(9);
  const seed = (over: Row = {}) => {
    seedMembers(member(PUBLISHER, "Engineer"));
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", library_id: null, deliverable_rev: "1", attachments: [DRAFT, FINAL1], ...over })];
    state.rows.document_versions = [{ id: UUIDV, org_id: ORG, record_id: UUIDD, revision_label: "0", related_ticket_id: "t1", review_state: null, created_by: PUBLISHER, created_at: "2026-10-01T00:00:00.000Z" }];
    state.rows.documents = [{ id: UUIDD, org_id: ORG, library_id: LIB2, document_number: "N-1", status: "Issued" }];
    state.user = { id: PUBLISHER };
  };
  const rpcCalls = (fn: string) => state.calls.filter((c) => c.table === "rpc" && c.method === fn).map((c) => c.args[0] as Row);
  it("a library-less request records the new document published into the chosen library — the publisher's authority checked server-side on the DOCUMENT's library; the request's own library is never written", async () => {
    seed();
    state.rpc.user_can_publish_on_library = { data: true, error: null };
    // a client-sent library id is ignored: the document's library is the one checked
    const res = await post({ ticketId: "t1", versionId: UUIDV, libraryId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    expect(res.status).toBe(200);
    expect(rpcCalls("user_can_publish_on_library")).toEqual([{ p_library: LIB2, p_uid: PUBLISHER, p_org: ORG }]);
    const upd = ticketUpdates()[0];
    expect("library_id" in upd).toBe(false);
    expect((upd.metadata as Row).deliverable).toMatchObject({ state: "published", version_id: UUIDV, document_id: UUIDD, library_id: LIB2, library_chosen: true, new_document: true });
    expect(auditRows().find((r) => r.action === "TICKET_HANDBACK_PUBLISHED")!.details).toMatchObject({ newDocument: true, libraryId: LIB2, libraryChosen: true });
  });
  it("the library's effective owner may publish there too (user_is_effective_owner on the library)", async () => {
    seed();
    state.rpc.user_can_publish_on_library = { data: false, error: null };
    state.rpc.user_is_effective_owner = { data: true, error: null };
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(200);
    expect(rpcCalls("user_is_effective_owner")).toEqual([{ p_doc_owner: null, p_collection: null, p_library: LIB2, p_uid: PUBLISHER }]);
  });
  it("a library the caller may NOT publish into is refused server-side (403), nothing written; an authority read that fails is a 503, nothing written", async () => {
    seed();
    state.rpc.user_can_publish_on_library = { data: false, error: null };
    state.rpc.user_is_effective_owner = { data: false, error: null };
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(403);
    seed();
    state.rpc.user_can_publish_on_library = { data: null, error: { message: "timeout" } };
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(503);
    expect(ticketUpdates()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });
  it("refused, nothing written: a document in another workspace, a document in no library, a version not carrying the ticket", async () => {
    state.rpc.user_can_publish_on_library = { data: true, error: null };
    seed();
    state.rows.documents[0].org_id = "o2";
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(409);
    seed();
    state.rows.documents[0].library_id = null;
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(409);
    seed();
    state.rows.document_versions[0].related_ticket_id = "t-other";
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(409);
    expect(ticketUpdates()).toEqual([]);
  });
  it("REGRESSION: a request WITH a library, or with a source document, asks no authority question and behaves exactly as before", async () => {
    seed({ library_id: LIB2 });
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(200);
    seed({ metadata: { source_document: { id: UUIDD, document_number: "N-1" } } });
    expect((await post({ ticketId: "t1", versionId: UUIDV })).status).toBe(200);
    expect(rpcCalls("user_can_publish_on_library")).toEqual([]);
    expect(rpcCalls("user_is_effective_owner")).toEqual([]);
  });
});

describe("DCW-4 remainder (DEC-90 ruling) — the close re-checks a library-less request's recorded publication against the register", () => {
  const seed = (deliverable: Row | null, versions: Row[] = [], documents: Row[] = [{ id: UUIDD, org_id: ORG, library_id: LIB2 }]) => {
    seedMembers();
    state.rows.libraries = [{ id: LIB2, org_id: ORG, name: "Civil", acl: null, visibility: "normal", read_access: "ALL", visible_to: [], write_access: [], admin_access: [] }];
    state.rows.document_versions = versions;
    state.rows.documents = documents;
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", library_id: null, deliverable_rev: "1", attachments: [DRAFT, FINAL1], metadata: deliverable ? { deliverable } : {} })];
    state.user = { id: REQ };
  };
  const published = { state: "published", version_id: UUIDV, revision_label: "0", document_id: UUIDD, published_at: LM, published_by: SUP, library_id: LIB2, library_chosen: true, new_document: true };
  const backing = [{ id: UUIDV, org_id: ORG, record_id: UUIDD, related_ticket_id: "t1" }];
  it("backed (the version carries the ticket; its document still exists, in the recorded library): closes clean", async () => {
    seed(published, backing);
    expect((await act({ actionType: "close_ticket" })).status).toBe(200);
    const upd = ticketUpdates()[0];
    expect("metadata" in upd).toBe(false);
    expect((upd.history as Row[]).some((h) => h.action === "Closed — deliverable not in the register")).toBe(false);
  });
  it("the recorded document no longer in the register (or in another library): closes visibly NOT in the register, the false state replaced", async () => {
    seed(published, backing, []);
    expect((await act({ actionType: "close_ticket" })).status).toBe(200);
    let upd = ticketUpdates()[0];
    expect((upd.metadata as Row).deliverable).toMatchObject({ state: "not_in_register", document_id: null, library_id: LIB2 });
    const hist = upd.history as Row[];
    expect(hist[hist.length - 1]).toMatchObject({ action: "Closed — deliverable not in the register" });
    expect(String(hist[hist.length - 1].details)).toContain("could not be matched to a document in Civil");
    state.calls = [];
    seed(published, backing, [{ id: UUIDD, org_id: ORG, library_id: LIB }]);
    expect((await act({ actionType: "close_ticket" })).status).toBe(200);
    upd = ticketUpdates()[0];
    expect(((upd.metadata as Row).deliverable as Row).state).toBe("not_in_register");
  });
  it("a register read that fails proves nothing: 503 register_unreadable, nothing written", async () => {
    seed(published, backing);
    state.errors["documents.select"] = [{ message: "statement timeout" }];
    const res = await act({ actionType: "close_ticket" });
    expect(res.status).toBe(503);
    expect(ticketUpdates()).toEqual([]);
  });
  it("REGRESSION: a library-less request with nothing recorded closes exactly as before (no metadata written, no note)", async () => {
    seed(null);
    expect((await act({ actionType: "close_ticket" })).status).toBe(200);
    const upd = ticketUpdates()[0];
    expect("metadata" in upd).toBe(false);
    expect((upd.history as Row[]).some((h) => h.action === "Closed — deliverable not in the register")).toBe(false);
  });
});
