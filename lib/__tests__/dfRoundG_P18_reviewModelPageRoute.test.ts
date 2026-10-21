// drafting-flow Round G, DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS — the
// workflow route's halves (route tests; the harness is DF-P6's
// dfRoundG_P6_reviewRoute.test.ts, copied):
//   * TIER-7: on a request of a work class the workspace flags "minor
//     correction", the minor-correction approval names its class in the
//     audit row; nothing for no class / an unflagged class (DEC-90 ruling (3));
//   * HAND-7 dw3: a roster sign-off over a moved source — its dry run and its
//     post — needs the acknowledgement; a failed documents read refuses the
//     dry run (503) with nothing recorded (DEC-90 ruling (2));
//   * GAP-101: the class sent with assign at triage is recorded (the page's
//     select), and refused off the list (REGRESSION of the DF-P6 route).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";

const LM = "2026-10-21T00:00:00.000Z";
const DOC = "d0000000-0000-4000-8000-000000000001";
const V3 = "a3000000-0000-4000-8000-000000000003";
const V4 = "a4000000-0000-4000-8000-000000000004";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
  // DF-P6 fix pass 2 (major 2): an error for a head-count read only.
  countErrors: {} as Record<string, { code?: string; message: string }>,
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
        if (head && state.countErrors[table]) return resolve({ data: null, error: state.countErrors[table], count: null });
        if (state.errors[table]) return resolve({ data: null, error: state.errors[table] });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head === true) head = true;
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
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn(() => {}) }));
vi.mock("@/lib/r2", () => ({ R2_BUCKET: "b", r2: { send: vi.fn(async () => ({ ContentLength: 4, ETag: '"e"' })) } }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DECLARED = {
  engineering_required: false,
  like_in_kind_statement: "Replacing the 6 inch gasket with an identical spiral-wound gasket",
  like_in_kind_declared_by: "req-1", like_in_kind_declared_at: "2026-10-20T00:00:00.000Z", like_in_kind_signature_id: "5a000000-0000-4000-8000-000000000001",
  work_class: null, code_class: null,
};
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "PENDING_REVIEW", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Manager", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 1, deliverable_rev: "1A",
  last_modified: LM, library_id: null, metadata: {}, ...over,
});
const DECL_SIG = { id: "5a000000-0000-4000-8000-000000000001", org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: "req-1" };
const seed = (requesterRole = "Manager") => {
  state.rows.org_members = [member("req-1", requesterRole), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("sup-1", "Supervisor"), member("ds-1", "DraftingSupervisor")];
  // DF-P6 fix pass (minor 11): a declaration stands on its e-signature.
  state.rows.e_signatures = [{ ...DECL_SIG }];
};
const updates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert").map((c) => c.args[0] as { action: string; details: Record<string, unknown> });

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.countErrors = {};
});


describe("TIER-7 (DF-P18) — the minor-correction class is named on the approval", () => {
  const CFG = { org_id: "o1", key: "drafting", data: { workClasses: { options: [{ value: "mc", label: "Typo fix", minorCorrection: true }, { value: "plain", label: "Plain" }] } } };
  it("a request of the flagged class: the audit row names the class beside the declared minor correction", async () => {
    seed("Maintenance");
    state.user = { id: "req-1" };
    state.rows.org_configurations = [CFG];
    state.rows.tickets = [ticketRow({ requester_role: "Maintenance", ...DECLARED, work_class: "mc" })];
    const res = await post({ ticketId: "t1", actionType: "approve_minor_correction", comment: "typo in the title block" });
    expect(res.status).toBe(200);
    expect(audits()[0].details).toMatchObject({ declaredClass: "minor_correction", minorCorrectionClass: "mc" });
  });
  it("REGRESSION (ruling (3)): no class, an unflagged class, or no configuration — the row is today's (no class key), the outcome the same", async () => {
    for (const [cfg, wc] of [[CFG, null], [CFG, "plain"], [null, "mc"]] as const) {
      state.calls = [];
      seed("Maintenance");
      state.user = { id: "req-1" };
      state.rows.org_configurations = cfg ? [cfg] : [];
      state.rows.tickets = [ticketRow({ requester_role: "Maintenance", ...DECLARED, work_class: wc })];
      const res = await post({ ticketId: "t1", actionType: "approve_minor_correction", comment: "typo in the title block" });
      expect(res.status).toBe(200);
      expect(audits()[0].details.declaredClass).toBe("minor_correction");
      expect("minorCorrectionClass" in audits()[0].details).toBe(false);
      expect(updates()[0].status).toBe("PENDING_IFC");
    }
  });
});

describe("HAND-7 dw3 (DF-P18) — a roster sign-off over a moved source", () => {
  const SIG = "5b000000-0000-4000-8000-000000000001";
  const rosterTicket = async (meta: Record<string, unknown>) => {
    const { openRoster } = await import("@/lib/ticketRoster");
    const { parseRoutingControl } = await import("@/lib/routingControl");
    const parsed = parseRoutingControl({ slots: [{ kind: "check", label: "Engineering check", mode: "blocking", fill: { roles: ["Engineer"] } }] });
    if (!parsed || !parsed.ok) throw new Error("bad control");
    const r = openRoster({ id: "r-1", control: parsed.control, level: "library", cycle: "1A",
      files: [{ id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", sha256: "f".repeat(64) }],
      ctx: { members: state.rows.org_members as never, policy: null, resource: { requestType: "ISO", unit: null }, requesterId: "req-1" }, openedBy: "d-1", now: LM });
    if (!r.ok) throw new Error(r.error);
    return ticketRow({ library_id: "1b000000-0000-4000-8000-000000000001", metadata: { review_roster: r.roster, ...meta } });
  };
  const moved = { source_document: { id: DOC, document_number: "P-101", rev: "3", version_id: V3 } };
  it("the dry run is refused without the acknowledgement (409, nothing recorded — no signature exists yet) and answered with it", async () => {
    seed("Manager");
    state.rows.documents = [{ id: DOC, org_id: "o1", rev: "4", current_version_id: V4, document_number: "P-101" }];
    state.user = { id: "e-1" };
    state.rows.tickets = [await rosterTicket(moved)];
    const refused = await post({ ticketId: "t1", actionType: "sign_slot", dryRun: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("source_drift_unacknowledged");
    expect(audits()).toEqual([]);
    const ok = await post({ ticketId: "t1", actionType: "sign_slot", dryRun: true, sourceDriftAcknowledged: true });
    expect(ok.status).toBe(200);
    expect(updates()).toEqual([]);
  });
  it("the post without the acknowledgement is refused and names the minted signature (DF-P5's rule)", async () => {
    seed("Manager");
    state.rows.documents = [{ id: DOC, org_id: "o1", rev: "4", current_version_id: V4, document_number: "P-101" }];
    state.rows.e_signatures = [{ ...DECL_SIG }, { id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: "e-1" }];
    state.user = { id: "e-1" };
    state.rows.tickets = [await rosterTicket(moved)];
    const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG });
    expect(res.status).toBe(409);
    expect(audits().find((a) => a.action === "TICKET_SIGN_SLOT_NOT_APPLIED")!.details).toMatchObject({ signatureId: SIG, code: "source_drift_unacknowledged" });
    expect(updates()).toEqual([]);
  });
  it("a failed documents read refuses the sign-off's dry run (503), nothing recorded", async () => {
    seed("Manager");
    state.errors.documents = { code: "57014", message: "timeout" };
    state.user = { id: "e-1" };
    state.rows.tickets = [await rosterTicket(moved)];
    const res = await post({ ticketId: "t1", actionType: "sign_slot", dryRun: true });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("source_drift_unchecked");
    expect(audits()).toEqual([]);
  });
  it("REGRESSION: an unmoved source — the dry run is answered with no acknowledgement, exactly as before", async () => {
    seed("Manager");
    state.rows.documents = [{ id: DOC, org_id: "o1", rev: "3", current_version_id: V3, document_number: "P-101" }];
    state.user = { id: "e-1" };
    state.rows.tickets = [await rosterTicket(moved)];
    expect((await post({ ticketId: "t1", actionType: "sign_slot", dryRun: true })).status).toBe(200);
  });
});

describe("GAP-101 / TIER-4 (DF-P18) — the class the triage select sends with assign", () => {
  const CFG = { org_id: "o1", key: "drafting", data: { workClasses: { options: [{ value: "pipe", label: "Piping", engineering: true }] }, codeClasses: { options: [{ value: "c1", label: "Code one" }] } } };
  const triage = (over: Record<string, unknown> = {}) => ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, deliverable_rev: null, review_model_filed: true, ...DECLARED, ...over });
  it("the picked work and code class are recorded; an engineering class raises the requirement", async () => {
    seed("Manager");
    state.user = { id: "sup-1" };
    state.rows.org_configurations = [CFG];
    state.rows.tickets = [triage()];
    const res = await post({ ticketId: "t1", actionType: "assign", assignment: { id: "d-1", name: "d-1" }, workClass: "pipe", codeClass: "c1" });
    expect(res.status).toBe(200);
    expect(updates()[0]).toMatchObject({ work_class: "pipe", code_class: "c1", engineering_required: true });
  });
  it("REGRESSION: an assign with no class (the unconfigured page sends none) writes no class column", async () => {
    seed("Manager");
    state.user = { id: "sup-1" };
    state.rows.tickets = [triage()];
    const res = await post({ ticketId: "t1", actionType: "assign", assignment: { id: "d-1", name: "d-1" } });
    expect(res.status).toBe(200);
    expect("work_class" in updates()[0]).toBe(false);
    expect("code_class" in updates()[0]).toBe(false);
  });
});
