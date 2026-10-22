// drafting-flow Round G, DF-P23 TRANSITION RECORD AND RECONCILE — the
// workflow route's follow-ups, on the route itself (the DF-P20 sweep's
// harness: vi.hoisted state + a Proxy chain for supabaseAdmin):
//
//   * EVID-1 done-when 3 (DEC-90 ruling (2) for DF-P23): every history line a
//     transition appends carries the actor's uid — the session's, never a
//     body field — beside the email; a legacy entry is left as it was.
//   * the DF-P20 follow-up (d): a comment that is not text is a 400 with
//     nothing read or written (it was a 500 TypeError); absent / null / text
//     comments behave exactly as before.
//   * the DF-P20 follow-up (b): the roster ledger not written is its own
//     response flag, `rosterLedgerNotWritten` (the panel reads it, so a hold
//     or library warning in `warning` can no longer displace it).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROSTER_LEDGER_NOT_WRITTEN } from "@/lib/routingControl";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { TicketAttachment, TicketReviewRoster, TicketStatus } from "@/types/schema";

const LM = "2026-10-21T00:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const SIG = "5a000000-0000-4000-8000-000000000001";
const BYTES = "%PDF-1.7 the draft";

// ── the route harness (vi.hoisted state + a Proxy chain for supabaseAdmin) ──
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
  r2: [] as Array<{ kind: string; key: string }>,
  r2Fail: false,
  r2Hang: false,
  after: [] as Array<() => unknown>,
  // A/B: true runs the route as it was before DF-P20 (the two DF-P20 calls answer "nothing to record").
  noP20: false,
}));
function chain(table: string) {
  const filters: Array<[string, unknown, "eq" | "is" | "in"]> = [];
  let head = false;
  const rows = () => (state.rows[table] ?? [])
    .filter((r) => filters.every(([k, v, how]) => (how === "is" ? (r[k] ?? null) === v : how === "in" ? (v as unknown[]).includes(r[k]) : r[k] === v)))
    .map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        // postgrest-js on a HEAD request: PostgREST's 404 for a missing table
        // has no body, and processResponse maps a body-less 404 to status 204
        // with error = null — a HEAD can never see PGRST205 / 42P01.
        if (head && state.errors[table] && /PGRST205|42P01/.test(state.errors[table].code ?? "")) return resolve({ data: null, error: null, count: null, status: 204 });
        if (state.errors[table]) return resolve({ data: null, error: state.errors[table] });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        // the ledger's slot rows land, so a later sign-off's update finds them
        if (prop === "insert" && table === "ticket_review_slots" && !state.errors[table]) {
          state.rows[table] = [...(state.rows[table] ?? []), ...(Array.isArray(args[0]) ? args[0] : [args[0]]) as Array<Record<string, unknown>>];
        }
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push([String(args[0]), args[1], "eq"]);
        if (prop === "is") filters.push([String(args[0]), args[1], "is"]);
        if (prop === "in") filters.push([String(args[0]), args[1], "in"]);
        if (prop === "maybeSingle" || prop === "single") {
          if (state.errors[table]) return Promise.resolve({ data: null, error: state.errors[table] });
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
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
    rpc: vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) }, __registerScopedServerClient: () => {} }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn((fn: () => unknown) => { state.after.push(fn); }) }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "b",
  r2: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
      const kind = cmd.constructor.name;
      state.r2.push({ kind, key: cmd.input.Key });
      if (kind === "GetObjectCommand") {
        if (state.r2Hang) return new Promise(() => {});
        if (state.r2Fail) throw new Error("timeout");
        return { ContentLength: BYTES.length, Body: (async function* () { yield new TextEncoder().encode(BYTES); })() };
      }
      return { ContentLength: 4096, ETag: '"e"' };
    }),
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/assuranceExamination", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/assuranceExamination")>();
  return {
    ...real,
    examinationForAct: (...a: Parameters<typeof real.examinationForAct>) => (state.noP20 ? { ok: true as const, value: null } : real.examinationForAct(...a)),
    examinationAuditFields: (e: Parameters<typeof real.examinationAuditFields>[0]) => (state.noP20 ? {} : real.examinationAuditFields(e)),
  };
});
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "staged" } as TicketAttachment;
const DRAFT2 = { id: "a-e", name: "iso_1A_sh2.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A_sh2.pdf", type: "Draft", status: "staged" } as TicketAttachment;
// The configured rosters at the deploy: the DF-P5 table plus blocking checks
// filled by a person, a role and ticket.direct_approve, and a notice — none
// opted in (no records_examination).
const NO_OPT_IN = { slots: [
  { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
  { kind: "check", label: "Engineering check", mode: "blocking", fill: { capability: "ticket.final_approve" }, independent_of: ["drafter"] },
  { kind: "assure", label: "Inspection check", mode: "blocking", fill: { users: ["q-1"] }, independent_of: ["drafter"] },
  { kind: "lead", label: "Lead check", mode: "blocking", fill: { roles: ["Viewer"] } },
  { kind: "direct", label: "Direct approval", mode: "blocking", fill: { capability: "ticket.direct_approve" } },
  { kind: "watch", label: "Inspection notice", mode: "notify_only", fill: { users: ["q-2"] } },
] };
const MEMBERS = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("e-2", "Engineer-3"), member("a-1", "Admin"), member("q-1", "Viewer"), member("q-2", "Viewer")];

const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [DRAFT, DRAFT2], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 0,
  last_modified: LM, library_id: LIB, metadata: {}, ...over,
});
const seed = () => {
  state.rows.org_members = MEMBERS.map((m) => ({ ...m }));
  state.rows.libraries = [{ id: LIB, org_id: "o1", name: "P&IDs", routing_control: NO_OPT_IN }];
  state.rows.ticket_review_slots = [];
};
const reset = () => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.r2 = []; state.r2Fail = false; state.r2Hang = false; state.after = [];
};

/** The roster a submission opens from the no-opt-in table (the route's own). */
async function openRoster(): Promise<TicketReviewRoster> {
  reset();
  seed();
  state.user = { id: "d-1" };
  state.rows.tickets = [ticketRow()];
  const res = await post({ ticketId: "t1", actionType: "submit_draft" });
  expect(res.status).toBe(200);
  const upd = state.calls.find((c) => c.table === "tickets" && c.method === "update")!.args[0] as { metadata: { review_roster: TicketReviewRoster } };
  return upd.metadata.review_roster;
}

const rowFor = (status: TicketStatus, roster: TicketReviewRoster) => ticketRow({
  status, deliverable_rev: "1A", draft_iteration: 1, assigned_engineer_id: status === "PENDING_FINAL_APPROVAL" ? "e-1" : null,
  attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }, { ...DRAFT2, status: "submitted", rev: "1A" }],
  metadata: { review_roster: roster },
});




beforeEach(() => { reset(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-22T08:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); state.noP20 = false; });

const ticketUpdate = () => state.calls.find((c) => c.table === "tickets" && c.method === "update")?.args[0] as Record<string, unknown> | undefined;
const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert");

describe("EVID-1 done-when 3 — the actor's uid on the history line, from the session", () => {
  it("a transition's history line names the caller's uid (actorId) beside the email; a forged body uid is ignored; earlier entries are untouched", async () => {
    seed();
    state.user = { id: "d-1" };
    const legacy = { action: "Created", user: "req-1@x.io", role: "Requester", date: "2026-10-01T00:00:00.000Z" };
    state.rows.tickets = [ticketRow({ history: [legacy] })];
    const res = await post({ ticketId: "t1", actionType: "save_progress", comment: "progress", actorId: "forged", actor: { uid: "forged" }, uid: "forged" });
    expect(res.status).toBe(200);
    const hist = ticketUpdate()!.history as Array<Record<string, unknown>>;
    expect(hist[0]).toEqual(legacy);
    expect(hist[hist.length - 1]).toMatchObject({ user: "d-1@x.io", actorId: "d-1" });
    expect(JSON.stringify(hist)).not.toContain("forged");
  });
  it("the submission's roster line and the triage lines carry it too (computeTransition's every appended entry)", async () => {
    const roster = await openRoster();
    expect(roster.slots.length).toBeGreaterThan(0);
    const hist = ticketUpdate()!.history as Array<Record<string, unknown>>;
    expect(hist.length).toBeGreaterThanOrEqual(2);
    for (const h of hist) expect(h.actorId, String(h.action)).toBe("d-1");
  });
  it("the close's 'not in the register' line is written with the caller's uid (source pin on the four close-note lines)", () => {
    const route = readFileSync(join(process.cwd(), "app/api/tickets/workflow-action/route.ts"), "utf8");
    expect(route.match(/\{ action: "Closed — deliverable not in the register", user: callerEmail, role: callerRole, date: new Date\(\)\.toISOString\(\), details: handbackNote, actorId: caller\.id \}/g)).toHaveLength(4);
  });
});

describe("the DF-P20 follow-up (d) — a comment that is not text", () => {
  for (const bad of [123, { text: "x" }, ["x"], true]) {
    it(`comment ${JSON.stringify(bad)} → 400, nothing read or written (it was a 500)`, async () => {
      seed();
      state.user = { id: "d-1" };
      state.rows.tickets = [ticketRow()];
      const res = await post({ ticketId: "t1", actionType: "save_progress", comment: bad });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "comment must be text" });
      expect(state.calls).toEqual([]);
    });
  }
  it("REGRESSION: an absent, a null and a text comment behave as before (200, the save lands)", async () => {
    for (const comment of [undefined, null, "a note"]) {
      reset();
      seed();
      state.user = { id: "d-1" };
      state.rows.tickets = [ticketRow()];
      const res = await post({ ticketId: "t1", actionType: "save_progress", ...(comment === undefined ? {} : { comment }) });
      expect(res.status, String(comment)).toBe(200);
      expect(ticketUpdate(), String(comment)).toBeDefined();
    }
  });
});

describe("the DF-P20 follow-up (b) — the ledger not written is its own flag", () => {
  it("a landed sign-off whose ledger write fails answers rosterLedgerNotWritten: true (and the warning as before); a written ledger answers no flag", async () => {
    const roster = await openRoster();
    const slot = roster.slots.find((s) => s.mode === "blocking" && s.primaries.includes("q-1"))!;
    expect(slot).toBeDefined();
    const sign = async (fail: boolean) => {
      reset();
      seed();
      state.rows.ticket_review_slots = roster.slots.map((x) => ({ id: `slot-${x.kind}`, roster_id: roster.id, slot_kind: x.kind }));
      state.rows.tickets = [rowFor("PENDING_REVIEW", roster)];
      state.rows.e_signatures = [{ id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: "q-1", content_hash: roster.contentHash, intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z" }];
      if (fail) state.errors.ticket_review_slot_events = { code: "08006", message: "connection lost" };
      state.user = { id: "q-1" };
      const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const failed = await sign(true);
    expect(failed.status).toBe(200);
    expect(failed.json.rosterLedgerNotWritten).toBe(true);
    expect(failed.json.warning).toBe(ROSTER_LEDGER_NOT_WRITTEN);
    const written = await sign(false);
    expect(written.status).toBe(200);
    expect("rosterLedgerNotWritten" in written.json).toBe(false);
    expect(audits().length).toBeGreaterThan(0);
  });
  it("the roster panel reads the flag (source pin), keeping the text for a route from before it", () => {
    const panel = readFileSync(join(process.cwd(), "components/requests/TicketRosterPanel.tsx"), "utf8");
    expect(panel).toContain("if ((out.rosterLedgerNotWritten === true || out.warning === ROSTER_LEDGER_NOT_WRITTEN) && assuranceSignKinds) {");
  });
});
