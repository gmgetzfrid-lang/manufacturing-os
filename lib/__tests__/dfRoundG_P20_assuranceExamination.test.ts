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
  examinationForAct, examinationAuditFields,
} from "@/lib/assuranceExamination";
import { parseRoutingControl, type RoutingControl } from "@/lib/routingControl";
import { draftToControl, controlToDraft, ASSURANCE_OPT_IN_HINT } from "@/components/documents/RoutingControlSection";

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
// The same, plus a facility's own blocking check filled by a named person —
// opted in as an assurance check by the controller (DF-P20 fix pass 2:
// `records_examination`, never inferred) — and a notify-only slot.
const ASSURED = { slots: [
  ...PLAIN.slots,
  { kind: "assure", label: "Inspection check", mode: "blocking", fill: { users: ["q-1"] }, independent_of: ["drafter"], records_examination: true },
  { kind: "watch", label: "Inspection notice", mode: "notify_only", fill: { users: ["q-2"] } },
] };
// DF-P20 fix pass 2 (review major): the configured rosters that exist at the
// deploy — blocking checks that are neither engineering nor the requester's,
// filled by a named person, by a role, by ticket.direct_approve — carry no
// opt-in, so they record nothing and render as before.
const UNFLAGGED = { slots: [
  ...PLAIN.slots,
  { kind: "assure", label: "Inspection check", mode: "blocking", fill: { users: ["q-1"] }, independent_of: ["drafter"] },
  { kind: "lead", label: "Lead check", mode: "blocking", fill: { roles: ["Viewer"] } },
  { kind: "direct", label: "Direct approval", mode: "blocking", fill: { capability: "ticket.direct_approve" } },
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
      ofFiles: 2, allFiles: true, note: null, defaulted: true,
    };
    expect(ev[0]).toMatchObject({ slot_kind: "assure", event: "satisfied", actor_id: "q-1", content_hash: roster.contentHash });
    // the event's copy names the slot by its label (fix pass 2, review minor 4)
    expect(ev[0].details).toEqual({ via: "primary", examination: { ...record, slotLabel: "Inspection check" } });
    // the record and the act agree: one insert, one hash
    expect((ev[0].details.examination as ExaminationRecord).contentHash).toBe(ev[0].content_hash);
    expect(state.r2.filter((x) => x.kind === "GetObjectCommand")).toEqual([]);
    const a = audits().find((x) => x.action === "TICKET_SIGN_SLOT")!;
    expect((a.details.reviewRoster as Record<string, unknown>).examination).toEqual({ slots: ["assure"], ...record });
  });

  it("fix pass 2 (review minor 1): the panel's sign-off with every file left ticked sends the list — a chosen 'all', not defaulted", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "q-1", SIG);
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG, examination: { files: ["a-d", "a-e"], note: null } })).status).toBe(200);
    const rec = events()[0].details.examination as ExaminationRecord;
    expect(rec).toMatchObject({ allFiles: true, ofFiles: 2 });
    expect("defaulted" in rec).toBe(false);
    expect(examinedFilesText(rec)).toBe("Examined all 2 files: iso_1A.pdf, iso_1A_sh2.pdf");
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
      { kind: "assure", label: "Inspection check", mode: "blocking", fill: { users: ["q-1", "req-1"] }, records_examination: true },
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
    // the page's Request Revision sends no file list: listed, never "examined"
    expect(ev.find((e) => e.slot_kind === "assure")!.details).toEqual({ reason: "request_revision", examination: {
      v: 1, act: "veto", contentHash: roster.contentHash, cycle: "1A",
      files: [{ id: "a-d", name: "iso_1A.pdf", sha256: SHA }, { id: "a-e", name: "iso_1A_sh2.pdf", sha256: SHA }],
      ofFiles: 2, allFiles: true, note: "the weld map is missing", defaulted: true, slotLabel: "Inspection check",
    } });
    expect(examinedFilesText(ev.find((e) => e.slot_kind === "assure")!.details.examination as ExaminationRecord)).toBe("Files under review: all 2 (not narrowed — the reviewer was not asked): iso_1A.pdf, iso_1A_sh2.pdf");
    const closed = audits().find((x) => x.action === "TICKET_REQUEST_REVISION")!.details.reviewRoster as Record<string, unknown>;
    expect(closed).toMatchObject({ id: roster.id, event: "closed", reason: "request_revision", examination: { slots: ["assure"], act: "veto", note: "the weld map is missing" } });
  });

  it("from the panel: the narrowed files and the note (sent as the comment too) land on the veto's record", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "q-1");
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment: "sheet 1 only — dimension missing", examination: { files: ["a-d"], note: "sheet 1 only — dimension missing" } });
    expect(res.status).toBe(200);
    const rec = events().find((e) => e.slot_kind === "assure")!.details.examination as ExaminationRecord;
    expect(rec).toMatchObject({ act: "veto", files: [{ id: "a-d" }], allFiles: false, note: "sheet 1 only — dimension missing" });
    expect("defaulted" in rec).toBe(false);
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

  it("fix pass (review blocker): the page's own Request Revision (no examination body) with a 2,500-character comment from the assurance occupant is accepted as before — the voided row carries the record, the note shortened and marked; the comment is kept whole", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "q-1");
    const comment = "w".repeat(2500);
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment, category: "Drafting Error" });
    expect(res.status).toBe(200);
    const assure = events().find((e) => e.slot_kind === "assure")!;
    expect(assure.event).toBe("voided");
    expect(assure.details.examination).toMatchObject({ act: "veto", allFiles: true, note: "w".repeat(EXAMINATION_NOTE_MAX), noteTruncated: true, defaulted: true });
    expect(JSON.stringify(updates())).toContain(comment);
    expect((audits().find((x) => x.action === "TICKET_REQUEST_REVISION")!.details.reviewRoster as { examination: { noteTruncated?: boolean } }).examination.noteTruncated).toBe(true);
  });

  it("a note the reviewer typed into the record past the limit is refused (the panel caps it) — nothing written", async () => {
    const roster = await submitRouted(ASSURED);
    actOn(roster, "q-1");
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment: "why", examination: { note: "n".repeat(EXAMINATION_NOTE_MAX + 1) } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("examination_invalid");
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
  it("fix pass 2 (review major): a configured table with NO opt-in — a person-, role- or ticket.direct_approve-filled blocking check — records nothing on any sign-off or veto, and its roster carries no flag (exactly as before the deploy)", async () => {
    const roster = await submitRouted(UNFLAGGED);
    expect(roster.slots.some((x) => "recordsExamination" in x)).toBe(false);
    actOn(roster, "q-1", SIG);
    expect((await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG, examination: "garbage" })).status).toBe(200);
    // q-1 fills the person-filled check and the role-filled one: { via } only on each
    expect(events().map((e) => [e.slot_kind, e.details])).toEqual([["assure", { via: "primary" }], ["lead", { via: "primary" }]]);
    expect("examination" in (audits().find((x) => x.action === "TICKET_SIGN_SLOT")!.details.reviewRoster as Record<string, unknown>)).toBe(false);
    actOn(roster, "q-1");
    expect((await post({ ticketId: "t1", actionType: "request_revision", comment: "fix it", examination: { files: ["gone"] } })).status).toBe(200);
    expect(events().every((e) => !("examination" in e.details))).toBe(true);
    expect("examination" in (audits().find((x) => x.action === "TICKET_REQUEST_REVISION")!.details.reviewRoster as Record<string, unknown>)).toBe(false);
  });

  it("fix pass 2: the opt-in is copied to the roster slot only where the routing slot carries it (blocking); every other slot is stored as before", async () => {
    const roster = await submitRouted(ASSURED);
    expect(roster.slots.filter((x) => x.recordsExamination === true).map((x) => x.kind)).toEqual(["assure"]);
    expect(roster.slots.filter((x) => x.kind !== "assure").some((x) => "recordsExamination" in x)).toBe(false);
  });

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
  const slot = (over: Partial<TicketReviewSlot>): TicketReviewSlot => ({ id: "r:x", kind: "x", label: "X", mode: "blocking", primaries: ["q-1"], alternates: [], overriders: [], independentOf: [], timeoutDays: null, fallback: false, status: "open", recordsExamination: true, ...over });
  const T = { requesterId: "req-1" } as Pick<Ticket, "requesterId">;
  const R = { contentHash: "c".repeat(64), cycle: "1A", files: [{ id: "a", name: "a.pdf", url: "k/a", sha256: "1".repeat(64) }, { id: null, name: "b.pdf", url: "k/b", sha256: null, unhashed: "too large to hash in a request" }] };

  it("an assurance slot is a property, not a name: a blocking slot, not the engineering approval, not the requester-only slot; a fallback slot is; notify-only and consent-window slots are not (fix pass)", () => {
    expect(isAssuranceSlot(slot({}), T)).toBe(true);
    // fix pass 2 (review major): never inferred — no opt-in, no assurance slot
    expect(isAssuranceSlot(slot({ recordsExamination: undefined }), T)).toBe(false);
    expect(rosterHasAssuranceSlot({ slots: [slot({ recordsExamination: undefined }), slot({ recordsExamination: undefined, fallback: true })] }, T)).toBe(false);
    // notify-only: told, never signed — no act a record could ride
    expect(isAssuranceSlot(slot({ mode: "notify_only", status: "told" }), T)).toBe(false);
    // consent window: it can advance by silence (nobody examined anything)
    expect(isAssuranceSlot(slot({ mode: "consent_window" }), T)).toBe(false);
    expect(isAssuranceSlot(slot({ mode: "consent_window", status: "satisfied", via: "consent" }), T)).toBe(false);
    expect(rosterHasAssuranceSlot({ slots: [slot({ mode: "consent_window" }), slot({ mode: "notify_only", status: "told" })] }, T)).toBe(false);
    expect(isAssuranceSlot(slot({ fallback: true, primaries: ["a-1", "a-2"] }), T)).toBe(true);
    expect(isAssuranceSlot(slot({ engineering: true }), T)).toBe(false);
    expect(isAssuranceSlot(slot({ primaries: ["req-1"] }), T)).toBe(false);
    expect(isAssuranceSlot(slot({ primaries: ["req-1", "q-1"] }), T)).toBe(true);
    expect(rosterHasAssuranceSlot({ slots: [slot({ engineering: true }), slot({ primaries: ["req-1"] })] }, T)).toBe(false);
    expect(rosterHasAssuranceSlot(null, T)).toBe(false);
  });
  it("buildExaminationRecord: default all; a file bound by identity keeps a null sha256; keys are the attachment id, else the storage key", () => {
    const all = buildExaminationRecord(R, undefined, { act: "sign_off" });
    expect(all).toEqual({ ok: true, record: { v: 1, act: "sign_off", contentHash: R.contentHash, cycle: "1A", files: [{ id: "a", name: "a.pdf", sha256: R.files[0].sha256 }, { id: null, name: "b.pdf", sha256: null }], ofFiles: 2, allFiles: true, note: null, defaulted: true } });
    // a body with no file list is defaulted too; a full list is a choice
    expect(buildExaminationRecord(R, { note: "n" }, { act: "sign_off" })).toMatchObject({ ok: true, record: { defaulted: true } });
    const chosen = buildExaminationRecord(R, { files: ["a", "k/b"] }, { act: "sign_off" });
    expect(chosen.ok && chosen.record.allFiles).toBe(true);
    expect(chosen.ok && "defaulted" in chosen.record).toBe(false);
    expect(R.files.map(examinationFileKey)).toEqual(["a", "k/b"]);
    const one = buildExaminationRecord(R, { files: ["k/b", "k/b"], note: " n " }, { act: "sign_off" });
    expect(one.ok && one.record).toMatchObject({ files: [{ name: "b.pdf" }], allFiles: false, note: "n" });
    expect(one.ok && "defaulted" in one.record).toBe(false);
  });
  it("a veto's note: the client's, else the comment (trimmed); neither → refused", () => {
    expect(buildExaminationRecord(R, null, { act: "veto", comment: "  why  " })).toMatchObject({ ok: true, record: { act: "veto", note: "why" } });
    expect(buildExaminationRecord(R, { note: "mine" }, { act: "veto", comment: "theirs" })).toMatchObject({ ok: true, record: { note: "mine" } });
    expect(buildExaminationRecord(R, { note: " " }, { act: "veto", comment: " " })).toEqual({ ok: false, error: "A revision request must say why — add a note." });
  });
  it("fix pass (review blocker): a veto's note that falls back to a long comment is never refused — kept to EXAMINATION_NOTE_MAX, marked noteTruncated; a typed note past the limit is still refused", () => {
    const long = buildExaminationRecord(R, undefined, { act: "veto", comment: `  ${"x".repeat(2500)}  ` });
    expect(long.ok).toBe(true);
    if (long.ok) {
      expect(long.record.note).toBe("x".repeat(EXAMINATION_NOTE_MAX));
      expect(long.record.noteTruncated).toBe(true);
      expect(examinationOf({ examination: long.record })).toEqual(long.record);
    }
    // a blank typed note falls back too
    expect(buildExaminationRecord(R, { note: " " }, { act: "veto", comment: "y".repeat(2001) })).toMatchObject({ ok: true, record: { noteTruncated: true } });
    // exactly the limit: kept whole, no mark
    const exact = buildExaminationRecord(R, undefined, { act: "veto", comment: "z".repeat(EXAMINATION_NOTE_MAX) });
    expect(exact.ok && "noteTruncated" in exact.record).toBe(false);
    expect(buildExaminationRecord(R, { note: "n".repeat(EXAMINATION_NOTE_MAX + 1) }, { act: "veto", comment: "short" })).toEqual({ ok: false, error: `The note is longer than ${EXAMINATION_NOTE_MAX} characters.` });
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
    // fix pass 2 (review minor 1): the reviewer was not asked — never "Examined"
    expect(examinedFilesText({ files: [{ id: "a", name: "a.pdf", sha256: null }, { id: "b", name: "b.pdf", sha256: null }], ofFiles: 2, allFiles: true, defaulted: true })).toBe("Files under review: all 2 (not narrowed — the reviewer was not asked): a.pdf, b.pdf");
  });
  it("fix pass 2: examinationOf reads back the defaulted mark and the slot label; junk in either is dropped, never a throw", () => {
    const base = { v: 1, act: "veto", contentHash: "c".repeat(64), cycle: null, files: [], ofFiles: 0, allFiles: true, note: "n" };
    expect(examinationOf({ examination: { ...base, defaulted: true, slotLabel: "Inspection check" } })).toEqual({ ...base, defaulted: true, slotLabel: "Inspection check" });
    expect(examinationOf({ examination: { ...base, defaulted: "yes", slotLabel: 4 } })).toEqual(base);
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
    expect(rows.map((r) => r.details)).toEqual([{ via: "primary" }, { via: "primary", examination: { ...record, slotLabel: "b" } }]);
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
    for (const f of ["lib/assuranceExamination.ts", "lib/ticketRoster.ts", "components/requests/TicketRosterPanel.tsx", "lib/routingControl.ts", "components/documents/RoutingControlSection.tsx", "lib/__tests__/dfRoundG_P20_assuranceExamination.test.ts", "lib/__tests__/dfRoundG_P20_assurancePanelRender.test.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(words);
    }
  });
  it("the record is written into the existing details column of the 20261242 ledger (jsonb NOT NULL DEFAULT '{}'), which no later migration changes", () => {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261242_df_roundG_ticket_roster.sql"), "utf8");
    expect(sql).toContain("details JSONB NOT NULL DEFAULT '{}'::jsonb,");
    expect(sql).toContain("event TEXT NOT NULL CHECK (event IN ('opened', 'told', 'satisfied', 'voided')),");
  });
});

describe("DF-P20 fix pass 2 (review major) — an assurance slot is the controller's explicit opt-in, never inferred", () => {
  const base = (over: Record<string, unknown>) => ({ slots: [{ kind: "eng", mode: "blocking", fill: { capability: "ticket.final_approve" } }, { kind: "assure", mode: "blocking", fill: { users: ["q-1"] }, ...over }] });
  const assureOf = (raw: unknown) => { const p = parseRoutingControl(raw); return p && p.ok ? p.control.slots[1] : p; };
  it("parseRoutingControl keeps records_examination: true on a blocking slot; false / null / absent store nothing", () => {
    expect(assureOf(base({ records_examination: true }))).toMatchObject({ kind: "assure", records_examination: true });
    for (const v of [false, null, undefined]) expect("records_examination" in (assureOf(base({ records_examination: v })) as object)).toBe(false);
  });
  it("refused on a notify-only or consent-window slot, on a slot only the requester fills, and as anything but true", () => {
    expect(parseRoutingControl(base({ mode: "notify_only", records_examination: true }))).toMatchObject({ ok: false, error: expect.stringMatching(/only a blocking slot records what its reviewer examined/) });
    expect(parseRoutingControl(base({ mode: "consent_window", records_examination: true }))).toMatchObject({ ok: false });
    expect(parseRoutingControl(base({ fill: { identity: "requester" }, records_examination: true }))).toMatchObject({ ok: false, error: expect.stringMatching(/requester's own acceptance/) });
    expect(parseRoutingControl(base({ records_examination: "yes" }))).toMatchObject({ ok: false, error: expect.stringMatching(/records_examination is true or absent/) });
    // the requester AND others: the others' check may record
    expect(assureOf(base({ fill: { identity: "requester", users: ["q-1"] }, records_examination: true }))).toMatchObject({ records_examination: true });
  });
  it("the routing editor: never ticked by default, round-trips a stored opt-in, writes it only on a blocking slot not filled by the requester alone", () => {
    const stored: RoutingControl = { slots: [
      { kind: "eng", mode: "blocking", fill: { capability: "ticket.final_approve" } },
      { kind: "assure", label: "Inspection check", mode: "blocking", fill: { users: ["q-1"] }, records_examination: true },
    ] };
    const drafts = controlToDraft(stored);
    expect(drafts.map((d) => d.recordsExamination ?? false)).toEqual([false, true]);
    expect(draftToControl(drafts)).toEqual(stored);
    // switched to notify-only, or to the requester: dropped (a stored value the parser would refuse is never written)
    expect("records_examination" in draftToControl([{ ...drafts[1], mode: "notify_only" }]).slots[0]).toBe(false);
    expect("records_examination" in draftToControl([{ ...drafts[1], fillKind: "requester" }]).slots[0]).toBe(false);
    // a slot the editor never opted in writes nothing new (a pre-DF-P20 table saves byte-identical)
    expect(draftToControl(controlToDraft({ slots: [stored.slots[0]] }))).toEqual({ slots: [stored.slots[0]] });
    expect(ASSURANCE_OPT_IN_HINT).toMatch(/neither the engineering approval nor the requester's own acceptance/);
    const src = readFileSync(join(process.cwd(), "components", "documents", "RoutingControlSection.tsx"), "utf8");
    expect(src).toContain('{s.mode === "blocking" && s.fillKind !== "requester" && (');
    expect(src).toContain('checked={!!s.recordsExamination}');
  });
  it("examinationForAct: nothing to record when no occupied slot is opted in (the body ignored, even junk); the audit copy is empty then", () => {
    const R = { contentHash: "c".repeat(64), cycle: "1A", files: [{ id: "a", name: "a.pdf", url: "k/a", sha256: null }] };
    const T = { requesterId: "req-1" };
    const s = (over: Record<string, unknown>) => ({ slot: { kind: "x", mode: "blocking" as const, primaries: ["q-1"], ...over } });
    expect(examinationForAct(R, T, [s({})], "junk", { act: "sign_off" })).toEqual({ ok: true, value: null });
    expect(examinationAuditFields(null)).toEqual({});
    const got = examinationForAct(R, T, [s({ recordsExamination: true }), s({ kind: "y" })], undefined, { act: "veto", comment: "why" });
    expect(got).toMatchObject({ ok: true, value: { kinds: ["x"], record: { act: "veto", note: "why", defaulted: true } } });
    expect(examinationForAct(R, T, [s({ recordsExamination: true })], "junk", { act: "sign_off" })).toMatchObject({ ok: false });
  });
  it("review minor 3: the workflow route carries one call per act (the computation lives in lib/assuranceExamination.ts)", () => {
    const route = readFileSync(join(process.cwd(), "app", "api", "tickets", "workflow-action", "route.ts"), "utf8");
    expect(route).toContain('const exam = examinationForAct(openRosterNow, ticket, plan.fillable, body.examination, { act: "sign_off" });');
    expect(route).toContain('const exam = examinationForAct(openRosterNow, ticket, [...occ.fillable, ...occ.blocked], body.examination, { act: "veto", comment: body.comment ?? null });');
    expect(route.match(/examinationAuditFields\(examination\)/g)).toHaveLength(2);
    expect(route).not.toMatch(/isAssuranceSlot|buildExaminationRecord/);
  });
});
