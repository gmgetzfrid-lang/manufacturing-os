// Document-control Round F — P6 CHECKOUT: the lock, force-release, the
// check-in register and the sweep, driven end-to-end through the lib against
// a recording supabase mock (vi.hoisted state + a Proxy chain, the
// sweepRoundD3 pattern).
//
//   DCK-4  a FAILED lock-claim write is not "you joined": the session is rolled
//          back and the caller is told the checkout did not complete. A
//          filtered write (the RESTRICTIVE documents_deny_write_guard) answers
//          with NO error, so a no-row claim is settled by re-reading the holder
//   DCK-5  forceReleaseDocument writes the FORCE_RELEASE audit row itself,
//          AFTER the RPC succeeded, with the reason; a refusal records nothing;
//          a refused audit insert after a real release is reported, not silent
//   DCK-7  the browser sweep is scoped to the caller's own sessions, the
//          notifications/audit rows come from the rows the UPDATE changed,
//          and a refused sweep THROWS instead of console.warn
//   DCK-9  the project release records an outcome per session and a CHECK_IN
//          per document, and its write is checked; the sweep writes CHECK_IN
//   DCK-11 the episode-schema latch is time-boxed and loud
//   DCK-14 an episode is not sealed over a session that joined after the
//          closer's fetch — the close reconciles instead

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  /** Static rows per table (filtered by eq/in/is when read). */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** Successive results per `${table}.${op}`; shifted on each read, then falls back to rows. */
  seq: {} as Record<string, Array<Array<Record<string, unknown>>>>,
  /** Error to return for `${table}.${op}`. */
  errors: {} as Record<string, { message: string; code?: string } | undefined>,
  calls: [] as Array<{ table: string; op: string; method: string; args: unknown[] }>,
  writes: [] as Array<{ table: string; op: string; payload: unknown; filters: Array<[string, unknown]> }>,
  rpc: [] as Array<{ fn: string; args: unknown }>,
  rpcResult: { data: null as unknown, error: null as null | { message: string } },
  audits: [] as Array<Record<string, unknown>>,
  /** What the (mocked) audit writer answers — the real one returns the insert's error. */
  auditResult: { error: null as string | null },
  emits: [] as Array<Record<string, unknown>>,
  timeline: [] as string[],
  insertSeq: 0,
}));

function chain(table: string) {
  let op = "select";
  let payload: unknown = undefined;
  const filters: Array<[string, unknown]> = [];
  const matches = (r: Record<string, unknown>) =>
    filters.every(([k, v]) => {
      if (k.startsWith("in:")) return (v as unknown[]).includes(r[k.slice(3)]);
      if (k.startsWith("is:")) return r[k.slice(3)] == null;
      return r[k] === v;
    });
  // A scripted (seq) answer is returned AS-IS — it is the test saying "this
  // is what the database answered"; static rows are filtered by eq/in/is.
  const result = () => {
    const key = `${table}.${op}`;
    const queued = state.seq[key];
    if (queued && queued.length > 0) return queued.shift() as Array<Record<string, unknown>>;
    return (state.rows[table] ?? []).filter(matches);
  };
  const error = () => state.errors[`${table}.${op}`] ?? null;
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => {
          const err = error();
          if (op === "insert" || op === "update" || op === "delete") state.writes.push({ table, op, payload, filters: [...filters] });
          if (op === "insert" && !err) state.timeline.push(`insert:${table}`);
          resolve({ data: err ? null : result(), error: err });
        };
      }
      return (...args: unknown[]) => {
        state.calls.push({ table, op, method: prop, args });
        if (prop === "insert" || prop === "update" || prop === "delete") { op = prop; payload = args[0]; }
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "in") filters.push([`in:${String(args[0])}`, args[1]]);
        if (prop === "is") filters.push([`is:${String(args[0])}`, args[1]]);
        if (prop === "maybeSingle" || prop === "single") {
          const err = error();
          if (op === "insert" || op === "update" || op === "delete") state.writes.push({ table, op, payload, filters: [...filters] });
          if (err) return Promise.resolve({ data: null, error: err });
          if (op === "insert") {
            state.insertSeq += 1;
            state.timeline.push(`insert:${table}`);
            return Promise.resolve({ data: { id: `${table}-${state.insertSeq}`, ...(payload as Record<string, unknown>) }, error: null });
          }
          return Promise.resolve({ data: result()[0] ?? null, error: null });
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
    rpc: (fn: string, args: unknown) => {
      state.rpc.push({ fn, args });
      state.timeline.push(`rpc:${fn}`);
      return Promise.resolve({ data: state.rpcResult.data, error: state.rpcResult.error });
    },
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
  },
}));
vi.mock("@/lib/audit", () => ({
  logCheckoutEvent: vi.fn(async (p: Record<string, unknown>) => { state.audits.push(p); state.timeline.push(`audit:${String(p.type)}`); return { error: state.auditResult.error }; }),
  logAuditAction: vi.fn(async (p: Record<string, unknown>) => { state.audits.push(p); state.timeline.push(`audit:${String(p.action)}`); return { error: state.auditResult.error }; }),
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (p: Record<string, unknown>) => { state.emits.push(p); }) }));
vi.mock("@/lib/intents", () => ({ recordIntent: vi.fn(async () => undefined), endMyIntents: vi.fn(async () => undefined) }));

import {
  classifyLockClaim, resolveLockClaim, quickHold, forceReleaseDocument, finishMySession, getActiveEpisode,
  resetEpisodeSchemaFlag, episodeSchemaIsMissing, EPISODE_SCHEMA_RECHECK_MS, isMissingEpisodeSchema,
} from "@/lib/checkoutEpisodes";
import { autoReleaseExpiredAdHoc, releaseAllCheckoutsForProject, transitionProjectStatus } from "@/lib/projects";
import { endMyIntents } from "@/lib/intents";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const writesTo = (table: string, op?: string) => state.writes.filter((w) => w.table === table && (!op || w.op === op));
const messages = () => writesTo("checkout_messages", "insert").map((w) => String((w.payload as { text: string }).text));

beforeEach(() => {
  state.rows = {}; state.seq = {}; state.errors = {}; state.calls = []; state.writes = [];
  state.rpc = []; state.rpcResult = { data: null, error: null }; state.audits = []; state.auditResult = { error: null }; state.emits = [];
  state.timeline = []; state.insertSeq = 0;
  vi.mocked(endMyIntents).mockClear();
  resetEpisodeSchemaFlag();
});

// ── DCK-4 ────────────────────────────────────────────────────────────────────

describe("DCK-4 — a failed lock claim is neither 'held' nor 'joined'", () => {
  it("classifyLockClaim: row → held, no row → joined, error → failed (error wins over data)", () => {
    expect(classifyLockClaim({ data: { id: "d1" }, error: null })).toBe("held");
    expect(classifyLockClaim({ data: null, error: null })).toBe("joined");
    expect(classifyLockClaim({ data: null, error: { message: "permission denied" } })).toBe("failed");
    expect(classifyLockClaim({ data: { id: "d1" }, error: { message: "x" } })).toBe("failed");
  });

  it("quickHold: a refused documents UPDATE rolls the session back, seals the episode it opened, posts no 'joined', and throws", async () => {
    state.errors["documents.update"] = { message: "new row violates row-level security policy (documents_deny_write_guard)" };
    await expect(quickHold({ orgId: "o1", documentId: "d1", libraryId: "l1", userId: "u1", userName: "ann" }))
      .rejects.toThrow(/did not complete — the lock could not be claimed: new row violates/);
    // the session we opened is ended, by id, with the honest reason
    const rollback = writesTo("checkout_sessions", "update");
    expect(rollback).toHaveLength(1);
    expect(rollback[0].payload).toMatchObject({ status: "checked_in", released_by: "u1" });
    expect(String((rollback[0].payload as { released_reason: string }).released_reason)).toMatch(/lock claim failed/);
    expect(rollback[0].filters).toContainEqual(["id", "checkout_sessions-2"]);
    // the episode THIS attempt created is sealed as 'reconciled'
    const sealed = writesTo("checkout_episodes", "update");
    expect(sealed).toHaveLength(1);
    expect(sealed[0].payload).toMatchObject({ status: "closed", close_reason: "reconciled" });
    // and nothing in the thread claims we joined anyone
    expect(messages()).toEqual([]);
    // the edit intent recorded for this session dies with it — no phantom editor
    expect(vi.mocked(endMyIntents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(endMyIntents)).toHaveBeenCalledWith({ documentId: "d1", userId: "u1", sources: ["checkout"] });
  });

  it("the modal's rollback also ends the intent: it hands the document id to abortFailedLockClaim after waiting for the intent write", () => {
    const modal = src("components/documents/CheckoutFlowModal.tsx");
    expect(modal).toMatch(/const intentWrite = recordIntent\(\{/);
    expect(modal).toMatch(/await intentWrite\.catch\(\(\) => undefined\);\s*\n\s*await abortFailedLockClaim\(\{\s*\n\s*sessionId: insertedSession\?\.id as string,\s*\n\s*documentId: document\.id!,/);
  });

  it("resolveLockClaim: a row is held and an error is failed without any re-read; a no-row/no-error claim is settled by checked_out_by", async () => {
    await expect(resolveLockClaim({ claim: { data: { id: "d1" }, error: null }, documentId: "d1", userId: "u1" })).resolves.toMatchObject({ verdict: "held" });
    await expect(resolveLockClaim({ claim: { data: null, error: { message: "permission denied" } }, documentId: "d1", userId: "u1" })).resolves.toMatchObject({ verdict: "failed", detail: "permission denied" });
    expect(state.calls.filter((c) => c.table === "documents")).toHaveLength(0);
    // another user's id in the lock column: a real holder → joined
    state.rows.documents = [{ id: "d1", checked_out_by: "other" }];
    await expect(resolveLockClaim({ claim: { data: null, error: null }, documentId: "d1", userId: "u1" })).resolves.toMatchObject({ verdict: "joined", holderId: "other" });
    // NULL: nobody holds it, so the CAS predicate matched and the write was filtered → failed
    state.rows.documents = [{ id: "d1", checked_out_by: null }];
    await expect(resolveLockClaim({ claim: { data: null, error: null }, documentId: "d1", userId: "u1" })).resolves.toMatchObject({ verdict: "failed", detail: expect.stringMatching(/refused without an error.*check your access/) });
    // the caller's OWN id: the predicate matched too → failed
    state.rows.documents = [{ id: "d1", checked_out_by: "u1" }];
    await expect(resolveLockClaim({ claim: { data: null, error: null }, documentId: "d1", userId: "u1" })).resolves.toMatchObject({ verdict: "failed" });
    // the row cannot be read at all (filtered SELECT, or an error) → failed, never joined
    state.rows.documents = [];
    await expect(resolveLockClaim({ claim: { data: null, error: null }, documentId: "d1", userId: "u1" })).resolves.toMatchObject({ verdict: "failed" });
    state.errors["documents.select"] = { message: "connection reset" };
    await expect(resolveLockClaim({ claim: { data: null, error: null }, documentId: "d1", userId: "u1" })).resolves.toMatchObject({ verdict: "failed", detail: expect.stringMatching(/could not be read: connection reset/) });
  });

  it("quickHold: the CONFIRMED mechanism — a RESTRICTIVE-policy filter (zero rows, NO error) over a free document — rolls back and throws; nothing says 'joined'", async () => {
    state.rows.documents = [{ id: "d1", checked_out_by: null }]; // nobody holds it
    state.seq["documents.update"] = [[]];                         // …yet the CAS matched nothing: filtered
    await expect(quickHold({ orgId: "o1", documentId: "d1", libraryId: "l1", userId: "u1", userName: "ann" }))
      .rejects.toThrow(/did not complete — the lock could not be claimed: the write was refused without an error/);
    const rollback = writesTo("checkout_sessions", "update");
    expect(rollback).toHaveLength(1);
    expect(rollback[0].payload).toMatchObject({ status: "checked_in", released_by: "u1" });
    expect(rollback[0].filters).toContainEqual(["id", "checkout_sessions-2"]);
    expect(writesTo("checkout_episodes", "update")[0].payload).toMatchObject({ status: "closed", close_reason: "reconciled" });
    expect(messages()).toEqual([]);
    expect(vi.mocked(endMyIntents)).toHaveBeenCalledWith({ documentId: "d1", userId: "u1", sources: ["checkout"] });
  });

  it("quickHold: no row and no error with ANOTHER user's id in checked_out_by is the genuine join", async () => {
    state.rows.checkout_episodes = [{ id: "ep-1", document_id: "d1", status: "active", org_id: "o1", seq: 3, opened_at: "2026-09-01T00:00:00Z" }];
    state.rows.documents = [{ id: "d1", checked_out_by: "other" }]; // someone else really holds it
    state.seq["documents.update"] = [[]];                              // so the CAS matched nothing
    await expect(quickHold({ orgId: "o1", documentId: "d1", libraryId: "l1", userId: "u1", userName: "ann" })).resolves.toBe("joined");
    expect(messages().some((t) => t.includes("joined via quick hold"))).toBe(true);
    expect(writesTo("checkout_sessions", "update")).toHaveLength(0);
    expect(vi.mocked(endMyIntents)).not.toHaveBeenCalled(); // a join keeps its intent
  });

  it("the modal settles its claim through the same resolveLockClaim (no bare classifyLockClaim)", () => {
    const modal = src("components/documents/CheckoutFlowModal.tsx");
    expect(modal).toMatch(/const resolved = await resolveLockClaim\(\{ claim, documentId: document\.id!, userId: currentUser\.uid \}\);/);
    expect(modal).toMatch(/if \(resolved\.verdict === "failed"\) \{/);
    expect(modal).toMatch(/could not be claimed: \$\{resolved\.detail\}/);
    expect(modal).not.toMatch(/classifyLockClaim\(/);
  });
});

// ── DCK-5 ────────────────────────────────────────────────────────────────────

describe("DCK-5 — forceReleaseDocument writes the audit row itself, after the release", () => {
  const input = { orgId: "o1", documentId: "d1", actorUserId: "ctl", actorName: "ctl", actorEmail: "ctl@x.io", actorRole: "DocCtrl", reason: "walkdown finished, drawing abandoned" };

  it("a refused RPC records NOTHING: no audit row, no thread alert, no episode close, no victim notice", async () => {
    state.rows.checkout_sessions = [{ id: "s1", user_id: "vic", user_name: "vic", started_at: "2026-09-01T00:00:00Z", document_id: "d1", status: "active" }];
    state.rpcResult = { data: null, error: { message: "You are not allowed to release another user's checkout." } };
    await expect(forceReleaseDocument(input)).rejects.toThrow(/refused — the lock was NOT cleared/);
    expect(state.audits).toEqual([]);
    expect(messages()).toEqual([]);
    expect(writesTo("checkout_episodes", "update")).toHaveLength(0);
    expect(state.emits).toEqual([]);
  });

  it("a successful RPC is followed by exactly one FORCE_RELEASE row carrying the reason, the holder, and the ended sessions", async () => {
    state.rows.checkout_sessions = [{ id: "s1", user_id: "vic", user_name: "vic", started_at: "2026-09-01T00:00:00Z", document_id: "d1", status: "active" }];
    state.rows.checkout_episodes = [{ id: "ep-1", document_id: "d1", status: "active", org_id: "o1", seq: 2, opened_at: "2026-09-01T00:00:00Z" }];
    state.rpcResult = { data: { documentId: "d1", previousHolder: "vic", endedSessions: 1 }, error: null };
    await forceReleaseDocument(input);
    // ordering: the RPC first, the audit row after it
    expect(state.timeline.indexOf("rpc:force_release_document")).toBeGreaterThanOrEqual(0);
    expect(state.timeline.indexOf("audit:FORCE_RELEASE")).toBeGreaterThan(state.timeline.indexOf("rpc:force_release_document"));
    const audit = state.audits.filter((a) => a.type === "FORCE_RELEASE");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ orgId: "o1", fileId: "d1", userId: "ctl", userEmail: "ctl@x.io", userRole: "DocCtrl" });
    expect(audit[0].details).toMatchObject({
      reason: "walkdown finished, drawing abandoned", previousHolderId: "vic", endedSessions: 1,
      releasedUsers: [{ userId: "vic", userName: "vic" }], episodeId: "ep-1", checkoutNumber: 2,
    });
    // the reason reached the RPC (→ released_reason) too
    expect(state.rpc[0].args).toMatchObject({ p_doc: "d1", p_reason: "walkdown finished, drawing abandoned" });
    // and the release itself still happens: episode sealed, alert posted, victim told
    expect(writesTo("checkout_episodes", "update")[0].payload).toMatchObject({ status: "closed", close_reason: "force_released" });
    expect(messages().some((t) => t.includes("force-released by ctl"))).toBe(true);
    expect(state.emits[0]).toMatchObject({ kind: "checkout_released", audience: { involved: ["vic"] } });
  });

  it("a successful RPC whose audit INSERT is refused: the release stands, and the caller is told the row is missing", async () => {
    state.rows.checkout_sessions = [{ id: "s1", user_id: "vic", user_name: "vic", started_at: "2026-09-01T00:00:00Z", document_id: "d1", status: "active" }];
    state.rows.checkout_episodes = [{ id: "ep-1", document_id: "d1", status: "active", org_id: "o1", seq: 2, opened_at: "2026-09-01T00:00:00Z" }];
    state.rpcResult = { data: { documentId: "d1", previousHolder: "vic", endedSessions: 1 }, error: null };
    state.auditResult = { error: "new row violates row-level security policy for table \"audit_logs\"" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(forceReleaseDocument(input)).resolves.toEqual({ auditRecorded: false, auditError: expect.stringMatching(/audit_logs/) });
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/FORCE_RELEASE audit row was refused/), expect.stringMatching(/audit_logs/));
    } finally { errSpy.mockRestore(); }
    // the act itself is not undone by a lost record: sealed, alerted, victim told
    expect(writesTo("checkout_episodes", "update")[0].payload).toMatchObject({ status: "closed", close_reason: "force_released" });
    expect(messages().some((t) => t.includes("force-released by ctl"))).toBe(true);
    expect(state.emits[0]).toMatchObject({ kind: "checkout_released" });
  });

  it("a recorded audit row answers auditRecorded: true", async () => {
    state.rpcResult = { data: { documentId: "d1", previousHolder: null, endedSessions: 0 }, error: null };
    await expect(forceReleaseDocument(input)).resolves.toEqual({ auditRecorded: true, auditError: null });
  });

  it("the real logAuditAction reads the insert's {error} instead of assuming: refused → { error }, landed → { error: null }", async () => {
    const real = await vi.importActual<typeof import("@/lib/audit")>("@/lib/audit");
    const entry = { action: "FORCE_RELEASE", resourceId: "d1", resourceType: "document", userId: "ctl" };
    await expect(real.logAuditAction(entry)).resolves.toEqual({ error: null });
    state.errors["audit_logs.insert"] = { message: "new row violates row-level security policy" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(real.logAuditAction(entry)).resolves.toEqual({ error: "new row violates row-level security policy" });
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Failed to write audit log \(FORCE_RELEASE\)/), "new row violates row-level security policy");
    } finally { errSpy.mockRestore(); }
  });

  it("both surfaces show a released-but-unrecorded outcome instead of plain success", () => {
    const cell = src("components/documents/CheckoutStatusCell.tsx");
    expect(cell).toMatch(/const released = await forceReleaseDocument\(\{/);
    expect(cell).toMatch(/if \(!released\.auditRecorded\) \{[\s\S]*?title: "Released, but the audit row was refused"/);
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(page).toMatch(/const released = await forceReleaseDocument\(\{/);
    expect(page).toMatch(/if \(!released\.auditRecorded\) \{[\s\S]*?setError\(`Released, but the audit row was refused:/);
  });

  it("an RPC answer for a different document is a refusal: nothing recorded", async () => {
    state.rpcResult = { data: { documentId: "other", endedSessions: 0 }, error: null };
    await expect(forceReleaseDocument(input)).rejects.toThrow(/not confirmed by the database/);
    expect(state.audits).toEqual([]);
  });
});

// ── DCK-14 ───────────────────────────────────────────────────────────────────

describe("DCK-14 — the close is conditional on the same evidence as the lock clear", () => {
  const leave = () => finishMySession({ orgId: "o1", documentId: "d1", userId: "me", userName: "me", episodeId: "ep-1", sessionStatus: "checked_in", outcome: { outcome: "all_clear" } });

  it("last one out with nobody joining: the episode seals and the thread says so", async () => {
    state.rows.documents = [{ id: "d1", checked_out_by: "me" }];
    state.rows.checkout_sessions = [];
    const r = await leave();
    expect(r.transition.kind).toBe("close");
    expect(r.episodeClosed).toBe(true);
    expect(writesTo("checkout_episodes", "update")).toHaveLength(1);
    expect(messages().some((t) => t.includes("checkout closed"))).toBe(true);
  });

  it("a session that joined AFTER the closer's fetch: the episode is NOT sealed, the lock is settled from the live rows, and the thread says the checkout stays open", async () => {
    state.rows.documents = [{ id: "d1", checked_out_by: null }];
    const newcomer = { id: "s-new", user_id: "u-new", user_name: "newcomer", started_at: "2026-09-01T00:00:00Z", document_id: "d1", status: "active", episode_id: "ep-1" };
    // 1st read (finishMySession's session list): empty; 2nd read (closeEpisode's re-read): the newcomer; later reads (reconcile): the newcomer
    state.seq["checkout_sessions.select"] = [[], [newcomer]];
    state.rows.checkout_sessions = [newcomer];
    const r = await leave();
    expect(r.transition.kind).toBe("close");
    expect(r.episodeClosed).toBe(false);
    expect(writesTo("checkout_episodes", "update")).toHaveLength(0);
    // reconcile handed the lock to the newcomer instead of leaving the document free
    const heir = writesTo("documents", "update").find((w) => (w.payload as { checked_out_by?: string }).checked_out_by === "u-new");
    expect(heir).toBeDefined();
    expect(messages().some((t) => t.includes("someone else joined meanwhile, so the checkout stays open"))).toBe(true);
    expect(messages().some((t) => t.includes("checkout closed"))).toBe(false);
  });

  it("the database rail's refusal (20261075) is the same verdict: reconcile, never throw", async () => {
    state.rows.documents = [{ id: "d1", checked_out_by: null }];
    const newcomer = { id: "s-new", user_id: "u-new", user_name: "newcomer", started_at: "2026-09-01T00:00:00Z", document_id: "d1", status: "active", episode_id: "ep-1" };
    state.seq["checkout_sessions.select"] = [[], []]; // the re-read missed the racer …
    state.rows.checkout_sessions = [newcomer];
    state.errors["checkout_episodes.update"] = { message: "This checkout episode still has active sessions and cannot be sealed.", code: "23514" };
    const r = await leave();
    expect(r.episodeClosed).toBe(false);
    expect(messages().some((t) => t.includes("stays open"))).toBe(true);
  });

  it("any OTHER refusal of the close still throws (nothing is swallowed)", async () => {
    state.rows.documents = [{ id: "d1", checked_out_by: "me" }];
    state.rows.checkout_sessions = [];
    state.errors["checkout_episodes.update"] = { message: "A closed checkout episode is a sealed record and cannot be changed.", code: "23514" };
    await expect(leave()).rejects.toThrow(/sealed record/);
  });
});

// ── DCK-11 ───────────────────────────────────────────────────────────────────

describe("DCK-11 — the episode-schema latch is time-boxed and loud", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("latches on a genuine pre-migration error, logs ONCE per window, and re-probes after the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T10:00:00Z"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.errors["checkout_episodes.select"] = { code: "42P01", message: 'relation "public.checkout_episodes" does not exist' };
    const probes = () => state.calls.filter((c) => c.table === "checkout_episodes" && c.method === "select").length;

    expect(await getActiveEpisode("d1")).toBeNull();
    expect(probes()).toBe(1);
    expect(episodeSchemaIsMissing()).toBe(true);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toMatch(/episode schema unavailable/);

    // latched: no query, no second log
    expect(await getActiveEpisode("d1")).toBeNull();
    expect(probes()).toBe(1);
    expect(err).toHaveBeenCalledTimes(1);

    // window over: re-probe (and, still failing, log again for the new window)
    vi.setSystemTime(new Date(Date.now() + EPISODE_SCHEMA_RECHECK_MS + 1));
    expect(episodeSchemaIsMissing()).toBe(false);
    expect(await getActiveEpisode("d1")).toBeNull();
    expect(probes()).toBe(2);
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it("an unrelated undefined-column error does NOT latch — it is thrown, and the next call still queries", async () => {
    state.errors["checkout_episodes.select"] = { code: "42703", message: 'column "colour" does not exist' };
    await expect(getActiveEpisode("d1")).rejects.toThrow(/colour/);
    expect(episodeSchemaIsMissing()).toBe(false);
    expect(isMissingEpisodeSchema(state.errors["checkout_episodes.select"])).toBe(false);
  });
});

// ── DCK-7 / DCK-9 — the sweep ────────────────────────────────────────────────

describe("DCK-7 — the browser sweep is the caller's own, select-driven, and loud", () => {
  const s1 = { id: "s1", document_id: "d1", org_id: "o1", user_id: "u1", library_id: "l1" };
  const s2 = { id: "s2", document_id: "d2", org_id: "o1", user_id: "u1", library_id: null };

  it("without a userId the RLS-client sweep does nothing at all", async () => {
    await expect(autoReleaseExpiredAdHoc("o1")).resolves.toBe(0);
    expect(state.calls).toEqual([]);
  });

  it("with a userId: the selection is scoped to that user, and notifications + CHECK_IN rows are built from the rows the UPDATE returned", async () => {
    state.seq["checkout_sessions.select"] = [[{ id: "s1" }, { id: "s2" }]];
    state.seq["checkout_sessions.update"] = [[s1]]; // only s1 actually changed (s2 already carried a verdict)
    const n = await autoReleaseExpiredAdHoc("o1", { userId: "u1" });
    expect(n).toBe(1);
    const listing = state.calls.filter((c) => c.table === "checkout_sessions" && c.op === "select" && c.method === "eq" && c.args[0] === "user_id");
    expect(listing.map((c) => c.args[1])).toEqual(["u1"]);
    const sweep = writesTo("checkout_sessions", "update")[0];
    expect(sweep.payload).toMatchObject({ status: "checked_in", outcome: "auto_released" });
    expect(sweep.filters).toContainEqual(["in:id", ["s1", "s2"]]);
    expect(sweep.filters).toContainEqual(["is:outcome", null]);
    const notes = writesTo("notifications", "insert")[0].payload as Array<Record<string, unknown>>;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ user_id: "u1", resource_id: "d1", metadata: { autoReleasedSessionId: "s1" } });
    const audits = writesTo("audit_logs", "insert")[0].payload as Array<Record<string, unknown>>;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "CHECK_IN", resource_id: "d1", org_id: "o1", user_id: "u1" });
    expect(audits[0].details).toMatchObject({ outcome: "auto_released", via: "page_sweep", sessionId: "s1", releasedUserId: "u1" });
  });

  it("a refused sweep write THROWS and notifies nobody", async () => {
    state.seq["checkout_sessions.select"] = [[{ id: "s1" }]];
    state.errors["checkout_sessions.update"] = { message: "You are not allowed to release another user's checkout.", code: "23514" };
    await expect(autoReleaseExpiredAdHoc("o1", { userId: "u1" })).rejects.toThrow(/NOT released: You are not allowed/);
    expect(writesTo("notifications", "insert")).toHaveLength(0);
    expect(writesTo("audit_logs", "insert")).toHaveLength(0);
  });

  it("/checkouts keeps the sweep in its own lane: a refused sweep is shown in sweepError and the listing still loads", () => {
    const page = src("app/(protected)/checkouts/page.tsx");
    expect(page).toMatch(/const \[sweepError, setSweepError\] = useState<string \| null>\(null\);/);
    // the sweep's try/catch closes BEFORE listAllActiveCheckouts is awaited
    expect(page).toMatch(/try \{\s*\n\s*await autoReleaseExpiredAdHoc\(activeOrgId, \{ userId: uid \?\? null \}\);\s*\n\s*\} catch \(e\) \{\s*\n\s*setSweepError\(/);
    expect(page).toMatch(/\}\s*\n\s*try \{\s*\n\s*const sessions = await listAllActiveCheckouts\(activeOrgId\);/);
    expect(page).toMatch(/\{sweepError && !loading && \(/);
    // the library page isolates its sweep the same way
    const lib = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(lib).toMatch(/m\.autoReleaseExpiredAdHoc\(activeOrgId, \{ userId: uid \}\)\)\s*\n\s*\.catch\(/);
  });

  it("the cron (service client, no org) sweeps everyone and attributes the CHECK_IN to the system, naming the holder", async () => {
    const { supabase } = await import("@/lib/supabase");
    state.seq["checkout_sessions.select"] = [[{ id: "s1" }, { id: "s2" }]];
    state.seq["checkout_sessions.update"] = [[s1, s2]];
    const n = await autoReleaseExpiredAdHoc(null, { client: supabase });
    expect(n).toBe(2);
    expect(state.calls.filter((c) => c.table === "checkout_sessions" && c.op === "select" && c.method === "eq" && (c.args[0] === "user_id" || c.args[0] === "org_id"))).toEqual([]);
    const audits = writesTo("audit_logs", "insert")[0].payload as Array<Record<string, unknown>>;
    expect(audits.map((a) => a.user_id)).toEqual([null, null]);
    expect(audits.map((a) => (a.details as { releasedUserId: string }).releasedUserId)).toEqual(["u1", "u1"]);
    expect(audits.map((a) => (a.details as { via: string }).via)).toEqual(["cron", "cron"]);
    expect((writesTo("notifications", "insert")[0].payload as unknown[]).length).toBe(2);
  });
});

describe("DCK-9 — the project release is a check-in with an outcome, a CHECK_IN row, and a checked write", () => {
  const row = { id: "s1", document_id: "d1", org_id: "o1", user_id: "u1", user_name: "ann" };

  it("records outcome 'auto_released' with the reason, one CHECK_IN per document naming the sessions, and returns the count", async () => {
    state.seq["checkout_sessions.select"] = [[row]];
    state.seq["checkout_sessions.update"] = [[row]];
    const n = await releaseAllCheckoutsForProject({ projectId: "p1", reason: "Project completed", actorUserId: "mgr", actorEmail: "mgr@x.io", actorRole: "Manager" });
    expect(n).toBe(1);
    const w = writesTo("checkout_sessions", "update")[0];
    expect(w.payload).toMatchObject({ status: "checked_in", released_by: "mgr", released_reason: "Project completed", outcome: "auto_released", outcome_note: "Project completed" });
    const checkIn = state.audits.filter((a) => a.action === "CHECK_IN");
    expect(checkIn).toHaveLength(1);
    expect(checkIn[0]).toMatchObject({ resourceId: "d1", orgId: "o1", userId: "mgr", userEmail: "mgr@x.io", userRole: "Manager" });
    expect(checkIn[0].details).toMatchObject({ outcome: "auto_released", via: "project_release", projectId: "p1", releasedSessions: [{ sessionId: "s1", userId: "u1", userName: "ann" }] });
  });

  it("a refused write is thrown, not discarded, and no CHECK_IN is written", async () => {
    state.seq["checkout_sessions.select"] = [[row]];
    state.errors["checkout_sessions.update"] = { message: "You are not allowed to release another user's checkout.", code: "23514" };
    await expect(releaseAllCheckoutsForProject({ projectId: "p1", reason: "Project completed", actorUserId: "mgr" })).rejects.toThrow(/NOT released: You are not allowed/);
    expect(state.audits.filter((a) => a.action === "CHECK_IN")).toHaveLength(0);
  });

  it("nothing active → nothing written, 0", async () => {
    state.seq["checkout_sessions.select"] = [[]];
    await expect(releaseAllCheckoutsForProject({ projectId: "p1", reason: "x", actorUserId: "mgr" })).resolves.toBe(0);
    expect(state.writes).toEqual([]);
  });

  it("transitionProjectStatus: the status change lands and a refused release comes back in the RESULT, not as a throw", async () => {
    state.rows.projects = [{ id: "p1", org_id: "o1", owner_user_id: "mgr", name: "Pump swap" }];
    state.seq["checkout_sessions.select"] = [[row]];
    state.errors["checkout_sessions.update"] = { message: "You are not allowed to release another user's checkout.", code: "23514" };
    const res = await transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "completed", actorUserId: "mgr", actorEmail: "mgr@x.io", actorRole: "Manager" });
    expect(res.releaseError).toMatch(/^The project is completed, but its active checkouts were NOT released: You are not allowed/);
    expect(writesTo("projects", "update")[0].payload).toMatchObject({ status: "completed" });
    // and with nothing to refuse, releaseError is null
    state.errors = {}; state.writes = [];
    state.seq["checkout_sessions.select"] = [[]];
    await expect(transitionProjectStatus({ projectId: "p1", orgId: "o1", toStatus: "completed", actorUserId: "mgr" })).resolves.toEqual({ releaseError: null });
  });

  it("the project page refreshes to the database's status BEFORE showing the release refusal, and refreshes on a throw too", () => {
    const page = src("app/(protected)/projects/[id]/page.tsx");
    expect(page).toMatch(/const \{ releaseError \} = await transitionProjectStatus\(\{/);
    expect(page).toMatch(/await refresh\(\);\s*\n(\s*\/\/.*\n)*\s*if \(releaseError\) setActionError\(releaseError\);/);
    expect(page).toMatch(/setActionError\(\(e as Error\)\.message\);\s*\n(\s*\/\/.*\n)*\s*await refresh\(\)\.catch\(\(\) => undefined\);/);
  });
});
