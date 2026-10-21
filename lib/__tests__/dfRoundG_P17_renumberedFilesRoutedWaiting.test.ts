// drafting-flow Round G, package DF-P17 RENUMBERED REQUEST FILES AND ROUTED
// WAITING-ON (ruled under DEC-90: fail-safe, no regression).
//
//   * EDGE-19 — a request the restore brought back under a fresh number
//     (admin-and-org P16, EDGE-5 ruling (3)) keeps its files under its
//     ORIGINAL number's folder; storage is never moved. Every per-number
//     request-prefix test (lib/ticketFilePrefix.ts: the page's mirror
//     lib/ticketCopyRequest.ts ticketFileCopyPath, app/api/tickets/copy,
//     app/api/tickets/workflow-action vetTicketAttachment) also admits that
//     folder — for a file the request LISTS, the number read from the
//     restore's own history line and, on the server, confirmed by the
//     restore's RESTORE_CHUNK audit row written by an Admin (tickets.history
//     is member-writable wherever ticket_update_guard is not pasted) — and
//     nothing else. The request KEEPING the old number cannot take, as its
//     own, a key a request renumbered away from its number lists. A request
//     never renumbered makes no AUDIT read and its own files get today's
//     answers (pinned on each caller); the workflow route does read tickets
//     once per unlisted upload on every request for that holder check (the
//     DF-P17 trade-off, pinned too). A RESTORE_CHUNK row the database
//     stamped actor_kind 'server' (20261201) confirms whoever the restoring
//     Admin is today (DF-P17 fix pass); a 'member' row never confirms, and a
//     failed or truncated holder-side read gives today's answer, recorded
//     `renumberedSiblingUnchecked` (final fix pass, the integrator's rulings
//     1-3). The restore half is driven for real
//     (apply-table on the in-memory engine), and its rows then drive the
//     workflow route and the copy route.
//   * ROUTE-15 — holdersFor on a review with a current routing roster names
//     the primaries of its OPEN BLOCKING slots (kind co_reviewers, part = the
//     slot labels), so the waiting-on line and the no-actions explanation
//     name them; notify-only and satisfied slots never hold it; an
//     unconfigured ticket's holders are unchanged in every status. Final fix
//     pass (ruling 4): an occupant slotSignPlan's drafter / requester legs
//     block is dropped, a slot's alternates join once their window opens.
//   * The request page changes only the waiting-on read (and hands the copy
//     viewer the history) — DF-P6's hunks stay intact (pinned).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import type { Ticket, TicketAttachment, TicketReviewRoster, TicketReviewSlot, TicketStatus } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ═════════════════════════════════════════════════════════════════════════════
// Harness: a Proxy-chain supabaseAdmin over `state.rows` (the dfRoundG_P1 /
// sweepRoundD3 pattern) with jsonb containment, JSON-path eq and `in`; the
// restore runs on the in-memory engine (restoreMemoryDb) through serverAuth.
// ═════════════════════════════════════════════════════════════════════════════
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, Array<{ code?: string; message: string } | null>>,
  objects: {} as Record<string, Uint8Array>,
}));

function jsonContains(a: unknown, b: unknown): boolean {
  if (Array.isArray(b)) return Array.isArray(a) && b.every((x) => a.some((y) => jsonContains(y, x)));
  if (b && typeof b === "object") {
    return !!a && typeof a === "object" && !Array.isArray(a)
      && Object.entries(b as Record<string, unknown>).every(([k, v]) => jsonContains((a as Record<string, unknown>)[k], v));
  }
  return a === b;
}
function pathValue(r: Record<string, unknown>, col: string): unknown {
  const m = /^(\w+)((?:->\w+)*)->>(\w+)$/.exec(col);
  if (!m) return r[col];
  let at: unknown = r[m[1]];
  for (const k of m[2].split("->").filter(Boolean)) at = (at as Record<string, unknown> | null | undefined)?.[k];
  const v = (at as Record<string, unknown> | null | undefined)?.[m[3]];
  return v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v);
}
function chain(table: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  let head = false;
  let method: string | null = null;
  let limit: number | null = null;
  const rows = () => {
    const out = (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
    return limit === null ? out : out.slice(0, limit);
  };
  const errOf = () => state.errors[`${table}.${method ?? "select"}`]?.shift() ?? null;
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        const err = errOf();
        if (err) return resolve({ data: null, error: err });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        if (method === "insert" || method === "upsert") return resolve({ data: [], error: null });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") method = prop;
        if (prop === "eq") { const [k, v] = args as [string, unknown]; filters.push((r) => pathValue(r, k) === v); }
        if (prop === "is") { const [k, v] = args as [string, unknown]; filters.push((r) => (v === null ? r[k] == null : r[k] === v)); }
        if (prop === "in") { const [k, v] = args as [string, unknown[]]; filters.push((r) => v.includes(r[k])); }
        if (prop === "contains") {
          const [k, raw] = args as [string, unknown];
          const v = typeof raw === "string" && /^[[{]/.test(raw) ? JSON.parse(raw) : raw;
          filters.push((r) => jsonContains(r[k], v));
        }
        if (prop === "limit") limit = Number(args[0]);
        if (prop === "maybeSingle" || prop === "single") {
          const err = errOf();
          if (err) return Promise.resolve({ data: null, error: err });
          return Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
      admin: { getUserById: vi.fn(async () => ({ data: { user: null }, error: { message: "User not found" } })) },
    },
    from: (t: string) => chain(t),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "test-bucket",
  r2: {
    send: vi.fn(async (cmd: { input?: { Key?: string } }) => {
      const key = String(cmd?.input?.Key ?? "");
      state.calls.push({ table: "r2", method: "send", args: [key] });
      const b = state.objects[key];
      if (!b) throw Object.assign(new Error("not found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      return {
        ContentLength: b.length, ETag: '"etag-1"',
        Body: {
          transformToByteArray: async () => b,
          transformToWebStream: () => new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(b); ctl.close(); } }),
        },
      };
    }),
  },
}));
vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@x.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});

import { db } from "./helpers/restoreMemoryDb";
import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { POST as copyPost } from "@/app/api/tickets/copy/route";
import { TICKET_RENUMBERED } from "@/lib/dataRestore";
import {
  RESTORE_RENUMBERED_NOTE_CODE, RESTORE_HISTORY_USER, ticketFolder, underFolder, restoredFromNumber, restoredFromFolder,
  restoreRenumberingConfirmed, renumberedRequestListsKey,
} from "@/lib/ticketFilePrefix";
import { ticketFileCopyPath } from "@/lib/ticketCopyRequest";
import { holdersFor, explainNoActions, rosterHolderUids, RESTORE_RENUMBERED_HISTORY_ACTION } from "@/lib/ticketAttention";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import { currentRoster, slotSignPlan } from "@/lib/workflow";

const ORG = "o1";
const OLD = "KE-DDRT-26-0007";
/** The two backup requests carrying OLD (row ids are UUIDs, as the copy route requires). */
const B1 = "b1b1b1b1-0000-4000-8000-000000000001";
const B2 = "b2b2b2b2-0000-4000-8000-000000000002";
const OLD_FOLDER = `orgs/${ORG}/tickets/${OLD}/`;
const LM = "2026-10-02T00:00:00.000Z";
const member = (uid: string, role: string, roles = [role], over: Record<string, unknown> = {}) =>
  ({ org_id: ORG, uid, role, roles, email: `${uid}@x.io`, display_name: null, status: "active", ...over });
const workflow = (body: unknown) => workflowAction(new NextRequest("http://app.local/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const copy = (body: unknown) => copyPost(new NextRequest("https://app.example.com/api/tickets/copy", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const auditReads = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "select");
const ticketWrites = () => state.calls.filter((c) => c.table === "tickets" && ["update", "insert", "upsert", "delete"].includes(c.method));
async function pdfBytes(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return new Uint8Array(await d.save());
}

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.objects = {};
  db.rows = { orgs: [{ id: ORG, name: "Acme" }], org_members: [] };
  db.keys = { ticket_number_counters: [["org_id", "year"]] };
  db.writeError = null; db.readError = {}; db.writes = []; db.attempts = []; db.countless = false; db.fks = {};
  db.maxRows = 1000; db.generated = {}; db.authUsers = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.NEXT_PUBLIC_SITE_URL = "https://plant.example.com";
});
afterEach(() => { vi.restoreAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════════
// EDGE-19 — the helper
// ═════════════════════════════════════════════════════════════════════════════
const restoreLine = (from: string, to: string, over: Record<string, unknown> = {}) => ({
  action: RESTORE_RENUMBERED_HISTORY_ACTION, user: RESTORE_HISTORY_USER, date: "2026-10-21T00:00:00.000Z",
  details: `Issued as "${from}"; request t-b-1 of this backup (restored first) carries that number (the workspace the backup was taken from held the number twice), so this request was restored as "${to}". Its files stay where the backup had them, in the "${from}" folder.`,
  ...over,
});

describe("EDGE-19 — lib/ticketFilePrefix.ts: the original number comes from the restore's own history line, and nothing else", () => {
  it("the note code and the history user are the restore's own (lib/dataRestore.ts)", () => {
    expect(RESTORE_RENUMBERED_NOTE_CODE).toBe(TICKET_RENUMBERED);
    expect(src("lib/dataRestore.ts")).toContain(`action: RESTORE_RENUMBERED_HISTORY_ACTION, user: "${RESTORE_HISTORY_USER}", date: at,`);
  });

  it("a request never renumbered has no original number (no history, a plain history, another line)", () => {
    for (const history of [undefined, null, [], [{ action: "Created", user: "a@x.io", date: LM }], "not a list", { a: 1 }]) {
      expect(restoredFromNumber({ ticketNumber: "REQ-1", history })).toBeNull();
      expect(restoredFromFolder({ orgId: ORG, ticketNumber: "REQ-1", history })).toBeNull();
    }
  });

  it("reads the line whose 'restored as' number is the CURRENT number; a line for another number, from another user, or naming an unsafe folder admits nothing", () => {
    expect(restoredFromNumber({ ticketNumber: "DDRT-26-0123", history: [restoreLine(OLD, "DDRT-26-0123")] })).toBe(OLD);
    expect(restoredFromFolder({ orgId: ORG, ticketNumber: "DDRT-26-0123", history: [restoreLine(OLD, "DDRT-26-0123")] })).toBe(OLD_FOLDER);
    // the line names a different current number (the request was renumbered again, or the line was copied)
    expect(restoredFromNumber({ ticketNumber: "DDRT-26-0999", history: [restoreLine(OLD, "DDRT-26-0123")] })).toBeNull();
    // not the restore's user (a member's own appended line names them)
    expect(restoredFromNumber({ ticketNumber: "DDRT-26-0123", history: [restoreLine(OLD, "DDRT-26-0123", { user: "eve@x.io" })] })).toBeNull();
    // the action label must be the restore's
    expect(restoredFromNumber({ ticketNumber: "DDRT-26-0123", history: [restoreLine(OLD, "DDRT-26-0123", { action: "Comment" })] })).toBeNull();
    // a folder segment that is not a plain number
    for (const bad of ["..", "a/b", "x\\y"]) {
      expect(restoredFromNumber({ ticketNumber: "DDRT-26-0123", history: [restoreLine(bad, "DDRT-26-0123")] })).toBeNull();
    }
    // the same number twice is no renumbering
    expect(restoredFromNumber({ ticketNumber: OLD, history: [restoreLine(OLD, OLD)] })).toBeNull();
    // the newest matching line wins
    expect(restoredFromNumber({ ticketNumber: "DDRT-26-0123", history: [restoreLine("KE-1", "DDRT-26-0123"), restoreLine(OLD, "DDRT-26-0123")] })).toBe(OLD);
  });

  it("ticketFolder / underFolder are today's test: inside the folder, never the folder itself", () => {
    expect(ticketFolder(ORG, "REQ-1")).toBe("orgs/o1/tickets/REQ-1/");
    expect(underFolder("orgs/o1/tickets/REQ-1/a.pdf", "orgs/o1/tickets/REQ-1/")).toBe(true);
    expect(underFolder("orgs/o1/tickets/REQ-1/", "orgs/o1/tickets/REQ-1/")).toBe(false);
    expect(underFolder("orgs/o1/tickets/REQ-10/a.pdf", "orgs/o1/tickets/REQ-1/")).toBe(false);
  });

  it("restoreRenumberingConfirmed: only a RESTORE_CHUNK row naming this row's from → to, written by an active Admin, confirms; a read error is 'unknown'", async () => {
    const note = (from: string, to: string, id = B2) => ({ id, code: TICKET_RENUMBERED, message: "m", renumbered: { from, to, numberHeldBy: B1 } });
    const row = (user_id: string, notes: unknown[], table = "tickets") => ({ org_id: ORG, action: "RESTORE_CHUNK", user_id, details: { table, cleared: notes } });
    const ask = () => restoreRenumberingConfirmed({ from: (t: string) => chain(t) }, { orgId: ORG, ticketRowId: B2, from: OLD, to: "DDRT-26-0123" });
    state.rows.org_members = [member("admin-1", "Admin"), member("eve", "Drafter"), member("gone", "Admin", ["Admin"], { status: "removed" })];
    expect(await ask()).toBe(false);
    state.rows.audit_logs = [row("eve", [note(OLD, "DDRT-26-0123")])]; // a member's own forged row
    expect(await ask()).toBe(false);
    state.rows.audit_logs = [row("gone", [note(OLD, "DDRT-26-0123")])]; // an Admin no longer active
    expect(await ask()).toBe(false);
    state.rows.audit_logs = [row("admin-1", [note("KE-OTHER", "DDRT-26-0123")]), row("admin-1", [note(OLD, "DDRT-26-0999")]), row("admin-1", [note(OLD, "DDRT-26-0123", "t-x")])];
    expect(await ask()).toBe(false);
    state.rows.audit_logs = [{ ...row("admin-1", [note(OLD, "DDRT-26-0123")]), action: "RESTORE_PREVIEW" }];
    expect(await ask()).toBe(false);
    state.rows.audit_logs = [{ ...row("admin-1", [note(OLD, "DDRT-26-0123")]), org_id: "o2" }];
    expect(await ask()).toBe(false);
    state.rows.audit_logs = [row("admin-1", [note(OLD, "DDRT-26-0123")])];
    expect(await ask()).toBe(true);
    state.errors["audit_logs.select"] = [{ message: "timeout" }];
    expect(await ask()).toBe("unknown");
    state.errors["org_members.select"] = [{ message: "timeout" }];
    expect(await ask()).toBe("unknown");
  });

  it("restoreRenumberingConfirmed (fix pass): a row the database stamped actor_kind 'server' confirms by itself — the restoring Admin may have left; a 'member' row never confirms; an unstamped row still needs an active Admin writer", async () => {
    const note = (from: string, to: string) => ({ id: B2, code: TICKET_RENUMBERED, message: "m", renumbered: { from, to, numberHeldBy: B1 } });
    const row = (user_id: string, actor_kind?: string, notes: unknown[] = [note(OLD, "DDRT-26-0123")]) =>
      ({ org_id: ORG, action: "RESTORE_CHUNK", user_id, ...(actor_kind ? { actor_kind } : {}), details: { table: "tickets", cleared: notes } });
    const ask = () => restoreRenumberingConfirmed({ from: (t: string) => chain(t) }, { orgId: ORG, ticketRowId: B2, from: OLD, to: "DDRT-26-0123" });
    state.rows.org_members = [member("eve", "Drafter"), member("gone", "Admin", ["Admin"], { status: "removed" }), member("admin-1", "Admin")];
    // the service role's row (apply-table) whose Admin has since been removed
    state.rows.audit_logs = [row("gone", "server")];
    state.calls = [];
    expect(await ask()).toBe(true);
    expect(state.calls.filter((c) => c.table === "org_members")).toHaveLength(0); // no membership read needed
    expect(state.calls.find((c) => c.table === "audit_logs" && c.method === "select")?.args[0]).toBe("user_id, details, actor_kind");
    // a 'server' stamp on a row naming another pair, another row or another action confirms nothing
    state.rows.audit_logs = [row("gone", "server", [note("KE-OTHER", "DDRT-26-0123")]), { ...row("gone", "server"), action: "RESTORE_PREVIEW" }, { ...row("gone", "server"), org_id: "o2" }];
    expect(await ask()).toBe(false);
    // a member's own insert is stamped 'member' and NEVER confirms (final fix pass, the integrator's ruling 2): a Drafter's forged row, a removed Admin's, an active Admin's
    state.rows.audit_logs = [row("eve", "member")];
    expect(await ask()).toBe(false);
    state.rows.audit_logs = [row("gone", "member")];
    expect(await ask()).toBe(false);
    state.rows.audit_logs = [row("admin-1", "member")];
    expect(await ask()).toBe(false);
    // an unstamped row (actor_kind null) keeps the active-Admin check
    state.rows.audit_logs = [{ ...row("admin-1"), actor_kind: null }];
    expect(await ask()).toBe(true);
    state.rows.audit_logs = [{ ...row("gone"), actor_kind: null }];
    expect(await ask()).toBe(false);
    // before 20261201 the column is absent: the read is re-sent without it and the active-Admin check decides
    state.calls = [];
    state.rows.audit_logs = [row("admin-1")];
    state.errors["audit_logs.select"] = [{ code: "42703", message: "column audit_logs.actor_kind does not exist" }];
    expect(await ask()).toBe(true);
    expect(state.calls.filter((c) => c.table === "audit_logs" && c.method === "select").map((c) => c.args[0])).toEqual(["user_id, details, actor_kind", "user_id, details"]);
    state.rows.audit_logs = [row("gone")];
    state.errors["audit_logs.select"] = [{ code: "PGRST204", message: "Could not find the 'actor_kind' column of 'audit_logs' in the schema cache" }];
    expect(await ask()).toBe(false);
    // any other failure — or the retry failing — is 'unknown', never an admit
    state.errors["audit_logs.select"] = [{ code: "57014", message: "canceling statement due to statement timeout" }];
    expect(await ask()).toBe("unknown");
    state.errors["audit_logs.select"] = [{ code: "42703", message: "column audit_logs.actor_kind does not exist" }, { message: "timeout" }];
    expect(await ask()).toBe("unknown");
  });

  it("restoreRenumberingConfirmed (final fix pass, ruling 3): the pair is in the containment filter; 'server' rows are read first, then unstamped rows, each oldest first; 25 forged member rows do not hide the genuine server row", async () => {
    const note = (from: string, to: string) => ({ id: B2, code: TICKET_RENUMBERED, message: "m", renumbered: { from, to, numberHeldBy: B1 } });
    const row = (user_id: string, actor_kind: string | null | undefined, notes: unknown[] = [note(OLD, "DDRT-26-0123")]) =>
      ({ org_id: ORG, action: "RESTORE_CHUNK", user_id, ...(actor_kind !== undefined ? { actor_kind } : {}), details: { table: "tickets", cleared: notes } });
    const ask = () => restoreRenumberingConfirmed({ from: (t: string) => chain(t) }, { orgId: ORG, ticketRowId: B2, from: OLD, to: "DDRT-26-0123" });
    state.rows.org_members = [member("eve", "Drafter"), member("admin-1", "Admin"), member("gone", "Admin", ["Admin"], { status: "removed" })];
    // 25 forged rows a member inserted (stamped 'member'), then the restore's own
    state.rows.audit_logs = [...Array.from({ length: 25 }, () => row("eve", "member")), row("gone", "server")];
    state.calls = [];
    expect(await ask()).toBe(true);
    const contains = state.calls.find((c) => c.table === "audit_logs" && c.method === "contains");
    expect(JSON.parse(String(contains?.args[1]))).toEqual({ table: "tickets", cleared: [{ code: TICKET_RENUMBERED, id: B2, renumbered: { from: OLD, to: "DDRT-26-0123" } }] });
    expect(state.calls.filter((c) => c.table === "audit_logs" && c.method === "eq" && c.args[0] === "actor_kind")).toEqual([{ table: "audit_logs", method: "eq", args: ["actor_kind", "server"] }]);
    expect(state.calls.filter((c) => c.table === "audit_logs" && c.method === "order").map((c) => c.args)).toEqual([["timestamp", { ascending: true }], ["id", { ascending: true }]]);
    expect(auditReads()).toHaveLength(1); // confirmed by the server read; no unstamped read
    // no server row: the unstamped read follows (actor_kind IS NULL), oldest first; the forged 'member' rows are never read
    state.rows.audit_logs = [...Array.from({ length: 25 }, () => row("eve", "member")), row("admin-1", null)];
    state.calls = [];
    expect(await ask()).toBe(true);
    expect(auditReads()).toHaveLength(2);
    expect(state.calls.filter((c) => c.table === "audit_logs" && c.method === "is")).toEqual([{ table: "audit_logs", method: "is", args: ["actor_kind", null] }]);
    expect(state.calls.filter((c) => c.table === "audit_logs" && c.method === "order")).toHaveLength(4);
    // a FULL page of unstamped rows with no confirming writer: not confirmed (fail-safe — "truncated"), even with a genuine row past the page
    state.rows.audit_logs = [...Array.from({ length: 20 }, () => row("eve", null)), row("admin-1", null)];
    expect(await ask()).toBe(false);
    // a 'member' row a database answered past the filter is still skipped
    state.rows.audit_logs = [row("admin-1", "member")];
    expect(await ask()).toBe(false);
    // the server read failing (not the missing column) is 'unknown', and the unstamped read failing too
    state.rows.audit_logs = [row("admin-1", null)];
    state.errors["audit_logs.select"] = [{ code: "57014", message: "canceling statement due to statement timeout" }];
    expect(await ask()).toBe("unknown");
    state.errors["audit_logs.select"] = [null, { message: "timeout" }];
    expect(await ask()).toBe("unknown");
    // the column absent: today's single read with no actor_kind filter
    state.calls = [];
    state.errors["audit_logs.select"] = [{ code: "42703", message: "column audit_logs.actor_kind does not exist" }];
    state.rows.audit_logs = [row("admin-1", undefined)];
    expect(await ask()).toBe(true);
    expect(state.calls.filter((c) => c.table === "audit_logs" && (c.method === "is" || (c.method === "eq" && c.args[0] === "actor_kind")))).toHaveLength(1); // the first (server) read only
  });

  it("renumberedRequestListsKey: a request renumbered AWAY from this number listing the key; a read error is 'unknown'", async () => {
    const ask = (key: string) => renumberedRequestListsKey({ from: (t: string) => chain(t) }, { orgId: ORG, number: OLD, key });
    state.rows.tickets = [
      { id: B1, org_id: ORG, ticket_id: OLD, attachments: [{ url: `${OLD_FOLDER}a.pdf` }] },
      { id: B2, org_id: ORG, ticket_id: "DDRT-26-0123", metadata: { restore_renumbered: { from: OLD, to: "DDRT-26-0123" } }, attachments: [{ url: `${OLD_FOLDER}final.pdf` }] },
      { id: "t-o2", org_id: "o2", ticket_id: "X", metadata: { restore_renumbered: { from: OLD } }, attachments: [{ url: `${OLD_FOLDER}other.pdf` }] },
    ];
    expect(await ask(`${OLD_FOLDER}final.pdf`)).toBe(true);
    expect(await ask(`${OLD_FOLDER}a.pdf`)).toBe(false); // the holder's own file
    expect(await ask(`${OLD_FOLDER}other.pdf`)).toBe(false); // another workspace
    expect(await ask(`${OLD_FOLDER}new-upload.pdf`)).toBe(false);
    state.errors["tickets.select"] = [{ message: "timeout" }];
    expect(await ask(`${OLD_FOLDER}final.pdf`)).toBe("unknown");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EDGE-19 — the page's mirror (lib/ticketCopyRequest.ts ticketFileCopyPath)
// ═════════════════════════════════════════════════════════════════════════════
describe("EDGE-19 — ticketFileCopyPath: a renumbered request's listed file under its original folder takes the server path; every other answer is today's", () => {
  const FID = "11111111-1111-4111-8111-111111111111";
  const ctx = (over: Record<string, unknown> = {}) => ({ ticketRowId: "t1", orgId: ORG, ticketNumber: "REQ-1", requesterId: "req-1", attachments: [{ id: FID }], ...over });
  it("REGRESSION — a request never renumbered: the same answers with or without the history field", () => {
    const cases: Array<[string, string]> = [
      ["orgs/o1/tickets/REQ-1/a.pdf", "server"],
      ["orgs/o1/tickets/REQ-2/a.pdf", "browser"],
      [`${OLD_FOLDER}a.pdf`, "browser"],
      ["https://cdn.example.com/a.pdf", "browser"],
      ["orgs/o1/tickets/REQ-1/../REQ-2/a.pdf", "browser"],
    ];
    for (const [url, kind] of cases) {
      for (const history of [undefined, [], [{ action: "Created", user: "a@x.io", date: LM }]]) {
        expect(ticketFileCopyPath({ id: FID, url }, ctx({ history })).kind, `${url} ${JSON.stringify(history)}`).toBe(kind);
      }
    }
  });
  it("a renumbered request: its listed file under the original number's folder is 'server'; another request's folder, or a line for another number, stays 'browser'", () => {
    const history = [restoreLine(OLD, "DDRT-26-0123")];
    const c = ctx({ ticketNumber: "DDRT-26-0123", history });
    expect(ticketFileCopyPath({ id: FID, url: `${OLD_FOLDER}final.pdf` }, c)).toEqual({ kind: "server" });
    expect(ticketFileCopyPath({ id: FID, url: "orgs/o1/tickets/DDRT-26-0123/new.pdf" }, c)).toEqual({ kind: "server" });
    expect(ticketFileCopyPath({ id: FID, url: "orgs/o1/tickets/KE-DDRT-26-0008/x.pdf" }, c)).toEqual({ kind: "browser", reason: "outside_request" });
    expect(ticketFileCopyPath({ id: FID, url: `orgs/o2/tickets/${OLD}/final.pdf` }, c)).toEqual({ kind: "browser", reason: "outside_request" });
    expect(ticketFileCopyPath({ id: FID, url: `${OLD_FOLDER}final.pdf` }, ctx({ ticketNumber: "DDRT-26-0999", history }))).toEqual({ kind: "browser", reason: "outside_request" });
    // a file the ticket does not name once is unaddressable, as before
    expect(ticketFileCopyPath({ id: "22222222-2222-4222-8222-222222222222", url: `${OLD_FOLDER}final.pdf` }, c)).toEqual({ kind: "browser", reason: "unaddressable" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EDGE-19 — done-when 2 and 3, driven end to end: the restore lands two
// carriers of one number (the second with files, renumbered), then its rows
// drive the workflow route's file check and the copy route.
// ═════════════════════════════════════════════════════════════════════════════
async function restoreTwoCarriers() {
  const backupFiles = [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "final.pdf", url: `orgs/backup-org/tickets/${OLD}/final.pdf`, type: "Final", status: "submitted", uploadedBy: "d-1@x.io" },
    { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "markup.pdf", url: `orgs/backup-org/tickets/${OLD}/markup.pdf`, type: "Reference", status: "submitted", uploadedBy: "d-1@x.io" },
  ];
  const t = (id: string, extra: Record<string, unknown>) => ({ id, org_id: "backup-org", ticket_id: OLD, title: `Request ${id}`, status: "CLOSED", ...extra });
  const res = await applyTable(new NextRequest(`https://app/api/admin/restore/apply-table?orgId=${ORG}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({
      table: "tickets",
      rows: [
        t(B1, { attachments: [{ id: "aaaaaaaa-0000-4000-8000-0000000000a1", name: "a.pdf", url: `orgs/backup-org/tickets/${OLD}/a.pdf`, type: "Draft", status: "submitted" }] }),
        t(B2, { attachments: backupFiles }),
      ],
      idRemap: { orgId: { "backup-org": ORG }, uid: {} }, manifest: { orgId: "backup-org" },
    }),
  }));
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status, JSON.stringify(body)).toBe(200);
  const tickets = db.rows.tickets ?? [];
  const b1 = tickets.find((r) => r.id === B1)!;
  const b2 = tickets.find((r) => r.id === B2)!;
  expect(b1.ticket_id).toBe(OLD);
  expect(b2.ticket_id).not.toBe(OLD);
  expect((b2.attachments as Array<{ url: string }>).map((a) => a.url)).toEqual([`${OLD_FOLDER}final.pdf`, `${OLD_FOLDER}markup.pdf`]);
  return { b1, b2, NEW: String(b2.ticket_id), audit: (db.rows.audit_logs ?? []).filter((a) => a.action === "RESTORE_CHUNK") };
}
/** The restored rows, placed in the route's view of the database with the
 *  workflow state a live request has (the restore wrote them CLOSED). */
function seed(r: Awaited<ReturnType<typeof restoreTwoCarriers>>, over: { b1?: Record<string, unknown>; b2?: Record<string, unknown> } = {}) {
  const live = { request_type: "ISO", unit: "U-100", requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1",
    assigned_engineer_id: null, comments: [], watchers: [], unread_by: [], revision_count: 0, last_modified: LM, archived_at: null, deliverable_rev: "0" };
  state.rows.tickets = [
    { ...r.b1, ...live, status: "PENDING_IFC", ...(over.b1 ?? {}) },
    { ...r.b2, ...live, status: "PENDING_IFC", ...(over.b2 ?? {}) },
  ];
  state.rows.audit_logs = r.audit.map((a) => ({ ...a }));
  state.rows.org_members = [member("admin-1", "Admin"), member("d-1", "Drafter"), member("req-1", "Requester")];
}

describe("EDGE-19 — the restore's rows through the workflow route's file check (vetTicketAttachment)", () => {
  it("the restore wrote the line and the audit row this package reads (P16's record, unchanged)", async () => {
    const r = await restoreTwoCarriers();
    expect(restoredFromNumber({ ticketNumber: r.NEW, history: r.b2.history })).toBe(OLD);
    expect(restoredFromNumber({ ticketNumber: OLD, history: r.b1.history })).toBeNull();
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0].user_id).toBe("admin-1");
    expect((r.audit[0].details as { cleared: Array<Record<string, unknown>> }).cleared).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: B2, code: TICKET_RENUMBERED, renumbered: expect.objectContaining({ from: OLD, to: r.NEW }) })]));
  });

  it("done-when 1/2: the renumbered request's own listed Final is accepted in a submit; its listed Reference in a redline", async () => {
    const r = await restoreTwoCarriers();
    seed(r);
    state.user = { id: "d-1" };
    const final = (r.b2.attachments as TicketAttachment[])[0];
    const res = await workflow({ ticketId: B2, actionType: "submit_final", finalAttachment: final });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(auditReads()).toHaveLength(2); // the restore's audit row (unstamped here): the 'server' read, then the unstamped read
    expect(state.calls.filter((c) => c.table === "r2")).toHaveLength(0); // a listed file — no storage round-trip, as before

    seed(r, { b2: { status: "PENDING_REVIEW" } });
    state.calls = [];
    state.user = { id: "req-1" };
    const markup = (r.b2.attachments as TicketAttachment[])[1];
    const red = await workflow({ ticketId: B2, actionType: "request_revision", comment: "see markup", redlineAttachment: markup });
    expect(red.status, JSON.stringify(await red.clone().json())).toBe(200);
  });

  it("nothing else under the original folder: an UNLISTED key there is refused, as today", async () => {
    const r = await restoreTwoCarriers();
    seed(r);
    state.user = { id: "d-1" };
    state.objects[`${OLD_FOLDER}a.pdf`] = new Uint8Array([1]);
    const res = await workflow({ ticketId: B2, actionType: "submit_final", finalAttachment: { name: "a.pdf", url: `${OLD_FOLDER}a.pdf`, type: "Final" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not stored under this request/);
    expect(ticketWrites()).toHaveLength(0);
  });

  it("fail-safe: no audit row (a forged history line), an audit row a non-Admin wrote, or an Admin no longer active — refused as today; an unreadable audit trail is a 503", async () => {
    const r = await restoreTwoCarriers();
    const final = (r.b2.attachments as TicketAttachment[])[0];
    const attempt = async (setup: () => void) => {
      seed(r); setup(); state.calls = []; state.user = { id: "d-1" };
      return workflow({ ticketId: B2, actionType: "submit_final", finalAttachment: final });
    };
    for (const setup of [
      () => { state.rows.audit_logs = []; },
      () => { state.rows.audit_logs = r.audit.map((a) => ({ ...a, user_id: "d-1" })); },
      () => { state.rows.org_members = [member("admin-1", "Admin", ["Admin"], { status: "removed" }), member("d-1", "Drafter"), member("req-1", "Requester")]; },
    ]) {
      const res = await attempt(setup);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not stored under this request/);
      expect(ticketWrites()).toHaveLength(0);
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = await attempt(() => { state.errors["audit_logs.select"] = [{ message: "timeout" }]; });
    expect(down.status).toBe(503);
    expect(ticketWrites()).toHaveLength(0);
  });

  it("fix pass: where 20261201 stamps the restore's row actor_kind 'server', the files stay the request's after the restoring Admin leaves (workflow route and copy route)", async () => {
    const r = await restoreTwoCarriers();
    const final = (r.b2.attachments as TicketAttachment[])[0];
    const gone = () => {
      seed(r);
      state.rows.audit_logs = r.audit.map((a) => ({ ...a, actor_kind: "server" }));
      state.rows.org_members = [member("admin-1", "Admin", ["Admin"], { status: "removed" }), member("d-1", "Drafter"), member("req-1", "Requester")];
      state.calls = [];
    };
    gone();
    state.user = { id: "d-1" };
    const res = await workflow({ ticketId: B2, actionType: "submit_final", finalAttachment: final });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    gone();
    state.user = { id: "d-1", email: "d-1@x.io" };
    state.objects[final.url] = await pdfBytes();
    const c = await copy({ ticketId: B2, attachmentId: final.id, channel: "download", acknowledged: true, acceptUnstamped: true });
    expect(c.status, c.status === 200 ? "" : JSON.stringify(await c.clone().json())).toBe(200);
    // the same departed Admin with an UNSTAMPED row (written before 20261201): today's answer
    seed(r);
    state.rows.org_members = [member("admin-1", "Admin", ["Admin"], { status: "removed" }), member("d-1", "Drafter"), member("req-1", "Requester")];
    state.user = { id: "d-1" };
    const before = await workflow({ ticketId: B2, actionType: "submit_final", finalAttachment: final });
    expect(before.status).toBe(400);
  });

  it("done-when 3: the request KEEPING the old number cannot attach the renumbered request's listed file as its own; its own new upload is accepted as before", async () => {
    const r = await restoreTwoCarriers();
    seed(r, { b1: { status: "PENDING_IFC" } });
    state.user = { id: "d-1" };
    const theirs = (r.b2.attachments as TicketAttachment[])[0];
    state.objects[theirs.url] = new Uint8Array([1]);
    const stolen = await workflow({ ticketId: B1, actionType: "submit_final", finalAttachment: { name: theirs.name, url: theirs.url, type: "Final" } });
    expect(stolen.status).toBe(400);
    expect((await stolen.json()).error).toMatch(/belongs to another request/);
    expect(ticketWrites()).toHaveLength(0);
    expect(state.calls.filter((c) => c.table === "r2")).toHaveLength(0); // refused before storage is asked
    // REGRESSION — the holder's own fresh upload under its folder
    state.calls = [];
    const own = `${OLD_FOLDER}1727000000000_iso_IFC.pdf`;
    state.objects[own] = new Uint8Array([1, 2, 3]);
    const ok = await workflow({ ticketId: B1, actionType: "submit_final", finalAttachment: { name: "iso_IFC.pdf", url: own, type: "Final" } });
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
    expect(auditReads()).toHaveLength(0); // the holder carries no restore line: no audit read
  });

  it("REGRESSION — a request never renumbered gets today's answers: its own folder only, no AUDIT read; the trade-off pinned: one renumbered-sibling read per unlisted upload, which finds nothing and changes nothing", async () => {
    state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
    state.rows.tickets = [{ id: "t1", org_id: ORG, ticket_id: "REQ-1", title: "Pump iso", status: "PENDING_IFC", request_type: "ISO", unit: "U-100",
      requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
      attachments: [], comments: [], history: [{ action: "Created", user: "req-1@x.io", date: LM }], watchers: [], unread_by: [], revision_count: 0, last_modified: LM }];
    state.user = { id: "d-1" };
    for (const url of ["orgs/o1/tickets/REQ-2/x.pdf", `${OLD_FOLDER}x.pdf`, "orgs/o2/tickets/REQ-1/x.pdf", "orgs/o1/tickets/REQ-1/../REQ-2/x.pdf"]) {
      const res = await workflow({ ticketId: "t1", actionType: "submit_final", finalAttachment: { name: "x.pdf", url, type: "Final" } });
      expect(res.status, url).toBe(400);
      expect((await res.json()).error).toMatch(/not stored under this request/);
    }
    expect(auditReads()).toHaveLength(0);
    const key = "orgs/o1/tickets/REQ-1/1727000000000_iso_IFC.pdf";
    state.objects[key] = new Uint8Array([1, 2]);
    const ok = await workflow({ ticketId: "t1", actionType: "submit_final", finalAttachment: { name: "iso_IFC.pdf", url: key, type: "Final" } });
    expect(ok.status).toBe(200);
    expect(auditReads()).toHaveLength(0);
    const sibling = state.calls.findIndex((c) => c.table === "tickets" && c.method === "eq" && c.args[0] === "metadata->restore_renumbered->>from");
    expect(sibling).toBeGreaterThan(-1);
    expect(state.calls[sibling].args[1]).toBe("REQ-1");
  });

  it("REGRESSION (final fix pass, ruling 1) — a never-renumbered request's fresh upload with the sibling read FAILING (or truncated) is accepted exactly as on base: the storage HEAD runs, the same ticket write lands, and only the audit row adds renumberedSiblingUnchecked", async () => {
    const key = "orgs/o1/tickets/REQ-1/1727000000000_iso_IFC.pdf";
    const ticketRow = () => ({ id: "t1", org_id: ORG, ticket_id: "REQ-1", title: "Pump iso", status: "PENDING_IFC", request_type: "ISO", unit: "U-100",
      requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
      attachments: [], comments: [], history: [{ action: "Created", user: "req-1@x.io", date: LM }], watchers: [], unread_by: [], revision_count: 0, last_modified: LM });
    const run = async (setup: () => void) => {
      state.rows.org_members = [member("d-1", "Drafter"), member("req-1", "Requester")];
      state.rows.tickets = [ticketRow()];
      state.objects = { [key]: new Uint8Array([1, 2]) };
      state.calls = []; state.errors = {};
      setup();
      state.user = { id: "d-1" };
      const res = await workflow({ ticketId: "t1", actionType: "submit_final", finalAttachment: { name: "iso_IFC.pdf", url: key, type: "Final" } });
      const update = ticketWrites().find((c) => c.method === "update")?.args[0] as Record<string, unknown> | undefined;
      const audit = state.calls.find((c) => c.table === "audit_logs" && c.method === "insert" && String((c.args[0] as { action?: string }).action) === "TICKET_SUBMIT_FINAL")?.args[0] as { details: Record<string, unknown> } | undefined;
      return { status: res.status, update, audit, heads: state.calls.filter((c) => c.table === "r2").map((c) => c.args[0]) };
    };
    const strip = (u: Record<string, unknown> | undefined) => JSON.parse(JSON.stringify(u ?? {}, (k, v) => (["id", "uploadedAt", "date", "last_modified", "lastModified", "updated_at", "attempt"].includes(k) ? undefined : v)));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ok = await run(() => undefined);
    expect(ok.status).toBe(200);
    expect(ok.update).toBeDefined();
    expect(ok.audit).toBeDefined();
    expect(ok.heads).toContain(key);
    expect(ok.audit?.details.renumberedSiblingUnchecked).toBeUndefined();
    // the sibling read fails: the route's own ticket read passes, the sibling read errors
    const down = await run(() => { state.errors["tickets.select"] = [null, { message: "timeout" }]; });
    expect(down.status).toBe(200);
    expect(down.heads).toEqual(ok.heads); // the storage HEAD ran, as on base
    expect(down.heads).toContain(key);
    expect(strip(down.update)).toEqual(strip(ok.update)); // the same write
    expect(down.update?.status).toBe(ok.update?.status);
    expect(down.audit?.details.renumberedSiblingUnchecked).toBe(true);
    const { renumberedSiblingUnchecked: _flag, ...rest } = down.audit!.details;
    void _flag;
    expect(strip(rest)).toEqual(strip(ok.audit!.details));
    expect(auditReads()).toHaveLength(0);
    // more renumbered requests name the number than are read (truncated, none listing the key): the same
    const many = await run(() => {
      state.rows.tickets.push(...Array.from({ length: 51 }, (_, i) => ({ id: `r-${i}`, org_id: ORG, ticket_id: `N-${i}`, metadata: { restore_renumbered: { from: "REQ-1" } }, attachments: [] })));
    });
    expect(many.status).toBe(200);
    expect(many.heads).toEqual(ok.heads);
    expect(many.audit?.details.renumberedSiblingUnchecked).toBe(true);
    // a file that is NOT in storage is still refused 400 by the HEAD, as on base
    const gone = await run(() => { state.errors["tickets.select"] = [null, { message: "timeout" }]; state.objects = {}; });
    expect(gone.status).toBe(400);
    expect(gone.update).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("the holder-side refusal stands only when the sibling read SUCCEEDS and finds a renumbered request listing the key", async () => {
    const r = await restoreTwoCarriers();
    seed(r, { b1: { status: "PENDING_IFC" } });
    state.user = { id: "d-1" };
    const theirs = (r.b2.attachments as TicketAttachment[])[0];
    state.objects[theirs.url] = new Uint8Array([1]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // the read fails: today's answer (base admitted the key under the holder's own folder) — never wider than base
    state.errors["tickets.select"] = [null, { message: "timeout" }];
    const unchecked = await workflow({ ticketId: B1, actionType: "submit_final", finalAttachment: { name: theirs.name, url: theirs.url, type: "Final" } });
    expect(unchecked.status, JSON.stringify(await unchecked.clone().json())).toBe(200);
    const audit = state.calls.find((c) => c.table === "audit_logs" && c.method === "insert" && String((c.args[0] as { action?: string }).action) === "TICKET_SUBMIT_FINAL")?.args[0] as { details: Record<string, unknown> };
    expect(audit.details.renumberedSiblingUnchecked).toBe(true);
  });
});

describe("EDGE-19 — the restore's rows through the server copy route (POST /api/tickets/copy)", () => {
  it("done-when 1/2: the renumbered request's listed Final is issued and recorded by the server (stamped), the original number confirmed by the audit row", async () => {
    const r = await restoreTwoCarriers();
    seed(r);
    state.user = { id: "d-1", email: "d-1@x.io" };
    const final = (r.b2.attachments as TicketAttachment[])[0];
    state.objects[final.url] = await pdfBytes();
    const res = await copy({ ticketId: B2, attachmentId: final.id, channel: "download", acknowledged: true, acceptUnstamped: true });
    expect(res.status, res.status === 200 ? "" : JSON.stringify(await res.clone().json())).toBe(200);
    expect(res.headers.get("x-ticket-copy-stamped")).toBe("1");
    expect(auditReads()).toHaveLength(2); // the 'server' read, then the unstamped read (the in-memory restore's row carries no stamp)
  });

  it("fail-safe: without the restore's audit row the answer is today's (409 'not stored under this request' — the page then takes the browser path); an unreadable trail is a 503 (transient)", async () => {
    const r = await restoreTwoCarriers();
    const final = (r.b2.attachments as TicketAttachment[])[0];
    seed(r);
    state.rows.audit_logs = [];
    state.user = { id: "d-1", email: "d-1@x.io" };
    state.objects[final.url] = await pdfBytes();
    const res = await copy({ ticketId: B2, attachmentId: final.id, channel: "download", acknowledged: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not stored under this request/);
    seed(r);
    state.errors["audit_logs.select"] = [{ message: "timeout" }];
    expect((await copy({ ticketId: B2, attachmentId: final.id, channel: "download", acknowledged: true })).status).toBe(503);
  });

  it("REGRESSION — the request keeping the old number takes a copy of its own file as before, with no audit read", async () => {
    const r = await restoreTwoCarriers();
    seed(r);
    state.user = { id: "d-1", email: "d-1@x.io" };
    const own = (r.b1.attachments as TicketAttachment[])[0];
    state.objects[own.url] = await pdfBytes();
    const res = await copy({ ticketId: B1, attachmentId: own.id, channel: "download", acknowledged: true, acceptUnstamped: true });
    expect(res.status).toBe(200);
    expect(auditReads()).toHaveLength(0);
  });
});

describe("EDGE-19 — every per-number request-prefix caller goes through the shared helper; the shed and the copy recall test no number folder", () => {
  it("no caller spells its own orgs/<org>/tickets/<number>/ prefix any more", () => {
    for (const f of ["lib/ticketCopyRequest.ts", "app/api/tickets/copy/route.ts", "app/api/tickets/workflow-action/route.ts"]) {
      const s = src(f).replace(/\/\/[^\n]*/g, "");
      expect(s, f).toContain("ticketFolder(");
      expect(s, f).not.toMatch(/`orgs\/\$\{[^}]+\}\/tickets\/\$\{/);
    }
    // the shed admits every key under orgs/<org>/tickets/ (no number), the copy recall has no prefix test
    expect(src("lib/ticketShed.ts")).toContain("key.startsWith(`orgs/${orgId}/tickets/`)");
    expect(src("lib/staleCopies.ts")).not.toMatch(/tickets\/\$\{/);
  });
  it("storage objects are never moved or copied by this package (no storage write in the helper)", () => {
    const s = src("lib/ticketFilePrefix.ts");
    expect(s).not.toMatch(/CopyObject|PutObject|DeleteObject|\.upload\(|\.move\(|\.copy\(/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE-15 — holdersFor on a routed review
// ═════════════════════════════════════════════════════════════════════════════
const slot = (over: Partial<TicketReviewSlot>): TicketReviewSlot => ({
  id: "s", kind: "qa", label: "QA", mode: "blocking", primaries: [], alternates: [], overriders: [], independentOf: [],
  timeoutDays: null, fallback: false, status: "open", ...over,
});
const roster = (slots: TicketReviewSlot[], over: Partial<TicketReviewRoster> = {}): TicketReviewRoster => ({
  v: 1, id: "r1", openedAt: "2026-10-20T00:00:00.000Z", openedBy: "d-1", level: "library", cycle: "1A", contentHash: "h", files: [], slots, ...over,
});
const base = {
  id: "t1", orgId: ORG, ticketId: "REQ-1", title: "Pump iso", requestType: "ISO", priority: "Normal",
  requesterId: "req-1", requesterName: "Rita Requester", requesterEmail: "rita@x.io",
  assignedDrafterId: "d-1", assignedDrafterName: "Dan Drafter", assignedEngineerId: "e-1", assignedEngineerName: "Erin Engineer",
  attachments: [], comments: [], history: [],
} as unknown as Ticket;
const STATUSES: TicketStatus[] = ["PENDING_ASSIGNMENT", "PENDING_ENG_TEAM", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT", "CLOSED", "CANCELED"];

describe("ROUTE-15 — a routed review waits on its open blocking slots' occupants", () => {
  const routed = roster([
    slot({ id: "s-eng", kind: "engineering", label: "Engineering", primaries: ["e-1", "e-2"], engineering: true }),
    slot({ id: "s-qa", kind: "qa", label: "QA", primaries: ["q-1"] }),
    slot({ id: "s-dc", kind: "doc_control", label: "Document control", mode: "notify_only", primaries: ["dc-1"] }),
    slot({ id: "s-ops", kind: "ops", label: "Operations", primaries: ["o-1"], status: "satisfied", satisfiedBy: "o-1" }),
  ]);
  const names = new Map([["e-1", "Erin Engineer"], ["e-2", "Eli Eng"], ["q-1", "Quinn QA"], ["dc-1", "Dee Control"], ["o-1", "Ola Ops"]]);
  const t = { ...base, status: "PENDING_REVIEW", metadata: { review_roster: routed } } as Ticket;

  it("names every primary of the open blocking slots (kind co_reviewers, part = the open slot labels) — never the requester, never a notify-only or satisfied slot", () => {
    const h = holdersFor(t, { memberNames: names });
    expect(h).toEqual([
      { kind: "co_reviewers", uid: "e-1", name: "Erin Engineer", part: "Engineering, QA" },
      { kind: "co_reviewers", uid: "e-2", name: "Eli Eng", part: "Engineering, QA" },
      { kind: "co_reviewers", uid: "q-1", name: "Quinn QA", part: "Engineering, QA" },
    ]);
    expect(h.some((x) => x.uid === "req-1" || x.uid === "dc-1" || x.uid === "o-1")).toBe(false);
    expect(rosterHolderUids(t)).toEqual(["e-1", "e-2", "q-1"]);
  });

  it("the requester is named only when they occupy an open slot; a person in two open slots is named once", () => {
    const r2 = roster([slot({ id: "a", label: "Requester review", kind: "requester", primaries: ["req-1", "q-1"] }), slot({ id: "b", label: "QA", primaries: ["q-1"] })]);
    const h = holdersFor({ ...base, status: "PENDING_REVIEW", metadata: { review_roster: r2 } } as Ticket, { memberNames: new Map([["req-1", "Rita Requester"], ["q-1", "Quinn QA"]]) });
    expect(h.map((x) => x.uid)).toEqual(["req-1", "q-1"]);
    expect(h.every((x) => x.kind === "co_reviewers" && x.part === "Requester review, QA")).toBe(true);
  });

  it("names not yet read: each slot is described ('a reviewer for QA' — no label takes a wrong article), never the requester; a slot with nobody rostered says so", () => {
    expect(holdersFor(t).map((x) => [x.uid, x.name])).toEqual([[null, "a reviewer for Engineering"], [null, "a reviewer for QA"]]);
    expect(holdersFor(t, { memberNames: new Map([["e-1", "Erin Engineer"]]) }).map((x) => x.name)).toEqual(["Erin Engineer", "a reviewer for Engineering", "a reviewer for QA"]);
    expect(holdersFor(t).map((x) => x.name).join(" ")).not.toMatch(/\ba [AEIOU]/);
    const empty = roster([slot({ label: "QA", primaries: [] })]);
    expect(holdersFor({ ...base, status: "PENDING_REVIEW", metadata: { review_roster: empty } } as Ticket)).toEqual([{ kind: "co_reviewers", uid: null, name: "the reviewers for QA", part: "QA" }]);
  });

  it("the waiting line and the no-actions explanation name the slots' occupants (the drafter reads them, not the requester)", () => {
    const h = holdersFor(t, { memberNames: names });
    const why = explainNoActions(t, { uid: "d-1", roles: ["Drafter"], holders: h });
    expect(why.kind).toBe("not_your_turn");
    expect(why.text).toBe("You are the drafter — this step is not yours (waiting on Erin Engineer, Eli Eng or Quinn QA: needs review).");
    expect(why.text).not.toMatch(/Rita|requester's/);
    // the page's line: "Waiting on <names> (<part>)"
    expect(`Waiting on ${h.map((x) => x.name).join(", ")} (${h[0].part})`).toBe("Waiting on Erin Engineer, Eli Eng, Quinn QA (Engineering, QA)");
  });

  it("a roster that is closed, of another version, with no open blocking slot, or on a ticket not in review answers as before", () => {
    const unconfigured = holdersFor({ ...base, status: "PENDING_REVIEW" } as Ticket);
    for (const r of [roster(routed.slots, { closedAt: "2026-10-21T00:00:00.000Z" }), { ...routed, v: 2 }, roster([slot({ status: "satisfied" }), slot({ mode: "notify_only" })])]) {
      expect(holdersFor({ ...base, status: "PENDING_REVIEW", metadata: { review_roster: r } } as Ticket, { memberNames: names })).toEqual(unconfigured);
    }
  });
});

describe("ROUTE-15 (final fix pass, ruling 4) — the holders are who may sign now: slotSignPlan's drafter / requester legs drop an occupant, a slot's alternates join once their window opens", () => {
  const OPENED = "2026-10-20T00:00:00.000Z";
  const at = (days: number) => Date.parse(OPENED) + days * 86_400_000;
  const names = new Map([["d-1", "Dan Drafter"], ["req-1", "Rita Requester"], ["q-1", "Quinn QA"], ["alt-1", "Alex Alt"], ["e-1", "Erin Engineer"]]);
  const ticketWith = (slots: TicketReviewSlot[]) => ({ ...base, status: "PENDING_REVIEW", metadata: { review_roster: roster(slots, { openedAt: OPENED }) } } as Ticket);

  it("the drafter / requester occupying a slot independent of them is not waited on there once separation of duties binds (3+ members) — the same rule slotSignPlan blocks them on", () => {
    const slots = [
      slot({ id: "a", kind: "qa", label: "QA", primaries: ["d-1", "q-1"], independentOf: ["drafter"] }),
      slot({ id: "b", kind: "requester", label: "Requester review", primaries: ["req-1", "e-1"], independentOf: ["requester"] }),
    ];
    const t = ticketWith(slots);
    const h = holdersFor(t, { memberNames: names, activeMemberCount: 3, now: at(0) });
    expect(h.map((x) => x.uid)).toEqual(["q-1", "e-1"]);
    expect(rosterHolderUids(t, { activeMemberCount: 3, now: at(0) })).toEqual(["e-1", "q-1"]);
    // the same rule: exactly the occupants slotSignPlan blocks on those legs are dropped
    const r = currentRoster(t)!;
    for (const uid of ["d-1", "req-1"]) {
      const plan = slotSignPlan(r, t, uid, true, at(0));
      expect(plan.blocked.map((b) => b.reason).join(" "), uid).toMatch(/must be independent of the (drafter|requester)/);
      expect(h.some((x) => x.uid === uid)).toBe(false);
    }
    for (const uid of ["q-1", "e-1"]) expect(slotSignPlan(r, t, uid, true, at(0)).fillable.length, uid).toBeGreaterThan(0);
    // below the threshold (or the count unknown) the engine applies no leg — every occupant is waited on, as before
    for (const ctx of [{}, { activeMemberCount: 2 }]) {
      expect(holdersFor(t, { memberNames: names, now: at(0), ...ctx }).map((x) => x.uid)).toEqual(["d-1", "q-1", "req-1", "e-1"]);
    }
    // a slot whose only occupant is blocked is described, never names the blocked party
    const lone = ticketWith([slot({ id: "a", kind: "qa", label: "QA", primaries: ["d-1"], independentOf: ["drafter"] })]);
    expect(holdersFor(lone, { memberNames: names, activeMemberCount: 5, now: at(0) })).toEqual([{ kind: "co_reviewers", uid: null, name: "the reviewers for QA", part: "QA" }]);
    // a cross-slot leg (independent of another slot) is not a party leg: unchanged
    const cross = ticketWith([slot({ id: "a", kind: "qa", label: "QA", primaries: ["q-1"], independentOf: ["engineering"] })]);
    expect(holdersFor(cross, { memberNames: names, activeMemberCount: 5, now: at(0) }).map((x) => x.uid)).toEqual(["q-1"]);
  });

  it("a slot's alternates are waited on once slotAlternatesActive holds (its timeoutDays elapsed), never before; an alternate the drafter leg blocks is dropped too", () => {
    const slots = [slot({ id: "a", kind: "qa", label: "QA", primaries: ["q-1"], alternates: ["alt-1", "d-1"], timeoutDays: 2, independentOf: ["drafter"] })];
    const t = ticketWith(slots);
    expect(holdersFor(t, { memberNames: names, activeMemberCount: 3, now: at(1) }).map((x) => x.uid)).toEqual(["q-1"]);
    expect(holdersFor(t, { memberNames: names, activeMemberCount: 3, now: at(2) }).map((x) => x.uid)).toEqual(["q-1", "alt-1"]);
    expect(rosterHolderUids(t, { activeMemberCount: 3, now: at(2) })).toEqual(["alt-1", "q-1"]);
    expect(holdersFor(t, { memberNames: names, now: at(2) }).map((x) => x.uid)).toEqual(["q-1", "alt-1", "d-1"]);
    // the engine agrees: the alternate signs via "alternate" at the same moment, not before
    const r = currentRoster(t)!;
    expect(slotSignPlan(r, t, "alt-1", true, at(1)).fillable).toHaveLength(0);
    expect(slotSignPlan(r, t, "alt-1", true, at(2)).fillable.map((f) => f.via)).toEqual(["alternate"]);
    // no timeout configured: alternates never join
    const never = ticketWith([slot({ id: "a", kind: "qa", label: "QA", primaries: ["q-1"], alternates: ["alt-1"], timeoutDays: null })]);
    expect(holdersFor(never, { memberNames: names, now: at(400) }).map((x) => x.uid)).toEqual(["q-1"]);
    // an alternate not yet named is described by the slot
    expect(holdersFor(t, { memberNames: new Map([["q-1", "Quinn QA"]]), activeMemberCount: 3, now: at(3) }).map((x) => x.name)).toEqual(["Quinn QA", "a reviewer for QA"]);
  });

  it("shared, not forked: slotSignPlan and the waiting-on line call the one leg rule (lib/workflow.ts slotPartyLegReason)", () => {
    const wf = src("lib/workflow.ts");
    const att = src("lib/ticketAttention.ts");
    expect(wf).toContain("reason = slotPartyLegReason(slot, k, ticket, uid);");
    expect(att).toContain("slotPartyLegReason(slot, k, parties, uid)");
    expect(att).toContain("slotAlternatesActive(roster, slot, now)");
    expect(att).not.toMatch(/must be independent of the/);
  });
});

describe("ROUTE-15 — REGRESSION: an unconfigured ticket's holders, labels and counts are unchanged in every status", () => {
  // Pinned expectations — what holdersFor answered before DF-P17 for this ticket.
  const expected: Record<string, unknown> = {
    PENDING_ASSIGNMENT: [{ kind: "queue", uid: null, name: "the assignment queue", part: "assigns a drafter" }],
    PENDING_ENG_TEAM: [{ kind: "engineer", uid: "e-1", name: "Erin Engineer", part: "the reviewing engineer" }],
    DRAFTING: [{ kind: "drafter", uid: "d-1", name: "Dan Drafter", part: "the drafter" }],
    REVISION_REQ: [{ kind: "drafter", uid: "d-1", name: "Dan Drafter", part: "the drafter" }],
    PENDING_REVIEW: [{ kind: "requester", uid: "req-1", name: "Rita Requester", part: "the requester" }],
    PENDING_FINAL_APPROVAL: [{ kind: "engineer", uid: "e-1", name: "Erin Engineer", part: "the reviewing engineer" }],
    PENDING_IFC: [{ kind: "drafter", uid: "d-1", name: "Dan Drafter", part: "the drafter" }],
    FINAL_DRAFT: [{ kind: "requester", uid: "req-1", name: "Rita Requester", part: "the requester" }],
    CLOSED: [],
    CANCELED: [],
  };
  it("for every status: no metadata, metadata without a roster, and a roster on a status other than review all give today's answer", () => {
    const routed = roster([slot({ primaries: ["q-1"] })]);
    for (const status of STATUSES) {
      const plain = holdersFor({ ...base, status } as Ticket);
      expect(plain, status).toEqual(expected[status]);
      expect(holdersFor({ ...base, status, metadata: {} } as Ticket), status).toEqual(plain);
      expect(holdersFor({ ...base, status, metadata: { other: 1 } } as Ticket, { memberNames: new Map([["q-1", "Q"]]) }), status).toEqual(plain);
      if (status !== "PENDING_REVIEW") {
        expect(holdersFor({ ...base, status, metadata: { review_roster: routed } } as Ticket, { memberNames: new Map([["q-1", "Q"]]) }), status).toEqual(plain);
      }
      expect(rosterHolderUids({ ...base, status } as Ticket)).toEqual([]);
    }
  });
  it("the departed / absent requester pools and the named queue are unchanged", () => {
    expect(holdersFor({ ...base, status: "PENDING_REVIEW" } as Ticket, { requesterRoles: [] })[0]).toMatchObject({ kind: "co_reviewers", uid: null });
    expect(holdersFor({ ...base, status: "PENDING_REVIEW", requesterId: null } as unknown as Ticket)[0]).toMatchObject({ kind: "co_reviewers", part: expect.stringMatching(/no requester/) });
    expect(holdersFor({ ...base, status: "PENDING_ASSIGNMENT" } as Ticket, { queueNames: ["Sue", "Sam"] }).map((x) => x.name)).toEqual(["Sue", "Sam"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The request page: the waiting-on read only (and the copy viewer's history);
// DF-P6's hunks intact.
// ═════════════════════════════════════════════════════════════════════════════
describe("the request page changes only the waiting-on read; DF-P6's hunks stay intact", () => {
  const page = src("app/(protected)/requests/[id]/page.tsx");
  it("the waiting-on read hands holdersFor the roster occupants' names, read through RLS like the roster panel", () => {
    expect(page).toContain("const holders = holdersFor(ticket, { queueNames, requesterRoles, memberNames: rosterNames, activeMemberCount });");
    expect(page).toContain("const rosterUidsKey = ticket ? rosterHolderUids(ticket, { activeMemberCount }).join(',') : '';");
    expect(page).toContain("supabase.from('org_members').select('uid, display_name, email').eq('org_id', ticketOrgId).in('uid', uids)");
    expect(page).toContain("copyContext={ticket ? { orgId: ticket.orgId, ticketNumber: ticket.ticketId, requesterId: ticket.requesterId, attachments: ticket.attachments, history: ticket.history } : null}");
  });
  it("DF-P6: the DeclarationCard mount, the reviewModelFieldsFromRow spread, the engineerPickAvailable effect, the override display and declarationCheck are in place", () => {
    expect(page).toMatch(/<DeclarationCard\b/);
    expect(page).toContain("reviewModelFieldsFromRow(");
    expect(page).toContain("...(engineerPickAvailable === undefined ? {} : { engineerPickAvailable }), // DF-P6 fix pass (issues 1 and 2)");
    expect(page).toContain("const engineeringOverride = engineeringOverrideOf(ticket);");
    expect(page).toContain("const engineeringNotRequired = engineeringOverride ? null : engineeringSignOffNotRequiredOf(ticket);");
    expect(page).toContain("ticketAsDeclarationChecked(ticket, declarationCheck)");
    expect(page).toMatch(/const \[declarationCheck, setDeclarationCheck\]/);
  });
});
