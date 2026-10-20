// document-control Round G — P29 TRANSMITTAL READ, DIST-18 limb (a), at
// RUNTIME on the replayed database (the I-17 harness; `npm run test:db` only).
//
// 20261231 takes SELECT on transmittals.portal_token away from client roles
// (a column-level privilege: the table-level SELECT revoked from PUBLIC, anon
// and authenticated; every other column granted back to authenticated). Each
// statement is sent as PostgREST sends that person's request (role
// `authenticated` or `anon`, the JWT's claims in request.jwt.claims), inside
// a transaction that is rolled back.
//
//   - the token is refused to a Viewer, the sender and a controller alike —
//     and to anon; a `select *` and a write's `RETURNING *` are refused too
//     (why the P29 app names its columns, and why the paste follows the
//     deploy);
//   - REGRESSION: every statement the P29 app still sends with a member's
//     session answers as before — the inbox's read, the next number, the
//     create / edit / draft read / issue with their named-column read-backs,
//     the revoke, the void and the draft delete — and every other column
//     (the items included: limb (b) is intelligence I-30's) still reads
//     through transmittals_select;
//   - the service role (the portal, the register route, the email / receipt
//     / stamp-check routes) still reads the token, by id and by token;
//   - BEFORE the paste (the rollback grant): the same statements answer the
//     same (the app works before the paste) and the token is still open;
//   - the file pasted as ONE script, as the SQL editor sends it: probes true,
//     the counts-only inventory in order, a re-paste the same; without
//     20260910, 20261133 or 20261199 it refuses, changing nothing (review
//     blocker: a column a later paste adds would miss the column grant, and
//     the revoke's WHERE on it would be refused).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, mosDb, selectAs, seedOrg, skipReason, type Caller, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { dollarQuote, runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = "20261231_dc_roundG_transmittal_token_column.sql";
const body = () => readFileSync(join(process.cwd(), "supabase", "migrations", FILE), "utf8");

/** lib/transmittals TRANSMITTAL_CLIENT_COLUMNS, read from the source (the
 *  list the browser's own writes read back). */
function clientColumns(): string {
  const src = readFileSync(join(process.cwd(), "lib", "transmittals.ts"), "utf8");
  const m = /export const TRANSMITTAL_CLIENT_COLUMNS =\s*((?:"[^"]*"\s*\+?\s*)+);/.exec(src);
  if (!m) throw new Error("TRANSMITTAL_CLIENT_COLUMNS not found in lib/transmittals.ts");
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("");
}

/** Statements as `who`, one transaction, rolled back. Each statement's
 *  outcome (`ok:<rows>` or `err:<SQLSTATE>:…`); `after` runs as the
 *  superuser before the rollback and its rows are returned too. */
function asCallerTx(target: string, who: Caller, stmts: string[], after?: string): { outcomes: string[]; after: string[] } {
  const { conn } = mosDb();
  const claims: Record<string, string> = { role: who.role };
  if (who.uid) claims.sub = who.uid;
  if (who.email) claims.email = who.email;
  const sql = [
    "BEGIN;",
    `SET LOCAL ROLE ${who.role};`,
    `SELECT set_config('request.jwt.claims', ${dollarQuote(JSON.stringify(claims))}, true);`,
    ...stmts.map((s) => `SELECT 'OUT ' || harness.try_sql(${dollarQuote(s)});`),
    ...(after ? ["RESET ROLE;", `SELECT 'AFTER ' || x::text FROM (${after}) x;`] : []),
    "ROLLBACK;",
  ].join("\n");
  const r = runPsql(conn!, target, conn!.superuser, { sql });
  if (!r.ok) throw new Error(`statements as ${who.role} failed: ${r.error ?? r.stderr}`);
  const lines = r.stdout.split("\n");
  return {
    outcomes: lines.filter((l) => l.startsWith("OUT ")).map((l) => l.slice(4)),
    after: lines.filter((l) => l.startsWith("AFTER ")).map((l) => l.slice(6)),
  };
}
const one = (target: string, who: Caller, stmt: string) => asCallerTx(target, who, [stmt]).outcomes[0];

interface World {
  orgId: string; m: Record<string, SeededMember>;
  lib: string; doc: string; ver: string; priv: string; tr: string; draft: string; token: string;
}

function seedWorld(target: string): World {
  const s = seedOrg(target, { docctrl: { role: "DocCtrl", roles: ["DocCtrl"] }, engineer: { role: "Engineer-2" }, viewer: { role: "Viewer" } });
  const w: World = {
    orgId: s.orgId, m: s.m, lib: randomUUID(), doc: randomUUID(), ver: randomUUID(), priv: randomUUID(),
    tr: randomUUID(), draft: randomUUID(), token: `tok${randomUUID().replace(/-/g, "")}`,
  };
  admin(target, `
    INSERT INTO org_configurations (org_id, key, data) VALUES ('${w.orgId}', 'capability_policy', '{"caps": {"transmittal.issue": ["Admin", "DocCtrl"]}}'::jsonb);
    INSERT INTO libraries (id, org_id, name, type) VALUES ('${w.lib}', '${w.orgId}', 'P&IDs', 'documents');
    INSERT INTO documents (id, org_id, library_id, name, title, document_number, status, visibility) VALUES
      ('${w.doc}', '${w.orgId}', '${w.lib}', 'p101.pdf', 'Feed pump layout', 'P-101', 'Draft', 'normal');
    INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, created_by) VALUES
      ('${w.ver}', '${w.orgId}', '${w.doc}', 'B', 'p29/${w.orgId.slice(0, 8)}/p101b.pdf', '${w.m.docctrl.uid}');
    UPDATE documents SET current_version_id = '${w.ver}', status = 'Issued', rev = 'B' WHERE id = '${w.doc}';
    INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility, acl_index) VALUES
      ('${w.priv}', '${w.orgId}', '${w.lib}', 'pid.pdf', 'Unit 3 HF alkylation relief system', 'PID-4412', 'C', 'Issued', 'private', '{"allow":{"roles":{"read":["Engineer-2"]}}}'::jsonb);
    -- a DRAFT the Viewer made (theirs to delete)
    INSERT INTO transmittals (id, org_id, seq, number, status, created_by, recipient_name, subject, items) VALUES
      ('${w.draft}', '${w.orgId}', 2, 'TR-0002', 'draft', '${w.m.viewer.uid}', 'Acme', 'Draft', '[{"documentId":"${w.doc}","number":"P-101"}]'::jsonb);
    -- an ISSUED transmittal with a live link, sent by the controller, listing the
    -- private P&ID (seeded with the triggers off: a service-role INSERT born
    -- issued is a restore and lands voided, DEC-45)
    SET session_replication_role = replica;
    INSERT INTO transmittals (id, org_id, seq, number, status, created_by, recipient_name, subject, items, issued_at, portal_token) VALUES
      ('${w.tr}', '${w.orgId}', 7, 'TR-0007', 'issued', '${w.m.docctrl.uid}', 'Jane Doe', 'Unit 3 relief package',
       '[{"documentId":"${w.priv}","number":"PID-4412","title":"Unit 3 HF alkylation relief system","rev":"C"},{"documentId":"${w.doc}","number":"P-101","rev":"B"}]'::jsonb,
       now(), '${w.token}');
    RESET session_replication_role;`);
  return w;
}

/** Every statement the P29 app still sends to transmittals with a member's
 *  session, as PostgREST runs it (a mutation's read-back is its RETURNING). */
function appStatements(w: World, cols: string) {
  const fresh = randomUUID();
  return {
    fresh,
    // lib/transmittals nextTransmittalSeq
    nextSeq: `SELECT seq FROM transmittals WHERE org_id = '${w.orgId}' ORDER BY seq DESC LIMIT 1`,
    // lib/inbox.ts — the sender's own transmittals awaiting receipt
    inbox: (uid: string) => `SELECT id, number, subject, recipient_name, recipient_company, issued_at, items FROM transmittals
      WHERE org_id = '${w.orgId}' AND created_by = '${uid}' AND status = 'issued' ORDER BY issued_at ASC LIMIT 50`,
    // createTransmittal (insert … select(TRANSMITTAL_CLIENT_COLUMNS))
    create: (uid: string) => `INSERT INTO transmittals (id, org_id, seq, number, status, items, created_by, created_by_name, recipient_name)
      VALUES ('${fresh}', '${w.orgId}', 50, 'TR-0050', 'draft', '[{"documentId":"${w.doc}","number":"P-101","stampAccepted":true}]'::jsonb, '${uid}', 'issuer', 'Acme')
      RETURNING ${cols}`,
    // updateTransmittalDraft (update … select("id"))
    edit: `UPDATE transmittals SET subject = 'For construction', updated_at = now() WHERE id = '${fresh}' AND status = 'draft' RETURNING id`,
    // getTransmittalRow (the issue's draft read)
    draftRead: `SELECT ${cols} FROM transmittals WHERE id = '${fresh}'`,
    // issueTransmittal (update … select(TRANSMITTAL_CLIENT_COLUMNS))
    issue: `UPDATE transmittals SET status = 'issued', issued_at = now(), updated_at = now() WHERE id = '${fresh}' AND status = 'draft' RETURNING ${cols}`,
    // revokeTransmittalLink / voidTransmittal / deleteTransmittal (select("id"))
    revoke: `UPDATE transmittals SET portal_revoked_at = now(), updated_at = now() WHERE id = '${w.tr}' AND status IN ('issued', 'acknowledged') AND portal_revoked_at IS NULL RETURNING id`,
    void: `UPDATE transmittals SET status = 'voided', updated_at = now() WHERE id = '${w.tr}' AND status IN ('issued', 'acknowledged') RETURNING id`,
    deleteDraft: `DELETE FROM transmittals WHERE id = '${w.draft}' AND status = 'draft' RETURNING id`,
  };
}

describe.skipIf(skip !== null)("DIST-18 limb (a), 20261231 replayed: portal_token is refused to client roles; every remaining client statement answers as before", () => {
  let w: World;
  let cols = "";
  beforeAll(() => {
    w = seedWorld(db);
    cols = clientColumns();
  });

  it("the REST read of the token is refused (42501) to a Viewer outside an item's ACL, to the sender (a controller) and to an Engineer who may read every item — and to anon", () => {
    const read = `SELECT portal_token FROM transmittals WHERE id = '${w.tr}'`;
    for (const who of [w.m.viewer, w.m.docctrl, w.m.engineer]) {
      expect(one(db, who.caller, read), who.email).toMatch(/^err:42501:/);
    }
    expect(one(db, { role: "anon" }, read)).toMatch(/^err:42501:/);
    // REGRESSION: anon's other statements answer as before — no row (no policy admits it), not a refusal
    expect(one(db, { role: "anon" }, `SELECT id, number, items FROM transmittals`)).toBe("ok:0");
    expect(one(db, { role: "anon" }, `UPDATE transmittals SET status = 'voided' WHERE id = '${w.tr}'`)).toBe("ok:0");
    // the filter is refused too — the token cannot be probed by WHERE
    expect(one(db, w.m.viewer.caller, `SELECT id FROM transmittals WHERE portal_token = '${w.token}'`)).toMatch(/^err:42501:/);
  });

  it("a select('*') and a write's RETURNING * are refused — why the P29 app names its columns, and why the paste follows the deploy — and the refused write changes nothing", () => {
    expect(one(db, w.m.viewer.caller, `SELECT * FROM transmittals WHERE org_id = '${w.orgId}'`)).toMatch(/^err:42501:/);
    const r = asCallerTx(db, w.m.docctrl.caller, [`UPDATE transmittals SET status = 'voided', updated_at = now() WHERE id = '${w.tr}' RETURNING *`],
      `SELECT status FROM transmittals WHERE id = '${w.tr}'`);
    expect(r.outcomes[0]).toMatch(/^err:42501:/);
    expect(r.after).toEqual(["(issued)"]);
  });

  it("REGRESSION: every other column still reads through transmittals_select exactly as before — the items included (DIST-18 limb (b) narrows them after intelligence I-30)", () => {
    expect(one(db, w.m.viewer.caller, `SELECT ${cols}, acknowledged_via, acknowledged_meta, portal_expires_at, portal_revoked_at, portal_revoked_by, portal_last_used_at, portal_open_count, portal_download_count, stamp_check FROM transmittals WHERE id = '${w.tr}'`)).toBe("ok:1");
    expect(selectAs(db, w.m.viewer.caller, `SELECT items->0->>'number', subject FROM transmittals WHERE id = '${w.tr}'`)).toEqual(["PID-4412|Unit 3 relief package"]);
    // RLS is unchanged: another workspace's member still reads nothing
    const other = seedOrg(db, { stranger: { role: "Admin" } });
    expect(one(db, other.m.stranger.caller, `SELECT ${cols} FROM transmittals WHERE id = '${w.tr}'`)).toBe("ok:0");
  });

  it("REGRESSION: the inbox's read (the sender's own, awaiting receipt) and the next number answer as before", () => {
    const a = appStatements(w, cols);
    expect(one(db, w.m.docctrl.caller, a.inbox(w.m.docctrl.uid))).toBe("ok:1");
    expect(selectAs(db, w.m.viewer.caller, a.nextSeq)).toEqual(["7"]);
  });

  it("REGRESSION: the composer and the issue, as the P29 app sends them — create (RETURNING the named columns), edit, the draft read, issue (RETURNING the named columns): the database mints the token, and the issuer cannot read it back", () => {
    const a = appStatements(w, cols);
    const r = asCallerTx(db, w.m.docctrl.caller, [a.create(w.m.docctrl.uid), a.edit, a.draftRead, a.issue, `SELECT portal_token FROM transmittals WHERE id = '${a.fresh}'`],
      `SELECT status || '|' || (portal_token IS NOT NULL)::text || '|' || subject FROM transmittals WHERE id = '${a.fresh}'`);
    expect(r.outcomes.slice(0, 4)).toEqual(["ok:1", "ok:1", "ok:1", "ok:1"]);
    expect(r.outcomes[4]).toMatch(/^err:42501:/);
    expect(r.after).toEqual(["(\"issued|true|For construction\")"]);
    // a member who drafts without transmit authority: the draft and its edit as before
    const e = asCallerTx(db, w.m.viewer.caller, [a.create(w.m.viewer.uid), a.edit, a.draftRead]);
    expect(e.outcomes).toEqual(["ok:1", "ok:1", "ok:1"]);
    // a member cannot plant a token either: the guard (TRX-1, unchanged) clears
    // whatever a member session sends, and the draft is born without one
    const forged = randomUUID();
    const f = asCallerTx(db, w.m.viewer.caller, [`INSERT INTO transmittals (id, org_id, seq, number, status, items, created_by, portal_token)
      VALUES ('${forged}', '${w.orgId}', 51, 'TR-0051', 'draft', '[]'::jsonb, '${w.m.viewer.uid}', 'forged') RETURNING id`],
      `SELECT (portal_token IS NULL)::text FROM transmittals WHERE id = '${forged}'`);
    expect(f.outcomes).toEqual(["ok:1"]);
    expect(f.after).toEqual(["(true)"]);
  });

  it("REGRESSION: the revoke, the void and the draft delete, as the app sends them (RETURNING id) — and who may do them is unchanged", () => {
    const a = appStatements(w, cols);
    expect(asCallerTx(db, w.m.docctrl.caller, [a.revoke, a.void]).outcomes).toEqual(["ok:1", "ok:1"]);
    expect(asCallerTx(db, w.m.viewer.caller, [a.revoke, a.void]).outcomes).toEqual(["ok:0", "ok:0"]);
    expect(one(db, w.m.viewer.caller, a.deleteDraft)).toBe("ok:1");
    expect(one(db, w.m.engineer.caller, a.deleteDraft)).toBe("ok:0");
  });

  it("the service role — the portal (by token), the register route (by org, select *), the receipt — still reads and writes the token's row", () => {
    const svc: Caller = { role: "service_role" };
    expect(selectAs(db, svc, `SELECT portal_token FROM transmittals WHERE id = '${w.tr}'`)).toEqual([w.token]);
    expect(selectAs(db, svc, `SELECT number FROM transmittals WHERE portal_token = '${w.token}'`)).toEqual(["TR-0007"]);
    expect(one(db, svc, `SELECT * FROM transmittals WHERE org_id = '${w.orgId}' ORDER BY seq DESC LIMIT 1000`)).toMatch(/^ok:[1-9]/);
    expect(one(db, svc, `UPDATE transmittals SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by_name = 'Jane Doe', acknowledged_via = 'portal' WHERE id = '${w.tr}' AND status = 'issued' RETURNING *`)).toBe("ok:1");
  });

  it("review minor: DIST-18 residual (v)'s identification query (the record, kept apart from the counts-only paste) runs after the paste and lists the live link with a restricted item by id and number — never the token", () => {
    const rec = readFileSync(join(process.cwd(), "audit-reports", "document-control", "05-distribution.md"), "utf8");
    const m = /```sql\n(-- DIST-18 residual \(v\)[\s\S]*?)```/.exec(rec);
    expect(m, "the identification query is in DIST-18's record").not.toBeNull();
    const q = m![1];
    expect(q).toMatch(/^SELECT DISTINCT t\.id, t\.number\n/m);
    const rows = admin(db, q).split("\n").filter((l) => l.length > 0);
    expect(rows).toContain(`${w.tr}|TR-0007`);
    expect(rows.every((r) => r.split("|").length === 2)).toBe(true);
    expect(rows.join("\n")).not.toContain(w.token);
    // the draft (no link) is not listed
    expect(rows.some((r) => r.startsWith(w.draft))).toBe(false);
  });

  it("review blocker: the search slice's old or() term was a service-role oracle on the token; the per-column ilike value is not", () => {
    const svc: Caller = { role: "service_role" };
    const p = w.token.slice(0, 4);
    // What PostgREST compiled q='qqzzqq,portal_token.like.<p>*' into under the
    // old .or(): the piece before the comma keeps its trailing backslash, and
    // LIKE raises "must not end with escape character" only when the matcher
    // reaches it — a prefix that matches no row is just false, and the
    // injected term decides the row.
    const oldOr = `SELECT count(*) FROM transmittals WHERE org_id = '${w.orgId}' AND (number ILIKE '%qqzzqq\\' OR portal_token LIKE '${p}%')`;
    expect(selectAs(db, svc, oldOr)).toEqual(["1"]);
    expect(selectAs(db, svc, oldOr.replace(`'${p}%'`, "'zzzz%'"))).toEqual(["0"]);
    // What the route sends now: the whole text as ONE LIKE-escaped value per
    // column (PostgREST reads its * as %) — no error, no row, no token term.
    for (const col of ["number", "subject", "recipient_name", "recipient_company"]) {
      expect(one(db, svc, `SELECT 1 FROM transmittals WHERE org_id = '${w.orgId}' AND ${col} ILIKE '%qqzzqq,portal\\_token.like.${p}%%'`)).toBe("ok:0");
    }
    expect(one(db, svc, `SELECT 1 FROM transmittals WHERE org_id = '${w.orgId}' AND number ILIKE '%TR-0007\\\\%'`)).toBe("ok:0");
  });
});

describe.skipIf(skip !== null)("BEFORE the paste (HEAD's table-level SELECT — also the file's rollback): the P29 app works the same, and the token is still open", () => {
  const scratch = "mos_p29_before";
  let w: World;
  let cols = "";
  beforeAll(() => {
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    // the file's ROLLBACK line (HEAD's privileges)
    admin(scratch, "GRANT SELECT ON transmittals TO anon, authenticated;");
    w = seedWorld(scratch);
    cols = clientColumns();
  });
  afterAll(() => { try { admin("postgres", `DROP DATABASE IF EXISTS ${scratch}`); } catch { /* deleted with the cluster */ } });

  it("every statement the P29 app sends answers as after the paste", () => {
    const a = appStatements(w, cols);
    expect(one(scratch, w.m.docctrl.caller, a.inbox(w.m.docctrl.uid))).toBe("ok:1");
    expect(asCallerTx(scratch, w.m.docctrl.caller, [a.create(w.m.docctrl.uid), a.edit, a.draftRead, a.issue]).outcomes).toEqual(["ok:1", "ok:1", "ok:1", "ok:1"]);
    expect(asCallerTx(scratch, w.m.docctrl.caller, [a.revoke, a.void]).outcomes).toEqual(["ok:1", "ok:1"]);
    expect(one(scratch, w.m.viewer.caller, a.deleteDraft)).toBe("ok:1");
  });

  it("… and the token is still open to every member (DIST-17's door — what the paste closes)", () => {
    expect(selectAs(scratch, w.m.viewer.caller, `SELECT portal_token FROM transmittals WHERE id = '${w.tr}'`)).toEqual([w.token]);
  });
});

describe.skipIf(skip !== null)("20261231 pasted as ONE script, as the SQL editor sends it", () => {
  const paste = (scratch: string) => runPsql(mosDb().conn!, scratch, "postgres", { sql: body() });
  const rowsOf = (stdout: string) => stdout.split("\n").filter((l) => l.length > 0).map((l) => {
    const [check, ok, n] = l.split("|");
    return { check, ok, n };
  });
  /** HEAD's privileges: the table-level SELECT Supabase grants every table. */
  const toHead = (scratch: string) => admin(scratch, "REVOKE SELECT ON TABLE transmittals FROM authenticated; GRANT SELECT ON transmittals TO anon, authenticated;");
  const scratches: string[] = [];
  afterAll(() => {
    for (const s of scratches) { try { admin("postgres", `DROP DATABASE IF EXISTS ${s}`); } catch { /* deleted with the cluster */ } }
  });

  it("on HEAD's shape: one result set — nine probes true, then the ten counts-only inventory rows in order; a re-paste answers the same (and says it is a re-paste)", () => {
    const scratch = "mos_p29_paste";
    scratches.push(scratch);
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    toHead(scratch);
    expect(admin(scratch, "SELECT has_column_privilege('authenticated', 'public.transmittals', 'portal_token', 'SELECT')")).toBe("t");
    const total = admin(scratch, "SELECT count(*) FROM transmittals");
    const withToken = admin(scratch, "SELECT count(*) FROM transmittals WHERE portal_token IS NOT NULL");
    for (let pass = 1; pass <= 2; pass++) {
      const r = paste(scratch);
      expect(r.errors, r.stderr).toEqual([]);
      const rows = rowsOf(r.stdout);
      expect(rows.length, `pass ${pass}`).toBe(19);
      const probes = rows.slice(0, 9);
      const inventory = rows.slice(9);
      expect(probes.filter((p) => p.ok !== "t"), JSON.stringify(probes)).toEqual([]);
      expect(probes.every((p) => p.n === "")).toBe(true);
      expect(inventory.every((i) => i.ok === "" && /^\d+$/.test(i.n)), JSON.stringify(inventory)).toBe(true);
      expect(inventory.map((i) => i.check.replace(/:.*$/, ""))).toEqual(Array(10).fill("inventory (before apply)"));
      expect(inventory[0].n).toBe(total);
      expect(inventory[1].n).toBe(withToken);
      expect(inventory[5].n).toBe(pass === 1 ? "1" : "0"); // authenticated held table-level SELECT
      expect(inventory[7].n).toBe("111");                    // INSERT / UPDATE / DELETE, left as they were
      expect([inventory[8].n, inventory[9].n]).toEqual(["1", "1"]); // authenticated and anon could read the table
    }
    expect(admin(scratch, "SELECT has_column_privilege('authenticated', 'public.transmittals', 'portal_token', 'SELECT')")).toBe("f");
    expect(admin(scratch, "SELECT has_column_privilege('authenticated', 'public.transmittals', 'items', 'SELECT')")).toBe("t");
    expect(admin(scratch, "SELECT has_column_privilege('anon', 'public.transmittals', 'portal_token', 'SELECT')")).toBe("f");
    expect(admin(scratch, "SELECT has_column_privilege('anon', 'public.transmittals', 'items', 'SELECT')")).toBe("t");
  });

  it("never grants a role a column it could not read before: with anon holding no SELECT on HEAD, the paste leaves anon with none", () => {
    const scratch = "mos_p29_no_anon";
    scratches.push(scratch);
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    toHead(scratch);
    admin(scratch, "REVOKE SELECT ON TABLE transmittals FROM anon;");
    const r = paste(scratch);
    expect(r.errors, r.stderr).toEqual([]);
    const rows = rowsOf(r.stdout);
    expect(rows.slice(0, 9).filter((p) => p.ok !== "t"), JSON.stringify(rows)).toEqual([]);
    expect(rows[18].n).toBe("0");
    expect(admin(scratch, "SELECT has_any_column_privilege('anon', 'public.transmittals', 'SELECT')")).toBe("f");
  });

  it("WITHOUT 20260910 (no portal_token column) it refuses, naming it, and changes nothing", () => {
    const scratch = "mos_p29_no_910";
    scratches.push(scratch);
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    toHead(scratch);
    admin(scratch, "ALTER TABLE transmittals DROP COLUMN portal_token CASCADE;");
    const r = paste(scratch);
    expect(r.error).toMatch(/20261231 needs 20260910/);
    expect(admin(scratch, "SELECT has_table_privilege('authenticated', 'public.transmittals', 'SELECT')")).toBe("t");
  });

  it("review blocker: WITHOUT 20261133 (its portal lifecycle columns not yet added) it refuses, naming it, and changes nothing — the column grant would otherwise miss the columns 20261133 adds after it", () => {
    const scratch = "mos_p29_no_1133";
    scratches.push(scratch);
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    toHead(scratch);
    admin(scratch, `ALTER TABLE transmittals DROP COLUMN portal_expires_at CASCADE, DROP COLUMN portal_revoked_at CASCADE, DROP COLUMN portal_revoked_by CASCADE,
      DROP COLUMN portal_last_used_at CASCADE, DROP COLUMN portal_open_count CASCADE, DROP COLUMN portal_download_count CASCADE;`);
    const r = paste(scratch);
    expect(r.error).toMatch(/20261231 needs 20261133/);
    expect(admin(scratch, "SELECT has_table_privilege('authenticated', 'public.transmittals', 'SELECT')")).toBe("t");
    expect(admin(scratch, "SELECT has_column_privilege('authenticated', 'public.transmittals', 'portal_token', 'SELECT')")).toBe("t");
  });

  it("review blocker: WITHOUT 20261199 (no stamp_check — the file held on the P24 deploy) it refuses, naming it, and changes nothing", () => {
    const scratch = "mos_p29_no_1199";
    scratches.push(scratch);
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    toHead(scratch);
    admin(scratch, "ALTER TABLE transmittals DROP COLUMN stamp_check CASCADE;");
    const r = paste(scratch);
    expect(r.error).toMatch(/20261231 needs 20261199/);
    expect(admin(scratch, "SELECT has_table_privilege('authenticated', 'public.transmittals', 'SELECT')")).toBe("t");
  });

  it("why the order matters (the failure the refusal prevents): a column added AFTER the column grant reaches members with no SELECT, and the revoke's WHERE on it is refused (42501)", () => {
    const scratch = "mos_p29_late_col";
    scratches.push(scratch);
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    toHead(scratch);
    const r = paste(scratch);
    expect(r.errors, r.stderr).toEqual([]);
    admin(scratch, "ALTER TABLE transmittals ADD COLUMN p29_late_probe timestamptz;");
    expect(admin(scratch, "SELECT has_column_privilege('authenticated', 'public.transmittals', 'p29_late_probe', 'SELECT')")).toBe("f");
    const w = seedWorld(scratch);
    expect(one(scratch, w.m.docctrl.caller, `UPDATE transmittals SET updated_at = now() WHERE id = '${w.tr}' AND p29_late_probe IS NULL RETURNING id`)).toMatch(/^err:42501:/);
    // with every column present at paste time (the refusal's guarantee), the revoke answers
    expect(asCallerTx(scratch, w.m.docctrl.caller, [appStatements(w, clientColumns()).revoke]).outcomes).toEqual(["ok:1"]);
  });
});
