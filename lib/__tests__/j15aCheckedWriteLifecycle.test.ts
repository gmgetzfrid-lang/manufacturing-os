// projects-tab SAF-18 — the J15 checked-write sweep, batch J15a, part 2 of 3:
// the document-control lifecycle (origin, share revoke, doc class, markups,
// markup requests, branches, renumber, the rollback park and lineage
// delete, the unit-code chunks, check-in / quick hold).
//
// Each converted site: a zero-row match is reported (class a: the typed
// refusal, nothing claims it happened; class b: said, never fails the act)
// or stays a no-op success (class c: legitimate), and the success path is
// the same write, the same filters, the same follow-on rows as before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  emits: [] as Array<Record<string, unknown>>,
  decodes: [] as unknown[],
  adminCalls: [] as Array<{ table: string; ops: Array<{ m: string; args: unknown[] }> }>,
  adminAnswer: null as null | ((c: { table: string; ops: Array<{ m: string; args: unknown[] }> }) => unknown),
}));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<typeof import("@/lib/audit")>()),
  logAuditAction: vi.fn(async (e: Record<string, unknown>) => { k.audits.push(e); return { error: null }; }),
  logRevisionEvent: vi.fn(async (e: Record<string, unknown>) => { k.revisionEvents.push(e); }),
  logHoldEvent: vi.fn(async () => undefined),
  logCheckoutEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notify/dispatch", async (orig) => ({ ...(await orig<typeof import("@/lib/notify/dispatch")>()), emit: vi.fn(async (e: Record<string, unknown>) => { k.emits.push(e); }) }));
vi.mock("@/lib/projects", () => ({ writeActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/activityThread", () => ({ postMarkupRef: vi.fn(async () => undefined) }));
vi.mock("@/lib/principal", () => ({ resolveActorPrincipal: vi.fn(async (i: { uid: string }) => ({ uid: i.uid, role: "Admin", roles: ["Admin"], orgId: "o1", teamIds: [], isActiveMember: true })) }));
vi.mock("@/lib/documentGuards", async (orig) => ({ ...(await orig<typeof import("@/lib/documentGuards")>()), resolveCanControlLibrary: vi.fn(async () => true) }));
vi.mock("@/lib/holdGate", async (orig) => ({ ...(await orig<typeof import("@/lib/holdGate")>()), assertNotOnHold: vi.fn(async () => undefined) }));
vi.mock("@/lib/unitCodeClient", () => ({ requestUnitCodeDecode: vi.fn(async (...a: unknown[]) => { k.decodes.push(a); return { note: null }; }) }));
vi.mock("@/lib/revisions", async (orig) => ({ ...(await orig<typeof import("@/lib/revisions")>()), putBackRetiredIssue: vi.fn(async () => ({ kind: "landed", putBackAs: undefined })) }));
vi.mock("@/lib/supabaseAdmin", () => {
  const chain = (table: string) => {
    const call = { table, ops: [] as Array<{ m: string; args: unknown[] }> };
    k.adminCalls.push(call);
    const p: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(() => k.adminAnswer?.(call) ?? { data: [], error: null }).then(res, rej);
        return (...args: unknown[]) => { call.ops.push({ m: String(prop), args }); return p; };
      },
    });
    return p;
  };
  return { supabaseAdmin: { from: (t: string) => chain(t) } };
});

import { CHECKED_WRITE_REFUSED } from "@/lib/checkedWrite";
import { setDocumentOrigin } from "@/lib/documentOrigin";
import { revokeShareLink } from "@/lib/documentShares";
import { setDocClass } from "@/lib/docClass";
import { saveMyMarkup } from "@/lib/markups";
import { resolveMarkupRequest } from "@/lib/markupRequests";
import { resolveBranch, BRANCH_MERGE_REFUSED } from "@/lib/branches";
import { renumberDocument } from "@/lib/documentLifecycle/renumber";
import { archiveRolledBackDoc, restoreSupersededSource } from "@/lib/documentLifecycle/common";
import { applyWrites, type Chunk } from "@/lib/unitCodeDecode";
import { finishMySession, adoptInFlightCheckout, abortFailedLockClaim, reconcileDocumentCheckoutState } from "@/lib/checkoutEpisodes";
import type { DocumentRecord } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const warned = (re: RegExp) => warn.mock.calls.some((c: unknown[]) => re.test(String(c[0])));
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.calls.length = 0;
  h.answers = {};
  k.audits.length = 0; k.revisionEvents.length = 0; k.emits.length = 0; k.decodes.length = 0; k.adminCalls.length = 0; k.adminAnswer = null;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { warn.mockRestore(); });

describe("lib/documentOrigin.ts setDocumentOrigin — class (a); before J15a the result was discarded and the audit row written regardless", () => {
  const set = () => setDocumentOrigin({ documentId: "d1", orgId: "o1", actorId: "u1", origin: "external", externalSource: " API ", externalReference: "610" });
  it("success: the same columns, then DOCUMENT_ORIGIN_SET", async () => {
    await set();
    expect(writes().map(opsOf)).toEqual(['update({…}).eq("id", "d1").select("id")']);
    expect(writes()[0].ops[0].args[0]).toEqual({ origin: "external", external_source: "API", external_reference: "610", external_edition: null, external_url: null });
    expect(k.audits.map((a) => a.action)).toEqual(["DOCUMENT_ORIGIN_SET"]);
  });
  it("zero rows: the typed refusal, and NO audit row", async () => {
    h.answers["documents:update"] = NONE;
    await expect(set()).rejects.toThrow(`The document's origin was not saved. ${CHECKED_WRITE_REFUSED}`);
    expect(k.audits).toEqual([]);
  });
  it("a database error: plain language, and NO audit row", async () => {
    h.answers["documents:update"] = { data: null, error: { code: "42501", message: "new row violates row-level security policy for table \"documents\"" } };
    await expect(set()).rejects.toThrow("You don't have permission to do this — nothing was changed.");
    expect(k.audits).toEqual([]);
  });
});

describe("lib/documentShares.ts revokeShareLink — already checked; now through checkedWrite, unchanged", () => {
  it("a revoked link is audited once; zero rows on an already-revoked link is the no-op; zero rows otherwise refuses; an error throws as before", async () => {
    h.answers["document_shares:update"] = { data: [{ id: "s1", org_id: "o1", document_id: "d1" }], error: null };
    expect(await revokeShareLink("s1", "u1")).toEqual({ auditWarning: null });
    expect(k.audits.map((a) => [a.action, a.resourceId])).toEqual([["SHARE_LINK_REVOKED", "d1"]]);
    k.audits.length = 0;
    h.answers["document_shares:update"] = NONE;
    h.answers["document_shares:select"] = { data: { id: "s1", revoked_at: "2026-11-01T00:00:00Z" }, error: null };
    expect(await revokeShareLink("s1", "u1")).toEqual({ auditWarning: null });
    h.answers["document_shares:select"] = { data: { id: "s1", revoked_at: null }, error: null };
    await expect(revokeShareLink("s1", "u1")).rejects.toThrow(/This link was not revoked/);
    expect(k.audits).toEqual([]);
    const err = { code: "P0001", message: "revoked_at cannot change once set" };
    h.answers["document_shares:update"] = { data: null, error: err };
    await expect(revokeShareLink("s1", "u1")).rejects.toMatchObject(err);
  });
});

describe("lib/docClass.ts setDocClass — class (a)", () => {
  it("zero rows refuses; the pre-migration error keeps its own classification; success resolves", async () => {
    await expect(setDocClass({ level: "document", id: "d1", docClass: "drawing" })).resolves.toBeUndefined();
    expect(writes().map(opsOf)).toEqual(['update({…}).eq("id", "d1").select("id")']);
    h.answers["documents:update"] = NONE;
    await expect(setDocClass({ level: "document", id: "d1", docClass: "drawing" })).rejects.toThrow(`The document class was not saved. ${CHECKED_WRITE_REFUSED}`);
    h.answers["documents:update"] = { data: null, error: { code: "PGRST204", message: "Could not find the 'doc_class' column of 'documents' in the schema cache" } };
    await expect(setDocClass({ level: "document", id: "d1", docClass: null })).rejects.toThrow(/need the 20261012 migration/);
  });
});

describe("lib/markups.ts saveMyMarkup (nothing drawn) — class (c)", () => {
  const clear = () => saveMyMarkup({ orgId: "o1", documentId: "d1", versionId: "v1", uid: "u1", pageStates: {} });
  it("nothing stored to clear is a success; a pending migration stays quiet (whole error); any other error throws its words", async () => {
    h.answers["document_markups:delete"] = NONE;
    expect(await clear()).toBeNull();
    expect(writes().map(opsOf)).toEqual(['delete().eq("document_id", "d1").eq("version_id", "v1").eq("user_id", "u1").select("id")']);
    h.answers["document_markups:delete"] = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.document_markups' in the schema cache" } };
    expect(await clear()).toBeNull();
    h.answers["document_markups:delete"] = { data: null, error: { code: "42501", message: "permission denied for table document_markups" } };
    await expect(clear()).rejects.toThrow("permission denied for table document_markups");
  });
});

describe("lib/markupRequests.ts resolveMarkupRequest — already checked; now through checkedWrite, unchanged", () => {
  const resolve = () => resolveMarkupRequest({ markupRequestId: "m1", status: "declined", orgId: "o1", actorUserId: "u1" });
  it("zero rows refuses with its own sentence (nothing recorded); a row resolves and is audited", async () => {
    h.answers["markup_requests:update"] = { data: null, error: null };
    await expect(resolve()).rejects.toThrow("The markup request could not be updated (not found or not permitted).");
    expect(k.audits).toEqual([]);
    h.answers["markup_requests:update"] = { data: { document_id: "d1", requested_by_user_id: "u2", requested_from_user_id: "u1" }, error: null };
    await expect(resolve()).resolves.toBeUndefined();
    expect(writes("markup_requests").at(-1)!.ops.map((o) => o.m)).toEqual(["update", "eq", "select", "maybeSingle"]);
    expect(k.audits.length).toBe(1);
  });
});

describe("lib/branches.ts resolveBranch — already checked; now through checkedWrite, unchanged", () => {
  const resolve = (resolution: "merged" | "withdrawn") => resolveBranch({ branchId: "b1", resolution, note: "done", orgId: "o1", actorUserId: "u1", actorName: "U" });
  it("zero rows refuses with its own sentence; 42501 on a merge claim is the DRLS-9 sentence (the whole error is read); nothing audited", async () => {
    h.answers["revision_branches:update"] = { data: null, error: null };
    await expect(resolve("withdrawn")).rejects.toThrow(/^Branch was not resolved/);
    h.answers["revision_branches:update"] = { data: null, error: { code: "42501", message: "new row violates row-level security policy" } };
    await expect(resolve("merged")).rejects.toThrow(BRANCH_MERGE_REFUSED);
    await expect(resolve("withdrawn")).rejects.toThrow("new row violates row-level security policy");
    expect(k.audits).toEqual([]);
  });
});

describe("lib/documentLifecycle — renumber, the rollback park, the lineage delete", () => {
  const doc = { id: "d1", libraryId: "L", documentNumber: "P-100" } as DocumentRecord;
  it("renumberDocument: zero rows refuses — no DOC_RENUMBERED, no unit decode; success writes both as before", async () => {
    h.answers["documents:update"] = NONE;
    await expect(renumberDocument({ doc, newDocumentNumber: "P-101", reason: "typo", orgId: "o1", actorUserId: "u1" })).rejects.toThrow(`The document was not renumbered. ${CHECKED_WRITE_REFUSED}`);
    expect(k.revisionEvents).toEqual([]);
    expect(k.decodes).toEqual([]);
    h.answers = {};
    await expect(renumberDocument({ doc, newDocumentNumber: "P-101", reason: "typo", orgId: "o1", actorUserId: "u1" })).resolves.toEqual({ unitCodeNote: null });
    expect(k.revisionEvents.map((e) => e.type)).toEqual(["DOC_RENUMBERED"]);
    expect(k.decodes).toHaveLength(1);
  });
  it("archiveRolledBackDoc: zero rows is a failed clean-up step (the rollback names it), never a silent 'rolled back'", async () => {
    await expect(archiveRolledBackDoc("n1", { orgId: "o1", actorUserId: "u1" } as never)).resolves.toBeUndefined();
    h.answers["documents:update"] = NONE;
    await expect(archiveRolledBackDoc("n1", { orgId: "o1", actorUserId: "u1" } as never)).rejects.toThrow("document n1 could not be archived (the write was refused) — it is still live");
  });
  it("restoreSupersededSource: the lineage delete matching no row is legitimate (the read decides); its error keeps its words", async () => {
    h.answers["document_supersessions:delete"] = NONE;
    h.answers["document_supersessions:select"] = NONE;
    await expect(restoreSupersededSource("s1", "Issued", ["r1"], { orgId: "o1", actorUserId: "u1" } as never)).resolves.toBeUndefined();
    expect(writes("document_supersessions").map(opsOf)).toEqual(['delete().eq("superseded_doc_id", "s1").in("replacement_doc_id", [r1]).select("id")']);
    h.answers["document_supersessions:delete"] = { data: null, error: { message: "permission denied for table document_supersessions" } };
    h.answers["document_supersessions:select"] = { data: [{ replacement_doc_id: "r1" }], error: null };
    await expect(restoreSupersededSource("s1", "Issued", ["r1"], { orgId: "o1", actorUserId: "u1" } as never)).rejects.toThrow("1 supersession link(s) from s1 could not be removed (permission denied for table document_supersessions) — Document Control must delete them");
  });
  it("the reversal's lineage delete and the split's set touch read their matched rows (driven end to end by the lifecycle suites)", () => {
    expect(src("lib/documentLifecycle/reverse.ts")).toMatch(/await checkedWrite\(answered\(supabase\s*\n\s*\.from\("document_supersessions"\)\s*\n\s*\.delete\(\)\s*\n\s*\.in\("superseded_doc_id", filter\.supersededIds\)\s*\n\s*\.in\("replacement_doc_id", filter\.replacementIds\)\s*\n\s*\.select\("id"\), delKept\)\);\s*\n\s*const error = delKept\.error;/);
    const split = src("lib/documentLifecycle/split.ts");
    expect(split).toMatch(/const touched = await checkedWrite\(supabase\s*\n\s*\.from\("document_sets"\)\s*\n\s*\.update\(\{ updated_at: new Date\(\)\.toISOString\(\) \}\)\s*\n\s*\.eq\("id", source\.setId\)\s*\n\s*\.select\("id"\)\);\s*\n\s*if \(!touched\.ok\) console\.warn\(/);
  });
});

describe("lib/unitCodeDecode.ts applyWrites — class (c): each chunk's rows are counted against its ids, as before", () => {
  it("the read-back is select('id') unless a chunk names its columns; changed and refused counted as before", async () => {
    const chunks: Chunk[] = [
      { patch: { unit_code: "U1" }, ids: ["a", "b"], guard: (q) => q.eq("document_number", "P-1") },
      { patch: { unit_code: "U2" }, ids: ["c"], guard: (q) => q, returning: "id, unit_code", landed: (r) => r.unit_code === "U2" },
      { patch: { unit_code: null }, ids: ["d"], guard: (q) => q },
    ];
    k.adminAnswer = (c) => {
      const ids = (c.ops.find((o) => o.m === "in")?.args[1] ?? []) as string[];
      if (ids.includes("a")) return { data: [{ id: "a" }], error: null };
      if (ids.includes("c")) return { data: [{ id: "c", unit_code: "U9" }], error: null };
      return { data: null, error: { message: "permission denied" } };
    };
    expect(await applyWrites("documents", "o1", chunks)).toEqual({ written: 1, changed: 2, refused: 1, firstError: "permission denied" });
    expect(k.adminCalls.map((c) => c.ops.find((o) => o.m === "select")?.args[0])).toEqual(["id", "id, unit_code", "id"]);
  });
});

describe("lib/checkoutEpisodes.ts — check-in (finishMySession), adoption", () => {
  const finish = (over: Record<string, unknown> = {}) => finishMySession({ orgId: "o1", documentId: "d1", userId: "u1", userName: "U One", episodeId: "e1", ...over });
  it("my session already ended (zero rows) is a success (class c); the pre-migration retry still reads the whole error; another error throws its words", async () => {
    h.answers["checkout_sessions:select"] = { data: [{ id: "s2", user_id: "u2", user_name: "U Two", started_at: "2026-11-01" }], error: null };
    h.answers["documents:select"] = { data: { checked_out_by: "u2" }, error: null };
    let n = 0;
    h.answers["checkout_sessions:update"] = () => (++n === 1 ? { data: null, error: { code: "42703", message: 'column "outcome" of relation "checkout_sessions" does not exist' } } : NONE);
    const r = await finish({ outcome: { outcome: "no_change" } });
    expect(r.transition.kind).toBe("remain");
    const ends = writes("checkout_sessions");
    expect(ends).toHaveLength(2);
    expect(ends[0].ops[0].args[0]).toHaveProperty("outcome", "no_change");
    expect(ends[1].ops[0].args[0]).not.toHaveProperty("outcome");
    expect(ends[1].ops.map((o) => o.m)).toEqual(["update", "eq", "eq", "eq", "select"]);
    h.answers["checkout_sessions:update"] = { data: null, error: { code: "42501", message: "permission denied for table checkout_sessions" } };
    await expect(finish()).rejects.toThrow("permission denied for table checkout_sessions");
  });
  it("a collaborator leaves: the display list is bookkeeping (class b) — one that did not land is said, the check-in stands", async () => {
    h.answers["checkout_sessions:select"] = { data: [{ id: "s2", user_id: "u2", user_name: "U Two", started_at: "2026-11-01" }], error: null };
    h.answers["documents:select"] = { data: { checked_out_by: "u2" }, error: null };
    await finish();
    expect(writes("documents").map((c) => c.ops[0].args[0])).toEqual([{ active_collaborators: ["U Two"] }]);
    expect(warn).not.toHaveBeenCalled();
    h.answers["documents:update"] = NONE;
    await expect(finish()).resolves.toMatchObject({ transition: { kind: "remain" } });
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/collaborator list was not updated/);
  });
  it("the last one out: the guarded lock clear matching no row is legitimate (a racer holds it) — quiet; an error is said", async () => {
    h.answers["checkout_sessions:select"] = NONE;
    h.answers["documents:select"] = { data: { checked_out_by: "u3" }, error: null };
    h.answers["documents:update"] = NONE;
    await finish({ episodeId: null });
    const clear = writes("documents")[0];
    expect(clear.ops.map((o) => o.m)).toEqual(["update", "eq", "or", "select"]);
    expect(warn.mock.calls.filter((c: unknown[]) => /lock columns/.test(String(c[0])))).toEqual([]);
    h.answers["documents:update"] = { data: null, error: { message: "upstream request timeout" } };
    await finish({ episodeId: null });
    expect(warn.mock.calls.some((c: unknown[]) => /lock columns could not be cleared/.test(String(c[0])))).toBe(true);
  });
  it("the holder leaves: the CAS to the heir matching no row is legitimate — quiet; an error is said", async () => {
    h.answers["checkout_sessions:select"] = (c: Call) => (c.ops.some((o) => o.m === "maybeSingle") ? { data: { purpose: "Edit", note: null, started_at: "2026-11-01" }, error: null } : { data: [{ id: "s2", user_id: "u2", user_name: "U Two", started_at: "2026-11-01" }], error: null });
    h.answers["documents:select"] = { data: { checked_out_by: "u1" }, error: null };
    h.answers["documents:update"] = NONE;
    const r = await finish();
    expect(r.transition.kind).toBe("transfer");
    expect(writes("documents")[0].ops.map((o) => o.m)).toEqual(["update", "eq", "eq", "select"]);
    expect(warn.mock.calls.filter((c: unknown[]) => /could not be passed/.test(String(c[0])))).toEqual([]);
    h.answers["documents:update"] = { data: null, error: { message: "deadlock detected", code: "40P01" } };
    await finish();
    expect(warn.mock.calls.some((c: unknown[]) => /lock could not be passed to U Two/.test(String(c[0])))).toBe(true);
  });
  it("adoptInFlightCheckout: sessions already tagged (zero rows) is a success; an error is said; the episode is answered either way", async () => {
    h.answers["checkout_sessions:select"] = { data: [{ id: "s1", user_id: "u1", user_name: "U One", started_at: "2026-11-01" }], error: null };
    h.answers["checkout_episodes:select"] = { data: { id: "e1", org_id: "o1", document_id: "d1", seq: 1, status: "active" }, error: null };
    h.answers["checkout_sessions:update"] = NONE;
    expect((await adoptInFlightCheckout({ orgId: "o1", documentId: "d1" }))?.id).toBe("e1");
    expect(writes("checkout_sessions")[0].ops.map((o) => o.m)).toEqual(["update", "eq", "eq", "is", "select"]);
    expect(warn).not.toHaveBeenCalled();
    h.answers["checkout_sessions:update"] = { data: null, error: { message: "upstream request timeout" } };
    expect((await adoptInFlightCheckout({ orgId: "o1", documentId: "d1" }))?.id).toBe("e1");
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not be tagged with the episode/);
  });
  // The integrator's residual-2 ruling: the writes through a `db` client
  // parameter (which the census does not count) are converted too.
  it("closeEpisode (c): the CAS matching no row (already closed by a racer) answers closed, as before; the rail's error still answers live_sessions", async () => {
    h.answers["checkout_sessions:select"] = NONE;
    h.answers["documents:select"] = { data: { checked_out_by: "u1" }, error: null };
    h.answers["checkout_episodes:update"] = NONE;
    expect(await finish()).toMatchObject({ transition: { kind: "close" }, episodeClosed: true });
    expect(writes("checkout_episodes").map(opsOf)).toEqual(['update({…}).eq("id", "e1").eq("status", "active").select("id")']);
    h.answers["checkout_episodes:update"] = { data: [{ id: "e1" }], error: null };
    expect(await finish()).toMatchObject({ episodeClosed: true });
    h.answers["checkout_episodes:update"] = { data: null, error: { code: "P0001", message: "episode e1 still has active sessions" } };
    expect(await finish()).toMatchObject({ episodeClosed: false });
    h.answers["checkout_episodes:update"] = { data: null, error: { code: "40001", message: "could not serialize access" } };
    await expect(finish()).rejects.toThrow("could not serialize access");
  });
  it("abortFailedLockClaim (c): a session already ended (zero rows) is nothing to roll back; an error throws in its words, as before", async () => {
    const abort = () => abortFailedLockClaim({ sessionId: "s1", documentId: "d1", userId: "u1" });
    h.answers["checkout_sessions:update"] = NONE;
    await expect(abort()).resolves.toBeUndefined();
    expect(writes("checkout_sessions").map(opsOf)).toEqual(['update({…}).eq("id", "s1").eq("status", "active").select("id")']);
    h.answers["checkout_sessions:update"] = { data: null, error: { message: "permission denied for table checkout_sessions" } };
    await expect(abort()).rejects.toThrow("The checkout could not be rolled back: permission denied for table checkout_sessions");
  });
  it("reconcileDocumentCheckoutState (b): the collaborator list and the lock transfer that did not land are said; landed ones are quiet and the same writes", async () => {
    h.answers["checkout_sessions:select"] = (c: Call) => (c.ops.some((o) => o.m === "maybeSingle") ? { data: { purpose: "Edit", note: null, started_at: "2026-11-01" }, error: null } : { data: [{ id: "s2", user_id: "u2", user_name: "U Two", started_at: "2026-11-01" }], error: null });
    h.answers["documents:select"] = { data: { checked_out_by: "u2" }, error: null };
    await reconcileDocumentCheckoutState("d1");
    expect(writes("documents").map((c) => c.ops[0].args[0])).toEqual([{ active_collaborators: ["U Two"] }]);
    expect(warn).not.toHaveBeenCalled();
    h.answers["documents:update"] = NONE;
    await reconcileDocumentCheckoutState("d1");
    expect(warned(/collaborator list NOT rebuilt/)).toBe(true);
    h.answers["documents:select"] = { data: { checked_out_by: "gone" }, error: null };
    h.answers["documents:update"] = { data: [{ id: "d1" }], error: null };
    h.calls.length = 0; warn.mockClear();
    await reconcileDocumentCheckoutState("d1");
    expect(writes("documents").map(opsOf)).toEqual(['update({…}).eq("id", "d1").select("id")']);
    expect(writes("documents")[0].ops[0].args[0]).toMatchObject({ checked_out_by: "u2", checked_out_by_name: "U Two", checkout_note: "Edit", active_collaborators: ["U Two"] });
    expect(warn).not.toHaveBeenCalled();
    h.answers["documents:update"] = NONE;
    await reconcileDocumentCheckoutState("d1");
    expect(warned(/stale lock NOT passed to U Two/)).toBe(true);
  });
  it("the quick hold's claim reads its row through checkedWrite and hands resolveLockClaim the same answer (driven by the checkout suites)", () => {
    const ce = src("lib/checkoutEpisodes.ts");
    expect(ce).toMatch(/\.or\(`checked_out_by\.is\.null,checked_out_by\.eq\.\$\{input\.userId\}`\)\s*\n\s*\.select\("id"\)\s*\n\s*\.maybeSingle\(\), claimKept\)\);\s*\n\s*const claim = \{ data: claimed\.ok \? claimKept\.data : null, error: claimKept\.error \};/);
  });
});
