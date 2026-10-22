// drafting-flow Round G, DF-P22 fix pass — /api/admin/sla-escalation: the
// escalation tier above the queue owners behind an ADMIN-ONLY write.
//   * A drafting supervisor (a queue owner the tier sits above, and a
//     request-form editor) may read it but never change it: 403, nothing
//     written, no audit row.
//   * An Admin's change: the audit row FIRST (TICKET_SLA_ESCALATION_SET, old
//     and new value), then the write of its own key; a failed write leaves a
//     _NOT_APPLIED row; the people the previous contact named who are no
//     longer named are told on the bell.
//   * A Contractor role or a Contractor-only member is refused; an inactive
//     member is refused; an unchanged value writes nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  actor: null as null | Record<string, unknown>,
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, { message: string }>,
  ops: [] as Array<{ table: string; op: string; payload?: unknown }>,
  bells: [] as Array<Record<string, unknown>>,
  bellError: null as string | null,
}));

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op = "select";
  let payload: unknown = null;
  const matched = () => (st.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
    insert: (p: unknown) => { op = "insert"; payload = p; return b; },
    upsert: (p: unknown) => { op = "upsert"; payload = p; return b; },
    delete: () => { op = "delete"; return b; },
    maybeSingle: async () => {
      const err = st.errors[`${table}:select`];
      return err ? { data: null, error: err } : { data: matched()[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      st.ops.push({ table, op, payload });
      const err = st.errors[`${table}:${op}`];
      if (err) return resolve({ data: null, error: err });
      if (op === "insert") { st.tables[table] = [...(st.tables[table] ?? []), payload as Row]; return resolve({ data: null, error: null }); }
      if (op === "upsert") {
        const p = payload as Row;
        st.tables[table] = [...(st.tables[table] ?? []).filter((r) => !(r.org_id === p.org_id && r.key === p.key)), p];
        return resolve({ data: null, error: null });
      }
      if (op === "delete") { const mm = new Set(matched()); st.tables[table] = (st.tables[table] ?? []).filter((r) => !mm.has(r)); return resolve({ data: null, error: null }); }
      return resolve({ data: matched(), error: null });
    },
  };
  return b;
}
const admin = { from: (t: string) => builder(t) };

vi.mock("@/lib/adminGate", () => ({ authorizeAdminSurface: vi.fn(async () => st.actor ?? { error: "Unauthorized", status: 401 }) }));
vi.mock("@/lib/inAppNotifications", () => ({
  notifyBatchWithReason: vi.fn(async (inputs: Array<Record<string, unknown>>) => { st.bells.push(...inputs); return st.bellError ? { landed: 0, error: st.bellError } : { landed: inputs.length }; }),
}));

import { GET, PUT } from "@/app/api/admin/sla-escalation/route";
import { SLA_ESCALATION_KEY, SLA_ESCALATION_SET_AUDIT } from "@/lib/ticketSla";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const SUP = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const CONTRACTOR = "44444444-4444-4444-8444-444444444444";
const actorOf = (uid: string, roles: string[]) => ({ userId: uid, email: `${uid.slice(0, 4)}@x.io`, orgId: ORG, role: roles[0], roles, admin, admittedRole: roles[0] });
const put = (config: unknown) => PUT(new NextRequest("http://x/api/admin/sla-escalation", { method: "PUT", body: JSON.stringify({ orgId: ORG, config }) }));
const audits = () => (st.tables.audit_logs ?? []);
const stored = () => (st.tables.org_configurations ?? []).find((r) => r.key === SLA_ESCALATION_KEY)?.data ?? null;

beforeEach(() => {
  st.actor = actorOf(ADMIN, ["Admin"]);
  st.tables = {
    org_members: [
      { org_id: ORG, uid: ADMIN, role: "Admin", roles: ["Admin"], status: "active" },
      { org_id: ORG, uid: SUP, role: "DraftingSupervisor", roles: ["DraftingSupervisor"], status: "active" },
      { org_id: ORG, uid: OTHER, role: "Manager", roles: ["Manager"], status: "active" },
      { org_id: ORG, uid: CONTRACTOR, role: "Contractor", roles: ["Contractor"], status: "active" },
    ],
    org_configurations: [],
    audit_logs: [],
  };
  st.errors = {};
  st.ops = [];
  st.bells = [];
  st.bellError = null;
});

describe("/api/admin/sla-escalation — the queue owners cannot change the tier above them", () => {
  it("a drafting supervisor reads it (canEdit false) and is refused a change: 403, nothing written, no audit row", async () => {
    st.tables.org_configurations = [{ org_id: ORG, key: SLA_ESCALATION_KEY, data: { contact: { kind: "member", uid: OTHER }, periodDays: 2 } }];
    st.actor = actorOf(SUP, ["DraftingSupervisor"]);
    const g = await GET(new NextRequest(`http://x/api/admin/sla-escalation?orgId=${ORG}`));
    expect(await g.json()).toEqual({ config: { contact: { kind: "member", uid: OTHER }, periodDays: 2 }, error: null, canEdit: false });
    const r = await put(null);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/Only an Admin/);
    expect(stored()).toEqual({ contact: { kind: "member", uid: OTHER }, periodDays: 2 });
    expect(audits()).toEqual([]);
  });
  it("…nor may they point it at themselves", async () => {
    st.actor = actorOf(SUP, ["Manager", "DraftingSupervisor"]);
    const r = await put({ contact: { kind: "member", uid: SUP }, periodDays: 2 });
    expect(r.status).toBe(403);
    expect(stored()).toBeNull();
  });
});

describe("/api/admin/sla-escalation — an Admin's change is recorded first, then written to its own key", () => {
  it("set: audit row first (old and new value, recordedBeforeApply), then the key", async () => {
    const r = await put({ contact: { kind: "role", role: "Manager" }, periodDays: 3 });
    expect(r.status).toBe(200);
    expect(st.ops.map((o) => `${o.table}:${o.op}`)).toEqual(["org_members:select", "audit_logs:insert", "org_configurations:upsert"]);
    expect(audits()[0]).toMatchObject({ action: SLA_ESCALATION_SET_AUDIT, resource_type: "org_configuration", user_id: ADMIN, user_role: "Admin",
      details: { key: SLA_ESCALATION_KEY, before: null, after: { contact: { kind: "role", role: "Manager" }, periodDays: 3 }, switchedOff: false, recordedBeforeApply: true } });
    expect(stored()).toEqual({ contact: { kind: "role", role: "Manager" }, periodDays: 3 });
  });
  it("switched off: the row is removed, the change audited, and the previous contact told on the bell", async () => {
    st.tables.org_configurations = [{ org_id: ORG, key: SLA_ESCALATION_KEY, data: { contact: { kind: "member", uid: OTHER }, periodDays: 2 } }];
    const r = await put(null);
    expect(r.status).toBe(200);
    expect(stored()).toBeNull();
    expect(audits()[0]).toMatchObject({ details: { before: { contact: { kind: "member", uid: OTHER }, periodDays: 2 }, after: null, switchedOff: true } });
    expect(st.bells).toHaveLength(1);
    expect(st.bells[0]).toMatchObject({ userId: OTHER, kind: "ticket_status", title: "Escalation of overdue requests was switched off", link: "/admin/requests" });
  });
  it("a failed write leaves the _NOT_APPLIED row naming the attempt; nobody is told", async () => {
    st.tables.org_configurations = [{ org_id: ORG, key: SLA_ESCALATION_KEY, data: { contact: { kind: "member", uid: OTHER }, periodDays: 2 } }];
    st.errors["org_configurations:delete"] = { message: "boom" };
    const r = await put(null);
    expect(r.status).toBe(500);
    expect(audits().map((a) => a.action)).toEqual([SLA_ESCALATION_SET_AUDIT, `${SLA_ESCALATION_SET_AUDIT}_NOT_APPLIED`]);
    expect((audits()[1].details as Row).attempt).toBe(audits()[0].id);
    expect(st.bells).toEqual([]);
  });
  it("an audit row that cannot be written stops the change", async () => {
    st.errors["audit_logs:insert"] = { message: "refused" };
    const r = await put({ contact: { kind: "role", role: "Manager" }, periodDays: 3 });
    expect(r.status).toBe(500);
    expect(stored()).toBeNull();
  });
  it("an unchanged value writes nothing", async () => {
    st.tables.org_configurations = [{ org_id: ORG, key: SLA_ESCALATION_KEY, data: { contact: { kind: "role", role: "Manager" }, periodDays: 3 } }];
    const r = await put({ contact: { kind: "role", role: "Manager" }, periodDays: 3 });
    expect(await r.json()).toMatchObject({ unchanged: true });
    expect(audits()).toEqual([]);
  });
});

describe("/api/admin/sla-escalation — a contact must read the requests it is told of", () => {
  it("a Contractor role, a Contractor-only member, an inactive member and an unknown role are refused (400), nothing written", async () => {
    for (const config of [
      { contact: { kind: "role", role: "Contractor" }, periodDays: 2 },
      { contact: { kind: "member", uid: CONTRACTOR }, periodDays: 2 },
      { contact: { kind: "member", uid: "55555555-5555-4555-8555-555555555555" }, periodDays: 2 },
      { contact: { kind: "role", role: "Wizard" }, periodDays: 2 },
      { contact: { kind: "role", role: "Admin" }, periodDays: 31 },
    ]) {
      const r = await put(config);
      expect(r.status, JSON.stringify(config)).toBe(400);
    }
    expect(audits()).toEqual([]);
    expect(stored()).toBeNull();
  });
});

describe("the key's write rule (20261264) — no client write of sla_escalation", () => {
  it("three RESTRICTIVE policies refuse every client INSERT / UPDATE / DELETE of the key, and a probe checks them", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261264_df_roundG_consent_escalation.sql"), "utf8");
    for (const [name, cmd] of [["ins", "INSERT"], ["upd", "UPDATE"], ["del", "DELETE"]]) {
      expect(sql).toContain(`CREATE POLICY org_config_sla_escalation_no_client_${name} ON org_configurations\n  AS RESTRICTIVE FOR ${cmd}`);
    }
    expect(sql).toMatch(/WITH CHECK \(key <> 'sla_escalation'\);/);
    expect(sql).toMatch(/LIKE '%<> ''sla_escalation''%'/);
  });
});
