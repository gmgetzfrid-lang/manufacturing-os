// projects-tab SAF-18 — the J15 checked-write sweep, batch J15a, part 3 of 3:
// the compliance clocks and rosters (read-&-understood, review sign-off,
// review cycles, effective dates, retention) and the retirement's share
// revoke / label sync in lib/revisions.ts.
//
// Each converted site: a zero-row match is reported (class a: the typed
// refusal, no audit row or notice claims it; class b: logged or collected,
// never fails the act — the scans' watermarks above all) or stays a no-op
// success (class c: a roster with nothing to void), and the success path is
// the same write, the same filters, the same follow-on rows as before.
// (The finalize's three-step promote and the submission's compare-and-set
// are driven in dcRoundFReviewGate / dcRoundFOwnerStamp.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Op = { m: string; args: unknown[] };
type Call = { table: string; ops: Op[] };
const h = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; ops: Array<{ m: string; args: unknown[] }> }>,
  /** `${table}:${kind}` → an answer, or a function of the call. A write with
   *  no answer set matches one row (PostgREST's RETURNING); a read answers
   *  nothing. */
  answers: {} as Record<string, unknown>,
}));
vi.mock("@/lib/supabase", () => {
  const WRITES = ["update", "delete", "insert", "upsert"];
  const kind = (ops: Array<{ m: string }>) => WRITES.find((k) => ops.some((o) => o.m === k)) ?? "select";
  const answer = (call: { table: string; ops: Array<{ m: string; args: unknown[] }> }) => {
    const a = h.answers[`${call.table}:${kind(call.ops)}`];
    const v = typeof a === "function" ? (a as (c: typeof call) => unknown)(call) : a;
    if (v !== undefined) return v;
    return kind(call.ops) === "select" ? { data: null, error: null } : { data: [{ id: "row-1" }], error: null };
  };
  const chain = (table: string) => {
    const call = { table, ops: [] as Array<{ m: string; args: unknown[] }> };
    h.calls.push(call);
    const p: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(() => answer(call)).then(res, rej);
        return (...args: unknown[]) => { call.ops.push({ m: String(prop), args }); return p; };
      },
    });
    return p;
  };
  const channel = { send: async () => "ok", httpSend: async () => ({ success: true }) };
  return {
    supabase: {
      from: (t: string) => chain(t),
      getChannels: () => [],
      channel: () => channel,
      removeChannel: async () => "ok",
      auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }) },
    },
  };
});
const NONE = { data: [], error: null };
const writes = (table?: string) => h.calls.filter((c) => (!table || c.table === table) && c.ops.some((o) => ["update", "delete", "insert", "upsert"].includes(o.m)));
const opsOf = (c: Call) => c.ops.map((o) => `${o.m}(${o.args.map((a) => typeof a === "string" ? JSON.stringify(a) : Array.isArray(a) ? `[${a.join(",")}]` : typeof a === "object" && a !== null ? "{…}" : String(a)).join(", ")})`).join(".");

const k = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  revisionEvents: [] as Array<Record<string, unknown>>,
  notices: [] as Array<{ kind: string; userId: string }>,
}));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<typeof import("@/lib/audit")>()),
  logAuditAction: vi.fn(async (e: Record<string, unknown>) => { k.audits.push(e); return { error: null }; }),
  logRevisionEvent: vi.fn(async (e: Record<string, unknown>) => { k.revisionEvents.push(e); }),
  logHoldEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/complianceNotify", async (orig) => ({
  ...(await orig<typeof import("@/lib/complianceNotify")>()),
  notifyCompliance: vi.fn(async (n: { kind: string; userId: string }) => { k.notices.push({ kind: n.kind, userId: n.userId }); return true; }),
  loadScanRetryPlan: vi.fn(async () => ({ unreadable: false, has: () => false, only: () => () => true })),
}));
vi.mock("@/lib/notify/dispatch", async (orig) => ({ ...(await orig<typeof import("@/lib/notify/dispatch")>()), pushAfterBellRows: vi.fn(async () => undefined) }));
vi.mock("@/lib/inAppNotifications", async (orig) => ({ ...(await orig<typeof import("@/lib/inAppNotifications")>()), notify: vi.fn(async () => true) }));
vi.mock("@/lib/eSignatures", () => ({ recordSignature: vi.fn(async () => ({ id: "sig1" })) }));
vi.mock("@/lib/ownership", async (orig) => ({
  ...(await orig<typeof import("@/lib/ownership")>()),
  effectiveOwnerForDocument: vi.fn(async () => ({ userId: "owner1", name: "Owner" })),
  getOrgControllers: vi.fn(async () => ["ctl1"]),
  teamSupervisorMap: vi.fn(async () => new Map()),
  isEffectiveOwnerOfDocument: vi.fn(async () => false),
}));
vi.mock("@/lib/principal", () => ({ resolveActorPrincipal: vi.fn(async (i: { uid: string }) => ({ uid: i.uid, role: "Admin", roles: ["Admin"], orgId: "o1", teamIds: [], isActiveMember: true })) }));
vi.mock("@/lib/documentGuards", async (orig) => ({ ...(await orig<typeof import("@/lib/documentGuards")>()), resolveCanControlLibrary: vi.fn(async () => true) }));
vi.mock("@/lib/holdGate", async (orig) => ({ ...(await orig<typeof import("@/lib/holdGate")>()), assertNotOnHold: vi.fn(async () => undefined) }));

import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";
import { waiveAcknowledgment, nudgeAcknowledgment, scanAndNotifyAcks, recomputeDocumentAck, recordAcknowledgment } from "@/lib/acknowledgments";
import { invalidateDraftSignoffs, activateAlternate, openReviewRoster, scanReviews } from "@/lib/reviewControl";
import { markReviewed, onDocumentIssued, scanAndNotifyReviews } from "@/lib/reviewCycles";
import { applyEffectiveDate, scanEffectiveDates } from "@/lib/effectiveDate";
import { recomputeRetention, scanRetention } from "@/lib/retention";
import { revokeLiveSharesForDocument, correctRevisionLabel } from "@/lib/revisions";
import type { DocumentRecord } from "@/types/schema";

const warned = (re: RegExp) => warn.mock.calls.some((c: unknown[]) => re.test(String(c[0])));
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.calls.length = 0;
  h.answers = {};
  k.audits.length = 0; k.revisionEvents.length = 0; k.notices.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { warn.mockRestore(); });
const NOW = () => new Date().toISOString();

describe("lib/acknowledgments.ts", () => {
  it("waiveAcknowledgment (class a; before J15a wholly unchecked): zero rows refuses — no ACK_WAIVED row, no completion read or notice", async () => {
    const waive = () => waiveAcknowledgment({ orgId: "o1", rosterId: "r1", documentId: "d1", reason: "left the role", actorId: "ctl1" });
    h.answers["document_acknowledgments:update"] = NONE;
    await expect(waive()).rejects.toThrow(`The acknowledgment was not waived. ${CHECKED_WRITE_REFUSED}`);
    expect(k.audits).toEqual([]);
    expect(h.calls).toHaveLength(1);
    h.calls.length = 0;
    h.answers = { "document_acknowledgments:select": { data: null, error: null, count: 2 } };
    await waive();
    expect(writes().map(opsOf)).toEqual(['update({…}).eq("id", "r1").select("id")']);
    expect(writes()[0].ops[0].args[0]).toMatchObject({ status: "waived", waived_by: "ctl1", waived_reason: "left the role" });
    expect(k.audits.map((a) => a.action)).toEqual(["ACK_WAIVED"]);
  });
  it("nudgeAcknowledgment (class b): a re-send whose watermark did not land is said; the reminder and its record stand", async () => {
    h.answers["document_acknowledgments:select"] = { data: { document_id: "d1", assignee_user_id: "u1", revision_label: "2" }, error: null };
    h.answers["documents:select"] = { data: { library_id: "L", document_number: "P-1" }, error: null };
    h.answers["document_acknowledgments:update"] = NONE;
    await expect(nudgeAcknowledgment({ orgId: "o1", rosterId: "r1" })).resolves.toBeUndefined();
    expect(k.notices.map((n) => n.kind)).toEqual(["ack_requested"]);
    expect(warned(/the re-send was sent, but its watermark \(notified_at\) was not stamped/)).toBe(true);
    expect(writes("document_acknowledgments").map(opsOf)).toEqual(['update({…}).eq("id", "r1").select("id")']);
  });
  it("scanAndNotifyAcks (class b): a watermark that did not land is said and the scan goes on; a landed one is quiet", async () => {
    h.answers["document_acknowledgments:select"] = { data: [{ id: "r1", document_id: "d1", document_version_id: "v1", assignee_user_id: "u1", assignee_name: "Una", revision_label: "2", notified_at: null, assigned_at: NOW() }], error: null };
    h.answers["documents:select"] = { data: [{ id: "d1", library_id: "L", document_number: "P-1" }], error: null };
    expect(await scanAndNotifyAcks("o1")).toBe(1);
    expect(writes("document_acknowledgments").map(opsOf)).toEqual(['update({…}).eq("id", "r1").select("id")']);
    expect(warned(/watermark/)).toBe(false);
    h.answers["document_acknowledgments:update"] = NONE;
    expect(await scanAndNotifyAcks("o1")).toBe(1);
    expect(warned(/scan: the reminder watermark of roster row r1 was not stamped/)).toBe(true);
  });
  it("recomputeDocumentAck (class c): nothing to void is a success; a void that errs is reported in the database's words", async () => {
    h.answers["documents:select"] = { data: { id: "d1", org_id: "o1", library_id: "L", collection_id: null, status: "Issued", current_version_id: "v2", ack_policy: null }, error: null };
    h.answers["libraries:select"] = { data: { ack_policy: null }, error: null };
    h.answers["document_acknowledgments:update"] = NONE;
    const errs: string[] = [];
    await recomputeDocumentAck({ orgId: "o1", documentId: "d1", writeErrors: errs });
    expect(errs).toEqual([]);
    expect(writes("document_acknowledgments").map(opsOf)).toEqual([
      'update({…}).eq("document_id", "d1").eq("status", "pending").not("document_version_id", "eq", "v2").select("id")',
      'update({…}).eq("document_id", "d1").eq("status", "pending").select("id")',
    ]);
    h.answers["document_acknowledgments:update"] = { data: null, error: { code: "42501", message: "permission denied for table document_acknowledgments" } };
    await recomputeDocumentAck({ orgId: "o1", documentId: "d1", writeErrors: errs });
    expect(errs).toEqual([
      "the acknowledgment rows of an older revision could not be voided (permission denied for table document_acknowledgments)",
      "the pending acknowledgment rows could not be voided (permission denied for table document_acknowledgments)",
    ]);
  });
  it("recordAcknowledgment: the roster scope is the same filters in the same order, read back in one statement", async () => {
    const sign = (over: Record<string, unknown>) => recordAcknowledgment({ orgId: "o1", documentId: "d1", signerUserId: "u1", signerName: "Una", statement: "read", ...over } as Parameters<typeof recordAcknowledgment>[0]);
    h.answers["document_acknowledgments:select"] = { data: null, error: null, count: 1 };
    await sign({ rosterId: "r1" });
    await sign({ documentVersionId: "v1" });
    await sign({});
    expect(writes("document_acknowledgments").map(opsOf)).toEqual([
      'update({…}).eq("assignee_user_id", "u1").eq("status", "pending").eq("id", "r1").select("id")',
      'update({…}).eq("assignee_user_id", "u1").eq("status", "pending").eq("document_id", "d1").eq("document_version_id", "v1").select("id")',
      'update({…}).eq("assignee_user_id", "u1").eq("status", "pending").eq("document_id", "d1").select("id")',
    ]);
    h.answers["document_acknowledgments:update"] = NONE;
    await expect(sign({ rosterId: "r1" })).rejects.toThrow(/there was no pending acknowledgment of yours to mark/);
  });
});

describe("lib/reviewControl.ts", () => {
  const signed = { data: [{ id: "s1", reviewer_user_id: "rev1", status: "signed" }, { id: "s2", reviewer_user_id: "rev2", status: "signed" }], error: null };
  const invalidate = () => invalidateDraftSignoffs({ orgId: "o1", documentId: "d1", libraryId: "L", oldVersionId: "v2A", newRevisionLabel: "2B" });
  it("invalidateDraftSignoffs: each signer whose sign-off was voided is told, as before", async () => {
    h.answers["document_review_signoffs:select"] = signed;
    h.answers["document_review_signoffs:update"] = { data: [{ id: "s1" }, { id: "s2" }, { id: "p3" }], error: null };
    await invalidate();
    expect(k.notices.map((n) => [n.kind, n.userId])).toEqual([["review_invalidated", "rev1"], ["review_invalidated", "rev2"]]);
    expect(writes().map(opsOf)).toEqual(['update({…}).eq("document_id", "d1").eq("document_version_id", "v2A").in("status", [pending,signed]).select("id")']);
  });
  it("invalidateDraftSignoffs: a void that failed or matched no row tells NOBODY their sign-off was voided (the defect before J15a)", async () => {
    h.answers["document_review_signoffs:select"] = signed;
    h.answers["document_review_signoffs:update"] = NONE;
    await invalidate();
    expect(k.notices).toEqual([]);
    expect(warned(/2 signed sign-off\(s\) of the prior draft were not voided/)).toBe(true);
    h.answers["document_review_signoffs:update"] = { data: null, error: { message: "permission denied" } };
    await invalidate();
    expect(k.notices).toEqual([]);
    expect(warn.mock.calls.some((c: unknown[]) => /invalidating prior draft's sign-offs failed/.test(String(c[0])) && c[1] === "permission denied")).toBe(true);
  });
  it("activateAlternate (class a): the manual activation that matched no row throws — no notice, no audit; the scan's answers null as before", async () => {
    h.answers["document_review_signoffs:update"] = { data: null, error: null };
    await expect(activateAlternate({ orgId: "o1", documentId: "d1", libraryId: "L", signoffId: "a1", actorId: "ctl1" })).rejects.toThrow(`The alternate was not activated. ${CHECKED_WRITE_REFUSED}`);
    expect(k.notices).toEqual([]);
    expect(k.audits).toEqual([]);
    expect(await activateAlternate({ orgId: "o1", documentId: "d1", libraryId: "L", signoffId: "a1", actorId: null, cause: { reason: "review_timeout", timeoutDays: 7, ageDays: 9, documentVersionId: "v2A" } })).toBeNull();
    h.answers["document_review_signoffs:update"] = { data: { reviewer_user_id: "alt1", revision_label: "2A" }, error: null };
    const r = await activateAlternate({ orgId: "o1", documentId: "d1", libraryId: "L", signoffId: "a1", actorId: "ctl1" });
    expect(r).toMatchObject({ reviewerUserId: "alt1", revisionLabel: "2A", noticeLanded: true });
    expect(k.audits.map((a) => a.action)).toEqual(["REVIEW_ALTERNATE_ACTIVATED"]);
  });
  const roster = () => openReviewRoster({ orgId: "o1", documentId: "d1", libraryId: "L", versionId: "v2A", revisionLabel: "2A", contentHash: "h", control: { mode: "require", reviewerIds: ["rev1"] }, actorId: "pub1", actorName: "Pat" });
  const failRoster = () => {
    h.answers["org_members:select"] = { data: [{ uid: "rev1", display_name: "Rita", email: "r@x", status: "active", role: "Engineer", roles: ["Engineer"] }], error: null };
    h.answers["document_review_signoffs:upsert"] = { data: null, error: { message: "new row violates row-level security policy" } };
  };
  it("a stranded submission is withdrawn exactly as before when both writes land", async () => {
    failRoster();
    h.answers["documents:select"] = { data: { library_id: "L", pending_version_id: "v2A" }, error: null };
    await expect(roster()).rejects.toThrow(/The submission was withdrawn: nothing is in review/);
    expect(writes("documents").map(opsOf)).toEqual(['update({…}).eq("id", "d1").eq("pending_version_id", "v2A").select("id")']);
    expect(writes("document_versions").map(opsOf)).toEqual(['update({…}).eq("id", "v2A").select("id")']);
  });
  it("withdrawStrandedSubmission: a pointer still on the draft that matched no row, and a retire that matched none, are said — never 'withdrawn'", async () => {
    failRoster();
    h.answers["documents:select"] = { data: { library_id: "L", pending_version_id: "v2A" }, error: null };
    h.answers["documents:update"] = NONE;
    h.answers["document_versions:update"] = NONE;
    await expect(roster()).rejects.toThrow("The submission could NOT be fully withdrawn — the pending pointer could not be released (the write was refused); the draft could not be retired (the write was refused) — a document controller must clear the stranded draft.");
    expect(k.audits.find((a) => a.action === "REVIEW_ROSTER_FAILED")?.details).toMatchObject({ withdrawn: false });
  });
  it("withdrawStrandedSubmission: the CAS matching no row because the pointer already moved is legitimate (re-read)", async () => {
    failRoster();
    h.answers["documents:select"] = { data: { library_id: "L", pending_version_id: "v9Z" }, error: null };
    h.answers["documents:update"] = NONE;
    await expect(roster()).rejects.toThrow(/The submission was withdrawn: nothing is in review/);
  });
  it("scanReviews (class b): a reminder watermark that did not land is said and the scan goes on", async () => {
    h.answers["document_review_signoffs:select"] = { data: [{ id: "s1", document_id: "d1", document_version_id: "v2A", reviewer_user_id: "rev1", reviewer_name: "Rita", revision_label: "2A", slot: "primary", activated: true, notified_at: null, assigned_at: NOW() }], error: null };
    h.answers["documents:select"] = { data: [{ id: "d1", library_id: "L", collection_id: null, review_control: null }], error: null };
    expect(await scanReviews("o1")).toBe(1);
    expect(writes("document_review_signoffs").map(opsOf)).toEqual(['update({…}).eq("id", "s1").select("id")']);
    expect(warned(/watermark/)).toBe(false);
    h.answers["document_review_signoffs:update"] = NONE;
    expect(await scanReviews("o1")).toBe(1);
    expect(warned(/scan: the reminder watermark of sign-off s1 was not stamped/)).toBe(true);
  });
});

describe("lib/reviewCycles.ts", () => {
  const docRow = { data: { id: "d1", library_id: "L", collection_id: null, review_policy: null, last_reviewed_at: null, updated_at: null, created_at: "2026-01-01T00:00:00Z" }, error: null };
  it("markReviewed (class a; before J15a unchecked): zero rows refuses — no recompute write, no certification event", async () => {
    h.answers["documents:update"] = NONE;
    await expect(markReviewed({ orgId: "o1", documentId: "d1", userId: "u1" })).rejects.toThrow(`The review was not recorded. ${CHECKED_WRITE_REFUSED}`);
    expect(writes()).toHaveLength(1);
    h.calls.length = 0;
    h.answers = { "documents:select": docRow, "libraries:select": { data: { review_policy: null }, error: null } };
    await markReviewed({ orgId: "o1", documentId: "d1", userId: "u1", outcome: "needs_revision" });
    expect(writes().map((c) => `${c.table}:${opsOf(c)}`)).toEqual([
      'documents:update({…}).eq("id", "d1").select("id")',
      'documents:update({…}).eq("id", "d1").select("id")',
      "document_review_events:insert({…})",
    ]);
    expect(writes()[0].ops[0].args[0]).toEqual({ last_reviewed_by: "u1", review_notified_at: null });
  });
  it("onDocumentIssued (class b): both clock writes matching no row are reported (and logged); the issue stands", async () => {
    h.answers = { "documents:select": docRow, "libraries:select": { data: { review_policy: null }, error: null }, "documents:update": NONE };
    const errs: string[] = [];
    await expect(onDocumentIssued({ orgId: "o1", documentId: "d1", userId: "u1", writeErrors: errs })).resolves.toBeUndefined();
    expect(errs).toEqual([
      "the review clock could not be reset to this issue (the write was refused)",
      "the next review date could not be saved (the write was refused)",
    ]);
    expect(warned(/review clock could not be reset/)).toBe(true);
  });
  it("scanAndNotifyReviews (class b): a watermark that did not land is said and the scan goes on", async () => {
    h.answers["documents:select"] = { data: [{ id: "d1", library_id: "L", collection_id: null, document_number: "P-1", review_policy: null, next_review_date: "2026-01-01", review_notified_at: null, owner_user_id: null, owner_name: null }], error: null };
    h.answers["org_members:select"] = { data: [{ uid: "ctl1", role: "DocCtrl" }], error: null };
    expect(await scanAndNotifyReviews("o1")).toBe(1);
    expect(writes("documents").map(opsOf)).toEqual(['update({…}).eq("id", "d1").select("id")']);
    h.answers["documents:update"] = NONE;
    expect(await scanAndNotifyReviews("o1")).toBe(1);
    expect(warned(/scan: the review-due watermark of d1 was not stamped/)).toBe(true);
  });
});

describe("lib/effectiveDate.ts", () => {
  it("applyEffectiveDate: both writes still run as before; either matching no row then refuses (its callers catch it)", async () => {
    await expect(applyEffectiveDate({ documentId: "d1", versionId: "v1", effectiveDate: null })).resolves.toBeUndefined();
    h.answers["document_versions:update"] = NONE;
    await expect(applyEffectiveDate({ documentId: "d1", versionId: "v1", effectiveDate: null })).rejects.toThrow("The effective date was not saved on the revision (the write was refused).");
    expect(writes().map((c) => c.table)).toEqual(["document_versions", "documents", "document_versions", "documents"]);
    h.answers = { "documents:update": NONE };
    await expect(applyEffectiveDate({ documentId: "d1", versionId: "v1", effectiveDate: null })).rejects.toThrow("The effective date was not saved on the document (the write was refused).");
  });
  it("scanEffectiveDates (class b): a watermark that did not land is said; a stale date whose silencing matched no row is said too", async () => {
    h.answers["documents:select"] = { data: [{ id: "d1", library_id: "L", effective_date: "2026-01-01", current_version_id: "v1" }], error: null };
    h.answers["document_versions:select"] = { data: [{ id: "v1", effective_date: "2026-01-01" }], error: null };
    expect(await scanEffectiveDates("o1")).toBe(1);
    expect(writes("documents").map(opsOf)).toEqual(['update({…}).eq("id", "d1").select("id")']);
    h.answers["documents:update"] = NONE;
    expect(await scanEffectiveDates("o1")).toBe(1);
    expect(warned(/scan: the "now in effect" watermark of d1 was not stamped/)).toBe(true);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      h.answers["document_versions:select"] = { data: [{ id: "v1", effective_date: "2027-06-01" }], error: null };
      expect(await scanEffectiveDates("o1")).toBe(0);
      expect(err.mock.calls.some((c: unknown[]) => /could not silence a stale effective date on d1: the write was refused/.test(String(c[0])))).toBe(true);
    } finally { err.mockRestore(); }
  });
});

describe("lib/retention.ts (RET-5's checked writes now read their matched row)", () => {
  it("recomputeRetention: a re-clock that matched no row refuses — never a stale deadline read as current", async () => {
    h.answers["documents:select"] = { data: { id: "d1", retention_policy: { enabled: true, years: 7, basis: "created" }, collection_id: null, library_id: "L", created_at: "2020-01-01T00:00:00Z", updated_at: null, effective_date: null, disposition_state: null }, error: null };
    await expect(recomputeRetention("d1")).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual(['update({…}).eq("id", "d1").select("id")']);
    h.answers["documents:update"] = NONE;
    await expect(recomputeRetention("d1")).rejects.toThrow("Retention clock was NOT updated: the write was refused.");
    h.answers["documents:select"] = { data: { id: "d1", retention_policy: { enabled: false }, collection_id: null, library_id: "L", disposition_state: null }, error: null };
    h.answers["libraries:select"] = { data: { retention_policy: null }, error: null };
    await expect(recomputeRetention("d1")).rejects.toThrow("Retention clock was NOT cleared: the write was refused.");
  });
  it("scanRetention: a flag that matched no row is skipped (no notice) and reported", async () => {
    h.answers["documents:select"] = { data: [{ id: "d1", library_id: "L", collection_id: null, document_number: "P-1", retention_until: "2020-01-01", retention_policy: null, retention_notified_at: null }], error: null };
    h.answers["documents:update"] = NONE;
    await expect(scanRetention("o1")).rejects.toThrow("Retention scan flagged 0 record(s) but 1 flag write(s) were refused — d1: the write was refused");
    expect(k.notices).toEqual([]);
  });
});

describe("lib/revisions.ts — the retirement's share revoke (class c) and the label sync (class a)", () => {
  it("revokeLiveSharesForDocument: no live link is revoked: 0 — a success; each revoked link is audited, as before", async () => {
    h.answers["document_shares:update"] = NONE;
    expect(await revokeLiveSharesForDocument("d1", "u1")).toMatchObject({ revoked: 0, error: null });
    expect(k.audits).toEqual([]);
    h.answers["document_shares:update"] = { data: [{ id: "s1", org_id: "o1" }, { id: "s2", org_id: "o1" }], error: null };
    expect(await revokeLiveSharesForDocument("d1", "u1")).toMatchObject({ revoked: 2, error: null });
    expect(k.audits.map((a) => (a.details as { shareId: string }).shareId)).toEqual(["s1", "s2"]);
    h.answers["document_shares:update"] = { data: null, error: { message: "permission denied for table document_shares" } };
    expect(await revokeLiveSharesForDocument("d1", "u1")).toMatchObject({ revoked: 0, error: "permission denied for table document_shares" });
  });
  it("correctRevisionLabel: a document-row sync that matched no row throws the sync sentence — no REV_LABEL_CORRECTED claims it synced", async () => {
    const doc = { id: "d1", currentVersionId: "v1" } as DocumentRecord;
    const input = { doc, versionId: "v1", newLabel: "1B", reason: "typo", libraryId: "L", orgId: "o1", actorUserId: "u1" };
    h.answers["document_versions:select"] = { data: [{ id: "v1", revision_label: "1A", review_state: null }], error: null };
    h.answers["documents:select"] = { data: { pending_version_id: null }, error: null };
    h.answers["documents:update"] = NONE;
    await expect(correctRevisionLabel(input)).rejects.toThrow("The revision was corrected, but the document row failed to sync: the write was refused. Re-run the correction or fix the document label via Metadata.");
    expect(k.revisionEvents).toEqual([]);
    h.answers["documents:update"] = { data: [{ id: "d1" }], error: null };
    expect(await correctRevisionLabel(input)).toEqual({ oldLabel: "1A", newLabel: "1B", syncedCurrent: true });
    expect(k.revisionEvents.map((e) => e.type)).toEqual(["REV_LABEL_CORRECTED"]);
    expect(writes("documents").at(-1)!.ops.map((o) => o.m)).toEqual(["update", "eq", "select"]);
  });
});
