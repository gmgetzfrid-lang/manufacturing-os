// @vitest-environment jsdom
//
// admin-and-org Round G, package P13 — drafting-flow EVID-6, the BROWSER
// branch of lib/auditOutbox.ts deadLetterAuditRow: a row the browser's RLS
// refused cannot be written to the outbox from the browser (the same rules
// would refuse it), so it is POSTed to /api/audit/dead-letter with the
// session's token; the route verifies the caller and writes as the service
// role. Never throws; says whether the row was kept and, if not, why.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const s = vi.hoisted(() => ({
  token: "tok-1" as string | null,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        s.inserts.push({ table, row });
        return { data: null, error: table === "audit_logs" ? { message: "new row violates row-level security policy" } : null };
      },
    }),
    auth: { getSession: async () => ({ data: { session: s.token ? { access_token: s.token } : null } }) },
  },
}));

import { deadLetterAuditRow, DEAD_LETTER_ROUTE, type DeadLetterRow } from "@/lib/auditOutbox";
import { logAuditAction } from "@/lib/audit";

const ORG = "11111111-1111-4111-8111-111111111111";
const UID = "22222222-2222-4222-8222-222222222222";
const ROW: DeadLetterRow = {
  action: "VIEW", resource_id: "d1", resource_type: "document", org_id: ORG, user_id: UID,
  user_email: "a@x.io", user_role: "Drafter", details: null, metadata: null,
};

let calls: Array<{ url: string; init: RequestInit }> = [];
let answer: () => Response | Promise<Response>;

beforeEach(() => {
  s.token = "tok-1"; s.inserts = []; calls = [];
  answer = () => new Response(JSON.stringify({ ok: true, id: "dl-1" }), { status: 201 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return answer(); }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("EVID-6 (P13) — the browser keeps a refused audit row through the verified route", () => {
  it("POSTs the row, the refusal and the workspace to /api/audit/dead-letter with the session's token, and never writes the outbox itself", async () => {
    expect(await deadLetterAuditRow(ROW, "new row violates row-level security policy")).toEqual({ kept: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DEAD_LETTER_ROUTE);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ orgId: ORG, entry: ROW, error: "new row violates row-level security policy" });
    expect(s.inserts.filter((i) => i.table === "audit_dead_letters")).toEqual([]);
  });

  it("no signed-in session: nothing is sent, not kept, and says why", async () => {
    s.token = null;
    expect(await deadLetterAuditRow(ROW, "x")).toEqual({ kept: false, why: "no signed-in session to verify" });
    expect(calls).toHaveLength(0);
  });

  it("the route's refusal (503 before 20261219, 403, 429) is not kept and carries the route's sentence; a network failure is not kept and never throws", async () => {
    answer = () => new Response(JSON.stringify({ error: "the audit dead-letter outbox is not installed yet (20261219 not applied)" }), { status: 503 });
    expect(await deadLetterAuditRow(ROW, "x")).toEqual({ kept: false, why: "the audit dead-letter outbox is not installed yet (20261219 not applied)" });
    answer = () => new Response("not json", { status: 429 });
    expect(await deadLetterAuditRow(ROW, "x")).toEqual({ kept: false, why: "HTTP 429" });
    answer = () => { throw new TypeError("Failed to fetch"); };
    expect(await deadLetterAuditRow(ROW, "x")).toEqual({ kept: false, why: "Failed to fetch" });
  });

  it("logAuditAction in the browser: the refused row goes to the route, the result is unchanged", async () => {
    const r = await logAuditAction({ action: "VIEW", resourceId: "d1", resourceType: "document", orgId: ORG, userId: UID, userEmail: "a@x.io", userRole: "Drafter" });
    expect(r).toEqual({ ok: false, error: "new row violates row-level security policy" });
    // sent on its own (P13 integrator fix pass): it lands after the caller has its answer
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(String(calls[0].init.body)).entry).toMatchObject({ action: "VIEW", org_id: ORG, user_id: UID });
    await vi.waitFor(() => expect(vi.mocked(console.error).mock.calls.some((c) => /was kept in the audit dead-letter outbox/.test(String(c[0])))).toBe(true));
  });

  it("P13 integrator fix pass: the caller is never held for the dead-letter POST — a route that never answers does not delay logAuditAction's { ok: false, error }", async () => {
    let release: (r: Response) => void = () => undefined;
    answer = () => new Promise<Response>((res) => { release = res; });
    const entry = { action: "VIEW", resourceId: "d1", resourceType: "document", orgId: ORG, userId: UID, userEmail: "a@x.io", userRole: "Drafter" };
    let settled = false;
    const p = logAuditAction(entry).then((r) => { settled = true; return r; });
    // the route has been asked and has NOT answered; the caller already has its answer
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(await p).toEqual({ ok: false, error: "new row violates row-level security policy" });
    // the POST is still bounded and caught: when it answers (here a refusal) it only logs
    release(new Response(JSON.stringify({ error: "too many" }), { status: 429 }));
    await vi.waitFor(() => expect(vi.mocked(console.error).mock.calls.some((c) => /was NOT kept in the audit dead-letter outbox \(too many\)/.test(String(c[0])))).toBe(true));
  });

  it("P13 integrator fix pass: a dead-letter POST that throws never reaches the caller (caught)", async () => {
    answer = () => { throw new TypeError("Failed to fetch"); };
    const entry = { action: "VIEW", resourceId: "d1", resourceType: "document", orgId: ORG, userId: UID, userEmail: "a@x.io", userRole: "Drafter" };
    expect(await logAuditAction(entry)).toEqual({ ok: false, error: "new row violates row-level security policy" });
    await vi.waitFor(() => expect(vi.mocked(console.error).mock.calls.some((c) => /was NOT kept in the audit dead-letter outbox \(Failed to fetch\)/.test(String(c[0])))).toBe(true));
  });
});
