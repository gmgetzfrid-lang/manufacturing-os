// drafting-flow Round G, DF-P18 — intelligence GAP-312 (equipment after
// filing): POST /api/tickets/equipment, DEC-90 ruling (4) for DF-P18 — the
// request's participants and the assignment queue only, the workspace
// checked on the server, the audit row FIRST and then a checked write; before
// 20261251 a 503 with nothing written.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { MemoryState } from "./helpers/memoryDb";

const h = vi.hoisted(() => ({
  admin: null as unknown as MemoryState,
  user: { id: "u-req", email: "req@plant.io" } as { id: string; email: string } | null,
  policy: { ok: true, policy: undefined, version: null } as Record<string, unknown>,
}));

vi.mock("@/lib/supabaseAdmin", async () => {
  const mem = await import("./helpers/memoryDb");
  h.admin = mem.freshState();
  const sb = mem.makeSupabase(h.admin) as Record<string, unknown>;
  sb.auth = { getUser: async () => (h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) };
  return { supabaseAdmin: sb };
});
vi.mock("@/lib/capabilityPolicy", async (orig) => ({
  ...(await orig<typeof import("@/lib/capabilityPolicy")>()),
  loadCapabilityPolicyStrict: vi.fn(async () => h.policy),
}));

import { POST } from "@/app/api/tickets/equipment/route";
import { resetState } from "./helpers/memoryDb";

type Row = Record<string, unknown>;
const ORG = "o-1";
const T = "11111111-1111-4111-8111-111111111111";
const ASSET = "5a000000-0000-4000-8000-000000000001";
const req = (body: unknown) => POST(new NextRequest("https://app.plant.io/api/tickets/equipment", {
  method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const seed = (ticket: Row = {}) => {
  resetState(h.admin);
  h.user = { id: "u-req", email: "req@plant.io" };
  h.policy = { ok: true, policy: undefined, version: null };
  h.admin.tables.tickets = [{
    id: T, org_id: ORG, status: "DRAFTING", archived_at: null, request_type: "ISO", unit: null,
    requester_id: "u-req", assigned_drafter_id: "u-drf", assigned_engineer_id: null, watchers: [], ...ticket,
  }];
  h.admin.tables.org_members = [
    { org_id: ORG, uid: "u-req", role: "Viewer", roles: [], email: "req@plant.io", status: "active" },
    { org_id: ORG, uid: "u-drf", role: "Drafter", roles: [], email: "drf@plant.io", status: "active" },
    { org_id: ORG, uid: "u-sup", role: "Supervisor", roles: [], email: "sup@plant.io", status: "active" },
    { org_id: ORG, uid: "u-other", role: "Viewer", roles: [], email: "other@plant.io", status: "active" },
    { org_id: "o-2", uid: "u-alien", role: "Admin", roles: [], email: "alien@x.io", status: "active" },
  ];
  h.admin.tables.assets = [{ id: ASSET, org_id: ORG, tag: "P-101", tag_normalized: "p101", archived: false }, { id: "other-org-asset", org_id: "o-2", tag: "P-102", tag_normalized: "p102", archived: false }];
  h.admin.tables.ticket_equipment = [];
};
const equipment = () => (h.admin.tables.ticket_equipment ?? []) as Row[];
const audits = () => (h.admin.tables.audit_logs ?? []) as Row[];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  seed();
});

describe("who may (ruling (4))", () => {
  it("the requester adds a tag: resolved through the registry's one tag grammar in THIS workspace; audit row first", async () => {
    const res = await req({ ticketId: T, action: "add", tag: " p 101 " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tag: "p 101", assetId: ASSET, resolution: "linked" });
    expect(equipment()).toHaveLength(1);
    expect(equipment()[0]).toMatchObject({ org_id: ORG, ticket_id: T, tag: "p 101", asset_id: ASSET, created_by: "u-req" });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ action: "TICKET_EQUIPMENT_ADDED", resource_id: T, org_id: ORG, user_id: "u-req" });
    const order = h.admin.writes.map((w) => w.table);
    expect(order.indexOf("audit_logs")).toBeLessThan(order.indexOf("ticket_equipment"));
  });
  it("the assigned drafter may; the assignment queue (ticket.assign) may; another member may not (403, nothing written)", async () => {
    h.user = { id: "u-drf", email: "drf@plant.io" };
    expect((await req({ ticketId: T, action: "add", tag: "XV-9" })).status).toBe(200);
    h.user = { id: "u-sup", email: "sup@plant.io" };
    expect((await req({ ticketId: T, action: "add", tag: "XV-10" })).status).toBe(200);
    h.user = { id: "u-other", email: "other@plant.io" };
    const before = equipment().length;
    const refused = await req({ ticketId: T, action: "add", tag: "XV-11" });
    expect(refused.status).toBe(403);
    expect(equipment()).toHaveLength(before);
  });
  it("a member of another workspace is refused (server-side org check), nothing written", async () => {
    h.user = { id: "u-alien", email: "alien@x.io" };
    expect((await req({ ticketId: T, action: "add", tag: "P-101" })).status).toBe(403);
    expect(equipment()).toEqual([]);
    expect(audits()).toEqual([]);
  });
  it("an unreadable permissions policy refuses a non-participant (503), never the defaults", async () => {
    h.user = { id: "u-sup", email: "sup@plant.io" };
    h.policy = { ok: false, error: "down" };
    expect((await req({ ticketId: T, action: "add", tag: "P-101" })).status).toBe(503);
    expect(equipment()).toEqual([]);
  });
  it("a closed, canceled or archived request is not changed (409)", async () => {
    for (const over of [{ status: "CLOSED" }, { status: "CANCELED" }, { archived_at: "2026-10-01T00:00:00Z" }]) {
      seed(over);
      expect((await req({ ticketId: T, action: "add", tag: "P-101" })).status).toBe(409);
      expect(equipment()).toEqual([]);
    }
  });
});

describe("what is written", () => {
  it("a tag the registry does not know (or another workspace's asset) is kept as typed, flagged", async () => {
    const res = await req({ ticketId: T, action: "add", tag: "P-102" });
    expect(await res.json()).toMatchObject({ assetId: null, resolution: "not_found" });
    expect(equipment()[0]).toMatchObject({ tag: "P-102", asset_id: null });
  });
  it("a lookup that fails keeps the tag as typed and says so", async () => {
    h.admin.readError.assets = { code: "57014", message: "timeout" };
    const out = await (await req({ ticketId: T, action: "add", tag: "P-101" })).json();
    expect(out).toMatchObject({ assetId: null, resolution: "lookup_failed" });
    expect(out.message).toMatch(/lookup failed/);
  });
  it("a correction adds the corrected row, then removes the one it replaces; the audit row names both", async () => {
    h.admin.tables.ticket_equipment = [{ id: "eq-1", org_id: ORG, ticket_id: T, tag: "P-1O1", asset_id: null, created_by: "u-req" }];
    const res = await req({ ticketId: T, action: "correct", rowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tag: "P-101" });
    expect(res.status).toBe(404);
    h.admin.tables.ticket_equipment = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", org_id: ORG, ticket_id: T, tag: "P-1O1", asset_id: null, created_by: "u-req" }];
    const ok = await req({ ticketId: T, action: "correct", rowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tag: "P-101" });
    expect(ok.status).toBe(200);
    expect(equipment()).toHaveLength(1);
    expect(equipment()[0]).toMatchObject({ tag: "P-101", asset_id: ASSET });
    const row = audits().find((a) => a.action === "TICKET_EQUIPMENT_CORRECTED")!;
    expect(row.details).toMatchObject({ tag: "P-101", assetId: ASSET, replaces: { rowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tag: "P-1O1", assetId: null } });
  });
  it("an audit row that cannot be written refuses the change (500), nothing applied", async () => {
    h.admin.tableWriteError = { audit_logs: { code: "42501", message: "denied" } };
    const res = await req({ ticketId: T, action: "add", tag: "P-101" });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("audit_unwritable");
    expect(equipment()).toEqual([]);
  });
  it("before 20261251 (no table): 503 not_migrated, nothing written — not even the audit row", async () => {
    h.admin.readError.ticket_equipment = { code: "42P01", message: 'relation "ticket_equipment" does not exist' };
    const res = await req({ ticketId: T, action: "add", tag: "P-101" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("not_migrated");
    expect(audits()).toEqual([]);
  });
  it("a bad body is refused before anything is read", async () => {
    expect((await req({ ticketId: "nope", action: "add", tag: "P-101" })).status).toBe(400);
    expect((await req({ ticketId: T, action: "delete", tag: "P-101" })).status).toBe(400);
    expect((await req({ ticketId: T, action: "add", tag: "" })).status).toBe(400);
    expect((await req({ ticketId: T, action: "correct", tag: "P-101" })).status).toBe(400);
  });
});

describe("the request page's control (source)", () => {
  const card = readFileSync(join(process.cwd(), "components", "requests", "DeclarationCard.tsx"), "utf8");
  const page = readFileSync(join(process.cwd(), "app", "(protected)", "requests", "[id]", "page.tsx"), "utf8");
  it("posts to the route; says the list is not available before 20261251; shown only where the route would take it", () => {
    expect(card).toContain('fetch("/api/tickets/equipment"');
    expect(card).toContain("EQUIPMENT_NOT_AVAILABLE");
    expect(card).toContain("{canEditEquipment && equipment !== null && (");
    expect(page).toContain("(isTicketParticipant(ticket, uid) || (!policyFault && !!capPolicy && activeRole !== null && policyAllows(capPolicy, 'ticket.assign', activeRole, roles, uid, ticketResource(ticket))))");
  });
});
