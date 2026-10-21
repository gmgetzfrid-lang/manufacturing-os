// drafting-flow Round G, DF-P7 CONSENT — DEC-90 ruling (6) (the merge-time
// fix pass), end to end through the real export (lib/dataExport.ts
// runOrgExport over the in-memory database): ticket_notice_events is
// EXPORTED (the integrator's decision), but a 'not_emailed' row's
// details.reason — a member's own email-preference reason — never leaves
// the database. Every other row of that table, and every other table, is
// exported byte-for-byte as before.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "./helpers/restoreMemoryDb";

vi.mock("@supabase/supabase-js", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return { createClient: () => ({ from: mem.from }) };
});
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({ ContentLength: 4, ContentType: "application/octet-stream" })) }, R2_BUCKET: "test-bucket" }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_c: unknown, cmd: { input: { Key: string } }) => `https://r2.test/${cmd.input.Key}`),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));

import { runOrgExport } from "@/lib/dataExport";

const ORG = "66666666-6666-4666-8666-666666666666";
const NOTICE = [
  { id: "ne-1", org_id: ORG, ticket_id: "tk-1", roster_id: "r-1", slot_kind: "ops", kind: "delivered", recipient: "u-1", notification_id: "n-1", actor_name: "system:consent-window", details: { phase: "opened" }, created_at: "2026-10-19T09:00:00Z" },
  { id: "ne-2", org_id: ORG, ticket_id: "tk-1", roster_id: "r-1", slot_kind: "ops", kind: "not_emailed", recipient: "u-2", notification_id: null, actor_name: "system:consent-window", details: { reason: "turned off assignment emails", event: "assignment", phase: "opened" }, created_at: "2026-10-19T09:00:01Z" },
  { id: "ne-3", org_id: ORG, ticket_id: "tk-1", roster_id: "r-1", slot_kind: "ops", kind: "blocked", recipient: null, notification_id: null, actor_name: "system:consent-window", details: { reason: "window_never_opened", escalatedTo: [] }, created_at: "2026-10-19T09:00:02Z" },
];
// Other tables carrying the very same shape — kind 'not_emailed', a details.reason — are untouched.
const OTHERS: Record<string, Array<Record<string, unknown>>> = {
  tickets: [{ id: "tk-1", org_id: ORG, title: "Gasket", status: "PENDING_REVIEW", attachments: [], metadata: { kind: "not_emailed", details: { reason: "kept" } } }],
  audit_logs: [{ id: "al-1", org_id: ORG, action: "EMAIL_SKIPPED", details: { kind: "not_emailed", reason: "kept verbatim" } }],
  notes: [{ id: "no-1", org_id: ORG, body: "x", kind: "not_emailed", details: { reason: "kept verbatim" } }],
};

beforeEach(() => {
  db.rows = {
    orgs: [{ id: ORG, name: "Acme" }],
    org_members: [{ org_id: ORG, uid: "u-1", email: "u1@acme.com", role: "Admin", roles: ["Admin"], status: "active" }],
    ticket_notice_events: JSON.parse(JSON.stringify(NOTICE)),
    ...JSON.parse(JSON.stringify(OTHERS)),
  };
});

describe("DEC-90 ruling (6) — the export strips a not_emailed row's private reason", () => {
  it("ticket_notice_events is exported; the not_emailed row keeps everything but details.reason; the other kinds are verbatim", async () => {
    const env = await runOrgExport({ supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: ORG, exporterUserId: "u-1", exporterEmail: "u1@acme.com" });
    const rows = env.tables.ticket_notice_events as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual(["ne-1", "ne-2", "ne-3"]);
    expect(rows[1]).toEqual({ ...NOTICE[1], details: { event: "assignment", phase: "opened" } });
    expect(JSON.stringify(rows)).not.toContain("turned off assignment emails");
    expect(JSON.stringify(rows[0])).toBe(JSON.stringify(NOTICE[0]));
    expect(JSON.stringify(rows[2])).toBe(JSON.stringify(NOTICE[2]));
    // the source rows are not mutated
    expect((db.rows.ticket_notice_events[1].details as Record<string, unknown>).reason).toBe("turned off assignment emails");
    expect(env.manifest.notes.join(" ")).toMatch(/PRIVATE fields left out of some rows: ticket_notice_events: a 'not_emailed' row's details\.reason/);
  });
  it("REGRESSION: every other table's export bytes are unchanged (the same shape elsewhere is exported verbatim)", async () => {
    const env = await runOrgExport({ supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc", orgId: ORG, exporterUserId: "u-1", exporterEmail: "u1@acme.com" });
    for (const [t, seeded] of Object.entries(OTHERS)) expect(JSON.stringify(env.tables[t]), t).toBe(JSON.stringify(seeded));
    expect(JSON.stringify(env.tables.orgs)).toBe(JSON.stringify([{ id: ORG, name: "Acme" }]));
  });
});
