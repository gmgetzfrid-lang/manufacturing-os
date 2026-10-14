// @vitest-environment jsdom
//
// admin-and-org Round G, package P13 — ALOG-11's hand-off (A&O P3 handoff 2 /
// fix-pass-8 item 2): the /admin/audit viewer's "who took which drawing" for
// a DATA_EXPORT row.
//   * app/api/admin/audit/export-files: the Audit log surface's gate
//     (authorizeAdminSurface(req, orgId, "audit")), then lib/dataExport.ts
//     rebuildExportList(sb, orgId, recordId); the exporter is exporter.userId's
//     CURRENT member (read now), never the stored email; undelivered null is
//     "no delivery failure recorded", never "delivered".
//   * components/audit/ExportFilesPanel + /admin/audit: the "Files" control on
//     a DATA_EXPORT row naming its file record, and only there.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  gate: null as null | { error: string; status: number },
  gateCalls: [] as unknown[][],
  rebuilt: null as unknown,
  rebuildCalls: [] as unknown[][],
  member: { data: null as unknown, error: null as null | { message: string } },
  memberSelects: [] as string[],
}));

vi.mock("@/lib/adminGate", () => ({
  authorizeAdminSurface: vi.fn(async (...args: unknown[]) => {
    s.gateCalls.push(args);
    if (s.gate) return s.gate;
    const chain: Row = {};
    const h: ProxyHandler<Row> = {
      get: (_t, p: string) => (p === "maybeSingle" ? async () => s.member
        : (...a: unknown[]) => { if (p === "select") s.memberSelects.push(String(a[0])); return new Proxy(chain, h); }),
    };
    return { userId: "u-aud", email: "aud@x.io", orgId: args[1], roles: ["Auditor"], admittedRole: "Auditor", admin: { from: () => new Proxy(chain, h) } };
  }),
}));
vi.mock("@/lib/dataExport", () => ({
  rebuildExportList: vi.fn(async (...args: unknown[]) => { s.rebuildCalls.push(args); return s.rebuilt; }),
}));

import { GET } from "@/app/api/admin/audit/export-files/route";
import ExportFilesPanel, { exporterSentence, deliverySentence } from "@/components/audit/ExportFilesPanel";

const O1 = "11111111-1111-4111-8111-111111111111";
const get = (q: string) => new NextRequest(`http://x/api/admin/audit/export-files?orgId=${O1}${q}`, { headers: { authorization: "Bearer t" } });
const LIST = (over: Row = {}) => ({
  list: {
    recordId: "rec-1",
    exporter: { userId: "u-ann", email: "stale@old.io", role: "Admin", at: "2026-10-14T03:00:00.000Z" },
    fileRecord: { recordId: "rec-1", mode: "baseline", sha256: "abc", count: 2 },
    files: [{ path: "files/P-100.pdf", documentId: "d1", versionId: "v1" }, { path: "files/P-200.pdf", documentId: "d2", versionId: "v2" }],
    undelivered: null,
    ...over,
  },
});

beforeEach(() => {
  s.gate = null; s.gateCalls = []; s.rebuilt = LIST(); s.rebuildCalls = []; s.memberSelects = [];
  s.member = { data: { email: "ann@acme.com", role: "Admin", status: "active" }, error: null };
});

describe("ALOG-11 hand-off (P13) — /api/admin/audit/export-files", () => {
  it("asks the Audit log surface's gate, then rebuilds the list for that workspace and record", async () => {
    const res = await GET(get("&recordId=rec-1"));
    expect(res.status).toBe(200);
    expect(s.gateCalls[0].slice(1)).toEqual([O1, "audit"]);
    expect(s.rebuildCalls[0].slice(1)).toEqual([O1, "rec-1"]);
  });

  it("a refused gate answers its own status, and nothing is rebuilt", async () => {
    s.gate = { error: "Only people with the Audit log permission can open this page.", status: 403 };
    const res = await GET(get("&recordId=rec-1"));
    expect(res.status).toBe(403);
    expect(s.rebuildCalls).toHaveLength(0);
  });

  it("the exporter is the user id's CURRENT member, not the stored email; the stored email is returned apart", async () => {
    const body = await (await GET(get("&recordId=rec-1"))).json() as Row;
    expect(body.exporter).toEqual({ kind: "member", userId: "u-ann", email: "ann@acme.com", role: "Admin", roles: ["Admin"], status: "active" });
    expect(body.stored).toEqual({ email: "stale@old.io", role: "Admin" });
    expect(body.files).toHaveLength(2);
  });

  it("integrator fix pass: the exporter's roles are role ∪ roles (headline and additive), read now — never the headline alone", async () => {
    s.member = { data: { email: "ann@acme.com", role: "Engineer-2", roles: ["Engineer-2", "DocCtrl", " ", 7, "DocCtrl"], status: "active" }, error: null };
    const body = await (await GET(get("&recordId=rec-1"))).json() as Row;
    expect(s.memberSelects).toEqual(["email, role, roles, status"]);
    expect(body.exporter).toEqual({ kind: "member", userId: "u-ann", email: "ann@acme.com", role: "Engineer-2", roles: ["Engineer-2", "DocCtrl"], status: "active" });
    expect(exporterSentence(body.exporter as Parameters<typeof exporterSentence>[0]))
      .toBe("ann@acme.com (Engineer-2, DocCtrl): this user id's current membership of the workspace, read now.");
    // a membership with no collection (an older row) is its headline, as before
    s.member = { data: { email: "ann@acme.com", role: "Admin", roles: null, status: "active" }, error: null };
    expect(((await (await GET(get("&recordId=rec-1"))).json()) as Row).exporter).toMatchObject({ role: "Admin", roles: ["Admin"] });
    // an additive role with no headline is still shown
    s.member = { data: { email: "ann@acme.com", role: null, roles: ["Auditor"], status: "active" }, error: null };
    const add = ((await (await GET(get("&recordId=rec-1"))).json()) as Row).exporter as Parameters<typeof exporterSentence>[0];
    expect(exporterSentence(add)).toBe("ann@acme.com (Auditor): this user id's current membership of the workspace, read now.");
  });

  it("undelivered null is 'no delivery failure recorded' (failureRecorded false) — never 'delivered'; a recorded failure is said", async () => {
    let body = await (await GET(get("&recordId=rec-1"))).json() as Row;
    expect(body.delivery).toEqual({ failureRecorded: false });
    expect(JSON.stringify(body)).not.toMatch(/delivered/i);
    s.rebuilt = LIST({ undelivered: { error: "Webhook 500", at: "2026-10-14T03:01:00.000Z" } });
    body = await (await GET(get("&recordId=rec-1"))).json() as Row;
    expect(body.delivery).toEqual({ failureRecorded: true, error: "Webhook 500", at: "2026-10-14T03:01:00.000Z" });
  });

  it("a machine row is the scheduled push; a uid no longer a member, or an unreadable membership, is said so", async () => {
    s.rebuilt = LIST({ exporter: { userId: null, email: "system:scheduled-export", role: "system", at: null } });
    expect((await (await GET(get("&recordId=rec-1"))).json() as Row).exporter).toEqual({ kind: "machine", label: "system:scheduled-export" });
    s.rebuilt = LIST();
    s.member = { data: null, error: null };
    expect((await (await GET(get("&recordId=rec-1"))).json() as Row).exporter).toEqual({ kind: "former", userId: "u-ann" });
    s.member = { data: null, error: { message: "timeout" } };
    expect((await (await GET(get("&recordId=rec-1"))).json() as Row).exporter).toEqual({ kind: "unread", userId: "u-ann", error: "timeout" });
  });

  it("a list that cannot be rebuilt answers 422 with the lib's problem; no recordId is 400", async () => {
    s.rebuilt = { list: null, problem: "no export is recorded under rec-9" };
    const res = await GET(get("&recordId=rec-9"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "no export is recorded under rec-9" });
    expect((await GET(get(""))).status).toBe(400);
  });

  it("the sentences: never 'delivered'; the current member, or the machine, or a former member", () => {
    expect(deliverySentence({ failureRecorded: false })).toBe("No delivery failure recorded. (This is not proof of delivery: a delivery stopped mid-flight records nothing.)");
    // DEC-87 §1 (P14 correction): a webhook's 500 can come after it received
    // the whole archive, and the UNDELIVERED row does not say which — so a
    // recorded failure never says nothing reached the other end.
    const failed = deliverySentence({ failureRecorded: true, error: "Webhook 500", at: null });
    expect(failed).toBe("Delivery failure recorded: Webhook 500. The record does not say whether it came before or after the archive was sent. If it came after (a webhook that answered with an error once it had the archive, a bucket read-back that failed), the destination may still hold these files: treat each file below as possibly taken.");
    expect(failed).not.toMatch(/nothing reached|never left|not delivered|did not leave/i);
    expect(exporterSentence({ kind: "member", userId: "u", email: "ann@acme.com", role: "Admin", status: "suspended" })).toBe("ann@acme.com (Admin) — suspended: this user id's current membership of the workspace, read now.");
    expect(exporterSentence({ kind: "machine", label: null })).toMatch(/scheduled push/);
    expect(exporterSentence({ kind: "former", userId: "u-x" })).toMatch(/no longer in this workspace/);
  });
});

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ALOG-11 hand-off (P13) — the Files control, rendered", () => {
  let host: HTMLDivElement;
  let root: Root;
  const fetches: string[] = [];
  let delivery: Record<string, unknown> = { failureRecorded: false };
  beforeEach(() => {
    fetches.length = 0;
    delivery = { failureRecorded: false };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetches.push(String(url));
      return new Response(JSON.stringify({
        recordId: "rec-1", exportedAt: null,
        exporter: { kind: "member", userId: "u-ann", email: "ann@acme.com", role: "Admin", roles: ["Admin", "Auditor"], status: "active" },
        stored: { email: "stale@old.io", role: "Admin" },
        files: [{ path: "files/P-100.pdf", documentId: "d1111111", versionId: "v1111111" }],
        delivery,
      }), { status: 200 });
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  it("opens on click, asks the route for that record, and shows the current member, the stored email apart, no-failure wording and the files", async () => {
    await act(async () => { root.render(React.createElement(ExportFilesPanel, { orgId: O1, recordId: "rec-1" })); });
    expect(fetches).toHaveLength(0); // nothing is read until asked
    const btn = host.querySelector("button") as HTMLButtonElement;
    await act(async () => { btn.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(fetches[0]).toBe(`/api/admin/audit/export-files?orgId=${O1}&recordId=rec-1`);
    const t = host.textContent ?? "";
    expect(t).toContain("Taken by: ann@acme.com (Admin, Auditor): this user id's current membership");
    expect(t).toContain("Stored on the row: stale@old.io (Admin)");
    expect(t).toContain("No delivery failure recorded.");
    expect(t).not.toMatch(/\bDelivered\b/);
    expect(t).toContain("1 file in this export");
    expect(t).toContain("files/P-100.pdf");
  });

  it("fix pass (DEC-87 §1): a recorded failure (a webhook's 500) says the destination may hold the files — never that nothing reached it", async () => {
    delivery = { failureRecorded: true, error: "Webhook 500: Internal Server Error", at: null };
    await act(async () => { root.render(React.createElement(ExportFilesPanel, { orgId: O1, recordId: "rec-1" })); });
    await act(async () => { (host.querySelector("button") as HTMLButtonElement).click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const t = host.textContent ?? "";
    expect(t).toContain("Delivery failure recorded: Webhook 500: Internal Server Error.");
    expect(t).toContain("the destination may still hold these files: treat each file below as possibly taken.");
    expect(t).not.toMatch(/nothing reached/i);
    expect(t).toContain("files/P-100.pdf");
  });
});
