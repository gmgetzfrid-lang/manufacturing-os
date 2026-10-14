// admin-and-org Round G, package P13 — drafting-flow EVID-6's remainder: the
// audit dead-letter outbox.
//   * lib/audit.ts logAuditAction: a refused (or thrown) insert is kept in
//     public.audit_dead_letters (20261219) through lib/auditOutbox.ts — the
//     server's own client here (node); the result is unchanged
//     ({ ok: false, error }) and the log says whether it was kept; a landed
//     row writes no dead letter (regression);
//   * app/api/audit/dead-letter: verifies the caller (an active member,
//     writing about themself or no one), bounds and rate-limits, keeps the
//     writer's word labelled with the verified reporter; 503 before the paste;
//   * lib/auditOutboxDrain.ts: the cron's drain — each outbox row becomes ONE
//     AUDIT_DEAD_LETTER machine row typed org (audit viewers only), stamped
//     drained; a refused write stays undrained with its attempt and error; a
//     row already written is only stamped; the run's errors say what was
//     recovered; nothing before the paste;
//   * app/api/cron/maintenance: ONE step (7d) with its own bounded budget.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { db, from as memFrom, type Row } from "./helpers/restoreMemoryDb";

const s = vi.hoisted(() => ({
  insertErrors: {} as Record<string, { message: string; code?: string } | null>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  throwOn: null as string | null,
  actor: null as null | { userId: string; email: string; role: string; roles: string[] } | { error: string; status: number },
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (s.throwOn === table) throw new Error("fetch failed");
        s.inserts.push({ table, row });
        return { data: null, error: s.insertErrors[table] ?? null };
      },
    }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));
vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: Request, orgId: string) => {
      const a = s.actor;
      if (!a) return { error: "Missing access token", status: 401 };
      if ("error" in a) return a;
      return { ...a, orgId, admin: { from: mem.from } };
    }),
  };
});

import { logAuditAction } from "@/lib/audit";
import { DEAD_LETTER_HOURLY_CAP } from "@/lib/auditOutbox";
import { drainAuditDeadLetters, AUDIT_OUTBOX_ACTOR, AUDIT_DEAD_LETTER_ACTION } from "@/lib/auditOutboxDrain";
import { POST as deadLetterPOST } from "@/app/api/audit/dead-letter/route";
import { AUDIT_ACTIONS } from "@/lib/auditActions";

const ORG = "11111111-1111-4111-8111-111111111111";
const UID = "22222222-2222-4222-8222-222222222222";
let logged: string[] = [];

beforeEach(() => {
  s.insertErrors = {}; s.inserts = []; s.throwOn = null; s.actor = null;
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
  db.rows = { audit_dead_letters: [], audit_logs: [] };
  db.readError = {}; db.writeError = null; db.keys = {}; db.defaults = {}; db.maxRows = 1000;
});

describe("EVID-6 (P13) — logAuditAction dead-letters a refused row (server branch)", () => {
  it("reproduced: a refused insert was only returned and logged; now it is also kept in the outbox, the result unchanged", async () => {
    s.insertErrors.audit_logs = { message: "new row violates row-level security policy" };
    const r = await logAuditAction({ action: "REVIEW_ALTERNATE_ACTIVATED", resourceId: "d1", resourceType: "document", orgId: ORG, userId: UID, userEmail: "a@x.io", userRole: "DocCtrl", details: { signoffId: "s1" } });
    expect(r).toEqual({ ok: false, error: "new row violates row-level security policy" });
    const dl = s.inserts.find((i) => i.table === "audit_dead_letters");
    expect(dl?.row).toMatchObject({
      org_id: ORG, action: "REVIEW_ALTERNATE_ACTIVATED", source: "server", reported_by: null,
      error: "new row violates row-level security policy",
      entry: { row: { action: "REVIEW_ALTERNATE_ACTIVATED", resource_id: "d1", resource_type: "document", org_id: ORG, user_id: UID, user_email: "a@x.io", user_role: "DocCtrl", details: { signoffId: "s1" } }, reporter: null },
    });
    // the refusal's own line is unchanged (checkoutRoundF pins it); a second line says it was kept
    expect(logged).toContain("Failed to write audit log (REVIEW_ALTERNATE_ACTIVATED): new row violates row-level security policy");
    expect(logged.some((l) => /^Audit log \(REVIEW_ALTERNATE_ACTIVATED\): the refused row was kept in the audit dead-letter outbox/.test(l))).toBe(true);
  });

  it("a thrown insert is dead-lettered too", async () => {
    s.throwOn = "audit_logs";
    const r = await logAuditAction({ action: "VIEW", resourceId: "d1", resourceType: "document", orgId: ORG, userId: UID });
    expect(r).toEqual({ ok: false, error: "fetch failed" });
    expect(s.inserts.filter((i) => i.table === "audit_dead_letters")).toHaveLength(1);
  });

  it("before 20261219 (the outbox missing) the row is not kept — today's path: returned and logged, saying why", async () => {
    s.insertErrors.audit_logs = { message: "timeout" };
    s.insertErrors.audit_dead_letters = { message: 'relation "public.audit_dead_letters" does not exist', code: "42P01" };
    const r = await logAuditAction({ action: "VIEW", resourceId: "d1", resourceType: "document", orgId: ORG, userId: UID });
    expect(r).toEqual({ ok: false, error: "timeout" });
    expect(logged.some((l) => /NOT kept in the audit dead-letter outbox \(relation "public.audit_dead_letters" does not exist\)/.test(l))).toBe(true);
  });

  it("regression: a landed row writes no dead letter and answers as before; a row with no workspace is refused before any write", async () => {
    expect(await logAuditAction({ action: "VIEW", resourceId: "d1", resourceType: "document", orgId: ORG, userId: UID })).toEqual({ error: null, ok: true });
    expect(s.inserts.map((i) => i.table)).toEqual(["audit_logs"]);
    s.inserts = [];
    const r = await logAuditAction({ action: "VIEW", resourceId: "d1", resourceType: "document", userId: UID });
    expect(r.ok).toBe(false);
    expect(s.inserts).toEqual([]);
  });

  it("the registry names AUDIT_DEAD_LETTER (the viewers can filter it)", () => {
    expect(AUDIT_ACTIONS.some((a) => a.action === AUDIT_DEAD_LETTER_ACTION && a.category === "system")).toBe(true);
  });
});

describe("EVID-6 (P13) — /api/audit/dead-letter verifies the caller before it keeps anything", () => {
  const post = (body: unknown, raw?: string) => new NextRequest("http://x/api/audit/dead-letter", {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: raw ?? JSON.stringify(body),
  });
  const entry = (over: Row = {}) => ({ action: "NODE_ACL_CHANGED", resource_id: "lib-1", resource_type: "library", org_id: ORG, user_id: UID, user_email: "forged@x.io", user_role: "Admin", details: { before: {}, after: {} }, metadata: null, ...over });
  const me = { userId: UID, email: "me@x.io", role: "DocCtrl", roles: ["DocCtrl"] };

  it("no session / not an active member: the gate's refusal, nothing kept", async () => {
    expect((await deadLetterPOST(post({ orgId: ORG, entry: entry(), error: "x" }))).status).toBe(401);
    s.actor = { error: "Not an active member of this workspace", status: 403 };
    expect((await deadLetterPOST(post({ orgId: ORG, entry: entry(), error: "x" }))).status).toBe(403);
    expect(db.rows.audit_dead_letters).toEqual([]);
  });

  it("a member's own row is kept as the writer's word, with the verified reporter beside it", async () => {
    s.actor = me;
    const res = await deadLetterPOST(post({ orgId: ORG, entry: entry(), error: "new row violates row-level security policy" }));
    expect(res.status).toBe(201);
    expect(db.rows.audit_dead_letters).toHaveLength(1);
    expect(db.rows.audit_dead_letters[0]).toMatchObject({
      org_id: ORG, action: "NODE_ACL_CHANGED", source: "browser", reported_by: UID, error: "new row violates row-level security policy",
      entry: { row: { user_id: UID, user_email: "forged@x.io", user_role: "Admin", resource_type: "library" }, reporter: { uid: UID, email: "me@x.io", role: "DocCtrl", roles: ["DocCtrl"] } },
    });
  });

  it("a row naming someone else, or another workspace, is refused 403; a stand-in names no one (user_id null)", async () => {
    s.actor = me;
    expect((await deadLetterPOST(post({ orgId: ORG, entry: entry({ user_id: "33333333-3333-4333-8333-333333333333" }) }))).status).toBe(403);
    expect((await deadLetterPOST(post({ orgId: ORG, entry: entry({ org_id: "99999999-9999-4999-8999-999999999999" }) }))).status).toBe(403);
    expect(db.rows.audit_dead_letters).toEqual([]);
    expect((await deadLetterPOST(post({ orgId: ORG, entry: entry({ user_id: null }) }))).status).toBe(201);
    expect((db.rows.audit_dead_letters[0].entry as { row: Row }).row.user_id).toBeNull();
  });

  it("a malformed action is 400, an oversized body 413, a flood past the hourly cap 429", async () => {
    s.actor = me;
    expect((await deadLetterPOST(post({ orgId: ORG, entry: entry({ action: "drop table" }) }))).status).toBe(400);
    expect((await deadLetterPOST(post(null, JSON.stringify({ orgId: ORG, entry: entry({ details: { pad: "x".repeat(300_000) } }) })))).status).toBe(413);
    const recent = new Date().toISOString();
    db.rows.audit_dead_letters = Array.from({ length: DEAD_LETTER_HOURLY_CAP }, (_, i) => ({ id: `d${i}`, org_id: ORG, reported_by: UID, drained_at: null, reported_at: recent }));
    expect((await deadLetterPOST(post({ orgId: ORG, entry: entry() }))).status).toBe(429);
  });

  it("before 20261219 (the table missing) it answers 503 — the caller keeps today's path", async () => {
    s.actor = me;
    db.readError = { audit_dead_letters: 'relation "public.audit_dead_letters" does not exist' };
    const res = await deadLetterPOST(post({ orgId: ORG, entry: entry() }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/not installed yet \(20261219 not applied\)/);
  });
});

describe("EVID-6 (P13) — the drain writes each lost row as an AUDIT_DEAD_LETTER machine row and reports it", () => {
  const sb = { from: memFrom } as unknown as Parameters<typeof drainAuditDeadLetters>[0];
  const outbox = (id: string, at: string, over: Row = {}): Row => ({
    id, org_id: ORG, action: "NODE_ACL_CHANGED", source: "browser", reported_by: UID, reported_at: at, drain_attempts: 0, drained_at: null,
    error: "refused", entry: { row: { action: "NODE_ACL_CHANGED", resource_type: "library", resource_id: "lib-1", user_id: UID, user_email: "forged@x.io" }, reporter: { uid: UID, email: "me@x.io" } },
    ...over,
  });
  const later = () => Date.now() + 60_000;

  it("each row becomes ONE machine row typed org (audit viewers only), carrying the lost row as sent and the verified reporter; the outbox row is stamped", async () => {
    db.rows.audit_dead_letters = [outbox("o1", "2026-10-14T01:00:00.000Z"), outbox("o2", "2026-10-14T02:00:00.000Z", { action: "VIEW", source: "server", reported_by: null })];
    const errors: string[] = [];
    const r = await drainAuditDeadLetters(sb, { stopBy: later(), errors });
    expect(r).toEqual({ drained: 2, failed: 0, orgs: 1 });
    const written = db.rows.audit_logs;
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      action: AUDIT_DEAD_LETTER_ACTION, resource_type: "org", resource_id: ORG, org_id: ORG,
      user_id: null, user_email: AUDIT_OUTBOX_ACTOR, user_role: "system",
      details: { outboxId: "o1", lostAction: "NODE_ACL_CHANGED", lost: { user_email: "forged@x.io", asSent: true }, reportedBy: UID, reporter: { uid: UID, email: "me@x.io" }, source: "browser", error: "refused" },
    });
    // never the lost action itself
    expect(written.some((w) => w.action === "NODE_ACL_CHANGED" || w.action === "VIEW")).toBe(false);
    for (const o of db.rows.audit_dead_letters) {
      expect(o.drained_at).toBeTruthy();
      expect(o.audit_log_id).toBe(written.find((w) => (w.details as Row).outboxId === o.id)!.id);
    }
    expect(errors).toEqual([expect.stringMatching(/^audit-outbox: 2 audit row\(s\) that could not be written were recovered into the audit log as AUDIT_DEAD_LETTER \(2 in workspace 11111111/)]);
  });

  it("a refused write leaves the row undrained, counts its attempt and keeps the refusal; the next run retries it", async () => {
    db.rows.audit_dead_letters = [outbox("o1", "2026-10-14T01:00:00.000Z")];
    db.writeError = (table, op) => (table === "audit_logs" && op === "insert" ? { code: "23514", message: "check violation" } : null);
    const errors: string[] = [];
    expect(await drainAuditDeadLetters(sb, { stopBy: later(), errors })).toEqual({ drained: 0, failed: 1, orgs: 0 });
    expect(db.rows.audit_dead_letters[0]).toMatchObject({ drained_at: null, drain_attempts: 1, drain_error: "check violation" });
    expect(errors[0]).toMatch(/could not be written to the audit log \(check violation\); it stays in the outbox/);
    db.writeError = null;
    expect(await drainAuditDeadLetters(sb, { stopBy: later(), errors: [] })).toEqual({ drained: 1, failed: 0, orgs: 1 });
  });

  it("a row already written (its drained stamp refused last run) is stamped, never written twice", async () => {
    db.rows.audit_dead_letters = [outbox("o1", "2026-10-14T01:00:00.000Z")];
    db.rows.audit_logs = [{ id: "a-prior", org_id: ORG, action: AUDIT_DEAD_LETTER_ACTION, resource_type: "org", resource_id: ORG, user_id: null, details: { outboxId: "o1" } }];
    expect(await drainAuditDeadLetters(sb, { stopBy: later(), errors: [] })).toEqual({ drained: 1, failed: 0, orgs: 1 });
    expect(db.rows.audit_logs).toHaveLength(1);
    expect(db.rows.audit_dead_letters[0].audit_log_id).toBe("a-prior");
  });

  it("drained rows are not read again; a past deadline drains nothing; before 20261219 nothing is done and nothing said", async () => {
    db.rows.audit_dead_letters = [outbox("o1", "2026-10-14T01:00:00.000Z", { drained_at: "2026-10-14T03:00:00.000Z" })];
    const errors: string[] = [];
    expect(await drainAuditDeadLetters(sb, { stopBy: later(), errors })).toEqual({ drained: 0, failed: 0, orgs: 0 });
    db.rows.audit_dead_letters = [outbox("o2", "2026-10-14T01:00:00.000Z")];
    expect(await drainAuditDeadLetters(sb, { stopBy: Date.now() - 1, errors })).toEqual({ drained: 0, failed: 0, orgs: 0 });
    db.readError = { audit_dead_letters: 'relation "public.audit_dead_letters" does not exist' };
    expect(await drainAuditDeadLetters(sb, { stopBy: later(), errors })).toEqual({ drained: 0, failed: 0, orgs: 0 });
    expect(errors).toEqual([]);
  });

  it("pages past a full page (keyset on reported_at, id)", async () => {
    db.rows.audit_dead_letters = Array.from({ length: 120 }, (_, i) => outbox(`o${String(i).padStart(3, "0")}`, "2026-10-14T01:00:00.000Z"));
    expect(await drainAuditDeadLetters(sb, { stopBy: later(), errors: [] })).toEqual({ drained: 120, failed: 0, orgs: 1 });
    expect(db.rows.audit_logs).toHaveLength(120);
  });
});

describe("EVID-6 (P13) — the maintenance cron carries ONE drain step with its own bounded budget", () => {
  const src = readFileSync(join(process.cwd(), "app", "api", "cron", "maintenance", "route.ts"), "utf8");
  it("step 7d: drainAuditDeadLetters, its own AUDIT_OUTBOX_MS budget never past the run's end, skipped (and said) when the run has no time", () => {
    expect(src.match(/drainAuditDeadLetters\(/g)?.length).toBe(1);
    expect(src).toContain('if (!noTimeFor("audit-outbox", AUDIT_OUTBOX_MIN_MS)) {');
    expect(src).toContain("result.auditOutbox = await drainAuditDeadLetters(sb, { stopBy: Math.min(runEnd, Date.now() + AUDIT_OUTBOX_MS), errors: result.errors });");
    expect(src).toMatch(/const AUDIT_OUTBOX_MS = 15_000;/);
    // after the push-subscription prune (7c), before the knowledge sync (8)
    expect(src.indexOf("prunePushSubscriptions(sb, result.errors")).toBeLessThan(src.indexOf("drainAuditDeadLetters(sb"));
    expect(src.indexOf("drainAuditDeadLetters(sb")).toBeLessThan(src.indexOf("await syncAllKnowledgeSources()"));
  });
});
