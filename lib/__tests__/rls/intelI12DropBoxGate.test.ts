// intelligence I-12 — 20261212's deny-binding gate (DEC-90 ruling R2 and its
// follow-up, the integrator, 2026-10-14), run on PostgreSQL 16 against the
// replayed database.
//
// 20261212 re-creates node_visible/6 with the deny binding (DACL-12 c1,
// IEDGE-12 c2) ONLY when BOTH hold: the operator switch app.i12_deny_binding
// is 'on' in the same paste (default OFF — the paste guide says do NOT set
// it), AND every drop-box precondition count is 0. A "drop box" (a library or
// folder that denies a role READ and lets it UPLOAD) is a legitimate pattern
// that must keep working, and the binding would refuse the uploader's
// INSERT … RETURNING (documents_acl_select is a RESTRICTIVE SELECT policy);
// a drop box configured AFTER the paste cannot be counted at the paste, so
// the binding is held back by default and lands with intelligence I-30
// (drop-box support, no switch). The KACL-5 index applies on every paste.
//
// Each case works on a scratch copy of the replayed database whose
// node_visible/6 is put back to 20261203's body (the state a live paste
// starts from — 20261212's own ROLLBACK), then pastes 20261212 exactly as the
// SQL editor sends it (one simple-query message, as `postgres`) — as written
// (the switch off), or with its commented SET LOCAL line uncommented (the
// switch on; never the paste guide's instruction):
//
//   · the replayed fresh install (no switch): node_visible/6 unchanged;
//   · as written, no drop box: a NOTICE ("held back by default"),
//     node_visible/6 byte-for-byte as it was, the index created;
//   · switch on, a drop box present: a NOTICE naming the drop boxes, the body
//     unchanged, and the uploader's INSERT … RETURNING still returns its row;
//   · switch on, no drop box: the binding applies — a read deny on a normal
//     row binds for the role it names only; controllers keep the row;
//   · switch on, a re-paste after the binding applied with a drop box created
//     since: the binding is never taken away, and that drop box does NOT take
//     uploads — WHY the switch stays off (pinned, never mistaken for covered).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { dollarQuote, runPsql } from "./pgHarness";

const skip = skipReason();
const MIG = join(process.cwd(), "supabase", "migrations");
const FILE_1212 = "20261212_intel_roundG_node_visible_deny.sql";
const SQL_1212 = readFileSync(join(MIG, FILE_1212), "utf8");

/** 20261203's node_visible/6, verbatim (its section 3). */
function nodeVisible1203(): string {
  const f = readdirSync(MIG).find((x) => x.startsWith("20261203_"))!;
  const s = readFileSync(join(MIG, f), "utf8");
  const start = s.indexOf("CREATE OR REPLACE FUNCTION node_visible(\n  p_visibility text,");
  const end = s.indexOf("\n$$;", start);
  expect(start, "20261203 defines node_visible/6").toBeGreaterThan(0);
  return s.slice(start, end + 4);
}

/** The body (prosrc) of 20261203's node_visible/6: the text between its $$ quotes. */
function nodeVisible1203Body(): string {
  const def = nodeVisible1203();
  const open = def.indexOf("AS $$") + "AS $$".length;
  return def.slice(open, def.lastIndexOf("$$"));
}

interface Row { check: string; ok: string; n: string }
interface Paste { rows: Row[]; notice: string; ok: boolean; error: string | null }

const SWITCH_LINE = "-- SET LOCAL app.i12_deny_binding = 'on';";

/** Pastes 20261212 as the SQL editor does: one message, as postgres; NOTICEs
 *  kept. `switchOn` uncomments the file's SET LOCAL line (the operator
 *  switch, which the paste guide says to leave off). */
function paste(db: string, opts: { switchOn?: boolean } = {}): Paste {
  const { conn } = mosDb();
  expect(SQL_1212.split(SWITCH_LINE)).toHaveLength(2);
  const sql = opts.switchOn ? SQL_1212.replace(SWITCH_LINE, SWITCH_LINE.slice(3)) : SQL_1212;
  const r = runPsql(conn!, db, "postgres", { sql }, { client_min_messages: "notice" });
  const rows = r.stdout.split("\n").filter((l) => l.includes("|")).map((l) => {
    const parts = l.split("|");
    return { check: parts.slice(0, -2).join("|"), ok: parts.at(-2)!, n: parts.at(-1)! };
  });
  return { rows, notice: r.stderr, ok: r.ok, error: r.error };
}

const row = (p: Paste, startsWith: string): Row => {
  const found = p.rows.filter((r) => r.check.startsWith(startsWith));
  expect(found, startsWith).toHaveLength(1);
  return found[0];
};
const preconditions = (p: Paste) => p.rows.filter((r) => r.check.startsWith("precondition P"));
const bodyHash = (db: string) => admin(db, "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6 AND pronamespace = 'public'::regnamespace");
const bodyHasBinding = (db: string) => admin(db, "SELECT prosrc LIKE '%IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (%' FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6 AND pronamespace = 'public'::regnamespace") === "t";
const indexExists = (db: string) => admin(db, "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'document_versions_source_file_key_idx'") === "1";

const DROP_BOX_INDEX = JSON.stringify({ allow: { roles: { upload: ["Vendor"], read: ["Engineer"] } }, deny: { roles: { read: ["Vendor"] } } });
const DENY_READ_AND_UPLOAD_INDEX = JSON.stringify({ allow: { roles: { read: ["Engineer"] } }, deny: { roles: { read: ["Vendor"], upload: ["Vendor"] } } });
const rule = (effect: "allow" | "deny", role: string, ...actions: string[]) => ({ effect, subject: { type: "role", id: role }, actions });
const acl = (...rules: object[]) => JSON.stringify({ inherit: true, visibility: "normal", rules });

describe.skipIf(skip !== null)("20261212 — the deny-binding gate (DEC-90 R2: switch off by default, drop boxes counted), on PostgreSQL 16", () => {
  const scratch = `mos_i12_dropbox_${process.pid}`;
  let orgId = "";
  let m: Record<string, SeededMember> = {};

  const library = (name: string, libAcl: string, defaultAcl: string | null): string => {
    const id = randomUUID();
    admin(scratch, `INSERT INTO libraries (id, org_id, name, type, acl, default_new_acl) VALUES ('${id}', '${orgId}', '${name}', 'documents', '${libAcl}'::jsonb, ${defaultAcl ? `'${defaultAcl}'::jsonb` : "NULL"})`);
    return id;
  };
  /** The library page's upload, as the member: insert(…).select("id") — INSERT … RETURNING. */
  const uploadAs = (who: SeededMember, libId: string, index: string) =>
    asCaller(scratch, who.caller, `INSERT INTO documents (org_id, library_id, name, title, document_number, rev, status, visibility, acl_index, created_by, updated_by)
      VALUES ('${orgId}', '${libId}', 'u.pdf', 'Uploaded', 'DB-${randomUUID().slice(0, 8)}', '0', 'Draft', 'normal', '${index}'::jsonb, '${who.uid}', '${who.uid}') RETURNING id`);
  const seedDoc = (libId: string, index: string): string => {
    const id = randomUUID();
    admin(scratch, `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility, acl_index)
      VALUES ('${id}', '${orgId}', '${libId}', 'd.pdf', 'Seeded', 'SD-${id.slice(0, 8)}', '0', 'Draft', 'normal', '${index}'::jsonb)`);
    return id;
  };
  const sees = (who: SeededMember, docId: string) => selectAs(scratch, who.caller, `SELECT count(*) FROM documents WHERE id = '${docId}'`)[0];

  beforeAll(() => {
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${REPLAY_DB}`);
    // A clean slate for the precondition: other suites may have seeded rows
    // into the replayed database (this copy only).
    admin(scratch, "SET session_replication_role = replica; DELETE FROM documents; DELETE FROM collections; DELETE FROM libraries;");
    // The state a live paste starts from: 20261203's node_visible/6.
    admin(scratch, nodeVisible1203());
    admin(scratch, "DROP INDEX IF EXISTS document_versions_source_file_key_idx");
    expect(bodyHasBinding(scratch)).toBe(false);
    const s = seedOrg(scratch, { admin: { role: "Admin" }, vendor: { role: "Vendor" }, engineer: { role: "Engineer" } });
    orgId = s.orgId;
    m = s.m;
  });
  afterAll(() => {
    if (scratch) {
      try { admin("postgres", `DROP DATABASE IF EXISTS ${scratch}`); } catch { /* the cluster is deleted after the run anyway */ }
    }
  });

  it("the replayed fresh install (the harness never sets the switch) left node_visible/6 as 20261203 wrote it, and took the index", () => {
    expect(bodyHasBinding(REPLAY_DB)).toBe(false);
    expect(admin(REPLAY_DB, "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6 AND pronamespace = 'public'::regnamespace"))
      .toBe(admin(REPLAY_DB, `SELECT md5(${dollarQuote(nodeVisible1203Body())})`));
    expect(indexExists(REPLAY_DB)).toBe(true);
  });

  it("AS WRITTEN (the switch off — the default), no drop box: a NOTICE says the binding is held back by default, node_visible/6 is byte-for-byte as it was, the index is created, every precondition 0", () => {
    const before = bodyHash(scratch);
    const p = paste(scratch);
    expect(p.error).toBeNull();
    expect(p.ok).toBe(true);
    expect(p.notice).toMatch(/NOTICE:\s+20261212 left node_visible\/6 unchanged — the deny binding does not apply; the index was created\. Why: it is held back by default: the operator switch app\.i12_deny_binding is not 'on' \(DEC-90 — leave it off\)\. The binding lands with intelligence I-30/);
    expect(p.notice).not.toMatch(/drop-box precondition row/);
    expect(p.rows).toHaveLength(34);
    expect(row(p, "operator switch: app.i12_deny_binding was NOT set").ok).toBe("t");
    expect(row(p, "deny binding gate (DEC-90)").ok).toBe("f");
    expect(row(p, "node_visible/6 is what the gate decided").ok).toBe("t");
    expect(p.rows.filter((r) => r.check.includes("(binding applied; NULL when held back)")).map((r) => r.ok)).toEqual(["", "", ""]);
    for (const k of ["KACL-5: document_versions_source_file_key_idx exists", "node_visible/6 (either body)", "node_visible/3 and /6", "behaviour (no session, either body)", "documents_acl_select and collections_acl_select"]) expect(row(p, k).ok, k).toBe("t");
    for (const r of preconditions(p)) expect(r.n, r.check).toBe("0");
    expect(bodyHash(scratch)).toBe(before);
    expect(bodyHasBinding(scratch)).toBe(false);
    expect(indexExists(scratch)).toBe(true);
  });

  it("switch ON, a drop box present: the uploader's INSERT … RETURNING works before; the paste raises a NOTICE naming the drop boxes, leaves node_visible/6 byte-for-byte as it was, creates the index; the drop box still takes the uploader's rows after", () => {
    const box = library("Vendor drop box", acl(rule("deny", "Vendor", "read"), rule("allow", "Vendor", "upload"), rule("allow", "Engineer", "read", "upload")), acl());
    expect(uploadAs(m.vendor, box, DROP_BOX_INDEX), "before the paste").toEqual({ ok: true, rows: 1 });
    const before = bodyHash(scratch);

    const p = paste(scratch, { switchOn: true });
    expect(p.error).toBeNull();
    expect(p.ok).toBe(true);
    expect(p.notice).toMatch(/NOTICE:\s+20261212 left node_visible\/6 unchanged — the deny binding does not apply; the index was created\. Why: \d+ drop-box precondition row\(s\) are not 0 \(DEC-90 ruling R2\)/);
    expect(p.notice).not.toMatch(/held back by default/);
    expect(p.rows).toHaveLength(34);
    // the probes: index true; switch probe false (it was set); gate false; "what the gate decided" true; the new body's three probes NULL; the rest true
    expect(row(p, "KACL-5: document_versions_source_file_key_idx exists").ok).toBe("t");
    expect(row(p, "operator switch: app.i12_deny_binding was NOT set").ok).toBe("f");
    expect(row(p, "deny binding gate (DEC-90)").ok).toBe("f");
    expect(row(p, "node_visible/6 is what the gate decided").ok).toBe("t");
    expect(p.rows.filter((r) => r.check.includes("(binding applied; NULL when held back)")).map((r) => r.ok)).toEqual(["", "", ""]);
    for (const k of ["node_visible/6 (either body)", "node_visible/3 and /6", "behaviour (no session, either body)", "documents_acl_select and collections_acl_select"]) expect(row(p, k).ok, k).toBe("t");
    // the precondition says why: the library's own ACL (P5) and the uploaded row (P1)
    const pre = preconditions(p);
    expect(pre).toHaveLength(6);
    expect(Number(row(p, "precondition P1").n)).toBe(1);
    expect(Number(row(p, "precondition P5").n)).toBe(1);
    const total = pre.reduce((a, r) => a + Number(r.n), 0);
    expect(p.notice).toContain(`Why: ${total} drop-box precondition row(s)`);

    expect(bodyHash(scratch)).toBe(before);
    expect(bodyHasBinding(scratch)).toBe(false);
    expect(indexExists(scratch)).toBe(true);
    // the drop box keeps working, exactly as before the paste
    expect(uploadAs(m.vendor, box, DROP_BOX_INDEX), "after the paste").toEqual({ ok: true, rows: 1 });
  });

  it("switch ON, no drop box: the binding applies — every probe but the switch probe true, every precondition 0; a read deny on a normal row binds for the role it names only; controllers keep the row; the paste is safe to repeat", () => {
    // remove the drop box: the role is now denied upload too (not a drop box)
    admin(scratch, "SET session_replication_role = replica; DELETE FROM documents; DELETE FROM libraries;");
    const lib = library("Engineering only", acl(rule("deny", "Vendor", "read", "upload"), rule("allow", "Engineer", "read", "upload")), acl());
    const doc = seedDoc(lib, DENY_READ_AND_UPLOAD_INDEX);
    // before the paste (20261203): a normal row is open to every member
    expect(sees(m.vendor, doc)).toBe("1");

    for (const attempt of ["first paste", "re-paste"]) {
      const p = paste(scratch, { switchOn: true });
      expect(p.error, attempt).toBeNull();
      expect(p.notice, attempt).not.toMatch(/left node_visible\/6 unchanged/);
      expect(p.rows, attempt).toHaveLength(34);
      for (const r of p.rows.filter((x) => x.n === "" && !x.check.startsWith("operator switch:"))) expect(r.ok, `${attempt}: ${r.check}`).toBe("t");
      expect(row(p, "operator switch: app.i12_deny_binding was NOT set").ok).toBe("f");
      for (const r of preconditions(p)) expect(r.n, `${attempt}: ${r.check}`).toBe("0");
      expect(row(p, "deny binding gate (DEC-90)").ok).toBe("t");
      expect(bodyHasBinding(scratch)).toBe(true);
    }
    // the deny binds at the database for the member it names; nobody else changes
    expect(sees(m.vendor, doc)).toBe("0");
    expect(sees(m.engineer, doc)).toBe("1");
    expect(sees(m.admin, doc)).toBe("1");
  });

  it("switch ON, a re-paste never takes an applied binding away: a drop box created since holds the gate (NOTICE, body unchanged) — and that drop box does not take uploads (WHY the switch stays off by default; the binding lands with intelligence I-30's drop-box support)", () => {
    expect(bodyHasBinding(scratch)).toBe(true);
    const box = library("Later drop box", acl(rule("deny", "Vendor", "read"), rule("allow", "Vendor", "upload")), acl());
    const before = bodyHash(scratch);
    const p = paste(scratch, { switchOn: true });
    expect(p.error).toBeNull();
    expect(p.notice).toMatch(/left node_visible\/6 unchanged/);
    expect(row(p, "deny binding gate (DEC-90)").ok).toBe("f");
    expect(row(p, "node_visible/6 is what the gate decided").ok).toBe("t");
    expect(bodyHash(scratch)).toBe(before);
    expect(bodyHasBinding(scratch)).toBe(true);
    // WHY THE SWITCH STAYS OFF (DEC-90): with the binding live, a drop box
    // configured AFTER the paste refuses its uploader's INSERT … RETURNING —
    // a regression; intelligence I-30 lands the binding with drop-box support.
    const o = uploadAs(m.vendor, box, DROP_BOX_INDEX);
    expect(o).toMatchObject({ ok: false, code: "42501" });
    expect((o as { message: string }).message).toMatch(/new row violates row-level security policy "documents_acl_select"/);
  });
});

describe.skipIf(skip !== null)("20261212 — what each precondition counts (P1–P6), on PostgreSQL 16", () => {
  const scratch = `mos_i12_precond_${process.pid}`;
  afterAll(() => {
    try { admin("postgres", `DROP DATABASE IF EXISTS ${scratch}`); } catch { /* deleted with the cluster */ }
  });

  it("each drop-box shape is counted once, in its own row; a subject denied read AND upload on the same node, and a user-scoped deny on a private row (already bound), are not", () => {
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${REPLAY_DB}`);
    admin(scratch, "SET session_replication_role = replica; DELETE FROM documents; DELETE FROM collections; DELETE FROM libraries;");
    admin(scratch, nodeVisible1203());
    const { orgId } = seedOrg(scratch, { admin: { role: "Admin" } });
    const T = randomUUID(), U = randomUUID();
    const subj = (type: string, id: string, effect: "allow" | "deny", ...actions: string[]) => ({ effect, subject: { type, id }, actions });
    const lib = (a: object[], d: object[] | null): string => {
      const id = randomUUID();
      admin(scratch, `INSERT INTO libraries (id, org_id, name, type, acl, default_new_acl) VALUES ('${id}', '${orgId}', 'L-${id.slice(0, 6)}', 'documents', '${acl(...a)}'::jsonb, ${d ? `'${acl(...d)}'::jsonb` : "NULL"})`);
      return id;
    };
    const folder = (libId: string, vis: string, a: object[] | null, index: object | null) => {
      admin(scratch, `INSERT INTO collections (org_id, library_id, name, visibility, acl, acl_index) VALUES ('${orgId}', '${libId}', 'F', '${vis}', ${a ? `'${acl(...a)}'::jsonb` : "NULL"}, ${index ? `'${JSON.stringify(index)}'::jsonb` : "NULL"})`);
    };
    const doc = (libId: string, vis: string, index: object) => {
      admin(scratch, `INSERT INTO documents (org_id, library_id, name, title, document_number, rev, status, visibility, acl_index) VALUES ('${orgId}', '${libId}', 'd', 'd', 'N-${randomUUID().slice(0, 8)}', '0', 'Draft', '${vis}', '${JSON.stringify(index)}'::jsonb)`);
    };
    // P5: a team denied read and allowed upload; a default ACL denying a role read; a role denied discover
    lib([subj("team", T, "deny", "read"), subj("team", T, "allow", "upload")], null);
    lib([], [subj("role", "Vendor", "deny", "read")]);
    lib([subj("role", "Guest", "deny", "discover")], null);
    // not P5: denied read AND upload on the same ACL; a user denied discover only
    const plain = lib([subj("role", "Contractor", "deny", "read", "upload")], null);
    lib([subj("user", U, "deny", "discover")], null);
    // P6: a folder denying the whole workspace read; not P6: read AND upload denied on the same folder ACL
    folder(plain, "normal", [subj("org", orgId, "deny", "read"), subj("org", orgId, "allow", "upload")], null);
    folder(plain, "normal", [subj("role", "Visitor", "deny", "read", "upload")], null);
    // P3: a normal folder's index denies a role read only; P4: a private folder's index denies a team discover
    folder(plain, "normal", null, { deny: { roles: { read: ["Viewer"] } } });
    folder(plain, "private", null, { deny: { teams: { discover: [T] } } });
    // P2: a private document's index denies a role read; not P2: a user (already bound in 20261203)
    doc(plain, "private", { deny: { roles: { read: ["Vendor"] } } });
    doc(plain, "private", { deny: { users: { read: [U] } } });
    // not P1: a normal document's index denies a role read AND upload
    doc(plain, "normal", { deny: { roles: { read: ["Vendor"], upload: ["Vendor"] } } });

    const p = paste(scratch);
    expect(p.error).toBeNull();
    expect(preconditions(p).map((r) => [r.check.slice(0, "precondition P1".length), r.n])).toEqual([
      ["precondition P1", "0"],
      ["precondition P2", "1"],
      ["precondition P3", "1"],
      ["precondition P4", "1"],
      ["precondition P5", "3"],
      ["precondition P6", "1"],
    ]);
    expect(row(p, "deny binding gate (DEC-90)").ok).toBe("f");
    // as written (the switch off): the NOTICE names both reasons
    expect(p.notice).toContain("Why: it is held back by default: the operator switch app.i12_deny_binding is not 'on' (DEC-90 — leave it off); 7 drop-box precondition row(s) are not 0 (DEC-90 ruling R2)");
    expect(bodyHasBinding(scratch)).toBe(false);
  });
});
