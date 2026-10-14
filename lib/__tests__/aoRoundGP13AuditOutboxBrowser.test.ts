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
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init.body)).entry).toMatchObject({ action: "VIEW", org_id: ORG, user_id: UID });
  });
});
