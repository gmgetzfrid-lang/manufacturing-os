// projects-joint Round G — J21: POST /api/projects/deliverable-reference
// (drafting-flow PROJ-1; GAP-114; DEC-40 — reference, never copy).
//
// A request's deliverable published INTO document review is referenced on
// the request's project register when its review completes — the same
// project_documents reference and the same register policy as DF-P8's
// hand-back (lib/ticketProject.ts referenceDeliverableInProject,
// recordedRegisterAuthority / callerHoldsRegisterAuthority). Pinned:
//   · nothing owed (a version no request produced, a review not completed,
//     a request with no project, 20261256 not pasted) writes NOTHING;
//   · the register policy decides: the authority recorded on the link, else
//     the finalizer's own (asked as the caller); no authority → nothing
//     written, RECORDED on the request's audit trail and SAID;
//   · the feed row is doc_added only for an actor the feed's rule admits,
//     else request_deliverable_referenced; a document already on the
//     register is left exactly as it is;
//   · a refused write answers 503 (the page retries once) and is recorded.
// J21 fix pass (review major 1): the route is tied to the ACT of completing
// the review — only the finalizer, within FINALIZER_WINDOW_MS of the promote
// (a non-finalizer, a stale replay → not_finalizer, nothing written); a
// detach since the promote is never undone (detached_since); a caller who
// cannot read the request (AUTHZ-13) gets no detail and records nothing.
// Minors: the miss row carries user_role NULL (DEC-91); a failed register
// read is "unknown", never "not there".
// Merge-time fix (DEC-90 rulings 1 / 2 / 5): only documents.updated_by names
// the finalizer — a (forgeable) REVISION_PUBLISHED_AFTER_REVIEW audit row
// never qualifies; a promote that names the caller but whose release stamp is
// outside the window (a skewed browser clock) writes nothing to the register,
// is RECORDED (outside_window) and SAID; every miss also lands as ONE line on
// the request's own history (its Audit Log tab), naming no project and no
// document, compare-and-set on last_modified.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  user: { id: "u-fin", email: "fin@x.test" } as { id: string; email: string } | null,
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  rpc: {} as Record<string, boolean | null>,
  rpcCalls: [] as string[],
  writes: [] as Array<{ table: string; op: string; payload: Row; opts?: Row }>,
  ticketError: null as null | { code: string; message: string },
  refuseRegister: null as null | string,
  failRead: {} as Record<string, string>,
  /** tickets updates that land as a conflict (0 rows) before landing. */
  ticketConflicts: 0,
  failTicketUpdate: null as null | string,
}));

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = UUID(1), DOC = UUID(2), VER = UUID(3), TICKET = UUID(4), PROJ = UUID(5), OLDV = UUID(6);

function chain(table: string) {
  let op = "select";
  let payload: Row = {};
  let opts: Row | undefined;
  const filters: Array<[string, string, unknown]> = [];
  const field = (r: Row, k: string): unknown => {
    const [col, sub] = k.split("->>");
    const v = r[col];
    return sub === undefined ? v : (v && typeof v === "object" ? (v as Row)[sub] : undefined);
  };
  const matches = (r: Row) => filters.every(([how, k, v]) => (how === "eq" ? field(r, k) === v : how === "is" ? (field(r, k) ?? null) === v : String(field(r, k) ?? "") >= String(v)));
  const finish = (): { data: unknown; error: unknown } => {
    if (op === "update") {
      st.writes.push({ table, op, payload });
      if (table === "tickets" && st.failTicketUpdate) return { data: null, error: { code: "57014", message: st.failTicketUpdate } };
      if (table === "tickets" && st.ticketConflicts > 0) {
        st.ticketConflicts--;
        // someone else changed the request meanwhile
        for (const r of st.rows[table] ?? []) { r.last_modified = "2026-10-22T09:09:09.000Z"; r.history = [...((r.history as unknown[]) ?? []), { action: "Comment", by: "other" }]; }
        return { data: [], error: null };
      }
      const hit = (st.rows[table] ?? []).filter(matches);
      for (const r of hit) Object.assign(r, payload);
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    if (op === "insert") {
      st.writes.push({ table, op, payload });
      (st.rows[table] ??= []).push({ ...payload });
      return { data: null, error: null };
    }
    if (op === "upsert") {
      st.writes.push({ table, op, payload, opts });
      if (table === "project_documents" && st.refuseRegister) return { data: null, error: { code: "42501", message: st.refuseRegister } };
      const t = (st.rows[table] ??= []);
      if (t.some((r) => r.project_id === payload.project_id && r.document_id === payload.document_id)) return { data: [], error: null };
      const id = `pd-${t.length + 1}`;
      t.push({ id, ...payload });
      return { data: [{ id }], error: null };
    }
    if (table === "tickets" && st.ticketError) return { data: null, error: st.ticketError };
    if (st.failRead[table]) return { data: null, error: { code: "57014", message: st.failRead[table] } };
    return { data: (st.rows[table] ?? []).filter(matches), error: null };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(finish()).then(res, rej);
      return (...args: unknown[]) => {
        if (prop === "insert" || prop === "upsert" || prop === "update") { op = prop; payload = args[0] as Row; opts = args[1] as Row | undefined; }
        if (prop === "eq" || prop === "gte" || prop === "is") filters.push([prop, String(args[0]), args[1]]);
        if (prop === "maybeSingle") {
          const out = finish();
          return Promise.resolve({ data: (out.data as Row[] | null)?.[0] ?? null, error: out.error });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => (st.user ? { data: { user: st.user }, error: null } : { data: { user: null }, error: { message: "bad jwt" } }) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/serverAuth", () => ({
  callerScopedClient: () => ({
    rpc: async (fn: string) => {
      st.rpcCalls.push(fn);
      const v = st.rpc[fn];
      return v === null ? { data: null, error: { message: "unavailable" } } : { data: v ?? false, error: null };
    },
  }),
}));

import { NextRequest } from "next/server";
import { POST, FINALIZER_WINDOW_MS, REGISTER_AUTHORITY_UNCONFIRMED, OUTSIDE_FINALIZER_WINDOW, referenceMissHistoryEntry } from "@/app/api/projects/deliverable-reference/route";
import { PROJECT_REGISTER_MANAGERS_ONLY, REQUEST_DELIVERABLE_REFERENCED } from "@/lib/ticketProject";

const post = (body: unknown, auth = "Bearer tok") => POST(new NextRequest("http://x/api/projects/deliverable-reference", {
  method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body),
}));
const BODY = { orgId: ORG, documentId: DOC, versionId: VER };

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function seed(opts: {
  related?: string | null; current?: string; projectId?: string | null; registerAuthority?: boolean; member?: boolean;
  updatedBy?: string | null; releasedAgoMs?: number | null; role?: string; ticket?: Row;
} = {}) {
  st.rows = {
    document_versions: [{
      id: VER, org_id: ORG, record_id: DOC, revision_label: "2", related_ticket_id: opts.related === undefined ? TICKET : opts.related,
      released_at: opts.releasedAgoMs === null ? null : ago(opts.releasedAgoMs ?? 5_000),
    }],
    // the promote stamps the finalizer (finalize_reviewed_promote: auth.uid())
    documents: [{ id: DOC, org_id: ORG, current_version_id: opts.current ?? VER, updated_by: opts.updatedBy === undefined ? "u-fin" : opts.updatedBy }],
    org_members: opts.member === false ? [] : [{ uid: "u-fin", org_id: ORG, status: "active", email: "fin@x.test", role: opts.role ?? "DocCtrl", roles: null }],
    tickets: [{
      id: TICKET, org_id: ORG, ticket_id: "KE-0042", project_id: opts.projectId === undefined ? PROJ : opts.projectId,
      metadata: opts.registerAuthority ? { project_link: { projectId: PROJ, registerAuthority: true } } : {},
      requester_id: "u-req", assigned_drafter_id: null, assigned_engineer_id: null, watchers: [],
      history: [{ action: "Created", user: "req@x.test" }], last_modified: "2026-10-22T08:00:00.000Z",
      ...(opts.ticket ?? {}),
    }],
    project_documents: [],
    project_activity: [],
    audit_logs: [],
    ticket_comments: [],
  };
}
const registerWrites = () => st.writes.filter((w) => w.table === "project_documents");
const feed = () => st.writes.filter((w) => w.table === "project_activity").map((w) => w.payload.type);
const records = () => st.writes.filter((w) => w.table === "audit_logs").map((w) => ({ action: w.payload.action, reason: (w.payload.details as Row).reason, resource_id: w.payload.resource_id }));
/** The request's history lines a miss wrote (its Audit Log tab). */
const missLines = () => ((st.rows.tickets[0].history as Row[]) ?? []).filter((h) => h.action === "Deliverable not put on project register");

beforeEach(() => {
  st.user = { id: "u-fin", email: "fin@x.test" };
  st.rpc = {}; st.rpcCalls = []; st.writes = []; st.ticketError = null; st.refuseRegister = null; st.failRead = {};
  st.ticketConflicts = 0; st.failTicketUpdate = null;
  seed();
});

describe("PROJ-1 route — who may ask", () => {
  it("no bearer / a bad token: 401; a non-member: 403; nothing written", async () => {
    expect((await post(BODY, "")).status).toBe(401);
    st.user = null;
    expect((await post(BODY)).status).toBe(401);
    st.user = { id: "u-fin", email: "fin@x.test" };
    seed({ member: false });
    expect((await post(BODY)).status).toBe(403);
    expect(st.writes).toEqual([]);
  });
  it("ids that are not UUIDs: 400; a version of another document: 404", async () => {
    expect((await post({ documentId: "x", versionId: VER })).status).toBe(400);
    expect((await post({ ...BODY, documentId: UUID(99) })).status).toBe(404);
  });
});

describe("PROJ-1 route — nothing owed writes nothing (REGRESSION: a request with no project, or a document not from a request, is exactly as today)", () => {
  it.each([
    ["not_from_request", { related: null }],
    ["not_current", { current: OLDV }],
    ["no_project", { projectId: null }],
  ] as const)("%s", async (skipped, opts) => {
    seed(opts as Parameters<typeof seed>[0]);
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, referenced: false, skipped });
    expect(st.writes).toEqual([]);
    expect(st.rpcCalls).toEqual([]);
  });
  it("20261256 not pasted (tickets.project_id 42703): nothing owed, today's path", async () => {
    st.ticketError = { code: "42703", message: "column tickets.project_id does not exist" };
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, skipped: "not_migrated" });
    expect(st.writes).toEqual([]);
  });
  it("any other ticket read failure: 503 (retried), nothing written", async () => {
    st.ticketError = { code: "57014", message: "canceling statement due to statement timeout" };
    expect((await post(BODY)).status).toBe(503);
    expect(st.writes).toEqual([]);
  });
});

describe("PROJ-1 route — the register policy decides (DF-P8 fix passes 2 / 3)", () => {
  it("authority recorded on the link: the reference is written (ignoreDuplicates, the 'attach to project' shape) and the feed says request_deliverable_referenced for a finalizer who is not controller / owner", async () => {
    seed({ registerAuthority: true });
    const res = await post(BODY);
    expect(await res.json()).toEqual({ ok: true, referenced: true });
    expect(registerWrites()).toEqual([expect.objectContaining({
      op: "upsert", payload: expect.objectContaining({ org_id: ORG, project_id: PROJ, document_id: DOC, source: "manual" }),
      opts: { onConflict: "project_id,document_id", ignoreDuplicates: true },
    })]);
    expect(feed()).toEqual([REQUEST_DELIVERABLE_REFERENCED]);
    expect(st.rpcCalls).not.toContain("can_manage_project"); // the recorded authority answered
  });
  it("the finalizer manages the project (asked as the caller) and owns it: written, with doc_added", async () => {
    st.rpc = { is_org_controller: false, can_manage_project: true, is_project_owner: true };
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: true });
    expect(feed()).toEqual(["doc_added"]);
  });
  it("no authority: NOTHING on the register, the miss RECORDED on the request (TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN) and SAID", async () => {
    st.rpc = { is_org_controller: false, can_manage_project: false };
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, referenced: false, warning: PROJECT_REGISTER_MANAGERS_ONLY });
    expect(registerWrites()).toEqual([]);
    expect(records()).toEqual([{ action: "TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN", reason: "no_register_authority", resource_id: TICKET }]);
    // DEC-91 (review minor): the route admits by membership — no role is the one acted under, so none is stamped
    const row = st.writes.find((w) => w.table === "audit_logs")!.payload;
    expect(row.user_role).toBeNull();
    expect(row.user_id).toBe("u-fin");
  });
  it("an authority check that cannot be asked is never a yes: nothing written, recorded as unconfirmed", async () => {
    st.rpc = { is_org_controller: null, can_manage_project: false };
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, warning: REGISTER_AUTHORITY_UNCONFIRMED });
    expect(registerWrites()).toEqual([]);
    expect(records()[0].reason).toBe("authority_unconfirmed");
  });
  it("already on the register: left exactly as it is — no feed row, answered already_referenced", async () => {
    seed({ registerAuthority: true });
    st.rows.project_documents = [{ id: "pd-x", project_id: PROJ, document_id: DOC, source: "checkout" }];
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, skipped: "already_referenced" });
    expect(feed()).toEqual([]);
    expect(st.rows.project_documents).toEqual([{ id: "pd-x", project_id: PROJ, document_id: DOC, source: "checkout" }]);
  });
  it("a refused register write: 503 (the page retries once), recorded as write_refused, said", async () => {
    seed({ registerAuthority: true });
    st.refuseRegister = "permission denied for table project_documents";
    const res = await post(BODY);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.warning).toMatch(/not put on its request's project register: permission denied/);
    expect(records()).toEqual([{ action: "TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN", reason: "write_refused", resource_id: TICKET }]);
    expect(feed()).toEqual([]);
  });
});

describe("J21 fix pass (review major 1): tied to the act of completing the review, never to the revision's lasting state", () => {
  it("REGRESSION: a member who did NOT complete the review (the promote names someone else, no publish row of theirs) gets not_finalizer — nothing written, nothing recorded, no authority asked", async () => {
    seed({ registerAuthority: true, updatedBy: "u-other" });
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, skipped: "not_finalizer" });
    expect(st.writes).toEqual([]);
    expect(st.rpcCalls).toEqual([]);
  });
  it("merge-time fix (ruling 2): a FORGED REVISION_PUBLISHED_AFTER_REVIEW row (audit_logs_insert admits a member's own row) does not qualify — not_finalizer, nothing written; the real finalizer (the promote's updated_by) still does", async () => {
    seed({ registerAuthority: true, updatedBy: "u-other" });
    st.rows.audit_logs.push({ action: "REVISION_PUBLISHED_AFTER_REVIEW", resource_type: "document", resource_id: DOC, user_id: "u-fin", details: { versionId: VER } });
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, skipped: "not_finalizer" });
    expect(st.writes).toEqual([]);
    expect(st.rpcCalls).toEqual([]);
    // the promote names u-fin: the real finalizer is referenced
    st.rows.documents[0].updated_by = "u-fin";
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: true });
    expect(registerWrites()).toHaveLength(1);
  });
  it("merge-time fix (ruling 2): no audit row is read to qualify the caller (a failing audit_logs read cannot open or close the door)", async () => {
    seed({ registerAuthority: true, updatedBy: "u-other" });
    st.failRead = { audit_logs: "timeout" };
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, skipped: "not_finalizer" });
    expect(st.writes).toEqual([]);
    seed({ registerAuthority: true, updatedBy: null });
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, skipped: "not_finalizer" });
  });
  it("merge-time fix (ruling 1): the finalizer the promote names, asking outside FINALIZER_WINDOW_MS (a skewed browser clock on the three-step path) — NOTHING on the register, the miss RECORDED (outside_window) and SAID, never a silent skip", async () => {
    seed({ registerAuthority: true, releasedAgoMs: FINALIZER_WINDOW_MS + 60_000 });
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, referenced: false, warning: OUTSIDE_FINALIZER_WINDOW });
    expect(registerWrites()).toEqual([]);
    expect(feed()).toEqual([]);
    expect(records()).toEqual([{ action: "TICKET_DELIVERABLE_REFERENCE_NOT_WRITTEN", reason: "outside_window", resource_id: TICKET }]);
    expect(st.rpcCalls).toEqual([]); // no authority is asked: nothing is written whatever it says
    // a stamp from a clock running AHEAD is judged the same (|now − released_at|)
    seed({ registerAuthority: true, releasedAgoMs: -(FINALIZER_WINDOW_MS + 60_000) });
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, warning: OUTSIDE_FINALIZER_WINDOW });
    // a version with no release stamp: unjudgeable — recorded and said the same way
    seed({ registerAuthority: true, releasedAgoMs: null });
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, warning: OUTSIDE_FINALIZER_WINDOW });
    expect(registerWrites()).toEqual([]);
  });
  it("merge-time fix (ruling 1): outside the window, a request with no project is still nothing owed; a finalizer who cannot read the request (AUTHZ-13) gets no detail and nothing is recorded", async () => {
    seed({ releasedAgoMs: FINALIZER_WINDOW_MS + 60_000, projectId: null });
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, skipped: "no_project" });
    seed({ role: "Contractor", releasedAgoMs: FINALIZER_WINDOW_MS + 60_000 });
    expect(await (await post(BODY)).json()).toEqual({ ok: true });
    expect(st.writes).toEqual([]);
  });
  it("REGRESSION (post-detach replay): a detach since the promote — the register record's PROJECT_DOCUMENT_DETACHED row, or the card's doc_removed feed row — is never undone: detached_since, nothing written", async () => {
    seed({ registerAuthority: true, releasedAgoMs: 60_000 });
    st.rows.audit_logs.push({ action: "PROJECT_DOCUMENT_DETACHED", resource_type: "project", resource_id: PROJ, details: { documentId: DOC }, timestamp: ago(10_000) });
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, skipped: "detached_since" });
    seed({ registerAuthority: true, releasedAgoMs: 60_000 });
    st.rows.project_activity.push({ project_id: PROJ, type: "doc_removed", metadata: { documentId: DOC }, created_at: ago(10_000) });
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, skipped: "detached_since" });
    expect(registerWrites()).toEqual([]);
    expect(records()).toEqual([]);
  });
  it("a detach dated BEFORE the promote (or of another document) does not block the reference", async () => {
    seed({ registerAuthority: true, releasedAgoMs: 60_000 });
    st.rows.audit_logs.push({ action: "PROJECT_DOCUMENT_DETACHED", resource_type: "project", resource_id: PROJ, details: { documentId: DOC }, timestamp: ago(120_000) });
    st.rows.project_activity.push({ project_id: PROJ, type: "doc_removed", metadata: { documentId: UUID(77) }, created_at: ago(10_000) });
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: true });
  });
  it("AUTHZ-13: a Contractor-only finalizer who cannot read the request gets NO detail (no_project / a missing authority alike) and nothing is recorded on the request", async () => {
    seed({ role: "Contractor", projectId: null });
    expect(await (await post(BODY)).json()).toEqual({ ok: true });
    seed({ role: "Contractor" });
    st.rpc = { is_org_controller: false, can_manage_project: false };
    expect(await (await post(BODY)).json()).toEqual({ ok: true });
    expect(records()).toEqual([]);
    expect(registerWrites()).toEqual([]);
  });
  it("AUTHZ-13: the same Contractor on the request (its requester) gets the full answer and the miss is recorded", async () => {
    seed({ role: "Contractor", ticket: { requester_id: "u-fin" } });
    st.rpc = { is_org_controller: false, can_manage_project: false };
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, warning: PROJECT_REGISTER_MANAGERS_ONLY });
    expect(records()).toHaveLength(1);
  });
});

describe("J21 fix pass (review minor): a failed register read is unknown, never 'not there'", () => {
  it("the read before the write fails while the write lands: the answer leaves `referenced` out (no false 'referenced: true')", async () => {
    seed({ registerAuthority: true });
    st.rows.project_documents = [{ id: "pd-x", project_id: PROJ, document_id: DOC, source: "manual" }];
    st.failRead = { project_documents: "timeout" };
    const body = await (await post(BODY)).json();
    expect(body).toEqual({ ok: true });
    expect(feed()).toEqual([]); // already there: ignoreDuplicates wrote nothing, no feed row
  });
  it("a refused write whose re-read fails: said, NOT recorded as write_refused, no 503 retry", async () => {
    seed({ registerAuthority: true });
    st.refuseRegister = "statement timeout";
    st.failRead = { project_documents: "timeout" };
    const res = await post(BODY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toMatch(/could not be confirmed/);
    expect(body.referenced).toBeUndefined();
    expect(records()).toEqual([]);
  });
});

describe("merge-time fix (ruling 5): every miss stays on the request's OWN audit trail — one history line (the Audit Log tab reads tickets.history)", () => {
  it("a miss appends ONE line to the request's history — naming its audit row, no project name and no document number — by compare-and-set on last_modified", async () => {
    st.rpc = { is_org_controller: false, can_manage_project: false };
    await post(BODY);
    const lines = missLines();
    expect(lines).toHaveLength(1);
    const audit = st.writes.find((w) => w.table === "audit_logs")!.payload;
    expect(lines[0]).toMatchObject({ action: "Deliverable not put on project register", user: "fin@x.test", role: null, reason: "no_register_authority", versionId: VER, documentId: DOC, projectId: PROJ, attempt: audit.id });
    expect((audit.details as Row).historyAttempt).toBe(true);
    expect(String(lines[0].details)).toBe("The reviewed deliverable (document revision 2) became the controlled revision, but it was not put on this request's project document register: the person who completed the review does not hold authority over the project's document register. A project manager can attach it from the project's Documents card.");
    // the earlier history is kept, in order
    expect((st.rows.tickets[0].history as Row[])[0]).toEqual({ action: "Created", user: "req@x.test" });
    const upd = st.writes.filter((w) => w.table === "tickets" && w.op === "update");
    expect(upd).toHaveLength(1);
    expect(Object.keys(upd[0].payload).sort()).toEqual(["history", "last_modified"]);
  });
  it("each reason reads plainly; none names the project or a document number", () => {
    for (const reason of ["no_register_authority", "authority_unconfirmed", "write_refused", "outside_window"] as const) {
      const e = referenceMissHistoryEntry({ reason, revisionLabel: "B", email: "fin@x.test", now: "2026-10-22T00:00:00Z", projectId: PROJ, documentId: DOC, versionId: VER, attempt: "a1" });
      expect(String(e.details)).toMatch(/^The reviewed deliverable \(document revision B\) became the controlled revision, but it was not put on this request's project document register: .+\. A project manager can attach it from the project's Documents card\.$/);
      expect(Object.keys(e)).not.toContain("projectName");
      expect(String(e.action)).not.toMatch(/\bissued Rev \d+\b/); // never read as a workflow issue line (lib/verifyTicketVerdict.ts ISSUED_LINE)
    }
  });
  it("outside the window and a refused write land on the history too; the page's one retry of a refused write adds no second line", async () => {
    seed({ registerAuthority: true, releasedAgoMs: FINALIZER_WINDOW_MS + 60_000 });
    await post(BODY);
    expect(missLines().map((l) => l.reason)).toEqual(["outside_window"]);
    seed({ registerAuthority: true });
    st.refuseRegister = "permission denied for table project_documents";
    await post(BODY);
    await post(BODY); // the page's retry
    expect(missLines().map((l) => l.reason)).toEqual(["write_refused"]);
    expect(records().map((r) => r.reason)).toEqual(["outside_window", "write_refused", "write_refused"]); // each attempt is an audit row
  });
  it("a conflict (the request changed meanwhile) is read again and tried once more — the other writer's line is kept", async () => {
    st.rpc = { is_org_controller: false, can_manage_project: false };
    st.ticketConflicts = 1;
    await post(BODY);
    const h = st.rows.tickets[0].history as Row[];
    expect(h.map((x) => x.action)).toEqual(["Created", "Comment", "Deliverable not put on project register"]);
    expect(st.writes.filter((w) => w.table === "tickets" && w.op === "update")).toHaveLength(2);
  });
  it("a history write that fails never changes the answer: the warning is still said, the audit row still written", async () => {
    st.rpc = { is_org_controller: false, can_manage_project: false };
    st.failTicketUpdate = "statement timeout";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: false, warning: PROJECT_REGISTER_MANAGERS_ONLY });
    expect(records()).toHaveLength(1);
    expect(errSpy.mock.calls.some((c) => /history line for the miss/.test(String(c[0])))).toBe(true);
    errSpy.mockRestore();
  });
  it("REGRESSION: a reference that lands, or nothing owed, writes no history line and does not touch the request", async () => {
    seed({ registerAuthority: true });
    expect(await (await post(BODY)).json()).toEqual({ ok: true, referenced: true });
    seed({ projectId: null });
    await post(BODY);
    expect(st.writes.filter((w) => w.table === "tickets")).toEqual([]);
  });
});
