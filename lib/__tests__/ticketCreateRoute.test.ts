// drafting-flow Round G, DF-P2 CREATE — /api/tickets/create end to end.
//
// One server-side creation path for the three doors (the request form, a
// document check-in, an intake collision), driven through the REAL route,
// the REAL notifier (lib/notify/dispatch → lib/inAppNotifications +
// lib/notifications), the REAL routing pool (lib/ticketRouting) and the REAL
// request-scoped binding (lib/serverClientScope), over an in-memory
// PostgREST stand-in. The shared client (lib/supabase) behaves as it does in
// a route with no browser session — the anon client, whose writes RLS
// refuses — unless the binding resolves it to the service role, so a fan-out
// that forgot to bind would write nothing and fail here.
//
// What is pinned, regression first:
//   * each door's legitimate flow files the ticket it filed before — same
//     fields, same history line, same notice — now numbered, stamped and
//     announced server-side (FRIC-8, ROUTE-4, EDGE-8);
//   * 20261038 ticket_insert_integrity is replicated for the service-role
//     insert that bypasses it (requester = caller, held role, queue entry,
//     configured type; AUTHZ-3's name from the membership);
//   * a refused submit allocates no number and leaves no staged file; a
//     failed insert gives its number back when it can (EDGE-13);
//   * opt-outs are honoured and the 60-second repeat is dropped (EDGE-1,
//     EDGE-12); the notice carries metadata.action / status (ROUTE-11);
//   * a check-in resumes its episode's ticket (LEAK-6); the source document
//     carries the version it was raised against (HAND-7) and several sheets
//     are all kept (GAP-8); the unit is optional and resolved (FRIC-3, DCW-7).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
type Err = { code?: string; message: string };

const s = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  objects: new Map<string, number>(),
  users: {} as Record<string, { id: string; email: string }>,
  /** next_ticket_number as the caller-scoped client sees it. */
  counter: new Map<string, number>(),
  rpcCalls: [] as Array<{ client: "admin" | "caller"; fn: string; args: Record<string, unknown> }>,
  callerToken: "" as string,
  emailGate: null as null | ((args: Record<string, unknown>) => { data: unknown; error: Err | null }),
  /** `${table}.${op}` → errors handed out one per call, in order. */
  errors: {} as Record<string, Array<Err | null>>,
  /** run before a statement executes: a test acts as a second writer. */
  hooks: [] as Array<(table: string, op: string) => void>,
  r2Fail: {} as Record<string, number>,   // "copy" | "head" | "delete" → how many calls fail
  r2Ops: [] as Array<{ op: string; key: string; from?: string }>,
  anonWrites: [] as Array<{ table: string; op: string }>,
  after: [] as Array<() => unknown>,
  seq: 0,
}));

// ── the in-memory PostgREST stand-in ──────────────────────────────────────
function readPath(row: Row, col: string): unknown {
  // "metadata->checkin->>episodeId", "metadata->>action", "metadata->source_documents"
  const parts = col.split(/->>?/);
  let v: unknown = row[parts[0]];
  for (const p of parts.slice(1)) v = v && typeof v === "object" ? (v as Row)[p] : undefined;
  if (col.includes("->>") && v != null && typeof v !== "string") v = typeof v === "object" ? JSON.stringify(v) : String(v);
  return v;
}
function containsJson(have: unknown, want: unknown): boolean {
  if (Array.isArray(want)) return Array.isArray(have) && want.every((w) => have.some((h) => containsJson(h, w)));
  if (want && typeof want === "object") {
    return !!have && typeof have === "object" && Object.entries(want as Row).every(([k, v]) => containsJson((have as Row)[k], v));
  }
  return have === want;
}
type F = (r: Row) => boolean;
function chain(table: string, client: "admin" | "anon") {
  const filters: F[] = [];
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | Row[] | null = null;
  let order: { col: string; asc: boolean } | null = null;
  let limitN: number | null = null;
  let single: "one" | "maybe" | null = null;
  let returning = false;
  const run = (): { data: unknown; error: Err | null } => {
    for (const h of s.hooks) h(table, op);
    const errs = s.errors[`${table}.${op}`];
    if (errs && errs.length > 0) {
      const e = errs.shift();
      if (e) return { data: null, error: e };
    }
    if (client === "anon" && op !== "select") {
      s.anonWrites.push({ table, op });
      return { data: null, error: { code: "42501", message: `new row violates row-level security policy for table "${table}"` } };
    }
    if (client === "anon") return { data: single ? null : [], error: null };
    const rows = (s.tables[table] ??= []);
    if (op === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: r.id ?? `${table}-${++s.seq}`, created_at: r.created_at ?? new Date().toISOString(), ...r }));
      rows.push(...list.map((r) => JSON.parse(JSON.stringify(r))));
      const out = returning ? list : null;
      return { data: single ? (out?.[0] ?? null) : out, error: null };
    }
    let hit = rows.filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(payload)));
      return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    if (op === "delete") {
      s.tables[table] = rows.filter((r) => !hit.includes(r));
      return { data: returning ? hit : null, error: null };
    }
    if (order) {
      const { col, asc } = order;
      hit = [...hit].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (asc ? 1 : -1));
    }
    if (limitN != null) hit = hit.slice(0, limitN);
    const out = hit.map((r) => JSON.parse(JSON.stringify(r)));
    if (single === "one") return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
    if (single === "maybe") return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  };
  const q: Record<string, unknown> = {
    select(_cols?: string) { if (op !== "select") returning = true; return q; },
    insert(p: Row | Row[]) { op = "insert"; payload = p; return q; },
    upsert(p: Row | Row[]) { op = "insert"; payload = p; return q; },
    update(p: Row) { op = "update"; payload = p; return q; },
    delete() { op = "delete"; return q; },
    eq(col: string, v: unknown) { filters.push((r) => { const x = readPath(r, col); return x != null && x === v; }); return q; },
    neq(col: string, v: unknown) { filters.push((r) => readPath(r, col) !== v); return q; },
    in(col: string, vs: unknown[]) { filters.push((r) => vs.includes(readPath(r, col))); return q; },
    gte(col: string, v: unknown) { filters.push((r) => String(readPath(r, col) ?? "") >= String(v)); return q; },
    is(col: string, v: unknown) { filters.push((r) => (v === null ? readPath(r, col) == null : readPath(r, col) === v)); return q; },
    not(col: string, how: string, v: unknown) {
      if (how === "in") {
        const list = String(v).replace(/[()"]/g, "").split(",");
        filters.push((r) => !list.includes(String(readPath(r, col))));
      } else if (how === "is") filters.push((r) => (v === null ? readPath(r, col) != null : readPath(r, col) !== v));
      return q;
    },
    contains(col: string, v: unknown) {
      const want = typeof v === "string" ? JSON.parse(v) : v;
      filters.push((r) => containsJson(readPath(r, col), want));
      return q;
    },
    order(col: string, o?: { ascending?: boolean }) { order = { col, asc: o?.ascending !== false }; return q; },
    limit(n: number) { limitN = n; return q; },
    maybeSingle() { single = "maybe"; return Promise.resolve(run()); },
    single() { single = "one"; return Promise.resolve(run()); },
    then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
      try { resolve(run()); } catch (e) { reject?.(e); }
    },
  };
  return q;
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (t: string) => chain(t, "admin"),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      s.rpcCalls.push({ client: "admin", fn, args });
      if (fn === "email_gate" && s.emailGate) return s.emailGate(args);
      return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
    },
    auth: {
      getUser: async (token: string) => (s.users[token]
        ? { data: { user: s.users[token] }, error: null }
        : { data: { user: null }, error: { message: "bad token" } }),
      getSession: async () => ({ data: { session: null }, error: null }),
      admin: { getUserById: async (id: string) => ({ data: { user: { id, email: `${id}@plant.io` } }, error: null }) },
    },
  },
}));
// The shared client as a route has it: the anon client, unless bound.
vi.mock("@/lib/supabase", () => {
  let scoped: (() => unknown) | null = null;
  const anon = {
    from: (t: string) => chain(t, "anon"),
    rpc: async () => ({ data: null, error: { code: "42501", message: "permission denied" } }),
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
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
// The caller-scoped client: next_ticket_number reads auth.uid() and admits
// active members only (20260724), so the route allocates AS THE CALLER.
vi.mock("@/lib/serverAuth", () => ({
  callerScopedClient: (req: Request) => {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    s.callerToken = token;
    return {
      rpc: async (fn: string, args: { p_org: string; p_year: number }) => {
        s.rpcCalls.push({ client: "caller", fn, args });
        const errs = s.errors[`rpc.${fn}`];
        if (errs && errs.length > 0) { const e = errs.shift(); if (e) return { data: null, error: e }; }
        const uid = s.users[token]?.id;
        const member = (s.tables.org_members ?? []).find((m) => m.org_id === args.p_org && m.uid === uid && m.status === "active");
        if (!member) return { data: null, error: { code: "P0001", message: "not an active member of this org" } };
        const k = `${args.p_org}:${args.p_year}`;
        const next = (s.counter.get(k) ?? 0) + 1;
        s.counter.set(k, next);
        (s.tables.ticket_number_counters ??= []).splice(0, Infinity,
          ...[...s.counter].map(([key, v]) => ({ org_id: key.split(":")[0], year: Number(key.split(":")[1]), next_seq: v })));
        return { data: next, error: null };
      },
    };
  },
}));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "bucket",
  r2: {
    send: async (cmd: { constructor: { name: string }; input: { Key: string; CopySource?: string } }) => {
      const name = cmd.constructor.name;
      const key = cmd.input.Key;
      const kind = name === "HeadObjectCommand" ? "head" : name === "CopyObjectCommand" ? "copy" : "delete";
      if ((s.r2Fail[kind] ?? 0) > 0) { s.r2Fail[kind]--; throw new Error(`${kind} failed`); }
      if (kind === "head") {
        s.r2Ops.push({ op: "head", key });
        if (!s.objects.has(key)) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
        return { ContentLength: s.objects.get(key) };
      }
      if (kind === "copy") {
        const from = decodeURIComponent(String(cmd.input.CopySource).replace(/^bucket\//, ""));
        s.r2Ops.push({ op: "copy", key, from });
        if (!s.objects.has(from)) throw new Error("NoSuchKey");
        s.objects.set(key, s.objects.get(from)!);
        return {};
      }
      s.r2Ops.push({ op: "delete", key });
      s.objects.delete(key);
      return {};
    },
  },
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { s.after.push(fn); },
}));

import { POST, DELETE } from "@/app/api/tickets/create/route";
import { POST as workflowPOST } from "@/app/api/tickets/workflow-action/route";
import { queueEmail } from "@/lib/notifications";
import { runWithServerClient } from "@/lib/serverClientScope";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { BUILTIN_REQUEST_TYPES, stampedRequesterRole, parseTicketCreateBody } from "@/lib/ticketCreate";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const REQ = "aaaaaaaa-0000-4000-8000-000000000001";       // the requester
const SUP = "aaaaaaaa-0000-4000-8000-000000000002";       // DraftingSupervisor
const SUP2 = "aaaaaaaa-0000-4000-8000-000000000003";      // DraftingSupervisor, emails off
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000004";     // Admin (steps aside: a supervisor exists)
const DOC = "dddddddd-0000-4000-8000-000000000001";
const DOC2 = "dddddddd-0000-4000-8000-000000000002";
const DOC_FOREIGN = "dddddddd-0000-4000-8000-000000000009";
const V3 = "eeeeeeee-0000-4000-8000-000000000003";
const V4 = "eeeeeeee-0000-4000-8000-000000000004";
const EPISODE = "cccccccc-0000-4000-8000-000000000001";
const BATCH = "bbbbbbbb-0000-4000-8000-000000000001";
const PROJECT = "ffffffff-0000-4000-8000-000000000001";
const YEAR = new Date().getFullYear();
const YY = String(YEAR).slice(-2);

const member = (uid: string, role: string, over: Row = {}) => ({
  org_id: ORG, uid, role, roles: [role], email: `${uid.slice(-1)}@plant.io`, display_name: null, status: "active", ...over,
});
const staged = (name: string, uid = REQ, org = ORG, batch = BATCH) => `orgs/${org}/tickets/pending/${uid}/${batch}/1727000000000_${name}`;

function seed() {
  s.tables = {
    org_members: [
      member(REQ, "Requester", { display_name: "Rita Requester", email: "rita@plant.io" }),
      member(SUP, "DraftingSupervisor", { email: "sam@plant.io" }),
      member(SUP2, "DraftingSupervisor", { email: "sue@plant.io" }),
      member(ADMIN, "Admin", { email: "ada@plant.io" }),
    ],
    orgs: [{ id: ORG, ticket_prefix: "KE", ticket_record_code: "DDRT", ticket_number_pad: 4 }],
    org_configurations: [{
      org_id: ORG, key: "drafting", data: {
        requestTypes: { label: "Type", enabled: true, options: [{ label: "ISO", value: "ISO" }, { label: "As-Built", value: "ASBUILT" }] },
        units: { label: "Unit", enabled: true, options: [{ label: "Unit 100", value: "100" }, { label: "Unit 200", value: "200" }] },
        priorities: { label: "P", enabled: true, options: [{ label: "1", value: 1 }, { label: "3", value: 3 }] },
        customCategories: [{ id: "wo", label: "Work order", enabled: true, fields: [{ key: "wo_number", label: "Work Order #", type: "text", required: true }] }],
      },
    }],
    documents: [
      { id: DOC, org_id: ORG, document_number: "P-101", title: "Flare header", name: "p101.pdf", rev: "4", current_version_id: V4, metadata: { Unit: "Unit 200" } },
      { id: DOC2, org_id: ORG, document_number: "P-102", title: "Knockout drum", name: "p102.pdf", rev: "2", current_version_id: "eeeeeeee-0000-4000-8000-000000000022", metadata: {} },
      { id: DOC_FOREIGN, org_id: OTHER_ORG, document_number: "X-1", title: "Not ours", name: "x.pdf", rev: "1", current_version_id: null, metadata: {} },
    ],
    document_versions: [
      { id: V3, record_id: DOC, revision_label: "3" },
      { id: V4, record_id: DOC, revision_label: "4" },
    ],
    notification_preferences: [{ user_id: SUP2, email_enabled: true, email_on_assignment: false }],
    tickets: [],
    notifications: [],
    email_notifications: [],
    codebook_entries: [],
  };
  s.users = { "tok-req": { id: REQ, email: "rita@plant.io" }, "tok-sup": { id: SUP, email: "sam@plant.io" }, "tok-out": { id: "aaaaaaaa-0000-4000-8000-0000000000ff", email: "out@x.io" } };
  s.objects = new Map([[staged("redline.pdf"), 2 * 1024 * 1024], [`orgs/${ORG}/libraries/l1/p101-r4.pdf`, 1]]);
}

beforeEach(() => {
  seed();
  s.counter = new Map();
  s.rpcCalls = [];
  s.emailGate = null;
  s.errors = {};
  s.hooks = [];
  s.r2Fail = {};
  s.r2Ops = [];
  s.anonWrites = [];
  s.after = [];
  s.seq = 0;
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const req = (body: unknown, token = "tok-req", method = "POST") => new NextRequest("https://app.plant.io/api/tickets/create", {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
const portal = (over: Row = {}) => ({
  orgId: ORG, title: "Re-route the flare header", description: "Move the tie-in 2 m east.", requestType: "ISO", priority: 3,
  unit: "200", requesterRole: "Requester",
  customCategories: { wo: { wo_number: "WO-77" } },
  sourceDocuments: [{ id: DOC, documentNumber: "P-101", title: "Flare header", rev: "4", versionId: null }],
  attachments: [
    { kind: "source_reference", key: `orgs/${ORG}/libraries/l1/p101-r4.pdf`, name: "p101-r4.pdf" },
    { kind: "staged", key: staged("redline.pdf"), name: "redline.pdf" },
  ],
  origin: { kind: "portal" },
  ...over,
});
const checkin = (over: Row = {}, origin: Row = {}) => ({
  orgId: ORG, title: "As-Built Discrepancy: Flare header", description: "Valve moved.\n\nMOC: NONE ON RECORD — flagged as an undocumented field change.",
  requestType: "ASBUILT", priority: 1, unit: null, requesterRole: "Requester",
  sourceDocuments: [{ id: DOC, documentNumber: "P-101", title: "Flare header", rev: "4", versionId: V4 }],
  attachments: [],
  origin: { kind: "checkin", episodeId: EPISODE, checkoutNumber: 7, purpose: "As-Built Verification", outcome: "discrepancy", moc: { status: "none", number: null }, minorCorrection: false, undocumentedChange: true, ...origin },
  ...over,
});
const collision = () => ({
  orgId: ORG, title: "Intake collision: P-101 (contractor)", description: "conflicts", requestType: "Revision", priority: 1, unit: null, requesterRole: null,
  sourceDocuments: [{ id: DOC2, documentNumber: "P-102", title: "Knockout drum", rev: "2", versionId: null }],
  origin: { kind: "intake_collision", projectId: PROJECT, intakeLinkId: "link-1", numberCollisionDocId: DOC, overlaps: [{ id: DOC, label: "P-101", sharedTags: ["V-1"] }], sheetLabel: "P-101 (contractor)" },
});
const tickets = () => s.tables.tickets ?? [];
const bell = () => s.tables.notifications ?? [];
const mail = () => s.tables.email_notifications ?? [];
const nextTicketRpc = () => s.rpcCalls.filter((c) => c.fn === "next_ticket_number");

describe("REGRESSION — each door's legitimate flow files the same ticket, now server-side", () => {
  it("the request form: numbered, stamped from the membership, attachments re-keyed, the queue told by bell and email before the response", async () => {
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ticketNumber: `KE-DDRT-${YY}-0001`, resumed: false, notified: true });
    expect(tickets()).toHaveLength(1);
    const t = tickets()[0];
    expect(t).toMatchObject({
      id: body.id, org_id: ORG, ticket_id: `KE-DDRT-${YY}-0001`, title: "Re-route the flare header", description: "Move the tie-in 2 m east.",
      unit: "200", request_type: "ISO", priority: 3, status: "PENDING_ASSIGNMENT",
      requester_id: REQ, requester_email: "rita@plant.io", requester_role: "Requester", requester_name: "Rita Requester",
      watchers: [REQ], comments: [], unread_by: [],
    });
    expect(typeof t.target_completion_at).toBe("string");
    expect(t.created_at).toBe(t.history && (t.history as Row[])[0].date);
    expect(t.history).toEqual([
      expect.objectContaining({ action: "Created", user: "rita@plant.io", role: "Requester", details: "Ticket created via portal" }),
      expect.objectContaining({ action: "Source Linked", details: "Sent from document viewer · P-101 Rev 4" }),
    ]);
    const meta = t.metadata as Row;
    expect(meta.custom_categories).toEqual({ wo: { wo_number: "WO-77" } });
    expect(meta.source_document).toEqual({ id: DOC, document_number: "P-101", title: "Flare header", rev: "4", version_id: V4 });
    expect(meta.source_documents).toBeUndefined();
    // attachments: the library reference as it was; the staged file moved under the number
    const atts = t.attachments as Row[];
    expect(atts.map((a) => [a.name, a.url, a.type, a.status])).toEqual([
      ["p101-r4.pdf", `orgs/${ORG}/libraries/l1/p101-r4.pdf`, "Source", "submitted"],
      ["redline.pdf", `orgs/${ORG}/tickets/KE-DDRT-${YY}-0001/1727000000000_redline.pdf`, "Source", "submitted"],
    ]);
    expect(atts[1].size).toBe("2.00 MB");
    expect(s.objects.has(staged("redline.pdf"))).toBe(false);
    expect(s.objects.has(`orgs/${ORG}/tickets/KE-DDRT-${YY}-0001/1727000000000_redline.pdf`)).toBe(true);
    // the routing pool (supervisors; the Admin steps aside) — bell rows written as the service role
    expect(s.anonWrites).toEqual([]);
    expect(bell().map((n) => n.user_id).sort()).toEqual([SUP, SUP2].sort());
    for (const n of bell()) {
      expect(n).toMatchObject({
        org_id: ORG, kind: "request_pending_approval", title: "New drafting request: Re-route the flare header",
        body: "Ready for a drafter to be assigned.", link: `/requests/${body.id}`, resource_type: "ticket", resource_id: body.id,
        actor_user_id: REQ,
      });
      expect(n.metadata).toMatchObject({ action: "created", status: "PENDING_ASSIGNMENT", request_type: "ISO", priority: 3, unit: "200" });
    }
    // email: SUP gets one (SUP2 has assignments off — EDGE-1), with an absolute link
    expect(mail().map((m) => m.to_user_id)).toEqual([SUP]);
    expect(mail()[0]).toMatchObject({ event_type: "assignment", resource_type: "ticket", resource_id: body.id, status: "queued", to_email: "sam@plant.io" });
    expect(String(mail()[0].body_text)).toContain(`https://app.plant.io/requests/${body.id}`);
    expect(String(mail()[0].body_html)).toContain(`href="https://app.plant.io/requests/${body.id}"`);
    expect(mail()[0].metadata).toMatchObject({ action: "created", status: "PENDING_ASSIGNMENT" });
    // the number was allocated as the caller, never the service role
    expect(nextTicketRpc().map((c) => c.client)).toEqual(["caller"]);
    // the email drain is kicked after the response
    expect(s.after).toHaveLength(1);
  });

  it("a check-in: the as-built ticket keeps its check-in facts, MOC line and source version; unit derived from the document", async () => {
    const res = await POST(req(checkin()));
    expect(res.status).toBe(201);
    const t = tickets()[0];
    expect(t).toMatchObject({ title: "As-Built Discrepancy: Flare header", request_type: "ASBUILT", priority: 1, unit: "200", status: "PENDING_ASSIGNMENT", watchers: [REQ] });
    expect(t.history).toEqual([expect.objectContaining({
      action: "Created via Check-in", user: "rita@plant.io", role: "Requester",
      details: "Source Document: P-101 Rev 4 · MOC: NONE ON RECORD — flagged as an undocumented field change.",
    })]);
    expect(t.metadata).toMatchObject({
      source_document: { id: DOC, document_number: "P-101", title: "Flare header", rev: "4", version_id: V4 },
      checkin: { episodeId: EPISODE, checkoutNumber: 7, purpose: "As-Built Verification", outcome: "discrepancy" },
      moc: { status: "none", number: null },
      undocumented_change: true,
    });
    expect((t.metadata as Row).minor_correction).toBeUndefined();
    expect((t.metadata as Row).unit_unknown).toBeUndefined();
    expect(bell()[0]).toMatchObject({ body: "Created from a document check-in. Ready for a drafter to be assigned.", title: "New drafting request: As-Built Discrepancy: Flare header" });
    // ROUTE-4: the check-in door now emails too (it was bell-only)
    expect(mail().map((m) => m.to_user_id)).toEqual([SUP]);
  });

  it("a minor-correction check-in keeps metadata.minor_correction (DEC-11 provenance)", async () => {
    await POST(req(checkin({ requestType: "Revision", priority: 2 }, { outcome: "correction", moc: null, minorCorrection: true, undocumentedChange: false })));
    expect(tickets()[0].metadata).toMatchObject({ minor_correction: true });
    expect((tickets()[0].metadata as Row).moc).toBeUndefined();
  });

  it("an intake collision: the collision facts, the opening history line and the collision notice", async () => {
    const res = await POST(req(collision()));
    expect(res.status).toBe(201);
    const t = tickets()[0];
    expect(t).toMatchObject({ title: "Intake collision: P-101 (contractor)", request_type: "Revision", priority: 1, watchers: [REQ], requester_role: "Requester" });
    expect(typeof t.target_completion_at).toBe("string");
    expect(t.history).toEqual([expect.objectContaining({ action: "Created from transition-in impact scan", user: "rita@plant.io", details: "Project intake sheet: P-101 (contractor)" })]);
    expect((t.metadata as Row).intake_collision).toMatchObject({ projectId: PROJECT, intakeLinkId: "link-1", numberCollisionDocId: DOC, overlaps: [{ id: DOC, label: "P-101", sharedTags: ["V-1"] }] });
    expect(typeof ((t.metadata as Row).intake_collision as Row).flaggedAt).toBe("string");
    expect(bell()[0]).toMatchObject({
      title: "Intake collision flagged: P-101 (contractor)",
      body: "A submitted sheet collides with an existing document number — needs a drafter and a source-of-truth decision.",
    });
  });

  it("the second request of the year gets the next number", async () => {
    await POST(req(portal({ attachments: [] })));
    const res = await POST(req(portal({ attachments: [] })));
    expect((await res.json()).ticketNumber).toBe(`KE-DDRT-${YY}-0002`);
  });
});

describe("20261038 ticket_insert_integrity, replicated for the service-role insert", () => {
  it("the newest ticket_insert_integrity is still 20261038's — its rules are what lib/ticketCreate.ts copies", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const defining = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()
      .filter((f) => /CREATE OR REPLACE FUNCTION ticket_insert_integrity\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(defining.at(-1)).toBe("20261038_rp_phase4_ticket_workflow_rails.sql");
    const sql = readFileSync(join(dir, defining.at(-1)!), "utf8");
    expect(sql).toContain("NEW.requester_id := auth.uid();");
    expect(sql).toContain("IF NEW.requester_role IS NULL OR NOT (NEW.requester_role = ANY(v_roles)) THEN\n    NEW.requester_role := v_role;");
    expect(sql).toContain("SELECT role, COALESCE(roles, ARRAY[role]), email INTO v_role, v_roles, v_email");
    expect(sql).toContain("NEW.status := 'PENDING_ASSIGNMENT';");
    const builtin = sql.match(/NEW\.request_type NOT IN \(([^)]+)\)/)![1].split(",").map((x) => x.trim().replace(/'/g, ""));
    expect([...BUILTIN_REQUEST_TYPES]).toEqual(builtin);
  });

  it("the role rule, line for line: a held role is kept, anything else becomes the headline (COALESCE(roles, ARRAY[role]))", () => {
    expect(stampedRequesterRole("Engineer-4", { role: "Requester", roles: ["Requester"], email: null })).toBe("Requester");
    expect(stampedRequesterRole("Engineer-2", { role: "Manager", roles: ["Manager", "Engineer-2"], email: null })).toBe("Engineer-2");
    expect(stampedRequesterRole(null, { role: "Drafter", roles: ["Drafter"], email: null })).toBe("Drafter");
    expect(stampedRequesterRole("Manager", { role: "Manager", roles: null, email: null })).toBe("Manager");
  });

  it("a forged role is replaced by the headline; the requester is always the caller; nothing arrives assigned, approved or closed", async () => {
    const res = await POST(req({ ...portal({ attachments: [] }), requesterRole: "Engineer-4", requester_id: SUP, status: "PENDING_IFC", assigned_drafter_id: SUP, engineer_approved_at: "2026-01-01" }));
    expect(res.status).toBe(201);
    const t = tickets()[0];
    expect(t).toMatchObject({ requester_role: "Requester", requester_id: REQ, status: "PENDING_ASSIGNMENT" });
    for (const col of ["assigned_drafter_id", "assigned_engineer_id", "engineer_approved_at", "closed_at", "archived_at"]) expect(t[col]).toBeUndefined();
  });

  it("only an active member files: a non-member is 403 and nothing is allocated or written", async () => {
    const res = await POST(req(portal({ attachments: [] }), "tok-out"));
    expect(res.status).toBe(403);
    expect(nextTicketRpc()).toHaveLength(0);
    expect(tickets()).toHaveLength(0);
  });

  it("a request type the workspace does not offer is refused (400, field requestType); the built-in vocabulary passes; an unconfigured workspace takes any type", async () => {
    const bad = await POST(req(portal({ requestType: "Teleport", attachments: [] })));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "requestType" });
    expect(nextTicketRpc()).toHaveLength(0);
    expect((await POST(req(portal({ requestType: "RFI", attachments: [] })))).status).toBe(201);
    s.tables.org_configurations = [];
    expect((await POST(req(portal({ requestType: "Teleport", unit: "ANY-TEXT", customCategories: null, attachments: [] })))).status).toBe(201);
  });

  it("AUTHZ-3: the requester's name comes from the membership (display name, else the email's local part), never the client", async () => {
    s.tables.org_members[0].display_name = null;
    await POST(req({ ...portal({ attachments: [] }), requester_name: "The CEO" }));
    expect(tickets()[0].requester_name).toBe("rita");
  });
});

describe("EDGE-13 — validate, THEN number; staged files never outlive a refusal", () => {
  it("a missing required custom field: 400 naming the field, no number allocated, the staged file deleted", async () => {
    const res = await POST(req(portal({ customCategories: { wo: { wo_number: "" } } })));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "custom:wo.wo_number", error: '"Work Order #" (Work order) is required.' });
    expect(nextTicketRpc()).toHaveLength(0);
    expect(tickets()).toHaveLength(0);
    expect(s.objects.has(staged("redline.pdf"))).toBe(false);
  });

  it("REGRESSION: a required form field never stops a check-in or an intake collision (they have no form to fill)", async () => {
    expect((await POST(req(checkin()))).status).toBe(201);
    expect((await POST(req(collision()))).status).toBe(201);
  });

  it("a malformed body (no title) is refused before anything else, and its staged file goes too", async () => {
    const res = await POST(req(portal({ title: "   " })));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "title" });
    expect(s.objects.has(staged("redline.pdf"))).toBe(false);
    expect(nextTicketRpc()).toHaveLength(0);
  });

  it("a staged file that is not the caller's, or never arrived, is refused before a number is spent", async () => {
    const foreign = staged("x.pdf", SUP);
    s.objects.set(foreign, 1);
    const r1 = await POST(req(portal({ attachments: [{ kind: "staged", key: foreign, name: "x.pdf" }] })));
    expect(r1.status).toBe(400);
    expect(s.objects.has(foreign)).toBe(true);           // someone else's file is never touched
    const r2 = await POST(req(portal({ attachments: [{ kind: "staged", key: staged("never.pdf"), name: "never.pdf" }] })));
    expect(r2.status).toBe(400);
    expect(await r2.json()).toMatchObject({ field: "attachments" });
    expect(nextTicketRpc()).toHaveLength(0);
  });

  it("storage that cannot answer is a 503 (try again), not a 'did not finish uploading'; nothing is numbered", async () => {
    s.r2Fail.head = 1;
    const res = await POST(req(portal()));
    expect(res.status).toBe(503);
    expect(nextTicketRpc()).toHaveLength(0);
    expect(tickets()).toHaveLength(0);
  });

  it("a failed insert releases its number when none was handed out after it — the next request reuses it", async () => {
    s.errors["tickets.insert"] = [{ code: "XX000", message: "disk full" }];
    const res = await POST(req(portal()));
    expect(res.status).toBe(500);
    expect(tickets()).toHaveLength(0);
    expect(s.objects.has(staged("redline.pdf"))).toBe(false);
    expect(s.tables.ticket_number_counters[0].next_seq).toBe(0);
    s.counter.set(`${ORG}:${YEAR}`, 0);   // the counter row as the release left it
    s.objects.set(staged("redline.pdf"), 5);
    const again = await POST(req(portal()));
    expect((await again.json()).ticketNumber).toBe(`KE-DDRT-${YY}-0001`);
  });

  it("a failed insert after another submission took the next number keeps the gap — never a reused number", async () => {
    s.hooks.push((table, op) => {
      if (table === "tickets" && op === "insert" && s.counter.get(`${ORG}:${YEAR}`) === 1) {
        s.counter.set(`${ORG}:${YEAR}`, 2);
        s.tables.ticket_number_counters[0].next_seq = 2;
      }
    });
    s.errors["tickets.insert"] = [{ code: "XX000", message: "disk full" }];
    expect((await POST(req(portal({ attachments: [] })))).status).toBe(500);
    expect(s.tables.ticket_number_counters[0].next_seq).toBe(2);
  });

  it("a number the counter cannot hand out is a 503 with nothing written", async () => {
    s.errors["rpc.next_ticket_number"] = [{ code: "42883", message: "function next_ticket_number does not exist" }];
    const res = await POST(req(portal()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/apply migration 20260724_ticket_numbering\.sql/);
    expect(tickets()).toHaveLength(0);
    expect(s.objects.has(staged("redline.pdf"))).toBe(false);
  });

  it("a staged file whose move fails stays on the row where it was staged — never unreferenced", async () => {
    s.r2Fail.copy = 1;
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    expect((await res.json()).unmovedAttachments).toBe(1);
    const att = (tickets()[0].attachments as Row[])[1];
    expect(att.url).toBe(staged("redline.pdf"));
    expect(s.objects.has(staged("redline.pdf"))).toBe(true);
  });

  it("a writer that lands between the insert and the re-key keeps its change; the copy is still pointed at", async () => {
    let done = false;
    s.hooks.push((table, op) => {
      if (!done && table === "tickets" && op === "update") {
        done = true;
        const t = tickets()[0];
        t.attachments = [...(t.attachments as Row[]), { id: "late", name: "late.pdf", url: `orgs/${ORG}/tickets/x/late.pdf`, type: "Reference", status: "submitted" }];
        t.last_modified = "2099-01-01T00:00:00.000Z";
      }
    });
    expect((await POST(req(portal()))).status).toBe(201);
    const urls = (tickets()[0].attachments as Row[]).map((a) => a.url);
    expect(urls).toEqual([
      `orgs/${ORG}/libraries/l1/p101-r4.pdf`,
      `orgs/${ORG}/tickets/KE-DDRT-${YY}-0001/1727000000000_redline.pdf`,
      `orgs/${ORG}/tickets/x/late.pdf`,
    ]);
    expect(s.objects.has(staged("redline.pdf"))).toBe(false);
  });
});

describe("EDGE-1 / EDGE-12 — the email leg reads the recipient's preferences where they are visible", () => {
  it("before 20261148 (email_gate missing): email_enabled=false and email_on_assignment=false each stop the email; the bell row stays", async () => {
    s.tables.notification_preferences.push({ user_id: SUP, email_enabled: false });
    await POST(req(portal({ attachments: [] })));
    expect(mail()).toHaveLength(0);
    expect(bell().map((n) => n.user_id).sort()).toEqual([SUP, SUP2].sort());
  });

  it("after 20261148: email_gate's answer decides, asked as the service role", async () => {
    s.emailGate = (args) => ({ data: args.p_to_user !== SUP, error: null });
    await POST(req(portal({ attachments: [] })));
    expect(mail().map((m) => m.to_user_id)).toEqual([SUP2]);
    expect(s.rpcCalls.filter((c) => c.fn === "email_gate").every((c) => c.client === "admin")).toBe(true);
  });

  it("the same (recipient, event, resource) email queued twice within 60 s lands once on the server path the route uses", async () => {
    const input = { orgId: ORG, toUserId: SUP, toEmail: "sam@plant.io", subject: "New drafting request: X", bodyText: "Ready.", resourceType: "ticket" as const, resourceId: "t-1", eventType: "assignment" };
    await runWithServerClient(supabaseAdmin, () => queueEmail(input));
    await runWithServerClient(supabaseAdmin, () => queueEmail(input));
    expect(mail()).toHaveLength(1);
    await runWithServerClient(supabaseAdmin, () => queueEmail({ ...input, resourceId: "t-2" }));
    expect(mail()).toHaveLength(2);
  });
});

describe("ROUTE-11 — the creation notice is retired like every workflow alert", () => {
  it("once the ticket leaves PENDING_ASSIGNMENT (a supervisor assigns it, through the real workflow route), no creation alert is left live in any bell", async () => {
    const DRAFTER = "aaaaaaaa-0000-4000-8000-000000000005";
    s.tables.org_members.push(member(DRAFTER, "Drafter", { email: "dan@plant.io", display_name: "Dan Drafter" }));
    const created = await (await POST(req(portal({ attachments: [] })))).json();
    const creation = () => bell().filter((n) => (n.metadata as Row).action === "created");
    expect(creation().length).toBe(2);
    const wf = await workflowPOST(new NextRequest("https://app.plant.io/api/tickets/workflow-action", {
      method: "POST",
      headers: { authorization: "Bearer tok-sup", "content-type": "application/json" },
      body: JSON.stringify({ ticketId: created.id, actionType: "assign", assignment: { id: DRAFTER, name: "Dan Drafter" } }),
    }));
    expect(wf.status).toBe(200);
    expect(tickets()[0].status).not.toBe("PENDING_ASSIGNMENT");
    // "live" as the bell reads it: unread and not superseded (lib/inAppNotifications listMyNotifications)
    const live = creation().filter((n) => n.read_at == null && (n.metadata as Row).superseded_at == null);
    expect(live).toEqual([]);
    expect(creation().every((n) => (n.metadata as Row).superseded_by === "assign")).toBe(true);
  });


  it("bell rows carry metadata.action and a string status — both retirement mechanisms' marker", async () => {
    await POST(req(portal({ attachments: [] })));
    for (const n of bell()) {
      const m = n.metadata as Row;
      // the workflow route's supersede: .not("metadata->>action", "is", null)
      expect(m.action).not.toBeNull();
      // the badge hook's reconcile: typeof status === 'string' && action != null
      expect(typeof m.status).toBe("string");
      expect(m.status).toBe(tickets()[0].status);
    }
    const src = readFileSync(join(process.cwd(), "app/api/tickets/workflow-action/route.ts"), "utf8");
    expect(src).toContain('.not("metadata->>action", "is", null)');
  });
});

describe("LEAK-6 — a check-in resumes the ticket its episode already filed", () => {
  it("an open ticket for this episode and requester: 200 resumed, nothing allocated, inserted or announced, the staged file discarded", async () => {
    s.tables.tickets.push({ id: "t-old", org_id: ORG, ticket_id: "KE-DDRT-26-0042", requester_id: REQ, status: "PENDING_ASSIGNMENT", created_at: "2026-10-01", metadata: { checkin: { episodeId: EPISODE } } });
    s.objects.set(staged("photo.jpg"), 10);
    const res = await POST(req(checkin({ attachments: [{ kind: "staged", key: staged("photo.jpg"), name: "photo.jpg" }] })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "t-old", ticketNumber: "KE-DDRT-26-0042", resumed: true });
    expect(tickets()).toHaveLength(1);
    expect(nextTicketRpc()).toHaveLength(0);
    expect(bell()).toHaveLength(0);
    expect(s.objects.has(staged("photo.jpg"))).toBe(false);
  });

  it("a closed or canceled ticket, or another requester's, is not resumed", async () => {
    s.tables.tickets.push(
      { id: "t-closed", org_id: ORG, ticket_id: "A", requester_id: REQ, status: "CLOSED", metadata: { checkin: { episodeId: EPISODE } } },
      { id: "t-theirs", org_id: ORG, ticket_id: "B", requester_id: SUP, status: "DRAFTING", metadata: { checkin: { episodeId: EPISODE } } },
    );
    const res = await POST(req(checkin()));
    expect(res.status).toBe(201);
    expect(tickets()).toHaveLength(3);
  });

  it("a lookup that fails is a 503 — never a second ticket", async () => {
    s.tables.tickets.push({ id: "t-old", org_id: ORG, ticket_id: "A", requester_id: REQ, status: "DRAFTING", metadata: { checkin: { episodeId: EPISODE } } });
    s.errors["tickets.select"] = [{ code: "57014", message: "statement timeout" }];
    const res = await POST(req(checkin()));
    expect(res.status).toBe(503);
    expect(tickets()).toHaveLength(1);
    expect(nextTicketRpc()).toHaveLength(0);
  });
});

describe("HAND-7 / GAP-8 — the source documents, in this workspace, with the version each was raised against", () => {
  it("a named version of the document is kept; a rev the requester saw that is no longer current captures no version", async () => {
    await POST(req(checkin({ sourceDocuments: [{ id: DOC, documentNumber: "P-101", title: "Flare header", rev: "3", versionId: V3 }] })));
    expect((tickets()[0].metadata as Row).source_document).toMatchObject({ rev: "3", version_id: V3 });
    await POST(req(portal({ attachments: [], sourceDocuments: [{ id: DOC, documentNumber: "P-101", title: null, rev: "3", versionId: null }] })));
    expect((tickets()[1].metadata as Row).source_document).toMatchObject({ rev: "3", version_id: null });
  });

  it("a version id that is not a version of THIS document is never recorded", async () => {
    await POST(req(checkin({ sourceDocuments: [{ id: DOC2, documentNumber: "P-102", title: null, rev: "2", versionId: V3 }] }, { episodeId: null })));
    expect((tickets()[0].metadata as Row).source_document).toMatchObject({ id: DOC2, version_id: "eeeeeeee-0000-4000-8000-000000000022" });
  });

  it("a document from another workspace is refused (400) — it is never stored", async () => {
    const res = await POST(req(portal({ attachments: [], sourceDocuments: [{ id: DOC_FOREIGN, documentNumber: null, title: null, rev: null, versionId: null }] })));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "sourceDocuments" });
    expect(nextTicketRpc()).toHaveLength(0);
  });

  it("several sheets: the primary is the singular source_document, every sheet is in source_documents", async () => {
    await POST(req(portal({ attachments: [], sourceDocuments: [
      { id: DOC, documentNumber: "P-101", title: null, rev: "4", versionId: null },
      { id: DOC2, documentNumber: "P-102", title: null, rev: null, versionId: null },
    ] })));
    const m = tickets()[0].metadata as Row;
    expect((m.source_document as Row).id).toBe(DOC);
    expect((m.source_documents as Row[]).map((d) => d.id)).toEqual([DOC, DOC2]);
  });
});

describe("FRIC-3 / DCW-7 — the unit is optional, explicit when unknown, resolved against the list", () => {
  it("no unit and no source document: NULL with metadata.unit_unknown — never a refusal", async () => {
    const res = await POST(req(portal({ unit: null, sourceDocuments: [], attachments: [] })));
    expect(res.status).toBe(201);
    expect(tickets()[0].unit).toBeNull();
    expect((tickets()[0].metadata as Row).unit_unknown).toBe(true);
  });

  it("no unit given but a source document names one: derived and resolved to the list's value ('Unit 200' → '200')", async () => {
    await POST(req(portal({ unit: null, attachments: [] })));
    expect(tickets()[0].unit).toBe("200");
  });

  it("the request form's unit must be on the list (400, field unit); a check-in's derived unit that is not is kept as derived and marked", async () => {
    const bad = await POST(req(portal({ unit: "999", attachments: [] })));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "unit" });
    s.tables.documents[0].metadata = { Unit: "Tank farm" };
    await POST(req(checkin()));
    expect(tickets()[0].unit).toBe("Tank farm");
    expect((tickets()[0].metadata as Row).unit_unlisted).toBe(true);
  });

  it("with no configured units the Site Codebook's are the list", async () => {
    (s.tables.org_configurations[0].data as Row).units = { label: "Unit", enabled: true, options: [] };
    s.tables.codebook_entries = [{ org_id: ORG, kind: "unit", code: "20", label: "Crude" }];
    expect((await POST(req(portal({ unit: "20 — Crude", attachments: [] })))).status).toBe(201);
    expect(tickets()[0].unit).toBe("20");
    expect((await POST(req(portal({ unit: "30", attachments: [] })))).status).toBe(400);
  });
});

describe("the contract's seams (DEC-34 declaration, DEC-40 projectId) travel and are ignored", () => {
  it("a declaration and a projectId are parsed and not written", async () => {
    const parsed = parseTicketCreateBody({ ...portal(), declaration: { text: "like for like" }, projectId: PROJECT });
    expect(parsed.ok && parsed.input.declaration).toEqual({ text: "like for like" });
    expect(parsed.ok && parsed.input.projectId).toBe(PROJECT);
    await POST(req({ ...portal({ attachments: [] }), declaration: { text: "x" }, projectId: PROJECT }));
    expect(tickets()[0].project_id).toBeUndefined();
    expect(JSON.stringify(tickets()[0].metadata)).not.toContain("declaration");
  });
});

describe("DELETE — discarding files staged for a submit that never reached the route", () => {
  it("deletes the caller's own unreferenced staged keys; never another's, never one a ticket names", async () => {
    const mine = staged("a.pdf");
    const named = staged("b.pdf");
    const theirs = staged("c.pdf", SUP);
    for (const k of [mine, named, theirs]) s.objects.set(k, 1);
    s.tables.tickets.push({ id: "t1", org_id: ORG, attachments: [{ id: "x", url: named }] });
    const res = await DELETE(req({ orgId: ORG, keys: [mine, named, theirs] }, "tok-req", "DELETE"));
    expect(await res.json()).toMatchObject({ ok: true, deleted: 1, refused: 2 });
    expect(s.objects.has(mine)).toBe(false);
    expect(s.objects.has(named)).toBe(true);
    expect(s.objects.has(theirs)).toBe(true);
  });

  it("needs a session", async () => {
    expect((await DELETE(req({ orgId: ORG, keys: [staged("a.pdf")] }, "nope", "DELETE"))).status).toBe(401);
    expect((await POST(req(portal(), "nope"))).status).toBe(401);
  });
});
