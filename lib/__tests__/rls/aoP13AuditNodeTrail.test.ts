// admin-and-org ALOG-16 (package P13): node-level authority rows —
// NODE_ACL_CHANGED (a node's full before / after access list), OWNER_ASSIGNED
// / OWNER_CLEARED / OWNER_TEAM_*, ACCESS_RECERTIFIED — are readable only by a
// holder of the Audit log permission or by a person who may manage that node,
// asserted at RUNTIME on the replayed database (20261219's
// audit_logs_admin_trail and audit_row_node_manageable), each read sent as
// PostgREST sends a signed-in person's request. Also: the paste picks the
// overlay's newest body by what is applied (20261157 → its §7; else 20261142
// → its §2; neither → it stops and changes nothing), a re-paste is clean, and
// the EVID-6 outbox (audit_dead_letters) is the service role's alone.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = join(process.cwd(), "supabase", "migrations", "20261219_ao_roundG_audit_node_trail_and_outbox.sql");
const M157 = join(process.cwd(), "supabase", "migrations", "20261157_prj_roundG_server_remainders.sql");

describe.skipIf(skip !== null)("ALOG-16: node-level authority rows reach only audit viewers and the node's managers, at runtime", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let outsider: SeededMember;
  const lib = randomUUID();
  const doc = randomUUID();
  const goneLib = randomUUID();
  const rows: Record<string, string> = {};
  const copies: string[] = [];
  const copy = (tag: string) => {
    const name = `mos_p13_${tag}_${process.pid}`;
    admin("postgres", `CREATE DATABASE ${name} TEMPLATE ${REPLAY_DB}`);
    copies.push(name);
    return name;
  };
  const read = (who: SeededMember, on = db) =>
    selectAs(on, who.caller, `SELECT action || ':' || resource_type FROM audit_logs WHERE org_id = '${orgId}' AND id IN (${Object.values(rows).map((r) => `'${r}'`).join(", ")}) ORDER BY action, resource_type`);
  const has = (who: SeededMember, key: string, on = db) =>
    selectAs(on, who.caller, `SELECT count(*) FROM audit_logs WHERE id = '${rows[key]}'`)[0] === "1";
  const paste = (on: string) => runPsql(mosDb().conn!, on, "postgres", { sql: readFileSync(FILE, "utf8") });
  // document-control P39 (DIST-20, 20261259 — declared to admin-and-org): a
  // second RESTRICTIVE SELECT policy on audit_logs (the deferred notice rows'
  // read rule). A re-paste of this file after it reads its "ONE restrictive
  // overlay" probe false — expected, and said in both headers — and leaves
  // that rule in force; every other probe stays true.
  const onlyOverlayProbe = (line: string) => line.startsWith("the read side is still one permissive member read (audit_logs_org_access) and ONE restrictive overlay");
  const deferredRuleStands = (on: string) =>
    admin(on, "SELECT count(*) FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_notice_deferred_readers' AND permissive = 'RESTRICTIVE'") === "1";

  beforeAll(() => {
    const s = seedOrg(db, {
      viewer: { role: "Viewer" },
      owner: { role: "Engineer-2" },
      granted: { role: "Drafter" },
      docctrl: { role: "Viewer", roles: ["DocCtrl"] },
      auditor: { role: "Auditor" },
    });
    orgId = s.orgId;
    m = s.m;
    outsider = seedOrg(db, { admin: { role: "Admin" } }).m.admin;
    const index = JSON.stringify({ allow: { users: { managePermissions: [m.granted.uid] } } });
    const stmts = [
      `INSERT INTO libraries (id, org_id, name, type, owner_user_id, acl_index) VALUES ('${lib}', '${orgId}', 'Restricted P&IDs', 'documents', '${m.owner.uid}', '${index}'::jsonb)`,
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${doc}', '${orgId}', '${lib}', 'p.pdf', 'P', 'P-${doc.slice(0, 8)}', '0', 'Draft')`,
    ];
    const add = (key: string, action: string, type: string, id: string, details = "{}") => {
      const rid = randomUUID();
      rows[key] = rid;
      stmts.push(`INSERT INTO audit_logs (id, org_id, action, resource_type, resource_id, user_id, user_email, details) VALUES ('${rid}', '${orgId}', '${action}', '${type}', '${id}', '${m.docctrl.uid}', '${m.docctrl.email}', '${details}'::jsonb)`);
    };
    add("acl", "NODE_ACL_CHANGED", "library", lib, JSON.stringify({ before: { rules: [] }, after: { rules: [{ subject: { type: "user", id: m.owner.uid } }] } }));
    add("team", "OWNER_TEAM_ASSIGNED", "library", lib);
    add("recert", "ACCESS_RECERTIFIED", "library", lib);
    add("docOwner", "OWNER_ASSIGNED", "document", doc);
    add("view", "VIEW", "document", doc);
    add("gone", "NODE_ACL_CHANGED", "library", goneLib);
    add("policy", "CAPABILITY_POLICY_CHANGED", "org_configuration", orgId);
    admin(db, stmts.join(";\n") + ";");
  });
  afterAll(() => {
    for (const c of copies) { try { admin("postgres", `DROP DATABASE IF EXISTS ${c}`); } catch { /* deleted with the cluster */ } }
  });

  it("a member who may not manage the node no longer reads its ACL change, owner or recertification rows; every other row reads as before", () => {
    expect(read(m.viewer)).toEqual(["VIEW:document"]);
  });

  it("the node's effective owner and a Manage Permissions grant holder read the node's rows; a controller and an audit viewer read every row", () => {
    // the library's owner: its three rows and the document's (the owner cascade reaches the document)
    expect(read(m.owner)).toEqual(["ACCESS_RECERTIFIED:library", "NODE_ACL_CHANGED:library", "OWNER_ASSIGNED:document", "OWNER_TEAM_ASSIGNED:library", "VIEW:document"]);
    // a managePermissions grant on the library's index: the library's rows (the document's own index grants nothing here)
    expect(read(m.granted)).toEqual(["ACCESS_RECERTIFIED:library", "NODE_ACL_CHANGED:library", "OWNER_TEAM_ASSIGNED:library", "VIEW:document"]);
    // DocCtrl (a controller, and an Audit log holder by default) and the Auditor: everything, the gone node's row included
    const all = ["ACCESS_RECERTIFIED:library", "CAPABILITY_POLICY_CHANGED:org_configuration", "NODE_ACL_CHANGED:library", "NODE_ACL_CHANGED:library", "OWNER_ASSIGNED:document", "OWNER_TEAM_ASSIGNED:library", "VIEW:document"];
    expect(read(m.docctrl)).toEqual(all);
    expect(read(m.auditor)).toEqual(all);
    // a node that is gone: only the audit viewers
    expect(has(m.owner, "gone")).toBe(false);
    // another workspace's Admin: nothing, as before
    expect(read(outsider)).toEqual([]);
  });

  it("reproduced: with the overlay as 20261157 left it (restored on a copy), the plain member read the ACL change and the owner rows", () => {
    const before = copy("before");
    const src = readFileSync(M157, "utf8");
    const a = src.indexOf("DROP POLICY IF EXISTS audit_logs_admin_trail ON audit_logs;");
    const b = src.indexOf("\n  );", a) + "\n  );".length;
    admin(before, src.slice(a, b));
    expect(read(m.viewer, before)).toEqual(["ACCESS_RECERTIFIED:library", "NODE_ACL_CHANGED:library", "NODE_ACL_CHANGED:library", "OWNER_ASSIGNED:document", "OWNER_TEAM_ASSIGNED:library", "VIEW:document"]);
  });

  it("a re-paste on the applied database is clean: every probe true, the overlay unchanged in effect", () => {
    const again = copy("again");
    const r = paste(again);
    expect(r.error).toBeNull();
    const probes = r.stdout.split("\n").filter((l) => l.split("|").length === 3 && l.split("|")[2] === "");
    expect(probes.length).toBeGreaterThanOrEqual(8);
    for (const p of probes) expect(p.split("|")[1], p).toBe(onlyOverlayProbe(p) ? "f" : "t");
    expect(read(m.viewer, again)).toEqual(["VIEW:document"]);
    expect(deferredRuleStands(again)).toBe(true);
  });

  it("20261157 not applied (20261142 is): the paste takes 20261142's body — no SEC-21 clause — and still narrows the node rows", () => {
    const worldB = copy("worldb");
    admin(worldB, "DROP FUNCTION public.audit_row_project_ref_visible(text, text, text, jsonb) CASCADE;"); // the overlay goes with it
    expect(admin(worldB, "SELECT count(*) FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail'")).toBe("0");
    const r = paste(worldB);
    expect(r.error).toBeNull();
    for (const p of r.stdout.split("\n").filter((l) => l.split("|").length === 3 && l.split("|")[2] === "")) expect(p.split("|")[1], p).toBe(onlyOverlayProbe(p) ? "f" : "t");
    expect(deferredRuleStands(worldB)).toBe(true);
    const qual = admin(worldB, "SELECT qual FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_admin_trail'");
    expect(qual).toContain("audit_row_node_manageable(resource_type, resource_id)");
    expect(qual).toContain("audit_row_project_visible(resource_type, resource_id)");
    expect(qual).not.toContain("audit_row_project_ref_visible");
    expect(read(m.viewer, worldB)).toEqual(["VIEW:document"]);
    expect(has(m.owner, "acl", worldB)).toBe(true);
  });

  it("20261142 not applied: the paste stops with the instruction and changes nothing", () => {
    const worldA = copy("worlda");
    admin(worldA, [
      "DROP FUNCTION public.audit_row_project_ref_visible(text, text, text, jsonb) CASCADE;",
      "DROP FUNCTION public.audit_row_project_visible(text, text) CASCADE;",
      "DROP FUNCTION public.audit_row_node_manageable(text, text) CASCADE;",
      "DROP TABLE public.audit_dead_letters;",
    ].join("\n"));
    const r = paste(worldA);
    expect(r.error).toMatch(/Apply 20261142_prj_roundG_project_audit_rows\.sql first/);
    expect(admin(worldA, "SELECT to_regprocedure('public.audit_row_node_manageable(text, text)') IS NULL AND to_regclass('public.audit_dead_letters') IS NULL")).toBe("t");
  });

  it("EVID-6: the outbox is the service role's alone — a signed-in member can neither read nor write it", () => {
    const sel = asCaller(db, m.docctrl.caller, "SELECT * FROM audit_dead_letters");
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.code).toBe("42501");
    const ins = asCaller(db, m.docctrl.caller, `INSERT INTO audit_dead_letters (org_id, action, entry, source) VALUES ('${orgId}', 'VIEW', '{}'::jsonb, 'browser')`);
    expect(ins.ok).toBe(false);
    const svc = asCaller(db, { role: "service_role" }, `INSERT INTO audit_dead_letters (org_id, action, entry, source, reported_by) VALUES ('${orgId}', 'VIEW', '{}'::jsonb, 'browser', '${m.viewer.uid}')`);
    expect(svc).toEqual({ ok: true, rows: 1 });
    const bad = asCaller(db, { role: "service_role" }, `INSERT INTO audit_dead_letters (org_id, action, entry, source) VALUES ('${orgId}', 'VIEW', '{}'::jsonb, 'elsewhere')`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("23514");
  });

  it("EVID-6 fix pass: the drain's claim is a compare-and-set, its write is keyed by the outbox id, and only the service role may prune", () => {
    const id = randomUUID();
    const svc = { role: "service_role" } as const;
    expect(asCaller(db, svc, `INSERT INTO audit_dead_letters (id, org_id, action, entry, source) VALUES ('${id}', '${orgId}', 'VIEW', '{}'::jsonb, 'server')`)).toEqual({ ok: true, rows: 1 });
    // two runs claiming the same read: the first wins, the second updates nothing
    const claim = `UPDATE audit_dead_letters SET drain_attempts = 1 WHERE id = '${id}' AND drained_at IS NULL AND drain_attempts = 0`;
    expect(asCaller(db, svc, claim)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(db, svc, claim)).toEqual({ ok: true, rows: 0 });
    // the recovered row under the outbox id: a second write is refused by the primary key
    const write = `INSERT INTO audit_logs (id, action, resource_type, resource_id, org_id, user_id, user_email, user_role, details) VALUES ('${id}', 'AUDIT_DEAD_LETTER', 'org', '${orgId}', '${orgId}', NULL, 'system:audit-outbox', 'system', jsonb_build_object('outboxId', '${id}'))`;
    expect(asCaller(db, svc, write)).toEqual({ ok: true, rows: 1 });
    const again = asCaller(db, svc, write);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("23505");
    expect(admin(db, `SELECT count(*) FROM audit_logs WHERE id = '${id}' AND action = 'AUDIT_DEAD_LETTER' AND details->>'outboxId' = '${id}'`)).toBe("1");
    // the prune: a signed-in member may not delete; the service role may
    admin(db, `UPDATE audit_dead_letters SET drained_at = now() - interval '31 days', audit_log_id = '${id}' WHERE id = '${id}'`);
    const del = asCaller(db, m.docctrl.caller, `DELETE FROM audit_dead_letters WHERE id = '${id}'`);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.code).toBe("42501");
    expect(asCaller(db, svc, `DELETE FROM audit_dead_letters WHERE id = '${id}' AND drained_at <= now() - interval '30 days'`)).toEqual({ ok: true, rows: 1 });
  });
});
