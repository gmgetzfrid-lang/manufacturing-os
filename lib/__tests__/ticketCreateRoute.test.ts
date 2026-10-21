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
//
// Fix pass (review of DF-P2):
//   * a failed insert gives its number back ONLY when nothing was written: a
//     23505 keeps the number and files under a fresh one; a write that
//     committed but whose reply was lost is found and carried on; an
//     ambiguous failure keeps the number and the staged files (EDGE-13);
//   * the form and the route use one unit list (no built-in units); a
//     derived unit tries each candidate; the opening history line carries
//     the stamped role; the origin is checked against its own facts; an
//     unusable hand-off is dropped with a warning; the numbering read is
//     checked; no branch deletes a staged key a ticket names; the notice is
//     written before the re-key, which keeps to a time budget.
//
// Fix pass 2 (second review of DF-P2):
//   * the PSM escalation of an undocumented field change is the ROUTE's:
//     sent once, stamped metadata.psm_escalated_at, and sent by a resumed
//     check-in only when the stamp is missing (a lost first reply, a first
//     attempt that answered insert_unconfirmed) — LIFE-7 / LEAK-6;
//   * source documents are read AS THE CALLER (documents_acl_select): one
//     they cannot see is treated exactly like one that is not here;
//   * a sheet list past MAX_SOURCE_DOCUMENTS files with a warning;
//   * the stored overlap list is complete (or counted and flagged);
//   * the number's year is the requester's own when it is in force
//     somewhere; the collision origin is checked against the project's
//     intake folder and links; the re-key runs after the answer.

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
  // DF-P8 fix pass 2: the caller's answers for the register-authority
  // functions (is_org_controller / can_manage_project); unset → false.
  callerRpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: { code?: string; message: string } | null }>,
  callerToken: "" as string,
  emailGate: null as null | ((args: Record<string, unknown>) => { data: unknown; error: Err | null }),
  /** `${table}.${op}` → errors handed out one per call, in order. */
  errors: {} as Record<string, Array<Err | null>>,
  /** `${table}.${op}` → the statement RUNS (the row is written) and then this
   *  error is what the caller sees: a write that committed but whose reply
   *  was lost on the way back. */
  lostReply: {} as Record<string, Array<Err | null>>,
  /** run before a statement executes: a test acts as a second writer. */
  hooks: [] as Array<(table: string, op: string) => void>,
  r2Fail: {} as Record<string, number>,   // "copy" | "head" | "delete" → how many calls fail
  r2Ops: [] as Array<{ op: string; key: string; from?: string; bellRows?: number }>,
  anonWrites: [] as Array<{ table: string; op: string }>,
  after: [] as Array<() => unknown>,
  seq: 0,
}));

/** The caller as the caller-scoped client sees them (RLS: auth.uid()). */
const callerUid = () => s.users[s.callerToken]?.id ?? null;

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
function chain(table: string, client: "admin" | "anon" | "caller") {
  const filters: F[] = [];
  // documents_acl_select (node_visible) as the caller-scoped client meets
  // it: a row with `visible_to` is returned only to the uids it names.
  if (client === "caller" && table === "documents") {
    filters.push((r) => !Array.isArray(r.visible_to) || (r.visible_to as string[]).includes(String(callerUid())));
  }
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
      const list: Row[] = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: r.id ?? `${table}-${++s.seq}`, created_at: r.created_at ?? new Date().toISOString(), ...r }));
      // schema.sql tickets: UNIQUE(org_id, ticket_id)
      if (table === "tickets" && list.some((r) => rows.some((x) => x.org_id === r.org_id && x.ticket_id === r.ticket_id))) {
        return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "tickets_org_id_ticket_id_key"' } };
      }
      rows.push(...list.map((r) => JSON.parse(JSON.stringify(r))));
      const lost = s.lostReply[`${table}.${op}`];
      if (lost && lost.length > 0) {
        const e = lost.shift();
        if (e) return { data: null, error: e };
      }
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
      from: (t: string) => chain(t, "caller"),
      rpc: async (fn: string, args: { p_org: string; p_year: number }) => {
        s.rpcCalls.push({ client: "caller", fn, args });
        if (fn !== "next_ticket_number") { const answer = s.callerRpc[fn]; return answer ? answer(args) : { data: false, error: null }; }
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
        s.r2Ops.push({ op: "copy", key, from, bellRows: (s.tables.notifications ?? []).length });
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
import {
  BUILTIN_REQUEST_TYPES, stampedRequesterRole, parseTicketCreateBody, insertFailureKind, requestNumberYear, checkinNoteOf,
  psmAlertNotice, capSourceDocuments, MAX_SOURCE_DOCUMENTS, MAX_COLLISION_OVERLAPS,
} from "@/lib/ticketCreate";

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
const PROJECT2 = "ffffffff-0000-4000-8000-000000000002";
const LINK = "99999999-0000-4000-8000-000000000001";
const INTAKE_FOLDER = "c0000000-0000-4000-8000-000000000001";
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
      // P-102 is an intake sheet: it sits in the project's intake folder.
      { id: DOC2, org_id: ORG, document_number: "P-102", title: "Knockout drum", name: "p102.pdf", rev: "2", current_version_id: "eeeeeeee-0000-4000-8000-000000000022", collection_id: INTAKE_FOLDER, metadata: {} },
      { id: DOC_FOREIGN, org_id: OTHER_ORG, document_number: "X-1", title: "Not ours", name: "x.pdf", rev: "1", current_version_id: null, metadata: {} },
    ],
    document_versions: [
      { id: V3, record_id: DOC, revision_label: "3" },
      { id: V4, record_id: DOC, revision_label: "4" },
    ],
    notification_preferences: [{ user_id: SUP2, email_enabled: true, email_on_assignment: false }],
    // The check-in's facts: the requester holds a checkout of P-101 in its
    // episode, and an (untagged, legacy) active checkout of P-102.
    checkout_episodes: [{ id: EPISODE, org_id: ORG, document_id: DOC, status: "active" }],
    checkout_sessions: [
      { id: "sess-1", org_id: ORG, document_id: DOC, user_id: REQ, episode_id: EPISODE, status: "active", started_at: "2026-10-07T08:00:00Z" },
      { id: "sess-2", org_id: ORG, document_id: DOC2, user_id: REQ, episode_id: null, status: "active", started_at: "2026-10-07T08:00:00Z" },
    ],
    // The collision's facts: the project it was flagged in, its intake
    // folder (where P-102 sits) and the intake link the sheet came through.
    projects: [
      { id: PROJECT, org_id: ORG, name: "Tie-ins", intake_collection_id: INTAKE_FOLDER },
      { id: PROJECT2, org_id: ORG, name: "Other", intake_collection_id: "c0000000-0000-4000-8000-000000000002" },
    ],
    project_intake_links: [{ id: LINK, org_id: ORG, project_id: PROJECT }],
    audit_logs: [],
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
  s.callerRpc = {};
  s.emailGate = null;
  s.errors = {};
  s.lostReply = {};
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
const collision = (origin: Row = {}) => ({
  orgId: ORG, title: "Intake collision: P-102", description: "conflicts", requestType: "Revision", priority: 1, unit: null, requesterRole: null,
  sourceDocuments: [{ id: DOC2, documentNumber: "P-102", title: "Knockout drum", rev: "2", versionId: null }],
  origin: { kind: "intake_collision", projectId: PROJECT, intakeLinkId: LINK, numberCollisionDocId: DOC, overlaps: [{ id: DOC, label: "P-101", sharedTags: ["V-1"] }], sheetLabel: "P-102", ...origin },
});
const tickets = () => s.tables.tickets ?? [];
const bell = () => s.tables.notifications ?? [];
const mail = () => s.tables.email_notifications ?? [];
const nextTicketRpc = () => s.rpcCalls.filter((c) => c.fn === "next_ticket_number");
/** The creation notice's rows (the PSM escalation is a second, separate notice). */
const creationBell = () => bell().filter((n) => (n.metadata as Row | null)?.action === "created");
const creationMail = () => mail().filter((m) => m.event_type === "assignment");
const psmBell = () => bell().filter((n) => String(n.title).startsWith("PSM alert"));
const psmMail = () => mail().filter((m) => m.event_type === "safety_alert");
/** Run what the route left for after its answer (the re-key, the drain
 *  kick — whose fetch is answered here, never sent). */
async function settle() {
  const pending = s.after.splice(0);
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  try {
    for (const fn of pending) await fn();
  } finally {
    globalThis.fetch = real;
  }
}

describe("REGRESSION — each door's legitimate flow files the same ticket, now server-side", () => {
  it("the request form: numbered, stamped from the membership, attachments re-keyed after the answer, the queue told by bell and email before the response", async () => {
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ticketNumber: `KE-DDRT-${YY}-0001`, resumed: false, notified: true });
    // the re-key and the drain kick run after the answer
    expect(s.after).toHaveLength(2);
    await settle();
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
    expect(creationMail().map((m) => m.to_user_id)).toEqual([SUP]);
    // LIFE-7: the undocumented field change went to the controllers too
    expect(psmBell().map((n) => n.user_id)).toEqual([ADMIN]);
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
    expect(t).toMatchObject({ title: "Intake collision: P-102", request_type: "Revision", priority: 1, watchers: [REQ], requester_role: "Requester" });
    expect(typeof t.target_completion_at).toBe("string");
    expect(t.history).toEqual([expect.objectContaining({ action: "Created from transition-in impact scan", user: "rita@plant.io", details: "Project intake sheet: P-102" })]);
    expect((t.metadata as Row).intake_collision).toMatchObject({ projectId: PROJECT, intakeLinkId: LINK, numberCollisionDocId: DOC, overlaps: [{ id: DOC, label: "P-101", sharedTags: ["V-1"] }] });
    expect(typeof ((t.metadata as Row).intake_collision as Row).flaggedAt).toBe("string");
    expect(bell()[0]).toMatchObject({
      title: "Intake collision flagged: P-102",
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
  it("the newest ticket_insert_integrity keeps 20261038's rules — what lib/ticketCreate.ts copies", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const defining = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()
      .filter((f) => /CREATE OR REPLACE FUNCTION ticket_insert_integrity\(/.test(readFileSync(join(dir, f), "utf8")));
    // drafting-flow DF-P3's 20261195 §2b re-created it from 20261038 with three lines that NULL
    // the SLA stamps and the outcome on a client insert (integrator, at the DF-P3 merge); every
    // rule the create route copies is unchanged, so the newest body is read whichever file holds it.
    // drafting-flow DF-P4's 20261208 re-created it again from 20261195 (a client insert is born
    // with no library and the member's own name); the copied rules are still unchanged.
    expect(defining.slice(-3)).toEqual(["20261038_rp_phase4_ticket_workflow_rails.sql", "20261195_df_roundG_outcome_and_departure.sql", "20261208_df_roundG_ticket_library.sql"]);
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
    await settle();
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
    await settle();
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
    // its creation notice went out (stamped) — the resume owes nothing
    s.tables.tickets.push({ id: "t-old", org_id: ORG, ticket_id: "KE-DDRT-26-0042", requester_id: REQ, status: "PENDING_ASSIGNMENT", created_at: "2026-10-01", metadata: { checkin: { episodeId: EPISODE }, created_notice_at: "2026-10-01T00:00:01.000Z" } });
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

  it("a document from another workspace is never stored — the request is filed without it, and says so", async () => {
    const res = await POST(req(portal({ attachments: [], sourceDocuments: [{ id: DOC_FOREIGN, documentNumber: "X-1", title: null, rev: null, versionId: null }] })));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toEqual(["The linked document X-1 is not in this workspace (it may have been removed) — the request was filed without that link."]);
    expect(JSON.stringify(tickets()[0].metadata ?? {})).not.toContain(DOC_FOREIGN);
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

describe("the contract's seams: the DEC-40 projectId is DF-P8's (confirmed, then written — lib/__tests__/dfRoundG_P8_projects.test.ts); the DEC-34 declaration is DF-P6's (lib/__tests__/reviewModel.test.ts)", () => {
  it("a projectId is parsed and, for a project of the workspace the caller sees, written; a declaration that is present but malformed is refused with the reason, and a blank one never blocks", async () => {
    const parsed = parseTicketCreateBody({ ...portal(), projectId: PROJECT });
    expect(parsed.ok && parsed.input.projectId).toBe(PROJECT);
    const malformed = parseTicketCreateBody({ ...portal(), declaration: { text: "like for like" } });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.field).toBe("declaration");
    const blank = parseTicketCreateBody({ ...portal(), declaration: null });
    expect(blank.ok && blank.input.declaration).toBeFalsy();
    await POST(req({ ...portal({ attachments: [] }), projectId: PROJECT }));
    expect(tickets()[0].project_id).toBe(PROJECT);
    expect(JSON.stringify(tickets()[0].metadata)).not.toContain("declaration");
    // no declaration: nothing is written for one — the database's default (engineered) is the answer
    expect(tickets()[0].engineering_required).toBeUndefined();
    expect(tickets()[0].like_in_kind_statement).toBeUndefined();
  });
});

describe("EDGE-13 — a failed insert gives its number back only when nothing was written", () => {
  it("insertFailureKind: 23505 is a duplicate; a Postgres SQLSTATE is definite; no code, a PostgREST code, class 08 or 57P0x is ambiguous", () => {
    expect(insertFailureKind({ code: "23505" })).toBe("duplicate");
    for (const code of ["XX000", "23502", "23514", "57014", "40001", "42501"]) expect(insertFailureKind({ code })).toBe("definite");
    for (const code of ["", "PGRST116", "08006", "08000", "57P01"]) expect(insertFailureKind({ code })).toBe("ambiguous");
    expect(insertFailureKind(null)).toBe("ambiguous");
    expect(insertFailureKind({})).toBe("ambiguous");
  });

  it("23505 — the number is already on a ticket: it is never given back, and the request files once under a fresh number; the next one moves on", async () => {
    s.tables.tickets.push({ id: "t-legacy", org_id: ORG, ticket_id: `KE-DDRT-${YY}-0001`, requester_id: SUP, status: "DRAFTING", created_at: "2026-10-01" });
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    expect((await res.json()).ticketNumber).toBe(`KE-DDRT-${YY}-0002`);
    expect(tickets()).toHaveLength(2);
    expect(nextTicketRpc()).toHaveLength(2);
    expect(s.tables.ticket_number_counters[0].next_seq).toBe(2);
    await settle();
    expect((tickets()[1].attachments as Row[])[1].url).toBe(`orgs/${ORG}/tickets/KE-DDRT-${YY}-0002/1727000000000_redline.pdf`);
    const next = await POST(req(portal({ attachments: [] })));
    expect((await next.json()).ticketNumber).toBe(`KE-DDRT-${YY}-0003`);
  });

  it("23505 twice: nothing filed, both numbers kept as gaps, the staged file discarded", async () => {
    s.tables.tickets.push(
      { id: "t-a", org_id: ORG, ticket_id: `KE-DDRT-${YY}-0001`, requester_id: SUP, status: "DRAFTING" },
      { id: "t-b", org_id: ORG, ticket_id: `KE-DDRT-${YY}-0002`, requester_id: SUP, status: "DRAFTING" },
    );
    const res = await POST(req(portal()));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/nothing was filed/);
    expect(tickets()).toHaveLength(2);
    expect(s.tables.ticket_number_counters[0].next_seq).toBe(2);
    expect(s.objects.has(staged("redline.pdf"))).toBe(false);
  });

  it("a write that committed but whose reply was lost (code ''): the row is found and the request carries on — filed once, announced, re-keyed; the number is never given back", async () => {
    s.lostReply["tickets.insert"] = [{ code: "", message: "TypeError: fetch failed" }];
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ ticketNumber: `KE-DDRT-${YY}-0001`, resumed: false, notified: true });
    expect(tickets()).toHaveLength(1);
    expect(body.id).toBe(tickets()[0].id);
    expect(s.tables.ticket_number_counters[0].next_seq).toBe(1);
    expect(bell().map((n) => n.user_id).sort()).toEqual([SUP, SUP2].sort());
    await settle();
    expect((tickets()[0].attachments as Row[])[1].url).toBe(`orgs/${ORG}/tickets/KE-DDRT-${YY}-0001/1727000000000_redline.pdf`);
    const next = await POST(req(portal({ attachments: [] })));
    expect(next.status).toBe(201);
    expect((await next.json()).ticketNumber).toBe(`KE-DDRT-${YY}-0002`);
  });

  it("an ambiguous failure with no row (yet): 500 'check the queue', the number kept, the staged file kept for the reference sweep", async () => {
    s.errors["tickets.insert"] = [{ code: "", message: "TypeError: fetch failed" }];
    const res = await POST(req(portal()));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "insert_unconfirmed", error: expect.stringMatching(/check the queue/) });
    expect(s.tables.ticket_number_counters[0].next_seq).toBe(1);
    expect(s.objects.has(staged("redline.pdf"))).toBe(true);
    const next = await POST(req(portal({ attachments: [] })));
    expect((await next.json()).ticketNumber).toBe(`KE-DDRT-${YY}-0002`);
  });

  it("a connection exception (class 08) is ambiguous too: the number is not given back", async () => {
    s.errors["tickets.insert"] = [{ code: "08006", message: "connection failure" }];
    expect((await POST(req(portal({ attachments: [] })))).status).toBe(500);
    expect(s.tables.ticket_number_counters[0].next_seq).toBe(1);
  });

  it("a definite failure is released only after the row was looked for — a look-up that fails keeps the number", async () => {
    s.errors["tickets.insert"] = [{ code: "XX000", message: "disk full" }];
    s.errors["tickets.select"] = [{ code: "57014", message: "statement timeout" }];
    const res = await POST(req(portal({ attachments: [] })));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("insert_unconfirmed");
    expect(s.tables.ticket_number_counters[0].next_seq).toBe(1);
  });
});

describe("the request number's format is read, and checked, before a number is spent", () => {
  it("an orgs read that fails is a 503 — never a number without the workspace's prefix; nothing allocated, the staged file gone", async () => {
    s.errors["orgs.select"] = [{ code: "57014", message: "statement timeout" }];
    const res = await POST(req(portal()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/request numbering/);
    expect(nextTicketRpc()).toHaveLength(0);
    expect(tickets()).toHaveLength(0);
    expect(s.objects.has(staged("redline.pdf"))).toBe(false);
  });

  it("the route reads the row itself under the service role (getTicketNumberConfig, which swallows its error, is not used)", () => {
    const route = readFileSync(join(process.cwd(), "app/api/tickets/create/route.ts"), "utf8");
    expect(route).not.toContain("getTicketNumberConfig");
    expect(route).toContain('.from("orgs").select("ticket_prefix, ticket_record_code, ticket_number_pad").eq("id", orgId).maybeSingle();');
    expect(route.indexOf('.from("orgs").select("ticket_prefix')).toBeLessThan(route.indexOf('caller_client.rpc("next_ticket_number"'));
  });
});

describe("FRIC-3 / DCW-7 — one unit list for the form and the route; a derived unit tries each candidate", () => {
  it("a workspace that never saved request settings, with a Site Codebook: the codebook's units are the list (as the form now shows); the old built-in '100' is refused", async () => {
    s.tables.org_configurations = [];
    s.tables.codebook_entries = [{ org_id: ORG, kind: "unit", code: "20", label: "Crude" }, { org_id: ORG, kind: "unit", code: "30", label: "Vacuum" }];
    const ok = await POST(req(portal({ unit: "20", customCategories: null, attachments: [] })));
    expect(ok.status).toBe(201);
    expect(tickets()[0].unit).toBe("20");
    const bad = await POST(req(portal({ unit: "100", customCategories: null, attachments: [] })));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "unit" });
  });

  const units = () => { (s.tables.org_configurations[0].data as Row).units = { label: "Unit", enabled: true, options: [{ label: "20-CRUDE", value: "20-CRUDE" }, { label: "30-VAC", value: "30-VAC" }] }; };

  it("the metadata unit is on the list and the codebook unit_code is not: the ticket gets the metadata unit, matched", async () => {
    units();
    s.tables.documents[0] = { ...s.tables.documents[0], metadata: { Unit: "20-CRUDE" }, unit_code: "20" };
    expect((await POST(req(checkin()))).status).toBe(201);
    expect(tickets()[0].unit).toBe("20-CRUDE");
    expect((tickets()[0].metadata as Row).unit_unlisted).toBeUndefined();
  });

  it("the unit_code is on the list and the metadata unit is not: the unit_code, matched", async () => {
    units();
    s.tables.documents[0] = { ...s.tables.documents[0], metadata: { Unit: "Tank farm" }, unit_code: "30-VAC" };
    await POST(req(checkin()));
    expect(tickets()[0].unit).toBe("30-VAC");
    expect((tickets()[0].metadata as Row).unit_unlisted).toBeUndefined();
  });

  it("neither is on the list: the metadata unit (what the check-in always wrote), kept and marked unit_unlisted", async () => {
    units();
    s.tables.documents[0] = { ...s.tables.documents[0], metadata: { Unit: "Tank farm" }, unit_code: "99" };
    await POST(req(checkin()));
    expect(tickets()[0].unit).toBe("Tank farm");
    expect((tickets()[0].metadata as Row).unit_unlisted).toBe(true);
  });
});

describe("the opening history line names the role the requester filed under", () => {
  it("a multi-role member filing under a role they hold: requester_role and every opening history line agree — the form and a check-in", async () => {
    s.tables.org_members[0] = { ...s.tables.org_members[0], role: "Operator", roles: ["Operator", "Engineer-2"] };
    await POST(req(portal({ requesterRole: "Engineer-2", attachments: [] })));
    expect(tickets()[0].requester_role).toBe("Engineer-2");
    expect((tickets()[0].history as Row[]).map((h) => h.role)).toEqual(["Engineer-2", "Engineer-2"]);
    await POST(req(checkin({ requesterRole: "Engineer-2" })));
    expect(tickets()[1].requester_role).toBe("Engineer-2");
    expect((tickets()[1].history as Row[])[0].role).toBe("Engineer-2");
  });

  it("a role they do not hold: the headline, in both", async () => {
    s.tables.org_members[0] = { ...s.tables.org_members[0], role: "Operator", roles: ["Operator"] };
    await POST(req(portal({ requesterRole: "Engineer-4", attachments: [] })));
    expect(tickets()[0].requester_role).toBe("Operator");
    expect((tickets()[0].history as Row[])[0].role).toBe("Operator");
  });
});

describe("FRIC-8 — the origin is checked against its own facts; naming one is not a way around the form", () => {
  it("a request posted as a check-in by a member with no checkout of the document: 400 (field origin), nothing numbered, no PSM flag written", async () => {
    s.tables.checkout_sessions = [];
    const res = await POST(req(checkin()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "origin" });
    expect(nextTicketRpc()).toHaveLength(0);
    expect(tickets()).toHaveLength(0);
  });

  it("another member's checkout of the document does not count", async () => {
    s.tables.checkout_sessions = [{ id: "sess-x", document_id: DOC, user_id: SUP, episode_id: EPISODE, status: "active", started_at: "2026-10-07T08:00:00Z" }];
    expect((await POST(req(checkin()))).status).toBe(400);
  });

  it("an episode of another document, or of another workspace, is refused", async () => {
    s.tables.checkout_episodes[0].document_id = DOC2;
    expect((await POST(req(checkin()))).status).toBe(400);
    s.tables.checkout_episodes[0] = { id: EPISODE, org_id: OTHER_ORG, document_id: DOC, status: "active" };
    expect((await POST(req(checkin()))).status).toBe(400);
    expect(nextTicketRpc()).toHaveLength(0);
  });

  it("a retry after a failed session close (the session no longer active, still in this episode) files", async () => {
    s.tables.checkout_sessions[0].status = "completed";
    expect((await POST(req(checkin()))).status).toBe(201);
  });

  it("a legacy check-in with no episode files on the requester's active checkout of the document — and not on an ended one", async () => {
    expect((await POST(req(checkin({}, { episodeId: null })))).status).toBe(201);
    s.tables.tickets = [];
    s.tables.checkout_sessions[0].status = "completed";
    expect((await POST(req(checkin({}, { episodeId: null })))).status).toBe(400);
  });

  it("a check-in whose document is not in this workspace is refused", async () => {
    const res = await POST(req(checkin({ sourceDocuments: [{ id: DOC_FOREIGN, documentNumber: null, title: null, rev: null, versionId: null }] })));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "origin" });
  });

  it("an intake collision naming a project of another workspace is refused", async () => {
    s.tables.projects = [{ id: PROJECT, org_id: OTHER_ORG, name: "Theirs", intake_collection_id: INTAKE_FOLDER }];
    const res = await POST(req(collision()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "origin" });
    expect(nextTicketRpc()).toHaveLength(0);
  });

  it("facts that cannot be read are a 503 with nothing numbered", async () => {
    s.errors["checkout_sessions.select"] = [{ code: "57014", message: "statement timeout" }];
    expect((await POST(req(checkin()))).status).toBe(503);
    s.errors["projects.select"] = [{ code: "57014", message: "statement timeout" }];
    expect((await POST(req(collision()))).status).toBe(503);
    expect(nextTicketRpc()).toHaveLength(0);
  });
});

describe("a hand-off the route cannot use never blocks the request", () => {
  it("a library reference outside this workspace is dropped with a warning; the request is filed", async () => {
    const res = await POST(req(portal({ attachments: [{ kind: "source_reference", key: `orgs/${OTHER_ORG}/libraries/l9/x.pdf`, name: "x.pdf" }] })));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toEqual(['"x.pdf" was not attached: it is not a file in this workspace.']);
    expect(tickets()[0].attachments).toEqual([]);
  });

  it("a version whose file is an https URL is kept as the Source, as the form always filed it", async () => {
    const url = "https://files.plant.io/p101.pdf";
    const res = await POST(req(portal({ attachments: [{ kind: "source_reference", key: url, name: "p101.pdf" }] })));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toBeUndefined();
    expect((tickets()[0].attachments as Row[])[0]).toMatchObject({ url, type: "Source", name: "p101.pdf" });
  });

  it("a source document removed since the hand-off: filed without the link, with a warning", async () => {
    s.tables.documents = s.tables.documents.filter((d) => d.id !== DOC);
    const res = await POST(req(portal({ attachments: [] })));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toEqual(["The linked document P-101 is not in this workspace (it may have been removed) — the request was filed without that link."]);
    expect((tickets()[0].metadata as Row).source_document).toBeUndefined();
  });
});

describe("EDGE-13 — no branch deletes a staged key a ticket names", () => {
  const named = () => staged("kept.pdf");
  beforeEach(() => {
    s.objects.set(named(), 3);
    // an earlier ticket whose move failed keeps its file at the staged key
    s.tables.tickets.push({ id: "t-earlier", org_id: ORG, ticket_id: "KE-DDRT-26-0007", requester_id: REQ, status: "DRAFTING", attachments: [{ id: "a1", url: named() }] });
  });

  it("a body refused before parsing finishes", async () => {
    expect((await POST(req(portal({ title: " ", attachments: [{ kind: "staged", key: named(), name: "kept.pdf" }] })))).status).toBe(400);
    expect(s.objects.has(named())).toBe(true);
  });

  it("a refusal after parsing (a required field)", async () => {
    expect((await POST(req(portal({ customCategories: null, attachments: [{ kind: "staged", key: named(), name: "kept.pdf" }] })))).status).toBe(400);
    expect(s.objects.has(named())).toBe(true);
  });

  it("a resumed check-in", async () => {
    s.tables.tickets.push({ id: "t-old", org_id: ORG, ticket_id: "KE-DDRT-26-0042", requester_id: REQ, status: "PENDING_ASSIGNMENT", created_at: "2026-10-01", metadata: { checkin: { episodeId: EPISODE } } });
    const res = await POST(req(checkin({ attachments: [{ kind: "staged", key: named(), name: "kept.pdf" }] })));
    expect(res.status).toBe(200);
    expect(s.objects.has(named())).toBe(true);
  });
});

describe("EDGE-8 — the notice is written before any file moves, and the re-key keeps to its time", () => {
  it("the bell rows exist when the first copy starts", async () => {
    expect((await POST(req(portal()))).status).toBe(201);
    await settle();
    const copy = s.r2Ops.find((o) => o.op === "copy");
    expect(copy?.bellRows).toBe(2);
  });

  it("past the re-key's start-by time no copy starts: the file stays on the row where it was staged; the request is filed and announced", async () => {
    const real = Date.now.bind(Date);
    let skew = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    try {
      s.hooks.push((table, op) => { if (table === "tickets" && op === "insert") skew = 36_000; });
      const res = await POST(req(portal()));
      expect(res.status).toBe(201);
      await settle();
      expect(s.r2Ops.filter((o) => o.op === "copy")).toEqual([]);
      expect((tickets()[0].attachments as Row[])[1].url).toBe(staged("redline.pdf"));
      expect(s.objects.has(staged("redline.pdf"))).toBe(true);
      expect(bell()).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("LIFE-7 / LEAK-6 — the PSM escalation is the route's: sent once, stamped, and resumed only when it never went out", () => {
  const psmStamp = (i = 0) => (tickets()[i].metadata as Row).psm_escalated_at;

  it("a check-in reporting an undocumented field change: the controllers (not the reporter) get it on the safety category, bell and email; the ticket is stamped", async () => {
    const res = await POST(req(checkin()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.psmAlert).toBe("sent");
    expect(psmBell()).toHaveLength(1);
    expect(psmBell()[0]).toMatchObject({
      user_id: ADMIN, kind: "request_pending_approval", resource_type: "ticket", resource_id: body.id, link: `/requests/${body.id}`,
      title: "PSM alert: undocumented field change — P-101",
      body: 'Rita Requester reported the field differs from P-101 with no MOC on record: "Valve moved."',
    });
    // the safety category: an event type no preference toggle gates; an absolute link
    expect(psmMail().map((m) => m.to_user_id)).toEqual([ADMIN]);
    expect(String(psmMail()[0].body_text)).toContain(`https://app.plant.io/requests/${body.id}`);
    expect(typeof psmStamp()).toBe("string");
    // not a creation notice: never retired when the ticket is assigned
    expect((psmBell()[0].metadata as Row | null)?.action).toBeUndefined();
  });

  it("a lost first reply, then the retry that resumes: exactly one escalation", async () => {
    // the first POST filed and escalated; its 201 never reached the tablet
    expect((await POST(req(checkin()))).status).toBe(201);
    const retry = await POST(req(checkin()));
    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body).toMatchObject({ resumed: true });
    expect(body.psmAlert).toBeUndefined();
    expect(tickets()).toHaveLength(1);
    expect(psmBell()).toHaveLength(1);
    expect(psmMail()).toHaveLength(1);
  });

  it("a first attempt answered 'check the queue' (insert_unconfirmed) whose row committed: the retry resumes it and sends the escalation the first never did — once", async () => {
    s.lostReply["tickets.insert"] = [{ code: "", message: "TypeError: fetch failed" }];
    // the resume look-up (first tickets read) answers; the insert's probe (second) cannot
    s.errors["tickets.select"] = [null, { code: "57014", message: "statement timeout" }];
    const first = await POST(req(checkin()));
    expect(first.status).toBe(500);
    expect((await first.json()).code).toBe("insert_unconfirmed");
    expect(tickets()).toHaveLength(1);             // the row DID commit
    expect(psmBell()).toHaveLength(0);              // and nothing was escalated
    expect(psmStamp()).toBeUndefined();
    const retry = await POST(req(checkin()));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ resumed: true, psmAlert: "sent", id: tickets()[0].id });
    expect(psmBell().map((n) => n.user_id)).toEqual([ADMIN]);
    expect(String(psmBell()[0].body)).toContain('"Valve moved."');
    expect(typeof psmStamp()).toBe("string");
    const third = await POST(req(checkin()));
    expect(third.status).toBe(200);
    expect((await third.json()).psmAlert).toBeUndefined();
    expect(psmBell()).toHaveLength(1);
    expect(tickets()).toHaveLength(1);
  });

  it("a ticket filed before this fix (flagged, never stamped) is escalated when its check-in resumes it — a second alert, never a lost one", async () => {
    s.tables.tickets.push({
      id: "t-old", org_id: ORG, ticket_id: "KE-DDRT-26-0042", requester_id: REQ, status: "PENDING_ASSIGNMENT", created_at: "2026-10-01", last_modified: "2026-10-01T00:00:00.000Z",
      description: "Old note.\n\nMOC: NONE ON RECORD — flagged as an undocumented field change.",
      metadata: { checkin: { episodeId: EPISODE }, undocumented_change: true, moc: { status: "none", number: null } },
    });
    const res = await POST(req(checkin()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "t-old", resumed: true, psmAlert: "sent" });
    expect(psmBell()[0]).toMatchObject({ resource_id: "t-old", body: 'Rita Requester reported the field differs from P-101 with no MOC on record: "Old note."' });
    expect(typeof psmStamp()).toBe("string");
    expect(nextTicketRpc()).toHaveLength(0);
  });

  it("no controller but the reporter: nothing sent, PSM_ALERT_UNROUTED audited, the answer says 'unrouted', nothing stamped", async () => {
    s.tables.org_members = s.tables.org_members.filter((m) => m.uid !== ADMIN);
    const res = await POST(req(checkin()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.psmAlert).toBe("unrouted");
    expect(psmBell()).toHaveLength(0);
    expect(s.tables.audit_logs).toEqual([expect.objectContaining({
      action: "PSM_ALERT_UNROUTED", resource_type: "ticket", resource_id: body.id, user_id: REQ,
      details: { reason: "no_active_controllers", title: "PSM alert: undocumented field change — P-101" },
    })]);
    expect(psmStamp()).toBeUndefined();
  });

  it("a controller read that fails: 'failed', not stamped — the check-in's next attempt resumes the ticket and sends it", async () => {
    s.tables.tickets.push({
      id: "t-old", org_id: ORG, ticket_id: "KE-DDRT-26-0042", requester_id: REQ, status: "PENDING_ASSIGNMENT", created_at: "2026-10-01", last_modified: "2026-10-01T00:00:00.000Z",
      description: "Old note.", metadata: { checkin: { episodeId: EPISODE }, undocumented_change: true, created_notice_at: "2026-10-01T00:00:01.000Z" },
    });
    // the membership read answers; the controller read does not
    s.errors["org_members.select"] = [null, { code: "57014", message: "statement timeout" }];
    const first = await POST(req(checkin()));
    expect(await first.json()).toMatchObject({ resumed: true, psmAlert: "failed" });
    expect(psmBell()).toHaveLength(0);
    expect(psmStamp()).toBeUndefined();
    const again = await POST(req(checkin()));
    expect(await again.json()).toMatchObject({ resumed: true, psmAlert: "sent" });
    expect(psmBell()).toHaveLength(1);
  });

  it("a check-in that reports no undocumented change sends no PSM alert", async () => {
    const res = await POST(req(checkin({ requestType: "Revision", priority: 2 }, { outcome: "correction", moc: null, minorCorrection: true, undocumentedChange: false })));
    expect((await res.json()).psmAlert).toBeUndefined();
    expect(psmBell()).toHaveLength(0);
  });

  it("the stamp loses no concurrent write: a writer that lands first keeps its change and the stamp still lands", async () => {
    let done = false;
    s.hooks.push((table, op) => {
      if (!done && table === "tickets" && op === "update") {
        done = true;
        const t = tickets()[0];
        t.metadata = { ...(t.metadata as Row), triage_note: "seen" };
        t.last_modified = "2099-01-01T00:00:00.000Z";
      }
    });
    expect((await POST(req(checkin()))).status).toBe(201);
    const m = tickets()[0].metadata as Row;
    expect(m.triage_note).toBe("seen");
    expect(typeof m.psm_escalated_at).toBe("string");
  });

  it("checkinNoteOf / psmAlertNotice: the reporter's words without the MOC line, in the panel's sentence", () => {
    expect(checkinNoteOf("Valve moved.\n\nMOC: NONE ON RECORD — flagged as an undocumented field change.", { status: "none", number: null })).toBe("Valve moved.");
    expect(checkinNoteOf("Just a note", null)).toBe("Just a note");
    expect(psmAlertNotice({ reporter: "rita", docLabel: "P-101", note: " Valve moved. " })).toEqual({
      title: "PSM alert: undocumented field change — P-101",
      body: 'rita reported the field differs from P-101 with no MOC on record: "Valve moved."',
    });
  });
});

describe("source documents are read AS THE CALLER — the document ACL applies", () => {
  it("a document the caller cannot open is treated exactly like one that is not here: dropped with the same warning, none of its fields stored, no unit derived from it", async () => {
    s.tables.documents[0].visible_to = [SUP];       // P-101 sits in a library only SUP can open
    const res = await POST(req(portal({ unit: null, attachments: [], sourceDocuments: [{ id: DOC, documentNumber: null, title: null, rev: null, versionId: null }] })));
    expect(res.status).toBe(201);
    const body = await res.json();
    // the same words a missing document gets — nothing tells the caller the id exists
    expect(body.warnings).toEqual(["A linked document is not in this workspace (it may have been removed) — the request was filed without that link."]);
    const t = tickets()[0];
    expect(JSON.stringify(t)).not.toContain("P-101");
    expect(JSON.stringify(t)).not.toContain("Flare header");
    expect(JSON.stringify(t)).not.toContain(V4);
    expect(t.unit).toBeNull();
    expect((t.metadata as Row).unit_unknown).toBe(true);
    // a removed document answers the same
    s.tables.documents = s.tables.documents.filter((d) => d.id !== DOC);
    const gone = await POST(req(portal({ unit: null, attachments: [], sourceDocuments: [{ id: DOC, documentNumber: null, title: null, rev: null, versionId: null }] })));
    expect((await gone.json()).warnings).toEqual(body.warnings);
  });

  it("the member who can open it files with its fields filled in from the row", async () => {
    s.tables.documents[0].visible_to = [REQ];
    await POST(req(portal({ unit: null, attachments: [], sourceDocuments: [{ id: DOC, documentNumber: null, title: null, rev: null, versionId: null }] })));
    expect((tickets()[0].metadata as Row).source_document).toEqual({ id: DOC, document_number: "P-101", title: "Flare header", rev: "4", version_id: V4 });
    expect(tickets()[0].unit).toBe("200");
  });

  it("a check-in on a document the caller cannot see is refused (field origin), nothing numbered", async () => {
    s.tables.documents[0].visible_to = [SUP];
    const res = await POST(req(checkin()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "origin" });
    expect(nextTicketRpc()).toHaveLength(0);
  });

  it("the read is the caller-scoped client's, never the service role's", () => {
    const route = readFileSync(join(process.cwd(), "app/api/tickets/create/route.ts"), "utf8");
    expect(route).toContain("const docs = await readSourceDocuments(caller_client, orgId, input.sourceDocuments.map((d) => d.id));");
    expect(route).not.toMatch(/supabaseAdmin\.from\("documents"\)/);
  });
});

describe("GAP-8 — a hand-off of many sheets files; the list is advisory", () => {
  const sheet = (i: number) => `dddddddd-1111-4000-8000-${String(i).padStart(12, "0")}`;
  const seedSheets = (n: number) => {
    for (let i = 0; i < n; i++) s.tables.documents.push({ id: sheet(i), org_id: ORG, document_number: `ISO-${i}`, title: null, name: `iso-${i}.pdf`, rev: "1", current_version_id: null, metadata: {} });
  };
  const sheets = (n: number) => Array.from({ length: n }, (_, i) => ({ id: sheet(i), documentNumber: `ISO-${i}`, title: null, rev: null, versionId: null }));

  it("30 marked-up sheets file, every one linked (the old 25-sheet refusal is gone)", async () => {
    seedSheets(30);
    const res = await POST(req(portal({ unit: null, attachments: [], sourceDocuments: sheets(30) })));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toBeUndefined();
    expect(((tickets()[0].metadata as Row).source_documents as Row[])).toHaveLength(30);
  });

  it("more than MAX_SOURCE_DOCUMENTS: filed with the first ones linked and a warning naming the rest — never a refusal", async () => {
    seedSheets(MAX_SOURCE_DOCUMENTS + 30);
    const res = await POST(req(portal({ unit: null, attachments: [], sourceDocuments: sheets(MAX_SOURCE_DOCUMENTS + 30) })));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toEqual([`30 more linked documents were not kept — one request links at most ${MAX_SOURCE_DOCUMENTS} (the first ${MAX_SOURCE_DOCUMENTS} are linked).`]);
    const refs = (tickets()[0].metadata as Row).source_documents as Row[];
    expect(refs).toHaveLength(MAX_SOURCE_DOCUMENTS);
    expect(refs[0].id).toBe(sheet(0));
  });

  it("capSourceDocuments: the form and the route cut the same way", () => {
    expect(capSourceDocuments([1, 2, 3])).toEqual({ kept: [1, 2, 3], dropped: 0 });
    const big = Array.from({ length: MAX_SOURCE_DOCUMENTS + 2 }, (_, i) => i);
    expect(capSourceDocuments(big)).toEqual({ kept: big.slice(0, MAX_SOURCE_DOCUMENTS), dropped: 2 });
  });
});

describe("an intake collision's overlap list is stored whole (or counted and flagged), never silently cut", () => {
  const overlaps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `o-${i}`, label: `P-${1000 + i}`, sharedTags: ["V-1"] }));

  it("400 overlaps: all 400 on the stored row", async () => {
    expect((await POST(req(collision({ overlaps: overlaps(400) })))).status).toBe(201);
    const ic = (tickets()[0].metadata as Row).intake_collision as Row;
    expect((ic.overlaps as Row[])).toHaveLength(400);
    expect(ic.overlapsTruncated).toBeUndefined();
  });

  it("past MAX_COLLISION_OVERLAPS: the first ones stored, with the full count and a truncated flag", async () => {
    expect((await POST(req(collision({ overlaps: overlaps(MAX_COLLISION_OVERLAPS + 200) })))).status).toBe(201);
    const ic = (tickets()[0].metadata as Row).intake_collision as Row;
    expect((ic.overlaps as Row[])).toHaveLength(MAX_COLLISION_OVERLAPS);
    expect(ic).toMatchObject({ overlapsTotal: MAX_COLLISION_OVERLAPS + 200, overlapsTruncated: true });
  });
});

describe("FRIC-8 — an intake collision is held to the project's own intake facts", () => {
  it("a sheet that is not in the project's intake folder is refused (field origin), nothing numbered", async () => {
    const res = await POST(req({ ...collision(), sourceDocuments: [{ id: DOC, documentNumber: "P-101", title: null, rev: null, versionId: null }] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "origin" });
    expect(nextTicketRpc()).toHaveLength(0);
  });

  it("another project of this workspace (its intake folder is elsewhere) is refused", async () => {
    expect((await POST(req(collision({ projectId: PROJECT2, intakeLinkId: null })))).status).toBe(400);
  });

  it("an intake link that is not this project's is refused", async () => {
    s.tables.project_intake_links = [{ id: LINK, org_id: ORG, project_id: PROJECT2 }];
    const res = await POST(req(collision()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "origin" });
  });

  it("the notice and the history line carry the sheet's own number — never the client's label", async () => {
    await POST(req(collision({ sheetLabel: "URGENT – call me" })));
    expect(creationBell()[0].title).toBe("Intake collision flagged: P-102");
    expect(JSON.stringify(tickets()[0].history)).not.toContain("URGENT");
  });

  it("a colliding document the caller cannot see is not stored: filed without it, with a warning, and the notice says overlap", async () => {
    s.tables.documents[0].visible_to = [SUP];
    const res = await POST(req(collision()));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toEqual(["The document this sheet's number collides with is not one you can see in this workspace — the request was filed without naming it."]);
    expect(((tickets()[0].metadata as Row).intake_collision as Row).numberCollisionDocId).toBeNull();
    expect(creationBell()[0].body).toBe("A submitted sheet overlaps existing drawings — tie-in revision work to assign.");
  });

  it("a malformed intake link or colliding-document id is refused as a body that is not valid", async () => {
    expect((await POST(req(collision({ intakeLinkId: "link-1" })))).status).toBe(400);
    expect((await POST(req(collision({ numberCollisionDocId: "doc-old" })))).status).toBe(400);
  });
});

describe("the request number's year is the requester's own when it is in force somewhere", () => {
  it("requestNumberYear: the local year one side of New Year is kept; any other year is the server's UTC year", () => {
    const nyUtc = Date.parse("2027-01-01T01:00:00Z");       // 19:00 on 31 Dec in US Central
    expect(requestNumberYear(nyUtc, 2026)).toBe(2026);
    expect(requestNumberYear(nyUtc, 2027)).toBe(2027);
    expect(requestNumberYear(nyUtc, 2025)).toBe(2027);
    expect(requestNumberYear(nyUtc, 2030)).toBe(2027);
    expect(requestNumberYear(nyUtc, null)).toBe(2027);
    const kiritimati = Date.parse("2026-12-31T10:30:00Z");  // already 1 Jan 2027 at UTC+14
    expect(requestNumberYear(kiritimati, 2027)).toBe(2027);
    expect(requestNumberYear(Date.parse("2026-12-31T09:00:00Z"), 2027)).toBe(2026);   // not yet anywhere
    expect(requestNumberYear(Date.parse("2026-07-01T00:00:00Z"), 2027)).toBe(2026);
  });

  it("a request filed at 19:00 on 31 December in Texas is numbered in that year and spends that year's counter", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-01T01:00:00Z"));
    try {
      const res = await POST(req({ ...portal({ attachments: [] }), localYear: 2026 }));
      expect((await res.json()).ticketNumber).toBe("KE-DDRT-26-0001");
      expect(nextTicketRpc()[0].args.p_year).toBe(2026);
      const forged = await POST(req({ ...portal({ attachments: [] }), localYear: 2031 }));
      expect((await forged.json()).ticketNumber).toBe("KE-DDRT-27-0001");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a saved settings row whose request-type list was emptied takes any type (20261038)", () => {
  it("the form's built-in 'ISO' files", async () => {
    (s.tables.org_configurations[0].data as Row).requestTypes = { label: "Type", enabled: true, options: [] };
    expect((await POST(req(portal({ attachments: [] })))).status).toBe(201);
    expect(tickets()[0].request_type).toBe("ISO");
  });
});

describe("EDGE-8 — the answer does not wait on the re-key", () => {
  it("the answer comes back with the request filed and announced, the row naming the staged key; the move happens after the answer", async () => {
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    expect(s.r2Ops.filter((o) => o.op === "copy")).toEqual([]);
    expect((tickets()[0].attachments as Row[])[1].url).toBe(staged("redline.pdf"));
    expect(creationBell()).toHaveLength(2);
    await settle();
    expect((tickets()[0].attachments as Row[])[1].url).toBe(`orgs/${ORG}/tickets/KE-DDRT-${YY}-0001/1727000000000_redline.pdf`);
    const route = readFileSync(join(process.cwd(), "app/api/tickets/create/route.ts"), "utf8");
    expect(route).toMatch(/after\(async \(\) => \{\s*\n\s*try \{\s*\n\s*const unmoved = await rekeyAttachments\(/);
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
    expect(await res.json()).toEqual({ ok: true, deleted: 1, kept: 1, unchecked: 0, foreign: 1 });
    expect(s.objects.has(mine)).toBe(false);
    expect(s.objects.has(named)).toBe(true);
    expect(s.objects.has(theirs)).toBe(true);
  });

  it("needs a session", async () => {
    expect((await DELETE(req({ orgId: ORG, keys: [staged("a.pdf")] }, "nope", "DELETE"))).status).toBe(401);
    expect((await POST(req(portal(), "nope"))).status).toBe(401);
  });
});

// ── Third review of DF-P2 ────────────────────────────────────────────────
describe("EDGE-8 / LEAK-6 — the creation notice is stamped, and a resume sends it only when it never went out", () => {
  const noticeStamp = (i = 0) => (tickets()[i].metadata as Row).created_notice_at;
  /** A ticket as the route inserts it, whose attempt then ended before the
   *  notice (a platform timeout, a crash): no bell row, no stamp. */
  const died = (over: Row = {}) => ({
    id: "t-died", org_id: ORG, ticket_id: "KE-DDRT-26-0042", requester_id: REQ, status: "PENDING_ASSIGNMENT", title: "As-Built Discrepancy: Flare header",
    request_type: "ASBUILT", priority: 1, unit: "200", created_at: "2026-10-01", last_modified: "2026-10-01T00:00:00.000Z",
    description: "Valve moved.", metadata: { checkin: { episodeId: EPISODE } }, ...over,
  });

  it("a new request is answered notified: true and its ticket stamped created_notice_at", async () => {
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.notified).toBe(true);
    expect(body.notifyReason).toBeUndefined();
    expect(typeof noticeStamp()).toBe("string");
    expect(creationBell()).toHaveLength(2);
  });

  it("a first attempt that died after the insert: the retry resumes and announces once", async () => {
    s.tables.tickets.push(died());
    const retry = await POST(req(checkin({ sourceDocuments: [{ id: DOC, documentNumber: "P-101", title: "Flare header", rev: "4", versionId: V4 }] }, { undocumentedChange: false, moc: null })));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ id: "t-died", resumed: true, notified: true });
    expect(creationBell().map((n) => n.user_id).sort()).toEqual([SUP, SUP2].sort());
    expect(creationBell().every((n) => n.resource_id === "t-died" && (n.metadata as Row).status === "PENDING_ASSIGNMENT")).toBe(true);
    expect(typeof noticeStamp()).toBe("string");
    const third = await POST(req(checkin({}, { undocumentedChange: false, moc: null })));
    expect(third.status).toBe(200);
    expect(creationBell()).toHaveLength(2);
    expect(nextTicketRpc()).toHaveLength(0);
  });

  it("a ticket already taken off the queue is not announced again on resume", async () => {
    s.tables.tickets.push(died({ status: "DRAFTING" }));
    const retry = await POST(req(checkin({}, { undocumentedChange: false, moc: null })));
    expect(await retry.json()).toMatchObject({ id: "t-died", resumed: true, notified: true });
    expect(creationBell()).toHaveLength(0);
  });

  it("a notice whose bell rows are all refused is answered notified: false with the reason, not stamped — and the check-in's retry sends it, once", async () => {
    const refused = { code: "42501", message: "new row violates row-level security policy" };
    s.errors["notifications.insert"] = [refused, refused];
    const first = await POST(req(checkin({}, { undocumentedChange: false, moc: null })));
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ notified: false, notifyReason: "the notice could not be written" });
    expect(creationBell()).toHaveLength(0);
    expect(noticeStamp()).toBeUndefined();
    const retry = await POST(req(checkin({}, { undocumentedChange: false, moc: null })));
    expect(await retry.json()).toMatchObject({ resumed: true, notified: true });
    expect(creationBell()).toHaveLength(2);
    expect(typeof noticeStamp()).toBe("string");
    await POST(req(checkin({}, { undocumentedChange: false, moc: null })));
    expect(creationBell()).toHaveLength(2);
  });

  it("nobody to notify (no supervisor or admin but the requester) is answered notified: false — never a 201 that looks told", async () => {
    s.tables.org_members = s.tables.org_members.filter((m) => m.uid === REQ);
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.notified).toBe(false);
    expect(body.notifyReason).toMatch(/^nobody to notify/);
    expect(noticeStamp()).toBeUndefined();
  });
});

describe("FRIC-8 / DEC-101 item 5 — a legacy library key the register carries is attached", () => {
  const LEGACY = "libraries/l1/legacy-p101.pdf";
  const handoff = (key: string) => portal({ sourceDocuments: [], attachments: [{ kind: "source_reference", key, name: "p101.pdf" }] });

  it("a key from before the orgs/ prefix that a version of a document in this workspace carries: attached as the Source", async () => {
    s.tables.document_versions.push({ id: "v-legacy", record_id: DOC, revision_label: "4", file_url: LEGACY });
    const res = await POST(req(handoff(LEGACY)));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toBeUndefined();
    expect((tickets()[0].attachments as Row[])[0]).toMatchObject({ url: LEGACY, type: "Source" });
  });

  it("the native source key (source_file_key) counts too", async () => {
    s.tables.document_versions.push({ id: "v-legacy", record_id: DOC, revision_label: "4", source_file_key: LEGACY });
    expect(((await (await POST(req(handoff(LEGACY)))).json()).warnings)).toBeUndefined();
  });

  it("a legacy key no version carries, one of another workspace's document, or of a document the caller cannot open: dropped with the warning", async () => {
    const drop = '"p101.pdf" was not attached: it is not a file in this workspace.';
    expect((await (await POST(req(handoff(LEGACY)))).json()).warnings).toEqual([drop]);
    s.tables.document_versions.push({ id: "v-x", record_id: DOC_FOREIGN, revision_label: "1", file_url: LEGACY });
    expect((await (await POST(req(handoff(LEGACY)))).json()).warnings).toEqual([drop]);
    s.tables.document_versions.push({ id: "v-legacy", record_id: DOC, revision_label: "4", file_url: LEGACY });
    s.tables.documents[0].visible_to = [SUP];
    expect((await (await POST(req(handoff(LEGACY)))).json()).warnings).toEqual([drop]);
    expect(tickets().every((t) => (t.attachments as Row[]).length === 0)).toBe(true);
  });

  it("another workspace's prefixed key is never looked up in the register; the register is read as the caller", async () => {
    const reads: string[] = [];
    s.hooks.push((table) => { if (table === "document_versions") reads.push(table); });
    await POST(req(handoff(`orgs/${OTHER_ORG}/libraries/l9/x.pdf`)));
    expect(reads).toEqual([]);
    const route = readFileSync(join(process.cwd(), "app/api/tickets/create/route.ts"), "utf8");
    expect(route).toMatch(/callerClient\.from\("document_versions"\)/);
    expect(route).not.toMatch(/supabaseAdmin\.from\("document_versions"\)/);
  });

  it("a register that cannot be read is a 503 before a number is spent", async () => {
    s.errors["document_versions.select"] = [{ code: "57014", message: "statement timeout" }];
    expect((await POST(req(handoff(LEGACY)))).status).toBe(503);
    expect(nextTicketRpc()).toHaveLength(0);
  });
});

describe("DCW-7 / FRIC-3 — a unit list that cannot be read fails visibly, and the same way as the form", () => {
  beforeEach(() => {
    (s.tables.org_configurations[0].data as Row).units = { label: "Unit", enabled: true, options: [] };
    s.tables.codebook_entries = [{ org_id: ORG, kind: "unit", code: "20", label: "Crude" }];
  });

  it("the codebook is there but unreadable: the unit given is not admitted unchecked — filed as Unit unknown, kept as unit_unchecked, and the answer says so", async () => {
    s.errors["codebook_entries.select"] = [{ code: "57014", message: "statement timeout" }];
    const res = await POST(req(portal({ unit: "99", sourceDocuments: [], attachments: [] })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(tickets()[0].unit).toBeNull();
    expect(tickets()[0].metadata).toMatchObject({ unit_unknown: true, unit_unchecked: "99" });
    expect((tickets()[0].metadata as Row).unit_unlisted).toBeUndefined();
    expect(body.warnings).toEqual(['The unit "99" could not be checked against this workspace\'s unit list — the request was filed as "Unit unknown" (triage assigns it); the unit given is on the record.']);
  });

  it("the codebook is not there yet (20260928 not pasted): no list — the unit is free text, as the form's box takes it", async () => {
    s.errors["codebook_entries.select"] = [{ code: "42P01", message: 'relation "codebook_entries" does not exist' }];
    const res = await POST(req(portal({ unit: "99", sourceDocuments: [], attachments: [] })));
    expect(res.status).toBe(201);
    expect(tickets()[0].unit).toBe("99");
    expect((tickets()[0].metadata as Row).unit_unchecked).toBeUndefined();
  });

  it("unitListReadFailure classes both sides' reads alike", async () => {
    const { unitListReadFailure } = await import("@/lib/ticketCreate");
    expect(unitListReadFailure(null)).toBe("none");
    expect(unitListReadFailure({ code: "42P01", message: "x" })).toBe("missing");
    expect(unitListReadFailure({ code: "PGRST205", message: "Could not find the table 'public.codebook_entries' in the schema cache" })).toBe("missing");
    expect(unitListReadFailure({ code: "57014", message: "statement timeout" })).toBe("unreadable");
    expect(unitListReadFailure({ message: "TypeError: fetch failed" })).toBe("unreadable");
  });
});

describe("EDGE-13 — DELETE says what became of each key", () => {
  it("own and referenced is kept, not refused; another's is foreign; each counted once", async () => {
    const named = staged("b.pdf");
    const theirs = staged("c.pdf", SUP);
    for (const k of [named, theirs]) s.objects.set(k, 1);
    s.tables.tickets.push({ id: "t1", org_id: ORG, attachments: [{ id: "x", url: named }] });
    const res = await DELETE(req({ orgId: ORG, keys: [named, named, theirs] }, "tok-req", "DELETE"));
    expect(await res.json()).toEqual({ ok: true, deleted: 0, kept: 1, unchecked: 0, foreign: 1 });
  });

  it("a reference check that fails: 503, the key counted unchecked and left in place", async () => {
    const mine = staged("a.pdf");
    s.objects.set(mine, 1);
    s.errors["tickets.select"] = [{ code: "57014", message: "statement timeout" }];
    const res = await DELETE(req({ orgId: ORG, keys: [mine] }, "tok-req", "DELETE"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ deleted: 0, kept: 0, unchecked: 1, foreign: 0 });
    expect(s.objects.has(mine)).toBe(true);
  });
});

describe("FRIC-8 / LEAK-6 — a legacy check-in retried after its checkout closed is told what happened", () => {
  it("the caller's own checkout of the document, closed, no episode: 400 saying the checkout is closed — not the ownership refusal", async () => {
    s.tables.checkout_sessions[0].status = "completed";
    const res = await POST(req(checkin({}, { episodeId: null })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("origin");
    expect(body.error).toMatch(/^Your checkout of this document is already closed/);
    expect(body.error).not.toMatch(/Only the person who checked this document out/);
    expect(nextTicketRpc()).toHaveLength(0);
  });

  it("a caller with no checkout of the document at all still gets the ownership refusal", async () => {
    s.tables.checkout_sessions = s.tables.checkout_sessions.filter((x) => x.document_id !== DOC);
    const res = await POST(req(checkin({}, { episodeId: null })));
    expect((await res.json()).error).toBe("Only the person who checked this document out can file its check-in request.");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// drafting-flow Round G, DF-P4 LIBRARY — the create route's library, due date
// and the columns it never writes.
const LIB = "1b000000-0000-4000-8000-000000000001";
describe("DF-P4 — GAP-105 / DCW-1: the library is derived from the source document, never asked for", () => {
  it("a request raised from a document carries the document's library", async () => {
    (s.tables.documents.find((d) => d.id === DOC) as Row).library_id = LIB;
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    expect(tickets()[0].library_id).toBe(LIB);
  });
  it("REGRESSION: a request with no source document files exactly as before — no library, never refused for it", async () => {
    const res = await POST(req(portal({ sourceDocuments: [], attachments: [] })));
    expect(res.status).toBe(201);
    expect("library_id" in tickets()[0]).toBe(false);
  });
  it("a source document the requester cannot see lends no library (it is dropped, as before — DEC-101 item 5)", async () => {
    const d = s.tables.documents.find((x) => x.id === DOC) as Row;
    d.library_id = LIB; d.visible_to = ["someone-else"];
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    expect("library_id" in tickets()[0]).toBe(false);
  });
  it("before 20261208 is pasted (the column is not there) the same number is retried without the library — today's path", async () => {
    (s.tables.documents.find((d) => d.id === DOC) as Row).library_id = LIB;
    s.errors["tickets.insert"] = [{ code: "PGRST204", message: "Could not find the 'library_id' column of 'tickets' in the schema cache" }];
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    expect(tickets()).toHaveLength(1);
    expect("library_id" in tickets()[0]).toBe(false);
    expect(nextTicketRpc()).toHaveLength(1);
    expect(tickets()[0].ticket_id).toBe(`KE-DDRT-${YY}-0001`);
  });
});

describe("DF-P4 — EDGE-7 done-when 2 / ROUTE-9 done-when 4: the due date comes from the org's sla_defaults first", () => {
  it("the org's window for the type sets target_completion_at; the requester's own date still wins; no row → the built-in window", async () => {
    s.tables.sla_defaults = [{ org_id: ORG, request_type: "ISO", default_days: 3 }];
    await POST(req(portal()));
    const days = (Date.parse(String(tickets()[0].target_completion_at)) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2); expect(days).toBeLessThan(4);

    seed(); s.counter = new Map();
    s.tables.sla_defaults = [{ org_id: ORG, request_type: "ISO", default_days: 3 }];
    const mine = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await POST(req(portal({ targetCompletionAt: mine })));
    expect(tickets()[0].target_completion_at).toBe(mine);

    seed(); s.counter = new Map();
    await POST(req(portal()));
    const builtIn = (Date.parse(String(tickets()[0].target_completion_at)) - Date.now()) / 86_400_000;
    expect(builtIn).toBeGreaterThan(13); expect(builtIn).toBeLessThan(15);   // ISO: 14 days (DEFAULT_SLA_DAYS)
  });
  it("an sla_defaults read that fails falls back to the built-in window — the request is still filed", async () => {
    s.errors["sla_defaults.select"] = [{ code: "57014", message: "statement timeout" }];
    const res = await POST(req(portal()));
    expect(res.status).toBe(201);
    const builtIn = (Date.parse(String(tickets()[0].target_completion_at)) - Date.now()) / 86_400_000;
    expect(builtIn).toBeGreaterThan(13);
  });
  it("DF-P4 fix pass: a member-written default_days outside 1..3650 whole days (2e9, 0, negative, fractional, text) is the built-in window — never a 500", async () => {
    for (const bad of [2_000_000_000, 3651, 0, -5, 2.5, "soon", Number.NaN]) {
      seed(); s.counter = new Map();
      s.tables.sla_defaults = [{ org_id: ORG, request_type: "ISO", default_days: bad }];
      const res = await POST(req(portal()));
      expect(res.status, String(bad)).toBe(201);
      const builtIn = (Date.parse(String(tickets()[0].target_completion_at)) - Date.now()) / 86_400_000;
      expect(builtIn, String(bad)).toBeGreaterThan(13); expect(builtIn, String(bad)).toBeLessThan(15);   // ISO: 14 days
    }
    seed(); s.counter = new Map();
    s.tables.sla_defaults = [{ org_id: ORG, request_type: "ISO", default_days: 3650 }];
    expect((await POST(req(portal()))).status).toBe(201);
    const longest = (Date.parse(String(tickets()[0].target_completion_at)) - Date.now()) / 86_400_000;
    expect(longest).toBeGreaterThan(3648); expect(longest).toBeLessThan(3651);
  });
  it("boundedSlaDays: whole days 1..SLA_DEFAULT_DAYS_MAX pass; everything else is null", async () => {
    const { boundedSlaDays, SLA_DEFAULT_DAYS_MAX } = await import("@/lib/notifications");
    expect(SLA_DEFAULT_DAYS_MAX).toBe(3650);
    expect([1, 7, "21", 3650].map(boundedSlaDays)).toEqual([1, 7, 21, 3650]);
    expect([0, -1, 1.5, 3651, 2e9, Infinity, NaN, null, undefined, "", "x", true].map(boundedSlaDays)).toEqual(Array(12).fill(null));
  });
  it("the service-role insert never writes sla_breached_at, sla_breach_warned_at or outcome (ticket_insert_integrity does not run for it)", async () => {
    for (const body of [portal(), checkin(), collision()]) {
      seed(); s.counter = new Map();
      const res = await POST(req(body));
      expect(res.status).toBe(201);
      for (const col of ["sla_breached_at", "sla_breach_warned_at", "outcome"]) expect(col in tickets()[0], col).toBe(false);
    }
    const src = readFileSync(join(process.cwd(), "app", "api", "tickets", "create", "route.ts"), "utf8").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/^\s*(sla_breached_at|sla_breach_warned_at|outcome)\s*:/m);
    expect(src).not.toMatch(/row\.(sla_breached_at|sla_breach_warned_at|outcome)\s*=/);
  });
});

describe("DF-P4 — EDGE-8: every filed request records that its creation notice is owed; the stamp settles it", () => {
  it("announced: owed and stamped; nobody to tell: owed and NOT stamped (creationNoticeOwed reads the pair)", async () => {
    const { creationNoticeOwed } = await import("@/lib/ticketLibrary");
    await POST(req(portal()));
    const m = tickets()[0].metadata as Row;
    expect(m.created_notice_owed).toBe(true);
    expect(typeof m.created_notice_at).toBe("string");
    expect(creationNoticeOwed("PENDING_ASSIGNMENT", m)).toBe(false);

    seed(); s.counter = new Map();
    s.tables.org_members = s.tables.org_members.filter((x) => x.uid === REQ);
    const res = await POST(req(portal()));
    expect((await res.json()).notified).toBe(false);
    const m2 = tickets()[0].metadata as Row;
    expect(m2.created_notice_owed).toBe(true);
    expect(m2.created_notice_at).toBeUndefined();
    expect(creationNoticeOwed("PENDING_ASSIGNMENT", m2)).toBe(true);
  });
});

describe("DF-P6 — GAP-110 / DEC-34: the like-in-kind declaration at filing; GAP-312: the equipment the request names", () => {
  const KEY = "7a000000-0000-4000-8000-000000000001";
  const SIG = "5a000000-0000-4000-8000-000000000001";
  const STATEMENT = "Replacing the PSV-12 spring with an identical spring, same set pressure.";
  const sigRow = (over: Row = {}) => ({
    id: SIG, org_id: ORG, resource_type: "ticket", resource_id: KEY, signer_user_id: REQ,
    statement: `Like-in-kind declaration: ${STATEMENT}`, intent: "Acknowledged", signed_at: new Date(Date.now() - 60_000).toISOString(), ...over,
  });
  const declared = (over: Row = {}) => portal({ attachments: [], declaration: { statement: STATEMENT, signatureId: SIG, ticketKey: KEY }, ...over });

  it("a signed declaration files the request under the signed id with the declaration recorded and engineering_required false", async () => {
    s.tables.e_signatures = [sigRow()];
    const res = await POST(req(declared()));
    expect(res.status).toBe(201);
    const t = tickets()[0];
    expect(t).toMatchObject({
      id: KEY, like_in_kind_statement: STATEMENT, like_in_kind_declared_by: REQ, like_in_kind_signature_id: SIG, engineering_required: false,
    });
    expect(typeof t.like_in_kind_declared_at).toBe("string");
    // GAP-110 acceptance 4: attributed in the history, in the requester's words
    expect(t.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "Declared like-in-kind (signed)", user: "rita@plant.io", role: "Requester", details: STATEMENT }),
    ]));
  });

  it("refused BEFORE a number is spent: no signature, another signer, another request, an edited statement, an expired signature", async () => {
    const cases: Array<[Row[] , RegExp]> = [
      [[], /not found/],
      [[sigRow({ signer_user_id: SUP })], /Only the requester/],
      [[sigRow({ resource_id: "7a000000-0000-4000-8000-000000000099" })], /different request/],
      [[sigRow({ statement: "Like-in-kind declaration: something else entirely, swapped" })], /changed after it was signed/],
      [[sigRow({ signed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })], /expired/],
      [[sigRow({ org_id: OTHER_ORG })], /another workspace/],
      [[sigRow({ intent: "Approved" })], /does not record a declaration/],
    ];
    for (const [rows, msg] of cases) {
      seed(); s.counter = new Map(); s.rpcCalls = [];
      s.tables.e_signatures = rows;
      const res = await POST(req(declared()));
      expect(res.status, String(msg)).toBe(400);
      const body = await res.json();
      expect(body.error, String(msg)).toMatch(msg);
      expect(tickets(), String(msg)).toHaveLength(0);
      expect(nextTicketRpc(), String(msg)).toHaveLength(0);
    }
  });

  it("a declaration already filed is refused 409 declaration_used (a double submit never files twice under one signature)", async () => {
    s.tables.e_signatures = [sigRow()];
    expect((await POST(req(declared()))).status).toBe(201);
    const again = await POST(req(declared()));
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("declaration_used");
    expect(tickets()).toHaveLength(1);
  });

  it("fix pass 2 (review, minor 8): two concurrent posts of one declaration — the second's insert collides on the row's id (tickets_pkey) after the pre-check passed: answered 409 declaration_used naming the filed request, never 'nothing was filed', and no second number is spent", async () => {
    s.tables.e_signatures = [sigRow()];
    let raced = false;
    s.hooks.push((table: string, op: string) => {
      if (table === "tickets" && op === "insert" && !raced) {
        raced = true;
        // the concurrent request lands first, under the same signed id
        s.tables.tickets.push({ id: KEY, org_id: ORG, ticket_id: `KE-DDRT-${YY}-0009`, requester_id: REQ, status: "PENDING_ASSIGNMENT" });
      }
    });
    s.errors["tickets.insert"] = [{ code: "23505", message: 'duplicate key value violates unique constraint "tickets_pkey"' }];
    const res = await POST(req(declared()));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("declaration_used");
    expect(body.error).toMatch(new RegExp(`KE-DDRT-${YY}-0009`));
    expect(tickets()).toHaveLength(1);
    expect(nextTicketRpc()).toHaveLength(1);
  });

  it("fix pass 3 (review, minor): an id that is another workspace's request is answered 409 declaration_key_used WITHOUT its request number — at the pre-check and on the concurrent-insert re-read alike — and files nothing", async () => {
    s.tables.e_signatures = [sigRow()];
    s.tables.tickets.push({ id: KEY, org_id: OTHER_ORG, ticket_id: "B-2026-0042", requester_id: "someone-else", status: "PENDING_ASSIGNMENT" });
    const res = await POST(req(declared()));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("declaration_key_used");
    expect(body.error).not.toMatch(/B-2026-0042/);
    expect(nextTicketRpc()).toHaveLength(0);
    // the race path: the foreign row lands between the pre-check and the insert
    seed(); s.counter = new Map(); s.rpcCalls = [];
    s.tables.e_signatures = [sigRow()];
    let raced = false;
    s.hooks.push((table: string, op: string) => {
      if (table === "tickets" && op === "insert" && !raced) {
        raced = true;
        s.tables.tickets.push({ id: KEY, org_id: OTHER_ORG, ticket_id: "B-2026-0043", requester_id: "someone-else", status: "PENDING_ASSIGNMENT" });
      }
    });
    s.errors["tickets.insert"] = [{ code: "23505", message: 'duplicate key value violates unique constraint "tickets_pkey"' }];
    const raceRes = await POST(req(declared()));
    const raceBody = await raceRes.json();
    expect(raceRes.status).toBe(409);
    expect(raceBody.code).toBe("declaration_key_used");
    expect(raceBody.error).not.toMatch(/B-2026-0043/);
    expect(tickets().filter((t) => t.org_id === ORG)).toHaveLength(0);
  });

  it("fix pass (review, minor 10): an id that already has a history — another person's signature, any other signature over it, or an audit row that is not this declaration's capture — is refused 409 declaration_key_used BEFORE a number is spent; the requester's own re-sign of the same id is not", async () => {
    const OTHER_SIG = "5a000000-0000-4000-8000-000000000002";
    const cases: Array<[Row[], Row[]]> = [
      [[sigRow(), { id: OTHER_SIG, org_id: ORG, resource_type: "ticket", resource_id: KEY, signer_user_id: SUP, intent: "Approved", statement: "Approved the old request" }], []],
      [[sigRow()], [{ id: "al-1", action: "TICKET_APPROVE_DRAFT_IFC", resource_id: KEY, org_id: ORG, details: {} }]],
      [[sigRow()], [{ id: "al-2", action: "ESIGNATURE_CAPTURED", resource_id: KEY, org_id: ORG, details: { signatureId: OTHER_SIG } }]],
    ];
    for (const [sigs, logs] of cases) {
      seed(); s.counter = new Map(); s.rpcCalls = [];
      s.tables.e_signatures = sigs;
      s.tables.audit_logs = logs;
      const res = await POST(req(declared()));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("declaration_key_used");
      expect(tickets()).toHaveLength(0);
      expect(nextTicketRpc()).toHaveLength(0);
    }
    // the requester's own earlier declaration signature over the same id, with its capture mirror, is fine
    seed(); s.counter = new Map(); s.rpcCalls = [];
    s.tables.e_signatures = [sigRow(), sigRow({ id: OTHER_SIG, statement: "Like-in-kind declaration: an earlier wording of the same declaration" })];
    s.tables.audit_logs = [{ id: "al-3", action: "ESIGNATURE_CAPTURED", resource_id: KEY, org_id: ORG, details: { signatureId: SIG } }, { id: "al-4", action: "ESIGNATURE_CAPTURED", resource_id: KEY, org_id: ORG, details: { signatureId: OTHER_SIG } }];
    expect((await POST(req(declared()))).status).toBe(201);
  });

  it("fix pass (review, minor 10): a history read that fails answers 503 and files nothing", async () => {
    s.tables.e_signatures = [sigRow()];
    s.errors["audit_logs.select"] = [{ code: "57014", message: "statement timeout" }];
    const res = await POST(req(declared()));
    expect(res.status).toBe(503);
    expect(tickets()).toHaveLength(0);
  });

  it("an unreadable signature read answers 503 and files nothing", async () => {
    s.tables.e_signatures = [sigRow()];
    s.errors["e_signatures.select"] = [{ code: "57014", message: "statement timeout" }];
    const res = await POST(req(declared()));
    expect(res.status).toBe(503);
    expect(tickets()).toHaveLength(0);
  });

  it("before 20261250 is pasted (42703 naming a declaration column) the request files the usual way, under the same number, and says the declaration was not recorded", async () => {
    s.tables.e_signatures = [sigRow()];
    s.errors["tickets.insert"] = [{ code: "42703", message: 'column "like_in_kind_statement" of relation "tickets" does not exist' }];
    const res = await POST(req(declared()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(JSON.stringify(body.warnings ?? [])).toMatch(/could not be recorded on the request yet/);
    const t = tickets()[0];
    expect(t.engineering_required).toBeUndefined();
    expect(t.like_in_kind_statement).toBeUndefined();
    expect(JSON.stringify(t.history)).not.toContain("Declared like-in-kind");
    expect(nextTicketRpc()).toHaveLength(1);
  });

  it("a malformed declaration is refused with the reason (never silently dropped); a short statement is refused at the contract", async () => {
    const res = await POST(req(portal({ attachments: [], declaration: { statement: "same", signatureId: SIG, ticketKey: KEY } })));
    expect(res.status).toBe(400);
    expect(tickets()).toHaveLength(0);
  });

  it("equipment: a resolved asset of this workspace is linked; a foreign or unknown one is kept as typed and flagged; the request is filed either way", async () => {
    const A1 = "a5000000-0000-4000-8000-000000000001";
    const AF = "a5000000-0000-4000-8000-000000000009";
    s.tables.assets = [{ id: A1, org_id: ORG, tag: "P-101" }, { id: AF, org_id: OTHER_ORG, tag: "XV-9" }];
    const res = await POST(req(portal({ attachments: [], equipment: [{ tag: "P-101", assetId: A1 }, { tag: "XV-9", assetId: AF }, { tag: "ZZ-1" }] })));
    expect(res.status).toBe(201);
    const body = await res.json();
    const rows = s.tables.ticket_equipment ?? [];
    expect(rows.map((r) => [r.tag, r.asset_id])).toEqual([["P-101", A1], ["XV-9", null], ["ZZ-1", null]]);
    expect(rows.every((r) => r.ticket_id === tickets()[0].id && r.org_id === ORG && r.created_by === REQ)).toBe(true);
    expect(JSON.stringify(body.warnings)).toMatch(/kept as typed: XV-9, ZZ-1/);
  });

  it("fix pass (review, minor 14): a tag the form could not look up is said as such — never 'not found' when nobody could ask", async () => {
    const res = await POST(req(portal({ attachments: [], equipment: [{ tag: "P-101", lookupFailed: true }, { tag: "ZZ-1" }] })));
    expect(res.status).toBe(201);
    const w = JSON.stringify((await res.json()).warnings);
    expect(w).toMatch(/Could not be checked against the equipment registry \(the lookup failed\), kept as typed: P-101/);
    expect(w).toMatch(/Not found in the equipment registry, kept as typed: ZZ-1\./);
    expect((s.tables.ticket_equipment ?? []).map((r) => r.tag)).toEqual(["P-101", "ZZ-1"]);
  });

  it("equipment before 20261251 is pasted: the request is filed and the answer says the equipment was not recorded", async () => {
    s.errors["ticket_equipment.insert"] = [{ code: "42P01", message: 'relation "ticket_equipment" does not exist' }];
    const res = await POST(req(portal({ attachments: [], equipment: [{ tag: "P-101" }] })));
    expect(res.status).toBe(201);
    expect(JSON.stringify((await res.json()).warnings)).toMatch(/20261251 is not applied/);
    expect(tickets()).toHaveLength(1);
  });
});

// ── drafting-flow Round G, DF-P8 PROJECTS — GAP-114 / DEC-40 / PROJ-4 / PROJ-10 / PROJ-12 ──
describe("DF-P8 — a request filed into a project names it BY REFERENCE (tickets.project_id), confirmed by the route", () => {
  const activity = () => (s.tables.project_activity ?? []) as Row[];
  it("the request form: a project of the workspace the caller can see is written, with one project feed row; REGRESSION: no projectId → no project_id, no feed row", async () => {
    const res = await POST(req({ ...portal({ attachments: [] }), projectId: PROJECT }));
    expect(res.status).toBe(201);
    expect(tickets()[0].project_id).toBe(PROJECT);
    expect(activity()).toHaveLength(1);
    expect(activity()[0]).toMatchObject({ project_id: PROJECT, org_id: ORG, type: "request_linked" });
    s.tables.tickets = []; s.tables.project_activity = [];
    const plain = await POST(req(portal({ attachments: [] })));
    expect(plain.status).toBe(201);
    expect("project_id" in tickets()[0]).toBe(false);
    expect(activity()).toHaveLength(0);
  });
  it("the request form: an unknown, malformed, another workspace's or closed project is dropped with a warning — never a refusal", async () => {
    for (const projectId of ["ffffffff-0000-4000-8000-0000000000aa", "not-a-uuid"]) {
      s.tables.tickets = [];
      const res = await POST(req({ ...portal({ attachments: [] }), projectId }));
      expect(res.status).toBe(201);
      expect(JSON.stringify((await res.json()).warnings)).toMatch(/project named is not one you can see/);
      expect("project_id" in tickets()[0]).toBe(false);
    }
    s.tables.tickets = [];
    (s.tables.projects as Row[])[1].status = "completed";
    const closed = await POST(req({ ...portal({ attachments: [] }), projectId: PROJECT2 }));
    expect(JSON.stringify((await closed.json()).warnings)).toMatch(/or it is closed/);
    expect("project_id" in tickets()[0]).toBe(false);
  });
  it("PROJ-4 / PROJ-10: a check-in takes the project of the requester's OWN checkout session (whatever the body says) and stamps that session with the request", async () => {
    (s.tables.checkout_sessions as Row[])[0].project_id = PROJECT;
    const res = await POST(req({ ...checkin(), projectId: PROJECT2 }));
    expect(res.status).toBe(201);
    const t = tickets()[0];
    expect(t.project_id).toBe(PROJECT);
    expect((s.tables.checkout_sessions as Row[])[0].linked_ticket_id).toBe(t.id);
    expect((s.tables.checkout_sessions as Row[])[1].linked_ticket_id).toBeUndefined();
    expect(activity().map((a) => a.project_id)).toEqual([PROJECT]);
    expect((t.metadata as Row).project_link).toMatchObject({ projectId: PROJECT, authority: "checkin", registerAuthority: true });
  });
  it("REGRESSION: an ad-hoc check-in (a session with no project) files as today — no project_id, no feed row — and its session is still stamped with the request", async () => {
    const res = await POST(req(checkin()));
    expect(res.status).toBe(201);
    expect("project_id" in tickets()[0]).toBe(false);
    expect(activity()).toHaveLength(0);
    expect((s.tables.checkout_sessions as Row[])[0].linked_ticket_id).toBe(tickets()[0].id);
  });
  it("PROJ-12: an intake collision names its verified project in the column (and still in metadata.intake_collision), with a feed row", async () => {
    const res = await POST(req(collision()));
    expect(res.status).toBe(201);
    const t = tickets()[0];
    expect(t.project_id).toBe(PROJECT);
    expect((t.metadata as Row).intake_collision).toMatchObject({ projectId: PROJECT });
    expect(activity()[0]).toMatchObject({ project_id: PROJECT, type: "request_linked" });
  });
  it("before 20261256: the insert answers 42703 naming project_id — retried once without it, the request filed; the request form says the project was not recorded, a collision says nothing (its metadata carries the project, as today)", async () => {
    s.errors["tickets.insert"] = [{ code: "42703", message: 'column "project_id" of relation "tickets" does not exist' }];
    const res = await POST(req({ ...portal({ attachments: [] }), projectId: PROJECT }));
    expect(res.status).toBe(201);
    expect(JSON.stringify((await res.json()).warnings)).toMatch(/20261256 is not applied/);
    expect(tickets()).toHaveLength(1);
    expect("project_id" in tickets()[0]).toBe(false);
    expect(activity()).toHaveLength(0);
    s.tables.tickets = [];
    s.errors["tickets.insert"] = [{ code: "PGRST204", message: "Could not find the 'project_id' column of 'tickets' in the schema cache" }];
    const col = await POST(req(collision()));
    expect(col.status).toBe(201);
    expect(JSON.stringify((await col.json()).warnings ?? [])).not.toMatch(/20261256/);
    expect((tickets()[0].metadata as Row).intake_collision).toMatchObject({ projectId: PROJECT });
    // no reference recorded → no link record either (the paste's backfill still fills it)
    expect((tickets()[0].metadata as Row).project_link).toBeUndefined();
  });
  it("fix pass 2 (PM-8 / SEC-17): the link is recorded with whether the project register's policy admits who made it — a form project only for a caller who manages it (asked AS THE CALLER); a check-in's or a collision's project is the server's own record", async () => {
    // a requester who merely sees the project
    await POST(req({ ...portal({ attachments: [] }), projectId: PROJECT }));
    expect((tickets()[0].metadata as Row).project_link).toMatchObject({ projectId: PROJECT, authority: "portal", registerAuthority: false });
    expect(s.rpcCalls.filter((c) => c.client === "caller" && c.fn === "can_manage_project").map((c) => c.args)).toEqual([{ p_project: PROJECT }]);
    // one who manages it
    s.tables.tickets = []; s.tables.project_activity = [];
    s.callerRpc = { can_manage_project: (a) => ({ data: a.p_project === PROJECT, error: null }) };
    await POST(req({ ...portal({ attachments: [] }), projectId: PROJECT }));
    expect((tickets()[0].metadata as Row).project_link).toMatchObject({ registerAuthority: true });
    // an unanswerable check is never a yes
    s.tables.tickets = [];
    s.callerRpc = { is_org_controller: () => ({ data: null, error: { message: "timeout" } }), can_manage_project: () => ({ data: null, error: { message: "timeout" } }) };
    await POST(req({ ...portal({ attachments: [] }), projectId: PROJECT }));
    expect((tickets()[0].metadata as Row).project_link).toMatchObject({ registerAuthority: false });
    // the server's own record
    s.tables.tickets = []; s.callerRpc = {};
    await POST(req(collision()));
    expect((tickets()[0].metadata as Row).project_link).toMatchObject({ projectId: PROJECT, authority: "intake_collision", registerAuthority: true });
    // REGRESSION: no project → no link record
    s.tables.tickets = [];
    await POST(req(portal({ attachments: [] })));
    expect((tickets()[0].metadata as Row).project_link).toBeUndefined();
  });
});
