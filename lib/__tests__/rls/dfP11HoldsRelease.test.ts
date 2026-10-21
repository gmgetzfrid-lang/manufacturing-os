// drafting-flow Round G, DF-P11 AFTER-DC — 20261239 at RUNTIME on the
// replayed database (the I-17 harness; `npm run test:db`).
//
//   HAND-2  holds.release ships to the controller tier (Admin, DocCtrl), and
//           a hold's OPENER keeps release / re-date of their own hold (the
//           document_holds UPDATE policy's opener leg, hold_opener_may_update,
//           while the org's list names "$opener" — the default does):
//           a Supervisor lifts the "pending field walk" hold they placed, but
//           not a hold a controller placed; a stored list or a personal grant
//           still widens; a stored list WITHOUT "$opener" ("only Admins lift
//           holds") is honoured exactly (fix pass 2); a suspended opener holds
//           nothing; opened_by cannot be re-pointed to borrow the leg.
//   EVID-2  the distribution-ack guard: a recorded acknowledgment is never
//           withdrawn or re-dated; requested_at moves only forward and only
//           by the requester or a controller; requested_by is immutable.
//   DEC-30  the paste as the SQL editor sends it: one result set, every probe
//           true, the inventory counts only; a re-paste is clean.
//
// Each statement is sent as PostgREST sends a signed-in person's request
// (role `authenticated`, the JWT's claims), so row-level security judges it
// as it judges that person. An UPDATE whose row a policy's USING hides
// touches 0 rows (no error).

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = "20261239_df_roundG_holds_release_grant_scope.sql";
const body = () => readFileSync(join(process.cwd(), "supabase", "migrations", FILE), "utf8");

function seedDocument(dbName: string, orgId: string): string {
  const lib = randomUUID();
  const doc = randomUUID();
  admin(dbName, [
    `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'Holds', 'documents')`,
    `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${doc}', '${orgId}', '${lib}', 'p.pdf', 'P&ID', 'P-${doc.slice(0, 8)}', 'B', 'Issued')`,
  ].join(";\n") + ";");
  return doc;
}
/** A hold placed by `openedBy` (seeded as the service role: no JWT). */
function placeHold(dbName: string, orgId: string, doc: string, openedBy: string): string {
  const id = randomUUID();
  admin(dbName, `INSERT INTO document_holds (id, org_id, document_id, reason, notes, opened_by) VALUES ('${id}', '${orgId}', '${doc}', 'Other', 'harness ${id.slice(0, 8)}', '${openedBy}')`);
  return id;
}
const release = (holdId: string, who: SeededMember) =>
  `UPDATE document_holds SET released_at = now(), released_by = '${who.uid}', released_reason = 'condition cleared' WHERE id = '${holdId}' AND released_at IS NULL`;
const redate = (holdId: string) =>
  `UPDATE document_holds SET expected_release_at = now() + interval '9 days' WHERE id = '${holdId}' AND released_at IS NULL`;

describe.skipIf(skip !== null)("HAND-2 (20261239): who may release or re-date a hold, at runtime", () => {
  let orgId = "";
  let doc = "";
  let m: Record<string, SeededMember> = {};

  beforeAll(() => {
    const s = seedOrg(db, {
      admin: { role: "Admin" },
      docctrl: { role: "DocCtrl" },
      managerDocCtrl: { role: "Manager", roles: ["DocCtrl"] },
      supervisor: { role: "Supervisor" },
      engineer: { role: "Engineer-2" },
      drafter: { role: "Drafter" },
      requester: { role: "Requester" },
      viewer: { role: "Viewer" },
      suspended: { role: "Supervisor" },
      granted: { role: "Drafter" },
    });
    orgId = s.orgId;
    m = s.m;
    admin(db, `UPDATE org_members SET status = 'suspended' WHERE org_id = '${orgId}' AND uid = '${m.suspended.uid}'`);
    admin(db, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${orgId}', 'capability_policy',
      '{"grants": [{"cap": "holds.release", "uid": "${m.granted.uid}", "expiresAt": null}]}'::jsonb)`);
    doc = seedDocument(db, orgId);
  });

  it("a hold a CONTROLLER placed: every role outside Admin / DocCtrl touches 0 rows (release and re-date); Admin, DocCtrl, a Manager also holding DocCtrl and a personal grant land", () => {
    for (const k of ["supervisor", "engineer", "drafter", "requester", "viewer", "suspended"]) {
      const h = placeHold(db, orgId, doc, m.docctrl.uid);
      expect(asCaller(db, m[k].caller, redate(h)), `${k} re-date`).toEqual({ ok: true, rows: 0 });
      expect(asCaller(db, m[k].caller, release(h, m[k])), `${k} release`).toEqual({ ok: true, rows: 0 });
      expect(admin(db, `SELECT released_at IS NULL FROM document_holds WHERE id = '${h}'`), k).toBe("t");
    }
    for (const k of ["admin", "docctrl", "managerDocCtrl", "granted"]) {
      const h = placeHold(db, orgId, doc, m.supervisor.uid);
      expect(asCaller(db, m[k].caller, release(h, m[k])), k).toEqual({ ok: true, rows: 1 });
    }
  });

  it("review fix: the hold's OPENER — a Supervisor, an Engineer, a Drafter — re-dates and releases their OWN hold under the controller-tier default", () => {
    for (const k of ["supervisor", "engineer", "drafter"]) {
      const h = placeHold(db, orgId, doc, m[k].uid);
      expect(asCaller(db, m[k].caller, redate(h)), `${k} re-date`).toEqual({ ok: true, rows: 1 });
      expect(asCaller(db, m[k].caller, release(h, m[k])), `${k} release`).toEqual({ ok: true, rows: 1 });
      // the 20261073 guard still attributes the release to the session and keeps the reason
      expect(admin(db, `SELECT released_by::text || '|' || released_reason FROM document_holds WHERE id = '${h}'`)).toBe(`${m[k].uid}|condition cleared`);
    }
  });

  it("the own-hold leg is identity-bound: another non-controller cannot use it, a suspended opener holds nothing, and opened_by cannot be re-pointed to borrow it", () => {
    const supHold = placeHold(db, orgId, doc, m.supervisor.uid);
    expect(asCaller(db, m.drafter.caller, release(supHold, m.drafter))).toEqual({ ok: true, rows: 0 });
    const goneHold = placeHold(db, orgId, doc, m.suspended.uid);
    expect(asCaller(db, m.suspended.caller, release(goneHold, m.suspended))).toEqual({ ok: true, rows: 0 });
    // the drafter re-points a controller's hold to themselves: the USING side
    // hides the row (they are not its opener), so nothing changes
    const dcHold = placeHold(db, orgId, doc, m.docctrl.uid);
    expect(asCaller(db, m.drafter.caller, `UPDATE document_holds SET opened_by = '${m.drafter.uid}' WHERE id = '${dcHold}'`)).toEqual({ ok: true, rows: 0 });
    // an opener re-pointing their own hold to someone else is refused (identity pinned, 20261073)
    const own = placeHold(db, orgId, doc, m.drafter.uid);
    expect(asCaller(db, m.drafter.caller, `UPDATE document_holds SET opened_by = '${m.docctrl.uid}' WHERE id = '${own}'`)).toMatchObject({ ok: false });
    expect(admin(db, `SELECT opened_by::text FROM document_holds WHERE id = '${own}'`)).toBe(m.drafter.uid);
    // and a release with no reason is still refused for the opener (20261073)
    expect(asCaller(db, m.drafter.caller, `UPDATE document_holds SET released_at = now(), released_by = '${m.drafter.uid}' WHERE id = '${own}'`)).toMatchObject({ ok: false });
  });

  it("fix pass 2: an org that STORED holds.release = [\"Admin\"] is honoured exactly — the opener, and DocCtrl, touch 0 rows; ticking \"$opener\" back on (a bare list or a rule list's base rule) returns the leg", () => {
    const s = seedOrg(db, { admin: { role: "Admin" }, dc: { role: "DocCtrl" }, supervisor: { role: "Supervisor" } });
    admin(db, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${s.orgId}', 'capability_policy', '{"caps": {"holds.release": ["Admin"]}}'::jsonb)`);
    const d = seedDocument(db, s.orgId);
    const own = placeHold(db, s.orgId, d, s.m.supervisor.uid);
    expect(asCaller(db, s.m.supervisor.caller, redate(own))).toEqual({ ok: true, rows: 0 });
    expect(asCaller(db, s.m.supervisor.caller, release(own, s.m.supervisor))).toEqual({ ok: true, rows: 0 });
    expect(asCaller(db, s.m.dc.caller, release(own, s.m.dc))).toEqual({ ok: true, rows: 0 });
    expect(admin(db, `SELECT released_at IS NULL FROM document_holds WHERE id = '${own}'`)).toBe("t");
    // the Admin's list names the opener again
    admin(db, `UPDATE org_configurations SET data = '{"caps": {"holds.release": ["Admin", "$opener"]}}'::jsonb WHERE org_id = '${s.orgId}' AND key = 'capability_policy'`);
    expect(asCaller(db, s.m.supervisor.caller, redate(own))).toEqual({ ok: true, rows: 1 });
    // a rule list: the first unconditional rule is the base list
    admin(db, `UPDATE org_configurations SET data = '{"caps": {"holds.release": [{"tokens": ["Admin", "$opener"], "when": {"libraryId": ["x"]}}, {"tokens": ["Admin"]}]}}'::jsonb WHERE org_id = '${s.orgId}' AND key = 'capability_policy'`);
    expect(asCaller(db, s.m.supervisor.caller, release(own, s.m.supervisor))).toEqual({ ok: true, rows: 0 });
    admin(db, `UPDATE org_configurations SET data = '{"caps": {"holds.release": [{"tokens": ["Admin"], "when": {"libraryId": ["x"]}}, {"tokens": ["Admin", "$opener"]}]}}'::jsonb WHERE org_id = '${s.orgId}' AND key = 'capability_policy'`);
    expect(asCaller(db, s.m.supervisor.caller, release(own, s.m.supervisor))).toEqual({ ok: true, rows: 1 });
    // the Admin, on the stored list, always could
    const dcHold = placeHold(db, s.orgId, d, s.m.dc.uid);
    expect(asCaller(db, s.m.admin.caller, release(dcHold, s.m.admin))).toEqual({ ok: true, rows: 1 });
  });

  it("an org that STORED holds.release as everyone keeps it (the CASE is the fallback only)", () => {
    const s = seedOrg(db, { dc: { role: "DocCtrl" }, drafter: { role: "Drafter" } });
    admin(db, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${s.orgId}', 'capability_policy', '{"caps": {"holds.release": ["*"]}}'::jsonb)`);
    const d = seedDocument(db, s.orgId);
    const h = placeHold(db, s.orgId, d, s.m.dc.uid);
    expect(asCaller(db, s.m.drafter.caller, release(h, s.m.drafter))).toEqual({ ok: true, rows: 1 });
  });
});

describe.skipIf(skip !== null)("EVID-2 (20261239): the distribution-ack record is one-way, at runtime", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let doc = "";
  let ver = "";

  beforeAll(() => {
    const s = seedOrg(db, { requester: { role: "Engineer-2" }, recipient: { role: "Drafter" }, other: { role: "Supervisor" }, docctrl: { role: "DocCtrl" } });
    orgId = s.orgId;
    m = s.m;
    doc = seedDocument(db, orgId);
    ver = randomUUID();
    admin(db, `INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, created_by) VALUES ('${ver}', '${orgId}', '${doc}', 'B', 'orgs/${orgId}/x.pdf', '${m.requester.uid}')`);
  });
  const newAck = (recipient: SeededMember): string => {
    const id = randomUUID();
    admin(db, `INSERT INTO distribution_acks (id, org_id, document_id, version_id, rev_label, recipient_user_id, requested_by, requested_at)
      VALUES ('${id}', '${orgId}', '${doc}', '${ver}', 'B', '${recipient.uid}', '${m.requester.uid}', now() - interval '2 days')`);
    return id;
  };

  it("the recipient acknowledges once; withdrawing or re-dating it afterwards is refused (23514)", () => {
    const a = newAck(m.recipient);
    expect(asCaller(db, m.recipient.caller, `UPDATE distribution_acks SET acknowledged_at = now() WHERE id = '${a}'`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, m.recipient.caller, `UPDATE distribution_acks SET acknowledged_at = NULL WHERE id = '${a}'`)).toMatchObject({ ok: false, code: "23514" });
    expect(asCaller(db, m.recipient.caller, `UPDATE distribution_acks SET acknowledged_at = now() + interval '1 day' WHERE id = '${a}'`)).toMatchObject({ ok: false, code: "23514" });
    expect(admin(db, `SELECT acknowledged_by::text FROM distribution_acks WHERE id = '${a}'`)).toBe(m.recipient.uid);
  });

  it("requested_at moves forward only, by the requester or a controller; requested_by is immutable", () => {
    admin(db, `DELETE FROM distribution_acks WHERE version_id = '${ver}'`);
    const a = newAck(m.recipient);
    expect(asCaller(db, m.other.caller, `UPDATE distribution_acks SET requested_at = now() WHERE id = '${a}'`)).toMatchObject({ ok: false, code: "23514" });
    expect(asCaller(db, m.recipient.caller, `UPDATE distribution_acks SET requested_at = now() WHERE id = '${a}'`)).toMatchObject({ ok: false, code: "23514" });
    expect(asCaller(db, m.requester.caller, `UPDATE distribution_acks SET requested_at = requested_at - interval '1 day' WHERE id = '${a}'`)).toMatchObject({ ok: false, code: "23514" });
    expect(asCaller(db, m.requester.caller, `UPDATE distribution_acks SET requested_at = now() WHERE id = '${a}'`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, m.docctrl.caller, `UPDATE distribution_acks SET requested_at = now() + interval '1 minute' WHERE id = '${a}'`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, m.other.caller, `UPDATE distribution_acks SET requested_by = '${m.other.uid}' WHERE id = '${a}'`)).toMatchObject({ ok: false, code: "23514" });
  });
});

describe.skipIf(skip !== null)("20261239 pasted as ONE script, as the SQL editor sends it", () => {
  const paste = (scratch: string) => {
    const r = runPsql(mosDb().conn!, scratch, "postgres", { sql: body() });
    expect(r.errors, r.stderr).toEqual([]);
    return r.stdout.split("\n").filter((l) => l.length > 0).map((l) => {
      const [check, ok, n] = l.split("|");
      return { check, ok, n };
    });
  };

  it("on a copy put back to 20260901's UPDATE policy: the opener is refused before, admitted after; an org storing [\"Admin\"] refuses its opener before AND after (nothing widened); every probe true; inventory rows 1–8 are counts (row 1: stored [\"*\"] apart); a re-paste is clean", () => {
    const scratch = "mos_df_p11_paste";
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    try {
      admin(scratch, `DROP POLICY document_holds_update ON document_holds;
        CREATE POLICY document_holds_update ON document_holds FOR UPDATE USING (
          org_capability_allows(org_id, 'holds.release', auth.uid())
        ) WITH CHECK (
          org_capability_allows(org_id, 'holds.release', auth.uid())
        );`);
      const s = seedOrg(scratch, { supervisor: { role: "Supervisor" }, docctrl: { role: "DocCtrl" } });
      const d = seedDocument(scratch, s.orgId);
      const h1 = placeHold(scratch, s.orgId, d, s.m.supervisor.uid);
      expect(asCaller(scratch, s.m.supervisor.caller, release(h1, s.m.supervisor))).toEqual({ ok: true, rows: 0 });
      // an org whose Admin stored "only Admins lift holds"
      const n = seedOrg(scratch, { admin: { role: "Admin" }, supervisor: { role: "Supervisor" } });
      admin(scratch, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${n.orgId}', 'capability_policy', '{"caps": {"holds.release": ["Admin"]}}'::jsonb)`);
      const nd = seedDocument(scratch, n.orgId);
      const nh = placeHold(scratch, n.orgId, nd, n.m.supervisor.uid);
      expect(asCaller(scratch, n.m.supervisor.caller, release(nh, n.m.supervisor))).toEqual({ ok: true, rows: 0 });
      // fix pass 3: an org whose grid save stored the old default ["*"] — counted apart (row 1)
      const star = seedOrg(scratch, { drafter: { role: "Drafter" }, dc: { role: "DocCtrl" } });
      admin(scratch, `INSERT INTO org_configurations (org_id, key, data) VALUES ('${star.orgId}', 'capability_policy', '{"caps": {"holds.release": ["*"], "ticket.assign": ["Admin"]}}'::jsonb)`);
      const starRow = () => Number(admin(scratch, `SELECT COUNT(*) FROM org_configurations c WHERE c.key = 'capability_policy' AND COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') = '["*"]'::jsonb`));
      const otherRow = () => Number(admin(scratch, `SELECT COUNT(*) FROM org_configurations c WHERE c.key = 'capability_policy' AND COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') IS NOT NULL AND COALESCE(c.data->'caps'->'holds.release', c.data->'holds.release') <> '["*"]'::jsonb`));
      const expectStar = starRow();
      const expectOther = otherRow();
      expect(expectStar).toBeGreaterThanOrEqual(1);
      expect(expectOther).toBeGreaterThanOrEqual(1);

      const rows = paste(scratch);
      const probes = rows.filter((r) => r.ok !== "");
      const inventory = rows.filter((r) => r.ok === "");
      expect(probes.length).toBe(13);
      expect(probes.filter((p) => p.ok !== "t"), JSON.stringify(probes)).toEqual([]);
      expect(probes.every((p) => p.n === "")).toBe(true);
      expect(inventory.length).toBe(8);
      expect(inventory.every((r) => /^\d+$/.test(r.n)), JSON.stringify(inventory)).toBe(true);
      // fix pass 3: row 1 is the stored old default ["*"], row 2 every other stored list
      expect(inventory[0].check).toMatch(/^inventory: workspaces whose stored holds\.release is exactly \["\*"\]/);
      expect(Number(inventory[0].n)).toBe(expectStar);
      expect(inventory[1].check).toMatch(/^inventory: workspaces whose stored holds\.release is any other list/);
      expect(Number(inventory[1].n)).toBe(expectOther);
      expect(rows.some((r) => r.check.startsWith("the hold UPDATE policy admits holds.release or the opener leg"))).toBe(true);
      expect(rows.some((r) => /widening/.test(r.check))).toBe(false);

      expect(asCaller(scratch, s.m.supervisor.caller, release(h1, s.m.supervisor))).toEqual({ ok: true, rows: 1 });
      const h2 = placeHold(scratch, s.orgId, d, s.m.docctrl.uid);
      expect(asCaller(scratch, s.m.supervisor.caller, release(h2, s.m.supervisor))).toEqual({ ok: true, rows: 0 });
      // the stored narrower list still decides after the paste: nothing widened
      expect(asCaller(scratch, n.m.supervisor.caller, release(nh, n.m.supervisor))).toEqual({ ok: true, rows: 0 });
      // the stored old default still decides too — the remainder HAND-2 records
      const sd = seedDocument(scratch, star.orgId);
      const sh = placeHold(scratch, star.orgId, sd, star.m.dc.uid);
      expect(asCaller(scratch, star.m.drafter.caller, release(sh, star.m.drafter))).toEqual({ ok: true, rows: 1 });
      // fix pass 3: the policy applies to authenticated only; anon cannot execute the opener function
      expect(admin(scratch, `SELECT array_to_string(roles, ',') FROM pg_policies WHERE tablename = 'document_holds' AND policyname = 'document_holds_update'`)).toBe("authenticated");
      expect(admin(scratch, `SELECT has_function_privilege('anon', 'public.hold_opener_may_update(uuid,uuid)', 'EXECUTE')`)).toBe("f");
      expect(admin(scratch, `SELECT has_function_privilege('authenticated', 'public.enforce_distribution_ack_guard()', 'EXECUTE')`)).toBe("f");

      const again = paste(scratch);
      expect(again.filter((r) => r.ok !== "" && r.ok !== "t")).toEqual([]);
      expect(admin(scratch, `SELECT count(*) FROM pg_policies WHERE tablename = 'document_holds' AND policyname = 'document_holds_update'`)).toBe("1");
    } finally {
      admin("postgres", `DROP DATABASE ${scratch}`);
    }
  });
});
