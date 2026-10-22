// drafting-flow Round G, DF-P26 ISSUING-PATH STOPS — GAP-116 (DEC-90 ruling
// (2) for DF-P26): a notify-only hold that stops the REQUEST, driven through
// the workflow route itself.
//   * REGRESSION FIRST (A/B): every action the state machine offers across
//     every status x every member of the harness, plus sign_slot /
//     request_revision, on requests where no such record could exist (no
//     roster, a roster with no opted-in notify-only slot, no source
//     document) — byte-identical with the route's one issueHoldStopGate call
//     removed (arm B answers "none"): responses, every database call, every
//     after-response task; no document_holds read by the gate.
//   * On a request where a record COULD exist but none stops it (no hold, a
//     hold by someone not of the slot, a released hold), every outcome —
//     status, answer and every write — is identical; the gate adds only its
//     read.
//   * An open hold placed by the slot's people with this request's record:
//     a completing sign-off (its dry run too) is refused 409
//     request_on_hold with the plain sentence, nothing written (a real
//     sign-off's signature named as not applied); a sign-off that would not
//     complete the review is not; an earlier round's hold is judged against
//     that round's ledger rows (unreadable → 503); an unreadable hold read →
//     503; before 20261267 (no column) → it proceeds.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { Role, Ticket, TicketAttachment, TicketReviewRoster, TicketStatus } from "@/types/schema";

const LM = "2026-10-21T00:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const DOC = "d0c00000-0000-4000-8000-000000000001";
const SIG = "5a000000-0000-4000-8000-000000000001";
const OLD_ROSTER = "0d000000-0000-4000-8000-000000000001";
const BYTES = "%PDF-1.7 the draft";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
  after: [] as Array<() => unknown>,
  noP26: false,
  noNote: false,
  hangNote: false,
}));
const pathGet = (r: Record<string, unknown>, key: string): unknown => {
  if (!key.includes("->")) return r[key];
  const parts = key.split(/->>?/);
  let v: unknown = r[parts[0]];
  for (const p of parts.slice(1)) v = v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined;
  return v;
};
function chain(table: string) {
  const filters: Array<[string, unknown, "eq" | "is" | "in"]> = [];
  let head = false;
  const rows = () => (state.rows[table] ?? [])
    .filter((r) => filters.every(([k, v, how]) => (how === "is" ? (pathGet(r, k) ?? null) === v : how === "in" ? (v as unknown[]).includes(pathGet(r, k)) : pathGet(r, k) === v)))
    .map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (head && state.errors[table] && /PGRST205|42P01/.test(state.errors[table].code ?? "")) return resolve({ data: null, error: null, count: null, status: 204 });
        if (state.errors[table]) return resolve({ data: null, error: state.errors[table] });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "insert" && (table === "ticket_review_slots" || table === "ticket_review_slot_events") && !state.errors[table]) {
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
      if (cmd.constructor.name === "GetObjectCommand") return { ContentLength: BYTES.length, Body: (async function* () { yield new TextEncoder().encode(BYTES); })() };
      return { ContentLength: 4096, ETag: '"e"' };
    }),
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
// A/B: with noP26 the route's single gate call decides "none" without
// running anything — the route without DF-P26's hold stop.
vi.mock("@/lib/requestHoldStop", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/requestHoldStop")>();
  return { ...real, issueHoldStopGate: (...a: Parameters<typeof real.issueHoldStopGate>) => (state.noP26 ? Promise.resolve({ kind: "none" as const }) : real.issueHoldStopGate(...a)) };
});
// GAP-102 acceptance 2 (DF-P26): arm B of the regression sweep also removes
// the issue notice's examination line (the route without DF-P26 at all).
vi.mock("@/lib/issueNoticeExamination", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/issueNoticeExamination")>();
  return { ...real, issueExaminationNote: (...a: Parameters<typeof real.issueExaminationNote>) => (state.hangNote ? new Promise<string | null>(() => {}) : state.noNote ? Promise.resolve(null) : real.issueExaminationNote(...a)) };
});
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { WorkflowEngine, ISSUING_APPROVALS } from "@/lib/workflow";
import { rowToTicket } from "@/lib/ticketTransitions";
import { requestHoldRefusal, holdStopScope, carryNotifyHoldMark } from "@/lib/requestHoldStop";

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "staged" } as TicketAttachment;
const MEMBERS = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("e-2", "Engineer-3"), member("a-1", "Admin"), member("q-1", "Viewer"), member("q-2", "Viewer")];
const STATUSES: TicketStatus[] = ["PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_IFC", "FINAL_DRAFT", "PENDING_FINAL_APPROVAL", "CLOSED", "CANCELED"];
const CHECK = { kind: "check", label: "Engineering check", mode: "blocking", fill: { capability: "ticket.final_approve" }, independent_of: ["drafter"] };
const WATCH = { kind: "watch", label: "Inspection notice", mode: "notify_only", fill: { users: ["q-2"] }, records_examination: true };
const WITH_WATCH = { slots: [CHECK, WATCH] };
const PLAIN_WATCH = { slots: [CHECK, { ...WATCH, records_examination: undefined }] };
const SOURCE = { source_document: { id: DOC, document_number: "P-100" } };

const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [DRAFT], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 0,
  last_modified: LM, library_id: LIB, created_at: "2026-10-05T00:00:00.000Z", metadata: {}, ...over,
});
const reviewRow = (over: Record<string, unknown> = {}) => ticketRow({ status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], ...over });
const reset = () => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.after = []; state.noP26 = false; state.noNote = false; state.hangNote = false;
};
const seed = (routing: unknown = null) => {
  state.rows.org_members = MEMBERS.map((m) => ({ ...m }));
  state.rows.libraries = [{ id: LIB, org_id: "o1", name: "P&IDs", routing_control: routing }];
  state.rows.documents = [{ id: DOC, org_id: "o1", collection_id: null, library_id: LIB, routing_control: null, rev: null, current_version_id: null, document_number: "P-100" }];
  state.rows.ticket_review_slots = [];
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const normal = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "function" ? "[fn]" : x)).replace(UUID, "<uuid>").replace(ISO, "<ts>");
/** The hold stop's own read (its filter on the record's ticket id). */
const isStopRead = (c: { table: string; method: string; args: unknown[] }) => c.table === "document_holds" && c.method === "select" && c.args[0] === "id, reason, opened_by, opened_at, examination";
const ticketUpdates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update");
const writes = () => state.calls.filter((c) => c.method === "insert" || c.method === "update" || c.method === "upsert" || c.method === "delete");

beforeEach(() => { reset(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-22T08:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

async function openRoster(routing: unknown, metadata: Record<string, unknown> = SOURCE): Promise<TicketReviewRoster> {
  reset();
  seed(routing);
  state.user = { id: "d-1" };
  state.rows.tickets = [ticketRow({ metadata })];
  const res = await post({ ticketId: "t1", actionType: "submit_draft" });
  expect(res.status).toBe(200);
  return (ticketUpdates()[0].args[0] as { metadata: { review_roster: TicketReviewRoster } }).metadata.review_roster;
}

const hold = (over: Record<string, unknown> = {}, rosterId?: string) => {
  const examination = { stop: "hold", ticketId: "t1", rosterId: rosterId ?? "R", slotKind: "watch", contentHash: "h", files: [], ofFiles: 0, note: "nozzle orientation differs" };
  return { id: "h-1", org_id: "o1", document_id: DOC, reason: "Other", opened_by: "q-2", opened_at: "2026-10-21T10:00:00.000Z", released_at: null, examination, ...over };
};

async function run(row: Record<string, unknown>, uid: string, body: Record<string, unknown>, noP26: boolean, routing: unknown = null, extra: (() => void) | null = null, noNote = false) {
  reset();
  seed(routing);
  state.noP26 = noP26;
  state.noNote = noNote;
  state.rows.tickets = [row];
  state.rows.e_signatures = [{ id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: uid, content_hash: (((row.metadata as { review_roster?: { contentHash?: string } }).review_roster)?.contentHash) ?? "h", intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z" }];
  if (extra) extra();
  state.user = { id: uid };
  const res = await post({ ticketId: "t1", ...body });
  const json = await res.json().catch(() => null);
  for (const fn of state.after.splice(0)) await fn();
  return { status: res.status, json: normal(json), calls: normal(state.calls), callsNoStop: normal(state.calls.filter((c) => c.table !== "document_holds")), writes: normal(writes()), stopReads: state.calls.filter(isStopRead).length, raw: json };
}

describe("REGRESSION FIRST — where no record could exist, the route is today's, byte for byte", () => {
  it("every action x status x member (no roster; source document or not): identical with and without DF-P26; the gate reads nothing", async () => {
    let combos = 0;
    for (const metadata of [{}, SOURCE]) {
      for (const status of STATUSES) {
        for (const m of MEMBERS) {
          const row = status === "PENDING_REVIEW" || status === "PENDING_FINAL_APPROVAL" ? reviewRow({ status, metadata, assigned_engineer_id: status === "PENDING_FINAL_APPROVAL" ? "e-1" : null }) : ticketRow({ status, metadata });
          const t = rowToTicket(row as never) as Ticket;
          const offered = WorkflowEngine.getActions(t, m.role as Role, m.uid, undefined, { userRoles: m.roles as Role[] }).map((a) => a.action);
          for (const actionType of [...new Set([...offered, "sign_slot", "request_revision"])]) {
            const body = { actionType, comment: "a reason", signatureId: SIG, issueAsIsAcknowledged: true };
            const a = await run(row, m.uid, body, false);
            const b = await run(row, m.uid, body, true, null, null, true);
            const where = `${JSON.stringify(metadata)} ${status} ${m.uid} ${actionType}`;
            expect(a.status, where).toBe(b.status);
            expect(a.json, where).toBe(b.json);
            expect(a.calls, where).toBe(b.calls);
            expect(a.stopReads, where).toBe(0);
            expect(a.json, where).not.toMatch(/request_on_hold|request_hold_unreadable/);
            combos++;
          }
        }
      }
    }
    expect(combos).toBeGreaterThan(300);
  }, 240_000);

  it("a roster on record with no opted-in notify-only slot, or no source document: a completing sign-off and its dry run are byte-identical with the gate removed; no read (even with a hold on file)", async () => {
    const cases: Array<[unknown, Record<string, unknown>]> = [[PLAIN_WATCH, SOURCE], [WITH_WATCH, {}], [{ slots: [CHECK] }, SOURCE]];
    for (const [routing, metadata] of cases) {
      const roster = await openRoster(routing, metadata);
      const signer = roster.slots.find((s) => s.kind === "check")!.primaries[0];
      const row = reviewRow({ metadata: { ...metadata, review_roster: roster } });
      for (const dryRun of [true, false]) {
        const extra = () => { state.rows.document_holds = [hold({}, roster.id)]; };
        const a = await run(row, signer, { actionType: "sign_slot", signatureId: SIG, dryRun }, false, routing, extra);
        const b = await run(row, signer, { actionType: "sign_slot", signatureId: SIG, dryRun }, true, routing, extra, true);
        const where = `${JSON.stringify(routing).slice(0, 60)} ${JSON.stringify(metadata)} ${dryRun}`;
        expect(a.status, where).toBe(b.status);
        expect(a.json, where).toBe(b.json);
        expect(a.calls, where).toBe(b.calls);
        expect(a.stopReads, where).toBe(0);
        expect(a.status, where).toBe(200);
      }
    }
  });
  it("holdStopScope: only a source document AND an opted-in notify-only slot on the roster on record", () => {
    const roster = { v: 1, id: "r", files: [], slots: [{ kind: "watch", mode: "notify_only", primaries: ["q-2"], recordsExamination: true }] };
    expect(holdStopScope({ metadata: { ...SOURCE, review_roster: roster }, requesterId: "req-1" } as never)).toMatchObject({ sourceId: DOC, documentLabel: "P-100" });
    expect(holdStopScope({ metadata: { review_roster: roster }, requesterId: "req-1" } as never)).toBeNull();
    expect(holdStopScope({ metadata: { source_document: { id: "not-a-uuid" }, review_roster: roster }, requesterId: "req-1" } as never)).toBeNull();
    expect(holdStopScope({ metadata: { ...SOURCE, review_roster: { ...roster, slots: [{ ...roster.slots[0], recordsExamination: undefined }] } }, requesterId: "req-1" } as never)).toBeNull();
    expect(holdStopScope({ metadata: SOURCE, requesterId: "req-1" } as never)).toBeNull();
  });
});

describe("GAP-116 — an open hold of the slot's people stops the request's completing sign-off", () => {
  let roster: TicketReviewRoster;
  let signer: string;
  let row: Record<string, unknown>;
  beforeEach(async () => {
    roster = await openRoster(WITH_WATCH);
    signer = roster.slots.find((s) => s.kind === "check")!.primaries[0];
    row = reviewRow({ metadata: { ...SOURCE, review_roster: roster } });
  });
  it("a hold placed by the slot's person with this request's record: the dry run and the sign-off are refused 409 with the plain sentence; nothing written but the signature's not-applied row", async () => {
    const extra = () => { state.rows.document_holds = [hold({}, roster.id)]; };
    const dry = await run(row, signer, { actionType: "sign_slot", dryRun: true }, false, WITH_WATCH, extra);
    expect(dry.status).toBe(409);
    expect(dry.raw).toMatchObject({ code: "request_on_hold", holds: [{ id: "h-1", reason: "Other", slot: "Inspection notice" }] });
    expect(dry.raw.error).toBe("P-100 is on hold (Other), placed by q-2 for Inspection notice with what they examined for this request. The hold stops this request: it cannot issue until the hold is released. The person who placed it, or anyone allowed to release holds, can release it on the document — then try again.");
    expect(JSON.parse(dry.writes)).toEqual([]);
    const real = await run(row, signer, { actionType: "sign_slot", signatureId: SIG }, false, WITH_WATCH, extra);
    expect(real.status).toBe(409);
    expect(ticketUpdates()).toEqual([]);
    const ws = writes();
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ table: "audit_logs", method: "insert" });
    expect((ws[0].args[0] as { action: string; details: Record<string, unknown> })).toMatchObject({ action: "TICKET_SIGN_SLOT_NOT_APPLIED", details: { signatureId: SIG, status: 409, code: "request_on_hold" } });
  });
  it("releasing the hold lets it proceed: the same sign-off issues the request", async () => {
    const extra = () => { state.rows.document_holds = [hold({ released_at: "2026-10-22T07:00:00.000Z" }, roster.id)]; };
    const r = await run(row, signer, { actionType: "sign_slot", signatureId: SIG }, false, WITH_WATCH, extra);
    expect(r.status).toBe(200);
    expect(r.raw.status).toBe("PENDING_IFC");
  });
  it("without a stopping hold every outcome is identical — no hold, a hold by someone not of the slot, a hold naming another request, a released hold — the gate adds only its read", async () => {
    const holdsCases: Array<Array<Record<string, unknown>>> = [
      [],
      [hold({ opened_by: "q-1" }, roster.id)],
      [{ ...hold({}, roster.id), examination: { ...hold({}, roster.id).examination, ticketId: "t-other" } }],
      [hold({ released_at: "2026-10-22T07:00:00.000Z" }, roster.id)],
    ];
    for (const holds of holdsCases) {
      for (const body of [{ actionType: "sign_slot", dryRun: true }, { actionType: "sign_slot", signatureId: SIG }]) {
        const extra = () => { state.rows.document_holds = holds; };
        const a = await run(row, signer, body, false, WITH_WATCH, extra);
        const b = await run(row, signer, body, true, WITH_WATCH, extra);
        const where = `${JSON.stringify(holds).slice(0, 80)} ${JSON.stringify(body)}`;
        expect(a.status, where).toBe(b.status);
        expect(a.json, where).toBe(b.json);
        expect(a.writes, where).toBe(b.writes);
        // the only difference: the gate's one document_holds read (arm B makes none)
        expect(a.callsNoStop, where).toBe(b.callsNoStop);
        expect(b.stopReads, where).toBe(0);
        expect(a.stopReads, where).toBe(1);
      }
    }
  });
  it("a sign-off that would NOT complete the review is never stopped (no read)", async () => {
    const twoSlots: TicketReviewRoster = { ...roster, slots: [...roster.slots, { ...roster.slots[0], id: "s2", kind: "lead", label: "Lead", primaries: ["q-1"], engineering: false }] };
    const r = await run(reviewRow({ metadata: { ...SOURCE, review_roster: twoSlots } }), signer, { actionType: "sign_slot", dryRun: true }, false, WITH_WATCH, () => { state.rows.document_holds = [hold({}, roster.id)]; });
    expect(r.status).toBe(200);
    expect(r.stopReads).toBe(0);
  });
  it("an earlier round's hold is judged against that round's ledger rows: the slot's person stops it; another does not; an unreadable ledger is a 503", async () => {
    const ledgerRow = { org_id: "o1", ticket_id: "t1", roster_id: OLD_ROSTER, slot_kind: "watch", label: "Inspection notice", mode: "notify_only", primaries: ["q-2"], alternates: [] };
    const stopped = await run(row, signer, { actionType: "sign_slot", dryRun: true }, false, WITH_WATCH, () => { state.rows.document_holds = [hold({}, OLD_ROSTER)]; state.rows.ticket_review_slots = [ledgerRow]; });
    expect(stopped.status).toBe(409);
    const other = await run(row, signer, { actionType: "sign_slot", dryRun: true }, false, WITH_WATCH, () => { state.rows.document_holds = [hold({}, OLD_ROSTER)]; state.rows.ticket_review_slots = [{ ...ledgerRow, primaries: ["q-1"] }]; });
    expect(other.status).toBe(200);
    const unreadable = await run(row, signer, { actionType: "sign_slot", dryRun: true }, false, WITH_WATCH, () => { state.rows.document_holds = [hold({}, OLD_ROSTER)]; state.errors.ticket_review_slots = { code: "PGRST000", message: "timeout" }; });
    expect(unreadable.status).toBe(503);
    expect(unreadable.raw.code).toBe("request_hold_unreadable");
  });
  it("the holds unreadable where a record could exist: 503 (try again), nothing written; before 20261267 (no column): it proceeds", async () => {
    const r = await run(row, signer, { actionType: "sign_slot", signatureId: SIG }, false, WITH_WATCH, () => { state.errors.document_holds = { code: "PGRST000", message: "upstream timeout" }; });
    expect(r.status).toBe(503);
    expect(r.raw).toMatchObject({ code: "request_hold_unreadable" });
    expect(ticketUpdates()).toEqual([]);
    const pre = await run(row, signer, { actionType: "sign_slot", signatureId: SIG }, false, WITH_WATCH, () => { state.errors.document_holds = { code: "42703", message: "column document_holds.examination does not exist" }; });
    expect(pre.status).toBe(200);
  });
  it("a non-issuing action on the same request (a revision request) never reads the holds", async () => {
    const r = await run(row, "req-1", { actionType: "request_revision", comment: "fix it" }, false, WITH_WATCH, () => { state.rows.document_holds = [hold({}, roster.id)]; });
    expect(r.stopReads).toBe(0);
  });
});

describe("GAP-116 — an issuing approval on a request whose roster on record carries the slot (an earlier round, now unrouted)", () => {
  function issuer(r: Record<string, unknown>): { uid: string; action: string } {
    const t = rowToTicket(r as never) as Ticket;
    for (const m of MEMBERS) {
      const a = WorkflowEngine.getActions(t, m.role as Role, m.uid, undefined, { userRoles: m.roles as Role[], activeMemberCount: MEMBERS.length }).find((x) => ISSUING_APPROVALS.has(x.action) && !x.disabledReason && !x.requiresComment);
      if (a) return { uid: m.uid, action: a.action };
    }
    throw new Error("no issuer in the harness");
  }
  it("refused 409 while the slot person's hold is open; with it released (or none) every outcome is identical to the route without the gate", async () => {
    const roster = await openRoster(WITH_WATCH);
    const closed = { ...roster, closedAt: "2026-10-21T00:00:00.000Z", closedReason: "request_revision" };
    const row = reviewRow({ metadata: { ...SOURCE, review_roster: closed } });
    const who = issuer(row);
    const stopped = await run(row, who.uid, { actionType: who.action, issueAsIsAcknowledged: true }, false, null, () => { state.rows.document_holds = [hold({}, roster.id)]; });
    expect(stopped.status).toBe(409);
    expect(stopped.raw.code).toBe("request_on_hold");
    expect(JSON.parse(stopped.writes)).toEqual([]);
    for (const holds of [[], [hold({ released_at: "2026-10-22T07:00:00.000Z" }, roster.id)]]) {
      const extra = () => { state.rows.document_holds = holds; };
      const a = await run(row, who.uid, { actionType: who.action, issueAsIsAcknowledged: true }, false, null, extra);
      const b = await run(row, who.uid, { actionType: who.action, issueAsIsAcknowledged: true }, true, null, extra);
      expect(a.status).toBe(200);
      expect(a.status).toBe(b.status);
      expect(a.json).toBe(b.json);
      expect(a.writes).toBe(b.writes);
      expect(a.callsNoStop).toBe(b.callsNoStop);
      expect(a.stopReads).toBe(1);
      expect(b.stopReads).toBe(0);
    }
  });
});

describe("DF-P26 fix pass 2 — a hold placed in an earlier round keeps stopping the request after the routing drops the opt-in", () => {
  it("the next round's roster carries the mark; the round-1 hold of the slot's person stops round 2's completing sign-off", async () => {
    const round1 = await openRoster(WITH_WATCH);
    const closed1 = { ...round1, closedAt: "2026-10-21T00:00:00.000Z", closedReason: "request_revision" };
    // the controller removes records_examination; the draft is re-submitted
    const round2 = await openRoster(PLAIN_WATCH, { ...SOURCE, review_roster: closed1 });
    expect(round2.id).not.toBe(round1.id);
    expect(round2.slots.some((x) => x.recordsExamination)).toBe(false);
    expect(round2.notifyHoldRecordsEarlier).toBe(true);
    const row = reviewRow({ metadata: { ...SOURCE, review_roster: round2 } });
    const signer = round2.slots.find((x) => x.kind === "check")!.primaries[0];
    const ledgerRow = { org_id: "o1", ticket_id: "t1", roster_id: round1.id, slot_kind: "watch", label: "Inspection notice", mode: "notify_only", primaries: ["q-2"], alternates: [] };
    const extra = () => { state.rows.document_holds = [hold({}, round1.id)]; state.rows.ticket_review_slots = [ledgerRow]; };
    const r = await run(row, signer, { actionType: "sign_slot", signatureId: SIG }, false, PLAIN_WATCH, extra);
    expect(r.status).toBe(409);
    expect(r.raw.code).toBe("request_on_hold");
    // released → it issues
    const released = await run(row, signer, { actionType: "sign_slot", signatureId: SIG }, false, PLAIN_WATCH, () => { extra(); state.rows.document_holds = [hold({ released_at: "2026-10-22T07:00:00.000Z" }, round1.id)]; });
    expect(released.status).toBe(200);
    expect(released.raw.status).toBe("PENDING_IFC");
    // the mark carries on into a third round
    const round3 = await openRoster(PLAIN_WATCH, { ...SOURCE, review_roster: { ...round2, closedAt: "2026-10-22T09:00:00.000Z" } });
    expect(round3.notifyHoldRecordsEarlier).toBe(true);
  });
  it("REGRESSION: where no earlier round carried an opted-in notify-only slot, the new roster has no mark (no key) and the scope reads nothing", async () => {
    const plain1 = await openRoster(PLAIN_WATCH);
    expect("notifyHoldRecordsEarlier" in plain1).toBe(false);
    const plain2 = await openRoster(PLAIN_WATCH, { ...SOURCE, review_roster: { ...plain1, closedAt: "2026-10-21T00:00:00.000Z" } });
    expect("notifyHoldRecordsEarlier" in plain2).toBe(false);
    expect(holdStopScope({ metadata: { ...SOURCE, review_roster: plain2 }, requesterId: "req-1" } as never)).toBeNull();
    // pure: the same object back when nothing carries
    expect(carryNotifyHoldMark(plain2, { metadata: { review_roster: plain1 }, requesterId: "req-1" } as never)).toBe(plain2);
    expect(carryNotifyHoldMark(plain2, { metadata: {}, requesterId: "req-1" } as never)).toBe(plain2);
    expect(holdStopScope({ metadata: { ...SOURCE, review_roster: { ...plain2, notifyHoldRecordsEarlier: true } }, requesterId: "req-1" } as never)).toMatchObject({ sourceId: DOC });
  });
});

describe("the refusal sentence", () => {
  it("names the document, the reason, the opener (or the slot's people when unnamed) and who can release it; several holds are counted", () => {
    const h = { id: "h", reason: "Engineering review", openedBy: "u", openedAt: null, slotLabel: "QA", openerName: null };
    expect(requestHoldRefusal("P-100", [h])).toBe("P-100 is on hold (Engineering review), placed by a member of QA for QA with what they examined for this request. The hold stops this request: it cannot issue until the hold is released. The person who placed it, or anyone allowed to release holds, can release it on the document — then try again.");
    expect(requestHoldRefusal("P-100", [{ ...h, openerName: "Quinn" }, h])).toMatch(/placed by Quinn for QA with what they examined for this request \(and 1 more hold like it\)\./);
  });
});

describe("GAP-102 acceptance 2 — the issue notice carries the recorded examination data (names and counts only)", () => {
  const CFG = { requestTypes: { options: [] }, examinationScope: { fields: [{ key: "exam", label: "Examination scope", options: [{ value: "rt5", label: "5% RT" }] }], requirements: [] } };
  function issuer(r: Record<string, unknown>): { uid: string; action: string } {
    const t = rowToTicket(r as never) as Ticket;
    for (const m of MEMBERS) {
      const a = WorkflowEngine.getActions(t, m.role as Role, m.uid, undefined, { userRoles: m.roles as Role[], activeMemberCount: MEMBERS.length }).find((x) => ISSUING_APPROVALS.has(x.action) && !x.disabledReason && !x.requiresComment);
      if (a) return { uid: m.uid, action: a.action };
    }
    throw new Error("no issuer in the harness");
  }
  const bells = () => state.calls.filter((c) => c.table === "notifications" && c.method === "insert").flatMap((c) => c.args[0] as Array<{ body: string; kind: string }>);
  const mails = () => state.calls.filter((c) => c.table === "email_notifications" && c.method === "insert").flatMap((c) => c.args[0] as Array<{ body_text: string; body_html: string; event_type: string }>);
  it("an issuing approval on a request with recorded scope values: every bell row and email of the existing kinds carries the one line; nothing else changes", async () => {
    const row = reviewRow();
    const who = issuer(row);
    const withValues = () => {
      state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: CFG }];
      state.rows.ticket_examination_scopes = [{ ticket_id: "t1", org_id: "o1", field_values: { exam: { value: "rt5", by: "e-1", at: "2026-10-20T00:00:00Z" } }, waiver: null }];
    };
    const a = await run(row, who.uid, { actionType: who.action, issueAsIsAcknowledged: true }, false, null, withValues);
    const aBells = bells(); const aMails = mails();
    const b = await run(row, who.uid, { actionType: who.action, issueAsIsAcknowledged: true }, false, null, withValues, true);
    const bBells = bells(); const bMails = mails();
    expect(a.status).toBe(200);
    expect(a.json).toBe(b.json);
    const LINE = "Examination data: Examination scope: 5% RT.";
    expect(aBells.length).toBeGreaterThan(0);
    for (const [i, bell] of aBells.entries()) {
      expect(bell.kind).toBe("ticket_status");
      expect(bell.body).toBe(`${bBells[i].body}\n\n${LINE}`);
    }
    expect(aMails.length).toBeGreaterThan(0);
    for (const [i, m] of aMails.entries()) {
      expect(m.event_type).toBe("ticket_approved");
      expect(m.body_text).toContain(`\n${LINE}\n`);
      expect(m.body_text.replace(`\n${LINE}\n`, "")).toBe(bMails[i].body_text);
      expect(m.body_html).toContain(`<p>${LINE}</p>`);
    }
    // every other write is the same
    const strip = (w: string) => w.replace(/"body(_text|_html)?":"(\\.|[^"\\])*"/g, '"body":"-"');
    expect(strip(a.writes)).toBe(strip(b.writes));
  });
  it("DF-P26 review fix (DEC-90 ruling (4)): the examination read never delays the act — the response returns while issueExaminationNote hangs; the notice is composed and sent after the response", async () => {
    const row = reviewRow();
    const who = issuer(row);
    reset();
    seed(null);
    state.rows.tickets = [row];
    state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: CFG }];
    state.rows.ticket_examination_scopes = [{ ticket_id: "t1", org_id: "o1", field_values: { exam: { value: "rt5", by: "e-1", at: "2026-10-20T00:00:00Z" } }, waiver: null }];
    state.hangNote = true;
    state.user = { id: who.uid };
    const res = await post({ ticketId: "t1", actionType: who.action, issueAsIsAcknowledged: true });
    // the act's answer is back although the examination read never resolves
    expect(res.status).toBe(200);
    expect(ticketUpdates().length).toBeGreaterThan(0);
    // nothing of the notice was written inside the request — it waits in an after-response task
    expect(bells()).toEqual([]);
    expect(mails()).toEqual([]);
    expect(state.after.length).toBeGreaterThan(0);
    // released: the after-response task composes the line and sends the notice
    state.hangNote = false;
    for (const fn of state.after.splice(0)) await fn();
    expect(bells().length).toBeGreaterThan(0);
    for (const bell of bells()) expect(bell.body).toContain("Examination data: Examination scope: 5% RT.");
  });
  it("DF-P26 review fix: where no record could exist (unconfigured), the notice is still written inside the request, as before", async () => {
    const row = reviewRow();
    const who = issuer(row);
    reset();
    seed(null);
    state.rows.tickets = [row];
    state.hangNote = true; // would hang if it were called — it is not
    state.user = { id: who.uid };
    const res = await post({ ticketId: "t1", actionType: who.action, issueAsIsAcknowledged: true });
    expect(res.status).toBe(200);
    expect(bells().length).toBeGreaterThan(0);
    for (const bell of bells()) expect(bell.body).not.toMatch(/Examination data/);
  });
  it("PIN: a request with none (fields configured but nothing recorded; or unconfigured) sends exactly today's notice", async () => {
    const row = reviewRow();
    const who = issuer(row);
    for (const extra of [() => { state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: CFG }]; }, () => {}]) {
      const a = await run(row, who.uid, { actionType: who.action, issueAsIsAcknowledged: true }, false, null, extra);
      const b = await run(row, who.uid, { actionType: who.action, issueAsIsAcknowledged: true }, false, null, extra, true);
      expect(a.status).toBe(200);
      expect(a.json).toBe(b.json);
      expect(a.writes).toBe(b.writes);
    }
  });
  it("the sign-off that completes a review with an assurance slot: the notice names the slot and how many files were examined — never the note or file names", async () => {
    const QA = { kind: "qa", label: "Quality", mode: "blocking", fill: { users: ["q-1"] }, records_examination: true, independent_of: ["drafter"] };
    const roster = await openRoster({ slots: [QA] }, {});
    const others = roster.slots.filter((s) => s.kind !== "qa");
    const ready: TicketReviewRoster = { ...roster, slots: roster.slots.map((s) => (others.includes(s) ? { ...s, status: "satisfied" as const, satisfiedBy: "e-2", via: "primary" as const, signatureId: "x" } : s)) };
    const row = reviewRow({ metadata: { review_roster: ready } });
    const ledger = () => { state.rows.ticket_review_slots = ready.slots.map((x) => ({ org_id: "o1", ticket_id: "t1", roster_id: ready.id, slot_kind: x.kind, mode: x.mode, status: x.status })); };
    const r = await run(row, "q-1", { actionType: "sign_slot", signatureId: SIG, examination: { note: "weld map checked privately" } }, false, { slots: [QA] }, ledger);
    expect(r.raw.rosterLedgerNotWritten).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.raw.status).toBe("PENDING_IFC");
    const body = bells().map((b) => b.body).join("\n");
    // no file list sent: the record is "defaulted" and the notice says so (never "examined")
    expect(body).toContain("Assurance records: Quality (files under review: 1 file, not narrowed).");
    expect(body).not.toMatch(/weld map checked privately|iso_1A\.pdf/);
  });
});
