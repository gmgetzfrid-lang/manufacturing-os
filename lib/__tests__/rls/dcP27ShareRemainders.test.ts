// document-control Round G — P27 SHARE REMAINDERS, at RUNTIME on the replayed
// database (the I-17 harness; `npm run test:db` only).
//
// 1. intelligence DACL-4 criterion 3 (20261227): a share written straight into
//    document_shares — the INSERT PostgREST sends for a signed-in person, the
//    app's door or anyone else holding a session — leaves exactly ONE
//    SHARE_LINK_CREATED audit row in the app door's shape; a refused mint
//    leaves none; the service role (a restore, the SQL console) is not
//    recorded; the app's probe answers true. Each statement is sent as
//    PostgREST sends that person's request (role `authenticated`, the JWT's
//    claims in request.jwt.claims). The file pasted as ONE script, as the SQL
//    editor sends it: it refuses (changing nothing) without 20261080, and a
//    re-paste answers every probe true.
// 2. document-control DIST-17's DATABASE half, pinned as it stands (OPEN —
//    DIST-18): transmittals_select (20260910) still admits every active member
//    to the whole row, items and portal_token included. The register and its
//    cover sheet are filtered on the server (app/api/transmittal/register);
//    the REST read is not, until DIST-18's owner lands the database half.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, selectAs, seedOrg, skipReason, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();
const db = REPLAY_DB;
const FILE = "20261227_dc_roundG_share_created_audit.sql";
const body = () => readFileSync(join(process.cwd(), "supabase", "migrations", FILE), "utf8");
const token = () => randomUUID().replace(/-/g, "");

describe.skipIf(skip !== null)("DACL-4 c3: a share minted straight into document_shares leaves one SHARE_LINK_CREATED row, at runtime", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let doc = "";
  let draft = "";

  const insertShare = (who: SeededMember["caller"], createdBy: string, docId: string, note = "for the vendor") => {
    const id = randomUUID();
    const r = asCaller(db, who, `INSERT INTO document_shares (id, token, org_id, document_id, created_by, expires_at, note)
      VALUES ('${id}', '${token()}', '${orgId}', '${docId}', '${createdBy}', now() + interval '7 days', '${note}')`);
    return { id, r };
  };
  const recordsOf = (shareId: string) =>
    admin(db, `SELECT count(*) FROM audit_logs WHERE action = 'SHARE_LINK_CREATED' AND details->>'shareId' = '${shareId}'`);

  beforeAll(() => {
    const s = seedOrg(db, { docctrl: { role: "DocCtrl", roles: ["DocCtrl"] }, viewer: { role: "Viewer" }, engineer: { role: "Engineer-2" } });
    orgId = s.orgId;
    m = s.m;
    const lib = randomUUID();
    doc = randomUUID();
    draft = randomUUID();
    admin(db, [
      `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'Shares', 'documents')`,
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility) VALUES ('${doc}', '${orgId}', '${lib}', 'p101.pdf', 'Relief P&ID', 'P-101', 'B', 'Issued', 'normal')`,
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility) VALUES ('${draft}', '${orgId}', '${lib}', 'p102.pdf', 'Draft P&ID', 'P-102', 'A', 'Draft', 'normal')`,
    ].join(";\n") + ";");
  });

  it("a controller's direct INSERT (the app door's own statement) writes exactly ONE row: SHARE_LINK_CREATED on the document, by the caller, details { shareId, expiresAt, note, recordedBy: database }", () => {
    const { id, r } = insertShare(m.docctrl.caller, m.docctrl.uid, doc);
    expect(r).toEqual({ ok: true, rows: 1 });
    expect(recordsOf(id)).toBe("1");
    const row = admin(db, `SELECT resource_type || '|' || resource_id || '|' || org_id || '|' || user_id || '|' || (details ? 'expiresAt')::text || '|' || (details->>'note') || '|' || (details->>'recordedBy')
      FROM audit_logs WHERE action = 'SHARE_LINK_CREATED' AND details->>'shareId' = '${id}'`);
    expect(row).toBe(`document|${doc}|${orgId}|${m.docctrl.uid}|true|for the vendor|database`);
    // the record carries the expiry the share was stored with (after the anchor guard)
    expect(admin(db, `SELECT (a.details->>'expiresAt')::timestamptz = s.expires_at FROM audit_logs a JOIN document_shares s ON s.id::text = a.details->>'shareId'
      WHERE a.action = 'SHARE_LINK_CREATED' AND s.id = '${id}'`)).toBe("t");
  });

  it("two shares, two rows — one per share however it is created", () => {
    const a = insertShare(m.docctrl.caller, m.docctrl.uid, doc, "a");
    const b = insertShare(m.docctrl.caller, m.docctrl.uid, doc, "b");
    expect(a.r.ok && b.r.ok).toBe(true);
    expect([recordsOf(a.id), recordsOf(b.id)]).toEqual(["1", "1"]);
  });

  it("a refused mint (a Viewer outside the minting tier; a Draft document) creates no share and leaves NO record", () => {
    const v = insertShare(m.viewer.caller, m.viewer.uid, doc);
    expect(v.r).toMatchObject({ ok: false, code: "42501" });
    expect(admin(db, `SELECT count(*) FROM document_shares WHERE id = '${v.id}'`)).toBe("0");
    expect(recordsOf(v.id)).toBe("0");
    const d = insertShare(m.docctrl.caller, m.docctrl.uid, draft);
    expect(d.r).toMatchObject({ ok: false, code: "42501" });
    expect(recordsOf(d.id)).toBe("0");
  });

  it("the service role's insert (a restore, the SQL console) is the server's word: the share stands and the trigger writes no row", () => {
    const { id, r } = insertShare({ role: "service_role" }, m.docctrl.uid, doc);
    expect(r).toEqual({ ok: true, rows: 1 });
    expect(recordsOf(id)).toBe("0");
  });

  it("the app's probe answers true for a signed-in member; anon may not call it; nobody may call the trigger function directly (DRLS-16)", () => {
    expect(selectAs(db, m.viewer.caller, "SELECT document_share_creation_recorded_by_database()")).toEqual(["t"]);
    expect(asCaller(db, { role: "anon" }, "SELECT document_share_creation_recorded_by_database()")).toMatchObject({ ok: false, code: "42501" });
    expect(admin(db, "SELECT has_function_privilege('authenticated', 'record_document_share_created()', 'EXECUTE') OR has_function_privilege('anon', 'record_document_share_created()', 'EXECUTE')")).toBe("f");
  });

  it("REVERSAL: with the trigger dropped the probe answers false (the app then writes its own record, as before the paste)", () => {
    const scratch = "mos_p27_reversal";
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    try {
      admin(scratch, "DROP TRIGGER trg_document_share_created_audit ON document_shares;");
      expect(selectAs(scratch, m.viewer.caller, "SELECT document_share_creation_recorded_by_database()")).toEqual(["f"]);
      // HEAD's shape (DACL-4 c3 reproduced): a direct insert then leaves no record
      const id = randomUUID();
      expect(asCaller(scratch, m.docctrl.caller, `INSERT INTO document_shares (id, token, org_id, document_id, created_by, expires_at)
        VALUES ('${id}', '${token()}', '${orgId}', '${doc}', '${m.docctrl.uid}', now() + interval '7 days')`)).toEqual({ ok: true, rows: 1 });
      expect(admin(scratch, `SELECT count(*) FROM audit_logs WHERE action = 'SHARE_LINK_CREATED' AND details->>'shareId' = '${id}'`)).toBe("0");
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${scratch}`);
    }
  });
});

describe.skipIf(skip !== null)("20261227 pasted as ONE script, as the SQL editor sends it", () => {
  const paste = (scratch: string) => runPsql(mosDb().conn!, scratch, "postgres", { sql: body() });
  const rowsOf = (stdout: string) => stdout.split("\n").filter((l) => l.length > 0).map((l) => {
    const [check, ok, n] = l.split("|");
    return { check, ok, n };
  });
  const toHead = (scratch: string) => admin(scratch, `DROP TRIGGER trg_document_share_created_audit ON document_shares;
    DROP FUNCTION record_document_share_created();
    DROP FUNCTION document_share_creation_recorded_by_database();`);
  const scratches: string[] = [];
  afterAll(() => {
    for (const s of scratches) { try { admin("postgres", `DROP DATABASE IF EXISTS ${s}`); } catch { /* deleted with the cluster */ } }
  });

  it("WITHOUT 20261080 it refuses, naming it, and changes nothing", () => {
    const scratch = "mos_p27_no_80";
    scratches.push(scratch);
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    toHead(scratch);
    // a database before 20261080: no document_share_refusal (its INSERT arm goes with it)
    admin(scratch, "DROP FUNCTION document_share_refusal(uuid, uuid) CASCADE;");
    const r = paste(scratch);
    expect(r.error).toMatch(/20261227 needs 20261080/);
    expect(admin(scratch, "SELECT count(*) FROM pg_proc WHERE proname IN ('record_document_share_created', 'document_share_creation_recorded_by_database')")).toBe("0");
    expect(admin(scratch, "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_document_share_created_audit'")).toBe("0");
  });

  it("on HEAD's shape (20261080 present, no trigger): one result set — six probes true, then the five inventory counts, in order; a re-paste answers the same", () => {
    const scratch = "mos_p27_paste";
    scratches.push(scratch);
    admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${db}`);
    toHead(scratch);
    const shares = admin(scratch, "SELECT count(*) FROM document_shares");
    for (let pass = 1; pass <= 2; pass++) {
      const r = paste(scratch);
      expect(r.errors, r.stderr).toEqual([]);
      const rows = rowsOf(r.stdout);
      expect(rows.length, `pass ${pass}`).toBe(11);
      const probes = rows.slice(0, 6);
      const inventory = rows.slice(6);
      expect(probes.filter((p) => p.ok !== "t"), JSON.stringify(probes)).toEqual([]);
      expect(probes.every((p) => p.n === "")).toBe(true);
      expect(inventory.every((i) => i.ok === "" && /^\d+$/.test(i.n)), JSON.stringify(inventory)).toBe(true);
      expect(inventory[0].check).toMatch(/^inventory \(before apply\): share rows \(all\)/);
      expect(inventory[0].n).toBe(shares);
      expect(Number(inventory[1].n) + Number(inventory[2].n)).toBe(Number(shares));
    }
    expect(admin(scratch, "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_document_share_created_audit' AND NOT tgisinternal")).toBe("1");
  });
});

describe.skipIf(skip !== null)("DIST-17's database half, pinned as it stands — OPEN (owner: DIST-18)", () => {
  let orgId = "";
  let m: Record<string, SeededMember> = {};
  let tr = "";

  beforeAll(() => {
    const s = seedOrg(db, { engineer: { role: "Engineer-2" }, viewer: { role: "Viewer" }, docctrl: { role: "DocCtrl" } });
    orgId = s.orgId;
    m = s.m;
    const lib = randomUUID(), priv = randomUUID();
    tr = randomUUID();
    admin(db, [
      `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'P&IDs', 'documents')`,
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status, visibility, acl_index) VALUES ('${priv}', '${orgId}', '${lib}', 'pid.pdf', 'Unit 3 HF alkylation relief system', 'PID-4412', 'C', 'Issued', 'private', '{"allow":{"roles":{"read":["Engineer-2"]}}}'::jsonb)`,
      `INSERT INTO transmittals (id, org_id, seq, number, status, items, created_by, portal_token)
         VALUES ('${tr}', '${orgId}', 7, 'TR-0007', 'draft', '[{"documentId":"${priv}","number":"PID-4412","title":"Unit 3 HF alkylation relief system","rev":"C"}]'::jsonb, '${m.docctrl.uid}', 'tok${tr.replace(/-/g, "")}')`,
    ].join(";\n") + ";");
  });

  it("the Viewer cannot read the private document itself (documents RLS) …", () => {
    const docId = admin(db, `SELECT items->0->>'documentId' FROM transmittals WHERE id = '${tr}'`);
    expect(selectAs(db, m.viewer.caller, `SELECT count(*) FROM documents WHERE id = '${docId}'`)).toEqual(["0"]);
    expect(selectAs(db, m.engineer.caller, `SELECT count(*) FROM documents WHERE id = '${docId}'`)).toEqual(["1"]);
  });

  it("… but OPEN (DIST-18): the REST read of transmittals still hands that Viewer the item's number and the portal token — the database half is not narrowed by P27 (the register and the cover sheet are filtered on the server)", () => {
    expect(selectAs(db, m.viewer.caller, `SELECT items->0->>'number', portal_token IS NOT NULL FROM transmittals WHERE id = '${tr}'`)).toEqual(["PID-4412|t"]);
    // the policy itself is 20260910's, unchanged
    expect(admin(db, "SELECT count(*) FROM pg_policies WHERE tablename = 'transmittals' AND cmd = 'SELECT'")).toBe("1");
  });

  // DIST-18's counts-only inventory (DEC-90 ruling 4: counts first) — the
  // read-only query recorded on DIST-18 for its owner, run here so its text
  // is known to execute on the replayed schema. Aggregate counts only.
  it("DIST-18's counts-only inventory runs read-only on the replayed schema and counts the restricted, token-bearing transmittal", () => {
    const INVENTORY = `
WITH restricted AS (
  SELECT DISTINCT t.id
    FROM transmittals t
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.items) = 'array' THEN t.items ELSE '[]'::jsonb END) AS i(item)
    LEFT JOIN documents d ON d.id::text = i.item->>'documentId'
    LEFT JOIN libraries l ON l.id = d.library_id
   WHERE d.id IS NULL
      OR COALESCE(d.visibility, 'normal') <> 'normal' OR d.acl IS NOT NULL OR d.collection_id IS NOT NULL
      OR COALESCE(l.visibility, 'normal') <> 'normal' OR l.acl IS NOT NULL
)
SELECT 'transmittals (all)' AS "check", NULL::boolean AS ok, COUNT(*)::text AS n FROM transmittals
UNION ALL
SELECT 'transmittals listing an item that is not plainly open (document private / hidden / ACL / in a folder, library private / hidden / ACL, or no document row)', NULL, COUNT(*)::text FROM restricted
UNION ALL
SELECT 'of those, with a LIVE portal link (issued / acknowledged, token set, not revoked, not expired)', NULL, COUNT(*)::text
  FROM transmittals t JOIN restricted r ON r.id = t.id
 WHERE t.status IN ('issued', 'acknowledged') AND t.portal_token IS NOT NULL
   AND t.portal_revoked_at IS NULL AND (t.portal_expires_at IS NULL OR t.portal_expires_at > now())
UNION ALL
SELECT 'transmittals with a portal token set (any state)', NULL, COUNT(*)::text FROM transmittals WHERE portal_token IS NOT NULL;`;
    const out = admin(db, INVENTORY).split("\n").map((l) => l.split("|"));
    expect(out).toHaveLength(4);
    expect(out.every(([, ok, n]) => ok === "" && /^\d+$/.test(n))).toBe(true);
    // the seeded TR-0007 lists a private document under an ACL, as a draft (no live link)
    expect(Number(out[1][2])).toBeGreaterThanOrEqual(1);
  });
});
