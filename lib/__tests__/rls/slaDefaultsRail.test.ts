// drafting-flow Round G — DF-P13 SLA DEFAULTS RAIL AND EDITOR (EDGE-16), at
// RUNTIME on the replayed database (the I-17 harness; `npm run test:db`).
//
// sla_defaults sets the due date of every request filed without a requester
// date (/api/tickets/create) and the window the SLA clock gives an open
// request with no target (lib/ticketSla.ts). Before 20261218 its only policy
// (20260605 sla_defaults_member_all, FOR ALL) let every active member write
// it, and default_days carried no CHECK. Each statement below is sent as
// PostgREST sends a signed-in person's request (role `authenticated`, the
// JWT's claims in request.jwt.claims), so row-level security judges it as it
// judges that person.
//
// How a refusal reads: an INSERT a policy refuses raises 42501; an UPDATE or
// DELETE whose rows a policy's USING hides touches 0 rows (no error) — the
// editor's checked write (lib/slaDefaultsEditor.ts) turns that into a
// refusal; an upsert (INSERT … ON CONFLICT DO UPDATE, PostgREST's
// `.upsert()`) onto a row the UPDATE policy hides raises 42501.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = "20261218_df_roundG_sla_defaults_rail_editor_writes.sql";
const body = () => readFileSync(join(process.cwd(), "supabase", "migrations", FILE), "utf8");

const EDITORS = ["admin", "docctrl", "draftingSupervisor", "viewerDraftingSupervisor"] as const;
const NON_EDITORS = ["viewer", "auditor", "requester", "drafter", "engineer", "manager", "supervisor"] as const;

describe.skipIf(skip !== null)("EDGE-16: sla_defaults writes are the drafting-configuration editors', at runtime", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let outsider: SeededMember;
  let suspendedAdmin: SeededMember;

  const seedRow = (type: string, days = 5): string => {
    const id = randomUUID();
    admin(db, `INSERT INTO sla_defaults (id, org_id, request_type, default_days) VALUES ('${id}', '${orgId}', '${type}', ${days})`);
    return id;
  };
  const daysOf = (id: string) => admin(db, `SELECT default_days FROM sla_defaults WHERE id = '${id}'`);

  beforeAll(() => {
    const s = seedOrg(db, {
      viewer: { role: "Viewer" },
      auditor: { role: "Auditor" },
      requester: { role: "Requester" },
      drafter: { role: "Drafter" },
      engineer: { role: "Engineer-1" },
      manager: { role: "Manager" },
      supervisor: { role: "Supervisor" },
      docctrl: { role: "DocCtrl" },
      draftingSupervisor: { role: "DraftingSupervisor" },
      admin: { role: "Admin" },
      // additive roles: a Viewer headline who also holds DraftingSupervisor is an editor
      viewerDraftingSupervisor: { role: "Viewer", roles: ["DraftingSupervisor"] },
      suspended: { role: "Admin" },
    });
    orgId = s.orgId;
    m = s.m;
    suspendedAdmin = m.suspended;
    admin(db, `UPDATE org_members SET status = 'suspended' WHERE org_id = '${orgId}' AND uid = '${suspendedAdmin.uid}'`);
    outsider = seedOrg(db, { admin: { role: "Admin" } }).m.admin;
  });

  it("SELECT is unchanged: every active member reads the windows; an outsider, a suspended member and anon read nothing", () => {
    const id = seedRow("READ");
    for (const k of [...NON_EDITORS, ...EDITORS]) {
      expect(selectAs(db, m[k].caller, `SELECT count(*) FROM sla_defaults WHERE id = '${id}'`), k).toEqual(["1"]);
    }
    expect(selectAs(db, outsider.caller, `SELECT count(*) FROM sla_defaults WHERE id = '${id}'`)).toEqual(["0"]);
    expect(selectAs(db, suspendedAdmin.caller, `SELECT count(*) FROM sla_defaults WHERE id = '${id}'`)).toEqual(["0"]);
    expect(selectAs(db, { role: "anon" }, `SELECT count(*) FROM sla_defaults WHERE id = '${id}'`)).toEqual(["0"]);
  });

  it("INSERT: every member outside Admin / DocCtrl / DraftingSupervisor is refused 42501 (the Viewer of the review's scenario included); the editors — by the full collection — create", () => {
    for (const k of NON_EDITORS) {
      expect(asCaller(db, m[k].caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${orgId}', 'INS-${k}', 1)`), k)
        .toMatchObject({ ok: false, code: "42501" });
    }
    expect(admin(db, `SELECT count(*) FROM sla_defaults WHERE org_id = '${orgId}' AND request_type LIKE 'INS-%'`)).toBe("0");
    for (const k of EDITORS) {
      expect(asCaller(db, m[k].caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${orgId}', 'INS-${k}', 7)`), k)
        .toEqual({ ok: true, rows: 1 });
    }
    expect(asCaller(db, outsider.caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${orgId}', 'INS-out', 7)`))
      .toMatchObject({ ok: false, code: "42501" });
    expect(asCaller(db, suspendedAdmin.caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${orgId}', 'INS-susp', 7)`))
      .toMatchObject({ ok: false, code: "42501" });
    expect(asCaller(db, { role: "anon" }, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${orgId}', 'INS-anon', 7)`))
      .toMatchObject({ ok: false, code: "42501" });
  });

  it("UPDATE: a non-editor's JWT touches 0 rows and the window is untouched; an editor's lands", () => {
    const id = seedRow("UPD", 14);
    for (const k of NON_EDITORS) {
      expect(asCaller(db, m[k].caller, `UPDATE sla_defaults SET default_days = 1 WHERE id = '${id}'`), k).toEqual({ ok: true, rows: 0 });
    }
    expect(asCaller(db, outsider.caller, `UPDATE sla_defaults SET default_days = 1 WHERE id = '${id}'`)).toEqual({ ok: true, rows: 0 });
    expect(daysOf(id)).toBe("14");
    for (const [i, k] of EDITORS.entries()) {
      expect(asCaller(db, m[k].caller, `UPDATE sla_defaults SET default_days = ${10 + i} WHERE id = '${id}'`), k).toEqual({ ok: true, rows: 1 });
    }
    expect(daysOf(id)).toBe(String(10 + EDITORS.length - 1));
  });

  it("the editor's upsert (PostgREST .upsert onConflict org_id,request_type): a non-editor's is refused 42501 onto an existing row and onto a new one; an editor's lands either way", () => {
    const id = seedRow("UPS", 14);
    const upsert = (days: number, type = "UPS") =>
      `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${orgId}', '${type}', ${days}) ON CONFLICT (org_id, request_type) DO UPDATE SET default_days = EXCLUDED.default_days RETURNING id`;
    for (const k of NON_EDITORS) {
      expect(asCaller(db, m[k].caller, upsert(1)), k).toMatchObject({ ok: false, code: "42501" });
      expect(asCaller(db, m[k].caller, upsert(1, `UPS-new-${k}`)), k).toMatchObject({ ok: false, code: "42501" });
    }
    expect(daysOf(id)).toBe("14");
    expect(asCaller(db, m.draftingSupervisor.caller, upsert(3))).toEqual({ ok: true, rows: 1 });
    expect(daysOf(id)).toBe("3");
    expect(asCaller(db, m.docctrl.caller, upsert(4, "UPS-new"))).toEqual({ ok: true, rows: 1 });
  });

  it("DELETE: a non-editor's JWT touches 0 rows; an editor's removes the window", () => {
    const id = seedRow("DEL");
    for (const k of NON_EDITORS) {
      expect(asCaller(db, m[k].caller, `DELETE FROM sla_defaults WHERE id = '${id}'`), k).toEqual({ ok: true, rows: 0 });
    }
    expect(asCaller(db, outsider.caller, `DELETE FROM sla_defaults WHERE id = '${id}'`)).toEqual({ ok: true, rows: 0 });
    expect(admin(db, `SELECT count(*) FROM sla_defaults WHERE id = '${id}'`)).toBe("1");
    expect(asCaller(db, m.viewerDraftingSupervisor.caller, `DELETE FROM sla_defaults WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
  });

  it("default_days outside 1–3650 whole days is refused by the database (23514) for an editor too; 1 and 3650 land", () => {
    for (const bad of [0, -1, 3651, 2000000000]) {
      expect(asCaller(db, m.admin.caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${orgId}', 'CHK${bad}', ${bad})`), String(bad))
        .toMatchObject({ ok: false, code: "23514" });
    }
    // whole days by type: a fraction never reaches the row as one
    expect(asCaller(db, m.admin.caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${orgId}', 'CHKfrac', '1.5')`))
      .toMatchObject({ ok: false, code: "22P02" });
    expect(asCaller(db, m.admin.caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${orgId}', 'CHK1', 1)`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, m.admin.caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${orgId}', 'CHK3650', 3650)`)).toEqual({ ok: true, rows: 1 });
    const id = seedRow("CHKUPD", 5);
    expect(asCaller(db, m.admin.caller, `UPDATE sla_defaults SET default_days = 0 WHERE id = '${id}'`)).toMatchObject({ ok: false, code: "23514" });
    expect(daysOf(id)).toBe("5");
  });

  it("the service role — the create route's and the clock's read, the restore's write — is not judged by the new policies", () => {
    const id = seedRow("SVC", 6);
    expect(selectAs(db, { role: "service_role" }, `SELECT default_days FROM sla_defaults WHERE id = '${id}'`)).toEqual(["6"]);
    expect(asCaller(db, { role: "service_role" }, `UPDATE sla_defaults SET default_days = 8 WHERE id = '${id}'`)).toEqual({ ok: true, rows: 1 });
    // the CHECK still binds it (a restore of an out-of-range row is reported row by row, 23514)
    expect(asCaller(db, { role: "service_role" }, `UPDATE sla_defaults SET default_days = 0 WHERE id = '${id}'`)).toMatchObject({ ok: false, code: "23514" });
  });

  it("the catalog: three RESTRICTIVE per-verb policies naming the editor set, the member policy unchanged, the CHECK validated on the fresh replay", () => {
    expect(admin(db, `SELECT string_agg(policyname || ':' || permissive || ':' || cmd, ',' ORDER BY policyname) FROM pg_policies WHERE tablename = 'sla_defaults'`))
      .toBe("sla_defaults_editor_writes_del:RESTRICTIVE:DELETE,sla_defaults_editor_writes_ins:RESTRICTIVE:INSERT,sla_defaults_editor_writes_upd:RESTRICTIVE:UPDATE,sla_defaults_member_all:PERMISSIVE:ALL");
    expect(admin(db, `SELECT with_check FROM pg_policies WHERE tablename = 'sla_defaults' AND policyname = 'sla_defaults_editor_writes_ins'`))
      .toBe("caller_holds_any_role(org_id, ARRAY['Admin'::text, 'DocCtrl'::text, 'DraftingSupervisor'::text])");
    expect(admin(db, `SELECT convalidated FROM pg_constraint WHERE conrelid = 'sla_defaults'::regclass AND conname = 'sla_defaults_default_days_bounded'`)).toBe("t");
  });
});

// The paste itself, on copies of the replay put back to HEAD's state for
// sla_defaults (20261218's three policies and its CHECK dropped — nothing
// else in the sequence touches the table): what the SQL editor shows.
describe.skipIf(skip !== null)("20261218 pasted as ONE script, as the SQL editor sends it", () => {
  const toHead = (scratch: string) =>
    admin(scratch, `DROP POLICY sla_defaults_editor_writes_ins ON sla_defaults;
                    DROP POLICY sla_defaults_editor_writes_upd ON sla_defaults;
                    DROP POLICY sla_defaults_editor_writes_del ON sla_defaults;
                    ALTER TABLE sla_defaults DROP CONSTRAINT sla_defaults_default_days_bounded;`);
  const paste = (scratch: string) => {
    const r = runPsql(mosDb().conn!, scratch, "postgres", { sql: body() });
    expect(r.errors, r.stderr).toEqual([]);
    // -A -t: one `check|ok|n` line per row of the ONE final result set
    return r.stdout.split("\n").filter((l) => l.length > 0).map((l) => {
      const [check, ok, n] = l.split("|");
      return { check, ok, n };
    });
  };
  // re-review: the ONE result set comes back in an explicit order (ORDER BY
  // sec, ord) — the six probes as written, then inventory rows 1–7.
  const PROBES = [
    "EDGE-16: sla_defaults_editor_writes_ins / _upd / _del",
    "EDGE-16: SELECT unchanged",
    "EDGE-16: row-level security is still enabled on sla_defaults",
    "EDGE-16: sla_defaults_default_days_bounded",
    "EDGE-16 world: the CHECK is ",
    "caller_holds_any_role (20261045) is SECURITY DEFINER",
  ];
  const INVENTORY = [
    "inventory (before apply): EDGE-16 — sla_defaults rows (all workspaces)",
    "inventory (before apply): workspaces with exactly 1 sla_defaults row",
    "inventory (before apply): workspaces with 2–5 sla_defaults rows",
    "inventory (before apply): workspaces with 6 or more sla_defaults rows",
    "inventory (before apply): EDGE-16 — sla_defaults rows whose default_days is outside 1–3650",
    "inventory (before apply): EDGE-16 — active members who LOSE",
    "inventory (before apply): of those, members of a workspace that has sla_defaults rows",
  ];
  const expectOrdered = (rows: Array<{ check: string; ok: string; n: string }>) => {
    expect(rows.length).toBe(PROBES.length + INVENTORY.length);
    rows.forEach((r, i) => {
      const want = i < PROBES.length ? PROBES[i] : INVENTORY[i - PROBES.length];
      expect(r.check.startsWith(want), `row ${i + 1}: ${r.check}`).toBe(true);
      expect(r.ok === "", `row ${i + 1}`).toBe(i >= PROBES.length);
    });
  };

  it("HEAD reproduces EDGE-16 (not vacuous): a Viewer writes a 1-day ISO window and a 2,000,000,000-day one; then the paste refuses the same Viewer, keeps both rows, leaves the CHECK NOT VALID and says so — every probe true, the inventory counted", () => {
    const scratch = "mos_p13_head";
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    try {
      toHead(scratch);
      const s = seedOrg(scratch, { viewer: { role: "Viewer" }, manager: { role: "Manager" }, admin: { role: "Admin" } });
      expect(asCaller(scratch, s.m.viewer.caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${s.orgId}', 'ISO', 1)`)).toEqual({ ok: true, rows: 1 });
      expect(asCaller(scratch, s.m.manager.caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${s.orgId}', 'MOC', 2000000000)`)).toEqual({ ok: true, rows: 1 });

      // the inventory's expected values, counted on the same database before the paste
      // (the template carries the rows the suite above wrote)
      const expected = {
        rows: admin(scratch, "SELECT count(*) FROM sla_defaults"),
        two5: admin(scratch, "SELECT count(*) FROM (SELECT org_id FROM sla_defaults GROUP BY org_id HAVING count(*) BETWEEN 2 AND 5) x"),
        outside: admin(scratch, "SELECT count(*) FROM sla_defaults WHERE NOT (default_days BETWEEN 1 AND 3650)"),
        lose: admin(scratch, `SELECT count(*) FROM org_members WHERE status = 'active' AND NOT (role IN ('Admin','DocCtrl','DraftingSupervisor') OR COALESCE(roles, '{}'::text[]) && ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[])`),
        loseWithRows: admin(scratch, `SELECT count(*) FROM org_members WHERE status = 'active' AND org_id IN (SELECT org_id FROM sla_defaults) AND NOT (role IN ('Admin','DocCtrl','DraftingSupervisor') OR COALESCE(roles, '{}'::text[]) && ARRAY['Admin','DocCtrl','DraftingSupervisor']::text[])`),
      };
      expect(Number(expected.outside)).toBe(1);

      const rows = paste(scratch);
      expectOrdered(rows);
      const probes = rows.filter((r) => r.ok !== "");
      const inventory = rows.filter((r) => r.ok === "");
      expect(probes.length).toBe(6);
      expect(probes.filter((p) => p.ok !== "t"), JSON.stringify(probes)).toEqual([]);
      expect(probes.every((p) => p.n === "")).toBe(true);
      expect(probes.some((p) => p.check.startsWith("EDGE-16 world: the CHECK is NOT VALID"))).toBe(true);
      expect(inventory.length).toBe(7);
      const inv = (prefix: string) => inventory.find((r) => r.check.startsWith(prefix))?.n;
      expect(inv("inventory (before apply): EDGE-16 — sla_defaults rows (all workspaces)")).toBe(expected.rows);
      expect(inv("inventory (before apply): workspaces with 2–5 sla_defaults rows")).toBe(expected.two5);
      expect(inv("inventory (before apply): EDGE-16 — sla_defaults rows whose default_days is outside 1–3650")).toBe("1");
      expect(inv("inventory (before apply): EDGE-16 — active members who LOSE")).toBe(expected.lose);
      expect(inv("inventory (before apply): of those, members of a workspace that has sla_defaults rows")).toBe(expected.loseWithRows);
      expect(Number(expected.loseWithRows)).toBeGreaterThanOrEqual(2);   // this workspace's Viewer and Manager, at least
      // counts only: every inventory value is a whole number, never a row
      expect(inventory.every((r) => /^\d+$/.test(r.n))).toBe(true);
      // nothing stored was rewritten or deleted
      expect(admin(scratch, `SELECT string_agg(request_type || '=' || default_days, ',' ORDER BY request_type) FROM sla_defaults WHERE org_id = '${s.orgId}'`))
        .toBe("ISO=1,MOC=2000000000");
      // the rail now holds: the Viewer is refused; the Admin's correction lands; a write outside the bound is refused
      expect(asCaller(scratch, s.m.viewer.caller, `UPDATE sla_defaults SET default_days = 1 WHERE org_id = '${s.orgId}'`)).toEqual({ ok: true, rows: 0 });
      expect(asCaller(scratch, s.m.admin.caller, `UPDATE sla_defaults SET default_days = 2000000001 WHERE org_id = '${s.orgId}' AND request_type = 'MOC'`)).toMatchObject({ ok: false, code: "23514" });
      expect(asCaller(scratch, s.m.admin.caller, `UPDATE sla_defaults SET default_days = 7 WHERE org_id = '${s.orgId}' AND request_type = 'MOC'`)).toEqual({ ok: true, rows: 1 });

      // the re-paste after the correction validates the CHECK
      const again = paste(scratch);
      expectOrdered(again);
      expect(again.filter((r) => r.ok !== "" && r.ok !== "t")).toEqual([]);
      expect(again.some((r) => r.check === "EDGE-16 world: the CHECK is VALIDATED — no stored row is outside 1–3650")).toBe(true);
      expect(admin(scratch, `SELECT convalidated FROM pg_constraint WHERE conrelid = 'sla_defaults'::regclass AND conname = 'sla_defaults_default_days_bounded'`)).toBe("t");
      expect(admin(scratch, `SELECT count(*) FROM pg_policies WHERE tablename = 'sla_defaults'`)).toBe("4");
    } finally {
      admin("postgres", `DROP DATABASE ${scratch}`);
    }
  });

  it("a re-paste of 20260605's member policy after 20261218 cannot reopen the writes (the narrowing is RESTRICTIVE)", () => {
    const scratch = "mos_p13_repaste";
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    try {
      admin(scratch, `DROP POLICY IF EXISTS "sla_defaults_member_all" ON sla_defaults;
CREATE POLICY "sla_defaults_member_all" ON sla_defaults
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = sla_defaults.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = sla_defaults.org_id AND uid = auth.uid() AND status = 'active'));`);
      const s = seedOrg(scratch, { viewer: { role: "Viewer" }, admin: { role: "Admin" } });
      expect(asCaller(scratch, s.m.viewer.caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${s.orgId}', 'ISO', 1)`)).toMatchObject({ ok: false, code: "42501" });
      expect(asCaller(scratch, s.m.admin.caller, `INSERT INTO sla_defaults (org_id, request_type, default_days) VALUES ('${s.orgId}', 'ISO', 9)`)).toEqual({ ok: true, rows: 1 });
    } finally {
      admin("postgres", `DROP DATABASE ${scratch}`);
    }
  });

  it("the prerequisite refuses without caller_holds_any_role and changes nothing", () => {
    const scratch = "mos_p13_prereq";
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    try {
      toHead(scratch);
      admin(scratch, "ALTER FUNCTION caller_holds_any_role(uuid, text[]) RENAME TO caller_holds_any_role_hidden;");
      const r = runPsql(mosDb().conn!, scratch, "postgres", { sql: body() });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/20261218 needs caller_holds_any_role \(20261045\); nothing was changed/);
      expect(admin(scratch, `SELECT count(*) FROM pg_policies WHERE tablename = 'sla_defaults'`)).toBe("1");
      expect(admin(scratch, `SELECT count(*) FROM pg_constraint WHERE conrelid = 'sla_defaults'::regclass AND conname = 'sla_defaults_default_days_bounded'`)).toBe("0");
    } finally {
      admin("postgres", `DROP DATABASE ${scratch}`);
    }
  });

  it("the prerequisite refuses without 20260605's sla_defaults_member_all (RLS still on, the policy dropped by hand) and changes nothing", () => {
    const scratch = "mos_p13_prereq_member";
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    try {
      toHead(scratch);
      admin(scratch, `DROP POLICY "sla_defaults_member_all" ON sla_defaults;`);
      expect(admin(scratch, `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sla_defaults'::regclass`)).toBe("t");
      const r = runPsql(mosDb().conn!, scratch, "postgres", { sql: body() });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/20261218 needs sla_defaults_member_all \(20260605\); nothing was changed/);
      expect(admin(scratch, `SELECT count(*) FROM pg_policies WHERE tablename = 'sla_defaults'`)).toBe("0");
      expect(admin(scratch, `SELECT count(*) FROM pg_constraint WHERE conrelid = 'sla_defaults'::regclass AND conname = 'sla_defaults_default_days_bounded'`)).toBe("0");
      // with the member policy put back (20260605's body), the same paste goes through
      admin(scratch, `CREATE POLICY "sla_defaults_member_all" ON sla_defaults
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = sla_defaults.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = sla_defaults.org_id AND uid = auth.uid() AND status = 'active'));`);
      const ok = runPsql(mosDb().conn!, scratch, "postgres", { sql: body() });
      expect(ok.errors, ok.stderr).toEqual([]);
      expect(admin(scratch, `SELECT count(*) FROM pg_policies WHERE tablename = 'sla_defaults'`)).toBe("4");
    } finally {
      admin("postgres", `DROP DATABASE ${scratch}`);
    }
  });
});
