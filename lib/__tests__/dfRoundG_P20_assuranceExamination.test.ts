// drafting-flow Round G, DF-P20 ASSURANCE EXAMINATION RECORD — GAP-102
// acceptances 1 and 4 as assigned at the DF-P6 merge, under the integrator's
// rulings for DF-P20 (DEC-90): what an assurance reviewer examined is
// recorded ON the slot event they create (ticket_review_slot_events.details,
// 20261242 — no migration), in the same insert as the sign-off or the veto;
// the record carries the roster's own sha256 (never a new hash), the files
// examined (default all; the reviewer may narrow) and the note (required,
// trimmed, for a veto). REGRESSION: a slot that is not an assurance slot, and
// every request with none, writes and records exactly as before.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { Ticket, TicketAttachment, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

const LM = "2026-10-21T00:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const SIG = "5a000000-0000-4000-8000-000000000001";
const SIG2 = "5a000000-0000-4000-8000-000000000002";
const BYTES = "%PDF-1.7 the draft";
const SHA = createHash("sha256").update(BYTES).digest("hex");

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
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { writeRosterLedger } from "@/lib/ticketRoster";
import {
  buildExaminationRecord, examinationOf, isAssuranceSlot, rosterHasAssuranceSlot, rosterOnRecord, shortHash, examinedFilesText,
  examinationFileKey, EXAMINATION_NOTE_MAX, EXAMINATION_NOT_RECORDED, type ExaminationRecord,
} from "@/lib/assuranceExamination";

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "staged" } as TicketAttachment;
const DRAFT2 = { id: "a-e", name: "iso_1A_sh2.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A_sh2.pdf", type: "Draft", status: "staged" } as TicketAttachment;
// The DF-P5 table: the requester's acceptance and an engineering-capability
// check — NO assurance slot (the regression table).
const PLAIN = { slots: [
  { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
  { kind: "check", label: "Engineering check", mode: "blocking", fill: { capability: "ticket.final_approve" }, independent_of: ["drafter"] },
] };
// The same, plus a facility's own blocking check filled by a named person and
// a notify-only slot — the two assurance shapes GAP-102 names.
const ASSURED = { slots: [
  ...PLAIN.slots,
  { kind: "assure", label: "Inspection check", mode: "blocking", fill: { users: ["q-1"] }, independent_of: ["drafter"] },
  { kind: "watch", label: "Inspection notice", mode: "notify_only", fill: { users: ["q-2"] } },
] };
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [DRAFT, DRAFT2], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 0,
  last_modified: LM, library_id: LIB, metadata: {}, ...over,
});
const seed = (routing: unknown) => {
  state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("e-2", "Engineer-3"), member("a-1", "Admin"), member("q-1", "Viewer"), member("q-2", "Viewer")];
  state.rows.libraries = [{ id: LIB, org_id: "o1", name: "P&IDs", routing_control: routing }];
  state.rows.ticket_review_slots = [];
};
const updates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert").map((c) => c.args[0] as { action: string; details: Record<string, unknown> });
type EventRow = { slot_kind: string; event: string; content_hash: string | null; details: Record<string, unknown>; actor_id: string | null };
const events = (): EventRow[] => state.calls.filter((c) => c.table === "ticket_review_slot_events" && c.method === "insert").flatMap((c) => c.args[0] as EventRow[]);
const signature = (id: string, signer: string, hash: string) => ({
  id, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: signer, content_hash: hash, intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z",
});

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.r2 = []; state.r2Fail = false; state.r2Hang = false; state.after = [];
});

async function submitRouted(routing: unknown): Promise<TicketReviewRoster> {
  state.calls = [];
  seed(routing);
  state.user = { id: "d-1" };
  state.rows.tickets = [ticketRow()];
  const res = await post({ ticketId: "t1", actionType: "submit_draft" });
  expect(res.status).toBe(200);
  return (updates()[0].metadata as { review_roster: TicketReviewRoster }).review_roster;
}
const underReview = (roster: TicketReviewRoster) => ticketRow({
  status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1,
  attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }, { ...DRAFT2, status: "submitted", rev: "1A" }], metadata: { review_roster: roster },
});
/** Put the roster under review and act as `uid` (calls / R2 reads reset). */
function actOn(roster: TicketReviewRoster, uid: string, sig?: string) {
  state.calls = [];
  state.r2 = [];
  state.rows.tickets = [underReview(roster)];
  if (sig) state.rows.e_signatures = [signature(sig, uid, roster.contentHash)];
  state.user = { id: uid };
}

describe("GAP-102 (DF-P20) — an assurance sign-off records what was examined on its own event, in the same insert", () => {
  it("default: every file under review, no note; the roster's own sha256 (no storage read: nothing hashed again); the audit row carries the same facts", async () => {
    const roster = await submitRouted(ASSURED);
    expect(roster.files.map((f) => f.id)).toEqual(["a-d", "a-e"]);
    actOn(roster, "q-1", SIG);
    const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
    expect(res.status).toBe(200);
    const ev = events();
    expect(ev).toHaveLength(1);
    const record: ExaminationRecord = {
      v: 1, act: "sign_off", contentHash: roster.contentHash, cycle: "1A",
      files: [{ id: "a-d", name: "iso_1A.pdf", sha256: SHA }, { id: "a-e", name: "iso_1A_sh2.pdf", sha256: SHA }],
      ofFiles: 2, allFiles: true, note: null,
    };
    expect(ev[0]).toMatchObject({ slot_kind: "assure", event: "satisfied", actor_id: "q-1", content_hash: roster.contentHash });
    expect(ev[0].details).toEqual({ via: "primary", examination: record });
    // the record and the act agree: one insert, one hash
    expect((ev[0].details.examination as ExaminationRecord).contentHash).toBe(ev[0].content_hash);
    expect(state.r2.filter((x) => x.kind === "GetObjectCommand")).toEqual([]);
    const a = audits().find((x) => x.action === "TICKET_SIGN_SLOT")!;
    expect((a.details.reviewRoster as Record<string, unknown>).examination).toEqual({ slots: ["assure"], ...record });
  });

  it("the reviewer narrows the files and writes a note: the record names exactly those files (roster order) and the trimmed note; the dry run takes the same body", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "q-1", SIG);
    const examination = { files: ["a-e"], note: "  checked the weld map on sheet 2  " };
    const dry = await post({ ticketId: "t1", actionType: "sign_slot", dryRun: true, examination });
    expect(dry.status).toBe(200);
    expect(events()).toEqual([]);
    const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG, examination });
    expect(res.status).toBe(200);
    expect(events()[0].details.examination).toMatchObject({
      act: "sign_off", files: [{ id: "a-e", name: "iso_1A_sh2.pdf", sha256: SHA }], ofFiles: 2, allFiles: false, note: "checked the weld map on sheet 2",
    });
  });

  it("a record that would not be true is refused before anything is written — a file not under review, an empty list, a malformed body, an over-long note — and on the dry run, so no signature is minted for it", async () => {
    const roster = await submitRouted(ASSURED);
    for (const examination of [{ files: ["not-a-file"] }, { files: [] }, { files: "a-d" }, "all", { note: 7 }, { note: "x".repeat(EXAMINATION_NOTE_MAX + 1) }]) {
      actOn(roster, "q-1", SIG);
      const dry = await post({ ticketId: "t1", actionType: "sign_slot", dryRun: true, examination });
      expect(dry.status, JSON.stringify(examination)).toBe(400);
      expect((await dry.json()).code).toBe("examination_invalid");
      const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG, examination });
      expect(res.status).toBe(400);
      expect(updates()).toEqual([]);
      expect(events()).toEqual([]);
    }
  });

  it("one sign-off filling an assurance slot AND the requester's own acceptance records only on the assurance slot's event (DEC-37: one act, every slot)", async () => {
    // the requester also sits in the assurance slot's pool
    const roster = await submitRouted({ slots: [
      { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
      { kind: "check", label: "Engineering check", mode: "blocking", fill: { capability: "ticket.final_approve" } },
      { kind: "assure", label: "Inspection check", mode: "blocking", fill: { users: ["q-1", "req-1"] } },
    ] });
    actOn(roster, "req-1", SIG);
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG })).status).toBe(200);
    const ev = events();
    expect(ev.map((e) => e.slot_kind).sort()).toEqual(["accept", "assure"]);
    expect(ev.find((e) => e.slot_kind === "accept")!.details).toEqual({ via: "primary" });
    expect((ev.find((e) => e.slot_kind === "assure")!.details.examination as ExaminationRecord).act).toBe("sign_off");
    expect((audits().find((x) => x.action === "TICKET_SIGN_SLOT")!.details.reviewRoster as { examination: { slots: string[] } }).examination.slots).toEqual(["assure"]);
  });
});

describe("GAP-102 (DF-P20) — a veto records what was examined, and must say why", () => {
  it("a revision request by the assurance reviewer: the voided event of THEIR slot carries the record with the comment as its note; every other voided row is exactly as before", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "q-1");
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment: "  the weld map is missing  " });
    expect(res.status).toBe(200);
    const ev = events();
    expect(ev.map((e) => [e.slot_kind, e.event])).toEqual([["accept", "voided"], ["check", "voided"], ["assure", "voided"]]);
    expect(ev.find((e) => e.slot_kind === "accept")!.details).toEqual({ reason: "request_revision" });
    expect(ev.find((e) => e.slot_kind === "check")!.details).toEqual({ reason: "request_revision" });
    expect(ev.find((e) => e.slot_kind === "assure")!.details).toEqual({ reason: "request_revision", examination: {
      v: 1, act: "veto", contentHash: roster.contentHash, cycle: "1A",
      files: [{ id: "a-d", name: "iso_1A.pdf", sha256: SHA }, { id: "a-e", name: "iso_1A_sh2.pdf", sha256: SHA }],
      ofFiles: 2, allFiles: true, note: "the weld map is missing",
    } });
    const closed = audits().find((x) => x.action === "TICKET_REQUEST_REVISION")!.details.reviewRoster as Record<string, unknown>;
    expect(closed).toMatchObject({ id: roster.id, event: "closed", reason: "request_revision", examination: { slots: ["assure"], act: "veto", note: "the weld map is missing" } });
  });

  it("from the panel: the narrowed files and the note (sent as the comment too) land on the veto's record", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "q-1");
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment: "sheet 1 only — dimension missing", examination: { files: ["a-d"], note: "sheet 1 only — dimension missing" } });
    expect(res.status).toBe(200);
    expect(events().find((e) => e.slot_kind === "assure")!.details.examination).toMatchObject({ act: "veto", files: [{ id: "a-d" }], allFiles: false, note: "sheet 1 only — dimension missing" });
  });

  it("a veto with no reason is refused (the comment is required, trimmed) — nothing written", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "q-1");
    for (const comment of [undefined, "", "   "]) {
      const res = await post({ ticketId: "t1", actionType: "request_revision", ...(comment === undefined ? {} : { comment }), examination: { note: "   " } });
      expect(res.status).toBe(400);
    }
    expect(updates()).toEqual([]);
    expect(events()).toEqual([]);
  });

  it("a veto naming a file not under review is refused before anything is written", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "q-1");
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment: "no", examination: { files: ["gone"] } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("examination_invalid");
    expect(updates()).toEqual([]);
    expect(audits()).toEqual([]);
  });
});

describe("REGRESSION (DF-P20 ruling (3)) — a slot that is not an assurance slot, and every request with none, is exactly as before", () => {
  it("the engineering sign-off on an assured roster: its event is { via } only, its audit row has no examination — even when a client sends one", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "e-1", SIG);
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG, examination: { files: ["a-d"], note: "x" } })).status).toBe(200);
    expect(events()).toEqual([expect.objectContaining({ slot_kind: "check", event: "satisfied" })]);
    expect(events()[0].details).toEqual({ via: "primary" });
    expect("examination" in (audits().find((x) => x.action === "TICKET_SIGN_SLOT")!.details.reviewRoster as Record<string, unknown>)).toBe(false);
  });

  it("the requester's own acceptance: { via } only, and a malformed examination body is ignored, never a refusal", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "req-1", SIG);
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG, examination: "garbage" })).status).toBe(200);
    expect(events()[0]).toMatchObject({ slot_kind: "accept", details: { via: "primary" } });
    expect(events()[0].details).toEqual({ via: "primary" });
  });

  it("a revision request by someone who holds no assurance slot (the engineer; the requester) voids every open slot with { reason } only", async () => {
    for (const who of ["e-1", "req-1"]) {
      const roster = await submitRouted(ASSURED);
      actOn(roster, who);
      expect((await post({ ticketId: "t1", actionType: "request_revision", comment: "fix it", examination: { note: "x" } })).status).toBe(200);
      expect(events().map((e) => e.details)).toEqual([{ reason: "request_revision" }, { reason: "request_revision" }, { reason: "request_revision" }]);
      expect("examination" in (audits().find((x) => x.action === "TICKET_REQUEST_REVISION")!.details.reviewRoster as Record<string, unknown>)).toBe(false);
    }
  });

  it("a roster with no assurance slot (the DF-P5 table): opened / satisfied / voided rows and audit rows exactly as DF-P5 wrote them", async () => {
    const roster = await submitRouted(PLAIN);
    expect(events().map((e) => e.details)).toEqual([
      { primaries: 1, alternates: 0, fallback: false, level: "library" },
      { primaries: 2, alternates: 0, fallback: false, level: "library" },
    ]);
    for (const [uid, kind] of [["e-1", "check"], ["req-1", "accept"]] as const) {
      actOn(roster, uid, SIG2);
      expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG2, examination: { note: "ignored" } })).status).toBe(200);
      expect(events()).toEqual([expect.objectContaining({ slot_kind: kind, event: "satisfied", details: { via: "primary" } })]);
      const rr = audits().find((x) => x.action === "TICKET_SIGN_SLOT")!.details.reviewRoster as Record<string, unknown>;
      expect(Object.keys(rr).sort()).toEqual(["complete", "contentHash", "event", "id", "signatureId", "slots"]);
    }
    actOn(roster, "e-1");
    expect((await post({ ticketId: "t1", actionType: "request_revision", comment: "fix the tag" })).status).toBe(200);
    expect(events().map((e) => e.details)).toEqual([{ reason: "request_revision" }, { reason: "request_revision" }]);
    expect(audits().find((x) => x.action === "TICKET_REQUEST_REVISION")!.details.reviewRoster).toEqual({ id: roster.id, event: "closed", reason: "request_revision" });
  });

  it("an unconfigured request (no roster) in review: a revision request carrying an examination body is today's — no ledger, no record", async () => {
    seed(null);
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ status: "PENDING_REVIEW", library_id: null, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }] })];
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment: "fix it", examination: { files: ["nope"], note: "x" } });
    expect(res.status).toBe(200);
    expect(events()).toEqual([]);
    expect("reviewRoster" in audits().find((x) => x.action === "TICKET_REQUEST_REVISION")!.details).toBe(false);
  });

  it("the notify-only slot's occupant is told when the roster opens (a 'told' row, as before) and has no sign-off — the assurance stop there is the hold (GAP-102 acceptance 3)", async () => {
    const roster = await submitRouted(ASSURED);
    expect(events().find((e) => e.slot_kind === "watch")).toMatchObject({ event: "told", details: { primaries: 1, alternates: 0, fallback: false, level: "library" } });
    actOn(roster, "q-2", SIG);
    const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
    expect(res.status).toBe(403);
    expect(events()).toEqual([]);
  });
});

describe("lib/assuranceExamination.ts — the record, pure", () => {
  const slot = (over: Partial<TicketReviewSlot>): TicketReviewSlot => ({ id: "r:x", kind: "x", label: "X", mode: "blocking", primaries: ["q-1"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "open", ...over });
  const T = { requesterId: "req-1" } as Pick<Ticket, "requesterId">;
  const R = { contentHash: "c".repeat(64), cycle: "1A", files: [{ id: "a", name: "a.pdf", url: "k/a", sha256: "1".repeat(64) }, { id: null, name: "b.pdf", url: "k/b", sha256: null, unhashed: "too large to hash in a request" }] };

  it("an assurance slot is a property, not a name: not the engineering approval, not the requester-only slot; notify-only and fallback slots are", () => {
    expect(isAssuranceSlot(slot({}), T)).toBe(true);
    expect(isAssuranceSlot(slot({ mode: "notify_only", status: "told" }), T)).toBe(true);
    expect(isAssuranceSlot(slot({ fallback: true, primaries: ["a-1", "a-2"] }), T)).toBe(true);
    expect(isAssuranceSlot(slot({ engineering: true }), T)).toBe(false);
    expect(isAssuranceSlot(slot({ primaries: ["req-1"] }), T)).toBe(false);
    expect(isAssuranceSlot(slot({ primaries: ["req-1", "q-1"] }), T)).toBe(true);
    expect(rosterHasAssuranceSlot({ slots: [slot({ engineering: true }), slot({ primaries: ["req-1"] })] }, T)).toBe(false);
    expect(rosterHasAssuranceSlot(null, T)).toBe(false);
  });
  it("buildExaminationRecord: default all; a file bound by identity keeps a null sha256; keys are the attachment id, else the storage key", () => {
    const all = buildExaminationRecord(R, undefined, { act: "sign_off" });
    expect(all).toEqual({ ok: true, record: { v: 1, act: "sign_off", contentHash: R.contentHash, cycle: "1A", files: [{ id: "a", name: "a.pdf", sha256: R.files[0].sha256 }, { id: null, name: "b.pdf", sha256: null }], ofFiles: 2, allFiles: true, note: null } });
    expect(R.files.map(examinationFileKey)).toEqual(["a", "k/b"]);
    const one = buildExaminationRecord(R, { files: ["k/b", "k/b"], note: " n " }, { act: "sign_off" });
    expect(one.ok && one.record).toMatchObject({ files: [{ name: "b.pdf" }], allFiles: false, note: "n" });
  });
  it("a veto's note: the client's, else the comment (trimmed); neither → refused", () => {
    expect(buildExaminationRecord(R, null, { act: "veto", comment: "  why  " })).toMatchObject({ ok: true, record: { act: "veto", note: "why" } });
    expect(buildExaminationRecord(R, { note: "mine" }, { act: "veto", comment: "theirs" })).toMatchObject({ ok: true, record: { note: "mine" } });
    expect(buildExaminationRecord(R, { note: " " }, { act: "veto", comment: " " })).toEqual({ ok: false, error: "A revision request must say why — add a note." });
  });
  it("examinationOf: a pre-DF-P20 event ({ via } / { reason }) or junk is 'not recorded' (null), never a throw; a stored record reads back", () => {
    for (const d of [{ via: "primary" }, { reason: "request_revision" }, null, undefined, "x", { examination: "x" }, { examination: { contentHash: 1, files: [] } }]) expect(examinationOf(d)).toBeNull();
    const built = buildExaminationRecord(R, { note: "n" }, { act: "veto", comment: null });
    expect(built.ok).toBe(true);
    if (built.ok) expect(examinationOf({ reason: "request_revision", examination: built.record })).toEqual(built.record);
    expect(EXAMINATION_NOT_RECORDED).toBe("Examination not recorded");
  });
  it("display: the hash shortened (copied in full elsewhere), the files counted", () => {
    expect(shortHash("abcdef0123456789")).toBe("abcdef012345…");
    expect(shortHash("abc")).toBe("abc");
    expect(examinedFilesText({ files: [{ id: "a", name: "a.pdf", sha256: null }], ofFiles: 2, allFiles: false })).toBe("Examined 1 of 2 files: a.pdf");
    expect(examinedFilesText({ files: [{ id: "a", name: "a.pdf", sha256: null }], ofFiles: 1, allFiles: true })).toBe("Examined all 1 file: a.pdf");
  });
  it("rosterOnRecord reads a closed roster too (the panel's history), and nothing that is not one", () => {
    const r = { v: 1, id: "r", slots: [], files: [], closedAt: "x" };
    expect(rosterOnRecord({ metadata: { review_roster: r } } as Pick<Ticket, "metadata">)).toBe(r);
    expect(rosterOnRecord({ metadata: { review_roster: { v: 2 } } } as Pick<Ticket, "metadata">)).toBeNull();
    expect(rosterOnRecord({ metadata: undefined } as Pick<Ticket, "metadata">)).toBeNull();
  });
});

describe("lib/ticketRoster.ts writeRosterLedger — the record rides the event insert", () => {
  const inserts: Array<{ t: string; rows: unknown }> = [];
  const client = {
    from: (t: string) => ({
      insert: (rows: unknown) => { inserts.push({ t, rows }); return Promise.resolve({ error: null }); },
      update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [{ id: "x" }], error: null }) }) }) }),
    }),
  };
  const roster = { v: 1, id: "r1", openedAt: LM, openedBy: "d-1", level: "library", cycle: "1A", contentHash: "c".repeat(64), files: [], slots: [] } as unknown as TicketReviewRoster;
  const s = (kind: string): TicketReviewSlot => ({ id: `r1:${kind}`, kind, label: kind, mode: "blocking", primaries: ["q-1"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "satisfied", satisfiedBy: "q-1", signatureId: SIG, via: "primary" });
  const record = { v: 1, act: "sign_off", contentHash: "c".repeat(64), cycle: "1A", files: [], ofFiles: 0, allFiles: true, note: null } as ExaminationRecord;
  beforeEach(() => { inserts.length = 0; });
  it("only the named slots' rows carry it; without it every row is byte-identical to DF-P5's", async () => {
    expect(await writeRosterLedger(client, { orgId: "o1", ticketId: "t1", roster, event: "satisfied", slots: [s("a"), s("b")], actor: { uid: "q-1", name: "q" }, examination: { kinds: ["b"], record } })).toBeNull();
    const rows = inserts.find((i) => i.t === "ticket_review_slot_events")!.rows as Array<{ slot_kind: string; details: unknown }>;
    expect(rows.map((r) => r.details)).toEqual([{ via: "primary" }, { via: "primary", examination: record }]);
    inserts.length = 0;
    await writeRosterLedger(client, { orgId: "o1", ticketId: "t1", roster, event: "satisfied", slots: [s("a")], actor: { uid: "q-1", name: "q" } });
    expect((inserts.find((i) => i.t === "ticket_review_slot_events")!.rows as Array<{ details: unknown }>)[0].details).toEqual({ via: "primary" });
  });
  it("an 'opened' write never carries a record (nothing has been examined yet)", async () => {
    await writeRosterLedger(client, { orgId: "o1", ticketId: "t1", roster, event: "opened", slots: [{ ...s("a"), status: "open" }], actor: { uid: "d-1", name: "d" }, examination: { kinds: ["a"], record } });
    const ev = (inserts.find((i) => i.t === "ticket_review_slot_events")!.rows as Array<{ details: Record<string, unknown> }>)[0];
    expect("examination" in ev.details).toBe(false);
  });
});

describe("DEC-35 / no migration — what DF-P20 wrote names no facility vocabulary and adds no table", () => {
  it("the census words (built from fragments, so this file adds no hit) appear in none of DF-P20's files", () => {
    const words = new RegExp([["QA", "QC"], ["QA/", "QC"], ["B", "31"], ["N", "DE"], ["radio", "graph"]].map((w) => w.join("")).join("|"));
    for (const f of ["lib/assuranceExamination.ts", "lib/ticketRoster.ts", "components/requests/TicketRosterPanel.tsx", "lib/__tests__/dfRoundG_P20_assuranceExamination.test.ts", "lib/__tests__/dfRoundG_P20_assurancePanelRender.test.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(words);
    }
  });
  it("the record is written into the existing details column of the 20261242 ledger (jsonb NOT NULL DEFAULT '{}'), which no later migration changes", () => {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261242_df_roundG_ticket_roster.sql"), "utf8");
    expect(sql).toContain("details JSONB NOT NULL DEFAULT '{}'::jsonb,");
    expect(sql).toContain("event TEXT NOT NULL CHECK (event IN ('opened', 'told', 'satisfied', 'voided')),");
  });
});
