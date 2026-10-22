// projects-joint Round G — J21 DRAFTING-REQUEST PROJECT REMAINDERS: the two
// changes in lib/reviewControl.ts, driven through the REAL module on an
// in-memory client.
//
//   drafting-flow EVID-8 done-when 3 — the TIMEOUT alternate activation's
//   audit row is written VERIFIED: the insert's answer is read, a refusal is
//   retried once under the same row id (a 23505 on the retry is the first
//   attempt, landed), and when both fail the row is dead-lettered to the
//   EVID-6 outbox (DEC-109). REGRESSION (DEC-90 ruling (5)): who is activated
//   and when — the sign-off update, the notice — are exactly as before in
//   every case; the MANUAL activation's row still goes through logAuditAction
//   exactly as before.
//
//   drafting-flow PROJ-1 — when a document review completes
//   (finalizeReviewedRevision) on a version a drafting request produced, the
//   reference on the request's project is STARTED and never awaited: the
//   publish answers exactly as before (REGRESSION: same answer, same writes,
//   no call at all for a version no request produced), the route is asked
//   with the document and version, a 5xx / unreachable route is retried
//   once, and a reference not written is said (onProjectReferenceNote, else
//   the console).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
  /** answers for successive audit_logs inserts (null: lands) */
  auditAnswers: [] as Array<null | { code?: string; message: string }>,
  auditInserts: [] as Array<Record<string, unknown>>,
  deadLetters: [] as Array<{ row: Record<string, unknown>; error: string }>,
  logged: [] as Array<Record<string, unknown>>,
  session: "tok" as string | null,
  rpcAnswer: { data: "promoted", error: null } as { data: unknown; error: unknown },
}));

function chain(table: string) {
  let op = "select";
  let payload: unknown;
  const filters: Array<[string, unknown]> = [];
  const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);
  const finish = () => {
    if (op === "insert" && table === "audit_logs") {
      st.auditInserts.push(payload as Row);
      const ans = st.auditAnswers.length ? st.auditAnswers.shift()! : null;
      return { data: null, error: ans };
    }
    if (op !== "select") {
      st.writes.push({ table, op, payload });
      const hit = (st.rows[table] ?? []).filter(matches);
      if (op === "update") for (const r of hit) Object.assign(r, payload as Row);
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    return { data: (st.rows[table] ?? []).filter(matches), error: null };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(finish()).then(res, rej);
      return (...args: unknown[]) => {
        if (prop === "update" || prop === "insert" || prop === "delete") { op = prop; payload = args[0]; }
        if (prop === "eq" || prop === "is") filters.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") {
          const out = finish();
          return Promise.resolve({ data: (out.data as Row[] | null)?.[0] ?? null, error: out.error });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: async (fn: string) => (fn === "finalize_reviewed_promote" ? st.rpcAnswer : { data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: st.session ? { access_token: st.session } : null } }) },
  },
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (a: Record<string, unknown>) => { st.logged.push(a); return { error: null, ok: true }; }) }));
vi.mock("@/lib/auditOutbox", () => ({
  deadLetterAuditRow: vi.fn(async (row: Record<string, unknown>, error: string) => { st.deadLetters.push({ row, error }); return { kept: true }; }),
}));
vi.mock("@/lib/complianceNotify", () => ({
  notifyCompliance: vi.fn(async () => true),
  loadScanRetryPlan: vi.fn(async () => ({ only: () => () => true })),
}));
vi.mock("@/lib/documentNoticeRecord", () => ({
  noticeRecorder: () => ({ record: async () => undefined }),
  noticeRow: (r: unknown) => r,
  newBellId: () => "bell-1",
  recordRequestNotices: vi.fn(async () => undefined),
  replayDeferredNotices: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notify/dispatch", () => ({ pushAfterBellRows: vi.fn(async () => undefined) }));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/postPublish", () => ({ runPostPublishSideEffects: vi.fn(async () => undefined) }));
vi.mock("@/lib/effectiveDate", () => ({ applyEffectiveDate: vi.fn(async () => undefined) }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => undefined) }));
vi.mock("@/lib/checklists", () => ({ sweepEvidenceForDocument: vi.fn(async () => ({ projects: 0 })) }));

import { activateAlternate, finalizeReviewedRevision, ACTIVATION_AUDIT_RETRY_MS } from "@/lib/reviewControl";
import { referenceReviewedRequestDeliverable, DELIVERABLE_REFERENCE_ROUTE } from "@/lib/reviewDeliverableReference";

const CAUSE = { reason: "review_timeout" as const, timeoutDays: 7, ageDays: 9, documentVersionId: "v1" };
const seedSignoff = () => {
  st.rows.document_review_signoffs = [{ id: "s2", reviewer_user_id: "alt", revision_label: "C", activated: false, notified_at: null }];
};

beforeEach(() => {
  st.rows = {}; st.writes = []; st.auditAnswers = []; st.auditInserts = []; st.deadLetters = []; st.logged = [];
  st.session = "tok";
  st.rpcAnswer = { data: "promoted", error: null };
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("EVID-8 done-when 3 — the timeout activation's audit row is written verified (checked, retried, dead-lettered)", () => {
  const activation = () => st.writes.filter((w) => w.table === "document_review_signoffs" && w.op === "update");

  it("lands first time: ONE insert of the system-actor row (user_id NULL, actor_kind system, the cause) signed as DEC-87 §2's machine row (system:review-timeout, role system), under an id; no dead letter", async () => {
    seedSignoff();
    const r = await activateAlternate({ orgId: "o1", documentId: "d1", libraryId: "L", signoffId: "s2", actorId: null, cause: CAUSE });
    expect(r).toMatchObject({ reviewerUserId: "alt", noticeLanded: true, auditRecorded: true });
    expect(st.auditInserts).toHaveLength(1);
    expect(st.auditInserts[0]).toMatchObject({
      action: "REVIEW_ALTERNATE_ACTIVATED", resource_type: "document", resource_id: "d1", org_id: "o1",
      user_id: null, user_email: "system:review-timeout", user_role: "system",
      details: { signoffId: "s2", cause: CAUSE }, metadata: { actor_kind: "system" },
    });
    expect(typeof st.auditInserts[0].id).toBe("string");
    expect(st.deadLetters).toEqual([]);
    expect(st.logged).toEqual([]); // not the best-effort path any more
  });

  it("a refused first attempt is retried once under the SAME id and lands; a 23505 on the retry counts as landed (never a second row)", async () => {
    seedSignoff();
    st.auditAnswers = [{ code: "57014", message: "canceling statement due to statement timeout" }, null];
    const t0 = Date.now();
    const r = await activateAlternate({ orgId: "o1", documentId: "d1", libraryId: "L", signoffId: "s2", actorId: null, cause: CAUSE });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(ACTIVATION_AUDIT_RETRY_MS - 20);
    expect(r?.auditRecorded).toBe(true);
    expect(st.auditInserts).toHaveLength(2);
    expect(st.auditInserts[1].id).toBe(st.auditInserts[0].id);
    expect(st.deadLetters).toEqual([]);

    seedSignoff(); st.auditInserts = [];
    st.auditAnswers = [{ message: "fetch failed" }, { code: "23505", message: "duplicate key value violates unique constraint \"audit_logs_pkey\"" }];
    const r2 = await activateAlternate({ orgId: "o1", documentId: "d1", libraryId: "L", signoffId: "s2", actorId: null, cause: CAUSE });
    expect(r2?.auditRecorded).toBe(true);
    expect(st.deadLetters).toEqual([]);
  });

  it("both attempts refused: the row (as sent, no id) is dead-lettered to the EVID-6 outbox with the error, and said; REGRESSION — the alternate is activated and told exactly as when the row lands", async () => {
    seedSignoff();
    st.auditAnswers = [{ code: "42501", message: "permission denied" }, { code: "42501", message: "permission denied" }];
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await activateAlternate({ orgId: "o1", documentId: "d1", libraryId: "L", signoffId: "s2", actorId: null, cause: CAUSE });
    expect(r).toMatchObject({ reviewerUserId: "alt", revisionLabel: "C", noticeLanded: true, notificationId: "bell-1", auditRecorded: false });
    expect(st.deadLetters).toHaveLength(1);
    expect(st.deadLetters[0].error).toBe("permission denied");
    expect(st.deadLetters[0].row).toMatchObject({ action: "REVIEW_ALTERNATE_ACTIVATED", user_id: null, details: { signoffId: "s2", cause: CAUSE } });
    expect("id" in st.deadLetters[0].row).toBe(false);
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/kept in the audit dead-letter outbox/);
    err.mockRestore();
    // who and when: the one sign-off update, activated + notified_at, before the audit row
    expect(activation()).toHaveLength(1);
    expect(activation()[0].payload).toMatchObject({ activated: true });
    expect(typeof (activation()[0].payload as Row).notified_at).toBe("string");
  });

  it("REGRESSION: the MANUAL activation (no cause, a person) writes its row through logAuditAction exactly as before — no verified path, no dead letter", async () => {
    seedSignoff();
    const r = await activateAlternate({ orgId: "o1", documentId: "d1", libraryId: "L", signoffId: "s2", actorId: "ctl" });
    expect(r?.auditRecorded).toBe(true);
    expect(st.auditInserts).toEqual([]);
    expect(st.logged).toEqual([expect.objectContaining({ action: "REVIEW_ALTERNATE_ACTIVATED", userId: "ctl", details: { signoffId: "s2" } })]);
  });

  it("a sign-off that matched no row activates nothing and writes no row (as before)", async () => {
    st.rows.document_review_signoffs = [];
    expect(await activateAlternate({ orgId: "o1", documentId: "d1", libraryId: "L", signoffId: "nope", actorId: null, cause: CAUSE })).toBeNull();
    expect(st.auditInserts).toEqual([]);
  });

  it("source pin: the scan still passes the cause and actor null; the verified write runs only for the system's activation", () => {
    const rc = readFileSync(join(process.cwd(), "lib/reviewControl.ts"), "utf8");
    expect(rc).toContain('orgId, documentId: r.document_id as string, libraryId: doc.library_id as string, signoffId: r.id as string, actorId: null,\n          cause: { reason: "review_timeout", timeoutDays, ageDays, documentVersionId: (r.document_version_id as string | null) ?? null },');
    expect(rc).toContain("if (input.cause && !input.actorId) {");
    expect(rc.indexOf('.update({ activated: true, notified_at: new Date().toISOString(), updated_at: new Date().toISOString() })')).toBeLessThan(rc.indexOf("auditRecorded = (await writeActivationAuditVerified({"));
  });
});

// ── PROJ-1 ───────────────────────────────────────────────────────────────────

function seedReview(relatedTicket: string | null) {
  st.rows = {
    documents: [{ id: "d1", library_id: "l1", rev: "1", status: "Issued", current_version_id: "v1", pending_version_id: "v2", document_number: "P-101" }],
    document_versions: [
      { id: "v1", record_id: "d1", revision_label: "1" },
      { id: "v2", record_id: "d1", revision_label: "2A", base_rev: "2", review_state: "in_review", supersedes_version_id: "v1", effective_date: null, related_ticket_id: relatedTicket },
    ],
    document_review_signoffs: [],
  };
}
const fin = (extra: Record<string, unknown> = {}) => finalizeReviewedRevision({ orgId: "o1", documentId: "d1", actorId: "ctl1", actorName: "ctl@example.com", requireRosterComplete: false, ...extra });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("PROJ-1 — the review completion references a request's deliverable on its project (started, never awaited)", () => {
  it("REGRESSION: a version no request produced publishes exactly as before and the route is never asked", async () => {
    seedReview(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await fin()).toEqual({ published: true });
    await settle(); await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a request's version: the publish answers {published: true} BEFORE a never-answering route — then the route is asked with the document and the promoted version, as the finalizer", async () => {
    seedReview("t1");
    const fetchSpy = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await fin()).toEqual({ published: true });
    for (let i = 0; i < 5 && fetchSpy.mock.calls.length === 0; i++) await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DELIVERABLE_REFERENCE_ROUTE);
    expect(JSON.parse(String(init.body))).toEqual({ orgId: "o1", documentId: "d1", versionId: "v2" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("a reference not written is SAID to onProjectReferenceNote (the route's warning) — the publish's answer is unchanged", async () => {
    seedReview("t1");
    const notes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, referenced: false, warning: "only the project's managers …" }), { status: 200 })));
    expect(await fin({ onProjectReferenceNote: (n: string) => notes.push(n) })).toEqual({ published: true });
    for (let i = 0; i < 10 && notes.length === 0; i++) await settle();
    expect(notes).toEqual(["only the project's managers …"]);
  });

  it("source pin: started with `void` after the publish's audit row, never awaited; the review's other steps are unchanged", () => {
    const rc = readFileSync(join(process.cwd(), "lib/reviewControl.ts"), "utf8");
    expect(rc).toContain("  void referenceReviewedRequestDeliverable({\n    orgId: input.orgId, documentId: input.documentId, versionId: pendingId, onNote: input.onProjectReferenceNote,\n  });");
    expect(rc.indexOf('action: "REVISION_PUBLISHED_AFTER_REVIEW"')).toBeLessThan(rc.indexOf("void referenceReviewedRequestDeliverable({"));
    expect(rc).not.toContain("await referenceReviewedRequestDeliverable(");
  });
});

describe("PROJ-1 — lib/reviewDeliverableReference.ts (never throws; retry once; said)", () => {
  it("no related request: no call", async () => {
    seedReview(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await referenceReviewedRequestDeliverable({ orgId: "o1", documentId: "d1", versionId: "v2" })).toEqual({ kind: "not_from_request" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a 503 is retried once and its answer returned; a second success is not retried again", async () => {
    vi.useFakeTimers();
    seedReview("t1");
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "refused" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, referenced: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const p = referenceReviewedRequestDeliverable({ orgId: "o1", documentId: "d1", versionId: "v2", onNote: () => undefined });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await p).toEqual({ kind: "answered", answer: { ok: true, referenced: true } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("an unreachable route twice: said once, never thrown", async () => {
    vi.useFakeTimers();
    seedReview("t1");
    const notes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Failed to fetch"); }));
    const p = referenceReviewedRequestDeliverable({ orgId: "o1", documentId: "d1", versionId: "v2", onNote: (n) => notes.push(n) });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await p).toEqual({ kind: "unreachable", error: "Failed to fetch" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/could not be reached .*Failed to fetch.*Documents card/);
  });

  it("no signed-in session: said, no call", async () => {
    seedReview("t1");
    st.session = null;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const notes: string[] = [];
    expect((await referenceReviewedRequestDeliverable({ orgId: "o1", documentId: "d1", versionId: "v2", onNote: (n) => notes.push(n) })).kind).toBe("unreachable");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notes).toHaveLength(1);
  });
});
